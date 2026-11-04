// Install advice (D-12): what a one-click install would do to the user's machine, how strongly the
// harness recommends it, and the exact command for this platform. The panel shows all of it before
// the button is pressed, so nobody installs nuclei without knowing it writes to their home directory.

import assert from 'node:assert/strict';
import test from 'node:test';
import { TOOL_CATALOGUE } from '../services/cyberTools';
import { detectPlatform, ecosystemLabel, installAdvice, installAdviceFor, installSummary, INSTALL_ADVICE } from '../services/cyberInstallAdvice';

test('every catalogued tool has advice, so no missing tool is a bare name', () => {
  for (const tool of TOOL_CATALOGUE) {
    const advice = installAdviceFor(tool.name, 'debian', tool);
    assert.ok(advice.why.length > 20, `${tool.name} says why it is worth installing`);
    assert.ok(advice.footprint.length > 10, `${tool.name} says where it lands`);
    assert.ok(advice.effects.length >= 1, `${tool.name} lists what changes`);
    assert.ok(['recommended', 'useful', 'optional'].includes(advice.recommendation));
  }
});

test('the recommendation tiers are ordered, and the summary leads with the recommended count', () => {
  const advice = installAdvice(['sqlmap', 'nmap', 'nuclei', 'testssl.sh', 'trivy'], 'debian', TOOL_CATALOGUE);
  assert.deepEqual(advice.slice(0, 2).map((entry) => entry.tool), ['nmap', 'trivy'], 'recommended tools come first');
  assert.equal(advice[advice.length - 1].recommendation, 'optional');
  const summary = installSummary(advice);
  assert.match(summary, /^5 checks could not run\./);
  assert.match(summary, /2 tools would add the most/);
  assert.match(summary, /built-in probes work without any of them/);
});

test('a recommended tool carries its real effects, including the ones a user would object to', () => {
  const nmap = installAdviceFor('nmap', 'debian', TOOL_CATALOGUE.find((tool) => tool.name === 'nmap'));
  assert.equal(nmap.recommendation, 'recommended');
  assert.equal(nmap.needsElevation, true);
  assert.equal(nmap.command, 'sudo apt-get install -y nmap');
  assert.ok(nmap.effects.some((effect) => /setuid/.test(effect)), 'the security-relevant effect is stated');
  assert.ok(nmap.cautions.length >= 1, 'nmap cautions about scanning a host you do not own');

  const nuclei = installAdviceFor('nuclei', 'debian', TOOL_CATALOGUE.find((tool) => tool.name === 'nuclei'));
  assert.equal(nuclei.needsElevation, false, 'a Go install lands in the home directory');
  assert.ok(nuclei.footprint.includes('~/go/bin'), 'the footprint names the real location');
  assert.ok(nuclei.effects.some((effect) => /nuclei-templates/.test(effect)), 'the template download is disclosed');
  assert.ok(nuclei.cautions.some((caution) => /Go/.test(caution)), 'the Go prerequisite is named');
});

test('the command is per platform, and an unsupported platform says so rather than guessing', () => {
  const debian = installAdviceFor('nmap', 'debian', TOOL_CATALOGUE[0]);
  const macos = installAdviceFor('nmap', 'macos', TOOL_CATALOGUE[0]);
  assert.match(debian.command ?? '', /apt-get install/);
  assert.match(macos.command ?? '', /brew install/);
  assert.equal(macos.needsElevation, false, 'brew does not need an administrator password');

  const other = installAdviceFor('nmap', 'other', TOOL_CATALOGUE[0]);
  assert.equal(other.command, undefined, 'an unknown platform gets no invented command');
  assert.ok(other.why.length > 20, 'the advice is still shown');
});

test('the macos Go tools use brew rather than a home-directory Go install', () => {
  const nuclei = installAdviceFor('nuclei', 'macos');
  assert.equal(nuclei.command, 'brew install nuclei');
});

test('every command is a runnable string, not prose', () => {
  for (const [tool, advice] of Object.entries(INSTALL_ADVICE)) {
    for (const [platform, entry] of Object.entries(advice.commands)) {
      assert.ok(entry && typeof entry.command === 'string', `${tool} on ${platform} has a command`);
      assert.doesNotMatch(entry!.command, /\(or |\)$/, `${tool} on ${platform}: "${entry!.command}" must be a single command, not a menu`);
      assert.match(entry!.command, /^[a-z]/, `${tool} on ${platform} starts with a program`);
    }
  }
});

test('platform detection maps the three cases', () => {
  assert.equal(detectPlatform('linux'), 'debian');
  assert.equal(detectPlatform('darwin'), 'macos');
  assert.equal(detectPlatform('win32'), 'other');
});

test('an unknown tool is described honestly rather than omitted', () => {
  const advice = installAdviceFor('some-tool');
  assert.equal(advice.tool, 'some-tool');
  assert.match(advice.cautions[0], /Install it yourself/);
  assert.ok(ecosystemLabel('apt').includes('apt'));
  assert.ok(ecosystemLabel('pip').length > 0);
});
