// How your organization works (FND-07, Phase 41 D-39, D-40): the one mode table, term() as the only reader of its words, and the people.organization
// block that may only tighten what a mode allows. Fictional data only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { SCALE_PRESETS } from '../domain/gate/labels';
import { parsePolicyDocument } from '../domain/gate/policyDocument';
import { parsePeopleSection } from '../domain/org/peopleSection';
import { term } from '../domain/org/terms';
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
