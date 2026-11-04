// The defensive suite proven against the seeded vulnerable fixture (CYBER-06): each seeded
// weakness is a finding with evidence, a reproduction command, and a WSTG id; the run is offline
// (loopback target, injected DNS, fake OSV fetch), and a folder with no IaC files still says which
// kinds were looked for rather than reporting silence.

import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { RunCheckpoints } from '../agent/checkpoints';
import { cyberProbes, lookupRecords, type CyberProbeDeps, type DnsResolvers } from '../agent/cyberProbes';
import { ShellSession } from '../agent/shell';
import type { ToolContext } from '../agent/tools';
import type { Finding, ResolvedScope } from '../domain/cyber';
import { startTarget, type FixtureTarget } from './cyberStartTarget';

interface Harness {
  target: FixtureTarget;
  context: ToolContext;
  deps: CyberProbeDeps;
  scope: ResolvedScope;
  findings: Finding[];
  tool(name: string): ReturnType<typeof cyberProbes>[number];
  dispose(): void;
}

/** The fixture scope: exactly the two loopback ports the fixture opened. */
async function harness(kind: 'vulnerable' | 'patched', extra: Partial<CyberProbeDeps> = {}): Promise<Harness> {
  const target = await startTarget(kind);
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-cyber-defensive-'));
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
    ...extra
  };
  const tools = cyberProbes(deps);
  return {
    target,
    context: { root, signal: new AbortController().signal, checkpoints: new RunCheckpoints('cyber-defensive'), shell, readFiles: new Set() },
    deps,
    scope,
    findings,
    tool: (name) => {
      const tool = tools.find((candidate) => candidate.name === name);
      assert.ok(tool, `${name} is one of the built-in probes`);
      return tool;
    },
    dispose: () => { shell.dispose(); void target.close(); }
  };
}

async function runTool(box: Harness, name: string, input: Record<string, unknown>): Promise<string> {
  const tool = box.tool(name);
  return tool.run(tool.parse(input), box.context);
}

const checkIds = (findings: Finding[]): string[] => findings.map((finding) => finding.checkId);
const countOf = (findings: Finding[], checkId: string): number => findings.filter((finding) => finding.checkId === checkId).length;

test('the header, TLS, and robots probes each report their seeded weakness once with evidence and a way to reproduce it', async () => {
  const box = await harness('vulnerable');
  try {
    await runTool(box, 'CyberHttpProbe', { url: box.target.httpUrl });
    await runTool(box, 'CyberTlsProbe', { url: box.target.tlsUrl });
    await runTool(box, 'CyberRobotsProbe', { url: box.target.httpUrl });

    for (const checkId of ['missing-hsts', 'missing-x-content-type-options', 'missing-x-frame-options', 'server-version-disclosure']) {
      assert.equal(countOf(box.findings, checkId), 1, `${checkId} is reported exactly once`);
    }
    const expired = box.findings.filter((finding) => finding.checkId === 'tls-certificate-expired');
    assert.equal(expired.length, 1);
    assert.match(expired[0].evidenceExcerpt, /notAfter=Jan +1 00:00:00 2021 GMT/);

    const exposed = box.findings.filter((finding) => finding.checkId === 'robots-disallowed-path');
    assert.deepEqual(exposed.map((finding) => finding.target).sort(), [`${new URL(box.target.httpUrl).origin}/admin`, `${new URL(box.target.httpUrl).origin}/backup/`]);
    assert.match(exposed[0].evidenceExcerpt, /Disallow: \/backup\//);
    assert.match(exposed[1].evidenceExcerpt, /Disallow: \/admin/);

    for (const finding of box.findings) {
      assert.ok(finding.reproductionCommand.length > 0, `${finding.checkId} carries a reproduction command`);
      assert.ok(finding.wstg.length > 0, `${finding.checkId} carries a WSTG id`);
      assert.ok(finding.evidenceHash.length === 64, `${finding.checkId} hashes its evidence`);
      assert.ok(finding.evidenceExcerpt.length > 0);
    }
    assert.match(expired[0].reproductionCommand, /openssl s_client/);
    assert.match(exposed[0].reproductionCommand, /curl -sS/);
  } finally {
    box.dispose();
  }
});

test('the IaC probe finds all five seeded misconfigurations with file:line and a CWE id, and reports absent kinds', async () => {
  const box = await harness('vulnerable');
  try {
    const output = await runTool(box, 'CyberIacProbe', { root: box.target.fixtureDir });
    const seeded = box.findings.map((finding) => `${finding.checkId}@${finding.target}`);
    const expected = [
      'iac-public-ingress@main.tf',
      'iac-unencrypted-storage@main.tf',
      'iac-container-root@Dockerfile',
      'iac-hardcoded-secret@Dockerfile',
      'iac-unpinned-image@Dockerfile',
      'iac-unpinned-action@.github/workflows/ci.yml',
      'iac-hardcoded-secret@.github/workflows/ci.yml'
    ];
    for (const item of expected) assert.ok(seeded.some((entry) => entry.startsWith(item)), `expected ${item}, got ${seeded.join(', ')}`);
    // public-read ACL and the plain ingress both land on the same Terraform file; the unencrypted
    // bucket is one finding, not one per bucket-adjacent resource.
    assert.equal(countOf(box.findings, 'iac-unencrypted-storage'), 1);
    assert.equal(countOf(box.findings, 'iac-container-root'), 1);

    for (const finding of box.findings) {
      assert.match(finding.cwes[0] ?? '', /^CWE-\d+$/, `${finding.checkId} carries a CWE id`);
      assert.match(finding.target ?? '', /^[^:]+:\d+$/, `${finding.checkId} cites file:line`);
      assert.match(finding.reproductionCommand, /^sed -n '\d+p' '/);
      assert.ok(finding.wstg.length > 0);
    }
    assert.match(output, /Terraform: 1 file\(s\) checked/);
    assert.match(output, /Dockerfile: 1 file\(s\) checked/);
    assert.match(output, /CI workflow: 1 file\(s\) checked/);
    assert.match(output, /No Kubernetes files found/);
    assert.match(output, /No CloudFormation files found/);

    const empty = await mkdtemp(path.join(tmpdir(), 'near-ai-cyber-empty-'));
    await writeFile(path.join(empty, 'README.md'), '# nothing here\n');
    // The scope must include the folder being scanned: a file-walking probe refuses a root outside it.
    const emptyBox = await harness('patched', { scope: { hosts: [], ports: [], paths: [empty], exclusions: [] } });
    try {
      const emptyOutput = await runTool(emptyBox, 'CyberIacProbe', { root: empty });
      assert.doesNotMatch(emptyOutput, /(^|\n)iac-/);
      for (const label of ['Terraform', 'CloudFormation', 'Kubernetes', 'Dockerfile', 'CI workflow']) {
        assert.match(emptyOutput, new RegExp(`No ${label} files found`), `${label} absence is stated, never silent`);
      }
    } finally {
      emptyBox.dispose();
    }
  } finally {
    box.dispose();
  }
});

test('the secrets probe reports the committed credential once, cites file:line, and never carries the value', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-cyber-secrets-'));
  await writeFile(path.join(root, 'settings.env'), 'API_KEY=sk-fixtureABCDEFGHIJKLMNOPQRSTUVWXYZ012345\n');
  await writeFile(path.join(root, 'notes.md'), 'Nothing secret here.\n');
  const box = await harness('vulnerable', { scope: { hosts: [], ports: [], paths: [root], exclusions: [] } });
  try {
    await runTool(box, 'CyberSecretsProbe', { root });
    assert.equal(countOf(box.findings, 'committed-secret'), 1);
    const [secret] = box.findings;
    assert.equal(secret.target, 'settings.env:1');
    assert.equal(secret.cwes[0], 'CWE-798');
    assert.match(secret.reproductionCommand, /^sed -n '1p' 'settings\.env'$/);
    const serialised = JSON.stringify(secret);
    assert.doesNotMatch(serialised, /sk-fixtureABCDEFGHIJKLMNOPQRSTUVWXYZ012345/);
    assert.match(serialised, /sk-f…/);

    // The fixture repository's own seeded credentials are found too, and only their prefixes show.
    const fixtureBox = await harness('vulnerable');
    try {
      await runTool(fixtureBox, 'CyberSecretsProbe', { root: fixtureBox.target.fixtureDir });
      const committed = fixtureBox.findings.filter((finding) => finding.checkId === 'committed-secret');
      assert.ok(committed.length >= 2, `expected the .env and the Dockerfile ENV, got ${committed.map((finding) => finding.target).join(', ')}`);
      assert.doesNotMatch(JSON.stringify(committed), /fixture-secret-DO-NOT-USE\.invalid/);
    } finally {
      fixtureBox.dispose();
    }
  } finally {
    box.dispose();
  }
});

test('the dependency probe reuses the OSV scan and carries the CVE id, severity, and reproduction command', async () => {
  const box = await harness('vulnerable');
  try {
    const scanned: string[] = [];
    const scan = async (root: string) => {
      scanned.push(root);
      return {
        scannedAt: '2026-11-02T00:00:00Z',
        components: [{ ecosystem: 'npm' as const, name: 'express', version: '4.17.2', purl: 'pkg:npm/express@4.17.2', source: 'package-lock.json', line: 15 }],
        runtimes: [],
        packages: [{
          component: { ecosystem: 'npm' as const, name: 'express', version: '4.17.2', purl: 'pkg:npm/express@4.17.2', source: 'package-lock.json', line: 15 },
          vulnerabilities: [{ id: 'GHSA-fixture-0001', aliases: ['CVE-2024-29041'], summary: 'Open redirect in express', severity: 'medium' as const, score: 6.1, vector: 'CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:L/I:L/A:N', url: 'https://osv.dev/vulnerability/GHSA-fixture-0001', cwes: ['CWE-601'], fixed: ['4.19.2'] }]
        }],
        runtimeFindings: [],
        lockfiles: ['package-lock.json'],
        notes: [],
        errors: [],
        counts: { critical: 0, high: 0, medium: 1, low: 0, unknown: 0 },
        sbomWritten: false
      };
    };
    // The probe is never run without an injected scan here: the default path calls OSV.dev.
    const probe = box.tool('CyberDependencyProbe');
    assert.ok(probe.description.includes('OSV'), 'the probe says it reuses the OSV scan');

    const withScan = await harness('vulnerable', { scan });
    try {
      const scannedOutput = await runTool(withScan, 'CyberDependencyProbe', { root: withScan.target.fixtureDir });
      assert.deepEqual(scanned, [withScan.target.fixtureDir]);
      assert.equal(countOf(withScan.findings, 'vulnerable-dependency'), 1);
      const [finding] = withScan.findings;
      assert.match(finding.title, /CVE-2024-29041|GHSA-fixture-0001/);
      assert.equal(finding.severity, 'medium');
      assert.equal(finding.cwes[0], 'CWE-601');
      assert.match(finding.evidenceExcerpt, /pkg:npm\/express@4\.17\.2/);
      assert.match(finding.reproductionCommand, /osv-scanner --lockfile='package-lock\.json'/);
      assert.match(scannedOutput, /medium/i);
    } finally {
      withScan.dispose();
    }

    // Consent off is a plain register, never a "clean" result.
    const notConsented = await harness('vulnerable', { security: { consented: () => false, scan: async () => undefined } });
    try {
      const message = await runTool(notConsented, 'CyberDependencyProbe', { root: notConsented.target.fixtureDir });
      assert.match(message, /not enabled for this project/);
      assert.match(message, /dependencies were not checked/);
      assert.equal(notConsented.findings.length, 0);
    } finally {
      notConsented.dispose();
    }
  } finally {
    box.dispose();
  }
});

test('the DNS probe flags a mail domain with no SPF or DMARC and stays quiet about a bare host', async () => {
  const offline: DnsResolvers = {
    resolve4: async (hostname) => (hostname === 'mail.example.test' ? ['127.0.0.1'] : []),
    resolve6: async () => [],
    resolveMx: async (hostname) => (hostname === 'mail.example.test' ? [{ exchange: 'mx.example.test', priority: 10 }] : []),
    resolveTxt: async (hostname) => (hostname === 'mail.example.test' ? [['v=spf1 mx -all']] : [])
  };
  const records = await lookupRecords('mail.example.test', offline);
  assert.deepEqual(records.mx, ['10 mx.example.test']);
  assert.deepEqual(records.txt, ['v=spf1 mx -all']);

  const noTxt: DnsResolvers = { ...offline, resolveTxt: async () => [] };
  const box = await harness('vulnerable', {
    scope: { hosts: ['mail.example.test'], ports: [], paths: [], exclusions: [] },
    dns: noTxt
  });
  try {
    await runTool(box, 'CyberDnsProbe', { hostname: 'mail.example.test' });
    assert.equal(countOf(box.findings, 'dns-missing-spf'), 1);
    assert.equal(countOf(box.findings, 'dns-missing-dmarc'), 1);
    for (const finding of box.findings) {
      assert.ok(finding.wstg.includes('WSTG-CONF-02'));
      assert.match(finding.reproductionCommand, /^dig \+short TXT/);
    }
  } finally {
    box.dispose();
  }

  const spfOnly = await harness('vulnerable', {
    scope: { hosts: ['mail.example.test'], ports: [], paths: [], exclusions: [] },
    dns: offline
  });
  try {
    await runTool(spfOnly, 'CyberDnsProbe', { hostname: 'mail.example.test' });
    assert.equal(countOf(spfOnly.findings, 'dns-missing-spf'), 0, 'a published SPF record is not a finding');
    assert.equal(countOf(spfOnly.findings, 'dns-missing-dmarc'), 1);
  } finally {
    spfOnly.dispose();
  }
});

test('the TCP probe reports the open fixture port and refuses ports and hosts outside the scope', async () => {
  const box = await harness('vulnerable');
  try {
    const httpPort = Number(new URL(box.target.httpUrl).port);
    const output = await runTool(box, 'CyberTcpProbe', { host: '127.0.0.1', ports: [httpPort] });
    assert.match(output, new RegExp(`${httpPort}: open`));
    assert.equal(countOf(box.findings, 'open-port'), 1);
    assert.equal(box.findings[0].cwes[0], 'CWE-1327');
    assert.match(box.findings[0].reproductionCommand, new RegExp(`nc -vz 127\\.0\\.0\\.1 ${httpPort}`));

    const tool = box.tool('CyberTcpProbe');
    assert.throws(() => tool.parse({ host: '127.0.0.1', ports: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33] }), /At most 32 ports/);
    await assert.rejects(runTool(box, 'CyberTcpProbe', { host: 'example.test', ports: [httpPort] }), /outside the engagement's resolved scope/);
    await assert.rejects(runTool(box, 'CyberTcpProbe', { host: '127.0.0.1', ports: [1] }), /outside the engagement's resolved scope/);
  } finally {
    box.dispose();
  }
});

test('every built-in probe is read-capability and marks its output untrusted', () => {
  const tools = cyberProbes({ inScope: () => true });
  assert.equal(tools.length, 9);
  assert.deepEqual(tools.map((tool) => tool.name), ['CyberHttpProbe', 'CyberTlsProbe', 'CyberDnsProbe', 'CyberTcpProbe', 'CyberRobotsProbe', 'CyberSecretsProbe', 'CyberIacProbe', 'CyberDependencyProbe', 'CyberFingerprintProbe']);
  for (const tool of tools) {
    assert.equal(tool.capability, 'read', `${tool.name} is a passive read`);
    assert.equal(tool.untrusted, true, `${tool.name} treats target data as untrusted`);
    assert.equal(tool.parameters.type, 'object');
  }
});
