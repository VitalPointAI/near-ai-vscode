// Validators for OSCAL documents and our own files, the safe JSON loader, and the no-status walk (44-01, D-16, D-17, D-43, D-44).
// OSCAL documents are checked offline against the vendored OSCAL 1.2.1 complete schema with ajv in non-strict mode (the OSCAL schemas use an
// untyped `pattern`); our own schemas compile in strict mode with every error reported.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';
import { ALLOWED_MAPPING_PROVENANCE_STATUS, ALLOWED_STATUS_FORM, FORBIDDEN_STATUS_NAMES, OSCAL_VERSION, SOURCE_DIRS, SOURCE_FILES } from './model.ts';

// ajv-formats is CommonJS; its plugin is both module.exports and module.exports.default.
const addFormats = addFormatsModule.default;

/** The folder of vendored and own schemas. */
export const SCHEMAS_DIR = fileURLToPath(new URL('../schemas/', import.meta.url));
/** The vendored OSCAL 1.2.1 complete schema (its SHA-256 is in schemas/SOURCES.json). */
export const OSCAL_SCHEMA_FILE = path.join(SCHEMAS_DIR, 'oscal_complete_schema.json');

/** The OSCAL models, named by their root key. */
export const OSCAL_MODELS = Object.freeze([
  'catalog',
  'profile',
  'component-definition',
  'system-security-plan',
  'assessment-plan',
  'assessment-results',
  'plan-of-action-and-milestones',
  'mapping-collection'
] as const);
export type OscalModel = (typeof OSCAL_MODELS)[number];

/** The complete schema's definition for each model's root, as its own `oneOf` names them (read from the 1.2.1 file). */
export const OSCAL_ROOT_DEFINITIONS: Readonly<Record<OscalModel, string>> = Object.freeze({
  'catalog': 'oscal-complete-oscal-catalog:catalog',
  'profile': 'oscal-complete-oscal-profile:profile',
  'component-definition': 'oscal-complete-oscal-component-definition:component-definition',
  'system-security-plan': 'oscal-complete-oscal-ssp:system-security-plan',
  'assessment-plan': 'oscal-complete-oscal-ap:assessment-plan',
  'assessment-results': 'oscal-complete-oscal-ar:assessment-results',
  'plan-of-action-and-milestones': 'oscal-complete-oscal-poam:plan-of-action-and-milestones',
  'mapping-collection': 'oscal-complete-oscal-mapping:mapping-collection'
});

/** The definition of the optional `$schema` key every OSCAL root allows. */
export const OSCAL_SCHEMA_DIRECTIVE_DEFINITION = 'json-schema-directive';

/** Vendored documents (for example the NIST catalogue, stamped 1.2.3) must be on the 1.2 line the vendored schema describes (D-43). */
const VENDORED_VERSION_LINE = /^1\.2\.\d+$/;

/** At most this many errors are returned. */
export const MAX_ERRORS = 5;

export interface ValidationResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

export interface Validators {
  /** The compiled wrapper for one OSCAL model (requires exactly that root). */
  oscalValidator(model: OscalModel): ValidateFunction;
  /** The compiled strict validator for schemas/<name>.schema.json. */
  oursValidator(schemaName: string): ValidateFunction;
  validateOscal(doc: unknown, model: OscalModel, options?: { readonly ours?: boolean }): ValidationResult;
  validateOurs(doc: unknown, schemaName: string): ValidationResult;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function formatErrors(errors: readonly ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).slice(0, MAX_ERRORS).map((error) => {
    const params = error.params as Record<string, unknown>;
    const extra = typeof params.additionalProperty === 'string' ? ` (${params.additionalProperty})` : '';
    return `${error.instancePath || '/'}: ${error.keyword}: ${error.message ?? 'invalid'}${extra}`;
  });
}

const SCHEMA_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Creates a fresh pair of ajv instances: one for OSCAL (non-strict, with formats), one for our own schemas (strict, all errors, with formats). */
export function createValidators(schemasDir: string = SCHEMAS_DIR): Validators {
  const oscal = new Ajv({ strict: false, allErrors: false });
  addFormats(oscal);
  const complete = JSON.parse(readFileSync(path.join(schemasDir, path.basename(OSCAL_SCHEMA_FILE)), 'utf8')) as { $id: string };
  oscal.addSchema(complete);
  const ours = new Ajv({ strict: true, allErrors: true });
  addFormats(ours);

  const oscalCache = new Map<OscalModel, ValidateFunction>();
  const oursCache = new Map<string, ValidateFunction>();

  const oscalValidator = (model: OscalModel): ValidateFunction => {
    if (!OSCAL_MODELS.includes(model)) throw new Error(`unknown OSCAL model: ${String(model)}`);
    let validate = oscalCache.get(model);
    if (!validate) {
      validate = oscal.compile({
        $id: `urn:near-ai-vscode:compliance:oscal-root:${model}`,
        type: 'object',
        properties: {
          $schema: { $ref: `${complete.$id}#/definitions/${OSCAL_SCHEMA_DIRECTIVE_DEFINITION}` },
          [model]: { $ref: `${complete.$id}#/definitions/${OSCAL_ROOT_DEFINITIONS[model]}` }
        },
        required: [model],
        additionalProperties: false
      });
      oscalCache.set(model, validate);
    }
    return validate;
  };

  const oursValidator = (schemaName: string): ValidateFunction => {
    if (!SCHEMA_NAME.test(schemaName)) throw new Error(`invalid schema name: ${schemaName}`);
    let validate = oursCache.get(schemaName);
    if (!validate) {
      const schema = loadJson(path.join(schemasDir, `${schemaName}.schema.json`)) as Record<string, unknown>;
      validate = ours.compile(schema);
      oursCache.set(schemaName, validate);
    }
    return validate;
  };

  const validateOscal = (doc: unknown, model: OscalModel, options: { readonly ours?: boolean } = {}): ValidationResult => {
    const validate = oscalValidator(model);
    const errors = validate(doc) ? [] : formatErrors(validate.errors);
    if (errors.length === 0) {
      const root = isPlainObject(doc) ? doc[model] : undefined;
      const metadata = isPlainObject(root) ? root.metadata : undefined;
      const version = isPlainObject(metadata) ? metadata['oscal-version'] : undefined;
      if (options.ours === true && version !== OSCAL_VERSION) errors.push(`/${model}/metadata/oscal-version: a generated document must be stamped ${OSCAL_VERSION}, found ${String(version)}`);
      if (options.ours !== true && (typeof version !== 'string' || !VENDORED_VERSION_LINE.test(version))) errors.push(`/${model}/metadata/oscal-version: expected a 1.2 version, found ${String(version)}`);
    }
    return { ok: errors.length === 0, errors: errors.slice(0, MAX_ERRORS) };
  };

  const validateOurs = (doc: unknown, schemaName: string): ValidationResult => {
    const validate = oursValidator(schemaName);
    return validate(doc) ? { ok: true, errors: [] } : { ok: false, errors: formatErrors(validate.errors) };
  };

  return { oscalValidator, oursValidator, validateOscal, validateOurs };
}

let shared: Validators | undefined;
const sharedValidators = (): Validators => (shared ??= createValidators());

/** Validates an OSCAL document as one model. With `ours`, the document must also be stamped OSCAL 1.2.1 (D-43). */
export function validateOscal(doc: unknown, model: OscalModel, options: { readonly ours?: boolean } = {}): ValidationResult {
  return sharedValidators().validateOscal(doc, model, options);
}

/** Validates one of our own files against schemas/<schemaName>.schema.json (strict). */
export function validateOurs(doc: unknown, schemaName: string): ValidationResult {
  return sharedValidators().validateOurs(doc, schemaName);
}

/** The OSCAL model a document's root key names, or undefined when there is not exactly one known root (besides `$schema`). */
export function modelOf(doc: unknown): OscalModel | undefined {
  if (!isPlainObject(doc)) return undefined;
  const roots = Object.keys(doc).filter((key) => key !== '$schema');
  if (roots.length !== 1) return undefined;
  return (OSCAL_MODELS as readonly string[]).includes(roots[0]) ? (roots[0] as OscalModel) : undefined;
}

/** The default byte cap of loadJson: 16 MiB (the NIST catalogue is about 10.4 MB). */
export const DEFAULT_MAX_JSON_BYTES = 16 * 1024 * 1024;
/** Keys loadJson refuses anywhere in a document. */
export const PROTOTYPE_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype'] as const);

/** Reads and parses a JSON file, refusing a file above `maxBytes` and any object key named `__proto__`, `constructor` or `prototype` at any depth. */
export function loadJson(file: string, options: { readonly maxBytes?: number } = {}): unknown {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_JSON_BYTES;
  const size = statSync(file).size;
  if (size > maxBytes) throw new Error(`${file}: ${size} bytes is above the ${maxBytes} byte cap`);
  const buffer = readFileSync(file);
  if (buffer.length > maxBytes) throw new Error(`${file}: ${buffer.length} bytes is above the ${maxBytes} byte cap`);
  try {
    return JSON.parse(buffer.toString('utf8'), (key, value) => {
      if ((PROTOTYPE_KEYS as readonly string[]).includes(key)) throw new Error(`key ${JSON.stringify(key)} refused`);
      return value;
    });
  } catch (error) {
    throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** One status-like key or prop found in a source file. `file` is relative to the walked folder, with forward slashes. */
export interface StatusField {
  readonly file: string;
  readonly path: string;
  readonly name: string;
  readonly kind: 'key' | 'prop';
}

/** The OSCAL namespace a standard prop may name explicitly; the withdrawal marker is the publisher's, so it is in no namespace of ours. */
const OSCAL_STANDARD_NS = 'http://csrc.nist.gov/ns/oscal';

const segment = (key: string | number): string => (typeof key === 'number' ? `[${key}]` : /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`);
const isForbidden = (name: string): boolean => (FORBIDDEN_STATUS_NAMES as readonly string[]).includes(name.toLowerCase());

/** True for the one allowed form: a `status` prop with value `withdrawn` on a control (an element of a `controls` array) in a file under catalogs/. */
function isAllowedStatusProp(file: string, ownerTrail: readonly (string | number)[], prop: Record<string, unknown>): boolean {
  if (file.split('/')[0] !== ALLOWED_STATUS_FORM.dir) return false;
  if (prop.name !== ALLOWED_STATUS_FORM.propName || prop.value !== ALLOWED_STATUS_FORM.value) return false;
  if (prop.ns !== undefined && prop.ns !== OSCAL_STANDARD_NS) return false;
  const length = ownerTrail.length;
  return length >= 2 && typeof ownerTrail[length - 1] === 'number' && ownerTrail[length - 2] === 'controls';
}

function isAllowedStatusKey(file: string, trail: readonly (string | number)[], key: string): boolean {
  return key === 'status' && file.split('/')[0] === ALLOWED_MAPPING_PROVENANCE_STATUS.dir && trail.length === ALLOWED_MAPPING_PROVENANCE_STATUS.trail.length && trail.every((segment, index) => segment === ALLOWED_MAPPING_PROVENANCE_STATUS.trail[index]);
}

function walkValue(file: string, value: unknown, trail: (string | number)[], found: StatusField[]): void {
  const at = (keys: readonly (string | number)[]): string => `$${keys.map(segment).join('')}`;
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkValue(file, item, [...trail, index], found));
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isForbidden(key) && !isAllowedStatusKey(file, trail, key)) found.push({ file, path: at([...trail, key]), name: key, kind: 'key' });
    if (key === 'props' && Array.isArray(child)) {
      child.forEach((prop, index) => {
        if (typeof prop !== 'object' || prop === null || Array.isArray(prop)) return;
        const name = (prop as Record<string, unknown>).name;
        if (typeof name === 'string' && isForbidden(name) && !isAllowedStatusProp(file, trail, prop as Record<string, unknown>)) {
          found.push({ file, path: at([...trail, 'props', index]), name, kind: 'prop' });
        }
      });
    }
    walkValue(file, child, [...trail, key], found);
  }
}

function jsonFilesIn(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((entry) => path.join(dir, entry))
    .filter((file) => file.endsWith('.json') && statSync(file).isFile())
    .sort();
}

/**
 * Walks every `.json` file under each SOURCE_DIRS folder and each SOURCE_FILES file of `rootDir` (missing ones are skipped by name) and returns every
 * object key and every `props[].name` in FORBIDDEN_STATUS_NAMES (any letter case) outside ALLOWED_STATUS_FORM, with file and JSON path (D-17, D-44).
 * A source file that is not valid JSON throws, naming the file.
 */
export function findStatusFields(rootDir: string): StatusField[] {
  const files = [
    ...SOURCE_DIRS.flatMap((dir) => jsonFilesIn(path.join(rootDir, dir))),
    ...SOURCE_FILES.map((file) => path.join(rootDir, file)).filter((file) => existsSync(file) && statSync(file).isFile())
  ];
  const found: StatusField[] = [];
  for (const file of files) {
    const relativeFile = path.relative(rootDir, file).split(path.sep).join('/');
    walkValue(relativeFile, loadJson(file), [], found);
  }
  return found;
}
