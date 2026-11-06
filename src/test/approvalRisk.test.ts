// The risk a card explains, and what "always allow" remembers (owner, 2026-11-05 for 0.4.17): "explain what the safety issue is ... and allow the
// user to expand and see the command or code ... The allow for this run or always allow doesn't seem to have any effect, so the project never learns."
//
// Two rules are pinned here. The sentence a card shows is a plain headline for the kind of risk, then the rule's own words, and the whole reason
// goes in the expander so nothing is lost. The entry "always allow" saves names the exact command up to its first option, so the same command is
// never asked twice and a different one still is.
import assert from 'node:assert/strict';
import test from 'node:test';
import { RISK_HEADLINE, RISK_KINDS, exactRuleFor, riskKindOf, riskSentence } from '../domain/approvalRisk';


test('each kind of risk has a plain headline, in whole words a person needs no developer knowledge for', () => {
  // The same rule the Team Mode wording scan applies (owner, 2026-11-02): no git or developer words, and no em or en dash. Main has no shared
  // scanner for it (that helper arrived with Team Mode), so the words are listed here where they are used.
  const DEVELOPER_WORDS = /\b(?:branch|commit|push|pull|remote|repository|repo|merge|rebase|worktree|clone|glob)\b/i;
  for (const kind of RISK_KINDS) {
    const headline = RISK_HEADLINE[kind];
    assert.ok(headline.length > 10, `${kind}: a whole sentence`);
    assert.equal(/[\u2013\u2014]/.test(headline), false, `${kind}: no em or en dash`);
    assert.equal(DEVELOPER_WORDS.test(headline), false, `${kind}: plain words (${headline})`);
  }
});

test('the kind is read from the rule\'s own words, and a kind the caller knows wins', () => {
  assert.equal(riskKindOf('it reads /etc/hosts, outside the workspace'), 'outside-workspace');
  assert.equal(riskKindOf('cd /etc leaves the workspace'), 'outside-workspace');
  assert.equal(riskKindOf('it names .env, which may hold credentials or knowledge-base keys'), 'credentials');
  assert.equal(riskKindOf('Safety model: installs a package from the network.'), 'installs');
  assert.equal(riskKindOf('this command can send data off this machine'), 'leaves-machine');
  assert.equal(riskKindOf('it can destroy work that cannot be recovered'), 'destructive');
  // Nothing recognisable: the honest answer is "not sure", which is what the safety model's own refusals mean.
  assert.equal(riskKindOf('Safety model: not sure.'), 'unsure');
  assert.equal(riskKindOf(undefined), 'unsure');
  // The caller's knowledge wins: the loop knows a command it holds for its own reason.
  assert.equal(riskKindOf('it names .env', 'destructive'), 'destructive');
});

test('a card shows a headline and a short detail, and a long reason is cut for the card only', () => {
  const short = riskSentence('it reads /etc/hosts, outside the workspace');
  assert.deepEqual(short, { kind: 'outside-workspace', headline: RISK_HEADLINE['outside-workspace'], detail: 'it reads /etc/hosts, outside the workspace' });
  const long = riskSentence(`it reads ${'x'.repeat(400)} outside the workspace`);
  assert.equal(long.kind, 'outside-workspace');
  assert.ok(long.detail.length <= 200, `the card detail is short (${long.detail.length})`);
  assert.ok(long.detail.endsWith('\u2026'), 'and says it was cut');
  // Whitespace is flattened, so a multi-line reason reads as one sentence on the card.
  assert.equal(riskSentence('one\ntwo   three').detail, 'one two three');
});

test('always allow saves the exact command up to its first option, so the same command is learnt and a different one still asks', () => {
  assert.equal(exactRuleFor('git status'), 'git status');
  assert.equal(exactRuleFor('git status --short'), 'git status', 'an option does not make a new rule');
  assert.equal(exactRuleFor('  git   status   '), 'git status', 'spacing is not part of it');
  assert.equal(exactRuleFor('npm test'), 'npm test');
  assert.notEqual(exactRuleFor('npm test'), exactRuleFor('npm run build'), 'two scripts are two rules');
  assert.equal(exactRuleFor('curl https://example.test/a'), 'curl https://example.test/a');
  assert.equal(exactRuleFor('cd src && npm test'), 'cd src', 'chaining stops where the first command ends');
  // A command with nothing to name keeps its own words, which is still exact: it covers only itself.
  assert.equal(exactRuleFor('./scripts/run.sh --fast'), './scripts/run.sh');
  assert.equal(exactRuleFor(''), '');
});

test('an entry the matcher can never honour is never offered, so "always allow" always has an effect when it is shown', async () => {
  const { allowRuleBlocker } = await import('../agent/permissions');
  // A command with an address on it can never match an allow entry (the rules keep addresses out of entries), so the card must not offer one.
  assert.match(allowRuleBlocker('curl https://example.test/page') ?? '', /address on the command line/);
  assert.match(allowRuleBlocker('git clone git@github.test:org/repo.git') ?? '', /address on the command line/);
  assert.match(allowRuleBlocker('cd src && npm test') ?? '', /chains/);
  assert.match(allowRuleBlocker('cat /etc/hosts') ?? '', /absolute path/);
  // A plain command the entry can cover offers one.
  assert.equal(allowRuleBlocker('npm test'), undefined);
  assert.equal(allowRuleBlocker('git status --short'), undefined);
});

test('always allow keeps the command next time: the saved entry is read back and the same command no longer asks', async () => {
  // The end of the chain the owner reported broken ("always allow doesn't seem to have any effect"): the entry is saved, and the next identical
  // command must be allowed by the rules alone. This pins the rule matching, which is what makes the saved entry work.
  const { isAutoAllowed, DEFAULT_RULES } = await import('../agent/permissions');
  // An address on the command line can never be covered by an entry, which is why the card offers none for it (the test above).
  const saved = [...DEFAULT_RULES.allowCommands, exactRuleFor('curl https://example.test/page')];
  assert.equal(isAutoAllowed('curl https://example.test/page', saved), false, 'an address on the command line still asks, as the allow rules say');
  const local = [...DEFAULT_RULES.allowCommands, exactRuleFor('npm test')];
  assert.equal(isAutoAllowed('npm test', local), true, 'the saved entry covers the command it was made from');
  assert.equal(isAutoAllowed('npm run build', local), false, 'and nothing broader');
});
