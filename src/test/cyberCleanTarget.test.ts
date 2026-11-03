// CYBER-07 measured, not assumed: the patched twin scanned by the full built-in probe set yields
// none of the seeded-issue check ids, and the summary of that empty result still names every check
// that could not run because a host tool is not installed (research Pitfall 1, CYBER-12).

import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { RunCheckpoints } from '../agent/checkpoints';
import { cyberProbes, type CyberProbeDeps } from '../agent/cyberProbes';
import { ShellSession } from '../agent/shell';
import type { ToolContext } from '../agent/tools';
import type { Finding, ResolvedScope } from '../domain/cyber';
import {
  detectTool,
  detectTools,
  installOffer,
  jsonFlagIsAssumed,
  missingToolsNote,
  TOOL_CATALOGUE,
  TOOL_NAMES
} from '../services/cyberTools';
import { startTarget, type FixtureTarget } from './cyberStartTarget';

/** Every check id the vulnerable fixture seeds; the patched twin must produce none of them. */
const SEEDED_CHECKS = [
  'missing-hsts',
  'missing-x-content-type-options',
  'missing-x-frame-options',
  'server-version-disclosure',
  'tls-certificate-expired',
  'tls-untrusted-chain',
  'tls-weak-protocol',
  'robots-disallowed-path',
  'committed-secret',
  'iac-public-ingress',
  'iac-unencrypted-storage',
  'iac-container-root',
  'iac-hardcoded-secret',
  'iac-unpinned-image',
  'iac-unpinned-action',
  'iac-privileged-container',
  'iac-missing-run-as-non-root',
  'vulnerable-dependency'
];

interface ScanRun { findings: Finding[]; output: string[] }

/** Runs every built-in probe against one fixture with the fixture's own directory as the scope. */
async function scanFixture(target: FixtureTarget): Promise<ScanRun> {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-cyber-clean-'));
  const shell = new ShellSession(root);
  const findings: Finding[] = [];
  const scope: ResolvedScope = {
    hosts: ['127.0.0.1'],
    ports: [Number(new URL(target.httpUrl).port), Number(new URL(target.tlsUrl).port)],
    paths: [target.fixtureDir],
    exclusions: []
  };
  const deps: CyberProbeDeps = {
    scope,
    inScope: (url, resolved) => {
      const actual = resolved ?? scope;
      try {
        const parsed = new URL(url);
        return actual.hosts.includes(parsed.hostname) && (!actual.ports.length || actual.ports.includes(Number(parsed.port)));
      } catch { return false; }
    },
    onFindings: (added) => { findings.push(...added); },
    scan: async () => ({
      scannedAt: '2026-11-02T00:00:00Z', components: [], runtimes: [], packages: [], runtimeFindings: [],
      lockfiles: ['package-lock.json'], notes: [], errors: [], counts: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 }, sbomWritten: false
    })
  };
  const context: ToolContext = { root, signal: new AbortController().signal, checkpoints: new RunCheckpoints('cyber-clean'), shell, readFiles: new Set() };
  const output: string[] = [];
  try {
    const tools = cyberProbes(deps);
    const calls: Array<[string, Record<string, unknown>]> = [
      ['CyberHttpProbe', { url: target.httpUrl }],
      ['CyberTlsProbe', { url: target.tlsUrl }],
      ['CyberRobotsProbe', { url: target.httpUrl }],
      ['CyberTcpProbe', { host: '127.0.0.1', ports: [Number(new URL(target.httpUrl).port)] }],
      ['CyberSecretsProbe', { root: target.fixtureDir }],
      ['CyberIacProbe', { root: target.fixtureDir }],
      ['CyberDependencyProbe', { root: target.fixtureDir }]
    ];
    for (const [name, input] of calls) {
      const tool = tools.find((candidate) => candidate.name === name)!;
      output.push(await tool.run(tool.parse(input), context));
    }
  } finally {
    shell.dispose();
  }
  return { findings, output };
}

test('the patched twin reports none of the seeded findings while the vulnerable twin reports them', async () => {
  const vulnerable = await startTarget('vulnerable');
  const patched = await startTarget('patched');
  try {
    const dirty = await scanFixture(vulnerable);
    const dirtyChecks = new Set(dirty.findings.map((finding) => finding.checkId));
    for (const checkId of ['missing-hsts', 'iac-public-ingress', 'iac-container-root', 'committed-secret', 'robots-disallowed-path']) {
      assert.ok(dirtyChecks.has(checkId), `the control scan must find ${checkId}, or the clean result proves nothing`);
    }

    const clean = await scanFixture(patched);
    const leaked = clean.findings.filter((finding) => SEEDED_CHECKS.includes(finding.checkId));
    assert.deepEqual(leaked.map((finding) => `${finding.checkId}@${finding.target}`), [], 'the patched twin must be clean of every seeded issue');
    for (const output of clean.output) assert.doesNotMatch(output, /^(?:HIGH|MEDIUM|LOW|INFO): (?:A literal value|The container runs as root|An ingress rule)/m);
  } finally {
    await patched.close();
    await vulnerable.close();
  }
});

test('a zero-finding scan still says which checks could not run', () => {
  const detection = TOOL_NAMES.map((name) => ({ name, available: !['nmap', 'nuclei'].includes(name) }));
  const note = missingToolsNote(detection);
  assert.match(note, /nmap \(not installed\)/);
  assert.match(note, /nuclei \(not installed\)/);
  assert.doesNotMatch(note, /semgrep \(not installed\)/);
  assert.match(note, /^Checks that could not run:/);

  // A scan summary that only has the note is still not a bare "no issues".
  const summary = `No infrastructure-as-code misconfiguration found.\n\n${note}`;
  assert.match(summary, /could not run/);

  const allPresent = missingToolsNote(TOOL_NAMES.map((name) => ({ name, available: true })));
  assert.match(allPresent, /no check was skipped/);
  assert.doesNotMatch(allPresent, /could not run/);
});

test('tool detection reports availability without installing, and never throws', async () => {
  const alwaysMissing = await detectTool('nmap', async () => { throw new Error('ENOENT'); });
  assert.deepEqual(alwaysMissing, { name: 'nmap', available: false });

  const reported = await detectTool('semgrep', async () => '1.78.0\n');
  assert.equal(reported.available, true);
  assert.equal(reported.version, '1.78.0');

  const empty = await detectTool('trivy', async () => '   \n');
  assert.equal(empty.available, false, 'an empty version output is not a detection');

  const unknown = await detectTool('nonexistent-tool', async () => '9.9.9');
  assert.equal(unknown.available, false, 'a tool outside the catalogue is never available');

  const calls: string[] = [];
  const all = await detectTools(async (command, args) => { calls.push(`${command} ${args.join(' ')}`); return '1.0.0'; });
  assert.equal(all.length, TOOL_NAMES.length);
  assert.equal(calls.length, TOOL_NAMES.length);
  assert.ok(calls.every((call) => /--version$|^gitleaks version$/.test(call)), 'one fixed version command per tool, no shell');

  // Detection only asks; an install offer is a string the panel shows, never an execution.
  assert.match(installOffer('nmap') ?? '', /apt install nmap|brew install nmap/);
  assert.equal(installOffer('nonexistent-tool'), undefined);
});

test('the tool catalogue covers the research matrix and marks its assumed JSON flags', () => {
  assert.ok(TOOL_CATALOGUE.length >= 10);
  for (const tool of TOOL_CATALOGUE) {
    assert.ok(tool.installCommand.length > 0, `${tool.name} has an install command`);
    assert.ok(tool.jsonFlag.length > 0, `${tool.name} declares its JSON output flag`);
    assert.equal(typeof tool.jsonFlagVerified, 'boolean');
  }
  for (const name of ['nmap', 'httpx', 'nuclei', 'nikto', 'sqlmap', 'semgrep', 'trivy', 'gitleaks', 'whatweb', 'testssl.sh']) {
    assert.ok(TOOL_NAMES.includes(name), `${name} is catalogued`);
  }
  // The research marked these three JSON flags [ASSUMED]; the executor must not trust them blindly.
  for (const name of ['nikto', 'sqlmap', 'whatweb']) assert.equal(jsonFlagIsAssumed(name), true, `${name} is still an assumption`);
  for (const name of ['httpx', 'nuclei', 'semgrep', 'trivy', 'gitleaks']) assert.equal(jsonFlagIsAssumed(name), false, `${name} is verified`);});
