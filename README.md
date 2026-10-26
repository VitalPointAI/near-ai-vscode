# Near AI for VSCode

Near AI for VSCode brings a guided Open-GSD workflow into VS Code: connect a
scoped NEAR AI provider profile, understand what will be sent, keep risky
actions behind approval, and follow model, usage, cost, and verification facts
as work progresses.

This `0.1.1` public preview makes the host/provider boundary visible and
reviewable. Core chat, Open-GSD execution, team studio, multimodal intake,
privacy controls, cost telemetry, and context-graph workflows are implemented;
provider-specific capabilities called out below remain explicitly fail-closed.

![Chat and activity demo](https://raw.githubusercontent.com/VitalPointAI/near-ai-vscode/main/docs/marketplace/near-ai-overview.gif)

![Setup and privacy controls demo](https://raw.githubusercontent.com/VitalPointAI/near-ai-vscode/main/docs/marketplace/near-ai-setup.gif)

The animated screenshots above are hosted from this repository so they render
in the Marketplace listing. Additional screenshots can be added the same way:
commit PNG/JPG/GIF assets under `docs/marketplace/`, reference their public
`https://raw.githubusercontent.com/VitalPointAI/near-ai-vscode/main/...` URL in
this README, then publish a new extension version.

## What you get

- **A guided first-project path.** The setup panel explains the Open-GSD loop,
  connects a provider profile, and opens the chat workspace without requiring
  users to memorize GSD commands.
- **Open-GSD command discovery.** Choose project setup, progress, planning,
  execution, review, context, statistics, or update workflows from the
  Command Palette. The selected command runs through the host-controlled Codex
  boundary with a workspace-scoped working directory.
- **Operational visibility.** Chat and activity surfaces show bounded lifecycle
  facts such as phase, action, agent, model, approval, outcome, latency, token
  usage, estimated cost, actual provider cost when reported, and provider
  verification status when returned.
- **Explainable model and cost data.** Model and pricing information is read
  from the configured provider. Estimates are shown only when price data is
  available; unavailable values stay unavailable rather than being fabricated.
- **Guarded agent behavior.** Reads and planning are allowed by the default
  policy. Workspace writes, shell commands, network actions, and git mutations
  require approval unless the user deliberately changes the action policy.
  Emergency-stop and bounded budget/audit paths are host-owned.
- **Project-scoped profiles.** Organization/company metadata and credentials are
  selected explicitly for the current workspace. A profile must validate before
  it can dispatch provider requests.

## Privacy, sovereignty, and TEE boundaries

The extension host owns credentials, provider calls, policy evaluation, activity
records, and wallet state. Webviews receive typed, allowlisted display data; API
keys, refresh credentials, raw prompts, raw context, and unrestricted paths are
not sent to the webview by design.

- API keys and refresh credentials are stored in VS Code SecretStorage under
  project/profile-scoped records. They are not written to workspace settings,
  `.env` files, GSD artifacts, activity history, analytics, exports, or error
  messages.
- The extension does **not** read, transmit, overwrite, archive, or delete
  `~/.near-credentials`. Wallet state is a separate boundary and is not an API
  key profile.
- Privacy preflight classifies secrets, private files, personal data, unknown
  content, and scope expansion. Secret/private-file findings block by default.
  Local-only mode blocks non-local provider boundaries. A one-time override is
  exact-scope, time-limited, and recorded as a redacted decision.
- The provider endpoint receives only the request approved for that provider
  boundary. The configured default is the NEAR AI Cloud OpenAI-compatible API;
  users can configure another endpoint only through the supported settings and
  profile validation path.
- TEE status is displayed only when the provider returns a recognizable
  verification signal. The extension does not independently attest hardware,
  guarantee a universal TEE, or turn an unknown provider response into a
  verified claim.

Read [SECURITY.md](SECURITY.md) for the public trust report, evidence, known
limitations, and remediation status.

## Requirements and permissions

- VS Code `1.90` or newer.
- A NEAR AI Cloud API key for inference. A NEAR account or external wallet is a
  separate staking/entitlement connection and does not replace the API key.
- A workspace folder for project-scoped profiles and Open-GSD workflows.
- Network access to the configured provider when using cloud inference. The
  setup command may open `https://cloud.near.ai/` to create an API key.

The extension requests host capabilities for SecretStorage, workspace settings
and files, commands, webviews, external links, network requests to the selected
provider, and child processes for the Open-GSD updater/runner. The child-process
boundary uses explicit argv and no shell interpolation for GSD execution.

## Installation

The extension is installed once per code-server/VS Code profile and is then
available across every project opened by that profile. From this project,
run `npm run verify:release && npm run install:global`; on a separate
code-server host, run `code-server --install-extension
near-ai-vscode-<version>.vsix --force`. Reload the window after installation
and look for the `NEAR AI` tab beside the other panel tabs. The legacy
`@nearAi` Chat participant remains available in Local-harness builds as a
compatibility fallback.

### Marketplace

Install **Near AI for VSCode** from the VS Code Extensions view, then run
**Near AI: Set Up** from the Command Palette.

### Local VSIX

```bash
npm ci
npm run verify:release
```

Install the generated `near-ai-vscode-0.1.0.vsix` from **Extensions → Views and
More Actions → Install from VSIX...**. `verify:release` compiles the extension,
packages it, and fails closed if required runtime/listing assets are missing or
development artifacts enter the archive.

## First run

1. Open a workspace and run **Near AI: Set Up**.
2. Create or enter a NEAR AI Cloud API key. Give the project any name you want;
   the extension creates the constrained internal profile scope automatically.
3. Confirm that provider validation succeeds, then explicitly select the
   profile in Chat Setup.
4. Review the privacy preview and action policy before starting a GSD workflow.
5. Use **Open-GSD: Choose Command** or **Near AI: Open Chat** to continue.

The extension checks for the stable `@opengsd/gsd-core@latest` runtime at startup
and during long sessions. When `nearAi.autoInstallGsd` is enabled (the default),
it may use the documented `npx` package channel to install/update the runtime
and synchronize the current project. Disable that setting if runtime updates
must be managed outside VS Code.

## Wallet and staking limitation

Wallet entitlement and staking are intentionally fail-closed in this release.
The extension ships typed status and exact-preview boundaries, but no concrete
NEAR AI staking network, validator, entitlement endpoint, method, or wallet
callback configuration. Without independently verified injected configuration,
entitlement status is unavailable and stake-changing writes remain disabled.
The extension never falls back to local NEAR credential files. This is a safety
limitation, not a claim that production staking is enabled.

## Troubleshooting

- **No profile can dispatch:** open **Near AI: Set Up**, select the intended
  workspace profile, and validate it again. Stale or invalid profiles are
  blocked from dispatch.
- **The model list or cost is unavailable:** confirm the provider endpoint and
  credential, then retry. The extension keeps unknown pricing/usage unknown.
- **A risky action asks for approval:** this is the default `approve-risky`
  policy. Review the scope, provider boundary, redacted preview, and budget
  impact before approving.
- **Open-GSD is unavailable:** check `nearAi.autoInstallGsd`, your network and
  npm access, then run **Open-GSD: Show Progress** after the update check.
- **Wallet status is unavailable:** this is expected until a verified official
  staking configuration and callback contract are supplied; no wallet write is
  attempted.

## Development and verification

```bash
npm ci
npm run lint
npm test
npm run package
npm run verify:release
npm ls --omit=dev --all
npm audit --omit=dev --audit-level=high
```

Press `F5` in VS Code to launch an Extension Development Host. The release
content verifier is intentionally independent of the extension runtime and
checks the actual VSIX entry list after packaging.

## Current limitations and roadmap

The NEAR account token-exchange flow is prepared in the UI but is not enabled
until the official provider contract is verified. NEAR AI staking and credit
balance writes are also fail-closed until the official network, validator,
endpoint, and wallet callback contract are available. TEE state is
provider-reported rather than independently attested. Live extension-host,
screen-reader, focus, and reduced-motion review still needs to be performed in
VS Code; the automated runtime harness and accessibility contracts are covered
by the release tests.

Future work may add the verified token-exchange flow, official staking/
entitlement integration, more provider adapters, and richer human-operated
VS Code smoke coverage. These capabilities are not silently enabled.

## License

MIT. See [LICENSE](LICENSE).
