---
phase: "47"
slug: "on-premise-deployment-stack-and-offline-bundle"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-11-23"
---

# Phase 47 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution. Seeded from `47-RESEARCH.md` "Validation Architecture".

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `node:test` through `scripts/run-tests.mjs` (existing runner) |
| **Config file** | none; `deploy/test/*.test.mjs` is new (not a gate path) |
| **Quick run command** | `systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 300 node scripts/run-tests.mjs <the one test file for the changed surface>` |
| **Full suite command** | `npm test`, then `node scripts/resource-check.mjs`, then `node scripts/run-tests.mjs deploy/test/*.test.mjs` (needs the pinned `helm`), each under the same memory cap |
| **Lab (not CI)** | `deploy/lab/run.sh` (air-gapped single-node RKE2 VM, up to 10 GiB, one heavy run at a time; owner item E5) |
| **Estimated runtime** | ~120 seconds for CI checks; the lab run is about an hour |

---

## Sampling Rate

- **After every task commit:** the one test file touching the changed surface.
- **After every plan wave:** all of `deploy/test`, the extended `scripts/test/resource-check.test.mjs`, and `node scripts/resource-check.mjs`.
- **Before `/gsd-verify-work`:** full suite green, the deploy CI job green, and one recorded `lab-core` run.
- **Max feedback latency:** 300 seconds (CI checks).

---

## Per-Requirement Verification Map

Every command runs under the memory cap above. Render checks are split per area so plans in the same wave never edit one shared test file; the shared global invariants live in `deploy/test/render.test.mjs` (47-02) and `invariants.mjs` (47-16), and the `deploy` CI job runs the whole `deploy/test/*.test.mjs` glob.

| Requirement | Behaviour | Test Type | Automated Command | File Exists |
|-------------|-----------|-----------|-------------------|-------------|
| DEP-01 | Import refuses a bad signature or any wrong item digest before touching the registry | unit (temp dirs, test key, no network) | `node scripts/run-tests.mjs deploy/test/bundle-verify.test.mjs` | ❌ W0 |
| DEP-02 | RKE2 `profile: cis`, registries only the site registry, audit policy records Theia Cloud records and Secrets at Metadata | unit on files | `node scripts/run-tests.mjs deploy/test/rke2.test.mjs` | ❌ W0 |
| DEP-03 | No ACME issuer and no ingress-nginx in any rendered chart; hub reachable by TCP passthrough only | render | `deploy/test/render.test.mjs`, `render-pki.test.mjs` (47-13), `render-stateful.test.mjs` (47-11) | ❌ W0 |
| DEP-04 | Realm has no password, OTP or recovery-code authenticator; passwordless policy as D-31 for both `signInKeys` levels (D-57); empty AAGUID list refused under `hardware-only` | unit on JSON | `node scripts/run-tests.mjs deploy/test/realm.test.mjs` | ❌ W0 |
| DEP-05 | Every per-person path is templated on `{{identity.entity.id}}`; seal and plugin stanzas present; Control Groups on key moves | unit on files | `node scripts/run-tests.mjs deploy/test/openbao.test.mjs` | ❌ W0 |
| DEP-06 | oauth2-proxy flags, `sessionsPerUser: 1`, eager start off, persistence on, no `imagePullPolicy: Always`, unset volume size refused, session env policy present | render | `deploy/test/render-sessions.test.mjs` (47-12, 47-15), `render-theia.test.mjs` (47-15), `install.test.mjs` (47-16) | ❌ W0 |
| DEP-07 | Every rendered image digest-pinned and in `images.lock.json`; rebuilt images on UBI 9 by digest | render + checker | `node scripts/run-tests.mjs deploy/test/render.test.mjs` and `node scripts/resource-check.mjs` | ❌ W0 |
| DEP-08 | Hub StatefulSet of one: uid/gid 65532, read-only root, caps dropped, seccomp, 16Mi `/tmp`, probes, four `*_FILE` settings, Secret mode 0400 | render | `deploy/test/render-stateful.test.mjs` (47-11) | ❌ W0 |
| DEP-09 | Signed user export, revocation lists and intermediates verify with the same check as the bundle | unit | `deploy/test/bundle-verify.test.mjs` (47-06), `federation.test.mjs` (47-14) | ❌ W0 |
| DEP-10 | Checker finds charts, tools, lock-file images and Containerfile `FROM`; unpinned image is a problem | unit | `node scripts/run-tests.mjs scripts/test/resource-check.test.mjs` and `node scripts/resource-check.mjs` | extend existing |
| DEP-11 | Runbooks exist and cover each ceremony | document review | n/a | n/a |
| DEP-12 | Air-gapped lab install with zero egress; sign-in once Phase 46's image exists | lab, scripted | `deploy/lab/run.sh` | ❌ W0 |
| DEP-13 | Guest rules refuse before any write; `guests` carries no role; a guest's entity is `guest-<id>` under the staff policies; end disables both sides and deletes nothing; `guest-expiry` only disables guest entities; the CronJob renders only with guests on, with a sessions-only Role; guests leave a site only when named, with `guests@1` and the target-site check; Keycloak holds lifecycle attributes only, no `security-contacts` group and no attribute or group claims in tokens; the approver passes the `SecurityContactCredential` check; an early end writes one create-only `sterling-revocation-request/1` (reason `guest-ended`, 71 D-22) that 71-12's card shows to the issuing officers; guests turn on only with 71-12 (revised 2026-11-24, owner: credentials) | unit with fakes + render + OpenBao and Keycloak in podman | `deploy/test/guests.test.mjs` (47-19, 47-20), `realm.test.mjs`, `openbao.test.mjs`, `federation.test.mjs` (47-21) | ❌ W0 |

### Compliance follow-ups (added 2026-11-24, `47-COMPLIANCE-CONTEXT.md`)

| Control (decision) | Behaviour | Test Type | Automated Command | Plan |
|--------------------|-----------|-----------|-------------------|------|
| AU-8, SC-45 (D-71) | chrony.conf names only site sources; Node and shell clock checks agree on real chronyc fixtures; node install refuses a bad clock; preflight refuses no source and a bad import host clock | unit + lab | `deploy/test/time.test.mjs`, `install.test.mjs` | 47-22, 47-16 |
| AC-8 (D-76) | Realm carries the notice per language; empty notice refused; theme ConfigMap mounted before Keycloak | unit on JSON + render | `deploy/test/realm.test.mjs` | 47-23 |
| CP-9, CP-10 (D-73) | Snapshot-only OpenBao policy and CronJob; OpenSearch repository and policy rendered; restore proven in a container | unit + render + container | `deploy/test/openbao.test.mjs`, `render-site.test.mjs` | 47-24 |
| CP-9 (D-73) | Escrow files 0600 with digest records; stale escrow detected; no value printed or on argv | unit + lab | `deploy/test/escrow.test.mjs` | 47-25 |
| D-06 (D-77) | Edited register entries pass the checker | checker | `node scripts/resource-check.mjs` | 47-26 |
| CP-2, CP-10 (D-73) | Recovery order, record validation, exact cron gaps against RPO, scratch-only drivers with cleanup | unit (fake runner) + lab | `deploy/test/drill.test.mjs` | 47-27, 47-18 |
| MA-2, MA-6 (D-75) | drain-check, upgrade-check, cert-check refusals | unit (fake runner) + lab | `deploy/test/maintenance.test.mjs` | 47-28 |
| RA-5, RA-5(2), SI-2, CM-4 (D-72) | Bundle carries SBOMs, scans, database, grype, change record; offline rescan; database host and checksum refusals | unit + container | `deploy/test/scan.test.mjs` | 47-29 |
| MP-4, MP-5, MP-7, SI-3, AC-4 (D-74) | Outbound kinds only, export marking under requires marking@1 with the target-site check (47 D-69), unlisted inbound files refused, transfer records, bundle manifest unchanged (47 D-68) | unit + container | `deploy/test/media.test.mjs`, `bundle-verify.test.mjs` | 47-30 |
| AC-2(3), AC-2(4), AC-12, IA-4 (D-79) | Disabled or removed people lose OpenBao access and sessions within revocation.checkMinutes; partial reads never revoke; narrow credentials; shared with guest expiry | unit (fakes) + podman + lab | `deploy/test/revoke.test.mjs`, `guests.test.mjs`, `realm.test.mjs` | 47-31 |
| CP-6, CP-9 (D-81, D-82) | Daily off-site copy locked per source (archive 1,825 days), signed chained manifest, keys never in the set, media mode, required by the preflight, quarterly sample check | unit (fake store, SigV4 vector) + lab store | `deploy/test/offsite.test.mjs`, `install.test.mjs` | 47-33 |
| SC-12 (D-80) | Production preflight refuses SoftHSM2 as the OpenBao seal (`softhsm-seal-token`); the signing-token rule is 48.1-17's | unit | `deploy/test/install.test.mjs` | 47-16 |
| CP-9, AU-9 signals (H-08) | `opensearch-snapshot-check` and `sterling-escrow-currency` Jobs fail on a missing snapshot or a stale escrow | unit + render | `deploy/test/render-site.test.mjs`, `escrow.test.mjs` | 47-24, 47-25 |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `deploy/test/` and the `deploy` CI job; `helm` pinned in `compliance/ci/tool-pins.json`
- [ ] Spikes, each the first task of the plan it gates: S1 cosign key mode and hauler with Zot; S2 Kyverno static-key image check; S3 Postgres image source; S4 cert-manager `vault` issuer on OpenBao; S5 `kms-pkcs11` with SoftHSM2; S6 Keycloak realm, AAGUID, user export round trip, `acr`/`auth_time`; S7 custom operator template admitted under restricted Pod Security

- Known red until 47-04: `compliance/test/toolPins.test.ts` ("exactly the three CI binaries are pinned" and "every tool has ... a known archive kind") fails from wave 1 on, because wave 1 adds the new tool pins and 47-04 owns that test and `install-tool.sh`. Wave 1 lands only with 47-04 in the one D-52 gate PR, never alone (47-01-SUMMARY.md, "Landing condition").

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Runbooks are usable by an operator | DEP-11 | Document review | Walk through each runbook during the lab run |
| Hardware-key sign-in with a real key | DEP-04, DEP-12 | Needs physical hardware | Enrol two keys in the lab realm; sign in; lose one; re-enrol by administrator |
| Real HSM unseal | DEP-05 | Site hardware | Site acceptance; SoftHSM2 covers dev and CI |
| Guest automatic end in a cluster (Session stop, RBAC) | DEP-13 | Needs a running cluster | In the phase verification lab run, set `guests.maxDays` in a copy of the lab realm site file, enrol a guest whose end is a few minutes away, and check: the CronJob ends it, its Session is stopped, and its Workspace and volume are kept |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 300s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
