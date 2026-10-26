# Phase 1 Research

## Scope

Establish a minimal installable VS Code extension, a secure onboarding flow, and the provider/authentication boundary needed by later chat and Open-GSD phases.

## Findings

- The repository is currently empty apart from planning metadata; Phase 1 must create the extension scaffold and toolchain.
- VS Code extensions can use `ExtensionContext.secrets` for SecretStorage, commands for onboarding/setup, and a webview or Chat Participant surface for the future chat experience.
- NEAR AI Cloud documents an OpenAI-compatible API, model discovery, pricing, streaming completions, usage reporting, and verification APIs. The extension should isolate these behind a provider interface so the UI and Open-GSD bridge do not depend on raw HTTP details.
- API-key authentication is straightforward to protect with SecretStorage. NEAR sign-in needs a browser/callback flow and short-lived credential handling; Phase 1 should establish an interface and safe placeholder flow rather than claim that the exact exchange is complete before the endpoint contract is validated.
- The default action policy should be explicit and serializable: read/inspect/plan allowed; workspace writes, shell, network, and git mutations require approval.
- Open GSD's current stable package is `@opengsd/gsd-core`; its documented update flow checks the `latest` dist-tag, detects install scope, backs up user-added managed files, runs the installer, and supports the `latest`/`next` channel distinction. The extension should use the stable `latest` channel by default and retain the upstream migration/backup behavior.

## Decisions for planning

- Use TypeScript and the VS Code Extension API.
- Keep provider/auth code in an extension-owned service boundary and keep secrets out of workspace files and logs.
- Provide a deterministic setup command and a status view so later phases can consume configuration without duplicating onboarding logic.
- Package a development VSIX in CI/local scripts and test activation, command registration, secret storage, and policy defaults.

## Open questions deferred to later phases

- Exact NEAR account sign-in/token exchange protocol.
- Whether Open-GSD is invoked as a local CLI, library, or host process in the target installation.
- Exact per-request cost reconciliation and verification evidence UX.
