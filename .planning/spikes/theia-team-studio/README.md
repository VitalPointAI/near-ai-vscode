# Sterling in Eclipse Theia

The Docker workbench opens to Sterling Get Started. Set up a project or open Chat from the welcome page. The native Team Studio sample uses the extension's existing team parser and four packaged sample projects.

## Run locally

From the root of this checkout, build and start the preview with Docker.

```sh
docker build -f .planning/spikes/theia-team-studio/Dockerfile -t near-ai-theia-preview:local .
docker run --detach --name near-ai-theia-team-preview \
  --publish 127.0.0.1:18771:3000 near-ai-theia-preview:local
```

Open [Get Started](http://127.0.0.1:18771/) and choose **Explore a sample team**. Use the home icon at the top of the right rail to reopen Get Started. **SovAI: Get Started** and **SovAI: Open Team Studio Preview** are also available from the command palette. Use the project picker to switch between two valid teams, a project without a team, and a project with an invalid team. Select a member to see their role, reporting line, and instructions.

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

Open [the VSIX workbench](http://localhost:18874/) using `localhost` so Theia can use separate `*.webview.localhost` origins. The Get Started page links to project setup, Chat, Teams, Activity, and Governance. The right rail opens Get Started, Documentation, Compliance, and Chat. The compatibility container is for synthetic projects and has an in-memory credential store.

## Research

Theia provides both a VS Code extension host and native application extensions. The native widget uses the Theia workbench and calls the backend through Theia JSON-RPC. See [Theia native extensions](https://theia-ide.org/docs/authoring_extensions/), [Theia JSON-RPC](https://theia-ide.org/docs/json_rpc/), and [VS Code extension support](https://theia-ide.org/docs/authoring_vscode_extensions/).

The parser carries over directly. The current VS Code extension declares VS Code 1.101 or later and also uses webview panels and the chat participant API. The container includes the pinned Theia VS Code extension host for running the VSIX alongside the native widget. Native ports also need to wire real project selection, workspace file access, and writes through the new host.

## Results

The browser container builds from the pinned dependencies and runs on localhost. Chromium verified that the widget opens, both valid projects load, member details show the reporting line, missing and invalid projects display their own messages, and returning to a valid project restores the roster. The backend uses the existing parser without changes.

See [Theia migration and acceptance](MIGRATION.md) for the full extension cutover.

## Hero artwork

The built-in ImageGen tool generated [the Sterling hero](extension/assets/sterling-hero.webp). The app animates the image and a light sweep in CSS and honors reduced-motion preferences.

> Editorial 3D hero image for the Sterling sovereign AI desktop workbench. A polished, monumental brushed-silver torus assembled from precisely machined interlocking arc segments floats above a dark graphite circular platform. A fine translucent icy-blue light traces one arc and echoes in thin concentric rings on the floor. Futuristic, architectural, restrained and tactile, with a soft cobalt atmospheric horizon, deep ink shadows, realistic metal reflections and a little film grain. Wide landscape composition, sculpture centred around 56% width, usable empty dark navy first quarter on the left for HTML text, generous framing. Clean high-end industrial photography, no text, no logos, no interface, no watermark.

### Canadian Edition

The Canadian Edition uses [the maple leaf hero](extension/assets/sterling-hero-ca.webp). The welcome page’s edition artwork, label, and shell accent class are paired in [the welcome module](extension/src/browser/sterling-welcome-module.ts) for future Sterling territories. The original hero remains available as a shared asset.

ImageGen edit prompt:

> Edit the supplied Sterling Sovereign AI hero with one localized change. Add a single clearly recognizable Canadian red maple leaf, matching the iconic symmetrical 11-point silhouette on Canada's flag, suspended at the exact visual center of the open steel ring. Make it a crisp, premium red enamel emblem with subtle dimensionality and a faint cool rim reflection from the blue light, facing the camera. Give it breathing room around all points within the opening, about 55% of the opening's width. Preserve the ring, camera position, framing, platform, dark navy and cobalt lighting, and especially the dark negative space on the left for webpage typography. Keep the same wide landscape composition. No flag rectangle, no extra symbols, no lettering, no watermark.

### Canadian Defence Edition

Documentation and Compliance open as Theia tabs. The Docker build bundles the existing Markdown sources for Documentation. The Compliance tab shows the published public evidence and explains when it is unavailable. To supply the refreshed bundle at startup, add this option to the workbench’s `docker run` command before the image name:

```sh
--mount "type=bind,source=/absolute/path/to/docs-site/build/compliance,target=/repo/.planning/spikes/theia-team-studio/lib/frontend/compliance,readonly"
```

Use the `build/compliance` directory populated by the docs site’s existing refresh workflow. Private overlays stay with the docs service.


The [Defence Edition hero](extension/assets/sterling-hero-ca-defence.webp) adds motifs for cyber, space, land, sea, and air around the maple leaf. A pulse travels along the trails. The hero pause button and reduced-motion setting also stop the pulses.

> Localized image edit for the Sterling Sovereign AI Canadian Defence Edition Get Started hero. Preserve the existing 16:9 wide blue and brushed-metal design, strong red Canadian maple leaf exactly in the ring's opening, pedestal, camera framing and original dark clean left 40 percent for the website headline. Add five distinct, understated cyan-blue holographic symbols in the open dark space around the outside of the ring, linked by slender curved dotted orbital tracks. The five symbols represent cyber (small circuit network), space (recognizable satellite with solar panels), land (topographic ground contour or mountain ridge), sea (wave lines and a small ship silhouette), and air (simple aircraft silhouette). Keep the symbols readable but restrained and visually secondary to the ring and red maple leaf. Keep all five clear within the central-right composition with generous edge margins. No writing, labels, brand text, watermarks, weapons, combat, explosions, or targeting graphics.
