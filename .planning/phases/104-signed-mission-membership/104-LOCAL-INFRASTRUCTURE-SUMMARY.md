---
phase: 104-signed-mission-membership
plan: local-infrastructure
completed: 2026-11-28
status: verified-local
requirements-completed: []
---

# Local infrastructure planning in Resource Inventory

Resource Inventory now reads an infrastructure report from the selected trusted workspace. It shows reported capabilities, owner, export and observation times, and capacity, including unknown and zero. The report does not verify availability or permissions. Existing stock and public catalogue files keep their format. Infrastructure reports have no edit, copy-reference or link controls.

The widget clears earlier results when the selection or trust changes, the file fails validation or the work-area link picker opens. A stock link checks the current report in a separate read after any pending refresh. The existing external replacement window after the final read remains.

## Local execution and verification

Independent plan review passed SHA-256 `b2ec24a94af3ee185c3706fbfa8fa91275d00e0fc1b0ca43f7aab8fbfeb1d770` against main `688b1abf6456d65db9637c03c67ecf90560b0901`. The owner instruction to proceed with independent feature work covered this local slice. This records no operational approval. Independent exact-source inspection passed the two source files, the two tests and the README.

- Parser RED passed six existing cases and reproduced two missing-parser failures. It then passed all eight cases. Read-order and stale trust RED passed eight and reproduced two missing-seam failures. The focused follow-up passed all ten. Retained logs and their SHA-256 values are below.
- Node 26.13.1, exact lock-matched existing dependencies and ordinary UID 1000. With the shared cap and a fresh network namespace whose only interface was down, Workbench lint, test build, all 15 inventory and work-area link checks with zero skips, and the production Workbench build passed. The first lint reported that the test's Promise helper was outside the configured TypeScript target. The verified test uses an ordinary deferred promise.
- One Chromium case passed in 8.8 seconds with zero skips against the exact native Workbench. It exercised restricted and trusted workspaces, filters and capacity, selecting each of two roots, invalid-file refresh, suppression of record actions and the native link mode. The fixture files, including the work-area record, matched before and after. The test deliberately replaced and restored the fictional report during the invalid-file check. It used a dedicated namespace with only loopback and no routes. An earlier attempt using a different user mapping stopped before Workbench startup when loopback could not be enabled.

Build commands from the Workbench were `npm run lint`, `node scripts/build.mjs`, `node ../scripts/run-tests.mjs dist/test/sterling-resource-inventory.test.js dist/test/sterling-work-area-resource-links.test.js` and `npm run build`. The browser used `./node_modules/.bin/playwright test -c test/e2e/playwright.config.ts resource-inventory.spec.ts --grep 'Resource Inventory shows a local infrastructure report'`.

Evidence under `.scratch/infrastructure-offline.T8nSAG/` in the isolated worktree:

| Evidence | SHA-256 |
| --- | --- |
| `red-direct.log` | `430d17b71bd85dd1d5a1ca271b7bbbd12ca9c7a130536b518e04cf83df17bc64` |
| `green.log` | `d7e364da544bbbdf21742a52186df6f9fa464aec76d21d73a280ad467b67b4bb` |
| `read-red.log` | `41abc05f850947244d4cc65b6b9a082c8c7f5316336014d2c13c053c239911b5` |
| `read-green.log` | `cb7cdd8ad2b450a2fdc6e8da32dfa6b026eeb25f8ee65290dd8d8f6a49d99796` |
| `check-retry.log` | `bfae021ea322ebc2fb6acb15fd70ccd91104fae3ef5681eed157fd27153e59dc` |
| `browser.aSGPz6/run.log` | `f18ee83926f8a42a91d016af21e2b160a8cfb95617129b2b5d8a2c7d34110ee2` |
| Browser before and after file hash manifests | `7f6c1afcc5fccb19cd7aceb1a3e340aa37fd342453b3bd6663a12839be27698f` |

## Open conditions

- **G564** covers verified mission ownership, membership and signed resource authority. Live discovery, connectors and production mission-scoped inventory require this authority and separate integration acceptance.
- Ordinary delivery waits for PR #254 and verification on the resulting main.
