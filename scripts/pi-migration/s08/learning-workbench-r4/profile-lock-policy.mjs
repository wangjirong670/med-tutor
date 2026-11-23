// Host-only policy for one synthetic USER.md authority. The fixed coordinator
// retains its liveness checks and bounded wait; only time-based takeover for
// this exact canonical mutation key is disabled.
import path from 'node:path';
export function installProfileLockPolicy(Coordinator, canonicalStoragePathSync, profileFile, bridge = null) {
  const proto=Coordinator.prototype;
  const original=proto.tryAcquire;
  const targetKey=`mutation:${canonicalStoragePathSync(profileFile)}`;
  const targetDb=canonicalStoragePathSync(path.join(path.dirname(path.dirname(profileFile)), '.pi-hermes-locks.sqlite'));
  if (original.__s07bProfilePolicy) throw new Error('profile lock policy already installed');
  function guardedTryAcquire(key, options) {
    const target = key === targetKey && canonicalStoragePathSync(this.dbPath) === targetDb;
    if (!target) return original.call(this,key,options);
    if (!bridge) return original.call(this,key,{...options,staleMs:0});
    const oldProbe=this.probeIncarnation, oldKill=process.kill, oldSweep=this.sweepDeadLocks, observed=new Map();
    const bridgedProbe=(pid)=>{
      const response=bridge.query(pid); observed.set(pid,response);
      return response.status==='alive'||response.status==='reused' ? response.observedInstance : null;
    };
    const bridgedKill=(pid,signal)=>{
      if (signal===0 && observed.get(pid)?.status==='absent') throw Object.assign(new Error('host confirmed current PID absent'),{code:'ESRCH'});
      return oldKill(pid,signal);
    };
    this.probeIncarnation=bridgedProbe;process.kill=bridgedKill;
    this.sweepDeadLocks=function(db,now){
      this.probeIncarnation=oldProbe;process.kill=oldKill;
      try{return oldSweep.call(this,db,now);}
      finally{this.probeIncarnation=bridgedProbe;process.kill=bridgedKill;}
    };
    try {return original.call(this,key,{...options,staleMs:0});}
    finally {this.probeIncarnation=oldProbe;this.sweepDeadLocks=oldSweep;process.kill=oldKill;}
  }
  Object.defineProperty(guardedTryAcquire,'__s07bProfilePolicy',{value:true});
  proto.tryAcquire=guardedTryAcquire;
  return {targetKey, targetDb, restore(){if(proto.tryAcquire===guardedTryAcquire)proto.tryAcquire=original;}};
}
