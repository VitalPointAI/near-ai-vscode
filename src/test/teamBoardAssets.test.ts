// The Team Board's page files (Phase 62 plan 14): every file the host loads exists, is on the release list, and keeps the page's safety rules:
// no dash characters in the text, no markup strings, no colour literals (the theme supplies colour), no network, and one IIFE per script.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { createVscodeStub, installVscodeStub } from './helpers/vscodeStub';

const stub = createVscodeStub();
const uninstall = installVscodeStub(stub);
const boardModule = require('../services/team/boardView') as typeof import('../services/team/boardView');
test.after(() => { uninstall(); });

const ROOT = path.resolve(__dirname, '..', '..');
const { BOARD_SCRIPTS, BOARD_STYLES } = boardModule;
const files = [...BOARD_SCRIPTS, ...BOARD_STYLES];
const text = (file: string): string => readFileSync(path.join(ROOT, 'media', 'board', file), 'utf8');
const release = readFileSync(path.join(ROOT, 'scripts', 'verify-release-content.mjs'), 'utf8');

test('the board loads six files, in the order the client needs them', () => {
  assert.deepEqual([...BOARD_SCRIPTS], ['board.js', 'menu.js', 'drag.js', 'detail.js', 'form.js']);
  assert.deepEqual([...BOARD_STYLES], ['board.css']);
});

test('every board script and stylesheet exists and is on the release content list', () => {
  for (const file of files) {
    assert.ok(text(file).length > 0, `${file} exists and is not empty`);
    assert.ok(release.includes(`'extension/media/board/${file}'`), `${file} is listed in verify-release-content.mjs`);
  }
  const listed = [...release.matchAll(/'extension\/media\/board\/([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual([...listed].sort(), [...files].sort(), 'the release list has exactly the files the host loads');
});

test('no board file contains an en dash or an em dash', () => {
  for (const file of files) assert.ok(!/[–—]/.test(text(file)), `${file} has a dash character`);
});

test('no board script builds markup from a string, evaluates code or reaches the network', () => {
  const sinks = [/\.innerHTML\b/, /\.outerHTML\b/, /\binsertAdjacentHTML\b/, /\bdocument\.write\b/, /\bsrcdoc\b/, /\beval\s*\(/, /\bnew\s+Function\b/, /\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bWebSocket\b/, /\bEventSource\b/, /\bsendBeacon\b/, /\bimportScripts\b/];
  for (const file of BOARD_SCRIPTS) {
    for (const sink of sinks) assert.ok(!sink.test(text(file)), `${file} uses ${sink}`);
  }
});

test('CR-01: no board script calls an Array method straight on a querySelectorAll, children or childNodes result', () => {
  // A NodeList has forEach and iteration but no map, filter, find, indexOf or some, and an HTMLCollection has no forEach either; such a call throws
  // in the real webview. The fake DOM has the same shapes now (WR-05); this is the cheap static half of the same rule.
  const misuse = /(?:querySelectorAll\([^()]*\)|\.children|\.childNodes)\s*\.\s*(?:map|filter|find|findIndex|indexOf|some|every|reduce|includes|slice|concat|flatMap)\s*\(/;
  for (const file of BOARD_SCRIPTS) assert.equal(misuse.test(text(file)), false, `${file} calls an Array method on a NodeList or HTMLCollection`);
});

test('T-62-46: form.js keeps every host secret pattern, so the stored draft leaves out what the host would refuse', () => {
  const { SECRET_PATTERNS } = require('../domain/team/secrets') as typeof import('../domain/team/secrets');
  const form = text('form.js');
  for (const pattern of SECRET_PATTERNS) {
    const literal = `/${pattern.source.replace(/\\\//g, '/')}/${pattern.flags}`;
    assert.ok(form.includes(literal), `form.js has ${literal}`);
  }
});

test('every board script is one strict-mode IIFE', () => {
  for (const file of BOARD_SCRIPTS) {
    const code = text(file).split('\n').filter((line) => !/^\s*(\/\/.*)?$/.test(line));
    assert.match(code[0] ?? '', /^\(function \(\) \{$/, `${file} starts with an IIFE`);
    assert.equal(code[1]?.trim(), "'use strict';", `${file} is strict`);
    assert.match(code[code.length - 1] ?? '', /^\}\)?\(\)\)?;$/, `${file} ends with the call`);
  }
});

test('the stylesheet has no colour literal: the VS Code theme variables supply every colour', () => {
  const css = text('board.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), 'no hex colour');
  assert.ok(!/\b(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\s*\(/i.test(css), 'no colour function');
  assert.ok(css.includes('--vscode-'), 'the theme variables are used');
});
