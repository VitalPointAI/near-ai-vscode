import * as path from 'node:path';
import type { AgentTool, ToolContext } from '../agent/tools';
import { DEFAULT_RULES, decidePermission, intrusiveGrantDecision, type IntrusiveStep, type PermissionRules, type RunGrants } from '../agent/permissions';
import { verifyFinding, type CriticEvidence } from '../agent/cyberCritic';
import { checkBudget, type RateLimiter } from '../domain/cyberLimits';
import { compactSteps, ROLE_PROMPTS, type ProtocolStepRecord, type Step, type StepRole } from '../domain/cyberProtocol';
import { profileChecks } from '../domain/cyber';
import { needsReacceptance, scopeFingerprint, type AcceptanceSnapshot } from '../domain/cyberLegal';
import type { CyberMode, DepthProfile, DisclaimerAcceptance, Engagement, Finding, ResolvedScope } from '../domain/cyber';
import { hardeningAdvice, isoTimestamp, SEVERITY_RANK } from '../domain/cyber';
import { redactSecrets } from '../domain/redaction';
import type { AskRoleResult } from '../agent/cyberProtocolDriver';
import { FINDING_MARKER, type CyberEvidenceStore, type CyberLedgerStore } from './cyberLedgerStore';
import { runHostTool, HostToolError, type HostToolDeps } from './cyberHostTools';
import { TOOL_CATALOGUE } from './cyberTools';

// The run engine (CYBER-04, CYBER-05, CYBER-11; D-19, D-20, D-22). Four roles, four model calls,
// one JSON-in-text protocol: nothing is executed because an assistant message contained a native
// tool-call array, which a raw-completion model never emits. Every step passes the production
// permission path before its tool runs, every step is a ledger entry, findings are persisted into
// the chain, and replay re-renders them with no network and no tool.

export type CyberRunOutcome = 'completed' | 'stopped' | 'incompatible' | 'refused';

export type CyberRunEvent =
  | { type: 'step-started'; step: Step }
  | { type: 'step-finished'; step: Step; result: string; evidenceHash: string }
  | { type: 'finding'; finding: Finding; verified: boolean }
  | { type: 'notice'; text: string }
  | { type: 'incompatible'; role: StepRole; reason: string }
  | { type: 'done'; outcome: CyberRunOutcome; runId: string };

/** The one seam the run needs from the protocol driver (25-02). */
export interface RoleDriver { askRole(role: StepRole, messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>, signal?: AbortSignal): Promise<AskRoleResult> }

/** A tool the run may execute, plus the capability it runs under and the target it aims at. */
export interface RunTool {
  tool: AgentTool<any>;
  /** 'shell' for the exploit and host-tool steps, 'read' for probes. */
  capability: 'read' | 'shell';
  /** Builds the tool input from a step; the default passes the step's args through. */
  input?(step: Step): Record<string, unknown>;
  /** The target a step aims at, for the scope check and the intrusive grant. */
  target?(step: Step): string;
  /**
   * The findings the tool reported while it ran. Probes built by cyberProbes collect through their
   * onFindings callback, so the panel supplies a closure that drains that collector here; without it
   * the run falls back to reading the tool's summary lines.
   */
  findings?(): Finding[];
}

export interface AcceptanceRefusal { ok: false; code: 'no-acceptance' | 'reacceptance-required'; reason: string }

/**
 * The production disclaimer gate (CYBER-03). Re-validated at every run start, so a stale
 * acceptance can never be replayed (T-25-08), and an acceptance with no acceptor name is refused.
 */
export function checkAcceptance(acceptance: Partial<DisclaimerAcceptance> | undefined, engagement: Engagement, current: AcceptanceSnapshot): { ok: true } | AcceptanceRefusal {
  if (!acceptance) return { ok: false, code: 'no-acceptance', reason: 'The engagement has no accepted disclaimer, so no run may start.' };
  if (!acceptance.acceptor || !acceptance.acceptor.trim()) return { ok: false, code: 'no-acceptance', reason: 'The accepted disclaimer has no acceptor name, so no run may start.' };
  const stored = { ...acceptance as DisclaimerAcceptance, scope: acceptance.region ? scopeFingerprint(engagement.resolvedScope) : '' };
  if (needsReacceptance(stored, current)) {
    return { ok: false, code: 'reacceptance-required', reason: `The accepted disclaimer no longer matches this engagement (region, scope, extension version, or statement version changed), so it must be accepted again.` };
  }
  return { ok: true };
}

export interface CyberRunInput {
  engagement: Engagement;
  /** The acceptance snapshot the current machine would accept under (region, scope, versions). */
  currentAcceptance: AcceptanceSnapshot;
  driver: RoleDriver;
  tools: RunTool[];
  ledger: CyberLedgerStore;
  evidence: CyberEvidenceStore;
  grants: RunGrants;
  policy: { mode: 'approve-risky' | 'fully-autonomous' | 'auto'; emergencyStop: boolean };
  rules?: PermissionRules;
  /** The caller binds this to the chat approval card (D-02 reuses the one approval UI). */
  requestApproval(step: Step): Promise<{ decision: 'allow' | 'deny'; reason?: string }>;
  limiter?: RateLimiter;
  budget?: () => ReturnType<typeof checkBudget>;
  signal: AbortSignal;
  /**
   * Findings the tools report through their own onFindings callback. The run drains this after every
   * step, so those findings are critiqued and chained like any other — a probe's findings arriving
   * outside the run used to never reach the ledger.
   */
  externalFindings?: Finding[];
  /** The depth profile this run promises; its checks decide how many steps the planner gets. */
  depth?: DepthProfile;
  /** The stop control, checked before every step (CYBER-10). */
  stopped?(): boolean;
  /** What a step's tool run receives: root, shell, checkpoints, and the abort signal. */
  toolContext: ToolContext;
  /** Runs catalogued host tools (D-27 kind 2); a step naming one executes here, not as an AgentTool. */
  hostTools?: HostToolDeps;
  now?: () => Date;
  onEvent?(event: CyberRunEvent): void;
}

export interface CyberRunResult {
  runId: string;
  outcome: CyberRunOutcome;
  reason?: string;
  findings: Finding[];
  steps: number;
  /** True only when the stored chain verifies; a broken chain is never reported as sound. */
  ledgerOk: boolean;
  transcript: string;
}

/** A run id the engagement store accepts, and that is safe as a directory name. */
export function newRunId(now: () => Date): string {
  const stamp = isoTimestamp(now()).replace(/[-:]/g, '').replace('T', '-').replace('Z', '');
  const random = Math.random().toString(36).slice(2, 8).padEnd(6, '0');
  return `run-${stamp}-${random}`;
}

const MAX_TRANSCRIPT = 12_000;

export async function startCyberRun(input: CyberRunInput): Promise<CyberRunResult> {
  const now = input.now ?? (() => new Date());
  const emit = (event: CyberRunEvent) => input.onEvent?.(event);
  const runId = newRunId(now);
  const rules = input.rules ?? DEFAULT_RULES;
  const findings: Finding[] = [];
  const records: ProtocolStepRecord[] = [];
  const transcript: string[] = [];

  const done = (outcome: CyberRunOutcome, extra: { reason?: string; ledgerOk?: boolean } = {}): CyberRunResult => {
    emit({ type: 'done', outcome, runId });
    return {
      runId,
      outcome,
      ...(extra.reason ? { reason: extra.reason } : {}),
      findings,
      steps: records.length,
      ledgerOk: extra.ledgerOk ?? false,
      transcript: redactSecrets(transcript.join('\n')).slice(0, MAX_TRANSCRIPT)
    };
  };

  // (1) The disclaimer gate runs before the first model call and before any tool.
  const acceptance = checkAcceptance(input.engagement.acceptedDisclaimer, input.engagement, input.currentAcceptance);
  if (!acceptance.ok) {
    emit({ type: 'notice', text: acceptance.reason });
    return done('refused', { reason: `${acceptance.code}: ${acceptance.reason}` });
  }

  const scope = input.engagement.resolvedScope;
  const inScope = (target: string) => scopeIncludes(scope, target);
  /**
   * A persisted finding is redacted field by field, then serialised. Redacting the whole JSON string
   * let the credential regex run across `\n` escapes and corrupt the JSON, which made one finding
   * unreadable on replay.
   */
  const findingResult = (finding: Finding): string => {
    const redacted: Finding = {
      ...finding,
      title: redactSecrets(finding.title),
      evidenceExcerpt: redactSecrets(finding.evidenceExcerpt),
      reproductionCommand: redactSecrets(finding.reproductionCommand),
      remediation: redactSecrets(finding.remediation),
      ...(finding.reason ? { reason: redactSecrets(finding.reason) } : {}),
      ...(finding.target ? { target: redactSecrets(finding.target) } : {})
    };
    return `${FINDING_MARKER}${JSON.stringify(redacted)}`;
  };
  const record = (fields: { tool: string; arguments: string; result: string; modelReasoning: string; evidenceHash?: string }) =>
    input.ledger.append(runId, {
      timestamp: isoTimestamp(now()),
      tool: fields.tool,
      // A finding line is already redacted per field, so it is stored as built (see findingResult).
      arguments: fields.tool === 'finding' ? fields.arguments : redactSecrets(fields.arguments).slice(0, 4_000),
      result: fields.tool === 'finding' ? fields.result : redactSecrets(fields.result).slice(0, 8_000),
      modelReasoning: redactSecrets(fields.modelReasoning).slice(0, 2_000),
      evidenceHash: fields.evidenceHash ?? ''
    });

  const askRole = async (role: StepRole, user: string): Promise<AskRoleResult> => {
    const history = records.length > COMPACTION_WINDOW ? compactSteps(records, COMPACTION_WINDOW) : records;
    const context = history.map((entry) => `- [${entry.action}] ${entry.target}: ${entry.result}${entry.evidenceHashes.length ? ` (evidence ${entry.evidenceHashes.join(', ')})` : ''}`).join('\n');
    const summary = [
      `Engagement: ${input.engagement.id}`,
      `Target: ${input.engagement.target.kind} ${input.engagement.target.value}`,
      `Scope hosts: ${scope.hosts.join(', ') || '(none)'}`,
      `Scope ports: ${scope.ports.join(', ') || '(none)'}`,
      `Checks: ${input.engagement.allowedModes.join(', ') || 'passive'}`,
      `Evidence so far: ${findings.length} finding(s)`,
      context ? `Steps so far (${history.length}):\n${context}` : 'No steps yet.'
    ].join('\n');
    return input.driver.askRole(role, [{ role: 'system', content: ROLE_PROMPTS[role] }, { role: 'user', content: `${summary}\n\n${user}` }], input.signal);
  };

  /**
   * Moves findings the tools collected into the run's own list, and announces each one. The
   * announcement is the point: a probe's findings used to be added silently, so the panel's Findings
   * table stayed empty while the run's own result counted them.
   */
  const drainExternal = () => {
    const pending = input.externalFindings;
    while (pending && pending.length) {
      const drained = pending.shift()!;
      findings.push(drained);
      emit({ type: 'finding', finding: drained, verified: Boolean(drained.reproductionCommand) });
    }
  };

  const incompatibility: string[] = [];
  const note = (role: StepRole, reason: string) => {
    const text = `${role} could not follow the JSON protocol: ${reason}. The model did not produce a valid Step, so this role's work is missing from the run.`;
    incompatibility.push(text);
    emit({ type: 'incompatible', role, reason });
  };

  /** One role call, recording the raw reasoning on the step that follows it (D-20). */
  const askOne = async (role: StepRole, user: string): Promise<Step | undefined> => {
    const answer = await askRole(role, user);
    if (answer.kind === 'incompatible') { note(role, answer.reason); return undefined; }
    return answer.steps[0];
  };

  const critiqueFindings = async (): Promise<void> => {
    const evidenceCheck: CriticEvidence = { has: (hash) => input.evidence.get(runId, hash).then(() => true).catch(() => false) };
    for (const finding of findings) {
      const verdict = await verifyFinding(finding, evidenceCheck);
      if (!verdict.verified) emit({ type: 'notice', text: `${finding.title}: ${verdict.reason}` });
    }
    await askOne('critic', findings.length ? `Judge these ${findings.length} finding(s): ${findings.map((finding) => finding.title).join('; ')}` : 'There are no findings to judge; say so.');
  };

  // (2) Planner, then (3) the operator loop. A plan is one step per model reply, so the run asks
  // the planner again until the depth profile's checks are covered, the planner stops, or the step
  // budget is spent. Without the loop a "quick" scan ran exactly one probe and called itself done.
  emit({ type: 'notice', text: 'Asking the planner which check to run first. The model may think for a while; the timeline fills in as steps complete.' });
  const depthChecks = profileChecks(input.depth ?? 'quick');
  const maxSteps = Math.max(1, Math.min(MAX_PLAN_STEPS, depthChecks.length * 2));
  const plan = await askRole('planner', planPrompt(depthChecks, []));
  if (plan.kind === 'incompatible') {
    note('planner', plan.reason);
    await record({ tool: 'planner', arguments: '', result: 'incompatible', modelReasoning: plan.reason });
    return done('incompatible', { reason: `incompatible: ${incompatibility.join(' ')}`, ledgerOk: await input.ledger.verify(runId) });
  }
  let planned: Step[] = plan.steps;

  /**
   * The operator role names the tool and arguments for the planner's step. When it cannot follow the
   * protocol the planner's step is executed as given, and the incompatibility is already recorded.
   */
  const operatorStep = async (plannedStep: Step): Promise<Step> => {
    const answer = await askOne('operator', `Execute this step: ${JSON.stringify(plannedStep)}`);
    return answer ?? plannedStep;
  };

  // (3) Operator: each planned step is handed to the operator role, which names the tool and args it
  // will run; execution then passes the production permission path below. When the step list is
  // exhausted the planner is asked for the next step, so a run covers what its profile promises.
  const ran: string[] = [];
  for (let position = 0; position < maxSteps; position += 1) {
    if (position === planned.length) {
      const covered = coveredChecks(ran, depthChecks);
      if (covered === depthChecks.length) break;
      emit({ type: 'notice', text: `Planning the next check (${covered} of ${depthChecks.length} covered).` });
      // `ran` holds tool names; the profile lists check ids. Comparing them directly never excluded
      // anything, so the planner was told "recon still needed" after recon had already run and chose
      // it again until the step budget ran out.
      const done = new Set(ran.map((tool) => CHECK_FOR_TOOL[tool]).filter((check): check is string => Boolean(check)));
      const outstanding = depthChecks.filter((check) => !done.has(check));
      const next = await askRole('planner', planPrompt(depthChecks, outstanding));
      if (next.kind === 'incompatible') { note('planner', next.reason); break; }
      // A planner that says it is done ends the run instead of being asked again.
      if (!next.steps.length || next.steps[0].tool === 'done') break;
      planned = [...planned, ...next.steps];
    }
    const plannedStep = planned[position];
    const step = await operatorStep(plannedStep);
    ran.push(step.tool);
    if (input.stopped?.() || input.signal.aborted) {
      await record({ tool: 'stop', arguments: step.id, result: 'stopped before the step ran', modelReasoning: 'the stop control was engaged' });
      return done('stopped', { reason: 'stopped', ledgerOk: await input.ledger.verify(runId) });
    }
    const budget = input.budget?.();
    if (budget && !budget.ok) {
      await record({ tool: 'budget', arguments: step.id, result: `${budget.reason} Not reached: ${budget.shortfall.unreachedHosts.join(', ')}; ${budget.shortfall.unreachedChecks.join(', ')}`, modelReasoning: 'the wall-clock budget was reached' });
      return done('stopped', { reason: budget.reason, ledgerOk: await input.ledger.verify(runId) });
    }
    const rate = input.limiter?.acquire();
    if (rate && !rate.ok) {
      await record({ tool: 'rate-limit', arguments: step.id, result: rate.reason, modelReasoning: 'the rate limit refused the step' });
      return done('stopped', { reason: rate.reason, ledgerOk: await input.ledger.verify(runId) });
    }

    const target = step.target;
    if (!inScope(target)) {
      const reason = `"${target}" is outside the resolved scope of engagement ${input.engagement.id}`;
      emit({ type: 'notice', text: reason });
      await record({ tool: step.tool, arguments: step.args.join(' '), result: `refused: ${reason}`, modelReasoning: step.expectedResult });
      continue;
    }

    const hostTool = TOOL_CATALOGUE.some((entry) => entry.name === step.tool) && input.hostTools ? step.tool : undefined;
    const selected = input.tools.find((candidate) => candidate.tool.name === step.tool);
    if (!selected && !hostTool) {
      const reason = `no tool named "${step.tool}" is attached to this run`;
      emit({ type: 'notice', text: reason });
      await record({ tool: step.tool, arguments: step.args.join(' '), result: `refused: ${reason}`, modelReasoning: step.expectedResult });
      continue;
    }

    // A host tool runs under 'shell' exactly like an exploit step (D-04, D-12).
    const capability = selected?.capability ?? 'shell';
    const intrusive: IntrusiveStep | undefined = capability === 'shell' ? { engagementId: input.engagement.id, target } : undefined;
    const command = capability === 'shell' ? [step.tool, ...step.args].join(' ') : undefined;
    let decision = decidePermission(capability, command, input.policy, rules, input.grants, undefined, intrusive);
    if (decision.decision === 'allow' && intrusive && !intrusiveGrantDecision(input.grants, intrusive)) decision = { decision: 'ask' };
    if (decision.decision === 'ask') {
      const reply = await input.requestApproval(step);
      if (reply.decision === 'deny') {
        const reason = `the user declined the step${reply.reason ? `: ${reply.reason}` : ''}`;
        emit({ type: 'notice', text: reason });
        await record({ tool: step.tool, arguments: step.args.join(' '), result: `refused: ${reason}`, modelReasoning: step.expectedResult });
        continue;
      }
      decision = { decision: 'allow' };
    }
    if (decision.decision === 'deny') {
      emit({ type: 'notice', text: decision.reason });
      await record({ tool: step.tool, arguments: step.args.join(' '), result: `refused: ${decision.reason}`, modelReasoning: step.expectedResult });
      continue;
    }

    emit({ type: 'step-started', step });
    const started = now().getTime();
    let output: string;
    let finding: Finding | undefined;
    // The host-tool tree's evidence hash, when this step ran one, so the finding can carry it.
    let ranHostTool: { evidenceHash: string } | undefined;
    try {
      if (hostTool && input.hostTools) {
        // The tool's own stdout bytes are stored verbatim and hashed; only the text below is trimmed.
        const host = await runHostTool({ runId, tool: hostTool, target, timeoutMs: step.safetyFlags.maxDurationMs, signal: input.signal }, input.hostTools);
        ranHostTool = { evidenceHash: host.evidenceHash };
        output = host.status === 'absent' ? host.stdoutText : `${host.stdoutText}\n\n[${hostTool} ${host.status}; exit ${host.provenance.exitCode ?? 'n/a'}; evidence ${host.evidenceHash.slice(0, 12)}…]`;
        await record({ tool: step.tool, arguments: JSON.stringify({ argv: host.provenance.argv, version: host.provenance.version, exitCode: host.provenance.exitCode, durationMs: host.provenance.durationMs, format: host.provenance.format, jsonFlagVerified: host.provenance.jsonFlagVerified }), result: output, modelReasoning: step.expectedResult, evidenceHash: host.evidenceHash });
        records.push({ id: step.id, action: step.action, target: step.target, result: output.slice(0, 1_000), reasoning: step.expectedResult, evidenceHashes: [host.evidenceHash], compacted: false });
        emit({ type: 'step-finished', step, result: output.slice(0, 1_000), evidenceHash: host.evidenceHash });
        transcript.push(`$ ${host.provenance.argv.join(' ')}\n${output.slice(0, 600)}`);
        if (host.status === 'absent') emit({ type: 'notice', text: `${hostTool} is not installed: ${host.stdoutText}` });
        continue;
      }
      const toolInput = selected!.input ? selected!.input(step) : toolInputFor(step.tool, step);
      const parsed = selected!.tool.parse(toolInput);
      output = await selected!.tool.run(parsed, runContext(input));
      finding = selected!.findings?.()[0] ?? extractFinding(selected!, output, step);
    } catch (error) {
      output = error instanceof HostToolError ? `refused: ${error.message}` : `error: ${(error as Error).message}`;
    }
    const durationMs = now().getTime() - started;
    const evidenceHash = await input.evidence.put(runId, `[${step.tool}] ${step.target}\n${output}`);
    records.push({ id: step.id, action: step.action, target: step.target, result: output.slice(0, 1_000), reasoning: step.expectedResult, evidenceHashes: [evidenceHash], compacted: false });
    await record({ tool: step.tool, arguments: JSON.stringify({ args: step.args, durationMs }), result: output, modelReasoning: step.expectedResult, evidenceHash });
    emit({ type: 'step-finished', step, result: output.slice(0, 1_000), evidenceHash });
    transcript.push(`$ ${step.tool} ${step.args.join(' ')}\n${output.slice(0, 600)}`);

    drainExternal();
    if (finding) {
      const withEvidence: Finding = { ...finding, evidenceHash: ranHostTool?.evidenceHash ?? evidenceHash };
      findings.push(withEvidence);
      emit({ type: 'finding', finding: withEvidence, verified: Boolean(withEvidence.reproductionCommand) });
    }
  }

  drainExternal();
  // (4) Critic: a model call, plus the deterministic verification every finding passes (CYBER-05).
  await critiqueFindings();

  // (5) Reporter, then persist each finding into the chain so replay can reproduce them.
  const report = await askRole('reporter', `Write the PTES summary for these ${findings.length} finding(s).`);
  if (report.kind === 'incompatible') note('reporter', report.reason);
  else transcript.push(`report: ${report.steps[0]?.expectedResult ?? ''}`);
  for (const finding of findings) await record({ tool: 'finding', arguments: finding.checkId, result: findingResult(finding), modelReasoning: finding.remediation || hardeningAdvice(finding.checkId), evidenceHash: finding.evidenceHash });

  const ledgerOk = await input.ledger.verify(runId);
  if (!ledgerOk) emit({ type: 'notice', text: 'The ledger chain did not verify after this run.' });
  findings.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.title.localeCompare(b.title));
  return done(incompatibility.length ? 'incompatible' : 'completed', { ...(incompatibility.length ? { reason: `incompatible: ${incompatibility.join(' ')}` } : {}), ledgerOk });
}

/** How many recent steps a role sees verbatim before compaction trims the rest (D-19). */
export const COMPACTION_WINDOW = 6;

/** Offline: re-render a recorded run from its ledger; no network, no tool (success criterion 5). */
export function replayRun(runId: string, ledger: CyberLedgerStore): ReturnType<CyberLedgerStore['replay']> {
  return ledger.replay(runId);
}

/** The scope check for a step's target: a URL's host and port, or a workspace path prefix. */
export function scopeIncludes(scope: ResolvedScope, target: string): boolean {
  const trimmed = target.trim();
  if (!trimmed) return false;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
      if (!scope.hosts.map((entry) => entry.toLowerCase()).includes(host)) return false;
      if (!scope.ports.length) return true;
      const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
      return scope.ports.includes(port);
    } catch { return false; }
  }
  const hosts = scope.hosts.map((entry) => entry.toLowerCase());
  if (hosts.includes(trimmed.toLowerCase())) return true;
  const [hostPart, portPart] = trimmed.split(':');
  if (portPart && /^\d+$/.test(portPart)) return hosts.includes(hostPart.toLowerCase()) && (!scope.ports.length || scope.ports.includes(Number(portPart)));
  return pathInScope(scope.paths, trimmed);
}

/**
 * Whether a path target is inside one of the scope's paths. A raw string prefix is not enough:
 * "/workspace/../../etc" starts with "/workspace/" and the probes then resolve it and read outside
 * the scope. Both sides are resolved and normalised, and the target must sit under the scope root.
 */
export function pathInScope(paths: string[], target: string): boolean {
  const resolvedTarget = path.resolve(target);
  for (const entry of paths) {
    const root = path.resolve(entry);
    if (resolvedTarget === root) return true;
    if (resolvedTarget.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`)) {
      // A `..` segment that survived normalisation would have climbed out; the prefix test above
      // already rejects it, but check explicitly so a platform quirk cannot let one through.
      const relative = path.relative(root, resolvedTarget);
      if (!relative.split(path.sep).includes('..')) return true;
    }
  }
  return false;
}

/** A finding built from a probe tool's output, when the tool supports one. */
function extractFinding(tool: RunTool, output: string, step: Step): Finding | undefined {
  const maybe = (tool.tool as { findingFrom?(output: string): Finding | undefined }).findingFrom;
  if (maybe) return maybe.call(tool.tool, output);
  const checkId = step.tool.replace(/^Cyber/, '').replace(/Probe$/, '').toLowerCase();
  if (!/missing-hsts|missing-x-content|server-version|tls-|robots-|committed-secret|iac-|vulnerable-dependency|open-port|dns-/.test(output)) return undefined;
  const check = /^(missing-[a-z-]+|server-version-disclosure|tls-[a-z-]+|robots-disallowed-path|committed-secret|iac-[a-z-]+|vulnerable-dependency|open-port|dns-missing-[a-z]+)/m.exec(output)?.[1] ?? checkId;
  return {
    id: `${check}-${Math.random().toString(36).slice(2, 8)}`,
    checkId: check,
    title: firstLine(output) || step.expectedResult,
    severity: /^CRITICAL/.test(output) ? 'critical' : /^HIGH/.test(output) ? 'high' : /^MEDIUM/.test(output) ? 'medium' : 'low',
    verdict: 'could_not_determine',
    cvssVector: 'CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:L/I:L/A:N',
    cwes: [],
    wstg: [],
    evidenceExcerpt: output.slice(0, 600),
    evidenceHash: '',
    reproductionCommand: /Reproduce: `(.+?)`/.exec(output)?.[1] ?? '',
    remediation: hardeningAdvice(check),
    target: step.target
  };
}

function firstLine(text: string): string {
  return text.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
}

/** The ToolContext a step's tool run receives; the signal comes from the run. */
function runContext(input: CyberRunInput): ToolContext {
  return { ...input.toolContext, signal: input.signal };
}

// ---- Panel-facing access (D-02) -----------------------------------------------------------------

/**
 * What a cyber turn hands the chat/agent path: the tools for the engagement's modes, and the
 * engagement grant. Ordinary chat never receives this, so the cyber tools cannot leak into it
 * (T-25-22).
 */
export interface CyberRunAccess {
  engagement: Engagement;
  /** The tools for this engagement's allowed modes. Re-evaluated per call, never cached. */
  tools(): AgentTool<any>[];
  /** The run's rate limiter, shared across steps (D-09). */
  limiter(): RateLimiter | undefined;
  /** Grants intrusive steps for this engagement (D-04); called once the user's Run card is allowed. */
  grant(): void;
}

export interface CyberRunAccessInput {
  engagement: Engagement;
  /** The probe tools for defensive steps (25-01/03). */
  probes(): AgentTool<any>[];
  /** The exploit and post-exploit tools (25-04); attached only for intrusive modes. */
  exploit(): AgentTool<any>[];
  limiter?: RateLimiter;
  /** The scope check the grant uses, so an out-of-scope step is refused, not asked. */
  inScope(target: string): boolean;
  grants: RunGrants;
  onGranted?(): void;
}

export function cyberRunAccess(input: CyberRunAccessInput): CyberRunAccess {
  return {
    engagement: input.engagement,
    tools: () => (input.engagement.allowedModes.includes('intrusive') ? [...input.probes(), ...input.exploit()] : [...input.probes()]),
    limiter: () => input.limiter,
    grant: () => {
      // The engagement-wide intrusive grant (D-04): one approval covers every in-scope step of this
      // engagement, and an out-of-scope step under it is refused rather than asked again.
      input.grants.intrusiveEngagement = { engagementId: input.engagement.id, inScope: input.inScope };
      input.onGranted?.();
    }
  };
}

/** What the chat turn is asked to do for a cyber run; the prompt is built here, not in chat.ts. */
export function cyberRunPrompt(input: { engagement: Engagement; mode: CyberMode; depth: DepthProfile }): string {
  const scope = input.engagement.resolvedScope;
  return [
    `Run a ${input.mode} cybersecurity scan at ${input.depth} depth for engagement ${input.engagement.id}.`,
    `Target: ${input.engagement.target.kind} ${input.engagement.target.value}.`,
    `Resolved scope — hosts: ${scope.hosts.join(', ') || '(none)'}; ports: ${scope.ports.join(', ') || '(any)'}; paths: ${scope.paths.join(', ') || '(none)'}; exclusions: ${scope.exclusions.join(', ') || '(none)'}.`,
    `Allowed modes: ${input.engagement.allowedModes.join(', ') || 'passive'}. Sandbox: ${input.engagement.sandbox.tier}${input.engagement.sandbox.reason ? ` (${input.engagement.sandbox.reason})` : ''}.`,
    'Use the cyber built-in probes for passive checks and the sandboxed exploit tools only when the mode allows intrusion.',
    'Record every finding with its evidence, a reproduction command, and its WSTG id. A failed or inconclusive exploit is stated with its reason, never as "clean".',
    'Do not leave the resolved scope.'
  ].join('\n');
}

/** The most steps one run may plan, so a runaway planner cannot spend a whole budget on one plan. */
export const MAX_PLAN_STEPS = 24;

/** How many of the profile's checks the tools already run cover. */
export function coveredChecks(ranTools: string[], checks: string[]): number {
  const covered = new Set<string>();
  for (const tool of ranTools) {
    const check = CHECK_FOR_TOOL[tool];
    if (check && checks.includes(check)) covered.add(check);
  }
  return covered.size;
}

/** Which profile check each built-in tool satisfies, so the planner can be told what is left. */
export const CHECK_FOR_TOOL: Record<string, string> = {
  CyberHttpProbe: 'http-headers',
  CyberFingerprintProbe: 'recon',
  CyberTlsProbe: 'tls',
  CyberDnsProbe: 'dns',
  CyberRobotsProbe: 'exposed-paths',
  CyberSecretsProbe: 'committed-secrets',
  CyberIacProbe: 'iac-probe',
  CyberDependencyProbe: 'dependency-scan',
  CyberTcpProbe: 'port-sweep'
};

/** The planner's instruction: which profile checks remain, so the model plans toward coverage. */
export function planPrompt(checks: string[], remaining: string[]): string {
  // An empty remaining list means every check has run, so say that rather than falling back to the
  // full list — the fallback read as "all of these are still needed" and the model repeated recon.
  if (!remaining.length) {
    return `Every one of this ${checks.length}-check run has run. Reply with a step whose "tool" is "done".`;
  }
  return [
    'Choose the single next step to run now.',
    `This ${checks.length}-check run still needs: ${remaining.map((check) => `${check} (${toolFor(check)})`).join(', ')}.`,
    'Do not repeat a check that already ran. When every check has run, reply with a step whose tool is "done".'
  ].join(' ');
}

/** The built-in tool that satisfies a profile check, for the planner's prompt. */
export function toolFor(check: string): string {
  const found = Object.entries(CHECK_FOR_TOOL).find(([, candidate]) => candidate === check);
  return found ? found[0] : 'a host tool or probe';
}

/**
 * The arguments a built-in probe expects, built from the step. Each probe takes its own parameter
 * names (`url`, `hostname`, `host`/`ports`, `url`, `root`), so a single `{args, target}` shape was
 * rejected by every one of them and the run recorded an error instead of a finding.
 */
export function toolInputFor(toolName: string, step: Step): Record<string, unknown> {
  const target = step.target;
  switch (toolName) {
    case 'CyberHttpProbe':
    case 'CyberRobotsProbe':
    case 'CyberFingerprintProbe':
      return { url: target, ...(toolName === 'CyberHttpProbe' ? { checks: step.args } : {}) };
    case 'CyberTlsProbe':
      return { url: target };
    case 'CyberDnsProbe':
      return { hostname: hostOf(target) };
    case 'CyberTcpProbe': {
      const ports = step.args.map((argument) => Number(argument)).filter((port) => Number.isInteger(port) && port > 0);
      const portFromTarget = Number(/:(\d+)\/*$/.exec(target)?.[1] ?? 0);
      return { host: hostOf(target), ports: ports.length ? ports : portFromTarget ? [portFromTarget] : [] };
    }
    case 'CyberSecretsProbe':
    case 'CyberIacProbe':
    case 'CyberDependencyProbe':
      return { root: target };
    default:
      return { ...(step.args.length ? { args: step.args } : {}), target };
  }
}

/** A hostname from a URL, a bare host, or a host:port pair. */
function hostOf(target: string): string {
  if (/^https?:\/\//i.test(target)) {
    try { return new URL(target).hostname.replace(/^\[|\]$/g, ''); } catch { return target; }
  }
  return target.split(':')[0];
}
