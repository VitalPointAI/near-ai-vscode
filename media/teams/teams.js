// NEAR AI Team Studio. The host sends the team library and everything the pickers need; the page
// edits a draft and asks the host to check it (the host renders the exact Markdown it would save).
// Everything is rendered with textContent. Messages only name teams by the ids the host listed.
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const SVG = 'http://www.w3.org/2000/svg';
  const ICONS = {
    team: 'M5.5 7a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zm5.5 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM1 13c0-2.2 2-4 4.5-4S10 10.8 10 13v1H1v-1zm10-3.9c1.9.2 4 1.3 4 3.4V14h-4v-1c0-1.5-.5-2.8-1.4-3.7.4-.1.9-.2 1.4-.2z',
    plus: 'M7.25 2h1.5v5.25H14v1.5H8.75V14h-1.5V8.75H2v-1.5h5.25z',
    warn: 'M8 1.5l7 12.5H1L8 1.5zm-.75 4.5v4h1.5V6h-1.5zm0 5v1.5h1.5V11h-1.5z',
    check: 'M6.2 11.6L2.6 8l1.1-1.1 2.5 2.5 6.1-6.1 1.1 1.1z',
    error: 'M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm2.8 8.7l-1.1 1.1L8 9.1l-1.7 1.7-1.1-1.1L6.9 8 5.2 6.3l1.1-1.1L8 6.9l1.7-1.7 1.1 1.1L9.1 8z'
  };
  const STEPS = ['Purpose', 'Members', 'Models', 'Tools & permissions', 'Instructions & review'];
  const TABS = ['Purpose', 'Members', 'Models', 'Tools', 'Instructions', 'Markdown & checks', 'History'];
  const CAPABILITY_ORDER = ['read', 'plan', 'edit', 'shell', 'network', 'generate', 'git', 'publish'];
  const CAPABILITY_LABEL = { read: 'Read', plan: 'Plan and coordinate', edit: 'Edit files', shell: 'Run commands', network: 'Network', generate: 'Generate media', git: 'Git', publish: 'Publish' };
  const STATUS_CLASS = { runs: 'ok', asks: 'ask', 'auto-checked': 'checked', off: 'off', stopped: 'stopped' };
  const STATUS_SHORT = { runs: 'Runs', asks: 'Asks first', 'auto-checked': 'Checked', off: 'Off', stopped: 'Blocked' };
  const PRIVACY_LABEL = { tee: 'TEE', local: 'Local', forwarded: 'Forwarded', unknown: 'Unknown' };
  const READ_ONLY = ['Read', 'Glob', 'Grep', 'TodoWrite', 'Recall', 'Remember'];
  const READ_EDIT = READ_ONLY.concat(['Write', 'Edit']);

  let ctx = null;
  let lib = { teams: [], archived: [] };
  let savedDraft = null;
  let work = null; // the team being built or edited
  let seq = 0;
  let reviewTimer = null;
  let flash = null;
  // Changes to a team that were kept when the studio was closed, until reopened or discarded.
  let keptEdit = null;
  let keptShown = false;
  // Nothing is unsaved when the page starts, so only a change is worth telling the host.
  let lastUnsaved = JSON.stringify({ type: 'unsaved' });

  // ---------- small DOM helpers ----------
  const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined && text !== null) node.textContent = String(text); return node; };
  const icon = (name) => {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('width', '16'); svg.setAttribute('height', '16'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('class', 'icon');
    const path = document.createElementNS(SVG, 'path'); path.setAttribute('d', ICONS[name]); path.setAttribute('fill', 'currentColor');
    svg.append(path);
    return svg;
  };
  const button = (label, onClick, options) => {
    const opts = options || {};
    const node = el('button', opts.primary ? 'primary' : opts.link ? 'link' : 'secondary');
    node.type = 'button';
    if (opts.icon) node.append(icon(opts.icon));
    node.append(document.createTextNode(label));
    if (opts.label) node.setAttribute('aria-label', opts.label);
    if (opts.id) node.id = opts.id;
    if (opts.disabled) node.disabled = true;
    node.addEventListener('click', onClick);
    return node;
  };
  const badge = (text, kind, title) => { const node = el('span', 'badge' + (kind ? ' ' + kind : ''), text); if (title) node.title = title; return node; };
  const privacyBadge = (privacy, title) => badge(PRIVACY_LABEL[privacy] || 'Unknown', 'privacy ' + privacy, title);
  let uid = 0;
  const nextId = (prefix) => prefix + '-' + (++uid);
  function field(labelText, control, hint) {
    const wrap = el('div', 'field');
    if (!control.id) control.id = nextId('f');
    const label = el('label', '', labelText); label.setAttribute('for', control.id);
    wrap.append(label, control);
    if (hint) { const note = el('p', 'hint', hint); note.id = control.id + '-hint'; control.setAttribute('aria-describedby', note.id); wrap.append(note); }
    return wrap;
  }
  function input(value, onInput, attrs) {
    const node = el('input'); node.type = 'text'; node.value = value || '';
    for (const key of Object.keys(attrs || {})) { if (key === 'id') node.id = attrs[key]; else node.setAttribute(key, attrs[key]); }
    node.addEventListener('input', () => onInput(node.value, node));
    return node;
  }
  function textarea(value, onInput, rows, id) {
    const node = el('textarea'); node.value = value || ''; node.setAttribute('rows', String(rows || 4)); if (id) node.id = id;
    node.addEventListener('input', () => onInput(node.value, node));
    return node;
  }
  function select(options, value, onChange, id) {
    const node = el('select'); if (id) node.id = id;
    const add = (parent, option) => { const item = el('option', '', option.label); item.value = option.value; if (option.value === value) item.selected = true; parent.append(item); };
    for (const option of options) {
      if (option.group) { const group = el('optgroup'); group.setAttribute('label', option.group); option.options.forEach((child) => add(group, child)); node.append(group); }
      else add(node, option);
    }
    node.value = value;
    node.addEventListener('change', () => onChange(node.value, node));
    return node;
  }
  const money = (value) => value === undefined ? undefined : '$' + (value < 0.01 && value > 0 ? value.toPrecision(2) : value.toFixed(2).replace(/\.00$/, ''));
  const tokens = (value) => value >= 1000000 ? (value / 1000000).toFixed(value % 1000000 ? 1 : 0) + 'M' : value >= 1000 ? Math.round(value / 1000) + 'K' : String(value);
  const slugify = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const when = (iso) => { if (!iso) return ''; const date = new Date(iso); return isNaN(date.getTime()) ? '' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); };
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const announce = (text) => { const node = $('announce'); node.textContent = ''; node.textContent = text; };

  function showBanner(text, level, actions) {
    const node = $('banner');
    node.replaceChildren();
    node.className = 'banner ' + (level || 'info');
    node.append(icon(level === 'error' ? 'error' : level === 'warning' ? 'warn' : 'check'), el('span', 'banner-text', text));
    for (const action of actions || []) node.append(action);
    if (!actions || !actions.length) node.append(button('Dismiss', hideBanner, { link: true, label: 'Dismiss message' }));
    node.hidden = false;
  }
  function hideBanner() { $('banner').hidden = true; $('banner').replaceChildren(); }

  // ---------- drafts ----------
  const emptyMember = (index) => ({ name: 'member-' + index, role: '', model: '', tools: null, instructions: '' });
  const roleById = (id) => (ctx ? ctx.roles : []).find((role) => role.id === id);
  const isDirty = () => Boolean(work && work.mode === 'editor' && JSON.stringify(work.draft) !== work.clean);
  // The builder has unsaved changes once its draft differs from how it started (or was last saved as a draft).
  const isWizardDirty = () => Boolean(work && work.mode === 'wizard' && JSON.stringify(work.draft) !== work.clean);
  const wizardState = () => { const state = { draft: work.draft, step: work.step, target: work.target }; if (work.startingPoint) state.startingPoint = work.startingPoint; return state; };

  // The host keeps what is unsaved if the panel is closed (it cannot ask then), so it always knows.
  function reportUnsaved() {
    const message = { type: 'unsaved' };
    if (isWizardDirty()) message.wizard = wizardState();
    else if (isDirty()) message.edit = { id: work.id, draft: work.draft, base: work.base };
    const json = JSON.stringify(message);
    if (json === lastUnsaved) return;
    lastUnsaved = json;
    vscode.postMessage(message);
  }
  const memberLabel = (member, index) => (member.name || 'member ' + (index + 1)) + (member.role ? ' (' + member.role + ')' : '');

  function startWizard(target, resume) {
    hideBanner();
    work = resume
      ? { mode: 'wizard', target: resume.target, step: resume.step, maxStep: resume.step, draft: clone(resume.draft), startingPoint: resume.startingPoint || 'recommend', options: { locality: 'cloud', workShape: 'feature', riskLevel: 'medium' }, review: null }
      : { mode: 'wizard', target: target === 'project' && ctx && ctx.hasProject ? 'project' : 'user', step: 0, maxStep: 0, draft: { name: target === 'project' ? 'Project team' : '', description: '', members: [] }, startingPoint: 'recommend', options: { locality: 'cloud', workShape: 'feature', riskLevel: 'medium' }, review: null };
    work.clean = JSON.stringify(work.draft);
    render();
    requestReview();
    focusMain();
  }

  function changed(structural) {
    if (structural) render(); else updateDirty();
    reportUnsaved();
    requestReview();
  }

  function requestReview() {
    if (!work) return;
    if (reviewTimer) clearTimeout(reviewTimer);
    reviewTimer = setTimeout(() => {
      reviewTimer = null;
      // Left the builder or editor in the meantime: nothing to check.
      if (!work) return;
      seq += 1;
      const message = { type: 'review', seq, draft: work.draft };
      if (work.mode === 'editor') message.id = work.id;
      vscode.postMessage(message);
    }, 150);
  }

  // ---------- header and breadcrumbs ----------
  function renderHeader() {
    const crumbs = $('crumbs');
    crumbs.replaceChildren();
    if (!work) { $('title').textContent = 'Team Studio'; return; }
    crumbs.append(button('All teams', () => leaveWork(), { link: true, label: 'Back to all teams' }));
    crumbs.append(el('span', 'sep', '/'), el('span', '', work.mode === 'wizard' ? 'New team' : (work.draft.name || 'Team')));
    $('title').textContent = work.mode === 'wizard' ? 'Build a team' : 'Edit team';
  }

  // Cancel, and "All teams": with unsaved changes the host asks first (a modal), and the page waits for its answer.
  function leaveWork() {
    if (isWizardDirty()) { vscode.postMessage({ type: 'leave-wizard', wizard: wizardState() }); return; }
    if (isDirty()) { vscode.postMessage({ type: 'leave-editor', edit: { id: work.id, draft: work.draft, base: work.base } }); return; }
    work = null;
    render();
    focusMain();
  }

  function focusMain() { const main = $('main'); if (main && main.focus) main.focus(); }

  // ---------- library ----------
  function renderLibrary(root) {
    const bar = el('div', 'toolbar');
    const heading = el('h2', '', 'Teams'); heading.id = 'library-title';
    const actions = el('div', 'actions');
    actions.append(button('New team', () => startWizard('user'), { primary: true, icon: 'plus' }));
    if (ctx && ctx.hasProject) actions.append(button(lib.teams.some((team) => team.kind === 'project') ? 'Rebuild project team' : 'Set up project team', () => startWizard('project')));
    actions.append(button('Import…', () => vscode.postMessage({ type: 'import' })), button('Refresh', () => vscode.postMessage({ type: 'refresh' }), { link: true }));
    bar.append(heading, actions);
    root.append(bar);

    if (savedDraft) {
      const resume = el('div', 'resume');
      resume.append(icon('warn'), el('span', '', 'You have an unfinished team' + (savedDraft.draft.name ? ' "' + savedDraft.draft.name + '"' : '') + ' (step ' + (savedDraft.step + 1) + ' of 5).'));
      resume.append(button('Resume', () => startWizard(savedDraft.target, savedDraft), { primary: true }), button('Discard draft', () => { vscode.postMessage({ type: 'discard-draft' }); savedDraft = null; render(); }, { link: true }));
      root.append(resume);
    }

    if (!lib.teams.length) {
      const empty = el('div', 'empty');
      const art = icon('team'); art.setAttribute('class', 'icon large');
      empty.append(art, el('h3', '', 'Create your first team'), el('p', 'hint', 'A team is a few agents with their own roles, models, and tools. A lead agent hands them the work and puts their results together. The studio guides you through it in five steps.'));
      const go = el('div', 'actions center');
      go.append(button('Create your first team', () => startWizard('user'), { primary: true, icon: 'plus' }));
      if (ctx && ctx.hasProject) go.append(button('Set up a team for this project', () => startWizard('project')));
      empty.append(go);
      root.append(empty);
    } else {
      const list = el('ul', 'cards'); list.setAttribute('aria-labelledby', 'library-title');
      for (const team of lib.teams) list.append(teamCard(team));
      root.append(list);
    }

    if (lib.archived.length) {
      const details = el('details', 'archived');
      const summary = el('summary', '', 'Archived teams (' + lib.archived.length + ')');
      details.append(summary, el('p', 'hint', 'Archived teams are kept, never deleted. Restore one to use it again.'));
      const list = el('ul', 'rows');
      for (const entry of lib.archived) {
        const row = el('li', 'row');
        row.append(el('span', 'name', entry.name), el('span', 'hint', entry.savedAt ? 'archived ' + when(entry.savedAt) : ''));
        const actions = el('span', 'row-actions');
        actions.append(button('Restore', () => vscode.postMessage({ type: 'restore', id: entry.id }), { label: 'Restore ' + entry.name }), button('Open as Markdown', () => vscode.postMessage({ type: 'open-markdown', id: entry.id }), { link: true, label: 'Open archived ' + entry.name + ' as Markdown' }));
        row.append(actions);
        list.append(row);
      }
      details.append(list);
      root.append(details);
    }
  }

  function teamCard(team) {
    const card = el('li', 'card'); card.dataset.id = team.id;
    const head = el('div', 'card-head');
    const title = el('h3', 'card-title', team.name); title.id = nextId('team');
    head.append(icon('team'), title, badge(team.kind === 'project' ? 'This project' : 'My team', team.kind === 'project' ? 'kind project' : 'kind'));
    card.setAttribute('aria-labelledby', title.id);
    card.append(head);
    if (team.error) {
      const problem = el('p', 'error'); problem.append(icon('error'), document.createTextNode(' Needs fixing: ' + team.error));
      card.append(problem);
      const actions = el('div', 'card-actions');
      actions.append(button('Open as Markdown', () => vscode.postMessage({ type: 'open-markdown', id: team.id }), { primary: true, label: 'Open ' + team.name + ' as Markdown to fix it' }));
      if (team.kind === 'user') actions.append(button('Archive', () => vscode.postMessage({ type: 'archive', id: team.id }), { label: 'Archive ' + team.name }));
      card.append(actions);
      return card;
    }
    if (team.description) card.append(el('p', 'desc', team.description));
    const chips = el('ul', 'chips'); chips.setAttribute('aria-label', 'Members');
    for (const member of team.members) chips.append(el('li', 'chip', member.name + (member.role && member.role !== member.name ? ' · ' + member.role : '')));
    card.append(chips);
    const counts = {};
    team.members.forEach((member) => { counts[member.privacy] = (counts[member.privacy] || 0) + 1; });
    const models = el('div', 'models');
    models.append(el('span', 'hint', 'Models: '));
    for (const privacy of ['tee', 'local', 'forwarded', 'unknown']) if (counts[privacy]) models.append(privacyBadge(privacy, counts[privacy] + ' member' + (counts[privacy] === 1 ? '' : 's') + ': ' + PRIVACY_LABEL[privacy]), el('span', 'count', '×' + counts[privacy]));
    const distinct = [...new Set(team.members.map((member) => member.model))];
    models.append(el('span', 'hint', ' ' + distinct.slice(0, 3).join(', ') + (distinct.length > 3 ? ', …' : '')));
    card.append(models);
    card.append(el('p', 'meta', team.members.length + ' member' + (team.members.length === 1 ? '' : 's') + (team.savedAt ? ' · saved ' + when(team.savedAt) : '') + (team.command ? ' · ' + team.command.trim() : '')));
    if (flash === team.id) { card.className += ' flash'; pendingFocus = 'open-' + team.id; }
    const actions = el('div', 'card-actions');
    actions.append(
      button('Open', () => vscode.postMessage({ type: 'open', id: team.id }), { primary: true, label: 'Open ' + team.name, id: 'open-' + team.id }),
      button('Use in chat', () => vscode.postMessage({ type: 'use-in-chat', id: team.id }), { label: 'Use ' + team.name + ' in chat' }),
      button('Duplicate', () => vscode.postMessage({ type: 'duplicate', id: team.id }), { label: 'Duplicate ' + team.name }),
      button('Export', () => vscode.postMessage({ type: 'export', id: team.id }), { label: 'Export ' + team.name })
    );
    if (team.kind === 'user') actions.append(button('Archive', () => vscode.postMessage({ type: 'archive', id: team.id }), { label: 'Archive ' + team.name }));
    card.append(actions);
    return card;
  }

  // ---------- sections shared by the wizard and the editor ----------
  function sectionPurpose(root) {
    const draft = work.draft;
    root.append(field('Team name', input(draft.name, (value) => { draft.name = value.replace(/[\r\n]+/g, ' '); renderHeaderName(); changed(false); }, { id: 'f-name', maxlength: '80', autocomplete: 'off' }), work.mode === 'editor' ? 'Renaming keeps the file and its /team: command.' : 'Shown in the library and when the team runs.'));
    root.append(field('What the team is for', textarea(draft.description, (value, node) => { const clean = value.replace(/[\r\n]+/g, ' '); if (clean !== value) node.value = clean; draft.description = clean; changed(false); }, 2, 'f-desc'), 'One or two sentences. The lead agent reads this.'));
    if (work.mode !== 'wizard') return;
    const where = el('fieldset', 'choices');
    where.append(el('legend', '', 'Save it as'));
    [['project', 'This project\'s team', 'Saved in .planning/.near-ai/team.md; run with /team:project.'], ['user', 'One of my teams', 'Reusable in any project; run with /team:<name>.']].forEach(([value, label, hint]) => {
      const option = el('label', 'choice' + (work.target === value ? ' selected' : ''));
      const radio = el('input'); radio.type = 'radio'; radio.name = 'target'; radio.value = value; radio.checked = work.target === value;
      if (value === 'project' && !(ctx && ctx.hasProject)) { radio.disabled = true; hint = 'Open a project folder to save a project team.'; }
      radio.addEventListener('change', () => { work.target = value; render(); });
      option.append(radio, el('span', 'choice-label', label), el('span', 'hint', hint));
      where.append(option);
    });
    root.append(where);

    const start = el('fieldset', 'choices starting');
    start.append(el('legend', '', 'Starting point'), el('p', 'hint', 'Pick one to fill in members you can then change. You can also add every member yourself.'));
    const groups = [['recommend', 'Recommended'], ['project-type', 'For this kind of project'], ['gsd', 'Built from Open-GSD roles'], ['empty', 'Blank']];
    for (const [group, title] of groups) {
      const points = (ctx ? ctx.startingPoints : []).filter((point) => point.group === group);
      if (!points.length) continue;
      start.append(el('h4', '', title));
      const grid = el('div', 'choice-grid');
      for (const point of points) {
        const option = el('label', 'choice' + (work.startingPoint === point.id ? ' selected' : ''));
        const radio = el('input'); radio.type = 'radio'; radio.name = 'starting-point'; radio.value = point.id; radio.checked = work.startingPoint === point.id;
        radio.addEventListener('change', () => { work.startingPoint = point.id; render(); });
        option.append(radio, el('span', 'choice-label', point.label), el('span', 'hint', point.description));
        if (point.members.length) option.append(el('span', 'hint small', point.members.join(', ')));
        grid.append(option);
      }
      start.append(grid);
    }
    const opts = el('div', 'inline-fields');
    if (work.startingPoint !== 'empty') opts.append(field('Where models may run', select([{ value: 'cloud', label: 'NEAR AI Cloud' }, { value: 'local', label: 'Local runtime only' }, { value: 'hybrid', label: 'Both' }], work.options.locality, (value) => { work.options.locality = value; }, 'f-locality')));
    if (work.startingPoint === 'recommend') {
      opts.append(field('Kind of work', select(['feature', 'bugfix', 'refactor', 'research', 'release'].map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1) })), work.options.workShape, (value) => { work.options.workShape = value; }, 'f-shape')));
      opts.append(field('Risk', select([{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High (adds a security member)' }], work.options.riskLevel, (value) => { work.options.riskLevel = value; }, 'f-risk')));
    }
    start.append(opts);
    if (work.startingPoint !== 'empty') {
      const applyRow = el('div', 'actions');
      applyRow.append(button(draft.members.length ? 'Replace members with this starting point' : 'Use this starting point', () => applyStartingPoint(false), { id: 'apply-start' }));
      start.append(applyRow);
    }
    if (work.startingPoint.startsWith('type:')) start.append(el('p', 'hint', 'Saving this as the project team also writes this project type\'s guidance to AGENTS.md (plan, execute, red team, verify, audit, release).'));
    root.append(start);
  }

  function renderHeaderName() { if (work && work.mode === 'editor') { const crumbs = $('crumbs'); const last = crumbs.children && crumbs.children[crumbs.children.length - 1]; if (last) last.textContent = work.draft.name || 'Team'; } }

  function applyStartingPoint(thenNext) {
    if (work.startingPoint === 'empty') { if (thenNext) goStep(1); return; }
    work.awaitingStart = { next: thenNext };
    const message = { type: 'starting-point', id: work.startingPoint, goal: work.draft.description, locality: work.options.locality };
    if (work.startingPoint === 'recommend') { message.workShape = work.options.workShape; message.riskLevel = work.options.riskLevel; }
    vscode.postMessage(message);
  }

  function roleOptions(member) {
    const roles = ctx ? ctx.roles : [];
    const known = roles.some((role) => role.id === member.role);
    const options = [{ value: '', label: 'No role' }];
    const team = roles.filter((role) => role.source === 'team');
    const gsd = roles.filter((role) => role.source === 'gsd');
    if (team.length) options.push({ group: 'Team roles', options: team.map((role) => ({ value: role.id, label: role.label })) });
    if (gsd.length) options.push({ group: 'Open-GSD agents', options: gsd.map((role) => ({ value: role.id, label: role.label })) });
    options.push({ value: '__custom', label: member.role && !known ? 'Custom: ' + member.role : 'Custom role…' });
    return { options, value: member.role && !known ? '__custom' : member.role };
  }

  function sectionMembers(root) {
    const draft = work.draft;
    root.append(el('p', 'hint', 'Up to 12 members. The lead agent delegates to them by name, so give each a short, distinct name.'));
    const list = el('ol', 'member-list');
    draft.members.forEach((member, index) => {
      const item = el('li', 'member');
      const box = el('fieldset', 'member-box');
      box.append(el('legend', '', 'Member ' + (index + 1)));
      const nameInput = input(member.name, (value) => { member.name = value; changed(false); }, { id: 'm-name-' + index, maxlength: '40', autocomplete: 'off', spellcheck: 'false' });
      nameInput.addEventListener('change', () => { const slug = slugify(nameInput.value); if (slug !== nameInput.value) { nameInput.value = slug; member.name = slug; changed(false); } });
      const row = el('div', 'inline-fields');
      row.append(field('Name', nameInput, 'Lowercase letters, digits, and dashes.'));
      const roles = roleOptions(member);
      const roleSelect = select(roles.options, roles.value, (value) => {
        if (value === '__custom') { member.role = member.role && !roleById(member.role) ? member.role : 'custom'; changed(true); focusLater('m-custom-' + index); return; }
        member.role = value;
        const role = roleById(value);
        if (role) {
          if (!member.instructions.trim()) member.instructions = role.suggestion;
          if (!member.model && role.model) member.model = role.model;
          if (member.tools === null && role.tools) member.tools = role.tools.slice();
        }
        changed(true);
        focusLater('m-role-' + index);
      }, 'm-role-' + index);
      row.append(field('Role', roleSelect));
      box.append(row);
      if (roles.value === '__custom') box.append(field('Custom role', input(member.role, (value) => { member.role = value.replace(/[\r\n,]+/g, ' '); changed(false); }, { id: 'm-custom-' + index, maxlength: '80' })));
      const role = roleById(member.role);
      if (role) box.append(el('p', 'hint role-desc', role.description));
      box.append(field('Responsible for', textarea(member.instructions, (value) => { member.instructions = value; changed(false); }, 3, 'm-resp-' + index), 'What this member does. This becomes its instructions; refine them in the last step.'));
      const actions = el('div', 'actions');
      actions.append(
        button('Move up', () => { move(index, -1); }, { label: 'Move ' + memberLabel(member, index) + ' up', disabled: index === 0 }),
        button('Move down', () => { move(index, 1); }, { label: 'Move ' + memberLabel(member, index) + ' down', disabled: index === draft.members.length - 1 }),
        button('Remove', () => { draft.members.splice(index, 1); announce('Removed ' + memberLabel(member, index) + '.'); changed(true); focusLater('add-member'); }, { label: 'Remove ' + memberLabel(member, index) })
      );
      box.append(actions);
      reviewSlot(box, 'member', index, ['name', 'role', 'instructions']);
      item.append(box);
      list.append(item);
    });
    root.append(list);
    if (!draft.members.length) root.append(el('p', 'hint empty-inline', 'No members yet. Add one, or go back and pick a starting point.'));
    root.append(button('Add member', () => {
      let n = draft.members.length + 1;
      while (draft.members.some((member) => member.name === 'member-' + n)) n += 1;
      draft.members.push(emptyMember(n));
      changed(true);
      focusLater('m-name-' + (draft.members.length - 1));
    }, { icon: 'plus', id: 'add-member', disabled: draft.members.length >= 12 }));
  }

  function move(index, delta) {
    const members = work.draft.members;
    const target = index + delta;
    if (target < 0 || target >= members.length) return;
    const [member] = members.splice(index, 1);
    members.splice(target, 0, member);
    announce('Moved ' + member.name + ' to position ' + (target + 1) + '.');
    changed(true);
    focusLater((delta < 0 ? 'm-name-' : 'm-name-') + target);
  }

  function modelChoices(member) {
    const tiers = ctx ? ctx.tiers : { main: '', deep: '', standard: '', fast: '' };
    const models = ctx ? ctx.models : [];
    const options = [
      { value: '', label: 'Main model → ' + (tiers.main || 'not set') },
      { value: 'deep', label: 'Deep tier → ' + tiers.deep },
      { value: 'standard', label: 'Standard tier → ' + tiers.standard },
      { value: 'fast', label: 'Fast tier → ' + tiers.fast }
    ];
    if (models.length) options.push({ group: 'A specific model', options: models.filter((model) => !model.kinds.some((kind) => kind === 'image out')).map((model) => ({ value: model.id, label: model.id + ' · ' + PRIVACY_LABEL[model.privacy] + (model.contextLength ? ' · ' + tokens(model.contextLength) + ' context' : '') + (model.inputPerMillion !== undefined ? ' · ' + money(model.inputPerMillion) + '/' + (money(model.outputPerMillion) || '—') + ' per 1M' : '') })) });
    const all = [];
    options.forEach((option) => { if (option.group) option.options.forEach((child) => all.push(child.value)); else all.push(option.value); });
    if (member.model && !all.includes(member.model)) options.push({ value: member.model, label: 'Custom: ' + member.model });
    return options;
  }

  function sectionModels(root) {
    const draft = work.draft;
    if (ctx && ctx.knowledgeBase) {
      const note = el('p', 'notice warning'); note.append(icon('warn'), document.createTextNode(' This project has a knowledge base (.near-kb). Every member must use a TEE or local model; forwarded models cannot be saved.'));
      root.append(note);
    }
    const tiers = el('div', 'tiers');
    tiers.append(el('span', 'hint', 'Tiers: '));
    [['deep', 'nearAi.agent.deepModel'], ['standard', 'nearAi.agent.standardModel'], ['fast', 'nearAi.agent.fastModel'], ['main', 'nearAi.defaultModel']].forEach(([tier, key]) => {
      const chip = el('span', 'tier-chip');
      chip.append(el('strong', '', tier), el('code', '', ' ' + ((ctx && ctx.tiers[tier]) || 'not set')), button('Change', () => vscode.postMessage({ type: 'open-setting', key }), { link: true, label: 'Change the ' + tier + ' model setting' }));
      tiers.append(chip);
    });
    root.append(tiers);
    if (ctx && ctx.modelsProblem) root.append(el('p', 'hint', ctx.modelsProblem));
    if (!draft.members.length) { root.append(el('p', 'hint', 'Add members first.')); return; }
    const table = el('table', 'grid');
    const caption = el('caption', 'visually-hidden', 'Model for each member');
    const head = el('thead'); const headRow = el('tr');
    ['Member', 'Model', 'Runs on'].forEach((label) => { const cell = el('th', '', label); cell.setAttribute('scope', 'col'); headRow.append(cell); });
    head.append(headRow);
    const body = el('tbody');
    draft.members.forEach((member, index) => {
      const row = el('tr');
      const name = el('th', '', memberLabel(member, index)); name.setAttribute('scope', 'row');
      const pick = select(modelChoices(member), member.model, (value) => { member.model = value; changed(false); }, 'm-model-' + index);
      pick.setAttribute('aria-label', 'Model for ' + memberLabel(member, index));
      const pickCell = el('td'); pickCell.append(pick);
      const runs = el('td', 'runs-on');
      reviewSlot(runs, 'model', index);
      reviewSlot(pickCell, 'member', index, ['model']);
      row.append(name, pickCell, runs);
      body.append(row);
    });
    table.append(caption, head, body);
    const wrap = el('div', 'table-wrap'); wrap.setAttribute('tabindex', '0'); wrap.setAttribute('aria-label', 'Member models');
    wrap.append(table);
    root.append(wrap);
    root.append(el('p', 'hint', 'A tier follows your settings, so changing nearAi.agent.deepModel later changes every member on that tier. Forwarded models leave NEAR\'s TEE: their prompts and files are not private.'));
  }

  function toolGroups() {
    const groups = new Map();
    for (const tool of ctx ? ctx.tools : []) { if (!groups.has(tool.capability)) groups.set(tool.capability, []); groups.get(tool.capability).push(tool); }
    return [...CAPABILITY_ORDER.filter((cap) => groups.has(cap)), ...[...groups.keys()].filter((cap) => !CAPABILITY_ORDER.includes(cap))].map((cap) => ({ capability: cap, tools: groups.get(cap) }));
  }
  const toolByName = (name) => (ctx ? ctx.tools : []).find((tool) => tool.name === name);

  function sectionTools(root) {
    const draft = work.draft;
    if (ctx) {
      const policy = el('p', 'policy' + (ctx.policy.stopped ? ' stopped' : ''));
      if (ctx.policy.stopped) policy.append(el('strong', '', 'Emergency stop is on.'), document.createTextNode(' Nothing runs until you resume.'));
      else policy.append(document.createTextNode('Approval mode: '), el('strong', '', ctx.policy.label), document.createTextNode(' — ' + ctx.policy.summary + ' The badges show what each tool does under it right now; change the mode from the picker under the chat box.'));
      root.append(policy);
    }
    if (!draft.members.length) { root.append(el('p', 'hint', 'Add members first.')); return; }
    const defaults = (ctx && ctx.defaultTools) || ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'TodoWrite', 'Remember', 'Recall', 'VectorizeImage', 'RenderSvg', 'CreatePresentation'];
    draft.members.forEach((member, index) => {
      const details = el('details', 'tools-member');
      if (index === 0 || work.openTools === index) details.open = true;
      details.addEventListener('toggle', () => { if (details.open) work.openTools = index; });
      const summary = el('summary');
      const chosen = member.tools || defaults;
      summary.append(el('span', 'name', memberLabel(member, index)), el('span', 'hint', ' · ' + (member.tools ? chosen.length + ' tools' : 'default set (' + defaults.length + ' tools)')));
      details.append(summary);
      const bar = el('div', 'actions');
      const useDefault = el('input'); useDefault.type = 'checkbox'; useDefault.id = 'm-default-' + index; useDefault.checked = member.tools === null;
      useDefault.addEventListener('change', () => { member.tools = useDefault.checked ? null : defaults.slice(); work.openTools = index; changed(true); focusLater('m-default-' + index); });
      const label = el('label', 'check'); label.setAttribute('for', useDefault.id); label.append(useDefault, document.createTextNode(' Use the default tool set'));
      bar.append(label,
        button('Read-only', () => { member.tools = READ_ONLY.slice(); work.openTools = index; changed(true); }, { label: 'Give ' + member.name + ' read-only tools' }),
        button('Read & edit', () => { member.tools = READ_EDIT.slice(); work.openTools = index; changed(true); }, { label: 'Give ' + member.name + ' read and edit tools' }),
        button('Everything', () => { member.tools = (ctx ? ctx.tools : []).filter((tool) => tool.status !== 'off').map((tool) => tool.name); work.openTools = index; changed(true); }, { label: 'Give ' + member.name + ' every available tool' }));
      details.append(bar);
      const runs = []; const asks = [];
      for (const group of toolGroups()) {
        const set = el('fieldset', 'tool-group');
        set.append(el('legend', '', CAPABILITY_LABEL[group.capability] || group.capability));
        for (const tool of group.tools) {
          const id = 'm-tool-' + index + '-' + tool.name;
          const box = el('input'); box.type = 'checkbox'; box.id = id; box.checked = chosen.includes(tool.name); box.disabled = member.tools === null;
          box.addEventListener('change', () => {
            const current = (member.tools || defaults).slice();
            member.tools = box.checked ? [...new Set(current.concat([tool.name]))] : current.filter((name) => name !== tool.name);
            work.openTools = index;
            changed(true);
            focusLater(id);
          });
          const line = el('div', 'tool-line');
          const label = el('label'); label.setAttribute('for', id);
          label.append(el('code', 'tool-name', tool.name), el('span', 'hint', ' ' + tool.description));
          line.append(box, label, badge(STATUS_SHORT[tool.status] || tool.status, 'status ' + (STATUS_CLASS[tool.status] || ''), tool.statusText));
          set.append(line);
          if (chosen.includes(tool.name)) (tool.status === 'runs' ? runs : asks).push(tool.name + (tool.status === 'runs' ? '' : ' (' + STATUS_SHORT[tool.status].toLowerCase() + ')'));
        }
        details.append(set);
      }
      const unknown = chosen.filter((name) => !toolByName(name));
      if (unknown.length) details.append(el('p', 'hint', 'Also listed: ' + unknown.join(', ') + ' (not a built-in tool here).'));
      const effect = el('p', 'effect');
      effect.append(el('strong', '', 'Under your approval mode: '), document.createTextNode('runs without asking — ' + (runs.join(', ') || 'none') + '; otherwise — ' + (asks.join(', ') || 'none') + '.'));
      details.append(effect);
      reviewSlot(details, 'member', index, ['tools']);
      root.append(details);
    });
  }

  function sectionInstructions(root) {
    const draft = work.draft;
    if (!draft.members.length) { root.append(el('p', 'hint', 'Add members first.')); return; }
    draft.members.forEach((member, index) => {
      const box = el('div', 'instructions');
      const area = textarea(member.instructions, (value) => { member.instructions = value; changed(false); }, 7, 'm-instr-' + index);
      box.append(field('Instructions for ' + memberLabel(member, index), area, 'Plain Markdown. Use ### for headings inside instructions.'));
      const role = roleById(member.role);
      if (role) box.append(button('Use the suggested text for ' + role.label, () => { member.instructions = role.suggestion; area.value = role.suggestion; changed(false); announce('Replaced the instructions for ' + member.name + ' with the suggested text.'); }, { link: true }));
      reviewSlot(box, 'member', index, ['instructions']);
      root.append(box);
    });
  }

  function sectionChecks(root, withPreview) {
    const checks = el('div', 'checks'); checks.id = 'checks'; checks.setAttribute('aria-live', 'polite');
    root.append(el('h3', '', 'Checks'), checks);
    if (withPreview) {
      const head = el('h3', '', 'The Markdown file'); head.id = 'preview-title';
      const pre = el('pre', 'preview'); pre.id = 'preview'; pre.setAttribute('aria-labelledby', 'preview-title'); pre.setAttribute('tabindex', '0');
      root.append(head, el('p', 'hint', work.mode === 'editor' ? 'Exactly what Save writes. Anything the studio does not show (other frontmatter keys, notes above the members) is kept as it is.' : 'Exactly what Save writes. You can keep editing it as Markdown afterwards.'), pre);
    }
    fillReview();
  }

  function sectionHistory(root) {
    root.append(el('p', 'hint', 'Every save is kept as a version (the latest 20). View one to compare it with the file now, or restore it.'));
    const versions = work.versions || [];
    if (!versions.length) { root.append(el('p', 'hint', 'No versions yet.')); return; }
    const list = el('ul', 'rows');
    versions.forEach((version, index) => {
      const row = el('li', 'row' + (work.versionView && work.versionView.ref === version.ref ? ' selected' : ''));
      row.append(el('span', 'name', version.label), el('span', 'hint', index === 0 ? 'latest' : ''));
      const actions = el('span', 'row-actions');
      actions.append(button('View changes', () => vscode.postMessage({ type: 'version-view', id: work.id, ref: version.ref }), { label: 'View the version from ' + version.label }), button('Restore', () => vscode.postMessage({ type: 'version-restore', id: work.id, ref: version.ref }), { label: 'Restore the version from ' + version.label }));
      row.append(actions);
      list.append(row);
    });
    root.append(list);
    if (work.versionView) {
      const view = work.versionView;
      root.append(el('h3', '', 'From the version of ' + view.label + ' to the file now'));
      const diff = el('pre', 'diff'); diff.setAttribute('tabindex', '0'); diff.setAttribute('aria-label', 'Line changes from the selected version to the current file');
      let changes = 0;
      for (const line of view.diff) {
        const node = el('span', 'diff-line ' + line.op, (line.op === 'add' ? '+ ' : line.op === 'del' ? '- ' : '  ') + line.text + '\n');
        if (line.op !== 'same') changes += 1;
        diff.append(node);
      }
      root.append(el('p', 'hint', changes ? changes + ' changed line' + (changes === 1 ? '' : 's') + ' (- only in that version, + only in the file now).' : 'No differences: the file now matches this version.'), diff);
    }
  }

  // ---------- review results ----------
  const slots = [];
  function reviewSlot(parent, kind, index, fields) { const node = el('div', 'slot'); node.setAttribute('aria-live', 'polite'); parent.append(node); slots.push({ node, kind, index, fields: fields || [] }); return node; }

  function issueLine(issue, level) {
    const line = el('li', level);
    line.append(icon(level === 'error' ? 'error' : 'warn'), document.createTextNode(' ' + issue.message));
    return line;
  }

  function fillReview() {
    const review = work && work.review;
    for (const slot of slots) {
      slot.node.replaceChildren();
      if (!review) continue;
      if (slot.kind === 'model') {
        const info = review.members[slot.index];
        if (!info) continue;
        const line = el('div', 'model-line');
        line.append(el('code', '', info.model || '(not set)'), document.createTextNode(' '), privacyBadge(info.privacy, info.privacyText));
        const model = (ctx ? ctx.models : []).find((candidate) => candidate.id === info.model);
        const facts = [];
        if (info.tier && info.tier !== 'model') facts.push(info.tier === 'inherit' ? 'main model' : info.tier + ' tier');
        if (model && model.contextLength) facts.push(tokens(model.contextLength) + ' context');
        if (model && (model.inputPerMillion !== undefined || model.outputPerMillion !== undefined)) facts.push((money(model.inputPerMillion) || '—') + ' in / ' + (money(model.outputPerMillion) || '—') + ' out per 1M');
        if (info.available === false) facts.push('not in your key\'s list');
        if (facts.length) line.append(el('span', 'hint', ' ' + facts.join(' · ')));
        slot.node.append(line);
        continue;
      }
      const issues = [].concat(review.errors.filter((issue) => issue.member === slot.index && slot.fields.includes(issue.field)).map((issue) => issueLine(issue, 'error')), review.warnings.filter((issue) => issue.member === slot.index && slot.fields.includes(issue.field)).map((issue) => issueLine(issue, 'warning')));
      if (issues.length) { const list = el('ul', 'issues'); issues.forEach((item) => list.append(item)); slot.node.append(list); }
    }
    const checks = $('checks');
    if (checks) {
      checks.replaceChildren();
      if (!review) checks.append(el('p', 'hint', 'Checking…'));
      else if (!review.errors.length && !review.warnings.length) { const ok = el('p', 'ok-line'); ok.append(icon('check'), document.createTextNode(' Everything checks out: the file reads back as this team, names are unique, and every model is available.')); checks.append(ok); }
      else {
        const list = el('ul', 'issues');
        review.errors.forEach((issue) => list.append(issueLine(issue, 'error')));
        review.warnings.forEach((issue) => list.append(issueLine(issue, 'warning')));
        checks.append(el('p', review.errors.length ? 'error' : 'hint', review.errors.length ? review.errors.length + ' problem' + (review.errors.length === 1 ? '' : 's') + ' to fix before saving' + (review.warnings.length ? ', and ' + review.warnings.length + ' warning' + (review.warnings.length === 1 ? '' : 's') : '') + '.' : review.warnings.length + ' warning' + (review.warnings.length === 1 ? '' : 's') + '; you can still save.'), list);
      }
    }
    const preview = $('preview');
    if (preview) preview.textContent = review ? review.markdown : '';
    const saveButton = $('save');
    if (saveButton) saveButton.disabled = Boolean(review && review.errors.length) || (work && work.mode === 'editor' && !isDirty());
    const errorCount = $('error-count');
    if (errorCount) errorCount.textContent = review && review.errors.length ? review.errors.length + ' to fix' : '';
  }

  // ---------- the wizard ----------
  function goStep(step) {
    work.step = Math.max(0, Math.min(STEPS.length - 1, step));
    work.maxStep = Math.max(work.maxStep, work.step);
    render();
    focusLater('step-heading');
  }

  function renderWizard(root) {
    const stepper = el('ol', 'stepper'); stepper.setAttribute('aria-label', 'Steps');
    STEPS.forEach((label, index) => {
      const item = el('li', index === work.step ? 'current' : index < work.step ? 'done' : '');
      const go = button((index + 1) + '. ' + label, () => goStep(index), { link: true, disabled: index > work.maxStep, label: 'Step ' + (index + 1) + ' of ' + STEPS.length + ': ' + label + (index < work.step ? ' (done)' : '') });
      if (index === work.step) go.setAttribute('aria-current', 'step');
      item.append(go);
      stepper.append(item);
    });
    const progress = el('div', 'progress'); progress.setAttribute('role', 'progressbar'); progress.setAttribute('aria-valuemin', '1'); progress.setAttribute('aria-valuemax', String(STEPS.length)); progress.setAttribute('aria-valuenow', String(work.step + 1)); progress.setAttribute('aria-label', 'Step ' + (work.step + 1) + ' of ' + STEPS.length);
    const fill = el('div', 'progress-fill step-' + (work.step + 1)); progress.append(fill);
    root.append(stepper, progress);
    const panel = el('section', 'panel'); panel.setAttribute('aria-labelledby', 'step-heading');
    const heading = el('h2', '', STEPS[work.step]); heading.id = 'step-heading'; heading.setAttribute('tabindex', '-1');
    panel.append(heading);
    const HINTS = ['Name the team, say what it is for, and pick a starting point.', 'Who is on the team and what each is responsible for.', 'Which model each member runs on.', 'What each member may use, and what will run or ask under your approval mode.', 'Fine-tune each member\'s instructions, check the result, and save.'];
    panel.append(el('p', 'hint', HINTS[work.step]));
    [sectionPurpose, sectionMembers, sectionModels, sectionTools, (node) => { sectionInstructions(node); sectionChecks(node, true); }][work.step](panel);
    root.append(panel);
    const footer = el('div', 'footer');
    footer.append(button('Back', () => goStep(work.step - 1), { disabled: work.step === 0 }), button('Save draft', () => { work.clean = JSON.stringify(work.draft); reportUnsaved(); vscode.postMessage({ type: 'save-draft', draft: work.draft, step: work.step, target: work.target, startingPoint: work.startingPoint }); }, {}), button('Cancel', leaveWork, { link: true }));
    const spacer = el('span', 'spacer'); footer.append(spacer);
    const count = el('span', 'hint'); count.id = 'error-count'; footer.append(count);
    if (work.step < STEPS.length - 1) footer.append(button('Next: ' + STEPS[work.step + 1], () => {
      if (work.step === 0 && !work.draft.members.length && work.startingPoint !== 'empty') { applyStartingPoint(true); return; }
      goStep(work.step + 1);
    }, { primary: true, id: 'next' }));
    else footer.append(button(work.target === 'project' ? 'Save project team' : 'Save team', save, { primary: true, id: 'save' }));
    root.append(footer);
  }

  // ---------- the editor ----------
  function renderEditor(root) {
    const head = el('div', 'editor-head');
    const title = el('div', 'editor-title');
    title.append(el('h2', '', work.draft.name || 'Team'), el('code', 'hint', work.file));
    const dirty = el('span', 'dirty'); dirty.id = 'dirty'; dirty.setAttribute('aria-live', 'polite');
    title.append(dirty);
    const actions = el('div', 'actions');
    actions.append(button('Save', save, { primary: true, id: 'save' }), button('Revert', () => { work.draft = JSON.parse(work.clean); changed(true); announce('Reverted to the saved team.'); }, { id: 'revert' }), button('Open as Markdown', () => vscode.postMessage({ type: 'open-markdown', id: work.id })), button('Use in chat', () => vscode.postMessage({ type: 'use-in-chat', id: work.id })));
    head.append(title, actions);
    root.append(head);
    const tabs = el('div', 'tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Team sections');
    TABS.forEach((label, index) => {
      const tab = button(label, () => selectTab(index), {});
      tab.className = 'tab' + (index === work.tab ? ' active' : '');
      tab.id = 'tab-' + index;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', index === work.tab ? 'true' : 'false');
      tab.setAttribute('aria-controls', 'tabpanel');
      tab.setAttribute('tabindex', index === work.tab ? '0' : '-1');
      tab.addEventListener('keydown', (event) => {
        const key = event.key;
        const next = key === 'ArrowRight' ? (index + 1) % TABS.length : key === 'ArrowLeft' ? (index + TABS.length - 1) % TABS.length : key === 'Home' ? 0 : key === 'End' ? TABS.length - 1 : -1;
        if (next >= 0) { if (event.preventDefault) event.preventDefault(); selectTab(next); focusLater('tab-' + next); }
      });
      tabs.append(tab);
    });
    root.append(tabs);
    const panel = el('section', 'panel'); panel.id = 'tabpanel'; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', 'tab-' + work.tab);
    [sectionPurpose, sectionMembers, sectionModels, sectionTools, sectionInstructions, (node) => sectionChecks(node, true), sectionHistory][work.tab](panel);
    if (work.tab !== 5) { const mini = el('div', 'mini-checks'); panel.append(mini); sectionChecks(mini, false); }
    root.append(panel);
    updateDirty();
  }

  function selectTab(index) {
    work.tab = index;
    if (index === 6) vscode.postMessage({ type: 'versions', id: work.id });
    render();
  }

  function updateDirty() {
    const node = $('dirty');
    if (node) node.textContent = isDirty() ? '● Unsaved changes' : 'Saved';
    const saveButton = $('save');
    if (saveButton && work && work.mode === 'editor') saveButton.disabled = !isDirty() || Boolean(work.review && work.review.errors.length);
    const revert = $('revert');
    if (revert) revert.disabled = !isDirty();
  }

  function save() {
    if (!work) return;
    if (work.mode === 'editor') { vscode.postMessage({ type: 'save', draft: work.draft, id: work.id, base: work.base }); return; }
    const message = { type: 'create', draft: work.draft, target: work.target };
    if (work.target === 'project' && work.startingPoint.startsWith('type:') && work.projectType) message.projectType = { id: work.projectType, goal: work.draft.description };
    vscode.postMessage(message);
  }

  function openEditor(message, keepTab) {
    work = { mode: 'editor', id: message.id, kind: message.kind, file: message.file, command: message.command, base: message.base, draft: message.draft, clean: JSON.stringify(message.draft), tab: keepTab && work && work.mode === 'editor' && work.id === message.id ? work.tab : 0, versions: message.versions || [], review: null, versionView: null };
  }

  // ---------- render ----------
  let pendingFocus = null;
  function focusLater(id) { pendingFocus = id; }

  function render() {
    const active = document.activeElement && document.activeElement.id;
    slots.length = 0;
    renderHeader();
    const main = $('main');
    main.replaceChildren();
    if (!ctx) { main.append(el('p', 'hint', 'Loading…')); return; }
    if (!work) renderLibrary(main);
    else if (work.mode === 'wizard') renderWizard(main);
    else renderEditor(main);
    fillReview();
    reportUnsaved();
    flash = null;
    const target = pendingFocus || active;
    pendingFocus = null;
    const node = target && $(target);
    if (node && node.focus) node.focus();
  }

  function showKept(kept) {
    if (kept.kind === 'wizard') { showBanner(kept.text, 'info'); announce(kept.text); return; }
    if (kept.kind !== 'editor' || keptShown || work) return;
    keptShown = true;
    keptEdit = kept;
    showBanner(kept.text, 'info', [
      button('Reopen with my changes', () => { hideBanner(); vscode.postMessage({ type: 'open', id: kept.id }); }, { primary: true }),
      button('Discard them', () => { hideBanner(); keptEdit = null; vscode.postMessage({ type: 'discard-kept' }); }, { link: true })
    ]);
    announce(kept.text);
  }

  window.addEventListener('message', (event) => {
    const message = event.data || {};
    switch (message.type) {
      case 'state':
        ctx = message.context; lib = message.library; savedDraft = message.savedDraft || null;
        render();
        if (work) requestReview();
        if (message.kept) showKept(message.kept);
        break;
      case 'left':
        // The host's answer to leaving with unsaved changes: stay, or go back to the library.
        if (message.choice === 'stay' || !work) break;
        work = null;
        if (message.savedDraft) savedDraft = message.savedDraft;
        render();
        if (message.notice) { showBanner(message.notice, 'info'); announce(message.notice); }
        focusMain();
        break;
      case 'library':
        lib = message.library;
        if (!work) render();
        break;
      case 'start-wizard':
        if (isDirty() || isWizardDirty()) { showBanner('Save or discard your changes first, then set up the project team.', 'warning'); break; }
        startWizard(message.target);
        break;
      case 'team':
        openEditor(message, true);
        if (keptEdit && keptEdit.id === message.id) {
          // Reopening a team whose changes were kept: they come back as unsaved changes.
          work.draft = clone(keptEdit.draft);
          const moved = keptEdit.base !== message.base;
          keptEdit = null;
          vscode.postMessage({ type: 'discard-kept' });
          savedDraft = null;
          render();
          requestReview();
          showBanner(moved ? 'Your kept changes are back. The file changed since they were kept; check them before saving.' : 'Your kept changes are back. Save them, or Revert to the saved team.', moved ? 'warning' : 'info');
          focusMain();
          break;
        }
        if (message.notice) { showBanner(message.notice, 'info'); announce(message.notice); }
        savedDraft = null;
        render();
        requestReview();
        focusMain();
        break;
      case 'review':
        if (!work || message.seq !== seq) break;
        work.review = { markdown: message.markdown, errors: message.errors, warnings: message.warnings, members: message.members };
        fillReview();
        updateDirty();
        break;
      case 'starting-point': {
        if (!work || work.mode !== 'wizard') break;
        const draft = message.draft;
        work.draft.members = draft.members;
        if (!work.draft.description.trim() && draft.description) work.draft.description = draft.description;
        work.projectType = message.projectType || null;
        const next = work.awaitingStart && work.awaitingStart.next;
        work.awaitingStart = null;
        announce('Added ' + draft.members.length + ' members from the starting point.');
        if (next) goStep(1); else { render(); }
        requestReview();
        break;
      }
      case 'external-change': {
        if (!work || work.mode !== 'editor' || work.id !== message.id) break;
        work.versions = message.versions || work.versions;
        if (!isDirty() && message.draft) {
          work.base = message.base; work.draft = message.draft; work.clean = JSON.stringify(message.draft);
          render(); requestReview();
          announce('The team file changed outside the studio; the studio now shows the new version.');
          showBanner('Updated from the Markdown file, which was changed outside the studio.', 'info');
          break;
        }
        const incoming = message;
        showBanner(message.reason === 'conflict' ? 'The team file changed outside the studio since you opened it, so it was not saved.' : 'The team file changed outside the studio while you have unsaved changes.', 'warning', [
          ...(incoming.draft ? [button('Reload from file', () => { work.base = incoming.base; work.draft = incoming.draft; work.clean = JSON.stringify(incoming.draft); hideBanner(); render(); requestReview(); announce('Reloaded from the file.'); }, { primary: true })] : []),
          button('Keep mine', () => { work.base = incoming.base; hideBanner(); announce('Keeping your changes. Save to write them over the file; its other content is kept.'); updateDirty(); requestReview(); }, {})
        ]);
        break;
      }
      case 'save-failed':
        if (work) { work.review = Object.assign({}, work.review || { markdown: '', warnings: [], members: [] }, { errors: message.errors }); fillReview(); }
        showBanner('Not saved: ' + (message.errors[0] ? message.errors[0].message : 'fix the problems listed under Checks.'), 'error');
        break;
      case 'versions':
        if (work && work.mode === 'editor' && work.id === message.id) { work.versions = message.versions; if (work.tab === 6) render(); }
        break;
      case 'version':
        if (work && work.mode === 'editor' && work.id === message.id) { work.versionView = { ref: message.ref, label: message.label, diff: message.diff }; render(); }
        break;
      case 'notice':
        showBanner(message.text, message.level === 'warning' ? 'warning' : 'info');
        announce(message.text);
        if (message.focus && !work) { flash = message.focus; render(); }
        break;
      case 'error':
        showBanner(message.text, 'error');
        break;
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
