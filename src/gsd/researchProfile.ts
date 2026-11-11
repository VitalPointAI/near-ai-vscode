import { execFile } from 'node:child_process';
import { readFile, realpath, writeFile, mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { writeVerifierScaffold } from './verifierScaffold';

// PERF-06: a lighter Open-GSD profile for research and writing projects. Measured on two research projects, runs spent days on small phases, a
// plan-checker pass for every plan (most of which only changed prose), and model-read verification of the whole report. The profile asks for bigger
// phases, quick mode for content edits, the plan-checker only for plans that change a gate or verifier, and deterministic verifier scripts.
//
// It lives beside the project-type guidance rather than inside it: its own AGENTS.md block between its own markers, so the role definitions in
// src/agent/projectTypes.ts are never edited.

const START = '<!-- near-ai:research-profile:start -->';
const END = '<!-- near-ai:research-profile:end -->';

/** The project types the research profile applies to. */
export function usesResearchProfile(typeId: string | undefined): boolean {
  return typeId === 'research' || typeId === 'writing';
}

export const RESEARCH_PROFILE_GUIDANCE = `## Open-GSD research profile

This project uses NEAR AI's research profile for Open-GSD, so runs finish in hours rather than days:
- **Bigger phases.** Plan coarse phases (granularity: coarse): one phase per deliverable section or research question, not one per sub-topic.
- **Quick mode for content edits.** Wording, structure, citations, figures and style fixes go through /gsd-quick, not a new phase.
- **The plan-checker only for gates.** A plan whose files_modified list touches no gate or verifier (scripts/verify/, scripts/gates/, tests, CI) is not sent to the plan-checker; one that does is checked as usual.
- **Cheap verification first.** Run \`node scripts/verify/verify-all.mjs\` (citation resolution, figure recompute, internal-path leak check) before any model-based verification, and fix what it finds. List computed figures in report/figures.json so they are recomputed.
- **One sub-agent per plan, task or workstream**, each with a fresh context, returning a short summary rather than its transcript.`;

/** AGENTS.md with the research-profile block between its markers; the rest of the file is left as it was. */
export function withResearchProfile(existing: string): string {
  const block = `${START}\n${RESEARCH_PROFILE_GUIDANCE}\n${END}`;
  const start = existing.indexOf(START);
  const end = existing.indexOf(END);
  if (start >= 0 && end > start) return `${existing.slice(0, start)}${block}${existing.slice(end + END.length)}`;
  return existing.trim() ? `${existing.replace(/\s*$/, '')}\n\n${block}\n` : `# Agent instructions\n\n${block}\n`;
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  try {
    const value = JSON.parse(await readFile(file, 'utf8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/**
 * Applies the research profile to a project: the AGENTS.md block, `granularity: coarse` in .planning/config.json when the project has not chosen one,
 * `gsdProfile: research` in .planning/.near-ai/project.json, and the verifier scripts (never overwriting one). Returns what it changed.
 */
export async function applyResearchProfile(root: string): Promise<{ agentsFile: string; granularitySet: boolean; scaffolded: string[] }> {
  const agentsFile = path.join(root, 'AGENTS.md');
  await writeFile(agentsFile, withResearchProfile(await readFile(agentsFile, 'utf8').catch(() => '')), 'utf8');
  const configFile = path.join(root, '.planning', 'config.json');
  const config = await readJson(configFile);
  let granularitySet = false;
  if (config.granularity === undefined) {
    await mkdir(path.dirname(configFile), { recursive: true });
    await writeFile(configFile, `${JSON.stringify({ ...config, granularity: 'coarse' }, null, 2)}\n`, 'utf8');
    granularitySet = true;
  }
  const projectFile = path.join(root, '.planning', '.near-ai', 'project.json');
  await mkdir(path.dirname(projectFile), { recursive: true });
  await writeFile(projectFile, `${JSON.stringify({ ...(await readJson(projectFile)), gsdProfile: 'research' }, null, 2)}\n`, 'utf8');
  return { agentsFile, granularitySet, scaffolded: await writeVerifierScaffold(root) };
}

/** Whether the project runs the research profile (project.json says so, or its type is research or writing). */
export async function researchProfileActive(root: string): Promise<boolean> {
  const project = await readJson(path.join(root, '.planning', '.near-ai', 'project.json'));
  return project.gsdProfile === 'research' || (project.gsdProfile === undefined && usesResearchProfile(typeof project.type === 'string' ? project.type : undefined));
}

/** A path that is a gate or verifier: verification scripts, gate scripts, tests, CI workflows, and the GSD verification documents' own checkers. */
const GATE_PATH = /(?:^|\/)(?:scripts\/(?:verify|gates?|checks?)\/|\.github\/workflows\/|tests?\/|__tests__\/)|(?:^|[\/._-])(?:verify|verifier|gate|gates|check|checker|lint|test|tests|spec)(?:[\/._-]|$)/i;

/**
 * A file a content-only plan may change: a document, data or image file, and never a gate (review of PR 34: deciding "content" by ruling out known gate
 * paths let a plan that rewrites any source file, such as the approval code, count as content). Anything that is not plainly content is not.
 */
const CONTENT_FILE = /\.(?:md|markdown|txt|csv|tsv|bib|ris|png|jpe?g|gif|webp|pdf|docx|xlsx|pptx|odt)$/i;
export const isContentFile = (file: string): boolean => { const normalized = file.replace(/\\/g, '/'); return CONTENT_FILE.test(normalized) && !GATE_PATH.test(normalized); };

/** The files_modified list of a PLAN.md, or undefined when it has none (then the plan is checked as usual). */
export function filesModified(plan: string): string[] | undefined {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(plan)?.[1];
  if (!frontmatter) return undefined;
  const block = /^files_modified:\s*(?:\[(.*)\]\s*$|\r?\n((?:[ \t]+-[^\n]*\r?\n?)+))/m.exec(frontmatter);
  if (!block) return undefined;
  const items = block[1] !== undefined ? block[1].split(',') : block[2].split(/\r?\n/).map((line) => line.replace(/^\s*-\s*/, ''));
  return items.map((item) => item.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

/** PLAN.md paths a plan-checker prompt names (as written; relative ones are resolved against the project root). */
export function plansNamedIn(prompt: string): string[] {
  return [...new Set([...prompt.matchAll(/((?:[A-Za-z0-9_.\/-]*\/)?[A-Za-z0-9_.-]*-PLAN\.md)\b/g)].map((match) => match[1]))].slice(0, 30);
}

/** A plan's text without its frontmatter (whose files_modified list is judged separately). */
const frontmatterless = (text: string): string => text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');

/**
 * How a skipped plan check reports (PERF-06, after the PR 34 reviews). Open-GSD's plan-phase workflow accepts exactly two checker outcomes,
 * `## VERIFICATION PASSED` and `## ISSUES FOUND`; any other reply falls to its step 11a, which asks the person "Accept / Retry / Stop" and so stalls
 * the unattended runs this profile exists to speed up. Open-GSD's own way to skip the checker (`--skip-verify`, or workflow.plan_check: false) is
 * decided once, before any plan exists, so it cannot skip one content-only plan and still check the next. The reply therefore carries the marker the
 * workflow needs to continue, and the very next line says plainly that no check was run, with the evidence. It never contains a BLOCKER or WARNING
 * entry (the workflow would read one as an issue). SECURITY.md and README say what the marker means here.
 */
export const PLAN_CHECK_MARKER = '## VERIFICATION PASSED';
export const PLAN_CHECK_SKIPPED = 'PLAN CHECK SKIPPED (content-only plan): the plan checker was NOT run, so these plans were not verified.';
/** Severity words Open-GSD reads as issue entries, kept out of a skip reply (a file name that contains one is not listed by name). */
const SEVERITY_WORD = /blocker|warning/i;

/** Files changed in the project's working tree and not yet committed (tracked and untracked), or undefined when git cannot say. */
export async function workingTreeChanges(root: string): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    execFile('git', ['status', '--porcelain', '--untracked-files=all', '-z'], { cwd: root, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) { resolve(undefined); return; }
      const entries = stdout.split('\0').filter(Boolean);
      const files: string[] = [];
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        files.push(entry.slice(3));
        // A rename lists its old path as the next entry.
        if (/^R|^C/.test(entry)) { const old = entries[index + 1]; if (old) files.push(old); index += 1; }
      }
      resolve(files);
    });
  });
}

/**
 * The report a skipped plan-checker returns, or undefined when it must run (review of PR 34: the plan's own files_modified list, written by the same
 * agent, is not evidence on its own). The check is skipped only when ALL of these hold, and the report lists the evidence:
 *   - the prompt names at least one plan, each readable inside the project, each with a files_modified list of content files only (isContentFile);
 *   - the plan's whole text names no gate or verifier path (an undeclared edit described in a task is caught here);
 *   - the actual changes so far, the files this run wrote and every uncommitted change git reports, are all content files.
 * When git cannot report the working tree (not a repository, git missing), the evidence is unavailable and the checker runs.
 */
export async function planCheckSkip(prompt: string, root: string, writtenByRun: string[] = []): Promise<string | undefined> {
  const named = plansNamedIn(prompt);
  if (!named.length) return undefined;
  const realRoot = await realpath(root).catch(() => path.resolve(root));
  const declared: string[] = [];
  for (const plan of named) {
    let text: string;
    try {
      const file = await realpath(path.resolve(root, plan));
      if (file !== realRoot && !file.startsWith(`${realRoot}${path.sep}`)) return undefined;
      text = await readFile(file, 'utf8');
    } catch {
      return undefined;
    }
    const files = filesModified(text);
    if (!files?.length) return undefined;
    if (!files.every(isContentFile)) return undefined;
    // Every path the plan's text mentions, not only the declared list.
    // A command that only RUNS a verifier (`node scripts/verify/verify-all.mjs`, `npm test`) is not an edit, so run commands are left out first.
    const prose = frontmatterless(text).replace(/\b(?:node|bash|sh|python3?|npx|npm\s+run|npm)\s+\S+/g, ' ');
    const mentioned = [...prose.matchAll(/(?:^|[\s`'"(\[])((?:\.?[\w-]+\/)*[\w.-]+\.[A-Za-z0-9]{1,6})\b/gm)].map((match) => match[1]);
    if (mentioned.some((file) => GATE_PATH.test(file)) || /\bscripts\/(?:verify|gates?|checks?)\b/.test(prose)) return undefined;
    declared.push(...files);
  }
  const uncommitted = await workingTreeChanges(root);
  if (uncommitted === undefined) return undefined;
  const written = writtenByRun.map((file) => path.relative(realRoot, path.resolve(file)).split(path.sep).join('/')).filter((file) => file && !file.startsWith('..'));
  const changed = [...new Set([...uncommitted, ...written])];
  if (!changed.every(isContentFile)) return undefined;
  const list = (items: string[]) => {
    const named = items.map((item) => (SEVERITY_WORD.test(item) ? '(one file, name not shown)' : item));
    return named.length ? `${named.slice(0, 8).join(', ')}${named.length > 8 ? `, and ${named.length - 8} more` : ''}` : 'none';
  };
  return `${PLAN_CHECK_MARKER}
${PLAN_CHECK_SKIPPED}

The marker above only lets Open-GSD's workflow carry on without stopping to ask; it is not a verification. NEAR AI's research profile (PERF-06) skips the plan checker only for plans that change content, not gates or verifiers. Continue the workflow, and run \`node scripts/verify/verify-all.mjs\` after executing.

Evidence for the skip:
- Plans: ${list(named)}.
- Files the plans declare (files_modified): ${list([...new Set(declared)])}; every one is a document, data or image file, and none is a gate, verifier, test or CI file.
- The plans' text names no gate or verifier path.
- Files this run has written so far: ${list(written)}.
- Uncommitted changes git reports: ${list(uncommitted)}.
- None of those changed files is a gate, verifier, test or CI file.

To check every plan, set nearAi.gsd.researchProfile to false.`;
}
