'use strict';
// State is host-owned and volatile. The opaque token never reaches the renderer.
class ScopeLease {
 #epoch=0;#scope='';#preparations=new Map();#lease=null;
 observe(scope){if(typeof scope!=='string'||!scope)throw Error('scope required');if(this.#scope!==scope){if(this.#lease)throw Error('S08B_SCOPE_LEASE_ACTIVE');this.#scope=scope;this.#epoch++;for(const [id,p] of this.#preparations){if(p.scope!==scope||p.epoch!==this.#epoch){p.revoked=true;this.#preparations.set(id,p)}}}return this.snapshot()}
 touch(){if(this.#lease)throw Error('S08B_SCOPE_LEASE_ACTIVE');this.#epoch++;for(const p of this.#preparations.values())p.revoked=true;return this.snapshot()}
 snapshot(){return {scope:this.#scope,epoch:this.#epoch,locked:!!this.#lease,operationId:this.#lease?.id??null}}
 begin(id,scope){if(!id||this.#lease||scope!==this.#scope||this.#preparations.has(id))throw Error('S08B_PREPARE_SCOPE_INVALID');const p={id,scope,epoch:this.#epoch,revoked:false};this.#preparations.set(id,p);return {...p}}
 revoke(id){const p=this.#preparations.get(id);if(!p)return false;if(this.#lease?.id===id)throw Error('S08B_COMMIT_OUTCOME_UNKNOWN');p.revoked=true;return true}
 claim(id,scope,epoch){const p=this.#preparations.get(id);if(!p||p.revoked||this.#lease||scope!==this.#scope||p.scope!==scope||p.epoch!==epoch||epoch!==this.#epoch)throw Error('S08B_PREPARATION_REVOKED');this.#lease={id,scope,epoch};return {...this.#lease}}
 assertScopeChangeAllowed(){if(this.#lease)throw Error('S08B_SCOPE_LEASE_ACTIVE')}
 finish(id,outcome){if(this.#lease?.id!==id)throw Error('S08B_LEASE_MISMATCH');if(!['receipt','worker-exited','not-published'].includes(outcome))throw Error('S08B_COMMIT_OUTCOME_UNKNOWN');this.#preparations.delete(id);this.#lease=null;return this.snapshot()}
}
module.exports={ScopeLease};
