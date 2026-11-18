// The optional `staff:` block in a team file's frontmatter (UX concept 11 and 12.5; WP-0): strict parsing, rejection of bad input, the round trip, and
// that every existing team file reads exactly as before, in this build and in a build that predates the block.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { PROJECT_TYPES, projectTypeTeam } from '../agent/projectTypes';
import { newTeamTemplate, parseTeam, renderTeam } from '../agent/teams';
import { readStaffTeamBlock, renderStaffTeamBlock } from '../domain/staff/teamBlock';
import type { StaffTeamBlock } from '../domain/staff/teamBlock';
import { parseFrontmatter } from '../gsd/library';

const FIXTURE = path.resolve(__dirname, '..', '..', 'test', 'fixtures', 'teams', 'wearable-research-team.md');

const BLOCK = [
  'staff:',
  '  section: j2',
  '  profile: us-joint          # the roster variant',
  '  level: operational',
  '  glyph: eye',
  '  human-lead: J2 director',
  '  steps: { 2: primary, 3: supporting, 4: supporting, 7: primary }',
  '  products: [intelligence-estimate, intelligence-annex]',
  '  layers: [cop-threat-layer]'
];

function teamText(frontmatterExtra: readonly string[], options: { private?: boolean } = {}): string {
  return [
    '---',
    'name: J2 intelligence',
    'description: The J2 section',
    ...(options.private ? ['privacy: private'] : []),
    ...frontmatterExtra,
    '---',
    '',
    '## j2-chief',
    'role: J2 integrator',
    'tools: Read, Write',
    '',
    'Integrate the section\'s products. Hand back the estimate.',
    '',
    '## release-guard',
    'role: Release gate',
    '',
    'Check the product. Hand back CLEARED or HOLD.',
    ''
  ].join('\n');
}

test('a full staff block parses to the block the design describes', () => {
  const result = readStaffTeamBlock(teamText(BLOCK));
  assert.ok(result.ok, result.ok ? '' : result.message);
  if (!result.ok) return;
  assert.deepEqual(result.value, {
    section: 'j2', profile: 'us-joint', level: 'operational', glyph: 'eye', humanLead: 'J2 director',
    steps: { 2: 'primary', 3: 'supporting', 4: 'supporting', 7: 'primary' },
    products: ['intelligence-estimate', 'intelligence-annex'], layers: ['cop-threat-layer']
  });
  const minimal = readStaffTeamBlock(teamText(['staff:', '  section: j5']));
  assert.ok(minimal.ok);
  if (minimal.ok) assert.deepEqual(minimal.value, { section: 'j5', steps: {}, products: [], layers: [] });
});

test('the block round trips through render and read, and through parseTeam and renderTeam', () => {
  const block: StaffTeamBlock = { section: 'j4', profile: 'nato-ca', level: 'tactical', humanLead: 'G4', steps: { 3: 'supporting', 2: 'primary' }, products: ['logistics-estimate'], layers: [] };
  const read = readStaffTeamBlock(teamText(renderStaffTeamBlock(block)));
  assert.ok(read.ok);
  if (read.ok) assert.deepEqual(read.value, block);
  const team = parseTeam(teamText(BLOCK, { private: true }), '/teams/j2-intelligence.md');
  assert.ok(team.staff);
  const copy = parseTeam(renderTeam(team.name, team.description, team.members, { private: team.private, staff: team.staff }), '/teams/copy.md');
  assert.deepEqual(copy.staff, team.staff);
  assert.equal(copy.private, true);
});

test('bad blocks are refused with the field named, and parseTeam says what to fix', () => {
  const cases: Array<[readonly string[], string, string]> = [
    [['staff:'], 'missing-field', 'staff.section'],
    [['staff: j2'], 'wrong-type', 'staff'],
    [['staff:', '  section: j2', 'staff:', '  section: j3'], 'duplicate-field', 'staff'],
    [['staff:', '  glyph: eye'], 'missing-field', 'staff.section'],
    [['staff:', '  section: J2'], 'unknown-value', 'staff.section'],
    [['staff:', '  section: j2', '  section: j3'], 'duplicate-field', 'staff.section'],
    [['staff:', '  section: j2', '  colour: red'], 'unknown-field', 'staff.colour'],
    [['staff:', '  section: j2', '  profile: caf-opp'], 'unknown-value', 'staff.profile'],
    [['staff:', '  section: j2', '  level: grand'], 'unknown-value', 'staff.level'],
    [['staff:', '  section: j2', '  profile: us-joint', '  level: tactical'], 'not-offered', 'staff.level'],
    [['staff:', '  section: j2', '  glyph: Eye Icon'], 'wrong-type', 'staff.glyph'],
    [['staff:', '  section: j2', '  human-lead:'], 'wrong-type', 'staff.human-lead'],
    [['staff:', '  section: j2', '  steps: { 9: primary }'], 'unknown-value', 'staff.steps.9'],
    [['staff:', '  section: j2', '  steps: { 2: lead }'], 'unknown-value', 'staff.steps.2'],
    [['staff:', '  section: j2', '  steps: { 2: primary, 2: supporting }'], 'duplicate-entry', 'staff.steps.2'],
    [['staff:', '  section: j2', '  steps: 2 primary'], 'wrong-type', 'staff.steps'],
    [['staff:', '  section: j2', '  products: intelligence-estimate'], 'wrong-type', 'staff.products'],
    [['staff:', '  section: j2', '  products: [Intelligence Estimate]'], 'wrong-type', 'staff.products[0]'],
    [['staff:', '  section: j2', '  products: [a, a]'], 'duplicate-entry', 'staff.products[1]'],
    [['staff:', '  section: j2', '  layers: [a, [b]]'], 'wrong-type', 'staff.layers'],
    [['staff:', '  section: j2', '  products:', '    - intelligence-estimate'], 'wrong-type', 'staff.products'],
    [['staff:', '  section: j2', '    level: operational'], 'bad-syntax', 'staff'],
    [['staff:', '\tsection: j2'], 'bad-syntax', 'staff']
  ];
  for (const [lines, reason, where] of cases) {
    const result = readStaffTeamBlock(teamText(lines));
    assert.equal(result.ok, false, `${lines.join(' / ')} should be refused`);
    if (!result.ok) assert.deepEqual([result.reason, result.path], [reason, where], lines.join(' / '));
    assert.throws(() => parseTeam(teamText(lines), '/teams/bad.md'), /staff: block is not valid/);
  }
});

test('a team file without a staff block reads exactly as before, and has no staff field', () => {
  const texts: Array<[string, string]> = [
    ['fixture', readFileSync(FIXTURE, 'utf8')],
    ['new team template', newTeamTemplate('My team')],
    ['hand-written', teamText([])],
    ['hand-written private', teamText([], { private: true })],
    ['no frontmatter staff, a member line that says staff', teamText([]).replace('Integrate the section', 'staff: the members keep their own hours.\nIntegrate the section')],
    ...PROJECT_TYPES.map((type): [string, string] => [`${type.id} project team`, projectTypeTeam(type, 'Ship the thing', 'cloud')])
  ];
  for (const [label, text] of texts) {
    const team = parseTeam(text, `/teams/${label.replace(/\W+/g, '-')}.md`);
    assert.equal('staff' in team, false, label);
    const block = readStaffTeamBlock(text);
    assert.ok(block.ok && block.value === undefined, label);
    // Rendering with no staff option is byte for byte what it was.
    assert.equal(renderTeam(team.name, team.description, team.members, { private: team.private }), renderTeam(team.name, team.description, team.members, { private: team.private, staff: undefined }));
  }
});

test('adding a staff block changes nothing else about the team, in this build and in a build that predates the block', () => {
  for (const isPrivate of [false, true]) {
    const plain = teamText([], { private: isPrivate });
    const withBlock = teamText(BLOCK, { private: isPrivate });
    const before = parseTeam(plain, '/teams/j2.md');
    const after = parseTeam(withBlock, '/teams/j2.md');
    const { staff, ...rest } = after;
    assert.ok(staff);
    assert.deepEqual(rest, before);
    // An older build reads frontmatter with parseFrontmatter only: the block's indented lines are skipped, so name, description and privacy are the same.
    const old = parseFrontmatter(withBlock).data;
    const oldPlain = parseFrontmatter(plain).data;
    assert.equal(old.name, oldPlain.name);
    assert.equal(old.description, oldPlain.description);
    assert.equal(old.privacy, oldPlain.privacy);
    assert.equal(old.staff, undefined);
    assert.deepEqual(Object.keys(old).filter((key) => key !== 'staff').sort(), Object.keys(oldPlain).sort());
  }
});
