// The workbench's outbound recording hook (46-03; 46-08 reuses it). Test tooling only: it is mounted read-only into a container at run time
// and loaded with NODE_OPTIONS=--import, which the backend's forked children (the plugin host) inherit; it never enters the image.
//
// It wraps every client network API Node offers, as hub/test/noOutbound.test.ts does: net.Socket.prototype.connect (net.connect and every
// http request end there), tls.connect (https), dns.lookup and dns.promises.lookup, dgram.createSocket and the global fetch. Unlike the hub's
// hook it lets a call through when its host (and port, when the entry names one) is in NEAR_AI_TEST_OUTBOUND_ALLOW, a comma list of `host`
// or `host:port` (`[::1]:8200` for an IPv6 host and port), or when it goes to a path (IPC). Every attempt appends one line to the file named
// by NEAR_AI_TEST_OUTBOUND_LOG: `allowed <kind> <target>` or `refused <kind> <target>`; a refused call fails with code NEAR_AI_TEST_OUTBOUND.
// A lookup of an address literal is passed through unlogged: Node answers it without a query, and a server's listen() asks for one. UDP has
// no target when the socket is made, so every dgram socket is refused.
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import dgram from 'node:dgram';
import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';

const file = process.env.NEAR_AI_TEST_OUTBOUND_LOG;
const allow = (process.env.NEAR_AI_TEST_OUTBOUND_ALLOW ?? '').split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean).map((entry) => {
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry);
  if (bracketed) return { host: bracketed[1], port: bracketed[2] };
  const hostPort = /^([^:]+):(\d+)$/.exec(entry);
  if (hostPort) return { host: hostPort[1], port: hostPort[2] };
  return { host: entry, port: undefined };
});

const bare = (host) => String(host).toLowerCase().replace(/^\[|\]$/g, '');
const allowed = (host, port) => allow.some((entry) => entry.host === bare(host) && (entry.port === undefined || entry.port === String(port ?? '')));
const record = (verdict, kind, target) => {
  if (file) appendFileSync(file, `${verdict} ${kind} ${target}\n`);
};
const refuse = (kind, target) => {
  record('refused', kind, target);
  const error = new Error(`outbound ${kind} refused by the test hook`);
  error.code = 'NEAR_AI_TEST_OUTBOUND';
  return error;
};

/** The target of a connect call: { path } for IPC, otherwise { host, port }. */
const targetOf = (args) => {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  if (first !== null && typeof first === 'object') {
    if (typeof first.path === 'string') return { path: first.path };
    return { host: String(first.host ?? first.hostname ?? 'localhost'), port: first.port };
  }
  if (typeof first === 'number' || /^[0-9]+$/.test(String(first))) return { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: first };
  return { path: String(first) };
};
const shown = (target) => (target.path !== undefined ? `path:${target.path}` : net.isIPv6(bare(target.host)) ? `[${bare(target.host)}]:${target.port ?? ''}` : `${target.host}:${target.port ?? ''}`);

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function hookedConnect(...args) {
  const target = targetOf(args);
  if (target.path !== undefined || allowed(target.host, target.port)) {
    record('allowed', 'net', shown(target));
    return connect.apply(this, args);
  }
  throw refuse('net', shown(target));
};
const tlsConnect = tls.connect;
tls.connect = function hookedTlsConnect(...args) {
  const target = targetOf(args);
  if (target.path !== undefined || allowed(target.host, target.port)) {
    record('allowed', 'tls', shown(target));
    return tlsConnect.apply(this, args);
  }
  throw refuse('tls', shown(target));
};
const lookup = dns.lookup;
dns.lookup = function hookedLookup(host, ...rest) {
  if (net.isIP(String(host)) !== 0) return lookup.call(this, host, ...rest);
  if (allowed(host)) {
    record('allowed', 'dns', String(host));
    return lookup.call(this, host, ...rest);
  }
  throw refuse('dns', String(host));
};
const promisesLookup = dns.promises.lookup;
dns.promises.lookup = function hookedPromisesLookup(host, ...rest) {
  if (net.isIP(String(host)) !== 0) return promisesLookup.call(this, host, ...rest);
  if (allowed(host)) {
    record('allowed', 'dns', String(host));
    return promisesLookup.call(this, host, ...rest);
  }
  return Promise.reject(refuse('dns', String(host)));
};
dgram.createSocket = function hookedCreateSocket(type) {
  throw refuse('udp', typeof type === 'string' ? type : String(type?.type));
};
const realFetch = globalThis.fetch;
globalThis.fetch = async function hookedFetch(input, init) {
  const href = String(input?.url ?? input);
  let url;
  try { url = new URL(href); } catch { url = undefined; }
  const network = url !== undefined && (url.protocol === 'http:' || url.protocol === 'https:');
  if (!network || allowed(url.hostname, url.port || (url.protocol === 'https:' ? '443' : '80'))) {
    record('allowed', 'fetch', href);
    return realFetch(input, init);
  }
  throw refuse('fetch', href);
};
syncBuiltinESMExports();
