---
sidebar_label: Getting started
sidebar_position: 1
---

# Getting started

The **Sterling workbench** runs on your computer in a container. Open it in your local browser.
The release image includes Eclipse Theia and the SovAI extension. The release build uses the VSIX
to bundle the extension into the image, so workstation setup requires only the container image.

See [Recommended hardware and configuration](./deployment-hardware.md) to choose a workstation,
hub, or site setup.

## Run the Sterling workbench image

The image is a **local preview** for one person on one computer. It has no sign-in of its own and
includes a terminal, so anyone who can reach its port gets a shell inside the container. Publish
it on `127.0.0.1` only. The internal listen address used below requires
`STERLING_PREVIEW_NO_SIGN_IN=accept`.

The current Workbench release is a Linux x86-64 container image. Docker calls this platform
`linux/amd64`, which covers 64-bit Intel and AMD processors. The Workbench connects to the
compatible model server you configure. That server can run on a separate machine.
If the registry asks you to sign in, run `docker login ghcr.io` with a GitHub account that can
read the repository's packages.

### Use the local launcher

Run the launcher on a Linux x86-64 or ARM64 workstation with Node.js 26.13.1 or newer in the
Node.js 26 series and a local Docker Engine 28 or newer. From a repository checkout, check the
workstation before downloading an image. The check reports the required image platform and makes
no Docker changes. If your shell says `node` is missing, install the supported Node.js version first.

```bash
node scripts/launch-local-workbench.mjs --check
```

On the [releases page](https://github.com/VitalPointAI/near-ai-vscode/releases), open the approved
release and copy the image reference from `sterling-image.txt`. The current file points to the
Linux x86-64 image. A signed Linux ARM64 release image is pending.

On a fresh workstation, use `--repair` so the launcher can download that exact image if needed.
Replace the example value of `IMAGE` with the reference you copied.

```bash
IMAGE='ghcr.io/vitalpointai/near-ai-vscode@sha256:REPLACE_WITH_RELEASE_DIGEST'
node scripts/launch-local-workbench.mjs --image "$IMAGE" --repair
```

Open the URL the launcher prints after the health check succeeds, then
[set up your first project](#set-up-your-first-project). If the launcher reports a Docker install,
upgrade or access requirement, resolve it through your administrator or software manager.

Stop the Workbench on the same local Docker engine the launcher uses.

```bash
(
  unset DOCKER_CONTEXT DOCKER_HOST DOCKER_TLS DOCKER_TLS_VERIFY DOCKER_CERT_PATH \
    DOCKER_API_VERSION DOCKER_DEFAULT_PLATFORM
  docker --host unix:///var/run/docker.sock stop sterling-local-workbench
)
```

To restart it or launch with an image that is already available locally, set `IMAGE` to the same
approved reference and run
`node scripts/launch-local-workbench.mjs --image "$IMAGE"`. The launcher reuses the container and
its workspace volume when they already exist.

### Start manually

Use Docker Engine 28 or newer for the loopback publishing example below. Older Docker engines can
expose a port published to localhost to machines on the same network segment.
[Docker port publishing guidance](https://docs.docker.com/engine/network/port-publishing/)

1. On the [releases page](https://github.com/VitalPointAI/near-ai-vscode/releases), open the version
   you want and copy the image reference from `sterling-image.txt`. It looks like
   `ghcr.io/vitalpointai/near-ai-vscode@sha256:...`. Pulling by digest gets exactly the image that
   was tested; the tag `ghcr.io/vitalpointai/near-ai-vscode:vX.Y.Z` names the same release.
2. Start it, published on this computer only:

   ```bash
   IMAGE='ghcr.io/vitalpointai/near-ai-vscode@sha256:REPLACE_WITH_RELEASE_DIGEST'
   docker run --detach --name sterling \
     --env STERLING_LISTEN_HOST=0.0.0.0 \
     --env STERLING_PREVIEW_NO_SIGN_IN=accept \
     --publish 127.0.0.1:3000:3000 \
     "$IMAGE"
   ```

3. Open [http://localhost:3000/](http://localhost:3000/). Use `localhost`, so the workbench can give
   each page of the extension its own origin. Then [set up your first project](#set-up-your-first-project).

To stop the Workbench, run `docker stop sterling`. Run `docker start sterling` to restart the same
container. If you want to work with a folder from your computer, mount it explicitly when you
create the container.

### Set up your first project

1. Open or create a project folder. In **SovAI Chat**, choose **Set up a new profile**, or run
   **SovAI: Set Up a New Profile** from the Command Palette. Choose a local runtime and enter the
   address of an approved compatible model server that the container can reach. For this local
   preview, use a server that accepts requests without an API key. `localhost` inside the container
   refers to the container itself. Use an approved HTTPS address when the server runs outside that
   container's loopback interface.
2. Start chatting when the connection check passes. You can also set up a project team or explore
   a sample team.

The workbench opens the Sterling Get Started page for the Canadian Defence Edition, or the page of
the work area you open. Get Started has **Set up Sterling**, **Open Chat** and **Explore a sample
agent team**, which opens read-only Team Studio samples, and a card for each Defence work area:
Capability Development, Exercises & Training, Planning and Resource Management.

Choose **Open local Resource Inventory** below the cards, or **SovAI: Resource Inventory** in the
Command Palette. The view reads an existing `.planning/.near-ai/resource-inventory.snapshot.json`
from the selected trusted local workspace folder.

From the right sidebar you can open:

- **Get Started**, **Portfolio**, **Team Studio**, **Agent Activity** and **Governance**;
- **Chat**, which slides the chat drawer open and closed;
- **Documentation**, the guides bundled with the image, which you can search without a network;
- **Compliance**, which shows control states only from an evidence bundle checked for the same
  release. The image starts without one, so the view says so until you give it one.

The SovAI extension is also inside, so **SovAI: Set Up a New Profile** and the other SovAI
commands are in the Command Palette.

The workspace opens at `/home/sterling/workspace`. The local preview has no secret store.
Profiles that need a saved API key cannot finish setup here. The planned hosted workbench uses
your organization's secret store.

Hosting the workbench for many people, with sign-in, at your organization's own sites is planned
and not yet released. See [Hosting for many people](../architecture/overview.mdx#hosting-for-many-people-planned-not-yet-released).

## Optional hub for shared staff projects

You can use your local workbench without a hub. Your organization's administrator runs the hub on a
shared server that participating workstations can reach. The current release lets administrators
deploy and prepare the hub. Connecting an editor project to the hub arrives in a later release.
See the [hub operator guide](https://github.com/VitalPointAI/near-ai-vscode/blob/main/relay/README.md#your-organizations-sync-hub).
The hosted site deployment in the repository includes a
[Helm definition for the hub](https://github.com/VitalPointAI/near-ai-vscode/tree/main/deploy/hub).

### Run the Workbench and hub on the same development machine

On Linux x86-64, [start the Workbench with the local launcher](#use-the-local-launcher) and the
exact approved image digest. The browser address it prints after the health check is ready for
use. You can open a project and chat while the hub is stopped.

To run a local development hub alongside it, prepare an approved hub image on the same Docker
engine under a dedicated local tag. Prepare a separate directory with the four files described in
[Secret files](https://github.com/VitalPointAI/near-ai-vscode/blob/main/relay/README.md#secret-files).
Use a new Compose project name, an available loopback port and the absolute path to that secret
directory. Set those values and the local image tag in this block, then run it from the repository
root.

```bash
(
  unset DOCKER_CONTEXT DOCKER_HOST DOCKER_TLS DOCKER_TLS_VERIFY DOCKER_CERT_PATH \
    DOCKER_API_VERSION DOCKER_DEFAULT_PLATFORM
  export NEAR_AI_HUB_IMAGE='near-ai-hub:sterling-dev'
  export NEAR_AI_HUB_SECRETS_DIR='/absolute/path/to/dev-hub-secrets'
  export NEAR_AI_HUB_PUBLISH_ADDRESS='127.0.0.1'
  export NEAR_AI_HUB_PUBLISH_PORT='8443'
  export NEAR_AI_HUB_PUBLIC_ADDRESS=''

  hub_compose() {
    docker --host unix:///var/run/docker.sock compose -f relay/compose.yaml \
      -p sterling-dev-hub --profile hub "$@"
  }

  hub_compose up -d --no-build --pull never hub && hub_compose ps hub
)
```

The start command uses the prepared image. The hub is ready when `ps hub` reports it healthy.
To check status later, use the same block with `hub_compose ps hub` as its last command. To stop
the hub, use `hub_compose stop hub` there. Run the original block to restart it with the same
settings.

The hub keeps its database in the Compose project's volume. The Workbench keeps its project
files in the launcher's workspace volume. These are independent services. Project pairing and
enrollment are outside this development setup.

## More help

For what each feature does and every setting, see [Features and settings](./features.synced.md).
If something does not work, see [Troubleshooting](./features.synced.md#troubleshooting).
