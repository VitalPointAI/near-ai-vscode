import type { PolicyDocument } from '../domain/gate/policyDocument';
import { passportReportListeners } from '../gate/sessionMark';
import type { PolicyLayersView } from '../gate/organizationStore';
import { whoToAsk } from '../domain/gate/passportStep';

// The report-only notice (74.1 D-22, D-28, 74.1-UI-SPEC S9, S10). While the model rules only report, the first would-refuse of route.passport in a session
// raises a notice that stays for the session at the top of the chat and in the status bar; it has no dismiss control, and it goes only when the effective
// mode turns to enforce (your organization's layer, or later a security officer's switch through the same effective mode). On a personal layer with no
// organization layer it offers Adopt the Western defaults, which only opens a policy editor proposal; nothing here writes the policy. Restricted Mode never
// hides it.

/** Every sentence of the notice and of Adopt (74.1-UI-SPEC S9, S10). */
export const REPORT_MODE_TEXT = Object.freeze({
  noticeOrg: 'Agent work is running outside your organization\'s model policy (report only).',
  noticeOwn: 'Agent work is running outside your rules for models (report only).',
  more: 'What this means',
  detailOrg: 'Your organization\'s rules only report models they do not approve, so agent work keeps running on them. Each use is recorded.',
  detailOwn: 'Your rules only report models they do not approve, so agent work keeps running on them. Each use is recorded. Adopting the Western defaults turns these reports into refusals.',
  adopt: 'Adopt the Western defaults',
  adoptReason: 'Adopt the Western defaults: agent work is refused on models your rules do not approve for it.',
  adoptEffectNear: 'Agent work will be refused on every model NEAR AI hosts today until a Western model is hosted.',
  adoptEffect: 'Agent work will be refused on models your rules do not approve for it.',
  statusText: '$(warning) Policy: models report only',
  statusTooltipEnd: 'Open it to see your policy.'
});

/** What the chat shows while the notice is raised. */
export interface ReportNoticeView {
  /** The first clause, in weight 600, and the rest of the sentence. */
  readonly lead: string;
  readonly tail: string;
  readonly more: string;
  readonly detail: string;
  /** Present only on a personal layer with no organization layer. */
  readonly adopt?: string;
}

let raised = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) {
    try { listener(); } catch { /* one listener never stops the others */ }
  }
}

/** Calls `listener` whenever the notice is raised or cleared. */
export function onReportNoticeChange(listener: () => void): { dispose(): void } {
  listeners.add(listener);
  return { dispose: () => { listeners.delete(listener); } };
}

function modeOf(layers: PolicyLayersView | undefined): 'report' | 'enforce' {
  return layers?.effective?.models?.mode === 'enforce' ? 'enforce' : 'report';
}

function organizationOf(layers: PolicyLayersView | undefined): PolicyDocument | undefined {
  return layers?.organization.state === 'valid' ? layers.organization.document : undefined;
}

/**
 * Starts the notice for this window's session: a would-refuse of route.passport raises it while the mode is report; a change of the host's rules clears
 * it when the effective mode is enforce. The returned disposer stops both and clears the notice.
 */
export function startReportModeNotice(host: { policyLayers(): PolicyLayersView; onDidChange(listener: () => void): () => void }): { dispose(): void } {
  const raise = (): void => {
    if (raised) return;
    let mode: 'report' | 'enforce' = 'report';
    try { mode = modeOf(host.policyLayers()); } catch { /* the notice is raised: it never hides a report */ }
    if (mode === 'enforce') return;
    raised = true;
    notify();
  };
  passportReportListeners.add(raise);
  const stop = host.onDidChange(() => {
    let mode: 'report' | 'enforce' = 'report';
    try { mode = modeOf(host.policyLayers()); } catch { return; }
    if (mode === 'enforce' && raised) { raised = false; notify(); }
  });
  return {
    dispose: () => {
      passportReportListeners.delete(raise);
      stop();
      if (raised) { raised = false; notify(); }
    }
  };
}

/** The notice's words now, or undefined when it is not raised. */
export function reportNoticeView(layers: PolicyLayersView | undefined): ReportNoticeView | undefined {
  if (!raised) return undefined;
  const organization = organizationOf(layers);
  const sentence = organization === undefined ? REPORT_MODE_TEXT.noticeOwn : REPORT_MODE_TEXT.noticeOrg;
  const split = sentence.indexOf(' (report only)');
  const contact = organization?.onboarding?.contacts.find((entry) => entry.topic === 'security');
  return Object.freeze({
    lead: sentence.slice(0, split),
    tail: sentence.slice(split),
    more: REPORT_MODE_TEXT.more,
    detail: organization === undefined ? REPORT_MODE_TEXT.detailOwn : `${REPORT_MODE_TEXT.detailOrg} ${whoToAsk(contact === undefined ? undefined : { name: contact.name, how: contact.how }, true)}`,
    ...(organization === undefined ? { adopt: REPORT_MODE_TEXT.adopt } : {})
  });
}

/** The status bar sentence while the notice is raised (Q9: words and an icon, no background colour). */
export function reportNoticeStatus(layers: PolicyLayersView | undefined): { readonly text: string; readonly tooltip: string } | undefined {
  if (!raised) return undefined;
  const sentence = organizationOf(layers) === undefined ? REPORT_MODE_TEXT.noticeOwn : REPORT_MODE_TEXT.noticeOrg;
  return { text: REPORT_MODE_TEXT.statusText, tooltip: `${sentence} ${REPORT_MODE_TEXT.statusTooltipEnd}` };
}

/** The proposal Adopt opens: the models section in enforce mode with unknown models at research only, on your own rules. */
export function adoptProposal(personal: PolicyDocument): { readonly from: string; readonly reason: string; readonly target: 'personal'; next(current: PolicyDocument): PolicyDocument } {
  // Under enforce nothing is above research until an approval carries your organization's evaluation (D-16); a personal layer has none by default, so the
  // models NEAR AI hosts today are refused for agent work.
  const evaluated = (personal.models?.passports ?? []).some((passport) => passport.evaluation !== undefined);
  return {
    from: REPORT_MODE_TEXT.adopt,
    reason: `${REPORT_MODE_TEXT.adoptReason} ${evaluated ? REPORT_MODE_TEXT.adoptEffect : REPORT_MODE_TEXT.adoptEffectNear}`,
    target: 'personal',
    next: (current) => ({ ...current, models: { ...(current.models ?? {}), v: 1, mode: 'enforce', unknownMaxTier: 'T0' } }) as PolicyDocument
  };
}

/**
 * Adopt the Western defaults: only on a personal layer with no organization layer, and only while the notice is raised; opens the proposal through
 * `propose` (the policy editor's openPolicyProposal). Returns false when it opened nothing.
 */
export async function adoptWesternDefaults(layers: PolicyLayersView | undefined, propose: (change: ReturnType<typeof adoptProposal>) => Promise<unknown>): Promise<boolean> {
  if (!raised || organizationOf(layers) !== undefined) return false;
  const personal = layers?.personal?.document;
  if (personal === undefined) return false;
  await propose(adoptProposal(personal));
  return true;
}

/** What a page's model policy action may reach. */
export interface ModelPolicyActionDeps {
  layers(): PolicyLayersView | undefined;
  propose(change: ReturnType<typeof adoptProposal>): Promise<unknown>;
  openResearchWorkspace(): Promise<unknown>;
  /** The guide's AI services option, when this build has it (P17). */
  addService?(): Promise<unknown>;
}

/**
 * One `model-policy-action` message from the chat page, checked field by field: adopt (only as adoptWesternDefaults allows), open-research-workspace, or
 * add-service when the build has it. Anything else, a dismiss included, changes nothing: the notice has no dismiss (T-74.1-58). Returns true when the
 * message was one of these.
 */
export async function modelPolicyAction(message: unknown, deps: ModelPolicyActionDeps): Promise<boolean> {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return false;
  const fields = message as Readonly<Record<string, unknown>>;
  if (fields['type'] !== 'model-policy-action') return false;
  switch (fields['action']) {
    case 'adopt': await adoptWesternDefaults(deps.layers(), (change) => deps.propose(change)); break;
    case 'open-research-workspace': await deps.openResearchWorkspace(); break;
    case 'add-service': if (deps.addService !== undefined) await deps.addService(); break;
    default: break;
  }
  return true;
}

/** The test seam: forgets the notice. */
export function resetReportNoticeForTests(): void {
  raised = false;
  listeners.clear();
}
