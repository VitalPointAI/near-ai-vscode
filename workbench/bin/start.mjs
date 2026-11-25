#!/usr/bin/env node
// Starts the Sterling workbench backend in this process (the image's ENTRYPOINT), so a SIGTERM to the container reaches Theia's onStop.
//
//   STERLING_LISTEN_HOST          the address Theia listens on; default 127.0.0.1 (D-12). In hosted mode a pod IP (status.podIP) is where
//                                 Theia Cloud's activity tracker reaches the session: Theia then stays on 127.0.0.1 for the oauth2-proxy
//                                 sidecar, and the backend answers only the tracker on the pod IP (extension/src/node/session-activity.ts).
//   STERLING_OPENBAO_ADDR         set in hosted mode (sign-in in front, Phase 47); unset means local mode.
//   STERLING_PREVIEW_NO_SIGN_IN   local mode only: `accept` confirms a non-loopback bind is published on 127.0.0.1 only (the #162 guard).
//
//   STERLING_WORKBENCH            set to 1 here for the backend and every plugin host it starts (Phase 33 D-64): the VS Code extension reads it
//                                 and registers none of its multi-user preview commands, so only the native engine edits shared projects.
//
// Any arguments the image's CMD passes (the release target's session preference) go to Theia after the workspace, host and port.
import net from 'node:net';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const WILDCARD = new Set(['0.0.0.0', '::']);
const host = process.env.STERLING_LISTEN_HOST?.trim() || '127.0.0.1';
const localMode = !process.env.STERLING_OPENBAO_ADDR?.trim();

if (localMode && !LOOPBACK.has(host) && process.env.STERLING_PREVIEW_NO_SIGN_IN !== 'accept') {
  console.error(
    `This local workbench has no sign-in and includes a terminal, and it was asked to listen on ${host}. ` +
      'Publish it on 127.0.0.1 only and start it with -e STERLING_PREVIEW_NO_SIGN_IN=accept.',
  );
  process.exit(1);
}

// Hosted mode with one specific address (the pod IP): the workbench itself is never served there, only behind the sidecar on loopback.
const theiaHost = !localMode && !LOOPBACK.has(host) && !WILDCARD.has(host) && net.isIP(host) !== 0 ? '127.0.0.1' : host;

process.env.STERLING_WORKBENCH = '1';

const appRoot = fileURLToPath(new URL('..', import.meta.url));
// Theia resolves its own relative paths (plugins, src-gen) from the working folder, so make it the app root.
process.chdir(appRoot);
process.argv = [process.argv[0], path.join(appRoot, 'lib', 'backend', 'main.js'), '/home/sterling/workspace', '--hostname', theiaHost, '--port', '3000', ...process.argv.slice(2)];
await import(pathToFileURL(path.join(appRoot, 'lib', 'backend', 'main.js')).href);
