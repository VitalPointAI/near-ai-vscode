// The feed file import, end to end, without vscode (WP-IMP): the command in services/staffImportCommand.ts asks the person, and this file does the
// work. prepareImport parses the file in the separate parser process (runner.ts) and plans the rows in the frame of the project's scenario; nothing is
// written. commitImport, run only after the person confirms, takes the import feed through its lifecycle (the person approves a new feed) and appends
// the rows through the store's one append path, which checks every row's label and stamp again.
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { clampImportLabel, frameArea, importFeed, importFeedSteps, planImport } from '../../domain/staff/obs/importers';
import type { ImportFormat, ImportPlan } from '../../domain/staff/obs/importers';
import { OBS_APPEND_MAX_ROWS } from '../../domain/staff/obs/store';
import { parseScenarioText, SCENARIO_DIR, SCENARIO_MAX_FILE } from '../../domain/staff/scenario';
import type { ExerciseFrame } from '../../domain/staff/obs/frame';
import type { PersonActor } from '../../domain/staff/release';
import type { ObservationStore } from '../observationStore';
import { parseFeedFile } from './runner';
import type { ParserLimits } from './runner';

/** The exercise frame of the scenario loaded in the project, if it has one. Without it, nothing with a position can be imported. */
export async function projectFrame(root: string): Promise<ExerciseFrame | undefined> {
  try {
    const file = path.join(root, SCENARIO_DIR, 'scenario.json');
    const text = await readFile(file, 'utf8');
    if (text.length > SCENARIO_MAX_FILE) return undefined;
    const parsed = parseScenarioText(text);
    return parsed.ok ? parsed.value.region.frame : undefined;
  } catch {
    return undefined;
  }
}

export type Prepared = { readonly ok: true; readonly plan: ImportPlan; /** The label was raised to the feed's own. */ readonly labelRaised: boolean } | { readonly ok: false; readonly message: string };

/** Parses and plans an import. Writes nothing. */
export async function prepareImport(input: { readonly root: string; readonly file: string; readonly label: string; readonly now: number; readonly format?: ImportFormat; readonly limits?: Partial<ParserLimits> }): Promise<Prepared> {
  const parsed = await parseFeedFile(input.file, { ...(input.format ? { format: input.format } : {}), ...(input.limits ? { limits: input.limits } : {}) });
  if (!parsed.ok) return parsed;
  const label = clampImportLabel(input.label, importFeed(parsed.format));
  if (!label.ok) return label;
  const frame = await projectFrame(input.root);
  const place = frame ? frameArea(frame) : undefined;
  const plan = planImport(parsed, { fileName: path.basename(input.file), importedAt: input.now, label: label.label, ...(place ? { area: place.area, centre: place.centre } : {}) });
  return { ok: true, plan, labelRaised: label.raised };
}

export interface CommitResult { readonly ok: boolean; readonly appended: number; readonly duplicates: number; readonly refused: number; readonly message: string }

/**
 * Writes a planned import, after the person confirmed it. A new import feed is registered and approved by that person, backfilled, and caught up; an
 * existing one is resynced if it was paused or degraded. Re-importing the same file adds nothing: every row it would write is already held.
 */
export async function commitImport(store: ObservationStore, plan: ImportPlan, person: PersonActor): Promise<CommitResult> {
  const fail = (message: string): CommitResult => ({ ok: false, appended: 0, duplicates: 0, refused: 0, message });
  const loaded = await store.load();
  if (!loaded.ok) return fail(loaded.message);
  const feed = plan.feed.id;
  const steps = importFeedSteps(loaded.value.registry.feeds[feed]?.state);
  if (!steps.ok) return fail(steps.message);
  if (steps.register) {
    const registered = await store.registerFeed(plan.feed);
    if (!registered.ok) return fail(registered.message);
  }
  for (const event of steps.before) {
    const moved = await store.transitionFeed(feed, event, event === 'approve' ? person : { kind: 'system' }, { hasHistory: true });
    if (!moved.ok) return fail(moved.message);
  }
  let appended = 0;
  let duplicates = 0;
  let refused = 0;
  let problem: string | undefined;
  for (let index = 0; index < plan.rows.length; index += OBS_APPEND_MAX_ROWS) {
    const result = await store.append({ rows: plan.rows.slice(index, index + OBS_APPEND_MAX_ROWS) });
    appended += result.appended;
    duplicates += result.duplicates;
    refused += result.refused.length;
    problem ??= result.message ?? result.refused[0]?.message;
    if (result.message) break;
  }
  // The feed is caught up whatever was refused: the refusals are reported, and the file can be imported again once their cause is fixed.
  const state = (await store.load());
  if (state.ok && state.value.registry.feeds[feed]?.state === 'backfilling') {
    for (const event of steps.after) await store.transitionFeed(feed, event, { kind: 'system' });
  }
  const words = `${appended} observation${appended === 1 ? '' : 's'} imported from ${plan.fileName}${duplicates ? `, ${duplicates} already held` : ''}${refused ? `, ${refused} refused` : ''}.`;
  return { ok: refused === 0 && problem === undefined, appended, duplicates, refused, message: problem ? `${words} ${problem}` : words };
}
