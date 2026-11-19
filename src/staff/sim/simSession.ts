// One running simulation (WP-SIM): the scenario and its inject script read from disk, the timeline built once, the player on the real clock, and the
// loopback servers fed by it. The feed source events it writes are kept here so the feed picture can be drawn from them at any time; WP-OBS Store takes
// them into the staff event log at integration. No vscode: the command in services/staffSimCommand.ts drives it.
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { feedPicture } from '../../domain/staff/obs/events';
import type { FeedPictureModel, FeedSourceStateEvent } from '../../domain/staff/obs/events';
import { parseScenarioText } from '../../domain/staff/scenario';
import type { Scenario } from '../../domain/staff/scenario';
import { SIM_FEEDS, simLayers } from '../../domain/staff/sim/feeds';
import { SIM_BADGE, SIM_STATEMENT } from '../../domain/staff/sim/formats';
import { SimPlayer } from '../../domain/staff/sim/player';
import type { SimPerson, SimScheduler, SimStatus } from '../../domain/staff/sim/player';
import { parseInjectScript } from '../../domain/staff/sim/script';
import { buildSimTimeline } from '../../domain/staff/sim/timeline';
import type { SimMessage, SimTimeline } from '../../domain/staff/sim/timeline';
import { STARTER_SCENARIO_FILE } from '../../services/staffScenarioLoader';
import { SimServers } from './simServers';
import type { SimEndpoints, SimPorts } from './simServers';

/** The starter scenario's inject script, beside the scenario. */
export const STARTER_SCRIPT_FILE = path.join(__dirname, '..', '..', '..', 'resources', 'staff', 'scenarios', 'iron-lantern.sim.jsonl');

export const REAL_SCHEDULER: SimScheduler = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

/** Reads and checks a scenario and its inject script, and builds the timeline. Throws with a plain message on a bad file. */
export async function loadSimTimeline(scenarioFile = STARTER_SCENARIO_FILE, scriptFile = STARTER_SCRIPT_FILE): Promise<{ scenario: Scenario; timeline: SimTimeline }> {
  const scenario = parseScenarioText(await readFile(scenarioFile, 'utf8'));
  if (!scenario.ok) throw new Error(`The scenario could not be read: ${scenario.message}`);
  const script = parseInjectScript(await readFile(scriptFile, 'utf8'), scenario.value);
  if (!script.ok) throw new Error(`The inject script could not be read (line ${script.line}): ${script.message}`);
  return { scenario: scenario.value, timeline: buildSimTimeline(scenario.value, script.value) };
}

export class SimSession {
  readonly player: SimPlayer;
  readonly servers: SimServers;
  private readonly events: FeedSourceStateEvent[] = [];
  private endpointsValue: SimEndpoints | undefined;

  constructor(readonly timeline: SimTimeline, person: SimPerson, scheduler: SimScheduler = REAL_SCHEDULER) {
    this.player = new SimPlayer(timeline, scheduler, person);
    this.servers = new SimServers(timeline);
    this.player.onMessage((message) => this.servers.publish(message));
    this.player.onFeedEvent((event) => this.events.push(event));
  }

  /** Opens the loopback servers, then starts the clock. */
  async start(ports?: SimPorts): Promise<SimEndpoints> {
    this.endpointsValue = await this.servers.start(ports);
    const started = this.player.start();
    if (!started.ok) { await this.servers.stop(); throw new Error('The simulation could not start.'); }
    return this.endpointsValue;
  }

  async stop(): Promise<void> {
    this.player.stop();
    await this.servers.stop();
  }

  endpoints(): SimEndpoints | undefined { return this.endpointsValue; }
  status(): SimStatus { return this.player.status(); }
  feedEvents(): readonly FeedSourceStateEvent[] { return [...this.events]; }
  /** The feed picture from the feed events so far: every simulated source is marked simulated, which the picture shows as the SIM badge. */
  picture(): FeedPictureModel { return feedPicture(this.events); }
  onMessage(listener: (message: SimMessage) => void): void { this.player.onMessage(listener); }
  feeds(): typeof SIM_FEEDS { return SIM_FEEDS; }
}

/** The status bar text for a simulation status. */
export function simStatusText(status: SimStatus): string {
  const icon = status.state === 'running' ? '$(broadcast)' : status.state === 'paused' ? '$(debug-pause)' : '$(debug-stop)';
  const state = status.state === 'running' ? `${status.speed}x` : status.state === 'paused' ? (status.pausedFor === 'hold' ? 'held' : 'paused') : status.state;
  return `${icon} ${SIM_BADGE} ${state} ${status.scenarioTime}`;
}

/** The feed picture as text: every source and every layer the simulation feeds carries the SIM badge. */
export function feedPictureText(current: SimSession): string {
  const picture = current.picture();
  const lines = [`${SIM_BADGE}: ${SIM_STATEMENT}`, '', 'Feeds:'];
  for (const source of picture.sources) {
    const feed = current.feeds().find((entry) => entry.id === source.feed);
    lines.push(`  [${source.simulated ? SIM_BADGE : 'LIVE'}] ${feed?.title ?? source.feed} (${source.feed}): ${source.state}`);
  }
  lines.push('', `Map layers fed: ${simLayers().map((layer) => `[${SIM_BADGE}] ${layer}`).join(', ')}`);
  const endpoints = current.endpoints();
  if (endpoints) {
    lines.push('', 'Endpoints (this machine only):', `  CoT friendly tracks: ${endpoints.cotOwn}`, `  CoT spot reports and contacts: ${endpoints.cotIntel}`, `  AIS: ${endpoints.ais}`);
    for (const [outlet, url] of Object.entries(endpoints.rss)) lines.push(`  RSS ${outlet}: ${url}`);
    lines.push(`  Mock partner server (MCP): ${endpoints.partnerMcp}`);
  }
  return lines.join('\n');
}
