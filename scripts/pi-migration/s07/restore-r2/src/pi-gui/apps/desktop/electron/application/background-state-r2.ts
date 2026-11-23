import type { SessionDriverEvent } from '@pi-gui/session-driver';
import type { WorkspaceRecord } from '../../contracts/desktop-state';

// A status-bearing event is newer than a refresh that started before it.
export function mergeRefreshWithNewerEvents(candidate: readonly WorkspaceRecord[], current: readonly WorkspaceRecord[], before: ReadonlyMap<string,number>, now: ReadonlyMap<string,number>): WorkspaceRecord[] {
 return candidate.map(workspace=>({...workspace,sessions:workspace.sessions.map(session=>{
  const key=`${workspace.id}:${session.id}`;
  if((before.get(key)??0)===(now.get(key)??0))return session;
  const live=current.find(w=>w.id===workspace.id)?.sessions.find(s=>s.id===session.id);
  return live?{...session,status:live.status,runningSince:live.runningSince,updatedAt:live.updatedAt,preview:live.preview,config:live.config,hasUnseenUpdate:live.hasUnseenUpdate}:session;
 })}));
}

type RunState={active?:string;startedAt?:string;generation:number;completed:string[]};
export class BackgroundRunOrder {
 private readonly states=new Map<string,RunState>();
 generation(key:string):number{return this.states.get(key)?.generation??0;}
 accept(key:string,event:SessionDriverEvent):boolean {
  let state=this.states.get(key);if(!state){state={generation:0,completed:[]};this.states.set(key,state);}
  const complete=(id:string|undefined)=>{if(id&&!state!.completed.includes(id)){state!.completed.push(id);if(state!.completed.length>32)state!.completed.shift();}};
  if(event.type==='sessionUpdated'||event.type==='sessionOpened'){
   const snapshot=event.snapshot,id=snapshot.runningRunId;
   if(snapshot.status==='running'&&id){
    if(state.completed.includes(id))return false;
    if(state.active&&state.active!==id&&state.startedAt&&snapshot.updatedAt<state.startedAt)return false;
    if(state.active!==id){state.active=id;state.startedAt=snapshot.updatedAt;state.generation++;}
    else if(!state.startedAt||snapshot.updatedAt>state.startedAt)state.startedAt=snapshot.updatedAt;
   }else if(snapshot.status==='idle'&&state.active){
    if(state.startedAt&&snapshot.updatedAt<state.startedAt)return false;
    complete(state.active);state.active=undefined;state.startedAt=undefined;state.generation++;
   }
  }else if(event.type==='runCompleted'||event.type==='runFailed'){
   const id=event.runId;complete(id??state.active);
   if(id&&state.active&&id!==state.active)return false;
   state.active=undefined;state.startedAt=undefined;state.generation++;
  }else if(event.type==='sessionClosed'){complete(state.active);state.active=undefined;state.startedAt=undefined;state.generation++;}
  return true;
 }
}
