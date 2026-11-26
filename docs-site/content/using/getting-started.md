---
sidebar_label: Getting started
sidebar_position: 1
---

# Getting started

The **Sterling workbench** runs on your computer in a container. Open it in your local browser.
The release image includes Eclipse Theia and the SovAI extension. The release build uses the VSIX
to bundle the extension into the image, so workstation setup requires only the container image.

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

To start the Workbench, pass the exact approved image reference for the platform the check reports.
The current `sterling-image.txt` supplies the Linux x86-64 release. A signed Linux ARM64 release image
is pending.

```bash
IMAGE='ghcr.io/vitalpointai/near-ai-vscode@sha256:REPLACE_WITH_RELEASE_DIGEST'
node scripts/launch-local-workbench.mjs --image "$IMAGE"
```

The launcher checks the host architecture, runtime and image before starting a container. The image
must already be local. Add `--repair` to allow it to fetch that exact digest if it is missing. If the
launcher reports a Docker install, upgrade or access requirement, resolve it through your host's
administrator or software manager. Use the URL it prints after the health check succeeds. Running
the command again with the same digest keeps the same container and workspace volume.

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
   each page of the extension its own origin.
4. Open or create a project folder. In **SovAI Chat**, choose **Set up a new profile**, or run
   **SovAI: Set Up a New Profile** from the Command Palette. Choose a local runtime and enter the
   address of an approved compatible model server that the container can reach. For this local
   preview, use a server that accepts requests without an API key. `localhost` inside the container
   refers to the container itself. Use an approved HTTPS address when the server runs outside that
   container's loopback interface.
5. Start chatting when the connection check passes. You can also set up a project team or explore
   a sample team.

The workbench opens the Sterling Get Started page for the Canadian Defence Edition, or the page of
the work area you open. Get Started has **Set up Sterling**, **Open Chat** and **Explore a sample
agent team**, which opens read-only Team Studio samples, and a card for each Defence work area:
Capability Development, Exercises & Training, Planning and Resource Management. From the right
sidebar you can open:

- **Get Started**, **Portfolio**, **Team Studio**, **Agent Activity** and **Governance**;
- **Chat**, which slides the chat drawer open and closed;
- **Documentation**, the guides bundled with the image, which you can search without a network;
- **Compliance**, which shows control states only from an evidence bundle checked for the same
  release. The image starts without one, so the view says so until you give it one.

The SovAI extension is also inside, so **SovAI: Set Up a New Profile** and the other SovAI
commands are in the Command Palette.

Keep in mind:

- The workspace lives inside the container, at `/home/sterling/workspace`. To work with a folder
  from your computer, mount it explicitly when you create the container.
- The local preview has no secret store. Profiles that need a saved API key cannot finish setup
  here. The planned hosted workbench uses your organization's secret store.
- `docker stop sterling` and `docker start sterling` stop and restart the same container.

Hosting the workbench for many people, with sign-in, at your organization's own sites is planned
and not yet released. See [Hosting for many people](../architecture/overview.md#hosting-for-many-people-planned-not-yet-released).

## Optional hub for shared staff projects

You can use your local workbench without a hub. Your organization's administrator runs the hub on a
shared server that participating workstations can reach. The current release lets administrators
deploy and prepare the hub. Connecting an editor project to the hub arrives in a later release.
See the [hub operator guide](https://github.com/VitalPointAI/near-ai-vscode/blob/main/relay/README.md#your-organizations-sync-hub).
The hosted site deployment in the repository includes a
[Helm definition for the hub](https://github.com/VitalPointAI/near-ai-vscode/tree/main/deploy/hub).

## More help

For what each feature does and every setting, see [Features and settings](./features.synced.md).
If something does not work, see [Troubleshooting](./features.synced.md#troubleshooting).
