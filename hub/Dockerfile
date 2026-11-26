# The hub image, built from the repository root: docker build -f hub/Dockerfile .
# (Compose does this through relay/compose.yaml, profile hub.) Two stages, both pinned by digest (D-26), on exactly the relay's two images:
#   build: compiles the hub with the Node it will run on, from the hub's committed lockfile, with install scripts off. The hub bundles the
#          extension's pure hub-side replica code (D-27), so the files of that closure under src/ are copied too; the root .dockerignore lets in
#          only those files (hub/test/dockerContext.test.ts pins the list).
#   final: distroless Node 26 as the non-root user; no shell, no package manager, no curl or wget. It holds two files and no secret.
# To re-pin, change relay/Dockerfile first (read the new digest with docker buildx imagetools inspect <image> and confirm the image prints a Node
# version of 26.13.1 or later), then copy the two FROM lines here unchanged. The hub container suite fails if a pin is missing, if the Node is
# too old, or if the two files name different images.
FROM docker.io/library/node:26.13.1-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS build
WORKDIR /build/hub
COPY hub/package.json hub/package-lock.json hub/.npmrc ./
RUN npm ci --ignore-scripts
COPY hub/tsconfig.json ./
COPY hub/scripts ./scripts
COPY hub/src ./src
# Only the allow-listed closure files arrive here; tsconfig.json maps @ext/* to ../src/*.
COPY src /build/src
RUN npx tsc -p tsconfig.json && node scripts/build.mjs --app-only
# Two folders to copy into the final image as they are, because the final stage has no shell to set modes with: the code (the folder
# readable and enterable, the two files read-only) and an empty private state directory, so a new named volume starts 0700 and writable
# by the hub's user.
RUN mkdir /app-skel \
 && cp dist/bin.mjs dist/app.mjs /app-skel/ \
 && chmod 0444 /app-skel/bin.mjs /app-skel/app.mjs \
 && chmod 0555 /app-skel \
 && mkdir -m 0700 /state-skel

FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:ffa8a7545403036c94ec76674b5dbac2d425af2d679147cdf3e30180071487b7
# Root-owned and read-only: the hub cannot rewrite its own code. Only the guard (bin.mjs) and the app (app.mjs) go in.
COPY --from=build --chown=0:0 /app-skel /app/
COPY --from=build --chown=65532:65532 --chmod=0700 /state-skel /var/lib/near-ai-hub
# Container-internal settings only. Who can reach the port is decided by how it is published (relay/compose.yaml binds 127.0.0.1 unless the
# operator sets NEAR_AI_HUB_PUBLISH_ADDRESS). The hub ends TLS itself on this port.
ENV HUB_STATE_DIR=/var/lib/near-ai-hub \
    HUB_HOST=0.0.0.0 \
    HUB_PORT=8443
USER 65532:65532
EXPOSE 8443
ENTRYPOINT ["/nodejs/bin/node"]
CMD ["/app/bin.mjs"]
