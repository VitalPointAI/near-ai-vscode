---
phase: 71-identities-and-verified-credentials-core
plan: 11
subsystem: trust-transfer
status: complete
tags: [trust-export, edge-import, offline-age, hub-chart, d-17]
requires:
  - "71-09: hub/src/store/trustStore.ts (TrustStore: putLog, putStatusList, allLogs, newestLists, heldListState, newest)"
  - "71-04, 71-05, 71-06: verifyWebvhLog, verifyStatusList, newerThan, keepsRevocations, verifyOrganizationLayer"
provides:
  - "src/domain/credentials/trustExport.ts: TRUST_EXPORT_EXTENSION, TRUST_EXPORT_FORMAT, buildTrustExport, readTrustExport, didHostPath, TRUST_IMPORT_REFUSALS"
  - "hub/src/trustTransfer.ts: exportTrust, importTrust, TRANSFER_TEXT"
  - "hub --trust-export <file> and --trust-import <file>"
  - "deploy/hub chart: per hub item organizationPolicy { configMap | secret, key } and organizationKey"
affects: [71-12, 71-14, 47-14]
tech-stack:
  added: []
  patterns:
    - "Each object in the file verifies on its own; the edge takes only what is newer than what it holds and names every refusal"
    - "The edge's rules stay the ones its configuration names: newer rules in a file are reported, never written"
key-files:
  created:
    - src/domain/credentials/trustExport.ts
    - src/test/credentialsTrustExport.test.ts
    - hub/src/trustTransfer.ts
    - hub/test/trustTransfer.test.ts
  modified:
    - hub/src/main.ts
    - deploy/hub/templates/statefulset.yaml
    - deploy/hub/values.yaml
    - deploy/test/render-stateful.test.mjs
decisions:
  - "The policy layer is read first; lists are checked against the newest verified rules (the file's when newer, else the edge's own)"
  - "An edge import may skip list versions (newer and keeping every revocation is enough); only the hub's PUT requires exactly one above"
  - "The rules and key are set per hub item in the site file, not in deploy/values/sterling-hub.yaml"
metrics:
  completed: 2026-11-24
estimate:
  tokens: 90047
  tasks: 3
actuals:
  tokens: 12150
  tasks: 3
  commits: 3
plan_head_before: 95fa4c68
plan_head_after: ea6b3a3b
---

# Phase 71 Plan 11: The trust export to edges, its import, and the hub chart's rules Summary

- **One file, checked piece by piece:** HQ writes its identity logs, the newest copy of each status list and your organization's signed rules into one `.near-trust-export` file. Nothing new is signed.
- **The edge takes only what holds:** each object must verify on its own and be newer than the edge's copy. A list never replaces a newer one or clears a revocation. Each refused object is named in one line, and the rest is still taken.
- **Offline age:** it counts from each list's own validFrom, never from the file's time, so a Protected B check refuses a list past 72 hours (the example value).
- **The chart:** a hub item in the site file can name your organization's rules and key; without both, the hub runs with its trust routes off.

## The file format as built (for 47-14's runbook)

```
{ "format": "near-trust-export/1", "exportedAt": "<ISO time, shown only>",
  "objects": [ { "kind": "policy-layer", "layer": <signed organization layer> },
               { "kind": "did-log", "path": "people/<id>", "log": "<did.jsonl text>", "witness"?: "<did-witness.json text>" },
               { "kind": "status-list", "list": <signed BitstringStatusListCredential> } ] }
```

The text is canonical JSON. Any other `kind` is refused and named (`unknown-kind`), never ignored.

## The commands as built

```
node /app/bin.mjs --trust-export <file>    at HQ: exit 0 "Wrote <file>: N identity logs and M status lists."; exit 1 with one sentence
                                            when the hub holds nothing, has no valid rules, or the file exists (never overwritten)
node /app/bin.mjs --trust-import <file>    at an edge: one line per refused object ("Object <n> (<kind>): <sentence>"), then
                                            "Imported N identity logs and M status lists from <file>."; exit 0 when anything was taken
```

Both run with the hub's normal settings (state folder, secrets, `HUB_ORGANIZATION_POLICY`, `HUB_ORGANIZATION_KEY`) and print plain lines only.

### Import refusals (`TRUST_IMPORT_REFUSALS`)

unreadable, unknown-kind, policy-invalid, policy-older, no-policy, list-not-in-policy, list-invalid, older, revocation-cleared, log-invalid (with the log's own reason), wrong-path, log-conflict.

### The chart as built

A hub item may add:

```yaml
organizationPolicy: { configMap: <name>, key: <key> }   # or { secret: <name>, key: <key> }
organizationKey: <43 base64url characters>
```

The layer is mounted read-only at `/run/organization/organization.near-org-rules`, and both settings reach the hub. Naming only one of the two, both a ConfigMap and a Secret, or a malformed key stops the render with one sentence.

## Verification

- **Failing first:** the new test files did not compile before `trustExport.ts` and `trustTransfer.ts` existed, and the two chart tests failed on the unchanged chart (no `HUB_ORGANIZATION_` setting rendered).
- **Tests added:** `credentialsTrustExport` 8 (at least 6 asked), `trustTransfer` 6 (at least 5 asked), 2 in `render-stateful` (at least 2 asked).
- **Tests run (capped, 2026-11-24):**
  - root, under the heavy-command lock: `credentialsTrustExport` and `architecture` in the 50-test run above, all passed;
  - hub, under the lock, Node 26.13.1: `trustTransfer`, `trustRoutes` and `startup` in the 61-test run, 58 passed, 0 failed, 3 skipped (older-Node cases);
  - `deploy/test/render-stateful.test.mjs` with helm: 6 tests, 6 passed.
- **Acceptance greps:** `.near-trust-export` in `trustExport.ts`: 3; `trust-import` in `hub/src/main.ts`: 5; `organizationPolicy` in the StatefulSet template: 5.

## Deviations from Plan

**1. The rules and key are per hub item, not in `deploy/values/sterling-hub.yaml`.** The hub chart renders once per item of the site's `hubs` list, and each item arrives as `instance`. Per-item settings need no change to the release values file, which stays untouched.

**2. An import may skip list versions.** It calls `putStatusList(..., { exactNext: false })`: newer and keeping every revocation is enough, while the hub's PUT keeps its exact compare-and-swap (71-09 deviation 4).

**3. The edge's own rules are never replaced by an import.** The plan's import "keeps" the policy layer. The hub reads its rules from the read-only file its configuration names (Task 3), so newer rules in a file are reported in one line for the administrator instead.

## Open conditions

None.

## Known Stubs

None.

## Threat Flags

None. T-71-41 to T-71-44 are mitigated as planned.

## Self-Check: PASSED

All created files exist. Commits 8f4f5ec8, 4b45808c and ea6b3a3b are on the branch.
