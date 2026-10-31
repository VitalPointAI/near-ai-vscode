// Write-side secret refusal (D-23, SEC-01). Pure: no I/O, no vscode.
// Every event body, team.json and team audit entry goes through assertNoSecrets before it is written.
// This is a write guard only. The read path must not call it, because a later change to the detector would
// then change which committed events are accepted. Read-side matches are reported as warnings instead.
import { redactSecrets } from '../redaction';

// A token must not continue an identifier or a longer word, so it is preceded by anything except a letter or digit.
const PKCS8_ED25519 = /MC4CAQAwBQYDK2VwBCIEI[A-Za-z0-9+/_-]*/;
const PEM_PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

export const SECRET_PATTERNS: readonly RegExp[] = Object.freeze([
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{8,}/,
  /(?<![A-Za-z0-9])sk_(?:live|test)_[A-Za-z0-9]{8,}/,
  /(?<![A-Za-z0-9])rpt-[A-Za-z0-9_-]{8,}/,
  /(?<![A-Za-z0-9])rt_[A-Za-z0-9_-]{8,}/,
  /(?<![A-Za-z0-9])adm_[A-Za-z0-9_-]{8,}/,
  /(?<![A-Za-z0-9])oc_[A-Za-z0-9_-]{8,}/,
  /(?<![A-Za-z0-9])bearer\s+[^\s,;]+/i,
  /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
  PEM_PRIVATE_KEY,
  PKCS8_ED25519
]);

// Generated key material is random base64url, so a token pattern can match it by chance. Values of exactly these
// shapes under these keys skip the token patterns but are still checked for private key material.
const PUBLIC_KEY_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const SIGNATURE_SHAPE = /^[A-Za-z0-9_-]{86}$/;
const MAX_DEPTH = 64;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export class SecretLeakError extends Error {
  public readonly paths: readonly string[];
  public constructor(message: string, paths: readonly string[]) {
    super(message);
    this.name = 'SecretLeakError';
    this.paths = paths;
  }
}

function looksSecret(text: string): boolean {
  if (text.length === 0) { return false; }
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) { return true; }
  }
  return redactSecrets(text) !== text;
}

function isPrivateKeyMaterial(text: string): boolean {
  return PKCS8_ED25519.test(text) || PEM_PRIVATE_KEY.test(text);
}

function isExemptKeyMaterial(key: string | undefined, text: string): boolean {
  return (key === 'publicKey' && PUBLIC_KEY_SHAPE.test(text)) || (key === 'sig' && SIGNATURE_SHAPE.test(text));
}

function stringIsFinding(key: string | undefined, text: string): boolean {
  return isExemptKeyMaterial(key, text) ? isPrivateKeyMaterial(text) : looksSecret(text);
}

interface Frame { value: unknown; path: string; key: string | undefined; depth: number }

// Returns JSON-style paths of every string, or object key, that looks like a secret. Never returns the matched text.
// A key that looks like a secret is reported as "<parent> key name" and its children use "[key]" so the key text
// is not repeated in any path.
export function findSecrets(value: unknown): string[] {
  const findings: string[] = [];
  const stack: Frame[] = [{ value, path: '$', key: undefined, depth: 0 }];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) { break; }
    const current = frame.value;
    if (typeof current === 'string') {
      if (stringIsFinding(frame.key, current)) { findings.push(frame.path); }
      continue;
    }
    if (typeof current !== 'object' || current === null) { continue; }
    if (frame.depth >= MAX_DEPTH) {
      findings.push(frame.path);
      continue;
    }
    const children: Frame[] = [];
    if (Array.isArray(current)) {
      current.forEach((item: unknown, index: number) => {
        children.push({ value: item, path: `${frame.path}[${index}]`, key: undefined, depth: frame.depth + 1 });
      });
    } else {
      for (const name of Object.keys(current)) {
        const entry = (current as Record<string, unknown>)[name];
        if (looksSecret(name)) {
          findings.push(`${frame.path} key name`);
          children.push({ value: entry, path: `${frame.path}[key]`, key: undefined, depth: frame.depth + 1 });
        } else {
          const segment = IDENTIFIER.test(name) ? `.${name}` : `[${JSON.stringify(name)}]`;
          children.push({ value: entry, path: `${frame.path}${segment}`, key: name, depth: frame.depth + 1 });
        }
      }
    }
    for (let index = children.length - 1; index >= 0; index -= 1) { stack.push(children[index]); }
  }
  return findings;
}

export function assertNoSecrets(value: unknown, what: string): void {
  const paths = findSecrets(value);
  if (paths.length === 0) { return; }
  throw new SecretLeakError(`${what} contains a secret-like value at ${paths[0]}; nothing was written.`, paths);
}
