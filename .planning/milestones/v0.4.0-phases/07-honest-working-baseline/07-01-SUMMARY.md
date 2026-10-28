# 07-01 Summary: honest, working baseline

Completed 2026-10-26. Evidence is the test that drives each behavior through its real entry point.

| Requirement | What changed | Evidence |
| --- | --- | --- |
| FIX-01 | Open-GSD is detected from `gsd-core/VERSION` in the runtime home, not `npm list -g` (which never sees installer-copied runtimes). Confirmed 1.19.0 detected on the dev machine. | `workspaceIsolation.test.ts` (real fixture directories: installed, missing, current, older) |
| FIX-02 | Actual cost from `POST /v1/billing/costs` keyed by the `inference-id` header (nano-USD), polled briefly; unrecorded stays an estimate. Streamed usage requested; the completion event now carries streamed usage (it previously kept only header metadata, so estimates never reached the footer). Provider cached per profile so pricing is loaded. | `chatSendPath.test.ts` (sidebar send → fake NEAR → estimate + billed cost), `nearAiClient.test.ts` |
| FIX-03 | Model privacy from `/v1/model/list` (attested NEAR-served → TEE; external → forwarded, with destination host). Shown in the picker (grouped, private first) and every reply. TEE verification is no longer inferred from headers. Per-response attestation verification moved to phase 12. | `nearAiClient.test.ts`, `chatBridge.test.ts`, `chatSendPath.test.ts` |
| FIX-04 | `NEAR AI: Remove Profile…` deletes metadata and the SecretStorage key after confirmation. | command wiring; `ProfileStore.remove` covered in `profileStore.test.ts` |
| FIX-05 | Sidebar shows planning-file links (PROJECT, ROADMAP, STATE, current phase) and next-step buttons after workflow runs; history via the title-bar picker. | rendered and inspected in headless Chromium |
| FIX-06 | Removed the NEAR account auth option, the onboarding staking button, the wallet panel; Tools tab hides team studio, attachments, generation, and memory until phase 11. | `chatBridge.test.ts` (Tools tab HTML) |
| FIX-07 | README and SECURITY.md rewritten to verified behavior, including that GSD runs use Codex's provider until phase 9. | review |
| FIX-08 | Release check requires `media/chat/{chat.js,chat.css,markdown.js}`. | `npm run verify:release` (81 entries, 13 required assets) |
| PRIV-02/03/05, COST-02 | One outbound guard for the sidebar and `@nearai`: emergency stop (persisted, status-bar indicator, aborts running chat and GSD), daily spend limit, TEE-only mode, privacy preflight with a single-use exact-message override. | `outboundGuard.test.ts`, `chatSendPath.test.ts` |
| TEST-02 | The team-studio source-text test was replaced by a behavior test; client tests now assert NEAR's documented contracts instead of invented headers and endpoints. | suite: 231 passing |

Not done in this phase, by design: GSD workflows still run through the Codex CLI and its provider (phases 8–9); `budgetRemainingUsd` in analytics and agent/cost fields in the status line (phase 9); per-response attestation verification (phase 12).
