// The canary scanners (TMR-03) look through separators and line wraps: a key rendering split with '-', ':', spaces, tabs or line breaks (also as the
// text escapes of a JSON string) is found by the plain scanners and by the digest scanners, in files and in git objects. The limits are in the helper header.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { DEVICE_KEY_SECRET, createDeviceIdentity } from '../team/identity';
import { deviceKeyFormDigests, deviceKeyForms, scanFiles, scanFilesForDigests, scanGitObjects, scanGitObjectsForDigests } from './helpers/teamCanary';
import type { LabelledDigest, Needle } from './helpers/teamCanary';
import { MemorySecrets } from './helpers/teamHarness';

function chunks(text: string, size: number): string[] {
  const parts: string[] = [];
  for (let index = 0; index < text.length; index += size) parts.push(text.slice(index, index + size));
  return parts;
}

// Every way of splitting one rendering that the scanners are meant to see through. Each result differs from the rendering itself.
function splitRenderings(form: string): Array<{ name: string; text: string }> {
  const isHex = /^[0-9a-f]+$/.test(form);
  const out: Array<{ name: string; text: string }> = [];
  for (const size of [8, 16, 32]) {
    const parts = chunks(form, size);
    if (parts.length < 2) continue;
    for (const [label, joiner] of [['LF wrap', '\n'], ['CRLF wrap', '\r\n'], ['escaped LF wrap', '\\n'], ['escaped CRLF wrap', '\\r\\n'], ['space', ' '], ['tab', '\t'], ['colon', ':'], ['colon and space', ': ']] as const) {
      out.push({ name: `${label} every ${size}`, text: parts.join(joiner) });
    }
    if (isHex) out.push({ name: `dash every ${size}`, text: parts.join('-') });
  }
  if (isHex) {
    out.push({ name: 'colon between bytes', text: chunks(form, 2).join(':') });
    out.push({ name: 'space between bytes', text: chunks(form, 2).join(' ') });
    out.push({ name: 'dash between bytes', text: chunks(form, 2).join('-') });
  }
  return out;
}

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-canary-split-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function freshKey(): Promise<{ stored: string; forms: string[] }> {
  const secrets = new MemorySecrets();
  await createDeviceIdentity(secrets);
  const stored = secrets.values.get(DEVICE_KEY_SECRET) as string;
  return { stored, forms: deviceKeyForms(stored) };
}

test('the plain scanners find a key rendering split by separators or wrapped over lines, in a file and in a git object, and not another key\'s', async () => {
  const { forms } = await freshKey();
  const other = await freshKey();
  const needles: Needle[] = forms.map((value, index) => ({ label: `key form ${index}`, value }));
  await withDir(async (dir) => {
    const files = path.join(dir, 'files');
    await mkdir(files);
    const repo = path.join(dir, 'repo.git');
    execFileSync('git', ['init', '--bare', '-q', repo]);
    let planted = 0;
    for (const [index, form] of forms.entries()) {
      for (const variant of splitRenderings(form)) {
        const file = path.join(files, 'planted.txt');
        await writeFile(file, `{"note":"before ${variant.text} after"}\n`, 'utf8');
        const hits = (await scanFiles([files], needles)).map((hit) => hit.split(': ')[1]);
        assert.ok(hits.includes(`key form ${index}`), `form ${index}, ${variant.name}, is found in a file`);
        execFileSync('git', ['--git-dir', repo, 'hash-object', '-w', '--stdin'], { input: `{"note":"${variant.text}"}\n` });
        planted += 1;
      }
    }
    assert.ok(planted >= forms.length * 6, `a spread of splits was planted (${planted})`);
    const inObjects = await scanGitObjects(repo, needles);
    for (const index of forms.keys()) assert.ok(inObjects.includes(`key form ${index}`), `form ${index} is found in a git object`);

    // Another key, split the same ways, matches nothing.
    const clean = path.join(dir, 'clean');
    await mkdir(clean);
    const cleanRepo = path.join(dir, 'clean.git');
    execFileSync('git', ['init', '--bare', '-q', cleanRepo]);
    for (const [index, form] of other.forms.entries()) {
      for (const [variantIndex, variant] of splitRenderings(form).entries()) {
        await writeFile(path.join(clean, `other-${index}-${variantIndex}.txt`), variant.text, 'utf8');
        execFileSync('git', ['--git-dir', cleanRepo, 'hash-object', '-w', '--stdin'], { input: variant.text });
      }
    }
    assert.deepEqual(await scanFiles([clean], needles), []);
    assert.deepEqual(await scanGitObjects(cleanRepo, needles), []);
  });
});

test('the digest scanners find a split or wrapped private rendering in a file and in a git object, and not another key\'s', async () => {
  const { stored, forms } = await freshKey();
  const other = await freshKey();
  const digests: LabelledDigest[] = deviceKeyFormDigests(stored).map((digest, index) => ({ ...digest, label: `private form ${index}` }));
  await withDir(async (dir) => {
    const files = path.join(dir, 'files');
    await mkdir(files);
    const repo = path.join(dir, 'repo.git');
    execFileSync('git', ['init', '--bare', '-q', repo]);
    for (const [index, form] of forms.entries()) {
      for (const variant of splitRenderings(form)) {
        await writeFile(path.join(files, 'planted.txt'), `key=${variant.text};\n`, 'utf8');
        const hits = (await scanFilesForDigests([files], digests)).map((hit) => hit.split(': ')[1]);
        assert.ok(hits.includes(`private form ${index}`), `form ${index}, ${variant.name}, is found in a file`);
        execFileSync('git', ['--git-dir', repo, 'hash-object', '-w', '--stdin'], { input: `{"note":"${variant.text}"}\n` });
      }
    }
    const inObjects = await scanGitObjectsForDigests(repo, digests);
    for (const index of forms.keys()) assert.ok(inObjects.includes(`private form ${index}`), `form ${index} is found in a git object`);

    const clean = path.join(dir, 'clean');
    await mkdir(clean);
    const cleanRepo = path.join(dir, 'clean.git');
    execFileSync('git', ['init', '--bare', '-q', cleanRepo]);
    for (const [index, form] of other.forms.entries()) {
      for (const [variantIndex, variant] of splitRenderings(form).entries()) {
        await writeFile(path.join(clean, `other-${index}-${variantIndex}.txt`), variant.text, 'utf8');
        execFileSync('git', ['--git-dir', cleanRepo, 'hash-object', '-w', '--stdin'], { input: variant.text });
      }
    }
    assert.deepEqual(await scanFilesForDigests([clean], digests), []);
    assert.deepEqual(await scanGitObjectsForDigests(cleanRepo, digests), []);
  });
});

test('a base64url rendering that contains a dash is still found when wrapped, and plain whole renderings are found exactly as before', async () => {
  const { stored, forms } = await freshKey();
  // Hunt for a key whose base64url rendering has a '-' in it, so the dash is not mistaken for a separator.
  let dashed: { forms: string[]; stored: string } | undefined;
  for (let attempt = 0; attempt < 400 && dashed === undefined; attempt += 1) {
    const candidate = await freshKey();
    if (candidate.forms.some((form) => form.includes('-'))) dashed = candidate;
  }
  assert.ok(dashed !== undefined, 'a key with a dash in its base64url rendering was generated');
  const needles = (dashed as { forms: string[] }).forms.map((value, index) => ({ label: `form ${index}`, value }));
  await withDir(async (dir) => {
    const target = (dashed as { forms: string[] }).forms.findIndex((form) => form.includes('-'));
    await writeFile(path.join(dir, 'wrapped.txt'), chunks((dashed as { forms: string[] }).forms[target] as string, 10).join('\n'), 'utf8');
    assert.ok((await scanFiles([dir], needles)).some((hit) => hit.endsWith(`: form ${target}`)), 'wrapped base64url with a dash');
    await writeFile(path.join(dir, 'wrapped.txt'), forms.join('\n'), 'utf8');
    assert.deepEqual(await scanFiles([dir], (dashed as { forms: string[] }).forms.map((value, index) => ({ label: `form ${index}`, value }))), [], 'another key\'s renderings, one per line, are not a hit');
    await writeFile(path.join(dir, 'wrapped.txt'), `x${stored}x`, 'utf8');
    assert.ok((await scanFiles([dir], [{ label: 'stored', value: stored }])).length === 1, 'a whole rendering is found as before');
  });
});
