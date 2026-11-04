// D-27 evidence kind 4: deterministic, hash-chained SVG visual captures. The same evidence renders
// identical bytes every time, the picture is stored on the same chain as the data it shows, the
// appendix references it by name and hash, and the browser screenshot is recorded absent-with-reason
// rather than silently omitted.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import type { DisclaimerAcceptance, Engagement, EngagementRun, Finding } from '../domain/cyber';
import { appendEntry } from '../domain/cyberLedger';
import { CyberEvidenceStore } from '../services/cyberLedgerStore';
import { buildPtesReport } from '../services/cyberReport';
import {
  captureFileName,
  captureForRun,
  escapeXml,
  renderEvidenceVisual,
  renderFindingsBySeverity,
  renderHttpExchange,
  SCREENSHOT_ABSENT_NOTE,
  type HttpExchange
} from '../services/cyberVisualCapture';

const EXCHANGE: HttpExchange = {
  method: 'GET',
  path: '/login',
  status: '200 OK',
  headers: [['content-type', 'application/json'], ['server', 'fixture/1.2.3'], ['strict-transport-security', '(absent)']],
  bodyExcerpt: '{"result":"ok"}',
  evidenceHash: 'c'.repeat(64)
};

const ACCEPTANCE: DisclaimerAcceptance = {
  acceptor: 'Example Organisation Ltd', osUser: 'test-user', machine: 'test-machine', extensionVersion: '0.4.10',
  textVersion: 'v1', region: 'us', acceptedAt: '2026-10-31T12:00:00Z'
};

const ENGAGEMENT: Engagement = {
  id: 'eng-00000000-0000-4000-8000-000000000001', workspace: '/workspace/example',
  target: { kind: 'url', value: 'https://example.test/' },
  resolvedScope: { hosts: ['example.test'], ports: [443], paths: ['/'], exclusions: [] },
  region: 'us', authorizationStatement: 'The acceptor owns the target.', allowedModes: ['passive'],
  exclusions: [], sandbox: { tier: 'tempFolder' }, acceptedDisclaimer: ACCEPTANCE, createdAt: ACCEPTANCE.acceptedAt, frozen: true
};

const RUN: EngagementRun = {
  id: 'run-0001-abcdef', engagementId: ENGAGEMENT.id, startedAt: '2026-11-02T12:00:00Z', depth: 'quick',
  ledgerPath: 'ledger.jsonl', outcome: 'completed'
};

const LEDGER = [appendEntry([], { index: 0, timestamp: '2026-11-02T12:00:00Z', tool: 'CyberHttpProbe', arguments: '{}', result: 'HTTP 200', modelReasoning: 'probe', evidenceHash: '' })];

function finding(severity: Finding['severity'], checkId: string): Finding {
  return {
    id: `${checkId}@https://example.test/`, checkId, title: `${checkId} on the target`, severity,
    verdict: 'could_not_determine', cvssVector: 'CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:L/I:L/A:N', cwes: [], wstg: [],
    evidenceExcerpt: 'captured', evidenceHash: 'd'.repeat(64), reproductionCommand: 'curl -sS -I https://example.test/',
    remediation: 'Fix it.', reason: 'no exploitation was attempted', target: 'https://example.test/'
  };
}

/** A hand-rolled tag-balance check: no XML library, just enough to prove well-formedness. */
function assertBalancedSvg(svg: string): void {
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /<\/svg>$/);
  const opens = [...svg.matchAll(/<([a-zA-Z]+)(?:\s[^>]*)?>/g)].filter((match) => !match[0].endsWith('/>'));
  const closes = [...svg.matchAll(/<\/([a-zA-Z]+)>/g)];
  assert.equal(opens.length, closes.length, 'every opened tag is closed');
  const stack: string[] = [];
  for (const match of svg.matchAll(/<(\/?)([a-zA-Z]+)(?:\s[^>]*?)?(\/?)>/g)) {
    const [, closing, name, selfClosing] = match;
    if (selfClosing) continue;
    if (closing) assert.equal(stack.pop(), name, `</${name}> closes the wrong tag`);
    else stack.push(name);
  }
  assert.deepEqual(stack, [], 'no tag is left open');
  assert.doesNotMatch(svg, /<image|href="http/, 'no raster or remote reference is embedded');
}

test('an http-exchange capture is a well-formed standalone SVG', () => {
  const svg = renderHttpExchange(EXCHANGE);
  assertBalancedSvg(svg);
  assert.match(svg, /GET \/login/);
  assert.match(svg, /200 OK/);
  assert.match(svg, new RegExp(EXCHANGE.evidenceHash), 'the caption names the source evidence hash');
});

test('the same input renders byte-identical SVG twice, with no clock or randomness involved', () => {
  const first = renderEvidenceVisual('http-exchange', { 'http-exchange': EXCHANGE });
  const second = renderEvidenceVisual('http-exchange', { 'http-exchange': EXCHANGE });
  assert.equal(first, second);

  // A different wall clock and a different random source cannot change the bytes: neither is read.
  const realNow = Date.now;
  const realRandom = Math.random;
  Date.now = () => 1;
  Math.random = () => 0.5;
  try {
    assert.equal(renderEvidenceVisual('http-exchange', { 'http-exchange': EXCHANGE }), first);
  } finally {
    Date.now = realNow;
    Math.random = realRandom;
  }
  assert.equal(captureFileName('http-exchange', EXCHANGE.evidenceHash), `http-exchange-${'c'.repeat(12)}.svg`);
});

test('the SVG bytes are stored through the evidence store and read back identically', async () => {
  const store = new CyberEvidenceStore(await mkdtemp(path.join(tmpdir(), 'near-ai-cyber-visual-')));
  const svg = renderHttpExchange(EXCHANGE);
  const hash = await store.put('run-0001-abcdef', Buffer.from(svg, 'utf8'));
  assert.equal(hash, createHash('sha256').update(Buffer.from(svg, 'utf8')).digest('hex'));
  assert.equal((await store.get('run-0001-abcdef', hash)).toString('utf8'), svg);
});

test('the findings bar reflects the real counts, not decoration', () => {
  const svg = renderFindingsBySeverity({
    findings: [finding('critical', 'sql-injection'), finding('critical', 'iac-public-ingress'), finding('low', 'missing-x-frame-options')],
    evidenceHash: 'e'.repeat(64)
  });
  assertBalancedSvg(svg);
  assert.match(svg, /Findings by severity \(3 total\)/);
  assert.match(svg, />critical</);
  assert.match(svg, />2</, 'the critical bar carries the count 2');
  assert.match(svg, />low</);
  assert.match(svg, />1</);
  assert.match(svg, />high</);
  assert.match(svg, />0</, 'a severity with no findings is still labelled');
});

test('values are escaped, so a hostile finding title cannot break the SVG', () => {
  assert.equal(escapeXml('<script>&"\''), '&lt;script&gt;&amp;&quot;&apos;');
  // The exchange form renders a body excerpt, so a hostile page cannot inject markup into the panel.
  const host_title = renderHttpExchange({ ...EXCHANGE, path: '/<script>alert(1)</script>', bodyExcerpt: '<script>alert(1)</script>' });
  assertBalancedSvg(host_title);
  assert.doesNotMatch(host_title, /<script>/);
  assert.match(host_title, /&lt;script&gt;/);
});

test('the appendix references each capture by filename and hash and always states the screenshot status', () => {
  const findings = [finding('critical', 'sql-injection')];
  const captures = {
    captures: [{ kind: 'findings-by-severity', fileName: 'findings-by-severity-eeeeeeeeeeee.svg', evidenceHash: 'e'.repeat(64) }],
    screenshot: { status: 'absent' as const, reason: SCREENSHOT_ABSENT_NOTE }
  };
  const report = buildPtesReport(ENGAGEMENT, RUN, findings, LEDGER, { visualCaptures: captures });
  assert.match(report, /Visual captures/);
  assert.match(report, /findings-by-severity-eeeeeeeeeeee\.svg/);
  assert.match(report, new RegExp(`evidence \\\`${'e'.repeat(64)}\\\``));
  assert.match(report, /Screenshot:\*\* absent/);
  assert.match(report, /host browser/);

  // With no captures requested the absence is still stated, never silent.
  const bare = buildPtesReport(ENGAGEMENT, RUN, findings, LEDGER);
  assert.match(bare, /Visual captures/);
  assert.match(bare, /No visual captures were recorded for this run/);
  assert.match(bare, /Screenshot:\*\* absent/);
});

test('captureForRun stores each capture and reports the screenshot absent with a reason', async () => {
  const store = new CyberEvidenceStore(await mkdtemp(path.join(tmpdir(), 'near-ai-cyber-visualrun-')));
  const result = await captureForRun('run-0001-abcdef', {
    evidence: store,
    findings: [finding('critical', 'sql-injection'), finding('low', 'missing-x-frame-options')],
    exchanges: [EXCHANGE],
    transcripts: [{ lines: ['uid=1000(fixture)', 'fixture-host'], provenance: { tool: 'CyberExploitTool', argv: ['whoami'], exitCode: 0 }, evidenceHash: 'a'.repeat(64) }]
  });
  assert.deepEqual(result.captures.map((capture) => capture.kind), ['http-exchange', 'terminal-transcript', 'findings-by-severity']);
  for (const capture of result.captures) {
    const bytes = await store.get('run-0001-abcdef', capture.evidenceHash);
    assert.equal(bytes.toString('utf8'), capture.svgText, 'the stored blob is the rendered SVG');
    assert.equal(capture.fileName, `${capture.kind}-${capture.evidenceHash.slice(0, 12)}.svg`);
    assertBalancedSvg(capture.svgText);
  }
  assert.equal(result.screenshot.status, 'absent');
  assert.match(result.screenshot.reason, /host browser/);
  assert.equal(SCREENSHOT_ABSENT_NOTE, result.screenshot.reason);
});
