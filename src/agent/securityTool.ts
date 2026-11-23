import { CI_WORKFLOW, SBOM_FILE, ScanReport, scanSummary } from '../security/scan';
import { declareManifest, INTERACTIVE_ONLY } from './tools';
import type { AgentTool } from './tools';

/** The hosts the scan contacts: the OSV API for dependencies and endoflife.date for runtimes (src/security/osv.ts, runtimes.ts). */
const SCAN_HOSTS = ['api.osv.dev', 'endoflife.date'];

/** What the host provides for the agent's SecurityScan tool. */
export interface SecurityAccess { consented(): boolean; scan(): Promise<ScanReport | undefined> }

export function securityTool(access: SecurityAccess): AgentTool<{ workflow: boolean }> {
  return {
    name: 'SecurityScan',
    description: 'Check the project\'s dependencies (from its lockfiles) and runtimes for known vulnerabilities on OSV.dev and endoflife.date, and write the SBOM (sbom.cdx.json). Run it after adding, upgrading, or removing dependencies and when creating a project. With workflow: true it returns a GitHub Actions workflow that scans on every push, pull request, and weekly, to save with Write as .github/workflows/dependency-scan.yml.',
    parameters: { type: 'object', properties: { workflow: { type: 'boolean', description: 'Return the CI workflow instead of scanning.' } }, additionalProperties: false },
    // Sends only package names and versions, and only after the user agreed for this project.
    capability: 'read',
    // It reads the project's manifests and lockfiles, writes the SBOM, and sends package names and versions to the two services it queries (the only
    // hosts src/security contacts: OSV's API and endoflife.date). The shorthand stays `read`, gated by the project's consent (a named exception).
    manifest: declareManifest({
      tool: 'SecurityScan',
      effects: [
        { verb: 'read', paths: ['**/package.json', '**/*lock*'] },
        { verb: 'workspaceWrite', paths: [SBOM_FILE] },
        { verb: 'network', hosts: SCAN_HOSTS }
      ],
      hosts: SCAN_HOSTS,
      contexts: INTERACTIVE_ONLY
    }),
    parse: (raw) => ({ workflow: raw.workflow === true }),
    title: (input) => (input.workflow ? 'Get dependency scan workflow' : 'Scan dependencies for vulnerabilities'),
    async run(input) {
      if (input.workflow) return `Save this as .github/workflows/dependency-scan.yml:\n\n${CI_WORKFLOW}`;
      if (!access.consented()) return 'Vulnerability checks are not enabled for this project. Ask the user to run "SovAI: Scan Dependencies for Vulnerabilities" once to allow them. Until then, say plainly that dependencies were not checked.';
      const report = await access.scan();
      if (!report) return 'The dependency check could not run; see the NEAR AI Security output. Say that dependencies were not checked.';
      return scanSummary(report);
    }
  };
}
