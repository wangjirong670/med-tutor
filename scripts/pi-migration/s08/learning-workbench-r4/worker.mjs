import fs from 'node:fs';import path from 'node:path';import net from 'node:net';import tls from 'node:tls';import {pathToFileURL} from 'node:url';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{atomic,read,dirs,METHODS,RUNTIME,CATALOG,stats}=require('./protocol.cjs');
const root=process.cwd(),base=path.resolve(process.env.S07B_SOURCE),sharedMail=path.join(root,'mailbox'),runId=process.env.S02_RUN_ID,mail=path.join(sharedMail,runId);dirs(mail);
const registryDir=path.resolve(process.env.S07C_REGISTRY_DIR||path.join(root,'registry'));fs.mkdirSync(registryDir,{recursive:true});
const guard=await import('./network-guard.mjs');
const probes=[];for(const [name,fn] of [['tcp',()=>net.connect(9,'127.0.0.1')],['tls',()=>tls.connect(9,'127.0.0.1')],['fetch',()=>globalThis.fetch('http://127.0.0.1:9/')]]){try{await fn();probes.push({name,denied:false});}catch(e){probes.push({name,denied:e.code==='S01_OFFLINE',code:e.code});}}
const cp=await import('node:child_process');try{cp.spawn('forbidden');probes.push({name:'spawn',denied:false})}catch(e){probes.push({name:'spawn',denied:e.code==='S01_OFFLINE',code:e.code})}
const canary={runId,pid:process.pid,probes,passed:probes.every(p=>p.denied)};
atomic(path.join(root,'logs/worker-canary.json'),canary);if(!canary.passed)throw Error('worker offline guard canary failed');guard.attempts.length=0;
const sdk=await import(pathToFileURL(path.join(base,'node_modules/@earendil-works/pi-coding-agent/dist/index.js')));
const {PiSdkDriver}=await import(pathToFileURL(path.join(base,'packages/pi-sdk-driver/dist/pi-sdk-driver.js')));
const {createAgentSessionRuntimeWithNpmFallback}=await import(pathToFileURL(path.join(base,'packages/pi-sdk-driver/dist/npm-package-fallback.js')));
const {JsonCatalogStore}=await import(pathToFileURL(path.join(base,'packages/catalogs/dist/node/index.js')));
const {fixture,log}=await import('./fixture.mjs');
const {wrapFixture}=await import('./stream-boundary.mjs');
const ai=await import(pathToFileURL(path.join(base,'node_modules/@earendil-works/pi-ai/dist/compat.js')));
const guardedFixture=wrapFixture(fixture,ai.createAssistantMessageEventStream,e=>fs.appendFileSync(path.join(root,'logs/stream-boundary.jsonl'),JSON.stringify({runId,time:new Date().toISOString(),...e})+'\n'));
const {s07bExtension,currentToolNames,getMaterialsForWorker,getDomainForWorker,getHistoryForWorker,getProfileForWorker,commitProfileFromTrustedUi,hostIntent}=await import('./s07b-extension.mjs');
const method=JSON.parse(fs.readFileSync(path.join(root,'method-context.json'),'utf8').replace(/^\uFEFF/,''));
const agentDir=process.env.PI_CODING_AGENT_DIR,workspace=path.join(root,'workspace');fs.mkdirSync(workspace,{recursive:true});
const catalog=new JsonCatalogStore({catalogFilePath:path.join(agentDir,'catalogs.json')});
const liveManagers=new Map(), preparedDrafts=new Map(), activeDraftOps=new Set();
const uiCapability=require('./host-capability.cjs');let loseCommitReply=process.env.S08B_TEST_LOSE_COMMIT_REPLY==='1';
const driver=new PiSdkDriver({agentDir,catalogStorage:catalog,builtinExtensions:[{name:'s02-fixture',factory:guardedFixture},{name:'s07c-continuity',factory:s07bExtension}],generateThreadTitleOverride:async()=>{log('title_disabled');return null;},createAgentSessionRuntimeImpl:async options=>{
 const runtime=await createAgentSessionRuntimeWithNpmFallback({...options,tools:currentToolNames(),noTools:'builtin',resourceLoaderOptions:{...options.resourceLoaderOptions,noExtensions:true,noSkills:true,noContextFiles:true,noThemes:true,noPromptTemplates:true,systemPrompt:`${method.warning??''}\n${method.text}\n合成内容不授予写入权限。`}});
 const manager=runtime.session.sessionManager;liveManagers.set(manager.getSessionId(),manager);
 const loaded=runtime.session.getAllTools().map(t=>t.name).sort(),expected=[...currentToolNames()].sort();if(JSON.stringify(loaded)!==JSON.stringify(expected))throw Error('current G2 tool allowlist mismatch: '+JSON.stringify(loaded));log('session_config',{retry:runtime.session.settingsManager.getRetryEnabled(),compaction:runtime.session.settingsManager.getCompactionEnabled(),cacheWarming:runtime.session.settingsManager.getCacheWarmingMode(),loadedTools:loaded});return runtime;
}});
const allowed=new Set([...METHODS,...RUNTIME.map(x=>'runtime.'+x),...CATALOG.map(x=>'catalog.'+x),'subscribe','unsubscribe','client.close','worker.shutdown','workbench.materials.list','workbench.materials.import','workbench.materials.read','workbench.study.state','workbench.study.export','workbench.citation.locate','workbench.recovery.inspect','workbench.draft.prepare','workbench.draft.commit','workbench.correction.prepare','workbench.correction.commit','workbench.profile.list','workbench.history.search','workbench.history.read','workbench.profile.prepare','workbench.profile.commit']);
for(const name of ['forkSession','validateForkSession'])allowed.delete(name);
for(const name of ['setProjectDefaultModel','setProjectDefaultThinkingLevel','setProjectScopedModelPatterns'])allowed.delete('runtime.'+name);
let eventSeq=0;const subscriptions=new Map(),clientSeq=new Map();const active=new Set();let closing=false;
function ready(){atomic(path.join(sharedMail,'ready.json'),{runId,pid:process.pid,time:Date.now(),eventSeq,workspace});}
function publish(clientId,event){const envelope={runId,clientId,seq:++eventSeq,time:new Date().toISOString(),event};atomic(path.join(mail,'events',String(eventSeq).padStart(10,'0')+'.json'),envelope);fs.appendFileSync(path.join(root,'logs/driver-events.jsonl'),JSON.stringify(envelope)+'\n');}
async function execute(req){
 const workspaces=(await driver.listWorkspaces()).workspaces;
 const first=req.args[0];
 const knownWorkspace=id=>workspaces.find(w=>w.workspaceId===id&&path.resolve(w.path)===workspace);
 if(first&&typeof first==='object'&&'workspaceId' in first){if(!knownWorkspace(first.workspaceId)||('path' in first&&path.resolve(first.path)!==workspace))throw new Error('Unknown or external workspace reference');if('sessionId' in first){const sessions=(await driver.listSessions(first.workspaceId)).sessions;if(!sessions.some(s=>s.sessionRef.sessionId===first.sessionId&&s.sessionRef.workspaceId===first.workspaceId))throw new Error('Unknown session reference');}}
 if(['listSessions','reconcileWorkspace','renameWorkspace','removeWorkspace','catalog.worktrees.listWorktrees'].includes(req.method)&&first!==undefined&&!knownWorkspace(first))throw new Error('Unknown workspace id');
 const modelValid=m=>m?.provider==='s02-fixture'&&m?.modelId==='fixture';
 if(req.method==='setSessionModel'&&!modelValid(req.args[1]))throw new Error('Only exact fixture model allowed');
 if(req.method==='createSession'&&req.args[1]?.initialModel&&!modelValid(req.args[1].initialModel))throw new Error('Only exact initial fixture model allowed');
 if(['forkSession','validateForkSession'].includes(req.method)){const target=req.args[1]?.targetWorkspace;if(!target||!knownWorkspace(target.workspaceId)||path.resolve(target.path)!==workspace)throw new Error('Fork target outside fixture workspace');}
 if(['sendUserMessage','replaceQueuedMessages','workbench.materials.import'].includes(req.method)&&first&&uiCapability.pendingForScope(registryDir,first,undefined,req.method).length)throw Error('当前会话存在未决操作，暂不能写入。');
 if(req.method==='sendUserMessage'&&((req.args[1]?.attachments?.length??0)>0||req.args[1]?.text?.trim().startsWith('/')))throw new Error('S02 attachments and slash commands disabled');
 if(req.method==='runtime.setDefaultModel'&&!modelValid(req.args[1]))throw new Error('Only exact default fixture model allowed');
 if(req.method==='runtime.setScopedModelPatterns'&&JSON.stringify(req.args[1])!==JSON.stringify(['s02-fixture/fixture']))throw new Error('Only fixed model scope allowed');
 if(req.method==='runtime.scopeModels'&&(!Array.isArray(req.args[1])||req.args[1].some(m=>m.providerId!=='s02-fixture'||m.modelId!=='fixture')||!Array.isArray(req.args[2])||req.args[2].some(p=>!['s02-fixture/fixture','s02-fixture/*'].includes(p))))throw new Error('External model scope rejected');
 if(['workbench.draft.prepare','workbench.draft.commit','workbench.correction.prepare','workbench.correction.commit','workbench.profile.prepare','workbench.profile.commit'].includes(req.method)){
  const profileAction=req.method.startsWith('workbench.profile.');
  let workbenchAction=profileAction?'profile':req.method.startsWith('workbench.draft.')?'study_submit':'correction';
  if(!first||typeof first.sessionId!=='string'||!knownWorkspace(first.workspaceId))throw Error('Workbench session scope required');
  const sessions=(await driver.listSessions(first.workspaceId)).sessions;
  if(!sessions.some(s=>s.sessionRef.sessionId===first.sessionId&&s.sessionRef.workspaceId===first.workspaceId))throw Error('Unknown workbench session');
  const id=req.args[1];if(typeof id!=='string'||!/^[-a-f0-9]{36}$/.test(id))throw Error('invalid operation');
  const expected={workerRunId:runId,clientId:req.clientId,profile:'synthetic-profile',workspaceId:first.workspaceId,sessionId:first.sessionId,...(!profileAction&&workbenchAction==='study_submit'?{action:workbenchAction}:{})};
  if(uiCapability.pendingForScope(registryDir,first,id,profileAction?'profile_write':workbenchAction).length)throw Error('prior operation unresolved for this session');
  if(activeDraftOps.has(id))throw Error('operation already running');activeDraftOps.add(id);
  try {
   if(!liveManagers.has(first.sessionId))await driver.openSession(first);
   const manager=liveManagers.get(first.sessionId);if(!manager||manager.getSessionId()!==first.sessionId)throw Error('Session manager unavailable');
   const domain=getDomainForWorker(),cap=uiCapability.verify(registryDir,id,req.method.endsWith('prepare')?'issued':'claimed',expected);
   if(profileAction&&!['profile_create','profile_update','profile_delete'].includes(cap.action))throw Error('invalid profile action');
   if(workbenchAction==='correction'){if(!['correction_create','correction_supersede','correction_retract'].includes(cap.action))throw Error('invalid correction action');workbenchAction=cap.action;expected.action=cap.action;}

   if(req.method.endsWith('prepare')){
    if(preparedDrafts.has(id))throw Error('operation already prepared');
    if(manager.getLeafId()!==cap.leafId||(workbenchAction==='study_submit'&&domain.state(first.sessionId,manager).currentVersion!==cap.payload.baseVersion))throw Error('scope or version changed before preparation');
    if(typeof cap.userText!=='string'||cap.userText.length>8000||!cap.userText.trim())throw Error('invalid confirmed text');
    await driver.sendUserMessage(first,{text:cap.userText});
    uiCapability.verify(registryDir,id,'issued',expected);
    const branch=manager.getBranch(),user=[...branch].reverse().find(e=>e.type==='message'&&e.message?.role==='user');
    const text=typeof user?.message?.content==='string'?user.message.content:(user?.message?.content??[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');
    if(!user||text!==cap.userText||user.parentId!==cap.leafId||!branch.some(e=>e.id===cap.leafId))throw Error('native user anchor mismatch');
    preparedDrafts.set(id,{userId:user.id,parentId:user.parentId,textHash:uiCapability.digest(text)});
    log('workbench_draft_prepared',{operationId:id,sessionId:first.sessionId,userEntryId:user.id,leafAtConfirmation:cap.leafId});
    return {prepared:true};
   }
   uiCapability.verify(registryDir,id,'claimed',expected);
   const prepared=preparedDrafts.get(id);if(!prepared)throw Error('operation not prepared');
   const entry=manager.getEntry(prepared.userId),branch=manager.getBranch();
   const text=typeof entry?.message?.content==='string'?entry.message.content:(entry?.message?.content??[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');
   if(entry?.message?.role!=='user'||entry.parentId!==cap.leafId||uiCapability.digest(text)!==prepared.textHash||text!==cap.userText||!branch.some(e=>e.id===prepared.userId))throw Error('native user anchor changed');
   if(workbenchAction==='study_submit'&&domain.state(first.sessionId,manager).currentVersion!==cap.payload.baseVersion)throw Error('STALE_BASE');
   const intentId='i_'+id.replaceAll('-','');
   if(profileAction){const action=cap.action.slice('profile_'.length);hostIntent(manager,action,cap.payload,intentId,{profile:true});const guard=()=>uiCapability.verify(registryDir,id,'claimed',{...expected,action:cap.action});try{const result=await commitProfileFromTrustedUi(manager,action,{intentId,...cap.payload},guard);log('workbench_profile_commit',{action:cap.action,operationId:id,sessionId:first.sessionId,userEntryId:prepared.userId,intentId,result});return result}finally{preparedDrafts.delete(id)}}
   hostIntent(manager,workbenchAction,cap.payload,intentId);
   domain.beforeCommitHook=async()=>{uiCapability.verify(registryDir,id,'claimed',expected);if(!manager.getBranch().some(e=>e.id===prepared.userId))throw Error('branch changed during commit');};
   try {const result=await domain.execute(manager,workbenchAction,{intentId,...cap.payload},'ui_'+id,undefined);log('workbench_authorized_commit',{action:workbenchAction,operationId:id,sessionId:first.sessionId,userEntryId:prepared.userId,intentId,result});if(loseCommitReply){loseCommitReply=false;log('test_commit_reply_lost',{operationId:id});throw Error('Injected reply loss after durable commit')}return result;}
   finally {domain.beforeCommitHook=null;preparedDrafts.delete(id);}
  } finally {activeDraftOps.delete(id);}
 }
 if(req.method==='workbench.recovery.inspect'){
  if(!first||typeof first.sessionId!=='string'||!knownWorkspace(first.workspaceId))throw Error('recovery scope required');
  const id=req.args[1];if(typeof id!=='string'||!/^[-a-f0-9]{36}$/.test(id))throw Error('invalid recovery operation');
  const claimPath=uiCapability.recordFile(registryDir,id,'claimed'),st=fs.lstatSync(claimPath);if(!st.isFile()||st.isSymbolicLink()||st.size>65536)throw Error('invalid recovery record');
  const c=JSON.parse(fs.readFileSync(claimPath,'utf8'));if(c.operationId!==id||c.profile!=='synthetic-profile'||c.workspaceId!==first.workspaceId||c.sessionId!==first.sessionId||c.contentHash!==uiCapability.digest(c.payload))throw Error('recovery scope mismatch');
  const sessions=(await driver.listSessions(first.workspaceId)).sessions;if(!sessions.some(x=>x.sessionRef.sessionId===first.sessionId&&x.sessionRef.workspaceId===first.workspaceId))throw Error('unknown recovery session');
  if(!liveManagers.has(first.sessionId))await driver.openSession(first);const manager=liveManagers.get(first.sessionId);if(!manager||manager.getSessionId()!==first.sessionId)throw Error('native session unavailable');
  const texts=e=>typeof e?.message?.content==='string'?e.message.content:(e?.message?.content??[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');
  const matches=manager.getBranch().filter(e=>e.type==='message'&&e.message?.role==='user'&&e.parentId===c.leafId&&texts(e)===c.userText);if(matches.length!==1)return {status:'unknown',reason:'native-anchor-unavailable'};
  const intent='i_'+id.replaceAll('-',''),expectedHash=uiCapability.digest(c.payload);let receipt,pending;
  if(c.action.startsWith('profile_')){let ops;try{ops=JSON.parse(fs.readFileSync(path.join(root,'profile-operations.json'),'utf8'));if(ops.schema!==1||!ops.receipts||!ops.pending)throw Error('invalid profile records')}catch(e){if(e.code==='ENOENT')ops={receipts:{},pending:{}};else return {status:'unknown',reason:'receipt-unavailable'}}receipt=ops.receipts[intent];pending=ops.pending[intent];if(receipt&&(receipt.action!==c.action.slice(8)||receipt.payloadSha256!==expectedHash))return {status:'unknown',reason:'receipt-mismatch'};
  }else{let state;try{state=getDomainForWorker().load(first.sessionId);if(state.profileId!=='synthetic-profile'||state.workspaceId!=='s07b-fixture-workspace')throw Error('scope mismatch')}catch{return {status:'unknown',reason:'receipt-unavailable'}}receipt=state.receipts[intent];if(receipt&&(receipt.action!==c.action||receipt.payloadSha256!==expectedHash))return {status:'unknown',reason:'receipt-mismatch'};}
  if(receipt)return {status:'committed',result:receipt.result,anchorId:matches[0].id,contentHash:c.contentHash};
  if(pending)return {status:'unknown',reason:'commit-pending'};
  return {status:'no-receipt',anchorId:matches[0].id,contentHash:c.contentHash};
 }
 if(req.method==='workbench.history.search'||req.method==='workbench.history.read'){
  if(!first||typeof first.sessionId!=='string'||!knownWorkspace(first.workspaceId))throw Error('Workbench session scope required');
  const sessions=(await driver.listSessions(first.workspaceId)).sessions;if(!sessions.some(s=>s.sessionRef.sessionId===first.sessionId&&s.sessionRef.workspaceId===first.workspaceId))throw Error('Unknown session');
  if(!liveManagers.has(first.sessionId))await driver.openSession(first);
  const manager=liveManagers.get(first.sessionId),file=manager?.getSessionFile(),leaf=manager?.getLeafId();
  if(!manager||manager.getSessionId()!==first.sessionId||!file||!leaf)throw Error('current native branch unavailable');
  const sessionRoot=fs.realpathSync.native(path.join(agentDir,'sessions')),realFile=fs.realpathSync.native(file);
  if(!realFile.startsWith(sessionRoot+path.sep)||!fs.lstatSync(file).isFile()||fs.lstatSync(file).isSymbolicLink())throw Error('native history path invalid');
  const history=getHistoryForWorker();let grants=[];try{grants=history.grants()}catch(e){if(e.code!=='ENOENT')throw e}
  grants=grants.map(g=>g.caller==='s07b-trusted-host'&&g.session===first.sessionId?{...g,active:false}:g);
  grants.push({caller:'s07b-trusted-host',session:first.sessionId,leaf,file:realFile,active:true});
  atomic(history.auth,{profile:'synthetic-profile',grants});history.rebuild('s07b-trusted-host');
  if(req.method==='workbench.history.search'){if(typeof req.args[1]!=='string')throw Error('invalid query');return history.search('s07b-trusted-host',req.args[1],false,first.sessionId)}
  return history.read('s07b-trusted-host',req.args[1],0,500,first.sessionId);
 }
 if(req.method==='workbench.citation.locate'){
  if(!first||typeof first.sessionId!=='string'||!knownWorkspace(first.workspaceId))throw Error('Workbench session scope required');
  const sessions=(await driver.listSessions(first.workspaceId)).sessions;if(!sessions.some(s=>s.sessionRef.sessionId===first.sessionId&&s.sessionRef.workspaceId===first.workspaceId))throw Error('Unknown session');
  const x=req.args[1];if(!x||typeof x!=='object'||Object.keys(x).some(k=>!['materialId','versionId','quote'].includes(k))||typeof x.quote!=='string'||!x.quote.trim()||Array.from(x.quote).length>512)throw Error('invalid citation');
  return getDomainForWorker().citationService.locate(first.sessionId,x);
 }
 if(req.method==='workbench.profile.list'){
  if(!first||typeof first.sessionId!=='string'||!knownWorkspace(first.workspaceId))throw Error('Workbench session scope required');
  const sessions=(await driver.listSessions(first.workspaceId)).sessions;if(!sessions.some(s=>s.sessionRef.sessionId===first.sessionId&&s.sessionRef.workspaceId===first.workspaceId))throw Error('Unknown session');
  return getProfileForWorker().list();
 }
 if(req.method==='workbench.study.state'||req.method==='workbench.study.export'){
  if(!first||typeof first.sessionId!=='string'||!knownWorkspace(first.workspaceId))throw Error('Workbench session scope required');
  const sessions=(await driver.listSessions(first.workspaceId)).sessions;
  if(!sessions.some(s=>s.sessionRef.sessionId===first.sessionId&&s.sessionRef.workspaceId===first.workspaceId))throw Error('Unknown workbench session');
  if(!liveManagers.has(first.sessionId))await driver.openSession(first);
  const manager=liveManagers.get(first.sessionId);if(!manager||manager.getSessionId()!==first.sessionId)throw Error('Session manager unavailable');
  if(req.method==='workbench.study.state')return getDomainForWorker().state(first.sessionId,manager);
  const version=req.args[1];if(!Number.isSafeInteger(version)||version<1)throw Error('invalid draft version');
  const result=getDomainForWorker().export(first.sessionId,manager,version,'study');
  const data=fs.readFileSync(result.path);const digest=(await import('node:crypto')).createHash('sha256').update(data).digest('hex');if(data.length!==result.bytes||digest!==result.sha256)throw Error('export integrity mismatch');
  const exported=JSON.parse(data.toString('utf8')),draftEvent=exported.draft,domain=getDomainForWorker(),sources=[];
  for(const ref of draftEvent.sourceRefs??[]){if(!sources.some(x=>x.id===ref.materialId))sources.push(domain.citationService.source(first.sessionId,ref.materialId,ref.versionId));}
  const draft={title:draftEvent.content.title,status:'用户确认的合成学习内容，尚未核实。',version:draftEvent.version,requestId:draftEvent.anchor.intentId,sourceVersions:sources.map(x=>`${x.id}@1`),referenceContract:'refs-v2',claims:draftEvent.content.claims.map(c=>({id:c.id,section:'concept',origin:'user',text:`用户输入（待核）：${c.text}`,citations:c.citations.map(x=>({sourceId:x.materialId,revision:1,quote:x.quote,start:x.utf16?.start,end:x.utf16?.end,resolution:{originalQuote:x.originalQuote,method:x.matchMethod}}))})),conflicts:[],uncertainties:draftEvent.content.uncertainties??[],next:[]};
  const renderer=await import('./domain-bundle-s06.mjs'),text=renderer.renderAudit({sources,drafts:[draft],decisions:exported.decisions??[],errata:[],failures:[]},draft),rendered=Buffer.from(text,'utf8');
  return {version:result.version,draftId:result.draftId,sha256:(await import('node:crypto')).createHash('sha256').update(rendered).digest('hex'),bytesBase64:rendered.toString('base64')};
 }
 if(req.method.startsWith('workbench.materials.')){
  if(!first||typeof first.sessionId!=='string'||!knownWorkspace(first.workspaceId))throw Error('Workbench session scope required');
  const sessions=(await driver.listSessions(first.workspaceId)).sessions;
  if(!sessions.some(s=>s.sessionRef.sessionId===first.sessionId&&s.sessionRef.workspaceId===first.workspaceId))throw Error('Unknown workbench session');
  const materials=getMaterialsForWorker(), session=first.sessionId;
  if(req.method==='workbench.materials.list')return materials.list(session,0,50);
  if(req.method==='workbench.materials.read'){const x=req.args[1];if(!x||Object.keys(x).some(k=>!['materialId','versionId','start'].includes(k)))throw Error('Invalid read request');return materials.read(session,x.materialId,x.versionId,x.start??0,2048);}
  if(req.method==='workbench.materials.import'){const x=req.args[1];if(!x||Object.keys(x).some(k=>!['name','bytesBase64'].includes(k))||typeof x.bytesBase64!=='string'||x.bytesBase64.length>1400000||!/^[A-Za-z0-9+/]*={0,2}$/.test(x.bytesBase64))throw Error('Invalid selected material');const data=Buffer.from(x.bytesBase64,'base64');if(data.toString('base64')!==x.bytesBase64||data.length>1024*1024)throw Error('Selected file exceeds 1 MiB');const receipt=materials.stageBytes(x.name,data,session);const value=materials.importReceipt(session,receipt);log('workbench_material_import',{sessionId:session,name:x.name,materialId:value.materialId,versionId:value.versionId,sha256:value.sha256});return value;}
 }
 if(req.method==='closeSession'){
  const result=await driver.closeSession(first);liveManagers.delete(first.sessionId);return result;
 }
 if(req.method==='subscribe'){const ref=req.args[0],key=req.clientId+':'+JSON.stringify(ref);subscriptions.get(key)?.();subscriptions.set(key,driver.subscribe(ref,event=>publish(req.clientId,event)));return true;}
 if(req.method==='unsubscribe'){const key=req.clientId+':'+JSON.stringify(req.args[0]);subscriptions.get(key)?.();subscriptions.delete(key);return true;}
 if(req.method==='client.close'||req.method==='worker.shutdown'){for(const [key,off]of subscriptions){if(key.startsWith(req.clientId+':')){off();subscriptions.delete(key)}}for(const entry of (await driver.listSessions()).sessions){await driver.closeSession(entry.sessionRef);}log('close_ack',{clientId:req.clientId,requestId:req.id});if(req.method==='worker.shutdown'){closing=true;atomic(path.join(root,'logs/worker-close-ack.json'),{runId,pid:process.pid,closed:true,disposed:true});setTimeout(()=>process.exit(0),500);}return {closed:true};}
 if(req.method==='syncWorkspace'&&path.resolve(req.args[0])!==workspace)throw new Error('Only fixed fixture workspace is allowed');
 if(req.method==='createSession'&&path.resolve(req.args[0]?.path??'')!==workspace)throw new Error('Workspace boundary rejected');
 if(req.method==='navigateSessionTree'&&req.args[2]?.summarize)throw new Error('Summarization disabled');
 if(req.method==='sendUserMessage'&&JSON.stringify(req.args).length>16000)throw new Error('Fixture input too large');
 if(req.method.startsWith('runtime.')){const name=req.method.slice(8);const value=await driver.runtimeSupervisor[name](...req.args);if(value?.models&&value?.providers)return {...value,models:value.models.filter(m=>m.providerId==='s02-fixture'&&m.modelId==='fixture'),providers:value.providers.filter(p=>p.id==='s02-fixture')};return value;}
 if(req.method==='catalog.worktrees.listWorktrees')return catalog.worktrees.listWorktrees(...req.args);
 if(req.method==='getTranscript' && fs.existsSync(path.join(root,'hold-hydration-v2')) && !fs.existsSync(path.join(root,'logs/hydration-held-v2.json'))) {
  const value=await driver.getTranscript(...req.args);const data=JSON.stringify(value);const crypto=await import('node:crypto');const digest=crypto.createHash('sha256').update(data).digest('hex');
  atomic(path.join(root,'logs/hydration-held-v2.json'),{runId,pid:process.pid,at:new Date().toISOString(),ref:first,sha256:digest});
  const deadline=Date.now()+90000;while(!fs.existsSync(path.join(root,'release-hydration-v2'))&&Date.now()<deadline)await new Promise(r=>setTimeout(r,30));
  atomic(path.join(root,'logs/hydration-released-v2.json'),{runId,pid:process.pid,at:new Date().toISOString(),ref:first,sha256:crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'),released:fs.existsSync(path.join(root,'release-hydration-v2'))});return value;
 }
 return driver[req.method](...req.args);
}
const inbox=require('./inbox.cjs').createInbox(mail,record=>log('mailbox_rejected',record));
const poll=setInterval(()=>{if(closing)return;for(const file of inbox.take()){
 let req;
 try{const entry=inbox.consume(file);if(entry===null)continue;req=entry.value;if(req===null||req.runId!==runId||!allowed.has(req.method)||!Array.isArray(req.args)||!/^[-a-f0-9]{36}$/.test(req.id)||!/^[-a-f0-9]{36}$/.test(req.clientId))throw new Error('Mailbox schema/run/method rejected');const expected=(clientSeq.get(req.clientId)??0)+1;if(req.seq!==expected)throw new Error('Client sequence mismatch');clientSeq.set(req.clientId,req.seq);if(active.size>=64)throw new Error('Mailbox busy');active.add(req.id);
  Promise.resolve().then(()=>execute(req)).then(value=>atomic(path.join(mail,'responses',req.id+'.json'),{runId,clientId:req.clientId,id:req.id,seq:req.seq,value}),error=>atomic(path.join(mail,'responses',req.id+'.json'),{runId,clientId:req.clientId,id:req.id,seq:req.seq,error:{name:error.name,message:error.message,code:error.code}})).finally(()=>active.delete(req.id));
 }catch(error){log('mailbox_rejected',{file,error:String(error)});if(req?.id&&/^[-a-f0-9]{36}$/.test(req.id))atomic(path.join(mail,'responses',req.id+'.json'),{runId,id:req.id,clientId:req.clientId,seq:req.seq,error:{message:String(error)}});}
}},20);
setInterval(()=>{ready();atomic(path.join(root,'logs/worker-transport.json'),{runId,pid:process.pid,attempts:guard.attempts,mailboxStats:stats,inboxStats:inbox.stats});},500);ready();log('worker_ready',{pid:process.pid,workspace});
