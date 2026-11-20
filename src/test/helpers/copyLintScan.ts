// The copy lint's scanner (FND-07, Phase 41 D-41 and D-64; GLOSSARY section 5). It reads the product's user copy sources, counts the hits of each copy
// rule per file, and compares the counts with the checked-in baseline (src/test/copy-lint-baseline.json). A helper with no `.test` suffix, so it can be
// loaded without registering tests. Pure apart from reading files under the repository root; no vscode.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';

/** The copy rules, in the order GLOSSARY section 5 and D-41 number them (the compliance claim is rule 7, after the bare team rule). */
export const COPY_RULES = ['glossary', 'mode-word', 'brand', 'em-dash', 'provider-organization', 'bare-team', 'compliance-claim'] as const;
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
  'compliance-claim': 'a status with its evidence, never a claim that the product is compliant, certified or accredited'
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

/** A name, not words: an id with a separator (nearAi.newChat, hub-revoked, room-squads) or a lower-case word beside such ids (a class list). */
const ID_LIKE = /^[a-z0-9_][A-Za-z0-9_]*(?:[-.:/@#][A-Za-z0-9_]+)+$/;
export function isNameList(text: string): boolean {
  const tokens = text.trim().split(/\s+/);
  return tokens.some((token) => ID_LIKE.test(token)) && tokens.every((token) => ID_LIKE.test(token) || /^[a-z0-9_]+$/.test(token));
}

/** The text a person sees in an HTML fragment: the text between tags, then the values of title, aria-label, placeholder and alt. Scripts and styles are dropped. */
export function htmlText(raw: string): string[] {
  const body = raw.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ');
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

/** A page script: every string that holds words, and the text of HTML it builds. */
function walkPage(file: ts.SourceFile, collector: Collector): void {
  const visit = (node: ts.Node): void => {
    const text = literalText(node);
    if (text !== undefined && !isPageName(node)) collector.add(node, text, { human: true });
    ts.forEachChild(node, visit);
  };
  visit(file);
}

/** The user copy of one source file, by its path from the repository root. */
export function extractCopy(source: string, file: string): CopyText[] {
  if (path.posix.basename(file) === 'package.json') return extractPackage(JSON.parse(source) as unknown);
  if (file.endsWith('.html')) return htmlText(source).map((text) => ({ text }));
  const page = file.startsWith('media/');
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, page ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const collector = new Collector();
  if (page) walkPage(parsed, collector);
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

/** Every copy source under `root`, sorted: package.json, src/**\/*.ts outside src/test, and media/**\/*.js and *.html outside media/vendor. */
export function copySourceFiles(root: string = REPO_ROOT): string[] {
  const out = ['package.json'];
  listFiles(root, 'src', (file) => file.endsWith('.ts') && !file.endsWith('.d.ts') && !file.startsWith('src/test/') && !NEVER_SCANNED.includes(file), out);
  listFiles(root, 'media', (file) => (file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.html')) && !file.startsWith('media/vendor/'), out);
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
  { file: 'media/policy/policy.js', words: EXPORT_WORDS, why: 'your organization\'s rules page, the administrator view (glossary section 1, D-64)' }
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

export interface CountOptions {
  /** The allowed-context table; tests pass their own. Defaults to ALLOWED_CONTEXTS. */
  readonly allowedContexts?: readonly AllowedContext[];
}

/** The hits of every rule in `texts`, all counted under `file`. Returns `{}` when nothing is hit, never a zero count. */
export function countHits(texts: readonly CopyText[], file: string, options: CountOptions = {}): CopyCounts {
  if (NEVER_SCANNED.includes(file)) return {};
  const allowed = new Set((options.allowedContexts ?? ALLOWED_CONTEXTS).filter((row) => row.file === file).flatMap((row) => row.words));
  const rules: Partial<Record<CopyRule, number>> = {};
  const add = (rule: CopyRule, count: number): void => { if (count > 0) rules[rule] = (rules[rule] ?? 0) + count; };
  for (const { text, title } of texts) {
    add('em-dash', countOf(text, EM_DASH));
    add('glossary', longestFirst(GLOSSARY_MATCHERS.flatMap(({ word, regex }) => hitsOf(text, regex, word))).filter((hit) => !allowed.has(hit.key)).length);
    add('brand', brandHits(text, title === true));
    add('provider-organization', hitsOf(text, PROVIDER_ORGANIZATION, 'provider').length);
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
