---
phase: 32-your-organizations-sync-hub
plan: 28
subsystem: docs and close-out (operator guide, SECURITY.md, CHANGELOG, planning records)
status: complete
tags: [hub, operator, docs, security, changelog, close-out, D-29, D-30, D-31, D-41, D-45, D-55, D-56, D-57, D-62, MUS-07, MUS-08]
requires: [32-13, 32-17, 32-26, 32-27]
provides:
  - "relay/README.md: ## Your organization's sync hub (certificates and pins, secret files, Compose, hub file and enrolment, health and logs, backups, restore with the honest-restore limit, restore drill, upgrades, key changes, what the hub can read)"
  - "hub/README.md: what the hub is, with links to the operator guide and SECURITY.md"
  - "SECURITY.md: ## Your organization's sync hub, each point naming its test"
  - "CHANGELOG.md: five hub bullets under Unreleased, Military staff teams"
  - ".planning/ROADMAP.md and .planning/REQUIREMENTS.md: Phase 32 28/28 complete, MUS-07 and MUS-08 done"
affects: [Phase 33 (re-admitting a hub, editor commands, README text for multi-user projects)]
tech-stack:
  added: []
  patterns:
    - "operator commands run as written in a scratch repository root and against a real Compose project with a unique project name and image tag"
    - "state copied by the image's own Node (fs.cpSync) as user 65532, since the distroless image has no shell or tar"
key-files:
  created:
    - hub/README.md
  modified:
    - relay/README.md
    - SECURITY.md
    - CHANGELOG.md
    - .planning/ROADMAP.md
    - .planning/REQUIREMENTS.md
decisions:
  - "Compose variables live in relay/secrets/hub.env (ignored by git) and every command passes --env-file, so a later up never falls back to 127.0.0.1 or an empty public address because a shell lost its exports"
  - "Backup and restore copy the hub-state volume with the hub image's own Node as user 65532 (no extra image pulled, ownership stays 65532); the restore empties the volume and copies the backup in, after the operator saves the current state too"
  - "The hub file command runs under umask 077 like the key commands, because the file holds the one-time enrolment secret"
  - "The restore drill is written for when members can connect from the editor; until then the operator practises the backup and restore commands on a hub with no projects, and the hub suite runs the drill on every change"
  - "SECURITY.md also states the 32-26 finding that clients do not recompute a checkpoint's order from entries, so a hub that reorders a prefix while changing the count is not caught by that check"
  - "Full extension suite and end-to-end suite not run here: the executor brief reserves them for the orchestrator (see Deviations)"
  - "Defaults of 32-CONTEXT.md taken as accepted; the plan had no checkpoint. Tracer gate: Task 1's verify (hub build, heading count, the three flags) re-run and green before Task 2"
metrics:
  duration: "about 75 minutes"
  completed: 2026-11-20
estimate:
  tokens: 70000
  tasks: 3
actuals:
  tokens: 11000
  tasks: 3
  commits: 3
plan_head_before: 8e278819d06301e06033b3da21a48230a2bb556f
plan_head_after: 9d6f89a0931d67c741ee8a75853a472c4b88d9a4
---

# Phase 32 Plan 28: Operator guide, SECURITY.md, CHANGELOG and close-out Summary

An operator can now stand up, enrol, back up and restore your organization's sync hub from `relay/README.md` alone, with every command run as written; SECURITY.md says what the hub holds, reads and cannot do, each point with its test, including the honest-restore limit from 32-26; the CHANGELOG says the hub exists for operators and is not usable from the editor yet; and the roadmap and requirements mark Phase 32 complete.

## What was written

**relay/README.md**, new last section "Your organization's sync hub" (and one pointer sentence in the intro):
- What the hub is and never does (no model credential, no outbound calls, no tools, admits nobody); what you need.
- Certificates and pins: the openssl command for a self-signed EC P-256 certificate with a subjectAltName, the pin pipeline (sha256 of the DER SubjectPublicKeyInfo, 64 hex), a same-key renewal, a CSR for your organization's CA; a new key means revoke and admit again.
- Secret files: the four names, what each is, `--generate-key signing|encryption` through the image (or `node hub/dist/bin.mjs` from a checkout), `sudo chown 65532:65532` and `chmod 0400`, kept out of the state volume and backups.
- Running with Compose under `--profile hub` with `relay/secrets/hub.env`; the variable table (`NEAR_AI_HUB_PUBLIC_ADDRESS` with its required port, `NEAR_AI_HUB_PUBLISH_ADDRESS` default 127.0.0.1, `NEAR_AI_HUB_PUBLISH_PORT`, `NEAR_AI_HUB_SECRETS_DIR`, `NEAR_AI_HUB_IMAGE`); TCP pass-through only, and that per-address limits then apply to everyone behind the proxy.
- The hub file: `exec -T hub /nodejs/bin/node /app/bin.mjs --hub-file 7`, 1 to 30 days, one project per file, give it privately, the hub keeps only the secret's hash and derives the secret from its encryption key and the enrolment id (32-19), so a changed encryption key refuses older hub files.
- Health and the log events (hub.listening, hub.start_refused with its reason words, store.damaged, store.recovered, checkpoint.signed, waiting, conflict, trimmed, too_large, failed, invite.locked).
- Backups (stop, copy the volume as 65532 with the image's Node, start), restoring (the procedure that avoids the honest-restore fork: members sync and make no new changes, save current state, restore, watch checkpoint.waiting and checkpoint.signed, the staff lead confirms every device synced), what to do when a device still names the hub forked (work by file or another hub until the staff lead re-admits it, a later-release flow), the order-mismatch conflict that heals on a later hand-back (32-26 amendment of 32-22), and the checkpoint-nobody-received gap.
- The restore drill, upgrades (schema version 1, a newer store refused by an older hub), changing a key or the certificate (`up -d --force-recreate`), and what the hub can read with the trade-off sentence.

**hub/README.md**: three sentences and links to the guide and SECURITY.md.

**SECURITY.md**, "Your organization's sync hub" after "Messaging relay (foundation)": what it stores and reads (roster with names, seats and declared clearances; only granted parts, with the trade-off sentence word for word on one line; ciphertext otherwise), metadata, what it cannot do and what clients do (withhold, delay, roll back, fork, inject, corrupt, wrong project), three limits (honest restore can look like a fork; a checkpoint nobody received; reordered history with a changed count), checkpoint coverage, TLS and pins, sessions bound to the connection, joining without the join secret, enrolment, no outbound connection, limits, keys, hardening and release. Every point names its test (hub/test: hubStore, killDrill, join, presence, append, enrol, ciphertextOnly, checkpoints, maliciousHub, restoreDrill, tlsServer, session, events, api, noOutbound, limits, secrets, keys, stateDir, logging, container, dockerContext; src/test: staffReplicaHubMembership, staffHubTransport, replicaHubWitness, replicaHubFile, hubIsolation).

**CHANGELOG.md**: five bullets after 32-13's under "## Unreleased / ### Military staff teams": the hub exists, it reads only the member list and granted parts, clients notice a misbehaving hub, the operator guide, not usable from the editor yet.

## Commands run as written

Local, in a scratch repository root, against `hub/dist/bin.mjs` built in this worktree:

| Command | Result |
| --- | --- |
| openssl self-signed EC P-256 certificate | key and certificate written, key mode 600 |
| pin pipeline | 64 hex characters |
| same-key renewal, then the pin pipeline again | same pin; the certificate itself differs |
| CSR from the same key | self-signature verifies |
| `--generate-key signing` and `encryption` under umask 077 | one line each, mode 600, the right prefixes, 43-character seeds |
| `--hub-file 7` with the four secret files and HUB_PUBLIC_ADDRESS | one line, 876 bytes |
| the printed file through `readHubFile` (32-15, bundled from src) | ok; address hub.example.test:8443; certPin equals the openssl pin; expires in 7 days; read 8 days later: expired |
| `--hub-file 7` without a public address; `--hub-file 31` | exit 1, one hub.start_refused line each |

Docker, through `relay/compose.yaml` with `-p p32-28-docs`, image tag `near-ai-hub:p32-28-docs`, a free port on 127.0.0.1 and the secrets in scratch (the only changes from the README text; `sudo chown` was done as root through the pinned build image, as the container suite does):

| Step | Result |
| --- | --- |
| `--profile hub build hub`, `docker run --rm --network none <image> /app/bin.mjs --generate-key ...` | one key line each |
| `config` | port 127.0.0.1 only, HUB_PUBLIC_ADDRESS passed, volume hub-state |
| `up -d hub` | healthy in 5 s; hub.listening logged |
| `exec -T hub /nodejs/bin/node /app/bin.mjs --hub-file 7` | read by readHubFile, pin equal to the openssl pin |
| backup (stop, mkdir 0700, chown, Node cpSync as 65532, start) | backup holds hub.db (600) and blobs/ (700), owned by 65532; hub healthy again |
| restore (stop, empty the volume and copy the backup in, start) | healthy; no start refusal or damage line |
| `up -d --force-recreate hub`, `up -d --build hub` | healthy each time |

Everything the run made (containers, volume, image) was removed afterwards; the pinned `node:26.13.1-slim` base image it pulled by digest stays in the local Docker cache.

## Final runs (D-57), one at a time in the shared lock

| Run | Result |
| --- | --- |
| `npm run lint` and `cd hub && npm run lint` | both exit 0 |
| hub suite (`npm test`, `NEAR_AI_HUB_OLD_NODE` set, 6G cap) | **366 tests, 366 pass, 0 fail, 0 skipped** |
| hub container suite (`npm run test:container`, Docker present) | **11 tests, 11 pass** |
| `npm run verify:release` | exit 0; "Release content verified: 3054 entries (13.39 MiB), 527 runtime JavaScript files, and 69 required release assets."; nothing from `hub/` in the listing |
| `npm run smoke:staff` | exit 0; 38 checks passed |
| doc-reading extension tests (changelogSections, gateDocs, staffReplicaLabelLeak, staffReplicaStore, staffReplicaMembership, replicaCellLeak) | 134 tests, 134 pass |

Acceptance greps: heading count 1 in relay/README.md and in SECURITY.md; `--profile hub`, `--generate-key`, `--hub-file` present; ciphertextOnly, noOutbound, maliciousHub, restoreDrill and join.test in SECURITY.md; the trade-off sentence once; em-dashes relay/README.md 0, hub/README.md 0, SECURITY.md 0, CHANGELOG.md 3 (unchanged); `- [x] **MUS-07**` 1 and `- [x] **MUS-08**` 1; `| 32. Your organization's sync hub | 28/28 |` 1.

### Failing first and teeth (D-66)

This plan writes documents; the checks are the acceptance greps, which were 0 (or missing) at HEAD and are now as expected. Teeth of the grep guards as the plan states them: an em-dash typed into a new section makes the em-dash count non-zero, and the trade-off grep caught a real defect on its first run (the sentence was wrapped across two lines, count 0), fixed by putting it on one line. The document tests that read SECURITY.md and CHANGELOG.md (gateDocs, changelogSections, staffReplicaLabelLeak, staffReplicaStore) pass with the new sections.

## Deviations from Plan

1. **[Brief over plan] Full extension suite and end-to-end suite not run here.** The executor brief says not to run the full `npm test` or the end-to-end suite because the orchestrator runs full suites at the phase boundary. Those two stay for the orchestrator. The relay suite was not run either: `relay/node_modules` is not installed in this worktree, the brief authorizes installing only the hub's tooling, and this plan changed only `relay/README.md` (32-17 ran the relay container suite after its compose change: 10/10).
2. **[Rule 2 - Correctness] umask 077 on the hub file command.** Found while running it: the printed file came out mode 664 and holds the enrolment secret. The command now matches the key commands.
3. **[Rule 2 - Correctness] Backup and restore commands that work with a shell-less image.** The plan says "copy the state volume"; the image has no shell or tar, and a host-side copy would change the owner away from 65532 (which the hub refuses). The commands copy with the image's own Node as 65532; both were run.
4. **[Plan wording] The restore drill depends on the editor.** Members cannot connect a project to the hub until a later release, so the drill is written for then, with what an operator can practise now.
5. **[Plan wording] Plans count.** The ROADMAP already said 28 plans in 14 waves; only the plan lines and the progress row changed.

Files touched outside the plan's list: none.

## Owner actions

- After the phase merges, add `hub` to main's required status checks (D-32; the section 8 command in the workflow page already includes it).
- Confirm the 32-CONTEXT defaults taken by every Phase 32 plan.
- Decide the longer-term fix for the honest-restore limit (32-26): a restore mode in which the restored hub signs nothing until the staff lead confirms every device synced, or re-admission with a fresh witness (Phase 33), and how clients could receive the checkpoints a newer one nests after so the checkpoint-nobody-received gap closes. Until then the operator guide's procedure avoids it.
- Checkpoint coverage (32-22, D-63): the hub checkpoints only the base part and parts granted to it; the clients' own records cover the rest, and delayed applies only to covered parts. SECURITY.md states this.
- The integration PR touches gate paths from 32-17 (ci.yml, scripts/lib/workflow.mjs, verify-release-content.mjs): it waits on the owner's gate approval.

## Known Stubs

None. The documents describe only what is built; the editor commands and re-admission are named as a later release.

## Threat Flags

None beyond the register: T-32-114 (the 127.0.0.1 default and how to choose an address are stated), T-32-115 (key files outside the volume and apart from backups; restore drill checks the backup), T-32-116 (every SECURITY.md point names its test), T-32-SC (no package installed; `npm ci --ignore-scripts` in hub/ restored the pinned dev tooling, gitignored).

## Self-Check: PASSED

- FOUND: relay/README.md, hub/README.md, SECURITY.md, CHANGELOG.md, .planning/ROADMAP.md, .planning/REQUIREMENTS.md
- FOUND commits: 19c19430, 53c0727d, 9d6f89a0 (ancestors of HEAD on feat/phase-32-28-operator-docs-closeout)
