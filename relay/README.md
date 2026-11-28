# NEAR AI relay (foundation)

The relay is its own small service for NEAR AI chats that arrive from Microsoft Teams and Signal. It lives in this folder with its own `package.json` and lockfile. It is not the extension, it is not the extension's sync feature, and it is never shipped in the extension's VSIX.

This version is the foundation only. It starts, keeps a private state folder and a small database, loads its secrets safely, writes redacted logs, and answers a health check. It does not receive or send any Teams or Signal message yet. Those channels arrive in later phases.

The same Compose file can also run your organization's sync hub, a separate service whose code lives in `hub/`. Its operator guide is the last section of this file, [Your organization's sync hub](#your-organizations-sync-hub).

## What you need

- Node 26.13.1 or a later 26.x release. An older Node refuses at install (`npm ci` stops) and at start (the relay prints one sentence and exits).
- To install it with nvm without changing your default Node:

  ```sh
  bash -c 'unset NVM_SYMLINK_CURRENT; . "$HOME/.nvm/nvm.sh"; nvm install 26.13.1'
  export PATH="$HOME/.nvm/versions/node/v26.13.1/bin:$PATH"
  ```

  Put that bin folder first on `PATH` only in the shell where you work on the relay. Do not run `nvm use` or `nvm alias default`.
- Docker with Compose, or Podman, to run the container image. The container suite needs Docker.

## Development commands

Run these from the `relay` folder.

| Command | What it does |
| --- | --- |
| `npm ci` | Installs the locked dependencies (install scripts are off). |
| `npm run lint` | Type-checks the relay. |
| `npm test` | Builds and runs the unit and integration tests. It does not need Docker. Set `NEAR_AI_RELAY_OLD_NODE` to an older `node` binary (for example `~/.nvm/versions/node/v24.22.2/bin/node`) to also run the older-Node refusal tests, which CI always runs. |
| `npm run test:container` | Builds the image and runs the container suite (Docker and Compose required). It makes only its own uniquely named image, Compose project and volume, and removes them again. |
| `npm start` | Starts the built relay from `dist/bin.mjs`. Run `npm run build` first. |

The relay has one runtime dependency, `jose` (exact pin, own lockfile, installed with install scripts off). Nothing imports it yet: it is reserved for the Teams JWT validation in Phase 75 (inbound authenticity), and the workspace test pins it so it cannot change by accident.

## Settings

The relay reads three settings from its environment. Any other name that starts with `RELAY_` stops the relay at start, so a typo cannot fall back to a default by accident.

| Setting | Default | Meaning |
| --- | --- | --- |
| `RELAY_HOST` | `127.0.0.1` | Address to listen on. |
| `RELAY_PORT` | `8080` | Port to listen on. |
| `RELAY_STATE_DIR` | `relay/state` in development, `/var/lib/near-ai-relay` in the image | Where the relay keeps its state. Must be an absolute path. |

## The state directory

Everything the relay keeps lives in one folder, `RELAY_STATE_DIR`. In development that is `relay/state`, which git ignores.

- The folder is created with mode 0700 and must belong to the user the relay runs as. Every file in it is mode 0600: the database (`relay.db`, `relay.db-wal`, `relay.db-shm`) and the phone-label key (`log-pseudonym.key`).
- If the folder or a file belongs to the relay's user but is open to the group or to everyone, the relay tightens it and logs that once. A folder or file that belongs to another user, or that is a link, is refused and the relay does not start.
- If the folder is the mount point of its own volume, the `lost+found` folder that the file system keeps there (owned by root) is left alone. Nothing else of another user is accepted.
- A temporary file the relay was writing when it was stopped (named like `.log-pseudonym.key.1a2b3c4d.tmp`) is removed at the next start, and the log says so once.
- Back it up only while the relay is stopped, and keep the backup as private as the folder.

## Secrets

The relay takes every secret from a file and from nowhere else. For a secret named `NAME` it looks, in this order, at:

1. the file named by `NAME_FILE`,
2. `$CREDENTIALS_DIRECTORY/name` in lower case (systemd credentials),
3. `/run/secrets/name` in lower case (Compose and Docker secrets).

A secret file must be mode 0400 or 0600 with no group or world access. A secret given as a plain environment value (for example `TEAMS_APP_SECRET=...`) is refused, because environment values show up in `docker inspect` and in process listings. Error messages name the secret and never print its value or any part of the file.

The kinds of secret in your deployment:

- The Teams bot app secret (`TEAMS_APP_SECRET`).
- A NEAR AI API key for your organization, and one for each other organization the relay serves, named `NEAR_AI_KEY_` plus a tenant name in capitals, for example `NEAR_AI_KEY_ACME`, given as a file with `NEAR_AI_KEY_ACME_FILE`. A tenant name cannot be `FILE` or end in `_FILE`. Any variable that starts with `NEAR_AI_KEY_`, in any case, set to a plain value stops the relay at start. This version does not read these key files at all: nothing opens them, checks their permissions or uses them until Phase 76 (tenants and identity). Until then a misnamed variable or file, a missing file, or a file with loose permissions is not detected, so there is no need to create them yet. If you do, check the names against this paragraph yourself.
- The Signal registration material. It is not a file the relay reads. It lives in the Signal sidecar's `signal-config` volume, and that volume is itself the credential for the number.
- The optional `LOG_PSEUDONYM_KEY`. It makes the stable labels that replace phone numbers in logs. When you give none, the relay creates `log-pseudonym.key` in the state directory once and reuses it.

Until the Teams channel is configured, the relay only checks the Teams secret file's permissions and does not use its value. Compose cannot make a file secret optional, so the `teams_app_secret` file must exist before `docker compose up`, even though nothing reads its value yet.

## Running with Compose

From the repository root:

```sh
mkdir -p relay/secrets
printf '%s' 'your-teams-app-secret' > relay/secrets/teams_app_secret
sudo chown 65532:65532 relay/secrets/teams_app_secret
chmod 0400 relay/secrets/teams_app_secret
docker compose -f relay/compose.yaml up -d --build
```

Compose ignores `uid`, `gid` and `mode` on file secrets and keeps the host file's owner and mode. The relay runs as user 65532, so you give it the secret file yourself with the `chown` and `chmod` above. Do not add `uid`, `gid` or `mode` keys to `compose.yaml`.

Compose variables, all with a `NEAR_AI_RELAY_` prefix so the relay's own `RELAY_` check never sees them:

| Variable | Default | Meaning |
| --- | --- | --- |
| `NEAR_AI_RELAY_IMAGE` | `near-ai-relay:local` | Name of the image to build and run. |
| `NEAR_AI_RELAY_PUBLISH_PORT` | `8080` | Port on `127.0.0.1` that reaches the relay. |
| `NEAR_AI_RELAY_SECRETS_DIR` | `relay/secrets` | Folder that holds the secret files. |

What the container gives you:

- A shell-less image: distroless Node 26 as user 65532, with no shell, package manager, curl or wget, and only `bin.mjs` and `app.mjs` in `/app`. Both base images are pinned by digest.
- A read-only root filesystem, every Linux capability dropped, no-new-privileges, a 16 MB private `/tmp`, and limits of 128 processes and 512 MB of memory.
- The state volume `relay-state` as the only writable path, created empty with mode 0700 for user 65532.
- The port published on `127.0.0.1` only. TLS for the public Teams webhook ends at your reverse proxy on the host, which the Phase 84 runbook covers. Never publish the relay's port on all interfaces.
- If your reverse proxy is NGINX: two critical NGINX flaws disclosed on 18 November 2026 (CVE-2026-123633 and CVE-2026-123007, CVSS 9.2) let an unauthenticated attacker run code on the proxy when HTTP/2 is enabled, even when it serves only static files. Use NGINX 1.30.7 (stable) or 1.31.9 (mainline) or newer, or the fixed NGINX Plus builds, and check the running binary with `nginx -v` (for a distribution package, its own advisory decides, not the version number alone; for a container, the running image digest). Until you have upgraded, turn HTTP/2 off: `http2 off;` in each server block and no `http2` on any `listen` line, then reload and confirm the old workers have exited. The relay itself does not use NGINX.

Podman rootless: run the same image with `--userns=keep-id:uid=65532,gid=65532` so a secret file you own is read as user 65532. The container suite does not cover Podman.

## Health

`GET /healthz` returns exactly five fields and nothing that names a tenant, a request or a secret:

| Field | Meaning |
| --- | --- |
| `version` | The relay's version. |
| `uptimeSeconds` | Seconds since the relay started. |
| `teams` | `not-configured`, `ok` or `down`. Always `not-configured` in this version. |
| `signal` | `not-configured`, `ok` or `down`. Always `not-configured` in this version. |
| `inFlightRuns` | How many runs are in progress (0 in this version), or `null` if that cannot be read. |

The reply is 200 when the relay is healthy and 503 when it cannot read its own state. The container healthcheck runs `node /app/bin.mjs --healthcheck`, which calls `/healthz` on the loopback address inside the container and exits 0 on a 200. `docker compose ps` shows the result as `healthy`.

## The Signal sidecar

`relay/compose.yaml` also describes a Signal sidecar (`bbernhard/signal-cli-rest-api`). It is in the profile `signal`, so it is off by default. Start it only when a later phase tells you to, with `docker compose -f relay/compose.yaml --profile signal up -d`.

- It is pinned by tag and digest: `0.101` plus its sha256 (a multi-architecture index for amd64, arm64 and arm/v7). That tag bundles signal-cli 0.14.8, released 2026-09-10. A signal-cli release stops working with Signal about three months after it comes out, so this pin stops working with Signal after about 2026-12-10. On 2026-11-18 `0.101` was still the newest stable release, and since the sidecar is off by default and nothing uses it yet, the pin is left to lapse: do not start the `signal` profile until Phase 82 (the Signal channel) re-pins it to a current release.
- It publishes no port. Only the relay, on the Compose network, can reach it.
- Its `signal-config` volume is the Signal registration. Treat it like a password: back it up privately and never share it.
- It runs with the same kind of limits as the relay: as the image's own `signal-api` user (uid 1000, never root), a read-only root filesystem, every Linux capability dropped, no-new-privileges, and limits of 256 processes and 1 GB of memory. Its only writable paths are the `signal-config` volume and a 128 MB private `/tmp`. That `/tmp` allows running programs, because the image's process supervisor (s6-overlay) runs its service scripts from `/tmp/s6-runtime` and signal-cli loads its native library from there.
- What was checked so far is static only: the pinned image's own settings (it is built to run as uid 1000 with a read-only root, `S6_READ_ONLY_ROOT=1`, and keeps its runtime files in `/tmp`) and `docker compose --profile signal config`, which the container suite also asserts. Nothing has started the sidecar yet. Phase 82 (the Signal channel) starts it for the first time and must confirm it runs with these settings, and loosen one only with a recorded reason.

## Known limits

- One relay per state directory. Nothing stops a second relay from opening the same folder until Phase 77 adds a lock, so run only one.
- No Teams or Signal messages are handled yet.
- This is a foundation guide. The full operator runbook (reverse proxy, TLS, backups, upgrades) arrives in Phase 84.

## Your organization's sync hub

The sync hub carries shared staff projects between the computers of the people who work on them. Your organization runs one hub, as its own service in this Compose file, under the profile `hub`. It runs without the relay, and the relay runs without it. Its code is in `hub/`, it has no runtime dependency, and it is never shipped in the extension's VSIX.

This release ships the hub for operators only. People cannot connect a staff project to it from the editor yet; that arrives in a later release. You can stand the hub up now, back it up and practise a restore, so it is ready when the editor can use it.

### What the hub is and what it never does

- It keeps the signed, sealed history of each staff project that the staff lead connects to it, and hands it to the project's members. It checks every change against the project's member list before it keeps it, tells members' computers at once when something changes, and signs checkpoints that let every computer notice a hub that holds back, rolls back or shows different people different histories.
- It holds no model credential, makes no model calls, runs no tools and opens no outbound connection. The only connection it makes is its own health check, to itself.
- It cannot write as a member, change what a member wrote or admit anyone. People are admitted by the staff lead's computer, which checks the join request and the six words as before.

### What you need

- Docker with Compose. The image is built from this repository; both base images are pinned by digest.
- A host name that members' computers can reach, for example `hub.example.test`, and a port (8443 unless you choose another).
- A TLS certificate and key for that host name: from your organization's certificate authority, or a self-signed one made with the command below.
- Every command in this section runs from the repository root.

### Certificates and pins

The hub ends TLS itself, with TLS 1.3 only. Members' computers trust it in one of two ways, never through the system's list of certificate authorities:

- **The pin.** The pin is the sha256 of the certificate's public key (its SubjectPublicKeyInfo), written as 64 hex characters. The hub puts it in every hub file it prints, and the staff lead's computer records it when it admits the hub. A computer that meets a certificate with another pin sends nothing.
- **Your organization's certificate authority.** A computer given your organization's CA accepts a certificate from that CA for the host name it connects to.

Because the pin is the pin of the key, not of the certificate, renewing the certificate with the same key keeps the pin, and nothing changes for members. A new key gives a new pin: the staff lead then revokes the hub and admits it again from a new hub file.

To make a self-signed certificate with an EC P-256 key for your host name:

```sh
mkdir -p relay/secrets/hub
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
  -keyout relay/secrets/hub/hub_tls_key -out relay/secrets/hub/hub_tls_cert \
  -days 365 -subj "/CN=hub.example.test" -addext "subjectAltName=DNS:hub.example.test"
```

To use your organization's CA instead, put the certificate it issued (followed by any intermediate certificates) in `relay/secrets/hub/hub_tls_cert` and its key, without a passphrase, in `relay/secrets/hub/hub_tls_key`. The certificate must name the host name members use.

To print the pin of a certificate:

```sh
openssl x509 -in relay/secrets/hub/hub_tls_cert -noout -pubkey \
  | openssl pkey -pubin -outform DER | openssl dgst -sha256 -r | cut -d' ' -f1
```

To renew a self-signed certificate with the same key, so the pin stays:

```sh
openssl req -x509 -key relay/secrets/hub/hub_tls_key -out relay/secrets/hub/hub_tls_cert.new \
  -days 365 -subj "/CN=hub.example.test" -addext "subjectAltName=DNS:hub.example.test"
```

Print the pin of the new file with the command above, check it is the same, then put it in place of the old certificate (see [Changing a key or the certificate](#changing-a-key-or-the-certificate)). For a certificate from your organization's CA, ask for the renewal from the same key: `openssl req -new -key relay/secrets/hub/hub_tls_key -subj "/CN=hub.example.test" -addext "subjectAltName=DNS:hub.example.test" -out hub.csr` makes the request.

### Secret files

The hub reads four secrets, each from its own file, exactly as the relay does (see [Secrets](#secrets)): never from a plain environment value, and only from a file with mode 0400 or 0600 and no group or world access. Compose mounts them from `relay/secrets/hub/` (or the folder in `NEAR_AI_HUB_SECRETS_DIR`):

| File | Secret | What it is |
| --- | --- | --- |
| `hub_tls_cert` | `HUB_TLS_CERT` | The TLS certificate, and any intermediate certificates after it. |
| `hub_tls_key` | `HUB_TLS_KEY` | The certificate's private key, without a passphrase. |
| `hub_signing_key` | `HUB_SIGNING_KEY` | The hub's Ed25519 signing key: one line made with `--generate-key signing`. It is the hub's identity; its checkpoints and hub files are signed with it. |
| `hub_encryption_key` | `HUB_ENCRYPTION_KEY` | The hub's X25519 encryption key: one line made with `--generate-key encryption`. The keys of the parts of a project the hub may read are wrapped to it. |
| `hub_kem_key` (optional) | `HUB_KEM_KEY` | The hub's post-quantum keys (P-256 and ML-KEM-768): one line made with `--generate-key kem`. With it, the hub file carries these keys and the hub can open keys wrapped with post-quantum protection. Without it the hub works as before. |

Build the image first, then make the key lines (the third is optional; to use it, also list `hub_kem_key` under the hub's secrets in `relay/compose.yaml`). Each command prints one line and writes nothing else; the `umask` keeps the new file private from the moment it exists:

```sh
docker compose -f relay/compose.yaml --profile hub build hub
(umask 077; docker run --rm --network none near-ai-hub:local /app/bin.mjs --generate-key signing > relay/secrets/hub/hub_signing_key)
(umask 077; docker run --rm --network none near-ai-hub:local /app/bin.mjs --generate-key encryption > relay/secrets/hub/hub_encryption_key)
(umask 077; docker run --rm --network none near-ai-hub:local /app/bin.mjs --generate-key kem > relay/secrets/hub/hub_kem_key)
```

Without Docker, a checkout with Node 26.13.1 does the same: `cd hub && npm ci --ignore-scripts && npm run build`, then `node hub/dist/bin.mjs --generate-key signing` from the repository root.

Print the certificate's pin now (above) and note it: once the files belong to the hub's user you need `sudo` to read them. Then give the four files to the hub's user, 65532, with mode 0400. Compose keeps the host file's owner and mode, so this is what the container sees:

```sh
sudo chown 65532:65532 relay/secrets/hub/*
sudo chmod 0400 relay/secrets/hub/*
```

Keep these files out of the hub's state volume and out of its backups. They are the hub's identity: anyone holding them can act as your organization's hub, and losing them means the staff lead must admit a new hub. Back them up on their own, as privately as any other key.

### Running with Compose

The hub's settings go in a small file of Compose variables, `relay/secrets/hub.env`, so every command below uses the same ones. The `relay/secrets` folder is ignored by git.

```sh
cat > relay/secrets/hub.env <<'EOF'
NEAR_AI_HUB_PUBLIC_ADDRESS=hub.example.test:8443
NEAR_AI_HUB_PUBLISH_ADDRESS=192.0.2.10
EOF
docker compose -f relay/compose.yaml --env-file relay/secrets/hub.env --profile hub up -d --build hub
docker compose -f relay/compose.yaml --env-file relay/secrets/hub.env --profile hub ps hub
```

`ps` shows the hub as `healthy` within a few seconds. Compose variables, all prefixed `NEAR_AI_HUB_` so the hub's own check of `HUB_` settings never sees them:

| Variable | Default | Meaning |
| --- | --- | --- |
| `NEAR_AI_HUB_PUBLIC_ADDRESS` | not set | The host name and port members' computers use, such as `hub.example.test:8443`. The port is required. The hub serves without it, but cannot print a hub file. |
| `NEAR_AI_HUB_PUBLISH_ADDRESS` | `127.0.0.1` | The address on this machine the hub's port is published on. Until you set it, nothing outside this machine reaches the hub. Set it to the address of the interface members reach, and use `0.0.0.0` only when every interface of the machine should accept the hub's port. |
| `NEAR_AI_HUB_PUBLISH_PORT` | `8443` | The port on that address. |
| `NEAR_AI_HUB_SECRETS_DIR` | `relay/secrets/hub` | The folder that holds the four secret files. A relative path is read from the `relay` folder. |
| `NEAR_AI_HUB_IMAGE` | `near-ai-hub:local` | The name of the image to build and run. |

What the container gives you is what the relay's gives (see [Running with Compose](#running-with-compose)): a shell-less distroless image run as user 65532, a read-only root filesystem, every capability dropped, no-new-privileges, a 16 MB private `/tmp`, limits of 128 processes and 512 MB of memory, and the volume `hub-state` (named `near-ai-relay_hub-state` by Docker) as its only writable path, mounted at `/var/lib/near-ai-hub`.

A reverse proxy in front of the hub must pass TCP through and never end TLS: members' computers bind their session to the hub's own TLS connection, and a proxy that ends TLS breaks that binding, so nothing works through it. Behind a pass-through proxy every member appears to come from the proxy's address, so the hub's per-address limits (120 session openings, 10 join requests and 10 enrolments a minute, 300 event streams) apply to all of them together. A member's computer keeps its connection, and so its session, for 2 minutes between requests, so a site does not spend a session opening on every exchange.

Slow links are expected. The hub wants a request's headers within 5 seconds; a body then gets 10 seconds, after which it must keep arriving at 16 KiB a second (128 kbit/s) or faster, so an 8 MiB attachment can take about eight and a half minutes. A client that trickles or stops is cut off with `408` within about a second of falling behind, and the hub logs `http.rejected` with route `slow-upload`. Stopping the hub ends any upload still arriving, so it stops within its grace; the member's computer sends it again on its next exchange.

### The hub file and enrolment

Nobody can put a project on the hub without a hub file from you. A hub file (`.near-staff-hub`) names the hub, its address, its certificate pin and its public keys, and carries a one-time enrolment secret, all signed by the hub's own key. To print one that expires in 7 days, while the hub is running:

```sh
(umask 077; docker compose -f relay/compose.yaml --env-file relay/secrets/hub.env --profile hub exec -T hub \
  /nodejs/bin/node /app/bin.mjs --hub-file 7 > hub.near-staff-hub)
```

- The number is the days until it expires, from 1 to 30; 7 when you leave it out.
- One hub file connects one project. The staff lead's computer admits the hub to the project's member list from it and then enrols the project with it; a second project needs a new file. The editor command the staff lead uses for this arrives in a later release.
- Treat it like a password until it is used: give it to the staff lead privately. Anyone holding it could put a project of their own on your hub. One that is lost or not needed can simply be left to expire.
- The hub keeps only a hash of the enrolment secret. It does not store the secret: it derives it again from its own encryption key and the file's enrolment id when the project is enrolled. So a hub whose encryption key changed refuses every hub file it printed before; print new ones.
- It prints nothing but the file. When it cannot (no public address set, days outside 1 to 30), it prints one `hub.start_refused` line instead and exits 1.

### Health and logs

`GET /healthz` returns three fields: `version`, `uptimeSeconds` and `store` (`ok`, or `down` when the hub's store is damaged), with 200 when healthy and 503 when not. The container healthcheck runs `node /app/bin.mjs --healthcheck` against the hub itself.

The hub logs one JSON line per event, through a redacting logger. Lines name a project id, an invitation id, counts and reason words, and never a key, a token, a secret or the content of a project. Read them with `docker compose -f relay/compose.yaml --env-file relay/secrets/hub.env --profile hub logs hub`. The lines to know:

| Event | Meaning |
| --- | --- |
| `hub.listening` | Started. Carries the hub's writer id and its public address. |
| `hub.start_refused` | Did not start, with a reason word (`config`, `secrets`, `state-dir`, `keys`, `tls`, `store`, `listen`) and a plain sentence. |
| `store.damaged`, `store.recovered` | The store found a missing blob file (restore from a backup), or cleaned up after an interrupted write. |
| `checkpoint.signed` | A checkpoint was signed for a project. |
| `checkpoint.waiting` | After a restore, the hub holds checkpoints that members handed back but not yet every change they cover, so it signs nothing for that project until members push those changes again. |
| `hub.restore-started`, `hub.restore-ended` | The hub started in restore mode because the state folder holds the marker `restore-mode`, and later left it (reason `members-synced` or `marker-removed`). |
| `checkpoint.conflict` | The checkpoints the hub holds for a project do not form one history, so it signs nothing more for it (see the restore drill). |
| `checkpoint.trimmed`, `checkpoint.too_large` | A checkpoint was too large and left out some parts the hub was granted, or could not be made small enough. |
| `checkpoint.failed` | Signing a checkpoint failed with an error; the next change tries again. |
| `invite.locked` | An invitation was locked after 5 wrong tries. |

### Backups

The hub's state is one folder in the volume `hub-state`: the database `hub.db` (with `hub.db-wal` when present) and the folder `blobs/`. Back it up only while the hub is stopped, and keep the key files out of it.

The image has no shell, so the copy is made by the image's own Node, as the hub's user, into a folder that only that user can read:

```sh
docker compose -f relay/compose.yaml --env-file relay/secrets/hub.env --profile hub stop hub
mkdir -m 0700 hub-backup-2026-11-20
sudo chown 65532:65532 hub-backup-2026-11-20
docker run --rm --network none --user 65532:65532 \
  -v near-ai-relay_hub-state:/var/lib/near-ai-hub:ro -v "$PWD/hub-backup-2026-11-20:/backup" \
  near-ai-hub:local -e "require('node:fs').cpSync('/var/lib/near-ai-hub', '/backup/state', { recursive: true })"
docker compose -f relay/compose.yaml --env-file relay/secrets/hub.env --profile hub start hub
```

Keep the backup as private as the key files, but apart from them. Back up often: a restore loses everything after the backup, and members' computers must push it back (below), so the newer the backup, the less they have to do.

### Restoring from a backup

Members' computers notice a hub that shows them less than they already saw. After an honest restore they call the hub rolled back once, hand back the newer checkpoints they hold, and push again what the hub lost; the hub waits (`checkpoint.waiting`) until it holds everything those checkpoints cover, then signs again.

One limit needs care. To a member's computer, an honest restore and a hub that shows different people different histories look the same when new work reaches the restored hub before every computer has handed back what it holds. A computer that held a checkpoint the restore lost then calls the hub forked as well as rolled back, and stops trusting it. So restore like this:

1. Ask the staff lead to tell every member: sync, and make no new changes in the project, until told otherwise.
2. Save the current state too, with the backup commands above into another folder, before replacing it.
3. Put the backup in place of the volume's contents and start the hub:

   ```sh
   docker compose -f relay/compose.yaml --env-file relay/secrets/hub.env --profile hub stop hub
   docker run --rm --network none --user 65532:65532 \
     -v near-ai-relay_hub-state:/var/lib/near-ai-hub -v "$PWD/hub-backup-2026-11-20:/backup:ro" \
     near-ai-hub:local -e "
       const fs = require('node:fs');
       const dir = '/var/lib/near-ai-hub';
       for (const name of fs.readdirSync(dir)) fs.rmSync(dir + '/' + name, { recursive: true });
       fs.cpSync('/backup/state', dir, { recursive: true });
       fs.writeFileSync(dir + '/restore-mode', '', { mode: 0o600 });"
   docker compose -f relay/compose.yaml --env-file relay/secrets/hub.env --profile hub start hub
   ```

   The last line writes the marker file `restore-mode`. With it the hub starts in restore mode (`hub.restore-started`): it takes back only changes that a checkpoint it kept, or one a member hands back, already covers, and answers anything newer with "being restored, send again in a moment" until members have handed back what they hold.
4. Let every member's computer sync. Watch the logs: `checkpoint.waiting` names projects that still miss changes, and `checkpoint.signed` follows once a project is whole again. The hub leaves restore mode by itself once every member's computer has asked it for a checkpoint since the restart, removes the marker and logs `hub.restore-ended`. To end it early, remove the file `restore-mode` from the state folder; the hub notices within 30 seconds.
5. When the staff lead has confirmed that every device has synced, and the logs show no `checkpoint.waiting` after the last of them reconnected, members may make changes again.

If a member's computer still names the hub forked after an honest restore, it keeps refusing the hub, which is the safe choice. That member keeps working by file, or through another hub, until the staff lead or the deputy re-admits it (Re-admit your organization's server). To re-admit:

1. In Share with people, SovAI shows the staff lead twelve words worked out from the certificate pin of the hub it now reaches.
2. Print the hub's own twelve words while it is running:

   ```sh
   docker compose -f relay/compose.yaml --env-file relay/secrets/hub.env --profile hub exec -T hub \
     /nodejs/bin/node /app/bin.mjs --pin-words
   ```

   It prints one line of twelve words and nothing else, worked out from the hub's certificate with the same function members' computers use. It reads only the certificate and its key, and writes nothing. Without Docker, `node hub/dist/bin.mjs --pin-words` does the same with `HUB_TLS_CERT_FILE` and `HUB_TLS_KEY_FILE` set. When it cannot read them, it prints one `hub.start_refused` line instead and exits 1.
3. Read the words to the staff lead in order, by phone or in person, not through the project. When they match, the lead chooses **Trust your organization's server again**, which clears the finding on every member's computer once. When they differ, the server SovAI reaches is not this hub with this certificate: tell the lead not to trust it, and find out why first.

Right after a restore, `checkpoint.conflict` with the reason `order-mismatch` can clear by itself: it means a member handed back a checkpoint that comes after one the hub does not hold yet, and signing resumes once another member hands that one back. A related gap remains: the hub may have signed a checkpoint that no member's computer ever received, with later checkpoints coming after it. If a restore loses it, no computer can hand it back, and the hub signs nothing more for that project until it is started again on a state whose checkpoints agree (for example a newer backup that still holds that checkpoint). Changes still sync in the meantime, but members' computers will in time report the hub as delayed. `checkpoint.conflict` with any other reason (`not-nested`, `equal-count-tip-mismatch`) means the hub's own record does not agree with itself and never clears: tell the staff lead, who re-admits the hub after comparing the words `--pin-words` prints (above).

### The restore drill

When members can connect projects from the editor, practise a restore before you need one, on a test project:

1. Take a backup.
2. Make a change from two members' computers and let both sync.
3. Ask both members to stop changing the project, restore the backup with the marker file `restore-mode` (step 3 above) and start the hub.
4. Let both computers sync. Each should say once that the hub was rolled back, then nothing more.
5. Check the logs: `hub.restore-ended` appears once both computers have synced, `checkpoint.waiting` lines stop and a `checkpoint.signed` line follows, with no `checkpoint.conflict`.
6. Check that both computers show both changes.

Until then, the hub's own test suite runs this drill on every change (`hub/test/restoreDrill.test.ts`), and you can practise the backup and restore commands on a hub with no projects: after the restore it must start and show `healthy`.

### Upgrades

1. Take a backup.
2. Update this repository to the new release.
3. Rebuild and restart the hub:

   ```sh
   docker compose -f relay/compose.yaml --env-file relay/secrets/hub.env --profile hub up -d --build hub
   ```

4. Check that `ps` shows it `healthy` and the logs show `hub.listening`.

The store's schema is version 1. A newer hub that changes it upgrades the store when it starts; each step of the upgrade either completes or leaves the store as it was. An older hub refuses a store a newer one has written, with a plain sentence; to go back, start the newer hub again or restore the backup you took before the upgrade, following the restore steps above.

### Changing a key or the certificate

- **A renewed certificate with the same key**: replace `hub_tls_cert` (owned by 65532, mode 0400 as before) and recreate the container so it reads the new file: `docker compose -f relay/compose.yaml --env-file relay/secrets/hub.env --profile hub up -d --force-recreate hub`. The pin stays, so members notice nothing.
- **A new TLS key, signing key or encryption key**: the hub becomes a different hub to every project. Replace the files and recreate the container as above, then print a new hub file for each project; the staff lead revokes the old hub and admits it again from the new file. Revoking moves every part of the project the hub held to a new key.

### What the hub can read

The hub holds the key of the part of each project every member holds. That part carries the member list: the names, seats and declared clearances of the people in the project, and their devices. So your organization's hub server holds the staff list of every project connected to it.

It reads nothing else unless the staff lead grants it a part of the project, such as one whose watches must run when nobody is at a computer (watches arrive in a later release). The staff lead is shown this sentence before a grant: "The hub will be able to read everything in this cell. Anyone who takes over the hub server can read it too. Grant only cells whose watches must run when nobody is at a computer."

Everything else stays sealed: the hub stores and passes on product text, labels, decisions and attachments of the other parts only as ciphertext. It still sees metadata: project, part and device ids, sizes and timing, and who is active in which part. SECURITY.md has the full list, and the test that shows each point, under "Your organization's sync hub".
