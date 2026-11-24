// The capacity page (Phase 48 D-09, D-10, VER-03): docs/hosting/capacity.md is a pure function of the committed run files. Only `load` runs are a
// source; a stage not reached prints "not reached" with its reason and nothing is extrapolated; a percentile prints only when n supports it. The
// docs check (docs-site/test/capacityFigures.test.mjs) regenerates the block and refuses a capacity figure anywhere else in the docs.
import type { Durations, RunFile, StageResult, StartTimes } from './runfile.ts';

export const BLOCK_BEGIN = '<!-- capacity:begin';
export const BLOCK_END = '<!-- capacity:end -->';
/** The smallest n each percentile is printed for (research Pitfall 16); below it the page prints "n too small", and the run file keeps n. */
export const MIN_SAMPLES = Object.freeze({ 50: 1, 95: 20, 99: 100 } as const);
export type Percentile = keyof typeof MIN_SAMPLES;
const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

export const PAGE_HEAD = [
  '# Capacity',
  '',
  'Capacity figures for a hosted site come only from load runs on our own hardware, each recorded in a run file in `loadtest/runs/` with its inputs, hardware, image digests, chart versions, raw measurements and hash. This page is generated from those files by `node loadtest/src/cli.ts capacity`; it is not edited by hand, and the docs check refuses a capacity figure anywhere else in the documentation. A stage a run did not reach is shown as not reached, never estimated.',
  ''
].join('\n');

/** Nearest-rank percentile of ascending integers: the value at rank ceil(p/100 * n). Undefined for no values. */
export function percentile(sorted: readonly number[], p: number): number | undefined {
  if (sorted.length === 0) return undefined;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

/** The printed percentile: "no samples", "n too small", or the value in its unit. */
export function figure(sorted: readonly number[], p: Percentile, format: (value: number) => string): string {
  if (sorted.length === 0) return 'no samples';
  if (sorted.length < MIN_SAMPLES[p]) return 'n too small';
  return format(percentile(sorted, p) as number);
}

/** Thousands separators, without locale data. */
export function grouped(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
export const ms = (value: number): string => `${grouped(value)} ms`;
export const millicores = (value: number): string => `${grouped(value)} millicores`;
export function bytes(value: number): string {
  if (value >= GIB) return `${(value / GIB).toFixed(2)} GiB`;
  return `${grouped(Math.round(value / MIB))} MiB`;
}

const merge = (durations: Durations): number[] => [...durations.cold, ...durations.warm].sort((a, b) => a - b);

function row(label: string, sorted: readonly number[], format: (value: number) => string): string {
  return `| ${label} | ${grouped(sorted.length)} | ${figure(sorted, 50, format)} | ${figure(sorted, 95, format)} | ${figure(sorted, 99, format)} |`;
}

function startTable(start: StartTimes, pollIntervalMs: number): string[] {
  const lines = ['| Measure | n | p50 | p95 | p99 |', '| --- | --- | --- | --- | --- |'];
  const measures: Array<[string, Durations]> = [
    ['Session to Deployment (operator reconcile)', start.reconcileMs],
    ['Session to Pod Ready', start.readyMs],
    [`Session to first response through the ingress (harness-observed, polled every ${grouped(pollIntervalMs)} ms)`, start.firstResponseMs]
  ];
  for (const [label, durations] of measures) {
    lines.push(row(`${label}, all`, merge(durations), ms));
    lines.push(row(`${label}, cold`, durations.cold, ms));
    lines.push(row(`${label}, warm`, durations.warm, ms));
  }
  lines.push('', `Starts requested ${grouped(start.requested)}, failed ${grouped(start.failed)}, timed out ${grouped(start.timedOut)}.`);
  return lines;
}

function stageSection(run: RunFile, stage: StageResult): string[] {
  const lines = [`### Stage ${grouped(stage.target)}`, '', `Held ${grouped(stage.sessions)} sessions for ${ms(run.inputs.holdMs)}.`, '', '#### Start times during the ramp', ''];
  lines.push(...startTable(stage.start, run.inputs.pollIntervalMs), '');
  const burst = stage.burst;
  lines.push(`#### Burst of ${grouped(burst.size)} starts`, '');
  if (!burst.reached) {
    lines.push(`Not reached: ${burst.reason}.`, '');
  } else {
    lines.push(`Peak concurrency ${grouped(burst.peakConcurrency)}.`, '', ...startTable(burst.start, run.inputs.pollIntervalMs), '');
    const windows = burst.reconcilesPer10s;
    lines.push(windows.length === 0
      ? 'Operator reconciles per 10 seconds: no samples.'
      : `Operator reconciles per 10 seconds: maximum ${grouped(windows[windows.length - 1])}, median ${grouped(percentile(windows, 50) as number)}, over ${grouped(windows.length)} windows.`, '');
  }
  const { active, idle } = stage.perPerson;
  lines.push('#### Use per person', '', `Measured on the active sample of ${grouped(active.sessions)} sessions with a browser running the activity profile; the sessions with no frontend are shown apart and are not a per-person figure.`, '');
  lines.push('| Measure | n | p50 | p95 | p99 |', '| --- | --- | --- | --- | --- |');
  lines.push(row('CPU, active sample', active.cpuMillicores, millicores));
  lines.push(row('Working-set memory, active sample', active.memoryBytes, bytes));
  lines.push(row('Workspace volume use, active sample', active.volumeBytes, bytes));
  lines.push(row(`CPU, ${grouped(idle.sessions)} sessions with no frontend`, idle.cpuMillicores, millicores));
  lines.push(row(`Working-set memory, ${grouped(idle.sessions)} sessions with no frontend`, idle.memoryBytes, bytes), '');
  const last = stage.ingress.samples[stage.ingress.samples.length - 1];
  lines.push('#### Shared Ingress and etcd', '');
  lines.push(last === undefined
    ? 'Shared Ingress object: no samples.'
    : `Shared Ingress object at the last sample: ${grouped(last.bytes)} bytes, ${grouped(last.rules)} rules${last.rules > 0 ? `, ${grouped(Math.round(last.bytes / last.rules))} bytes per rule` : ''}.`, '');
  lines.push('| Measure | n | p50 | p95 | p99 |', '| --- | --- | --- | --- | --- |', row('Route propagation (rule in the Ingress to first response)', stage.ingress.propagationMs, ms), '');
  if (stage.ingress.propagationUnmeasured > 0) lines.push(`Route propagation not measured for ${grouped(stage.ingress.propagationUnmeasured)} sessions that answered before a sample showed their rule.`, '');
  const { dbSizeBytes, objects } = stage.etcd;
  lines.push(`etcd database size: ${dbSizeBytes === null ? 'not measured' : bytes(dbSizeBytes)}. Objects stored: ${objects === null ? 'not measured' : grouped(objects)}${objects !== null && stage.sessions > 0 ? `, ${grouped(Math.round(objects / stage.sessions))} per session held` : ''}.`, '');
  if (stage.queries.length > 0) {
    lines.push('Queries:', '');
    for (const query of stage.queries) lines.push(`- ${query.name}: \`${query.text.replace(/`/g, "'")}\``);
    lines.push('');
  }
  return lines;
}

function runSection(run: RunFile): string[] {
  const lines = [`## Run ${run.id}`, ''];
  lines.push(`Run file \`loadtest/runs/${run.id}.run.json\`, hash \`${run.hash}\`. Started ${new Date(run.startedAt).toISOString()} on rig ${run.rig}; peak concurrency ${grouped(run.peakConcurrency)}.`, '');
  const v = run.versions;
  lines.push(`Workbench image \`${v.workbenchImage}\`; Theia Cloud chart ${v.theiaCloud.chart}, commit ${v.theiaCloud.commit}, operator \`${v.theiaCloud.operatorImage}\`; Keycloak ${v.keycloak}; OpenBao ${v.openbao}; ingress ${v.ingress.kind} ${v.ingress.version}; RKE2 ${v.rke2}; hub \`${v.hub}\`.`, '');
  const h = run.hardware;
  lines.push(`Hardware: ${grouped(h.nodes.length)} nodes (${h.nodes.map((node) => `${node.name} ${node.role}, ${millicores(node.cpuMillicores)}, ${bytes(node.memoryBytes)}, maxPods ${grouped(node.maxPods)}`).join('; ')}); storage class ${h.storageClass}; images preloaded: ${h.imagesPreloaded ? 'yes' : 'no'}; network: ${h.network}.`, '');
  const i = run.inputs;
  lines.push(`Inputs: AppDefinition ${i.appDefinition.name} (\`${i.appDefinition.image}\`), sessionsPerUser ${grouped(i.sessionsPerUser)}, activity profile ${i.profile.id} version ${i.profile.version} (\`${i.profile.sha256}\`), idle timeout ${grouped(i.idleTimeoutMinutes)} minutes, test realm ${i.testRealm.name} (${i.testRealm.differences.join('; ')}).`, '');
  lines.push('| Stage | Result | Sessions held | Burst |', '| --- | --- | --- | --- |');
  for (const stage of run.stages) {
    lines.push(stage.reached
      ? `| ${grouped(stage.target)} | ${stage.target > TOP_CLASS ? 'reached (headroom)' : 'reached'} | ${grouped(stage.sessions)} | ${stage.burst.reached ? `reached, peak ${grouped(stage.burst.peakConcurrency)}` : `not reached: ${stage.burst.reason}`} |`
      : `| ${grouped(stage.target)} | not reached: ${stage.reason} | | |`);
  }
  lines.push('');
  for (const stage of run.stages) if (stage.reached) lines.push(...stageSection(run, stage));
  return lines;
}

/** The site size classes with a default: up to 100, 200 and 400 people (D-07, the HQ target). A reached stage above the last is headroom, never a class (D-20). */
const BASE_CLASSES = [100, 200, 400];
const TOP_CLASS = BASE_CLASSES[BASE_CLASSES.length - 1];

/** A p95-based default, or why there is none: "no samples" or "n too small". */
function rounded(sorted: readonly number[], toValue: (p95: number) => string): string {
  const shown = figure(sorted, 95, String);
  return shown === 'no samples' || shown === 'n too small' ? shown : toValue(percentile(sorted, 95) as number);
}

/**
 * Sizing defaults per site size class, each read from the latest load run that reached that class's stage: memory per person is the active
 * sample's p95 working set rounded up to 256 MiB, the workspace volume is the active sample's p95 volume use doubled and rounded up to a whole GiB,
 * and the idle timeout is the one the run used, printed with the idle-session memory and the cold-start p95 measured under it. A class whose
 * stage no load run reached prints "not measured". Setting these in a site's chart values stays with the site.
 */
function sizingSection(sources: readonly RunFile[]): string[] {
  const lines = ['## Sizing defaults per site size class', '', 'Each class reads the latest load run that reached its stage. Memory per person is the active sample\'s p95 working set rounded up to 256 MiB; the workspace volume is the active sample\'s p95 volume use doubled and rounded up to a whole GiB; the idle timeout is the one that run used, shown with the idle-session memory (p95) and the cold-start p95 to Pod Ready measured under it.', ''];
  lines.push('| Site size class | Source run | Memory per person | Workspace volume | Idle timeout | Idle-session memory | Cold start p95 |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const size of BASE_CLASSES) {
    const label = `Up to ${grouped(size)} people`;
    const found = [...sources].sort((a, b) => b.startedAt - a.startedAt || (a.id < b.id ? 1 : -1))
      .map((run) => ({ run, stage: run.stages.find((stage) => stage.target === size && stage.reached) }))
      .find((item) => item.stage !== undefined);
    if (!found?.stage) { lines.push(`| ${label} | not measured | | | | | |`); continue; }
    const { run, stage } = found;
    const memory = rounded(stage.perPerson.active.memoryBytes, (p95) => `${grouped(Math.ceil(p95 / (256 * MIB)) * 256)} MiB`);
    const volume = rounded(stage.perPerson.active.volumeBytes, (p95) => `${grouped(Math.ceil((2 * p95) / GIB))} GiB`);
    lines.push(`| ${label} | ${run.id} | ${memory} | ${volume} | ${grouped(run.inputs.idleTimeoutMinutes)} minutes | ${figure(stage.perPerson.idle.memoryBytes, 95, bytes)} | ${figure(stage.start.readyMs.cold, 95, ms)} |`);
  }
  lines.push('');
  return lines;
}

/** The generated block: only `load` runs, in id order, between the begin marker (naming the runs) and the end marker. */
export function renderCapacity(runs: readonly RunFile[]): string {
  const sources = runs.filter((run) => run.kind === 'load').sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const lines = [`${BLOCK_BEGIN} runs=${sources.length === 0 ? 'none' : sources.map((run) => run.id).join(',')} -->`, ''];
  if (sources.length === 0) lines.push('No load run has been recorded yet, so this page states no capacity figure.', '');
  if (sources.length > 0) lines.push(...sizingSection(sources));
  for (const run of sources) lines.push(...runSection(run));
  lines.push(BLOCK_END);
  return lines.join('\n');
}

/** The whole page: the fixed head and the generated block. */
export function renderCapacityPage(runs: readonly RunFile[]): string {
  return `${PAGE_HEAD}\n${renderCapacity(runs)}\n`;
}

/** Problems with the generated block in `text`: missing, repeated, naming a run that is not a verified load run, or not what the runs render. */
export function checkCapacityBlock(text: string, runs: readonly RunFile[]): string[] {
  const begins = text.split(BLOCK_BEGIN).length - 1;
  if (begins === 0) return ['no generated capacity block'];
  if (begins > 1) return ['more than one generated capacity block'];
  const start = text.indexOf(BLOCK_BEGIN);
  const end = text.indexOf(BLOCK_END, start);
  if (end < 0) return ['the generated capacity block has no end marker'];
  const block = text.slice(start, end + BLOCK_END.length);
  const problems: string[] = [];
  const named = /^<!-- capacity:begin runs=([^ ]*) -->/.exec(block)?.[1];
  if (named === undefined) problems.push('the begin marker does not name its runs');
  for (const id of named === undefined || named === 'none' ? [] : named.split(',')) {
    const run = runs.find((item) => item.id === id);
    if (run === undefined) problems.push(`the block names ${id}, which is not a committed, verified run file`);
    else if (run.kind !== 'load') problems.push(`the block names ${id}, a ${run.kind} run, which is never a capacity source`);
  }
  if (block !== renderCapacity(runs)) problems.push('the block is not what the committed load runs render; run `node loadtest/src/cli.ts capacity`');
  return problems;
}

// A capacity figure: a whole number followed by sessions, people, persons or users (plural: "120 session openings" is a rate limit, and
// "TLS 1.3 sessions" a version), or a number with GiB, MiB, TiB or vCPU in the same clause as a session, person or user ("4 MiB per append, ...,
// 120 session openings" names a size and a session in different clauses and is a protocol limit). Matched per sentence; a Markdown table row,
// heading or list item is a sentence of its own.
const WHOLE = String.raw`(?<![\w.,-])(?:\d{1,3}(?:,\d{3})+|\d+)(?![.,]\d)`;
const DECIMAL = String.raw`(?<![\w.,-])\d+(?:[.,]\d+)*`;
const COUNT = new RegExp(String.raw`${WHOLE}\+?\s+(?:concurrent\s+|simultaneous\s+|active\s+|parallel\s+)?(?:sessions|people|persons|users)\b`, 'i');
const SIZE = new RegExp(String.raw`${DECIMAL}\s*(?:GiB|MiB|TiB|vCPUs?)\b`);
const ABOUT = /\b(?:sessions?|people|persons?|users?)\b/i;
const CLAUSE = /,\s|;|:\s|[()]|\s[\u2013\u2014-]\s/;
const BLOCK_START_LINE = /^\s*(?:\||#|[-*+]\s|\d+[.)]\s|>|```|~~~)/;

export interface CapacityFigure { readonly line: number; readonly text: string }

/** Blanks the generated block (keeping line numbers), so only text outside it is scanned. A begin with no end blanks nothing. */
function outsideBlocks(text: string): string[] {
  const lines = text.split(/\r?\n/);
  let inside = false;
  let opened = -1;
  const out = [...lines];
  lines.forEach((line, index) => {
    if (!inside && line.includes(BLOCK_BEGIN)) { inside = true; opened = index; }
    if (inside) out[index] = '';
    if (inside && line.includes(BLOCK_END)) inside = false;
  });
  if (inside) for (let index = opened; index < lines.length; index += 1) out[index] = lines[index];
  return out;
}

/** Sentences with the 1-based line each starts on. */
function sentences(lines: readonly string[]): CapacityFigure[] {
  const found: CapacityFigure[] = [];
  let unit: Array<{ line: number; text: string }> = [];
  const flush = (): void => {
    if (unit.length === 0) return;
    let joined = '';
    const starts: Array<{ offset: number; line: number }> = [];
    for (const part of unit) { starts.push({ offset: joined.length, line: part.line }); joined += `${part.text} `; }
    const lineAt = (offset: number): number => starts.filter((item) => item.offset <= offset).pop()?.line ?? unit[0].line;
    let offset = 0;
    for (const piece of joined.split(/(?<=[.!?])\s+/)) {
      const at = joined.indexOf(piece, offset);
      offset = at + piece.length;
      if (piece.trim()) found.push({ line: lineAt(at + (piece.length - piece.trimStart().length)), text: piece.trim() });
    }
    unit = [];
  };
  lines.forEach((text, index) => {
    if (!text.trim()) { flush(); return; }
    if (BLOCK_START_LINE.test(text)) flush();
    unit.push({ line: index + 1, text });
    if (/^\s*\|/.test(text)) flush();
  });
  flush();
  return found;
}

/** Every capacity figure in `text` outside the generated block, with its line. */
export function findCapacityFigures(text: string): CapacityFigure[] {
  return sentences(outsideBlocks(text))
    .filter((sentence) => COUNT.test(sentence.text) || sentence.text.split(CLAUSE).some((clause) => SIZE.test(clause) && ABOUT.test(clause)))
    .map((sentence) => ({ line: sentence.line, text: sentence.text.length > 200 ? `${sentence.text.slice(0, 200)}…` : sentence.text }));
}
