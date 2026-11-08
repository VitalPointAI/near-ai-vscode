// Whether a `curl`/`wget` call is a plain download that sends nothing of the run's with it (owner, 2026-11-06, redesigned 2026-11-08).
//
// THE HISTORY, because it explains the shape. The first attempt was a denylist of flags that send something. The second was an allowlist of flags known to
// send nothing. Three review rounds found a new hole in the allowlist each time: `--resolve` pointing a public name at a private address, `-w
// '%output{path}'` writing a file, `169.254.169.254.nip.io` carrying an address in a name, wget's `-e` being `--execute` rather than curl's referer. Each
// fix was correct and each round found another, because every enumeration of "harmless flags" is incomplete by construction: curl ships flags, and each OS
// reaches an address in a new way.
//
// So this does not enumerate. It accepts EXACTLY ONE canonical shape per program and asks about everything else:
//
//   curl  -sS  [-A <literal>]  [--max-time N]  [-w <status>]  -o <path>  [-w <status>]  <one https URL>
//   wget  -q   [--timeout N]                   -O <path>                <one https URL>
//
// That is the shape a research run actually uses. Anything else, however harmless it looks, asks, and a flag curl ships next year is caught because it is
// not in the shape rather than because nobody listed it.
//
// What the shape guarantees, each checked directly:
//   - one URL, http(s), a PUBLIC host (an address written in the name counts as that address);
//   - every word literal, so no `$VAR`, `${…}`, backtick or `!` can put a secret in the request;
//   - the reply is written to a path the caller then judges like any other write, and -w carries no %output{...} or @file;
//   - no other flag, so no upload, no header, no --resolve, no --execute.
//
// Pure: no I/O. The caller supplies the path rule through `output`.
import { URL } from 'node:url';

export interface PlainDownloadResult {
  plain: boolean;
  url?: string;
  /** Where the reply is written, when the command names a file rather than `/dev/null`. The caller judges it like any other write. */
  output?: string;
  reason?: string;
}

/** A word without the quotes a shell would remove, which is how a URL usually appears in a real command. */
function unquote(word: string): string {
  const trimmed = word.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) return trimmed.slice(1, -1);
  return trimmed;
}

/** No `$`, backtick or `!`: the shell would expand it before curl runs, and an expansion can carry a secret into the URL. */
function isLiteral(word: string): boolean {
  return !/[$`!]/.test(word);
}

/** Whether a dotted quad is a public address. Separate from the host checks so a host that CONTAINS an address cannot recurse. */
export function isPublicAddress(address: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (!match) return false;
  const [a, b] = [Number(match[1]), Number(match[2])];
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  return a < 224;
}

/**
 * Whether a URL names a host on the public internet, so a download cannot reach the machine or its private network. A name that carries an address
 * (`169.254.169.254.nip.io`) is judged as that address, and an IPv4-mapped IPv6 address as the IPv4 it maps to.
 */
export function isPublicHost(url: string): boolean {
  let parsed: URL;
  try { parsed = new URL(unquote(url)); } catch { return false; }
  // `localhost.` is the same host to DNS as `localhost`, so the final dot is stripped.
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) return false;
  // A dotted address written anywhere in the name is judged as an address.
  for (const address of host.match(/(?:\d{1,3}\.){3}\d{1,3}/g) ?? []) if (!isPublicAddress(address)) return false;
  // A name that is only a decimal number is the address it encodes (2130706433 is 127.0.0.1).
  if (/^\d{1,10}$/.test(host)) {
    const value = Number(host);
    if (value > 0 && value <= 4294967295) {
      const octets = [Math.floor(value / 16777216) % 256, Math.floor(value / 65536) % 256, Math.floor(value / 256) % 256, value % 256];
      if (!isPublicAddress(octets.join('.'))) return false;
    }
  }
  if (/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(host)) return isPublicAddress(host);
  if (host.includes(':')) {
    const mappedDotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host);
    if (mappedDotted) return isPublicAddress(mappedDotted[1] as string);
    // Node normalises the dotted form to hex, so `::ffff:127.0.0.1` arrives as `::ffff:7f00:1`.
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
    if (mappedHex) {
      const high = parseInt(mappedHex[1] as string, 16);
      const low = parseInt(mappedHex[2] as string, 16);
      return isPublicAddress(`${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`);
    }
    // Loopback, unspecified, unique-local (fc00::/7) and link-local (fe80::/10) ask; another public IPv6 host is fine.
    if (host === '::1' || host === '::') return false;
    if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return false;
  }
  return true;
}

/** `-w`/`--write-out` is harmless text UNLESS it names an output, which writes the reply to any path. */
function writesThroughWriteOut(value: string): boolean {
  return /%output|@/.test(unquote(value));
}

/** The one word that must be a public http(s) URL, shared by both programs. */
function withUrl(result: PlainDownloadResult, word: string): PlainDownloadResult {
  if (!isLiteral(word)) return { plain: false, reason: `${word} is expanded by the shell, which can carry a secret into the request` };
  const bare = unquote(word);
  let parsed: URL;
  try { parsed = new URL(bare); } catch { return { plain: false, reason: `"${bare}" is not a URL` }; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { plain: false, reason: `${bare} is not an http or https URL` };
  if (!isPublicHost(bare)) return { plain: false, reason: `${bare} is on the local machine or a private network` };
  return { ...result, plain: true, url: bare };
}

/** A number of seconds, as curl and wget write it. */
const seconds = (value: string | undefined): boolean => value !== undefined && /^\d{1,6}$/.test(value);

/** The canonical curl shape, and nothing else. */
function canonicalCurl(words: readonly string[]): PlainDownloadResult {
  const rest = [...words];
  const quiet = rest.shift();
  if (quiet !== '-sS' && quiet !== '-s' && quiet !== '-Ss' && quiet !== '-S') return { plain: false, reason: 'a plain download starts with -sS' };
  // The user agent is part of the shape a research run uses (`-A "curl/8"`); it sends a header, which is safe only because every word must be literal.
  while (rest.length && (rest[0] === '-A' || rest[0] === '--user-agent')) {
    const value = rest[1];
    if (value === undefined || !isLiteral(value)) return { plain: false, reason: `${rest[0]} needs a literal value` };
    rest.splice(0, 2);
  }
  while (rest.length && (rest[0] === '--max-time' || rest[0] === '-m' || rest[0] === '--connect-timeout')) {
    if (!seconds(rest[1])) return { plain: false, reason: `${rest[0]} needs a number of seconds` };
    rest.splice(0, 2);
  }
  const result: PlainDownloadResult = { plain: false };
  // An optional status write-out may come before or after -o, as long as it does not write the reply anywhere.
  if (rest[0] === '-w' || rest[0] === '--write-out') {
    if (rest[1] === undefined) return { plain: false, reason: '-w needs a value' };
    if (writesThroughWriteOut(rest[1])) return { plain: false, reason: '-w names an output, so the reply is written to a path' };
    rest.splice(0, 2);
  }
  if (rest[0] !== '-o' && rest[0] !== '--output') return { plain: false, reason: 'a plain download writes to a path with -o' };
  const target = rest[1];
  if (target === undefined) return { plain: false, reason: '-o needs a path' };
  if (!isLiteral(target)) return { plain: false, reason: `${target} is expanded by the shell` };
  rest.splice(0, 2);
  if (unquote(target) !== '/dev/null') result.output = unquote(target);
  const trailing = rest[0] as string | undefined;
  if (trailing === '-w' || trailing === '--write-out') {
    if (rest[1] === undefined) return { plain: false, reason: '-w needs a value' };
    if (writesThroughWriteOut(rest[1])) return { plain: false, reason: '-w names an output, so the reply is written to a path' };
    rest.splice(0, 2);
  }
  if (rest.length !== 1) return { plain: false, reason: rest.length ? 'a plain download has one URL and nothing after it' : 'no URL' };
  return withUrl(result, rest[0] as string);
}

/** The canonical wget shape, and nothing else. */
function canonicalWget(words: readonly string[]): PlainDownloadResult {
  const rest = [...words];
  const quiet = rest.shift();
  if (quiet !== '-q' && quiet !== '--quiet') return { plain: false, reason: 'a plain download starts with -q' };
  while (rest.length && (rest[0] === '--timeout' || rest[0] === '-T' || rest[0] === '--tries' || rest[0] === '-t')) {
    if (!seconds(rest[1])) return { plain: false, reason: `${rest[0]} needs a number` };
    rest.splice(0, 2);
  }
  if (rest[0] !== '-O' && rest[0] !== '--output-document') return { plain: false, reason: 'a plain download writes to a path with -O' };
  const target = rest[1];
  if (target === undefined) return { plain: false, reason: '-O needs a path' };
  if (!isLiteral(target)) return { plain: false, reason: `${target} is expanded by the shell` };
  rest.splice(0, 2);
  const result: PlainDownloadResult = { plain: false };
  if (unquote(target) !== '/dev/null' && unquote(target) !== '-') result.output = unquote(target);
  if (rest.length !== 1) return { plain: false, reason: rest.length ? 'a plain download has one URL and nothing after it' : 'no URL' };
  return withUrl(result, rest[0] as string);
}

/**
 * Whether these words (the program's arguments, without the program name) are the canonical plain download for that program. `program` is the bare binary
 * name; anything but curl or wget has no plain download at all, so it asks.
 */
export function plainDownload(words: readonly string[], program: string): PlainDownloadResult {
  if (program === 'curl') return canonicalCurl(words);
  if (program === 'wget') return canonicalWget(words);
  return { plain: false, reason: `${program} is not a program whose downloads are checked` };
}
