// Budget and inventory for the fixed, single-node lab profile.
import { readFileSync } from 'node:fs';
import { metadataName } from '../bundle/lib/invariants.mjs';
import { splitDocs } from '../bundle/lib/render.mjs';

const FIXED = [
  { id: 'registry', release: 'zot', namespace: 'sterling-registry', name: 'zot', template: 'zot-pvc', option: 'pvc.storage' },
  { id: 'secrets', release: 'openbao', namespace: 'sterling-openbao', name: 'openbao', template: 'data', option: 'server.dataStorage.size' },
  { id: 'secretSnapshots', release: 'openbao', namespace: 'sterling-openbao', name: 'openbao-snapshots', option: 'sterling.snapshots.size' },
  { id: 'secretTokens', release: 'openbao', namespace: 'sterling-openbao', name: 'openbao-lab-tokens', manual: true },
  { id: 'identity', release: 'sterling-postgres', namespace: 'sterling-identity', name: 'sterling-postgres', template: 'data', option: 'dataSize' },
  { id: 'identityDumps', release: 'sterling-postgres', namespace: 'sterling-identity', name: 'sterling-postgres-dumps', option: 'dump.size' },
  { id: 'hub', release: 'sterling-hub', namespace: 'sterling-hubs', name: 'hub-lab', template: 'state' },
];
const WORKSPACE_NAMESPACE = 'theia-cloud';
const STORAGE_CLASS = 'lab-static';
const MAX_PVC_MIB = 2 ** 43 - 1; // The quantity in bytes must fit in a signed 64-bit integer.
const quantity = (miB) => `${miB}Mi`;

function exactFields(value, fields) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

export function readStoragePlan(file) {
  let input;
  try {
    input = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error('Supply a readable JSON storage plan.');
  }
  if (!exactFields(input, ['usableMiB', 'reserveMiB', 'volumesMiB'])) {
    throw new Error('The storage plan needs exactly usableMiB, reserveMiB and volumesMiB.');
  }
  const { usableMiB, reserveMiB, volumesMiB } = input;
  for (const [field, value] of Object.entries({ usableMiB, reserveMiB })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`The storage plan needs a positive integer for ${field}.`);
  }
  const ids = [...FIXED.map(({ id }) => id), 'workspace'];
  if (!exactFields(volumesMiB, ids)) throw new Error(`The storage plan volumesMiB needs exactly: ${ids.join(', ')}.`);
  for (const [id, miB] of Object.entries(volumesMiB)) {
    if (!Number.isSafeInteger(miB) || miB <= 0 || miB > MAX_PVC_MIB) {
      throw new Error(`The storage plan volume ${id} needs a positive integer MiB size within the Kubernetes quantity limit.`);
    }
  }
  const volumeMiB = Object.values(volumesMiB).reduce((sum, miB) => sum + miB, 0);
  // Each volume is limited to 43 bits, so the full eight-volume sum remains exact.
  if (volumeMiB > usableMiB - reserveMiB) throw new Error('The storage plan exceeds usable capacity after reserving headroom.');
  return { usableMiB, reserveMiB, volumesMiB, volumeMiB, unallocatedMiB: usableMiB - reserveMiB - volumeMiB };
}

export function labStorageSettings(settings, plan) {
  return {
    ...settings,
    requestedStorage: quantity(plan.volumesMiB.workspace),
    hubs: [{ ...settings.hubs[0], storage: quantity(plan.volumesMiB.hub) }],
  };
}

export function labStorageOverrides(release, plan) {
  return FIXED.filter((entry) => entry.release === release && entry.option)
    .map(({ option, id }) => `${option}=${quantity(plan.volumesMiB[id])}`);
}

// Inspect the block layout of the pinned charts. Refuse a changed layout instead of overlooking a request.
function block(lines, index, indent) {
  const result = [];
  for (const line of lines.slice(index + 1)) {
    if (line.trim() && line.search(/\S/) <= indent) break;
    result.push(line);
  }
  return result;
}

function fieldIndexes(lines, indent, field) {
  const prefix = ' '.repeat(indent);
  const canonical = `${prefix}${field}:`;
  const pattern = new RegExp(`^${prefix}["']?${field}["']?[ \t]*:`);
  return lines.flatMap((line, index) => {
    if (!pattern.test(line)) return [];
    if (!line.startsWith(canonical)) throw new Error(`Unsupported rendered storage layout for ${field}.`);
    return [index];
  });
}

function section(lines, indent, field) {
  const indexes = fieldIndexes(lines, indent, field);
  if (indexes.length === 0) return undefined;
  if (indexes.length !== 1 || lines[indexes[0]].trim() !== `${field}:`) {
    throw new Error(`Ambiguous rendered storage section ${field}.`);
  }
  return block(lines, indexes[0], indent);
}

function simpleValue(value) {
  const token = value?.trim();
  if (!token) return undefined;
  return /^[\w-]+$/.test(token) ? token : /^(["'])([\w-]+)\1$/.exec(token)?.[2];
}

function scalar(lines, indent, field, fallback) {
  const label = `${' '.repeat(indent)}${field}:`;
  const indexes = fieldIndexes(lines, indent, field);
  if (!indexes.length) return fallback;
  const value = indexes.length === 1 && simpleValue(lines[indexes[0]].slice(label.length));
  if (!value) throw new Error(`Invalid rendered storage field ${field}.`);
  return value;
}

function verifyQuantity(lines, indent, expected, label) {
  const resources = section(lines, indent, 'resources') ?? [];
  const requests = section(resources, indent + 2, 'requests') ?? [];
  if (scalar(lines, indent, 'storageClassName') !== STORAGE_CLASS ||
      scalar(requests, indent + 4, 'storage') !== quantity(expected)) {
    throw new Error(`Rendered storage for ${label} must request ${expected}Mi on ${STORAGE_CLASS}.`);
  }
}

function verifyTemplate(spec, expected, miB) {
  const { name, template } = expected;
  const templates = section(spec, 2, 'volumeClaimTemplates') ?? [];
  const items = templates.filter((line) => /^    - /.test(line));
  if (items.length !== 1 || scalar(spec, 2, 'replicas') !== '1') {
    throw new Error(`Rendered storage for ${name} requires one claim template and one replica.`);
  }
  const ordinals = section(spec, 2, 'ordinals') ?? [];
  if (scalar(ordinals, 4, 'start', '0') !== '0') throw new Error(`Rendered storage for ${name} must start at ordinal zero.`);
  const fields = templates.map((line) => line.replace(/^    - /, '      '));
  if (scalar(section(fields, 6, 'metadata') ?? [], 8, 'name') !== template) {
    throw new Error(`Unexpected rendered storage template for ${name}.`);
  }
  verifyQuantity(section(fields, 6, 'spec') ?? [], 8, miB, name);
}

function podClaimReferences(lines) {
  return lines.flatMap((line, index) => {
    if (!/(?:^|[ {,])["']?persistentVolumeClaim["']?[ \t]*:/.test(line)) return [];
    const field = /^( *)(- )?persistentVolumeClaim:[ \t]*$/.exec(line);
    if (!field) throw new Error('Unsupported rendered storage layout for persistentVolumeClaim.');
    const indent = field[1].length + (field[2]?.length ?? 0);
    const claim = scalar(block(lines, index, indent), indent + 2, 'claimName');
    if (!claim) throw new Error('Missing claimName in rendered persistentVolumeClaim.');
    return [claim];
  });
}

function verifyWorkspace(docs, settings) {
  const find = (release, kind, name) => {
    const found = docs.filter((doc) => doc.release === release && doc.kind === kind && doc.name === name &&
      doc.namespace === WORKSPACE_NAMESPACE);
    if (found.length !== 1) throw new Error(`Expected one rendered lab workspace resource ${name}.`);
    return found[0];
  };
  const operator = find('theia-cloud', 'Deployment', 'operator-deployment');
  const flag = (name) => {
    const values = [...operator.text.matchAll(new RegExp(`^ +-[ \\t]+"?--${name}"?[ \\t]*\\n +-[ \\t]+([^\\n]+)$`, 'gm'))];
    return values.length === 1 && simpleValue(values[0][1]);
  };
  const landing = find('theia-cloud', 'ConfigMap', 'landing-page-config');
  const app = find('sterling-sessions', 'AppDefinition', 'sterling-workbench');
  if (flag('requestedStorage') !== settings.requestedStorage || flag('storageClassName') !== STORAGE_CLASS ||
      !/^ +useEphemeralStorage: false,$/m.test(landing.text) || scalar(section(app.lines, 0, 'spec') ?? [], 2, 'maxInstances') !== '1') {
    throw new Error('Rendered workspace storage must be persistent on lab-static at the planned size with one active instance.');
  }
}

export function verifyLabStorage(rendered, plan, settings) {
  const docs = rendered.flatMap(({ name: release, namespace, yaml }) => splitDocs(yaml).map((text) => {
    const lines = text.split('\n');
    const metadata = section(lines, 0, 'metadata') ?? [];
    return { release, text, lines, kind: scalar(lines, 0, 'kind'), name: metadataName(text),
      namespace: scalar(metadata, 2, 'namespace', namespace) };
  }));
  const observed = new Set();
  const manualReferences = new Set();
  const allocations = FIXED.map(({ id, namespace, name, template, manual }) => ({
    id, namespace, claim: template ? `${template}-${name}-0` : name, miB: plan.volumesMiB[id], source: manual ? 'manual' : 'rendered',
  }));
  const roster = new Set(allocations.map(({ namespace, claim }) => `${namespace}/${claim}`));
  for (const doc of docs) {
    const { release, kind, name, namespace, lines } = doc;
    for (const claim of podClaimReferences(lines)) {
      const binding = `${namespace}/${claim}`;
      if (!roster.has(binding)) throw new Error(`Unexpected rendered persistent claim reference ${binding}.`);
      const manual = FIXED.find((item) => item.manual && item.namespace === namespace && item.name === claim);
      if (manual && release === manual.release && kind === 'StatefulSet' && name === manual.release) {
        manualReferences.add(binding);
      }
    }
    for (const line of lines) {
      if (/(?:^|[ {,])["']?volumeClaimTemplate["']?[ \t]*:/.test(line)) {
        throw new Error(`Unexpected ephemeral claim template in ${namespace}/${name}.`);
      }
      if (/(?:^|[ {,])["']?volumeClaimTemplates["']?[ \t]*:/.test(line) &&
          !(kind === 'StatefulSet' && /^ {2}volumeClaimTemplates:[ \t]*$/.test(line))) {
        throw new Error(`Unsupported rendered storage layout for claim templates in ${namespace}/${name}.`);
      }
    }
    if (kind !== 'StatefulSet' && kind !== 'PersistentVolumeClaim') continue;
    const spec = section(lines, 0, 'spec') ?? [];
    if (kind === 'StatefulSet' && !section(spec, 2, 'volumeClaimTemplates')) continue;
    const expected = FIXED.find((item) => !item.manual && item.release === release && item.namespace === namespace &&
      item.name === name && Boolean(item.template) === (kind === 'StatefulSet'));
    if (!expected || observed.has(expected.id)) throw new Error(`Unexpected or duplicate rendered storage for ${namespace}/${name}.`);
    observed.add(expected.id);
    if (expected.template) verifyTemplate(spec, expected, plan.volumesMiB[expected.id]);
    else verifyQuantity(spec, 2, plan.volumesMiB[expected.id], name);
  }
  for (const { id, source, namespace, claim } of allocations) {
    const binding = `${namespace}/${claim}`;
    if (source === 'manual' ? !manualReferences.has(binding) : !observed.has(id)) {
      throw new Error(`Missing rendered storage requirement ${binding}.`);
    }
  }
  verifyWorkspace(docs, settings);
  const { usableMiB, reserveMiB, volumeMiB, unallocatedMiB } = plan;
  return {
    usableMiB, reserveMiB, volumeMiB, unallocatedMiB, allocations,
    reservation: { id: 'workspace', namespace: WORKSPACE_NAMESPACE, miB: plan.volumesMiB.workspace, retainedWorkspaces: 1 },
  };
}
