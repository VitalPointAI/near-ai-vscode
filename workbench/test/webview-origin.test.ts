// The webview host for a page at a loopback address (common/webview-origin.ts): 127.0.0.1 and [::1], with or without a port, become
// localhost on the same port, so `<uuid>.webview.<host>` is a valid name browsers serve from loopback. Every other host, including names
// and addresses that only start like a loopback address, is kept, and every result is a valid URL host under the default pattern.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { webviewParentHost } from '../extension/src/common/webview-origin.ts';

test('a page at 127.0.0.1 or [::1] gets its webviews under localhost on the same port', () => {
  assert.equal(webviewParentHost('127.0.0.1:18881'), 'localhost:18881');
  assert.equal(webviewParentHost('127.0.0.1'), 'localhost');
  assert.equal(webviewParentHost('[::1]:3000'), 'localhost:3000');
  assert.equal(webviewParentHost('[::1]'), 'localhost');
});

test('any other page host is kept as given', () => {
  for (const host of ['localhost:18881', 'ws.site.example', 'ws.site.example:8443', '127.0.0.10:3000', '127.0.0.1.nip.io:3000',
    '127.0.0.1.nip.io', '10.0.0.5:3000', '[::12]:3000', '[2001:db8::1]:3000']) {
    assert.equal(webviewParentHost(host), host);
  }
});

test('the default pattern gives a valid URL for every page host that has a name or a loopback address', () => {
  for (const host of ['127.0.0.1:18881', '127.0.0.1', '[::1]:3000', 'localhost:18881', 'ws.site.example', '127.0.0.1.nip.io:3000']) {
    const url = new URL(`http://0f8c2a4e-1b3d-4c5e-8f9a-0b1c2d3e4f5a.webview.${webviewParentHost(host)}/webview/index.html`);
    assert.match(url.hostname, /^0f8c2a4e-1b3d-4c5e-8f9a-0b1c2d3e4f5a\.webview\./);
  }
  assert.throws(() => new URL('http://0f8c2a4e-1b3d-4c5e-8f9a-0b1c2d3e4f5a.webview.127.0.0.1:18881/'), 'the unmapped form is no valid URL');
});
