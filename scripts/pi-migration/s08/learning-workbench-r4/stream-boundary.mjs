// Worker-side provider boundary: isolate mutable provider objects from Pi and
// finalize exactly once per invocation. No SDK or persisted session mutation.
export function guardProviderStream({createStream, raw, signal, model, observe=()=>{}}) {
  const out=createStream();let terminal=false,last=null,sequence=0;
  const copy=x=>structuredClone(x);
  const baseline=()=>last?copy(last):{role:'assistant',api:model.api,provider:model.provider,model:model.id,content:[],stopReason:'aborted',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},timestamp:Date.now()};
  const abort=()=>{
    if(terminal)return;terminal=true;
    const message=baseline();message.stopReason='aborted';message.errorMessage='用户已停止；未完成的内容未继续生成。';
    // Incomplete provider tool calls are not execution receipts and must not run.
    message.content=(message.content??[]).filter(x=>x.type!=='toolCall');
    observe({kind:'cancel-accepted',sequence});out.push({type:'error',reason:'aborted',error:message});
  };
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  (async()=>{try{
    for await(const input of raw){
      if(terminal||signal?.aborted){observe({kind:'rejected-after-terminal',type:input?.type});continue;}
      const event=copy(input);sequence++;
      if(event.partial)last=copy(event.partial);
      if(event.type==='done'||event.type==='error'){
        terminal=true;const key=event.type==='done'?'message':'error';event[key]=copy(event[key]);
        observe({kind:'terminal',type:event.type,sequence});out.push(event);break;
      }
      observe({kind:'accepted',type:event.type,sequence});out.push(event);
    }
    if(!terminal){const message=copy(await raw.result());terminal=true;observe({kind:'terminal-result',sequence});out.push({type:message.stopReason==='error'||message.stopReason==='aborted'?'error':'done',reason:message.stopReason,error:message,message});}
  }catch(error){if(!terminal){terminal=true;const message=baseline();message.stopReason='error';message.errorMessage=String(error?.message??error);out.push({type:'error',reason:'error',error:message});observe({kind:'boundary-error',message:message.errorMessage});}}
  finally{signal?.removeEventListener('abort',abort);}})();
  return out;
}
export function wrapFixture(fixture,createStream,observe){return pi=>fixture(new Proxy(pi,{get(target,key){
  if(key==='registerProvider')return (name,config)=>target.registerProvider(name,{...config,streamSimple(model,context,options={}){
    const raw=config.streamSimple(model,context,options);return guardProviderStream({createStream,raw,signal:options.signal,model,observe});
  }});
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
}}));}
