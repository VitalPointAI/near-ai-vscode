---
phase: 71-identities-and-verified-credentials-core
plan: 08
subsystem: gate-credentials
status: complete
tags: [wallet, presentation, cache-state, gate-clearance, cli, offline-bundle]
requires:
  - "71-07: checkEvidence, factsFrom, clearanceFromCredentials"
provides:
  - "src/domain/credentials/present.ts: presentFor(request, wallet, scales)"
  - "src/domain/credentials/cacheState.ts: CredentialCacheState, cacheStateAt, initialCache, CACHE_STATE_TEXT"
  - "src/gate/wallet.ts: Wallet (load, importFile, verifiedView, onDidChange), WALLET_SECRET_KEY, TrustSource, walletStateAt, walletStateText"
  - "src/gate/clearances.ts: clearancesInForce, DECLARED_NOT_VERIFIED_TEXT"
  - "GateHost: options.wallet, clearancesNow()"
  - "deploy/tools/credential-check.mjs and build-credential-engine.mjs (engine generated, git-ignored, packed by deploy/bundle/build.mjs)"
affects: [71-10, 71-12, 71-13, 47-19]
tech-stack:
  added: []
  patterns:
    - "The wallet checks each credential with the fold's own checker (checkEvidence), at the host's clock, citing the credential, its issuer's roles and the lists held now"
    - "The site tool runs the product's checker from one generated engine file, so the operator machine needs no compile"
key-files:
  created:
    - src/domain/credentials/present.ts
    - src/domain/credentials/cacheState.ts
    - src/gate/wallet.ts
    - src/gate/clearances.ts
    - src/test/gateWallet.test.ts
    - src/test/gateCredentialClearance.test.ts
    - deploy/tools/credential-check.mjs
    - deploy/tools/build-credential-engine.mjs
    - deploy/test/credentialCheck.test.mjs
  modified:
    - src/gate/host.ts
    - src/gate/sessionMark.ts
    - src/domain/credentials/evidence.ts
    - deploy/bundle/build.mjs
    - .gitignore
decisions:
  - "Nothing checked yet is unavailable, never fresh; a wallet turns stale when the oldest list it used is past the time to live"
  - "presentFor gives the exact threshold asked for, else the lowest above it on the same scale, else nothing"
  - "Under credentials@1 a stale or unavailable wallet gives no clearance at all (fail closed); without credentials@1 nothing changes"
metrics:
  duration: "about 1 h 15 min (2026-11-24)"
  completed: 2026-11-24
estimate:
  tokens: 105055
  tasks: 3
actuals:
  tokens: 30200
  tasks: 3
  commits: 3
plan_head_before: 81e05f4d
plan_head_after: c37b00ba
---

# Phase 71 Plan 08: The wallet, the gate's clearance from credentials, and the command-line check Summary

- **The wallet:** a person's credentials live under one SecretStorage key. Each is checked on the way in and at every load, with the same checker the fold uses, and the view has one state: fresh, stale or unavailable.
- **The gate:** under your organization's policy with credentials@1, its clearances come only from that fresh view. Otherwise the person's declared clearances apply as before, shown as declared, not verified.
- **Operators:** they check a credential with `deploy/tools/credential-check.mjs`, whose engine is built from the product's code and packed into the signed offline bundle.

## The CLI as built (47-19 calls it)

```
node deploy/tools/credential-check.mjs --holder <did> --type <CredentialType> --credential <file> --trust <dir>
                                      [--scope <scope>] [--at <ISO time>] [--holder-name <name>]
```

- **The trust folder:**
  - `issuer.pub`: your organization's policy issuer key, base64url;
  - `organization.near-org-rules`: the signed rules, with credentials@1;
  - `logs/*.jsonl`: did:webvh logs;
  - `lists/*.json`: signed status lists (the newest version of each id is used);
  - `roles/*.json`: the issuers' role credentials.
- **Exit codes:**
  - 0 prints "<name or The holder> holds a valid <Type>.";
  - 1 prints one sentence on stderr: the checker's own refusal, or "This credential is about someone else.", "This credential is not a <Type>.", "This credential is not for that scope.", "A status list in the trust folder was not signed by the key your organization's rules name for it.", or "This tool is incomplete. Use the copy from your organization's signed offline bundle.";
  - 2 prints the usage line.
- It never prints the credential or its claims.

## Verification

- `gateWallet` 11, `gateCredentialClearance` 6 and `deploy/test/credentialCheck` 11 tests pass. These pass unchanged: `gateLabelReads`, `gateMark`, `gateRouting`, `gateOffline`, `gateRouteGuard`, `gateOrganizationStore`, `credentialsEvidence` and `bundle-verify`, plus `copyLint` and `architecture`. That is 236 of 236 in one capped run on 2026-11-24.
- Acceptance greps:
  - `near-ai.credentials` in `wallet.ts`: 1;
  - `people?.clearances` in `sessionMark.ts`: 0;
  - `clearancesInForce` in `host.ts`: 3;
  - `build-credential-engine` in `build.mjs`: 2.
- The engine test checks that it imports only `node:` built-ins, and that the deploy tree `build.mjs` packs (`deployTreeWithEngine`) contains it next to the tool.

## Deviations from Plan

**1. [Rule 1 - Bug] `checkEvidence` treated every role-type credential as an issuer's role.** So a member's own role credential (the SecurityContactCredential the tool checks) gave `no-evidence`. Now a credential whose subject is the member counts as the member's own, whatever its type. The 71-07 evidence tests pass unchanged. **Commit:** c37b00ba.

**2. The holder's name comes from `--holder-name`.** Credentials carry no name, and people's DIDs end in a random id, never a name (71-RESEARCH.md). Without the flag the tool says "The holder".

**3. The trust folder layout is defined here.** The `.near-trust-export` of 71-11 is a later file; 71-11 can unpack into this layout.

**4. The engine also exports builders** (issueCredential, buildStatusList, signStatusList, buildGenesisEntry, buildOrganizationLayer). The test makes its fixtures with exactly the code that ships, and 71-10 and 71-12's issuer commands can use them. They are pure functions and hold no key.

**5. A labelled read refused under a stale wallet** shows the read site's own sentence. The wallet's sentence is available as `host.clearancesNow().sentence` for the native views (71-13).

## Open conditions

None.

## Known Stubs

- `TrustSource` has an in-memory implementation in tests only. The hub-backed one is 71-13's (planned). Until then no production code builds a `Wallet`, so the gate behaves exactly as before: `GateHost.options.wallet` is unset.

## Threat Flags

None. T-71-26 to T-71-30 are mitigated as planned.

## Self-Check: PASSED

All created files exist. Commits f671782c, 97f96354 and c37b00ba are on `feat/phase-71-wave-2`.
