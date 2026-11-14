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
