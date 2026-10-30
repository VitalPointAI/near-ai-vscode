# Phase 25 Context: Cybersecurity harness

**Captured:** 2026-10-30
**Source:** the owner's brief, given verbatim when the phase was added

## Owner's brief

> provide user with UI to select a target to do a full exploit scan to gain access or develop targeted exploits to pen test and audit targets. Must include disclaimer about using legally according to region. Should be a full featured defensive and offensive cyber security harness for NEAR AI abliterated models to use.

## What that means concretely

- **A target picker, not a chat prompt.** The user names what to test (workspace, URL/host/IP, CIDR, git repo, container), sees the resolved scope, and chooses Defensive, Offensive, or Full before anything leaves the machine.
- **Two jobs, one harness.** Defensive: audit, harden, map to CVE/CWE/OWASP. Offensive: fingerprint, find, exploit, verify access, prove, clean up. "Develop targeted exploits" means the model may write a PoC, not only pick a public one.
- **The disclaimer is a gate, not a footnote.** Plain language, names the region's law, records who accepted it and when, and blocks active/intrusive modes until accepted.
- **Built for raw-completion abliterated models.** No native tool calling to rely on, so the harness owns the protocol: strict JSON tool calls, parse repair, retries, compaction, and a visible failure when the model will not comply.
- **Full featured** — findings with evidence and reproduction commands, exports (Markdown, JSON, SARIF), run diffs, an append-only ledger, replay, stop control, and honest "could not determine" reporting.

## Decisions this phase leans on (already true in the codebase)

- `src/security/` already scans dependencies and runtimes (OSV.dev, endoflife.date) and writes a CycloneDX SBOM; the harness reuses it for the supply-chain part of a defensive scan rather than re-implementing it.
- Every agent tool call already passes `decidePermission` (`src/agent/permissions.ts`) and the capability policy (`src/domain/policy.ts`), and the emergency stop is global (`src/services/emergencyStop.ts`). Intrusive actions must ride these, not bypass them.
- Webview UI lives in `media/` with typed `postMessage` payloads in `src/services/chatBridge.ts`; a Cybersecurity view should follow that pattern in its own bridge types instead of adding strings to `chat.ts`.
- The extension is CommonJS compiled by `tsc` with no bundler, `src/domain` and `src/agent` avoid `vscode` imports, and tests run with `node --test` against `dist/test/*.test.js`.

## Open questions for the planner

1. Second loop or reuse `AgentRun`? The harness needs tighter control (rate limits, timeouts, engagement scope) than the chat loop gives; the answer decides how much of `src/agent/loop.ts` is shared.
2. Which host tools are assumed available versus detected-and-reported? Both, with the built-in Node probes guaranteeing a floor, and missing tools stated in the report.
3. Sandbox for offensive work across Linux, WSL, macOS, and Windows, and how cleanup is proven rather than claimed.
4. Where the ledger lives and how it is protected from an agent rewriting it (`.planning/security/<engagement>/` with an append-only file and a hash chain is the default).
5. Legal text per region: which regions ship in the first release, and how the public-sector and critical-infrastructure default-deny is decided without a network lookup.
6. Test targets: a seeded vulnerable local service (packaged, no network) and its patched twin, so criteria 2 and 3 are provable in CI.
