// Where a multi-user staff project keeps its shared state, as paths relative to the project root (D-27, D-46). Pure: no I/O, so the staff host can
// ask "is this project multi-user?" without loading anything under src/staff/replica/.
//
// - REPLICA_DIR holds the replica store: one append-only file per writer per stream, sealed blobs by content hash, signed grants and checkpoints. It
//   ignores itself in git (its own .gitignore), because the store is fed by the transport, not by git, and a tracked append-only folder would be
//   rolled back by a branch switch and conflict on merge.
// - REPLICA_PROJECT_FILE is the convenience copy of the project's genesis pin; the trusted pin lives in extension storage outside the project.
// - LEGACY_DIR is where migration moves today's single-machine ledgers (renamed, never deleted).

/** The replica store folder of a multi-user staff project. */
export const REPLICA_DIR = '.planning/staff/replica';

/** The convenience copy of the project's genesis pin, inside the store folder. */
export const REPLICA_PROJECT_FILE = '.planning/staff/replica/project.json';

/** Where the single-machine ledgers go once a project has become multi-user. */
export const LEGACY_DIR = '.planning/staff/legacy';
