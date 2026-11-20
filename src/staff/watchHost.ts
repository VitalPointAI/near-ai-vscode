// The standing watch runtime of one staff project (research note 11, 4.5; WP-WATCH). Node I/O only, no vscode, so the tests drive it directly; every
// rule it applies lives in src/domain/staff/obs/watches.ts and watchRun.ts.
//
// The watches live in the J2's register, .planning/staff/products/j2/standing-watches.json, one owner's file that members could also write by hand. So:
//   - the host never overwrites bytes it did not read: every change is read whole, made, and written with writeIfUnchanged under the register's lock; a
//     write that lands in between refuses the change, and nothing is written;
//   - unreadable is never empty: a register that cannot be read whole, or holds one watch that does not read, refuses every change and says why;
//   - the file alone arms nothing: arming and retiring are a named person's decisions, signed with this device's key in the decision log, and a watch is
//     read through that log (watchRun.ts trustWatch) before anything acts on it;
//   - in a shared (multi-user) project every change is refused with SHARED_PROJECT_REFUSAL before the file is touched (D-29).
// Who does what: a named person creates, arms, rejects, pauses, resumes, acknowledges and retires (the NEAR AI: Staff watch commands); a member proposes,
// drafts and reports its drafts ready (the observations server's watch tools); the runtime matches, pauses, resumes and expires, and only while a person
// attends the project (watchAttendance.ts): nothing runs in the background without one. No step releases, approves or tasks anything.
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { parseIsoMillis } from '../domain/gate/shape';
import type { CcirTriggeredEvent } from '../domain/staff/events';
import { SHARED_PROJECT_REFUSAL } from '../domain/staff/multiUser';
import type { FeedEvent, WatchAlertEvent, WatchStateEvent } from '../domain/staff/obs/events';
import type { Observation } from '../domain/staff/obs/observation';
import type { SliceContext } from '../domain/staff/obs/slices';
import {
  applyWatchEvent, evaluateWatch, nextWatchId, parseWatchRegisterText, planAlert, renderWatchRegister, trustWatch, watchDraftNotice, watchEcoaRevisionNote,
  watchIntrepDraft, watchSees, watchWording
} from '../domain/staff/obs/watchRun';
import type { WatchDraftKind } from '../domain/staff/obs/watchRun';
import { parseWatch, WATCH_CAPS } from '../domain/staff/obs/watches';
import type { StandingWatch, WatchActor, WatchAlertee, WatchDraftRef, WatchEvent, WatchOutput } from '../domain/staff/obs/watches';
import type { PersonActor } from '../domain/staff/release';
import { parseRegisterBody, registerSchema } from '../domain/staff/registers';
import { splitProductFile } from '../domain/staff/products';
import { sliceContextOf } from '../agent/observationsTools';
import type { ObservationStore } from './observationStore';
import { withRegisterLock } from './registerLock';
import { readWhole, snapshotOfBytes, writeIfUnchanged } from './staffFiles';
import { productPath, staffHostFor } from './staffHost';
import type { StaffCaller, StaffHost, StaffResult } from './staffHost';
import { observationStoreFor } from './observationStore';
import { scenarioOf, staffSettingsOf, STANDING_WATCHES_FILE } from './staffRoomData';
import { attendanceHolders, isAttended, onAttendance } from './watchAttendance';
import type { AttendanceChange } from './watchAttendance';

export { STANDING_WATCHES_FILE };

/** How often an attended project's watches are looked at even with no new observation, so the latest time of value expires them on time. */
export const WATCH_TICK_MS = 60_000;

export const WATCH_CHANGED_TEXT = 'The standing watches file changed while this was being written, so nothing was changed. Look at the watches again and try again.';

/** What a person is told, beside the record in the staff log. Only `alert` is shown on its own; `digest` waits for the next alert. */
export interface WatchNotice { readonly watch: string; readonly person: WatchAlertee; readonly mode: 'alert' | 'digest'; readonly text: string }

export interface WatchHostOptions {
  readonly root: string;
  readonly host: () => StaffHost | undefined;
  readonly store: () => ObservationStore | undefined;
  readonly now?: () => number;
  /** Whether a person attends the project now. Defaults to the attendance registry. */
  readonly attended?: () => boolean;
  readonly notify?: (notice: WatchNotice) => void;
}

const ok = (text: string): StaffResult => ({ ok: true, text });
const refuse = (message: string): StaffResult => ({ ok: false, message });

type Mutation = { readonly entries: StandingWatch[]; readonly events: FeedEvent[]; readonly text: string } | StaffResult;

/** The person's own words for a watch they create: what it matches, what it serves and until when. */
export interface WatchCreateInput {
  readonly title: string;
  readonly pir: string;
  readonly indicator: string;
  readonly condition: unknown;
  readonly ltiov: string;
  readonly alert?: WatchAlertee;
  readonly outputs?: readonly string[];
  readonly label?: string;
}

/** A member's draft of a watch; a named person arms it. */
export interface WatchProposal extends WatchCreateInput { readonly alert: WatchAlertee }

export interface WatchRead {
  readonly ok: true;
  /** The watches as the signed decision log proves them. */
  readonly watches: StandingWatch[];
  /** Why a watch reads other than the file says. */
  readonly problems: string[];
}

const DEFAULT_OUTPUTS: readonly WatchOutput[] = ['draft-intrep', 'mark-source-changed', 'alert-person'];
const OPEN_PRODUCT_STATES: readonly string[] = ['draft', 'guard-checked', 'awaiting-decision', 'rejected'];

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : /(ch|sh|s|x)$/.test(word) ? 'es' : 's'}`;
}

export class WatchHost {
  private readonly now: () => number;
  /** Evaluations run one after another, never two at once. */
  private chain: Promise<unknown> = Promise.resolve();
  private attached: Array<() => void> = [];

  public constructor(private readonly options: WatchHostOptions) {
    this.now = options.now ?? Date.now;
  }

  public get root(): string { return this.options.root; }
  private get file(): string { return path.join(this.options.root, ...STANDING_WATCHES_FILE.split('/')); }
  private attended(): boolean { return this.options.attended ? this.options.attended() : isAttended(this.options.root); }
  private iso(): string { return new Date(this.now()).toISOString(); }

  // ---- Reading -------------------------------------------------------------------------------------------------------------------------------

  /** The watches, each read through the signed decision log. A register that cannot be read whole, or that holds a watch that does not read, says why. */
  public async read(): Promise<WatchRead | { readonly ok: false; readonly message: string }> {
    const whole = await readWhole(this.file);
    if (whole.kind === 'unreadable') return { ok: false, message: `${STANDING_WATCHES_FILE} cannot be read: ${whole.reason}. Nothing was changed.` };
    const parsed = parseWatchRegisterText(whole.kind === 'text' ? whole.text : undefined);
    if (!parsed.ok) return { ok: false, message: `${parsed.message} Fix ${STANDING_WATCHES_FILE} first; nothing was changed.` };
    const trusted = await this.trusted(parsed.entries);
    return { ok: true, watches: trusted.watches, problems: trusted.problems };
  }

  private async trusted(entries: readonly StandingWatch[]): Promise<{ watches: StandingWatch[]; problems: string[] }> {
    const decisions = await this.options.host()?.watchDecisions() ?? new Map();
    const problems: string[] = [];
    const watches = entries.map((entry) => {
      const trusted = trustWatch(entry, decisions.get(entry.id));
      if (trusted.problem) problems.push(trusted.problem);
      return trusted.watch;
    });
    return { watches, problems };
  }

  /**
   * One change to the register: read whole under the lock, every watch read through the decision log, `mutate` builds the new watches, and the file is
   * written only over the exact bytes read. The events are recorded after the write.
   */
  private async change(mutate: (watches: StandingWatch[]) => Promise<Mutation> | Mutation): Promise<StaffResult & { readonly events?: FeedEvent[] }> {
    // In a shared (multi-user) project the staff host refuses the events of every step (D-29, 31-21), so the register is not written either: a step
    // is refused whole, before the file is touched, instead of leaving a changed register whose events were never recorded.
    if (await this.options.host()?.isSharedProject()) return refuse(SHARED_PROJECT_REFUSAL);
    const outcome = await withRegisterLock(this.file, async () => {
      const whole = await readWhole(this.file);
      if (whole.kind === 'unreadable') return refuse(`${STANDING_WATCHES_FILE} cannot be read: ${whole.reason}. Nothing was changed.`);
      const parsed = parseWatchRegisterText(whole.kind === 'text' ? whole.text : undefined);
      if (!parsed.ok) return refuse(`${parsed.message} Fix ${STANDING_WATCHES_FILE} first; nothing was changed.`);
      const { watches } = await this.trusted(parsed.entries);
      const result = await mutate(watches);
      if ('ok' in result) return result;
      if (!(await writeIfUnchanged(this.file, snapshotOfBytes(whole.kind === 'text' ? whole.bytes : undefined), renderWatchRegister(result.entries)))) return refuse(WATCH_CHANGED_TEXT);
      return { ok: true as const, text: result.text, events: result.events };
    });
    if (outcome.ok && 'events' in outcome && outcome.events?.length) await this.options.host()?.recordFeed(outcome.events);
    return outcome;
  }

  /** One state machine step on one watch, as part of a change. */
  private step(watches: StandingWatch[], id: string, event: WatchEvent, actor: WatchActor, extra: { reason?: string; edit?: (watch: StandingWatch) => StandingWatch; text: (watch: StandingWatch) => string; run?: string | null }): Mutation {
    const index = watches.findIndex((watch) => watch.id === id);
    if (index < 0) return refuse(`There is no standing watch ${id}.`);
    const result = applyWatchEvent(watches[index], event, actor, { at: this.now(), attendedRun: this.attended(), run: extra.run ?? this.runNow(), ...(extra.reason ? { reason: extra.reason } : {}) });
    if (!result.ok) return refuse(result.message);
    const next = extra.edit ? extra.edit(result.watch) : result.watch;
    const entries = watches.map((watch, at) => (at === index ? next : watch));
    return { entries, events: result.events, text: extra.text(next) };
  }

  /** The staff run open now, for the events' `run`, or null when only the Staff Room is open. */
  private runNow(): string | null {
    const run = attendanceHolders(this.options.root).find((holder) => holder.kind === 'run');
    return run ? run.id : null;
  }

  // ---- A person's steps ------------------------------------------------------------------------------------------------------------------------

  private async personProblem(person: PersonActor): Promise<StaffResult | undefined> {
    const host = this.options.host();
    if (!host) return refuse('Open the project folder of a staff team first.');
    return (await host.isThisDevicePerson(person)) ? undefined : refuse('A watch is armed, paused, resumed, acknowledged or retired only by a named person: a name, a role and this device\'s key.');
  }

  private buildWatch(id: string, input: WatchCreateInput, alert: WatchAlertee, by: string): { ok: true; watch: StandingWatch } | { ok: false; message: string } {
    const parsed = parseWatch({
      id, title: input.title, pir: input.pir, indicator: input.indicator, condition: input.condition ?? {}, ltiov: input.ltiov, alert: { name: alert.name, role: alert.role },
      outputs: input.outputs ?? DEFAULT_OUTPUTS, runMode: 'attended', state: 'proposed', missedWhilePaused: 0, label: input.label ?? 'org/Internal', proposedBy: by
    });
    return parsed.ok ? { ok: true, watch: parsed.value } : { ok: false, message: parsed.message };
  }

  /** A person arms the watch: the file first, then the signed decision. Without the signed entry it reads as proposed, which arms nothing. */
  private async signArm(person: PersonActor, watch: StandingWatch, text: string): Promise<StaffResult> {
    const signed = await this.options.host()!.signWatchDecision(person, { watch: watch.id, decision: 'approved', wording: watchWording(watch), reasons: [] });
    if (!signed.ok) return refuse(`${signed.message} ${watch.id} reads as proposed until a person arms it.`);
    if (this.attended()) await this.evaluate();
    return ok(text);
  }

  /** A person creates a watch and arms it in one step. Without an attended run it is armed straight into paused. */
  public async create(person: PersonActor, input: WatchCreateInput): Promise<StaffResult> {
    const problem = await this.personProblem(person);
    if (problem) return problem;
    let armed: StandingWatch | undefined;
    const result = await this.change((watches) => {
      const built = this.buildWatch(nextWatchId(watches), input, input.alert ?? { name: person.name, role: person.role }, `person:${person.name} (${person.role})`);
      if (!built.ok) return refuse(built.message);
      const all = [...watches, built.watch];
      const created: WatchStateEvent = { type: 'staff.watch.state', run: this.runNow(), at: this.iso(), watch: built.watch.id, from: null, to: 'proposed', actor: `person:${person.name} (${person.role})` };
      const step = this.step(all, built.watch.id, 'arm', person, { edit: (watch) => { armed = { ...watch, cursor: this.iso() }; return armed; }, text: (watch) => this.armedText(watch) });
      return 'ok' in step ? step : { ...step, events: [created, ...step.events] };
    });
    if (!result.ok || !armed) return result;
    return this.signArm(person, armed, result.text);
  }

  private armedText(watch: StandingWatch): string {
    return watch.state === 'paused'
      ? `${watch.id} is armed and paused: no staff run or Staff Room is open, so it waits and looks at what came in when a person is back.`
      : `${watch.id} is armed. It looks at every new observation while a person attends this project, and alerts ${watch.alert.name} (${watch.alert.role}).`;
  }

  /** A person arms a proposed watch, after seeing exactly what it matches. */
  public async arm(person: PersonActor, id: string): Promise<StaffResult> {
    const problem = await this.personProblem(person);
    if (problem) return problem;
    let armed: StandingWatch | undefined;
    const result = await this.change((watches) => this.step(watches, id, 'arm', person, { edit: (watch) => { armed = { ...watch, cursor: this.iso() }; return armed; }, text: (watch) => this.armedText(watch) }));
    if (!result.ok || !armed) return result;
    return this.signArm(person, armed, result.text);
  }

  /** A person rejects a proposed watch or retires a live one, with the reason. Signed: a retired watch never runs again, whatever the file says. */
  public async retire(person: PersonActor, id: string, reasons: readonly string[]): Promise<StaffResult> {
    const problem = await this.personProblem(person);
    if (problem) return problem;
    const why = reasons.map((reason) => reason.trim()).filter(Boolean);
    if (!why.length) return refuse('Say why the watch is rejected or retired.');
    let retired: StandingWatch | undefined;
    const result = await this.change((watches) => {
      const current = watches.find((watch) => watch.id === id);
      const event: WatchEvent = current?.state === 'proposed' ? 'reject' : 'disarm';
      return this.step(watches, id, event, person, { reason: why.join('; '), edit: (watch) => { const { drafting: _d, ...rest } = watch; void _d; retired = rest; return rest; }, text: (watch) => `${watch.id} is ${watch.state} by ${person.name} (${person.role}).` });
    });
    if (!result.ok || !retired) return result;
    const signed = await this.options.host()!.signWatchDecision(person, { watch: id, decision: 'rejected', wording: watchWording(retired), reasons: why });
    return signed.ok ? ok(result.text) : refuse(`${result.text} The signed record failed (${signed.message}); the file says ${retired.state}.`);
  }

  /** A person pauses an armed watch. It keeps counting what it matches, and only a person resumes it. */
  public async pause(person: PersonActor, id: string): Promise<StaffResult> {
    const problem = await this.personProblem(person);
    if (problem) return problem;
    return this.change((watches) => this.step(watches, id, 'pause', person, { reason: `Paused by ${person.name} (${person.role}).`, text: (watch) => `${watch.id} is paused. Matches are counted and queued for you, never dropped; resume it to have them delivered.` }));
  }

  /** A person resumes a paused watch; what it queued is delivered as one match at once. */
  public async resume(person: PersonActor, id: string): Promise<StaffResult> {
    const problem = await this.personProblem(person);
    if (problem) return problem;
    const result = await this.change((watches) => this.step(watches, id, 'resume', person, { reason: `Resumed by ${person.name} (${person.role}).`, text: (watch) => `${watch.id} is armed again.${watch.missedWhilePaused ? ` Missed while paused: ${plural(watch.missedWhilePaused, 'match')}, delivered now.` : ''}` }));
    if (result.ok) await this.evaluate();
    return result;
  }

  /** The named person acknowledges a watch's drafts: it is armed again, and anything queued meanwhile is delivered. The drafts follow their own release path. */
  public async acknowledge(person: PersonActor, id: string): Promise<StaffResult> {
    const problem = await this.personProblem(person);
    if (problem) return problem;
    const result = await this.change((watches) => this.step(watches, id, 'acknowledge', person, {
      reason: `Acknowledged by ${person.name} (${person.role}).`,
      edit: (watch) => { const { match: _m, drafting: _d, drafts: _r, ...rest } = watch; void _m; void _d; void _r; return rest; },
      text: (watch) => `${watch.id} is armed again. Its drafts stay in the release state machine for a person to decide.`
    }));
    if (result.ok && this.attended()) await this.evaluate();
    return result;
  }

  // ---- A member's steps ------------------------------------------------------------------------------------------------------------------------

  private memberProblem(caller: StaffCaller): StaffResult | undefined {
    if (caller.member === undefined || !caller.team.members.includes(caller.member)) return refuse('Only a member of this staff team can do that. The run\'s lead coordinates.');
    if (caller.team.section !== 'j2') return refuse('Standing watches are the J2\'s (research note 11, 4.5).');
    return undefined;
  }

  /** A member drafts a watch: it starts `proposed`, and only a named person arms it. */
  public async propose(caller: StaffCaller, input: WatchProposal): Promise<StaffResult> {
    const problem = this.memberProblem(caller);
    if (problem) return problem;
    return this.change((watches) => {
      if (watches.length >= 200) return refuse('The register holds 200 watches; a person retires some first.');
      const built = this.buildWatch(nextWatchId(watches), input, input.alert, `member:${caller.member}`);
      if (!built.ok) return refuse(built.message);
      const event: WatchStateEvent = { type: 'staff.watch.state', run: caller.run, at: this.iso(), watch: built.watch.id, from: null, to: 'proposed', actor: `member:${caller.member}` };
      return {
        entries: [...watches, built.watch], events: [event],
        text: `${built.watch.id} is proposed. ${built.watch.alert.name} (${built.watch.alert.role}) or another named person arms it with NEAR AI: Staff: Arm a Standing Watch; until then it watches nothing.`
      };
    });
  }

  /** The rows of a watch's match a reader may see. */
  private async matchRows(watch: StandingWatch, visible: (label: string) => boolean): Promise<Observation[]> {
    const store = this.options.store();
    if (!store || !watch.match) return [];
    const loaded = await store.load();
    if (!loaded.ok) return [];
    const ids = new Set(watch.match.observations);
    return loaded.value.rows.filter((row) => ids.has(row.obsId) && visible(row.label) && watchSees(watch.label, row.label));
  }

  /**
   * A member starts drafting for a match (matched to drafting), or adds a second draft while drafting. `intrep`: the host writes the INTREP draft as a
   * new J2 product and proposes it as this member, so it enters the release state machine as a draft. `ecoa-revision`: the host returns the revision
   * note for the owner of the adversary COA product to add to a new version and propose; the member then names it in watch_drafted.
   */
  public async draft(caller: StaffCaller, input: { readonly watch: string; readonly kind: WatchDraftKind }, visible: (label: string) => boolean): Promise<StaffResult> {
    const problem = this.memberProblem(caller);
    if (problem) return problem;
    if (!this.attended()) return refuse('A watch is worked on only while a person attends the project (a staff run or the Staff Room is open).');
    const member = caller.member!;
    const read = await this.read();
    if (!read.ok) return refuse(read.message);
    const watch = read.watches.find((entry) => entry.id === input.watch);
    if (!watch) return refuse(`There is no standing watch ${input.watch}.`);
    const allowed: readonly WatchOutput[] = input.kind === 'intrep' ? ['draft-intrep'] : ['draft-ecoa-revision', 'draft-threat-revision'];
    if (!watch.outputs.some((output) => allowed.includes(output))) return refuse(`${watch.id} does not draft ${input.kind === 'intrep' ? 'an INTREP' : 'an adversary COA revision'}; its outputs are ${watch.outputs.join(', ')}.`);
    if (watch.state === 'drafting' && watch.drafting && (watch.drafting.member !== member || watch.drafting.run !== caller.run)) return refuse(`${watch.id} is being drafted by ${watch.drafting.member} in another run.`);
    if (watch.state !== 'matched' && watch.state !== 'drafting') return refuse(`${watch.id} is ${watch.state}; a member drafts only for a match.`);
    if (watch.state === 'matched') {
      const started = await this.change((watches) => this.step(watches, watch.id, 'draft', { kind: 'agent', member }, { run: caller.run, edit: (entry) => ({ ...entry, drafting: { run: caller.run, member } }), text: () => '' }));
      if (!started.ok) return started;
    }
    const rows = await this.matchRows(watch, visible);
    const at = this.now();
    if (input.kind === 'ecoa-revision') {
      return ok([
        `Add this section to a new version of the adversary COA product you own (adversary-coa-set or threat-assessment), keep its draft line, revise with ICD 203 terms, propose it with mcp__staff-products__propose, then call watch_drafted with the product's name. The tradecraft reviewer and the release-guard check it like any product; a person decides.`,
        '',
        watchEcoaRevisionNote({ watch, rows, at })
      ].join('\n'));
    }
    const settings = await staffSettingsOf(caller.root);
    const draft = watchIntrepDraft({ watch, rows, at, owner: member, settings: { profile: settings.profile, level: settings.level } });
    const file = path.join(caller.root, ...productPath('j2', draft.product).split('/'));
    // A new file only: an existing product of that name is never written over.
    if (!(await writeIfUnchanged(file, { exists: false }, draft.text))) return refuse(`${productPath('j2', draft.product)} is already there; call watch_draft again in a second.`);
    const host = this.options.host();
    const proposed = host ? await host.propose(caller, { product: draft.product, kind: 'report', label: watch.label }) : refuse('The staff host is not ready.');
    if (!proposed.ok) {
      await writeIfUnchanged(file, snapshotOfBytes(Buffer.from(draft.text, 'utf8')), undefined);
      return refuse(`The INTREP draft was not recorded: ${proposed.message}`);
    }
    const version = (await host!.productState(draft.product))?.version ?? 1;
    const recorded = await this.change((watches) => {
      const index = watches.findIndex((entry) => entry.id === watch.id);
      if (index < 0 || watches[index].state !== 'drafting') return refuse(`${watch.id} is no longer drafting.`);
      const drafts: WatchDraftRef[] = [...(watches[index].drafts ?? []).filter((ref) => ref.product !== draft.product), { product: draft.product, version }].slice(-WATCH_CAPS.drafts);
      return { entries: watches.map((entry, at2) => (at2 === index ? { ...entry, drafts } : entry)), events: [], text: '' };
    });
    if (!recorded.ok) return recorded;
    return ok(`${productPath('j2', draft.product)} is written as a draft for ${watch.alert.name} (${watch.alert.role}) and recorded as version ${version} (${proposed.text}) Fill in the event line and your deduction, propose it again, then call watch_drafted. Nothing is released by a watch.`);
  }

  /**
   * A member reports the drafts ready (drafting to awaiting-review). Each draft must be in the product ledger, open (not approved, released, superseded or
   * withdrawn), recorded since the match, and carry the draft line for the named person; then the person is alerted.
   */
  public async drafted(caller: StaffCaller, input: { readonly watch: string; readonly products?: readonly string[] }): Promise<StaffResult> {
    const problem = this.memberProblem(caller);
    if (problem) return problem;
    if (!this.attended()) return refuse('A watch is worked on only while a person attends the project (a staff run or the Staff Room is open).');
    const host = this.options.host();
    if (!host) return refuse('The staff host is not ready.');
    const read = await this.read();
    if (!read.ok) return refuse(read.message);
    const watch = read.watches.find((entry) => entry.id === input.watch);
    if (!watch) return refuse(`There is no standing watch ${input.watch}.`);
    if (watch.state !== 'drafting') return refuse(`${watch.id} is ${watch.state}; only a watch being drafted can have its drafts reported.`);
    if (watch.drafting && (watch.drafting.member !== caller.member || watch.drafting.run !== caller.run)) return refuse(`${watch.id} is being drafted by ${watch.drafting.member} in another run.`);
    const names = [...new Set([...(watch.drafts ?? []).map((ref) => ref.product), ...(input.products ?? [])])].slice(0, WATCH_CAPS.drafts);
    if (!names.length) return refuse(`${watch.id} has no draft yet: call watch_draft first.`);
    const refs: WatchDraftRef[] = [];
    const notice = watchDraftNotice(watch.alert);
    const since = parseIsoMillis(watch.match?.at ?? '1970-01-01T00:00:00.000Z');
    for (const product of names) {
      const state = await host.productState(product);
      if (!state) return refuse(`${product} is not in the product ledger; propose it first.`);
      if (state.tampered) return refuse(`${product} cannot be used: ${state.tampered}`);
      if (!OPEN_PRODUCT_STATES.includes(state.state)) return refuse(`${product} is ${state.state}. A watch's draft is a new, open version for a person to decide; it is never one already approved or released.`);
      if (!(parseIsoMillis(state.lastAt) >= since)) return refuse(`${product} version ${state.version} was recorded before ${watch.id} matched; propose the revision first.`);
      let body = '';
      try { body = await readFile(path.join(caller.root, ...productPath(state.section, product).split('/')), 'utf8'); } catch { /* checked below */ }
      if (!body.includes(notice)) return refuse(`${product} does not say plainly that it is a draft for ${watch.alert.name} (${watch.alert.role}). Keep this line in it: "${notice}"`);
      refs.push({ product, version: state.version });
    }
    const history = await host.feedEvents();
    let alert: ReturnType<typeof planAlert> | undefined;
    const result = await this.change((watches) => {
      const step = this.step(watches, watch.id, 'drafts-ready', { kind: 'agent', member: caller.member! }, {
        run: caller.run,
        edit: (entry) => { const { drafting: _d, ...rest } = entry; void _d; return { ...rest, drafts: refs }; },
        text: (entry) => `${entry.id} is awaiting review by ${entry.alert.name} (${entry.alert.role}): ${refs.map((ref) => `${ref.product} v${ref.version}`).join(', ')}. The drafts follow their own release path; nothing is released by a watch.`
      });
      if ('ok' in step) return step;
      alert = planAlert(history, watch, watch.match?.observations.length ?? 0, this.now(), caller.run);
      return { ...step, events: [...step.events, alert.event] };
    });
    if (result.ok && alert) this.tell(watch, alert, `${watch.id} drafts await your review: ${refs.map((ref) => `${ref.product} v${ref.version}`).join(', ')}.`);
    return result;
  }

  // ---- The runtime -----------------------------------------------------------------------------------------------------------------------------

  private tell(watch: StandingWatch, alert: ReturnType<typeof planAlert>, what: string): void {
    if (alert.event.mode !== 'alert') return;
    const digest = alert.digest.entries ? ` Also in your digest: ${plural(alert.digest.matches, 'match')} on ${alert.digest.watches.join(', ')}.` : '';
    try { this.options.notify?.({ watch: watch.id, person: watch.alert, mode: 'alert', text: `For ${watch.alert.name} (${watch.alert.role}): ${what}${digest}` }); } catch { /* a notice never stops the record */ }
  }

  /** The CCIR the watch's PIR is, if the CCIR register holds it active: its match then also raises `staff.ccir.triggered`. */
  private async ccirOf(pir: string): Promise<string | undefined> {
    const schema = registerSchema('ccir-register');
    if (!schema) return undefined;
    for (const section of ['j3', 'j2'] as const) {
      const read = await readWhole(path.join(this.options.root, ...productPath(section, 'ccir-register').split('/')));
      if (read.kind !== 'text') continue;
      const parts = splitProductFile(read.text);
      const rows = parseRegisterBody(schema, parts ? parts.body : read.text) ?? [];
      const row = rows.find((entry) => entry.id === pir && entry.type === 'pir' && entry.status === 'active');
      if (row) return String(row.id);
    }
    return undefined;
  }

  /** Looks at every watch once, if a person attends the project. Runs one at a time. */
  public evaluate(): Promise<StaffResult> {
    const next = this.chain.then(() => this.evaluateNow(), () => this.evaluateNow());
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async evaluateNow(): Promise<StaffResult> {
    if (!this.attended()) return ok('No person attends this project, so no watch was looked at.');
    const store = this.options.store();
    const loaded = store ? await store.load() : undefined;
    const rows = loaded?.ok ? loaded.value.rows : [];
    const degraded = new Set(loaded?.ok ? Object.entries(loaded.value.registry.feeds).filter(([, feed]) => feed.state === 'degraded').map(([id]) => id) : []);
    const scenario = await scenarioOf(this.options.root);
    const context: Omit<SliceContext, 'visible'> = (({ visible: _v, ...rest }) => { void _v; return rest; })(sliceContextOf(scenario.scenario, () => true));
    const now = this.now();
    const run = this.runNow();
    const raised: Array<{ watch: StandingWatch; count: number; missed: number }> = [];
    const history = await this.options.host()?.feedEvents() ?? [];
    const alerts: Array<{ watch: StandingWatch; alert: ReturnType<typeof planAlert>; what: string }> = [];
    const result = await this.change((watches) => {
      const events: FeedEvent[] = [];
      let changed = false;
      const entries = watches.map((watch) => {
        const evaluation = evaluateWatch({ watch, rows, context, now, run, attended: true, degradedFeeds: degraded });
        events.push(...evaluation.events);
        if (evaluation.changed) changed = true;
        if (evaluation.raised) raised.push({ watch: evaluation.watch, count: evaluation.raised.observations.length, missed: evaluation.raised.missed });
        return evaluation.watch;
      });
      if (!changed) return ok('');
      // The alerts, in order, each against the history including the ones just planned, so one evaluation never floods a person either.
      const planned: FeedEvent[] = [...history];
      for (const match of raised) {
        const alert = planAlert(planned, match.watch, match.count, now, run);
        planned.push(alert.event);
        events.push(alert.event);
        alerts.push({ watch: match.watch, alert, what: `${match.watch.id} matched ${plural(match.count, 'observation')}${match.missed ? ` (missed while paused: ${plural(match.missed, 'match')})` : ''}. A member run drafts the INTREP; you review it.` });
      }
      return { entries, events, text: raised.length ? `${plural(raised.length, 'watch')} matched.` : 'Watches updated.' };
    });
    if (result.ok) {
      for (const entry of alerts) this.tell(entry.watch, entry.alert, entry.what);
      const host = this.options.host();
      for (const match of raised) {
        const ccir = await this.ccirOf(match.watch.pir);
        if (ccir && host) await host.emit([{ type: 'staff.ccir.triggered', run: run ?? 'staff-room', at: new Date(now).toISOString(), ccir, report: `${match.watch.id} matched ${plural(match.count, 'observation')} on indicator ${match.watch.indicator}.`.slice(0, 500), member: 'standing-watch', time: new Date(now).toISOString() } satisfies CcirTriggeredEvent]);
      }
    }
    return result;
  }

  /**
   * Attendance changed. A person's run that ended hands back the match it was drafting (drafting to matched), so the next member run picks it up; when
   * nobody attends any more, armed watches pause (no attended run) and wait. A person arriving makes the watches look at what came in meanwhile.
   */
  public async attendanceChanged(change: Pick<AttendanceChange, 'attended' | 'holder' | 'change'>): Promise<StaffResult> {
    if (change.change === 'start') return this.evaluate();
    const ended = change.holder;
    const result = await this.change((watches) => {
      const events: FeedEvent[] = [];
      let changed = false;
      const entries = watches.map((watch) => {
        let current = watch;
        const apply = (event: WatchEvent, reason: string, attendedRun: boolean): void => {
          const step = applyWatchEvent(current, event, { kind: 'system' }, { at: this.now(), attendedRun, run: ended.kind === 'run' ? ended.id : null, reason, ...(event === 'pause' ? { pauseReason: 'no-attended-run' as const } : {}) });
          if (!step.ok) return;
          current = step.watch;
          events.push(...step.events);
          changed = true;
        };
        if (ended.kind === 'run' && current.state === 'drafting' && current.drafting?.run === ended.id) {
          apply('abandon', `The run drafting it ended without reporting drafts; the match waits for the next member run.${current.drafts?.length ? ` Drafts so far: ${current.drafts.map((ref) => ref.product).join(', ')}.` : ''}`, change.attended);
          const { drafting: _d, ...rest } = current; void _d; current = rest;
        }
        if (!change.attended && current.state === 'armed') apply('pause', 'No staff run or Staff Room is open; it waits for a person.', false);
        return current;
      });
      return changed ? { entries, events, text: 'Watches updated.' } : ok('');
    });
    return result;
  }

  /** Follows the project's attendance and observations: evaluates on new observations and source changes, and every WATCH_TICK_MS while attended. */
  public attach(): () => void {
    if (this.attached.length) return () => this.detach();
    let timer: ReturnType<typeof setInterval> | undefined;
    let unfollow: (() => void) | undefined;
    const follow = (): void => {
      if (!timer) { timer = setInterval(() => { void this.evaluate().catch(() => undefined); }, WATCH_TICK_MS); timer.unref?.(); }
      if (!unfollow) unfollow = this.options.host()?.onFeedEvent((event) => { if (event.type === 'feed.observations.appended' || event.type === 'feed.source.state') void this.evaluate().catch(() => undefined); });
    };
    const unfollowAll = (): void => {
      if (timer) clearInterval(timer);
      timer = undefined;
      unfollow?.();
      unfollow = undefined;
    };
    const stop = onAttendance((change) => {
      if (path.resolve(change.root) !== path.resolve(this.options.root)) return;
      if (change.attended) follow(); else unfollowAll();
      void this.attendanceChanged(change).catch(() => undefined);
    });
    if (this.attended()) { follow(); void this.evaluate().catch(() => undefined); }
    this.attached = [stop, unfollowAll];
    return () => this.detach();
  }

  public detach(): void {
    for (const stop of this.attached) stop();
    this.attached = [];
  }
}

// ---- One host per project --------------------------------------------------------------------------------------------------------------------

let configured: Pick<WatchHostOptions, 'notify'> | undefined;
const hosts = new Map<string, WatchHost>();

/** Sets up the watch hosts (the notice a person sees), or tears them down. */
export function configureWatchHosts(options: Pick<WatchHostOptions, 'notify'> | undefined): void {
  configured = options;
  for (const host of hosts.values()) host.detach();
  hosts.clear();
}

/** The watch host of a project, following its attendance, or undefined before the extension set the hosts up. */
export function watchHostFor(root: string): WatchHost | undefined {
  if (!configured) return undefined;
  const key = path.resolve(root);
  let host = hosts.get(key);
  if (!host) {
    host = new WatchHost({ root: key, host: () => staffHostFor(key), store: () => observationStoreFor(key), ...(configured.notify ? { notify: configured.notify } : {}) });
    host.attach();
    hosts.set(key, host);
  }
  return host;
}
