# Sterling workbench (Eclipse Theia)

The workbench opens to Sterling Sovereign AI Canadian Defence Edition. Get Started shows the Sterling logo for the active theme and opens a native Team Studio preview with four packaged samples.

It is its own package (`sterling-workbench`, Theia 1.77.0, Node 26.13.1 or later in the 26 line) and its own image: UBI 9 minimal with the upstream Node 26 binary, native addons built on UBI, user `10001:0`, port 3000, `GET /healthz`. It never ships in the VS Code extension.

## Run locally

From the root of this checkout, build and start the workbench with Docker.

```sh
docker build -f workbench/Dockerfile -t sterling-workbench .
docker run --detach --name sterling-workbench \
  --env STERLING_LISTEN_HOST=0.0.0.0 \
  --env STERLING_PREVIEW_NO_SIGN_IN=accept \
  --publish 127.0.0.1:18771:3000 sterling-workbench
```

Open [Get Started](http://127.0.0.1:18771/) and select **Explore a sample team**. Reopen the page with the home icon at the top of the right sidebar or **SovAI: Get Started** in the command palette. **SovAI: Open Team Studio Preview** also opens the sample. Use the sample picker to switch between two valid teams, a sample without a team, and a sample with an invalid team. Select a member to see their role, reporting line, and instructions.

Use `docker stop sterling-workbench` and `docker start sterling-workbench` to stop and restart the same container.

**Publish it on `127.0.0.1` only.** Run locally, the workbench has no sign-in and includes a terminal, so anyone who can reach its port gets a shell as the container's user. Inside the container it listens on `127.0.0.1` by default, which a port mapping cannot reach; `STERLING_LISTEN_HOST=0.0.0.0` makes it listen on every interface so the mapping works, and the safety then comes from `--publish 127.0.0.1:…`. Never use `-p 3000:3000` or publish it on a shared host. Without sign-in in front (no `STERLING_OPENBAO_ADDR`), the image refuses to listen on any address other than loopback until you pass `--env STERLING_PREVIEW_NO_SIGN_IN=accept` to confirm this.

The container runs as user `10001` in group `0`; only its home `/home/sterling` and workspace `/home/sterling/workspace` are writable. Its runtime holds only the Node binary and production dependencies: the Theia CLI, bundlers, compilers and the browser test tools stay in the build stage. The examples are synthetic. The workbench has no host workspace mounts, provider credentials, or agent run controls.

An air-gapped build mirrors the digest-pinned base images through the builder's registry-mirror setting and points npm at a registry mirror with `--build-arg NPM_REGISTRY=<url>`.

## Develop and test

Workbench commands run on Node 26.13.1 or later in the 26 line.

```sh
npm --prefix workbench ci --ignore-scripts
npm --prefix workbench run lint
npm --prefix workbench test                        # unit tests, no Docker
npx --prefix workbench playwright install chromium   # once
npm --prefix workbench run test:container          # builds the image, checks it and opens Get Started in Chromium
```

`test:container` builds its own image tag and removes it afterwards; set `WORKBENCH_TEST_IMAGE` to test an image you built already (it is never removed). An air-gapped run sets `PLAYWRIGHT_BROWSERS_PATH` to a mirrored copy of the browsers.

## Run the existing extension in Theia

Build the same image as above. From this checkout, run `npm ci` and `npm run package` to build a VSIX with the Theia command fixes. Unpack that VSIX into the ignored local plugin directory, then start a separate container with that directory mounted read-only. The VSIX runs with a new container-side workspace and no host home or provider credentials. The local session disables automatic GSD installation.

```sh
mkdir -p workbench/local-plugins
unzip -q ./near-ai-vscode-*.vsix 'extension/*' -d workbench/local-plugins

docker run --detach --name sterling-workbench-vsix \
  --publish 127.0.0.1:18874:3000 \
  --mount "type=bind,source=$PWD/workbench/local-plugins,target=/plugins,readonly" \
  --env THEIA_DEFAULT_PLUGINS=local-dir:///plugins \
  --env STERLING_LISTEN_HOST=0.0.0.0 \
  --env STERLING_PREVIEW_NO_SIGN_IN=accept \
  sterling-workbench --session-preference nearAi.autoInstallGsd=false
```

Open [the VSIX workbench](http://localhost:18874/) using `localhost` so Theia can use separate `*.webview.localhost` origins. From the command palette choose **NEAR AI: Set Up**, **NEAR AI: Team Studio**, or **NEAR AI: Open Chat**. The compatibility container is for synthetic projects and has an in-memory credential store.

The Release workflow builds the `release` target, which bundles the release's verified VSIX at `/plugins` the same way.

## Documentation and Compliance

The right sidebar opens both views in Theia. Documentation search uses the guides packaged in the image. Links to included topics open in place. Other links open in your browser.

The Compliance view displays an evidence bundle's recorded states and source, with filters for level, state and control. The image starts without evidence. From a trusted checkout, run `npm --prefix docs-site run compliance:refresh` to verify the evidence manifest and write the public dashboard projection. Add the following read-only bind mount when starting the local container.

```sh
--mount "type=bind,source=$PWD/docs-site/static/compliance,target=/app/lib/frontend/compliance,readonly"
```

Mount only the public projection written by the [documentation site's evidence refresh](../docs-site/README.md). The container's user must be able to read its dashboard, `refresh.json` and public control text. The view shows states only when `refresh.json` records a verified manifest for the same commit as the dashboard. It reports missing, invalid, unverified or old bundles, and shows no evidence counts until a verified projection is available. The view shows the states the bundle recorded when it was built; it does not recompute them.

## Research

Theia provides both a VS Code extension host and native application extensions. The native widget uses the Theia workbench and calls the backend through Theia JSON-RPC. See [Theia native extensions](https://theia-ide.org/docs/authoring_extensions/), [Theia JSON-RPC](https://theia-ide.org/docs/json_rpc/), and [VS Code extension support](https://theia-ide.org/docs/authoring_vscode_extensions/).

The parser carries over directly. The current VS Code extension declares VS Code 1.101 or later and also uses webview panels and the chat participant API. The container includes the pinned Theia VS Code extension host for running the VSIX alongside the native widget. Native ports also need to wire real project selection, workspace file access, and writes through the new host.

## Results

The browser container builds from the pinned dependencies and runs on localhost. Chromium verified that the widget opens, both valid projects load, member details show the reporting line, missing and invalid projects display their own messages, and returning to a valid project restores the roster. The backend uses the existing parser without changes.

See [Theia migration and acceptance](MIGRATION.md) for the full extension cutover.
