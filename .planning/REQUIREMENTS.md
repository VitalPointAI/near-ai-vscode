# Requirements: Near AI for VSCode

## Milestone v0.7.0: Governed agent platform and messaging relay

**Defined:** 2026-11-13 (relay). **Replanned:** 2026-11-15 from the owner's platform direction (`.planning/PROJECT.md`, "Platform direction"): the identity and governance core was added, the relay requirements were re-mapped to renumbered phases, and new groups were added (TMR, GATE, OFFL, DLGT, EXEC, CRED, CTRT, CHAN, PAIR, APRV).
**Amended:** 2026-11-15 with the identity, credential and classification design the owner approved (`.planning/PROJECT.md`, Platform direction decisions 8-13; evidence in `.planning/research/platform-direction/identity-research.md`): CLAS (classification labels and routing, Phase 70) and VCRD (verifiable credentials, Phase 71) added, DLGT-08 added, DLGT-01, DLGT-03, DLGT-07, OFFL-03, OFFL-04 and IDNT-05 revised, and the L4 and L5 drafts revised for roots-only anchoring, the confidential backend interface, HQ's roles and the per-level maximum offline age.
**Amended:** 2026-11-16 by the owner: CLAS-08 (the trust badge) added and CLAS-05 ratified; then the agent authorization decisions (`.planning/PROJECT.md`, Platform direction decisions 14-17; evidence in `.planning/research/platform-direction/agent-authz-prior-art.md`): CRED-08 added to Phase 73, CLAS-08 notes the automatic check, and L4 drafts ANCH-09 … ANCH-15 added for NEAR function-call access keys on agents' and nodes' on-chain calls only.
**Core value:** Every agent works under a governance layer a person can see and check, deciding offline from a signed local policy; and a person in a Microsoft Teams, Signal or Telegram chat asks the team for something and the answer arrives where they already are, without VS Code. The group sees only the finished result, the working thread stays private to whoever asked, and every relay run executes under a contract in a sandbox.

> **What "relay" means here.** The new messaging relay at `relay/`: receive a chat message, drive an existing agent team, post the result back. **Not** the paused v0.5.0 ciphertext sync relay (RELAY-01/02, archived in `.planning/milestones/v0.5.0-paused/`) and **not** the planned `relayTransport.ts` board sync on the unmerged Team Mode branch. Those are separate, deliberate, unrelated work.

> **Id collisions with v0.6.0.** The Team Mode requirements on `feat/team-fix-pass` use TEAM-01..04 (team and identity) and SETUP-01 (guided project setup) with other meanings. In this file TEAM-xx is the Teams channel and SETUP-xx the Messaging setup view; carried v0.6.0 ids take a `TM-` prefix (TMR-04).

> **Two kinds of credential.** CRED-xx (Phase 73, credential broker) are secrets such as API keys that agents use by handle and never hold. VCRD-xx (Phase 71) are W3C Verifiable Credentials: signed statements about an identity's authority, clearance, roles and compartments. The prefixes differ on purpose.

### Relay foundation (Phase 68, done)

- [x] **RELAY-01**: The relay runs as its own workspace with its own lockfile and exactly one runtime dependency (`jose`), on Node 26.13.1 (a release carrying all current security fixes, with `engines` pinned so an older runtime refuses to start), while the extension keeps its existing Node target and zero-dependency bundle; the two never share a lockfile.
- [x] **RELAY-02**: The relay answers a health check that reports version, uptime, whether the Teams verifier and the Signal sidecar are operational, and the count of in-flight runs, so an operator knows the box is alive without reading logs.
- [x] **RELAY-03**: All relay state (run records, conversation bindings, tenant registry, pending approvals, message queues) lives in a single state directory that is git-ignored and readable only by the relay's OS user, and a restart loses no queued message or in-flight run record.
- [x] **RELAY-04**: The relay ships as a container image built without a shell or package manager, and every secret it needs (bot secret, tenant API keys, Signal registration material) is read at startup from an operator-supplied source and never appears in the image, the state directory listing, or a log line.

### Team Mode reconciliation (Phase 69)

- [x] **TMR-01**: Before any code moves, `feat/team-fix-pass` is preserved on GitHub as an archive branch and the uncommitted files in its legacy worktree are committed or recorded.
- [x] **TMR-02**: The Team Mode core verified in v0.6.0 Phase 60 (device identities held in SecretStorage, canonical JSON, the signed append-only event envelope with Lamport ordering, event validation, the deterministic materializer, the role-by-action permission matrix, the git coordination transport and the roster) runs on current `main`, re-verified against Phase 60's success criteria, in `src/domain/team/` and `src/team/` with no `vscode` import and no new runtime dependency.
- [x] **TMR-03**: A project with no team file behaves exactly as before, the full suite stays green, and a canary test proves no secret reaches the coordination log, `team.json`, settings or audit.
- [x] **TMR-04**: Every v0.6.0 phase and requirement has a recorded disposition (landed in Phase 69, carried to the Team Mode milestone, folded into a named v0.7.0 phase, or retired), and carried ids that collide with v0.7.0 ids take a `TM-` prefix.
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

### Delegation (Phase 71)

- [ ] **DLGT-01**: Every agent, machine and device acts under its own `did:key` (Ed25519; Phase 69's device identity maps to it unchanged), and people and your organization's root use `did:webvh` (a hash-chained log with pre-rotation that verifies offline from a cached copy); DID documents stay minimal and conform to DID Core 1.0 (identifier, verification methods, controller, services) with no custom authority or sandbox members; `did:near` is not used; no agent uses another agent's key or a shared credential pool. *(Revised 2026-11-15, owner-confirmed; was: an Ed25519 key, the NEAR implicit account derived from it, and a DID document with an authority section and a reserved sandbox section.)*
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
- [ ] **VCRD-03**: The W3C `eddsa-jcs-2022` test vectors are frozen tests, and Digital Bazaar's `@digitalbazaar/eddsa-jcs-2022-cryptosuite` and `@digitalbazaar/vc`, added as devDependencies only, verify our credentials and we verify theirs; the extension bundle gains no runtime dependency.
- [ ] **VCRD-04**: Revocation (permanent) and suspension (reversible) use Bitstring Status List: each credential has a randomly assigned index in a list of at least 131,072 entries, compressed with `node:zlib` and carrying `validUntil`; a verifier checks status from a cached list and fails closed when a needed list is missing or past `validUntil`; lowering a clearance revokes every higher threshold credential.
- [ ] **VCRD-05**: Selective disclosure uses atomic and threshold credentials (one fact each, for example "clearance at least Secret" on a named scale), and a holder presents only the credentials a check asks for; SD-JWT VC and BBS are later options, not built here.
- [ ] **VCRD-06**: Each device and agent `did:key` is bound to its person (or to your organization) by a device binding or delegation credential with a device class and a short expiry; a lost device is cut off by revoking its binding, with no change to anyone's DID.
- [ ] **VCRD-07**: The gate builds each actor's clearance, roles and compartments only from verified, unexpired, unrevoked credentials and the delegation chain, and a missing or unverifiable credential gives nothing (fail closed). A person with no organization issues their own credentials from their device DID, so a fresh install works with no HQ; in your organization the issuer is your organization's DID.

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
| RELAY-01 | Phase 68: Relay foundation *(v0.7.0 RELAY-01: not the archived v0.5.0 ciphertext-sync RELAY-01)* | Complete |
| RELAY-02 | Phase 68: Relay foundation *(v0.7.0 RELAY-02: not the archived v0.5.0 ciphertext-sync RELAY-02)* | Complete |
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
| DLGT-01 | Phase 71: Identities, credentials and delegation that only narrows | Pending |
| DLGT-02 | Phase 71: Identities, credentials and delegation that only narrows | Pending |
| DLGT-03 | Phase 71: Identities, credentials and delegation that only narrows | Pending |
| DLGT-04 | Phase 71: Identities, credentials and delegation that only narrows | Pending |
| DLGT-05 | Phase 71: Identities, credentials and delegation that only narrows | Pending |
| DLGT-06 | Phase 71: Identities, credentials and delegation that only narrows | Pending |
| DLGT-07 | Phase 71: Identities, credentials and delegation that only narrows | Pending |
| DLGT-08 | Phase 71: Identities, credentials and delegation that only narrows | Pending |
| VCRD-01 | Phase 71: Identities, credentials and delegation that only narrows | Pending |
| VCRD-02 | Phase 71: Identities, credentials and delegation that only narrows | Pending |
| VCRD-03 | Phase 71: Identities, credentials and delegation that only narrows | Pending |
| VCRD-04 | Phase 71: Identities, credentials and delegation that only narrows | Pending |
| VCRD-05 | Phase 71: Identities, credentials and delegation that only narrows | Pending |
| VCRD-06 | Phase 71: Identities, credentials and delegation that only narrows | Pending |
| VCRD-07 | Phase 71: Identities, credentials and delegation that only narrows | Pending |
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

Coverage: 134 of 134 active v0.7.0 requirements mapped, each to exactly one phase (Phase 68: 4 complete; Phases 69-84: 130 pending). RUNL-05 is retired. Amended 2026-11-15 with the identity design: CLAS-01 … CLAS-07 added to Phase 70, DLGT-08 and VCRD-01 … VCRD-07 added to Phase 71 (117 to 132); nothing was re-mapped. Amended 2026-11-16 by the owner: CLAS-08 (the trust badge) added to Phase 70 and CLAS-05 ratified with the pre-send connection check (132 to 133). Amended 2026-11-16 with the owner's agent authorization decisions: CRED-08 (signed, request-bound invocations checked by the broker) added to Phase 73 (133 to 134); nothing was re-mapped, and the L4 drafts ANCH-09 … ANCH-15 are not counted. Re-mapped on 2026-11-15 from the old numbering: AUTH from 69 to 75, IDNT from 70 to 76, RUNL-01/03 and TEAM from 71 to 77, SETUP from 71.1 to 78, BUDG from 72 to 79, RUNL-02/04/06/07 and CMND from 73 to 80, GRP from 74 to 81, SGNL from 75 to 82, TGRM from 75.1 to 83, OPS from 76 to 84.

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

The v0.5.0 requirements (55, trusted-source knowledge base) are archived with the paused milestone in `.planning/milestones/v0.5.0-paused/REQUIREMENTS.md`.

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

## Later milestones: draft requirements (not mapped to phases yet)

Drafted 2026-11-15 with the outlines in ROADMAP.md, "Later milestones". Ids are reserved so the outlines can be cited; each set is reviewed and mapped to phases when its milestone starts. Not counted in any coverage figure above.

### L1 Theia appliance and local inference on one machine

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

- Carried from v0.6.0 (text on the archived `feat/team-fix-pass`, ids prefixed where they collide): TM-TEAM-02, TM-TEAM-03, BOARD-01 … BOARD-04, ASSIGN-01 … ASSIGN-03, CLAIM-01 … CLAIM-05, INTEG-01 … INTEG-03, BUDGET-01 … BUDGET-05, METRIC-01, COLLAB-01, COLLAB-02, SEC-02, SEC-03, FLOW-01, TM-SETUP-01, UX-01. TM-TEAM-01, TM-TEAM-04, SEC-01 and SEC-04 land with Phase 69 (TMR-02, TMR-03). Phase 69 records each disposition (TMR-04). Record: `.planning/research/v0.6.0-disposition.md`.
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
- **ANCH-07**: The anchor sits behind one interface (`anchor(root, kind, epoch)`, `latest(kind)`) with public NEAR mainnet as the first backend, so it moves to a NEAR confidential backend without changing what is anchored once NEAR accepts third-party contracts and data on its private shard; the policy bundle names the backend.
- **ANCH-08**: HQ is the credential issuer, the `did:webvh` host and witness, the status list publisher and the only anchor writer; your organization's root key stays offline with `did:webvh` pre-rotation, a separate online key issues day-to-day credentials, and a compromised online key is replaced by rotation from the root and re-issued credentials.

Added 2026-11-16 (PROJECT.md, Platform direction decisions 14-17, owner; evidence in `.planning/research/platform-direction/agent-authz-prior-art.md`): NEAR function-call access keys are used for agents' and nodes' on-chain calls only. Off-chain capabilities stay in private credentials checked by the credential broker (CRED-08, Phase 73).

- **ANCH-09**: Each agent or node that may write on chain gets its own NEAR function-call access key on your organization's account, whose only receiver is your organization's registry contract and whose method names are exactly the registry methods its grant allows, with a small allowance; nothing else signs on chain for it. Off-chain capabilities (external APIs, model providers, messaging channels) never appear in the account's key list, by name or by hash: anyone can read that list, so it would publish your organization's capability map (decision 13). What a registry call carries follows ANCH-01: nothing readable, only roots and hashes.
- **ANCH-10**: A child key's method list is a subset of its parent key's list, checked before the add is prepared. A narrowing that leaves no method is refused and never written, because on NEAR an empty list means every method, and a list beyond NEAR's limits (2,000 bytes of method names per key, 256 per name) is refused with a plain reason rather than cut short.
- **ANCH-11**: A key is added only with a person's full-access key, or by the orchestrator acting under authority a person delegated to it, and every add is recorded in the signed log with the grant it serves. The product never removes a key itself: when a key must go (revocation, rotation, a finished grant, a retired agent or node) it shows a person the exact removal command with the account and key it affects, and records when the key is gone from the chain. It never deletes an account.
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
