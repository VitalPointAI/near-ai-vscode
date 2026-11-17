# 70-17a: PR #70 review carry-overs, fixed on the PR 3 branch

Branch `feat/gate-floor`, on top of plan 17 (`96cb9b3`). One commit per item. Each fix replaces a heuristic with an invariant and a test that would
catch the next case of the same class. Every new test was seen failing first (the implementation set aside with a tagged stash, then applied back by SHA).

## Results

- Lint (`tsc --noEmit`): clean.
- Full `npm test` (once, at the end, under the memory cap): 3289 tests, 3280 passed, 0 failed, 9 skipped (the skips are existing ones; none is new).
- `package.json` and `package-lock.json`: unchanged. No new packages.

## Per item

### 1. Policy event ids were not on any known list

- Commit `78b2d9e`.
- `POLICY_EVENT_IDS` (`policy.created`, `policy.renewed`, `policy.reset`, `policy.load`) is a named list in `src/domain/gate/bundle.ts`, kept apart
  from `GATE_RULE_IDS` (events, not rules). `BundleEvent` is derived from it. `RECORD_RULE_IDS` in `decide.ts` joins both.
- Invariant: `validateDecisionRecord` refuses a record whose rule (`authorizations[].policy.name`) is not in `RECORD_RULE_IDS`, or whose
  `api.operation` is neither a capability verb nor a policy event. The decision log runs that check before every write, so a writer that invents an id is
  caught at its first record (reported once through `onProblem`, never failing a decision).
- Tests (`src/test/gateRecordIds.test.ts`): every known id validates and an invented one is refused and not written; the host's real created, load and
  reset events land on disk with known ids; a scan of all of `src` finds every rule-shaped string literal and fails on one that is neither a known id nor
  named, with its reason, as something else (a Team Mode event, a file name, a field path).

### 2. SECURITY.md overclaimed what is removed from decision records

- Commit `e3cabf1`.
- `redactCredentialArguments` in `src/domain/redaction.ts` removes credentials by where they sit: the user part of a URL; the value of `-u`, `--user`,
  `--proxy-user`, `-U` when it holds a colon; the value of an option named for a password, passphrase, token, secret, API key or credential (not the
  `-file`/`-stdin`/`-path` forms); credential headers (`Authorization` of any scheme, `Proxy-Authorization`, `Cookie`, `Private-Token`,
  `X-...-Token`/`-Key`/`-Auth`/`-Secret`); an environment assignment or URL query parameter named for one (a `$VAR` reference is kept). It is idempotent.
- Invariant: `redactRecord` runs it over every string of a record before the token shapes, and `validateDecisionRecord` refuses a record in which any
  string still carries a credential argument, so no writer can skip it.
- SECURITY.md now lists exactly what is removed and what is not (a plain positional password such as `sshpass -p`, `mysql -p...`, `htpasswd -b`; one a
  script reads; one built by command substitution; names not listed).
- Tests (`src/test/gateRecordRedaction.test.ts`): one per class with near misses that must survive, the documented gaps asserted as gaps, a record built
  end to end, a refused unredacted record, and a Bash call through `gateToolCall`. `gateDocs.test.ts` checks the new wording and runs each documented
  example against the code; its older phrase check (`secrets are removed`, the overclaim itself) now checks the new sentence.
- Not changed: `redactSecrets` (the activity feed and other surfaces) does not use the new classes; only decision records do. Widening the shared
  function is a separate change with its own surfaces to check.

### 3. The host kept a decision log per project root forever

- Commit `ca803b6`.
- `GateHost.retainProjectLogs(openRoots)` lets go of every project log whose folder is not open (never the install log or the open project's). Activation
  calls it on each `onDidChangeWorkspaceFolders`. Independently of folder events, the host holds at most `MAX_PROJECT_LOGS` (8) project logs and lets go
  of the least recently used one.
- A runtime now looks its log up at each record instead of holding it, so a run still going in a closed folder reopens the log and `flush()` always
  waits for it; a log let go with records queued is still awaited by `flush()`. No record is lost.
- Tests (`src/test/gateHostLogs.test.ts`): the cap and LRU order with every record on disk, retention with a running run, the open project kept, and
  activation through the stubbed editor (the shared vscode stub now fires `onDidChangeWorkspaceFolders` from `setWorkspaceFolders`).
- Known cost: a log reopened after being let go reports a persistent write failure again (once per reopen, not once per session).

### 4. A placeholder web search provider reached the catalog's manifests

- Commit `659343e`.
- `builtInTools()` has no stand-in provider: absent or `null` means none is set up, and WebSearch is built with no provider, so its manifest declares no
  host. `webSearchTool(undefined)` now has the shorthand `plan`, as its manifest already said: the Pitfall 10 agreement test had passed only because of
  the stand-in, and in a real install with no search set up the shorthand and manifest disagreed.
- Behaviour change to note: with no search provider, a WebSearch call (which only returns "web search is not set up") no longer asks in approve-risky.
- Tests (`src/test/gateManifests.test.ts`): no default-built tool names an RFC 2606 or RFC 6761 placeholder host; the catalog and Tools page sources
  name none; the page with search off or with no host lists none; a no-provider call is recorded as a plan naming no host. The page comparisons build the
  catalog with the same configured provider as the page.

### 5. Team Studio captured its folder when the panel opened

- Commit `23c0ed5`.
- `TeamStudioDeps.root` is a function asked at each use (listing, `hasProject`, display paths, project save and its project type, role tests, share
  default). `onDidChangeFolder` refreshes the page. The panel's project team watcher moves to the new folder's team file and the old watcher is disposed.
  A project save reads the folder once, so the team file and the project type land in the same folder. A role test run keeps the folder it started in.
- Tests (`src/test/teamStudioPage.test.ts`): a folder change with and without notifying the studio (listing, no-folder error, save goes to the folder
  open now, old folder untouched); the real panel with a stubbed editor follows a folder change and moves its watcher.

### 6. Calls rejected before the gate wrote no record

- Commit `62c70ea`.
- `PRE_GATE_RULES` (`call.unknown-tool`, `call.check-failed`) are part of `GATE_RULE_IDS`. `recordRefusedBeforeGate` in `gateAdapter.ts` writes a
  `denied` record naming the tool (never its arguments), with the tool's own shorthand when it exists and fixed words, never the error text.
- The loop records an unknown tool name, and a `forbidden`, `sensitive`, `risky` or `preview` hook that throws. The preview runs after the gate asked, so
  its record closes that ask.
- Tests (`src/test/gateEnumeration.test.ts`): both cases through a scripted run, each hook, nothing ran, no argument or error text recorded.
- Deferred: a call whose arguments do not parse still writes no record. An existing plan 13 test states that on purpose ("reaches no decision and no
  execution ... writes no tool decision record"), so changing it needs an owner decision. If wanted, it is one more `recordRefusedBeforeGate` call with a
  third rule id.

### 7. The tool-run scan missed reflection

- Commit `2846b89`.
- The type-checked scan (`src/test/helpers/toolRunScan.ts`) has two new kinds, both failing the production check: `reflect` (a `Reflect.*` call given a
  tool, a table of tools or an untyped value; `Object.values`, `entries`, `getOwnPropertyDescriptor(s)`, `assign`, `fromEntries` given a tool or a table
  of tools) and `cast` (a tool or a tool table cast to a type that holds no tool: the other way the type, and so the scan, is lost).
- Planted sources prove each is found (`Reflect.get`, `Reflect.apply`, Reflect over a table and over `unknown`, `Object.values`/`entries` over a tool and a
  table, a computed key on a table, dropping casts), and that harmless reflection is not.
- The one production site it found: `extractFinding` in `src/services/cyberRun.ts` cast a tool to a narrower type to read `findingFrom`; it now widens the
  tool's type instead, with the same behaviour.
- Still not seen (stated in the scan's header): a value built from strings at run time, or a structural type with no `run` reached without a cast or an
  `any`. Neither can be written without one of the reported kinds.

## Review round 1 (PR #74)

Four commits on `feat/gate-floor`, one per finding (findings 1 and 2 share one, as both change `floorFactsFor`). Every new test was seen failing against
the unchanged source first (the tests compiled and ran before the implementation existed). Each fix closes the class the review named, not the instance.

### Results

- Lint (`tsc --noEmit`): clean.
- Full `npm test` (once, at the end, 6G cap): 3330 tests, 3321 passed, 0 failed, 0 cancelled, 9 skipped (the same 9 as before). After the follow-up
  below, again: 3338 tests, 3329 passed, 0 failed, 0 cancelled, 9 skipped.
- `node scripts/secret-scan.mjs --range origin/main..HEAD`: clean.
- `package.json` and `package-lock.json`: unchanged by this round. No activation or webview code changed, so the e2e suite was not run.

### 1. [BLOCKER] The classifier's recursion had no bound on some paths, and its stack overflow failed open

- Commit `1b2f27b`.
- Reproduced first: `if ` x5000 + `git push`, and the same with `sudo`, `exec`, `{`, `then`, threw `RangeError` in the classifier; `floorFactsFor`
  returned `{ effects: [] }`, so the push ran unasked in fully-autonomous.
- One bound, `MAX_NESTING` (4), checked first by `tooDeep()` in both entry points every recursive path goes through, `classifyText` and
  `classifyWords`. Every recursion site was found: `RUNS_WHAT_FOLLOWS` words, `noteRunsAs` (sudo, doas, pkexec, su -c), `noteInlineScript` (eval,
  `sh -c` and the other shells), `checkScript` (npm scripts), `classifyNpx`, `xargs` (piped and plain), `find -exec`, `$(...)`, `NAME=$(...)` and the
  Open-GSD preamble remainder. `classifyNpx` passed the same depth (now `depth + 1`), and `checkScript` had its own silent `depth >= 3` skip that read a
  deeper script as having no effects (removed: the one bound applies).
- Past the bound the classifier calls `beyondReach()`, which marks the whole call's effect frame: `CommandClassification.effectsUnknown` carries the
  reason, and a command not read whole is never `safe` (the verdict becomes `unknown`).
- Non-recursive blowups: `MAX_COMMAND_LENGTH` (100,000 characters, checked before anything is read) and `MAX_COMMAND_WORDS` (10,000 lexed words, per
  line read) give the same unknown effects. Measured before: a 1 MB command took about 5 s to classify, and the cost is per word (about 33 µs for a
  path-like word), so the word cap bounds a call at about a third of a second. A 1,500-line here-document (about 6,000 words, since the lexer reads its
  text as words) is still read.
- The gate: `gateToolCall` gives a call whose command has unknown effects an empty effect list, so `decide()` asks with a person there and refuses with
  nobody (`manifest.effects-unknown`), in every mode; a credential store the command names is still refused first.
- Tests (`src/test/commandBounds.test.ts`): 24 wrapper kinds, each read once (the push is seen), then nested past the bound and thousands deep (no throw,
  effects unknown, never safe); npm script chains and a self-running script; the loop-read wrappers (time, nohup, nice, command, env, timeout, subshell
  parentheses) read whole through thousands; both caps and a megabyte; a source scan that every recursive call goes one level deeper and both entry
  points check the bound first; the gate in fully-autonomous with a person and with nobody.
- Docs: `FLOOR_EFFECTS_CANNOT_SEE_TEXT` and SECURITY.md no longer list "commands nested more than four levels deep" as something that runs unread; they
  say such a command, or one too long to read, asks and is refused with nobody. `gateDocs` now checks five levels and a too-long command have unknown
  effects (it asserted they had no tag) and still checks four levels are read.
- Deliberate test change: `commandSafety.test.ts` asserted a self-referencing script (`test: npm test`) is `safe`, which was the fail-open result. It now
  asserts `unknown` with unknown effects; its intent (no endless loop) is kept.
- A deny-listed command that was also too deep or too long was asked about instead of refused by the deny list (the unknown-effects step came before the
  settings layer). That broke D-10 and is fixed below ("Follow-up: the deny list decides first").

### 2. [MAJOR] `floorFactsFor` failed open on any reader failure

- Commit `1b2f27b`.
- `floorFactsFor` now returns `effectsUnknown` when the classifier throws, when it stops reading (finding 1), and when the credential-store resolver
  throws (it used to `.catch(() => ({}))`, i.e. "reaches nothing"). The readers are injectable (`FloorReaders`, passed by tests through
  `GateCallOptions.floorReaders`); nothing in production passes them.
- Tests: a throwing classifier and a throwing resolver, each through `floorFactsFor` and through `gateToolCall` in fully-autonomous: asks with a person,
  refused with nobody; the same command with working readers is allowed, as before.
- Audit of the other catches in `gateAdapter.ts` and `decide.ts`: `decide.ts` has none. In `gateAdapter.ts`, `bundleHashOf`, `keep` and
  `recordRefusedBeforeGate` only affect records; `decideOrRefuse` keeps the caller's refusal; `recordApprovalReply` denies on a throw; `realFolder` falls
  back to the path as written. `readCallPaths` treats a throwing `resolveInWorkspace` as "not resolved": its credential checks still run on the path as
  written, and the tool itself resolves through the same function and refuses the call, so nothing runs on a path the gate could not read. No other catch
  yields empty effects or facts.

### 3. [MINOR] No changelog entry

- Commit `f022f72`.
- `## Unreleased` at the top of CHANGELOG.md, with a summary line and bold-led bullets: Full auto asks before writes into git's and NEAR AI's own
  folders, publishing and destruction (no Always allow, refused with nobody there; everything else still runs); key and credential stores and the
  extension's identity and policy files are refused in every mode (a project file named like VS Code's secrets database is not); a command too deep or
  too long to check asks; a late approval of a helper's card runs that call once; web search with no provider no longer asks; decision records leave
  out passwords and tokens by kind; Team Studio follows the open folder. No em-dash, no internal names.
- `gateDocs`: a new test pins this entry by its own words wherever it sits (Unreleased now, its version after the release), checks each bullet leads
  with a bold sentence, and checks for no em-dash, no "NEAR organization" and no internal names. The 0.4.28 policy entry test took whatever
  `## Unreleased` held to be the policy entry, so any later Unreleased entry broke it; it now finds that entry by its words ("Reset Policy to
  Defaults"), with every phrase check unchanged and the "Unreleased is first, a release follows" check kept. `changelogSections` passes.
- `node scripts/prepare-release.mjs check` on `feat/gate-floor` exits 1 with "run this on a release/x.y.z or hotfix/x.y.z branch", as designed.

### 4. [MINOR] VS Code's secrets database was refused by file name anywhere

- Commit `b701585`.
- `namesCredentialStore` matches `state.vscdb` and `state.vscdb.backup` only after a `globalStorage/` or `workspaceStorage/<id>/` folder (any VS Code's
  layout: Linux, macOS, Windows, remote), or anywhere under this VS Code's own storage folders, which `vscodeStorageRoots()` finds from the extension's
  global storage (the global storage folder, and in the standard layout the user-data folder above it). `shellReachesCredentialStore` uses the same check
  for each resolved word, with the global storage as written and as it resolves.
- Tests: the real locations by text and from the shell's folder are refused; `sqlite3 state.vscdb`, `fixtures/state.vscdb`, a project-root path and a
  temporary-folder path are not. Two old "anywhere" hits in `gateFloor.test.ts` (`sqlite3 /x/state.vscdb .dump`, `cp state.vscdb.backup /x`) move to
  the misses, which is the change the review asked for.
- Not changed: the auto mode's settings layer still calls such a file sensitive (it asks before reading it outside fully-autonomous); only the floor's
  refusal moved.

### 5. [MINOR] Scratch deletes were known only under `/tmp`

- Commit `7dbf485`.
- `CommandContext.temporaryRoots`: the caller hands the classifier the resolved temporary folders, so it reads no environment for them; with none given
  it keeps its old fallback (`/tmp`, `/var/tmp`, TMPDIR), which the auto mode's path still uses. `systemTemporaryRoots()` in the gate adapter gives
  os.tmpdir(), TMPDIR, `/tmp` and `/var/tmp`, each as written and as it resolves (`/private/var/folders/...`); `floorFactsFor` passes it.
- A delete is scratch only strictly inside such a folder, and never of a folder that holds the project or the home folder. That also closes the old
  rule's gap where `rm -rf /tmp/<project>` (a project kept in `/tmp`) was not destruction.
- Tests (`src/test/commandTemporary.test.ts`): a stand-in macOS folder as written and as it resolves; the folder itself, outside it and a project inside
  it; the context, not the environment, decides; `systemTemporaryRoots` with a linked stand-in tmpdir and TMPDIR; the floor with a stand-in and with
  the system's own folder.

### 6. [MINOR] `git gc`, `git prune`, `git rebase --continue` tagged destruction

- Not changed, as instructed: it is the owner question already in the PR body.

### Follow-up: the deny list decides first (D-10)

- Commit `2c11d7c`, asked for by the coordinator after the first report.
- The gap: with unknown effects, `decide()` asked before the settings layer ran, so a deny-listed command that was too deep, too long, had too many words,
  or whose classifier or resolver threw, became a card a person could approve. The phase's rule is that the deny list and the emergency stop always win.
- `GateRequest.settingsRefusal` carries a refusal the settings layer makes whatever else is true, worked out before the gate: `gateToolCall` sets it from
  the deny list for a shell command (`denyListReason` in `permissions.ts`, which `decidePermission` now also uses, so there is one matcher); `gateStep`
  sets it when the caller's settings answer is already a deny (an engagement's scope). `decide()` refuses with it before every step that could only ask:
  inside the unknown-effects step (after the floor's own refusals of what the call names, so a credential store is still recorded as the floor's) and
  before the settings layer, so before the floor's asks, taint holds and sensitive reads. The emergency stop and the bundle state still come first.
- Can the deny list be matched on an over-long command? Yes: the matcher is a plain substring search over the whole text (quotes and escapes removed,
  spaces collapsed) with no length or depth cap, and it runs on the raw command, not on what the classifier read. So no "refuse when it might match"
  fallback was needed; a too-long command that contains a deny pattern is refused by the deny list itself.
- Tests: `commandBounds.test.ts`, for each unknown-effects cause (past the bound, thousands deep, too long, too many words, classifier throws, resolver
  throws), a command with the default deny rule `git push --force` is refused as `settings.deny-list` in all four modes with a person there, the emergency
  stop refuses it as `settings.emergency-stop`, and with no deny rule the same command is asked about (`manifest.effects-unknown`).
  `gateDecide.test.ts`: a settings refusal on the request beats each kind of ask (unknown effects, a floor ask, a taint hold, a sensitive read, the
  settings layer's own ask), and the emergency stop beats it.
- Records: a deny-listed call is still recorded as `settings.deny-list` with the same reason; the settings layer is no longer asked about it, so no
  classifier or safety model runs for a command that will not run.
- Lint clean, full `npm test` as above, secret scan clean.

## Review round 2 (PR #74)

Four commits on `feat/gate-floor`, one per finding. Every new test was seen failing against the unchanged source first.

### Results

- Lint (`tsc --noEmit`): clean.
- Full `npm test` (once, at the end, 6G cap): 3345 tests, 3335 passed, 1 failed, 0 cancelled, 9 skipped (the same 9). The one failure is a timing race in
  `teamStudioPage.test.ts` ("a newer request drops the older reply", which waits a fixed 10 ms for a request to be sent and read `sent[0]` as undefined
  under full-suite load). Nothing in Team Studio changed in this round; the file was then run alone three times: 55 of 55 each time. Left as is (out of
  scope; a candidate for a follow-up that waits for the send instead of a fixed delay).
- `node scripts/secret-scan.mjs --range origin/main..HEAD`: clean. No package changes. No activation or webview code changed, so e2e was not run.

### 1. [MAJOR] A window with no folder recorded no decisions

- Commit `7bd7e43`.
- `GateHost.runtimeFor` wrote records only when the request named a folder. It now resolves the log key once for every runtime (the project's, or
  `INSTALL_LOG_KEY` for no folder or an empty one) and opens the log by that key at each record, so a log let go is reopened as before.
- Test (`gateHostLogs.test.ts`): each kind of runtime the host hands out (folder; no folder; sub-agent with and without a folder; nobody present with a
  folder, with none, and with an empty one) writes a record that is on disk in the log its key names; a fresh host's first no-folder record opens the
  install log.
- SECURITY.md now says the decisions of a no-folder window go to the install log.

### 2. [MINOR] Unknown wrappers hid a floor action

- Commit `85beef0`.
- stdbuf, flock and watch are read in the wrapper loop like timeout and nice, each with its own option syntax: stdbuf's `-i/-o/-e` modes (attached, as
  the next word, or `--output=`); flock's flags and value options, its lock file, then a command or `-c`/`--command` (read as a command line); watch's
  `-n`/`--interval` and flags, one quoted command line read as `sh -c` reads it, and `-x` read as words. A flock lock file in a protected place is a
  write there. A known runner still makes a `safe` command `unknown` (it changes how it runs).
- The class: after a program the rules do not know, each later word that names a program the rules can tag (`TAGGED_PROGRAMS`: the tagged commands,
  the runners, shells, privilege wrappers, interpreters) is read from there; if that tags anything, the command's effects are unknown, so the gate asks.
  More than 16 such words are not each read: unknown too. Words that tag nothing (`chronic git status`) change nothing. Shell keywords (`if`, `{`,
  `exec`, ...) keep their own reading, which already reads the words after them.
- Tests (`commandEffects.test.ts`): every tagged row (publish, destroy, protected write) through ten forms of the three runners keeps its exact tags;
  every row after four unknown wrappers (`chronic`, `ionice -c3`, a made-up runner with options, one by absolute path) is tagged or has unknown effects;
  look-alikes stay untagged. The source scan in `commandBounds.test.ts` now counts parentheses to read a call's arguments (it missed
  `classifyWords(args.slice(index), …, depth + 1)`) and covers the new probe.
- Docs: `FLOOR_EFFECTS_CANNOT_SEE_TEXT` and SECURITY.md name timeout, nice, stdbuf, flock and watch among the wrappers read, drop "wrappers they do not
  know" from what runs unread, and say a program they do not know with a flagged command after it asks. The CHANGELOG bullet says the same. gateDocs:
  the three wrappers move from the "not seen" list to the "seen" list, `chronic git push` and `ionice -c3 rm -rf src` are checked to have unknown effects,
  and the text and changelog phrase checks follow the new words.

### 3. [MINOR] `--user 1000:1000` was removed from records

- Commit `a0492b8`.
- After `-u`, `--user`, `--proxy-user` or `-U`, a value of digits, a colon and digits (quoted, attached or after `=`) is kept. Every other value with a
  colon is still removed, including a numeric user with a password and a number-only password after a name. Nothing else was exempted (a name and
  group, or `$(id -u):$(id -g)`, can carry a password, so they are still removed).
- Tests (`gateRecordRedaction.test.ts`): six docker and podman forms kept whole by both the class rule and the token rules; the near misses removed.
  SECURITY.md says the numeric user and group is kept; gateDocs checks the sentence and runs the example.

### 4. [MINOR] manifestInput ran twice per call

- Commit `412620d`.
- `CallPaths.input` (replacing `raw`) is the call's arguments in the manifest's shape, built once by `readCallPaths`, with each trusted-folder read
  written as `**`. `gateToolCall` and `effectsOfStep` fill the effects from it (`effectsOfArguments`), so manifestInput runs once per call and a tool
  that renames a field keeps the trusted-folder rewrite. `effectsOfCall` and `manifestArguments` keep their behaviour for callers that start from the
  model's own arguments.
- Tests (`gateCallArguments.test.ts`): a stand-in tool whose manifestInput renames `file` to `file_path`: a trusted-folder read is a known read and is
  allowed with nobody present, manifestInput runs once for the whole decision, a read outside every trusted folder stays unknown, and a project read is
  its project path.

## Review round 4 (PR #74)

Five commits on `feat/gate-floor`, on top of the coordinator's `29a82e3` and `25174d3`. Every new test was seen failing against the unchanged source first
(the implementation set aside with a tagged stash and applied back by SHA, or the test run before the code existed).

### Results

- Lint (`tsc --noEmit`): clean.
- Full `npm test` (6G cap): 3356 tests, 3347 passed, 0 failed, 0 cancelled, 9 skipped (the same 9). An earlier full run in this round failed one test, the
  source scan in `commandBounds.test.ts`, which correctly reported a new same-level call (`classifyPackageManagerIn -> checkScript`) after the last
  commit split a function; the scan's list of known descents was updated in that same (unpushed) commit, and the full suite was run again.
- `node scripts/secret-scan.mjs --range origin/main..HEAD`: clean. No package changes. No activation or webview code changed, so e2e was not run.

### 1. [MAJOR] Package scripts were read only from the project root

- Commits `6805f80` and `93dd67a`.
- `PackageScriptsReader` (`src/agent/packageScripts.ts`) finds the nearest package.json at or above a folder, as the package managers do, and keeps it by
  file, read again only when its size or time changes. The loop holds one per run and gives it to the floor (`FloorShellContext.packageScriptsAt`) and to
  the auto mode's checks (`CommandContext.packageScriptsAt`); `floorPackageScripts` (root only) is gone.
- The folder a package manager runs in is the shell's folder, moved by cd and pushd earlier on the line, by npm `--prefix`/`-C`, yarn and bun `--cwd`,
  pnpm `-C`/`--dir`, and npm `--workspace`/`-w` given a package folder. A script is read with its package's folder as the shell's folder. npm
  start/stop/restart and pnpm/bun scripts by name are read too.
- Unknown effects (asks), never "a project script": a cd to a run-time folder, `cd -`, a glob, popd, pushd with no folder, a cd inside parentheses, a
  folder outside the project (including a bare cd to home), a package.json that cannot be read, one above the project, a workspace given by name, every
  workspace (`--workspaces`, `-ws`), pnpm `-r`/`--filter`/`-w`, yarn `workspace(s)`, bun `--filter`.
- No verdict is made newly safe by this (`93dd67a`): a safe reading of a folder option, npm start/stop/restart or a pnpm/bun script by name stays
  `unknown`, as before. `cd sub && npm run x` is now read from sub, which can move a verdict either way (it is the script that really runs).
- Tests (`packageScriptsFolder.test.ts`): 17 forms that name the folder, the script's own folder for its paths, the nearest package.json for a folder
  with none, a nested workspace package by cd and by `--workspace`, 23 unknown forms, the cache (one read while unchanged, one more after a change,
  unreadable, outside), the gate with a person and with nobody, never newly safe. `gateFloorRuns.test.ts`: a real run in Full auto with nobody present,
  where `cd sub && npm run sync` (sub's script pushes) is refused as `floor.publish` and nothing reaches the remote, and the root's harmless script runs.
- Docs: `FLOOR_EFFECTS_CANNOT_SEE_TEXT` and SECURITY.md say scripts are read from the package.json of the folder the command runs in, and that a
  package script in a folder they cannot tell (or whose package.json they cannot read) asks. The coordinator's sentence about the unknown-program case
  still follows that case, which stays last in the list. The CHANGELOG bullet says the same. gateDocs pins the new words and checks both directions.

### 2. [MINOR] A log let go could be replaced by a second writer for the same file

- Commit `28c3e4b`.
- The host keeps a log being let go by key until its queue is written; a reopen of that key takes it back, so one instance writes each file. It is let
  go for good only after its flush resolves and only if nothing took it back; `flush()` still waits for it.
- Test (`gateHostLogs.test.ts`): four rounds of 25 records, the folder closed with records queued, then 25 more at once: every record on disk in the
  order made, numbered 1 to 200 with no gap or repeat (red before: the order on disk differed).

### 3. [MINOR] A call reading several trusted-folder files named only the first

- Commit `2c9ccd9`.
- `trustedReadsName` lists every file, as many as fit in the resource name's 200 characters, then "and N more" (a first name too long to fit is cut to
  make room). Chat calls and cyber steps both use it.
- Tests (`gateCallArguments.test.ts`): a stand-in tool reading two trusted files names both in its decision and its record; a long list ends with the
  count of what was left out.

### 4. [MINOR] The temporary folders were resolved on every shell call

- Commit `df4cdf4`.
- `temporaryRootsCache` keeps `systemTemporaryRoots()` and works it out again only when the temporary folder or TMPDIR it came from changes; the
  floor uses the process's cache when its caller names no folders, and a caller or test can still hand in its own. Once per process (and again after a
  change) rather than once per host or run: the answer depends only on the process's environment.
- Test (`commandTemporary.test.ts`): a stand-in source that counts resolves: four on the first call, none on the next hundred, four more after each
  change.

## Review round 5 (PR #74)

Three commits on `feat/gate-floor`, one per minor finding; the nit was skipped as instructed. Every new test was seen failing first: the scratch and
late-approval tests against the unchanged source, the git branch test against a mutant that tags `-m`/`-c` (the behaviour itself was already right).

### Results

- Lint (`tsc --noEmit`): clean.
- Full `npm test` (6G cap): 3363 tests, 3354 passed, 0 failed, 0 cancelled, 9 skipped (the same 9).
- `node scripts/secret-scan.mjs --range origin/main..HEAD`: clean. No package changes. No activation or webview code changed, so e2e was not run.

### 1. Recursive deletes in the project's scratch folder asked

- Commit `4e2c9d8`.
- A delete target strictly inside `.near-ai/scratch`, named with no `..`, that lands inside it however links resolve, is scratch for plain and
  recursive deletes alike: no tag. Never the folder itself, its parents or the project. Each target of a recursive delete is now excused on its own (a
  temporary folder's contents, the scratch folder's contents, or build output), so a mix of them is excused too.
- Where a delete lands: the folders on the way resolved through links, and the last part too when it ends with a slash (rm then follows it). A plain
  delete through a link that leaves the project is now destruction (before, it was judged by its text only).
- Test (`commandTemporary.test.ts`, a real project): plain and recursive deletes inside scratch (by relative and absolute path, and from a shell in the
  scratch folder) carry no tag; the folder itself, its parent (also by `..`), a `..` escape, a link into the project and a link out of it (with a
  trailing slash, and through it), and plain deletes through a link or `..` out of the project are destruction.

### 2. A late floor approval could outlive its call

- Commit `7572aa7`.
- Every decision of a call now takes that exact call's late approval, whatever its outcome; it lets the call run only when the decision is a floor ask.
  A refusal in between (the emergency stop, the caller's own refusal, a failed-closed policy, a deny) uses it up.
- `FloorApprovalsOnce` replaces the bare set: an approval expires after `FLOOR_APPROVAL_TTL_MS` (five minutes, against the runtime's clock), and all end
  with the lead's turn (`endFloorApprovals`, called where agentSession finishes the turn); one given after the end is not kept.
- Tests (`gateLateApproval.test.ts`, injectable clock): once and not twice; used up by the emergency stop, by the caller's refusal and by a
  failed-closed policy; expired one millisecond past the TTL and still good one millisecond before; nothing after the turn ends. The existing
  late-approval run in `gateFloorRuns.test.ts` passes unchanged.
- Known gap (unchanged): a call refused before the gate (an unknown tool, a check that throws) does not reach a decision, so it does not use up an
  approval; the TTL and the turn's end still bound it.

### 3. git branch comment and tests

- Commit `ec05a9e`.
- Behaviour kept: `-M`, `-C`, and `--move`/`--copy` with `--force` (they overwrite an existing branch of the new name, whose commits can be lost),
  `-d`/`-D`/`--delete` and `-f`/`--force` are destruction; `-m`, `-c`, `--move`, `--copy`, upstream and description changes are not (still risky,
  so they ask in the asking modes). The comment now says exactly this.
- Test (`commandEffects.test.ts`): `-m`, `-c`, `--move`, `--copy` and `-m new` carry no tag; `-M`, `-C`, `--move --force`, `--copy --force`,
  `-mf`, `-cf`, `-f` and `-D` are destruction.

## Review round 6 (PR #74)

Four commits on `feat/gate-floor`, one per finding (the nit included, as asked). Every new test was seen failing first: the no-reader tests against
the unchanged classifier (set aside with a tagged stash and applied back by SHA), the others against the unchanged source.

### Results

- Lint (`tsc --noEmit`): clean.
- Full `npm test` (6G cap): 3372 tests, 3363 passed, 0 failed, 0 cancelled, 9 skipped (the same 9).
- `node scripts/secret-scan.mjs --range origin/main..HEAD`: clean. No package changes. No activation or webview code changed, so e2e was not run.

### 1. Scripts nobody read were an empty set

- Commit `9315d9e`.
- `scriptsIn`: with no reader, only root scripts the caller read (`packageScripts`) are known; with none read, a named script, in the root or a
  subfolder, is unknown with unknown effects (never safe). A release-like name still tags `publish{release}` on its own word, as it does when the
  scripts are known.
- Audit of every caller of the classifier: the loop gives the floor and the auto mode's checks a reader (round 4); `decidePermission`/
  `decidePermissionAsync` classify only with the auto context the loop builds; the unattended check takes that same context; the gate's floor reads
  through `floorFactsFor` (reader from the loop) and its rule naming uses the auto context; `cyberRun` calls `decidePermission` with no auto context,
  so the classifier is never asked there (a shell step asks in auto). `toolsDirectory` passes no command.
- Tests (`packageScriptsFolder.test.ts`), one per caller kind with no reader: the classifier (root, subfolder, yarn, pnpm, npm start; the release name;
  root scripts read and a subfolder's not), auto approval and permissions (the command goes to the safety model, and with none it asks), the
  unattended check (not allowed), the gate in Full auto (asks with a person, refused with nobody, `manifest.effects-unknown`), and the cyber
  permission path (asks).
- Test fixtures: the shared contexts of `commandSafety.test.ts`, `commandEffects.test.ts` and `autoApproval.test.ts` described a project but said
  nothing of its scripts, which the old code read as "none". They now state it (a reader for a root package.json with no scripts), and a test that
  names root scripts is read with those. Every expectation in those files is unchanged.

### 2. A card with no grant told the agent "allowed for the rest of this run"

- Commit `a99e349`.
- `awaitingApprovalMessage` takes the card that was sent, built once in the loop: a floor card is allowed once; a card that carries a grant (a command
  or edits) is allowed for the rest of the run; any other card (effects the gate cannot read, a held action) grants nothing ahead of time, and running
  the call again asks again. This matches what a late answer does (agentSession tells the lead "approved-once" when no grant took effect).
- Tests (`gateFloorRuns.test.ts`): each card kind; through a real run, an effects-unknown card nobody answers (no grant on the card, no "rest of this
  run" in the message) and a grantable one (a grant on the card and the words). The existing floor-message test now passes card shapes; its
  expectations hold.

### 3. readCallPaths resolved folders per path field

- Commit `4a3e717`.
- The project and the trusted folders are resolved through links once per call, and only when a path needs them. The resolver can be handed in.
- Test (`gateCallArguments.test.ts`): two path fields and two trusted folders resolve three folders, not six; a call naming no path resolves none.

### 4. (nit) Late approvals read two clocks

- Commit `82a3083`.
- `FloorApprovalsOnce.add` and `has` take the time, with no default. `approveFloorCallLate(grants, callKey, clock)` stamps an approval with the clock
  of the runtime whose gate checks it; agentSession passes the sub-agent's runtime clock (the host's; `Date.now` only when a run has no gate runtime,
  which is also what the gate then reads).
- Test (`gateLateApproval.test.ts`): with a runtime clock a day past the fixed start, an approval given through it is honoured by the gate and has
  expired a TTL later by that clock. The store test in `gateFloorRuns.test.ts` passes explicit times.

## Review round 7 (PR #74)

Four commits on `feat/gate-floor`, one per finding. Every new test was seen failing first: the classifier and gate tests against the unchanged source
(set aside with a tagged stash and applied back by SHA), the docs pins against the old words.

### Results

- Lint (`tsc --noEmit`): clean.
- Full `npm test` (6G cap): 3383 tests, 3374 passed, 0 failed, 0 cancelled, 9 skipped (the same 9).
- `node scripts/secret-scan.mjs --range origin/main..HEAD`: clean. No package changes. No activation or webview code changed, so e2e was not run.

### 1. [BLOCKER] Global options hid the subcommand

- Commit `a1367c9`.
- `GLOBAL_OPTIONS` lists every program the classifier tags by its subcommand, found from the code: git, docker, podman, kubectl, oc, helm, terraform,
  tofu, pulumi, cdk, serverless, sls, gh, glab, cargo, vsce, ovsx, gem, aws, gcloud, az, gsutil, npm, pnpm, yarn, bun. For each: the options that take a
  value (`--opt value`, `--opt=value`, a short one attached as `-nvalue`), the flags (short ones also together, `-qv`), and those that move the folder
  (git `-C`, terraform/tofu `-chdir`, pulumi `-C`/`--cwd`, cargo `-C`); `--help`, `-h` and `--version` everywhere; cargo's `+toolchain`. They are
  skipped before the subcommand is read (`skipGlobals`, `classifyAfterGlobals`); the package managers skip theirs in `classifyPackageManager`, after
  their folder options, and their registry verbs are now read before the `--global`/`--registry` early answer.
- Backstop: an option before the subcommand that is not listed, or a folder option decided at run time, makes the effects unknown (asks). git `-C`
  moves the folder for the subcommand's paths (`git -C sub clean -fd build` destroys `sub/build`).
- Never newly safe: after a value option, or any option but `--no-pager` for git, docker, podman and go (which never read past an option before), a
  harmless subcommand stays unknown.
- make: the targets are read anywhere already; a release-like target is now tagged even with `-C` or `-f` (it returned unknown, untagged, before).
- near reads every word, so no option hides its verbs; it is not in the table.
- Tests (`commandGlobalOptions.test.ts`): every tagged subcommand of every program keeps its exact tags after each value option in both forms and after
  each flag (several hundred combinations, counted); an unknown option before it gives unknown effects; the review's examples; git `-C` paths and a
  run-time folder; harmless subcommands after options stay non-safe. The source scan in `commandBounds.test.ts` knows the one new same-level call
  (`classifyAfterGlobals -> classifyProgram`, with strictly fewer words and no leading option).

### 2. [MINOR] A cyber step's command was never read by the floor

- Commit `26adbd0`.
- `gateStep` reads a step's command with `floorFactsFor`, as `gateToolCall` does, and both join the command's tags to the declared effects through one
  helper (`effectsWithReading`); a command the floor cannot read whole, or one with no folder to read it in, has unknown effects. `cyberRun` passes the
  project's folder (`GateStepInput.root`).
- Found with it: a project kept in a temporary folder had its own files read as temporary scratch (`rm -rf src` there carried no tag); a path inside
  the project is never temporary now. And with a failed-closed policy, a call the deny list also refuses is refused by the deny list's rule (both
  refuse; the person's own rule is named, as everywhere else) — this kept `cyberRun.test.ts`'s deny-list step naming the deny list, unchanged.
- Tests (`gateCyberStep.test.ts`): a step running `git push` or `rm -rf src` is `floor.publish` / `floor.destroy`, asked with a person and refused with
  nobody in Full auto; a too-deep command and one with no folder have unknown effects; `nmap` does not. `commandTemporary.test.ts`: the project in a
  temporary folder. `gateDecide.test.ts`: the deny list named over a failed-closed policy.

### 3. [MINOR] A credential after a quote was kept in records

- Commit `933028b`.
- A quote and a comma start a name=value too (`&`, `?`, `;` already did), and an unquoted value ends at a quote or a comma, so the quote around a form
  body stays. Idempotent (tested).
- SECURITY.md names form fields (`-d "password=..."`); gateDocs checks the words and runs the example.
- Tests (`gateRecordRedaction.test.ts`): double and single quotes, after `&`, `,` and `;`, quotes kept, applied twice, look-alike names kept.

### 4. [MINOR] The docs did not say a mere mention of a credential store is refused

- Commit `e8d722d`.
- Kept as a refusal. `FLOOR_CANNOT_SEE_TEXT` (and SECURITY.md word for word): because the checks read text, a command that only mentions one of these
  folders (a commit message naming ~/.ssh) is refused too, with nothing to approve; rephrase it so it does not name the folder, or do that step yourself.
  The CHANGELOG bullet says the same.
- The "a false alarm costs one card" sentence is scoped to the publishing and destruction checks ("here ..."), followed by "The check of key and
  credential folders above is stricter: a mention there is refused, with no card."
- gateDocs pins both sentences, checks the old unscoped sentence is gone, and checks that a commit message naming `~/.ssh` is refused by the code.

## Review round 8 (PR #74)

Two commits on `feat/gate-floor`, one per finding. Every new test was seen failing first against the unchanged source (set aside with a tagged stash
and applied back by SHA).

### Results

- Lint (`tsc --noEmit`): clean.
- Full `npm test` (6G cap): 3389 tests, 3380 passed, 0 failed, 0 cancelled, 9 skipped (the same 9).
- `node scripts/secret-scan.mjs --range origin/main..HEAD`: clean. No package changes. No activation or webview code changed, so e2e was not run.

### 1. [MAJOR] An early return could still report complete, empty effects

- Commit `71715d8`.
- The invariant, inverted: `unknown(...)` now marks the command's effects unknown by default; only a path that read the whole command and cannot judge
  it says so, with `unknownRead(...)`. classifyCommand reports `effectsUnknown` whenever the frame was marked, so every early return is unknown unless it
  positively says otherwise. lexed.broken marks it too; its sensitive-text `risky` verdict stays where it was.
- Each of the 100+ calls was decided. Read whole: a known program's own words, judged unknown for safety (git reset, checkout, merge, tag, branch, npm
  install, outdated, docker ps, kubectl get, gh, cargo run, go run, make install, near, aws, export), a script file or inline code in another language (the
  documented gap: what a script does), a program the rules do not know whose later words were probed (now also an npx package), a git command of git's
  own (`GIT_BUILTINS`: init, worktree, clone, ...), shell-structure answers that read every part (cd out of the project, a read outside it, a variable,
  a subshell). Not read whole (effects unknown, asks in Full auto): an option the rules do not know (sed, awk, git's own globals before the table),
  a nested command not read (`env -i ...`, `timeout --signal ...`, sed `e`/`w` scripts, awk `system`), a write whose target or folder is decided at run
  time (a redirect to `$OUT`, `cd "$D"`, `sed -i *.txt`, `find -fprint`), writes the rules do not tag (`git config`, `git rm -f`, `git ... --output`,
  `chmod`, `ln`, local `rsync`, `tsc --outDir`, `sort -o`, a non-plain `curl`), a name that may be an alias (`git lg`, `alias x=...`), npm or git given
  by an unusual path, `npm version` (runs version scripts), and an unparseable line.
- Tests (`commandReadWhole.test.ts`): a source scan lists every `unknown(` and `unknownRead(` call; each has an input that reaches it (checked by its
  reason), or is listed with why not (the bound and caps, covered by commandBounds; git's old global-option return, now a backstop behind
  classifyAfterGlobals). Read-whole inputs give complete effects (and the right tags), the others unknown effects. Two property tests: every tagged
  command (push, delete, publish, image push, reset, apply, a protected write) followed by each of eleven breakages, and a quote or bracket dropped at
  420 seeded random places, keeps its tag or has unknown effects, never complete and empty. The review's example and the sensitive-text case.
- Docs: the floor's effects text, SECURITY.md and the CHANGELOG add "one they cannot parse (a quote left open, say), one with an option they do not know
  where they would read what it runs" to the commands that ask; gateDocs pins it and checks examples (`git push origin main; echo "`, `env -i git
  push`, `git -frob x push`).
- UX change to note: in Full auto, the not-read-whole cases above now ask (refused with nobody), where they ran before.

### 2. [MINOR] The package.json cache missed a same-size rewrite

- Commit `a477766`.
- The reader reads the file for every decision (a package.json is small) and keeps only the parse, keyed by a SHA-256 of the content, so a rewrite is
  seen whatever its size and time.
- Tests (`packageScriptsFolder.test.ts`): a same-size rewrite with its time set back to the same value is seen by the reader and by the floor; the
  file is read for every decision and unchanged content gives the same parse. The round 4 cache test (which pinned the size-and-time key) is replaced.
- No SECURITY.md wording described the cache; the loop's comment now says how it reads.

### Refinement: writes the command names are tagged, not unknown (GATE-06)

- Commit `ff28d0b`, asked for by the coordinator to keep Full auto usable.
- `writesNamed`/`writeResult`: a write whose target the text names (after cd, `-C` and `env -C` folder moves; a wildcard as a project-relative
  pattern) is a `workspaceWrite` on that path, with complete effects. A protected place (`.git/`, `.near-ai/`) is then a floor ask, as any write there
  is. Effects stay unknown only for a target decided at run time, one outside the project and not scratch, or an option the rules do not read.
- Programs: chmod/chown/chgrp/chattr, ln, git rm/mv -f, git `--output`/`-o`, git config (a setting writes `.git/config`, so the floor asks; a read
  writes nothing; `--file` names the file), rsync (destination; `--delete` destroys it; `-e` not read), tsc and the other dev tools (output options;
  config and plugin options not read), sort -o, sed -i on a wildcard, find -fprint, awk printing to a file its program names, curl and wget (`-o`,
  `-O`, `--output-dir`, `-P`, the URL's file name, a recursive fetch's host folder; `-K`, `-e`, `--config` not read). A plain `curl -o` inside the
  project was untagged before this PR's round 8: a download into `.git/` now asks.
- env and timeout options are read through to the command they run (env `-i`, `-u`, `-C`, `-S`; timeout `-s`, `-k`, `--preserve-status`,
  `--foreground`); an unknown option still leaves the effects unknown.
- A curl or wget word decided at run time (it reached plainDownload as empty text) is not a plain download.
- Tests (`commandNamedWrites.test.ts`): per program, a literal in-project target is a write on that path and runs with no card in Full auto with nobody
  present; a `$VAR` target is unknown and asks, refused with nobody; a `.git/` or `.near-ai/` target is a floor ask. git config read and write, rsync
  `--delete`, env/timeout read through, downloads to the terminal. The read-whole table follows the new and removed calls. Seen failing against the
  round 8 classifier first.
- Full suite: 3395 tests, 3386 passed, 0 failed, 9 skipped; lint clean; secret scan clean. No existing Full auto test asks.
- Survey of common commands in Full auto with nobody present, after this: npm test/run/install/ci, npx, node and python scripts, git status/add/commit/
  checkout/pull/fetch/log/diff/stash/merge/tag, rm -rf of build output, mkdir/touch/cp/mv/chmod/ln/sed -i inside the project, redirects, curl and
  wget downloads, docker build/run/compose, make, cargo, go, env/timeout wrappers, cd, bash -c, gh pr create/view all run with no card. Still asking
  (or refused with nobody): publishing (git push, docker push, kubectl apply, make deploy, gh release create), destruction (git rebase, reset --hard,
  clean, branch -D, commit --amend, rm -rf of project folders), writes into `.git/` or `.near-ai/` (git config set), and unknown effects (a git alias
  such as `git lg`, a write to a `$VAR` target, an unparseable line, an option the rules do not read).
