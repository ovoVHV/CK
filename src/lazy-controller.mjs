import {BuildController} from './controller.mjs';
import {BuildError} from './protocol.mjs';

// The desktop may start before a Core is installed. Keep the authenticated
// service alive; prove the current environment when a build actually arrives.
// Failed readiness is never cached and never creates a worker or authority.
export class LazyBuildController {
 constructor(load,{desktopPid,create=(config,options)=>new BuildController(config,options),onStatus=()=>{}}={}){
  this.load=load;this.desktopPid=desktopPid;this.create=create;this.onStatus=onStatus;
  this.controller=null;this.closed=false;this.readinessError=null;
 }
 async submit(message,options){
  if(this.closed)throw new BuildError('CLOSED','Controller closed');
  let config;
  try{config=this.load();}
  catch(error){
   this.readinessError=String(error.message??error);
   this.onStatus({ready:false,reason:this.readinessError});
   throw new BuildError('NOT_QUALIFIED','V9 当前环境校验未通过：'+this.readinessError,{fallbackSafe:true});
  }
  if(!this.controller){
   this.controller=this.create(config,{desktopPid:this.desktopPid});
   this.readinessError=null;this.onStatus({ready:true,reason:'current-input-environment-validated'});
  }
  // Session paths and policy remain immutable. The build engine observes the
  // complete current platform and package-index namespace for every request.
  if(JSON.stringify(config.paths)!==JSON.stringify(this.controller.config.paths)){
   throw new BuildError('NOT_QUALIFIED','V9 会话目录已改变，请重新打开 CK 以使用新目录',{fallbackSafe:true});
  }
  if(this.readinessError){this.readinessError=null;this.onStatus({ready:true,reason:'current-input-environment-validated'});}
  // This toggle only selects when Core compilation is scheduled. It cannot
  // authorize a retained object or change the session's validation policy.
  return this.controller.submit(message,{...options,deferCoreOnRediscovery:config.features?.deferCoreOnRediscovery});
 }
 async acknowledge(...args){if(!this.controller)throw new BuildError('ACK_MISMATCH','No build is awaiting acknowledgement');return this.controller.acknowledge(...args);}
 async cancel(...args){return this.controller?.cancel(...args);}
 async close(){this.closed=true;return this.controller?.close();}
}
