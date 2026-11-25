// The three actions of the switch to post-quantum keys (33.2 D-05): the lead's switch, moving every part of the project to a new post-quantum key,
// and giving keys to computers that published theirs late. Node only, never imports vscode. Each reuses what already exists: the roster.require
// writer's checked append, planRekey through membership's rekey planner and writer (reason scheduled, no new reason), and the later-grant path
// (wrapPlan.grantsTo over earlierEpochGrants). Each answers with the project's own refusal when one comes, and writes nothing then.
import { kemKeysAt } from '../../domain/replica/deviceKem';
import { isRosterWriterAt } from '../../domain/replica/roster';
import { epochAt } from '../../domain/replica/rosterCells';
import { WRAP_FEATURE } from '../../domain/replica/wrapFormat';
import { wrapSwitchCards } from '../../domain/staff/wrapSwitchModel';
import type { WrapCard } from '../../domain/staff/wrapSwitchModel';
import { cellsAt, clearedDevices, gateOf, headOf, rekeyPlans, writeRekeys } from './membership';
import type { CellInfo, MembershipResult, RekeyOutcome, SharedProjectHost } from './membership';
import { isProjectRefused } from './replicaProject';
import type { AppendOwnResult } from './replicaProject';
import { formatFor, grantsTo } from './wrapPlan';

// keys-not-published: the lead's own computer has not published its post-quantum keys, so after a switch it could not hold any new key.
export type WrapActionSkip = { ok: false; skipped: 'already-switched' | 'not-a-lead-device' | 'keys-not-published' | 'not-switched' | 'nothing-to-do' };

/** The cards this computer sees now, with the host's clearance check, so a computer dropped for its clearance is never offered keys. */
export async function wrapCardsFor(shared: SharedProjectHost): Promise<WrapCard[]> {
  const { roster } = await shared.project.state();
  const gate = gateOf(shared);
  const head = headOf(roster).position;
  const infos = new Map(cellsAt(roster, shared.project.keys, head, gate.scales).map((info) => [info.cell, info]));
  const cleared = new Map<string, Set<string>>();
  return wrapSwitchCards(roster, shared.project.deviceWriter, (writer, cell) => {
    const info = infos.get(cell);
    if (info === undefined) return false;
    if (!cleared.has(cell)) cleared.set(cell, new Set(clearedDevices(roster, info, head, gate)));
    return (cleared.get(cell) as Set<string>).has(writer);
  });
}

/**
 * The lead's switch: one roster.require { features: [wrap@2] } from a lead or deputy device, signed by the person key (a step-up in a hosted
 * session). The check and the write are one checked append, so two leads acting at once give one switch: the second sees it folded and writes nothing.
 */
export function switchToV2(shared: SharedProjectHost): Promise<AppendOwnResult | WrapActionSkip> {
  const { project } = shared;
  // A person signer's refusal (a step-up not given) comes back as the project's signer-refused answer, with nothing written.
  return project.appendChecked<WrapActionSkip>(({ roster }) => {
    if (roster.required.includes(WRAP_FEATURE)) return { ok: false, skipped: 'already-switched' };
    if (!isRosterWriterAt(roster, project.deviceWriter, roster.positions.length - 1)) return { ok: false, skipped: 'not-a-lead-device' };
    if (kemKeysAt(roster, project.deviceWriter) === undefined) return { ok: false, skipped: 'keys-not-published' };
    return { kind: 'roster.require', data: { features: [WRAP_FEATURE] }, options: {}, check: () => undefined };
  });
}

/**
 * Moves parts of the project to a new post-quantum key after the switch: one cell.rekey reason scheduled per part through planRekey, each new key
 * wrapped only as cell-wrap/v2 (wrapPlan.formatFor). By default the parts whose holders all have post-quantum keys; with waiting too, the others
 * as well, their computers without keys left to Give keys.
 */
export async function moveCellsToV2(shared: SharedProjectHost, options: { cells?: readonly string[]; includeWaiting?: boolean } = {}): Promise<RekeyOutcome | WrapActionSkip | MembershipResult> {
  const cards = await wrapCardsFor(shared);
  const move = cards.find((card) => card.kind === 'move');
  if (move === undefined || move.kind !== 'move') {
    const { roster } = await shared.project.state();
    return { ok: false, skipped: roster.required.includes(WRAP_FEATURE) ? 'nothing-to-do' : 'not-switched' };
  }
  const offered = new Set([...move.ready, ...(options.includeWaiting === true ? move.waiting : [])]);
  const chosen = new Set((options.cells ?? [...offered]).filter((cell) => offered.has(cell)));
  if (chosen.size === 0) return { ok: false, skipped: 'nothing-to-do' };
  const { roster } = await shared.project.state();
  const planned = rekeyPlans(shared, roster, { kind: 'scheduled', writers: [] }, {}, gateOf(shared));
  if ('ok' in planned) return planned;
  return writeRekeys(shared, planned.plans.filter((plan) => chosen.has(plan.cell)), planned.cells);
}

/**
 * Gives the current key of each part to the computers the Give keys card lists (they published post-quantum keys after the part moved), as a
 * later grant of the existing epoch at the roster head, in the epoch's format. Nothing else changes and nobody is removed.
 */
export async function giveKeys(shared: SharedProjectHost): Promise<{ ok: true; given: string[] } | WrapActionSkip | { ok: false; reason: string; message: string }> {
  const card = (await wrapCardsFor(shared)).find((item) => item.kind === 'give-keys');
  if (card === undefined || card.kind !== 'give-keys') return { ok: false, skipped: 'nothing-to-do' };
  const { project } = shared;
  const { roster } = await project.state();
  const head = headOf(roster);
  const infos = new Map(cellsAt(roster, project.keys, head.position, gateOf(shared).scales).map((info) => [info.cell, info]));
  const given = new Set<string>();
  for (const item of card.grants) {
    const info = infos.get(item.cell) as CellInfo;
    const key = project.keys.epochKey(item.cell, item.epoch);
    const founded = roster.cells.cells.get(item.cell)?.epochs.find((epoch) => epoch.epoch === item.epoch)?.from;
    if (key === undefined || founded === undefined || epochAt(roster.cells, item.cell, head.position) !== item.epoch) continue;
    const choice = formatFor(roster, info, founded, shared.routing);
    if (choice === 'switch-first') continue;
    for (const writer of item.writers) {
      const grants = grantsTo(project.signer, roster, head.hash, writer, [{ cell: item.cell, epochs: [{ epoch: item.epoch, key, choice }], ...(info.base ? {} : { raw: info.raw }) }]);
      if (grants.length === 0) continue;
      const stored = await project.putGrants(grants);
      if (isProjectRefused(stored)) return { ok: false, reason: stored.refused, message: stored.message };
      given.add(writer);
    }
  }
  return { ok: true, given: [...given].sort() };
}
