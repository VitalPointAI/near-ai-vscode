import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { applyGuidanceUpdate, applyTeamUpdate, planGuidanceUpdate, planTeamUpdate, type GuidancePlan, type TeamUpdatePlan, type UpdateDecisions } from '../agent/teamUpdate';
import { parseTeam, TeamLibrary } from '../agent/teams';
import { guidanceFingerprint } from '../agent/teamFingerprints';
import { readProjectGuidance, templateVersion } from '../agent/projectTypes';
import { runInProgress } from '../agent/runActivity';

// Update Team without VS Code: preview, apply with a backup first, and undo; and the record of
// which teams have been offered an update or asked not to be. The commands in
// workspaceCommands.ts put these behind a preview and a confirmation.

/** `text` and `agents` are the contents the plan was made from, so apply can tell whether either changed since. */
/** `guidanceSkipped` says why AGENTS.md is left alone even though it has project-type guidance. */
export interface TeamUpdatePreview { file: string; name: string; plan: TeamUpdatePlan; guidance?: GuidancePlan; agentsFile?: string; text: string; agents?: string; guidanceSkipped?: string }
/** The files an update wrote and their backups. `configFile` is project.json, whose templateVersion and guidanceBase change with the guidance. */
export interface AppliedUpdate { file: string; backup: string; agentsFile?: string; agentsBackup?: string; configFile?: string; configBackup?: string }

const projectRoot = (file: string) => (path.basename(file) === 'team.md' && path.basename(path.dirname(file)) === '.near-ai' && path.basename(path.dirname(path.dirname(file))) === '.planning' ? path.resolve(path.dirname(file), '..', '..') : undefined);

/** What the user saw and confirmed, member by member and for the guidance. */
function planSignature(preview: TeamUpdatePreview): string {
  return JSON.stringify([preview.plan.template.id, preview.plan.template.toVersion, preview.plan.members.map((member) => [member.name, member.action, member.current ?? '', member.proposed ?? '', member.merged ?? '']), preview.guidance ? [preview.guidance.action, preview.guidance.current ?? '', preview.guidance.proposed ?? ''] : null]);
}

function samePlan(a: TeamUpdatePreview, b: TeamUpdatePreview): boolean {
  return planSignature(a) === planSignature(b);
}

/** The team file (or its guidance) changed after the user confirmed the preview; `preview` is the plan for the file as it is now. */
export class TeamChangedError extends Error {
  public constructor(file: string, public readonly preview: TeamUpdatePreview | undefined) {
    super(`${path.basename(file)} changed while you were reviewing the update, so nothing was written.`);
    this.name = 'TeamChangedError';
  }
}

/** An update that could be neither finished nor rolled back: `changed` names the files that have it, and `applied` is what Undo needs. */
export class PartialUpdateError extends Error {
  public constructor(message: string, public readonly applied: AppliedUpdate, public readonly changed: string[]) {
    super(message);
    this.name = 'PartialUpdateError';
  }
}

/** A run started while the update was being written; nothing was left changed. */
export class RunStartedError extends Error {
  public constructor() {
    super('A run started, so the team was not changed. Update it when the run ends.');
    this.name = 'RunStartedError';
  }
}

export class TeamUpdater {
  /**
   * `write` is replaceable so a test can make one write fail; `busy` says whether a run is in progress. It is checked synchronously right
   * before every write, so no run can start between the check and the write, and a run that starts part-way rolls the update back.
   */
  public constructor(private readonly library: TeamLibrary, private readonly write: (file: string, content: string) => Promise<void> = (file, content) => writeFile(file, content, 'utf8'), private readonly busy: () => boolean = runInProgress) {}

  /** What an update would change in a team file (and, for a project team, its AGENTS.md guidance); undefined when it is not from a built-in type. */
  public async preview(file: string): Promise<TeamUpdatePreview | undefined> {
    const text = await readFile(file, 'utf8');
    const plan = planTeamUpdate(text);
    if (!plan) return undefined;
    const name = parseTeam(text, file).name;
    const root = projectRoot(file);
    if (!root) return { file, name, plan, text };
    const agentsFile = path.join(root, 'AGENTS.md');
    const agents = await readFile(agentsFile, 'utf8').catch(() => undefined);
    const raw = await readFile(path.join(root, '.planning', '.near-ai', 'project.json'), 'utf8').catch(() => undefined);
    let config: Record<string, unknown> | undefined;
    try { const parsed: unknown = raw === undefined ? undefined : JSON.parse(raw); config = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined; } catch { config = undefined; }
    if (agents === undefined || !readProjectGuidance(agents)) return { file, name, plan, text };
    // The guidance is updated only when project.json can record the result (its guidanceBase); without one, a later update could not tell
    // the new guidance from an edit. Creating it would also switch on the project's red-team stage, so the guidance is left as it is.
    if (!config) return { file, name, plan, text, guidanceSkipped: `AGENTS.md was left as it is: this project has ${raw === undefined ? 'no' : 'an unreadable'} .planning/.near-ai/project.json to record the guidance in. Set the project type up again (Set Up Project Team) to update its guidance.` };
    // Only guidance this extension wrote for the same type is updated.
    if (config.type !== undefined && config.type !== plan.template.id) return { file, name, plan, text };
    const guidance = planGuidanceUpdate(agents, plan.template.id, typeof config.guidanceBase === 'string' ? config.guidanceBase : undefined);
    return { file, name, plan, text, ...(guidance.action === 'none' ? {} : { guidance, agentsFile, agents }) };
  }

  /** Whether the file should be offered an update: from a built-in type and not already current. */
  public async outdated(file: string): Promise<TeamUpdatePreview | undefined> {
    const preview = await this.preview(file).catch(() => undefined);
    // A team recognised only by its member names, none of which match any built-in version, is the user's own: not offered.
    if (preview && !preview.plan.template.stamped && !preview.plan.members.some((member) => member.action === 'auto' || member.action === 'same')) return undefined;
    return preview && (!preview.plan.upToDate || preview.guidance?.action === 'auto' || preview.guidance?.action === 'choice') ? preview : undefined;
  }

  /**
   * Writes the update as one change. Every new text is worked out first and every file is backed up (the team file into its version history,
   * AGENTS.md beside it) before anything is written. If a write fails, everything already written is put back and the error says nothing
   * changed; if putting it back fails too, a PartialUpdateError says exactly which files changed and carries what Undo needs.
   */
  public async apply(confirmed: TeamUpdatePreview, decisions: UpdateDecisions & { guidance?: 'take' | 'keep' }): Promise<AppliedUpdate> {
    // Plan again from the files as they are now: an edit made while the confirmation was open must not be overwritten by a stale plan.
    const preview = await this.preview(confirmed.file);
    if (!preview || !samePlan(preview, confirmed)) throw new TeamChangedError(confirmed.file, preview);
    const text = preview.text;
    const updated = applyTeamUpdate(text, preview.plan, decisions);
    parseTeam(updated, preview.file);
    const writes: Array<{ file: string; before: string; after: string; label: string }> = [{ file: preview.file, before: text, after: updated, label: path.basename(preview.file) }];
    const guidance = preview.guidance;
    const result: AppliedUpdate = { file: preview.file, backup: '' };
    if (preview.agentsFile && guidance && (guidance.action === 'auto' || (guidance.action === 'choice' && decisions.guidance === 'take'))) {
      const agents = preview.agents!;
      writes.push({ file: preview.agentsFile, before: agents, after: applyGuidanceUpdate(agents, guidance), label: 'AGENTS.md' });
      const configFile = path.join(path.dirname(preview.agentsFile), '.planning', '.near-ai', 'project.json');
      const raw = await readFile(configFile, 'utf8').catch(() => undefined);
      const config = raw === undefined ? undefined : (() => { try { return JSON.parse(raw) as Record<string, unknown>; } catch { return undefined; } })();
      if (raw !== undefined && config) writes.push({ file: configFile, before: raw, after: `${JSON.stringify({ ...config, templateVersion: templateVersion(preview.plan.template.id), guidanceBase: guidanceFingerprint(guidance.proposed!) }, null, 2)}\n`, label: 'project.json' });
      result.agentsFile = preview.agentsFile;
    }
    // Backups first, so a failure part-way can always be undone.
    await this.library.snapshot(preview.file);
    result.backup = (await this.library.versions(preview.file))[0];
    if (result.agentsFile) result.agentsBackup = await this.library.backup(preview.file, result.agentsFile, 'agents');
    const configWrite = writes.find((write) => write.label === 'project.json');
    if (configWrite) { result.configFile = configWrite.file; result.configBackup = await this.library.backup(preview.file, configWrite.file, 'config'); }
    // No snapshot after writing: one in the same millisecond would take the backup's file name.
    const written: typeof writes = [];
    try {
      for (const write of writes) {
        if (this.busy()) throw new RunStartedError();
        await this.write(write.file, write.after);
        written.push(write);
      }
    } catch (error) {
      const failed: string[] = [];
      for (const write of written.reverse()) await this.write(write.file, write.before).catch(() => failed.push(write.label));
      const reason = (error as Error).message;
      if (!failed.length && error instanceof RunStartedError) throw error;
      if (!failed.length) throw new Error(`Nothing was changed: writing ${writes[written.length]?.label ?? 'a file'} failed (${reason}), and what had been written was put back.`);
      throw new PartialUpdateError(`The update stopped part-way: writing failed (${reason}), and ${failed.join(' and ')} could not be put back, so ${failed.length === 1 ? 'it has' : 'they have'} the update and the rest do not. Undo restores the backups.`, result, failed);
    }
    return result;
  }

  /** Puts back what the update replaced, from its backups. */
  public async undo(applied: AppliedUpdate): Promise<void> {
    await writeFile(applied.file, await readFile(applied.backup, 'utf8'), 'utf8');
    await this.library.snapshot(applied.file);
    if (applied.agentsFile && applied.agentsBackup) await writeFile(applied.agentsFile, await readFile(applied.agentsBackup, 'utf8'), 'utf8');
    // project.json too, so the restored guidance is again recognised as the one the extension wrote, not as an edit.
    if (applied.configFile && applied.configBackup) await writeFile(applied.configFile, await readFile(applied.configBackup, 'utf8'), 'utf8');
  }
}

/** Something that keeps small values between sessions, such as VS Code's globalState. */
export interface KeyValueStore { get<T>(key: string): T | undefined; update(key: string, value: unknown): PromiseLike<void> }

const NOTICES_KEY = 'nearAi.teamUpdateNotices';
type Notices = Record<string, { offered?: number; dontAsk?: boolean }>;

/** Which teams were told an update is available (once per version) and which asked not to be told again. */
export class UpdateNotices {
  public constructor(private readonly store: KeyValueStore) {}
  private read(): Notices { return { ...(this.store.get<Notices>(NOTICES_KEY) ?? {}) }; }
  public shouldOffer(file: string, toVersion: number): boolean {
    const entry = this.read()[path.resolve(file)];
    return !entry?.dontAsk && entry?.offered !== toVersion;
  }
  public async offered(file: string, toVersion: number): Promise<void> {
    const all = this.read();
    all[path.resolve(file)] = { ...all[path.resolve(file)], offered: toVersion };
    await this.store.update(NOTICES_KEY, all);
  }
  public async dontAsk(file: string): Promise<void> {
    const all = this.read();
    all[path.resolve(file)] = { ...all[path.resolve(file)], dontAsk: true };
    await this.store.update(NOTICES_KEY, all);
  }
}

/** Where Update Team may write: a project's own team file, or a team file directly in the team library. */
export class TeamPathError extends Error {
  public constructor(requested: string, reason: string) {
    super(`Update Team only changes a project's .planning/.near-ai/team.md or a team in your team library; ${requested} ${reason}.`);
    this.name = 'TeamPathError';
  }
}

/**
 * Checks a requested team file before Update Team reads or writes it, and returns its real path. Allowed: `.planning/.near-ai/team.md` under one
 * of `roots`, or a `.md` file directly in the library folder (not in its archive or version history). The file must exist and must not be a
 * symlink, and its folder is compared by real path, so neither `..` nor a link can point the write anywhere else.
 */
export async function resolveTeamFile(library: TeamLibrary, requested: string, roots: string[]): Promise<string> {
  if (typeof requested !== 'string' || !requested.trim() || requested.includes('\0')) throw new TeamPathError(String(requested), 'is not a file path');
  const absolute = path.resolve(requested);
  const info = await lstat(absolute).catch(() => undefined);
  if (!info) throw new TeamPathError(requested, 'does not exist');
  if (info.isSymbolicLink()) throw new TeamPathError(requested, 'is a symbolic link');
  if (!info.isFile()) throw new TeamPathError(requested, 'is not a file');
  const folder = await realpath(path.dirname(absolute));
  const name = path.basename(absolute);
  const real = path.join(folder, name);
  const libraryFolder = await realpath(library.directory).catch(() => undefined);
  if (libraryFolder && folder === libraryFolder && name.endsWith('.md')) return real;
  for (const root of roots) {
    const projectFolder = await realpath(path.join(root, '.planning', '.near-ai')).catch(() => undefined);
    if (projectFolder && folder === projectFolder && name === 'team.md') return real;
  }
  throw new TeamPathError(requested, 'is neither');
}
