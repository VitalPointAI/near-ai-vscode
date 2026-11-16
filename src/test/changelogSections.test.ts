import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// Review of PR 72: an edit meant for the Unreleased section also rewrote an already released one. Each section of the changelog is its own text: no two
// sections share a paragraph, so text copied or replaced across sections is caught here before it ships.

const CHANGELOG = path.join(__dirname, '..', '..', 'CHANGELOG.md');

test('no two changelog sections share a paragraph', () => {
  const sections = readFileSync(CHANGELOG, 'utf8').split(/^## /m).slice(1);
  const seen = new Map<string, string>();
  for (const section of sections) {
    const heading = section.slice(0, section.indexOf('\n')).trim();
    const paragraphs = section.slice(section.indexOf('\n')).split(/\n\s*\n/).map((paragraph) => paragraph.replace(/\s+/g, ' ').trim()).filter((paragraph) => paragraph.length >= 80);
    for (const paragraph of paragraphs) {
      const earlier = seen.get(paragraph);
      assert.equal(earlier, undefined, `"${paragraph.slice(0, 80)}..." is in both ${earlier} and ${heading}`);
      seen.set(paragraph, heading);
    }
  }
  assert.ok(seen.size > 0);
});
