FROM node:24.22.1-bookworm-slim AS build-files
RUN apt-get update && apt-get install -y --no-install-recommends g++ make python3
WORKDIR /repo/.planning/spikes/theia-team-studio

COPY .planning/spikes/theia-team-studio/package.json .planning/spikes/theia-team-studio/package-lock.json ./
COPY .planning/spikes/theia-team-studio/extension/package.json ./extension/package.json
RUN npm ci --ignore-scripts --no-audit --no-fund
# Core loads drivelist at startup. Build just this addon with the image's Node headers.
RUN npm_config_build_from_source=true npm_config_nodedir=/usr/local npm rebuild drivelist

COPY src /repo/src
COPY README.md SECURITY.md CHANGELOG.md CONTRIBUTING.md /repo/
COPY docs/*.md /repo/docs/
COPY docs-site/content /repo/docs-site/content
COPY .planning/spikes/theia-team-studio/tools ./tools
COPY .planning/spikes/theia-team-studio/extension/tsconfig.json ./extension/tsconfig.json
COPY .planning/spikes/theia-team-studio/extension/src ./extension/src
COPY .planning/spikes/theia-team-studio/extension/fixtures ./extension/fixtures
COPY .planning/spikes/theia-team-studio/extension/assets ./extension/assets
FROM build-files AS build
RUN NODE_OPTIONS=--max-old-space-size=1536 npm run build

FROM node:24.22.1-bookworm-slim AS preview
RUN apt-get update && apt-get install -y --no-install-recommends git procps
WORKDIR /repo/.planning/spikes/theia-team-studio

COPY --from=build /repo/.planning/spikes/theia-team-studio ./
COPY --from=build /repo/dist/agent/teams.js /repo/dist/agent/teams.js

USER node
RUN mkdir /home/node/workspace
EXPOSE 3000
CMD ["node_modules/.bin/theia", "start", "--hostname", "0.0.0.0", "--port", "3000"]

# Opt-in package for testing the upstream Theia SecretStorage backend.
FROM build-files AS credential-build
RUN apt-get update && apt-get install -y --no-install-recommends libsecret-1-dev pkg-config
# Build the pinned addon from source using the image's Node headers, without downloading a prebuilt binary.
RUN node /usr/local/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js rebuild \
    --directory node_modules/keytar --nodedir=/usr/local --napi_build_version=3
# Theia must see the addon while bundling its Node backend.
RUN NODE_OPTIONS=--max-old-space-size=1536 npm run build && test -f lib/backend/native/keytar.node

FROM preview AS credential-proof
USER root
RUN apt-get update && apt-get install -y --no-install-recommends dbus-daemon gnome-keyring libsecret-1-0
COPY --from=credential-build /repo/.planning/spikes/theia-team-studio/lib/backend ./lib/backend
COPY --from=credential-build /repo/.planning/spikes/theia-team-studio/node_modules/keytar/build/Release/keytar.node ./node_modules/keytar/build/Release/keytar.node
USER node
RUN mkdir -p /home/node/.local/share/keyrings

# Keep the standard preview on its existing single-user, in-memory configuration.
FROM preview AS local
