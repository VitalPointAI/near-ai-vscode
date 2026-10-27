# NEAR AI for VS Code: security and privacy

This report describes what the current code does with your code, keys, and
requests, and what it does not do yet. It is a repository-level report, not an
independent audit or a guarantee about NEAR AI Cloud, the models it serves, or
other software.

Last reviewed: 2026-10-26, against the code on `main`.

## Where your data goes

| What | Where it goes | Notes |
| --- | --- | --- |
| Chat messages (sidebar and `@nearai`) | The endpoint serving the model you picked: NEAR AI Cloud, or your local runtime | Each message passes the outbound check below first. |
| What the sidebar agent reads or runs | The same model, as tool results: file contents it reads, search results, and command output | Files under the workspace only. Reading a likely credential file (`.env`, private keys, SSH, AWS, or NEAR credential files) asks first. Pick a private or local model to keep this inside a TEE or on your machine. |
| Open-GSD workflows | The NEAR AI agent runner, on the model you picked; sub-agents use the model for their tier (`nearAi.agent.deepModel`, `standardModel`, `fastModel`) when your provider offers it | The same outbound check, approvals, revert, and cost tracking as any agent run. No Codex or Claude Code runtime is invoked. |
| Your API key | VS Code SecretStorage, one key per project and profile | Never written to settings, project files, logs, activity, analytics, exports, or error messages. |
| Saved conversations | VS Code's extension storage on this machine, one folder per project; never the project itself | Full transcripts, including file contents and command output the agent saw, so History can resume them. The 50 most recent per project are kept. Turn off with `nearAi.agent.saveTranscripts`. |
| Activity and cost records | `.planning/.near-ai/` in your project | Operational facts only (models, token counts, costs, outcomes); no prompts or replies. Add it to `.gitignore` if you do not want it committed. |
| Open-GSD installation | `npx @opengsd/gsd-core@<exact version> --claude --global` into the extension's own storage, never `~/.claude` | Installed the first time you run a workflow; in NEAR AI projects, checked for updates at startup and daily. A new version must pass a compatibility check before it replaces the installed one, and the previous version is kept. |

### Which models are private

NEAR AI runs some models inside an attested trusted execution environment
(TEE) and forwards others to third-party providers. The extension reads this
from NEAR's model catalog (`/v1/model/list`) and shows it in the model picker
and on every reply:

- **Private · runs in NEAR TEE**: NEAR reports attestation support and serves
  the model itself (for example GLM 5.3, Kimi K3, Qwen 3.x).
- **Not private · forwarded to …**: NEAR forwards the request to another
  provider, named in the label (for example `openrouter.ai` for DeepSeek V4.1
  Flash, `anthropic.com` for Claude models).

The extension does not yet verify NEAR's per-response attestation signatures
itself; the label reflects NEAR's catalog. Set `nearAi.privacyMode` to
`tee-only` to block every model NEAR forwards elsewhere.

## The outbound check

Every chat message passes one check before it leaves VS Code, in this order:

1. **Emergency stop.** `NEAR AI: Emergency Stop` blocks all requests and stops
   anything running until `NEAR AI: Resume`. The state survives reloads.
2. **Daily spend limit.** With `nearAi.dailySpendLimitUsd` set, requests stop
   once today's recorded spend reaches the limit.
3. **TEE-only mode.** Blocks models NEAR forwards to another provider.
4. **Privacy check on the new message.** What looks like a credential (API key,
   token, password, private key) or a private-file path is blocked; what looks
   like personal data asks for confirmation. A blocked message can be sent once
   with an explicit override that is bound to that exact message and expires
   after a minute.

Earlier turns of a conversation are not re-checked; each was checked when it
was sent. The check applies to chat only; it does not yet cover Open-GSD
workflows (see the table above).

## Costs

Estimates come from NEAR's published per-model prices and the token usage NEAR
streams back. The actual charge is read afterwards from NEAR's billing API
(`POST /v1/billing/costs`, keyed by the `inference-id` response header). When
NEAR has not recorded a charge yet, the cost stays marked as an estimate rather
than being shown as $0.

## Permissions the extension uses

| Capability | Used for |
| --- | --- |
| SecretStorage | Project-scoped API keys |
| Workspace files | The agent's Read, Write, Edit, Glob, and Grep tools, confined to the workspace (symlinks included); `.planning/.near-ai/` records; `.planning/HANDOFF.json` when you save a checkpoint. Snapshots for **Revert** are kept in VS Code's extension storage, outside the project. |
| Network | Your configured NEAR AI endpoint and, if you set one up, your local runtime. API keys are sent only over HTTPS; plain HTTP is accepted only for `localhost`. Each key goes only to its own endpoint. |
| Child processes | A bash session for the agent's commands (each shown for approval unless allow-listed, never if deny-listed), VS Code's bundled ripgrep for searches, and the Open-GSD installer (`npx`, plus `npm view` to check the latest version) |
| External links | Opening `https://cloud.near.ai/` to create a key, when you choose to |

The extension never reads, writes, moves, or deletes `~/.near-credentials`, and
has no wallet, staking, or NEAR account sign-in feature. Those wait for a
documented NEAR AI contract.

## Activation

The extension activates automatically only in workspaces that contain
`.planning/.near-ai/`, a folder created by your own actions in the extension.
Elsewhere it starts only when you open its view or run one of its commands, and
opening the view writes nothing to the project.

## Dependencies

`package.json` declares no runtime dependencies; the shipped extension contains
only its own compiled code and assets. Development tools (`typescript`,
`@types/node`, `@types/vscode`, `@vscode/vsce`) are pinned with integrity hashes
in `package-lock.json`. `npm audit --omit=dev --audit-level=high` reports 0
vulnerabilities for the shipped tree.

## Verify it yourself

```bash
npm ci
npm ls --omit=dev --all                    # (empty)
npm audit --omit=dev --audit-level=high
npm run check                              # type check and tests
npm run verify:release                     # package, then inspect the VSIX
grep -RInE 'eval\(|new Function|shell:[[:space:]]*true' src scripts
```

`verify:release` fails if the packaged VSIX is missing the manifest, README,
this report, the license, the compiled extension, the sidebar's scripts and
stylesheet, or the listing screenshots, or if it contains source, tests, source
maps, `node_modules`, `.planning`, `.codex`, `.agents`, or `.git`.

## Known limitations

| Limitation | Plan |
| --- | --- |
| Per-response TEE attestation is not verified by the extension | Verify NEAR attestation/signature endpoints, milestone 2 |
| Open-GSD's Claude Code hooks (statusline, context monitor) are not run | The runner provides its own context thresholds, compaction, and handoff instead |
| Open-GSD's `Workflow` tool and MCP servers (for example context7) are not available | Workflows that need them report the tool as unavailable and fall back to their other paths |
| Team studio, attachments, image generation, and context memory are hidden | Rebuilt on the native runner, milestone 2 phase 11 |
| **Revert** restores files changed by the agent's file tools, not changes made by shell commands it ran | Use git for command side effects; documented in the chat |
| Under `fully-autonomous`, the agent runs commands without asking | Only the deny list applies; intended for throwaway workspaces |

Report security issues through the repository's issue tracker with redacted
logs. Never include API keys, raw prompts, or private file contents.
