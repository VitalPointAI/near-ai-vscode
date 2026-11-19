#!/usr/bin/env node
// Maintains src/agent/teamTemplateHistory.ts: the fingerprints of every released version of each
// built-in project type's team and AGENTS.md guidance, which Update Team uses to tell a member the
// user never changed from one they edited.
//
//   npm run compile && node scripts/template-history.mjs
//       Appends a new version for every project type and staff section template whose definition changed since the last one.
//   node scripts/template-history.mjs --from-git <commit>...
//       Rebuilds the history from those commits (oldest first), then appends the current definitions.
//   node scripts/template-history.mjs --keep-from <commit>
//       Merges the fingerprints that commit's history recorded into the version of the same number here, then appends as usual. Use it when a
//       version was rewritten before it was released (drop 2 rewrote j2-intelligence v1), so a team made from the earlier build still matches.
//
// The unit test "a project type cannot change without a new template version" fails until this is run.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist', 'agent');
const require = createRequire(import.meta.url);
const ts = require('typescript');
const { splitTeam } = require(path.join(DIST, 'teamMarkdown.js'));
const { memberFingerprint, guidanceFingerprint, definitionHash } = require(path.join(DIST, 'teamFingerprints.js'));
const GOAL = 'GOAL';

/** One snapshot of every project type from a projectTypes module (current or historical). */
function snapshot(module) {
  const out = {};
  for (const type of module.PROJECT_TYPES) {
    const members = {};
    for (const locality of ['cloud', 'local']) {
      for (const section of splitTeam(module.projectTypeTeam(type, GOAL, locality)).sections) {
        const fingerprint = memberFingerprint({ ...section, tools: section.tools ?? null });
        members[section.name] = [...new Set([...(members[section.name] ?? []), fingerprint])];
      }
    }
    const agents = module.withProjectGuidance('', type, GOAL);
    const inner = agents.slice(agents.indexOf('-->') + 3, agents.lastIndexOf('<!--')).replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    out[type.id] = { definition: definitionHash({ members: type.members, guidance: type.guidance, policy: module.RED_TEAM_POLICY ?? '' }), guidance: [guidanceFingerprint(inner)], members };
  }
  return out;
}

/** A historical projectTypes.ts, transpiled, with its './teams' import pointed at today's renderer. */
function fromGit(commit) {
  const source = execFileSync('git', ['show', `${commit}:src/agent/projectTypes.ts`], { cwd: ROOT, encoding: 'utf8' });
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    .replace(/require\("\.\/teams"\)/g, `require(${JSON.stringify(path.join(DIST, 'teams.js'))})`)
    .replace(/require\("\.\/(teamFingerprints|teamTemplateHistory)"\)/g, (_, name) => `require(${JSON.stringify(path.join(DIST, `${name}.js`))})`);
  const dir = mkdtempSync(path.join(tmpdir(), 'template-history-'));
  try {
    const file = path.join(dir, `projectTypes-${commit}.cjs`);
    writeFileSync(file, js);
    return snapshot(require(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** One snapshot of every staff section template (src/agent/staff/templates.ts): each rendering's members and guidance, and a hash of everything it renders. */
function staffSnapshot() {
  const { STAFF_TEMPLATES, staffTemplateSnapshot } = require(path.join(DIST, 'staff', 'templates.js'));
  return Object.fromEntries(STAFF_TEMPLATES.map((template) => [template.id, staffTemplateSnapshot(template)]));
}

function append(history, snap) {
  for (const [id, entry] of Object.entries(snap)) {
    const versions = (history[id] ??= []);
    const last = versions[versions.length - 1];
    if (last && last.definition === entry.definition) {
      // Same definition (a commit that changed another type): merge any fingerprint the renderer gives now.
      last.guidance = [...new Set([...last.guidance, ...entry.guidance])];
      for (const [name, prints] of Object.entries(entry.members)) last.members[name] = [...new Set([...(last.members[name] ?? []), ...prints])];
      continue;
    }
    versions.push({ version: (last?.version ?? 0) + 1, ...entry });
  }
}

/** The history file as it was at a commit, transpiled. */
function historyAt(commit) {
  const source = execFileSync('git', ['show', `${commit}:src/agent/teamTemplateHistory.ts`], { cwd: ROOT, encoding: 'utf8' });
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const dir = mkdtempSync(path.join(tmpdir(), 'template-history-'));
  try {
    const file = path.join(dir, `teamTemplateHistory-${commit}.cjs`);
    writeFileSync(file, js);
    return require(file).TEMPLATE_HISTORY;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Adds every fingerprint `older` recorded to the version of the same number in `history`: nothing is removed, and no version is added. */
function keepFingerprints(history, older) {
  for (const [id, versions] of Object.entries(older)) {
    for (const old of versions) {
      const kept = history[id]?.find((version) => version.version === old.version);
      if (!kept) continue;
      kept.guidance = [...new Set([...kept.guidance, ...old.guidance])];
      for (const [name, prints] of Object.entries(old.members)) kept.members[name] = [...new Set([...(kept.members[name] ?? []), ...prints])];
    }
  }
}

const args = process.argv.slice(2);
let history = {};
if (args[0] === '--from-git') { for (const commit of args.slice(1)) append(history, fromGit(commit)); }
else history = structuredClone(require(path.join(DIST, 'teamTemplateHistory.js')).TEMPLATE_HISTORY);
if (args[0] === '--keep-from') { for (const commit of args.slice(1)) keepFingerprints(history, historyAt(commit)); }
append(history, { ...snapshot(require(path.join(DIST, 'projectTypes.js'))), ...staffSnapshot() });

const body = `// Generated by scripts/template-history.mjs; do not edit by hand. Each project type's released team
// and guidance versions, oldest first: the version number, a hash of the definition, and the
// fingerprints of the generated AGENTS.md guidance and of each member (cloud and local variants).

export interface TemplateSnapshot { version: number; definition: string; guidance: string[]; members: Record<string, string[]> }

export const TEMPLATE_HISTORY: Record<string, TemplateSnapshot[]> = ${JSON.stringify(history, null, 2).replace(/"([a-z][a-z0-9]*)":/gi, '$1:').replace(/"/g, "'")};
`;
writeFileSync(path.join(ROOT, 'src', 'agent', 'teamTemplateHistory.ts'), body);
console.log(Object.entries(history).map(([id, versions]) => `${id}: v${versions[versions.length - 1].version}`).join(', '));
