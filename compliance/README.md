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

Neither this package nor `docs/security/` ships in the extension: both are listed in `.vscodeignore`, and the release content check refuses a package that holds either.
# Compliance evidence data

## Writing statements and evidence rules

Add a statement only for behavior the product has today. State what the code does in plain words; do not describe it as compliant, certified, or accredited. Give each implemented requirement exactly one responsibility. A limitation must match a row in SECURITY.md exactly.

Every statement needs an evidence rule. A test rule names the source test file and its exact literal test name, never a comment or a broad file-level result. Renaming or removing that literal name makes the PR summary show the evidence loss. Collector rules name only their documented collector and subject.

Component and rule source files never carry a state. The generated dashboard computes states from current evidence, responsibility, tailoring, and the unsettled or official-decision boundaries.
