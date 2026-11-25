// The key release check (Phase 71, D-18, D-19, DCAC-04; research 4.3): an epoch key reaches the engine only after the cell's own label allows it
// for this person's checked credentials, fresh at the moment of release. Host-neutral and synchronous: it reads the wallet's last verified view from
// memory and never waits on the network.
//
//   no credentials@1      every key is released, exactly as before (D-08: nothing changes without your organization's rules)
//   session ended         nothing is released, the base cell included (ending the session or disabling the person's entity cuts even granted epochs)
//   unmarked cell         released (the base cell is unmarked)
//   lowest level          released when the label has no compartment and no releasability (O11: the lowest level never waits on credentials)
//   any other label       the view must be fresh (connected) or within the level's offline age (edge), checkFreshness must pass on the lists the
//                         view used, and mayRelease must pass on the person's facts; else the key is dropped and the cell shows the sentence
//   unreadable label      refused: a cell whose label does not open, or does not read, stays closed
import { CACHE_STATE_TEXT, cacheStateAt } from '../../domain/credentials/cacheState';
import type { CredentialCache } from '../../domain/credentials/cacheState';
import { checkFreshness } from '../../domain/credentials/freshness';
import type { SiteKind } from '../../domain/credentials/freshness';
import { mayRelease } from '../../domain/credentials/mayRelease';
import type { CredentialFacts } from '../../domain/credentials/mayRelease';
import type { CredentialsSection } from '../../domain/gate/credentialsSection';
import { labelKey, levelIndex, parseLabel } from '../../domain/gate/labels';
import type { Label, ScaleMapping, ScaleTable } from '../../domain/gate/labels';
import { labelFromText, readLegacyCellLabel } from '../../domain/replica/productCells';

/** What a cell shows when its key is not released: one sentence and, where the person can act, the action. */
export const KEY_RELEASE_TEXT = {
  notCleared: 'You are not cleared for this work. Ask your organization\'s security officer if you need access.',
  unreadable: 'This work\'s marking cannot be read here, so it stays closed. Ask the project lead to check it.',
  ended: 'Your session has ended, so this work is closed. Sign in again to open it.'
} as const;

export type KeyReleaseRefusal = 'not-cleared' | 'stale' | 'unavailable' | 'freshness' | 'label-unreadable' | 'session-ended';

export type ReleaseDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: KeyReleaseRefusal; readonly sentence: string; readonly action?: 'retry' | 'connect' };

/** The label the key ring opened from the cell's grant: undefined when the cell is unmarked, UNREADABLE_LABEL when it holds one that did not open. */
export const UNREADABLE_LABEL: unique symbol = Symbol('unreadable-label');

/** Asked by the key ring before it hands out an epoch key (settle, every read, and the reading path). */
export type KeyReleaseCheck = (cell: string, label: unknown) => ReleaseDecision;

/** Your organization's rules the check reads: credentials@1, the scales and the approved mappings. */
export interface ReleasePolicy {
  readonly section: CredentialsSection;
  readonly scales: ScaleTable;
  readonly mappings?: readonly ScaleMapping[];
}

/** The person's last verified view (the wallet's WalletView fits): its cache, facts and the lists it used; ended once the session is over. */
export interface ReleaseView {
  readonly cache: CredentialCache;
  readonly facts: CredentialFacts;
  readonly lists?: readonly { readonly list: string; readonly validFrom: string; readonly fetchedAt: number }[];
  readonly ended?: boolean;
}

const RELEASED: ReleaseDecision = Object.freeze({ ok: true });

function refuse(reason: KeyReleaseRefusal, sentence: string, action?: 'retry' | 'connect'): ReleaseDecision {
  return Object.freeze({ ok: false, reason, sentence, ...(action === undefined ? {} : { action }) });
}

/** The labels a cell's sealed label stands for: one, or every label of a legacy set; undefined when it does not read. */
function labelsOf(value: unknown, scales: ScaleTable): readonly Label[] | undefined {
  if (typeof value === 'string') {
    const label = labelFromText(value, scales);
    return label === undefined ? undefined : [label];
  }
  const legacy = readLegacyCellLabel(value, scales);
  if (legacy !== undefined) return legacy;
  const parsed = parseLabel(value, scales);
  return parsed.ok ? [parsed.value] : undefined;
}

/** O11: the lowest level of a scale, with no compartment and no releasability, never waits on credentials. */
function lowest(label: Label, scales: ScaleTable): boolean {
  return levelIndex(scales, label.scale, label.level) === 0 && label.compartments.length === 0 && label.releasability.length === 0;
}

/**
 * The check the key ring asks. `policy` is your organization's rules in force (undefined: none, every key is released as today); `view` is read at
 * each release, so a view that turns stale or a session that ends stops the next release.
 */
export function keyReleaseFor(policy: () => ReleasePolicy | undefined, view: () => ReleaseView, now: () => number, siteKind: SiteKind = 'connected'): KeyReleaseCheck {
  return (_cell, label) => {
    const rules = policy();
    if (rules === undefined) return RELEASED;
    const current = view();
    if (current.ended === true) return refuse('session-ended', KEY_RELEASE_TEXT.ended);
    if (label === undefined) return RELEASED;
    if (label === UNREADABLE_LABEL) return refuse('label-unreadable', KEY_RELEASE_TEXT.unreadable);
    const labels = labelsOf(label, rules.scales);
    if (labels === undefined || labels.length === 0) return refuse('label-unreadable', KEY_RELEASE_TEXT.unreadable);
    const at = now();
    const state = cacheStateAt(current.cache, { kind: 'tick', now: at }).state;
    for (const each of labels) {
      if (lowest(each, rules.scales)) continue;
      // Connected, only a fresh view counts; at an edge the level's maximum offline age decides (O6), and an unavailable view never counts.
      if (state === 'unavailable' || (siteKind === 'connected' && state === 'stale')) {
        const text = CACHE_STATE_TEXT[state];
        return refuse(state, text.text, text.action);
      }
      const lists = current.lists ?? [];
      const newest = Object.fromEntries(lists.map((used) => [used.list, { validFrom: used.validFrom, fetchedAt: used.fetchedAt }]));
      const fresh = checkFreshness({ evidence: [], status: lists.map((used) => ({ list: used.list, hash: '', validFrom: used.validFrom })) }, newest, labelKey(each), rules.section, at, siteKind);
      if (!fresh.ok) return refuse('freshness', fresh.message, fresh.action);
      const allowed = mayRelease(current.facts, each, { scales: rules.scales, mappings: rules.mappings ?? [], policy: rules.section, now: at });
      if (!allowed.ok) return refuse('not-cleared', KEY_RELEASE_TEXT.notCleared);
    }
    return RELEASED;
  };
}

/**
 * What a key ring remembers about releases, in memory only (keyring.ts): the label opened for each released epoch, why a cell's key is withheld, and
 * the epochs dropped since. Kept here so the key ring's own module still holds exactly one SecretStorage delete (forgetJoinSecret).
 */
export class ReleaseMemory {
  private readonly labels = new Map<string, unknown>();
  private readonly withheld = new Map<string, ReleaseDecision>();
  private readonly dropped = new Set<string>();

  /** Whether settle has opened this epoch's label (a key is handed out only after it has). */
  public hasLabel(id: string): boolean {
    return this.labels.has(id);
  }

  public label(id: string): unknown {
    return this.labels.get(id);
  }

  /** Records a release; true when the epoch had no label yet (a cached key released for the first time). */
  public released(id: string, cell: string, label: unknown): boolean {
    const first = !this.labels.has(id);
    this.labels.set(id, label);
    this.withheld.delete(cell);
    this.dropped.delete(id);
    return first;
  }

  /** Records a refusal: the cell keeps its decision and the epoch is dropped until a later release. */
  public refused(id: string, cell: string, decision: ReleaseDecision): void {
    this.withheld.set(cell, decision);
    this.labels.delete(id);
    this.dropped.add(id);
  }

  public wasDropped(id: string): boolean {
    return this.dropped.has(id);
  }

  public withheldCells(): ReadonlyMap<string, ReleaseDecision> {
    return new Map(this.withheld);
  }
}

/** Takes an entry out of an in-memory map, zeroing it when it is a key; the entry, or undefined. */
export function forgetInMemory<V>(map: Map<string, V>, key: string): V | undefined {
  const held = map.get(key);
  map.delete(key);
  if (Buffer.isBuffer(held)) held.fill(0);
  return held;
}
