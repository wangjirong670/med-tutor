'use strict';
// Host-owned capability records. The worker may call only verify(), never these mutators.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const canonical=v=>Array.isArray(v)?`[${v.map(canonical).join(',')}]`:v&&typeof v==='object'?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`:JSON.stringify(v);
const digest=v=>crypto.createHash('sha256').update(canonical(v)).digest('hex');
const validId=id=>typeof id==='string'&&/^[a-f0-9-]{36}$/.test(id);
function recordFile(dir,id,status){if(!validId(id)||!['issued','claimed','consumed','revoked'].includes(status))throw Error('invalid capability name');return path.join(dir,`ui-${id}.${status}.json`)}
function readSafe(file){const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.size>65536)throw Error('invalid capability record');return JSON.parse(fs.readFileSync(file,'utf8'))}
function validate(v,expected,now=Date.now()){
 if(!v||v.schema!==1||!validId(v.operationId)||!validId(v.guiRunId)||!validId(v.workerRunId)||!validId(v.clientId)||typeof v.action!=='string'||typeof v.sessionId!=='string'||typeof v.workspaceId!=='string'||typeof v.leafId!=='string'||!Number.isSafeInteger(v.epoch)||!Number.isSafeInteger(v.expiresAt)||v.expiresAt<=now||v.expiresAt-now>120000||v.profile!=='synthetic-profile'||v.contentHash!==digest(v.payload))throw Error('capability invalid or expired');
 for(const [key,value] of Object.entries(expected??{}))if(canonical(v[key])!==canonical(value))throw Error(`capability mismatch: ${key}`);
 return v;
}
function issue(dir,body){const id=crypto.randomUUID();const v={schema:1,...body,operationId:id};validate(v,{},Date.now());const file=recordFile(dir,id,'issued');fs.writeFileSync(file,JSON.stringify(v),{flag:'wx',mode:0o600});return v}
function transition(dir,id,from,to){const a=recordFile(dir,id,from),b=recordFile(dir,id,to);if(fs.existsSync(b))throw Error('capability transition already used');fs.renameSync(a,b);return readSafe(b)}
function verify(dir,id,status,expected,now){return validate(readSafe(recordFile(dir,id,status)),{operationId:id,...expected},now)}
function pendingForScope(dir,scope,exclude,action){
 const found=[];for(const name of fs.readdirSync(dir)){if(!name.startsWith('ui-')||!name.endsWith('.claimed.json'))continue;if(!/^ui-[a-f0-9-]{36}\.claimed\.json$/.test(name))return [{unknown:true}];const id=name.slice(3,-13);if(id===exclude)continue;let v;try{v=readSafe(path.join(dir,name));if(v.operationId!==id||!validId(v.workerRunId)||v.profile!=='synthetic-profile'||typeof v.workspaceId!=='string'||typeof v.sessionId!=='string'||v.contentHash!==digest(v.payload))throw Error('invalid');}catch{return [{unknown:true}]};if(v.workspaceId===scope.workspaceId&&(v.sessionId===scope.sessionId||(String(v.action).startsWith('profile_')&&(!action||String(action).startsWith('profile_')))))found.push(v)}return found;
}
function verifyWatch(dir,id,expected){
 const claim=recordFile(dir,id,'claimed'),raw=fs.readFileSync(claim),v=verify(dir,id,'claimed',expected),ack=readSafe(path.join(dir,`ui-watch-${id}.json`)),worker=readSafe(path.join(dir,`worker-${v.workerRunId}.json`)),gui=readSafe(path.join(dir,`ui-gui-${v.guiRunId}.json`));
 const hash=crypto.createHash('sha256').update(raw).digest('hex');
 if(ack.operationId!==id||ack.recordSha256!==hash||worker.runId!==v.workerRunId||ack.workerRunId!==worker.runId||ack.workerPid!==worker.pid||String(ack.workerInstance)!==String(worker.instance)||!validId(worker.monitorRunId)||ack.monitorRunId!==worker.monitorRunId||ack.monitorPid!==worker.monitorPid||String(ack.monitorInstance)!==String(worker.monitorInstance)||gui.guiRunId!==v.guiRunId||gui.workerRunId!==worker.runId||ack.guiRunId!==gui.guiRunId||ack.guiPid!==gui.pid||String(ack.guiInstance)!==String(gui.instance))throw Error('monitor acknowledgement mismatch');
 return v;
}
module.exports={canonical,digest,recordFile,validate,issue,transition,verify,verifyWatch,pendingForScope};
