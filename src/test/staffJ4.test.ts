// The J4 logistics team template (design 10, 3.5; research note 03 part B; WP-J4): every rendering parses and passes the local team check with no
// finding, stays within 12 members with a release guard, has one member per core logistics function plus the JLOC chief, the logistics plans officer and
// the LOGSTAT analyst, gives every product exactly one owner, starts support planning at step 1, files the annexes by profile (joint D, Army F,
// NATO/Canadian R with S), speaks combat service support in Canadian land terms, adds the CJOC weekly reports under the Canadian nation setting, ships
// the logstat-definitions skill, and refuses every number that does not trace to a calculator record.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { grantsMcpTool } from '../mcp/tools';
import { checkTeam, MAX_INSTRUCTION_WORDS } from '../agent/teamCheck';
import { draftFromMarkdown } from '../agent/teamMarkdown';
import { parseTeam, teamAgents } from '../agent/teams';
import { staffGuidanceIn } from '../agent/staff/guidance';
import { J4_ROSTERS } from '../agent/staff/j4Members';
import {
  CALC_RECORDS_HEADING, CALCULATOR_FOLDER, J4_FUNCTION_OWNERS, J4_PRODUCTS, J4_TACTICAL_FOLDS, j4MissingHeadings, j4NumberTrace, j4Product, j4ProductPath,
  j4ProductsOwnedBy, j4VariantProducts
} from '../agent/staff/j4Products';
import { J4_SKILLS, j4SkillPath, logstatDefinitionsSkill } from '../agent/staff/j4Skills';
import { J4_STEPS, J4_TEMPLATE_ID, j4Guidance, j4Renderings, j4Template, j4Workflow, j4WorkflowSteps, renderJ4Team, withJ4Guidance } from '../agent/staff/j4Template';
import { J4_VARIANTS, j4Vocabulary } from '../agent/staff/j4Vocabulary';
import { J4_STAFF_TEMPLATE, STAFF_TEMPLATES, staffTemplate, staffTemplateForSection } from '../agent/staff/templates';
import { bestStaffRendering } from '../agent/staffTeamUpdate';
import { splitTeam } from '../agent/teamMarkdown';
import {
  CORE_LOGISTICS_FUNCTIONS, CROSSWALK_STEPS, DOCTRINE_PROFILES, LOGISTICS_TERMS, RETIRED_SPACE_TERMS, STAFF_PROFILE_IDS, SUPPLY_CLASSES
} from '../domain/staff/doctrine';
import { writerIn } from '../domain/staff/ownership';
import { staffPreambleText, STAFF_MARKERS } from '../domain/staff/products';
import { defaultStaffSettings, renderProfileMarkdown, resolveProfile } from '../domain/staff/profiles';
import type { StaffSettings } from '../domain/staff/profiles';
import { HUMAN_ONLY_EVENTS } from '../domain/staff/release';
import { RELEASE_GUARD_TOOLS } from '../domain/staff/releaseGuard';
import { staffGuardFolder } from '../domain/staff/writeLimits';
import { levelChoices, nationChoices, planStaffSetup, profileChoices, templateQuestions } from '../services/staffSetup';
import { CALCULATOR_DIR } from '../staff/staffHost';
import { callLogistics, callTool, hashIn, J4_TEAM, staffWorld, writeBody, writeFactors } from './helpers/staffFixtures';

const settings = (patch: Partial<StaffSettings> = {}): StaffSettings => ({ ...defaultStaffSettings(), ...patch });
const US_JOINT = settings();
const US_JOINT_STRATEGIC = settings({ level: 'strategic' });
const US_ARMY = settings({ profile: 'us-army', level: 'tactical' });
const CA_OPERATIONAL = settings({ profile: 'nato-ca', level: 'operational', nation: 'ca' });
const CA_STRATEGIC = settings({ profile: 'nato-ca', level: 'strategic', nation: 'ca' });
const CA_TACTICAL = settings({ profile: 'nato-ca', level: 'tactical', nation: 'ca' });
const NATO_OPERATIONAL = settings({ profile: 'nato-ca', level: 'operational', nation: 'nato' });
const NATO_TACTICAL = settings({ profile: 'nato-ca', level: 'tactical', nation: 'nato' });
const RENDERINGS = j4Renderings();
const team = (text: string) => parseTeam(text, '/p/.planning/staff/teams/j4-logistics.md');
const memberOf = (s: StaffSettings, name: string) => team(renderJ4Team(s)).members.find((entry) => entry.name === name)!;
const STAFF_SRC = path.resolve(__dirname, '..', '..', 'src', 'agent', 'staff');

test('every rendering parses, stays within 12 members with the release guard, is private, and passes the team check with no finding at all', () => {
  assert.ok(RENDERINGS.length >= 27, 'every profile, offered level, nation and planning type');
  for (const rendering of J4_STAFF_TEMPLATE.renderings()) {
    const parsed = team(rendering.team);
    assert.ok(parsed.members.length <= 12, `${rendering.key}: ${parsed.members.length} members`);
    assert.ok(parsed.members.some((member) => member.name === 'release-guard'), `${rendering.key}: the guard is never dropped`);
    assert.equal(parsed.private, true);
    assert.ok(parsed.members.every((member) => member.privacy === 'private'), `${rendering.key}: every member private`);
    assert.equal(parsed.staff?.section, 'j4');
    assert.deepEqual(parsed.staff?.layers, ['cop-logistics-layer']);
    const findings = checkTeam(draftFromMarkdown(rendering.team, 'team.md'));
    assert.deepEqual(findings.map((finding) => `${finding.id}: ${finding.message}`), [], rendering.key);
  }
});

test('the roster: 12 at strategic and operational level, 9 at tactical; one member per core logistics function, plus the JLOC chief, plans officer, LOGSTAT analyst and guard', () => {
  assert.deepEqual(J4_VARIANTS.map((variant) => J4_ROSTERS[variant].length), [12, 12, 9]);
  for (const s of [US_JOINT, US_JOINT_STRATEGIC, CA_OPERATIONAL, CA_STRATEGIC]) {
    const names = team(renderJ4Team(s)).members.map((member) => member.name);
    assert.deepEqual(names, ['j4-director', 'log-plans-officer', 'jloc-chief', 'supply-planner', 'maintenance-planner', 'mobility-planner', 'engineer-planner', 'ocs-planner', 'health-services-planner', 'services-mortuary-planner', 'logstat-analyst', 'release-guard']);
    assert.deepEqual(J4_FUNCTION_OWNERS.map((entry) => entry.function), [...CORE_LOGISTICS_FUNCTIONS], 'the seven functions in doctrine order');
    for (const { member } of J4_FUNCTION_OWNERS) assert.ok(names.includes(member), `${member} covers its function`);
    assert.equal(new Set(J4_FUNCTION_OWNERS.map((entry) => entry.member)).size, 7, 'one member each');
  }
  for (const s of [US_ARMY, CA_TACTICAL, NATO_TACTICAL]) {
    const names = team(renderJ4Team(s)).members.map((member) => member.name);
    assert.deepEqual(names, ['s4-lead', 'jloc-chief', 'supply-planner', 'maintenance-planner', 'mobility-planner', 'ocs-planner', 'health-services-planner', 'logstat-analyst', 'release-guard']);
    // Engineering folds into mobility and services into supply; the plans officer's work into the integrator. Every function still has an owner.
    for (const { member } of J4_FUNCTION_OWNERS) assert.ok(names.includes(J4_TACTICAL_FOLDS[member] ?? member), `${member} or its fold is on the tactical roster`);
    const v = j4Vocabulary(s);
    assert.equal(j4ProductsOwnedBy('mobility-planner', v).some((product) => product.id === 'sustainment-engineering-concept'), true);
    assert.equal(j4ProductsOwnedBy('supply-planner', v).some((product) => product.id === 'mortuary-affairs-concept'), true);
    assert.equal(j4ProductsOwnedBy('s4-lead', v).some((product) => product.id === 'logistics-estimate'), true);
  }
});

test('every product has exactly one owner on the roster, the staff block lists it, and the owner\'s instructions carry its place and headings', () => {
  for (const { key, settings: s } of RENDERINGS) {
    const v = j4Vocabulary(s);
    const parsed = team(renderJ4Team(s));
    const names = parsed.members.map((member) => member.name);
    const products = j4VariantProducts(v);
    assert.ok(products.length <= 50);
    for (const product of products) {
      const owner = product.owners[v.variant]!;
      assert.ok(names.includes(owner), `${key}: ${product.id} is owned by ${owner}, on the roster`);
      const holders = parsed.members.filter((member) => member.instructions.includes(`- ${product.title(v)}, ${j4ProductPath(product)}.`));
      assert.deepEqual(holders.map((member) => member.name), [owner], `${key}: ${product.id} is in its owner's Owns list only`);
      for (const heading of product.headings(v)) assert.ok(parsed.members.find((member) => member.name === owner)!.instructions.includes(heading), `${key}: ${product.id} heading ${heading}`);
    }
    const listed = [...(parsed.staff?.products ?? []), ...(parsed.staff?.layers ?? [])].sort();
    assert.deepEqual(listed, products.map((product) => product.id).sort(), `${key}: the staff block lists every product`);
    // The shared product the J4 writes (the COP logistics layer) goes to the writer the staff contract names.
    for (const phase of ['planning', 'execution'] as const) {
      assert.equal(writerIn('cop-logistics-layer', { phase, mode: 'standalone' }, { section: 'j4', members: names })?.member, 'jloc-chief');
    }
  }
});

test('support planning starts at step 1, alongside force planning: the staff block, the workflow, the integrator and the guidance all say so', () => {
  for (const { key, settings: s } of RENDERINGS) {
    const v = j4Vocabulary(s);
    assert.equal(J4_STEPS[1], 'supporting');
    assert.deepEqual(j4WorkflowSteps(s), [...CROSSWALK_STEPS], `${key}: all eight steps`);
    const workflow = j4Workflow(v);
    const first = workflow.find((row) => row.step === 1)!;
    assert.ok(first.lanes.some((lane) => lane.startsWith(v.tactical ? 's4-lead:' : 'log-plans-officer:')), `${key}: the overview starts in step 1`);
    assert.ok(first.lanes.length >= 3, `${key}: parallel lanes in step 1`);
    assert.equal(workflow.find((row) => row.step === 6)!.human, true);
    const step2 = workflow.find((row) => row.step === 2)!;
    assert.equal(step2.lanes.length, v.tactical ? 5 : 7, `${key}: every functional planner assesses its function at once`);
    const chief = team(renderJ4Team(s)).members[0];
    assert.match(chief.instructions, new RegExp(`start the section at step 1 \\(${v.step(1).replace(/[()']/g, '.')}\\), the same turn the ${v.planningLead} starts force planning`));
    assert.match(j4Guidance(s), /\*\*Support planning starts at step 1\.\*\*/);
  }
  assert.match(memberOf(US_JOINT, 'log-plans-officer').instructions, /In step 1 \(Planning initiation\) build the theater logistics overview/);
  assert.match(memberOf(US_JOINT, 'j4-director').instructions, /the same turn the J-5 starts force planning/);
  assert.match(memberOf(settings({ planningType: 'crisis' }), 'j4-director').instructions, /the same turn the J-3 starts force planning/, 'in a crisis the J3 leads planning');
});

test('the annex letters follow the profile: joint D, Army F (Sustainment), NATO/Canadian R with movements in S; health services and contracting too', () => {
  const annexOf = (s: StaffSettings) => j4Vocabulary(s).annex;
  assert.equal(annexOf(US_JOINT), 'Annex D (Logistics)');
  assert.equal(annexOf(US_ARMY), 'Annex F (Sustainment)');
  assert.equal(annexOf(CA_OPERATIONAL), 'Annex R (Logistics)');
  assert.equal(annexOf(NATO_TACTICAL), 'Annex R (Logistics)');
  assert.equal(j4Vocabulary(CA_OPERATIONAL).movementsAnnex, 'Annex S (Movements)');
  assert.equal(j4Vocabulary(US_JOINT).movementsAnnex, undefined);
  assert.equal(j4Vocabulary(US_ARMY).movementsAnnex, undefined);
  const director = memberOf(US_JOINT, 'j4-director').instructions;
  assert.match(director, /The logistics annex is Annex D \(Logistics\)\. Health services are Annex Q \(Health Services\); contracting is Annex W \(Operational Contract Support\)/);
  assert.match(memberOf(US_ARMY, 's4-lead').instructions, /The logistics annex is Annex F \(Sustainment\)\. Health services are Part of Annex F/);
  assert.match(memberOf(CA_OPERATIONAL, 'j4-director').instructions, /Annex R \(Logistics\); movements are Annex S \(Movements\), which the mobility-planner drafts\. Health services are Annex K \(Health Service Support\); contracting is Annex FF \(Financial Support\)/);
  assert.equal(j4VariantProducts(j4Vocabulary(CA_OPERATIONAL)).find((product) => product.id === 'movements-annex')?.owners.operational, 'mobility-planner');
  assert.ok(!j4VariantProducts(j4Vocabulary(US_JOINT)).some((product) => product.id === 'movements-annex'));
  assert.match(memberOf(CA_OPERATIONAL, 'mobility-planner').instructions, /movements have their own annex, Annex S \(Movements\): you draft it/);
  for (const { settings: s } of RENDERINGS) {
    const v = j4Vocabulary(s);
    assert.equal(j4Product('logistics-annex')!.title(v), v.annex);
    assert.ok(renderJ4Team(s).includes(v.annex), 'the annex reaches the team');
    // The joint D trap: under the Army D is fires, under NATO/Canadian D is intelligence. Neither template says "Annex D (Logistics)".
    if (s.profile !== 'us-joint') assert.ok(!renderJ4Team(s).includes('Annex D (Logistics)'), `${s.profile}: never the joint letter`);
  }
});

test('Canadian land terms: combat service support at tactical level with the Canadian nation setting; logistics everywhere else; sustainment under the Army', () => {
  const ca = j4Vocabulary(CA_TACTICAL);
  assert.equal(ca.function, 'Combat service support (CSS)');
  assert.equal(ca.code, 'G4');
  assert.match(renderJ4Team(CA_TACTICAL), /^name: G4 Combat service support \(CSS\) \(tactical\)$/m);
  assert.match(memberOf(CA_TACTICAL, 's4-lead').instructions, /You lead the G4 section's combat service support \(CSS\) work/);
  assert.match(j4Guidance(CA_TACTICAL), /^## Staff section: G4 combat service support \(CSS\) \(tactical\)$/m);
  assert.equal(j4Vocabulary(NATO_TACTICAL).function, 'Logistics');
  assert.equal(j4Vocabulary(NATO_TACTICAL).code, 'S4');
  assert.equal(j4Vocabulary(CA_OPERATIONAL).function, 'Logistics');
  assert.equal(j4Vocabulary(US_ARMY).function, 'Sustainment');
  assert.equal(j4Vocabulary(US_ARMY).code, 'S-4');
  assert.equal(j4Vocabulary(US_JOINT).code, 'J-4');
  assert.match(memberOf(US_ARMY, 's4-lead').instructions, /The Army frames sustainment as logistics, financial management, personnel services and health service support/);
  // Lines of support by level, under the Canadian nation setting only.
  assert.deepEqual(j4Vocabulary(CA_TACTICAL).linesOfSupport.map((line) => line.line), ['First line', 'Second line']);
  assert.deepEqual(j4Vocabulary(CA_OPERATIONAL).linesOfSupport.map((line) => line.line), ['Third line']);
  assert.deepEqual(j4Vocabulary(CA_STRATEGIC).linesOfSupport.map((line) => line.line), ['Fourth line']);
  assert.deepEqual(j4Vocabulary(NATO_OPERATIONAL).linesOfSupport, []);
  assert.ok(j4Product('concept-of-support')!.headings(j4Vocabulary(CA_OPERATIONAL)).includes('Lines of support'));
  assert.ok(!j4Product('concept-of-support')!.headings(j4Vocabulary(US_JOINT)).includes('Lines of support'));
});

test('the Canadian weekly report variant: CJOC weekly logistics and ammunition reports alongside the LOGSTAT, owned by the JLOC chief', () => {
  for (const s of [CA_OPERATIONAL, CA_STRATEGIC]) {
    const v = j4Vocabulary(s);
    const ids = j4VariantProducts(v).map((product) => product.id);
    assert.ok(ids.includes('logstat') && ids.includes('weekly-logistics-report') && ids.includes('ammunition-report'), s.level);
    assert.deepEqual(j4ProductsOwnedBy('jloc-chief', v).map((product) => product.id).slice(0, 3), ['logstat', 'weekly-logistics-report', 'ammunition-report']);
    const jloc = memberOf(s, 'jloc-chief').instructions;
    assert.match(jloc, /you also write the weekly logistics report and the ammunition status report and ammunition expenditure report for the CJOC J4 desk, alongside the LOGSTAT/);
    assert.match(j4Guidance(s), /weekly logistics report and ammunition reports to the CJOC J4 desk/);
    assert.match(logstatDefinitionsSkill(v), /the CJOC J4 desk the weekly logistics report/);
  }
  assert.match(memberOf(CA_STRATEGIC, 'jloc-chief').instructions, /At strategic level you consolidate those reports from every deployed operation/);
  for (const s of [US_JOINT, US_JOINT_STRATEGIC, US_ARMY, NATO_OPERATIONAL, CA_TACTICAL, NATO_TACTICAL]) {
    const v = j4Vocabulary(s);
    const ids = j4VariantProducts(v).map((product) => product.id);
    assert.ok(ids.includes('logstat'), `${s.profile}/${s.level}: the LOGSTAT is always there`);
    assert.ok(!ids.includes('weekly-logistics-report') && !ids.includes('ammunition-report'), `${s.profile}/${s.level}/${s.nation}: no CJOC report`);
    assert.doesNotMatch(renderJ4Team(s), /CJOC/);
  }
});

test('the level variants: the strategic estimate and global distribution at strategic level, the JTF J4 JLOC at operational, hours and 72-hour forecasts at tactical', () => {
  assert.equal(j4Vocabulary(US_JOINT_STRATEGIC).estimate, LOGISTICS_TERMS['us-joint'].strategicEstimate);
  assert.equal(j4Product('logistics-estimate')!.title(j4Vocabulary(US_JOINT_STRATEGIC)), 'Joint logistics estimate');
  assert.match(memberOf(US_JOINT_STRATEGIC, 'j4-director').instructions, /global distribution, the industrial base, long-lead items/);
  assert.match(memberOf(US_JOINT_STRATEGIC, 'jloc-chief').instructions, /the CCMD J4 joint logistics operations center \(CCMD J4 JLOC\)\. Always name it that way, never as a bare "JLOC"/);
  assert.match(memberOf(US_JOINT, 'jloc-chief').instructions, /the JTF J4 joint logistics operations center \(JTF J4 JLOC\)/);
  assert.match(memberOf(CA_OPERATIONAL, 'jloc-chief').instructions, /JTF J4 joint logistics operations centre \(JTF J4 JLOC\)/);
  assert.match(memberOf(US_ARMY, 's4-lead').instructions, /the daily LOGSTAT with a 72-hour forecast/);
  assert.match(memberOf(US_ARMY, 's4-lead').instructions, /With no logistics plans officer in the section, you also write/);
  assert.equal(j4Vocabulary(US_ARMY).humanLead, 'S-4 logistics officer');
  assert.equal(j4Vocabulary(US_JOINT).humanLead, 'J-4 director');
  assert.equal(team(renderJ4Team(US_ARMY)).staff?.humanLead, 'S-4 logistics officer');
  // Reception and onward movement follows the profile's term.
  assert.match(memberOf(US_JOINT, 'mobility-planner').instructions, /Joint reception, staging, onward movement and integration \(JRSOI\)/i);
  assert.match(memberOf(CA_OPERATIONAL, 'mobility-planner').instructions, /reception, staging and onward movement \(RSOM\)/i);
});

test('every member has the preamble, a doctrinal job, a boundary, a no-decide rule, its hand-back and a definition of done, within the length limit, with no rank', () => {
  const ranks = /\b(?:General|Colonel|Lieutenant|Captain|Major|Sergeant|Admiral|Brigadier|Corporal|Private First)\b/;
  for (const { key, settings: s } of RENDERINGS) {
    for (const member of team(renderJ4Team(s)).members) {
      const where = `${key} ${member.name}`;
      assert.ok(member.instructions.startsWith(staffPreambleText()), `${where}: preamble first`);
      assert.match(member.instructions, /\n\n?(?:Your )?[Jj]ob: /, `${where}: job`);
      assert.match(member.instructions, /\nBoundary: /, `${where}: boundary`);
      assert.match(member.instructions, /\nHand back/, `${where}: hand-back`);
      assert.match(member.instructions, /\nDone when: /, `${where}: done`);
      if (member.name !== 'release-guard') assert.match(member.instructions, /\nAuthority: .*(?:never|decide)/, `${where}: a no-decide rule`);
      const words = (member.instructions.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((word) => word.length > 2).length;
      assert.ok(words < MAX_INSTRUCTION_WORDS, `${where}: ${words} words`);
      assert.doesNotMatch(`${member.role}\n${member.instructions}`, ranks, `${where}: no rank`);
      assert.doesNotMatch(member.instructions, /^##\s/m, `${where}: no line that would start a new member`);
    }
  }
  assert.match(memberOf(US_JOINT, 'ocs-planner').instructions, /Boundary: "Never select vendors or commit funds\."/);
  assert.match(memberOf(US_JOINT, 'mobility-planner').instructions, /never build or import a TPFDD/);
  assert.match(memberOf(US_JOINT, 'logstat-analyst').instructions, /Boundary: "Never fix numbers silently\."/);
  assert.match(memberOf(US_JOINT, 'services-mortuary-planner').instructions, /Boundary: "No personal data, ever\."/);
  assert.match(memberOf(US_JOINT, 'health-services-planner').instructions, new RegExp(STAFF_MARKERS.surgeonReview));
  assert.match(memberOf(US_JOINT, 'release-guard').instructions, /real stock levels, real unit holdings or real contract values/);
});

test('no member can decide: refusals in the instructions, no deciding tool, and the LOGSTAT analyst and the guard hold no file tools', () => {
  const deciding = HUMAN_ONLY_EVENTS.map((verb) => `mcp__staff-products__${verb}`);
  for (const { key, settings: s } of RENDERINGS) {
    const parsed = team(renderJ4Team(s));
    for (const member of parsed.members) {
      assert.ok(!member.tools.some((tool) => deciding.includes(tool) || /approve|reject|release|supersede/i.test(tool)), `${key} ${member.name}`);
      for (const sentence of member.instructions.split(/(?<=[.!?])\s+|\n+/)) {
        if (!/\b(?:selected|approved|released|awarded)\b/i.test(sentence)) continue;
        assert.match(sentence, /\b(?:never|not|no|nothing)\b|"/i, `${key} ${member.name}: "${sentence}"`);
      }
      const has = (verb: string) => member.tools.includes(`mcp__staff-products__${verb}`);
      assert.equal(has('submit'), member.name === parsed.members[0].name, `${key} ${member.name}: only the integrator submits`);
      assert.equal(has('verdict'), member.name === 'release-guard', `${key} ${member.name}: only the gate records verdicts`);
    }
    const analyst = parsed.members.find((member) => member.name === 'logstat-analyst')!;
    assert.ok(!analyst.tools.some((tool) => ['Write', 'Edit', 'Bash'].includes(tool)), `${key}: the analyst can never fix a report`);
    assert.ok(grantsMcpTool([...analyst.tools], 'mcp__logistics__logstat_validate'));
    assert.ok(!grantsMcpTool([...analyst.tools], 'mcp__logistics__logstat_consolidate'), 'it validates; the JLOC chief consolidates');
    const guard = parsed.members.find((member) => member.name === 'release-guard')!;
    assert.deepEqual(guard.tools, [...RELEASE_GUARD_TOOLS]);
    assert.equal(guard.model, 'standard');
    assert.deepEqual(teamAgents(parsed).find((agent) => agent.name === 'release-guard')!.writeOnly, [staffGuardFolder('j4')]);
  }
  assert.match(memberOf(US_JOINT, 'j4-director').instructions, /You never commit resources, sign contracts or approve priorities/);
  assert.match(memberOf(US_JOINT, 'jloc-chief').instructions, /never change priorities/);
});

test('the logistics server is granted by tool family: the calculator to every member with numbers, LOGSTAT to the watch, movement to the mobility planner', () => {
  const grants = (s: StaffSettings, name: string) => [...memberOf(s, name).tools];
  const withNumbers = ['j4-director', 'log-plans-officer', 'jloc-chief', 'supply-planner', 'maintenance-planner', 'mobility-planner', 'engineer-planner', 'ocs-planner', 'health-services-planner', 'services-mortuary-planner'];
  for (const name of withNumbers) assert.ok(grantsMcpTool(grants(US_JOINT, name), 'mcp__logistics__calc_run'), `${name} reaches the calculator`);
  assert.ok(grantsMcpTool(grants(US_JOINT, 'jloc-chief'), 'mcp__logistics__logstat_consolidate'));
  assert.ok(grantsMcpTool(grants(US_JOINT, 'supply-planner'), 'mcp__logistics__logstat_read'));
  assert.ok(!grantsMcpTool(grants(US_JOINT, 'supply-planner'), 'mcp__logistics__logstat_consolidate'));
  assert.ok(grantsMcpTool(grants(US_JOINT, 'mobility-planner'), 'mcp__logistics__movement_table'));
  assert.ok(!grantsMcpTool(grants(US_JOINT, 'log-plans-officer'), 'mcp__logistics__movement_table'), 'the plans officer reads movement, it does not build tables');
  assert.ok(grantsMcpTool(grants(US_JOINT, 'log-plans-officer'), 'mcp__logistics__movement_read'));
  assert.ok(grantsMcpTool(grants(US_JOINT, 'maintenance-planner'), 'mcp__logistics__readiness_import'));
  assert.ok(grantsMcpTool(grants(US_JOINT, 'jloc-chief'), 'mcp__cop-map__layer_write'), 'the JLOC chief writes the logistics layer');
  for (const { settings: s } of RENDERINGS) for (const member of team(renderJ4Team(s)).members) assert.ok(!member.tools.some((tool) => /^Web|CheckCitations/.test(tool)), 'no web tools');
});

test('every number traces to a calculator record: a traced sample estimate passes; untraced numbers and unknown records are refused', () => {
  const v = j4Vocabulary(US_JOINT);
  const estimate = j4Product('logistics-estimate')!;
  const traced = [
    '# Logistics estimate',
    '## Mission and the commander\'s priorities for support', 'Support the fictional joint force through two phases.',
    '## Logistics situation by function', '- Supply: Class III (bulk) for phase 1 is 120,000 litres (calc:fuel-phase-1).', '- Maintenance: 14 trucks need recovery (calc:recovery-phase-1).',
    '## Constraints and critical shortfalls', '- Bridging stock covers 3 days of supply (calc:class-iv-dos).',
    '## Assumptions', '- The port opens on day 2.',
    '## Requirements by course of action and phase', '| Course of action | Phase | Requirement |', '|---|---|---|', '| COA 1 | 2 | 4,500 rations (calc:class-i-coa1-p2) |',
    '## Logistics information requirements', '- Is the coastal road open?',
    '## Conclusions', `${STAFF_MARKERS.decisionFor} commander. Option A or option B, with their sustainment risk.`,
    `## ${CALC_RECORDS_HEADING}`, '- calc:fuel-phase-1: litres per vehicle per day times vehicles times days.', '```', '120000 = 40 x 1000 x 3', '```'
  ].join('\n');
  assert.deepEqual(j4MissingHeadings(estimate, v, traced), []);
  assert.deepEqual(j4NumberTrace(traced), []);
  const records = new Set(['fuel-phase-1', 'recovery-phase-1', 'class-iv-dos', 'class-i-coa1-p2']);
  assert.deepEqual(j4NumberTrace(traced, records), []);

  const untraced = traced.replace(' (calc:fuel-phase-1)', '').replace(' (calc:class-i-coa1-p2)', '');
  const found = j4NumberTrace(untraced);
  assert.equal(found.length, 2, 'both untraced numbers are found');
  assert.ok(found.every((finding) => finding.rule === 'number-without-calculation' && finding.severity === 'hold'));
  assert.match(found[0].excerpt, /120,000 litres/);
  const unknown = j4NumberTrace(traced, new Set(['fuel-phase-1']));
  assert.deepEqual(unknown.map((finding) => finding.excerpt).sort(), ['calc:class-i-coa1-p2', 'calc:class-iv-dos', 'calc:recovery-phase-1']);
  assert.equal(CALCULATOR_FOLDER, `${CALCULATOR_DIR}/`, 'the skill names the folder guard-scan reads');
  // Every product with numbers says where its records are listed.
  for (const product of J4_PRODUCTS.filter((entry) => !['map-layer', 'critique'].includes(entry.kind) && entry.id !== 'logstat-validation-log' && entry.id !== 'logistics-sync-matrix')) {
    const headings = product.headings(v);
    assert.ok(headings.includes(CALC_RECORDS_HEADING) || headings.includes('Calculator record'), `${product.id} has a place for its records`);
  }
});

test('the staff tools refuse to clear a J4 product with an untraced number or a hand-made record, and clear it once every number traces to a record the calculator wrote', async () => {
  const world = await staffWorld();
  const team4 = { ...J4_TEAM, members: [...J4_TEAM.members, 'log-plans-officer'] };
  const body = (fuel: string) => `# Logistics estimate\n\nClass III (bulk) for phase 1: 120,000 litres${fuel}.\n\n${STAFF_MARKERS.decisionFor} commander. Option A or B, with their risk.\n`;
  const propose = async (text: string) => {
    await writeBody(world.root, 'j4', 'logistics-estimate', text);
    const result = await callTool(world, team4, 'mcp__staff-products__propose', { product: 'logistics-estimate', kind: 'estimate' }, 'log-plans-officer');
    assert.ok(result.ok, result.text);
    return hashIn(result.text);
  };
  const clear = (hash: string) => callTool(world, team4, 'mcp__staff-products__verdict', { product: 'logistics-estimate', gate: 'guard', verdict: 'CLEARED', hash }, 'release-guard');

  const untraced = await clear(await propose(body('')));
  assert.equal(untraced.ok, false, 'an untraced number is refused');
  assert.match(untraced.text, /number-without-calculation/);

  // A record file a member wrote by hand is not a calculator record: the calculator ledger has no entry for it (WP-LOG).
  await mkdir(path.join(world.root, CALCULATOR_DIR), { recursive: true });
  await writeFile(path.join(world.root, CALCULATOR_DIR, 'fuel-by-hand.json'), JSON.stringify({ id: 'fuel-by-hand', formula: 'litres per vehicle per day x vehicles x days', inputs: { rate: 1000, vehicles: 40, days: 3 }, result: 120000 }));
  const byHand = await clear(await propose(body(' (calc:fuel-by-hand)')));
  assert.equal(byHand.ok, false, 'a record the calculator did not write is refused');
  assert.match(byHand.text, /calc:fuel-by-hand has a file in the calculator folder but no entry in the calculator ledger/);

  const missing = await clear(await propose(body(' (calc:fuel-phase-9)')));
  assert.equal(missing.ok, false, 'a record that does not exist is refused');
  assert.match(missing.text, /calc:fuel-phase-9 names no calculator record/);

  await writeFactors(world.root, [{ id: 'fuel-cargo-truck', what: 'Fuel for one cargo truck', rate: 1000, unit: 'litres', per: 'vehicle per day', enteredBy: 'A. Demo' }]);
  const calculated = await callLogistics(world, team4, 'calc_run', { id: 'fuel-phase-1', title: 'Class III (bulk) for phase 1', lines: [{ factor: 'fuel-cargo-truck', count: 40, item: 'cargo trucks' }], days: 3 }, 'log-plans-officer');
  assert.ok(calculated.ok, calculated.text);
  const ok = await clear(await propose(body(' (calc:fuel-phase-1)')));
  assert.ok(ok.ok, ok.text);
});

test('the logstat-definitions skill: the LOGSTAT words, the plausibility rules, the bands as settings, the profile\'s classes, and the calculator convention', () => {
  assert.deepEqual([...J4_SKILLS], ['logstat-definitions']);
  for (const profile of STAFF_PROFILE_IDS) {
    const s = profile === 'us-army' ? US_ARMY : profile === 'nato-ca' ? CA_OPERATIONAL : US_JOINT;
    const text = logstatDefinitionsSkill(j4Vocabulary(s));
    assert.match(text, /^# LOGSTAT definitions/);
    for (const word of ['On hand', 'Received', 'Consumed', 'Capacity', 'Required', 'Days of supply']) assert.match(text, new RegExp(`\\| ${word} \\|`));
    for (const entry of SUPPLY_CLASSES[profile]) assert.ok(text.includes(`| Class ${entry.class}:`), `${profile}: Class ${entry.class}`);
    assert.equal((text.match(/^\| Class /gm) ?? []).length, profile === 'nato-ca' ? 5 : 10);
    assert.match(text, /never above capacity \(no fuel above tank capacity\)/);
    assert.match(text, /a difference is a finding, not a correction/);
    assert.match(text, /The amber and red bands are settings, never fixed numbers/);
    assert.match(text, /\.planning\/staff\/calculator\/<id>\.json/);
    assert.match(text, /`calc:<id>`/);
    assert.match(text, /ships no planning factor tables/);
  }
  const files = j4Template(US_JOINT).files;
  assert.deepEqual(files.map((file) => file.path), ['.planning/staff/PROFILE.md', j4SkillPath('logstat-definitions')]);
  assert.equal(files[0].content, renderProfileMarkdown(resolveProfile(US_JOINT)));
});

test('the project guidance: its own markers, the rules, the workflow per step, the handoffs and the skill it points to', () => {
  for (const { key, settings: s } of RENDERINGS) {
    const guidance = j4Guidance(s);
    const v = j4Vocabulary(s);
    for (const step of CROSSWALK_STEPS) assert.match(guidance, new RegExp(`^\\| ${step} `, 'm'), `${key}: step ${step}`);
    assert.match(guidance, /\*\*Every number traces to a calculator record\.\*\*/);
    assert.match(guidance, /logstat-definitions\.md/);
    assert.match(guidance, new RegExp(`From the ${v.intel}: threats to lines of communication`));
    assert.match(guidance, /\*\*A person decides\.\*\*/);
  }
  const agents = withJ4Guidance('# Notes\n\nKeep this.\n', US_JOINT);
  assert.match(agents, /Keep this\./);
  assert.equal(staffGuidanceIn(agents, J4_TEMPLATE_ID)?.trim(), j4Guidance(US_JOINT).trim());
});

test('the Staff setup offers J4: every profile and offered level, no extra question, and a plan with the team, PROFILE.md, the skill and the guidance', () => {
  assert.equal(staffTemplate(J4_TEMPLATE_ID), J4_STAFF_TEMPLATE);
  assert.equal(staffTemplateForSection('j4'), J4_STAFF_TEMPLATE);
  assert.ok(STAFF_TEMPLATES.includes(J4_STAFF_TEMPLATE));
  assert.deepEqual(profileChoices(J4_STAFF_TEMPLATE).map((choice) => choice.value), ['us-joint', 'us-army', 'nato-ca']);
  assert.deepEqual(levelChoices(J4_STAFF_TEMPLATE, 'nato-ca').map((choice) => choice.value), ['strategic', 'operational', 'tactical']);
  assert.deepEqual(levelChoices(J4_STAFF_TEMPLATE, 'us-army').map((choice) => choice.value), ['tactical']);
  assert.equal(nationChoices('nato-ca').length, 2);
  assert.deepEqual(templateQuestions(J4_STAFF_TEMPLATE, { profile: 'nato-ca', level: 'tactical' }), {});
  const plan = planStaffSetup({ templateId: J4_TEMPLATE_ID, options: { settings: CA_OPERATIONAL }, agents: '# Agent instructions\n' });
  assert.equal(plan.roster.members.length, 12);
  assert.equal(plan.roster.humanLead, 'J4 director');
  assert.equal(plan.roster.fileName, 'j4-nato-ca-operational');
  assert.match(plan.team, /template: j4-logistics\ntemplateVersion: \d+\n/);
  const paths = plan.writes.map((write) => write.path);
  assert.deepEqual(paths, ['.planning/staff/PROFILE.md', j4SkillPath('logstat-definitions'), '.planning/.near-ai/project.json', 'AGENTS.md']);
  assert.ok(staffGuidanceIn(plan.writes[3].content, J4_TEMPLATE_ID));
  // Update Team finds today's rendering for a J4 file by its own members.
  const sections = splitTeam(plan.team).sections;
  const best = bestStaffRendering(J4_STAFF_TEMPLATE, CA_OPERATIONAL, sections);
  assert.deepEqual(best?.sections.map((section) => section.name), sections.map((section) => section.name));
});

test('the J4 sources and renderings carry no em-dash, no provisional or preview marker, no retired space term, and no restricted publication by name', () => {
  for (const file of readdirSync(STAFF_SRC).filter((name) => name.startsWith('j4'))) {
    const text = readFileSync(path.join(STAFF_SRC, file), 'utf8');
    assert.ok(!text.includes(String.fromCharCode(0x2014)), `${file} has an em-dash`);
    assert.doesNotMatch(text, /provisional|preview/i, file);
  }
  for (const rendering of J4_STAFF_TEMPLATE.renderings().filter((entry) => entry.key.endsWith('/cloud'))) {
    for (const text of [rendering.team, rendering.guidance, ...rendering.files.map((file) => file.content)]) {
      assert.ok(!text.includes(String.fromCharCode(0x2014)), `${rendering.key} has an em-dash`);
      assert.doesNotMatch(text, /provisional|preview|NEAR organization/i);
      for (const term of RETIRED_SPACE_TERMS) assert.ok(!text.toLowerCase().includes(term));
      // Products cite restricted publications by title only; the template itself never prompts a member to quote one.
      assert.doesNotMatch(text, /\bJP 4-0\b|\bCFJP 4-0\b/, rendering.key);
    }
  }
  assert.ok(DOCTRINE_PROFILES['us-joint'].annexes.logistics.kind === 'annex');
});
