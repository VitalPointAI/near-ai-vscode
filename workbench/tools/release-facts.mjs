#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import releaseFacts from '../engine/release-facts.cjs';

const { FEATURE_IDS, POLICY_DOCUMENT_VERSION, GATE_VOCABULARY_VERSION } = releaseFacts;
const args = process.argv.slice(2);
const digest = args[1];
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--digest'
  || /^sha256:[0-9a-f]{64}$/u.exec(digest)?.[0] !== digest)) {
  console.error('Usage: node workbench/tools/release-facts.mjs [--digest sha256:<64 lowercase hexadecimal digits>]');
  process.exit(1);
}

const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
if (typeof version !== 'string' || /^[0-9]+\.[0-9]+\.[0-9]+$/u.exec(version)?.[0] !== version) {
  console.error('The root package version must have exactly three numeric components.');
  process.exit(1);
}

const policy = [...FEATURE_IDS, `policy-bundle@${POLICY_DOCUMENT_VERSION}`, `vocabulary@${GATE_VOCABULARY_VERSION}`].sort();
const facts = { format: 'sterling-release/1', version, reads: { policy } };
process.stdout.write(`${JSON.stringify(digest === undefined ? facts : { ...facts, digest })}\n`);
