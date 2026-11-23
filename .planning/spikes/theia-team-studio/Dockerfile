FROM node:24.22.1-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends g++ make python3
WORKDIR /repo/.planning/spikes/theia-team-studio

COPY .planning/spikes/theia-team-studio/package.json .planning/spikes/theia-team-studio/package-lock.json ./
COPY .planning/spikes/theia-team-studio/extension/package.json ./extension/package.json
RUN npm ci --ignore-scripts --no-audit --no-fund
# Core loads drivelist at startup. Build just this addon with the image's Node headers.
RUN npm_config_build_from_source=true npm_config_nodedir=/usr/local npm rebuild drivelist

COPY src /repo/src
COPY .planning/spikes/theia-team-studio/tools ./tools
COPY .planning/spikes/theia-team-studio/extension/tsconfig.json ./extension/tsconfig.json
COPY .planning/spikes/theia-team-studio/extension/src ./extension/src
COPY .planning/spikes/theia-team-studio/extension/fixtures ./extension/fixtures
RUN NODE_OPTIONS=--max-old-space-size=1536 npm run build

FROM node:24.22.1-bookworm-slim
WORKDIR /repo/.planning/spikes/theia-team-studio

COPY --from=build /repo/.planning/spikes/theia-team-studio ./
COPY --from=build /repo/dist/agent/teams.js /repo/dist/agent/teams.js

USER node
EXPOSE 3000
CMD ["node_modules/.bin/theia", "start", "--hostname", "0.0.0.0", "--port", "3000"]
