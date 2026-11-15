# NVIDIA OpenShell: what to take for the NEAR AI agent trust layer

Date: 2026-11-15. Sources: a shallow clone of https://github.com/NVIDIA/OpenShell (commit `2e5589b`, 2026-11-13), a shallow clone of https://github.com/nearai/ironclaw (commit `b0b999d`, 2026-09-10, read only enough to judge fit), and this repository read on `origin/main`, `origin/fix/patch-0.4.23`, `origin/feat/messaging-relay` and the local `feat/team-fix-pass` branch. Nothing was run from either cloned repo. Paths like `docs/...` below are inside the OpenShell repo unless they start with `src/`, `relay/` or `.planning/`. Statements marked **(inference)** are my reading, not something a source says.

---

## 0. The short answer

- OpenShell is an OS-level enforcement runtime: it puts an agent (any agent, as a process in an OCI image) inside a sandbox that the kernel confines (Landlock for files, seccomp for syscalls and to intercept every TCP and DNS open), forces all network traffic through a trusted supervisor that checks a YAML policy, and injects real credentials only into requests bound for approved endpoints. It also ships an SMT-based **policy prover** that can show one policy grants no more than another.
- It has **no identity or delegation model of its own beyond OIDC, JWTs and SPIFFE**, and nothing about DIDs or chains. It is the missing bottom layer of the trust model in `.planning/PROJECT.md`, not a replacement for any part of it. A smart contract can decide "may this agent do X"; it cannot stop a running process from opening `.near-ai/state/keys/` or a socket to an unknown host. OpenShell can.
- Most valuable things to take, in order: (1) the **enforcement boundary** for agent shell and tool execution, as an optional backend, because our Bash guard is a text heuristic (SECURITY.md on `fix/patch-0.4.23`, lines 104-107, says so); (2) the **credential broker** pattern (placeholders in the agent, real secrets added at the boundary); (3) the **declarative policy format** as the compile target for DID constraints; (4) the **prover's boundary check** as the mechanism for "an agent can never grant more than it was delegated"; (5) the **gateway interceptor** pattern for verifying a policy against an on-chain anchor before a sandbox starts; (6) **OCSF audit events** as the local audit format, with periodic on-chain anchoring.
- Do not make OpenShell a hard requirement of the desktop extension. It needs Linux kernel 6.2+ with Landlock ABI 3 (inside Docker Desktop's VM on macOS), Docker 28+/Podman 5/KVM/Hypervisor.framework, Windows is experimental (WSL 2) or on a separate branch (native MXC, "not a production-qualified security boundary"). Make it a selectable enforcement backend, required for the relay and for the cyber-testing tier, optional on desktop.
- For the IronClaw-based direction: run the **whole IronClaw process (or its worker) inside an OpenShell sandbox** as the outer fence, keep IronClaw's WASM per-tool capabilities as the inner fence, and keep authority decisions in IronClaw's own capability host fed by the DID layer. Do not port OpenShell's enforcement code into the fork. Details in section 5.

---

## 1. What OpenShell is and does (from the repo)

### 1.1 Identity of the project

- Apache-2.0 (`LICENSE`, `README.md`). Copyright NVIDIA, 2025-2026. Now part of the CNCF, moving to the `ai-openshell` GitHub org (`README.md` note).
- Written in Rust (`Cargo.toml`, `crates/` with about 40 crates: `openshell-gateway`, `openshell-supervisor*`, `openshell-sandbox`, `openshell-policy`, `openshell-prover`, `openshell-ocsf`, `openshell-driver-{docker,podman,kubernetes,vm,mxc}`, `openshell-credential-issuer`, `openshell-driver-vault`, and so on).
- SDKs: Python (PyPI `openshell`), TypeScript (`@nvidia/openshell-sdk`, GitHub Packages for now, `sdk/typescript/README.md`), Go, Rust (`README.md`).
- Maturity: "New in OpenShell 0.1.x: a stable release cadence" (`README.md`). Weekly stable releases, N and N-1 minor lines supported, Experimental interfaces may change in a patch (`docs/about/support-matrix.mdx`, `rfc/0014-release-stability`). Many RFCs are still `draft` or `review` (for example `rfc/0011-multi-player-design` is draft, `rfc/0012-isolation-backend` is in review). **(inference)** Young but moving fast and well documented; treat its APIs as unstable for another few minors.
- Telemetry is **on by default** (anonymous counts), off with `OPENSHELL_TELEMETRY_ENABLED=false` or compiled out (`README.md` "Telemetry"). We would have to turn it off in anything we ship, given our privacy commitments in SECURITY.md.

### 1.2 Runtime model

Three trusted pieces and one untrusted one (`docs/about/architecture.mdx`):

| Piece | Role |
|---|---|
| Gateway | Control plane. Sandbox lifecycle, policy storage and revisions, provider (credential) storage, authentication (OIDC, JWT), authorization. |
| Supervisor | Trusted side of the boundary. Decides every network request against policy, resolves DNS, adds credentials, opens the real connection, relays logs. |
| Sandbox runtime (`openshell-sandbox`) | Lives inside the boundary with the agent, owns the agent's process tree, identifies which executable made each request from trusted `/proc` data, forwards TCP and DNS to the supervisor. Never makes policy decisions. |
| Workload | The agent, in a user-supplied OCI image. Untrusted. |

Enforcement mechanisms (`docs/about/architecture.mdx`, `docs/about/support-matrix.mdx` "Kernel Requirements", `docs/security/best-practices.mdx`):

- **Landlock LSM** (ABI 3, Linux 6.2+) confines filesystem access to listed paths. Required; launch fails closed if missing.
- **seccomp user notification** intercepts TCP opens and DNS so they wait for a supervisor decision; a startup seccomp prelude also blocks escape-shaped syscalls (`mount`, `pivot_root`, namespace creation, `ptrace`, `bpf`, `io_uring_setup`, user-namespace `clone`/`unshare`, installing further seccomp filters) with `EPERM` (`docs/security/best-practices.mdx` around lines 229-241).
- The workload runs as **one non-root identity with no Linux capabilities**; root UIDs are rejected by the policy schema.
- An **outer network fence** built by each runtime: Docker/Podman workload containers have networking turned off and talk to the supervisor over an authenticated Unix socket; Kubernetes uses NetworkPolicy; the MicroVM guest has no network device and uses vsock (`docs/about/architecture.mdx`, "How Each Runtime Builds the Boundary").
- **Binary identity**: every network rule is scoped to executables, and OpenShell pins each authorization-capable path to its first observed SHA-256 (trust on first use); a later mismatch is denied (`docs/security/best-practices.mdx`).
- **Fail closed**: the agent does not start until the supervisor confirms the boundary, and is frozen if the supervisor disconnects (`docs/about/architecture.mdx`, "Mediated Channel").
- **gVisor is not used.** RFC 0001 says the design "does not mandate Docker, microVMs, Kubernetes, Kata, gVisor, or any other specific runtime" (`rfc/0001-core-architecture/README.md`). The available hypervisor boundary is the **MicroVM** driver (libkrun; KVM on Linux, Hypervisor.framework on macOS). Note the warning that libkrun "does not confine a compromised guest kernel to the configured source directory" for VM bind mounts (`docs/how-it-works/sandboxes/runtimes.mdx` line 260).

Sessions are tied to a sandbox "generation" with gateway-signed JWTs; restart gives fresh tokens and certificates, and deleting a sandbox ends renewal (`docs/about/architecture.mdx`, "Gateway and Sandbox JWTs", "Renewing and revoking").

### 1.3 Policy language, versioning and enforcement

- A policy is **YAML, `version: 1`**, max 4 MiB, unknown fields and duplicate keys rejected (`docs/how-it-works/policies/schema.mdx`). Five sections: `filesystem_policy` (allowlists `read_only`, `read_write`, `include_workdir`; at most 256 paths; no `..`), `landlock` (`best_effort` or `hard_requirement`), `process` (`run_as_user`/`run_as_group`, never root), `network_policies` (named rules: endpoints x binaries), `network_middlewares` (content inspection hooks).
- Network rules are deny by default and can go to layer 7: `protocol: rest | websocket | graphql | mcp | json-rpc | tcp`, `access: read-only | read-write | full`, explicit `rules` and `deny_rules` on method, path glob and query, MCP tool-name allowlists, `enforcement: enforce | audit` (default `audit`, which only logs). Loopback, link-local and cloud metadata (`169.254.169.254`) are never reachable, and Kubernetes control-plane ports are blocked (`schema.mdx`, "Destination Fields").
- Decisions are evaluated by **OPA/Rego** in the supervisor (`crates/openshell-supervisor-network/data/sandbox-policy.rego`, `default allow_network = false`; log lines show `engine:opa` in `docs/observability/logging.mdx`).
- **Precedence**: global policy (replaces, not intersects, every sandbox's policy, and blocks changes while active), then the sandbox's saved policy, then a policy baked in the image at `/etc/openshell/policy.yaml`, then a restrictive default (`docs/how-it-works/policies/overview.mdx`). Providers add `_provider_*` network rules to form the **effective** policy.
- **Versioning**: the gateway saves each change as a numbered **revision**; the sandbox re-validates and reports `Loaded`; you can list and roll back (`docs/how-it-works/policies/manage-policies.mdx`). Filesystem, Landlock and process sections are **fixed at startup**; only network rules and middleware change live. Removing filesystem paths after start is rejected; you recreate the sandbox.
- **Policy advisor**: when a request is denied, the agent can propose a narrow network rule; a person approves; optional auto-approval only when risk checks find nothing (`docs/how-it-works/policies/advisor.mdx`). Proposals can only add network rules, never change filesystem or process settings.
- **Policy prover**: an SMT-solver check that a **candidate policy grants nothing beyond a boundary policy**, covering filesystem, process, Landlock, network and REST rules, and refusing (not ignoring) GraphQL/MCP rules it cannot model. It runs standalone (`openshell-prover check candidate.yaml --boundary boundary.yaml`), needs no gateway, and the docs give exactly our use case: "a parent agent can check that a policy it writes for a subagent stays within the parent's own maximum allowed policy" (`docs/how-it-works/policies/prover.mdx`).
- **Gateway interceptors**: an external gRPC service called after authentication and before the handler, phases `modify_operation` (allow, deny or JSON-patch), `validate`, `post_commit` (observe) (`docs/extensibility/gateway-interceptors.mdx`). The example `examples/governance-interceptor/README.md` vends signed provider profiles, applies a **signed policy** to every new sandbox, denies "unsigned, stale, or modified policies", denies sandbox-authored proposals and blocks auto-approval.

### 1.4 Credentials and inference routing

- **Providers** are named credentials stored by the gateway; **profiles** say which endpoints, ports, paths and binaries a credential may reach (`docs/how-it-works/providers/overview.mdx`, `providers/*.yaml`). The agent sees an **opaque placeholder** (`openshell:resolve:env:KEY`); the supervisor substitutes the real value only on a request to an approved endpoint, optionally in bodies or WebSocket text, and can do AWS SigV4 signing itself (`schema.mdx`, "Credential Fields"; `docs/about/architecture.mdx`). Detaching a provider revokes it (`docs/how-it-works/inference.mdx`).
- Dynamic credentials: OIDC token exchange, SPIFFE JWT-SVID token grants (`examples/spiffe-token-grant-demo/README.md`), Vault and Kubernetes secrets drivers (`crates/openshell-driver-vault`, `crates/openshell-driver-kubernetes-secrets`), a credential issuer service (`crates/openshell-credential-issuer`).
- **Inference** is not a special router any more: the workload calls the model provider's native API and the supervisor enforces the profile's endpoints and injects the key (`docs/how-it-works/inference.mdx`). "Provider attachment does not select or rewrite a model." A host-local model is reached through `host.openshell.internal`. Using the `openai` profile with a different base URL deliberately does **not** carry the credential to the new host. **(inference)** So "privacy routing" in OpenShell means "this agent's traffic can only reach the inference endpoints you approved, with keys it never sees". It has no notion of TEE attestation; that stays our job (we already check TEE in SECURITY.md line 249 area and `nearAi.agent.safetyModel`).
- **Supervisor middleware** (RFC 0009, accepted) inspects, transforms, blocks or annotates outbound requests by content, for example redacting PII from prompts before they leave (`rfc/0009-supervisor-middleware/README.md`).

### 1.5 Agents supported

Any agent installed in an OCI image ("OpenShell can run any agent that is available in a sandbox image", `docs/about/run-your-first-agent.mdx`, which uses OpenCode). Example provider profiles exist for Claude Code, Codex, Copilot, Cursor, Anthropic, OpenAI, OpenRouter, NVIDIA, Bedrock, Vertex, GitHub, PyPI and others (`providers/`). `examples/codex-app-server` runs Codex's app server inside a sandbox. RFC 0011 names OpenClaw as an example harness that procures sandboxes from a gateway (`rfc/0011-multi-player-design/README.md` lines 239, 904-909), and `docs/security/best-practices.mdx` points to NVIDIA's NemoClaw. There is a VS Code Remote-SSH path into a sandbox (`examples/vscode-remote-sandbox.md`).

### 1.6 Audit and logging

Every sandbox log carries **OCSF** structured events: `NET:` (4001), `HTTP:` (4002), `PROC:` (1007), `FINDING:` (2004), `AUTH:` (3002), `API:` (6003, inference calls), `CONFIG:` (5019, policy loads) and more, each with allow/deny, the binary and the matching policy rule (`docs/observability/logging.mdx`). The gateway can write OCSF JSONL or export via OpenTelemetry (`docs/observability/ocsf-json-export.mdx`); events never include presented credentials. RFC 0011 adds a control-plane audit log of every mutating call. Multi-tenant "workspaces" with Platform Admin / Workspace Admin / User roles exist (`docs/how-it-works/workspaces.mdx`).

### 1.7 Platforms

`docs/about/support-matrix.mdx`: Linux amd64/arm64 supported; macOS Apple Silicon supported via Docker Desktop (the kernel features run inside Docker Desktop's Linux VM) or MicroVM; Windows via WSL 2 + Docker Desktop is **experimental**; native Windows (Microsoft MXC ProcessContainer) lives on the `windows` branch and `WINDOWS.md` says it "is not a production-qualified security boundary" (exclusive egress mediation and live revocation unverified). No Intel Mac listed. Gateway with Docker needs the **Docker API socket** (`docs/how-it-works/sandboxes/runtimes.mdx`).

### 1.8 Things that matter for an IDE agent specifically

- Project files normally get into a sandbox by **copying** (`openshell sandbox upload` / `download`, `examples/sync-files.md`) or named volumes. **Bind mounts of host folders** are opt-in (`enable_bind_mounts = true`) and the docs warn they "can bypass workspace isolation and filesystem policy" (`docs/how-it-works/sandboxes/runtimes.mdx` line 171). **(inference)** An agent editing the person's live checkout is the case OpenShell is least designed for; the clean pattern is "work in a copy, bring back a diff".
- Landlock rules are **allowlists only** (schema has `read_only` and `read_write`, no deny list). **(inference)** You cannot say "the workspace is writable except `.near-ai/state/keys`" in an OpenShell policy; the protected folder must simply not be present in the sandbox.

---

## 2. Mapping OpenShell onto the DID model

### 2.1 What a DID can carry versus what OpenShell can enforce

Our model (PROJECT.md, "Verifiable agent guardrails"): each agent has a NEAR implicit account and a W3C DID carrying its constraints; it cannot exceed what it was created with or delegated; only the orchestrator changes it, with authority delegated by a person; policies are immutable contracts that gate each action.

| Constraint in the DID | Compiles to OpenShell? | Who enforces it |
|---|---|---|
| Files the agent may read / write (workspace subtree, scratch) | Yes: `filesystem_policy.read_only` / `read_write` | Kernel (Landlock), at sandbox start |
| Hosts / APIs the agent may reach, per method and path | Yes: `network_policies` with `protocol: rest`, `access`, `rules`, `deny_rules`, `enforcement: enforce` | Supervisor (OPA), per connection and per request |
| MCP tools the agent may call over the network | Yes: `protocol: mcp` rules | Supervisor |
| Credentials the agent may use, and where | Yes, by reference: provider attachment plus profile endpoints. The DID names a provider, never a secret value | Supervisor (placeholder substitution) |
| Run as non-root, no capabilities | Yes: `process` | Runtime |
| Which models it may use; TEE only | Partly: endpoint allowlist only. Attestation check is ours | Our model client plus network policy |
| Spend limits, budgets (team `budget.set`, `allocation.*`) | No | Our engine / contract |
| Team actions (claim item, move card, approve merge, `src/domain/team/permissions.ts` on `feat/team-fix-pass`) | No | Our signed-event validation |
| Approval requirements (risky, sharedWrite always asks, `src/domain/policy.ts`) | No (OpenShell's only human loop is the policy advisor for network rules) | Our approval flow in `src/agent/loop.ts` |
| Time window, run count, expiry | No (only JWT TTL per sandbox generation) | Our engine / contract |
| Who may change the DID (orchestrator with person's delegation) | No; OpenShell's admin model is OIDC roles | DID layer / contract |

So: **a DID's runtime-resource constraints compile cleanly into an OpenShell policy; its business and delegation constraints do not and should not.** Put both in one DID document, with a clearly separated `sandbox` section whose schema is the OpenShell policy schema (or a subset of it), and an `authority` section for spend, actions, approvals and delegation.

### 2.2 Delegation as policy containment

The prover gives a concrete, checkable meaning to "an agent can never grant itself more than it was delegated":

- Person grants the orchestrator a **boundary** policy B0 (the most this team may ever do).
- Orchestrator writes a policy Pi for each agent; `openshell-prover check Pi --boundary B0` must pass. A sub-agent's policy must pass against its parent's policy.
- The DID document of each agent records `policyHash(Pi)`, `parentDid`, and the parent's signature. Verification is: signature chain valid, hashes match, and the containment proof re-runs and passes.

Limits to state honestly: the prover models filesystem, process, Landlock, network and REST; it refuses GraphQL and MCP rules (`prover.mdx`), so delegated policies that use those must be checked another way or forbidden. Spend and action constraints need our own (much simpler) monotonic check: child budget <= parent remaining budget, child action set subset of parent action set.

### 2.3 On-chain versus local

A contract call per shell command or per TCP connect is not workable: it adds network latency to every action, fails when the chain is unreachable, and cannot see inside the machine anyway. **(inference, from the architecture rather than any NEAR doc I read)**

| Concern | On-chain | Local runtime |
|---|---|---|
| Agent identity (implicit account, DID) | Yes | Cache |
| Delegation chain, policy hash per agent, parent signature | Yes (anchor) | Verify on load |
| Revocation (agent or delegation withdrawn) | Yes (the source of truth) | Checked at run start and at lease renewal; cached with expiry |
| Coarse authorization: "may this agent start a run with policy hash H, budget N" | Yes, once per run or per lease | |
| Fine authorization: this file, this socket, this HTTP request | No | OpenShell-style sandbox and proxy |
| Credential release | No (never put secrets or references that leak them on chain, even confidentially, without a clear need) | Credential broker |
| Approval of risky actions | Record the decision hash | The person approves in the editor |
| Audit | Anchor a hash chain root periodically | Full OCSF / signed event log |

### 2.4 Proposed layered architecture

```
L1 Identity and delegation (DID)
   person -> orchestrator -> agent -> sub-agent; each DID holds: policyHash, authority section,
   parent DID, parent signature, expiry. Anchored on NEAR; revocation on NEAR.
        |
L2 Policy decision
   a) run admission (once per run / lease): verify DID chain, revocation, policy containment
      (prover), budget. Result: a short-lived signed run lease bound to policyHash and run id.
      Source of truth on chain; decision can be made by a local verifier against cached chain state.
   b) per-action decisions inside the run: our existing engine (src/agent/permissions.ts,
      src/domain/policy.ts, approval cards) for approvals, team actions, spend.
        |
L3 Enforcement
   OpenShell (or equivalent) sandbox around tool execution: Landlock files, seccomp, network fence,
   egress proxy with per-binary L7 rules, credential placeholders, fail closed.
   Loads ONLY a policy whose hash equals the lease's policyHash (gateway interceptor pattern).
        |
L4 Audit
   OCSF events from the sandbox + our signed team events, hash-chained locally;
   chain root anchored on NEAR per run or per interval; dashboard reads both.
```

Chain unreachable and offline runs (open questions in PROJECT.md): the lease makes these concrete. A run may start offline only on a cached, unexpired lease or a cached DID whose policy it **attenuates** (never widens); widening always needs the chain. Audit roots queue and anchor when the chain returns. **(inference)** This mirrors how OpenShell keeps working when the gateway drops for a short recovery window but freezes after it.

---

## 3. What to incorporate, prioritized

Value and effort are my judgement; effort assumes the current TypeScript extension.

### P1. A real enforcement boundary for Bash and tool execution (high value, medium-high effort)

The problem is documented: "The shell checks read text, so they are a heuristic: a path built at run time ..., a script that another script or `npm run` starts, or a directory walk is not caught. There is no OS-level sandbox around the agent's shell." (SECURITY.md on `origin/fix/patch-0.4.23`, lines 104-107). `src/agent/shell.ts` spawns `bash -c` on the host with the editor's environment minus secret-looking names (`shellEnv`, lines 180-200 on main).

Proposal: an **execution backend** setting with three values:
- `host` (today's behavior, the text guard and approvals stay);
- `container` (what `src/services/cyberSandbox.ts` already does for cyber payloads: `docker run --rm --network none`), extended to agent shells;
- `openshell` (agent shell runs inside an OpenShell sandbox).

How the workspace gets in matters more than which runtime: run the agent against a **copy** (a git worktree or upload of the project without `.near-ai/state`, `.git/hooks` and other protected paths), and bring changes back as a diff the extension shows and applies. That turns the protected-path rule from a regex (`src/domain/protectedPaths.ts`) into a structural fact: the keys folder is not in the sandbox. Avoid OpenShell host bind mounts of the live checkout; its own docs say they can bypass filesystem policy.

Keep the existing text guard and approval cards as the **user-experience layer** (they explain to a person why something asks), and stop describing them as the security boundary when a sandbox backend is active.

Risks: worktree/diff flow changes how agents feel (long builds, `node_modules`, dev servers); needs Docker on the user's machine; Windows users get the weakest boundary. Mitigation: per-project opt-in, default to `container` or `openshell` only where available, say plainly in the UI which boundary is active.

### P2. Credential broker: keys never enter the agent's environment (high value, medium effort)

Today we strip secret-looking variables from the shell environment by name and value pattern (`src/agent/shell.ts`), which is a deny-list and can miss things. OpenShell's pattern is a positive model: the agent gets a placeholder, the boundary substitutes the real key only for approved endpoints, and the key is never in the sandbox.

Take the pattern even without OpenShell: the extension already holds NEAR AI keys in SecretStorage and calls the model itself, so agent processes rarely need keys. For the cases that do (a project's `npm publish`, `gh`), route them through a small local egress proxy that the sandboxed process must use, with per-tool endpoint bindings. Where OpenShell is the backend, use its providers directly.

Risk: a proxy that is optional is bypassable on the host backend; the guarantee only holds with a network fence (container or OpenShell).

### P3. Declarative policy per team and agent, in OpenShell's schema (high value, low-medium effort)

Adopt the OpenShell policy YAML (`version: 1`, the five sections) as the **compile target** for the `sandbox` section of an agent's DID and for a team's boundary policy, rather than inventing our own format. Benefits: a documented schema, a validator, the prover, OCSF decisions that name the rule, and portability to the relay and to an IronClaw-based runtime. Our team policy (`src/domain/team/policy.ts` on `feat/team-fix-pass`: `sharedPaths`, `allowedModels`, `teeOnly`, budgets) stays our own format in the `authority` section.

Risk: schema churn while OpenShell is 0.1.x; pin a version and validate against it.

### P4. Containment proofs for delegation (high value for the DID story, low effort to prototype)

Use the standalone `openshell-prover` (static Linux musl and macOS Apple Silicon binaries, no gateway needed, `support-matrix.mdx`) to check every child policy against its parent at delegation time, and record the result in the DID. This is the most direct, cheap win: it makes "can never exceed its delegation" a machine-checked statement for files and network, today. Not available on Windows natively (no Windows prover artifact listed), so run it on the orchestrator's side, the relay, or CI.

Risk: the prover is an external binary with an SMT solver; ship it as an optional download with checksum, or run it server-side.

### P5. Egress allowlists (medium-high value, medium effort without OpenShell)

Our network control today is per command (classifier and `CARRIES_DATA` holds after outside content, `src/agent/permissions.ts`) plus WebFetch checks. Per-binary, per-host, per-method egress rules with deny by default are strictly stronger. Only meaningful with a fence (P1). Take OpenShell's specific safe defaults even on our own fence: never metadata or link-local, no loopback egress, `enforce` rather than `audit`.

### P6. Policy-change review with risk checks (medium value, low effort)

OpenShell's advisor flow (agent proposes a narrow rule after a denial, risk checks, person approves) fits our approval cards exactly. The proposal becomes a delegation change, so it must be signed by the orchestrator under a person's authority and anchored. Keep auto-approval off by default (the governance interceptor example blocks it outright).

### P7. Audit in OCSF (medium value, low effort)

Emit our security events (`onSecurity` held/blocked in `src/agent/loop.ts`) as OCSF classes alongside our signed team events, so the activity dashboard, the relay and a SIEM read one format. Hash-chain them and anchor the root (L4).

### P8. Inference routing to private (TEE) models (low incremental value)

OpenShell restricts which inference endpoints an agent can reach and hides the key; it does not attest TEEs or choose models. We already do the TEE part. Use OpenShell's endpoint rules to make sure a sandboxed agent cannot call a non-TEE endpoint directly, and keep attestation in our model client.

### What NOT to adopt

- **OpenShell's gateway as our identity or authorization system.** Its users and roles are OIDC-based; our identity is the DID chain. Use the gateway as an enforcement control plane only, behind an interceptor that checks our anchors.
- **Global policy semantics** that replace rather than intersect sandbox policies (`policies/overview.mdx`). Our delegation is attenuation; replacement would let a misconfigured global policy widen an agent.
- **Auto-approval of policy proposals**, and `enforcement: audit` (the default) for anything that matters.
- **Host bind mounts** of the person's checkout, and the MicroVM bind-mount path for anything untrusted.
- **Telemetry on**; ship with it off.
- **The native Windows MXC backend** as a security claim, until OpenShell itself calls it production-qualified.
- **Requiring Docker for every desktop user.** The extension must keep a host mode that works everywhere, clearly labeled.
- **Putting per-action checks on chain.** Run-level admission and revocation yes; per syscall no.

### Platform summary

| Where users run | OpenShell feasibility | Recommendation |
|---|---|---|
| Linux desktop, kernel 6.2+, Docker 28+ or Podman 5 | Supported | Offer `openshell` backend |
| macOS Apple Silicon with Docker Desktop | Supported (enforcement inside Docker's VM) | Offer it; boundary is the Linux VM plus Landlock |
| macOS Intel | Not listed | `container` or `host` |
| Windows | WSL 2 experimental; native on a separate branch, not production | `container` via Docker Desktop or `host`, labeled |
| code-server in Docker | Needs the host Docker socket or nested containers to run a gateway. **(inference)** Mounting the host Docker socket into the code-server container gives that container root-equivalent control of the host, which is worse than no sandbox | Run the OpenShell gateway on the host next to code-server, with code-server talking to it over a socket or the TypeScript SDK; never hand code-server the Docker socket |

---

## 4. Relay, extension, and the move to Theia

**Relay** (`relay/` on `origin/feat/messaging-relay`; ROADMAP Phases 68-76): headless, containerized, eventually multi-tenant, and it "runs a team headlessly by composing the existing agent engine, tools ..." (ROADMAP RUNL-01). It already has the right instincts: distroless image, secrets from operator files, redacting logger, private state dir with strict modes (`relay/README.md`). This is where OpenShell fits best:
- The relay is Linux, server-side, and already container-based; Kubernetes and Docker drivers are OpenShell's best-supported paths.
- A chat message from Teams or Signal is exactly the "untrusted input drives an agent" case. Each run should execute in its own sandbox with a policy derived from the tenant's DID boundary, and credentials (tenant API keys) as providers, never in the run's environment.
- OpenShell workspaces (`docs/how-it-works/workspaces.mdx`) map to tenants; RFC 0011's audit log maps to the relay's per-tenant audit.
- Make OpenShell (or an equivalent fence) **required** for the relay once it executes tools, rather than optional. Note the relay itself runs in a container; it should talk to an OpenShell gateway beside it, not run sandboxes by mounting the Docker socket into itself.

**Extension** (desktop): optional backend as in section 3, because of platforms and because people expect edits to land in their checkout.

**Theia**: everything in L1, L2a, L3 and L4 is editor-agnostic: the DID verifier, the policy compiler, the prover call, the sandbox backend and the OCSF audit writer should live in a package with no `vscode` import, the same discipline `src/domain/` already follows ("Pure: no I/O, no imports from src/agent" in `protectedPaths.ts`). Only approval cards, the activity dashboard and the settings UI are editor-specific. **(inference)** Theia's backend runs as a Node process on a server more often than VS Code does, which makes a server-side OpenShell gateway the natural deployment there too, so a Theia product inherits the relay's architecture more than the desktop extension's.

---

## 5. Fit with an IronClaw-based core (owner's current direction)

What I read in IronClaw (`README.md`, `Dockerfile.process-sandbox`, `docs/internal/reborn/contracts/runtime-selection.md`, `.../runtime-profiles.md`, `crates/` listing):
- Rust, MIT or Apache-2.0. A WASM tool sandbox with capability-based permissions, endpoint allowlisting, credential injection "at the host boundary, never exposed to WASM code", request and response leak scanning, rate and resource limits (`README.md` "Security").
- An orchestrator/worker split with Docker sandbox containers and per-job tokens (`README.md` "Architecture"). The process sandbox image routes credentialed runs through `HTTP(S)_PROXY` to a host broker with a per-run CA; secrets are not passed as environment values (`Dockerfile.process-sandbox` header).
- Its newer "Reborn" contracts separate **authority** from **containment**: "CapabilityHost remains the authority boundary. A sandbox can reduce blast radius, but it does not grant authority. Grants, leases, approvals, resource accounting, secret handling, network policy, and audit stay outside the runtime lane" (`runtime-selection.md`). Process backends are an enum `SandboxBackend { Srt, SmolVm, Docker, ... }`, raw shell is "never ambient", always scoped and sandboxed. (`Srt` is not expanded in what I read; it may be Anthropic's sandbox-runtime, **inference**.) Kernel crates include `ironclaw_authorization`, `ironclaw_approvals`, `ironclaw_trust`, `ironclaw_capabilities`, `ironclaw_runtime_policy`.

Judgement on the three options the owner named:

1. **Run the whole IronClaw process (or each worker) inside an OpenShell sandbox.** Good fit and lowest effort. IronClaw's own model already says containment is a pluggable backend under a separate authority layer, and OpenShell's own model says the sandbox runs "any agent in an image". The OS fence then covers everything WASM does not: native code in process-backed tools, MCP stdio servers, build and test runs, and bugs in IronClaw's host itself. Caveat: IronClaw's own Docker orchestrator inside an OpenShell sandbox would need nested containers, which the seccomp prelude forbids (no namespace creation, no `mount`). So run IronClaw's **workers** as OpenShell sandboxes (add OpenShell as another `SandboxBackend`), and keep the orchestrator outside on the trusted side.
2. **Port OpenShell's policy enforcement into the fork.** Not recommended. The enforcement is kernel plumbing (Landlock, seccomp user notification, binary identity, fenced transports across four runtimes) that NVIDIA and the CNCF will keep hardening; a fork would freeze a copy. Port the **ideas and formats** instead: the policy YAML as the network/filesystem section of IronClaw's runtime policy, OCSF event shapes, placeholder credentials, and call the standalone prover.
3. **Combine WASM per-tool isolation with an OS-level outer sandbox.** This is the target, and it is option 1 done properly: WASM is the inner, fine-grained, per-tool fence (no ambient authority, capability-scoped HTTP); OpenShell is the outer, coarse, per-run fence that holds even if the WASM runtime, a native tool or the agent host is compromised. Both fences should be compiled from the same DID policy so they cannot disagree: the WASM capability manifest for each tool must be a subset of the sandbox policy, checked with the same containment idea as section 2.2.

Credential handling: IronClaw's host broker and OpenShell's supervisor both inject credentials at a boundary. Use one of them per deployment, not both in series. **(inference)** On the relay and servers, prefer OpenShell's supervisor (it sits outside the workload boundary); on a desktop without OpenShell, IronClaw's host broker is the fallback.

DID layering with IronClaw: L1 DID verifier feeds IronClaw's `ironclaw_trust` / `ironclaw_authorization` (grants and leases); L2a run admission issues the lease IronClaw already models; L2b is IronClaw's capability host plus our approval UI; L3 is IronClaw WASM inside OpenShell; L4 merges IronClaw's tool audit log ("Full audit log of all tool executions", `README.md`) with OpenShell OCSF events into one anchored chain.

For Hermes Agent (not researched): whatever plugin or tool system it brings would sit at L2b and run inside the same L3 fence; it needs no special treatment from OpenShell as long as its tools execute as processes in the sandbox.

---

## 6. Suggested next steps

1. Spike (1-2 days, Linux): run the extension's agent shell against a worktree copy inside an OpenShell sandbox on a host gateway, with Landlock limited to the copy, one npm registry rule and the NEAR AI endpoint, and confirm the run-time read of `.near-ai/state/keys` that the text guard cannot catch is now impossible because the folder is absent.
2. Spike (half a day): draft a DID document with `sandbox` (OpenShell policy) and `authority` sections; run `openshell-prover` for a parent/child pair; write down what goes on chain (hashes, parent, signature, expiry, revocation).
3. Decide per surface: relay requires a fence; desktop offers it; code-server deployment puts the gateway on the host.
4. Before relying on OpenShell, re-read its stable-interface list for the version you pin, turn telemetry off, and track RFC 0011 (multi-tenant) and RFC 0012 (isolation backend) status.
