import assert from 'node:assert/strict';
import test from 'node:test';
import { launchLocalWorkbench } from '../../scripts/launch-local-workbench.mjs';

const image = `ghcr.io/vitalpointai/near-ai-vscode@sha256:${'1'.repeat(64)}`;
const imageId = `sha256:${'2'.repeat(64)}`;
const containerId = '3'.repeat(64);
const owner = 'com.vitalpointai.sterling.launcher';
const release = 'com.vitalpointai.sterling.release';
const containerName = 'sterling-local-workbench';
const volumeName = 'sterling-local-workspace';
const workspace = '/home/sterling/workspace';
const binding = { HostIp: '127.0.0.1', HostPort: '43112' };
const launched = 'http://localhost:43112/';
const endpoint = 'http://127.0.0.1:43112/healthz';
const dockerRoot = '/mnt/workbench data/docker';
const availableStorage = 'Docker data-root filesystem visible to the launcher has 15 GiB available (16106127360 bytes). Other mounts may differ.';
const unavailableStorage = 'Docker data-root filesystem space is unavailable.';
const emptyProxies = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'FTP_PROXY']
  .flatMap((name) => [`${name}=`, `${name.toLowerCase()}=`]);

function fixture(options = {}) {
  const architecture = options.arch === 'arm64' ? 'arm64' : 'amd64';
  const imageConfig = {
    User: '10001:0', Entrypoint: ['node', '/app/bin/start.mjs'],
    Cmd: ['--session-preference', 'nearAi.autoInstallGsd=false'],
    Env: ['HOME=/home/sterling', 'THEIA_DEFAULT_PLUGINS=local-dir:///plugins'],
  };
  const mutations = [];
  const prerequisiteSteps = [];
  const probes = [];
  const postHealthTimeouts = [];
  const capacityQueries = [];
  const storageProbes = [];
  let installed = options.installed ?? true;
  let namedVolume = options.volume;
  let namedContainer = options.container;
  let now = 0;
  let healthAnswered = false;
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
  const missing = (kind, target) => ({
    code: 1, stdout: options.missStdout ?? '[]',
    stderr: kind === 'volume' ? `Error response from daemon: get ${target}: no such volume`
      : `Error response from daemon: No such ${kind}: ${target}`,
  });
  const deps = {
    platform: options.platform ?? 'linux',
    arch: options.arch ?? 'x64',
    nodeVersion: options.nodeVersion ?? '26.13.1',
    env: options.env ?? {},
    async statSocket(socket) {
      assert.equal(socket, '/var/run/docker.sock');
      prerequisiteSteps.push('socket');
      if (options.socketDenied) throw Object.assign(new Error('untrusted detail'), { code: 'EACCES' });
      return !options.noSocket;
    },
    async docker(args, env, timeout) {
      assert.deepEqual(args.slice(0, 2), ['--host', 'unix:///var/run/docker.sock']);
      assert.equal(env.DOCKER_CONTEXT, undefined);
      assert.equal(env.DOCKER_HOST, undefined);
      const [command, subcommand, target] = args.slice(2);
      if (command === '--version') {
        assert.deepEqual(args.slice(2), ['--version']);
        prerequisiteSteps.push('client');
        return options.clientError ? { code: options.clientError, stderr: 'untrusted detail' } : ok('Docker version 28.0.0');
      }
      if (command === 'version') {
        assert.deepEqual(args.slice(2), ['version', '--format', '{{json .Server}}']);
        prerequisiteSteps.push('engine');
        return options.engineError ? { code: 1, stderr: options.engineError }
          : ok(JSON.stringify({ Os: 'linux', Arch: options.engineArch ?? architecture, Version: options.engineVersion ?? '28.0.0' }));
      }
      if (command === 'info') {
        assert(options.checkOnly, 'capacity is observed only in check mode');
        capacityQueries.push(args.slice(2));
        assert.equal(timeout, 3000);
        prerequisiteSteps.push('capacity');
        const projectedRoot = target.includes('DockerRootDir') ? `\n${JSON.stringify(dockerRoot)}` : '';
        return options.capacityResult ?? ok(`8 17179869184${projectedRoot}\n`);
      }
      assert(!options.checkOnly, 'check mode cannot inspect or change images, containers or volumes');
      if (command === 'volume' && subcommand === 'inspect') {
        assert.equal(target, volumeName);
        return namedVolume ? ok(JSON.stringify([namedVolume])) : missing('volume', volumeName);
      }
      if (command === 'container' && subcommand === 'inspect') {
        assert([containerId, containerName].includes(target));
        if (healthAnswered) postHealthTimeouts.push(timeout);
        return namedContainer ? ok(JSON.stringify([namedContainer])) : missing('container', target);
      }
      if (command === 'image' && subcommand === 'inspect') {
        assert.equal(target, image);
        return installed ? ok(JSON.stringify([{ Id: imageId, RepoDigests: options.wrongDigest ? [] : [image], Os: 'linux', Architecture: options.imageArch ?? architecture, Config: imageConfig }]))
          : missing('image', image);
      }
      mutations.push(args.slice(2));
      if (command === 'pull') {
        assert.deepEqual(args.slice(2), ['pull', '--platform', `linux/${architecture}`, image]);
        installed = true;
        return ok();
      }
      if (command === 'volume' && subcommand === 'create') {
        assert(args.includes(`${owner}=local-workbench-v1`));
        assert.equal(args.at(-1), volumeName);
        namedVolume = { Name: volumeName, Driver: 'local', Options: null, Labels: { [owner]: 'local-workbench-v1' } };
        return ok(volumeName);
      }
      if (command === 'create') {
        assert(args.includes('--pull=never'));
        assert.equal(args[args.indexOf('--platform') + 1], `linux/${architecture}`);
        assert(args.includes(`type=volume,source=${volumeName},target=${workspace}`));
        assert(args.includes('127.0.0.1::3000'));
        assert(args.includes(`${release}=${image}`));
        for (const variable of emptyProxies) assert(args.includes(variable), `explicitly clear ${variable}`);
        assert.equal(args.at(-1), image);
        namedContainer = {
          Id: containerId, Name: `/${containerName}`, Image: imageId,
          Config: { ...imageConfig, Image: image, Labels: { [owner]: 'local-workbench-v1', [release]: image },
            Env: [...imageConfig.Env, 'STERLING_LISTEN_HOST=0.0.0.0', 'STERLING_PREVIEW_NO_SIGN_IN=accept', ...emptyProxies] },
          Mounts: [{ Type: 'volume', Name: volumeName, Destination: workspace, RW: true }],
          HostConfig: { Privileged: false, NetworkMode: 'bridge', PortBindings: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] } },
          NetworkSettings: { Networks: { bridge: {} }, Ports: null },
          State: { Running: false, Status: 'created' },
        };
        return ok(containerId);
      }
      if (command === 'start') {
        assert.equal(subcommand, containerId);
        namedContainer.State = { Running: true, Status: 'running' };
        namedContainer.NetworkSettings.Ports = { '3000/tcp': [binding] };
        return ok(containerId);
      }
      assert.fail(`unexpected Docker command: ${args.join(' ')}`);
    },
    async statfs(path, statOptions) {
      storageProbes.push([path, statOptions]);
      if (options.storageFailure) throw new Error('untrusted detail');
      return options.storageStats ?? { frsize: 8192n, bsize: 4096n, bavail: 1966080n, bfree: 3000000n };
    },
    async probe(url, timeout) {
      assert(!options.checkOnly, 'check mode cannot probe application health');
      assert.equal(url, endpoint);
      assert(timeout > 0 && timeout <= 3000);
      probes.push(url);
      if (options.changedPort) namedContainer.NetworkSettings.Ports = { '3000/tcp': [{ ...binding, HostPort: '43113' }] };
      if (probes.length === 1 && !options.changedPort) return { status: 503, body: 'starting' };
      healthAnswered = true;
      if (options.healthAnsweredAt !== undefined) now = options.healthAnsweredAt;
      return { status: 200, body: 'ok' };
    },
    now: () => now,
    async sleep(ms) { now += ms; },
  };
  return {
    deps, mutations, probes, postHealthTimeouts, prerequisiteSteps, capacityQueries, storageProbes,
    preventReuse(changes) {
      Object.assign(namedContainer.HostConfig, changes);
      installed = false;
    },
    stop() {
      namedContainer.State = { Running: false, Status: 'exited' };
      namedContainer.NetworkSettings.Ports = null;
    },
  };
}

test('check reports workstation prerequisites in order and never reaches resources', async () => {
  const check = { check: true };
  for (const [arch, platform] of [['x64', 'linux/amd64'], ['arm64', 'linux/arm64']]) {
    const f = fixture({ arch, checkOnly: true, installed: false });
    const [prerequisites, capacity, storage, secretStorage] = (await launchLocalWorkbench(check, f.deps)).split('\n');
    assert.equal(prerequisites, `Workbench prerequisites are ready for ${platform}. A matching approved image is required to start.`);
    assert.equal(capacity, 'Docker reports 8 logical CPUs and 16 GiB total memory.');
    assert.equal(storage, availableStorage);
    assert.match(secretStorage, /no local keyring or organization secret store/);
    assert.match(secretStorage, /saved credentials and active Standing Orders are unavailable/i);
    assert.match(secretStorage, /you can still use Workbench features/i);
    assert.match(secretStorage, /ask your administrator/i);
    assert.deepEqual(f.prerequisiteSteps, ['client', 'socket', 'engine', 'capacity']);
    assert.deepEqual(f.capacityQueries, [['info', '--format', '{{.NCPU}} {{.MemTotal}}\n{{json .DockerRootDir}}']]);
    assert.deepEqual(f.storageProbes, [[dockerRoot, { bigint: true }]]);
  }

  for (const capacityResult of [
    { code: 1, stdout: '8 17179869184', stderr: 'untrusted detail' },
    ...['', '0 17179869184', '8 9007199254740992', '8 17179869184 untrusted detail']
      .map((stdout) => ({ code: 0, stdout, stderr: '' })),
  ]) {
    const f = fixture({ checkOnly: true, capacityResult });
    const [prerequisites, capacity, storage] = (await launchLocalWorkbench(check, f.deps)).split('\n');
    assert.match(prerequisites, /prerequisites.*ready.*linux\/amd64.*matching.*image/i);
    assert.equal(capacity, 'Docker CPU and memory readings are unavailable.');
    assert.equal(storage, unavailableStorage);
    assert.deepEqual(f.storageProbes, []);
  }

  for (const [options, expected, steps] of [
    [{ platform: 'darwin', arch: 'arm64' }, /darwin.*arm64.*Linux x86-64/i, []],
    [{ nodeVersion: '24.22.2' }, /Node 26\.13\.1/i, []],
    [{ env: { DOCKER_CONTEXT: 'remote' } }, /local Docker/i, []],
    [{ clientError: 'ENOENT' }, /Docker CLI.*missing/i, ['client']],
    [{ clientError: 1 }, /Docker CLI.*could not run/i, ['client']],
    [{ noSocket: true }, /install.*start.*Docker/i, ['client', 'socket']],
    [{ socketDenied: true }, /socket.*access.*denied|access.*socket.*denied/i, ['client', 'socket']],
    [{ engineError: 'permission denied: untrusted detail' }, /socket.*access.*denied|access.*socket.*denied/i, ['client', 'socket', 'engine']],
    [{ engineError: 'untrusted detail' }, /Docker daemon.*unavailable/i, ['client', 'socket', 'engine']],
    [{ engineVersion: '27.9.1' }, /Docker server 28\.0\.0/i, ['client', 'socket', 'engine']],
    [{ engineArch: 'arm64' }, /Linux amd64 Docker server/i, ['client', 'socket', 'engine']],
  ]) {
    const f = fixture({ ...options, checkOnly: true });
    await assert.rejects(launchLocalWorkbench(check, f.deps), (error) => {
      assert.match(error.message, expected);
      assert.doesNotMatch(error.message, /untrusted detail/);
      return true;
    });
    assert.deepEqual(f.prerequisiteSteps, steps);
  }
  for (const flags of [{ image }, { repair: true }]) {
    const f = fixture({ checkOnly: true });
    await assert.rejects(launchLocalWorkbench({ ...check, ...flags }, f.deps), /--check.*--image.*--repair/);
    assert.deepEqual(f.prerequisiteSteps, []);
  }
});

test('check keeps Docker data-root storage separate from CPU and memory readiness', async () => {
  const check = { check: true };
  const documentedCapacity = 'Docker reports 8 logical CPUs and 16 GiB total memory.';

  for (const [storageStats, expected] of [
    [{ frsize: 8192n, bsize: 4096n, bavail: 0n, bfree: 5n }, /0 GiB available \(0 bytes\)/],
    [{ bsize: 4096n, bavail: 327680n }, /1\.25 GiB available \(1342177280 bytes\)/],
    [{ frsize: 0n, bsize: 1n, bavail: 9007199254740993n }, /8388608 GiB available \(9007199254740993 bytes\)/],
    [{ frsize: -1n, bsize: 4096n, bavail: 1n }, /Docker data-root filesystem space is unavailable\./],
    [{ frsize: 4096n, bavail: -1n }, /Docker data-root filesystem space is unavailable\./],
    [{ bsize: 0n, bavail: 1n }, /Docker data-root filesystem space is unavailable\./],
  ]) {
    const f = fixture({ checkOnly: true, storageStats });
    const [, capacity, storage] = (await launchLocalWorkbench(check, f.deps)).split('\n');
    assert.equal(capacity, documentedCapacity);
    assert.match(storage, expected);
    assert.deepEqual(f.storageProbes, [[dockerRoot, { bigint: true }]]);
  }

  for (const result of ['', 'null', '"/wrong', '"relative/path"', JSON.stringify('/bad\npath')]) {
    const f = fixture({ checkOnly: true, capacityResult: { code: 0, stdout: `8 17179869184\n${result}` } });
    const [, capacity, storage] = (await launchLocalWorkbench(check, f.deps)).split('\n');
    assert.equal(capacity, documentedCapacity);
    assert.equal(storage, unavailableStorage);
    assert.deepEqual(f.storageProbes, []);
  }

  for (const cpuAndMemory of ['0 17179869184', '']) {
    const missingCapacity = fixture({
      checkOnly: true,
      capacityResult: { code: 0, stdout: `${cpuAndMemory}\n${JSON.stringify(dockerRoot)}\n` },
    });
    const [, capacity, storage] = (await launchLocalWorkbench(check, missingCapacity.deps)).split('\n');
    assert.equal(capacity, 'Docker CPU and memory readings are unavailable.');
    assert.equal(storage, availableStorage);
  }

  for (const missingProbe of [false, true]) {
    const f = fixture({ checkOnly: true, storageFailure: true });
    if (missingProbe) f.deps.statfs = undefined;
    const output = await launchLocalWorkbench(check, f.deps);
    assert.equal(output.split('\n')[1], documentedCapacity);
    assert.equal(output.split('\n')[2], unavailableStorage);
    assert.doesNotMatch(output, /untrusted detail/);
  }
});

test('local Workbench preflights, uses the approved release, and retries its own workspace', async (t) => {
  await t.test('first launch, healthy retry and stopped-container retry preserve identity and storage', async () => {
    const f = fixture();
    assert.equal(await launchLocalWorkbench({ image }, f.deps), launched);
    assert.deepEqual(f.probes, [endpoint, endpoint]);
    assert.deepEqual(f.prerequisiteSteps, ['client', 'socket', 'engine']);
    assert.equal(await launchLocalWorkbench({ image }, f.deps), launched);
    assert.deepEqual(f.mutations.map(([command]) => command), ['volume', 'create', 'start']);
    f.stop();
    assert.equal(await launchLocalWorkbench({ image }, f.deps), launched);
    assert.deepEqual(f.mutations.map(([command]) => command), ['volume', 'create', 'start', 'start']);
    assert.deepEqual(f.storageProbes, []);
  });

  await t.test('invalid host, daemon, or existing resources refuse before optional repair', async () => {
    const scenarios = [
      [{ arch: 'arm' }, /Linux.*(?:x86-64|amd64)/i],
      [{ engineVersion: '27.5.1' }, /28\.0\.0/],
      [{ engineVersion: 'unknown' }, /28\.0\.0/],
      [{ env: { DOCKER_HOST: 'ssh://foreign.invalid' } }, /local Docker/i],
      [{ volume: { Name: volumeName, Driver: 'local', Labels: {} } }, /volume/i],
      [{ container: { Name: `/${containerName}`, Config: { Image: 'unowned:tag', Labels: {} } } }, /container/i],
      [{ missStdout: '[{"Id":"unexpected"}]' }, /inspect/i],
    ];
    for (const [options, error] of scenarios) {
      const f = fixture({ ...options, installed: false });
      await assert.rejects(launchLocalWorkbench({ image, repair: true }, f.deps), error);
      assert.deepEqual(f.mutations, []);
    }
    for (const capability of [
      { PidMode: 'host' }, { IpcMode: 'host' }, { UTSMode: 'host' }, { UsernsMode: 'host' },
      { Devices: [{ PathOnHost: '/dev/test' }] }, { DeviceRequests: [{}] }, { CapAdd: ['SYS_ADMIN'] },
      { SecurityOpt: ['seccomp=unconfined'] }, { Binds: [`${volumeName}:${workspace}`] },
    ]) {
      const f = fixture();
      await launchLocalWorkbench({ image }, f.deps);
      const previous = f.mutations.length;
      f.preventReuse(capability);
      await assert.rejects(launchLocalWorkbench({ image, repair: true }, f.deps), /container/i);
      assert.equal(f.mutations.length, previous);
    }
  });

  await t.test('only an explicit exact-digest repair can acquire a missing image', async () => {
    const absent = fixture({ installed: false });
    await assert.rejects(launchLocalWorkbench({ image }, absent.deps), /image.*missing/i);
    assert.deepEqual(absent.mutations, []);
    const repair = fixture({ installed: false });
    assert.equal(await launchLocalWorkbench({ image, repair: true }, repair.deps), launched);
    assert.deepEqual(repair.mutations.map(([command]) => command), ['pull', 'volume', 'create', 'start']);
    assert.deepEqual(repair.storageProbes, []);
    const wrong = fixture({ installed: false, wrongDigest: true });
    await assert.rejects(launchLocalWorkbench({ image, repair: true }, wrong.deps), /image.*digest/i);
    assert.deepEqual(wrong.mutations.map(([command]) => command), ['pull']);
  });

  await t.test('Linux ARM64 starts and retries natively and refuses mismatched engines or images', async () => {
    const workstation = fixture({ arch: 'arm64', installed: false });
    assert.equal(await launchLocalWorkbench({ image, repair: true }, workstation.deps), launched);
    assert.equal(await launchLocalWorkbench({ image }, workstation.deps), launched);
    assert.deepEqual(workstation.mutations.map(([command]) => command), ['pull', 'volume', 'create', 'start']);

    const wrongEngine = fixture({ arch: 'arm64', engineArch: 'amd64', installed: false });
    await assert.rejects(launchLocalWorkbench({ image, repair: true }, wrongEngine.deps), /Linux arm64 Docker server/i);
    assert.deepEqual(wrongEngine.mutations, []);

    const wrongImage = fixture({ arch: 'arm64', imageArch: 'amd64' });
    await assert.rejects(launchLocalWorkbench({ image, repair: true }, wrongImage.deps), /linux\/arm64/i);
    assert.deepEqual(wrongImage.mutations, []);
  });

  await t.test('health on a port that changed during its probe never reports ready', async () => {
    const f = fixture({ changedPort: true });
    await assert.rejects(launchLocalWorkbench({ image }, f.deps), /publication.*changed/i);
    assert.equal(f.probes.length, 1);
    assert.deepEqual(f.mutations.map(([command]) => command), ['volume', 'create', 'start']);
    const nearDeadline = fixture({ healthAnsweredAt: 119_995 });
    assert.equal(await launchLocalWorkbench({ image }, nearDeadline.deps), launched);
    assert.deepEqual(nearDeadline.postHealthTimeouts, [5]);
    const expired = fixture({ healthAnsweredAt: 120_000 });
    await assert.rejects(launchLocalWorkbench({ image }, expired.deps), /health.*time/i);
    assert.deepEqual(expired.postHealthTimeouts, []);
  });
});
