/**
 * The staff engine bundle as the backend sees it (Phase 33 D-51; the Phase 46 D-15 pattern). tools/staff-engine-entry.ts re-exports the
 * host-neutral engine names from the repository's src/, tools/build-engine.mjs bundles them into `<appRoot>/engine/staff.cjs`, and the backend
 * loads that file on first use. The extension's own code cannot import src/ (its rootDir is extension/src), so the names it calls are typed here
 * structurally; the workbench lint checks this interface against the entry. Nothing here imports Theia, and nothing here reaches the browser.
 */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { defaultAppRoot } from '../team-preview-reader.js';

/** The fields a session key's binding covers (src/domain/replica/sessionKeys.ts). */
export interface SessionBindingFields {
  readonly project: string;
  readonly member: string;
  readonly device: string;
  readonly sessionKey: string;
  readonly slot: number;
  readonly notAfter: string;
}

/** The data of a session.certify entry: the binding fields without the project, and the session key's own signature over the binding. */
export interface SessionCertifyData {
  readonly member: string;
  readonly device: string;
  readonly sessionKey: string;
  readonly slot: number;
  readonly notAfter: string;
  readonly sessionSig: string;
}

/** The engine names the staff backend calls. 33-24 adds the replica project and the live replicator. */
export interface StaffEngine {
  sessionCertifyData(fields: SessionBindingFields, sign: (bytes: Buffer) => string): SessionCertifyData;
  writerIdOf(publicKey: string): string;
  readonly SESSION_DEFAULT_LIFETIME_MS: number;
  readonly ENCRYPTION_KEY_SECRET: string;
  readonly EPOCH_KEY_SECRET_PREFIX: string;
  readonly JOIN_SECRET_PREFIX: string;
}

const loaded = new Map<string, unknown>();

/**
 * The engine bundle under `appRoot` (by default the app root computed from this code's own location, never the working folder). Loaded once
 * per path. Throws a plain error when the bundle is missing, which is a broken image, not something a person can fix.
 */
export function loadStaffEngine<T extends object = StaffEngine>(appRoot: string = defaultAppRoot()): T {
  const file = resolve(appRoot, 'engine', 'staff.cjs');
  if (!loaded.has(file)) {
    try {
      loaded.set(file, createRequire(file)(file));
    } catch (error) {
      throw new Error('The shared-work engine is missing from this workbench build.', { cause: error });
    }
  }
  return loaded.get(file) as T;
}
