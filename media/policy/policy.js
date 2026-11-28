// The rules page: your organization's rules (or your rules) read only, and a proposed change with one plain sentence per changed key.
// Everything the host sends is set with textContent; nothing is parsed as HTML.
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
  const ACTION_LABELS = { apply: 'Apply to my Standing Orders', export: 'Save a file for your organization', discard: 'Discard' };
  const MARKERS = { widens: 'Wider', narrows: 'Stricter' };
  const text = (value) => (typeof value === 'string' ? value : '');
  let lastAtSeq = 0;

  function button(label, onClick, secondary) {
    const node = el('button', secondary ? 'secondary' : '', label);
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
  }

  function renderProposal(proposal, actions) {
    const box = $('proposal');
    box.replaceChildren();
    if (!proposal || typeof proposal !== 'object') { box.hidden = true; return; }
    box.hidden = false;
    box.append(el('h2', '', proposal.stale === true ? 'Proposed change (out of date)' : 'Proposed change'));
    if (text(proposal.from)) box.append(el('p', 'hint', 'Asked by: ' + text(proposal.from)));
    if (text(proposal.reason)) box.append(el('p', 'hint', text(proposal.reason)));
    const list = el('ul', 'changes');
    const changes = Array.isArray(proposal.changes) ? proposal.changes : [];
    for (const change of changes) {
      if (!change || typeof change !== 'object') continue;
      const item = el('li', 'change');
      const marker = MARKERS[change.direction];
      if (marker) item.append(el('span', 'marker ' + (change.direction === 'widens' ? 'wider' : 'stricter'), marker));
      item.append(el('span', 'effect', text(change.effect)));
      list.append(item);
    }
    box.append(list);
    const row = el('div', 'actions');
    for (const action of Array.isArray(actions) ? actions : []) {
      const label = ACTION_LABELS[action];
      if (!label) continue;
      row.append(button(label, () => vscode.postMessage({ type: action, id: text(proposal.id) }), action === 'discard'));
    }
    box.append(row);
  }

  function renderSections(sections, at) {
    const holder = $('sections');
    holder.replaceChildren();
    for (const section of Array.isArray(sections) ? sections : []) {
      if (!section || typeof section !== 'object') continue;
      const part = el('section', 'rules');
      if (text(section.id)) part.id = 'section-' + text(section.id);
      part.append(el('h2', '', text(section.title)));
      const rows = el('dl', 'rows');
      for (const row of Array.isArray(section.rows) ? section.rows : []) {
        if (!row || typeof row !== 'object') continue;
        rows.append(el('dt', '', text(row.name)), el('dd', '', text(row.value)));
      }
      part.append(rows);
      holder.append(part);
      if (at && text(section.id) === at) part.scrollIntoView();
    }
  }

  // Edit my Standing Orders and Apply my draft appear when the host offers them.
  // Show as stored and Reset my Standing Orders always appear. The host checks each message again.
  const PAGE_ACTION_LABELS = { 'edit-own': 'Edit my Standing Orders', 'apply-draft': 'Apply my draft' };
  function renderPageActions(offered) {
    const own = (Array.isArray(offered) ? offered : []).filter((action) => Object.prototype.hasOwnProperty.call(PAGE_ACTION_LABELS, action));
    $('page-actions').replaceChildren(
      ...own.map((action) => button(PAGE_ACTION_LABELS[action], () => vscode.postMessage({ type: action }), false)),
      button('Show as stored', () => vscode.postMessage({ type: 'show-stored' }), true),
      button('Reset my Standing Orders', () => vscode.postMessage({ type: 'reset' }), true)
    );
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'state') {
      $('title').textContent = text(message.title);
      $('set-by').textContent = text(message.setBy);
      $('notice').textContent = text(message.notice);
      renderProposal(message.proposal, message.actions);
      renderPageActions(message.pageActions);
      // Scroll to the section asked for once per request, not on every update.
      const seq = typeof message.atSeq === 'number' ? message.atSeq : 0;
      renderSections(message.sections, seq !== lastAtSeq ? text(message.at) : '');
      lastAtSeq = seq;
    } else if (message.type === 'error') {
      $('notice').textContent = text(message.text);
    }
  });

  renderPageActions([]);
  vscode.postMessage({ type: 'ready' });
})();
