---
sidebar_label: Getting started
sidebar_position: 1
---

# Getting started

There are two ways to try the product: the **Sterling Sovereign AI** extension in your own VS Code,
or the **Sterling workbench**, a browser-based editor that runs from a container image with the
same extension inside it. Both come from the same release.

A guided setup that asks a few plain questions and lands you where your work is is being built.
Until it ships, the steps below and in the README are the way in:
[Get started in two minutes](./features.synced.md#get-started-in-two-minutes).

## Where each release is

Releases are no longer published to the Visual Studio Marketplace. Each release from 0.4.38 on is
on the repository's [releases page](https://github.com/VitalPointAI/near-ai-vscode/releases)
with:

- the extension package, `near-ai-vscode-X.Y.Z.vsix`, and its SHA-256 checksum;
- the Sterling workbench image, recorded by its digest in `sterling-image.txt` and in the release
  notes;
- the assessor package for your organization's security assessment.

## Use the extension in VS Code

You need VS Code 1.101 or newer.

1. Download `near-ai-vscode-X.Y.Z.vsix` and `near-ai-vscode-X.Y.Z.vsix.sha256` from the release.
2. Check the download: `sha256sum --check near-ai-vscode-X.Y.Z.vsix.sha256` should print `OK`.
3. In VS Code, run **Extensions: Install from VSIX...** from the Command Palette and choose the file.
4. Open a project folder, open the **SovAI** chat and set up a profile: your NEAR AI key, a model
   runtime on this computer, or both.
5. Once it connects, the chat suggests what to do next, starting with a team for your project.

Then pick the guide for your role from the menu: software projects, staff teams, data and
connections, or administration and your organization's rules.

## Run the Sterling workbench image

The image is a **local preview** for one person on one computer. It has no sign-in of its own and
includes a terminal, so anyone who can reach its port gets a shell inside the container. Publish
it on `127.0.0.1` only, never on a shared address. The image refuses to start until you pass
`STERLING_PREVIEW_NO_SIGN_IN=accept` to confirm this.

You need Docker, or another tool that runs container images, on a 64-bit Intel or AMD (`linux/amd64`)
computer. If the registry asks you to sign in, run `docker login ghcr.io` with a GitHub account
that can read the repository's packages.

1. Copy the image reference from `sterling-image.txt` on the release. It looks like
   `ghcr.io/vitalpointai/near-ai-vscode@sha256:...`. Pulling by digest gets exactly the image that
   was tested; the tag `ghcr.io/vitalpointai/near-ai-vscode:vX.Y.Z` names the same release.
2. Start it, published on this computer only:

   ```bash
   docker run --detach --name sterling \
     --env STERLING_PREVIEW_NO_SIGN_IN=accept \
     --publish 127.0.0.1:3000:3000 \
     ghcr.io/vitalpointai/near-ai-vscode@sha256:<digest from sterling-image.txt>
   ```

3. Open [http://localhost:3000/](http://localhost:3000/). Use `localhost`, so the workbench can give
   each page of the extension its own origin.

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

- The workspace lives inside the container, at `/home/node/workspace`. Nothing on your computer is
  shared with it unless you mount it yourself.
- Secrets you enter may not survive a restart of the container yet. Durable secrets for each person
  come with hosting at your organization's sites.
- `docker stop sterling` and `docker start sterling` stop and restart the same container.

Hosting the workbench for many people, with sign-in, at your organization's own sites is planned
and not yet released. See [Hosting for many people](../architecture/overview.md#hosting-for-many-people-planned-not-yet-released).

## More help

For what each feature does and every setting, see [Features and settings](./features.synced.md).
If something does not work, see [Troubleshooting](./features.synced.md#troubleshooting).
