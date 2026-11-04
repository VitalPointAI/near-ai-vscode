// The test window sizer (Phase 62 plan 22): under Xvfb there is no window manager, so the e2e gives the VS Code window the whole hidden screen itself,
// with a few X11 requests. These tests run it against a fake X server on a local socket that answers like Xvfb, then against a real Xvfb when one is
// installed (a real handshake and window tree).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { configureWindowRequest, cookieFor, fillScreen, localDisplay, parseXauthority, setupRequest, type Box } from './e2e/x11Window';

const COOKIE = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');

/** One Xauthority entry: family, then address, display number, name and data, each with a big-endian 16-bit length. */
function authEntry(family: number, address: string, display: string, name: string, data: Buffer): Buffer {
  const field = (value: Buffer): Buffer => { const head = Buffer.alloc(2); head.writeUInt16BE(value.length); return Buffer.concat([head, value]); };
  const head = Buffer.alloc(2);
  head.writeUInt16BE(family);
  return Buffer.concat([head, field(Buffer.from(address)), field(Buffer.from(display)), field(Buffer.from(name)), field(data)]);
}

interface FakeWindow { id: number; box: Box; viewable: boolean; overrideRedirect?: boolean }

/** A fake X server: checks the setup's cookie, then answers QueryTree, GetWindowAttributes, GetGeometry and applies ConfigureWindow, like Xvfb. */
async function fakeServer(socketPath: string, windows: FakeWindow[], screen = { width: 1920, height: 1080 }): Promise<{ server: net.Server; configured: Array<{ id: number; box: Box }>; refuse?: string }> {
  const ROOT = 0x100;
  const configured: Array<{ id: number; box: Box }> = [];
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let ready = false;
    let sequence = 0;
    const reply = (extra: Buffer, byte1 = 0): void => {
      const head = Buffer.alloc(32);
      head[0] = 1; head[1] = byte1; head.writeUInt16LE(sequence, 2);
      const body = extra.length > 24 ? extra.subarray(24) : Buffer.alloc(0);
      head.writeUInt32LE(body.length / 4, 4);
      extra.subarray(0, 24).copy(head, 8);
      socket.write(Buffer.concat([head, body]));
    };
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!ready) {
        if (buffer.length < 12) return;
        const n = buffer.readUInt16LE(6); const d = buffer.readUInt16LE(8);
        const total = 12 + n + ((4 - (n % 4)) % 4) + d + ((4 - (d % 4)) % 4);
        if (buffer.length < total) return;
        const name = buffer.subarray(12, 12 + n).toString('latin1');
        const data = buffer.subarray(12 + n + ((4 - (n % 4)) % 4), 12 + n + ((4 - (n % 4)) % 4) + d);
        buffer = buffer.subarray(total);
        if (name !== 'MIT-MAGIC-COOKIE-1' || !data.equals(COOKIE)) {
          const reason = Buffer.from('Authorization required, but no authorization protocol specified\n');
          const out = Buffer.alloc(8 + reason.length + ((4 - (reason.length % 4)) % 4));
          out[0] = 0; out[1] = reason.length; out.writeUInt16LE(11, 2); out.writeUInt16LE((out.length - 8) / 4, 6);
          reason.copy(out, 8);
          socket.end(out);
          return;
        }
        // Success: a vendor of 5 bytes (padded to 8), one pixmap format, one screen with its root and size.
        const vendor = Buffer.from('Fake\0\0\0\0');
        const screenBlock = Buffer.alloc(40);
        screenBlock.writeUInt32LE(ROOT, 0);
        screenBlock.writeUInt16LE(screen.width, 20);
        screenBlock.writeUInt16LE(screen.height, 22);
        const body = Buffer.alloc(32);
        body.writeUInt16LE(5, 16); body[20] = 1; body[21] = 1;
        const data2 = Buffer.concat([body, vendor, Buffer.alloc(8), screenBlock]);
        const head = Buffer.alloc(8);
        head[0] = 1; head.writeUInt16LE(11, 2); head.writeUInt16LE(data2.length / 4, 6);
        socket.write(Buffer.concat([head, data2]));
        ready = true;
      }
      while (buffer.length >= 4) {
        const length = buffer.readUInt16LE(2) * 4;
        if (buffer.length < length) return;
        const request = buffer.subarray(0, length);
        buffer = buffer.subarray(length);
        sequence = (sequence + 1) & 0xffff;
        const window = request.readUInt32LE(4);
        const found = windows.find((w) => w.id === window);
        if (request[0] === 15) {
          const ids = window === ROOT ? windows.map((w) => w.id) : [];
          const extra = Buffer.alloc(24 + ids.length * 4);
          extra.writeUInt32LE(ROOT, 0); extra.writeUInt16LE(ids.length, 8);
          ids.forEach((id, i) => extra.writeUInt32LE(id, 24 + i * 4));
          reply(extra);
        } else if (request[0] === 3) {
          const extra = Buffer.alloc(36);
          extra.writeUInt16LE(1, 4); extra[18] = found?.viewable === true ? 2 : 0; extra[19] = found?.overrideRedirect === true ? 1 : 0;
          reply(extra);
        } else if (request[0] === 14) {
          const box = found?.box ?? { x: 0, y: 0, width: screen.width, height: screen.height };
          const extra = Buffer.alloc(24);
          extra.writeUInt32LE(ROOT, 0); extra.writeInt16LE(box.x, 4); extra.writeInt16LE(box.y, 6); extra.writeUInt16LE(box.width, 8); extra.writeUInt16LE(box.height, 10);
          reply(extra, 24);
        } else if (request[0] === 12 && found !== undefined) {
          assert.equal(request.readUInt16LE(8), 0xf, 'x, y, width and height are set');
          found.box = { x: request.readInt32LE(12), y: request.readInt32LE(16), width: request.readUInt32LE(20), height: request.readUInt32LE(24) };
          configured.push({ id: found.id, box: { ...found.box } });
        } else {
          const error = Buffer.alloc(32);
          error[0] = 0; error[1] = 3; error.writeUInt16LE(sequence, 2); error[10] = request[0];
          socket.write(error);
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return { server, configured };
}

test('an Xauthority file is read entry by entry, and the cookie for the display is chosen (62-22)', () => {
  const file = Buffer.concat([
    authEntry(256, 'host', '7', 'MIT-MAGIC-COOKIE-1', Buffer.from('aa', 'hex')),
    authEntry(256, 'host', '99', 'MIT-MAGIC-COOKIE-1', COOKIE),
  ]);
  const entries = parseXauthority(file);
  assert.equal(entries.length, 2);
  assert.deepEqual(cookieFor(entries, '99'), { name: 'MIT-MAGIC-COOKIE-1', data: COOKIE });
  assert.equal(cookieFor(entries, '5'), undefined, 'no entry for another display');
  assert.deepEqual(cookieFor([...entries, ...parseXauthority(authEntry(65535, '', '', 'MIT-MAGIC-COOKIE-1', COOKIE))], '5')?.data, COOKIE, 'a wildcard entry serves any display');
  assert.throws(() => parseXauthority(file.subarray(0, file.length - 3)), /ends inside an entry/);
});

test('only a local display is used: ":99", ":99.0" and "unix:99" are display 99, a host name or no DISPLAY is refused (62-22)', () => {
  assert.equal(localDisplay(':99'), '99');
  assert.equal(localDisplay(':99.0'), '99');
  assert.equal(localDisplay('unix:99'), '99');
  assert.throws(() => localDisplay('example.invalid:0'), /Only a local X display/);
  assert.throws(() => localDisplay(undefined), /not set/);
});

test('the setup and ConfigureWindow requests are laid out as the X11 protocol says (62-22)', () => {
  const setup = setupRequest({ name: 'MIT-MAGIC-COOKIE-1', data: COOKIE });
  assert.equal(setup[0], 0x6c, 'least significant byte first');
  assert.equal(setup.readUInt16LE(2), 11);
  assert.equal(setup.readUInt16LE(6), 18);
  assert.equal(setup.readUInt16LE(8), 16);
  assert.equal(setup.length, 12 + 20 + 16, 'name and data each padded to 4 bytes');
  const configure = configureWindowRequest(0x400001, { x: 0, y: 0, width: 1920, height: 1080 });
  assert.deepEqual([configure[0], configure.readUInt16LE(2), configure.readUInt32LE(4), configure.readUInt16LE(8)], [12, 7, 0x400001, 0xf]);
  assert.deepEqual([configure.readInt32LE(12), configure.readInt32LE(16), configure.readUInt32LE(20), configure.readUInt32LE(24)], [0, 0, 1920, 1080]);
});

test('fillScreen gives the largest shown top-level window the whole screen and leaves hidden and pop-up windows alone (62-22)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-x11-'));
  const socketPath = path.join(dir, 'X99');
  const xauthority = path.join(dir, 'Xauthority');
  await writeFile(xauthority, authEntry(256, 'host', '99', 'MIT-MAGIC-COOKIE-1', COOKIE));
  const fake = await fakeServer(socketPath, [
    { id: 0x200001, box: { x: 0, y: 0, width: 10, height: 10 }, viewable: true, overrideRedirect: true },
    { id: 0x400001, box: { x: 240, y: 90, width: 1440, height: 900 }, viewable: true },
    { id: 0x500001, box: { x: 0, y: 0, width: 1920, height: 1080 }, viewable: false },
    { id: 0x600001, box: { x: 5, y: 5, width: 300, height: 200 }, viewable: true },
  ]);
  try {
    const result = await fillScreen({ display: ':99', xauthority, socketPath });
    assert.deepEqual(result, { screen: { width: 1920, height: 1080 }, window: 0x400001, before: { x: 240, y: 90, width: 1440, height: 900 }, after: { x: 0, y: 0, width: 1920, height: 1080 } });
    assert.deepEqual(fake.configured, [{ id: 0x400001, box: { x: 0, y: 0, width: 1920, height: 1080 } }], 'only the test window is changed');
  } finally {
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('fillScreen says why when the server refuses the cookie, and when no window is shown (62-22)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-x11-'));
  const socketPath = path.join(dir, 'X98');
  const wrong = path.join(dir, 'wrong');
  const right = path.join(dir, 'right');
  await writeFile(wrong, authEntry(256, 'host', '98', 'MIT-MAGIC-COOKIE-1', Buffer.alloc(16)));
  await writeFile(right, authEntry(256, 'host', '98', 'MIT-MAGIC-COOKIE-1', COOKIE));
  const fake = await fakeServer(socketPath, [{ id: 0x500001, box: { x: 0, y: 0, width: 800, height: 600 }, viewable: false }]);
  try {
    await assert.rejects(fillScreen({ display: ':98', xauthority: wrong, socketPath }), /refused the connection: Authorization required/);
    await assert.rejects(fillScreen({ display: ':98', xauthority: right, socketPath }), /shows no window to size \(1 top-level windows, none shown\)/);
    assert.deepEqual(fake.configured, []);
  } finally {
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

const hasXvfb = spawnSync('sh', ['-c', 'command -v Xvfb'], { encoding: 'utf8' }).status === 0;

test('against a real Xvfb the handshake and window tree work: the screen size is read and an empty screen is reported, not guessed (62-22)', { skip: hasXvfb ? false : 'Xvfb is not installed' }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-x11-real-'));
  const display = `:${4000 + (process.pid % 1000)}`;
  const xvfb = spawn('Xvfb', [display, '-screen', '0', '1024x768x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
  try {
    const socket = `/tmp/.X11-unix/X${display.slice(1)}`;
    for (let i = 0; i < 50 && !existsSync(socket); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    await assert.rejects(fillScreen({ display, xauthority: '' }), /shows no window to size \(0 top-level windows, none shown\)/);
  } finally {
    xvfb.kill();
    await rm(dir, { recursive: true, force: true });
  }
});
