// The research workspace's rules (74.1 D-17, provenance design 7): the one place adversary models are used on purpose, with no project data and no tools.
// Pure: no vscode, no clock. Paths are compared after the caller's resolver (fs.realpathSync in the host) has followed symlinks and '..', so a link inside
// the workspace's own folder that points into a project is judged by where it points. The words are the UI-SPEC's (74.1-UI-SPEC S1, S2), constants here so
// the copy lint reads them and the cyber panel shares them.
import * as path from 'node:path';
import type { UseInput } from './useTier';

/** Every sentence the research workspace and the cyber panel's research banner show (74.1-UI-SPEC S1, S2). Placeholders in braces are filled by code. */
export const RESEARCH_TEXT = Object.freeze({
  command: 'Open Research Workspace',
  panelTitle: 'Research workspace',
  banner: 'Research workspace. Adversary models allowed. No project data.',
  bannerDetail: 'SovAI\'s own checks keep your projects and every tool out of this workspace. It does not run in a separate machine.',
  modelLabel: 'Model to study',
  emptyTitle: 'Choose a model to study',
  emptyBody: 'Any model in the list can answer here, including models approved for research only. Messages and files stay in this workspace\'s own folder.',
  placeholder: 'Ask the model. Nothing from your projects is sent.',
  send: 'Send message',
  addFile: 'Add a file',
  newChat: 'New research chat',
  copiedIn: 'Copied {file} into this workspace\'s own folder and attached it.',
  fileCopyFailed: '{file} could not be copied into this workspace\'s folder: {reason}. Nothing was attached. Save the file somewhere you can read it, outside your projects, and add it again.',
  laneNotice: 'This is the research workspace. It cannot open project files, run commands or use tools.',
  projectFileRefused: '{file} is in a project, so it was not added.',
  copyName: 'Copy with the research workspace line',
  copyHeader: 'From the research workspace, model {model}, untrusted',
  copied: 'Copied. The first line says where the text came from.',
  loadingModels: 'Loading the models list',
  modelsError: 'The models list could not be loaded: {reason}.',
  reloadModels: 'Reload models list',
  noModels: 'No AI service gives any models yet. Add an AI service, then choose a model here.',
  addService: 'Add an AI service',
  waiting: 'Waiting for {model}',
  cyberIsolation: 'Scans run on this computer with your approvals and this engagement\'s scope check. They are not isolated in a separate machine.',
  cyberChooseModel: 'Choose a model for this engagement. Nothing is sent until you press Run.',
  cyberProjectTarget: 'This is the research workspace. A scan cannot target a folder in an open project: {folder}.'
});

/** Fills `{name}` placeholders; an unknown placeholder is left as it is. */
export function fillText(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{([a-z]+)\}/g, (whole, key: string) => (Object.prototype.hasOwnProperty.call(values, key) ? values[key] as string : whole));
}

/** The tools a research workspace request may carry: none (no read, write, edit, run, web, MCP or sub-agent). */
export const LANE_TOOLS: readonly string[] = Object.freeze([]);

/** Whether the research workspace may offer a tool by name: never. */
export function laneToolAllowed(name: string): boolean {
  return LANE_TOOLS.includes(name);
}

/** The use of every research workspace request (D-17): research only, whatever else is set. */
export const RESEARCH_USE: UseInput = Object.freeze({ lane: 'research' });

/** The `lane` a model request's record carries: `t0` for a request in the research lane, none otherwise (D-17, D-23). */
export function recordLaneOf(use: UseInput | undefined): 't0' | undefined {
  return use?.lane === 'research' ? 't0' : undefined;
}

/** True when `child` is `parent` or inside it, both already absolute and resolved. */
export function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Whether a file may be attached in the research workspace as it is: only a real file inside the workspace's own folder, after `resolve` has followed
 * symlinks and '..' (the host passes fs.realpathSync). A path that cannot be resolved is refused.
 */
export function laneAttachmentAllowed(file: string, laneFolder: string, resolve: (value: string) => string): boolean {
  try {
    return isInside(resolve(path.resolve(file)), resolve(path.resolve(laneFolder)));
  } catch {
    return false;
  }
}

/**
 * The open project folder a file lies in, after resolving (Q2: such a file is never copied in), or undefined. A path or folder that cannot be resolved is
 * compared as given, so a broken link into a project still counts as the project's.
 */
export function projectFolderOf(file: string, projectFolders: readonly string[], resolve: (value: string) => string): string | undefined {
  const real = (value: string): string => { try { return resolve(path.resolve(value)); } catch { return path.resolve(value); } };
  const own = [path.resolve(file), real(file)];
  for (const folder of projectFolders) {
    const roots = [path.resolve(folder), real(folder)];
    if (own.some((candidate) => roots.some((root) => isInside(candidate, root)))) return folder;
  }
  return undefined;
}

/** The first line of text copied out of the research workspace. */
export function copyOutHeader(model: string): string {
  return fillText(RESEARCH_TEXT.copyHeader, { model });
}

/** `text` with the header line, then a blank line, first; added once even when the text already starts with it. */
export function withCopyOutHeader(model: string, text: string): string {
  const header = copyOutHeader(model);
  return text.startsWith(header) ? text : `${header}\n\n${text}`;
}
