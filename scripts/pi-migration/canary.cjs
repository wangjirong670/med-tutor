// No SDK/provider imports. Network canary performs connection probes only.
const fs = require('node:fs');
const net = require('node:net');
const tls = require('node:tls');
const dgram = require('node:dgram');
const out = { runId:fs.readFileSync('run-id.txt','utf8').trim(),started:new Date().toISOString(), versions: process.versions, environmentKeys: Object.keys(process.env).sort(), probes: [] };
async function connection(name, connect) {
  return new Promise(resolve => {
    const s = connect();
    let settled = false;
    const finish = result => { if (settled) return; settled = true; out.probes.push({name,...result}); s.destroy(); resolve(); };
    s.once('connect', () => finish({connected:true}));
    s.once('error', e => finish({error:e.code}));
    s.setTimeout(3000, () => finish({error:'TIMEOUT_NOT_DENIAL'}));
  });
}
(async () => {
  await connection('raw-tcp-external', () => net.connect({host:'1.1.1.1',port:443}));
  await connection('raw-tls-external', () => tls.connect({host:'1.1.1.1',port:443,rejectUnauthorized:false}));
  await connection('loopback', () => net.connect({host:'127.0.0.1',port:46391}));
  for(const host of ['1.1.1.1','127.0.0.1']) await new Promise(resolve => {
    const s=dgram.createSocket('udp4');
    const finish=e => {out.probes.push({name:`raw-udp-${host==='127.0.0.1'?'loopback':'external'}`,error:e?.code??'SUBMITTED_DELIVERY_UNKNOWN'});s.close();resolve();};
    s.once('error',finish);
    s.send(Buffer.from('S01 canary'),host==='127.0.0.1'?46392:443,host,finish);
  });
  // Overall gate requires pairing this result with the host receiver evidence.
  out.tcpExternallyDenied=out.probes.filter(x=>x.name.endsWith('external')&&x.name!=='raw-udp-external').every(x=>x.error==='EACCES'||x.error==='EPERM');
  out.gate='requires receiver evidence and verified zero-capability token';
  out.ended=new Date().toISOString();
  fs.writeFileSync('canary-result.json',JSON.stringify(out,null,2));
  process.exitCode=out.tcpExternallyDenied?0:2;
})().catch(e=>{fs.writeFileSync('canary-result.json',JSON.stringify({fatal:String(e)}));process.exitCode=3;});
