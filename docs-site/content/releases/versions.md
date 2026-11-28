---
sidebar_label: Documentation versions
sidebar_position: 2
---

# Documentation versions

The site shows the documentation for the code on `main`, labelled **Next**. When a minor release
is prepared, the release checklist takes a snapshot of the documentation for that version, so the
pages for each released minor version stay readable after the code moves on. Patch releases update
the current pages without a new snapshot.

How a snapshot is taken is in [This documentation site](../developing/docs-site.synced.md#versions-at-release).
What changed in each release is in the [Changelog](./changelog.synced.md).

## How each version is released

Releases are no longer published to the Visual Studio Marketplace. Versions before 0.4.37 were
published there; no later version is.

Each version is a Sterling workbench container image, with that version's extension inside it, on
the GitHub Container Registry as `ghcr.io/vitalpointai/near-ai-vscode:vX.Y.Z`. Images are tagged
this way from 0.4.37. An image is pushed only after the owner approves it in the protected
`container-release` environment.

Releases from 0.4.38 on also have a GitHub release, which records the image digest beside the
extension package (VSIX), its checksum and the assessor package. Version 0.4.37's image is on the
registry, but the release stopped after the push, so 0.4.37 has no GitHub release.

How to install the extension package or run the image is in [Getting started](../using/getting-started.md).
How a release is built is in the [Architecture overview](../architecture/overview.mdx#how-a-release-is-shipped).
