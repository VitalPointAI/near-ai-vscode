import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { writeZip } from '../agent/zip';
import type { SaaReleaseEvidence } from './saaReleaseEvidence';

const STATES = ['met', 'partly-met', 'not-met', 'stale', 'your-organizations-responsibility', 'not-applicable'] as const;
type ProductState = typeof STATES[number];
type CsvRow = readonly (string | number | undefined)[];
type Table = { title: string; file: string; rows: readonly CsvRow[] };
type ArchiveEntry = [name: string, bytes: Buffer];

interface RuleResult {
  rule: string;
  passed: boolean;
  reason: string;
  collectedAt: string;
  commit?: string;
  runUrl?: string;
  window?: string;
}

interface Component {
  component: string;
  responsibility: string;
  state: ProductState;
  statement?: string;
  evidence: RuleResult[];
}

interface Control {
  level: string;
  control: string;
  label: string;
  title: string;
  reason: string;
  state: ProductState;
  gap?: string;
  textFile?: string;
  components: Component[];
}

interface Gap {
  id: string;
  title: string;
  ownerRole: string;
  state: string;
  controls: string[];
  remediation: string;
  phase?: string;
}

interface Profile {
  id: string;
  title: string;
  kind: string;
  claim: boolean;
}

interface Dashboard {
  generatedAt: string;
  levels: Profile[];
  rows: Control[];
  gaps: Gap[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const optionalText = (value: unknown): boolean => value === undefined || typeof value === 'string';
const isState = (value: unknown): value is ProductState => STATES.some((state) => state === value);

function isRuleResult(value: unknown): value is RuleResult {
  return isObject(value) && isText(value.rule) && typeof value.passed === 'boolean' &&
    isText(value.reason) && isText(value.collectedAt) && Number.isFinite(Date.parse(value.collectedAt)) &&
    optionalText(value.commit) && optionalText(value.runUrl) && optionalText(value.window);
}

function isComponent(value: unknown): value is Component {
  return isObject(value) && isText(value.component) && isText(value.responsibility) && isState(value.state) &&
    optionalText(value.statement) && Array.isArray(value.evidence) && value.evidence.every(isRuleResult);
}

function isControl(value: unknown): value is Control {
  return isObject(value) && isText(value.level) && isText(value.control) && isText(value.label) &&
    isText(value.title) && isText(value.reason) && isState(value.state) && optionalText(value.gap) &&
    optionalText(value.textFile) && Array.isArray(value.components) && value.components.every(isComponent);
}

function isGap(value: unknown): value is Gap {
  return isObject(value) && isText(value.id) && isText(value.title) && isText(value.ownerRole) &&
    isText(value.state) && isText(value.remediation) && optionalText(value.phase) &&
    Array.isArray(value.controls) && value.controls.every(isText);
}

function isProfile(value: unknown): value is Profile {
  return isObject(value) && isText(value.id) && isText(value.title) &&
    (value.kind === 'level' || value.kind === 'overlay') && typeof value.claim === 'boolean';
}

function parseDashboard(value: unknown, commit: string): Dashboard {
  if (!isObject(value) || value.schemaVersion !== 1 || value.commit !== commit ||
      !isText(value.generatedAt) || !Number.isFinite(Date.parse(value.generatedAt)) ||
      !Array.isArray(value.levels) || !value.levels.length || !value.levels.every(isProfile) ||
      !Array.isArray(value.rows) || !value.rows.length || !value.rows.every(isControl) ||
      !Array.isArray(value.gaps) || !value.gaps.every(isGap)) {
    throw new Error('The release dashboard has missing or malformed control evidence.');
  }
  const levels = new Set(value.levels.map((level) => level.id));
  const controls = new Set(value.rows.map((row) => JSON.stringify([row.level, row.control])));
  const gaps = new Set(value.gaps.map((gap) => gap.id));
  if (levels.size !== value.levels.length || controls.size !== value.rows.length ||
      gaps.size !== value.gaps.length ||
      value.rows.some((row) => !levels.has(row.level) || (row.gap && !gaps.has(row.gap)))) {
    throw new Error('The release dashboard references unknown or duplicate controls, profiles or gaps.');
  }
  return { generatedAt: value.generatedAt, levels: value.levels, rows: value.rows, gaps: value.gaps };
}

/** Use plain ZIP member names safe to open on the supported platforms. */
function safePath(name: string): boolean {
  return name.length <= 240 && name.split('/').every((part) =>
    /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(part) && !part.endsWith('.') &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

async function readForms(root: string): Promise<ArchiveEntry[]> {
  if (!(await lstat(root)).isDirectory()) throw new Error('The bundled SA&A forms directory is missing.');
  const entries: ArchiveEntry[] = [];
  const maxBytes = 8 * 1024 * 1024;
  let remaining = maxBytes;
  async function walk(directory: string, prefix: string): Promise<void> {
    const contents = await readdir(directory, { withFileTypes: true });
    for (const entry of contents.sort((left, right) => left.name.localeCompare(right.name))) {
      const name = prefix + entry.name;
      if (/^official\/[^/]+\.docx$/.test(name)) continue;
      if (!safePath(name)) throw new Error(`Unexpected file name in the bundled SA&A forms: ${name}.`);
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(file, `${name}/`);
        continue;
      }
      if (!entry.isFile()) throw new Error(`The bundled SA&A form ${name} must be a regular file.`);
      const stats = await lstat(file);
      if (!stats.isFile() || stats.size > remaining || entries.length >= 128) {
        throw new Error('The bundled SA&A forms are too large or contain an unexpected file.');
      }
      const bytes = await readFile(file);
      if (bytes.length !== stats.size) throw new Error('A bundled SA&A form changed while it was being read.');
      remaining -= bytes.length;
      entries.push([`forms/${name}`, bytes]);
    }
  }
  await walk(root, '');
  if (!entries.some(([name]) => /^forms\/editable\/.+\.docx$/.test(name))) {
    throw new Error('The bundled editable SA&A forms are missing.');
  }
  return entries;
}

const dashboardFile = 'release-package/evidence/bundle/dashboard/dashboard.json';

function nextAction(control: Control, profile: Profile): string {
  if (!profile.claim) return 'Confirm the separately scoped reference with the sponsor before assessment.';
  if (control.state === 'your-organizations-responsibility') return 'Identify the responsible deployment or inherited control owner and obtain evidence.';
  if (control.state === 'met') return 'Confirm deployment applicability and independently assess effectiveness.';
  if (control.state === 'not-applicable') return 'Confirm the published exclusion against the deployment scope.';
  return 'Confirm applicability and owner, then obtain implementation and assessment evidence.';
}

function traceabilityTables(dashboard: Dashboard, release: SaaReleaseEvidence): Table[] {
  const coverage: CsvRow[] = [['Profile ID', 'Profile name', 'Product rows', ...STATES, 'Deployment assessment']];
  const controls: CsvRow[] = [[
    'Profile ID', 'Profile kind', 'OSCAL control ID', 'Control label', 'Control title', 'Product state', 'Product reason',
    'Product snapshot (UTC)', 'Product commit', 'Mapped components and responsibilities', 'Product rule IDs', 'Product gap ID',
    'Product gap owner role', 'Next assessment action', 'Official source in package', 'Deployment applicability',
    'Tailoring decision and rationale', 'Deployment owner', 'Assessment method', 'Deployment evidence ID', 'Assessor result',
    'Assessor and date', 'Closure or approval reference'
  ]];
  const components: CsvRow[] = [[
    'Profile ID', 'OSCAL control ID', 'Component', 'Product responsibility', 'Product statement', 'Product component state',
    'Evidence rule ID', 'Product rule result', 'Result reason', 'Collected (UTC)', 'Evidence commit', 'Original run URL',
    'Validity window', 'Evidence source in package'
  ]];
  const actions: CsvRow[] = [[
    'Product gap ID', 'Title', 'Published state', 'OSCAL control IDs', 'Product owner role', 'Published remediation',
    'Published phase', 'Deployment applicability', 'Assigned owner', 'Priority', 'Target date', 'Compensating measure',
    'Closure evidence', 'Assessor disposition'
  ]];
  const index: CsvRow[] = [
    ['Evidence ID', 'Artifact', 'Source or path in evidence folder', 'Product commit', 'Use and limitations'],
    ['EV-REL-01', 'Published GitHub release', release.sourceUrl, release.commit, 'Version and release asset provenance.'],
    ['EV-REL-02', 'Original assessor archive', release.fileName, release.commit, 'Published archive and its SHA-256.'],
    ['EV-REL-03', 'Release dashboard', dashboardFile, release.commit, 'Source of the product traceability rows.'],
    ['EV-REL-04', 'Original package checksums', 'release-package/SHA256SUMS', release.commit, 'Integrity of the extracted release files.'],
    ['EV-REL-05', 'OSCAL models', 'release-package/oscal/', release.commit, 'Release models for tailoring and assessment.'],
    ['EV-REL-06', 'Readable release records', 'release-package/readable/', release.commit, 'Release security plans and responsibilities.'],
    ['EV-DEP-___', 'Deployment evidence reference', '', '', 'Record permitted IDs and repository links after assessment.']
  ];
  const gapById = new Map(dashboard.gaps.map((gap) => [gap.id, gap]));
  for (const profile of dashboard.levels) {
    const rows = dashboard.rows.filter((row) => row.level === profile.id);
    const counts = new Map<ProductState, number>();
    for (const row of rows) {
      counts.set(row.state, (counts.get(row.state) ?? 0) + 1);
      const rules = new Set(row.components.flatMap((component) => component.evidence.map((result) => result.rule)));
      const textFile = row.textFile ? `evidence/bundle/dashboard/${row.textFile}` : '';
      const official = textFile && safePath(textFile) && release.files.has(textFile) ? `release-package/${textFile}` : '';
      controls.push([
        profile.id, profile.kind, row.control, row.label, row.title, row.state, row.reason, dashboard.generatedAt, release.commit,
        row.components.map(({ component, responsibility }) => `${component} (${responsibility})`).join('; '), [...rules].join('; '),
        row.gap, row.gap ? gapById.get(row.gap)?.ownerRole : '', nextAction(row, profile), official,
        '', '', '', '', '', profile.claim ? 'Not assessed' : 'Reference only', '', ''
      ]);
      for (const component of row.components) {
        const base = [profile.id, row.control, component.component, component.responsibility, component.statement, component.state];
        if (component.evidence.length === 0) {
          components.push([...base, '', '', '', '', '', '', '', dashboardFile]);
        }
        for (const item of component.evidence) {
          components.push([
            ...base, item.rule, item.passed ? 'Passed' : 'Failed or unavailable', item.reason, item.collectedAt,
            item.commit, item.runUrl, item.window, dashboardFile
          ]);
        }
      }
    }
    coverage.push([profile.id, profile.title, rows.length, ...STATES.map((state) => counts.get(state) ?? 0),
      profile.claim ? 'Not assessed' : 'Reference only']);
  }
  for (const gap of dashboard.gaps) {
    actions.push([gap.id, gap.title, gap.state, gap.controls.join('; '), gap.ownerRole, gap.remediation, gap.phase,
      '', '', '', '', '', '', '']);
  }
  return [
    { title: 'Coverage', file: 'coverage-summary.csv', rows: coverage },
    { title: 'Control traceability', file: 'control-traceability.csv', rows: controls },
    { title: 'Component evidence', file: 'component-evidence.csv', rows: components },
    { title: 'Evidence index', file: 'evidence-index.csv', rows: index },
    { title: 'Product gaps', file: 'gap-and-action-register.csv', rows: actions }
  ];
}

function csvCell(value: CsvRow[number]): string {
  const text = String(value ?? '');
  // Quotes protect record boundaries. A leading apostrophe also keeps formula-like text inert.
  const prefix = typeof value === 'string' && /^(?:[\t\r\n]|[\s\uFEFF]*[=+\-@])/.test(text) ? "'" : '';
  return `"${prefix}${text.replaceAll('"', '""')}"`;
}

const xml = (value: string): string => value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const spreadsheet = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const officeRelationships = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const packageRelationships = 'http://schemas.openxmlformats.org/package/2006/relationships';

function columnName(index: number): string {
  const suffix = String.fromCharCode(65 + index % 26);
  return index < 26 ? suffix : columnName(Math.floor(index / 26) - 1) + suffix;
}

function worksheet(rows: readonly CsvRow[]): string {
  const data = rows.map((row, offset) => {
    const number = offset + 1;
    const cells = row.map((value, index) => {
      const coordinate = `${columnName(index)}${number}`;
      if (typeof value === 'number') return `<c r="${coordinate}"><v>${value}</v></c>`;
      if (!value) return '';
      return `<c r="${coordinate}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
    }).join('');
    return `<row r="${number}">${cells}</row>`;
  }).join('');
  const lastColumn = rows[0].length - 1;
  return `<worksheet xmlns="${spreadsheet}"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="${lastColumn + 1}" width="26" customWidth="1"/></cols><sheetData>${data}</sheetData><autoFilter ref="A1:${columnName(lastColumn)}${rows.length}"/></worksheet>`;
}

function workbook(tables: Table[]): Buffer {
  const sheets = tables.map((table, index) => ({ table, id: index + 1 }));
  const entries: ArchiveEntry[] = [];
  const add = (name: string, value: string) => entries.push([name, Buffer.from(value)]);
  const types = 'application/vnd.openxmlformats-officedocument.spreadsheetml';
  add('[Content_Types].xml', `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${types}.sheet.main+xml"/>${sheets.map(({ id }) => `<Override PartName="/xl/worksheets/sheet${id}.xml" ContentType="${types}.worksheet+xml"/>`).join('')}</Types>`);
  add('_rels/.rels', `<Relationships xmlns="${packageRelationships}"><Relationship Id="rId1" Type="${officeRelationships}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  add('xl/workbook.xml', `<workbook xmlns="${spreadsheet}" xmlns:r="${officeRelationships}"><bookViews><workbookView/></bookViews><sheets>${sheets.map(({ id, table }) => `<sheet name="${xml(table.title)}" sheetId="${id}" r:id="rId${id}"/>`).join('')}</sheets></workbook>`);
  add('xl/_rels/workbook.xml.rels', `<Relationships xmlns="${packageRelationships}">${sheets.map(({ id }) => `<Relationship Id="rId${id}" Type="${officeRelationships}/worksheet" Target="worksheets/sheet${id}.xml"/>`).join('')}</Relationships>`);
  for (const { id, table } of sheets) add(`xl/worksheets/sheet${id}.xml`, worksheet(table.rows));
  return writeZip(entries);
}

/** Combine a verified public release with blank forms. All generated content stays in this archive. */
export async function buildSaaPackage(evidence: SaaReleaseEvidence, formsDir: string, privacyForms: ReadonlyMap<string, Buffer>): Promise<Buffer> {
  const dashboard = parseDashboard(evidence.dashboard, evidence.commit);
  const tables = traceabilityTables(dashboard, evidence);
  const entries: ArchiveEntry[] = await readForms(formsDir);
  const append = (name: string, value: string) => entries.push([name, Buffer.from(value)]);
  const addSource = (name: string, value: Buffer) => {
    if (!safePath(name)) throw new Error('The release package contains an unsafe file name.');
    entries.push([name, value]);
  };
  for (const [name, bytes] of privacyForms) addSource(`forms/official/${name}`, bytes);
  append('README.md', `# Security Assessment and Authorization package

Draft for departmental review

- Product release: v${evidence.version}
- Evidence commit: ${evidence.commit}
- Product evidence snapshot (UTC): ${dashboard.generatedAt}
- Published source: ${evidence.sourceUrl}

Start with the editable submission and routing form in the [forms index](forms/README.md). The package includes categorization, tailoring, security design and operating plans, the assessment plan and report, remediation records, and authorization and residual risk worksheets. The index also identifies the official blank Treasury Board forms and the department's approval responsibilities.

Open the [control and evidence workbook](evidence/SA-and-A-control-and-evidence-workbook.xlsx) for the release's ${dashboard.rows.length} profile and overlay rows. The [evidence notes](evidence/README.md) describe how to read the product snapshot and trace it to the original assessor archive.

These documents are drafts. The sponsor supplies the deployment, departmental templates, evidence location and approval route. The assessor records deployment findings, and the authorizing official makes and signs the decision. Use the approved departmental repository for sensitive material.
`);
  append('evidence/README.md', `# Product evidence and deployment assessment

This export uses the product evidence published for NEAR AI for VS Code v${evidence.version} at ${evidence.commit}. The source archive was checked against its GitHub release asset SHA-256 and the release package's internal checksums.

The actual deployment and its control conclusions remain open. States and results in the workbook describe the product evidence as published. They do not establish authorization, control implementation at a particular site, or acceptance of residual risk. Profiles marked reference only require separate scope and direction.

- The [workbook](SA-and-A-control-and-evidence-workbook.xlsx) and CSVs contain editable traceability, component evidence, the evidence index and product gaps.
- The [published assessor archive](${evidence.fileName}) and its [SHA-256](${evidence.fileName}.sha256) accompany the unchanged [extracted release records](release-package/).
- Evidence references for the deployment should identify the assessed component, build and configuration, assessment objective, method, collection date, approved location and reviewer.
`);
  addSource(`evidence/${evidence.fileName}`, evidence.archive);
  append(`evidence/${evidence.fileName}.sha256`, `${evidence.sha256}  ${evidence.fileName}\n`);
  for (const [name, bytes] of evidence.files) addSource(`evidence/release-package/${name}`, bytes);
  for (const { file, rows } of tables) {
    append(`evidence/${file}`, `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`);
  }
  entries.push(['evidence/SA-and-A-control-and-evidence-workbook.xlsx', workbook(tables)]);
  entries.sort(([left], [right]) => left.localeCompare(right));
  const manifest = entries.map(([name, bytes]) => `${createHash('sha256').update(bytes).digest('hex')}  ${name}\n`).join('');
  append('SHA256SUMS', manifest);
  return writeZip(entries);
}
