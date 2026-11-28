// Phase 33 plan 28 (D-57; the state list and warning rule of superseded 33-20). The sync word on Sterling's status bar: one entry,
// sterling.staffSync, while a shared project is open, with the state's word, its sentence as the tooltip and Sync Now as its command; removed when
// no shared project is open; joined to a Sterling status item instead when 32.1 native made one. Every state's word and look, and nothing but
// words and sentences on the bar (T-33-76, T-33-77). Fictional exercise data only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StaffStatusRow } from '../extension/src/common/staff-live.ts';
import {
  STAFF_SYNC_COMMAND, STAFF_SYNC_ENTRY, STAFF_SYNC_WARNING_STATES, STAFF_SYNC_WORDS, StaffSyncStatus, type StaffSyncBar, type StaffSyncEntry, type StaffSyncShown,
  type SterlingStatusItem,
} from '../extension/src/browser/staff/staff-sync-status.ts';
import { RESTORING_TEXT, SENTENCE_STATES, SYNC_WORDS, syncSentence } from '../../src/domain/staff/liveSentences.ts';

class FakeBar implements StaffSyncBar {
  public readonly entries = new Map<string, StaffSyncEntry>();
  public readonly calls: string[] = [];
  async setElement(id: string, entry: StaffSyncEntry): Promise<void> { this.calls.push(`set ${id}`); this.entries.set(id, entry); }
  async removeElement(id: string): Promise<void> { this.calls.push(`remove ${id}`); this.entries.delete(id); }
}

const PROJECT = 'a'.repeat(32);
const row = (state: string, extra: Partial<StaffStatusRow> = {}): StaffStatusRow => ({
  project: PROJECT, root: '/home/sterling/workspace/logistics', state, sentence: syncSentence({ state, findings: [] } as never), ...extra,
});

test('tracer: a live shared project puts "Synced" on the status bar, with the sentence as tooltip and Sync Now as its command', async () => {
  const bar = new FakeBar();
  const status = new StaffSyncStatus(bar);
  await status.reset([row('live')]);
  const entry = bar.entries.get(STAFF_SYNC_ENTRY);
  assert.equal(entry?.text, '$(sync) Synced');
  assert.equal(entry?.tooltip, 'Synced with your organization\'s server.');
  assert.equal(entry?.command, STAFF_SYNC_COMMAND);
  assert.equal(entry?.backgroundColor, undefined, 'a calm state has no warning look');
  assert.equal(entry?.accessibilityInformation.label, 'Sync: Synced. Synced with your organization\'s server.');
  assert.equal(status.shownProject, PROJECT);
});

test('a row going offline updates the text once, and the same row again writes nothing', async () => {
  const bar = new FakeBar();
  const status = new StaffSyncStatus(bar);
  await status.update(row('live'));
  await status.update(row('offline'));
  await status.update(row('offline'));
  assert.deepEqual(bar.calls, [`set ${STAFF_SYNC_ENTRY}`, `set ${STAFF_SYNC_ENTRY}`]);
  assert.equal(bar.entries.get(STAFF_SYNC_ENTRY)?.text, '$(sync) Offline');
  assert.match(bar.entries.get(STAFF_SYNC_ENTRY)?.tooltip ?? '', /^You are offline\./);
});

test('with no shared project open the entry is absent: never set at start, and removed when the rows go', async () => {
  const bar = new FakeBar();
  const status = new StaffSyncStatus(bar);
  await status.reset([]);
  assert.equal(bar.entries.size, 0);
  await status.update(row('live'));
  await status.reset([]);
  assert.equal(bar.entries.has(STAFF_SYNC_ENTRY), false);
  assert.equal(status.shownProject, undefined);
});

test('a Sterling status item made before this phase takes the word, and no sterling.staffSync entry is set', async () => {
  const bar = new FakeBar();
  const parts: Array<StaffSyncShown | undefined> = [];
  const item: SterlingStatusItem = { setSyncPart: (part) => { parts.push(part); } };
  const status = new StaffSyncStatus(bar, item);
  await status.update(row('attention', { sentence: 'Your organization\'s server showed an older copy of this shared work than this computer has already seen.' }));
  await status.reset([]);
  assert.deepEqual(bar.calls, [], 'Phase 33 adds no entry beside the Sterling item');
  assert.equal(parts[0]?.word, 'Needs attention');
  assert.equal(parts[0]?.warning, true);
  assert.equal(parts[1], undefined, 'the word leaves the item when no shared project is open');
});

test('the browser\'s words are liveSentences.ts SYNC_WORDS word for word, for exactly the nine states', () => {
  assert.deepEqual({ ...STAFF_SYNC_WORDS }, { ...SYNC_WORDS });
  assert.equal(SENTENCE_STATES.length, 9);
  assert.deepEqual([...STAFF_SYNC_WARNING_STATES].sort(), ['attention', 'needs-update', 'refused']);
});

for (const state of SENTENCE_STATES) {
  test(`state ${state}: its word, its sentence as tooltip, and ${STAFF_SYNC_WARNING_STATES.has(state) ? 'the warning look' : 'no warning look'}`, async () => {
    const bar = new FakeBar();
    await new StaffSyncStatus(bar).update(row(state));
    const entry = bar.entries.get(STAFF_SYNC_ENTRY);
    const warning = ['refused', 'attention', 'needs-update'].includes(state);
    assert.equal(entry?.text, `$(${warning ? 'warning' : 'sync'}) ${SYNC_WORDS[state]}`);
    assert.equal(entry?.tooltip, syncSentence({ state, findings: [] }));
    assert.equal(entry?.backgroundColor, warning ? 'var(--theia-statusBarItem-warningBackground)' : undefined);
    assert.equal(entry?.color, warning ? 'var(--theia-statusBarItem-warningForeground)' : undefined);
  });
}

test('restoring shows the offline word with RESTORING_TEXT, and no warning look (D-32)', async () => {
  const bar = new FakeBar();
  const sentence = syncSentence({ state: 'offline', reason: 'restoring', findings: [] });
  assert.equal(sentence, RESTORING_TEXT);
  await new StaffSyncStatus(bar).update(row('offline', { sentence }));
  const entry = bar.entries.get(STAFF_SYNC_ENTRY);
  assert.equal(entry?.text, '$(sync) Offline');
  assert.equal(entry?.tooltip, RESTORING_TEXT);
  assert.equal(entry?.backgroundColor, undefined);
});

test('the entry shows only words and sentences: never a name, a product, an address, a pin or the folder (T-33-76)', async () => {
  const bar = new FakeBar();
  const secrets = ['Avery Lead', 'logistics-estimate', 'hub.example.org:8443', 'f'.repeat(64), 'logistics'];
  const loaded = { ...row('refused', { root: '/home/sterling/workspace/logistics' }), name: secrets[0], product: secrets[1], address: secrets[2], certPin: secrets[3] } as StaffStatusRow;
  await new StaffSyncStatus(bar).update(loaded);
  const shown = JSON.stringify(bar.entries.get(STAFF_SYNC_ENTRY));
  for (const value of secrets) assert.equal(shown.includes(value), false, `the bar shows ${value}`);
  assert.match(shown, /Not accepted/);
});

test('with several shared projects open, the one needing a person is shown and Sync Now runs for it (T-33-77)', async () => {
  const bar = new FakeBar();
  const status = new StaffSyncStatus(bar);
  const other = 'b'.repeat(32);
  await status.reset([row('live'), row('needs-update', { project: other })]);
  assert.equal(bar.entries.get(STAFF_SYNC_ENTRY)?.text, '$(warning) Needs an update');
  assert.equal(status.shownProject, other);
  await status.update(row('live', { project: other }));
  assert.equal(bar.entries.get(STAFF_SYNC_ENTRY)?.text, '$(sync) Synced');
});

test('a state this build does not know is shown as needing attention with a plain sentence, never calm and never the raw state', async () => {
  const bar = new FakeBar();
  await new StaffSyncStatus(bar).update(row('quantum-sync', { sentence: 'internal detail' }));
  const entry = bar.entries.get(STAFF_SYNC_ENTRY);
  assert.equal(entry?.text, '$(warning) Needs attention');
  assert.equal(entry?.tooltip, 'Sterling cannot show this sync state. Ask your administrator.');
  assert.equal(JSON.stringify(entry).includes('quantum-sync'), false);
});
