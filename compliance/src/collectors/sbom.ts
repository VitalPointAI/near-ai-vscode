import { createHash } from 'node:crypto';
import type { Observation } from '../model.ts';
import type { Collector, CollectorContext } from './types.ts';
import { collectorError } from './github.ts';

/** Reads CycloneDX SBOMs and Grype relay image scans without copying their sensitive detail (D-24). */
export interface SbomInput { readonly sboms: readonly { readonly subject: string; readonly file: string }[]; readonly scans?: readonly { readonly subject: string; readonly file: string }[]; readonly retainVsix?: boolean; }
const SUBJECT = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'unknown'] as const;
const isEntry = (entry: unknown): entry is { subject: string; file: string } => Boolean(entry && typeof (entry as { subject?: unknown }).subject === 'string' && SUBJECT.test((entry as { subject: string }).subject) && typeof (entry as { file?: unknown }).file === 'string' && (entry as { file: string }).file !== '');
function json(text: string, code: string): Record<string, unknown> { try { const value: unknown = JSON.parse(text); if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>; } catch { /* error below */ } throw collectorError(code, 'sbom: document is not the expected JSON shape'); }
function grypeCounts(text: string): Record<string, number> { const doc = json(text, 'not-grype-json'); if (!Array.isArray(doc.matches)) throw collectorError('not-grype-json', 'sbom: Grype report has no matches list'); const counts: Record<string, number> = Object.fromEntries(SEVERITIES.map((value) => [value, 0])); for (const match of doc.matches) { const raw = (match as { vulnerability?: { severity?: unknown } })?.vulnerability?.severity; const severity = typeof raw === 'string' ? raw.toLowerCase() : 'unknown'; counts[SEVERITIES.includes(severity as typeof SEVERITIES[number]) ? severity : 'unknown'] += 1; } counts.total = doc.matches.length; return counts; }

export const sbomCollector: Collector<SbomInput> = Object.freeze({
  id: 'sbom', window: 'head',
  async collect(input: SbomInput, context: CollectorContext): Promise<Observation[]> {
    if (!Array.isArray(input?.sboms) || input.sboms.length === 0 || !input.sboms.every(isEntry) || !(input.scans ?? []).every(isEntry)) throw collectorError('invalid-input', 'sbom: no valid input files given');
    const collectedAt = context.now.toISOString(); const observations: Observation[] = [];
    for (const entry of input.sboms) { const text = await context.readFile(entry.file); const doc = json(text, 'not-cyclonedx-json'); if (doc.bomFormat !== 'CycloneDX' || !Array.isArray(doc.components) || doc.components.length === 0) throw collectorError('not-cyclonedx-json', 'sbom: document is not a non-empty CycloneDX SBOM'); observations.push({ collector: 'sbom', subject: entry.subject, passed: true, collectedAt, commit: context.commit, ...(context.runUrl ? { runUrl: context.runUrl } : {}), hash: createHash('sha256').update(text).digest('hex'), counts: { components: doc.components.length } }); }
    for (const entry of input.scans ?? []) { const counts = grypeCounts(await context.readFile(entry.file)); observations.push({ collector: 'image-scan', subject: entry.subject, passed: counts.high === 0 && counts.critical === 0, collectedAt, commit: context.commit, ...(context.runUrl ? { runUrl: context.runUrl } : {}), counts }); }
    return observations;
  }
});
