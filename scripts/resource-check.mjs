#!/usr/bin/env node
// The compliance fit check: every third-party resource the repository uses (npm packages, container images, GitHub Actions, the libraries
// shipped under vendor/, the Helm charts and pinned tools of the deployment stack) must have a reviewed entry in compliance/resources.json saying how it helps or affects the compliance requirements, and
// whether it fits; and every model the extension ships a passport for. Run by the required `lint` CI job. No dependencies; the files are read as text.
//
//   node scripts/resource-check.mjs          check, and exit 1 with one plain line per problem
//   node scripts/resource-check.mjs --json   print the inventory (what was found, with each entry's fit) as evidence, then check
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REGISTER_FILE = 'compliance/resources.json';
export const PACKAGE_FILES = Object.freeze(['package.json', 'relay/package.json', 'hub/package.json', 'docs-site/package.json', 'compliance/package.json', 'workbench/package.json']);
export const IMAGE_FILES = Object.freeze(['hub/Dockerfile', 'relay/Dockerfile', 'relay/compose.yaml', 'workbench/Dockerfile']);
export const WORKFLOW_DIR = '.github/workflows';
export const VENDOR_SCRIPT = 'scripts/vendor-libs.mjs';
export const VENDORED_JSON = 'media/vendor/VENDORED.json';
// The deployment stack (Phase 47): vendored Helm charts, pinned tools, third-party images and the base stages of the images we rebuild.
export const CHART_LOCK = 'deploy/charts/charts.lock.json';
export const TOOL_PINS = 'compliance/ci/tool-pins.json';
export const IMAGE_LOCK = 'deploy/bundle/images.lock.json';
export const CONTAINERFILE_DIR = 'deploy/images';
// The model passports the extension ships (Phase 74.1 D-10): one `model:<passport id>` resource per row, read from each row's literal `id: '<id>'` line.
// Phase 74.3 appends its classifier roster here.
export const MODEL_FILES = Object.freeze(['src/domain/gate/shippedPassports.ts']);
// The fixed set of architecture areas every entry's architectureArea names (one place; the component catalogue's area summaries live there too).
export const AREAS_FILE = 'compliance/architecture-areas.json';

export const KINDS = Object.freeze(['npm', 'image', 'action', 'vendored', 'chart', 'tool', 'model']);
export const SCOPES = Object.freeze(['runtime', 'build', 'test']);
export const FITS = Object.freeze(['pass', 'pass-with-conditions', 'fail']);
const FIELDS = Object.freeze(['id', 'kind', 'where', 'component', 'scope', 'purpose', 'role', 'architectureArea', 'roleNeedsReview', 'licence', 'controls', 'evidence', 'crypto', 'cveResponse', 'airGap', 'fit', 'conditions', 'reviewer', 'reviewedAt', 'supplier', 'supplierJurisdiction']);
const ID_PREFIX = Object.freeze({ npm: 'npm:', image: 'image:', action: 'action:', vendored: 'vendor:', chart: 'chart:', tool: 'tool:', model: 'model:' });
const CRYPTO = /^(none|uses-platform|unvalidated|validated:.+)$/;
const AIR_GAP = /^(ok|no|needs-mirror:.+)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// Phase 48.4 D-08: who publishes the resource and the country of that organization's legal seat, as its own pages state it, or unknown.
const JURISDICTION = /^([A-Z]{2}|unknown)$/;
const SHA = /^[0-9a-f]{40}$/;

const read = (root, file) => readFileSync(path.join(root, file), 'utf8');
const add = (found, id, kind, where, extra = {}) => {
  const entry = found.get(id) ?? { id, kind, where: [] };
  if (!entry.where.includes(where)) entry.where.push(where);
  for (const [key, value] of Object.entries(extra)) entry[key] = entry[key] || value;
  found.set(id, entry);
};

/** Splits an image reference into its name (no tag, no digest) and whether it is pinned by a sha256 digest. */
export function parseImage(ref) {
  const [withTag, digest] = ref.split('@');
  const slash = withTag.lastIndexOf('/');
  const colon = withTag.indexOf(':', slash + 1);
  return { name: colon < 0 ? withTag : withTag.slice(0, colon), pinned: /^sha256:[0-9a-f]{64}$/.test(digest ?? '') };
}

/** The `uses:` references of one workflow file's text (comments ignored). */
export function workflowUses(text) {
  return [...text.matchAll(/^\s*(?:-\s+)?uses:\s*['"]?([^\s'"#]+)/gm)].map((match) => match[1]);
}

/** The passport ids of one shipped passports file: each row's own `id: '<id>',` line (a nested object's id never starts a line). */
export function passportIds(text) {
  return [...text.matchAll(/^\s*id: '([^']+)',/gm)].map((match) => match[1]);
}

/** The npm packages vendor-libs.mjs copies or bundles (read from its source, never run). */
export function vendoredFromScript(text) {
  const names = [...text.matchAll(/\bcopy\(\s*'([^']+)'/g)].map((match) => match[1]);
  for (const line of text.split('\n').filter((line) => /\bawait bundle\(/.test(line))) {
    const quoted = [...line.matchAll(/'([^']+)'/g)].map((match) => match[1]);
    if (quoted.length) names.push(quoted.at(-1));
  }
  return names;
}

/**
 * Finds every third-party resource in the repository at `root`. Returns the resources by id, and the problems found while looking (an action or
 * image that is not pinned). Each resource: { id, kind, where (paths), runtime (npm: listed in `dependencies`), pinned (image) }.
 */
export function discover(root) {
  const found = new Map();
  const problems = [];
  for (const file of PACKAGE_FILES.filter((file) => existsSync(path.join(root, file)))) {
    const pkg = JSON.parse(read(root, file));
    for (const name of Object.keys(pkg.dependencies ?? {})) add(found, `npm:${name}`, 'npm', file, { runtime: true });
    for (const name of Object.keys(pkg.devDependencies ?? {})) add(found, `npm:${name}`, 'npm', file);
  }
  const containerfiles = existsSync(path.join(root, CONTAINERFILE_DIR))
    ? readdirSync(path.join(root, CONTAINERFILE_DIR), { withFileTypes: true }).filter((dir) => dir.isDirectory()).map((dir) => `${CONTAINERFILE_DIR}/${dir.name}/Containerfile`).sort()
    : [];
  for (const file of [...IMAGE_FILES, ...containerfiles].filter((file) => existsSync(path.join(root, file)))) {
    const text = read(root, file);
    const stages = new Set();
    const refs = /(?:Dockerfile|Containerfile)$/.test(file)
      ? [...text.matchAll(/^\s*FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/gim)].map((match) => { const ref = match[1]; if (match[2]) stages.add(match[2].toLowerCase()); return ref; })
      : [...text.matchAll(/^\s*image:\s*['"]?([^\s'"#]+)/gm)].map((match) => match[1]);
    // `${VAR:-name}` is an image this repository builds itself; `FROM <stage>` and `scratch` are not images pulled from anywhere.
    for (const ref of refs.filter((ref) => !ref.startsWith('${') && ref !== 'scratch' && !stages.has(ref.toLowerCase()))) {
      const { name, pinned } = parseImage(ref);
      if (!pinned) problems.push(`${file}: the image ${ref} is not pinned by a sha256 digest; pin it (name:tag@sha256:...).`);
      add(found, `image:${name}`, 'image', file, { pinned });
    }
  }
  const workflows = existsSync(path.join(root, WORKFLOW_DIR)) ? readdirSync(path.join(root, WORKFLOW_DIR)).filter((name) => /\.ya?ml$/.test(name)).sort() : [];
  for (const name of workflows) {
    const file = `${WORKFLOW_DIR}/${name}`;
    for (const ref of workflowUses(read(root, file))) {
      if (ref.startsWith('./')) continue;
      const [action, version = ''] = ref.split('@');
      if (!SHA.test(version)) problems.push(`${file}: the action ${ref} is not pinned to a full 40-character commit SHA; pin it (owner/repo@<sha> # vX.Y.Z).`);
      add(found, `action:${action}`, 'action', file);
    }
  }
  // A lock file that does not parse is one plain problem, not a crash.
  const lock = (file) => {
    if (!existsSync(path.join(root, file))) return undefined;
    try { return JSON.parse(read(root, file)); } catch { problems.push(`${file}: is not valid JSON; fix the file so its resources can be checked.`); return undefined; }
  };
  for (const chart of lock(CHART_LOCK)?.charts ?? []) add(found, `chart:${chart.name}`, 'chart', CHART_LOCK);
  for (const name of Object.keys(lock(TOOL_PINS) ?? {})) add(found, `tool:${name}`, 'tool', TOOL_PINS);
  // Only images[] are pulled from elsewhere; built[] are images this repository builds and release[] another pipeline publishes.
  for (const image of lock(IMAGE_LOCK)?.images ?? []) {
    const { name, pinned } = parseImage(String(image.ref));
    if (!pinned) problems.push(`${IMAGE_LOCK}: the image ${image.ref} is not pinned by a sha256 digest; pin it (name:tag@sha256:...).`);
    add(found, `image:${name}`, 'image', IMAGE_LOCK, { pinned });
  }
  if (existsSync(path.join(root, VENDOR_SCRIPT))) for (const name of vendoredFromScript(read(root, VENDOR_SCRIPT))) add(found, `vendor:${name}`, 'vendored', VENDOR_SCRIPT);
  if (existsSync(path.join(root, VENDORED_JSON))) for (const pkg of JSON.parse(read(root, VENDORED_JSON)).packages ?? []) add(found, `vendor:${pkg.name}`, 'vendored', VENDORED_JSON);
  for (const file of MODEL_FILES.filter((file) => existsSync(path.join(root, file)))) for (const id of passportIds(read(root, file))) add(found, `model:${id}`, 'model', file);
  for (const entry of found.values()) entry.where.sort();
  return { resources: found, problems };
}

/** The ids of the architecture areas in AREAS_FILE; empty when the file is missing or unreadable (main() then fails). */
export function areaIds(root) {
  const file = path.join(root, AREAS_FILE);
  if (!existsSync(file)) return new Set();
  try {
    const areas = JSON.parse(readFileSync(file, 'utf8')).areas;
    return new Set(Array.isArray(areas) ? areas.map((area) => area?.id).filter((id) => typeof id === 'string' && id !== '') : []);
  } catch {
    return new Set();
  }
}

/** The control ids in the catalogues under compliance/catalogs (any object with an id and a title), the component ids and the architecture area ids. */
export function knownIds(root) {
  const controls = new Set();
  const catalogs = path.join(root, 'compliance', 'catalogs');
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (typeof node.id === 'string' && typeof node.title === 'string') controls.add(node.id);
    Object.values(node).forEach(walk);
  };
  if (existsSync(catalogs)) for (const dir of readdirSync(catalogs)) {
    const file = path.join(catalogs, dir, 'catalog.json');
    if (existsSync(file)) walk(JSON.parse(readFileSync(file, 'utf8')));
  }
  const componentsDir = path.join(root, 'compliance', 'components');
  const components = new Set(existsSync(componentsDir) ? readdirSync(componentsDir).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5)) : []);
  return { controls, components, areas: areaIds(root) };
}

const nonEmpty = (value) => typeof value === 'string' && value.trim() !== '';
const stringList = (value) => Array.isArray(value) && value.length > 0 && value.every(nonEmpty);

/** The field problems of one register entry. `known` holds the valid control, component and area ids (an empty or missing set skips that membership check; main() refuses a missing area list). */
export function entryProblems(entry, known = { controls: new Set(), components: new Set() }) {
  const id = nonEmpty(entry?.id) ? entry.id : '(an entry without an id)';
  const say = (text) => `${REGISTER_FILE} ${id}: ${text}`;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [say('is not an object.')];
  const out = [];
  for (const key of Object.keys(entry)) if (!FIELDS.includes(key)) out.push(say(`has an unknown field "${key}".`));
  if (!nonEmpty(entry.id)) out.push(say('needs an id.'));
  if (!KINDS.includes(entry.kind)) out.push(say(`kind must be one of ${KINDS.join(', ')}.`));
  else if (nonEmpty(entry.id) && !entry.id.startsWith(ID_PREFIX[entry.kind])) out.push(say(`the id of a ${entry.kind} resource starts with "${ID_PREFIX[entry.kind]}".`));
  if (!stringList(entry.where)) out.push(say('where must list the files that use it.'));
  if (!nonEmpty(entry.component)) out.push(say('needs a component.'));
  else if (known.components.size && !known.components.has(entry.component)) out.push(say(`component "${entry.component}" is not one of ${[...known.components].sort().join(', ')}.`));
  if (!SCOPES.includes(entry.scope)) out.push(say(`scope must be one of ${SCOPES.join(', ')}.`));
  for (const field of ['purpose', 'licence', 'evidence', 'cveResponse', 'reviewer']) if (!nonEmpty(entry[field])) out.push(say(`needs ${field}.`));
  // Why the architecture needs it (what breaks, or what we would build instead, without it), not a second copy of what it does.
  if (!nonEmpty(entry.role)) out.push(say('needs a role: why the architecture needs it and which part it serves.'));
  else if (nonEmpty(entry.purpose) && entry.role.trim() === entry.purpose.trim()) out.push(say('role repeats purpose; say why the architecture needs it.'));
  if (!nonEmpty(entry.architectureArea)) out.push(say(`needs an architectureArea (an id in ${AREAS_FILE}).`));
  else if (known.areas?.size && !known.areas.has(entry.architectureArea)) out.push(say(`architectureArea "${entry.architectureArea}" is not one of ${[...known.areas].sort().join(', ')}.`));
  if (entry.roleNeedsReview !== undefined && entry.roleNeedsReview !== true) out.push(say('roleNeedsReview is true when present; remove it once the owner has confirmed the role.'));
  if (!stringList(entry.controls)) out.push(say('controls must list at least one control id.'));
  else if (known.controls.size) for (const control of entry.controls.filter((control) => !known.controls.has(control))) out.push(say(`control "${control}" is not in the catalogues.`));
  if (!CRYPTO.test(entry.crypto ?? '')) out.push(say('crypto must be none, uses-platform, unvalidated or validated:<certificate or mode>.'));
  if (!AIR_GAP.test(entry.airGap ?? '')) out.push(say('airGap must be ok, no or needs-mirror:<what>.'));
  if (!nonEmpty(entry.supplier)) out.push(say('supplier must name the organization that publishes it, or say unknown.'));
  if (!(typeof entry.supplierJurisdiction === 'string' && JURISDICTION.test(entry.supplierJurisdiction))) {
    out.push(say('supplierJurisdiction must be an ISO 3166-1 alpha-2 code in capitals (CA, US, BE) or unknown.'));
  }
  if (!DATE.test(entry.reviewedAt ?? '') || Number.isNaN(Date.parse(`${entry.reviewedAt}T00:00:00Z`))) out.push(say('reviewedAt must be a date (YYYY-MM-DD).'));
  if (!FITS.includes(entry.fit)) out.push(say(`fit must be one of ${FITS.join(', ')}.`));
  else if (entry.fit === 'fail') out.push(say(`is marked fail: it does not fit the compliance requirements and may not be used. Remove it, or replace it with a resource that fits.${stringList(entry.conditions) ? ` Reason: ${entry.conditions.join(' ')}` : ''}`));
  else if (entry.fit === 'pass-with-conditions' && !stringList(entry.conditions)) out.push(say('is pass-with-conditions but lists no conditions; write the conditions down.'));
  else if (entry.fit === 'pass') {
    if (entry.conditions !== undefined && !(Array.isArray(entry.conditions) && entry.conditions.length === 0)) out.push(say('is pass but lists conditions; make it pass-with-conditions, or remove the conditions.'));
    // Something the deployed product runs that cannot work without the internet, or relies on unvalidated cryptography, always carries conditions.
    if (entry.scope === 'runtime' && entry.airGap !== 'ok') out.push(say('runs in the product but is not ok air-gapped; it must be pass-with-conditions with the conditions written down.'));
    if (entry.scope === 'runtime' && entry.crypto === 'unvalidated') out.push(say('runs in the product with unvalidated cryptography; it must be pass-with-conditions with the conditions written down.'));
  }
  return out;
}

/** Compares the register with what was discovered. Returns every problem as one plain sentence. */
export function check(register, discovered, known) {
  const problems = [...discovered.problems];
  const entries = Array.isArray(register?.resources) ? register.resources : null;
  if (!entries) return [...problems, `${REGISTER_FILE} must hold a "resources" list.`];
  const byId = new Map();
  for (const entry of entries) {
    problems.push(...entryProblems(entry, known));
    if (!nonEmpty(entry?.id)) continue;
    if (byId.has(entry.id)) problems.push(`${REGISTER_FILE} ${entry.id}: is listed twice.`);
    byId.set(entry.id, entry);
  }
  for (const resource of discovered.resources.values()) {
    const entry = byId.get(resource.id);
    if (!entry) {
      problems.push(`${resource.id} (used in ${resource.where.join(', ')}) has no entry in ${REGISTER_FILE}. Check its compliance fit and add an entry before using it.`);
      continue;
    }
    if (stringList(entry.where) && entry.where.slice().sort().join('\n') !== resource.where.join('\n')) problems.push(`${REGISTER_FILE} ${resource.id}: where lists ${entry.where.join(', ')} but it is used in ${resource.where.join(', ')}; review the new use and update the entry.`);
    if (resource.runtime && entry.scope !== 'runtime') problems.push(`${REGISTER_FILE} ${resource.id}: is a runtime dependency (package.json "dependencies") but its scope is ${entry.scope}.`);
  }
  for (const id of byId.keys()) if (!discovered.resources.has(id)) problems.push(`${REGISTER_FILE} ${id}: nothing in the repository uses it any more; remove the stale entry.`);
  return problems;
}

/** The inventory printed by --json: every discovered resource with its register verdict. */
export function inventory(register, discovered) {
  const byId = new Map((register?.resources ?? []).map((entry) => [entry?.id, entry]));
  return [...discovered.resources.values()].sort((a, b) => a.id.localeCompare(b.id)).map((resource) => {
    const entry = byId.get(resource.id);
    return { ...resource, registered: Boolean(entry), fit: entry?.fit ?? null, scope: entry?.scope ?? null, component: entry?.component ?? null, licence: entry?.licence ?? null,
      supplier: entry?.supplier ?? null, supplierJurisdiction: entry?.supplierJurisdiction ?? null };
  });
}

export function main(argv = process.argv.slice(2), root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')) {
  const register = JSON.parse(read(root, REGISTER_FILE));
  const discovered = discover(root);
  if (argv.includes('--json')) process.stdout.write(`${JSON.stringify({ register: REGISTER_FILE, resources: inventory(register, discovered) }, null, 2)}\n`);
  const known = knownIds(root);
  const problems = known.areas.size ? check(register, discovered, known) : [`${AREAS_FILE} is missing or lists no areas; every entry's architectureArea is checked against it.`, ...check(register, discovered, known)];
  for (const problem of problems) process.stderr.write(`${problem}\n`);
  if (problems.length) {
    process.stderr.write(`\nThe compliance fit check failed (${problems.length} problem${problems.length === 1 ? '' : 's'}). See "Adding a resource" in compliance/README.md.\n`);
    return 1;
  }
  if (!argv.includes('--json')) process.stdout.write(`Compliance fit check passed: ${discovered.resources.size} resources, each with a reviewed entry in ${REGISTER_FILE}.\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
