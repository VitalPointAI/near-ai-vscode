# Data flows

Last reviewed: 2026-11-24

One diagram per component shows what data crosses which boundary and whether it is encrypted on
the way. Dashed lines are boundaries the data crosses encrypted end to end, so the other side holds
only ciphertext; solid lines are TLS connections, where the other side reads what it receives, or
steps inside one computer. The [threat model](threat-model.md) says which threats each boundary
faces, and the [security policy](../../SECURITY.md) is the authority on every detail.

## Extension

```mermaid
flowchart LR
  subgraph PC["This computer"]
    UI["Chat and pages (webviews)"]
    EXT["Extension host: agent, outbound check, route check"]
    SEC[("Secret storage: API keys, device keys, data keys")]
    STATE[("Project state folder, sealed with AES-256-GCM")]
    WS[("Workspace files")]
  end
  GIT["Project's git remote, near-ai/state branch"]
  MOD["Model endpoint, see Model endpoints"]
  WEB["Web pages, search, MCP servers, OSV.dev"]
  UI -- "requests and replies, inside the editor" --> EXT
  EXT -- "keys, read only by the extension" --> SEC
  EXT -- "reads and writes, confined to the workspace" --> WS
  EXT -- "chats and runs, sealed" --> STATE
  STATE -. "ciphertext only, when sync is on" .-> GIT
  EXT -- "prompts and tool results over HTTPS, after both checks" --> MOD
  EXT -- "queries, tool calls, package names over HTTPS" --> WEB
```

Everything the extension sends to a model passes the outbound check and the route check first,
and what comes back from the web, a search or an MCP server is fenced as untrusted content. Project
state leaves the computer only as ciphertext, and no telemetry is sent.

## Messaging relay

```mermaid
flowchart LR
  subgraph ORG["Your organization's server"]
    RP["Your organization's reverse proxy, HTTPS"]
    RELAY["Relay container, 127.0.0.1"]
    RS[("Relay state folder 0700, files 0600")]
    SECF[("Secret files, no group or world access")]
    LOG["Logs, redacted"]
  end
  CHECK["Health monitor"]
  CHECK -- "GET /healthz over HTTPS" --> RP
  RP -- "loopback" --> RELAY
  RELAY -- "five fields: version, uptime, two channel states, runs in progress" --> RP
  SECF -- "read at start" --> RELAY
  RELAY -- "state" --> RS
  RELAY -- "no credentials, no message text" --> LOG
```

In this version the relay handles no Teams or Signal message; its only endpoint is the health check,
which names no one. Public HTTPS ends at your organization's reverse proxy, and this diagram gains
the Teams and Signal flows in the phase that first receives messages.

## Sync hub

```mermaid
flowchart LR
  subgraph M1["A member's computer"]
    D1["Extension: signs and seals entries"]
  end
  subgraph M2["Another member's computer"]
    D2["Extension: checks signatures, opens its own cells"]
  end
  subgraph HUBS["Your organization's hub server"]
    HUB["Hub: TLS 1.3, session bound to the connection"]
    DB[("Store: sealed entries, sealed attachments, signed grants, checkpoints")]
  end
  D1 -- "TLS 1.3, pinned key" --> HUB
  HUB -- "TLS 1.3, pinned key" --> D2
  D1 -. "entries sealed per cell; the hub opens only the roster and granted cells" .-> D2
  HUB -- "stores as received" --> DB
```

The hub holds the roster's key so it can check each change, and the key of any part the staff lead
grants it; every other part stays ciphertext to it. It makes no outbound connection and holds no
model credential.

## Release pipeline

```mermaid
flowchart LR
  DEV["Pull request"] -- "CI, secret scan, compliance fit check, agent review" --> MAIN["main on GitHub"]
  MAIN -- "release tag, protected" --> BUILD["Release workflow: tests, build, SBOM, VSIX checks"]
  BUILD -- "VSIX, checksum checked" --> IMG["Image job: builds the workbench image with that VSIX, starts it and checks it"]
  IMG -- "image archive, checksum checked" --> PUB["Publish job, waits for the owner's approval"]
  PUB -- "HTTPS, short-lived workflow token" --> GHCR["GitHub Container Registry"]
  PUB -- "image digest" --> GHR["GitHub release: digest, VSIX, checksums, assessor package"]
  GHCR -- "image pulled by digest over HTTPS" --> USER["Container runtime on each computer"]
  GHR -- "VSIX and checksum over HTTPS" --> VSC["VS Code on each computer"]
```

Every change reaches `main` through a pull request and its gates. The VSIX inside the image and on
the GitHub release is the one the build job made, checked by its checksum, and the image that is
pushed is the one the image job started and checked. The publish job runs only after the owner
approves it in the protected `container-release` environment. The GitHub release records the
image's registry digest, so pulling by that digest gets exactly the pushed image. Releases are no
longer published to the Visual Studio Marketplace.

## Model endpoints

```mermaid
flowchart LR
  EXT["Extension on this computer"]
  subgraph CLOUD["NEAR AI Cloud"]
    TEE["Private model in a TEE, attested"]
    FWD["Model forwarded to another provider"]
  end
  LOCAL["Local runtime on this computer"]
  ORGM["Endpoint your organization lists in its policy"]
  EXT -- "HTTPS; connection proven to end in the enclave for attested levels" --> TEE
  EXT -- "HTTPS; only for levels whose tier allows any cloud" --> FWD
  EXT -- "loopback HTTP or HTTPS" --> LOCAL
  EXT -- "HTTPS only, with a pin and an authorization for Protected B" --> ORGM
  TEE -- "answer, signature and attestation checked" --> EXT
```

Which endpoint a request may reach is decided by the route check from the chat's labels, the
routing tiers and your organization's list of places. A model endpoint reads the prompt in the
clear to answer it, so the encryption on these lines protects the data on the way, not from the
endpoint.
