// The J5 plans team template (design 10, 3.3; WP-J5): every variant parses and passes the local team check with no findings, stays within 12 members
// with a release guard, gives every product exactly one owner (and the shared ones to the owner the staff contract names), opens every member with the
// shared preamble and ends it with a boundary and a deliverable, runs two COA owners in parallel with distinct themes and areas and one integrator after
// them, applies each profile's COA tests, hands the lead to the J3 in crisis planning, offers MDO only under US Army and the red-team switch only under
// NATO/Canadian, and keeps the red team out of every plan file at the tool level.
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkTeam, MAX_INSTRUCTION_WORDS, similarity } from '../agent/teamCheck';
import { memberFingerprint, definitionHash, guidanceFingerprint } from '../agent/teamFingerprints';
import { draftFromMarkdown, splitTeam } from '../agent/teamMarkdown';
import { TEMPLATE_HISTORY } from '../agent/teamTemplateHistory';
import { parseTeam, teamAgents } from '../agent/teams';
import { j5Guidance, j5OptionSets, j5Template, J5TemplateError, J5_SKILLS, renderJ5Team, skillPath } from '../agent/staff/j5Plans';
import type { J5TemplateOptions } from '../agent/staff/j5Plans';
import { j5SkillText, j5TemplateFiles } from '../agent/staff/j5Skills';
import { STAFF_TEMPLATES } from '../agent/staff/templates';
import { DOCTRINE_PROFILES, PLANNING_TYPE_RULES, RETIRED_SPACE_TERMS } from '../domain/staff/doctrine';
import { writerOf } from '../domain/staff/ownership';
import { staffPreambleText } from '../domain/staff/products';
import { defaultStaffSettings, retiredSpaceTerms } from '../domain/staff/profiles';
import type { StaffSettings } from '../domain/staff/profiles';
import { RED_TEAM_PRODUCT, STAFF_GUARD_FOLDER, staffProductPath, staffWriteLimit } from '../domain/staff/writeLimits';

const settings = (extra: Partial<StaffSettings> = {}): StaffSettings => ({ ...defaultStaffSettings(), ...extra });
const ALL = j5OptionSets();
const LOCALITIES = ['cloud', 'local'] as const;
const label = (options: J5TemplateOptions) => `${options.settings.profile}/${options.settings.level}${options.settings.nation ? `/${options.settings.nation}` : ''}/${options.settings.planningType}/${options.variant ?? 'standard'}${options.redTeam === false ? '/no-red-team' : ''}${options.locality ? `/${options.locality}` : ''}`;
const ownsLine = (instructions: string) => /^Owns: (.*)$/m.exec(instructions)?.[1] ?? '';
const CRITIQUE = staffProductPath('j5', RED_TEAM_PRODUCT);

test('every variant parses, has at most 12 members with a release guard, is private, and carries its staff block', () => {
  assert.ok(ALL.length >= 40, 'every profile, level, nation, planning type and variant is covered');
  for (const locality of LOCALITIES) {
    for (const options of ALL) {
      const text = renderJ5Team({ ...options, locality });
      const team = parseTeam(text, 'team.md');
      const name = label({ ...options, locality });
      assert.ok(team.members.length <= 12, `${name}: ${team.members.length} members`);
      assert.ok(team.members.some((member) => member.name === 'release-guard'), `${name}: the guard is never dropped`);
      assert.equal(team.private, true, `${name}: private by default`);
      assert.ok(team.members.every((member) => member.privacy === 'private'), `${name}: every member private`);
      assert.equal(team.staff?.section, 'j5');
      assert.equal(team.staff?.profile, options.settings.profile);
      assert.equal(team.staff?.level, options.settings.level);
      assert.deepEqual(team.staff?.layers, ['cop-plans-layer']);
      if (locality === 'local') assert.ok(team.members.every((member) => !member.tools.some((tool) => /^Web|CheckCitations/.test(tool))), `${name}: no web tools offline`);
    }
  }
});

test('the local team check finds nothing in any variant: no warnings and no parallel-work advice', () => {
  for (const locality of LOCALITIES) {
    for (const options of ALL) {
      const text = renderJ5Team({ ...options, locality });
      const findings = checkTeam(draftFromMarkdown(text, 'team.md'));
      assert.deepEqual(findings.map((finding) => `${finding.id}: ${finding.message}`), [], label({ ...options, locality }));
    }
  }
});

test('every product has exactly one owner, named in that member\'s Owns line and nobody else\'s, and shared products go to the contract\'s writer', () => {
  for (const options of ALL) {
    const template = j5Template(options);
    const name = label(options);
    const names = template.members.map((member) => member.name);
    const products = template.products.map((product) => product.product);
    assert.equal(new Set(products).size, products.length, `${name}: no product listed twice`);
    assert.deepEqual([...template.block.products], products, `${name}: the staff block lists the products`);
    for (const product of template.products) {
      assert.ok(names.includes(product.owner), `${name}: ${product.product} is owned by a member`);
      const holders = template.members.filter((member) => ownsLine(member.instructions).split(', ').some((entry) => entry.replace(/\.$/, '') === staffProductPath('j5', product.product) || entry.includes(`(${product.product}:`)));
      assert.deepEqual(holders.map((member) => member.name), [product.owner], `${name}: ${product.product} appears in exactly its owner's Owns line`);
      const shared = (() => { try { return writerOf(product.product, { phase: 'planning', mode: 'standalone' }); } catch { return undefined; } })();
      if (shared?.section === 'j5') assert.equal(shared.member, product.owner, `${name}: ${product.product} goes to the contract's writer`);
    }
    for (const member of template.members) assert.ok(ownsLine(member.instructions), `${name}: ${member.name} says what it owns`);
  }
});

test('every member opens with the shared preamble and ends with a boundary and what it hands back, within the length limit, with no persona or rank', () => {
  const ranks = /\b(?:General|Colonel|Lieutenant|Captain|Major|Sergeant|Admiral|Brigadier|Corporal|Private First)\b/;
  for (const options of ALL) {
    for (const member of j5Template(options).members) {
      const where = `${label(options)} ${member.name}`;
      assert.ok(member.instructions.startsWith(staffPreambleText()), `${where}: preamble first`);
      assert.match(member.instructions, /\nBoundary: "[^"]+"/, `${where}: boundary sentence`);
      assert.match(member.instructions, /\n(?:Hands back|Return): /, `${where}: deliverable`);
      const words = (member.instructions.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((word) => word.length > 2).length;
      assert.ok(words < MAX_INSTRUCTION_WORDS, `${where}: ${words} words`);
      assert.doesNotMatch(`${member.role}\n${member.instructions}`, ranks, `${where}: no rank`);
      assert.doesNotMatch(member.instructions, /^##\s/m, `${where}: no line that would start a new member`);
      assert.deepEqual(retiredSpaceTerms(member.instructions), [], `${where}: no retired space term`);
    }
  }
});

test('members never claim a decision: "selected", "approved" and "released" appear only as prohibitions or as a person\'s act', () => {
  for (const options of ALL) {
    for (const member of j5Template(options).members) {
      for (const sentence of member.instructions.split(/(?<=[.!?])\s+|\n+/)) {
        if (!/\b(?:selected|approved|released|selects|approves)\b/i.test(sentence)) continue;
        assert.match(sentence, /\b(?:never|not|no|nothing)\b|"|the commander approved|approved by the higher commander|is approved by/i, `${label(options)} ${member.name}: "${sentence}"`);
      }
    }
  }
});

test('two COA owners work in parallel with distinct themes and separate files, and the lead-planner alone integrates them after', () => {
  for (const options of ALL) {
    const template = j5Template(options);
    const name = label(options);
    const owners = template.variant === 'mdo' ? ['coa-cell-a', 'convergence-planner'] : ['coa-cell-a', 'coa-cell-b'];
    const [a, b] = owners.map((owner) => template.members.find((member) => member.name === owner)!);
    assert.ok(a && b, `${name}: both COA owners exist`);
    assert.notEqual(a.role, b.role);
    assert.ok(similarity(a.instructions, b.instructions) < 0.6, `${name}: the two COA owners' instructions are distinct`);
    const filesA = ownsLine(a.instructions).split(', '); const filesB = ownsLine(b.instructions).split(', ');
    assert.ok(filesA.every((file) => !filesB.includes(file)), `${name}: no file in both areas`);
    assert.match(a.instructions, /coa-themes/); assert.match(b.instructions, /coa-themes/);
    if (template.variant === 'standard') { assert.match(a.instructions, /direct approach/); assert.match(b.instructions, /indirect/); }
    const step3 = template.workflow.find((step) => step.step === 3)!;
    assert.deepEqual(owners.filter((owner) => step3.parallel.some((lane) => lane.member === owner)), owners, `${name}: both start in the same turn`);
    assert.equal(step3.merge?.member, 'lead-planner', `${name}: one integrator`);
    assert.ok(!step3.parallel.some((lane) => lane.member === 'lead-planner'), `${name}: the integrator is not a lane`);
    assert.ok(step3.mergeReads.includes('coa-a') && step3.mergeReads.includes('coa-b'), `${name}: the merge reads both COAs`);
    const tests = DOCTRINE_PROFILES[options.settings.profile].coaTests;
    assert.match(step3.merge!.does, new RegExp(tests.join(', ')), `${name}: the merge applies the profile's tests in order`);
    const lead = template.members.find((member) => member.name === 'lead-planner')!;
    assert.match(lead.instructions, /Start both COA owners and the red-cell-seat in the same turn/);
    assert.match(lead.instructions, /you alone integrate them/);
    // Every lane's member exists, every merge is the lead-planner's, and the wargame runs at the table in order, not as parallel lanes.
    for (const step of template.workflow) {
      for (const lane of [...step.parallel, ...step.sequence, ...step.alongside]) assert.ok(template.members.some((member) => member.name === lane.member), `${name}: step ${step.step} lane ${lane.member}`);
      if (step.merge) assert.equal(step.merge.member, 'lead-planner');
      for (const product of step.mergeReads) assert.ok(template.products.some((entry) => entry.product === product), `${name}: step ${step.step} merges ${product}`);
    }
    const step4 = template.workflow.find((step) => step.step === 4)!;
    assert.equal(step4.parallel.length, 0, `${name}: the wargame is not run as parallel lanes`);
    assert.ok(step4.sequence.length > 0);
    assert.equal(template.workflow.find((step) => step.step === 6)!.humanGate, true, `${name}: a person decides`);
  }
});

test('the red team is independent and can write nothing but its critique: no reports-to, no Edit or shell, and a write limit the runtime enforces', () => {
  for (const options of ALL.filter((entry) => entry.redTeam !== false)) {
    const team = parseTeam(renderJ5Team(options), 'team.md');
    const red = team.members.find((member) => member.name === 'red-team')!;
    assert.ok(red, label(options));
    assert.equal(red.reportsTo, undefined, 'it reports to the human chief of staff, not to a member');
    assert.ok(!red.tools.some((tool) => ['Edit', 'Bash', 'CreateDocument', 'CreatePdf', 'CreatePresentation', 'RenderSvg', 'Agent'].includes(tool)), `${label(options)}: ${red.tools.join(', ')}`);
    assert.match(red.instructions, /human chief of staff/);
    assert.match(red.instructions, /unedited/);
    const agents = teamAgents(team);
    assert.deepEqual(agents.find((agent) => agent.name === 'red-team')!.writeOnly, [CRITIQUE]);
    assert.deepEqual(agents.find((agent) => agent.name === 'release-guard')!.writeOnly, [STAFF_GUARD_FOLDER]);
    assert.ok(agents.filter((agent) => !['red-team', 'release-guard'].includes(agent.name)).every((agent) => agent.writeOnly === undefined), 'nobody else is limited');
  }
  assert.equal(staffWriteLimit(undefined, 'red-team'), undefined, 'a team with no staff block keeps its red team as it was');
});

test('each profile\'s COA tests reach the lead-planner and the skills; US Joint never tests "adequate" or says "military end state"', () => {
  for (const options of ALL) {
    const template = j5Template(options);
    const lead = template.members.find((member) => member.name === 'lead-planner')!;
    const tests = DOCTRINE_PROFILES[options.settings.profile].coaTests;
    const positions = tests.map((name) => lead.instructions.indexOf(`${name}: `));
    assert.ok(positions.every((position) => position >= 0), `${label(options)}: every test is named`);
    assert.deepEqual([...positions].sort((x, y) => x - y), positions, `${label(options)}: in the profile's order`);
    const skills = J5_SKILLS.map((skill) => j5SkillText(skill, options)).join('\n');
    for (const name of tests) assert.ok(skills.includes(name), `${label(options)}: the planning templates carry ${name}`);
    const everything = `${renderJ5Team(options)}\n${skills}\n${j5Guidance(options)}`;
    if (options.settings.profile === 'us-joint') {
      assert.doesNotMatch(everything, /\badequate\b/i);
      assert.doesNotMatch(everything, /military end state/i);
    }
    assert.deepEqual(retiredSpaceTerms(everything), []);
    assert.ok(!everything.includes(String.fromCharCode(0x2014)), 'no em-dash');
    assert.doesNotMatch(everything, /provisional|preview/i);
  }
  const army = j5Template({ settings: settings({ profile: 'us-army', level: 'tactical' }) });
  assert.match(army.members[0].instructions, /Feasible: .*Acceptable: .*Suitable: .*Distinguishable: .*Complete: /s);
  const nato = j5Template({ settings: settings({ profile: 'nato-ca', level: 'operational', nation: 'ca' }) });
  assert.match(nato.members[0].instructions, /Exclusivity: /);
  assert.match(j5SkillText('planning-templates', { settings: settings({ profile: 'nato-ca', level: 'operational', nation: 'ca' }) }), /Intelligence|intelligence \| Annex D \(Intelligence\)/);
});

test('crisis planning hands the lead to the J3 director; campaign and contingency planning keep the J5 director', () => {
  for (const options of ALL.filter((entry) => entry.settings.level !== 'tactical')) {
    const template = j5Template(options);
    const role = PLANNING_TYPE_RULES[options.settings.planningType].leadRole;
    assert.equal(template.block.humanLead, role, label(options));
    const lead = template.members.find((member) => member.name === 'lead-planner')!;
    assert.match(lead.instructions, new RegExp(`Staff planning is led by the ${role}`));
    if (options.settings.planningType === 'crisis') {
      assert.equal(role, 'J3 director');
      assert.match(lead.instructions, /This is crisis planning: steps may run at the same time/);
      assert.match(j5Guidance(options), /Crisis planning/);
    } else {
      assert.equal(role, 'J5 director');
      assert.doesNotMatch(lead.instructions, /crisis planning/);
    }
  }
  const tactical = j5Template({ settings: settings({ profile: 'us-army', level: 'tactical', planningType: 'crisis' }) });
  assert.equal(tactical.block.humanLead, 'G-3 or S-3 (operations officer)');
  assert.equal(j5Template({ settings: settings({ profile: 'us-army', level: 'tactical' }) }).block.humanLead, 'G-5 (division) or S-3 (brigade)');
});

test('the variants: MDO swaps COA cell B for a convergence planner under US Army only; the red team switches off only under NATO/Canadian', () => {
  const army = settings({ profile: 'us-army', level: 'tactical' });
  const mdo = j5Template({ settings: army, variant: 'mdo' });
  const names = mdo.members.map((member) => member.name);
  assert.ok(names.includes('convergence-planner') && !names.includes('coa-cell-b'));
  assert.equal(mdo.products.find((product) => product.product === 'coa-b')?.owner, 'convergence-planner');
  assert.equal(mdo.products.find((product) => product.product === 'convergence-matrix')?.owner, 'convergence-planner');
  assert.match(j5SkillText('wargame-ledger', { settings: army, variant: 'mdo' }), /one row per domain \(Air, Land, Maritime, Space, Cyberspace\)/);
  assert.throws(() => j5Template({ settings: settings(), variant: 'mdo' }), J5TemplateError);
  assert.throws(() => j5Template({ settings: settings({ profile: 'nato-ca', level: 'operational', nation: 'ca' }), variant: 'mdo' }), J5TemplateError);

  const nato = settings({ profile: 'nato-ca', level: 'operational', nation: 'nato' });
  const off = j5Template({ settings: nato, redTeam: false });
  assert.equal(off.members.length, 11);
  assert.ok(!off.members.some((member) => member.name === 'red-team'));
  assert.ok(!off.products.some((product) => product.product === RED_TEAM_PRODUCT));
  assert.match(j5Guidance({ settings: nato, redTeam: false }), /switched off in this project/);
  assert.match(j5Guidance({ settings: nato }), /UK national element/);
  assert.throws(() => j5Template({ settings: settings(), redTeam: false }), J5TemplateError);
  assert.throws(() => j5Template({ settings: army, redTeam: false }), J5TemplateError);
});

test('the level variants: strategic adds the strategic estimate and a component seat; tactical folds policy into the lead and adds fires, never "S-5"', () => {
  const strategic = j5Template({ settings: settings({ level: 'strategic' }) });
  const names = strategic.members.map((member) => member.name);
  assert.ok(names.includes('component-seat') && !names.includes('future-ops-seat'));
  assert.equal(strategic.products.find((product) => product.product === 'strategic-estimate')?.owner, 'policy-planner');
  assert.ok(strategic.products.some((product) => product.product === 'ipr-material'));
  assert.ok(!j5Template({ settings: settings() }).products.some((product) => product.product === 'strategic-estimate'), 'operational has no strategic estimate');

  for (const tacticalSettings of [settings({ profile: 'us-army', level: 'tactical' }), settings({ profile: 'nato-ca', level: 'tactical', nation: 'ca' })]) {
    const tactical = j5Template({ settings: tacticalSettings });
    const tacticalNames = tactical.members.map((member) => member.name);
    assert.ok(!tacticalNames.includes('policy-planner') && tacticalNames.includes('fires-seat'));
    assert.equal(tactical.products.find((product) => product.product === 'guidance-analysis')?.owner, 'lead-planner');
    assert.match(tactical.name, /^Plans cell/);
    const text = `${renderJ5Team({ settings: tacticalSettings })}\n${j5Guidance({ settings: tacticalSettings })}`;
    assert.doesNotMatch(text, /\bS-?5\b/);
    assert.match(tactical.members[0].instructions, /one-third, two-thirds rule/);
    const fires = tactical.members.find((member) => member.name === 'fires-seat')!;
    assert.match(fires.instructions, /LEGAL REVIEW REQUIRED/);
    assert.match(fires.instructions, /DECISION FOR: commander or delegate/);
  }
  assert.match(j5Template({ settings: settings({ profile: 'us-army', level: 'tactical' }) }).members.find((member) => member.name === 'fires-seat')!.instructions, /Annex D \(Fires\)/);
  assert.match(j5Template({ settings: settings({ profile: 'nato-ca', level: 'tactical', nation: 'ca' }) }).members.find((member) => member.name === 'fires-seat')!.instructions, /Part of Annex A/);
});

test('the template files: the team, PROFILE.md and the four skills, each at its path', () => {
  const files = j5TemplateFiles({ settings: settings() });
  assert.deepEqual(files.map((file) => file.path), ['.planning/.near-ai/team.md', '.planning/staff/PROFILE.md', ...J5_SKILLS.map(skillPath)]);
  assert.ok(files.every((file) => file.text.trim().length > 200));
  const byPath = Object.fromEntries(files.map((file) => [file.path, file.text]));
  assert.match(byPath[skillPath('assessment-framework')], /Annex N \(Assessments\)/);
  assert.match(byPath[skillPath('cog-analysis')], /Center of gravity analysis/);
  assert.match(j5SkillText('cog-analysis', { settings: settings({ profile: 'nato-ca', level: 'operational', nation: 'ca' }) }), /^# Centre of gravity analysis/);
  assert.match(byPath[skillPath('wargame-ledger')], /"phase":"action"/);
  assert.match(byPath[skillPath('planning-templates')], /\| Step \| Lanes \| Merge \(one integrator\) \| Gate \|/);
  for (const term of RETIRED_SPACE_TERMS) assert.ok(!files.some((file) => file.text.toLowerCase().includes(term)));
});

test('the J5 template cannot change without a new template version', () => {
  for (const template of STAFF_TEMPLATES) {
    const history = TEMPLATE_HISTORY[template.id];
    assert.ok(history?.length, `${template.id} has a template history`);
    assert.equal(history[history.length - 1].definition, definitionHash(template.definition()), `${template.id} changed: run "npm run compile && node scripts/template-history.mjs" to record template v${history[history.length - 1].version + 1}`);
    assert.deepEqual(history.map((version) => version.version), history.map((_, index) => index + 1));
    const latest = history[history.length - 1];
    for (const team of template.teams()) {
      for (const section of splitTeam(team).sections) assert.ok(latest.members[section.name]?.includes(memberFingerprint({ ...section, tools: section.tools ?? null })), `${template.id}/${section.name}`);
    }
    for (const guidance of template.guidance()) assert.ok(latest.guidance.includes(guidanceFingerprint(guidance)));
  }
  assert.ok(STAFF_TEMPLATES.some((template) => template.id === 'staff-j5-plans'));
});
