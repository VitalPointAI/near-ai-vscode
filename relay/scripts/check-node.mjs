#!/usr/bin/env node
// Refuses to run the relay's build, lint or tests on the wrong Node: prints one plain sentence and exits 1. The version rule lives in
// src/nodeVersion.ts (Node 24 and 26 strip its types natively), so this script, the start guard and the tests agree.
import { checkNodeVersion } from '../src/nodeVersion.ts';

const refusal = checkNodeVersion(process.versions.node);
if (refusal) {
  process.stderr.write(`${refusal}\n`);
  process.exit(1);
}
