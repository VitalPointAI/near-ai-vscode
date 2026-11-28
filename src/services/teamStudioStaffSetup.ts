// The Team Studio chooser inspects staff coverage for a project selected by the editor host.
import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import * as path from 'node:path';
import { STAFF_TEMPLATES } from '../agent/staff/templates';
import { STAFF_SECTION_IDS, STAFF_SECTIONS } from '../domain/staff/doctrine';
import type { StaffLevel, StaffProfileId, StaffSectionId } from '../domain/staff/doctrine';
import { isStaffTeamSection, sectionCode, staffOrganizationDesignation, STAFF_ORGANIZATION_LEVELS, STAFF_ORGANIZATION_PROFILES } from '../domain/staff/profiles';
import type { StaffOrganizationLevel, StaffOrganizationProfile, StaffTeamSection } from '../domain/staff/profiles';
import { isOneOf } from '../domain/staff/parse';
import { readWhole } from '../staff/staffFiles';
import { existingStaffSettings, PROJECT_JSON, templateOffers, type StudioStaffSelection } from './staffSetup';
import { projectStaffTeams } from './staffTeams';

interface PreviewFolder { readonly root: string; readonly name: string }
interface ProjectIdentity { readonly resolved: string; readonly device: bigint; readonly inode: bigint }
interface CapturedProject { readonly folder: PreviewFolder; readonly identity: ProjectIdentity }

interface CoverageRow {
  readonly id: StaffSectionId;
  readonly code?: string;
  readonly status?: 'mappingUnavailable' | 'legacyUnresolved';
  readonly team?: string;
}

interface ChooserSession {
  readonly request: number;
  readonly id: string;
  readonly choice?: CapturedProject;
  readonly profile?: StaffOrganizationProfile;
  readonly organizationLevel?: StaffOrganizationLevel;
  legacy?: { readonly project: StudioStaffSelection; readonly offered: readonly StaffSectionId[] };
}

interface LegacyRow {
  readonly id: StaffSectionId;
  readonly code?: string;
  readonly template: boolean;
  readonly status: 'noTemplate' | 'linked' | 'unverified' | 'available' | 'incompatible';
  readonly team?: string;
  readonly decisionRole?: true;
}

interface LegacyPreview {
  readonly legacy: true;
  readonly session: string;
  readonly project: string;
  readonly profile?: StaffProfileId;
  readonly level?: StaffLevel;
  readonly rows: readonly LegacyRow[];
}

interface HandoffResult {
  readonly type: 'staff-preview-result';
  readonly request: number;
  readonly session: string;
  readonly applied: boolean;
  readonly preview?: LegacyPreview;
}

type PreviewState = { readonly type: 'staff-preview-state'; readonly request: number } &
  ({ readonly error: PreviewError } | (LegacyPreview & { readonly previousSession: string }) | {
    readonly session: string;
    readonly previousSession?: string;
    readonly project: string;
    readonly profiles: readonly StaffOrganizationProfile[];
    readonly levels: readonly StaffOrganizationLevel[];
    readonly profile?: StaffOrganizationProfile;
    readonly organizationLevel?: StaffOrganizationLevel;
    readonly legacySetup: boolean;
    readonly rows: readonly CoverageRow[];
  });

interface PreviewDeps {
  folders(): readonly PreviewFolder[];
  pick(folders: readonly PreviewFolder[]): Promise<PreviewFolder | undefined>;
  readonly libraryDir: string;
  post(message: PreviewState | HandoffResult): void;
  startSection?(section: StaffTeamSection, project: StudioStaffSelection): Promise<boolean>;
}

type PreviewError = 'projectChanged' | 'noProject' | 'noSelection' | 'previewFailed';

export type TeamStudioLocale = 'en-CA' | 'fr-CA';
export function createTeamStudioLocale(read: () => PromiseLike<unknown>) {
  let locale: TeamStudioLocale = 'en-CA';
  let generation = 0;
  const listeners = new Set<(value: TeamStudioLocale) => void>();
  return {
    current: () => locale,
    async refresh(): Promise<void> {
      const request = ++generation;
      let value: unknown;
      try { value = await read(); } catch { value = undefined; }
      if (request !== generation) return;
      const next = value === 'fr-CA' ? 'fr-CA' : 'en-CA';
      if (next === locale) return;
      locale = next;
      for (const listener of listeners) listener(next);
    },
    subscribe(listener: (value: TeamStudioLocale) => void): { dispose(): void } {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    }
  };
}

export type TeamStudioLanguage = ReturnType<typeof createTeamStudioLocale>;

function identify(root: string): ProjectIdentity | undefined {
  try {
    const resolved = realpathSync(root);
    const stat = statSync(resolved, { bigint: true });
    return stat.isDirectory() && stat.ino !== 0n ? { resolved, device: stat.dev, inode: stat.ino } : undefined;
  } catch {
    return undefined;
  }
}

function sameProject(before: ProjectIdentity, root: string): boolean {
  const now = identify(root);
  return now?.resolved === before.resolved && now.device === before.device && now.inode === before.inode;
}

async function projectSettings(root: string): Promise<string | undefined> {
  const parts = PROJECT_JSON.split('/');
  for (let index = 1; index <= parts.length; index += 1) {
    try {
      const info = await lstat(path.join(root, ...parts.slice(0, index)));
      if (index === parts.length ? !info.isFile() : !info.isDirectory()) return undefined;
    } catch {
      return undefined;
    }
  }
  const read = await readWhole(path.join(root, PROJECT_JSON));
  return read.kind === 'text' ? read.text : undefined;
}

async function legacyPreviewFor(project: PreviewFolder, root: string, libraryDir: string): Promise<{ content: Omit<LegacyPreview, 'session'>; bytes: string | undefined }> {
  const bytes = await projectSettings(root);
  const settings = existingStaffSettings(bytes);
  const links = settings?.teams ? await projectStaffTeams(root, libraryDir) : undefined;
  if (bytes !== await projectSettings(root)) throw new Error('Project settings changed');
  const rows = STAFF_SECTION_IDS.map((id): LegacyRow => {
    const section = STAFF_SECTIONS[id];
    const code = settings ? sectionCode(settings.profile, settings.level, id) : section.number === undefined ? undefined : `J${section.number}`;
    const template = STAFF_TEMPLATES.find((entry) => entry.section === id);
    if (!template) return { id, code, template: false, status: 'noTemplate' };
    const compatible = !settings || templateOffers(template).some((offer) => offer.profile === settings.profile && offer.level === settings.level && offer.nation === settings.nation);
    const expectedTeam = settings && isStaffTeamSection(id) ? settings.teams?.[id] : undefined;
    const link = expectedTeam ? links?.sections.find((entry) => entry.section === id && entry.team === expectedTeam) : undefined;
    if (link?.state === 'ready' && link.title) {
      return { id, code, template: compatible, team: link.title, status: 'linked', decisionRole: true };
    }
    const status = expectedTeam ? 'unverified' : compatible ? 'available' : 'incompatible';
    return { id, code, template: compatible, status, decisionRole: true };
  });
  const content: Omit<LegacyPreview, 'session'> = {
    legacy: true,
    project: project.name,
    ...(settings ? { profile: settings.profile, level: settings.level } : {}),
    rows
  };
  return { content, bytes };
}

type PreviewSelection = { readonly field: 'profile'; readonly choice: StaffOrganizationProfile }
  | { readonly field: 'level'; readonly choice: StaffOrganizationLevel };

type PreviewMessage =
  | { readonly type: 'staff-preview-open' | 'staff-preview-leave'; readonly request: number }
  | { readonly type: 'staff-preview-legacy' | 'staff-preview-back'; readonly request: number; readonly session: string }
  | { readonly type: 'staff-preview-continue'; readonly request: number; readonly session: string; readonly section: StaffTeamSection }
  | ({ readonly type: 'staff-preview-select'; readonly request: number; readonly session: string } & PreviewSelection);

function previewMessage(value: unknown): PreviewMessage | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const keys = Object.keys(value);
  const { type, request, session, field, choice, section } = value as Record<string, unknown>;
  if (!keys.includes('type') || !keys.includes('request') || typeof request !== 'number' || !Number.isSafeInteger(request) || request <= 0) return undefined;
  if ((type === 'staff-preview-open' || type === 'staff-preview-leave') && keys.length === 2) return { type, request };
  if (typeof session !== 'string' || !keys.includes('session')) return undefined;
  if ((type === 'staff-preview-legacy' || type === 'staff-preview-back') && keys.length === 3) return { type, request, session };
  if (type === 'staff-preview-continue' && keys.length === 4 && keys.includes('section') && isStaffTeamSection(section)) return { type, request, session, section };
  if (type !== 'staff-preview-select' || keys.length !== 5 || !['session', 'field', 'choice'].every(key => keys.includes(key))) return undefined;
  if (field === 'profile' && isOneOf(STAFF_ORGANIZATION_PROFILES, choice)) return { type, request, session, field, choice };
  if (field === 'level' && isOneOf(STAFF_ORGANIZATION_LEVELS, choice)) return { type, request, session, field, choice };
  return undefined;
}

export function createStaffSetupPreview(deps: PreviewDeps): {
  receive(value: unknown): Promise<void>;
  invalidate(): void;
  reset(): void;
  dispose(): void;
} {
  let current: ChooserSession | undefined;
  let inFlight = false;
  let latest = 0;
  let disposed = false;
  const fail = (session: ChooserSession, error: PreviewError) => {
    if (current !== session) return;
    current = undefined;
    deps.post({ type: 'staff-preview-state', request: session.request, error });
  };
  const invalidate = () => { if (current) fail(current, 'projectChanged'); };
  const isOpen = (session: ChooserSession, { folder, identity }: CapturedProject): boolean => current === session
    && deps.folders().some(({ root }) => root === folder.root) && sameProject(identity, folder.root);

  async function publish(session: ChooserSession, previousSession?: string): Promise<void> {
    const { choice, profile, organizationLevel } = session;
    if (!choice || !isOpen(session, choice)) return fail(session, 'projectChanged');
    const { folder, identity } = choice;
    try {
      const bytes = await projectSettings(identity.resolved);
      const settings = existingStaffSettings(bytes);
      const links = settings?.teams ? await projectStaffTeams(identity.resolved, deps.libraryDir) : undefined;
      if (bytes !== await projectSettings(identity.resolved) || !isOpen(session, choice)) return fail(session, 'projectChanged');
      const rows = STAFF_SECTION_IDS.map((id): CoverageRow => {
        const code = profile && organizationLevel ? staffOrganizationDesignation(profile, organizationLevel, id) : undefined;
        const team = isStaffTeamSection(id) ? settings?.teams?.[id] : undefined;
        const title = team ? links?.sections.find((entry) => entry.section === id && entry.team === team)?.title : undefined;
        return {
          id, ...(code ? { code } : {}),
          ...(team ? { team: title ?? team, status: 'legacyUnresolved' } : organizationLevel && !code ? { status: 'mappingUnavailable' } : {})
        };
      });
      deps.post({ type: 'staff-preview-state', request: session.request, session: session.id, previousSession,
        project: folder.name, profiles: STAFF_ORGANIZATION_PROFILES, levels: profile ? STAFF_ORGANIZATION_LEVELS : [],
        profile, organizationLevel, legacySetup: !profile && Boolean(deps.startSection), rows });
    } catch {
      fail(session, 'previewFailed');
    }
  }

  async function prepareLegacy(session: ChooserSession, choice: CapturedProject, active = session): Promise<LegacyPreview | undefined> {
    if (!isOpen(active, choice)) return undefined;
    const { folder, identity } = choice;
    const { content, bytes } = await legacyPreviewFor(folder, identity.resolved, deps.libraryDir);
    if (!isOpen(active, choice)) return undefined;
    session.legacy = {
      project: {
        root: identity.resolved, name: folder.name, ...(bytes === undefined ? {} : { projectJson: bytes }),
        isCurrent: () => isOpen(session, choice), isSameDirectory: () => sameProject(identity, folder.root),
        isPrimary: () => deps.folders()[0]?.root === folder.root && sameProject(identity, folder.root)
      },
      offered: content.rows.filter(row => row.template && (row.status === 'available' || row.status === 'unverified')).map(row => row.id)
    };
    return { session: session.id, ...content };
  }

  return {
    invalidate,
    reset: () => { current = undefined; latest = 0; },
    dispose: () => { disposed = true; current = undefined; },
    async receive(value) {
      const message = previewMessage(value);
      if (disposed || !message) return;
      const { request } = message;
      if (message.type === 'staff-preview-leave') {
        if (current?.request === request) current = undefined;
        return;
      }
      if (message.type === 'staff-preview-back') {
        const active = current;
        if (!active?.choice || !active.profile || active.request !== request || active.id !== message.session) return;
        const next: ChooserSession = { request, id: randomUUID(), choice: active.choice };
        current = next;
        await publish(next, active.id);
        return;
      }
      if (message.type === 'staff-preview-legacy') {
        const active = current;
        if (!active?.choice || active.profile || active.legacy || !deps.startSection
          || active.request !== request || active.id !== message.session) return;
        const next: ChooserSession = { request, id: randomUUID(), choice: active.choice };
        current = next;
        try {
          const preview = await prepareLegacy(next, active.choice);
          if (!preview) return fail(next, 'projectChanged');
          deps.post({ type: 'staff-preview-state', request, previousSession: active.id, ...preview });
        } catch {
          fail(next, 'previewFailed');
        }
        return;
      }
      if (message.type === 'staff-preview-continue') {
        const session = current;
        const start = deps.startSection;
        if (!session?.choice || !session.legacy || !start || session.request !== request
          || session.id !== message.session || !session.legacy.offered.includes(message.section)) return;
        const { choice, legacy: { project } } = session;
        delete session.legacy;
        if (inFlight || !project.isCurrent()) return invalidate();
        inFlight = true;
        let applied = false;
        let replacement: ChooserSession | undefined;
        let preview: LegacyPreview | undefined;
        try {
          applied = await start(message.section, project);
          const fresh: ChooserSession = { request, id: randomUUID(), choice };
          preview = await prepareLegacy(fresh, choice, session);
          if (preview) replacement = fresh;
        } catch {
          // The next section needs a fresh preview.
        } finally {
          inFlight = false;
          if (current === session) {
            current = replacement;
            deps.post({ type: 'staff-preview-result', request, session: session.id, applied, ...(preview ? { preview } : {}) });
          }
        }
        return;
      }
      if (message.type === 'staff-preview-select') {
        const active = current;
        if (!active?.choice || active.legacy || active.request !== request || active.id !== message.session) return;
        if (!isOpen(active, active.choice)) return fail(active, 'projectChanged');
        if (message.field === 'level' && !active.profile) return;
        const next: ChooserSession = message.field === 'profile'
          ? { request, id: randomUUID(), choice: active.choice, profile: message.choice }
          : { ...active, id: randomUUID(), organizationLevel: message.choice };
        current = next;
        await publish(next, active.id);
        return;
      }
      if (request <= latest) return;
      latest = request;
      const pending: ChooserSession = { request, id: randomUUID() };
      current = pending;
      const folders = deps.folders();
      if (!folders.length) return fail(pending, 'noProject');
      const offered = new Map(folders.map((folder) => [folder.root, { folder, identity: identify(folder.root) }]));
      try {
        const selected = folders.length === 1 ? folders[0] : await deps.pick(folders);
        if (current !== pending) return;
        if (!selected) return fail(pending, 'noSelection');
        const choice = offered.get(selected.root);
        if (!choice?.identity) return fail(pending, 'projectChanged');
        const session = { ...pending, choice: { folder: choice.folder, identity: choice.identity } };
        current = session;
        await publish(session);
      } catch {
        fail(pending, 'previewFailed');
      }
    }
  };
}
