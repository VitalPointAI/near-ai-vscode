import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import type { BindingSource } from '../services/staffEditorBinding';
import { ProductEditor } from '../staff/replica/productEditing';
import { productOutput } from '../staff/replica/productFeed';
import { carryThroughFake, createLiveWorld } from './helpers/liveWorld';
import { createFakeContext, createVscodeStub, installVscodeStub } from './helpers/vscodeStub';

const PRODUCT = 'bridge-status';
const HEADER = '---\nproduct: bridge-status\n---\n\n';
const FILE = '/virtual/products/bridge-status.md';
const servicePath = '../services/staffEditorBinding';

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, 'the expected editor event did not arrive');
    await pause(15);
  }
}

async function withAdapter(run: (fixture: {
  stub: ReturnType<typeof createVscodeStub>;
  notify(): void;
  body(): Promise<string | undefined>;
  updateCount(): Promise<number>;
  remoteEdit(edits: Array<{ offset: number; length: number; text: string }>): Promise<void>;
}) => Promise<void>): Promise<void> {
  const world = await createLiveWorld({ people: [{ label: 'ana', name: 'Avery Lead' }, { label: 'ben', name: 'Blake Rivers' }] });
  const [a, b] = world.devices;
  const stream = a.project.projectId;
  const target = { stream, product: PRODUCT, actor: { kind: 'person' } as const, header: () => HEADER };
  const stub = createVscodeStub();
  const context = createFakeContext(a.at.global, a.at.secrets);
  const restore = installVscodeStub(stub);
  const listeners = new Set<() => void>();
  try {
    const seed = await ProductEditor.open(a.project, target);
    try {
      seed.insert(0, 'Alpha Bravo');
      assert.deepEqual(await seed.flush(), { appended: 1, queued: 0 });
    } finally {
      seed.close();
    }
    await carryThroughFake(a, b, stream);
    const source: BindingSource = {
      productFor: (uri) => uri.fsPath === FILE ? { ...target, project: a.project } : undefined,
      onProductChanged(listener) {
        listeners.add(listener);
        return { dispose: () => { listeners.delete(listener); } };
      }
    };
    const { registerStaffEditorBindings } = require(servicePath) as typeof import('../services/staffEditorBinding');
    registerStaffEditorBindings(context, () => assert.fail('the tracer registers no commands'), source);
    await run({
      stub,
      notify() { for (const listener of listeners) listener(); },
      async body() { return productOutput((await a.project.state()).fold, stream, PRODUCT)?.text; },
      async updateCount() { return (await a.project.findOwnAll('doc.update', () => true)).length; },
      async remoteEdit(edits) {
        await carryThroughFake(a, b, stream);
        const peer = await ProductEditor.open(b.project, target);
        try {
          peer.edit(edits);
          assert.deepEqual(await peer.flush(), { appended: 1, queued: 0 });
        } finally {
          peer.close();
        }
        await carryThroughFake(b, a, stream);
        for (const listener of listeners) listener();
      }
    });
  } finally {
    for (const subscription of context.subscriptions) subscription.dispose();
    await until(() => stub.documentChangeListeners() === 0);
    delete require.cache[require.resolve(servicePath)];
    restore();
    await world.close();
  }
}

test('a shared document persists local typing and renders one remote WorkspaceEdit without echo', async () => {
  await withAdapter(async ({ stub, body, updateCount, remoteEdit }) => {
    const document = stub.fireDocumentOpen(FILE, HEADER + 'Alpha Bravo');
    await until(() => stub.documentChangeListeners() === 1);
    stub.fireDocumentChange(document, [{ rangeOffset: document.getText().length, rangeLength: 0, text: '!' }]);
    await until(async () => await body() === 'Alpha Bravo!');
    assert.equal(stub.workspaceEdits.length, 0);

    await remoteEdit([{ offset: 0, length: 5, text: 'Left' }, { offset: 6, length: 5, text: 'Right' }]);
    await until(() => document.getText() === HEADER + 'Left Right!');
    const [{ version, applied, edits }] = stub.workspaceEdits;
    assert.equal(stub.workspaceEdits.length, 1);
    assert.equal(version, 2);
    assert.equal(applied, true);
    assert.equal(edits.length, 2);
    await pause(550);
    assert.equal(await updateCount(), 2, 'the seed and local typing account for the two authored updates');
  });
});

test('an unlisted document stays unbound without loading replica modules', async () => {
  const stub = createVscodeStub();
  const restore = installVscodeStub(stub);
  const context = createFakeContext('/virtual/store', {});
  const module = require('node:module') as { _load(request: string, parent: unknown, main: boolean): unknown };
  const load = module._load;
  const replicaLoads: string[] = [];
  module._load = (request, parent, main) => {
    if (request.startsWith('../staff/replica/')) replicaLoads.push(request);
    return load(request, parent, main);
  };
  try {
    const { registerStaffEditorBindings } = require(servicePath) as typeof import('../services/staffEditorBinding');
    registerStaffEditorBindings(context, () => assert.fail('the tracer registers no commands'), {
      productFor: () => undefined, onProductChanged: () => ({ dispose() {} })
    });
    const document = stub.fireDocumentOpen('/virtual/other.md', 'Private notes');
    stub.fireDocumentChange(document, [{ rangeOffset: 0, rangeLength: 0, text: 'New ' }]);
    await pause(0);
    assert.equal(stub.documentChangeListeners(), 0);
    assert.deepEqual(replicaLoads, []);
    assert.deepEqual(stub.workspaceEdits, []);
  } finally {
    for (const subscription of context.subscriptions) subscription.dispose();
    delete require.cache[require.resolve(servicePath)];
    module._load = load;
    restore();
  }
});

test('closing a shared document flushes its captured edits and detaches the listener', async () => {
  await withAdapter(async ({ stub, body, notify }) => {
    const document = stub.fireDocumentOpen(FILE, HEADER + 'Alpha Bravo');
    await until(() => stub.documentChangeListeners() === 1);
    stub.fireDocumentChange(document, [{ rangeOffset: document.getText().length, rangeLength: 0, text: '?' }]);
    stub.fireDocumentClose(document);
    await until(async () => stub.documentChangeListeners() === 0 && await body() === 'Alpha Bravo?');
    notify();
    assert.deepEqual(stub.workspaceEdits, []);
  });
});

test('a version change in flight refuses the remote WorkspaceEdit without overwriting newer typing', async () => {
  await withAdapter(async ({ stub, remoteEdit, updateCount }) => {
    const document = stub.fireDocumentOpen(FILE, HEADER + 'Alpha Bravo');
    await until(() => stub.documentChangeListeners() === 1);
    stub.beforeNextWorkspaceEdit(() => stub.fireDocumentChange(document, [{ rangeOffset: HEADER.length, rangeLength: 0, text: 'New ' }]));
    await remoteEdit([{ offset: 0, length: 5, text: 'Left' }]);
    await until(() => stub.workspaceEdits.length === 1 && stub.notifications.length > 0);
    assert.equal(stub.workspaceEdits[0].applied, false);
    assert.equal(document.getText(), HEADER + 'New Alpha Bravo');
    assert.equal(await updateCount(), 1);
  });
});

test('opening a CRLF editor normalizes line endings in one WorkspaceEdit', async () => {
  await withAdapter(async ({ stub, updateCount }) => {
    const document = stub.fireDocumentOpen(FILE, HEADER.replaceAll('\n', '\r\n') + 'Alpha Bravo');
    await until(() => document.getText() === HEADER + 'Alpha Bravo');
    assert.equal(stub.workspaceEdits.length, 1);
    assert.equal(stub.workspaceEdits[0].edits.length, 1);
    assert.equal(await updateCount(), 1);
  });
});
