# Near AI for VSCode

## Vision

Build an installable VS Code extension that gives developers a seamless, private, cost-aware AI coding harness centered on Open-GSD. The extension should expose Open-GSD commands through a native chat experience, use NEAR AI Cloud's private TEE-backed inference, and make model selection, routing, agent generation, spend, and approvals understandable and controllable.

## Users

Developers who want to plan and implement complex projects from VS Code with strong privacy guarantees, model choice, transparent costs, and safe-but-effective automation.

## Product principles

- Private by default: keep project context inside the selected NEAR AI inference path and make verification status visible.
- User control: expose model, routing, budget, agent, tool, and approval controls without requiring config-file archaeology.
- Conversational transparency: default to clear, fairly verbose progress reporting so developers can see what the system is doing, why it is doing it, what is waiting, and how to intervene.
- Effective autonomy: automate low-risk planning and inspection while gating writes, shell commands, network access, and git mutations.
- Observable economics: stream usage, estimates, actual request costs when available, and budget state in the UI.
- Open-GSD native: map the full Open-GSD command lifecycle into discoverable chat actions and preserve its artifacts and state.
- Recoverable execution: support cancellation, retries, checkpoints, resumability, and clear failure explanations.
- Current GSD runtime: keep the active Open-GSD core synchronized with the latest stable `@opengsd/gsd-core@latest` release at startup and at least daily during long sessions, while preserving project customizations and exposing the update result.
- Chat parity default: when a feature is ambiguous, prefer the interaction pattern of this chat—streaming status, interactive prompts, visible tool/agent activity, model and cost context, history, cancellation, and explicit handoffs.
- Context continuity: rely on Open-GSD's context-monitor and pause/resume artifacts where the host exposes them; use structured handoffs and explicit checkpoints as the extension fallback before context exhaustion.

## Initial scope

The first milestone includes onboarding, both API-key and NEAR sign-in authentication paths, a VS Code chat surface, Open-GSD command discovery/execution, streaming responses, model catalog and selection, sub-agent routing configuration, cost telemetry, approvals, and an extension package that can be installed locally.

## Constraints and open decisions

- NEAR AI Cloud is documented as OpenAI-compatible and provides model/pricing discovery, usage reporting, streaming chat completions, and TEE verification capabilities.
- The extension must not expose API keys to workspace files, agent prompts, or extension logs.
- Exact NEAR sign-in/token-exchange mechanics and the supported Open-GSD command integration boundary require validation during implementation research.
- Open-GSD updates must be constrained to the official stable package/channel and must use the upstream installer/update contract rather than copying managed files blindly.
- The MVP should favor a safe approval policy over unrestricted autonomy; autonomy can be expanded through explicit settings and budgets.

## Current Milestone: v0.7.0 Governed agent platform and messaging relay

**Goal:** Every agent the extension runs works under a governance layer a person can see and check: one policy gate with a floor that nothing overrides, delegation that can only narrow, run contracts with caps, a sandbox that makes protected folders absent rather than forbidden, and credentials the agent never holds, all deciding offline from a signed local policy. On that layer, people reach their teams from Microsoft Teams, Signal and Telegram through a relay, without VS Code: the group sees only the finished result, the working thread stays private to whoever asked, and every relay run executes under a contract in a sandbox.

**Why now:** The owner accepted the platform direction on 2026-11-15 (see "Platform direction" below): keep our TypeScript engine and build the DID trust and governance layer into it. The relay needs that layer before it runs tools for people outside VS Code (run contracts, a sandbox, request-bound signed approvals), and the edge, federation and Theia work that follows needs it to work offline. Phase 68 (relay foundation) is built and stands as it is.

**Shape:** one milestone in three stages, in order. Stage 1, identity and governance core (Phases 69-74), changes the extension's engine and lands on `main` phase by phase. Stage 2, the relay on the governed core (Phases 75-81). Stage 3, more channels and release (Phases 82-84). The roadmap's v0.7.0 section starts with the order of work across every stream.

**Decided up front (relay, 2026-11-13, still holding):**
- The relay is a new workspace at `relay/` in this repo, owner-hosted and multi-tenant.
- Runtime is Node **26.13.1** for the relay only; the extension keeps Node 24 and its zero-runtime-dependency bundle.
- Exactly one new runtime dependency: **`jose`**, for Bot Framework JWT/JWKS verification. No HTTP framework, no Bot Framework SDK.
- Signal goes through a pinned `signal-cli-rest-api` sidecar, not a reimplemented protocol client.
- Group visibility is **result-only**; work detail stays in the private chat.
- The bot is an **external app**: it never joins the customer's Microsoft organization.
- Phase numbering starts at **68** because milestone v0.6.0 (Team Mode, Phases 60-67) is claimed on the unmerged `feat/team-fix-pass` branch. The replan of 2026-11-15 renumbered the relay phases after 68 (old 69-76, 71.1 and 75.1 are now 75-84); the roadmap has the mapping.

**Naming trap:** this milestone's "relay" is the *messaging* relay. It is not the paused v0.5.0 ciphertext sync relay (RELAY-01/02) and not the planned `relayTransport.ts` board sync from Team Mode.

**Research:** `.planning/research/platform-direction/` (the accepted recommendation, the IronClaw, Hermes and OpenShell reviews, and `identity-research.md` on DIDs, credentials, classification and NEAR confidential) and `.planning/research/SUMMARY.md` with STACK, FEATURES, ARCHITECTURE and PITFALLS for the relay. Requirements: `.planning/REQUIREMENTS.md`, milestone v0.7.0.

## Platform direction (owner decisions, 2026-11-15)

Recorded as the owner gave them. They govern the roadmap from v0.7.0 on; the recommendation behind them is `.planning/research/platform-direction/summary.html`.

1. No fork of IronClaw. Keep our TypeScript engine and build the DID trust and governance layer into it.
2. Deployment is both connected installs and edge devices with no connectivity; edge devices can combine and federate back to an HQ server. So: the policy gate must work fully offline (a signed local copy of DIDs and policy, fail closed), edge devices must be able to group locally, and there must be edge-to-HQ federation (sync of identities, policy, audit, results when connectivity returns). Theia product: container appliance first (browser Theia + agent engine + relay + optional OpenShell gateway in one Compose stack, GPU passthrough optional, offline-loadable images), desktop app second, VS Code extension kept while cheap.
3. IronClaw, Hermes Agent and NVIDIA OpenShell are used only as sources for the parts we integrate (designs; OpenShell's policy YAML format and policy prover), not as products we depend on or fork.
4. An OpenShell spike is approved and runs now in parallel (another agent): Linux, agent shell on a worktree copy inside OpenShell, prove a run-time read of `.near-ai/state/keys` becomes impossible; draft a DID document with a sandbox section and run the prover on a parent/child pair. Plan the execution-backend phase so its research consumes the spike result (it will be written to .planning/research/platform-direction/openshell-spike.md).
5. Replan v0.7.0 with the designs folded in: capability manifest, run contracts, channel pairing; plus the single policy gate with a non-overridable floor, restrict-only delegation, execution backends and the credential broker, request-bound signed approvals in the command-surface phase. Phase 68 stands as built.
6. Additional owner requirement (2026-11-15): the product must support both NVIDIA and AMD GPUs. Target hardware includes NVIDIA DGX Spark class GB10 machines (Grace Blackwell, ARM64 CPU, unified memory) and AMD Ryzen AI Max "Strix Halo" machines (x86-64, Radeon iGPU with ROCm/Vulkan, unified memory). Machines of both kinds may be linked together to pool compute and GPU power for local inference, and/or federated back to a larger inference cluster or server, in addition to bursting to cloud resources (NEAR AI Cloud).

7. AMD first (owner, 2026-11-15): the first hardware available to test the platform on is AMD based, a Ryzen AI Max "Strix Halo" machine (https://www.amd.com/en/products/processors/desktops/ryzen/ryzen-ai-halo.html). Sequence development so every hardware-dependent step is built and proven on AMD (x86-64, Radeon iGPU with ROCm or Vulkan, unified memory) first; NVIDIA GB10 (arm64) follows and must not block AMD work.

**Identity, credentials and classification (owner, 2026-11-15).** The owner approved this design the same day, built on `.planning/research/platform-direction/identity-research.md`. Decision 10 revises the owner's earlier acceptance of `did:near`; the owner confirmed the revision and the roots-only anchoring of decision 13 on 2026-11-15.

8. Identities are standard W3C DIDs. DID documents stay minimal and conform to DID Core 1.0 (the identifier, verification methods, controller and services), with no custom authority, constraint or sandbox blocks inside them. This replaces the spike's draft `agentGuardrails` member.
9. Authority, clearance (classification level), access roles and compartments are attributed per identity as W3C Verifiable Credentials 2.0 with `eddsa-jcs-2022` Data Integrity proofs, revoked or suspended through Bitstring Status List. We implement a narrow profile ourselves on `node:crypto` Ed25519 and the existing canonical JSON (to be confirmed against the W3C test vectors in Phase 71's first research step), with zero runtime dependencies; Digital Bazaar packages are used only as devDependencies to cross-check our credentials in tests. Selective disclosure starts with atomic and threshold credentials (one fact each, for example "clearance at least Secret"); SD-JWT VC and BBS come later.
10. DID methods (owner-confirmed 2026-11-15; revises the earlier acceptance of `did:near`): `did:key` (Ed25519) for agents and machines, from the same key as Phase 69's device identity; `did:webvh` for people and your organization's root, hosted by HQ, hash-chained, and verifiable offline from a cached copy. `did:near` is not used: two incompatible specifications already hold the name (the W3C-registered Ontology method of 2020, abandoned and older than DID Core 1.0, and the method in NEAR's own documentation, which specifies only create and read and ties a DID to a public account's keys and history), and a third would add confusion.
11. Classification. A label is `{scale, level, compartments, releasability, handling}`, and access needs a clearance that dominates the label (same scale or a mapping your organization approves, a level at least the label's, every compartment held, releasability met). Each session keeps a high-water mark, and everything it writes inherits it. Scale presets: commercial (Public, Internal, Confidential, Restricted), Canadian government as two scales (Protected A, B and C; Confidential, Secret and Top Secret), and NATO. Each level maps to a routing tier (any cloud, attested TEE cloud only, local only, deny) with the research's defaults: Restricted, Protected B and C and every classified level are local only unless your organization approves otherwise. The gate also steers inference routing by label. The gate prevents mistakes; it does not accredit a device for classified information.
12. Delegation only narrows on level, roles, compartments, expiry and depth, checked at every link of the chain, and nothing in the chain may be revoked or suspended.
13. On chain. The owner requires private transactions using NEAR confidential. Research (2026-11-15) found that NEAR's Confidential Intents private shard does not accept third-party contracts or data today. So (owner-confirmed 2026-11-15): nothing readable goes on chain; one anchor account per organization writes 32-byte Merkle roots (DID log heads, status lists, policy bundle hashes) at fixed intervals to public NEAR now; the anchor sits behind one interface so it moves to a NEAR confidential backend when NEAR allows third-party data there; and the owner asks NEAR in writing about third-party contracts on the private shard (open owner action). The chain is checked once per run (a short-lived lease) and the local gate decides every action. Offline edge devices sync DID logs, status lists, policy and anchor roots before going offline, verify locally, and fail closed after a per-level maximum offline age. HQ is the issuer, the DID host, the status list publisher and the only anchor writer, with an offline root key and pre-rotation.

**What follows from them (the plan's reading, not further owner decisions):**
- The gate decides from a signed local policy bundle in every case; the chain, when it arrives (later milestone), adds freshness and revocation to that bundle and never becomes a per-action dependency. The bundle format, the capability vocabulary, the label format, the DID methods, the credential profile and the status list format are costly to change once edge devices hold them offline and anchored roots commit to them, so their phases carry an "Undo cost" note.
- Multi-architecture images (arm64 and amd64) for everything we ship as a container, starting with the relay in v0.7.0; both GPU stacks in the appliance (NVIDIA Container Toolkit / CDI, AMD ROCm through `/dev/kfd` and `/dev/dri`, and a CPU or Vulkan fallback); a sandbox never blocks GPU access the policy grants.
- A local inference layer that runs on either vendor and is exposed to the engine as providers next to NEAR AI Cloud, built on today's local and hybrid profiles (`src/domain/auth.ts`, `src/services/providerFactory.ts`, `privateRouteFor` in `src/services/providerCache.ts`, the `privacy: private` member rule). Routing goes local first, then linked machines, then the HQ cluster, then a NEAR AI Cloud burst, decided by the gate: data marked private never bursts to a non-TEE target, NEAR AI TEE models count as private only where attested, burst spend counts against the run contract, and at the edge with no connectivity the cloud is simply unavailable.
- Machines link and federate under signed node identities; the edge grouping and HQ federation milestone covers compute pooling and inference federation as well as identity, policy, audit and result sync.
- From decisions 8-13: v0.7.0 builds what works with no HQ and no chain (labels and routing by label in Phase 70; DIDs, credentials, status lists and delegation that narrows at every link in Phase 71, where a person with no organization issues their own credentials from their device DID). Roots-only anchoring, the confidential backend interface and HQ's roles come in milestone L4; edge sync and the per-level maximum offline age in L5.
- No agent, person or device needs a NEAR account of its own: one anchor account per organization is the only actor on chain. The NEAR implicit account id stays derivable offline from any Ed25519 key (Phase 69, D-20), but nothing uses it on chain.
- Retired by these decisions: the IronClaw fork, the "IronClaw as an optional backend" experiment, and asking NEAR AI about IronClaw's upstream activity before depending on it (nothing depends on it).

## Previous Line: 0.4.x

**Goal:** Keep extending and hardening the v0.4.0 release: the native NEAR agent runner, its chat, approvals, spend tracking, teams and tooling. Each change ships as a 0.4.x release.

v0.5.0 (trusted-source knowledge base) was paused on 2026-10-29 and is moving to a separate project; its brief, research, roadmap and Phase 13 plans are archived in `.planning/milestones/v0.5.0-paused/`. Evidence-based model defaults (`.planning/research/v0.6.0-evidence-based-model-defaults.md`) remain a candidate for later 0.4.x work.

## Planned features (owner, 2026-11-05)

Not started. Recorded so they are not lost; each becomes its own milestone and phase set when the owner starts it.

**Where each stands (checked 2026-11-15):** autonomous phase boundaries and Steer shipped in 0.4.18, and the new-project kind and team step in 0.4.19. The relay is v0.7.0 (Phases 68 and 75-84). Verifiable agent guardrails are planned: v0.7.0 Phases 69-74 build the local, offline layer, and on-chain anchoring is the later "Verifiable identity and policy on NEAR" milestone. The isolated cyber VM is a follow-up phase of v0.8.0 on the execution backends of Phase 72. Decision agents and named agents with personalities are not scheduled; a decision agent may act only under a grant (v0.7.0 Phase 71), and personalities wait for the Theia desktop milestone so the team builder UI is built once. The roadmap's "Later milestones" section has the order.

### Autonomous GSD phases, and a Steer that interrupts now (0.4.18)

Owner, 2026-11-06: "before each GSD phase, the agent typically stops and asks user to do a /clear ... I'd rather it just autonomously do the clear if
it's time to clear context and then move right into the next phase or plan or execution or verification. If the user needs to interrupt, they should be
able to send a message ... similar to Codex where the user can click Steer and have that message injected immediately."

- **A phase boundary no longer waits for a person.** The `/clear` step at a GSD phase, plan, execution or verification boundary is done by the agent
  when the context is actually full enough to warrant it, and the next step starts on its own. A summary and a handoff are written before the context
  is reset, so nothing is lost. It happens only in Auto (or the mode the owner names), and a person can still ask to be stopped at boundaries.
- **Steer interrupts now.** A message the person sends mid-run can either queue (today's behaviour, taken at the next safe point, never cutting off a
  streaming reply or a running tool) or **Steer**, which injects it at once: the current turn is cut, the message is taken as the newest direction,
  and the tool in flight is cancelled cleanly and said so.

  **Confirmed cause (owner report, 2026-11-06: "a message sent is still only queued").** The queue-and-cut machinery is built: the composer already
  posts `steer` when the chat is busy (`media/chat/chat.js:771`), the host forwards it to the running agent (`src/services/chat.ts:601`), and the
  loop subscribes and can abort the in-flight request (`src/agent/loop.ts:337`). But the subscription is gated:

  ```ts
  // src/agent/loop.ts:337
  const unsubscribe = input?.subscribe(() => {
    if (received || !(this.options.client.cooldownRemainingMs?.(this.options.model) ?? 0)) return;
    cutForInput = true;
    attemptAbort.abort();
  });
  ```

  It cuts only when **nothing has streamed yet** (`!received`) **and** the model is in a rate-limit cooldown. In normal use neither holds, so a steer
  can only ever queue. The fix is to make interruption an explicit request from the person, not a side effect of those two conditions: a `steer` with
  `interrupt: true` (a Steer button, or Ctrl+Enter on the composer) aborts the in-flight attempt whatever `received` says, the loop then takes the
  queued messages as the newest direction, and the chat says the reply was interrupted and the tool in flight was stopped.
- Open questions for the owner when this starts: whether a cleared boundary keeps the visible transcript (so the person still reads the history) while
  only the model's context is reset, how much context is "time to clear" (a percentage of the model's window, or a token count), and whether Steer is a
  button or a modifier on send.

### Agents reachable from Microsoft Teams, and a relay so end users need no VS Code

Owner, 2026-11-06: "is there a way that we could integrate this extension with Microsoft Teams, so that if I invited an agentic team like ResearchX to
be a member in a group chat, people in the chat could interact with it, each conversation within its own thread ... ResearchX would then privately
message the requestor to continue ... Doable without ResearchX being a member inside the organization - would always be an external user."

The extension cannot do this alone: it runs inside VS Code and has no inbound endpoint, so Teams needs a hosted service in front of the team.

- **A relay service is the real product.** An HTTP API over an agentic team (start a run, continue it, ask its status, stream updates), with the
  security and limits in one place. Teams is then one adapter over it, and a web page, Slack, or a plain API can use the same team. This is the piece
  that gives end users the team without installing VS Code or the extension.
- **Signal is another adapter over the same relay.** Signal has no bot platform, so the options are signal-cli (a Java client that can register a
  number and send and receive messages) or a small self-hosted bridge. Two options are worth weighing: **link a dedicated number** (signal-cli or a
  bridge, full support including group chats and attachments, the owner runs one process), or **the Signal bot API** where a provider hosts the number
  for you (less to run, less control, and messages leave the owner's infrastructure). Recommendation: signal-cli linked to a dedicated number on a
  machine the owner controls, because nothing then depends on a third party and the relay stays the only outward surface. Group chats are addressed by
  the Signal group id, and the same "reply privately to the requestor" rule holds: the group gets the result, the requestor gets the working thread
  over Signal direct message. Signal's end-to-end encryption stops at the bridge, so the relay must treat every incoming message as untrusted content,
  and the bridge must never hold a NEAR AI key.
- **The Teams bot is a thin adapter.** Registered with the Bot Framework for group chats, it receives an @mention, starts a run, and replies in the
  same thread when the work is done. On the first mention it opens the bot's 1:1 conversation with the requestor and continues the work there, so each
  person gets a private thread. Sessions are keyed on tenant, conversation, thread and requestor, so two people asking the same team get isolated runs.
- **The team is an external app, not a member of the organization.** It needs no NEAR AI organization membership; the relay holds the model key,
  scoped per tenant and team.
- **Security, which is the real work.** Verify every Bot Framework activity (issuer, audience, expiry, OpenID key set), never trust a raw POST; carry
  the requestor's validated Teams identity into the run so approvals and spend are attributed to a person; allowlist tenant ids so an outside install
  cannot spend the budget; give every thread its own workspace, spend cap and runtime; treat every chat message as untrusted content under the rules
  the extension already applies; and never put a NEAR AI key anywhere a person can read it.
- **Recommended order:** the relay first, then the Teams adapter, then (optionally) an MCP server so other assistants can call the same team.

Open questions for the owner when this starts: whether the relay is hosted by the owner or per customer, which Teams identity is authoritative when a
guest account is involved, whether a group chat may see the whole run or only its result, and how a thread survives the bot being restarted.

### Decision agents on teams

The team builder gains a decision agent configuration, so a decision agent can be put on a team and use a model configured for deciding. Sage 2
through NEAR AI is the default decision model. A decision agent's job is to use all the information the team has and decide in real time, and to act
on that decision when it has been delegated the authority to act. Open questions for the owner when this starts: what a decision agent may act on
without a person (and what always waits for one), how its decisions are recorded so the rest of the team can see them, how it is distinguished from an
orchestrator in the roster and the board, and what it does when the information it has conflicts (for example two people's reports disagree).

### Named team agents with personalities, and who is acting in the chat

It is not clear today when a member agent of a team is the one acting in the chat, or which team it belongs to. Three things, together:

- **Every action in the chat names the agent** that performed it and the team it belongs to, so a person can always tell who did what without
  reading the details view.
- **Agents can be named in the team builder,** and a name is shown wherever that agent acts, so the team has people rather than roles.
- **Agents can be given a personality in the team builder,** and new agents come with a random default name and a personality typical of the role.
- **A personality never makes an agent worse at its work.** The example the owner gave: a technical role is often written as a poor communicator, but
  communication with the person is the job, so the personality is a skilled engineer who also explains things clearly. Every generated personality must
  keep the role's competence and its communication explicit, and the tests should pin that. A personality changes voice and manner, never capability,
  permissions or the quality of the work.

Open questions for the owner when this starts: whether a personality is text appended to the agent's instructions or a structured set of traits, how a
person changes a name or personality after the team is made, whether personalities are shared with the team (so everyone sees the same person) or local
to one computer, and how a personality is kept from growing the prompt until runs get expensive.

### Verifiable agent guardrails

Every agent the extension runs works under guardrails a person can see, and those guardrails are verifiable rather than trusted.

- **Every agent gets a cryptographic identity:** a NEAR Protocol implicit account, with a W3C-compliant DID attached. The DID carries that agent's
  constraints and limits, so what an agent may do is data, not a prompt.
- **The agent activity dashboard shows them:** for each agent, what it is allowed to do in plain words, and the DID itself for anyone who wants to
  inspect it.
- **An agent can only act within its DID,** and can never grant itself more permissions or authority than it was created with or delegated to it.
- **Only the orchestrating agent changes it,** and only with authority delegated by a person.
- **DIDs are stored with NEAR confidential intents,** so they are immutable on chain, and the authorization policies are immutable smart contracts
  that act as gates: an agent asks to act, and the contract checks its authorization before anything runs.

Builds on what exists: signed events and device identities (`src/team/`, Phase 60), the permission rows (`src/domain/team/permissions.ts`), the
approval and policy layer (`src/agent/permissions.ts`, `src/domain/policy.ts`) and the activity view. Open questions: which NEAR account model, how a
DID is anchored in the confidential-intents format, what happens when the chain is unreachable, and how a run works with no chain at all.

**Planned (2026-11-15):** the owner's platform direction answers the last two questions: the gate decides from a signed local copy of DIDs and policy and fails closed, so a run works with no chain at all (v0.7.0 Phases 69-74). The account model and the anchoring were answered by the identity decisions of 2026-11-15 (below and Platform direction 8-13); anchoring belongs to the later "Verifiable identity and policy on NEAR" milestone (L4).

**Revised design (owner, 2026-11-15; Platform direction decisions 8-13).** How the bullets above are met:
- An agent's identity is a standard DID (`did:key` for agents and machines; `did:webvh` for people and your organization). What it may do is still data, not a prompt, but it lives in signed Verifiable Credentials attributed to that DID (authority, clearance, roles, compartments, delegations), not inside the DID document.
- "Never more than it was created with or delegated" is the delegation rule: each link narrows level, roles, compartments, expiry and depth, the verifier checks every link, and a revoked or suspended credential anywhere refuses the chain.
- "Stored with NEAR confidential intents" cannot be met today: the private shard runs only NEAR Intents and accepts no third-party contracts or data. Nothing readable goes on chain; one anchor account per organization writes only Merkle roots to public NEAR, behind an interface that can move to a NEAR confidential backend later. The owner asks NEAR in writing about third-party contracts on the private shard.
- "Immutable smart contracts that act as gates" becomes the local gate deciding every action from the signed policy bundle, whose hash is in the anchored roots; the chain is checked once per run, never per action.
- Agents do not get NEAR accounts of their own; the per-agent implicit account stays derivable offline but unused on chain.


### A new project asks what kind it is, then offers a team for it (0.4.19)

Owner, 2026-11-06: "when someone opens the extension and clicks the button to start a new project, it initiates /gsd-new-project which is ok, but the next
question should be what kind of project it is with option to choose from one of our templates - research, software dev, etc... and then whether or not the
user wants to attach an agent team to carry it out." Today a newcomer has no way to know that teams designed for exactly their kind of work already exist.

- **The second step of Start a New Project asks what kind of project it is**, offering the shipped templates (research, software development, and the
  others the library already has), each with a one-line description of what it produces.
- **The third step offers the team that fits that kind**, showing each candidate's members and what it is good at, with "no team for now" as a real
  choice, so a person can start solo and add a team later.
- **The choice is written where the project keeps it**: the project's kind in its planning state, and a chosen team as the project's own
  `.planning/.near-ai/team.md` (the mechanism that already exists), so the first message can use it without being told again.
- **A newcomer learns the teams exist** without opening Team Studio first. The wording stays plain and says what the team will do for them.
- Open questions for the owner when this starts: whether the template list is fixed or read from the team library, whether the team step can offer a
  team the person has already saved, and how the flow behaves when Open-GSD is not installed yet.

### An isolated sandbox VM for cyber testing (owner, 2026-11-06)

Owner: "ability to spin up a completely isolated VM to run tests and disassemble code, test exploits, etc... that is 100% completely separated from
the user's machine. There must be absolutely no way for an agent or agent team doing cyber testing in this isolated sandbox VM or suitable constraining
mechanism from breaking out of their sandbox. They can do what they like inside the VM across the whole range of defensive and offensive security
testing, but only inside that isolated enclave."

Today the cyber harness runs in a container or a temporary folder on the person's own machine. A container shares the host kernel, so a kernel bug, a
misconfigured mount or a privileged flag is an escape; the temporary-folder tier is not isolation at all. A real enclave means a VM with a hypervisor
boundary, and the work is in proving the boundary rather than assuming it.

- **A VM per engagement, not a shared one**, destroyed when the engagement ends and never reused across targets.
- **Hardware virtualisation with the smallest surface that still works:** a microVM (Firecracker, Cloud Hypervisor or QEMU microvm) with a minimal
  kernel, one virtio NIC on a host-only bridge, no shared folders, no clipboard, no 9p/virtiofs mount of the person's home, and no host devices
  except what is named explicitly.
- **Network is deny-by-default.** The VM reaches the engagement's target scope and nothing else: an egress allowlist by address and port, DNS through
  the host's resolver only for names in scope, and no route to the host's own services or the local network beyond the scope. Anything else is dropped
  and logged.
- **No way back to the host:** no host mounts, no host ports forwarded into the VM except a control channel the host dials outward, no shared memory, and
  the agent's tools reach the VM only through that channel. The extension never executes VM output on the host.
- **Constraints inside the VM are the point:** snapshots before an exploit, a time and CPU budget, a disk quota, and a reset to the snapshot between
  attempts, so an agent may do anything inside and can always be rolled back.
- **Prove it, do not claim it.** A breakout test suite that tries the known escapes and must fail: mount the host, reach the host's localhost, read a
  host path through a shared folder, use a privileged container escape inside the VM, and exfiltrate to an address outside scope. Each escape attempt is
  a test with an expected refusal, and the gate runs them before a release.
- **What the person sees:** the panel says which isolation tier a run has (VM, container, temporary folder), and a scan cannot claim VM isolation unless
  the breakout suite passed on that machine.

Open questions for the owner when this starts: which hypervisor (KVM is available on Linux; macOS and Windows need a different answer), whether the VM
image ships with the extension or is fetched once, how much of a scan's speed the VM costs, and what the fallback is on a machine without hardware
virtualisation (my recommendation: refuse to claim isolation and say so plainly, rather than silently running in a container).

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-11-15 with the identity, credential and classification decisions (Platform direction 8-13); 2026-11-15 with the owner's platform direction and the v0.7.0 replan; 2026-11-05 with four recorded future features; 2026-10-29 after pausing v0.5.0 and continuing the 0.4.x line*
