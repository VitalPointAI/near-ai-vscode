#!/usr/bin/env node
// Smoke check for the staff teams, following the J2 demo script: set up a J2 intelligence team in a fresh temporary project, load the
// Exercise IRON LANTERN starter scenario, and check every file a person would then open. Runs on the compiled extension, with no VS Code, no network
// and no model:
//
//   npm run compile && node scripts/staff-smoke.mjs [--keep]
//
// Exits 1 on the first failed check. --keep leaves the temporary project in place and prints where it is.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const require = createRequire(import.meta.url);
const load = (file) => require(path.join(DIST, file));

const { planStaffSetup, applyStaffSetup } = load('services/staffSetup.js');
const { loadScenarioIntoProject, STARTER_SCENARIO_FILE } = load('services/staffScenarioLoader.js');
const { TeamLibrary, parseTeam } = load('agent/teams.js');
const { defaultStaffSettings } = load('domain/staff/profiles.js');
const { DEMO_SCRIPTS, demoScriptPath } = load('domain/staff/demoScripts.js');
const { ACCEPTANCE_PRODUCTS } = load('domain/staff/acceptance.js');
const { J2_PRODUCTS } = load('agent/staff/j2Products.js');
const { staffGuidanceIn } = load('agent/staff/guidance.js');

const keep = process.argv.includes('--keep');
const project = mkdtempSync(path.join(tmpdir(), 'near-ai-staff-smoke-'));
const storage = mkdtempSync(path.join(tmpdir(), 'near-ai-staff-smoke-teams-'));
let checks = 0;

function check(condition, what) {
  checks += 1;
  if (!condition) {
    console.error(`FAIL ${what}`);
    console.error(`Project left at ${project}`);
    process.exit(1);
  }
  console.log(`ok   ${what}`);
}
const read = (relative) => readFileSync(path.join(project, relative), 'utf8');
const has = (relative) => existsSync(path.join(project, relative));

// 1. Set up the J2 team, as NEAR AI: Set Up a Staff Team does after the person checks the roster.
const settings = { ...defaultStaffSettings(), profile: 'us-joint', level: 'operational', planningType: 'contingency' };
const plan = planStaffSetup({ templateId: 'j2-intelligence', options: { settings, locality: 'cloud' } });
check(plan.roster.members.length === 12, `the operational J2 roster has 12 members (${plan.roster.members.length})`);
check(Boolean(plan.roster.humanLead), `a named person decides: ${plan.roster.humanLead}`);
const library = new TeamLibrary(storage);
const result = await applyStaffSetup(project, library, plan);

// 2. Load the starter scenario, as the setup offers.
const loaded = await loadScenarioIntoProject(project, readFileSync(STARTER_SCENARIO_FILE, 'utf8'));
check(loaded.ok, `the starter scenario loads${loaded.ok ? '' : `: ${loaded.message}`}`);

// 3. The files a person opens next.
const team = parseTeam(readFileSync(result.teamFile, 'utf8'), result.teamFile);
check(team.staff?.section === 'j2' && team.staff?.profile === 'us-joint' && team.staff?.level === 'operational', 'the team file carries its staff block');
check(team.private === true, 'the team is private');
check(team.members.every((member) => !member.tools.some((tool) => /approve|reject|release|supersede/i.test(tool))), 'no member has a deciding tool');
const member = (name) => team.members.find((entry) => entry.name === name);
check(member('tradecraft-reviewer')?.tools.includes('mcp__staff-products__lint'), 'the tradecraft gate runs the one tradecraft lint');
check(member('release-guard')?.tools.includes('mcp__guard-scan__*') && member('release-guard')?.tools.includes('mcp__staff-products__verdict'), 'the release guard scans and records verdicts');
check(team.members.some((entry) => entry.tools.includes('mcp__intel-workbench__*')), 'J2 members are granted the intel workbench');
for (const file of ['.planning/staff/PROFILE.md', '.planning/staff/skills/icd203-standards.md', '.planning/staff/skills/source-grading.md']) check(has(file), `${file} written`);
check(/US Joint/.test(read('.planning/staff/PROFILE.md')), 'PROFILE.md names the profile');
const projectJson = JSON.parse(read('.planning/.near-ai/project.json'));
check(projectJson.staff?.profile === 'us-joint' && projectJson.staff?.level === 'operational', 'the staff settings are in project.json');
const guidance = staffGuidanceIn(read('AGENTS.md'), 'j2-intelligence');
check(Boolean(guidance) && /People decide/.test(guidance), 'AGENTS.md holds the J2 guidance between its own markers');
for (const file of ['README.md', 'mission.md', 'reports.md', 'scenario.json']) check(has(`.planning/staff/scenario/${file}`), `scenario ${file} written`);
check(has(demoScriptPath('j2')) && has(demoScriptPath('j5')), 'the J2 and J5 demo scripts are written');

// 4. The J2 demo script, beat by beat: every product it expects is one the J2 template owns, at the one product path.
const script = read(demoScriptPath('j2'));
for (const beat of DEMO_SCRIPTS.j2.beats) {
  for (const id of beat.products) {
    const fixture = ACCEPTANCE_PRODUCTS.find((entry) => entry.id === id);
    for (const product of fixture.products) {
      const entry = J2_PRODUCTS.find((candidate) => candidate.id === product);
      const owner = entry?.owners.operational;
      check(Boolean(owner) && team.members.some((candidate) => candidate.name === owner), `step ${beat.step} "${beat.title}": ${product} is owned by ${owner}`);
      check(script.includes(`.planning/staff/products/j2/${product}.md`), `the script points at .planning/staff/products/j2/${product}.md`);
    }
  }
}
check(!/products\/j2\/[a-z-]+\.md/.test(script.replace(/\.planning\/staff\/products\/j2\//g, '')), 'no product path outside .planning/staff/');

console.log(`\n${checks} checks passed.`);
if (keep) console.log(`Project: ${project}\nTeams: ${storage}`);
else { rmSync(project, { recursive: true, force: true }); rmSync(storage, { recursive: true, force: true }); }
