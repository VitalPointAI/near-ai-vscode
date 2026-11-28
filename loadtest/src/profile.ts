import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { canonicalize } from '../../compliance/src/signed.ts';

const locators = ['get-started', 'command-palette', 'editor', 'terminal'] as const;
const fixtureFilename = /^[a-z0-9][a-z0-9_-]*\.md$/;

type ActivityProfile = {
  readonly id: 'activity';
  readonly version: '1';
  readonly idleShareBasisPoints: number;
  readonly locators: typeof locators;
  readonly steps: readonly [
    { readonly kind: 'open-files'; readonly files: readonly string[] },
    { readonly kind: 'edit'; readonly file: string; readonly text: string },
    { readonly kind: 'terminal'; readonly action: 'fixture-echo' },
    { readonly kind: 'idle'; readonly durationMs: number },
  ];
  readonly sha256: string;
};

function hasFields(value: unknown, ...fields: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

export function parseProfile(text: string): ActivityProfile {
  const value: unknown = JSON.parse(text);
  assert(hasFields(value, 'id', 'version', 'idleShareBasisPoints', 'locators', 'steps', 'sha256'), 'Unexpected activity profile fields');
  assert(value.id === 'activity' && value.version === '1', 'Unsupported activity profile id or version');
  const share = value.idleShareBasisPoints;
  assert(typeof share === 'number' && Number.isSafeInteger(share) && share >= 0 && share <= 10_000, 'Invalid idle share');
  const declaredLocators = value.locators;
  assert(Array.isArray(declaredLocators) && declaredLocators.length === locators.length
    && locators.every((locator, index) => declaredLocators[index] === locator), 'Invalid activity locators');
  assert(Array.isArray(value.steps) && value.steps.length === 4, 'Invalid activity steps');
  const [open, edit, terminal, idle]: unknown[] = value.steps;
  assert(hasFields(open, 'kind', 'files') && open.kind === 'open-files' && Array.isArray(open.files)
    && open.files.length === 3 && new Set(open.files).size === 3
    && open.files.every((file) => typeof file === 'string' && fixtureFilename.test(file)), 'Invalid open-files step');
  assert(hasFields(edit, 'kind', 'file', 'text') && edit.kind === 'edit' && open.files.includes(edit.file)
    && typeof edit.text === 'string' && edit.text.length > 0, 'Invalid edit step');
  assert(hasFields(terminal, 'kind', 'action') && terminal.kind === 'terminal'
    && terminal.action === 'fixture-echo', 'Invalid terminal step');
  assert(hasFields(idle, 'kind', 'durationMs') && idle.kind === 'idle' && typeof idle.durationMs === 'number'
    && Number.isSafeInteger(idle.durationMs) && idle.durationMs > 0, 'Invalid idle duration');

  const { sha256, ...payload } = value;
  const checksum = `sha256:${createHash('sha256').update(canonicalize(payload)).digest('hex')}`;
  assert(sha256 === checksum, 'Activity profile checksum does not match');
  return value as ActivityProfile;
}

export function loadProfile(file: string | URL): ActivityProfile {
  return parseProfile(readFileSync(file, 'utf8'));
}
