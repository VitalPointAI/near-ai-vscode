# The documentation site

`docs-site/` is the documentation site for NEAR AI for VS Code: how to use the extension, and how
it is built, secured, tested and released. It is built with [Docusaurus 3](https://docusaurus.io/)
and, for now, is read on this computer only.

It is a workspace of its own, with its own `package.json` and lockfile. Nothing in it is a
dependency of the extension, it is not compiled or type-checked with the extension, and none of it
ships in the VSIX (`.vscodeignore` leaves it out and `scripts/verify-release-content.mjs` refuses a
package that holds any of it).

## Open it

From the repository root:

| Command | What it does |
| --- | --- |
| `npm run docs:install` | Installs the site's own dependencies (once, and after its lockfile changes). Dependency install scripts never run. |
| `npm run docs` | Live preview at http://127.0.0.1:3211/ that reloads as you edit. Search works only in a build, not in the preview. |
| `npm run docs:build` | Builds the site into `docs-site/build/`. Fails on any broken link or anchor. |
| `npm run docs:serve` | Serves the last build at http://127.0.0.1:3210/ until you stop it (Ctrl+C). |

Builds are heavy: on Linux, run them inside the memory cap described in the testing rules
([`docs/testing.md`](../docs/testing.md)).

## The local service

The local service serves the last build at **http://127.0.0.1:3210/** all the time, and starts
again when you log in. It is a systemd user service named `near-ai-docs`, running
`scripts/serve.mjs`: a small static file server, from this workspace's own dependencies, that only
binds to 127.0.0.1 (it refuses any other address) and stops with an error instead of moving to
another port if 3210 is taken.

| To | Run |
| --- | --- |
| Install and start it | `npm run docs:build`, then `npm run docs:service:install` (or `sh docs-site/scripts/install-service.sh <port>` for another port) |
| See whether it runs | `systemctl --user status near-ai-docs` |
| Stop it | `systemctl --user stop near-ai-docs` |
| Start it again | `systemctl --user start near-ai-docs` |
| Show a newer version of the docs | `npm run docs:build`. The service reads the files on every request, so there is nothing to restart. |
| See its log | `journalctl --user -u near-ai-docs -n 50` |
| Uninstall it | `npm run docs:service:uninstall` (stops it and removes the unit file it installed; the site and its build stay) |

The unit file in the repository (`scripts/near-ai-docs.service.in`) is a template with no paths
in it; the install script fills in this checkout's folder, the Node.js it finds on `PATH` and the
port, and writes it to `~/.config/systemd/user/near-ai-docs.service`. The service serves the
checkout it was installed from: install it from the checkout you keep up to date (normally your
main checkout, not a short-lived worktree), and run the install again to move it.

## Where the pages come from

One source of truth: the repository's documents stay where they are and are edited only there.
At every build `scripts/sync-docs.mjs` renders these into the site:

| Repository file | Site section |
| --- | --- |
| `README.md` | Using NEAR AI: Features and settings |
| `docs/*.md` (other than those below) | Using NEAR AI: Reference |
| `SECURITY.md` | Security: Security policy |
| `.planning/codebase/*.md`, `.planning/research/**/*.md` | Architecture |
| `docs/decisions/*.md` (when there are any) | Architecture: Decision records |
| `CONTRIBUTING.md`, `docs/development-workflow.md`, `docs/testing.md`, this file | Developing |
| `CHANGELOG.md` | Releases |

The copies are written into `docs-site/content/` as `*.synced.md`, are ignored by git, and are
replaced at every build. Their relative links are rewritten: a link to another rendered document
goes to its page, an image is served from the site, and a link to any other file in the repository
goes to it on GitHub. A link to a file that does not exist fails the build. Only files tracked by
git are rendered, so add a new document with `git add` before it shows up.

The pages written for the site itself (the welcome page, getting started, the role guides, the
trust model summary, the architecture overview) are the other files in `docs-site/content/`. The
role guides are short placeholders until the guided setup lands; they will be written then, in the
setup's own words.

The site loads nothing from the web: no analytics, no web fonts, no CDN. Search is
[`@easyops-cn/docusaurus-search-local`](https://github.com/easyops-cn/docusaurus-search-local):
its index is built with the site and searched in the browser. Diagrams in ```` ```mermaid ```` code
blocks are drawn in the browser by the bundled Mermaid.

## Keeping it current

- **CI.** The `docs` job in `.github/workflows/ci.yml` installs this workspace with
  `npm ci --ignore-scripts`, runs `npm audit` on it, and builds the site, which fails on a broken
  link or anchor. It runs on every pull request.
- **Changes.** A change that alters what a user sees or does updates the README or the relevant
  page in the same pull request, as the PR template's docs checkbox asks.
- **Releases.** The release checklist (`.claude/commands/release.md` and the "Releasing" section
  of `docs/development-workflow.md`) has a "docs updated" step, and a versions step for minor
  releases (below).

## Versions at release

The site shows the docs for `main` as **Next**. For each minor release (`x.y.0`), take a snapshot
on the release branch after the version bump, so the docs for that version stay readable:

```bash
cd docs-site
npm run version:snapshot -- <x.y.z>
git add versions.json versioned_docs versioned_sidebars
```

The script refuses unless the root `package.json` already has that version, and refuses a version
that already has a snapshot. In the snapshot, links to repository files point at the release tag
`v<x.y.z>` instead of `main`. Patch releases update the current pages without a snapshot.

## Dependencies

Every dependency is pinned to an exact version in `package.json`, `.npmrc` turns off install
scripts, and `overrides` in `package.json` lift three transitive packages
(`serialize-javascript`, `tinypool`, `uuid`) past published advisories that Docusaurus 3.10.2 still
pulls in. Check with `npm run audit` here; CI runs the same check.
