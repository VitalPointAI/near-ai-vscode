# 71-01 Task 1: package check of the three test-only packages

**Checked:** 2026-11-24 by Claude (agent), for the owner to confirm. **Status:** waiting for the owner (blocking-human gate). Nothing is installed in the repository.

How it was checked, without installing or running any package code:
- `npm view <package> --json` for each package (registry metadata).
- A lockfile-only resolution in a scratch folder (`npm install --package-lock-only --ignore-scripts`; no tarball fetched, no script run) to list the whole tree the three pull in.
- For each of the 25 packages in that tree: the registry manifest of that exact version, the npm registry ECDSA signature over `<name>@<version>:<integrity>` checked with `node:crypto` against npm's published keys (`https://registry.npmjs.org/-/npm/v1/keys`), the integrity compared with the lockfile, the licence, install scripts (`preinstall`, `install`, `postinstall`), and whether a provenance attestation exists. This is what `npm audit signatures` checks, done on metadata only because that command needs an installed tree.
- `npm audit --package-lock-only` on the resolved tree.
- GitHub: each repository exists under the `digitalbazaar` organization, is not archived, and has a tag for the version proposed.

## The three packages

| | `@digitalbazaar/vc` | `@digitalbazaar/eddsa-jcs-2022-cryptosuite` | `@digitalbazaar/vc-bitstring-status-list` |
|---|---|---|---|
| Version proposed (exact pin) | **7.3.0** (latest, not a pre-release) | **1.0.0** (latest and only version) | **2.0.1** (latest, not a pre-release) |
| Published | 2026-02-05 | 2024-11-08 | 2025-03-07 |
| Publisher of that version | davidlehn (Digital Bazaar maintainer) | gannan@digitalbazaar.com | davidlehn |
| Maintainers | dlongley, msporny, gannan (all @digitalbazaar.com), davidlehn | the same plus mattcollier@digitalbazaar.com | dlongley, msporny, gannan, davidlehn |
| Repository | github.com/digitalbazaar/vc (216 stars, tag v7.3.0) | github.com/digitalbazaar/eddsa-jcs-2022-cryptosuite (tag v1.0.0) | github.com/digitalbazaar/vc-bitstring-status-list (tag v2.0.1) |
| Licence (npm and GitHub) | BSD-3-Clause | BSD-3-Clause | BSD-3-Clause |
| Weekly downloads (2026-11-17 to 23) | 37,957 | 10,524 | 5,832 |
| Direct dependencies | `@digitalbazaar/credentials-context`, `jsonld`, `jsonld-signatures` | `canonicalize`, `@digitalbazaar/ed25519-multikey` | `@digitalbazaar/bitstring`, `@digitalbazaar/credentials-context`, `@digitalbazaar/vc`, `@digitalbazaar/vc-bitstring-status-list-context` |
| Install scripts | none | none | none |
| Registry signature | valid | valid | valid |
| Provenance attestation | none | none | none |

## The whole tree (25 packages, all devDependencies)

| Result | Count |
|---|---|
| Registry signature valid against npm's keys | 25 of 25 |
| Integrity in the registry equals the lockfile | 25 of 25 |
| Packages with an install script | 0 |
| Packages with a provenance attestation | 1 (`undici` 6.29.1, published from GitHub Actions) |
| `npm audit` advisories | 0 |

Packages, with licence and publisher:
- Digital Bazaar (BSD-3-Clause): `@digitalbazaar/bitstring` 3.1.0, `credentials-context` 3.2.0 (BSD-3-Clause code, W3C Software and Document licence for the context files), `ed25519-multikey` 1.3.1, `http-client` 4.4.0, `security-context` 1.0.1, `vc-bitstring-status-list-context` 1.1.0, `base58-universal` 2.0.0, `base64url-universal` 2.0.0, `jsonld` 9.0.0, `jsonld-signatures` 11.6.0, `rdf-canonize` 5.0.0.
- Others: `canonicalize` 2.1.0 (Apache-2.0, Samuel Erdtman, an author of RFC 8785), `@noble/ed25519` 1.7.5 (MIT, Paul Miller), `base64url` 3.0.1 (MIT), `ky` 1.14.3 (MIT), `undici` 6.29.1 (MIT, Node.js project), `lru-cache` 6.0.0 and `yallist` 4.0.0 (ISC, isaacs), `pako` 2.2.0 (MIT AND Zlib), `serialize-error` 8.1.0 and `type-fest` 0.20.2 (MIT, sindresorhus), `setimmediate` 1.0.5 (MIT).

## Points for the owner

1. **No provenance on the Digital Bazaar packages.** Their versions are signed by the npm registry (checked) but carry no build provenance, so the tarball cannot be tied to a commit by a signature; the GitHub tags exist for each version. This is normal for these packages and is why D-20 keeps them test-only.
2. **`eddsa-jcs-2022-cryptosuite` has one release (1.0.0, November 2024) and no update since.** Its maintainers dlongley and msporny are the authors of the specification (Dave Longley and Manu Sporny, Digital Bazaar, named on the W3C Recommendation of 15 May 2025, which came after this release; the W3C vectors in our test show whether it still matches). We use it only as a test oracle.
3. **Network-capable code in the tree.** `jsonld` brings `@digitalbazaar/http-client`, `ky` and `undici`, because by default it fetches JSON-LD contexts over HTTP. Our tests will pass a static document loader that holds the needed contexts and refuses any other URL, so no test touches the network.
4. **Not unrelated to the job:** everything else is JSON-LD, Data Integrity, Ed25519, base encoding, gzip for the bitstring, or small utilities of those.
5. All three are ES modules; the tests load them with a dynamic `import()` (Node 24 supports it from our CommonJS test build).

## The question

Type "approved" with the three exact versions (`@digitalbazaar/vc` 7.3.0, `@digitalbazaar/eddsa-jcs-2022-cryptosuite` 1.0.0, `@digitalbazaar/vc-bitstring-status-list` 2.0.1), or name the package to drop.

After approval, Task 2 installs them with `npm install --save-dev --save-exact --ignore-scripts`, adds their compliance fit entries, and Task 3 adds the Digital Bazaar cross-check both ways and the 2,000-value RFC 8785 generator against `canonicalize`, then records the JCS verdict.
