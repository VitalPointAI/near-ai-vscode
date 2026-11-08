import type { ActionCapability, ActionPolicy } from '../domain/policy';
import { classifyCommand, simpleDownload, CommandContext } from './commandSafety';
import { NETWORK_COMMAND } from './untrusted';
import { riskAllowed } from '../domain/riskSwitches';
import type { CommandSafetyCheck } from './safetyModel';

/** `reason` on an allow names the grant that let it run (the engagement grant names its
 * engagement); `reason` on an ask says why it was not run automatically and the card shows it. */
export type PermissionDecision = { decision: 'allow'; reason?: string } | { decision: 'ask'; reason?: string } | { decision: 'deny'; reason: string };

/** What the `auto` mode needs to judge a shell command. */
export interface AutoApprovalContext extends CommandContext {
  /** The private safety model, for commands the rules cannot decide; without it they ask. */
  safety?: CommandSafetyCheck;
  signal?: AbortSignal;
  /** 0.4.17: the kinds of risk this project has already allowed (read outside the project, install). */
  riskSwitches?: { outsideWorkspace: boolean; installs: boolean };
  /** 0.4.17: the tool that is asking marked itself autoSafe (WebSearch, WebFetch), so Auto may run it without a question. */
  autoSafeTool?: boolean;
}

export interface PermissionRules {
  /** Commands (leading words) that run without asking when written as plain words, e.g. "npm test". */
  allowCommands: string[];
  /** Substrings that are always refused, e.g. "git push --force". */
  denyCommands: string[];
}

export const DEFAULT_RULES: PermissionRules = {
  allowCommands: ['git status', 'git diff', 'git log', 'git show', 'git branch', 'ls', 'pwd', 'node --version', 'npm --version'],
  denyCommands: ['rm -rf /', 'rm -rf ~', 'git push --force', 'git push -f', 'mkfs', ':(){']
};

/**
 * Only plain words are auto-allowed: anything else (chaining, redirects, substitution, quotes,
 * globs, `~`, variables, newlines) needs approval. Checked on the raw command, before any
 * whitespace is collapsed.
 */
const PLAIN_COMMAND = /^[A-Za-z0-9 _.\/:=@+,%-]+$/;
/** git options that write files, read outside the repository, run programs, or destroy refs. */
const RISKY_GIT_ARG = /^(?:--output(?:=|$)|-o$|--no-index$|--ext-diff$|--textconv$|--exec|--upload-pack|--receive-pack|-c$|-C$|--git-dir|--work-tree|-[a-zA-Z]*[DdMmfc][a-zA-Z]*$|--delete$|--force$|--move$|--copy$|--set-upstream|--unset-upstream|--edit-description$)/;
const SAFE_GIT_BRANCH_ARGS = new Set(['-a', '-r', '-v', '-vv', '--list', '--show-current', '--all', '--remotes']);
/** The classifier's own words for a command that runs or reads outside the workspace (0.4.17: a fact the safety model cannot overturn). */
const LEAVES_WORKSPACE = /outside the workspace|leaves the workspace|another user's home directory/;
/** A network command that sends data of its own accord (0.4.17: held after outside content, so a safety-model "allow" cannot leak it). */
const CARRIES_DATA = /\b(?:curl|wget|http|httpie)\b[^|;&]*?(?:\s-d\s|--data|-F\s|--form|-T\s|--upload-file|--post-file|-X\s*(?:POST|PUT|PATCH))/i;
/** The classifier's own words for a command that installs or downloads software (0.4.17: only covered by a project's own switch). */
const INSTALLS = /(?:^|\W)(?:npm|pnpm|yarn|bun|pip|pip3|uv|poetry|cargo|go|gem|composer|apt|apt-get|brew|dnf|yum|apk|pacman)\s+(?:i|install|add|get)\b|installs a package from the network/i;
/** Programs that only read, so the outside-workspace switch can cover them. Anything not named here is treated as a change. */
const READ_ONLY_PROGRAMS = new Set(['cat', 'head', 'tail', 'less', 'more', 'wc', 'ls', 'stat', 'file', 'grep', 'rg', 'zcat', 'jq', 'diff', 'du', 'df', 'pwd', 'echo', 'sed', 'find']);
/**
 * Options that turn an otherwise read-only program into a write: find's -fprint/-fls/-fprintf, sed's `w`/`W` commands and -i, tree's -o. A
 * program whose options can write is not read-only for this purpose, which is what the 0.4.17 review found.
 */
const WRITING_OPTION = /\s(?:-i|--in-place|-fprint0?|-fprintf|-fls|-o\b)|(?:^|[\s'"])(?:[0-9]*w)\s/i;
/** A command that only reads its operands: a read-only program, walked one segment at a time, with no in-place edit, delete or redirect that writes. */
function readsOnly(command: string): boolean {
  // A mutating option turns an otherwise read-only program into a change.
  if (WRITING_OPTION.test(command)) return false;
  if (/\s-(?:delete|exec|execdir|ok|okdir)\b|^\s*ln\b|\btruncate\b|\btee\b/.test(command)) return false;
  // Any redirect that writes, `>|` and `&>` included.
  if (/(?:^|[^0-9])>\|?|&>/.test(command)) return false;
  for (const segment of command.split(/&&|;|\|/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    if (words[0] === 'cd') {
      const target = words[1];
      if (target !== undefined && (target.startsWith('/') || target.startsWith('~') || target.split('/').includes('..'))) return false;
      continue;
    }
    if (!READ_ONLY_PROGRAMS.has(words[0] as string)) return false;
  }
  return true;
}

/** Why a command can never be covered by an allow-list entry, or undefined when it can be. One rule, asked by the matcher and by the card's offer. */
export function allowRuleBlocker(command: string): string | undefined {
  const raw = command.trim();
  if (!raw || !PLAIN_COMMAND.test(raw)) return 'it chains, quotes, redirects or substitutes, so no entry can name it';
  const words = raw.split(/ +/);
  if (words.some((word) => word.startsWith('/') || word.startsWith('~') || word.split('/').includes('..'))) return 'it names an absolute path, a home folder or steps up out of the folder';
  // An allow-list entry covers named remotes and local paths, never an address typed on the command line.
  if (words.some((word) => /:\/\/|^[\w.-]+@[\w.-]+:/.test(word))) return 'it names an address on the command line';
  return undefined;
}

/** Programs an entry must never name, because allowing them allows almost anything (0.4.17: the offer and the match share this list). */
/** `node --version`, `python3 --version`: no side effect at all, so an entry naming one is still honoured. */
const VERSION_QUESTION = /^(?:node|python3?|npm|npx|ruby|perl|go|cargo|java|deno|bun)\s+(?:--version|-v|--help|-h)$/;
const NEVER_IN_AN_ENTRY = new Set(['rm', 'rmdir', 'sh', 'bash', 'zsh', 'python', 'python3', 'node', 'perl', 'ruby', 'eval', 'exec', 'sudo', 'su', 'curl', 'wget', 'ssh', 'scp', 'nc', 'dd']);

/** Whether a command matches an allow-list entry and is simple enough to run without asking. */
export function isAutoAllowed(command: string, allowCommands: string[]): boolean {
  const raw = command.trim();
  if (allowRuleBlocker(raw) !== undefined) return false;
  // 0.4.17 review: an entry whose first word is one of these is never honoured, but the shipped `node --version` must still work, so a command that
  // is exactly the plain version question is let through as the safe, side-effect-free thing it is.
  if (NEVER_IN_AN_ENTRY.has(raw.split(/ +/)[0] ?? '') && !VERSION_QUESTION.test(raw)) return false;
  const words = raw.split(/ +/);
  // 0.4.17 review: an entry whose first word is a program no entry may name (`rm`, `curl`, an interpreter) is never honoured, so a person's own
  // allowCommands entry for one of those is ignored by design. The setting's own description says so.
  const entry = allowCommands.map((prefix) => prefix.trim().split(/\s+/)).find((prefix) => prefix[0] && prefix.every((word, index) => words[index] === word));
  if (!entry) return false;
  const rest = words.slice(entry.length);
  if (words[0] === 'git') {
    if (rest.some((word) => RISKY_GIT_ARG.test(word))) return false;
    if (words[1] === 'branch' && rest.some((word) => !SAFE_GIT_BRANCH_ARGS.has(word))) return false;
  }
  return true;
}

/**
 * Grants made from approval cards for the rest of one run: "allow edits for this run" and
 * "allow this exact command for this run".
 */
export class RunGrants {
  public edits = false;
  public readonly commands = new Set<string>();
  /** Allow-list entries added from an approval card ("always allow …") during this run. */
  public readonly allowRules = new Set<string>();
  /** Set once the run reads outside content; some actions then always ask. */
  public tainted = false;
  /**
   * URLs whose text this run already has (filled from ToolContext.pages). Re-reading one sends nothing the run did not already send, so a plain download of
   * it is not held by the taint rule (0.4.18 review). A shell download is not recorded, so a second `curl` of the same URL after taint still asks.
   */
  public readonly fetched = new Set<string>();
  /**
   * The engagement-wide grant for intrusive cyber steps (D-04): granted once for a run, and each
   * step must still name that engagement and an in-scope target. Undefined for every other run, so
   * no existing decision changes.
   */
  public intrusiveEngagement?: { engagementId: string; inScope(target: string): boolean };

  /** Grants intrusive steps for one engagement for the rest of this run (D-04). */
  public grantIntrusive(engagementId: string, inScope: (target: string) => boolean): void {
    this.intrusiveEngagement = { engagementId, inScope };
  }
}

/** Which engagement, and which target, a cyber step claims the grant for. */
export interface IntrusiveStep { engagementId: string; target: string }

/**
 * The decision for an intrusive step under the engagement grant, or undefined when no grant is set
 * or the step does not claim one (so the caller falls through to the ordinary order). An in-scope
 * step of the granted engagement is allowed; anything else is DENIED, not asked, so a model cannot
 * widen its own scope by asking again (T-25-36).
 */
export function intrusiveGrantDecision(grants: RunGrants, step: IntrusiveStep | undefined): PermissionDecision | undefined {
  const grant = grants.intrusiveEngagement;
  if (!grant || !step) return undefined;
  if (step.engagementId !== grant.engagementId) return undefined;
  if (!grant.inScope(step.target)) return { decision: 'deny', reason: `${step.target} is outside the resolved scope of engagement ${grant.engagementId}.` };
  return { decision: 'allow', reason: `Allowed under the intrusive grant for engagement ${grant.engagementId}.` };
}/**
 * Decides whether a tool call runs, asks first, or is refused. Reads, searches, and task lists
 * always run. File writes follow the action policy. Shell commands consult the deny list, the
 * per-run grants, the allow list (simple commands only), then the action policy. In `auto` mode
 * the command classifier then decides; this synchronous form asks for commands it cannot decide
 * (decidePermissionAsync asks the safety model about those).
 *
 * The optional `intrusive` step is the one additive input for cyber work (D-04): it is consulted
 * only when the run holds an engagement grant, only after the deny list, and never changes a
 * decision for a run without one.
 */
export function decidePermission(capability: ActionCapability, command: string | undefined, policy: ActionPolicy, rules: PermissionRules, grants: RunGrants, auto?: AutoApprovalContext, intrusive?: IntrusiveStep): PermissionDecision {
  if (policy.emergencyStop) return { decision: 'deny', reason: 'Emergency stop is on.' };
  if (capability === 'read' || capability === 'plan') return { decision: 'allow' };
  // Owner decision 2026-11-05 (0.4.17): in auto, a tool that marks itself autoSafe (only WebSearch and WebFetch do) runs by itself. Research is
  // what the run is for, so searching is not the risk; what can carry data out is judged by the tool's own checks (WebFetch's exfiltration check
  // after outside content). The gate is the tool's own marker, never the bare network capability, so an MCP or remote tool keeps asking.
  // 0.4.17: the web tools run in auto even after outside content. Their results are what taints a run in the first place, so holding them once
  // tainted would ask for every search after the first one, which is exactly what this change exists to stop. Their own outbound checks cover the
  // risk: WebFetch refuses an exfiltration-shaped URL after outside content (src/agent/webTools.ts risky), and the pages go to the model fenced.
  if (capability === 'network' && policy.mode === 'auto' && auto?.autoSafeTool === true) return { decision: 'allow' };
  if (capability === 'workspaceWrite') {
    if (grants.edits || policy.mode !== 'approve-risky') return { decision: 'allow' };
    return { decision: 'ask' };
  }
  if (capability === 'shell') {
    // The deny list is a backstop, not a sandbox: matched with quotes and escapes removed.
    const unquoted = normalizeCommand((command ?? '').replace(/["'\\]/g, ''));
    const denied = rules.denyCommands.find((pattern) => pattern && unquoted.includes(normalizeCommand(pattern)));
    if (denied) return { decision: 'deny', reason: `"${denied}" is on your deny list (nearAi.agent.denyCommands).` };
    // The engagement grant sits between the deny list and the per-command grants: an intrusive
    // step of the granted engagement runs without a card, an out-of-scope one is refused.
    const intrusion = intrusiveGrantDecision(grants, intrusive);
    if (intrusion) return intrusion;
    if (grants.commands.has((command ?? '').trim())) return { decision: 'allow' };
    const allowList = [...rules.allowCommands, ...grants.allowRules];
    if (isAutoAllowed(command ?? '', allowList)) return { decision: 'allow' };
    if (policy.mode === 'fully-autonomous') return { decision: 'allow' };
    if (policy.mode === 'auto') {
      if (!auto) return { decision: 'ask', reason: 'Auto approve could not check this command.' };
      const classified = classifyCommand(command ?? '', withAllowList(auto, allowList));
      if (classified.verdict === 'safe') return { decision: 'allow' };
      return { decision: 'ask', reason: classified.verdict === 'risky' ? `Auto approve held this: ${classified.reason}.` : `The rules could not decide this command (${classified.reason}).` };
    }
    return { decision: 'ask' };
  }
  return policy.mode === 'fully-autonomous' ? { decision: 'allow' } : { decision: 'ask' };
}

/**
 * decidePermission, plus the `auto` mode's model check: a shell command the rules call `unknown` goes to the private safety model. With no private
 * model available the command asks, with a reason that names the setting to fix; the project's own allow switches and the structural guards still decide
 * first, so a missing model never overrides them. Every other mode decides exactly as decidePermission does.
 */
export async function decidePermissionAsync(capability: ActionCapability, command: string | undefined, policy: ActionPolicy, rules: PermissionRules, grants: RunGrants, auto?: AutoApprovalContext, intrusive?: IntrusiveStep): Promise<PermissionDecision> {
  const decided = decidePermission(capability, command, policy, rules, grants, auto, intrusive);
  if (capability !== 'shell') return decided;
  // 0.4.19 review: this hold must apply in EVERY mode, not only auto. The classifier calls a plain download `safe` in the asking modes too, so a tainted run
  // would otherwise have treated it as harmless and run it with no card.
  const download = grants.tainted ? simpleDownload(command ?? '') : undefined;
  if (download?.plain && !(grants.fetched ?? new Set<string>()).has(download.url ?? '')) {
    return { decision: 'ask', reason: 'This run read outside content, and this download sends a URL that content may have chosen, which can carry data out in the path, the query or a header. Approve it only if you expected it.' };
  }
  if (policy.mode !== 'auto' || !auto) return decided;
  if (decided.decision !== 'ask') return decided;
  const allowList = withAllowList(auto, [...rules.allowCommands, ...grants.allowRules]);
  const classified = classifyCommand(command ?? '', allowList);
  if (classified.verdict !== 'unknown') return decided;
  // Say why the safety model did not let it run: skipped (network command in a tainted run, no
  // private model), unable to answer (busy, unreachable, timed out), or answered no.
  const unplaced = `the rules couldn't place this command (${classified.reason})`;
  // Owner decision 2026-11-05 (0.4.17): the blanket "after outside content, any network command asks" is gone. Research runs shell commands
  // that reach the network on purpose, so the risk is judged per command (the shell rules, and the safety model below), not per run.
  //
  // A command that leaves the workspace is a structural fact, not a judgement call: the safety model is not asked about it, because a command
  // that runs in another folder can do anything there and a model cannot check that from the command text alone.
  // 0.4.17: the project may have allowed this kind of risk once (nearAi.agent.autoAllowOutsideWorkspace, or ...autoAllowInstalls). Only a read or an
  // install is covered by a switch; nothing that writes outside, runs elsewhere, or sends data out is.
  //
  // Which kind a command is, and whether its switch is on, is remembered here and used below: with the switch off the command asks unless the safety
  // model itself allows it (a deliberate, per-command approval); with the switch on, the ordinary safety-model path decides, as it did before the
  // switch existed. Nothing gets weaker than it was before 0.4.17.
  const switches = auto.riskSwitches ?? { outsideWorkspace: false, installs: false };
  // After outside content, a command that carries data out on its own flags is held, whatever the safety model says: a page could have asked for it.
  // The shape is a network program with a body, file upload or data flag (`curl -d`, `--data`, `-F`, `-T`, `--upload-file`, `-X POST`, `wget --post-file`).
  if (grants.tainted && CARRIES_DATA.test(command ?? '')) {
    return { decision: 'ask', reason: 'This run read outside content, and this command sends data with it, which that content may have asked for. Approve it only if you expected it.' };
  }
  // 0.4.17 review: a flag regex cannot know every way data leaves (curl --json @.env, wget --post-data, xargs curl, nc, node -e fetch), so any
  // other command that can reach the network still asks after outside content. This keeps the guard structural rather than a list of flags.
  if (grants.tainted && NETWORK_COMMAND.test(command ?? '') && !INSTALLS.test(classified.reason)) {
    return { decision: 'ask', reason: 'This run read outside content, and this command can reach the network, which that content may have asked for. Approve it only if you expected it.' };
  }
  // Reading outside the project is held by the rules alone, because a model cannot tell from the command text what a command in another folder
  // touches. The project's own switch is the one thing that lifts that hold, and even then the safety model still has to agree.
  if (LEAVES_WORKSPACE.test(classified.reason) && readsOnly(command ?? '') && !riskAllowed('outside-workspace', switches)) {
    return { decision: 'ask', reason: `Auto approve held this: ${classified.reason}. Nothing outside this project is touched without your say.` };
  }
  // Installing is decided by the safety model as it always was, so a project that changes no switch sees no new question. Turning the switch on
  // means the project has decided for itself, so the model is not asked at all.
  // A command that runs in another folder is never covered by the outside-workspace switch, whatever it does there: the switch is about reading.
  if (LEAVES_WORKSPACE.test(classified.reason) && !readsOnly(command ?? '')) {
    return { decision: 'ask', reason: `Auto approve held this: ${classified.reason}. Nothing runs outside this project without your say.` };
  }
  if (INSTALLS.test(classified.reason) && riskAllowed('installs', switches)) return { decision: 'allow' };
  if (!auto.safety) {
    // 0.4.18 review: this stays after the switches and the structural guards, so a project's own allow switches still decide without a safety
    // model. The message names the model to set, which is the one action that ends this class of question for good.
    return { decision: 'ask', reason: `No private (TEE) safety model is available to check it, and ${unplaced}. Set nearAi.agent.safetyModel to a private chat model, such as a TEE chat model that is not the abliterated one, to stop these questions.` };
  }
  const verdict = await auto.safety.check((command ?? '').trim(), { root: auto.root, cwd: auto.cwd ?? auto.root, outsideContent: grants.tainted }, auto.signal);
  if (verdict.allow) return { decision: 'allow' };
  // The safety model said no: its own reason is the card's, and a kind the project has not allowed says so too.
  return { decision: 'ask', reason: verdict.reason.startsWith('Safety model:') ? verdict.reason : `${verdict.reason} Without it, ${unplaced}.` };
}

function withAllowList(context: CommandContext, allowList: string[]): CommandContext {
  return { ...context, isAllowListed: (part) => isAutoAllowed(part, allowList) };
}

/** Programs whose second word picks what they do, so an allow-list entry names both (`git push`, `npm run`). */
const VERB_PROGRAMS = new Set(['git', 'npm', 'pnpm', 'yarn', 'npx', 'cargo', 'go', 'docker', 'podman', 'pip', 'pip3', 'uv', 'poetry', 'make', 'dotnet', 'kubectl']);
/** Where the verb is still too broad (`npm run` runs any script, `gh pr` includes merge), the entry names three words. */
const THREE_WORD = new Set(['npm run', 'pnpm run', 'yarn run', 'bun run', 'gh pr', 'gh issue', 'gh run', 'gh release', 'gh repo', 'glab mr', 'glab issue', 'docker compose']);
/** Never offered for "always allow": allowing them would allow almost anything. */
const NEVER_ALLOW_LIST = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'python', 'python3', 'node', 'perl', 'ruby', 'php', 'deno', 'bun', 'eval', 'source', 'exec', 'xargs', 'env', 'sudo', 'su', 'doas', 'rm', 'rmdir', 'find', 'dd', 'shred', 'truncate', 'chmod', 'chown', 'curl', 'wget', 'ssh', 'scp', 'nc', 'ncat', 'socat', 'timeout', 'nohup', 'time', 'command', 'nice', 'near', 'aws', 'gcloud', 'az']);

/**
 * The allow-list entry an approval card offers for "always allow" (`git push`, `npm install`,
 * `docker`), or undefined when the command has no part worth allowing on its own. A leading
 * `cd <dir> &&` is skipped; a chained command offers its first other part.
 */
export function suggestAllowRule(command: string): string | undefined {
  const parts = command.trim().split(/\s*(?:&&|;|\n)\s*/).filter(Boolean);
  const part = parts.find((candidate) => !/^cd(?:\s|$)/.test(candidate));
  if (!part || !PLAIN_COMMAND.test(part)) return undefined;
  const words = part.split(/ +/);
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || words[0].includes('/')) return undefined;
  if (NEVER_ALLOW_LIST.has(words[0])) return undefined;
  const operands = words.slice(1).filter((word) => !word.startsWith('-'));
  if (THREE_WORD.has(`${words[0]} ${operands[0]}`)) return operands[1] ? `${words[0]} ${operands[0]} ${operands[1]}` : undefined;
  if (!VERB_PROGRAMS.has(words[0])) return words[0];
  return operands[0] ? `${words[0]} ${operands[0]}` : undefined;
}

export function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}
