// Claim before parsing: malformed files leave the live queue exactly once.
const fs=require('node:fs'),path=require('node:path');
const {atomic,read}=require('./protocol.cjs');
function createInbox(mail,onReject){
 const queue=path.join(mail,'requests'),processing=path.join(mail,'processing'),diagnostics=path.join(mail,'rejected');
 fs.mkdirSync(processing,{recursive:true});fs.mkdirSync(diagnostics,{recursive:true});
 const blocked=new Set();const stats={claimed:0,rejected:0,claimFailures:0,cleanupFailures:0,halted:false};
 function reject(file,error,claimed){
  stats.rejected++;let cleanupError;
  if(claimed){try{fs.unlinkSync(claimed);}catch(e){if(e.code!=='ENOENT'){stats.cleanupFailures++;cleanupError=String(e);}}}
  const record={file,time:new Date().toISOString(),error:String(error).slice(0,1000),cleanupError};
  atomic(path.join(diagnostics,String((stats.rejected-1)%64).padStart(2,'0')+'.json'),record);
  if(stats.rejected<=64)onReject(record);
 }
 function take(){
  if(stats.halted)return [];
  const pending=fs.readdirSync(processing).length;
  if(pending>=64){stats.halted=true;return [];}
  return fs.readdirSync(queue).filter(f=>/^\d{10}-[0-9a-f-]{36}\.json$/.test(f)&&!blocked.has(f)).sort().slice(0,64-pending);
 }
 function consume(file){
  if(stats.halted)return null;
  const full=path.join(queue,file),claimed=path.join(processing,file);
  try{fs.renameSync(full,claimed);}catch(error){
   if(error.code==='ENOENT')return null;
   stats.claimFailures++;blocked.add(file);reject(file,error);
   if(blocked.size>=256)stats.halted=true;
   return null;
  }
  stats.claimed++;
  try{const req=read(claimed);fs.unlinkSync(claimed);return {value:req};}
  catch(error){reject(file,error,claimed);return null;}
 }
 return {take,consume,stats};
}
module.exports={createInbox};
