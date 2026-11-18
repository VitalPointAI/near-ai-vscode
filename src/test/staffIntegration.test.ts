// Drop 1 integration (design 10; WP-0, WP-SHARED, WP-INT, WP-DEMO, WP-J2, WP-J5 together): one template registry, one layout under .planning/staff/,
// one tradecraft rule set, the staff tools granted by role in both templates, one owner per shared product in every rendering, and one real-entity
// list that guard-scan and the scenario loader both hold to.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { RunCheckpoints } from '../agent/checkpoints';
import { intelToolName, intelWorkbenchTools } from '../agent/intelWorkbench';
import { J2_PRODUCTS } from '../agent/staff/j2Products';
import { j5OptionSets, j5Template } from '../agent/staff/j5Plans';
import { J2_STAFF_TEMPLATE, J5_STAFF_TEMPLATE, STAFF_TEMPLATES, staffTemplate, staffTemplateForSection } from '../agent/staff/templates';
import { WRITE_LIMITED_STAFF_TOOLS } from '../agent/staffTools';
import { parseTeam } from '../agent/teams';
import type { AgentTool, ToolContext } from '../agent/tools';
import { registerPath } from '../domain/staff/intel';
import { mergeRealEntities, parseRealEntityList, realEntitiesFromGuardConfig } from '../domain/staff/realEntities';
import { ACCEPTANCE_PRODUCTS } from '../domain/staff/acceptance';
import { SHARED_PRODUCTS, writerIn } from '../domain/staff/ownership';
import { HUMAN_ONLY_EVENTS } from '../domain/staff/release';
import { staffGuardFolder, staffProductPath } from '../domain/staff/writeLimits';
import { loadScenarioIntoProject, STARTER_SCENARIO_FILE } from '../services/staffScenarioLoader';
import { readRealEntities } from '../staff/realEntities';
import { productPath, SOURCES_FILE } from '../staff/staffHost';
import { callTool, CLEAN_BODY, J5_TEAM, staffWorld, writeBody } from './helpers/staffFixtures';

const members = (team: string) => parseTeam(team, '/p/team.md').members;

test('one staff template registry holds both sections, each with a distinct id, section, file and guidance markers', () => {
  assert.deepEqual(STAFF_TEMPLATES.map((template) => [template.id, template.section]), [['j2-intelligence', 'j2'], ['j5-plans', 'j5']]);
  assert.equal(staffTemplate('j5-plans'), J5_STAFF_TEMPLATE);
  assert.equal(staffTemplateForSection('j2'), J2_STAFF_TEMPLATE);
  assert.equal(staffTemplateForSection('j4'), undefined);
  for (const template of STAFF_TEMPLATES) {
    const renderings = template.renderings();
    assert.ok(renderings.length > 0);
    assert.equal(new Set(renderings.map((rendering) => rendering.key)).size, renderings.length, `${template.id}: rendering keys are unique`);
    for (const rendering of renderings.filter((_, index) => index % 11 === 0)) {
      const team = parseTeam(rendering.team, `/p/${template.file}.md`);
      assert.equal(team.staff?.section, template.section);
      assert.equal(team.staff?.glyph, template.glyph);
      assert.ok(rendering.files.some((file) => file.path === '.planning/staff/PROFILE.md'));
      assert.ok(rendering.files.every((file) => file.path.startsWith('.planning/staff/')), `${rendering.key}: every file under .planning/staff/`);
    }
  }
});

test('every product, report and register lives under .planning/staff/, and the tradecraft lint reads the workbench source register', () => {
  assert.equal(staffProductPath('j5', 'coa-a'), '.planning/staff/products/j5/coa-a.md');
  assert.equal(productPath('j2', 'intsum'), staffProductPath('j2', 'intsum'));
  assert.equal(staffGuardFolder('j2'), '.planning/staff/products/j2/guard/');
  assert.equal(registerPath('source-register'), '.planning/staff/products/j2/source-register.json');
  assert.equal(SOURCES_FILE, registerPath('source-register'));
  for (const product of J2_PRODUCTS) assert.match(staffProductPath('j2', product.id), /^\.planning\/staff\/products\/j2\//);
});

test('the tradecraft gate reads the source register the intel-workbench writes, in the workbench\'s own format', async () => {
  const world = await staffWorld();
  const root = world.root;
  const context = { root, signal: new AbortController().signal, checkpoints: new RunCheckpoints('intel', path.join(root, '.ckpt')), shell: {} as never, readFiles: new Set<string>(), agentLabel: 'osint-analyst' } as unknown as ToolContext;
  const tools = new Map(intelWorkbenchTools({ now: () => Date.UTC(2026, 10, 18, 12) }).map((tool) => [tool.name, tool] as const));
  const add = tools.get(intelToolName('source_add')) as AgentTool<Record<string, unknown>>;
  await add.run(add.parse({ title: 'Ferry seen', source: 'Fictional Gazette', origin: 'Port office', discipline: 'OSINT', reportedAt: '2026-11-18T09:00Z', accessedAt: '2026-11-18T10:00Z', reliability: 'B', credibility: 2, claims: ['ferry'], deceptionNote: 'none seen' }), context);
  const register = JSON.parse(await readFile(path.join(root, SOURCES_FILE), 'utf8')) as { entries: unknown[] };
  assert.equal(register.entries.length, 1);
  const team = { slug: 'j2', section: 'j2' as const, sectionLead: 'j2-chief', members: ['j2-chief', 'osint-analyst', 'tradecraft-reviewer', 'release-guard'] };
  await writeBody(root, 'j2', 'osint-report', '# OSINT report\n\n## Facts\n\n- A ferry was seen at the port [src:SRC-1].\n- A second item [src:SRC-9].\n');
  const lint = await callTool(world, team, 'mcp__staff-products__lint', { product: 'osint-report' }, 'tradecraft-reviewer');
  assert.ok(lint.ok, lint.text);
  assert.doesNotMatch(lint.text, /SRC-1\] is not in the source register/, 'the register entry is found');
  assert.match(lint.text, /SRC-9\] is not in the source register/);
});

test('J2 and J5 members get the staff tools by role; no member can be granted a deciding verb', () => {
  const deciding = HUMAN_ONLY_EVENTS.map((verb) => `mcp__staff-products__${verb}`);
  const j5 = j5OptionSets().filter((_, index) => index % 5 === 0);
  for (const options of j5) {
    const team = members(J5_STAFF_TEMPLATE.render({ settings: options.settings, ...(options.variant ? { variant: options.variant } : {}), ...(options.redTeam !== undefined ? { redTeam: options.redTeam } : {}) }).team);
    for (const member of team) {
      assert.ok(!member.tools.some((tool) => deciding.includes(tool) || /approve|reject|release|supersede/i.test(tool)), `${member.name} has no deciding tool`);
      const has = (verb: string) => member.tools.includes(`mcp__staff-products__${verb}`);
      if (member.name === 'release-guard') {
        assert.ok(has('verdict') && member.tools.includes('mcp__guard-scan__*'), 'the release guard scans and records verdicts');
        assert.ok(!has('propose') && !has('submit'));
      } else if (member.name === 'red-team') {
        assert.deepEqual(member.tools.filter((tool) => tool.startsWith('mcp__')), ['mcp__staff-products__propose', 'mcp__staff-products__status', 'mcp__staff-products__list']);
        for (const tool of member.tools.filter((name) => name.startsWith('mcp__'))) assert.ok(WRITE_LIMITED_STAFF_TOOLS.has(tool), `${tool} survives the write limit`);
      } else {
        assert.ok(has('propose') && has('status') && has('list'), `${member.name} registers its products`);
        assert.ok(!has('verdict'), `${member.name}: only the gate records verdicts`);
        assert.equal(has('submit'), member.name === 'lead-planner', `${member.name}: only the integrator submits`);
        assert.equal(has('step'), member.name === 'lead-planner', `${member.name}: the lead marks the step`);
        assert.equal(has('wargame'), ['lead-planner', 'plans-writer'].includes(member.name), `${member.name}: the controller and the recorder run the wargame ledger`);
      }
    }
  }
  for (const rendering of J2_STAFF_TEMPLATE.renderings().filter((_, index) => index % 9 === 0)) {
    const gate = members(rendering.team).find((member) => member.name === 'tradecraft-reviewer')!;
    assert.ok(gate.tools.includes('mcp__staff-products__lint'), `${rendering.key}: the tradecraft gate runs the one lint`);
  }
});

test('a write-limited member registers only a product inside its limit: the red team its critique, the release guard nothing', async () => {
  const world = await staffWorld();
  await writeBody(world.root, 'j5', 'red-team-critique', '# Critique\n\n1. high: an assumption has no trigger.\n');
  await writeBody(world.root, 'j5', 'coa-a', CLEAN_BODY);
  const critique = await callTool(world, J5_TEAM, 'mcp__staff-products__propose', { product: 'red-team-critique', kind: 'critique' }, 'red-team');
  assert.ok(critique.ok && !/may register only/.test(critique.text), critique.text);
  const plan = await callTool(world, J5_TEAM, 'mcp__staff-products__propose', { product: 'coa-a', kind: 'coa-statement' }, 'red-team');
  assert.match(plan.text, /red-team may register only \.planning\/staff\/products\/j5\/red-team-critique\.md/);
  const guard = await callTool(world, J5_TEAM, 'mcp__staff-products__propose', { product: 'coa-a', kind: 'coa-statement' }, 'release-guard');
  assert.match(guard.text, /release-guard may register only/);
});

test('every shared product has exactly one writer in every J2 and J5 rendering, the member the template says owns it', () => {
  const context = { phase: 'planning' as const, mode: 'standalone' as const };
  for (const rendering of J2_STAFF_TEMPLATE.renderings().filter((entry) => entry.key.endsWith('/cloud'))) {
    const team = parseTeam(rendering.team, '/p/j2.md');
    const roster = team.members.map((member) => member.name);
    for (const shared of SHARED_PRODUCTS) {
      for (const part of [undefined, ...Object.keys(shared.parts ?? {})]) {
        const writer = writerIn(shared.product, context, { section: 'j2', members: roster }, part);
        if (writer?.section !== 'j2') continue;
        assert.ok(roster.includes(writer.member), `${rendering.key}: ${shared.product}${part ? `/${part}` : ''} has its writer ${writer.member} in the roster`);
      }
    }
    for (const product of J2_PRODUCTS.filter((entry) => SHARED_PRODUCTS.some((shared) => shared.product === entry.id))) {
      const level = team.staff!.level;
      const variant = level === 'strategic' || level === 'operational' ? level : roster.includes('collection-manager') ? 'brigade' : 'battalion';
      const owner = product.owners[variant];
      if (owner) assert.equal(writerIn(product.id, context, { section: 'j2', members: roster })?.member, owner, `${rendering.key}: ${product.id} catalogue owner is the writer`);
    }
  }
  for (const options of j5OptionSets()) {
    const template = j5Template(options);
    const roster = template.members.map((member) => member.name);
    for (const product of template.products) {
      if (!SHARED_PRODUCTS.some((shared) => shared.product === product.product)) continue;
      const writer = writerIn(product.product, context, { section: 'j5', members: roster });
      assert.equal(writer?.section, 'j5', product.product);
      assert.equal(writer?.member, product.owner, `${product.product}: the J5 template and the writer table agree`);
    }
  }
});

test('one real-entity list: a name in either file is refused by the scenario loader and held by guard-scan', async () => {
  assert.deepEqual(parseRealEntityList('# notes\nFort Example\nA\n  Port Real # a note\n'), ['Fort Example', 'Port Real']);
  assert.deepEqual(realEntitiesFromGuardConfig({ realEntities: ['Base Real', 7, ' x '] }), ['Base Real']);
  assert.deepEqual(realEntitiesFromGuardConfig('not an object'), []);
  assert.deepEqual(mergeRealEntities(['A1', 'B2'], ['B2', 'C3']), ['A1', 'B2', 'C3']);

  const starter = await readFile(STARTER_SCENARIO_FILE, 'utf8');
  const place = 'Harrow Ridge';
  for (const where of ['config', 'list'] as const) {
    const world = await staffWorld();
    if (where === 'config') {
      await mkdir(path.join(world.root, '.planning/.near-ai'), { recursive: true });
      await writeFile(path.join(world.root, '.planning/.near-ai/staff-guard.json'), JSON.stringify({ realEntities: [place] }));
    } else {
      await mkdir(path.join(world.root, '.planning/staff'), { recursive: true });
      await writeFile(path.join(world.root, '.planning/staff/real-entities.txt'), `# real names\n${place}\n`);
    }
    assert.deepEqual(await readRealEntities(world.root), [place]);
    const loaded = await loadScenarioIntoProject(world.root, starter);
    assert.equal(loaded.ok, false, `${where}: the scenario loader refuses a listed name`);
    assert.deepEqual((await world.host.guardConfig()).realEntities, [place], `${where}: guard-scan holds the same list`);
  }
});

test('every product the demo scripts and acceptance fixtures name is a product its section template owns, with one owner in the roster', () => {
  for (const fixture of ACCEPTANCE_PRODUCTS) {
    for (const product of fixture.products) {
      if (fixture.section === 'j2') {
        const entry = J2_PRODUCTS.find((candidate) => candidate.id === product);
        assert.ok(entry, `the J2 template has ${product}`);
        assert.ok(entry!.owners.operational, `${product} has an owner in the operational roster`);
      } else {
        for (const options of j5OptionSets().filter((_, index) => index % 4 === 0)) {
          const owners = j5Template(options).products.filter((candidate) => candidate.product === product);
          assert.equal(owners.length, 1, `the J5 template has exactly one owner of ${product}`);
        }
      }
    }
  }
});
