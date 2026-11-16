// One request-local limit shared by discovery and independent Core compilation.
// High priority probes can advance library selection while free slots compile
// the Core. Already running tasks always drain before callers clear a workspace.
export class DiscoveryPool {
 eagerRelease=false;
 #jobs;#active=0;#queue=[];#scheduled=false;
 constructor(jobs){if(!Number.isInteger(jobs)||jobs<1||jobs>16)throw Error('Invalid discovery concurrency');this.#jobs=jobs;}
 run(priority,work){return new Promise((resolve,reject)=>{this.#queue.push({priority,work,resolve,reject});this.#queue.sort((a,b)=>a.priority-b.priority);this.#schedule();});}
 #schedule(){if(this.#scheduled)return;this.#scheduled=true;queueMicrotask(()=>{this.#scheduled=false;while(this.#active<this.#jobs&&this.#queue.length){const task=this.#queue.shift();this.#active++;if(this.eagerRelease){const finish=(callback,value)=>{this.#active--;this.#schedule();callback(value);};try{Promise.resolve(task.work()).then(value=>finish(task.resolve,value),error=>finish(task.reject,error));}catch(error){finish(task.reject,error);}}else Promise.resolve().then(task.work).then(task.resolve,task.reject).finally(()=>{this.#active--;this.#schedule();});}});}
}
