// Sidebar chat. The extension host owns providers, credentials, and Open-GSD; this script
// only renders typed host messages and sends bounded intents back.
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const markdown = window.nearMarkdown;
  const $ = (id) => document.getElementById(id);
  const transcript = $('transcript');
  const welcome = $('welcome');
  const input = $('input');
  const send = $('send');
  const model = $('model');
  const profile = $('profile');
  const status = $('status');
  const menu = $('commands');
  const live = $('live');
  const projectLinks = $('project-links');
  const todoPanel = $('todos');
  const commands = JSON.parse(document.body.dataset.commands || '[]');
  const saved = vscode.getState() || {};

  const ICONS = {
    send: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.7 1.3 15 8 1.7 14.7l1.6-5.9L10 8 3.3 7.2z"/></svg>',
    stop: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1"/></svg>',
    copy: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4V2.5A1.5 1.5 0 0 1 5.5 1h7A1.5 1.5 0 0 1 14 2.5v7a1.5 1.5 0 0 1-1.5 1.5H11v1.5A1.5 1.5 0 0 1 9.5 14h-7A1.5 1.5 0 0 1 1 12.5v-7A1.5 1.5 0 0 1 2.5 4zm1 0h4.5A1.5 1.5 0 0 1 11 5.5V10h1.5a.5.5 0 0 0 .5-.5v-7a.5.5 0 0 0-.5-.5h-7a.5.5 0 0 0-.5.5zM2.5 5a.5.5 0 0 0-.5.5v7a.5.5 0 0 0 .5.5h7a.5.5 0 0 0 .5-.5v-7a.5.5 0 0 0-.5-.5z"/></svg>',
    insert: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1v8.3l2.6-2.6.7.7L7.5 11.2 3.7 7.4l.7-.7L7 9.3V1zM2 13h11v1H2z"/></svg>',
    check: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6.3 11.6-3.6-3.6.7-.7 2.9 2.9 6.3-6.3.7.7z"/></svg>'
  };

  let busy = false;
  let current;
  let lastReply;
  let runInfo = {};
  const agentRows = new Map();
  let tools = new Map();
  let menuIndex = 0;
  let modelInfo = new Map();

  function post(message) { vscode.postMessage(message); }
  function announce(text) { live.textContent = text; }
  function scrollToEnd() { transcript.scrollTop = transcript.scrollHeight; }
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function iconButton(icon, label, onClick) {
    const button = el('button', 'icon-button');
    button.type = 'button';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.innerHTML = ICONS[icon];
    button.addEventListener('click', onClick);
    return button;
  }
  function textButton(label, onClick, primary) {
    const button = el('button', primary ? 'text-button primary' : 'text-button', label);
    button.type = 'button';
    button.addEventListener('click', onClick);
    return button;
  }
  function append(node) {
    welcome.hidden = true;
    transcript.appendChild(node);
    scrollToEnd();
    return node;
  }

  function setBusy(value) {
    busy = value;
    send.innerHTML = ICONS[value ? 'stop' : 'send'];
    send.title = value ? 'Stop' : 'Send (Enter)';
    send.setAttribute('aria-label', value ? 'Stop' : 'Send');
    updateSendState();
  }
  function updateSendState() { send.disabled = !busy && !input.value.trim(); }

  // Assistant text is re-rendered from the full buffer so partial Markdown settles as it streams.
  function renderMarkdown(target, text) {
    target.replaceChildren();
    for (const block of markdown.parse(text)) {
      if (block.type === 'html') {
        const holder = document.createElement('div');
        holder.innerHTML = block.html;
        target.append(...holder.childNodes);
        continue;
      }
      const wrapper = el('div', 'code-block');
      const header = el('header');
      header.append(el('span', '', block.lang || 'text'));
      header.append(iconButton('insert', 'Insert at cursor', () => post({ type: 'insert-code', text: block.code })));
      const copy = iconButton('copy', 'Copy', () => {
        navigator.clipboard.writeText(block.code).then(() => {
          copy.innerHTML = ICONS.check;
          setTimeout(() => { copy.innerHTML = ICONS.copy; }, 1200);
        }, () => undefined);
      });
      header.append(copy);
      const pre = el('pre');
      pre.append(el('code', '', block.code));
      wrapper.append(header, pre);
      target.append(wrapper);
    }
  }

  function startAssistant() {
    const node = append(el('div', 'turn assistant'));
    current = { node, body: el('div'), text: '', frame: 0 };
    node.append(current.body);
    current.body.append(el('span', 'spinner'));
    return current;
  }
  function flushAssistant() {
    if (!current) return;
    current.frame = 0;
    renderMarkdown(current.body, current.text);
    scrollToEnd();
  }
  function finishAssistant(meta) {
    if (!current) return;
    if (current.frame) cancelAnimationFrame(current.frame);
    flushAssistant();
    if (!current.text) current.body.replaceChildren();
    if (meta) current.node.append(el('div', 'meta', meta));
    current = undefined;
    setBusy(false);
  }
  function notice(text, actions, isError) {
    const node = el('div', isError ? 'turn notice error' : 'turn notice');
    node.append(el('span', '', text));
    (actions || []).forEach((action) => node.append(action));
    append(node);
    announce(text);
  }

  // The reply footer: model, privacy, tokens, and cost. The estimate (~$) is replaced by the
  // actual charge when NEAR's billing API reports it.
  function usageLine(usage, modelId, privacy, actualCostUsd) {
    const parts = [];
    if (modelId) parts.push(modelId);
    if (privacy) parts.push(privacy);
    const tokens = (usage && (usage.inputTokens || 0) + (usage.outputTokens || 0)) || 0;
    if (tokens) parts.push(tokens.toLocaleString() + ' tokens');
    if (actualCostUsd !== undefined) parts.push('$' + actualCostUsd.toFixed(4));
    else if (usage && usage.estimatedCostUsd !== undefined) parts.push('~$' + usage.estimatedCostUsd.toFixed(4) + ' est.');
    return parts.join(' · ');
  }

  // Open-GSD runs render like a tool call: one collapsible row per run with its log inside.
  function toolFor(event) {
    const key = event.sessionId || event.command;
    let tool = tools.get(key);
    if (tool) return tool;
    const details = el('details', 'tool');
    const summary = el('summary');
    const spinner = el('span', 'spinner');
    const label = el('strong', '', '/' + event.command);
    const state = el('span', '', 'starting…');
    summary.append(spinner, label, state);
    const log = el('div', 'log');
    details.append(summary, log);
    append(details);
    tool = { details, spinner, state, log };
    tools.set(key, tool);
    return tool;
  }
  function onCommandProgress(event) {
    const tool = toolFor(event);
    tool.details.dataset.state = event.state;
    if (event.text) {
      tool.log.textContent += (tool.log.textContent ? '\n' : '') + event.text;
      tool.log.scrollTop = tool.log.scrollHeight;
    }
    const finished = event.state === 'completed' || event.state === 'failed' || event.state === 'cancelled';
    tool.state.textContent = finished ? event.state : (event.action || event.state);
    if (finished) {
      tool.spinner.remove();
      if (event.state === 'failed') tool.details.open = true;
      if (event.state !== 'cancelled') nextActions(tool, event.state === 'failed');
      announce('/' + event.command + ' ' + event.state);
      setBusy(false);
      post({ type: 'refresh-status' });
    } else {
      setBusy(true);
    }
    scrollToEnd();
  }

  function onPrompt(prompt) {
    const card = el('div', 'question');
    card.setAttribute('role', 'group');
    card.setAttribute('aria-label', prompt.question);
    card.append(el('p', '', prompt.question));
    const choices = el('div', 'choices');
    const disable = () => card.querySelectorAll('button,input').forEach((node) => { node.disabled = true; });
    (prompt.choices || []).forEach((choice, index) => {
      const button = textButton(choice.label, () => { disable(); post({ type: 'prompt-choice', sessionId: prompt.sessionId, promptId: prompt.promptId, choiceId: choice.id }); }, index === 0);
      if (choice.description) button.title = choice.description;
      choices.append(button);
    });
    choices.append(textButton('Cancel', () => { disable(); post({ type: 'prompt-cancel', sessionId: prompt.sessionId, promptId: prompt.promptId }); }));
    card.append(choices);
    if (prompt.freeForm && prompt.freeForm.enabled) {
      const answer = el('input');
      answer.placeholder = prompt.freeForm.placeholder || 'Type an answer and press Enter';
      answer.setAttribute('aria-label', prompt.freeForm.label || 'Answer');
      answer.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' || !answer.value.trim()) return;
        disable();
        post({ type: 'prompt-answer', sessionId: prompt.sessionId, promptId: prompt.promptId, text: answer.value.trim() });
      });
      card.append(answer);
    }
    append(card);
    announce('Open-GSD is asking: ' + prompt.question);
  }

  // Key planning files from the host's artifact list, as links that open in the editor.
  const KEY_ARTIFACTS = /(^|\/)(PROJECT|ROADMAP|REQUIREMENTS|STATE)\.md$/;
  function renderArtifacts(artifacts) {
    const links = (artifacts || []).filter((item) => item.kind === 'directory' || KEY_ARTIFACTS.test(item.path));
    projectLinks.replaceChildren(...links.map((item) => {
      const link = el('button', 'link', item.kind === 'directory' ? 'Current phase' : item.path.split('/').pop().replace(/\.md$/, ''));
      link.type = 'button';
      link.title = item.path;
      link.addEventListener('click', () => post({ type: 'open-artifact', path: item.path, kind: item.kind }));
      return link;
    }));
    projectLinks.hidden = !links.length;
  }

  // After a workflow finishes, offer the usual next steps instead of a dead end.
  function nextActions(tool, failed) {
    const row = el('div', 'next-actions');
    const choices = failed ? [['progress', 'Show progress']] : [['next', 'Continue with the next step'], ['progress', 'Show progress']];
    choices.forEach(([command, label], index) => row.append(textButton(label, () => runCommand(command), index === 0)));
    tool.details.after(row);
  }

  function resetConversation() {
    agentRows.clear();
    renderTodos([]);
    transcript.replaceChildren(welcome);
    welcome.hidden = false;
    tools = new Map();
    current = undefined;
    setBusy(false);
    input.focus();
  }


  // Agent tool calls: a collapsible row each, between the text segments of the reply.
  function closeSegment() {
    if (!current) return;
    if (current.frame) cancelAnimationFrame(current.frame);
    flushAssistant();
    if (!current.text) current.node.remove();
    current = undefined;
  }
  function onAgentToolStart(m) {
    closeSegment();
    const details = el('details', 'tool agent-tool');
    const summary = el('summary');
    const spinner = el('span', 'spinner');
    const state = el('span', 'state', '');
    summary.append(spinner, el('strong', '', m.title), state);
    const log = el('div', 'log');
    details.append(summary, log);
    append(details);
    agentRows.set(m.callId, { details, spinner, state, log });
  }
  function onAgentToolEnd(m) {
    const row = agentRows.get(m.callId);
    if (!row) return;
    row.spinner.remove();
    row.details.dataset.state = m.ok ? 'completed' : 'failed';
    row.state.textContent = m.ok ? '' : 'failed';
    row.log.textContent = m.output || '';
    if (!m.ok) row.details.open = true;
    const card = document.getElementById('approval-' + m.callId);
    if (card && !card.dataset.answered) card.remove();
  }
  function onApproval(m) {
    const card = el('div', 'question approval');
    card.id = 'approval-' + m.callId;
    card.setAttribute('role', 'group');
    card.setAttribute('aria-label', 'Approve: ' + m.title);
    card.append(el('p', '', m.title));
    const preview = m.preview || {};
    if (preview.kind === 'diff') {
      const pre = el('pre', 'diff');
      (preview.diff || '(no changes)').split('\n').forEach((line) => pre.append(el('span', line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : line.startsWith('@@') ? 'hunk' : '', line + '\n')));
      card.append(pre);
    } else if (preview.kind === 'command') {
      const pre = el('pre', 'command');
      pre.append(el('code', '', preview.command));
      card.append(pre, el('div', 'meta', 'in ' + (!preview.cwd || preview.cwd === '.' ? 'the workspace root' : preview.cwd) + (preview.background ? ' · runs in the background' : '')));
    } else if (preview.kind === 'note') {
      card.append(el('div', 'meta', preview.text));
    }
    const feedback = el('input');
    feedback.placeholder = 'Optional: tell NEAR AI what to do instead';
    feedback.setAttribute('aria-label', 'Instructions if you decline');
    const choices = el('div', 'choices');
    const answer = (decision, label) => {
      card.dataset.answered = 'true';
      card.querySelectorAll('button,input').forEach((node) => { node.disabled = true; });
      choices.replaceChildren(el('span', 'meta', label));
      post({ type: 'approval-reply', callId: m.callId, decision, ...(decision === 'deny' && feedback.value.trim() ? { feedback: feedback.value.trim() } : {}) });
    };
    const runLabel = m.tool === 'Bash' ? 'Allow this command for this run' : 'Allow edits for this run';
    choices.append(
      textButton('Allow', () => answer('allow', 'Allowed'), true),
      textButton(runLabel, () => answer('allow-run', runLabel.replace('Allow', 'Allowed'))),
      textButton('Deny', () => answer('deny', 'Declined'))
    );
    card.append(choices, feedback);
    append(card);
    announce('Approval needed: ' + m.title);
  }
  function renderTodos(todos) {
    todoPanel.hidden = !todos.length;
    const list = el('ul');
    todos.forEach((todo) => {
      const item = el('li', 'todo ' + todo.status, todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content);
      item.setAttribute('aria-label', todo.status.replace('_', ' ') + ': ' + todo.content);
      list.append(item);
    });
    const done = todos.filter((todo) => todo.status === 'completed').length;
    todoPanel.replaceChildren(el('div', 'todo-title', `Tasks · ${done}/${todos.length}`), list);
  }
  function onRunChanges(m) {
    const row = el('div', 'changes');
    row.id = 'changes-' + m.runId;
    row.append(el('span', '', `${m.files.length} file${m.files.length === 1 ? '' : 's'} changed`));
    row.title = m.files.join('\n') + '\n(Changes made by shell commands are not included.)';
    row.append(textButton('Revert', () => { row.querySelector('button').disabled = true; post({ type: 'revert-run', runId: m.runId }); }));
    append(row);
  }

  // Slash-command menu
  function matchingCommands() {
    const query = input.value.slice(1).toLowerCase();
    const rank = (command) => command.command.startsWith(query) ? 0 : command.command.includes(query) ? 1 : query.length > 1 && command.title.toLowerCase().includes(query) ? 2 : 3;
    return commands.filter((command) => rank(command) < 3).sort((a, b) => rank(a) - rank(b)).slice(0, 12);
  }
  function renderMenu() {
    const open = /^\/[\w-]*$/.test(input.value);
    const matches = open ? matchingCommands() : [];
    menu.hidden = !matches.length;
    input.setAttribute('aria-expanded', String(!menu.hidden));
    if (menu.hidden) return;
    menuIndex = Math.min(menuIndex, matches.length - 1);
    menu.replaceChildren(...matches.map((command, index) => {
      const option = el('div');
      option.id = 'command-' + command.command;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(index === menuIndex));
      option.append(el('strong', '', '/' + command.command), el('span', '', command.description));
      option.addEventListener('mousedown', (event) => { event.preventDefault(); runCommand(command.command); });
      return option;
    }));
    input.setAttribute('aria-activedescendant', 'command-' + matches[menuIndex].command);
  }
  function runCommand(command) {
    input.value = '';
    menu.hidden = true;
    autosize();
    updateSendState();
    const turn = el('div', 'turn user', '/' + command);
    append(turn);
    setBusy(true);
    post({ type: 'open-command', command });
  }

  function submit() {
    if (busy) { post({ type: 'stop' }); return; }
    const text = input.value.trim();
    if (!text) return;
    const exact = /^\/([\w-]+)$/.exec(text);
    if (exact && commands.some((command) => command.command === exact[1])) { runCommand(exact[1]); return; }
    append(el('div', 'turn user', text));
    input.value = '';
    autosize();
    setBusy(true);
    startAssistant();
    post({ type: 'send', text, model: model.value || undefined });
  }
  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  }

  input.addEventListener('input', () => { autosize(); updateSendState(); menuIndex = 0; renderMenu(); });
  input.addEventListener('keydown', (event) => {
    if (!menu.hidden) {
      const matches = matchingCommands();
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        menuIndex = (menuIndex + (event.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length;
        renderMenu();
        return;
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && matches[menuIndex]) { event.preventDefault(); runCommand(matches[menuIndex].command); return; }
      if (event.key === 'Escape') { menu.hidden = true; return; }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit(); }
  });
  input.addEventListener('blur', () => { menu.hidden = true; });
  send.addEventListener('click', submit);
  profile.addEventListener('click', () => post({ type: profile.dataset.state === 'missing' ? 'open-setup' : 'select-profile' }));
  status.addEventListener('click', () => { if (!busy) runCommand('progress'); });
  model.addEventListener('change', () => { saved.model = model.value; vscode.setState(saved); model.title = (modelInfo.get(model.value) || {}).label || ''; });
  document.querySelectorAll('[data-command]').forEach((button) => button.addEventListener('click', () => runCommand(button.dataset.command)));

  window.addEventListener('message', (event) => {
    const m = event.data || {};
    switch (m.type) {
      case 'host-request': post(m.payload); break;
      case 'reset': resetConversation(); post({ type: 'new-chat' }); break;
      case 'prefill': input.value = m.text || ''; autosize(); updateSendState(); input.focus(); break;
      case 'status': status.textContent = m.value || ''; status.title = (m.value || '') + ' — click for detailed progress'; break;
      case 'models': {
        const models = m.models || [];
        if (!models.length) {
          model.replaceChildren(el('option', '', 'No models — set up a profile'));
          model.title = '';
          break;
        }
        const groups = [['local', 'Local · runs on this machine'], ['tee', 'Private · runs in NEAR TEE'], ['forwarded', 'Not private · NEAR forwards to another provider'], ['unknown', 'Privacy unknown']];
        model.replaceChildren(...groups.map(([kind, label]) => {
          const group = el('optgroup');
          group.label = label;
          group.append(...models.filter((item) => item.privacy === kind).map((item) => {
            const option = el('option', '', item.id.split('/').pop() + (kind === 'tee' ? ' 🔒' : ''));
            option.value = item.id;
            option.title = item.label;
            return option;
          }));
          return group;
        }).filter((group) => group.children.length));
        modelInfo = new Map(models.map((item) => [item.id, item]));
        if (saved.model && modelInfo.has(saved.model)) model.value = saved.model;
        model.title = (modelInfo.get(model.value) || {}).label || '';
        break;
      }
      case 'models-error': model.replaceChildren(el('option', '', 'Models unavailable')); model.title = m.text || ''; break;
      case 'auth-required':
        if (current) { current.node.remove(); current = undefined; }
        setBusy(false);
        notice(m.text || 'Set up NEAR AI to start chatting.', [
          textButton('Set up', () => post({ type: 'open-setup' }), true),
          textButton('Choose profile', () => post({ type: 'select-profile' }))
        ]);
        break;
      case 'profile-status': {
        const value = m.value || {};
        const active = (value.profiles || []).find((item) => item.profileId === value.activeProfileId);
        profile.textContent = active ? active.displayName : 'Set up';
        profile.title = active ? active.displayName + (active.organization && active.organization !== active.displayName ? ' · ' + active.organization : '') + ' — click to switch profile' : 'Set up NEAR AI for this project';
        profile.dataset.state = active ? (active.validation && active.validation.status === 'valid' ? 'ready' : 'attention') : 'missing';
        break;
      }
      case 'assistant-start': runInfo = { model: m.model, privacy: m.privacy }; if (!current) startAssistant(); if (m.status) status.textContent = m.status; break;
      case 'assistant-delta':
        if (!current) startAssistant();
        current.text += m.text || '';
        if (!current.frame) current.frame = requestAnimationFrame(flushAssistant);
        break;
      case 'assistant-done': {
        // A run is several text segments around tool rows; the footer goes after the last one.
        if (!current) startAssistant();
        lastReply = { node: current.node, usage: m.usage, model: runInfo.model, privacy: runInfo.privacy };
        finishAssistant(usageLine(m.usage, runInfo.model, runInfo.privacy));
        announce('Response complete.');
        break;
      }
      case 'tool-start': onAgentToolStart(m); break;
      case 'tool-end': onAgentToolEnd(m); break;
      case 'approval-request': onApproval(m); break;
      case 'todos': renderTodos(m.todos || []); break;
      case 'run-changes': onRunChanges(m); break;
      case 'run-reverted': {
        const row = document.getElementById('changes-' + m.runId);
        if (row) row.replaceChildren(el('span', '', `Reverted ${m.files.length} file${m.files.length === 1 ? '' : 's'}.`));
        announce('Changes reverted.');
        break;
      }
      case 'assistant-cost': {
        const meta = lastReply && lastReply.node.querySelector('.meta');
        if (meta) meta.textContent = usageLine(lastReply.usage, lastReply.model, lastReply.privacy, m.actualCostUsd);
        break;
      }
      case 'outbound-blocked': {
        if (current) { current.node.remove(); current = undefined; }
        setBusy(false);
        const actions = m.overrideToken ? [textButton(m.confirm ? 'Send anyway' : 'Send once anyway', () => {
          setBusy(true);
          startAssistant();
          post({ type: 'send', text: m.text, model: m.model, overrideToken: m.overrideToken });
        }, false)] : [];
        notice(m.reason, actions, !m.confirm);
        break;
      }
      case 'assistant-cancelled':
        agentRows.forEach((row) => { if (row.spinner.isConnected) { row.spinner.remove(); row.state.textContent = 'stopped'; } });
        if (current) finishAssistant('Stopped');
        else setBusy(false);
        if (m.status) status.textContent = m.status;
        break;
      case 'assistant-error':
        finishAssistant();
        notice(m.text || 'The request failed.', [], true);
        break;
      case 'command-progress': onCommandProgress(m); break;
      case 'structured-prompt': onPrompt(m.prompt); break;
      case 'prompt-error': notice(m.text || 'That answer could not be sent.', [], true); break;
      case 'session-reopened': {
        const actions = m.continuation ? [textButton('Continue', () => post({ type: 'continue-session', sessionId: m.session.sessionId }), true)] : [];
        notice('Reopened ' + (m.session.plans && m.session.plans.length ? '/' + m.session.plans.join(', /') : 'session') + ' from ' + new Date(m.session.updatedAt).toLocaleString(), actions);
        break;
      }
      case 'history-error': notice(m.text, [], true); break;
      case 'artifacts': renderArtifacts(m.artifacts); break;
      default: break;
    }
  });

  setBusy(false);
  autosize();
  post({ type: 'load-models' });
  post({ type: 'refresh-status' });
})();
