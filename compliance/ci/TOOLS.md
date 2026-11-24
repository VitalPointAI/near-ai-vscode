# Pinned compliance CI tools

## Owner-approved tool review

On 2026-11-21, the owner approved these tools for CI and the one local help and
validation pass in this plan: oscal-cli 3.2.0, Syft 1.57.2, Grype 0.122.1, and
Compliance Trestle 5.2.1. The three executable downloads are installed only by
`install-tool.sh`, which verifies the repository SHA-256 before extracting.
Never pipe a download into a shell or replace these pins with a marketplace
action.

## oscal-cli 3.2.0

The Maven Central ZIP is pinned in `tool-pins.json` to
`e001b353ee245da6f4ff0ad930c4dfaa88083c63243ca004bd5f5bcef44e8ec8` and
requires Java 11 or newer. The 3.2.0 help confirms these CI calls:

```sh
oscal-cli validate <oscal-file>
oscal-cli profile resolve --to=json --overwrite -q <profile> <resolved-output>
```

`oscal-validate.sh` wraps those exact calls. `--to=json` selects JSON,
`--overwrite` permits a repeatable generated destination, and `-q` keeps profile
resolution output to errors.

The release job runs `oscal-validate.sh package <package-directory>`. OSCAL CLI
3.2.0 resolves an SSP's relative profile link against an assessment's directory
when it validates nested imports. The wrapper validates assessments with an
equivalent absolute profile link in a scratch copy of the SSP and validates the
original SSP separately. The shipped archive keeps portable relative links.

## Syft 1.57.2

The immutable Anchore release tarball is pinned to
`ad92bd3ec1b94a3df01d4d0aec199afa9c42b72e86da436ff5f837914d32706b`.
The confirmed CycloneDX JSON form is:

```sh
syft scan <image> --output cyclonedx-json=<sbom-file>
```

The `scan` command is explicit so CI scans the intended Docker image rather
than falling back to a registry pull.

## Grype 0.122.1

The immutable Anchore release tarball is pinned to
`f1ba7e2917ee1395618de20a98da0aa7c0fb1788927797651047c50502a37538`.
The confirmed SBOM scan form is:

```sh
grype sbom:<sbom-file> --only-fixed --fail-on high --output json=<scan-file>
```

`grype --help` says `--fail-on high` exits 2 for a finding at or above the
threshold; an invalid invocation exited 1 in the approved 0.122.1 local check.
CI must therefore keep `grype db update` separate from the threshold scan and
treat an update outage as infrastructure failure, not as a vulnerability
finding. The confirmed defaults validate database age and cap it at 120h; CI
sets `GRYPE_DB_VALIDATE_AGE=true` and `GRYPE_DB_MAX_ALLOWED_BUILT_AGE=120h`
explicitly before scanning.

### The vulnerability database for the bundle and sites

Since Phase 47 (D-72, 47-26) grype also runs at sites, on the import host, so
the database a site scans with travels in signed media. `grype.anchore.io` is
reached only from the connected build host; nothing at a site contacts it.

On the connected build host, the bundle build:

1. Reads Anchore's listing with `grype db list -o json`. Each listing entry
   names the archive `path` (relative to `https://grype.anchore.io/databases`),
   its `built` time and its `checksum` (`sha256:<hex>`).
2. Downloads the `active` archive over https into a private folder and checks
   its SHA-256 against the listing's checksum before anything else reads it.
3. Runs `grype db import <archive>` into a private cache
   (`GRYPE_DB_CACHE_DIR` set to a folder of its own), scans each image SBOM
   from that cache, and adds the archive to the bundle as
   `vulnerability-db.tar.zst`, under the one manifest signature.

Between bundles HQ can ship a newer archive as a file signed with your
organization's key (`scan.mjs db-pack`, 47-29); a site checks the signature
before importing it.

At a site, a rescan runs grype against the database from the bundle or the
signed file, with every update check off:

```sh
export GRYPE_DB_CACHE_DIR=<private folder>
export GRYPE_DB_AUTO_UPDATE=false        # never contact the listing
export GRYPE_CHECK_FOR_APP_UPDATE=false  # never contact Anchore for a newer grype
export GRYPE_DB_VALIDATE_AGE=false       # an air-gapped database is older than 120h by design;
                                         # the report shows the database's build date instead
grype db import vulnerability-db.tar.zst
grype sbom:<sbom-file> --only-fixed --output json=<scan-file>
```

Scans at sites are report-only; the site change board decides (D-72). These
setting names are confirmed from `grype config` of the pinned 0.122.1.

## Compliance Trestle 5.2.1

The owner-approved PyPI wheel is pinned to
`4f870ba0d98b89f7196ae275daa522d990753e4aeaad26d8651237cc7d6a5479`.
`trestle-requirements.txt` lists its CPython 3.12 manylinux x86_64 wheel and
every resolved dependency with a SHA-256. CI installs only that list:

```sh
pip install --require-hashes --no-deps --only-binary=:all: -r compliance/ci/trestle-requirements.txt
```

Trestle is not installed locally in this plan. Its `trestle init`, `trestle
import -f <file> -o <name>`, and `trestle validate -a` flags are confirmed from
its own help during the first isolated CI run in 44-19.

The release workflow uses a throwaway Trestle workspace and records import and validation output in the job summary. Model findings are report-only, while installation failures still stop the job.

GitHub disables scheduled workflows after 60 days without repository activity. Re-enable the compliance schedule when the Evidence page shows a collector has gone silent.

## Deployment stack pins (Phase 47)

`tool-pins.json` also pins the downloads of the on-premise stack: cosign,
hauler, helm, RKE2 (with its image archives, checksum file and the
`rke2-selinux` RPM as `assets`), the OpenBao `kms-pkcs11` plugin, the PGDG
PostgreSQL RPMs and signing key, and the SoftHSM2 source (test scope only).
`install-tool.sh <tool> <target-dir>` installs any of them: versions are
`x.y` or `x.y.z` with an optional `+build` suffix; hosts are Maven Central,
GitHub, `get.helm.sh` and `download.postgresql.org`; `zip` and `tar.gz` are
extracted, `binary` is copied to `<target>/<bin>` and made executable, and
`file` is placed as-is under its address's file name. Each `assets[]` item is
downloaded, host-checked and hash-checked the same way and placed beside under
its file name. Every hash is checked before anything is extracted or placed.
Each tool also has an entry in `compliance/resources.json` (`tool:<name>`).

How each is bumped (always into a fresh temporary directory, then the steps
under "Updating a pin"):

- cosign, hauler, syft, grype: take the new hash from the release's
  `*_checksums.txt` and confirm it with `sha256sum` of the download. A new
  cosign is checked again against the key-mode flags spike S1 proved
  (`--signing-config` with an empty signing config; `--insecure-ignore-tlog`
  to verify).
- helm: `get.helm.sh/helm-v<version>-linux-amd64.tar.gz` and its `.sha256sum`.
- RKE2: the release's `sha256sum-amd64.txt` lists the tarball and both image
  archives; the checksum file itself is pinned by its GitHub release asset
  digest. `rke2-selinux` is the newest EL9 stable release asset, confirmed
  against its `sha256sum-centos9-noarch.txt`. The `+` of the version is `%2B`
  in the addresses.
- kms-pkcs11: `checksums-kms-pkcs11.txt` gives both the tarball hash
  (`sha256`) and the extracted plugin binary's hash (`binSha256`); re-hash the
  binary after extracting.
- postgresql: the RPM hashes come from the PGDG repository's `primary.xml.gz`,
  whose own hash is in `repodata/repomd.xml`; the signing key is pinned by hash
  and its `fingerprint` read with `gpg --show-keys`. The image build still
  checks each RPM's signature against that key.
- softhsm2: upstream publishes no release tarball or checksum, so the pin is
  the commit of the `2.7.0` tag (`pinKind: commit`) and its tree. The archive
  hash is taken on the first download and confirmed against the signed tag:
  `git fetch --depth 1 https://github.com/softhsm/SoftHSMv2 <commit>`, check
  that GitHub reports the commit's signature as verified, that
  `git rev-parse <commit>^{tree}` equals `tree`, and that
  `git archive --format=tar --prefix=SoftHSMv2-<commit>/ <commit> | sha256sum`
  equals `tarSha256` and `gzip -dc` of the download. Never re-hash from a
  download alone.

## cosign 3.1.4 for the Sterling workbench image (Phase 46)

The Release workflow also uses the same cosign pin, the bare `cosign-linux-amd64` binary
`424e2c97d0b45fd7a6b608a87f090f35633f4c23ece5f092d48bba11aaf4bbfa`. Only its `publish` job
signs, in the protected `container-release` environment, with your organization's key. That
job holds a write token, so it checks out no code. The read-only `image` job installs cosign
with `install-tool.sh`, which checks the binary against the repository SHA-256. It hands
`publish` the binary with that hash, and `publish` checks the hash again before running it.
cosign never runs keyless and never uploads to a public transparency log. The owner's
approval of this use is requested in the Phase 46 PR.

Confirmed on 2026-11-24 from the 3.1.4 binary's own help (`cosign sign --help`,
`cosign attest --help`, `cosign verify --help`, `cosign verify-attestation --help`,
`cosign signing-config create --help`). They were then run once against a throwaway local
registry, with every outbound HTTPS request sent to a dead proxy. Signing, attesting and
both verifications passed, so none of them needs the internet:

```sh
cosign signing-config create --out signing-config.json   # no services: no transparency log, no timestamp authority
cosign sign --key env://COSIGN_PRIVATE_KEY --signing-config signing-config.json -y <image@digest>
cosign attest --key env://COSIGN_PRIVATE_KEY --signing-config signing-config.json --type cyclonedx --predicate <sbom> -y <image@digest>
cosign public-key --key env://COSIGN_PRIVATE_KEY > cosign.pub
cosign verify --key cosign.pub --insecure-ignore-tlog <image@digest>
cosign verify-attestation --key cosign.pub --insecure-ignore-tlog --type cyclonedx <image@digest>
```

In 3.1.4, `--tlog-upload=false` survives only as a help example. The empty signing config is
what keeps key mode off every public service, as spike S1 found. Never use
`--identity-token`, any `--oidc-*` flag or `COSIGN_EXPERIMENTAL`.

## Updating a pin

Download into a fresh temporary directory. Compare the downloaded SHA-256 with
both the vendor checksum and the candidate repository value, update the pin and
its offline test, then obtain a fresh owner approval before executing the new
tool. Regenerate the Trestle requirement set with `pip download` for CI's
Python and platform; do not add an unhashed dependency or permit source builds.
