// The J3 operations team template (design 10, 3.4; WP-J3): every variant parses and passes the local team check with no findings, stays within 12
// members with a release guard, gives every product exactly one owner (and the shared ones to the writer the staff contract names, folds included),
// opens every member with the shared preamble and ends it with a boundary and a deliverable, uses the right running estimate headings and space terms,
// hands staff planning to the J3 director in a crisis, scales by level, keeps the watch officer without Write, and is offered by Staff setup.
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkTeam, MAX_INSTRUCTION_WORDS } from '../agent/teamCheck';
import { draftFromMarkdown } from '../agent/teamMarkdown';
import { parseTeam } from '../agent/teams';
import { planTeamUpdate } from '../agent/teamUpdate';
import { staffTemplateOf } from '../agent/staffTeamUpdate';
import { staffGuidanceIn } from '../agent/staff/guidance';
import { j2Renderings } from '../agent/staff/j2Template';
import { variantProducts } from '../agent/staff/j2Products';
import { j3Guidance, j3OptionSets, j3SkillPath, j3Template, J3_SKILLS, J3_TEMPLATE_ID, renderJ3Team } from '../agent/staff/j3Operations';
import type { J3TemplateOptions } from '../agent/staff/j3Operations';
import { j3SkillText, j3TemplateFiles } from '../agent/staff/j3Skills';
import { j5OptionSets, j5Template } from '../agent/staff/j5Plans';
import { J3_STAFF_TEMPLATE, STAFF_TEMPLATES, staffTemplate } from '../agent/staff/templates';
import { FUNCTION_SETS, INFLUENCE_ACTIVITIES, RETIRED_SPACE_TERMS, SPACE_MISSION_AREAS } from '../domain/staff/doctrine';
import { phaseFrom, SHARED_PRODUCTS, TRANSITION_PRODUCT, writerIn } from '../domain/staff/ownership';
import type { StaffPhase } from '../domain/staff/ownership';
import { STAFF_MARKERS, staffPreambleText } from '../domain/staff/products';
import { defaultStaffSettings, retiredSpaceTerms } from '../domain/staff/profiles';
import type { StaffSettings } from '../domain/staff/profiles';
import { checkRow, COMMANDER_REVIEW_MARK, REGISTER_SCHEMAS } from '../domain/staff/registers';
import { staffProductPath, staffWriteLimit, writeAllowedBy } from '../domain/staff/writeLimits';
import { levelChoices, planStaffSetup, profileChoices, templateOffers } from '../services/staffSetup';

const settings = (extra: Partial<StaffSettings> = {}): StaffSettings => ({ ...defaultStaffSettings(), ...extra });
const ALL = j3OptionSets();
const label = (options: J3TemplateOptions) => `${options.settings.profile}/${options.settings.level}${options.settings.nation ? `/${options.settings.nation}` : ''}/${options.settings.planningType}`;
const ownsLine = (instructions: string) => /^Owns: (.*)$/m.exec(instructions)?.[1] ?? '';
const member = (options: J3TemplateOptions, name: string) => j3Template(options).members.find((entry) => entry.name === name);
/** The shared products whose writer changes at transition: the J3 writes them in execution. */
const EXECUTION_PRODUCTS = ['sync-matrix', 'dst-dsm', 'assessment-plan'];

test('every variant parses, has at most 12 members with a release guard, is private, and carries its staff block', () => {
  assert.equal(ALL.length, 27, 'every offered profile, level, nation and planning type');
  for (const options of ALL) {
    const team = parseTeam(renderJ3Team(options), 'team.md');
    const name = label(options);
    assert.ok(team.members.length <= 12, `${name}: ${team.members.length} members`);
    assert.equal(team.members.length, options.settings.level === 'tactical' ? 10 : 12, `${name}: the roster size for the level`);
    assert.ok(team.members.some((entry) => entry.name === 'release-guard'), `${name}: the guard is never dropped`);
    assert.equal(team.private, true, `${name}: private by default`);
    assert.ok(team.members.every((entry) => entry.privacy === 'private'), `${name}: every member private`);
    assert.equal(team.staff?.section, 'j3');
    assert.equal(team.staff?.glyph, 'chevrons');
    assert.equal(team.staff?.profile, options.settings.profile);
    assert.equal(team.staff?.level, options.settings.level);
    assert.deepEqual([...(team.staff?.layers ?? [])].sort(), ['cop', 'cop-operations-layer']);
    assert.ok(team.members.every((entry) => !entry.tools.some((tool) => /^Web|CheckCitations/.test(tool))), `${name}: no web tools`);
  }
  // The J3 carries no web tools, so a local-only project gets the same team.
  assert.equal(J3_STAFF_TEMPLATE.render({ settings: settings(), locality: 'local' }).team, J3_STAFF_TEMPLATE.render({ settings: settings(), locality: 'cloud' }).team);
});

test('the local team check finds nothing in any variant: no warnings and no parallel-work advice', () => {
  for (const options of ALL) {
    const findings = checkTeam(draftFromMarkdown(renderJ3Team(options), 'team.md'));
    assert.deepEqual(findings.map((finding) => `${finding.id}: ${finding.message}`), [], label(options));
  }
});

test('every product has exactly one owner, named in that member\'s Owns line and nobody else\'s, and shared products go to the contract\'s writer', () => {
  for (const options of ALL) {
    const template = j3Template(options);
    const name = label(options);
    const names = template.members.map((entry) => entry.name);
    const products = template.products.map((product) => product.product);
    assert.equal(new Set(products).size, products.length, `${name}: no product listed twice`);
    assert.deepEqual([...template.block.products, ...template.block.layers].sort(), [...products].sort(), `${name}: the staff block lists the products`);
    assert.ok(products.length <= 50, `${name}: within the staff block's limit`);
    for (const product of template.products) {
      assert.ok(names.includes(product.owner), `${name}: ${product.product} is owned by a member`);
      const holders = template.members.filter((entry) => ownsLine(entry.instructions).split(', ').some((item) => item.replace(/\.$/, '') === staffProductPath('j3', product.product)));
      assert.deepEqual(holders.map((entry) => entry.name), [product.owner], `${name}: ${product.product} appears in exactly its owner's Owns line`);
      const shared = SHARED_PRODUCTS.find((entry) => entry.product === product.product);
      if (!shared) continue;
      const phase: StaffPhase = EXECUTION_PRODUCTS.includes(product.product) ? 'execution' : 'planning';
      const writer = writerIn(product.product, { phase, mode: 'standalone' }, { section: 'j3', members: names });
      assert.equal(writer?.section, 'j3', `${name}: ${product.product} is the J3's in ${phase}`);
      assert.equal(writer?.member, product.owner, `${name}: ${product.product} goes to the contract's writer, through its folds`);
    }
    // Every shared part the J3 writes has its writer on this roster.
    const ffir = writerIn('ccir-register', { phase: 'planning', mode: 'standalone' }, { section: 'j3', members: names }, 'ffir');
    assert.ok(ffir && names.includes(ffir.member), `${name}: the FFIR part has its writer`);
    for (const entry of template.members) assert.ok(ownsLine(entry.instructions), `${name}: ${entry.name} says what it owns`);
  }
});

test('J3 product names never collide with another section\'s, except the shared products and the transition brief', () => {
  const others = new Set<string>([
    ...j5OptionSets().flatMap((options) => j5Template(options).products.map((product) => product.product)),
    ...(['strategic', 'operational', 'brigade', 'battalion'] as const).flatMap((variant) => variantProducts(variant).map((product) => product.id))
  ]);
  assert.ok(j2Renderings().length > 0);
  const allowed = new Set([...SHARED_PRODUCTS.map((entry) => entry.product), TRANSITION_PRODUCT]);
  for (const options of ALL) {
    for (const product of j3Template(options).products) {
      if (others.has(product.product)) assert.ok(allowed.has(product.product), `${label(options)}: ${product.product} is also another section's`);
    }
  }
});

test('every member opens with the shared preamble and ends with a boundary and what it hands back, within the length limit, with no persona or rank', () => {
  const ranks = /\b(?:General|Colonel|Lieutenant|Captain|Major|Sergeant|Admiral|Brigadier|Corporal|Private First)\b/;
  for (const options of ALL) {
    for (const entry of j3Template(options).members) {
      const where = `${label(options)} ${entry.name}`;
      assert.ok(entry.instructions.startsWith(staffPreambleText()), `${where}: preamble first`);
      assert.match(entry.instructions, /\nBoundary: "[^"]+"/, `${where}: boundary sentence`);
      assert.match(entry.instructions, /\nHands back: /, `${where}: deliverable`);
      const words = (entry.instructions.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((word) => word.length > 2).length;
      assert.ok(words < MAX_INSTRUCTION_WORDS, `${where}: ${words} words`);
      assert.doesNotMatch(`${entry.role}\n${entry.instructions}`, ranks, `${where}: no rank`);
      assert.doesNotMatch(entry.instructions, /^##\s/m, `${where}: no line that would start a new member`);
    }
  }
});

test('members never claim a decision: "selected", "approved" and "released" appear only as prohibitions', () => {
  for (const options of ALL) {
    for (const entry of j3Template(options).members) {
      for (const sentence of entry.instructions.split(/(?<=[.!?])\s+|\n+/)) {
        if (!/\b(?:selected|approved|released|selects|approves)\b/i.test(sentence)) continue;
        assert.match(sentence, /\b(?:never|not|no|nothing)\b|"/i, `${label(options)} ${entry.name}: "${sentence}"`);
      }
    }
  }
});

test('the watch officer has no Write: no write tools, a write limit of nothing, and only the register tool to log through', () => {
  for (const options of ALL) {
    const watch = member(options, 'watch-officer')!;
    assert.ok(watch, label(options));
    assert.ok(!watch.tools.some((tool) => ['Write', 'Edit', 'Bash', 'CreateDocument', 'RenderSvg'].includes(tool)), `${label(options)}: ${watch.tools.join(', ')}`);
    assert.ok(watch.tools.includes('mcp__staff-products__register'), 'it logs through the register tool');
    assert.ok(!watch.tools.some((tool) => /__(?:propose|submit|verdict)$/.test(tool)), 'it registers no product');
    assert.match(watch.instructions, /Boundary: "Your output is facts, never interpretation\."/);
    assert.equal(watch.model, 'fast');
  }
  assert.deepEqual(staffWriteLimit({ section: 'j3' }, 'watch-officer'), []);
  assert.equal(writeAllowedBy([], staffProductPath('j3', 'event-log')), false);
  // The J2's watch officer writes its INTSUM; only the J3's has no Write.
  assert.equal(staffWriteLimit({ section: 'j2' }, 'watch-officer'), undefined);
});

test('every FRAGO is a staff product the release guard checks and a person releases', () => {
  for (const options of ALL) {
    const template = j3Template(options);
    const fragos = template.products.filter((product) => product.kind === 'order');
    assert.deepEqual(fragos.map((product) => product.product).sort(), ['frago', 'immediate-frago'], label(options));
    for (const name of ['future-ops-planner', template.members[1].name]) {
      const text = member(options, name)!.instructions;
      assert.match(text, /mcp__staff-products__propose/, `${label(options)} ${name}`);
      assert.match(text, /release-guard checks that exact version/);
      assert.match(text, /only that person releases it/);
    }
    const execute = template.workflow.find((step) => step.step === 8)!;
    assert.ok(execute.humanGate);
    assert.match(execute.gate, /through the release state machine/);
    assert.match(member(options, 'release-guard')!.instructions, /every (?:FRAGORD|FRAGO) above all/);
  }
  assert.match(member({ settings: settings() }, 'future-ops-planner')!.instructions, /FRAGORD/);
  assert.match(member({ settings: settings({ profile: 'nato-ca', nation: 'ca' }) }, 'future-ops-planner')!.instructions, /\bFRAGO\b/);
});

test('fires and targeting: both review marks on every package and workbook row, notional targets, the six-phase targeting cycle', () => {
  for (const options of ALL) {
    const fires = member(options, 'fires-effects-coordinator')!.instructions;
    assert.ok(fires.includes(`${STAFF_MARKERS.decisionFor} commander or delegate`) && fires.includes(STAFF_MARKERS.legalReview), label(options));
    assert.match(fires, /never nominate or approve real targets/);
    assert.match(fires, /1\. End state and commander's objectives;.*6\. Assessment/);
    const targeting = member(options, 'targeting-officer')!.instructions;
    assert.ok(targeting.includes(STAFF_MARKERS.legalReview) && targeting.includes(COMMANDER_REVIEW_MARK), label(options));
    assert.match(targeting, /Notional entries in the exercise box only/);
    const guard = member(options, 'release-guard')!.instructions;
    assert.match(guard, /a fires or targeting product without both/);
  }
});

test('the space work uses the JP 3-14 (2023) mission areas and no retired term anywhere the template writes', () => {
  for (const options of ALL) {
    const template = j3Template(options);
    const planner = member(options, 'cyber-space-planner') ?? member(options, 'information-cyber-space-planner');
    assert.ok(planner, label(options));
    for (const area of SPACE_MISSION_AREAS) assert.ok(planner!.instructions.includes(area), `${label(options)}: ${area}`);
    const files = J3_STAFF_TEMPLATE.render({ settings: options.settings });
    for (const text of [files.team, files.guidance, ...files.files.map((file) => file.content)]) assert.deepEqual(retiredSpaceTerms(text), [], label(options));
    for (const entry of template.members) for (const term of RETIRED_SPACE_TERMS) assert.ok(!entry.role.toLowerCase().includes(term));
  }
});

test('the running estimate uses the seven joint functions, or the five Canadian operational functions under NATO/Canadian with Canada', () => {
  const headings = (options: J3TemplateOptions) => j3SkillText('running-estimate', options);
  for (const options of ALL) {
    const canadian = options.settings.profile === 'nato-ca' && options.settings.nation === 'ca';
    const names = canadian ? FUNCTION_SETS['canadian-operational-functions'] : FUNCTION_SETS['joint-functions'];
    const director = j3Template(options).members[0].instructions;
    assert.ok(director.includes(names.join(', ')), `${label(options)}: the director's headings`);
    assert.ok(headings(options).includes(names.join(', ')), `${label(options)}: the skill's headings`);
    assert.match(director, /recommendations for anticipated decisions/);
  }
  assert.match(j3Template({ settings: settings({ profile: 'nato-ca', nation: 'ca' }) }).members[0].instructions, /Command, Sense, Act, Shield, Sustain/);
  assert.match(j3Template({ settings: settings({ profile: 'nato-ca', nation: 'nato' }) }).members[0].instructions, /seven joint functions/);
});

test('the three horizons and the transition brief come from the settings and reach the members, guidance and skill', () => {
  const options = { settings: settings({ horizons: { currentOpsHours: 12, futureOpsHours: 72 } }) };
  const guidance = j3Guidance(options);
  assert.match(guidance, /Current operations \(immediate and near-term issues of the operation under way\) runs to 12 hours/);
  assert.match(guidance, /future operations \(branches to the current operation\) runs to 72 hours/);
  assert.match(guidance, /future plans \(the next phase of the operation and sequels\) lies beyond, with the J-5/);
  assert.match(guidance, /only through a transition brief a person accepts/);
  const loop = j3SkillText('execution-loop', options);
  assert.match(loop, /\| Current operations \|.*\| to 12 hours \|/);
  assert.match(loop, /\| Future plans \|.*\(J-5\) \| beyond \|/);
  const future = member(options, 'future-ops-planner')!;
  assert.match(future.instructions, /Boundary: "Your output is branches; sequels are the J5's\."/);
  assert.ok(ownsLine(future.instructions).includes(staffProductPath('j3', TRANSITION_PRODUCT)));
  assert.match(member(options, 'joc-chief')!.instructions, /joint operations centre \(JOC\)/);
  assert.match(member({ settings: settings({ level: 'strategic' }) }, 'joc-chief')!.instructions, /command centre or joint operations centre/);
});

test('crisis planning: the J3 director leads staff planning, writes the planning direction, and the J3 leads step 1', () => {
  for (const options of ALL) {
    const template = j3Template(options);
    const crisis = options.settings.planningType === 'crisis';
    const direction = template.products.some((product) => product.product === 'planning-direction');
    assert.equal(direction, crisis, `${label(options)}: the planning direction only in a crisis`);
    assert.equal(template.block.steps[1], crisis ? 'primary' : 'supporting');
    const guidance = j3Guidance(options);
    if (crisis) {
      assert.match(guidance, /\*\*Crisis planning\.\*\*/, label(options));
      assert.match(template.members[0].instructions, /This is crisis planning/);
      assert.equal(template.planningLead, template.humanLead, `${label(options)}: the section's own director leads`);
    } else {
      assert.doesNotMatch(guidance, /Crisis planning/);
      if (options.settings.level !== 'tactical') assert.match(template.planningLead, /^J-?5 director$/);
    }
  }
});

test('the level variants: strategic campaigns across the continuum; tactical folds to ten under G or S codes, with convergence windows under US Army', () => {
  const strategic = j3Template({ settings: settings({ level: 'strategic' }) });
  assert.equal(strategic.members.length, 12);
  assert.match(strategic.members[0].instructions, /competition continuum \(cooperation, competition below armed conflict, armed conflict\)/);
  const operational = j3Template({ settings: settings() });
  assert.deepEqual(operational.members.map((entry) => entry.name), [
    'j3-director', 'joc-chief', 'watch-officer', 'future-ops-planner', 'fires-effects-coordinator', 'targeting-officer', 'information-planner', 'cyber-space-planner',
    'airspace-maritime-liaison', 'assessment-analyst', 'liaison-coordinator', 'release-guard'
  ]);
  assert.equal(operational.humanLead, 'J-3 director');
  const army = j3Template({ settings: settings({ profile: 'us-army', level: 'tactical' }) });
  assert.deepEqual(army.members.map((entry) => entry.name), [
    's3-lead', 'current-ops-chief', 'watch-officer', 'future-ops-planner', 'fires-effects-coordinator', 'targeting-officer', 'information-cyber-space-planner',
    'assessment-analyst', 'liaison-coordinator', 'release-guard'
  ]);
  assert.match(army.name, /^S-3 operations/);
  assert.doesNotMatch(renderJ3Team({ settings: settings({ profile: 'us-army', level: 'tactical' }) }), /\bJ-3\b/);
  assert.ok(army.products.some((product) => product.product === 'convergence-window-tracker'));
  assert.match(army.members[1].role, /^Current operations cell chief/);
  assert.match(army.members[1].instructions, /battle captain's and battle NCO's duties/);
  assert.ok(army.products.some((product) => product.product === 'airspace-maritime-requests' && product.owner === 'liaison-coordinator'));
  const canadian = j3Template({ settings: settings({ profile: 'nato-ca', level: 'tactical', nation: 'ca' }) });
  assert.ok(!canadian.products.some((product) => product.product === 'convergence-window-tracker'), 'multidomain operations is a US Army concept');
  assert.match(canadian.name, /^G3 operations/);
  const influence = canadian.members.find((entry) => entry.name === 'information-cyber-space-planner')!.instructions;
  for (const activity of INFLUENCE_ACTIVITIES) assert.ok(influence.toLowerCase().includes(activity.toLowerCase()), activity);
  assert.match(influence, /not information operations/);
});

test('the annex letters come from the profile: operations C, C or A; fires an appendix to C, Annex D or within A', () => {
  const director = (extra: Partial<StaffSettings>) => j3Template({ settings: settings(extra) }).members[0].instructions;
  const fires = (extra: Partial<StaffSettings>) => j3Template({ settings: settings(extra) }).members.find((entry) => entry.name === 'fires-effects-coordinator')!.instructions;
  assert.match(director({}), /the operations annex is Annex C \(Operations\)/);
  assert.match(director({ profile: 'us-army', level: 'tactical' }), /the operations annex is Annex C/);
  assert.match(director({ profile: 'nato-ca', nation: 'nato' }), /the operations annex is Annex A \(Conduct of Operations\)/);
  assert.match(fires({}), /filed as Appendix to Annex C/);
  assert.match(fires({ profile: 'us-army', level: 'tactical' }), /filed as Annex D \(Fires\)/);
  assert.match(fires({ profile: 'nato-ca', nation: 'nato' }), /filed as No letter in the profile|filed as Part of Annex A/);
});

test('the template files: PROFILE.md and the two skills, each at its path', () => {
  const files = j3TemplateFiles({ settings: settings() });
  assert.deepEqual(files.map((file) => file.path), ['.planning/.near-ai/team.md', '.planning/staff/PROFILE.md', ...J3_SKILLS.map(j3SkillPath)]);
  assert.ok(files.every((file) => file.text.trim().length > 200));
  const loop = files.find((file) => file.path === j3SkillPath('execution-loop'))!.text;
  assert.match(loop, /\| Step \| Lanes, run in parallel \| Merge \(one integrator\) \| Gate \|/);
  assert.match(loop, /Time \(UTC\); Source; What was reported/);
  const rendered = J3_STAFF_TEMPLATE.render({ settings: settings() });
  assert.deepEqual(rendered.files.map((file) => file.path), ['.planning/staff/PROFILE.md', ...J3_SKILLS.map(j3SkillPath)]);
});

test('Staff setup offers J3 with every profile and level it is written for, and writes its team, skills and guidance block', () => {
  assert.ok(STAFF_TEMPLATES.includes(J3_STAFF_TEMPLATE));
  assert.equal(staffTemplate(J3_TEMPLATE_ID), J3_STAFF_TEMPLATE);
  assert.deepEqual(STAFF_TEMPLATES.map((template) => template.section), ['j2', 'j5', 'j3', 'j4'], 'demo order');
  assert.deepEqual(profileChoices(J3_STAFF_TEMPLATE).map((choice) => choice.value), ['us-joint', 'us-army', 'nato-ca']);
  assert.deepEqual(levelChoices(J3_STAFF_TEMPLATE, 'nato-ca').map((choice) => choice.value), ['strategic', 'operational', 'tactical']);
  assert.equal(templateOffers(J3_STAFF_TEMPLATE).length, 9);
  const options = { settings: settings(), locality: 'cloud' as const };
  const plan = planStaffSetup({ templateId: J3_TEMPLATE_ID, options, agents: '# Agent instructions\n\nMine.\n' });
  assert.equal(plan.roster.fileName, 'j3-us-joint-operational');
  assert.equal(plan.roster.humanLead, 'J-3 director');
  assert.match(plan.team, /^---[\s\S]*template: j3-operations\ntemplateVersion: \d+\ntemplateBase:/);
  const byPath = new Map(plan.writes.map((write) => [write.path, write.content]));
  for (const skill of J3_SKILLS) assert.ok(byPath.has(j3SkillPath(skill)), skill);
  const agents = byPath.get('AGENTS.md')!;
  assert.match(agents, /Mine\./);
  assert.equal(staffGuidanceIn(agents, J3_TEMPLATE_ID), J3_STAFF_TEMPLATE.render(options).guidance);
  // Update Team knows the J3 team, and a fresh one is the current rendering.
  assert.equal(staffTemplateOf(plan.team, 'j3-operations')?.id, J3_TEMPLATE_ID);
  const update = planTeamUpdate(plan.team, { staffSettings: options.settings })!;
  assert.ok(update.members.every((entry) => entry.action === 'same'), JSON.stringify(update.members.map((entry) => [entry.name, entry.action])));
  const tactical = settings({ profile: 'us-army', level: 'tactical' });
  const army = planStaffSetup({ templateId: J3_TEMPLATE_ID, options: { settings: tactical, locality: 'cloud' } });
  assert.ok(planTeamUpdate(army.team, { staffSettings: tactical })!.members.every((entry) => entry.action === 'same'));
});

test('the phase comes from a person accepting the transition brief, and the tactical names fold to the shared products\' writers', () => {
  assert.equal(phaseFrom(undefined), 'planning');
  assert.equal(phaseFrom({ approvedVersions: [] }), 'planning');
  assert.equal(phaseFrom({ approvedVersions: [1] }), 'execution');
  const tactical = j3Template({ settings: settings({ profile: 'us-army', level: 'tactical' }) }).members.map((entry) => entry.name);
  const team = { section: 'j3' as const, members: tactical };
  for (const product of ['cop', 'cop-operations-layer', 'event-log', 'battle-rhythm-calendar']) {
    assert.equal(writerIn(product, { phase: 'planning', mode: 'standalone' }, team)?.member, 'current-ops-chief', product);
  }
  assert.equal(writerIn('ccir-register', { phase: 'planning', mode: 'standalone' }, team)?.member, 's3-lead');
  assert.equal(writerIn('ccir-register', { phase: 'planning', mode: 'standalone' }, team, 'ffir')?.member, 's3-lead');
  // The event log takes facts in a fixed form; an escalated entry names what it matched.
  const log = REGISTER_SCHEMAS['event-log'];
  assert.deepEqual(log.columns.filter((column) => column.required).map((column) => column.key), ['id', 'time', 'source', 'report', 'status']);
  assert.equal(checkRow(log, { id: 'E1', time: '2026-11-18T12:05Z', source: 'TF ANVIL', report: 'Bridge 4 down', status: 'escalated' }).ok, false);
  assert.equal(checkRow(log, { id: 'E1', time: '2026-11-18T12:05Z', source: 'TF ANVIL', report: 'Bridge 4 down', status: 'escalated', decisionPoint: 'DP1' }).ok, true);
});
