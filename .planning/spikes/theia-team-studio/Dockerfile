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
# The runtime needs only the built app and its production dependencies: drop the CLI, bundlers and compilers.
RUN npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24.22.1-bookworm-slim
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
