#!/usr/bin/env node
// The WP-R0 CRDT spike (D-22): measure Yjs update sizes, full-state size and garbage
// collection over a simulated multi-page product with many authors, check convergence and
// attribution, and write the numbers to a markdown report.
//
// It loads the vendored bundle vendor/yjs/yjs.cjs (built by scripts/vendor-libs.mjs, the same
// bytes the extension ships), uses only Node built-ins, and runs on synthetic text, so the
// report holds numbers and never document content. It is not product code and is not shipped
// (.vscodeignore excludes scripts/**).
//
// Usage: node scripts/crdt-spike.mjs [--pages 30] [--persons 12] [--agents 8]
//                                    [--seed 30,31,32] [--out <report.md>]
// Exit code 1 when convergence or attribution fails (the seed is printed) or the bundle on disk
// does not match scripts/crdt-vendor.json.

import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import v8 from 'node:v8';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const bundlePath = path.join(root, 'vendor', 'yjs', 'yjs.cjs');
const manifest = JSON.parse(readFileSync(path.join(root, 'scripts', 'crdt-vendor.json'), 'utf8'));

/** Fixed thresholds (planner's, reversible; see 30-03-PLAN objective). */
export const THRESHOLDS = {
  bytesPerCharacter: 8,
  loadMilliseconds: 500,
  heapMegabytes: 256,
  laterUpdates: 500,
  gcSavingRecordPercent: 25,
};

const CHARS_PER_PAGE = 3000;

const { Y: YDefault, sha256: bundleSha256 } = loadYjs();

// A forced garbage collection, so heap numbers are not dominated by garbage still waiting.
v8.setFlagsFromString('--expose-gc');
const forceGc = vm.runInNewContext('gc');

/** A small seeded generator (xorshift32), the same pattern as src/test/stateMerge.test.ts. */
function rng(seed) {
  let state = (seed * 2654435761) >>> 0 || 1;
  const next = () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 4294967296;
  };
  return {
    next,
    int: (n) => Math.floor(next() * n),
    range: (a, b) => a + Math.floor(next() * (b - a + 1)),
    chance: (p) => next() < p,
  };
}

function loadYjs() {
  const bytes = readFileSync(bundlePath);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== manifest.output.sha256) {
    throw new Error(`vendor/yjs/yjs.cjs sha256 ${actual} does not match scripts/crdt-vendor.json ${manifest.output.sha256}; run node scripts/vendor-libs.mjs`);
  }
  return { Y: require(bundlePath), sha256: actual };
}

// ---------------------------------------------------------------------------------------
// Synthetic text
// ---------------------------------------------------------------------------------------

function makeVocabulary(random) {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const words = [];
  for (let i = 0; i < 300; i++) {
    let word = '';
    for (let n = random.range(2, 9); n > 0; n--) word += letters[random.int(letters.length)];
    words.push(word);
  }
  return words;
}

/** Exactly `length` characters of plain words; paragraph breaks only when asked for. */
function words(random, vocabulary, length, paragraphs) {
  let out = '';
  while (out.length < length) {
    out += vocabulary[random.int(vocabulary.length)];
    if (paragraphs && random.chance(0.012)) out += '\n\n';
    else out += random.chance(0.08) ? '. ' : ' ';
  }
  return out.slice(0, length);
}

// ---------------------------------------------------------------------------------------
// Workload
// ---------------------------------------------------------------------------------------

/**
 * Build a seeded concurrent workload. Each author (person or agent run) has its own Y.Doc and
 * client id; other authors receive each update after a random delay, so edits are genuinely
 * concurrent. Returns every update with its pattern, the per-author record of what each author
 * typed (for the attribution check) and the text the authors ended with.
 */
export function workload(random, options, Y = YDefault) {
  const authorCount = options.persons + options.agents;
  const vocabulary = makeVocabulary(random);
  const target = options.pages * CHARS_PER_PAGE;
  const authors = [];
  for (let i = 0; i < authorCount; i++) {
    const doc = new Y.Doc(); // an editor replica: garbage collection on, as in a real editor
    const isAgent = i >= options.persons;
    const author = { index: i, isAgent, doc, text: doc.getText('body'), cursor: 0, inbox: [], typedClock: 0 };
    authors.push(author);
  }
  const updates = []; // creation order, which is causal order (an update is made after its inputs arrived)
  const typed = new Map(); // client id -> array indexed by clock holding the character typed there
  let step = 0;
  let current = null; // the author being run, so the update listener can file the update
  let currentKind = 'typing';

  for (const author of authors) {
    typed.set(author.doc.clientID, []);
    author.doc.on('update', (bytes, origin) => {
      if (origin !== 'local') return;
      updates.push({ bytes, kind: currentKind, author: author.index, client: author.doc.clientID });
      for (const other of authors) {
        if (other === author) continue;
        other.inbox.push({ due: step + random.int(13), bytes });
      }
    });
  }

  const insertChars = (author, position, str) => {
    // The author's own clock before the insert is the clock of the first inserted character.
    const clock = Y.getState(author.doc.store, author.doc.clientID);
    const record = typed.get(author.doc.clientID);
    if (record.length !== clock) throw new Error(`authorship record out of step for author ${author.index}: ${record.length} vs clock ${clock}`);
    author.text.insert(position, str);
    for (let i = 0; i < str.length; i++) record.push(str[i]);
    if (Y.getState(author.doc.store, author.doc.clientID) !== record.length) {
      throw new Error(`insert advanced the clock by an unexpected amount for author ${author.index}`);
    }
  };

  const clamp = (value, max) => Math.max(0, Math.min(value, max));

  const doTyping = (author) => {
    // Sequential typing at a cursor, with an occasional jump, as a person writes.
    if (random.chance(0.1)) author.cursor = random.int(author.text.length + 1);
    const at = clamp(author.cursor, author.text.length);
    const str = random.chance(0.02) ? '\n\n' : words(random, vocabulary, random.range(1, 40), false);
    current = author; currentKind = 'typing';
    author.doc.transact(() => insertChars(author, at, str), 'local');
    author.cursor = at + str.length;
  };

  const doDelete = (author) => {
    if (author.text.length < 40) return doTyping(author);
    const len = random.range(1, 30);
    const at = clamp(author.cursor - len, author.text.length - len);
    current = author; currentKind = 'delete';
    author.doc.transact(() => author.text.delete(at, len), 'local');
    author.cursor = at;
  };

  const doPaste = (author) => {
    const size = author.isAgent ? random.range(200, 3000) : random.range(500, 3000);
    const at = random.int(author.text.length + 1);
    const str = words(random, vocabulary, size, true);
    current = author; currentKind = 'paste';
    author.doc.transact(() => insertChars(author, at, str), 'local');
    author.cursor = at + str.length;
  };

  const doRewrite = (author) => {
    const whole = author.text.toString();
    if (whole.length < 400) return doPaste(author);
    const p = random.int(whole.length);
    let start = whole.lastIndexOf('\n\n', p);
    start = start < 0 ? Math.max(0, p - 600) : start + 2;
    let end = whole.indexOf('\n\n', p);
    end = end < 0 ? Math.min(whole.length, p + 600) : end;
    end = Math.min(end, start + CHARS_PER_PAGE);
    if (end - start < 20) return doTyping(author);
    const replacement = words(random, vocabulary, Math.max(20, Math.round((end - start) * (0.6 + random.next() * 0.8))), false);
    current = author; currentKind = 'rewrite';
    author.doc.transact(() => {
      author.text.delete(start, end - start);
      insertChars(author, start, replacement);
    }, 'local');
    author.cursor = start + replacement.length;
  };

  const deliver = (author) => {
    if (author.inbox.length === 0) return;
    const due = [];
    const later = [];
    for (const item of author.inbox) (item.due <= step ? due : later).push(item);
    author.inbox = later;
    for (const item of due) Y.applyUpdate(author.doc, item.bytes, 'remote');
  };

  let peakHeap = 0;
  const maxSteps = 2_000_000;
  for (step = 0; step < maxSteps; step++) {
    const author = authors[random.int(authorCount)];
    deliver(author);
    const roll = random.next();
    if (author.isAgent) {
      // An agent run writes in blocks and rewrites; occasional small typing.
      if (roll < 0.5) doPaste(author);
      else if (roll < 0.85) doRewrite(author);
      else doTyping(author);
    } else if (roll < 0.86) doTyping(author);
    else if (roll < 0.93) doDelete(author);
    else if (roll < 0.95) doPaste(author);
    else doRewrite(author);
    if (step % 50 === 0) {
      peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
      if (authors[random.int(authorCount)].text.length >= target) break;
    }
  }
  if (step >= maxSteps) throw new Error('the workload never reached its target length');

  // Let every delayed update arrive, in order of due time, then check the authors agree.
  step = Number.MAX_SAFE_INTEGER;
  for (const author of authors) {
    author.inbox.sort((a, b) => a.due - b.due);
    deliver(author);
  }
  // A second pass: an update applied early may have been held back by a missing dependency.
  for (const author of authors) deliver(author);
  const finalText = authors[0].text.toString();
  for (const author of authors) {
    if (author.text.toString() !== finalText) {
      throw new Error(`authors did not converge after delivery (author ${author.index} differs)`);
    }
  }
  peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
  const stepsRun = updates.length;
  for (const author of authors) author.doc.destroy();
  return { updates, typed, finalLength: finalText.length, finalText, peakHeap, stepsRun, authorCount };
}

// ---------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------

function freshDoc(Y, gc) { return new Y.Doc({ gc }); }

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function shuffled(random, items) {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = random.int(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** Two replicas fed the updates in different shuffled orders, with duplicates, must agree. */
export function checkConvergence(updates, random, Y = YDefault) {
  const feed = (order) => {
    const doc = freshDoc(Y, false);
    for (const bytes of order) Y.applyUpdate(doc, bytes, 'remote');
    return doc;
  };
  const withDuplicates = (order) => {
    const out = order.slice();
    for (let i = 0; i < Math.ceil(order.length * 0.05); i++) out.splice(random.int(out.length + 1), 0, order[random.int(order.length)]);
    return out;
  };
  const all = updates.map((u) => u.bytes);
  const a = feed(withDuplicates(shuffled(random, all)));
  const b = feed(withDuplicates(shuffled(random, all)));
  const textA = a.getText('body').toString();
  const textB = b.getText('body').toString();
  const svA = Y.encodeStateVector(a);
  const svB = Y.encodeStateVector(b);
  const pending = [a, b].some((d) => d.store.pendingStructs !== null || d.store.pendingDs !== null);
  const ok = textA === textB && sameBytes(svA, svB) && !pending;
  const result = { ok, textLength: textA.length, pending };
  a.destroy(); b.destroy();
  return result;
}

/** Every live character's item client id must be the author who typed that character. */
export function checkAttribution(doc, authorship) {
  const text = doc.getText('body');
  let live = 0;
  let wrongClient = 0;
  let wrongText = 0;
  for (let item = text._start; item !== null; item = item.right) {
    if (item.deleted || item.content.getRef() !== 4) continue;
    const str = item.content.str;
    const record = authorship.get(item.id.client);
    if (!record) { wrongClient += str.length; continue; }
    for (let i = 0; i < str.length; i++) {
      if (record[item.id.clock + i] !== str[i]) wrongText++;
    }
    live += str.length;
  }
  const ok = wrongClient === 0 && wrongText === 0 && live === text.length;
  return { ok, live, wrongClient, wrongText };
}

// ---------------------------------------------------------------------------------------
// Measurements
// ---------------------------------------------------------------------------------------

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

function sizeStats(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return {
    count: sorted.length,
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.length ? sorted[sorted.length - 1] : 0,
  };
}

function medianOf(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function timeIt(fn, repeats = 3) {
  const times = [];
  for (let i = 0; i < repeats; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  return medianOf(times);
}

/** Sizes, timings and heap for one workload's updates. Returns the gc-off doc for the attribution check. */
export function measure(updates, options, Y = YDefault, extras = {}) {
  const byKind = {};
  for (const kind of ['typing', 'delete', 'paste', 'rewrite']) {
    byKind[kind] = sizeStats(updates.filter((u) => u.kind === kind).map((u) => u.bytes.length));
  }
  const sum = updates.reduce((total, u) => total + u.bytes.length, 0);

  // The fold document: garbage collection off, every update applied in creation order.
  const applyAll = () => {
    const doc = freshDoc(Y, false);
    for (const u of updates) Y.applyUpdate(doc, u.bytes, 'remote');
    return doc;
  };
  const applyMs = timeIt(() => applyAll().destroy());
  const offDoc = applyAll();
  const finalLength = offDoc.getText('body').length;
  const fullOff = Y.encodeStateAsUpdate(offDoc);

  const onDoc = freshDoc(Y, true);
  for (const u of updates) Y.applyUpdate(onDoc, u.bytes, 'remote');
  const fullOn = Y.encodeStateAsUpdate(onDoc);
  const onLength = onDoc.getText('body').length;
  onDoc.destroy();

  // Compaction at the point before the last N updates, then those updates on top of it.
  const cut = Math.max(0, updates.length - THRESHOLDS.laterUpdates);
  const earlier = freshDoc(Y, false);
  for (let i = 0; i < cut; i++) Y.applyUpdate(earlier, updates[i].bytes, 'remote');
  const compactionAtCut = Y.encodeStateAsUpdate(earlier);
  earlier.destroy();
  const later = updates.slice(cut);
  const loadMs = timeIt(() => {
    const doc = freshDoc(Y, false);
    Y.applyUpdate(doc, compactionAtCut, 'remote');
    for (const u of later) Y.applyUpdate(doc, u.bytes, 'remote');
    doc.destroy();
  });

  // Walk the item list, as attribution does.
  const text = offDoc.getText('body');
  let walked = 0;
  const walkMs = timeIt(() => {
    walked = 0;
    for (let item = text._start; item !== null; item = item.right) if (!item.deleted) walked += item.length;
  }, 5);

  // Heap: the cost of holding the fold document, measured after a forced collection, and the
  // peak the whole workload reached (twenty live editor replicas are part of that).
  forceGc();
  const heapNow = process.memoryUsage().heapUsed;
  const heapPeak = Math.max(extras.peakHeap ?? 0, heapNow);

  return {
    updateCount: updates.length,
    byKind,
    sum,
    finalLength,
    gcOnLength: onLength,
    fullOff: fullOff.length,
    fullOn: fullOn.length,
    compaction: fullOff.length,
    compactionAtCut: compactionAtCut.length,
    cut,
    laterCount: later.length,
    applyMs,
    loadMs,
    walkMs,
    walkedCharacters: walked,
    bytesPerCharacter: fullOff.length / Math.max(1, finalLength),
    heapNow,
    heapPeak,
    doc: offDoc,
  };
}

// ---------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------

const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const mb = (bytes) => (bytes / 1048576).toFixed(1);

function verdictOf(results) {
  const crossed = [];
  for (const r of results) {
    const m = r.measures;
    if (m.bytesPerCharacter > THRESHOLDS.bytesPerCharacter) crossed.push(`seed ${r.seed}: gc-off full state is ${m.bytesPerCharacter.toFixed(2)} bytes per character, above ${THRESHOLDS.bytesPerCharacter}`);
    if (m.loadMs > THRESHOLDS.loadMilliseconds) crossed.push(`seed ${r.seed}: loading a compaction plus ${m.laterCount} updates took ${m.loadMs.toFixed(0)} ms, above ${THRESHOLDS.loadMilliseconds} ms`);
    if (m.heapPeak / 1048576 > THRESHOLDS.heapMegabytes) crossed.push(`seed ${r.seed}: heap reached ${mb(m.heapPeak)} MB, above ${THRESHOLDS.heapMegabytes} MB`);
  }
  return crossed;
}

export function report(results, options, env) {
  const lines = [];
  const L = (s = '') => lines.push(s);
  L('# CRDT spike (WP-R0, D-22)');
  L();
  L('Measured with `node scripts/crdt-spike.mjs`, a seeded script over the vendored Yjs bundle. The numbers below are regenerated by that script; nothing here is hand-typed.');
  L();
  L('## Method');
  L();
  L(`- Workload: a simulated ${options.pages}-page product (target about ${CHARS_PER_PAGE} characters per page of final text), ${options.persons} persons and ${options.agents} agent runs, each author with its own Yjs document and client id. Authors take random turns; every update reaches each other author after a random delay of 0 to 12 turns, so edits are genuinely concurrent.`);
  L('- Persons mostly type in batches of 1 to 40 characters at a cursor (one update per batch, as a 500 ms batch would give), sometimes delete, paste 500 to 3000 characters, or rewrite a paragraph. Agent runs mostly paste blocks of 200 to 3000 characters and rewrite paragraphs, with a little typing.');
  L('- The fold document is garbage collection off (needed for versions and deletion records, 30-RESEARCH "Yjs facts" item 9). The compaction is the full state of that document. The "garbage collection on" figure is the full state of a document fed the same updates with collection on.');
  L('- Load time is a compaction taken before the last 500 updates, loaded into a fresh document, then those 500 updates applied. Timings are the median of three runs (walk: five); heap is `process.memoryUsage().heapUsed` after a forced collection, and the peak sampled during the workload, which includes all live editor replicas.');
  L('- Convergence: two fresh garbage-collection-off documents fed all updates in two different shuffled orders, each with 5 percent duplicates, must end with equal text and equal state vector and nothing pending. Attribution: every live character in the final document sits in an item whose client id is the author who typed that character at that clock. A failure of either prints the seed and exits with code 1.');
  L();
  L('## Environment');
  L();
  L(`- Node ${env.node}, ${env.platform}`);
  L(`- yjs ${env.yjs}, lib0 ${env.lib0}`);
  L(`- vendor/yjs/yjs.cjs sha256 ${env.bundleSha256} (matches scripts/crdt-vendor.json)`);
  L(`- Options: pages ${options.pages}, persons ${options.persons}, agents ${options.agents}, seeds ${results.map((r) => r.seed).join(', ')}`);
  L(`- Run: ${env.date}`);
  L();
  L('## Thresholds');
  L();
  L(`- gc-off full state above ${THRESHOLDS.bytesPerCharacter} bytes per character of final text is a size problem.`);
  L(`- A compaction plus ${THRESHOLDS.laterUpdates} later updates taking over ${THRESHOLDS.loadMilliseconds} ms to load on this machine is a size problem.`);
  L(`- Heap above ${THRESHOLDS.heapMegabytes} MB for the workload is a size problem.`);
  L('- Research\'s preliminary figure was about 3.6 bytes per character and 73 ms to apply 8000 updates.');
  L();

  for (const r of results) {
    const m = r.measures;
    L(`## seed ${r.seed}`);
    L();
    L(`Updates ${m.updateCount}, final text ${m.finalLength} characters, ${options.persons + options.agents} authors. Convergence: ${r.convergence.ok ? 'held' : 'FAILED'}. Attribution: ${r.attribution.ok ? 'held' : 'FAILED'} (${r.attribution.live} live characters checked).`);
    L();
    L('| Update size by pattern (bytes) | count | median | p95 | p99 | max |');
    L('|---|---|---|---|---|---|');
    const names = { typing: 'typing batches (at most 500 ms)', delete: 'deletions', paste: 'paste blocks', rewrite: 'paragraph rewrites' };
    for (const kind of ['typing', 'delete', 'paste', 'rewrite']) {
      const s = m.byKind[kind];
      L(`| ${names[kind]} | ${s.count} | ${fmt(s.median)} | ${fmt(s.p95)} | ${fmt(s.p99)} | ${fmt(s.max)} |`);
    }
    L();
    L('| Measurement | Value |');
    L('|---|---|');
    L(`| Sum of all updates | ${m.sum} bytes |`);
    L(`| Full state, garbage collection off | ${m.fullOff} bytes (${m.bytesPerCharacter.toFixed(2)} bytes per character) |`);
    L(`| Full state, garbage collection on | ${m.fullOn} bytes (${(100 * (m.fullOff - m.fullOn) / m.fullOff).toFixed(1)} percent smaller than off) |`);
    L(`| Compaction (full state of the gc-off document) | ${m.compaction} bytes |`);
    L(`| Apply every update to a fresh document | ${m.applyMs.toFixed(0)} ms |`);
    L(`| Load a compaction plus the last ${m.laterCount} updates | ${m.loadMs.toFixed(0)} ms (compaction at that point ${m.compactionAtCut} bytes) |`);
    L(`| Walk the text for attribution | ${m.walkMs.toFixed(1)} ms |`);
    L(`| Heap used after the run (forced collection) | ${mb(m.heapNow)} MB |`);
    L(`| Heap used, peak during the workload | ${mb(m.heapPeak)} MB |`);
    L();
  }

  const across = (pick) => {
    const values = results.map((r) => pick(r.measures));
    return [Math.min(...values), Math.max(...values)];
  };
  L('## Summary across seeds');
  L();
  L('| Measurement | min | max |');
  L('|---|---|---|');
  const row = (label, pick, digits = 0) => {
    const [lo, hi] = across(pick);
    L(`| ${label} | ${lo.toFixed(digits)} | ${hi.toFixed(digits)} |`);
  };
  row('Final text (characters)', (m) => m.finalLength);
  row('Typing update median (bytes)', (m) => m.byKind.typing.median);
  row('Typing update p99 (bytes)', (m) => m.byKind.typing.p99);
  row('Typing update max (bytes)', (m) => m.byKind.typing.max);
  row('Paste update max (bytes)', (m) => m.byKind.paste.max);
  row('Rewrite update max (bytes)', (m) => m.byKind.rewrite.max);
  row('Sum of all updates (bytes)', (m) => m.sum);
  row('Full state, gc off (bytes)', (m) => m.fullOff);
  row('Full state, gc on (bytes)', (m) => m.fullOn);
  row('gc-off bytes per character', (m) => m.bytesPerCharacter, 2);
  row('gc saving (percent of gc-off)', (m) => 100 * (m.fullOff - m.fullOn) / m.fullOff, 1);
  row('Apply all updates (ms)', (m) => m.applyMs);
  row('Load compaction plus later updates (ms)', (m) => m.loadMs);
  row('Attribution walk (ms)', (m) => m.walkMs, 1);
  row('Heap peak (MB)', (m) => m.heapPeak / 1048576, 1);
  L();

  const crossed = verdictOf(results);
  const [savingLow] = across((m) => 100 * (m.fullOff - m.fullOn) / m.fullOff);
  L('## Verdict');
  L();
  if (crossed.length === 0) {
    L('Verdict: No size or garbage collection problem found. Convergence and attribution held on every seed. A garbage-collection-off fold document and compaction blobs are affordable at this size.');
  } else {
    L(`Verdict: size or garbage collection problem found. ${crossed.join('; ')}.`);
    L();
    L('Fallback: Loro behind `src/domain/replica/doc.ts` is the named alternative (D-17). Per D-22 this does not block the phase.');
  }
  L();
  if (savingLow > THRESHOLDS.gcSavingRecordPercent) {
    L(`Input for Phase 33's compaction default: garbage collection on was at least ${savingLow.toFixed(1)} percent smaller than off on every seed (above the ${THRESHOLDS.gcSavingRecordPercent} percent mark). Nothing changes in this phase; the fold document stays garbage collection off for versions and deletion records.`);
  } else {
    L(`Garbage collection on was never more than ${THRESHOLDS.gcSavingRecordPercent} percent smaller than off on every seed (smallest saving ${savingLow.toFixed(1)} percent), so there is no size reason to prefer a garbage-collected compaction by default. The fold document stays garbage collection off for versions and deletion records.`);
  }
  L();
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------

function parseArgs(argv) {
  const options = {
    pages: 30,
    persons: 12,
    agents: 8,
    seeds: [30, 31, 32],
    out: path.join(root, '.planning', 'phases', '30-replication-contract-and-co-editing-core', '30-CRDT-SPIKE.md'),
  };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    if (flag === '--pages') options.pages = Number(value);
    else if (flag === '--persons') options.persons = Number(value);
    else if (flag === '--agents') options.agents = Number(value);
    else if (flag === '--seed') options.seeds = value.split(',').map(Number);
    else if (flag === '--out') options.out = path.resolve(value);
    else throw new Error(`unknown option ${flag}`);
  }
  for (const key of ['pages', 'persons', 'agents']) {
    if (!Number.isInteger(options[key]) || options[key] < (key === 'agents' ? 0 : 1)) throw new Error(`--${key} must be a whole number`);
  }
  if (options.persons + options.agents < 1) throw new Error('need at least one author');
  if (options.seeds.some((s) => !Number.isInteger(s) || s < 1)) throw new Error('--seed must be positive whole numbers');
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const Y = YDefault;
  const sha256 = bundleSha256;
  const packages = Object.fromEntries(manifest.packages.map((p) => [p.name, p.version]));
  const results = [];
  for (const seed of options.seeds) {
    forceGc();
    const random = rng(seed);
    const w = workload(random, options, Y);
    const m = measure(w.updates, options, Y, { peakHeap: w.peakHeap });
    const attribution = checkAttribution(m.doc, w.typed);
    const convergence = checkConvergence(w.updates, rng(seed + 1000), Y);
    const sameAsAuthors = m.doc.getText('body').toString() === w.finalText;
    m.doc.destroy();
    delete m.doc;
    console.log(`seed ${seed}: ${m.updateCount} updates, ${m.finalLength} chars, full state ${m.fullOff} B (gc off) / ${m.fullOn} B (gc on), convergence ${convergence.ok}, attribution ${attribution.ok}`);
    if (!convergence.ok || !attribution.ok || !sameAsAuthors) {
      console.error(`FAILED seed ${seed}: convergence ${JSON.stringify(convergence)}, attribution ${JSON.stringify(attribution)}, foldMatchesAuthors ${sameAsAuthors}`);
      process.exit(1);
    }
    results.push({ seed, measures: m, convergence, attribution });
  }
  const text = report(results, options, {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    yjs: packages.yjs,
    lib0: packages.lib0,
    bundleSha256: sha256,
    date: new Date().toISOString().slice(0, 10),
  });
  writeFileSync(options.out, text);
  console.log(`report written to ${options.out}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
