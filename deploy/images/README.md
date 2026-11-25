# Images this repository builds

Each folder here holds one image we build ourselves instead of pulling it from upstream (D-23, D-12). Two readers depend on this file: the
`deploy-images` CI job (`.github/workflows/deploy-images.yml`) and the bundle build (`deploy/bundle/build.mjs --build-local`). Both follow
the contract below and nothing else.

## When an image is built

An image is built only when `deploy/images/<name>/image.json` exists beside its Containerfile; an image without `image.json` is not built.
A folder with only a Containerfile is a set of pinned base stages waiting for its build steps, so it can never be published by accident.

| Folder | Status | Build steps and `image.json` written by |
|---|---|---|
| `theia-cloud-operator`, `theia-cloud-service`, `theia-cloud-conversion-webhook`, `theia-cloud-landing-page` | built (`image.json`, Theia Cloud 1.2.0 at `e2d201fd`); the operator carries our session pod template in `templates/` | 47-09 |
| `oauth2-proxy` | built (`image.json`, v7.15.6 at `ea755ac0`, Go FIPS module) | 47-09 |
| `openbao`, `openbao-softhsm` (test scope only) | built (`image.json`); `openbao-softhsm` builds on the same pinned upstream base as `openbao`, not on our image, because the CI builds every image in parallel | 47-07 |
| `postgres` | built (`image.json`; the pinned PGDG RPMs and key from the `postgresql` pin, signature-checked) | 47-11 |
| `hub` | `image.json` only, pointing at the unchanged `hub/Dockerfile` with context `.` (D-45, D-46) | 47-11 |
| `guest-expiry` | built (`image.json`, context `.`): our Node scripts from `deploy/` on the UBI 9 Node.js 22 minimal runtime, for the automatic end of guest accounts and the realm applier's permission step | 47-20 |

## `image.json`

```json
{
  "name": "oauth2-proxy",
  "containerfile": "deploy/images/oauth2-proxy/Containerfile",
  "context": "deploy/images/oauth2-proxy",
  "source": { "repository": "oauth2-proxy/oauth2-proxy", "ref": "<full 40-character commit SHA>" },
  "tools": [{ "pin": "kms-pkcs11", "dir": "plugins" }],
  "buildArgs": { "EXAMPLE": "value" }
}
```

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | The image name. It is published as `sterling/<name>`. |
| `containerfile` | yes | Path of the Containerfile (or Dockerfile), from the repository root. |
| `context` | yes | Path of the build context, from the repository root. |
| `source` | no | Upstream source to build from: `repository` as `owner/repo` and `ref` as a full 40-character commit SHA (never a tag or branch). It is checked out and given to the build as the named build context `upstream` (`COPY --from=upstream ...`). |
| `tools` | no | List of `{ "pin": "<key in compliance/ci/tool-pins.json>", "dir": "<folder inside the context>" }`. Each pin is fetched with `compliance/ci/install-tool.sh` and hash-checked before the build starts; nothing is downloaded during the build itself. |
| `buildArgs` | no | String map passed as `--build-arg KEY=value`. Never a secret. |

The hub is defined by `deploy/images/hub/image.json` with `name` `near-ai-hub`, `containerfile` `hub/Dockerfile` and `context` `.`; the hub's
Dockerfile itself does not change.

## Base stages are pinned by digest

Every `FROM` that pulls an image is written `<registry>/<repository>:<tag>@sha256:<64 hex>`. The digest is the linux/amd64 image manifest,
not the multi-platform index: spike S1 (`.planning/phases/47-on-premise-deployment-stack-and-offline-bundle/47-01-SUMMARY.md`) showed that
this is the form that stays the same through the hauler bundle copy, and that hauler refuses to select one platform from an index pinned by
digest. A `FROM ${VAR}` takes an image passed in as a build argument by digest (for example the final stage of `openbao-softhsm`, whose
`image.json` passes the same pinned upstream OpenBao base that `openbao` uses).

To re-pin a base:

1. Read the tag's index without signing in: `curl -sSI -H 'Accept: application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.index.v1+json' https://<registry>/v2/<repository>/manifests/<tag>`
   (quay.io needs an anonymous pull token first), or `podman manifest inspect <registry>/<repository>:<tag>`.
2. Take the digest of the `linux/amd64` entry.
3. Fetch the manifest by that digest and check that its bytes hash to it (`sha256sum`).
4. Replace the `FROM` line, and give the same base the same digest in every Containerfile here that uses it.

The resource register (`compliance/resources.json`) lists each pulled base as an `image:<name>` entry, so a new base also needs its entry.
