// Team Board New item and Edit item form (62-UI-SPEC "New item form (D-14)"). It opens in the shared aside#detail, validates with the rules the host applies again,
// sends one new-item or edit-item request and waits for the host's saved or refused answer. Plain browser JavaScript in an IIFE that plugs into board.js through
// window.NearAiBoard. Text nodes only, attributes with setAttribute, no markup strings. The form says Close form, never the word kept for the real cancel action.
(function () {
  'use strict';
  const board = window.NearAiBoard;
  if (!board) return;
  const drawer = board.drawer();
  const TITLE_MAX = 200;
  const DESCRIPTION_MAX = 2000;
  const FILES_MAX = 64;
  const FILE_MAX = 200;
  const ESTIMATE_MAX = 1000000000000;
  const COUNTER_FROM = 200;
  const KINDS = [['bug', 'Bug'], ['chore', 'Chore'], ['spike', 'Spike']];
  const T = {
    newTitle: 'New item', editTitle: 'Edit item', type: 'Type', title: 'Title', description: 'Description (optional)', files: 'Files this touches (optional)',
    filesHint: 'One pattern per line, for example src/services/**', estimate: 'Estimate in tokens (optional)', estimateHint: 'A rough size is fine. Typical plans are 50,000 to 100,000.',
    readiness: 'Without files and an estimate this item stays in Backlog.', add: 'Add item', adding: 'Adding...', save: 'Save changes', saving: 'Saving...', close: 'Close form',
    discard: 'Discard this item?', discardYes: 'Discard changes', keep: 'Keep editing', loading: 'Loading details...', newItem: 'New item',
    cannotEdit: 'This item cannot be edited.', noChanges: 'No changes to save.', gone: 'That item is no longer on the board.',
    titleEmpty: 'Enter a title.', titleLong: 'The title must be 200 characters or fewer.', descriptionLong: 'The description must be 2000 characters or fewer.',
    files_: 'Use one pattern per line, relative to the project folder, for example src/services/**.', estimate_: 'Enter a whole number of tokens, 1 or more.'
  };

  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  function button(cls, label, onClick) {
    const b = el('button', cls, label);
    b.setAttribute('type', 'button');
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }
  const attr = (n, name, value) => { if (value === null || value === undefined) n.removeAttribute(name); else n.setAttribute(name, value); };

  // ---- validation: the same rules the host applies again ---------------------------------------------------------------------------------------
  const lines = (text) => text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
  const isPattern = (line) => line.length >= 1 && line.length <= FILE_MAX && !/[\u0000-\u001F\u007F\u2028\u2029]/.test(line) && line.indexOf('\\') < 0 && line.charAt(0) !== '/' && line.split('/').indexOf('..') < 0;
  const estimateOf = (text) => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : NaN);
  function problem(name, v) {
    switch (name) {
      case 'title': return v.title.trim() === '' ? T.titleEmpty : v.title.trim().length > TITLE_MAX ? T.titleLong : '';
      case 'description': return v.description.length > DESCRIPTION_MAX ? T.descriptionLong : '';
      case 'files': { const l = lines(v.files); return l.length > FILES_MAX || !l.every(isPattern) ? T.files_ : ''; }
      case 'estimate': {
        // An estimate can be changed but not taken away again.
        if (v.estimate.trim() === '') return f && f.mode === 'edit' && f.initial.estimate !== '' ? T.estimate_ : '';
        const n = estimateOf(v.estimate); return Number.isSafeInteger(n) && n >= 1 && n <= ESTIMATE_MAX ? '' : T.estimate_;
      }
      default: return '';
    }
  }
  const FIELD_ORDER = ['title', 'description', 'files', 'estimate'];

  // ---- the form --------------------------------------------------------------------------------------------------------------------------------
  let f; // { mode, id, kind, opener, form, nodes, errors, hints, counter, alert, submit, discardRow, initial, busy, sent, wasHidden, hidden }
  let waitingFocus;
  let loading; // an edit waiting for its detail: { id, opener, restored }

  const clean = (v) => ({ type: v.type, title: v.title.trim(), description: v.description.replace(/\r\n?/g, '\n').trim(), files: lines(v.files).join('\n'), estimate: v.estimate.trim() });
  function read() {
    return { type: f.nodes.type.value, title: f.nodes.title.value, description: f.nodes.description.value, files: f.nodes.files.value, estimate: f.nodes.estimate.value };
  }
  const isChanged = () => JSON.stringify(clean(read())) !== JSON.stringify(f.initial);

  function field(id, label, control, hintText) {
    const wrap = el('div', 'form-field');
    const l = el('label', '', label);
    l.setAttribute('for', id);
    control.id = id;
    wrap.append(l, control);
    const hint = hintText ? el('p', 'hint', hintText) : null;
    if (hint) { hint.id = id + '-hint'; wrap.appendChild(hint); }
    return { wrap, hint };
  }

  function buildForm(mode, itemId, values, kindWord) {
    const form = el('form');
    form.id = 'item-form';
    form.setAttribute('novalidate', '');
    form.setAttribute('aria-labelledby', 'item-form-title');
    const heading = el('h2', '', mode === 'new' ? T.newTitle : T.editTitle);
    heading.id = 'item-form-title';
    heading.setAttribute('tabindex', '-1');
    const alert = el('div', 'form-alert');
    alert.setAttribute('role', 'alert');
    alert.hidden = true;

    const nodes = {};
    const wraps = [];
    if (mode === 'new') {
      const select = el('select');
      for (const [value, word] of KINDS) { const o = el('option', '', word); o.setAttribute('value', value); select.appendChild(o); }
      select.value = values.type;
      nodes.type = select;
      wraps.push(field('item-type', T.type, select).wrap);
    } else {
      // The type of an item cannot change, so it is shown as text.
      const fixed = el('p', 'form-type', kindWord);
      fixed.id = 'item-type';
      nodes.type = { value: values.type };
      const wrap = el('div', 'form-field');
      wrap.append(el('span', 'form-label', T.type), fixed);
      wraps.push(wrap);
    }
    const title = el('input');
    title.setAttribute('type', 'text');
    title.setAttribute('autocomplete', 'off');
    title.setAttribute('required', '');
    title.value = values.title;
    nodes.title = title;
    wraps.push(field('item-title', T.title, title).wrap);

    const description = el('textarea');
    description.setAttribute('rows', '4');
    description.setAttribute('maxlength', String(DESCRIPTION_MAX));
    description.value = values.description;
    nodes.description = description;
    const d = field('item-description', T.description, description);
    const counter = el('p', 'counter');
    counter.id = 'item-description-counter';
    counter.hidden = true;
    d.wrap.appendChild(counter);
    wraps.push(d.wrap);

    const files = el('textarea');
    files.setAttribute('rows', '3');
    files.value = values.files;
    nodes.files = files;
    wraps.push(field('item-files', T.files, files, T.filesHint).wrap);

    const estimate = el('input');
    estimate.setAttribute('type', 'number');
    estimate.setAttribute('min', '1000');
    estimate.setAttribute('step', '1000');
    estimate.value = values.estimate;
    nodes.estimate = estimate;
    wraps.push(field('item-estimate', T.estimate, estimate, T.estimateHint).wrap);

    const readiness = el('p', 'hint', T.readiness);
    const submit = el('button', '', mode === 'new' ? T.add : T.save);
    submit.setAttribute('type', 'submit');
    const closeBtn = button('secondary', T.close, () => requestClose());
    const buttons = el('div', 'form-buttons');
    buttons.append(submit, closeBtn);
    const discardRow = el('div', 'form-alert form-discard');
    discardRow.hidden = true;
    form.append(heading, alert, ...wraps, readiness, buttons, discardRow);

    const errors = {};
    for (const name of FIELD_ORDER) {
      const e = el('p', 'error');
      e.id = 'item-' + name + '-error';
      e.hidden = true;
      nodes[name].parentNode.appendChild(e);
      errors[name] = e;
    }
    return { form, heading, nodes, errors, counter, alert, submit, discardRow };
  }

  function showProblem(name, message) {
    const control = f.nodes[name];
    const e = f.errors[name];
    e.textContent = message;
    e.hidden = message === '';
    const hint = document.getElementById('item-' + name + '-hint');
    const ids = [];
    if (message !== '') ids.push(e.id);
    if (hint) ids.push(hint.id);
    attr(control, 'aria-invalid', message === '' ? null : 'true');
    attr(control, 'aria-describedby', ids.length > 0 ? ids.join(' ') : null);
  }
  function validate(name) {
    const message = problem(name, read());
    showProblem(name, message);
    return message === '';
  }
  function updateCounter() {
    const left = DESCRIPTION_MAX - f.nodes.description.value.length;
    f.counter.hidden = left > COUNTER_FROM;
    f.counter.textContent = left > COUNTER_FROM ? '' : Math.max(0, left) + (left === 1 ? ' character left.' : ' characters left.');
  }

  function draftNow() {
    if (!f || f.busy) return;
    const v = read();
    board.setDraft({ mode: f.mode, ...(f.mode === 'edit' ? { id: f.id } : {}), values: { type: v.type, title: v.title, description: v.description, files: v.files, estimate: v.estimate } });
  }

  function present(mode, itemId, values, initial, opener, extra) {
    const built = buildForm(mode, itemId, values, extra.kindWord);
    f = Object.assign({ mode, id: itemId, kind: extra.kind, opener, initial, busy: false, sent: undefined, wasHidden: drawer.hidden, hidden: [] }, built);
    for (const child of [...drawer.children]) { if (!child.hidden) { child.hidden = true; f.hidden.push(child); } }
    drawer.appendChild(f.form);
    drawer.hidden = false;
    drawer.scrollTop = 0;
    for (const name of FIELD_ORDER) {
      const node = f.nodes[name];
      node.addEventListener('blur', () => { if (f && !f.busy) validate(name); });
      node.addEventListener('input', () => { if (name === 'description') updateCounter(); if (f && f.nodes[name].getAttribute('aria-invalid') === 'true') validate(name); draftNow(); });
    }
    if (f.nodes.type.addEventListener) f.nodes.type.addEventListener('change', draftNow);
    f.submit.addEventListener('click', (e) => { e.preventDefault(); submit(); });
    f.form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
    f.form.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey) return;
      e.preventDefault();
      requestClose();
    });
    updateCounter();
    (mode === 'new' ? f.nodes.type : f.nodes.title).focus();
  }

  function openNew(restored) {
    const values = restored && restored.values ? restored.values : { type: 'chore', title: '', description: '', files: '', estimate: '' };
    const merged = Object.assign({ type: 'chore', title: '', description: '', files: '', estimate: '' }, values);
    present('new', '', merged, { type: 'chore', title: '', description: '', files: '', estimate: '' }, document.activeElement, { kind: merged.type });
  }

  function openEdit(detail, loadingState) {
    const base = { type: detail.kind, title: detail.title, description: detail.description || '', files: (detail.files || []).join('\n'), estimate: detail.estimateTokens === undefined ? '' : String(detail.estimateTokens) };
    const restored = loadingState.restored && loadingState.restored.values ? Object.assign({}, base, loadingState.restored.values) : base;
    present('edit', detail.itemId, restored, clean(base), loadingState.opener, { kind: detail.kind, kindWord: detail.kindLabel || detail.kind });
  }

  // ---- closing ---------------------------------------------------------------------------------------------------------------------------------
  function tearDown() {
    if (!f) return;
    const done = f;
    f = undefined;
    done.form.remove();
    for (const child of done.hidden) child.hidden = false;
    if (done.wasHidden) drawer.hidden = true;
    return done;
  }

  function newItemButton() {
    return document.querySelectorAll('button').find((b) => b.textContent === T.newItem && !b.hidden);
  }
  function focusOpener(done) {
    const opener = done.opener;
    if (opener && opener.isConnected && !opener.hidden) { opener.focus(); return; }
    if (done.mode === 'edit') { if (!board.focusCard(done.id)) { const b = newItemButton(); if (b) b.focus(); } return; }
    const fallback = newItemButton();
    if (fallback) fallback.focus();
  }

  function requestClose() {
    if (!f) return;
    if (f.busy) return;
    if (!isChanged()) { closeNow(); return; }
    askDiscard();
  }
  function askDiscard() {
    if (f.discardRow.hidden === false) { f.keepBtn.focus(); return; }
    const keep = button('secondary', T.keep, () => { f.discardRow.hidden = true; f.discardRow.replaceChildren(); f.nodes.title.focus(); });
    const yes = button('', T.discardYes, () => closeNow());
    const buttons = el('div', 'form-buttons');
    buttons.append(yes, keep);
    f.discardRow.replaceChildren(el('p', 'form-discard-text', T.discard), buttons);
    f.discardRow.hidden = false;
    f.keepBtn = keep;
    keep.focus();
  }
  function closeNow() {
    board.setDraft(undefined);
    const done = tearDown();
    if (done) focusOpener(done);
  }

  // ---- submitting ------------------------------------------------------------------------------------------------------------------------------
  function setBusy(on) {
    f.busy = on;
    attr(f.submit, 'aria-busy', on ? 'true' : null);
    attr(f.submit, 'aria-disabled', on ? 'true' : null);
    f.submit.textContent = on ? (f.mode === 'new' ? T.adding : T.saving) : (f.mode === 'new' ? T.add : T.save);
  }
  function showAlert(text) {
    f.alert.textContent = text;
    f.alert.hidden = text === '';
  }

  function submit() {
    if (!f || f.busy) return;
    showAlert('');
    const bad = FIELD_ORDER.filter((name) => !validate(name));
    if (bad.length > 0) {
      f.nodes[bad[0]].focus();
      board.announce(bad.length === 1 ? '1 field needs attention.' : bad.length + ' fields need attention.');
      return;
    }
    const now = clean(read());
    const scope = lines(f.nodes.files.value);
    let message;
    if (f.mode === 'new') {
      const draft = { kind: now.type, title: now.title, scope };
      if (now.description !== '') draft.description = now.description;
      if (now.estimate !== '') draft.estimate = Number(now.estimate);
      message = { type: 'new-item', draft };
    } else {
      const changes = {};
      if (now.title !== f.initial.title) changes.title = now.title;
      if (now.description !== f.initial.description) changes.description = now.description;
      if (now.files !== f.initial.files) changes.scope = scope;
      if (now.estimate !== f.initial.estimate) changes.estimate = Number(now.estimate);
      if (Object.keys(changes).length === 0) { board.announce(T.noChanges); closeNow(); return; }
      message = { type: 'edit-item', itemId: f.id, changes };
    }
    f.sent = { title: now.title, kind: now.type, asked: f.mode === 'new' ? '' : f.id };
    setBusy(true);
    board.post(message);
  }

  function afterSave(id) {
    const decide = () => {
      if (board.cardElement(id) && board.focusCard(id)) return;
      const b = newItemButton();
      if (b) b.focus();
    };
    if (board.cardData(id)) { decide(); return; }
    // The new card arrives with the next state. If it never does, the New item button is the safe place to land.
    waitingFocus = { id, decide, timer: window.setTimeout(() => { if (waitingFocus) { const w = waitingFocus; waitingFocus = undefined; w.decide(); } }, 3000) };
  }

  board.onMessage('state', () => {
    if (!waitingFocus) return;
    const w = waitingFocus;
    waitingFocus = undefined;
    window.clearTimeout(w.timer);
    w.decide();
  });

  board.onMessage('saved', (m) => {
    if (!f || !f.busy || !f.sent || typeof m.itemId !== 'string') return;
    if (f.mode === 'edit' && m.itemId !== f.id) return;
    const sent = f.sent;
    board.setDraft(undefined);
    const done = tearDown();
    const code = m.itemId.slice(-4).toUpperCase();
    board.announce((done && done.mode === 'new' ? 'Added ' : 'Saved changes to ') + sent.kind + ' ' + code + ': ' + sent.title + '.');
    afterSave(m.itemId);
  });

  board.onMessage('refused', (m) => {
    if (!f || !f.busy || !f.sent || m.itemId !== f.sent.asked) return;
    setBusy(false);
    // A dismissed prompt has no words; otherwise the host's reason is shown in the form and every field stays.
    if (typeof m.reason === 'string' && m.reason !== '') {
      showAlert(m.reason);
      board.announce(m.reason);
    }
  });

  // ---- edit: the form is filled from the host's detail ----------------------------------------------------------------------------------------
  board.onMessage('detail', (m) => {
    if (!loading || m.itemId !== loading.id) return;
    const wait = loading;
    loading = undefined;
    if (m.editable !== true) { board.announce(T.cannotEdit); return; }
    openEdit(m, wait);
  });
  board.onMessage('refused', (m) => {
    if (!loading || m.itemId !== loading.id) return;
    loading = undefined;
    board.announce(m.reason || T.gone);
  });

  function open(itemId, restored) {
    if (f) { f.nodes.title.focus(); return; }
    if (itemId === undefined) { openNew(restored); return; }
    loading = { id: itemId, opener: document.activeElement, restored };
    board.post({ type: 'detail', itemId });
  }

  // A card that disappears under an open edit form takes the form with it, and the drawer must stay visible for a form that is open.
  board.onRender(() => {
    if (!f) return;
    if (f.mode === 'edit' && !board.cardData(f.id)) {
      tearDown();
      board.setDraft(undefined);
      board.announce(T.gone);
      return;
    }
    if (drawer.hidden) drawer.hidden = false;
  });

  window.NearAiBoard.registerForm((itemId) => open(itemId));

  // The unsent draft of a form that was open before the view was hidden or reloaded comes back once the first state has arrived.
  const kept = board.getDraft();
  if (kept && kept.values) {
    let once = true;
    board.onMessage('state', () => {
      if (!once) return;
      once = false;
      if (kept.mode === 'edit' && typeof kept.id === 'string') open(kept.id, kept);
      else open(undefined, kept);
    });
  }
}());
