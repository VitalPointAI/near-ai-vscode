// The docs say what the code does (OFFL-02, D-27, D-34): SECURITY.md and README carry the exact strings the code owns (the clearance is self-declared, a
// manifest is a claim, a local server runs with your permissions), name the two commands as the package contributes them, and match the code's numbers.
// The new sections have no em-dash and never say "NEAR organization". Pure: reads the repository's own files, no vscode.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { CLEARANCE_SELF_ASSERTED_TEXT } from '../domain/gate/labels';
import { BUNDLE_FAILURES } from '../domain/gate/bundle';
import { MANIFEST_IS_A_CLAIM_TEXT, RUNS_ON_THIS_MACHINE_TEXT } from '../domain/gate/words';
import { MAX_DECISION_LOG_BYTES, MAX_ROTATED_FILES } from '../gate/decisionLog';

const ROOT = path.resolve(__dirname, '..', '..');
const SECURITY = readFileSync(path.join(ROOT, 'SECURITY.md'), 'utf8');
const README = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const MANIFEST = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { contributes: { commands: Array<{ command: string; title: string; category?: string }> } };

const EM_DASH = '—';
const POLICY_HEADING = '### Your policy file and decision records';

// From a heading line to the next heading of the same or a higher level (or the end of the file).
function sectionOf(text: string, heading: string): string {
  const start = text.indexOf(`\n${heading}\n`);
  assert.ok(start >= 0, `${heading} exists`);
  const level = heading.match(/^#+/)?.[0].length ?? 1;
  const body = text.slice(start + 1);
  const next = body.slice(heading.length + 1).search(new RegExp(`\\n#{1,${String(level)}} `));
  return next < 0 ? body : body.slice(0, heading.length + 1 + next);
}

function commandName(id: string): string {
  const entry = MANIFEST.contributes.commands.find((command) => command.command === id);
  assert.ok(entry, `${id} is contributed`);
  return `${entry.category ?? ''}: ${entry.title}`;
}

const flat = (text: string): string => text.replace(/\s+/g, ' ');
const policySection = sectionOf(SECURITY, POLICY_HEADING);
const mcpSection = sectionOf(SECURITY, '## MCP connections');
const readmeMcp = sectionOf(README, '### MCP connections');
const readmePolicy = README.slice(README.indexOf('- **Your policy.**'), README.indexOf("- API keys live in VS Code's encrypted"));

test('SECURITY.md has the policy section once, after "What the agent can do without asking" and before the sub-agent section', () => {
  assert.equal(SECURITY.split(POLICY_HEADING).length - 1, 1);
  const here = SECURITY.indexOf(POLICY_HEADING);
  assert.ok(SECURITY.indexOf('### What the agent can do without asking') < here);
  assert.ok(here < SECURITY.indexOf('### Sub-agents nobody is watching'));
});

test('the policy section carries the code\'s clearance text word for word, and that text still begins "Until verified credentials arrive"', () => {
  assert.ok(CLEARANCE_SELF_ASSERTED_TEXT.startsWith('Until verified credentials arrive'));
  assert.ok(policySection.includes(CLEARANCE_SELF_ASSERTED_TEXT));
});

test('the commands the docs name are the ones package.json contributes, and the failure sentences name the same reset command', () => {
  const reset = commandName('nearAi.policy.reset');
  const show = commandName('nearAi.policy.show');
  assert.equal(reset, 'NEAR AI: Reset Policy to Defaults');
  assert.equal(show, 'NEAR AI: Show Policy');
  for (const text of [policySection, readmePolicy]) {
    assert.ok(flat(text).includes(reset), 'Reset Policy to Defaults');
    assert.ok(flat(text).includes(show), 'Show Policy');
  }
  assert.ok(flat(README).includes(reset) && flat(README).includes(show));
  for (const sentence of Object.values(BUNDLE_FAILURES)) {
    if (sentence.includes('Reset Policy to Defaults')) assert.ok(sentence.includes(reset), sentence);
  }
});

test('the policy section says what the code does: own storage not the project, own device key (created at activation in every folder), default allows what settings allow, only the command re-signs, no network, records redacted and not synced, labels not used yet', () => {
  for (const phrase of [
    "this extension's own storage",
    'never in your project',
    'Your own device key',
    "creates this install's device identity in every folder",
    'because it signs the first policy file',
    'allows what your settings allow',
    'only reading and planning run',
    'Deleting the file does not reset a policy',
    'Only that command re-signs a policy that failed',
    'keeps the old file beside the new one',
    'records the reset',
    'Nothing in a decision needs the network',
    'secrets are removed',
    'Records are not synced',
    'does not use them yet'
  ]) {
    assert.ok(flat(policySection).includes(phrase), phrase);
  }
});

test('the numbers in the policy section match the decision log\'s own limits', () => {
  assert.equal(MAX_DECISION_LOG_BYTES, 5 * 1024 * 1024);
  assert.equal(MAX_ROTATED_FILES, 4);
  assert.match(flat(policySection), /rolls over at about 5 MB and keeps the last four older files/);
});

test('SECURITY.md\'s MCP section says what plan 10 shipped: declared tools, restrictive new servers, a local server runs with your permissions, a manifest is a claim', () => {
  assert.ok(mcpSection.includes(MANIFEST_IS_A_CLAIM_TEXT));
  assert.ok(mcpSection.includes(RUNS_ON_THIS_MACHINE_TEXT));
  assert.match(mcpSection, /Servers added from this version on/);
  assert.match(mcpSection, /"What it does" menu/);
  assert.match(flat(mcpSection), /every mode except `fully-autonomous`/);
  assert.match(mcpSection, /behave as they did/);
});

test('README names the two commands, points to the SECURITY.md section, and repeats the MCP changes in its own words', () => {
  assert.ok(readmePolicy.includes('(SECURITY.md#your-policy-file-and-decision-records)'));
  assert.ok(readmeMcp.includes(MANIFEST_IS_A_CLAIM_TEXT));
  assert.match(flat(readmeMcp), /with your permissions/);
  assert.match(flat(readmeMcp), /every mode except `fully-autonomous`/);
});

test('this plan leaves the floor text and the fully-autonomous limitation as they were (plan 17 changes them with the code)', () => {
  assert.ok(flat(SECURITY).includes('Under `fully-autonomous` they run without asking (see Known limitations).'));
  assert.ok(SECURITY.includes('| Under `fully-autonomous`, the agent runs commands, reads likely credential files, and writes protected files'));
  assert.ok(flat(SECURITY).includes('every other tool asks in every mode, including fully-autonomous'));
});

test('the new sections have no em-dash and never say NEAR organization', () => {
  for (const [name, text] of [['policy section', policySection], ['MCP section', mcpSection], ['README policy', readmePolicy], ['README MCP', readmeMcp]] as const) {
    assert.ok(text.length > 100, name);
    assert.ok(!text.includes(EM_DASH), `${name} has no em-dash`);
    assert.doesNotMatch(text, /NEAR organization/i, name);
  }
});
