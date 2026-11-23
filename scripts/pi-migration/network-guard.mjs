import {syncBuiltinESMExports} from 'node:module';
import http from 'node:http';import https from 'node:https';import net from 'node:net';import tls from 'node:tls';
import dns from 'node:dns';import dgram from 'node:dgram';import cp from 'node:child_process';
export const attempts=[];
const deny=name=>(...args)=>{const e=new Error(`S01 offline transport denied: ${name}`);attempts.push({name,time:new Date().toISOString(),command:name.startsWith('child_process')?String(args[0]):undefined,stack:e.stack});e.code='S01_OFFLINE';throw e;};
for(const [label,obj,keys] of [['http',http,['request','get']],['https',https,['request','get']],['net',net,['connect','createConnection']],['tls',tls,['connect']],['dns',dns,['lookup','resolve','resolve4','resolve6','resolveAny']],['dgram',dgram,['createSocket']],['child_process',cp,['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']]])for(const key of keys)obj[key]=deny(`${label}.${key}`);
// spawnSync reports launch failures in result.error rather than throwing.
// Preserve that contract so optional process-identity probes can fail safely.
cp.spawnSync=(...args)=>{try{deny('child_process.spawnSync')(...args);}catch(error){return {status:null,signal:null,pid:0,stdout:'',stderr:'',output:[null,'',''],error};}};
net.Socket.prototype.connect=deny('Socket.connect');
for(const key of ['lookup','resolve','resolve4','resolve6','resolveAny'])dns.promises[key]=async()=>deny(`dns.promises.${key}`)();
globalThis.fetch=async()=>deny('fetch')();
if(globalThis.WebSocket)globalThis.WebSocket=class {constructor(){deny('WebSocket')();}};
syncBuiltinESMExports();
