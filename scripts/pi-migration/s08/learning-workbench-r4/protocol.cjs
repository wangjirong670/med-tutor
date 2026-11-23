// D001: bounded atomic file transport, not an execution protocol.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const MAX=2*1024*1024;
const stats={writes:0,renameRetries:0,failures:0};
function atomic(file,value){const text=JSON.stringify(value);if(Buffer.byteLength(text)>MAX)throw new Error('S02 mailbox message too large');const temp=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(temp,text,{flag:'wx'});for(let i=0;i<8;i++){try{fs.renameSync(temp,file);stats.writes++;return;}catch(e){if(!['EPERM','EACCES','EBUSY'].includes(e.code)||i===7){stats.failures++;throw e;}stats.renameRetries++;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5*(i+1));}}}
function read(file){const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.size>MAX)throw new Error('Invalid mailbox file');return JSON.parse(fs.readFileSync(file,'utf8'));}
function dirs(root){for(const d of ['requests','responses','events'])fs.mkdirSync(path.join(root,d),{recursive:true});}
const METHODS=['createSession','openSession','forkSession','validateForkSession','archiveSession','archiveSessionIfIdle','unarchiveSession','sendUserMessage','replaceQueuedMessages','cancelCurrentRun','setSessionModel','setSessionThinkingLevel','renameSession','reloadSession','reloadSessionWhenIdle','getSessionTree','navigateSessionTree','getSessionCommands','respondToHostUiRequest','closeSession','listWorkspaces','listSessions','syncWorkspace','reconcileWorkspace','getSessionFilePath','renameWorkspace','removeWorkspace','getTranscript','getSessionSchemaInfo','generateThreadTitle'];
const RUNTIME=['getRuntimeSnapshot','refreshRuntime','getGlobalModelSettings','scopeModels','setDefaultModel','setProjectDefaultModel','setDefaultThinkingLevel','setProjectDefaultThinkingLevel','setScopedModelPatterns','setProjectScopedModelPatterns','listCustomProviders','getCodemodeAlwaysOn'];
const CATALOG=['worktrees.listWorktrees'];
module.exports={MAX,atomic,read,dirs,METHODS,RUNTIME,CATALOG,stats};
