// Whether a `curl`/`wget` call is a plain download that sends nothing of the run's with it (owner, 2026-11-06: "invert the curl rule if it's more
// resilient and adaptive").
//
// The first attempt was a denylist: assume a download, then name the flags that send something. Three review rounds each found another flag it missed
// (`--url-query @.env`, `-H "Authorization: …"`, `--netrc`, `-o`). A denylist fails open: every flag curl adds later is a new hole.
//
// This is the inverse, which fails closed. A call is a plain download only when every one of its flags is on a short list known not to send anything,
// and it has exactly one URL. Anything else asks a person:
//   - a flag not on the list (unknown, new, or plainly a sender such as -d, -F, -T, -H, -b, -u, -K, --netrc, --json, --url-query, -X POST);
//   - a bare word after the URL that is not the write target of -o, a value the list expects, or `-` for a body;
//   - a URL that is not http(s).
import { URL } from 'node:url';

/** Flags that take no value, and send nothing: silence, errors, redirects, timing, compression, address family, TLS verification, output naming. */
const VALUELESS = new Set([
  '-s', '-S', '-sS', '-Ss', '-L', '-i', '-I', '-f', '-k', '-g', '-v', '-4', '-6', '-q', '-C', '-#',
  '--silent', '--show-error', '--location', '--include', '--head', '--fail', '--insecure', '--compressed', '--globoff', '--verbose',
  '--ipv4', '--ipv6', '--http1.1', '--http2', '--no-progress-meter', '--remote-name', '--remote-header-name', '--progress-bar',
  // wget's own harmless ones
  '-nv', '-nc', '-N', '--no-verbose', '--no-clobber', '--timestamping', '--spider', '--no-check-certificate', '--https-only'
]);

/** Flags whose value is the next word, all known to carry nothing of the run's: method is GET, headers are absent, the body is `-`. */
const TAKES_VALUE = new Set([
  '-o', '--output', '-w', '--write-out', '-A', '--user-agent', '-m', '--max-time', '--connect-timeout', '--retry', '--retry-delay',
  '--retry-max-time', '--limit-rate', '--max-filesize', '--referer', '-e', '--resolve', '--cacert', '--capath', '--tlsv1.2', '--tlsv1.3',
  '--max-redirs', '-r', '--range', '--dns-servers', '--interface', '--local-port', '--timeout', '--tries', '--waitretry', '-P', '--directory-prefix',
  '--output-document', '--user-agent-http'
]);

/** Regex forms of the same: `--flag=value` and `-oVALUE`. */
const VALUELESS_PREFIX = [...VALUELESS];
const TAKES_VALUE_PREFIX = [...TAKES_VALUE];

export interface PlainDownloadResult { plain: boolean; url?: string; reason?: string }

/** A word without the quotes a shell would remove, which is how a URL usually appears in a real command. */
function unquote(word: string): string {
  const trimmed = word.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isUrl(word: string): boolean {
  try {
    const parsed = new URL(unquote(word));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Whether these words (the program's arguments, without the program name) describe one plain download. `plain` is true only when every flag is on the
 * harmless list and exactly one http(s) URL is given; anything else is false, which the caller turns into a question.
 */
export function plainDownload(words: readonly string[]): PlainDownloadResult {
  const urls: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] as string;
    if (isUrl(word)) { urls.push(unquote(word)); continue; }
    if (word.startsWith('-')) {
      // A value attached with `=` or straight after a short flag.
      const equals = /^(--?[A-Za-z0-9][\w-]*)=(.*)$/.exec(word);
      if (equals) {
        const flag = equals[1] as string;
        if (!TAKES_VALUE.has(flag)) return { plain: false, reason: `${flag} is not a flag known to send nothing` };
        if (isUrl(equals[2] as string)) urls.push(unquote(equals[2] as string));
        continue;
      }
      if (VALUELESS.has(word)) continue;
      // `-o/tmp/page.html`, `-w"code=%{http_code}"`: a short flag with its value attached.
      const attached = /^(-[A-Za-z])(.+)$/.exec(word);
      if (attached && TAKES_VALUE.has(attached[1] as string)) continue;
      if (TAKES_VALUE.has(word)) {
        // Its value is the next word, which must not be another flag.
        const value = words[index + 1];
        if (value === undefined || (value.startsWith('-') && value !== '-')) return { plain: false, reason: `${word} has no value` };
        index += 1;
        if (isUrl(value)) urls.push(unquote(value));
        continue;
      }
      // A combined short form such as -sSL, every letter of which must be harmless.
      if (/^-[A-Za-z]{2,}$/.test(word) && [...word.slice(1)].every((letter) => VALUELESS.has(`-${letter}`) || VALUELESS.has(`-${letter.toUpperCase()}`))) continue;
      return { plain: false, reason: `${word} is not a flag known to send nothing` };
    }
    // A bare word that is neither a URL nor consumed as a flag value: wget's target file name, or stray text.
    return { plain: false, reason: `"${word}" is not a URL` };
  }
  if (urls.length !== 1) return { plain: false, reason: urls.length === 0 ? 'no URL' : 'more than one URL' };
  void VALUELESS_PREFIX; void TAKES_VALUE_PREFIX;
  return { plain: true, url: urls[0] as string };
}
