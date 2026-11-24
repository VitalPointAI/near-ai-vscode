FROM docker.io/library/node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS build
RUN apt-get update && apt-get install -y --no-install-recommends g++ make python3
WORKDIR /repo/.planning/spikes/theia-team-studio

COPY .planning/spikes/theia-team-studio/package.json .planning/spikes/theia-team-studio/package-lock.json ./
COPY .planning/spikes/theia-team-studio/extension/package.json ./extension/package.json
RUN npm ci --ignore-scripts --no-audit --no-fund
# Core loads drivelist at startup. Build just this addon with the image's Node headers.
RUN npm_config_build_from_source=true npm_config_nodedir=/usr/local npm rebuild drivelist

COPY src /repo/src
COPY README.md SECURITY.md CHANGELOG.md /repo/
COPY docs/development-workflow.md docs/testing.md /repo/docs/
COPY docs-site/content/index.md /repo/docs-site/content/
COPY docs-site/content/architecture/overview.md /repo/docs-site/content/architecture/
COPY docs-site/content/releases/versions.md /repo/docs-site/content/releases/
COPY docs-site/content/security/trust-model.md /repo/docs-site/content/security/
COPY docs-site/content/using/getting-started.md /repo/docs-site/content/using/
COPY docs-site/content/using/roles/administration.md docs-site/content/using/roles/data-and-connections.md docs-site/content/using/roles/software-projects.md docs-site/content/using/roles/staff-teams.md /repo/docs-site/content/using/roles/
COPY .planning/spikes/theia-team-studio/tools ./tools
COPY .planning/spikes/theia-team-studio/extension/tsconfig.json ./extension/tsconfig.json
COPY .planning/spikes/theia-team-studio/extension/src ./extension/src
COPY .planning/spikes/theia-team-studio/extension/fixtures ./extension/fixtures
COPY .planning/spikes/theia-team-studio/extension/assets ./extension/assets
RUN NODE_OPTIONS=--max-old-space-size=1536 npm run build
# The runtime needs only the built app and its production dependencies: drop the CLI, bundlers and compilers.
RUN npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM docker.io/library/node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends git procps
WORKDIR /repo/.planning/spikes/theia-team-studio

COPY --from=build /repo/.planning/spikes/theia-team-studio ./
COPY --from=build /repo/dist/agent/teams.js /repo/dist/agent/teams.js

USER node
RUN mkdir /home/node/workspace
EXPOSE 3000
# This preview has no sign-in and includes a terminal, so whoever reaches port 3000 gets a shell as `node`.
# It listens on every interface inside the container (port mapping needs that), so it refuses to start
# until the person running it confirms they publish it on 127.0.0.1 only (see README.md).
ENV STERLING_PREVIEW_NO_SIGN_IN=""
ENTRYPOINT ["sh", "-c", "if [ \"$STERLING_PREVIEW_NO_SIGN_IN\" != accept ]; then echo 'This preview has no sign-in and includes a terminal. Publish it on 127.0.0.1 only and start it with -e STERLING_PREVIEW_NO_SIGN_IN=accept.' >&2; exit 1; fi; exec \"$@\"", "--"]
CMD ["node", "lib/backend/main.js", "/home/node/workspace", "--hostname", "0.0.0.0", "--port", "3000"]

# The release image: the runtime with the release's verified VSIX bundled as a default plugin.
FROM build AS bundled-plugin
RUN apt-get update && apt-get install -y --no-install-recommends unzip
COPY release-input/sterling.vsix /bundle/sterling.vsix
RUN unzip -q /bundle/sterling.vsix 'extension/*' -d /plugins \
    && test -s /plugins/extension/package.json

FROM runtime AS release
COPY --from=bundled-plugin /plugins /plugins
ENV THEIA_DEFAULT_PLUGINS=local-dir:///plugins
CMD ["node", "lib/backend/main.js", "/home/node/workspace", "--hostname", "0.0.0.0", "--port", "3000", "--session-preference", "nearAi.autoInstallGsd=false"]

# Default target for local builds: the preview without a bundled VSIX.
FROM runtime AS development
