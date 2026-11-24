// Generated blocks inside the hand-written hosted SA&A documents (48.1-01, D-02, D-09). The component catalogue regenerates whole pages; these
// documents mix judgement and generated tables, so each generated part sits between two markers:
//
//   <!-- generated:<block id> begin -->
//   ...text the block's source produces...
//   <!-- generated:<block id> end -->
//
// Each block is a module in ./blocks/ exporting `blocks` (found by directory listing, so a plan adds a block without editing a list). A block
// names its document, renders its text from files read through a SourceReader, and may export source checks (detectors) that compare its
// source with the code. `hosted-docs --check` fails on any difference or check problem and runs in the required docs CI job; `--write`
// rewrites the blocks. The documents collector counts stale blocks, so drift never reads as Met. Node built-ins only: the docs job runs this
// without installing the compliance package.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Reads a repository file by its path relative to the repository root. */
export interface SourceReader { readText(relativePath: string): Promise<string> }
export interface CheckResult { readonly problems: readonly string[]; readonly warnings: readonly string[] }
export interface Block {
  /** Lower-case id used in the markers. */
  readonly id: string;
  /** The document the block lives in, relative to the repository root. */
  readonly document: string;
  /** The block's text, without the markers and without a trailing newline. */
  render(source: SourceReader): Promise<string>;
  /** Source checks run by --check against the repository root (detectors); problems fail, warnings only print. */
  check?(root: string): CheckResult;
}

export const BLOCKS_DIR = fileURLToPath(new URL('./blocks/', import.meta.url));
/** The repository root this module sits in (compliance/src/hosted/). */
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const BLOCK_ID = /^[a-z][a-z0-9-]{0,47}$/;
const MARKER = /^<!-- generated:([a-z][a-z0-9-]{0,47}) (begin|end) -->$/;

export const beginMarker = (id: string): string => `<!-- generated:${id} begin -->`;
export const endMarker = (id: string): string => `<!-- generated:${id} end -->`;

/** A SourceReader over the files of a repository root. */
export const fileSource = (root: string): SourceReader => ({ readText: async (relativePath) => readFileSync(path.join(root, relativePath), 'utf8') });

/** Every block exported by a module in `dir`, in file name order; refuses a malformed or repeated id. */
export async function loadBlocks(dir: string = BLOCKS_DIR): Promise<Block[]> {
  const files = readdirSync(dir).filter((name) => name.endsWith('.ts')).sort();
  const blocks: Block[] = [];
  for (const file of files) {
    const module = await import(pathToFileURL(path.join(dir, file)).href) as { blocks?: readonly Block[] };
    if (!Array.isArray(module.blocks)) throw new Error(`hosted block module ${file} does not export blocks`);
    for (const block of module.blocks) {
      if (!BLOCK_ID.test(block.id)) throw new Error(`hosted block module ${file}: block id ${JSON.stringify(block.id)} is not lower-case words joined by hyphens`);
      if (blocks.some((other) => other.id === block.id)) throw new Error(`hosted block id ${block.id} is used twice`);
      blocks.push(block);
    }
  }
  return blocks;
}

/** The generated blocks of a document by id, each the text between its markers. Throws on an unpaired, nested or repeated marker. */
export function findBlocks(text: string): Map<string, string> {
  const found = new Map<string, string>();
  const lines = text.split('\n');
  let open: { id: string; from: number } | undefined;
  lines.forEach((line, index) => {
    const match = MARKER.exec(line.trimEnd());
    if (!match) return;
    const [, id, edge] = match;
    if (edge === 'begin') {
      if (open) throw new Error(`generated block ${id} begins inside block ${open.id}`);
      if (found.has(id)) throw new Error(`generated block ${id} appears twice`);
      open = { id, from: index + 1 };
    } else {
      if (!open || open.id !== id) throw new Error(`generated block ${id} ends without its begin marker`);
      found.set(id, lines.slice(open.from, index).join('\n'));
      open = undefined;
    }
  });
  if (open) throw new Error(`generated block ${open.id} has no end marker`);
  return found;
}

/** The document with block `id`'s text replaced; the markers must already be there. */
export function replaceBlock(text: string, id: string, content: string): string {
  const begin = beginMarker(id);
  const end = endMarker(id);
  const from = text.indexOf(`${begin}\n`);
  const to = text.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`the document has no ${begin} ... ${end} markers`);
  return `${text.slice(0, from + begin.length + 1)}${content}\n${text.slice(to)}`;
}

/**
 * The ids of the generated blocks in a document's text that differ from what their source produces, including a marker no block of this
 * document owns and a block whose markers are missing. A source that cannot be read counts as stale.
 */
export async function staleBlocks(text: string, documentPath: string, blocks: readonly Block[], source: SourceReader): Promise<string[]> {
  let present: Map<string, string>;
  try { present = findBlocks(text); } catch { return ['(markers)']; }
  const owned = blocks.filter((block) => block.document === documentPath);
  const stale: string[] = [...present.keys()].filter((id) => !owned.some((block) => block.id === id));
  for (const block of owned) {
    const current = present.get(block.id);
    let expected: string | undefined;
    try { expected = await block.render(source); } catch { expected = undefined; }
    if (current === undefined || expected === undefined || current !== expected) stale.push(block.id);
  }
  return stale;
}

export interface CheckReport { readonly stale: readonly string[]; readonly problems: readonly string[]; readonly warnings: readonly string[] }

/** Compares every block with its document and runs every block's source checks. */
export async function checkAll(root: string, blocks: readonly Block[]): Promise<CheckReport> {
  const stale: string[] = [];
  const problems: string[] = [];
  const warnings: string[] = [];
  const source = fileSource(root);
  for (const document of [...new Set(blocks.map((block) => block.document))]) {
    const file = path.join(root, document);
    if (!existsSync(file)) { problems.push(`${document} does not exist; create it with the markers of its generated blocks`); continue; }
    const text = readFileSync(file, 'utf8');
    let present: Map<string, string>;
    try { present = findBlocks(text); } catch (error) { problems.push(`${document}: ${error instanceof Error ? error.message : String(error)}`); continue; }
    for (const block of blocks.filter((entry) => entry.document === document)) {
      if (!present.has(block.id)) problems.push(`${document} has no ${beginMarker(block.id)} ... ${endMarker(block.id)} markers; add them and run node compliance/src/cli.ts hosted-docs --write`);
    }
    for (const id of await staleBlocks(text, document, blocks, source)) {
      if (present.has(id)) stale.push(`${document}: block ${id} is out of date with its source; run node compliance/src/cli.ts hosted-docs --write and commit the document`);
    }
  }
  for (const block of blocks) {
    if (!block.check) continue;
    const result = block.check(root);
    problems.push(...result.problems.map((problem) => `${block.id}: ${problem}`));
    warnings.push(...result.warnings.map((warning) => `${block.id}: ${warning}`));
  }
  return { stale, problems, warnings };
}

/** Rewrites every block whose document holds its markers; returns the documents changed. */
export async function writeAll(root: string, blocks: readonly Block[]): Promise<string[]> {
  const changed: string[] = [];
  const source = fileSource(root);
  for (const document of [...new Set(blocks.map((block) => block.document))]) {
    const file = path.join(root, document);
    if (!existsSync(file)) continue;
    const before = readFileSync(file, 'utf8');
    let text = before;
    const present = findBlocks(text);
    for (const block of blocks.filter((entry) => entry.document === document && present.has(entry.id))) text = replaceBlock(text, block.id, await block.render(source));
    if (text !== before) { writeFileSync(file, text); changed.push(document); }
  }
  return changed;
}
