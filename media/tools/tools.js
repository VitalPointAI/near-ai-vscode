// NEAR AI Tools: a directory of what the agents can use. The host sends the whole directory; all of
// it is rendered with textContent. Buttons only ask the host to prefill the chat, open a setting,
// run an existing NEAR AI command, or switch an MCP server on for this project.
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined && text !== null) node.textContent = String(text); return node; };
  const button = (label, onClick, options) => {
    const node = el('button', options && options.secondary ? 'secondary' : '', label);
    node.type = 'button';
    if (options && options.label) node.setAttribute('aria-label', options.label);
    node.addEventListener('click', onClick);
    return node;
  };
  const GROUP_ORDER = ['Project lifecycle', 'Planning', 'Execution', 'Review and quality', 'Research and context', 'Settings and workspace', 'Other'];
  const STATUS_CLASS = { runs: 'ok', asks: 'ask', 'auto-checked': 'checked', off: 'off', stopped: 'stopped' };
  const PRIVACY_LABEL = { tee: 'TEE', local: 'Local', forwarded: 'Forwarded', unknown: 'Unknown' };

  const useInChat = (text, name) => button('Use in chat', () => vscode.postMessage({ type: 'use-in-chat', text }), { label: 'Use ' + name + ' in chat' });
  const runCommand = (label, command, secondary) => button(label, () => {
    if (command.startsWith('setting:')) vscode.postMessage({ type: 'open-setting', key: command.slice(8) });
    else vscode.postMessage({ type: 'run-command', command });
  }, { secondary: secondary !== false });
  const badge = (text, kind, title) => { const node = el('span', 'badge' + (kind ? ' ' + kind : ''), text); if (title) node.title = title; return node; };
  // Each searchable row keeps its words so one search box filters every section.
  const row = (tag, words) => { const node = el(tag, 'item'); node.dataset.search = words.filter(Boolean).join(' ').toLowerCase(); return node; };
  const money = (value) => value === undefined ? undefined : '$' + (value < 0.01 && value > 0 ? value.toPrecision(2) : value.toFixed(2).replace(/\.00$/, ''));
  const tokens = (value) => value >= 1000000 ? (value / 1000000).toFixed(value % 1000000 ? 1 : 0) + 'M' : value >= 1000 ? Math.round(value / 1000) + 'K' : String(value);

  function renderPolicy(policy) {
    const node = $('policy');
    node.replaceChildren();
    node.className = 'policy' + (policy.stopped ? ' stopped' : '');
    if (policy.stopped) {
      node.append(el('strong', '', 'Emergency stop is on.'), document.createTextNode(' Nothing runs until you resume. '), runCommand('Resume', 'nearAi.resume', false));
      return;
    }
    node.append(document.createTextNode('Approval mode: '), el('strong', '', policy.label), document.createTextNode(' — ' + policy.summary + ' Change it from the picker under the chat box.'));
  }

  function renderSkills(data) {
    const root = $('skills');
    root.replaceChildren();
    root.append(el('p', 'hint', data.gsd.installed
      ? 'Open-GSD ' + (data.gsd.version || '') + ' · ' + data.skills.length + ' installed workflows and skills. Type / in the chat to see the same list.'
      : 'Open-GSD is not installed yet; it installs the first time you run a workflow. These are the core workflows.'));
    const groups = new Map();
    for (const skill of data.skills) { if (!groups.has(skill.group)) groups.set(skill.group, []); groups.get(skill.group).push(skill); }
    const order = [...GROUP_ORDER.filter((group) => groups.has(group)), ...[...groups.keys()].filter((group) => !GROUP_ORDER.includes(group))];
    for (const group of order) {
      const wrap = el('div', 'group');
      const id = 'group-' + group.toLowerCase().replace(/[^a-z]+/g, '-');
      const heading = el('h3', '', group); heading.id = id;
      const list = el('ul', 'list'); list.setAttribute('aria-labelledby', id);
      for (const skill of groups.get(group)) {
        const item = row('li', [skill.name, skill.description, skill.argumentHint, group]);
        const head = el('div', 'item-head');
        head.append(el('code', 'name', '/' + skill.name));
        if (skill.argumentHint) head.append(el('span', 'hint args', skill.argumentHint));
        head.append(useInChat(skill.insert, '/' + skill.name));
        item.append(head);
        if (skill.description) item.append(el('p', 'desc', skill.description));
        list.append(item);
      }
      wrap.append(heading, list);
      root.append(wrap);
    }
  }

  function modelLine(tier, model, extra) {
    const node = el('span', 'model');
    node.append(badge(tier === 'inherit' ? 'main model' : tier === 'model' ? 'own model' : tier, 'tier'), el('code', '', model));
    if (extra) node.append(el('span', 'hint', ' (' + extra + ')'));
    return node;
  }

  function renderAgents(data) {
    const root = $('agents');
    root.replaceChildren();
    const teamsHead = el('h3', '', 'Teams'); teamsHead.id = 'teams-title';
    const teamActions = el('div', 'actions');
    teamActions.append(runCommand('Manage teams', 'nearAi.manageTeams'), runCommand('Set up project team', 'nearAi.setupProjectTeam'));
    root.append(teamsHead, teamActions);
    if (!data.teams.length) root.append(el('p', 'hint', 'No reusable teams yet. A team is a Markdown file listing its members; run one with /team:<name> <task>.'));
    const teams = el('ul', 'list'); teams.setAttribute('aria-labelledby', 'teams-title');
    for (const team of data.teams) {
      const item = row('li', [team.name, team.description, team.command, ...team.members.map((member) => member.name + ' ' + (member.role || '') + ' ' + member.model)]);
      const head = el('div', 'item-head');
      head.append(el('strong', 'name', team.name), el('code', 'hint', '/' + team.command), useInChat(team.insert, '/' + team.command));
      if (team.project) head.append(badge('this project', 'tier'));
      item.append(head);
      if (team.description) item.append(el('p', 'desc', team.description));
      const members = el('ul', 'members');
      for (const member of team.members) {
        const line = el('li');
        line.append(el('span', 'member', member.name + (member.role ? ' — ' + member.role : '')), document.createTextNode(' '), modelLine(member.tier, member.model));
        if (member.tools.length) line.append(el('span', 'hint', ' · tools: ' + member.tools.join(', ')));
        members.append(line);
      }
      item.append(members);
      teams.append(item);
    }
    root.append(teams);
    for (const problem of data.teamProblems) root.append(el('p', 'error', problem));

    const agentsHead = el('h3', '', 'Agent roles'); agentsHead.id = 'roles-title';
    root.append(agentsHead, el('p', 'hint', 'Workflows start these as sub-agents. The model comes from nearAi.agent.roleModels for the role, else the tier in its definition (deep, standard, fast → nearAi.agent.deepModel, standardModel, fastModel).'));
    if (!data.agents.length) root.append(el('p', 'hint', data.gsd.installed ? 'This Open-GSD version defines no agent roles.' : 'Agent roles appear once Open-GSD is installed.'));
    const roles = el('ul', 'list'); roles.setAttribute('aria-labelledby', 'roles-title');
    for (const agent of data.agents) {
      const item = row('li', [agent.name, agent.description, agent.tier, agent.model]);
      const head = el('div', 'item-head');
      head.append(el('code', 'name', agent.name), modelLine(agent.tier, agent.model, agent.source === 'role setting' ? 'from roleModels' : agent.source === 'default' ? 'no tier set' : ''));
      item.append(head);
      if (agent.description) item.append(el('p', 'desc', agent.description));
      if (agent.tools.length) item.append(el('p', 'hint', 'Tools: ' + agent.tools.join(', ')));
      roles.append(item);
    }
    root.append(roles);
  }

  function statusBadge(status, text) { return badge(text, 'status ' + (STATUS_CLASS[status] || '')); }

  function renderTools(data) {
    const root = $('tools');
    root.replaceChildren();
    root.append(el('p', 'hint', 'Built-in tools every agent run is given, and what each does under your approval mode right now.'));
    const list = el('ul', 'list'); list.setAttribute('aria-labelledby', 'tools-title');
    for (const tool of data.tools) {
      const item = row('li', [tool.name, tool.description, tool.capability, tool.statusText, ...tool.notes]);
      const head = el('div', 'item-head');
      head.append(el('code', 'name', tool.name), badge(tool.capability, 'capability', 'Capability'), statusBadge(tool.status, tool.statusText));
      if (tool.setup) head.append(runCommand(tool.setup.label, tool.setup.command));
      item.append(head, el('p', 'desc', tool.description));
      for (const note of tool.notes) item.append(el('p', 'hint', note));
      list.append(item);
    }
    root.append(list);
  }

  function renderMcp(data) {
    const root = $('mcp');
    root.replaceChildren();
    const actions = el('div', 'actions');
    actions.append(runCommand('Manage MCP connections', 'nearAi.manageMcp'));
    root.append(actions);
    if (!data.mcp.length) { root.append(el('p', 'hint', 'No MCP servers yet. Add one under Manage MCP connections; switch it on for a project to give agents its tools.')); return; }
    const list = el('ul', 'list'); list.setAttribute('aria-labelledby', 'mcp-title');
    for (const server of data.mcp) {
      const item = row('li', [server.name, server.host, server.state, ...server.tools.map((tool) => tool.name + ' ' + tool.description)]);
      const head = el('div', 'item-head');
      head.append(el('strong', 'name', server.name), badge(server.enabledHere ? 'on for this project' : 'off for this project', server.enabledHere ? 'status ok' : 'status off'), badge(server.state, 'tier'));
      head.append(button(server.enabledHere ? 'Switch off here' : 'Switch on here', () => vscode.postMessage({ type: 'mcp-enable', id: server.id, enabled: !server.enabledHere }), { secondary: true, label: (server.enabledHere ? 'Switch off ' : 'Switch on ') + server.name + ' for this project' }));
      if (server.enabledHere && server.state !== 'connected') head.append(button('Connect', () => vscode.postMessage({ type: 'mcp-connect', id: server.id }), { secondary: true, label: 'Connect to ' + server.name + ' to list its tools' }));
      item.append(head);
      if (server.host) item.append(el('p', 'hint', server.transport + ' · ' + server.host));
      if (server.error) item.append(el('p', 'error', server.error));
      if (!server.tools.length) item.append(el('p', 'hint', server.state === 'connected' ? 'This server lists no tools.' : 'Its tools are listed once it connects (when an agent first uses it, or with Connect).'));
      else {
        const tools = el('ul', 'members');
        for (const tool of server.tools) {
          const line = el('li');
          line.append(el('code', '', tool.agentName), document.createTextNode(' '), statusBadge(tool.status, tool.enabled ? tool.statusText : 'Switched off'), el('span', 'hint', ' ' + tool.description));
          tools.append(line);
        }
        item.append(tools);
      }
      list.append(item);
    }
    root.append(list);
  }

  function renderModels(data) {
    const root = $('models');
    root.replaceChildren();
    const uses = el('ul', 'uses'); uses.setAttribute('aria-label', 'Models your settings use');
    for (const use of data.settingsModels) {
      const line = el('li');
      line.append(el('span', 'use', use.use), el('code', '', use.model || '(not set)'));
      if (use.available === false) line.append(badge('not in your key’s list', 'status stopped'));
      line.append(button('Change', () => vscode.postMessage({ type: 'open-setting', key: use.setting }), { secondary: true, label: 'Change the ' + use.use + ' model setting' }));
      uses.append(line);
    }
    root.append(el('h3', '', 'Used by your settings'), uses);
    if (data.modelsProblem) root.append(el('p', 'hint', data.modelsProblem));
    if (!data.models.length) return;
    const head = el('h3', '', 'Available to your key'); head.id = 'catalog-title';
    const list = el('ul', 'list'); list.setAttribute('aria-labelledby', 'catalog-title');
    for (const model of data.models) {
      const item = row('li', [model.id, model.privacyText, PRIVACY_LABEL[model.privacy], ...model.kinds, ...model.usedFor]);
      const top = el('div', 'item-head');
      top.append(el('code', 'name', model.id), badge(PRIVACY_LABEL[model.privacy], 'privacy ' + model.privacy, model.privacyText));
      for (const use of model.usedFor) top.append(badge(use, 'tier'));
      item.append(top);
      const facts = [];
      if (model.contextLength) facts.push(tokens(model.contextLength) + ' context');
      if (model.inputPerMillion !== undefined || model.outputPerMillion !== undefined) facts.push((money(model.inputPerMillion) || '—') + ' in / ' + (money(model.outputPerMillion) || '—') + ' out per 1M tokens');
      if (model.imagePrice !== undefined) facts.push(money(model.imagePrice) + ' per image');
      if (model.kinds.length) facts.push(model.kinds.join(', '));
      facts.push(model.privacyText);
      item.append(el('p', 'hint', facts.join(' · ')));
      list.append(item);
    }
    root.append(head, list);
  }

  function renderElsewhere() {
    const root = $('elsewhere');
    root.replaceChildren();
    const list = el('ul', 'elsewhere');
    [['Agent activity and analytics', 'nearAi.openAgentActivity'], ['Export usage and activity', 'nearAi.exportAnalytics'], ['Conversation history', 'nearAi.showHistory'], ['Project memory', 'nearAi.manageMemory'], ['Spending limits', 'nearAi.spendingLimits']].forEach(([label, command]) => {
      const line = el('li'); line.append(runCommand(label, command)); list.append(line);
    });
    root.append(el('p', 'hint', 'Planning files and the chat’s task list are in the NEAR AI chat in the side bar.'), list);
  }

  function applyFilter() {
    const query = $('filter').value.trim().toLowerCase();
    let shown = 0;
    document.querySelectorAll('.item').forEach((item) => { const match = !query || item.dataset.search.includes(query); item.hidden = !match; if (match) shown += 1; });
    document.querySelectorAll('.group').forEach((group) => { group.hidden = Boolean(query) && !group.querySelector('.item:not([hidden])'); });
    $('empty-search').hidden = !query || shown > 0;
  }

  function render(data) {
    renderPolicy(data.policy);
    renderSkills(data);
    renderAgents(data);
    renderTools(data);
    renderMcp(data);
    renderModels(data);
    renderElsewhere();
    applyFilter();
  }

  $('filter').addEventListener('input', applyFilter);
  $('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  window.addEventListener('message', (event) => {
    const message = event.data || {};
    if (message.type === 'directory' && message.directory) render(message.directory);
    if (message.type === 'error') { const node = el('p', 'error', message.text); node.setAttribute('role', 'alert'); $('policy').after(node); setTimeout(() => node.remove(), 8000); }
  });
  vscode.postMessage({ type: 'ready' });
})();
