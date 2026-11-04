// Test-only window sizing (Phase 62 plan 22): under Xvfb there is no window manager, so VS Code's "maximized" setting has no effect and the test window
// stays at its 1440 by 900 default on a 1920 by 1080 hidden screen (62-21). Without a window manager the X server applies a ConfigureWindow request from
// any client directly, so this module speaks just enough of the X11 protocol, with Node built-ins only (no program is installed and no dependency is
// added), to move the test window to the screen's corner and give it the whole screen.
//
// Only a local display (":N" or "unix:N", the one xvfb-run made) is ever used; the authorization cookie is read from XAUTHORITY and never logged.
// Protocol: the client sends a little-endian connection setup, then requests of 4-byte units; the server answers with 32-byte packets: replies (first
// byte 1, plus 4 * length more bytes), errors (first byte 0) and events (anything else).
import { readFile } from 'node:fs/promises';
import * as net from 'node:net';

/** One entry of an Xauthority file: every field is a big-endian 16-bit length and that many bytes. */
export interface XAuthEntry { family: number; address: Buffer; display: string; name: string; data: Buffer }

export interface Box { x: number; y: number; width: number; height: number }

/** What fillScreen changed: the screen, and the test window before and after. */
export interface FillResult { screen: { width: number; height: number }; window: number; before: Box; after: Box }

const COOKIE = 'MIT-MAGIC-COOKIE-1';
const FAMILY_WILD = 65535;
const TIMEOUT_MS = 5_000;
// The X opcodes this module sends.
const GET_WINDOW_ATTRIBUTES = 3;
const CONFIGURE_WINDOW = 12;
const GET_GEOMETRY = 14;
const QUERY_TREE = 15;
const VIEWABLE = 2;
const INPUT_OUTPUT = 1;

const pad4 = (n: number): number => (4 - (n % 4)) % 4;

export function parseXauthority(file: Buffer): XAuthEntry[] {
  const entries: XAuthEntry[] = [];
  let at = 0;
  const field = (): Buffer => {
    if (at + 2 > file.length) throw new Error('The Xauthority file ends inside an entry');
    const length = file.readUInt16BE(at);
    if (at + 2 + length > file.length) throw new Error('The Xauthority file ends inside an entry');
    const value = file.subarray(at + 2, at + 2 + length);
    at += 2 + length;
    return value;
  };
  while (at < file.length) {
    if (at + 2 > file.length) throw new Error('The Xauthority file ends inside an entry');
    const family = file.readUInt16BE(at);
    at += 2;
    const address = field();
    const display = field().toString('latin1');
    const name = field().toString('latin1');
    const data = field();
    entries.push({ family, address, display, name, data });
  }
  return entries;
}

/** The display number of a local display (":99", ":99.0", "unix:99"); anything else (a host name, a TCP display) is refused. */
export function localDisplay(display: string | undefined): string {
  const m = /^(?:unix)?:(\d+)(?:\.\d+)?$/.exec(display ?? '');
  if (m === null) throw new Error(`Only a local X display is used, and DISPLAY is ${display === undefined || display === '' ? 'not set' : `"${display}"`}`);
  return m[1];
}

/** The cookie for this display: its own MIT-MAGIC-COOKIE-1 entry, else a wildcard entry; none when the file has neither. */
export function cookieFor(entries: XAuthEntry[], displayNumber: string): { name: string; data: Buffer } | undefined {
  const own = entries.find((e) => e.name === COOKIE && e.display === displayNumber) ?? entries.find((e) => e.name === COOKIE && e.family === FAMILY_WILD);
  return own === undefined ? undefined : { name: own.name, data: own.data };
}

export function setupRequest(auth?: { name: string; data: Buffer }): Buffer {
  const name = Buffer.from(auth?.name ?? '', 'latin1');
  const data = auth?.data ?? Buffer.alloc(0);
  const out = Buffer.alloc(12 + name.length + pad4(name.length) + data.length + pad4(data.length));
  out[0] = 0x6c; // 'l': every number in both directions is least significant byte first
  out.writeUInt16LE(11, 2);
  out.writeUInt16LE(0, 4);
  out.writeUInt16LE(name.length, 6);
  out.writeUInt16LE(data.length, 8);
  name.copy(out, 12);
  data.copy(out, 12 + name.length + pad4(name.length));
  return out;
}

/** The setup reply's length in bytes once its 8-byte head is in, or undefined before that. */
function setupLength(buffer: Buffer): number | undefined {
  return buffer.length < 8 ? undefined : 8 + buffer.readUInt16LE(6) * 4;
}

/** The first screen's root window and size from a whole setup reply; a refused setup throws with the server's reason. */
export function parseSetup(reply: Buffer): { root: number; width: number; height: number } {
  const status = reply[0];
  if (status !== 1) {
    const reason = status === 0 ? reply.subarray(8, 8 + reply[1]).toString('latin1') : 'the server asks for more authentication';
    throw new Error(`The X server refused the connection: ${reason}`);
  }
  const vendor = reply.readUInt16LE(24);
  const screens = reply[28];
  const formats = reply[29];
  if (screens < 1) throw new Error('The X server has no screen');
  const at = 40 + vendor + pad4(vendor) + formats * 8;
  if (at + 24 > reply.length) throw new Error('The X server\'s setup reply is shorter than its first screen');
  return { root: reply.readUInt32LE(at), width: reply.readUInt16LE(at + 20), height: reply.readUInt16LE(at + 22) };
}

function windowRequest(opcode: number, window: number): Buffer {
  const out = Buffer.alloc(8);
  out[0] = opcode;
  out.writeUInt16LE(2, 2);
  out.writeUInt32LE(window, 4);
  return out;
}
export const queryTreeRequest = (window: number): Buffer => windowRequest(QUERY_TREE, window);
export const getGeometryRequest = (window: number): Buffer => windowRequest(GET_GEOMETRY, window);
export const getWindowAttributesRequest = (window: number): Buffer => windowRequest(GET_WINDOW_ATTRIBUTES, window);

/** ConfigureWindow with x, y, width and height (value mask 0xf, one 32-bit value each). */
export function configureWindowRequest(window: number, box: Box): Buffer {
  const out = Buffer.alloc(28);
  out[0] = CONFIGURE_WINDOW;
  out.writeUInt16LE(7, 2);
  out.writeUInt32LE(window, 4);
  out.writeUInt16LE(0xf, 8);
  out.writeInt32LE(box.x, 12);
  out.writeInt32LE(box.y, 16);
  out.writeUInt32LE(box.width, 20);
  out.writeUInt32LE(box.height, 24);
  return out;
}

export const parseQueryTree = (reply: Buffer): number[] => Array.from({ length: reply.readUInt16LE(16) }, (_, i) => reply.readUInt32LE(32 + i * 4));
export const parseGeometry = (reply: Buffer): Box => ({ x: reply.readInt16LE(12), y: reply.readInt16LE(14), width: reply.readUInt16LE(16), height: reply.readUInt16LE(18) });
export const parseAttributes = (reply: Buffer): { inputOutput: boolean; viewable: boolean; overrideRedirect: boolean } =>
  ({ inputOutput: reply.readUInt16LE(12) === INPUT_OUTPUT, viewable: reply[26] === VIEWABLE, overrideRedirect: reply[27] === 1 });

/** One connection to the X server; requests go one batch at a time and the batch's last request must have a reply. */
class Connection {
  private buffer = Buffer.alloc(0);
  private wake: (() => void) | undefined;
  private failure: Error | undefined;
  private sequence = 0;
  private constructor(private readonly socket: net.Socket) {
    socket.on('data', (chunk: Buffer) => { this.buffer = Buffer.concat([this.buffer, chunk]); this.wake?.(); });
    socket.on('error', (error) => { this.failure = error; this.wake?.(); });
    socket.on('close', () => { this.failure ??= new Error('The X server closed the connection'); this.wake?.(); });
  }

  public static async open(socketPath: string): Promise<Connection> {
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect(socketPath);
      const timer = setTimeout(() => { s.destroy(); reject(new Error(`No X server answered on ${socketPath}`)); }, TIMEOUT_MS);
      s.once('connect', () => { clearTimeout(timer); resolve(s); });
      s.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
    return new Connection(socket);
  }

  /** Waits until `length(buffer)` says enough bytes are in, then takes them. */
  private async take(length: (buffer: Buffer) => number | undefined): Promise<Buffer> {
    const deadline = Date.now() + TIMEOUT_MS;
    for (;;) {
      const n = length(this.buffer);
      if (n !== undefined && this.buffer.length >= n) { const out = this.buffer.subarray(0, n); this.buffer = this.buffer.subarray(n); return out; }
      if (this.failure !== undefined) throw this.failure;
      if (Date.now() > deadline) throw new Error('The X server did not answer in time');
      await new Promise<void>((resolve) => { this.wake = resolve; setTimeout(resolve, 100); });
      this.wake = undefined;
    }
  }

  public async setup(auth?: { name: string; data: Buffer }): Promise<{ root: number; width: number; height: number }> {
    this.socket.write(setupRequest(auth));
    return parseSetup(await this.take(setupLength));
  }

  /** Sends the requests and returns the reply to the last one; an error for any of them throws. */
  public async batch(requests: Buffer[]): Promise<Buffer> {
    for (const request of requests) this.socket.write(request);
    this.sequence = (this.sequence + requests.length) & 0xffff;
    const last = this.sequence;
    for (;;) {
      const packet = await this.take((b) => (b.length < 32 ? undefined : b[0] === 1 ? 32 + b.readUInt32LE(4) * 4 : 32));
      if (packet[0] === 0) throw new Error(`The X server refused request ${packet[10]} (error ${packet[1]})`);
      if (packet[0] === 1 && packet.readUInt16LE(2) === last) return packet;
    }
  }

  public close(): void { this.socket.destroy(); }
}

/**
 * Moves the largest shown top-level window (the test's VS Code window; without a window manager it is a child of the root) to the screen's top left
 * corner and gives it the whole screen, then reads its size back from the server.
 */
export async function fillScreen(options: { display?: string; xauthority?: string; socketPath?: string } = {}): Promise<FillResult> {
  // RED stub (62-22): nothing is sized yet.
  void options; void Connection;
  const none = { x: 0, y: 0, width: 0, height: 0 };
  return { screen: { width: 0, height: 0 }, window: 0, before: none, after: none };
}
