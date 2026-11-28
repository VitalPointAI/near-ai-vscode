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

## Adding a resource

Before the repository uses a new third-party resource (an npm package in any `package.json`, a container image in `hub/Dockerfile`, `relay/Dockerfile`, `relay/compose.yaml`, a `deploy/images/*/Containerfile` or the `images` list of `deploy/bundle/images.lock.json`, a Helm chart in `deploy/charts/charts.lock.json`, a pinned tool in `ci/tool-pins.json`, a GitHub Action, or a library `scripts/vendor-libs.mjs` ships), check how it fits the compliance requirements and add an entry to `resources.json`. Each entry's `kind` is `npm`, `image`, `action`, `vendored`, `chart` (id `chart:<name>`) or `tool` (id `tool:<key in tool-pins.json>`); the image lock's `built` and `release` lists are images this repository builds or another pipeline publishes, so they need no entry, but every base a Containerfile pulls does. The fields are described in `schemas/resources.schema.json`: where it is used, which component, runtime, build or test scope, purpose, its `role` (why the architecture needs it: what breaks, or what we would have to build, without it, and which part it serves; add `"roleNeedsReview": true` when the role is not yet clear, and say what it is used for), its `architectureArea` (one of the ids in `architecture-areas.json`), licence, its `supplier` (the organization that publishes it, from the SBOM or the publisher's own pages; "Individual maintainers" for packages people publish on their own, with no names recorded) and `supplierJurisdiction` (the ISO 3166-1 alpha-2 code of that organization's legal seat as its own pages state it, or `unknown`; never inferred from a domain or a time zone; Phase 48.4), the controls it supports or affects, the evidence it gives a collector, its cryptography, how security fixes reach us, whether it works air-gapped, and the verdict `fit` (`pass`, `pass-with-conditions` with the conditions written down, or `fail`), with the reviewer and date.

Models are resources too. Every model passport the extension ships (`src/domain/gate/shippedPassports.ts`) needs an entry of kind `model` with id `model:<passport id>`: the check reads each row's literal `id: '<id>'` line from the files in `MODEL_FILES` in `scripts/resource-check.mjs`. The entry records the licence as the publisher states it (the same text as the passport's `licence.id`), the controls it supports (at least `sa-04`, `sr-03` and `sr-04`), `airGap` `needs-mirror: weights by your organization's approved transfer` for open weights and `no` for a closed API, and the conditions of its use: research only for a model whose developer is in the People's Republic of China, only where the label allows any cloud for a closed API, and your organization's own passport with the artifact hash for its own hosting of open weights. A new shipped passport, or a corrected licence, changes the entry in the same pull request. Phase 74.3 appends its classifier roster to `MODEL_FILES` rather than adding a second model kind.

The `lint` CI job runs `node scripts/resource-check.mjs`, which fails when a resource has no entry, an entry is `fail`, a `pass-with-conditions` entry lists no conditions, a field is missing or invalid (unknown control or component included), an entry no longer matches anything (stale), an action is not pinned to a full commit SHA, or an image (in a Dockerfile, a Containerfile or the image lock) is not pinned by digest. Something the product runs that needs the internet or uses unvalidated cryptography is never a plain `pass`. `node scripts/resource-check.mjs --json` prints the inventory as evidence. The register and the script are gate files: changing them needs the owner's approval.

The register is the one source of the component inventory (`src/inventory.ts`, which reads each entry's exact pins from the lockfiles, Dockerfiles, Containerfiles, image and chart locks, tool pins and workflows). It has three outputs that must agree: the component catalogue of the documentation site (`docs-site/content/architecture/components/`, written by `node scripts/build-component-catalogue.mjs`), the SSP `inventory-items` of each level in the assessor package, and the package's `readable/component-inventory.csv`, which the SA&A export carries as a workbook sheet. After changing the register or `architecture-areas.json`, run `node scripts/build-component-catalogue.mjs` and commit the pages; `scripts/test/component-catalogue.test.mjs` fails when they differ.

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

## Hosted deployment evidence

A running site proves its hosted controls through a signed deployment evidence export, which the `deployment` collector (`src/collectors/deployment.ts`) reads offline. CI never connects to a site.

What the export holds: the site id, the time it was made, and a fixed list of facts. The facts are counts (enabled password or one-time-code authenticators in the realm's bound flows, `loadtest-` clients, audit events shipped to the log store in the last day, nodes and nodes in FIPS mode, images in the lock list and images whose signature, SBOM and provenance verified, sampled sessions and sessions with the FIPS provider on), true or false values (user and admin events on, Session and Workspace records audited), a few named values (Keycloak build, Keycloak FIPS mode, OpenBao seal type, registry product), the Keycloak and OpenBao versions, and the SHA-256 of the Kubernetes audit policy. What it never holds: realm or client names, user names, emails, tokens, passwords, keys, log lines or policy text. The collector refuses an export with any fact outside that list, so a site cannot add one, and it decides every pass itself under thresholds in its source. The export carries no pass field. Observations keep only the check name, pass or fail, counts, the audit policy hash and the signed time.

The export is signed in the extension's signed-payload format for the purpose `site-evidence-export`. Only a key in `attestations/site-signers.json` (a gate file) makes a reference export count. The list ships empty until the owner adds the reference site's operator key, a key held by the site operator, never one held by the OpenBao instance the export describes. An export signed by any other key, for another purpose, with a time in the future, with a changed fact, or that is missing, unreadable or larger than 256 KiB stops the collector. Every rule on it then reads as a missing result, never Met.

Each observation is dated at the export's signed time and judged on the 7-day settings window. An export older than 7 days reads Stale, whatever CI ran since.

Making an export on a site takes two steps, both run by the site operator:

1. `compliance/site-export/collect.sh --out <empty folder>` collects the raw outputs. It only reads: `kubectl get`, `kcadm.sh get`, `bao status` and `bao read`, `cosign verify` and `cosign verify-attestation` for each digest in the image lock list, a count query to the log store, `/proc/sys/crypto/fips_enabled` on each node over SSH, and `node -p "crypto.getFips()"` in a sample of session pods. It starts no pod and changes nothing. Its settings and the tools it needs are listed at the top of the script; credentials come from the operator's environment. The folder holds raw site data, so it stays on the site.
2. `node compliance/src/cli.ts site-export --sources <folder> --site <id> --key <pkcs8.pem> --out <export.json>` reads only the files it knows from that folder, keeps only the facts, and signs. For a key in an HSM or other external signer, run it with `--public-key <key> --emit-signing-input <file> --out <unsigned.json>`, sign the bytes of that file with Ed25519, then run `site-export --unsigned <unsigned.json> --attach-signature <signature> --out <export.json>`. The command checks the signature before it writes. It stops without writing when a source file is missing, too large or unreadable, or when the repository's secret scan flags any text in the export.

The reference site's export reaches the public dashboard as a committed file under `compliance/site-evidence/`, signed by the owner-approved key.

Your organization's own sites stay in your organization's local view and are never uploaded. Give the bundle your own export and your own trust list as the `deployment` collector input, `{ "deployment": { "file": "<your export>", "signersFile": "<your trust list>" } }` in the inputs file of `node compliance/src/cli.ts bundle --inputs <file> --out <bundle>`, then show it with `npm --prefix docs-site run compliance:refresh -- --from-dir <bundle>`. The public trust list refuses your export. The organization overlay cannot carry this evidence: it only changes rows that are your organization's responsibility.

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
