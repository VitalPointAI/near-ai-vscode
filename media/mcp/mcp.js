// MCP Connections page. Server data arrives without secrets; all of it is set with textContent.
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
  const button = (label, onClick, secondary) => { const node = el('button', secondary ? 'secondary' : '', label); node.type = 'button'; node.addEventListener('click', onClick); return node; };
  const APPROVAL = { 'ask-for-changes': 'Ask before changes (read-only tools follow your normal rules)', 'ask-every-call': 'Ask before every call', trusted: 'Trusted (your normal approval rules apply to every tool)' };
  const STATE = { connected: 'Connected', connecting: 'Connecting…', disconnected: 'Not connected', error: 'Error' };
  let project = '';

  function field(label, input, hint) {
    const wrap = el('label', 'field');
    wrap.append(el('span', 'field-label', label), input);
    if (hint) wrap.append(el('span', 'hint', hint));
    return wrap;
  }
  function input(type, value, placeholder) { const node = document.createElement(type === 'textarea' ? 'textarea' : 'input'); if (type !== 'textarea') node.type = type; node.value = value || ''; if (placeholder) node.placeholder = placeholder; return node; }
  function lines(text) { return text.split('\n').map((line) => line.trim()).filter(Boolean); }
  function keyValues(text, separator) { return lines(text).map((line) => { const at = line.indexOf(separator); return at > 0 ? [line.slice(0, at).trim(), line.slice(at + 1).trim()] : null; }).filter(Boolean); }

  function showForm(server) {
    const form = $('form');
    form.hidden = false;
    const editing = Boolean(server);
    const name = input('text', server ? server.config.name : '', 'Product catalog');
    const transport = document.createElement('select');
    [['http', 'Remote (URL)'], ['stdio', 'Runs on this computer (command)']].forEach(([value, label]) => { const option = el('option', '', label); option.value = value; transport.append(option); });
    transport.value = server ? server.config.transport : 'http';
    const url = input('password', '', editing && server.hasSecrets.url ? 'Stored; leave blank to keep it' : 'https://…');
    const headers = input('textarea', '', editing && server.hasSecrets.headers.length ? 'Stored: ' + server.hasSecrets.headers.join(', ') + ' (leave blank to keep)' : 'Authorization: Bearer …\nX-Api-Key: …');
    const command = input('text', server ? server.config.command : '', 'npx');
    const args = input('textarea', server ? (server.config.args || []).join('\n') : '', '-y\n@example/mcp-server');
    const env = input('textarea', '', editing && server.hasSecrets.env.length ? 'Stored: ' + server.hasSecrets.env.join(', ') + ' (leave blank to keep)' : 'API_KEY=…');
    const approval = document.createElement('select');
    Object.entries(APPROVAL).forEach(([value, label]) => { const option = el('option', '', label); option.value = value; approval.append(option); });
    approval.value = server ? server.config.approval : 'ask-for-changes';
    const remote = el('div', 'group');
    remote.append(field('URL', url, 'Kept secret: some servers put the access token in the URL.'), field('Headers (one per line, Name: value)', headers, 'Values are stored in secret storage.'));
    const local = el('div', 'group');
    local.append(field('Command', command), field('Arguments (one per line)', args), field('Environment variables (one per line, NAME=value)', env, 'Only these are passed, with a minimal PATH and HOME; values are stored in secret storage.'));
    const sync = () => { remote.hidden = transport.value !== 'http'; local.hidden = transport.value !== 'stdio'; };
    transport.addEventListener('change', sync);
    sync();
    const save = button(editing ? 'Save' : 'Add', () => vscode.postMessage({
      type: 'save', ...(editing ? { id: server.config.id } : {}), name: name.value, transport: transport.value, approval: approval.value,
      url: url.value, headers: keyValues(headers.value, ':'), command: command.value, args: lines(args.value), env: keyValues(env.value, '=')
    }));
    const cancel = button('Cancel', () => { form.hidden = true; form.replaceChildren(); }, true);
    const title = el('h2', '', editing ? 'Edit ' + server.config.name : 'Add an MCP server');
    title.id = 'form-title';
    form.replaceChildren(title, field('Name', name), field('Type', transport), remote, local, field('Approval', approval, 'Tools that can change data ask first in every mode unless the server is Trusted.'), el('div', 'actions'));
    form.querySelector('.actions').append(save, cancel);
    name.focus();
  }

  function card(server) {
    const box = el('article', 'server state-' + server.state);
    const head = el('div', 'server-head');
    head.append(el('span', 'dot'), el('h3', '', server.config.name), el('span', 'state', STATE[server.state] + (server.serverInfo ? ' · ' + server.serverInfo : '')));
    box.append(head);
    const where = server.config.transport === 'http' ? (server.host || 'no URL set') : [server.config.command].concat(server.config.args || []).join(' ');
    box.append(el('p', 'where', (server.config.transport === 'http' ? 'Remote: ' : 'Runs locally: ') + where));
    if (server.error) box.append(el('p', 'error', server.error));
    const controls = el('div', 'controls');
    const here = document.createElement('input');
    here.type = 'checkbox';
    here.checked = server.enabledHere;
    here.addEventListener('change', () => vscode.postMessage({ type: 'enable-here', id: server.config.id, enabled: here.checked }));
    const hereLabel = el('label', 'toggle');
    hereLabel.append(here, document.createTextNode(' On for this project' + (project ? ' (' + project + ')' : '')));
    const approval = document.createElement('select');
    approval.setAttribute('aria-label', 'Approval for ' + server.config.name);
    Object.entries(APPROVAL).forEach(([value, label]) => { const option = el('option', '', label); option.value = value; approval.append(option); });
    approval.value = server.config.approval;
    approval.addEventListener('change', () => vscode.postMessage({ type: 'approval', id: server.config.id, approval: approval.value }));
    controls.append(hereLabel, approval);
    box.append(controls);
    const stats = el('p', 'stats', server.calls ? server.calls + ' call' + (server.calls === 1 ? '' : 's') + (server.errors ? ' (' + server.errors + ' failed)' : '') + (server.averageMs !== undefined ? ' · ' + server.averageMs + ' ms average' : '') + (server.lastUsed ? ' · last used ' + new Date(server.lastUsed).toLocaleTimeString() : '') : 'Not used this session.');
    box.append(stats);
    if (server.tools.length) {
      const details = el('details', 'tools');
      details.append(el('summary', '', server.tools.length + ' tools (' + (server.tools.length - (server.config.disabledTools || []).length) + ' on)'));
      const list = el('ul');
      server.tools.forEach((tool) => {
        const item = el('li');
        const box2 = document.createElement('input');
        box2.type = 'checkbox';
        box2.checked = !(server.config.disabledTools || []).includes(tool.name);
        box2.addEventListener('change', () => vscode.postMessage({ type: 'tool', id: server.config.id, tool: tool.name, enabled: box2.checked }));
        const label = el('label');
        label.append(box2, el('code', '', ' ' + tool.name), el('span', 'tag', tool.readOnly && !tool.destructive ? 'read-only' : tool.destructive ? 'can delete' : 'can change data'));
        item.append(label, el('p', 'hint', tool.description));
        list.append(item);
      });
      details.append(list);
      box.append(details);
    }
    const actions = el('div', 'actions');
    actions.append(server.state === 'connected' ? button('Disconnect', () => vscode.postMessage({ type: 'disconnect', id: server.config.id }), true) : button(server.state === 'error' ? 'Retry' : 'Connect and list tools', () => vscode.postMessage({ type: 'connect', id: server.config.id })), button('Edit', () => showForm(server), true), button('Remove', () => vscode.postMessage({ type: 'remove', id: server.config.id }), true));
    box.append(actions);
    return box;
  }

  window.addEventListener('message', (event) => {
    const message = event.data || {};
    if (message.type === 'state') {
      project = message.project || '';
      $('servers').replaceChildren(...(message.servers || []).map(card));
      $('empty').hidden = (message.servers || []).length > 0;
    }
    if (message.type === 'error') {
      const banner = el('p', 'error error-banner', message.text);
      banner.setAttribute('role', 'alert');
      document.querySelector('header').append(banner);
      setTimeout(() => banner.remove(), 8000);
    }
    if (message.type === 'state' && message.saved) { $('form').hidden = true; $('form').replaceChildren(); }
  });
  $('add').addEventListener('click', () => showForm(null));
  vscode.postMessage({ type: 'ready' });
})();
