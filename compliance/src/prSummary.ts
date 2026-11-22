import { STATE_WORDS, type State } from './model.ts';

type Row = Readonly<{ level: string; control: string; label?: string; state: string; reason: string; reasonText: string }>;
type Dashboard = Readonly<{ levels?: readonly { id: string; title: string }[]; rows?: readonly Row[] }>;
export interface PrChange { readonly level: string; readonly levelTitle: string; readonly control: string; readonly from: string; readonly to: string; readonly reason: string; readonly reasonText: string }
export interface PrSummary { readonly changes: readonly PrChange[]; readonly dropsWithoutReview: number; readonly counts: Readonly<Record<string, number>> }
const state = (value: string) => STATE_WORDS[value as State] ?? value;

/** Compare only control-state transitions. A tailoring or POA&M edit is the required review signal for drops. */
export function prSummary(mainDashboard: Dashboard, prDashboard: Dashboard, changedFiles: readonly string[]): PrSummary {
  const before = new Map((mainDashboard.rows ?? []).map((row) => [`${row.level}:${row.control}`, row])); const titles = new Map((prDashboard.levels ?? mainDashboard.levels ?? []).map((level) => [level.id, level.title]));
  const changes = (prDashboard.rows ?? []).flatMap((row) => { const prior = before.get(`${row.level}:${row.control}`); return prior && prior.state !== row.state ? [{ level: row.level, levelTitle: titles.get(row.level) ?? row.level, control: row.label ?? row.control.toUpperCase(), from: state(prior.state), to: state(row.state), reason: row.reason, reasonText: row.reasonText }] : []; }).sort((a, b) => a.level.localeCompare(b.level) || a.control.localeCompare(b.control));
  const reviewed = changedFiles.some((file) => file.startsWith('compliance/tailoring/') || file.startsWith('compliance/poam/'));
  const drops = changes.filter((change) => change.from === 'Met' && (change.to === 'Not met' || change.to === 'Stale')).length;
  return { changes, dropsWithoutReview: reviewed ? 0 : drops, counts: Object.fromEntries(Object.entries((prDashboard.rows ?? []).reduce<Record<string, number>>((out, row) => { out[row.level] = (out[row.level] ?? 0) + 1; return out; }, {})).sort(([a], [b]) => a.localeCompare(b))) };
}

export function renderPrSummary(summary: PrSummary): string {
  if (!summary.changes.length) return `## Compliance control changes\n\nNo control changed state.\n\n${Object.entries(summary.counts).map(([level, count]) => `- ${level}: ${count} controls`).join('\n')}\n`;
  const shown = summary.changes.slice(0, 50); const extra = summary.changes.length - shown.length;
  return ['## Compliance control changes', '', '| Level | Control | Before | After | Reason |', '| --- | --- | --- | --- | --- |', ...shown.map((change) => `| ${change.levelTitle} | ${change.control} | ${change.from} | ${change.to} | ${change.reason} — ${change.reasonText} |`), ...(extra ? [`\n${extra} more control changes are not shown.`] : []), summary.dropsWithoutReview ? `\n${summary.dropsWithoutReview} drop(s) have no tailoring or POA&M review change.` : ''].join('\n');
}
