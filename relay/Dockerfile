# The relay image, built from the repository root: docker build -f relay/Dockerfile .
# (Compose does this through relay/compose.yaml.) Two stages, both pinned by digest (D-13):
#   build: compiles the relay with the Node it will run on, from the committed lockfile, with install scripts off.
#   final: distroless Node 26 as the non-root user; no shell, no package manager, no curl or wget. It holds two files and no secret.
# To re-pin, read the new digest from the registry (docker buildx imagetools inspect <image>), confirm the image prints a Node version of
# 26.13.1 or later, and change the digest on the matching line. The container test suite fails if a pin is missing or the Node is too old.
FROM docker.io/library/node:26.13.1-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS build
WORKDIR /build/relay
COPY relay/package.json relay/package-lock.json relay/.npmrc ./
RUN npm ci --ignore-scripts
COPY relay/tsconfig.json ./
COPY relay/scripts ./scripts
COPY relay/src ./src
RUN npx tsc -p tsconfig.json && node scripts/build.mjs --app-only
# Two folders to copy into the final image as they are, because the final stage has no shell to set modes with: the code (the folder
# readable and enterable, the two files read-only) and an empty private state directory, so a new named volume starts 0700 and writable
# by the relay's user.
RUN mkdir /app-skel \
 && cp dist/bin.mjs dist/app.mjs /app-skel/ \
 && chmod 0444 /app-skel/bin.mjs /app-skel/app.mjs \
 && chmod 0555 /app-skel \
 && mkdir -m 0700 /state-skel

FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:ffa8a7545403036c94ec76674b5dbac2d425af2d679147cdf3e30180071487b7
# Root-owned and read-only: the relay cannot rewrite its own code. Only the guard (bin.mjs) and the app (app.mjs) go in.
COPY --from=build --chown=0:0 /app-skel /app/
COPY --from=build --chown=65532:65532 --chmod=0700 /state-skel /var/lib/near-ai-relay
# Container-internal settings only. Who can reach the port is decided by how it is published (relay/compose.yaml binds 127.0.0.1).
ENV RELAY_STATE_DIR=/var/lib/near-ai-relay \
    RELAY_HOST=0.0.0.0 \
    RELAY_PORT=8080
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/nodejs/bin/node"]
CMD ["/app/bin.mjs"]
