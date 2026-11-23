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

## Research

Theia provides both a VS Code extension host and native application extensions. The native widget uses the Theia workbench and calls the backend through Theia JSON-RPC. See [Theia native extensions](https://theia-ide.org/docs/authoring_extensions/), [Theia JSON-RPC](https://theia-ide.org/docs/json_rpc/), and [VS Code extension support](https://theia-ide.org/docs/authoring_vscode_extensions/).

The parser carries over directly. The current VS Code extension declares VS Code 1.101 or later and also uses webview panels and the chat participant API. Full extension compatibility needs a separate VSIX smoke test in a Theia build with the VS Code extension host enabled. Native ports also need to wire real project selection, workspace file access, and writes through the new host.

## Results

The browser container builds from the pinned dependencies and runs on localhost. Chromium verified that the widget opens, both valid projects load, member details show the reporting line, missing and invalid projects display their own messages, and returning to a valid project restores the roster. The backend uses the existing parser without changes.

See [Theia migration and acceptance](MIGRATION.md) for the full extension cutover.
