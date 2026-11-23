import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { install } = require('./trusted-writes.cjs');

function createHarness(rpcImpl, dialogResponse = 1) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-r4-test-'));
  const prevReg = process.env.S08B_REGISTRY_DIR;
  const prevRun = process.env.S02_RUN_ID;
  process.env.S08B_REGISTRY_DIR = dir;
  process.env.S02_RUN_ID = '11111111-1111-4111-8111-111111111111';

  const handlers = new Map();
  let exitCalled = false;
  const win = { on() {} };
  const mainFrame = {};
  const stateObj = { selectedWorkspaceId: 'ws-1', selectedSessionId: 'sess-1' };
  const subscribers = [];

  const electron = {
    ipcMain: {
      handle(ch, fn) { handlers.set(ch, fn); },
      on() {},
    },
    dialog: {
      async showMessageBox() { return { response: dialogResponse }; },
    },
    app: {
      exit() { exitCalled = true; },
    },
  };
  const owners = {
    state: {
      subscribe(fn) { subscribers.push(fn); },
      async getState() { return stateObj; },
    },
  };
  const windows = {
    allWindows() { return [win]; },
    windowForSender() { return win; },
  };
  const rpcCalls = [];
  const rpc = async (method, args) => {
    rpcCalls.push({ method, args });
    return rpcImpl(method, args);
  };

  install({
    electron,
    owners,
    windows,
    rpc,
    ready: () => ({ runId: '22222222-2222-4222-8222-222222222222', pid: process.pid }),
    clientId: '33333333-3333-4333-8333-333333333333',
  });

  const event = { sender: { mainFrame }, senderFrame: mainFrame };
  const cleanup = () => {
    if (prevReg === undefined) delete process.env.S08B_REGISTRY_DIR;
    else process.env.S08B_REGISTRY_DIR = prevReg;
    if (prevRun === undefined) delete process.env.S02_RUN_ID;
    else process.env.S02_RUN_ID = prevRun;
    fs.rmSync(dir, { recursive: true, force: true });
  };

  return {
    dir,
    handlers,
    event,
    rpcCalls,
    get exitCalled() { return exitCalled; },
    cleanup,
  };
}

test('trusted-writes completes study_submit via prepare -> commit without watch ACK files', async () => {
  const h = createHarness(async (method) => {
    if (method === 'workbench.study.state') return { currentVersion: 0, branch: { leafId: 'leaf-1' }, corrections: [] };
    if (method === 'workbench.draft.prepare') return { prepared: true };
    if (method === 'workbench.draft.commit') return { version: 1, draftId: 'd-1' };
    throw new Error(`unexpected rpc: ${method}`);
  });
  try {
    const res = await h.handlers.get('learning:study:save')(h.event, { title: '测试标题', text: '测试内容' });
    assert.deepEqual(res, { cancelled: false, result: { version: 1, draftId: 'd-1' } });
    assert.equal(h.exitCalled, false);
    assert.deepEqual(h.rpcCalls.map((c) => c.method), [
      'workbench.study.state',
      'workbench.study.state',
      'workbench.draft.prepare',
      'workbench.draft.commit',
    ]);
    const files = fs.readdirSync(h.dir);
    assert.ok(files.some((f) => f.endsWith('.consumed.json')));
    assert.equal(files.some((f) => f.startsWith('ui-watch-') || f.startsWith('ui-stop-')), false);
  } finally {
    h.cleanup();
  }
});

test('trusted-writes never exits app or kills worker when commit fails with no-receipt', async () => {
  let commits = 0;
  const h = createHarness(async (method) => {
    if (method === 'workbench.study.state') return { currentVersion: 0, branch: { leafId: 'leaf-1' }, corrections: [] };
    if (method === 'workbench.draft.prepare') return { prepared: true };
    if (method === 'workbench.draft.commit') {
      commits++;
      if (commits === 1) throw new Error('STALE_BASE');
      return { version: 1, draftId: 'd-2' };
    }
    if (method === 'workbench.recovery.inspect') {
      const files = fs.readdirSync(h.dir);
      const claimFile = files.find((f) => f.endsWith('.claimed.json'));
      const claim = JSON.parse(fs.readFileSync(path.join(h.dir, claimFile), 'utf8'));
      return { status: 'no-receipt', contentHash: claim.contentHash, anchorId: 'anchor-1' };
    }
    throw new Error(`unexpected rpc: ${method}`);
  });
  try {
    await assert.rejects(
      h.handlers.get('learning:study:save')(h.event, { title: '标题', text: '正文' }),
      /STALE_BASE/,
    );
    assert.equal(h.exitCalled, false);
    const files = fs.readdirSync(h.dir);
    assert.equal(files.some((f) => f.startsWith('ui-stop-')), false);
    assert.ok(files.some((f) => f.endsWith('.revoked.json')));

    // User can immediately retry without being blocked by an unresolved claimed record
    const retryRes = await h.handlers.get('learning:study:save')(h.event, { title: '标题2', text: '正文2' });
    assert.deepEqual(retryRes, { cancelled: false, result: { version: 1, draftId: 'd-2' } });
  } finally {
    h.cleanup();
  }
});

test('trusted-writes reconciles committed receipt if commit reply throws after durable commit', async () => {
  const h = createHarness(async (method) => {
    if (method === 'workbench.study.state') return { currentVersion: 0, branch: { leafId: 'leaf-1' }, corrections: [] };
    if (method === 'workbench.draft.prepare') return { prepared: true };
    if (method === 'workbench.draft.commit') throw new Error('Injected reply loss');
    if (method === 'workbench.recovery.inspect') {
      const files = fs.readdirSync(h.dir);
      const claimFile = files.find((f) => f.endsWith('.claimed.json'));
      const claim = JSON.parse(fs.readFileSync(path.join(h.dir, claimFile), 'utf8'));
      return { status: 'committed', contentHash: claim.contentHash, anchorId: 'anchor-1', result: { version: 2, draftId: 'd-ok' } };
    }
    throw new Error(`unexpected rpc: ${method}`);
  });
  try {
    const res = await h.handlers.get('learning:study:save')(h.event, { title: '标题', text: '正文' });
    assert.deepEqual(res, { cancelled: false, result: { version: 2, draftId: 'd-ok' } });
    assert.equal(h.exitCalled, false);
    const files = fs.readdirSync(h.dir);
    assert.ok(files.some((f) => f.endsWith('.consumed.json')));
  } finally {
    h.cleanup();
  }
});

test('s07b-extension skips host-liveness-bridge when S07B_BRIDGE_REQUEST_DIR is unset', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 's07b-ext-test-'));
  const prevRoot = process.env.S07B_DATA_ROOT;
  const prevSrc = process.env.S07B_SOURCE;
  const prevReq = process.env.S07B_BRIDGE_REQUEST_DIR;
  process.env.S07B_DATA_ROOT = dataRoot;
  process.env.S07B_SOURCE = path.resolve('scripts/pi-migration/s07/restore-r2/src/pi-gui');
  delete process.env.S07B_BRIDGE_REQUEST_DIR;
  try {
    const ext = await import('./s07b-extension.mjs');
    assert.equal(ext.getHostBridgeForWorker(), null);
    assert.equal(ext.currentToolNames().length, 19);
  } finally {
    if (prevRoot === undefined) delete process.env.S07B_DATA_ROOT;
    else process.env.S07B_DATA_ROOT = prevRoot;
    if (prevSrc === undefined) delete process.env.S07B_SOURCE;
    else process.env.S07B_SOURCE = prevSrc;
    if (prevReq !== undefined) process.env.S07B_BRIDGE_REQUEST_DIR = prevReq;
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('worker.mjs starts cleanly without host registration or ACL forgery shackle and shuts down gracefully', async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-worker-smoke-'));
  const scriptDir = path.resolve('scripts/pi-migration/s08/learning-workbench-r4');
  const source = path.resolve('scripts/pi-migration/s07/restore-r2/src/pi-gui');
  const runId = '44444444-4444-4444-8444-444444444444';
  const clientId = '55555555-5555-4555-8555-555555555555';
  const reqId = '66666666-6666-4666-8666-666666666666';

  for (const d of ['profile/agent', 'profile/electron', 'home', 'tmp', 'logs', 'workspace']) {
    fs.mkdirSync(path.join(sandbox, d), { recursive: true });
  }
  fs.copyFileSync(path.join(scriptDir, 'method-context.json'), path.join(sandbox, 'method-context.json'));

  const child = spawn(
    process.execPath,
    ['--preserve-symlinks', '--preserve-symlinks-main', path.join(scriptDir, 'worker.mjs')],
    {
      cwd: sandbox,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: path.join(sandbox, 'profile/agent'),
        PI_APP_USER_DATA_DIR: path.join(sandbox, 'profile/electron'),
        PI_APP_INITIAL_WORKSPACES: path.join(sandbox, 'workspace'),
        S02_RUN_ID: runId,
        S07B_RUN_ID: runId,
        S07B_PHASE: 'test',
        S07B_SANDBOX: sandbox,
        S07B_SOURCE: source,
        // Intentionally omit S07C_REGISTRY_DIR and S07B_BRIDGE_REQUEST_DIR
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  try {
    const readyFile = path.join(sandbox, 'mailbox/ready.json');
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(readyFile) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(fs.existsSync(readyFile), true, `worker did not become ready; stderr=${stderr}`);
    const canary = JSON.parse(fs.readFileSync(path.join(sandbox, 'logs/worker-canary.json'), 'utf8'));
    assert.equal(canary.passed, true);

    const inboxReq = path.join(sandbox, 'mailbox', runId, 'requests', `0000000001-${reqId}.json`);
    fs.writeFileSync(inboxReq, JSON.stringify({
      runId,
      clientId,
      id: reqId,
      seq: 1,
      method: 'worker.shutdown',
      args: [],
    }));

    const exitCode = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('worker shutdown timeout')), 10000);
      child.on('exit', (code) => { clearTimeout(t); resolve(code); });
    });
    assert.equal(exitCode, 0);
    assert.equal(fs.existsSync(path.join(sandbox, 'logs/worker-close-ack.json')), true);
  } finally {
    if (child.exitCode === null) child.kill();
    await new Promise((r) => setTimeout(r, 100));
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
