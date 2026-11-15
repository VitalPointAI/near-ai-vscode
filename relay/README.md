# NEAR AI relay (foundation)

The relay is its own small service for NEAR AI chats that arrive from Microsoft Teams and Signal. It lives in this folder with its own `package.json` and lockfile. It is not the extension, it is not the extension's sync feature, and it is never shipped in the extension's VSIX.

This version is the foundation only. It starts, keeps a private state folder and a small database, loads its secrets safely, writes redacted logs, and answers a health check. It does not receive or send any Teams or Signal message yet. Those channels arrive in later phases.

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
| `npm test` | Builds and runs the unit and integration tests. It does not need Docker. |
| `npm run test:container` | Builds the image and runs the container suite (Docker and Compose required). It makes only its own uniquely named image, Compose project and volume, and removes them again. |
| `npm start` | Starts the built relay from `dist/bin.mjs`. Run `npm run build` first. |

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
- Back it up only while the relay is stopped, and keep the backup as private as the folder.

## Secrets

The relay takes every secret from a file and from nowhere else. For a secret named `NAME` it looks, in this order, at:

1. the file named by `NAME_FILE`,
2. `$CREDENTIALS_DIRECTORY/name` in lower case (systemd credentials),
3. `/run/secrets/name` in lower case (Compose and Docker secrets).

A secret file must be mode 0400 or 0600 with no group or world access. A secret given as a plain environment value (for example `TEAMS_APP_SECRET=...`) is refused, because environment values show up in `docker inspect` and in process listings. Error messages name the secret and never print its value or any part of the file.

The kinds of secret in your deployment:

- The Teams bot app secret (`TEAMS_APP_SECRET`).
- A NEAR AI API key for your organization, and one for each other organization the relay serves, named `NEAR_AI_KEY_` plus a tenant name in capitals, for example `NEAR_AI_KEY_ACME`. These are used in later phases.
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
- The port published on `127.0.0.1` only. TLS for the public Teams webhook ends at your reverse proxy on the host, which the Phase 76 runbook covers. Never publish the relay's port on all interfaces.

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

- It is pinned by tag and digest: `0.101` plus its sha256. That tag bundles signal-cli 0.14.8. Re-check the tag and re-pin it before about 2026-12-10 (Phase 75 does this).
- It publishes no port. Only the relay, on the Compose network, can reach it.
- Its `signal-config` volume is the Signal registration. Treat it like a password: back it up privately and never share it.

## Known limits

- One relay per state directory. Nothing stops a second relay from opening the same folder until Phase 71 adds a lock, so run only one.
- No Teams or Signal messages are handled yet.
- This is a foundation guide. The full operator runbook (reverse proxy, TLS, backups, upgrades) arrives in Phase 76.
