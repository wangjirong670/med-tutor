import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function validateHostResponse(response, request, now=Date.now()) {
  if (!response || response.runId!==request.runId || response.nonce!==request.nonce || response.profile!==request.profile || response.lockKey!==request.lockKey || response.dbPath!==request.dbPath || response.pid!==request.pid || response.expectedInstance!==request.expectedInstance || response.issuedAtMs!==request.issuedAtMs) return false;
  if (!Number.isSafeInteger(response.observedAtMs) || !Number.isSafeInteger(response.expiresAtMs) || response.observedAtMs<request.issuedAtMs || response.expiresAtMs>request.issuedAtMs+500 || now<response.observedAtMs || now>response.expiresAtMs) return false;
  if (!['alive','absent','reused','unknown'].includes(response.status)) return false;
  if (response.status==='alive' && response.observedInstance!==request.expectedInstance) return false;
  if (response.status==='reused' && (typeof response.observedInstance!=='string' || response.observedInstance===request.expectedInstance)) return false;
  if ((response.status==='absent'||response.status==='unknown') && response.observedInstance!==null) return false;
  return true;
}

export function createHostLivenessBridge({runId,profile,lockKey,dbPath,ownerPid,ownerInstance,requestDir,responseDir}) {
  const sleeper=new Int32Array(new SharedArrayBuffer(4));
  return {
    query(pid) {
      if (!runId || !responseDir || !requestDir || !Number.isSafeInteger(ownerPid) || ownerPid<=0 || pid!==ownerPid || !/^\d+$/.test(ownerInstance ?? '')) return {status:'unknown',reason:'unregistered'};
      const nonce=crypto.randomBytes(16).toString('hex');const issuedAtMs=Date.now();
      const request={runId,nonce,profile,lockKey,dbPath,pid,expectedInstance:ownerInstance,issuedAtMs};
      const requestFile=path.join(requestDir,`${nonce}.json`);const temp=`${requestFile}.tmp`;
      try {fs.writeFileSync(temp,JSON.stringify(request),{flag:'wx'});fs.renameSync(temp,requestFile);} catch(error){return {status:'unknown',reason:`request:${error.code??'error'}`};}
      const responseFile=path.join(responseDir,`${nonce}.json`);
      while(Date.now()-issuedAtMs<500) {
        try {const response=JSON.parse(fs.readFileSync(responseFile,'utf8'));return validateHostResponse(response,request)?response:{status:'unknown',reason:'invalid-response'};}
        catch(error){if(!['ENOENT','EBUSY','EACCES','EPERM'].includes(error.code))return {status:'unknown',reason:'invalid-response'};}
        Atomics.wait(sleeper,0,0,10);
      }
      return {status:'unknown',reason:'timeout'};
    }
  };
}
