// The Team Studio chooser binds one section handoff to a project selected by the editor host.
import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import * as path from 'node:path';
import { STAFF_TEMPLATES } from '../agent/staff/templates';
import { STAFF_SECTION_IDS, STAFF_SECTIONS } from '../domain/staff/doctrine';
import type { StaffSectionId } from '../domain/staff/doctrine';
import { isStaffTeamSection, profileOf, sectionCode, type StaffTeamSection } from '../domain/staff/profiles';
import { readWhole } from '../staff/staffFiles';
import { existingStaffSettings, PROJECT_JSON, templateOffers, type StudioStaffSelection } from './staffSetup';
import { projectStaffTeams } from './staffTeams';

interface PreviewFolder { readonly root: string; readonly name: string }
interface ProjectIdentity { readonly resolved: string; readonly device: bigint; readonly inode: bigint }

interface PreviewRow {
  readonly id: StaffSectionId;
  readonly label: string;
  readonly template: boolean;
  readonly status: string;
  readonly team?: string;
  readonly decisionRole?: string;
}

interface PreviewContent {
  readonly project: string;
  readonly profile?: string;
  readonly level?: string;
  readonly modelLocation: string;
  readonly rows: readonly PreviewRow[];
}

type PreviewState = { readonly type: 'staff-preview-state'; readonly request: number } &
  ({ readonly session: string } & PreviewContent | { readonly error: string });

interface HandoffResult {
  readonly type: 'staff-preview-result';
  readonly request: number;
  readonly session: string;
  readonly applied: boolean;
}

interface PreviewDeps {
  folders(): readonly PreviewFolder[];
  pick(folders: readonly PreviewFolder[]): Promise<PreviewFolder | undefined>;
  readonly libraryDir: string;
  post(message: PreviewState | HandoffResult): void;
  startSection?(section: StaffTeamSection, project: StudioStaffSelection): Promise<boolean>;
}

const changed = 'The project changed. Review the new plan before setting up staff.';

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

async function previewFor(project: PreviewFolder, root: string, libraryDir: string): Promise<{ content: PreviewContent; bytes: string | undefined }> {
  const bytes = await projectSettings(root);
  const settings = existingStaffSettings(bytes);
  const links = settings?.teams ? await projectStaffTeams(root, libraryDir) : undefined;
  if (bytes !== await projectSettings(root)) throw new Error('Project settings changed');
  const rows = STAFF_SECTION_IDS.map((id): PreviewRow => {
    const section = STAFF_SECTIONS[id];
    const code = settings ? sectionCode(settings.profile, settings.level, id) : section.number === undefined ? undefined : `J${section.number}`;
    const label = code ? `${code} ${section.function}` : section.function;
    const template = STAFF_TEMPLATES.find((entry) => entry.section === id);
    if (!template) return { id, label, template: false, status: 'Setup unavailable. No team template is available.' };
    const compatible = !settings || templateOffers(template).some((offer) => offer.profile === settings.profile && offer.level === settings.level && offer.nation === settings.nation);
    const decisionRole = 'Section lead. Appointment unverified.';
    const expectedTeam = settings && isStaffTeamSection(id) ? settings.teams?.[id] : undefined;
    const link = expectedTeam ? links?.sections.find((entry) => entry.section === id && entry.team === expectedTeam) : undefined;
    if (link?.state === 'ready' && link.title) {
      return { id, label, template: compatible, team: link.title, status: 'Linked team. Review before retaining or replacing it.', decisionRole };
    }
    const status = expectedTeam
      ? 'Linked team could not be verified.'
      : compatible ? 'Section template available. Whole-staff changes require review.' : 'Setup unavailable for this staff profile and level.';
    return { id, label, template: compatible, status, decisionRole };
  });
  const content: PreviewContent = {
    project: project.name,
    ...(settings ? { profile: profileOf(settings.profile).name, level: settings.level[0].toUpperCase() + settings.level.slice(1) } : {}),
    modelLocation: 'Model location unavailable until project setup records a policy.',
    rows
  };
  return { content, bytes };
}

type PreviewMessage =
  | { readonly type: 'staff-preview-open' | 'staff-preview-leave'; readonly request: number }
  | { readonly type: 'staff-preview-continue'; readonly request: number; readonly session: string; readonly section: StaffTeamSection };

function previewMessage(value: unknown): PreviewMessage | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const keys = Object.keys(value);
  const { type, request, session, section } = value as Record<string, unknown>;
  if (!keys.includes('type') || !keys.includes('request') || typeof request !== 'number' || !Number.isSafeInteger(request) || request <= 0) return undefined;
  if ((type === 'staff-preview-open' || type === 'staff-preview-leave') && keys.length === 2) return { type, request };
  if (type !== 'staff-preview-continue' || keys.length !== 4 || !keys.includes('session') || !keys.includes('section')) return undefined;
  if (typeof session !== 'string' || !isStaffTeamSection(section)) return undefined;
  return { type, request, session, section };
}

interface ChooserSession {
  readonly request: number;
  readonly id: string;
  preview?: { readonly project: StudioStaffSelection; readonly offered: readonly StaffSectionId[] };
}

export function createStaffSetupPreview(deps: PreviewDeps): {
  receive(value: unknown): Promise<void>;
  invalidate(): void;
  reset(): void;
  dispose(): void;
} {
  let current: ChooserSession | undefined;
  let inFlight: ChooserSession | undefined;
  let latest = 0;
  let disposed = false;
  const publishError = (request: number, error: string) => deps.post({ type: 'staff-preview-state', request, error });
  const invalidate = () => {
    const previous = current;
    current = undefined;
    if (previous) publishError(previous.request, changed);
  };

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
      if (message.type === 'staff-preview-continue') {
        const session = current;
        const start = deps.startSection;
        if (!session?.preview || !start || session.request !== request || session.id !== message.session || !session.preview.offered.includes(message.section)) return;
        const project = session.preview.project;
        delete session.preview;
        if (inFlight || !project.isCurrent()) { invalidate(); return; }
        inFlight = session;
        let applied = false;
        try {
          applied = await start(message.section, project);
        } finally {
          inFlight = undefined;
          if (current === session) {
            current = undefined;
            deps.post({ type: 'staff-preview-result', request, session: session.id, applied });
          }
        }
        return;
      }
      if (request <= latest) return;
      latest = request;
      const session: ChooserSession = { request, id: randomUUID() };
      current = session;
      const fail = (error: string) => {
        if (current !== session) return;
        current = undefined;
        publishError(request, error);
      };
      const folders = deps.folders();
      if (!folders.length) return fail('Open a project to set up its staff.');
      const offered = new Map(folders.map((folder) => [folder.root, { folder, identity: identify(folder.root) }]));
      try {
        const selected = folders.length === 1 ? folders[0] : await deps.pick(folders);
        if (current !== session) return;
        if (!selected) return fail('Choose a project to see its staff setup.');
        const choice = offered.get(selected.root);
        if (!choice?.identity) return fail(changed);
        const { folder, identity } = choice;
        const isSameDirectory = () => sameProject(identity, folder.root);
        const isCurrent = () => current === session && isSameDirectory() && deps.folders().some(({ root }) => root === folder.root);
        const isPrimary = () => {
          const primary = deps.folders()[0];
          return Boolean(primary && isSameDirectory() && sameProject(identity, primary.root));
        };
        if (!isCurrent()) return fail(changed);
        const { content, bytes } = await previewFor(folder, identity.resolved, deps.libraryDir);
        if (!isCurrent()) return fail(changed);
        session.preview = {
          project: { root: identity.resolved, name: folder.name, ...(bytes === undefined ? {} : { projectJson: bytes }), isCurrent, isSameDirectory, isPrimary },
          offered: content.rows.filter((row) => row.template).map((row) => row.id)
        };
        deps.post({ type: 'staff-preview-state', request, session: session.id, ...content });
      } catch {
        fail('Staff setup did not finish. Review the project and try again.');
      }
    }
  };
}
