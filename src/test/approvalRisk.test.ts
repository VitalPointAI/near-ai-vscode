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

test('always allow names exactly the command, options included, so an entry is never wider than what was approved', () => {
  // 0.4.17 review: options are part of the entry for every program, because dropping them made the entry wider than the command
  // (`make -j8` would have saved `make`, which covers every make invocation).
  assert.equal(exactRuleFor('git status'), 'git status');
  assert.equal(exactRuleFor('ls -la'), 'ls -la');
  assert.equal(exactRuleFor('make -j8'), 'make -j8');
  assert.equal(exactRuleFor('git reset --hard'), 'git reset --hard', 'git options change what git does');
  assert.equal(exactRuleFor('git status --short'), 'git status --short');
  assert.equal(exactRuleFor('  git   status   '), 'git status', 'spacing is not part of it');
  assert.equal(exactRuleFor('npm test'), 'npm test');
  assert.notEqual(exactRuleFor('npm test'), exactRuleFor('npm run build'), 'two scripts are two rules');
  assert.equal(exactRuleFor('npm install -g x'), 'npm install -g x', 'no word or option is ever dropped');
  assert.equal(exactRuleFor('cd src && npm test'), 'cd src', 'chaining stops where the first command ends');
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

// ---- The second way a project learns: a whole kind of risk allowed once (owner, 2026-11-05) --------------------------------------------
test('a project can allow reading outside the workspace and installing, and nothing that loses work or sends data out', async () => {
  const { RISK_SWITCH, SWITCHABLE_KINDS, riskAllowed, switchOf } = await import('../domain/riskSwitches');
  assert.deepEqual(SWITCHABLE_KINDS, ['outside-workspace', 'installs'], 'only these two have a switch');
  for (const kind of ['destructive', 'leaves-machine', 'credentials', 'unsure'] as const) {
    assert.equal(RISK_SWITCH[kind], undefined, `${kind} always asks`);
    assert.equal(switchOf(kind), undefined);
  }
  const off = { outsideWorkspace: false, installs: false };
  const on = { outsideWorkspace: true, installs: true };
  assert.equal(riskAllowed('outside-workspace', off), false);
  assert.equal(riskAllowed('outside-workspace', on), true);
  assert.equal(riskAllowed('installs', on), true);
  // A kind without a switch is never allowed, even when both switches are on.
  for (const kind of ['destructive', 'leaves-machine', 'credentials', 'unsure'] as const) assert.equal(riskAllowed(kind, on), false, kind);
  // The setting names a person can find and remove in Settings.
  assert.equal(switchOf('outside-workspace'), 'agent.autoAllowOutsideWorkspace');
  assert.equal(switchOf('installs'), 'agent.autoAllowInstalls');
});

// ---- The reviewer's findings (PR #20, 2026-11-06): each one pinned so it cannot come back --------------------------------------------------
test('an "always allow" entry is never wider than the command it was made from, and is never one the matcher refuses', async () => {
  const { narrowRuleFor } = await import('../agent/loop');
  const { isAutoAllowed, DEFAULT_RULES } = await import('../agent/permissions');
  // The blocker the review found: these used to save `git`, `npm install` and `rm`, which cover far more than what was approved.
  assert.equal(narrowRuleFor('git reset --hard', DEFAULT_RULES.allowCommands), 'git reset --hard');
  // The narrowest entry the matcher will honour: the whole command, because `npm install x` (options dropped) is refused by the matcher itself.
  assert.equal(narrowRuleFor('npm install -g x', DEFAULT_RULES.allowCommands), 'npm install -g x');
  assert.equal(narrowRuleFor('rm -rf build', DEFAULT_RULES.allowCommands), undefined, 'rm is never offered');
  assert.equal(narrowRuleFor('curl example.com', DEFAULT_RULES.allowCommands), undefined, 'a network program is never offered');
  assert.equal(narrowRuleFor('node script.js', DEFAULT_RULES.allowCommands), undefined, 'an interpreter is never offered');
  // Every offer is honoured by the matcher and covers only its own command.
  for (const command of ['git status --short', 'npm test', 'npm install lodash', 'ls -la', 'make -j8']) {
    const rule = narrowRuleFor(command, DEFAULT_RULES.allowCommands);
    assert.ok(rule, `${command} offers a rule`);
    assert.equal(isAutoAllowed(command, [rule as string]), true, `${command}: the offer is honoured`);
  }
  assert.equal(isAutoAllowed('npm install lodash', [narrowRuleFor('npm test', DEFAULT_RULES.allowCommands) as string]), false, 'one offer does not cover another command');
});

// ---- The second review (PR #20, 2026-11-06) ------------------------------------------------------------------------------------------------
test('a key file, a destructive command and anything that sends data out never offer "always allow", and a home path is never an entry', async () => {
  const { allowRuleBlocker } = await import('../agent/permissions');
  // `~` is outside the workspace, so no entry can name it (before this it was treated as an ordinary word).
  // A home path is refused as not a plain command at all, which is just as final.
  assert.match(allowRuleBlocker('cat ~/.ssh/id_rsa') ?? '', /absolute path|home folder|chains, quotes/);
  assert.match(allowRuleBlocker('cat $HOME/.env') ?? '', /chains|quotes/);
  // The blocker the review found is closed in the loop, by risk kind; the loop's own offer is tested next. Here the classification those three
  // rest on is pinned, including that the tainted data hold reads as "leaves the machine" and not as "not sure".
  const { riskKindOf } = await import('../domain/approvalRisk');
  assert.equal(riskKindOf('it names .env, which may hold credentials or knowledge-base keys'), 'credentials');
  assert.equal(riskKindOf('it can destroy work that cannot be recovered'), 'destructive');
  assert.equal(riskKindOf('this command can send data off this machine'), 'leaves-machine');
  assert.equal(riskKindOf('This run read outside content, and this command sends data with it, which that content may have asked for.'), 'leaves-machine');
});

test('the card offers no "always allow" for the three kinds of risk that always ask, and one whenever a narrow entry exists', async () => {
  const { offeredRule } = await import('../agent/loop');
  const { DEFAULT_RULES } = await import('../agent/permissions');
  // The blocker the second review found, tested at the loop's own offer rather than only in the classifier.
  for (const kind of ['credentials', 'destructive', 'leaves-machine']) {
    assert.equal(offeredRule('cat .env', kind, DEFAULT_RULES.allowCommands), undefined, kind);
    assert.equal(offeredRule('git status', kind, DEFAULT_RULES.allowCommands), undefined, `${kind} with an otherwise ordinary command`);
  }
  // Every other kind still offers the exact entry when one exists.
  assert.equal(offeredRule('git status', 'outside-workspace', DEFAULT_RULES.allowCommands), 'git status');
  assert.equal(offeredRule('npm test', 'unsure', DEFAULT_RULES.allowCommands), 'npm test');
  assert.equal(offeredRule('rm -rf build', 'unsure', DEFAULT_RULES.allowCommands), undefined, 'and nothing when no narrow entry exists');
});

test('the shipped node --version entry still works, while an entry for an interpreter itself never covers a script', async () => {
  const { isAutoAllowed, DEFAULT_RULES } = await import('../agent/permissions');
  // 0.4.17 review: the never-in-an-entry rule made the shipped default dead. A bare version question has no side effect, so it is still honoured.
  assert.equal(DEFAULT_RULES.allowCommands.includes('node --version'), true, 'the default entry is still shipped');
  assert.equal(isAutoAllowed('node --version', DEFAULT_RULES.allowCommands), true);
  assert.equal(isAutoAllowed('python3 --version', ['python3 --version']), true);
  // A script through an interpreter is still refused, which is what the rule is for.
  assert.equal(isAutoAllowed('node script.js', ['node']), false);
  assert.equal(isAutoAllowed('node --version extra', ['node --version extra']), false);
});
