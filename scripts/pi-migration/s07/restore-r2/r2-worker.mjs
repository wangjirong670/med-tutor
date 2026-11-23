import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import dgram from 'node:dgram';
import cp from 'node:child_process';
import {syncBuiltinESMExports, createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = path.resolve(process.env.R2_SANDBOX ?? process.cwd());
const source = path.resolve(process.env.R2_SOURCE ?? '');
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const resultPath = path.join(root, 'worker-result.json');
const runId = process.env.S07A_R2_RUN_ID;
const attempts = [];
const events = [];
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const record = (name, args = []) => {
  const error = new Error(`S07A offline guard denied ${name}`);
  error.code = 'S07A_OFFLINE';
  attempts.push({name, at: new Date().toISOString(), code: error.code, command: name === 'child_process.spawnSync' ? String(args[0]) : undefined, stack: error.stack});
  throw error;
};
const deny = name => (...args) => record(name, args);

for (const [label, mod, keys] of [
  ['http', http, ['request', 'get']], ['https', https, ['request', 'get']],
  ['net', net, ['connect', 'createConnection']], ['tls', tls, ['connect']],
  ['dns', dns, ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny']],
  ['dgram', dgram, ['createSocket']],
  ['child_process', cp, ['spawn', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']],
]) for (const key of keys) mod[key] = deny(`${label}.${key}`);
cp.spawnSync = (...args) => {
  try { return record('child_process.spawnSync', args); }
  catch (error) { return {pid: 0, status: null, signal: null, stdout: '', stderr: '', output: [null, '', ''], error}; }
};
net.Socket.prototype.connect = deny('Socket.connect');
for (const key of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny']) {
  if (dns.promises[key]) dns.promises[key] = async (...args) => record(`dns.promises.${key}`, args);
}
globalThis.fetch = async (...args) => record('fetch', args);
if (globalThis.WebSocket) globalThis.WebSocket = class { constructor(...args) { record('WebSocket', args); } };
syncBuiltinESMExports();

function json(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(value, null, 2), {flag: 'w'});
}
function probeSync(name, fn) {
  try { fn(); return {name, denied: false}; }
  catch (error) { return {name, denied: error.code === 'S07A_OFFLINE', code: error.code ?? null}; }
}
async function probeAsync(name, fn) {
  try { await fn(); return {name, denied: false}; }
  catch (error) { return {name, denied: error.code === 'S07A_OFFLINE', code: error.code ?? null}; }
}

let session;
let runtime;
let result = {runId, pid: process.pid, startedAt: new Date().toISOString(), node: process.version, nodeAbi: process.versions.modules, napi: process.versions.napi, probes: [], fixtureRequests: [], realProviderRequests: 0, embeddingRequests: 0, titleOverrideCalls: 0, loaderErrors: [], extensionErrors: [], tools: [], events};
try {
  if (!runId || !fs.realpathSync.native(root).startsWith(path.resolve(root))) throw new Error('worker root or run ID invalid');
  const agentDir = path.resolve(process.env.PI_CODING_AGENT_DIR ?? '');
  if (!agentDir.startsWith(root + path.sep)) throw new Error('agent directory escaped synthetic profile');
  const methodPath = path.join(root, 'method-context.json');
  const methodBytes = fs.readFileSync(methodPath);
  const method = JSON.parse(methodBytes.toString('utf8'));
  if (method.mode !== 'source' || !method.mapping?.mappedRepo) throw new Error('mapped method context identity missing');
  result.method = {path: methodPath, sha256: sha256(methodBytes), mode: method.mode, sourceCount: method.sources?.length, anchorFileCount: method.anchorFiles?.length};

  const canaries = [
    await probeAsync('fetch', () => globalThis.fetch('https://example.invalid/')),
    probeSync('http', () => http.request('http://127.0.0.1:9/never')),
    probeSync('https', () => https.request('https://127.0.0.1:9/never')),
    probeSync('tcp', () => net.connect(9, '127.0.0.1')),
    probeSync('tls', () => tls.connect(9, '127.0.0.1')),
    probeSync('dns', () => dns.lookup('example.invalid', () => {})),
    probeSync('udp', () => dgram.createSocket('udp4')),
    (() => { const response = cp.spawnSync('node', ['--version']); return {name: 'child_process', denied: response.error?.code === 'S07A_OFFLINE', code: response.error?.code ?? null}; })(),
  ];
  result.probes = canaries;
  if (!canaries.every(item => item.denied)) throw new Error('offline guard canary failed before SDK load');
  attempts.length = 0;

  const sdkEntry = path.join(source, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js');
  const aiEntry = path.join(source, 'node_modules/@earendil-works/pi-ai/dist/compat.js');
  const memoryEntry = path.join(source, 'packages/hermes-memory/dist/index.js');
  const sqliteEntry = path.join(source, 'node_modules/better-sqlite3/prebuilds/win32-x64.node');
  const sdk = await import(pathToFileURL(sdkEntry));
  const ai = await import(pathToFileURL(aiEntry));
  const memoryModule = await import(pathToFileURL(memoryEntry));
  const memory = memoryModule.default;
  if (typeof memory !== 'function') throw new Error('Hermes MemoryStore extension export missing');
  const require = createRequire(import.meta.url);
  const Database = require(path.join(source, 'node_modules/better-sqlite3'));
  const db = new Database(':memory:');
  const sqliteVersion = db.prepare('SELECT sqlite_version() AS version').get().version;
  db.close();
  result.loaded = {
    piSdk: {entry: sdkEntry, version: JSON.parse(fs.readFileSync(path.join(source, 'node_modules/@earendil-works/pi-coding-agent/package.json'), 'utf8')).version, sha256: sha256(fs.readFileSync(sdkEntry))},
    piAi: {entry: aiEntry, version: JSON.parse(fs.readFileSync(path.join(source, 'node_modules/@earendil-works/pi-ai/package.json'), 'utf8')).version, sha256: sha256(fs.readFileSync(aiEntry))},
    memoryStore: {entry: memoryEntry, version: JSON.parse(fs.readFileSync(path.join(source, 'packages/hermes-memory/package.json'), 'utf8')).version, sha256: sha256(fs.readFileSync(memoryEntry))},
    sqlite: {entry: sqliteEntry, sha256: sha256(fs.readFileSync(sqliteEntry)), sqliteVersion, nodeAbi: process.versions.modules, napi: process.versions.napi},
  };

  const workerAgentDir = path.resolve(process.env.PI_CODING_AGENT_DIR);
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, {recursive: true});
  fs.mkdirSync(workerAgentDir, {recursive: true});
  fs.writeFileSync(path.join(workerAgentDir, 'auth.json'), '{}');
  fs.writeFileSync(path.join(workerAgentDir, 'models.json'), '{}');
  fs.writeFileSync(path.join(workerAgentDir, 'hermes-memory-config.json'), JSON.stringify({reviewEnabled: false, flushOnCompact: false, flushOnShutdown: false, correctionDetection: false, autoConsolidate: false, memoryOverflowStrategy: 'reject', memoryDir: path.join(root, 'memory'), projectsMemoryDir: 'fixture-projects'}));
  const settings = sdk.SettingsManager.inMemory({compaction: {enabled: false}, retry: {enabled: false}, cacheWarming: 'off'});
  runtime = await sdk.ModelRuntime.create({authPath: path.join(workerAgentDir, 'auth.json'), modelsPath: path.join(workerAgentDir, 'models.json'), refreshOnCreate: false});
  runtime.registerProvider('r2-fixture', {
    baseUrl: 'http://127.0.0.1:9/never-used', apiKey: 'R2-SYNTHETIC-ONLY', api: 'r2-fixture-api',
    models: [{id: 'fixture', name: 'R2 synthetic fixture', reasoning: false, input: ['text'], cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}, contextWindow: 32768, maxTokens: 1024}],
    streamSimple(model, context) {
      result.fixtureRequests.push({provider: model.provider, model: model.id, messageCount: context.messages.length});
      const stream = ai.createAssistantMessageEventStream();
      const useTool = result.fixtureRequests.length === 1;
      const message = {role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: useTool ? [{type: 'toolCall', id: 'r2-memory-call', name: 'memory_add', arguments: {target: 'memory', content: 'R2 synthetic preference'}}] : [{type: 'text', text: 'R2 合成回复'}], stopReason: useTool ? 'toolUse' : 'stop', usage: {input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}, timestamp: Date.now()};
      queueMicrotask(() => {
        stream.push({type: 'start', partial: message});
        if (!useTool) { stream.push({type: 'text_start', contentIndex: 0, partial: message}); stream.push({type: 'text_delta', contentIndex: 0, delta: 'R2 合成回复', partial: message}); stream.push({type: 'text_end', contentIndex: 0, content: 'R2 合成回复', partial: message}); }
        stream.push({type: 'done', reason: message.stopReason, message});
      });
      return stream;
    },
  });
  await runtime.refresh({allowNetwork: false});
  const loader = new sdk.DefaultResourceLoader({cwd: workspace, agentDir: workerAgentDir, settingsManager: settings, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true, extensionFactories: [memory], systemPrompt: 'R2 synthetic offline fixture; method supplied by verified mapping.'});
  await loader.reload();
  result.loaderErrors = loader.getExtensions().errors;
  result.extensions = loader.getExtensions().extensions.map(item => ({path: item.path, tools: [...item.tools.keys()]}));
  const created = await sdk.createAgentSession({cwd: workspace, agentDir: workerAgentDir, modelRuntime: runtime, model: runtime.getModel('r2-fixture', 'fixture'), settingsManager: settings, resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(), tools: ['memory_*', 'session_search']});
  session = created.session;
  session.subscribe(event => events.push(event.type));
  await session.bindExtensions({onError: error => result.extensionErrors.push(String(error))});
  result.tools = session.getAllTools().map(tool => tool.name);
  await session.prompt('R2 synthetic fixture only. Use the provided memory tool.');
  result.messages = session.messages.map(message => ({role: message.role, content: message.content, isError: message.isError}));
  const {DatabaseManager} = await import(pathToFileURL(path.join(source, 'packages/hermes-memory/dist/store/db.js')));
  const manager = new DatabaseManager(path.join(root, 'memory'));
  try {
    const database = manager.getDb();
    result.memoryStore = {rows: database.prepare('SELECT content FROM memories').all(), quickCheck: database.prepare('PRAGMA quick_check').all()};
  } finally { manager.close(); }
  result.settings = {retry: settings.getRetryEnabled(), compaction: settings.getCompactionEnabled(), cacheWarming: settings.getCacheWarmingMode()};

  const {Materials} = await import(pathToFileURL(path.join(scriptDir, 'materials.mjs')));
  const staging = path.join(root, 'staging');
  fs.mkdirSync(staging, {recursive: true});
  const materialFile = path.join(staging, 'r2-synthetic-material.md');
  fs.writeFileSync(materialFile, '合成材料：仅用于离线导入与局部读取验证。\n第二段包含固定测试文本。\n');
  const materials = new Materials(path.join(root, 'materials'));
  const receiptId = materials.stageBytes(path.basename(materialFile), fs.readFileSync(materialFile), 'r2-synthetic-session');
  const imported = materials.importReceipt('r2-synthetic-session', receiptId);
  const partial = materials.read('r2-synthetic-session', imported.materialId, imported.versionId, 0, 12);
  result.material = {receiptId, imported, partial, sourcePath: materialFile, fullTextBytes: fs.statSync(materialFile).size};

  result.guardAttemptsAfterRun = attempts.filter(attempt => !(attempt.name === 'child_process.spawnSync' && attempt.command === 'powershell.exe' && String(attempt.stack).includes('probeProcessIncarnation')));
  result.passed = result.method.mode === 'source' && result.method.sourceCount === 2 && result.probes.length === 8 && result.probes.every(item => item.denied) && result.loaderErrors.length === 0 && result.extensionErrors.length === 0 && result.fixtureRequests.length === 2 && result.realProviderRequests === 0 && result.embeddingRequests === 0 && result.tools.includes('memory_add') && session.messages.some(message => message.role === 'toolResult' && !message.isError) && result.memoryStore.rows.some(row => row.content === 'R2 synthetic preference') && result.memoryStore.quickCheck.every(row => row.quick_check === 'ok') && result.settings.retry === false && result.settings.compaction === false && result.settings.cacheWarming === 'off' && imported.bytes > 0 && partial.text.startsWith('合成材料') && result.guardAttemptsAfterRun.length === 0;
} catch (error) {
  result.error = String(error);
  result.stack = error.stack;
  result.passed = false;
}
try { session?.dispose(); } catch (error) { result.disposeError = String(error); result.passed = false; }
result.endedAt = new Date().toISOString();
json(resultPath, result);
json(path.join(root, 'worker-ready.json'), {runId, pid: process.pid, at: result.endedAt, passed: result.passed});

const closePath = path.join(root, 'close-request.json');
const closeAck = path.join(root, 'close-ack.json');
const deadline = Date.now() + 60000;
while (!fs.existsSync(closePath) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
if (!fs.existsSync(closePath)) {
  json(closeAck, {runId, pid: process.pid, closed: false, error: 'protocol close timeout'});
  process.exitCode = 94;
} else {
  const request = JSON.parse(fs.readFileSync(closePath, 'utf8').replace(/^\uFEFF/, ''));
  if (request.runId !== runId) {
    json(closeAck, {runId, pid: process.pid, closed: false, error: 'run ID mismatch'});
    process.exitCode = 95;
  } else {
    json(closeAck, {runId, pid: process.pid, closed: true, at: new Date().toISOString(), disposed: true});
    process.exitCode = result.passed ? 0 : 1;
  }
}
