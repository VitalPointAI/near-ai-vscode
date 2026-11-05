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

// 62.1-03 (D-04, T-62.1-06): timeline.js plugs into board.js like the other feature scripts, so it loads last, with the page's nonce.
test('the board loads seven files, in the order the client needs them', () => {
  assert.deepEqual([...BOARD_SCRIPTS], ['board.js', 'menu.js', 'drag.js', 'detail.js', 'form.js', 'timeline.js']);
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

test('IN-03: the form\'s limits and the duplicated command id match the one source they copy', () => {
  const validate = require('../domain/team/validate') as typeof import('../domain/team/validate');
  const form = text('form.js');
  const constant = (name: string): number => Number((new RegExp(`const ${name} = (\\d+);`).exec(form) ?? [])[1]);
  assert.equal(constant('TITLE_MAX'), validate.TITLE_MAX);
  assert.equal(constant('DESCRIPTION_MAX'), validate.DESCRIPTION_MAX);
  assert.equal(constant('FILES_MAX'), validate.MAX_SCOPE_ENTRIES);
  assert.equal(constant('ESTIMATE_MAX'), validate.MAX_ESTIMATE_TOKENS);
  const commands = require('../services/team/teamCommands') as typeof import('../services/team/teamCommands');
  const statusBar = require('../services/team/teamStatusBar') as typeof import('../services/team/teamStatusBar');
  assert.equal(statusBar.OPEN_BOARD_COMMAND, commands.OPEN_BOARD_COMMAND);
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

// 62.1-08 (found in the real window): the probe's rules 3, 11 and 12 ask that the Now pill, the percents, the phase labels, the preview and the
// expanded card show no text under 0.85 of the editor font size. VS Code's editor font (14 px) is larger than its workbench font (13 px), so a bare
// 0.85em of the page font gave 11.05 px where 11.9 px is the floor. Every Small size in the timeline's part of the stylesheet, and the board's own
// card face inside the preview and the expanded card, take that floor; Columns keeps its sizes.
test('62.1-08: the timeline\'s Small text is never under 0.85 of the editor font size, inside the preview and the expanded card too', () => {
  const css = text('board.css').replace(/\/\*[\s\S]*?\*\//g, (comment) => (comment.startsWith('/* timeline */') ? '@@timeline@@' : ''));
  const at = css.indexOf('@@timeline@@');
  assert.ok(at > 0, 'the stylesheet has its timeline part');
  const timeline = css.slice(at);
  // One Small size: 0.85em, and at least 0.85 of the editor font size (only theme variables, as the stylesheet's colour rules ask).
  const SMALL = /font-size:\s*max\(0\.85em,\s*calc\(var\(--vscode-editor-font-size(?:,\s*0px)?\)\s*\*\s*0\.85\)\)/;
  assert.match(timeline, SMALL, 'the timeline has the floored Small size');
  const bare = [...timeline.matchAll(/([^{}]+)\{[^}]*font-size:\s*0\.8\d*em/g)].map((m) => (m[1] ?? '').trim());
  assert.deepEqual(bare, [], 'no timeline rule sets a bare em Small size');
  for (const face of ['.card-meta', '.card-top .state', '.badge', '.card-msg', '.did', '.assignee-initials', '.refusal-line', '.pending-line']) {
    for (const layer of ['#tl-card', '#tl-preview']) {
      const rule = [...timeline.matchAll(/([^{}]+)\{([^}]*)\}/g)].find((m) => (m[1] ?? '').split(',').map((s) => s.trim()).includes(`${layer} ${face}`));
      assert.ok(rule !== undefined && SMALL.test(rule[2] ?? ''), `${layer} ${face} takes the Small floor`);
    }
  }
  // The milestone header's progress text and Current badge are the board's own classes, floored inside the header.
  for (const selector of ['.tl-ms-head .progress-text', '.tl-ms-head .badge']) {
    const rule = [...timeline.matchAll(/([^{}]+)\{([^}]*)\}/g)].find((m) => (m[1] ?? '').split(',').map((s) => s.trim()).includes(selector) && /font-size/.test(m[2] ?? ''));
    assert.ok(rule !== undefined && SMALL.test(rule[2] ?? ''), `${selector} takes the Small floor`);
  }
});
