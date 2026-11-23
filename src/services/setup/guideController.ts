import { isDeepStrictEqual } from 'node:util';
import { decideRoute, type RoutePolicy, type RoutingTable, type RoutingTier } from '../../domain/gate/routing';
import type { Label } from '../../domain/gate/labels';
import { MODE_IDS } from '../../domain/org/modes';
import type { GuideAnswers, KindOfWorkAnswer, OpenGetStartedRequest } from '../../domain/setup/answers';
import { cardFor } from '../../domain/setup/cards';
import { changeList } from '../../domain/setup/changes';
import type { HostKind } from '../../domain/setup/device';
import { buildAbandonedRecord } from '../../domain/setup/guideRecord';
import { QUESTION_SCREENS, type GuideInbound, type GuideOutbound } from '../../domain/setup/guideMessages';
import { exerciseFor, resolveLanding, type Landing, type LandingPort } from '../../domain/setup/landing';
import { proposeLabel, raiseOnly, useFor } from '../../domain/setup/map';
import { modeRowOf, suggestMode, type ModeRow } from '../../domain/setup/modes';
import { GENERIC_CONTACT_TEXT, readGuidePolicy, type GuidePolicy, type GuidePolicyInput } from '../../domain/setup/policy';
import { recommend, type OptionInput } from '../../domain/setup/recommend';
import { screenFor, type FoundServerRow, type GuideDiscoveryPort, type ScanOffer } from '../../domain/setup/screens';
import { nextSession, startSession, type GuideEffect, type GuideEvent, type GuideSession } from '../../domain/setup/session';
import { isChoosable, type ViabilityResult } from '../../domain/setup/viability';
import { planApply, runApply, type ApplyContext, type ApplyDeps, type ApplyStep } from './apply';
import { approvedDeviceName, guideSessionPrefill, proposedRoutePolicy, routeFactsOf } from './guideFacts';
import { progressOf, restoreProgress, type GuideProgressStore } from './guideProgress';
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
  readonly progress?: GuideProgressStore;
  readonly discovery?: GuideDiscoveryPort;
  readonly kindStore?: {
    get(): Pick<GuideAnswers, 'kindOfWork' | 'otherKind'> | undefined;
    set(kind: KindOfWorkAnswer, otherKind?: string): PromiseLike<void>;
  };
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
  dispose(): Promise<void>;
}

const scanOff = { offered: false, ranges: [], running: false } as const;
const checkAgainText = 'The rules or connection changed during checking. Close Get Started and open it again to recheck your options.';

interface DiscoveryVisit {
  readonly scope: AbortController;
  readonly listener: { dispose(): void };
  ready: boolean;
  rows: readonly FoundServerRow[];
  offer: ScanOffer;
  confirmation?: object;
  confirmed: boolean;
}

function factsFor(result: ViabilityResult, snapshot: GuideRouteSnapshot, now: number) {
  return result.policyHash === snapshot.hash ? routeFactsOf(result, now) : undefined;
}

function contactFor(policy: GuidePolicy): string {
  return (policy.contacts.find(({ topic }) => topic === 'security') ?? policy.contacts[0])?.name ?? GENERIC_CONTACT_TEXT;
}

function offersKind(policy: ReadyPolicy, kind: KindOfWorkAnswer): boolean {
  return kind === 'something-else' || policy.kindsOfWork.includes(kind);
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
  let progressWrite = Promise.resolve();
  let kindWrite = Promise.resolve();
  let projectName: string | undefined;
  const discovery = deps.discovery;
  let discoveryVisit: DiscoveryVisit | undefined;

  function storeProgress(current?: GuideSession): Promise<void> {
    const store = deps.progress;
    if (!store) return progressWrite;
    const progress = current && progressOf(current);
    if (current && !progress) return progressWrite;
    progressWrite = progressWrite.catch(() => undefined).then(() => store.write(progress));
    return progressWrite;
  }

  function stopChecking(): void {
    checking?.abort();
    checking = undefined;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }

  function discoveryAllowed(): boolean {
    const configured = policy?.state === 'ready' ? policy.discovery : undefined;
    return !lifetime.signal.aborted && session?.state === 'choosing' && session.screen === 'options' &&
      !session.changesRequested && !!configured && configured.networks.length > 0 &&
      (configured.announce || configured.scanRanges.length > 0);
  }

  function stopDiscovery(): void {
    const visit = discoveryVisit;
    if (!visit) return;
    discoveryVisit = undefined;
    visit.listener.dispose();
    visit.scope.abort();
    discovery?.stopScan();
  }

  function updateDiscovery(): void {
    if (!discoveryAllowed()) return stopDiscovery();
    if (!discovery || discoveryVisit) return;
    const scope = new AbortController();
    const listener = discovery.onDidChange(() => {
      if (discoveryVisit?.scope === scope && discoveryVisit.ready) postScreen();
    });
    const visit: DiscoveryVisit = { scope, listener, ready: false, rows: [], offer: scanOff, confirmed: false };
    discoveryVisit = visit;
    void verifyDiscovery(visit).then(async (allowed) => {
      if (!allowed || discoveryVisit !== visit) return;
      await discovery.refresh(scope.signal);
      if (discoveryVisit !== visit) return;
      visit.ready = true;
      postScreen();
    }).catch(() => {
      if (discoveryVisit === visit) stopDiscovery();
    });
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
    const visit = discoveryVisit;
    if (discovery && visit?.ready && discoveryAllowed()) {
      const offer = discovery.scanOffer();
      const configured = policy.state === 'ready' ? policy.discovery?.scanRanges ?? [] : [];
      const canOffer = !visit.confirmed && offer.ranges.length > 0 &&
        offer.ranges.every((range) => configured.some(({ cidr }) => cidr === range));
      visit.offer = offer.offered && !canOffer ? scanOff : { ...offer, ranges: [...offer.ranges] };
      visit.rows = discovery.rows().map((row) => ({ ...row }));
    }
    const screen = screenFor(current, {
      cards, candidates: visit?.rows ?? [], scan: visit?.offer ?? scanOff,
      checkedOn, policy, contacts: policy.contacts, startingRules: false, modeRow, landing, approvedDevice
    });
    deps.post({ type: 'screen', screen: projectName && screen.kind !== 'fix'
      ? { ...screen, heading: `${screen.heading} · ${projectName}` } : screen });
  }

  function failClosed(text: string, contacts: GuidePolicy['contacts'] = policy?.contacts ?? []): void {
    stopChecking();
    stopDiscovery();
    policy = { state: 'failed-closed', sentence: text, contacts };
    postScreen();
  }

  async function readPolicy(isCurrent: () => boolean = () => true): Promise<{ snapshot: GuideRouteSnapshot; policy: ReadyPolicy } | undefined> {
    const current = await deps.readPolicy(now());
    if (!isCurrent()) return undefined;
    const view = readGuidePolicy(current.view);
    if (view.state === 'failed-closed' || !('route' in current)) {
      failClosed(view.state === 'failed-closed' ? view.sentence : checkAgainText, view.contacts);
      return undefined;
    }
    return { snapshot: current, policy: view };
  }

  async function verifyDiscovery(visit: DiscoveryVisit): Promise<boolean> {
    const isCurrent = () => discoveryVisit === visit && discoveryAllowed();
    try {
      const latest = await readPolicy(isCurrent);
      if (!latest || !isCurrent()) return false;
      if (latest.snapshot.hash === snapshot?.hash && isDeepStrictEqual(latest.snapshot.projectLabel, snapshot.projectLabel) &&
          policy?.state === 'ready' && isDeepStrictEqual(latest.policy.discovery, policy.discovery)) return true;
    } catch {
      if (!isCurrent()) return false;
    }
    failClosed(checkAgainText);
    return false;
  }

  async function confirmScan(ranges: readonly string[]): Promise<void> {
    const visit = discoveryVisit;
    if (!discovery || !visit?.ready || visit.confirmed || visit.confirmation) return;
    const reviewed = visit.offer;
    const sameOffer = (offer: ScanOffer) => offer.offered && !offer.running &&
      isDeepStrictEqual(offer.ranges, ranges) && offer.confirmText === reviewed.confirmText;
    if (!sameOffer(reviewed) || !reviewed.confirmText) return;
    const confirmation = {};
    visit.confirmation = confirmation;
    try {
      if (!await verifyDiscovery(visit) || visit.confirmation !== confirmation ||
          !sameOffer(visit.offer) || !sameOffer(discovery.scanOffer())) return;
      visit.confirmed = true;
      await discovery.startScan(ranges);
    } finally {
      if (visit.confirmation === confirmation) visit.confirmation = undefined;
      if (discoveryVisit === visit) postScreen();
    }
  }

  function cancelScan(): void {
    const visit = discoveryVisit;
    if (!visit) return;
    visit.confirmation = undefined;
    if (visit.confirmed) discovery?.stopScan();
  }

  async function approveCandidate(id: string): Promise<void> {
    const visit = discoveryVisit;
    if (!discovery || !visit?.ready) return;
    const reviewed = visit.rows.find((row) => row.id === id && row.state === 'found' && row.action === 'approve');
    if (!reviewed || !await verifyDiscovery(visit) ||
        !discovery.rows().some((row) => isDeepStrictEqual(row, reviewed))) return;
    const result = await discovery.approve(id).catch(() => 'failed');
    if (discoveryVisit !== visit) return;
    if (result === 'failed') deps.post({ type: 'announce', text: 'The server proposal could not be opened.' });
    if (result === 'not-allowed') deps.post({ type: 'announce', text: 'This server can no longer be proposed.' });
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
      project: { ...(mode.changeable ? { mode: mode.mode } : {}), ...(canadaOnly ? { residency: { required: ['CA'] } } : {}),
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
        await Promise.all([
          storeProgress(),
          deps.apply.audit.append('setup.guide.abandoned', buildAbandonedRecord({ answers: current.answers, screen: item.screen, hostKind: deps.hostKind }))
        ]);
        break;
      case 'land':
        landing = resolveLanding({
          kind: current.answers.kindOfWork, staffSection: current.answers.staffSection, isAdmin: false,
          proposalsOpened: false, hasTeam: false, firstRun: { allowedModel: current.chosen !== undefined }
        });
        postScreen();
        await deps.landing.land(landing);
        break;
      case 'save-progress':
        await storeProgress(current);
        if (deps.progress && session === current && !lifetime.signal.aborted) deps.close?.();
        break;
    }
  }

  async function dispatch(event: GuideEvent): Promise<void> {
    if (!session || policy?.state !== 'ready' || lifetime.signal.aborted) return;
    if (event.type === 'answer' && event.key === 'kindOfWork' && !offersKind(policy, event.value)) return;
    const previous = session;
    const result = nextSession(previous, event, now());
    session = result.session;
    if (session === previous) return;
    if (previous.state === 'checking' && (session.state !== 'checking' || session.recommendationRequested)) stopChecking();
    updateDiscovery();
    postScreen();
    if (event.type === 'viability-progress') {
      deps.post({ type: 'progress', text: `Checked ${session.results.filter((row) => row.state !== 'checking' && row.state !== 'unknown').length} of ${session.results.length}` });
    }
    const store = deps.kindStore;
    const { kindOfWork, otherKind } = session.answers;
    if (store && kindOfWork && event.type === 'answer' && (event.key === 'kindOfWork' || event.key === 'otherKind')) {
      kindWrite = kindWrite.then(() => store.set(kindOfWork, otherKind)).catch(() => undefined);
      await kindWrite;
    }
    try {
      await Promise.all(result.effects.map((item) => effect(item, result.session)));
    } catch {
      if (session === result.session) failClosed(checkAgainText);
    }
  }

  return {
    async open(request) {
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
          const prefill = guideSessionPrefill(request);
          projectName = prefill?.projectName;
          const input = {
            now: now(), previous: readSetupGuide(deps.root), locked: { canada: policy.locked.canada === true },
            answers: deps.kindStore?.get(), prefill, question: QUESTION_SCREENS.find((screen) => screen === request?.step)
          };
          const restored = restoreProgress(deps.progress?.read(), input);
          session = restored ?? startSession(input);
          const kind = session.answers.kindOfWork;
          if (kind !== undefined && !offersKind(policy, kind)) {
            session = startSession({ ...input, prefill: {
              ...session.answers, kindOfWork: undefined, otherKind: undefined, staffSection: undefined, agentWork: undefined
            } });
          }
          if (restored) await storeProgress();
          if (lifetime.signal.aborted) return;
          if (session.state === 'paused') await dispatch({ type: 'resume' });
          else if (session.state === 'not-started') await dispatch({ type: 'start' });
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
        case 'close': stopDiscovery(); deps.close?.(); return;
        case 'change-answers': return dispatch({ type: 'restart' });
        case 'scan-confirm': return confirmScan(message.ranges);
        case 'scan-stop': return cancelScan();
        case 'approve-candidate': return approveCandidate(message.candidateId);
        case 'fix': return;
        default: return dispatch(message);
      }
    },
    async dispose() {
      if (!lifetime.signal.aborted) {
        const current = session;
        const paused = current && policy?.state === 'ready' && nextSession(current, { type: 'pause' }, now()).session;
        lifetime.abort();
        stopChecking();
        stopDiscovery();
        if (paused && paused !== current) storeProgress(paused);
      }
      await Promise.all([progressWrite, kindWrite]);
    }
  };
}
