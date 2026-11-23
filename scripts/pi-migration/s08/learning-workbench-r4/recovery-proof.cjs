'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {digest}=require('./host-capability.cjs');
function read(file,max=65536){const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.size>max)throw Error('invalid recovery proof');return JSON.parse(fs.readFileSync(file,'utf8'))}
function notDispatched(dir,c){try{const pre=path.join(dir,`ui-stage-${c.operationId}.pre-dispatch.json`),sent=path.join(dir,`ui-stage-${c.operationId}.dispatching.json`);if(fs.existsSync(sent))return false;const v=read(pre,4096);return ['operationId','workerRunId','guiRunId','workspaceId','sessionId','contentHash'].every(k=>v[k]===c[k])}catch{return false}}
function publish(dir,result){if(!/^[a-f0-9-]{36}$/.test(result.operationId)||!['committed','not-submitted'].includes(result.status))throw Error('invalid recovery terminal');const file=path.join(dir,`ui-resolution-${result.operationId}.json`),tmp=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(result),{flag:'wx'});try{try{fs.linkSync(tmp,file)}catch(e){if(e.code!=='EEXIST'||digest(read(file))!==digest(result))throw e}}finally{fs.unlinkSync(tmp)}return file}
module.exports={notDispatched,publish};
