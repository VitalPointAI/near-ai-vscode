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

/**
 * The report a skipped plan-checker returns, or undefined when it must run. It is skipped only when the prompt names at least one plan, every named plan
 * can be read inside the project and lists its files_modified, and none of those files is a gate or verifier. Anything uncertain runs the checker.
 */
export async function planCheckSkip(prompt: string, root: string): Promise<string | undefined> {
  const named = plansNamedIn(prompt);
  if (!named.length) return undefined;
  const realRoot = await realpath(root).catch(() => path.resolve(root));
  const touched: string[] = [];
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
    if (files.some((file) => GATE_PATH.test(file.replace(/\\/g, '/')))) return undefined;
    touched.push(...files);
  }
  return `## VERIFICATION PASSED

Plan check skipped by NEAR AI's research profile (PERF-06): ${named.length === 1 ? 'this plan changes' : `these ${named.length} plans change`} no gate or verifier, only ${touched.length} content file${touched.length === 1 ? '' : 's'} (${[...new Set(touched)].slice(0, 8).join(', ')}${touched.length > 8 ? ', …' : ''}). Plans that change a gate, verifier, test or CI file are checked as usual. Run \`node scripts/verify/verify-all.mjs\` after executing. To check every plan, set nearAi.gsd.researchProfile to false.`;
}
