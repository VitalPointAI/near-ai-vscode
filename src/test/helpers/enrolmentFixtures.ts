// Fixtures for your organization's enrolment and rules files (Phase 41, FND-01, D-11 to D-17), for 41-03, 41-09 and 41-14 tests. Every file is made
// with the real builders in src/domain/gate/enrolment.ts, so a fixture that reads back is a file the issuer tool could have written. Fictional names
// only: the organization is Example Organization and its one contact is the Security desk. No key material is written here: keys come from
// policyFixtures' issuerKey and deviceKey, made at test time from a label.
import { buildEnrolment, buildOrganizationLayer } from '../../domain/gate/enrolment';
import type { EnrolmentOrganization } from '../../domain/gate/enrolment';
import type { PayloadSigner } from '../../domain/team/signedPayload';
import { FIXED_NOW, issuerKey, policyDocumentFor } from './policyFixtures';

/** The fictional organization every fixture enrolment names. */
export const EXAMPLE_ORGANIZATION: EnrolmentOrganization = Object.freeze({
  name: 'Example Organization',
  contacts: Object.freeze([Object.freeze({ topic: 'security' as const, name: 'Security desk', how: 'security@example.org' })])
});

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * The sections of the example organization's first rules: the starting rules' labels and agents, with org/Internal kept on this computer
 * ('local-only', the one rule that shows the organization's layer is in force), then any overrides (a key set to undefined is left out).
 */
export function organizationSections(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const start = plain(policyDocumentFor({ key: issuerKey() })) as unknown as Record<string, any>;
  const labels = start['labels'];
  labels.routing.levels['org/Internal'] = 'local-only';
  const sections: Record<string, unknown> = { labels, agents: start['agents'] };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete sections[key];
    else sections[key] = value;
  }
  return sections;
}

export interface EnrolmentTextOptions {
  /** Epoch milliseconds; FIXED_NOW by default. */
  readonly now?: number;
  /** The enrolment file's life in days (30 by default). */
  readonly days?: number;
  /** The first layer's life in days (90 by default). */
  readonly layerDays?: number;
  readonly serial?: number;
  readonly sections?: Record<string, unknown>;
  readonly organization?: EnrolmentOrganization;
  /** The pinned key handing over to the issuer (a rotation file). */
  readonly rotation?: PayloadSigner;
}

/** The compact JSON text of an enrolment file signed by `issuer` with its first rules (organizationSections by default). */
export function enrolmentTextFor(issuer: PayloadSigner, options: EnrolmentTextOptions = {}): string {
  const now = options.now ?? FIXED_NOW;
  const layer = buildOrganizationLayer(issuer, options.sections ?? organizationSections(), { now, days: options.layerDays ?? 90 });
  const envelope = buildEnrolment(issuer, {
    organization: options.organization ?? EXAMPLE_ORGANIZATION,
    layer,
    now,
    days: options.days ?? 30,
    serial: options.serial ?? 1,
    ...(options.rotation === undefined ? {} : { rotation: options.rotation })
  });
  return JSON.stringify(envelope);
}

/** A key handover file: signed by `newKey`, with the handover signed by `oldKey` (the pinned key), serial 2 by default. */
export function rotationTextFor(oldKey: PayloadSigner, newKey: PayloadSigner, options: EnrolmentTextOptions = {}): string {
  return enrolmentTextFor(newKey, { ...options, serial: options.serial ?? 2, rotation: oldKey });
}

export interface RulesTextOptions {
  readonly now?: number;
  readonly days?: number;
}

/** The compact JSON text of a rules update (an org-policy-layer envelope) signed by `issuer` with these sections. */
export function rulesTextFor(issuer: PayloadSigner, sections: Record<string, unknown> = organizationSections(), options: RulesTextOptions = {}): string {
  return JSON.stringify(buildOrganizationLayer(issuer, sections, { now: options.now ?? FIXED_NOW, days: options.days ?? 90 }));
}
