---
phase: "62"
slug: "work-model-gsd-import-team-board-live-read-and-move"
status: verified
# threats_open = count of OPEN threats at or above workflow.security_block_on severity (the blocking gate)
threats_open: 0
asvs_level: 1
created: "2026-11-02"
---

# Phase 62 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| Member's client to coordination log | Any member, or a hostile client, can try to write an item event | item.* events (create, edit, estimate, move, imported) |
| Coordination log to every client | Every client re-checks every item event at its log position | Signed item events, rejected events with reasons |
| Integration branch on the remote to importer | Anyone who can push to the integration branch controls every byte the importer and parser read | `.planning` tree, plan frontmatter, roadmap text |
| Member's local repository to importer | Unpushed work must never cross into the shared board | Local draft commits (must stay invisible) |
| Integration branch files to coordination log | Plan text written by anyone with push access becomes signed metadata | Titles, ids, globs, requirement ids, estimates, waves, tags, truths |
| Lead's client to coordination log | Two leads may import from different fetch states at the same time | item.imported batches, recorded import source |
| Snapshot file on the branch to client | A snapshot is untrusted input that only shortens replay | Work items, state hash |
| Remote to session | Polls bring other members' events; the remote may be slow or unreachable | Coordination branch commits |
| Session to status bar | Team names and NEAR labels are untrusted display text | Display names, labels |
| Webview page to extension host | The page may be buggy or compromised; every message is untrusted | move, edit-item, new-item, import-plans, retry requests |
| Extension host to webview page | Model text comes from teammates and branch files | Board model, card detail, history sentences |
| Other applications and editors to board page | Anything can be dragged onto the webview | Drag data (text, files, board card type) |
| Extension host tests to extension internals | The e2e test seam exposes the team handle and SecretStorage | Team handle, SecretStorage, storage directory |
| Packaged extension to users | Missing or altered assets would break the board for everyone | `media/board/*` assets |

---

## Threat Register

Extracted from the `<threat_model>` tables of 62-01 to 62-14 (T-62-SC appears in every plan and is listed once). All 14 SUMMARY `## Threat Flags` sections say "None". T-62-46 to T-62-49 were found while verifying mitigations in the 2026-11-02 audit (gsd-security-auditor, ASVS L1, block on high). The auditor ran 19 focused compiled suites (item events, forgery, import source, privacy canary, board assets, moves, GSD import, board view, items, client, drag, detail, menu, form, live, session import, solo parity, snapshot, import): 320 tests, all pass. Paths below are relative to `src/services/team/`, `src/domain/team/` or `media/board/` as named.

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-62-01 | Elevation of privilege | item.* authors | high | mitigate | `item.move` row is owner and lead only (`permissions.ts`); `actionForEvent` maps hold or state changes to item.move and the rest to edit/estimate with `isOwnDraft`; `decideTeamAction` on write (`prepareEvents`) and read (`authorisationProblem`). Tests: teamItemEvents permission and move rows | closed |
| T-62-02 | Tampering | illegal transitions, claim states | high | mitigate | `referenceProblem` calls `transitionProblem`; `state` may only be `done`; hold or state never travels with another key; item.imported state limited to backlog or done. Test: "no item event can store a claim or integration state" | closed |
| T-62-03 | Tampering | hostile bodies (extra keys, prototype keys, huge lists) | medium | mitigate | Exact-key `checkKeys` on every item body, list caps, 16 KB `MAX_EVENT_BYTES` on write and read, stored copies built key by key (no spread). Tests: "body validation: an extra key names the key", frozen canonical bodies | closed |
| T-62-04 | Information disclosure | secret-like text in item fields | high | mitigate | `prepareEvents` runs `assertNoSecrets(intent.body)` first for every intent, before permission and signing (`eventLog.ts`) | closed |
| T-62-05 | Information disclosure | unpushed local drafts | high | mitigate | Fetch `+refs/heads/<branch>:refs/near-ai/integration/<branch>` with `--no-write-fetch-head`; `resolveRef` reads only that private ref; fetch failure has no local fallback. Test: "the integration branch is read from a private ref and an unpushed local draft stays invisible" | closed |
| T-62-06 | Information disclosure | remote URL credentials in git errors | high | mitigate | `redactGitMessage` via `mustSucceed`, `failureDetail`, `safeMessage` and `importResultText`. Tests: teamImportSource canary password `canary-secret-62` | closed |
| T-62-07 | Denial of service | huge blobs or trees on the branch | medium | mitigate | 256 KB per file, 2000 paths, 8 MB total (`integrationSource.ts`); sizes read with batch-check before any blob; symlinks never opened. Test: "a plan file over the size cap is listed as oversize and never read". Residual: T-62-47 | closed |
| T-62-08 | Tampering | hostile path names in the tree | medium | mitigate | `ls-tree -r -z`; paths are data only and never opened; ref and remote names pass `isGitRefName` (no leading `-`, whitespace or `:`). Tests: "a branch name git would refuse never reaches git", space and newline path test | closed |
| T-62-09 | Denial of service | frontmatter and roadmap scanning | medium | mitigate | Caps in `gsdImport.ts` (400 frontmatter lines, 4000 chars per line, 64 list entries, 50 tasks, 2000 plans, 20k roadmap lines); linear scans. Tests: 1 MB hostile frontmatter under 1 s, unclosed task tags and milestone bullet flood | closed |
| T-62-10 | Tampering | prototype keys in frontmatter | medium | mitigate | `KNOWN_KEYS` allow-list, unknown keys and children skipped, locals/Sets/Maps only. Pollution test (`__proto__`, `constructor.prototype`) leaves `Object.prototype` clean | closed |
| T-62-11 | Tampering | snapshot with forged or malformed items | high | mitigate | Strict `parseWorkItem` (exact keys, shared validators, origin rules), `stateHash` and head check, result `provisional: true`, signer must be owner or lead; `parseSnapshotFile` has no production caller, so the board replays from genesis. Tests: teamItemSnapshot malformed-item and empty-claims tests | closed |
| T-62-12 | Tampering | forged item events | high | mitigate | `applyEntry` rejects before mutation. Test: teamItemForgery "forged item events written straight to the coordination branch are rejected with their reasons on both clones and change no state" (developer hold, observer create, duplicate id, missing parent, bad reopen, revoked device, tampered signature, unknown key) | closed |
| T-62-13 | Denial of service | unbounded card history | low | mitigate | 50 entries per item (`itemHistory.ts`), accepted item events only, in memory and outside `TeamState`. Test: "history stops at the latest 50 changes and says so" | closed |
| T-62-14 | Information disclosure | secret-like plan strings | high | mitigate | `safeText` runs `findSecrets` per cleaned field and substitutes `WITHHELD_TEXT`; `safeScope`/`safeTag`; final `findSecrets(fitted.body)` guard. Tests: per-field cleaning, teamItemPrivacy canary withholds exactly 3 strings | closed |
| T-62-15 | Information disclosure | plan bodies in the log | high | mitigate | `graphToItems` writes only titles, ids, globs, requirement ids, estimate, wave, tags and truths. Test: teamItemPrivacy scans every coordination blob, the mirror, `import.json` and `team.json` for objective, context, action and secret canaries, with a positive control on the code branch | closed |
| T-62-16 | Denial of service | flapping imports and log spam | medium | mitigate | `diffImport` no-op on no change, source recorded only with real changes, `isAncestor` stale guard, 250 intents per append and 20 rounds. Tests: older-commit import, unchanged tree skip, 600 items in three appends | closed |
| T-62-17 | Tampering / Denial of service | hostile or oversized branch content | medium | mitigate | `fitItemBody` with worst-case envelope, `validateBody('item.imported')` before the intent, bad id skipped with a warning, read side re-validates via `parseEventFile`. Tests: shrink-to-fit, over-cap plans imported trimmed | closed |
| T-62-18 | Elevation of privilege | non-lead import | high | mitigate | item.imported maps to item.create with `ownDraft: false`; `prepareEvents` refuses; `importPlans` fails fast before any fetch. Test: "a developer cannot import: the result carries the permission reason and nothing is written" | closed |
| T-62-19 | Elevation of privilege | moves offered to a role that may not make them | high | mitigate | `planMove` calls `moveDenial` (`decideTeamAction(item.move)`) first; `availableMoves` lists only moves `planMove` accepts. Test: teamBoardMoves full state-by-viewer table | closed |
| T-62-20 | Spoofing | stale move from an old model | medium | mitigate | `planMove` is pure and re-run inside `log.append` (`boardView.ts`); `staleRefusal` names who changed the card. Tests: two members move the same card in one poll window; card changed while prompt open | closed |
| T-62-21 | Tampering | hostile names and reasons in the model | medium | mitigate | `flattenName` strips control characters, collapses whitespace, bounds length; used for every name in `board.ts`. Test: newline and 200-char name becomes one bounded line | closed |
| T-62-22 | Information disclosure | secret-like block or cancel reason | high | mitigate | `cleanReason` in `planMove` refuses a `findSecrets` hit before any intent; `assertNoSecrets` on write. Tests: teamBoardMoves reason rules, teamBoardView key-like reason refused | closed |
| T-62-23 | Denial of service | polling while the board is visible | low | mitigate | Visible board only changes the existing scheduler's focused interval; 5 s floor, 10 minute backoff; auto check at most once a minute. Test: "a visible board keeps the focused poll interval ... creates no timer of its own" | closed |
| T-62-24 | Elevation of privilege | automatic import by a non-lead window | high | mitigate | Owner/lead gate first in `checkIntegration`, before roadmap stat and `remoteBranchHead`; repeated in `importPlans`; log refuses item.imported from other roles. Test: teamSessionImport "a developer, a window with no device key ... never ask the remote" | closed |
| T-62-25 | Tampering | status bar icon injection | low | mitigate | `displayText` flattens, redacts and escapes `$(`; tooltip is a plain string. Test: team name that looks like an icon shown as typed | closed |
| T-62-26 | Information disclosure | board viewing recorded as presence | medium | mitigate | `boardVisible` is a private in-memory boolean feeding the scheduler only; no event type for viewing. Test checks output channel, storage folder and remote for any record | closed |
| T-62-27 | Spoofing / Elevation of privilege | page messages claiming moves, roles or ids | high | mitigate | `parseBoardMessage` exact keys, id patterns, move enum, caps; three plannings, the last inside `append`; role from `session.memberId()` and the log only. Test: "hostile messages from a page are ignored or refused and never reach the log" | closed |
| T-62-28 | Tampering | script injection into the webview | high | mitigate | CSP `default-src 'none'; style-src <cspSource>; script-src 'nonce-<n>'`, 16-byte random nonce per HTML, `localResourceRoots: [media/board]`. Test: one nonce CSP, no inline script or style, no remote address or font source | closed |
| T-62-29 | Information disclosure | secrets in a prompt answer | high | mitigate | `planMove` refusal, `assertNoSecrets`, `SecretLeakError` mapped to a fixed sentence; log lines carry fixed or `safeReason` text, never card text. Test: "a secret caught on write maps to the secret sentence". See T-62-48 for raw error text elsewhere in the output channel | closed |
| T-62-30 | Denial of service | message floods or post storms (host to page) | low | mitigate | 250 ms throttle, post only when the serialised model changed and only to visible surfaces, one panel. Tests: four posts a second at most; one editor tab. Page-to-host direction: T-62-49 | closed |
| T-62-31 | Tampering | solo project behaviour change | medium | mitigate | `await import('./boardView')` only once a team session runs; type-only static import; view `when: nearAi.teamMode`. Test: teamSoloParity asserts `boardView.js` not in `require.cache` | closed |
| T-62-32 | Tampering / Elevation of privilege | stored script injection through card text | high | mitigate | Zero hits in `media/board/*.js` for `innerHTML`, `outerHTML`, `insertAdjacent*`, `document.write`, `srcdoc`, `eval`, `new Function`, network APIs or href/src assignment; fake DOM throws on markup. Tests: boardClient markup title drawn as text; teamBoardAssets sink and network test | closed |
| T-62-33 | Information disclosure | page state persisted by VS Code | low | accept | Accepted in 62-09 (AR-62-01). Scope has since widened: since 62-13 the state also holds the unsent form draft; that wider scope is tracked separately as T-62-46 and is not covered by this acceptance | closed |
| T-62-34 | Spoofing | page acting on stale permissions | medium | transfer | Transferred to the host (TR-62-01): `boardView.ts` re-plans moves on fresh state inside `append`; `editProblem` re-checks edits on fresh state. Tests: developer cannot move a card; hostile edit judged on the log | closed |
| T-62-35 | Elevation of privilege | menu offering a move the viewer may not make | medium | transfer | Transferred to the host (TR-62-02): `menu.js` lists only the model's moves and posts a request only; host re-plans on fresh state | closed |
| T-62-36 | Tampering | markup in menu labels or refusal reasons | medium | mitigate | Text-only rendering; sink grep empty for `menu.js`. Test: boardMenu "menu.js has no markup sink" | closed |
| T-62-37 | Tampering | foreign drag data dropped on the board | low | mitigate | `drag.js` accepts only with an active session and `application/x-near-ai-card`; drop needs `getData(TYPE) === session.id`. Test: "drops that do not carry the board type are ignored" | closed |
| T-62-38 | Elevation of privilege | drop into a column the viewer may not use | medium | transfer | Transferred to the host (TR-62-03): refused drops never post; offered drops post a move request the host re-plans. Test: drop on a claim or integration column posts nothing | closed |
| T-62-39 | Tampering | markup in detail text | medium | mitigate | Text-only rendering; sink grep empty for `detail.js`. Test: boardDetail `<img onerror>`, `<script>` and `$(trash)` render as text | closed |
| T-62-40 | Denial of service | very long lists in a detail | low | mitigate | `FILES_SHOWN=8`, `HISTORY_SHOWN=50` on the page; host caps in `board.ts` and `itemHistory.ts`. Tests: files Show all N; history stops at 50 even when host sends more | closed |
| T-62-41 | Elevation of privilege | editing another member's item through a crafted edit-item | high | mitigate | `editProblem` inside `append` on fresh state refuses imported items and feeds `isOwnDraft` to `decideTeamAction` for item.edit and item.estimate; `prepareEvents` and reader re-check. Tests: teamBoardItems developer cannot edit another's chore; imported plan never editable | closed |
| T-62-42 | Information disclosure | secret-like text typed into a form | high | mitigate | `cleanFields` runs `findSecrets` over title, description and scope before and after normalising; `assertNoSecrets` on write. Test: key-like text refused in title, description and file line with remote scan. Page-side persistence of the draft: T-62-46 | closed |
| T-62-43 | Tampering | oversize or malformed fields | medium | mitigate | Parser caps (title 200, description 2000, 64 scope lines of 200, estimate range), `cleanFields` re-validation, exact-key validators on read. Test: malformed files and sizes refused, nothing written | closed |
| T-62-44 | Information disclosure / Elevation of privilege | test seam returning SecretStorage | high | mitigate | `extension.ts` returns the team handle and secrets only when `process.env.NEAR_AI_E2E === '1'`, else `undefined`; e2e runner sets it. No negative unit test for the production return (advisory A1) | closed |
| T-62-45 | Tampering | release missing or changed board assets | medium | mitigate | `scripts/verify-release-content.mjs` lists all six board files; teamBoardAssets test checks the list equals the files the host loads, plus sink, network and colour-literal tests; `.vscodeignore` keeps `media/` | closed |
| T-62-SC | Tampering | npm/pip/cargo installs | high | mitigate | `git diff` against the merge base with main: `package-lock.json` unchanged; `package.json` gains only `contributes.commands`, `contributes.views` and `nearAi.team.pollSeconds`, no dependency change | closed |
| T-62-46 | Information disclosure | unsent form draft persisted in webview state (found in audit; widens T-62-33) | low | mitigate | No mitigation yet. `media/board/board.js` `persist` stores `draft` and `media/board/form.js` `draftNow` saves type, title, description, files and estimate on every input. In edit mode the draft starts from teammate-authored card text, and secret-like text is stored by VS Code before the host's `findSecrets` refusal (the page has no detector). Fix options: drop the draft when the view hides or on submit/refusal, or accept with the wider scope | open — below high threshold (non-blocking) |
| T-62-47 | Denial of service | `.planning` tree listing buffered before the 2000-path cap (found in audit; residual of T-62-07) | medium | mitigate | No mitigation yet. `integrationSource.ts` runs `parseTree(listed.stdout)` on the full `ls-tree` output before `slice(0, MAX_PLANNING_PATHS)`; `runGit.ts` has a timeout but no output byte cap, so a branch pusher with a huge `.planning` tree can force a large in-memory buffer. Fix: byte-capped or streaming listing | open — below high threshold (non-blocking) |
| T-62-48 | Information disclosure | unredacted error text in the Team Board output channel (found in audit) | low | mitigate | No mitigation at this layer. `boardView.ts` lines 420, 427, 448, 611 and 655 write `describe(error)` directly, unlike `safeReason` elsewhere. Today's error sources are already redacted (`mustSucceed`), so this is defence in depth | open — below high threshold (non-blocking) |
| T-62-49 | Denial of service | page-to-host messages not rate-limited (found in audit) | low | mitigate | No mitigation yet. T-62-30 controls are host-to-page only; `import-plans`, `new-item` and `retry` from the page are bounded only by role checks, the serialised import chain and the CSP | open — below high threshold (non-blocking) |

*Status: open · closed · open — below high threshold (non-blocking)*
*Severity: critical > high > medium > low — only open threats at or above workflow.security_block_on count toward threats_open*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-62-01 | T-62-33 | VS Code persists the board page's `setState` in its local webview storage. Accepted for filters, group by, collapsed sets, selection and milestone ids only, which hold no card text. This acceptance does not cover the unsent form draft added in 62-13; that is open as T-62-46 | Plan 62-09 threat model | 2026-11-02 |

**Transferred:**
- TR-62-01 (T-62-34), TR-62-02 (T-62-35), TR-62-03 (T-62-38): the page only shows and requests what the model offers; the extension host re-plans every move and re-checks every edit on fresh log state inside `log.append` (62-08, `boardView.ts`). Host control verified present and tested.

**Advisories (non-blocking at ASVS L1):**
- A1 (T-62-44): there is no negative unit test that production `activate()` returns `undefined` without `NEAR_AI_E2E`.
- A2 (T-62-46..49): open below the high block threshold. They are recorded for a later fix or an explicit owner acceptance. No code was changed in this audit.

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-11-02 | 50 (T-62-01..T-62-45, T-62-SC counted once, plus T-62-46..T-62-49 found in audit) | 46 (42 mitigate, 1 accept, 3 transfer) | 4 (T-62-46 low, T-62-47 medium, T-62-48 low, T-62-49 low; all below the high threshold, 0 blocking) | gsd-security-auditor (ASVS L1, block on high); 320 focused tests pass |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed (4 open threats below the high threshold, non-blocking)
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-11-02
