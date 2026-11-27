import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { RunCheckpoints } from '../agent/checkpoints';
import { compactConversation, contextAction, contextStatus, DEFAULT_COMPACT_AT_TOKENS, DEFAULT_CONTEXT_WINDOW, DEFAULT_THRESHOLDS, estimateTokens, trimOldToolResults } from '../agent/context';
import type { GateHost } from '../gate/host';
import { currentSessionRoute, defaultSessionRoute, routeEventRecordFor, sessionRouteFrom, withPrivateOnly, withSessionRoute } from '../gate/sessionMark';
import type { AnswerCheckListener, AnswerCheckResult, RouteAttestation, SessionRoute } from '../gate/sessionMark';
import { approveFloorCallLate, endFloorApprovals, recordLateApproval, unavailableGateRuntime } from '../agent/gateAdapter';
import { projectLabelOf, scalesOf } from '../agent/gateLabels';
import { OutboundFingerprints } from '../agent/outboundCheck';
import { SessionMark } from '../domain/gate/dominance';
import type { Mark } from '../domain/gate/dominance';
import { SHIPPED_DEFAULT_LABEL } from '../domain/gate/bundle';
import { activeScales, labelKeyShown } from '../domain/gate/labelAlgebra';
import { STAFF_PRIVATE_MODELS_TEXT } from '../domain/staff/products';
import type { Label } from '../domain/gate/labels';
import { isDefaultMark } from '../gate/sessionMark';
import { chatLabelOf } from './threadStore';
import { noteChatProjectMark } from '../domain/gate/lowerings';
import type { GateRuntime } from '../domain/gate/decide';
import { AgentEvent, AgentRun, AgentRunError, ApprovalReply, ApprovalRequest, AWAITING_APPROVAL_PREFIX, DEFAULT_MAX_TURNS, DEFAULT_TURN_CEILING_MS, RunInput, RunOutcome, RunResult } from '../agent/loop';
import { countersOf, runSplitOf } from './activityOverview';
import { PermissionRules, RunGrants } from '../agent/permissions';
import { SafetyModelCheck } from '../agent/safetyModel';
import { ShellSession } from '../agent/shell';
import { agentSystemPrompt, projectInstructions } from '../agent/systemPrompt';
import { GRAPHICS_TOOLS } from '../agent/graphicsTools';
import { grantsMcpTool } from '../mcp/tools';
import { staffLeadNote } from '../agent/staffLead';
import { staffServerToolsForRun } from '../agent/staffServers';
import { OBSERVATIONS_TOOL_NAMES } from '../agent/observationsTools';
import { checkCitationsTool, checkOriginalityTool, webFetchTool, webSearchTool } from '../agent/webTools';
import type { SearchProvider } from '../agent/webSearch';
import { SecurityAccess, securityTool } from '../agent/securityTool';
import { AgentTool, CORE_TOOLS, offeredTools, Todo, ToolContext } from '../agent/tools';
import type { CyberRunAccess } from './cyberRun';
import { TaskBoard, endsWithQuestion } from '../agent/taskBoard';
import { displayPath, resolveInWorkspace, ToolError } from '../agent/workspace';
import { AgentWorktree, createAgentWorktree, finishAgentWorktree, worktreeReport } from '../agent/worktree';
import type { ActionPolicy } from '../domain/policy';
import { agentModelFor, expandPrompt, fallbackModelsFor, GsdAgent, GsdSkill, PrivacyCandidate, privateModelFor, roleModelFor, tierOf } from '../gsd/library';
import { failureReason, modelDisplayName, ModelTrouble, switchNotice } from '../agent/modelFallback';
import { trustedPreambles } from '../gsd/preamble';
import { gsdTools, Question } from '../gsd/tools';
import type { ActivityFeed, AgentBoundary, AgentPhase } from './agentActivity';
import type { ActivityStore } from './activityStore';
import { saveHandoff } from './handoff';
import { homeFolder, teamLibraryDir } from '../domain/teamStorage';
import { SCRATCH_INSTRUCTIONS } from '../domain/scratch';
import { AGENT_DEFAULTS } from '../domain/agentDefaults';
import { WAITING_INSTRUCTIONS, checkNowMessage, isCheckNow } from '../domain/checkNow';
import { cleanScratch } from './scratch';
import { scriptsNamedIn } from '../agent/unattended';
import { planCheckSkip, researchProfileActive } from '../gsd/researchProfile';
import type { AgentMessage, ModelInfo, NearAiClient, UsageMetadata } from './nearAiClient';
import { contentKey, commandForm } from '../domain/state/threadCapture';
import { entriesToMessages, entriesToView, type ViewItem } from '../domain/state/threadView';
import { ThreadStore } from './threadStore';
import type { ConversationStore, Transcript } from './transcripts';
import type { RunEnd, RunMarkers } from './runMarkers';
import { NOT_CHECKED_IN_EDITOR, type ResponseEvidence } from './attestation';
import { trustDetailsOf } from './trustDetails';
import { BADGE_CHECK_TIMEOUT_MS, TRUST_BADGE_TEXT, trustBadgeFor, trustBadgeFromRecord, trustRecordKey, trustRecordOf, type TrustBadge, type TrustBadgeFacts, type TrustVerification } from '../domain/gate/trustBadge';
import { PreparedAttachments, StagedAttachment } from '../agent/attachments';
import { imageTool, ImageDraft, ImageDraftEntry, ImageReviewDecision, ImageReviewer, memoryPreamble, memoryTools } from '../agent/extraTools';
import { cleanOldDrafts, DRAFT_ID, draftFile } from '../agent/imageDrafts';
import { TeamDefinition, teamLeadPrompt, teamMembersNote } from '../agent/teams';
import { knowledgeTools } from '../agent/knowledgeTools';
import { addKnowledge, KNOWLEDGE_INSTRUCTIONS, loadKnowledge } from './teamKnowledgeStore';
import { teamKnowledgeKey } from '../agent/teams';
import type { MemoryScope } from '../domain/contextGraph';
import type { AgentRole } from '../domain/agents';
import type { ContextGraphMemory } from './contextGraphMemory';
import type { ReputationStore } from './reputation';
import { SpendAccount } from './spendAccount';
import { nanoToUsd, totalNanoUsd, withSpendTag } from './spendLedger';
import { staffTeamInfo, staffTools, WRITE_LIMITED_STAFF_TOOLS } from '../agent/staffTools';
import { staffHostFor } from '../staff/staffHost';
import { storeInstitutionalDraft, verifyInstitutionalDraftTarget } from '../staff/institutionalDraftStore';
import { institutionalChildTools, selectedTeamAgents } from '../agent/staff/institutionalCommand';
import { observationStoreFor } from '../staff/observationStore';
import { attend } from '../staff/watchAttendance';
import { watchHostFor } from '../staff/watchHost';
import { privateRefusal, routeAllows, type PrivateRoute } from './privateRoute';
import { answerFactsOf, type AnswerFacts } from './answerFacts';

/** What the installed Open-GSD runtime provides to a conversation. */
export interface GsdContext {
  home: string;
  skills: GsdSkill[];
  agents: GsdAgent[];
  shellEnv: NodeJS.ProcessEnv;
}

export interface ModelTiers { deep: string; standard: string; fast: string }

export interface AgentTurnRequest {
  /** What the user typed, shown in the transcript. */
  text: string;
  /** Run an installed skill: its expanded instructions become the turn's prompt. */
  skill?: { name: string; args: string };
  client: NearAiClient;
  model: string;
  privacy: string;
  policy: ActionPolicy;
  rules: PermissionRules;
  activity?: { store: ActivityStore; sessionId: string };
  /** A local runtime has no billing API to ask for actual costs. */
  local?: boolean;
  gsd?: GsdContext;
  /** NEAR models for GSD's model tiers; a tier model the provider lacks falls back to `model`. */
  tiers?: ModelTiers;
  availableModels?: string[];
  /** The catalog entries of availableModels, with where each runs; a `privacy: private` team member is resolved against it. */
  modelCatalog?: PrivacyCandidate[];
  /**
   * Which client `client` is: NEAR AI Cloud (`attestation` true only for NEAR's own endpoint, where a TEE model's attestation can be
   * checked) or a local runtime. A private member runs only on a model of this route's own private kind; without it, none runs.
   */
  route?: PrivateRoute;
  /** The model's context window in tokens, from the catalog. */
  contextWindows?: Record<string, number | undefined>;
  maxParallelAgents?: number;
  maxTurns?: number;
  /** Run a team: a lead agent delegates `text` to the team's members. */
  team?: TeamDefinition;
  /** 0.4.21: the team this run works with, not led: its members can be spawned and are preferred for work their roles cover. */
  memberTeam?: TeamDefinition;
  /** Attachments already read (text inlined, images described, audio transcribed). */
  attachments?: PreparedAttachments;
  /** Project memory: relevant facts start each turn, and Remember/Recall are available. */
  memory?: { store: ContextGraphMemory; projectScope: MemoryScope };
  /** The provider's image model, when it has one; enables GenerateImage. */
  imageModel?: ModelInfo;
  /** The other models on this key that output images; GenerateImage may be asked to use one of them instead of imageModel. */
  imageModels?: ModelInfo[];
  /**
   * 0.4.23 (nearAi.agent.imageReview): "ask", the default, saves each generated image as a draft and waits for the person to accept it, ask for changes
   * or discard it before anything reaches the path; "off" writes it straight to the path as before. The wait is the same in every approval mode, as
   * AskUserQuestion's is: nothing reaches the path unless the person accepts it.
   */
  imageReview?: 'ask' | 'off';
  reputation?: ReputationStore;
  /** Dependency vulnerability checks for the SecurityScan tool. */
  security?: SecurityAccess;
  /**
   * A cybersecurity run: the cyber tools attach to this turn only (D-02, the security-tool
   * precedent). Ordinary chat never carries them.
   */
  cyber?: CyberRunAccess;
  /** The WebSearch tool's provider; without one, WebSearch says search is not set up. */
  webSearch?: SearchProvider;
  /** Added after a GSD skill's instructions (e.g. the project's red-team stage). */
  skillAddendum?: string;
  /** Project team members a GSD workflow may spawn by name (e.g. red-team). */
  projectAgents?: GsdAgent[];
  /** Tools of the MCP servers switched on for this project. */
  mcpTools?: AgentTool<any>[];
  /** Caps for the whole run (the agent and all its sub-agents), checked before every model turn. */
  budget?: { maxCostUsd: number; maxTokens: number };
  /** Environment variables to pass to the agent's shell even though they look like credentials. */
  shellEnvAllow?: string[];
  /** Output tokens one reply may use (nearAi.agent.maxOutputTokens). */
  maxOutputTokens?: number;
  /** The auto mode's private safety model; without one, commands the rules cannot decide ask. */
  safetyModel?: string;
  /** A second private model for the safety check, asked when the first is busy or gives no readable answer. */
  safetyFallbackModel?: string;
  /** 0.4.17: the kinds of risk this project has already allowed, so the same kind is not asked about twice. */
  riskSwitches?: { outsideWorkspace: boolean; installs: boolean };
  /** Saves an approval card's "always allow" entry to the workspace allow list. */
  rememberAllowRule?(rule: string): void | Promise<void>;
  /** PERF-06: the research profile's plan-checker gate (nearAi.gsd.researchProfile, default on). */
  researchProfile?: boolean;
  /** PERF-03: how long a model turn may stream nothing (before its first token, or between chunks) before it is retried on `backupModel` (0: off). */
  modelStallMs?: number;
  /** PERF-03: the model a stalled turn is retried on (at least as private as the chat's model). */
  backupModel?: string;
  /** TEE-only mode (nearAi.privacyMode): a sub-agent's fallback model must run in a NEAR TEE or on this machine too. */
  teeOnly?: boolean;
  /** PERF-01: sub-agents' safe and verification commands run without a card in auto and mostly-autonomous (nearAi.agent.unattendedAutoApprove, default on). */
  unattendedAutoApprove?: boolean;
  /** Model or tier per agent role (nearAi.agent.roleModels); a team member's own model line wins. */
  roleModels?: Record<string, string>;
  /** The run's ID, when the host already tagged spend for it (attachments read before the run). */
  runId?: string;
}

/** The spend account of a client, when spend tracking is on for it. */
/**
 * A staff team member's lane on the step board (design 10, 4.5): `staff.lane.started` when it starts and `staff.lane.finished` when it ends. Only for a
 * member of a staff section team; a lane that cannot be recorded never stops the agent.
 */
function staffLane(request: Pick<AgentTurnRequest, 'team'>, root: string, run: string, member: string, teamMember: boolean, status: 'started' | 'done' | 'failed' | 'cancelled', reason?: string): void {
  const team = request.team ? staffTeamInfo(request.team) : undefined;
  const host = team && teamMember && team.members.includes(member) ? staffHostFor(root) : undefined;
  if (!team || !host) return;
  const at = new Date().toISOString();
  const event = status === 'started'
    ? { type: 'staff.lane.started' as const, run, at, section: team.section, member }
    : { type: 'staff.lane.finished' as const, run, at, section: team.section, member, outcome: status, ...(status === 'failed' && reason ? { reason: reason.slice(0, 300) } : {}) };
  void host.record(event).catch(() => undefined);
}

/** A staff team member moved to its next model (overloaded or silent at NEAR AI): the Staff Room's activity says so in words. */
function staffSwitch(request: Pick<AgentTurnRequest, 'team'>, root: string, run: string, member: string, teamMember: boolean, from: string, to: string, reason: string): void {
  const team = request.team ? staffTeamInfo(request.team) : undefined;
  const host = team && teamMember && team.members.includes(member) ? staffHostFor(root) : undefined;
  if (!team || !host) return;
  void host.record({ type: 'staff.lane.switched', run, at: new Date().toISOString(), section: team.section, member, from: modelDisplayName(from), to: modelDisplayName(to), reason: reason.slice(0, 300) }).catch(() => undefined);
}

export function spendAccountOf(client: unknown): SpendAccount | undefined {
  const spend = (client as { spend?: unknown } | undefined)?.spend;
  return spend instanceof SpendAccount ? spend : undefined;
}

type Record_ = (event: Parameters<ActivityStore['append']>[1]) => Promise<unknown>;

interface LiveAgent {
  id: string;
  label: string;
  description: string;
  model: string;
  abort: AbortController;
  paused: boolean;
  resume?: () => void;
  background: boolean;
  /** What it is doing now, for the agents strip and progress lines. */
  activity: string;
  activitySince: number;
  /** The last tool it ran, shown while it thinks about the result. */
  lastAction?: string;
  startedAt: number;
  toolCalls: number;
  turns: number;
  /** The sub-agent's own TodoWrite list, shown as steps in its row (not in the main task list). */
  todos?: Todo[];
}

/** A sub-agent's task list as its row shows it: done of total, and the step in progress. */
export function agentSteps(todos: Todo[]): { done: number; total: number; active?: string } {
  const active = todos.find((todo) => todo.status === 'in_progress');
  return { done: todos.filter((todo) => todo.status === 'completed').length, total: todos.length, ...(active ? { active: active.activeForm || active.content } : {}) };
}

/**
 * A message the user sent while a run was going. 0.4.21: it can carry the files attached to it, already read (`attachments`), so they reach the agent
 * in the same message as the words that refer to them; `staged` keeps the originals so a message handed back by Stop gets its attachments back too.
 */
export interface SteerMessage { id: string; text: string; attachments?: PreparedAttachments; staged?: StagedAttachment[] }

/** How a message sent during a run reaches the agent: marked, so it knows it is new direction. */
export function steeringContent(text: string): string {
  // 0.4.19: a "Check now" message is not new direction, it is a request to look at the real state again, so it is wrapped as that. Left as ordinary
  // direction it reads like a plan change, and the agent may answer it instead of polling, which is the wait this button exists to end.
  if (isCheckNow(text)) return `<check-now>\n${text}\n</check-now>\nThis is not a change of plan. Stop waiting and look at the real state now, then carry on from what you find.`;
  return `<user-message-during-run>\n${text}\n</user-message-during-run>\nThe user sent this while you were working. It is new direction: it takes precedence over your current plan, so adjust what you are doing (or stop and answer) and say briefly how you changed course.`;
}

/** The workspace's HEAD commit, or undefined when it is not a git repository (or git is missing). */
const headCommit = (root: string): Promise<string | undefined> => new Promise((resolve) => {
  execFile('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: root, timeout: 10_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, stdout) => resolve(error ? undefined : String(stdout).trim() || undefined));
});
/** The text of the last assistant message in a transcript, or an empty string when there is none. */
const lastAssistantText = (transcript: AgentMessage[]): string => { for (let index = transcript.length - 1; index >= 0; index -= 1) { const message = transcript[index]; if (message.role === 'assistant') return message.content ?? ''; } return ''; };
/** Tool capabilities that change files or run programs: an agent with a write limit keeps none of them except Write and Edit, which check the limit. */
const WRITING_CAPABILITIES: ReadonlySet<string> = new Set(['workspaceWrite', 'sharedWrite', 'shell', 'mediaGeneration', 'mediaPublication']);
const minutesSince = (at: number) => { const seconds = Math.max(0, Math.round((Date.now() - at) / 1000)); return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)} min`; };

export { routeAllows, type PrivateRoute } from './privateRoute';
export { answerFactsOf } from './answerFacts';
/**
 * One sidebar conversation with the agent. Keeps the message history (saved locally so it can be
 * resumed) and a persistent shell, routes approvals and questions to the webview, runs GSD skills
 * and sub-agents (foreground or background, with pause/stop and a concurrency limit), manages the
 * context window, and keeps each run's file checkpoints so the user can revert it.
 */

/** Where a chat whose stored label cannot be read opens: the default scale's highest level, never lower than it was (edge CLAS-04 encoding). */
export const UNREADABLE_CHAT_LABEL: Label = Object.freeze({ scale: 'org', level: 'Restricted', compartments: [], releasability: [], handling: [] });

/** Said when a lowering was overtaken by a sync that raised the chat's label on another copy meanwhile (PR #87 review). */
export const LOWERING_OVERTAKEN_TEXT =
  "This chat's label was raised on another copy while you lowered it here, so it keeps the higher label. Run SovAI: Lower This Chat's Label again if what it read now allows it.";

/** Said when a chat's stored label cannot be read. */
export const UNREADABLE_CHAT_LABEL_TEXT =
  "This chat's saved label could not be read, so it opens at Organization: Restricted and its content stays on this computer. If you know it holds nothing that sensitive, use SovAI: Lower This Chat's Label.";

/** The chat panel's conversations still open, so the window's shutdown can close them (PR #95 review round 3). */
const openConversations = new Set<AgentConversation>();
/** Conversations being closed, until each has written what it was writing. */
const closingConversations = new Set<Promise<void>>();

/** Registers a conversation of the chat panel, so closeAllConversations reaches it when the window shuts down. */
export function trackConversation(conversation: AgentConversation): void { openConversations.add(conversation); }

/**
 * The one way the chat panel closes a conversation (a closed tab, a closed panel or view): nothing more is posted or written for it, and the badge record
 * it was writing finishes; the window's shutdown waits for that too.
 */
export function closeConversation(conversation: AgentConversation): Promise<void> {
  openConversations.delete(conversation);
  const done: Promise<void> = conversation.close().catch(() => undefined).finally(() => { closingConversations.delete(done); });
  closingConversations.add(done);
  return done;
}

/** Closes every conversation still open and waits, at most `timeoutMs`, for every one being closed to finish its last write (the window's shutdown). */
export async function closeAllConversations(timeoutMs = 1_000): Promise<void> {
  for (const conversation of [...openConversations]) void closeConversation(conversation);
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([Promise.all([...closingConversations]), new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); timer.unref?.(); })]);
  if (timer !== undefined) clearTimeout(timer);
}

/** How many lead answers keep their badge's facts and check result in memory, so Check again and Show full attestation can use them (CLAS-08). */
export const TRUST_ENTRIES_KEPT = 20;
/** How many runs' last shown badges are kept: as many answers as the page keeps. */
const SHOWN_BADGES_KEPT = 50;
/** How many failed checks a chat keeps for Check again. Failures are few: the first one at an attested level stops further requests at that level. */
export const FAILED_CHECKS_KEPT = 100;

/** Said by Check again when the chat's stop holds a failure no longer kept for checking (PR #89 review). */
export const CHECK_AGAIN_NEW_CHAT_TEXT =
  'An earlier failed check in this chat can no longer be checked again from the editor, so the levels that need an attested cloud stay stopped for this chat. Start a new chat to send content at those levels to NEAR AI Cloud again.';

/** One lead answer's badge: the facts it is chosen from, its check as far as it got, and what Check again needs. */
interface BadgeEntry {
  /** The chat the answer belongs to, and the answer's text: where and under which key its settled badge is kept (plan 27). */
  readonly thread: string;
  readonly answerText: string;
  readonly model: string;
  readonly client: NearAiClient;
  readonly evidence: ResponseEvidence | undefined;
  readonly facts: AnswerFacts;
  /** When the answer finished (ms since the epoch): the attestation tab's title shows it. */
  readonly answeredAt: number;
  verification: TrustVerification;
  result?: AnswerCheckResult;
}

export class AgentConversation {
  private messages: AgentMessage[] = [];
  /**
   * The chat's one attestation state (CLAS-06, D-55): every session route this conversation builds (its runs, their sub-agents, its attachment reads)
   * shares it, so an answer check that fails stops attested-cloud for the chat and its helpers alike. A new chat or a reopened one gets a fresh state, and
   * the old one is marked closed, so a check that settles late sets nothing on the chat that replaced it.
   */
  private chatAttestation: RouteAttestation = { failed: false };
  /** Set once this chat has said where staff teams' private models come from (coherence review S5): once per chat. */
  private staffModelsTold = false;
  public get routeAttestation(): RouteAttestation { return this.chatAttestation; }
  /** The results of the checks after each run's attested-cloud answers (D-36, D-55), by run id, the newest 50, with the run's route. */
  private readonly answerChecks = new Map<string, { route: SessionRoute; results: Map<string, AnswerCheckResult> }>();
  /**
   * The chat ids of this chat's failed answer checks that no Check again has passed yet (PR #89 review). Kept for the whole chat, apart from the newest-50
   * list above, so a failure whose run has left that list still holds the stop. Failures are few, since the first one stops further requests at that level.
   */
  private uncheckedFailures = new Set<string>();
  /**
   * What Check again needs for each of those failures (PR #89 review): the answer's run, model, hashes, client and route, kept for the whole chat apart from
   * the newest-50 list, so Check again on a failed answer whose run has left that list can still clear it. Bounded at FAILED_CHECKS_KEPT; a failure dropped
   * past the bound still holds the stop, and Check again then says plainly that a new chat is needed.
   */
  private routeFailures = new Map<string, { runId: string; model: string; evidence: ResponseEvidence; client: NearAiClient; route: SessionRoute }>();
  /**
   * The trust badge's own failed checks (CLAS-08) of answers the route did not check (at any-cloud), by chat id, for the whole chat, the newest
   * FAILED_CHECKS_KEPT. They set no stop, but every later badge of the chat says an earlier check failed until Check again on that answer passes.
   */
  private badgeFailures = new Map<string, { runId: string; model: string; evidence: ResponseEvidence; client: NearAiClient }>();
  /**
   * How many of the badge's failed checks were dropped past FAILED_CHECKS_KEPT (PR #95 review). They can no longer be checked again, but they still count:
   * every later badge of the chat stays Not verified and says a new chat is needed.
   */
  private droppedBadgeFailures = 0;
  /**
   * The chat's high-water mark (CLAS-04, D-29, D-54): set at the project's resolved label when the chat's first run starts (or at its stored mark when it
   * was reopened), raised by what any of its agents read, and read by every session route of the chat before each model request. It only rises; the
   * person's Lower This Chat's Label is the one way down.
   */
  private chatMark: SessionMark | undefined;
  /** Set by prepareLowering for the one change the person's lowering makes. */
  private pendingLowering: { readonly lowering: unknown; readonly from?: Mark } | undefined;
  /** Stops saving and showing the current mark's changes (a new chat or a reopened one replaces the mark). */
  private stopMarkListener: (() => void) | undefined;
  /** The policy's default label as the last run read it: the chat's label is shown only above it (D-33). */
  private defaultLabel: Label = SHIPPED_DEFAULT_LABEL;
  /** The fingerprints of the labelled text this chat's agents read (D-60): in memory beside the mark, shared with sub-agents, never on record. */
  private outboundPrints = new OutboundFingerprints();
  public get outbound(): OutboundFingerprints { return this.outboundPrints; }
  /** Told the chat's mark whenever it changes, and undefined for a new chat (the status bar shows the label of the chat in view, D-33). */
  public onLabelChange: ((mark: Mark | undefined) => void) | undefined;
  /** Each lead answer's trust badge and what it was chosen from, by run id, the newest TRUST_ENTRIES_KEPT (Check again and Show full attestation use them). */
  private readonly verifiable = new Map<string, BadgeEntry>();
  /** Which run last wrote each badge record key in this window, so a newer result of the same answer replaces its own record (plan 27). */
  private readonly trustWriters = new Map<string, string>();
  /** The badge record writes, one after another so they land in order. */
  private trustWrites: Promise<void> = Promise.resolve();
  /** The badge last shown for each run, the newest SHOWN_BADGES_KEPT (as many answers as the page keeps), so Check again on one no longer kept says so. */
  private readonly shownBadges = new Map<string, TrustBadge>();
  /**
   * Set by dispose (PR #95 CI): no badge record is written after it, a record queued before it is dropped, and close() waits for the one already being
   * written, so nothing reaches the thread store once the conversation is closed.
   */
  private disposed = false;
  /** The badge timeouts still running, cleared when the chat is replaced or closed. */
  private readonly badgeTimerHandles = new Set<unknown>();
  /** The timer the badge's check waits on (D-56); a test gives its own clock. A timer never keeps the extension host alive. */
  public badgeTimers: { set(run: () => void, ms: number): unknown; clear(handle: unknown): void } = {
    set: (run, ms) => { const handle = setTimeout(run, ms); handle.unref?.(); return handle; },
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
  };
  /** What the user typed, keyed by a hash of the message the model saw (survives compaction). */
  private display = new Map<string, string>();
  /** Messages already written to the thread log (D-07). A message is logged once, before the model's context can replace it with a trimmed copy or a summary. */
  private readonly logged = new WeakSet<AgentMessage>();
  private conversationId = newConversationId();
  private title = '';
  /** The team the newest /team run of this conversation led (0.4.21); kept through compaction, which summarizes the message that named it. */
  private teamSlug: string | undefined;
  /** The team the current run leads or works with (its /team:, or the team a workflow works with), so the agents strip offers Watch the team. */
  private runTeamSlug: string | undefined;
  /** The team note this conversation's model has in context (its full text, so an edited team is sent again), so it is sent once rather than every turn. */
  private notedTeam: string | undefined;
  private shell: ShellSession | undefined;
  private shellEnvAllow: string[] = [];
  private shellEnvKey = '';
  private abort: AbortController | undefined;
  private readonly approvals = new Map<string, (reply: ApprovalReply, cancelled?: boolean) => void>();
  private readonly questions = new Map<string, (answers: string[], cancelled?: boolean) => void>();
  /** 0.4.23: generated images waiting for the person's review, by draft id. */
  private readonly imageReviews = new Map<string, (reply: ImageReviewDecision, cancelled?: boolean) => void>();
  /** The drafts and attempt counts of this conversation's image reviews, kept across its runs so edit_of and attempt numbers carry over. */
  private readonly imageReviewState = { drafts: new Map<string, ImageDraftEntry>(), attempts: new Map<string, number>() };
  /** Approvals and questions waiting for the user, oldest first, as they were posted (replayed when the view reloads). */
  private readonly waiting = new Map<string, Record<string, unknown>>();
  /** Told how many prompts are waiting whenever that changes, so the host can badge the view. */
  public onWaitingChange: ((count: number) => void) | undefined;
  /** Told each time a running run's state was saved (before a model turn, after a finished call): a quiet point at which project sync may run. */
  public onRunStateSaved: (() => void) | undefined;
  /** Records each run's start, steps, and end, so a run the extension host never finished can be reported and resumed. */
  public runMarkers: RunMarkers | undefined;
  private readonly runs = new Map<string, RunCheckpoints>();
  private readonly agents = new Map<string, LiveAgent>();
  /** 0.4.28: agents asked for that wait for a slot, so Pause and Stop reach them too (Agent Activity and Team Live show them). */
  private readonly queuedAgents = new Map<string, LiveAgent>();
  private readonly background = new Set<Promise<void>>();
  private notifications: AgentMessage[] = [];
  /**
   * 0.4.28: the reports of background agents a running sub-agent started, kept for that sub-agent (which reads them at its next turn and waits for the
   * rest before it ends), and its helpers still running. Before, every report went to the run's lead, which had not asked for them.
   */
  private readonly inboxes = new Map<string, { reports: AgentMessage[]; pending: Set<Promise<void>> }>();
  /** The main run's task list; sub-agents started for one of its items move that item along. */
  private readonly tasks = new TaskBoard();
  /** Messages the user sent while a run was going, oldest first, until a model request takes them. */
  private steering: SteerMessage[] = [];
  /** The running main run's taint flag, extra usage and agent id, so attachments that arrive with a message during the run count as they would at its start. */
  private steerRun: { grants: RunGrants; extraUsage: UsageMetadata[]; mainId: string } | undefined;
  /** Called with the messages Stop hands back to the composer, so the host can put their attachments back too. */
  public onReturned: ((items: SteerMessage[]) => void) | undefined;
  private readonly steerListeners = new Set<(notice: { interrupt: boolean }) => void>();
  private slotWaiters: Array<() => void> = [];
  private slotsInUse = 0;
  private contextWarned = false;
  /** The critical-level notice that summarizing could not free space was shown; it is shown once until a summary succeeds. */
  private contextFullWarned = false;
  private agentsTimer: ReturnType<typeof setTimeout> | undefined;
  private lastVisibleAt = Date.now();
  private heartbeats = 0;
  /** A progress line after this long without visible output, then at the longer interval while it stays quiet. */
  public progressTiming = { firstMs: 60_000, everyMs: 120_000, checkMs: 15_000 };
  /** Estimated cost and tokens of the current run, across the agent and its sub-agents. */
  /** The current run's auto-mode safety check, shared with its sub-agents. */
  private runSafety: SafetyModelCheck | undefined;
  /** When the current run started: a script any of its agents wrote since then never runs without a card. */
  private currentRunStartedAt = 0;
  /** The commit the workspace was on when the current run started, if it is a git repository. */
  private currentBaseCommit: string | undefined;
  /** The current run's main agent id, for the activity feed's idle time (PERF-07). */
  private mainAgentId: string | undefined;
  private spend = { costUsd: 0, tokens: 0, totalTokens: 0, cachedTokens: 0, stopped: false };
  /** The current run's ID and the key's spend ledger: run cost, the run budget, and progress lines read it. */
  private runSpendSource: { runId: string; account: SpendAccount } | undefined;

  public constructor(
    private readonly root: string,
    private readonly post: (message: Record<string, unknown>) => void,
    private readonly checkpointDir: string,
    private readonly ripgrepPath?: string,
    private readonly transcripts?: ConversationStore,
    private readonly activity?: ActivityFeed
  ) {}

  /** The project the chat works in. */
  public get projectRoot(): string { return this.root; }

  /** The chat's mark, or undefined before its first run (a new chat then starts at the project's label). */
  public get mark(): SessionMark | undefined { return this.chatMark; }

  /** The chat's mark for a run starting now: made at the project's resolved label the first time, and raised by that label every time after. */
  private async markForRun(gate: GateRuntime): Promise<SessionMark> {
    const projectLabel = await projectLabelOf(gate, this.root);
    try {
      const state = gate.bundleState();
      this.defaultLabel = state.state === 'valid' ? state.bundle.defaultLabel : SHIPPED_DEFAULT_LABEL;
    } catch { this.defaultLabel = SHIPPED_DEFAULT_LABEL; }
    if (this.chatMark === undefined) this.adoptMark(new SessionMark(projectLabel));
    else this.chatMark.raise(projectLabel, scalesOf(gate));
    // A merge never applies a signed lowering of this chat below the project's label as this run found it (PR #87 review).
    noteChatProjectMark(this.conversationId, projectLabel);
    return this.chatMark!;
  }

  /** Makes `mark` the chat's mark: each change is saved with the chat (raise-only, D-58) and shown on the page and in the status bar (D-33). */
  private adoptMark(mark: SessionMark | undefined): void {
    this.stopMarkListener?.();
    this.stopMarkListener = undefined;
    this.chatMark = mark;
    if (mark !== undefined) {
      this.stopMarkListener = mark.onDidChange((next) => {
        const pending = this.pendingLowering;
        this.pendingLowering = undefined;
        void this.saveLabel(next, pending?.lowering, pending?.from);
        this.showLabel();
      });
      void this.saveLabel(mark.current());
    }
    this.showLabel();
  }

  /**
   * Saves the chat's mark in its thread meta, joined with what is stored (a raise), or, with `lowering`, as the person's lowering from `from`. When a sync
   * raised the stored mark above `from` meanwhile, the store keeps the higher label (PR #87 review) and the chat is raised to it here too, and says so.
   * Never throws.
   */
  private async saveLabel(mark: Mark, lowering?: unknown, from?: Mark): Promise<void> {
    const store = this.transcripts;
    if (!(store instanceof ThreadStore)) return;
    const id = this.conversationId;
    const outcome = await store.setChatLabel(id, mark, lowering, from).catch(() => undefined);
    if (outcome !== 'raised-meanwhile' || id !== this.conversationId) return;
    const stored = await store.storedChatMark(id).catch(() => undefined);
    if (stored !== undefined) this.chatMark?.raise(stored, activeScales());
    this.post({ type: 'notice', text: LOWERING_OVERTAKEN_TEXT });
  }

  /** The chat's label as the page and the status bar show it: the mark's labels while it is above the policy's default label, otherwise nothing. */
  public labelText(): string {
    const mark = this.chatMark?.current();
    if (mark === undefined || isDefaultMark(mark, this.defaultLabel)) return '';
    // Coherence review S8: the scale's name with the level ("Organization: Sensitive"), never the raw id.
    return mark.map((label) => `${labelKeyShown(label)}${label.compartments.length ? ` (${label.compartments.join(', ')})` : ''}`).join(', ');
  }

  private showLabel(): void {
    this.post({ type: 'chat-label', text: this.labelText() });
    try { this.onLabelChange?.(this.chatMark?.current()); } catch { /* a listener never changes the mark */ }
  }

  /**
   * The person's Lower This Chat's Label (CLAS-04, D-29) is about to lower the mark: the next change is saved as that lowering (with its signed
   * declassification, or `true` when this install could not sign one) rather than joined with what is stored. Only the command calls it, right before
   * SessionMark.lowerByPerson.
   */
  public prepareLowering(signed: unknown): void {
    // The mark the person lowers from, so the store can tell a raise that arrived meanwhile from the lowering itself.
    const from = this.chatMark?.current();
    this.pendingLowering = { lowering: signed, ...(from === undefined ? {} : { from }) };
  }

  /** The policy's default label as this chat last read it. */
  public get chatDefaultLabel(): Label { return this.defaultLabel; }

  /** The one gate (GATE-04): the chat sets it, and every tool call of a run, a sub-agent's included, is decided through it. Without one a run is failed closed: only reading and planning run, and no policy is guessed. */
  public gateHost: Pick<GateHost, 'runtimeFor'> | undefined;
  /** The folder for sub-agents' git worktrees. The chat sets it to the editor's own storage: a worktree is a full checkout and never belongs in the project. */
  public worktreeRoot: string | undefined;
  /** Awaited before each checkpoint save; the chat sets it to the state home's ensure(), so the inner .gitignore exists before any checkpoint file. */
  public checkpointPrepare: (() => Promise<unknown>) | undefined;

  /** Where sub-agents' git worktrees live: the extension's storage, never the project. */
  private get worktreeDir(): string { return this.worktreeRoot ?? path.join(path.dirname(this.checkpointDir), 'worktrees'); }

  public get running(): boolean { return Boolean(this.abort); }
  /** This conversation's ID (spend for "this conversation" is tagged with it). */
  public get id(): string { return this.conversationId; }
  /** A new run ID, for spend the host records before the run starts (attachments). */
  public static newRunId(): string { return `run-${Date.now()}-${randomBytes(3).toString('hex')}`; }
  public get runningAgents(): number { return this.agents.size; }
  /** Nothing has been sent in this conversation yet. */
  public get isEmpty(): boolean { return this.messages.length === 0; }
  /** The conversation's title: the start of its first message, or of the saved transcript's. */
  public get displayTitle(): string { return this.title; }

  /** Takes a conversation ID chosen by the host (a tab it already lists), before anything is sent. */
  public adopt(id: string): void {
    if (!this.messages.length && !this.abort && /^conv-[a-z0-9-]{6,60}$/.test(id)) this.conversationId = id;
  }

  public async send(request: AgentTurnRequest): Promise<void> {
    // A conversation used again after it was closed keeps its badges again.
    this.disposed = false;
    // Messages queued while this turn was being prepared stay queued: the run delivers them.
    this.halt();
    const abort = new AbortController();
    this.abort = abort;
    // The run's own finally clears the controller, but preparing the run can throw first (no shell, a missing skill, a
    // failed save): the conversation must not then stay "running" with nothing behind it.
    try {
      await this.runTurn(request, abort);
    } finally {
      if (this.abort === abort) this.abort = undefined;
    }
  }

  private async runTurn(request: AgentTurnRequest, abort: AbortController): Promise<void> {
    this.spend = { costUsd: 0, tokens: 0, totalTokens: 0, cachedTokens: 0, stopped: false };
    const runId = request.runId ?? AgentConversation.newRunId();
    const account = request.local ? undefined : spendAccountOf(request.client);
    this.runSpendSource = account ? { runId, account } : undefined;
    const checkpoints = new RunCheckpoints(runId, this.checkpointDir, { root: this.root, allowedRoots: [this.worktreeDir], ...(this.checkpointPrepare ? { beforeWrite: this.checkpointPrepare } : {}) });
    this.runs.set(runId, checkpoints);
    this.shellEnvAllow = request.shellEnvAllow ?? [];
    const shell = this.shellFor(request.gsd?.shellEnv ?? {});
    // A thread reopened from the log alone (one begun in the Chat view) has history and no system prompt: it gets the panel's, first.
    const freshConversation = this.messages[0]?.role !== 'system';
    if (freshConversation) this.messages.unshift({ role: 'system', content: this.systemPrompt(request, this.root, this.spawnableAgents(request).length > 0) });
    if (!this.title) this.title = request.text.replace(/\s+/g, ' ').slice(0, 80);
    let prompt = request.text;
    if (request.team) this.teamSlug = request.team.slug;
    if (request.team) prompt = teamLeadPrompt(request.team, request.text.replace(/^\/team:\S+\s*/, ''), staffLeadNote(request.team));
    if (request.skill && request.gsd) {
      const skill = findSkill(request.gsd.skills, request.skill.name);
      if (!skill) throw new Error(`Open-GSD has no skill named ${request.skill.name}.`);
      prompt = `The user ran /${skill.name}${request.skill.args ? ` ${request.skill.args}` : ''}. Follow these instructions:\n\n${await expandPrompt(skill.body, { args: request.skill.args, home: request.gsd.home, root: this.root })}${request.skillAddendum ?? ''}`;
    }
    // The team note goes ahead of whatever the turn asks, a GSD workflow's instructions included (after them, it would be replaced). It is sent once per
    // team in a conversation, not every turn: a long GSD conversation would otherwise carry one copy per message. It is sent again when the team or its
    // members change (notedTeam holds the note's full text) and after the conversation is summarized (the summary may drop it). A reopened conversation
    // counts the newest note already in its restored context as sent, so it does not get a second copy.
    const note = !request.team && request.memberTeam ? teamMembersNote(request.memberTeam) : undefined;
    const noteSent = note !== undefined && this.notedTeam !== note;
    if (noteSent) prompt = `${note}\n\n${prompt}`;
    const extraUsage: UsageMetadata[] = [...(request.attachments?.usage ?? [])];
    if (request.attachments?.text) prompt = `${request.attachments.text}\n\n${prompt}`;
    const remembered = request.memory ? await memoryPreamble(request.memory.store, request.memory.projectScope, request.text).catch(() => undefined) : undefined;
    if (remembered) prompt = `<project-memory>\n${remembered}\n</project-memory>\n\n${prompt}`;
    this.display.set(contentKey(prompt), request.text);
    this.messages.push({ role: 'user', content: prompt });
    // Recorded once the note is in the conversation, never before a turn that failed to start.
    if (noteSent) this.notedTeam = note;
    // Saved before the run, so a run a reload cuts off still keeps what was asked.
    await this.saveTranscript(request.model);
    const conversationId = this.conversationId;
    let ended: RunEnd = 'failed';
    await this.runMarkers?.start({ conversationId, runId, model: request.model });
    this.markerRun = { conversationId, runId };
    const mainId = `main-${runId}`;
    this.mainAgentId = mainId;
    // Every agent of this run judges a script's provenance from this moment: anything written since asks (review of PR 34).
    this.currentRunStartedAt = Date.now();
    this.currentBaseCommit = await headCommit(this.root);
    // Image drafts left for more than a week are removed (only drafts this extension made); it never fails a run.
    if (request.imageModel) await cleanOldDrafts(this.root).catch(() => 0);
    const boundary = runBoundary(request);
    // 0.4.28: the team the run leads or works with, as it is now, so Team Live draws the run against the team it started with.
    const runTeam = request.team ?? request.memberTeam;
    this.runTeamSlug = runTeam?.slug;
    if (runTeam) this.activity?.setRunTeam(runId, runTeam);
    this.activity?.agentStarted({ agentId: mainId, agent: request.skill ? `/${request.skill.name}` : request.team ? `team:${request.team.slug}` : 'agent', runId, model: request.model, conversationId: this.conversationId, ...(boundary ? { boundary } : {}), ...(runTeam ? { team: runTeam.slug } : {}) }, prompt, freshConversation ? String(this.messages[0].content) : undefined);
    this.post({ type: 'assistant-start', model: request.model, privacy: request.privacy });
    for (const note of request.attachments?.notes ?? []) this.post({ type: 'notice', text: note });
    const record: Record_ = (event) => request.activity ? request.activity.store.append(request.activity.sessionId, event).catch(() => undefined) : Promise.resolve();
    const grants = new RunGrants();
    // Attached files are outside content, so the run starts out treated as having read some.
    if (request.attachments?.text) grants.tainted = true;
    for (const event of request.attachments?.security ?? []) this.activity?.security(mainId, event);
    this.steerRun = { grants, extraUsage, mainId };
    const context: Omit<ToolContext, 'signal' | 'onTodos'> = { root: this.root, agentId: mainId, checkpoints, shell, readFiles: new Set(), pages: new Map(), ripgrepPath: this.ripgrepPath, readOnlyRoots: request.gsd ? [request.gsd.home] : [], // A person's own teams (0.4.18) are the extension's files as much as the managed Open-GSD runtime: reading them must never ask. Their folder
    // lives outside the workspace by design, so it is a trusted root for reads, and it is never written to by an agent.
    trustedToolRoots: [...(request.gsd ? [request.gsd.home] : []), teamLibraryDir(homeFolder())], ...(request.gsd ? { gsdRuntime: { home: request.gsd.home, preambles: await trustedPreambles(request.gsd.home) } } : {}) };
    const tools = this.toolsFor(request, context, grants, extraUsage, record, abort.signal, runId);
    // One safety check per run, shared with sub-agents, so each command is asked about once.
    const safety = request.policy.mode === 'auto' && request.safetyModel ? new SafetyModelCheck({ client: request.client, model: request.safetyModel, fallbackModel: request.safetyFallbackModel, task: request.text, onUsage: (usage) => extraUsage.push(usage) }) : undefined;
    this.runSafety = safety;
    // The list as this run found it: a run that never touched it asks for no reminder and flags nothing at its end.
    const tasksAtStart = this.tasks.revision;
    let taskCheckSent = false;
    let mainTurns = 0;
    // The gate has finished its start-up check before the first call is decided; the main run is an agent working for a person who is here.
    const gate = await this.gateHost?.runtimeFor({ root: this.root, actor: { kind: 'agent', sessionId: this.conversationId, agentId: mainId, agentLabel: 'agent' }, presence: 'person', context: 'interactive' });
    // The chat's mark starts at the project's resolved label and never below it: a project labelled since the last run raises it (CLAS-04, edge empty).
    const mark = await this.markForRun(gate ?? unavailableGateRuntime());
    grants.mark = mark;
    grants.outbound = this.outbound;
    const run = new AgentRun({
      client: request.client,
      model: request.model,
      // The run's lead is offered only the tools it may call (offeredTools): a staff server's member-only tools go to the members granted them.
      tools: offeredTools(tools, undefined),
      context,
      policy: request.policy,
      rules: request.rules,
      grants,
      safety,
      ...(gate ? { gate } : {}),
      ...(request.riskSwitches ? { riskSwitches: request.riskSwitches } : {}),
      maxTurns: request.maxTurns,
      maxOutputTokens: request.maxOutputTokens,
      ...(request.modelStallMs ? { stallMs: request.modelStallMs } : {}),
      ...(request.backupModel ? { backupModel: request.backupModel } : {}),
      beforeTool: (signal) => this.whileRunPaused(signal),
      beforeTurn: async (transcript, lastUsage, signal) => {
        this.enforceBudget(request, abort);
        await this.whileRunPaused(signal);
        const pending = this.drainNotifications();
        const input = pending.length ? [...transcript, ...pending] : transcript;
        // D-07: the originals go into the thread log first; managing the context may replace them with trimmed copies or a summary.
        const captured = await this.captureThread(request.model, input);
        const managed = await this.manageContext(input, lastUsage, request, signal, true);
        const next = managed ?? (pending.length ? input : undefined);
        if (captured) for (const message of next ?? transcript) this.logged.add(message);
        await this.saveRunState(request.model, runId, next ?? transcript);
        return next;
      },
      afterAnswer: async (transcript, signal) => {
        const background = await this.waitForBackground(signal);
        if (background?.length) return background;
        if (taskCheckSent) return undefined;
        // A closing question, or a question still waiting for the person, stays the last thing they see: no extra paid turn to bury it (the list is shown as not confirmed done at the run's end).
        if (this.questions.size || this.imageReviews.size || endsWithQuestion(lastAssistantText(transcript))) return undefined;
        const check = this.taskListCheck(tasksAtStart, signal, (request.maxTurns ?? DEFAULT_MAX_TURNS) - mainTurns);
        if (check) taskCheckSent = true;
        return check;
      },
      // PERF-05: the state is saved after every finished call too, not only before each model turn, so a reload mid-batch keeps the finished results.
      onProgress: (transcript) => this.saveRunState(request.model, runId, transcript),
      input: this.steeringInput,
      requestApproval: (approval) => this.askApproval(approval, abort.signal, undefined, mainId, undefined, grants),
      rememberAllowRule: request.rememberAllowRule,
      emit: (event) => {
        this.track(mainId, event);
        if (event.type !== 'reasoning' && event.type !== 'turn') this.markVisible();
        if (event.type === 'tool-start') void this.runMarkers?.step(conversationId, runId, event.tool);
        if (event.type === 'turn') mainTurns += 1;
        // Every post of the main task list goes through this.tasks, so a host mark is never overwritten by a stale list.
        if (event.type === 'todos') this.post({ type: 'todos', todos: this.tasks.write(event.todos) });
        else this.forward(event, request.model, record);
      }
    });
    const runStartedAt = Date.now();
    let costAsked = false;
    this.markVisible();
    const heartbeat = setInterval(() => this.heartbeat(runStartedAt), this.progressTiming.checkMs);
    // A person's staff run attends the project while it runs: the standing watches run with it and pause when nothing attends (WP-WATCH, Q5).
    if (request.team?.staff) watchHostFor(this.root);
    // Coherence review S5: a staff team is marked private, and every private model NEAR AI offers today is from PRC developers. Said once per chat; no
    // routing changes.
    if (request.team?.staff && !this.staffModelsTold) {
      this.staffModelsTold = true;
      this.post({ type: 'notice', text: STAFF_PRIVATE_MODELS_TEXT });
    }
    const releaseAttendance = request.team?.staff ? attend(this.root, { kind: 'run', id: runId }) : () => undefined;
    try {
      let result: RunResult;
      try {
        // Every NEAR request the run makes (sub-agents, safety checks, summaries included) is tagged with it.
        // CLAS-06: and every one of them is routed by the run's session route, decided at the client before anything is sent and recorded in the run's log.
        // With no gate host (a test) the run is wrapped in the default route, so the call is wrapped either way (PR 4a review).
        const attestation = this.chatAttestation;
        let routeOfRun: SessionRoute | undefined;
        const onAnswerChecked: AnswerCheckListener = (chatId, result, checked) => { if (routeOfRun) this.answerChecked(runId, routeOfRun, attestation, chatId, result, { ...checked, client: request.client }); };
        const onNotice = (text: string): void => this.post({ type: 'notice', text });
        const runRoute = gate ? sessionRouteFrom(gate, { attestation, markOf: () => mark.current(), onAnswerChecked, onNotice }) : defaultSessionRoute();
        routeOfRun = runRoute;
        // Coherence review S4: in TEE-only mode every request of the run counts as private only when the gate's own check passes, not on the catalog's word.
        const runAll = () => withSessionRoute(runRoute, () => run.run(this.messages, abort.signal));
        result = await withSpendTag({ kind: 'main', runId, conversationId: this.conversationId, agentId: mainId }, () => (request.teeOnly === true ? withPrivateOnly(runAll) : runAll()));
      } catch (error) {
        this.activity?.agentEnded(mainId, 'failed', error instanceof Error ? error.message : String(error));
        await this.recordRunSplit(request, mainId, extraUsage);
        await this.persistAgent(request, mainId, 'failed');
        // Keep what the run did, so the next message continues from there.
        if (error instanceof AgentRunError) { this.messages = error.messages; await this.saveTranscript(request.model); throw error.cause; }
        throw error;
      } finally {
        // Whatever way the run ended, a list it touched and left unfinished is shown as not confirmed done.
        this.settleTaskList(tasksAtStart);
        // The label raises its writes queued are written now, at the run's end (D-26); a write that fails never fails the run.
        await gate?.labels?.(this.root).flushRaises?.().catch(() => undefined);
      }
      this.activity?.agentEnded(mainId, result.outcome);
      await this.recordRunSplit(request, mainId, [...result.usage, ...extraUsage]);
      // The run's scratch folder is emptied when it ends (0.4.18), so a long session does not grow one. It never fails a run.
      await cleanScratch(this.root).catch(() => 0);
      ended = result.outcome;
      await this.persistAgent(request, mainId, result.outcome);
      this.messages = result.messages;
      const allUsage = [...result.usage, ...extraUsage];
      const usage = sumUsage(allUsage);
      // The run's cost is the ledger's sum over every request it made, not just its model turns.
      if (account) usage.estimatedCostUsd = nanoToUsd(totalNanoUsd(account.totals({ runId })));
      const changed = checkpoints.changedFiles.map((file) => displayPath(this.root, file));
      if (result.outcome === 'cancelled') this.post({ type: 'assistant-cancelled' });
      else {
        this.post({ type: 'assistant-done', usage, runId, ...(account ? { spend: spendLine(account.window('run', { runId })) } : {}) });
        // A run stopped before the model finished says why, and offers Continue (nothing continues without the click).
        const stopped = stopNotice(result);
        if (stopped) this.post({ type: 'run-stopped', reason: result.stop?.kind ?? 'turn-limit', text: stopped, continuable: true });
      }
      if (changed.length) this.post({ type: 'run-changes', runId, files: changed });
      await record({ status: result.outcome === 'cancelled' ? 'cancelled' : 'completed', kind: 'message', model: request.model, summary: `${request.skill ? `/${request.skill.name} run` : 'Agent run'} ${result.outcome}; ${changed.length} file(s) changed.`, estimatedCostUsd: usage.estimatedCostUsd, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
      await this.saveTranscript(request.model);
      // CLAS-08: the lead agent's answer through a cloud client gets its trust badge, chosen only from checks that ran. A sub-agent's answer is not shown
      // as an answer and gets none (D-56); an answer through a local client gets none. It comes after the chat is saved, so its record has a chat to go in.
      if (result.outcome !== 'cancelled' && !request.local) {
        this.startBadge(runId, request, result.usage.at(-1), lastAssistantText(result.messages));
        // A badge already settled when the run ends (no check follows) is saved with the chat before the run returns, like the transcript above, so the
        // run leaves no write of its own behind (PR #95 CI). A badge whose check is still running is saved by that check, which close() drains.
        await this.trustWrites;
      }
      const ids = allUsage.map((turn) => turn.requestId).filter((id): id is string => Boolean(id));
      if (account) {
        if (result.outcome !== 'cancelled') { costAsked = true; await this.reportRunCost(account, runId, request.model, record); }
      } else if (result.outcome !== 'cancelled' && ids.length && !request.local) {
        const actual = await request.client.actualCostsUsd(ids).catch(() => undefined);
        if (actual !== undefined) {
          this.post({ type: 'assistant-cost', actualCostUsd: actual });
          await record({ status: 'completed', kind: 'model', model: request.model, summary: 'Actual cost reported by NEAR AI.', actualCostUsd: actual });
        }
      }
    } finally {
      clearInterval(heartbeat);
      releaseAttendance();
      if (this.abort === abort) this.abort = undefined;
      this.releasePending();
      this.markerRun = undefined;
      this.steerRun = undefined;
      // The turn is over: a floor card approved late for it lets nothing run any more (PR #74 review round 5).
      endFloorApprovals(grants);
      // Stopped or failed runs are reconciled too: NEAR bills what they used.
      if (account && !costAsked) void account.settleNow((entry) => entry.runId === runId);
      await this.runMarkers?.end(conversationId, runId, ended);
    }
  }

  /**
   * Asks NEAR for the run's actual cost at once; the footer shows it when every request is settled,
   * now or (NEAR records usage a few seconds late) when the ledger's reconciliation settles them.
   */
  private async reportRunCost(account: SpendAccount, runId: string, model: string, record: Record_): Promise<void> {
    await account.settleNow((entry) => entry.runId === runId);
    const settled = () => { const totals = account.totals({ runId }); return totals.requests > 0 && totals.pendingNanoUsd === 0 && totals.estimatedNanoUsd === 0 ? totals : undefined; };
    const report = async (late: boolean) => {
      const totals = settled();
      if (!totals) return false;
      const actualCostUsd = nanoToUsd(totals.confirmedNanoUsd);
      this.post(late ? { type: 'assistant-cost', actualCostUsd, runId } : { type: 'assistant-cost', actualCostUsd });
      await record({ status: 'completed', kind: 'model', model, summary: 'Actual cost reported by NEAR AI.', actualCostUsd });
      return true;
    };
    if (await report(false)) return;
    let done = false;
    const watch = account.onChange(() => { if (!done && settled()) { done = true; watch.dispose(); clearTimeout(expiry); void report(true); } });
    const expiry = setTimeout(() => { done = true; watch.dispose(); }, 30 * 60_000);
    expiry.unref?.();
  }

  public answerApproval(callId: string, reply: ApprovalReply): void {
    this.approvals.get(callId)?.(reply);
    this.approvals.delete(callId);
  }

  public answerQuestions(id: string, answers: string[]): void {
    this.questions.get(id)?.(answers);
    this.questions.delete(id);
  }

  /** The person's decision on a generated image; false when that draft is not waiting (already decided, or its run stopped). */
  public answerImageReview(id: string, reply: { decision: 'accept' | 'changes' | 'discard'; feedback?: string }): boolean {
    const settle = this.imageReviews.get(id);
    if (!settle) return false;
    this.imageReviews.delete(id);
    settle(reply.decision === 'changes' ? { decision: 'changes', feedback: (reply.feedback ?? '').trim() || '(no details given)' } : { decision: reply.decision });
    return true;
  }

  /** The file of a draft waiting for review, for "Open full size"; undefined for any other id. */
  public imageDraftFile(id: string): string | undefined {
    return DRAFT_ID.test(id) && this.imageReviews.has(id) ? draftFile(this.root, id) : undefined;
  }

  /** Pause (before its next model turn), resume, or stop one sub-agent. */
  public controlAgent(agentId: string, action: 'pause' | 'resume' | 'stop' | 'nudge'): boolean {
    const agent = this.agents.get(agentId) ?? (action === 'nudge' ? undefined : this.queuedAgents.get(agentId));
    if (!agent) return false;
    if (action === 'nudge') {
      // 0.4.19: "Check now". The queue a run takes belongs to the whole conversation and only the main run consumes it, so the message goes to the main
      // run rather than to the row that was clicked: that is where the wait is, and sending it "to" a sub-agent would have delivered it to the parent
      // anyway, without saying so (0.4.18 review). The message names the agent when a sub-agent's row was clicked, so the parent knows what is being asked.
      const id = `steer-${randomBytes(6).toString('hex')}`;
      const working = !agent.paused && !agent.abort.signal.aborted;
      // 0.4.18 review: a paused agent is not waiting on anything, so a check queued for it would arrive on a later, unrelated turn, which is worse than
      // doing nothing. 0.4.19 review: the page must say so, or the click looks broken, so a notice explains why.
      if (!working) {
        this.post({ type: 'notice', text: `${agent.label} is paused, so there is nothing to check. Resume it first, or stop it.` });
        return false;
      }
      this.steer(id, checkNowMessage(agent.label), { interrupt: true });
      return true;
    }
    if (action === 'stop') agent.abort.abort();
    else if (action === 'pause') agent.paused = true;
    else { agent.paused = false; agent.resume?.(); agent.resume = undefined; this.resumeRun(); }
    if (action !== 'stop') this.activity?.setPaused(agentId, action === 'pause');
    this.postAgents();
    return true;
  }

  /** Stops the run and its sub-agents. Messages still queued for it go back to the composer. */
  public stop(): void {
    this.halt();
    const returned = this.takeUndelivered();
    for (const item of returned) this.post({ type: 'steer-state', id: item.id, state: 'returned', text: item.text });
    if (returned.length) this.onReturned?.(returned);
  }

  private halt(): void {
    this.resumeRun(false);
    this.approvalTimeoutStreaks.clear();
    this.abort?.abort();
    this.abort = undefined;
    for (const agent of this.agents.values()) agent.abort.abort();
    this.releasePending();
  }

  /**
   * Queues a message the user sent while a run is going (or about to start). The run appends it to
   * its transcript before its next model request; a retry wait ends early for it.
   */
  public steer(id: string, text: string, options: { interrupt?: boolean; attachments?: PreparedAttachments; staged?: StagedAttachment[] } = {}): void {
    this.resumeRun();
    this.steering.push({ id, text, ...(options.attachments ? { attachments: options.attachments } : {}), ...(options.staged?.length ? { staged: options.staged } : {}) });
    this.post({ type: 'steer-state', id, state: 'queued' });
    // 0.4.18: a message the person asked to interrupt with cuts the turn in flight; one that did not waits for the next safe point as before.
    const interrupt = options.interrupt === true;
    if (interrupt) {
      this.interrupting = true;
      // Said at once, so a person who pressed Steer sees that it was taken as an interruption rather than a queue.
      this.post({ type: 'steer-state', id, state: 'interrupting' });
    }
    for (const listener of [...this.steerListeners]) listener({ interrupt });
  }

  /** What a run does with attachments at its start, for attachments that arrive with a message during it: outside content taints the run. */
  private takeSteerAttachments(attachments: PreparedAttachments): void {
    for (const note of attachments.notes) this.post({ type: 'notice', text: note });
    const run = this.steerRun;
    // A run takes queued messages only while it runs, and it sets steerRun before it starts, so this is never expected; if it ever happens, say so.
    if (!run) { this.post({ type: 'notice', text: 'An attachment reached the agent outside a run, so it was not counted toward the run\'s cost or safety checks.' }); return; }
    if (attachments.text) run.grants.tainted = true;
    run.extraUsage.push(...attachments.usage);
    for (const event of attachments.security) this.activity?.security(run.mainId, event);
  }

  /** The ID of the run going now, for spend the host records for it (attachments read during it). */
  public get currentRunId(): string | undefined { return this.markerRun?.runId; }

  /** Queued messages no run took (it ended first), oldest first; the caller sends them as a new turn. */
  public takeUndelivered(): SteerMessage[] {
    const left = this.steering;
    this.steering = [];
    // The queue is emptied, so any interrupt it carried has been honoured.
    this.interrupting = false;
    return left;
  }

  /** Whether a queued message asked to interrupt; cleared when a run takes the queue. */
  private interrupting = false;

  private readonly steeringInput: RunInput = {
    pending: () => this.steering.length > 0,
    take: () => this.takeUndelivered().map((item) => {
      // Attached files go in the same message, ahead of the words, exactly as they do at the start of a run.
      const content = item.attachments?.text ? `${item.attachments.text}\n\n${steeringContent(item.text)}` : steeringContent(item.text);
      if (item.attachments) this.takeSteerAttachments(item.attachments);
      this.display.set(contentKey(content), item.text);
      this.post({ type: 'steer-state', id: item.id, state: 'delivered' });
      return { role: 'user', content };
    }),
    subscribe: (listener) => { this.steerListeners.add(listener); return () => { this.steerListeners.delete(listener); }; },
    interruptRequested: () => this.interrupting,
    consumeInterrupt: () => { this.interrupting = false; }
  };

  /**
   * Checks NEAR's signature and TDX attestation for a run's final answer, always afresh (never the 10-minute report cache). When a check after one of this
   * run's answers had failed (D-55), Check again checks each of those answers afresh: when every one is signed, the chat's stop is cleared (if no other run
   * of the chat still has a failed check) and route.attestation-cleared is recorded; a fresh result that fails again leaves the stop. The run's badge takes
   * the fresh result (CLAS-08).
   */
  public async verifyRun(runId: string): Promise<AnswerCheckResult> {
    const entry = this.verifiable.get(runId);
    const attestation = this.chatAttestation;
    let last: AnswerCheckResult | undefined;
    // Every failed check of this run's answers, from the chat-wide list (PR #89 review), so a run that has left the newest-50 list can still be checked.
    const failures = [...this.routeFailures].filter(([, failure]) => failure.runId === runId);
    if (failures.length > 0) {
      let model = '';
      let route: SessionRoute | undefined;
      for (const [chatId, failed] of failures) {
        model = failed.model;
        last = await failed.client.verifyResponse(failed.model, failed.evidence);
        if (entry?.evidence?.chatId === chatId) { entry.result = last; entry.verification = last.outcome; }
        if (last.outcome !== 'signed') return last;
        if (attestation === this.chatAttestation) { this.routeFailures.delete(chatId); this.uncheckedFailures.delete(chatId); this.badgeFailures.delete(chatId); }
        this.answerChecks.get(runId)?.results.set(chatId, last);
        route = failed.route;
      }
      // Cleared only when no failed answer of the chat is left unchecked, counted for the whole chat.
      if (this.uncheckedFailures.size === 0 && attestation === this.chatAttestation && attestation.closed !== true && attestation.failed) {
        attestation.failed = false;
        try { if (route !== undefined) route.sink?.record(routeEventRecordFor(route, 'route.attestation-cleared', { model, attestation: 'verified' })); } catch { /* D-21 */ }
      }
    }
    // The badge's own failed checks of this run's answers (CLAS-08) are checked again too; a signed one no longer counts as an earlier failure.
    for (const [chatId, failed] of [...this.badgeFailures].filter(([, failure]) => failure.runId === runId)) {
      if (entry?.evidence?.chatId === chatId) continue;
      const again = await failed.client.verifyResponse(failed.model, failed.evidence);
      if (attestation === this.chatAttestation && again.outcome === 'signed') this.badgeFailures.delete(chatId);
    }
    if (last !== undefined) {
      const final = entry?.evidence !== undefined ? this.answerChecks.get(runId)?.results.get(entry.evidence.chatId) : undefined;
      return this.withLostFailures(final ?? last, attestation);
    }
    if (!entry?.evidence) return { outcome: 'unavailable', summary: `This response can no longer be verified from the editor (only the last ${String(TRUST_ENTRIES_KEPT)} are kept).`, checks: {}, notChecked: NOT_CHECKED_IN_EDITOR };
    const fresh = await entry.client.verifyResponse(entry.model, entry.evidence);
    entry.result = fresh;
    entry.verification = fresh.outcome;
    if (attestation === this.chatAttestation) this.noteBadgeCheck(runId, entry, entry.evidence, fresh);
    return this.withLostFailures(fresh, attestation);
  }

  /**
   * A Check again that passed while the chat's stop still holds a failure no longer kept for checking (past FAILED_CHECKS_KEPT) says plainly that only a new
   * chat clears it (PR #89 review), rather than leaving the person to press Check again on an answer it cannot reach.
   */
  private withLostFailures(result: AnswerCheckResult, attestation: RouteAttestation): AnswerCheckResult {
    if (result.outcome !== 'signed' || attestation !== this.chatAttestation || !attestation.failed) return result;
    if (![...this.uncheckedFailures].some((chatId) => !this.routeFailures.has(chatId))) return result;
    return { ...result, summary: `${result.summary} ${CHECK_AGAIN_NEW_CHAT_TEXT}` };
  }

  /** Keeps or clears a badge check's failure of an answer the route did not check (CLAS-08); the route's own failures are kept by answerChecked. */
  private noteBadgeCheck(runId: string, entry: BadgeEntry, evidence: ResponseEvidence, result: AnswerCheckResult): void {
    if (result.outcome === 'signed') { this.badgeFailures.delete(evidence.chatId); return; }
    if (result.outcome !== 'failed' || this.uncheckedFailures.has(evidence.chatId)) return;
    this.badgeFailures.delete(evidence.chatId);
    this.badgeFailures.set(evidence.chatId, { runId, model: entry.model, evidence, client: entry.client });
    for (const old of [...this.badgeFailures.keys()].slice(0, -FAILED_CHECKS_KEPT)) { this.badgeFailures.delete(old); this.droppedBadgeFailures += 1; }
  }

  /** The badge a run's lead answer shows now, or undefined when the run's badge is no longer kept or it came through a local client. */
  public trustBadge(runId: string): TrustBadge | undefined {
    const entry = this.verifiable.get(runId);
    return entry === undefined ? undefined : this.badgeOf(entry);
  }

  /**
   * The badge a run's answer shows now, with one more reason (PR #95 review): Check again could not run, so the page is given its badge back with the cause
   * rather than left on "Checking again". The state is what the checks that did run proved. Undefined when the run never had a badge here.
   */
  public badgeWithNotice(runId: string, reason: string): TrustBadge | undefined {
    const badge = this.trustBadge(runId) ?? this.shownBadges.get(runId);
    return badge === undefined ? undefined : { ...badge, reasons: [...badge.reasons.filter((known) => known !== reason), reason] };
  }

  /** Show full attestation (CLAS-08): one answer's check details, or undefined when the run's badge is no longer kept (the newest TRUST_ENTRIES_KEPT). */
  public trustDetails(runId: string): Record<string, unknown> | undefined {
    const entry = this.verifiable.get(runId);
    if (entry === undefined) return undefined;
    return trustDetailsOf({ runId, model: entry.model, answeredAt: entry.answeredAt, badge: this.badgeOf(entry), result: entry.result, connection: entry.facts.connection, connectionPinned: entry.facts.connectionFresh });
  }

  /**
   * A person's Check again on a badge (the page's verify-response): a fresh check of the run's answer, and of every failed check of the run, then the badge
   * for that run id. An answer no longer kept keeps the state it showed and says it cannot be checked again; undefined when the run never had a badge here.
   */
  public async checkAgain(runId: string): Promise<TrustBadge | undefined> {
    await this.verifyRun(runId);
    const badge = this.trustBadge(runId);
    if (badge !== undefined) return badge;
    const shown = this.shownBadges.get(runId);
    return shown === undefined ? undefined : { ...shown, reasons: [...shown.reasons.filter((reason) => reason !== TRUST_BADGE_TEXT.notKept), TRUST_BADGE_TEXT.notKept] };
  }

  /** Starts a lead answer's badge when its run ends: keeps what it was chosen from and shows it (CLAS-08). */
  private startBadge(runId: string, request: AgentTurnRequest, usage: UsageMetadata | undefined, answerText: string): void {
    const facts = answerFactsOf(request, usage);
    if (facts.route === 'local') return;
    const evidence = usage?.evidence;
    // A check follows only for a TEE model on NEAR AI Cloud's own endpoint whose answer carried a signature id; anything else is never checked.
    const willCheck = facts.boundary === 'tee' && facts.nearEndpoint && evidence !== undefined;
    const entry: BadgeEntry = { thread: this.conversationId, answerText, model: request.model, client: request.client, evidence, facts, answeredAt: Date.now(), verification: willCheck ? 'pending' : 'not-run' };
    this.verifiable.delete(runId);
    this.verifiable.set(runId, entry);
    for (const old of [...this.verifiable.keys()].slice(0, -TRUST_ENTRIES_KEPT)) this.verifiable.delete(old);
    this.postBadge(runId, entry);
    if (willCheck) this.checkForBadge(runId, entry, evidence);
  }

  /**
   * Checks a lead answer once in the background (the owner's decision of 2026-11-16): plan 25's own check of the same chat id when its request was at
   * attested-cloud, else one through the client's 10-minute report cache. If it has not settled after BADGE_CHECK_TIMEOUT_MS the badge says it could not be
   * checked in time (D-56); a result that comes later still updates it. Every post names the answer's own run id, so a check that settles after the person
   * started another run updates only its own answer. A chat that was closed or replaced meanwhile gets nothing.
   */
  private checkForBadge(runId: string, entry: BadgeEntry, evidence: ResponseEvidence): void {
    const attestation = this.chatAttestation;
    const current = () => attestation === this.chatAttestation && attestation.closed !== true;
    let settled = false;
    const timer = this.badgeTimers.set(() => {
      this.badgeTimerHandles.delete(timer);
      if (settled || entry.verification !== 'pending' || !current()) return;
      entry.verification = 'timed-out';
      this.postBadge(runId, entry);
    }, BADGE_CHECK_TIMEOUT_MS);
    this.badgeTimerHandles.add(timer);
    let check: Promise<AnswerCheckResult>;
    try { check = entry.client.verificationFor(entry.model, evidence); } catch (error) { check = Promise.reject(error); }
    void check.then((result) => result, (error: unknown): AnswerCheckResult => ({ outcome: 'unavailable', summary: `The answer could not be checked (${error instanceof Error ? error.message : 'unknown error'}).`, checks: {}, notChecked: NOT_CHECKED_IN_EDITOR }))
      .then((result) => {
        settled = true;
        this.badgeTimers.clear(timer);
        this.badgeTimerHandles.delete(timer);
        if (!current() || this.disposed) return;
        // A person's Check again that finished first already holds the newer result.
        if (entry.verification !== 'pending' && entry.verification !== 'timed-out') return;
        entry.result = result;
        entry.verification = result.outcome;
        this.noteBadgeCheck(runId, entry, evidence, result);
        this.postBadge(runId, entry);
      });
  }

  /** The badge of one entry, chosen by trustBadgeFor alone, with what the editor does not check. */
  private badgeOf(entry: BadgeEntry): TrustBadge | undefined {
    const own = entry.evidence?.chatId;
    const earlierCheckLost = this.droppedBadgeFailures > 0 || [...this.uncheckedFailures].some((chatId) => chatId !== own && !this.routeFailures.has(chatId));
    const earlierCheckFailed = earlierCheckLost || [...this.uncheckedFailures, ...this.badgeFailures.keys()].some((chatId) => chatId !== own);
    const badge = trustBadgeFor({ ...entry.facts, verification: entry.verification, ...(entry.result ? { verificationSummary: entry.result.summary } : {}), earlierCheckFailed, ...(earlierCheckLost ? { earlierCheckLost } : {}) });
    return badge === undefined ? undefined : { ...badge, notChecked: entry.result?.notChecked ?? NOT_CHECKED_IN_EDITOR };
  }

  /** Shows an entry's badge under its own run's answer (never the newest one). */
  private postBadge(runId: string, entry: BadgeEntry): void {
    const badge = this.badgeOf(entry);
    if (badge === undefined) return;
    this.shownBadges.delete(runId);
    this.shownBadges.set(runId, badge);
    for (const old of [...this.shownBadges.keys()].slice(0, -SHOWN_BADGES_KEPT)) this.shownBadges.delete(old);
    this.post({ type: 'trust-badge', runId, badge });
    if (entry.verification !== 'pending') this.keepTrust(runId, entry, badge);
  }

  /**
   * Keeps a settled badge in the chat's meta (plan 27), so a reopened chat shows the state its checks reached. Never waits and never fails anything: a write
   * that fails is ignored. A newer result of the same run's answer replaces what this window wrote for it; anything else keeps the weaker state.
   */
  private keepTrust(runId: string, entry: BadgeEntry, badge: TrustBadge): void {
    const store = this.transcripts;
    if (!(store instanceof ThreadStore) || entry.answerText === '' || this.disposed) return;
    const record = trustRecordOf(entry.answerText, badge, new Date());
    const mode = this.trustWriters.get(record.key) === runId ? 'replace' : 'weaker';
    this.trustWriters.set(record.key, runId);
    for (const old of [...this.trustWriters.keys()].slice(0, -SHOWN_BADGES_KEPT)) this.trustWriters.delete(old);
    // Queued behind the writes before it; one still queued when the conversation is closed is dropped, never written later (PR #95 CI).
    const write = this.trustWrites.then(() => this.disposed ? undefined : store.recordTrust(entry.thread, record, mode)).catch(() => undefined);
    this.trustWrites = write;
  }

  /** Resolves once every badge record this chat started writing has been written, failed or been dropped by a close. */
  public trustRecorded(): Promise<void> { return this.trustWrites; }

  /**
   * Closes the conversation and waits until nothing of it is still being written to the thread store (PR #95 CI): later badge results and timeouts are
   * ignored, records still queued are dropped, and the one being written is awaited. The answer checks themselves are not awaited; their results are dropped.
   */
  public async close(): Promise<void> {
    this.dispose();
    openConversations.delete(this);
    await this.trustWrites;
  }

  /**
   * The check after one of a run's attested-cloud answers settled (D-36, D-55). For a closed or replaced chat nothing is posted or set. A failed check is
   * kept for Check again; a failure of another answer of the run makes the run's badge say so at once (the final answer's own check updates the badge
   * itself).
   */
  private answerChecked(runId: string, route: SessionRoute, attestation: RouteAttestation, chatId: string, result: AnswerCheckResult, checked: { model: string; evidence: ResponseEvidence; client: NearAiClient }): void {
    if (attestation !== this.chatAttestation || attestation.closed === true) return;
    let checks = this.answerChecks.get(runId);
    if (!checks) {
      checks = { route, results: new Map() };
      this.answerChecks.set(runId, checks);
      for (const old of [...this.answerChecks.keys()].slice(0, -50)) this.answerChecks.delete(old);
    }
    checks.results.set(chatId, result);
    if (result.outcome === 'failed') {
      this.uncheckedFailures.add(chatId);
      this.badgeFailures.delete(chatId);
      this.routeFailures.delete(chatId);
      this.routeFailures.set(chatId, { runId, ...checked, route });
      for (const old of [...this.routeFailures.keys()].slice(0, -FAILED_CHECKS_KEPT)) this.routeFailures.delete(old);
    }
    const entry = this.verifiable.get(runId);
    if (entry && entry.evidence?.chatId !== chatId && result.outcome === 'failed') this.postBadge(runId, entry);
  }

  /** Undoes every file change a run made with the file tools. */
  public async revert(runId: string): Promise<string[]> {
    const checkpoints = this.runs.get(runId) ?? await RunCheckpoints.load(runId, this.checkpointDir, { root: this.root, allowedRoots: [this.worktreeDir], ...(this.checkpointPrepare ? { beforeWrite: this.checkpointPrepare } : {}) });
    if (!checkpoints) return [];
    const restored = await checkpoints.revert();
    this.runs.delete(runId);
    return restored.map((file) => displayPath(this.root, file));
  }

  /**
   * Continues an earlier conversation with its full context; returns what the view shows. A thread kept by the thread store comes back as `items`: every
   * entry of its log, tool steps included (D-07). Another store has only the saved messages, so it comes back as the visible turns.
   */
  public async restore(id: string): Promise<RestoredView | undefined> {
    const transcript = await this.transcripts?.load(id);
    if (!transcript) return undefined;
    this.reset();
    // PERF-05: a run saved mid-batch has calls without results; they get a placeholder so the transcript is valid and nothing finished is redone.
    this.messages = repairTranscript(transcript.messages);
    this.display = new Map(transcript.display ?? []);
    this.conversationId = transcript.id;
    this.title = transcript.title;
    this.teamSlug = undefined;
    // The newest team note already in the restored context counts as sent, so reopening does not add a second copy.
    this.notedTeam = undefined;
    for (const message of this.messages) {
      if (message.role !== 'user' || typeof message.content !== 'string') continue;
      const notes = message.content.match(/<team name="[^"\n]*">[\s\S]*?<\/team>/g);
      if (notes) this.notedTeam = notes[notes.length - 1];
    }
    const store = this.transcripts;
    let items: ViewItem[] | undefined;
    if (store instanceof ThreadStore) {
      // D-07: the view comes from the thread log, which holds every message. The saved context is what the model continues from, unless the thread was
      // continued somewhere else since (the log's main line ends at another entry): then the context is rebuilt from the log, so nothing that was said is missing.
      const lines = await store.lines(id).catch(() => undefined);
      const tip = lines?.main.at(-1)?.id ?? '';
      if (lines && tip && transcript.basedOnTip !== tip) {
        const system = this.messages[0]?.role === 'system' ? [this.messages[0]] : [];
        this.messages = [...system, ...entriesToMessages(lines.main)];
        store.cover(id, tip);
      }
      if (lines?.main.length) {
        const meta = await store.meta(id).catch(() => undefined);
        // Each answer's kept badge (CLAS-08) comes back as it was proven, replayed: no Check again and no full attestation. Answers saved before this
        // version have no record and show no badge.
        const kept = new Map((meta?.trust ?? []).map((record) => [record.key, record] as const));
        const trustFor = (text: string) => { const record = kept.get(trustRecordKey(text)); return record === undefined ? undefined : { ...trustBadgeFromRecord(record), notChecked: NOT_CHECKED_IN_EDITOR }; };
        items = entriesToView(lines, { history: meta?.history, trustFor });
      }
    }
    // What was just loaded is already in the log (or is the model's own text); it is never written again.
    for (const message of this.messages) this.logged.add(message);
    await this.restoreLabel(id);
    return items ? { items } : visibleTurns(transcript.messages, this.display);
  }

  /**
   * A reopened chat keeps its label (CLAS-04): its mark starts at the stored mark, or at the default scale's highest level with a sentence naming the
   * Lower command when the stored value cannot be read. Its fingerprints (D-60) are not stored, so above the shipped default label they are rebuilt from
   * every tool result in its context (which results were labelled is not stored either, so all of them count: fail closed).
   */
  private async restoreLabel(id: string): Promise<void> {
    const store = this.transcripts;
    const meta = store instanceof ThreadStore ? await store.meta(id).catch(() => undefined) : undefined;
    const read = chatLabelOf(meta);
    if (read.kind === 'none') return;
    this.adoptMark(new SessionMark(read.kind === 'mark' ? read.mark : [UNREADABLE_CHAT_LABEL]));
    if (read.kind === 'unreadable') this.post({ type: 'notice', text: UNREADABLE_CHAT_LABEL_TEXT });
    const mark = this.chatMark!.current();
    if (!isDefaultMark(mark, SHIPPED_DEFAULT_LABEL)) {
      for (const message of this.messages) if (message.role === 'tool' && typeof message.content === 'string') this.outboundPrints.addEarlier(message.content);
    }
  }

  /** The stored output of one tool step of this conversation, for a reopened card that was opened (D-07). Only the thread store keeps it. */
  public async toolOutput(entryId: string): Promise<string | undefined> {
    const store = this.transcripts;
    return store instanceof ThreadStore ? store.toolOutput(this.conversationId, entryId) : undefined;
  }

  public reset(): void {
    this.halt();
    this.steering = [];
    this.tasks.clear();
    this.messages = [];
    this.display = new Map();
    this.conversationId = newConversationId();
    this.title = '';
    this.teamSlug = undefined;
    this.notedTeam = undefined;
    this.contextWarned = false;
    this.contextFullWarned = false;
    this.notifications = [];
    this.shell?.dispose();
    this.shell = undefined;
    // A new chat starts with no mark (its first run sets it at the project's label) and no fingerprints.
    this.outboundPrints = new OutboundFingerprints();
    this.adoptMark(undefined);
    // ...and without the stop of a failed answer check (D-55): the old state is closed, so a check of the old chat that settles later sets nothing.
    this.chatAttestation.closed = true;
    this.chatAttestation = { failed: false };
    this.answerChecks.clear();
    this.uncheckedFailures = new Set();
    this.routeFailures = new Map();
    this.badgeFailures = new Map();
    this.droppedBadgeFailures = 0;
    // Every badge of the old chat goes with it (PR #95 review round 3): its run ids answer neither trustBadge nor Check again, and nothing more is written to
    // its thread from here. Records already queued for it were for that thread, and are written there as queued.
    this.verifiable.clear();
    this.shownBadges.clear();
    this.trustWriters.clear();
    // The old chat's badge timeouts can post nothing any more.
    for (const handle of this.badgeTimerHandles) this.badgeTimers.clear(handle);
    this.badgeTimerHandles.clear();
  }

  /** Closes the conversation: nothing more is posted or written for it (see close() to also wait for a write in progress). */
  public dispose(): void {
    this.disposed = true;
    this.reset();
  }

  /** The agent definitions a run can start; without any, the run has no Agent tool. */
  private spawnableAgents(request: AgentTurnRequest): GsdAgent[] {
    // One definition per name, the first one wins. The agents a workflow step adds for this run (the red-team stage) come first, with or without a team
    // (#46 review), so neither a team file in the repository nor an Open-GSD agent of the same name can replace them; then the team's members, which win
    // over Open-GSD's agents of the same name; then Open-GSD's.
    const members = selectedTeamAgents(request.team ?? request.memberTeam);
    const all = [...(request.projectAgents ?? []), ...members, ...(request.gsd?.agents ?? [])];
    return all.filter((agent, index) => all.findIndex((other) => other.name === agent.name) === index);
  }

  /**
   * The team this conversation was started with: the newest `/team:<name>` the person typed in it. Read from the conversation itself, so a reopened
   * conversation keeps its team, and a later /team:<other> switches it.
   */
  public get conversationTeam(): string | undefined {
    if (this.teamSlug) return this.teamSlug;
    // A reopened conversation: the newest /team in what the person typed. Its display line is kept even after the message itself was summarized away.
    let slug: string | undefined;
    for (const typed of this.display.values()) {
      const match = /^\/team:(\S+)/.exec(typed);
      if (match) slug = match[1];
    }
    return slug;
  }

  /** `agentTool` says whether this run's tools include Agent, so the prompt only advises handing work to sub-agents when it can. */
  private systemPrompt(request: AgentTurnRequest, root: string, agentTool: boolean): string {
    // Every run is told where scratch work goes (0.4.18): inside the project, ignored by git, and emptied when the run ends. It goes before the
    // Open-GSD note so a workflow's own instructions read as the more specific direction.
    const base = `${agentSystemPrompt({ security: Boolean(request.security), agentTool, root, platform: `${process.platform} ${process.arch}`, date: new Date().toISOString().slice(0, 10), isGitRepo: insideGitRepo(root), model: request.model })}${projectInstructions(root)}\n\n${SCRATCH_INSTRUCTIONS}\n\n${WAITING_INSTRUCTIONS}${request.team ? `\n\n${KNOWLEDGE_INSTRUCTIONS}` : ''}`;
    if (!request.gsd) return base;
    return `${base}\n\n# Open-GSD\nOpen-GSD is installed at ${request.gsd.home} (read-only to you). Its skills, agents, workflows, templates, and references live there; read them with Read when instructions point to them. Run gsd-tools as the workflows show; CLAUDE_CONFIG_DIR is already set in your shell. ${agentTool ? 'When a workflow says to spawn an agent, use the Agent tool with that subagent_type (run_in_background works). Run each plan, task and research workstream as its own sub-agent with a fresh context, and ask it to end with a short summary (what changed, how it was verified, what is still open) rather than its working notes: your context stays small, which keeps every later turn fast. When the agent does an item on your task list, pass that item\'s exact content (or its number on the list, counting from 1) as the Agent call\'s task: the list then shows it in progress and marks it completed (or back to pending) when the agent ends, even while other agents still run. Background agents\' reports arrive as messages on their own: once you have nothing else to do, end your turn to wait for them. Never wait with sleep or by polling for output files.' : 'You have no Agent tool here: when a workflow says to spawn an agent, do that part of the work yourself.'} When it says to ask the user, use AskUserQuestion.`;
  }

  private shellFor(env: NodeJS.ProcessEnv): ShellSession {
    const key = JSON.stringify([env, this.shellEnvAllow]);
    if (!this.shell || this.shellEnvKey !== key) {
      this.shell?.dispose();
      this.shell = new ShellSession(this.root, undefined, env, this.shellEnvAllow);
      this.shellEnvKey = key;
    }
    return this.shell;
  }

  /**
   * Keeps the transcript inside the model's window. Over 60% used, old tool output is trimmed;
   * at Open-GSD's warning threshold the user is told; at the critical threshold earlier history
   * is summarized by the model and, for the main run, a handoff is saved. If summarizing fails,
   * trimming still applies and the user is told, so work continues rather than overflowing.
   */
  private async manageContext(transcript: AgentMessage[], lastUsage: UsageMetadata | undefined, request: AgentTurnRequest, signal: AbortSignal, mainRun: boolean): Promise<AgentMessage[] | undefined> {
    const window = request.contextWindows?.[request.model] ?? DEFAULT_CONTEXT_WINDOW;
    const reported = lastUsage?.inputTokens !== undefined ? lastUsage.inputTokens + (lastUsage.outputTokens ?? 0) : undefined;
    const used = Math.max(reported ?? 0, estimateTokens(transcript));
    const status = contextStatus(used, window, DEFAULT_THRESHOLDS);
    if (mainRun) this.post({ type: 'context', remainingPercent: status.remainingPercent, level: status.level });
    // PERF-02: also an absolute threshold (nearAi.agent.compactAtTokens), so a large window does not mean a large, slow, expensive transcript.
    const action = contextAction(used, window, this.compactAtTokens, DEFAULT_THRESHOLDS);
    if (action === 'none') return undefined;
    let next = trimOldToolResults(transcript);
    if (action === 'warn' && mainRun && !this.contextWarned) {
      this.contextWarned = true;
      this.post({ type: 'notice', text: `Context is ${100 - status.remainingPercent}% full. Older tool output is being trimmed; at ${100 - DEFAULT_THRESHOLDS.criticalRemaining}% the conversation is summarized automatically.` });
    }
    if (action !== 'compact') return next;
    try {
      // Nothing older than the recent messages to summarize: trimming is all that applies, and no summary is announced. The user is told once
      // that the context is nearly full, since the recent messages themselves hold most of it and the run may soon hit the model's limit.
      const compacted = await compactConversation(request.client, request.model, next, signal);
      if (!compacted) {
        if (mainRun && !this.contextFullWarned) {
          this.contextFullWarned = true;
          this.post({ type: 'notice', text: `Context is ${100 - status.remainingPercent}% full, and summarizing could not free space. Older tool output is trimmed; if the run fails for lack of space, start a new chat with a shorter request.` });
        }
        return next;
      }
      next = compacted;
      this.contextFullWarned = false;
      // The summary may have dropped the team note: the next turn says it again.
      if (mainRun) this.notedTeam = undefined;
      if (mainRun) {
        this.post({ type: 'notice', text: 'The conversation was summarized to stay within the model\'s context window. A handoff was saved to .planning/HANDOFF.json.' });
        await saveHandoff(this.root, { reason: 'context-critical', currentAction: this.title || 'Agent conversation', nextAction: 'Continue from the summarized conversation, or resume it from NEAR AI history.', activeAgents: this.agents.size, pendingApprovals: this.approvals.size }).catch(() => undefined);
      }
    } catch (error) {
      if (signal.aborted) throw error;
      if (mainRun) this.post({ type: 'notice', text: `Summarizing the conversation failed (${(error as Error).message}); older tool output was trimmed instead. Consider starting a new chat soon.` });
    }
    return next;
  }

  private toolsFor(request: AgentTurnRequest, context: Omit<ToolContext, 'signal' | 'onTodos'>, grants: RunGrants, extraUsage: UsageMetadata[], record: Record_, runSignal: AbortSignal, runId: string): AgentTool<any>[] {
    const media = request.imageModel ? [imageTool(request.client, request.imageModel, request.imageModels ?? [], request.imageReview === 'off' ? undefined : this.imageReviewer(request.policy))] : [];
    const memoryFor = (agentScope?: MemoryScope, source = runId) => request.memory ? memoryTools(request.memory.store, { project: request.memory.projectScope, agent: agentScope }, AGENT_MEMORY_ACTOR, source) : [];
    // A team run reads and feeds the team's own knowledge graph, so the team gets better the more it works (owner, 2026-11-08). Every member writes to the
    // same graph, which is what makes it shared: a fact one member verified is there for the next one. The graph is keyed by teamKnowledgeKey: a library team's
    // slug (its file name, unique in the library), or a project team's own per-project key, so no two projects share one graph. The agent writes as `research`: its own grades are held to the ceiling, because a run that read a hostile page
    // can be steered into claiming anything. A damaged file's problem reaches the tool, so the agent and the person are told rather than shown a quiet nothing.
    const teamKnowledge = request.team
      ? knowledgeTools({
          read: async () => {
            const { knowledge, problem } = await loadKnowledge(teamLibraryDir(homeFolder()), teamKnowledgeKey(request.team!.file));
            return problem ? { ...knowledge, problem } : knowledge;
          },
          add: async (addition) => addKnowledge(teamLibraryDir(homeFolder()), teamKnowledgeKey(request.team!.file), addition)
        }, 'research')
      : [];
    // A staff section team's run (its file has a `staff:` block) gets the staff tools (design 10, 6.2) and the built-in local staff servers listed once in
    // staffServers.ts: the intel-workbench, observations, cop-map and logistics. Each of those is given only to members whose own tools line grants it,
    // never to the run's lead: each is offered only to those members (offeredTools, below and in the run) and refuses any other caller at call time
    // (staffServerToolsForRun). None of them can approve, reject or release anything, and none reaches the network.
    const staffTeam = request.team ? staffTeamInfo(request.team) : undefined;
    const staff = staffTeam ? staffTools({ host: () => staffHostFor(this.root), team: staffTeam, run: runId }) : [];
    const servers = staffTeam && request.team?.staff ? staffServerToolsForRun(request.team, { host: () => staffHostFor(this.root), store: () => observationStoreFor(this.root), team: staffTeam, run: runId }) : [];
    const base = [...CORE_TOOLS, webFetchTool, webSearchTool(request.webSearch), checkCitationsTool, checkOriginalityTool, ...GRAPHICS_TOOLS, ...media, ...(request.security ? [securityTool(request.security)] : []), ...(request.cyber ? request.cyber.tools() : []), ...staff, ...servers, ...(request.mcpTools ?? []), ...teamKnowledge, ...memoryFor()];
    const agents = this.spawnableAgents(request);
    if (!agents.length) return base;
    const gsd = request.gsd;
    // The team's members, and those offered as members: a member whose name a project agent took is not offered, since that name runs the project agent.
    const memberNames = selectedTeamAgents(request.team ?? request.memberTeam).map((agent) => agent.name);
    const offeredMembers = memberNames.filter((name) => !(request.projectAgents ?? []).some((agent) => agent.name === name));
    let all: AgentTool<any>[] = [];
    const extra = gsdTools({
      home: gsd?.home ?? '',
      root: this.root,
      skills: gsd?.skills ?? [],
      agents,
      // A member whose name a run's own agent took is not offered as a member: that name runs the run's agent.
      teamMembers: offeredMembers,
      ask: (questions, askSignal, askerId) => this.askQuestions(questions, askSignal, request.policy, askerId),
      spawn: async (spawn, callSignal) => {
        const label = spawn.agent?.name ?? spawn.type;
        // PERF-06: in a research-profile project the plan-checker runs only for plans that change a gate or verifier; for content-only plans it returns
        // a VERIFICATION PASSED report saying it was skipped, so the workflow carries on without a model pass.
        if (/plan-checker/i.test(label) && request.researchProfile !== false && await researchProfileActive(this.root)) {
          const skipped = await planCheckSkip(spawn.prompt, this.root, context.checkpoints.changedFiles).catch(() => undefined);
          if (skipped) {
            void record({ status: 'completed', kind: 'agent', agentRole: label, action: spawn.description, summary: `Sub-agent ${label} skipped by the research profile.` });
            this.post({ type: 'notice', text: `${label} skipped: the research profile checks only plans that change a gate or verifier, and these plans change content only.` });
            if (!spawn.background) return skipped;
            this.notifications.push({ role: 'user', content: `<agent-notification id="${label}-skipped" agent="${label}" status="finished">\n${skipped}\n</agent-notification>` });
            return `Started ${label} in the background. Its report will arrive in a later message.`;
          }
        }
        const tiers = request.tiers ?? { deep: request.model, standard: request.model, fast: request.model };
        // A team member's own model line wins; then the role's configured model; then the tier the workflow asked for.
        const teamMember = Boolean(spawn.agent && (!gsd || !spawn.agent.file.startsWith(gsd.home)));
        // Whether it is one of the run's team members (not merely an agent with a file of its own): a project agent that took a member's name is not
        // that member, so the feed says so (member: false) and Team Live and the staff lanes never put it on the member's card.
        const onTeam = Boolean(spawn.agent) && offeredMembers.includes(label);
        const membership = onTeam ? { member: true } : memberNames.includes(label) ? { member: false } : {};
        const roleModel = spawn.agent && !(teamMember && spawn.agent.model) ? roleModelFor(label, request.roleModels ?? {}) : undefined;
        // A model the Agent call names that is not on this key fails the call, naming it and the models that are; a role, agent-file or
        // tier model that is not on this key falls back to the chat's model with a note the lead sees (in the result) and the person sees.
        // A private member keeps its own resolution below, so its unresolved request still falls back rather than failing.
        const choice = agentModelFor({ roleModel, requested: spawn.model, agentModel: spawn.agent?.model, tiers, current: request.model, available: request.availableModels });
        if ('error' in choice && spawn.agent?.privacy !== 'private') throw new ToolError(choice.error);
        let model = 'error' in choice ? request.model : choice.model;
        let modelNote = 'error' in choice ? undefined : choice.note;
        // A member that must stay private runs on a TEE or local model, or not at all: it never falls back to a forwarded model.
        if (spawn.agent?.privacy === 'private') {
          const tier = tierOf(roleModel ?? spawn.model ?? spawn.agent.model);
          const offered = (request.modelCatalog ?? []).filter((candidate) => !request.availableModels || request.availableModels.includes(candidate.id) || candidate.id === request.model);
          // Fail closed on the route: every sub-agent is sent through this run's one client, so a model is eligible only if it is private on
          // that client. A local catalog entry is never sent to the NEAR client (NEAR would serve or forward it), and a TEE entry only goes to
          // NEAR's own endpoint, where its attestation can be checked; never to a local runtime or another endpoint claiming TEE.
          const candidates = offered.filter((candidate) => routeAllows(request.route, candidate));
          const chosen = privateModelFor(model, tier, tiers, candidates);
          if (!chosen || !routeAllows(request.route, candidates.find((candidate) => candidate.id === chosen))) throw new ToolError(privateRefusal(label, tier, request.route));
          if (chosen !== model || 'error' in choice) modelNote = `${label} must stay private, so it runs on the private model ${chosen}${'error' in choice ? ` (the requested ${spawn.model} is not a model on this key)` : ''}.`;
          model = chosen;
        }
        // The model the agent runs on goes back to the lead with its report (and in the "Started" line of a background agent), so the lead
        // can say truthfully which model did the work; a fallback is also shown to the person.
        if (modelNote) this.post({ type: 'notice', text: `${label}: ${modelNote}` });
        // Owner's D-48 run: the models it may move to when its model is overloaded or silent at NEAR AI, each at least as private as its own (TEE stays
        // TEE, a private member stays private, TEE-only keeps it private). A member whose team file names its model moves too, and the notice says so.
        const privateMember = spawn.agent?.privacy === 'private';
        const pinnedLine = teamMember ? spawn.agent?.model?.trim() : undefined;
        const pinned = Boolean(pinnedLine && !tierOf(pinnedLine) && !/^(?:inherit|default)$/i.test(pinnedLine) && !roleModel && !spawn.model);
        const eligible = fallbackModelsFor({ current: model, preferred: [request.backupModel, tiers.standard, tiers.deep, tiers.fast, request.model], ...(request.modelCatalog ? { catalog: request.modelCatalog } : {}), ...(request.availableModels ? { available: request.availableModels } : {}), privateMember, teeOnly: request.teeOnly === true, allowed: (candidate) => routeAllows(request.route, candidate), max: 64 });
        const fallbacks = eligible.slice(0, 4);
        // PERF-03: a stalled turn's backup is the run's backup, or the chat's own model, and only one it may move to (a private member never leaves privacy).
        const stallBackup = [request.backupModel, request.model].find((candidate) => candidate && candidate !== model && eligible.includes(candidate));
        const switches: string[] = [];
        // The model the agent runs on goes back to the lead with its report, so the lead can say truthfully which model did the work; a move is said too.
        const ranOnText = (): string => `${label} ran on ${agent.model}.${modelNote ? ` ${modelNote}` : ''}${switches.length ? ` ${switches.join(' ')}` : ''}`;
        const agentBody = spawn.agent ? (gsd ? await expandPrompt(spawn.agent.body, { home: gsd.home, root: this.root }) : spawn.agent.body) : undefined;
        // Each sub-agent's Remember/Recall also reach its own private memory.
        const privateMemory = memoryFor({ kind: 'private-agent', id: `agent-${label}`.slice(0, 80) }, `${runId}-${label}`.slice(0, 100));
        const pool = [...all.filter((tool) => tool.name !== 'Remember' && tool.name !== 'Recall'), ...privateMemory];
        // A listed tool, Task for Agent, and MCP tools by name, mcp:<server>, or a trailing-* pattern.
        const listed = spawn.agent?.tools.length ? pool.filter((tool) => spawn.agent!.tools.includes(tool.name) || (tool.name === 'Task' && spawn.agent!.tools.includes('Agent')) || (tool.name.startsWith('mcp__') && grantsMcpTool(spawn.agent!.tools, tool.name))) : pool.filter((tool) => tool.name !== 'Agent' && tool.name !== 'Task');
        // An agent with a write limit (a staff team's red team or guard) keeps only Write and Edit among the tools that change files, since those two
        // refuse every path outside the limit; a shell, an MCP tool or a document maker could write anywhere, and starting other agents could too. The
        // built-in staff tools it is granted stay (WRITE_LIMITED_STAFF_TOOLS): they write only the ledger, headers and gate reports, through the host.
        // The observations server's tools stay too: they only read the observation store (the J3 watch officer watches the feeds with them).
        const writeOnly = spawn.agent?.writeOnly;
        const limited = writeOnly ? listed.filter((tool) => tool.name === 'Write' || tool.name === 'Edit' || WRITE_LIMITED_STAFF_TOOLS.has(tool.name) || (OBSERVATIONS_TOOL_NAMES.includes(tool.name) && tool.capability === 'read') || (!WRITING_CAPABILITIES.has(tool.capability) && !tool.name.startsWith('mcp__') && tool.name !== 'Agent' && tool.name !== 'Task')) : listed;
        // Offered only what it may call: a staff server's tools only when this member's own tools line grants them (the call-time gate stays).
        const institutional = await institutionalChildTools(request.team ?? request.memberTeam,
          { root: this.root, runId, label, model, local: request.local === true && request.route?.kind === 'local', onTeam, detached: Boolean(spawn.isolation || spawn.background || spawn.parentId !== context.agentId) },
          { verify: (scope, draft) => verifyInstitutionalDraftTarget(scope, resolveInWorkspace, draft),
            commit: (scope, draft, verify) => storeInstitutionalDraft(scope, resolveInWorkspace, draft, verify) });
        const allowed = institutional ?? offeredTools(limited, label);
        // The task-list item this agent does, when the call names one that is on the list.
        const todo = spawn.task ? this.moveTask(spawn.task, 'in_progress') : undefined;
        const agent: LiveAgent = { id: `${label}-${randomBytes(3).toString('hex')}`, label, description: spawn.description, model, abort: new AbortController(), paused: false, background: spawn.background, activity: 'Waiting for a free slot', activitySince: Date.now(), startedAt: Date.now(), toolCalls: 0, turns: 0 };
        // 0.4.28: who it is on the activity feed from the moment it is asked for, with the agent that asked (the main agent, or a sub-agent starting its own
        // helper) as its parent. It shows as queued until it gets a slot.
        const parentId = spawn.parentId ?? `main-${runId}`;
        const agentBoundary = runBoundary(request);
        const identity = { agentId: agent.id, agent: label, runId, model, parentId, conversationId: this.conversationId, task: spawn.description, ...membership, background: spawn.background, ...(agentBoundary ? { boundary: agentBoundary } : {}) };
        this.activity?.agentQueued(identity);
        this.queuedAgents.set(agent.id, agent);
        this.postAgents();
        // A background agent outlives the tool call but not the run; a foreground one ends with the call too.
        const parent = spawn.background ? runSignal : callSignal;
        const onParentAbort = () => agent.abort.abort();
        parent.addEventListener('abort', onParentAbort, { once: true });
        const limit = request.maxParallelAgents ?? AGENT_DEFAULTS.maxParallelAgents;
        const slot = { held: false, nested: 0, worktree: spawn.isolation === 'worktree', worktreeHeld: false };
        // A foreground agent this agent starts needs a slot from the same pool, so this agent hands its own slot back while it waits for that child
        // and takes one again before its next turn. Otherwise a parent holding the last slot would wait for ever on a child that waits for that slot.
        // 0.4.28: the same hand-back serves an agent waiting for its background helpers' reports (afterAnswer below).
        const handBackSlot = () => {
          if (slot.held) { slot.held = false; this.releaseSlot(); }
          if (slot.worktreeHeld) { slot.worktreeHeld = false; this.worktreeSlots.release(); }
        };
        const takeBackSlot = async () => {
          // Once the agent is stopped there is no next turn to hold a slot for, and waiting on the aborted signal would throw here and replace the
          // child's finished report with an error.
          while (slot.nested === 0 && !slot.held && !agent.abort.signal.aborted) {
            // Stopped while waiting: there is no next turn, and the child's finished report must still be returned, not replaced by the abort.
            try { await this.acquireSlot(limit, agent.abort.signal); } catch { break; }
            slot.held = true;
            // Another foreground child started while this one waited for the slot: it needs the slot more.
            if (slot.nested > 0) { slot.held = false; this.releaseSlot(); }
          }
          // Then its worktree slot, the same way (PERF-04 with #36).
          while (slot.worktree && slot.nested === 0 && slot.held && !slot.worktreeHeld && !agent.abort.signal.aborted) {
            try { await this.worktreeSlots.acquire(this.maxParallelWorktrees, agent.abort.signal); } catch { break; }
            slot.worktreeHeld = true;
            if (slot.nested > 0) { slot.worktreeHeld = false; this.worktreeSlots.release(); }
          }
        };
        const yieldingSlot = (tool: AgentTool<any>): AgentTool<any> => ({
          ...tool,
          run: async (input, toolContext) => {
            if ((input as { background?: boolean }).background) return tool.run(input, toolContext);
            slot.nested += 1;
            if (slot.nested === 1) handBackSlot();
            try {
              return await tool.run(input, toolContext);
            } finally {
              slot.nested -= 1;
              await takeBackSlot();
            }
          }
        });
        const tools = allowed.map((tool) => (tool.name === 'Agent' || tool.name === 'Task' ? yieldingSlot(tool) : tool));
        const execute = async (): Promise<string> => {
          // Stopped before it got a slot (0.4.28): it ends as stopped on the feed rather than staying queued.
          try { await this.acquireSlot(limit, agent.abort.signal); } catch (error) { this.activity?.agentEnded(agent.id, 'cancelled'); this.queuedAgents.delete(agent.id); this.postAgents(); throw error; } finally { this.queuedAgents.delete(agent.id); }
          slot.held = true;
          // PERF-04: agents in their own worktree also take a worktree slot (nearAi.agent.maxParallelWorktrees), since each one checks out and builds.
          // Like the agent slot (#36), it is handed back while the agent waits for a foreground helper, so a worktree cap of 1 cannot deadlock either.
          if (slot.worktree) {
            try { await this.worktreeSlots.acquire(this.maxParallelWorktrees, agent.abort.signal); slot.worktreeHeld = true; } catch (error) { slot.held = false; this.releaseSlot(); this.activity?.agentEnded(agent.id, 'cancelled'); throw error; }
          }
          let shell: ShellSession | undefined;
          let worktree: AgentWorktree | undefined;
          let worktreeState: 'removed' | 'kept' | undefined;
          const inbox = { reports: [] as AgentMessage[], pending: new Set<Promise<void>>() };
          agent.startedAt = Date.now();
          this.setActivity(agent, 'Starting');
          this.agents.set(agent.id, agent);
          this.postAgents();
          const started = Date.now();
          const usage: UsageMetadata[] = [];
          void record({ status: 'running', kind: 'agent', agentId: agent.id, parentAgentId: parentId, agentRole: label, action: spawn.description, model, summary: `Sub-agent ${label} started.` });
          try {
            if (spawn.isolation === 'worktree') worktree = await createAgentWorktree(this.root, this.worktreeDir, agent.id);
            const agentRoot = worktree?.root ?? this.root;
            // Its own shell, so parallel agents neither queue behind each other's commands nor share a cwd.
            shell = new ShellSession(agentRoot, undefined, request.gsd?.shellEnv ?? {}, request.shellEnvAllow ?? []);
            // Research agents gather outside content; their writes belong in .planning/ (others ask).
            const agentContext = { ...context, root: agentRoot, shell, readFiles: new Set<string>(), pages: new Map<string, string>(), agentId: agent.id, agentLabel: label, ...(/research|synthesi|red-team/i.test(label) ? { writeScope: '.planning' } : {}), ...(writeOnly ? { writeOnly } : {}) };
            const isolationNote = worktree ? `\n\n# Isolation\nYou are working in an isolated git worktree at ${worktree.path} on branch ${worktree.branch}${worktree.root !== worktree.path ? `, in its copy of the workspace folder, ${worktree.root}` : ''}.${worktree.rootUnmatched ? ` The workspace folder (${this.root}) could not be placed inside the worktree, so you start at its top level: change into the matching subfolder before working.` : ''}${worktree.rootCreatedEmpty ? ` git does not track that folder, so its copy here is empty: files you need from it are only in the main checkout.` : ''} Commit your work on this branch; do not switch branches or touch the main checkout at ${this.root}.` : '';
            const base = `${this.systemPrompt({ ...request, model }, agentRoot, tools.some((tool) => tool.name === 'Agent' || tool.name === 'Task'))}${isolationNote}`;
            const system = agentBody ? `${agentBody}\n\n${base}` : base;
            this.activity?.agentStarted(identity, spawn.prompt, system);
            staffLane(request, this.root, runId, label, onTeam, 'started');
            // Paused while it waited for a slot: it starts paused.
            if (agent.paused) this.activity?.setPaused(agent.id, true);
            this.inboxes.set(agent.id, inbox);
            // A sub-agent of a person's run is interactive with the person present, even though its PERF-01 unattended flag below is set (D-43): its cards queue for them.
            const childGate = await this.gateHost?.runtimeFor({ root: this.root, actor: { kind: 'sub-agent', sessionId: this.conversationId, agentId: agent.id, agentLabel: label }, presence: 'person', context: 'interactive' });
            const child = new AgentRun({
              client: request.client, model, tools, context: agentContext, policy: request.policy, rules: request.rules, grants, safety: this.runSafety, maxTurns: request.maxTurns, maxOutputTokens: request.maxOutputTokens,
              ...(childGate ? { gate: childGate } : {}),
              ...(request.unattendedAutoApprove !== false ? { unattended: { planScripts: scriptsNamedIn(spawn.prompt), runStartedAt: this.currentRunStartedAt, ...(this.currentBaseCommit ? { baseCommit: this.currentBaseCommit } : {}) } } : {}),
              ...(institutional ? { stallRetries: 0, ...(request.modelStallMs ? { idleTimeoutMs: request.modelStallMs, turnCeilingMs: DEFAULT_TURN_CEILING_MS } : {}) } : {}),
              ...(!institutional && request.modelStallMs ? { stallMs: request.modelStallMs, ...(stallBackup ? { backupModel: stallBackup } : {}) } : {}),
              ...(!institutional && fallbacks.length ? { fallbackModels: fallbacks, modelAnswering: (candidate: string) => this.modelTrouble.answering(candidate), modelTrouble: (left: string) => this.modelTrouble.mark(left) } : {}),
              beforeTool: (signal) => this.whileRunPaused(signal),
              beforeTurn: async (transcript, lastUsage, signal) => {
                if (this.abort) this.enforceBudget(request, this.abort);
                await this.whileRunPaused(signal);
                while (agent.paused && !signal.aborted) await waitOrAbort(signal, (wake) => { agent.resume = wake; });
                // Reports of its own background helpers reach it before its next turn, as the lead's reach the lead (0.4.28).
                const reports = this.takeReports(agent.id);
                const input = reports.length ? [...transcript, ...reports] : transcript;
                return (await this.manageContext(input, lastUsage, { ...request, model }, signal, false)) ?? (reports.length ? input : undefined);
              },
              // 0.4.28: done, but helpers it started in the background still run: it waits for their reports (handing its slot back meanwhile, so a
              // helper can run with one slot) instead of ending with "started" and leaving the reports for the lead.
              afterAnswer: async (_transcript, signal) => {
                const ready = this.takeReports(agent.id);
                if (ready.length || !inbox.pending.size || signal.aborted) return ready.length ? ready : undefined;
                handBackSlot();
                this.activity?.waitingForAgents(agent.id, true);
                this.setActivity(agent, `Waiting for ${inbox.pending.size} helper${inbox.pending.size === 1 ? '' : 's'}`);
                this.postAgents();
                let reports: AgentMessage[] = [];
                while (!reports.length && inbox.pending.size && !signal.aborted) {
                  await waitOrAbort(signal, (wake) => { void Promise.race(inbox.pending).then(wake, wake); });
                  reports = this.takeReports(agent.id);
                }
                this.activity?.waitingForAgents(agent.id, false);
                await takeBackSlot();
                // Stopped while reports were already taken: they go on to the lead rather than being lost (review of PR 72).
                if (signal.aborted && reports.length) { this.notifications.push(...reports); return undefined; }
                return reports.length ? reports : undefined;
              },
              // PERF-01: nobody may be watching a sub-agent, so its card waits only briefly; unanswered, the call returns "awaiting approval", the card
              // stays queued, and a later answer is passed to the lead (an allow grants that exact command for the rest of the run).
              // In every mode, deliberately (review of PR 34): the short wait never runs anything. The card stays queued for the person, the action
              // happens only if they allow it, and the sub-agent works on meanwhile instead of holding the run.
              requestApproval: (approval) => this.askApproval({ ...approval, callId: `${agent.id}:${approval.callId}`, title: `${label} › ${approval.title}` }, agent.abort.signal, label, agent.id, {
                waitMs: this.subagentApprovalWaitMs,
                onLate: (reply) => { if (childGate) recordLateApproval(childGate, approval.callId, reply, { model }); this.lateApproval(label, approval, reply, grants, request.rememberAllowRule, childGate?.clock ?? Date.now); }
              }, grants),
              rememberAllowRule: request.rememberAllowRule,
              emit: (event) => {
                this.track(agent.id, event);
                this.observe(agent, event);
                if (event.type === 'tool-start') this.forward({ ...event, callId: `${agent.id}:${event.callId}`, title: `${label} › ${event.title}` }, agent.model, record);
                else if (event.type === 'tool-end') this.forward({ ...event, callId: `${agent.id}:${event.callId}` }, agent.model, record);
                else if (event.type === 'turn') { usage.push(event.usage); extraUsage.push(event.usage); this.forward(event, agent.model, record); }
                else if (event.type === 'retry') this.post({ type: 'notice', text: `${label}: ${retryNotice(event)}` });
                else if (event.type === 'model-switch') {
                  // The member carries on on the next model: the person reads why, in the chat, the activity feed (Team Live) and the Staff Room.
                  agent.model = event.to;
                  const text = switchNotice(label, event.from, event.to, event.reason, pinned && event.from === model);
                  switches.push(`It switched from ${event.from} to ${event.to}: ${event.reason}.`);
                  this.post({ type: 'notice', text });
                  this.activity?.modelSwitched(agent.id, event.to, text);
                  this.postAgents();
                  void record({ status: 'running', kind: 'model', agentId: agent.id, parentAgentId: parentId, agentRole: label, model: event.to, summary: text, errorCode: `model-switch-${event.cause}` });
                  staffSwitch(request, this.root, runId, label, onTeam, event.from, event.to, event.reason);
                }
              }
            });
            // The sub-agent's own route names it in its records, and shares the parent's mark and attestation state, so a helper is routed as its lead is
            // (research 9.1); outside a parent route (a test) it starts from the chat's own state.
            const parentRoute = currentSessionRoute();
            const childRoute = childGate ? sessionRouteFrom(childGate, { ...(parentRoute ? { markOf: parentRoute.markOf } : {}), attestation: parentRoute?.attestation ?? this.routeAttestation, ...(parentRoute?.onAnswerChecked ? { onAnswerChecked: parentRoute.onAnswerChecked } : {}), ...(parentRoute?.onNotice ? { onNotice: parentRoute.onNotice } : {}) }) : parentRoute ?? defaultSessionRoute();
            const childMessages: AgentMessage[] = [{ role: 'system', content: system }, { role: 'user', content: spawn.prompt }];
            // Coherence review S4: a private member (its own line, or a private team's) is sent only when the gate's own check passes: a model on this
            // computer, or a private NEAR AI Cloud model over a connection proven to end inside its private hardware. The catalog's word only chose the model.
            const runChild = () => withSessionRoute(childRoute, () => child.run(childMessages, agent.abort.signal));
            const result = await withSpendTag({ kind: 'sub-agent', agentId: agent.id }, () => (privateMember ? withPrivateOnly(runChild) : runChild()));
            this.activity?.agentEnded(agent.id, result.outcome);
            staffLane(request, this.root, runId, label, onTeam, result.outcome === 'cancelled' ? 'cancelled' : result.outcome === 'completed' ? 'done' : 'failed');
            await this.persistAgent(request, agent.id);
            const total = sumUsage(usage);
            const report = [...result.messages].reverse().find((message) => message.role === 'assistant' && message.content)?.content;
            await this.recordReputation(request.reputation, label, result.outcome === 'completed' ? 1 : result.outcome === 'max-turns' || result.outcome === 'stuck' ? 0 : -1, agent.id);
            const ranOn = ranOnText();
            void record({ status: result.outcome === 'cancelled' ? 'cancelled' : 'completed', kind: 'agent', agentId: agent.id, parentAgentId: parentId, agentRole: label, action: spawn.description, model: agent.model, summary: `Sub-agent ${label} ${result.outcome}.`, inputTokens: total.inputTokens, outputTokens: total.outputTokens, estimatedCostUsd: total.estimatedCostUsd, durationMs: Date.now() - started });
            shell.dispose();
            worktreeState = worktree ? await finishAgentWorktree(worktree).catch(() => 'kept' as const) : undefined;
            const isolated = worktree && worktreeState ? `\n\n${worktreeReport(worktree, worktreeState)}` : '';
            const done = result.outcome === 'completed';
            if (todo) this.moveTask(todo, done ? 'completed' : 'pending');
            const note = this.taskNote(todo, done);
            if (result.outcome === 'cancelled') return `${label} was stopped before it finished.\n\n${ranOn}${isolated}${note}`;
            // A sub-agent stopped short says so, so the lead does not take a partial report as finished work.
            const short = stopNotice(result);
            return `${typeof report === 'string' && report.trim() ? boundedReport(report, label) : `${label} finished without a written report.`}${short ? `\n\n${label} did not finish. ${short}` : ''}\n\n${ranOn}${isolated}${note}`;
          } catch (error) {
            if (todo) this.moveTask(todo, 'pending');
            // Why, in words (overloaded at NEAR AI, no answer for 90 s, refused by policy), for the person and for the lead, not only the error's name.
            const reason = failureReason(error);
            const message = error instanceof Error ? error.message : String(error);
            const tried = switches.length ? ` ${switches.join(' ')}` : '';
            const said = reason ? `${label} failed: ${reason}.${tried}` : undefined;
            this.activity?.agentEnded(agent.id, 'failed', said ?? message);
            staffLane(request, this.root, runId, label, onTeam, 'failed', reason);
            await this.persistAgent(request, agent.id);
            await this.recordReputation(request.reputation, label, -1, agent.id);
            const cause = error instanceof AgentRunError && error.cause instanceof Error ? error.cause : error;
            void record({ status: 'failed', kind: 'agent', agentId: agent.id, parentAgentId: parentId, agentRole: label, action: spawn.description, model: agent.model, summary: said ? `Sub-agent ${said}` : `Sub-agent ${label} failed.`, errorCode: cause instanceof Error ? cause.name : 'unknown', durationMs: Date.now() - started });
            if (said) throw Object.assign(new Error(`${said} ${message}`), { cause: error });
            throw error;
          } finally {
            shell?.dispose();
            // A failed agent's empty worktree is removed too; one with changes stays for recovery.
            if (worktree && !worktreeState) await finishAgentWorktree(worktree).catch(() => undefined);
            parent.removeEventListener('abort', onParentAbort);
            // Reports it did not read (it was stopped, or failed) go to the run's lead, as do those of helpers still running when it ended.
            this.inboxes.delete(agent.id);
            this.notifications.push(...inbox.reports);
            this.agents.delete(agent.id);
            if (slot.worktreeHeld) { slot.worktreeHeld = false; this.worktreeSlots.release(); }
            if (slot.held) { slot.held = false; this.releaseSlot(); }
            this.postAgents();
          }
        };
        if (!spawn.background) return execute().catch((error: Error) => { throw new Error(`${error.message}${this.taskNote(todo, false)}`); });
        // The report goes to whoever started it while that agent runs (0.4.28), else to the run's lead.
        const owner = this.inboxes.get(parentId);
        const task = execute()
          .then((report) => { this.deliverReport(parentId, { role: 'user', content: `<agent-notification id="${agent.id}" agent="${label}" status="finished">\n${report}\n</agent-notification>` }); })
          .catch((error: Error) => { this.deliverReport(parentId, { role: 'user', content: `<agent-notification id="${agent.id}" agent="${label}" status="failed">\n${error.message}${this.taskNote(todo, false)}\n</agent-notification>` }); })
          .finally(() => { this.background.delete(task); owner?.pending.delete(task); });
        this.background.add(task);
        owner?.pending.add(task);
        return `Started ${label} in the background as ${agent.id} on ${model}.${modelNote ? ` ${modelNote}` : ''}${fallbacks.length ? ` If NEAR AI is overloaded on ${model} or it stops answering, it moves to ${fallbacks.join(', then ')} and says so.` : ''} Its report will arrive in a later message when it finishes; there is no output file to poll. Continue with other work, or end your turn to wait; do not sleep.`;
      }
    });
    all = [...base, ...extra.filter((tool) => gsd || (tool.name !== 'Skill' && tool.name !== 'SlashCommand'))];
    return all;
  }

  /** Reliability evidence for the sub-agent's role (when it maps to one), so routing history is explainable. */
  private async recordReputation(store: ReputationStore | undefined, label: string, value: number, agentId: string): Promise<void> {
    const role = roleFor(label);
    if (!store || !role) return;
    await store.record({ evidenceId: `evidence-${agentId}`.slice(0, 100), profileId: `agent-${label}`.slice(0, 100), role, kind: 'reliability', value, recordedAt: new Date().toISOString(), source: 'runtime', outcome: value > 0 ? 'success' : value < 0 ? 'failure' : 'partial' }).catch(() => undefined);
  }

  /** A background agent's report: to the sub-agent that started it while that one runs, otherwise to the run's lead (0.4.28). */
  private deliverReport(ownerId: string, message: AgentMessage): void {
    const inbox = this.inboxes.get(ownerId);
    if (inbox) inbox.reports.push(message);
    else this.notifications.push(message);
  }

  /** The reports waiting for a sub-agent, now read. */
  private takeReports(agentId: string): AgentMessage[] {
    const inbox = this.inboxes.get(agentId);
    if (!inbox?.reports.length) return [];
    const reports = inbox.reports;
    inbox.reports = [];
    this.activity?.reportsDelivered(agentId, reportCount(reports));
    return reports;
  }

  /** Reports from background agents that finished since the last turn, as user messages. */
  private drainNotifications(): AgentMessage[] {
    const pending = this.notifications;
    this.notifications = [];
    // 0.4.28: the main agent reads them now, which is when a report reaches it (Team Live shows it docking).
    if (this.mainAgentId) this.activity?.reportsDelivered(this.mainAgentId, reportCount(pending));
    return pending;
  }

  /** When the model is done but background agents are still running, wait for the next report. */
  private async waitForBackground(signal: AbortSignal): Promise<AgentMessage[] | undefined> {
    // Drain first, notice second (0.4.19 review): a report that arrived while the parent was still streaming feeds the run at once — posting "Waiting…" first
    // would announce a hold that instantly ends. The notice therefore appears exactly when the run genuinely holds, and never when it does not.
    const ready = this.drainNotifications();
    if (ready.length) return ready;
    if (!this.background.size || signal.aborted) return undefined;
    this.post({ type: 'notice', text: `Waiting for ${this.background.size} background agent${this.background.size === 1 ? '' : 's'} to finish…` });
    // A message from the user wakes the agent too.
    let unsubscribe: (() => void) | undefined;
    const mainId = this.mainAgentId;
    if (mainId) this.activity?.waitingForAgents(mainId, true);
    // A helper that finishes may have reported to the sub-agent that started it (0.4.28), not here: then nothing is ready yet, and the lead keeps waiting
    // while agents still run rather than ending its run under them.
    let arrived: AgentMessage[] = [];
    while (!signal.aborted) {
      // The abort listener is removed after each pass (review of PR 72), as waitOrAbort does, so a lead that waits through several waves does not pile them up.
      let onAbort: (() => void) | undefined;
      await Promise.race([...this.background, new Promise<void>((resolve) => { onAbort = () => resolve(); signal.addEventListener('abort', onAbort, { once: true }); unsubscribe = this.steeringInput.subscribe(() => resolve()); })]);
      if (onAbort) signal.removeEventListener('abort', onAbort);
      unsubscribe?.();
      arrived = [...this.drainNotifications(), ...this.steeringInput.take()];
      if (arrived.length || !this.background.size) break;
    }
    if (mainId) this.activity?.waitingForAgents(mainId, false);
    return signal.aborted ? undefined : arrived;
  }

  /** Reserves a slot in the same synchronous step as the check, so parallel spawns cannot overshoot the limit. */
  private async acquireSlot(limit: number, signal: AbortSignal): Promise<void> {
    while (this.slotsInUse >= Math.max(1, limit)) {
      if (signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
      await waitOrAbort(signal, (wake) => this.slotWaiters.push(wake));
    }
    if (signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    this.slotsInUse += 1;
  }

  private releaseSlot(): void {
    this.slotsInUse = Math.max(0, this.slotsInUse - 1);
    const waiters = this.slotWaiters;
    this.slotWaiters = [];
    for (const wake of waiters) wake();
  }

  private postAgents(): void {
    if (this.agentsTimer) { clearTimeout(this.agentsTimer); this.agentsTimer = undefined; }
    // The agents working and those waiting for a slot (queued), each with its state; `team`: this run leads or works with a team, so the page offers
    // its dots and Watch the team (a run with no team has no team to watch).
    const listed = [...this.agents.values(), ...[...this.queuedAgents.values()].filter((agent) => !this.agents.has(agent.id))];
    const stateOf = (agent: LiveAgent) => agentDotState(agent, this.activity?.agentStat(agent.id) ?? (this.queuedAgents.has(agent.id) ? { phase: 'queued' as const } : undefined));
    this.post({ type: 'agents', count: this.agents.size, ...(this.runTeamSlug ? { team: true } : {}), agents: listed.map((agent) => ({ id: agent.id, label: agent.label, description: agent.description, model: agent.model, paused: agent.paused, background: agent.background, activity: agent.activity, state: stateOf(agent), activitySince: agent.activitySince, lastAction: agent.lastAction, startedAt: agent.startedAt, toolCalls: agent.toolCalls, turns: agent.turns, ...(agent.todos?.length ? { steps: agentSteps(agent.todos) } : {}) })) });
  }

  /** Refreshes the agents strip at most once a second. */
  private schedulePostAgents(): void {
    this.agentsTimer ??= setTimeout(() => { this.agentsTimer = undefined; this.postAgents(); }, 1_000);
  }

  private setActivity(agent: LiveAgent, activity: string): void {
    if (agent.activity === activity) return;
    agent.activity = activity;
    agent.activitySince = Date.now();
  }

  /**
   * The one reminder a run may send when its answer leaves the list unfinished: it asks the model to update the list and never changes a status
   * itself (the host marks nothing done that did not finish). Only a run that touched the list asks, and only with two model turns to spare, so
   * the reminder cannot push a finished run into a turn-limit stop.
   */
  private taskListCheck(tasksAtStart: number, signal: AbortSignal, turnsLeft: number): AgentMessage[] | undefined {
    if (signal.aborted || this.tasks.revision === tasksAtStart || !this.tasks.unfinished || turnsLeft < 2) return undefined;
    const list = this.tasks.list;
    const open = list.filter((item) => item.status !== 'completed');
    const named = open.map((item) => `"${item.content}" (${item.status === 'in_progress' ? 'in progress' : 'pending'})`).join(', ');
    return [{ role: 'user', content: `<task-list-check>\nYour task list still shows ${open.length} of ${list.length} items not completed: ${named}. If you finished any of them, send TodoWrite now with the full list, marking completed only what is really done, and leave anything not done as it is. Then end your turn with one short line; do not repeat your answer.\n</task-list-check>` }];
  }

  /** At the end of a run, posts the list once more as unconfirmed when the run touched it and items are unfinished. Statuses are never changed here. */
  private settleTaskList(tasksAtStart: number): void {
    if (this.tasks.revision !== tasksAtStart && this.tasks.unfinished) this.post({ type: 'todos', todos: this.tasks.list, unconfirmed: true });
  }

  /** Moves a task-list item and shows the list at once, without waiting for sibling agents. */
  private moveTask(task: string, status: Todo['status']): string | undefined {
    const content = this.tasks.set(task, status);
    if (content !== undefined) this.post({ type: 'todos', todos: this.tasks.list });
    return content;
  }

  /** What an Agent result tells the main agent about its task list, so its next TodoWrite agrees with the host. */
  private taskNote(task: string | undefined, done: boolean): string {
    const lines: string[] = [];
    if (task) lines.push(done ? `Task list: "${task}" is now marked completed.` : `Task list: "${task}" is back to pending, because the agent did not finish.`);
    if (this.tasks.unfinished) lines.push('Update the task list with TodoWrite if this finished a task.');
    return lines.length ? `\n\n${lines.join('\n')}` : '';
  }

  /** Keeps each sub-agent's live status current from its own events. */
  private observe(agent: LiveAgent, event: AgentEvent): void {
    // A step finishing is worth showing at once, unlike the stream of activity updates.
    if (event.type === 'todos') { agent.todos = event.todos; return void this.postAgents(); }
    if (event.type === 'tool-start') { agent.toolCalls += 1; agent.lastAction = event.title; this.setActivity(agent, event.title); }
    else if (event.type === 'tool-end') this.setActivity(agent, 'Thinking');
    else if (event.type === 'reasoning') { this.setActivity(agent, 'Thinking'); return void this.schedulePostAgents(); }
    else if (event.type === 'text') this.setActivity(agent, 'Writing');
    else if (event.type === 'turn') agent.turns += 1;
    else if (event.type === 'retry') this.setActivity(agent, 'Retrying after NEAR AI went quiet');
    this.schedulePostAgents();
  }

  /** A progress line in the chat when nothing has appeared there for a while (sub-agents show only in the strip), so long runs show they are moving. */
  private heartbeat(runStartedAt: number): void {
    const quietFor = Date.now() - this.lastVisibleAt;
    const due = this.heartbeats === 0 ? this.progressTiming.firstMs : this.progressTiming.everyMs;
    if (quietFor < due) return;
    this.heartbeats += 1;
    this.lastVisibleAt = Date.now();
    // Consecutive progress lines replace each other in the chat, so a long quiet stretch is one updating line.
    const agents = [...this.agents.values()];
    // 0.4.23: a run held on an image review says so, rather than that the agent is thinking.
    const reviews = this.imageReviews.size;
    const reviewing = reviews ? `waiting for your review of ${reviews === 1 ? 'an image' : `${reviews} images`}` : undefined;
    const detail = agents.length
      ? `${reviewing ? `${reviewing} · ` : ''}${agents.map((agent) => `${agent.description || agent.label}: ${agent.paused ? 'paused' : agent.activity === 'Thinking' ? `thinking for ${minutesSince(agent.activitySince)}${agent.lastAction ? ` after ${agent.lastAction}` : ''}` : agent.activity} (${minutesSince(agent.startedAt)}, ${agent.toolCalls} tool call${agent.toolCalls === 1 ? '' : 's'})`).join(' · ')}`
      : reviewing ?? 'the agent is thinking';
    const spent = this.runCostUsd();
    const cost = spent > 0 ? ` · about $${spent.toFixed(2)} so far` : '';
    this.post({ type: 'progress', text: `Still working (${minutesSince(runStartedAt)}): ${detail}${cost}.` });
  }

  private markVisible(): void {
    this.lastVisibleAt = Date.now();
    this.heartbeats = 0;
  }

  private transcriptOf(model: string, messages: AgentMessage[]): Transcript {
    return { id: this.conversationId, title: this.title || 'Conversation', model, updatedAt: new Date().toISOString(), turns: messages.filter((message) => message.role === 'user').length, messages, display: [...this.display.entries()].filter(([key, typed]) => /^\/team:\S/.test(typed) || messages.some((message) => message.role === 'user' && contentKey(message.content) === key)) };
  }

  /**
   * Writes the messages not yet in the thread log (D-07). It does nothing unless the conversation is kept in a thread store, and a failure never stops
   * a run: the messages stay unlogged and the next call tries them again. Returns whether everything given is now in the log.
   */
  private async captureThread(model: string, messages: AgentMessage[]): Promise<boolean> {
    const store = this.transcripts;
    if (!(store instanceof ThreadStore) || messages.length < 2) return false;
    return store.captureTranscript(this.transcriptOf(model, messages), this.display, this.logged).then(() => true, () => false);
  }

  private async saveTranscript(model: string, messages = this.messages, during = false): Promise<boolean> {
    if (!this.transcripts || messages.length < 2) return false;
    await this.captureThread(model, messages);
    const transcript = this.transcriptOf(model, messages);
    return (during ? this.transcripts.checkpoint(transcript) : this.transcripts.save(transcript)).then(() => true, () => false);
  }

  /**
   * Saves a running run's state before each model turn: every step so far, with its result. If the
   * extension host dies mid-run (code-server closed it, a reload, a crash), Resume continues from here.
   */
  private async saveRunState(model: string, runId: string, messages: AgentMessage[]): Promise<void> {
    if (!(await this.saveTranscript(model, messages, true))) return;
    await this.runMarkers?.saved(this.conversationId, runId);
    try { this.onRunStateSaved?.(); } catch { /* a listener never breaks a run */ }
  }

  private tally(usage: UsageMetadata): void {
    const tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
    this.spend.totalTokens += tokens;
    this.spend.cachedTokens += usage.cachedInputTokens ?? 0;
    // Priced turns are bounded by the cost limit; the token limit is for models without known prices.
    if (usage.estimatedCostUsd !== undefined) this.spend.costUsd += usage.estimatedCostUsd;
    else this.spend.tokens += tokens;
  }

  /** The current or last run's estimated cost and tokens, across its sub-agents. */
  public get runSpend(): { costUsd: number; totalTokens: number; cachedTokens: number; unpricedTokens: number } {
    return { costUsd: this.runCostUsd(), totalTokens: this.spend.totalTokens, cachedTokens: this.spend.cachedTokens, unpricedTokens: this.spend.tokens };
  }

  /** The run's cost so far: every request in the ledger tagged with it (sub-agents, safety checks, summaries), or the model turns' estimates without a ledger. */
  private runCostUsd(): number {
    const source = this.runSpendSource;
    return source ? nanoToUsd(totalNanoUsd(source.account.totals({ runId: source.runId }))) : this.spend.costUsd;
  }

  /** Stops the whole run, keeping its work, once its estimated cost or tokens reach the budget. */
  private enforceBudget(request: AgentTurnRequest, abort: AbortController): void {
    if (this.spend.stopped) return;
    // The daily limit, before every model turn: NEAR's total for today when known, else this computer's ledger.
    const reached = this.runSpendSource?.account.limitReached();
    if (reached) {
      this.spend.stopped = true;
      this.post({ type: 'notice', text: `Stopped the run: today's NEAR AI spend ($${reached.spentUsd.toFixed(2)}${reached.source === 'near' ? ', from NEAR\'s usage summary' : ''}) reached your daily limit of $${reached.limitUsd.toFixed(2)} (nearAi.dailySpendLimitUsd). Everything it did is kept.` });
      abort.abort();
      return;
    }
    const budget = request.budget;
    if (!budget) return;
    const costUsd = this.runCostUsd();
    const overCost = costUsd >= budget.maxCostUsd;
    const overTokens = this.spend.tokens >= budget.maxTokens;
    if (!overCost && !overTokens) return;
    this.spend.stopped = true;
    this.post({ type: 'notice', text: overCost
      ? `Stopped the run: its estimated cost reached $${costUsd.toFixed(2)}, the limit for one run ($${budget.maxCostUsd.toFixed(2)}; nearAi.agent.maxRunCostUsd, and never more than what is left of nearAi.dailySpendLimitUsd). Everything it did is kept; send a message to continue.`
      : `Stopped the run: it used ${Math.round(this.spend.tokens).toLocaleString('en-US')} tokens on models without published prices, the limit for one run (nearAi.agent.maxRunTokens). Everything it did is kept; send a message to continue.` });
    abort.abort();
  }

  /** PERF-07: the run's wall time split and its whole token use, saved in its session when the main agent ends. */
  private async recordRunSplit(request: AgentTurnRequest, mainId: string, usage: UsageMetadata[]): Promise<void> {
    const stat = this.activity?.agentStat(mainId);
    if (!stat || !request.activity) return;
    const total = sumUsage(usage);
    await request.activity.store.setRunSplit(request.activity.sessionId, runSplitOf(stat, { inputTokens: total.inputTokens ?? 0, cachedInputTokens: total.cachedInputTokens ?? 0, outputTokens: total.outputTokens ?? 0 })).catch(() => undefined);
  }

  /**
   * Saves an ended agent's counters (no content) in its run's session in the project's activity
   * history, so the overview survives reloads; `outcome` is given for the run's main agent.
   */
  private async persistAgent(request: AgentTurnRequest, agentId: string, outcome?: RunOutcome | 'failed'): Promise<void> {
    const stat = this.activity?.agentStat(agentId);
    if (!stat || !request.activity) return;
    const saved = await request.activity.store.addStats(request.activity.sessionId, countersOf(stat), outcome ? { outcome } : undefined).catch(() => undefined);
    if (saved) this.activity?.markPersisted(agentId);
  }

  /** Mirrors an agent's events into the Agent Activity feed. */
  private track(agentId: string, event: AgentEvent): void {
    const feed = this.activity;
    if (!feed) return;
    if (event.type === 'text' || event.type === 'reasoning') feed.stream(agentId, event.type, event.text);
    else if (event.type === 'tool-start') feed.toolStarted(agentId, event.callId, event.title, event.input, event.tool);
    else if (event.type === 'tool-end') feed.toolEnded(agentId, event.callId, event.ok, event.output);
    else if (event.type === 'turn') feed.turn(agentId, event.usage);
    else if (event.type === 'retry') feed.retry(agentId, retryNotice(event), { status: event.status, delayMs: event.delayMs });
    else if (event.type === 'security') feed.security(agentId, event);
    else if (event.type === 'permission') feed.permission(agentId, event.decision);
  }

  private forward(event: AgentEvent, model: string, record: Record_): void {
    if (event.type === 'text') this.post({ type: 'assistant-delta', text: event.text });
    else if (event.type === 'tool-start') { this.toolStarts.set(event.callId, { tool: event.tool, at: Date.now() }); this.post({ type: 'tool-start', callId: event.callId, tool: event.tool, title: event.title }); void record({ status: 'running', kind: 'tool', tool: event.tool, summary: event.title.slice(0, 200) }); }
    else if (event.type === 'tool-end') {
      // PERF-07: the end names its tool and how long it ran, so a report can tell an approval timeout from a slow command without pairing events.
      const started = this.toolStarts.get(event.callId);
      this.toolStarts.delete(event.callId);
      // A sub-agent's call that returned "awaiting approval" ends here while its card stays open (PERF-01). The view closed every card whose call
      // ended, so a parked card vanished from the chat while it still counted on the badge (owner, 2026-11-14: a badge of 50 with nothing to answer).
      // The end now says so, and the view keeps the card until it is answered or closed.
      this.post({ type: 'tool-end', callId: event.callId, ok: event.ok, output: event.output, ...(this.waiting.has(event.callId) ? { stillWaiting: true } : {}) });
      void record({ status: event.ok ? 'completed' : 'failed', kind: 'tool', ...(started ? { tool: started.tool, durationMs: Date.now() - started.at } : {}), ...(event.output.startsWith(AWAITING_APPROVAL_PREFIX) ? { errorCode: 'approval-pending' } : {}), summary: event.ok ? 'Tool call finished.' : 'Tool call failed or was declined.' });
    }
    else if (event.type === 'retry') { this.post({ type: 'assistant-retry', discard: event.discardText, text: retryNotice(event) }); void record({ status: 'running', kind: 'model', model, summary: `Model turn failed; retrying (attempt ${event.attempt + 1}).` }); }
    else if (event.type === 'turn') this.tally(event.usage);
    if (event.type === 'turn') void record({ status: 'completed', kind: 'model', model: event.model || model, requestId: event.usage.requestId, summary: 'Model turn completed.', estimatedCostUsd: event.usage.estimatedCostUsd, inputTokens: event.usage.inputTokens, cachedInputTokens: event.usage.cachedInputTokens, cacheHit: (event.usage.cachedInputTokens ?? 0) > 0, outputTokens: event.usage.outputTokens, durationMs: event.usage.latencyMs });
  }

  /** Start time and tool of each call in flight, by call id, so its end event records both (PERF-07). */
  private readonly toolStarts = new Map<string, { tool: string; at: number }>();

  /** How long an approval may wait before the run is paused on it (and declined a day after that); 0 waits indefinitely. */
  public approvalTimeoutMs = 15 * 60_000;

  /** The prompts still waiting for the user, oldest first, marked as replays for a reloaded view. */
  public waitingPrompts(): Array<Record<string, unknown>> {
    return [...this.waiting.values()].map((message) => ({ ...message, replay: true }));
  }

  /** The run whose marker is live: set while a run is in progress, so its marker can say it is waiting on a person (the pick-up card reads it). */
  private markerRun: { conversationId: string; runId: string } | undefined;

  private openPrompt(id: string, message: Record<string, unknown>): void {
    this.waiting.set(id, message);
    if (this.markerRun) void this.runMarkers?.waiting(this.markerRun.conversationId, this.markerRun.runId, true);
    this.post(message);
    this.onWaitingChange?.(this.waiting.size);
  }

  /**
   * Forgets a waiting prompt; one cancelled by a stop or the run ending is reported so the view unpins it. `timedOut` (0.4.24): a question or an image
   * review nobody answered within the approval timeout, closed as timed out after that many minutes.
   */
  private closePrompt(id: string, cancelled = false, timedOut?: number): void {
    this.openCards.delete(id);
    if (!this.waiting.delete(id)) return;
    if (this.markerRun && this.waiting.size === 0) void this.runMarkers?.waiting(this.markerRun.conversationId, this.markerRun.runId, false);
    if (timedOut !== undefined) this.post({ type: 'prompt-closed', id, outcome: 'timed-out', minutes: timedOut });
    else if (cancelled) this.post({ type: 'prompt-closed', id, outcome: 'cancelled' });
    this.onWaitingChange?.(this.waiting.size);
  }

  /**
   * Each open approval card's run grants and the exact command an allow would grant there (only a card that is not held as risky has one), so an answer
   * that grants a command for the run also settles the other open cards that grant now covers.
   */
  private readonly openCards = new Map<string, { grants: RunGrants; command?: string; allowRule?: string; cover(): void }>();

  /**
   * An answer that granted a command for the rest of the run (allow for this run, always allow, or a late allow of a parked card) settles every other
   * open card of the same run for that exact command, or for the same saved allow entry, with the same answer: the grant already covers them, so leaving
   * them open only kept them on the badge. A card held as risky has no grant and is never settled this way (a risky action asks every time).
   */
  private settleCovered(request: ApprovalRequest, reply: ApprovalReply, late: boolean, grants: RunGrants): void {
    const command = request.grant?.command;
    if (!command) return;
    if (!(reply.decision === 'allow-run' || reply.decision === 'allow-always' || (late && reply.decision === 'allow'))) return;
    // "Always allow" saves the card's allow entry whether it was answered in time or late (lateApproval), so cards for the same entry are covered too.
    const rule = reply.decision === 'allow-always' ? request.allowRule : undefined;
    for (const [id, card] of [...this.openCards]) {
      if (id === request.callId || card.grants !== grants || !card.command || !this.approvals.has(id)) continue;
      if (card.command === command || (rule !== undefined && card.allowRule === rule)) card.cover();
    }
  }

  /** PERF-04: sub-agents that may run in their own git worktree at once (nearAi.agent.maxParallelWorktrees), within maxParallelAgents. */
  public maxParallelWorktrees = 4;
  private readonly worktreeSlots = new Slots();
  /** Models a member of this conversation's runs just left as overloaded or silent: other members do not move to them for a few minutes. */
  private readonly modelTrouble = new ModelTrouble();

  /** PERF-02: compact a transcript at this many tokens whatever the window (nearAi.agent.compactAtTokens; 0 uses only the window's thresholds). */
  public compactAtTokens = DEFAULT_COMPACT_AT_TOKENS;

  /** PERF-01: how long a sub-agent's approval card waits before the call returns "awaiting approval" (nearAi.agent.subagentApprovalWaitSeconds). */
  public subagentApprovalWaitMs = 20_000;
  /** PERF-01: consecutive "awaiting approval" outcomes that pause the run (nearAi.agent.approvalTimeoutsBeforePause; 0 never pauses). */
  public approvalTimeoutsBeforePause = 3;
  /**
   * Consecutive "awaiting approval" outcomes, per agent (agent review of PR 34): one agent's answered approval does not reset another agent's count,
   * so an agent that keeps stalling is caught even while its siblings' approvals are being answered.
   */
  private readonly approvalTimeoutStreaks = new Map<string, number>();
  private runPause: { wait: Promise<void>; release: () => void; limit: ReturnType<typeof setTimeout> } | undefined;
  /** How long a run may stay paused for unanswered approvals before it is stopped (review of PR 34: the same day the main approval path allows). */
  public runPauseLimitMs = 24 * 60 * 60_000;

  /** Holds every agent of the run before its next model turn while the run is paused for unanswered approvals. */
  private async whileRunPaused(signal: AbortSignal): Promise<void> {
    while (this.runPause && !signal.aborted) {
      const { wait } = this.runPause;
      await waitOrAbort(signal, (wake) => { void wait.then(wake); });
    }
  }

  /** Pauses the run after too many approvals in a row went unanswered, so it stops working around decisions nobody made. */
  private pauseRun(streak: number): void {
    if (this.runPause) return;
    let release = () => {};
    const wait = new Promise<void>((resolve) => { release = resolve; });
    // A pause has an end: after runPauseLimitMs with nobody back, the run is stopped cleanly and its work kept, rather than held open for ever.
    const limit = setTimeout(() => {
      if (this.runPause?.wait !== wait) return;
      this.resumeRun(false);
      this.post({ type: 'notice', text: `Stopped the run: it was paused for ${Math.round(this.runPauseLimitMs / 3_600_000) || 1} hour${Math.round(this.runPauseLimitMs / 3_600_000) === 1 ? '' : 's'} on approvals nobody answered. Everything it did is kept; send a message to continue.` });
      this.halt();
    }, this.runPauseLimitMs);
    limit.unref?.();
    this.runPause = { wait, release, limit };
    for (const id of [this.mainAgentId, ...this.agents.keys()]) if (id) this.activity?.setPaused(id, true);
    this.post({ type: 'notice', text: `Paused: ${streak} approvals in a row went unanswered for one agent, so the run stopped before its next step instead of carrying on without them. Answer a waiting approval, press Resume on an agent, or send a message to carry on.` });
  }

  /**
   * The person is back (the window regained focus, or they used the chat): a run paused for unanswered approvals carries on, and its cards are still
   * there for them to answer (review of PR 34).
   */
  public userActive(): void { this.resumeRun(); }

  /** Ends a pause; `announce` false when the run is ending anyway. */
  private resumeRun(announce = true): void {
    const pause = this.runPause;
    if (!pause) return;
    this.runPause = undefined;
    clearTimeout(pause.limit);
    this.approvalTimeoutStreaks.clear();
    for (const id of [this.mainAgentId, ...this.agents.keys()]) if (id) this.activity?.setPaused(id, false);
    pause.release();
    if (announce) this.post({ type: 'notice', text: 'Resumed.' });
  }

  /**
   * A queued sub-agent approval answered after the agent moved on: an allow grants that exact command for the run, and the lead is told either way. A floor
   * card (publishing, destruction, a write into `.git/` or NEAR AI's state) grants nothing for the run: an allow lets that exact call run once, and the
   * next identical call asks again (D-43, Pitfall 4).
   */
  private lateApproval(label: string, approval: ApprovalRequest, reply: ApprovalReply, grants: RunGrants, remember: ((rule: string) => void | Promise<void>) | undefined, clock: () => number): void {
    const allowed = reply.decision === 'allow' || reply.decision === 'allow-run' || reply.decision === 'allow-always';
    if (approval.floor) {
      // Never grants.commands, grants.edits or an allow rule: the approval is kept beside the grants and is used up by the one call it names.
      // Stamped with the clock of the gate that will check it (the runtime's), so the approval's time limit is read on one clock.
      if (allowed) approveFloorCallLate(grants, approval.floor.callKey, clock);
      const shown = approval.subject ? `\`${approval.subject.slice(0, 300)}\`` : `"${approval.title.slice(0, 200)}"`;
      this.notifications.push({ role: 'user', content: allowed
        ? `<approval-update agent="${label}" decision="allowed-once">\nThe user approved ${shown}, which ${label} had queued. This kind of action needs a person every time, so it is allowed once: run that exact call again (the same tool and arguments, from the same folder) if it is still needed. Any further run of it asks again.\n</approval-update>`
        : `<approval-update agent="${label}" decision="declined">\nThe user declined ${shown}, which ${label} had queued.${reply.feedback ? ` Their note: ${reply.feedback}` : ''} Do not run it; adjust instead.\n</approval-update>` });
      return;
    }
    // "Always allow" on a parked card saves its allow entry, exactly as it does on a card answered in time (owner, 2026-11-14): before, a late answer
    // only granted the command for the run, so the same command asked again in the next run. Only the entry the card offered is saved: the offer was
    // already checked to cover this command and nothing wider, and a held (risky) card offers none.
    // Only a card that carries a grant (#47 review): a card held as risky grants nothing, so a late answer to it never saves an entry either.
    const rule = reply.decision === 'allow-always' && approval.grant?.command ? approval.allowRule : undefined;
    let saved = false;
    if (rule && remember) {
      grants.allowRules.add(rule);
      saved = true;
      void Promise.resolve().then(() => remember(rule)).catch(() => undefined);
    }
    // The grant recorded on the card when it was made (review of PR 34: the subject line was not always set, so an allow could grant nothing while the
    // lead was told it was allowed). The lead hears "allowed for the run" only when a grant really took effect.
    const command = approval.grant?.command;
    let granted = false;
    if (allowed && command) { grants.commands.add(command); granted = grants.commands.has(command); }
    if (allowed && approval.grant?.edits) { grants.edits = true; granted = true; }
    const what = command ? `\`${command.slice(0, 300)}\`` : `"${approval.title.slice(0, 200)}"`;
    this.notifications.push({ role: 'user', content: allowed && granted
      ? `<approval-update agent="${label}" decision="allowed">\nThe user approved ${what}, which ${label} had queued. It is now allowed ${saved ? 'every time, in this run and later ones' : 'for the rest of this run'}: run it, or have an agent run it, if it is still needed.\n</approval-update>`
      : allowed
        ? `<approval-update agent="${label}" decision="approved-once">\nThe user approved ${what}, which ${label} had queued, but this kind of action asks every time, so nothing was allowed for the rest of the run. If it is still needed, run it again: it will ask again.\n</approval-update>`
        : `<approval-update agent="${label}" decision="declined">\nThe user declined ${what}, which ${label} had queued.${reply.feedback ? ` Their note: ${reply.feedback}` : ''} Do not run it; adjust instead.\n</approval-update>` });
  }

  private askApproval(request: ApprovalRequest, signal: AbortSignal, agent?: string, agentId?: string, unattended?: { waitMs: number; onLate(reply: ApprovalReply): void }, grants?: RunGrants): Promise<ApprovalReply> {
    if (signal.aborted) return Promise.resolve({ decision: 'deny' });
    if (agentId) this.activity?.approvalAsked(agentId);
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let parkLimit: ReturnType<typeof setTimeout> | undefined;
      // A day past the first timeout, which is long enough that nobody is surprised and short enough that an abandoned run does not live for ever.
      const parkLimitMs = PARK_LIMIT_MS;
      /** Set once the call has returned "awaiting approval": a later answer goes to `onLate`, not to the finished call. */
      let returned = false;
      /** `covered`: settled by an answer to another card whose grant covers this one, which must not in turn settle others. */
      const settle = (reply: ApprovalReply, cancelled = false, covered = false) => {
        if (timer) clearTimeout(timer);
        if (parkLimit) clearTimeout(parkLimit);
        this.closePrompt(request.callId, cancelled);
        if (!cancelled) { this.approvalTimeoutStreaks.delete(agentId ?? 'main'); this.resumeRun(); }
        if (returned) {
          if (!cancelled) unattended?.onLate(reply);
        } else {
          if (agentId) this.activity?.approvalSettled(agentId, cancelled ? 'cancelled' : reply.decision === 'deny' ? 'declined' : 'allowed');
          resolve(reply);
        }
        if (!cancelled && !covered && grants) this.settleCovered(request, reply, returned, grants);
      };
      this.approvals.set(request.callId, settle);
      if (grants) {
        this.openCards.set(request.callId, {
          grants, ...(request.grant?.command ? { command: request.grant.command } : {}), ...(request.allowRule ? { allowRule: request.allowRule } : {}),
          cover: () => {
            if (!this.approvals.delete(request.callId)) return;
            // The view shows why the card went away: the person's answer to the same command already allowed it.
            this.post({ type: 'prompt-closed', id: request.callId, outcome: 'covered' });
            settle({ decision: 'allow' }, false, true);
          }
        });
      }
      signal.addEventListener('abort', () => {
        if (!this.approvals.delete(request.callId)) return;
        // A card parked after "awaiting approval" belongs to an agent that has now been stopped: it is removed (review of PR 34), so it cannot linger for
        // a day or grant anything to a run that no longer wants it. A later answer for it finds nothing and does nothing.
        if (returned) { if (parkLimit) clearTimeout(parkLimit); this.closePrompt(request.callId, true); return; }
        settle({ decision: 'deny' }, true);
      }, { once: true });
      if (unattended) {
        // PERF-01: the sub-agent goes back to work after a short wait; its card stays open (until the run ends, or a day at most).
        timer = setTimeout(() => {
          if (!this.approvals.has(request.callId)) return;
          returned = true;
          if (agentId) this.activity?.approvalTimedOut(agentId);
          const streak = (this.approvalTimeoutStreaks.get(agentId ?? 'main') ?? 0) + 1;
          this.approvalTimeoutStreaks.set(agentId ?? 'main', streak);
          // Paused before the call returns, so the agent's next call in the same batch already waits (agent review of PR 34).
          if (this.approvalTimeoutsBeforePause > 0 && streak >= this.approvalTimeoutsBeforePause) this.pauseRun(streak);
          resolve({ decision: 'pending' });
          parkLimit = setTimeout(() => { if (this.approvals.delete(request.callId)) this.closePrompt(request.callId, true); }, parkLimitMs);
          parkLimit.unref?.();
        }, Math.max(0, unattended.waitMs));
      } else if (this.approvalTimeoutMs > 0) {
        timer = setTimeout(() => {
          // 0.4.19 (owner, 2026-11-07: "stop the idling"): the wait no longer ends by declining an action nobody saw. Measured on the owner's own runs,
          // 35 waits hit this timeout exactly and 49 more ran long, which is up to 752 minutes of a run parked on a question. Declining made the run work
          // around a decision the person never got to make, and the work was usually redone. Now the run simply stops counting down and stays on this
          // step: nothing runs, nothing is lost, and answering whenever the person is back carries on from exactly here.
          if (!this.approvals.has(request.callId)) return;
          const minutes = Math.round(this.approvalTimeoutMs / 60_000);
          this.post({
            type: 'approval-paused', callId: request.callId, minutes,
            text: `No one answered "${request.title}" within ${minutes} minute${minutes === 1 ? '' : 's'}, so the run is paused on this step. It has not run. Approve or decline it and the run carries on from here.`
          });
          if (agentId) this.activity?.approvalExpired(agentId);
          // 0.4.19 review: a parked run had no end at all, so an abandoned conversation kept the run and its sub-agents alive for ever. After a generous
          // final wait (a whole working day past the first timeout) the prompt is declined, and the message says it was the long limit, not the person.
          parkLimit = setTimeout(() => {
            if (!this.approvals.delete(request.callId)) return;
            this.post({
              type: 'approval-expired', callId: request.callId, minutes: Math.round(parkLimitMs / 60_000),
              text: `"${request.title}" waited a whole day without an answer, so it was declined and the run was released.`
            });
            settle({ decision: 'deny', feedback: 'Nobody answered for a day, so this action was declined and the run released. Ask again if it is still wanted.' });
          }, parkLimitMs);
        }, this.approvalTimeoutMs);
      }
      // 0.4.17: the card also carries the plain risk headline and the whole reason, and the exact command or code, so it can say why in one
      // sentence and let the person expand to see exactly what will run.
      this.openPrompt(request.callId, {
        type: 'approval-request', callId: request.callId, tool: request.tool, title: request.title, preview: request.preview,
        ...(request.reason ? { reason: request.reason } : {}), ...(request.allowRule ? { allowRule: request.allowRule } : {}), ...(agent ? { agent } : {}),
        ...(request.risk ? { risk: request.risk } : {}), ...(request.reasonShort ? { reasonShort: request.reasonShort } : {}), ...(request.subject ? { subject: request.subject } : {}),
        // A floor card offers one call only: the page shows no "for this run" choice for it (GATE-04, D-43).
        ...(request.floor ? { floor: true } : {})
      });
    });
  }

  /** The approval timeout in whole minutes, for the messages about a question or image review that waited that long (0.4.24). */
  private get promptLimitMinutes(): number { return Math.max(1, Math.round(this.approvalTimeoutMs / 60_000)); }

  /**
   * Whether a question or image review may end on its own once the approval timeout passes (owner, 0.4.24): only in Full auto, where nobody is expected to
   * be watching, and for a background sub-agent, which nobody may be watching. Everywhere else it waits like an approval does in that mode.
   */
  private promptMayTimeOut(policy: ActionPolicy | undefined, agentId: string | undefined): boolean {
    return policy?.mode === 'fully-autonomous' || (agentId !== undefined && this.agents.get(agentId)?.background === true);
  }

  /**
   * Waits for the person's answer to a question or image review (0.4.24, review of PR 51: before, these had no limit at all).
   *
   * - `mayTimeOut` (Full auto, or a background sub-agent): the wait ends at the approval timeout, resolving 'timed-out'.
   * - Otherwise it reuses the approvals' park (askApproval): at the timeout the run is paused on this step with `approval-paused`, the card stays open
   *   and answerable, and nothing is decided for the person (0.4.19: never decide something nobody saw). Only after the same day-long limit as an approval
   *   is it released, resolving 'released' with `approval-expired`, so an abandoned conversation does not live for ever.
   *
   * 0 (nearAi.agent.approvalTimeoutMinutes) waits indefinitely in both cases.
   */
  private waitForPerson(id: string, signal: AbortSignal, register: (wake: () => void) => void, mayTimeOut: boolean, paused: (minutes: number) => string, released: string): Promise<'woken' | 'aborted' | 'timed-out' | 'released'> {
    if (mayTimeOut) return waitOrAbort(signal, register, this.approvalTimeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let parkLimit: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    return waitOrAbort(signal, (wake) => {
      register(wake);
      if (this.approvalTimeoutMs <= 0) return;
      timer = setTimeout(() => {
        if (!this.waiting.has(id)) return;
        const minutes = this.promptLimitMinutes;
        this.post({ type: 'approval-paused', callId: id, minutes, text: paused(minutes) });
        parkLimit = setTimeout(() => {
          if (!this.waiting.has(id)) return;
          expired = true;
          this.post({ type: 'approval-expired', callId: id, minutes: Math.round(PARK_LIMIT_MS / 60_000), text: released });
          wake();
        }, PARK_LIMIT_MS);
        parkLimit.unref?.();
      }, this.approvalTimeoutMs);
    }).then((how) => {
      if (timer) clearTimeout(timer);
      if (parkLimit) clearTimeout(parkLimit);
      return expired && how === 'woken' ? 'released' : how;
    });
  }

  /**
   * 0.4.24 (review of PR 51): a question no longer waits without limit. In Full auto or a background sub-agent it ends at the approval timeout: each
   * question is answered QUESTION_TIMED_OUT, the card closes as timed out, and the agent carries on with its own judgement. In every other mode it parks the
   * run like an approval: the card stays and the answer, whenever it comes, carries the run on from here.
   */
  private askQuestions(questions: Question[], signal: AbortSignal, policy?: ActionPolicy, agentId?: string): Promise<string[]> {
    if (signal.aborted) return Promise.resolve([]);
    const id = `q-${randomBytes(6).toString('hex')}`;
    const title = questions.length === 1 ? `"${questions[0].question.slice(0, 200)}"` : `${questions.length} questions`;
    // waitOrAbort removes its abort listener once answered, so a long run's questions do not pile listeners up on its signal (agent review of PR 51).
    let reply: { answers: string[]; cancelled: boolean } | undefined;
    // 0.4.28: a question puts the agent asking it in "waiting for you" on the activity feed, as an approval and an image review do (it did not before,
    // so a sub-agent waiting on a question looked busy); the strip says what it waits for.
    if (agentId) this.activity?.waitingForUser(agentId, true, 'question');
    const live = agentId ? this.agents.get(agentId) : undefined;
    const before = live?.activity;
    if (live) { this.setActivity(live, 'Waiting for your answer'); this.postAgents(); }
    return this.waitForPerson(id, signal, (wake) => {
      this.questions.set(id, (answers: string[], cancelled = false) => { reply = { answers, cancelled }; wake(); });
      this.openPrompt(id, { type: 'questions-request', id, questions });
    }, this.promptMayTimeOut(policy, agentId),
    (minutes) => `No one answered ${title} within ${minutes} minute${minutes === 1 ? '' : 's'}, so the run is paused on this question. Answer it and the run carries on from here.`,
    `${title} waited a whole day without an answer, so the run was released.`).then((how) => {
      if (!reply && (how === 'timed-out' || how === 'released')) {
        this.questions.delete(id);
        if (how === 'timed-out') this.closePrompt(id, true, this.promptLimitMinutes);
        else this.closePrompt(id);
        return questions.map(() => how === 'timed-out' ? QUESTION_TIMED_OUT : QUESTION_RELEASED);
      }
      if (!reply) { this.questions.delete(id); reply = { answers: [], cancelled: true }; }
      this.closePrompt(id, reply.cancelled);
      return reply.answers;
    }).finally(() => { if (agentId) this.activity?.waitingForUser(agentId, false, 'question'); this.endPersonWait(live, 'Waiting for your answer', before); });
  }

  /** The image reviewer of this conversation: drafts in the project, cards in this conversation's chat (a sub-agent's too, labelled with it). */
  private imageReviewer(policy?: ActionPolicy): ImageReviewer {
    return { root: this.root, drafts: this.imageReviewState.drafts, attempts: this.imageReviewState.attempts, review: (draft, signal) => this.askImageReview(draft, signal, policy) };
  }

  /**
   * Shows a draft in the chat and waits for the person, like a question: it is pinned, replayed to a reloaded view, counted on the badge and in the run's
   * marker as waiting on a person, and cancelled (the draft kept) when the run or the agent stops. The image goes in the card as a data URL (the view's
   * CSP allows data: images), up to MAX_PREVIEW_BYTES; a larger one is opened full size instead. 0.4.24: like a question, in Full auto or a background
   * sub-agent it ends at the approval timeout (cancelled with `timedOut`, the draft kept, the card closed as timed out); in every other mode it parks the
   * run like an approval, with the card kept open, and after the day-long park limit ends as `released` (the draft kept).
   */
  private async askImageReview(draft: ImageDraft, signal: AbortSignal, policy?: ActionPolicy): Promise<ImageReviewDecision> {
    if (signal.aborted) return { decision: 'cancelled' };
    const bytes = await readFile(draft.file).catch(() => undefined);
    if (signal.aborted) return { decision: 'cancelled' };
    // 0.4.25: an empty draft file (zero bytes) has no image either, so it is gone like a missing one, never an image or too large to show.
    const present = bytes?.length ? bytes : undefined;
    const image = present && present.length <= MAX_PREVIEW_BYTES ? `data:image/png;base64,${present.toString('base64')}` : undefined;
    const live = draft.agentId ? this.agents.get(draft.agentId) : undefined;
    if (draft.agentId) this.activity?.waitingForUser(draft.agentId, true);
    const before = live?.activity;
    if (live) { this.setActivity(live, 'Waiting for your image review'); this.postAgents(); }
    // waitOrAbort removes its abort listener once answered, so each review does not leave one on the run's signal (agent review of PR 51).
    let answer: { reply: ImageReviewDecision; cancelled: boolean } | undefined;
    const how = await this.waitForPerson(draft.id, signal, (wake) => {
      this.imageReviews.set(draft.id, (reply: ImageReviewDecision, cancelled = false) => { answer = { reply, cancelled }; wake(); });
      this.openPrompt(draft.id, {
        type: 'image-review-request', id: draft.id, path: draft.path, model: draft.model, prompt: draft.prompt, attempt: draft.attempt, sizeKb: Math.max(1, Math.round(draft.bytes / 1024)),
        // 0.4.24: a draft that could not be read is gone (removed by hand, or by a clean-up), which is not the same as too large to show.
        ...(image ? { image } : present ? { tooLarge: true } : { missing: true }), ...(draft.agent ? { agent: draft.agent } : {}), ...(draft.editOf ? { editOf: draft.editOf } : {}), ...(draft.note ? { note: draft.note } : {})
      });
    }, this.promptMayTimeOut(policy, draft.agentId),
    (minutes) => `No one reviewed the image for ${draft.path} within ${minutes} minute${minutes === 1 ? '' : 's'}, so the run is paused on this step. Nothing was saved. Accept, request changes or discard it and the run carries on from here.`,
    `The image for ${draft.path} waited a whole day without a review, so the run was released. The draft is kept.`);
    if (!answer && (how === 'timed-out' || how === 'released')) {
      this.imageReviews.delete(draft.id);
      if (how === 'timed-out') {
        this.closePrompt(draft.id, true, this.promptLimitMinutes);
        answer = { reply: { decision: 'cancelled', timedOut: this.promptLimitMinutes }, cancelled: true };
      } else {
        // Released after the day-long park (the chat already said so with approval-expired): its own outcome, so the agent is not told it timed out.
        this.closePrompt(draft.id);
        answer = { reply: { decision: 'released' }, cancelled: true };
      }
    } else {
      if (!answer) { this.imageReviews.delete(draft.id); answer = { reply: { decision: 'cancelled' }, cancelled: true }; }
      this.closePrompt(draft.id, answer.cancelled);
    }
    if (draft.agentId) this.activity?.waitingForUser(draft.agentId, false);
    this.endPersonWait(live, 'Waiting for your image review', before);
    return answer.reply;
  }

  /**
   * Review of PR 72: when a wait on the person ends, the agent's activity goes back to what it said before, unless something newer has replaced the
   * waiting words meanwhile; the running-agents row then stops saying it waits for you.
   */
  private endPersonWait(live: LiveAgent | undefined, waiting: string, before: string | undefined): void {
    if (!live || live.activity !== waiting) return;
    this.setActivity(live, before && before !== waiting ? before : 'Thinking');
    this.postAgents();
  }

  private releasePending(): void {
    const approvals = [...this.approvals.values()];
    const questions = [...this.questions.values()];
    const reviews = [...this.imageReviews.values()];
    this.approvals.clear();
    this.questions.clear();
    this.imageReviews.clear();
    for (const settle of approvals) settle({ decision: 'deny' }, true);
    for (const settle of questions) settle([], true);
    for (const settle of reviews) settle({ decision: 'cancelled' }, true);
  }
}

/** How many of these messages are background agents' reports (not approval updates). */
const reportCount = (messages: AgentMessage[]) => messages.filter((message) => typeof message.content === 'string' && message.content.startsWith('<agent-notification ')).length;

/** What each question answers when nobody answered within the approval timeout, in Full auto or a background sub-agent only (0.4.24). */
export const QUESTION_TIMED_OUT = '(no answer, timed out)';
/** What each question answers when, in another mode, it waited the whole day-long park limit without an answer and the run was released (0.4.24). */
export const QUESTION_RELEASED = '(no answer: nobody answered for a day, so the run was released; ask again if it still matters)';

/** How long past the approval timeout a parked approval, question or image review waits before the run is released: a whole day (0.4.19 review). */
export const PARK_LIMIT_MS = 24 * 60 * 60_000;

/** The largest draft shown inside the review card; a larger one is shown with "Open full size" only, to keep the chat's messages small. */
export const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;

/**
 * Waits until `register`'s wake function is called or the signal aborts, whichever comes first, and removes its abort listener either way (review of
 * PR 34: a listener added per wait and never removed piled up on a long run's signal). With `timeoutMs` above 0 it also ends after that long. It
 * resolves with what ended it.
 */
/**
 * 0.4.28 (review of PR 72): the state the chat's team dots show, as a machine word from the activity feed's phase, never read back from the activity
 * wording. Without a feed it falls back to what the session knows itself.
 */
export function agentDotState(agent: { paused: boolean }, stat?: { phase: AgentPhase }): 'paused' | 'needs-you' | 'queued' | 'waiting' | 'working' {
  if (agent.paused || stat?.phase === 'paused') return 'paused';
  if (stat?.phase === 'waiting-you') return 'needs-you';
  if (stat?.phase === 'queued') return 'queued';
  if (stat?.phase === 'waiting-agents') return 'waiting';
  return 'working';
}

export function waitOrAbort(signal: AbortSignal, register: (wake: () => void) => void, timeoutMs = 0): Promise<'woken' | 'aborted' | 'timed-out'> {
  if (signal.aborted) return Promise.resolve('aborted');
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (how: 'woken' | 'aborted' | 'timed-out') => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      resolve(how);
    };
    const aborted = () => finish('aborted');
    signal.addEventListener('abort', aborted, { once: true });
    // 0.4.24: a wait with a limit (the approval timeout, for questions and image reviews) ends on its own, so an unattended run is not held for good.
    if (timeoutMs > 0) timer = setTimeout(() => finish('timed-out'), timeoutMs);
    register(() => finish('woken'));
  });
}

/** A counting limit whose waiters wake in turn; a waiter whose signal aborts stops waiting and takes nothing. */
export class Slots {
  private used = 0;
  private waiters: Array<() => void> = [];
  public get inUse(): number { return this.used; }
  public async acquire(limit: number, signal: AbortSignal): Promise<void> {
    while (this.used >= Math.max(1, limit)) {
      if (signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
      await waitOrAbort(signal, (wake) => this.waiters.push(wake));
    }
    if (signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    this.used += 1;
  }
  public release(): void {
    this.used = Math.max(0, this.used - 1);
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }
}

/** The memory actor the runner writes as; the host registers it as trusted when it creates the memory service. */
export const AGENT_MEMORY_ACTOR = 'near-ai-agent';

/** Maps an agent definition name onto the reputation roles. */
export function roleFor(label: string): AgentRole | undefined {
  const name = label.toLowerCase();
  if (/secur/.test(name)) return 'security';
  if (/plan/.test(name)) return 'planner';
  if (/research|mapper|analy/.test(name)) return 'researcher';
  if (/test|nyquist|uat/.test(name)) return 'tester';
  if (/review|check|verif|audit/.test(name)) return 'reviewer';
  if (/exec|implement|fix|writer|build/.test(name)) return 'implementer';
  return undefined;
}

/** Finds a skill by its name, its name without the `gsd-` prefix, or a legacy `gsd:name` form. */
export function findSkill(skills: GsdSkill[], name: string): GsdSkill | undefined {
  const wanted = name.replace(/^\//, '').trim();
  return skills.find((skill) => skill.name === wanted) ?? skills.find((skill) => skill.name === `gsd-${wanted}` || skill.name.replace(/:/g, '-') === wanted);
}

/** The result a resumed transcript gives a tool call whose result was never saved (the run was cut off while it ran, or before it started). */
export const MISSING_RESULT = 'No result was recorded: the run was cut off while this call was running (or before it started). It may or may not have taken effect. Check (the files, git status, or what it would have changed) before repeating it.';

/**
 * PERF-05: a saved transcript made valid to continue from. Every assistant tool call gets exactly one result; one that has none (the run was cut off
 * mid-batch) gets MISSING_RESULT, placed after the results that were saved. Results that were saved are kept as they are, so a resumed run sees every
 * finished call's real output and has no reason to run it again. A transcript that needs no repair is returned unchanged.
 */
export function repairTranscript(messages: AgentMessage[]): AgentMessage[] {
  const repaired: AgentMessage[] = [];
  let changed = false;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    repaired.push(message);
    if (message.role !== 'assistant' || !message.tool_calls?.length) continue;
    const answered = new Set<string>();
    while (index + 1 < messages.length && messages[index + 1].role === 'tool') {
      const result = messages[index + 1] as Extract<AgentMessage, { role: 'tool' }>;
      answered.add(result.tool_call_id);
      repaired.push(result);
      index += 1;
    }
    for (const call of message.tool_calls) {
      if (answered.has(call.id)) continue;
      changed = true;
      repaired.push({ role: 'tool', tool_call_id: call.id, content: MISSING_RESULT });
    }
  }
  return changed ? repaired : messages;
}

/** What a reopened conversation shows: every entry of its log (a thread store), or the visible turns of its saved messages (any other store). */
export type RestoredView = Array<{ role: 'user' | 'assistant'; text: string; tools: number }> | { items: ViewItem[] };

/** The user-visible turns of a saved conversation: what the user typed and what the agent answered. */
export function visibleTurns(messages: AgentMessage[], display = new Map<string, string>()): Array<{ role: 'user' | 'assistant'; text: string; tools: number }> {
  const turns: Array<{ role: 'user' | 'assistant'; text: string; tools: number }> = [];
  for (const message of messages) {
    const shown = message.role === 'user' ? display.get(contentKey(message.content)) : undefined;
    if (shown !== undefined) { turns.push({ role: 'user', text: shown, tools: 0 }); continue; }
    if (message.role === 'user') {
      if (message.content.startsWith('<agent-notification') || message.content.startsWith('<conversation-summary>') || message.content.startsWith('<task-list-check>')) continue;
      turns.push({ role: 'user', text: commandForm(message.content) ?? message.content, tools: 0 });
    } else if (message.role === 'assistant') {
      const last = turns.at(-1);
      if (last?.role === 'assistant') { last.text += message.content ? `${last.text ? '\n\n' : ''}${message.content}` : ''; last.tools += message.tool_calls?.length ?? 0; }
      else turns.push({ role: 'assistant', text: message.content ?? '', tools: message.tool_calls?.length ?? 0 });
    }
  }
  return turns;
}

/** Where the run's models run, for the Agent Activity badge; sub-agents use models at least as private. */
function runBoundary(request: Pick<AgentTurnRequest, 'local' | 'privacy'>): AgentBoundary | undefined {
  if (request.local || request.privacy.startsWith('Local')) return 'local';
  if (request.privacy.startsWith('Private')) return 'tee';
  if (request.privacy.startsWith('Not private')) return 'cloud';
  return undefined;
}

export function retryNotice(event: Extract<AgentEvent, { type: 'retry' }>): string {
  const stall = event.stall ? `, retry ${event.stall.retry} of ${event.stall.of} before the run stops` : '';
  return `${event.reason} Retrying in ${Math.round(event.delayMs / 1000)} s (attempt ${event.attempt + 1}${stall}); the run continues from where it was.`;
}

/** A new conversation ID (the host names a tab before its agent exists). */
export function newConversationId(): string {
  return `conv-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

/** A spend figure for the webview: its text and what it means. */
export function spendLine(view: { text: string; tooltip: string; source: string }): { text: string; tooltip: string; source: string } {
  return { text: view.text, tooltip: view.tooltip, source: view.source };
}

function sumUsage(turns: UsageMetadata[]): UsageMetadata {
  const total: UsageMetadata = { verificationStatus: 'unknown', latencyMs: turns.reduce((sum, turn) => sum + turn.latencyMs, 0) };
  const add = (key: 'inputTokens' | 'cachedInputTokens' | 'outputTokens' | 'estimatedCostUsd') => {
    const values = turns.map((turn) => turn[key]).filter((value): value is number => value !== undefined);
    if (values.length) total[key] = values.reduce((sum, value) => sum + value, 0);
  };
  add('inputTokens');
  add('cachedInputTokens');
  add('outputTokens');
  add('estimatedCostUsd');
  return total;
}

/** PERF-02: the most of a sub-agent's report its lead takes into its own context. */
export const MAX_REPORT_CHARS = 12_000;

/** A sub-agent's report, cut to MAX_REPORT_CHARS with a note, so a long report does not fill the lead's context (the lead wants a summary, not a transcript). */
export function boundedReport(report: string, label: string): string {
  if (report.length <= MAX_REPORT_CHARS) return report;
  return `${report.slice(0, MAX_REPORT_CHARS)}\n\n[${label}'s report was cut to ${MAX_REPORT_CHARS.toLocaleString('en-US')} of ${report.length.toLocaleString('en-US')} characters to keep your context small. Anything it wrote to files is there in full; ask it for a shorter summary if you need the rest.]`;
}

/** The sentence for a run that stopped before the model finished, or undefined when it finished (or was cancelled). */
export function stopNotice(result: Pick<RunResult, 'outcome' | 'stop'>): string | undefined {
  if (result.outcome === 'stuck') {
    if (result.stop?.kind === 'loop') return `Stopped: the agent kept repeating ${result.stop.action} with the same result.`;
    if (result.stop?.kind === 'output-limit') return 'Stopped: the agent\'s replies kept running past the output limit.';
    return 'Stopped: the agent was not making progress.';
  }
  if (result.outcome === 'max-turns') return result.stop?.kind === 'turn-limit' ? `Stopped after reaching the turn limit (${result.stop.turns} turns).` : 'Stopped after reaching the turn limit.';
  return undefined;
}

/**
 * Whether a folder is inside a git checkout: its own .git, or one in a parent folder. A workspace opened at a monorepo subfolder, and an isolated
 * agent's copy of that subfolder inside its worktree, have no .git of their own, yet they are in a repository and the agent may commit there.
 */
function insideGitRepo(root: string): boolean {
  for (let dir = path.resolve(root); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, '.git'))) return true;
    if (path.dirname(dir) === dir) return false;
  }
}
