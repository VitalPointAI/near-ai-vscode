// The shared browser sign-in: the paste box says the same things as before for the usage reporting token,
// and says the sign-in is kept for Team Mode. Driven through the code-server path, where the forwarded
// callback is not on loopback and the sign-in address is pasted.
import assert from 'node:assert/strict';
import test from 'node:test';

interface RecordedBox {
  title: string; prompt: string; password: boolean; placeholder: string;
  hide?: () => void; accept?: () => void; change?: (text: string) => void;
  value: string; validationMessage?: string; disposed: boolean;
}

const boxes: RecordedBox[] = [];
const opened: string[] = [];
const vscodeStub = {
  Uri: { parse: (text: string) => ({ toString: () => text }) },
  UIKind: { Desktop: 1, Web: 2 },
  env: {
    uiKind: 2,
    asExternalUri: async () => ({ toString: () => 'https://code-server.example.invalid/proxy/1234/near-ai/signed-in/abc' }),
    openExternal: async (uri: { toString(): string }) => { opened.push(uri.toString()); return true; }
  },
  window: {
    createInputBox: () => {
      const box: RecordedBox = { title: '', prompt: '', password: false, placeholder: '', value: '', disposed: false };
      boxes.push(box);
      return Object.assign(box, {
        onDidChangeValue: (handler: (text: string) => void) => { box.change = handler; },
        onDidAccept: (handler: () => void) => { box.accept = handler; },
        onDidHide: (handler: () => void) => { box.hide = handler; },
        show: () => undefined,
        dispose: () => { box.disposed = true; }
      });
    }
  }
};

function load<T>(id: string): T {
  const nodeModule = require('node:module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = nodeModule._load;
  nodeModule._load = (request, parent, isMain) => (request === 'vscode' ? vscodeStub : originalLoad(request, parent, isMain));
  try { return require(id) as T; } finally { nodeModule._load = originalLoad; }
}

const signIn = load<typeof import('../services/nearSignIn')>('../services/nearSignIn');

async function pasteBoxFor(copy: import('../services/nearSignIn').SignInCopy): Promise<RecordedBox> {
  boxes.length = 0;
  opened.length = 0;
  const abort = new AbortController();
  const pending = signIn.browserSignIn('https://cloud-api.near.ai/v1', 'github', abort.signal, copy);
  for (let waited = 0; waited < 100 && boxes.length === 0; waited += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  const box = boxes[0];
  assert.ok(box, 'the paste box opened');
  box.hide?.();
  assert.equal(await pending, undefined, 'dismissing the paste box cancels the sign-in');
  assert.equal(box.disposed, true);
  return box;
}

test('the reporting flow keeps its exact paste box wording', async () => {
  const box = await pasteBoxFor(signIn.REPORTING_SIGN_IN_COPY);
  assert.equal(box.title, 'Finish signing in to NEAR AI Cloud');
  assert.equal(box.prompt, 'After signing in, the browser shows a page that can\'t be reached. Copy that page\'s whole address and paste it here. It holds a one-time sign-in that is signed out as soon as the token is made.');
  assert.equal(box.password, true);
  assert.match(opened[0] ?? '', /\/auth\/github\?frontend_callback=/);
});

test('the team flow says the sign-in is kept for this team until sign out', async () => {
  const box = await pasteBoxFor(signIn.TEAM_SIGN_IN_COPY);
  assert.equal(box.title, 'Finish signing in to NEAR AI Cloud');
  assert.ok(box.prompt.startsWith('After signing in, the browser shows a page that can\'t be reached.'));
  assert.ok(box.prompt.endsWith('NEAR AI keeps this sign-in for this team\'s invitations and member keys until you run "NEAR AI: Sign Out of NEAR AI for This Team".'));
  assert.ok(!box.prompt.includes('signed out as soon as the token is made'));
});

test('a pasted address is checked before it is accepted', async () => {
  boxes.length = 0;
  const abort = new AbortController();
  const pending = signIn.browserSignIn('https://cloud-api.near.ai/v1', 'github', abort.signal, signIn.TEAM_SIGN_IN_COPY);
  for (let waited = 0; waited < 100 && boxes.length === 0; waited += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  const box = boxes[0];
  box.value = 'not an address';
  box.change?.(box.value);
  assert.match(box.validationMessage ?? '', /no NEAR AI sign-in/);
  box.value = 'http://127.0.0.1:9/near-ai/signed-in#token=fa-abc&refresh_token=rt_abc12345';
  box.change?.(box.value);
  assert.equal(box.validationMessage, undefined);
  box.accept?.();
  assert.deepEqual(await pending, { accessToken: 'fa-abc', refreshToken: 'rt_abc12345' });
});
