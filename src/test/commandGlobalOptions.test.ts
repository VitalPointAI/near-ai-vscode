// PR #74 review round 7: a program's own global options before its subcommand hid the subcommand. `docker --context prod push app:1`,
// `kubectl --context prod apply -f x`, `git -C repo push`, `git -c k=v push`, `helm --kube-context x upgrade` carried no tag, so in Full auto they ran
// unasked. Every program the classifier tags by subcommand now skips its known global options (a value as the next word or after `=`, short clusters)
// before it reads the subcommand, and an option it does not know there makes the command's effects unknown. Nothing here runs a command.
import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyCommand, GLOBAL_OPTIONS } from '../agent/commandSafety';
import type { CommandContext, CommandEffect } from '../agent/commandSafety';

const context: CommandContext = { root: '/work/app', cwd: '/work/app', home: '/home/dev', packageScriptsAt: () => ({ kind: 'found', folder: '/work/app', scripts: {} }) };
const classify = (command: string) => classifyCommand(command, context);
const key = (effects: readonly CommandEffect[] | undefined): string => JSON.stringify([...(effects ?? [])].map((effect) => JSON.stringify(effect)).sort());

/** For each program tagged by subcommand, the subcommands it tags, written as they follow the program. Their tags do not depend on the folder. */
const TAGGED: Readonly<Record<string, readonly string[]>> = {
  git: ['push origin main', 'push', 'reset --hard', 'rebase main', 'commit --amend -m x', 'branch -D old', 'send-email 0001.patch'],
  docker: ['push app:1', 'image push app:1'],
  podman: ['push app:1', 'image push app:1'],
  buildah: ['push app:1'],
  kubectl: ['apply -f k8s.yaml', 'delete pod app-1', 'rollout restart deploy/app', 'scale deploy/app --replicas=2'],
  oc: ['apply -f k8s.yaml', 'delete pod app-1'],
  helm: ['upgrade app ./chart', 'install app ./chart', 'uninstall app', 'rollback app 1'],
  terraform: ['apply', 'destroy', 'import a.b id'],
  tofu: ['apply', 'destroy'],
  pulumi: ['up', 'destroy'],
  cdk: ['deploy', 'destroy'],
  serverless: ['deploy', 'remove'],
  sls: ['deploy'],
  gh: ['release create v1.0.0', 'release upload v1.0.0 app.vsix', 'pr merge 12', 'pr merge --squash 12', 'api -X POST repos/acme/app/issues', 'api repos/acme/app/issues -f title=x'],
  glab: ['release create v1.0.0', 'mr merge 3'],
  cargo: ['publish', 'yank --version 1.0.0', 'owner --add bob'],
  vsce: ['publish'],
  ovsx: ['publish app.vsix'],
  gem: ['push app.gem'],
  aws: ['s3 cp out s3://bucket/ --recursive', 's3 mv a s3://bucket/a', 'cloudformation deploy --template-file t.yaml'],
  gcloud: ['app deploy', 'storage rm gs://bucket/a'],
  az: ['webapp deploy --src-path app.zip', 'group delete -n rg'],
  gsutil: ['cp a.txt gs://bucket/', 'rm gs://bucket/a'],
  npm: ['publish', 'unpublish pkg@1.0.0', 'dist-tag add pkg@1.0.0 latest', 'deprecate pkg old'],
  pnpm: ['publish'],
  yarn: ['npm publish'],
  bun: ['publish']
};

/** A value for an option: a folder the project has for the options that move the folder, a plain word otherwise. */
const valueFor = (option: string): string => (/^(?:-C|-chdir|--cwd|--dir|--work-tree|--git-dir)$/.test(option) ? 'sub' : /^-c$/.test(option) ? 'core.pager=cat' : 'v1');

test('every program tagged by subcommand has its global options listed, and every tagged subcommand is tagged when written plainly', () => {
  for (const program of Object.keys(TAGGED)) {
    assert.ok(GLOBAL_OPTIONS[program] !== undefined, `${program} lists its global options`);
    for (const verb of TAGGED[program]!) assert.ok((classify(`${program} ${verb}`).effects ?? []).length > 0, `${program} ${verb} is tagged`);
  }
});

test('each tagged subcommand keeps its exact tags after each of its program\'s value-taking global options, as `--opt value` and `--opt=value`', () => {
  const wrong: string[] = [];
  let checked = 0;
  for (const [program, verbs] of Object.entries(TAGGED)) {
    const globals = GLOBAL_OPTIONS[program]!;
    for (const verb of verbs) {
      const plain = key(classify(`${program} ${verb}`).effects);
      for (const option of globals.values) {
        const forms = option.startsWith('--') || option.startsWith('-chdir') ? [`${option} ${valueFor(option)}`, `${option}=${valueFor(option)}`] : [`${option} ${valueFor(option)}`];
        for (const form of forms) {
          const command = `${program} ${form} ${verb}`;
          const result = classify(command);
          checked += 1;
          if (key(result.effects) !== plain || result.effectsUnknown !== undefined) wrong.push(`${command} → ${JSON.stringify(result)} (plain: ${plain})`);
        }
      }
      for (const flag of globals.flags) {
        const command = `${program} ${flag} ${verb}`;
        const result = classify(command);
        checked += 1;
        if (key(result.effects) !== plain || result.effectsUnknown !== undefined) wrong.push(`${command} → ${JSON.stringify(result)} (plain: ${plain})`);
      }
    }
  }
  assert.deepEqual(wrong, []);
  assert.ok(checked > 300, `${checked} combinations checked`);
});

test('an option the rules do not know before a tagged subcommand gives unknown effects, never "no tag"', () => {
  for (const [program, verbs] of Object.entries(TAGGED)) {
    for (const command of [`${program} --frobnicate ${verbs[0]}`, `${program} --frobnicate value ${verbs[0]}`]) {
      const result = classify(command);
      assert.equal(typeof result.effectsUnknown, 'string', `${command} → ${JSON.stringify(result)}`);
      assert.notEqual(result.verdict, 'safe', command);
    }
  }
});

test('the examples the review named are tagged', () => {
  const push: CommandEffect = { verb: 'publish', target: 'git-remote' };
  for (const command of ['git -C repo push', 'git -c k=v push', 'git --git-dir=x push', 'git --git-dir x push', 'git --no-pager -C . push', 'git -C sub -c a=b push origin main']) {
    assert.deepEqual(classify(command).effects, [push], command);
  }
  assert.deepEqual(classify('docker --context prod push app:1').effects, [{ verb: 'publish', target: 'container-registry' }]);
  assert.deepEqual(classify('kubectl --context prod apply -f x').effects, [{ verb: 'publish', target: 'deploy' }]);
  assert.deepEqual(classify('kubectl -n prod delete pod a').effects, [{ verb: 'publish', target: 'deploy' }]);
  assert.deepEqual(classify('kubectl -nprod delete pod a').effects, [{ verb: 'publish', target: 'deploy' }], 'a short value attached');
  assert.deepEqual(classify('helm --kube-context x upgrade app ./chart').effects, [{ verb: 'publish', target: 'deploy' }]);
  assert.deepEqual(classify('terraform -chdir=infra apply').effects, [{ verb: 'publish', target: 'deploy' }]);
  assert.deepEqual(classify('cargo +nightly publish').effects, [{ verb: 'publish', target: 'registry' }], 'a toolchain before the subcommand');
  assert.deepEqual(classify('npm --tag beta --access public publish').effects, [{ verb: 'publish', target: 'registry' }]);
  for (const command of ['make -C sub release', 'make -f ci.mk deploy', 'make --directory=sub release']) assert.deepEqual(classify(command).effects, [{ verb: 'publish', target: 'release' }], command);
});

test('git -C moves the folder the subcommand works in: its paths are read from there', () => {
  assert.deepEqual(classify('git -C sub clean -fd build').effects, [{ verb: 'destroy', paths: ['sub/build'] }]);
  assert.deepEqual(classify('git -C sub restore src/a.ts').effects, [{ verb: 'destroy', paths: ['sub/src/a.ts'] }]);
  assert.equal(typeof classify('git -C "$REPO" push').effectsUnknown, 'string', 'a folder decided at run time');
});

test('global options never make a command newly safe: a harmless subcommand after them stays as unknown as it was', () => {
  for (const command of ['git -C sub status', 'git -c color.ui=never log', 'docker --context prod ps', 'kubectl --context prod get pods', 'gh -R acme/app pr view 1']) {
    assert.notEqual(classify(command).verdict, 'safe', command);
  }
});
