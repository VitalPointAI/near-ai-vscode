import type { SspInput } from './oscalSsp.ts';

export function renderSspMarkdown(input: SspInput): string {
  const rows = input.rows.filter((row) => row.level === input.level.id).sort((a, b) => a.control.localeCompare(b.control));
  return [`# ${input.level.title} SSP draft`, '', 'Your organization decides whether this draft is sufficient. It is not an authorization.', '', '| Control | Evidence state | Reason |', '| --- | --- | --- |', ...rows.map((row) => `| ${row.control} | ${row.state} | ${row.reasonText} |`), ''].join('\n');
}

export function renderReadme(release: string, commit: string): string {
  return [`# NEAR AI compliance package ${release}`, '', `Release commit: \`${commit}\`.`, '', 'This documentation package is evidence for an assessor. It is not an authorization, accreditation, or certification. Your organization decides whether it is sufficient and who authorizes a system.', '', 'Verify files with `sha256sum --check SHA256SUMS` from this folder. Verify a release attestation with `gh attestation verify <asset> --repo VitalPointAI/near-ai-vscode`.', '', 'To import the OSCAL documents into Compliance Trestle, use Python 3.11 or later and run `trestle import -f oscal/ssp/protected-b.json` after installing Trestle in your own environment.', ''].join('\n');
}

export function renderGaps(gaps: readonly { id: string; title: string; remediation: string }[]): string {
  return ['# Gaps and POA&M', '', 'Your organization decides how to address these documented gaps.', '', ...gaps.map((gap) => `## ${gap.id}: ${gap.title}\n\n${gap.remediation}\n`)].join('\n');
}
