// Sidebar chat. The extension host owns providers, credentials, and Open-GSD; this script
// only renders typed host messages and sends bounded intents back.
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const markdown = window.nearMarkdown;
  // If the table helper is missing, replies still render; tables only lose their kept scroll and focus.
  const tables = window.nearTables || {
    capture: () => ({ wraps: [], scroll: [], focused: -1, inner: -1 }),
    restore: () => [],
    syncTabStop: () => undefined,
    focusLeft: () => undefined,
    watchSizes: () => ({ observe: () => undefined, release: () => undefined, reset: () => undefined })
  };
  const $ = (id) => document.getElementById(id);
  const transcript = $('transcript');
  const welcome = $('welcome');
  const input = $('input');
  const send = $('send');
  const stopButton = $('stop');
  const steerButton = $('steer');
  const model = $('model');
  const policy = $('policy');
  const advanceButton = $('advance');
  const advanceMenu = $('advance-menu');
  const profile = $('profile');
  const status = $('status');
  // Below the status line: set a usage reporting token, or that NEAR's total is in use.
  const spendToken = $('spend-token');
  const menu = $('commands');
  const live = $('live');
  const defaultPlaceholder = input.placeholder;
  const projectLinks = $('project-links');
  const todoPanel = $('todos');
  const chips = $('chips');
  $('attach').addEventListener('click', () => post({ type: 'attach-files' }));
  const agentPanel = $('agents');
  const pendingRegion = $('pending');
  const pendingKit = window.nearPending;
  // The empty chat's "no team yet" card; without its helper the chat simply shows no card.
  // Without its helper, the chat shows the usual welcome rather than a blank one.
  const setupKit = window.nearSetup || { renderSetupNudge: () => undefined, welcomeState: () => 'ready', applyWelcomeState: () => { const ready = $('welcome-ready'); if (ready) ready.hidden = false; } };
  // Until the project has a working profile, the welcome shows only the Connect NEAR AI panel.
  const welcomeReady = $('welcome-ready') || welcome;
  // The "Pick up where you left off" card; without its helper the chat simply shows no card.
  const pickupKit = window.nearPickup || { renderPickupCard: () => undefined };
  // The sync control in the bar and the invitation before sync is on; without its helper the bar keeps its first text and the chat shows no invitation.
  const syncKit = window.nearSyncControl || { renderSyncControl: () => undefined, renderSyncPrompt: () => undefined };
  const syncButton = $('sync');
  const welcomeMemory = {};
  if ($('welcome-new-profile')) $('welcome-new-profile').addEventListener('click', () => post({ type: 'new-profile' }));
  if ($('welcome-choose-profile')) $('welcome-choose-profile').addEventListener('click', () => post({ type: 'select-profile' }));
  if ($('welcome-open-folder')) $('welcome-open-folder').addEventListener('click', () => post({ type: 'open-folder' }));
  const tabList = $('conversation-tabs');
  const newConversationButton = $('new-conversation');
  const needsYou = $('needs-you');
  let contextLeft;
  // Replaced by the host with the installed Open-GSD skills.
  let commands = JSON.parse(document.body.dataset.commands || '[]');
  const saved = vscode.getState() || {};
  // Several conversations can be open; the host sends only the one on screen, and shows another
  // by clearing the view and sending everything that one showed again (marked as a replay).
  let activeId = typeof saved.activeConversation === 'string' ? saved.activeConversation : undefined;
  let conversations = [];
  let replaying = false;
  // Each conversation keeps its own unsent draft. Drafts are saved only once a conversation is
  // on screen, so a switch never files one conversation's draft under another.
  let draftsLive = false;
  saved.drafts = saved.drafts && typeof saved.drafts === 'object' ? saved.drafts : {};

  const ICONS = {
    send: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.7 1.3 15 8 1.7 14.7l1.6-5.9L10 8 3.3 7.2z"/></svg>',
    stop: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1"/></svg>',
    copy: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4V2.5A1.5 1.5 0 0 1 5.5 1h7A1.5 1.5 0 0 1 14 2.5v7a1.5 1.5 0 0 1-1.5 1.5H11v1.5A1.5 1.5 0 0 1 9.5 14h-7A1.5 1.5 0 0 1 1 12.5v-7A1.5 1.5 0 0 1 2.5 4zm1 0h4.5A1.5 1.5 0 0 1 11 5.5V10h1.5a.5.5 0 0 0 .5-.5v-7a.5.5 0 0 0-.5-.5h-7a.5.5 0 0 0-.5.5zM2.5 5a.5.5 0 0 0-.5.5v7a.5.5 0 0 0 .5.5h7a.5.5 0 0 0 .5-.5v-7a.5.5 0 0 0-.5-.5z"/></svg>',
    insert: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1v8.3l2.6-2.6.7.7L7.5 11.2 3.7 7.4l.7-.7L7 9.3V1zM2 13h11v1H2z"/></svg>',
    attach: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.5 3.5 5 9a1.5 1.5 0 0 0 2.1 2.1L12.6 5.6a2.5 2.5 0 0 0-3.5-3.5L3.4 7.8a3.5 3.5 0 0 0 5 5l4.2-4.2.7.7-4.2 4.2a4.5 4.5 0 0 1-6.4-6.4l5.7-5.7a3.5 3.5 0 0 1 4.9 4.9l-5.5 5.5a2.5 2.5 0 0 1-3.5-3.5l5.5-5.5z"/></svg>',
    check: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6.3 11.6-3.6-3.6.7-.7 2.9 2.9 6.3-6.3.7.7z"/></svg>',
    add: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M7.5 2h1v5.5H14v1H8.5V14h-1V8.5H2v-1h5.5z"/></svg>',
    close: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m8 7.3 3.6-3.6.7.7L8.7 8l3.6 3.6-.7.7L8 8.7l-3.6 3.6-.7-.7L7.3 8 3.7 4.4l.7-.7z"/></svg>'
  };
  $('attach').innerHTML = ICONS.attach;
  send.innerHTML = ICONS.send;
  stopButton.innerHTML = ICONS.stop;
  newConversationButton.innerHTML = ICONS.add;

  let busy = false;
  let current;
  let lastReply;
  // Replies by run, so a cost NEAR settles later lands on the reply it belongs to.
  const replies = new Map();
  let runInfo = {};
  const agentRows = new Map();
  let tools = new Map();
  let menuIndex = 0;
  let modelInfo = new Map();
  const staged = new Map();
  /** Where each staged file was saved in the project (0.4.21), by attachment ID. */
  const savedAs = new Map();
  function renderChips() {
    chips.replaceChildren(...[...staged.entries()].map(([id, name]) => {
      const chip = el('span', 'chip-file', name);
      // Where the copy in the project is, so a person can see the file was saved and open it.
      if (savedAs.get(id)) chip.title = 'Saved in the project as ' + savedAs.get(id);
      const remove = iconButton('stop', 'Remove ' + name, () => { staged.delete(id); savedAs.delete(id); post({ type: 'attachment-remove', id }); renderChips(); });
      chip.append(remove);
      return chip;
    }));
    chips.hidden = !staged.size;
  }

  function post(message) { vscode.postMessage(message); }
  /** A message about the conversation on screen names it, so it never reaches one the user has left. */
  function postFor(message) { post(activeId ? Object.assign({}, message, { conversationId: activeId }) : message); }
  // A conversation shown again is not news: its replayed messages are not announced.
  function announce(text) { if (!replaying) live.textContent = text; }
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

  // Prompts that block a run (approvals, questions, choices) are pinned above the composer until
  // they are settled, so they cannot scroll away. The transcript keeps a line at the spot where
  // each was asked, which becomes a record of the outcome. Only the shown prompt is in the DOM;
  // the others keep their half-filled state until the user steps to them.
  const pendingQueue = pendingKit.createPendingQueue();
  const pendingCards = new Map();
  const pendingHeader = el('div', 'pending-header');
  const pendingTitle = el('strong', 'pending-title');
  const pendingPrev = textButton('‹ Previous', () => stepPending(-1));
  const pendingNext = textButton('Next ›', () => stepPending(1));
  pendingPrev.setAttribute('aria-label', 'Show the previous waiting prompt');
  pendingNext.setAttribute('aria-label', 'Show the next waiting prompt');
  const pendingSteps = el('span', 'pending-steps');
  pendingSteps.append(pendingPrev, pendingNext);
  pendingHeader.append(pendingTitle, pendingSteps);
  const pendingBody = el('div', 'pending-body');
  pendingRegion.append(pendingHeader, pendingBody);

  function renderPending() {
    const item = pendingQueue.current();
    pendingRegion.hidden = !item;
    if (!item) { pendingBody.replaceChildren(); return; }
    pendingTitle.textContent = pendingKit.headerText(item, pendingQueue.position(), pendingQueue.size);
    pendingSteps.hidden = pendingQueue.size < 2;
    const entry = pendingCards.get(item.id);
    if (pendingBody.firstChild !== entry.card) pendingBody.replaceChildren(entry.card);
  }
  // Typing in the composer (or any field outside the pinned prompt) keeps its focus.
  function userIsTyping() {
    const active = document.activeElement;
    if (!active || pendingRegion.contains(active)) return false;
    if (active === input) return Boolean(input.value.trim());
    return active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT';
  }
  function focusPending(id) {
    if (!pendingQueue.select(id)) return;
    renderPending();
    const entry = pendingCards.get(id);
    pendingRegion.scrollIntoView({ block: 'nearest' });
    entry.primary.focus();
  }
  function stepPending(delta) {
    const item = pendingQueue.step(delta);
    renderPending();
    if (item) announce(pendingTitle.textContent + ': ' + item.title);
  }
  /** Pins a prompt; false when it is already pinned (a replay to a view that did not reload). */
  function addPending(item, card, primary, spoken) {
    if (!pendingQueue.add(item)) return false;
    const line = el('div', 'turn pending-line');
    line.append(el('span', '', pendingKit.waitingText(item)));
    const show = el('button', 'link', 'Show');
    show.type = 'button';
    show.setAttribute('aria-label', 'Show the waiting prompt: ' + item.title);
    show.addEventListener('click', () => focusPending(item.id));
    line.append(' ', show);
    append(line);
    pendingCards.set(item.id, { item, card, line, primary });
    renderPending();
    if (pendingQueue.size === 1 && !userIsTyping() && !replaying) primary.focus();
    announce(spoken + (pendingQueue.size > 1 ? ' ' + pendingQueue.size + ' prompts are waiting.' : ''));
    return true;
  }
  /** Unpins a prompt and leaves its outcome in the transcript. */
  function closePending(id, outcome, detail) {
    const entry = pendingCards.get(id);
    if (!entry) return false;
    const active = document.activeElement;
    const hadFocus = !active || active === document.body || pendingRegion.contains(active);
    pendingQueue.resolve(id);
    pendingCards.delete(id);
    entry.line.className = 'turn pending-line resolved';
    entry.line.replaceChildren(el('span', '', pendingKit.outcomeText(entry.item, outcome, detail)));
    renderPending();
    const next = pendingQueue.current();
    if (hadFocus) {
      if (next) pendingCards.get(next.id).primary.focus();
      else input.focus();
    }
    return true;
  }
  function closeAllPending(outcome) {
    pendingQueue.list().forEach((item) => closePending(item.id, outcome));
  }
  function clearPending() {
    pendingQueue.clear();
    pendingCards.clear();
    renderPending();
  }

  // The composer stays open during a run: Send queues the message for the running agent, and a
  // separate Stop button (or Esc in an empty message box) stops the run.
  function setBusy(value) {
    busy = value;
    stopButton.hidden = !value;
    // 0.4.18: while a run is going there are two ways to send. Enter queues the message for the next safe point; Steer (or Ctrl+Enter) interrupts
    // the reply in flight, so the message is the agent's newest direction now. Each button says which it does.
    steerButton.hidden = !value;
    send.title = value ? 'Queue for the running agent (Enter): it sees the message after its current step; Ctrl+Enter or Steer interrupts it now' : 'Send (Enter)';
    send.setAttribute('aria-label', value ? 'Send to the running agent' : 'Send');
    updateSendState();
  }
  function updateSendState() { send.disabled = !input.value.trim(); }
  function stopRun() { if (busy) postFor({ type: 'stop' }); }
  // 0.4.18: Steer sends the message and interrupts the reply in flight. It needs text like Send does.
  steerButton.addEventListener('click', () => { const text = input.value.trim(); if (busy && text) sendSteer(text, { interrupt: true }); });

  // Messages sent during a run, by id: the bubble's state line says queued, delivered, or sent as a new message.
  const steerBubbles = new Map();
  const STEER_LABELS = { queued: 'Queued — the agent sees it after its current step', interrupting: 'Interrupting the reply now…', delivered: 'Delivered to the running agent', 'sent-new': 'Sent as a new message (the run had ended)', returned: 'Not sent — the run was stopped; it is back in the message box', blocked: 'Not sent' };
  function steerId() {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    return 'steer-' + [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  function sendSteer(text, options = {}) {
    const id = steerId();
    const node = append(el('div', 'turn user steer', text));
    const line = el('span', 'steer-state', options.interrupt ? 'Interrupting…' : 'Sending…');
    node.append(line);
    steerBubbles.set(id, { node, line });
    input.value = '';
    autosize();
    updateSendState();
    // 0.4.21: the files attached to this message go with it, to the running agent, never left for a later message.
    const ids = [...staged.keys()];
    if (ids.length) node.insertBefore(document.createTextNode('\n📎 ' + [...staged.values()].join(', ')), line);
    postFor({ type: 'steer', id, text, ...(options.interrupt ? { interrupt: true } : {}), ...(ids.length ? { attachmentIds: ids } : {}) });
  }
  function onSteerState(m) {
    // A conversation shown again brings back the messages still queued for its run.
    if (m.replay && m.state === 'queued' && m.text && !steerBubbles.has(m.id)) {
      const node = append(el('div', 'turn user steer', m.text));
      const line = el('span', 'steer-state', '');
      node.append(line);
      steerBubbles.set(m.id, { node, line });
    }
    const bubble = steerBubbles.get(m.id);
    if (bubble) {
      bubble.line.textContent = m.state === 'blocked' && m.reason ? 'Not sent: ' + m.reason : STEER_LABELS[m.state] || '';
      bubble.line.dataset.state = m.state;
      // Once the agent has it, the message sits where the conversation took it in, and the reply follows it.
      if (m.state === 'delivered' || m.state === 'sent-new') {
        if (m.state === 'delivered') closeSegment();
        append(bubble.node);
        if (m.state === 'delivered' && busy) startAssistant();
      }
      if (m.state !== 'queued') steerBubbles.delete(m.id);
    }
    if (m.state === 'delivered' || m.state === 'sent-new' || m.state === 'blocked') announce(STEER_LABELS[m.state]);
    // A message the run never took goes back to the composer, unless something new is being typed.
    if (!m.replay && (m.state === 'returned' || m.state === 'blocked') && m.text && !input.value.trim()) { input.value = m.text; autosize(); updateSendState(); }
  }

  // A table box becomes a Tab stop when it gets wider than the chat, and stops being one when the
  // chat is widened again. Boxes are let go when their reply is removed or the chat is cleared.
  const tableSizes = tables.watchSizes(typeof ResizeObserver === 'function' ? ResizeObserver : undefined, () => document.activeElement);
  const removeTurn = (node) => { tableSizes.release(node.querySelectorAll('.table-wrap')); node.remove(); };
  // A table that is not wider than the chat stops being a Tab stop once focus leaves it.
  transcript.addEventListener('focusout', tables.focusLeft);

  // Assistant text is re-rendered from the full buffer so partial Markdown settles as it streams.
  // `partial` is true while more text is still on its way. Each table keeps its sideways scroll
  // and keyboard focus across the rebuild.
  function renderMarkdown(target, text, partial) {
    const saved = tables.capture(target, document.activeElement);
    tableSizes.release(saved.wraps);
    target.replaceChildren();
    for (const block of markdown.parse(text, { partial: partial === true })) {
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
    tableSizes.observe(tables.restore(target, saved));
  }

  function startAssistant() {
    const node = append(el('div', 'turn assistant'));
    current = { node, body: el('div'), text: '', frame: 0 };
    node.append(current.body);
    current.body.append(el('span', 'spinner'));
    return current;
  }
  function flushAssistant(partial) {
    if (!current) return;
    current.frame = 0;
    renderMarkdown(current.body, current.text, partial === true);
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
  // Resume and Dismiss of a cut-off run: used once, then removed (the host ignores a second click).
  function settleCut(type) {
    transcript.querySelectorAll('.cut-action').forEach((button) => button.remove());
    if (type) postFor({ type: type });
  }
  // Continue after a stopped run: used once, then removed; a new turn removes it too.
  function settleContinue(send) {
    transcript.querySelectorAll('.continue-action').forEach((button) => button.remove());
    if (send) postFor({ type: 'continue-run' });
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
  // With the spend ledger, the estimate is the run's pending total (every request it made), until
  // NEAR confirms it.
  function usageLine(usage, modelId, privacy, actualCostUsd, spend) {
    const parts = [];
    if (modelId) parts.push(modelId);
    if (privacy) parts.push(privacy);
    const tokens = (usage && (usage.inputTokens || 0) + (usage.outputTokens || 0)) || 0;
    if (tokens) parts.push(tokens.toLocaleString() + ' tokens');
    if (actualCostUsd !== undefined) parts.push('$' + actualCostUsd.toFixed(4) + (spend ? ' confirmed' : ''));
    else if (spend && usage && usage.estimatedCostUsd !== undefined) parts.push('~$' + usage.estimatedCostUsd.toFixed(4) + ' pending');
    else if (usage && usage.estimatedCostUsd !== undefined) parts.push('~$' + usage.estimatedCostUsd.toFixed(4) + ' est.');
    return parts.join(' · ');
  }
  const COST_TIP = 'Confirmed: NEAR\u2019s billing API reported the actual cost. Pending: the estimate, until NEAR reports it (usually within seconds to minutes). The run\u2019s cost includes its sub-agents, safety checks, and summaries.';

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
    if (pendingQueue.has(prompt.promptId)) return;
    const choices = el('div', 'choices');
    const disable = () => card.querySelectorAll('button,input').forEach((node) => { node.disabled = true; });
    (prompt.choices || []).forEach((choice, index) => {
      const button = textButton(choice.label, () => { disable(); post({ type: 'prompt-choice', sessionId: prompt.sessionId, promptId: prompt.promptId, choiceId: choice.id }); closePending(prompt.promptId, 'answered', choice.label); }, index === 0);
      if (choice.description) button.title = choice.description;
      choices.append(button);
    });
    const cancel = textButton('Cancel', () => { disable(); post({ type: 'prompt-cancel', sessionId: prompt.sessionId, promptId: prompt.promptId }); closePending(prompt.promptId, 'deny'); });
    choices.append(cancel);
    card.append(choices);
    if (prompt.freeForm && prompt.freeForm.enabled) {
      const answer = el('input');
      answer.placeholder = prompt.freeForm.placeholder || 'Type an answer and press Enter';
      answer.setAttribute('aria-label', prompt.freeForm.label || 'Answer');
      answer.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' || !answer.value.trim()) return;
        disable();
        post({ type: 'prompt-answer', sessionId: prompt.sessionId, promptId: prompt.promptId, text: answer.value.trim() });
        closePending(prompt.promptId, 'answered', answer.value.trim());
      });
      card.append(answer);
    }
    addPending({ id: prompt.promptId, kind: 'choice', agent: 'Open-GSD', title: prompt.question }, card, choices.querySelector('button') || cancel, 'Open-GSD is asking: ' + prompt.question);
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
    replies.clear();
    steerBubbles.clear();
    lastReply = undefined;
    runInfo = {};
    renderTodos([]);
    renderAgents([]);
    clearPending();
    tableSizes.reset();
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
    if (!current.text) removeTurn(current.node);
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
    // The call ended without an answer (declined elsewhere): nothing is waiting any more.
    closePending(m.callId, 'closed');
  }
  function onApproval(m) {
    if (pendingQueue.has(m.callId)) return;
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
    // Why it was not run automatically (auto approve's rules or safety model). 0.4.17: the headline says what kind of risk it is in one plain
    // sentence, and the expander holds the whole reason and the exact command or code, so nothing has to be guessed from a one-line title.
    if (m.risk && m.risk.headline) {
      card.append(el('p', 'approval-why', m.risk.headline));
      // 0.4.17: a card with a headline always has a reason; one without says only the rule's own words.
      const line = m.reasonShort || m.reason;
      if (line) card.append(el('div', 'meta approval-reason', line));
    } else if (m.reason) {
      card.append(el('div', 'meta approval-reason', 'Why this asks: ' + m.reason));
    }
    const subject = m.subject || (preview.kind === 'command' ? preview.command : undefined);
    if (m.reason || (subject && m.risk)) {
      const more = el('details', 'approval-more');
      more.append(el('summary', '', m.risk && m.risk.kind === 'outside-workspace' ? 'Show the whole reason' : 'Show what will run'));
      if (m.reason && m.reason !== m.reasonShort) more.append(el('div', 'meta approval-reason', m.reason));
      if (subject) {
        const pre = el('pre', 'command');
        pre.append(el('code', '', subject));
        more.append(pre);
      }
      card.append(more);
    }
    const feedback = el('input');
    feedback.placeholder = 'Optional: tell NEAR AI what to do instead';
    feedback.setAttribute('aria-label', 'Instructions if you decline');
    const choices = el('div', 'choices');
    const answer = (decision) => {
      card.querySelectorAll('button,input').forEach((node) => { node.disabled = true; });
      postFor({ type: 'approval-reply', callId: m.callId, decision, ...(decision === 'deny' && feedback.value.trim() ? { feedback: feedback.value.trim() } : {}) });
      closePending(m.callId, decision);
    };
    // Owner decision 2026-11-06: two named choices, because "Allow" and "for this run" did the same thing whenever a run makes a command once.
    // "Allow this time" is one call. "Allow every time" is permanent: it writes the entry to this workspace's allow list and says what it saved.
    // "For this run" appears only where it is genuinely different, which is when the command repeats but no permanent entry can be made (an address on
    // the command line, or something held for review).
    const allow = textButton('Allow this time', () => answer('allow'), true);
    choices.append(allow);
    if (m.allowRule) choices.append(textButton('Allow every time', () => answer('allow-always')));
    const runnable = m.allowRule === undefined && m.tool === 'Bash';
    if (runnable) choices.append(textButton('Allow this command for this run', () => answer('allow-run')));
    choices.append(textButton('Deny', () => answer('deny')));
    // Enter in the feedback box declines with those instructions.
    feedback.addEventListener('keydown', (event) => { if (event.key === 'Enter' && feedback.value.trim()) { event.preventDefault(); answer('deny'); } });
    card.append(choices, feedback);
    addPending({ id: m.callId, kind: 'approval', agent: m.agent, title: m.title }, card, allow, 'Approval needed: ' + m.title);
  }
  // AskUserQuestion: one block per question, options as buttons (or checkboxes when several may
  // apply) plus a free-text "Other", answered together.
  function onQuestions(m) {
    if (pendingQueue.has(m.id)) return;
    const card = el('div', 'question questions');
    card.setAttribute('role', 'group');
    card.setAttribute('aria-label', 'NEAR AI has questions');
    const readers = m.questions.map((question, index) => {
      const block = el('fieldset', 'q');
      const legend = el('legend', '', (question.header ? question.header + ' · ' : '') + question.question);
      block.append(legend);
      const name = m.id + '-' + index;
      const choices = question.options.map((option) => {
        const label = el('label', 'option');
        const box = el('input');
        box.type = question.multiSelect ? 'checkbox' : 'radio';
        box.name = name;
        box.value = option.label;
        label.append(box, el('span', '', option.label));
        if (option.description) label.append(el('small', '', option.description));
        block.append(label);
        return box;
      });
      const other = el('input', 'other');
      other.placeholder = 'Other (type your own answer)';
      other.setAttribute('aria-label', 'Other answer for: ' + question.question);
      block.append(other);
      card.append(block);
      return () => {
        const picked = choices.filter((box) => box.checked).map((box) => box.value);
        if (other.value.trim()) picked.push(other.value.trim());
        return picked.join(', ');
      };
    });
    const submitButton = textButton('Submit answers', () => {
      const answers = readers.map((read) => read());
      if (answers.some((answer) => !answer)) { announce('Answer every question first.'); return; }
      card.querySelectorAll('button,input').forEach((node) => { node.disabled = true; });
      postFor({ type: 'questions-reply', id: m.id, answers });
      closePending(m.id, 'answered', answers.join('; '));
    }, true);
    card.append(submitButton);
    const first = m.questions[0] || { question: 'Questions' };
    const title = first.question + (m.questions.length > 1 ? ' (+' + (m.questions.length - 1) + ' more)' : '');
    addPending({ id: m.id, kind: 'questions', agent: m.agent, title }, card, card.querySelector('input') || submitButton, 'NEAR AI is asking you ' + (m.questions.length === 1 ? 'a question: ' + first.question : m.questions.length + ' questions.'));
  }

  // Running sub-agents with what each is doing, how long it has run, and pause, resume, and stop.
  let agentClock;
  const clock = (ms) => { const seconds = Math.max(0, Math.floor(ms / 1000)); return seconds < 60 ? seconds + 's' : Math.floor(seconds / 60) + 'm ' + String(seconds % 60).padStart(2, '0') + 's'; };
  function updateAgentStatus(node) {
    const now = Date.now();
    const thinking = node.dataset.activity === 'Thinking' || node.dataset.activity === 'Writing';
    node.textContent = node.dataset.activity + (thinking ? ' (' + clock(now - Number(node.dataset.since)) + ')' : '') + (node.dataset.after ? ' after ' + node.dataset.after : '') + ' · ' + clock(now - Number(node.dataset.startedAt)) + ' · ' + node.dataset.counts;
  }
  function renderAgents(agents) {
    agentPanel.hidden = !agents.length;
    if (!agents.length) { agentPanel.replaceChildren(); return; }
    const list = el('ul');
    agents.forEach((agent) => {
      const item = el('li', 'agent' + (agent.paused ? ' paused' : ''));
      const body = el('span', 'agent-body');
      const label = el('button', 'agent-label link-button', agent.label + (agent.description ? ' · ' + agent.description : ''));
      label.type = 'button';
      label.title = 'Show what this agent is doing in Agent Activity · ' + agent.model + (agent.background ? ' · background' : '');
      label.addEventListener('click', () => post({ type: 'open-activity', agentId: agent.id }));
      const status = el('span', 'agent-status');
      status.dataset.startedAt = String(agent.startedAt || Date.now());
      status.dataset.since = String(agent.activitySince || Date.now());
      status.dataset.activity = agent.paused ? 'Paused' : (agent.activity || 'Starting');
      status.dataset.after = !agent.paused && agent.activity === 'Thinking' && agent.lastAction ? agent.lastAction : '';
      // The agent's own task list, as steps done of total and the step in progress (the line ellipsizes if it is long).
      const steps = agent.steps && agent.steps.total ? ' · ' + agent.steps.done + '/' + agent.steps.total + ' steps' + (agent.steps.active ? ' · ' + agent.steps.active : '') : '';
      status.dataset.counts = (agent.toolCalls || 0) + ' tool call' + (agent.toolCalls === 1 ? '' : 's') + ' · ' + (agent.turns || 0) + ' turn' + (agent.turns === 1 ? '' : 's') + steps;
      if (agent.steps && agent.steps.active) status.title = agent.steps.active;
      updateAgentStatus(status);
      body.append(label, status);
      const controls = el('span', 'agent-controls');
      controls.append(
        agent.paused
          ? textButton('Resume', () => post({ type: 'agent-control', agentId: agent.id, action: 'resume' }))
          : textButton('Pause', () => post({ type: 'agent-control', agentId: agent.id, action: 'pause' })),
        // 0.4.19: a run waiting on CI or a review can be told to look again now, instead of the person waiting out a poll they can already see is stale.
        textButton('Check now', () => post({ type: 'agent-control', agentId: agent.id, action: 'nudge' })),
        textButton('Stop', () => post({ type: 'agent-control', agentId: agent.id, action: 'stop' }))
      );
      item.append(body, controls);
      list.append(item);
    });
    agentClock ??= setInterval(() => { const rows = agentPanel.querySelectorAll('.agent-status'); if (!rows.length) { clearInterval(agentClock); agentClock = undefined; } rows.forEach(updateAgentStatus); }, 1000);
    const title = el('div', 'todo-title');
    title.append(panelToggle(list, 'agents-list', 'agentsCollapsed', `Agents running · ${agents.length}`, 'running agents'), ' ', textButton('Activity', () => post({ type: 'open-activity' })));
    agentPanel.replaceChildren(title, list);
  }

  // A panel's list can be collapsed to its title line; the choice is remembered across reloads.
  function panelToggle(list, listId, key, label, what) {
    const toggle = el('button', 'panel-toggle', label);
    toggle.type = 'button';
    toggle.setAttribute('aria-controls', listId);
    list.id = listId;
    const applyCollapsed = () => {
      list.hidden = !!saved[key];
      toggle.setAttribute('aria-expanded', String(!saved[key]));
      toggle.title = saved[key] ? 'Show ' + what : 'Hide ' + what;
    };
    toggle.addEventListener('click', () => { saved[key] = !saved[key]; vscode.setState(saved); applyCollapsed(); });
    applyCollapsed();
    return toggle;
  }

  // `unconfirmed`: the run ended with items not marked done. They show as not confirmed, never as in progress, and nothing is struck through.
  function renderTodos(todos, unconfirmed) {
    todoPanel.hidden = !todos.length;
    const list = el('ul');
    todos.forEach((todo) => {
      const open = unconfirmed === true && todo.status !== 'completed';
      const item = el('li', 'todo ' + todo.status + (open ? ' unconfirmed' : ''), !open && todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content);
      item.setAttribute('aria-label', open ? 'not confirmed done: ' + todo.content : todo.status.replace('_', ' ') + ': ' + todo.content);
      if (open) item.title = 'The run ended without this item marked done.';
      list.append(item);
    });
    const done = todos.filter((todo) => todo.status === 'completed').length;
    const title = el('div', 'todo-title');
    title.append(panelToggle(list, 'todos-list', 'todosCollapsed', `Tasks · ${done}/${todos.length}` + (unconfirmed === true && done < todos.length ? ` · ${todos.length - done} not confirmed done` : ''), 'the task list'));
    todoPanel.replaceChildren(title, list);
  }
  function onRunChanges(m) {
    const row = el('div', 'changes');
    row.id = 'changes-' + m.runId;
    row.append(el('span', '', `${m.files.length} file${m.files.length === 1 ? '' : 's'} changed`));
    row.title = m.files.join('\n') + '\n(Changes made by shell commands are not included.)';
    row.append(textButton('Revert', () => { row.querySelector('button').disabled = true; postFor({ type: 'revert-run', runId: m.runId }); }));
    append(row);
  }

  // Slash-command menu
  function matchingCommands() {
    const query = input.value.slice(1).toLowerCase();
    const rank = (command) => command.command.startsWith(query) ? 0 : command.command.includes(query) ? 1 : query.length > 1 && command.title.toLowerCase().includes(query) ? 2 : 3;
    return commands.filter((command) => rank(command) < 3).sort((a, b) => rank(a) - rank(b)).slice(0, 12);
  }
  function renderMenu() {
    const open = /^\/[\w:-]*$/.test(input.value);
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
      // The full name and description stay in the tooltip when a narrow sidebar shortens them.
      option.title = '/' + command.command + (command.description ? ': ' + command.description : '');
      option.append(el('strong', '', '/' + command.command), el('span', '', command.description));
      option.addEventListener('mousedown', (event) => { event.preventDefault(); chooseCommand(command); });
      return option;
    }));
    input.setAttribute('aria-activedescendant', 'command-' + matches[menuIndex].command);
  }
  function findCommand(name) {
    return commands.find((command) => command.command === name) || commands.find((command) => command.command === 'gsd-' + name);
  }
  function runCommand(command, args) {
    // A workflow needs the agent to itself: it is not queued behind, or mixed into, a running one.
    if (busy) { notice('Finish or stop the current run first: /' + command + ' starts a new workflow. Your message stays in the box; or start it in a new conversation (+), which runs alongside this one.', []); return; }
    input.value = '';
    input.placeholder = defaultPlaceholder;
    menu.hidden = true;
    autosize();
    updateSendState();
    append(el('div', 'turn user', '/' + command + (args ? ' ' + args : '')));
    setBusy(true);
    postFor({ type: 'open-command', command, ...(args ? { args } : {}), ...(model.value ? { model: model.value } : {}) });
  }
  // Picking a command that takes arguments fills it in and shows its argument hint; others run at once.
  function chooseCommand(command) {
    if (!command.argumentHint) { runCommand(command.command); return; }
    input.value = '/' + command.command + ' ';
    input.placeholder = command.argumentHint;
    menu.hidden = true;
    autosize();
    updateSendState();
    input.focus();
  }

  function submit() {
    const text = input.value.trim();
    if (!text) return;
    const slash = /^\/([\w:-]+)(?:\s+([\s\S]*))?$/.exec(text);
    if (slash && slash[1] === 'stop' && !slash[2]) { input.value = ''; autosize(); updateSendState(); stopRun(); return; }
    const command = slash && findCommand(slash[1]);
    if (busy && !command) { sendSteer(text); return; }
    if (command) { runCommand(command.command, (slash[2] || '').trim()); return; }
    const ids = [...staged.keys()];
    append(el('div', 'turn user', text + (ids.length ? '\n📎 ' + [...staged.values()].join(', ') : '')));
    input.value = '';
    autosize();
    setBusy(true);
    startAssistant();
    postFor({ type: 'send', text, model: model.value || undefined, ...(ids.length ? { attachmentIds: ids } : {}) });
  }
  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
    saveDraft();
  }
  function saveDraft() {
    if (!draftsLive || !activeId) return;
    if (input.value.trim()) saved.drafts[activeId] = input.value;
    else delete saved.drafts[activeId];
    vscode.setState(saved);
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
      if ((event.key === 'Enter' || event.key === 'Tab') && matches[menuIndex]) { event.preventDefault(); chooseCommand(matches[menuIndex]); return; }
      if (event.key === 'Escape') { menu.hidden = true; return; }
    }
    // Ctrl+Enter (Cmd+Enter on a Mac) sends the message as a Steer, interrupting the reply in flight; plain Enter queues it as before.
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      const text = input.value.trim();
      if (busy && text) sendSteer(text, { interrupt: true });
      else submit();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit(); }
    // Esc in an empty message box stops the run, as in Claude Code; with text in it, Esc does nothing.
    else if (event.key === 'Escape' && busy && !input.value.trim()) { event.preventDefault(); stopRun(); }
  });
  input.addEventListener('blur', () => { menu.hidden = true; });
  send.addEventListener('click', submit);
  stopButton.addEventListener('click', stopRun);
  profile.addEventListener('click', () => post({ type: profile.dataset.state === 'missing' ? 'open-setup' : 'select-profile' }));
  status.addEventListener('click', () => { if (!busy) runCommand('progress'); });
  if (spendToken) spendToken.addEventListener('click', () => post({ type: 'reporting-token' }));
  function showSpendToken(token) {
    if (!spendToken) return;
    spendToken.hidden = !token;
    if (!token) return;
    spendToken.textContent = token.text;
    spendToken.title = token.title;
    spendToken.dataset.state = token.state;
  }
  // The approval-policy picker: a button that opens a listbox of the modes, each with its label
  // and a one-line summary. The host validates the choice, asks before Full auto, and writes
  // nearAi.actionPolicy; it then sends the effective state back, which is what this shows.
  const policyMenu = $('policy-menu');
  let policyState;

  // 0.4.18: whether a workflow carries on by itself, shown beside the approval picker so it can be changed during a run (owner, 2026-11-06). It is the
  // project's Open-GSD setting, changed through the same picker, so the two cannot disagree.
  // 0.4.19: a picker, not a button, and styled like the approval picker beside it (owner, 2026-11-06). It offers "Carry on by itself" and each mode
  // that stops between steps, so the person can choose rather than only toggle. The choices are the same approval modes, so the two pickers agree.
  const CARRY_ON = 'auto';
  let advanceState = { on: false, text: '' };
  function renderAdvance(m) {
    advanceState = m.autoAdvance || { on: false, text: '' };
    advanceButton.hidden = !advanceState.text;
    // The markup ships a chevron, and setting textContent would drop it, so the affordance went missing after the first state message.
    advanceButton.textContent = (advanceState.on ? 'Carrying on' : 'Stops each step') + ' \u25be';
    advanceButton.dataset.carrying = advanceState.on ? 'true' : 'false';
    advanceButton.setAttribute('aria-label', advanceState.on ? 'Between steps: carrying on by itself' : 'Between steps: stops so you can choose');
    advanceButton.title = advanceState.text || 'Whether a workflow carries on to its next step by itself';
    // The menu: carry on, then every mode that asks. The approval picker's own labels and summaries are reused, so the two read the same.
    const asking = (m.options || []).filter((option) => option.mode !== CARRY_ON);
    // 0.4.18 review: when the run stops between steps while the mode IS "auto", "carry on" must not also look selected, or the menu contradicts the
    // button that says "Stops each step". Only a run that really carries on marks the carry-on row.
    const chosen = advanceState.on ? CARRY_ON : (m.mode === CARRY_ON ? '' : m.mode);
    advanceMenu.replaceChildren(
      optionRow(CARRY_ON, 'Carry on by itself', 'Each step starts the next one without asking', chosen === CARRY_ON, false),
      ...asking.map((option) => optionRow(option.mode, 'Stop between steps: ' + option.label, option.summary || option.description, chosen === option.mode, option.risky === true))
    );
  }
  function optionRow(mode, label, summary, selected, risky) {
    const item = el('div', 'policy-option');
    item.id = 'advance-option-' + mode;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(selected));
    item.tabIndex = -1;
    item.dataset.mode = mode;
    item.dataset.risky = risky ? 'true' : 'false';
    item.title = summary || '';
    item.append(el('strong', '', label + (risky ? ' ⚠' : '')), el('span', '', summary || ''));
    item.addEventListener('click', () => chooseAdvance(mode));
    return item;
  }
  function advanceItems() { return [...advanceMenu.querySelectorAll('[role="option"]')]; }
  // The listbox keeps DOM focus on the option (tabIndex -1), so a screen reader is told which one by aria-activedescendant rather than by focus.
  function markAdvanceActive() {
    const current = document.activeElement;
    if (current && current.id && advanceMenu.contains(current)) advanceMenu.setAttribute('aria-activedescendant', current.id);
    else advanceMenu.removeAttribute('aria-activedescendant');
  }
  function openAdvanceMenu() {
    const items = advanceItems();
    if (!items.length) return;
    advanceMenu.hidden = false;
    advanceButton.setAttribute('aria-expanded', 'true');
    (items.find((item) => item.getAttribute('aria-selected') === 'true') || items[0]).focus();
    markAdvanceActive();
  }
  function closeAdvanceMenu(returnFocus) {
    if (advanceMenu.hidden) return;
    advanceMenu.hidden = true;
    advanceButton.setAttribute('aria-expanded', 'false');
    advanceMenu.removeAttribute('aria-activedescendant');
    if (returnFocus) advanceButton.focus();
  }
  function chooseAdvance(mode) {
    closeAdvanceMenu(true);
    if (!mode) return;
    post({ type: 'set-action-policy', mode });
  }
  advanceButton.addEventListener('click', () => { if (advanceMenu.hidden) openAdvanceMenu(); else closeAdvanceMenu(true); });
  advanceButton.addEventListener('keydown', (event) => {
    // Escape closes an open menu from the button too, so the key works wherever the focus is.
    if (event.key === 'Escape' && !advanceMenu.hidden) { event.preventDefault(); closeAdvanceMenu(true); return; }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); openAdvanceMenu(); }
  });
  advanceMenu.addEventListener('keydown', (event) => {
    const items = advanceItems();
    const at = items.indexOf(document.activeElement);
    if (event.key === 'Escape') { event.preventDefault(); closeAdvanceMenu(true); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      (items[(at + step + items.length) % items.length] ?? items[0])?.focus();
      markAdvanceActive();
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      const item = items[at];
      if (item) { event.preventDefault(); chooseAdvance(item.dataset.mode || ''); }
    }
  });
  document.addEventListener('click', (event) => {
    if (!advanceMenu.hidden && !advanceMenu.contains(event.target) && !advanceButton.contains(event.target)) closeAdvanceMenu(false);
  });
  function renderPolicy(state) {
    policyState = state;
    closePolicyMenu(policyMenu.contains(document.activeElement));
    const options = state.options || [];
    const current = options.find((option) => option.mode === state.mode) || {};
    if (state.stopped) {
      policy.textContent = 'Stopped';
      policy.disabled = true;
      policy.dataset.state = 'stopped';
      policy.dataset.risky = 'false';
      policy.setAttribute('aria-label', 'Approval policy: stopped');
      policy.title = 'Emergency stop is on: NEAR AI sends and runs nothing. Run "NEAR AI: Resume" to continue (approval policy stays ' + (current.label || state.mode) + ').';
      policyMenu.replaceChildren();
      return;
    }
    policy.textContent = (current.label || state.mode) + (current.risky ? ' ⚠' : '');
    policy.disabled = false;
    policy.dataset.state = 'ready';
    policy.dataset.risky = current.risky ? 'true' : 'false';
    policy.setAttribute('aria-label', 'Approval policy: ' + (current.label || state.mode));
    policy.title = 'Approval policy: ' + (current.label || state.mode) + ' — ' + (current.description || '') + (state.scope === 'workspace' || state.scope === 'workspaceFolder' ? ' (set in workspace settings)' : '');
    policyMenu.replaceChildren(...options.map((option) => {
      const item = el('div', 'policy-option');
      item.id = 'policy-option-' + option.mode;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(option.mode === state.mode));
      item.tabIndex = -1;
      item.dataset.mode = option.mode;
      item.dataset.risky = option.risky ? 'true' : 'false';
      item.title = option.description;
      item.append(el('strong', '', option.label + (option.risky ? ' ⚠' : '')), el('span', '', option.summary || option.description));
      item.addEventListener('click', () => choosePolicy(option.mode));
      return item;
    }));
  }
  function policyItems() { return [...policyMenu.querySelectorAll('[role="option"]')]; }
  function openPolicyMenu() {
    const items = policyItems();
    if (policy.disabled || !items.length) return;
    policyMenu.hidden = false;
    policy.setAttribute('aria-expanded', 'true');
    (items.find((item) => item.getAttribute('aria-selected') === 'true') || items[0]).focus();
  }
  function closePolicyMenu(returnFocus) {
    if (policyMenu.hidden) return;
    policyMenu.hidden = true;
    policy.setAttribute('aria-expanded', 'false');
    if (returnFocus) policy.focus();
  }
  function choosePolicy(mode) {
    closePolicyMenu(true);
    if (!mode || !policyState || mode === policyState.mode) return;
    post({ type: 'set-action-policy', mode });
  }
  policy.addEventListener('click', () => { if (policyMenu.hidden) openPolicyMenu(); else closePolicyMenu(true); });
  policy.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); openPolicyMenu(); }
  });
  policyMenu.addEventListener('keydown', (event) => {
    const items = policyItems();
    const at = items.indexOf(document.activeElement);
    const move = (index) => { event.preventDefault(); items[(index + items.length) % items.length].focus(); };
    if (event.key === 'ArrowDown') move(at + 1);
    else if (event.key === 'ArrowUp') move(at - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(items.length - 1);
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (at >= 0) choosePolicy(items[at].dataset.mode); }
    else if (event.key === 'Escape') { event.preventDefault(); closePolicyMenu(true); }
    else if (event.key === 'Tab') closePolicyMenu(false);
  });
  document.addEventListener('mousedown', (event) => { if (!policyMenu.hidden && !policyMenu.contains(event.target) && event.target !== policy) closePolicyMenu(false); });
  model.addEventListener('change', () => { saved.model = model.value; vscode.setState(saved); model.title = (modelInfo.get(model.value) || {}).label || ''; });
  document.querySelectorAll('[data-command]').forEach((button) => button.addEventListener('click', () => runCommand(button.dataset.command)));

  // The conversation strip: one tab per open conversation with its status (running, waiting for
  // you, stopped, done) and a dot for output that arrived while it was in the background.
  const STATUS_TEXT = { idle: 'new', running: 'running', waiting: 'waiting for you', done: 'done', error: 'stopped with an error', stopped: 'stopped' };
  let shownTab;
  function titleOf(item) { return item.title || 'New conversation'; }
  function switchConversation(id) { if (id && id !== activeId) post({ type: 'switch-conversation', id }); }
  function closeConversation(id) { post({ type: 'close-conversation', id }); }
  function stepConversation(delta) {
    if (conversations.length < 2) return;
    const at = conversations.findIndex((item) => item.id === activeId);
    switchConversation(conversations[(at + delta + conversations.length) % conversations.length].id);
  }
  function conversationTab(item) {
    const title = titleOf(item);
    const selected = item.id === activeId;
    const unseen = item.unread && !selected;
    const tab = el('div', 'conversation-tab');
    tab.id = 'conversation-' + item.id;
    tab.dataset.id = item.id;
    tab.dataset.status = item.status;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(selected));
    tab.setAttribute('aria-controls', 'transcript');
    tab.tabIndex = selected ? 0 : -1;
    const described = title + ' — ' + (STATUS_TEXT[item.status] || item.status) + (item.waiting > 1 ? ' (' + item.waiting + ' prompts)' : '') + (unseen ? ', new output' : '');
    tab.setAttribute('aria-label', described);
    tab.title = described;
    const dot = el('span', 'status-dot');
    dot.setAttribute('aria-hidden', 'true');
    const unread = el('span', 'unread-dot');
    unread.setAttribute('aria-hidden', 'true');
    unread.hidden = !unseen;
    const close = el('button', 'tab-close');
    close.type = 'button';
    close.tabIndex = -1;
    close.innerHTML = ICONS.close;
    close.title = 'Close (Delete)' + (item.status === 'running' || item.status === 'waiting' ? ': stops its run first' : '');
    close.setAttribute('aria-label', 'Close ' + title);
    close.addEventListener('click', (event) => { event.stopPropagation(); closeConversation(item.id); });
    tab.addEventListener('click', () => switchConversation(item.id));
    tab.append(dot, el('span', 'tab-title', title), unread, close);
    return tab;
  }
  function renderConversations(m) {
    const before = new Map(conversations.map((item) => [item.id, item]));
    conversations = Array.isArray(m.items) ? m.items : [];
    if (m.activeId) activeId = m.activeId;
    const focused = document.activeElement && tabList.contains(document.activeElement) ? document.activeElement.closest('[role="tab"]') : undefined;
    tabList.replaceChildren(...conversations.map(conversationTab));
    if (focused) { const again = document.getElementById(focused.id); if (again) again.focus(); }
    if (shownTab !== activeId) { shownTab = activeId; const selected = document.getElementById('conversation-' + activeId); if (selected) selected.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
    newConversationButton.title = 'New conversation: starts alongside the ones still running (' + conversations.length + ' of ' + (m.max || 8) + ' open)';
    // A background conversation's change of state is said aloud; the one on screen speaks for itself.
    conversations.forEach((item) => {
      const was = before.get(item.id);
      if (!was || item.id === activeId || was.status === item.status) return;
      if (item.status === 'waiting') announce('“' + titleOf(item) + '” needs you.');
      else if (item.status === 'done') announce('“' + titleOf(item) + '” finished.');
      else if (item.status === 'error' || item.status === 'stopped') announce('“' + titleOf(item) + '” stopped.');
    });
    // Prompts waiting in other conversations: answering one takes a switch, one click from here.
    const others = conversations.filter((item) => item.id !== activeId && item.status === 'waiting');
    needsYou.hidden = !others.length;
    if (others.length) needsYou.replaceChildren(el('span', '', others.length === 1 ? '“' + titleOf(others[0]) + '” needs you' : others.length + ' conversations need you'), textButton('Show', () => switchConversation(others[0].id)));
    else needsYou.replaceChildren();
    // Drafts of closed conversations go.
    const open = new Set(conversations.map((item) => item.id));
    let pruned = false;
    Object.keys(saved.drafts).forEach((id) => { if (!open.has(id)) { delete saved.drafts[id]; pruned = true; } });
    if (pruned) vscode.setState(saved);
  }
  newConversationButton.addEventListener('click', () => post({ type: 'new-chat' }));
  // Arrow keys move between tabs (and show the one reached), Home and End jump, Delete closes.
  tabList.addEventListener('keydown', (event) => {
    const tabs = [...tabList.querySelectorAll('[role="tab"]')];
    const at = tabs.indexOf(document.activeElement);
    if (at === -1) return;
    const go = (index) => { event.preventDefault(); const target = tabs[(index + tabs.length) % tabs.length]; target.focus(); switchConversation(target.dataset.id); };
    if (event.key === 'ArrowRight') go(at + 1);
    else if (event.key === 'ArrowLeft') go(at - 1);
    else if (event.key === 'Home') go(0);
    else if (event.key === 'End') go(tabs.length - 1);
    else if (event.key === 'Delete') { event.preventDefault(); closeConversation(tabs[at].dataset.id); }
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); switchConversation(tabs[at].dataset.id); }
  });
  // Ctrl+Shift+[ and ] (Cmd on macOS) switch to the previous and next conversation from anywhere in the view.
  document.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey) return;
    const delta = event.code === 'BracketLeft' || event.key === '[' || event.key === '{' ? -1 : event.code === 'BracketRight' || event.key === ']' || event.key === '}' ? 1 : 0;
    if (!delta) return;
    event.preventDefault();
    stepConversation(delta);
  });

  // history:begin
  // A reopened conversation arrives as batches of items: user messages, assistant replies, tool steps, notices and dividers (D-07). They are drawn in
  // slices of HISTORY_SLICE per animation frame so a long thread never freezes the view (T-27-27), and anything else the host sends meanwhile waits
  // behind them, so what is on screen stays in the order it happened. Tool output is not sent with the step: the card asks for it when it is opened.
  const HISTORY_SLICE = 50;
  const historyQueue = [];
  let historyFrame = 0;
  function previewArguments(text) {
    const flat = String(text || '').replace(/\s+/g, ' ').trim();
    return flat.length > 100 ? flat.slice(0, 100) + '\u2026' : flat;
  }
  function historyToolCard(item) {
    const details = el('details', 'tool history-tool reopened');
    details.dataset.entryId = item.entryId;
    details.dataset.state = item.ok ? 'completed' : 'failed';
    const summary = el('summary');
    summary.append(el('strong', '', item.name));
    const preview = previewArguments(item.args);
    if (preview) summary.append(el('span', 'history-args', preview));
    if (item.note) summary.append(el('span', 'history-note', item.note));
    details.append(summary, el('div', 'log'));
    return details;
  }
  function historyNode(item) {
    if (item.kind === 'user') return el('div', 'turn user reopened', item.text || '');
    if (item.kind === 'assistant') {
      const node = el('div', 'turn assistant reopened');
      const body = el('div');
      renderMarkdown(body, item.text || '');
      node.append(body);
      return node;
    }
    if (item.kind === 'tool') return historyToolCard(item);
    if (item.kind === 'divider') {
      const node = el('div', 'history-divider');
      node.setAttribute('role', 'separator');
      node.setAttribute('aria-label', item.text || '');
      node.append(el('span', '', item.text || ''));
      return node;
    }
    const node = el('div', 'turn notice reopened');
    node.append(el('span', '', item.text || ''));
    return node;
  }
  // A hidden webview never runs an animation frame, so the queue waits on a frame only while the view is visible and on a timer otherwise. Without
  // that, a reopened conversation and every approval, question and live event behind it stalled until the person looked at the view (T-27-138).
  let historyTimer = 0;
  function viewVisible() {
    return typeof requestAnimationFrame === 'function' && document.visibilityState === 'visible';
  }
  function scheduleHistory() {
    if (historyFrame || historyTimer) return;
    if (viewVisible()) historyFrame = requestAnimationFrame(drawHistory);
    else historyTimer = setTimeout(drawHistory, 0);
  }
  function cancelHistoryWork() {
    if (historyFrame) { cancelAnimationFrame(historyFrame); historyFrame = 0; }
    if (historyTimer) { clearTimeout(historyTimer); historyTimer = 0; }
  }
  // Hidden with a frame pending: that frame will not come, so the rest of the queue moves to a timer.
  document.addEventListener('visibilitychange', () => {
    if (historyFrame && document.visibilityState !== 'visible') { cancelAnimationFrame(historyFrame); historyFrame = 0; scheduleHistory(); }
  });
  function drawHistory() {
    historyFrame = 0;
    historyTimer = 0;
    const fragment = document.createDocumentFragment();
    let drawn = 0;
    while (historyQueue.length && drawn < HISTORY_SLICE) {
      const unit = historyQueue[0];
      if (unit.message) {
        // A message that came in behind the history runs once everything before it is on screen.
        if (drawn) break;
        historyQueue.shift();
        onHostMessage(unit.message);
        continue;
      }
      historyQueue.shift();
      fragment.append(historyNode(unit.item));
      drawn += 1;
      if (unit.item.kind === 'notice') announce(unit.item.text || '');
    }
    if (fragment.childNodes.length) append(fragment);
    if (historyQueue.length) scheduleHistory();
  }
  /** Takes a host message that belongs behind the history on screen; false when it can be handled now. */
  function holdForHistory(m) {
    if (m.type === 'transcript' && Array.isArray(m.items)) {
      m.items.forEach((item) => historyQueue.push({ item }));
      // The note goes after the last part, with the last of the items.
      if (m.note) historyQueue.push({ item: { kind: 'notice', text: m.note } });
      scheduleHistory();
      return true;
    }
    if (!historyQueue.length) return false;
    historyQueue.push({ message: m });
    return true;
  }
  function dropHistory() {
    historyQueue.length = 0;
    cancelHistoryWork();
  }
  // Opening a tool step asks the host for its stored output, once; the answer is shown as text, never as markup (T-27-25).
  transcript.addEventListener('toggle', (event) => {
    const card = event.target;
    if (!card || !card.classList || !card.classList.contains('history-tool') || !card.open || card.dataset.asked) return;
    card.dataset.asked = '1';
    const log = card.querySelector('.log');
    if (log) log.textContent = 'Loading\u2026';
    postFor({ type: 'thread-tool-output', entryId: card.dataset.entryId });
  }, true);
  function showToolOutput(m) {
    const cards = transcript.querySelectorAll('details.history-tool');
    for (const card of cards) {
      if (card.dataset.entryId !== m.entryId) continue;
      const log = card.querySelector('.log');
      if (!log) continue;
      const pre = el('pre');
      pre.textContent = typeof m.output === 'string' ? m.output : 'The stored output of this step is not available.';
      log.replaceChildren(pre);
    }
  }
  // history:end

  window.addEventListener('message', (event) => {
    const m = event.data || {};
    if (m.type === 'conversation-show') dropHistory();
    if (holdForHistory(m)) return;
    onHostMessage(m);
  });
  function onHostMessage(m) {
    // Only under the extension-host tests, which load the layout probe: report this page's layout.
    if (m.type === 'layout-probe' && window.nearAiLayoutProbe) { vscode.postMessage(window.nearAiLayoutProbe()); return; }
    switch (m.type) {
      case 'host-request': post(m.payload); break;
      // The view's "New Chat" action: a new conversation, alongside any still running.
      case 'reset': post({ type: 'new-chat' }); break;
      case 'conversations': renderConversations(m); break;
      case 'setup-nudge': setupKit.renderSetupNudge(document, welcomeReady, m.show === true, post, () => input.focus()); break;
      case 'pickup-card': pickupKit.renderPickupCard(document, welcomeReady, m.model, post, () => input.focus()); break;
      case 'sync-status':
        syncKit.renderSyncControl(document, syncButton, m.model, post);
        // The invitation sits in the ready area (shown once a profile works, after "Connect NEAR AI to start") and steps aside while the pick-up card carries its own (syncControl.js decides).
        syncKit.renderSyncPrompt(document, welcomeReady, post, m.prompt === true);
        break;
      case 'conversation-show': {
        draftsLive = false;
        activeId = m.id;
        saved.activeConversation = m.id;
        vscode.setState(saved);
        resetConversation();
        replaying = true;
        if (m.model && modelInfo.has(m.model)) { model.value = m.model; model.title = (modelInfo.get(m.model) || {}).label || ''; }
        break;
      }
      case 'conversation-shown': {
        replaying = false;
        setBusy(Boolean(m.busy));
        input.value = saved.drafts[m.id] || '';
        draftsLive = true;
        autosize();
        updateSendState();
        scrollToEnd();
        break;
      }
      case 'user-turn': append(el('div', 'turn user', m.text || '')); break;
      case 'prompt-record': {
        const line = el('div', 'turn pending-line resolved');
        line.append(el('span', '', pendingKit.outcomeText({ kind: m.kind, title: m.title || '' }, m.outcome, m.detail)));
        append(line);
        break;
      }
      case 'prefill': {
        // "Use in chat" inserts a command and keeps the draft; other prefills (a resumed session) set the text.
        if (m.insert) { const next = window.nearComposer.insertCommand(input.value, m.text); input.value = next.text; input.focus(); input.setSelectionRange(next.caret, next.caret); }
        else { input.value = m.text || ''; input.focus(); }
        autosize(); updateSendState();
        break;
      }
      case 'status': status.textContent = (m.value || '') + (status.dataset.context || ''); status.title = (m.value || '') + (m.tooltip ? '\n' + m.tooltip : '') + (m.token ? '\n' + m.token.text + ' (the link below)' : '') + ' — click for detailed progress'; showSpendToken(m.token); break;
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
      case 'action-policy': renderPolicy(m); renderAdvance(m); break;
      case 'models-error': model.replaceChildren(el('option', '', 'Models unavailable')); model.title = m.text || ''; break;
      case 'auth-required':
        if (current) { removeTurn(current.node); current = undefined; }
        setBusy(false);
        notice(m.text || 'Set up NEAR AI to start chatting.', [
          textButton('Set up a new profile', () => post({ type: 'new-profile' }), true),
          textButton('Choose a profile', () => post({ type: 'select-profile' }))
        ]);
        break;
      case 'profile-status': {
        const value = m.value || {};
        const active = (value.profiles || []).find((item) => item.profileId === value.activeProfileId);
        profile.textContent = active ? active.displayName : 'Set up';
        profile.title = active ? active.displayName + (active.organization && active.organization !== active.displayName ? ' · ' + active.organization : '') + ' — click to switch profile' : 'Set up NEAR AI for this project';
        profile.dataset.state = active ? (active.validation && active.validation.status === 'valid' ? 'ready' : 'attention') : 'missing';
        { const focus = setupKit.applyWelcomeState(document, setupKit.welcomeState(value), welcomeMemory); if (focus && !welcome.hidden) focus.focus(); }
        break;
      }
      case 'assistant-start': settleContinue(false); runInfo = { model: m.model, privacy: m.privacy }; setBusy(true); if (!current) startAssistant(); if (m.status) status.textContent = m.status; break;
      case 'assistant-delta':
        if (!current) startAssistant();
        current.text += m.text || '';
        if (!current.frame) current.frame = requestAnimationFrame(() => flushAssistant(true));
        break;
      case 'assistant-done': {
        // A run is several text segments around tool rows; the footer goes after the last one.
        if (!current) startAssistant();
        lastReply = { node: current.node, usage: m.usage, model: runInfo.model, privacy: runInfo.privacy, spend: m.spend };
        if (m.runId) { replies.set(m.runId, lastReply); if (replies.size > 50) replies.delete(replies.keys().next().value); }
        finishAssistant(usageLine(m.usage, runInfo.model, runInfo.privacy, undefined, m.spend));
        { const meta = lastReply.node.querySelector('.meta'); if (meta && m.spend) meta.title = COST_TIP; }
        announce('Response complete.');
        break;
      }
      case 'tool-start': onAgentToolStart(m); break;
      case 'tool-end': onAgentToolEnd(m); break;
      case 'approval-request': onApproval(m); break;
      case 'approval-expired':
        if (closePending(m.callId, 'expired', m.minutes)) announce(m.text || 'An approval request expired.');
        else notice(m.text || 'An approval request expired.', []);
        break;
      // 0.4.19: the wait reached its timeout and the run parked on this step. The card stays, because the answer is still owed and the run carries on
      // from here when it comes.
      case 'approval-paused': {
        const entry = pendingCards.get(m.callId);
        const text = m.text || 'The run is paused on this step until you answer.';
        // The card stays and keeps its buttons: the answer is still owed, and the run carries on from this step when it comes.
        if (entry && !entry.card.querySelector('.pending-paused')) {
          const paused = el('p', 'pending-paused', text);
          entry.card.append(paused);
        } else if (!entry) notice(text, []);
        announce(text);
        break;
      }
      case 'prompt-closed': closePending(m.id, m.outcome === 'cancelled' ? 'cancelled' : 'closed'); break;
      case 'todos': renderTodos(m.todos || [], m.unconfirmed === true); break;
      case 'run-changes': onRunChanges(m); break;
      case 'run-reverted': {
        const row = document.getElementById('changes-' + m.runId);
        if (row) row.replaceChildren(el('span', '', `Reverted ${m.files.length} file${m.files.length === 1 ? '' : 's'}.`));
        announce('Changes reverted.');
        break;
      }
      case 'response-verifiable': {
        const node = lastReply && lastReply.node;
        if (!node) break;
        const row = el('div', 'verify');
        row.id = 'verify-' + m.runId;
        row.append(textButton('Verify signature', () => { row.replaceChildren(el('span', '', 'Checking NEAR\u2019s signature and attestation\u2026')); postFor({ type: 'verify-response', runId: m.runId }); }));
        node.append(row);
        break;
      }
      case 'response-verification': {
        const row = document.getElementById('verify-' + m.runId);
        if (!row) break;
        const r = m.result || {};
        const icon = r.outcome === 'signed' ? '\u2713 ' : r.outcome === 'failed' ? '\u2717 ' : '';
        const line = el('span', r.outcome === 'failed' ? 'verify-failed' : r.outcome === 'signed' ? 'verify-ok' : '', icon + (r.summary || ''));
        if (r.notChecked && r.notChecked.length) line.title = 'Not checked in the editor: ' + r.notChecked.join(', ') + '. For a full check use cloud.near.ai/verify or NEAR\u2019s nearai-cloud-verifier.';
        row.replaceChildren(line);
        announce(r.summary || 'Verification finished.');
        break;
      }
      case 'assistant-cost': {
        const reply = (m.runId && replies.get(m.runId)) || (!m.runId && lastReply);
        const meta = reply && reply.node.querySelector('.meta');
        if (meta) meta.textContent = usageLine(reply.usage, reply.model, reply.privacy, m.actualCostUsd, reply.spend);
        break;
      }
      case 'outbound-blocked': {
        if (current) { removeTurn(current.node); current = undefined; }
        setBusy(false);
        const actions = m.overrideToken ? [textButton(m.confirm ? 'Send anyway' : 'Send once anyway', () => {
          setBusy(true);
          startAssistant();
          postFor({ type: 'send', text: m.text, model: m.model, overrideToken: m.overrideToken });
        }, false)] : [];
        notice(m.reason, actions, !m.confirm);
        break;
      }
      case 'assistant-cancelled':
        closeAllPending('cancelled');
        agentRows.forEach((row) => { if (row.spinner.isConnected) { row.spinner.remove(); row.state.textContent = 'stopped'; } });
        if (current) finishAssistant('Stopped');
        else setBusy(false);
        if (m.status) status.textContent = m.status;
        break;
      case 'assistant-retry':
        // The failed attempt's partial text is void; the retry streams its own.
        if (current && m.discard) { current.text = current.text.slice(0, Math.max(0, current.text.length - m.discard)); flushAssistant(true); }
        notice(m.text || 'Retrying…', []);
        break;
      case 'assistant-error':
        closeAllPending('cancelled');
        finishAssistant();
        notice(m.text || 'The request failed.', [], true);
        break;
      case 'command-progress': onCommandProgress(m); break;
      case 'structured-prompt': onPrompt(m.prompt); break;
      case 'prompt-error': notice(m.text || 'That answer could not be sent.', [], true); break;
      case 'history-error': notice(m.text, [], true); break;
      case 'artifacts': renderArtifacts(m.artifacts); break;
      case 'attachment-staged': staged.set(m.id, m.name); savedAs.set(m.id, m.savedAs || ''); renderChips(); announce('Attached ' + m.name + (m.savedAs ? ', saved in the project as ' + m.savedAs : '')); break;
      case 'attachments-cleared': staged.clear(); savedAs.clear(); renderChips(); break;
      case 'commands': if (Array.isArray(m.commands) && m.commands.length) commands = m.commands; break;
      case 'notice': notice(m.text || '', []); break;
      // A run the extension host never finished: nothing continues until the user clicks Resume.
      case 'run-interrupted': {
        const actions = m.resumable ? [textButton('Resume', () => settleCut('resume-interrupted'), true), textButton('Dismiss', () => settleCut('dismiss-interrupted'), false)] : [];
        actions.forEach((button) => button.classList.add('cut-action'));
        notice(m.text || 'This run was cut off.', actions);
        break;
      }
      // A run the agent stopped short (stuck, or at the turn limit): Continue sends "Continue." for the user.
      case 'run-stopped': {
        const actions = m.continuable ? [textButton('Continue', () => settleContinue(true), true)] : [];
        actions.forEach((button) => button.classList.add('continue-action'));
        notice(m.text || 'Stopped.', actions);
        break;
      }
      case 'run-interrupted-settled':
        settleCut();
        if (m.text) notice(m.text, []);
        break;
      case 'progress': {
        const last = transcript.lastElementChild;
        if (last && last.classList.contains('progress')) { last.firstChild.textContent = m.text || ''; announce(m.text || ''); }
        else { notice(m.text || '', []); transcript.lastElementChild.classList.add('progress'); }
        break;
      }
      case 'agents':
        status.textContent = /Agents \d+/.test(status.textContent) ? status.textContent.replace(/Agents \d+/, 'Agents ' + m.count) : status.textContent;
        renderAgents(m.agents || []);
        break;
      case 'context':
        contextLeft = m.level === 'normal' ? undefined : m.remainingPercent;
        status.dataset.context = contextLeft === undefined ? '' : ` · context ${contextLeft}% left`;
        break;
      // A saved conversation's turns, at the start of a conversation opened from history or after a reload.
      case 'transcript': {
        (m.turns || []).forEach((turn) => {
          if (turn.role === 'user') append(el('div', 'turn user', turn.text));
          else {
            const node = append(el('div', 'turn assistant'));
            const body = el('div');
            renderMarkdown(body, turn.text || '');
            node.append(body);
            if (turn.tools) node.append(el('div', 'meta', `${turn.tools} tool call${turn.tools === 1 ? '' : 's'}`));
          }
        });
        notice(m.note || 'Resumed this conversation with its full context. Continue where you left off.', []);
        break;
      }
      case 'thread-tool-output': showToolOutput(m); break;
      case 'questions-request': onQuestions(m); break;
      case 'steer-state': onSteerState(m); break;
      default: break;
    }
  }

  setBusy(false);
  autosize();
  post({ type: 'load-models' });
  post({ type: 'refresh-status' });
  // After a reload the host re-sends any prompt that is still waiting.
  post({ type: 'chat-ready' });
})();
