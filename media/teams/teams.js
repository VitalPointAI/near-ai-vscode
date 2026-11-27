// SovAI Team Studio. The host sends the team library and everything the pickers need; the page
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
    error: 'M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm2.8 8.7l-1.1 1.1L8 9.1l-1.7 1.7-1.1-1.1L6.9 8 5.2 6.3l1.1-1.1L8 6.9l1.7-1.7 1.1 1.1L9.1 8z',
    info: 'M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm-.75 3h1.5v1.5h-1.5V4zm0 3h1.5v5h-1.5V7z'
  };
  const STEPS = ['Purpose', 'Members', 'Models', 'Tools & permissions', 'Instructions & review'];
  const TABS = ['Purpose', 'Members', 'Models', 'Tools', 'Instructions', 'Team shape', 'Knowledge', 'Markdown & checks', 'History'];
  // Named indexes, because a tab inserted in the middle silently moved every number after it (adding "Team shape" turned History from 6 into 7).
  const TAB_SHAPE = TABS.indexOf('Team shape');
  const TAB_KNOWLEDGE = TABS.indexOf('Knowledge');
  const TAB_CHECKS = TABS.indexOf('Markdown & checks');
  const TAB_HISTORY = TABS.indexOf('History');
  const CAPABILITY_ORDER = ['read', 'plan', 'edit', 'shell', 'network', 'generate', 'git', 'publish', 'learn'];
  const CAPABILITY_LABEL = { read: 'Read', plan: 'Plan and coordinate', edit: 'Edit files', shell: 'Run commands', network: 'Network', generate: 'Generate media', git: 'Git', publish: 'Publish', learn: 'Share with the team' };
  const STATUS_CLASS = { runs: 'ok', asks: 'ask', 'auto-checked': 'checked', off: 'off', stopped: 'stopped' };
  const STATUS_SHORT = { runs: 'Runs', asks: 'Asks first', 'auto-checked': 'Checked', off: 'Off', stopped: 'Blocked' };
  const PRIVACY_LABEL = { tee: 'TEE', local: 'Local', forwarded: 'Forwarded', unknown: 'Unknown' };
  const READ_ONLY = ['Read', 'Glob', 'Grep', 'TodoWrite', 'Recall', 'Remember'];
  const READ_EDIT = READ_ONLY.concat(['Write', 'Edit']);

  let ctx = null;
  let lib = { teams: [], archived: [] };
  // Every starting point the new-team picker offers (the host builds it: the person's saved teams, then the built-in ones), and which of them it shows.
  let picker = null;
  let pickerFilter = 'all';
  const PICKER_FILTERS = [['all', 'All'], ['mine', 'My teams'], ['builtin', 'Built-in']];
  const NO_SAVED_TEAMS = 'You have no saved teams yet. Save a team as one of your teams in Team Studio to reuse it in any project.';
  let savedDraft = null;
  let work = null; // the team being built or edited
  let staffPreview;
  let staffPreviewRequest = 0;
  let seq = 0;
  let reviewTimer = null;
  // Improve with AI (0.4.27): its own sequence numbers, so a reply to an older request is dropped.
  let improveSeq = 0;
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

  // ---------- team icons (0.4.30, owner 2026-11-17) ----------
  // A team's own icon is a 128 x 128 PNG the host checked and sends as a data URI; anything else is never loaded (the policy allows only data: images,
  // and this only a PNG one). A team without one, built-in teams included, gets a default drawn here: its initials on a colour picked from its name, so
  // every card always has an icon and the same team always looks the same. The colours all keep white initials at a contrast of at least 4.5 to 1;
  // high contrast themes draw it with the theme's own colours and a border instead (teams.css).
  const ICON_COLOURS = ['#1f5fa8', '#6f3fb0', '#a3316a', '#a8401f', '#2b7139', '#0e6a74', '#7e5500', '#4a5568'];
  const ICON_SIZE = 128;
  const MAX_ICON_BYTES = 64 * 1024;
  const PNG_URI = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;
  function initials(name) {
    const words = String(name || '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const named = words.length > 1 ? words.filter((word) => word.toLowerCase() !== 'team') : words;
    return (named.slice(0, 2).map((word) => Array.from(word)[0]).join('') || 'T').toUpperCase();
  }
  function iconColour(name) {
    let hash = 2166136261;
    for (const char of String(name || '').toLowerCase()) { hash ^= char.codePointAt(0); hash = Math.imul(hash, 16777619) >>> 0; }
    return ICON_COLOURS[hash % ICON_COLOURS.length];
  }
  /**
   * The team's icon: its own PNG, or the default. `label`: a name for a screen reader (the icon on its own, as in the editor); without one it is
   * decorative, because the team's name is written beside it.
   */
  function teamIcon(name, uri, label, size) {
    const big = size === 'large';
    if (typeof uri === 'string' && PNG_URI.test(uri)) {
      const image = el('img', 'team-icon' + (big ? ' large' : ''));
      image.src = uri; image.alt = label ? 'Icon for ' + name : ''; image.width = big ? 64 : 32; image.height = big ? 64 : 32;
      return image;
    }
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 32 32'); svg.setAttribute('width', big ? '64' : '32'); svg.setAttribute('height', big ? '64' : '32');
    svg.setAttribute('class', 'team-icon team-icon-default' + (big ? ' large' : ''));
    if (label) { svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Default icon for ' + name); } else svg.setAttribute('aria-hidden', 'true');
    const box = document.createElementNS(SVG, 'rect');
    box.setAttribute('width', '32'); box.setAttribute('height', '32'); box.setAttribute('rx', '7'); box.setAttribute('fill', iconColour(name));
    const letters = document.createElementNS(SVG, 'text');
    const text = initials(name);
    letters.setAttribute('x', '16'); letters.setAttribute('y', '16'); letters.setAttribute('dy', '0.35em'); letters.setAttribute('text-anchor', 'middle');
    letters.setAttribute('font-size', text.length > 1 ? '13' : '16'); letters.setAttribute('font-weight', '600'); letters.setAttribute('fill', '#ffffff');
    letters.textContent = text;
    svg.append(box, letters);
    return svg;
  }
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
  const wizardState = () => { const state = { draft: work.draft, step: work.step, target: work.target }; if (work.startingPoint) state.startingPoint = work.startingPoint; if (work.path) state.path = work.path; return state; };

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

  // The saved team's shape and knowledge, held here because a new team must clear them (see startWizard). Declared before anything that assigns them.
  let currentGraph = null;
  // 0.4.28: a run of the open team is going now, so the shape tab offers to watch it live.
  let currentLive = false;
  let currentKnowledge = null;
  let selectedNode = null;
  let openCard = null;

  // How the builder starts (owner, 2026-11-17: "if I select an existing team I shouldn't have to name it and give it a description"). Its stages:
  //   start ("How do you want to start?") -> pick (Use an existing team) -> Use as is (the host saves it; the builder closes)
  //                                                                       -> Clone and modify -> steps (Purpose ... save)
  //   start -> new (Create a new team) -> From scratch -> steps
  //                                    -> pick (Clone an existing team) -> Clone and modify -> steps
  //                                    -> Describe it, and AI drafts it -> the library's AI box
  //   start -> recommend (Recommend a team for me, 0.4.30: moved here from the picker) -> the answers -> the recommended team -> Use as is | Clone and
  //            modify, as for a picked team. Changing an answer clears the team shown, so what is used is always what was shown for these answers.
  // Back goes one screen up from each of them: from the Purpose step to the screen the team was started from (work.path), and to Create a new team for
  // a draft saved before this change (no path) or a team the AI drafted. Cancel and "All teams" leave from any of them, asking first when something
  // is unsaved. A resumed draft opens straight on its step.
  function startWizard(target, resume, fromProposal) {
    hideBanner();
    // A new team has no shape or knowledge yet, so the previous team's are cleared here. Without this, "New team" showed the last team's hierarchy and
    // graph in its tabs (0.4.19 review).
    currentGraph = null;
    currentKnowledge = null;
    selectedNode = null;
    openCard = null;
    const options = { locality: 'cloud', workShape: 'feature', riskLevel: 'medium', goal: '' };
    // Another builder: a draft aimed at the project from an earlier one is forgotten. (A proposal being used has already taken its target.)
    askTarget = 'user';
    pendingAsk = null;
    if (resume) work = { mode: 'wizard', stage: 'steps', target: resume.target, step: resume.step, maxStep: resume.step, draft: clone(resume.draft), startingPoint: resume.startingPoint || 'recommend', path: resume.path || null, defaultName: '', options, review: null };
    else if (fromProposal) work = { mode: 'wizard', stage: 'steps', target: target === 'project' && ctx && ctx.hasProject ? 'project' : 'user', step: 0, maxStep: 0, draft: clone(fromProposal.draft || fallbackDraft(fromProposal.proposal || fromProposal)), startingPoint: 'empty', path: null, defaultName: '', options, review: null };
    else {
      const name = target === 'project' ? 'Project team' : '';
      work = { mode: 'wizard', stage: 'start', target: target === 'project' && ctx && ctx.hasProject ? 'project' : 'user', step: 0, maxStep: 0, draft: { name, description: '', members: [] }, startingPoint: 'empty', path: null, defaultName: name, options, review: null };
    }
    work.pickMode = 'existing';
    // A draft cloned from a team goes back to the picker with that team still selected (the recommendation is not in the picker: its draft goes back
    // to its own screen, see backFromPurpose).
    work.pick = resume && resume.path && resume.startingPoint && resume.startingPoint !== 'empty' && resume.startingPoint !== 'recommend' ? resume.startingPoint : null;
    work.recommendation = null;
    work.recommendSeq = null;
    work.cloned = null;
    work.clean = JSON.stringify(work.draft);
    focusLater('step-heading');
    render();
    requestReview();
  }

  /** Moves to one of the screens before the steps, and puts focus on its heading. */
  function goStage(stage, pickMode, focusId) {
    work.stage = stage;
    if (pickMode) work.pickMode = pickMode;
    work.awaitingStart = null;
    // A request left behind is no longer waited on here (PR #75 review): the buttons are offered again, and the host still answers a second request.
    work.busy = false;
    work.busyFor = null;
    // The same for a recommendation asked for on a screen the person has left: its reply is dropped.
    work.recommendSeq = null;
    focusLater(focusId || 'step-heading');
    render();
  }

  /** Back from the Purpose step: the screen the team was started from. */
  function backFromPurpose() {
    // The recommendation, cloned on its own screen (path existing, as a 0.4.29 build also reads it) or from the 0.4.29 picker: back to its screen.
    if (work.startingPoint === 'recommend' && (work.path === 'existing' || work.path === 'clone')) goStage('recommend');
    else if (work.path === 'existing') goStage('pick', 'existing');
    else if (work.path === 'clone') goStage('pick', 'clone');
    else goStage('new');
  }


  function changed(structural) {
    if (structural) render(); else { updateDirty(); updateImprove(); }
    reportUnsaved();
    requestReview();
  }

  /**
   * The team being built was cloned from a team (Clone and modify, from the picker or the recommendation, or a resumed draft that was): its name must be
   * one no team has, and it starts with the default icon, never the icon of the team it was copied from. From scratch clears it.
   */
  function isClone() {
    return Boolean(work && work.mode === 'wizard' && (work.path === 'clone' || work.path === 'existing') && work.startingPoint && work.startingPoint !== 'empty');
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
      // A clone's name is checked by the host against every team's (owner, 2026-11-18); the page shows what it says and has no naming rules of its own.
      if (isClone()) message.clone = true;
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
    askTarget = 'user';
    pendingAsk = null;
    work = null;
    render();
    focusMain();
  }

  function focusMain() { const main = $('main'); if (main && main.focus) main.focus(); }

  // ---------- one size of card (0.4.30, owner 2026-11-17: "ensure each of the team cards are standard size (truncate/show more for description if it's
  // too long)") ----------
  // A card's description is clamped to three lines and its member list to four names; Show more opens that card alone (aria-expanded), and the cards
  // open stay open while the page is drawn again. Whether anything is clamped is worked out from the text first, then measured once the page is laid out,
  // so a description that wraps to four lines in a narrow panel still gets its button.
  const MEMBER_CHIPS = 4;
  const CLAMP_CHARS = 120;
  const expandedCards = new Set();

  /** The Show more / Show less button for one card. `key` names the card (its team id; picker cards are prefixed), `controls` the clamped part. */
  function moreButton(key, name, controls, hiddenMembers, longText) {
    const open = expandedCards.has(key);
    const node = button(open ? 'Show less' : 'Show more', () => {
      if (expandedCards.has(key)) expandedCards.delete(key); else expandedCards.add(key);
      focusLater(node.id);
      render();
    }, { link: true, label: (open ? 'Show less about ' : 'Show more about ') + name, id: 'more-' + key.replace(/[^A-Za-z0-9_-]/g, '-') });
    node.className += ' more';
    node.setAttribute('aria-expanded', open ? 'true' : 'false');
    node.setAttribute('aria-controls', controls);
    node.dataset.hiddenMembers = String(hiddenMembers);
    node.hidden = !(open || hiddenMembers > 0 || longText);
    return node;
  }

  /** After layout: a card whose text is cut off shows its button, one whose text fits does not. Only in a real page (the tests' small DOM has no layout). */
  function measureClamps() {
    const main = $('main');
    if (!main || typeof main.querySelectorAll !== 'function') return;
    for (const node of main.querySelectorAll('button.more')) {
      if (node.getAttribute('aria-expanded') === 'true') { node.hidden = false; continue; }
      const holder = node.closest('.card, .choice-cell');
      const cut = holder ? [...holder.querySelectorAll('.clamp')].some((part) => part.scrollHeight > part.clientHeight + 1) : false;
      node.hidden = !(cut || Number(node.dataset.hiddenMembers || 0) > 0);
    }
  }
  let measureQueued = false;
  function measureSoon() {
    if (measureQueued || typeof requestAnimationFrame !== 'function') return;
    measureQueued = true;
    requestAnimationFrame(() => { measureQueued = false; measureClamps(); });
  }
  window.addEventListener('resize', () => measureSoon());

  // ---------- library ----------
  // ---------- the AI start ----------
  // Owner, 2026-11-08: "start with the chat asking what type of task or output the user wants the team to be able to provide", then draft the team with a
  // name, members, roles, suggested models, what each produces, and the final outputs and formats. The proposal is shown first and becomes a team only
  // when the person accepts it, so one answer is never saved on trust.
  let proposal = null;
  let drafting = false;
  // What the person typed is kept while they look at the proposal, so "Start over" does not make them write it again.
  let lastIdea = '';
  let lastFormat = '';
  let lastDepth = 'thorough';
  let lastPrivate = false;
  // Where a team drafted by AI is saved: 'project' only when the person came straight from a builder saving to this project's team (Describe it, and
  // AI drafts it). Forgotten whenever the builder is left another way, a team or another builder is opened, or the proposal is discarded (PR #75
  // review), so a later draft from the library's own box is one of the person's teams. `pendingAsk` holds it while the host asks about unsaved work.
  let askTarget = 'user';
  let pendingAsk = null;

  // The host computes the draft from the proposal (src/agent/teamBuilder.ts) and sends it with the proposal, so the two cannot drift. This is only a
  // fallback for an older host that does not send it: the page must never throw, even then.
  function fallbackDraft(from) {
    return {
      name: from.name || 'New team',
      description: `${from.mission || ''} ${from.description || ''}`.trim().slice(0, 400),
      members: (from.members || []).map((member, index) => ({
        name: member.name || 'member-' + (index + 1), role: member.role || '', model: member.model || 'standard', tools: null,
        instructions: member.instructions || ''
      }))
    };
  }

  function askSection() {
    const box = el('section', 'ask');
    if (drafting) { box.append(el('p', 'hint', 'Drafting the team from what you wrote...')); return box; }
    box.append(el('h3', '', 'What should this team be able to produce?'));
    box.append(el('p', 'hint', 'Describe it in your own words. The team is drafted from this: its name, its members and their roles, what each one hands back, and the outputs you get.'));
    if (askTarget === 'project') box.append(el('p', 'hint', 'The team you draft here is saved as this project\'s team unless you choose otherwise.'));
    const idea = el('textarea', 'ask-idea', '');
    idea.id = 'ask-idea'; idea.rows = 3;
    idea.value = lastIdea;
    idea.setAttribute('aria-label', 'What should this team be able to produce');
    idea.setAttribute('placeholder', 'e.g. A team that researches a market and writes a short brief with a citation for every claim');
    idea.addEventListener('input', () => { lastIdea = idea.value; });
    box.append(idea);
    const details = el('div', 'ask-details');
    const format = input(lastFormat, (value) => { lastFormat = value; }, { id: 'ask-format', placeholder: 'Output format, e.g. Markdown brief with citations', maxlength: '300', autocomplete: 'off' });
    format.setAttribute('aria-label', 'The output format you want');
    const depth = el('select'); depth.setAttribute('aria-label', 'How deep the work should go');
    depth.append(new Option('Thorough: sources checked', 'thorough', false, lastDepth !== 'quick'), new Option('Quick: a first useful answer', 'quick', false, lastDepth === 'quick'));
    depth.addEventListener('change', () => { lastDepth = depth.value; });
    details.append(field('Output format (optional)', format), field('Depth', depth));
    box.append(details);
    // A private team's brief goes only to a private model, and the drafted team is marked private (owner, 2026-11-16).
    const privateBox = el('input'); privateBox.type = 'checkbox'; privateBox.id = 'ask-private'; privateBox.checked = lastPrivate;
    privateBox.addEventListener('change', () => { lastPrivate = privateBox.checked; });
    const privateLabel = el('label', 'check'); privateLabel.setAttribute('for', privateBox.id);
    privateLabel.append(privateBox, document.createTextNode(' Private team: draft it with a private model only (NEAR TEE or this machine), and keep its members on private models'));
    box.append(privateLabel);
    const actions = el('div', 'ask-actions');
    actions.append(button('Draft the team', () => {
      if (!idea.value.trim()) { announce('Say what the team should produce first.'); idea.focus(); return; }
      drafting = true; render();
      vscode.postMessage({ type: 'draft-team', idea: idea.value, ...(lastFormat.trim() ? { outputFormat: lastFormat } : {}), depth: lastDepth, ...(lastPrivate ? { private: true } : {}) });
    }, { primary: true, id: 'draft-team' }), el('span', 'hint', 'One model call. You see the proposal before anything is saved.'));
    box.append(actions);
    return box;
  }

  function proposalSection() {
    const box = el('section', 'proposal');
    const title = el('h3', '', proposal.proposal.name || 'Proposed team'); title.id = 'proposal-title'; title.setAttribute('tabindex', '-1');
    box.setAttribute('aria-labelledby', title.id);
    box.append(title);
    box.append(el('p', 'mission', proposal.proposal.mission));
    box.append(el('p', '', proposal.proposal.description));
    const members = el('table', 'proposal-members');
    const head = el('thead'); const headRow = el('tr');
    for (const label of ['Member', 'Role', 'Model', 'Produces']) headRow.append(el('th', '', label));
    head.append(headRow); members.append(head);
    const body = el('tbody');
    for (const member of proposal.proposal.members) {
      const row = el('tr');
      row.append(el('td', '', member.name), el('td', '', member.role), el('td', '', member.model), el('td', '', member.produces));
      body.append(row);
    }
    members.append(body);
    box.append(members);
    if (proposal.proposal.outputs.length) {
      box.append(el('h3', '', 'You get'));
      const list = el('ul', 'proposal-outputs');
      for (const output of proposal.proposal.outputs) list.append(el('li', '', output.name + ': ' + output.format + ' (from ' + output.from + ')'));
      box.append(list);
    }
    // What the builder added on its own (the plagiarism checker on a research team), said before the person accepts.
    for (const note of proposal.proposal.notes || []) box.append(el('p', 'hint', note));
    if (proposal.problems && proposal.problems.length) {
      const notes = el('ul', 'issues');
      for (const problem of proposal.problems) notes.append(issueLine({ message: problem }, 'warning'));
      box.append(el('p', 'hint', 'The draft was repaired in these places:'), notes);
    }
    const actions = el('div', 'ask-actions');
    actions.append(
      // A team drafted from the builder keeps where that builder was saving to (its entry point, or the person's choice there); one drafted from the
      // library's own box is one of the person's teams, as before (PR #75 review).
      // Either ends the wait: the host stops keeping the drafted team.
      button('Use this team', () => { const from = proposal; const target = askTarget; proposal = null; askTarget = 'user'; vscode.postMessage({ type: 'proposal-done' }); startWizard(target, null, from); }, { primary: true }),
      // Start over stays on the AI start, so it keeps where that start saves (PR 86 review, round 3): only entering the AI start sets the target, and only
      // leaving it clears it.
      button('Start over', () => { proposal = null; drafting = false; vscode.postMessage({ type: 'proposal-done' }); render(); }, { link: true })
    );
    box.append(actions);
    return box;
  }

  // ---------- the dashboard (owner, 2026-11-17: "The Team Studio main page needs to be more of a dashboard of existing teams and their statuses, model
  // setups, stats about them, rating, etc.") ----------
  // The host works out every figure (src/domain/teamDashboard.ts) from what the extension keeps: the project's run history, the runs going now, the team
  // files, the local check and the last role test. The page only lays it out, and says "none yet" or "not recorded" where there is no record.
  const SORTS = [['used', 'Most used'], ['recent', 'Recently run'], ['rating', 'Rating'], ['name', 'Name']];
  const STATUS_TEXT = { running: 'Running now', ready: 'Ready', attention: 'Needs attention', 'never-run': 'Never run' };
  const PRIVACY_WORD = { tee: 'Private', local: 'Private', forwarded: 'Cloud', unknown: 'Privacy unknown' };
  const FIRST_TEAM_LABEL = 'New team: create your first team';
  const NO_HISTORY = 'Runs and spend are kept per project. Open a project folder to see them.';
  /** The sort and the Needs attention filter: the webview's own state when this tab is reloaded, else what the host kept for the person (applyView). */
  const viewState = (() => { try { const value = vscode.getState ? vscode.getState() : null; return value && typeof value === 'object' ? value : {}; } catch (error) { return {}; } })();
  let dash = null;
  let dashSort = SORTS.some(([value]) => value === viewState.dashSort) ? viewState.dashSort : 'used';
  let dashAttention = viewState.dashAttention === true;
  /** Kept twice: in the webview's state (for a reload of this tab) and by the host for the person (for the next time the tab opens). */
  function rememberView() {
    try { if (vscode.setState) vscode.setState({ dashSort, dashAttention }); } catch (error) { /* the view still works, it is only not remembered here */ }
    vscode.postMessage({ type: 'view', sort: dashSort, attention: dashAttention });
  }
  /** The view the host kept for the person, when it is one of the known choices. */
  function applyView(view) {
    if (!view || typeof view !== 'object') return;
    if (SORTS.some(([value]) => value === view.sort)) dashSort = view.sort;
    if (typeof view.attention === 'boolean') dashAttention = view.attention;
  }
  /** Ratings chosen on a card and not yet confirmed by the host (team id -> stars, 0 for none), shown at once; sent once the choice settles. */
  const pendingRating = new Map();
  const ratingQueue = new Map();
  let ratingTimer = null;
  const keyOf = (id) => String(id).replace(/[^A-Za-z0-9_-]/g, '-');
  const ratingOf = (team) => (pendingRating.has(team.id) ? pendingRating.get(team.id) : (team.rating || 0));
  const NO_STATS = { runs: 0, running: 0, completed: 0, failed: 0, cancelled: 0, ended: 0, timedRuns: 0, costedRuns: 0, runsThisWeek: 0 };
  /** The host's card for a team; a team it has not worked out yet (an older host, or a listing that arrived first) gets an honest empty one. */
  function cardInfo(team) {
    const card = dash && dash.cards ? dash.cards[team.id] : null;
    if (card) return card;
    const attention = [];
    if (team.error) attention.push('The team file needs fixing: ' + team.error);
    if (team.imported) attention.push('Imported and not approved yet: you are asked the first time it runs.');
    return { id: team.id, status: attention.length ? 'attention' : 'never-run', attention, stats: NO_STATS, health: { parts: [] } };
  }
  const needsAttention = (team) => cardInfo(team).attention.length > 0 || Boolean(team.error);

  /** "5 minutes ago", "2 days ago": relative to the time the host worked the dashboard out, so it never depends on this page's clock. */
  function ago(iso) {
    const at = Date.parse(iso);
    if (isNaN(at)) return 'unknown';
    const now = dash && typeof dash.now === 'number' ? dash.now : Date.now();
    const minutes = Math.floor(Math.max(0, now - at) / 60000);
    const unit = (count, word) => count + ' ' + word + (count === 1 ? '' : 's') + ' ago';
    if (minutes < 1) return 'just now';
    if (minutes < 60) return unit(minutes, 'minute');
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return unit(hours, 'hour');
    const days = Math.floor(hours / 24);
    if (days < 31) return unit(days, 'day');
    return new Date(at).toLocaleDateString(undefined, { dateStyle: 'medium' });
  }
  function duration(ms) {
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return seconds + ' s';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + ' min' + (seconds % 60 ? ' ' + (seconds % 60) + ' s' : '');
    return Math.floor(minutes / 60) + ' h' + (minutes % 60 ? ' ' + (minutes % 60) + ' min' : '');
  }

  // Staff teams: gold is a person's decision, violet is agent work (the Staff Room's colour language), always with words, never colour alone.
  function staffLegend() {
    const legend = el('p', 'staff-legend');
    legend.append(el('span', 'staff-person', 'A named person decides'), document.createTextNode(' '), el('span', 'staff-agent', 'Agents draft and recommend'));
    return legend;
  }

  function renderLibrary(root) {
    const bar = el('div', 'toolbar');
    const heading = el('h2', '', 'Your teams'); heading.id = 'library-title';
    const actions = el('div', 'actions');
    // New team goes to the builder's first screen: Use an existing team, Create a new team, or Recommend a team for me.
    // Every control on the dashboard has a stable id, so focus comes back to it whenever the page is drawn again (PR 86 review, round 4).
    actions.append(button('New team', () => startWizard('user'), { primary: true, icon: 'plus', id: 'new-team' }));
    // On demand, for every team at once: test each and set its member models from what the tests found.
    // 0.4.19 review: it said "This takes a few minutes", and six members on three models can run for hours. The host asks first and states the ceiling
    // worked out from the runs, so the button only says the run is coming, not how long it takes.
    actions.append(button('Optimise all teams', () => { announce('Testing every team to set its models. The cost and the longest it can take are asked before anything runs.'); vscode.postMessage({ type: 'optimise-all' }); }, { label: 'Test every team and set each member model from what the tests found, after asking about the cost', id: 'optimise-all' }));
    actions.append(button('Set up staff', openStaffPreview, { id: 'staff-preview-open' }));
    actions.append(button('Import…', () => vscode.postMessage({ type: 'import' }), { id: 'import-team' }), button('Refresh', () => vscode.postMessage({ type: 'refresh' }), { link: true, id: 'refresh' }));
    bar.append(heading, actions);
    root.append(bar);
    if (lib.teams.some((team) => team.staff)) {
      actions.append(button('Open the Staff Room', () => vscode.postMessage({ type: 'staff-room' }), { label: 'Open the Staff Room: the staff run as a war room, with each section\'s workspace, the shared map, the products and the decisions waiting for a person', id: 'staff-room' }));
      root.append(staffLegend());
    }

    if (savedDraft) {
      const resume = el('div', 'resume');
      resume.append(icon('warn'), el('span', '', 'You have an unfinished team' + (savedDraft.draft.name ? ' "' + savedDraft.draft.name + '"' : '') + ' (step ' + (savedDraft.step + 1) + ' of 5).'));
      resume.append(button('Resume', () => startWizard(savedDraft.target, savedDraft), { primary: true, id: 'resume-draft' }), button('Discard draft', () => { vscode.postMessage({ type: 'discard-draft' }); savedDraft = null; render(); }, { link: true, id: 'discard-draft' }));
      root.append(resume);
    }
    const waiting = draftWaiting();
    if (waiting) root.append(waiting);

    if (!lib.teams.length) {
      // The first run: no summary of nothing, just the two ways in.
      const empty = el('div', 'empty');
      const art = icon('team'); art.setAttribute('class', 'icon large');
      empty.append(art, el('h3', '', 'Create your first team'), el('p', 'hint', 'A team is a few agents with their own roles, models, and tools. A lead agent hands them the work and puts their results together. Start from a team the extension provides, build your own, or let the studio recommend one.'));
      const go = el('div', 'actions center');
      go.append(button('New team', () => startWizard('user'), { primary: true, icon: 'plus', label: FIRST_TEAM_LABEL, id: 'first-team' }));
      if (ctx && ctx.hasProject) go.append(button('Set up a team for this project', () => startWizard('project'), { id: 'first-project-team' }));
      empty.append(go);
      root.append(empty);
    } else {
      root.append(summaryRow());
      const attentionCount = lib.teams.filter(needsAttention).length;
      root.append(dashControls(attentionCount));
      const list = el('ul', 'cards'); list.setAttribute('aria-labelledby', 'library-title');
      // The project's own team comes first when there is none yet: a card that says so, with Set up (not a team, so never filtered in).
      if (ctx && ctx.hasProject && !dashAttention && !lib.teams.some((team) => team.kind === 'project')) list.append(projectEmptyCard());
      const shown = sortedTeams(lib.teams.filter((team) => !dashAttention || needsAttention(team)));
      for (const team of shown) list.append(teamCard(team));
      root.append(list);
      if (dashAttention && !shown.length) root.append(el('p', 'hint', 'No team needs attention.'));
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
        actions.append(button('Restore', () => vscode.postMessage({ type: 'restore', id: entry.id }), { label: 'Restore ' + entry.name, id: 'restore-' + keyOf(entry.id) }), button('Open as Markdown', () => vscode.postMessage({ type: 'open-markdown', id: entry.id }), { link: true, label: 'Open archived ' + entry.name + ' as Markdown', id: 'archived-md-' + keyOf(entry.id) }));
        row.append(actions);
        list.append(row);
      }
      details.append(list);
      root.append(details);
    }
  }

  /** The summary row: teams, running now, runs and spend this week, and how many need attention, each from the host's records. */
  function summaryRow() {
    const summary = dash && dash.summary ? dash.summary : null;
    const history = Boolean(dash && dash.history);
    const box = el('section', 'summary'); box.setAttribute('aria-label', 'Summary');
    const tiles = el('dl', 'tiles');
    const tile = (id, label, value, title) => {
      const wrap = el('div', 'tile' + (id === 'sum-attention' && value !== '0' ? ' warn' : ''));
      const value_ = el('dd', '', value); value_.id = id;
      wrap.append(el('dt', '', label), value_);
      if (title) wrap.title = title;
      tiles.append(wrap);
    };
    const runs = summary ? summary.runsThisWeek : 0;
    tile('sum-teams', 'Teams', String(lib.teams.length));
    tile('sum-running', 'Running now', String(summary ? summary.running : 0), 'Teams with a run going now.');
    tile('sum-runs', 'Runs this week', !history ? 'not recorded' : runs ? String(runs) : 'none', 'Team runs started in this project in the last seven days.');
    tile('sum-spend', 'Spend this week', !history ? 'not recorded' : !runs ? 'none' : summary.spendThisWeekUsd === undefined ? 'not recorded' : money(summary.spendThisWeekUsd), 'What those runs cost, from the spend ledger.');
    tile('sum-attention', 'Need attention', String(summary ? summary.attention : lib.teams.filter(needsAttention).length));
    box.append(tiles, el('p', 'hint small', history ? 'This week is the last seven days, in this project.' : NO_HISTORY));
    return box;
  }

  function dashControls(attentionCount) {
    const box = el('div', 'dash-controls');
    box.append(field('Sort by', select(SORTS.map(([value, label]) => ({ value, label })), dashSort, (value) => {
      dashSort = SORTS.some(([known]) => known === value) ? value : 'used';
      rememberView();
      focusLater('dash-sort');
      render();
    }, 'dash-sort')));
    const check = el('input'); check.type = 'checkbox'; check.id = 'dash-attention'; check.checked = dashAttention;
    check.addEventListener('change', () => { dashAttention = check.checked === true; rememberView(); focusLater('dash-attention'); render(); });
    const label = el('label', 'check'); label.setAttribute('for', check.id);
    label.append(check, document.createTextNode('Needs attention only (' + attentionCount + ')'));
    box.append(label);
    return box;
  }

  /** The teams in the chosen order; ties (and Name) by name. */
  function sortedTeams(teams) {
    const stats = (team) => cardInfo(team).stats || NO_STATS;
    const lastRun = (team) => { const at = stats(team).lastRunAt ? Date.parse(stats(team).lastRunAt) : NaN; return isNaN(at) ? -1 : at; };
    const health = (team) => { const value = cardInfo(team).health; return value && typeof value.score === 'number' ? value.score : -1; };
    const byName = (a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' });
    const order = {
      used: (a, b) => stats(b).runs - stats(a).runs,
      recent: (a, b) => lastRun(b) - lastRun(a),
      rating: (a, b) => ratingOf(b) - ratingOf(a) || health(b) - health(a),
      name: () => 0
    }[dashSort] || (() => 0);
    return teams.slice().sort((a, b) => order(a, b) || byName(a, b));
  }

  function projectEmptyCard() {
    const card = el('li', 'card project-empty'); card.dataset.id = 'project-empty';
    const head = el('div', 'card-head');
    const title = el('h3', 'card-title', 'No team for this project yet'); title.id = 'project-empty-title';
    head.append(teamIcon('Project team'), title, badge('Project team', 'kind project'));
    card.setAttribute('aria-labelledby', title.id);
    card.append(head, el('p', 'desc', 'A project team works on this folder and runs with /team:project. Set one up from a team you have, a new one, or a recommendation.'));
    const actions = el('div', 'card-actions');
    actions.append(button('Set up', () => startWizard('project'), { primary: true, label: 'Set up a team for this project', id: 'project-setup' }));
    card.append(actions);
    return card;
  }

  function kindBadge(team) {
    if (team.kind === 'project') return badge('Project team', 'kind project');
    // An imported team runs only once the person approves it; the first run asks.
    if (team.imported && !team.derived) return badge('Imported', 'kind imported', 'Added with Import team. The first time it runs you are asked to approve it.');
    return badge('One of your teams', 'kind', 'Saved in My teams, so you can use it in any project.');
  }

  function teamCard(team) {
    const info = cardInfo(team);
    const key = team.id;
    const card = el('li', 'card dash-card'); card.dataset.id = team.id;
    const head = el('div', 'card-head');
    const title = el('h3', 'card-title', team.name); title.id = nextId('team');
    head.append(teamIcon(team.name, team.icon), title, kindBadge(team));
    // 0.4.27: a private team (marked private, or every member private) runs and is reviewed only on private models.
    if (team.private) head.append(badge('Private', 'kind private', 'Every member runs only on a private model (NEAR TEE or this machine), and Improve with AI uses only a private model.'));
    // A staff section team: who decides in gold, that its members draft in violet (the Staff Room's colours, with words).
    if (team.staff) head.append(badge('Staff ' + team.staff.section.toUpperCase(), 'staff-agent', 'A military staff section team. Its members draft and recommend.'), badge((team.staff.humanLead || 'A named person') + ' decides', 'staff-person', 'Only a named person approves, rejects and releases its products, with the SovAI: Staff commands.'));
    card.setAttribute('aria-labelledby', title.id);
    card.append(head);
    // The status, as words in a pill (never colour alone), and Watch it live while it runs.
    const status = el('p', 'status-line');
    status.append(el('span', 'pill ' + info.status, STATUS_TEXT[info.status] || 'Never run'));
    const cardKey = keyOf(team.id);
    if (info.status === 'running') status.append(button('Watch it live', () => vscode.postMessage({ type: 'watch-live', id: team.id }), { link: true, label: 'Watch ' + team.name + ' live in Team Live', id: 'watch-' + cardKey }));
    card.append(status);
    if (team.error) {
      const problem = el('p', 'error'); problem.append(icon('error'), document.createTextNode(' Needs fixing: ' + team.error));
      card.append(problem);
      const actions = el('div', 'card-actions');
      actions.append(button('Open as Markdown', () => vscode.postMessage({ type: 'open-markdown', id: team.id }), { primary: true, label: 'Open ' + team.name + ' as Markdown to fix it', id: 'fix-' + cardKey }));
      if (team.kind === 'user') actions.append(button('Archive', () => vscode.postMessage({ type: 'archive', id: team.id }), { label: 'Archive ' + team.name, id: 'archive-' + cardKey }));
      card.append(actions);
      return card;
    }
    if (info.attention.length) {
      const reasons = el('ul', 'reasons'); reasons.setAttribute('aria-label', 'Why it needs attention');
      for (const reason of info.attention) { const item = el('li', ''); item.append(icon('warn'), document.createTextNode(' ' + reason)); reasons.append(item); }
      card.append(reasons);
    }
    const open = expandedCards.has(key);
    if (open) card.className += ' expanded';
    const desc = el('p', 'desc clamp', team.description || '');
    desc.id = 'desc-' + keyOf(key);
    card.append(desc);
    // Models: each member's model (or tier) and whether it is private, compact; a model that is not in the model directory is flagged.
    card.append(el('h4', '', 'Models'));
    const models = el('ul', 'member-models'); models.setAttribute('aria-label', 'Members and their models');
    const shownMembers = open ? team.members : team.members.slice(0, MEMBER_CHIPS);
    for (const member of shownMembers) {
      const item = el('li', 'member-model');
      item.append(el('strong', '', member.name), document.createTextNode(' ' + modelLabel(member) + ' · '), el('span', 'privacy-word ' + (member.privacy || 'unknown'), PRIVACY_WORD[member.privacy] || 'Privacy unknown'));
      item.title = (member.role ? member.name + ' (' + member.role + '): ' : member.name + ': ') + (member.model || 'the main model') + '. ' + (member.privacyText || '');
      if (member.available === false) item.append(el('span', 'flag', 'not in the model directory'));
      models.append(item);
    }
    const hiddenMembers = team.members.length - shownMembers.length;
    if (hiddenMembers > 0) models.append(el('li', 'member-model more-chip', '+' + hiddenMembers + ' more'));
    card.append(models);
    if (team.description || hiddenMembers > 0 || open) card.append(moreButton(key, team.name, desc.id, hiddenMembers, (team.description || '').length > CLAMP_CHARS));
    card.append(el('h4', '', 'Activity'), statsBlock(info.stats || NO_STATS));
    const rating = el('div', 'rating');
    rating.append(el('h4', '', 'Rating'), healthBlock(info.health), ratingField(team));
    card.append(rating);
    card.append(el('p', 'meta', team.members.length + ' member' + (team.members.length === 1 ? '' : 's') + (team.savedAt ? ' · saved ' + when(team.savedAt) : '') + (team.command ? ' · ' + team.command.trim() : '')));
    if (flash === team.id) { card.className += ' flash'; pendingFocus = 'open-' + cardKey; }
    const actions = el('div', 'card-actions');
    actions.append(
      button('Open', () => vscode.postMessage({ type: 'open', id: team.id }), { primary: true, label: 'Open ' + team.name, id: 'open-' + cardKey }),
      button('Use in chat', () => vscode.postMessage({ type: 'use-in-chat', id: team.id }), { label: 'Use ' + team.name + ' in chat', id: 'chat-' + cardKey }),
      button('Duplicate', () => vscode.postMessage({ type: 'duplicate', id: team.id }), { label: 'Duplicate ' + team.name, id: 'duplicate-' + cardKey }),
      // Share is the one way to send a team (owner, 2026-11-16): the raw Markdown copy (Export) was dropped. Open as Markdown still shows the file.
      button('Share…', () => vscode.postMessage({ type: 'share', id: team.id }), { label: 'Share ' + team.name, id: 'share-' + cardKey })
    );
    // A team made from a built-in project type can be brought up to date; the host previews every change and asks first.
    if (team.update) actions.append(button(team.update.available ? 'Update team…' : 'Check for updates…', () => vscode.postMessage({ type: 'update-team', id: team.id }), { label: (team.update.available ? 'Update ' : 'Check for updates to ') + team.name + ' (' + team.update.template + ' template' + (team.update.from ? ' v' + team.update.from : '') + (team.update.available ? ' → v' + team.update.to : '') + ')', id: 'update-' + cardKey }));
    if (team.kind === 'user') actions.append(button('Archive', () => vscode.postMessage({ type: 'archive', id: team.id }), { label: 'Archive ' + team.name, id: 'archive-' + cardKey }));
    card.append(actions);
    return card;
  }

  /** "glm-5.3 (deep)": the model's own name, and the tier it comes from when it is one. */
  function modelLabel(member) {
    const short = String(member.model || '').split('/').pop() || 'the main model';
    const tier = member.tier === 'deep' || member.tier === 'standard' || member.tier === 'fast' ? ' (' + member.tier + ')' : member.tier === 'inherit' ? ' (main model)' : '';
    return short + tier;
  }

  /** Runs, last run, success, average time and spend, from the project's run history; none yet or not recorded where there is no record. */
  function statsBlock(stats) {
    if (!dash || !dash.history) return el('p', 'hint small', NO_HISTORY);
    const list = el('dl', 'stats');
    const row = (label, value, title) => { const wrap = el('div', 'stat'); wrap.append(el('dt', '', label), el('dd', '', value)); if (title) wrap.title = title; list.append(wrap); };
    const none = 'none yet';
    row('Runs', stats.runs ? String(stats.runs) : none, 'Runs started with this team\'s /team: command in this project.');
    row('Last run', stats.lastRunAt ? ago(stats.lastRunAt) : 'never', stats.lastRunAt ? when(stats.lastRunAt) : '');
    row('Success', stats.ended ? Math.round(100 * (stats.successRate || 0)) + '% (' + stats.completed + ' of ' + stats.ended + ')' : stats.runs ? 'none ended yet' : none, 'Completed, out of the runs that ended (failed, stopped or cancelled count against it).');
    row('Average time', typeof stats.averageMs === 'number' ? duration(stats.averageMs) : none);
    row('Spend', !stats.runs ? none : typeof stats.spendUsd === 'number' ? money(stats.spendUsd) + ' total, ' + money(stats.perRunUsd || 0) + ' a run' : 'not recorded', typeof stats.spendUsd === 'number' && stats.costedRuns < stats.runs ? 'Recorded for ' + stats.costedRuns + ' of ' + stats.runs + ' runs.' : 'What the runs cost, from the spend ledger.');
    return list;
  }

  /** The computed health and the parts it is made of. */
  function healthBlock(health) {
    const box = el('div', 'health');
    const score = health && typeof health.score === 'number' ? health.score : null;
    const line = el('p', 'health-score');
    line.append(el('span', 'label', 'Health'), el('strong', '', score === null ? 'not known' : score + ' out of 100'));
    box.append(line);
    const parts = el('ul', 'health-parts');
    for (const part of (health && health.parts) || []) parts.append(el('li', '', part.label + ': ' + (typeof part.score === 'number' ? part.score + '. ' : '') + part.detail));
    if (parts.children.length) box.append(parts);
    return box;
  }

  /**
   * The person's own 1 to 5 stars: native radio buttons in a fieldset, so it is one Tab stop, the arrow keys move between the stars, and a screen reader
   * says each one. A choice is shown at once and sent when it settles, so arrowing past two stars to the third writes one version of the team file.
   */
  function ratingField(team) {
    const key = keyOf(team.id);
    const current = ratingOf(team);
    const group = el('fieldset', 'stars');
    group.append(el('legend', '', 'Your rating'));
    const hintId = 'rate-hint-' + key;
    group.setAttribute('aria-describedby', hintId);
    const name = 'rate-' + key;
    for (let value = 0; value <= 5; value += 1) {
      const radio = el('input'); radio.type = 'radio'; radio.name = name; radio.value = String(value); radio.id = name + '-' + value; radio.checked = value === current;
      const label = el('label', 'star' + (value === 0 ? ' none' : '') + (value && value <= current ? ' on' : '')); label.setAttribute('for', radio.id);
      if (value === 0) label.append(document.createTextNode('No rating'));
      // A filled star or an outline one, so the rating never rests on colour alone (high contrast themes included).
      else { const glyph = el('span', 'glyph', value <= current ? '★' : '☆'); glyph.setAttribute('aria-hidden', 'true'); label.append(glyph, el('span', 'visually-hidden', value + (value === 1 ? ' star' : ' stars'))); }
      radio.addEventListener('change', () => { if (radio.checked) chooseRating(team, value, group); });
      group.append(radio, label);
    }
    const hint = el('p', 'hint small', 'Only yours: kept on this computer, never in the team file or the project.'); hint.id = hintId;
    group.append(hint);
    return group;
  }

  /** Shows `value` stars in a card's star group, in place: the radio checked, the stars lit (filled) up to it. Focus is not touched. */
  function paintStars(group, value) {
    for (const node of group.children) {
      const tag = String(node.tagName).toLowerCase();
      if (tag === 'input') { node.checked = Number(node.value) === value; continue; }
      if (tag !== 'label') continue;
      const stars = Number((node.getAttribute('for') || '').split('-').pop());
      const base = node.className.replace(/\s*\bon\b/g, '');
      const lit = Boolean(stars && stars <= value);
      node.className = lit ? base + ' on' : base;
      const glyph = node.children && node.children[0];
      if (stars && glyph && glyph.className === 'glyph') glyph.textContent = lit ? '★' : '☆';
    }
  }

  /**
   * The teams listed again with only ratings changed (the host's answer to a rating): each card's stars are updated in place, so the page is not drawn
   * again under the person and focus stays exactly where it is (PR 86 review, round 4). Sorted by rating the cards move, so the page is drawn again.
   */
  function onlyRatingsChanged(next) {
    if (work || dashSort === 'rating' || !next || !Array.isArray(next.teams)) return false;
    const strip = (state) => JSON.stringify({ teams: (state.teams || []).map((team) => Object.assign({}, team, { rating: undefined })), archived: state.archived || [] });
    return strip(next) === strip(lib);
  }
  function repaintRatings() {
    for (const team of lib.teams) {
      const radio = $('rate-' + keyOf(team.id) + '-0');
      const group = radio && (radio.parentElement || radio.parentNode || radio.parent);
      if (group) paintStars(group, ratingOf(team));
    }
  }

  function chooseRating(team, value, group) {
    pendingRating.set(team.id, value);
    ratingQueue.set(team.id, value);
    // The stars light up at once, in place, so focus stays on the star the person is on.
    paintStars(group, value);
    if (ratingTimer) clearTimeout(ratingTimer);
    ratingTimer = setTimeout(sendRatings, 300);
  }

  /** Sends the ratings waiting for their choice to settle. Also when the tab is hidden or closed, so a star chosen just before is not lost. */
  function sendRatings() {
    if (ratingTimer) { clearTimeout(ratingTimer); ratingTimer = null; }
    for (const [id, rating] of ratingQueue) vscode.postMessage({ type: 'rate', id, rating });
    ratingQueue.clear();
  }
  window.addEventListener('pagehide', () => sendRatings());
  if (typeof document.addEventListener === 'function') document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') sendRatings(); });

  // ---------- sections shared by the wizard and the editor ----------
  // The team as a picture: who answers to whom, and a card for each member. It reads the saved team, not the unsaved draft, and says so, so a card
  // never claims to describe a change that has not been saved.
  function sectionShape(root) {
    root.append(el('p', 'hint', 'The saved team, as it is written. Click a member for its card: what it is for, what it can do, and what to expect from it.'));
    if (currentLive) {
      const live = el('p', 'hint');
      live.append('This team is running now. ', button('Watch it live', () => vscode.postMessage({ type: 'watch-live' }), { link: true, label: 'Watch this team work live in Team Live' }));
      root.append(live);
    }
    const lax = el('div', 'graph'); lax.id = 'graph';
    const card = el('section', 'member-card');
    card.id = 'member-card'; openCard = null;
    card.setAttribute('aria-live', 'polite');
    root.append(lax, card);
    renderGraph(lax);
    renderCard();
    if (!currentGraph) root.append(el('p', 'hint', 'This team has no saved shape yet. Save it, then come back.'), el('p', 'hint', 'A card shows what a member is for, what it can do from its tools, and what it reports back.'));
  }

  function sectionPurpose(root) {
    const draft = work.draft;
    const nameInput = input(draft.name, (value) => { draft.name = value.replace(/[\r\n]+/g, ' '); renderHeaderName(); renderWizardIcon(); changed(false); }, { id: 'f-name', maxlength: '80', autocomplete: 'off' });
    const nameField = field('Team name', nameInput, work.mode === 'editor' ? 'Renaming keeps the file and its /team: command.' : isClone() ? 'Shown in the library and when the team runs. A copy needs a name no other team has.' : 'Shown in the library and when the team runs.');
    root.append(nameField);
    // The team's own name problems, under the field (a name another team has, or none): the host's words, from its review.
    if (work.mode === 'wizard') {
      const slot = reviewSlot(nameField, 'team', undefined, ['name']);
      slot.id = 'f-name-issues';
      nameInput.setAttribute('aria-describedby', [nameInput.getAttribute('aria-describedby'), slot.id].filter(Boolean).join(' '));
    }
    root.append(field('What the team is for', textarea(draft.description, (value, node) => { const clean = value.replace(/[\r\n]+/g, ' '); if (clean !== value) node.value = clean; draft.description = clean; changed(false); }, 2, 'f-desc'), 'One or two sentences. The lead agent reads this.'));
    root.append(privateToggle(draft));
    if (work.mode === 'editor') root.append(iconField());
    if (work.mode !== 'wizard') return;
    root.append(wizardIconField());
    const where = el('fieldset', 'choices');
    where.append(el('legend', '', 'Save it as'));
    [['project', 'This project\'s team', 'Saved in .planning/.near-ai/team.md; run with /team:project.'], ['user', 'One of my teams', 'Reusable in any project; run with /team:<name>.']].forEach(([value, label, hint]) => {
      const option = el('label', 'choice' + (work.target === value ? ' selected' : ''));
      const radio = el('input'); radio.type = 'radio'; radio.name = 'target'; radio.value = value; radio.checked = work.target === value; radio.id = 'target-' + value;
      if (value === 'project' && !(ctx && ctx.hasProject)) { radio.disabled = true; hint = 'Open a project folder to save a project team.'; }
      radio.addEventListener('change', () => { work.target = value; render(); });
      option.append(radio, el('span', 'choice-label', label), el('span', 'hint', hint));
      where.append(option);
    });
    root.append(where);
    if ((work.startingPoint || '').startsWith('type:')) root.append(el('p', 'hint', 'Saving this as the project team also writes this project type\'s guidance to AGENTS.md (plan, execute, red team, verify, audit, release).'));
  }

  /**
   * The new team's icon in the builder: always the default (its initials on a colour), never the icon of a team it was cloned from. Upload and Generate
   * are on the saved team's Purpose tab, so this is only the preview and a line saying so. The preview follows the name as it is typed.
   */
  function wizardIconField() {
    const wrap = el('div', 'field icon-field');
    const heading = el('span', 'field-label', 'Team icon'); heading.id = 'icon-label';
    // The heading names the preview and its line (PR #94 review: its id was never used).
    wrap.setAttribute('role', 'group'); wrap.setAttribute('aria-labelledby', heading.id);
    const row = el('div', 'icon-row');
    const slot = el('span', 'icon-slot'); slot.id = 'icon-preview-slot';
    const hint = el('p', 'hint', isClone()
      ? 'The new team starts with the default icon (its initials on a colour), not the icon of the team you copied. After you save it, upload a picture or generate one on its Purpose tab.'
      : 'The new team starts with the default icon (its initials on a colour). After you save it, upload a picture or generate one on its Purpose tab.');
    hint.id = 'icon-preview-hint';
    row.append(slot, hint);
    wrap.append(heading, row);
    fillWizardIcon(slot);
    return wrap;
  }
  function fillWizardIcon(slot) {
    const preview = teamIcon(work.draft.name || 'this team', null, true, 'large');
    preview.id = 'icon-preview';
    preview.setAttribute('aria-describedby', 'icon-preview-hint');
    slot.replaceChildren();
    slot.append(preview);
  }
  /** Typing the name repaints only the preview, as renderHeaderName does for the breadcrumb, so the name field keeps its focus and caret. */
  function renderWizardIcon() {
    if (!work || work.mode !== 'wizard') return;
    const slot = $('icon-preview-slot');
    if (slot) fillWizardIcon(slot);
  }

  /**
   * The saved team's icon (0.4.30): Upload (VS Code's file picker; the host checks the picture and this page makes it a 128 x 128 PNG), Generate with AI
   * (offered when an image model may be used for this team; the cost is asked first), and Remove (back to the default). One request at a time.
   */
  function iconField() {
    const name = work.draft.name || 'this team';
    const wrap = el('div', 'field icon-field');
    const heading = el('span', 'field-label', 'Team icon'); heading.id = 'icon-label';
    const row = el('div', 'icon-row');
    const preview = teamIcon(name, work.icon, true, 'large'); preview.id = 'icon-preview';
    const actions = el('div', 'actions'); actions.setAttribute('role', 'group'); actions.setAttribute('aria-labelledby', 'icon-label');
    const busy = Boolean(work.iconBusy);
    const ai = work.iconAi || { available: false, reason: 'Checking whether an image model can be used…' };
    actions.append(button('Upload icon…', () => iconRequest('icon-upload'), { id: 'icon-upload', label: 'Upload an icon for ' + name + ' (PNG, JPEG or WebP)', disabled: busy }));
    const generate = button('Generate with AI…', () => iconRequest('icon-generate'), { id: 'icon-generate', label: 'Generate an icon for ' + name + ' with AI', disabled: busy || !ai.available });
    actions.append(generate);
    if (work.icon) actions.append(button('Remove icon', () => iconRequest('icon-remove'), { id: 'icon-remove', label: 'Remove the icon of ' + name + ' and use the default', link: true, disabled: busy }));
    row.append(preview, actions);
    wrap.append(heading, row);
    wrap.append(el('p', 'hint', 'PNG, JPEG or WebP, up to 2 MB. It is cropped to a square and saved as a 128 x 128 PNG beside the team file. Without one, the team shows its initials.'));
    const why = el('p', 'hint', ai.available ? 'Generate with AI sends the team\'s name and what it is for to ' + ai.model + (ai.private ? ', a private model' : '') + (ai.estimate ? ' (' + ai.estimate + ')' : '') + '. You are asked first.' : 'Generate with AI: ' + (ai.reason || 'not available here.'));
    why.id = 'icon-generate-hint'; generate.setAttribute('aria-describedby', why.id);
    wrap.append(why);
    if (busy) { const working = el('p', 'hint', 'Working on the icon…'); working.setAttribute('role', 'status'); wrap.append(working); }
    return wrap;
  }

  function iconRequest(type) {
    if (!work || work.mode !== 'editor' || work.iconBusy) return;
    work.iconBusy = true;
    vscode.postMessage({ type, id: work.id });
    render();
  }

  /** The picture the host checked, made into the icon: the centre square, scaled to 128 x 128, encoded as a PNG of at most 64 KB. */
  /** A picture that is still larger than an icon may be after its colours were simplified: too detailed, not unreadable (PR #82 review). */
  class IconTooDetailed extends Error {}

  async function normaliseIcon(mime, data) {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
    try {
      const side = Math.min(bitmap.width, bitmap.height);
      if (!side) throw new Error('empty image');
      const canvas = document.createElement('canvas');
      canvas.width = ICON_SIZE; canvas.height = ICON_SIZE;
      const context = canvas.getContext('2d');
      context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
      context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, ICON_SIZE, ICON_SIZE);
      // A busy photo can still be larger than an icon may be: its colours are simplified a step at a time until it fits.
      for (const step of [0, 8, 16, 32]) {
        if (step) {
          const image = context.getImageData(0, 0, ICON_SIZE, ICON_SIZE);
          for (let index = 0; index < image.data.length; index += 1) image.data[index] = Math.min(255, Math.round(image.data[index] / step) * step);
          context.putImageData(image, 0, 0);
        }
        const uri = canvas.toDataURL('image/png');
        const encoded = uri.slice(uri.indexOf(',') + 1);
        if (/^data:image\/png;base64,/.test(uri) && Math.floor(encoded.length * 3 / 4) <= MAX_ICON_BYTES) return encoded;
      }
      throw new IconTooDetailed();
    } finally { if (bitmap.close) bitmap.close(); }
  }

  // The team's own private marking (owner, 2026-11-16): every member runs only on a private model, and the team is sent only to a private model when the
  // studio asks AI about it. A team whose members are all private counts as private even unticked, which the hint says.
  function privateToggle(draft) {
    const wrap = el('div', 'field check-field');
    // A hand-written privacy: tee or local line keeps the team private and is the person's to change in the file: the box reflects only the value it
    // writes (private), and is disabled (PR #69 review: unticking used to delete such a line).
    const written = work && work.teamPrivacy;
    const box = el('input'); box.type = 'checkbox'; box.id = 'f-private'; box.checked = draft.private === true && !written; box.disabled = Boolean(written);
    box.addEventListener('change', () => { if (box.checked) draft.private = true; else delete draft.private; changed(false); });
    const label = el('label', 'check'); label.setAttribute('for', box.id);
    label.append(box, document.createTextNode(' Private team'));
    const allPrivate = draft.members.length > 0 && draft.members.every((member) => member.privacy === 'private');
    const hint = el('p', 'hint', written
      ? 'This team\'s file says privacy: ' + written + ', which keeps every member on a private model. Change that line in the Markdown file to change it.'
      : 'Every member runs only on a private model (a NEAR TEE model or one on this machine), and Improve with AI sends this team only to a private model.' + (allPrivate && !box.checked ? ' Every member is already private, so the team counts as private.' : ''));
    hint.id = 'f-private-hint'; box.setAttribute('aria-describedby', hint.id);
    wrap.append(label, hint);
    return wrap;
  }

  /** The picker's entries from the host; before the first state arrives, the built-in starting points. */
  function pickerEntries() {
    if (picker) return picker;
    // Names come from the host (PR #75 review): the page has no naming rules of its own, so what it shows is what the host saves.
    return (ctx ? ctx.startingPoints : []).map((point) => ({ id: point.id, source: 'builtin', group: point.group, label: point.label, name: point.name || point.label, description: point.description, members: point.members, memberCount: point.members.length, origin: 'Built in' }));
  }
  /**
   * The teams the picker offers under the current filter. "Start empty" is not a team: From scratch is its own choice now. The recommendation is not
   * either: it is made from answers, on its own screen (0.4.30), so it is never offered twice.
   */
  const inPicker = (entry) => entry.id !== 'empty' && entry.id !== 'recommend';
  function visibleEntries() {
    return pickerEntries().filter((entry) => inPicker(entry) && (pickerFilter === 'all' || entry.source === pickerFilter));
  }
  const entryName = (entry) => entry.name || entry.label;

  // ---------- the screens before the steps ----------
  function startChoices(items) {
    const list = el('div', 'start-choices'); list.setAttribute('role', 'group'); list.setAttribute('aria-labelledby', 'step-heading');
    for (const [id, label, hint, onClick] of items) {
      const node = el('button', 'start-choice'); node.type = 'button'; node.id = id;
      node.setAttribute('aria-label', label);
      const note = el('span', 'hint', hint); note.id = id + '-hint';
      node.setAttribute('aria-describedby', note.id);
      node.append(el('span', 'choice-label', label), note);
      node.addEventListener('click', onClick);
      list.append(node);
    }
    return list;
  }

  function renderStart(root) {
    const titles = { start: 'How do you want to start?', new: 'Create a new team', recommend: 'Recommend a team for me', ai: 'Describe it, and AI drafts it', pick: work.pickMode === 'existing' ? 'Use an existing team' : 'Clone an existing team' };
    if (work.stage === 'start' || work.stage === 'new') { const waiting = draftWaiting(); if (waiting) root.append(waiting); }
    const panel = el('section', 'panel start'); panel.setAttribute('aria-labelledby', 'step-heading');
    const heading = el('h2', '', titles[work.stage]); heading.id = 'step-heading'; heading.setAttribute('tabindex', '-1');
    panel.append(heading);
    if (work.stage === 'start') {
      panel.append(el('p', 'hint', 'Use a team that already exists, make a new one with its own name, or let the studio suggest one.'));
      panel.append(startChoices([
        ['start-existing', 'Use an existing team', 'One of your saved teams, or one the extension provides. Use it as it is, or clone it and change it.', () => goStage('pick', 'existing')],
        ['start-new', 'Create a new team', 'Give it a name and its members: from scratch, or from a copy of an existing team.', () => goStage('new')],
        ['start-recommend', 'Recommend a team for me', 'Answer a few questions about the work. The studio suggests a team sized to it; use it as it is, or clone it and change it.', () => goStage('recommend')]
      ]));
    } else if (work.stage === 'new') {
      panel.append(el('p', 'hint', 'A new team gets its own name, and you choose where to save it.'));
      panel.append(startChoices([
        ['new-scratch', 'From scratch', work.draft.members.length && !work.cloned ? 'Keep the ' + work.draft.members.length + ' member' + (work.draft.members.length === 1 ? '' : 's') + ' your team has now, and add or remove any yourself.' : 'Start with no members and add each one yourself.', startFromScratch],
        ['new-clone', 'Clone an existing team', 'Start from a copy of one of your teams or a built-in one, then change it.', () => goStage('pick', 'clone')],
        ['new-ai', 'Describe it, and AI drafts it', 'Say what the team should produce. AI proposes a team for you to look over before anything is saved.', describeToAi]
      ]));
    } else if (work.stage === 'recommend') sectionRecommend(panel);
    else if (work.stage === 'ai') {
      // The AI start (owner, 2026-11-17: moved off the main page, which is a dashboard now): what the team should produce, then the proposal it drafted.
      panel.append(el('p', 'hint', 'One model call drafts the team. You see it, and can start over, before anything is saved.'));
      panel.append(askSection());
      if (proposal) panel.append(proposalSection());
    } else sectionPicker(panel);
    root.append(panel);
    const footer = el('div', 'footer');
    if (work.stage !== 'start') footer.append(button('Back', () => {
      // Back from the AI start: Create a new team, and a draft made after that is one of the person's teams unless they come back this way.
      if (work.stage === 'ai') { askTarget = 'user'; goStage('new'); return; }
      goStage(work.stage === 'pick' && work.pickMode === 'clone' ? 'new' : 'start');
    }, {}));
    footer.append(button('Cancel', leaveWork, { link: true }));
    root.append(footer);
  }

  /** The existing teams: the person's saved teams and the built-in ones, filtered and grouped. A selected team shows what can be done with it. */
  function sectionPicker(root) {
    const existing = work.pickMode === 'existing';
    root.append(el('p', 'hint', existing ? 'Pick a team. Use it as it is, or clone it into a new team and change it.' : 'Pick the team to copy. You name the copy, and can change everything in it before it is saved.'));
    const entries = pickerEntries().filter(inPicker);
    // All, My teams (saved from any project) or Built-in (provided by the extension).
    const filter = el('div', 'picker-filter'); filter.setAttribute('role', 'radiogroup'); filter.setAttribute('aria-label', 'Show teams');
    for (const [value, label] of PICKER_FILTERS) {
      const count = entries.filter((entry) => value === 'all' || entry.source === value).length;
      const option = el('label', 'filter' + (pickerFilter === value ? ' selected' : ''));
      const radio = el('input'); radio.type = 'radio'; radio.name = 'picker-filter'; radio.value = value; radio.checked = pickerFilter === value; radio.id = 'picker-filter-' + value;
      radio.addEventListener('change', () => {
        pickerFilter = value;
        // The selected team stays selected only while it is shown, so its buttons never act on a team the person cannot see.
        if (work.pick && !visibleEntries().some((entry) => entry.id === work.pick)) work.pick = null;
        render();
      });
      option.append(radio, el('span', '', label + ' (' + count + ')'));
      filter.append(option);
    }
    root.append(filter);
    const groups = [['library', 'My teams'], ['project-type', 'For this kind of project'], ['gsd', 'Built from Open-GSD roles']];
    const visible = visibleEntries();
    if (pickerFilter === 'mine' && !visible.length) root.append(el('p', 'hint empty-picker', NO_SAVED_TEAMS));
    // The radios share one name, so they are one group to the keyboard and a screen reader; the selected team's buttons and answers sit beside them.
    const list = el('div', 'starting'); list.setAttribute('role', 'group'); list.setAttribute('aria-label', 'Teams');
    for (const [group, title] of groups) {
      const points = visible.filter((point) => point.group === group);
      if (!points.length) continue;
      list.append(el('h4', '', title));
      const grid = el('div', 'choice-grid');
      for (const point of points) {
        const selected = work.pick === point.id;
        const key = 'pick:' + point.id;
        const open = expandedCards.has(key);
        const cell = el('div', 'choice-cell' + (selected ? ' selected' : '') + (open ? ' expanded' : ''));
        const option = el('label', 'choice' + (selected ? ' selected' : ''));
        const radio = el('input'); radio.type = 'radio'; radio.name = 'starting-point'; radio.value = point.id; radio.checked = selected; radio.id = 'pick-' + point.id.replace(/[^a-z0-9-]/g, '-');
        // What the team is for belongs to the team it was typed for (PR #75 review): choosing another one starts it empty.
        radio.addEventListener('change', () => { if (work.pick !== point.id) work.options.goal = ''; work.pick = point.id; render(); });
        const label = el('span', 'choice-label');
        // A saved team's icon comes with the library listing (sent once, not again for the picker); built-in teams show the default.
        const listed = point.teamId ? (lib.teams || []).find((team) => team.id === point.teamId) : null;
        label.append(teamIcon(entryName(point), listed ? listed.icon : null), document.createTextNode(point.label));
        option.append(radio, label);
        if (point.origin) option.append(badge(point.origin, point.imported ? 'kind imported' : 'kind'));
        const descId = 'pdesc-' + point.id.replace(/[^A-Za-z0-9_-]/g, '-');
        const desc = el('span', 'hint clamp', point.description || ''); desc.id = descId;
        option.append(desc);
        // The same rule as a library card (PR #82 review): the first four members, then a count of the rest; Show more lists them all.
        const shownMembers = open ? point.members : point.members.slice(0, MEMBER_CHIPS);
        const hiddenMembers = point.members.length - shownMembers.length;
        if (point.members.length) option.append(el('span', 'hint small', point.memberCount + ' member' + (point.memberCount === 1 ? '' : 's') + ': ' + shownMembers.join(', ') + (hiddenMembers > 0 ? ' +' + hiddenMembers + ' more' : '')));
        cell.append(option);
        // Beside the choice, not inside its label, so opening a card never selects the team.
        if (point.description || point.members.length) cell.append(moreButton(key, entryName(point), descId, hiddenMembers, (point.description || '').length > CLAMP_CHARS));
        // A saved team can be shared from here too (one portable file to send; the host checks it and asks about the knowledge graph).
        if (point.teamId) cell.append(button('Share…', () => vscode.postMessage({ type: 'share', id: point.teamId }), { link: true, label: 'Share ' + point.label }));
        if (selected) cell.append(pickActions(point));
        grid.append(cell);
      }
      list.append(grid);
    }
    root.append(list);
  }

  /**
   * What can be done with the selected team. A built-in team is made from a few answers (what it is for and where its models run), so those are asked
   * here, before Use as is or Clone and modify, and nothing else is. (The recommendation's own questions are on its screen, sectionRecommend.)
   */
  function pickActions(point) {
    const box = el('div', 'pick-details');
    if (point.source === 'builtin') {
      const fields = el('div', 'inline-fields');
      fields.append(goalField(), localityField());
      box.append(fields);
    }
    pickButtons(box, point, work.pickMode === 'existing');
    return box;
  }

  const goalField = (onInput) => field('What the team is for', input(work.options.goal, (value) => { work.options.goal = value.replace(/[\r\n]+/g, ' '); if (onInput) onInput(); }, { id: 'f-goal', maxlength: '400', autocomplete: 'off' }), 'Optional. It is written into the members\' instructions.');
  const localityField = (onChange) => field('Where models may run', select([{ value: 'cloud', label: 'NEAR AI Cloud' }, { value: 'local', label: 'Local runtime only' }, { value: 'hybrid', label: 'Both' }], work.options.locality, (value) => { work.options.locality = value; if (onChange) onChange(); }, 'f-locality'));

  /** Use as is (when using an existing team) and Clone and modify for a team, with what each will do. */
  function pickButtons(box, point, existing) {
    const name = entryName(point);
    const actions = el('div', 'actions');
    if (existing) actions.append(button('Use as is', () => useAsIs(point), { primary: true, label: 'Use ' + name + ' as is', id: 'use-as-is', disabled: work.busy }));
    actions.append(button('Clone and modify', () => cloneEntry(point), { primary: !existing, label: 'Clone ' + name + ' and modify it', id: 'clone-team', disabled: work.busy }));
    if (work.busy) { box.setAttribute('aria-busy', 'true'); actions.append(el('span', 'hint', 'Waiting for the answer…')); }
    box.append(actions);
    if (existing) {
      box.append(el('p', 'hint', ctx && ctx.hasProject
        ? 'Use as is makes it this project\'s team (run it with /team:project) without changing it. If the project already has a team, you are asked first, and the old one stays in its history.'
        : point.source === 'builtin' ? (point.saveAs ? 'Use as is saves it to My teams as "' + point.saveAs + '" and opens it in chat.' : 'Use as is saves it to My teams under its own name and opens it in chat.') : 'Use as is opens it in chat.'));
    }
    const count = work.draft.members.length;
    if (count) box.append(el('p', 'hint', 'Clone and modify replaces the ' + count + ' member' + (count === 1 ? '' : 's') + ' your team has now.'));
    if (point.id.startsWith('type:')) box.append(el('p', 'hint', 'As this project\'s team it also writes this project type\'s guidance to AGENTS.md (plan, execute, red team, verify, audit, release).'));
  }

  // ---------- Recommend a team for me (0.4.30: moved from the picker to the first screen) ----------
  let recommendSeq = 0;

  /** The answers changed: a team shown for the old ones no longer applies, so it is cleared (and the person is told) until recommended again. */
  // PR #82 review, round 2: every change of an answer ends the request in flight too (its reply is for the old answers), not only a team already shown;
  // a reply is taken only when its number and its answers match the answers on screen; and Use as is and Clone send the answers the shown team was made
  // from, never whatever the fields hold now.
  const currentAnswers = () => ({ goal: work.options.goal.slice(0, 400), locality: work.options.locality, workShape: work.options.workShape, riskLevel: work.options.riskLevel });
  const sameAnswers = (one, two) => Boolean(one && two) && ['goal', 'locality', 'workShape', 'riskLevel'].every((key) => one[key] === two[key]);

  function answersChanged(redraw) {
    const waiting = work.recommendSeq !== null;
    if (waiting) { work.recommendSeq = null; work.busy = false; work.busyFor = null; }
    if (!work.recommendation && !waiting) return;
    work.recommendation = null;
    work.recommendStale = true;
    // A request that was waiting had its button off: draw the screen again so Recommend works at once.
    if (redraw || waiting) { render(); return; }
    // While typing: the shown team is replaced in place, so the field keeps its caret.
    const box = $('recommendation');
    if (box) box.replaceChildren(el('p', 'hint', STALE_RECOMMENDATION));
  }
  const STALE_RECOMMENDATION = 'Your answers changed. Recommend again to see the team for them.';

  function sectionRecommend(root) {
    root.append(el('p', 'hint', 'Answer these about the work. The studio suggests a team sized to it, and shows it before anything is saved.'));
    const fields = el('div', 'inline-fields');
    fields.append(field('Kind of work', select(['feature', 'bugfix', 'refactor', 'research', 'release'].map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1) })), work.options.workShape, (value) => { work.options.workShape = value; answersChanged(true); }, 'f-shape')));
    fields.append(field('Risk', select([{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High (adds a security member)' }], work.options.riskLevel, (value) => { work.options.riskLevel = value; answersChanged(true); }, 'f-risk')));
    fields.append(localityField(() => answersChanged(true)), goalField(() => answersChanged(false)));
    root.append(fields);
    const actions = el('div', 'actions');
    actions.append(button('Recommend a team', requestRecommendation, { primary: !work.recommendation, id: 'recommend-go', disabled: work.busy }));
    if (work.busy && work.recommendSeq !== null) actions.append(el('span', 'hint', 'Waiting for the answer…'));
    root.append(actions);
    const result = el('section', 'recommendation'); result.id = 'recommendation'; result.setAttribute('aria-live', 'polite');
    const shown = work.recommendation;
    if (shown) {
      const title = el('h3', '', shown.name); title.id = 'recommendation-title';
      result.setAttribute('aria-labelledby', title.id);
      const head = el('div', 'card-head');
      head.append(teamIcon(shown.name), title, badge('Built in', 'kind'));
      result.append(head);
      if (shown.description) result.append(el('p', 'desc', shown.description));
      result.append(el('p', 'meta', shown.members.length + ' member' + (shown.members.length === 1 ? '' : 's')));
      const chips = el('ul', 'chips'); chips.setAttribute('aria-label', 'Members');
      for (const member of shown.members) chips.append(el('li', 'chip', member.name + (member.role && member.role !== member.name ? ' · ' + member.role : '')));
      result.append(chips);
      const point = { id: 'recommend', source: 'builtin', name: shown.name, ...(shown.saveAs ? { saveAs: shown.saveAs } : {}), members: shown.members.map((member) => member.name), answers: shown.answers };
      pickButtons(result, point, true);
    } else if (work.recommendStale) result.append(el('p', 'hint', STALE_RECOMMENDATION));
    root.append(result);
  }

  /** One request at a time; the reply is matched by its number, so one for an older request or a screen the person left is dropped. */
  function requestRecommendation() {
    if (work.busy) return;
    recommendSeq += 1;
    work.recommendSeq = recommendSeq;
    waitFor('recommend');
    vscode.postMessage(Object.assign({ type: 'recommend', seq: recommendSeq }, currentAnswers()));
    render();
  }

  function startAnswers(point, message) {
    if (point.source !== 'builtin') return message;
    // The recommendation shown carries the answers it was made from, and sends exactly those (it is never offered without them: sectionRecommend).
    if (point.answers) return Object.assign(message, point.answers);
    message.goal = work.options.goal.slice(0, 400);
    message.locality = work.options.locality;
    return message;
  }

  /**
   * The number of the request Use as is and Clone and modify wait on (PR #75 review): a starting point's reply (or its error) frees them only when it
   * answers that request, so the reply to a Clone the person left behind cannot free them while a Use as is is still being answered.
   */
  let startSeq = 0;
  function waitFor(kind) {
    startSeq += 1;
    work.busy = true;
    work.busyFor = kind + ':' + startSeq;
    return startSeq;
  }

  /** Use as is: the host makes it this project's team, or puts it in the chat. Unsaved work in the builder is only dropped after the host asks. */
  function useAsIs(point) {
    if (work.busy) return;
    const message = startAnswers(point, { type: 'use-team', id: point.id });
    if (isWizardDirty()) message.discard = true;
    // Nothing is announced yet (PR #75 review): the host may still ask, or refuse. Its answer (the team, used, declined, or an error) is announced.
    vscode.postMessage(message);
    // Until the host answers, Use as is and Clone and modify wait, so a double click sends one request.
    waitFor('use');
    render();
  }

  /** Clone and modify: the host sends the team's members, and the Purpose step opens with the copy's name and description filled in. */
  function cloneEntry(point) {
    if (work.busy) return;
    const label = entryName(point);
    // The recommendation is cloned on its own screen; its path is `existing`, which a 0.4.29 build also reads, and Back finds its screen from the starting
    // point (backFromPurpose).
    const seq = waitFor('start');
    work.awaitingStart = { id: point.id, seq, clone: true, stage: work.stage, path: work.stage === 'recommend' || work.pickMode === 'existing' ? 'existing' : 'clone', label, goal: point.answers ? point.answers.goal : point.source === 'builtin' ? work.options.goal : '' };
    const message = startAnswers(point, { type: 'starting-point', id: point.id, goal: '', locality: work.options.locality, seq });
    vscode.postMessage(message);
    render();
  }

  /** From scratch: no members. Members, a name and a description that a clone filled in are cleared; anything the person wrote is kept. */
  function startFromScratch() {
    if (work.cloned) {
      work.draft.members = [];
      if (work.cloned.name !== undefined && work.draft.name === work.cloned.name) work.draft.name = work.defaultName;
      if (work.cloned.description !== undefined && work.draft.description === work.cloned.description) work.draft.description = '';
      work.cloned = null;
    }
    work.startingPoint = 'empty';
    work.projectType = null;
    work.path = 'scratch';
    work.stage = 'steps';
    work.step = 0;
    focusLater('step-heading');
    render();
    requestReview();
  }

  /**
   * Describe it, and AI drafts it: the AI start, a screen of the builder (0.4.31: it was a box on the main page). A team drafted here is saved where this
   * builder saves. With unsaved work the host asks first: the work is dropped (or kept as a draft) and a fresh builder opens on this screen.
   */
  function describeToAi() {
    if (isWizardDirty()) { pendingAsk = work.target; leaveWork(); return; }
    askTarget = work.target;
    goStage('ai', null, 'ask-idea');
  }

  /** A fresh builder on the AI start, saving to `target`. */
  function openAiStage(target) {
    startWizard(target);
    askTarget = work.target;
    goStage('ai', null, proposal ? 'proposal-title' : 'ask-idea');
  }

  /** A drafted team that arrived after the person left the AI start: back to it, unless something unsaved is open. */
  /**
   * Review it (PR 86 review, round 2: a drafted team waiting for review is state, not a banner). With unsaved work open the host asks first, as leaving
   * does (Discard changes, or Save draft / Save); staying keeps both the work and the waiting team, and leaving opens the AI start on it.
   */
  function reviewDrafted() {
    const target = work && work.mode === 'wizard' ? work.target : askTarget;
    if (isDirty() || isWizardDirty()) { pendingAsk = target; leaveWork(); return; }
    openAiStage(target);
  }

  function discardDrafted() {
    proposal = null;
    vscode.postMessage({ type: 'proposal-done' });
    announce('The drafted team was discarded.');
    focusMain();
    render();
  }

  /** Where a drafted team waits: on the main page and the New team screens, until it is used or discarded. Never a banner, which another can replace. */
  function draftWaiting() {
    if (!proposal || drafting) return null;
    const box = el('div', 'resume draft-waiting'); box.setAttribute('role', 'region'); box.setAttribute('aria-label', 'A drafted team');
    const name = (proposal.proposal && proposal.proposal.name) || (proposal.draft && proposal.draft.name) || 'New team';
    box.append(icon('team'), el('span', '', 'A team you described is drafted: "' + name + '". Review it before anything is saved.'));
    box.append(button('Review it', reviewDrafted, { primary: true, label: 'Review the drafted team', id: 'review-drafted' }), button('Discard', discardDrafted, { link: true, label: 'Discard the drafted team', id: 'discard-drafted' }));
    return box;
  }

  function renderHeaderName() { if (work && work.mode === 'editor') { const crumbs = $('crumbs'); const last = crumbs.children && crumbs.children[crumbs.children.length - 1]; if (last) last.textContent = work.draft.name || 'Team'; } }

  /**
   * A draft saved before the builder asked how to start can be on its Purpose step with a starting point chosen and no members yet: Next fills them in
   * from it, as it did when the draft was saved.
   */
  function applyLegacyStart() {
    startSeq += 1;
    work.awaitingStart = { id: work.startingPoint, seq: startSeq, legacy: true };
    const message = { type: 'starting-point', id: work.startingPoint, goal: work.draft.description.slice(0, 400), locality: work.options.locality, seq: startSeq };
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
    if (!draft.members.length) root.append(el('p', 'hint empty-inline', 'No members yet. Add one, or go back to the start and clone an existing team.'));
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
    // On a narrow panel each member becomes a small card: name, then model, then where it runs.
    const table = el('table', 'grid stack-narrow');
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
      const pickCell = el('td'); pickCell.append(pick); pickCell.dataset.label = 'Model';
      const runs = el('td', 'runs-on'); runs.dataset.label = 'Runs on';
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
    const servers = new Map();
    for (const tool of ctx ? ctx.tools : []) {
      // A built-in staff server's tools sit together under the server, after the tools every run gets: only a staff team's run is given them.
      if (tool.server) { if (!servers.has(tool.server.id)) servers.set(tool.server.id, { capability: 'staff:' + tool.server.id, legend: tool.server.name + ': staff teams only', tools: [] }); servers.get(tool.server.id).tools.push(tool); continue; }
      if (!groups.has(tool.capability)) groups.set(tool.capability, []); groups.get(tool.capability).push(tool);
    }
    return [...[...CAPABILITY_ORDER.filter((cap) => groups.has(cap)), ...[...groups.keys()].filter((cap) => !CAPABILITY_ORDER.includes(cap))].map((cap) => ({ capability: cap, tools: groups.get(cap) })), ...servers.values()];
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
        button('Everything', () => { member.tools = (ctx ? ctx.tools : []).filter((tool) => tool.status !== 'off' && !tool.server).map((tool) => tool.name); work.openTools = index; changed(true); }, { label: 'Give ' + member.name + ' every available tool' }));
      details.append(bar);
      const runs = []; const asks = [];
      for (const group of toolGroups()) {
        const set = el('fieldset', 'tool-group');
        set.append(el('legend', '', group.legend || CAPABILITY_LABEL[group.capability] || group.capability));
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
          // What the tool's manifest says it can do, in the sentences the Tools page shows.
          if (tool.words && tool.words.length) label.append(el('span', 'hint tool-words', ' ' + tool.words.join('. ') + '.'));
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
    iconHistory(root);
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

  /** Earlier icons (0.4.30): each one the team had before a change or Remove, newest first, with Restore. */
  function iconHistory(root) {
    if (work.iconHistory === null || work.iconHistory === undefined) { root.append(el('p', 'hint', 'Loading earlier icons…')); return; }
    const earlier = work.iconHistory;
    if (!earlier.length) return;
    root.append(el('h3', '', 'Earlier icons'));
    const list = el('ul', 'rows icon-history');
    for (const entry of earlier) {
      const row = el('li', 'row');
      row.append(teamIcon(work.draft.name, entry.icon), el('span', 'name', entry.label));
      const actions = el('span', 'row-actions');
      actions.append(button('Restore', () => { if (work.iconBusy) return; work.iconBusy = true; vscode.postMessage({ type: 'icon-restore', id: work.id, ref: entry.ref }); render(); }, { label: 'Restore the icon from ' + entry.label, disabled: Boolean(work.iconBusy) }));
      row.append(actions);
      list.append(row);
    }
    root.append(list);
    root.append(el('h3', '', 'Team file versions'));
  }

  // ---------- review results ----------
  const slots = [];
  function reviewSlot(parent, kind, index, fields) { const node = el('div', 'slot'); node.setAttribute('aria-live', 'polite'); parent.append(node); slots.push({ node, kind, index, fields: fields || [] }); return node; }

  /**
   * The wizard step a problem lives on, so the count can take the person to it. A problem with a member belongs to the step that owns that field; one
   * about the team itself belongs to Purpose.
   */
  function stepFor(issue) {
    if (!issue) return undefined;
    if (issue.member === undefined || issue.member === null) return (issue.field === 'name' || issue.field === 'description') ? 0 : 1;
    if (issue.field === 'name' || issue.field === 'role') return 1;
    if (issue.field === 'model') return 2;
    if (issue.field === 'tools') return 3;
    if (issue.field === 'instructions') return 4;
    return 1;
  }

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
      if (slot.kind === 'team') {
        // The team's own name: its problems are shown under the field, and the field is marked invalid while there is one.
        const own = (issue) => (issue.member === undefined || issue.member === null) && slot.fields.includes(issue.field);
        const errors = review.errors.filter(own);
        const nameInput = $('f-name');
        if (nameInput) nameInput.setAttribute('aria-invalid', errors.length ? 'true' : 'false');
        if (errors.length) { const list = el('ul', 'issues'); errors.forEach((issue) => list.append(issueLine(issue, 'error'))); slot.node.append(list); }
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
      // Owner, 2026-11-18: advice on running members side by side (each with its own area) and on who brings their parts together. Notes, not
      // problems: the team still saves and still shows Ready.
      const notes = review && Array.isArray(review.notes) ? review.notes : [];
      if (notes.length) {
        const list = el('ul', 'issues notes');
        notes.forEach((issue) => { const line = el('li', 'hint'); line.append(icon('info'), document.createTextNode(' ' + issue.message)); list.append(line); });
        checks.append(el('p', 'hint', 'Suggestion' + (notes.length === 1 ? '' : 's') + ' for running members side by side (you can still save):'), list);
      }
    }
    const preview = $('preview');
    if (preview) preview.textContent = review ? review.markdown : '';
    const saveButton = $('save');
    if (saveButton) saveButton.disabled = Boolean(review && review.errors.length) || (work && work.mode === 'editor' && !isDirty());
    // 0.4.19 (owner, 2026-11-08): "there's no indication of what that thing is that needs fixing". The footer used to say only "1 to fix", and the
    // problem usually lives on a step the person is not looking at. It now names each problem and goes to the step that holds it.
    const errorCount = $('error-count');
    if (errorCount) {
      errorCount.replaceChildren();
      if (review && review.errors.length) {
        const go = button(review.errors.length + ' to fix', () => { const step = stepFor(review.errors[0]); if (step !== undefined) goStep(step); }, { link: true, label: 'Go to the first problem that is stopping this team from being saved' });
        errorCount.append(go);
        // Show the first two and count the REST from what was actually shown: the old loop broke after one and then subtracted two, so it said "and 1 more"
        // while two were hidden (0.4.19 review).
        const shown = review.errors.slice(0, 2);
        for (const issue of shown) errorCount.append(el('span', 'error-count-text', ' ' + issue.message));
        const hidden = review.errors.length - shown.length;
        if (hidden > 0) errorCount.append(el('span', 'hint', ` and ${hidden} more`));
      }
    }
  }

  // ---------- the wizard ----------
  function goStep(step) {
    work.stage = 'steps';
    work.step = Math.max(0, Math.min(STEPS.length - 1, step));
    work.maxStep = Math.max(work.maxStep, work.step);
    render();
    focusLater('step-heading');
  }

  function renderWizard(root) {
    if (work.stage !== 'steps') { renderStart(root); return; }
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
    const HINTS = ['Name the new team, say what it is for, and choose where to save it.', 'Who is on the team and what each is responsible for.', 'Which model each member runs on.', 'What each member may use, and what will run or ask under your approval mode.', 'Fine-tune each member\'s instructions, check the result, and save.'];
    panel.append(el('p', 'hint', HINTS[work.step]));
    [sectionPurpose, sectionMembers, sectionModels, sectionTools, (node) => { node.append(improveEntry()); sectionInstructions(node); sectionChecks(node, true); }][work.step](panel);
    root.append(panel);
    const footer = el('div', 'footer');
    footer.append(button('Back', () => { if (work.step === 0) backFromPurpose(); else goStep(work.step - 1); }, {}), button('Save draft', () => { work.clean = JSON.stringify(work.draft); reportUnsaved(); vscode.postMessage(Object.assign({ type: 'save-draft' }, wizardState())); }, {}), button('Cancel', leaveWork, { link: true }));
    const spacer = el('span', 'spacer'); footer.append(spacer);
    const count = el('span', 'hint'); count.id = 'error-count'; footer.append(count);
    if (work.step < STEPS.length - 1) footer.append(button('Next: ' + STEPS[work.step + 1], () => {
      if (work.step === 0 && !work.path && !work.draft.members.length && work.startingPoint && work.startingPoint !== 'empty') { applyLegacyStart(); return; }
      goStep(work.step + 1);
    }, { primary: true, id: 'next' }));
    else footer.append(button(work.target === 'project' ? 'Save project team' : 'Save team', save, { primary: true, id: 'save' }));
    root.append(footer);
  }

  // ---------- the editor ----------
  function renderEditor(root) {
    const head = el('div', 'editor-head');
    const title = el('div', 'editor-title');
    title.append(teamIcon(work.draft.name || 'Team', work.icon), el('h2', '', work.draft.name || 'Team'), el('code', 'hint', work.file));
    const dirty = el('span', 'dirty'); dirty.id = 'dirty'; dirty.setAttribute('aria-live', 'polite');
    title.append(dirty);
    const actions = el('div', 'actions');
    actions.append(button('Save', save, { primary: true, id: 'save' }), button('Improve with AI', openImprove, { id: 'improve', label: 'Improve with AI: run the free local check, then ask for an AI review of this team' }), button('Revert', () => { work.draft = JSON.parse(work.clean); changed(true); announce('Reverted to the saved team.'); }, { id: 'revert' }), button('Open as Markdown', () => vscode.postMessage({ type: 'open-markdown', id: work.id })), button('Use in chat', () => vscode.postMessage({ type: 'use-in-chat', id: work.id })));
    head.append(title, actions);
    root.append(head);
    const slot = el('div', 'improve-slot'); slot.id = 'improve-slot';
    if (work.improve) slot.append(sectionImprove());
    root.append(slot);
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
    [sectionPurpose, sectionMembers, sectionModels, sectionTools, sectionInstructions, sectionShape, sectionKnowledge, (node) => sectionChecks(node, true), sectionHistory][work.tab](panel);
    // The mini checks sit under every tab except the checks tab itself and the shape, which is a picture rather than a form.
    if (work.tab !== TAB_CHECKS && work.tab !== TAB_SHAPE && work.tab !== TAB_KNOWLEDGE) { const mini = el('div', 'mini-checks'); panel.append(mini); sectionChecks(mini, false); }
    root.append(panel);
    updateDirty();
  }

  function selectTab(index) {
    work.tab = index;
    if (index === TAB_HISTORY) vscode.postMessage({ type: 'versions', id: work.id });
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

  // ---------- the knowledge graph as a network ----------
  // Owner, 2026-11-08: "visualize its context graph in an interactive network graph where one can select nodes and see suitable animations depicting all
  // its relationships, additional detail cards, admiralty of sources". The layout is computed by the host, so the same graph always draws the same way.

  function renderNetwork(root) {
    root.replaceChildren();
    const knowledge = currentKnowledge;
    if (!knowledge || !knowledge.nodes || !knowledge.nodes.length) { root.hidden = true; return; }
    root.hidden = false;
    const head = el('div', 'network-head');
    head.append(el('strong', '', 'What this team knows'), el('span', 'hint', ` ${knowledge.nodes.length} actors, ${knowledge.edges.length} relations, ${knowledge.coverage.gradedNodes} graded actors and ${knowledge.coverage.gradedEdges} graded relations.`));
    root.append(head);
    if (knowledge.problem) root.append(el('p', 'hint', knowledge.problem));
    const svgNs = 'http://www.w3.org/2000/svg';
    const make = (name, attrs) => { const node = document.createElementNS(svgNs, name); for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, String(value)); return node; };
    const chart = make('svg', { viewBox: `0 0 ${knowledge.width} ${knowledge.height}`, width: '100%', height: knowledge.height, role: 'img', 'aria-label': 'Network of the actors this team knows and how they relate' });
    const positions = new Map(knowledge.nodes.map((node) => [node.id, node]));
    const touched = selectedNode ? highlightSet(knowledge, selectedNode) : null;
    const order = selectedNode ? highlightOrderOf(knowledge, selectedNode) : [];
    const delayFor = new Map(order.map((entry) => [entry.edgeId, entry.delayMs]));
    // Relations first, so the nodes sit on top of their lines.
    for (const edge of knowledge.edges) {
      const from = positions.get(edge.from);
      const to = positions.get(edge.to);
      if (!from || !to) continue;
      const dim = touched && !touched.edges.has(edge.id);
      const line = make('line', { x1: from.x, y1: from.y, x2: to.x, y2: to.y, class: 'net-edge' + (dim ? ' dim' : '') + (edge.neutral ? ' unmeasured' : edge.positive ? ' positive' : ' negative'), 'stroke-width': edge.width });
      if (selectedNode && touched && touched.edges.has(edge.id)) {
        // The relations of the selected actor are drawn on in sequence, strongest first, so the eye follows strength.
        line.setAttribute('class', 'net-edge highlighted' + (edge.positive ? ' positive' : ' negative'));
        line.style.animationDelay = (delayFor.get(edge.id) || 0) + 'ms';
      }
      line.setAttribute('aria-hidden', 'true');
      chart.append(line);
      if (selectedNode && touched && touched.edges.has(edge.id)) {
        const label = make('text', { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 - 4, class: 'net-edge-label', 'text-anchor': 'middle' });
        label.textContent = edge.kind + (edge.tension === null ? '' : ' ' + edge.tension.toFixed(1));
        chart.append(label);
      }
    }
    for (const node of knowledge.nodes) {
      const dim = touched && !touched.nodes.has(node.id);
      const circle = make('circle', { cx: node.x, cy: node.y, r: node.radius, class: 'net-node' + (dim ? ' dim' : '') + (node.id === selectedNode ? ' selected' : ''), tabindex: '0', role: 'button', 'aria-label': node.label + ', ' + node.degree + ' relations: open its card' });
      circle.addEventListener('click', () => { selectedNode = selectedNode === node.id ? null : node.id; renderNetwork(root); });
      chart.append(circle);
      const label = make('text', { x: node.x, y: node.y + node.radius + 12, class: 'net-label' + (dim ? ' dim' : ''), 'text-anchor': 'middle' });
      label.textContent = node.label;
      chart.append(label);
    }
    root.append(chart);
    const card = el('section', 'net-card');
    card.id = 'net-card';
    card.setAttribute('aria-live', 'polite');
    root.append(card);
    renderNodeCard();
  }

  function highlightSet(knowledge, id) {
    const nodes = new Set([id]);
    const edges = new Set();
    for (const edge of knowledge.edges) {
      if (edge.from === id) { nodes.add(edge.to); edges.add(edge.id); }
      else if (edge.to === id) { nodes.add(edge.from); edges.add(edge.id); }
    }
    return { nodes, edges };
  }

  function highlightOrderOf(knowledge, id) {
    return knowledge.edges.filter((edge) => edge.from === id || edge.to === id)
      .map((edge) => ({ edgeId: edge.id, tension: Math.abs(edge.tension === null ? 0 : edge.tension) }))
      .sort((a, b) => b.tension - a.tension || a.edgeId.localeCompare(b.edgeId))
      .map((entry, index) => ({ edgeId: entry.edgeId, delayMs: index * 60 }));
  }

  /** Admiralty as a person reads it: the source's reliability and the information's credibility, spelled out. */
  function admiralty(grading) {
    const reliability = { A: 'completely reliable', B: 'usually reliable', C: 'fairly reliable', D: 'not usually reliable', E: 'unreliable', F: 'cannot be judged' }[grading.reliability] || 'unknown source';
    const credibility = { 1: 'confirmed', 2: 'probably true', 3: 'possibly true', 4: 'doubtful', 5: 'improbable', 6: 'cannot be judged' }[grading.credibility] || 'unknown credibility';
    return grading.reliability + grading.credibility + ' (' + reliability + ', ' + credibility + ')';
  }

  // The card for the selected actor: what it does, what is known with where it came from and how reliable that is, and every relation.
  function renderNodeCard() {
    const card = $('net-card');
    if (!card) return;
    card.replaceChildren();
    const knowledge = currentKnowledge;
    if (!knowledge || !selectedNode || !knowledge.groups || !knowledge.groups[selectedNode]) { card.hidden = true; return; }
    card.hidden = false;
    const node = knowledge.nodes.find((entry) => entry.id === selectedNode);
    const detail = knowledge.groups[selectedNode];
    card.append(el('h3', '', node.label));
    card.append(el('p', 'meta', `${node.kind}, seen ${detail.mentions} time${detail.mentions === 1 ? '' : 's'}, from ${detail.origin}${detail.grading ? `; evidence ${admiralty(detail.grading)}` : '; evidence not graded'}`));
    if (detail.functions.length) {
      const list = el('ul', 'net-functions');
      for (const fn of detail.functions) list.append(el('li', '', fn));
      card.append(el('h4', '', 'What it does'), list);
    }
    if (detail.facts.length) {
      card.append(el('h4', '', 'What is known'));
      const list = el('ul', 'net-facts');
      for (const fact of detail.facts) {
        const item = el('li');
        item.append(document.createTextNode(fact.text + ' '));
        if (fact.source) item.append(el('code', 'net-source', fact.source));
        if (fact.grading) item.append(el('span', 'net-grade', ' ' + admiralty(fact.grading)));
        list.append(item);
      }
      card.append(list);
    }
    if (detail.relations.length) {
      card.append(el('h4', '', 'Relations'));
      const list = el('ul', 'net-relations');
      for (const relation of detail.relations) {
        const other = knowledge.nodes.find((entry) => entry.id === relation.other);
        const item = el('li');
        const strength = relation.tension === null ? 'not measured' : (relation.tension > 0 ? '+' : '') + relation.tension.toFixed(1);
        item.append(el('span', 'net-relation', (relation.direction === 'out' ? '\u2192 ' : '\u2190 ') + (other ? other.label : '?') + ' (' + relation.kind + ', tension ' + strength + ')' + (relation.basis ? ': ' + relation.basis : '')));
        if (relation.grading) item.append(el('span', 'net-grade', ' ' + admiralty(relation.grading)));
        list.append(item);
      }
      card.append(list);
    }
    card.append(button('Close', () => { selectedNode = null; renderNetwork($('knowledge')); }, { link: true }));
  }

  function sectionKnowledge(root) {
    root.append(el('p', 'hint', 'What this team has learned, shared by all its members and kept between runs. Select an actor to see what is known about it, where that came from, and how strongly it relates to the rest.'));
    const network = el('div', 'network');
    network.id = 'knowledge';
    root.append(network);
    renderNetwork(network);
    if (!currentKnowledge || !currentKnowledge.nodes.length) root.append(el('p', 'hint', 'Nothing learned yet. A team adds to this graph as it researches and as people tell it things.'));
  }

  function save() {
    if (!work) return;
    if (work.mode === 'editor') { vscode.postMessage({ type: 'save', draft: work.draft, id: work.id, base: work.base }); return; }
    const message = { type: 'create', draft: work.draft, target: work.target };
    if (isClone()) message.clone = true;
    if (work.target === 'project' && (work.startingPoint || '').startsWith('type:') && work.projectType) message.projectType = { id: work.projectType, goal: work.draft.description };
    vscode.postMessage(message);
  }

  function openEditor(message, keepTab) {
    const same = keepTab && work && work.mode === 'editor' && work.id === message.id;
    // The same team reopened after a Save keeps its Improve panel: pending suggestions stay, and any whose field changed show as Stale.
    work = { mode: 'editor', id: message.id, kind: message.kind, file: message.file, command: message.command, base: message.base, draft: message.draft, clean: JSON.stringify(message.draft), teamPrivacy: message.teamPrivacy || null, tab: same ? work.tab : 0, versions: message.versions || [], review: null, versionView: null, improve: same ? work.improve : null,
      icon: message.icon || null, iconHistory: same ? work.iconHistory : null, iconAi: message.iconAi || null, iconBusy: false };
    // The earlier icons come with the History tab (PR #82 review): a team reopened on it asks for them again.
    if (work.tab === TAB_HISTORY) vscode.postMessage({ type: 'versions', id: work.id });
  }

  // ---------- Improve with AI (0.4.27) ----------
  // Step 1 is the free local check; step 2, only on request, is one AI review through the host, which sends the team only to a model the privacy rule
  // allows. Suggestions are data: each one is accepted, rejected or edited on its own, and accepting changes only this draft. Save writes it as always.
  // Request: Checking -> Checked -> Requesting -> Reviewing | Nothing to suggest | Failed | Blocked | Cancelled. Each suggestion: Pending -> Accepted |
  // Rejected | Stale (its field changed since the review) | Invalid (applying it would break the team).
  const KIND_LABEL = { instructions: 'Instructions', role: 'Role', 'reports-to': 'Reports to', 'tools-add': 'Add tools', 'tools-remove': 'Remove tools', 'add-member': 'New member', 'remove-member': 'Remove member', advice: 'Advice' };
  const ACCEPT_ALL = ['instructions', 'role'];
  const STATE_LABEL = { accepted: 'Accepted', rejected: 'Rejected', stale: 'Stale', invalid: 'Invalid' };

  function improveEntry() {
    const slot = el('div', 'improve-slot'); slot.id = 'improve-slot';
    if (work.improve) { slot.append(sectionImprove()); return slot; }
    const box = el('div', 'improve-entry');
    box.append(button('Improve with AI', openImprove, { id: 'improve', label: 'Improve with AI: run the free local check, then ask for an AI review of this team' }), el('span', 'hint', ' A free local check first; an AI review only when you ask.'));
    slot.append(box);
    return slot;
  }

  /** After a keystroke (no full render): if a pending suggestion's field changed, redraw only the Improve panel so it shows Stale at once. */
  function updateImprove() {
    const imp = work && work.improve;
    const slot = $('improve-slot');
    if (!imp || !slot) return;
    const before = imp.suggestions.map((item) => item.status).join();
    refreshStale();
    if (imp.suggestions.map((item) => item.status).join() === before) return;
    slot.replaceChildren();
    slot.append(sectionImprove());
  }

  function openImprove() {
    if (!work) return;
    improveSeq += 1;
    work.improve = { seq: improveSeq, state: 'checking', findings: [], ai: null, suggestions: [], dropped: [], member: '' };
    const message = { type: 'improve-check', seq: improveSeq, draft: work.draft };
    if (work.mode === 'editor') message.id = work.id;
    vscode.postMessage(message);
    render();
    focusLater('improve-heading');
  }

  function closeImprove() {
    if (!work || !work.improve) return;
    if (work.improve.state === 'requesting') vscode.postMessage({ type: 'improve-cancel', seq: work.improve.seq });
    work.improve = null;
    render();
    focusLater(work.mode === 'editor' ? 'improve' : 'step-heading');
  }

  function askForReview() {
    const imp = work.improve;
    improveSeq += 1;
    imp.seq = improveSeq;
    Object.assign(imp, { state: 'requesting', suggestions: [], dropped: [], summary: null, rating: null, partial: false, reason: null });
    const message = { type: 'improve-ai', seq: imp.seq, draft: work.draft };
    if (work.mode === 'editor') message.id = work.id;
    if (imp.member) message.member = imp.member;
    vscode.postMessage(message);
    render();
    focusLater('improve-cancel');
  }

  /** The same value the host compares a suggestion's base with (src/agent/teamRefine.ts fieldValue). */
  function fieldValue(member, kind) {
    if (!member) return '';
    if (kind === 'instructions' || kind === 'remove-member') return member.instructions;
    if (kind === 'role') return member.role;
    if (kind === 'reports-to') return member.reportsTo || '';
    if (kind === 'tools-add' || kind === 'tools-remove') return JSON.stringify(member.tools);
    return '';
  }

  /** A pending suggestion whose field changed since the review (an edit, a reload from the file, another suggestion) is Stale. */
  function refreshStale() {
    const imp = work && work.improve;
    if (!imp) return;
    for (const item of imp.suggestions) {
      if (item.status !== 'pending' || item.kind === 'advice') continue;
      const member = work.draft.members.find((entry) => entry.name === item.member);
      const stale = item.kind === 'add-member' ? Boolean(member) : !member || fieldValue(member, item.kind) !== item.base;
      if (stale) { item.status = 'stale'; item.note = 'Its field changed after the review, so it no longer fits. Ask for a new review.'; item.editing = false; }
    }
  }

  function acceptSuggestions(ids, edited) {
    const imp = work.improve;
    const message = { type: 'improve-accept', seq: imp.seq, ids, draft: work.draft };
    if (work.mode === 'editor') message.id = work.id;
    if (edited !== undefined) message.edited = edited;
    vscode.postMessage(message);
  }

  function suggestionCard(item) {
    const card = el('li', 'suggestion-card ' + item.status + (item.sensitive ? ' sensitive' : ''));
    card.id = 'sg-' + item.id;
    const title = el('p', 'suggestion-title');
    title.append(el('strong', '', item.member || 'The team'), document.createTextNode(' · ' + (KIND_LABEL[item.kind] || item.kind)));
    if (item.status !== 'pending') title.append(document.createTextNode(' '), badge(STATE_LABEL[item.status], 'state ' + item.status));
    card.append(title);
    if (item.label) { const label = el('p', item.sensitive ? 'notice warning power' : 'hint'); if (item.sensitive) label.append(icon('warn'), document.createTextNode(' ')); label.append(document.createTextNode(item.label)); card.append(label); }
    card.append(el('p', 'reason', item.reason));
    if (item.diff && item.kind !== 'advice') {
      const diff = el('pre', 'diff'); diff.setAttribute('tabindex', '0'); diff.setAttribute('aria-label', 'Proposed change to ' + (item.member || 'the team') + ': lines with - are removed, lines with + are added');
      for (const line of item.diff) diff.append(el('span', 'diff-line ' + line.op, (line.op === 'add' ? '+ ' : line.op === 'del' ? '- ' : '  ') + line.text + '\n'));
      card.append(diff);
    }
    if (item.note) card.append(el('p', item.status === 'invalid' || item.status === 'stale' ? 'notice warning' : 'hint', item.note));
    if (item.status !== 'pending' || item.kind === 'advice') return card;
    const actions = el('div', 'actions');
    if (item.editing) {
      const area = textarea(item.edited !== undefined ? item.edited : item.proposed, (value) => { item.edited = value; }, item.kind === 'instructions' ? 7 : 2, 'sg-edit-' + item.id);
      area.setAttribute('aria-label', 'Your version of the suggested ' + (KIND_LABEL[item.kind] || '').toLowerCase() + ' for ' + item.member);
      card.append(el('p', 'hint', 'Suggested by the AI; change it as you like, then accept your version.'), area);
      actions.append(button('Accept my version', () => acceptSuggestions([item.id], item.edited !== undefined ? item.edited : item.proposed), { primary: true, label: 'Accept your version of the suggestion for ' + item.member }), button('Cancel edit', () => { item.editing = false; item.edited = undefined; render(); }, { link: true }));
    } else {
      actions.append(button('Accept', () => acceptSuggestions([item.id]), { primary: true, label: 'Accept the suggestion for ' + (item.member || 'the team') + ': ' + (KIND_LABEL[item.kind] || item.kind), id: 'sg-accept-' + item.id }),
        button('Reject', () => { item.status = 'rejected'; announce('Rejected.'); render(); }, { label: 'Reject the suggestion for ' + (item.member || 'the team') + ': ' + (KIND_LABEL[item.kind] || item.kind) }));
      if (item.editable) actions.append(button('Edit', () => { item.editing = true; render(); focusLater('sg-edit-' + item.id); }, { label: 'Edit the suggestion for ' + item.member + ' before accepting it' }));
    }
    card.append(actions);
    return card;
  }

  function sectionImprove() {
    refreshStale();
    const imp = work.improve;
    const box = el('section', 'improve'); box.setAttribute('aria-labelledby', 'improve-heading'); box.setAttribute('aria-live', 'polite');
    const head = el('div', 'improve-head');
    const heading = el('h3', '', 'Improve with AI'); heading.id = 'improve-heading'; heading.setAttribute('tabindex', '-1');
    head.append(heading, button('Close', closeImprove, { link: true, label: 'Close Improve with AI' }));
    box.append(head);
    box.append(el('h4', '', 'Local check (free, no model)'));
    if (imp.state === 'checking') box.append(el('p', 'hint', 'Checking…'));
    else if (!imp.findings.length) { const ok = el('p', 'ok-line'); ok.append(icon('check'), document.createTextNode(' The local check found nothing to fix.')); box.append(ok); }
    else {
      const list = el('ul', 'issues');
      for (const finding of imp.findings) list.append(issueLine(finding, finding.severity === 'block' ? 'error' : 'warning'));
      box.append(list);
    }
    if (imp.findingsNow !== undefined && imp.findingsBefore !== undefined) box.append(el('p', 'hint', 'Local check: ' + imp.findingsBefore + ' finding' + (imp.findingsBefore === 1 ? '' : 's') + ' before the review, ' + imp.findingsNow + ' now.'));
    box.append(el('h4', '', 'AI review'));
    const ai = imp.ai;
    if (!ai) box.append(el('p', 'hint', 'Finding a model…'));
    else if (!ai.available) { const why = el('p', 'notice warning'); why.append(icon('warn'), document.createTextNode(' ' + (ai.reason || 'The AI review is not available.'))); box.append(why); }
    else {
      box.append(el('p', 'hint', 'One call to ' + ai.model + (ai.private ? ', a private model (NEAR TEE or this computer)' : ', which is not a private model') + (ai.estimate ? ', ' + ai.estimate : '') + '. It suggests changes; nothing changes until you accept one, and nothing is saved until you Save.'));
      if (ai.note) { const note = el('p', 'notice warning'); note.append(icon('warn'), document.createTextNode(' ' + ai.note)); box.append(note); }
      const row = el('div', 'actions');
      const scope = select([{ value: '', label: 'The whole team' }].concat(work.draft.members.map((member) => ({ value: member.name, label: 'Only ' + member.name }))), imp.member || '', (value) => { imp.member = value; }, 'improve-member');
      scope.setAttribute('aria-label', 'What to review');
      row.append(scope);
      if (imp.state === 'requesting') {
        row.append(el('span', 'hint', 'Asking ' + (imp.model || ai.model) + '…'), button('Cancel', () => { vscode.postMessage({ type: 'improve-cancel', seq: imp.seq }); imp.state = 'cancelled'; imp.reason = 'Cancelled. Nothing changed.'; render(); }, { id: 'improve-cancel', label: 'Cancel the AI review' }));
      } else row.append(button(imp.suggestions.length || imp.state === 'nothing' ? 'Review again' : 'Run the AI review', askForReview, { primary: true, id: 'improve-run' }));
      box.append(row);
    }
    if (imp.reason && (imp.state === 'failed' || imp.state === 'blocked' || imp.state === 'cancelled')) { const why = el('p', 'notice ' + (imp.state === 'cancelled' ? 'info' : 'warning')); why.append(icon(imp.state === 'cancelled' ? 'check' : 'warn'), document.createTextNode(' ' + imp.reason)); box.append(why); }
    if (imp.summary) box.append(el('p', 'summary', imp.summary));
    if (imp.rating) box.append(el('p', 'hint', 'The model\'s own rating, not a measurement: ' + imp.rating.before.toFixed(2) + ' now, ' + imp.rating.after.toFixed(2) + ' with its suggestions (0 to 1).' + (imp.rating.note ? ' ' + imp.rating.note : '')));
    if (imp.partial) { const cut = el('p', 'notice warning'); cut.append(icon('warn'), document.createTextNode(' The reply was cut short, so some suggestions may be missing.')); box.append(cut); }
    if (imp.state === 'nothing') box.append(el('p', 'hint', 'The AI review has nothing to change.'));
    const wording = imp.suggestions.filter((item) => !item.sensitive && item.kind !== 'advice');
    const power = imp.suggestions.filter((item) => item.sensitive);
    const advice = imp.suggestions.filter((item) => item.kind === 'advice');
    const bulk = imp.suggestions.filter((item) => item.status === 'pending' && ACCEPT_ALL.includes(item.kind));
    if (bulk.length > 1) box.append(button('Accept all wording changes (' + bulk.length + ')', () => acceptSuggestions(bulk.map((item) => item.id)), { id: 'improve-accept-all', label: 'Accept all ' + bulk.length + ' wording changes. Tool and member changes are never included.' }));
    const group = (title, items, hint) => {
      if (!items.length) return;
      box.append(el('h4', '', title));
      if (hint) box.append(el('p', 'hint', hint));
      const list = el('ul', 'suggestions');
      for (const item of items) list.append(suggestionCard(item));
      box.append(list);
    };
    group('Suggested changes', wording);
    group('Changes to who can do what', power, 'These give a member more power or change who is on the team, so each is accepted on its own and never by Accept all.');
    group('Advice', advice);
    if (imp.dropped.length) {
      const details = el('details', 'dropped');
      details.append(el('summary', '', imp.dropped.length + ' suggestion' + (imp.dropped.length === 1 ? ' was' : 's were') + ' left out'));
      const list = el('ul');
      for (const reason of imp.dropped) list.append(el('li', '', reason));
      details.append(list);
      box.append(details);
    }
    if (imp.templateNote) box.append(el('p', 'hint', imp.templateNote));
    return box;
  }

  // ---------- render ----------
  let pendingFocus = null;
  function focusLater(id) { pendingFocus = id; }

  // ---------- the team as a shape ----------
  // Owner, 2026-11-08: "teams represented graphically with ability to click on a member and get a member card detailing their capabilities and
  // expectations. Should show hierarchy if one exists." Drawn as nested boxes rather than an abstract diagram: the nesting IS the hierarchy, and every
  // member is a real button, so it works with Tab and Enter as well as with a click.

  function renderGraph(root) {
    root.replaceChildren();
    const graph = currentGraph;
    if (!graph || !graph.roots || !graph.roots.length) { root.hidden = true; return; }
    root.hidden = false;
    root.append(el('strong', '', 'The team, and who answers to whom'));
    const tree = el('ul', 'graph-tree');
    const node = (member) => {
      const item = el('li', 'graph-node');
      const button = el('button', 'graph-member');
      button.type = 'button';
      button.setAttribute('aria-expanded', String(openCard === member.name));
      button.setAttribute('aria-label', `${member.name}${member.role ? ', ' + member.role : ''}${member.children && member.children.length ? ', leads ' + member.children.length : ''}: open its card`);
      button.append(el('strong', '', member.name));
      if (member.role && member.role !== member.name) button.append(el('span', 'graph-role', member.role));
      if (member.card && member.card.model) button.append(el('code', 'graph-model', member.card.model.split('/').pop()));
      if (member.card && member.card.abliterated) button.append(badge('abliterated'));
      button.addEventListener('click', () => { openCard = openCard === member.name ? null : member.name; renderGraph(root); renderCard(); const again = root.querySelector('.graph-member[aria-expanded="true"]'); if (again) again.focus(); });
      item.append(button);
      if (member.children && member.children.length) {
        const children = el('ul', 'graph-children');
        for (const child of member.children) children.append(node(child));
        item.append(children);
      }
      return item;
    };
    for (const member of graph.roots) tree.append(node(member));
    root.append(tree);
    if (graph.orphaned && graph.orphaned.length) {
      root.append(el('p', 'hint', 'Report to someone who is not on the team, so they are drawn at the top: ' + graph.orphaned.map((entry) => entry.name + (entry.reportsTo ? ' (reports to ' + entry.reportsTo + ')' : '')).join(', ') + '.'));
    }
  }

  function renderCard() {
    const card = $('member-card');
    if (!card) return;
    card.replaceChildren();
    const graph = currentGraph;
    const member = graph && openCard ? findMember(graph.roots, openCard) : null;
    if (!member) { card.hidden = true; return; }
    card.hidden = false;
    const title = el('h3', '', member.name);
    if (member.role && member.role !== member.name) title.append(el('span', 'hint', ' · ' + member.role));
    card.append(title);
    const info = member.card || {};
    if (info.model) card.append(el('p', 'meta', 'Model: ' + info.model + (info.abliterated ? ' (does not refuse)' : '')));
    if (info.reportsTo) card.append(el('p', 'meta', 'Reports to: ' + info.reportsTo));
    if (info.leads && info.leads.length) card.append(el('p', 'meta', 'Leads: ' + info.leads.join(', ')));
    if (info.purpose) { card.append(el('h4', '', 'What it is for'), el('p', '', info.purpose)); }
    if (info.capabilities && info.capabilities.length) {
      const list = el('ul', 'graph-capabilities');
      for (const capability of info.capabilities) list.append(el('li', '', capability));
      card.append(el('h4', '', 'What it can do'), list);
    }
    if (info.tools && info.tools.length) card.append(el('p', 'hint', 'Tools: ' + info.tools.join(', ')));
    if (info.expectations && info.expectations.length) {
      card.append(el('h4', '', 'What to expect from it'));
      for (const part of info.expectations) card.append(el('p', '', part));
    }
    const close = button('Close', () => { openCard = null; renderGraph($('graph')); renderCard(); }, { link: true });
    card.append(close);
  }

  function findMember(nodes, name) {
    for (const node of nodes || []) {
      if (node.name === name) return node;
      const found = findMember(node.children, name);
      if (found) return found;
    }
    return null;
  }

  function openStaffPreview() {
    const request = ++staffPreviewRequest;
    staffPreview = { request, scope: 'section' };
    pendingFocus = 'staff-preview-title';
    vscode.postMessage({ type: 'staff-preview-open', request });
    render();
  }

  function leaveStaffPreview() {
    if (!staffPreview) return;
    vscode.postMessage({ type: 'staff-preview-leave', request: staffPreview.request });
    staffPreview = undefined;
    pendingFocus = 'staff-preview-open';
    render();
  }

  function renderStaffPreview(root) {
    const panel = el('section', 'panel staff-preview');
    const title = el('h2', '', 'Staff setup preview');
    title.id = 'staff-preview-title';
    title.setAttribute('tabindex', '-1');
    panel.setAttribute('aria-labelledby', title.id);
    panel.append(title);
    const { data, scope, busy, finished, section } = staffPreview;
    if (data?.error) {
      panel.append(el('p', '', data.error));
    } else if (!data) {
      panel.append(el('p', 'hint', 'Waiting for a project…'));
    } else {
      panel.append(el('h3', '', data.project));
      if (data.profile) panel.append(el('p', '', data.profile + ' · ' + data.level));
      else panel.append(el('p', '', 'No staff profile is saved for this project.'));
      panel.append(el('p', 'hint', data.modelLocation));
      const scopes = el('div', 'actions staff-preview-scopes');
      scopes.setAttribute('role', 'group');
      scopes.setAttribute('aria-label', 'Staff setup scope');
      for (const [value, label] of [['section', 'One section'], ['complete', 'Complete staff']]) {
        const control = button(label, () => {
          staffPreview.scope = value;
          pendingFocus = 'staff-preview-title';
          render();
        });
        control.setAttribute('aria-pressed', String(scope === value));
        control.disabled = Boolean(busy);
        scopes.append(control);
      }
      panel.append(scopes);
      const rows = el('ul', 'choice-grid staff-preview-rows');
      for (const row of data.rows) {
        if (scope === 'section' && !row.template) continue;
        const card = el('li', '', '');
        if (scope === 'section') {
          const pick = button(row.label, () => {
            staffPreview.section = row.id;
            pendingFocus = 'staff-section-' + row.id;
            render();
          }, { id: 'staff-section-' + row.id });
          pick.setAttribute('aria-pressed', String(section === row.id));
          pick.disabled = Boolean(busy);
          card.append(pick);
        } else {
          card.append(el('h4', '', row.label));
        }
        card.append(el('p', '', row.status));
        if (row.team) card.append(el('p', '', row.team));
        if (row.decisionRole) card.append(el('p', 'hint', row.decisionRole));
        rows.append(card);
      }
      if (scope === 'complete') panel.append(el('p', 'hint', 'Review the coverage for this project. Whole-staff setup is unavailable.'));
      panel.append(rows);
      if (busy) panel.append(el('p', 'hint', 'Continue in the editor’s setup questions.'));
      else if (finished) {
        panel.append(el('p', '', finished === 'applied' ? 'The section is set up.' : 'Setup did not finish. Review the project to try again.'));
        if (finished !== 'applied') panel.append(button('Review again', openStaffPreview));
      } else if (scope === 'section') {
        const next = button('Continue to section setup', () => {
          staffPreview.busy = true;
          vscode.postMessage({ type: 'staff-preview-continue', request: staffPreview.request, session: data.session, section });
          announce('Continue in the editor’s setup questions.');
          render();
        }, { primary: true, id: 'staff-preview-continue' });
        next.disabled = !section;
        panel.append(next);
      }
    }
    panel.append(button('Leave setup', leaveStaffPreview, { id: 'staff-preview-leave' }));
    root.append(panel);
  }

  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !staffPreview) return;
    event.preventDefault();
    leaveStaffPreview();
  });

  function render() {
    const active = document.activeElement && document.activeElement.id;
    slots.length = 0;
    renderHeader();
    const main = $('main');
    main.replaceChildren();
    if (!ctx) { main.append(el('p', 'hint', 'Loading…')); return; }
    if (staffPreview) renderStaffPreview(main);
    else if (!work) renderLibrary(main);
    else if (work.mode === 'wizard') renderWizard(main);
    else renderEditor(main);
    fillReview();
    reportUnsaved();
    flash = null;
    const target = pendingFocus || active;
    pendingFocus = null;
    const node = target && $(target);
    if (node && node.focus) node.focus();
    measureSoon();
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
    // Only under the extension-host tests, which load the layout probe: report this page's layout.
    if (message.type === 'layout-probe' && window.nearAiLayoutProbe) { vscode.postMessage(window.nearAiLayoutProbe()); return; }
    switch (message.type) {
      case 'staff-preview-state':
        if (staffPreview?.request !== message.request) break;
        staffPreview.data = message;
        staffPreview.busy = false;
        announce(message.error || 'Staff setup preview ready.');
        render();
        break;
      case 'staff-preview-result':
        if (staffPreview?.request !== message.request || staffPreview.data?.session !== message.session || !staffPreview.busy) break;
        staffPreview.busy = false;
        staffPreview.finished = message.applied ? 'applied' : 'held';
        pendingFocus = message.applied ? 'staff-preview-title' : 'staff-section-' + staffPreview.section;
        announce(message.applied ? 'The section is set up.' : 'Setup did not finish. Review the project to try again.');
        render();
        break;
      case 'state':
        ctx = message.context; lib = message.library; savedDraft = message.savedDraft || null; picker = message.picker || null; dash = message.dashboard || null;
        applyView(message.view);
        // A drafted team the host kept (null: none waiting); an older host says nothing, and the page keeps what it has.
        if ('proposal' in message) proposal = message.proposal ? { proposal: message.proposal.proposal || {}, draft: message.proposal.draft || null, problems: message.proposal.problems || [] } : null;
        render();
        if (work) requestReview();
        if (message.kept) showKept(message.kept);
        break;
      case 'left': {
        // The host's answer to leaving with unsaved changes: stay, or go back to the library (to the AI box when that is where the person was going).
        const toAsk = pendingAsk;
        pendingAsk = null;
        if (message.choice === 'stay' || !work) break;
        askTarget = toAsk || 'user';
        work = null;
        if (message.savedDraft) savedDraft = message.savedDraft;
        // Leaving for the AI start: a fresh builder opens on it, saving where the one that was left would have.
        if (toAsk) openAiStage(toAsk);
        else render();
        if (message.notice) { showBanner(message.notice, 'info'); announce(message.notice); }
        if (!toAsk) focusMain();
        break;
      }
      case 'library':
        if (onlyRatingsChanged(message.library) && (!message.dashboard || JSON.stringify(message.dashboard) === JSON.stringify(dash))) {
          lib = message.library;
          if (message.picker) picker = message.picker;
          repaintRatings();
          break;
        }
        lib = message.library;
        if (message.picker) picker = message.picker;
        if (message.dashboard) dash = message.dashboard;
        // The builder's picker lists saved teams, so it is drawn again when the library changes there; a selected team that has gone is unselected.
        if (work && work.mode === 'wizard' && work.pick && !pickerEntries().some((entry) => entry.id === work.pick)) work.pick = null;
        if (!work || (work.mode === 'wizard' && work.stage === 'pick')) render();
        break;
      // A team run started or ended: the dashboard alone, drawn when the dashboard is on screen (the builder and the editor are left as they are).
      case 'dashboard':
        dash = message.dashboard || dash;
        if (!work) render();
        break;
      // A run of the open team started or ended: the Team shape tab's Watch it live link follows, drawn again only on that tab and only on a change.
      case 'live-run':
        if (!work || work.mode !== 'editor' || work.id !== message.id || currentLive === (message.liveRun === true)) break;
        currentLive = message.liveRun === true;
        if (work.tab === TAB_SHAPE) render();
        break;
      case 'rated':
        // The host kept it on this computer (never in the team file, so an open editor has nothing to catch up on).
        pendingRating.delete(message.id);
        if (message.text) announce(message.text);
        break;
      case 'start-wizard':
        if (isDirty() || isWizardDirty()) { showBanner('Save or discard your changes first, then set up the project team.', 'warning'); break; }
        startWizard(message.target);
        break;
      case 'team':
        // The shape and knowledge tabs read these, so they are set BEFORE the editor renders: assigned after, the first paint of either tab could show
        // the previous team's graph (0.4.19 review).
        currentGraph = message.graph || null;
        currentLive = message.liveRun === true;
        currentKnowledge = message.knowledge || null;
        selectedNode = null;
        askTarget = 'user';
        pendingAsk = null;
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
      // A saved team's members checked against the comparisons (owner, 2026-11-08). The host used to post this with no handler here, so the suggestion was
      // dropped silently; it now shows above the team with the members it would change and a way to act on it.
      case 'model-suggestion': {
        const changes = Array.isArray(message.changes) ? message.changes : [];
        const box = $('suggestion');
        if (box) {
          box.replaceChildren();
          box.hidden = !changes.length;
          if (changes.length) {
            box.append(el('strong', '', 'The comparisons suggest a different model'));
            const list = el('ul', 'issues');
            for (const entry of changes) list.append(el('li', '', `${entry.member}: ${entry.model}${entry.current ? ' (now ' + entry.current + ')' : ''}${entry.why ? ' — ' + entry.why : ''}`));
            // 0.4.19 review: this was labelled "Review in Compare Models" but posted `optimise-all`, which RUNS role tests for every team and rewrites their
            // files. It now says what it does, and the suggestion itself is only advice until the person clicks it.
            box.append(list, button('Test every team and set the models', () => vscode.postMessage({ type: 'optimise-all' }), { link: true, label: 'Run the role tests for EVERY team, not only this one, and set each member model from the result' }));
          }
        }
        if (message.text) { showBanner(message.text, 'info'); announce(message.text); }
        break;
      }
      case 'team-proposal':
        drafting = false;
        proposal = { proposal: message.proposal, draft: message.draft || null, problems: message.problems || [] };
        if (work && work.mode === 'wizard' && work.stage === 'ai') {
          focusLater('proposal-title');
          render();
          announce('The team has been drafted. Review it, then use it or start over.');
        } else {
          // The person left the AI start while it was drafting: the team waits on the main page and the New team screens (the host keeps it too), never
          // dropped and never forced on screen; an open editor or builder step is left as it is.
          if (!work || (work.mode === 'wizard' && work.stage !== 'steps')) render();
          announce('The team you described is drafted. Review it from Team Studio\'s main page or New team.');
        }
        break;
      case 'improve-checked': {
        const imp = work && work.improve;
        if (!imp || message.seq !== imp.seq) break;
        imp.findings = Array.isArray(message.findings) ? message.findings : [];
        imp.ai = message.ai || null;
        imp.state = 'checked';
        render();
        break;
      }
      case 'improve-state': {
        const imp = work && work.improve;
        if (!imp || message.seq !== imp.seq) break;
        imp.state = 'requesting'; imp.model = message.model;
        render();
        break;
      }
      case 'improve-result': {
        const imp = work && work.improve;
        // A reply to an older request, or to one that was cancelled here, is dropped.
        if (!imp || message.seq !== imp.seq || imp.state !== 'requesting') break;
        imp.state = message.state;
        imp.reason = message.reason || null;
        imp.suggestions = (message.suggestions || []).map((item) => Object.assign({}, item, { status: 'pending' }));
        imp.dropped = message.dropped || [];
        imp.partial = Boolean(message.partial);
        imp.summary = message.summary || null;
        imp.rating = message.rating || null;
        if (message.note && imp.ai) imp.ai.note = message.note;
        if (typeof message.findings === 'number') { imp.findingsBefore = message.findings; imp.findingsNow = undefined; }
        render();
        announce(message.state === 'reviewing' ? imp.suggestions.length + ' suggestion' + (imp.suggestions.length === 1 ? '' : 's') + ' to review.' : (message.reason || 'The AI review has nothing to change.'));
        break;
      }
      case 'improve-applied': {
        const imp = work && work.improve;
        if (!imp || message.seq !== imp.seq) break;
        let accepted = 0;
        for (const result of message.results || []) {
          const item = imp.suggestions.find((entry) => entry.id === result.id);
          if (!item) continue;
          if (result.state === 'accepted') { item.status = 'accepted'; item.note = null; item.editing = false; accepted += 1; }
          else if (result.state === 'stale' || result.state === 'invalid') { item.status = result.state; item.note = result.reason || null; item.editing = false; }
          else item.note = result.reason || null;
        }
        if (accepted) {
          work.draft = message.draft;
          if (typeof message.findings === 'number') imp.findingsNow = message.findings;
          // A team made from a built-in template: Update Team treats a member you changed as yours and asks before replacing it. Said once.
          const entry = work.mode === 'editor' ? (lib.teams || []).find((team) => team.id === work.id) : null;
          if (entry && entry.update && !imp.templateNote) imp.templateNote = 'Accepted changes make these members yours: Update Team will ask before replacing them with a newer template.';
        }
        changed(true);
        announce(accepted ? 'Accepted ' + accepted + ' suggestion' + (accepted === 1 ? '' : 's') + '. The draft changed; Save to keep it.' : 'Nothing was accepted.');
        break;
      }
      case 'review':
        if (!work || message.seq !== seq) break;
        work.review = { markdown: message.markdown, errors: message.errors, warnings: message.warnings, notes: Array.isArray(message.notes) ? message.notes : [], members: message.members };
        fillReview();
        updateDirty();
        break;
      case 'starting-point': {
        // The reply to the request the buttons wait on frees them, even when it is dropped below; a reply to any other request leaves them as they are.
        if (work && work.mode === 'wizard' && work.busy && work.busyFor === 'start:' + message.seq) { work.busy = false; work.busyFor = null; if (work.stage === 'pick' || work.stage === 'recommend') render(); }
        // Only the reply to the request still waiting, matched by its number: one for a screen the person has left (Back, another team) is dropped.
        const pending = work && work.mode === 'wizard' ? work.awaitingStart : null;
        if (!pending || pending.id !== message.id || pending.seq !== message.seq) break;
        // The person left the picker: this reply is dropped for good, so a later one cannot move the builder either (PR #75 review).
        if (pending.clone && work.stage !== (pending.stage || 'pick')) { work.awaitingStart = null; break; }
        work.awaitingStart = null;
        const draft = message.draft;
        work.projectType = message.projectType || null;
        work.startingPoint = message.id;
        if (pending.legacy) {
          work.draft.members = draft.members;
          if (!work.draft.description.trim() && draft.description) work.draft.description = draft.description;
          announce('Added ' + draft.members.length + ' members from the starting point.');
          goStep(1);
          requestReview();
          break;
        }
        // Clone and modify: the members are the team's; the name and description are filled in where they are empty, the default, or what an
        // earlier clone filled in, so nothing the person wrote is replaced.
        const before = work.cloned || {};
        const cloned = {};
        // The copy's name is the host's, resolved against the library when it sent the members; the page never makes one up (PR #75 review).
        if (typeof message.cloneName === 'string' && message.cloneName && (!work.draft.name.trim() || work.draft.name === work.defaultName || work.draft.name === before.name)) { work.draft.name = message.cloneName.slice(0, 80); cloned.name = work.draft.name; }
        const description = (pending.goal || '').trim() || draft.description || '';
        if (!work.draft.description.trim() || work.draft.description === before.description) { work.draft.description = description.slice(0, 600); cloned.description = work.draft.description; }
        work.draft.members = draft.members;
        work.cloned = cloned;
        work.path = pending.path;
        work.stage = 'steps';
        work.step = 0;
        announce('Cloned ' + pending.label + ': ' + draft.members.length + ' member' + (draft.members.length === 1 ? '' : 's') + '. Name the new team, say what it is for, and choose where to save it.');
        focusLater('step-heading');
        render();
        requestReview();
        break;
      }
      case 'recommendation': {
        // Only the reply to the request still waiting, on the screen it was asked from.
        if (!work || work.mode !== 'wizard' || work.stage !== 'recommend' || work.recommendSeq === null || message.seq !== work.recommendSeq) break;
        // Made from answers that are no longer the ones on screen: not shown (answersChanged has normally ended the request already).
        if (!sameAnswers(message.answers, currentAnswers())) { work.recommendSeq = null; work.busy = false; work.busyFor = null; work.recommendStale = true; render(); break; }
        work.recommendSeq = null;
        work.busy = false;
        work.busyFor = null;
        work.recommendStale = false;
        work.recommendation = { answers: currentAnswers(), name: String(message.name || ''), ...(message.saveAs ? { saveAs: String(message.saveAs) } : {}), description: String(message.description || ''), members: Array.isArray(message.members) ? message.members.map((member) => ({ name: String(member.name || ''), role: String(member.role || '') })) : [] };
        render();
        announce('Recommended ' + work.recommendation.name + ': ' + work.recommendation.members.length + ' members. Use it as it is, or clone it and change it.');
        break;
      }
      case 'used':
        // Use as is was declined (the project's team, or the builder's unsaved work, is kept): nothing changed, so the builder stays where it is.
        if (message.declined) { if (work && work.mode === 'wizard') { work.busy = false; work.busyFor = null; render(); } if (message.text) { showBanner(message.text, 'info'); announce(message.text); } break; }
        askTarget = 'user';
        pendingAsk = null;
        // Use as is finished without a project team to open (a saved team put in the chat, or a built-in saved to My teams first): back to the library.
        if (work && work.mode === 'wizard') work = null;
        flash = message.focus || null;
        render();
        if (message.text) { showBanner(message.text, 'info'); announce(message.text); }
        break;
      case 'icon-source': {
        // The picture the host checked: made into the icon here, then sent back to be checked again and saved. A picture this page cannot read is
        // reported, and the host is told so it stops waiting.
        if (!work || work.mode !== 'editor' || work.id !== message.id) break;
        const seq = message.seq;
        normaliseIcon(String(message.mime || ''), String(message.data || '')).then((png) => {
          vscode.postMessage({ type: 'icon-set', seq, id: message.id, png });
        }, (error) => {
          vscode.postMessage({ type: 'icon-failed', seq });
          if (work && work.mode === 'editor') { work.iconBusy = false; render(); }
          showBanner(error instanceof IconTooDetailed
            ? 'The picture is too detailed to use as an icon, even with fewer colours, so the icon was not changed. Choose a simpler picture, such as a logo or a symbol on a plain background.'
            : 'The picture could not be read as an image, so the icon was not changed. Try a PNG, JPEG or WebP image.', 'error');
        });
        break;
      }
      case 'icon-updated':
        if (work && work.mode === 'editor' && work.id === message.id) {
          work.icon = message.icon || null;
          // The earlier icons changed too: asked for again when History is open, and dropped otherwise until it opens.
          work.iconHistory = null;
          if (work.tab === TAB_HISTORY) vscode.postMessage({ type: 'versions', id: work.id });
          // The team file gained or lost its icon line; the host moved this editor to that version, so a save is not taken for an outside edit.
          if (message.base) work.base = message.base;
          work.iconBusy = false;
          render();
        }
        if (message.text) { showBanner(message.text, 'info'); announce(message.text); }
        break;
      case 'icon-done':
        if (work && work.mode === 'editor' && work.id === message.id && work.iconBusy) { work.iconBusy = false; render(); }
        if (message.text) { showBanner(message.text, 'info'); announce(message.text); }
        break;
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
        if (work && work.mode === 'editor' && work.id === message.id) { work.versions = message.versions; if (Array.isArray(message.iconHistory)) work.iconHistory = message.iconHistory; if (work.tab === TAB_HISTORY) render(); }
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
        // A failed draft leaves the ask box replaced by "Drafting the team..." with no way back, because only team-proposal cleared this: clear it and
        // draw the box again so the person can retry or change what they wrote.
        if (drafting) { drafting = false; if (work && work.mode === 'wizard' && work.stage === 'ai') render(); }
        // The project's team was written, but a step after it failed (the host says which): the builder's work is saved, so it closes, and the
        // listing shows the new team.
        if (message.written && work && work.mode === 'wizard') { work = null; render(); break; }
        // A starting point that could not be read, or a Use as is that failed: their buttons work again. An error for a numbered starting-point
        // request counts only when it is the request they wait on (PR #75 review).
        if (work && work.mode === 'wizard' && (message.seq === undefined || work.busyFor === 'start:' + message.seq)) { work.awaitingStart = null; work.recommendSeq = null; if (work.busy) { work.busy = false; work.busyFor = null; render(); } }
        // A rating that was not saved: the cards show the saved ratings again. (One still waiting to be sent is kept: the error was about something else.)
        // With the builder or an editor open the cards are not on the page; they are drawn from the saved ratings when the dashboard comes back.
        if (pendingRating.size) { for (const id of [...pendingRating.keys()]) if (!ratingQueue.has(id)) pendingRating.delete(id); if (!work) render(); }
        // An icon request that was refused or failed: its buttons work again.
        if (work && work.mode === 'editor' && work.iconBusy) { work.iconBusy = false; render(); }
        break;
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
