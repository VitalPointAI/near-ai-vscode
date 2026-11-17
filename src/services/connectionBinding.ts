// The connection binding source (CLAS-05 as the owner amplified it, D-50): what says whether the connection a NEAR AI Cloud client uses is proven to end
// inside the private hardware its attestation names. No vscode import. Only the interface lives here for now: no client has a source in this release, so
// every level whose tier is attested-cloud routes local-only. Plan 25 (PR 4d) adds the NEAR AI Cloud source to this file.
import type { ConnectionBindingFact } from '../domain/gate/routing';

export interface ConnectionBindingSource {
  /** The fact held in memory for a host, or undefined when none is. Read by the route check at decision time, so it must not touch the network (OFFL-01). */
  current(host: string): ConnectionBindingFact | undefined;
  /** Checks the binding again, out of band of any decision, and resolves with what it found. */
  refresh(host: string): Promise<ConnectionBindingFact>;
  /** Forgets a binding for a host, for example after a connection did not match it. */
  markNotBound(host: string, detail: string): void;
  /** A fetch pinned to the bound connection, when the source can give one. */
  fetchFor?(fact: ConnectionBindingFact): typeof fetch;
}
