# Cryptography inventory

Last reviewed: 2026-11-21

This inventory lists every cryptographic algorithm the code in this repository uses: the
extension (`src/`), the messaging relay (`relay/`), the sync hub (`hub/`) and the issuer tool your
organization uses to sign its rules (`scripts/org-issuer.mjs`). For each one it says
where it is used, whether the Cyber Centre's ITSP.40.111, *Cryptographic algorithms for
UNCLASSIFIED, PROTECTED A, and PROTECTED B information*, version 5 (effective 2026-05-29), names
it, and the basis for using it. It is our own reading of that publication, for your
organization's security officer to check.

The third column uses three words, each a fact about the list and not a judgement of the
algorithm:

- **listed:** the publication names the algorithm among those it recommends;
- **listed with conditions:** it names the algorithm, with a condition such as a date to phase it
  out or pair it with another scheme;
- **not listed:** the publication does not name it.

## Algorithms

| Algorithm | Where used | ITSP.40.111 (version 5) | Basis |
| --- | --- | --- | --- |
| AES-256-GCM | Sealing project state and saved conversations, the encrypted copy of the NEAR AI key, cell keys wrapped to devices and the sealed labels of shared staff projects, and your organization's issuer key file (`src/domain/state/keys.ts`, `src/services/transcripts.ts`, `src/domain/replica/cellKeys.ts`, `scripts/org-issuer.mjs`) | listed | AES in Galois/Counter Mode (NIST SP 800-38D) with a 256-bit key, a 96-bit random IV and a 128-bit tag |
| HKDF-SHA256 | One subkey per purpose or object from a project's data key, the key that wraps a cell key for one device, the key that seals a cell's label, and the hub's check key for an invitation (`src/domain/state/keys.ts`, `src/domain/replica/cellKeys.ts`, `src/domain/replica/invite.ts`, `hub/src/enrol.ts`) | listed | The two-step key derivation of NIST SP 800-56C Rev. 2, with SHA-256 |
| scrypt | Deriving the key that wraps a project's data key from its recovery code (`src/domain/state/keys.ts`), and the key that seals your organization's issuer key from its passphrase (`scripts/org-issuer.mjs`); both with N = 2^17, r = 8, p = 1, a 16-byte random salt and a 32-byte key | not listed | The publication recommends PBKDF per NIST SP 800-132 for keys derived from passwords and does not name scrypt. A recovery code is not a chosen password: it is a generated code of 256 random bits, so the key's strength rests on the code. The issuer passphrase is chosen by a person, at least 12 characters, and the tool is meant to run on a computer kept offline. In both, scrypt adds a memory-hard cost of about 128 MiB to each guess |
| Ed25519 | Each install's device signing key: signed policies, labels, decision records, staff entries, invitations and join requests; your organization's issuer key for its rules and enrolment files; the hub's own signing key for checkpoints and hub files (`src/team/identity.ts`, `src/domain/replica/invite.ts`, `src/domain/replica/hubFile.ts`, `scripts/org-issuer.mjs`, `hub/src/keys.ts`) | listed with conditions | EdDSA on Edwards25519 is recommended; the publication says EdDSA used without a post-quantum signature scheme is to be phased out by the end of 2035 |
| X25519 | The key agreement that wraps a cell key to each device in a shared staff project, and the hub's encryption key (`src/domain/replica/cellKeys.ts`, `src/staff/replica/keyring.ts`, `hub/src/keys.ts`) | not listed | The version 5 list for elliptic-curve key agreement names curves P-224, P-256, P-384 and P-521 only. X25519 gives about 128-bit strength, comparable to P-256. The security policy already requires any new public-key step in sync to be a hybrid of X25519 and ML-KEM |
| SHA-256 | Content and file hashes, the sync manifest, the SHA-256 checksum of each release, certificate key pins, the request and response hashes checked against NEAR AI Cloud's signatures, and vendored-file hashes (throughout `src/`, `relay/src/`, `hub/src/` and `scripts/`) | listed | SHA-256 of FIPS 180-4 |
| HMAC-SHA256 | The proof in a join request, the hub file's enrolment proof and the hub's join check (`src/domain/replica/invite.ts`, `src/domain/replica/hubFile.ts`), and the stable labels the relay's logs use in place of phone numbers (`relay/src/log/redact.ts`) | listed | HMAC of FIPS 198-1 with SHA-256 |
| ECDSA P-256 with SHA-256 | Verifying only: the signature of an Intel TDX quote from NEAR AI Cloud and its certificate chain to Intel's root (`src/services/attestation.ts`) | listed | ECDSA on curve P-256; the product checks these signatures and never makes them |
| ECDSA secp256k1 with Keccak-256 | Verifying only: the signature NEAR AI Cloud puts on each answer, in the format its own verifier defines (`src/services/attestation.ts`) | not listed | Neither the curve nor the hash is on the list. NEAR AI Cloud chooses this format; the product checks the signature and never makes one, and the security policy says what the trust badge does and does not check |
| Random numbers from Node's `randomBytes` | Every key, IV, salt, recovery code, join secret and nonce the product makes | listed | The runtime's generator (see Basis): in both libraries, a deterministic random bit generator of NIST SP 800-90A seeded by the operating system |
| TLS through Node's defaults | Every HTTPS connection: model endpoints, web pages and searches, OSV.dev, GitHub; members' connections to the hub and the hub's own listener use TLS 1.3 only, and a session is bound to the connection's exported keying material (`src/staff/replica/hubTransport.ts`, `hub/src/http/server.ts`) | not listed | TLS is a protocol, and the publication lists algorithms; the Cyber Centre's guidance for configuring it is ITSP.40.062. Other connections use Node's defaults, which allow TLS 1.2 and 1.3 |
| MD5 | The file identifier inside PDF files the agent writes (`src/agent/pdfWriter.ts`) | not listed | The PDF format's `/ID` field only; it protects nothing and no check relies on it |

SHA-1 and SHA-512 appear only in the tests. Compression (brotli) and padding are not cryptography
and are left out.

## Basis

- **Node's built-in cryptography.** Every algorithm above comes from the `node:crypto` module of
  the runtime the code runs in, except the Keccak-256 and secp256k1 arithmetic for answer
  signatures, which the extension implements itself. In VS Code on the desktop the extension runs
  in Electron's Node, whose `node:crypto` is built on BoringSSL; in an editor that runs extensions
  in plain Node, such as code-server, and for the relay, the hub and the issuer tool, it is the
  OpenSSL that Node bundles. The product adds no cryptographic library of its own.
- **No FIPS mode.** Node's built-in cryptography, as the product uses it, is not run as a
  FIPS 140 validated module. The product does not turn on Node's FIPS mode, and its tests do not
  run with it. Nothing in this inventory says that any module is validated.
- **Comparable strength.** Where an algorithm is not listed, the basis column says what it is
  comparable to. Every algorithm that protects data at rest or in transit gives at least
  128-bit strength.
- **Your organization decides.** Whether comparable strength without a validated module is enough
  for the information your organization handles is your organization's decision, made by its
  security officer for its own system.
- **What is planned.** Evaluating a FIPS 140-3 validated provider for the hub and the appliance,
  where the operating system can supply one, is POA&M item `x08` (`compliance/poam/x08.json`).
