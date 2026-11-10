import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { applyGuidanceUpdate, applyTeamUpdate, planGuidanceUpdate, planTeamUpdate, type GuidancePlan, type TeamUpdatePlan, type UpdateDecisions } from '../agent/teamUpdate';
import { parseTeam, TeamLibrary } from '../agent/teams';
import { guidanceFingerprint } from '../agent/teamFingerprints';
import { templateVersion } from '../agent/projectTypes';

// Update Team without VS Code: preview, apply with a backup first, and undo; and the record of
// which teams have been offered an update or asked not to be. The commands in
// workspaceCommands.ts put these behind a preview and a confirmation.

export interface TeamUpdatePreview { file: string; name: string; plan: TeamUpdatePlan; guidance?: GuidancePlan; agentsFile?: string }
export interface AppliedUpdate { file: string; backup: string; agentsFile?: string; agentsBackup?: string }

const projectRoot = (file: string) => (path.basename(file) === 'team.md' && path.basename(path.dirname(file)) === '.near-ai' && path.basename(path.dirname(path.dirname(file))) === '.planning' ? path.resolve(path.dirname(file), '..', '..') : undefined);

export class TeamUpdater {
  public constructor(private readonly library: TeamLibrary) {}

  /** What an update would change in a team file (and, for a project team, its AGENTS.md guidance); undefined when it is not from a built-in type. */
  public async preview(file: string): Promise<TeamUpdatePreview | undefined> {
    const text = await readFile(file, 'utf8');
    const plan = planTeamUpdate(text);
    if (!plan) return undefined;
    const name = parseTeam(text, file).name;
    const root = projectRoot(file);
    if (!root) return { file, name, plan };
    const agentsFile = path.join(root, 'AGENTS.md');
    const agents = await readFile(agentsFile, 'utf8').catch(() => undefined);
    const config = await readFile(path.join(root, '.planning', '.near-ai', 'project.json'), 'utf8').then((raw) => JSON.parse(raw) as Record<string, unknown>).catch(() => ({} as Record<string, unknown>));
    // Only guidance this extension wrote for the same type is updated.
    if (agents === undefined || (config.type !== undefined && config.type !== plan.template.id)) return { file, name, plan };
    const guidance = planGuidanceUpdate(agents, plan.template.id, typeof config.guidanceBase === 'string' ? config.guidanceBase : undefined);
    return { file, name, plan, ...(guidance.action === 'none' ? {} : { guidance, agentsFile }) };
  }

  /** Whether the file should be offered an update: from a built-in type and not already current. */
  public async outdated(file: string): Promise<TeamUpdatePreview | undefined> {
    const preview = await this.preview(file).catch(() => undefined);
    // A team recognised only by its member names, none of which match any built-in version, is the user's own: not offered.
    if (preview && !preview.plan.template.stamped && !preview.plan.members.some((member) => member.action === 'auto' || member.action === 'same')) return undefined;
    return preview && (!preview.plan.upToDate || preview.guidance?.action === 'auto' || preview.guidance?.action === 'choice') ? preview : undefined;
  }

  /**
   * Writes the update: the team file (and the guidance, when `guidance` is take) is backed up into the team's version history first, then
   * rewritten and stamped. The result names the backups, for undo.
   */
  public async apply(preview: TeamUpdatePreview, decisions: UpdateDecisions & { guidance?: 'take' | 'keep' }): Promise<AppliedUpdate> {
    const text = await readFile(preview.file, 'utf8');
    const updated = applyTeamUpdate(text, preview.plan, decisions);
    parseTeam(updated, preview.file);
    await this.library.snapshot(preview.file);
    const backup = (await this.library.versions(preview.file))[0];
    // No second snapshot here: one in the same millisecond would take the backup's file name.
    await writeFile(preview.file, updated, 'utf8');
    const result: AppliedUpdate = { file: preview.file, backup };
    const guidance = preview.guidance;
    if (preview.agentsFile && guidance && (guidance.action === 'auto' || (guidance.action === 'choice' && decisions.guidance === 'take'))) {
      const agents = await readFile(preview.agentsFile, 'utf8');
      result.agentsFile = preview.agentsFile;
      result.agentsBackup = await this.library.backup(preview.file, preview.agentsFile, 'agents');
      await writeFile(preview.agentsFile, applyGuidanceUpdate(agents, guidance), 'utf8');
      const configFile = path.join(path.dirname(preview.agentsFile), '.planning', '.near-ai', 'project.json');
      const config = await readFile(configFile, 'utf8').then((raw) => JSON.parse(raw) as Record<string, unknown>).catch(() => undefined);
      if (config) await writeFile(configFile, `${JSON.stringify({ ...config, templateVersion: templateVersion(preview.plan.template.id), guidanceBase: guidanceFingerprint(guidance.proposed!) }, null, 2)}\n`, 'utf8');
    }
    return result;
  }

  /** Puts back what the update replaced, from its backups. */
  public async undo(applied: AppliedUpdate): Promise<void> {
    await writeFile(applied.file, await readFile(applied.backup, 'utf8'), 'utf8');
    await this.library.snapshot(applied.file);
    if (applied.agentsFile && applied.agentsBackup) await writeFile(applied.agentsFile, await readFile(applied.agentsBackup, 'utf8'), 'utf8');
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
