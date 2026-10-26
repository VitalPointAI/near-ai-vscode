# NEAR AI for VS Code

**Private AI coding that you can see, steer, and afford.**

Chat with models running in NEAR AI Cloud's confidential (TEE) inference, with
every model clearly labelled private or not. Plan whole projects with built-in
Open-GSD workflows. See the model, tokens, and cost of every answer, and decide
exactly what is allowed to leave your machine.

![NEAR AI chat beside the editor in VS Code](https://raw.githubusercontent.com/VitalPointAI/near-ai-vscode/main/docs/marketplace/near-ai-chat.png)

## Why developers choose NEAR AI

- **You know where your code goes.** NEAR AI runs some models inside attested
  trusted execution environments and forwards others to third parties. Every
  model in the picker, and every reply, says which. Private models come first,
  and the default (GLM 5.3) is one of them.
- **It feels like part of VS Code.** A compact chat in the secondary side bar
  uses your theme and fonts. Prefer the built-in Chat view? Type
  `@nearai` there instead.
- **You always know the cost.** Every response shows the model, token count,
  and cost: estimated up front, then the actual amount when NEAR AI reports it.
  The status line under the chat shows project progress, active agents, and
  estimated spend.
- **From idea to shipped, not just autocomplete.** Open-GSD turns a goal into
  requirements, phases, plans, and verified work, with agents doing the legwork
  and you making the calls.
- **You stay in control of what's sent.** Each message is checked before it
  leaves: likely secrets are held back, personal data asks first, TEE-only mode
  blocks forwarded models, a daily spend limit caps cost, and an emergency stop
  halts everything.

## Features

### Chat that fits in your editor

- Streaming answers with formatted code, plus **Copy** and **Insert at cursor**
  on every code block.
- Pick any model NEAR AI offers from the input box, with pricing shown.
- **New Chat**, **History**, **Tools**, and **Set Up** live in the view's title
  bar, just like other VS Code views.
- Keyboard-first, with screen-reader labels and reduced-motion support.

### Open-GSD workflows, one slash away

![Open-GSD command menu](https://raw.githubusercontent.com/VitalPointAI/near-ai-vscode/main/docs/marketplace/near-ai-commands.png)

Type `/` to run any of 16 workflows: start a project, onboard an existing
codebase, discuss, plan, and execute phases, verify work, review code, map the
codebase, and more. Runs appear as collapsible activity rows, and when a
workflow needs a decision, it asks you right in the chat.

![A planning workflow asking for a decision](https://raw.githubusercontent.com/VitalPointAI/near-ai-vscode/main/docs/marketplace/near-ai-workflow.png)

### Spend and activity

Open **NEAR AI Tools** from the title bar for analytics: sessions, models,
tokens, and spend by organization and project, exportable. Agent teams,
attachments, image generation, and context memory are being rebuilt on a native
NEAR agent runner and will appear there when they do real work.

### Respects your projects

The extension only acts in projects you set up with it. Opening a folder,
the sidebar, or a status view never adds files. Open-GSD is installed only
when you run a workflow and it's missing, and the extension never adds its own
copy of Open-GSD to a project that doesn't already have one.

## Get started in two minutes

1. Install **NEAR AI for VS Code** and open a project folder.
2. Run **NEAR AI: Set Up** from the Command Palette.
3. Create a NEAR AI Cloud API key at [cloud.near.ai](https://cloud.near.ai/),
   or paste the one you have, and give the project a name.
4. Open the **NEAR AI** view in the secondary side bar and start chatting, or
   type `/new-project` to plan something new.

## Security and privacy

- API keys live in VS Code's encrypted **SecretStorage**, scoped to each
  project. They are never written to settings, workspace files, logs, history,
  or exports.
- Keys are only sent over **HTTPS**. Plain HTTP is allowed only for a model
  runtime on your own machine (`localhost`).
- A **privacy check** runs on every chat message before it is sent. Likely
  credentials and private-file paths are held back (you can send a message once
  anyway), personal data asks first, and `tee-only` mode blocks models NEAR
  forwards to other providers.
- The chat view only receives display data; credentials and raw context stay
  in the extension host.
- The extension never reads `~/.near-credentials` or other local wallet files.

Read the full [security and trust report](SECURITY.md).

## Requirements

- VS Code 1.90 or newer.
- A NEAR AI Cloud API key.
- For Open-GSD workflows, for now: the Codex CLI (`codex`) on your PATH and
  npm access. These runs use Codex's own configured model provider, not NEAR AI,
  until the native NEAR runner replaces it (see [SECURITY.md](SECURITY.md)).

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `nearAi.defaultModel` | `z-ai/glm-5.3` | Model used for new chats. |
| `nearAi.actionPolicy` | `approve-risky` | How much agents may do without asking. |
| `nearAi.baseUrl` | NEAR AI Cloud | OpenAI-compatible endpoint (HTTPS, or HTTP on localhost). |
| `nearAi.privacyMode` | `standard` | `tee-only` blocks models NEAR forwards to other providers. |
| `nearAi.dailySpendLimitUsd` | `0` (none) | Stop sending requests once today's spend reaches this amount. |
| `nearAi.autoInstallGsd` | `true` | Install Open-GSD when a workflow needs it and keep it current in NEAR AI projects. |

## Good to know

- **Privacy labels come from NEAR's model catalog.** The extension does not
  yet verify NEAR's per-response attestation signatures itself.
- **No wallet, staking, or NEAR account sign-in yet.** They wait for a
  documented NEAR AI contract; sign-in uses API keys.

## Troubleshooting

- **Chat asks you to set up:** run **NEAR AI: Set Up**, then select and
  validate a profile for this project.
- **No models or costs shown:** check your API key and endpoint; prices appear
  when the provider publishes them.
- **A workflow won't start:** make sure `codex` is on your PATH and npm can
  reach the registry, then run any command, such as `/progress`, to install
  Open-GSD.
- **Endpoint rejected:** use an `https://` URL, or `http://localhost` for a
  local runtime.

## Build from source

```bash
npm ci
npm run check            # type check and tests
npm run verify:release   # package and verify the VSIX
```

Issues and contributions: [github.com/VitalPointAI/near-ai-vscode](https://github.com/VitalPointAI/near-ai-vscode).

## License

MIT. See [LICENSE](LICENSE).
