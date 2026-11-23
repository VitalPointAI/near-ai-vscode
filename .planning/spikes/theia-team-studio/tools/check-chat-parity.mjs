import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const [image, pluginDirectory, browserPath, puppeteerPath] = process.argv.slice(2);
assert.ok(image && pluginDirectory && browserPath,
  'Usage: node check-chat-parity.mjs <local Theia image> <unpacked VSIX directory> <Chromium executable> [Puppeteer entry point]');
const require = createRequire(import.meta.url);
const puppeteer = require(puppeteerPath ? path.resolve(puppeteerPath) : 'puppeteer');
const fixture = fileURLToPath(new URL('../../../../dist/test/e2e/fakeModelServer.js', import.meta.url));
await access(fixture).catch(() => { throw new Error('Run npm run compile from the repository root first'); });
const browserData = await mkdtemp(fileURLToPath(new URL('../../../../dist/theia-chat-browser-', import.meta.url)));
const label = randomUUID();
const network = `sterling-chat-test-${label}`;
const container = `sterling-chat-workbench-${label}`;
const docker = promisify(execFile);

const host = 'sterling-chat-test.localhost';
const origin = `http://${host}:3000`;
const prompt = 'Synthetic browser smoke test';
const partial = 'Hi from the';
const reply = `${partial} fake model.`;
const replyGapMs = 2200;
const mockUrl = 'http://127.0.0.1:11434/v1';

// The container has no host workspace or credentials, no egress and no published port.
await docker('docker', ['network', 'create', '--internal', network]);
let browser;
try {
  await docker('docker', [
    'run', '--detach', '--pull=never', '--name', container, '--network', network,
    '--mount', `type=bind,source=${path.resolve(pluginDirectory)},target=/plugins,readonly`,
    '--mount', `type=bind,source=${fixture},target=/chat-fixture.js,readonly`,
    '--env', 'THEIA_DEFAULT_PLUGINS=local-dir:///plugins', image, 'sh', '-ec',
    `mkdir -p "$HOME/.theia"
printf '%s\n' '{"security.workspace.trust.startupPrompt":"never"}' > "$HOME/.theia/settings.json"
node -e 'require("/chat-fixture.js").fakeModelServer({ port: 11434, replyGapMs: ${replyGapMs} }).then(server => {
  server.on("request", (request, response) => {
    if (request.url === "/v1/chat/completions") response.once("close", () => {
      if (!response.writableFinished) console.log("MOCK_STREAM_CANCELLED");
    });
  });
})' &
exec node_modules/.bin/theia start /home/node/workspace --hostname 0.0.0.0 --port 3000 \
  --session-preference nearAi.autoInstallGsd=false --session-preference nearAi.agent.saveTranscripts=true`
  ]);
  const { stdout } = await docker('docker', [
    'inspect', container, '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'
  ]);
  const containerAddress = stdout.trim();
  assert.match(containerAddress, /^(?:\d{1,3}\.){3}\d{1,3}$/, 'Docker assigned a private workbench address');
  for (let attempt = 0; ; attempt += 1) {
    const ready = await fetch(`http://${containerAddress}:3000/`, { signal: AbortSignal.timeout(1000) })
      .then((response) => response.ok, () => false);
    if (ready) break;
    if (attempt >= 20) throw new Error('The isolated workbench did not start');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  browser = await puppeteer.launch({
    executablePath: browserPath,
    userDataDir: browserData,
    args: [
      '--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking', '--no-proxy-server',
      `--host-resolver-rules=MAP ${host} ${containerAddress}, MAP *.webview.${host} ${containerAddress}, MAP * ~NOTFOUND`
    ]
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = new URL(request.url());
    const external = /^(http|https|ws|wss):$/.test(url.protocol)
      && url.hostname !== host && !url.hostname.endsWith(`.webview.${host}`);
    void (external ? request.abort() : request.continue()).catch(() => {});
  });
  const waitForChat = async () => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      for (const frame of page.frames()) {
        if (frame.parentFrame() && await frame.evaluate(() => Boolean(document.querySelector('#input'))).catch(() => false)) return frame;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error('The Chat webview did not load');
  };
  const openChat = async () => {
    await page.waitForSelector('button[data-command="nearAi.openChat"]', { visible: true });
    await page.click('button[data-command="nearAi.openChat"]');
    return waitForChat();
  };
  const waitForQuickInput = async (label) => {
    const found = await page.waitForFunction((text) => {
      for (const widget of document.querySelectorAll('.quick-input-widget')) {
        if (!widget.getBoundingClientRect().width) continue;
        for (const input of widget.querySelectorAll('input:not([type=hidden])')) {
          if (!input.getBoundingClientRect().width) continue;
          if (widget.innerText.includes(text) || input.placeholder?.includes(text) || input.getAttribute('aria-label')?.includes(text)) return input;
        }
      }
      return false;
    }, { timeout: 8_000 }, label);
    const input = found.asElement();
    assert.ok(input, `Expected input for ${label}`);
    await input.focus();
    return input;
  };
  const answer = async (label, value) => {
    await waitForQuickInput(label);
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    if (value) await page.keyboard.type(value);
    await page.keyboard.press('Enter');
  };
  const command = async (title) => {
    await page.bringToFront();
    await page.keyboard.down('Control');
    await page.keyboard.down('Shift');
    await page.keyboard.press('KeyP');
    await page.keyboard.up('Shift');
    await page.keyboard.up('Control');
    const input = await page.waitForSelector('.quick-input-widget input', { visible: true, timeout: 8_000 });
    await input.evaluate((element, command) => {
      element.value = `>${command}`;
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }, title);
    await page.waitForFunction((name) => document.querySelector('.quick-input-list')?.textContent.includes(name), { timeout: 8_000 }, title.split(': ').at(-1));
    await input.focus();
    await page.keyboard.press('Enter');
  };
  page.on('pageerror', (error) => console.error('Browser error:', error.message));
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  let chat = await openChat();
  await chat.waitForSelector('#welcome-connect:not([hidden])', { visible: true });
  assert.equal(await chat.$eval('#welcome-connect-title', (element) => element.textContent), 'Connect AI to start');
  await command('SovAI: Set Up a New Profile');
  await waitForQuickInput('Where should models run?');
  await page.keyboard.type('Local runtime');
  await page.keyboard.press('Enter');
  await answer('Project name', 'Theia Chat smoke');
  await answer('Organization or company', '');
  await answer('Local runtime URL', mockUrl);
  await answer('API key for the local runtime', '');
  await chat.waitForFunction(() => document.querySelector('#profile')?.dataset.state === 'ready' && document.querySelector('#model')?.value === 'fake-coder', { timeout: 15_000 });
  console.log('PASS  Setup listed the mock model without a key');
  // Activate the form within its own frame so the automation focuses the composer, not the outer dock.
  const send = async (message) => {
    await chat.$eval('#input', (element, text) => {
      element.value = text;
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }, message);
    await chat.$eval('#send', (element) => element.click());
  };
  const waitForReply = (text) => chat.waitForFunction((part) =>
    [...document.querySelectorAll('.turn.assistant')].at(-1)?.firstElementChild?.textContent.trim() === part,
  { timeout: 12_000 }, text).catch(async (error) => {
    console.error('Chat DOM:', await chat.evaluate(() => ({
      input: document.querySelector('#input')?.value,
      send: document.querySelector('#send')?.disabled,
      status: document.querySelector('#status')?.textContent,
      transcript: document.querySelector('#transcript')?.innerText.slice(-1000),
      profile: document.querySelector('#profile')?.dataset.state
    })));
    throw error;
  });
  await send(prompt);
  await waitForReply(partial);
  await waitForReply(reply);
  console.log('PASS  Chat sent the message and rendered both stream chunks');

  await chat.waitForSelector('#stop[hidden]');
  await chat.$eval('#new-conversation', (element) => element.click());
  await chat.waitForFunction(() => !document.querySelector('.turn.user'));
  await send('Synthetic reply to stop');
  await waitForReply(partial);
  await chat.$eval('#stop:not([hidden])', (element) => element.click());
  await chat.waitForFunction(() => document.querySelector('#stop').hidden &&
    [...document.querySelectorAll('.turn.assistant')].at(-1)?.querySelector('.meta')?.textContent === 'Stopped',
  { timeout: 8_000 });
  // The mock would have produced its second chunk again by now if the stream were still running.
  await new Promise((resolve) => setTimeout(resolve, replyGapMs + 200));
  const stoppedReply = await chat.evaluate(() =>
    [...document.querySelectorAll('.turn.assistant')].at(-1)?.firstElementChild?.textContent.trim());
  assert.equal(stoppedReply, partial, 'The stopped reply kept its partial text without the delayed chunk');
  const providerLog = await docker('docker', ['logs', container]);
  assert.match(providerLog.stdout, /^MOCK_STREAM_CANCELLED$/m, 'The mock detected the HTTP response close before it finished');
  console.log('PASS  Chat Stop cancelled the stream and kept the partial reply');

  await page.reload({ waitUntil: 'domcontentloaded' });
  chat = await openChat();
  await command('SovAI: Show Chat History');
  await waitForQuickInput('Open a NEAR AI conversation');
  await page.keyboard.type(prompt);
  await page.waitForFunction((text) => document.querySelector('.quick-input-list')?.textContent.includes(text), { timeout: 8_000 }, prompt);
  await page.keyboard.press('Enter');
  await chat.waitForFunction((user, assistant) =>
    [...document.querySelectorAll('.turn.user')].some((turn) => turn.textContent.includes(user)) &&
    [...document.querySelectorAll('.turn.assistant')].some((turn) => turn.textContent.includes(assistant)),
  { timeout: 12_000 }, prompt, reply);
  console.log('PASS  Show Chat History reopened both turns after reload');
} catch (error) {
  const logs = await docker('docker', ['logs', '--tail', '25', container]).catch(() => undefined);
  if (logs) console.error(logs.stdout, logs.stderr);
  throw error;
} finally {
  try {
    await browser?.close();
  } finally {
    await docker('docker', ['stop', '--timeout', '2', container]).catch((error) => {
      console.error(`Could not stop ${container}: ${error.message}`);
    });
    console.log(`Retained test resources\nContainer ${container}\nNetwork ${network}\nBrowser profile ${browserData}`);
  }
}
