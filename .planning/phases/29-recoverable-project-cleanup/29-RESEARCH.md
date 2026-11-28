# Phase 29 — Recoverable project cleanup research

**Research baseline** `5bfeba0af`, as recorded in Phase 29 context. [VERIFIED: .planning/phases/29-recoverable-project-cleanup/29-CONTEXT.md:13-15]

<user_constraints>

## User Constraints (from CONTEXT.md)

### Approved scope

[Phase 29](../../ROADMAP.md#phase-29-a-cleanup-member-with-a-safe-cleanup-tool)
and CLEAN-01 through CLEAN-05 in the [requirements](../../REQUIREMENTS.md)
define this feature. A restricted software team member can show a dry run for recorded
agent-created artifacts or reviewed known-disposable locations. The floor and a scoped
file operation enforce all never-touch rules. The feature uses recoverable quarantine,
an operation record, and restore. Permanent purge requires explicit human approval
and the retention window.

The dependency is Phase 70. Verified main `5bfeba0af` includes the Phase 70 verification
record from #216, including the floor and action-decision paths for GATE-05 and GATE-06.
Main has no registered CleanUp tool or Phase 29 plan.

### Boundaries

Keep candidate discovery, quarantine, restore and permanent purge distinguishable.
Candidate evidence and approval must remain bound to the selected workspace and item
through each operation. An unavailable check, ambiguous provenance, filesystem mismatch
or active use remains visible to the operator. Evidence of recent activity or restricted
location refuses the move. The cleanup role gets read-only tools and the scoped CleanUp
capability. It cannot call a general shell or file writer.

Never test against real user files, keys, secrets, containers, shared projects or host
cleanup targets. Research and planning have no filesystem effects on a target project.
Fixture acceptance uses a private synthetic workspace and the applicable process or
filesystem proof. Any actual permanent purge needs the owner-authorized action and target.
Do not infer a new user decision from this planning record.

</user_constraints>

## Summary

Build a read-only preview that uses positive creation evidence or a reviewed exact-location catalog. At mutation time, require current evidence for the same object, a floor decision, and enforceable control of access and pathname changes for the whole mutation. Keep preview usable wherever the runtime can evaluate it and show why an item cannot move when a capability is unavailable. [VERIFIED: .planning/phases/29-recoverable-project-cleanup/29-CONTEXT.md:5-11,19-29] [CITED: https://man7.org/linux/man-pages/man2/openat2.2.html] [CITED: https://man7.org/linux/man-pages/man7/pid_namespaces.7.html]

**Primary recommendation.** Plan the first mutation adapter for a private, application-controlled workspace scope where all consumers are accountable and the host can prove containment. Treat broader local directories, host-mounted containers, shared or network filesystems, and other platforms as preview-only unless an adapter demonstrates equivalent guarantees. Make every moved item recoverable before offering purge. [CITED: https://man7.org/linux/man-pages/man2/rename.2.html] [CITED: https://man7.org/linux/man-pages/man2/flock.2.html] [VERIFIED: .planning/phases/29-recoverable-project-cleanup/29-CONTEXT.md:19-29]

## Architectural Responsibility Map

| Capability | Primary tier | Secondary tier | Responsibility |
|---|---|---|---|
| Eligibility and reason display | Local tool service | Workspace UI | Produce bounded preview from evidence. Carry refused, active and unavailable reasons into the display. [VERIFIED: .planning/phases/29-recoverable-project-cleanup/29-CONTEXT.md:19-24] |
| Protection and human decisions | Action gate | Local tool service | Decide floor and authorization before the adapter can mutate. [VERIFIED: src/domain/gate/decide.ts:284-301] |
| Containment and in-use proof | Host filesystem adapter | Local tool service | Hold authoritative scope, identity and quiescence through each mutation. [CITED: https://man7.org/linux/man-pages/man2/openat2.2.html] [CITED: https://man7.org/linux/man-pages/man7/pid_namespaces.7.html] |
| Recovery and retention | Local operation store and adapter | Workspace UI | Persist intent and final state. Restore from the manifest and gate purge. [VERIFIED: .planning/phases/29-recoverable-project-cleanup/29-CONTEXT.md:8-11,19-29] [CITED: https://man7.org/linux/man-pages/man2/fsync.2.html] |

<phase_requirements>

## Phase Requirements

| ID | Requirement text | Research support |
|---|---|---|
| CLEAN-01 | CleanUp offers as candidates only items the extension recorded as created by agent runs, or a short built-in list of known-disposable locations. | Closed catalog and creation evidence. [VERIFIED: .planning/REQUIREMENTS.md:801-801] |
| CLEAN-02 | Never-touch rules are checked in code and are part of the gate's floor (GATE-05): tracked files and files deliberately kept, `.git`, `.env*`, keys and credentials (including the person's NEAR key folder in their home folder), `.planning`, anything outside the project and the system temp area, anything changed in the last hour, and anything a running process has open or uses as its folder; links out, `..`, the home folder and over-broad patterns are refused. | Independent floor and adapter evidence, bounded subtree inspection, in-use proof. [VERIFIED: .planning/REQUIREMENTS.md:802-802] |
| CLEAN-03 | Nothing is deleted at once: items go to a recoverable quarantine with a manifest, a Restore command brings them back, and a purge happens only after a retention window of about 7 days. | Journaled same-filesystem move, no-replace restore, retention state. [VERIFIED: .planning/REQUIREMENTS.md:803-803] |
| CLEAN-04 | A dry-run list comes first, and the person confirms anything not on the known-disposable list, anything large or of unknown origin, and every permanent purge. | Bind the preview and each approval to the exact operation and object. [VERIFIED: .planning/REQUIREMENTS.md:804-804] |
| CLEAN-05 | The cleanup member gets only CleanUp and read-only tools (no Bash, no Write), and a disaster test proves each never-touch rule. | Explicit role allowlist, floor dominance, synthetic host checks. [VERIFIED: .planning/REQUIREMENTS.md:805-805] |

</phase_requirements>

## Project Constraints (from AGENTS.md)

- Keep real credentials and their archives untouched. Run any future acceptance with synthetic substitutes in a private fixture. Owner authorization identifies an actual irreversible action and its target. [VERIFIED: .planning/phases/29-recoverable-project-cleanup/29-CONTEXT.md:26-30]
- Apply the supplied AGENTS.md directives on separate worktrees for independent writers, scoped checks first, a full relevant gate once, and meaningful tests for changed state transitions. Keep permission and data-integrity failures blocking. Reuse existing code and keep scope limited to approved requirements. Compare unfamiliar mechanisms using primary open-source documentation. [CITED: user-provided AGENTS.md]

## Standard Stack

| Layer | Use |
|---|---|
| Action policy | Existing pure floor and gate decision path. The floor defines `'floor.state-keys': 'refuse'`, `'floor.credential-store': 'refuse'`, `'floor.identity-files': 'refuse'` and `'floor.destroy': 'ask'`. Its workspace resolver is text-only. Have the host collect filesystem evidence and pass a typed verdict to the gate, then independently enforce current invariants in the adapter. [VERIFIED: src/domain/gate/floor.ts:1-18,101-105] |
| Tracked paths | Use the intended workspace's Git index and literal NUL-delimited path handling. Review repository/worktree identity before querying and refuse an unavailable or incomplete result. Include tracked descendants and gitlinks when evaluating a directory. Git ignore and index membership are separate checks. [CITED: https://git-scm.com/docs/git-ls-files] |
| Filesystem | Use a narrow platform adapter with root-bound resolution, controlled source and destination parents, same-filesystem atomic no-replace moves and directory persistence. Linux references describe kernel facilities. Availability in the shipped runtime remains an acceptance question. [CITED: https://man7.org/linux/man-pages/man2/openat2.2.html] [CITED: https://man7.org/linux/man-pages/man2/rename.2.html] [CITED: https://man7.org/linux/man-pages/man2/fsync.2.html] |
| Dependencies | Plan against existing runtime and repository test infrastructure. Defer any package selection until a concrete unmet adapter requirement justifies it. No external package is recommended, so there is no package audit. [VERIFIED: package.json:1258-1261] |

## Architecture Patterns

~~~text
Selected workspace + creation receipts or reviewed catalog
    → bounded read-only preview → evidence and refusal reasons
                                 → opaque candidate IDs
Exact quarantine request → fresh floor and host evidence → refused or unavailable
                         → human confirmation when required
                         → exclusive scope + durable intent → quarantine → manifest
Manifest item + Restore → check origin and vacancy → restored or conflict retained
Manifest item + Purge → check retention and owner approval → purged or refused
Interrupted operation → reconcile both sides + recorded identity → state or conflict
~~~

### Discovery and provenance

- Resolve selection against a specific registered workspace and producer record. Accept a creation receipt only when the trusted producer positively recorded creation of that object. A write, modification, existence in a familiar folder, ignore rule, or an agent's own assertion alone cannot establish creation. Attach original relative path, workspace identity, producer/run identity and object identity to the preview. [VERIFIED: .planning/REQUIREMENTS.md:801-802] [CITED: https://git-scm.com/docs/git-ls-files]
- Use exact reviewed locations with documented ownership and expected object kind. Bound depth, entries, bytes read and elapsed time. Record an incomplete check instead of issuing a mutable candidate. Before a directory can move, inspect the whole tree for tracked or kept items, recent changes, protected descendants, unexpected links or types, filesystem boundaries and current use. A folder name or time stamp alone supplies insufficient evidence. Treat an unknown origin within a reviewed location as requiring confirmation only when the catalog supplies independent eligibility. If provenance essential to eligibility is ambiguous, refuse. [VERIFIED: .planning/REQUIREMENTS.md:801-804] [VERIFIED: .planning/phases/29-recoverable-project-cleanup/29-CONTEXT.md:19-24]
- Reject absolute or unscoped input, traversal before normalization, broad selectors, protected locations at any covered depth and ambiguous workspace identities. Reject symlinks, external mount transitions, special files and unexpected multiply linked entries for the first adapter. The parent identities and source object must remain stable through commit. Linux root-bound resolution restricts path traversal during lookups. A later rename receives names, so an atomic rename on its own cannot enforce the identity reviewed earlier. Require control over concurrent writers and renames in the supported scope throughout the commit. [VERIFIED: .planning/REQUIREMENTS.md:802-802] [CITED: https://man7.org/linux/man-pages/man2/openat2.2.html] [CITED: https://man7.org/linux/man-pages/man2/rename.2.html]

### Authoritative in-use proof

- A positive open-file or working-directory match blocks movement. Check the candidate and its descendants by filesystem identity where possible. Treat denied or hidden inspection, process churn with unknown outcomes, and scope mismatch as incomplete evidence. Linux process descriptor and cwd views have permission checks, and a PID namespace has a bounded view of processes. An empty result in a container cannot establish absence of live users of a host-shared path. [CITED: https://man7.org/linux/man-pages/man5/proc_pid_fd.5.html] [CITED: https://man7.org/linux/man-pages/man5/proc_pid_cwd.5.html] [CITED: https://man7.org/linux/man-pages/man5/proc.5.html] [CITED: https://man7.org/linux/man-pages/man7/pid_namespaces.7.html]
- Plan an authoritative scope where every possible consumer is either excluded by the host boundary or tracked by an enforceable application access protocol. Hold the exclusive maintenance interlock while checking active handles and working directories and through the final mutation. Include inherited or persistent uses in the contract if the runtime can hand them out. A cooperative lock can participate only where every access path actually honors it. A process list, a second scan, an inactive job record, or an old timestamp cannot stand in for exclusion. If the planner cannot identify the enforcement and the deployed runtime cannot demonstrate it, keep that path in preview with a plain explanation. [CITED: https://man7.org/linux/man-pages/man2/flock.2.html] [CITED: https://www.freedesktop.org/software/systemd/man/latest/tmpfiles.d.html] [VERIFIED: .planning/phases/29-recoverable-project-cleanup/29-CONTEXT.md:19-29]

### Quarantine, restore and purge

- Allocate an opaque item ID under restricted quarantine on the source filesystem. Persist the intent and original workspace-relative path before moving, then persist changed directory entries and commit the final state. Store object identity, state revision, verification timestamp, policy reference, quarantine time and expiry without file contents. On restart compare the recorded source and quarantine identities. A mismatch or ambiguous location requires a visible conflict and leaves both sides intact. [CITED: https://specifications.freedesktop.org/trash/1.0/] [CITED: https://man7.org/linux/man-pages/man2/fsync.2.html]
- Restore the manifest object to its original scoped destination by no-replace move after checking the destination parent and applicable rules. If the original location was recreated or its parent changed, retain the quarantined item and display the conflict. Refuse when the underlying mount or its atomic operation cannot deliver the required behavior. Skip copy-and-unlink fallback. Report quarantine bytes separately from reclaimed bytes, since a same-filesystem move still stores the object. [CITED: https://man7.org/linux/man-pages/man2/rename.2.html] [CITED: https://specifications.freedesktop.org/trash/1.0/]
- Derive purge eligibility from the persisted time of completed quarantine and the configured retention policy. Keep the record recoverable when clock or operation state is uncertain. Issue purge approval only for an eligible manifest item and consume the human authorization once for that exact action, item, workspace and state revision. Recheck retention, identity and locks at commit. Serialize restore and purge for the same record. Reconcile an interrupted purge from durable intent and evidence, without using stale approval to retry blindly. [VERIFIED: .planning/REQUIREMENTS.md:803-804] [VERIFIED: .planning/phases/29-recoverable-project-cleanup/29-CONTEXT.md:19-29] [CITED: https://man7.org/linux/man-pages/man2/fsync.2.html]

## Don't Hand-Roll

| Reference | Pattern to reuse | Boundary for SovAI |
|---|---|---|
| freedesktop.org Trash 1.0 | Durable original location and the operation timestamp are worth preserving independently of the storage name. Create the accompanying metadata before the move. | Use the pattern with the existing local operation store and private quarantine. The desktop convention handles interoperable trash and recovery. SovAI requires its own scoped floor, approval and retention. [CITED: https://specifications.freedesktop.org/trash/1.0/] |
| systemd tmpfiles | Scoped lifetime rules and skipping subtrees on an active cooperative lock. | Use as a comparison for an interlock where access is closed and accountable. Direct aging removal cannot express the required recovery and owner decision sequence. [CITED: https://www.freedesktop.org/software/systemd/man/latest/tmpfiles.d.html] |
| Git index and native host operations | Existing index authority, root-bound open, atomic no-replace rename and durable directory updates. | Reuse the primitives through the local adapter. Keep unsupported filesystems and unprovable scopes visible in preview. [CITED: https://git-scm.com/docs/git-ls-files] [CITED: https://man7.org/linux/man-pages/man2/openat2.2.html] [CITED: https://man7.org/linux/man-pages/man2/rename.2.html] [CITED: https://man7.org/linux/man-pages/man2/fsync.2.html] |

## Common Pitfalls

| Failure | Planning control |
|---|---|
| A reviewed path changes while a person reads the card. | Scope the card to an immutable candidate record. Revalidate at execution. If identity or evidence materially changes, require a new preview and any applicable new decision. [VERIFIED: .planning/phases/29-recoverable-project-cleanup/29-CONTEXT.md:19-24] |
| A stale timestamp masks recent activity or a directory shields a protected descendant. | Define age using reliable activity evidence, including descendant changes. Refuse activity within the required hour and refuse missing timestamps where they matter. Scan and hold a bounded, complete subtree before using a directory as the unit of movement. [VERIFIED: .planning/REQUIREMENTS.md:802-802] |
| A gap in process visibility is treated as inactivity. | Bind the proof to the exact workspace mount and all possible consumers, and keep the exclusion in force. Model unavailable as a blocking result distinct from active. [CITED: https://man7.org/linux/man-pages/man7/pid_namespaces.7.html] [CITED: https://man7.org/linux/man-pages/man5/proc_pid_fd.5.html] |
| Gate approval is reused for another operation or becomes a permanent policy exception. | Bind one use to verb, workspace, item identity and revision. In the existing decision path the floor's `'refuse'` yields `'deny'`, and an `'ask'` when presence is `'none'` also yields `'deny'`. Preserve that ordering. [VERIFIED: src/domain/gate/decide.ts:284-301] |
| A crash leaves the state of the original and quarantine unclear. | Journal intent first, persist both directory changes, and reconcile by recorded identities. Surface a restore collision and any uncertain purge explicitly. [CITED: https://man7.org/linux/man-pages/man2/fsync.2.html] [CITED: https://man7.org/linux/man-pages/man2/rename.2.html] |

## Code Examples

Use this control-flow sketch as a planning example. Names are placeholders. [CITED: https://man7.org/linux/man-pages/man2/openat2.2.html] [CITED: https://man7.org/linux/man-pages/man2/rename.2.html] [CITED: https://man7.org/linux/man-pages/man2/fsync.2.html]

~~~text
hold maintenance interlock for the selected workspace and item
  verify capability, current floor evidence, identity and required decision
  persist scoped intent
  perform the same-filesystem no-replace move through controlled parent handles
  persist changed directories
  commit the operation record
release the interlock
~~~

## Assumptions Log

| ID | Open assumption | Planning consequence |
|---|---|---|
| A1 | The shipped workstation runtime can supply verifiable controlled parents and an authoritative consumer boundary for at least one approved location. [ASSUMED] | Require a synthetic fixture capability checkpoint on the actual supported runtime. Ship mutation only for scopes with positive proof. Report any other scope as unavailable. |
| A2 | The exact list of known-disposable locations, which evidence shows an explicit keep, and the size cutoff have an approved source in the product. [ASSUMED] | Ask the planner to identify an existing approved contract and otherwise use a conservative default requiring confirmation or omitting unreviewed sites. Record the default as a decision for review. |
| A3 | Existing operation storage and the selected filesystem can provide the durability and restart behavior required by the design. [ASSUMED] | Prove the crash boundaries on synthetic storage before claiming recovery. Treat unavailable directory persistence as blocking mutation for that adapter. |

## Environment Availability

This research read source and documentation without exercising a cleanup target. Host support is unverified here. For planning, use read-only preview when resolution, atomic no-replace move, directory persistence, tracked/keep evidence or in-use proof is unavailable in the actual workspace mount and process scope. A synthetic check should exercise the shipped runtime access policy and mount type. [CITED: https://man7.org/linux/man-pages/man2/openat2.2.html] [CITED: https://man7.org/linux/man-pages/man2/rename.2.html] [CITED: https://man7.org/linux/man-pages/man2/fsync.2.html] [VERIFIED: .planning/phases/29-recoverable-project-cleanup/29-CONTEXT.md:26-29]

## Validation Architecture

Use the repository's focused tests after compile and the repository test script at the phase gate. The existing script is `"test": "npm run compile && node scripts/run-tests.mjs dist/test/*.test.js scripts/test/*.test.mjs"`. Plan assertions for new behavior before implementation and cover the actual tool and command entry points. [VERIFIED: package.json:1258-1261] [VERIFIED: .planning/REQUIREMENTS.md:805-805]

| Requirement | Focused acceptance contract |
|---|---|
| CLEAN-01 | Positive provenance and a reviewed location appear in a read-only preview. Modification-only, ambiguous origin, stale receipts and exhausted verification budgets fail to authorize movement. [VERIFIED: .planning/REQUIREMENTS.md:801-801] |
| CLEAN-02 | One table-driven private disaster fixture exercises every listed protection. Include a synthetic child holding a descriptor and a child whose cwd is inside the candidate, loss of process visibility, concurrent object/parent changes, and filesystem mismatch. Adapter simulation verifies refusal results. The supported-host fixture verifies the actual positive proof. [VERIFIED: .planning/REQUIREMENTS.md:802-802] [CITED: https://man7.org/linux/man-pages/man5/proc_pid_fd.5.html] [CITED: https://man7.org/linux/man-pages/man5/proc_pid_cwd.5.html] |
| CLEAN-03 | A move is recoverable after restart, an existing original is preserved, and an intent interrupted at each durable boundary reconciles predictably. Verify retention with a controlled clock. [VERIFIED: .planning/REQUIREMENTS.md:803-803] [CITED: https://man7.org/linux/man-pages/man2/fsync.2.html] |
| CLEAN-04 | Missing, expired or wrong-item approval fails. A changed record invalidates the earlier decision. Purge before expiry or without exact human approval fails. A synthetic restore/purge race has one winner and no collateral effects. [VERIFIED: .planning/REQUIREMENTS.md:804-804] [VERIFIED: .planning/phases/29-recoverable-project-cleanup/29-CONTEXT.md:19-29] |
| CLEAN-05 | Unauthorized actions are unavailable from the cleanup role and fail through the direct dispatch route. Confirm the floor still prevails in every approval mode and review successful and refused decision records. [VERIFIED: .planning/REQUIREMENTS.md:805-805] [VERIFIED: src/domain/gate/decide.ts:284-301] |

## Security Domain

Use OWASP ASVS 5 as a control cross-reference for this local feature. Apply V5 file handling to rooted selection and storage, V8 authorization to floor decisions and individual operations, and V16 logging and error handling to durable, minimal records and recoverable failure. Reuse existing authenticated approval identity where applicable and current OS and SDK facilities for identity and storage. This mapping scopes controls to the local tool contract. [CITED: https://cheatsheetseries.owasp.org/IndexASVS.html]

| Threat | Required mitigation |
|---|---|
| Tampering with pathname or manifest | Enforce trusted roots and stable identities in the executor. Protect the quarantine and operation store from the cleanup role's writes. [CITED: https://man7.org/linux/man-pages/man2/openat2.2.html] [VERIFIED: .planning/phases/29-recoverable-project-cleanup/29-CONTEXT.md:19-24] |
| Elevation via approval reuse or broad tool access | Require exact, one-use decisions and keep floor refusals independent of the human decision. Maintain the explicit role allowlist. [VERIFIED: src/domain/gate/decide.ts:284-301] [VERIFIED: .planning/REQUIREMENTS.md:804-805] |
| Disclosure via preview, process inspection or logs | Inspect only data needed for the decision, display a reason without unrelated process information, and omit file contents and sensitive host paths from durable records. [CITED: https://cheatsheetseries.owasp.org/IndexASVS.html] |
| Storage exhaustion or uncertain recovery | Bound checks, report the physical impact of retained data, and preserve quarantined bytes on every uncertain state transition. [CITED: https://specifications.freedesktop.org/trash/1.0/] [CITED: https://man7.org/linux/man-pages/man2/fsync.2.html] |

## Sources and confidence

- **High for repository behavior and scope.** Phase 29 context, requirements, Phase 70 floor and decision source. Consult the accompanying pattern map for production composition.
- **Medium for host primitives and comparison patterns.** Linux man-pages, Git documentation, freedesktop.org Trash 1.0, systemd tmpfiles and OWASP. These references describe each mechanism under its own prerequisites.
- **Low for deployment assumptions.** Resolve A1–A3 with the planner and synthetic runtime checks before claiming mutation support.
