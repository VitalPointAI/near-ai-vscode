// The exchange and interconnection register (48.1-01, D-10; CA-3, CA-9, SA-9(2)): one source, compliance/hosted/exchanges.json, rendered as
// the register table and the exchange diagram of docs/security/hosted-interconnections.md, and checked against the code:
//   - every module under deploy/ (tests excluded) that calls signFile, verifySignedFile, signBlob, verifyBlob, signImage or verifyImage is
//     named by an implemented exchange, so a new signing module cannot land without its exchange;
//   - every implemented exchange's implementedBy paths exist; a planned exchange names plannedIn, and once one of its modules exists the
//     check warns that it should be marked implemented without failing (another phase's pull request is never blocked by this register);
//   - every siteSettings entry, `<file under deploy/values/>#<dotted key>`, exists in the site example.
// Node built-ins only (it runs in the docs CI job without the compliance package); the schema check stays in `validate`.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Block, CheckResult, SourceReader } from '../generate.ts';

export const EXCHANGES_FILE = 'compliance/hosted/exchanges.json';
export const DOCUMENT = 'docs/security/hosted-interconnections.md';
export const TO_BE_COMPLETED = 'To be completed by your organization';
/** The signing and verifying functions of deploy/bundle/lib/cosign.mjs and deploy/bundle/signed-file.mjs. */
export const SIGNING_FUNCTIONS = Object.freeze(['signFile', 'verifySignedFile', 'signBlob', 'verifyBlob', 'signImage', 'verifyImage']);

export interface Exchange {
  readonly id: string;
  readonly title: string;
  readonly kind: 'file' | 'network';
  readonly from: string;
  readonly to: string;
  readonly direction: 'one-way' | 'both-ways';
  readonly data: string;
  readonly format: string;
  readonly protection: string;
  readonly frequency: string;
  readonly status: 'implemented' | 'planned';
  readonly implementedBy?: readonly string[];
  readonly plannedIn?: string;
  readonly siteSettings: readonly string[];
  readonly controls: readonly string[];
  readonly agreement: string;
  /** 48.4 D-08: the ISO 3166-1 alpha-2 code of the legal seat of the far end's operator, `org` when your organization operates it, or `unknown`. */
  readonly operatorJurisdiction: string;
  /** 48.4 D-08: where the far end is: an ISO 3166-1 alpha-2 code, `site` when it is inside the site, or `unknown`. */
  readonly location: string;
}
export interface ExchangeRegister { readonly exchanges: readonly Exchange[] }

const CALL = new RegExp(`(?<![\\w$.])(${SIGNING_FUNCTIONS.join('|')})\\s*\\(`, 'g');
const CODE_FILE = /\.(?:mjs|cjs|js|ts)$/;
const OPERATOR_JURISDICTION = /^(?:[A-Z]{2}|org|unknown)$/;
const LOCATION = /^(?:[A-Z]{2}|site|unknown)$/;
const SETTING = /^(site\.example\.yaml|site\.example\/[a-z0-9-]+\.yaml)#([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)$/;

function codeFiles(root: string, dir: string): string[] {
  const full = path.join(root, dir);
  if (!existsSync(full)) return [];
  return readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return relative === 'deploy/test' || entry.name === 'node_modules' ? [] : codeFiles(root, relative);
    return entry.isFile() && CODE_FILE.test(entry.name) ? [relative] : [];
  });
}

/** The modules under deploy/ (tests excluded) that call a signing or verifying function, relative to `root`, sorted. Definitions are not calls. */
export function signingCallSites(root: string): string[] {
  return codeFiles(root, 'deploy').filter((file) => {
    const text = readFileSync(path.join(root, file), 'utf8');
    for (const match of text.matchAll(CALL)) {
      if (!/function\s*$/.test(text.slice(Math.max(0, (match.index ?? 0) - 12), match.index))) return true;
    }
    return false;
  }).sort();
}

/** Whether a dotted key exists in a site example file: JSON parsed, otherwise block YAML read by indentation. */
export function hasSetting(text: string, dotted: string): boolean {
  const keys = dotted.split('.');
  try {
    let value: unknown = JSON.parse(text);
    for (const key of keys) {
      if (typeof value !== 'object' || value === null || Array.isArray(value) || !Object.hasOwn(value, key)) return false;
      value = (value as Record<string, unknown>)[key];
    }
    return true;
  } catch { /* not JSON: block YAML */ }
  const lines = text.split('\n').filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'));
  let start = 0;
  let end = lines.length;
  let parentIndent = -1;
  for (const key of keys) {
    const indentOf = (line: string) => line.length - line.trimStart().length;
    const childIndent = start < end ? indentOf(lines[start]) : -1;
    if (childIndent <= parentIndent) return false;
    let found = -1;
    for (let index = start; index < end; index += 1) {
      const indent = indentOf(lines[index]);
      if (indent < childIndent) { end = index; break; }
      if (indent === childIndent && new RegExp(`^\\s*${key}:(\\s|$)`).test(lines[index])) { found = index; break; }
    }
    if (found < 0) return false;
    let blockEnd = found + 1;
    while (blockEnd < end && indentOf(lines[blockEnd]) > childIndent) blockEnd += 1;
    start = found + 1;
    end = blockEnd;
    parentIndent = childIndent;
  }
  return true;
}

/** The register's source checks (see the module comment). */
export function checkExchanges(root: string, register: ExchangeRegister): CheckResult {
  const problems: string[] = [];
  const warnings: string[] = [];
  const exchanges = register.exchanges ?? [];
  const named = new Map<string, Exchange[]>();
  for (const exchange of exchanges) {
    for (const file of exchange.implementedBy ?? []) named.set(file, [...(named.get(file) ?? []), exchange]);
    if (exchange.status === 'implemented') {
      if (!exchange.implementedBy?.length) problems.push(`exchange ${exchange.id} is implemented but names no implementedBy file`);
      for (const file of exchange.implementedBy ?? []) if (!existsSync(path.join(root, file))) problems.push(`exchange ${exchange.id}: implementedBy ${file} does not exist`);
    } else {
      if (!exchange.plannedIn) problems.push(`exchange ${exchange.id} is planned but names no plannedIn plan or phase`);
      const built = (exchange.implementedBy ?? []).filter((file) => existsSync(path.join(root, file)));
      if (built.length) warnings.push(`exchange ${exchange.id} is planned in ${exchange.plannedIn ?? '?'}, but ${built.join(', ')} now exists: mark it implemented in ${EXCHANGES_FILE}`);
    }
    if (!OPERATOR_JURISDICTION.test(String(exchange.operatorJurisdiction ?? ''))) {
      problems.push(`exchange ${exchange.id}: operatorJurisdiction must be an ISO 3166-1 alpha-2 code in capitals, org (your organization operates it) or unknown`);
    }
    if (!LOCATION.test(String(exchange.location ?? ''))) problems.push(`exchange ${exchange.id}: location must be an ISO 3166-1 alpha-2 code in capitals, site (inside the site) or unknown`);
    for (const setting of exchange.siteSettings ?? []) {
      const match = SETTING.exec(setting);
      if (!match) { problems.push(`exchange ${exchange.id}: site setting ${setting} is not <site.example.yaml or site.example/<file>.yaml>#<dotted key>`); continue; }
      const file = path.join(root, 'deploy', 'values', match[1]);
      if (!existsSync(file) || !hasSetting(readFileSync(file, 'utf8'), match[2])) problems.push(`exchange ${exchange.id}: site setting ${setting} is not in deploy/values/${match[1]}`);
    }
  }
  for (const file of signingCallSites(root)) {
    const owners = named.get(file) ?? [];
    if (!owners.length) problems.push(`${file} calls a signing helper (${SIGNING_FUNCTIONS.join(', ')}) but no exchange names it in implementedBy; add its exchange to ${EXCHANGES_FILE}`);
  }
  return { problems, warnings };
}

// A Markdown table cell: every backslash and pipe is escaped in one pass (so an added backslash is never escaped again), and line breaks
// become spaces.
const cell = (text: string): string => text.replace(/[\\|]/g, (character) => `\\${character}`).replace(/\s*\n\s*/g, ' ');
const code = (text: string): string => `\`${text}\``;

function parse(text: string): ExchangeRegister {
  const data = JSON.parse(text) as ExchangeRegister;
  if (!data || !Array.isArray(data.exchanges)) throw new Error(`${EXCHANGES_FILE} has no exchanges list`);
  return data;
}

/** The operator's jurisdiction and the far end's place in plain words (48.4 D-08): a country code as written, never guessed. */
const OPERATOR_WORDS: Readonly<Record<string, string>> = Object.freeze({ org: 'your organization', unknown: 'unknown' });
const PLACE_WORDS: Readonly<Record<string, string>> = Object.freeze({ site: 'at the site', unknown: 'unknown' });

/** The register table. */
export function renderTable(register: ExchangeRegister): string {
  const rows = register.exchanges.map((exchange) => {
    const route = `${exchange.from} to ${exchange.to}${exchange.direction === 'both-ways' ? ' and back' : ''}, ${exchange.kind === 'file' ? 'by file' : 'over the network'}`;
    const status = exchange.status === 'implemented' ? `Implemented: ${(exchange.implementedBy ?? []).map(code).join(', ')}` : `Planned in ${exchange.plannedIn ?? '?'}`;
    const settings = exchange.siteSettings.length ? exchange.siteSettings.map(code).join(', ') : 'None';
    const operator = OPERATOR_WORDS[exchange.operatorJurisdiction] ?? exchange.operatorJurisdiction;
    const place = PLACE_WORDS[exchange.location] ?? exchange.location;
    return `| **${cell(exchange.title)}** (${code(exchange.id)}) | ${cell(route)} | ${cell(operator)} | ${cell(place)} | ${cell(exchange.data)} Format: ${cell(exchange.format)} | ${cell(exchange.protection)} | ${cell(exchange.frequency)} | ${settings} | ${status} | ${cell(exchange.agreement)} |`;
  });
  return ['| Exchange | From and to | Operator under | Far end | Data and format | Protection | Frequency | Site settings | Status | Agreement |', '|---|---|---|---|---|---|---|---|---|---|', ...rows].join('\n');
}

const nodeId = (party: string): string => `n_${party.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`;

/** The exchange diagram: one node per party, one labelled edge per exchange, dotted for files. */
export function renderDiagram(register: ExchangeRegister): string {
  const parties = [...new Set(register.exchanges.flatMap((exchange) => [exchange.from, exchange.to]))];
  const lines = ['```mermaid', 'flowchart LR', ...parties.map((party) => `  ${nodeId(party)}["${party.replace(/"/g, "'")}"]`)];
  for (const exchange of register.exchanges) {
    const both = exchange.direction === 'both-ways' ? '<' : '';
    const arrow = exchange.kind === 'file' ? `${both}-.->` : `${both}-->`;
    lines.push(`  ${nodeId(exchange.from)} ${arrow}|"${exchange.id}"| ${nodeId(exchange.to)}`);
  }
  lines.push('```');
  return lines.join('\n');
}

const read = async (source: SourceReader): Promise<ExchangeRegister> => parse(await source.readText(EXCHANGES_FILE));

export const blocks: readonly Block[] = Object.freeze([
  {
    id: 'exchanges',
    document: DOCUMENT,
    render: async (source: SourceReader) => renderTable(await read(source)),
    check: (root: string) => checkExchanges(root, parse(readFileSync(path.join(root, EXCHANGES_FILE), 'utf8')))
  },
  { id: 'exchange-diagram', document: DOCUMENT, render: async (source: SourceReader) => renderDiagram(await read(source)) }
]);
