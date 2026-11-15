# Platform direction research (2026-11-15)

Source-level reviews of three agent projects, read but never run, and the recommendation the owner accepted on 2026-11-15. The decisions taken from them are recorded in `.planning/PROJECT.md` under "Platform direction", and the plan built on them is the v0.7.0 section of `.planning/ROADMAP.md`.

| File | What it is |
|------|------------|
| [summary.html](./summary.html) | The accepted recommendation: keep our TypeScript engine, take IronClaw's capability and authorization design, Hermes's workflow ideas reshaped to pass a DID policy gate, and OpenShell as the sandbox; build order, what not to copy, and the Theia container appliance. |
| [ironclaw-analysis.md](./ironclaw-analysis.md) | IronClaw (NEAR AI, Rust): capability manifests, credentials injected at the boundary, staged authorization, restrict-only hooks, run guardrails, channel manifests and two-step pairing, and why a fork is not recommended. |
| [hermes-analysis.md](./hermes-analysis.md) | Hermes Agent (Nous Research, Python): delegation that only narrows, request-bound approvals, schedules, learned skills as proposals, the package lifecycle, and why its in-process plugins fail the single-gate test. |
| [openshell-analysis.md](./openshell-analysis.md) | NVIDIA OpenShell (Rust, CNCF): kernel-enforced sandbox, policy YAML and the policy prover, credential placeholders, OCSF audit, and how a DID's sandbox section compiles to an OpenShell policy. |
| openshell-spike.md | Not written yet. The OpenShell spike approved on 2026-11-15 (agent shell on a worktree copy inside OpenShell; a run-time read of `.near-ai/state/keys` must become impossible; a DID document with a sandbox section and the prover on a parent and child pair) writes its result here. Phase 72 (execution backends) reads it before planning. |
