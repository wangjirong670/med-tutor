'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { compileFunction } = require('node:vm');
const ts = require('../../../s07/restore-r2/src/pi-gui/node_modules/typescript/lib/typescript.js');

const root = 'runtime/src/pi-gui/apps/desktop/out';
const fixturesDir = path.join(__dirname, 'fixtures');
const mainPath = path.join(fixturesDir, 'r3-main.js');
const originalPath = path.join(fixturesDir, 'r4-main.js');
const r2Path = path.join(fixturesDir, 'r2-main.js');
const preloadPath = path.join(fixturesDir, 'r3-preload.js');
const sha256 = content => crypto.createHash('sha256').update(content).digest('hex');
const assets = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'runtime-build-map.json')));
const mainReceipt = assets.files.find(file => file.relative === root + '/main/main.js');
const preloadReceipt = assets.files.find(file => file.relative === root + '/preload/preload.js');

function unique(nodes, predicate, name) {
  const found = nodes.filter(predicate);
  assert.equal(found.length, 1, name);
  return found[0];
}

function parse(filename, expected) {
  const source = fs.readFileSync(filename);
  assert.equal(sha256(source), expected);
  const ast = ts.createSourceFile(filename, source.toString('utf8'), ts.ScriptTarget.Latest, true);
  assert.deepEqual(ast.parseDiagnostics, []);
  return ast;
}

const sessionDriver = { sessionKey: ({ workspaceId, sessionId }) => `${workspaceId}:${sessionId}` };
const a = { workspaceId: 'A-workspace', sessionId: 'same-id' };
const b = { workspaceId: 'B-workspace', sessionId: 'same-id' };
const keyA = sessionDriver.sessionKey(a);
const keyB = sessionDriver.sessionKey(b);
const original = 'A original draft';
const next = 'A newer draft';
const initialB = 'B original draft';
const notSent = '连接已断开，本次消息未发送，草稿已保留。请重新打开应用后手动发送。';
const uncertain = '连接中断，消息是否已提交无法确认；请重新打开并核对会话后再决定是否发送。草稿已保留。';
const queuedBefore = {
  id: 'existing-queue-item', text: 'Existing queued text', mode: 'followUp',
  createdAt: '2026-11-20T00:00:00.000Z', updatedAt: '2026-11-20T00:00:00.000Z',
};
const transcriptBefore = {
  kind: 'message', id: 'existing-transcript-item', role: 'user', text: 'Existing transcript text',
  createdAt: queuedBefore.createdAt,
};

function loadMain(filename, hash) {
  const ast = parse(filename, hash);
  const named = name => unique(ast.statements, node =>
    (ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name?.text === name, name);
  const storeClass = named('DesktopAppStore');
  const constructor = unique(storeClass.members, ts.isConstructorDeclaration, 'store constructor');
  const assignment = unique(constructor.body.statements, node => ts.isExpressionStatement(node) &&
    ts.isBinaryExpression(node.expression) &&
    node.expression.left.getText(ast) === 'this.conversationOwner', 'real conversation owner adapter');
  const handlers = ['updateComposerDraft', 'submitComposer'].map(name => {
    const registration = unique(named('registerDesktopIpc').body.statements, node =>
      ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) &&
      node.expression.expression.getText(ast) === 'electron.ipcMain.handle' &&
      node.expression.arguments[0]?.getText(ast) === `desktopIpc.${name}`, name + ' handler');
    return `${name}: ${registration.expression.arguments[1].getText(ast)}`;
  });
  const declarations = [
    'SessionStateMap', 'SessionLeasedError', 'createConversationOwner', 'mapToRecord',
    'submitComposer', 'submitComposerToSession', 'sendMessageToSession', 'updateComposerDraft',
    'composerSubmitNeedsSenderView', 'hasRuntimeSlashCommand', 'resolveRuntimeSlashCommand',
    'appendUserMessage', 'makeTranscriptMessage', 'toTranscriptAttachments', 'toSessionAttachments',
    'buildQueuedComposerMessage', 'replaceQueuedComposerMessage', 'toSessionQueuedMessages',
    'appendQueuedUserMessage', 'removeOptimisticQueuedUserMessage',
    'clearActiveAssistantMessage', 'cloneComposerAttachments', 'toolOutputContent',
    'transcriptForWindow', 'messageForWindow', 'toSessionRef', 'describeStoreError',
    'isSessionLeasedError', 'hasStoredModelSettings', 'serializeCompatibilityByWorkspace',
    'toPersistedOrchestrationChildren', 'expectRecord', 'expectString', 'expectNonEmptyString',
    'expectSessionTarget', 'expectOptionalDeliverOptions',
  ].map(name => named(name).getText(ast));
  const methods = [
    'initialize', 'sessionFromState', 'isSelectedSession', 'selectedSessionRef', 'emit',
    'recordUserMessageRecency', 'allocateComposerDraftSyncNonce', 'resolveComposerDraft',
    'setComposerDraftForSession', 'persistComposerAttachments', 'persistUiState',
    'schedulePersistUiState', 'withSessionError', 'buildSelectedTranscriptRecord',
    'ensureSessionSchemaInfo', 'publishSelectedTranscript', 'publishSelectedTranscriptFor',
    'getQueuedComposerEditState', 'getQueuedComposerMessages', 'setQueuedComposerEditState',
    'submitComposer', 'composerSubmitNeedsSenderView',
    'updateComposerDraft',
  ].map(name => unique(storeClass.members, node =>
    ts.isMethodDeclaration(node) && node.name.getText(ast) === name, name).getText(ast));
  const load = compileFunction(`${declarations.join('\n')}
    const transcriptsForWindow = new WeakMap();
    const messagesForWindow = new WeakMap();
    return {
      SessionStateMap,
      methods: { ${methods.join(',\n')} },
      bindOwner() { ${assignment.getText(ast)} },
      handlers(windows, owners, run, immediate) { return { ${handlers.join(',\n')} }; },
    };`, ['sessionDriver', 'require$$2', 'writePersistedUiState'], { filename });
  return writer => load(sessionDriver, crypto, writer);
}

const r4 = loadMain(originalPath, '139877773422dddb6e732cf50d51a287160df667629f12be5839aa6d9f2b6bb7');
const r2 = loadMain(r2Path, 'c8103d119f7eee1d0dc8084078d1709300448a158397870170ca3473fe9c4014');
const r3 = loadMain(mainPath, mainReceipt.sha256);
const preloadAst = parse(preloadPath, preloadReceipt.sha256);
const preloadHandlers = new Map();
function inspectPreload(node) {
  if (ts.isPropertyAssignment(node) && ts.isArrowFunction(node.initializer)) {
    const name = node.name.getText(preloadAst);
    if (name === 'updateComposerDraft' || name === 'submitComposer') {
      assert(!preloadHandlers.has(name));
      preloadHandlers.set(name, node.initializer);
    }
  }
  ts.forEachChild(node, inspectPreload);
}
inspectPreload(preloadAst);
assert.equal(preloadHandlers.size, 2);
assert.equal(preloadReceipt.sha256, preloadReceipt.r2Sha256);
const preload = Object.fromEntries([...preloadHandlers].map(([name, handler]) => [
  name, compileFunction('return ' + handler.getText(preloadAst),
    ['electron', 'desktopIpc'], { filename: preloadPath }),
]));

function harness(load, { ready = true, running = false } = {}) {
  const writes = [];
  const built = load(async (target, value) => {
    assert.equal(target, 'isolated-writer');
    writes.push(structuredClone(value));
  });
  const sessions = new built.SessionStateMap();
  sessions.composerDraftsBySession.set(keyA, original).set(keyB, initialB);
  if (ready) sessions.loadedTranscriptKeys.add(keyA);
  if (running) {
    sessions.queuedComposerMessagesBySession.set(keyA, [{ ...queuedBefore, attachments: [] }]);
    sessions.transcriptCache.set(keyA, [transcriptBefore]);
  }
  const readiness = Promise.withResolvers();
  const enteredReadiness = Promise.withResolvers();
  const sent = [];
  const observedSend = [Promise.withResolvers(), Promise.withResolvers()];
  function recordRequest(method, scope, input) {
    const response = Promise.withResolvers();
    assert(observedSend[sent.length], 'unexpected retry');
    observedSend[sent.length].resolve();
    sent.push({ method, scope, input, response });
    return response.promise;
  }
  const store = {
    ...built.methods,
    sessionState: sessions,
    state: {
      selectedWorkspaceId: a.workspaceId, selectedSessionId: a.sessionId, revision: 10,
      composerDraft: original, composerDraftSyncNonce: 1, activeView: 'threads',
      workspaceOrder: [], collapsedWorkspaceIds: [], orchestrationChildren: [],
      workspaces: [a, b].map(ref => ({
        id: ref.workspaceId,
        sessions: [{ id: ref.sessionId, status: ref === a && running ? 'running' : 'idle' }],
      })),
    },
    composerDraftProjectionNonce: 1,
    initPromise: Promise.resolve(),
    runtimeByWorkspace: new Map(),
    taskWorkbenchTemplatesBySession: new Map(),
    extensionCommandCompatibilityByWorkspace: new Map(),
    extensionFlagsByWorkspace: new Map(),
    disabledBuiltinExtensions: new Set(),
    persistenceReadiness: 'ready',
    uiStateFilePath: 'isolated-writer',
    listeners: new Set(),
    selectedTranscriptListeners: new Set(),
    sessionSchemaInfoCache: new Map([[keyA, {}], [keyB, {}]]),
    attachmentStore: { async write(key, value) { assert.equal(key, keyA); assert.deepEqual(value, []); } },
    ensureSessionReady(ref) {
      assert.deepEqual(ref, a);
      enteredReadiness.resolve();
      return readiness.promise;
    },
    async refreshState(options) {
      // The successful driver response is tested before the catalog refresh boundary.
      assert.deepEqual(options, { clearLastError: true, markSelectedSessionViewed: false });
      return store.emit();
    },
    driver: {
      sendUserMessage: (scope, input) => recordRequest('sendUserMessage', scope, input),
      replaceQueuedMessages: (scope, input) => recordRequest('replaceQueuedMessages', scope, input),
    },
  };
  built.bindOwner.call(store);
  const routes = [];
  const windows = {
    targetForSender: sender => sender.ref,
    withComposerDraftPersistOrigin: (_sender, action) => action(),
  };
  const dispatch = route => (_event, action) => {
    routes.push(route);
    return action();
  };
  const handlers = built.handlers(windows, { conversation: store }, dispatch('queue'), dispatch('immediate'));
  const event = { sender: { ref: a } };
  const channels = {
    updateComposerDraft: 'pi-gui:update-composer-draft',
    submitComposer: 'pi-gui:submit-composer',
  };
  const electron = { ipcRenderer: { invoke(channel, ...args) {
    const name = Object.keys(channels).find(key => channels[key] === channel);
    assert(name, 'expected an existing composer channel');
    return handlers[name](event, ...args);
  } } };
  const update = preload.updateComposerDraft(electron, channels);
  const submit = preload.submitComposer(electron, channels);
  return {
    store, writes, sent, routes, update, readiness, enteredReadiness,
    firstRequest: observedSend[0].promise,
    async start(text = original, delivery) {
      const index = sent.length;
      const completion = submit(text, delivery ? { deliverAs: delivery } : undefined);
      await Promise.race([observedSend[index].promise, completion.then(() => assert.fail('send ended before request'))]);
      const request = sent[index];
      assert.deepEqual(request.scope, a);
      if (running) {
        assert.equal(request.method, 'replaceQueuedMessages');
        assert.equal(request.input.length, 2);
        assert.deepEqual(request.input[0], queuedBefore);
        assert.equal(request.input[1].text, text);
        assert.equal(request.input[1].mode, delivery ?? 'followUp');
        assert.notEqual(request.input[1].id, queuedBefore.id);
      } else {
        assert.equal(request.method, 'sendUserMessage');
        assert.deepEqual(request.input, { text, attachments: [] });
      }
      return { ...request, completion };
    },
    submit: () => submit(original),
    drafts: () => writes.at(-1).composerDraftsBySession,
    selectB() {
      store.state = { ...store.state, selectedWorkspaceId: b.workspaceId, composerDraft: initialB };
    },
  };
}

async function verify(load, mode, expected) {
  const h = harness(load);
  const request = await h.start();
  assert.deepEqual(h.drafts(), { [keyB]: initialB });
  if (mode === 'new' || mode === 'clear-after-new') await h.update(next, a);
  if (mode === 'clear-after-new' || mode === 'echo') await h.update('', a);
  if (mode === 'explicit-empty') await h.update('', { ...a, explicitClear: true });
  if (mode === 'other-workspace') {
    h.selectB();
    await h.update('B newer draft', b);
  }
  if (mode === 'no-edit') h.selectB();
  await h.store.persistUiState();
  request.response.reject(new Error(mode === 'uncertain' ? uncertain : notSent));
  await request.completion;
  assert.equal(h.drafts()[keyA], expected, mode);
  assert.equal(h.drafts()[keyB], mode === 'other-workspace' ? 'B newer draft' : initialB);
  assert.equal(h.store.resolveComposerDraft(a.workspaceId, a.sessionId), expected ?? '');
  assert.equal(h.store.sessionState.sessionErrorsBySession.get(keyA), mode === 'uncertain' ? uncertain : notSent);
  assert.equal(h.store.sessionState.sessionErrorsBySession.has(keyB), false);
  assert.equal(h.store.sessionState.transcriptCache.get(keyA).length, 0);
  assert.equal(h.sent.length, 1);
  assert.equal(h.routes.filter(route => route === 'immediate').length, 1);
  assert(!h.store.sessionState.pendingComposerDraftRestoreBySession?.has(keyA));
}

for (const [mode, expected] of [['new', next], ['clear-after-new', undefined], ['explicit-empty', undefined]]) {
  test(`${mode}: the frozen main resurrects the text and the candidate preserves the accepted edit`, async () => {
    await verify(r4, mode, original);
    await verify(r3, mode, expected);
  });
}

for (const mode of ['no-edit', 'echo', 'other-workspace', 'uncertain']) {
  test(`${mode}: restores only A and makes one submission`, async () => {
    await verify(r4, mode, original);
    await verify(r3, mode, original);
  });
}

test('a second accepted submission replaces the first submission’s draft restoration', async () => {
  const h = harness(r3);
  const first = await h.start();
  const second = await h.start(next);
  first.response.reject(new Error(notSent));
  await first.completion;
  assert.equal(h.drafts()[keyA], undefined);
  assert.deepEqual(h.store.sessionState.transcriptCache.get(keyA).map(item => item.text), [next]);
  second.response.reject(new Error(notSent));
  await second.completion;
  assert.equal(h.drafts()[keyA], next);
  assert.equal(h.sent.length, 2);
  assert.deepEqual(h.routes, ['immediate', 'immediate']);
  assert.equal(h.store.sessionState.pendingComposerDraftRestoreBySession.size, 0);
});

test('the original send cannot clear a draft accepted while session readiness is pending', async () => {
  const h = harness(r3, { ready: false });
  const pending = h.submit();
  await Promise.race([h.enteredReadiness.promise, pending.then(() => assert.fail('readiness not entered'))]);
  await h.update(next, a);
  await h.store.persistUiState();
  h.readiness.resolve();
  await Promise.race([h.firstRequest, pending.then(() => assert.fail('driver request not made'))]);
  assert.equal(h.drafts()[keyA], next);
  h.sent[0].response.reject(new Error(notSent));
  await pending;
  assert.equal(h.drafts()[keyA], next);
  assert.equal(h.sent.length, 1);
});

test('the automatic empty acknowledgement during readiness still permits failure recovery', async () => {
  const h = harness(r3, { ready: false });
  const pending = h.submit();
  await Promise.race([h.enteredReadiness.promise, pending.then(() => assert.fail('readiness not entered'))]);
  await h.update('', a);
  await h.store.persistUiState();
  h.readiness.resolve();
  await Promise.race([h.firstRequest, pending.then(() => assert.fail('driver request not made'))]);
  h.sent[0].response.reject(new Error(notSent));
  await pending;
  assert.equal(h.drafts()[keyA], original);
  assert.equal(h.sent.length, 1);
});

function rowIds(h) {
  return h.store.sessionState.transcriptCache.get(keyA).map(message => message.id);
}

function queuedPayload(h) {
  return h.store.getQueuedComposerMessages(a).map(({ attachments, ...message }) => message);
}

function rowsWithPending(delivery, request) {
  return delivery === 'steer'
    ? [transcriptBefore.id, request.input[1].id]
    : [transcriptBefore.id];
}

async function queuedFailure(load, delivery, edit, expected) {
  const h = harness(load, { running: true });
  const request = await h.start(original, delivery);
  assert.equal(h.store.sessionState.pendingComposerDraftRestoreBySession.has(keyA), load === r3);
  assert.deepEqual(rowIds(h), rowsWithPending(delivery, request));
  await h.store.persistUiState();
  assert.deepEqual(h.drafts(), { [keyB]: initialB });
  if (edit === 'new') await h.update(next, a);
  if (edit === 'clear') await h.update('', { ...a, explicitClear: true });
  if (edit === 'none') await h.update('', a);
  if (edit === 'other') {
    h.selectB();
    await h.update('B newer draft', b);
  }
  await h.store.persistUiState();
  assert.equal(h.drafts()[keyA], edit === 'new' ? next : undefined);
  const message = edit === 'unknown' ? uncertain : notSent;
  request.response.reject(new Error(message));
  const visible = await request.completion;
  assert.equal(h.drafts()[keyA], expected);
  assert.equal(h.store.resolveComposerDraft(a.workspaceId, a.sessionId), expected ?? '');
  assert.equal(h.drafts()[keyB], edit === 'other' ? 'B newer draft' : initialB);
  assert.equal(h.store.sessionState.sessionErrorsBySession.get(keyA), message);
  assert.equal(h.store.sessionState.sessionErrorsBySession.has(keyB), false);
  assert.equal(visible.lastError, edit === 'other' ? undefined : message);
  assert.deepEqual(rowIds(h), [transcriptBefore.id]);
  assert.deepEqual(queuedPayload(h), [queuedBefore]);
  assert.equal(h.sent.length, 1);
  assert.equal(h.routes.filter(route => route === 'immediate').length, 1);
  assert.equal(h.store.sessionState.pendingComposerDraftRestoreBySession.size, 0);
}

for (const delivery of ['followUp', 'steer']) {
  for (const [edit, expected] of [
    ['new', next], ['clear', undefined], ['none', original], ['other', original], ['unknown', original],
  ]) {
    test(delivery + ' preserves draft authority with ' + edit, async () => {
      await queuedFailure(r2, delivery, edit, original);
      await queuedFailure(r3, delivery, edit, expected);
    });
  }

  test(delivery + ' older rejection cannot release a newer in-flight submission', async () => {
    const h = harness(r3, { running: true });
    const first = await h.start(original, delivery);
    const initialToken = h.store.sessionState.pendingComposerDraftRestoreBySession.get(keyA);
    await h.update(next, a);
    const second = await h.start(next, delivery);
    const newerToken = h.store.sessionState.pendingComposerDraftRestoreBySession.get(keyA);
    assert(newerToken && newerToken !== initialToken);
    assert.notEqual(first.input[1].id, second.input[1].id);

    first.response.reject(new Error(notSent));
    assert.equal((await first.completion).lastError, notSent);
    assert.equal(h.drafts()[keyA], undefined);
    assert.equal(h.store.sessionState.pendingComposerDraftRestoreBySession.get(keyA), newerToken);
    assert.deepEqual(rowIds(h), rowsWithPending(delivery, second));

    second.response.reject(new Error(notSent));
    assert.equal((await second.completion).lastError, notSent);
    assert.equal(h.drafts()[keyA], next);
    assert.equal(h.drafts()[keyB], initialB);
    assert.deepEqual(rowIds(h), [transcriptBefore.id]);
    assert.deepEqual(queuedPayload(h), [queuedBefore]);
    assert.deepEqual(h.sent.map(item => item.input[1].text), [original, next]);
    assert.equal(h.store.sessionState.pendingComposerDraftRestoreBySession.size, 0);
  });

  test(delivery + ' newer accepted result survives an older rejection in reverse order', async () => {
    const h = harness(r3, { running: true });
    const first = await h.start(original, delivery);
    const second = await h.start(next, delivery);
    // Supply the queue snapshot accepted by the stand-in driver.
    h.store.sessionState.queuedComposerMessagesBySession.set(keyA,
      second.input.map(item => ({ ...item, attachments: [] })));
    second.response.resolve();
    await second.completion;
    assert.equal(h.drafts()[keyA], undefined);
    assert.equal(h.store.sessionState.pendingComposerDraftRestoreBySession.size, 0);

    first.response.reject(new Error(notSent));
    assert.equal((await first.completion).lastError, notSent);
    assert.equal(h.drafts()[keyA], undefined);
    assert.equal(h.drafts()[keyB], initialB);
    assert.deepEqual(queuedPayload(h), second.input);
    assert.deepEqual(rowIds(h), rowsWithPending(delivery, second));
    assert.deepEqual(h.sent.map(item => item.input[1].text), [original, next]);
    assert.equal(h.store.sessionState.pendingComposerDraftRestoreBySession.size, 0);
  });
}
