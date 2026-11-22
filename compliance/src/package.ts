import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { toCsv } from '../../docs-site/src/compliance/lib.mjs';
import { loadComponents } from './components.ts';
import type { Dashboard } from './dashboard.ts';
import { loadGaps, loadPoam } from './gaps.ts';
import { verifyManifest } from './manifest.ts';
import type { Observation } from './model.ts';
import { buildSsp, type SspInput } from './oscalSsp.ts';
import { buildAssessmentPlan, buildAssessmentResults } from './oscalAssessment.ts';
import { buildPoam, type PoamGap } from './oscalPoam.ts';
import { renderGaps, renderReadme, renderSspMarkdown } from './readable.ts';
import { assertNoSecrets, redactObservation } from './redact.ts';
import { lintPage } from './wordLint.ts';
import { loadJson, validateOscal, validateOurs } from './validate.ts';

export interface PackageLevel { readonly id: string; readonly title: string; readonly profile: string; readonly components: readonly string[]; readonly kind?: string }
export interface PackageOptions { readonly release: string; readonly bundle: string; readonly out: string; readonly sourceRoot?: string; readonly levels?: readonly PackageLevel[]; readonly resolved?: string; readonly sboms?: readonly string[] }
export interface PackageResult { readonly directory: string; readonly verify: () => void }
const stable = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const files = (dir: string, root = dir): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const file = path.join(dir, entry.name);
  if (entry.isDirectory()) return files(file, root);
  const relative = path.relative(root, file);
  if (!entry.isFile() || /[\r\n\\]/.test(entry.name)) throw new Error(`unsupported package file: ${relative}`);
  return [relative];
}).sort();
const digest = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const checksums = (dir: string) => `${files(dir).filter((relative) => relative !== 'SHA256SUMS')
  .map((relative) => `${digest(path.join(dir, relative))}  ${relative.split(path.sep).join('/')}`).join('\n')}\n`;
const safeRelease = (release: string) => { if (!/^v?[0-9A-Za-z][0-9A-Za-z._-]*$/.test(release)) throw new Error('invalid release tag'); return release; };
type SourceModel = 'catalog' | 'profile';
type ProfileDocument = { profile: { imports: { href: string; 'include-controls'?: { 'with-ids'?: string[] }[] }[] } };
type ComponentDocument = { 'component-definition': { components?: { 'control-implementations'?: { source: string }[] }[] } };
type CatalogPart = { id?: string; name: string; ns?: string; prose?: string };
type CatalogContent = {
  controls?: (CatalogContent & { id: string; parts?: CatalogPart[] })[];
  groups?: CatalogContent[];
};
const ITSG_PROFILE = 'profiles/itsg33-profile3.json';
const ITSG_CATALOGUE = 'catalogs/itsg-33/annex-3a.json';
const ITSG_ASSESSOR = 'catalogs/itsg-33/assessor-annex-3a.json';

function validateDocument(file: string, document: unknown, model: Parameters<typeof validateOscal>[1], ours = true): void {
  const valid = validateOscal(document, model, { ours });
  if (!valid.ok) throw new Error(`${file}: ${valid.errors.join('; ')}`);
}

function readOscalSource(root: string, relative: string): unknown {
  const file = path.join(root, relative);
  if (realpathSync(file) !== file) throw new Error(`OSCAL source cannot use a symbolic link: ${relative}`);
  return loadJson(file);
}

/** Stage precisely the profile and catalogue that will be included in the assessor package. */
export function stageAssessorItsg33Profile(output: string, sourceRoot = 'compliance'): string {
  const root = realpathSync(sourceRoot);
  for (const [relative, source, model] of [[ITSG_PROFILE, ITSG_PROFILE, 'profile'], [ITSG_CATALOGUE, ITSG_ASSESSOR, 'catalog']] as const) {
    validateDocument(source, readOscalSource(root, source), model);
    const file = path.join(output, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    cpSync(path.join(root, source), file, { force: false, errorOnExist: true });
  }
  return path.join(output, ITSG_PROFILE);
}

function catalogStatements(content: CatalogContent, statements = new Map<string, CatalogPart>()): Map<string, CatalogPart> {
  for (const control of content.controls ?? []) {
    const statement = control.parts?.find((part) => part.name === 'statement' && part.id &&
      (part.ns === undefined || part.ns === 'http://csrc.nist.gov/ns/oscal'));
    if (statement) statements.set(control.id, statement);
    catalogStatements(control, statements);
  }
  for (const group of content.groups ?? []) catalogStatements(group, statements);
  return statements;
}

/** Keep the source layout under oscal/ so profile imports work after extraction. */
function packageSources(root: string, destination: string, levels: readonly PackageLevel[], resolved?: string): ReadonlyMap<string, ReadonlyMap<string, string>> {
  const copied = new Map<string, Map<string, string>>();
  const active = new Set<string>();
  function copySource(relative: string): Map<string, string> {
    if (!/^(profiles|catalogs)\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.json$/.test(relative) ||
      relative.split('/').some((part) => part === '.' || part === '..')) throw new Error(`unsafe OSCAL source path: ${relative}`);
    const existing = copied.get(relative);
    if (existing) return existing;
    if (active.has(relative)) throw new Error(`cyclic OSCAL profile import: ${relative}`);
    active.add(relative);
    const model: SourceModel = relative.startsWith('profiles/') ? 'profile' : 'catalog';
    const source = relative === ITSG_CATALOGUE ? ITSG_ASSESSOR : relative;
    const document = readOscalSource(root, source);
    validateDocument(relative, document, model, false);
    const statements = new Map<string, string>();
    if (model === 'profile') {
      for (const { href } of (document as ProfileDocument).profile.imports) {
        if (!/^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.json$/.test(href)) throw new Error(`unsupported OSCAL import: ${href}`);
        for (const [id, statement] of copySource(path.posix.join(path.posix.dirname(relative), href))) statements.set(id, statement);
      }
    } else {
      for (const [id, statement] of catalogStatements((document as { catalog: CatalogContent }).catalog)) {
        if (statement.id) statements.set(id, statement.id);
      }
    }
    const target = path.join(destination, 'oscal', relative);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(path.join(root, source), target);
    active.delete(relative);
    copied.set(relative, statements);
    return statements;
  }

  for (const level of levels) copySource(level.profile);
  const componentDir = path.join(root, 'components');
  const componentTarget = path.join(destination, 'oscal/component-definitions');
  mkdirSync(componentTarget);
  for (const source of readdirSync(componentDir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith('.json')).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(componentDir, source.name);
    const document = loadJson(file) as ComponentDocument;
    validateDocument(file, document, 'component-definition');
    for (const component of document['component-definition'].components ?? []) {
      for (const implementation of component['control-implementations'] ?? []) {
        copySource(implementation.source);
        implementation.source = `../${implementation.source}`;
      }
    }
    validateDocument(source.name, document, 'component-definition');
    writeFileSync(path.join(componentTarget, source.name), stable(document));
  }
  const notice = path.join(root, 'catalogs/NOTICE');
  if (existsSync(notice)) cpSync(notice, path.join(destination, 'oscal/catalogs/NOTICE'));

  if (resolved) {
    const resolvedRoot = realpathSync(resolved);
    const target = path.join(destination, 'oscal/profiles/resolved');
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(path.join(root, 'profiles'), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const file = path.join(resolvedRoot, entry.name);
      if (!existsSync(file)) throw new Error(`missing resolved catalogue: ${entry.name}`);
      if (realpathSync(file) !== file) throw new Error(`resolved catalogue cannot use a symbolic link: ${entry.name}`);
      const document = loadJson(file) as { catalog: CatalogContent };
      validateDocument(entry.name, document, 'catalog', false);
      if (`profiles/${entry.name}` === ITSG_PROFILE) {
        copySource(ITSG_PROFILE);
        const oscal = path.join(destination, 'oscal');
        const { profile } = loadJson(path.join(oscal, ITSG_PROFILE)) as ProfileDocument;
        const selected = new Set(profile.imports.flatMap((item) => item['include-controls']?.flatMap((selection) => selection['with-ids'] ?? []) ?? []));
        const expected = catalogStatements((loadJson(path.join(oscal, ITSG_CATALOGUE)) as { catalog: CatalogContent }).catalog);
        const actual = catalogStatements(document.catalog);
        // OSCAL CLI 3.2.0 drops the Markdown indentation of nested list lines.
        const unindent = (prose: string) => prose.replace(/^[\t ]+/gm, '');
        if (!selected.size || actual.size !== selected.size || [...selected].some((id) => {
          const source = expected.get(id);
          const resolvedPart = actual.get(id);
          return !source?.prose || !resolvedPart?.prose || source.id !== resolvedPart.id ||
            unindent(source.prose) !== unindent(resolvedPart.prose);
        })) throw new Error('resolved ITSG-33 catalogue must match the assessor profile selections and published statements');
      }
      cpSync(file, path.join(target, entry.name));
    }
  }
  return copied;
}

function copySupportingDocuments(root: string, destination: string): void {
  const repo = path.dirname(root);
  const security = readdirSync(path.join(repo, 'docs/security'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => `docs/security/${entry.name}`);
  for (const relative of ['SECURITY.md', 'docs/development-workflow.md', ...security]) {
    const source = path.join(repo, relative);
    if (realpathSync(source) !== source) throw new Error(`supporting document cannot use a symbolic link: ${relative}`);
    const target = path.join(destination, 'supporting', relative);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(source, target);
  }
}

/** Build a deterministic, redacted assessor package. It never modifies the supplied evidence bundle. */
export function buildPackage(options: PackageOptions): PackageResult {
  const root = realpathSync(options.sourceRoot ?? 'compliance'); const bundle = path.resolve(options.bundle); const release = safeRelease(options.release);
  const checkedBundle = verifyManifest(bundle);
  if (!checkedBundle.ok) throw new Error(`invalid evidence bundle: ${checkedBundle.errors.join('; ')}`);
  const dashboard = loadJson(path.join(bundle, 'dashboard', 'dashboard.json')) as Dashboard;
  const dashboardValidation = validateOurs(dashboard, 'dashboard');
  if (!dashboardValidation.ok) throw new Error(`invalid evidence dashboard: ${dashboardValidation.errors.join('; ')}`);
  const manifest = loadJson(path.join(bundle, 'manifest.json')) as { commit: string };
  if (manifest.commit !== dashboard.commit) throw new Error('evidence manifest and dashboard commits differ');
  const recorded = loadJson(path.join(bundle, 'observations.json')) as { schemaVersion: number; commit: string; observations: Observation[] };
  if (recorded?.schemaVersion !== 1 || recorded.commit !== manifest.commit || !Array.isArray(recorded.observations)) {
    throw new Error('invalid release evidence observations');
  }
  const observations = recorded.observations.map((observation) => {
    const redacted = redactObservation(observation);
    if (!isDeepStrictEqual(observation, redacted)) throw new Error('release evidence observation is not redacted');
    return redacted;
  });
  const levels: readonly PackageLevel[] = options.levels ?? dashboard.levels.filter((level) => level.kind === 'level');
  if (!levels.some((level) => level.id === 'protected-b')) throw new Error('evidence dashboard has no Protected B profile');
  const ids = new Set<string>();
  for (const level of levels) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(level.id) || ids.has(level.id)) throw new Error(`invalid or duplicate package level: ${level.id}`);
    ids.add(level.id);
  }
  const loaded = existsSync(path.join(root, 'components')) ? loadComponents(path.join(root, 'components')) : { components: [], errors: [] };
  if (loaded.errors.length) throw new Error(loaded.errors.join('; '));
  const destination = path.resolve(options.out, `compliance-package-${release}`);
  mkdirSync(path.dirname(destination), { recursive: true });
  mkdirSync(destination);
  mkdirSync(path.join(destination, 'oscal/ssp'), { recursive: true });
  mkdirSync(path.join(destination, 'readable'));
  const statements = packageSources(root, destination, levels, options.resolved);
  const collectors = dashboard.collectors as readonly { id: string; window: string }[];
  const generatedAt = dashboard.generatedAt;
  for (const level of levels) {
    const rows = dashboard.rows.filter((row) => row.level === level.id);
    const input: SspInput = { level: { ...level, profile: `../${level.profile}` }, rows, components: loaded.components, generatedAt };
    const ssp = buildSsp(input);
    validateDocument(level.id, ssp, 'system-security-plan');
    writeFileSync(path.join(destination, 'oscal/ssp', `${level.id}.json`), stable(ssp));
    writeFileSync(path.join(destination, 'readable', `${level.id}-ssp.md`), renderSspMarkdown(input));
    const primary = level.id === 'protected-b';
    const suffix = primary ? '' : `-${level.id}`;
    const plan = `assessment-plan${suffix}.json`;
    const results = `assessment-results${suffix}.json`;
    const scope = { level: level.id, title: level.title, rows, generatedAt };
    const assessmentPlan = buildAssessmentPlan({ ...scope, collectors });
    const assessmentResults = buildAssessmentResults({ ...scope, plan,
      statements: statements.get(level.profile) ?? new Map(), observations: primary ? observations : [] });
    validateDocument(plan, assessmentPlan, 'assessment-plan');
    validateDocument(results, assessmentResults, 'assessment-results');
    writeFileSync(path.join(destination, 'oscal', plan), stable(assessmentPlan));
    writeFileSync(path.join(destination, 'oscal', results), stable(assessmentResults));
  }
  const milestones = new Map(loadPoam(path.join(root, 'poam')).map(item => [item.gap, item.milestones]));
  const gaps: readonly PoamGap[] = dashboard.gaps.length ? (dashboard.gaps as readonly PoamGap[]).map(gap => ({
    ...gap, milestones: gap.milestones ?? milestones.get(gap.id)
  })) : loadGaps(path.join(root, 'gaps.json')).map(gap => ({
    id: gap.id, title: gap.title ?? gap.id, remediation: gap.remediation, milestones: milestones.get(gap.id)
  }));
  const poam = buildPoam({ gaps, generatedAt });
  validateDocument('poam.json', poam, 'plan-of-action-and-milestones');
  writeFileSync(path.join(destination, 'oscal', 'poam.json'), stable(poam));
  writeFileSync(path.join(destination, 'readable', 'gaps.md'), renderGaps(gaps));
  const matrix = dashboard.matrix.map(({ control, component, weProvide, youDo }) => ({
    'Control': control, 'Component': component, 'We provide': weProvide, 'Your organization does': youDo
  }));
  writeFileSync(path.join(destination, 'readable', 'responsibility-matrix.csv'), `${toCsv(matrix, ['Control', 'Component', 'We provide', 'Your organization does'])}\r\n`);
  const crosswalk = loadJson(path.join(root, 'mappings/itsg33-to-itsp10033.json')) as {
    mappings: { source: string; target: string | null; relation: string }[]
  };
  const note = "Mapping note (ours, not the Cyber Centre's)";
  const mappings = crosswalk.mappings.map(({ source, target, relation }) => ({
    'ITSG-33 control': source, 'ITSP.10.033 control': target, [note]: relation
  }));
  writeFileSync(path.join(destination, 'readable', 'itsg33-crosswalk.csv'), `${toCsv(mappings, ['ITSG-33 control', 'ITSP.10.033 control', note])}\r\n`);
  copySupportingDocuments(root, destination);
  cpSync(bundle, path.join(destination, 'evidence/bundle'), { recursive: true, dereference: false });
  for (const sbom of options.sboms ?? []) {
    if (!lstatSync(sbom).isFile()) throw new Error(`SBOM must be a regular file: ${sbom}`);
    cpSync(sbom, path.join(destination, 'evidence', path.basename(sbom)), { force: false, errorOnExist: true });
  }
  const commit = typeof dashboard.commit === 'string' ? dashboard.commit : 'unknown'; writeFileSync(path.join(destination, 'README.md'), renderReadme(release, commit));
  const readmeHits = lintPage(readFileSync(path.join(destination, 'README.md'), 'utf8')); if (readmeHits.length) throw new Error(`README copy lint: ${readmeHits.map((hit) => hit.phrase).join(', ')}`);
  assertNoSecrets(destination);
  const sumsFile = path.join(destination, 'SHA256SUMS');
  writeFileSync(sumsFile, checksums(destination));
  return { directory: destination, verify: () => {
    if (!lstatSync(sumsFile).isFile() || readFileSync(sumsFile, 'utf8') !== checksums(destination)) {
      throw new Error('SHA256SUMS verification failed');
    }
  } };
}
