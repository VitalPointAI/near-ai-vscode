// How much of a shell command NEAR AI reads (PR #74 reviews): one set of bounds for the shell classifier and the credential-store check, so neither reads
// what the other gives up on. Past them, a command is not read at all, and what it does is unknown (the gate asks with a person and refuses with nobody).

/** How many levels deep the classifier reads a command inside another (a wrapper, a script, a substitution, an inline shell). One bound for every path. */
export const MAX_NESTING = 4;
/** A command longer than this is not read at all: its effects are unknown. Reading is linear but not free, and the extension host waits for it. */
export const MAX_COMMAND_LENGTH = 100_000;
/**
 * A command line (or a script it runs) with more words than this is not read: a word can be resolved as a path, so the cost grows with the words (about
 * a third of a second at the cap). Well above ordinary work: a 1,500-line here-document, whose text the lexer reads as words, is about 6,000.
 */
export const MAX_COMMAND_WORDS = 10_000;
