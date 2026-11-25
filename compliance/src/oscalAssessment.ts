import { NS, OSCAL_VERSION, type Observation } from './model.ts';
import { stableOscalUuid as uuid } from './oscalSsp.ts';

const metadata = (title: string, at: string) => ({ title, 'last-modified': at, version: '1.0.0', 'oscal-version': OSCAL_VERSION });
const reviewed = (controls: readonly string[]) => ({ 'control-selections': [{ 'include-controls': controls.map((control) => ({ 'control-id': control })) }] });
type Row = Readonly<{ control: string; state: string; reasonText: string; dashboardIndex?: number }>;
type AssessmentScope = Readonly<{ level: string; title: string; rows: readonly Row[]; generatedAt: string }>;
const controls = (rows: readonly Row[]) => [...new Set(rows.map((row) => row.control))].sort();
const needsFinding = (row: Row) => row.state === 'not-met' || row.state === 'stale' || row.state === 'partly-met';

/** The plan imports the SSP for its level and schedules review of the release evidence. */
export function buildAssessmentPlan(input: AssessmentScope & { readonly collectors: readonly { id: string; window: string }[] }) {
  const tasks = input.collectors.map(({ id, window }) => ({
    uuid: uuid(`assessment-task:${input.level}:${id}`), title: `Review evidence from ${id}`, type: 'action',
    description: `Review the recorded results and collection time for ${id} against its ${window} evidence window.`
  }));
  return {
    'assessment-plan': {
      uuid: uuid(`assessment-plan:${input.level}`), metadata: metadata(`Sterling Sovereign AI ${input.title} assessment plan draft`, input.generatedAt),
      'import-ssp': { href: `ssp/${input.level}.json` }, 'reviewed-controls': reviewed(controls(input.rows)),
      ...(tasks.length ? { tasks } : {})
    }
  };
}

/** Build results from redacted observations and controls with open findings. */
export function buildAssessmentResults(input: AssessmentScope & {
  readonly plan: string;
  readonly statements: ReadonlyMap<string, string>;
  readonly observations: readonly Observation[];
}) {
  let start = input.generatedAt;
  let end = input.generatedAt;
  const observations = input.observations.map((observation, index) => {
    if (Date.parse(observation.collectedAt) < Date.parse(start)) start = observation.collectedAt;
    if (Date.parse(observation.collectedAt) > Date.parse(end)) end = observation.collectedAt;
    const outcome = observation.passed ? 'pass' : 'fail';
    const props = [
      { name: 'collector', ns: NS, value: observation.collector },
      { name: 'subject', ns: NS, value: observation.subject },
      { name: 'evidence-outcome', ns: NS, value: outcome },
      ...(observation.commit ? [{ name: 'commit', ns: NS, value: observation.commit }] : []),
      ...(observation.hash ? [{ name: 'sha256', ns: NS, value: observation.hash }] : []),
      ...Object.entries(observation.counts ?? {}).map(([name, count]) => ({ name: `count-${name}`, ns: NS, value: String(count) }))
    ];
    return {
      uuid: uuid(`assessment-observation:${input.level}:${observation.collector}:${observation.subject}:${observation.collectedAt}:${index}`),
      description: `Collector ${observation.collector} reported ${outcome} for ${observation.subject}.`,
      methods: ['EXAMINE'], collected: observation.collectedAt, props,
      'relevant-evidence': [{ href: observation.runUrl ?? '../evidence/bundle/observations.json', description: 'Redacted collector evidence.' }]
    };
  });
  const unlinked: string[] = [];
  const findings = input.rows.filter(needsFinding).flatMap(({ control, state, reasonText, dashboardIndex }) => {
    const statement = input.statements.get(control);
    if (!statement) {
      unlinked.push(`${control} (${state}): ${reasonText}`);
      return [];
    }
    return [{
      uuid: uuid(`assessment-finding:${input.level}:${control}`), title: `${control} release evidence finding`, description: reasonText,
      props: [{ name: 'evidence-state', ns: NS, value: state }],
      ...(state === 'partly-met' && dashboardIndex !== undefined ? { links: [{
        href: `../evidence/bundle/dashboard/dashboard.json#/rows/${dashboardIndex}`,
        rel: 'evidence', text: 'Verified bundle control row and mapped evidence'
      }] } : {}),
      target: { type: 'statement-id', 'target-id': statement, status: { state: 'not-satisfied', reason: 'other' } }
    }];
  });
  return {
    'assessment-results': {
      uuid: uuid(`assessment-results:${input.level}`), metadata: metadata(`Sterling Sovereign AI ${input.title} assessment results draft`, input.generatedAt),
      'import-ap': { href: input.plan },
      results: [{
        uuid: uuid(`assessment-result:${input.level}`), title: 'Release evidence results',
        description: 'Evidence-derived release assessment results. Your organization decides whether this is sufficient.',
        start, end, 'reviewed-controls': reviewed(controls(input.rows)),
        ...(observations.length ? { observations } : {}), ...(findings.length ? { findings } : {}),
        ...(unlinked.length ? { remarks: ['The packaged reference catalogue supplies no statement identifiers for these controls.', ...unlinked].join('\n') } : {})
      }]
    }
  };
}
