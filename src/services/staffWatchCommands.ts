// A named person's standing watch steps (research note 11, 4.5; WP-WATCH): create and arm, arm a member's proposal, pause, resume, acknowledge the
// drafts, and reject or retire. Each asks who the person is and confirms in a modal dialog; arming and retiring are signed with this device's key in the
// decision log. No agent tool runs a VS Code command, so a member can only propose a watch and draft for its matches.
import * as vscode from 'vscode';
import type { PersonActor } from '../domain/staff/release';
import { WATCH_OUTPUTS } from '../domain/staff/obs/watches';
import type { StandingWatch, WatchState } from '../domain/staff/obs/watches';
import { OPEN_STAFF_ROOM_COMMAND, STAFF_COMMANDS } from '../domain/staff/commands';
import { configureWatchHosts, watchHostFor } from '../staff/watchHost';
import type { WatchHost } from '../staff/watchHost';
import { staffHostFor } from '../staff/staffHost';
import { askPerson, STAFF_IDENTITY_TEXT } from './staffCommands';
import type { StaffCommandArgs, StaffCommandContext } from './staffCommands';

type Register = (id: string, run: (args?: StaffCommandArgs) => Promise<void>) => void;

function projectRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function watchesOrSay(): WatchHost | undefined {
  const root = projectRoot();
  const host = root && staffHostFor(root) ? watchHostFor(root) : undefined;
  if (!host) void vscode.window.showInformationMessage('Open the project folder of a staff team first.');
  return host;
}

function describe(watch: StandingWatch): string {
  return [
    `${watch.title}`,
    `Serves ${watch.indicator} of ${watch.pir}; expires at its latest time of value, ${watch.ltiov}.`,
    `Matches: ${JSON.stringify(watch.condition)}`,
    `Alerts ${watch.alert.name} (${watch.alert.role}). May produce: ${watch.outputs.join(', ')}. Label ${watch.label}.`,
    'It only drafts: it never releases, approves or tasks collection, and it runs only while a staff run or the Staff Room is open.'
  ].join('\n');
}

/** Picks a watch in one of the states, or the one the Staff Room named. */
async function pickWatch(host: WatchHost, states: readonly WatchState[], title: string, args?: StaffCommandArgs): Promise<StandingWatch | undefined> {
  const read = await host.read();
  if (!read.ok) { void vscode.window.showWarningMessage(read.message); return undefined; }
  const choices = read.watches.filter((watch) => states.includes(watch.state));
  const wanted = (args as { watch?: unknown } | undefined)?.watch;
  if (typeof wanted === 'string') {
    const found = choices.find((watch) => watch.id === wanted);
    if (!found) void vscode.window.showWarningMessage(`${wanted} is not ${states.join(' or ')} now.`);
    return found;
  }
  if (!choices.length) { void vscode.window.showInformationMessage(`No standing watch is ${states.join(' or ')}.`); return undefined; }
  const picked = await vscode.window.showQuickPick(choices.map((watch) => ({ label: watch.id, description: `${watch.state}: ${watch.title}`, detail: `${watch.indicator} of ${watch.pir}; alerts ${watch.alert.name} (${watch.alert.role})` })), { title, placeHolder: 'Pick the watch' });
  return picked ? choices.find((watch) => watch.id === picked.label) : undefined;
}

async function confirm(question: string, detail: string, action: string): Promise<boolean> {
  return (await vscode.window.showWarningMessage(question, { modal: true, detail: `${detail}\n\n${STAFF_IDENTITY_TEXT}` }, action)) === action;
}

function show(outcome: { ok: true; text: string } | { ok: false; message: string }): void {
  if (outcome.ok) void vscode.window.showInformationMessage(outcome.text);
  else void vscode.window.showWarningMessage(outcome.message);
}

/** Registers the watch commands and the notice a person sees when a watch alerts them. */
export function registerWatchCommands(context: StaffCommandContext, identity: () => Promise<{ fingerprint: string }>, register: Register): void {
  configureWatchHosts({
    notify: (notice) => {
      void vscode.window.showInformationMessage(notice.text, 'Open Staff Room').then((answer) => { if (answer) void vscode.commands.executeCommand(OPEN_STAFF_ROOM_COMMAND); });
    }
  });
  context.subscriptions.push({ dispose: () => configureWatchHosts(undefined) });
  const person = async (role?: string): Promise<PersonActor | undefined> => askPerson(context, (await identity()).fingerprint, role);

  register(STAFF_COMMANDS.createWatch, async () => {
    const host = watchesOrSay();
    const staff = projectRoot() ? staffHostFor(projectRoot()!) : undefined;
    if (!host || !staff) return;
    const register_ = await staff.pirRegister();
    const pirs = 'entries' in register_ ? (register_.entries ?? []).filter((entry) => entry.status === 'approved' || entry.status === 'awaiting-decision' || entry.status === 'candidate') : [];
    if (!pirs.length) { void vscode.window.showInformationMessage('A watch serves a PIR and one of its indicators, and this project\'s PIR register has none open. The J2 adds PIRs with the intel workbench first.'); return; }
    const pir = await vscode.window.showQuickPick(pirs.map((entry) => ({ label: entry.id, description: entry.requirement, detail: `Supports ${entry.decisionPoint}; latest time of value ${entry.ltiov}` })), { title: 'Create a standing watch: the PIR it serves' });
    const entry = pir ? pirs.find((candidate) => candidate.id === pir.label) : undefined;
    if (!entry) return;
    if (!entry.indicators.length) { void vscode.window.showInformationMessage(`${entry.id} has no indicators yet.`); return; }
    const indicator = await vscode.window.showQuickPick(entry.indicators.map((item) => ({ label: item.id, description: item.text })), { title: 'The indicator it watches' });
    if (!indicator) return;
    const title = await vscode.window.showInputBox({ title: 'What it looks for, in one line', value: entry.indicators.find((item) => item.id === indicator.label)?.text ?? '', ignoreFocusOut: true } as vscode.InputBoxOptions);
    if (!title?.trim()) return;
    const area = await vscode.window.showInputBox({ title: 'Where: a named area of interest or other control measure id from the scenario (for example nai-3), or empty for anywhere', ignoreFocusOut: true } as vscode.InputBoxOptions);
    if (area === undefined) return;
    const grade = await vscode.window.showQuickPick([{ label: 'Any reliability' }, ...['A', 'B', 'C', 'D', 'E'].map((value) => ({ label: `Reliability ${value} or better` }))], { title: 'The weakest source it counts' });
    if (!grade) return;
    const ltiov = await vscode.window.showInputBox({ title: 'Latest time of value (YYYY-MM-DDTHH:MM:SS.sssZ); it expires then', value: entry.ltiov, ignoreFocusOut: true } as vscode.InputBoxOptions);
    if (!ltiov?.trim()) return;
    const ecoa = await vscode.window.showQuickPick([{ label: 'INTREP draft' }, { label: 'INTREP draft and adversary COA revision draft' }], { title: 'What a match drafts (a named person decides on every draft)' });
    if (!ecoa) return;
    const who = await person('J2');
    if (!who) return;
    const condition = {
      ...(area.trim() ? { area: { kind: 'control-measure', id: area.trim() } } : {}),
      ...(grade.label !== 'Any reliability' ? { grade: { minReliability: grade.label.slice('Reliability '.length, 'Reliability '.length + 1) } } : {})
    };
    const outputs = ecoa.label.includes('COA') ? ['draft-intrep', 'draft-ecoa-revision', 'mark-source-changed', 'alert-person'] : ['draft-intrep', 'mark-source-changed', 'alert-person'];
    const preview = `${title.trim()}\nServes ${indicator.label} of ${entry.id}; expires ${ltiov.trim()}.\nMatches: ${JSON.stringify(condition)}\nAlerts you. May produce: ${outputs.filter((output) => (WATCH_OUTPUTS as readonly string[]).includes(output)).join(', ')}.`;
    if (!(await confirm(`Create and arm this watch as ${who.name} (${who.role})?`, preview, 'Create and Arm'))) return;
    show(await host.create(who, { title: title.trim(), pir: entry.id, indicator: indicator.label, condition, ltiov: ltiov.trim(), outputs }));
  });

  register(STAFF_COMMANDS.armWatch, async (args) => {
    const host = watchesOrSay();
    if (!host) return;
    const watch = await pickWatch(host, ['proposed'], 'Arm a standing watch', args);
    if (!watch) return;
    const who = await person(watch.alert.role);
    if (!who) return;
    if (!(await confirm(`Arm ${watch.id} as ${who.name} (${who.role})?`, describe(watch), 'Arm'))) return;
    show(await host.arm(who, watch.id));
  });

  register(STAFF_COMMANDS.pauseWatch, async (args) => {
    const host = watchesOrSay();
    if (!host) return;
    const watch = await pickWatch(host, ['armed'], 'Pause a standing watch', args);
    if (!watch) return;
    const who = await person();
    if (!who) return;
    if (!(await confirm(`Pause ${watch.id} as ${who.name} (${who.role})?`, `${describe(watch)}\n\nWhile paused it counts and queues what it matches; only a person resumes it.`, 'Pause'))) return;
    show(await host.pause(who, watch.id));
  });

  register(STAFF_COMMANDS.resumeWatch, async (args) => {
    const host = watchesOrSay();
    if (!host) return;
    const watch = await pickWatch(host, ['paused'], 'Resume a standing watch', args);
    if (!watch) return;
    const who = await person();
    if (!who) return;
    if (!(await confirm(`Resume ${watch.id} as ${who.name} (${who.role})?`, `${describe(watch)}\n\nMissed while paused: ${watch.missedWhilePaused}. They are delivered as one match.`, 'Resume'))) return;
    show(await host.resume(who, watch.id));
  });

  register(STAFF_COMMANDS.acknowledgeWatch, async (args) => {
    const host = watchesOrSay();
    if (!host) return;
    const watch = await pickWatch(host, ['awaiting-review'], 'Acknowledge a standing watch\'s drafts', args);
    if (!watch) return;
    const who = await person(watch.alert.role);
    if (!who) return;
    const drafts = (watch.drafts ?? []).map((ref) => `${ref.product} v${ref.version}`).join(', ') || 'none';
    if (!(await confirm(`Acknowledge ${watch.id}'s drafts as ${who.name} (${who.role})?`, `Drafts: ${drafts}.\n\nAcknowledging arms the watch again. It does not approve or release any draft: each follows its own release path, decided with NEAR AI: Staff: Approve.`, 'Acknowledge'))) return;
    show(await host.acknowledge(who, watch.id));
  });

  register(STAFF_COMMANDS.retireWatch, async (args) => {
    const host = watchesOrSay();
    if (!host) return;
    const watch = await pickWatch(host, ['proposed', 'armed', 'paused', 'matched', 'drafting', 'awaiting-review'], 'Reject or retire a standing watch', args);
    if (!watch) return;
    const who = await person();
    if (!who) return;
    const reason = await vscode.window.showInputBox({ title: `Why ${watch.state === 'proposed' ? 'reject' : 'retire'} ${watch.id}?`, prompt: 'Required. It is kept with the signed record.', ignoreFocusOut: true } as vscode.InputBoxOptions);
    if (!reason?.trim()) return;
    if (!(await confirm(`${watch.state === 'proposed' ? 'Reject' : 'Retire'} ${watch.id} as ${who.name} (${who.role})?`, `${describe(watch)}\n\nIt never runs again. Drafts it made stay in the release state machine.`, watch.state === 'proposed' ? 'Reject' : 'Retire'))) return;
    show(await host.retire(who, watch.id, reason.split(/\s*;\s*/).filter(Boolean)));
  });
}
