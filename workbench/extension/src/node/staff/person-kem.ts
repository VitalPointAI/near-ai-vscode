/**
 * Publishing a hosted person's post-quantum keys (33.2 D-03, D-05). In a hosted session the person key is the device, so the person's device.kem is
 * signed by the person key through KeyService.sign, which asks for a fresh passkey or security key confirmation (46-07): the binding once, then the
 * entry, as any person-key change. The keys themselves come from the Transit envelope (encryption-key.ts) and are never written anywhere else.
 *
 *   the roster already holds these keys   -> present, nothing signed
 *   a refused confirmation                -> refused with the Staff Room's sentence and "Confirm with your passkey or security key"; the keys stay
 *                                            made in the envelope and are published at the next attempt
 *
 * Nothing here imports Theia or logs.
 */
import { KEY_SERVICE_TEXT } from '../../common/key-service.js';
import { ok, refused, type ServiceResult } from '../../common/service-result.js';
import type { OpenedKemKeys } from './encryption-key.js';
import type { PersonSigner } from './person-signer.js';
import { SESSION_KEY_TEXT } from './session-keys.js';
import type { StaffEngine } from './staff-engine.js';

/** A shared project as publishing needs it: ReplicaProject's state and appendOwn, structurally. */
export interface KemPublishTarget {
  state(): Promise<{ readonly roster: unknown }>;
  appendOwn(kind: string, data: unknown, options: { signer: PersonSigner }): Promise<{ readonly ok: true } | { readonly refused: string; readonly message: string }>;
}

const stepUp = <T>(): ServiceResult<T> => refused(SESSION_KEY_TEXT.stepUp, KEY_SERVICE_TEXT.confirm);

/** Appends the person's device.kem in one shared project when its roster does not hold these keys yet. Never throws for a refusal. */
export async function publishPersonKem(
  target: KemPublishTarget, person: PersonSigner, kem: OpenedKemKeys, engine: Pick<StaffEngine, 'kemBindingBytes' | 'kemKeysAt' | 'writerIdOf'>,
): Promise<ServiceResult<'published' | 'present'>> {
  const writer = engine.writerIdOf(person.publicKey);
  const { roster } = await target.state();
  const held = engine.kemKeysAt(roster as never, writer);
  if (held !== undefined && held.p256 === kem.publicKeys.p256 && held.mlkem768 === kem.publicKeys.mlkem768) return ok('present');
  const sig = await person.sign(engine.kemBindingBytes(kem.publicKeys, writer));
  if (typeof sig !== 'string') return sig.refused === KEY_SERVICE_TEXT.stepUpNeeded ? stepUp() : refused(sig.refused, sig.fix);
  const written = await target.appendOwn('device.kem', { device: writer, p256: kem.publicKeys.p256, mlkem768: kem.publicKeys.mlkem768, sig }, { signer: person });
  if ('ok' in written) return ok('published');
  return written.message === KEY_SERVICE_TEXT.stepUpNeeded ? stepUp() : refused(written.message);
}
