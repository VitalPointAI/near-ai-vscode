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

  // ---- Exceptions for chat you review (74.1-UI-SPEC S11). The host decides everything; this only renders and posts. ----
  // Codicons drawn as inline SVG built with DOM calls (no HTML is parsed on this page).
  const ICONS = {
    law: 'M8 1l.5.3V3h4.7l.3.5L15 8a2.5 2.5 0 0 1-5 0l1.6-4H8.5v10H11v1H5v-1h2.5V4H4.4L6 8a2.5 2.5 0 0 1-5 0l1.5-4.5L2.8 3H7.5V1.3zM3.5 4.6 2.2 8h2.6zm9 0L11.2 8h2.6z',
    check: 'm6.3 11.6-3.6-3.6.7-.7 2.9 2.9 6.3-6.3.7.7z',
    history: 'M8 1a7 7 0 1 1-6.6 9.3l.9-.3A6 6 0 1 0 3.3 4H6v1H2V1h1v2.2A7 7 0 0 1 8 1m-.5 3h1v3.8l2.6 2.6-.7.7-2.9-2.9z',
    slash: 'M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1m4.3 3.4-7.9 7.9A6 6 0 0 0 12.3 4.4M8 2a6 6 0 0 0-4.3 10.2l7.9-7.9A6 6 0 0 0 8 2'
  };
  const SVG = 'http://www.w3.org/2000/svg';
  const icon = (name) => {
    const span = el('span', 'icon');
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('class', 'codicon-svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    const shape = document.createElementNS(SVG, 'path');
    shape.setAttribute('d', ICONS[name]);
    svg.append(shape);
    span.append(svg);
    return span;
  };
  let exceptionKey = '';
  let shownCard = '';
  let uid = 0;
  const nextId = (prefix) => prefix + '-' + String(++uid);

  // A checkbox row (74.1-UI-SPEC "Checkboxes"): one label wrapping its input, the box left of the text, centred on the first line by policy.css.
  function checkboxRow(name, value, label, checked) {
    const row = el('label', 'check-row');
    const box = el('input');
    box.type = 'checkbox';
    box.name = name;
    box.value = value;
    box.checked = Boolean(checked);
    row.append(box, el('span', '', label));
    return row;
  }

  function fieldError(field, errors, holder, controls) {
    const message = errors && errors[field];
    if (!message) return;
    const id = nextId('err');
    const node = el('p', 'error field-error', message);
    node.id = id;
    holder.append(node);
    for (const target of controls) { target.setAttribute('aria-invalid', 'true'); target.setAttribute('aria-describedby', id); }
  }

  function readFields(card) {
    const checked = (name) => [...card.querySelectorAll('input[type=checkbox][name="' + name + '"]')].filter((box) => box.checked).map((box) => box.value);
    const extra = card.querySelector('#exception-add-condition');
    const conditions = checked('conditions');
    if (extra && extra.value.trim()) conditions.push(extra.value.trim());
    return {
      projects: checked('projects'), labels: checked('labels'), conditions,
      benefit: card.querySelector('#exception-benefit').value,
      person: { name: card.querySelector('#exception-name').value, position: card.querySelector('#exception-position').value },
      endsOn: card.querySelector('#exception-ends').value
    };
  }

  function legalBox(words, line) {
    const box = el('div', 'legal-flags');
    box.setAttribute('role', 'note');
    box.tabIndex = -1;
    const words2 = el('div');
    words2.append(el('p', 'strong', words.legalTitle), el('p', '', line));
    box.append(icon('law'), words2);
    return box;
  }

  function checkFieldset(legendText, field, draft, fill) {
    const set = el('fieldset');
    set.append(el('legend', 'strong', legendText));
    const rows = el('div', 'check-rows');
    fill(rows);
    set.append(rows);
    fieldError(field, draft.errors, set, [set]);
    return set;
  }

  function textField(id, labelText, value, maxLength) {
    const wrap = el('label', 'field');
    wrap.append(el('span', '', labelText));
    const input = el('input');
    input.type = 'text';
    input.id = id;
    input.maxLength = maxLength;
    input.value = value;
    wrap.append(input);
    return wrap;
  }

  function draftCard(draft, words) {
    const card = el('div', 'lifted raised exception-card');
    card.setAttribute('role', 'group');
    const title = el('h3', '', draft.title);
    title.id = nextId('draft-title');
    card.setAttribute('aria-labelledby', title.id);
    card.append(title, legalBox(words, draft.legal));
    const use = el('div', 'field');
    use.append(el('p', 'strong', words.useLabel), el('p', '', words.useValue));
    card.append(use);
    card.append(checkFieldset(words.projectsLabel, 'projects', draft, (rows) => {
      for (const project of draft.projects) rows.append(checkboxRow('projects', project.id, project.name, draft.fields.projects.includes(project.id)));
    }));
    card.append(checkFieldset(words.labelsLabel, 'labels', draft, (rows) => {
      for (const scale of draft.labels) {
        rows.append(el('p', 'muted scale-name', scale.scale));
        for (const label of scale.labels) rows.append(checkboxRow('labels', label, label, draft.fields.labels.includes(label)));
      }
    }));
    card.append(checkFieldset(words.conditionsLabel, 'conditions', draft, (rows) => {
      const shown = [...new Set([...words.conditionDefaults, ...draft.fields.conditions])];
      for (const condition of shown) rows.append(checkboxRow('conditions', condition, condition, draft.fields.conditions.includes(condition)));
      const add = textField('exception-add-condition', words.addCondition, '', 280);
      rows.append(add);
    }));
    const benefit = el('div', 'field');
    const benefitLabel = el('label', 'strong', words.benefitLabel);
    benefitLabel.htmlFor = 'exception-benefit';
    const area = el('textarea');
    area.id = 'exception-benefit';
    area.rows = 4;
    area.maxLength = 200;
    area.value = draft.fields.benefit;
    const hint = el('p', 'muted', words.benefitHint);
    hint.id = nextId('hint');
    area.setAttribute('aria-describedby', hint.id);
    benefit.append(benefitLabel, hint, area);
    fieldError('benefit', draft.errors, benefit, [area]);
    card.append(benefit);
    const person = el('fieldset');
    person.append(el('legend', 'strong', words.personLabel));
    const pair = el('div', 'person');
    pair.append(textField('exception-name', words.personName, draft.fields.person.name, 64), textField('exception-position', words.personPosition, draft.fields.person.position, 64));
    person.append(pair);
    if (draft.keyNotListed) person.append(el('p', 'muted', draft.keyNotListed));
    fieldError('person', draft.errors, person, [...person.querySelectorAll('input')]);
    card.append(person);
    const ends = el('div', 'field');
    const endsLabel = el('label', 'strong', words.endsLabel);
    endsLabel.htmlFor = 'exception-ends';
    const date = el('input');
    date.type = 'date';
    date.id = 'exception-ends';
    date.min = draft.ends.min;
    date.max = draft.ends.max;
    date.value = draft.fields.endsOn;
    const endsHint = el('p', 'muted', draft.ends.hint);
    endsHint.id = nextId('hint');
    date.setAttribute('aria-describedby', endsHint.id);
    ends.append(endsLabel, endsHint, date);
    fieldError('ends', draft.errors, ends, [date]);
    card.append(ends);
    for (const field of ['use', 'conditions']) if (draft.errors && draft.errors[field]) card.append(el('p', 'error', draft.errors[field]));
    const actions = el('div', 'actions');
    actions.append(
      button(words.review, () => vscode.postMessage({ type: 'exception-review', draft: draft.id, fields: readFields(card) }), false),
      button(words.close, () => vscode.postMessage({ type: 'exception-close', draft: draft.id }), true)
    );
    card.append(actions);
    return card;
  }

  function reviewCard(draft, words) {
    const review = draft.review;
    const card = el('div', 'lifted raised exception-card');
    card.setAttribute('role', 'group');
    const title = el('h3', '', review.title);
    title.id = nextId('review-title');
    card.setAttribute('aria-labelledby', title.id);
    card.append(title, legalBox(words, draft.legal));
    const facts = el('dl', 'rows review-facts');
    for (const pair of review.facts) facts.append(el('dt', '', pair[0]), el('dd', '', pair[1]));
    card.append(facts, el('p', 'review-next', review.next));
    const actions = el('div', 'actions');
    const sign = button(words.sign, () => {
      if (sign.getAttribute('aria-disabled') === 'true') return;
      sign.setAttribute('aria-disabled', 'true');
      $('notice').textContent = words.signing;
      vscode.postMessage({ type: 'exception-sign', draft: draft.id });
    }, false);
    if (draft.stage === 'signing') sign.setAttribute('aria-disabled', 'true');
    actions.append(sign, button(words.change, () => vscode.postMessage({ type: 'exception-change', draft: draft.id }), true));
    card.append(actions);
    return card;
  }

  function renderExceptions(view) {
    const holder = $('exceptions');
    if (!holder) return;
    // Re-rendered only when what the host says changed, so a person's typing is never wiped by an unrelated update.
    const key = JSON.stringify(view || null);
    if (key === exceptionKey) return;
    exceptionKey = key;
    holder.replaceChildren();
    if (!view || typeof view !== 'object') return;
    const words = view.words;
    const section = el('section', 'rules exceptions');
    section.id = 'section-exceptions';
    section.append(el('h2', '', words.sectionTitle), el('p', 'muted', words.sectionIntro));
    holder.append(section);
    if (view.noOrg) { section.append(el('p', '', view.noOrg)); return; }
    if (view.status) section.append(el('p', 'section-status', view.status));
    if (view.saved && !view.draft) {
      const line = el('p', 'saved');
      line.tabIndex = -1;
      line.append(icon('check'), el('span', '', view.saved));
      section.append(line);
      window.setTimeout(() => line.focus(), 0);
    }
    const reasonId = nextId('reason');
    if (view.oneDraft) { const note = el('p', 'muted', words.oneDraft); note.id = reasonId; section.append(note); }
    const askButton = (label, message) => {
      const node = button(label, () => { if (node.getAttribute('aria-disabled') !== 'true') vscode.postMessage(message); }, true);
      if (view.oneDraft) { node.setAttribute('aria-disabled', 'true'); node.setAttribute('aria-describedby', reasonId); }
      return node;
    };
    section.append(el('h3', '', words.researchOnlyTitle));
    if (!view.research.length) section.append(el('p', 'muted', words.noResearchOnly));
    const researchList = el('ul', 'exception-rows');
    let anchor;
    for (const row of view.research) {
      const item = el('li', 'lifted exception-row');
      item.append(el('p', '', row.text), askButton(words.ask, { type: 'exception-ask', model: row.id }));
      researchList.append(item);
      if (view.draft && view.draft.model === row.id) anchor = item;
    }
    section.append(researchList);
    section.append(el('h3', '', words.exceptionsTitle));
    if (!view.rows.length) section.append(el('p', 'muted', words.noneYet));
    const rowList = el('ul', 'exception-rows');
    for (const row of view.rows) {
      const item = el('li', 'lifted exception-row');
      const line = el('p', 'row-state');
      line.append(icon(row.state === 'active' ? 'check' : row.state === 'withdrawn' ? 'slash' : 'history'), el('span', '', row.text));
      item.append(line, el('p', 'muted', row.scope));
      if (row.renew) item.append(askButton(words.renew, { type: 'exception-renew', id: row.id }));
      rowList.append(item);
    }
    section.append(rowList);
    if (!view.draft) { shownCard = ''; return; }
    const draft = view.draft;
    const card = draft.stage === 'draft' ? draftCard(draft, words) : reviewCard(draft, words);
    // The card opens under the row that asked for it (a renewal's under the lists), and focus goes to its legal flags box when it opens.
    if (anchor) anchor.after(card); else section.append(card);
    const cardKey = draft.id + ':' + (draft.stage === 'draft' ? 'draft' : 'review');
    const invalid = card.querySelector('[aria-invalid="true"]');
    if (invalid) invalid.focus();
    else if (cardKey !== shownCard) card.querySelector('.legal-flags').focus();
    shownCard = cardKey;
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
      renderExceptions(message.exceptions);
    } else if (message.type === 'error') {
      $('notice').textContent = text(message.text);
    }
  });

  renderPageActions([]);
  vscode.postMessage({ type: 'ready' });
})();
