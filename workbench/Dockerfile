# The Sterling workbench image (Phase 46: D-12, D-13, D-30, D-34, D-39). Build it from the repository root:
#
#   docker build -f workbench/Dockerfile -t sterling-workbench .                     the development image (the default, last stage)
#   docker build -f workbench/Dockerfile --target release ...                         the release image with the verified VSIX (release.yml)
#
# Every FROM line is literal and pinned by digest, so the compliance fit check (scripts/resource-check.mjs) sees and pin-checks each base.
# Base images are never build arguments (D-39): an air-gapped build mirrors these digests through the builder's registry-mirror setting.
# The npm registry is the one build argument (NPM_REGISTRY).
#
# Red Hat publishes no Node 26 for UBI 9 (research C1), so the build and runtime stages are UBI 9 minimal with the upstream Node 26.13.1
# binary taken from the digest-pinned node image below (the one the hub and relay pin), plus libatomic, which that binary needs.

# Node 26.13.1: only its binary, headers and npm are copied out (COPY --from=node); nothing else of this Debian image reaches the runtime.
FROM docker.io/library/node:26.13.1-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS node

FROM registry.access.redhat.com/ubi9/ubi-minimal:9.9-1795198179@sha256:08d4c70f1baf6537a0728656cf7942d561e74a35916509d205b6519861266352 AS build
ARG NPM_REGISTRY=https://registry.npmjs.org/
RUN microdnf -y --nodocs --setopt=install_weak_deps=0 install gcc-c++ make python3 libatomic tar gzip unzip \
    && microdnf clean all
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/include/node /usr/local/include/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
ENV npm_config_registry=${NPM_REGISTRY}
WORKDIR /repo/workbench

COPY workbench/package.json workbench/package-lock.json workbench/.npmrc ./
COPY workbench/extension/package.json ./extension/package.json
# No install scripts run (D-10): only the two native addons the backend loads are rebuilt, by name, against these Node 26 headers on UBI.
RUN npm ci --ignore-scripts --no-audit --no-fund
# Building node-pty from source removes its upstream prebuilds; Theia's bundler copies pty.node from prebuilds/<platform>-<arch>/, so the
# UBI-built binary is put there (never the upstream prebuild). Both builds must exist, or the image build stops here.
RUN JOBS=2 npm_config_build_from_source=true npm_config_nodedir=/usr/local npm rebuild drivelist node-pty \
    && test -s node_modules/drivelist/build/Release/drivelist.node \
    && test -s node_modules/node-pty/build/Release/pty.node \
    && dist="$(node -p 'process.platform + "-" + process.arch')" \
    && mkdir -p "node_modules/node-pty/prebuilds/$dist" \
    && cp node_modules/node-pty/build/Release/pty.node "node_modules/node-pty/prebuilds/$dist/pty.node"

# The engine bundle reads the repository's src/ and the compliance status engine's compliance/src/ with the exchange register (48.2-01,
# 48.2-08: only engine/compliance.cjs reaches the runtime stage), and copies the vendored Yjs build after checking it against its pin (Phase 33
# D-51; run `node scripts/vendor-libs.mjs` before the image build); the documentation tool reads the published guides.
COPY src /repo/src
COPY compliance/src /repo/compliance/src
COPY compliance/hosted/exchanges.json /repo/compliance/hosted/exchanges.json
COPY scripts/crdt-vendor.json /repo/scripts/crdt-vendor.json
COPY vendor/yjs/yjs.cjs vendor/yjs/LICENSES.txt /repo/vendor/yjs/
COPY README.md SECURITY.md CHANGELOG.md CONTRIBUTING.md /repo/
COPY docs/development-workflow.md docs/testing.md docs/staff-env-packs.md /repo/docs/
# The screenshots README.md shows: bundled as same-origin images by the documentation tool, never loaded from GitHub.
COPY docs/marketplace/near-ai-approval.png docs/marketplace/near-ai-chat.png docs/marketplace/near-ai-commands.png docs/marketplace/near-ai-workflow.png /repo/docs/marketplace/
COPY docs-site/content/index.md /repo/docs-site/content/
COPY docs-site/content/architecture/overview.mdx /repo/docs-site/content/architecture/
COPY docs-site/static/img/sovai-data-flows.webp /repo/docs-site/static/img/
COPY docs-site/content/releases/versions.md /repo/docs-site/content/releases/
COPY docs-site/content/security/trust-model.md /repo/docs-site/content/security/
COPY docs-site/content/using/getting-started.md /repo/docs-site/content/using/
COPY docs-site/content/using/roles/administration.md docs-site/content/using/roles/data-and-connections.md docs-site/content/using/roles/software-projects.md docs-site/content/using/roles/staff-teams.md /repo/docs-site/content/using/roles/
COPY workbench/bin ./bin
COPY workbench/tools ./tools
COPY workbench/extension/tsconfig.json ./extension/tsconfig.json
COPY workbench/extension/src ./extension/src
COPY workbench/extension/fixtures ./extension/fixtures
COPY workbench/extension/assets ./extension/assets
RUN NODE_OPTIONS=--max-old-space-size=1536 npm run build
# The runtime holds only the built app and its production dependencies: no @theia/cli, esbuild, puppeteer or Playwright (typescript
# stays: @theia/filesystem needs it at run time through opfs-worker). Prune leaves emptied scope folders behind; remove those too.
# @theia/core lists @types/* packages (express, ws, ...) as dependencies, so prune keeps @types/node with them; they hold only type
# declarations that nothing loads at run time, so the whole @types folder goes.
RUN npm prune --omit=dev --ignore-scripts --no-audit --no-fund \
    && rm -rf node_modules/@types \
    && rmdir --ignore-fail-on-non-empty node_modules/@*/ && rm -rf /root/.npm && chmod -R go-w /repo/workbench

# Declared only so the fit check sees and pin-checks the test OpenBao (D-29); no stage copies from it and a plain build never builds it.
# 46-02's container tests take the image reference from this line.
FROM docker.io/openbao/openbao:2.7.3@sha256:ba4b133eb9586630024e71a617e66f37f29cc3534cdd46a6233e098ceded8dc9 AS openbao-test

FROM registry.access.redhat.com/ubi9/ubi-minimal:9.9-1795198179@sha256:08d4c70f1baf6537a0728656cf7942d561e74a35916509d205b6519861266352 AS runtime
RUN microdnf -y --nodocs --setopt=install_weak_deps=0 install libatomic procps-ng \
    && microdnf clean all \
    && rm -rf /var/cache/dnf /var/cache/yum /var/lib/dnf/repos /var/log/dnf* /var/log/yum* \
    && echo 'sterling:x:10001:0:Sterling:/home/sterling:/bin/bash' >> /etc/passwd \
    && mkdir -p /home/sterling/workspace \
    && chown -R 10001:0 /home/sterling \
    && chmod -R g=u /home/sterling
COPY --from=node /usr/local/bin/node /usr/local/bin/node
# The app tree is owned by root and read-only for the workbench user; only its home and workspace are writable (arbitrary-UID friendly).
COPY --from=build /repo/workbench /app
ENV HOME=/home/sterling
USER 10001:0
WORKDIR /home/sterling
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD ["node","/app/bin/healthcheck.mjs"]
# Listens on 127.0.0.1 unless STERLING_LISTEN_HOST is set; in local mode a non-loopback bind needs STERLING_PREVIEW_NO_SIGN_IN=accept.
ENTRYPOINT ["node","/app/bin/start.mjs"]

# The release image: the runtime with the release's verified VSIX bundled as a default plugin (release.yml, #165).
FROM build AS bundled-plugin
COPY release-input/sterling.vsix /bundle/sterling.vsix
RUN unzip -q /bundle/sterling.vsix 'extension/*' -d /plugins \
    && test -s /plugins/extension/package.json

FROM runtime AS release
COPY --from=bundled-plugin /plugins /plugins
ENV THEIA_DEFAULT_PLUGINS=local-dir:///plugins
CMD ["--session-preference", "nearAi.autoInstallGsd=false"]

# Default target for local builds: the workbench without a bundled VSIX.
FROM runtime AS development
