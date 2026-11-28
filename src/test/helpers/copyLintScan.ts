// The copy lint's scanner (FND-07, Phase 41 D-41 and D-64; GLOSSARY section 5). It reads the product's user copy sources, counts the hits of each copy
// rule per file, and compares the counts with the checked-in baseline (src/test/copy-lint-baseline.json). A helper with no `.test` suffix, so it can be
// loaded without registering tests. Pure apart from reading files under the repository root; no vscode.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';
import { MODES, ModeId, ModeRow } from '../../domain/org/modes';

/** The copy rules, in the order GLOSSARY section 5 and D-41 number them (the compliance claim is rule 7, after the bare team rule). */
export const COPY_RULES = ['glossary', 'mode-word', 'brand', 'em-dash', 'provider-organization', 'bare-team', 'compliance-claim', 'product-name'] as const;
export type CopyRule = (typeof COPY_RULES)[number];

/** Counts per file (path from the repository root, forward slashes) and rule. A zero count is never stored. */
export type CopyCounts = Record<string, Partial<Record<CopyRule, number>>>;

/** One piece of user copy. `title` marks a panel or command title, which the brand rule also checks for a prefix. */
export interface CopyText {
  readonly text: string;
  readonly title?: boolean;
}

/** The repository root: this file compiles to dist/test/helpers. */
export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
export const BASELINE_PATH = path.join(REPO_ROOT, 'src', 'test', 'copy-lint-baseline.json');

const EM_DASH = String.fromCharCode(0x2014);

/** What to use instead, per rule, for the ratchet's message. */
export const RULE_ADVICE: Readonly<Record<CopyRule, string>> = Object.freeze({
  glossary: 'the glossary\'s user word (.planning/research/coherence/GLOSSARY.md), or add an allowed-context row with its reason',
  'mode-word': 'term(concept, mode) from src/domain/org/terms.ts',
  brand: '"NEAR AI" and "VS Code", and a panel title with no brand prefix',
  'em-dash': 'a colon, a comma or two sentences',
  'provider-organization': '"your organization" (NEAR AI is only the provider)',
  'bare-team': '"agent team" for agents, the mode word from term() for people, or "Microsoft Teams"',
  'compliance-claim': 'a status with its evidence, never a claim that the product is compliant, certified or accredited',
  'product-name': '"Sterling Sovereign AI" or "SovAI" for the product and "SovAI:" for its commands; NEAR AI is only the provider'
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pushString(out: CopyText[], value: unknown, title = false): void {
  if (typeof value === 'string' && value.length > 0) out.push(title ? { text: value, title: true } : { text: value });
}

/**
 * The user copy of a package manifest: command titles and categories, setting descriptions (plain, markdown, enum and deprecation), the configuration
 * section titles, view and view container names and titles, the package's display name and description, and the chat participant's names and command
 * descriptions.
 */
export function extractPackage(manifest: unknown): CopyText[] {
  const out: CopyText[] = [];
  if (!isRecord(manifest)) return out;
  pushString(out, manifest.displayName);
  pushString(out, manifest.description);
  const contributes = isRecord(manifest.contributes) ? manifest.contributes : {};
  for (const command of Array.isArray(contributes.commands) ? contributes.commands : []) {
    if (!isRecord(command)) continue;
    pushString(out, command.title, true);
    pushString(out, command.category);
  }
  const sections = Array.isArray(contributes.configuration) ? contributes.configuration : [contributes.configuration];
  for (const section of sections) {
    if (!isRecord(section)) continue;
    pushString(out, section.title);
    for (const property of Object.values(isRecord(section.properties) ? section.properties : {})) {
      if (!isRecord(property)) continue;
      for (const key of ['description', 'markdownDescription', 'deprecationMessage', 'markdownDeprecationMessage']) pushString(out, property[key]);
      for (const key of ['enumDescriptions', 'markdownEnumDescriptions']) for (const item of Array.isArray(property[key]) ? property[key] as unknown[] : []) pushString(out, item);
    }
  }
  for (const group of ['views', 'viewsContainers']) {
    const table = contributes[group];
    for (const list of Object.values(isRecord(table) ? table : {})) {
      for (const entry of Array.isArray(list) ? list : []) {
        if (!isRecord(entry)) continue;
        pushString(out, entry.name);
        pushString(out, entry.title);
      }
    }
  }
  for (const participant of Array.isArray(contributes.chatParticipants) ? contributes.chatParticipants : []) {
    if (!isRecord(participant)) continue;
    pushString(out, participant.fullName);
    pushString(out, participant.description);
    for (const command of Array.isArray(participant.commands) ? participant.commands : []) if (isRecord(command)) pushString(out, command.description);
  }
  return out;
}

// ---- Sources ----

/** The Sterling workbench's user copy sources (D-33): its browser pages and the common modules they share with the backend. */
export const WORKBENCH_SOURCES: readonly string[] = Object.freeze(['workbench/extension/src/browser', 'workbench/extension/src/common']);
/**
 * The workbench backend (Phase 46 verification W3). Most of it is not copy (start errors name settings for an administrator), so only the
 * strings it sends to the browser are read, found by rule rather than by a file list: text constants (TEXT_CONSTANT, exported or not), the
 * values of the result fields an RPC result carries to the browser (RESULT_COPY_KEYS), and the arguments of refused().
 */
export const WORKBENCH_BACKEND = 'workbench/extension/src/node';
/**
 * The sovereignty badge and card's words (48.4 D-35): every string literal in this folder is read as copy, like the workbench's common modules, because
 * the desktop badge and the workbench card both show them. Its files are already among the src sources; an absent folder simply gives no file.
 */
export const SOVEREIGNTY_SOURCES: readonly string[] = Object.freeze(['src/domain/sovereignty']);

/** Files no rule ever scans: the mode table is where the mode words live (D-40), and term() is its only reader. */
export const NEVER_SCANNED: readonly string[] = Object.freeze(['src/domain/org/modes.ts', 'src/domain/org/terms.ts']);

/** Keys of an object literal passed to a copy call whose string values are copy (a quick pick item, a message or input box option). */
const COPY_KEYS = new Set(['label', 'description', 'detail', 'title', 'placeHolder', 'placeholder', 'prompt']);
/** showInformationMessage, showWarningMessage, showErrorMessage and any other show*Message call. */
const MESSAGE_CALL = /^show\w*Message$/;
const OPTION_CALLS = new Set(['showQuickPick', 'showInputBox']);
/**
 * Exported text constants, and the frozen records of refusal, failure, rejection and problem messages (a record may carry a qualifier after the word, as
 * ROUTE_REFUSALS_NAMED_AHEAD does).
 */
const TEXT_CONSTANT = /_(?:TEXT|TITLE|DETAIL|PROMPT|ACTION|LABEL|PLACEHOLDER|QUESTION|NOTICE)S?$|_(?:REFUSALS|FAILURES|REJECTIONS|PROBLEMS)(?:_[A-Z0-9]+)*$/;

/** An exported constant whose name looks like copy but whose text is an instruction to a model, never shown as a screen's words. */
export interface ModelInstruction {
  readonly file: string;
  readonly name: string;
  readonly why: string;
}

/** Model instructions the text constant rule would otherwise read. A test checks each file exports its name, so a rename cannot hide copy silently. */
export const MODEL_INSTRUCTIONS: readonly ModelInstruction[] = Object.freeze([
  { file: 'src/agent/teamBuilder.ts', name: 'TEAM_BUILDER_PROMPT', why: 'the instruction the agent team builder sends to a model' },
  { file: 'src/agent/teamRefine.ts', name: 'REFINE_PROMPT', why: 'the instruction the agent team review sends to a model' },
  { file: 'src/domain/cyberProtocol.ts', name: 'ROLE_PROMPTS', why: 'the instructions each security scan step sends to a model' },
  { file: 'src/benchmark/graders.ts', name: 'RESEARCH_PROMPT', why: 'a benchmark task given to a model' },
  { file: 'src/benchmark/graders.ts', name: 'PLAN_PROMPT', why: 'a benchmark task given to a model' }
].map((row) => Object.freeze(row)));
/** A tag that makes a literal host-built HTML (or HTML a page script builds). */
const HTML_TAG = /<(?:h[1-6]|p|button|label|section|div|span|li|td|th|a|title|option|summary|legend|strong|em|small|header|footer|ul|ol|table|form|fieldset|details|dialog)[\s>/]/i;
/** Attributes whose values a person reads or hears. */
const COPY_ATTRIBUTE = /(?<![\w-])(?:title|aria-label|aria-description|placeholder|alt)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
/** Calls whose first string argument in a page script is a selector, an event, an attribute or an element name, never copy. */
const PAGE_NAME_CALLS = new Set([
  'querySelector', 'querySelectorAll', 'getElementById', 'getElementsByClassName', 'getElementsByTagName', 'closest', 'matches', 'createElement',
  'addEventListener', 'removeEventListener', 'setAttribute', 'getAttribute', 'removeAttribute', 'hasAttribute', 'toggleAttribute', 'setProperty',
  'getPropertyValue', 'removeProperty', 'insertAdjacentHTML', 'insertAdjacentElement', 'require', 'postMessage'
]);
/** classList calls: every string argument is a class name. */
const CLASS_LIST_CALLS = new Set(['add', 'remove', 'toggle', 'contains', 'replace']);
/** Assignments whose string is a class name or a style, never copy. */
const NAME_PROPERTIES = new Set(['className', 'cssText', 'id', 'type', 'role', 'name', 'href', 'src']);

const ENTITIES: Readonly<Record<string, string>> = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', mdash: EM_DASH, ndash: '-', middot: '·' });

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X')) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith('#')) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

const tidy = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * A name, not words: an id with a separator (nearAi.newChat, hub-revoked, room-squads, or dot- before a removed ${...}) or a lower-case word beside such
 * ids (a class list).
 */
const ID_LIKE = /^[a-z0-9_][A-Za-z0-9_]*(?:[-.:/@#][A-Za-z0-9_]*)+$/;
export function isNameList(text: string): boolean {
  const tokens = text.trim().split(/\s+/);
  return tokens.some((token) => ID_LIKE.test(token)) && tokens.every((token) => ID_LIKE.test(token) || /^[a-z0-9_]+$/.test(token));
}

/** The text a person sees in an HTML fragment: the text between tags, then the values of title, aria-label, placeholder and alt. Scripts and styles are dropped. */
export function htmlText(raw: string): string[] {
  // A line break inside one run of text keeps its words in one piece ("Sterling<br>Sovereign AI" is one heading).
  const body = raw.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<br\s*\/?>/gi, ' ');
  const attributes = [...body.matchAll(COPY_ATTRIBUTE)].map((match) => match[1] ?? match[2] ?? '');
  const nodes = body.replace(/<[^>]*>/g, '\n').split('\n');
  return [...nodes, ...attributes].map((text) => tidy(decodeEntities(text))).filter((text) => text.length > 0);
}

/** A page script string that holds words: it contains a space, or starts with a capital letter followed by a lower-case letter. */
export function isHumanText(text: string): boolean {
  return /\s/.test(text.trim()) || /^[A-Z][a-z]/.test(text);
}

/** The text of a string or template literal, with each `${...}` removed. */
function literalText(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' ');
  return undefined;
}

function propertyName(name: ts.PropertyName): string {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isPrivateIdentifier(name) ? name.text : '';
}

function calleeName(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  if (ts.isIdentifier(callee)) return callee.text;
  return undefined;
}

/** Collects copy, each literal once (a literal can be both a call argument and a constant value). */
class Collector {
  readonly out: CopyText[] = [];
  private readonly seen = new Set<ts.Node>();

  add(node: ts.Node, text: string, options: { title?: boolean; human?: boolean } = {}): void {
    if (this.seen.has(node)) return;
    this.seen.add(node);
    const html = HTML_TAG.test(text);
    for (const piece of html ? htmlText(text) : [tidy(text)]) {
      if (piece.length === 0 || (!html && isNameList(piece)) || (options.human === true && !html && !isHumanText(piece))) continue;
      this.out.push(options.title === true ? { text: piece, title: true } : { text: piece });
    }
  }

  /** Marks every literal under `node` as seen, so no later pass reads it as copy (a model instruction). */
  skip(node: ts.Node): void {
    if (literalText(node) !== undefined) this.seen.add(node);
    ts.forEachChild(node, (child) => { this.skip(child); });
  }

  /** Every string under `node`. With `copyKeysOnly`, an object literal gives only the values of its copy keys (label, description, ...). */
  gather(node: ts.Node, copyKeysOnly: boolean, title = false): void {
    if (ts.isTypeNode(node)) return;
    const text = literalText(node);
    if (text !== undefined) {
      this.add(node, text, { title });
      if (ts.isTemplateExpression(node)) for (const span of node.templateSpans) this.gather(span.expression, copyKeysOnly);
      return;
    }
    if (ts.isPropertyAssignment(node)) {
      if (!copyKeysOnly || COPY_KEYS.has(propertyName(node.name))) this.gather(node.initializer, copyKeysOnly);
      return;
    }
    if (ts.isElementAccessExpression(node)) { this.gather(node.expression, copyKeysOnly); return; }
    ts.forEachChild(node, (child) => { this.gather(child, copyKeysOnly); });
  }
}

const isExported = (node: ts.VariableStatement): boolean => node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;

/** Extension code: copy calls and exported text constants everywhere, and host-built HTML in services files. */
function walkHost(file: ts.SourceFile, collector: Collector, services: boolean): void {
  const instructions = new Set(MODEL_INSTRUCTIONS.filter((row) => row.file === file.fileName).map((row) => row.name));
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name !== undefined && (MESSAGE_CALL.test(name) || OPTION_CALLS.has(name))) for (const argument of node.arguments) collector.gather(argument, true);
      if (name === 'createWebviewPanel' && node.arguments.length > 1) collector.gather(node.arguments[1], true, true);
    }
    if (ts.isVariableStatement(node) && isExported(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer || !TEXT_CONSTANT.test(declaration.name.text)) continue;
        if (instructions.has(declaration.name.text)) collector.skip(declaration.initializer);
        else collector.gather(declaration.initializer, false);
      }
    }
    if (services) {
      const text = literalText(node);
      if (text !== undefined && HTML_TAG.test(text)) collector.add(node, text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
}

/**
 * The workbench pages' DOM helpers (D-33): for each function declared in the file, the position of its parameter named `className`. The position is read
 * from the helper itself, because the modules disagree: team-preview's element() takes (tag, className, text), the compliance, portfolio and work-area
 * pages' element() takes (tag, text, className).
 */
function classNameParameters(file: ts.SourceFile): Map<string, number> {
  const out = new Map<string, number>();
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      const at = node.parameters.findIndex((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === 'className');
      if (at >= 0) out.set(node.name.text, at);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

/** True when a workbench literal is a name: a `Symbol()` description, or the class name argument of the file's own DOM helper. */
function isWorkbenchName(node: ts.Node, classNames: ReadonlyMap<string, number>): boolean {
  const parent = node.parent;
  if (!ts.isCallExpression(parent) || parent.expression === node || !ts.isIdentifier(parent.expression)) return false;
  const name = parent.expression.text;
  if (name === 'Symbol') return true;
  const at = classNames.get(name);
  return at !== undefined && parent.arguments[at] === node;
}

/** True when a page script literal is a name (selector, event, attribute, class, message type or comparison value), not copy. */
function isPageName(node: ts.Node): boolean {
  const parent = node.parent;
  if (ts.isExpressionStatement(parent) || ts.isImportDeclaration(parent) || ts.isCaseClause(parent) || ts.isLiteralTypeNode(parent)) return true;
  if ((ts.isPropertyAssignment(parent) || ts.isPropertyAccessExpression(parent)) && parent.name === node) return true;
  if (ts.isPropertyAssignment(parent) && NAME_PROPERTIES.has(propertyName(parent.name))) return true;
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) return true;
  if (ts.isBinaryExpression(parent)) {
    const operator = parent.operatorToken.kind;
    if ([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(operator)) return true;
    if (operator === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(parent.left) && NAME_PROPERTIES.has(parent.left.name.text)) return true;
  }
  if (ts.isCallExpression(parent) && parent.expression !== node) {
    const name = calleeName(parent);
    const owner = ts.isPropertyAccessExpression(parent.expression) ? parent.expression.expression : undefined;
    if (name !== undefined && owner !== undefined && ts.isPropertyAccessExpression(owner) && owner.name.text === 'classList' && CLASS_LIST_CALLS.has(name)) return true;
    if (name !== undefined && PAGE_NAME_CALLS.has(name) && parent.arguments[0] === node) return true;
  }
  return false;
}

/** The fields of an RPC result that carry words to the browser: ServiceResult's reason and fix, a result's message, a listed item's title. */
const RESULT_COPY_KEYS = new Set(['message', 'reason', 'fix', 'title', 'label', 'description', 'detail']);

/** The workbench backend: text constants, the values of result copy fields, and refused() arguments (see WORKBENCH_BACKEND). */
function walkBackend(file: ts.SourceFile, collector: Collector): void {
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && TEXT_CONSTANT.test(node.name.text)) collector.gather(node.initializer, false);
    if (ts.isPropertyAssignment(node) && RESULT_COPY_KEYS.has(propertyName(node.name))) collector.gather(node.initializer, false);
    if (ts.isCallExpression(node) && calleeName(node) === 'refused') for (const argument of node.arguments) collector.gather(argument, false);
    ts.forEachChild(node, visit);
  };
  visit(file);
}

/** A page script: every string that holds words, and the text of HTML it builds. A workbench page also knows its own name positions. */
function walkPage(file: ts.SourceFile, collector: Collector, workbench = false): void {
  const classNames = workbench ? classNameParameters(file) : new Map<string, number>();
  const visit = (node: ts.Node): void => {
    const text = literalText(node);
    if (text !== undefined && !isPageName(node) && !(workbench && isWorkbenchName(node, classNames))) collector.add(node, text, { human: true });
    ts.forEachChild(node, visit);
  };
  visit(file);
}

/** The user copy of one source file, by its path from the repository root. */
export function extractCopy(source: string, file: string): CopyText[] {
  if (path.posix.basename(file) === 'package.json') return extractPackage(JSON.parse(source) as unknown);
  if (file.endsWith('.html')) return htmlText(source).map((text) => ({ text }));
  const page = file.startsWith('media/');
  // The Sterling workbench's pages build their DOM from inline strings, so they are read as page scripts, parsed as TypeScript (D-33); so are the
  // sovereignty badge and card's words (48.4 D-35).
  const workbench = [...WORKBENCH_SOURCES, ...SOVEREIGNTY_SOURCES].some((folder) => file.startsWith(`${folder}/`));
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, page ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const collector = new Collector();
  if (file.startsWith(`${WORKBENCH_BACKEND}/`)) walkBackend(parsed, collector);
  else if (page || workbench) walkPage(parsed, collector, workbench);
  else walkHost(parsed, collector, file.startsWith('src/services/'));
  return collector.out;
}

function listFiles(root: string, folder: string, keep: (file: string) => boolean, out: string[]): void {
  for (const entry of readdirSync(path.join(root, folder), { withFileTypes: true })) {
    const relative = `${folder}/${entry.name}`;
    if (entry.isDirectory()) listFiles(root, relative, keep, out);
    else if (entry.isFile() && keep(relative)) out.push(relative);
  }
}

/**
 * Every copy source under `root`, sorted: package.json, src/**\/*.ts outside src/test, media/**\/*.js and *.html outside media/vendor, the Sterling
 * workbench's browser and common sources (D-33), and its backend sources, read only for what they send to the browser (WORKBENCH_BACKEND).
 */
export function copySourceFiles(root: string = REPO_ROOT): string[] {
  const out = ['package.json'];
  const typescript = (file: string): boolean => file.endsWith('.ts') && !file.endsWith('.d.ts');
  listFiles(root, 'src', (file) => typescript(file) && !file.startsWith('src/test/') && !NEVER_SCANNED.includes(file), out);
  listFiles(root, 'media', (file) => (file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.html')) && !file.startsWith('media/vendor/'), out);
  for (const folder of [...WORKBENCH_SOURCES, WORKBENCH_BACKEND]) listFiles(root, folder, typescript, out);
  return out.sort();
}

// ---- Rules ----

/** A word from the glossary's "never on main screens" column, with the user word to suggest. */
export interface GlossaryWord {
  /** The word as allowed-context rows name it. */
  readonly word: string;
  /** A regular expression source, matched as a whole token (no letter, digit or underscore on either side). */
  readonly pattern: string;
  readonly caseSensitive: boolean;
  readonly instead: string;
}

const PROOF = '"Verified", "Model verified, connection not proven" or "Not verified", followed by what (the trust details pane may say more)';
const RUNS_ON = '"Runs on" in plain words: this computer, your organization\'s server, NEAR AI private hardware';
const RULES_WORD = '"your organization\'s rules" (or "your rules")';
const EXPORT_SHOWN = 'the shown words from the label module: "Controlled goods (Canada)", "ITAR", "US export-controlled (EAR)"';
const EXPORT_DECISION = '"Allowed to see: {marking} until {date}, decided by {name}" (administrator and officials\' pages only)';

const glossary = (word: string, pattern: string, caseSensitive: boolean, instead: string): GlossaryWord => Object.freeze({ word, pattern, caseSensitive, instead });

/**
 * The glossary's "never on main screens" words (GLOSSARY.md sections 1 to 3, with the export-control rows of D-64). Nouns also match their plural.
 *
 * Left out on purpose, because each is ordinary English in another sense and a count would be mostly noise: host, provider, node, cell, grant, writer,
 * device, member, workspace, layer, mark, role, relay. People review those in copy. "Team Mode" is counted by the bare team rule only, never twice.
 */
export const GLOSSARY_WORDS: readonly GlossaryWord[] = Object.freeze([
  // Section 1: content, use and where AI runs.
  glossary('TEE', 'TEE', true, PROOF),
  glossary('TDX', 'TDX', true, PROOF),
  glossary('SEV-SNP', 'SEV-SNP', true, PROOF),
  glossary('enclave', 'enclaves?', false, PROOF),
  glossary('attested', 'attested', false, PROOF),
  glossary('attestation', 'attestations?', false, PROOF),
  glossary('T0 to T3', 'T[0-3]', true, 'the use in plain words: research only, chat you review, agent work, operational work'),
  glossary('tier', 'tiers?', false, 'plain use words, "where it may go", or "Models by job"'),
  ...['nearai-tee', 'org-tee', 'vendor-tee', 'vendor-region', 'org-plain', 'closed-api'].map((id) => glossary(id, id, true, RUNS_ON)),
  glossary('session mark', 'session\\s+marks?', false, '"this chat\'s label"'),
  glossary('policy bundle', 'policy\\s+bundles?', false, RULES_WORD),
  glossary('issuer', 'issuers?', false, RULES_WORD),
  glossary('residency', 'residency', false, '"must stay in Canada" (or the region named)'),
  glossary('sovereign', 'sovereign', false, '"must stay in Canada" (or the region named)'),
  // 48.4 D-35, D-04: Sovereignty only as the badge and card name (allowed-context rows, one per file, added by the plans that build them).
  glossary('sovereignty', 'sovereignty', false, 'Sovereignty only as the badge and card name; the dimension\'s plain name elsewhere ("Where your data is stored")'),
  glossary('SEAL', 'SEAL', true, 'the sovereignty card\'s state words (Met, Partly met, Not met, Unknown), never a level or a score'),
  glossary('sovereignty score', 'sovereignty\\s+scores?', false, 'the worst state and counts, never a score (48.4 D-02)'),
  glossary('model passport', 'model\\s+passports?', false, '"Approved for {use words} until {date}"'),
  glossary('passport', 'passports?', false, '"Approved for {use words} until {date}"'),
  glossary('risk acceptance', 'risk\\s+acceptances?', false, '"Allowed by {name} until {date}"'),
  // Section 1, export-controlled content (D-64).
  glossary('CGP', 'CGP', true, EXPORT_SHOWN),
  glossary('ITAR', 'ITAR', true, EXPORT_SHOWN),
  glossary('EAR', 'EAR', true, EXPORT_SHOWN),
  glossary('regime', 'regimes?', false, EXPORT_SHOWN),
  glossary('exportControl', 'exportControl', true, EXPORT_SHOWN),
  glossary('export-person', 'export-person', true, EXPORT_DECISION),
  glossary('export-endpoint', 'export-endpoint', true, EXPORT_DECISION),
  glossary('designated official', 'designated\\s+officials?', false, EXPORT_DECISION),
  glossary('empowered official', 'empowered\\s+officials?', false, EXPORT_DECISION),
  // Section 2: agents and people.
  glossary('squad', 'squads?', false, '"agent team"'),
  glossary('crew', 'crews?', false, '"agent team"'),
  glossary('seat', 'seats?', false, '"Agent" with its job, or "Position"'),
  glossary('lead agent', 'lead\\s+agents?', false, '"coordinating agent"'),
  glossary('genesis', 'genesis', false, 'the joining word from term(), or "People"'),
  glossary('join secret', 'join\\s+secrets?', false, 'the joining word from term() (invitation file and safety code)'),
  glossary('key group', 'key\\s+groups?', false, '"Who can see this"'),
  glossary('epoch', 'epochs?', false, '"Who can see this"'),
  // Section 3: places, connections and sharing.
  glossary('hub', 'hubs?', false, '"your organization\'s server"'),
  glossary('appliance', 'appliances?', false, '"your organization\'s server"'),
  glossary('L1a', 'L1a', true, '"your organization\'s server"'),
  glossary('endpoint', 'endpoints?', false, '"AI service"'),
  glossary('profile', 'profiles?', false, '"Connection", "Doctrine" or "Your directive"'),
  glossary('Project Sync', 'Project\\s+Sync', false, '"My computers"'),
  glossary('online home', 'online\\s+homes?', false, '"My computers" (say "GitHub repository" once)'),
  glossary('multi-user', 'multi-user', false, '"Share with people"'),
  glossary('replica', 'replicas?', false, '"Share with people"'),
  glossary('GSD', 'GSD', true, '"Workflows" (GSD is for the Tools page detail only)'),
  glossary('Staff Center', 'staff\\s+cent(?:er|re)s?', false, '"Staff Room" (owner, 2026-11-24: the one name for a staff team\'s shared room)'),
  glossary('T0 lane', 'T0\\s+lane', false, '"Research workspace"')
]);

/** Where a glossary word may appear, and why. A file listed here must exist (a test checks it), so a moved file cannot widen the table silently. */
export interface AllowedContext {
  readonly file: string;
  readonly words: readonly string[];
  readonly why: string;
}

const PROOF_WORDS = ['TEE', 'TDX', 'SEV-SNP', 'enclave', 'attested', 'attestation'];
const EXPORT_WORDS = ['CGP', 'ITAR', 'EAR', 'regime', 'exportControl', 'export-person', 'export-endpoint', 'designated official', 'empowered official'];

/**
 * The allowed-context table (GLOSSARY section 5 rule 1). The officials' pages of Phases 44 and 45 add their own rows when they land, each with its reason.
 */
export const ALLOWED_CONTEXTS: readonly AllowedContext[] = Object.freeze([
  { file: 'src/services/trustDetails.ts', words: PROOF_WORDS, why: 'the trust details pane, where the proof words belong (glossary section 1)' },
  { file: 'src/services/toolsPage.ts', words: ['GSD'], why: 'Tools page detail only (glossary section 3)' },
  { file: 'media/tools/tools.js', words: ['GSD'], why: 'Tools page detail only (glossary section 3)' },
  { file: 'src/domain/gate/labels.ts', words: ['CGP', 'ITAR', 'EAR'], why: 'the label module that holds the reserved compartments\' shown words; they are produced there (D-62)' },
  { file: 'src/services/policyEditor.ts', words: EXPORT_WORDS, why: 'your organization\'s rules page, the administrator view (glossary section 1, D-64)' },
  { file: 'media/policy/policy.js', words: EXPORT_WORDS, why: 'your organization\'s rules page, the administrator view (glossary section 1, D-64)' },
  { file: 'workbench/extension/src/common/compliance-evidence.ts', words: ['attestation'], why: 'the cosign verify-attestation and gh attestation verify commands\' own names, inside the release checks disclosure (48.2-UI-SPEC P5)' },
  { file: 'workbench/extension/src/common/staff-share.ts', words: ['hub'], why: 'the grant trade-off, shown word for word as hubMembership.ts HUB_GRANT_TRADE_OFF says it (DESIGN 10.2, 33-27)' }
].map((row) => Object.freeze({ ...row, words: Object.freeze([...row.words]) })));

const TOKEN_BEFORE = '(?<![A-Za-z0-9_])';
const TOKEN_AFTER = '(?![A-Za-z0-9_])';
const GLOSSARY_MATCHERS = GLOSSARY_WORDS.map((entry) => ({ word: entry.word, regex: new RegExp(`${TOKEN_BEFORE}(?:${entry.pattern})${TOKEN_AFTER}`, entry.caseSensitive ? 'g' : 'gi') }));

/** A brand spelling is joined to a name (near-ai-vscode, vscode.open, @vscode/vsce, nearAi.baseUrl) when a -, /, . or @ links it to a letter or digit. */
const BRAND_BEFORE = '(?<![A-Za-z0-9_]|[A-Za-z0-9_][-/.@])';
const BRAND_AFTER = '(?![A-Za-z0-9_]|[-/.@][A-Za-z0-9_])';
const BRANDS: ReadonlyArray<{ readonly regex: RegExp; readonly correct: string }> = [
  { regex: new RegExp(`${BRAND_BEFORE}near\\s?ai${BRAND_AFTER}`, 'gi'), correct: 'NEAR AI' },
  { regex: new RegExp(`${BRAND_BEFORE}vs\\s?code${BRAND_AFTER}`, 'gi'), correct: 'VS Code' }
];
/** A brand prefix on a panel or command title, in any case. */
const TITLE_PREFIX = /^\s*near\s?ai\s*:/i;
/**
 * Rule 8 (owner, 2026-11-24): the product is Sterling Sovereign AI, short name SovAI, and NEAR AI is only the provider. The old product names
 * ("NEAR AI for VS Code", "the NEAR AI extension") and a "NEAR AI:" command prefix anywhere in a sentence count. A prefix at the start of a title is
 * already a brand hit, so it is not counted twice.
 */
const OLD_PRODUCT_NAMES: readonly RegExp[] = [
  /(?<![A-Za-z0-9_])near\s?ai\s+for\s+vs\s?code(?![A-Za-z0-9_])/gi,
  /(?<![A-Za-z0-9_])near\s?ai\s+extensions?(?![A-Za-z0-9_])/gi,
  /(?<![A-Za-z0-9_])near\s?ai\s*:/gi
];

/** The old product name hits in `text` (rule 8). A title's leading prefix is left to the brand rule. */
export function productNameHits(text: string, title = false): number {
  const rest = title ? text.replace(TITLE_PREFIX, '') : text;
  return OLD_PRODUCT_NAMES.reduce((sum, regex) => sum + [...rest.matchAll(regex)].length, 0);
}

/**
 * The documentation people read about the product (rule 8 outside the extension's copy): README.md, SECURITY.md, CONTRIBUTING.md, the guides in
 * docs/ and docs-site/content/, the docs site's README, configuration and sidebars, and the workbench's README and MIGRATION.md. CHANGELOG.md is
 * history and is not read.
 */
export function documentationFiles(root: string = REPO_ROOT): string[] {
  const out = ['README.md', 'SECURITY.md', 'CONTRIBUTING.md', 'docs-site/README.md', 'docs-site/docusaurus.config.js', 'docs-site/sidebars.js',
    'workbench/README.md', 'workbench/MIGRATION.md'];
  const markdown = (file: string): boolean => file.endsWith('.md') || file.endsWith('.mdx');
  listFiles(root, 'docs', markdown, out);
  listFiles(root, 'docs-site/content', markdown, out);
  return out.filter((file) => existsSync(path.join(root, file))).sort();
}

/** The provider's name, with or without AI and an apostrophe s, in front of organization (the user word is always "your organization"). */
const PROVIDER_ORGANIZATION = /(?<![A-Za-z0-9_])NEAR(?:\s+AI)?(?:['’]s)?\s+organi[sz]ations?(?![A-Za-z0-9_])/gi;

interface Hit {
  readonly start: number;
  readonly end: number;
  readonly key: string;
}

function hitsOf(text: string, regex: RegExp, key: string): Hit[] {
  return [...text.matchAll(regex)].map((match) => ({ start: match.index, end: match.index + match[0].length, key }));
}

/** The longest hit wins where hits overlap, so one phrase counts once ("model passport" is not also "passport"). */
function longestFirst(hits: readonly Hit[]): Hit[] {
  const sorted = [...hits].sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start);
  const taken: Hit[] = [];
  for (const hit of sorted) if (!taken.some((other) => hit.start < other.end && other.start < hit.end)) taken.push(hit);
  return taken;
}

function brandHits(text: string, title: boolean): number {
  let count = 0;
  let rest = text;
  const prefix = title ? TITLE_PREFIX.exec(text) : null;
  if (prefix) { count += 1; rest = text.slice(prefix[0].length); }
  for (const { regex, correct } of BRANDS) for (const match of rest.matchAll(regex)) if (match[0].replace(/\s/g, ' ') !== correct) count += 1;
  return count;
}

function countOf(text: string, needle: string): number {
  let count = 0;
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) count += 1;
  return count;
}

/**
 * Single words that are mode words and not ordinary English, so a count is a real hit. Left out because each is also plain English or a word every mode
 * uses in another sense: Position, Member, Invitation, Accept, Decline, Guest, Removed, Handover, Acting, Role, Employee, People and Approved.
 */
export const DISTINCTIVE_MODE_WORDS: readonly string[] = Object.freeze(['Directorate', 'Dual-hatted', 'Roster']);

/** The mode words rule 2 counts: every `word` and `also` value of the mode table with two or more words, plus DISTINCTIVE_MODE_WORDS. Never spelled here. */
export function modeWordsFromTable(modes: Readonly<Record<ModeId, ModeRow>> = MODES): string[] {
  const words = new Set<string>(DISTINCTIVE_MODE_WORDS);
  for (const row of Object.values(modes)) {
    for (const entry of Object.values(row.words)) for (const word of [entry.word, ...(entry.also ?? [])]) if (/\s/.test(word.trim())) words.add(word.trim());
  }
  return [...words].sort();
}

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const phraseRegex = (phrase: string): RegExp => new RegExp(`${TOKEN_BEFORE}${phrase.split(/\s+/).map(escapeRegex).join('\\s+')}${TOKEN_AFTER}`, 'gi');
const modeMatchers = (words: readonly string[]): Array<{ word: string; regex: RegExp }> => words.map((word) => ({ word, regex: phraseRegex(word) }));
const DEFAULT_MODE_MATCHERS = modeMatchers(modeWordsFromTable());

/**
 * Rule 6 (owner, 2026-11-20): team, teams or team's, unless "agent" or "work" comes before it, or it is Microsoft Teams. "Team Mode" counts here.
 * "Defence team" is allowed too (owner, 2026-11-21): the Military and Public service mode word "Defence team member" names the whole Defence Team.
 */
const TEAM_WORD = /(?<![A-Za-z0-9_])teams?(?:['\u2019]s)?(?![A-Za-z0-9_])/gi;
const TEAM_QUALIFIER = /(?:agent|work|defence)[\s-]+$/i;
const MICROSOFT = /Microsoft\s+$/;

function bareTeamHits(text: string): number {
  let count = 0;
  for (const match of text.matchAll(TEAM_WORD)) {
    const before = text.slice(0, match.index);
    if (TEAM_QUALIFIER.test(before) || (match[0] === 'Teams' && MICROSOFT.test(before))) continue;
    count += 1;
  }
  return count;
}

/**
 * The sovereignty overclaims (48.4 D-35; GLOSSARY section 5 rule 6): a product named Sterling Sovereign AI must never call itself any of these. The
 * sovereignty card shows a state with its evidence instead. They are compliance claims in user copy (rule 7) and are also read in the documentation
 * files (overclaimHits). "Sterling Sovereign AI" is a name and is stripped before matching (EDITION_NAME).
 */
export const SOVEREIGNTY_OVERCLAIMS: readonly string[] = Object.freeze([
  'fully sovereign', '100% sovereign', '100% Canadian', 'sovereign by default', 'sovereignty certified', 'certified sovereign'
]);

/**
 * Rule 7 (D-64; GLOSSARY section 5; CGP-ITAR.md section 10.3): claims about the product, the sovereignty overclaims included (spelled out, because
 * compliance/src/wordLint.ts copies this list and compliance/test/wordLintParity.test.ts reads it literally). The longest phrase wins, so "ITAR compliant"
 * counts once and not also as "compliant", and "certified sovereign" not also as "certified".
 */
export const COMPLIANCE_CLAIMS: readonly string[] = Object.freeze([
  'ITAR compliant', 'ITAR certified', 'CGP compliant', 'CGP approved', 'export compliant', 'controlled goods approved', 'fully sovereign', '100% sovereign',
  '100% Canadian', 'sovereign by default', 'sovereignty certified', 'certified sovereign', 'compliant', 'accredited', 'certified'
]);
const CLAIM_MATCHERS = COMPLIANCE_CLAIMS.map((phrase) => ({ phrase, regex: phraseRegex(phrase) }));
const OVERCLAIM_MATCHERS = SOVEREIGNTY_OVERCLAIMS.map((phrase) => ({ phrase, regex: phraseRegex(phrase) }));
/** A claim is honest when its own sentence negates it before the phrase ("is not certified", "does not make ... accredited"). */
const NEGATION = /(?<![A-Za-z0-9_])(?:not|never|no|cannot|without|isn['\u2019]t|doesn['\u2019]t)(?![A-Za-z0-9_])/i;
/** "Nothing here is 100% Canadian" is the same negation in sentence form; compliance/src/wordLint.ts reads it the same way. */
const NOTHING = /(?<![A-Za-z0-9_])nothing(?![A-Za-z0-9_])/i;
const SENTENCE_BREAK = /[.!?]\s+|\n/;

/** Where a compliance phrase may appear, and why. */
export interface ClaimContext {
  readonly file: string;
  readonly phrases: readonly string[];
  readonly why: string;
}

/**
 * Files whose compliance phrases are statuses with evidence, never a claim. It starts empty: Phase 44 adds its compliance pages when they land, each row
 * with its reason.
 */
export const ALLOWED_CLAIM_CONTEXTS: readonly ClaimContext[] = Object.freeze([]);

/** True when the hit's own sentence negates it before the phrase. */
function negated(text: string, hit: Hit): boolean {
  const sentence = text.slice(0, hit.start).split(SENTENCE_BREAK).pop() ?? '';
  return NEGATION.test(sentence) || NOTHING.test(sentence);
}

function claimHits(text: string, allowed: ReadonlySet<string>): number {
  const hits = longestFirst(CLAIM_MATCHERS.flatMap(({ phrase, regex }) => hitsOf(text, regex, phrase)));
  return hits.filter((hit) => !allowed.has(hit.key.toLowerCase()) && !negated(text, hit)).length;
}

/**
 * The sovereignty overclaims in `text` (48.4 D-35), one entry per hit in order of appearance, with the same negation rule as rule 7. Used over whole
 * documentation files (documentationFiles), where the extension's copy rules are not run. The product's name is stripped first.
 */
export function overclaimHits(text: string): string[] {
  const plain = text.replace(EDITION_NAME, ' ');
  return longestFirst(OVERCLAIM_MATCHERS.flatMap(({ phrase, regex }) => hitsOf(plain, regex, phrase)))
    .filter((hit) => !negated(plain, hit))
    .sort((a, b) => a.start - b.start)
    .map((hit) => hit.key);
}

export interface CountOptions {
  /** The allowed-context table; tests pass their own. Defaults to ALLOWED_CONTEXTS. */
  readonly allowedContexts?: readonly AllowedContext[];
  /** The mode words; tests pass their own. Defaults to modeWordsFromTable(). */
  readonly modeWords?: readonly string[];
  /** The claim contexts; tests pass their own. Defaults to ALLOWED_CLAIM_CONTEXTS. */
  readonly claimContexts?: readonly ClaimContext[];
}

/**
 * The Sterling edition's own name (design D1 and D10; D-08, D-33): "Sterling Sovereign AI" is a name, so its "Sovereign" is not the glossary word. Only the
 * whole phrase: "sovereign" anywhere else still counts. "Sterling" and "SovAI" need no rule, because BRANDS knows only NEAR AI and VS Code.
 */
const EDITION_NAME = /(?<![A-Za-z0-9_])Sterling\s+Sovereign\s+AI(?![A-Za-z0-9_])/g;

/** The hits of every rule in `texts`, all counted under `file`. Returns `{}` when nothing is hit, never a zero count. */
export function countHits(texts: readonly CopyText[], file: string, options: CountOptions = {}): CopyCounts {
  if (NEVER_SCANNED.includes(file)) return {};
  const allowed = new Set((options.allowedContexts ?? ALLOWED_CONTEXTS).filter((row) => row.file === file).flatMap((row) => row.words));
  const claimsAllowed = new Set((options.claimContexts ?? ALLOWED_CLAIM_CONTEXTS).filter((row) => row.file === file).flatMap((row) => row.phrases.map((phrase) => phrase.toLowerCase())));
  const modes = options.modeWords === undefined ? DEFAULT_MODE_MATCHERS : modeMatchers(options.modeWords);
  const rules: Partial<Record<CopyRule, number>> = {};
  const add = (rule: CopyRule, count: number): void => { if (count > 0) rules[rule] = (rules[rule] ?? 0) + count; };
  for (const { text: copy, title } of texts) {
    const text = copy.replace(EDITION_NAME, ' ');
    add('em-dash', countOf(text, EM_DASH));
    add('glossary', longestFirst(GLOSSARY_MATCHERS.flatMap(({ word, regex }) => hitsOf(text, regex, word))).filter((hit) => !allowed.has(hit.key)).length);
    add('brand', brandHits(text, title === true));
    add('mode-word', longestFirst(modes.flatMap(({ word, regex }) => hitsOf(text, regex, word))).length);
    add('provider-organization', hitsOf(text, PROVIDER_ORGANIZATION, 'provider').length);
    add('bare-team', bareTeamHits(text));
    add('compliance-claim', claimHits(text, claimsAllowed));
    add('product-name', productNameHits(text, title === true));
  }
  return Object.keys(rules).length > 0 ? { [file]: rules } : {};
}

function mergeInto(target: CopyCounts, counts: CopyCounts): void {
  for (const [file, rules] of Object.entries(counts)) {
    const into = (target[file] ??= {});
    for (const [rule, count] of Object.entries(rules) as Array<[CopyRule, number]>) into[rule] = (into[rule] ?? 0) + count;
  }
}

/** Every copy source under `root`, counted per file and rule. */
export function scanRepository(root: string = REPO_ROOT): CopyCounts {
  const counts: CopyCounts = {};
  for (const file of copySourceFiles(root)) mergeInto(counts, countHits(extractCopy(readFileSync(path.join(root, file), 'utf8'), file), file));
  return counts;
}

function line(file: string, rule: string, before: number, now: number): string {
  return `${file}  ${rule}  ${String(before)} -> ${String(now)}`;
}

/** Counts above the baseline (`increased`, always a failure) and baseline counts above today's (`stale`, a failure only when the baseline must be tight). */
export function compareWithBaseline(counts: CopyCounts, baseline: CopyCounts): { increased: string[]; stale: string[] } {
  const increased: string[] = [];
  const stale: string[] = [];
  const files = [...new Set([...Object.keys(counts), ...Object.keys(baseline)])].sort();
  for (const file of files) {
    for (const rule of COPY_RULES) {
      const now = counts[file]?.[rule] ?? 0;
      const before = baseline[file]?.[rule] ?? 0;
      if (now > before) increased.push(line(file, rule, before, now));
      else if (now < before) stale.push(line(file, rule, before, now));
    }
  }
  return { increased, stale };
}

/** The failure message for increased counts: which rule, which file, what to use instead, and how a moved count is handled. */
export function increaseMessage(increased: readonly string[]): string {
  if (increased.length === 0) return 'no new copy lint hits';
  const rules = [...new Set(increased.map((entry) => entry.split('  ')[1] as CopyRule))];
  return [
    'New copy lint hits (file  rule  baseline -> now):',
    ...increased.map((entry) => `  ${entry}`),
    'Use instead:',
    ...rules.map((rule) => `  ${rule}: ${RULE_ADVICE[rule]}`),
    'A count that moved with code from another file moves in the baseline with it: the rule\'s total must not grow. Fix new copy, never raise the baseline.'
  ].join('\n');
}

/**
 * The tightness check (the D-45 pattern applied to the copy lint): a baseline count above today's count is stale. With `tight` (NEAR_AI_BASELINE_TIGHT=1,
 * set by the closing plan of a phase) it fails, naming each; otherwise the same list goes to `diagnostic` and the run passes.
 */
export function checkTightness(stale: readonly string[], tight: boolean, diagnostic: (note: string) => void): void {
  if (stale.length === 0) return;
  const message = [
    'Stale copy lint baseline counts (file  rule  baseline -> now). Lower them: run the copy lint once with NEAR_AI_WRITE_BASELINE=1 and review the diff.',
    ...stale.map((entry) => `  ${entry}`)
  ].join('\n');
  if (tight) throw new Error(message);
  diagnostic(message);
}

/** The baseline file's text: files sorted, rules sorted, zero counts left out, two-space indent, a trailing newline. */
export function baselineText(counts: CopyCounts): string {
  const sorted: Record<string, Record<string, number>> = {};
  for (const file of Object.keys(counts).sort()) {
    const rules: Record<string, number> = {};
    for (const rule of Object.keys(counts[file]).sort() as CopyRule[]) {
      const count = counts[file][rule] ?? 0;
      if (count > 0) rules[rule] = count;
    }
    if (Object.keys(rules).length > 0) sorted[file] = rules;
  }
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

export function readBaseline(file: string = BASELINE_PATH): CopyCounts {
  return JSON.parse(readFileSync(file, 'utf8')) as CopyCounts;
}

/** The write mode: records the baseline from `counts` and then always fails, so a run with NEAR_AI_WRITE_BASELINE=1 can never pass silently. */
export function writeBaselineAndFail(file: string, counts: CopyCounts): never {
  writeFileSync(file, baselineText(counts));
  throw new Error('baseline written; review the diff and run again without NEAR_AI_WRITE_BASELINE');
}
