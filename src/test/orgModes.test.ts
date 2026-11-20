// How your organization works (FND-07, Phase 41 D-39, D-40): the one mode table, term() as the only reader of its words, and the people.organization
// block that may only tighten what a mode allows. Fictional data only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { SCALE_PRESETS } from '../domain/gate/labels';
import { parsePolicyDocument } from '../domain/gate/policyDocument';
import { CONCEPT_KEYS, MODES, MODE_IDS, SOURCE_STATUSES } from '../domain/org/modes';
import type { ModeId } from '../domain/org/modes';
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
        const allowed = before === 'work' || (mode === 'capital' && before === 'project');
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
