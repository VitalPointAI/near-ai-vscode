// DRAFT verifier: node verify-delegation.js <parent.did.json> <child.did.json> <prover-binary>
// 1) sandbox policyHash matches the referenced file, 2) authority is a subset
// of the parent's (our own monotonic check), 3) openshell-prover boundary check.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), { spawnSync } = require('child_process');
const [pf, cf, prover] = process.argv.slice(2);
const P = JSON.parse(fs.readFileSync(pf)), C = JSON.parse(fs.readFileSync(cf));
const dir = path.dirname(path.resolve(cf)); const errs = [];
const g = d => d.agentGuardrails;
const file = d => path.join(dir, g(d).sandbox.policyRef);
for (const d of [P, C]) { const h = 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(file(d))).digest('hex');
  if (h !== g(d).sandbox.policyHash) errs.push(`${d.id}: policyHash mismatch`); }
if (g(C).parent !== P.id) errs.push('child.parent is not the parent DID');
const a = g(P).authority, b = g(C).authority;
const sub = (x, y, what) => x.forEach(v => { if (!y.includes(v)) errs.push(`authority: ${what} '${v}' not granted by parent`); });
sub(b.network.hosts, a.network.hosts, 'network host');
b.mcp.forEach(m => { const pm = a.mcp.find(q => q.server === m.server); if (!pm) errs.push(`authority: mcp server '${m.server}' not granted`); else sub(m.tools, pm.tools, `mcp tool on ${m.server}`); });
sub(b.send.map(s => s.channel), a.send.map(s => s.channel), 'send channel');
if (b.schedule && !a.schedule) errs.push('authority: schedule not granted');
b['skill.write'].scope.forEach(s => { if (!a['skill.write'].scope.some(p => p === s || (p.endsWith('/**') && s.startsWith(p.slice(0, -2))))) errs.push(`authority: skill.write scope '${s}' outside parent`); });
const days = p => Number(/^P(\d+)D$/.exec(p)[1]);
if (b.spend.usd > a.spend.usd || days(b.spend.period) > days(a.spend.period)) errs.push(`authority: spend ${b.spend.usd}/${b.spend.period} exceeds parent ${a.spend.usd}/${a.spend.period}`);
if (b.delegation.maxDepth > a.delegation.maxDepth - 1) errs.push(`authority: delegation depth ${b.delegation.maxDepth} not below parent ${a.delegation.maxDepth}`);
if (Date.parse(b.expiry) > Date.parse(a.expiry)) errs.push(`authority: expiry ${b.expiry} after parent ${a.expiry}`);
const r = spawnSync(prover, ['check', file(C), '--boundary', file(P), '--output', 'json'], { encoding: 'utf8' });
const pr = JSON.parse(r.stdout);
if (pr.result !== 'within_boundary') errs.push(`sandbox: prover ${pr.result}${pr.counterexample ? ' :: ' + JSON.stringify(pr.counterexample) : ''}${pr.reason ? ' :: ' + pr.reason : ''}`);
console.log(`${C.id} under ${P.id}: ${errs.length ? 'REJECT' : 'ACCEPT'} (prover: ${pr.result}, coverage ${pr.coverage.domains.join(',')})`);
errs.forEach(e => console.log('  - ' + e)); process.exit(errs.length ? 1 : 0);
