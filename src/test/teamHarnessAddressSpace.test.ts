// The team test harness keeps a test process inside the address-space cap the tests run under (ulimit -v 6000000 with a 1536 MB heap).
// Node's fetch creates undici's llhttp WebAssembly parser on its first connection, and V8 reserves the whole growth range of a wasm memory up front:
// 4 GiB of address space with nothing behind it unless the page limit is lowered. Under the cap that left about 270 MB for the heap, and
// teamBoardView.test.js died at its 18th test with "Committing semi space failed ... heap out of memory" while its heap held under 50 MB
// (.planning/debug/team-board-view-test-oom.md). Every rig-based test file talks to the fake NEAR server with fetch, so each one paid it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import './helpers/teamHarness';

const MIB = 1024 * 1024;

interface Mapping { size: number; perms: string; name: string }

/** The address ranges this process has mapped or reserved, from /proc/self/maps. */
function mappings(): Mapping[] {
  return readFileSync('/proc/self/maps', 'utf8').trim().split('\n').map((line) => {
    const [range = '', perms = '', , , , name = ''] = line.split(/\s+/);
    const [start = '0', end = '0'] = range.split('-');
    return { size: Number(BigInt(`0x${end}`) - BigInt(`0x${start}`)), perms, name };
  });
}

const label = (mapping: Mapping): string => `${(mapping.size / MIB).toFixed(0)} MiB ${mapping.perms} ${mapping.name}`.trim();

// V8 only gives up its 8 GiB guard region for wasm memory (and so shows no large reservation) when an address-space limit is in force, so the check
// has to run under the cap it protects. A run of the suite without `ulimit -v` (the memory cap there is a cgroup) would otherwise report the guard
// region and fail for a reason that costs nothing. The test therefore runs its own check in a child process started under the documented cap.
const CHILD_FLAG = 'NEAR_AI_ADDRESS_SPACE_CHILD';
const ADDRESS_SPACE_CAP_KB = 6_000_000;

test('a team test process reserves no single range of 1 GiB or more after its first fetch, so the address-space cap is left to the heap', { skip: process.platform !== 'linux' }, async () => {
  if (process.env[CHILD_FLAG] !== '1') {
    const child = spawnSync('sh', ['-c', `ulimit -v ${ADDRESS_SPACE_CAP_KB} && exec "$0" "$@"`, process.execPath, __filename], {
      encoding: 'utf8', env: { ...process.env, [CHILD_FLAG]: '1' }, timeout: 60_000
    });
    assert.equal(child.status, 0, `the check failed under ulimit -v ${ADDRESS_SPACE_CAP_KB}:\n${child.stdout}\n${child.stderr}`);
    return;
  }
  const server = createServer((_request, response) => { response.end('x'.repeat(4 * MIB)); });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
    assert.equal((await response.text()).length, 4 * MIB, 'the parser still reads a large response');
  } finally {
    await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
  }
  const largest = mappings().sort((a, b) => b.size - a.size).slice(0, 4);
  assert.ok((largest[0]?.size ?? 0) < 1024 * MIB, `the largest reservations are ${largest.map(label).join(', ')}`);
});
