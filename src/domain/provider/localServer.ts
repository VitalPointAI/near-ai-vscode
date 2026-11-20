// FND-09, D-43: how the editor looks after a local model server. Interface only. Phase 32.2 implements one per local server; kind is data, so a new
// server needs no change here. Pure: types only.

/** A model a local server has installed. */
export interface LocalModelRef {
  readonly name: string;
  /** The model file's SHA-256 (64 hex characters), when the server reports one. */
  readonly sha256?: string;
  readonly sizeBytes?: number;
}

/** A model to install, with the hash its file must have; built from a policy catalogue entry by the caller. */
export interface LocalInstallRequest {
  readonly name: string;
  readonly sha256: string;
}

/** One local model server. install and remove are optional: a server that cannot do them leaves them out, and the caller says so. */
export interface LocalServerAdmin {
  /** Which server this is (for example its product name); plain data, never a closed list. */
  readonly kind: string;
  /** The server's version when it answers as the server it claims to be; undefined when it does not. */
  identify(signal?: AbortSignal): Promise<{ readonly version?: string } | undefined>;
  listInstalled(signal?: AbortSignal): Promise<readonly LocalModelRef[]>;
  install?(request: LocalInstallRequest, signal?: AbortSignal): Promise<void>;
  remove?(name: string, signal?: AbortSignal): Promise<void>;
  /** True only when the installed model's file has exactly this SHA-256. */
  verifyHash(name: string, sha256: string, signal?: AbortSignal): Promise<boolean>;
}
