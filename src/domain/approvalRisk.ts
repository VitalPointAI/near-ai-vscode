// Why an approval card asks, in the words a person reads (owner, 2026-11-05 for 0.4.17): "explain what the safety issue is and then allow the user
// to expand and see the command or code in question". A reason from the rules, the classifier or the safety model is sorted into one risk class, and
// each class has a plain sentence. The class also keys what "always allow" remembers, so approving one kind of risk teaches the project about that
// kind and not about everything. Pure: no vscode, no I/O.

/** The kinds of risk an approval can be about. */
export const RISK_KINDS = ['outside-workspace', 'destructive', 'leaves-machine', 'credentials', 'installs', 'unsure'] as const;
export type RiskKind = typeof RISK_KINDS[number];

/** What the card says about each kind, before the rule's own sentence. Plain words, no em or en dash. */
export const RISK_HEADLINE: Readonly<Record<RiskKind, string>> = Object.freeze({
  'outside-workspace': 'It reaches outside this project.',
  destructive: 'It can destroy work that cannot be recovered.',
  'leaves-machine': 'It can send data off this machine, or publish.',
  credentials: 'It reads or changes something that can hold keys or secrets.',
  installs: 'It installs or runs software the project did not already have.',
  unsure: 'NEAR AI was not sure this is safe.'
});

/** The longest reason the card shows before the full text goes in the expander. */
const SHORT_REASON_CHARS = 200;

// The classifier's and the safety model's own words, most specific first: a credential path is named before "outside the workspace", because a
// command that names a key file is about the keys even when the file is elsewhere.
const PATTERNS: ReadonlyArray<{ kind: RiskKind; pattern: RegExp }> = [
  { kind: 'credentials', pattern: /credential|secret|knowledge-base|\bkeys?\b|\.env\b|token/i },
  { kind: 'destructive', pattern: /destroy|cannot be recovered|deletes?|removes?|overwrit|force|rm -rf|reset --hard|clean -[a-z]*[fd]/i },
  { kind: 'installs', pattern: /install|downloads? (?:a |an )?(?:package|binary|script)|from the network|runs? code the rules cannot check/i },
  { kind: 'leaves-machine', pattern: /publish|deploy|release|push|send (?:data|it) off|reach(?:es)? the network|exfiltration|carry data out/i },
  { kind: 'outside-workspace', pattern: /outside the workspace|leaves the workspace|another user's home|outside this project/i }
];

/**
 * The risk class a reason is about. The kind the caller already knows wins when it gives one (the agent loop knows a write is outside the
 * workspace, or that a command is a risky one); otherwise the reason's own words decide; a reason that matches nothing is `unsure`, which is the
 * honest answer and is what the safety model's own refusals say.
 */
export function riskKindOf(reason: string | undefined, known?: RiskKind): RiskKind {
  if (known !== undefined) return known;
  const text = reason ?? '';
  for (const { kind, pattern } of PATTERNS) if (pattern.test(text)) return kind;
  return 'unsure';
}

/**
 * What the card shows: the plain headline for the kind, then the rule's own sentence, cut short for the card. The caller puts the whole sentence
 * in the expander, so nothing is lost.
 */
export function riskSentence(reason: string | undefined, known?: RiskKind): { kind: RiskKind; headline: string; detail: string } {
  const kind = riskKindOf(reason, known);
  const detail = (reason ?? '').replace(/\s+/g, ' ').trim();
  const short = detail.length > SHORT_REASON_CHARS ? `${detail.slice(0, SHORT_REASON_CHARS - 1).trimEnd()}\u2026` : detail;
  return { kind, headline: RISK_HEADLINE[kind], detail: short };
}

/**
 * The entry "always allow" saves for a command or a tool: the exact command with its arguments up to the first option, so `git status` and
 * `git status --short` teach the same rule, while `npm test` and `npm run build` stay apart. A command with no leading words worth naming (a
 * wrapper such as `env`, or a script path) saves the whole command trimmed, which is still exact and still safe: it only ever covers itself.
 */
export function exactRuleFor(command: string): string {
  const flat = command.replace(/\s+/g, ' ').trim();
  if (flat === '') return '';
  const words = flat.split(' ');
  const keep: string[] = [];
  for (const word of words) {
    if (keep.length > 0 && word.startsWith('-')) break;
    if (keep.length > 0 && /[|;&><]/.test(word)) break;
    keep.push(word);
    if (keep.length === 3) break;
  }
  return keep.join(' ');
}
