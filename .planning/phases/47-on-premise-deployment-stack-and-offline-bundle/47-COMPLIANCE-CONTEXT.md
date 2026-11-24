# Phase 47: Compliance follow-ups for the on-premise stack - Context

**Gathered:** 2026-11-24
**Status:** Ready for execution after wave 5 (47-13, 47-14, 47-15) merges.
**Source:** a compliance audit of the Phase 47 stack found six gaps (AU-8 and SC-45; RA-5, RA-5(2), SI-2 and CM-4; CP-2, CP-6, CP-9 and CP-10; MP-4, MP-5, MP-7, SI-3 and AC-4; MA-2, MA-6 and SI-2; AC-8). A seventh was added the same day: access lingering after a person is disabled (AC-2(3), AC-2(4), AC-12, IA-4). The owner's direction (2026-11-24): obligations that the controls require must be planned by us, with code and generated output and tests wherever possible. This file sits beside `47-CONTEXT.md`, whose decisions D-01 to D-57 still bind. Decision numbers start at D-70 and threat numbers at T-47-80, so they do not clash with the guest-accounts plans (47-19 to 47-21, PR #182: D-58 to D-65; threats up to T-47-76, plus T-47-125 in 47-21) or with version safety (47-32: D-66 to D-69; threats T-47-120 to T-47-124). Ours are D-70 to D-83, T-47-80 to T-47-118 and T-47-126 to T-47-130 (47-33). These plans were renumbered 47-22 to 47-30 on 2026-11-24 for the same reason, and 47-31 was added.
**Discovery (level 1, read as text only, nothing run from downloads):** Grype 0.122.1 source (`grype db list -o json` gives the archive address and its `sha256:` checksum; `grype db import FILE`; settings `db.auto-update`, `db.validate-age`, `db.cache-dir`, `check-for-app-update`; the listing is `https://grype.anchore.io/databases`); Keycloak 26.8.2 source (`TermsAndConditions.evaluateTriggers` is empty, so the terms action shows once per person; `keycloak.v2/login/template.ftl` calls `footer.ftl` on every sign-in page, and `footer.ftl` says it is meant to be overridden by a custom theme; `RealmRepresentation.localizationTexts` exists); docs.rke2.io backup and restore page (the server token at `/var/lib/rancher/rke2/server/token` must be restored, or passed as `token`, to restore any snapshot; with secrets encryption on, snapshots include the encryption configuration and keys, protected by the token; `ETCDSnapshotFile` resources list snapshots); chrony 4.8 on the development host (`chronyc -c tracking` fields, in order: reference id, name, stratum, reference time, system time offset, last offset, RMS offset, frequency, residual frequency, skew, root delay, root dispersion, update interval, leap status).

<domain>
## Boundary

In scope: the six gaps, as code, generated output and tests where possible, and as runbook text where the obligation is human or physical. Everything stays on-premise and works air-gapped; logs go to the site's OpenSearch through Fluent Bit; sign-in stays passkeys and hardware keys only; the first goal is an HQ of about 400 people and no plan states a capacity figure; documents say "your organization".

Not in scope (Phase 48.1, planned in parallel): the hosted SSP, the threat model document, the exchange register, the key management plan, alerting, the audit store design (retention, tamper-evidence, the write-once archive of 48.1-14 to 48.1-16 and the hosted audit store gap 48.1-01 files), the crypto inventory, and the signing tool (48.1-17). These plans supply mechanisms those documents point to and plan none of the documents:
- the key management plan can cite the escrow procedure and escrow checks (D-73);
- the exchange register can cite the inbound and outbound transfer kinds and records (D-74);
- alerting can watch the signals these plans expose (clock error, backup job results, escrow currency, certificate horizons);
- the RTO and RPO values fill the settings defined here (D-73).

Alert ownership (decided in 48.1's hand-off ledger, row H-08): every hosted alert rule is 48.1's. 48.1-16 owns the clock-error and escrow-currency alerts, and 48.1-12 the backup alerts. These plans supply the signals:
- **clock error:** node-exporter's timex series (`node_timex_*`). Node-exporter is on in the Prometheus release with its default collectors, timex included. The threshold is `time.maxClockErrorMs` (47-22), whose name stays stable;
- **backup and off-site job results:** the CronJobs `openbao-raft-snapshot` (47-24), `opensearch-snapshot-check` (47-24; it fails when no OpenSearch snapshot has finished in 36 hours) and `sterling-offsite` (47-33), through kube-state-metrics job and CronJob series, the same pattern 48.1-12 uses for the Postgres dump;
- **escrow currency:** CronJob `sterling-escrow-currency` (47-25), which fails when the `longhorn-crypto` key no longer matches its digest-only record. The RKE2 token and encryption configuration are node files no restricted pod may read; their currency stays with `escrow-node.sh check`, after every key rotation and on 48.1-04's monthly checklist.

The `audit-archive` Transit key is 48.1-14's; 47-17's key ceremony creates it by running `apply.mjs`, exports its public key with a recorded fingerprint, and records the first manifest as the verification anchor (H-05). Signing with the site key uses the pinned cosign 3.1.4, with the key operation through OpenSC `pkcs11-tool` (`deploy/bundle/lib/pkcs11-sign.mjs`, 48.1-17). The owner's development key comes from `deploy/keys/new-dev-site-key.sh` (48.1-22).

Not in scope here either: guest accounts (47-19 to 47-21). 47-31 shares their expiry job's mechanism (D-79).
</domain>

<decisions>
## Decisions

- **D-70 (owner, 2026-11-24):** Obligations the controls require are planned by us. Each is delivered as code or generated output with tests wherever possible, and as runbook text only where the obligation is a human or physical act. Every item traces to one of the controls above.
- **D-71 (time source; AU-8, AU-8(1), SC-45):** Site requirement: an on-site authoritative time source on the site network, either a GNSS-disciplined NTP appliance or a stratum-1 server (two or more recommended), never an internet pool. Every node and the import host run chrony from the site's own OS repository, configured as code from the site file's `time` settings (`servers`, `refclocks`, `nts`, `maxClockErrorMs`): clients only, the site's sources only, a step allowed only in the first three updates after start, and NTS when the source supports it (trusting the site CA). The install refuses a site file with no source, and refuses a node or the import host whose clock is not synchronised, is following its own local clock, or whose error bound (absolute offset plus root dispersion plus half the root delay, chrony's own bound) exceeds `time.maxClockErrorMs`. Default 1000 ms, an organization-defined value under AU-8(1): it keeps every node within about two seconds of every other, far inside the tightest tolerance in the stack (5 minutes for signed site exports in `compliance/src/status.ts` `FUTURE_TOLERANCE_MS` and gate bundles in `src/domain/gate/bundle.ts` `CLOCK_SKEW_MS`; 10 minutes for future-dated replica entries in `src/domain/replica/chain.ts` `FUTURE_HOLD_MS`), and suits certificates, WebAuthn, etcd and audit correlation across nodes. The lab uses the KVM PTP clock (`refclock PHC /dev/ptp0`) because the air-gapped VM has no network time source. Workstations sync to the same source (runbook line). Alerting on drift is Phase 48.1's.
- **D-72 (vulnerability scanning and SBOMs for the bundle; RA-5, RA-5(2), SI-2, CM-4):** The bundle build makes a CycloneDX SBOM (the pinned syft) of every image item: the 38 upstream images in `deploy/bundle/images.lock.json`, and, because it is the same loop and a site must be able to rescan everything it runs, our built and released images too. It scans each SBOM with the pinned grype against a vulnerability database downloaded on the connected build host from Anchore's listing (host `grype.anchore.io` only, checksum from the listing verified). It adds to the bundle, under the one manifest signature: the SBOMs and scan results (`security-reports.tar`), the database it used (`vulnerability-db.tar.zst`), grype as a site tool, and a change and impact record (`change-record.json` and `change-record.md`) against the previous bundle. The record holds the item digest diff, the deploy file diff with security-relevant paths flagged, and the CVE delta split into fixed, introduced by the change, and newly disclosed. Sites rescan offline (`scan.mjs rescan`) with every update check off. Between bundles HQ ships a signed database file (`scan.mjs db-pack`), so rescans use current data (RA-5(2)). Scans are report-only and the site change board decides; whether a critical finding with a fix should block a bundle is an owner item. The pins are the owner-approved syft 1.57.2 and grype 0.122.1 in `compliance/ci/tool-pins.json`.
- **D-73 (contingency and backup; CP-2, CP-6, CP-9, CP-10):**
  - **Recovery order.** Stage 0 is the prerequisites that hold no unique data: nodes; RKE2, by etcd restore with the escrowed token or by a fresh install; and the registry, rebuilt by importing the last verified bundle so that images can be pulled. Then the owner's priority order: 1 the HSM and OpenBao; 2 Keycloak and its Postgres; 3 the registry's own service (Harbor's state, and admission back to Deny); 4 Theia Cloud sessions and workspace volumes; 5 the hubs.
  - **Audit gate (planner decision, owner to confirm).** People are let back in at step 4 only once the audit pipeline (OpenSearch and Fluent Bit) runs, so their actions are recorded. The historical audit data is restored from snapshots afterwards, as step 6.
  - **Backups added.** Scheduled OpenBao Raft snapshots, by a CronJob whose token can only read `sys/storage/raft/snapshot`, onto an encrypted volume. OpenSearch audit and log snapshots to a filesystem repository on an encrypted volume, under a snapshot-management policy, with a tested restore. Both volumes join the Longhorn backups. OpenSearch snapshots are kept 1,825 days, the hosted audit retention (D-82).
  - **Escrow.** The RKE2 server token (required to restore any etcd snapshot), the secrets-encryption configuration (also inside each snapshot, protected by the token; escrowed so a restore never depends on a surviving node, and so a key rotation is detected) and the `longhorn-crypto` key (needed to read any Longhorn backup) are written to escrow media, with the key backups of the HSM tokens (the site signing key and the seal key, D-80) recorded by digest-only records. Two key custodians hold that media, kept apart from the backups. Escrow records hold digests only, and the checks report a stale escrow after a rotation.
  - **Registry.** It is not backed up. It is rebuilt from the bundle, and the import host keeps the last two verified bundles on the backup target.
  - **Off-site copy (required, 3-2-1, D-81).** Every day to a write-once store at a second organization site, or by signed media for a disconnected site: the encrypted backups and the write-once audit archive. The key backups go separately, with the custodians. A quarterly restore drill runs from the off-site copy (47-33).
  - **Degraded modes.** Runbook text for two cases: HQ lost, and an edge disconnected.
  - **RTO and RPO (D-83).** Site-wide settings in the site example: `recovery.rtoMinutes: 480` and `recovery.rpoMinutes: 1440` (owner decision c, 2026-11-24). They are the single source that 48.1's system description reads. `drill.mjs plan` compares every backup schedule with the RPO, and a full-site drill compares the total recovery time with the RTO.
  - **Restore-test record.** Format `sterling-restore-test/1`.
  - **Drill as code.** Non-destructive verifies: a Postgres dump restored into a scratch database, OpenSearch snapshots restored into renamed indices, a Longhorn backup restored into a scratch volume, the retained bundle checked, and escrow currency checked. The lab-only destructive steps (etcd cluster reset, OpenBao snapshot restore) and the human steps are timed into the same record.
- **D-74 (media handling; MP-4, MP-5, MP-7, SI-3, AC-4):**
  - **Marking.**
    - The bundle is UNCLASSIFIED. `check.mjs --record` states it on the inbound transfer record; the `sterling-bundle/1` manifest is not changed (47 D-68).
    - User exports carry the site's `personalDataMarking` under `requires: ["marking@1"]` (47 D-69). The marking is required and has no default; the owner confirms the level.
    - Exports travel only on encrypted approved media, and only to a target site whose signed evidence export shows it reads `marking@1`. CSRs, revocation lists and site evidence exports hold no personal data.
  - **Approved media (MP-7).** Write-once optical media, or your organization's approved hardware-encrypted removable drives, and nothing else.
  - **Chain of custody (MP-5).** A transfer record (`sterling-transfer/1`) is written by `check.mjs --record` for inbound media and `outbound.mjs check --record` for outbound media, beside the runbook's custody form: two-person handover, tamper-evident seal number, signatures.
  - **What crosses (AC-4).** Import refuses any file in the bundle folder that the signed manifest does not list. Only signed files of known kinds leave an edge: user export, CSR, revocation list, site evidence export. `outbound.mjs` refuses anything else.
  - **Sanitizing after import.** Write-once media is destroyed, or kept under custody as the archive copy. Reusable drives are sanitized under your organization's procedure (CCCS ITSP.40.006) before reuse, and are never carried back to the connected side unsanitized.
  - **Malware scanning (SI-3).** No anti-malware engine ships in the bundle. Cosign signatures and grype prove origin and known CVEs, not the absence of malicious code, and neither covers the non-image payloads (RPMs, tarballs, plugin binaries, charts). So every medium is scanned on your organization's approved malicious-code scanning station twice: on the connected side before writing, and at the air-gapped entry point before import. The result goes on the transfer record, together with the provenance allowlist above. Owner item: confirm this, or choose an engine in the bundle, which would be a new resource with a fit entry and an offline signature feed.
  - **HQ build host.** The transfer is one-way, from the connected build host to the air-gapped enclave, through the scanning station and a verification host.
- **D-75 (maintenance; MA-2, MA-6, SI-2):**
  - **Runbook.** `maintenance.md` covers node OS patching from the site's own OS repository mirror (refreshed by media), with one node at a time drained. It also covers:
    - the RKE2 upgrade order: servers one at a time, then agents, one minor version per bundle;
    - certificate renewal and the expiry of the site intermediate and the HQ root;
    - HSM firmware: only versions listed on the module's CMVP certificate, a Raft snapshot first, and an unseal test after;
    - patch timelines: your organization's timelines by severity, measured from a bundle's `created` date; the values are an owner item;
    - maintenance records.
  - **Checks as code (`maintenance.mjs`).**
    - `drain-check`: etcd quorum, OpenBao members Ready, and Longhorn volumes whose only healthy replica is on the node; it also lists the hubs and sessions the drain interrupts.
    - `upgrade-check`: the bundle's RKE2 version must be no downgrade and at most one minor version up; every node must be Ready and on one version; the etcd snapshot, OpenBao Raft snapshot and Postgres dump must each be recent (`--max-backup-age-hours`, default 24); plus the certificate checks.
    - `cert-check`: cert-manager Certificates must be Ready with renewal not overdue; the site CA chain and the API server certificate must not expire within `--horizon-days` (default 90).
- **D-76 (system use notice; AC-8):**
  - **Where it is set.** Organization-configurable text per language in the realm site file, `systemUseNotice`. `en` is required; a default `en` and `fr` text is supplied for your organization's legal review (owner item).
  - **How it reaches the sign-in page.** Realm as code writes it into `localizationTexts` under `sterlingSystemUseNotice`. A minimal login theme `sterling` (parent `keycloak.v2`) overrides only `footer.ftl`, the template's documented extension point, so the notice shows on every Keycloak sign-in page, including the administration console sign-in. The theme is delivered as ConfigMap `sterling-login-theme` by a small local chart that installs before Keycloak.
  - **Why not terms and conditions.** Keycloak's terms-and-conditions required action shows once per person, not at every sign-in.
  - **Refusal.** `apply.mjs` refuses an empty notice.
  - **Other access points.** Node console and SSH banners use the same text through the site's OS hardening baseline (runbook line). API-only access points show no banner.
- **D-77 (register; D-06):** One gate PR (47-26) updates the entries whose use changes:
  - `tool:grype`: site rescans, and the database fetched on the connected host and shipped in the bundle;
  - `tool:syft`: SBOMs of every bundle image;
  - `tool:rke2`: chrony, the on-site time source, and escrow of the token and encryption configuration;
  - `chart:longhorn`: escrow of `longhorn-crypto`;
  - `chart:opensearch` and `chart:openbao`: scheduled snapshots.

  No new resource kind is needed. A new resource would be needed only if the owner picks a malware engine (D-74).
- **D-78 (numbering and waves):** Plans 47-22 to 47-31; 47-19 to 47-21 are the guest-accounts plans.
  - Wave 6: 47-19 (guests), 47-22, 47-25, 47-26.
  - Wave 7: 47-16 and 47-17 (amended), 47-23 and 47-24 (after 47-19, which edits the same realm and OpenBao files), 47-27, 47-28.
  - Wave 8: 47-18 (amended), 47-20 and 47-21 (guests; they depend on 47-16 and 47-17), 47-29.
  - 47-32 (version safety, planned separately) is wave 9, after 47-18, 47-21 and 47-29; it shares no file with 47-30 or 47-31.
  - Wave 9: 47-30 (after 47-21: both edit `users.mjs` and the runbook index), 47-31 (after 47-20, whose expiry job it shares).
  - Wave 10: 47-33 (the off-site copy; after 47-20 for the shared image, 47-30 for the site files, 47-31 for OpenBao's apply).

  47-16 moves to wave 7 because its preflight and node files use 47-22's clock module. It applies 47-24's OpenSearch objects by name, since they share the wave. 47-18 moves to wave 8 so that its one lab run also proves the clock check, the notice, the escrow and the restore drill.
- **D-79 (revocation on disable; AC-2(3), AC-2(4), AC-12, IA-4):** When a person is disabled or removed in Keycloak, their OpenBao token and Theia session must not live on until the idle stop or the 8-hour renewal limit (Phase 46 D-22).
  - **The job.** A reconcile CronJob runs every `revocation.checkMinutes` (realm site file, default 2, refused outside 1 to 5). It compares Keycloak's users with OpenBao's person and guest entities and with Theia sessions, then:
    - disables the entity of every disabled or removed person, which stops every OpenBao token it holds at once (the entity-scoped revoke, as for guests, D-62);
    - stops their sessions, keeping their volumes.
  - **Why a poll.** It catches changes made while the job was not running. Admin events stay on for the audit trail.
  - **Safe reads.** A partial read never revokes anyone as removed: only a complete list plus a 404 for that person does.
  - **Shared with guest expiry (47-20).** The same image, the same shared functions (`lib/offboard.mjs`) and the same role pattern, with separate least-privilege credentials:
    - Keycloak `view-users` only;
    - OpenBao: list entity names, and set `disabled = [true]` on `keycloak-*` and `guest-*`;
    - Kubernetes: list and delete sessions in one namespace.
  - **Re-enabling.** Only an administrator re-enables, with `enrol.mjs reenable` or `rebind`, after the two-key check.
  - **Credentials (owner direction 2026-11-24, data-centric access: Keycloak authenticates only).** A Keycloak disable ends sign-in, not the verified credentials a person holds, which keep working at edges.
    - The job files one `sterling-revocation-request/1` at `kv/data/site/revocation-requests/<entity>-<reason>`, create-only, with `cas: 0`; the reasons are `keycloak-disabled` and `keycloak-removed`. This is exactly 71 D-22, which also covers 47-20's `guest-ended`.
    - 71-12's revocation card shows the request to the issuing officers, who revoke in their own step-up sessions. The issuer step-up role deletes the request when that person's credentials are revoked.
    - No script signs a status list.
    - **71-12:** decided in 71 D-22 on main; no open ask.
- **D-80 (owner decision a, 2026-11-24: separate keys):**
  - **Two keys.** The release key is the existing cosign key in GitHub `container-release`; it signs our images and releases only. Your organization's site key signs bundles, re-signed images, user exports, CSRs and CRLs.
  - **Where the site key lives.** It sits in an HSM. There is no HSM yet, so in development it lives in SoftHSM2 through the same PKCS#11 path; production swaps the real HSM in by configuration.
  - **Production refuses SoftHSM2.** As the OpenBao seal: 47-16's preflight rule `softhsm-seal-token`. As the site signing token: 48.1-17's rule `softhsm-signing-token`, added to the same preflight after 47-16 merges (H-12).
  - **Key ceremony and key backups.** The ceremony generates the site key in the token and backs it up by the HSM's own procedure (47-17). That key backup is recorded by digest only (47-25).
  - **Ownership.** 48.1-17 makes the signing change itself.
- **D-81 (owner decision d, 2026-11-24: off-site copy, 3-2-1, required):**
  - **What and where.** The encrypted backups and the write-once audit archive are copied to a write-once store at a second organization site daily, or by signed media from disconnected sites.
  - **Keys.** The keys that decrypt the backups travel separately, with the key custodians.
  - **Drill.** A quarterly restore drill runs from the off-site copy.
  - **Required.** The preflight refuses a site without an off-site target or media mode.
  - **Lab simulation.** The second site is simulated on this machine by the write-once S3-compatible store Phase 48.1 picks (not MinIO, AGPL); this plan references it and does not choose it.
  - **Plan.** 47-33.
- **D-82 (owner decision b, 2026-11-24: audit retention):** Every hosted audit record is kept 5 years (1,825 days), for ITAR.
  - OpenSearch keeps 730 days online, then the write-once archive keeps records to 1,825 days, with an object-lock retention of 1,825 days.
  - OpenSearch snapshots (47-24) and the off-site copy of the archive (47-33) keep 1,825 days.
- **D-83 (owner decision c, 2026-11-24: RTO and RPO):** RTO 8 hours and RPO 24 hours, shipped as `recovery.rtoMinutes: 480` and `recovery.rpoMinutes: 1440` in the site example (47-27). This is the single source for 48.1's system description.
</decisions>

<coverage>
## Coverage of the audit's gaps

| Gap item | Plan |
|---|---|
| Time: site requirement (on-site authoritative source) | 47-22 (site file notes), 47-17 (site-install.md) |
| Time: node chrony config as code | 47-22 (`chronyConf`, `writeClockFiles`), 47-16 (node-files writes them) |
| Time: preflight drift check that refuses beyond a limit | 47-22 (node `check-time.sh` in `install-node.sh`), 47-16 (preflight: settings and import host clock) |
| Time: runbook line | 47-17 (site-install.md), 47-28 (maintenance.md: re-check after reboot) |
| Time: tests | 47-22 (`time.test.mjs`), 47-16 (`install.test.mjs`) |
| Scan: Syft SBOMs and Grype scans in the bundle build | 47-29 |
| Scan: offline vulnerability database with the bundle, site rescans | 47-29 |
| Scan: per-bundle change and impact record | 47-29 |
| Scan: reuse the approved pins; register | 47-26, 47-29 |
| Contingency: priority order, degraded modes, record format, RTO 8 h and RPO 24 h | 47-17 (recovery-plan.md, backup-and-restore.md), 47-27 (`recovery.mjs`) |
| Off-site copy, required 3-2-1, daily, signed media for disconnected sites, quarterly drill | 47-33, 47-17 |
| Separate release and site keys; SoftHSM2 in development; production refuses SoftHSM2 | 47-17 (key ceremony), 47-25 (key backup records), 47-16 (`softhsm-seal-token`), 47-26 (register); the signing tool, the `softhsm-signing-token` rule and the owner's key script are 48.1-17 and 48.1-22 |
| Contingency: OpenSearch audit store restore | 47-24 (snapshots and tested restore), 47-27 (drill verify), 47-17 |
| Contingency: RKE2 token and encryption configuration safekeeping | 47-25, 47-17 (key-ceremony.md custody) |
| Contingency: `longhorn-crypto` escrow | 47-25 |
| Contingency: registry rebuild from the bundle | 47-17, 47-27 (`registry-input` verify) |
| Contingency: RTO and RPO as settings | 47-27 (`recovery.*`, `drill.mjs plan`) |
| Contingency: restore drill as code | 47-27, 47-18 (first lab drill) |
| Media: marking, custody, transport, approved media, sanitizing, malware decision, outbound, HQ transfer | 47-30 (runbook and checks) |
| Maintenance: OS patching and drain, RKE2 upgrade order, certificates, HSM firmware, patch timelines, upgrade checks | 47-28 |
| System use notice: site file and realm, default text, realm test | 47-23 |
| Revocation on disable: OpenBao tokens and Theia sessions ended within a site bound, shared with guest expiry, tests and a lab check | 47-31 |
| Every new resource has a passing register entry | 47-26 |
</coverage>

## For the owner to confirm

1. Gate approval of 47-26 (register entries; D-77).
2. `time.maxClockErrorMs` default 1000 ms (D-71, AU-8(1) organization-defined).
3. The audit-pipeline gate in the recovery order: people return only once auditing runs; historical audit data last (D-73).
4. Bundle scans report-only, the site change board decides; or block a bundle on a critical finding with a fix (D-72).
5. `personalDataMarking` level for user exports (no default shipped), the approved media list, and the malware-scan decision: your organization's scanning station at both ends, no engine in the bundle (D-74).
6. Patch timelines by severity (SI-2(c), D-75).
7. The default system use notice wording in English and French, after legal review (D-76).
8. Decided 2026-11-24: RTO 8 hours and RPO 24 hours (D-83). Still open: the off-site backup copies' lock period, `offsite.backupRetentionDays` (default 35, D-81).
9. Upgrade check defaults: backups no older than 24 hours before an upgrade, CA chain horizon 90 days (D-75).
10. Revocation bound `revocation.checkMinutes` default 2 (allowed 1 to 5); re-enabling a revoked person is an administrator step, never automatic; the shared job image (guest expiry, revocation, off-site copy) keeps the name `sterling/guest-expiry` unless you want it renamed (D-79, D-81).

## Status of 48.1's hand-off rows (for the coordinator to copy into `48.1-HANDOFFS.md`)

| Row | Status | Where |
|---|---|---|
| (a) Separate keys | planned | 47-17 key ceremony per H-05; 47-25 `record-key-backup` (never touches the owner's development token); 47-16 `softhsm-seal-token` only (the signing-token rule is 48.1-17's, H-12) |
| (b) Audit retention | planned | 47-24 snapshots: `maxAgeDays` 1,825, never shorter (render refuses less), `ignore_unavailable` so snapshots keep working with indices the archive job deletes; 47-33 locks archive copies for 1,825 days and its preflight refuses less |
| (c) RTO and RPO | planned | 47-27: `recovery.rtoMinutes: 480` and `recovery.rpoMinutes: 1440`, site-wide scalars applied to every recovery group, note records owner decision c; 48.1-13 reads the two numbers |
| (d) Off-site copy | planned | 47-33 (daily locked copy, signed media, keys separate, quarterly drill) on 48.1-20's `deploy/audit/lib/s3.mjs` and `deploy/lab/worm-site`; 47-17 runbooks |
| H-05 | planned | 47-17 Task 2 (`key-ceremony.md`): audit-archive key by `apply.mjs`, fingerprint, first-manifest anchor; site key in the production HSM with its PKCS#11 URI (no PIN) and `organizationPublicKey`; development by `new-dev-site-key.sh`; HSM backed up to a second HSM kept off site |
| H-06 | planned | 47-33 (copy, media, drill), 47-24 and 47-25 (sources), 47-17 (`backup-and-restore.md`, `recovery-plan.md`); the off-site target is 48.1-20's `deploy/lab/worm-site` in the lab |
| H-07 | planned | 47-27 site example (scalars, see (c)) |
| H-08 | planned | signals above: node-exporter timex (no change needed), `opensearch-snapshot-check` (47-24, added), `sterling-escrow-currency` (47-25 Task 3, added), job results of `openbao-raft-snapshot` and `sterling-offsite` |
| H-09 | decided | The Kubernetes auth mount already exists from 47-13 (cert-manager). 47-24 adds only `raft-snapshot`, 47-33 only `offsite-manifest`, and 48.1-14 only `audit-archive`; none re-creates the mount |
| H-10 | planned | 47-24 adds the repository, the policy and the check Job to `opensearch.yaml`, keeps 48.1-16's retention and `audit-archiver` changes on rebase, and its T-47-87 now cites the hosted audit store gap 48.1-01 files, not G2 |
| H-11 | decided | Register edits merge one after the other, each regenerating the catalogue with `node scripts/build-component-catalogue.mjs` and checking it with `--check` (H-01): 47-26, 47-20's `image:registry.access.redhat.com/ubi9/nodejs-22-minimal` entry (with `role` and `architectureArea`, required since #184), and 48.1's register edits |
| H-12 | decided | As written; 47-16 adds only `softhsm-seal-token` and leaves the problem list open for 48.1-17 |
| H-13 | planned | 47-17: `key-ceremony.md` and `moving-a-person.md` say exports, CSRs and CRLs are signed with the site key's PKCS#11 URI as `--key` |
| H-14 | planned | 47-22 (time for air-gapped sites) |
| H-15 | planned | 47-23 (system use notice) |
| H-16 | planned | 47-30 media runbook sections 8 and 9 |
| H-17 | planned (48.1's) | no action here |
| H-21 | planned | 47-17 points at `new-dev-site-key.sh` for development |

<canonical_refs>
## Canonical references

- `47-CONTEXT.md` (D-01 to D-57), `47-RESEARCH.md`, `47-PATTERNS.md`, `47-VALIDATION.md`
- `deploy/bundle/build.mjs`, `check.mjs`, `import.mjs`, `signed-file.mjs`, `lib/manifest.mjs`, `lib/render.mjs`; `deploy/rke2/install-node.sh`, `config.yaml`; `deploy/keycloak/apply.mjs`, `realm.json`; `deploy/values/opensearch.yaml`, `openbao.yaml`, `keycloakx.yaml`; `deploy/charts/sterling-storage`, `sterling-postgres`
- `compliance/ci/tool-pins.json`, `compliance/ci/TOOLS.md`, `compliance/resources.json`, `scripts/resource-check.mjs`
- docs.rke2.io datastore backup and restore page; Grype 0.122.1 and Keycloak 26.8.2 source (see Discovery above)
</canonical_refs>
