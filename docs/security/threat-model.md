# Threat model

Last reviewed: 2026-11-24

This is the threat model of NEAR AI for VS Code and the services that come with it in this
repository: the extension, the messaging relay (`relay/`) and the sync hub (`hub/`), the Sterling
workbench image that ships the extension, and the pipeline that releases them. It says what is protected, where the trust boundaries are, which
threats the product handles and where, and what it cannot stop. Each mitigation links to the
section of the [security policy](../../SECURITY.md) that describes it in full; the security policy
is the authority where the two differ. Where each component's data goes is drawn in the
[data flows](data-flow.md).

It describes the code on `main`. It is reviewed at least once a year and whenever a component
gains a new boundary (a new endpoint, service or sharing path).

## What is protected

| Asset | Where it lives | Why it matters |
| --- | --- | --- |
| API keys for NEAR AI Cloud and other providers | VS Code SecretStorage, one key per project and profile | A stolen key spends money and reads nothing else, but it must never reach a model, a log or a file |
| Device keys (the signing key and the encryption key of each install) | The editor's secret storage | They sign policies, labels, decisions and staff entries, and open the cell keys of shared staff projects |
| Project data keys, recovery codes, cell keys and join secrets | Secret storage and a private key file (mode 0600) in the state folder; recovery codes are shown once and never stored | Whoever holds them can read the project's state |
| Project state: chats, runs, checkpoints, spend history | `.near-ai/state/` in the project, sealed with AES-256-GCM; an encrypted copy on the project's git remote when sync is on | Transcripts hold file contents and command output the agent saw |
| Prompts, attached files and the files the agent reads | Sent to the model you picked, after the outbound check | They can hold your organization's code and labelled content |
| Signed policies, labels and decision records | The extension's own storage, `.planning/.near-ai/labels.json` and the project's records | They decide what the agent may do and where content may go |
| Shared staff projects | The replica store in the project, members' computers, and your organization's hub | Labelled products from several people |
| Release artifacts | The Sterling workbench image on the GitHub Container Registry, and the GitHub release (the image digest, the VSIX and its SHA-256 checksum, the assessor package) | Every user installs or runs them |

## Trust boundaries

| Component | Boundary | What crosses it |
| --- | --- | --- |
| Extension and its webviews | Between the extension host and each page it shows (chat, Team Studio, the policy page, the COP map) | Each page runs under a content security policy that allows only its own scripts and loads no remote content; choices such as a team's privacy are decided from the workspace, not from what the page sends |
| The editor host | Between the extension and VS Code, the operating system and the user's own account | The extension runs with the user's permissions; the agent's tools are confined to the workspace, and secrets stay in SecretStorage |
| Model endpoints | Between this computer and NEAR AI Cloud, a local runtime or another endpoint your policy lists | Prompts and tool results go out over HTTPS (plain HTTP only to `localhost`); answers come back as untrusted content |
| Outside content | Between the agent and web pages, search results, attached files and MCP servers | Everything that comes back is fenced as data, scanned for injection attempts and marks the run as tainted |
| Project sync | Between this computer and the project's git remote | Only ciphertext on the `near-ai/state` branch, with opaque names and a constant author and message |
| Messaging relay | Between your organization's server and the network | In this version only `GET /healthz`, on `127.0.0.1` by default; public HTTPS ends at your organization's reverse proxy |
| Sync hub | Between members' computers and your organization's hub server | TLS 1.3 sessions bound to the connection; the hub stores sealed entries and reads only the roster and the parts the staff lead grants it |
| GitHub and its Container Registry | Between the maintainers' work and every user's install | Changes reach `main` only through pull requests and their gates; a release is built from a tagged commit, and its image is pushed only after the owner's approval in the protected `container-release` environment |
| The Sterling workbench image | Between the container and whoever can reach its port | The image has no sign-in of its own, so it is a preview for one person, published on `127.0.0.1` only |

## Threats and mitigations

The table names each threat by its STRIDE category: spoofing, tampering, repudiation,
information disclosure, denial of service and elevation of privilege.

| STRIDE | Threat | Where it is handled |
| --- | --- | --- |
| Spoofing | A server pretends to be a NEAR AI Cloud private model | Attestation of the connection and of each answer: [Classification labels and routing](../../SECURITY.md#classification-labels-and-routing), [The trust badge on each answer](../../SECURITY.md#the-trust-badge-on-each-answer) |
| Spoofing | A server pretends to be your organization's hub | Certificate key pin or your organization's authority, never the system list: [Connections and sessions](../../SECURITY.md#connections-and-sessions) |
| Spoofing | Someone joins a shared staff project with a swapped key | Signed invitations, a one-time join secret and six words compared by the staff lead: [Invitations, join secrets and the safety code](../../SECURITY.md#invitations-join-secrets-and-the-safety-code) |
| Tampering | A changed or planted policy file widens what the agent may do | The policy is signed by the device key and fails closed when it is missing, unsigned, changed or expired: [Your policy file and decision records](../../SECURITY.md#your-policy-file-and-decision-records) |
| Tampering | A synced object is altered, swapped or rolled back | AES-256-GCM with bound additional data and a manifest counter: [Encryption model](../../SECURITY.md#encryption-model) |
| Tampering | A hub or a member's store forges, reorders or rolls back shared history | Signed entries checked on every computer, signed checkpoints and each device's own record: [What the hub cannot do, and what members' computers do about it](../../SECURITY.md#what-the-hub-cannot-do-and-what-members-computers-do-about-it), [The replica store and rollback detection](../../SECURITY.md#the-replica-store-and-rollback-detection) |
| Tampering | A file in a cloned repository steers sync or runs a hook | Sync keeps its switch, mirror and hooks outside the project: [What sync trusts in the project folder](../../SECURITY.md#what-sync-trusts-in-the-project-folder) |
| Tampering | A compromised dependency or a changed vendored library reaches the VSIX or the image | Lockfiles, actions pinned by commit, base images pinned by digest, vendored files checked by hash, an SBOM checked on OSV.dev, and a reviewed entry for every resource in the [compliance fit check](../../compliance/resources.json): [Dependencies](../../SECURITY.md#dependencies), [How changes reach a release](../../SECURITY.md#how-changes-reach-a-release) |
| Tampering | A different image is run in place of the released one | The image is pushed only after it was started and checked, and the GitHub release records its digest, so a pull by that digest gets exactly the tested image |
| Repudiation | Nobody can tell who decided a gated step | Decisions are recorded with their rule ids; staff decisions are signed by the deciding person's device key: [Your policy file and decision records](../../SECURITY.md#your-policy-file-and-decision-records) |
| Information disclosure | A credential or private-file path is sent to a model | The outbound check blocks it before anything leaves: [The outbound check](../../SECURITY.md#the-outbound-check) |
| Information disclosure | Labelled content goes to a model or a place it may not reach | The route check on every request, with tiers per level and the list of places: [Classification labels and routing](../../SECURITY.md#classification-labels-and-routing), [Where AI may run](../../SECURITY.md#where-ai-may-run) |
| Information disclosure | Text in a web page or a tool result steers the agent into sending data out | Hidden content removed, injections flagged, content fenced, tainted runs ask before anything leaves: [Outside content and prompt injection](../../SECURITY.md#outside-content-and-prompt-injection) |
| Information disclosure | Synced state, or a hub, reveals project content | Only ciphertext leaves the computer; the hub reads only the roster and granted parts: [What still leaks](../../SECURITY.md#what-still-leaks), [What the hub stores and what it reads](../../SECURITY.md#what-the-hub-stores-and-what-it-reads) |
| Information disclosure | The workbench image is reachable from other computers, giving anyone a shell in it | The image refuses to start until `STERLING_PREVIEW_NO_SIGN_IN=accept` confirms it is published on `127.0.0.1` only: [Run the Sterling workbench image](../../.planning/spikes/theia-team-studio/README.md#run-locally) |
| Information disclosure | A key or a secret ends up in a log, an export or an error | Keys stay in secret storage and never reach a log; Agent Activity masks secrets, and the relay and the hub log through a redaction layer: [Where your data goes](../../SECURITY.md#where-your-data-goes), [Device encryption keys and the key ring](../../SECURITY.md#device-encryption-keys-and-the-key-ring) |
| Denial of service | A hostile change from another computer exhausts the editor's memory | Size limits, counting before decoding, and a separate decode process with its own limits: [Update size limits and the decode worker](../../SECURITY.md#update-size-limits-and-the-decode-worker) |
| Denial of service | A client floods or stalls the hub | Size and rate limits and slow-upload rules: [Limits, keys and release](../../SECURITY.md#limits-keys-and-release) |
| Denial of service | A runaway run spends without limit | Per-run and daily spend limits and Emergency stop: [The outbound check](../../SECURITY.md#the-outbound-check), [Known limitations](../../SECURITY.md#known-limitations) |
| Elevation of privilege | The agent writes into `.git/`, publishes or reads the key folder | These always ask or are refused, in every mode: [What the agent can do without asking](../../SECURITY.md#what-the-agent-can-do-without-asking) |
| Elevation of privilege | An MCP server's tool does more than it was approved for | Tool approvals, held changed tools, label ceilings per server: [MCP connections](../../SECURITY.md#mcp-connections) |
| Elevation of privilege | An agent approves its own pull request or publishes a release | A separate reviewer identity, and the owner's approval for gate files and for publishing: [How changes reach a release](../../SECURITY.md#how-changes-reach-a-release) |

The [Known limitations](../../SECURITY.md#known-limitations) table lists where each of these is
partial today and what is planned. This page adds no limitation that table does not already name,
except that the workbench image has no sign-in of its own: sign-in for each person comes with
hosting at your organization's sites, which is planned and not yet released.

## What the product cannot stop

Some threats are outside what software on one computer can control. They stay with your
organization:

- **Its devices.** A computer that is lost, shared or compromised exposes what it holds: the
  project folder, the editor's secret storage and anything open on screen. Disk encryption,
  screen locks, patching and endpoint protection are your organization's controls.
- **Its people.** Who may use the product, who may hold which labels and keys, and who is a
  staff lead are your organization's decisions. Clearances in the product are declared, not
  verified, until verified credentials arrive.
- **Physical security.** Where computers and servers sit, who can reach them, and where backups
  of the relay and the hub are kept.
- **Content pasted elsewhere.** A person who can read a file can copy it into another tool, a
  browser or a message. The product checks only what it sends itself. Data-loss controls and
  training are your organization's responsibility.
- **Shell commands and local servers beyond their words.** The agent's commands and local MCP
  servers run with the user's permissions; the checks read a command's text and a server's
  declarations, as the Known limitations table says.
- **Providers.** What a model provider or GitHub, including its Container Registry, does inside
  its own service is covered by that provider's own assessment, which your organization records
  and relies on.
