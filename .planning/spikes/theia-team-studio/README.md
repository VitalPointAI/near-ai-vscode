# Sterling in Eclipse Theia

The Docker workbench opens to Sterling Get Started. Set up a project or open Chat from the welcome page. The native Team Studio sample uses the extension's existing team parser and four packaged sample projects.

## Run locally

From the root of this checkout, build and start the preview with Docker.

```sh
docker build -f .planning/spikes/theia-team-studio/Dockerfile -t near-ai-theia-preview:local .
docker run --detach --name near-ai-theia-team-preview \
  --publish 127.0.0.1:18771:3000 near-ai-theia-preview:local
```

Open [Get Started](http://127.0.0.1:18771/) and choose **Explore a sample team**. Use **SovAI: Get Started** or **SovAI: Open Team Studio Preview** to reopen either tab from the command palette. Use the project picker to switch between two valid teams, a project without a team, and a project with an invalid team. Select a member to see their role, reporting line, and instructions.

Use `docker stop near-ai-theia-team-preview` and `docker start near-ai-theia-team-preview` to stop and restart the same container.

The container runs as the unprivileged Node user and binds to localhost on the host. The examples are synthetic. This preview has no host workspace mounts, provider credentials, or agent run controls.

## Run the existing extension in Theia

Build the same image as above. Unpack a trusted release VSIX into the ignored local plugin directory, then start a separate container with that directory mounted read-only. The VSIX runs with a new container-side workspace and no host home or provider credentials. This sample session disables automatic GSD installation. If Theia asks whether you trust the sample workspace, choose Restricted Mode to explore without trusting it.

```sh
mkdir -p .planning/spikes/theia-team-studio/local-plugins
unzip -q /path/to/near-ai-vscode-0.4.36.vsix 'extension/*' \
  -d .planning/spikes/theia-team-studio/local-plugins

docker run --detach --name near-ai-theia-vsix \
  --publish 127.0.0.1:18874:3000 \
  --mount "type=bind,source=$PWD/.planning/spikes/theia-team-studio/local-plugins,target=/plugins,readonly" \
  --env THEIA_DEFAULT_PLUGINS=local-dir:///plugins \
  near-ai-theia-preview:local \
  node_modules/.bin/theia start /home/node/workspace --hostname 0.0.0.0 --port 3000 \
  --session-preference nearAi.autoInstallGsd=false
```

Open [the VSIX workbench](http://localhost:18874/) using `localhost` so Theia can use separate `*.webview.localhost` origins. The Get Started page links to project setup, Chat, Teams, Activity, and Governance. The Chat icon opens the conversation drawer. The compatibility container is for synthetic projects and has an in-memory credential store.

## Research

Theia provides both a VS Code extension host and native application extensions. The native widget uses the Theia workbench and calls the backend through Theia JSON-RPC. See [Theia native extensions](https://theia-ide.org/docs/authoring_extensions/), [Theia JSON-RPC](https://theia-ide.org/docs/json_rpc/), and [VS Code extension support](https://theia-ide.org/docs/authoring_vscode_extensions/).

The parser carries over directly. The current VS Code extension declares VS Code 1.101 or later and also uses webview panels and the chat participant API. The container includes the pinned Theia VS Code extension host for running the VSIX alongside the native widget. Native ports also need to wire real project selection, workspace file access, and writes through the new host.

## Results

The browser container builds from the pinned dependencies and runs on localhost. Chromium verified that the widget opens, both valid projects load, member details show the reporting line, missing and invalid projects display their own messages, and returning to a valid project restores the roster. The backend uses the existing parser without changes.

See [Theia migration and acceptance](MIGRATION.md) for the full extension cutover.

## Hero artwork

The built-in ImageGen tool generated [the Sterling hero](extension/assets/sterling-hero.webp). The app animates the image and a light sweep in CSS and honors reduced-motion preferences.

> Editorial 3D hero image for the Sterling sovereign AI desktop workbench. A polished, monumental brushed-silver torus assembled from precisely machined interlocking arc segments floats above a dark graphite circular platform. A fine translucent icy-blue light traces one arc and echoes in thin concentric rings on the floor. Futuristic, architectural, restrained and tactile, with a soft cobalt atmospheric horizon, deep ink shadows, realistic metal reflections and a little film grain. Wide landscape composition, sculpture centred around 56% width, usable empty dark navy first quarter on the left for HTML text, generous framing. Clean high-end industrial photography, no text, no logos, no interface, no watermark.
