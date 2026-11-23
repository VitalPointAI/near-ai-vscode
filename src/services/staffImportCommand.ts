// SovAI: Staff: Import Feed File... (research note 11, 9.2 item 3; WP-IMP). A person picks a GeoJSON, KML, CoT, RSS, Atom or AIS file; the file is
// parsed in a separate process; the person sees what would be imported (how many observations, the format, the label, the time span, and what is held
// outside the exercise frame or skipped) and confirms in a modal dialog before anything is written. Agents cannot run it: no agent tool runs a VS Code
// command, and approving a new import feed needs a named person.
import * as vscode from 'vscode';
import { STAFF_TEMPLATE_LABELS } from '../domain/staff/doctrine';
import { STAFF_IMPORT_FEED_COMMAND } from '../domain/staff/commands';
import { importSummaryText } from '../domain/staff/obs/importers';
import type { PersonActor } from '../domain/staff/release';
import { commitImport, prepareImport } from '../staff/feedImport/feedImport';
import { observationStoreFor } from '../staff/observationStore';

export { STAFF_IMPORT_FEED_COMMAND };

/** The same key the staff decision commands keep the person's name and role under. */
const PERSON_KEY = 'nearAi.staff.person';

export interface ImportCommandContext {
  readonly subscriptions: Array<{ dispose(): unknown }>;
  readonly globalState?: { get<T>(key: string): T | undefined; update(key: string, value: unknown): Thenable<void> };
}

export function registerStaffImport(context: ImportCommandContext): void {
  context.subscriptions.push(vscode.commands.registerCommand(STAFF_IMPORT_FEED_COMMAND, async () => {
    try { await importFeedFile(context); } catch (error) { void vscode.window.showErrorMessage(`NEAR AI could not finish that: ${error instanceof Error ? error.message : String(error)}`); }
  }));
}

async function askPerson(context: ImportCommandContext): Promise<PersonActor | undefined> {
  const last = context.globalState?.get<{ name?: string; role?: string }>(PERSON_KEY);
  const name = await vscode.window.showInputBox({ title: 'Your name', prompt: 'The import is recorded under the name and role you give here (self-declared).', value: last?.name ?? '', ignoreFocusOut: true });
  if (!name?.trim()) return undefined;
  const role = await vscode.window.showInputBox({ title: 'Your role', prompt: 'The role you import in, for example J2 watch officer.', value: last?.role ?? '', ignoreFocusOut: true });
  if (!role?.trim()) return undefined;
  await context.globalState?.update(PERSON_KEY, { name: name.trim(), role: role.trim() });
  return { kind: 'person', name: name.trim().slice(0, 120), role: role.trim().slice(0, 80), deviceFingerprint: 'this-window' };
}

async function importFeedFile(context: ImportCommandContext): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const store = root ? observationStoreFor(root) : undefined;
  if (!root || !store) { void vscode.window.showInformationMessage('Open the project folder of a staff team first.'); return; }
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false, canSelectFiles: true, canSelectFolders: false, openLabel: 'Read this file', title: 'Import a feed file into the observation store',
    filters: { 'Feed files': ['geojson', 'json', 'kml', 'xml', 'cot', 'rss', 'atom', 'nmea', 'ais', 'txt', 'log'], 'All files': ['*'] }
  });
  const file = picked?.[0]?.fsPath;
  if (!file) return;
  const labelPick = await vscode.window.showQuickPick(
    STAFF_TEMPLATE_LABELS.map((label) => ({ label, ...(label === 'org/Internal' ? { description: 'the import feed\'s own label' } : {}) })).sort((a, b) => (a.label === 'org/Internal' ? -1 : b.label === 'org/Internal' ? 1 : 0)),
    { title: 'The label every imported observation gets', placeHolder: `Staff projects hold exercise data at ${STAFF_TEMPLATE_LABELS.join(', ')} at most` }
  );
  if (!labelPick) return;
  const prepared = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Reading the feed file in a separate process...' },
    () => prepareImport({ root, file, label: labelPick.label, now: Date.now() }));
  if (!prepared.ok) { void vscode.window.showWarningMessage(`Nothing was imported. ${prepared.message}`); return; }
  const { plan } = prepared;
  const preview = `${importSummaryText(plan)}${prepared.labelRaised ? `\nThe label was raised to ${plan.label}: an import is never labelled below its feed.` : ''}`;
  if (plan.rows.length === 0) { void vscode.window.showWarningMessage('Nothing in that file can be imported.', { modal: true, detail: preview }); return; }
  const person = await askPerson(context);
  if (!person) return;
  const choice = await vscode.window.showInformationMessage(`Import ${plan.rows.length} observation${plan.rows.length === 1 ? '' : 's'} from ${plan.fileName}?`, { modal: true, detail: `${preview}\nNothing is written until you choose Import.` }, 'Import');
  if (choice !== 'Import') return;
  const result = await commitImport(store, plan, person);
  if (result.ok) void vscode.window.showInformationMessage(result.message);
  else void vscode.window.showWarningMessage(result.message);
}

