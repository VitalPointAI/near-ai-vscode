# Compliance package

This package is the one machine-readable source behind the Accreditation pages of the documentation site and the release package for assessors. It holds the control catalogues and profiles in NIST OSCAL JSON, what each part of the product does per control, the evidence rules that tie each statement to a test or a check, and the status engine that turns evidence into a state.

## What it is not

It is not an authorization, and it makes no compliance claim. The states it computes say only what evidence shows today. Your organization decides whether a system that uses this product may operate, and your organization's authorizing official signs that decision. Controls that only your organization can carry out (people, premises, the authorization itself) are shown as your organization's responsibility and are never shown as Met.

## How a state is computed

- Every state comes from one function, `computeStatus` in `src/status.ts`. It reads statements, responsibility values, evidence rule results, the commit being judged and the clock. No source file carries a state: a test walks every source file and refuses any key or prop named `status`, `state` or `met` (`test/noStatus.test.ts`).
- The six states are Met, Partly met, Not met, Stale, Not applicable (always with a reason) and Your organization's responsibility. Stale counts as not met.
- Met needs a statement, an evidence rule for every statement, a result for every rule, every result passed, and every result fresh: test evidence from the commit being judged, audits within 24 hours, repository settings within 7 days, harness scans within 30 days, documents and signed attestations within 365 days.

## Layout

- `src/`: the shared model (`model.ts`), evidence rules (`rules.ts`), the status engine (`status.ts`), the dashboard builder (`dashboard.ts`), validators and the safe JSON loader (`validate.ts`), and collector types (`collectors/`).
- `schemas/`: the vendored OSCAL 1.2.1 complete schema with its source address and SHA-256 in `SOURCES.json`, and our own strict schemas such as `evidence-rule.schema.json`.
- Source folders, added by later work: `catalogs/`, `profiles/`, `mappings/`, `components/`, `responsibility/`, `evidence-rules/`, `tailoring/`, `poam/`, `attestations/`, `import-reports/`, and the files `sources.json`, `gaps.json` and `levels.json`.
- `test/`: tests and fixtures. Fixture text is written for the tests and never copies published control text.

Every document this package generates is stamped OSCAL 1.2.1. Props it adds use the namespace `urn:near-ai-vscode:compliance`.

## Install, lint and test

The package has its own lockfile and no runtime dependencies beyond Node built-ins. It runs on Node 24 or later with Node's built-in type stripping; there is no build step.

```sh
npm --prefix compliance ci --ignore-scripts
npm --prefix compliance run lint
node scripts/run-tests.mjs compliance/test/*.test.ts
```

Run the tests through the repository's runner as shown (from the repository root), or `npm --prefix compliance test`, which calls the same runner.

## Generated files

Everything generated (resolved profiles, the evidence bundle, the dashboard JSON and the release package) goes under `compliance/out/`, which git ignores. Nothing generated is committed, so nothing on `main` can drift from what CI computed.

Use a fresh or empty output directory for each local `bundle --out` run. Existing files are kept intact.

Neither this package nor `docs/security/` ships in the extension: both are listed in `.vscodeignore`, and the release content check refuses a package that holds either.
# Compliance evidence data

## Writing statements and evidence rules

Add a statement only for behavior the product has today. State what the code does in plain words; do not describe it as compliant, certified, or accredited. Give each implemented requirement exactly one responsibility. A limitation must match a row in SECURITY.md exactly.

Every statement needs an evidence rule. A test rule names the source test file and its exact literal test name, never a comment or a broad file-level result. Renaming or removing that literal name makes the PR summary show the evidence loss. Collector rules name only their documented collector and subject.

Component and rule source files never carry a state. The generated dashboard computes states from current evidence, responsibility, tailoring, and the unsettled or official-decision boundaries.

## CI jobs

The `test`, `relay`, and `hub` jobs write per-test reports. The `compliance` job validates the compliance package, rebuilds those reports into a redacted evidence bundle, and shows control-state changes in the pull-request job summary. On `main` it secret-scans and stores the bundle for 30 days. `relay-image-scan` separately records the relay image SBOM and known fixed vulnerabilities. These reporting jobs do not turn a finding into a failed required check; a tool that cannot run still fails its step.

When the installer build succeeds, the evidence job reads its SBOM from the current run's commit-named VSIX artifact. The evidence bundle retains the exact installer SBOM and records its component count and digest. The assessor package carries that same file under `evidence/bundle/`. Its observation describes the software shipped in that installer. Record the actual installed configuration and its approval when assessing a deployment.

The pull-request summary is report-only by default. After the owner has seen stable results and made `compliance` a required check, set its `FAIL_ON_DROP` environment value to `--fail-on-drop` and remove any masking behavior from that summary step to make an unexplained evidence drop blocking.

For CM-03, use the configured protections on main and the agent review attached to the pull-request head that produced the assessed commit. Deployment environment settings show whether a reviewer is required. The protected environment owner's approval belongs to its particular run. The read-only settings token cannot confirm which actors may bypass release-tag rules. These approval and bypass checks remain open until their records are verified.

## Release package

Releases with compliance sources attach `compliance-package-<version>.tar.gz` and its checksum beside the VSIX. An unmerged hotfix based on an older release that predates the compliance sources can still publish an attested VSIX. The release workflow validates the package's OSCAL documents, imports its assessor documents into a throwaway Compliance Trestle workspace, and creates GitHub artifact attestations. Verify the checksum with `sha256sum --check <package>.sha256`. Verify provenance with `gh attestation verify <file> --repo VitalPointAI/near-ai-vscode`.

A main release can include settings and review observations from a verified daily evidence run for the same commit. The package retains the CI test evidence, the installer inventory, and the collection-run links. The release summary records when it uses the CI bundle alone. The package flags expired settings evidence as stale.

## Owner steps

These settings and outside contacts cannot be changed by this code. They may be completed later; the Evidence and Gaps pages continue to show what remains open.

1. Approve the integration pull request's `agent-review-gates` gate after reading the workflow diff.
2. Make `docs` a required check on `main` when the pull request that adds `docs` to `CI_CHECKS` merges (done in that PR); later do the same for `compliance`, and enable the fail-on-drop switch only after it has been stable.
3. Create `compliance-settings` under the repository's Settings → Environments. Allow deployments from the `main` branch only and leave required reviewers empty. Create a fine-grained token restricted to this repository with read access to Metadata, Actions, Pull requests, Commit statuses, Administration, and Code scanning alerts. Save it as the environment secret `COMPLIANCE_SETTINGS_TOKEN`.
4. Upgrade `gh` on the documentation host to a version with `gh attestation`, then install the refresh timer with `npm --prefix docs-site run refresh-timer:install`.
5. Do not enable “Require review from Code Owners”; CODEOWNERS provides routing, while the existing gate provides enforcement.
6. Use the public Cyber Centre catalogue and Medium profile sources. The import report records the differences found in the published editions.
7. Confirm or change the recorded supported versions, response times, POA&M target date `2027-05-31`, risk-acceptance purpose `compliance-risk-acceptance`, empty signer list, and the context's remaining owner confirmations.
8. GitHub disables scheduled workflows after 60 days without repository activity; re-enable them when the Evidence page shows a silent collector.

The Controlled Goods and ITAR pages describe your organization's obligations; they are not legal advice. CODEOWNERS currently routes these files to `@ALuhning`, the authenticated human administrator found by the read-only repository check; the owner should confirm that routing at the checkpoint.
