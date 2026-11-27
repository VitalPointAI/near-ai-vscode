import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ASSET_DIR, createDocumentationRenderer } from './documentation-render.mjs';

// The tools folder sits at workbench/tools both in a checkout and in the image build, so root is the repository root in both.
// It reads the repository docs from there and writes only inside workbench/ (lib/frontend/). Fail with a plain message if a layout change breaks that.
const root = new URL('../../', import.meta.url);
const output = new URL('../lib/frontend/', import.meta.url);
if (!existsSync(new URL('docs-site/content/index.md', root))) {
  throw new Error(`build-sterling-documentation: no docs-site/content under ${root.pathname}; run it from workbench/ in a checkout or the image build.`);
}

// Bundle the documentation site's guides, its linked repository references, and the software licence. The site already publishes the tracked
// design and security guides below. Sync routes follow the site's paths, and the Docker context names each source and image explicitly.
const guides = [
  ['docs-site/content/index.md', 'Overview', 'Welcome', 'index.md'],
  ['docs-site/content/using/getting-started.md', 'Using Sterling', 'Getting started', 'using/getting-started.md'],
  ['docs-site/content/using/roles/administration.md', 'Using Sterling', 'Administration and organization rules', 'using/roles/administration.md'],
  ['docs-site/content/using/roles/data-and-connections.md', 'Using Sterling', 'Data and connections', 'using/roles/data-and-connections.md'],
  ['docs-site/content/using/roles/software-projects.md', 'Using Sterling', 'Software projects', 'using/roles/software-projects.md'],
  ['docs-site/content/using/roles/staff-teams.md', 'Using Sterling', 'Staff teams', 'using/roles/staff-teams.md'],
  ['README.md', 'Using Sterling', 'Features and settings', 'using/features.synced.md'],
  ['docs-site/content/using/deployment-hardware.md', 'Using Sterling', 'Recommended hardware and configuration', 'using/deployment-hardware.md'],
  ['docs/staff-env-packs.md', 'Reference', 'Environment packs: terrain and weather for the COP map', 'using/reference/staff-env-packs.synced.md'],
  ['docs/hosting/capacity.md', 'Reference', 'Capacity', 'using/reference/hosting/capacity.synced.md'],
  ['relay/README.md', 'Reference', 'Hub and relay operator guide', 'using/reference/relay.synced.md'],
  ['deploy/runbooks/site-install.md', 'Reference', 'Site installation runbook', 'using/reference/site-install.synced.md'],
  ['docs-site/content/security/trust-model.md', 'Security', 'The trust model in plain words', 'security/trust-model.md'],
  ['SECURITY.md', 'Security', 'Security policy', 'security/policy.synced.md'],
  ['docs/security/controlled-goods-and-itar.md', 'Security', 'Controlled goods and ITAR', 'security/documents/controlled-goods-and-itar.synced.md'],
  ['docs/security/hosted-incident-playbooks.md', 'Security', 'Hosted deployment: incident playbooks', 'security/documents/hosted-incident-playbooks.synced.md'],
  ['docs/security/hosted-observers.md', 'Security', 'Hosted deployment: observers', 'security/documents/hosted-observers.synced.md'],
  ['docs/security/incident-response.md', 'Security', 'Incident response plan', 'security/documents/incident-response.synced.md'],
  ['docs-site/content/security/road-to-production.md', 'Security', 'Road to production and higher classification', 'security/road-to-production.md'],
  ['docs-site/content/architecture/overview.mdx', 'Architecture', 'Architecture overview', 'architecture/overview.md'],
  ['.planning/codebase/ARCHITECTURE.md', 'Architecture', 'Codebase architecture', 'architecture/codebase/ARCHITECTURE.synced.md'],
  ['.planning/codebase/INTEGRATIONS.md', 'Architecture', 'Codebase integrations', 'architecture/codebase/INTEGRATIONS.synced.md'],
  ['.planning/codebase/STRUCTURE.md', 'Architecture', 'Codebase structure', 'architecture/codebase/STRUCTURE.synced.md'],
  ['.planning/ROADMAP.md', 'Architecture', 'Product roadmap', 'architecture/roadmap.synced.md'],
  ['CONTRIBUTING.md', 'Developing', 'Contributing', 'developing/contributing.synced.md'],
  ['LICENSE', 'Developing', 'Software licence', 'developing/license.md'],
  ['docs/development-workflow.md', 'Developing', 'Development workflow', 'developing/development-workflow.synced.md'],
  ['docs/testing.md', 'Developing', 'Testing rules', 'developing/testing.synced.md'],
  ['docs-site/README.md', 'Developing', 'Documentation site guide', 'developing/docs-site.synced.md'],
  ['docs-site/content/releases/versions.md', 'Releases', 'Documentation versions', 'releases/versions.md'],
  ['CHANGELOG.md', 'Releases', 'Changelog', 'releases/changelog.synced.md'],
  ['docs-site/content/architecture/components/build-and-test.md', 'Component catalogue', 'Build and test only', 'architecture/components/build-and-test.md'],
  ['docs-site/content/architecture/components/compliance-tooling.md', 'Component catalogue', 'Compliance tooling', 'architecture/components/compliance-tooling.md'],
  ['docs-site/content/architecture/components/documentation-site.md', 'Component catalogue', 'Documentation site', 'architecture/components/documentation-site.md'],
  ['docs-site/content/architecture/components/identity.md', 'Component catalogue', 'Identity and sign-in', 'architecture/components/identity.md'],
  ['docs-site/content/architecture/components/index.md', 'Component catalogue', 'Component catalogue', 'architecture/components/index.md'],
  ['docs-site/content/architecture/components/release-and-supply-chain.md', 'Component catalogue', 'Release and supply chain', 'architecture/components/release-and-supply-chain.md'],
  ['docs-site/content/architecture/components/secrets-and-keys.md', 'Component catalogue', 'Secrets and keys', 'architecture/components/secrets-and-keys.md'],
  ['docs-site/content/architecture/components/site-platform.md', 'Component catalogue', 'Site platform: Kubernetes, registry, ingress and certificates', 'architecture/components/site-platform.md'],
  ['docs-site/content/architecture/components/storage-logging-monitoring.md', 'Component catalogue', 'Storage, logging and monitoring', 'architecture/components/storage-logging-monitoring.md'],
  ['docs-site/content/architecture/components/sync-and-relay.md', 'Component catalogue', 'Sync hub and relay', 'architecture/components/sync-and-relay.md'],
  ['docs-site/content/architecture/components/workbench.md', 'Component catalogue', 'Workbench, sessions and extension', 'architecture/components/workbench.md'],
  ['.planning/research/canadian-official-languages.md', 'Design documents', 'Canadian English and French in SovAI', 'architecture/design/canadian-official-languages.synced.md'],
  ['.planning/research/data-platform/00-DESIGN.md', 'Design documents', 'Data platform: combined design', 'architecture/design/data-platform/00-DESIGN.synced.md'],
  ['.planning/research/data-platform/01-connectors-extraction-etl.md', 'Design documents', 'Data platform research 01: discovery, connectors, extraction and ETL', 'architecture/design/data-platform/01-connectors-extraction-etl.synced.md'],
  ['.planning/research/data-platform/02-classification-tagging-data-centric-security.md', 'Design documents', 'Automatic classification, metadata tagging, privacy assessment and data-centric access control', 'architecture/design/data-platform/02-classification-tagging-data-centric-security.synced.md'],
  ['.planning/research/data-platform/03-context-graph-analytics-knowledge-layer.md', 'Design documents', '03: Context graph, search, analytics and reporting, and the knowledge-base interaction layer', 'architecture/design/data-platform/03-context-graph-analytics-knowledge-layer.synced.md'],
  ['.planning/research/data-platform/04-model-factory-and-opportunity-agent.md', 'Design documents', 'Model Factory and Opportunity Agent', 'architecture/design/data-platform/04-model-factory-and-opportunity-agent.synced.md'],
  ['.planning/research/data-platform/05-defence-digital-twin.md', 'Design documents', 'DND/CAF digital twin foundation', 'architecture/design/data-platform/05-defence-digital-twin.synced.md'],
  ['.planning/research/guided-onboarding/DESIGN.md', 'Design documents', 'Guided onboarding and local models', 'architecture/design/guided-onboarding/DESIGN.synced.md'],
  ['.planning/research/model-provenance/DESIGN.md', 'Design documents', 'Model provenance, use tiers and Western defaults', 'architecture/design/model-provenance/DESIGN.synced.md'],
  ['.planning/research/multiuser-hosting/DESIGN.md', 'Design documents', 'On-premises hosting design', 'architecture/design/multiuser-hosting/DESIGN.synced.md'],
  ['.planning/research/multiuser-sync/DESIGN.md', 'Design documents', 'Staff workspaces and signed sync', 'architecture/design/multiuser-sync/DESIGN.synced.md'],
  ['.planning/research/platform-direction/README.md', 'Design documents', 'Platform direction research (2026-11-15 and 2026-11-16)', 'architecture/design/platform-direction/README.synced.md'],
  ['.planning/research/platform-direction/agent-authz-prior-art.md', 'Design documents', 'Prior art for the agent authorization architecture', 'architecture/design/platform-direction/agent-authz-prior-art.synced.md'],
  ['.planning/research/platform-direction/calimero-evaluation.md', 'Design documents', 'Calimero Network as a privacy layer for identity and governance: evaluation', 'architecture/design/platform-direction/calimero-evaluation.synced.md'],
  ['.planning/research/platform-direction/hermes-analysis.md', 'Design documents', 'Hermes Agent compared with NEAR AI agent teams: what to adopt, and where', 'architecture/design/platform-direction/hermes-analysis.synced.md'],
  ['.planning/research/platform-direction/identity-research.md', 'Design documents', 'Trust and governance layer: identity, credentials, clearance and NEAR confidentiality', 'architecture/design/platform-direction/identity-research.synced.md'],
  ['.planning/research/platform-direction/ironclaw-analysis.md', 'Design documents', 'IronClaw and our agent teams: what to adopt, what to leave, and when', 'architecture/design/platform-direction/ironclaw-analysis.synced.md'],
  ['.planning/research/platform-direction/openshell-analysis.md', 'Design documents', 'NVIDIA OpenShell: what to take for the NEAR AI agent trust layer', 'architecture/design/platform-direction/openshell-analysis.synced.md'],
  ['.planning/research/platform-direction/openshell-spike.md', 'Design documents', 'OpenShell spike: an execution sandbox for the agent shell', 'architecture/design/platform-direction/openshell-spike.synced.md'],
  ['.planning/research/portfolio-and-assignment/DESIGN.md', 'Design documents', 'Portfolio and assignments', 'architecture/design/portfolio-and-assignment/DESIGN.synced.md'],
  ['.planning/research/staff-teams/00-bastion-staff-teams.md', 'Design documents', 'Bastion staff teams: what exists, and what the extension can reuse', 'architecture/design/staff-teams/00-bastion-staff-teams.synced.md'],
  ['.planning/research/staff-teams/01-agent-exchange.md', 'Design documents', 'Research note 01: the Agent Exchange from ai-workbench, mapped onto the extension', 'architecture/design/staff-teams/01-agent-exchange.synced.md'],
  ['.planning/research/staff-teams/02-J2-intelligence.md', 'Design documents', 'Research note 02: the J2 (joint intelligence) staff team', 'architecture/design/staff-teams/02-J2-intelligence.synced.md'],
  ['.planning/research/staff-teams/03-J3-operations-J4-logistics.md', 'Design documents', 'J3 Operations and J4 Logistics: doctrine research for agentic staff teams', 'architecture/design/staff-teams/03-J3-operations-J4-logistics.synced.md'],
  ['.planning/research/staff-teams/05-J5-plans.md', 'Design documents', 'J5 plans and policy agent team: doctrine research (US, Canadian, NATO)', 'architecture/design/staff-teams/05-J5-plans.synced.md'],
  ['.planning/research/staff-teams/06-full-joint-staff.md', 'Design documents', '06: The full joint staff as a team of teams', 'architecture/design/staff-teams/06-full-joint-staff.synced.md'],
  ['.planning/research/staff-teams/07-J1-personnel-J8-resources.md', 'Design documents', 'J1 Personnel and J8 Resources: doctrine research for agentic staff teams', 'architecture/design/staff-teams/07-J1-personnel-J8-resources.synced.md'],
  ['.planning/research/staff-teams/09-J7-J9-command-special-staff.md', 'Design documents', 'Research note 09: J7, J9, and the command group with the personal and special staff', 'architecture/design/staff-teams/09-J7-J9-command-special-staff.synced.md'],
  ['.planning/research/staff-teams/10-STAFF-TEAMS-DESIGN.md', 'Design documents', 'Staff teams design', 'architecture/design/staff-teams/10-STAFF-TEAMS-DESIGN.synced.md'],
  ['.planning/research/staff-teams/13-staff-personnel-resources-and-special-advice.md', 'Design documents', 'Personnel, resources and special advice', 'architecture/design/staff-teams/13-staff-personnel-resources-and-special-advice.synced.md'],
  ['.planning/research/staff-teams/TERMS-REGISTER.md', 'Design documents', 'Doctrine terms register', 'architecture/design/staff-teams/TERMS-REGISTER.synced.md'],
];

// Each page is HTML made here (documentation-render.mjs): no Markdown, MDX or diagram source reaches the browser.
const renderer = createDocumentationRenderer({ root: fileURLToPath(root) });
const pages = await Promise.all(guides.map(async ([source, category, title, route]) => {
  const { html, text } = renderer.render(source, await readFile(new URL(source, root), 'utf8'), title);
  return { source, route, category, title, html, text };
}));
await rm(new URL(`${ASSET_DIR}/`, output), { recursive: true, force: true });
await mkdir(new URL(`${ASSET_DIR}/`, output), { recursive: true });
for (const [name, file] of renderer.assets) await copyFile(file, new URL(`${ASSET_DIR}/${name}`, output));
await writeFile(new URL('sterling-documentation.json', output), JSON.stringify(pages));
