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

You need Docker, or another tool that runs container images, on a 64-bit Intel or AMD (`linux/amd64`)
computer. If the registry asks you to sign in, run `docker login ghcr.io` with a GitHub account
that can read the repository's packages.

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
