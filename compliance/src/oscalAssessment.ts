import { OSCAL_VERSION } from './model.ts';

const uuid = (suffix: string) => `10000000-0000-5000-8000-${suffix.padStart(12, '0').slice(-12)}`;
const metadata = (title: string, at: string) => ({ title, 'last-modified': at, version: '1.0.0', 'oscal-version': OSCAL_VERSION });
const reviewed = (controls: readonly string[]) => ({ 'control-selections': [{ 'include-controls': controls.map((control) => ({ 'control-id': control })) }] });
type Row = Readonly<{ control: string; state: string; reasonText: string }>;

/** Build a fixture-safe OSCAL assessment plan from the dashboard control set. */
export function buildAssessmentPlan(input: { readonly controls: readonly string[]; readonly generatedAt: string }) {
  return { 'assessment-plan': { uuid: uuid('1'), metadata: metadata('NEAR AI assessment plan draft', input.generatedAt), 'import-ssp': { href: 'ssp/protected-b.json' }, 'reviewed-controls': reviewed(input.controls) } };
}

/** Build results from redacted bundle observations and the dashboard's honest non-met rows. */
export function buildAssessmentResults(input: { readonly rows: readonly Row[]; readonly generatedAt: string }) {
  const controls = [...new Set(input.rows.map((row) => row.control))].sort();
  return { 'assessment-results': { uuid: uuid('2'), metadata: metadata('NEAR AI assessment results draft', input.generatedAt), 'import-ap': { href: 'assessment-plan.json' }, results: [{ uuid: uuid('3'), title: 'Release evidence results', description: 'Evidence-derived release assessment results. Your organization decides whether this is sufficient.', start: input.generatedAt, end: input.generatedAt, 'reviewed-controls': reviewed(controls), remarks: input.rows.filter((row) => row.state === 'not-met' || row.state === 'stale').map((row) => `${row.control}: ${row.reasonText}`).join('\n') || 'No not-met or stale fixture rows.' }] } };
}
