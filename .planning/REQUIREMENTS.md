# Requirements: Near AI for VSCode

## Canadian official languages

- [ ] **LANG-01**: The Canadian profile supports a persistent user switch between English (Canada) and French (Canada). Workbench, setup, administration, help and documentation support both languages, with equivalent accessibility and no loss of project context.
- [ ] **LANG-02**: The Canadian profile can draft in either official language and present both approved renditions of a shared product. Translations preserve exact source provenance and inherited data controls. Approval tracks both versions and qualified human review, and a stale rendition cannot be presented as current.
- [ ] **LANG-03**: The translation service evaluates each supported language pair and format. Approved model versions have exact artifact, deployment and evaluation evidence. Out-of-scope or uncertain source work can be referred to a qualified person.

Track workbench localization under LANG-01. Carry LANG-02 into Phase 96 and institutional staff draft acceptance. Carry LANG-03 into Phase 98 and authorized multilingual document intake. [Delivery and acceptance](research/canadian-official-languages.md).

## Milestone v0.5.0: Governed agent platform (Phases 68-74), and v0.7.0 Messaging relay (Phases 75-84)

**Defined:** 2026-11-13 (relay). **Replanned:** 2026-11-15 from the owner's platform direction (`.planning/PROJECT.md`, "Platform direction"): the identity and governance core was added, the relay requirements were re-mapped to renumbered phases, and new groups were added (TMR, GATE, OFFL, DLGT, EXEC, CRED, CTRT, CHAN, PAIR, APRV).
**Amended:** 2026-11-15 with the identity, credential and classification design the owner approved (`.planning/PROJECT.md`, Platform direction decisions 8-13; evidence in `.planning/research/platform-direction/identity-research.md`): CLAS (classification labels and routing, Phase 70) and VCRD (verifiable credentials, Phase 71) added, DLGT-08 added, DLGT-01, DLGT-03, DLGT-07, OFFL-03, OFFL-04 and IDNT-05 revised, and the L4 and L5 drafts revised for roots-only anchoring, the confidential backend interface, HQ's roles and the per-level maximum offline age.
**Amended:** 2026-11-16 by the owner: CLAS-08 (the trust badge) added and CLAS-05 ratified; then the agent authorization decisions (`.planning/PROJECT.md`, Platform direction decisions 14-17; evidence in `.planning/research/platform-direction/agent-authz-prior-art.md`): CRED-08 added to Phase 73, CLAS-08 notes the automatic check, and L4 drafts ANCH-09 … ANCH-15 added for NEAR function-call access keys on agents' and nodes' on-chain calls only.
**Split:** 2026-11-18 (owner, data platform decision 2): the relay requirements of Phases 75 to 84 (AUTH, CHAN, IDNT, PAIR, RUNL, CMND, APRV, GRP, BUDG, TEAM, SETUP, SGNL, TGRM, OPS, EXEC-11 and CTRT-07) now belong to the separate milestone v0.7.0 Messaging relay, which runs after v0.6.0 Data platform. Their ids, text and phase mappings are unchanged, so they stay in this section and its traceability table. v0.5.0 keeps Phases 68 to 74 (67 requirements; RELAY-01 … RELAY-04 stay with Phase 68, which shipped as "v0.7.0 Phase 68", now v0.5.0) and the relay milestone holds 67.
**Renumbered:** 2026-11-18 (owner: "considering we are on 0.4 now, lower the rest to start at 0.5"): the governed agent platform, v0.7.0 until then, is v0.5.0; the data platform is v0.6.0 and the messaging relay v0.7.0. No id, text or phase mapping changed.
**Core value:** Every agent works under a governance layer a person can see and check, deciding offline from a signed local policy; and (now v0.7.0 Messaging relay) a person in a Microsoft Teams, Signal or Telegram chat asks the team for something and the answer arrives where they already are, without VS Code. The group sees only the finished result, the working thread stays private to whoever asked, and every relay run executes under a contract in a sandbox.

> **What "relay" means here.** The new messaging relay at `relay/`: receive a chat message, drive an existing agent team, post the result back. **Not** the ciphertext sync relay of the paused former v0.5.0 knowledge-base plan (RELAY-01/02, archived in `.planning/milestones/v0.5.0-paused/`) and **not** the planned `relayTransport.ts` board sync on the unmerged Team Mode branch. Those are separate, deliberate, unrelated work.

> **Id collisions with the former v0.6.0 Team Mode branch plan.** The Team Mode requirements on `feat/team-fix-pass` use TEAM-01..04 (team and identity) and SETUP-01 (guided project setup) with other meanings. In this file TEAM-xx is the Teams channel and SETUP-xx the Messaging setup view; its carried ids take a `TM-` prefix (TMR-04).

> **Two kinds of credential.** CRED-xx (Phase 73, credential broker) are secrets such as API keys that agents use by handle and never hold. VCRD-xx (Phase 71) are W3C Verifiable Credentials: signed statements about an identity's authority, clearance, roles and compartments. The prefixes differ on purpose.

### Relay foundation (Phase 68, done)

- [x] **RELAY-01**: The relay runs as its own workspace with its own lockfile and exactly one runtime dependency (`jose`), on Node 26.13.1 (a release carrying all current security fixes, with `engines` pinned so an older runtime refuses to start), while the extension keeps its existing Node target and zero-dependency bundle; the two never share a lockfile.
- [x] **RELAY-02**: The relay answers a health check that reports version, uptime, whether the Teams verifier and the Signal sidecar are operational, and the count of in-flight runs, so an operator knows the box is alive without reading logs.
- [x] **RELAY-03**: All relay state (run records, conversation bindings, tenant registry, pending approvals, message queues) lives in a single state directory that is git-ignored and readable only by the relay's OS user, and a restart loses no queued message or in-flight run record.
- [x] **RELAY-04**: The relay ships as a container image built without a shell or package manager, and every secret it needs (bot secret, tenant API keys, Signal registration material) is read at startup from an operator-supplied source and never appears in the image, the state directory listing, or a log line.

### Team Mode reconciliation (Phase 69)

- [x] **TMR-01**: Before any code moves, `feat/team-fix-pass` is preserved on GitHub as an archive branch and the uncommitted files in its legacy worktree are committed or recorded.
- [x] **TMR-02**: The Team Mode core verified in Phase 60 of the former v0.6.0 Team Mode branch plan (device identities held in SecretStorage, canonical JSON, the signed append-only event envelope with Lamport ordering, event validation, the deterministic materializer, the role-by-action permission matrix, the git coordination transport and the roster) runs on current `main`, re-verified against Phase 60's success criteria, in `src/domain/team/` and `src/team/` with no `vscode` import and no new runtime dependency.
- [x] **TMR-03**: A project with no team file behaves exactly as before, the full suite stays green, and a canary test proves no secret reaches the coordination log, `team.json`, settings or audit.
- [x] **TMR-04**: Every phase and requirement of the former v0.6.0 Team Mode branch plan has a recorded disposition (landed in Phase 69, carried to the Team Mode milestone, folded into a named phase of the then v0.7.0 plan, or retired), and carried ids that collide with live ids take a `TM-` prefix.
- [x] **TMR-05**: A person's device identity signs and verifies any canonical payload through one interface (policy bundles, grants, approval answers), and key rotation and revocation are signed events that later checks honour.

### Capability gate and manifests (Phase 70)

- [ ] **GATE-01**: One versioned capability vocabulary (verb, resource, constraints; for example `read`, `workspaceWrite{paths}`, `shell{cwd}`, `network{hosts}`, `mcp{server, tools}`, `send{channel}`, `schedule`, `skill.write{scope}`, `spend{usd}`, `useSecret{handle}`, with reserved verbs for inference routes and GPU devices) lives in `src/domain` with no `vscode` import, and unknown verbs or fields are refused.
- [ ] **GATE-02**: Every built-in tool has a declared capability manifest (effects, network hosts, credential handles, and the contexts it may run in: interactive, unattended, relay, routine), replacing the implicit `ActionCapability` mapping, and a test fails if any registered tool lacks one.
- [ ] **GATE-03**: Every MCP server has a manifest (declared effects per tool, allowed hosts, credential handles); an undeclared tool gets the most restrictive effects; a stdio server is labelled as running on this machine with the person's own permissions and never runs in unattended contexts unless named; the Tools page and member cards show manifests in plain words.
- [ ] **GATE-04**: One gate decides every tool call from the actor, the capability and the context; a test enumerates every execution path (file tools, Bash, MCP calls, sub-agent spawns) and proves each passes it; approval cards are only a transport into the gate.
- [ ] **GATE-05**: A floor no mode, setting or delegation can override: the key folder and credential stores are refused, and writes into `.git/` and `.near-ai/` state, publishing and destruction always ask a person with no "always allow", in every mode including fully-autonomous.
- [ ] **GATE-06**: Fully-autonomous means "no approval needed within the policy's grant", never "gate off", and SECURITY.md and README describe the floor the same way.
- [ ] **GATE-07**: Every gate decision is recorded with actor, capability, outcome and the rule that decided it, in a record shape (OCSF classes) that a later audit chain can sign and anchor.

### Classification labels and routing (Phase 70)

- [ ] **CLAS-01**: Labels are part of the versioned capability vocabulary and the signed policy bundle: `{scale, level, compartments, releasability, handling}`, attached to files, folders, chats, projects and tool output; an unlabelled item takes its folder's or project's label, a project with no label takes the policy's default, and an unknown scale, level or field is refused.
- [ ] **CLAS-02**: The policy bundle ships scale presets, each an ordered list: commercial `org` (Public < Internal < Confidential < Restricted; the default), Canadian government as two separate scales (Protected A < Protected B < Protected C, and Confidential < Secret < Top Secret), and NATO (NATO Unclassified < NATO Restricted < NATO Confidential < NATO Secret < Cosmic Top Secret); a clearance on one scale covers another only through a mapping your organization adds to its policy (for example "Secret also covers Protected A and B").
- [ ] **CLAS-03**: The gate allows access to labelled content only when the actor's clearance dominates the label: the same scale (or a policy mapping), a level at least the label's, every label compartment held, releasability met, and nothing expired or revoked. The check is a small hand-written evaluator in `src/domain` with no runtime dependency, and a property test shows no access without dominance. Until Phase 71's credentials exist the clearance comes from the signed policy bundle; from then on, from verified credentials (VCRD-07).
- [ ] **CLAS-04**: Every agent session carries a high-water mark, the highest label it has read; anything it writes, sends or summarizes inherits that label, sub-agents start at their parent's mark, and the mark never goes down except by a person's declassification action, which is recorded.
- [ ] **CLAS-05**: The policy bundle maps each level (and any `handling` flag) to a routing tier: `any-cloud`, `attested-cloud` (only TEE models on NEAR AI Cloud's own endpoint, with attestation and the response signature verified after each response and a failure stopping further requests at that tier), `local-only` (a model on this machine's loopback address or a host your organization names in its policy; no content leaves the machine otherwise) or `deny`. Defaults: Public any cloud; Internal, Confidential and Protected A attested cloud; Restricted, Protected B (unless your organization approves an assessed cloud), Protected C and every classified level local only; `deny` available per compartment. *(Revised 2026-11-16 in Phase 70 planning, D-36 and D-37: attestation can only be checked after a response, and a local runtime URL can be any host today.)* Owner-ratified 2026-11-16 with this amplification: verifying attestation after a response proves which model and code ran, not that the connection was private, because the request was already sent and the connection may end outside the enclave. So a level that requires `attested-cloud` also needs a check before sending that the connection key is bound to the enclave in its attestation; if NEAR AI Cloud does not expose that binding, those levels route `local-only` and the trust badge (CLAS-08) says why.
- [ ] **CLAS-06**: Before every model request the gate decides the route from the session's high-water label; a request that needs `local-only` with no local model configured is refused with a plain explanation and never sent to a cloud.
- [ ] **CLAS-08**: Every answer from a cloud model shows a small trust badge in plain words, with the full attestation one click away for anyone who wants to inspect it: "Verified private model" (attestation and signature verified and the connection key is bound to the enclave), "Model verified, connection not proven" (attestation verified but the connection is not bound to the enclave, so a proxy in between could read the request), or "Not verified" (no attestation, a failed check, or a model outside an enclave). The badge never claims more privacy than was proven. (Owner, 2026-11-16.) The check runs automatically on every answer from a TEE model: one signature request per answer, with the attestation report reused for 10 minutes. *(Owner decision, 2026-11-16, PROJECT.md Platform direction decision 16; Phase 70 plans 24 to 27 already build it this way.)*
- [ ] **CLAS-07**: The product says plainly, where labels are set and in SECURITY.md, that the gate is an organizational control that prevents mistakes and does not make a device accredited for classified information.

### Offline policy (Phases 70 and 74)

- [ ] **OFFL-01**: The gate decides with no network at all; nothing in a decision waits on a network call.
- [ ] **OFFL-02**: Policy comes from a local bundle signed by a person's device identity; a missing, unsigned, tampered or expired bundle fails closed to the floor plus read and plan, with a plain explanation of how to fix it; a fresh install creates and signs its first bundle, so nothing breaks.
- [ ] **OFFL-03**: The bundle carries a version, expiry, issuer and reserved fields for anchor roots with inclusion proofs, status list references and a maximum offline age per level, so the anchoring and edge milestones (L4, L5) add freshness without a format change. *(Revised 2026-11-15; was: reserved fields for chain anchoring and revocation lists.)*
- [ ] **OFFL-04**: Run admission (a contract and its chain of grants and credentials up to the person's signed policy, with status checked from cached status lists) needs no network, and anything the local copy cannot cover fails closed. *(Revised 2026-11-15 to name credentials and status lists.)*

### Delegation (Phase 71: DLGT-01; Phase 71.1: DLGT-02 to DLGT-08, split 2026-11-24)

- [x] **DLGT-01**: Every agent, machine and device acts under its own `did:key` (Ed25519; Phase 69's device identity maps to it unchanged), and people and your organization's root use `did:webvh` (a hash-chained log with pre-rotation that verifies offline from a cached copy); DID documents stay minimal and conform to DID Core 1.0 (identifier, verification methods, controller, services) with no custom authority or sandbox members; `did:near` is not used; no agent uses another agent's key or a shared credential pool. *(Revised 2026-11-15, owner-confirmed; was: an Ed25519 key, the NEAR implicit account derived from it, and a DID document with an authority section and a reserved sandbox section.)*
- [ ] **DLGT-02**: A child's capabilities are the intersection of the parent's grant, the member's declared tools and the task's request, enforced in the gate, never in the prompt, and a property test shows no delegation widens.
- [ ] **DLGT-03**: Every grant is a delegation credential (the VCRD-02 profile) signed by its delegator, carrying an expiry, a budget, a level cap, roles, compartments and a depth limit, and recorded in the signed log; an expired, unsigned or tampered grant is refused. *(Revised 2026-11-15; was: a signed grant with an expiry and a budget.)*
- [ ] **DLGT-04**: Delegation depth (default: the lead plus members; members spawn only when marked as orchestrators) and fan-out (per turn and per tree) are capped as data in the grant.
- [ ] **DLGT-05**: Leaves never receive authority-amplifying capabilities (spawning agents, scheduling, outbound messages, skill or memory writes, changes to tools, MCP servers or policy) unless their grant names them, and adding tools, servers or schedules is never available to member agents.
- [ ] **DLGT-06**: A delegation may declare a result shape; a member's result is checked with one correction turn, and after a restart an unfinished result is reported as unknown.
- [ ] **DLGT-07**: The Agent Activity view shows, for each agent, what it may do in plain words, the level, roles and compartments it holds, and its DID for anyone who wants to inspect it.
- [ ] **DLGT-08**: Delegation only narrows on level, roles, compartments, expiry and depth: at every link of the chain the verifier checks that the level cap is at most the delegator's, roles and compartments are subsets of the delegator's, the expiry is no later than the delegator's earliest relevant credential and the depth limit holds, and that no credential anywhere in the chain is revoked or suspended; one failing link refuses the whole chain, and a property test shows no chain widens.

### Verifiable credentials (Phase 71)

- [ ] **VCRD-01**: Authority, clearance (classification level), access roles and compartments are attributed per identity only as W3C Verifiable Credentials 2.0, never inside a DID document and never on chain: membership, clearance (threshold), compartment, role, device binding and delegation credentials, each with an issuer, a subject DID, an expiry and a status entry.
- [ ] **VCRD-02**: Credentials follow one narrow profile: a fixed `@context` list (the VC 2.0 context plus one of our own; any other is refused and no JSON-LD processing runs), `DataIntegrityProof` with the `eddsa-jcs-2022` cryptosuite only, Ed25519 keys as Multikey, integers only. It is built on `node:crypto` Ed25519 and the existing canonical JSON with zero new runtime dependencies, signs through Phase 69's signer interface and honours its key status (a revoked key is refused for everything).
- [x] **VCRD-03**: The W3C `eddsa-jcs-2022` test vectors are frozen tests, and Digital Bazaar's `@digitalbazaar/eddsa-jcs-2022-cryptosuite` and `@digitalbazaar/vc`, added as devDependencies only, verify our credentials and we verify theirs; the extension bundle gains no runtime dependency.
- [x] **VCRD-04**: Revocation (permanent) and suspension (reversible) use Bitstring Status List: each credential has a randomly assigned index in a list of at least 131,072 entries, compressed with `node:zlib` and carrying `validUntil`; a verifier checks status from a cached list and fails closed when a needed list is missing or past `validUntil`; lowering a clearance revokes every higher threshold credential.
- [x] **VCRD-05**: Selective disclosure uses atomic and threshold credentials (one fact each, for example "clearance at least Secret" on a named scale), and a holder presents only the credentials a check asks for; SD-JWT VC and BBS are later options, not built here.
- [ ] **VCRD-06**: Each device and agent `did:key` is bound to its person (or to your organization) by a device binding or delegation credential with a device class and a short expiry; a lost device is cut off by revoking its binding, with no change to anyone's DID.
- [x] **VCRD-07**: The gate builds each actor's clearance, roles and compartments only from verified, unexpired, unrevoked credentials and the delegation chain, and a missing or unverifiable credential gives nothing (fail closed). In your organization the issuer is your organization's DID or a person your organization's signed policy authorizes; agents and devices never issue. A person with no organization keeps their own declared clearances on their own computer, shown as "declared, not verified": they are never credentials, are never cited as evidence and count nowhere else (no shared project, hub, wrap or organization policy), so a fresh install keeps working with no HQ. *(Owner, 2026-11-24, owner item 1 of `71-CONTEXT.md` answered "defaults"; was: a person with no organization issues their own credentials from their device DID.)*

### Data-centric access control (Phase 71, added 2026-11-24)

From the owner's data-centric access direction (`.planning/research/data-centric-access/RESEARCH.md`, decisions O1 to O11 accepted 2026-11-24): verified credentials are the only source of access attributes, data decides access from its own label, zero trust throughout, Keycloak for authentication only.

- [x] **DCAC-01**: Trusted issuers are in the signed policy: `credentials@1` pins your organization's root DID and names, for each credential type, the role credential an issuer must hold and the ceiling it may issue, with the status lists, the status time to live, the maximum offline age per level and the credentials required by sensitivity (only ever tightened); `agreements@1` holds organization-to-organization agreements. Only people with a role credential from the root can issue; an agent or device key never can, whatever the policy says.
- [x] **DCAC-02**: An entry that relies on a person's attribute cites its evidence by hash (the credentials and the status lists checked); the fold checks only the cited evidence at the entry's signed time, so every replica gives the same answer whatever list it holds.
- [x] **DCAC-03**: One pure `mayRelease` decides every key wrap, release and serve from verified credential facts and the data's own label: level on the scale or an approved mapping, every compartment, releasability for every holder of a marked cell, export eligibility for CGP, ITAR and EAR, and the credentials required by sensitivity; a position's required clearance and ways of serving are checked the same way.
- [ ] **DCAC-04**: The enforcement points check freshness at the moment of action: your organization's server refuses an append that cites a stale status list and stops serving a member whose credential is revoked, the wrap preparer and the session refuse stale evidence with a plain reason and Retry, an edge refuses past the level's maximum offline age, and a later revocation leads to a rekey.
- [x] **DCAC-05**: Credentials are issued, revoked and suspended only from an officer's own session, signed by their person key after a passkey step-up, under a role credential from your organization's root; status lists are signed by the HQ status-list key in OpenBao Transit, each signature authorized only by an officer's step-up (O4); no new runtime service.
- [x] **DCAC-06**: Your organization's server serves the `did:webvh` logs and status lists, and a trust export carries them and the issuer section to disconnected edges, which verify every object from their own copies.

### AI classification (Phases 70.1 and 74.3, added 2026-11-24)

From the AI classification research (`.planning/research/ai-classification/RESEARCH.md`, branch `origin/docs/research-ai-classification`, merged on `docs/phase-70.1-74.3-plan`). Owner, 2026-11-24: AI proposes data attributes only, never person attributes (D1); the classifier models are gpt-oss, Nemotron 3 Nano, IBM Granite (including Granite Guardian) and Command A+ on the Cohere Model Vault classes and your organization's own on-premise hosting through its signed passport, never NEAR AI's hosting; your organization's signed passport may widen hosting (owner, 2026-11-24; 74.1 D-05) (a hosting rule; Phase 74.1 found Command A+ 05-2026 under Apache-2.0), each with a role only after evaluation and red-team at that level, no PRC models (D7, revised). Owner decisions D2 to D6 and D8 to D14 are owner-confirmed 2026-11-24 at the research defaults.

- [ ] **CLSF-01**: Every classification proposal is one closed record: the item, content hash and revision, the inherited start, the proposed label with each field's direction, each basis with its kind (`source`, `marking`, `guide`, `detector`, `compilation`, `judgement`) and reference, calibrated confidence, the model passport and artifact, the prompt and policy hashes, a rationale labelled at the item's label, and the outcome. It has no field for any person attribute, and the copy in the decision log holds hashes, ids, kinds and counts only.
- [ ] **CLSF-02**: A proposal starts from the join of the labels the content inherits and can only raise or keep it. Lowering a level, removing a compartment or a handling flag, widening releasability and declassifying are never applied automatically; they become a "could be lower" suggestion for a person with the authority. A result for another content hash is dropped, and no text in the content, visible or hidden, can lower its label or suppress a floor.
- [ ] **CLSF-03**: Each level's raise threshold is 1 / (1 + cost ratio) from your organization's signed policy, with raise, suggest and nothing bands. Markings, guide rules, detectors, compilation rules and source labels are floors that need no threshold. A model judgement alone raises only the level; its compartments, releasability and handling are suggestions. In shadow mode judgements only suggest. A drop in measured recall lowers a level's effective threshold, never above the signed value, and a raise by more than one level or to the top level also goes to review.
- [ ] **CLSF-04**: The signed `classification@1` section holds thresholds and recall targets per level, the system-high, shadow and review settings, model roles, marking patterns, code words, fact types, and guide and compilation rules, each rule with its guide reference and the label of its own text. Newer or lower layers may only tighten it. Pure code evaluates rules over typed facts, and compilation rules also over a session's running set of fact types.
- [ ] **CLSF-05**: The label events `label.auto-raised`, `label.exception-queued`, `label.exception-resolved`, `label.could-be-lower` and `label.affirmed` are named and written to the decision log. A proposal or floor above the system-high gives the possible-spill outcome: the item is raised to the system-high with `local-only` and `no-agent-tools`, frozen for sharing and queued as an exception.
- [ ] **CLSF-06**: Classification runs only on a model server your organization's policy lists, inside the content's security domain at its system-high, never on a commercial cloud. The model's passport covers the checking job (T2; T3 for staff and classified work), its origin is Western and its family differs from the model that wrote the content; at the levels the policy marks, a second family must agree before "nothing to raise". The answer is closed JSON with no tools, the content is passed as data, and the policy and thresholds are never in the prompt. Any failure leaves the item unassessed with its rules applied, never lower.
- [ ] **CLSF-07**: The candidate models are gpt-oss (20b; 120b at HQ), Nemotron 3 Nano, IBM Granite (including Granite Guardian) and Command A+ only on the Cohere Model Vault classes and your organization's own on-premise hosting through its signed passport, never NEAR AI's hosting; your organization's signed passport may widen hosting (owner, 2026-11-24; 74.1 D-05) (a hosting rule: Command A+ 05-2026 is Apache-2.0, per Phase 74.1's licence check); no PRC model. Each has a licence check and a compliance fit entry the resource check enforces. A model gets a role at a level only after its signed evaluation report (public, synthetic guide, in-domain golden and red-team sets; recall, over-classification, override rate, review load and time per level, never one accuracy number) passes there and no red-team case lowers a label or suppresses a floor. Model raises begin at a level only after the shadow period and the blind audit's recall target.
- [ ] **CLSF-08**: A native Classification panel beside the editor shows the item's label, each basis in plain words, the model and passport, and only upward actions. Each item moves through draft, assessing, proposed, unassessed, affirmed and lower-requested; no state waits on the network or a model; proposals arrive after edits settle and never block typing; a raise tells the originator at once.
- [ ] **CLSF-09**: Submitting or releasing an item, including releasing it to an observer, needs the originator's one-step signed affirmation of its label, showing the bases. The record reads "Classified by" a named person "assisted by" the model passport and binds the label to the content hash; editing afterwards never lowers the label.
- [ ] **CLSF-10**: A label is lowered, or a compartment or handling flag removed, by any path, only with the signed approval of a person presenting a verified, unrevoked `ClassificationAuthorityCredential` that covers the item's level and scope, signed with their person key after a passkey step-up. Releasability widens only through a release authority. Agents and devices can never lower. A request carries no content, is never dropped, and is shown as overdue after the policy's age limit.
- [ ] **CLSF-11**: A possible spill freezes the item for sharing and reports it, with its basis and no content, to your organization's security officer, who resolves it with a recorded decision; resolving it never lowers the label.
- [ ] **CLSF-12**: Every output an agent writes, sends or summarizes is classified; a raise raises the chat's label and the written file's label; content that may leave the computer is checked before it is sent; the chat's running fact set survives reloads and merges so a compilation spread over a conversation is caught.
- [ ] **CLSF-13**: A raise on a shared cell's content narrows the cell marking with its basis and stages the key change that leaves out holders `mayRelease` no longer allows; a lower cell marking is covered only by a `marking.approve` from a holder of a `ClassificationAuthorityCredential` covering that level; observers never see proposals, rationales or bases.
- [ ] **CLSF-14**: The runner classifies after edits settle with bounded parallel slots per model server and never blocks anyone. The sizing estimates for an HQ of about 400 people are recorded as estimates until Phase 85 measures them, and the operator guide explains the load per item and per call with no capacity, throughput or timing number.

### Execution backends (Phases 72 and 77)

- [ ] **EXEC-01**: A project or run chooses its execution backend: host (today, labelled as text checks only), container (Docker or Podman) or OpenShell (Linux first, pinned version); the chat and Agent Activity say which boundary a run has; Windows and Intel Macs get container or host, labelled, and nothing claims isolation it does not have.
- [ ] **EXEC-02**: In container and OpenShell runs the agent works on a copy the extension builds from tracked files and uncommitted changes, never containing `.near-ai/state`, `.git` or other floor paths, never a bind mount of the live checkout, and never relying on `.gitignore` filtering.
- [ ] **EXEC-03**: Changes return only through a guarded apply: a diff computed on the host from regular files and shown to the person before anything is applied; symlinks (including links back to the key folder), special files, mode changes and paths under protected locations are refused or flagged; Revert covers what was applied.
- [ ] **EXEC-04**: A run-time read of `.near-ai/state/keys` (built from variables, `$(...)`, base64, scripts started by `npm run`, recursive walks, links or `/proc`) fails in container and OpenShell runs, and the spike's 20 escape cases (`.planning/research/platform-direction/openshell-spike/tests/key-escape.sh`) are regression tests.
- [ ] **EXEC-05**: The OpenShell policy for a run is generated from the agent's grant and the team policy, never written by hand or by an agent: enforce mode, `landlock: hard_requirement`, a non-root user, network rules per binary, and a fixed vocabulary of file paths that a child may only drop or make read-only; the schema is pinned to the shipped OpenShell version.
- [ ] **EXEC-06**: When a lead delegates under the OpenShell backend, the child's generated policy is checked against the parent's with the pinned prover and only `within_boundary` is accepted; rules the prover cannot model (MCP) are left to the delegation subset check (DLGT-02).
- [ ] **EXEC-07**: The gate still decides network, secrets and outbound actions inside every backend, no check is skipped because a sandbox is active, policy can require a non-host backend for unattended runs, and sandbox decisions (binary, host, rule, reason) appear in Agent Activity.
- [ ] **EXEC-08**: On Linux a guided setup installs the pinned OpenShell release after checking its checksums and build attestations, generates the local certificates and gateway signing keys, runs the gateway as a user service with telemetry off and its sockets under the short runtime folder, and re-verifies on upgrade; under code-server the gateway runs on the host and the editor reaches it only over its own authenticated API, never through a container runtime socket.
- [ ] **EXEC-09**: Workload images are pinned by digest, loaded where the gateway's runtime finds them, carry the tools a project needs, and exist for arm64 and amd64.
- [ ] **EXEC-10**: A dev server the agent starts inside a sandbox is reachable by the person only through a forward the person can see, and host services are reachable from a sandbox only through an endpoint the policy allows.
- [ ] **EXEC-11**: Every relay run executes in a container or OpenShell sandbox on a copy of the tenant's workspace with only placeholders for that tenant's credentials; with no sandbox reachable the relay refuses to run tools and says so in the chat.

### Credential broker (Phase 73)

- [ ] **CRED-01**: Every credential an agent may use is a named handle bound to its audience hosts, and the extension refuses to send it anywhere else (MCP headers, web tools, project commands).
- [ ] **CRED-02**: In container and OpenShell runs processes see only placeholders; the real value is added at the boundary only on a request to the bound endpoint in the bound placement (OpenShell providers, or our own egress path for the container backend), and mismatches are refused.
- [ ] **CRED-03**: Shell output, MCP results and fetched pages are checked for known secret formats before they reach a model, and a match is held back and shown.
- [ ] **CRED-04**: On the host backend the existing environment scrub stays and the UI says the broker's guarantee needs a sandbox; SECURITY.md states that the sandbox supervisor terminates TLS on the machine, so request contents pass through it.
- [ ] **CRED-05**: A child agent receives a credential handle only when its grant names it; children never inherit a parent's credential pool.
- [ ] **CRED-06**: A canary leak test proves no real credential reaches a sandboxed process, its environment, a log line, the transcript or a model request.
- [ ] **CRED-07**: No credential value ever appears on a command line, in a process list or in a log.
- [ ] **CRED-08**: The broker adds a real credential to a request only after checking the acting agent's authority for that exact request. The request carries a signed invocation in the UCAN 1.0 shape (issuer, subject, audience, command, arguments, proof chain, nonce, an expiry of minutes) bound to the request by an RFC 9421 HTTP message signature or a body hash, and the broker checks it against the agent's private credentials (the grant that names the handle and its delegation chain, VCRD-07 and DLGT-08, with status from the cached lists); a replayed, expired, re-targeted or wider invocation is refused. Each credential and each lease is bound to one audience, the agent's own token is never passed through, a missing capability is answered with 403 `insufficient_scope` naming what a person can grant, and each use leaves a receipt in the signed log. If the invocation reuses NEP-413's message layout, it carries our own tag and recipient, documented, because NEP-413 expects a full-access key. *(Owner, 2026-11-16, PROJECT.md Platform direction decisions 15 and 17: off-chain capabilities stay in private credentials checked here and never go into NEAR's public key list.)*

### Run contracts (Phases 74 and 77)

- [ ] **CTRT-01**: One signed run contract type names the allowed capabilities, cost, tool-call and wall-clock caps, the largest sub-agent tree, the backend required, whether approvals may wait or must deny, and an expiry.
- [ ] **CTRT-02**: A contract wider than its issuer holds (capabilities, budget, backend) is refused before anything runs, with the reason in plain words.
- [ ] **CTRT-03**: Each cap stops the run at the next turn or tool call with an honest report naming partial results, and the effective cost cap is the smallest of the contract, the run budget and the daily limit.
- [ ] **CTRT-04**: Every run no person started from the chat requires a contract; unattended sub-agent runs in the editor get one derived from the lead's grant.
- [ ] **CTRT-05**: An approval nobody answers in a contract run expires to deny, never to allow, and a contract that says approvals must deny refuses any action that needs one and reports it.
- [ ] **CTRT-06**: The contract's hash and issuer, and actual use against each cap, are recorded in the signed log at start and end.
- [ ] **CTRT-07**: Every relay run carries a contract issued under the tenant's authority and the requester's pairing, and a refused contract is explained in the chat.

### Inbound authenticity and allowlisting (Phase 75)

- [ ] **AUTH-01**: Every inbound request is authenticated before anything else happens: the token's signature, issuer, audience, expiry, clock skew and its `serviceUrl` claim match the running bot's configuration — and any failure returns 403 without running anything.
- [ ] **AUTH-02**: The verifier accepts bot-emulator traffic only when a development flag is set, and a release build cannot be configured into an unverified mode.
- [ ] **AUTH-03**: A signal that the same message arrived twice (platform retry, reconnect resend, edited event) starts exactly one run; signature validity alone is not treated as replay safety, so verification is always paired with the dedupe ledger.
- [ ] **AUTH-04**: A message from a tenant or group that is not allowlisted is rejected in the channel with a plain explanation and never reaches a model.
- [ ] **AUTH-05**: A suite of adversarial requests (forged signature, tampered body, expired token, wrong issuer/audience, mismatched serviceUrl, replayed request, emulator-shaped token) is part of the build and fails the build if any of them is accepted.
- [ ] **AUTH-06**: The inbound path acknowledges within about a second and does the work afterwards, so a slow agent never makes the platform retry.

### Channel manifests (Phase 75)

- [ ] **CHAN-01**: Each channel is a manifest in the gate's vocabulary (ingress verification kind, body size limit, egress hosts, credential handles and how each is injected), so a further channel is a manifest plus one adapter.
- [ ] **CHAN-02**: A channel's deployment credentials are configured once by the operator from secret files, never by an agent, and the relay refuses to start a channel whose manifest and secrets disagree.
- [ ] **CHAN-03**: A channel's egress is limited to its manifest's hosts, and each credential is sent only to its audience.

### Identity, tenants and requesters (Phase 76)

- [ ] **IDNT-01**: Each inbound message binds to a tenant from the verified envelope alone, never from message text, and a message that cannot be bound is refused rather than guessed.
- [ ] **IDNT-02**: Each request is attributed to the person who sent it, by a channel identity recorded on first sight and, once that person has paired, by their identity in the new identity model; the binding survives a restart.
- [ ] **IDNT-03**: A result and its working thread can only ever reach the tenant, conversation and requester that produced them; a test proves an answer generated for one tenant cannot be delivered to another.
- [ ] **IDNT-04**: Each tenant has an isolated workspace directory and uses only its own API key, so a run can neither read another tenant's files nor bill another tenant's key.
- [ ] **IDNT-05**: Each tenant has an identity whose authority, held as signed credentials and never inside its DID document, bounds every run for that tenant, so no run for the tenant can exceed it. *(Revised 2026-11-15; was: an authority section.)*

### Channel pairing (Phase 76)

- [ ] **PAIR-01**: After the operator has configured a channel, a person pairs their chat account in two steps (a one-time code from the operator side or the person's own editor, confirmed in the chat), recorded as a signed event that binds the channel identity to the person's identity within one tenant.
- [ ] **PAIR-02**: An unpaired person in an allowlisted conversation cannot start runs or approve anything; the bot replies with how to pair (owner decision 2026-11-15: everyone must pair).
- [ ] **PAIR-03**: A person or the operator can unpair, and account changes, reassigned accounts and recycled phone numbers never inherit a pairing.
- [ ] **PAIR-04**: No agent can pair, unpair or change any pairing, or the operator's channel configuration.

### Runner pool and run lifecycle (Phases 77 and 80)

- [ ] **RUNL-01**: The relay runs a team headlessly by composing the existing agent engine, tools, team library, model client, checkpoints and run markers together with the gate, grants and contracts, and the relay leaves the extension's own behaviour unchanged.
- [ ] **RUNL-02**: Concurrent runs are capped globally, and overflow waits in a durable queue rather than being dropped or failing.
- [ ] **RUNL-03**: A person can ask a question in a 1:1 chat and receive the team's finished answer in that same chat, with progress visible while it runs.
- [ ] **RUNL-04**: A run interrupted by a restart resumes automatically inside the existing window, or reports in-channel that it died; a run never disappears silently and its record is never left in an unknown state.
- [ ] ~~**RUNL-05**~~: Retired 2026-11-15, replaced by APRV-01 … APRV-04 (request-bound, signed approvals that expire to deny). The original text: When the run needs approval, the requester gets a durable request in their private chat; answering it continues the run, and leaving it unanswered lets the run proceed as non-blocking and later denied on expiry, instead of stalling.
- [ ] **RUNL-06**: A person can send a follow-up while a run is working, and it reaches the run or waits durably in its queue.
- [ ] **RUNL-07**: A person can cancel a run from plain text with no buttons available, and receives an honest confirmation that names the partial artifacts if anything had completed.

### Text command surface (Phase 80)

- [ ] **CMND-01**: `help`, `status`, `cancel`, `cost`, `pause` and `resume` work as text with identical meaning in both channels, and each answers with the run it refers to.
- [ ] **CMND-02**: `status` reports elapsed time, current step and spend so far for a run.
- [ ] **CMND-03**: `cost` reports spend against the tenant's and the group's budget in the same terms the extension shows.

### Request-bound signed approvals (Phase 80)

- [ ] **APRV-01**: An approval request is bound to a digest of the exact request (actor identity, capability, arguments, run, contract, expiry); an answer applies only to that digest, and a changed or replayed request needs a new answer.
- [ ] **APRV-02**: Only the requester or an approver the contract names may answer, and the answer is a signed event: signed by the person's device identity in the editor, and in a chat by the relay attesting the verified, paired identity of who answered.
- [ ] **APRV-03**: In a chat the request reaches the requester's private thread durably; answering continues the run; an unanswered request expires to deny, and a run with no way to ask is refused rather than left pending.
- [ ] **APRV-04**: "Always allow" becomes a signed, scoped, expiring grant rather than a local setting, and the editor and the relay show the same approval object.

### Group-chat discipline (Phase 81)

- [ ] **GRP-01**: A group chat receives an acknowledgement and the finished result and nothing else; the working thread, tool output and internal narration stay in the requester's private chat.
- [ ] **GRP-02**: Replies in a threaded channel land in the thread that caused them, and follow-ups in the group reuse the same thread.
- [ ] **GRP-03**: Group text is treated as untrusted input: members' words cannot redirect where results go, reveal the private working thread, or widen what the run may do.
- [ ] **GRP-04**: Document results (PDF, DOCX) are delivered as signed, expiring links so delivery does not depend on the customer tenant's file-storage provisioning.
- [ ] **GRP-05**: A person can drag a file into the chat and have the run use it as input, with the same result-only discipline holding for what comes back.

### Budgets and spend (Phase 79)

- [ ] **BUDG-01**: A tenant's spend is capped and a run that would exceed the cap is refused before it is billed, with a plain in-channel explanation instead of silence.
- [ ] **BUDG-02**: A per-conversation cap exists and defaults to unlimited, so a busy group can be clamped without every group needing configuration at onboarding.
- [ ] **BUDG-03**: Every run's spend is recorded against its tenant, conversation and requester in an append-only ledger, and the totals in chat match the extension's ledger for the same key.
- [ ] **BUDG-04**: A relay run's contract cost cap is the smallest of the requester's grant, the tenant's remaining budget and the conversation's remaining budget, computed in integer nano-USD with the same arithmetic the editor uses, so Team Mode allocations can reuse it.

### Teams channel (Phase 77)

- [ ] **TEAM-01**: The bot is an external app that a customer's administrator installs without it joining their organisation, and it works in both 1:1 and group chats inside a threaded conversation.
- [ ] **TEAM-02**: The bot is addressed by mention in a group and by direct message in a 1:1, and a greeting on first encounter happens once per thread rather than on every membership event.
- [ ] **TEAM-03**: Progress is streamed live into the private 1:1 thread and, where the platform permits it, into the group thread; when in-group streaming is not available the bot posts discrete updates instead of failing.
- [ ] **TEAM-04**: The bot presents the team's own name, avatar and personality as configured for that tenant, not a generic bot identity.

### Messaging setup view (Phase 78)

- [ ] **SETUP-01**: A Messaging view in the extension shows relay health and each channel's state (Not set up, Connected, Down).
- [ ] **SETUP-02**: The view uses a local, operator-authenticated admin endpoint on loopback, separate from the public webhook port; secret values never reach the webview or settings.
- [ ] **SETUP-03**: The Teams card connects the bot (app ID and secret written as relay secret files), verifies it, and produces the app package for your organization's admin.
- [ ] **SETUP-04**: The operator views and edits each channel's allowlist, and changes apply without a restart.
- [ ] **SETUP-05**: The view lists paired people per channel, issues one-time pairing codes and revokes pairings, through the same admin endpoint.

### Signal channel (Phase 82)

- [ ] **SGNL-01**: The relay speaks Signal through a supervised sidecar running a pinned version that is never auto-upgraded, sharing credentials over a socket restricted to the relay's OS user.
- [ ] **SGNL-02**: A group on the relay's Signal number can be allowlisted, and messages from groups that are not allowlisted are rejected.
- [ ] **SGNL-03**: Every text command, acknowledgement, result and document attachment works in Signal with the same semantics as Teams, using quoted replies in place of threads.
- [ ] **SGNL-04**: An onboarding path exists for provisioning the relay's number, backing up its registration material, and recovering it, because losing that material means losing the number.
- [ ] **SGNL-05**: The Messaging view's Signal card registers or links the relay's number, backs up its registration material and sends a test message.

### Telegram channel (Phase 83)

- [ ] **TGRM-01**: The relay connects to a Telegram bot from its BotFather token, held as a secret file, registers its own webhook with a secret token and rejects updates without it.
- [ ] **TGRM-02**: Telegram updates pass the same inbound checks as other channels (replay window, duplicate update ids, allowlist), proven by adversarial tests.
- [ ] **TGRM-03**: Allowlisted Telegram chats and groups get every command, acknowledgement, result and attachment with Teams semantics, using replies in place of threads.
- [ ] **TGRM-04**: Each Telegram message binds to a tenant and requester from the verified update alone, with tenant isolation tested.

### Operations, onboarding and release (Phase 84)

- [ ] **OPS-01**: A customer's administrator can install the bot into their tenant by following a written package of steps, including what to verify and how to upgrade.
- [ ] **OPS-02**: An operator can deploy the relay on their own host by following a written playbook covering the reverse proxy, redirect-URI validation, key provisioning and backup.
- [ ] **OPS-03**: A threat model documents each surface, what authenticates it, and the failure it prevents, and names the accepted residual risks.
- [ ] **OPS-04**: An append-only activity log lets an operator replay a run and answer a customer's "what happened here?" without access to the customer's chat.
- [ ] **OPS-05**: The adversarial suite and the tenant-isolation test run in CI, so a future change cannot quietly reopen a closed pitfall.
- [ ] **OPS-06**: The relay's deployment puts an OpenShell gateway (or the container runtime its sandbox uses) beside the relay on the host, never inside the relay container through a runtime socket; the relay refuses to run tools when no sandbox is reachable, and the operator playbook covers it.
- [ ] **OPS-07**: The relay image builds for arm64 and amd64 from one definition, pinned by a multi-architecture digest, and starts on both an arm64 (DGX Spark class) and an x86-64 (Strix Halo class) machine.

### Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| RELAY-01 | Phase 68: Relay foundation *(Phase 68 RELAY-01: not the archived ciphertext-sync RELAY-01 of the former v0.5.0 knowledge-base plan)* | Complete |
| RELAY-02 | Phase 68: Relay foundation *(Phase 68 RELAY-02: not the archived ciphertext-sync RELAY-02 of the former v0.5.0 knowledge-base plan)* | Complete |
| RELAY-03 | Phase 68: Relay foundation | Complete |
| RELAY-04 | Phase 68: Relay foundation | Complete |
| TMR-01 | Phase 69: Team Mode reconciliation | Complete |
| TMR-02 | Phase 69: Team Mode reconciliation | Complete |
| TMR-03 | Phase 69: Team Mode reconciliation | Complete |
| TMR-04 | Phase 69: Team Mode reconciliation | Complete |
| TMR-05 | Phase 69: Team Mode reconciliation | Complete |
| GATE-01 | Phase 70: Capability vocabulary, manifests and one gate | Pending |
| GATE-02 | Phase 70: Capability vocabulary, manifests and one gate | Pending |
| GATE-03 | Phase 70: Capability vocabulary, manifests and one gate | Pending |
| GATE-04 | Phase 70: Capability vocabulary, manifests and one gate | Pending |
| GATE-05 | Phase 70: Capability vocabulary, manifests and one gate | Pending |
| GATE-06 | Phase 70: Capability vocabulary, manifests and one gate | Pending |
| GATE-07 | Phase 70: Capability vocabulary, manifests and one gate | Pending |
| OFFL-01 | Phase 70: Capability vocabulary, manifests and one gate | Pending |
| OFFL-02 | Phase 70: Capability vocabulary, manifests and one gate | Pending |
| OFFL-03 | Phase 70: Capability vocabulary, manifests and one gate | Pending |
| OFFL-04 | Phase 74: Run contracts | Pending |
| CLAS-01 | Phase 70: Capability vocabulary, manifests and one gate | Pending |
| CLAS-02 | Phase 70: Capability vocabulary, manifests and one gate | Pending |
| CLAS-03 | Phase 70: Capability vocabulary, manifests and one gate | Pending |
| CLAS-04 | Phase 70: Capability vocabulary, manifests and one gate | Pending |
| CLAS-05 | Phase 70: Capability vocabulary, manifests and one gate | Pending |
| CLAS-06 | Phase 70: Capability vocabulary, manifests and one gate | Pending |
| CLAS-07 | Phase 70: Capability vocabulary, manifests and one gate | Pending |
| CLAS-08 | Phase 70: Capability vocabulary, manifests and one gate | Pending |
| DLGT-01 | Phase 71: Identities and verified credentials (core) | Complete |
| DLGT-02 | Phase 71.1: Agent delegation that only narrows | Pending |
| DLGT-03 | Phase 71.1: Agent delegation that only narrows | Pending |
| DLGT-04 | Phase 71.1: Agent delegation that only narrows | Pending |
| DLGT-05 | Phase 71.1: Agent delegation that only narrows | Pending |
| DLGT-06 | Phase 71.1: Agent delegation that only narrows | Pending |
| DLGT-07 | Phase 71.1: Agent delegation that only narrows | Pending |
| DLGT-08 | Phase 71.1: Agent delegation that only narrows | Pending |
| VCRD-01 | Phase 71: Identities and verified credentials (core) | Pending |
| VCRD-02 | Phase 71: Identities and verified credentials (core) | Pending |
| VCRD-03 | Phase 71: Identities and verified credentials (core) | Complete |
| VCRD-04 | Phase 71: Identities and verified credentials (core) | Complete |
| VCRD-05 | Phase 71: Identities and verified credentials (core) | Complete |
| VCRD-06 | Phase 71: Identities and verified credentials (core) | Pending |
| VCRD-07 | Phase 71: Identities and verified credentials (core) | Complete |
| DCAC-01 | Phase 71: Identities and verified credentials (core) | Complete |
| DCAC-02 | Phase 71: Identities and verified credentials (core) | Complete |
| DCAC-03 | Phase 71: Identities and verified credentials (core) | Complete |
| DCAC-04 | Phase 71: Identities and verified credentials (core) | Pending |
| DCAC-05 | Phase 71: Identities and verified credentials (core) | Complete |
| DCAC-06 | Phase 71: Identities and verified credentials (core) | Complete |
| CLSF-01 | Phase 70.1: Classification engine | Pending |
| CLSF-02 | Phase 70.1: Classification engine | Pending |
| CLSF-03 | Phase 70.1: Classification engine | Pending |
| CLSF-04 | Phase 70.1: Classification engine | Pending |
| CLSF-05 | Phase 70.1: Classification engine | Pending |
| CLSF-06 | Phase 74.3: Classification assistant | Pending |
| CLSF-07 | Phase 74.3: Classification assistant | Pending |
| CLSF-08 | Phase 74.3: Classification assistant | Pending |
| CLSF-09 | Phase 74.3: Classification assistant | Pending |
| CLSF-10 | Phase 74.3: Classification assistant | Pending |
| CLSF-11 | Phase 74.3: Classification assistant | Pending |
| CLSF-12 | Phase 74.3: Classification assistant | Pending |
| CLSF-13 | Phase 74.3: Classification assistant | Pending |
| CLSF-14 | Phase 74.3: Classification assistant | Pending |
| EXEC-01 | Phase 72: Execution backends on a copy, with a guarded apply | Pending |
| EXEC-02 | Phase 72: Execution backends on a copy, with a guarded apply | Pending |
| EXEC-03 | Phase 72: Execution backends on a copy, with a guarded apply | Pending |
| EXEC-04 | Phase 72: Execution backends on a copy, with a guarded apply | Pending |
| EXEC-05 | Phase 72: Execution backends on a copy, with a guarded apply | Pending |
| EXEC-06 | Phase 72: Execution backends on a copy, with a guarded apply | Pending |
| EXEC-07 | Phase 72: Execution backends on a copy, with a guarded apply | Pending |
| EXEC-08 | Phase 72: Execution backends on a copy, with a guarded apply | Pending |
| EXEC-09 | Phase 72: Execution backends on a copy, with a guarded apply | Pending |
| EXEC-10 | Phase 72: Execution backends on a copy, with a guarded apply | Pending |
| EXEC-11 | Phase 77: Teams 1:1 slice under a contract in a sandbox | Pending |
| CRED-01 | Phase 73: Credential broker | Pending |
| CRED-02 | Phase 73: Credential broker | Pending |
| CRED-03 | Phase 73: Credential broker | Pending |
| CRED-04 | Phase 73: Credential broker | Pending |
| CRED-05 | Phase 73: Credential broker | Pending |
| CRED-06 | Phase 73: Credential broker | Pending |
| CRED-07 | Phase 73: Credential broker | Pending |
| CRED-08 | Phase 73: Credential broker | Pending |
| CTRT-01 | Phase 74: Run contracts | Pending |
| CTRT-02 | Phase 74: Run contracts | Pending |
| CTRT-03 | Phase 74: Run contracts | Pending |
| CTRT-04 | Phase 74: Run contracts | Pending |
| CTRT-05 | Phase 74: Run contracts | Pending |
| CTRT-06 | Phase 74: Run contracts | Pending |
| CTRT-07 | Phase 77: Teams 1:1 slice under a contract in a sandbox | Pending |
| AUTH-01 | Phase 75: Inbound authenticity, allowlisting and channel manifests | Pending |
| AUTH-02 | Phase 75: Inbound authenticity, allowlisting and channel manifests | Pending |
| AUTH-03 | Phase 75: Inbound authenticity, allowlisting and channel manifests | Pending |
| AUTH-04 | Phase 75: Inbound authenticity, allowlisting and channel manifests | Pending |
| AUTH-05 | Phase 75: Inbound authenticity, allowlisting and channel manifests | Pending |
| AUTH-06 | Phase 75: Inbound authenticity, allowlisting and channel manifests | Pending |
| CHAN-01 | Phase 75: Inbound authenticity, allowlisting and channel manifests | Pending |
| CHAN-02 | Phase 75: Inbound authenticity, allowlisting and channel manifests | Pending |
| CHAN-03 | Phase 75: Inbound authenticity, allowlisting and channel manifests | Pending |
| IDNT-01 | Phase 76: Identity, tenants, requesters and pairing | Pending |
| IDNT-02 | Phase 76: Identity, tenants, requesters and pairing | Pending |
| IDNT-03 | Phase 76: Identity, tenants, requesters and pairing | Pending |
| IDNT-04 | Phase 76: Identity, tenants, requesters and pairing | Pending |
| IDNT-05 | Phase 76: Identity, tenants, requesters and pairing | Pending |
| PAIR-01 | Phase 76: Identity, tenants, requesters and pairing | Pending |
| PAIR-02 | Phase 76: Identity, tenants, requesters and pairing | Pending |
| PAIR-03 | Phase 76: Identity, tenants, requesters and pairing | Pending |
| PAIR-04 | Phase 76: Identity, tenants, requesters and pairing | Pending |
| RUNL-01 | Phase 77: Teams 1:1 slice under a contract in a sandbox | Pending |
| RUNL-02 | Phase 80: Command surface, run lifecycle and signed approvals | Pending |
| RUNL-03 | Phase 77: Teams 1:1 slice under a contract in a sandbox | Pending |
| RUNL-04 | Phase 80: Command surface, run lifecycle and signed approvals | Pending |
| RUNL-05 | Retired 2026-11-15 (replaced by APRV-01 … APRV-04) | Retired |
| RUNL-06 | Phase 80: Command surface, run lifecycle and signed approvals | Pending |
| RUNL-07 | Phase 80: Command surface, run lifecycle and signed approvals | Pending |
| CMND-01 | Phase 80: Command surface, run lifecycle and signed approvals | Pending |
| CMND-02 | Phase 80: Command surface, run lifecycle and signed approvals | Pending |
| CMND-03 | Phase 80: Command surface, run lifecycle and signed approvals | Pending |
| APRV-01 | Phase 80: Command surface, run lifecycle and signed approvals | Pending |
| APRV-02 | Phase 80: Command surface, run lifecycle and signed approvals | Pending |
| APRV-03 | Phase 80: Command surface, run lifecycle and signed approvals | Pending |
| APRV-04 | Phase 80: Command surface, run lifecycle and signed approvals | Pending |
| GRP-01 | Phase 81: Group-chat discipline | Pending |
| GRP-02 | Phase 81: Group-chat discipline | Pending |
| GRP-03 | Phase 81: Group-chat discipline | Pending |
| GRP-04 | Phase 81: Group-chat discipline | Pending |
| GRP-05 | Phase 81: Group-chat discipline | Pending |
| BUDG-01 | Phase 79: Budgets and spend ledger on run contracts | Pending |
| BUDG-02 | Phase 79: Budgets and spend ledger on run contracts | Pending |
| BUDG-03 | Phase 79: Budgets and spend ledger on run contracts | Pending |
| BUDG-04 | Phase 79: Budgets and spend ledger on run contracts | Pending |
| TEAM-01 | Phase 77: Teams 1:1 slice under a contract in a sandbox | Pending |
| TEAM-02 | Phase 77: Teams 1:1 slice under a contract in a sandbox | Pending |
| TEAM-03 | Phase 77: Teams 1:1 slice under a contract in a sandbox | Pending |
| TEAM-04 | Phase 77: Teams 1:1 slice under a contract in a sandbox | Pending |
| SETUP-01 | Phase 78: Messaging setup view and pairing | Pending |
| SETUP-02 | Phase 78: Messaging setup view and pairing | Pending |
| SETUP-03 | Phase 78: Messaging setup view and pairing | Pending |
| SETUP-04 | Phase 78: Messaging setup view and pairing | Pending |
| SETUP-05 | Phase 78: Messaging setup view and pairing | Pending |
| SGNL-01 | Phase 82: Signal channel | Pending |
| SGNL-02 | Phase 82: Signal channel | Pending |
| SGNL-03 | Phase 82: Signal channel | Pending |
| SGNL-04 | Phase 82: Signal channel | Pending |
| SGNL-05 | Phase 82: Signal channel | Pending |
| TGRM-01 | Phase 83: Telegram channel | Pending |
| TGRM-02 | Phase 83: Telegram channel | Pending |
| TGRM-03 | Phase 83: Telegram channel | Pending |
| TGRM-04 | Phase 83: Telegram channel | Pending |
| OPS-01 | Phase 84: Ops, onboarding and release | Pending |
| OPS-02 | Phase 84: Ops, onboarding and release | Pending |
| OPS-03 | Phase 84: Ops, onboarding and release | Pending |
| OPS-04 | Phase 84: Ops, onboarding and release | Pending |
| OPS-05 | Phase 84: Ops, onboarding and release | Pending |
| OPS-06 | Phase 84: Ops, onboarding and release | Pending |
| OPS-07 | Phase 84: Ops, onboarding and release | Pending |

Coverage: 134 of 134 active requirements of v0.5.0 and v0.7.0 Messaging relay (one milestone, numbered v0.7.0, until 2026-11-18) mapped, each to exactly one phase (Phase 68: 4 complete; Phases 69-84: 130 pending). RUNL-05 is retired. Amended 2026-11-15 with the identity design: CLAS-01 … CLAS-07 added to Phase 70, DLGT-08 and VCRD-01 … VCRD-07 added to Phase 71 (117 to 132); nothing was re-mapped. Amended 2026-11-16 by the owner: CLAS-08 (the trust badge) added to Phase 70 and CLAS-05 ratified with the pre-send connection check (132 to 133). Amended 2026-11-16 with the owner's agent authorization decisions: CRED-08 (signed, request-bound invocations checked by the broker) added to Phase 73 (133 to 134); nothing was re-mapped, and the L4 drafts ANCH-09 … ANCH-15 are not counted. Re-mapped on 2026-11-15 from the old numbering: AUTH from 69 to 75, IDNT from 70 to 76, RUNL-01/03 and TEAM from 71 to 77, SETUP from 71.1 to 78, BUDG from 72 to 79, RUNL-02/04/06/07 and CMND from 73 to 80, GRP from 74 to 81, SGNL from 75 to 82, TGRM from 75.1 to 83, OPS from 76 to 84. Split on 2026-11-18 with no re-mapping: 67 in v0.5.0 Governed agent platform (Phases 68-74) and 67 in v0.7.0 Messaging relay (Phases 75-84). Amended 2026-11-24 with the data-centric access direction: Phase 71 is re-scoped as "Identities and verified credentials (core)", pulled forward, and keeps DLGT-01 and VCRD-01 … VCRD-07; DLGT-02 … DLGT-08 move to the new Phase 71.1 (agent delegation, still in Stage 1); DCAC-01 … DCAC-06 are added to Phase 71 (134 to 140). Amended 2026-11-24 with the AI classification research: CLSF-01 … CLSF-05 are added to the new Phase 70.1 (classification engine) and CLSF-06 … CLSF-14 to the new Phase 74.3 (classification assistant) (140 to 154); nothing was re-mapped.

## Milestone v0.6.0: Data platform (Phases 85-101)

**Defined:** 2026-11-18 from the owner's requirements R1 to R11 and the design built on them (`.planning/research/data-platform/00-DESIGN.md`), which the owner accepted the same day: decisions 1 to 13 and the 32 settled-in-design choices as recommended, decision 14 changed to one-click connection, and collectors that are simple to install added. The draft (`01-DRAFT-MILESTONE.md`) had 106 requirements; adoption added SPIKE-09, CONN-01 … CONN-04, COLL-01 … COLL-06, KB-15 and FAC-09, and revised SPIKE-01, DATA-14, DATA-17, DATA-20, DSEC-10 and FAC-06 (119). Version set by the owner when the milestone starts.
**Core value:** Once installed, the platform finds your organization's data wherever it lives, keeps it in sync, describes and labels every item, and lets people and agents use it (search, ask, reports, specialists trained on your organization's own machines) only within their clearance and the source's own permissions, with people asked only on real exceptions.

> **Prefixes.** DSEC (data-centric security), not SEC: SEC-01 … SEC-04 are carried ids of the former v0.6.0 Team Mode branch plan, and the paused former v0.5.0 knowledge-base plan used SEC as well. CONN (one-click connection) is not CRED (Phase 73's credential broker) or VCRD (Phase 71's verifiable credentials). None of SPIKE, DATA, CONN, COLL, TAG, DSEC, MARK, HOLD, KB, FAC and OPP is used anywhere else in the plan or in the archive of the paused former v0.5.0 knowledge-base plan. SPIKE-01 and SPIKE-02 build the lasting host (L1a), not a throwaway.

> **Decisions.** "Decision N" means decision N of the design's section 10.1, as the owner answered it on 2026-11-18 (the roadmap's data platform section has a table of them).

### Host and spikes (Phases 85-87)

- [ ] **SPIKE-01**: A Compose stack on amd64 runs Postgres 18 with pgvector, pg_textsearch and RLS, DuckDB with DuckLake, the encrypted blob store, a sandboxed Python worker image and llama.cpp. Images are pinned by digest, install with one command from a signed offline bundle and start with no network. Postgres holds content in plaintext on an encrypted disk, with per-item keys for erasable content (decision 3). This is the lasting host (L1a), not a throwaway. *(Revised 2026-11-18: one-command install from the signed bundle, L1a.)*
- [ ] **SPIKE-02**: Local inference on the host is reachable from the extension through the existing hybrid provider as `local` models, with ROCm and Vulkan both measured.
- [ ] **SPIKE-03**: Measured on a fixed test set: embeddings in chunks per second, GLiNER spans per second, local LLM tokens per second for prompt and generation, LoRA on a 4B base in tokens per second with peak memory, and stability at a GPU memory fraction of 0.8 under a cgroup cap. The exact ROCm and PyTorch versions are recorded.
- [ ] **SPIKE-04**: Permission fidelity for SharePoint and OneDrive is measured with read scopes plus hierarchical sharing, against full control, and `Sites.Selected` is checked with and without broad file scopes.
- [ ] **SPIKE-05**: The delta `nextLink` lifetime over a multi-day backfill, a 410 resync on a large drive, and `immutableId` with message delta across folder moves are measured.
- [ ] **SPIKE-06**: A resource-unit budget model for a tenant of under 1,000 licences, plus reads of Purview sensitivity and retention labels (`extractSensitivityLabels`, LabelInfo, the 423 cases) and Exchange RBAC for Applications scoping, all checked against v1.0 permissions.
- [ ] **SPIKE-07**: On a fixed set of 1,000 pages (born-digital, clean scans, hard scans with tables and handwriting) and 10 hours of audio, Tika, the Docling standard and VLM pipelines, Tesseract or PP-OCRv5 on CPU, PaddleOCR-VL and granite-docling on GPU, and whisper.cpp large-v3-turbo are measured under ROCm and Vulkan.
- [ ] **SPIKE-08**: A page-difficulty router (tier 1 to tier 2 OCR) is built with its accuracy and cost recorded, and the licence of every model weight it uses is confirmed.
- [ ] **SPIKE-09**: The one-click Microsoft 365 setup is proven on the test tenant: one administrator sign-in, through a public client that holds no secret of ours, creates the app registration in the tenant, uploads a certificate generated on the host (the private key never leaves it) and grants admin consent for the least permissions, each with a reason; the app then adds its next certificate itself with no new sign-in; and nothing of the administrator's sign-in is stored. *(Added 2026-11-18 with decision 14 as changed.)*

### Discovery, connectors and ingestion (Phases 88-92, 100, 101)

- [ ] **DATA-01**: The connector contract (`RECORD`, `STATE`, `DELETE`, `ACL`, `LOG` messages), the connector runtime and per-partition cursors advanced in the same transaction as their batch.
- [ ] **DATA-02**: An item ledger with identity, version and derivative keys, idempotent upserts and an outbox for side effects.
- [ ] **DATA-03**: The source lifecycle (`proposed`, `approved`, `backfilling`, `live`, `degraded`, `paused`, `retired`), with every state, transition and reason visible.
- [ ] **DATA-04**: Three levels of reconciliation sweep, and automatic resync on any "missed something" signal.
- [ ] **DATA-05**: Reorgs at catalog level: a delete hides the item at once, a move or rename updates it in place, and a permission change recomputes the subtree before the next query.
- [ ] **DATA-06**: A filesystem connector on the host itself, as the reference connector.
- [ ] **DATA-07**: The inventory-only dry run, showing names, sizes, counts, types and owners before any content is read.
- [ ] **DATA-08**: The data map view in the extension, showing sources and items by type, size, owner, label and freshness, plus each source's status (phase, backfill progress, sync lag, processing backlog, last event, throttle state, coverage).
- [ ] **DATA-09**: Microsoft 365 site, drive and mailbox discovery, inventory-only first.
- [ ] **DATA-10**: Per-drive delta with hierarchical sharing and sharing-change annotations; the live cursor captured before backfill; the resource-unit budget; a global `Retry-After`; off-peak backfill.
- [ ] **DATA-11**: A separate identity sync (users and groups delta) on its own schedule.
- [ ] **DATA-12**: Mailbox delta with immutable ids, scoped by Exchange RBAC for Applications. Mail follows decision 6: off by default, and label-only (a card, no content, chunks or vectors) once your organization confirms its privacy assessment and employee notice.
- [ ] **DATA-13**: Purview sensitivity and retention labels read into `sourceLabels` and `retentionClass`; unreadable (423) and double-key items treated as the top level and metadata-only.
- [ ] **DATA-14**: The Google connector runs on the per-organization setup of CONN-03: a service account with domain-wide delegation for exactly the listed scopes, its credential held in the broker (short-lived or keyless where the research finds it workable). *(Revised 2026-11-18; was: domain-wide delegation set up with one pasted client id and scope list.)*
- [ ] **DATA-15**: `changes.list` per user and per shared drive, and Gmail `history.list`, with the cursor captured before backfill and a full resync on 404.
- [ ] **DATA-16**: Drive labels mapped; the Admin SDK used for identity sync; quotas checked in a test project before planning.
- [ ] **DATA-17**: A Rust collector on Windows (MFT enumeration plus the USN journal), running as a service with the rights it needs and installed by the COLL-01 package, with journal sizing advice. *(Revised 2026-11-18: installed by the package.)*
- [ ] **DATA-18**: A macOS collector (FSEvents with stored event ids, and a Full Disk Access profile from device management) and a Linux collector (fanotify, with inotify as the fallback).
- [ ] **DATA-19**: Sync roots and cloud placeholder attributes detected and skipped; operating system folders, caches and build outputs excluded by default.
- [ ] **DATA-20**: File shares read from the host over SMB and NFS with nothing installed on the file servers: directory enumeration, change notifications as hints only, and snapshot diffs as the feed; a collector on a file server is optional, for faster change detection; NTFS and POSIX permissions resolved through the directory. *(Revised 2026-11-18 for "agentless where possible"; was: a collector on the file server where possible.)*
- [ ] **DATA-21**: A mutually authenticated collector channel to the host, signed with device keys; a personal mark known from an item's location is honoured before fetching.
- [ ] **DATA-22**: A Tika and Docling router in sandboxed workers with no network and with size and time limits.
- [ ] **DATA-23**: Tiered OCR using the Phase 87 router, and whisper.cpp for audio and video.
- [ ] **DATA-24**: Content-addressed derivatives keyed by `(hash, extractor, version, options)`, so an item is extracted once across duplicates.
- [ ] **DATA-25**: Exact and near-duplicate detection (hash, MinHash).
- [ ] **DATA-26**: The bounded, encrypted re-extraction cache of decision 5 (on by default for scans, images and audio, capped at 10 percent of the host disk, kept 180 days), deleted along with its source item; a priority queue in which live changes pre-empt backfill; the spend governor (from paused Phase 18) on GPU work.
- [ ] **DATA-27**: A source catalog showing plain descriptions, exact scopes with their reasons, and an estimated backfill time.
- [ ] **DATA-28**: A declarative manifest schema of our own (auth, pagination, record selector, cursor, deletion signal, permission mapping).
- [ ] **DATA-29**: Agent-written connectors: manifest first, then sandboxed code; egress only to declared hosts; credentials injected by the broker; read-only scopes enforced by the broker.
- [ ] **DATA-30**: A conformance suite against recorded fixtures (pagination, resume, incremental, deletion, permission mapping, throttling, idempotent replay); a person approves a connector, and again for every later change.
- [ ] **DATA-31**: Databases: directory-first discovery; network scanning off by default; dlt backfill and Debezium CDC, with abandoned replication slots monitored; each database approved on its own.
- [ ] **DATA-32**: The importers carried from paused Phase 15 (CSV, STIX, GeoJSON) and the offline gazetteer.
- [ ] **DATA-33**: PIA and DPIA packs generated from catalog facts; monitoring-policy text; SECURITY.md and README updated (including plaintext on the host's encrypted disk and what clearances guarantee); the operator runbook for the host.

### One-click connection (Phases 89-91)

Added 2026-11-18 with decision 14 as changed ("easy from the start").

- [ ] **CONN-01**: One-click "Connect Microsoft 365". An administrator signs in once. Setup then creates your organization's own app registration in its own tenant, uploads a certificate generated on the host (the private key never leaves the host and is held in the credential broker), and grants admin consent for exactly the permissions the wizard listed with their reasons. The administrator's sign-in is used only during setup, held in memory and dropped when setup ends. No shared multi-tenant app that we publish is used or offered, because its publisher-held credential could reach every customer tenant.
- [ ] **CONN-02**: Every one-click connection keeps itself working and can be undone: its credential is rotated before expiry with no new sign-in; setup can be re-run and adds only what is missing; a setup cut off midway says what was done and what was not, reads nothing until it is finished, and finishes on re-run without duplicating anything; Disconnect lists what setup created and removes it only after the administrator confirms.
- [ ] **CONN-03**: One-click "Connect Google Workspace", the same pattern as CONN-01: an administrator signs in once; setup creates a project and a service account in your organization's own Google Cloud, enables only the needed APIs, creates the credential on the host and keeps it in the broker, and authorizes exactly the listed scopes for domain-wide delegation. A step Google allows only in its admin console is one prefilled page that setup opens and then checks. No shared app that we publish.
- [ ] **CONN-04**: One-click "Connect file shares": the host finds the SMB and NFS shares your organization publishes (its directory and DFS namespaces), an administrator picks them and signs in once, setup uses a dedicated read-only account kept in the broker, and the host reads the shares with nothing installed on the file servers.

### Collector packaging and enrolment (Phase 91)

Added 2026-11-18 (owner: collectors must be super simple to install).

- [ ] **COLL-01**: Endpoint collectors are small signed native packages, not containers: an MSI for Windows that Intune or Group Policy installs silently, a signed and notarized pkg for macOS that Jamf or Intune installs, .deb and .rpm packages for Linux, and a one-line install for machines without device management that checks the package signature before installing. The host itself is a container stack (SPIKE-01).
- [ ] **COLL-02**: Enrolment needs no configuration on the machine: your organization's device-management tools deliver an enrolment code issued by the host (an MSI property, a managed configuration profile, or an install argument). On first start the collector creates its own device key, enrols with the code and receives a device binding credential (VCRD-06), so nobody types anything on the machine. Codes are scoped to a device group, limited in number, expiring and revocable, and every newly enrolled device shows in the source list.
- [ ] **COLL-03**: Collectors update themselves from the host: signed updates, staged with rollback, and the host refuses a collector below the minimum version. An update never widens what is collected; that takes a change of policy.
- [ ] **COLL-04**: Each machine shows a local notice, in plain words, of what is collected from it, what is excluded and who can see it, with Mark as Personal available from the notice and from the file manager where the operating system allows it.
- [ ] **COLL-05**: Agentless where possible: Microsoft 365, Google Workspace and SMB or NFS shares are read from the host with no software on endpoints or file servers; a collector is needed only for files that live only on endpoints.
- [ ] **COLL-06**: A collector stays small and can be removed cleanly: low CPU, memory and network budgets, paused on battery and metered connections by default; revoking its device credential or removing the device in device management stops collection at its next contact; uninstalling removes the collector and its local state; the host shows the source as `paused` or `retired` with the reason.

### Classification and metadata (Phase 93)

- [ ] **TAG-01**: Tier 0 detectors, including checksum-backed Canadian identifiers written by us in English and French, and the gitleaks rules (secret values are never stored).
- [ ] **TAG-02**: Tier 1: the union of GLiNER spans and a second Apache-2.0 classifier, plus language and an embedding.
- [ ] **TAG-03**: Tier 2: a local LLM (three samples, majority vote, constrained JSON, policy never in the prompt) only for unsettled, sampled or about-to-be-used items, under a run contract.
- [ ] **TAG-04**: The full item card of design section 5. Owner and steward come from source metadata and the directory, never from a model.
- [ ] **TAG-05**: Privacy facts (design section 5, privacy layer), stored as facts, never as the personal data itself.
- [ ] **TAG-06**: Training-suitability fields, where `rights.basis = unknown` means not allowed; TDMRep reservations read.
- [ ] **TAG-07**: The policy wizard (scales, source label map, ingest default, rules, scope exclusions), with a mandatory shadow simulation before any rule is signed.
- [ ] **TAG-08**: A weekly stratified blind sampling audit reporting precision and recall per level, with thresholds re-fitted from it.

### Data-centric security (Phases 88, 93, 94, 101)

- [ ] **DSEC-01**: RLS on every table of the governed store, with `FORCE ROW LEVEL SECURITY`; the clearance is set only through a short-lived gate-signed token checked by a security-definer function, never by a plain `SET`, and the application role cannot bypass it.
- [ ] **DSEC-02**: The `source.acl` layer in `decide` after the label check (an agent's access is its clearance, intersected with the person's clearance and the person's source permissions), a directory snapshot with group expansion at query time, and fail-closed handling of permission snapshots older than the limit (24 hours by default).
- [ ] **DSEC-03**: The ingest-default label on every discovered item, and the governance log (paused Phase 13's log with envelope v2) recording every label, permission and lifecycle event.
- [ ] **DSEC-04**: Classification rules and the source label map in the signed bundle; the pure `classify.ts`; label v2 with the handling flags `no-train` and `no-summarize-down`. Automatic steps only ever raise a label.
- [ ] **DSEC-05**: A signed Merkle root per sync batch over item labels.
- [ ] **DSEC-06**: The exception queue, ordered by impact and grouped by steward into a weekly batch, with bulk actions on clusters and "could be lower" suggestions; lowering happens only through a signed `lowerByPerson`.
- [ ] **DSEC-07**: Aggregation rules on indexes, exports, datasets and a chat's running count of distinct items.
- [ ] **DSEC-08**: The derivative cascade along `derivedFrom`, purged after the source's restore window; datasets marked "contains revoked items"; crypto-shredding with per-item keys (from paused Phase 13).
- [ ] **DSEC-09**: A signed erasure proof listing every derivative removed.
- [ ] **DSEC-10**: A retention class per item, which its derivatives follow (decision 10), and a ROT report (report only; disposition is always a person's decision). *(Revised 2026-11-18: derivatives follow the class.)*
- [ ] **DSEC-11**: The canary scan and the network spy across every flow, including the database, caches, model server logs and training jobs.
- [ ] **DSEC-12**: The indistinguishability test across every view, count, answer, dashboard and specialist.
- [ ] **DSEC-13**: A scale test at 1 million items and 10 million mail headers on one host, within recorded budgets.

### Personal mark (Phase 94)

- [ ] **MARK-01**: Mark as Personal on files, folders and personal areas, signed by the person's device key and refused at once with a reason where policy forbids it; agents cannot set a mark.
- [ ] **MARK-02**: A marked item keeps only the existence record of research report 02 section 10.3; its existing derivatives are removed unless a hold covers them.
- [ ] **MARK-03**: Unmarking re-enters the item at the ingest default, and its label is never lower than before.
- [ ] **MARK-04**: The personal-mark policy in the bundle, with the defaults of decision 8: allowed in a person's own areas only; 5 GB and 20,000 items per person; location-only mode off; notice at override time, with any delay at most 90 days and recorded.
- [ ] **MARK-05**: Abuse signals computed from existence records and metadata only, with stepped escalation (a private notice, then counts for the privacy officer, then sampling only under an override).

### Legal holds and requests (Phase 95)

- [ ] **HOLD-01**: The hold lifecycle of design section 4.3, with per-source confirmation and a visible `partial` state that never times out silently.
- [ ] **HOLD-02**: Holds applied through Purview eDiscovery and Vault where available (manual import first), plus our write-once hold store with signed manifests for sources without a hold feature.
- [ ] **HOLD-03**: A hold check in every deletion path (sync propagation, retention, ROT, CleanUp, dataset and model deletion), carried along lineage.
- [ ] **HOLD-04**: Change attempts on held items recorded as `hold.change-observed`; custodian notices with signed acknowledgment, reminders and release notices.
- [ ] **HOLD-05**: The request lifecycle of design section 4.4, with regime deadline rules held as data in the signed bundle, extensions recorded only after their notice, and warnings at 50, 80 and 95 percent of the time.
- [ ] **HOLD-06**: Subject resolution to identifiers; searches of our indexes plus live source searches that record cursor age; lineage followed to derivatives and models.
- [ ] **HOLD-07**: Redaction proposals confirmed one by one with exemption codes, burned in, with a redaction log.
- [ ] **HOLD-08**: Release as a signed package declassification, with the manifest root signed and an append-only custody log.
- [ ] **HOLD-09**: A request-scoped, time-boxed grant; recusal; the two-person rule above the officer's clearance; agents propose and never decide.
- [ ] **HOLD-10**: The personal-mark override of design section 4.5, with `notice-pending` visible to the privacy officer, and the coverage statement of research report 02 section 9.5 for every hold and request.

### Knowledge layer (Phases 96-97)

- [ ] **KB-01**: Chunks and embeddings carry their item's label; hybrid BM25 and vector search with reciprocal-rank fusion and reranking, filtered inside the scan; recall tested at low clearance.
- [ ] **KB-02**: Tier 0 entity tagging and noun-phrase co-occurrence; evidence rows pointing to exact spans; entities and edges with no stored attributes, computed at read time from the rows the reader may see.
- [ ] **KB-03**: Entity resolution (deterministic keys, blocking, Splink or an LLM group judge) as reversible proposals with undo; each link labelled with the join of both sides.
- [ ] **KB-04**: Tier 1 LLM relation extraction with verified quotes, queued under the spend governor for priority items only.
- [ ] **KB-05**: The knowledge-base panel shell (strict CSP, capped results, from paused Phase 15): data map, search, item and entity pages.
- [ ] **KB-06**: An ask agent with `catalog.search`, `catalog.describe`, `catalog.lineage`, graph neighbourhood and timeline tools. Every sentence cites items, the answer carries its high-water label, and the model is routed by that label.
- [ ] **KB-07**: No side channels: no hidden counts, caches keyed by clearance, no summaries across labels.
- [ ] **KB-08**: The two-compartment indistinguishability test extended to search, entity pages, facets, autocomplete and answers.
- [ ] **KB-09**: Automatic dashboards (Mosaic, Perspective) fed by host-built, label-filtered results; DuckLake analytics tables written per label cell and read only by the query service.
- [ ] **KB-10**: Natural-language questions turned into SQL over curated views, parsed and allowlisted, run under RLS, and always shown with their SQL.
- [ ] **KB-11**: Suggested insights, each with its query: new or fast-growing entities, unusual volume, new connections, possible oversharing, stale data and unclassified items.
- [ ] **KB-12**: Reports carried from ReportBuilder and ReportVerifier, carrying their high-water label and failing verification if any figure differs from the store.
- [ ] **KB-13**: A graph explorer with saved scopes (slices) and the RAFT profile, plus timeline replay ("as known at T"), with the slice cap and a truncation notice.
- [ ] **KB-14**: A label-change impact preview ("what changes if this label changes").
- [ ] **KB-15**: Your organization may turn on, per scale, "existence only" placeholders (decision 7): a search or entity page then shows that an item exists, with its steward and a request-access button, only for items whose discovery description a person approved. It is off by default, so strict indistinguishability holds unless your organization opts in, and the indistinguishability test covers both settings. *(Added 2026-11-18: no draft requirement built decision 7's opt-in.)*

### Model factory (Phase 98)

- [ ] **FAC-01**: A trainer worker in a pinned container, driven by job specs, with a heartbeat, checkpoints and resume, a GPU memory fraction of 0.8 or less, a cgroup cap and one heavy job at a time; a training job reaches no network destination outside the machine it runs on.
- [ ] **FAC-02**: A licence registry for bases and teachers; Llama-licensed bases blocked by default; teacher terms recorded per dataset.
- [ ] **FAC-03**: A dataset builder over the sealed thread store (outcome filter, Presidio scrub, dedup, decontamination, time-and-source split, golden set) producing a manifest with record-level hashes; the dataset's label is the join of its inputs. The first specialist uses chat and run logs only (decision 13).
- [ ] **FAC-04**: An evaluator using the extension's graders, a golden set, a regression subset and a memorisation probe, with the gates of research report 04 section 6.2.
- [ ] **FAC-05**: A registrar writing a sealed model card (label, lineage, licence, evaluation, approvals, deletion log); the specialist registered as a `local` model.
- [ ] **FAC-06**: A router covering shadow, canary and live by role or tier, with automatic rollback triggers and one-click rollback. One click approves a specialist up to shadow and a second click is needed for canary; auto-promotion is off by default and only policy turns it on (decision 12). *(Revised 2026-11-18: the two clicks.)*
- [ ] **FAC-07**: The specialist lifecycle of design section 4.6, with every stuck-state guard.
- [ ] **FAC-08**: Serving gated on dominance (the session's clearance must dominate the model's label), with fallback to the incumbent when the host is down.
- [ ] **FAC-09**: Training runs only on your organization's own machines or hardware endpoints it controls, each listed as a training target in the signed policy (the host first); a job naming any other target, or a training service, is refused before it starts. Teacher inference that writes training targets follows the label's routing (local, or attested NEAR AI TEE models where the label allows; decision 11); it is inference, never training. *(Added 2026-11-18, owner.)*

### Opportunity agent (Phase 99)

- [ ] **OPP-01**: A signal collector over the spend ledger, activity history, approvals, edits and benchmark results, reading metadata only.
- [ ] **OPP-02**: Signature clustering, plus content clustering under the standing signed policy for your organization's lowest level, or above it after an approval whose clearance dominates the data.
- [ ] **OPP-03**: Scoring (value, feasibility gates, risk) and the one-click proposal card of research report 04 section 7.4, naming who can approve.
- [ ] **OPP-04**: Data-gap planning (design section 3.6): when a feasibility gate fails, a data plan with ranked options, each its own card, with only counts for blocked or marked items.
- [ ] **OPP-05**: Process-level opportunities from run and business event logs, using a TypeScript directly-follows graph and variant counts; usage is aggregated to groups and no person is scored.
- [ ] **OPP-06**: Specialists from organization data built through `dataset.assemble` (training-allowed items only, opt-in per source or collection, signed), one compartment at a time.
- [ ] **OPP-07**: Deletion-triggered retraining: a touched model moves to `retrain-required` with the 30-day deadline of decision 9, and traffic falls back to the incumbent when the deadline passes.

### Traceability (data platform)

| Requirement | Phase | Status |
|-------------|-------|--------|
| SPIKE-01 | Phase 85: Host and local inference on Strix Halo (L1a), measured | Pending |
| SPIKE-02 | Phase 85: Host and local inference on Strix Halo (L1a), measured | Pending |
| SPIKE-03 | Phase 85: Host and local inference on Strix Halo (L1a), measured | Pending |
| SPIKE-04 | Phase 86: Microsoft 365 connector spike | Pending |
| SPIKE-05 | Phase 86: Microsoft 365 connector spike | Pending |
| SPIKE-06 | Phase 86: Microsoft 365 connector spike | Pending |
| SPIKE-07 | Phase 87: Extraction and OCR throughput spike | Pending |
| SPIKE-08 | Phase 87: Extraction and OCR throughput spike | Pending |
| SPIKE-09 | Phase 86: Microsoft 365 connector spike | Pending |
| DATA-01 | Phase 88: Ingestion core, governed store and the data map | Pending |
| DATA-02 | Phase 88: Ingestion core, governed store and the data map | Pending |
| DATA-03 | Phase 88: Ingestion core, governed store and the data map | Pending |
| DATA-04 | Phase 88: Ingestion core, governed store and the data map | Pending |
| DATA-05 | Phase 88: Ingestion core, governed store and the data map | Pending |
| DATA-06 | Phase 88: Ingestion core, governed store and the data map | Pending |
| DATA-07 | Phase 88: Ingestion core, governed store and the data map | Pending |
| DATA-08 | Phase 88: Ingestion core, governed store and the data map | Pending |
| DATA-09 | Phase 89: Microsoft 365 connector with one-click connection | Pending |
| DATA-10 | Phase 89: Microsoft 365 connector with one-click connection | Pending |
| DATA-11 | Phase 89: Microsoft 365 connector with one-click connection | Pending |
| DATA-12 | Phase 89: Microsoft 365 connector with one-click connection | Pending |
| DATA-13 | Phase 89: Microsoft 365 connector with one-click connection | Pending |
| DATA-14 | Phase 90: Google Workspace connector with one-click connection | Pending |
| DATA-15 | Phase 90: Google Workspace connector with one-click connection | Pending |
| DATA-16 | Phase 90: Google Workspace connector with one-click connection | Pending |
| DATA-17 | Phase 91: Endpoint collectors, file shares and simple install | Pending |
| DATA-18 | Phase 91: Endpoint collectors, file shares and simple install | Pending |
| DATA-19 | Phase 91: Endpoint collectors, file shares and simple install | Pending |
| DATA-20 | Phase 91: Endpoint collectors, file shares and simple install | Pending |
| DATA-21 | Phase 91: Endpoint collectors, file shares and simple install | Pending |
| DATA-22 | Phase 92: Extraction pipeline | Pending |
| DATA-23 | Phase 92: Extraction pipeline | Pending |
| DATA-24 | Phase 92: Extraction pipeline | Pending |
| DATA-25 | Phase 92: Extraction pipeline | Pending |
| DATA-26 | Phase 92: Extraction pipeline | Pending |
| DATA-27 | Phase 100: Easy sources: catalog, manifest connectors, agent-written connectors, databases | Pending |
| DATA-28 | Phase 100: Easy sources: catalog, manifest connectors, agent-written connectors, databases | Pending |
| DATA-29 | Phase 100: Easy sources: catalog, manifest connectors, agent-written connectors, databases | Pending |
| DATA-30 | Phase 100: Easy sources: catalog, manifest connectors, agent-written connectors, databases | Pending |
| DATA-31 | Phase 100: Easy sources: catalog, manifest connectors, agent-written connectors, databases | Pending |
| DATA-32 | Phase 100: Easy sources: catalog, manifest connectors, agent-written connectors, databases | Pending |
| DATA-33 | Phase 101: End-to-end hardening and release | Pending |
| CONN-01 | Phase 89: Microsoft 365 connector with one-click connection | Pending |
| CONN-02 | Phase 89: Microsoft 365 connector with one-click connection | Pending |
| CONN-03 | Phase 90: Google Workspace connector with one-click connection | Pending |
| CONN-04 | Phase 91: Endpoint collectors, file shares and simple install | Pending |
| COLL-01 | Phase 91: Endpoint collectors, file shares and simple install | Pending |
| COLL-02 | Phase 91: Endpoint collectors, file shares and simple install | Pending |
| COLL-03 | Phase 91: Endpoint collectors, file shares and simple install | Pending |
| COLL-04 | Phase 91: Endpoint collectors, file shares and simple install | Pending |
| COLL-05 | Phase 91: Endpoint collectors, file shares and simple install | Pending |
| COLL-06 | Phase 91: Endpoint collectors, file shares and simple install | Pending |
| TAG-01 | Phase 93: Classification, labels, privacy assessment and exceptions | Pending |
| TAG-02 | Phase 93: Classification, labels, privacy assessment and exceptions | Pending |
| TAG-03 | Phase 93: Classification, labels, privacy assessment and exceptions | Pending |
| TAG-04 | Phase 93: Classification, labels, privacy assessment and exceptions | Pending |
| TAG-05 | Phase 93: Classification, labels, privacy assessment and exceptions | Pending |
| TAG-06 | Phase 93: Classification, labels, privacy assessment and exceptions | Pending |
| TAG-07 | Phase 93: Classification, labels, privacy assessment and exceptions | Pending |
| TAG-08 | Phase 93: Classification, labels, privacy assessment and exceptions | Pending |
| DSEC-01 | Phase 88: Ingestion core, governed store and the data map | Pending |
| DSEC-02 | Phase 88: Ingestion core, governed store and the data map | Pending |
| DSEC-03 | Phase 88: Ingestion core, governed store and the data map | Pending |
| DSEC-04 | Phase 93: Classification, labels, privacy assessment and exceptions | Pending |
| DSEC-05 | Phase 93: Classification, labels, privacy assessment and exceptions | Pending |
| DSEC-06 | Phase 93: Classification, labels, privacy assessment and exceptions | Pending |
| DSEC-07 | Phase 93: Classification, labels, privacy assessment and exceptions | Pending |
| DSEC-08 | Phase 94: Lifecycle, erasure and the personal mark | Pending |
| DSEC-09 | Phase 94: Lifecycle, erasure and the personal mark | Pending |
| DSEC-10 | Phase 94: Lifecycle, erasure and the personal mark | Pending |
| DSEC-11 | Phase 101: End-to-end hardening and release | Pending |
| DSEC-12 | Phase 101: End-to-end hardening and release | Pending |
| DSEC-13 | Phase 101: End-to-end hardening and release | Pending |
| MARK-01 | Phase 94: Lifecycle, erasure and the personal mark | Pending |
| MARK-02 | Phase 94: Lifecycle, erasure and the personal mark | Pending |
| MARK-03 | Phase 94: Lifecycle, erasure and the personal mark | Pending |
| MARK-04 | Phase 94: Lifecycle, erasure and the personal mark | Pending |
| MARK-05 | Phase 94: Lifecycle, erasure and the personal mark | Pending |
| HOLD-01 | Phase 95: Legal holds and access requests | Pending |
| HOLD-02 | Phase 95: Legal holds and access requests | Pending |
| HOLD-03 | Phase 95: Legal holds and access requests | Pending |
| HOLD-04 | Phase 95: Legal holds and access requests | Pending |
| HOLD-05 | Phase 95: Legal holds and access requests | Pending |
| HOLD-06 | Phase 95: Legal holds and access requests | Pending |
| HOLD-07 | Phase 95: Legal holds and access requests | Pending |
| HOLD-08 | Phase 95: Legal holds and access requests | Pending |
| HOLD-09 | Phase 95: Legal holds and access requests | Pending |
| HOLD-10 | Phase 95: Legal holds and access requests | Pending |
| KB-01 | Phase 96: Search, context graph, entity pages and ask | Pending |
| KB-02 | Phase 96: Search, context graph, entity pages and ask | Pending |
| KB-03 | Phase 96: Search, context graph, entity pages and ask | Pending |
| KB-04 | Phase 96: Search, context graph, entity pages and ask | Pending |
| KB-05 | Phase 96: Search, context graph, entity pages and ask | Pending |
| KB-06 | Phase 96: Search, context graph, entity pages and ask | Pending |
| KB-07 | Phase 96: Search, context graph, entity pages and ask | Pending |
| KB-08 | Phase 96: Search, context graph, entity pages and ask | Pending |
| KB-09 | Phase 97: Analytics, reports, insights and views | Pending |
| KB-10 | Phase 97: Analytics, reports, insights and views | Pending |
| KB-11 | Phase 97: Analytics, reports, insights and views | Pending |
| KB-12 | Phase 97: Analytics, reports, insights and views | Pending |
| KB-13 | Phase 97: Analytics, reports, insights and views | Pending |
| KB-14 | Phase 97: Analytics, reports, insights and views | Pending |
| KB-15 | Phase 96: Search, context graph, entity pages and ask | Pending |
| FAC-01 | Phase 98: Model factory v1, first specialist from chat and run logs | Pending |
| FAC-02 | Phase 98: Model factory v1, first specialist from chat and run logs | Pending |
| FAC-03 | Phase 98: Model factory v1, first specialist from chat and run logs | Pending |
| FAC-04 | Phase 98: Model factory v1, first specialist from chat and run logs | Pending |
| FAC-05 | Phase 98: Model factory v1, first specialist from chat and run logs | Pending |
| FAC-06 | Phase 98: Model factory v1, first specialist from chat and run logs | Pending |
| FAC-07 | Phase 98: Model factory v1, first specialist from chat and run logs | Pending |
| FAC-08 | Phase 98: Model factory v1, first specialist from chat and run logs | Pending |
| FAC-09 | Phase 98: Model factory v1, first specialist from chat and run logs | Pending |
| OPP-01 | Phase 99: Opportunity agent, data-gap planning and specialists from organization data | Pending |
| OPP-02 | Phase 99: Opportunity agent, data-gap planning and specialists from organization data | Pending |
| OPP-03 | Phase 99: Opportunity agent, data-gap planning and specialists from organization data | Pending |
| OPP-04 | Phase 99: Opportunity agent, data-gap planning and specialists from organization data | Pending |
| OPP-05 | Phase 99: Opportunity agent, data-gap planning and specialists from organization data | Pending |
| OPP-06 | Phase 99: Opportunity agent, data-gap planning and specialists from organization data | Pending |
| OPP-07 | Phase 99: Opportunity agent, data-gap planning and specialists from organization data | Pending |

Coverage: 119 of 119 data platform requirements mapped, each to exactly one phase, all pending (SPIKE 9, DATA 33, CONN 4, COLL 6, TAG 8, DSEC 13, MARK 5, HOLD 10, KB 15, FAC 9, OPP 7; 17 phases). Nothing in v0.5.0 or v0.7.0 was re-mapped.

## Phase 25 requirements: Cybersecurity harness (milestone v0.8.0)

**Defined:** 2026-10-30
**Core value:** A user picks a target, accepts a plain legal-use statement, and gets a reproducible offensive and defensive security assessment that the model plans, runs, verifies, and reports — with every intrusive action approved, recorded, and replayable.

### Engagement and target selection

- [ ] **CYBER-01**: A user selects a target from a dedicated Cybersecurity view: a workspace folder, a URL/host/IP, a CIDR range, a git repository, or a local container. The resolved scope (hosts, ports, paths, exclusions) is shown before anything is sent, and modes that exceed the resolved scope are disabled with a reason.
- [ ] **CYBER-02**: An engagement is recorded in `.planning/security/` with target, authorization statement, allowed modes, window, rate limit, exclusions, sandbox, and the accepted disclaimer (region, timestamp, extension version); it is immutable once a run starts, and every run names its engagement.
- [ ] **CYBER-03**: Before any probe leaves the machine the user accepts a legal-use disclaimer that names the region's law in plain language and states that the user owns the target or is authorized to test it; the interactive path is a modal and records the answer, and declining leaves the target untouched.

### Models and protocol

- [ ] **CYBER-04**: The harness drives NEAR AI models through a structured tool protocol that works with a raw-completion abliterated model that has no native tool calling: parse repair, bounded retries, and context compaction, with a visible failure when a model cannot follow the protocol.
- [ ] **CYBER-05**: Independent planner, operator, critic, and reporter roles work from one engagement, and the critic marks a finding unverified unless a reproduction command or captured evidence supports it.

### Defensive scanning

- [ ] **CYBER-06**: A defensive scan covers recon, HTTP headers and security policy, TLS and certificates, DNS, exposed paths, committed secrets, dependency and IaC findings (reusing the OSV scanner), and maps results to CVE, CWE, and OWASP with hardening advice.
- [ ] **CYBER-07**: A defensive scan of a clean target reports no findings from the seeded issue set, so false positives are measured rather than assumed.

### Offensive scanning

- [ ] **CYBER-08**: An offensive scan fingerprints the target, discovers candidate vulnerabilities, selects or develops an exploit, runs it in the sandbox, verifies access with captured evidence, records a minimal post-exploitation proof, and cleans up after itself.
- [ ] **CYBER-09**: An offensive run reports honestly when no exploit works, and distinguishes "not vulnerable", "could not determine", and "exploit failed" in the report.

### Safety and audit

- [ ] **CYBER-10**: Every active or intrusive action passes the existing permission and capability policy and is rate-limited, timed out, and scoped to the engagement; a stop control halts a run within one tool call.
- [ ] **CYBER-11**: The engagement ledger is append-only and records each step's tool, arguments, result, and model reasoning, so a run can be replayed tool-for-tool and audited by a second person.
- [ ] **CYBER-12**: Findings export as Markdown, JSON, and SARIF, carry evidence, reproduction commands, severity, and a diff against the previous run of the same engagement, and the UI states which host tools were missing so an empty result is never read as clean.

---

The 55 requirements of the former v0.5.0 knowledge-base plan (trusted-source knowledge base, paused, its number reassigned on 2026-11-18) are archived in `.planning/milestones/v0.5.0-paused/REQUIREMENTS.md`. Its knowledge base returns as the viewing layer of v0.6.0 Data platform (owner, 2026-11-18): the data platform requirements above take over from its ids, and ROADMAP.md (data platform section) records what happened to each paused phase.

## Phase 26 requirements: Performance — faster agent and research runs

**Defined:** 2026-11-10
**Core value:** A research project (or any long agent run) finishes in hours, not days, without weakening a single approval protection.

- [x] **PERF-01**: No approval stalls. Sub-agents auto-approve read-only and verification commands (tests, lint, typecheck, gate scripts the plan names, `git status/log/diff/show`) and commands that write only inside the run's own worktree, using the existing safety rules; pushes, deletes outside the worktree, publishing and credential paths still ask. An approval that is needed returns "awaiting approval" to the agent after a short, configurable wait, stays queued for the user, and notifies them; three consecutive approval timeouts pause the run with a clear message.
- [x] **PERF-02**: Context discipline. Compaction at about 60–80k tokens (configurable); large file reads default to ranges; each GSD plan, task or research workstream runs as a sub-agent with fresh context and returns a bounded summary; the system and tool prefix is stable and history append-only so NEAR's prompt cache can hit; `cached_tokens` is recorded in the activity log; a test proves the prefix is byte-stable across turns.
- [x] **PERF-03**: Models by tier, with deadlines. A model-call deadline (default about 120 s, configurable) retries on a backup model, reusing the safety check's second-model pattern; tier routing resolves planner, verifier, analyst, editor and red-team roles to `deep` and bulk fetch and extract roles to `fast` (routing and plumbing only; the role tiers themselves are set on feat/pdf-docx-output).
- [x] **PERF-04**: Parallelism. WebFetch, WebSearch and CheckCitations run concurrently; read-only shell commands run in a pool beside the serial mutating shell; the orchestrator fans out independent members or workstreams in parallel worktrees under a configurable cap; the system prompt tells agents to batch independent tool calls in one turn.
- [x] **PERF-05**: Survive reloads. Runs cut off by a VS Code reload resume automatically with a visible notice and a setting to turn it off; resumed runs do not repeat completed tool calls.
- [x] **PERF-06**: Research-mode GSD profile. Research and writing projects use bigger phases and quick mode for content edits; the plan-checker runs only for plans that change gates or verifiers; research projects get a scaffold of deterministic verifier scripts (citation resolution, figure recompute, internal-path leak check). Implemented through `src/gsd/` and project-type guidance without editing role definitions.
- [x] **PERF-07**: Measurement. The activity log's 100-event cap per session is replaced by a size bound; each run records wall time split into model wait, tool time, approval wait and idle, with input, cached and output tokens; a report command prints that breakdown for a project; the before baseline from two real projects is in the phase VERIFICATION.

| Requirement | Plan |
|-------------|------|
| PERF-01 | 26-02 |
| PERF-02 | 26-03 |
| PERF-03 | 26-03 |
| PERF-04 | 26-04 |
| PERF-05 | 26-04 |
| PERF-06 | 26-05 |
| PERF-07 | 26-01 |

## Phase 27 requirements: Project state follows the project (0.4.20)

**Defined:** 2026-11-13
**Core value:** Whatever interface or machine a person opens a project on, they pick up where they left off: no lost chats, no profile set up again, no paying to redo comparisons. Anything that leaves the machine is encrypted end to end.

- [x] **SYNC-01**: Project-local state home. Every chat thread with its full conversation history (all messages, in order, never truncated or summarised away; the 5 most recent threads stay live by default, adjustable by a user setting, and older threads are archived, never deleted, and reopenable in full), run records, checkpoints, comparison runs, applied model choices, the project's spend history and the resume pointer live in a git-ignored folder inside the project, shared by every editor that opens it on this machine.
- [x] **SYNC-02**: Safe migration. On first start of 0.4.20 each editor merges its own existing storage for the project into the state home by record id; the merge is idempotent, never overwrites a newer record and never deletes the source.
- [x] **SYNC-03**: Portable encryption. Transcripts are encrypted with a per-project data key that is wrapped per device in SecretStorage and by the recovery-code key; transcripts under an install-local key are re-encrypted by the editor that holds that key.
- [x] **SYNC-04**: Recovery code. A high-entropy code is shown once when sync is turned on and is never stored or logged; a strong KDF derives the wrapping key; the NEAR AI key travels wrapped; a wrong code and a tampered or truncated bundle are refused with a plain message and leave state untouched (tested).
- [x] **SYNC-05**: Cross-machine sync over the project's git remote. An encrypted bundle on a dedicated branch (never `main`), written without touching the person's working tree, index or current branch. Records from two machines merge with no lost entries (tested), and a leak test proves no plaintext transcript, key, prompt, title or record id reaches the remote (file names, paths, commit messages and branch names included). Everything pushed is end-to-end encrypted so only the user (recovery code or an unlocked device of theirs) can open it; no key escrow. Sync commits use a generic author/committer identity, never the person's git name or email. The remote is a parameter of the sync layer (a private-remote setting is specified but deferred). All of it is reported in plain words.
- [x] **SYNC-06**: Model choices follow the project. Comparison runs show in Compare Models in every interface; "Apply recommended" takes effect at project level in every interface without re-running; choices applied globally before 0.4.20 are offered for import.
- [x] **SYNC-07**: Pick up where you left off. Opening the project on a different interface or machine shows the last chat, the last run's state and the current GSD phase with its next step; one click reopens it; nothing re-runs or spends money.
- [x] **SYNC-09**: Online home in one click. A project with no git repo or no remote is offered "Give this project an online home". One click runs `git init` if needed, signs in to GitHub through VS Code, asks public or private (with plain notes on free-plan limits and visibility), creates the repo, adds the remote and pushes the sync branch. Pushing the person's own code is a separate offer behind a check for likely secrets. If GitHub sign-in is not available, the fallbacks are the `gh` CLI or pasting an existing repo URL. Everything is reported in plain words and nothing happens without the click.
- [x] **SYNC-08**: Release 0.4.20 through the release PR, with CHANGELOG and README (Marketplace listing) updated. *(Met 2026-11-14: feature PR #40 and release PR #41, tag v0.4.20. The owner's real-host check in 27-16 is a record item, not this requirement.)*

## Phase 28 requirements: Secure development workflow setup step (0.4.x)

**Defined:** 2026-11-15 from the owner's plan of 2026-11-05.
**Core value:** A person with no git knowledge gets a protected way of working (checks, an independent review, releases behind their approval) in one guided step.

- [ ] **DEVF-01**: Project Setup for a software project offers a "Secure development workflow" step in plain words; it is skippable, shows as done when done, can be reopened, and the DevOps member carries it out.
- [ ] **DEVF-02**: The step installs this repository's own kit adapted to the project: CI on every pull request (tests, secret scan, dependency audit) as required checks, the separate-reviewer automatic review gate with the owner's approval for changes to the gate, the merge, tag and release workflow with publishing behind the owner's approval, and the bootstrap.
- [ ] **DEVF-03**: Nothing outside the repository is changed by an agent and no token is asked for or stored: branch protection, environments and secrets are written as exact commands for the person to approve and run, and the step checks afterwards and says what is still missing.
- [ ] **DEVF-04**: Re-running the step on a project that already has part of the kit adds only what is missing and never overwrites the person's own workflow files without showing the difference first.

| Requirement | Phase |
|-------------|-------|
| DEVF-01 … DEVF-04 | Phase 28 |

## Phase 29 requirements: A cleanup member with a safe CleanUp tool (0.4.x)

**Defined:** 2026-11-15 from the owner's design of 2026-11-05.
**Core value:** Agents' leftovers stop filling disk and memory, and nothing important or in use is ever deleted.

- [ ] **CLEAN-01**: CleanUp offers as candidates only items the extension recorded as created by agent runs, or a short built-in list of known-disposable locations.
- [ ] **CLEAN-02**: Never-touch rules are checked in code and are part of the gate's floor (GATE-05): tracked files and files deliberately kept, `.git`, `.env*`, keys and credentials (including the person's NEAR key folder in their home folder), `.planning`, anything outside the project and the system temp area, anything changed in the last hour, and anything a running process has open or uses as its folder; links out, `..`, the home folder and over-broad patterns are refused.
- [ ] **CLEAN-03**: Nothing is deleted at once: items go to a recoverable quarantine with a manifest, a Restore command brings them back, and a purge happens only after a retention window of about 7 days.
- [ ] **CLEAN-04**: A dry-run list comes first, and the person confirms anything not on the known-disposable list, anything large or of unknown origin, and every permanent purge.
- [ ] **CLEAN-05**: The cleanup member gets only CleanUp and read-only tools (no Bash, no Write), and a disaster test proves each never-touch rule.

| Requirement | Phase |
|-------------|-------|
| CLEAN-01 … CLEAN-05 | Phase 29 |

## Phases 30 to 35 requirements: Multi-user staff workspaces (0.4.x, staff collaboration drops A and B)

**Defined:** 2026-11-19 from `.planning/research/multiuser-sync/DESIGN.md` (section 18), added when Phase 30 was planned.
**Core value:** Several people work one staff project at once from their own machines, co-edit products with every change attributed, and decide with signed, verifiable decisions, online through your organization's sync hub or offline.

- [ ] **MUS-01**: Per-writer signed hash-chained logs, deterministic fold and state digest; equivocation proven and quarantined.
- [ ] **MUS-02**: Product text co-edited through Yjs inside signed entries, with unforgeable attribution.
- [ ] **MUS-03**: Versions pin a content hash; contested decisions need a fresh decision; agents never decide.
- [ ] **MUS-04**: Genesis, linear single-writer roster, join by signed file with a safety code.
- [ ] **MUS-05**: Per-cell keys wrapped to cleared devices; rekey on removal.
- [ ] **MUS-06**: Verified, idempotent migration of today's ledgers; unchanged behaviour for projects that stay single-machine.
- [x] **MUS-07**: The hub as its own Compose service: append checks, live push, presence, checkpoints, invitations.
- [x] **MUS-08**: Malicious-hub detection, rollback refusal, ciphertext only for ungranted cells, operator backup and restore.
- [ ] **MUS-09**: Live multi-user staff projects in the extension: editor binding, presence, sync states, contested UI, docs.
- [ ] **MUS-10**: Git per-writer refs, sealed bundle files and LAN peer links, converging with the hub.
- [ ] **MUS-11**: Shared run summaries and claims; observation slices with coalescing and budgets.
- [ ] **MUS-12**: Standing watches on the hub under draft-only, rate, spend, route and kill-switch guards.
- [ ] **POST-01**: `roster.require` feature check: a client, or your organization's server, that lacks a feature a project requires refuses to fold it with the update sentence instead of ignoring entries it does not know (defined in `.planning/research/portfolio-and-assignment/DESIGN.md` 3.9 and 10.2; planned into Phase 33 so it is in the field before Phase 33.1).
- [ ] **POST-02**: Positions as roster objects with title, section, shift, decision roles, required clearance, key groups, acting and dual-hat flags and the ways of serving they are open to; history answers who held what when.
- [ ] **POST-03**: Signed authority to post: held by the lead position, delegated with scope, kinds, expiry and depth under the one pure delegation rule (`mayDelegate`, shared with Phase 71); every posting records who ordered it, under whose authority, and when, derived from the verified signer.
- [ ] **POST-04**: Posting machine (portfolio DESIGN 3.8): ordered, device proven, unable reported, decided (confirm, defer, reassign), in effect, overdue, away, relieved, cancelled; no decline path in assignment modes, enforced by the fold from the shared project's signed mode.
- [ ] **POST-05**: Device proof by safety code as key delivery, with the "not consent" sentence, by posting file or your organization's server; in a hosted session the device is the person's key in your organization's key store; expired secrets never cancel a posting.
- [ ] **POST-06**: Atomic handover: authority switches at the incoming's report entry; staged key changes activate at the same point; stale staging refused and restaged; writes held until the staged epoch is folded; a client or server without the positions feature stops.
- [ ] **POST-07**: Acting, temporary and dual-hatted postings with the single-authority invariant, decisions that name their position, and separation-of-duty checks.
- [ ] **POST-08**: Personnel key group for report-unable reasons and order references; migration from seats with parity; silent positions per seat in invitation mode; team files name positions, never people; Staff Room screens in the mode's words and, in the Defence Team mode, the words that follow how a person serves.
- [ ] **POST-09**: Observer positions for industry, allied military members and others invited to observe and give feedback (owner, 2026-11-24): placed by invitation into an Observer position; time-limited; receive no roster (no name, position, member key or personnel attribute) and see only the copies staff release to them from the key groups the position lists that their approved releasability allows (checked at the release and at every key grant to an outside member); comment in their own stream, which no other observer can read; never edit, decide, approve or post; allied-military and industry observers, and the markings that open key groups to outside people, approved by your organization's security contact. Outside observers sign in with Phase 47 guest accounts (planned).

| Requirement | Phase |
|-------------|-------|
| MUS-01 … MUS-03 | Phase 30 |
| MUS-04 … MUS-06 | Phase 31 |
| MUS-07, MUS-08 | Phase 32 |
| MUS-09, POST-01 | Phase 33 |
| POST-02 … POST-09 | Phase 33.1 |
| MUS-10 | Phase 34 |
| MUS-11, MUS-12 | Phase 35 |

## Phase 33.2 requirements: Post-quantum cell keys (0.4.x)

**Defined:** 2026-11-24 from the owner's decision O3 (`.planning/research/data-centric-access/RESEARCH.md` section 10), when Phase 33.2 was planned.

- [x] **WRAP-01**: Cell epoch keys are wrapped with `near-ai/cell-wrap/v2`: P-256 ECDH and ML-KEM-768 joined by HKDF-SHA256 (the SP 800-56C two-step KDF) and AES-256-GCM, bound to the cell, the epoch, the device and both recipient keys, with frozen test vectors; version 1 wraps stay readable.
- [x] **WRAP-02**: Every device, hosted person and hub publishes a P-256 key and an ML-KEM-768 key bound to its Ed25519 key (`device.kem`, or `kem` in its descriptor); the safety words cover them; the private keys live only in the keyring, the Transit-KEK envelope or the hub's key file.
- [x] **WRAP-03**: An epoch grant may span several signed pages, each within the grant size limit, all committed by the founding roster entry.
- [ ] **WRAP-04**: The `wrap@2` feature goes through `roster.require`: new shared projects require it at creation, a lead switches an existing project in one step, each cell moves at its next epoch, late devices get keys in one step, and after the switch the fold and your organization's server refuse any new X25519 wrap.
- [ ] **WRAP-05**: A cell whose label routes local-only or nowhere (by default Protected B, Protected C and every classified level) is never wrapped with X25519; a required CI check fails if any wrap path bypasses the one entry point; ML-KEM-1024 with P-384 is reserved for Protected C and classified work.

| Requirement | Phase |
|-------------|-------|
| WRAP-01 … WRAP-05 | Phase 33.2 |

## Phase 41 requirements: One foundation (organization policy foundation, 0.4.x)

**Defined:** 2026-11-20 from `.planning/research/coherence/REVIEW.md` (section 9.2), added when Phase 41 was planned.
**Core value:** Your organization can hand its rules to every computer, and every feature reads them the same way; an older extension asks to be updated instead of reset.

- [x] **FND-01**: Organization layer: enrolment file, pinned issuer fingerprint read aloud, personal and project layers that narrow only, declared narrowing direction per key, Reset touching only the personal layer.
- [x] **FND-02**: Bundle v2 sections, `requires`, `needs-update`, v1 read as v2; also the `exportControl` section parsed in report mode and starting rules that keep the reserved compartments `CGP`, `ITAR` and `EAR` on this computer (`local-only`) (amended 2026-11-20, CGP-ITAR.md section 12).
- [x] **FND-03**: `endpoints[]` replacing `routing.localHosts` (migration at today's effect, one-time notice).
- [x] **FND-04**: One `authorizations[]` record with kinds and inner signatures; "self-signed on this computer" until an issuer exists; also the kinds `export-person` and `export-endpoint` and the reserved rule id `route.export-control` (shapes only; enforcement in Phase 45).
- [x] **FND-05**: Residency section and `route.residency`; accredited-device rule in report mode.
- [x] **FND-06**: One dependency-free label module; `decideRoute` as the one decision function; `privacyMode` and `teeOnly` folded in as floors; `TrustFacts`.
- [x] **FND-07**: The mode table (`src/domain/org/modes.ts`) and `term()`, moved from 32.1; the copy lint with its baseline.
- [x] **FND-08**: Passport schema only (WP-0 of 74.1): the `models` section shape, parsed in report mode; 74.1 keeps enforcement, the T0 lane and the defaults.
- [x] **FND-09**: `ModelEndpoint` and `LocalServerAdmin` interfaces with `NearAiClient` as the first adapter; the architecture test with its baseline; the policy editor shell that receives proposals.

| Requirement | Phase |
|-------------|-------|
| FND-01 … FND-09 | Phase 41: complete (2026-11-20, plans 41-01 to 41-15; tests in 41-VALIDATION.md) |

## Phase 32.1 requirements: Get Started, guided setup with viable options (0.4.x)

**Defined:** 2026-11-21 from `.planning/research/guided-onboarding/DESIGN.md` (section 16.2) and `.planning/research/portfolio-and-assignment/DESIGN.md` (section 5, ORG-01 to ORG-04), added when Phase 32.1 was planned.
**Core value:** A person answers a few plain questions about their work, sees only the options that really work here and that your organization allows, and gets one recommendation with a reason.

- [ ] **GUIDE-01**: The question set (kind of work, data, Canada, conditional follow-ups, pre-answered agent work), one per screen, with Not sure mapped to the stricter reading and explained; levels shown as scale name plus level; the kind of work remembered per person, the rest per project.
- [ ] **GUIDE-02**: Answers map to a proposed project label on the policy's scales, applied through Set Label and only ever raised; Protected C, classified and contract work without approval stop with the plain sentence and no recommendation.
- [ ] **GUIDE-03**: Viability per option (detected, configured, allowed, answered) for local servers on loopback, policy-named hosts and servers found on your network and approved, NEAR AI and the device class; only viable options can be chosen; the rest are listed apart with reason and fix; results go stale after 10 minutes or on a change.
- [ ] **GUIDE-04**: A pure `recommend()` that calls `decideRoute` for every option and ranks with rules R1 to R9, giving one recommendation with a one-sentence reason; ruled-out options greyed with the gate's refusal sentence.
- [ ] **GUIDE-05**: Option cards in plain words (where your text goes, who could see it, what is proven, what is not, cost, speed) ending in the trust line from `TrustFacts`; a choice other than the recommendation records a reason.
- [ ] **GUIDE-06**: The policy wins: only verified bundles, nothing outside the bundle offered, who to ask from the `onboarding` v2 section or a generic contact, no policy edit or label lowering offered; rule changes only as proposals in the one policy editor; the `onboarding` section named in `requires` and parsed with strict key checks.
- [ ] **GUIDE-07**: Check answers with a grouped list of what will change before Apply; re-run pre-filled showing only differences; partly applied runs finish on re-run; a hash-chained local audit record of answers, viability snapshot, bundle hash, options, recommendation, choice and changes; in a shared project the answers, label and mode as project-stream entries.
- [ ] **GUIDE-08**: Landing by kind of work with a filtered checklist (including My computers and Share with people) and the first-run guarantee; Get Started as the only setup command, every other setup path folded in with old ids as hidden aliases, staff setup's "where" question and discovery `locality` removed; an invitation file opens Get Started prefilled; keyboard, screen reader and reduced motion on the webview kit.
- [x] **ORG-01**: One pure mode table (`src/domain/org/modes.ts`): four modes, concept-key vocabulary and behaviour settings (built in Phase 41 as FND-07; first shown on screen by 32.1).
- [x] **ORG-02**: The `people.organization` section of policy bundle v2, named in `requires` (built in Phase 41 as part of FND-01 and FND-07).
- [x] **ORG-03**: `term()` used by every joining and organization string, checked by the copy lint with its baseline (built in Phase 41 as FND-07).
- [ ] **ORG-04**: Get Started suggests a mode from "kind of work" on the check-answers page, shows "Set by your organization" when fixed, and records the choice.

| Requirement | Phase |
|-------------|-------|
| GUIDE-01 … GUIDE-08 | Phase 32.1: planned |
| ORG-01 … ORG-03 | Phase 41: complete (FND-07); success criterion 7 of Phase 32.1 checks them on screen |
| ORG-04 | Phase 32.1: planned |

## Version safety requirements (Phases 32.1, 46, 47 and 48)

**Defined:** 2026-11-24, approved by the owner ("go"), from the owner's principle "the application should always keep itself up to date". People never update anything. An administrator updates a site by importing a signed bundle, so a disconnected edge site can briefly run an older release than HQ. Decisions 32.1 D-60 to 32.1 D-69 in `.planning/phases/32.1-guided-setup-with-viable-options-and-a-plain-recommendation/32.1-CONTEXT.md`.
**Core value:** a site never applies part of something it cannot read, nobody is asked to update anything, and every session follows its site's release on its own.

- [ ] **VSAFE-01**: The tool your organization uses to write and sign its rules refuses to sign rules that use a feature some target site cannot read yet, and names each such site and the release it needs. Site releases come from the signed site evidence exports; a site with no recent export counts as unknown and is refused unless the author excludes it, with the reason recorded in the signed rules. Every policy feature has a `name@N` id in one registry, named by what a document uses.
- [ ] **VSAFE-02**: A release that receives rules needing a feature it does not read refuses the whole file and keeps enforcing the last good signed rules, never no rules; a refused update applies itself after the site is updated. People see one plain status line that asks their administrator to update the site; the administrator sees the missing features. No user text tells a person to update the extension or Sterling, for any shared, signed format.
- [ ] **VSAFE-03**: When a site's image is updated, running sessions show "A new version of Sterling is ready. Save your work; it will reload when you're idle" and move to the new image at the next idle stop or sign-in, never mid-work without warning.
- [ ] **VSAFE-04**: The signed site evidence export carries the site's Sterling release and the features it reads.

| Requirement | Phase |
|-------------|-------|
| VSAFE-01 | Phase 32.1: planned (32.1-30) |
| VSAFE-02 | Phase 32.1: planned (32.1-31, 32.1-32) |
| VSAFE-03 | Phases 46 and 47: planned (46-09, 47-32) |
| VSAFE-04 | Phase 48: planned (48-11) |

## Phase 32.2 requirements: Local model manager (0.4.x)

**Defined:** 2026-11-21 from `.planning/research/guided-onboarding/DESIGN.md` (section 16.3), added when Phase 32.2 was planned.
**Core value:** A person sees what local models this machine can run and how fast, installs the recommended Western models safely, and assigns them to jobs, so the guide can offer local AI.

- [ ] **LMOD-01**: Hardware detection with unified memory as a first-class device class (Strix Halo GTT, GB10 via meminfo, Apple working set), fixed tools only, no shell, timeouts and output caps.
- [ ] **LMOD-02**: Server adapters (each a `ModelEndpoint`, plus `LocalServerAdmin` where the server can install) for Ollama, llama.cpp server, Lemonade, LM Studio, vLLM, NVIDIA NIM, LocalAI and Jan, identified by signature endpoints on loopback, policy-named hosts and approved found servers, install where supported and list-only otherwise.
- [ ] **LMOD-03**: Fit bands and speed estimates per artifact from GGUF header ranged reads and the bandwidth formula, labelled as estimates; an optional benchmark replaces them with measured numbers per machine, server and artifact.
- [ ] **LMOD-04**: Recommendations by job and kind of work from passports and the signed local catalogue (shipped, replaceable by the policy's `models.localCatalogue`); PRC-origin and passport-less models only into the research workspace's list.
- [ ] **LMOD-05**: Install with licence acceptance, disk check, HTTPS from pinned sources or your organization's mirror, sha256 verified before the file is visible to the server, safetensors or GGUF only; update offered only within the passport; remove after confirmation naming the jobs affected.
- [ ] **LMOD-06**: Models by job for fast, standard, deep, embeddings and safety within the policy's defaults; a person's own setting kept; the tool-calling and embedding tests before a job's model counts as viable.
- [ ] **LMOD-07**: Local audit records for install, update, remove, assignment and benchmark; SECURITY.md and README sections for local models; the page on the webview kit.

| Requirement | Phase |
|-------------|-------|
| LMOD-01 … LMOD-07 | Phase 32.2: planned |

## Phase 44 requirements: Accreditation evidence and compliance dashboard (0.4.x)

**Defined:** 2026-11-21 from `.planning/research/compliance-dashboard/DESIGN.md` (section 18) and `CGP-ITAR.md` (sections 10 to 14), added when Phase 44 was planned.
**Core value:** Anyone preparing a security assessment of a system that uses this product can see, per level, the exact controls, what the product does for each with live evidence, what your organization must do, and every gap with its remediation, and can download a release's documentation package in OSCAL and readable form. Your organization decides; nothing here is an authorization.

- [ ] **ACCR-01**: The `compliance/` package holds the NIST 800-53 Rev. 5 catalogue, the Canadian catalogue and profiles in OSCAL JSON with an attribution `NOTICE`, source addresses, retrieval dates and hashes, and validates against the OSCAL schemas.
- [ ] **ACCR-02**: A maintainer-run importer builds the ITSP.10.033 catalogue and ITSP.10.033-01 profile from the official pages and reports every disagreement with the two unofficial conversions; a weekly job detects upstream changes.
- [ ] **ACCR-03**: Component definitions exist for the extension, relay, release pipeline and model endpoints (hub and appliance as placeholders), each control with an implementation statement and one responsibility value.
- [ ] **ACCR-04**: Evidence rules tie statements to collectors; a check fails when a mapped test is missing, skipped or not run.
- [ ] **ACCR-05**: Collectors produce a redacted evidence bundle with a hash manifest on every merge to `main` and on a daily schedule (CI checks, mapped tests, audits, SBOMs, secret scan, workflow hardening, repository settings, review and approval trail, release integrity, documentation checks).
- [ ] **ACCR-06**: The status engine computes the six states from evidence and freshness only; no source file carries a status; Stale counts as not met.
- [ ] **ACCR-07**: Docs-site Accreditation section: overview, one page per level, gaps, responsibility matrix, evidence and package pages, reading generated JSON refreshed without a rebuild.
- [ ] **ACCR-08**: Every gap shows remediation, owner and the phase or POA&M item; risk acceptances are signed, expire and never show as Met.
- [ ] **ACCR-09**: Each release attaches the documentation package (OSCAL SSP draft, assessment plan and results, POA&M, resolved profiles, responsibility matrix, ITSG-33 crosswalk, evidence bundle, README) with checksums and artifact attestations.
- [ ] **ACCR-10**: The pull request job summarizes control state changes; a drop from Met without a reviewed tailoring or POA&M change fails it once D5's switch is made.
- [ ] **ACCR-11**: Nothing generated says compliant, accredited or certified about the product; the evidence bundle holds no secrets or organization data; an organization overlay is merged locally only.
- [ ] **ACCR-12**: Gaps G1, G4, G5, G6, G7, G9 and G12 from the design are closed or have a dated POA&M item.
- [ ] **ACCR-13**: Controlled goods (Canada) and ITAR overlays: requirement catalogues from the official texts with source hashes and an unofficial-representation notice, mapped to ITSP.10.033 and NIST SP 800-53 controls and to product statements, shown as two Accreditation pages with the same six states (`CGP-ITAR.md`, section 10).
- [ ] **ACCR-14**: The copy lint refuses "ITAR compliant", "CGP compliant" and similar phrases about the product; rows that depend on unsettled questions (TEEs, encrypted storage at third parties) are never Met; a docs page gives the interim settings and what the product cannot stop (`CGP-ITAR.md`, sections 10.3 and 11).

| Requirement | Phase | Plans |
|-------------|-------|-------|
| ACCR-01 | Phase 44 | 44-01, 44-06, 44-10, 44-11, 44-12, 44-16 |
| ACCR-02 | Phase 44 | 44-06, 44-10, 44-11, 44-12, 44-16 |
| ACCR-03 | Phase 44 | 44-05, 44-18 |
| ACCR-04 | Phase 44 | 44-01, 44-02, 44-07, 44-18 |
| ACCR-05 | Phase 44 | 44-02, 44-07, 44-08, 44-14, 44-19 |
| ACCR-06 | Phase 44 | 44-01, 44-04 |
| ACCR-07 | Phase 44 | 44-01, 44-05, 44-14, 44-15 |
| ACCR-08 | Phase 44 | 44-03, 44-04, 44-14, 44-15, 44-18 |
| ACCR-09 | Phase 44 | 44-09, 44-17, 44-19 |
| ACCR-10 | Phase 44 | 44-17, 44-19 |
| ACCR-11 | Phase 44 | 44-02, 44-05, 44-14, 44-15, 44-17 |
| ACCR-12 | Phase 44 | 44-03, 44-04, 44-08, 44-09, 44-18, 44-19 |
| ACCR-13 | Phase 44 | 44-06, 44-13, 44-15, 44-16, 44-18 |
| ACCR-14 | Phase 44 | 44-03, 44-04, 44-05, 44-13, 44-18 |

## Phase 44.1 amendment requirements: compliance coverage

**Defined:** 2026-11-25 from the owner's brief, when the coverage amendment to Phase 44.1 was planned (`.planning/phases/44.1-accreditation-control-implementation-and-evidence-closure/44.1-CONTEXT.md`). They extend ACCR-03, ACCR-04, ACCR-06, ACCR-07 and ACCR-10.

- [ ] **COVR-01**: A generated, reviewable per-component applicability map, derived by rules from the component catalogue and the control families, says which controls each component implements, supports or has no part in; a component with no part shows "Not applicable to this component" with its reason, never Not met; your organization signs each stage in the repository, and a change takes effect only after a new sign-off, so no cell changes class unseen.
- [ ] **COVR-02**: Every applicable (component, control) pair has a statement of what the built code does, or a named gap and phase where it is not built; the plans that already write statements keep their pairs.
- [ ] **COVR-03**: Every statement has an evidence rule backed by a test in a CI job that writes a per-test report, a CI artefact collector or the site collector; a statement without such a rule is refused at source time and is never Met; freshness follows Phase 48.2 (Live compliance evidence).
- [ ] **COVR-04**: Unclassified and Protected A first, then Protected B, then the Classified appliance and the overlays, each with its own sign-off.
- [ ] **COVR-05**: A generated coverage measure gives counts per state and component; a required check fails when the number of applicable cells without a statement rises without a gated baseline change, or falls without the baseline being lowered.

| Requirement | Phase | Plans |
|-------------|-------|-------|
| COVR-01 | Phase 44.1 | 44.1-05, 44.1-06, 44.1-07, 44.1-08, 44.1-23, 44.1-24 |
| COVR-02 | Phase 44.1 | 44.1-09 to 44.1-22 |
| COVR-03 | Phase 44.1 | 44.1-07, 44.1-08, 44.1-09 to 44.1-22 |
| COVR-04 | Phase 44.1 | 44.1-06, 44.1-07, 44.1-10 to 44.1-21, 44.1-22, 44.1-23, 44.1-24 |
| COVR-05 | Phase 44.1 | 44.1-07, 44.1-22 |

## Phases 45.1 and 45.2 requirements: NATO and Five Eyes exchange

**Defined:** 2026-11-24 from the owner's decision O1 and NATO direction (`.planning/research/data-centric-access/RESEARCH.md` sections 2.2 and 11), when Phase 45.1 was planned. XCHG-05 … XCHG-08 were reworded 2026-11-24 when Phase 45.2 was planned from AC322 (DCRA v2), ADatP-4774, 4778, 4778.2, 5636 and the public OpenTDF specification 4.3.0 (`45.2-RESEARCH.md`), with unverified label values drafted as tracked assumptions; ACP-240(A) is not held, so ZTDF conformance stays unverified until it or a partner's KAS with its own samples arrives.

- [ ] **XCHG-01**: Your organization's signed policy maps each label to a NATO-readable form (the `labelInterop` section, feature `label-interop@1`: policy identifier, classification value, restrictive and permissive categories) that its security officer confirms; a label with no mapping is refused for export; mapping out and back gives the same label.
- [ ] **XCHG-02**: Every release copy and export carries a signed label binding (4778-style) over the label, the mapping version and the content hash, signed by the certified staff session key (release copies) or your organization's release key (exports), never with a person key and never naming a person; a changed label or content is refused.
- [ ] **XCHG-03**: An export is a release to a partner: the same `mayRelease` check against the partner's agreement, a release authority credential, a passkey step-up and a recorded entry; export-controlled content is refused until Phase 45; a received object is verified, mapped and held until a person accepts it.
- [ ] **XCHG-04**: Base TDF objects from the public OpenTDF specification are written to a partner's key and read through our own non-exportable receiving key in OpenBao.
- [ ] **XCHG-05**: ADatP-4774 labels are written and read exactly as the text defines: every export carries an originator label in the information owner's policy and an alternative label in the common partner policy, written from label policy profiles your security officer adopted, each value carrying its provenance (verified, public-unverified or assumed) and every unverified value tracked by a gap row; an operational export that would use an assumed value is refused unless your security officer records an exception; a partner's labels are mapped in and joined, never lowered, and an unmappable label is refused; test vectors follow the structure of every example in the text.
- [ ] **XCHG-06**: ADatP-4778 binding objects carrying the ADatP-5636 mandatory core metadata (the metadata label bound by the ADatP-5636 binding profile) are written for every export and read in every form the texts allow, including ADatP-4778.2 sidecar files; they are signed by your organization's release key to the ADatP-4778.2 cryptographic artefact profile, with an X.509 certificate from your organization's site PKI; a changed label, metadata entry or payload is refused.
- [ ] **XCHG-07**: A ZTDF-compatible profile on the public OpenTDF specification 4.3.0 carries the 4774 label and the 4778 binding as signed assertions, with every point where ZTDF may differ behind one profile interface; key access reaches a partner's key access server listed and pinned in the signed policy, by wrapping to it and by rewrapping from it; classical key access is capped at the lowest of the partner's limit, the agreement's ceiling and Protected B or its equivalent, recorded, and refused from 2036. ZTDF conformance is unverified until ACP-240(A) or a partner's KAS with its own samples is available.
- [ ] **XCHG-08**: Conformance evidence: an AC322 (DCRA v2) conformance matrix for data-centric security, ABAC and data-product metadata with a passing test behind every claim; negative tests for every refusal; our XML checked against the texts' own schemas; control statements and hosted register rows; a development round trip against the OpenTDF quickstart's KAS; and an acceptance trial with an ally's or vendor's KAS paired with its own samples as the acceptance check.
- [ ] **XCHG-09** (added 2026-11-25, owner direction: be liberal in what we accept and strict in what we keep; 45.1 D-11, 45.2 D-24 to D-35): Partners' files in formats that are not ZTDF (OpenTDF and TDF3 objects, ADatP-4778 binding objects and sidecar files, Office documents carrying a binding object, files with a recognisable marking, unlabelled files) are accepted into quarantine through one adapter per arrival format, each declaring what it can check and what it must assume; every arrival is kept as your organization's protected cell plus a ZTDF-compatible form where conversion is possible, with the converter, its version and what was lost or assumed recorded; nothing is shown or kept as more trusted than its source proves; labels in policies the tables do not know, and arrivals without a checkable label, are held for an exchange officer, who can confirm, raise or set a label but never lower one; changed objects are refused; the parsers are limited against hostile input and fetch nothing; and your organization never unwraps a key with RSA-OAEP SHA-1 (ITSP.40.111 v5).

| Requirement | Phase |
|-------------|-------|
| XCHG-01 … XCHG-04 | Phase 45.1 |
| XCHG-05 … XCHG-09 | Phase 45.2 |

## Phase 46 requirements: Native Theia foundation

**Defined:** 2026-11-23 from `.planning/research/multiuser-hosting/DESIGN.md` (section 8: P1, P2, P3, P4, P5, P8, P9, P11 and the image build of P10; decisions D1 to D11), added when Phase 46 was planned. Decisions: `.planning/phases/46-native-theia-foundation/46-CONTEXT.md`.
**Core value:** The Sterling workbench is a real, tested Theia product that keeps each person's secrets durable and their own, keeps long-term keys out of the session, knows who signed in, and calls nothing outside what your organization lists.
**Status:** all ten complete 2026-11-24 with 46-01 to 46-08 on `feat/phase-46-wave-1` (on main with the integration PR); 46-09 (VSAFE-03, version safety) extends FND-T-09 and is not executed yet.

- [x] **FND-T-01**: The workbench lives in the `workbench/` package with its own lockfile, build, tests and CI job; nothing remains only under `.planning/spikes/`; the #162 review fixes are applied (localhost bind by default, no dev dependencies at run time, build writes only inside the package). (P1)
- [x] **FND-T-02**: Native widgets call engine code in the backend through one shared JSON-RPC service pattern, and refusals cross it as plain data with their reason. (P2)
- [x] **FND-T-03**: Secrets saved through Theia's `KeyStoreService` (VSIX `SecretStorage` and Theia AI credentials) are stored per person in OpenBao KV, or the OS keyring on a single machine, survive a restart, and are never held only in memory. (P3)
- [x] **FND-T-04**: `KeyService` signs, makes wrapped data keys and unwraps through OpenBao Transit; private keys never enter the session; signing is refused without a fresh `acr` and `auth_time`. (P4)
- [x] **FND-T-05**: The session identifies the person from the forwarded sign-in token and `THEIACLOUD_SESSION_USER`, logs in to OpenBao with jwt auth, renews and revokes its token with the session, shows `failed` with a reason and Retry, and can start a step-up sign-in. (P5)
- [x] **FND-T-06**: Open VSX and model server addresses come from configuration; telemetry and every update check are off; the running image makes no outbound connection outside the configured addresses, proven by a container test. (P8)
- [x] **FND-T-07**: A Playwright browser harness runs against the built container in CI. (P9)
- [x] **FND-T-08**: The workbench image and the hub use one Node major. (P11)
- [x] **FND-T-09**: CI builds the workbench image on a digest-pinned UBI 9 base, writes a CycloneDX SBOM, scans it, and signs it with your organization's key on `main` (no keyless signing). (P10, image build)
- [x] **FND-T-10**: Every resource the phase adds has a passing entry in `compliance/resources.json` and the fit check covers the workbench manifests; the copy lint accepts the Sterling edition names and scans the workbench's user strings. (D9; DESIGN section 15)

## Phase 48.2 requirements: Live compliance evidence in the workbench

**Defined:** 2026-11-25 from the owner's direction ("yes, plan that as long as the compliance evidence is always a real-time understanding of the product's compliance status"). Decisions and the real-time meaning per source: `.planning/phases/48.2-live-compliance-evidence-in-the-workbench/48.2-CONTEXT.md`.
**Core value:** The Compliance view always shows a real-time, verified understanding of the product's compliance status: the release's own evidence from the image, your site's evidence live on top, and nothing unverified shown as passing.
**Status:** planned, 17 plans in 10 waves (revised 2026-11-25 after the plan check).

- [ ] **LCE-01**: Every release image carries its own product evidence read-only at `/opt/sterling/evidence` (SBOM, vulnerability scan with its database build date, the evidence bundle with the engine inputs, the OSCAL package, the gap register and road-to-production) under a manifest the release key signs; its as-of time is the release build. [CM-8, SA-11, SR-4]
- [ ] **LCE-02**: States and freshness are re-judged by the one status engine against the current time at start, every 60 seconds and on every change; each cell shows source, as-of time, freshness (Current, Ageing, Out of date) and verification. [CA-7]
- [ ] **LCE-03**: A freshness policy gives each evidence kind an ageing and an out-of-date threshold; your organization can only tighten the release defaults; vulnerability evidence ages from its database build date; a clock earlier than the release build or future-dated evidence never reads current. [RA-5, RA-5(2), CA-7, AU-8]
- [ ] **LCE-04**: Release and site evidence are verified (manifest hashes, signatures, purposes, times) against trust anchors from your organization's configuration before display; what does not verify is not shown; what cannot be verified is Not verified and never passing; no evidence is trusted for where it is found. [SI-7, SI-7(1), SR-4]
- [ ] **LCE-05**: A scheduled site collector gathers in-cluster facts with their own collection times, signs them with a key your site key vouches for, and every session sees them within the interval plus about two minutes through a read-only mount, re-judged in place and never cached as if current. [CA-7, SI-4, AU-5, AU-6, CM-2]
- [ ] **LCE-06**: The operator publishes the signed site evidence export, the offline rescan summary and the exchange agreements as signed site files; each shows with its own time; a site rescan with a newer signed database replaces the release scan. [CA-7, CA-3, RA-5, RA-5(2)]
- [ ] **LCE-07**: The Compliance view layers release evidence then site evidence; "Authorization is your organization's decision" stays; in Restricted Mode and with no site evidence it shows the release evidence clearly labelled; original theme with lifted cards, codicons and Theia variables only. [CA-7]
- [x] **LCE-08**: `compliance:refresh` writes the public projection readable by the workbench user (files 0644, folders 0755) under any umask, with a test; the README's read-only mount works.
- [ ] **LCE-09**: Air-gapped and disconnected edges work with local sources only (the image, the site collector, operator files, the signed database media); nothing fetches outside. [CA-7, SC-7]
- [ ] **LCE-10**: Statements, evidence rules and documents for the controls this phase implements, gap rows G475 to G479, and the real-time definitions in the continuous monitoring strategy. [CA-7, CM-8, RA-5, SI-4, SA-11]

| Requirement | Plans |
|-------------|-------|
| LCE-01 | 48.2-01, 48.2-05, 48.2-07 |
| LCE-02 | 48.2-01, 48.2-03, 48.2-08, 48.2-10 |
| LCE-03 | 48.2-03, 48.2-05, 48.2-14 |
| LCE-04 | 48.2-01, 48.2-04, 48.2-06, 48.2-07, 48.2-12, 48.2-13, 48.2-16, 48.2-17 |
| LCE-05 | 48.2-06, 48.2-08, 48.2-09, 48.2-11, 48.2-12, 48.2-17 |
| LCE-06 | 48.2-06, 48.2-13, 48.2-14 |
| LCE-07 | 48.2-10, 48.2-15, 48.2-16 |
| LCE-08 | 48.2-02 |
| LCE-09 | 48.2-04, 48.2-08, 48.2-09, 48.2-11 |
| LCE-10 | 48.2-02, 48.2-15 |

## Phase 74.1 requirements: Model passports, use tiers and Western defaults (0.4.x)

**Defined:** 2026-11-24 from `.planning/research/model-provenance/DESIGN.md` (sections 5 to 10 and 14; owner decisions 1 to 5 and O1 to O5) and the ROADMAP's success criteria, added when Phase 74.1 was planned. Phase 41 delivered the schema half (FND-08); these requirements are the enforcement, the research workspace, the defaults and the surfaces.
**Core value:** A model does only the work your organization approved it for, PRC-origin models stay in research, checks run on another model family, and every output says which model and approval produced it.

- [ ] **MPRV-01**: The gate reads model passports from the signed policy's `models` section (schema from Phase 41) and from shipped passports whose licences, lineage and hosting match their publishers' pages; your organization's passport replaces a shipped one by id; every shipped model has a compliance fit entry.
- [ ] **MPRV-02**: A model with no passport is usable for research only; an `XX` origin, a legal flag or a removal order caps a passport at research; strict keys, limits and refusals of the `models` section are unchanged.
- [ ] **MPRV-03**: Each request's use (research only, chat you review, agent work, operational work) is worked out from local facts (lane, tools, context, writes, checking job, label, project kind and exercise attribute, inherited use) at every caller, and only rises in a session.
- [ ] **MPRV-04**: Under `models.mode: enforce` the one decision function refuses a model whose passport does not cover the use, before anything is sent, with a plain sentence for the reason and the models that would pass; under report mode it records the would-be refusal; under enforce a model takes any role above research only with your organization's evaluation of its exact files; nothing ever retries on another model by itself.
- [ ] **MPRV-05**: A PRC-origin model is refused for agent work, code, Protected B, staff and classified work, and for chat you review unless a signed, time-boxed (at most 90 days) exception by a named person, carried by your organization's layer, covers that model, project and label (no exception without your organization's layer); an expired passport or exception, a re-evaluation trigger or a revocation drops the model to research only (or to nothing, when revoked); a passport under a non-commercial licence serves research only off a vendor's own service.
- [ ] **MPRV-06**: An isolated research workspace runs adversary models with no project data and no write, run, network or MCP tools, marks its records and anything copied out, and is the only place the cyber harness and Compare Models evaluations of PRC-origin models open.
- [ ] **MPRV-07**: Model defaults live only in `AGENT_DEFAULTS` and name Western passports by job (Nemotron 3, Command A+, gpt-oss, Whisper, FLUX; for checking, gpt-oss, Nemotron 3 Nano, Granite Guardian); duplicates in settings, config and the cyber handoff are gone; a value a person set is kept; runs start on models the gate allows.
- [ ] **MPRV-08**: When no allowed model is available the person sees the ways forward (your organization's server, a closed Western model only where the label allows any cloud, waiting for NEAR AI, the research workspace) and who to ask; the picker shows each model's origin, family and approved use; a policy without model rules, or one set to report, runs in report mode with a notice nobody can dismiss for the session; a security officer can switch your organization to enforce at once with Stop agent work now, and back, each a signed, recorded switch that reaches hosted sessions within a minute and other computers at their next rules import; nobody has an override that loosens the rules.
- [ ] **MPRV-09**: Reviewers, the release guard, the tradecraft reviewer, red team, editor, plan checker and the safety classifier never run on the same model family as the work they check; under enforce a checker needs your organization's evaluation of the exact artifact; with no allowed checker a person decides; records name both families.
- [ ] **MPRV-10**: Route records and the trust facts carry the use, passport id and hash, and the reason for a refusal; staff product headers and signed version entries carry the model, artifact hash and passport hash (behind a replica feature); each project can export a CycloneDX 1.6 AI bill of materials listing every model used with its lineage.

| Requirement | Phase |
|-------------|-------|
| MPRV-01 … MPRV-10 | Phase 74.1: planned (20 plans in 8 waves, 2026-11-24; owner decisions of 2026-11-24 recorded) |

## Later milestones: draft requirements (not mapped to phases yet)

Drafted 2026-11-15 with the outlines in ROADMAP.md, "Later milestones". Ids are reserved so the outlines can be cited; each set is reviewed and mapped to phases when its milestone starts. Not counted in any coverage figure above.

### L1 Theia appliance and local inference on one machine

Split 2026-11-18 (owner, data platform decision 1): L1a, the host and local inference, is built in v0.6.0 Data platform (Phase 85 and the host parts of Phase 88), where SPIKE-01 and SPIKE-02 meet the AMD and amd64 half of APPL-02, APPL-03 and APPL-05 and the single-machine half of INFR-01 and INFR-03. Everything else below is L1b, the Theia appliance, and stays a later milestone.

- **APPL-01**: One Compose stack holds Theia in the browser, the agent engine, the relay, a local inference service and an optional OpenShell gateway on the host side; it replaces today's code-server setup, and the current VSIX bridges the first release.
- **APPL-02**: Images build for arm64 (DGX Spark class GB10) and amd64 (Strix Halo class) from one definition, pinned by manifest-list digest, and install offline from a signed bundle with checksums.
- **APPL-03**: GPU passthrough is optional and vendor-neutral: NVIDIA through the Container Toolkit and CDI, AMD through ROCm device passthrough (`/dev/kfd`, `/dev/dri`), and a CPU or Vulkan fallback; the stack says what it found.
- **APPL-04**: A sandbox gets exactly the GPU devices a grant names and none otherwise, proven by tests on an NVIDIA GB10 machine and an AMD Strix Halo machine.
- **APPL-05**: The appliance starts and works fully offline: the gate decides from the signed local copy and runs use local models.
- **INFR-01**: A local inference service runs on NVIDIA (CUDA) or AMD (ROCm or Vulkan) GPUs, or the CPU, on arm64 and amd64, and is exposed to the engine as an OpenAI-compatible provider next to NEAR AI Cloud through today's local and hybrid profiles.
- **INFR-02**: The gate decides routing from policy: this machine first, then (L5) linked machines and the HQ cluster, then a NEAR AI Cloud burst; data marked private never goes to a non-TEE target, NEAR AI TEE models count as private only when attested, and burst spend counts against the run contract's cost cap.
- **INFR-03**: With no connectivity, routing uses only local (and linked) targets and says the cloud is unavailable, with no retry loop and no error that stops the run.
- **INFR-04**: The person sees which tier served each turn (this machine, a linked machine, HQ, NEAR AI TEE, NEAR AI forwarded) and why.

### L2 Team Mode on the governed core

- Carried from the former v0.6.0 Team Mode branch plan (text on the archived `feat/team-fix-pass`, ids prefixed where they collide): TM-TEAM-02, TM-TEAM-03, BOARD-01 … BOARD-04, ASSIGN-01 … ASSIGN-03, CLAIM-01 … CLAIM-05, INTEG-01 … INTEG-03, BUDGET-01 … BUDGET-05, METRIC-01, COLLAB-01, COLLAB-02, SEC-02, SEC-03, FLOW-01, TM-SETUP-01, UX-01. TM-TEAM-01, TM-TEAM-04, SEC-01 and SEC-04 land with Phase 69 (TMR-02, TMR-03). Phase 69 records each disposition (TMR-04). Record: `.planning/research/v0.6.0-disposition.md`.
- **SHRD-01**: On a shared code-server or appliance, each person's editor-wide spend ledger and daily limit are their own.
- **SHRD-02**: A recovery code shown once unlocks an encrypted backup of the person's device key and own NEAR AI key (strong KDF; the code is never stored or logged; a wrong code and tampering are refused, tested).
- **SHRD-03**: "Replace my device": the lead accepts a person back as the same member, keeping assignments, history and role.

### L3 Routines and signed packages

- **ROUT-01**: Routines are markdown files (team, schedule or trigger, task, run contract), signed by a person and expiring; agents may propose routines, only a person creates them.
- **ROUT-02**: Unattended firings get no approvals (anything that needs one is denied and reported), and the emergency stop covers routines.
- **ROUT-03**: Routines run headlessly on the relay host or the appliance engine, and in the editor only while it is open, said plainly.
- **PKG-01**: Signed packages use the Agent Plugins v1 layout with a capabilities block that maps one-to-one onto grant constraints, and package code never runs in the extension or engine process.
- **PKG-02**: Packages install disabled, pinned to a commit, scanned with a non-overridable "dangerous" verdict, and need fresh consent when an update widens capabilities; installing is never available to member agents.
- **PKG-03**: MCP servers have per-server spend limits, tool schemas load on demand when many tools are attached, and MCP sampling stays off.

### L4 Verifiable identity and policy on NEAR

Revised 2026-11-15 for roots-only anchoring (PROJECT.md, Platform direction decision 13, owner-confirmed): nothing readable goes on chain.

- **ANCH-01**: Nothing readable goes on chain. One anchor account per organization writes only 32-byte Merkle roots over DID log heads, status lists and policy bundle hashes, at fixed intervals even when nothing changed (so timing does not show who was added or revoked); no DID document, credential, clearance, role, relationship or ciphertext of any of them is written; a verifier given a leaf and its inclusion path checks it against a root. *(Revised; was: identities anchor on NEAR with policy hash, parent DID, parent signature and expiry.)*
- **ANCH-02**: Run admission checks the latest anchored roots once per run and issues a short-lived signed lease, never per action; the local gate decides every action; offline, the signed local copy decides and anything wider fails closed.
- **ANCH-03**: Revocation's source of truth is your organization's status lists, published by HQ and committed in the anchored roots; they are cached with `validUntil` and checked at run start and lease renewal. *(Revised; was: revocation on chain.)*
- **ANCH-04**: A grant credential (not the DID document) references the run's generated OpenShell policy by hash, the prover's result is recorded, and our own subset check covers what the prover cannot model (MCP tools, spend, schedules, depth, expiry). *(Revised; was: a DID's sandbox section.)*
- **ANCH-05**: The root of the hash-chained audit log is included in the anchored roots from time to time and queued while offline.
- **ANCH-06**: The activity dashboard shows each agent's DID and delegation chain in plain words.
- **ANCH-07**: The anchor sits behind one interface (`anchor(root, kind, epoch)`, `latest(kind)`) with public NEAR mainnet as the first backend, so another backend (for example a NEAR confidential one, should NEAR ever accept third-party contracts and data on its private shard; as of 2026-11-18 not expected soon) can be added without changing what is anchored; the policy bundle names the backend.
- **ANCH-08**: HQ is the credential issuer, the `did:webvh` host and witness, the status list publisher and the only anchor writer; your organization's root key stays offline with `did:webvh` pre-rotation, a separate online key issues day-to-day credentials, and a compromised online key is replaced by rotation from the root and re-issued credentials.

Added 2026-11-16 (PROJECT.md, Platform direction decisions 14-17, owner; evidence in `.planning/research/platform-direction/agent-authz-prior-art.md`): NEAR function-call access keys are used for agents' and nodes' on-chain calls only. Off-chain capabilities stay in private credentials checked by the credential broker (CRED-08, Phase 73).

- **ANCH-09**: Each agent or node that may write on chain gets its own NEAR function-call access key on your organization's account, whose only receiver is your organization's registry contract and whose method names are exactly the registry methods its grant allows, with a small allowance; nothing else signs on chain for it. Off-chain capabilities (external APIs, model providers, messaging channels) never appear in the account's key list, by name or by hash: anyone can read that list, so it would publish your organization's capability map (decision 13). What a registry call carries follows ANCH-01: nothing readable, only roots and hashes.
- **ANCH-10**: A child key's method list is a subset of its parent key's list, checked before the add is prepared. A narrowing that leaves no method is refused and never written, because on NEAR an empty list means every method, and a list beyond NEAR's limits (2,000 bytes of method names per key, 256 per name) is refused with a plain reason rather than cut short.
- **ANCH-11**: A key is added only with a person's full-access key (the orchestrator may at most prepare an addition for a person to sign; the mechanism is an open L4 research question), and every add is recorded in the signed log with the grant it serves. The product never removes a key itself: when a key must go (revocation, rotation, a finished grant, a retired agent or node) it shows a person the exact removal command with the account and key it affects, and records when the key is gone from the chain. It never deletes an account.
- **ANCH-12**: The registry contract checks every call twice: NEAR's own key check (the receiver and method list), and its own check that the signing key is bound to an agent or node whose delegation chain allows that method and that nothing in the chain is revoked or suspended, judged against the latest anchored roots. Both must allow, and a revocation in either (the key removed, or a credential revoked in a status list) wins. Your organization's status lists stay revocation's source of truth (ANCH-03); removing a key only cuts off more, and never restores access.
- **ANCH-13**: Each key's allowance is small and fixed when the key is added, sized to its expected calls; a key whose allowance runs out is replaced, not topped up. Registry methods are cheap and move no value (no attached deposit, no transfer, little state), so a stolen key can at most spend its own small allowance on registry calls.
- **ANCH-14**: Each on-chain key is a dedicated Ed25519 key, never the device key or the key behind the agent's `did:key`, bound to the agent's or node's DID by a credential (the VCRD-06 binding) that names the account, the public key and the allowed methods and expires. Keys rotate on the schedule the policy names and at once on suspicion: the new key is added, the binding moves to it, and the removal command for the old key is shown. A key whose binding is missing, expired or revoked is refused by the registry contract and by the product.
- **ANCH-15**: Chain reads fail closed. An RPC answer that is missing, rate-limited, inconsistent or stale counts as "not allowed": no on-chain write is attempted and anything that depends on it is refused with a plain reason. More than one RPC provider can be configured, and an answer used for a decision is checked against the anchored roots (or a light-client proof) rather than trusted as is. The local gate still decides every action from the signed local copy (ANCH-02).

### L5 Edge grouping, compute pooling and HQ federation

- **NODE-01**: Each machine has a node identity (`did:key`) bound to your organization by a credential issued by a person with authority, and revocable through the status list. *(Revised 2026-11-15; was: a signed node identity.)*
- **NODE-02**: Edge devices group on the local network with no internet, mutually authenticated by node identity and binding credentials checked against cached DID logs and status lists, and each node's gate still decides alone.
- **POOL-01**: Linked machines pool GPU and compute for local inference; a mixed NVIDIA and AMD group at least balances requests across per-vendor pools (one model split across vendors is not promised).
- **POOL-02**: Routing extends to linked machines and the HQ cluster, each hop allowed only where policy, privacy tier and contract allow; an HQ cluster counts as private only when the policy says it belongs to your organization.
- **FED-01**: On reconnection an edge group federates with HQ: identities (DID logs, credentials, status lists), policy, audit and results sync, signed, so neither side can forge the other's records, and a relay in between can withhold but not forge.
- **FED-02**: Policy flows down only as signed bundles that never widen an edge's anchored authority.
- **FED-03**: Audit flows up hash-chained, and gaps are detected.
- **FED-04**: An HQ inference cluster is one more provider under the same routing rules.
- **FED-05**: Before going offline an edge device syncs your organization's DID log, the DID logs of the people it works with, all status lists, the policy bundle and the latest anchor roots with inclusion proofs; offline it verifies signatures, status bits and delegation chains locally and checks that the cached lists and bundle hash into the roots it saw.
- **FED-06**: Each level has a maximum offline age in the policy bundle; past it the gate refuses new access at that level (fail closed), with age measured from the last sync by monotonic counters, not the wall clock alone; on reconnect the device re-syncs, re-evaluates sessions that ran on stale data and flags them for review.
- **FED-07**: Two offline devices exchange stapled status lists and accept one only when your organization signed it and it is newer than their own; devices with no HQ link authenticate each other by `did:key` (or `did:peer`) and binding credentials.
- **FED-08**: A second site may hold its own issuer DID under a narrower delegation from your organization (for example, clearances up to Protected B for one compartment), checked like any other delegation (DLGT-08).

### L6 Theia desktop app and learned skills

- **DESK-01**: A desktop app from the appliance's code, with Team Studio, chat and the board as Theia widgets or agents, our gate in front of every tool including Theia's own, and a routines screen.
- **SKIL-01**: Learned skills arrive only as staged proposals (diff, the run that produced it, a scan verdict) that a person approves into a scope, signed; the skills folder is protected from file tools, and runs that read untrusted content cannot propose.
- **SKIL-02**: The rebuilt team builder offers named agents with personalities and decision agents; a personality changes voice and manner, never capability, and a decision agent acts only under a grant.
