import { createHash } from 'node:crypto';
import { canonicalBytes, verifySignature } from '../team/canonical';
import { isRecord } from '../team/validate';
import { CELL_ACCESS_FEATURE } from './features';

const HASH = /^[0-9a-f]{64}$/;
const CELL = /^[0-9a-f]{32}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const PERMIT_DEPTH = 256;
const MAX_CELLS = 4096;

function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function hashes(value: unknown, length: number): value is readonly string[] {
  if (!Array.isArray(value) || value.length !== length) return false;
  for (const item of value) if (typeof item !== 'string' || !HASH.test(item)) return false;
  return true;
}

function hasProofShape(value: unknown): value is AccessWriteProof {
  if (!closed(value, ['commitment', 'cell', 'signed', 'permitSiblings'])) return false;
  const { commitment, cell, signed } = value;
  return closed(commitment, ['cellRoot', 'permitRoot', 'frontierRoot']) &&
    closed(cell, ['decision', 'count', 'index', 'siblings']) &&
    closed(cell.decision, ['cell', 'previousEpoch', 'epoch', 'decision', 'salt', 'evidence']) &&
    closed(signed, ['permit', 'signature']) &&
    closed(signed.permit, ['project', 'revision', 'predecessor', 'cell', 'epoch', 'device', 'writer', 'certificate', 'authority']);
}

const isHash = (value: unknown): boolean => typeof value === 'string' && HASH.test(value);
const isCell = (value: unknown): boolean => typeof value === 'string' && CELL.test(value);


function domainBytes(domain: string, value: unknown): Buffer {
  return Buffer.concat([Buffer.from(`near-ai/cell-access/1/${domain}\n`), canonicalBytes(value)]);
}

function digest(domain: string, value: unknown): string {
  return createHash('sha256').update(domainBytes(domain, value)).digest('hex');
}

function node(domain: string, left: string, right: string): string {
  return digest(`${domain}-node`, [left, right]);
}

export function accessRevisionId(project: string, prior: string | null, predecessor: string, kind: string, operation: unknown): string {
  return digest('revision', [CELL_ACCESS_FEATURE, project, prior, predecessor, kind, operation]);
}

export interface AccessRevision {
  id: string;
  entry: string;
  predecessor: string;
  root: string;
  cells: readonly string[];
}

export interface CellAccessDecision {
  cell: string;
  previousEpoch: number;
  epoch: number;
  decision: 'continues' | 'pending' | 'closed';
  salt: string;
  evidence: string;
}

export interface AccessPermit {
  project: string;
  revision: string;
  predecessor: string;
  cell: string;
  epoch: number;
  device: string;
  writer: string;
  certificate: string | null;
  authority: string;
}

export interface SignedAccessPermit {
  permit: AccessPermit;
  signature: string;
}

export interface AccessCommitment {
  cellRoot: string;
  permitRoot: string;
  frontierRoot: string | null;
}

export interface CellAccessOpening {
  decision: CellAccessDecision;
  count: number;
  index: number;
  siblings: readonly string[];
}

export interface AccessCellProof {
  commitment: AccessCommitment;
  cell: CellAccessOpening;
}

export interface AccessWriteProof extends AccessCellProof {
  signed: SignedAccessPermit;
  permitSiblings: readonly string[];
}

export interface AccessWriteContext {
  project: string;
  cell: string;
  epoch: number;
  device: string;
  writer: string;
  certificate: string | null;
  authorityKey(writer: string): string | undefined;
}

export function accessPermitBytes(permit: AccessPermit): Buffer {
  const { project, revision, predecessor, cell, epoch, device, writer, certificate, authority } = permit;
  return domainBytes('permit-signature', [project, revision, predecessor, cell, epoch, device, writer, certificate, authority]);
}

function permitKey(permit: AccessPermit): bigint {
  return BigInt(`0x${digest('permit-key', [permit.cell, permit.device, permit.writer])}`);
}

function signedPermitLeaf(signed: SignedAccessPermit): string {
  return digest('permit-leaf', [accessPermitBytes(signed.permit).toString('base64url'), signed.signature]);
}

function cellLeaf(revision: string, index: number, value: CellAccessDecision): string {
  return digest('cell-leaf', [revision, index, value.cell, value.previousEpoch, value.epoch, value.decision, value.salt, value.evidence]);
}

function rootOf(revision: string, count: number, commitment: AccessCommitment): string {
  return digest('access-root', [revision, count, commitment.cellRoot, commitment.permitRoot, commitment.frontierRoot]);
}

const permitEmpty: readonly string[] = (() => {
  const empty = [digest('permit-empty', [])];
  for (let height = 0; height < PERMIT_DEPTH; height += 1) empty.push(node('permit', empty[height], empty[height]));
  return empty;
})();

function openBranch(domain: string, leaf: string, index: bigint, siblings: readonly string[]): string {
  let result = leaf;
  for (const sibling of siblings) {
    result = (index & 1n) === 0n ? node(domain, result, sibling) : node(domain, sibling, result);
    index >>= 1n;
  }
  return result;
}

function validEpoch(epoch: number): boolean {
  return Number.isSafeInteger(epoch) && epoch > 0;
}

function validDecision(value: CellAccessDecision): boolean {
  return isCell(value.cell) && Number.isSafeInteger(value.previousEpoch) && value.previousEpoch >= 0 && validEpoch(value.epoch) &&
    ['continues', 'pending', 'closed'].includes(value.decision) && isHash(value.salt) && isHash(value.evidence);
}

function validPermit({ permit, signature }: SignedAccessPermit): boolean {
  return isCell(permit.project) && isCell(permit.cell) && validEpoch(permit.epoch) &&
    [permit.revision, permit.predecessor, permit.device, permit.writer, permit.authority].every(isHash) &&
    (permit.certificate === null || isHash(permit.certificate)) && typeof signature === 'string' && SIGNATURE.test(signature);
}

/** Decode only the proof shape. This does not establish authority before its roster root is selected. */
export function readAccessWriteProof(value: unknown): AccessWriteProof | undefined {
  if (!hasProofShape(value) || !validPermit(value.signed) || !validDecision(value.cell.decision) ||
      !hashes(value.permitSiblings, PERMIT_DEPTH) || !Array.isArray(value.cell.siblings) ||
      value.cell.siblings.length > Math.ceil(Math.log2(MAX_CELLS)) || !hashes(value.cell.siblings, value.cell.siblings.length)) return undefined;
  return value;
}

function validCommitment(commitment: AccessCommitment): boolean {
  return isHash(commitment.cellRoot) && isHash(commitment.permitRoot) &&
    (commitment.frontierRoot === null || isHash(commitment.frontierRoot));
}

function permitContextMatches(permit: AccessPermit, revision: AccessRevision, context: AccessWriteContext): boolean {
  return permit.project === context.project && permit.revision === revision.id && permit.predecessor === revision.predecessor &&
    permit.cell === context.cell && permit.epoch === context.epoch && permit.device === context.device &&
    permit.writer === context.writer && permit.certificate === context.certificate;
}

/** Returns only the private leaf authenticated by the selected roster root and the cell's canonical slot. */
export function verifiedCellAccess(revision: AccessRevision, commitment: unknown, opening: unknown, cell: string): CellAccessDecision | undefined {
  if (revision.cells.length === 0 || revision.cells.length > MAX_CELLS ||
    !closed(commitment, ['cellRoot', 'permitRoot', 'frontierRoot']) || !closed(opening, ['decision', 'count', 'index', 'siblings']) ||
    !closed(opening.decision, ['cell', 'previousEpoch', 'epoch', 'decision', 'salt', 'evidence'])) return undefined;
  const roots = commitment as unknown as AccessCommitment;
  if (!validCommitment(roots) || rootOf(revision.id, revision.cells.length, roots) !== revision.root) return undefined;
  const slot = revision.cells.indexOf(cell);
  const depth = Math.ceil(Math.log2(revision.cells.length));
  if (slot < 0 || opening.index !== slot || opening.count !== revision.cells.length || !hashes(opening.siblings, depth)) return undefined;
  const decision = opening.decision as unknown as CellAccessDecision;
  if (!validDecision(decision) || decision.cell !== cell) return undefined;
  for (let height = 0; height < depth; height += 1) {
    const siblingStart = ((slot >> height) ^ 1) << height;
    if (siblingStart >= revision.cells.length && opening.siblings[height] !== paddingNode(revision.id, siblingStart, height)) return undefined;
  }
  return openBranch('cell', cellLeaf(revision.id, slot, decision), BigInt(slot), opening.siblings) === roots.cellRoot ? decision : undefined;
}

/** Verifies exact writer authority against the root of the already selected roster entry. */
export function verifiesAccessWrite(revision: AccessRevision, proof: unknown, context: AccessWriteContext): boolean {
  if (!hasProofShape(proof)) return false;
  const { commitment, cell, signed, permitSiblings } = proof;
  if (!validPermit(signed) || !permitContextMatches(signed.permit, revision, context)) return false;
  const decision = verifiedCellAccess(revision, commitment, cell, context.cell);
  if (decision?.decision !== 'continues' || decision.epoch !== context.epoch) return false;
  if (!hashes(permitSiblings, PERMIT_DEPTH)) return false;
  const authority = context.authorityKey(signed.permit.authority);
  return authority !== undefined && verifySignature(accessPermitBytes(signed.permit), signed.signature, authority) &&
    openBranch('permit', signedPermitLeaf(signed), permitKey(signed.permit), permitSiblings) === commitment.permitRoot;
}

function paddingNode(revision: string, index: number, height: number): string {
  if (height === 0) return digest('cell-padding', [revision, index]);
  const left = paddingNode(revision, index, height - 1);
  const right = paddingNode(revision, index + 2 ** (height - 1), height - 1);
  return node('cell', left, right);
}

function cellLayers(revision: string, cells: readonly CellAccessDecision[]): string[][] {
  const level = cells.map((cell, index) => cellLeaf(revision, index, cell));
  const width = 2 ** Math.ceil(Math.log2(cells.length));
  for (let index = cells.length; index < width; index += 1) level.push(digest('cell-padding', [revision, index]));
  const layers = [level];
  while (layers[layers.length - 1].length > 1) {
    const below = layers[layers.length - 1], above: string[] = [];
    for (let index = 0; index < below.length; index += 2) above.push(node('cell', below[index], below[index + 1]));
    layers.push(above);
  }
  return layers;
}

function permitLayers(permits: readonly SignedAccessPermit[]): Array<Map<bigint, string>> | undefined {
  const base = new Map<bigint, string>();
  for (const signed of permits) {
    if (!validPermit(signed)) return undefined;
    const key = permitKey(signed.permit);
    if (base.has(key)) return undefined;
    base.set(key, signedPermitLeaf(signed));
  }
  const layers = [base];
  for (let height = 0; height < PERMIT_DEPTH; height += 1) {
    const below = layers[height], above = new Map<bigint, string>();
    for (const index of below.keys()) {
      const parent = index >> 1n;
      if (above.has(parent)) continue;
      const left = parent << 1n;
      above.set(parent, node('permit', below.get(left) ?? permitEmpty[height], below.get(left | 1n) ?? permitEmpty[height]));
    }
    layers.push(above);
  }
  return layers;
}

export function buildAccessCommitment(revision: string, cells: readonly CellAccessDecision[], permits: readonly SignedAccessPermit[], frontierRoot: string | null = null):
  { root: string; cellProof(cell: string): AccessCellProof | undefined; proof(cell: string, writer: string): AccessWriteProof | undefined } | undefined {
  if (!HASH.test(revision) || cells.length === 0 || cells.length > MAX_CELLS || cells.some((cell, index) => !validDecision(cell) || (index > 0 && cells[index - 1].cell >= cell.cell))) return undefined;
  const permitTree = permitLayers(permits);
  if (permitTree === undefined || permits.some(({ permit }) => permit.revision !== revision || !cells.some((cell) =>
    cell.decision === 'continues' && cell.cell === permit.cell && cell.epoch === permit.epoch))) return undefined;
  const cellTree = cellLayers(revision, cells);
  const commitment = { cellRoot: cellTree.at(-1)![0], permitRoot: permitTree.at(-1)!.get(0n) ?? permitEmpty[PERMIT_DEPTH], frontierRoot };
  if (!validCommitment(commitment)) return undefined;
  const cellProof = (cell: string): AccessCellProof | undefined => {
    const index = cells.findIndex((item) => item.cell === cell);
    if (index < 0) return undefined;
    const siblings = cellTree.slice(0, -1).map((layer, height) => layer[(index >> height) ^ 1]);
    return { commitment, cell: { decision: cells[index], count: cells.length, index, siblings } };
  };
  return {
    root: rootOf(revision, cells.length, commitment),
    cellProof,
    proof(cell, writer) {
      const opening = cellProof(cell);
      const signed = permits.find((item) => item.permit.cell === cell && item.permit.writer === writer);
      if (opening === undefined || signed === undefined) return undefined;
      const key = permitKey(signed.permit);
      const permitSiblings = permitTree.slice(0, -1).map((layer, height) => layer.get((key >> BigInt(height)) ^ 1n) ?? permitEmpty[height]);
      return { ...opening, signed, permitSiblings };
    }
  };
}
