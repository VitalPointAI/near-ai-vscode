---
phase: 33-live-multi-user-staff-projects
plan: 27
status: complete
subsystem: Share with people in the Sterling workbench, hosted joining in the engine, the hub's join desk for session keys, re-admission, and the extension's guard in the image
tags: [workbench, staff, share, hosted, person-key, session-keys, hub, readmit, open-handler, d-10, d-13, d-21, d-42, d-58, d-60, d-61, d-64, mus-09]
requires: [33-03, 33-18, 33-21, 33-22, 33-23, 33-24, 33-31, 46-07]
provides: [StaffShareService, StaffShareServer, STAFF_SHARE_PATH, STAFF_SHARE_TEXT, ShareView, ShareWithPeopleSection, mountShareSection, InviteOpenHandler, readmitHub, readmitWordsMatch, buildInviteAsync, buildJoinRequestAsync, buildHubJoinAsync, buildGrantAsync, ReplicaProject.rosterSigner, ReplicaProject.signGrant, settled, ProjectRoster.actsForRosterWriter, StaffLiveEngine.shareContext, StaffLiveEngine.reopen, StaffLiveEngine.certificateOf, inSterlingWorkbench, SHOW_WORK_SECRET, showWorkOf]
affects: [33-25, 33-26, 33-29, 33-30, 33.1-17]
tech-stack:
  added: []
  patterns: [the device the roster names signs every roster-checked payload, an async builder beside each sync one, re-signing at the one grant store so the existing flows need no change, heavy browser modules loaded on first use so the staff frontend module stays light]
key-files:
  created:
    - workbench/extension/src/common/staff-share.ts
    - workbench/extension/src/node/staff/share-service.ts
    - workbench/extension/src/browser/staff/share-section.ts
    - workbench/extension/src/browser/staff/share-widget.ts
    - workbench/extension/src/browser/staff/invite-open-handler.ts
    - workbench/extension/src/browser/sterling-share.css
    - workbench/test/staff-share-service.test.ts
    - src/staff/replica/hubReadmit.ts
    - src/test/staffHubReadmit.test.ts
    - src/test/staffHostedJoin.test.ts
    - src/test/helpers/hostedWorld.ts
  modified:
    - workbench/extension/src/node/staff/share-part.ts
    - workbench/extension/src/browser/staff/share-part.ts
    - workbench/extension/src/browser/sterling-work-areas-module.ts
    - workbench/extension/src/node/staff/staff-live-engine.ts
    - workbench/tools/staff-engine-entry.ts
    - workbench/bin/start.mjs
    - src/domain/replica/invite.ts
    - src/domain/replica/cellKeys.ts
    - src/staff/replica/replicaProject.ts
    - src/staff/replica/membership.ts
    - src/staff/replica/hubMembership.ts
    - src/staff/replica/labelCells.ts
    - src/services/staffMultiUserCommands.ts
    - src/test/staffMultiUserCommands.test.ts
    - src/test/helpers/copyLintScan.ts
    - hub/src/append/rosterCache.ts
    - hub/src/join.ts
    - hub/test/sessionCertify.test.ts
    - compliance/gaps.json
    - compliance/test/gaps.test.ts
    - docs-site/content/security/road-to-production.md
key-decisions:
  - "In a hosted session the person key is the device the roster names, so it signs everything the roster or a joining computer checks against that device: the genesis and its founding grant, the X25519 binding, cell grants, invitations, join requests and hub join envelopes. The session key signs none of them; it signs ordinary entries, store marks and its session answers."
  - "ReplicaProject.putGrants signs again with the person key any grant the session key built (same payload, same signing time), so admit, hub grants and label-cell grants need no change. Founding grants, which entries commit to by hash, are signed by the person key before the hash is taken (signGrant)."
  - "The person key binds the session's X25519 key once per session in the share service; the live engine still opens projects with an empty binding, which opening does not read."
  - "A project opened again in the same session (reopen) keeps its one session.certify: your organization's server knows the session key by that certificate, and a second one made the server refuse the session."
  - "The hub's join desk (invitation registration, the join-request list and event) takes a standing session key certified by a lead or deputy device as that device. Roster kinds stay the person key's (D-60)."
  - "The section mounts through the one line in sterling-work-areas-module.ts on the Planning and Exercises & Training pages: no 32.1 section registry existed. An invitation file opens the same section on a page of its own."
  - "Person-key signatures go through the session's personSigner under 33-23's step-up window. 33.1-17's action-bound step-up is on the Phase 33.1 branch, not this base; its rule keeps Phase 33's kinds on 33-23's behaviour, and adopting action ids for Share with people is G440."
requirements: [MUS-09]
requirements-completed: []
actuals:
  tokens: 47000
  tasks: 3
  commits: 6
completed: 2026-11-24
---

# Phase 33 Plan 27: Share with people Summary

A person in SovAI can now share a staff project and bring a colleague in, both in hosted sessions. The lead turns sharing on from the work-area page, connects your organization's server from its hub file and invites. The colleague opens the invitation file, which opens the join flow already filled in. The lead compares the six words and admits them, and the colleague opens the welcome file and goes live. Every signature the roster checks is made by a person key, through a passkey confirmation; no session key ever signs one. The same section grants a part to the server (after showing the trade-off word for word), removes the server, changes its address, trusts it again after comparing twelve words, makes a single-machine copy and turns "Show others what I am working on" on or off. In the image, the VS Code extension registers none of its multi-user preview commands.

## Base and branch

- `feat/phase-33-wave-27-28` from `2353811b` (head of `feat/phase-33-engine-wave-1` after 33-24 and 33-31).
- `origin/main` (#197: `KeyService.personPublicKey()`, #198) was merged at `10f936cd`, with no conflicts.
- 33-28 is on the same branch (see its summary). `plan_head_before` for both plans is `10f936cd`.

Step 0, each as the plan expects:
- `export function conversionNoticeLines` in conversionNotice.ts: 1
- `export function ensureRequireArmed` in requireGate.ts: 1
- `bindSharePart` in node/staff/share-part.ts: 1
- `sterling-work-areas-module.ts` exists

## The three pieces 33-24 left

1. **The person key's signature over the encryption key.** `StaffShareService.depsWithBinding` signs `x25519BindingBytes(x25519, personWriter)` through the session's `personSigner`, once per session, before the conversion or a join. The genesis carries it as the lead device's `x25519Sig`. A joining person's request signs its own binding in `buildJoinRequestAsync`.
2. **The hub address of a project joined in a session.** `openInvitation` writes `hub.json` for the invitation's project from its hub field (address, and the hub id from its writer), before the request is sent. Once the welcome is opened, the engine connects to that address. The real-hub tracer checks it.
3. **Grants signed by the person key.** The engine's `ReplicaProject` now has `rosterSigner`, which is the person key in a hosted session and this device's key otherwise. Founding grants and the genesis are signed by it (`signGrant`, `buildEntryAsync`). `putGrants` signs again any grant the session key built. Invitations and hub join envelopes use the new async builders.

## What was built

- **Engine (root `src/`).**
  - Async builders: `buildInviteAsync`, `buildJoinRequestAsync`, `buildHubJoinAsync`, `buildGrantAsync`. Each makes the same payload as its sync twin, which now shares the payload code.
  - `settled()`: a person-key refusal becomes a `ReplicaProjectError` with reason `signer-refused` and the key store's sentence. The guarded flows return it as a plain result.
  - Hosted `createSharedProject`: the genesis is signed by the person key and stored through `ingestForeign`.
  - `readmitHub` (hubReadmit.ts): compares the twelve words in order, then writes one `hub.readmit` with the compared pin.
- **Hub.** `ProjectRoster.actsForRosterWriter` lets a lead's certified session key use the join desk.
- **Workbench backend.**
  - `StaffShareService` at `/services/sterling-staff-share`, over the live engine. It uses the new `shareContext()`, `reopen(root)` and `certificateOf(id)`, and `syncNow` after every lead action.
  - Engine bundle: one new block in `staff-engine-entry.ts`, typed by `StaffShareApi`. The workbench lint checks the entry against it.
- **Workbench browser.**
  - `ShareWithPeopleSection`: plain DOM, lifted cards, Theia variables, codicons.
  - It is mounted on the Planning and Exercises & Training work-area pages.
  - An invitation file opens it on a page of its own through `InviteOpenHandler`.
- **Extension.** `inSterlingWorkbench()` makes `registerStaffMultiUserCommands` register nothing in the image. `workbench/bin/start.mjs` sets `STERLING_WORKBENCH=1`.

## Deviations from Plan

1. **[Rule 3] Engine changes outside the plan's file list.** Hosted joining needs the person key at every place the roster checks the device, so these files changed:
   - `invite.ts` and `cellKeys.ts` (async builders);
   - `replicaProject.ts`, now at exactly 1,200 lines, its limit;
   - call sites in `membership.ts`, kept line-neutral because the file is frozen at 1,537 lines;
   - call sites in `hubMembership.ts` and `labelCells.ts`.
2. **[Rule 1] The hub refused a hosted lead's own invitation registration as forbidden.** The join desk checked the session key as a roster writer. It now takes the certified lead device (`hub/src/append/rosterCache.ts`, `hub/src/join.ts`), with one hub test.
3. **[Rule 1] A reopened project made a second certificate, and the server refused the session.** `StaffLiveEngine` now keeps one certificate per project per session.
4. **[Rule 3] Shared files touched, kept minimal.**
   - `workbench/extension/src/node/staff/staff-live-engine.ts` (33-24): `shareContext`, `reopen`, `certificateOf` and the certificate cache, about 30 lines.
   - `workbench/tools/staff-engine-entry.ts`: one block at the end, which may conflict with 33-25 and 33-26 appends.
   - `src/staff/replica/labelCells.ts`: one call site.
   - `src/test/helpers/copyLintScan.ts`: one allowed-context row, for the trade-off sentence shown word for word, which says "hub".
5. **Section file.** The plan names `share-section.tsx`. The work-area page is plain DOM and the extension has no JSX setting, so it is `share-section.ts`, with `share-widget.ts` and `sterling-share.css`. The extension build copies only CSS that sits directly in `src/browser`, which is why the stylesheet is there.
6. **Staff Room actions are not added here.** The Staff Room is 33-26's. The share service is its backend, so 33-26 or 33-29 adds the buttons.
7. **"Both see each other's text"** is checked as each person's view of the roster (people, and the joiner's certified session key) through the engine. Product text over the hosted path is left to 33-30's scenario.
8. **Flat workbench test.** It is `workbench/test/staff-share-service.test.ts`, as the coordinator asked.
9. **The gap count in `compliance/test/gaps.test.ts` was already red at the base.** It expected 391 while 392 gaps existed (G416 from 33-24). It now expects 394, after G440 and G441. `docs-site/content/security/road-to-production.md` was regenerated.
10. **Tests first:** the tests were written with the code, before the first run. The first runs failed on:
    - the hosted genesis held by the decode check;
    - the hub's forbidden join desk;
    - the second certificate;
    - a CSS path the build does not copy;
    - an eager browser import in the module test.

## Verification

All runs used the shared heavy lock, MemoryMax=6G, MemorySwapMax=0 and choom, on Node 26.13.1 with `NEAR_AI_HUB_NODE` set.

| Run | Result |
|-----|--------|
| `npm --prefix workbench run build`, `npm --prefix workbench test`, `npm --prefix workbench run lint` (final) | build ok; **175 tests: 175 passed, 0 failed, 0 skipped**, including the bundle scan (T-33-N11) over the browser bundle with the share section; lint exit 0 |
| Root: copyLint, architecture and 29 staff and replica suites (the hosted, hub-membership, migration, copy, live and real-hub ones included) | **557 tests: 557 passed, 0 failed, 0 skipped** |
| Root `npm run lint` | exit 0 |
| `npm --prefix hub test` | **448 tests: 445 passed, 0 failed, 3 skipped** (the hub suite's own skips) |
| `compliance` gaps test; `build-road-to-production.mjs --check` | 19 passed; matches |

- `share-service` tests: 10 (plan: at least 9), one of them against a real hub child (D-46 skip rule).
- `staffHubReadmit` tests: 5 (plan: at least 3).
- New `staffMultiUserCommands` tests: 2 (plan: at least 2).
- `grep -c "STERLING_WORKBENCH" src/services/staffMultiUserCommands.ts` gives 2.
- **Tests added: 21.** Workbench 10; root `staffHubReadmit` 5, `staffHostedJoin` 3 and `staffMultiUserCommands` 2; hub 1. **Tests changed: 1** (the gap count).

## Threat model

| Threat | As built |
|---|---|
| T-33-N17 | Admission needs the lead's confirmation that the six words matched; a false `codeMatched` admits nobody (tracer). Joins go through the executed Phase 31 and 32 checks. |
| T-33-N18 | `readmitHub` writes nothing unless the typed words are the pin's twelve words in order; tested with another pin's words and the reversed order. |
| T-33-N15 | The extension registers no preview command in the image (test); only the native engine binds. |
| T-33-N9 | Every roster kind, grant, invitation, join request and `hub.readmit` is signed by the person key through `KeyService.sign`. A stale confirmation signs nothing and returns the Staff Room sentence and its fix (tests in root and workbench). Action-bound step-up is G440. |
| T-33-SC | No package was installed. |

## Gate files

None. The plan touched no `.github/`, `SECURITY.md`, `scripts/lib/` or release verification file. The hub change is in `hub/src` and `hub/test`.

## Known Stubs

None. The section's "Open a join request file" admits from a file when the server is not connected, as Phase 31 did.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: new RPC path | workbench/extension/src/node/staff/share-service.ts | `/services/sterling-staff-share`: the person's Share with people actions. The browser sends typed text and files and receives sentences, safety words and files; no key or token. |
| threat_flag: session key at the join desk | hub/src/append/rosterCache.ts, hub/src/join.ts | A standing session key certified by a lead or deputy device may register invitations and read join requests for that device. |
| threat_flag: open handler | workbench/extension/src/browser/staff/invite-open-handler.ts | A `.near-staff-invite` file from outside opens the join flow. At most 256 KiB is read; the backend checks the whole invitation. |

## Open conditions

- **G440:** Share with people's person-key signatures are not yet bound to one confirmed action. When 33.1-17 is merged with Phase 33, begin and resume one pending action per Share with people action.
- **G441:** a conversion from SovAI accepts any key that signed the legacy staff ledgers. The workbench backend cannot read the extension's key history.

## Hand-offs

These are work for other plans, not compliance conditions.

- **The Staff Room's Share with people actions** (D-58) are for 33-26 or 33-29, over `StaffShareServer`.
- **Engine sentences.** The engine's Phase 31 and 32 result sentences still say "project", "hub" and "staff lead". The D-69 folder words for the Defence edition come with 32.1's `folderNoun` and 33-26's copy-lint extension.
- **Shared-file merges.** `staff-engine-entry.ts` and `staff-live-engine.ts` need a merge with 33-25 and 33-26. `replicaProject.ts` is at its 1,200-line limit.

## Self-Check: PASSED

- The created files exist. The plan's commits (`5231f498`, `01ef4bf5`, `13db31ba`, `f339a072` and the workbench commit) are in HEAD.
