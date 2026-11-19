// NEAR AI: Staff Simulation commands (research note 11, 8; WP-SIM). Start replays Exercise IRON LANTERN as live feeds on loopback only (CoT, AIS, RSS
// and the mock partner server), Controls pauses, resumes, steps and sets the speed (0.5x, 1x, 2x, 4x), and Stop closes every server. A status bar item
// shows the SIM badge, the speed and the scenario clock; the output channel lists the endpoints and the feed picture, every source badged SIM.
import * as vscode from 'vscode';
import { SIM_BADGE, SIM_STATEMENT } from '../domain/staff/sim/formats';
import { SIM_SPEEDS } from '../domain/staff/sim/player';
import type { SimPerson } from '../domain/staff/sim/player';
import type { SimMessage } from '../domain/staff/sim/timeline';
import { feedPictureText, loadSimTimeline, SimSession, simStatusText } from '../staff/sim/simSession';
import { SimFeedRuntime } from '../staff/sim/feedRuntime';
import { observationStoreFor } from '../staff/observationStore';

export const STAFF_SIM_COMMANDS = {
  start: 'nearAi.staff.startSimulation',
  controls: 'nearAi.staff.simulationControls',
  stop: 'nearAi.staff.stopSimulation'
} as const;

/** The same key the staff decision commands keep the person's name and role under. */
const PERSON_KEY = 'nearAi.staff.person';

let session: SimSession | undefined;
let runtime: SimFeedRuntime | undefined;
let statusItem: vscode.StatusBarItem | undefined;
let output: vscode.OutputChannel | undefined;

/** The running simulation, if any: the feed picture and the COP read it. */
export function currentSimulation(): SimSession | undefined {
  return session;
}

/** The running simulation's feed runtime (the store ingest and its decay timer), if a project folder is open. */
export function currentFeedRuntime(): SimFeedRuntime | undefined {
  return runtime;
}

export function registerStaffSimulation(context: { subscriptions: Array<{ dispose(): unknown }>; globalState?: { get<T>(key: string): T | undefined } }): void {
  const run = (id: string, body: () => Promise<void>): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, async () => {
      try { await body(); } catch (error) { void vscode.window.showErrorMessage(`NEAR AI could not finish that: ${error instanceof Error ? error.message : String(error)}`); }
    }));
  };
  run(STAFF_SIM_COMMANDS.start, () => startSimulation(context));
  run(STAFF_SIM_COMMANDS.controls, () => simulationControls());
  run(STAFF_SIM_COMMANDS.stop, () => stopSimulation());
  context.subscriptions.push({ dispose: () => { void stopSimulation(); } });
}

async function startSimulation(context: { globalState?: { get<T>(key: string): T | undefined } }): Promise<void> {
  if (session && session.status().state !== 'stopped') {
    await simulationControls();
    return;
  }
  const stored = context.globalState?.get<{ name?: string; role?: string }>(PERSON_KEY);
  const person: SimPerson = { kind: 'person', name: stored?.name?.trim() || 'Presenter', role: stored?.role?.trim() || 'Exercise control', deviceFingerprint: 'this-window' };
  const { timeline, scenario } = await loadSimTimeline();
  const current = new SimSession(timeline, person);
  // The simulated streams go into the open project's observation store and its staff event log, so the J2 workspace shows them live.
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const store = root ? observationStoreFor(root) : undefined;
  runtime = store && scenario.region.frame ? new SimFeedRuntime(current, store, scenario.region.frame, person) : undefined;
  runtime?.attach();
  output ??= vscode.window.createOutputChannel('NEAR AI Staff Simulation');
  statusItem ??= vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusItem.command = STAFF_SIM_COMMANDS.controls;
  statusItem.tooltip = `${SIM_STATEMENT} Click for the simulation controls.`;
  let lastText = '';
  current.player.onStatus((status) => {
    const text = simStatusText(status);
    if (statusItem && text !== lastText) { statusItem.text = text; lastText = text; }
  });
  current.onMessage((message) => onMessage(message));
  session = current;
  await current.start();
  statusItem.show();
  output.clear();
  output.appendLine(feedPictureText(current));
  output.appendLine(runtime ? '' : 'No project folder is open, so the reports are not kept in an observation store.');
  output.show(true);
  void vscode.window.showInformationMessage(`Simulation started on this machine only, every feed marked ${SIM_BADGE}. It holds at the mid-demo report.`, 'Controls')
    .then((pick) => { if (pick) void simulationControls(); });
}

function onMessage(message: SimMessage): void {
  if (message.stream === 'marker') {
    output?.appendLine(`[${message.scenarioTime}] Beat ${message.beat}: ${message.title}`);
    if (message.hold) {
      void vscode.window.showInformationMessage(`${SIM_BADGE} held at beat ${message.beat}, ${message.title}: the mid-demo report has landed. Run the beat, then resume.`, 'Resume', 'Step')
        .then((pick) => { if (pick === 'Resume') session?.player.resume(); else if (pick === 'Step') session?.player.step(); });
    }
  } else if (message.stream === 'rss' || message.stream === 'partner' || message.stream === 'cot-intel') {
    output?.appendLine(`[${message.scenarioTime}] ${SIM_BADGE} ${message.stream}: ${message.inject}`);
  }
}

async function simulationControls(): Promise<void> {
  const current = session;
  if (!current || current.status().state === 'stopped') {
    const pick = await vscode.window.showInformationMessage('No simulation is running.', 'Start');
    if (pick) await vscode.commands.executeCommand(STAFF_SIM_COMMANDS.start);
    return;
  }
  const status = current.status();
  const items: Array<vscode.QuickPickItem & { act: () => unknown }> = [];
  if (status.state === 'running') items.push({ label: '$(debug-pause) Pause', act: () => current.player.pause() });
  if (status.state === 'paused') {
    items.push({ label: '$(debug-continue) Resume', act: () => current.player.resume() });
    items.push({ label: '$(debug-step-over) Step', description: 'Release the next reports and stay paused', act: () => current.player.step() });
  }
  if (status.state === 'running' || status.state === 'paused') {
    for (const speed of SIM_SPEEDS) {
      if (speed !== status.speed) items.push({ label: `$(dashboard) Speed ${speed}x`, act: () => current.player.setSpeed(speed) });
    }
  }
  items.push({ label: '$(list-unordered) Show the feed picture and endpoints', act: () => { output?.appendLine(''); output?.appendLine(feedPictureText(current)); output?.show(true); } });
  items.push({ label: '$(debug-stop) Stop the simulation', act: () => stopSimulation() });
  const pick = await vscode.window.showQuickPick(items, { title: `${SIM_BADGE} simulation: ${simStatusText(status).replace(/\$\([a-z-]+\) /, '')}`, placeHolder: `${status.emitted} of ${status.total} messages released${status.beat ? `; beat ${status.beat.beat}, ${status.beat.title}` : ''}` });
  await pick?.act();
}

async function stopSimulation(): Promise<void> {
  const current = session;
  session = undefined;
  if (!current) return;
  await current.stop();
  const feeds = runtime;
  runtime = undefined;
  if (feeds) {
    await feeds.detach();
    output?.appendLine(`Observation store: ${feeds.counts.appended} report(s) kept, ${feeds.counts.duplicates} repeated, ${feeds.counts.refused} refused.${feeds.counts.problems.length ? ` First problem: ${feeds.counts.problems[0]}` : ''}`);
  }
  statusItem?.hide();
  output?.appendLine('Simulation stopped. Every loopback server is closed.');
}
