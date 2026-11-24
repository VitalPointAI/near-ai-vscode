#!/usr/bin/env node
// Checks one verified credential with the product's own checker (Phase 71 plan 08; research row C). The deployment tools call it before they act on a
// person's authority: 47-19's guests.mjs checks the approver's SecurityContactCredential with it. Plain Node, no package: it imports the generated
// credential-checker.engine.mjs beside it, which travels in your organization's signed offline bundle.
//
//   node deploy/tools/credential-check.mjs --holder <did> --type <CredentialType> --credential <file> --trust <dir> \
//     [--scope <scope>] [--at <time>] [--holder-name <name>]
//
// The trust folder holds what the check needs, all of it signed:
//   issuer.pub                 your organization's policy issuer key (base64url, 32 bytes), from the enrolment
//   organization.near-org-rules your organization's signed rules, with the credentials section
//   logs/*.jsonl               did:webvh logs (your organization's root, the issuers, the holder)
//   lists/*.json               signed status lists
//   roles/*.json               the issuers' role credentials
//
// Exit codes: 0 the holder holds a valid credential of that type; 1 it does not, or it cannot be checked (one plain sentence on stderr); 2 usage.
// It prints only the type and the holder's name (when --holder-name is given), never the credential or its claims.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.join(HERE, 'credential-checker.engine.mjs');
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const USAGE = 'usage: credential-check.mjs --holder <did> --type <CredentialType> --credential <file> --trust <dir> [--scope <scope>] [--at <time>] [--holder-name <name>]';
export const INCOMPLETE_TEXT = 'This tool is incomplete. Use the copy from your organization\'s signed offline bundle.';

class Refusal extends Error {}
class Usage extends Error {}

function readText(file) {
  if (!existsSync(file) || !statSync(file).isFile()) throw new Refusal(`A file the check needs is missing: ${path.basename(file)}.`);
  if (statSync(file).size > MAX_FILE_BYTES) throw new Refusal(`A file the check needs is too large: ${path.basename(file)}.`);
  return readFileSync(file, 'utf8');
}

function readJson(file) {
  try {
    return JSON.parse(readText(file));
  } catch (error) {
    if (error instanceof Refusal) throw error;
    throw new Refusal(`A file the check needs is not JSON: ${path.basename(file)}.`);
  }
}

function filesIn(dir, suffix) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(suffix)).sort().map((name) => path.join(dir, name));
}

function parseArgs(argv) {
  const known = new Set(['--holder', '--type', '--credential', '--trust', '--scope', '--at', '--holder-name']);
  const out = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!known.has(flag) || value === undefined || value.startsWith('--')) throw new Usage(USAGE);
    out[flag.slice(2)] = value;
  }
  for (const required of ['holder', 'type', 'credential', 'trust']) if (out[required] === undefined) throw new Usage(USAGE);
  if (out.at !== undefined && Number.isNaN(Date.parse(out.at))) throw new Usage(USAGE);
  return out;
}

async function loadEngine() {
  if (!existsSync(ENGINE)) throw new Refusal(INCOMPLETE_TEXT);
  try {
    return await import(ENGINE);
  } catch {
    throw new Refusal(INCOMPLETE_TEXT);
  }
}

/** The newest copy of each list id among the signed lists given (the enforcement point uses the newest it holds). */
function newestLists(engine, blobs, keysById) {
  const byId = new Map();
  for (const blob of blobs) {
    const id = typeof blob?.id === 'string' ? blob.id : undefined;
    const key = id === undefined ? undefined : keysById.get(id);
    if (key === undefined) continue;
    const verified = engine.verifyStatusList(blob, key);
    if (!verified.ok) continue;
    const held = byId.get(id);
    if (held === undefined || verified.list.version > held.list.version) byId.set(id, { blob, list: verified.list, hash: verified.hash });
  }
  return byId;
}

export async function check(args, now = Date.now()) {
  const engine = await loadEngine();
  const at = args.at === undefined ? now : Date.parse(args.at);
  const trust = path.resolve(args.trust);
  const issuerKey = readText(path.join(trust, 'issuer.pub')).trim();
  const layer = engine.verifyOrganizationLayer(readText(path.join(trust, 'organization.near-org-rules')), { issuerPublicKey: issuerKey, now: at });
  if (!layer.ok) throw new Refusal('Your organization\'s rules in the trust folder do not verify with its key.');
  const section = layer.document.credentials;
  if (section === undefined) throw new Refusal('Your organization\'s rules hold no credentials section, so no credential can be checked against them.');
  const policy = { section, scales: layer.document.labels.scales };
  const states = {};
  for (const file of filesIn(path.join(trust, 'logs'), '.jsonl')) {
    const verified = engine.verifyWebvhLog(readText(file), { now: at });
    if (verified.ok) states[verified.state.did] = verified.state;
  }
  const keysById = new Map(section.statusLists.map((entry) => [entry.uri, engine.decodePublicKeyMultibase(entry.key)]));
  const lists = newestLists(engine, filesIn(path.join(trust, 'lists'), '.json').map(readJson), keysById);
  // A list that does not verify against the policy's key is never used; a forged one is reported as such rather than as missing.
  for (const file of filesIn(path.join(trust, 'lists'), '.json')) {
    const blob = readJson(file);
    const key = keysById.get(blob?.id);
    if (key !== undefined && !engine.verifyStatusList(blob, key).ok && !lists.has(blob.id)) throw new Refusal('A status list in the trust folder was not signed by the key your organization\'s rules name for it.');
  }
  const blob = readJson(path.resolve(args.credential));
  const read = engine.readCredential(blob, policy.scales, { signed: true });
  if (!read.ok) throw new Refusal('This file is not a credential this tool can read.');
  if (read.value.type !== args.type) throw new Refusal(`This credential is not a ${args.type}.`);
  if (read.value.claims.id !== args.holder) throw new Refusal('This credential is about someone else.');
  if (args.scope !== undefined && read.value.claims.scope !== args.scope) throw new Refusal('This credential is not for that scope.');
  const hash = engine.credentialHash(blob);
  const credentials = { [hash]: blob };
  const evidence = [hash];
  for (const file of filesIn(path.join(trust, 'roles'), '.json')) {
    const role = readJson(file);
    const roleRead = engine.readCredential(role, policy.scales, { signed: true });
    if (!roleRead.ok || roleRead.value.claims.id === args.holder) continue;
    const roleHash = engine.credentialHash(role);
    credentials[roleHash] = role;
    evidence.push(roleHash);
  }
  const status = [];
  const listBlobs = {};
  for (const [id, held] of lists) {
    status.push({ list: id, hash: held.hash, validFrom: held.list.validFrom });
    listBlobs[held.hash] = held.blob;
  }
  const result = engine.checkEvidence({ evidence, status }, { credentials, lists: listBlobs, policy, didState: { states }, member: args.holder, signedAt: at });
  if (!result.ok) throw new Refusal(result.message);
  const who = args['holder-name'] ?? 'The holder';
  return `${who} holds a valid ${args.type}.`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(await check(parseArgs(process.argv.slice(2))));
  } catch (error) {
    if (error instanceof Usage) {
      console.error(error.message);
      process.exit(2);
    }
    console.error(error instanceof Refusal ? error.message : 'The credential could not be checked.');
    process.exit(1);
  }
}
