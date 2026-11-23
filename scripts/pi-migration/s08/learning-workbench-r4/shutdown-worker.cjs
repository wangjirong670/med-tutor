const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(process.argv[2]);const base=path.resolve(__dirname,'../../../../.study/pi-migration/S08/execution-s08b/r4');
if(!root.startsWith(base+path.sep))throw Error('outside owned lane');
const {atomic,read}=require('./protocol.cjs');const ready=read(path.join(root,'mailbox/ready.json'));
const phase=process.argv[3];if(!['primary','resume','resume2','final','final2','final3','final4','final5','final6','final7','final8','final9','final10','final11','final12','final13','final14','final15','final16','final17','final18','final19','final20','final21','final22','final23','final24','final25','final26','final27','final28','final29','final30','final31','final32','final33'].includes(phase))throw Error('phase required');
const owner=read(path.join(base,`worker-owner-${phase}-r4.json`));if(ready.runId!==owner.runId||ready.pid!==owner.pid||Date.now()-ready.time>3000)throw Error('worker ownership mismatch');
const id=crypto.randomUUID(),clientId=crypto.randomUUID(),mail=path.join(root,'mailbox',ready.runId);
atomic(path.join(mail,'requests',`0000000001-${id}.json`),{runId:ready.runId,clientId,id,seq:1,method:'worker.shutdown',args:[]});
(async()=>{for(let i=0;i<400;i++){const f=path.join(mail,'responses',id+'.json');if(fs.existsSync(f)){const response=read(f);if(response.runId!==ready.runId||response.clientId!==clientId||response.id!==id||!response.value?.closed)throw Error('invalid response');console.log(JSON.stringify({runId:ready.runId,pid:ready.pid,id,response}));return;}await new Promise(r=>setTimeout(r,25));}throw Error('shutdown response timeout')})().catch(e=>{console.error(e);process.exitCode=1});
