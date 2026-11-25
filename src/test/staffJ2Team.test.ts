// The J2 intelligence staff team template (design 10, 3.2, 4.4 and 6.2; WP-J2): every rendering parses and passes the team check with no findings,
// the roster limits and level variants hold, the words follow the profile, every product has one owner whose instructions carry its headings, the
// boundary and no-decide rules are in every member, no member has a persona name or a rank, the team is private, and the template history is current.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { draftFromMarkdown } from '../agent/teamMarkdown';
import { checkTeam, MAX_INSTRUCTION_WORDS } from '../agent/teamCheck';
import { TEMPLATE_HISTORY } from '../agent/teamTemplateHistory';
import { parseTeam, teamIsPrivate } from '../agent/teams';
import { staffProductTools } from '../agent/staff/grants';
import { J2_ROSTERS } from '../agent/staff/j2Members';
import { J2_PRODUCTS, missingHeadings, productPath, productsOwnedBy, variantProducts } from '../agent/staff/j2Products';
import { icd203Skill, sourceGradingSkill } from '../agent/staff/j2Skills';
import { j2Guidance, j2Renderings, j2Template, j2TeamDescription, j2WorkflowSteps, MAX_TEAM_MEMBERS, renderJ2Team, withJ2Guidance } from '../agent/staff/j2Template';
import { J2_VARIANTS, j2VariantFor, j2Vocabulary } from '../agent/staff/j2Vocabulary';
import type { J2Variant } from '../agent/staff/j2Vocabulary';
import { STAFF_TEMPLATES, staffTemplateSnapshot } from '../agent/staff/templates';
import { CLEARANCE_SELF_ASSERTED_TEXT, LABELS_NOT_ACCREDITATION_TEXT } from '../domain/gate/labels';
import { ANNEX_SUBJECTS, CROSSWALK_STEPS, DOCTRINE_PROFILES, ICD203_LIKELIHOOD, STAFF_PROCESSES } from '../domain/staff/doctrine';
import { defaultStaffSettings, stepName } from '../domain/staff/profiles';
import type { StaffSettings } from '../domain/staff/profiles';
import { HUMAN_ONLY_EVENTS } from '../domain/staff/release';

const settings = (patch: Partial<StaffSettings> = {}): StaffSettings => ({ ...defaultStaffSettings(), ...patch });
const US_JOINT = settings();
const US_ARMY = settings({ profile: 'us-army', level: 'tactical' });
const NATO_CA = settings({ profile: 'nato-ca', level: 'operational', nation: 'ca' });
const NATO = settings({ profile: 'nato-ca', level: 'operational', nation: 'nato' });
const team = (text: string) => parseTeam(text, '/p/.planning/staff/teams/j2-intelligence.md');
const member = (text: string, name: string) => team(text).members.find((entry) => entry.name === name)!;
const STAFF_SRC = path.resolve(__dirname, '..', '..', 'src', 'agent', 'staff');

/** A sample of the settings: every profile and offered level, both nations, both echelons, a crisis, cloud and local. */
const RENDERINGS = j2Renderings();

test('every rendering of the template parses, stays within 12 members, and passes the team check with no finding at all', () => {
  assert.equal(RENDERINGS.length, 36, 'every profile, offered level, nation, planning type and echelon');
  for (const rendering of RENDERINGS) {
    for (const locality of ['cloud', 'local'] as const) {
      const text = renderJ2Team(rendering.settings, { ...(rendering.echelon ? { echelon: rendering.echelon } : {}), locality });
      const parsed = team(text);
      assert.ok(parsed.members.length <= MAX_TEAM_MEMBERS, `${rendering.key}: at most 12 members`);
      assert.deepEqual(checkTeam(draftFromMarkdown(text, 'j2.md')), [], `${rendering.key} (${locality}): no warnings and no parallel-work advice`);
      for (const entry of parsed.members) {
        const words = (entry.instructions.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((word) => word.length > 2).length;
        assert.ok(words < MAX_INSTRUCTION_WORDS, `${rendering.key}/${entry.name}: ${words} words`);
      }
      if (locality === 'local') assert.ok(parsed.members.every((entry) => !entry.tools.some((tool) => ['WebSearch', 'WebFetch', 'CheckCitations'].includes(tool))), 'a local-only project keeps members off the web');
      assert.ok(j2TeamDescription(j2Vocabulary(rendering.settings, j2VariantFor(rendering.settings, rendering.echelon))).length <= 300);
    }
  }
});

test('the roster per level: 9 strategic, 12 operational, 7 at brigade, 5 at battalion, the release-guard and the tradecraft gate in every one', () => {
  const expected: Record<J2Variant, string[]> = {
    strategic: ['j2-chief', 'requirements-manager', 'collection-manager', 'jipoe-analyst', 'threat-analyst', 'warning-analyst', 'red-cell', 'tradecraft-reviewer', 'release-guard'],
    operational: ['j2-chief', 'requirements-manager', 'collection-manager', 'jipoe-analyst', 'geoint-analyst', 'osint-analyst', 'threat-analyst', 'watch-officer', 'target-analyst', 'red-cell', 'tradecraft-reviewer', 'release-guard'],
    brigade: ['s2-lead', 'ipb-analyst', 'collection-manager', 'watch-officer', 'target-analyst', 'tradecraft-reviewer', 'release-guard'],
    battalion: ['s2-lead', 'ipb-analyst', 'watch-officer', 'tradecraft-reviewer', 'release-guard']
  };
  for (const variant of J2_VARIANTS) assert.deepEqual(J2_ROSTERS[variant].map((spec) => spec.name), expected[variant], variant);
  assert.equal(team(renderJ2Team(US_JOINT)).members.length, 12, 'the operational default uses the whole cap');
  assert.deepEqual(team(renderJ2Team(settings({ level: 'strategic' }))).members.map((entry) => entry.name), expected.strategic);
  assert.deepEqual(team(renderJ2Team(US_ARMY)).members.map((entry) => entry.name), expected.brigade, 'tactical defaults to brigade');
  assert.deepEqual(team(renderJ2Team(US_ARMY, { echelon: 'battalion' })).members.map((entry) => entry.name), expected.battalion);
  // The variant follows the level; a roster cannot be rendered for a level it is not written for.
  assert.equal(j2VariantFor(US_JOINT, 'battalion'), 'operational', 'the echelon only matters at tactical level');
  assert.throws(() => j2Vocabulary(US_JOINT, 'brigade'), /not written for the operational level/);
  assert.throws(() => j2Vocabulary(US_ARMY, 'operational'), /not written for the tactical level/);
  // The strategic warning analyst replaces the watch; the tactical integrator is the s2-lead, and reports-to lines name members on the roster.
  for (const variant of J2_VARIANTS) {
    const names = new Set(J2_ROSTERS[variant].map((spec) => spec.name));
    for (const spec of J2_ROSTERS[variant]) { const boss = spec.reportsTo?.(variant); if (boss) assert.ok(names.has(boss), `${variant}/${spec.name} reports to ${boss}`); }
  }
});

test('every product has exactly one owner on its roster, the staff block lists them, and the owner\'s instructions carry its place and headings', () => {
  for (const rendering of RENDERINGS) {
    const v = j2Vocabulary(rendering.settings, j2VariantFor(rendering.settings, rendering.echelon));
    const text = renderJ2Team(rendering.settings, rendering.echelon ? { echelon: rendering.echelon } : {});
    const parsed = team(text);
    const names = parsed.members.map((entry) => entry.name);
    for (const product of variantProducts(v.variant)) {
      const owner = product.owners[v.variant]!;
      assert.ok(names.includes(owner), `${rendering.key}: ${product.id} is owned by ${owner}, who is on the roster`);
      const instructions = member(text, owner).instructions;
      assert.ok(instructions.includes(`- ${product.title(v)}, ${productPath(product)}.`), `${owner} lists ${product.id}`);
      if (product.headings(v).length) assert.ok(instructions.includes(`Headings, in this order: ${product.headings(v).join('; ')}.`), `${owner} carries the headings of ${product.id}`);
      for (const other of names.filter((name) => name !== owner)) assert.ok(!member(text, other).instructions.includes(`, ${productPath(product)}.`), `${other} does not also own ${product.id}`);
    }
    for (const entry of parsed.members) assert.ok(productsOwnedBy(entry.name, v.variant).length > 0, `${rendering.key}: ${entry.name} owns at least one product`);
    assert.deepEqual([...parsed.staff!.products, ...parsed.staff!.layers].sort(), variantProducts(v.variant).map((product) => product.id).sort());
    assert.equal(parsed.staff!.section, 'j2');
    assert.equal(parsed.staff!.profile, rendering.settings.profile);
    assert.equal(parsed.staff!.level, rendering.settings.level);
  }
  assert.equal(new Set(J2_PRODUCTS.map((product) => product.id)).size, J2_PRODUCTS.length, 'product ids are unique');
  // The design's products (3.2): the estimate and annex, the INTSUM and the release-guard report each have an owner at operational level.
  assert.equal(J2_PRODUCTS.find((product) => product.id === 'intelligence-estimate')!.owners.operational, 'j2-chief');
  assert.equal(J2_PRODUCTS.find((product) => product.id === 'intsum')!.owners.operational, 'watch-officer');
  assert.equal(J2_PRODUCTS.find((product) => product.id === 'guard-report')!.owners.battalion, 'release-guard');
});

test('a member\'s output is checked for its required headings: all present passes, a missing one is named, table columns count', () => {
  const v = j2Vocabulary(US_JOINT);
  const estimate = J2_PRODUCTS.find((product) => product.id === 'intelligence-estimate')!;
  const full = estimate.headings(v).map((heading, index) => `## ${index + 1}. ${heading}\n\nText.\n`).join('\n');
  assert.deepEqual(missingHeadings(estimate, v, full), []);
  assert.deepEqual(missingHeadings(estimate, v, full.replace('## 6. Key judgements', '## 6. Main points')), ['Key judgements']);
  const intsum = J2_PRODUCTS.find((product) => product.id === 'intsum')!;
  assert.deepEqual(missingHeadings(intsum, v, '# INTSUM 004\n### Period\n### Significant activity\n### Assessment of intent\n### Gaps\n'), ['Changes since the last INTSUM']);
  const register = J2_PRODUCTS.find((product) => product.id === 'pir-register')!;
  assert.deepEqual(missingHeadings(register, v, '| Requirement | Decision point supported | Indicators | Specific information requirements | Latest time of value | Status |\n|---|---|---|---|---|---|\n'), []);
  // Headings follow the vocabulary: the tactical estimate speaks of the threat, the joint one of the adversary.
  assert.ok(estimate.headings(j2Vocabulary(US_ARMY)).includes('Threat courses of action in order of probability'));
  assert.ok(estimate.headings(v).includes('Adversary courses of action in order of probability'));
});

test('the words follow the profile: JIPOE, IPOE or IPB, Annex B or D, the staff code, the process, requirements management and the planning lead', () => {
  const joint = renderJ2Team(US_JOINT);
  const army = renderJ2Team(US_ARMY);
  const canadian = renderJ2Team(NATO_CA);
  const nato = renderJ2Team(NATO);
  // JIPOE at joint levels; at tactical level IPOE under US Army (FM 5-0, 2024; ADP 2-0, 2026) and IPB under NATO/Canadian; OAKOC only at tactical level.
  for (const text of [joint, canadian, nato, renderJ2Team(settings({ level: 'strategic' }))]) { assert.match(text, /\bJIPOE\b/); assert.doesNotMatch(text, /\bIPB\b|\bIPOE\b|OAKOC/); }
  for (const text of [army, renderJ2Team(US_ARMY, { echelon: 'battalion' })]) { assert.match(text, /\bIPOE\b/); assert.doesNotMatch(text, /\bJIPOE\b|JIPB|\bIPB\b/); }
  { const text = renderJ2Team(settings({ profile: 'nato-ca', level: 'tactical', nation: 'ca' })); assert.match(text, /\bIPB\b/); assert.doesNotMatch(text, /\bJIPOE\b|JIPB|\bIPOE\b/); }
  // NATO JIPOE has three steps on the operating environment (AJP-10.1, 2023): the jipoe-analyst does step 1, the threat-analyst steps 2 and 3.
  for (const text of [canadian, nato]) {
    assert.match(member(text, 'jipoe-analyst').instructions, /^Job: You do JIPOE step 1: describe and evaluate the operating environment\. Set the limits of the operating environment:/m);
    assert.match(member(text, 'threat-analyst').instructions, /^Job: You do JIPOE steps 2 and 3: evaluate actors in the operating environment, and determine actor courses of action\./m);
    assert.match(text, /JIPOE step 3 \(adversary course of action set\)/);
    assert.doesNotMatch(text, /JIPOE steps? 4|steps 3 and 4/);
  }
  assert.match(member(joint, 'jipoe-analyst').instructions, /^Job: You do JIPOE steps 1 and 2: define the operational environment and describe the impact of the operational environment\./m);
  // The US Army intelligence process: six steps, no continuing activities (ADP 2-0, 2026).
  assert.doesNotMatch(army, /throughout\)|analyze and assess/i);
  // The annex letter from the profile: B under US Joint and US Army, D under NATO/Canadian; the joint estimate as appendix 11 to annex B.
  assert.match(member(joint, 'j2-chief').instructions, /The intelligence annex is Annex B \(Intelligence\), and the intelligence estimate goes in as Appendix 11 to Annex B/);
  assert.match(member(army, 's2-lead').instructions, /The intelligence annex is Annex B \(Intelligence\)\./);
  assert.match(member(canadian, 'j2-chief').instructions, /The intelligence annex is Annex D \(Intelligence\)\..*appendices such as the threat assessment, CCIRM/s);
  assert.doesNotMatch(canadian, /Annex B/);
  // Staff codes: J-2 joint, J2 NATO, S-2 for an Army brigade, G2 for a Canadian brigade, S2 for a NATO battalion.
  assert.match(joint, /^name: J-2 Intelligence \(operational\)$/m);
  assert.match(canadian, /^name: J2 Intelligence \(operational\)$/m);
  assert.match(army, /^name: S-2 Intelligence \(brigade\)$/m);
  assert.match(renderJ2Team(settings({ profile: 'nato-ca', level: 'tactical', nation: 'ca' })), /^name: G2 Intelligence \(brigade\)$/m);
  assert.match(renderJ2Team(settings({ profile: 'nato-ca', level: 'tactical', nation: 'nato' }), { echelon: 'battalion' }), /^name: S2 Intelligence \(battalion\)$/m);
  // The intelligence process and requirements management per profile and nation.
  assert.match(member(joint, 'j2-chief').instructions, /joint intelligence process \(planning and direction; collection; processing and exploitation; analysis and production; dissemination and integration; evaluation and feedback\)/);
  assert.match(member(army, 's2-lead').instructions, /intelligence process \(plan and direct; collect; process and exploit; analyze and produce; disseminate and integrate; evaluate and provide feedback\)/);
  assert.match(member(canadian, 'j2-chief').instructions, /intelligence cycle \(direction; collection; processing; dissemination\)/);
  assert.match(member(joint, 'requirements-manager').instructions, /CRM and COM/);
  assert.match(member(canadian, 'requirements-manager').instructions, /requirements management for the section: CCIRM/);
  assert.match(member(nato, 'requirements-manager').instructions, /IRM and CM, formerly CCIRM/);
  assert.match(member(army, 'collection-manager').instructions, /information collection plan/);
  // The planning lead: the J-5, the J-3 in a crisis, the S-3 plans cell at brigade, the S-3 at battalion.
  assert.match(member(joint, 'j2-chief').instructions, /the J-5's tasking/);
  assert.match(member(renderJ2Team(settings({ planningType: 'crisis' })), 'j2-chief').instructions, /the J-3's tasking/);
  assert.match(member(army, 's2-lead').instructions, /the S-3 plans cell's tasking/);
  assert.match(member(renderJ2Team(US_ARMY, { echelon: 'battalion' }), 's2-lead').instructions, /the S-3's tasking/);
  // What units below staff level plan with, and the Canadian strategic requirements.
  assert.match(member(army, 'watch-officer').instructions, /troop leading procedures/);
  assert.match(member(renderJ2Team(settings({ profile: 'nato-ca', level: 'tactical', nation: 'ca' })), 'watch-officer').instructions, /battle procedure/);
  const canadianStrategic = renderJ2Team(settings({ profile: 'nato-ca', level: 'strategic', nation: 'ca' }));
  assert.match(member(canadianStrategic, 'j2-chief').instructions, /CDS critical intelligence requirements[\s\S]*statement of the intelligence problem/);
  assert.match(member(canadianStrategic, 'warning-analyst').instructions, /CDS critical intelligence requirement/);
  assert.doesNotMatch(renderJ2Team(settings({ profile: 'nato-ca', level: 'strategic', nation: 'nato' })), /CDS/);
  // Spelling follows the profile: centre under NATO/Canadian, center under the US profiles.
  assert.match(canadian, /centre of gravity/);
  assert.match(joint, /center of gravity/);
  // Every step name in the guidance is the profile's own.
  for (const rendering of RENDERINGS) {
    const guidance = j2Guidance(rendering.settings, rendering.echelon ? { echelon: rendering.echelon } : {});
    for (const step of CROSSWALK_STEPS) {
      const name = stepName(rendering.settings.profile, rendering.settings.level, step);
      if (name) assert.ok(guidance.includes(`| ${step} ${name} |`), `${rendering.key}: step ${step} is "${name}"`);
    }
    assert.deepEqual(j2WorkflowSteps(rendering.settings, rendering.echelon), [...CROSSWALK_STEPS]);
  }
});

test('every member has the preamble, a doctrinal job, a boundary, a no-decide rule, its hand-back and a definition of done', () => {
  const boundaries: Record<string, RegExp> = {
    'j2-chief': /^Boundary: Your output is the estimate and the annex, not the PIRs' approval and not collection tasking\.$/m,
    's2-lead': /^Boundary: Your output is the estimate and the annex, not the PIRs' approval and not collection tasking\.$/m,
    'requirements-manager': /^Boundary: Your output is the register, not a PIR the commander has approved\.$/m,
    'collection-manager': /^Boundary: Your output is a recommendation; the [JGS]-?3 approves asset allocation and you never task assets\.$/m,
    'jipoe-analyst': /^Boundary: Your output is steps 1 and 2, not adversary courses of action\.$/m,
    'geoint-analyst': /^Boundary: Your output is terrain and weather analysis, not threat assessment\.$/m,
    'osint-analyst': /^Boundary: Your output is graded source material, not finished analysis\.$/m,
    'threat-analyst': /^Boundary: Your output is the adversary's options, not friendly courses of action and not targeting decisions\.$/m,
    'watch-officer': /^Boundary: Your output is facts and short assessments with likelihood terms, not new estimates\.$/m,
    'warning-analyst': /^Boundary: Your output is warning: [^\n]*; not policy advice and not the response\.$/m,
    'target-analyst': /^Boundary: Your output is intelligence on notional target systems in a fictional scenario, never a named real person or place and never an engagement recommendation\.$/m,
    'red-cell': /^Boundary: Your output is the adversary's play, not an independent critique of the plan \(that is the red team\)\.$/m,
    'ipb-analyst': /^Boundary: Your output is the (?:IPOE|IPB) products, not friendly courses of action and not targeting decisions\.$/m,
    'tradecraft-reviewer': /^Boundary: You check; you never rewrite another member's judgement\.$/m,
    'release-guard': /^Boundary: You advise; a person releases\. Your output is a verdict and reasons; you never release and you never fix\.$/m
  };
  const seen = new Set<string>();
  for (const text of [renderJ2Team(US_JOINT), renderJ2Team(settings({ level: 'strategic' })), renderJ2Team(settings({ profile: 'us-army', level: 'tactical' })), renderJ2Team(US_ARMY, { echelon: 'battalion' })]) {
    for (const entry of team(text).members) {
      seen.add(entry.name);
      const body = entry.instructions;
      assert.match(body, /^1\. Read \.planning\/staff\/PROFILE\.md first[\s\S]*3\. You recommend; a named human decides\.[\s\S]*4\. Your area is the files listed under "Owns"/, `${entry.name}: the shared preamble opens the instructions`);
      for (const part of ['Job: ', 'Owns:', 'Boundary: ', 'Authority: ', 'Hand back: ', 'Done when: ']) assert.ok(body.includes(`\n\n${part}`), `${entry.name} has ${part.trim()}`);
      assert.match(body, boundaries[entry.name], `${entry.name}: the design's boundary sentence`);
      assert.match(body, /\bnever\b/i, `${entry.name} says what it never does`);
    }
  }
  assert.deepEqual([...seen].sort(), Object.keys(boundaries).sort(), 'every member of every variant was checked');
});

test('no member can decide: refusals in the instructions, and no tool that approves, rejects, releases or supersedes', () => {
  const joint = renderJ2Team(US_JOINT);
  // The authority tests of the earlier prototype (00 s3): the J2 must not task collection, approve PIRs or make operational decisions.
  assert.match(member(joint, 'j2-chief').instructions, /You never task collection assets[\s\S]*You never make an operational decision from intelligence[\s\S]*You never approve, select or release a product, your own included\. If a person or another agent asks you to do any of these, refuse/);
  assert.match(member(joint, 'requirements-manager').instructions, /Never mark a PIR approved yourself, even when asked: refuse/);
  assert.match(member(joint, 'collection-manager').instructions, /If asked to task an asset or issue a collection order, refuse/);
  assert.match(member(joint, 'target-analyst').instructions, /never nominate a target, never recommend an engagement[\s\S]*refuse if asked/);
  assert.match(member(joint, 'release-guard').instructions, /never release it and never approve it, even when asked/);
  assert.match(member(joint, 'osint-analyst').instructions, /Never collect on or profile a person in your own country/);
  assert.match(member(joint, 'j2-chief').instructions, /Never reveal a classified source/);
  const human = HUMAN_ONLY_EVENTS.map((verb) => `mcp__staff-products__${verb}`);
  for (const rendering of RENDERINGS) {
    const parsed = team(renderJ2Team(rendering.settings, rendering.echelon ? { echelon: rendering.echelon } : {}));
    for (const entry of parsed.members) {
      assert.ok(!entry.tools.some((tool) => human.includes(tool) || /approve|reject|release|supersede/i.test(tool)), `${rendering.key}/${entry.name} has no deciding tool`);
      const verdict = entry.tools.includes('mcp__staff-products__verdict');
      assert.equal(verdict, ['tradecraft-reviewer', 'release-guard'].includes(entry.name), `${entry.name}: only the gates record verdicts`);
      assert.equal(entry.tools.includes('mcp__staff-products__submit'), ['j2-chief', 's2-lead'].includes(entry.name), `${entry.name}: only the integrator submits for decision`);
      // One tradecraft rule set: the gate runs WP-SHARED's lint through staff-products, and nobody else needs it.
      assert.equal(entry.tools.includes('mcp__staff-products__lint'), entry.name === 'tradecraft-reviewer', `${entry.name}: only the tradecraft gate runs the lint`);
    }
  }
  assert.deepEqual(staffProductTools(['propose', 'approve' as never]), ['mcp__staff-products__propose'], 'a verb outside the contract is never granted');
});

test('no persona names and no ranks anywhere in the template, its guidance or its skills', () => {
  const RANKS = /\b(?:lieutenant|captain|colonel|brigadier|admiral|commodore|sergeant|corporal|warrant officer|lt\.?-?col|lcol|bgen|mgen|capt|maj|sgt|cpl)\b|\b(?:Major|General|Private) [A-Z][a-z]+/i;
  const PERSONA = /\b(?:my name is|you are called|call me|named [A-Z][a-z]+)\b/;
  const roles = new Set(Object.values(J2_ROSTERS).flatMap((roster) => roster.map((spec) => spec.name)));
  for (const rendering of RENDERINGS) {
    const output = j2Template(rendering.settings, rendering.echelon ? { echelon: rendering.echelon } : {});
    for (const text of [output.team, output.guidance, ...output.files.map((file) => file.content)]) {
      const scrubbed = text.replace(/privacy: private/g, '').replace(/\b(?:major|general|private) (?:analytic|military|model|models|hardware)\b/gi, '');
      assert.doesNotMatch(scrubbed, RANKS, `${rendering.key}: no rank`);
      assert.doesNotMatch(text, PERSONA, `${rendering.key}: no persona`);
    }
    for (const entry of team(output.team).members) {
      assert.ok(roles.has(entry.name), `${entry.name} is a role slug`);
      assert.match(entry.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  }
});

test('the team is private by default: the team line and every member line, so every member runs on a private model', () => {
  for (const rendering of RENDERINGS) {
    const text = renderJ2Team(rendering.settings, rendering.echelon ? { echelon: rendering.echelon } : {});
    const parsed = team(text);
    assert.match(text, /^privacy: private$/m);
    assert.equal(parsed.private, true);
    assert.ok(parsed.members.every((entry) => entry.privacy === 'private'), `${rendering.key}: every member is private`);
    assert.ok(teamIsPrivate(parsed));
  }
});

test('the project guidance: the rules, the workflow per step, the handoffs, its own markers, and the skills it points to', () => {
  const guidance = j2Guidance(US_JOINT);
  assert.ok(guidance.includes(LABELS_NOT_ACCREDITATION_TEXT));
  assert.ok(guidance.includes(CLEARANCE_SELF_ASSERTED_TEXT));
  assert.match(guidance, /\*\*Exercise data only\.\*\*[^\n]*accredited systems/);
  assert.match(guidance, /\*\*People decide\.\*\*[^\n]*The commander approves PIRs; the J-3 approves the allocation of collection assets/);
  assert.match(guidance, /\*\*Gates, in this order\.\*\*[^\n]*SIGN-OFF, then the release-guard's CLEARED[^\n]*approval is not a tool/);
  assert.match(guidance, /\| 2 Mission analysis \| jipoe-analyst ‖ geoint-analyst[^\n]*\| j2-chief: mission analysis input/);
  assert.match(guidance, /\| 6 COA approval \| None: a person decides \|/);
  assert.match(guidance, /icd203-standards\.md[\s\S]*source-grading\.md/);
  assert.match(j2Guidance(settings({ planningType: 'crisis' })), /steps may also run at the same time/);
  // The block sits between its own markers, beside any project-type block, and replaces itself when written again.
  const existing = '# Our rules\n\nUse tabs.\n\n<!-- near-ai:project-type:start -->\nX\n<!-- near-ai:project-type:end -->\n';
  const once = withJ2Guidance(existing, US_JOINT);
  const twice = withJ2Guidance(once, NATO_CA);
  assert.ok(once.startsWith(existing.trimEnd()));
  assert.equal(twice.match(/near-ai:staff-section:j2-intelligence:start/g)?.length, 1);
  assert.match(twice, /<!-- near-ai:project-type:start -->\nX\n<!-- near-ai:project-type:end -->/);
  assert.match(twice, /Staff section: J2 intelligence \(operational\)/);
  assert.doesNotMatch(twice, /J-2 intelligence/);
  assert.match(withJ2Guidance('', US_JOINT), /^# Agent instructions\n\n<!-- near-ai:staff-section:j2-intelligence:start -->/);
});

test('the two skills: the ICD 203 scale and the separate-sentence rule; reliability and credibility graded separately, grade 1 per profile', () => {
  const icd = icd203Skill();
  for (const entry of ICD203_LIKELIHOOD) assert.ok(icd.includes(`| ${entry.term} | ${entry.alternative} | ${entry.range[0]} to ${entry.range[1]} percent |`), entry.term);
  assert.match(icd, /Never put a likelihood term and a confidence level in the same sentence/);
  assert.match(icd, /The five analytic standards[\s\S]*The nine analytic tradecraft standards/);
  const nato = sourceGradingSkill('nato-ca');
  const us = sourceGradingSkill('us-joint');
  assert.match(nato, /two separate scales[\s\S]*Judge them independently/);
  // NATO grade 1 is "Confirmed by other sources" (never "Completely credible"); the US Army table labels it "Confirmed".
  assert.match(nato, /\| 1 \| Confirmed by other sources \|[\s\S]*Grade 1 means an independent source confirms the item/);
  assert.doesNotMatch(nato, /completely credible/i);
  assert.match(us, /\| 1 \| Confirmed by other sources \|/);
  assert.match(sourceGradingSkill('us-army'), /\| 1 \| Confirmed \|\n\| 2 \| Probably true \|/);
  assert.match(us, /\| A \| Completely reliable \|[\s\S]*\| F \| Reliability cannot be judged \|[\s\S]*\| 6 \| Truth cannot be judged \|/);
  assert.match(us, /Reports that share an origin are one report/);
  const files = j2Template(NATO_CA).files.map((file) => file.path);
  assert.deepEqual(files, ['.planning/staff/PROFILE.md', '.planning/staff/skills/icd203-standards.md', '.planning/staff/skills/source-grading.md']);
  assert.match(j2Template(NATO_CA).files[0].content, /Annex D \(Intelligence\)/);
});

test('a staff template cannot change without a new template version', () => {
  for (const template of STAFF_TEMPLATES) {
    const history = TEMPLATE_HISTORY[template.id];
    assert.ok(history?.length, `${template.id} has a template history`);
    const current = staffTemplateSnapshot(template);
    const latest = history[history.length - 1];
    assert.equal(latest.definition, current.definition, `${template.id} changed: run "npm run compile && node scripts/template-history.mjs" to record template v${latest.version + 1}`);
    assert.deepEqual(history.map((version) => version.version), history.map((_, index) => index + 1));
    for (const [name, prints] of Object.entries(current.members)) for (const print of prints) assert.ok(latest.members[name]?.includes(print), `${template.id}/${name}`);
    for (const print of current.guidance) assert.ok(latest.guidance.includes(print));
  }
  assert.equal(staffTemplateSnapshot(STAFF_TEMPLATES[0]).definition, staffTemplateSnapshot(STAFF_TEMPLATES[0]).definition, 'renderings are deterministic');
});

test('a staff template version keeps every fingerprint main recorded for it before drop 2, so a team made from that build still reads as unchanged', () => {
  // Drop 1 was never released, so drop 2 kept j2-intelligence and j5-plans at v1; scripts/template-history.mjs --keep-from 94b9909 merged the
  // fingerprints main had at that commit into v1 rather than replacing them. The fixture is that commit's history for the staff templates.
  const fixture = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'test', 'fixtures', 'template-history', 'staff-before-drop2.json'), 'utf8')) as { templates: Record<string, Array<{ version: number; guidance: string[]; members: Record<string, string[]> }>> };
  assert.deepEqual(Object.keys(fixture.templates).sort(), ['j2-intelligence', 'j5-plans']);
  for (const [id, versions] of Object.entries(fixture.templates)) {
    for (const old of versions) {
      const kept = TEMPLATE_HISTORY[id]?.find((version) => version.version === old.version);
      assert.ok(kept, `${id} v${old.version} is still in the history`);
      for (const print of old.guidance) assert.ok(kept.guidance.includes(print), `${id} v${old.version} guidance ${print}`);
      for (const [name, prints] of Object.entries(old.members)) for (const print of prints) assert.ok(kept.members[name]?.includes(print), `${id} v${old.version} ${name} ${print}`);
    }
  }
});

test('the staff template sources and renderings carry no em-dash, no provisional or preview marker, and spell no doctrine term of their own', () => {
  const terms = new Set<string>();
  for (const process of Object.values(STAFF_PROCESSES)) for (const step of CROSSWALK_STEPS) { const entry = process.steps[step]; if (entry.kind === 'step') terms.add(entry.name); }
  for (const profile of Object.values(DOCTRINE_PROFILES)) {
    for (const name of profile.coaTests) terms.add(name);
    for (const subject of ANNEX_SUBJECTS) { const placement = profile.annexes[subject]; if (placement.kind === 'annex') terms.add(placement.title); }
  }
  const multiWord = [...terms].filter((term) => term.includes(' '));
  for (const file of readdirSync(STAFF_SRC).filter((name) => name.endsWith('.ts'))) {
    const text = readFileSync(path.join(STAFF_SRC, file), 'utf8');
    assert.ok(!text.includes(String.fromCharCode(0x2014)), `${file} has an em-dash`);
    assert.ok(!/provisional|preview/i.test(text), `${file} has a provisional or preview marker`);
    for (const term of multiWord) assert.ok(!text.includes(`'${term}'`), `${file} spells "${term}"; it belongs in doctrine.ts`);
  }
  for (const rendering of STAFF_TEMPLATES[0].renderings().filter((_, index) => index % 7 === 0)) {
    for (const text of [rendering.team, rendering.guidance, ...rendering.files.map((file) => file.content)]) {
      assert.ok(!text.includes(String.fromCharCode(0x2014)), `${rendering.key} has an em-dash`);
      assert.doesNotMatch(text, /provisional|preview|NEAR organization/i);
    }
  }
});
