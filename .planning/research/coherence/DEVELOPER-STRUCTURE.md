# Developer structure: layers, shared kits, ADRs and phase conventions

Part of the coherence review (`REVIEW.md` in this folder). Written 2026-11-20 against `origin/main` at 15bc560c. Numbers come from reading the code; no tests were run.

## 1. Layers and one architecture test

What holds today: no file under `src/domain`, `src/agent`, `src/staff`, `src/gate` or `src/team` imports `vscode`; only `src/services` does. `src/test/teamBoundaries.test.ts` and `src/test/replicaBoundaries.test.ts` guard `domain/team`, `domain/gate`, `domain/staff`, `domain/replica`, `src/team` and `src/gate`. The rest of `src/domain`, `src/agent` and `src/staff` have no guard, and that is where the leaks are: `domain/auth.ts` and `domain/state/{threadView,threadCapture,syncStatus}.ts` import from `services`; `domain/cyberLimits.ts` imports `agent/permissions`; the chat message types live in `services/nearAiClient.ts`. Folder pairs import each other: agent and services, gsd and agent, mcp and agent, staff and services, gate and services, team and services.

| Layer | Folders | May import | Never |
|---|---|---|---|
| Composition root | `src/extension.ts` | everything | holds no logic |
| Editor | `src/services/<area>/` | everything below | imported by anything below |
| Engines and hosts (Node) | `src/agent`, `src/gsd`, `src/mcp`, `src/staff`, `src/gate`, `src/team` | platform, domain; another engine only through a declared seam (for example `agent` uses `domain/provider`, never `services/nearAiClient`) | `vscode`, `services` |
| Platform (Node) | `src/platform/node/` (new): `writeFileAtomic`, file lock, state home, secret store shape, process runner, fetch | domain | engines, services |
| Domain (pure) | `src/domain/<area>/`: `core`, `chat`, `provider`, `gate` (labels, routing, policy, trust), `org` (modes, `term()`), `team`, `replica`, `staff`, `setup`, `state`, `cyber` | other domain areas, `node:crypto` | `vscode`, `node:fs`, `node:os`, any package |
| Domain core | `src/domain/core/`: canonical JSON, signing, key status, validate (`isRecord`), ids, time | nothing in domain | |
| Servers | `relay/`, `hub/`, and a shared `services-kit/` (logger, secrets from files, state folder, health) | `src/domain` through a path alias | extension code |

**One test.** `src/test/architecture.test.ts` merges the two boundary scanners and is driven by the table above. It starts with a **checked-in baseline** (`src/test/architecture-baseline.json`) listing today's violations (the seven domain leaks and the folder cycles above), so it passes on the day it lands and fails on any new violation. Each move deletes baseline lines; the baseline may only shrink. The same test checks:

- no `SCALE_PRESETS` import outside `domain/gate` and the starting rules (fixes the two-evaluator drift, REVIEW S7);
- no nonce `randomBytes` or CSP string outside the webview kit;
- no temp-file `rename(` outside `platform/node`;
- no `getConfiguration` outside `services/settings.ts`;
- a file-size budget: warn at 800 lines, fail for a new file above 1,200; today's large files (`agent/commandSafety.ts` 2,900, `services/agentSession.ts` 2,738, `services/teamStudioPage.ts` 2,236, `agent/teamTemplateHistory.ts` 2,046, `services/nearAiClient.ts` 1,930, `staff/staffHost.ts` 1,612, `services/chat.ts` 1,517) are frozen at their size, and a phase that changes one moves the part it changes out first.

## 2. Shared kits every feature uses

| Kit | Home | Replaces |
|---|---|---|
| Webview kit: `openPanel({ id, title, assets, retain })`, one CSP, nonce, `base.css`, layout probe, theme tokens, typed `onMessage(parser)` and `post(msg)`, accessibility checks | `src/services/webview/`, `media/shared/` | ten hand-built hosts with four CSP variants; `cyberPanel.ts` lacks `base.css` and the probe |
| Typed messages: one `Inbound`/`Outbound` union per page in TypeScript, emitted as `.d.ts` for `// @ts-check` page scripts | `src/services/<area>/protocol.ts`, `media/shared/protocol.d.ts` | untyped `case 'x':` switches in 23 scripts (12,664 lines) |
| Record writer: `writeRecord(path, value, { schemaVersion, mode })` over one `writeFileAtomic` (fsync, mode 0600, write queue, Windows rename retry) | `src/platform/node/records.ts` | about 20 inline atomic writers |
| Policy reader: `policy.section('labels' \| 'endpoints' \| ...)` returning typed, verified sections, one change subscription | `src/gate/policyReader.ts` over `domain/gate/bundle.ts` | ad hoc reads in `gate/host.ts`, `agent/gateAdapter.ts`, `services/gateCommands.ts` |
| Label service: `dominates`, `join`, `atLeast` over the active `ScaleTable`, in a dependency-free module the hub can import | `src/domain/gate/labels.ts` (dependency-free) | the staff observation evaluator and the roster kind schema's own copy of the label words |
| Decision function and trust facts: `decideRoute(...)` and `TrustFacts` | `src/domain/gate/routing.ts`, `src/domain/gate/trust.ts` | badge, picker, team privacy and privacy mode words computed in several places |
| Provider interface: `ModelEndpoint` (chat stream, list models, facts: endpoint id, class, region, attestation source, spend account) and `LocalServerAdmin` (install, list, delete, verify hash) | `src/domain/provider/` | the concrete 1,930-line `NearAiClient` imported in 34 places; Cohere's planned `route: 'vault'` and eight local adapters bolted onto it |
| `term(concept, mode)`, with doctrine words as one profile under it | `src/domain/org/terms.ts` | words spelled in hosts and pages |
| Setup step contract: `{ id, title, state(), viability(), run() }` | `src/domain/setup/`, `src/services/setup/` | separate setup commands |
| Untrusted fence: one `fence(source, text, notes)` | `src/agent/untrusted.ts` | four fences (`untrusted.ts`, `staffFence.ts`, `mcp/tools.ts`, `observationsTools.ts`) |
| Shared test fakes: secrets, memento, clock, fs, vscode stub, fake `ModelEndpoint`, git world | `src/test/fakes/` | `MemorySecrets` redefined in 19 files; 10 private `vscode` fakes through `Module._load` |

## 3. ADRs (one line each)

1. **ADR-001 Layers and the architecture test:** the table in section 1, enforced by one test with a shrinking baseline.
2. **ADR-002 Folder triple:** `domain/x` (pure), `x/` (Node host), `services/x` (editor), and the renames `domain/policy.ts` to `actionPolicy.ts`, `domain/team/policy.ts` to `teamPolicy.ts`, `domain/routing.ts` to `memoryRouting.ts`.
3. **ADR-003 Policy bundle v2:** sections, `requires`, `needs-update`, layers, narrowing directions, how a phase adds a field (`POLICY-SCHEMA.md`).
4. **ADR-004 One label algebra:** the active bundle's scale table is the only source; presets only seed the starting rules.
5. **ADR-005 Provider interface:** `ModelEndpoint` with endpoint facts; adapters for NEAR AI, Cohere vaults and each local server.
6. **ADR-006 Local server management:** `LocalServerAdmin`, catalogue hash checks, the adapter list.
7. **ADR-007 Trust facts:** one `TrustFacts` record; every user trust word derived from it.
8. **ADR-008 Organization modes and `term()`:** concept keys, doctrine as a profile, the copy lint.
9. **ADR-009 Identity:** one device key per install, one person id per organization (the roster member id, with an optional `did`), one device lifecycle; Team Mode ids map on import at L2.
10. **ADR-010 Collaboration transport:** new shared features use the replica layer; the Team Mode log is frozen and import-only at L2.
11. **ADR-011 Records:** shared facts are replica entries; local audit is the OCSF record, hash-chained, with periodic signed heads; standalone artifacts use `signedPayload` envelopes; nothing is called "signed" per record until it is.
12. **ADR-012 Webview kit and typed messages,** including `@ts-check` for page scripts.
13. **ADR-013 Settings and commands:** one settings accessor, command namespaces, the alias policy (two minor releases).
14. **ADR-014 Server workspaces:** `relay/`, `hub/` and `services-kit/`; servers on Node 26, the extension on the VS Code runtime, and why.
15. **ADR-015 Test structure:** folders per area, shared fakes, a heavy shard (fork, git, ports), a default concurrency cap in `scripts/run-tests.mjs`, an injected clock, per-run TMPDIR.

## 4. Conventions for every new phase

- The plan names each new file's layer and checks every cited `src/` path against main (designs cite paths that do not exist: `src/replica/store.ts`, `src/domain/gate/models.ts`, `src/team/secrets.ts`).
- New policy fields go into a v2 section with a `requires` feature id and a declared narrowing direction.
- New trust words come from `TrustFacts`; new user words from `term()` and the glossary; the copy lint passes.
- New pages use the webview kit and a typed protocol; new disk state uses the record writer; new models use `ModelEndpoint`.
- A setup flow is a step registered with the guide, never a new command.
- Shared multi-person state goes on the replica layer; local audit uses the record format.
- New tests go in the area folder, use `src/test/fakes`, inject a clock, and are marked heavy if they fork, spawn git or listen.
- No new file above 800 lines without a note in the plan.

## 5. Order

1. ADR-001, ADR-003, ADR-005 and the architecture test with its baseline (in F1, Phase 41).
2. The webview kit and record writer (in F1 or the first phase that adds a page, whichever is first: Phase 32.1).
3. One mechanical restructuring PR (moves with re-exports, no behaviour change) right after the architecture test, so 32.1 and later land in the target layout. Phase 32's hub work is in `hub/` and is not touched by it.
