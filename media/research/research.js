// The research workspace page (74.1-UI-SPEC S1). It only renders what the host posts and posts what the person does; every word comes from the host
// (RESEARCH_TEXT). Text goes in as text nodes; an answer's Markdown goes through the chat's renderer, which escapes every character first.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const page = document.getElementById('page');
  const status = document.getElementById('status');
  const ICONS = {
    beaker: '<svg class="codicon-svg" viewBox="0 0 16 16" aria-hidden="true"><path d="M10 1v1h-.5v4.3l4.3 6.5A1.5 1.5 0 0 1 12.6 15H3.4a1.5 1.5 0 0 1-1.2-2.2L6.5 6.3V2H6V1zM7.5 2v4.6l-1.6 2.4h4.2L8.5 6.6V2zM5.2 10l-2.1 3.3a.5.5 0 0 0 .4.7h9.1a.5.5 0 0 0 .4-.7L10.8 10z"/></svg>',
    copy: '<svg class="codicon-svg" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4V2.5A1.5 1.5 0 0 1 5.5 1h7A1.5 1.5 0 0 1 14 2.5v7a1.5 1.5 0 0 1-1.5 1.5H11v1.5A1.5 1.5 0 0 1 9.5 14h-7A1.5 1.5 0 0 1 1 12.5v-7A1.5 1.5 0 0 1 2.5 4zm1 0h4.5A1.5 1.5 0 0 1 11 5.5V10h1.5a.5.5 0 0 0 .5-.5v-7a.5.5 0 0 0-.5-.5h-7a.5.5 0 0 0-.5.5zM2.5 5a.5.5 0 0 0-.5.5v7a.5.5 0 0 0 .5.5h7a.5.5 0 0 0 .5-.5v-7a.5.5 0 0 0-.5-.5z"/></svg>',
    check: '<svg class="codicon-svg" viewBox="0 0 16 16" aria-hidden="true"><path d="m6.3 11.6-3.6-3.6.7-.7 2.9 2.9 6.3-6.3.7.7z"/></svg>',
    add: '<svg class="codicon-svg" viewBox="0 0 16 16" aria-hidden="true"><path d="M7.5 2h1v5.5H14v1H8.5V14h-1V8.5H2v-1h5.5z"/></svg>',
    fileAdd: '<svg class="codicon-svg" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 1h6.7L13 4.3V8h-1V5H9V2H4v12h4v1H3zm7 1.4V4h1.6zM12 10h1v2h2v1h-2v2h-1v-2h-2v-1h2z"/></svg>',
    close: '<svg class="codicon-svg" viewBox="0 0 16 16" aria-hidden="true"><path d="m8 7.3 3.6-3.6.7.7L8.7 8l3.6 3.6-.7.7L8 8.7l-3.6 3.6-.7-.7L7.3 8 3.7 4.4l.7-.7z"/></svg>'
  };
  let words = {};
  let busy = false;
  let picked;
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const icon = (name) => { const span = el('span', 'icon'); span.innerHTML = ICONS[name]; return span; };
  const button = (label, onClick, options) => {
    const node = el('button', options && options.primary ? 'primary' : 'secondary');
    node.type = 'button';
    if (options && options.icon) node.append(icon(options.icon));
    if (options && options.iconOnly) { node.classList.add('icon-only'); node.setAttribute('aria-label', label); node.title = label; } else node.append(el('span', '', label));
    node.addEventListener('click', onClick);
    return node;
  };
  const say = (text) => { status.textContent = ''; window.setTimeout(() => { status.textContent = text; }, 30); };

  // The layout: header, banner, model row, transcript, composer.
  const header = el('div', 'top');
  const title = el('div', 'header-row');
  const h1 = el('h1');
  const newChat = el('div');
  title.append(h1, newChat);
  const banner = el('div', 'lifted bar-warning banner');
  banner.setAttribute('role', 'note');
  const modelRow = el('div', 'model-row');
  const modelLabel = el('label');
  modelLabel.htmlFor = 'model';
  const select = el('select');
  select.id = 'model';
  const facts = el('p', 'facts');
  const reload = el('div');
  modelRow.append(modelLabel, select, facts, reload);
  header.append(title, banner, modelRow);
  const transcript = el('div', 'transcript');
  transcript.setAttribute('aria-live', 'off');
  const composer = el('div', 'composer');
  const chips = el('div', 'chips');
  const box = el('textarea');
  box.rows = 3;
  box.setAttribute('aria-label', 'Message');
  const bar = el('div', 'bar');
  composer.append(chips, box, bar);
  page.append(header, transcript, composer);

  function renderWords() {
    h1.textContent = words.panelTitle;
    newChat.replaceChildren(button(words.newChat, () => vscode.postMessage({ type: 'new-chat' }), { icon: 'add' }));
    const first = el('p', 'banner-title', words.banner);
    const second = el('p', 'muted', words.bannerDetail);
    const text = el('div');
    text.append(first, second);
    banner.replaceChildren(icon('beaker'), text);
    modelLabel.textContent = words.modelLabel;
    box.placeholder = words.placeholder;
    const add = button(words.addFile, () => vscode.postMessage({ type: 'add-file' }), { icon: 'fileAdd' });
    const send = button(words.send, () => submit(), { primary: true });
    send.id = 'send';
    bar.replaceChildren(add, el('span', 'spacer'), send);
    // Keep the focused item below the sticky banner.
    document.documentElement.style.setProperty('--banner-height', header.offsetHeight + 'px');
  }

  function submit() {
    if (busy || !box.value.trim()) return;
    vscode.postMessage({ type: 'send', text: box.value });
    box.value = '';
  }

  box.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); }
    if (event.key === 'Escape' && !box.value && busy) vscode.postMessage({ type: 'stop' });
  });
  // A paste of a path or a `/` command reaches nothing: the host says so.
  box.addEventListener('input', () => { if (box.value === '/') vscode.postMessage({ type: 'reach-out' }); });
  select.addEventListener('change', () => { picked = select.value; vscode.postMessage({ type: 'choose-model', model: select.value }); });
  document.addEventListener('dragover', (event) => { event.preventDefault(); });
  document.addEventListener('drop', (event) => {
    event.preventDefault();
    const list = event.dataTransfer && (event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain'));
    const uris = (list || '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
    if (uris.length === 0) { vscode.postMessage({ type: 'reach-out' }); return; }
    for (const uri of uris) vscode.postMessage({ type: 'drop-file', uri });
  });

  function renderAnswer(container, text, turnIndex) {
    const blocks = window.nearMarkdown ? window.nearMarkdown.parse(text) : [{ type: 'html', html: '' }];
    let code = 0;
    for (const block of blocks) {
      if (block.type === 'code') {
        const index = code++;
        const wrap = el('div', 'code');
        const head = el('div', 'code-head');
        head.append(el('span', 'muted', block.lang || ''), button(words.copyName, () => vscode.postMessage({ type: 'copy', turn: turnIndex, block: index }), { icon: 'copy', iconOnly: true }));
        const pre = el('pre');
        pre.append(el('code', '', block.code));
        wrap.append(head, pre);
        container.append(wrap);
      } else {
        const part = el('div');
        // The renderer escapes every character of the model's text before it adds markup (media/chat/markdown.js).
        part.innerHTML = block.html;
        container.append(part);
      }
    }
  }

  function renderTranscript(message) {
    if (message.model) { select.value = message.model; picked = message.model; }
    facts.textContent = message.facts || '';
    transcript.replaceChildren();
    if (!message.model && message.turns.length === 0) {
      const empty = el('div', 'empty');
      const big = icon('beaker');
      big.classList.add('big');
      empty.append(big, el('h2', '', words.emptyTitle), el('p', 'muted', words.emptyBody));
      transcript.append(empty);
    }
    for (const turn of message.turns) {
      const node = el('div', 'turn ' + turn.role);
      if (turn.role === 'assistant') {
        renderAnswer(node, turn.text, turn.index);
        const foot = el('div', 'turn-foot');
        foot.append(el('span', 'muted', turn.trust || ''), button(words.copyName, () => vscode.postMessage({ type: 'copy', turn: turn.index }), { icon: 'copy', iconOnly: true }));
        node.append(foot);
      } else node.textContent = turn.text;
      transcript.append(node);
    }
    chips.replaceChildren(...message.files.map((name, index) => {
      const chip = el('span', 'chip', name);
      chip.append(button('Remove ' + name, () => vscode.postMessage({ type: 'remove-file', index }), { icon: 'close', iconOnly: true }));
      return chip;
    }));
    setBusy(busy);
    transcript.scrollTop = transcript.scrollHeight;
  }

  function setBusy(on) {
    busy = on;
    const send = document.getElementById('send');
    if (send) send.setAttribute('aria-disabled', on || !picked ? 'true' : 'false');
    box.disabled = !picked;
  }

  function addNotice(text, error) {
    const node = el('div', error ? 'turn notice error' : 'turn notice', text);
    transcript.append(node);
    node.scrollIntoView({ block: 'nearest' });
    say(text);
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message && message.type) {
      case 'words': words = message.words; renderWords(); break;
      case 'models-loading': {
        const option = el('option', '', words.loadingModels);
        select.replaceChildren(option);
        select.disabled = true;
        break;
      }
      case 'models-error':
        select.replaceChildren();
        select.disabled = true;
        say(message.text);
        reload.replaceChildren(el('p', 'error', message.text), button(words.reloadModels, () => vscode.postMessage({ type: 'reload-models' })));
        break;
      case 'no-models':
        select.replaceChildren();
        select.disabled = true;
        reload.replaceChildren(el('p', 'muted', words.noModels), ...(message.addService ? [button(words.addService, () => vscode.postMessage({ type: 'add-service' }))] : []));
        break;
      case 'models': {
        reload.replaceChildren();
        const none = el('option', '', words.emptyTitle);
        none.value = '';
        none.disabled = true;
        select.replaceChildren(none, ...message.groups.map((group) => {
          const optgroup = el('optgroup');
          optgroup.label = group.label;
          optgroup.append(...group.options.map((option) => { const node = el('option', '', option.text); node.value = option.id; node.title = option.title; return node; }));
          return optgroup;
        }));
        select.disabled = false;
        select.value = message.selected || '';
        if (!message.selected) select.focus();
        break;
      }
      case 'transcript': renderTranscript(message); break;
      case 'waiting': {
        setBusy(true);
        const node = el('div', 'turn assistant waiting');
        node.append(el('span', 'spinner'), el('span', 'visually-hidden', message.text));
        node.id = 'pending';
        transcript.append(node);
        break;
      }
      case 'delta': {
        const node = document.getElementById('pending');
        if (node) { node.replaceChildren(); renderAnswer(node, message.text, -1); }
        break;
      }
      case 'idle': setBusy(false); break;
      case 'returned': if (!box.value) box.value = message.text; break;
      case 'notice': addNotice(message.text, message.error); break;
      case 'status': say(message.text); break;
      default: break;
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
