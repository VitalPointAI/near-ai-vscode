import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  institutionalActionRegisterDirectory, institutionalBriefDigest, institutionalBriefDirectory, institutionalBriefMaxBytes,
  institutionalFindingsDirectory, institutionalObservationDirectory, institutionalObservationInput, prepareInstitutionalActionRegister, prepareInstitutionalBrief,
  prepareInstitutionalFindings, prepareInstitutionalObservation, type InstitutionalDraftReview, type InstitutionalDraftScope, type PreparedInstitutionalDraft,
} from '../domain/staff/institutionalBrief';
import { replaceKeepingEdits } from './staffFiles';

type ResolveDraftPath = (root: string, requested: string) => Promise<string>;
const hexDigest = /^[0-9a-f]{64}$/;
const readLeafFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

function directoryOf(scope: InstitutionalDraftScope): string {
  if (scope.findings) return institutionalFindingsDirectory;
  return scope.observation ? institutionalObservationDirectory : scope.actionRegister ? institutionalActionRegisterDirectory : institutionalBriefDirectory;
}

function changed(): never {
  throw new Error('The institutional draft or its project scope changed. Review the current evidence.');
}

async function captureParents(scope: InstitutionalDraftScope): Promise<string> {
  // A real proof comes from the isolated fixture provider's interlock, not
  // from this filesystem observation. The observation rejects wrong objects.
  let directory = scope.root;
  const identities = [];
  for (const part of ['', ...directoryOf(scope).split('/')]) {
    directory = path.join(directory, part);
    const stat = await lstat(directory, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory) return changed();
    identities.push(`${stat.dev}:${stat.ino}:${stat.birthtimeNs}`);
  }
  if (institutionalBriefDigest(scope.root) !== scope.binding.project || institutionalBriefDigest(identities[0]) !== scope.binding.directory) return changed();
  return identities.join('/');
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

async function readExact(file: string): Promise<Buffer | undefined> {
  const before = await lstat(file, { bigint: true }).catch((error: unknown) => { if (isMissing(error)) return undefined; throw error; });
  if (!before) return undefined;
  if (!before.isFile() || before.isSymbolicLink() || before.size > institutionalBriefMaxBytes) return changed();
  const descriptor = await open(file, readLeafFlags);
  try {
    const opened = await descriptor.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) return changed();
    const buffer = Buffer.alloc(institutionalBriefMaxBytes + 1);
    let count = 0;
    while (count < buffer.length) {
      const next = await descriptor.read(buffer, count, buffer.length - count, count);
      if (!next.bytesRead) break;
      count += next.bytesRead;
    }
    const after = await lstat(file, { bigint: true });
    if (count > institutionalBriefMaxBytes || !after.isFile() || before.ino !== after.ino || before.dev !== after.dev ||
        before.size !== BigInt(count) || after.size !== before.size || before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs) return changed();
    return buffer.subarray(0, count);
  } finally { await descriptor.close(); }
}

async function draftPath(scope: InstitutionalDraftScope, resolve: ResolveDraftPath, relative: string): Promise<string> {
  const directory = directoryOf(scope);
  if (!relative.startsWith(directory + '/') ||
      !hexDigest.test(relative.slice(directory.length + 1, -5)) || !relative.endsWith('.json')) return changed();
  const expected = path.join(scope.root, relative);
  const resolved = await resolve(scope.root, relative);
  if (resolved !== expected) return changed();
  return expected;
}

function reconstruct(bytes: Buffer, scope: InstitutionalDraftScope, pathExpected: string): PreparedInstitutionalDraft {
  const payload: unknown = JSON.parse(bytes.toString('utf8'));
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return changed();
  const { body, productId } = payload as Record<string, unknown>;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return changed();
  const sources = scope.currentSources();
  const expected = scope.findings
    ? prepareInstitutionalFindings({ ...body, productId }, scope.binding, sources, scope.findings.current())
    : scope.observation ? prepareInstitutionalObservation(institutionalObservationInput(body, productId), scope.binding, sources, scope.observation.current())
    : scope.actionRegister
      ? prepareInstitutionalActionRegister({ productId, rows: storedActionRows(body) }, scope.binding, sources, scope.actionRegister.current())
      : prepareInstitutionalBrief({ ...body, productId }, scope.binding, sources);
  if (expected.path !== pathExpected || !bytes.equals(Buffer.from(expected.text))) return changed();
  return expected;
}

function storedActionRows(body: object): unknown[] {
  const { rows } = body as { rows?: unknown };
  if (!Array.isArray(rows) || rows.length > 12) return changed();
  return rows.map((row: unknown) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return changed();
    const { overdue: _overdue, humanHandoff: _handoff, ...input } = row as Record<string, unknown>;
    return input;
  });
}

async function requireCurrentPredecessor(scope: InstitutionalDraftScope): Promise<void> {
  const predecessor = scope.actionRegister ?? scope.findings;
  if (predecessor && !await predecessor.predecessorCurrent()) return changed();
}

function exactPredecessorLeaf(scope: InstitutionalDraftScope, review: InstitutionalDraftReview): boolean {
  if (review.kind === 'observation') return scope.observation?.correctionAtEffect(review.correction) === true;
  if (review.kind === 'findings') return scope.findings?.predecessorAtEffect(review.observation.version) === true;
  return review.kind === 'brief' || scope.actionRegister?.predecessorAtEffect(review.predecessor.version) === true;
}

export async function verifyInstitutionalDraftTarget(scope: InstitutionalDraftScope, resolve: ResolveDraftPath, draft: PreparedInstitutionalDraft): Promise<void> {
  await requireCurrentPredecessor(scope);
  await scope.withStableParents(async () => {
    const parents = await captureParents(scope);
    const file = await draftPath(scope, resolve, draft.path);
    const existing = await readExact(file);
    if (await captureParents(scope) !== parents || !await scope.bindingIsCurrent() || (existing && !existing.equals(Buffer.from(draft.text)))) return changed();
    const { review } = reconstruct(Buffer.from(draft.text), scope, draft.path);
    if (!exactPredecessorLeaf(scope, review)) return changed();
  });
}

export async function storeInstitutionalDraft(
  scope: InstitutionalDraftScope, resolve: ResolveDraftPath, draft: PreparedInstitutionalDraft, verifyBeforeInstall: () => boolean,
): Promise<InstitutionalDraftReview> {
  await requireCurrentPredecessor(scope);
  return scope.withStableParents(async () => {
    const parents = await captureParents(scope);
    const file = await draftPath(scope, resolve, draft.path);
    const existing = await readExact(file);
    if (await captureParents(scope) !== parents || !await scope.bindingIsCurrent()) return changed();
    const prepared = reconstruct(Buffer.from(draft.text), scope, draft.path);
    const stillValid = () => verifyBeforeInstall() && exactPredecessorLeaf(scope, prepared.review);
    if (!existing) {
      const result = await replaceKeepingEdits(file, { exists: false }, draft.text, stillValid);
      if (result.status !== 'written') return changed();
    }
    if (await captureParents(scope) !== parents) return changed();
    const bytes = await readExact(await draftPath(scope, resolve, draft.path));
    if (!bytes || !await scope.bindingIsCurrent() || !stillValid()) return changed();
    return reconstruct(bytes, scope, draft.path).review;
  });
}

export async function readInstitutionalDraftReview(scope: InstitutionalDraftScope, resolve: ResolveDraftPath, version: string): Promise<InstitutionalDraftReview> {
  if (!hexDigest.test(version)) return changed();
  await requireCurrentPredecessor(scope);
  return scope.withStableParents(async () => {
    const parents = await captureParents(scope);
    const expected = `${directoryOf(scope)}/${version}.json`;
    const bytes = await readExact(await draftPath(scope, resolve, expected));
    if (!bytes || await captureParents(scope) !== parents || !await scope.bindingIsCurrent()) return changed();
    const { review } = reconstruct(bytes, scope, expected);
    if (!exactPredecessorLeaf(scope, review)) return changed();
    return review;
  });
}
