import type { Block, Inline } from '../agent/docMarkdown';
import { createDocx } from '../agent/docxWriter';

export interface SaaSponsorReportInput {
  version: string;
  commit: string;
  generatedAt: string;
  sourceUrl: string;
  profiles: readonly {
    title: string;
    id: string;
    referenceOnly: boolean;
    rows: readonly {
      label: string;
      title: string;
      publishedState: string;
      publishedReason?: string;
      evidenceStatus: string;
      sponsorDraft: string;
      followUp: string;
    }[];
  }[];
}

const heading = (level: 1 | 2 | 3, text: string): Block => ({ kind: 'heading', level, inlines: [{ text }] });
const paragraph = (text: string): Block => ({ kind: 'paragraph', inlines: [{ text }] });
const field = (label: string, entry: string): Block => ({
  kind: 'paragraph',
  inlines: [{ text: label, bold: true }, { text: `  ${entry}` }]
});
const link = (text: string, url: string): Block => ({ kind: 'paragraph', inlines: [{ text, link: url }] });
const table = (columns: string[], rows: string[][]): Block => {
  const cell = (text: string): Inline[] => [{ text }];
  return { kind: 'table', header: columns.map(cell), rows: rows.map((row) => row.map(cell)), align: columns.map(() => 'left') };
};

const sponsor = '[Sponsor to confirm]';
const assessor = '[Assessor to complete]';
const pending = 'Pending';
const evidenceWorkbook = 'evidence/SA-and-A-control-and-evidence-workbook.xlsx';
const evidenceIndex = 'evidence/evidence-index.csv';
const actionRegister = 'evidence/gap-and-action-register.csv';
const coverTitle = 'SA&A submission cover and routing record';
const reportTitle = 'Security Assessment Report';

export function buildSaaSponsorReport(input: SaaSponsorReportInput): Buffer {
  const baseline = `NEAR AI for VS Code v${input.version}`;
  const rowCount = input.profiles.reduce((total, profile) => total + profile.rows.length, 0);
  const transmittal = heading(2, 'Draft transmittal');
  const sponsorPlan = heading(1, 'Proposed sponsor scope and operating plan');
  const report = heading(1, reportTitle);
  const controlAnnex = heading(2, 'Annex A. Proposed sponsor entries by profile');
  const blocks: Block[] = [
    heading(1, coverTitle),
    field('Supplier-prepared draft for sponsor review', 'Revision 0.1'),
    heading(2, 'Submission details'),
    table(['Field', 'Entry'], [
      ['Product and supplier', 'NEAR AI for VS Code, VitalPointAI'],
      ['Release and source commit', `v${input.version}, ${input.commit}`],
      ['Request', 'Initial scope confirmation and Security Assessment and Authorization (SA&A) intake'],
      ['Sponsoring department, program and unit', sponsor],
      ['Departmental system name, identifier and SA&A file number', sponsor],
      ['Business or operational owner', '[Sponsor to designate]'],
      ['System owner and operating organization', '[Sponsor to designate]'],
      ['Proposed deployment boundary and environment', 'Start with the proposed extension installation. Identify the deployment environment, connected services and interfaces, and reference the approved boundary and inventory.'],
      ['Submission date, package revision and recipient', 'Draft revision 0.1. [Sponsor to enter submission date, final revision and recipient.]'],
      ['Recommended handling for this baseline', 'Public release evidence and draft worksheets. The sponsor assigns handling to the completed package and attachments before transfer.'],
      ['Authorized repository or transfer channel', '[Receiving security authority to specify]']
    ]),
    transmittal,
    field('To', '[Departmental security intake or delegated assessment authority]'),
    field('From', '[Sponsoring official and business contact]'),
    paragraph(`Please review this supplier package for initial SA&A intake for the system identified on the cover. It provides release-specific evidence and proposed entries for ${baseline}. Please confirm the assessment boundary, categorization, tailored control profile, current departmental forms, review authority, submission location and evidence handling instructions. The assessor determines whether product evidence supports the deployment assessment. The designated departmental authorities record findings, accept residual risk and decide authorization.`),
    field('Business owner endorsement', '[Name or position, authority reference, signature and date]'),
    field('Intake acknowledgement', '[Receiving authority, case identifier and date]'),
    heading(2, 'Intake and decision record'),
    table(['Check', 'Responsible role', 'Record or status'], [
      ['Confirm the intake process, current departmental templates, submission channel and approved handling', 'Departmental security intake', pending],
      ['Identify program sponsor, business owner, system owner and accountable operator', 'Sponsoring department', pending],
      ['Confirm assessor, reviewer independence and authorizing official’s delegation', 'Departmental security authority', pending],
      ['Validate categorization and select or tailor the baseline', 'Business owner and security authority', pending],
      ['Decide whether privacy and procurement reviews apply', 'Departmental privacy and procurement leads', pending],
      ['Acknowledge package revision and evidence receipt', 'Intake authority', pending]
    ]),
    paragraph('Keep the release, the evidence snapshot and departmental deployment records separately identifiable. Record revisions, hashes and recipients. Store sensitive deployment details and signatures in the approved departmental repository.'),
    heading(2, 'References'),
    link('DND public solicitation W6369-23-P5PE, §3.2', 'https://canadabuys.canada.ca/sites/default/files/webform/tender_notice/8466/w6369-23-p5pe_rfp.pdf'),
    link('Government of Canada Security Playbook for Information System Solutions', 'https://www.canada.ca/en/government/system/digital-government/digital-government-innovations/cloud-services/security-playbook-information-system-solutions-cloud.html'),
    link(`v${input.version} published release`, input.sourceUrl),
    sponsorPlan,
    heading(2, 'Security categorization and statement of sensitivity'),
    paragraph(`Begin with the proposed departmental use of ${baseline}. Describe the supported business activity, users, dependencies and consequences of service loss. Inventory the information handled at rest and in transit, including project material, prompts and responses, credentials, audit and operational records, and attachments where in scope.`),
    table(['Sponsor entry', 'Proposed treatment'], [
      ['Business process, mandate and deployment', '[Enter the approved purpose, system owner, users, mission dependencies and environment.]'],
      ['Information inventory and injury assessment', '[Identify information owners and authorized handling. Assess confidentiality, integrity and availability injury separately, with its rationale.]'],
      ['Recommended categorization', '[Enter the resulting categorization, exceptions and conditions after validating the inventory.]'],
      ['Concurrence', '[Enter business and security authority names or positions, dates and record references.]']
    ]),
    paragraph('Use forms/editable/01-02-scar-and-statement-of-sensitivity.docx to document the categorization, inventory and concurrence.'),
    heading(2, 'Tailored security profile'),
    paragraph('Proposed approach. Select the baseline from the approved categorization, applicable departmental requirements and actual operating environment. Confirm whether any separate overlay applies. Record control additions, tailoring, inheritance, exclusions, responsible owners, supporting rationale and approval references.'),
    table(['Decision', 'Sponsor entry'], [
      ['Candidate scope and baseline', '[Enter categorization, profile version, proposed overlays and their decision authorities.]'],
      ['Tailoring and inheritance', '[Enter control IDs, proposed disposition, owner, justification, compensating measures and supporting records.]'],
      ['Profile approval', '[Enter approving authority, scope conditions, profile revision, signature reference and date.]']
    ]),
    paragraph('Record the decision and submit the draft approval letter using forms/editable/01-03-tailored-profile-approval.docx.'),
    heading(2, 'Procurement and privacy intake'),
    paragraph('Ask the departmental procurement and privacy leads to determine which reviews and official forms apply. Record the solicitation or contract requirements and the handling and screening conditions identified by the contracting authority. For privacy, describe the personal information, purpose, authority, collection, access, transmission, retention and disposition. Record the privacy office’s screening outcome and any required assessment, registration or protocol.'),
    table(['Track', 'Sponsor entry'], [
      ['Procurement and contract security', '[Enter procurement reference, applicability decision, authority, required clauses or forms, and record reference.]'],
      ['Privacy and personal information', '[Enter data inventory reference, accountable privacy lead, screening decision, required actions and record references.]'],
      ['Departmental intake readiness', '[Confirm approved forms, evidence channel, package revision, signatures and required attachments.]']
    ]),
    paragraph('Use forms/editable/01-05-conditional-forms-and-intake-checklist.docx and forms/official/README.md for conditional records and issuing authority links.'),
    heading(2, 'Security concept of operations'),
    paragraph('Proposed operating concept. Identify the authorized user groups, workspaces, administrators and support paths. Describe normal operation and privileged work, shared services, trust boundaries and the interfaces used to send or receive information. Document the proposed response when a service fails, an endpoint becomes unavailable, or an incident requires isolation or recovery.'),
    field('Boundary, deployment and operating approvals', '[Enter diagrams, environments, authorized users, operating roles and emergency contacts.]'),
    paragraph('Use forms/editable/02-01-security-conops.docx to record the approved operating concept.'),
    heading(2, 'System security and privacy plan'),
    paragraph('Proposed design record. Tie the deployment inventory, identity and access design, data flow and approved configurations to the tailored profile. Identify segregation, audit, credential and key management, model endpoint restrictions, vulnerability handling, and backup and recovery settings where applicable. Record how personal and sensitive information will be minimized, protected, retained and disposed of.'),
    table(['Plan record', 'Sponsor entry'], [
      ['Architecture, data flow and configuration baseline', '[Enter approved inventories, diagrams, operators, service versions, data locations and configuration revisions.]'],
      ['Security and privacy implementation', '[Map each relevant design measure and inherited dependency to its owner, applicable control and evidence reference.]'],
      ['Approval and change control', '[Enter plan owner, approved revision, change thresholds and change authority.]']
    ]),
    paragraph('Use forms/editable/02-02-system-security-and-privacy-plan.docx for complete design and privacy records.'),
    heading(2, 'Threat and risk assessment'),
    paragraph('Proposed TRA method. Identify assets and trust boundaries, record credible threat scenarios and relevant weaknesses, and assess likelihood and impact using the department’s approved criteria. Link treatment to the applicable controls and assess residual risk after collecting evidence. Consider unauthorized access, disclosure to external services, integrity of shared state and operational disruptions where applicable.'),
    table(['Risk record', 'Sponsor entry'], [
      ['Scope, criteria and reviewer', '[Enter boundary revision, assets, applicable methodology, threat sources and reviewer.]'],
      ['Threat scenarios and treatment', '[Enter asset, threat, weakness, likelihood, impact, treatment owner and evidence reference for each scenario.]'],
      ['Residual risk', '[Enter reviewed ratings and decision references after assessment.]']
    ]),
    paragraph('Use forms/editable/02-04-threat-and-risk-assessment.docx to record scenario analysis and treatment.'),
    heading(2, 'Operations and continuous monitoring'),
    paragraph('Proposed monitoring plan. Define the signals, owners, thresholds, review cadence and evidence retention for access changes, operational events, updates, configuration drift and incident response. Identify conditions that require retesting or reassessment. Record how the department will test recovery, preserve audit evidence and escalate overdue actions.'),
    field('Monitoring schedule and ownership', '[Enter systems monitored, operational owners, review dates, incident and escalation routes, reassessment triggers and evidence locations.]'),
    paragraph('Use forms/editable/02-03-operations-and-monitoring.docx for detailed operational records and monitoring assignments.'),
    heading(2, 'Security assessment plan'),
    paragraph('Proposed plan. Assess the authorized boundary and approved control objectives on a representative deployment. For each objective, specify an examination, interview or test, expected result, evidence artifacts, sampling justification and planned depth. Review the release evidence for applicability and collect deployment-specific evidence wherever the objective requires it.'),
    table(['Planning field', 'Proposed entry'], [
      ['Scope and assessor', '[Enter boundary, profile, objectives, exclusions, assessor and independence record.]'],
      ['Execution and evidence', '[Enter environment, methods, samples, expected results, milestones, evidence handling and approved locations.]'],
      ['Review and approvals', '[Enter plan approval, limitations, change procedures and reporting dates.]']
    ]),
    paragraph('Use forms/editable/03-01-security-assessment-plan.docx to record the approved written plan and working assessment record.'),
    report,
    field('Assessment working draft', 'Revision 0.1'),
    field('Product evidence baseline', baseline),
    field('Deployment assessment status', pending),
    paragraph('Use forms/editable/03-04-security-assessment-report.docx when the department needs a separate assessor working copy.'),
    heading(2, 'Executive summary'),
    table(['Field', 'Assessor entry'], [
      ['Department, system, case and boundary reference', 'Use the cover record and the approved departmental boundary document.'],
      ['Approved categorization, tailored profile and plan', '[Enter approved document IDs, dates and revisions.]'],
      ['Assessment period, assessor and independence declaration', assessor],
      ['Deployment versions, configuration and sites assessed', `Candidate product baseline is ${baseline}. [Enter assessed builds, configurations, environments and sites.]`],
      ['Overall conclusion and limitations', '[Complete after examination, interviews and tests. Record scope and evidence limitations.]'],
      ['Findings to resolve before authorization', 'Use the release gaps and Annex A as leads. [Enter confirmed deployment findings.]'],
      ['Residual risks and recommended operating conditions', '[Enter assessed risks and proposed conditions after review.]']
    ]),
    paragraph('Proposed sponsor position. Use the selected release as the candidate supplier baseline. Confirm the deployment’s information categories, system boundary, applicable control profiles and separately governed overlays before setting the assessment scope.'),
    heading(2, 'Inputs and method'),
    paragraph('Proposed operating boundary. Begin with the deployed extension and its host editor. For services the department plans to use, record the operator, versions, authentication, trust boundaries, what crosses each interface, and how data is protected, retained and monitored. Consider shared workspace services, model endpoints and any optional integrations in use. Confirm external and inherited dependencies with their owners.'),
    paragraph('Proposed responsibilities. The sponsor and system owner maintain the boundary, operating configuration, ownership and evidence references. The operational and inherited control owners confirm their assigned controls. The assessor confirms applicability and effectiveness. The authorizing official records any conditions and risk decision.'),
    paragraph('Draft assessment method. For each applicable objective, identify the expected outcome, responsible role, assessment method and acceptable evidence. Examine approved configurations and records, interview control owners, and test representative deployments where the plan calls for testing. Record the evidence cut-off, sampling rationale, environment differences and departures from the approved plan.'),
    field('Assessment plan, environment, evidence repository and cut-off', assessor),
    paragraph(`Record each applicable objective’s disposition in the control and evidence workbook at ${evidenceWorkbook}. Use the evidence requests and POA&M worksheet at forms/editable/03-03-evidence-requests-and-poam.docx to request missing material and track agreed remediation.`),
    heading(2, 'Product release observations'),
    table(['Item', 'Recorded baseline'], [
      ['Release and source commit', `${baseline}, ${input.commit}`],
      ['Product evidence snapshot (UTC)', input.generatedAt],
      ['Profile and overlay rows in this package', String(rowCount)],
      ['Evidence sources', `See ${evidenceIndex} and evidence/release-package/. Their provenance and checksums are described in evidence/README.md.`],
      ['Evidence reuse', 'Confirm release, configuration, assessment boundary, freshness and assurance depth against each deployment objective before relying on product evidence.']
    ]),
    heading(2, 'Deployment findings and coverage'),
    paragraph('Assessment of the specific deployment is pending. Annex A provides proposed sponsor responses for discussion. Its product states describe the published snapshot, and its evidence status describes the support available for review. The assessor records the deployment finding after reviewing applicable evidence.'),
    table(['Finding or objective ID', 'Control and profile', 'Scope and component', 'Method and evidence IDs', 'Observed result and rationale', 'Assessor disposition, date and reviewer'], [
      ['[Enter ID]', '[Enter control and profile]', '[Enter scope]', '[Enter method and IDs]', '[Enter observed result]', '[Enter disposition]']
    ]),
    paragraph('Record assessed, excluded, inherited, deferred and unevaluated objectives separately. Record a rationale for each exclusion or inherited disposition. Reference the approved location of underlying artifacts by evidence ID.'),
    heading(2, 'Residual risk and recommendation'),
    table(['Finding or limitation', 'Consequence and residual risk', 'Remediation or operating condition', 'Owner, due date and verification method'], [
      ['[Enter finding]', '[Enter assessed risk]', '[Enter proposed action or condition]', '[Enter owner, date and closure test]']
    ]),
    paragraph(`Start supplier follow-up with the gap and action register at ${actionRegister}. Open departmental actions for verified deployment findings. Assign an owner and target date, propose a practical remediation and closure test, and record the reviewer’s disposition when supporting evidence arrives.`),
    field('Assessor conclusion and recommendation', assessor),
    field('Assessor signature and date', assessor),
    field('Independent reviewer and date', '[Independent reviewer to complete]'),
    field('Distribution and handling marking', sponsor),
    paragraph('Attach the evidence and remediation record and the independent review form at forms/editable/03-02-security-assessment-report-review.docx. Route the recommendation through the sponsor to the designated official using forms/editable/01-04-authorization-and-residual-risk.docx.'),
    link('Cyber Centre assessment, authorization and monitoring guidance', 'https://www.cyber.gc.ca/en/guidance/cyber-security-privacy-risk-management/itsp10033/assessment-authorization-monitoring'),
    heading(2, 'Evidence requests and plan of action and milestones (POA&M)'),
    table(['Register', 'Proposed action'], [
      ['Evidence request', 'Record the objective, exact artifact or observed activity required, assigned owner, due date and acceptable evidence. Record the reviewed evidence ID and disposition when received.'],
      ['Remediation item', 'Link the applicable objective and verified finding. Record the consequence, priority and risk, correction or interim measure, assigned owner and milestone dates.'],
      ['Closure record', 'Identify the retest or examination criteria, corrected scope, closure evidence ID, reviewer and date.']
    ]),
    paragraph(`Start with ${evidenceIndex}, ${actionRegister} and the source records at evidence/release-package/. Use forms/editable/03-03-evidence-requests-and-poam.docx for individual requests, actions and approval records.`),
    heading(2, 'Independent Security Assessment Report review'),
    paragraph('Proposed review. Confirm reviewer independence, coverage against the approved plan, reproducibility of evidence and alignment between findings, risk and recommendations. Record unresolved discrepancies, required changes and evidence of closure before routing the report.'),
    field('Review record', '[Enter report version, reviewer authority and independence, checks performed, findings, disposition, signature reference and date.]'),
    paragraph('Use forms/editable/03-02-security-assessment-report-review.docx for the independent review and its findings.'),
    heading(2, 'Authorization decision and residual risk acceptance'),
    paragraph('Proposed routing. Present the final assessment, independent review, open findings and sponsor recommendation to the designated authorizing official. Document the decision and its authority, scope, conditions, review or expiry dates, residual risk acceptance and limits. Route the signed decision through the approved departmental channel.'),
    field('Decision and authority', '[Authorizing official to complete after review. Enter decision, delegation reference, risk dispositions, operating conditions, effective dates, signature reference and distribution.]'),
    paragraph('Use forms/editable/01-04-authorization-and-residual-risk.docx for the decision record and draft letter.'),
    controlAnnex,
    paragraph('Review the entries against the approved scope and update the sponsor responses before submission. Reference-only profiles require separate scoping and direction. The accompanying workbook identifies control IDs, product evidence, ownership and assessment fields for working through the annex.')
  ];

  for (const profile of input.profiles) {
    blocks.push(
      heading(3, `${profile.title} (${profile.id})`),
      paragraph(`${profile.referenceOnly ? 'Reference only' : 'Applicability pending sponsor confirmation'}. ${profile.rows.length} published rows.`),
      table(['Control', 'Published state and evidence', 'Proposed sponsor entry and follow-up'], profile.rows.map((row) => [
        `${row.label}\n${row.title}`,
        [row.publishedState, row.evidenceStatus, row.publishedReason].filter(Boolean).join('\n'),
        `${row.sponsorDraft}\n${row.followUp}`
      ]))
    );
  }

  return createDocx({
    title: `Security Assessment and Authorization sponsor draft for ${baseline}`,
    author: 'VitalPointAI',
    pageSize: 'A4',
    blocks,
    images: new Map(),
    pageBreakBeforeHeadings: new Set([transmittal, sponsorPlan, report, controlAnnex]),
    tableOfContentsBefore: transmittal
  }).bytes;
}
