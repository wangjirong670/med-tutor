// Ordinary GUI process: no local SDK. All model work goes through D001 worker.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const {app,session,shell}=require('electron');const root=process.cwd();
const log=(type,data={})=>fs.appendFileSync(path.join(root,'logs/gui.jsonl'),JSON.stringify({runId:process.env.S02_RUN_ID,time:new Date().toISOString(),type,...data})+'\n');
for(const level of ['error','warn']){const original=console[level].bind(console);console[level]=(...args)=>{log('console_'+level,{message:args.map(a=>a instanceof Error?a.stack:typeof a==='string'?a:JSON.stringify(a)).join(' ')});original(...args);};}
const guard=require('./network-guard.mjs');setInterval(()=>{fs.writeFileSync(path.join(root,'logs/gui-transport.json'),JSON.stringify({runId:process.env.S02_RUN_ID,attempts:guard.attempts},null,2));},1000).unref();
const originalLoad=Module._load;
Module._load=function(name,...rest){if(/@earendil-works[\\/]pi-(coding-agent|ai|tui)|@pi-gui[\\/]pi-sdk-driver/.test(name)){log('local_sdk_denied',{name});throw new Error('S02 GUI local SDK prohibited');}return originalLoad.call(this,name,...rest);};
const cp=require('node:child_process');for(const key of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']){cp[key]=(...args)=>{log('child_denied',{api:key,command:String(args[0])});const e=new Error('S02 GUI child disabled');e.code='EACCES';if(key==='spawnSync')return {status:null,error:e,stdout:'',stderr:''};if(key==='exec'||key==='execFile'){const cb=args.at(-1);if(typeof cb==='function'){queueMicrotask(()=>cb(e,'',''));return {kill(){}};}}throw e;};}
shell.openExternal=async()=>{throw new Error('S02 external navigation disabled')};
process.on('uncaughtException',e=>{log('uncaught',{error:String(e),stack:e.stack});});
app.on('child-process-gone',(_,details)=>log('child_process_gone',details));
app.on('web-contents-created',(_,contents)=>{
 contents.on('render-process-gone',(_,details)=>log('renderer_gone',details));
 contents.on('did-fail-load',(_,code,description,url)=>log('load_failed',{code,description,url}));
 contents.setWindowOpenHandler(()=>({action:'deny'}));contents.on('will-navigate',(e,url)=>{if(!url.startsWith('file:')&&!url.startsWith('pi-gui-extension:')){e.preventDefault();log('navigation_denied',{url});}});
 contents.on('did-finish-load',()=>{log('window_loaded',{id:contents.id,url:contents.getURL(),prefs:contents.getLastWebPreferences()});fs.writeFileSync(path.join(root,'logs/gui-ready.json'),JSON.stringify({pid:process.pid,runId:process.env.S02_RUN_ID,time:new Date().toISOString(),metrics:app.getAppMetrics()}));});
});
setInterval(()=>{if(fs.existsSync(path.join(root,'logs','stop-'+process.env.S02_RUN_ID+'.txt'))){log('development_stop');app.exit(0);}},500).unref();
app.whenReady().then(()=>{session.defaultSession.setPermissionRequestHandler((_c,_p,done)=>done(false));session.defaultSession.setPermissionCheckHandler(()=>false);session.defaultSession.webRequest.onBeforeRequest((details,done)=>{const deny=/^(https?|wss?):/.test(details.url);if(deny)log('network_denied',{url:details.url});done({cancel:deny});});});
log('entry',{pid:process.pid,versions:process.versions,environmentKeys:Object.keys(process.env).sort()});
require(path.resolve(root,'../src/pi-gui/apps/desktop/out/main/main.js'));
