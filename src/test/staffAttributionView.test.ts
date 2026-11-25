import assert from 'node:assert/strict';
import test from 'node:test';
import type { AuthorSpan } from '../domain/replica/attribution';
import { authorLabel, authorRows, NOT_VERIFIED_TEXT } from '../domain/staff/whoWroteThis';

const person: AuthorSpan = { start: 0, length: 3, clientId: 1, writer: 'device-a', member: 'avery', actor: 'person' };
const peer: AuthorSpan = { start: 3, length: 5, clientId: 2, writer: 'device-b', member: 'blake', actor: 'person' };
const agent: AuthorSpan = {
  start: 8, length: 2, clientId: 3, writer: 'device-b', member: 'blake', actor: 'agent', agentMember: 'j4-analyst', run: '7'
};
const names = (span: AuthorSpan) => span.member === 'avery'
  ? { memberName: 'Avery Lead' }
  : { memberName: 'Blake Rivers', agentJob: 'J4 analyst' };

test('a verified person is named through the roster resolver', () => {
  assert.equal(authorLabel(person, (span) => {
    assert.equal(span, person);
    return names(span);
  }), 'Avery Lead');
});

test('a verified agent is described by job, run and the computer owner', () => {
  assert.equal(authorLabel(agent, names), "J4 analyst agent, run 7, on Blake Rivers's computer");
});

test('provisional text never resolves to a person or agent even when an author is present', () => {
  const unexpectedNames = (): never => assert.fail('only verified spans can be named');
  const spans = [{ ...person, unverified: true as const }, { ...agent, unverified: true as const }];
  assert.equal(authorLabel(spans[0], unexpectedNames), NOT_VERIFIED_TEXT);
  assert.equal(authorLabel(spans[1], unexpectedNames), NOT_VERIFIED_TEXT);
  assert.deepEqual(authorRows(spans, unexpectedNames).map(({ label, share }) => ({ label, share })), [
    { label: NOT_VERIFIED_TEXT, share: 1 }
  ]);
});

test('unresolved historical names and agent seats are shown as unavailable', () => {
  assert.equal(authorLabel(person, () => undefined), 'Author unavailable');
  assert.equal(authorLabel(agent, () => ({ memberName: 'Blake Rivers' })), 'Author unavailable');
});

test('rows combine disjoint spans for two people and an agent and report their shares', () => {
  const tail = { ...person, start: 10, length: 2 };
  assert.deepEqual(authorRows([person, peer, agent, tail], names), [
    { label: 'Avery Lead', share: 5 / 12, spans: [person, tail] },
    { label: 'Blake Rivers', share: 5 / 12, spans: [peer] },
    { label: "J4 analyst agent, run 7, on Blake Rivers's computer", share: 2 / 12, spans: [agent] }
  ]);
});
