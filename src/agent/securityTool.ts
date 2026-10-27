import { CI_WORKFLOW, ScanReport, scanSummary } from '../security/scan';
import type { AgentTool } from './tools';

/** What the host provides for the agent's SecurityScan tool. */
export interface SecurityAccess { consented(): boolean; scan(): Promise<ScanReport | undefined> }

export function securityTool(access: SecurityAccess): AgentTool<{ workflow: boolean }> {
  return {
    name: 'SecurityScan',
    description: 'Check the project\'s dependencies (from its lockfiles) and runtimes for known vulnerabilities on OSV.dev and endoflife.date, and write the SBOM (sbom.cdx.json). Run it after adding, upgrading, or removing dependencies and when creating a project. With workflow: true it returns a GitHub Actions workflow that scans on every push, pull request, and weekly, to save with Write as .github/workflows/dependency-scan.yml.',
    parameters: { type: 'object', properties: { workflow: { type: 'boolean', description: 'Return the CI workflow instead of scanning.' } }, additionalProperties: false },
    // Sends only package names and versions, and only after the user agreed for this project.
    capability: 'read',
    parse: (raw) => ({ workflow: raw.workflow === true }),
    title: (input) => (input.workflow ? 'Get dependency scan workflow' : 'Scan dependencies for vulnerabilities'),
    async run(input) {
      if (input.workflow) return `Save this as .github/workflows/dependency-scan.yml:\n\n${CI_WORKFLOW}`;
      if (!access.consented()) return 'Vulnerability checks are not enabled for this project. Ask the user to run "NEAR AI: Scan Dependencies for Vulnerabilities" once to allow them. Until then, say plainly that dependencies were not checked.';
      const report = await access.scan();
      if (!report) return 'The dependency check could not run; see the NEAR AI Security output. Say that dependencies were not checked.';
      return scanSummary(report);
    }
  };
}
