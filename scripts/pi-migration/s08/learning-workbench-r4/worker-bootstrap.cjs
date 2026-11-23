const fs=require('node:fs'),path=require('node:path'),root=process.cwd();
for(const level of ['log','warn','error'])console[level]=(...args)=>fs.appendFileSync(path.join(root,'logs/worker-console.jsonl'),JSON.stringify({time:new Date().toISOString(),level,message:args.map(a=>a instanceof Error?a.stack:String(a)).join(' ')})+'\n');
const failed=e=>{fs.writeFileSync(path.join(root,'logs/worker-error.json'),JSON.stringify({pid:process.pid,time:new Date().toISOString(),error:String(e),stack:e.stack},null,2));process.exit(1);};
import('./worker.mjs').catch(failed);
process.on('uncaughtException',failed);
