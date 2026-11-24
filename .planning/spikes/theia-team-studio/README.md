# Sterling in Eclipse Theia

The local workbench opens to Sterling Sovereign AI Canadian Defence Edition. Get Started shows the Sterling logo for the active theme and opens a native Team Studio preview with four packaged samples.

## Run locally

From the root of this checkout, build and start the preview with Docker.

```sh
docker build -f .planning/spikes/theia-team-studio/Dockerfile -t near-ai-theia-preview:local .
docker run --detach --name near-ai-theia-team-preview \
  --env STERLING_PREVIEW_NO_SIGN_IN=accept \
  --publish 127.0.0.1:18771:3000 near-ai-theia-preview:local
```

Open [Get Started](http://127.0.0.1:18771/) and select **Explore a sample team**. Reopen the page with the home icon at the top of the right sidebar or **SovAI: Get Started** in the command palette. **SovAI: Open Team Studio Preview** also opens the sample. Use the sample picker to switch between two valid teams, a sample without a team, and a sample with an invalid team. Select a member to see their role, reporting line, and instructions.

Use `docker stop near-ai-theia-team-preview` and `docker start near-ai-theia-team-preview` to stop and restart the same container.

**Publish it on `127.0.0.1` only.** The preview has no sign-in and includes a terminal, so anyone who can reach its port gets a shell as the container's `node` user. It listens on every interface inside the container, because port mapping needs that, so the safety comes from `--publish 127.0.0.1:…`. Never use `-p 3000:3000` or publish it on a shared host. The image refuses to start until you pass `--env STERLING_PREVIEW_NO_SIGN_IN=accept` to confirm this. Sign-in and per-person sessions come in Phase 46 and Phase 47.

The container runs as the unprivileged Node user. Its runtime holds only production dependencies: the Theia CLI, bundlers and compilers stay in the build stage. The examples are synthetic. This preview has no host workspace mounts, provider credentials, or agent run controls.

## Run the existing extension in Theia

Build the same image as above. From this checkout, run `npm ci` and `npm run package` to build a VSIX with the Theia command fixes. Unpack that VSIX into the ignored local plugin directory, then start a separate container with that directory mounted read-only. The VSIX runs with a new container-side workspace and no host home or provider credentials. The local session disables automatic GSD installation.

```sh
mkdir -p .planning/spikes/theia-team-studio/local-plugins
unzip -q ./near-ai-vscode-*.vsix 'extension/*' \
  -d .planning/spikes/theia-team-studio/local-plugins

docker run --detach --name near-ai-theia-vsix \
  --publish 127.0.0.1:18874:3000 \
  --mount "type=bind,source=$PWD/.planning/spikes/theia-team-studio/local-plugins,target=/plugins,readonly" \
  --env THEIA_DEFAULT_PLUGINS=local-dir:///plugins \
  --env STERLING_PREVIEW_NO_SIGN_IN=accept \
  near-ai-theia-preview:local \
  node lib/backend/main.js /home/node/workspace --hostname 0.0.0.0 --port 3000 \
  --session-preference nearAi.autoInstallGsd=false
```

Open [the VSIX workbench](http://localhost:18874/) using `localhost` so Theia can use separate `*.webview.localhost` origins. From the command palette choose **NEAR AI: Set Up**, **NEAR AI: Team Studio**, or **NEAR AI: Open Chat**. The compatibility container is for synthetic projects and has an in-memory credential store.

## Research

Theia provides both a VS Code extension host and native application extensions. The native widget uses the Theia workbench and calls the backend through Theia JSON-RPC. See [Theia native extensions](https://theia-ide.org/docs/authoring_extensions/), [Theia JSON-RPC](https://theia-ide.org/docs/json_rpc/), and [VS Code extension support](https://theia-ide.org/docs/authoring_vscode_extensions/).

The parser carries over directly. The current VS Code extension declares VS Code 1.101 or later and also uses webview panels and the chat participant API. The container includes the pinned Theia VS Code extension host for running the VSIX alongside the native widget. Native ports also need to wire real project selection, workspace file access, and writes through the new host.

## Results

The browser container builds from the pinned dependencies and runs on localhost. Chromium verified that the widget opens, both valid projects load, member details show the reporting line, missing and invalid projects display their own messages, and returning to a valid project restores the roster. The backend uses the existing parser without changes.

See [Theia migration and acceptance](MIGRATION.md) for the full extension cutover.
