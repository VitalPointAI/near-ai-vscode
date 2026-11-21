import { OSCAL_VERSION } from './model.ts';
type Gap = Readonly<{ id: string; title: string; remediation: string }>;

/** Build a POA&M that preserves the source gap ids and remediation language. */
export function buildPoam(input: { readonly gaps: readonly Gap[]; readonly generatedAt: string }) {
  return { 'plan-of-action-and-milestones': { uuid: '10000000-0000-5000-8000-000000000004', metadata: { title: 'NEAR AI POA&M draft', 'last-modified': input.generatedAt, version: '1.0.0', 'oscal-version': OSCAL_VERSION }, 'poam-items': input.gaps.map((gap, index) => ({ uuid: `10000000-0000-5000-8000-${String(index + 10).padStart(12, '0')}`, title: `${gap.id}: ${gap.title}`, description: gap.remediation })) } };
}
