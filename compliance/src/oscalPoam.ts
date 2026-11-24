import type { GapState, PoamMilestone } from './gaps.ts';
import { NS, OSCAL_VERSION } from './model.ts';
import { stableOscalUuid as uuid } from './oscalSsp.ts';

export type PoamGap = Readonly<{
  id: string;
  title: string;
  remediation: string;
  state?: GapState;
  milestones?: readonly PoamMilestone[];
  profiles?: readonly string[];
  controls?: readonly string[];
  ownerRole?: string;
}>;

/** Build a POA&M that preserves the source gap IDs, scope and remediation language. */
export function buildPoam(input: { readonly gaps: readonly PoamGap[]; readonly generatedAt: string }) {
  const risks = input.gaps.filter(gap => gap.milestones?.length).map(gap => ({
    uuid: uuid(`poam-risk:${gap.id}`), title: gap.title, description: gap.remediation, statement: gap.title,
    status: gap.state === 'risk-accepted' ? 'deviation-approved' : gap.state === 'closed' ? 'closed' : gap.state === 'in-progress' ? 'remediating' : 'open',
    remediations: [{
      uuid: uuid(`poam-remediation:${gap.id}`), title: `Milestones for ${gap.id}`, description: gap.remediation,
      lifecycle: 'planned',
      tasks: gap.milestones!.map(({ phase, targetDate, title }, index) => ({
        uuid: uuid(`poam-milestone:${gap.id}:${index}:${title}`), type: 'milestone', title,
        ...(phase ? { props: [{ name: 'phase', ns: NS, value: phase }] } : {}),
        ...(targetDate ? { timing: { 'on-date': { date: `${targetDate}T00:00:00Z` } } } : {})
      }))
    }]
  }));
  const items = input.gaps.filter(gap => gap.state !== 'closed' || gap.milestones?.length).map(gap => {
    const props = [
      ...(gap.profiles ?? []).map(value => ({ name: 'assessment-profile', ns: NS, value })),
      ...(gap.controls ?? []).map(value => ({ name: 'control-id', ns: NS, value })),
      ...(gap.ownerRole ? [{ name: 'owner-role', ns: NS, value: gap.ownerRole }] : [])
    ];
    return {
      uuid: uuid(`poam-item:${gap.id}`), title: `${gap.id}: ${gap.title}`, description: gap.remediation,
      ...(props.length ? { props } : {}),
      ...(gap.milestones?.length ? { 'related-risks': [{ 'risk-uuid': uuid(`poam-risk:${gap.id}`) }] } : {})
    };
  });
  return { 'plan-of-action-and-milestones': {
    uuid: '10000000-0000-5000-8000-000000000004',
    metadata: { title: 'NEAR AI POA&M draft', 'last-modified': input.generatedAt, version: '1.0.0', 'oscal-version': OSCAL_VERSION },
    ...(risks.length ? { risks } : {}), ...(items.length ? { 'poam-items': items } : {})
  } };
}
