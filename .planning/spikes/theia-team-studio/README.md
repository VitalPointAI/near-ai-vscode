# Team Studio in Eclipse Theia

Can a native Theia view reuse the existing Team Studio data model in a browser container? This preview uses a native Theia widget and RPC service with the extension's existing team parser. It reads four packaged sample projects.

## Run locally

From the root of this checkout, build and start the preview with Docker.

```sh
docker build -f .planning/spikes/theia-team-studio/Dockerfile -t near-ai-theia-preview:local .
docker run --detach --name near-ai-theia-team-preview \
  --publish 127.0.0.1:18771:3000 near-ai-theia-preview:local
```

Open [Team Studio](http://127.0.0.1:18771/). If you close the tab inside the workbench, run **NEAR AI: Open Team Studio Preview** from the command palette. Use the project picker to switch between two valid teams, a project without a team, and a project with an invalid team. Select a member to see their role, reporting line, and instructions.

Use `docker stop near-ai-theia-team-preview` and `docker start near-ai-theia-team-preview` to stop and restart the same container.

The container runs as the unprivileged Node user and binds to localhost on the host. The examples are synthetic. This preview has no host workspace mounts, provider credentials, or agent run controls.

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
  near-ai-theia-preview:local \
  node_modules/.bin/theia start /home/node/workspace --hostname 0.0.0.0 --port 3000 \
  --session-preference nearAi.autoInstallGsd=false
```

Open [the VSIX workbench](http://localhost:18874/) using `localhost` so Theia can use separate `*.webview.localhost` origins. From the command palette choose **NEAR AI: Set Up**, **NEAR AI: Team Studio**, or **NEAR AI: Open Chat**. The compatibility container is for synthetic projects and has an in-memory credential store.

## Research

Theia provides both a VS Code extension host and native application extensions. The native widget uses the Theia workbench and calls the backend through Theia JSON-RPC. See [Theia native extensions](https://theia-ide.org/docs/authoring_extensions/), [Theia JSON-RPC](https://theia-ide.org/docs/json_rpc/), and [VS Code extension support](https://theia-ide.org/docs/authoring_vscode_extensions/).

The parser carries over directly. The current VS Code extension declares VS Code 1.101 or later and also uses webview panels and the chat participant API. The container includes the pinned Theia VS Code extension host for running the VSIX alongside the native widget. Native ports also need to wire real project selection, workspace file access, and writes through the new host.

## Results

The browser container builds from the pinned dependencies and runs on localhost. Chromium verified that the widget opens, both valid projects load, member details show the reporting line, missing and invalid projects display their own messages, and returning to a valid project restores the roster. The backend uses the existing parser without changes.

See [Theia migration and acceptance](MIGRATION.md) for the full extension cutover.
