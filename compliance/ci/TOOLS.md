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

## Updating a pin

Download into a fresh temporary directory. Compare the downloaded SHA-256 with
both the vendor checksum and the candidate repository value, update the pin and
its offline test, then obtain a fresh owner approval before executing the new
tool. Regenerate the Trestle requirement set with `pip download` for CI's
Python and platform; do not add an unhashed dependency or permit source builds.
