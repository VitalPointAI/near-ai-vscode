/**
 * Well-known credential shapes, found anywhere in the text: OpenAI-style `sk-…`, Stripe, GitHub, GitLab, AWS access keys, Slack and JWTs. Shared with
 * the activity feed's display redaction, so there is one list.
 */
export const SECRET_TOKENS = /\b(?:sk-[A-Za-z0-9_-]{20,}|sk_(?:live|test)_[A-Za-z0-9]{10,}|gh[pousr]_[A-Za-z0-9]{30,}|glpat-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+)\b/g;

/**
 * A secret's name, then `:` or `=`, then its value. The name may be quoted (JSON's `"apiKey": "…"`, 0.4.19 review: the old pattern needed the colon
 * right after the name, so JSON was never redacted), and a quoted value is replaced inside its quotes. Only names that mean a secret are matched, and
 * only when a value is assigned to them, so prose such as "the password was changed" is left alone.
 */
const SECRET_ASSIGNMENT = /((?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|authorization|client[-_ ]?secret|\b[A-Za-z0-9]*[_-]?(?:secret|password|passwd)(?:[_-][A-Za-z0-9]+)*)["']?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi;

/**
 * A recovery code (D-18: 52 Crockford base32 characters, shown as 13 groups of 4) or a long piece of one: eight or more groups of four joined by hyphens, in
 * either case (a person may type it in lower case), or 32 or more of the characters in a row, in upper case as it is shown. An accidental error string
 * cannot print one (Pitfall 11). Hex digests in lower case, hyphenated words and ordinary prose do not look like this.
 *
 * Both patterns also need at least one Crockford letter outside 0-9 and A-F (G, H, J, K, M, N, P, Q, R, S, T, V, W, X, Y, Z). A hex digest (SHA-256, SHA-1, a
 * git object id) is made only of 0-9 and A-F, so its upper-case form falls inside the Crockford set and would otherwise be redacted out of cyber evidence.
 * A generated 52-character code is all hex with chance 2 to the power -52, and a 32-character piece of one with chance 2 to the power -32, so no real code
 * is let through in practice.
 */
const RECOVERY_CODE_GROUPS = /(?<![0-9A-Za-z-])(?=[0-9A-F-]*[G-HJKMNP-TV-Z])(?:[0-9A-HJKMNP-TV-Z]{4}-){7,}[0-9A-HJKMNP-TV-Z]{4}(?![0-9A-Za-z-])/gi;
const RECOVERY_CODE_RUN = /(?<![0-9A-Za-z_])(?=[0-9A-F]*[G-HJKMNP-TV-Z])[0-9A-HJKMNP-TV-Z]{32,}(?![0-9A-Za-z_])/g;

export function redactSecrets(value: string): string {
  const bearerSafe = value.replace(/bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]');
  return bearerSafe
    .replace(/\brpt-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(SECRET_ASSIGNMENT, (_match, name: string, secret: string) => `${name}${/^["']/.test(secret) ? `${secret[0]}[REDACTED]${secret[0]}` : '[REDACTED]'}`)
    .replace(SECRET_TOKENS, '[REDACTED]')
    .replace(RECOVERY_CODE_GROUPS, '[REDACTED]')
    .replace(RECOVERY_CODE_RUN, '[REDACTED]');
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Credentials carried by a command's arguments (PR #70 review carry-over). A decision record names a shell call by its command's first line, and a
// command carries a credential in a handful of fixed ways that no token shape above recognises (`curl -u user:pass`, `--password=x`, a header, an
// environment assignment). Each way is a class matched by where the value sits, not by what it looks like, so a password of any shape is removed.
// ---------------------------------------------------------------------------------------------------------------------------------------------------

const REDACTED = '[REDACTED]';

/** `scheme://user:password@host` and `scheme://token@host`: the whole user part is removed, whatever it holds. */
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/?#@'"]+)@/gi;

/** `-u user:pass`, `-uuser:pass`, `--user user:pass`, `--user=user:pass`, `--proxy-user …`, `-U …` (curl's proxy user): a value with a colon is a password. */
const USER_OPTION = /(^|[\s;&|(])(--(?:proxy-)?user(?:=|\s+)|-[uU]\s*)(?:"([^"\n]*:[^"\n]*)"|'([^'\n]*:[^'\n]*)'|([^\s"';&|)]*:[^\s"';&|)]*))/g;

/** A numeric user and group (`docker run --user 1000:1000`): no password, so the value is kept (PR #74 review round 2). Digits only on both sides. */
const NUMERIC_USER_GROUP = /^\d+:\d+$/;

/** An option, `-x` or `--x`, then `=` or spaces, then its value: a quoted string or one word that does not start another option. */
const OPTION_WITH_VALUE = /(^|[\s;&|(])(--?[A-Za-z][\w-]*)(=|\s+)("[^"\n]*"|'[^'\n]*'|(?!-)[^\s;&|)]+)/g;
/** An option named for a credential: a password, passphrase, secret or credential anywhere in its name, a token or API key at its end, `pass` as its last word (`--pass`, `--db-pass`, keytool's `-storepass`), or `--auth`. */
function credentialOption(option: string): boolean {
  const name = option.replace(/^-+/, '');
  if (CREDENTIAL_LOCATION.test(name)) return false;
  return /password|passwd|passphrase|secret|credential/i.test(name) || /(?:tokens?|api[-_]?key|apikey)$/i.test(name) || /(?:^|[-_]|store|key)pass$/i.test(name) || /^auth$/i.test(name);
}
/** An option named for a credential but whose value is where one is kept, never the credential itself: a file, a path, a variable's name, and the like. */
const CREDENTIAL_LOCATION = /[-_](?:file|path|stdin|env|dir|name|id|type|url|uri|helper|cmd|command|prompt|length|ttl)$/i;

/**
 * A header that carries a credential, then a colon, then its value up to the closing quote or the end of the line. A value already removed is matched as
 * itself first, so a header whose quotes another rule took away does not then swallow the rest of the line.
 */
const CREDENTIAL_HEADER = /(?<![\w-])((?:proxy-)?authorization|cookie|private-token|x-api-key|api-key|x-[\w-]*?(?:token|auth|secret|password|key)[\w-]*)(\s*:\s*)(\[REDACTED\]|[^"'\s][^"'\n]*)/gi;

/**
 * `NAME=value`, at the start of a command or after a space, a separator, `=`, `?`, a quote or a comma (so `export`, `env`, `set`, `docker -e`, `--env=`, a
 * prefix assignment, a URL's query parameter and a form body such as `curl -d "password=..."` all match). An unquoted value ends at a quote or a comma, so
 * the quote around a form body stays where it was (PR #74 review round 7).
 */
const ENV_ASSIGNMENT = /(^|[\s;&|(`=?"',])([A-Za-z_][A-Za-z0-9_]*)=("[^"\n]*"|'[^'\n]*'|[^\s;&|)`"',]+)/g;
/** A variable named for a credential: one of these words as a part of the name between underscores, or a name that contains password, secret or token. */
const CREDENTIAL_NAME_PART = /^(?:token|secret|password|passwd|pass|passphrase|key|apikey|credential|credentials|auth|pat)$/i;
const CREDENTIAL_NAME_WORD = /password|passwd|secret|token|apikey/i;

function credentialVariable(name: string): boolean {
  return CREDENTIAL_NAME_WORD.test(name) || name.split('_').some((part) => CREDENTIAL_NAME_PART.test(part));
}

/** The value with its own quotes kept and its content replaced. */
function replaced(value: string): string {
  return /^["']/.test(value) ? `${value[0]}${REDACTED}${value[0]}` : REDACTED;
}

/**
 * Removes the credentials a command carries in its arguments, by class: the user part of a URL; the value of `-u`/`--user`/`--proxy-user`/`-U` when it holds
 * a colon; the value of an option named for a password, passphrase, token, secret, API key or credential (`--password=x`, `--token x`, `-storepass x`), but
 * not one that names where a credential is kept (`--token-file`, `--password-stdin`); the value of an `Authorization`, `Proxy-Authorization`, `Cookie`,
 * `Private-Token` or `X-…-Token`/`-Key`/`-Auth`/`-Secret` header; and the value of an environment assignment named for one (`GITHUB_TOKEN=…`, `PGPASSWORD=…`,
 * `AWS_SECRET_ACCESS_KEY=…`) or a URL query parameter named for one (`?api_key=…`), unless the value is only a reference to another variable (`$TOKEN`).
 * Applying it twice gives the same text.
 *
 * Not removed: a credential passed as a plain positional argument (`sshpass -p`, `mysql -psecret`, `htpasswd -b file user pass`), one inside a script or
 * here-document the command runs, one built by command substitution, and one under an option or variable name not described above.
 */
export function redactCredentialArguments(text: string): string {
  return text
    .replace(URL_USERINFO, (_match, scheme: string) => `${scheme}${REDACTED}@`)
    .replace(USER_OPTION, (match, before: string, option: string, double?: string, single?: string, bare?: string) =>
      (NUMERIC_USER_GROUP.test(double ?? single ?? bare ?? '') ? match : `${before}${option}${double !== undefined ? `"${REDACTED}"` : single !== undefined ? `'${REDACTED}'` : REDACTED}`))
    .replace(OPTION_WITH_VALUE, (match, before: string, option: string, joiner: string, value: string) =>
      (credentialOption(option) ? `${before}${option}${joiner}${replaced(value)}` : match))
    .replace(CREDENTIAL_HEADER, (_match, name: string, colon: string) => `${name}${colon}${REDACTED}`)
    .replace(ENV_ASSIGNMENT, (match, before: string, name: string, value: string) => {
      const inner = value.replace(/^(["'])(.*)\1$/, '$2');
      if (!credentialVariable(name) || inner === '' || /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(inner)) return match;
      return `${before}${name}=${replaced(value)}`;
    });
}
