import { isDeepStrictEqual } from 'node:util';
import { decideRoute, type RoutePolicy, type RoutingTable, type RoutingTier } from '../../domain/gate/routing';
import type { Label } from '../../domain/gate/labels';
import { MODE_IDS } from '../../domain/org/modes';
import type { OpenGetStartedRequest } from '../../domain/setup/answers';
import { cardFor } from '../../domain/setup/cards';
import { changeList } from '../../domain/setup/changes';
import type { HostKind } from '../../domain/setup/device';
import { buildAbandonedRecord } from '../../domain/setup/guideRecord';
import type { GuideInbound, GuideOutbound } from '../../domain/setup/guideMessages';
import { exerciseFor, resolveLanding, type Landing, type LandingPort } from '../../domain/setup/landing';
import { proposeLabel, raiseOnly, useFor } from '../../domain/setup/map';
import { modeRowOf, suggestMode, type ModeRow } from '../../domain/setup/modes';
import { GENERIC_CONTACT_TEXT, readGuidePolicy, type GuidePolicy, type GuidePolicyInput } from '../../domain/setup/policy';
import { recommend, type OptionInput } from '../../domain/setup/recommend';
import { screenFor } from '../../domain/setup/screens';
import { nextSession, startSession, type GuideEffect, type GuideEvent, type GuideSession } from '../../domain/setup/session';
import { isChoosable, type ViabilityResult } from '../../domain/setup/viability';
import { planApply, runApply, type ApplyContext, type ApplyDeps, type ApplyStep } from './apply';
import { approvedDeviceName, proposedRoutePolicy, routeFactsOf } from './guideFacts';
import { isSharedProject, readProjectLayer, readSetupGuide } from './projectStore';
import { clearanceProposalFor } from './proposals';
import type { ViabilityRun } from './viabilityRunner';

type ReadyPolicy = Extract<GuidePolicy, { state: 'ready' }>;

export interface GuideRouteSnapshot {
  readonly view: GuidePolicyInput;
  readonly hash: string;
  readonly route: RoutePolicy;
  readonly routing: RoutingTable;
  readonly defaultLabel: Label;
  readonly projectLabel?: Label;
  readonly floor?: RoutingTier;
}

type PolicySnapshot = GuideRouteSnapshot | { readonly view: GuidePolicyInput };
type PreflightResult = 'ready' | 'blocked' | 'route-changed';
type ApplyPorts = Omit<ApplyDeps, 'root' | 'record' | 'preflight' | 'connection'> & {
  connection(result: ViabilityResult): ApplyStep | undefined;
};

export interface GuideControllerDeps {
  readonly root: string;
  readonly machine: string;
  readonly hostKind: HostKind;
  readonly clock?: () => number;
  readPolicy(now: number): Promise<PolicySnapshot>;
  check(snapshot: GuideRouteSnapshot, progress: (result: ViabilityResult) => void, signal: AbortSignal): Promise<ViabilityRun>;
  readonly apply: ApplyPorts;
  readonly landing: LandingPort;
  post(message: GuideOutbound): void;
  close?(): void;
}

export interface GuideController {
  open(request?: OpenGetStartedRequest): Promise<void>;
  receive(message: GuideInbound): Promise<void>;
  dispose(): void;
}

const scan = { offered: false, ranges: [], running: false } as const;
const checkAgainText = 'The rules or connection changed during checking. Close Get Started and open it again to recheck your options.';

function factsFor(result: ViabilityResult, snapshot: GuideRouteSnapshot, now: number) {
  return result.policyHash === snapshot.hash ? routeFactsOf(result, now) : undefined;
}

function contactFor(policy: GuidePolicy): string {
  return (policy.contacts.find(({ topic }) => topic === 'security') ?? policy.contacts[0])?.name ?? GENERIC_CONTACT_TEXT;
}

function labelFor(session: GuideSession, policy: ReadyPolicy, snapshot: GuideRouteSnapshot) {
  const outcome = proposeLabel(session.answers, { scales: snapshot.route.scales, routing: snapshot.routing, defaultScale: policy.defaultScale });
  return { outcome, label: raiseOnly(snapshot.projectLabel, outcome, snapshot.route.scales) };
}

export function createGuideController(deps: GuideControllerDeps): GuideController {
  const now = deps.clock ?? Date.now;
  const lifetime = new AbortController();
  let session: GuideSession | undefined;
  let policy: GuidePolicy | undefined;
  let snapshot: GuideRouteSnapshot | undefined;
  let applyContext: ApplyContext | undefined;
  let modeRow: ModeRow | undefined;
  let landing: Landing | undefined;
  let checking: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let openInFlight: Promise<void> | undefined;

  function stopChecking(): void {
    checking?.abort();
    checking = undefined;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }

  function postScreen(): void {
    if (lifetime.signal.aborted || !session || !policy) return;
    const current = session;
    const verified = snapshot;
    const route = verified && policy.state === 'ready' ? labelFor(current, policy, verified) : undefined;
    const stop = route?.outcome.stop;
    const approvedDevice = current.screen === 'stopped' && verified && route && (stop === 'classified' || stop === 'protected-c')
      ? approvedDeviceName(verified.route, route.outcome.proposed, useFor(current.answers), now()) : undefined;
    const cards = verified && route ? current.results.flatMap((viability) => {
      const outcome = current.recommendation?.options.find(({ optionId }) => optionId === viability.optionId);
      if (!outcome) return [];
      return [cardFor({ viability, outcome, facts: factsFor(viability, verified, now()),
        context: { mark: [route.label.proposed], routing: verified.routing, defaultLabel: verified.defaultLabel }, scales: verified.route.scales })];
    }) : [];
    const kind = deps.hostKind;
    const checkedOn = deps.machine + (kind === 'container' ? ', a container' : kind === 'remote' ? ', a remote computer' : '');
    deps.post({ type: 'screen', screen: screenFor(current, {
      cards, candidates: [], scan, checkedOn, policy, contacts: policy.contacts, startingRules: false, modeRow, landing, approvedDevice
    }) });
  }

  function failClosed(text: string, contacts: GuidePolicy['contacts'] = policy?.contacts ?? []): void {
    stopChecking();
    policy = { state: 'failed-closed', sentence: text, contacts };
    postScreen();
  }

  async function readPolicy(): Promise<{ snapshot: GuideRouteSnapshot; policy: ReadyPolicy } | undefined> {
    const current = await deps.readPolicy(now());
    const view = readGuidePolicy(current.view);
    if (view.state === 'failed-closed' || !('route' in current)) {
      failClosed(view.state === 'failed-closed' ? view.sentence : checkAgainText, view.contacts);
      return undefined;
    }
    return { snapshot: current, policy: view };
  }

  async function runCheck(checkId: number): Promise<void> {
    const opened = snapshot;
    const current = session;
    if (!opened || !current) return;
    stopChecking();
    const signal = new AbortController();
    checking = signal;
    const progress = (result: ViabilityResult) => {
      if (signal.signal.aborted) return;
      void dispatch({ type: 'viability-progress', result, checkId });
    };
    try {
      const latest = await readPolicy();
      if (!latest || signal.signal.aborted) return;
      if (latest.snapshot.hash !== opened.hash) return failClosed(checkAgainText);
      snapshot = latest.snapshot;
      policy = latest.policy;
      if (labelFor(current, policy, snapshot).outcome.stop !== undefined) {
        await dispatch({ type: 'viability-done', results: [], checkId });
        return;
      }
      const result = await deps.check({
        ...snapshot, route: proposedRoutePolicy(snapshot.route, current.answers.canada)
      }, progress, signal.signal);
      try {
        if (signal.signal.aborted) return;
        if (result.stillChecking.length > 0) await dispatch({ type: 'ceiling', checkId });
        else await dispatch({ type: 'viability-done', results: result.results, checkId });
      } finally {
        result.dispose();
      }
    } catch {
      if (!signal.signal.aborted) await dispatch({ type: 'viability-done', results: [], checkId });
    }
  }

  async function recommendation(current: GuideSession, checkId: number): Promise<void> {
    const fresh = await readPolicy();
    if (session !== current || lifetime.signal.aborted || !fresh) return;
    if (fresh.snapshot.hash !== snapshot?.hash) return failClosed(checkAgainText);
    snapshot = fresh.snapshot;
    policy = fresh.policy;
    const { label, outcome } = labelFor(current, policy, snapshot);
    const at = now();
    const options: OptionInput[] = [];
    const missing = [];
    for (const viability of current.results) {
      const facts = factsFor(viability, snapshot, at);
      const { kind, optionId } = viability;
      if (!facts) missing.push({ kind, optionId, outcome: 'not-available' as const });
      else options.push({ kind, optionId, viability, facts });
    }
    const result = recommend({
      mark: [label.proposed], routing: snapshot.routing, defaultLabel: snapshot.defaultLabel, floor: snapshot.floor,
      policy: proposedRoutePolicy(snapshot.route, current.answers.canada), options, use: useFor(current.answers),
      kind: current.answers.kindOfWork, now: at, contact: contactFor(policy), stopped: outcome.stop
    });
    await dispatch({ type: 'recommendation', checkId, recommendation: { ...result, options: [...result.options, ...missing] } });
  }

  async function changes(current: GuideSession): Promise<void> {
    if (!snapshot || policy?.state !== 'ready') return;
    const next = await readPolicy();
    if (session !== current || lifetime.signal.aborted || !next) return;
    if (next.snapshot.hash !== snapshot.hash || !isDeepStrictEqual(next.snapshot.projectLabel, snapshot.projectLabel)) return failClosed(checkAgainText);
    const shared = await isSharedProject(deps.root);
    if (session !== current || lifetime.signal.aborted) return;
    const { route, projectLabel: currentLabel } = snapshot;
    const { outcome, label } = labelFor(current, policy, snapshot);
    const project = readProjectLayer(deps.root, route.scales);
    const layer = project.state === 'valid' ? project.layer : undefined;
    const currentMode = MODE_IDS.find((mode) => mode === layer?.mode);
    const mode = suggestMode({ kind: current.answers.kindOfWork, policy: policy.organizationMode, setByOrganization: policy.setByOrganization });
    modeRow = modeRowOf(mode);
    // Operational approval requires the later staff scenario. This slice stays at exercise-only for staff.
    const exercise = exerciseFor({ kind: current.answers.kindOfWork, operationalApproved: false });
    const { canada } = current.answers;
    const canadaOnly = canada === 'yes' || canada === 'not-sure';
    const prior = readSetupGuide(deps.root);
    const chosen = current.recommendation?.options.find(({ optionId }) => optionId === current.chosen);
    const clearance = clearanceProposalFor(label.proposed, route.organization);
    const items = changeList({
      current: { label: currentLabel, answers: prior?.answers, mode: currentMode,
        exercise: layer?.exercise !== undefined, residency: layer?.residency?.required, connection: prior?.chosen[0] },
      proposal: label, requestedLabel: outcome.proposed, answers: current.answers,
      chosen: chosen ? [chosen.kind] : [], chosenIds: chosen ? [chosen.optionId] : [],
      mode, exercise, canada, residencyBySetting: policy.locked.canada ? 'already' : 'project',
      clearances: route.clearances, dominance: { scales: route.scales, mappings: route.mappings, now: now() },
      shared, proposals: [], scales: route.scales
    }).filter(({ id }) => id !== 'your-rules:clearance' || clearance !== undefined);
    applyContext = {
      label,
      project: { mode: mode.mode, ...(canadaOnly ? { residency: { required: ['CA'] } } : {}),
        ...(exercise.exercise && exercise.reason ? { exercise: { reason: exercise.reason, setAt: new Date(now()).toISOString() } } : layer?.exercise ? { exercise: null } : {}) },
      proposals: clearance ? [{ id: 'clearance', kind: 'clearance', change: clearance }] : []
    };
    await dispatch({ type: 'changes-ready', changes: items });
  }

  async function preflight(current: GuideSession, reviewed: GuideRouteSnapshot, selected: ViabilityResult | undefined): Promise<PreflightResult> {
    const next = await readPolicy();
    const sameAuthority = (current: GuideRouteSnapshot) => current.hash === reviewed.hash && current.floor === reviewed.floor &&
      isDeepStrictEqual(current.projectLabel, reviewed.projectLabel) && isDeepStrictEqual(current.route.residency, reviewed.route.residency);
    if (!next || !sameAuthority(next.snapshot) || lifetime.signal.aborted) return 'blocked';
    if (!selected) return !current.chosen && current.recommendation?.state === 'stopped' ? 'ready' : 'blocked';
    const checked = await deps.check({
      ...next.snapshot, route: proposedRoutePolicy(next.snapshot.route, current.answers.canada)
    }, () => {}, lifetime.signal);
    try {
      const latest = await readPolicy();
      if (!latest || !sameAuthority(latest.snapshot) || lifetime.signal.aborted) return 'blocked';
      const result = checked.results.find(({ optionId }) => optionId === selected.optionId);
      const at = now();
      if (!result || !isChoosable(result, at)) return 'blocked';
      const facts = factsFor(result, latest.snapshot, at);
      const planned = selected.routeFacts;
      if (!facts || !planned) return 'blocked';
      if (facts.clientRoute !== planned.clientRoute || facts.host !== planned.host || !isDeepStrictEqual(facts.model, planned.model)) return 'route-changed';
      const { label, outcome } = labelFor(current, latest.policy, latest.snapshot);
      if (outcome.stop !== undefined) return 'blocked';
      const { route, routing, defaultLabel, floor } = latest.snapshot;
      const decision = decideRoute([label.proposed], routing, { ...facts, use: useFor(current.answers) }, defaultLabel, floor,
        proposedRoutePolicy(route, current.answers.canada));
      return decision.allowed ? 'ready' : 'blocked';
    } finally {
      checked.dispose();
    }
  }

  async function apply(current: GuideSession): Promise<void> {
    const reviewed = snapshot;
    if (!reviewed || !applyContext || !current.recommendation) return;
    const selected = current.results.find(({ optionId }) => optionId === current.chosen);
    let routeChanged = false;
    const inputs: ApplyDeps = {
      ...deps.apply, root: deps.root, clock: now,
      preflight: async () => {
        const result = await preflight(current, reviewed, selected);
        routeChanged = result === 'route-changed';
        return result === 'ready';
      },
      connection: selected && deps.apply.connection(selected),
      record: {
        answers: current.answers, proposedLabel: applyContext.label.proposed, use: useFor(current.answers),
        residency: { narrowed: Boolean(applyContext.project.residency) }, viability: current.results,
        policy: { effective: reviewed.hash }, options: current.recommendation.options,
        recommendation: { optionId: current.recommendation.recommendedId, reasonId: current.recommendation.reasonId },
        choice: current.chosen ? [current.chosen] : [], choiceReason: current.choiceReason, hostKind: deps.hostKind
      }
    };
    const report = await runApply(planApply(current.changes, applyContext, inputs), inputs);
    await dispatch(routeChanged ? { type: 'apply-recheck' } : { type: 'apply-done', report, previous: readSetupGuide(deps.root) });
  }

  async function effect(item: GuideEffect, current: GuideSession): Promise<void> {
    switch (item.type) {
      case 'run-viability': return runCheck(item.checkId);
      case 'start-ceiling':
        timer = setTimeout(() => { void dispatch({ type: 'ceiling', checkId: item.checkId }); }, item.ms);
        break;
      case 'compute-recommendation': return recommendation(current, item.checkId);
      case 'compute-changes': return changes(current);
      case 'apply': return apply(current);
      case 'record-abandoned':
        await deps.apply.audit.append('setup.guide.abandoned', buildAbandonedRecord({ answers: current.answers, screen: item.screen, hostKind: deps.hostKind }));
        break;
      case 'land':
        landing = resolveLanding({
          kind: current.answers.kindOfWork, staffSection: current.answers.staffSection, isAdmin: false,
          proposalsOpened: false, hasTeam: false, firstRun: { allowedModel: current.chosen !== undefined }
        });
        postScreen();
        await deps.landing.land(landing);
        break;
      // Persistent pause/resume and invitation routing are the later host cases.
      case 'save-progress': break;
    }
  }

  async function dispatch(event: GuideEvent): Promise<void> {
    if (!session || policy?.state !== 'ready' || lifetime.signal.aborted) return;
    const previous = session;
    const result = nextSession(previous, event, now());
    session = result.session;
    if (session === previous) return;
    if (previous.state === 'checking' && (session.state !== 'checking' || session.recommendationRequested)) stopChecking();
    postScreen();
    if (event.type === 'viability-progress') {
      deps.post({ type: 'progress', text: `Checked ${session.results.filter((row) => row.state !== 'checking' && row.state !== 'unknown').length} of ${session.results.length}` });
    }
    try {
      await Promise.all(result.effects.map((item) => effect(item, result.session)));
    } catch {
      if (session === result.session) failClosed(checkAgainText);
    }
  }

  return {
    async open() {
      if (lifetime.signal.aborted) return;
      if (openInFlight) return openInFlight;
      if (session) { postScreen(); return; }
      openInFlight = (async () => {
        session = startSession({ now: now() });
        try {
          const next = await readPolicy();
          if (lifetime.signal.aborted || !next) return;
          snapshot = next.snapshot;
          policy = next.policy;
          session = startSession({ now: now(), previous: readSetupGuide(deps.root), locked: { canada: policy.locked.canada === true } });
          if (session.state === 'not-started') await dispatch({ type: 'start' });
          else postScreen();
        } catch {
          failClosed(checkAgainText);
        }
      })();
      try { await openInFlight; } finally { openInFlight = undefined; }
    },
    async receive(message) {
      switch (message.type) {
        case 'ready': postScreen(); return;
        case 'close': deps.close?.(); return;
        case 'change-answers': return dispatch({ type: 'restart' });
        case 'fix': case 'scan-confirm': case 'scan-stop': case 'approve-candidate': return;
        default: return dispatch(message);
      }
    },
    dispose() {
      lifetime.abort();
      stopChecking();
    }
  };
}
