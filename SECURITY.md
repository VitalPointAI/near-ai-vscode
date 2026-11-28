# Sterling Sovereign AI: security and privacy

This report describes what the current code does with your code, keys, and
requests, and what it does not do yet. It is a repository-level report, not an
independent audit or a guarantee about NEAR AI Cloud, the models it serves, or
other software.

Last reviewed: 2026-11-15, against the code on `main` plus the messaging relay foundation in `relay/`.

## Where your data goes

| What | Where it goes | Notes |
| --- | --- | --- |
| Chat messages (sidebar and `@nearai`) | The endpoint serving the model you picked: NEAR AI Cloud, or your local runtime | Each message passes the outbound check below first. |
| What the sidebar agent reads or runs | The same model, as tool results: file contents it reads, search results, and command output | Files under the workspace only. Reading a likely credential file (`.env`, private keys, SSH, AWS, or NEAR credential files) asks first, in every mode except `fully-autonomous`. The project's key folder (`.near-ai/state/keys/`) is refused (see "What the agent can do without asking"). Pick a private or local model to keep this inside a TEE or on your machine. |
| Open-GSD workflows | The SovAI agent runner, on the model you picked; sub-agents use the model for their tier (`nearAi.agent.deepModel`, `standardModel`, `fastModel`) when your provider offers it | The same outbound check, approvals, revert, and cost tracking as any agent run. No Codex or Claude Code runtime is invoked. |
| Your API key | VS Code SecretStorage, one key per project and profile | Never written to settings, project files, logs, activity, analytics, exports, or error messages. |
| Saved conversations | The project's own state folder, `.near-ai/state/`, which the extension keeps out of git; with project sync on, also an encrypted copy on your git host (see Project state and sync) | Full transcripts, including file contents and command output the agent saw, so History can resume them in every editor, **encrypted with AES-256-GCM** under a per-project key. Every conversation is kept (the 5 most recent stay open, older ones are archived, none is deleted; `nearAi.history.liveConversations`). A single tool output over 2 MiB is stored shortened with a visible marker. Turn off with `nearAi.agent.saveTranscripts`. |
| Project state sync (only after **SovAI: Turn On Project Sync**) | A branch named `near-ai/state` of your project's own git remote, never `main`. SovAI writes only that branch and, when you choose to put your code online, your own current branch; no other branch is ever created or pushed | Only ciphertext, with opaque file names and a constant commit message and author. Your git host can see that sync is used, roughly how much is stored, and when you save. See Project state and sync. |
| Agent Activity | Memory only, while VS Code runs | Prompts, replies, and tool calls for the live page; time- and size-limited; secrets masked. Never written to disk unless you export it. |
| Team Live (**Watch the team**) | Memory only, while VS Code runs; read from Agent Activity's live data, or after a reload from the activity records below | The page gets each agent's name, state, model and privacy boundary, the tool it is running (the name only), counts and cost, and its task label: the short description the lead gave it, with secrets and private keys removed, cut to 80 characters. Never a prompt, a tool's input or output, or reply text, except the last 280 characters of the latest reply of the one agent whose card you have open, with secrets removed. A member's card shows its purpose and abilities from the team file, as Team Studio does. |
| Your environment variables | Not passed to the agent's commands when they look like credentials (by name or value) | So `env` or a careless script cannot send them to the model. Pass specific ones with `nearAi.agent.shellEnvAllow`. Local MCP servers get only a minimal environment plus what you configure; the Open-GSD installer gets the environment without credential-like variables. |
| Web searches | Only after **SovAI: Set Up Web Search**: your SearXNG instance, Brave Search, or Tavily | The query text; Brave and Tavily also receive your API key, which links the searches to your account. A SearXNG instance you run keeps queries on your infrastructure. |
| Web pages the agent fetches | The page's site | A plain GET with the extension's user agent and no cookies, login, or referrer. Asks first under `approve-risky`. |
| Cybersecurity scans (**SovAI: Cybersecurity**) | The model you picked: step results, and response headers, bodies, and TLS certificate details from the target you nominated | Only the target you resolved to a scope is contacted. What comes back is treated as untrusted: fenced as data, invisible characters stripped, injection attempts flagged, and secrets redacted before it is stored or exported. Engagement records and evidence stay in VS Code's extension storage, never in the project. |
| MCP tool calls | Only servers you add and switch on for the project | The call's arguments, shown on the approval card; see MCP connections below. |
| Dependency checks | OSV.dev (package names and versions) and endoflife.date (runtime versions), after you agree once per project | No code, file contents, or project names. See Checking your project's dependencies. |
| A team's knowledge graph | One file per team on this computer, `~/.near-ai-teams/knowledge/<team>.json` (or `knowledge/` under `NEAR_AI_TEAMS_DIR`), never in the project and never synced | What the team's agents add with the Learn tool during runs with that team: actors, what they do, how they relate, and facts with their sources and Admiralty grades. Every member reads it with TeamKnowledge, and its contents go to the model as tool results. A team from your library has one graph for every project it works in; a project's own team (`team.md`) has a graph for that project only. Agents' grades are capped at C3, because a run that read a hostile page could be steered into claiming anything. Team Studio shows it. |
| A staff team's J2 registers (the intel workbench, `mcp:intel-workbench`) | `.planning/staff/products/j2/source-register.json`, `pir-register.json` and `collection-plan.json` in your project, so they go wherever the project's files go | What the J2 members record: source items with their two grades, origin and deception note; PIRs with their decision points, latest times of value, indicators and any person's decision; and collection recommendations. The tools run inside the extension, reach no network, and declare only these files and `.planning/.near-ai/project.json`, so the gate's label checks apply to them. Entries above org/Internal, NATO Unclassified or Protected A are refused: staff templates hold exercise and fictional data only, and labels are not accreditation. A PIR counts as approved or rejected only when a signed entry in `.planning/staff/ledger/decisions.jsonl` records it: one made by **SovAI: Staff: Decide a PIR**, signed with the deciding person's device key, on that exact wording. A decision written into the register by hand or by a member, naming anyone, reads as awaiting a decision. Only members whose tools line grants `mcp:intel-workbench` can call these tools; the run's lead cannot. |
| A staff team's standing watches (`mcp__observations__watch_*` and the **SovAI: Staff** watch commands) | `.planning/staff/products/j2/standing-watches.json` in your project, and the watch decisions in `.planning/staff/ledger/decisions.jsonl` | Each watch's PIR and indicator, the slice it matches, its latest time of value, the person it alerts by name and role, what it may draft, its state, what it found while paused (observation ids), the subjects it matched in the last 30 minutes, its current match and drafts. Arming and retiring are signed decisions of the named person. Watch events (state, matches, pauses and alerts with the person's name and role) go into the staff event log. Nothing leaves this computer. |
| A staff team's feed observations (the observation store, read through `mcp:observations`) | `.planning/staff/observations/` in your project, which ignores itself in git, so it is not committed or pushed | Feed reports, one append-only file per feed, channel and hour, each with its label and handling as the feed stamped them; the feed registry and an index of file sizes and hashes; and, for live streams only, the raw messages the reports came from, kept as a documented raw-copy exception (a stream cannot be read again from its source) for a retention period per feed class (72 hours for positions, 30 days for events, 90 days for reports, 7 days for gridded data), with any message over 64 KB kept as its hash and length only. The tools run inside the extension, reach no network, read only this folder and the loaded scenario, and show an agent only reports your clearances cover (none marked no-agent-tools); the chat's label rises to what they show. Labels above org/Internal, NATO Unclassified or Protected A are refused. |
| A team sent for review (**Improve with AI** in Team Studio, and the description you give when the AI drafts a team) | One model on NEAR AI Cloud or your local runtime, only when you ask, after the outbound check | The team's name, description, and each member's name, role, reports-to line, tools and instructions, plus the local check's findings. Which model may see it follows the team's privacy: a private team (marked `privacy: private`, every member private, or any team, including one being drafted, in a project with a knowledge base, which Team Studio decides from the workspace rather than from what the page sends) goes only to a private model, a NEAR TEE model on NEAR AI Cloud's own endpoint whose attestation NEAR reports as supported or verified (one reported as failed or unverified, or not reported at all, does not count), or a model on this computer; a team with some private members goes to a private model, or, when there is none, without those members' text; any other team goes to a model your settings and TEE-only mode allow. Nothing is sent while the team holds something that looks like a key, token or password. The reply is read as data: the reviewer has no tools, its suggestions never change a model or privacy, and none is applied until you accept it and Save. |
| A shared team file (**Share…** in Team Studio) | A `.near-team.json` file you save and choose where to send; the extension sends it nowhere | The team file as saved (names, roles, models, tools, instructions), a summary, a format version and a checksum. No file path, setting, key or token. A team holding something that looks like a key or password is refused; one naming a folder on this computer is shared only after you agree. The team's knowledge graph is included only when you choose it, after local paths, non-web sources and secret-looking values are removed. An imported team file is checked, shown and added only with your consent, and stays untrusted until you approve it the first time it would run; its checksum is not a signature. |
| Team Studio's dashboard | Nothing new is sent anywhere. Your ratings, the last role test of each team, how you last sorted and filtered the dashboard, and a team the AI drafted that you have not yet used or discarded (its name, members, roles, models and instructions, as shown to you) are kept in this extension's own storage on this computer, never synced, and never written into a team file or the project, so a code push never carries them (see below for a line an old development build wrote) | The dashboard reads what is already kept: the project's activity history (each run's title, outcome, times and spend), the live agent activity, and the team files. Ratings and role tests are kept by the team's identity, `user:<name>` for a team in My teams (`archived:<name>` while it is archived) or `project:` and a hash of the project folder's real path, so no path is stored; a new team under an earlier team's name never takes that team's records. A rating is 1 to 5 stars (or cleared), with when it was set; at most 500 are kept. A role test record holds only when it ran, how many members were tested and passed, and the average score; at most 200 are kept. A `rating:` line a development build of this release wrote into a team file (a project team's `team.md` included, so a code push could carry it) is read once into this storage and stays in the file until the team is next saved in Team Studio, which leaves it out; the extension never writes one. The page is given figures and team ids, never a file path. **Share…** and **Import…** leave the rating out, so your opinion is not sent with a team and someone else's is not taken as yours. |
| A team icon (**Upload icon…** or **Generate with AI…** in Team Studio) | A 128 x 128 PNG beside the team file: `<team>.icon.png` in your teams folder, or `.planning/.near-ai/team.icon.png` beside a project's team (so it goes wherever the project's files go); earlier icons in `.versions/.icons/` in your teams folder, on this computer only | **Upload icon…** sends nothing anywhere: VS Code's file picker chooses the picture, the extension checks it by its bytes (PNG, JPEG or WebP, at most 2 MB; SVG is refused because it can carry scripts) and gives the picture, never its path, to the Team Studio page, which crops it and makes it a PNG; the extension checks that PNG again (its signature, 128 x 128, at most 64 KB, intact, nothing but the picture) before writing it. **Generate with AI…** sends the team's name and its description (what it is for), plus a colour scheme and drawing style picked at random from a fixed list, and nothing else from the team, to one image model, only after it names the model and the cost and you agree, and only when the outbound check (Emergency stop, the daily spend limit, TEE-only mode, the privacy check) allows it. When the picture comes out the same as another team's icon and one more is made, that second call reads the current settings and today's spend again, goes through the same checks, and is refused if it would use another model than the one you agreed to. A private team (marked private, every member private, or any team in a project with a knowledge base, decided from the workspace rather than from the page) uses only a private image model: a NEAR TEE model whose attestation counts, as for Improve with AI, or one on this computer. The page shows icons only as data URIs; it may not load an image from a path or the web. A shared team file carries the icon, and an imported icon is checked the same way and left out if it is not a valid icon. |
| Activity and cost records | `.planning/.near-ai/` in your project | Operational facts only (models, token counts, costs, outcomes, and which agent started which); no prompts or replies. The code push leaves these records out by default and names them in its summary; only the shared project files (`team.md`, `project.json`, `verifiers.json`) go up with your code. Add the folder to `.gitignore` if you do not want it committed. |
| Open-GSD installation | `npx @opengsd/gsd-core@<exact version> --claude --global` into the extension's own storage, never `~/.claude` | Installed the first time you run a workflow; in SovAI projects, checked for updates at startup and daily, which contacts the npm registry (it sees your IP address and the package name). Turn both off with `nearAi.autoInstallGsd`. A new version must pass a compatibility check before it replaces the installed one, and the previous version is kept. |

The extension sends **no telemetry** and loads no remote content into its
pages (each has a content security policy that allows only its own scripts).

### Which models are private

NEAR AI runs some models inside an attested trusted execution environment
(TEE) and forwards others to third-party providers. The extension reads this
from NEAR's model catalog (`/v1/model/list`) and shows it in the model picker
and on every reply:

- **NEAR AI private hardware (checked each time it is used)**: NEAR
  reports attestation support and serves the model itself (for example GLM
  5.3, Kimi K3, Qwen 3.x).
- **Runs on outside provider (…)**: NEAR forwards the request to another
  provider, named in the label (for example `openrouter.ai` for DeepSeek V4.1
  Flash, `anthropic.com` for Claude models).

The label reflects NEAR's catalog, and the catalog's word only chooses a
model. Where a model must be private (a team or member marked
`privacy: private`, Team Studio's private calls, and every request while
`nearAi.privacyMode` is `tee-only`), a request counts as private only when the
same check the labels use passes, each time it is sent: a model on this
computer, or a private model on NEAR AI Cloud's own endpoint over a connection
proven to end inside its private hardware (see "Attested cloud in this
version" below). A model on a host your organization names as local counts
only when the policy names that exact host and it is reached over https; a
`*.` pattern or plain http does not. Otherwise nothing is sent, and the
refusal says so. Set
`nearAi.privacyMode` to `tee-only` to hold every request to that check. The
setting's own words for that choice say what private means: "Only verified private hardware or this computer: NEAR AI private hardware, checked each time it is used, or a model on this computer."
Agent teams and members marked private decide through the same check, as
one private floor: whichever asks for private work, the request goes only
where that check passes.

**Where private models come from.** Military staff teams are marked private,
and every private model NEAR AI offers today comes from developers in the
People's Republic of China. Where a staff team is set up, in its team file,
and once in each chat that runs one, it says: "The private models NEAR AI offers today come from developers in the People's Republic of China. Use this team only on fictional or exercise material until your organization approves a model for operational work."
This changes nothing about where the team's work is sent.

### The trust badge on each answer

Every answer of the lead agent that comes from a cloud model has a trust badge
under it, in one of three states. An answer from a model on this computer has
none.

- **Verified private model**: This answer's signature and NEAR AI Cloud's
  attestation were checked, and the connection that carried your request was
  proven to end inside NEAR AI Cloud's private enclave.
- **Model verified, connection not proven**: This answer's signature and NEAR AI
  Cloud's attestation were checked, so a private model on NEAR AI Cloud sent it.
  The connection that carried your request was not proven to end inside the
  private enclave.
- **Not verified**: SovAI could not show that a private model on NEAR AI Cloud
  sent this answer. The reasons below say why.

The badge is chosen only from checks that ran, and it never says more than they
proved. A check that is still running, did not finish in time, could not be
made or failed shows **Not verified**, and so does every later badge of a chat
in which an earlier check failed, until **Check again** on that answer passes.
**Verified private model** needs all of these: the model runs in a TEE on NEAR
AI Cloud's own endpoint, NEAR AI returned a signature id for the answer, the
answer's check passed, and your request went over a connection held to the key
NEAR AI Cloud's attestation names. At a level that needs an attested cloud (see
[Classification labels and routing](#classification-labels-and-routing)) every
request is held to that key, and refused if the server presents another. At
other levels a request to NEAR AI Cloud is held to that key while a fresh proof
of the connection exists. If the server then presents another key, for example
behind a proxy that inspects encrypted traffic, the request is sent without the
key held instead of being refused, a second model request record for it says it
fell back (and nothing about its content), and the answer's badge shows **Model
verified, connection not proven**. With no fresh proof the request is sent as before, and
the best its answer shows is the same.

**When it is checked.** Each cloud answer from a TEE model is checked once,
automatically, in the background, after it arrives. That costs one signature
request per answer; an attestation report SovAI has already verified for the
same signing key is reused for up to ten minutes. While the check runs the badge
shows **Not verified** with "Checking now." A check that has not finished after
20 seconds shows **Not verified**, saying it could not be checked in time, so a
badge never waits forever, for example offline; if the check finishes later,
the badge changes. An answer from a model NEAR AI forwards to another provider is
never checked, and its badge says where it is forwarded.

**Lead answers only.** The badge is on the lead agent's answers only. A helper
agent's answer is not shown to you as an answer, so it has no badge; each
badge's details say that helper agents in the run may have used other models,
each request routed by the chat's label and recorded. At a level that needs an
attested cloud, every answer NEAR AI Cloud sends, tool-call turns and helper
agents' answers included, is checked this way too, and a failed check stops
those levels for the chat (see
[Classification labels and routing](#classification-labels-and-routing)); the
badge reuses that check, so it makes no second request.

**What the check covers.** It follows NEAR's reference verifier
(`nearai/nearai-cloud-verifier`) and checks that:

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
key** is signed inside the model's own TEE. Whether the connection was proven
comes from the connection check described under
[Classification labels and routing](#classification-labels-and-routing): NEAR AI
Cloud's attestation must name the certificate the server presents, and the
connection that carries your request must present it.

**Check again and Show full attestation.** Click the badge, or press Enter or
Space on it, to read why it shows its state and what was checked. Opening the
details moves the focus into them. Escape anywhere in the chat closes them and
puts the focus back on the badge, unless that Escape already did something else
there, such as stopping a run or closing a menu. A click outside the badge
closes them too. **Check again** checks the answer again with a fresh report,
never a reused one. On an answer whose failed check stopped the levels that
need an attested cloud for the chat, it lifts that stop when the answer now
checks out. **Show full attestation** opens the details as read-only JSON in a
preview tab named for the answer, such as "Attestation: answer at 14:32,
glm-5.3": the signed text and signature, the signing address and which
component holds the key, every check result, the connection fact with its
fingerprint, and the attestation report the check used. The tab is served from
the editor's memory, not a file: it cannot be edited and never asks to be saved.
Nothing is written to your project or to a decision record. The full
attestation is kept for the last 20 answers of the window that checked them; an
older answer says so and offers Check again.

What is **not** checked in the editor, and the details say so:

- the platform's TCB status and certificate revocation, which need Intel's
  collateral;
- which code the enclave runs (its measurements against NEAR's published
  build);
- NVIDIA's GPU attestation verdict.

For those, use [cloud.near.ai/verify](https://cloud.near.ai/verify) or NEAR's
verifier.

**A reopened chat.** A chat reopened after a reload or a restart shows each
answer's badge in the state its checks reached when the answer arrived, and
says so; it has neither Check again nor Show full attestation. Answers saved
before this version have no badge. The kept badges hold a state, plain reasons
and a time, never a fingerprint, a signing address or the answer's text, and
they sync with the chat; when two copies disagree about an answer, the weaker
state is kept.

#### The trust line

Beside each badge a line says three things, always in this order: where the
answer ran, what was checked, and what allowed the request. For example:

- "Runs on NEAR AI private hardware · Verified · Allowed for Organization: Internal"
- "Runs on your organization's server · Not checked yet · Allowed for Canada, Protected: Protected B by Alex Example's authorization pb-2027-01 until 31 Mar 2027 (self-signed on this computer)"

Where it ran is one of: this computer, your organization's server, your
organization's server (private hardware), NEAR AI private hardware, a Cohere
vault in its region, an outside provider (named when it is known), or a place
your rules do not name. A local model on any address other than this
computer's own is never called this computer. What was checked is the
badge's own state, or "Not checked yet" before its check runs, so the line
never says more than the checks proved. What allowed it names the label the
request was decided at, every authorization that allowed it (whose it is, its
id and its end date) and the model approval, when there is one. An answer
shown again after a reload says "What allowed it is not kept for an answer shown again",
because a kept badge holds only its state, plain reasons and a time.

### What the agent can do without asking

Under the default `approve-risky` policy, reads and searches run freely, and
file changes and commands ask first. A command runs without asking only if it
matches `nearAi.agent.allowCommands` and is written as plain words. That rules
out quotes, `~`, variables, globs, newlines, pipes, redirects and substitution.
It must also use no absolute or `..` paths, and no git options that write files,
read outside the repository, or delete refs.

In every mode, `fully-autonomous` included, these always ask, with no **Always
allow** and no grant for the rest of the run, even after **Allow edits for this
run** or an allow-list entry that matches:

- writing into `.git/`, where hooks and config would run on the next git
  command;
- writing into `.planning/.near-ai/` (other than its `team.md`) or into
  `.near-ai/` (other than its `scratch/` and `attachments/` folders);
- publishing: git push, merging a pull request (`gh pr merge`), a write
  through `gh api` (a writing method, a field or a body), package and
  extension publishing, release creation, container image push, deploy
  commands, and sending email;
- signing in or out: registry and account logins, logouts and token changes,
  which change the logins and tokens kept on this computer (`npm`, `yarn`,
  `pnpm` and `bun` login, logout and token; `cargo login` and `logout`;
  `docker`, `podman` and `buildah` login and logout; `helm registry login`;
  `gh auth login`, `logout`, `refresh`, `setup-git` and `switch`;
  `gcloud auth login` and the like; `az login`; `aws configure` and
  `aws sso login`);
- destruction: recursive deletes outside scratch and build folders,
  `git reset --hard`, `git clean`, discarding uncommitted changes, history
  rewrites (`git commit --amend`, starting a `git rebase`, and removing
  unreachable commits at once with `git gc --prune=now`, a bare `git prune`
  or `git reflog expire`), and deleting branches and tags. Routine
  maintenance is not destruction: `git gc` and `git prune` that keep git's
  grace period of days or more, and `git rebase --continue`, `--abort`,
  `--skip`, `--quit` or `--edit-todo` on a rebase already under way. The
  grace period is judged from the command line only: a `gc.pruneExpire` set
  in a git config file is not seen, so a plain `git gc` there still runs;
- writing to the knowledge your team shares (the Learn tool).

Approving one of these runs that one call. When a helper agent's card is
approved after the helper has moved on, that exact call (the same tool and
arguments, from the same folder) may run once more; the next one asks again.
In a run with nobody to answer (a model comparison, a role test, a benchmark),
they are refused. The deny list still refuses a command first, and the emergency
stop refuses everything.

In every mode these are refused, with no card: the project's key folder (below),
the NEAR key folder in your home folder (`~/.near-credentials`), SSH keys
(`~/.ssh`), cloud and registry credential files (`~/.aws`, `~/.config/gcloud`,
`~/.azure`, `~/.docker/config.json`, `~/.kube`, `~/.netrc`, `~/.git-credentials`,
`~/.gnupg`, `~/.npmrc`, `~/.pypirc`, `~/.config/gh` (the GitHub CLI's folder, which holds its login),
`~/.cargo/credentials` and `credentials.toml`,
`~/.terraform.d/credentials.tfrc.json`, `~/.config/glab-cli`, `~/.config/hub`,
`~/.gem/credentials`, `~/.local/share/keyrings`, `~/.yarnrc.yml`; a project's
own `.npmrc` or `.yarnrc.yml` is the project's), operating-system keychain
commands that print a secret, commands that print a stored login or token
(`gh auth token`, `gh auth status --show-token`, `gcloud auth
print-access-token` and `print-identity-token`, `az account get-access-token`,
`aws configure get` of a key, token or secret, `aws sts get-session-token`,
`aws ecr get-login-password` and the like, `npm token list` and `create`, `git credential fill`,
git's credential helpers run by hand (`git credential-store get`, `git-credential-libsecret get`), and the `docker-credential-*`
helpers; `git credential approve`, `reject` and `erase` change the stored login, so they ask), VS Code's own secrets database, and this extension's own identity
and policy files in its storage. This holds for the file tools and for shell
commands alike. For aws, gcloud and az, a word that looks like a command that
prints a token (such as `get-session-token`, `print-access-token` or
`get-access-token`) anywhere among the arguments, even as an option's value,
makes the command refused as one: rename that word, or run that step yourself.

A file tool's path outside the project and every folder that tool may use (a
folder SovAI trusts for reading, such as the managed Open-GSD runtime, is for
reading only) is refused at once, in every mode, with the tool's own "outside
the workspace" message and no card, because the tool would refuse it anyway.

Reading a file inside the project that looks like a credential (`.env`, private
keys, SSH, AWS, or NEAR credential files), through any path or symlink, asks
first in every mode except `fully-autonomous`, where it runs without asking (see
Known limitations). The holds after outside content apply in every mode (see
"Outside content and prompt injection").

Once a run has read such a file, in any mode, a call that could send data off
this computer asks in every mode, `fully-autonomous` included, with no
**Always allow** and no grant for the rest of the run, and is refused when
nobody is there to answer: publishing or sending, a web fetch or search, a
call to an add-on server with a web address (or a local one declared to reach
a host), and a shell command the checks know reaches the network (curl or wget
other than a plain download, http and xh, nc, socat, telnet, ssh, scp, sftp,
rsync to another machine, git push, fetch, pull, clone and ls-remote, the
plumbing under them (send-pack, fetch-pack, http-push, http-fetch), `git remote
update`, `show` and `prune`, `git submodule update`, git lfs fetch, pull, push,
clone and its other server commands, gh and
glab, the cloud and cluster tools, a container registry push, pull or login,
an install that names a remote address (a URL other than `file://`, or a
version-control address) with npm, yarn, pnpm, bun, pip, `python -m pip`, uv,
pipx, cargo, gem or composer, `cargo install` or `gem install` from another
registry or source, `go get` and `go install` of a module path, network code
an interpreter runs from the line), as well as one the checks cannot read
whole. An install of a package by name from the default registry is not
held. A command that reads such a file and could send in
the same line is held the same way. Local work still runs unasked: builds,
tests, `npm run` scripts, `make`, and `node` or `python` running a script.
A program the agent starts can still read the credential and send it itself,
and a plain download's address could carry it; only the planned sandbox around
the shell closes that. The read is seen as the other checks see one: a file the
command or tool names, or a path that resolves to one; a recursive search, a
glob, a path built while the command runs, or a link named without a folder
(`cat notes` where `notes` is a link to `.env`) is not. A command that only
mentions a credential file (`echo .env`, a commit message that names it) marks
the run as a read does, and the mark lasts until the run ends.

The checks that keep agents out of key and credential folders read the text of
a command, following the shell's folder and any cd or pushd earlier in the same
command. They cannot see a path built while the command runs (from a variable
or $(...)), what a script or an npm script the command starts does, a program
that reads a store for you and is not one of the token printers the checks know,
a walk down from
a parent folder, or anything an add-on server or the cyber host tools do inside
themselves. There is no operating-system sandbox around the shell yet, so a
determined command can still get past them. Because they read text, a command
that only mentions one of these folders (a commit message that names ~/.ssh,
say) is refused too, with nothing to approve: rephrase the command so it does
not name the folder, or do that step yourself.

The checks that find publishing, destruction and protected writes in a shell
command also read its text, through npm, yarn, pnpm and bun scripts (from the
package.json of the folder the command runs in, after any cd on the line) and
wrappers such as bash -c, sudo, xargs, pipes, subshells, timeout, nice, stdbuf,
flock and watch. A word in `$'…'` quoting is decoded as the shell decodes it
before it is read, so `gh $'auth' token` is the printer it runs. They do not see a command built while it runs (bash -c
"$CMD"), a file run with source or piped into sh, or a script written or
changed earlier on the same line (it is read as it was before the line ran).
Under fully-autonomous such a command runs without asking. A command nested
more than four levels deep, too long to read, one they cannot parse (a quote
left open, say), one with an option they do not know where they would read
what it runs, running a package script in a folder they cannot tell or whose package.json they cannot read, or started by a
program they do not know with a command they would flag among the words after
it, is not guessed at: it asks, and it is refused when nobody is there to
answer. That last case also asks when the words
only mention such a command (for example `mytool git push`, where `git push` is
text the program reads): here a false alarm costs one card and a miss would run
unasked. The check of key and credential folders above is stricter: a mention
there is refused, with no card.

The project's key folder, `.near-ai/state/keys/` (and the `keys/` folder of an older
`state.previous-*` or `state.adopt-*` copy), is off limits to agents in every mode, with no
card to approve: Read, Write, Edit, Glob and Grep refuse it, by path or through a link, and
never list or search it; a shell command whose text names it is refused; and a command that
runs a file in the project whose text names it (for example `node script.cjs`) always asks,
with no "always allow". The shell check follows the shell's current folder: each word of a
command is resolved from that folder, and from any folder a `cd` or `pushd` earlier in the same
command moves to, with `{a,b}` braces expanded, globs read as reaching the key folder when they
could, and links followed. So `cd .near-ai/state` followed by `cat keys/local.key` is refused,
and a shell that ends up inside the key folder runs nothing but a `cd` out of it. The shell
checks still read text, so they are a heuristic: a path built at run time from pieces that do
not look like it (a variable, `$(...)`, string arithmetic, base64), a script that another
script or `npm run` starts, or a directory walk (`grep -r`, `find`, `**`) from the project
root or a folder above it is not caught. A walk that searches, packs or copies `.near-ai` or a
state folder itself (`grep -r`, `rg`, `find`, `tar`, `zip`, `cp`, `rsync`, `scp`, named there or
started inside it) is refused like a path into the key folder. There is no OS-level sandbox around the agent's
shell.

### Your policy file and decision records

Before a tool runs, SovAI checks the call against a signed policy file. This
is what that file and the records beside it do in this version.

- **Where it lives.** The policy file is kept in this extension's own storage
  on this computer, never in your project. It is not committed, synced or
  shared with the people you work with.
- **Who signs it.** Your own device key, held on this computer, signs it. A
  fresh install signs a default policy that allows what your settings allow, so
  nothing changes until a policy narrows it. Your settings can narrow what the
  policy allows and can never widen it. Activation creates this install's
  device identity in every folder, not only for Team Mode, because it signs the
  first policy file with it.
- **When it cannot be trusted.** If the file is missing, unsigned, changed or
  expired, only reading and planning run until you open **SovAI: Policy** and
  choose **Reset my rules**, and the project's key folder stays off limits in
  every case.
  A policy written for a newer version (one that names a feature in its
  `requires` list, or a version or action list this version does not know)
  is never applied in part and never ignored: only reading and planning run, and
  the sentence says to update the extension. It never offers Reset as the fix,
  because a reset would discard every rule the policy holds. A setting this
  version does not know is refused the same way, and the sentence names both
  ways on: update the extension if a newer version wrote it, or, only for a
  policy signed by this computer's own key, **SovAI: Policy** offers
  **Reset my rules**, saying it keeps the old file and discards every change
  made to the policy. A policy signed by any other key is never offered Reset.
  The status bar says "Policy: reading only" with one sentence naming the cause
  and the fix. Deleting the file does not reset a policy: a file that has gone
  missing counts as a changed one. A file signed by a key this computer does
  not know is never adopted, even one that carries the default policy, and a
  valid file that is not the policy SovAI last used is refused too. SovAI
  signs a policy by itself only on a true first install, when nothing shows an
  earlier one: no remembered policy in this computer's secret storage, no
  policy file, no record naming an earlier policy and no key history without
  its key. Only **Reset my rules** re-signs a policy that failed, and it
  resets your own rules only: your organization's rules and files stay as they
  are. It asks you to confirm, keeps the old file beside the new one, and
  records the reset.
- **Reading it.** **SovAI: Policy** opens the policy page (see below).
  **Show as stored** on that page opens the policy in plain words and as
  stored. The view is read only, and editing it changes nothing.
- **Changing it.** **Edit my rules** on the policy page opens an unsigned draft
  of your own rules, kept in this extension's storage and never in your
  project. **Apply my draft** on the page, or **Apply** in the message beside
  the draft, shows the change on the page first; **Apply to my rules** there
  checks it, sets the signer and the dates itself, signs it with your device
  key and records the change with the old and new policy hashes. A draft that
  is not valid, or that was made before the policy changed (a reset, or an edit
  in another window), changes nothing.
- **No network.** Nothing in a decision needs the network, so the policy
  works the same offline.
- **Policy and paths used for a decision.** The record identifies the valid
  policy evaluated for that decision. A new check after someone approves a
  call uses its own policy record. A reply without a new check refers to the
  original question. If the tool's host derives a write destination, the
  gate checks that destination and retains any refusal from the original
  call. The manifest records the exact destination the tool can write.
- **Decision records.** Each decision, allowed, asked or refused, is written
  to a record for the project in this extension's storage. A call refused
  before it could be judged (a tool the run does not have, arguments that are
  not valid JSON or do not fit the tool, or a tool's own check that failed) is
  recorded too, naming the tool and never its arguments. A record names what
  was asked for, what was decided and why, never file contents. A command is
  named by its first line only, and before a record is written SovAI removes
  from every text in it: known token shapes (such as `sk-`, `ghp_`, AWS access
  keys and JSON web tokens), bearer tokens, a value given to a name such as
  `password`, `secret` or `api_key`, the user part of a URL
  (`https://user:password@host`), the value of `-u`, `--user`,
  `--proxy-user` or `-U` when it holds a colon (a numeric user and group, such
  as `1000:1000`, is kept), the value of an option named
  for a password, passphrase, token, secret, API key or credential (such as
  `--password=...`, `--token ...` or `-storepass ...`; a number given to a
  count of tokens, such as `--max-tokens 4096`, is kept), the value of an
  `Authorization`, `Proxy-Authorization`, `Cookie`, `Private-Token` or
  `X-...-Token` or `-Key` header, and the value of an environment assignment,
  URL query parameter or form field named for one (such as `GITHUB_TOKEN=...`,
  `?api_key=...` or `-d "password=..."`). It does not remove a password passed as a plain argument
  (`sshpass -p`, `mysql -p...`, `htpasswd -b`), one a script receives or
  reads, one built by command substitution, or one under an option or name
  not listed here, so do not put a password in a command's first line.
  Records are not synced and are not put in your project, in
  the chat history or in the project's synced state. Each project's log rolls
  over at about 5 MB and keeps the last four older files. What happens to the
  policy itself (it was created, renewed, reset, loaded, or could not be
  trusted) belongs to this install and not to a project, so it is written to
  a separate log for the install in the same storage, whether or not a folder
  is open, and also to the open project's record when there is one. That log
  rolls over the same way. The decisions of a run in a window with no folder
  open are written to that install log too.
- **Model requests.** Before anything is sent to a model, whether from the
  chat, a helper agent, an attached file being read, the chat view in VS Code,
  Team Studio, a cybersecurity scan or a model comparison, SovAI checks the
  request against the routing tiers in the policy file, using only what is on
  this computer. Each chat's label decides where its requests may go (see
  [Classification labels and routing](#classification-labels-and-routing)); a
  chat that read nothing labelled is at the policy's default label, which may
  go to any model, so on a fresh install nothing changes where requests go. A request the routing does not allow is
  not sent, and you are told why in plain words. Content at a level whose tier
  needs an attested cloud model goes to NEAR AI Cloud only over a connection
  proven to end inside its private hardware; otherwise it stays on this
  computer. Every model request, sent or not, leaves a record in a log of its own,
  `gate/model-requests/` in this extension's storage, beside the decision
  records: it rolls over the same way, is never synced and is never put in your
  project. A routine record holds the time, who asked, the model and its
  provider, the routing tier, the rule that allowed it and the policy's hash,
  each once; a refused request's record also holds the plain reason and the
  label that decided it, which is the policy's default label when nothing
  raised the label. Every record is written when the route is decided, before
  anything is sent. A request at any-cloud that was to go over the connection
  held to NEAR AI Cloud's attested key, met another key and was sent without it
  gets a second record holding `connectionFallback: "unpinned"`. A request whose route cannot be worked out is refused with
  a fixed reason and no label. A record of a model request names never the
  content, the endpoint's address or a file path.
- **Labels and clearances in this version.** **SovAI: Set Label** labels a
  file, a folder or the project. Labels are kept in
  `.planning/.near-ai/labels.json`, signed with your device key, and travel
  with the project, so anyone who can read the project can read its labels,
  compartment names included: do not use a compartment name that is itself
  secret. A label file SovAI cannot verify (changed by hand, merged, or signed
  on another computer) only ever makes a label stricter, and it is signed
  again only after you confirm. A label file that cannot be read, or that was
  deleted, stops agents reading the project until you put it back (for example
  with git restore) or sign the labels this computer last checked again with
  **SovAI: Set Label**. A signed label file that is older than, or different
  from, the one this computer last checked (for example after switching
  branches) also stops agent reads, with one button, Use this branch's labels,
  that makes its labels the current ones. SovAI remembers the label file it
  last checked in this computer's secret storage, so deleting files does not
  make it forget. Reading SovAI's own Open-GSD runtime files is judged at the
  default label; a link from there into the project keeps the project file's
  label. While a label file holds reads, only reads of the project are held:
  reads of those runtime files go on. You can set only a label your own clearance covers;
  to add a clearance, open **SovAI: Policy** and use **Edit my rules**, then
  **Apply my draft**. An agent cannot read a file whose label your clearances do not
  cover, through the file tools, searches or a command that names it; a read
  a command does not show (a path built in a variable) is not seen. A glob in a
  command (such as `secret/*.md`) is checked against every labelled file it
  could match, and a glob next to a variable is judged by the strictest label
  in the project. Content
  with no label takes your policy's default label, so a policy with no
  clearance on that scale cannot read it. Decision records hold the labels
  involved and stay on this computer. Where a labelled chat's content may be
  sent is in [Classification labels and routing](#classification-labels-and-routing). **A ceiling per add-on server.** Your policy can also set the highest label
each MCP server may receive. A call to that server from a chat whose label is
above it is refused before anything is sent, at every tier, with
`label.mcp-ceiling`; see "MCP connections" below.

Labels and routing are an organizational control that helps prevent mistakes. They check what NEAR AI itself sends to a model and what its own file tools read, and they cannot see everything a shell command or an add-on server does. They do not make this device accredited for classified information. Until verified credentials arrive, your clearance is the one you declared yourself, so it is not an enforced boundary.
- **Your clearance is your own word.** Until verified credentials arrive, your clearance comes from your own policy file, which your own device key signs, so it is self-declared. It is not an enforced clearance boundary.

#### Your organization's rules on this computer

Your organization can hand its rules to every computer that uses SovAI.
Its security contact gives you a signed `.near-org-enrolment` file, and
**SovAI: Add Your Organization's Rules** opens it. The file is read as
hostile input: a file larger than 64 KiB is refused before it is read, and
nothing in it is used until its signature checks out against the key it
names.

Before that key is trusted, SovAI shows twelve words computed from it,
under its own domain (`near-ai/org-issuer/v1`), so they cannot be mistaken
for words made for anything else. The question reads "Use the rules from
Example Organization on this computer?" with your organization's name, and
the details say: "Ask your organization's security contact to read their
twelve words. Compare them with these:" followed by the words and the key's
fingerprint. Compare them with the twelve words your organization's security
contact reads to you over a channel you trust, such as a call you placed to
a number you already know. The only button is **The twelve words match**.
Closing the question, or any other answer, writes nothing.

Once you confirm, the key and the date of the last rules you accepted are
kept in VS Code's secret storage on this computer, not in a file on disk.
If that record disappears from secret storage while your organization's
rules are still on this computer, SovAI does not fall back to your own
rules: only reading and planning run until you open your organization's
enrolment file again and compare the twelve words.
From then on a newer version of your organization's rules is accepted only
when that key signed it and it is newer than the rules in use; an older one
is refused. A handover to a new key must be signed by the key in use, and
you compare the new key's twelve words the same way. Rules signed with this
computer's own key are never taken as your organization's.
If the rules file on this computer goes missing, or an older one is put in
its place, opening the current rules file or enrolment file again writes it
back without changing the key in use.

Your organization's rules end on the date they carry. When they have ended,
only reading and planning run until your organization sends current ones,
and the status bar says why, for example: "Your organization's rules ended on 2027-01-31. Ask Security desk (security@example.org) for the current rules."
The tool your organization uses to make these files, `scripts/org-issuer.mjs`,
keeps its key in a passphrase-protected file on the issuing computer, never
on yours. The key file is sealed with AES-256-GCM under a key that scrypt
derives from the passphrase (N = 2^17, r = 8, p = 1, a random 16-byte salt
and 12-byte nonce for each file), so someone who copies the file must pay
that cost for every passphrase they try. The tool opens a new key file again
with its passphrase before it says done, and refuses a key file that is not
sealed this way, including an unencrypted key.

#### Layers, the policy page and versions

**Layers that only narrow.** The policy in force is your organization's rules
narrowed by your own rules on this computer. Your own rules can make a rule
stricter and never wider: each setting has one declared direction, and a
personal value wider than your organization's is ignored, and listed once in
one notice, for example: "These personal settings are wider than your organization allows and have no effect: labels.routing.levels.org/Internal (yours: any-cloud, allowed: local-only)."
A change you apply that would make a setting wider is refused, naming the
setting: "Your organization's rules do not allow labels.routing.levels.org/Internal to be wider than local-only."
A project's rules are part of the same design and can only narrow too, but
no project carries rules of its own in this version. Without your
organization's rules, your own rules are the policy, as before.

**Reset touches your own rules only.** **Reset my rules** signs fresh starting
rules for your own rules with this computer's key. Your organization's rules,
and the files that hold them, stay as they are.

**The policy page.** **SovAI: Policy** opens one page, titled "Your organization's rules"
when your organization's rules are on this computer and "Your rules" when
they are not. It shows the rules in force, section by section, read only, and
says who set them. A change to the rules, such as a draft of your own rules,
is shown there first as a proposal, one plain sentence per setting, each marked **Wider** or **Stricter**; nothing changes until you
choose. A change to your own rules is applied with **Apply to my rules**. A
change to your organization's rules cannot be made on this computer, because
your organization keeps its key elsewhere: **Save a file for your organization**
writes it as a signed `.near-policy-proposal` file to send to your
organization's contacts, and nothing changes here. **Discard** drops a
proposal, and a proposal made from rules that changed while it was shown can
only be discarded. **Edit my rules**, **Apply my draft**, **Show as stored** and
**Reset my rules** are on the same page; Edit my rules and Apply my draft are
there only while your own rules can be read and this computer holds the key
that signs them.

**Versions.** A policy file an earlier version wrote (version 1) is read as it
is and never rewritten on its own; the first change you apply writes
version 2. A fresh install and a reset still sign version 1 starting rules. A
policy that lists in its `requires` a feature this version does not have, or
names a newer version of SovAI, is never reset for you; the sentence says to
update, for example: "Your policy file needs version 0.5.0 or later of SovAI. Update SovAI to use it. Until then only reading and planning run, and your policy file is left as it is."

**Leaving.** There is no command to leave your organization. Removing its
rules means removing everything this extension keeps on this computer, its
saved secrets included, so ask your organization's security contact first.

### Classification labels and routing

**What a label is.** A label is a level on a scale (for example `org/Confidential`),
with optional compartments and handling flags. Labels are stored by that id
and shown by the scale's name with the level ("Organization: Internal",
"Canada, Classified: Confidential"). The organization scale's Confidential
level is shown as "Sensitive" so it is never mistaken for the Canadian
classified level of the same name; its id stays `org/Confidential`. Every check
that ranks levels, the staff checks and a chat's label included, reads your
policy's own scales. **SovAI: Set Label** labels a
file, a folder or the project; the labels are kept in
`.planning/.near-ai/labels.json`, signed with your device key, and travel with
the project, so anyone who can read the project can read its labels.

**Scales.** Four scales ship with the policy: `org` (Public, Internal,
Confidential, Restricted), `ca-protected` (Protected A, B and C),
`ca-classified` (Confidential, Secret, Top Secret) and `nato` (NATO
Unclassified to Cosmic Top Secret). The NATO levels come from secondary copies, and treating the Canadian Protected and Classified families as two scales is how SovAI reads them. Your organization's security officer should confirm both before you rely on them.

**Clearances.** An agent reads a labelled file only when a clearance in your
policy covers its label; add one in **SovAI: Policy** with **Edit my rules**,
then **Apply my draft**. Until verified credentials arrive, your clearance comes from your own policy file, which your own device key signs, so it is self-declared. It is not an enforced clearance boundary.

**The chat's label.** Each chat has a label that rises with what its agents,
helpers included, read: reading a Confidential file makes the chat
Confidential. It is kept with the chat and synced with it, encrypted like the
rest of the chat. A sync never lowers a chat's label: two copies merge to the
higher label. Only you lower it, with **SovAI: Lower This Chat's Label** and
a reason that is recorded. You reach it from the Command Palette, by clicking
the chat's label beside the model (or pressing Enter or Space on it), or with
the button under any refusal that names it. Lowering a file's label with
**SovAI: Set Label** does not lower a chat that read the file: the chat keeps
its label, says so, and offers the same button. A lowering reaches your other computers only as a
declassification signed with your device key that they can check, and only
when it undoes no raise made there. In this version your other computers
cannot check another computer's key yet, in or outside Team Mode, so a
lowering made on one computer is not applied on the others: the higher label
stays there and the chat says why. Lower it there too if you need to.

**What a labelled chat writes.** A file a labelled chat writes takes the chat's
label in the label file, never a lower one, so a later chat that reads it is
labelled too. A file holds one label. A file already labelled on a scale the
chat's label also holds is raised on that scale. A file labelled only on scales
the chat's label does not hold is left as it is, so it keeps a label whose tier
may let its content go to a private cloud model once those are allowed. The
chat's own label keeps protecting what the chat holds. A label file that is not signed by
this computer is never signed again for this without you: you are asked once,
with Sign Again.

**Routing tiers.** Each level maps to one tier:

| Tier | What it allows | Levels by default |
| --- | --- | --- |
| any-cloud | any model you have set up | `org/Public` |
| attested-cloud | a private model on NEAR AI Cloud, over a connection proven to end inside its private hardware | `org/Internal`, `org/Confidential`, `ca-protected/Protected A`, `nato/NATO Unclassified` |
| local-only | a model on this computer | `org/Restricted`, `ca-protected/Protected B`, `ca-protected/Protected C`, `ca-classified/Confidential`, `ca-classified/Secret`, `ca-classified/Top Secret`, `nato/NATO Restricted`, `nato/NATO Confidential`, `nato/NATO Secret`, `nato/Cosmic Top Secret` |
| deny | no model | none by default |

A chat that holds labels on several scales goes by the strictest tier among
them.

**Attested cloud in this version.** Levels whose tier is attested-cloud
(Internal, Confidential, Protected A and NATO Unclassified by default) may go
only to a private model on NEAR AI Cloud's own endpoint, and only over a proven
connection:

Content at a level that needs an attested cloud goes to NEAR AI Cloud only when NEAR AI Cloud's attestation shows that the connection ends inside the private enclave: the enclave's attestation must name the certificate the server presents, and the connection that carries your request must present that certificate. When this cannot be shown, content at those levels stays on this computer, and a request with no model on this computer is refused.

NEAR AI Cloud's attestation names the key of the certificate its endpoint
serves, so from this release content at these levels can reach a private NEAR
AI Cloud model again, whenever that check passes. SovAI makes the check in
the background, never while a request waits, and repeats it every few minutes;
a check older than ten minutes no longer counts. After each such answer, SovAI
also checks the answer's signature and NEAR AI Cloud's attestation (see
[The trust badge on each answer](#the-trust-badge-on-each-answer)). If that
check fails, nothing more at these levels is sent to NEAR AI Cloud from that
chat until **Check again** under that answer passes; a new chat or a window
reload also starts without the stop, and the failure stays in the decision log.
A check that cannot be made, for example offline, changes nothing. Behind a proxy that inspects encrypted traffic, the connection cannot be proven, so content at these levels stays on this computer. Protected B stays on this computer because no CCCS
Medium assessment of NEAR AI Cloud was found, unless your organization changes
its policy.

**Local means this computer.** Local-only means a model on this computer
(localhost, 127.0.0.1 or [::1]) unless your organization names another host in
its policy's list of places (see [Where AI may run](#where-ai-may-run)), with
two limits. Content at a local-only level (Protected
B, `org/Restricted` and NATO Restricted by default) goes to a named host only
when the policy names that exact host, not a `*.` pattern, and the runtime is
reached over https; otherwise it is refused with `route.local-host-not-exact`.
Content at Protected C, any Canadian classified level, or NATO Confidential and
above never leaves this computer, even for an exact named host, and is refused
with `route.this-computer-only`. This holds whatever tier the policy gives
those levels: no cloud and no other host is accredited for them today, so a
policy that routes one of them to attested-cloud or any-cloud still keeps it
here, and every check that reads a tier treats them as local-only. A pattern or plain http still counts as local
for levels whose tier is attested-cloud. A policy whose local hosts hold a
`*.` pattern is told so, naming the entry, each time the window starts.

**Classified work on a computer not recorded as accredited.** When a chat's
content at Protected C, a Canadian classified level, or NATO Confidential and
above goes to a model, the chat says once: "This computer is not recorded as
accredited for" the label, that nothing stops you yet, and that your
organization may require an accredited system. The decision log records
`route.not-accredited` once per chat. Nothing is refused for it in this
version; once your organization can issue accreditation records, it will be.

**Calls that could send data off this computer.** While a chat's label is
local-only or deny, a web fetch, a web search, an add-on server call or a
command that could send data off this computer is refused, whatever the mode,
and a refused request names **SovAI: Lower This Chat's Label** as the way out
when what the chat read allows it. While a chat holds content whose label may not go to any cloud (Internal, Confidential or higher by default), SovAI keeps fingerprints of the labelled text its agents read, never the text itself, only in memory and never in a record, and refuses a web fetch, a web search, an add-on server call or a command that could send data off this computer when what it would send carries some of that text. This catches labelled text copied or quoted into a request. It does not catch a paraphrase, an encoding such as base64, or a program the agent starts that reads the file and sends it itself; a planned sandbox around the shell is the stronger fix. A chat reopened after a reload or a restart cannot tell which of its earlier results came from labelled files, so it treats all of them as labelled: a call that would send text from any of them is refused, and the refusal says why.

**A ceiling per add-on server.** Your policy can also set the highest label
each MCP server may receive. A call to that server from a chat whose label is
above it is refused before anything is sent, at every tier, with
`label.mcp-ceiling`; see "MCP connections" below.

Labels and routing are an organizational control that helps prevent mistakes. They check what NEAR AI itself sends to a model and what its own file tools read, and they cannot see everything a shell command or an add-on server does. They do not make this device accredited for classified information. Until verified credentials arrive, your clearance is the one you declared yourself, so it is not an enforced boundary.

#### Where AI may run

**One list of places.** Your policy holds one list of every place AI may run:
your organization's servers, private hardware and outside providers, each
with the highest label it may receive and the region it is in. It replaces
the local hosts of earlier versions (`routing.localHosts`). A policy that
named local hosts is moved to the list once, with the same effect as before,
and says so once: "Your policy's local servers are now listed with every other place AI may run, with the same effect as before."
When a host can no longer take a level, the notice names the host and the
level, and those levels then need a pinned connection and an authorization
from your organization. With no list (the starting rules), the places are
this computer and NEAR AI Cloud, and nothing changes where requests go.

**What a place in the list means.** A place your rules list is reached only
over https; a plain http connection to it is refused (`route.endpoint-pin`).
This computer is the only exception. Only NEAR AI Cloud's own host may be
listed as NEAR AI private hardware (`nearai-tee`). Only a model NEAR AI's
catalog marks as running in private hardware counts as running in a place
your rules list as NEAR AI private hardware; any other model on that host is
forwarded to an outside provider, with no stated region, and no
authorization naming that place covers it.

**What the list decides.** After a chat's label allows a request, these
refuse it, each recorded with its rule id:

- a place the list does not name, for content that may not go to any cloud
  (`route.endpoint-unknown`);
- content above the highest label the place may receive
  (`route.endpoint-ceiling`);
- Protected B (and NATO Restricted), sent to any server that is not this
  computer, without a TLS pin for that server or, on private hardware, a
  fresh proof of the connection (`route.endpoint-pin`);
- the same content without a Protected B authorization that names that
  server (`route.authorization-missing`);
- a place outside the regions your rules require for a level
  (`route.residency`).

So Protected B needs a TLS pin or a verified connection plus a Protected B
authorization naming that server, for every server that is not this
computer. This is a change: Protected B used to reach a server your policy
named as local with an exact name over https alone; it now needs both.

**Residency.** Your rules can require that content at a level runs only in
some regions (Canada, the European Union or the United States). Every place
but this computer is checked, and a place whose region is `unstated` never
satisfies such a rule. A residency exception authorization can allow one
place for a while.

**Rules that only record in this version.** Content at Protected C, a
Canadian classified level, or NATO Confidential and above runs only on this
computer. When no authorization says your organization approved this
computer for that work, the request is recorded as one that rule would
refuse (`route.accredited-device`) and the chat says once that this computer
is not recorded as accredited for that label; it is not refused unless your organization's
rules turn on `requireAccreditedDevice`. Model approvals work the same way
by default: a model your rules have not approved for the work is recorded
(`route.passport`) and sent, and with no `models` section the shipped
approvals are used in this report mode. When your organization's `models`
section says `mode: enforce`, the same request is refused before anything is
sent, with the reason.
A step that only records never refuses, even when its check cannot be made;
it is then recorded as one that would refuse. Under `mode: enforce` a model
approval check that cannot be made refuses.

**Authorizations.** An authorization is one signed record that allows one
thing for a while:

- a server for Protected B (`protected-b`, at most 365 days);
- a model for a use its approval does not cover (`t1-risk`, at most 90 days);
- this computer for work that stays on it (`accredited-device`, at most 365
  days);
- a place outside the regions your rules require (`residency-exception`, at
  most 90 days);
- a label made lower (`declassify`, with no fixed end);
- a person, for export-controlled content (`export-person`, at most five
  years, less for some regimes' exemptions);
- an AI service, for export-controlled content (`export-endpoint`, at most
  365 days).

Under your organization's rules only authorizations signed by a key your
organization lists count. Without your organization's rules, one signed on
this computer counts for your own rules, and the trust line says
"(self-signed on this computer)" until your organization's issuer can sign
them. A model exception (`t1-risk`) is the one kind that never counts this
way: it counts only under your organization's rules (see "Which models may do
what").

#### Export-controlled content

Content can carry one of three markings for export-controlled work, shown
after the level: Controlled goods (Canada), ITAR, and US export-controlled
(EAR), for example "Organization: Internal · ITAR". In policy files and
records they are the compartments `CGP`, `ITAR` and `EAR`.

Under the starting rules, content marked Controlled goods (Canada), ITAR or
US export-controlled (EAR) stays on this computer: the starting rules route
all three to local-only. A fresh install, and the renewal of starting rules
nobody edited, get these entries. An install upgraded from an earlier version
whose starting rules nobody edited gets them when its policy is next renewed,
in the last 30 days before the policy ends; until then those markings are
routed by their level. A policy someone edited is not changed in place; it
gets them through a change on the policy page. Under your organization's
rules, your organization decides.

Your organization's rules can now carry its export-control decisions: who
may see such content and which AI services may receive it. Nothing grants
access with them yet; a later release uses them. Until then the two
authorization kinds for them and the rule `route.export-control` are shapes
that are read and recorded only, and never decide a request. Meeting the
Controlled Goods Program or the ITAR is your organization's obligation, and
your officials decide. SovAI does not make your organization compliant
with either.

### Which models may do what

Every model request is checked against an approval for its use before
anything is sent. An approval names the model, the uses it is approved for,
the places it may run and the date it ends. Your organization's signed rules
hold its approvals (its model policy); without them, the approvals SovAI ships
are used. Your organization's approval of a model replaces the shipped one.

**Approvals by use.** Each request has one of four uses, worked out on this
computer from what the request does: research only (in the research
workspace), chat you review (plain chat whose answer a person reads), agent
work (tools, file changes, sub-agents, checks, unattended runs) and
operational work (a staff project). A use only rises during a chat, and a
sub-agent starts at its parent's use. A model may do the work only when its
approval covers the use at the place it runs; the model picker shows each
model's origin, family and "Approved for {use} until {date}" or "Research
only". Under enforce, every use above research also needs your organization's
evaluation of that model's files, cited in its approval, and this includes
every checking role. The approvals SovAI ships carry no evaluation, so under
enforce nothing goes above research until your organization evaluates its
models.

A model from a developer in the People's Republic of China is approved for
research only, and so is a model with no approval. A model under a
non-commercial licence is approved for research only, except through the
vendor's own service. Command A+ is approved on the Cohere Model Vault; your
organization may approve its own on-premise copy with the files' hash; it is
never approved on NEAR AI's private hardware.

**The refusal.** Under enforce a refused request sends nothing. The chat says
why in one form, which starts with "Nothing was sent." and ends with "Who to
ask:", for example: "Nothing was sent. Your organization has not evaluated gpt-oss-120b for agent work, and under its rules a model takes any role above research only after that evaluation. Choose an evaluated model, or ask for this one to be evaluated. Who to ask: your organization's security contact."
When other models would pass, it names up to five of them. Nothing moves your
work to another model by itself. When no approved model can do the work, the
chat shows the ways forward that apply here, and who to ask.

**Report only.** Until your organization's model policy says
`mode: enforce`, and on every computer without your organization's rules,
approvals are only reported: the request is sent and recorded as one the rules
would refuse (`route.passport`). From the first such request in a session, a
notice stays at the top of the chat and in the status bar, with no way to
close it: "Agent work is running outside your organization's model policy (report only)."
Without your organization's rules it says "Agent work is running outside your rules for models (report only)."
and offers **Adopt the Western defaults**, which opens a proposal on the policy
page; nothing changes until you apply it. In report mode today's models,
including those from developers in the People's Republic of China, keep doing
agent work, and each use outside the rules is recorded (G409).

**The Western defaults.** The models for each job come from one list, by
approval: standard Nemotron 3 Super, then Command A+, then gpt-oss; deep
Nemotron 3 Ultra, Command A+, gpt-oss; fast Nemotron 3 Nano, gpt-oss, IBM
Granite; safety checks gpt-oss, Nemotron 3 Nano, Granite Guardian; vision
Command A+; transcription Whisper large-v3; images FLUX.2 klein 4B. For each
job, a model you set yourself is kept; otherwise your organization's default
is used, then the first model in that list that the AI service offers and the
rules allow. In report mode, while none of these models is offered, each job
falls back to the model it used before; under enforce it never does.

**The research workspace.** **SovAI: Open Research Workspace** opens the one
place where a model approved for research only, including an adversary model,
is used on purpose. Its banner says "Research workspace. Adversary models allowed. No project data."
It reads no project file, searches no project, keeps no project memory and
has no tools; anything else is refused with "This is the research workspace. It cannot open project files, run commands or use tools."
A file you add is copied into the workspace's own folder first, and a file in
an open project is refused. Text copied out starts with the line
"From the research workspace, model {model}, untrusted". Records of its
requests say `lane: t0`. The cybersecurity panel and Compare Models'
evaluations run in the same research lane. The workspace is kept apart by
SovAI's own checks, not by the operating system, and the cybersecurity scan
tools still run on this computer with your approvals and the engagement's
scope check (G413).

**Exceptions.** Under your organization's rules, a named person can allow one
model approved for research only to serve chat you review, for named projects
and labels, for at most 90 days. On the policy page, **Ask to allow for chat you review**
drafts the exception with the model's legal flags first, the named person
signs it, and it is saved as a request file for your organization; nothing
changes on this computer. It counts only once your organization's rules carry
it and list that person's key, and the trust line then reads
"Allowed for chat you review by {name} until {date}". An exception never
allows agent work. With no organization rules there are no exceptions: one
signed only on this computer covers nothing.

**Checks by another family.** Every role that checks another model's work
(the safety check of agent commands, reviewers, plan checkers, verifiers,
editors, red team, the staff release guard and the J2 tradecraft reviewer)
runs on a model of another family than the model it checks. The family comes
from the approval's lineage, not from the model's name. When no approved
model of another family is available, a person decides, and the chat says:
"This check was not given to {model}, because it comes from the same family ({family}) as the model it checks, and no approved model of another family is available. A person decides instead."
The record of each check names both families.

**What the records say.** Each model request's record names its use, the
approval by id and hash, and, when the request was refused or reported, the
reason. **SovAI: Export AI Bill of Materials** writes
`.near-ai/state/ai-bom.cdx.json` in an open project: a CycloneDX 1.6 list of
every model the project used, from the model requests this computer still
keeps, with supplier, licence, the files' hash when known, the base model and
teachers with their origin, the approval's hash, where it ran and the uses it
served. It holds no prompt or answer text.

**Known limits.** Each one is in the
[road to production](https://github.com/VitalPointAI/near-ai-vscode/blob/main/docs-site/content/security/road-to-production.md)
with its gap id.

- No Western model runs in NEAR AI's private hardware yet, so under enforce
  agent work on NEAR AI has no approved model (G408).
- Under enforce nothing goes above research until your organization evaluates
  its models (G410).
- On NEAR AI's private hardware an approval binds to the model's name, not to
  the exact files, because the proof of the hardware does not report the
  files' hash (G411).
- How NEAR AI passes the publishers' licence terms on to your organization is
  not answered yet (G412).
- The research workspace is kept apart by SovAI's own checks, not by the
  operating system (G413).
- An exception is signed with this computer's device key until a person's
  credential replaces it (G414), and it records the mission benefit but no
  reference to your organization's assessment of the model (G537).
- Stop agent work now, a security officer's signed switch to enforce, is not yet available, so enforce comes only from a new signed policy from your organization (G418).

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
  complete. The one exception is a verifier SovAI scaffolded whose text still
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
  import cycle. The verifier scripts SovAI scaffolds are also compared with
  the SHA-256 recorded in `.planning/.near-ai/verifiers.json` when they were
  written (a file agents cannot change without asking); a scaffolded file that
  differs in any way asks. You may edit a scaffolded verifier, but it asks until
  you run **SovAI: Trust Research Verifiers**, which lists the changed files
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
A team member with `privacy: private` in its team file (or every member of a
team with `privacy: private` in its frontmatter) goes further: it runs
only on a model in a NEAR TEE or on this machine, even when the chat's own
model is forwarded. The model must also be private on the run's own route:
a run on NEAR AI Cloud uses only TEE models, and only on NEAR's own endpoint,
where attestation can be checked (never a local catalog entry, and never a
different endpoint that claims TEE); a run on a local runtime uses only its
local models. If the run has no such model, or its route is unknown, that
member does not run and the lead is told why; its work is never sent to a
forwarded model instead. Choosing the model is not the check: each request the
member sends counts as private only when the gate's own check passes, a model
on this computer or a private model on NEAR AI Cloud over a connection proven
within the last ten minutes to end inside its private hardware, and is refused
before anything is sent otherwise. New
research teams set this on every member, and new presales teams on their
reviewer; `privacy: any` turns it off for a member.

When a team member's model is overloaded at NEAR AI or keeps sending nothing,
the member moves to another model by itself, under the same rules: only a
model at least as private as the one it leaves (a TEE model moves only to
another TEE model, a local one only to another local one, and a forwarded one
never to a local one), only a private model its route can carry for a
`privacy: private` member, and only a TEE or local model in TEE-only mode. The
model it moves to goes through the same route check as every request, so the
chat's label still decides; a refused model is skipped, and if none is left the
member stops and says it was refused by policy. The same rules now also choose
the model a stalled reply is retried on (`nearAi.agent.modelStallSeconds`), so
a private member is never retried on the chat's forwarded model.

With `nearAi.agent.imageReview` set to `ask` (the default), a generated image
is first saved as a draft in the project's `.near-ai/drafts/images/` folder,
which is ignored by git (by the project's `.gitignore` and by the folder's own
`.gitignore`), and reaches the path the agent named only when you accept it.
The agent's file tools treat that folder like the rest of `.near-ai/`: writing
there asks. When you ask for changes and the agent edits the draft, the draft
image is sent to the same image model's provider, through NEAR AI's
`/images/edits`; no other image leaves the machine. Drafts are deleted when
you discard them or when a new version of the same image is made, and any left
behind are removed after 7 days.

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

**Staff team write limits.** In a team file with a `staff:` block (the military
staff templates), three members are held to their own files by the extension, not
only by their instructions: the `red-team` may write only
`.planning/staff/products/<section>/red-team-critique.md`, the
`release-guard` only its section's gate reports,
`.planning/staff/products/<section>/guard/`, and the J3 `watch-officer` no file
at all (it logs by proposing event-log rows through the staff tools). Write and Edit refuse
any other path outright (no approval card), after resolving `..`, absolute paths
and links, so a critique or a verdict can never change a plan file. Such a member
is also given no tool that could write elsewhere (shell, document and graphics
makers, MCP tools, starting other agents), even when its `tools:` line lists one.
The one exception is the built-in staff tools it is granted (propose, verdict,
status, list, the register tools, the tradecraft lint and guard-scan): they write
only the ledger, product headers, gate reports and register proposals, and the
extension refuses to let such a member register any product or write any
register outside its own files.
Teams without a `staff:` block are unaffected.

**Update Team** rewrites a team file (and, for a project, the extension's own
block in `AGENTS.md`) only from the **SovAI: Update Team…** command or the
Team Studio button, after a preview and a confirmation, never while a run is in
progress, and never from an agent. It copies the file into the team's version
history first and offers **Undo**.
API keys are bound to the endpoint they were saved for, in SecretStorage, so
editing the project's profile file cannot redirect a key.

### Staff products and a person's decisions

The institutional staff tests use fictional sources and a host-supplied
fixture. The extension package excludes the fixture's implementation.
Ordinary Staff Setup and agent conversations have no fixture provider.
The test results cover the isolated fixture and its exact draft authority.

Staff section teams record each product's steps in a ledger in the project
(`.planning/staff/ledger/products.jsonl`). Every entry is signed with this
device's key and chained to the one before it. This is what is detected, and
what is not:

- **Detected: a line changed, added, removed from the middle or reordered**
  outside SovAI. It breaks the signature or the chain, and the products it
  touches read as tampered.
- **Detected on this computer: the end of the ledger cut off, the file
  deleted, or the file replaced by an older or different copy.** After every
  entry it writes or reads, SovAI keeps a signed record of the ledger head
  (how many entries and the last one's hash) in VS Code's secret storage on
  this computer, outside the project, the way it keeps the label map's last
  checked copy. A ledger shorter than that record, or with another entry at
  its place, reads as tampered, with every product in it, because which
  entries went missing (a HOLD, a decision) cannot be known. A record that
  does not verify is treated the same way.
- **Not detected:** cutting the end off a ledger before this computer saw
  those entries (for example on another computer before you pull), or on a
  computer whose secret storage was cleared, or a ledger read by a build
  without the record. There only the chain is checked. Switching to a git
  branch whose ledger is older than the one this computer saw reads as
  tampered too, by design. **SovAI: Staff: Use This Branch's Ledger** is
  the way back for that case only: it is offered when the ledger is shorter
  than, or different from, the recorded head and its own signatures and chain
  verify; a person names themselves and their role, confirms in a dialog that
  says what changes, and the recorded head moves to this branch's ledger. Who
  did it is a signed entry in `.planning/staff/ledger/decisions.jsonl`. A
  ledger whose chain is broken is refused (Set Aside is its way out), and no
  agent tool can run it.
- **Unreadable is never empty.** A ledger, wargame ledger, event log or
  register that cannot be read whole (over 2 MB, or refused by the disk) is
  reported as unreadable with the reason, nothing is written to it, and no
  write starts on top of it. The ledger's way out, and the way out of any
  tampered ledger, is **SovAI: Staff: Set Aside the Product Ledger**: the old
  file is kept beside itself under a new name, never deleted, and the record
  of the head starts again.

A product file whose header claims a state the ledger does not hold, or an
approved or released product whose text changed, also reads as tampered.

**A decision counts only when a signed entry records it.** Products are
decided only through the product ledger above. A PIR is approved or rejected
only through **SovAI: Staff: Decide a PIR**, which asks the person's name and
role, confirms in a dialog, and appends an entry to
`.planning/staff/ledger/decisions.jsonl`, signed with this device's key and
chained like the ledger. The register is written only after that entry. A
decision block in a register file without a matching entry (same PIR, same
decision, same person, same wording) reads as awaiting a decision, whoever
wrote it; a broken or unverifiable log proves nothing from that point, which
leaves decisions untaken, never taken. The staff event log is a notice board,
never the record of any decision.

**Standing watches run only when a person armed them, and only while a person
attends.** The J2's standing watches live in
`.planning/staff/products/j2/standing-watches.json`, a file members could also
write. A watch is armed, rejected or retired only through the **SovAI:
Staff** watch commands, which ask the person's name and role, confirm in a
dialog and append an entry to `.planning/staff/ledger/decisions.jsonl` signed
with this device's key, over a hash of the watch as the person saw it (what it
matches, whom it alerts, what it may draft and its label). A watch the file
calls armed with no matching entry, or changed since it was armed, reads as
proposed and looks at nothing; a retired one stays retired whatever the file
says. Pausing, resuming and acknowledging also need the person this device's
key signs for. Members granted the watch tools (`mcp__observations__watch_*`:
the J2 watch officer, warning analyst and threat or IPB analyst, and no one
else) can propose a watch, list them, draft for a match and report drafts
ready; no tool arms, pauses, resumes, acknowledges, retires, approves or
releases. The watch tools write files, so only their own grant
(`mcp__observations__watch_*`, or a watch tool by its name) gives them: a
tools line that grants the whole observations server (`mcp:observations` or
`mcp__observations__*`), written by hand or not, gets the read tools and is
refused every watch tool. A watch may only draft and alert a named person: an output that
would release, approve or task collection is refused when the watch is read.
Watches are evaluated only while a person's staff run or the Staff Room is
open in this window (owner decision: attended runs only until run contracts
exist), the watch tools are declared for interactive runs only, and nothing
evaluates them in the background. A watch sees only observations at its own
label or Public, and its drafts carry its label. An INTREP draft is written as
a new product file only (never over an existing one), says that it is a draft
for the named person, copies no free text from the feeds, and enters the
product ledger as the member's draft; the tradecraft gate, the release-guard
and a person's decision follow as for any product. Every write to the watch
register is a compare-and-swap like the other staff files below, and a
register with one watch that does not read refuses every change rather than
dropping it. `watch_list` returns its text fenced as untrusted.

**SovAI never overwrites bytes it did not read.** Members write project
files with Write and Edit, which take no lock, so every write SovAI makes to
a file a member can also write (product headers, register rewrites, the J2
registers, gate reports, the generated PIR register product, the staff setup's
project files and their rollback) is a compare-and-swap: it reads the file,
builds the new text from those bytes, and renames it into place only if the
file still holds exactly those bytes, checked again immediately before the
rename. Otherwise nothing is written: the member's write stands and reads as
the next edit. The window left is the rename itself. A register write that the
ledger refuses puts the register file back as it was, under the same check.
The J2 PIR register has one source,
`.planning/staff/products/j2/pir-register.json`: the PIR register product is
generated from it (`pir_publish`), a differing product cannot be registered,
and the tradecraft lint reads the register itself. The staff register tools
keep no second PIR schema: reading `pir-register` returns that JSON register
with its decisions checked, and writing or proposing PIR rows there is
refused. Reading any register is its own read-only tool
(`mcp__staff-products__register_read`), so a read never asks for a write
approval. **Decide a PIR** says why the PIR register cannot be read when it
cannot, rather than saying no PIR is waiting.

Approve, reject, release and withdraw-after-a-decision exist only as VS Code
commands a person runs and confirms in a dialog. No agent tool offers them,
and the state machine refuses them from any agent whatever calls it. A
person's decision names them and their role and is signed with this device's
key. Until verified credentials arrive, that name and role are self-declared.

A project moves from planning to execution only when a person approves the
transition brief (`transition-brief`); the phase is read from the signed
ledger, so no agent can start execution, and from then on the J3 members, not
the planners, write the synchronization matrix, the DST and DSM and the
assessment plan. A product the J5 made in planning stays in the J5 folder the
ledger recorded; after the approval the J3 writer writes it there, the J5 is
refused and proposes instead, and status names the new writer and the
approval that moved it. A version still open under the J5 at that point is
withdrawn by a person (or by its J5 owner) before the J3 writes the next one.
The Staff Room panel only reads: the ledger, the event log, the files
under `.planning/staff/` and the observation store. Its page gets display data
only, through `textContent`, under the COP map's content security policy (see
"COP map" below): no inline script, no `'unsafe-eval'`, no `'unsafe-inline'`
and no remote source. The panel may load files only from its own folder, the
shared stylesheet, `media/staff/` (the map component), `media/vendor/` (the
vendored map libraries), `media/map/` (the globe's bundled world tiles) and
`resources/staff/env/` (the bundled environment packs and their tiles). The COP picture it sends holds only the observations
the person's clearance covers: the rows come from the store's reader view,
which drops every row the gate's own check does not cover before anything is
built from them, and with no gate in the window no observation is read. Every
message from the page is checked for its type, exact keys (a message with a
key added or left out is refused) and the form of each value. A decision button sends only the product and the version hash the
person saw; the extension then runs the same person-only command, which asks
who they are, confirms in a dialog and signs, and refuses a product that
changed. The event log is not signed, so the room shows a person's decision,
and names a person on a section, only when the signed ledger holds it; a
decision in the log that the ledger does not hold is shown as not counted.

The tools record what they do inside the project only and send nothing out.
They declare every project file they read (the staff folder, the project's
staff settings in `.planning/.near-ai/project.json` and the guard settings in
`.planning/.near-ai/staff-guard.json`) and write only in `.planning/staff/`,
so the gate's label checks see all of them.
guard-scan's checks are deterministic text rules: they catch markings,
coordinates, listed names and the other patterns they know, and nothing else.
The release-guard reviews what rules cannot judge, and a person decides.
The exercise box lives in `.planning/.near-ai/staff-guard.json`, which an agent
must ask before changing; the real-entity list can also be in
`.planning/staff/real-entities.txt`, which an agent can write like any project
file, so review changes to it. guard-scan and the scenario import read the same
list from both files, so a name in either is held in products and refused in
scenarios. Staff templates are for exercise and fictional
data only: labels are not accreditation.

Coordinates marked as positions (a hemisphere letter, a minus sign, a degree
sign, degrees and minutes, or a GeoJSON pair) are always held when no exercise
box is set or when they fall outside it. Two plain decimal numbers such as
"45.42, 75.69" look the same as prices, scores and measures, so guard-scan
treats them as a possible position only when a word before them presents them
as one (lat, lon, grid, position, located, at, rally point and the like), or
when the pair is alone on its line (a list of points), and no money, score or
unit word sits beside them; such a pair outside the exercise box goes to the
release guard to check. This is a deliberate trade-off: a plain pair inside a
sentence with no such word (for example "Then 45.42, 75.69 for the night") is
not flagged at all, so the rules alone do not catch a position written that
way. The release guard's own review and the person who releases
the product are the check for it.

In a J4 logistics team, guard-scan holds any number that has no calculator
record on its line (`calc:<id>`), or a `calc:<id>` the calculator did not
write. Every record the logistics server writes to
`.planning/staff/calculator/<id>.json` is entered in the calculator ledger,
`.planning/staff/ledger/calculator.jsonl`: one entry per record holding the
SHA-256 of the record file, signed with this device's key and chained to the
entry before it, like the product ledger. A record counts only when its file
matches a trusted entry. A file a member wrote by hand has no entry, and a
record changed after the calculator wrote it no longer matches its hash, so
guard-scan holds a product that cites either one and says which. An agent
never holds the key, so it cannot add an entry that verifies; a removed,
reordered or forged entry breaks the chain, and no record after it is
trusted. Records never change: a revised calculation is a new record.

The calculator takes no rate from an agent. Rates are planning factors a person
enters in `.planning/.near-ai/staff-factors.json`, which an agent must ask
before changing, and every result shows its formula with each factor and who
entered it. The extension ships no planning factor tables. Readiness data comes
only from a CSV file a person puts in the project, and each import records the
file's name and hash. Movement tables are notional, and a table naming a real
deployment database is refused. Road routing runs on a road graph in the
project (`.planning/staff/logistics/roads.json`); no route request leaves the
machine, and no logistics tool declares a network effect.

The LOGSTAT analyst has no file tools at all, so it can flag a report but
never change one: its validation tool writes only the validation log and its
product, and every consolidation checks the plausibility rules again rather
than trusting the log.

The orders server (`mcp:orders`) builds an order or plan only from staff
products a person released, and only when each product file still holds the
exact version the ledger records as released. It writes the result, and every
FRAGO it drafts, as a draft product of the calling member in
`.planning/staff/products/<section>/`, over only the bytes it read, and
registers it through the same propose step as any product, so the release
guard checks it and only a person approves and releases it. It takes annex
letters from the doctrine profile, never from the caller. The battle-rhythm
server (`mcp:battle-rhythm`) writes the calendar through the register tool, so
only its one writer changes it, writes an `.ics` file only under
`.planning/staff/exports/`, and reads an `.ics` file only from inside the
project. That file is treated as untrusted: at most 256 KB, refused whole when
a line is not a well-formed iCalendar line, has control characters or BEGIN
and END that do not nest, each event checked against the register's columns,
and its text returned to the model fenced as untrusted data. Neither server
reaches the network, and neither has an approve, release, issue or send verb.

### Exercise scenarios for staff teams

**SovAI: Load Staff Exercise Scenario** reads the starter scenario shipped
with the extension, or a scenario file you pick, and writes it into
`.planning/staff/scenario/`. Before anything is written, the whole file is
read strictly: it must be at most 512 KB of JSON in the staff scenario format,
marked `fictional: true` with an UNCLASSIFIED and EXERCISE marking, with no
unknown fields and every reference resolved. A scenario is refused if any of
its text carries a classification or caveat marking (for example SECRET,
CONFIDENTIAL, NATO RESTRICTED, PROTECTED B, CUI, NOFORN, EYES ONLY or REL TO),
names an entry on the project's real-entity list (`.planning/staff/real-entities.txt`
or the guard settings), or
carries coordinates on a fictional grid or outside a declared exercise box. A
refused file writes nothing. An earlier scenario is moved to
`.planning/staff/archive/<time>/`, never deleted, and nothing is written when
a folder on the way is a symbolic link. These checks keep the inputs clean;
they are not an accreditation, and real operational material belongs on
accredited systems.

**The exercise feed simulation** (**SovAI: Staff: Start the Exercise Feed
Simulation**) opens two Cursor on Target streams and one AIS stream over TCP,
and one HTTP server for the RSS outlets and the mock partner MCP server, all
bound to 127.0.0.1 and nothing else. It opens no outbound connection and no
UDP or multicast socket, and transmits on no radio. The HTTP server answers
only requests addressed to this machine's own names and refuses requests from
a web page of any other origin, so a browser page cannot read it by DNS
rebinding. Request bodies are capped and a client that falls behind is
dropped. Every message is fictional and marked SIM; ship radio ids come from
a range below the lowest that the ITU allocates, and RSS links point at the
reserved `.invalid` domain. The partner reports are labelled, marked
simulated and routed local-only, and a person must add the mock partner
server before any team can call it. Stopping the simulation, or closing the
window, closes every server. With a project folder open, the simulation also takes its own CoT, AIS and
RSS reports straight into that project's observation store (in the extension,
not over the network), stamped with each simulated feed's label and marked
simulated, and records the feeds' state changes in the staff event log. The
person who started the simulation is recorded as the person who approved its
feeds. The partner feed is never taken in this way. Stopping the simulation
pauses its feeds in the store.

**Feed file import** (**SovAI: Staff: Import Feed File...**) is run by a
person only: no agent tool runs a VS Code command, and a new import feed must
be approved by the named person who confirms the import. The chosen file is
never parsed in the extension host. The extension starts a separate Node
process for it with a 256 MB heap limit, an environment that holds nothing
but the switch that makes the editor's runtime act as Node (no tokens, keys
or proxy settings), no standard input or output, and a 20 second limit after
which the process is killed. Files over 16 MB are refused before any process
starts, and text that is not UTF-8 is refused. The parser opens no network
connection, writes no file and returns only plain records, which the extension
checks again one by one. XML (CoT, KML, RSS, Atom) is read by the extension's
own small reader, not a third-party parser: a document type declaration is
refused outright, only the five predefined XML entities and character
references are read, nothing external is ever resolved, and nesting depth,
element and attribute counts and value lengths are capped. This choice
follows the entity expansion flaws found in popular JavaScript XML parsers in
2026. AIS sentences are accepted only with a correct NMEA checksum. Every
imported report is placed inside the scenario's exercise frame or held back
(with no frame loaded, everything with a position is held), is stamped with a
label inside the staff template ceiling (never below its feed's), is never
marked simulated, and enters the observation store through its one append
path, which checks the label and stamp again. No dependency was added.

### COP map

The `cop-map` server (`mcp:cop-map`) is built in and runs inside the
extension; it declares only the staff files it reads and writes and names no
host. Each COP product layer (operations, threat, terrain, logistics, plans)
has exactly one writer, from the staff ownership table, resolved for the
team's roster so a member that stands in for a folded job writes it. Anyone
else's features are written to `.planning/staff/proposals/<layer>/` for the
writer to merge, and the staff products host checks the writer again when the
new version is recorded; a version the host refuses puts the layer file back
exactly as it was. Feed layers are views over observations: no tool writes a
feature into one. Hostile, suspect, neutral and unknown symbols (the J2's
assessment) go on the threat layer only, every position must lie inside the
scenario's exercise frame over empty ocean, every feature carries an exercise
label, and a layer's label is the join of its features' labels. What one
member wrote is shown to another agent fenced as untrusted data.

Every read tool of the built-in staff servers (staff-products, guard-scan, the
intel workbench, cop-map, logistics, orders and battle-rhythm) returns its whole answer inside an
`<untrusted-content>` block with a random id, with injection attempts flagged,
the same fence web pages and MCP results get: products, registers, LOGSTATs,
planning factors, layers and proposals are text a unit, a person or another
member wrote. A write tool that also returns stored text (the wargame ledger,
LOGSTAT validation findings, an `.ics` import) fences that part. The
observations server fences its rows itself, and its `watch_list` its text. A test calls every read tool of every staff server and
checks the fence.

The map page draws the scenario's synthetic geography and requests no map
tile, glyph, sprite or font from any server: an outside tile request would
reveal the area of interest. Its only requests are the vendored files under
`media/vendor/`, the map worker (started from a blob) and the bundled map
tiles and land cover under `media/map/` and `resources/staff/env/`, all served
by VS Code from the extension's own folder. The policy is unchanged:
`img-src` and `connect-src` already name only the extension. Before the page
gets any tile address, the host (`src/staff/mapTiles.ts`) checks the folder's
`index.json` against the hash its record holds (`media/map/globe/DATA.json`,
or the pack manifest), then every tile it lists: a regular file, at most
512 KB, the size the index records, the PNG or WebP magic bytes its format
claims, and its SHA-256. Tile paths are plain `z/x/y` numbers inside their
set's zoom range and bounds, so an index cannot point outside its folder. One
problem leaves that folder's tiles out, and the map says why and draws
without them; organization tile servers stay off. The images are decoded by
Chromium's own decoders inside the webview's renderer sandbox. Spike result (2026-11-18): MapLibre GL
JS 6.16.0 runs under the page policy `default-src 'none'; script-src
'nonce-…'; style-src <extension>; img-src <extension> data: blob:; font-src
<extension>; worker-src blob:; connect-src <extension>` with no
`'unsafe-eval'`, no `'unsafe-inline'` and no new script source: the nonced
page script imports the vendored module, fetches the vendored worker from the
extension and starts it from a blob URL. Checked with
`scripts/spike-cop-map-csp.mjs` in headless Chromium with the page and the
resources on two loopback origins, as in a webview: no policy violation, the
globe and the 2D map both render, and 2,000 moving tracks at 10 updates a
second kept 60 frames a second with no long task (5,000 doubled the slowest
frames, so the map draws at most 2,000 tracks and says how many it left out).
Without WebGL, or if the library cannot start, the page falls back to a 2D
SVG map behind the same interface and says why.

The Staff Room embeds this component in the J2 workspace and the war room
through the same interface, under the same policy, and keeps its own SVG map
as the fallback, with the reason on the map. Checked on 2026-11-18 with
`scripts/spike-cop-map-csp.mjs <chrome> --room`, which loads the Staff Room
page exactly as the panel writes it: no policy violation, MapLibre running,
and the only requests the page's own files, the vendored files and the worker
blob. With `--no-webgl` the room shows its SVG map and the line "2D map:
WebGL is not available in this window.", and no two of its 44 name labels
overlap as the browser measures them. Map names are drawn by MapLibre from
the system's own font, so no glyph is fetched.

### Environment packs

The COP map's terrain and weather (hillshade, contours, coastline, forecast)
come only from environment packs on disk (`docs/staff-env-packs.md`), never
from a tile, raster or forecast server, so drawing them reveals no area of
interest. The extension reads only the four file names of the format, each a
regular file of at most 8 MB, checks every file's size and SHA-256 against the
manifest before parsing it, and refuses a pack with any coordinate outside its
bounding box or, when drawn in a scenario, outside the exercise frame. A
real-data pack must carry its attribution and every source's licence. The
contours and hillshade are computed on the host and sent to the page as
GeoJSON inside the picture, so the page's policy is unchanged and the page
makes no request for them. The bundled IRON LANTERN pack is synthetic, made
from a seed, and a test makes it again and compares the bytes. Pack version 2
adds `landcover.geojson` (checked like the other files) and a `tiles/` folder
of photo-like imagery and Terrarium height tiles with its own hashed index
(checked as described under "COP map"); a test compares the folder with its
index file by file and draws a sample of tiles again from the seed, pixel for
pixel. Version 1 packs stay valid, and a version 1 manifest may not name land
cover or tiles.

The globe's world tiles in `media/map/globe/` are third-party data made once
on a developer machine (`scripts/build-globe-tiles.mjs`, which refuses a source
image whose SHA-256 is not the one given): NASA Blue Marble Next Generation
(NASA content is generally not subject to copyright in the United States;
credit "NASA Earth Observatory"; no NASA logo or wording that implies NASA
endorsement is used) and Natural Earth's cross-blended hypsometric raster
(public domain). `media/map/globe/DATA.json` records each source's address,
SHA-256, terms, credit and build parameters; the map shows the credit of the
base on show, and the SBOM lists both as data components. The tile builders'
encoders (`@jsquash/webp`, `@jsquash/jpeg`, Apache-2.0, WebAssembly) are
build-time devDependencies only and never ship.

`scripts/build-env-pack.mjs` turns real elevation and forecast files into a
pack on a developer machine. It refuses to run when `CI` is set or GDAL is not
installed, runs only the GDAL command-line tools (`gdalinfo`, `gdalwarp`,
`gdal_translate`, `gdal_contour`) without a shell on the files named on its
command line, makes no network request of its own, writes only into a new or
empty output folder, and validates the result before writing it. It never
runs in the extension or in CI, and GRIB2, NetCDF and GeoTIFF decoding stays
in GDAL, outside the extension. No agent tool reads or writes packs.

## The outbound check

Every chat message passes one check before it leaves VS Code, in this order:

1. **Emergency stop.** `SovAI: Emergency Stop` blocks all requests and stops
   anything running until `SovAI: Resume`. The state survives reloads.
2. **Daily spend limit.** With `nearAi.dailySpendLimitUsd` set, requests stop
   once today's recorded spend reaches the limit.
3. **TEE-only mode.** The outbound check no longer decides where a request
   goes. With `nearAi.privacyMode` at `tee-only` it asks the same route check
   every request passes whether the model is allowed, so the chat can say so
   before anything is sent, and the route check decides again when the
   request is sent. A model NEAR forwards to another provider is refused by it.
4. **Privacy check on the new message.** What looks like a credential (API key,
   token, password, private key) or a private-file path is blocked; what looks
   like personal data asks for confirmation. A blocked message can be sent once
   with an explicit override that is bound to that exact message and expires
   after a minute.

The outbound check keeps its own checks for credentials, personal data and
private-file paths; where a request may go is the route check's alone (see
[Classification labels and routing](#classification-labels-and-routing)).

Earlier turns of a conversation are not re-checked; each was checked when it
was sent. Since 0.4.27 Team Studio's model calls (drafting a team with AI, and
Improve with AI) pass the same check; before, drafting a team called the model
directly. Since 0.4.30 so does a team icon made with **Generate with AI…**,
checked before you are asked about its cost and again before it is made. In Team Studio a message the privacy check would ask about is not
sent: there is no override, and you are told what to remove. The check does not
yet cover Open-GSD workflows (see the table above).

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
- **No escrow.** SovAI, its authors, NEAR AI, your git host and anyone with read access to the
  repository cannot decrypt the state, and nobody can recover a lost recovery code. A computer
  that is still unlocked can show a new one.
- **Anonymous commits.** Sync writes its commits with git plumbing into a private mirror, with the
  author and committer `near-ai-state <state@near-ai.invalid>`, a constant date and the message
  "Update encrypted project state". Sync never changes your git configuration and never uses your
  name or email. Git still reads your global git settings and this project's remote address, as any
  git command would. Hooks, signing, helper transports, fsmonitor and the inherited git environment
  are switched off for sync's calls, and sync's private mirror and hooks folder live in the editor's
  own storage, outside the project. A credential for the remote reaches git only through the child process's environment and is
  never written to a config file or passed as an argument.
- **Automatic syncs never prompt.** A background sync looks up an existing GitHub sign-in silently;
  if there is none it stops with "Sync needs you to sign in. Choose Sync Project Now.".

### What sync trusts in the project folder

Files inside the project folder can arrive with a cloned or downloaded repository, so sync does not
let them decide what it does:

- **The sync switch, the remote and the online-home progress** are kept per editor, not in the
  project folder. Whether sync is on is decided in each editor.
- **Sync's private mirror and hooks folder** live in the editor's own storage, outside the project,
  so a hook or a git setting planted in the project is never run by sync.
- **A key file** is used only when it is your own private file (mode 0600), not tracked by git,
  not a link, and it passes a key check.
- **A state folder that is tracked by git** is not used. Chats still work, but are not saved until
  the folder is taken out of the repository, and nothing is changed.
- **The agent** asks before it writes anything under `.near-ai/` and before it reads the state
  folder, and its checkpoints and Revert touch only the project and the editor's own worktrees.
- **Joining a project on a computer that has chats** waits for running chats and syncs, holds the
  sync lock from the copy to the catch-up, and removes the folder from before the join only when
  everything in it is carried. What could not be carried is kept beside the project's saved state
  and never deleted by the extension.

### Post-quantum reasoning

The sync format uses only symmetric cryptography: AES-256-GCM, HKDF-SHA256 and scrypt over a
generated code. It has no public-key step, so an attacker who stores the ciphertext today and
waits for a quantum computer gains at most Grover's square-root speed-up (AES-256 keeps about
128-bit strength). The recovery code is 256 bits for the same reason: it keeps about 128-bit
strength against Grover before counting scrypt's cost.

**Constraint for later work.** Any public-key step added to sync, such as sharing state between
different people in Team Mode, must use a hybrid key exchange (P-256 plus ML-KEM-768, as shared
staff projects do), so that it does not bring back the harvest-now-decrypt-later weakness the
symmetric design avoids.

### What still leaks

| Leak | Who sees it | Limit |
| --- | --- | --- |
| That the project uses SovAI sync (the branch name and the manifest's shape) | Anyone who can read the repository | Accepted; they carry no project data |
| Total size, to within about 12.5% | Same | Padding; objects over 8 MiB are split |
| Number of objects | Same | Objects are consolidated so the count follows size, not the number of chats |
| Push times and number of commits | Same, and your git host in any case | The commit date is constant, but the host sees the push. Pushes are batched and spaced apart, so the timing shows activity rather than single chats |
| That you pushed from some account or address | Your git host | Not something the extension can control |

On a public repository the ciphertext is public too. The recovery code's 256 bits make a search
against it infeasible. Your project's own code is visible to everyone only if you choose to push it
to a public repository (see below).

### Residual risks

- **A new recovery code does not lock out the old one.** Anyone who has the old code and can read
  the project's repository can still open everything synced, including what is synced from now on,
  because the chats keep the same data key. A new code only changes who can open the project on a
  new computer. Changing the data key is planned. Treat a leaked code as a leak of everything
  synced.
- **A deleted, replaced or rewound sync branch** is rebuilt from what your computers hold. Nothing
  is lost, and an older recovery code is never taken back.
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
repository, a history that could not be checked completely is not pushed at all. SovAI does not
rewrite your history; that stays your decision.

The code push is also available later, as **SovAI: Put This Project's Code Online**, and running
**Give This Project an Online Home** again offers it; both go through exactly the same checks and
the same click on the summary. SovAI writes only the `near-ai/state` branch and, on your choice,
your own current branch, and never forces a push. The only setting of your repository it ever
changes is the default branch: GitHub makes the first branch pushed the default, so while
`near-ai/state` is the only branch it is shown first. After your code is online, SovAI makes
your branch the default branch through the GitHub API with your token, once, and only when the
default is still `near-ai/state`; a default branch you chose is never changed. For a repository an
earlier version set up, the same change is made only after you click to confirm it. On a pasted
address no request is sent to GitHub and the text names the setting for you to change. SovAI's
own account and run records in `.planning/.near-ai/` stay on this computer by default; the control
in the chat bar shows a sync problem as a plain sentence under it and never includes a token or
a password.

## Multi-user staff projects (preview)

Multi-user staff projects, where several people and their agents work on the same staff products
from their own machines, are being built over several releases. What exists in this release is
switched off unless a person turns on the preview setting `nearAi.staff.multiUserPreview` (off by
default). A project that never turns multi-user behaves exactly as before.

### Update size limits and the decode worker

Every change to a staff product's text that arrives from another machine is checked before the
shared text library reads it, because a hostile or damaged change could otherwise make that
library use a lot of memory or crash.

- **Size limits.** One text change may be at most 256 KiB, and a saved state of a whole product or
  a snapshot of it at most 2 MiB. Anything larger is refused before it is read. A long text is
  still fine: it is built from many changes.
- **Counted before it is unpacked.** A quick pass counts the parts of each change without building
  anything from them, and refuses a change with more than 100,000 parts or deleted ranges. It also
  refuses every kind of content except plain text, deleted text and gaps, so embedded objects,
  formatting and nested structures never reach the library.
- **A separate process with its own limits.** Changes from other machines are then read in a
  separate background process, never in the editor's own memory. That process is started with
  its own memory limit (128 MB, plus up to 32 MB for short-lived data, and a 4 MB stack; on
  Windows the stack stays at the default of just under 1 MB) and has a 5 second time limit per
  change. The limits are set on that process's own command line, and the editor's memory
  settings (such as a larger memory limit given to the editor on its command line or in
  `NODE_OPTIONS`) are not passed on to it, so they hold however the editor was started. A process
  that reaches its memory limit is stopped by the JavaScript engine at once; one that passes the
  time limit is ended by the extension, even in the middle of a long step. Either way the change
  is reported as too large, and a new process is started for the next change. Any other failure
  of the process (a crash, or an answer it should not give) reports the change as damaged. A
  refused or crashed check cannot take the editor down with it.
- **The check only reports.** The process reads and answers; it never stores, changes or keeps
  anything. The same counting checks also run inside the extension as a second line, so a change
  is refused the same way on every machine.

### The replica store and rollback detection

The shared history of a multi-user staff project (every signed change from every person and
agent, and the sealed text they carry) is kept on each machine in a replica store inside the
project folder.

- **Where it lives.** The store is the folder `.planning/staff/replica/`: one append-only file per
  writer per product area, sealed attachments named by their hash, signed key grants, signed
  checkpoints and the lists of each device's rollback record (below). Entries and attachments are
  written whole and synced to disk before they count; a line cut short by a crash is never
  counted. The store never deletes an entry or an attachment and never rewrites a line.
- **Git ignores it.** The folder holds its own `.gitignore` that ignores everything in it, so the
  shared history is never committed to your repository by accident. It is carried between
  machines by the sharing service, not by git, so a branch switch cannot roll it back.
- **Two windows at once.** Every write takes a lock in the folder, so two editor windows or two
  processes on one machine never mix or lose each other's lines.
- **Rollback is noticed.** After each write the device records how far it has seen the shared
  history: for each writer's file the newest change, the count of changes and a digest of them in
  order, the changes set aside or waiting for the decode check, and the newest roster change. The
  record has two parts. The editor's secret storage, outside the project, holds only a small
  signed record, which stays a few hundred bytes: the device signs the newest roster change, the
  sizes of the lists and the sha256 of the file that holds them. The lists themselves are in that
  file, in the store folder (`marks/`, named by the sha256 of its bytes, one folder per device),
  and are trusted only when its bytes hash to the signed value and it holds lists of the signed
  sizes. The lists file is bounded, so no other device can grow it until it can no longer be
  written: it keeps at most 1,000 refused changes from one device in each part of the project and
  10,000 in all, and 100,000 waiting for the decode check. Past a device's bound its later changes
  in that part of the project are not kept; the store notes that once, with one line for that
  device, and everyone else's changes are still recorded. A new change that would wait past
  100,000 is not kept this time and is taken when it is delivered again. When the folder is opened again and it holds less than that
  record (restored from an older backup, a file cut short or deleted, a change swapped, moved or
  put in between, or the lists file itself gone), the store is refused with a plain message and
  nothing is changed. A change the device had already read that can no longer be read (a disk
  error, an edited file) is reported as damage, not as an older copy. A signed record whose
  signature does not verify, or whose lists file is edited, unreadable, over 64 MB or a symbolic
  link, is refused the same way and is never trusted, read as empty or silently replaced. The
  record is written after the changes are on disk, so a record that could not be written never
  stops the next write; that write records it. The lists file is written first, then the signed
  record, and the device's older lists files are removed only after the signed record is written,
  so an interruption at any point leaves a record whose lists file is there. The lists file's
  folder is synced to disk before the record names it, so a power cut cannot lose the file the
  record names.
- **Starting again is a person's choice.** A refused store is never reset by itself. **Staff:
  Start This Computer's Shared History Again** asks first and only then moves the store folder
  aside to a folder beside it (`.planning/staff/replica.set-aside-<time>/`, still ignored by git);
  it never deletes it. It carries this device's own signed changes, the signed key grants, the
  sealed attachments and the project record into a new store and starts a new signed record.
  Changes from other people are not carried: they come back with a new welcome file from the staff
  lead (and, in a later version, from the sharing service). A store that opens is left alone.
  A Start Again that is interrupted (the editor closed or the power cut part way) finishes on the
  next open and never starts empty: it writes down what it is doing before it moves anything and
  syncs each step to disk. If the store folder is gone while this device still has its record, it
  is not made again empty: Start Again rebuilds it from the newest folder set aside whose changes
  from this device verify, and the result names that folder.
- **Only this device writes as this device.** A line that names this device as its writer counts
  only when it carries this device's valid signature. Any other such line is damage, so a planted
  line can never become this device's newest change or block its next one.
- **No private keys in the folder.** The store holds only sealed entries, sealed attachments,
  signed grants and checkpoints, and the lists of the rollback record (hashes, counts and the
  reasons changes were set aside). No private key, epoch key or join secret is ever written to it;
  the device key stays in the editor's secret storage.
- **Changes from other machines are checked first.** A change that arrives from another machine is
  checked by the decode worker (above) before the shared view is built from it. A change the check
  refuses is still kept in the store, set aside with the reason, and left out of the shared view.
  It is never silently dropped, so a person can see what was set aside and why. The list of what
  was set aside is covered by the device's signed record: it is in the lists file whose hash the
  record signs, so deleting or editing that file refuses the store, and no file in the project can
  let a refused change in. A change the check cannot run on yet, because its key or its attachment
  has not arrived, waits outside the shared view and is checked when they arrive; so does a change
  found in the folder that no check has passed (copied in by hand, or written by another install
  of the extension). The project's member list is still read from a change that waits for its
  key, because that key comes only from the grants the member list places; reading the member
  list decodes no document update.
- **Symbolic links are refused.** If any folder or file on the way to the store is a symbolic
  link, nothing is read or written through it.

### Cell keys, wraps and rekey

A multi-user project is split into label cells. The base cell carries only the roster (who is
in the project, their devices, roles and declared clearances) and entries about the project as a
whole. Every member holds it, and so will your organization's sync hub once one is connected.
Every product is in the cell for its label, `org/Public` included, so the base cell never holds
product text. Everything in a cell (its products, their text, versions and decisions) is sealed
under that cell's key, so only the devices cleared for the cell can read it.

- **One key per cell per epoch.** Each cell has its own key, 32 random bytes, and a cell gets a
  new key (a new epoch) whenever someone must stop receiving it. Old keys are kept so old entries
  stay readable.
- **A key is wrapped to each cleared device.** Every device has an encryption key pair besides
  its signing key; the device signs its encryption key so it cannot be swapped. To give a device a
  cell key, the lead's machine makes a fresh key pair, agrees a shared secret with the device's
  public key (X25519 in the first format; new work uses the hybrid in the next subsection), derives
  a wrapping key from it with HKDF-SHA256 bound to the cell, the epoch and the receiving device,
  and seals the cell key with AES-256-GCM. A wrap copied to another device, cell or epoch does not
  open.
- **Grants are signed and sent only to that cell's devices.** The wraps for one cell and epoch
  travel together in a grant signed by the staff lead (or the deputy, once named). The roster
  entry that creates the cell or gives it a new key records the hash of the grant, so a changed
  or substituted grant is refused. A grant is accepted only when its signer could change the
  roster at the roster it names and every device it wraps to was admitted there. Grants are files
  outside the shared history and are given only to the devices on that cell: a member never
  receives the grant of a cell they are not cleared for, and so cannot even see who is on it.
- **The cell's label is sealed inside the grant.** The level and compartments of a cell are
  sealed under a key derived from the cell key, so a device below the cell learns only that an
  unnamed cell exists, not what it is or what is in it.
- **A completed rotation limits access to new work.** After a verified rotation, an affected
  cell has a new key wrapped to devices that still have access. A device that lost access keeps
  what it received under the old key. This computer pauses ordinary writes when it verifies
  that a revoked device received the current key. Roster recovery remains available. A
  computer can still write under an old key while it is waiting for an earlier grant that
  would show the revoked device held it (G552), or while rotation after a clearance reduction
  is pending (G551).
- **New devices can read the history of their cells.** A device admitted later receives wraps
  for the earlier epochs of the cells it is cleared for, so the history of those cells stays
  readable on it.
- **Write up, never down.** An entry in a higher cell may cite entries in a lower cell. An entry
  in a lower cell that cites a higher cell is refused when the project's cell order is known, and
  listed with the reason, so nothing from a higher cell leaks into a lower one through a citation.
- **Who is cleared is decided when a grant is written.** Clearance checks need the current date
  and the label scales, so they run on the lead's machine when a grant or a new key is written.
  The shared history then relies on the signed grant: it never decides clearance itself.

### How cell keys are wrapped

New shared work, and every project its lead switches to post-quantum keys, wraps each cell key with a hybrid of P-256 and ML-KEM-768, joined by HKDF-SHA256 and sealed with AES-256-GCM. An attacker who records shared work today
must break both halves to open it later, so a future quantum computer that breaks P-256 alone
gains nothing. Both halves and the key derivation are listed in CCCS ITSP.40.111 for Unclassified,
Protected A and Protected B information.

- **The wrap.** A fresh P-256 key agrees a secret with the device's P-256 key, and ML-KEM-768
  gives a second secret. HKDF-SHA256 joins them, the P-256 secret first, bound to both ciphertexts,
  the cell, the epoch, the receiving device and both of its keys. The cell key is sealed with
  AES-256-GCM. A wrap is 1,214 bytes, so a grant for many devices is split into signed pages, all
  committed by the one hash the roster holds.
- **The device's keys.** Each computer, hosted person and hub signs its P-256 and ML-KEM-768 keys
  with its own signing key, and the six safety words cover them when a join request carries them.
  The private parts are kept only as seeds: in this computer's secret storage, in the hosted
  person's key envelope sealed by your organization's key service, or in the hub's key file.
- **The switch.** A project that requires post-quantum keys refuses any new X25519 wrap, on every
  member's computer and on your organization's server alike. Keys given before the switch keep their older X25519 wraps and stay readable. Each part of the
  project moves to the new wrap at its next new key. A computer that cannot make the new wrap is
  told to update; it never falls back to the older one, and a computer that has not published its
  keys yet is given the key later.
- **Protected B.** Protected B work is never wrapped the older way, so a project must switch before it shares Protected B work.
- **Reserved.** ML-KEM-1024 with P-384 is reserved for Protected C and classified work, pending the Cyber Centre's advice.
- **Signatures.** Signatures stay Ed25519. A later change to post-quantum signatures is its own decision.

### Labelled products in shared projects

A shared staff project keeps each product in a part of the project (a label cell) for its label,
so a person's computer holds only the products their declared clearance covers.

- **Each product lives in the part for its label.** A part is made the first time a label is
  used, and its key goes only to the devices whose member's declared clearance covers the label.
  No hub is given a part for a label unless the staff lead grants it.
- **The base part carries only the roster.** The part every member holds names the people, their
  devices, roles and declared clearances, and nothing else. A sync hub given that part, as your
  organization's hub will be, never reads product text.
- **`org/Internal` is the default label.** A product made without a label is `org/Internal`. A
  product keeps its label for its whole life; to give it another label, make a new product with
  that label.
- **Write up, never down, for pins.** A version may pin only products at its own label or below.
  The computer writing the version refuses a pin above it before anything is written, and every
  computer that reads the project refuses it too.
- **The lead makes a part only for a label they are declared cleared for.** A staff lead whose
  declared clearance does not cover a label is told: "You are not declared cleared for that
  label, so this computer cannot hold that part of the project. Ask the staff lead to declare a
  clearance that covers it, or keep this project on one machine." With no declared clearance,
  only `org/Public` parts can be made.
- **The old ledgers stay whole in a part only the staff lead holds.** Making a project
  multi-user keeps the old product ledger and decision log, unchanged, in a legacy part that only
  the staff lead holds, and a deputy declared cleared for every label in them. Each label's part
  gets only its own products' ledger lines. The calculator and wargame ledgers go to the
  `org/Internal` part.
- **Projects shared with 0.4.35 keep working, but cannot connect to a hub.** Their products stay
  in the part every member holds, and they keep working as before. They cannot be connected to a
  sync hub, because the hub must hold every key of that part, and so could read those products.
  The way forward: "This project was made shared by an earlier preview, and its products sit in
  the part of the project the hub must read. Make a single-machine copy and make that copy
  multi-user again; the new shared project keeps each product in its own part."
- **A member below a part never receives it.** A member whose declared clearance does not cover
  a part never receives its key, its grants, its history or its attachments, and cannot tell
  whether a product is in it. Entries of that part handed to their computer by mistake stay
  sealed and wait, unread. The single-machine copy carries only the parts this computer holds,
  and says "Parts of this project you are not cleared for were not copied."
- **Product files in your folder hold what this computer holds.** The product files a shared
  project writes in your project folder hold the text of every part this computer holds. Do not
  commit them to a repository that people who are not cleared for those parts can read.

### Device encryption keys and the key ring

Each machine in a multi-user staff project has two keys of its own: the signing key it already
uses for Team Mode and for signing staff records, and an encryption key that cell keys are wrapped
to. Both stay on the machine.

- **One encryption key per person per install.** The encryption key is an X25519 key pair made with
  Node's built-in crypto the first time it is needed. Its private half is kept in the editor's
  secret storage next to the signing key, under `nearAi.identity.encryptionKey`. It is made inside
  the same lock as the signing key and read back before it is used, so two editor windows opening
  at once never make two keys. A stored key is never replaced or deleted by the extension.
- **Bound to the device by a signature.** The device signs its encryption public key together with
  its writer id. The roster entry that admits or adds the device carries that signature, and the
  roster checks it, so nobody can swap in another encryption key for the device without the
  signature failing.
- **Only the roster decides which key a cell uses.** A device takes a cell key only from a grant
  the shared roster has accepted (signed by a device that could change the roster, for a key epoch
  the roster has started, or the exact grant the roster recorded by hash), or a key it made itself
  for a grant the roster then recorded. A grant from anyone else, or for a key epoch that has not
  started yet, is kept on disk but never opened into the key ring, so it cannot choose the key this
  device writes with. If a new key could not be recorded, the next one is made for the same epoch
  and only the recorded one is used. While a device catches up on the roster, it may try the keys
  of other grants addressed to it to read the roster's own entries signed by the lead or the
  deputy, but it never writes with such a key or keeps it.
- **Opened cell keys are cached in secret storage only.** The device opens its wrap with the
  private encryption key and keeps the cell key in memory and in secret storage (one value per
  project, `nearAi.staff.epochKeys.<project>`), together with the keys it made for new cells and
  new key epochs. If that cached value is lost, nothing in a grant is lost with it: the grants on
  disk are encrypted to this device, so the keys are opened again from them.
- **The project is pinned outside the project folder.** When a device creates or joins a shared
  project, it records which project that is (the hash of its first signed entry, and the staff
  lead's public keys) in the extension's own storage, the way Team Mode keeps its trust record.
  The copy in `.planning/staff/replica/project.json` is only a convenience: a copy that names
  another project is refused, and opening a folder never records a new project by itself.
- **Join secrets are kept only until they are used.** The secret in an invitation is kept in
  secret storage under the invitation's id until the roster records what happened to the
  invitation (the person was admitted, or the invitation was withdrawn). It is the only secret the
  extension ever deletes.
- **Never in the project folder, a log or a file.** Private keys, opened cell keys and join secrets
  are never written to the project folder, to a log or output channel, to an error message or to
  any other file. A test scans every file in the project folder and in the extension's storage
  after a project is made and used, and fails if it finds any of them.

### Invitations, join secrets and the safety code

People join a multi-user staff project by exchanging three small files and comparing six words.
Nothing is posted anywhere: the files go from person to person any way they like (email, chat, a
USB stick), and there is no server to trust.

- **Invitations are signed files.** A computer of the staff lead or the deputy lead writes a
  `.near-staff-invite` file signed with its device key. It names the project (the hash of its first
  signed entry and the founding lead's public keys), the inviting computer's public keys, the
  invitation id, when it expires (7 days unless the lead chooses otherwise), and a one-time join
  secret of 32 random bytes. The joining computer checks the signature and the expiry before it
  uses anything in the file.
- **Opening an invitation ties this computer to nothing yet.** The joining computer keeps the
  project and the inviting computer named in the invitation in the editor's storage, outside the
  project folder. It pins the project only when the welcome file arrives and the roster in it,
  read from the project's first signed entry, shows that this computer was admitted through that
  invitation, and that the invitation was written by the inviting computer while it belonged to
  the staff lead or the deputy lead. Anything else is refused and nothing is kept, so a fake
  invitation cannot block the real one.
- **Each invitation works once, expires, and can be cancelled.** The roster records the
  invitation when it is made, and records when it is used or cancelled. A join request for an
  invitation that has expired, was already used or was cancelled is refused with a plain message,
  and so is one made with a different secret. An invitation for a person's other computer can be
  answered only by that person's own computer.
- **The join secret stays on the lead's computer.** The secret is kept in the editor's secret
  storage until the roster records what happened to the invitation (used or cancelled), and is
  then deleted. It is the only secret the extension ever deletes. The shared record holds only its
  SHA-256 hash. If a welcome file is lost, the lead makes it again from the same join request
  without the secret: the person is already in the roster, and the welcome file works only on
  their computer. Expired invitations stay listed until the lead cancels them, which deletes their
  secrets too.
- **The joining computer proves it holds the secret without sending it.** The `.near-staff-join`
  file carries the joining device's public keys, signed by that device, and an HMAC-SHA256 of
  them under the join secret. The secret itself is never in the join request.
- **The six words catch a swapped key.** Anyone who gets hold of an invitation file can make a
  join request that passes the secret check, so both screens show six words worked out from the
  invitation, the founding lead's keys, the inviting computer's keys, the joining device's keys and
  a random value the joining computer draws after it has read the invitation. Because that value
  comes after the invitation is fixed, someone who controls the files in both directions cannot
  prepare two matching sets of words in advance: they have to match one fixed set, about 2^66
  tries. The lead admits the person only after confirming that the words match, out loud or in
  person. Admit is refused unless the lead confirms; nothing confirms it for them.
- **What the person receives is limited to what they are cleared for.** On admission the lead's
  computer gives the new device the keys, with their earlier epochs, of only the cells the
  person's declared clearance dominates, and returns a `.near-staff-welcome` file for that device
  alone. The welcome file holds the signed roster and grants wrapped to that one device, and no
  secret or key in readable form.
- **Only the lead or the deputy changes who is in the project.** Inviting, admitting, removing a
  person or a device, changing a clearance, naming the deputy and handing over the lead are roster
  changes, and the roster accepts them only from a device of the staff lead or the deputy lead.
  A join request is admitted on the computer that made its invitation, where its join secret is
  kept. Removing someone or lowering their clearance moves the affected cells to new keys. Which
  cells still need a new key is worked out from the roster, so if that is interrupted, the next
  removal, change or admission finishes it first, and Remove from Staff Project offers to finish
  it.
- **People and clearances are declared, not verified.** Until verified credentials arrive, every
  multi-user result says: "People and clearances in this project are declared by the staff lead,
  not verified." The six words check that the right device joined; they do not check who the
  person is or what clearance they really hold.

### People and clearances are declared by the staff lead

Verified credentials arrive in a later release. Until then, a shared staff project knows people
only by what the staff lead says about them.

- **Declared, not checked.** The name, seat, roles and clearance of each person in a shared
  project are what the staff lead (or the deputy lead) declares when inviting or changing them.
  SovAI does not check who a person is or what clearance they really hold. The six words check
  only that the device that joined is the one the person used.
- **Every screen says so.** Every multi-user confirmation and result shows three notices: that a
  clearance is self-declared and not an enforced boundary, that labels and routing help prevent
  mistakes but are not accreditation, and "People and clearances in this project are declared by
  the staff lead, not verified."
- **Labels are not accreditation.** A part of the project with a higher label is sealed under its
  own key and given only to the devices whose declared clearance covers it. That helps prevent
  mistakes; it does not make any computer accredited for classified information, and a declared
  clearance can be wrong.
- **Labelled products get a part of their own.** Making a project multi-user puts each product
  in a part of the project for its label, given only to the devices whose declared clearance
  covers that label. See "Labelled products in shared projects" above for who receives what.
- **Off unless you turn it on.** Everything multi-user is a preview, off unless a person turns on
  `nearAi.staff.multiUserPreview` in their own settings. The setting applies to the whole editor,
  so a project folder cannot turn it on for you. While it is off, the multi-user commands are
  hidden from the Command Palette, a command run anyway only says how to turn it on, no
  multi-user code is loaded, and no file, folder or secret is made.
- **Only a person runs these steps.** Making a project multi-user, inviting, joining, admitting,
  removing, adding a computer, choosing a roster branch, naming the deputy, handing over the lead,
  changing a member and making a single-machine copy are commands a person runs, each change
  behind a confirmation. No agent tool runs a command, and none of them is a decision the Staff
  Room's buttons can run. A person is admitted only after the lead picks "The six words match".
- **The invitation stays out of the project.** An invitation holds a one-time secret, so the
  command does not save it inside the project folder, where git could commit it, and saves every
  invitation, join request and welcome file readable by your own user account only.
- **The single-machine copy is honest about what it carries.** Steps other people took in the
  shared project are carried under the name and key of the person who makes the copy, written
  like "A. Person (approved in the shared project, carried by B. Person)". A decision people made
  at the same time is left open. The result lists what is not copied (registers, calculator
  records, gate reports, proposals, settings, observations and the staff event log), and the
  shared project is not changed.

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
| Yjs (`yjs`, with `lib0`) | 13.6.33 (lib0 0.2.119) | MIT | Shared product text in the replica core (not used by the extension yet) |

Yjs and lib0 are the first third-party code inside the signed replica core
(`src/domain/replica/`), the pure code that later staff collaboration releases
use to check and merge signed entries from several people. In this release the
replica core exists but the extension does not use it yet. Other vendored
libraries already run in the extension host, for PDFs, SVG and decks. Both are
built from exact devDependency pins into `vendor/yjs/yjs.cjs`; lib0 is 0.2.119
rather than the newest release, because a release must be at least two weeks old
when it is vendored. `scripts/crdt-vendor.json` records each package's npm
integrity, the SHA-256 of every source file esbuild bundled, the esbuild version
and the SHA-256 of the built file. `npm run compile`,
`src/test/replicaVendor.test.ts` and `npm run verify:release` check those
hashes, so a changed or substituted copy fails the build, CI and the release.
Both packages appear in the extension's SBOM like the other bundled packages.

The COP map page's two libraries are committed under `media/vendor/` byte for
byte from their published npm packages, each with its license, and
`media/vendor/VENDORED.json` records their versions, npm integrity and the
hash of every file. `src/test/staffCopSymbols.test.ts` checks every file in the
working tree against those hashes, and `npm run verify:release` checks the same hashes on the
bytes inside the packaged VSIX, so a changed or substituted copy fails CI and the release; they are never fetched at run time
and enter the SBOM from that file:

| Package | Version | License | Used for |
| --- | --- | --- | --- |
| MapLibre GL JS (`maplibre-gl`) | 6.16.0 | BSD-3-Clause | The COP map, 2D and globe (WebGL) |
| milsymbol | 3.0.5 | MIT | MIL-STD-2525 and APP-6 military symbols |

One piece of third-party data is committed into the source, not vendored: the word list for the
safety code two people compare when one joins a multi-user staff project. It is data only, never
run, and `src/test/replicaSafetyCode.test.ts` checks it against the SHA-256 of the published file,
so a changed, missing or reordered word fails the build:

| Data | Source | License | Used for |
| --- | --- | --- | --- |
| BIP-39 English word list (2048 words, in `src/domain/replica/safetyWords.ts`) | `bitcoin/bips`, `bip-0039/english.txt` | MIT | The six safety code words shown when a person joins a multi-user staff project |

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

Web search sends queries to the provider you choose with **SovAI: Set Up Web
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
- **Servers added from this version on** start with every tool undeclared. An
  undeclared tool asks before every call in every mode, `fully-autonomous`
  included, with no **Always allow**, and it runs only while you are there: a
  run with nobody present does not call it. Servers you added before this
  version behave as they did, with one exception: a tool that changes data on a
  local server (one started by a command, with no web address) now asks before
  every call in every mode, even on a server marked trusted, because SovAI
  cannot tell what it reaches, until you declare what it may do (below).
- **Declaring what a local server may do.** In your user settings,
  `nearAi.mcp.localServerEffects` names, per server id, what the tools of a
  server with no web address may do: `"read"`, `{ "workspaceWrite": [paths] }`
  (writes inside the project on those paths) and `{ "network": [hosts] }`
  (reaches those hosts, named exactly). A declaration is your statement that you trust what that server's tools do: the gate does not check each call's arguments against it, so a declared tool runs without asking in Full auto. Only declare servers you trust like your own code. What a declared tool
  does with its arguments (which file it writes, what it reads, where it
  sends) is the server's own business: SovAI sees only what you declared,
  so a declared server could still write into `.git/` or read a credential
  store. A declaration only narrows which tools it covers: it decides the
  server's tools that themselves say they neither delete nor reach the open
  world (MCP's `destructiveHint` and `openWorldHint` both false); a tool that
  says it may delete or reach the open world, or says neither way, keeps
  asking whatever is declared. The setting itself refuses to name publishing,
  deleting, sending, shell commands, `.git/`, `.planning/` or `.near-ai/`, the
  whole project or a wildcard at its top, and after a credential read a
  declared host still asks. A declaration that cannot be read is ignored with
  a warning, and the server keeps asking. A workspace's settings cannot
  declare it.
- **Declaring what a tool does.** The MCP page has a "What it does" menu for
  each tool of a connected server: it only reads, it changes data on the server,
  or you do not know. That decides how the tool is treated from then on.
  This is what you or the server declared it does. SovAI cannot check what a server does inside itself.
- **Local servers** run only after you confirm the exact command, with a
  minimal environment (PATH, HOME, and the like) plus the variables you set,
  never the editor's own environment. Runs on this machine with your permissions:
  a local server is a program on your computer with the same access you have.
- **Results** are outside content: fenced, scanned for injection attempts, and
  shown in Agent Activity.
- **Tool descriptions** are outside content too. A server's description of each
  tool reaches the model only inside an `<untrusted-content>` block with a
  random id, after a line that says it is the server's own words and never
  instructions. It is cut to 1,024 characters before it is fenced, so the fence
  is never cut; hidden characters are removed and likely injections are flagged
  inside the block, and the person is told once per window which tool's
  description was flagged. The input schema's own field descriptions are not
  fenced; they are covered by the change check below.
- **Changed tools are held.** The tools a server lists at its first connection
  after you add it (or, for a server added before this version, at its next
  connection) are recorded as the ones you approved: a digest of each tool's
  name, description, input schema and read-only, destructive and open-world
  hints, kept with the server's settings. When the server later lists a new
  tool, or changes any of those for a tool, that tool is not offered to agents,
  the chat says which tools changed (once per listing, not every turn), and the MCP page shows the change with
  **Approve tool changes**. Approving needs a live connection, so what you
  approve is the listing the page shows. A tool the server no longer lists is
  reported the same way. If a server's approval record is lost after it was
  made, every tool of that server is held until you approve them again; a lost
  record never counts as a first connection. Editing a server to point it
  somewhere else (a new web address, a different transport, or another local
  program or arguments) drops its approval the same way: every tool is held
  until you approve the new server's listing. Renaming it or changing its
  headers keeps the approval. The first listing is trusted as it is: read it on the
  MCP page before you switch a server on for a project.
- **A label ceiling per server.** Your policy can name, per server id, the
  highest label the server may ever receive, in `ceiling.mcpLabelCeilings`
  (through **Edit my rules** in **SovAI: Policy**; for example
  `{ "partner": { "scale": "org", "level": "Internal", "compartments": [], "releasability": [] } }`).
  A ceiling has a clearance's shape: a level on one of the policy's scales,
  compartments, releasability and an optional `expiresAt`. Every call to a
  named server is checked before anything is sent, at every routing tier and
  whether the server runs here or elsewhere: each label of the chat (and of
  what the call itself reads) must be at or under the ceiling, on the same
  scale or through a mapping in the policy, with every compartment the label
  has and, when the label restricts releasability, a releasability in common.
  A chat with no label above the default is judged at the policy's default
  label. Otherwise the call is refused with `label.mcp-ceiling`, the tool never
  runs, the refusal names the label and the ceiling, and a decision record
  names the rule and the label, never the arguments. A ceiling that cannot be
  checked refuses the call with its own sentence and names no label. An expired ceiling lets
  nothing through. A server with no ceiling behaves as before, and the shipped
  policy names none, so nothing changes until you set one. The ceiling lives
  only in the signed policy, never in a server's settings or manifest, so
  raising or lowering it is a policy change like any other. The policy file
  refuses a ceiling with an unknown scale or level, an unknown field, or a key
  that is not a server id, and then fails closed. Set the ceiling on the scale
  your labels use: a label on another scale with no mapping is above it.
- **Not yet supported:** servers that require an interactive OAuth sign-in.
  Servers authenticated by a token in the URL or a header work.

## Checking your project's dependencies

**SovAI: Scan Dependencies for Vulnerabilities** (and, once you agree, every
time a SovAI project opens or a lockfile changes) writes `sbom.cdx.json` for
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
  (linking to the advisory), a status-bar shield, the **SovAI Security**
  output, and the SBOM's `vulnerabilities` with ratings, CVE aliases, and
  fixed versions. If a service can't be reached, the SBOM says the check was
  incomplete rather than clean.
- **Agents** run the `SecurityScan` tool after changing dependencies and are
  told to fix high and critical findings or say why they remain, and never to
  claim no known vulnerabilities without a fresh scan.
- **CI:** **SovAI: Add Dependency Scan Workflow** writes a GitHub Actions
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
maps, `node_modules`, `.planning`, `.codex`, `.agents`, `.git`, or anything of the
messaging relay (`relay/`, `.dockerignore`).

## Messaging relay (foundation)

`relay/` holds the start of a separate service that will carry SovAI chats from Microsoft Teams
and Signal for your organization. It is not part of the extension and is never in the VSIX.

- It handles no Teams or Signal message yet. Its only network endpoint is `GET /healthz`, which
  returns five fields that identify no one: version, uptime, the Teams and Signal states (both
  `not-configured` for now), and the number of runs in progress.
- It listens on `127.0.0.1` by default. Its container publishes the port on `127.0.0.1` only, and
  public HTTPS is meant to end at your own reverse proxy. Keep that proxy patched: for NGINX,
  version 1.30.7 (stable) or 1.31.9 (mainline) or newer fixes CVE-2026-123633 and
  CVE-2026-123007 (unauthenticated code execution with HTTP/2 on), and until you upgrade, HTTP/2
  should be off (`relay/README.md`, "Running with Compose"). The relay and the hub do not use NGINX.
- It reads secrets only from files with no group or world access, refuses a secret given as a
  plain environment value, keeps its state in a private folder (0700, files 0600), and writes
  logs through a redaction layer that drops credentials and message text and replaces phone
  numbers with stable labels.
- It has its own `package.json` and lockfile. Its one runtime dependency, `jose`, is the relay's
  own, pinned exactly and installed with install scripts off; the extension does not use it.
- CI has a seventh required job, `relay`, which installs the relay with install scripts off, runs
  `npm audit` at high, its type check and tests on Node 26.13.1, and builds its container image
  to check the hardening. `verify:release` refuses a VSIX that contains anything from `relay/`.

A full section on what the relay stores and sends comes with the phase that first receives
messages.

## Your organization's sync hub

`hub/` holds the sync hub: a separate service your organization runs to carry multi-user staff
projects between people's computers. It is not part of the extension and is never in the VSIX.
This release ships it for operators only; the editor cannot connect a project to it until a later
release. How to run it, back it up and restore it is in `relay/README.md`, under "Your
organization's sync hub". Each point below names the test that shows it: files under `hub/test/`
are the hub's own suite, files under `src/test/` the extension's.

### What the hub stores and what it reads

- **What it stores.** For each project connected to it, for the life of the project: the sealed
  entries and sealed attachments of every part of the project, the signed key grants (the label of
  each part stays sealed inside its grant), and every checkpoint it signed or was handed back. It
  never deletes or rewrites an entry, and an entry it acknowledged survives a hard kill
  (`hub/test/hubStore.test.ts`, `hub/test/killDrill.test.ts`). It also keeps the check key of each
  invitation registered with it and the join requests that passed its check, removed 7 days after
  they were accepted (`hub/test/join.test.ts`). Who is active where is kept in memory only, never
  on disk (`hub/test/presence.test.ts`).
- **What it reads: the roster.** The hub holds the key of the part of each project every member
  holds, which carries only the roster. So the hub server holds the staff list of every project
  connected to it: the names, seats and declared clearances of the people in it, and their
  devices. It needs the roster to check every change against it (`hub/test/append.test.ts`,
  `hub/test/enrol.test.ts`). A roster change sealed with a new key the hub has not been given yet
  is kept as ciphertext in its writer's log, and the hub applies it, a revocation included, as soon
  as the key reaches it; it never refuses such a change, so the writer's later changes are never
  cut off (`hub/test/append.test.ts`, "epoch key late").
- **What it reads: only the parts the staff lead grants it.** The staff lead may grant the hub
  further parts of a project, for watches that must run when nobody is at a computer (watches
  arrive in a later release). Before any grant the lead's computer shows, and requires the lead to
  confirm: "The hub will be able to read everything in this cell.
  Anyone who takes over the hub server can read it too.
  Grant only cells whose watches must run when nobody is at a computer." The legacy part that keeps a converted project's old ledgers is never granted
  (`src/test/staffReplicaHubMembership.test.ts`).
- **Everything else stays ciphertext.** A byte capture over a real session searches the hub's
  database and attachment folder, every byte it receives and sends, and its logs, for product
  names, titles, text, labels, decision reasons and attachments of parts not granted to it, as
  UTF-8, UTF-16, hex and base64 at every offset, and encoded twice. None appear. The parts granted
  to the hub open in its memory and appear in no log line and in no answer to a member not cleared
  for them, and a planted canary in each encoding is found, so the search has teeth
  (`hub/test/ciphertextOnly.test.ts`).
- **Metadata it sees.** Project, part, device and entry ids, sizes and timing, which devices are
  on each part (the roster says so), and who is active in which part right now (the activity value
  itself is sealed). For a part granted to the hub, its checkpoints name the writer ids and entry
  counts of that part, and every member receives them, including members not cleared for that part
  (`hub/test/checkpoints.test.ts`, `hub/test/presence.test.ts`).

### What the hub cannot do, and what members' computers do about it

- **It cannot forge or change an entry.** Every entry is signed by the device that wrote it. The
  hub refuses one whose signature, writer or place in its writer's log is wrong, and every member's
  computer checks the signature, the writer and the place again before it keeps anything
  (`hub/test/append.test.ts`, `src/test/staffHubTransport.test.ts`).
- **It can withhold, delay, roll back or fork its view, and is named when it does.** A member's
  computer names the hub as withholding when the hub's own heads, a checkpoint or a delivered
  entry's citations name a change it does not deliver within 60 seconds; as delayed when this
  computer's own changes in a part the hub checkpoints are not covered within 5 minutes; as rolled
  back when it shows less than this computer already saw; and as forked when two checkpoints it
  signed disagree. A forked hub is kept as proof (both checkpoints) and not trusted again until the
  staff lead re-admits it. Replayed and reordered answers change nothing; an injected entry, a
  corrupt attachment and another project's answer are refused and named
  (`hub/test/maliciousHub.test.ts`, `src/test/replicaHubWitness.test.ts`).
- **A restore from an old backup is refused as a rollback and refilled.** Members' computers hand
  back the checkpoints the restored hub lost and push again what it lacks; the hub signs nothing
  new until it holds everything those checkpoints cover, and its next checkpoint covers every
  member's changes (`hub/test/restoreDrill.test.ts`).
- **Limit: an honest restore can look like a fork.** If new work reaches a restored hub before
  every member's computer has synced, a computer that held a checkpoint the restore lost sees two
  checkpoints of the hub that disagree, names the hub rolled back and forked, and stops trusting
  it. To that computer an honest restore and a real fork are the same evidence. The operator guide
  gives the restore procedure that avoids it (members sync and make no new changes until every
  device has synced). A member whose computer still names the hub forked keeps working by file or
  through another hub until the staff lead re-admits the hub, a flow that arrives with the
  editor's hub commands.
- **Limit: a checkpoint nobody received.** If the hub signed a checkpoint that no member's
  computer received, and later checkpoints come after it, a restore that loses it cannot be
  mended by members: the hub signs nothing more for that project until it is started again on a
  state whose checkpoints agree. Changes still sync; members' computers in time report the hub as
  delayed.
- **Limit: a reordered history with a changed count.** Members' computers judge a new checkpoint
  against the ones they hold by its heads and by checkpoints over the same number of changes; they
  do not yet recompute its order from the changes themselves, so a hub that reorders earlier
  changes while also changing the count is not caught by that check.
- **Limit: the size of a checkpoint.** A checkpoint is at most 64 KiB, which holds about 250
  writer heads over the parts it covers. Past that, the hub leaves out parts granted to it that no
  earlier checkpoint covered (from the end of their id order); a part an earlier checkpoint covered is
  never left out, because members' computers would read that as a rollback. When the parts already
  covered pass the limit on their own (for example many devices writing in the part every member
  holds), the hub signs nothing more for that project: it logs `checkpoint.too_large` once with the
  reason, lists the project as stuck, and members' computers in time report the hub as delayed.
  Changes still sync (`hub/test/checkpoints.test.ts`, the trimmed and stuck rows).

### Checkpoints cover only what the hub can read

A checkpoint names, for each writer, facts kept inside the sealed changes (each head's order
number and the roster it cites), so the hub signs checkpoints over only the part every member holds
and the parts granted to it, and only over changes whose predecessors it holds too
(`hub/test/checkpoints.test.ts`). For every other part, rollback and withholding are noticed by each
member's own record of what it has seen and by citations of changes never delivered; delay is
noticed only in the parts a checkpoint covers (`hub/test/maliciousHub.test.ts`, the
ungranted-part rows).

### Connections and sessions

- **TLS ends at the hub, TLS 1.3 only** (`hub/test/tlsServer.test.ts`). Members' computers trust
  it by the pin of its certificate's key, or by your organization's certificate authority, and never
  by the system's list of authorities. A certificate with another pin, or one your organization's
  authority did not issue for that host, is refused before any byte is sent
  (`src/test/staffHubTransport.test.ts`).
- **Sessions are bound to the connection.** A device opens a session by signing the hub's one-time
  challenge together with keying material exported from that very TLS connection. Its token lasts
  15 minutes, works only on that connection, and is checked against the roster on every call, so a
  revoked or quarantined device is refused at once and its event stream ends
  (`hub/test/session.test.ts`, `hub/test/events.test.ts`).
- **A device sees only its own parts.** Heads, catch-up, attachments, events and activity go only
  to devices on the part they belong to. A device that asks for the history or an attachment of a
  part it is not on gets the same answer as for one that does not exist (`hub/test/api.test.ts`,
  `hub/test/events.test.ts`, `hub/test/presence.test.ts`).

### Joining and enrolment

- **No join secret at the hub.** An invitation registered with the hub carries only a check key
  derived from the join secret, so the hub can check a join request without ever holding the
  secret. An invitation is locked after 5 wrong tries, and requests expire with their invitation.
  The hub admits nobody: the staff lead's computer checks each request again and the lead still
  compares the six words (`hub/test/join.test.ts`, `src/test/staffReplicaHubMembership.test.ts`).
- **No project without a hub file.** A project reaches the hub only with a hub file the operator
  printed: signed by the hub's own key, for one project, expiring after 1 to 30 days, and accepted
  only for a roster that admits this hub's own key and certificate pin. The hub keeps only a hash of
  the file's enrolment secret (`hub/test/enrol.test.ts`, `src/test/replicaHubFile.test.ts`).

### No outbound connection, no model credential

The hub holds no model credential and opens no outbound connection. The built hub, run through a
whole session under a hook that records every network call a process can start, makes none; its
health check connects only to itself; and no hub source file names a client network call
(`hub/test/noOutbound.test.ts`). A key of its own for hub watches comes in a later release.

### Limits, keys and release

- **Size and rate limits.** At most 200 entries and 4 MiB per append, 8 MiB per attachment, 256 MiB
  of attachments not yet used per device, 50 entries a second per device (a burst of 200), and per
  address 120 session openings, 10 join requests and 10 enrolments a minute; 4 event streams per
  device and 300 per address (a whole site may sit behind one address), and an event stream that
  falls 1 MiB behind is ended. A connection with a session stays open for 2 minutes between
  requests, so a member keeps one session through an exchange
  (`hub/test/limits.test.ts`, `hub/test/api.test.ts`, `hub/test/events.test.ts`).
- **Slow uploads, not slow clients.** Headers must arrive within 5 seconds. A body gets 10 seconds
  and must then keep arriving at 16 KiB a second or faster, so a slow site link can still send an
  8 MiB attachment or a 4 MiB enrolment while a client that trickles or stalls is cut off with 408;
  holding a connection open costs a client real upload bandwidth. A connection without a session
  is closed 10 seconds after it opens, except that a body already arriving then is read to the end
  under the same rule and answered first (`hub/test/tlsServer.test.ts`, `hub/test/session.test.ts`).
- **Keys outside the state volume.** The hub's signing key, encryption key and TLS key are secret
  files the operator makes and mounts; the hub never writes a key, refuses a secret given as a plain
  environment value, and logs through a redaction layer. A backup of its state holds no byte of
  either key (`hub/test/secrets.test.ts`, `hub/test/keys.test.ts`, `hub/test/stateDir.test.ts`,
  `hub/test/logging.test.ts`, `hub/test/restoreDrill.test.ts`).
- **Hardened container.** The hub has no runtime dependency. Its image is distroless and runs as a
  user that is not root, with a read-only root filesystem, every capability dropped and its port
  published on `127.0.0.1` until the operator chooses an address (`hub/test/container/container.test.ts`,
  `hub/test/dockerContext.test.ts`).
- **Never in the VSIX.** CI has an eighth job, `hub`, which installs the hub with install scripts
  off, runs `npm audit` at high, its type check, its tests and its container suite on Node 26.13.1;
  the owner adds it to main's required checks after this phase merges. `verify:release` refuses a
  VSIX that contains anything from `hub/` (`src/test/hubIsolation.test.ts`).

## Known limitations

| Limitation | Plan |
| --- | --- |
| This evidence covers encrypted project state stored by the optional Git sync feature. Other local and hosted information stores need separate evidence. | Verify at-rest protections for the local and hosted stores and backups in the assessed deployment. |
| The approval test verifies the extension's preflight and preview audit event types. Required audit fields and coverage across assessed components need separate evidence. | Deployment and component owners verify approved audit fields from each assessed source under G45. |
| Approval attribution is verified for extension decisions. The deployment still needs evidence of authenticator issuance, protection, recovery, rotation and revocation. | The deployment identity owner documents credential lifecycle controls and samples issuance, recovery and denied use after revocation. |
| Branch protection and an agent review do not establish the owner's approval for a protected environment or verify release-tag bypass authority. | Record each required protected deployment approval and authoritatively review the release-tag ruleset's bypass settings. |
| The dependency audit and one verified policy remediation do not establish complete flaw coverage or that fixes were installed in a particular deployment. | Track findings through reviewed fixes and releases. Deployment operators verify installed versions and record patch deadlines and retest results. |
| The installer inventory identifies shipped components. It does not establish the approved deployment configuration or operational configuration management. | Record the assessed installation, settings, approved baseline and change history for each operational environment. |
| The published incident response plan and supported versions policy document the supplier procedure. They do not establish response exercises, advisory delivery, or deployment response effectiveness. | Record a product response exercise and evidence of advisory and notification procedures. Your organization owns its deployment response plan and exercises. |
| Local gate decision records cover only extension decisions. They do not establish deployment-wide event selection, retention, or monitoring. | Your organization selects events and components to log, and defines retention, forwarding and review. |
| The crypto inventory documents the AES-256-GCM entry. It does not establish key management practices or approved cryptographic configurations for a deployment. | Record the reviewed key lifecycle and verify approved cryptographic configurations for the assessed deployment. |
| The trust badge's checks do not check TCB status or revocation, enclave measurements, or NVIDIA's verdict | Use cloud.near.ai/verify or NEAR's verifier for a full check |
| Open-GSD's Claude Code hooks (statusline, context monitor) are not run | The runner provides its own context thresholds, compaction, and handoff instead |
| Open-GSD's `Workflow` tool and MCP servers (for example context7) are not available | Workflows that need them report the tool as unavailable and fall back to their other paths |
| Scanned PDFs (no text layer), old binary Office files (.doc, .ppt, .xls), and video can't be attached; video can't be generated | The chat says so when a file can't be read; export with OCR or re-save in the current format |
| Attached PDFs and Office files are parsed on this machine (PDFs by Mozilla's pdf.js, vendored, with script evaluation and font loading off; Office files by the extension's own reader, capped at 50 MB unpacked) | Only the extracted text is sent, and it passes the same privacy and spend checks as typed text |
| Attached images and audio are sent to the profile's provider (NEAR AI or your local runtime) to be read or transcribed, possibly by a different model than the one you chose | The chat names the model used for each file; TEE-only mode blocks the turn if that model is not TEE-attested |
| Project sync cannot lock out an old recovery code: anyone with the old code and read access to the repository can still open everything synced, including what is synced from now on, because the data key does not change | Treat a leaked code as a leak of everything synced; changing the data key is planned; see Project state and sync |
| The daily spend limit counts the spend of the editor it runs in, not every editor on the computer | Project spend history is shown in every editor; a combined limit is planned |
| The history keeps the lead agent's steps and each sub-agent's report; a sub-agent's own steps are not yet separate threads | Linked sub-agent threads are planned |
| Project memory has a searchable list, not a graph view | A team's own knowledge graph (see "Where your data goes") is shown as a network in Team Studio; members also get project memory and their own private memory |
| Agent reputation is recorded per role but does not yet change which model a role uses | Routing comes from team `model:` lines and the deep/standard/fast settings |
| **Revert** restores files changed by the agent's file tools, not changes made by shell commands it ran | Use git for command side effects; documented in the chat |
| Under `fully-autonomous`, the agent runs commands and reads likely credential files inside the project without asking | Writes into `.git/`, `.planning/.near-ai/` and `.near-ai/`, publishing and destruction still ask, with no "always allow", and the key folder and credential stores are refused. After it reads such a file, anything that could send data off this computer asks too. The command checks read text, and there is no sandbox around the shell yet, so a command whose words they cannot see, such as one built at run time, runs; one too deep or too long to read asks (see "What the agent can do without asking"). Intended for throwaway workspaces |
| Facts the agent saves with Remember are not reviewed when saved, and later runs start with the relevant ones | Each fact is labeled "verify before relying on it"; review, correct or reset memory with **Manage Project Memory** |
| Shell reads and network exits are checked from a command's text: a path built in a variable, or a program that reads a labelled file and sends it itself, is not seen | A planned sandbox around the shell |
| Local-only trusts the address your local runtime is configured with, unless it is loopback | Name only hosts you control in the policy |
| Labels and the policy are signed by your own key, so they protect against mistakes, not against you | Your organization's rules, signed by its own key, now narrow your own; verified credentials are planned |
| An MCP server's and the cybersecurity host tools' effects are their declarations | A server or tool that does more than it declares is not seen |
| The label file is readable by anyone who can read the project | Do not use a compartment name that is itself secret |
| The outbound check catches labelled text copied into a network call, not a paraphrase or an encoding | A planned sandbox around the shell |
| The check of an answer's attestation and signature runs after the answer, so it cannot stop that answer's request; a failed check stops the next ones. | The connection is proven before anything is sent, and each request is pinned to it |
| The check that a connection ends inside the enclave relies on NEAR AI Cloud's attestation and Intel's root of trust. Like the answer check, it does not check the platform's TCB status, certificate revocation or which code the enclave runs. | Use cloud.near.ai/verify or NEAR's verifier for a full check |
| Spend limits use NEAR's published prices for estimates; the actual charge arrives from billing after the run | Each run, with all its sub-agents, stops before a model turn once its estimate reaches `nearAi.agent.maxRunCostUsd` (default $5), what is left of `nearAi.dailySpendLimitUsd`, or `nearAi.agent.maxRunTokens`; an agent repeating the same action is nudged and then stopped |
| The twelve words protect your organization's key only when its security contact reads them to you over a channel you trust | Compare them in person or on a call you placed to a number you already know; never over the channel the file came through |
| Your organization's rules can carry export-control decisions, but nothing grants access with them yet, and SovAI does not make your organization compliant with the Controlled Goods Program or the ITAR | Your organization's officials decide; a later release uses these decisions to allow access |
| Your organization's server does not load your organization's rules yet | Its rules reach this computer as a signed file you add with **SovAI: Add Your Organization's Rules** |
| Model approvals, and the rule for work that may run only on an approved computer, record what they would refuse and do not refuse it | Your organization's rules can turn on `requireAccreditedDevice` to refuse the second, and set the model policy to `mode: enforce` to refuse the first (see the section on models above) |
| Authorizations are self-signed on this computer until your organization's issuer can sign them | Under your organization's rules only authorizations signed by a key it lists count; a model exception counts only under your organization's rules |
| There is no command to leave your organization | Ask your organization's security contact |

## How changes reach a release

The development process requires every change to reach `main` through a pull request. Before a
pull request merges, CI type checks it, runs the unit tests and the end-to-end tests in a real
VS Code, packages and inspects the VSIX, runs `npm audit` on runtime dependencies, and scans the
files and every commit for secrets, and a security and code review must pass. Releases are
built by GitHub Actions from a tagged commit on `main` (or, for an urgent fix to an older
release, the reviewed head of its hotfix branch). Each release is a Sterling workbench container
image with the release's VSIX inside it. The Release workflow builds the image from the checked
VSIX, starts it and checks it, and pushes it to the GitHub Container Registry only after the
owner approves the push in the protected `container-release` environment. The GitHub release
then records the image's registry digest beside the VSIX, its SHA-256 checksum and the assessor
package. Releases are no longer published to the Visual Studio Marketplace. Every GitHub Action
is pinned to a full commit hash.

The checksum ties the VSIX in the image and on the GitHub release to the build output, and the
recorded digest names exactly the image that was checked and pushed. The build job disables
dependency install scripts and runs the lockfile-pinned build tools and tests. A compromised
tool can still change the VSIX before its checksum is taken.

AI agents do much of this work, and they act through the owner's GitHub account, which is a
repository and organization admin. The image publication approval and the repository settings
are therefore kept by policy: the agents are instructed never to take those steps, the scripts they
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
that keeps release tags from being moved or deleted, and the protected `container-release`,
`agent-review` and `agent-review-gates` environments; the older `marketplace` environment
still exists but no release uses it).
They are listed, with the commands that apply them, in
[docs/development-workflow.md](https://github.com/VitalPointAI/near-ai-vscode/blob/main/docs/development-workflow.md)
(section 8), which also describes the whole process. A rule is in force only once its setting is
applied.

## Supported versions

| Version | Supported |
| --- | --- |
| The latest 0.4.x release | Yes |
| Earlier releases | No |

How a report is handled, with the response times the maintainers commit to, is in the
[incident response plan](https://github.com/VitalPointAI/near-ai-vscode/blob/main/docs/security/incident-response.md).

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
