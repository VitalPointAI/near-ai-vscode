// PR #74 review round 8: a command's effects are complete only when the classifier read it whole. Three times a path that stopped reading early (the
// nesting bound, a throw, an unparseable command) forgot to say so, and the floor saw "no effects" and let the command run in Full auto. The default is
// now the other way round: every `unknown(...)` result marks the command's effects unknown, and only a path that read the whole command says so, with
// `unknownRead(...)`. This file lists every one of those calls in commandSafety.ts, by a scan of its source, each with an input that reaches it, and adds
// a property test: tagged commands broken at random never come back with a complete, empty effect list. Nothing here runs a command.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { classifyCommand } from '../agent/commandSafety';
import type { CommandContext } from '../agent/commandSafety';

const GSD_ROOT = '/opt/near-ai-gsd';
const GSD_TOOLS = `${GSD_ROOT}/gsd-core/bin/gsd-tools.cjs`;
const context: CommandContext = {
  root: '/work/app', cwd: '/work/app', home: '/home/dev', trustedToolRoots: [GSD_ROOT],
  packageScriptsAt: () => ({ kind: 'found', folder: '/work/app', scripts: { test: 'echo ok', build: 'echo build' } })
};
const classify = (command: string, extra: Partial<CommandContext> = {}) => classifyCommand(command, { ...context, ...extra });

interface Site { readonly kind: 'unknown' | 'unknownRead'; readonly arg: string; readonly line: number }

/** Every `unknown(` and `unknownRead(` call in the classifier, with its first argument as written. */
function sites(): Site[] {
  const source = readFileSync(path.join(__dirname, '..', '..', 'src', 'agent', 'commandSafety.ts'), 'utf8');
  const found: Site[] = [];
  for (const match of source.matchAll(/\b(unknown|unknownRead)\(/g)) {
    const at = match.index ?? 0;
    if (source.slice(Math.max(0, at - 9), at) === 'function ' || /const (?:unknown|unknownRead) = $/.test(source.slice(Math.max(0, at - 30), at))) continue;
    let end = at + match[0].length;
    for (let depth = 1; depth > 0 && end < source.length; end += 1) {
      if (source[end] === '(') depth += 1;
      else if (source[end] === ')') depth -= 1;
    }
    found.push({ kind: match[1] as Site['kind'], arg: source.slice(at + match[0].length, end - 1).replace(/\s+/g, ' ').trim(), line: source.slice(0, at).split('\n').length });
  }
  return found;
}

/**
 * An input that reaches each call, by the call's kind and its argument as written. `reason` is matched against the classification's reason, so the input
 * is known to reach that very call. Calls that read the command whole must come back with complete effects (`tags`, none when absent); the others with
 * unknown effects.
 */
const REACH: Readonly<Record<string, { readonly input: string; readonly reason: RegExp; readonly tags?: unknown[]; readonly extra?: Partial<CommandContext> }>> = {
  // Read whole: the classifier interpreted every word, and only cannot judge the command.
  "unknownRead:'git archive writes to its output stream'": { input: 'git archive HEAD', reason: /writes to its output stream/ },
  "unknownRead:`git bundle ${rest[0]?.text ?? ''} reads a bundle`.trim()": { input: 'git bundle verify repo.bundle', reason: /git bundle verify reads a bundle/ },
  'unknownRead:`${label} names ${value}, which is outside the workspace`': { input: 'cat /srv/data.txt', reason: /cat names \/srv\/data\.txt, which is outside the workspace/ },
  "unknownRead:'gsd-tools --config-dir works on another configuration folder'": { input: `${GSD_TOOLS} state --config-dir x`, reason: /--config-dir works on another configuration folder/ },
  'unknownRead:`gsd-tools --${option[1]} points outside the workspace`': { input: `${GSD_TOOLS} state --cwd /srv`, reason: /gsd-tools --cwd points outside the workspace/ },
  'unknownRead:`${label} can reach the network or folders outside the workspace`': { input: `${GSD_TOOLS} websearch x`, reason: /gsd-tools websearch can reach the network/ },
  "unknownRead:'git reset moves the branch or unstages changes'": { input: 'git reset HEAD~1', reason: /git reset moves the branch/ },
  "unknownRead:'git clean --dry-run'": { input: 'git clean -n', reason: /git clean --dry-run/ },
  "unknownRead:'git checkout may overwrite uncommitted changes'": { input: 'git checkout main', reason: /git checkout may overwrite/ },
  "unknownRead:'git switch changes the checked-out branch'": { input: 'git switch -q main', reason: /git switch changes the checked-out branch/ },
  'unknownRead:`${label} from a URL or path instead of a named remote`': { input: 'git fetch https://example.test/repo.git', reason: /git fetch from a URL or path/ },
  'unknownRead:`${label} with options that can rewrite or remove local work`': { input: 'git pull --rebase', reason: /git pull with options that can rewrite/ },
  'unknownRead:`git rebase ${words[0]} finishes, leaves or edits a rebase already under way`': { input: 'git rebase --continue', reason: /git rebase --continue finishes, leaves or edits a rebase/ },
  'unknownRead:`${label} tidies the repository and keeps recent unreachable commits`': { input: 'git gc --auto', reason: /git gc tidies the repository/ },
  "unknownRead:'git merge with a strategy option'": { input: 'git merge -s ours main', reason: /git merge with a strategy option/ },
  "unknownRead:'git merge'": { input: 'git merge --squash', reason: /^git merge with a strategy option$|^git merge$/ },
  "unknownRead:'git branch with arguments'": { input: 'git branch feature', reason: /git branch with arguments/ },
  "unknownRead:'git tag creates a tag'": { input: 'git tag v1.0.0', reason: /git tag creates a tag/ },
  "unknownRead:'git stash changes the working tree'": { input: 'git stash branch new', reason: /git stash changes the working tree/ },
  "unknownRead:network ?? 'git remote'": { input: 'git remote get-url origin', reason: /^git remote$/ },
  // Gate follow-up: git's network plumbing, lfs, submodule and credential commands.
  'unknownRead:`${shown} ${action.text}`': { input: 'git credential-cache exit', reason: /^git credential-cache exit$/ },
  'unknownRead:`${label} downloads from another repository`': { input: 'git fetch-pack https://example.test/repo.git', reason: /git fetch-pack downloads from another repository/ },
  "unknownRead:network ?? `git lfs ${action ?? ''}`.trim()": { input: 'git lfs ls-files', reason: /^git lfs ls-files$/ },
  "unknown:'git submodule foreach runs a command the rules do not read'": { input: 'git submodule foreach ls', reason: /git submodule foreach runs a command/ },
  "unknownRead:network ?? 'git submodule is not one the rules know'": { input: 'git submodule status', reason: /git submodule is not one the rules know/ },
  "unknownRead:'git credential capability lists what git credential supports'": { input: 'git credential capability', reason: /git credential capability lists/ },
  "unknownRead:'git commit --amend rewrites the last commit', DESTROY_ALL": { input: 'git commit --amend', reason: /git commit --amend rewrites the last commit/, tags: [{ verb: 'destroy', paths: ['**'] }] },
  "unknownRead:'git commit --no-verify skips the repository\\'s hooks'": { input: 'git commit --no-verify -m x', reason: /--no-verify skips/ },
  'unknownRead:`git ${sub} is not one the rules know`': { input: 'git init', reason: /git init is not one the rules know/ },
  'unknownRead:`${manager} with a folder option runs in another folder`': { input: 'npm --prefix sub run build', reason: /npm with a folder option runs in another folder/, extra: { packageScriptsAt: (folder: string) => ({ kind: 'found', folder, scripts: { build: 'echo build' } }) } },
  'unknownRead:`${manager} ${sub} can install or run code the rules cannot check`': { input: 'npm start', reason: /npm start can install or run code/, extra: { packageScriptsAt: () => ({ kind: 'found', folder: '/work/app', scripts: { start: 'echo hi' } }) } },
  'unknownRead:`${manager} with --prefix, --global, or a registry option acts outside the workspace`': { input: 'npm -g install left-pad', reason: /--global, or a registry option/ },
  'unknownRead:`${manager} ${sub} may contact the registry`': { input: 'npm outdated', reason: /npm outdated may contact the registry/ },
  "unknownRead:`${manager} ${sub || ''} can install or run code the rules cannot check`.replace(/\\s+/g, ' ')": { input: 'npm install left-pad', reason: /npm install can install or run code/ },
  "unknownRead:'npx without a tool'": { input: 'npx', reason: /npx without a tool/ },
  "unknownRead:'npx options can install packages'": { input: 'npx -y create-thing', reason: /npx options can install packages/ },
  'unknownRead:`npx ${tool}`': { input: 'npx vsce package', reason: /^npx vsce$/ },
  "unknownRead:'sed -i without a file'": { input: "sed -i 's/a/b/'", reason: /sed -i without a file/ },
  "unknownRead:'it sets shell variables for the rest of the session'": { input: 'FOO=bar', reason: /sets shell variables/ },
  'unknownRead:`${program} runs a command decided at run time`': { input: 'flock /tmp/app.lock -c "$CMD"', reason: /flock runs a command decided at run time|decides at run time/ },
  'unknownRead:prefixReason': { input: 'nice ls', reason: /nice changes how the command runs/ },
  "unknownRead:'flock without a command'": { input: 'flock /tmp/app.lock', reason: /flock without a command/ },
  "unknownRead:'env prints environment variables, which may include secrets'": { input: 'env', reason: /env prints environment variables/ },
  'unknownRead:`${program} alone`': { input: 'nohup', reason: /nohup alone/ },
  "unknownRead:`${name} ${found.skipped.join(' ')}`.trim()": { input: 'docker --debug', reason: /^docker --debug$/ },
  'unknownRead:`${name} with options before its subcommand acts on something they name`': { input: 'git -C sub status', reason: /git with options before its subcommand/ },
  "unknownRead:'rm -r of a temporary path'": { input: 'rm -r /tmp/build-1', reason: /rm -r of a temporary path/, extra: { temporaryRoots: ['/tmp'] } },
  "unknownRead:'rm -r deletes folders inside the workspace'": { input: 'rm -r src', reason: /rm -r deletes folders inside the workspace/, tags: [{ verb: 'destroy', paths: ['src'] }] },
  'unknownRead:`${name} without a file`': { input: 'rm -f', reason: /rm without a file/ },
  'unknownRead:`${name} deletes files matched at run time`': { input: 'rm src/*.log', reason: /rm deletes files matched at run time/ },
  "unknownRead:'find -exec runs a command for every match'": { input: 'find . -exec wc -l \\;', reason: /find -exec runs a command for every match/ },
  "unknownRead:'kill stops a process'": { input: 'kill 1234', reason: /kill stops a process/ },
  "unknownRead:'crontab -l'": { input: 'crontab -l', reason: /^crontab -l$/ },
  'unknownRead:`${name}`': { input: 'systemctl status app', reason: /^systemctl$/ },
  "unknownRead:`${name} ${words[0] ?? ''}`.trim()": { input: 'docker ps', reason: /^docker ps$/ },
  'unknownRead:name': { input: 'kubectl get pods', reason: /^kubectl$/ },
  'unknownRead:`${name} api`': { input: 'gh api repos/acme/app', reason: /^gh api$/ },
  "unknownRead:`${name} ${group ?? ''} contacts GitHub`.trim()": { input: 'gh auth status', reason: /gh auth contacts GitHub/ },
  'unknownRead:`${name} ${sub}`.trim()': { input: 'vsce package', reason: /^vsce package$/ },
  'unknownRead:`gem ${sub}`.trim()': { input: 'gem list', reason: /^gem list$/ },
  'unknownRead:`cargo ${sub}`.trim()': { input: 'cargo run', reason: /^cargo run$/ },
  'unknownRead:`go ${sub}`.trim()': { input: 'go run .', reason: /^go run$/ },
  "unknownRead:'make with -C or -f runs another makefile'": { input: 'make -C sub build', reason: /make with -C or -f/ },
  'unknownRead:`make ${target} may change files outside the workspace`': { input: 'make install', reason: /make install may change files/ },
  "unknownRead:'make with variable overrides'": { input: 'make CC=clang', reason: /make with variable overrides/ },
  "unknownRead:'near contacts the NEAR network'": { input: 'near view-account x.near', reason: /near contacts the NEAR network/ },
  "unknownRead:'xargs runs a command for every input line'": { input: 'xargs cat', reason: /xargs runs a command for every input line/ },
  'unknownRead:`${name} changes the shell session for later commands`': { input: 'export FOO=bar', reason: /export changes the shell session/ },
  'unknownRead:`${name} runs code the rules cannot check`': { input: 'python3 scripts/report.py', reason: /python3 runs code the rules cannot check/ },
  "unknownRead:'tsx runs a script'": { input: 'tsx scripts/a.ts', reason: /tsx runs a script/ },
  "unknownRead:'tail -f does not finish'": { input: 'tail -f app.log', reason: /tail -f does not finish/ },
  'unknownRead:`${name} without a destination`': { input: 'cp a.txt', reason: /cp without a destination/ },
  "unknownRead:'cd'": { input: 'cd', reason: /cd with no directory/ },
  'unknownRead:`${name} is not a command the rules know`': { input: 'then echo x', reason: /^then is not a command the rules know$|echo/ },
  'unknownRead:reason': { input: 'nmap -sV scanme.example', reason: /nmap is not a command the rules know/ },
  "unknownRead:'the command is empty'": { input: '   ', reason: /the command is empty/ },
  "unknownRead:`it starts with the Open-GSD preamble, but ${context.gsdRun?.reason ?? 'the shell it would run in was not checked'}`": { input: 'PREAMBLE\nls', reason: /it starts with the Open-GSD preamble/, extra: { gsdPreambles: ['PREAMBLE'] } },
  "unknownRead:'the shell\\'s working directory is outside the workspace'": { input: 'ls', reason: /the shell's working directory is outside the workspace/, extra: { cwd: '/srv' } },
  'unknownRead:`it reads ${target.text}, outside the workspace`': { input: 'wc -l < /srv/data.txt', reason: /it reads \/srv\/data\.txt, outside the workspace/ },
  "unknownRead:'it names another user\\'s home directory'": { input: 'ls ~root', reason: /another user's home directory/ },
  "unknownRead:'cd with no directory goes to the home directory, outside the workspace'": { input: 'cd && ls', reason: /cd with no directory/ },
  'unknownRead:`cd ${target.text} leaves the workspace`': { input: 'cd /srv && ls', reason: /cd \/srv leaves the workspace/ },
  'unknownRead:`it uses a wildcard (${wild.text}) that may match files outside the workspace`': { input: 'ls /srv/*', reason: /may match files outside the workspace|outside the workspace/ },
  'unknownRead:lexed.opaque': { input: 'echo $HOME', reason: /variable|run time/ },
  "unknownRead:'it runs nothing the rules recognise'": { input: '> out.txt', reason: /it runs nothing the rules recognise/ },
  // A write the text names (PR #74 review round 8, refinement): read whole, tagged as a write to that place.
  'unknownRead:reason, effects': { input: 'chmod +x scripts/run.sh', reason: /chmod changes file permissions/, tags: [{ verb: 'workspaceWrite', paths: ['scripts/run.sh'] }] },
  "unknownRead:'git config prints repository settings'": { input: 'git config --get core.pager', reason: /git config prints repository settings/ },
  "unknownRead:'env -S runs a command line'": { input: 'env -S "ls src"', reason: /env -S runs a command line/ },
  "unknownRead:'rsync without a destination'": { input: 'rsync -a src/', reason: /rsync without a destination/ },
  "unknownRead:'rsync copies files and deletes others', written.length > 0 ? destroyPaths(written) : undefined": { input: 'rsync -a --delete src/ backup', reason: /rsync copies files and deletes others/, tags: [{ verb: 'destroy', paths: ['backup'] }] },
  "unknownRead:'rsync copies files', effects": { input: 'rsync -a src/ backup', reason: /^rsync copies files$/, tags: [{ verb: 'workspaceWrite', paths: ['backup'] }] },
  "unknownRead:'ln without a target'": { input: 'ln -s', reason: /ln without a target/ },
  "unknownRead:'printf -v sets a shell variable'": { input: 'printf -v x %s y', reason: /printf -v sets a shell variable/ },
  // Not read whole: the effects are unknown.
  'unknown:`${label} with an option that runs programs or reaches outside the repository`': { input: 'git archive --remote=origin -o x.tar HEAD', reason: /git archive with an option that runs programs/ },
  'unknown:`${label} without its output`': { input: 'git archive -o', reason: /git archive without its output/ },
  'unknown:`${name} ${found.unknown}`': { input: 'gh pr --weird merge 12', reason: /gh with --weird before its action/ },
  'unknown:`${name} api ${api.unknown}`': { input: 'gh api --brand-new repos/acme/app', reason: /gh api with --brand-new, an option the rules do not know/ },
  'unknown:`${name} ${read.unknown}`': { input: 'aws sts --brand-new get-caller-identity', reason: /aws with --brand-new before what it does/ },
  "unknown:'git bundle create without a file'": { input: 'git bundle create', reason: /git bundle create without a file/ },
  'unknown:`${name} downloads a file to ${download.output}, which is outside the project`': { input: 'curl -sS -o /srv/x.tgz https://example.test/x.tgz', reason: /downloads a file to \/srv\/x\.tgz, which is outside the project/ },
  'unknown:`${reason}, to a place decided at run time or outside the project`': { input: 'ln -s a /srv/link', reason: /to a place decided at run time or outside the project/ },
  "unknown:'git config with an option the rules do not check'": { input: 'git config --frob a b', reason: /git config with an option the rules do not check/ },
  "unknown:'awk without a program'": { input: 'awk', reason: /awk without a program/ },
  "unknown:'env -C moves to a folder decided at run time'": { input: 'env -C "$D" git push', reason: /env -C moves to a folder decided at run time|decides at run time/ },
  "unknown:'env -S runs a command decided at run time'": { input: 'env -S "$CMD"', reason: /env -S runs a command decided at run time|decides at run time/ },
  'unknown:`${name} with an option the rules do not check`': { input: 'chmod --reference=a.txt b.txt', reason: /chmod with an option the rules do not check/ },
  'unknown:`${name} with a part the shell decides at run time`': { input: 'curl -sS -o $O https://example.test/', reason: /curl with a part the shell decides at run time|decides at run time/ },
  "unknown:'rsync runs a remote shell the rules do not check'": { input: 'rsync -e ssh a/ b', reason: /rsync runs a remote shell/ },
  "unknown:'rsync copies files, to a place decided at run time or outside the project'": { input: 'rsync -a src/ /srv/backup', reason: /rsync copies files, to a place decided at run time/ },
  "unknown:'ln with an option the rules do not check'": { input: 'ln -t dir a', reason: /ln with an option the rules do not check/ },
  'unknown:`${name} with a config or plugin option`': { input: 'tsc --plugin x', reason: /tsc with a config or plugin option/ },
  'unknown:`${reason}, with options read from elsewhere`': { input: 'curl -K cfg https://example.test/', reason: /with options read from elsewhere/ },
  'unknown:`${reason}, to a folder decided at run time`': { input: 'wget -P "$D" https://example.test/a.zip', reason: /to a folder decided at run time|decides at run time/ },
  "unknown:'sort -o without a file'": { input: 'sort -o', reason: /sort -o without a file/ },
  "unknown:'env with options'": { input: 'env --frob git push', reason: /env with options/ },
  "unknown:'timeout with options'": { input: 'timeout --frob 5 git push', reason: /timeout with options/ },
  "unknown:'git options before the subcommand (-C, -c, --git-dir) change what it acts on'": { input: '', reason: /./ },
  'unknown:`${label} ${writesOrEscapes}`': { input: 'git add --exec=x .', reason: /git add --exec/ },
  'unknown:`${label} ${writesOrEscapes} can write files or read outside the repository`': { input: 'git diff --ext-diff', reason: /git diff --ext-diff can write files/ },
  "unknown:`git ${sub || '(no subcommand)'} is not one the rules know`": { input: 'git lg', reason: /git lg is not one the rules know/ },
  'unknown:`${manager} version changes the version and may tag a release`': { input: 'npm version patch', reason: /npm version changes the version/ },
  'unknown:`sed ${text} is an option the rules do not check`': { input: "sed --frob 's/a/b/' x", reason: /sed --frob is an option/ },
  "unknown:'sed with a script that may run commands or write other files'": { input: "sed 'w .git/config' x", reason: /sed with a script that may run commands/ },
  "unknown:'awk -v without an assignment'": { input: "awk -v x '{print}' f", reason: /awk -v without an assignment/ },
  'unknown:`awk ${text} is an option the rules do not check`': { input: "awk --frob '{print}' f", reason: /awk --frob is an option/ },
  "unknown:'awk with a program that may run commands or write files'": { input: 'awk \'{system("git push")}\' f', reason: /awk with a program that may run commands/ },
  'unknown:`${program} is not the usual ${name}`': { input: '/opt/x/npm publish', reason: /\/opt\/x\/npm is not the usual npm/ },
  'unknown:`${program} is not the usual git`': { input: '/opt/x/git push', reason: /\/opt\/x\/git is not the usual git/ },
  "unknown:'alias makes a later word run another command'": { input: "alias x='git push'; x", reason: /alias makes a later word/ },
  'unknown:`${name} with an option that writes or runs programs`': { input: 'rg --pre ./x pattern', reason: /rg with an option that writes or runs programs/ },
  'unknown:`it has ${lexed.broken}`': { input: 'git push origin main; echo "', reason: /unterminated double quote/ },
  "unknown:'a redirect has no target'": { input: 'echo x >', reason: /a redirect has no target|the command ends/ },
  "unknown:'a redirect target is decided at run time'": { input: 'echo x > "$OUT"', reason: /a redirect target is decided at run time|decides at run time/ },
  "unknown:'cd to a directory decided at run time'": { input: 'cd "$D" && echo x > config', reason: /cd to a directory decided at run time|decides at run time/ }
};

/** Calls no single command reaches as written, with why (each is covered elsewhere). */
const UNREACHED: Readonly<Record<string, string>> = {
  'unknown:reason': 'beyondReach: the nesting bound and the length caps, covered by commandBounds.test.ts',
  "unknown:'git options before the subcommand (-C, -c, --git-dir) change what it acts on'": 'kept as a backstop: git\'s global options are now skipped by classifyAfterGlobals (commandGlobalOptions.test.ts)'
};

test('every unknown( and unknownRead( call in the classifier has an input that reaches it, or is listed with why it is not reached', () => {
  const missing = sites().map((site) => `${site.kind}:${site.arg}`).filter((key) => REACH[key] === undefined && UNREACHED[key] === undefined);
  assert.deepEqual([...new Set(missing)], [], 'a new call needs an input here (and a decision: unknown, or unknownRead because it read the whole command)');
  assert.ok(sites().length > 90, `${sites().length} calls scanned`);
});

test('each input reaches its call: a call that read the whole command gives complete effects, any other gives unknown effects', () => {
  const wrong: string[] = [];
  for (const [key, { input, reason, tags, extra }] of Object.entries(REACH)) {
    if (UNREACHED[key] !== undefined) continue;
    const result = classify(input, extra ?? {});
    const readWhole = key.startsWith('unknownRead:');
    if (!reason.test(result.reason)) { wrong.push(`${key}: "${input}" gave "${result.reason}"`); continue; }
    if (readWhole && result.effectsUnknown !== undefined) wrong.push(`${key}: "${input}" was read whole, but its effects are unknown (${result.effectsUnknown})`);
    if (readWhole && JSON.stringify(result.effects ?? []) !== JSON.stringify(tags ?? [])) wrong.push(`${key}: "${input}" effects ${JSON.stringify(result.effects)}`);
    if (!readWhole && result.effectsUnknown === undefined) wrong.push(`${key}: "${input}" stopped early, but its effects are complete (${JSON.stringify(result.effects)})`);
  }
  assert.deepEqual(wrong, []);
});

// The property: a tagged command broken any way (cut short, a quote left open, an unclosed substitution, a dangling operator) never comes back with a
// complete, empty effect list. It is tagged, or its effects are unknown.
const TAGGED = ['git push origin main', 'rm -rf src', 'npm publish', 'docker push app:1', 'git reset --hard', 'kubectl apply -f k8s.yaml', 'echo x > .git/config'];
const BREAKS = ['; echo "', " '", ' $(', ' `', ' && (', ' |', ' &&', ' \\', ' "unterminated', ' <<', ' >'];

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
}

test('property: a tagged command followed by any breakage keeps its tag or has unknown effects, never complete and empty', () => {
  const wrong: string[] = [];
  for (const command of TAGGED) {
    for (const breakage of BREAKS) {
      const result = classify(`${command}${breakage}`);
      if (result.effectsUnknown === undefined && (result.effects ?? []).length === 0) wrong.push(`${command}${breakage} → ${JSON.stringify(result)}`);
    }
  }
  assert.deepEqual(wrong, []);
});

test('property: a quote or bracket dropped at a random place in a tagged line keeps the tag or has unknown effects', () => {
  const next = random(74_8);
  const wrong: string[] = [];
  let tried = 0;
  for (const command of TAGGED) {
    const line = `${command} && echo done`;
    for (let round = 0; round < 60; round += 1) {
      const at = Math.floor(next() * (line.length + 1));
      const mark = ['"', "'", '`', '$(', '(', '\\'][Math.floor(next() * 6)]!;
      const broken = `${line.slice(0, at)}${mark}${line.slice(at)}`;
      const result = classify(broken);
      tried += 1;
      // A break inserted after the tagged command's own words leaves them intact: that line must keep the tag or have unknown effects. A break inside
      // them can make another, harmless command, which may honestly have no tag.
      const intact = at >= command.length;
      if (result.effectsUnknown === undefined && (result.effects ?? []).length === 0 && intact) wrong.push(`${broken} → ${JSON.stringify(result)}`);
    }
  }
  assert.deepEqual(wrong, []);
  assert.ok(tried >= 400);
});

test('the review\'s example: an unparseable command after a push is not read as having no effects', () => {
  const result = classify('git push origin main; echo "');
  assert.equal(typeof result.effectsUnknown, 'string');
  // The sensitive-text answer stays where it is, risky, and its effects are unknown too.
  const sensitive = classify('cat ~/.ssh/id_rsa; echo "');
  assert.equal(sensitive.verdict, 'risky');
  assert.equal(typeof sensitive.effectsUnknown, 'string');
});
