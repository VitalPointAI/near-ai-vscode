// Copied from relay/src/types/node-sqlite-database.d.ts and adapted for the hub (D-26, D-28).
import 'node:sqlite';

declare module 'node:sqlite' {
  // @types/node declares only the deprecated alias of this class, while Node 26.13.1 exports it as Database (the same class). If a later
  // @types/node adds Database, tsc reports a duplicate declaration here and this file is deleted (68-RESEARCH.md Pitfall 1).
  export class Database extends DatabaseSync {}
}
