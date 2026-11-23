import { randomBytes } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import { projectTeamFile } from './setupSteps';
import { createExclusive } from './stateHome';

export const CREATE_WORK_AREA_COMMAND = 'sterling.workAreas.create';
const WORK_AREA_KINDS = ['projects', 'training', 'operations', 'resources'] as const;
type WorkAreaKind = (typeof WORK_AREA_KINDS)[number];

const PROJECT_CATEGORIES = [
  { id: 'major-capital', label: 'Major capital project' },
  { id: 'minor-capital', label: 'Minor capital project' },
  { id: 'initiative', label: 'Initiative' },
  { id: 'product', label: 'Product' }
] as const;

interface WorkAreaParent {
  readonly folder: vscode.Uri;
  readonly mustStayOpen: boolean;
}

const CREATE = 'Create';
const CANCEL = 'Cancel';
const STALE_PARENT = 'The chosen folder changed. Start creating the work area again.';

function isWorkAreaKind(value: unknown): value is WorkAreaKind {
  return typeof value === 'string' && WORK_AREA_KINDS.some((kind) => kind === value);
}

async function chooseParent(): Promise<WorkAreaParent | undefined> {
  const folders = (vscode.workspace.workspaceFolders ?? []).filter(({ uri }) => uri.scheme === 'file');
  if (folders.length === 1) return { folder: folders[0].uri, mustStayOpen: true };
  if (folders.length > 1) {
    const selected = await vscode.window.showQuickPick(folders.map(({ name, uri }) => ({
      label: name, description: uri.fsPath, folder: uri
    })), { title: 'Choose a parent folder', placeHolder: 'The work area will be created inside this folder.' });
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

async function resolveParent(folder: vscode.Uri): Promise<{ directory: string; device: number; inode: number } | undefined> {
  try {
    const selected = await lstat(folder.fsPath);
    if (!selected.isDirectory()) return undefined;
    const directory = await realpath(folder.fsPath);
    const resolved = await lstat(directory);
    if (!resolved.isDirectory() || resolved.dev !== selected.dev || resolved.ino !== selected.ino) return undefined;
    return { directory, device: resolved.dev, inode: resolved.ino };
  } catch {
    return undefined;
  }
}

export async function createWorkArea(kind: unknown): Promise<{ uri: string; title: string } | undefined> {
  if (!isWorkAreaKind(kind)) return undefined;
  const parent = await chooseParent();
  if (!parent) return undefined;
  const title = (await vscode.window.showInputBox({
    title: 'New defence work area', prompt: 'Work area title', ignoreFocusOut: true, validateInput: titleProblem
  }))?.trim();
  if (title === undefined || titleProblem(title)) return undefined;
  const category = kind === 'projects'
    ? (await vscode.window.showQuickPick([...PROJECT_CATEGORIES], { title: 'Choose a project category', ignoreFocusOut: true }))?.id
    : undefined;
  if (kind === 'projects' && category === undefined) return undefined;

  const root = await resolveParent(parent.folder);
  if (!root) {
    void vscode.window.showWarningMessage(STALE_PARENT);
    return undefined;
  }
  const destination = path.join(root.directory, `work-area-${randomBytes(8).toString('hex')}`);
  const answer = await vscode.window.showWarningMessage(`Create “${title}”?`, {
    modal: true,
    detail: `Sterling will create and open this work area at ${destination}.`
  }, CREATE, CANCEL);
  if (answer !== CREATE) return undefined;
  const observedRoot = await resolveParent(parent.folder);
  const stillOpen = !parent.mustStayOpen || vscode.workspace.workspaceFolders?.some(({ uri }) =>
    uri.scheme === 'file' && path.relative(uri.fsPath, parent.folder.fsPath) === '');
  if (!stillOpen || !observedRoot || observedRoot.directory !== root.directory ||
    observedRoot.device !== root.device || observedRoot.inode !== root.inode) {
    void vscode.window.showWarningMessage(STALE_PARENT);
    return undefined;
  }

  try {
    await mkdir(destination, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      void vscode.window.showWarningMessage('An item already exists at this location. Start creating the work area again.');
    } else {
      void vscode.window.showErrorMessage('Sterling could not create a folder at that location.');
    }
    return undefined;
  }

  const projectDir = path.dirname(projectTeamFile(destination));
  try {
    await mkdir(path.dirname(projectDir), { mode: 0o700 });
    await mkdir(projectDir, { mode: 0o700 });
    const ignore = await createExclusive(path.join(projectDir, '.gitignore'), '/work-area.json\n');
    if (ignore === 'created') {
      const workArea = { version: 1, kind, title, ...(category ? { category } : {}) };
      const saved = await createExclusive(path.join(projectDir, 'work-area.json'), `${JSON.stringify(workArea, null, 2)}\n`);
      if (saved === 'created') return { uri: vscode.Uri.file(destination).toString(), title };
    }
  } catch {
    // Keep the new folder in place. It might already contain files from another editor.
  }
  void vscode.window.showErrorMessage('The folder was created, but Sterling could not save its work area details. The folder was kept.');
  return undefined;
}
