// The exchange adapter at the release boundary (Phase 45.1, D-04, D-11). Pure apart from tdf.ts's node:crypto: no I/O, no clock, no vscode, no package.
// An adapter turns a released version into an object for a partner (export) and an object from a partner into content, a label and the record of what
// arrived and what we keep (import). Part 1 ships one adapter, `tdf`. Inbound adapters for formats that are not ZTDF (OpenTDF from other tools, ADatP-4778
// binding data objects, marked plain files, unlabelled files) are Phase 45.2's (hand-off H-13); each normalizes to the same import result.
//
// Owner direction 2026-11-25 (D-11): liberal in what we accept, strict in what we keep. Every arrival is quarantined first; converting never raises
// trust above what the source proves; and a client never interprets an `arrived` or `stored` id it does not know.
import type { Agreement } from '../gate/agreementsSection';
import type { Label } from '../gate/labels';
import { canExport, isExportDecision } from './exportCheck';
import type { ExportCheck, ExportContext, ExportDecision } from './exportCheck';
import type { LabelBinding } from './labelBinding';
import type { ExternalLabel } from './labelInterop';
import { TDF_FORMAT, TdfError, buildTdf, readTdf } from './tdf';
import type { ReadTdfOptions, TdfObject, TdfReadResult, TdfRecipient } from './tdf';

/**
 * Arrival format ids this version reads (the open set of D-11: `tdf`, and later `ztdf-profile/1`, `bdo-4778`, `marked-file`, `unlabelled` and more).
 */
export const KNOWN_ARRIVAL_FORMATS = Object.freeze([TDF_FORMAT] as const);
/**
 * What this version keeps of an arrival: your organization's own protected cell. A record's `stored` is a list (`['cell']`, and from Phase 45.2
 * `['cell', 'ztdf-profile/1']` where a ZTDF-compatible copy is kept beside it). These two lists are the one authoritative id sets; 45.2 imports them.
 */
export const KNOWN_STORED_FORMS = Object.freeze(['cell'] as const);

/** The sentence a client shows, and all it does, for a record whose arrived or stored id it does not know (D-11). */
export const UNKNOWN_FORMAT_TEXT = 'Received in a format this version can\'t read; ask your administrator.';

/** Shown beside a readable record that also lists a stored form this version does not know (that form is never read). */
export const ALSO_KEPT_TEXT = 'Also kept in a form this version can\'t read.';

function storedList(stored: unknown): readonly string[] | undefined {
  return Array.isArray(stored) && stored.every((form) => typeof form === 'string') ? (stored as string[]) : undefined;
}

/**
 * Whether this version may interpret a record: its `arrived` id is one this version knows and its `stored` list holds `'cell'`. Other stored forms are
 * ignored for reading (see unknownStoredForms). Otherwise the client shows UNKNOWN_FORMAT_TEXT and leaves the content alone.
 */
export function readableArrival(arrived: unknown, stored: unknown): boolean {
  const forms = storedList(stored);
  return (KNOWN_ARRIVAL_FORMATS as readonly unknown[]).includes(arrived) && forms !== undefined && forms.includes('cell');
}

/** The stored forms of a record that this version does not know, for ALSO_KEPT_TEXT; never read. */
export function unknownStoredForms(stored: unknown): readonly string[] {
  return Object.freeze((storedList(stored) ?? []).filter((form) => !(KNOWN_STORED_FORMS as readonly string[]).includes(form)));
}

/** How an arrival became what we keep: the converter and its version, and what was lost or assumed on the way, in plain words. */
export interface ImportConversion {
  readonly converter: string;
  readonly version: number;
  readonly lost: readonly string[];
  readonly assumed: readonly string[];
}

/** What an import gives the host, which records it as exchange.import in state quarantined (every arrival, D-11). */
export interface ImportedObject {
  readonly content: Uint8Array;
  readonly label: Label;
  readonly external: ExternalLabel;
  readonly binding: LabelBinding;
  readonly mimeType: string;
  readonly arrived: string;
  /** What we keep, `'cell'` always among them. */
  readonly stored: readonly string[];
  /** How it was converted; absent when an arrival is kept as received (a `ztdf-profile/1` arrival, Phase 45.2). */
  readonly conversion?: ImportConversion;
  readonly state: 'quarantined';
}

export type ImportResult = { readonly ok: true; readonly value: ImportedObject } | Extract<TdfReadResult, { ok: false }>;

/** What leaves: the released version's content, the passed check, and the label binding signed with your organization's release key. */
export interface ExportCopy {
  readonly content: Uint8Array;
  readonly decision: ExportDecision;
  readonly binding: LabelBinding;
  readonly mimeType?: string;
}

export interface ExchangeAdapter {
  readonly id: string;
  /** The format ids it writes and reads. */
  readonly formats: readonly string[];
  canExport(label: Label, agreement: Agreement | undefined, context: ExportContext): ExportCheck;
  /** Throws TdfError when the copy did not pass canExport, or its binding is not over this content, label and mapping version. */
  export(copy: ExportCopy, recipient: TdfRecipient): TdfObject;
  import(object: TdfObject, options: ReadTdfOptions): Promise<ImportResult>;
}

function sameLabel(a: Label, b: Label): boolean {
  return JSON.stringify([a.scale, a.level, a.compartments, a.releasability, a.handling]) === JSON.stringify([b.scale, b.level, b.compartments, b.releasability, b.handling]);
}

/** The TDF converter's own record: a base TDF object becomes a cell; its policy attributes are not carried (45.1 writes none, 45.1-RESEARCH section 6). */
const TDF_CONVERSION: ImportConversion = Object.freeze({
  converter: 'tdf', version: 1, lost: Object.freeze(['the object\'s policy attributes and key access record']), assumed: Object.freeze([])
});

export const tdfAdapter: ExchangeAdapter = Object.freeze({
  id: TDF_FORMAT,
  formats: Object.freeze([TDF_FORMAT]),
  canExport,
  export(copy: ExportCopy, recipient: TdfRecipient): TdfObject {
    if (!isExportDecision(copy.decision)) throw new TdfError('label-binding');
    if (!sameLabel(copy.binding.label, copy.decision.label)) throw new TdfError('label-binding');
    return buildTdf({ content: copy.content, external: copy.decision.external, binding: copy.binding, recipient, ...(copy.mimeType === undefined ? {} : { mimeType: copy.mimeType }) });
  },
  async import(object: TdfObject, options: ReadTdfOptions): Promise<ImportResult> {
    const read = await readTdf(object, options);
    if (!read.ok) return read;
    return {
      ok: true,
      value: Object.freeze({
        content: read.content, label: read.label, external: read.external, binding: read.binding, mimeType: read.mimeType,
        arrived: TDF_FORMAT, stored: Object.freeze(['cell']), conversion: TDF_CONVERSION, state: 'quarantined' as const
      })
    };
  }
});
