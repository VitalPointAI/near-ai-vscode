// Creates a defence work area for the Sterling workbench's work-area pages (their "Create …" button runs sterling.workAreas.create with the page's
// kind). A work area is a new folder, work-area-<16 hex digits>, inside the folder the person chooses, holding .planning/.near-ai/work-area.json with
// its kind and title: the marker the workbench reads (workbench/extension/src/common/sterling-work-areas.ts parseWorkArea). Ported from the Codex
// branches (50d5861f, 96b05d57, b42b5fb1) and reviewed:
//   - the only value the caller supplies is the kind, checked against a fixed list, so no caller text ever reaches a path;
//   - every write is inside the new folder, which is a direct child of the chosen folder (checked by real path, device and inode);
//   - nothing is ever overwritten: the folder name is random, the folder and the marker are created exclusively, and an existing item refuses;
//   - the person confirms the location before anything is written, and the chosen folder is checked again after the confirmation.
// The caller opens the returned folder; this command never opens anything itself.
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import { projectTeamFile } from './setupSteps';
import { createExclusive } from './stateHome';

export const CREATE_WORK_AREA_COMMAND = 'sterling.workAreas.create';
export const WORK_AREA_KINDS = ['capability-development', 'training', 'operations', 'resources'] as const;
export type WorkAreaKind = (typeof WORK_AREA_KINDS)[number];

// The naming dialog per kind, matching the page names the workbench shows ("operations" is the Planning page; the stored kind stays).
const WORK_AREA_DIALOGS: Record<WorkAreaKind, readonly [title: string, prompt: string]> = {
  'capability-development': ['New Capability Development work area', 'Capability title'],
  training: ['New Exercises & Training work area', 'Exercise or training title'],
  operations: ['New Planning work area', 'Plan title'],
  resources: ['New Resource Management work area', 'Resource management title']
};

const CAPABILITY_COMPONENT_KINDS = [
  { id: 'program', label: 'Program' },
  { id: 'major-capital', label: 'Major capital project' },
  { id: 'minor-capital', label: 'Minor capital project' },
  { id: 'initiative', label: 'Initiative' },
  { id: 'product', label: 'Product' }
] as const;
const FINISH = { id: 'finish', label: 'Finish adding components' } as const;
const MAX_CAPABILITY_COMPONENTS = 50;

interface CapabilityComponent {
  readonly kind: (typeof CAPABILITY_COMPONENT_KINDS)[number]['id'];
  readonly title: string;
}

interface WorkAreaParent {
  readonly folder: vscode.Uri;
  readonly mustStayOpen: boolean;
}

interface ResolvedFolder {
  readonly directory: string;
  readonly device: number;
  readonly inode: number;
}

const CREATE = 'Create';
const CANCEL = 'Cancel';
const STALE_PARENT = 'The chosen folder changed. Start creating the work area again.';
const GENERATED_FOLDER = /^work-area-[0-9a-f]{16}$/u;

export function isWorkAreaKind(value: unknown): value is WorkAreaKind {
  return typeof value === 'string' && WORK_AREA_KINDS.some((kind) => kind === value);
}

/** True when `target` is `root` itself or below it, compared as paths (no `..` step out, not another drive). */
export function isInsideFolder(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function chooseParent(): Promise<WorkAreaParent | undefined> {
  const folders = (vscode.workspace.workspaceFolders ?? []).filter(({ uri }) => uri.scheme === 'file');
  if (folders.length === 1) return { folder: folders[0].uri, mustStayOpen: true };
  if (folders.length > 1) {
    const selected = await vscode.window.showQuickPick(folders.map(({ name, uri }) => ({
      label: name, description: uri.fsPath, folder: uri
    })), { title: 'Choose a parent folder', placeHolder: 'The work area will be created inside this folder.', ignoreFocusOut: true });
    return selected && { folder: selected.folder, mustStayOpen: true };
  }
  const selected = await vscode.window.showOpenDialog({
    title: 'Choose a parent folder', openLabel: 'Choose folder',
    canSelectFolders: true, canSelectFiles: false, canSelectMany: false
  });
  const folder = selected?.[0];
  return folder?.scheme === 'file' ? { folder, mustStayOpen: false } : undefined;
}

function titleProblem(value: string): string | undefined {
  const title = value.trim();
  if (!title || title.length > 100 || /[\p{Cc}\u2028\u2029]/u.test(title)) {
    return 'Enter a title of up to 100 characters on one line.';
  }
  return undefined;
}

async function askTitle(title: string, prompt: string): Promise<string | undefined> {
  const value = (await vscode.window.showInputBox({ title, prompt, ignoreFocusOut: true, validateInput: titleProblem }))?.trim();
  return value === undefined || titleProblem(value) ? undefined : value;
}

async function chooseCapabilityComponents(): Promise<CapabilityComponent[] | undefined> {
  const components: CapabilityComponent[] = [];
  while (components.length < MAX_CAPABILITY_COMPONENTS) {
    const selected = await vscode.window.showQuickPick([...CAPABILITY_COMPONENT_KINDS, FINISH], {
      title: 'Add a capability component', ignoreFocusOut: true,
      placeHolder: `Choose a component type or finish. ${components.length} of ${MAX_CAPABILITY_COMPONENTS} added.`
    });
    if (selected === undefined) return undefined;
    if (selected.id === FINISH.id) return components;
    const title = await askTitle(selected.label, 'Component title');
    if (title === undefined) return undefined;
    components.push({ kind: selected.id, title });
  }
  return components;
}

/** The folder's real path with its device and inode, or undefined when it is not a directory (a link to one counts only as what it points at). */
async function resolveFolder(folder: string): Promise<ResolvedFolder | undefined> {
  try {
    const selected = await lstat(folder);
    if (!selected.isDirectory()) return undefined;
    const directory = await realpath(folder);
    const resolved = await lstat(directory);
    if (!resolved.isDirectory() || resolved.dev !== selected.dev || resolved.ino !== selected.ino) return undefined;
    return { directory, device: resolved.dev, inode: resolved.ino };
  } catch {
    return undefined;
  }
}

const sameFolder = (a: ResolvedFolder, b: ResolvedFolder | undefined): boolean =>
  b !== undefined && a.directory === b.directory && a.device === b.device && a.inode === b.inode;

/**
 * Asks for the parent folder, the title (and, for Capability Development, its components), confirms the location, then creates the work area.
 * Returns the new folder's URI and the title, or undefined when the person cancelled or creation was refused (a message says why).
 */
export async function createWorkArea(kind: unknown): Promise<{ uri: string; title: string } | undefined> {
  if (!isWorkAreaKind(kind)) return undefined;
  const parent = await chooseParent();
  if (!parent) return undefined;
  const title = await askTitle(...WORK_AREA_DIALOGS[kind]);
  if (title === undefined) return undefined;
  const components = kind === 'capability-development' ? await chooseCapabilityComponents() : undefined;
  if (kind === 'capability-development' && components === undefined) return undefined;

  const root = await resolveFolder(parent.folder.fsPath);
  if (!root) {
    void vscode.window.showWarningMessage(STALE_PARENT);
    return undefined;
  }
  const name = `work-area-${randomBytes(8).toString('hex')}`;
  const destination = path.join(root.directory, name);
  if (!GENERATED_FOLDER.test(name) || path.dirname(destination) !== root.directory) return undefined;
  const componentCount = components ? ` Components to add: ${components.length}.` : '';
  const answer = await vscode.window.showWarningMessage(`Create “${title}”?`, {
    modal: true,
    detail: `The work area will be created and opened at ${destination}.${componentCount}`
  }, CREATE, CANCEL);
  if (answer !== CREATE) return undefined;
  const stillOpen = !parent.mustStayOpen || vscode.workspace.workspaceFolders?.some(({ uri }) =>
    uri.scheme === 'file' && path.relative(uri.fsPath, parent.folder.fsPath) === '');
  if (!stillOpen || !sameFolder(root, await resolveFolder(parent.folder.fsPath))) {
    void vscode.window.showWarningMessage(STALE_PARENT);
    return undefined;
  }

  try {
    // Not recursive: an existing file, folder or link at this name refuses, so nothing is ever written into something that was already there.
    await mkdir(destination, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      void vscode.window.showWarningMessage('An item already exists at this location. Start creating the work area again.');
    } else {
      void vscode.window.showErrorMessage('The work area folder could not be created at that location.');
    }
    return undefined;
  }

  const projectDir = path.dirname(projectTeamFile(destination));
  try {
    // The new folder must still be the one just made, directly inside the chosen folder, before anything goes into it.
    const made = await resolveFolder(destination);
    if (!made || made.directory !== destination || !isInsideFolder(destination, projectDir)) throw new Error('moved');
    await mkdir(path.dirname(projectDir), { mode: 0o700 });
    await mkdir(projectDir, { mode: 0o700 });
    if (await realpath(projectDir) !== projectDir) throw new Error('moved');
    const ignore = await createExclusive(path.join(projectDir, '.gitignore'), '/work-area.json\n');
    if (ignore === 'created') {
      const workArea = { version: 1, kind, title, ...(components ? { components } : {}) };
      const saved = await createExclusive(path.join(projectDir, 'work-area.json'), `${JSON.stringify(workArea, null, 2)}\n`);
      if (saved === 'created') return { uri: vscode.Uri.file(destination).toString(), title };
    }
  } catch {
    // Keep the new folder in place: it might already hold files from another editor.
  }
  void vscode.window.showErrorMessage('The folder was created, but its work area details could not be saved. The folder was kept.');
  return undefined;
}
