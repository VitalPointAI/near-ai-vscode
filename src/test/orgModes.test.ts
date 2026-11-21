// How your organization works (FND-07, Phase 41 D-39, D-40): the one mode table, term() as the only reader of its words, and the people.organization
// block that may only tighten what a mode allows. Fictional data only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { SCALE_PRESETS } from '../domain/gate/labels';
import { parsePolicyDocument } from '../domain/gate/policyDocument';
import { CONCEPT_KEYS, MAX_DELEGATION_DEPTH, MODES, MODE_IDS, ORGANIZATION_SETTING_KEYS, SOURCE_STATUSES, effectiveBehaviour } from '../domain/org/modes';
import type { ModeId, OrganizationSettings } from '../domain/org/modes';
import { parsePeopleSection } from '../domain/org/peopleSection';
import { HOW_YOUR_ORGANIZATION_WORKS, modeName, planningProfileFor, term } from '../domain/org/terms';
import { STAFF_PROFILE_IDS } from '../domain/staff/doctrine';
import { FIXED_NOW, deviceKey, policyDocumentFor } from './helpers/policyFixtures';

type Loose = any; // a document under edit: each test breaks one value on purpose

function plain<T>(value: T): Loose {
  return JSON.parse(JSON.stringify(value)) as Loose;
}

/** The starting rules as a plain v2 document of your organization's layer, with one edit applied. */
function orgDocument(edit: (doc: Loose) => void = () => undefined): Loose {
  const doc = plain(policyDocumentFor({ key: deviceKey(), layer: 'organization', now: FIXED_NOW }));
  edit(doc);
  return doc;
}

/** A people section holding one organization block. */
function people(organization: Loose): Loose {
  return { v: 1, organization };
}

function corporate(settings: Loose = {}): Loose {
  return { mode: 'corporate', allowedModes: ['corporate'], projectMayChoose: false, settings };
}

/** `ok`, or the refusal reason and path, for one people section. */
function outcome(value: unknown): string {
  const parsed = parsePeopleSection(value, SCALE_PRESETS);
  return parsed.ok ? 'ok' : `${parsed.reason} ${parsed.path}`;
}

test('D-39: term() gives the Corporate words, and work team where people group', () => {
  assert.equal(term('group', 'corporate'), 'Work team');
  assert.equal(term('tasker', 'corporate'), 'Work team admin');
  assert.equal(term('lead', 'corporate'), 'Work team lead');
  assert.equal(term('dual', 'corporate'), 'Member of two work teams');
  assert.equal(term('join', 'corporate'), 'Invitation');
  assert.equal(term('join'), 'Invitation', 'a project without a mode behaves as Corporate and software (portfolio D12)');
});

test('D-40: a v2 policy with people.organization reads through parsePolicyDocument', () => {
  const doc = orgDocument((d) => { d.people = people(corporate()); });
  assert.ok(doc.requires.includes('people@1'));
  const parsed = parsePolicyDocument(doc);
  assert.equal(parsed.ok ? 'ok' : `${parsed.reason} ${parsed.path}`, 'ok');
  if (!parsed.ok) return;
  const organization = parsed.value.people?.organization;
  assert.ok(organization !== undefined);
  assert.equal(organization.mode, 'corporate');
  assert.deepEqual([...organization.allowedModes], ['corporate']);
  assert.equal(organization.projectMayChoose, false);
  assert.equal(organization.settings.maxDelegationDepth, 0);
  assert.equal(organization.settings.overdueDays, 2);
  assert.equal(Object.prototype.hasOwnProperty.call(organization.settings, 'mayDecline'), false, 'a boolean setting not written stays absent');
  assert.ok(Object.isFrozen(organization) && Object.isFrozen(organization.allowedModes) && Object.isFrozen(organization.settings));
  // A document is its own wire form: its JSON copy parses to the same block.
  const again = parsePeopleSection(plain(parsed.value.people), SCALE_PRESETS);
  assert.ok(again.ok);
  if (!again.ok) return;
  assert.deepEqual(again.value, parsed.value.people);
});

test('D-40: a people.organization key the schema does not know is refused unknown-field at its path', () => {
  assert.equal(outcome(people({ ...corporate(), invented: true })), 'unknown-field people.organization.invented');
  const hostile = JSON.parse('{"mode":"corporate","allowedModes":["corporate"],"projectMayChoose":false,"__proto__":{"x":1}}') as Loose;
  assert.equal(outcome(people(hostile)), 'unknown-field people.organization.__proto__');
  assert.equal(outcome(people(corporate({ invented: 1 }))), 'unknown-field people.organization.settings.invented');
  // Through the document, the path carries the section name.
  const parsed = parsePolicyDocument(orgDocument((d) => { d.people = people({ ...corporate(), invented: true }); }));
  assert.equal(parsed.ok ? 'ok' : `${parsed.reason} ${parsed.path}`, 'unknown-field people.organization.invented');
});

/** Every word of a mode row, the main word and the `also` words, with its concept. */
function wordsOf(mode: ModeId): Array<{ concept: string; word: string }> {
  const out: Array<{ concept: string; word: string }> = [];
  for (const concept of CONCEPT_KEYS) {
    const entry = MODES[mode].words[concept];
    out.push({ concept, word: entry.word });
    for (const also of entry.also ?? []) out.push({ concept, word: also });
  }
  return out;
}

test('D-39: four modes in a fixed order with their names', () => {
  assert.deepEqual([...MODE_IDS], ['military', 'public-service', 'corporate', 'capital']);
  assert.deepEqual(Object.keys(MODES), [...MODE_IDS]);
  assert.deepEqual(MODE_IDS.map((mode) => modeName(mode)), ['Military', 'Public service', 'Corporate and software', 'Capital projects']);
  assert.equal(HOW_YOUR_ORGANIZATION_WORKS, 'How your organization works');
  assert.ok(Object.isFrozen(MODES));
  for (const mode of MODE_IDS) {
    assert.ok(Object.isFrozen(MODES[mode]) && Object.isFrozen(MODES[mode].words) && Object.isFrozen(MODES[mode].behaviour), mode);
    for (const concept of CONCEPT_KEYS) assert.ok(Object.isFrozen(MODES[mode].words[concept]), `${mode} ${concept}`);
  }
});

test('D-39: every concept key has a non-empty word in every mode, and term() agrees with MODES', () => {
  assert.equal(CONCEPT_KEYS.length, 17);
  for (const mode of MODE_IDS) {
    assert.deepEqual(Object.keys(MODES[mode].words), [...CONCEPT_KEYS], mode);
    for (const concept of CONCEPT_KEYS) {
      const word = term(concept, mode);
      assert.ok(word.trim().length > 0 && word === word.trim(), `${mode} ${concept}`);
      assert.equal(word, MODES[mode].words[concept].word);
    }
  }
  assert.throws(() => term('seat' as never, 'corporate'), TypeError);
  assert.throws(() => term('position', 'navy' as never), TypeError);
  assert.throws(() => term('position', '__proto__' as never), TypeError);
});

test('owner 2026-11-20: no mode word is the bare word team', () => {
  const emDash = String.fromCharCode(0x2014);
  for (const mode of MODE_IDS) {
    for (const { concept, word } of wordsOf(mode)) {
      assert.ok(!word.includes(emDash), `${mode} ${concept} ${word}`);
      for (const match of word.matchAll(/team/gi)) {
        const before = word.slice(0, match.index).trimEnd().split(/\s+/).pop()?.toLowerCase() ?? '';
        const allowed = before === 'work' || (mode === 'capital' && before === 'project') || ((mode === 'military' || mode === 'public-service') && before === 'defence');
        assert.ok(allowed, `${mode} ${concept}: "${word}" uses the bare word team`);
      }
    }
  }
  assert.equal(term('member', 'capital'), 'Project team member');
});

test('D-39: every military and public service word has a source note; corporate and capital words carry none', () => {
  assert.deepEqual([...SOURCE_STATUSES], ['confirmed', 'confirmed-by-owner', 'best-guess']);
  for (const mode of MODE_IDS) {
    for (const concept of CONCEPT_KEYS) {
      const source = MODES[mode].words[concept].source;
      if (mode === 'military' || mode === 'public-service') {
        assert.ok(source !== undefined, `${mode} ${concept} has no source`);
        assert.ok((SOURCE_STATUSES as readonly string[]).includes(source.status), `${mode} ${concept}`);
        assert.ok(source.note.trim().length > 0 && source.note.length <= 300, `${mode} ${concept} note length ${String(source.note.length)}`);
        assert.ok(!source.note.includes(String.fromCharCode(0x2014)), `${mode} ${concept}`);
        assert.ok(Object.isFrozen(source), `${mode} ${concept}`);
      } else {
        assert.equal(source, undefined, `${mode} ${concept}`);
      }
    }
  }
});

test('5.3: behaviour per mode', () => {
  const column = <K extends keyof (typeof MODES)['corporate']['behaviour']>(key: K): unknown[] => MODE_IDS.map((mode) => MODES[mode].behaviour[key]);
  assert.deepEqual(column('joiningModel'), ['assignment', 'assignment', 'invitation', 'appointment']);
  assert.deepEqual(column('mayDecline'), [false, false, true, false]);
  assert.deepEqual(column('invitationExpiryDays'), [undefined, undefined, 7, undefined]);
  assert.deepEqual(column('whoMayPost'), ['lead-and-delegates', 'lead-and-delegates', 'lead-and-deputy', 'appointing-authority-and-delegates']);
  assert.deepEqual(column('instrumentRequired'), [false, false, false, true]);
  assert.deepEqual(column('acting'), [true, true, false, true]);
  assert.deepEqual(column('temporary'), ['yes', 'yes', 'guest-only', 'yes']);
  assert.deepEqual(column('dualHatting'), [true, true, false, true]);
  assert.deepEqual(column('handoverRequired'), [true, true, false, true]);
  assert.deepEqual(column('positionsPersist'), ['yes', 'yes', 'optional', 'yes']);
  assert.deepEqual(column('guests'), ['if-policy-allows', 'allowed', 'always', 'allowed']);
  assert.deepEqual(column('planningProfile'), ['nato-ca', 'none', 'none', 'capital-pack']);
  // The words and the behaviour come from one row: a mode that does not let people decline never offers a Decline word.
  for (const mode of MODE_IDS) {
    assert.equal(MODES[mode].behaviour.mayDecline, term('unable', mode) === 'Decline', mode);
    assert.equal(MODES[mode].behaviour.acting, MODES[mode].words.acting.offered !== false, mode);
  }
});

test('D-40: doctrine stays a profile under term()', () => {
  assert.equal(planningProfileFor('military'), 'nato-ca');
  assert.equal(planningProfileFor('military', 'us-joint'), 'us-joint');
  for (const choice of STAFF_PROFILE_IDS) assert.equal(planningProfileFor('military', choice), choice);
  assert.equal(planningProfileFor('public-service'), 'none');
  assert.equal(planningProfileFor('corporate'), 'none');
  assert.equal(planningProfileFor('capital'), 'capital-pack');
  assert.equal(planningProfileFor('corporate', 'us-joint'), 'none', 'a mode without doctrine ignores the choice');
  for (const outside of ['caf-opp', 'NATO-CA', '', '__proto__', 'constructor']) {
    assert.equal(planningProfileFor('military', outside), 'nato-ca', `profile ${outside} is refused`);
  }
});

/** An organization block over `allowedModes` (sorted by the caller), with `mode` the first of them unless given. */
function over(allowedModes: string[], settings: Loose = {}, mode: string = allowedModes[0] ?? 'corporate'): Loose {
  return people({ mode, allowedModes, projectMayChoose: true, settings });
}

function parsedSettings(value: unknown): Loose {
  const parsed = parsePeopleSection(value, SCALE_PRESETS);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.message);
  return parsed.ok ? parsed.value.organization?.settings : undefined;
}

test('D-40: maxDelegationDepth defaults to 0, accepts 0 to 2 and refuses 3 (wrong-type), -1 and 1.5', () => {
  assert.equal(MAX_DELEGATION_DEPTH, 2);
  assert.equal(parsedSettings(over(['corporate'])).maxDelegationDepth, 0);
  assert.equal(parsedSettings(people({ mode: 'corporate', allowedModes: ['corporate'], projectMayChoose: false })).maxDelegationDepth, 0, 'settings absent');
  for (const depth of [0, 1, 2]) assert.equal(parsedSettings(over(['military'], { maxDelegationDepth: depth })).maxDelegationDepth, depth);
  for (const depth of [3, -1, 1.5, '1', null, Number.NaN, Number.POSITIVE_INFINITY, true]) {
    assert.equal(outcome(over(['military'], { maxDelegationDepth: depth })), 'wrong-type people.organization.settings.maxDelegationDepth', String(depth));
  }
});

test('D-40: declining can never be turned on in an assignment mode', () => {
  assert.equal(outcome(over(['corporate', 'military'], { mayDecline: true })), 'not-allowed-here people.organization.settings.mayDecline');
  for (const mode of ['capital', 'military', 'public-service']) {
    assert.equal(outcome(over([mode], { mayDecline: true })), 'not-allowed-here people.organization.settings.mayDecline', mode);
    assert.equal(outcome(over(['corporate', mode].sort(), { mayDecline: true }, 'corporate')), 'not-allowed-here people.organization.settings.mayDecline', mode);
  }
  assert.equal(outcome(over(['corporate'], { mayDecline: true })), 'ok');
  assert.equal(parsedSettings(over(['corporate'], { mayDecline: true })).mayDecline, true);
  for (const modes of [['corporate'], ['military'], ['capital', 'corporate', 'military', 'public-service']]) {
    assert.equal(outcome(over(modes, { mayDecline: false })), 'ok', modes.join(' '));
  }
  assert.equal(outcome(over(['corporate'], { mayDecline: 'yes' })), 'wrong-type people.organization.settings.mayDecline');
});

test('D-40: acting or dualHatting true is refused while Corporate is an allowed mode', () => {
  for (const key of ['acting', 'dualHatting']) {
    assert.equal(outcome(over(['corporate'], { [key]: true })), `not-allowed-here people.organization.settings.${key}`);
    assert.equal(outcome(over(['corporate', 'military'], { [key]: true }, 'military')), `not-allowed-here people.organization.settings.${key}`);
    assert.equal(outcome(over(['capital', 'military', 'public-service'], { [key]: true })), 'ok', key);
    for (const modes of [['corporate'], ['military'], ['capital', 'corporate', 'military', 'public-service']]) {
      assert.equal(outcome(over(modes, { [key]: false })), 'ok', `${key} ${modes.join(' ')}`);
    }
  }
});

test('D-40: effectiveBehaviour never allows declining in an assignment or appointment mode', () => {
  const values: OrganizationSettings[] = [
    {}, { mayDecline: true }, { mayDecline: false }, { acting: true, dualHatting: true, guests: true, temporary: true },
    JSON.parse('{"__proto__":{"mayDecline":true},"mayDecline":true}') as OrganizationSettings
  ];
  for (const mode of MODE_IDS) {
    for (const settings of values) {
      const behaviour = effectiveBehaviour(mode, settings);
      const expected = mode === 'corporate' && settings.mayDecline !== false;
      assert.equal(behaviour.mayDecline, expected, `${mode} ${JSON.stringify(settings)}`);
      if (MODES[mode].behaviour.joiningModel !== 'invitation') assert.equal(behaviour.mayDecline, false, mode);
      assert.ok(Object.isFrozen(behaviour));
    }
  }
  assert.equal(effectiveBehaviour('corporate', { mayDecline: false }).mayDecline, false);
  assert.equal(MODES.corporate.behaviour.mayDecline, true, 'the table itself is never changed');
});

test('D-40: effectiveBehaviour only turns a permission off or a duty on, never widens a mode', () => {
  const widest: OrganizationSettings = { acting: true, dualHatting: true, enrolAtReport: false, guests: true, mayDecline: true, temporary: true };
  const narrowest: OrganizationSettings = { acting: false, dualHatting: false, enrolAtReport: true, guests: false, mayDecline: false, temporary: false };
  for (const mode of MODE_IDS) {
    const row = MODES[mode].behaviour;
    const wide = effectiveBehaviour(mode, widest);
    for (const key of ['mayDecline', 'acting', 'dualHatting'] as const) assert.equal(wide[key], row[key], `${mode} ${key}`);
    assert.equal(wide.guests, row.guests);
    assert.equal(wide.temporary, row.temporary);
    assert.equal(wide.enrolAtReport, false);
    assert.equal(wide.joiningModel, row.joiningModel);
    const narrow = effectiveBehaviour(mode, narrowest);
    for (const key of ['mayDecline', 'acting', 'dualHatting'] as const) assert.equal(narrow[key], false, `${mode} ${key}`);
    assert.equal(narrow.guests, 'if-policy-allows');
    assert.equal(narrow.temporary, 'no');
    assert.equal(narrow.enrolAtReport, true);
    assert.equal(narrow.handoverRequired, row.handoverRequired, 'a duty the mode has stays');
    assert.equal(effectiveBehaviour(mode, {}).enrolAtReport, false, 'reading in is allowed from enrolment by default (portfolio D3)');
  }
});

test('D-40: overdueDays is an integer from 1 to 30 (default 2); enrolAtReport, guests, temporary are booleans', () => {
  assert.equal(parsedSettings(over(['military'])).overdueDays, 2);
  for (const days of [1, 2, 30]) assert.equal(parsedSettings(over(['military'], { overdueDays: days })).overdueDays, days);
  for (const days of [0, 31, 2.5, -2, '2', null]) {
    assert.equal(outcome(over(['military'], { overdueDays: days })), 'wrong-type people.organization.settings.overdueDays', String(days));
  }
  for (const key of ['enrolAtReport', 'guests', 'temporary']) {
    for (const mode of MODE_IDS) {
      assert.equal(parsedSettings(over([mode], { [key]: true }))[key], true, `${key} ${mode}`);
      assert.equal(parsedSettings(over([mode], { [key]: false }))[key], false, `${key} ${mode}`);
    }
    for (const bad of ['true', 1, null, {}]) assert.equal(outcome(over(['military'], { [key]: bad })), `wrong-type people.organization.settings.${key}`);
  }
  assert.equal(outcome(over(['military'], 'tight')), 'wrong-type people.organization.settings');
  assert.equal(outcome(over(['military'], [])), 'wrong-type people.organization.settings');
});

test('D-40: mode not in allowedModes, a bad allowedModes list and an unknown mode id are refused', () => {
  assert.equal(outcome(over(['military'], {}, 'corporate')), 'not-allowed-here people.organization.mode');
  assert.equal(outcome(over([], {}, 'corporate')), 'empty-list people.organization.allowedModes');
  assert.equal(outcome(over(['military', 'corporate'], {}, 'corporate')), 'not-sorted people.organization.allowedModes[1]');
  assert.equal(outcome(over(['corporate', 'corporate'], {}, 'corporate')), 'duplicate people.organization.allowedModes[1]');
  assert.equal(outcome(over(['corporate'], {}, 'navy')), 'wrong-type people.organization.mode');
  assert.equal(outcome(over(['corporate', 'navy'], {}, 'corporate')), 'wrong-type people.organization.allowedModes[1]');
  assert.equal(outcome(over(['Corporate'], {}, 'Corporate')), 'wrong-type people.organization.mode');
  assert.equal(outcome(people({ mode: 'corporate', allowedModes: 'corporate', projectMayChoose: false })), 'wrong-type people.organization.allowedModes');
  assert.equal(outcome(people({ mode: 'corporate', allowedModes: ['corporate'], projectMayChoose: 'no' })), 'wrong-type people.organization.projectMayChoose');
  assert.equal(outcome(people({ allowedModes: ['corporate'], projectMayChoose: false })), 'missing-field people.organization.mode');
  assert.equal(outcome(people({ mode: 'corporate', projectMayChoose: false })), 'missing-field people.organization.allowedModes');
  assert.equal(outcome(people({ mode: 'corporate', allowedModes: ['corporate'] })), 'missing-field people.organization.projectMayChoose');
  assert.equal(outcome(people('corporate')), 'wrong-type people.organization');
  assert.equal(outcome(over(['capital', 'corporate', 'military', 'public-service'], {}, 'public-service')), 'ok');
});

test('D-40: ORGANIZATION_SETTING_KEYS lists exactly the settings the parser accepts', () => {
  assert.deepEqual([...ORGANIZATION_SETTING_KEYS], [...ORGANIZATION_SETTING_KEYS].sort());
  const every: Loose = {};
  for (const key of ORGANIZATION_SETTING_KEYS) every[key] = key === 'maxDelegationDepth' ? 1 : key === 'overdueDays' ? 5 : false;
  const settings = parsedSettings(over(['corporate'], every));
  assert.deepEqual(Object.keys(settings).sort(), [...ORGANIZATION_SETTING_KEYS]);
  for (const key of ['invented', 'joiningModel', 'handoverRequired', 'invitationExpiryDays', 'allowedModes', 'constructor', 'toString']) {
    assert.equal(outcome(over(['corporate'], { ...every, [key]: false })), `unknown-field people.organization.settings.${key}`, key);
  }
});

test('owner 2026-11-21: the Military words are confirmed; position is Position; member also Staff member or Defence team member', () => {
  for (const concept of CONCEPT_KEYS) assert.equal(MODES.military.words[concept].source?.status, 'confirmed-by-owner', concept);
  assert.equal(term('position', 'military'), 'Position');
  assert.equal(MODES.military.words.position.also, undefined);
  assert.equal(term('member', 'military'), 'Staff officer');
  assert.deepEqual(MODES.military.words.member.also, ['Staff member', 'Defence team member']);
  assert.equal(term('member', 'public-service'), 'Employee');
  assert.deepEqual(MODES['public-service'].words.member.also, ['Defence team member']);
  assert.equal(MODES['public-service'].words.member.source?.status, 'confirmed-by-owner');
});
