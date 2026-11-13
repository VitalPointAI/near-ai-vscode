# NEAR AI for VS Code: security and privacy

This report describes what the current code does with your code, keys, and
requests, and what it does not do yet. It is a repository-level report, not an
independent audit or a guarantee about NEAR AI Cloud, the models it serves, or
other software.

Last reviewed: 2026-11-13, against the code on `main` plus the project state and sync work for 0.4.20.

## Where your data goes

| What | Where it goes | Notes |
| --- | --- | --- |
| Chat messages (sidebar and `@nearai`) | The endpoint serving the model you picked: NEAR AI Cloud, or your local runtime | Each message passes the outbound check below first. |
| What the sidebar agent reads or runs | The same model, as tool results: file contents it reads, search results, and command output | Files under the workspace only. Reading a likely credential file (`.env`, private keys, SSH, AWS, or NEAR credential files) asks first. Pick a private or local model to keep this inside a TEE or on your machine. |
| Open-GSD workflows | The NEAR AI agent runner, on the model you picked; sub-agents use the model for their tier (`nearAi.agent.deepModel`, `standardModel`, `fastModel`) when your provider offers it | The same outbound check, approvals, revert, and cost tracking as any agent run. No Codex or Claude Code runtime is invoked. |
| Your API key | VS Code SecretStorage, one key per project and profile | Never written to settings, project files, logs, activity, analytics, exports, or error messages. |
| Saved conversations | The project's own state folder, `.near-ai/state/`, which the extension keeps out of git; with project sync on, also an encrypted copy on your git host (see Project state and sync) | Full transcripts, including file contents and command output the agent saw, so History can resume them in every editor, **encrypted with AES-256-GCM** under a per-project key. Every conversation is kept (the 5 most recent stay open, older ones are archived, none is deleted; `nearAi.history.liveConversations`). A single tool output over 2 MiB is stored shortened with a visible marker. Turn off with `nearAi.agent.saveTranscripts`. |
| Project state sync (only after **NEAR AI: Turn On Project Sync**) | A branch named `near-ai/state` of your project's own git remote, never `main`. NEAR AI writes only that branch and, when you choose to put your code online, your own current branch; no other branch is ever created or pushed | Only ciphertext, with opaque file names and a constant commit message and author. Your git host can see that sync is used, roughly how much is stored, and when you save. See Project state and sync. |
| Agent Activity | Memory only, while VS Code runs | Prompts, replies, and tool calls for the live page; time- and size-limited; secrets masked. Never written to disk unless you export it. |
| Your environment variables | Not passed to the agent's commands when they look like credentials (by name or value) | So `env` or a careless script cannot send them to the model. Pass specific ones with `nearAi.agent.shellEnvAllow`. Local MCP servers get only a minimal environment plus what you configure; the Open-GSD installer gets the environment without credential-like variables. |
| Web searches | Only after **NEAR AI: Set Up Web Search**: your SearXNG instance, Brave Search, or Tavily | The query text; Brave and Tavily also receive your API key, which links the searches to your account. A SearXNG instance you run keeps queries on your infrastructure. |
| Web pages the agent fetches | The page's site | A plain GET with the extension's user agent and no cookies, login, or referrer. Asks first under `approve-risky`. |
| Cybersecurity scans (**NEAR AI: Cybersecurity**) | The model you picked: step results, and response headers, bodies, and TLS certificate details from the target you nominated | Only the target you resolved to a scope is contacted. What comes back is treated as untrusted: fenced as data, invisible characters stripped, injection attempts flagged, and secrets redacted before it is stored or exported. Engagement records and evidence stay in VS Code's extension storage, never in the project. |
| MCP tool calls | Only servers you add and switch on for the project | The call's arguments, shown on the approval card; see MCP connections below. |
| Dependency checks | OSV.dev (package names and versions) and endoflife.date (runtime versions), after you agree once per project | No code, file contents, or project names. See Checking your project's dependencies. |
| Activity and cost records | `.planning/.near-ai/` in your project | Operational facts only (models, token counts, costs, outcomes); no prompts or replies. The code push leaves these records out by default and names them in its summary; only the shared project files (`team.md`, `project.json`, `verifiers.json`) go up with your code. Add the folder to `.gitignore` if you do not want it committed. |
| Open-GSD installation | `npx @opengsd/gsd-core@<exact version> --claude --global` into the extension's own storage, never `~/.claude` | Installed the first time you run a workflow; in NEAR AI projects, checked for updates at startup and daily, which contacts the npm registry (it sees your IP address and the package name). Turn both off with `nearAi.autoInstallGsd`. A new version must pass a compatibility check before it replaces the installed one, and the previous version is kept. |

The extension sends **no telemetry** and loads no remote content into its
pages (each has a content security policy that allows only its own scripts).

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

The label reflects NEAR's catalog. Set `nearAi.privacyMode` to `tee-only` to
block every model NEAR forwards elsewhere.

### Checking a response's signature

Answers from a private model have a **Verify signature** action. It follows
NEAR's reference verifier (`nearai/nearai-cloud-verifier`) and checks that:

1. NEAR's signature (`/v1/signature/{chat_id}`) covers SHA-256 hashes equal to
   the exact request this editor sent and the raw response it received. The
   extension keeps only these hashes, not the text.
2. The signature (EIP-191, secp256k1) recovers to NEAR's signing address.
3. A fresh attestation report (`/v1/attestation/report`, with a random nonce
   from the extension) contains a **genuine Intel TDX quote**. The quote is
   signed by its attestation key. The Quoting Enclave's report vouches for that
   key and is signed by the platform's PCK certificate. That certificate chains
   to Intel's SGX Root CA, which the extension pins by fingerprint.
4. The quote's `report_data` binds the signing address and the fresh nonce, and
   any GPU evidence echoes the nonce.

The result names which key signed. **NEAR AI's gateway key** (seen for
tool-calling responses) proves the exchange passed unaltered through NEAR's
attested gateway. It does not by itself prove which enclave ran the model,
since the model's TEE is attested separately in the same report. **The model's
key** is signed inside the model's own TEE.

What is **not** checked in the editor, and the result says so:

- the platform's TCB status and certificate revocation, which need Intel's
  collateral;
- which code the enclave runs (its measurements against NEAR's published
  build);
- NVIDIA's GPU attestation verdict.

For those, use [cloud.near.ai/verify](https://cloud.near.ai/verify) or NEAR's
verifier. Only the final answer of a run is offered for verification. Tool-call
turns are signed the same way but are not checked.

### What the agent can do without asking

Under the default `approve-risky` policy, reads and searches run freely, and
file changes and commands ask first. A command runs without asking only if it
matches `nearAi.agent.allowCommands` and is written as plain words. That rules
out quotes, `~`, variables, globs, newlines, pipes, redirects and substitution.
It must also use no absolute or `..` paths, and no git options that write files,
read outside the repository, or delete refs. These always ask, even after
**Allow edits for this run**:

- reading a file that looks like a credential, through any path or symlink;
- writing into `.git/`, where hooks and config would run on the next git
  command;
- writing into `.planning/.near-ai/`.

### Sub-agents nobody is watching

In the `auto` and `mostly-autonomous` policies, a sub-agent (an agent another
agent started) runs two more kinds of command without a card, because nobody
is usually there to answer one and runs used to wait hours on their own checks
(`nearAi.agent.unattendedAutoApprove`, on by default):

- a command the fixed safety rules call safe: reads, read-only git (`status`,
  `log`, `diff`, `show`), tests, lint, type checks, builds, and writes inside
  the sub-agent's own folder, which is its git worktree when it has one;
- a verification script run by `bash`, `sh`, `node` or `python3`, when the
  script resolves (symlinks followed) inside the project, is named like a check
  (verify, check, gate, lint, test, typecheck, validate, audit) or is named in
  the sub-agent's task, is under 256 KiB, and **no agent of the current run
  wrote or changed it** (or any file it loads). "Changed" is judged by the
  file's change time as well as its modified time, because an agent can set a
  modified time back but not a change time; a file with recent times still
  counts when its bytes equal its committed copy at the commit the project was
  on when the run started (as in a worktree checked out during the run). That
  last rule is the boundary:
  such a script is the project's own code, which the rules already trust the
  way they trust `npm test`. A script any agent writes or edits during the run
  asks, whatever its text says, because no reading of a script's text can be
  complete. The one exception is a verifier NEAR AI scaffolded whose text still
  matches the hash it recorded (below).

  On top of that, the script's text is screened for obvious mistakes: a network
  program or URL, starting another program or evaluating code, deleting or
  discarding files, publishing or pushing, a credential, an environment
  variable or home-directory path (`~/`, `$HOME`, `expanduser`, …), an absolute
  path outside the project, a `..` segment or another way to climb out, and
  shell lines the rules call risky. This screen is a safety net against
  accidents, not the security boundary, and it is not complete.

  Its arguments follow the same rules: an argument (or the value of a
  `--name=value` option) that has a `..` segment, is an absolute path, starts
  with `~`, expands a variable or a glob, or resolves outside the project
  (symbolic links followed) makes the command ask; so does any argument that is
  not plain text. A script another script runs is held to the same argument
  rules.

  These rules apply to the script's whole closure, not just the file named on
  the command line: every relative `import`, `export … from`, `require()` and
  `import()` in a JavaScript file, and every script a shell script runs, is
  resolved and checked the same way, recursively (at most 50 files). The only
  other things a script may load are the built-ins `node:fs`,
  `node:fs/promises`, `node:path`, `node:url`, `node:util` and `node:assert`
  (and, for Python, a short list of standard modules with no process or
  network access). Anything else asks: a load that does not resolve to a file
  inside the project, a non-relative package, an `import()` or `require()`
  whose argument is not one string literal, a Python relative import or
  `importlib`, an invocation a shell line makes that cannot be followed, and an
  import cycle. The verifier scripts NEAR AI scaffolds are also compared with
  the SHA-256 recorded in `.planning/.near-ai/verifiers.json` when they were
  written (a file agents cannot change without asking); a scaffolded file that
  differs in any way asks. You may edit a scaffolded verifier, but it asks until
  you run **NEAR AI: Trust Research Verifiers**, which lists the changed files
  and records their new hashes only after you confirm.

  "The current run" is one message's run with all its sub-agents. A script an
  agent wrote in an earlier run of the conversation, and that you have not
  looked at since, counts as the project's own in a later run; review what an
  earlier run wrote under `scripts/` before leaving a new run unattended.

Everything else asks exactly as before, including for sub-agents: a push, a
delete outside the project, publishing, any command that can reach the
network, and any credential path. The deny list, the emergency stop, the
outside-content holds and credential-path checks are applied first and are
never overridden. In `approve-risky` and the other modes, and in the main
conversation, nothing above runs without a card.

In every approval mode, `approve-risky` included, a sub-agent's approval card
waits `nearAi.agent.subagentApprovalWaitSeconds` (20 s by default). If nobody answers, the action does **not** run: the
sub-agent is told it is awaiting approval and carries on with other work, and
the card stays queued (until the run ends, or a day at most). Allowing it later
allows that exact command, or edits, for the rest of the run and tells the lead
agent; declining tells the lead not to run it. After
`nearAi.agent.approvalTimeoutsBeforePause` (3) unanswered approvals in a row,
every agent of the run pauses before its next model turn with a message;
answering an approval, Resume, a new message, or coming back to the window
carries on, and after a day with nobody back the run is stopped, its work kept. The main
conversation's own approvals still wait for you (`nearAi.agent.approvalTimeoutMinutes`).

### Plan checks the research profile skips

In a research or writing project (`nearAi.gsd.researchProfile`, on by
default), Open-GSD's plan checker is not run for a plan that changes content
only. A plan counts as content-only when every file its `files_modified`
list names, every file this run wrote, and every uncommitted change git
reports is a document, data or image file (`.md`, `.txt`, `.csv`, `.tsv`,
`.bib`, `.ris`, images, `.pdf`, `.docx`, `.xlsx`, `.pptx`, `.odt`) and none is
a gate, verifier, test or CI file, and its text names no gate or verifier
either. Any source, script or configuration file means the checker runs, and
so does a project without git. The checker's place in the workflow is then filled by a reply that
starts with `## VERIFICATION PASSED`, because Open-GSD continues only on that
marker or `## ISSUES FOUND` and otherwise stops to ask you. The next line
always reads "PLAN CHECK SKIPPED (content-only plan): the plan checker was NOT
run, so these plans were not verified", followed by the evidence. In this
case the marker means only "carry on"; nothing was checked. Set
`nearAi.gsd.researchProfile` to `false` to have every plan checked.

Search results leave out credential-looking files unless you search one
directly. WebFetch follows redirects itself, requires https at every hop, and
refuses hosts that resolve to loopback, private, link-local or metadata
addresses.

### Cybersecurity scans

A scan is the one feature that deliberately reaches private addresses, because
the target is usually your own machine or network. Its own rules different:

- **Only the resolved scope is contacted.** A step naming a host, URL or folder
  outside the scope the panel showed you is refused, and the refusal is recorded
  in the run's ledger. A folder is compared as a resolved path, so `..` cannot
  climb out of it.
- **Loopback is allowed only when named literally.** Typing `127.0.0.1` or
  `localhost` scans this machine; a *hostname* that resolves to loopback is
  refused, so a target cannot point the harness at your own machine by accident.
- **Intrusive steps need one grant.** Defensive scans run freely. Exploit and
  post-exploitation steps need the engagement's intrusive grant, given once for
  the run; after that each step is still scope-checked and denied rather than
  asked again if it strays. A step that would be risky also asks through the
  same approval card as chat, unless the grant covers it.
- **Payloads run in a sandbox, never on the host.** A container (`--rm`,
  `--network none`, target mounted read-only) or a temporary folder, chosen per
  engagement. A disabled sandbox refuses the step rather than falling back.
  Cleanup is verified against the runtime, and only read-only commands
  (`cat`, `ls`, `whoami`, `hostname`, `id`, `uname`) may follow a successful
  exploit.
- **Installs ask first.** A one-click host-tool install shows the exact
  command and waits for your confirmation before running a package manager.

Sub-agents, model tiers and image generation only use models on the same route
as the one you picked (local or cloud) that are at least as private. A run on a
TEE model never hands work to a forwarded model, and a local run stays local.
A team member with `privacy: private` in its team file goes further: it runs
only on a model in a NEAR TEE or on this machine, even when the chat's own
model is forwarded. The model must also be private on the run's own route:
a run on NEAR AI Cloud uses only TEE models, and only on NEAR's own endpoint,
where attestation can be checked (never a local catalog entry, and never a
different endpoint that claims TEE); a run on a local runtime uses only its
local models. If the run has no such model, or its route is unknown, that
member does not run and the lead is told why; its work is never sent to a
forwarded model instead. New
research teams set this on every member, and new presales teams on their
reviewer; `privacy: any` turns it off for a member.

### Document tools and team roles

CreatePdf and CreateDocument write a `.pdf` or `.docx` from Markdown on this
machine, with no library and no network: images must already be files in the
workspace (web addresses are refused), and the source and images are read only
from the workspace, with the same credential-file check as Read. They are
ordinary workspace writes, so they ask first under `approve-risky`, writes into
`.git/` or `.planning/.near-ai/` always ask, and **Revert** removes the file.
The research team's editor now has Write and Edit (for copy edits to the
report) and the research red team has Bash (to try deliberate breakages of the
project's checks in a scratch copy). Neither gets anything that runs without
asking: their edits and commands go through the same approval policy as every
other agent's. That policy is the only limit: nothing confines the red team's
writes to `.planning/`, and Bash can reach anywhere the policy allows.

**Update Team** rewrites a team file (and, for a project, the extension's own
block in `AGENTS.md`) only from the **NEAR AI: Update Team…** command or the
Team Studio button, after a preview and a confirmation, never while a run is in
progress, and never from an agent. It copies the file into the team's version
history first and offers **Undo**.
API keys are bound to the endpoint they were saved for, in SecretStorage, so
editing the project's profile file cannot redirect a key.

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

## Project state and sync

Since 0.4.20 the extension keeps a project's chats, runs, checkpoints, comparisons, model choices,
spend history and resume pointer in one git-ignored folder inside the project, `.near-ai/state/`,
so every editor on the same computer shows the same project. Optional sync copies that folder,
encrypted, to a branch of the project's own git remote so another computer can open it.

### Encryption model

- **Keys.** Each project has a random 256-bit data key. It is kept in the editor's secret storage,
  in a private key file inside the state folder (`keys/local.key`, mode 0600, never added to a
  bundle, log or push; `nearAi.sync.keepKeyInProject` turns the file off), and, once sync is on,
  wrapped by a key derived from the recovery code. Nothing else holds it.
- **Recovery code.** It is generated, never chosen: 256 random bits, shown as 52 characters in 13
  groups of 4, once, and never stored, logged or sent. Typing is forgiving (case, spaces and look-alike
  characters), but a code that is not exactly what was generated is refused. The key that wraps the
  data key comes from scrypt (N = 2^17, r = 8, p = 1, 16-byte random salt, 32-byte key). Costs read
  from a remote are bounded before any scrypt call, so a hostile manifest cannot ask for more than
  256 MiB of memory.
- **Objects.** State is compressed (brotli), padded, and sealed with AES-256-GCM (96-bit random IV,
  128-bit tag). Each object gets its own HKDF-SHA256 subkey from a random 16-byte salt, and its
  authenticated additional data binds the project's state id, the object class and its part number
  and count, so an object cannot be swapped between projects, classes or positions. Padding uses
  buckets of about 12.5% above a 64 KiB floor, and large payloads are split into parts of at most
  8 MiB.
- **Manifest.** The list of objects is sealed too, with a counter that never goes backwards, so an
  older copy of the state, a missing object or a truncated or altered one is refused and changes
  nothing on this computer. Every refusal is one plain sentence with no partial plaintext.
- **The NEAR AI key.** An encrypted copy of the project's key and endpoint sits in the state folder,
  sealed under its own HKDF subkey of the data key, so a second editor on the same computer needs no
  set-up. It is opened only in memory inside the editor, then stored in that editor's secret storage.
  It is never written in plain form to disk, logs, a webview, a model request or a bundle. It
  travels to another computer only inside the encrypted bundle.
- **No escrow.** NEAR AI, the extension's authors, your git host and anyone with read access to the
  repository cannot decrypt the state, and nobody can recover a lost recovery code. A computer
  that is still unlocked can show a new one.
- **Anonymous commits.** Sync writes its commits with git plumbing into a private mirror, with the
  author and committer `near-ai-state <state@near-ai.invalid>`, a constant date and the message
  "Update encrypted project state". Your git identity and configuration are never read or changed,
  and hooks, signing, helper transports and the inherited git environment are switched off for those
  calls. A credential for the remote reaches git only through the child process's environment and is
  never written to a config file or passed as an argument.
- **Automatic syncs never prompt.** A background sync looks up an existing GitHub sign-in silently;
  if there is none it stops with "Sync needs you to sign in. Choose Sync Project Now.".

### Post-quantum reasoning

The sync format uses only symmetric cryptography: AES-256-GCM, HKDF-SHA256 and scrypt over a
generated code. It has no public-key step, so an attacker who stores the ciphertext today and
waits for a quantum computer gains at most Grover's square-root speed-up (AES-256 keeps about
128-bit strength). The recovery code is 256 bits for the same reason: it keeps about 128-bit
strength against Grover before counting scrypt's cost.

**Constraint for later work.** Any public-key step added to sync, such as sharing state between
different people in Team Mode, must use a hybrid key exchange (X25519 plus ML-KEM), so that it does
not bring back the harvest-now-decrypt-later weakness the symmetric design avoids.

### What still leaks

| Leak | Who sees it | Limit |
| --- | --- | --- |
| That the project uses NEAR AI sync (the branch name and the manifest's shape) | Anyone who can read the repository | Accepted; they carry no project data |
| Total size, to within about 12.5% | Same | Padding; objects over 8 MiB are split |
| Number of objects | Same | Objects are consolidated so the count follows size, not the number of chats |
| Push times and number of commits | Same, and your git host in any case | The commit date is constant, but the host sees the push. Pushes are batched and spaced apart, so the timing shows activity rather than single chats |
| That you pushed from some account or address | Your git host | Not something the extension can control |

On a public repository the ciphertext is public too. The recovery code's 256 bits make a search
against it infeasible. Your project's own code is visible to everyone only if you choose to push it
to a public repository (see below).

### Residual risks

- **A new recovery code does not revoke the old one.** Copies already on the git host stay in git
  history and still open with the old code. A new code only protects what is pushed afterwards;
  treat a leaked code as a leak of everything pushed before it.
- **Chats at rest in the project folder** are protected by file permissions on that computer
  (the key file is mode 0600), not by a password. Anyone who can read your files can read your
  chats. They are end-to-end encrypted everywhere they leave the computer. With
  `nearAi.sync.keepKeyInProject` off, a new editor or browser needs the recovery code or that
  device's secret storage.
- **Size limits.** A warning appears from 500 MB; from 1 GiB, older archived chats stay on this
  computer only (nothing is deleted) until there is room.
- **History shows the lead agent's steps** and each sub-agent's report; sub-agent steps become
  linked threads in a later release. The daily spend limit still counts the spend of the editor
  it runs in.

### Giving a project an online home and pushing your code

Creating a repository, adding the remote and pushing your own code are separate steps, each behind
its own click, and public or private is asked every time with no default. Sign-in uses VS Code's
GitHub authentication, then the `gh` tool, then a pasted address of an empty repository that must
not contain a password or token; the extension never asks for a token, and a GitHub token is held
only in memory. Before your own code is pushed, the extension lists the files and blocks likely
secrets (`.env` files, private keys, credential files, and secret-looking contents). It scans the
earlier commits that would be published as well: a secret committed once and deleted later still
blocks the push, naming the file and the short commit id and never the value. For a public
repository, a history that could not be checked completely is not pushed at all. NEAR AI does not
rewrite your history; that stays your decision.

The code push is also available later, as **NEAR AI: Put This Project's Code Online**, and running
**Give This Project an Online Home** again offers it; both go through exactly the same checks and
the same click on the summary. NEAR AI writes only the `near-ai/state` branch and, on your choice,
your own current branch, and never forces a push. The only setting of your repository it ever
changes is the default branch: GitHub makes the first branch pushed the default, so while
`near-ai/state` is the only branch it is shown first. After your code is online, NEAR AI makes
your branch the default branch through the GitHub API with your token, once, and only when the
default is still `near-ai/state`; a default branch you chose is never changed. For a repository an
earlier version set up, the same change is made only after you click to confirm it. On a pasted
address no request is sent to GitHub and the text names the setting for you to change. NEAR AI's
own account and run records in `.planning/.near-ai/` stay on this computer by default; the control
in the chat bar shows a sync problem as a plain sentence under it and never includes a token or
a password.

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

`package.json` declares no runtime dependencies. The third-party code the
extension runs is vendored into `vendor/` at build time from pinned
devDependencies by `scripts/vendor-libs.mjs`, each with its license, and listed
in `vendor/manifest.json` from esbuild's record of what it bundled:

| Package | Version | License | Used for |
| --- | --- | --- | --- |
| pdf.js (`pdfjs-dist`) | 6.4.299 | Apache-2.0 | Text of attached PDFs |
| resvg (`@resvg/resvg-wasm`) | 2.6.2 | MPL-2.0 | Rendering SVG; decoding images for tracing |
| imagetracer.js | 1.2.6 | Unlicense | Tracing images into SVG |
| pptxgenjs (with jszip and 12 small helpers) | 4.0.1 | MIT | Writing .pptx decks |
| DejaVu Sans | 2.37.3 | Bitstream Vera | Text in rendered SVG |

Every release carries `sbom.cdx.json` (CycloneDX 1.6) for those components.
`npm run sbom` builds it and checks each one on OSV.dev; the release fails on a
high or critical finding in shipped code. Build-only tools are not shipped;
`@azure/msal-node` 6.0.1 (CVE-2026-109461, pulled in by `@vscode/vsce` through
`@azure/identity`, which does not yet accept the fixed 7.x) is a known
build-time exception: the affected authorization-code flow is not used.

## Outside content and prompt injection

Web pages (WebFetch), search results (WebSearch), attached files, and MCP results
can contain text written to steer an agent. They pass through layered defenses;
no single one is relied on:

1. **Hidden content is removed.** HTML elements hidden by `hidden`,
   `aria-hidden`, or inline styles (display, visibility, zero opacity or size,
   off-screen), comments, templates, scripts, and styles; zero-width, Unicode
   tag, and bidi-control characters; hidden Word text, hidden slides, and
   hidden sheets and rows. What was removed is noted.
2. **Likely injections are flagged** in visible text as well: instructions to
   ignore earlier instructions, role changes, chat or tool-call markup, requests
   to run commands, download-and-run commands, requests to send secrets, and
   requests to hide something from the user. The flag is shown to the model and
   recorded in Agent Activity with where it came from. Detection is pattern
   based and can miss new phrasing, which is why the next layers exist.
3. **Everything is fenced** in `<untrusted-content>` blocks with a random id the
   content cannot forge, and the system prompt says text inside is information,
   never instructions.
4. **The run is marked tainted** once it reads outside content. From then on,
   shell commands that can send data off the machine (curl, wget, nc, ssh, …),
   fetches of URLs that could carry data (long query strings, encoded path
   segments), and research agents' writes outside `.planning/` ask for approval
   **even in fully-autonomous mode**, and an earlier "allow for this run" does
   not cover them. A declined action is reported as blocked.
5. **Citations are checked.** CheckCitations confirms each quoted passage
   appears in the page actually fetched, so a report cannot rest on text a
   source never contained. CheckOriginality compares a draft with the same
   fetched pages for copied runs, misquotations, and close paraphrase; it reads
   only the workspace draft and pages already fetched, and sends nothing out.

Agent Activity counts, per agent, injections flagged, hidden content removed,
and actions held and blocked, with an entry for each showing the source.

Web search sends queries to the provider you choose with **NEAR AI: Set Up Web
Search**: a SearXNG instance you run (queries stay on your infrastructure),
Brave Search, or Tavily (keys in SecretStorage). It is off until you choose.

## MCP connections

- **Storage:** server names, commands, and approval settings in your user
  storage; URLs, header values, and environment values in SecretStorage (a URL
  can carry an access token, so it is never shown, only its host); which
  servers a project uses in that workspace's state, never in the repository.
- **What is sent:** a tool call's arguments go to that server, and the
  approval card shows them before anything is sent; the server's results go
  to your chosen model. Nothing else (no files, no other context) is sent to a
  server.
- **Approval:** per server, *ask before changes* (default: tools the server
  marks read-only follow your normal rules; every other tool asks in every
  mode, including fully-autonomous), *ask before every call*, or *trusted*.
  Tools can be switched off one by one.
- **Local servers** run only after you confirm the exact command, with a
  minimal environment (PATH, HOME, and the like) plus the variables you set,
  never the editor's own environment.
- **Results** are outside content: fenced, scanned for injection attempts, and
  shown in Agent Activity.
- **Not yet supported:** servers that require an interactive OAuth sign-in.
  Servers authenticated by a token in the URL or a header work.

## Checking your project's dependencies

**NEAR AI: Scan Dependencies for Vulnerabilities** (and, once you agree, every
time a NEAR AI project opens or a lockfile changes) writes `sbom.cdx.json` for
the project and checks it:

- **What is sent, and to whom:** the names and versions of dependencies from
  lockfiles to [OSV.dev](https://osv.dev) (Google's open vulnerability
  database), and the runtime versions the project declares or that are
  installed (Node.js, Python, PHP, Go, Ruby, Rust, .NET) to
  [endoflife.date](https://endoflife.date). No code, file contents, or project
  names are sent.
- **Consent:** asked once per project before anything is sent;
  `nearAi.security.scanOnOpen` (`ask`, `always`, `never`) controls automatic
  checks.
- **Results:** Problems entries on the lockfile line of each affected package
  (linking to the advisory), a status-bar shield, the **NEAR AI Security**
  output, and the SBOM's `vulnerabilities` with ratings, CVE aliases, and
  fixed versions. If a service can't be reached, the SBOM says the check was
  incomplete rather than clean.
- **Agents** run the `SecurityScan` tool after changing dependencies and are
  told to fix high and critical findings or say why they remain, and never to
  claim no known vulnerabilities without a fresh scan.
- **CI:** **NEAR AI: Add Dependency Scan Workflow** writes a GitHub Actions
  workflow running OSV-Scanner (pinned by commit) on pushes, pull requests,
  and weekly.

## Verify it yourself

```bash
npm ci
npm ls --omit=dev --all                    # (empty)
npm audit --omit=dev --audit-level=high
npm run check                              # type check and tests
npm run test:e2e                           # real VS Code (needs xvfb-run on Linux)
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
| Verify signature does not check TCB status or revocation, enclave measurements, or NVIDIA's verdict | Use cloud.near.ai/verify or NEAR's verifier for a full check |
| Open-GSD's Claude Code hooks (statusline, context monitor) are not run | The runner provides its own context thresholds, compaction, and handoff instead |
| Open-GSD's `Workflow` tool and MCP servers (for example context7) are not available | Workflows that need them report the tool as unavailable and fall back to their other paths |
| Scanned PDFs (no text layer), old binary Office files (.doc, .ppt, .xls), and video can't be attached; video can't be generated | The chat says so when a file can't be read; export with OCR or re-save in the current format |
| Attached PDFs and Office files are parsed on this machine (PDFs by Mozilla's pdf.js, vendored, with script evaluation and font loading off; Office files by the extension's own reader, capped at 50 MB unpacked) | Only the extracted text is sent, and it passes the same privacy and spend checks as typed text |
| Attached images and audio are sent to the profile's provider (NEAR AI or your local runtime) to be read or transcribed, possibly by a different model than the one you chose | The chat names the model used for each file; TEE-only mode blocks the turn if that model is not TEE-attested |
| Project sync cannot revoke a recovery code: a new code protects only what is pushed afterwards | Treat a leaked code as exposing everything pushed before it; see Project state and sync |
| The daily spend limit counts the spend of the editor it runs in, not every editor on the computer | Project spend history is shown in every editor; a combined limit is planned |
| The history keeps the lead agent's steps and each sub-agent's report; a sub-agent's own steps are not yet separate threads | Linked sub-agent threads are planned |
| Memory has a searchable list, not a graph view; teams have no shared team memory | Members get project memory and their own private memory |
| Agent reputation is recorded per role but does not yet change which model a role uses | Routing comes from team `model:` lines and the deep/standard/fast settings |
| **Revert** restores files changed by the agent's file tools, not changes made by shell commands it ran | Use git for command side effects; documented in the chat |
| Under `fully-autonomous`, the agent runs commands and writes protected files without asking | Only the deny list applies, and it is a substring backstop, not a sandbox. Intended for throwaway workspaces |
| Facts the agent saves with Remember are not reviewed when saved, and later runs start with the relevant ones | Each fact is labeled "verify before relying on it"; review, correct or reset memory with **Manage Project Memory** |
| Spend limits use NEAR's published prices for estimates; the actual charge arrives from billing after the run | Each run, with all its sub-agents, stops before a model turn once its estimate reaches `nearAi.agent.maxRunCostUsd` (default $5), what is left of `nearAi.dailySpendLimitUsd`, or `nearAi.agent.maxRunTokens`; an agent repeating the same action is nudged and then stopped |

## How changes reach a release

The development process requires every change to reach `main` through a pull request. Before a
pull request merges, CI type checks it, runs the unit tests and the end-to-end tests in a real
VS Code, packages and inspects the VSIX, runs `npm audit` on runtime dependencies, and scans the
files and every commit for secrets, and a security and code review must pass. Releases are
built by GitHub Actions from a tagged commit on `main` (or, for an urgent fix to an older
release, the reviewed head of its hotfix branch) and attached to a GitHub release with a SHA-256
checksum. Publishing to the Marketplace waits for an approval in GitHub, which is the owner's
decision. Every GitHub Action is pinned to a full commit hash.

The checksum shows that the VSIX published is the one the build job made; it does not protect
the build itself. The build job installs dependencies with their install scripts and runs the
tests, so a compromised dependency could change the VSIX before its checksum is taken.

AI agents do much of this work, and they act through the owner's GitHub account, which is a
repository and organization admin. The Marketplace approval and the repository settings are
therefore kept by policy: the agents are instructed never to take those steps, the scripts they
use never do, and the approval is given by the owner in person.

The review result is not taken from the owner's account. It comes from a separate reviewer
identity, `near-ai-reviewer`, through `.github/workflows/agent-review.yml`:

- **Who reviews.** After CI passes on a pull request, the workflow, run from `main` (never the
  pull request's own copy), sends the pull request to a review model and posts the result as the
  `agent-review` status and a review comment, as `near-ai-reviewer`. The merge and release gates
  trust `agent-review` only from that account, and the review script refuses to post as any
  other, so an agent running as the owner cannot certify its own work.
- **Where the token lives.** `near-ai-reviewer`'s token and the review model's key are secrets of
  the `agent-review` environment, which deploys only from protected branches. No machine that
  authors code holds them. This is a repository setting: a repository admin could still change
  the environment's branch policy, so it protects against mistakes and against a PR, not against
  an admin account acting on purpose. `can_admins_bypass: false` only stops an admin skipping a
  required reviewer.
- **What leaves the repository.** For each pull request, its title, description, branch name,
  CI results, list of changed files and diff (capped in size) are sent to the review model's
  endpoint: NEAR AI Cloud (`https://cloud-api.near.ai/v1`) unless the `REVIEW_MODEL_BASE_URL`
  variable names another; the key is sent only over https. For this public repository that
  content is already public.
- **What a model verdict is worth.** The verdict is a model's judgement, and the pull request's
  own content can try to influence it. The prompt marks everything the author wrote as untrusted
  data, and the gate fails mechanically on an open BLOCKER, a missing or second verdict, a verdict
  for another commit, or a PASS that does not recommend merging. It cannot catch a model that is
  simply persuaded; that is why changes to the gates need the owner.
- **What it approves on its own.** When the review passes, `near-ai-reviewer` approves the pull
  request, pinned to the reviewed commit, which satisfies the one approval branch protection
  requires. A pull request that changes the gates (the workflows, the review, merge and release
  scripts, `SECURITY.md`, the agent commands) or whose diff was too large to review whole is not
  approved automatically: the approval waits for the owner to approve the run in the
  `agent-review-gates` environment, whose only reviewer is the owner and which holds no secrets.

GitHub enforces these rules through repository settings (branch protection on `main`, a ruleset
that keeps release tags from being moved or deleted, and the protected `marketplace`,
`agent-review` and `agent-review-gates` environments).
They are listed, with the commands that apply them, in
[docs/development-workflow.md](https://github.com/VitalPointAI/near-ai-vscode/blob/main/docs/development-workflow.md)
(section 8), which also describes the whole process. A rule is in force only once its setting is
applied.

## Reporting a vulnerability

Report vulnerabilities privately through GitHub's private vulnerability reporting: on the
repository's **Security** tab, choose **Report a vulnerability**
([direct link](https://github.com/VitalPointAI/near-ai-vscode/security/advisories/new)). Only the
maintainers see the report. Please do not describe a vulnerability in a public issue.

If that page does not offer **Report a vulnerability**, open an
[issue](https://github.com/VitalPointAI/near-ai-vscode/issues) that only asks the maintainers for
a private way to send a security report, with no details of the problem, and they will reply
there. Other security issues, such as a hardening idea, can go to the issue tracker with redacted
logs. Never include API keys, raw prompts, or private file contents.
