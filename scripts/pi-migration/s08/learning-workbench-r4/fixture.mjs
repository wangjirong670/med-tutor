import fs from 'node:fs';import path from 'node:path';import {createRequire} from 'node:module';import {fileURLToPath,pathToFileURL} from 'node:url';
const __extDir=path.dirname(fileURLToPath(import.meta.url));
const root=process.env.S07B_DATA_ROOT?path.resolve(process.env.S07B_DATA_ROOT):process.cwd();
function resolvePiAiCompat(){
  const candidates=[
    process.env.S07B_SOURCE?.trim()?path.resolve(process.env.S07B_SOURCE.trim()):null,
    typeof process.resourcesPath==='string'&&process.resourcesPath?path.join(process.resourcesPath,'app.asar'):null,
    typeof process.resourcesPath==='string'&&process.resourcesPath?path.join(process.resourcesPath,'app'):null,
    typeof process.resourcesPath==='string'&&process.resourcesPath?path.join(process.resourcesPath,'med-tutor','pi-runtime'):null,
    path.resolve(__extDir,'../../app.asar'),
    path.resolve(__extDir,'../../app'),
    path.resolve(__extDir,'../pi-runtime'),
    path.resolve(__extDir,'../../s07/restore-r2/src/pi-gui'),
  ].filter(Boolean);
  for(const dir of candidates){
    const direct=path.join(dir,'node_modules/@earendil-works/pi-ai/dist/compat.js');
    if(fs.existsSync(direct)) return direct;
    try{return createRequire(path.join(dir,'package.json')).resolve('@earendil-works/pi-ai/compat');}catch{}
  }
  return path.join(path.resolve(process.env.S07B_SOURCE??''),'node_modules/@earendil-works/pi-ai/dist/compat.js');
}
const ai=await import(pathToFileURL(resolvePiAiCompat()).href);
export function log(type,data={}){const dir=path.join(root,'logs');fs.mkdirSync(dir,{recursive:true});fs.appendFileSync(path.join(dir,'provider.jsonl'),JSON.stringify({runId:process.env.S02_RUN_ID,time:new Date().toISOString(),type,...data})+'\n');}
let count=0;
export function fixture(pi){
 pi.registerProvider('s02-fixture',{baseUrl:'http://127.0.0.1:1/never-used',apiKey:'S02-FAKE-ONLY',api:'s02-fixture-api',models:[{id:'fixture',name:'S02 Offline Fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:65536,maxTokens:2048}],streamSimple:(model,context,options={})=>{
  const id=++count;const user=[...context.messages].reverse().find(m=>m.role==='user');const text=typeof user?.content==='string'?user.content:(user?.content??[]).filter(c=>c.type==='text').map(c=>c.text).join('');
  const last=context.messages.at(-1);log('request',{id,provider:model.provider,model:model.id,text,messageCount:context.messages.length,messages:context.messages});
  const stream=ai.createAssistantMessageEventStream();const usage={input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
  const msg={role:'assistant',api:model.api,provider:model.provider,model:model.id,content:[],stopReason:'stop',usage,timestamp:Date.now()};
  let finished=false;
  const done=(reason='stop')=>{if(finished)return;finished=true;msg.stopReason=reason;stream.push(reason==='error'||reason==='aborted'?{type:'error',reason,error:msg}:{type:'done',reason,message:msg});log('end',{id,reason});};
  options.signal?.addEventListener('abort',()=>{msg.errorMessage='S02 stopped by user';log('abort',{id});done('aborted');setTimeout(()=>{const late=`CANCELLED_LATE_${id}`;log('late_attempt',{id,text:late,kind:'text_and_unexecuted_tool'});if(msg.content[0]?.type==='text')msg.content[0].text+=late;msg.content.push({type:'toolCall',id:`late-tool-${id}`,name:'profile_create',arguments:{}});stream.push({type:'text_delta',contentIndex:0,delta:late,partial:msg});stream.push({type:'toolcall_end',contentIndex:1,partial:msg});},1600);},{once:true});
  queueMicrotask(async()=>{
   stream.push({type:'start',partial:msg});
   if(text.startsWith('S08 TOOL ')){const plan=JSON.parse(fs.readFileSync(path.join(root,'fixture-plan.json'),'utf8'));if(last?.role!=='toolResult'){const action=text.slice('S08 TOOL '.length);const params=plan[action];if(!params)throw Error('missing S06 fixture plan');log('tool_requested',{action});msg.content=[{type:'toolCall',id:`s06-tool-${id}`,name:action,arguments:params}];done('toolUse');return;}const result=JSON.stringify(last);log('tool_result_observed',{bytes:Buffer.byteLength(result),result});let answer;try{const parsed=JSON.parse(last.content.find(x=>x.type==='text').text);if(!parsed.ok)answer='离线合成状态读取失败：'+String(parsed.error);else {const d=parsed.data;answer=`离线合成学习状态：当前稿版本 ${d.currentVersion}，纠正 ${d.corrections.length} 项，待核 ${d.unresolved.length} 项。`;}}catch{answer='离线合成状态读取结果无法解析。'}msg.content=[{type:'text',text:answer}];stream.push({type:'text_start',contentIndex:0,partial:msg});stream.push({type:'text_delta',contentIndex:0,delta:answer,partial:msg});stream.push({type:'text_end',contentIndex:0,content:answer,partial:msg});done();return;}
   if(text.startsWith('S04 TOOL ')){const plan=JSON.parse(fs.readFileSync(path.join(root,'fixture-plan.json'),'utf8'));if(last?.role!=='toolResult'){const action=text.slice('S04 TOOL '.length);const params=plan[action];if(!params)throw Error('missing S04 fixture plan');log('tool_requested',{action});msg.content=[{type:'toolCall',id:`s04-tool-${id}`,name:action,arguments:params}];done('toolUse');return;}const result=JSON.stringify(last);log('tool_result_observed',{bytes:Buffer.byteLength(result),result});msg.content=[{type:'text',text:'S04 synthetic tool completed.'}];done();return;}
   if(text.startsWith('S03 TOOL ')){const plan=JSON.parse(fs.readFileSync(path.join(root,'fixture-plan.json'),'utf8'));if(last?.role!=='toolResult'){const action=text.slice('S03 TOOL '.length);const params=plan[action];if(!params)throw Error('missing fixture plan');log('tool_requested',{action,systemHasMethod:JSON.stringify(context).includes('med-study-knead')});msg.content=[{type:'toolCall',id:`s03-tool-${id}`,name:'material_'+action,arguments:params}];done('toolUse');return;}const result=JSON.stringify(last);log('tool_result_observed',{bytes:Buffer.byteLength(result),result});msg.content=[{type:'text',text:'S03 synthetic tool completed.'}];done();return;}
   if(text.includes('error')){msg.errorMessage='S02 injected provider error; retry disabled';done('error');return;}
   if(text.includes('empty')){done();return;}
   const chunks=last?.role==='toolResult'?['工具已完成。','S02 合成偏好已保存或检索，结果来自真实记忆扩展。']:text.includes('slow')?['慢流第一段：可以按停止。',`NORMAL_SLOW_${id}`,'慢流结束。']:['第一段：这是 S02 合成回复。','第二段：增量来自隔离 Pi worker。','第三段：本次未调用真实模型。'];
   msg.content=[{type:'text',text:''}];stream.push({type:'text_start',contentIndex:0,partial:msg});
   for(let i=0;i<chunks.length;i++){if(i)await new Promise(r=>setTimeout(r,text.includes('slow')?12000:2200));if(finished)return;msg.content[0].text+=chunks[i]+'\n';stream.push({type:'text_delta',contentIndex:0,delta:chunks[i]+'\n',partial:msg});log('delta',{id,index:i,text:chunks[i]});}
   stream.push({type:'text_end',contentIndex:0,content:msg.content[0].text,partial:msg});done();
  });return stream;
 }});
}
