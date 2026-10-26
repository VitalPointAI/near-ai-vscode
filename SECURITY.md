# Near AI for VSCode trust and security report

This report describes the security and privacy boundaries implemented in the
`0.1.0` release candidate and the evidence used for its release checks. It is a
repository-level report, not an independent audit, provider certification, or
guarantee about code or services outside this extension.

## Scope and status

The extension is a VS Code host plus webview application. The host controls
credentials, provider requests, policy decisions, durable operational records,
and wallet state. The webview is a presentation and interaction surface and is
not an authority for credentials, attribution, usage, cost, or wallet writes.

Status for this release candidate:

- Implemented controls and negative-path tests are passing in this checkout.
- The packaged VSIX is checked after every package operation by a fail-closed
  content verifier.
- No production runtime dependencies are declared.
- Wallet entitlement/staking writes are intentionally unavailable until an
  independently verified official configuration and callback contract exists.
- TEE status is provider-reported metadata; this extension does not independently
  attest hardware or make a universal TEE guarantee.
- The final GSD security audit closed a release-metadata regression by excluding
  both the mounted `.git` marker and the usable `.git-real` repository directory
  from the VSIX and by making the verifier reject either path if present.

## Permissions and outbound boundaries

The extension uses the following VS Code/host capabilities:

| Capability | Why it is used | Boundary |
| --- | --- | --- |
| SecretStorage | Store project/profile-scoped API and refresh credentials | Host-only; values are not placed in settings, prompts, activity, analytics, exports, or errors |
| Workspace settings/files | Read configuration and persist bounded profile/checkpoint state | Workspace-scoped paths; raw credentials are not written to project files |
| Webviews and commands | Render onboarding/chat/status and receive typed user actions | Allowlisted DTOs and strict message parsing |
| Network requests | Call the selected provider's models, pricing, chat, and usage endpoints | Configured provider boundary; privacy preflight and local-only policy apply |
| External links | Open the NEAR AI Cloud API-key portal when requested | User-visible `https://cloud.near.ai/` navigation |
| Child processes | Check/update Open-GSD and run the selected Codex workflow | Explicit argv, workspace cwd, and `shell: false` for the GSD runner |

The extension does not read, transmit, overwrite, archive, or delete
`~/.near-credentials`. The wallet seam is external-wallet-only and separate from
API-key profiles. No local signing key, seed phrase, or wallet credential file is
required by the shipped default.

## Data handling

Before a provider request, host-side privacy preflight classifies secret/private
file paths, personal data, unknown content, and scope expansion. Secret and
private-file findings block by default. Local-only mode blocks non-local provider
boundaries. A one-time override is bound to the exact provider, boundary, scope,
classification set, and short expiry; its audit record contains a redacted
preview rather than raw context.

Provider and activity records retain bounded operational facts: request/session
IDs, selected organization/profile and workspace-project attribution, phase,
agent, model, latency, token counts when available, estimated cost, actual cost
when reported, approval state, outcome, and provider verification status. The
extension keeps estimated and actual values separate and preserves unavailable
values as unavailable.

The host recomputes analytics and exports from bounded records. Persisted event
ownership is normalized from its owning session during reload, so a conflicting
event-shaped attribution cannot relabel history. Webviews cannot inject
authoritative cost or attribution values.

## Provider and TEE qualification

The default endpoint is the OpenAI-compatible NEAR AI Cloud API. The extension
can display a `verified`, `unverified`, or `unknown` provider signal when it is
returned in supported response metadata. That display is evidence of what the
provider returned to the extension, not an independent attestation. The code
does not claim that every model, endpoint, response, or user-selected provider
runs inside a TEE.

## Wallet and staking separation

The release contains typed, fail-closed entitlement and exact transaction
preview boundaries. It does not ship a concrete NEAR AI staking network, RPC,
validator, entitlement endpoint, transaction method, or callback value. Missing,
expired, or untrusted injected configuration produces an unavailable status and
keeps all stake-changing writes disabled before wallet authorization. A future
integration must supply verified official values, fresh exact-scope approval,
and an external wallet callback contract. This limitation is intentional and is
not represented as production staking support.

## Dependency provenance

`package.json` declares no runtime `dependencies`. The installed production tree
therefore resolves to:

```text
near-ai-vscode@0.1.0
└── (empty)
```

The development toolchain observed from `npm ls --depth=0 --all` in this
checkout is:

```text
@types/node@22.20.5
@types/vscode@1.140.0
@vscode/vsce@3.9.2
typescript@5.9.3
```

These are dev-only packages. `package-lock.json` is lockfile version 3 and pins
their registry resolutions and SHA-512 integrity values. The root entries
reviewed for this report are:

| Package | Resolved version | Registry resolution | Integrity |
| --- | --- | --- | --- |
| `@types/node` | 22.20.5 | `https://registry.npmjs.org/@types/node/-/node-22.20.5.tgz` | `sha512-U2+DNr+wSjpsTS/wZGYHq7GcwfuSmKiKvoPvK22zwTlRhU91yOniN4qRR5KhIjvif7ysw/dz/hKmfDH0Ris4aA==` |
| `@types/vscode` | 1.140.0 | `https://registry.npmjs.org/@types/vscode/-/vscode-1.140.0.tgz` | `sha512-KAB5RBZIgnUhpp4mKsVJPPHLOQKu6WtGy2xpfWjaajEXO4xIIC+UESAXLiQ9ewx6QD1uBmvC/S8BJzkbvv4bRA==` |
| `@vscode/vsce` | 3.9.2 | `https://registry.npmjs.org/@vscode/vsce/-/vsce-3.9.2.tgz` | `sha512-XSxMosEEDO6vLxELAHVkwmhC0qe0ijZni2jB9Rcs8kQsW4lhTDQ/wMzmwFs/buotAWSnpmUp/dRWD2ufG3UYKA==` |
| `typescript` | 5.9.3 | `https://registry.npmjs.org/typescript/-/typescript-5.9.3.tgz` | `sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==` |

No package was added for release verification or image generation. The two
Marketplace GIFs are generated from a checked-in, dependency-free Node script,
then the generator itself is excluded from the VSIX.

The clean `npm ci` install also reported two high-severity findings when npm
audited the complete development tree. The release gate intentionally audits
the shipped production tree with `npm audit --omit=dev --audit-level=high`,
which returned `found 0 vulnerabilities`; the reported development-only audit
result is not presented as a claim that the full toolchain is vulnerability
free.

## Backdoor-oriented source review

The review covered the extension host, provider, privacy, wallet, GSD runner,
and release files. The reproducible checks were:

```bash
grep -RInE 'eval\\(|new Function|vm\\.|shell:[[:space:]]*true' src scripts
grep -RInE 'exec\\(|execFile\\(|spawn\\(' src
grep -RInE 'near-credentials|readFile.*credential|writeFile.*credential|unlink.*credential' src
grep -RInE 'console\\.(log|error)|show(Error|Warning|Information)Message' src
npm ls --omit=dev --all
npm audit --omit=dev --audit-level=high
```

Observed results for this checkout:

- No `eval`, `new Function`, VM evaluation, or `shell: true` path was found.
- The expected child-process calls are limited to the Open-GSD updater and
  runner. The runner passes an argv array with `shell: false`; runtime output is
  bounded and redacted before it becomes an activity event.
- `near-credentials` appears only in privacy denylist/negative-test coverage;
  there is no wallet filesystem reader or credential-file mutation path.
- User-visible errors, activity, audit, analytics, exports, and wallet DTOs use
  redaction/allowlists. The negative tests reject API-key, refresh-token,
  bearer, seed/private-key, prompt/context, and unrestricted-path shaped values.
- The production dependency tree is empty. The audit command is still required
  as a release gate so a future runtime dependency cannot be introduced without
  evidence.

This review is source- and test-based; it does not prove the integrity of the
host operating system, VS Code, npm registry, configured provider, or future
changes after this report.

## Reproducible release evidence

Run from a clean checkout with the lockfile present:

```bash
npm ci
npm ls --omit=dev --all
npm audit --omit=dev --audit-level=high
npm run lint
npm test
npm run package
npm run verify:release
```

`verify:release` runs the package command and then inspects the resulting VSIX
with the local `unzip` tool. It requires the manifest, README, SECURITY report,
license, compiled extension entrypoint, every non-test `dist/**/*.js` runtime
module, and both Marketplace GIFs. It rejects `.codex`, `.agents`, `.planning`,
source, test, source-map, node_modules, package-lock, `.git`, `.git-real`, and
other development entries. A missing required asset or unexpected development
entry exits non-zero. The final release check for this checkout produced 66
archive entries, 58 runtime JavaScript files, and 7 required release assets,
with no forbidden entries.

The complete repository verification result for this release is recorded in the
phase execution summary at
`.planning/phases/05-verification-hardening-and-release/05-05-SUMMARY.md`.

## Known limitations and remediation status

| Limitation | Status | Remediation |
| --- | --- | --- |
| NEAR account token exchange is prepared in the UI but not configured | Open, explicit | Verify and implement the official provider exchange contract before enabling it |
| Official NEAR AI staking/wallet configuration and callback contract are unavailable | Open, fail-closed | Supply independently verified network, validator, endpoints, methods, and callback/status values; keep writes disabled until then |
| TEE evidence is provider-reported, not independently attested by the extension | Accepted limitation | Preserve `unknown`/`unverified` states and avoid universal TEE claims |
| Interactive VS Code host/wallet callback smoke verification is not available without the official callback contract | Open verification item | Run the manual flow after the official integration exists |
| The mounted `.git` marker cannot be replaced because it is busy | Environment limitation | A separate local `.git-real` repository is used for attributable commits; configure a remote and publish credentials before pushing |

Report issues through the project’s normal issue channel with reproduction steps
and redacted logs. Do not include API keys, wallet signing material, raw prompts,
or private workspace paths in a report.
