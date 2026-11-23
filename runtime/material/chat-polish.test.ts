import { it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session } from './store.js';
import { converse, initializeApprovedBatch, parseDialogue, budgetStatus } from './dialogue.js';
import { source } from '../../core/material/test-fixtures.js';
const dirs:string[]=[];
const rules={mode:'dev',note:'offline',text:'offline',commit:'test',hash:'test',skillHash:'test',longHash:'test'} as const;
const blocks=[{text:'说明',origin:'ai',citations:[]}];
function setup(){const root=mkdtempSync(join(tmpdir(),'polish-'));dirs.push(root);initializeApprovedBatch(root);const session=new Session(root,'test');session.append({type:'created',at:new Date().toISOString(),title:'合成'});return session}
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true})});
it('仅普通chat可省略draft；额外字段、organize缺稿和非null改稿仍拒绝',async()=>{
 expect(parseDialogue(JSON.stringify({blocks}),'chat').draft).toBeNull();
 expect(()=>parseDialogue(JSON.stringify({blocks}),'organize')).toThrow();
 expect(()=>parseDialogue(JSON.stringify({blocks,extra:true}),'chat')).toThrow();
 const s=setup();await converse(s,{model:'offline',async generate(){return {raw:JSON.stringify({blocks}),model:'offline',ms:0,finishReason:'stop'}}},'其他话题',{rules});
 expect(s.read().state.dialogue?.[0]?.status).toBe('completed');
 const id=s.read().state.dialogue![0]!.requestId;
 expect(JSON.parse(readFileSync(join(s.dir,'requests',id+'.normalized.json'),'utf8')).normalization).toBe('chat-missing-draft-to-null');
});
it('取消即使provider忽略signal迟到返回，也不写回答或学习单；次数保留',async()=>{
 const s=setup(),controller=new AbortController();let release!:(value:any)=>void;let signal:AbortSignal|undefined;
 const pending=converse(s,{model:'offline',generate(_s,_u,sig){signal=sig;return new Promise(ok=>{release=ok})}},'等待',{rules,signal:controller.signal});
 controller.abort();release({raw:JSON.stringify({blocks}),model:'offline',ms:1,finishReason:'stop'});
 await expect(pending).rejects.toThrow('主动停止');expect(signal?.aborted).toBe(true);
 expect(s.read().events.at(-1)?.event.type).toBe('dialogue_cancelled');expect(s.read().state.pending).toBeUndefined();expect(s.read().state.dialogue?.[0]?.blocks).toBeUndefined();expect(budgetStatus(s.root).used).toBe(1);
});

it('省略draft后的坏引用仍整份拒收，保留全部定位诊断',async()=>{
 const s=setup();s.append({type:'source_added',at:new Date().toISOString(),source});
 const bad={blocks:[{text:'伪引用',origin:'material',citations:[{sourceId:source.id,revision:1,quote:'不存在一'},{sourceId:source.id,revision:1,quote:'不存在二'}]}]};
 await expect(converse(s,{model:'offline',async generate(){return{raw:JSON.stringify(bad),model:'offline',ms:1,finishReason:'stop'}}},'追问',{rules})).rejects.toThrow('引用无法定位');
 const id=s.read().state.dialogue![0]!.requestId;expect(JSON.parse(readFileSync(join(s.dir,'requests',id+'.reply-candidate.json'),'utf8')).issues).toHaveLength(2);expect(s.read().state.dialogue![0]!.blocks).toBeUndefined();
});
