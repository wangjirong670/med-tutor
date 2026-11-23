import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CorrectionDomain, atomic, canonical } from './correction-domain.mjs';
import { readCloseRequest } from './close-request.mjs';
import { validateHostResponse, createHostLivenessBridge } from './host-liveness-bridge.mjs';
import { installProfileLockPolicy } from './profile-lock-policy.mjs';

test('bridge maps only target lock signal zero; nonzero and later calls retain original behavior', () => {
  const oldKill=process.kill;const calls=[];process.kill=(pid,signal)=>{calls.push({pid,signal});return true;};
  try {
    const profileFile=path.resolve(os.tmpdir(),'s07b-scope','profile-memory','USER.md');
    class Fixture {constructor(){this.dbPath=path.resolve(os.tmpdir(),'s07b-scope','.pi-hermes-locks.sqlite');this.probeIncarnation=()=>null;} sweepDeadLocks(){} tryAcquire(){this.probeIncarnation(123);assert.throws(()=>process.kill(123,0),error=>error.code==='ESRCH');assert.equal(process.kill(123,9),true);return true;} }
    const bridge={query:()=>({status:'absent'})};const policy=installProfileLockPolicy(Fixture,(p)=>path.resolve(p),profileFile,bridge);
    assert.equal(new Fixture().tryAcquire(policy.targetKey,{staleMs:1}),true);
    assert.equal(process.kill(123,0),true);assert.deepEqual(calls,[{pid:123,signal:9},{pid:123,signal:0}]);policy.restore();
  } finally {process.kill=oldKill;}
});

test('host liveness response must match every scope field and freshness', () => {
  const request={runId:'run',nonce:'nonce',profile:'profile',lockKey:'mutation:key',dbPath:'db',pid:123,expectedInstance:'456',issuedAtMs:1000};
  const good={...request,observedAtMs:1100,expiresAtMs:1500,status:'alive',observedInstance:'456'};
  assert.equal(validateHostResponse(good,request,1200),true);
  for(const [field,value] of [['runId','wrong'],['nonce','wrong'],['profile','wrong'],['lockKey','wrong'],['dbPath','wrong'],['pid',124],['expectedInstance','999'],['issuedAtMs',999]]) assert.equal(validateHostResponse({...good,[field]:value},request,1200),false,field);
  assert.equal(validateHostResponse(good,request,1501),false);
  assert.equal(validateHostResponse({...good,status:'reused',observedInstance:'789'},request,1200),true);
  assert.equal(validateHostResponse({...good,status:'alive',observedInstance:'999'},request,1200),false);
  assert.equal(validateHostResponse({...good,status:'absent',observedInstance:'456'},request,1200),false);
  const bridge=createHostLivenessBridge({runId:'run',profile:'profile',lockKey:'key',dbPath:'db',ownerPid:123,ownerInstance:'456',requestDir:'unused',responseDir:'unused'});
  assert.equal(bridge.query(124).status,'unknown');
});

test('missing host response returns unknown within the 500ms budget', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'s07b-r3-bridge-'));
  try {
    const req=path.join(root,'request'),res=path.join(root,'response');fs.mkdirSync(req);fs.mkdirSync(res);
    const bridge=createHostLivenessBridge({runId:'run',profile:'profile',lockKey:'key',dbPath:'db',ownerPid:123,ownerInstance:'456',requestDir:req,responseDir:res});
    const started=Date.now(),value=bridge.query(123),elapsed=Date.now()-started;
    assert.equal(value.status,'unknown');assert.equal(value.reason,'timeout');assert.ok(elapsed>=500 && elapsed<1000);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('close request retries transient EBUSY and rejects malformed JSON', async () => {
  let n=0; const read=()=>{if(++n===1)throw Object.assign(new Error('busy'),{code:'EBUSY'});return '{"runId":"r","request":"close"}';};
  const result=await readCloseRequest('fixture',{read,delay:async()=>{}});
  assert.equal(result.attempts,2); assert.equal(result.request.request,'close');
  await assert.rejects(readCloseRequest('fixture',{read:()=>'{broken',delay:async()=>{}}),/close request read failed/);
  let elapsed=0; await assert.rejects(readCloseRequest('fixture',{read:()=>{throw Object.assign(new Error('busy'),{code:'EBUSY'});},delay:async(ms)=>{elapsed+=ms;},timeoutMs:100,now:()=>elapsed}),(error)=>error.code==='EBUSY'&&error.attempts===2&&error.elapsedMs===100);
});

const makeManager = (branch, entries, sessionId = 'session_fixture') => ({
  getSessionId: () => sessionId,
  getBranch: () => branch,
  getLeafId: () => branch.at(-1)?.id ?? null,
  getEntry: (id) => entries.get(id)
});
const user = (id, parentId, content) => ({ id, parentId, type: 'message', message: { role: 'user', content } });

test('canonical authorization ignores key order but compares values and rejects extras', () => {
  assert.equal(canonical({ a: 1, b: { x: 2, y: 3 } }), canonical({ b: { y: 3, x: 2 }, a: 1 }));
  assert.notEqual(canonical({ a: 1, b: 2 }), canonical({ a: 1, b: 3 }));
});

for (const mutation of ['revoke', 'branch', 'user']) test(`async commit rechecks ${mutation}`, async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'s07b-r3-'));
  try {
    const a=user('a',null,'授权原文'); const b=user('b',null,'兄弟分支');
    let branch=[a]; const entries=new Map([['a',a],['b',b]]);
    const manager={getSessionId:()=> 'session_fixture',getBranch:()=>branch,getLeafId:()=>branch.at(-1).id,getEntry:(id)=>entries.get(id)};
    const domain=new CorrectionDomain(root);
    const payload={target:{kind:'discussion',scope:'fixture'},originalClaim:'原文',correction:'新文'};
    const grant=domain.issueHostIntent(manager,'correction_create',payload,'intent_async');
    domain.beforeCommitHook=async()=>{if(mutation==='revoke') domain.revokeIntent(grant.intentId); if(mutation==='branch') branch=[b]; if(mutation==='user') entries.set('a',user('a',null,'内容已变'));};
    await assert.rejects(domain.execute(manager,'correction_create',{intentId:grant.intentId,...payload},'call_async'));
    const state=domain.load('session_fixture'); assert.equal(state.revision,0); assert.equal(state.events.length,0); assert.equal(Object.keys(state.receipts).length,0);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('normal leaf progression during wait remains authorized', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'s07b-r3-leaf-'));
  try {
    const a=user('a',null,'授权原文'), b=user('b','a','后续消息'); let branch=[a]; const entries=new Map([['a',a],['b',b]]);
    const manager={getSessionId:()=> 'session_fixture',getBranch:()=>branch,getLeafId:()=>branch.at(-1).id,getEntry:(id)=>entries.get(id)};
    const domain=new CorrectionDomain(root);const payload={target:{kind:'discussion',scope:'fixture'},originalClaim:'原文',correction:'新文'};
    const grant=domain.issueHostIntent(manager,'correction_create',payload,'intent_leaf');domain.beforeCommitHook=async()=>{branch=[a,b];};
    const result=await domain.execute(manager,'correction_create',{intentId:grant.intentId,...payload},'call_leaf');
    assert.equal(result.ok,true);assert.equal(domain.load('session_fixture').events[0].anchor.observedLeaf,'b');
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('concurrent revision change during wait rejects original candidate', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'s07b-r3-revision-'));
  try {
    const a=user('a',null,'授权原文');const manager=makeManager([a],new Map([['a',a]]));
    const first=new CorrectionDomain(root), second=new CorrectionDomain(root);
    const payload={target:{kind:'discussion',scope:'fixture'},originalClaim:'原文',correction:'新文'};
    const g1=first.issueHostIntent(manager,'correction_create',payload,'intent_first');const g2=second.issueHostIntent(manager,'correction_create',payload,'intent_second');
    first.beforeCommitHook=async()=>{await second.execute(manager,'correction_create',{intentId:g2.intentId,...payload},'call_second');};
    await assert.rejects(first.execute(manager,'correction_create',{intentId:g1.intentId,...payload},'call_first'),/domain changed before commit/);
    const state=first.load('session_fixture');assert.equal(state.events.length,1);assert.equal(state.receipts.intent_first,undefined);assert.ok(state.receipts.intent_second);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('host intent is pinned to persisted user entry and current native ancestry', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's07b-domain-'));
  try {
    const domain = new CorrectionDomain(root);
    const entry = user('u1', null, '明确授权登记合成纠正');
    const entries = new Map([[entry.id, entry]]);
    const manager = makeManager([entry], entries);
    const grant = domain.issueHostIntent(manager, 'correction_create', { target: { kind: 'discussion', scope: 'fixture' }, correction: '合成说明' }, 'intent_fixture');
    assert.equal(domain.assertGrant(manager, 'correction_create', { intentId: grant.intentId, ...grant.payload }).payload.correction, '合成说明');
    assert.throws(() => domain.assertGrant(manager, 'correction_create', { intentId: grant.intentId, ...grant.payload, extra: true }), /payload mismatch/);
    const sibling = user('u2', null, '另一分支');
    assert.throws(() => domain.assertGrant(makeManager([sibling], new Map([[sibling.id, sibling]])), 'correction_create', { intentId: grant.intentId, ...grant.payload }), /branch anchor/);
    domain.revokeIntent(grant.intentId);
    assert.throws(() => domain.assertGrant(manager, 'correction_create', { intentId: grant.intentId, ...grant.payload }), /intent revoked/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('visible projection revalidates native user role, text hash and exact parent chain without writing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's07b-anchor-'));
  try {
    const domain = new CorrectionDomain(root);
    const entry = user('u1', null, '明确授权登记合成纠正');
    const entries = new Map([[entry.id, entry]]);
    const manager = makeManager([entry], entries);
    const payload = { target: { kind: 'discussion', scope: 'anchor-probe' }, originalClaim: '原说法', correction: '新说明' };
    const grant = domain.issueHostIntent(manager, 'correction_create', payload, 'intent_anchor_probe');
    await domain.execute(manager, 'correction_create', { intentId: grant.intentId, ...payload }, 'call_anchor_probe');
    assert.equal(domain.state(manager.getSessionId(), manager).corrections.length, 1);
    const file = domain.sessionFile(manager.getSessionId());
    const before = fs.readFileSync(file, 'utf8');
    entries.set('u1', user('u1', null, '同ID但已改变的原始内容'));
    assert.throws(() => domain.state(manager.getSessionId(), manager), /NATIVE_ANCHOR_INVALID.*role\/content hash changed/);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'invalid read must not rewrite authoritative domain state');
    entries.set('u1', { ...user('u1', null, '明确授权登记合成纠正'), message: { role: 'assistant', content: '明确授权登记合成纠正' } });
    assert.throws(() => domain.state(manager.getSessionId(), manager), /NATIVE_ANCHOR_INVALID.*role\/content hash changed/);
    entries.set('u1', entry);
    const broken = user('u1', 'missing-parent', '明确授权登记合成纠正');
    assert.throws(() => domain.state(manager.getSessionId(), makeManager([broken], new Map([['u1', broken]]))), /NATIVE_ANCHOR_INVALID.*parent chain/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('failed atomic rename preserves prior state and cleans temporary file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's07b-atomic-'));
  try {
    const file = path.join(root, 'state.json');
    atomic(file, { revision: 1 });
    const before = fs.readFileSync(file, 'utf8');
    assert.throws(() => atomic(file, { revision: 2 }, { failRename: true }), /injected rename failure/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.deepEqual(fs.readdirSync(root), ['state.json']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('corrupt domain state fails closed instead of becoming an empty study', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's07b-corrupt-'));
  try {
    const domain = new CorrectionDomain(root);
    const file = domain.sessionFile('session_fixture');
    fs.writeFileSync(file, '{broken');
    assert.throws(() => domain.load('session_fixture'), SyntaxError);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('cancelled and stale-base intents leave no domain event or receipt', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's07b-cancel-'));
  try {
    const domain = new CorrectionDomain(root);
    const entry = user('u1', null, '明确授权测试'); const manager = makeManager([entry], new Map([[entry.id, entry]]));
    const payload = { target: { kind: 'discussion', scope: 'unit-test' }, originalClaim: '原说法', correction: '新说明', verificationStatus: 'pending', unresolvedItems: [] };
    const grant = domain.issueHostIntent(manager, 'correction_create', payload, 'intent_cancelled');
    const abort = new AbortController(); abort.abort();
    await assert.rejects(domain.execute(manager, 'correction_create', { intentId: grant.intentId, ...payload }, 'call_cancelled', abort.signal), /cancelled before commit/);
    assert.equal(domain.load('session_fixture').revision, 0);
    const stale = domain.issueHostIntent(manager, 'study_submit', { baseVersion: 1, draft: {} }, 'intent_stale');
    await assert.rejects(domain.execute(manager, 'study_submit', { intentId: stale.intentId, ...stale.payload }, 'call_stale'), /STALE_BASE/);
    assert.equal(domain.load('session_fixture').events.length, 0);
    assert.equal(Object.keys(domain.load('session_fixture').receipts).length, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('rename failure is retryable; response loss after commit returns durable replay receipt', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's07b-commit-'));
  try {
    const managerEntry = user('u1', null, '明确授权测试'); const manager = makeManager([managerEntry], new Map([[managerEntry.id, managerEntry]]));
    const payload = { target: { kind: 'discussion', scope: 'unit-test' }, originalClaim: '原说法', correction: '新说明', verificationStatus: 'pending', unresolvedItems: [] };
    const domain = new CorrectionDomain(root);
    const grant = domain.issueHostIntent(manager, 'correction_create', payload, 'intent_commit');
    domain.failNextRename = true;
    await assert.rejects(domain.execute(manager, 'correction_create', { intentId: grant.intentId, ...payload }, 'call_rename_failure'), /injected rename failure/);
    assert.equal(domain.load('session_fixture').revision, 0);
    const committed = await domain.execute(manager, 'correction_create', { intentId: grant.intentId, ...payload }, 'call_retry');
    assert.equal(committed.replayed, false);
    const afterCommit = new CorrectionDomain(root, { faultAfterCommitIntent: 'intent_lost_response' });
    const lostGrant = afterCommit.issueHostIntent(manager, 'correction_create', { ...payload, correction: '中断后提交' }, 'intent_lost_response');
    await assert.rejects(afterCommit.execute(manager, 'correction_create', { intentId: lostGrant.intentId, ...lostGrant.payload }, 'call_lost_response'), /response loss after durable commit/);
    const replay = await afterCommit.execute(manager, 'correction_create', { intentId: lostGrant.intentId, ...lostGrant.payload }, 'call_replay_after_loss');
    assert.equal(replay.replayed, true);
    assert.equal(replay.historicalCommit, true);
    const state = afterCommit.load('session_fixture');
    assert.equal(state.events.length, 2);
    assert.equal(state.revision, 2);
    assert.equal(Object.keys(state.receipts).length, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
