const { decidePermission, DEFAULT_RULES, RunGrants } = require('../../dist/agent/permissions.js');
const policy = (mode) => ({ mode, emergencyStop: false });
for (const cmd of ['curl -sS -o /home/x/a.html https://example.test/x', 'gh pr view 12']) {
  for (const mode of ['approve-risky', 'mostly-autonomous', 'auto', 'fully-autonomous']) {
    console.log(mode, JSON.stringify(cmd), '->', JSON.stringify(decidePermission('shell', cmd, policy(mode), DEFAULT_RULES, new RunGrants(), { root: '', cwd: '' })));
  }
}
