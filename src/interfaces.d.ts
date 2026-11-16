/** V9 protocol 1. Disk candidates never confer session authority. */
export type Sha256 = string;
export interface BuildRequest {
 requestId:string;sourceSha256:Sha256;fqbn:string;sysroot:string;
 workspace:string;sketchDir:string;libraries:string[];forceClean?:boolean;
 buildSignature?:string;
}
export interface AssetProof {
 roots:string[];sha256:Sha256;namespaceSha256:Sha256;files:number;bytes:number;
 elapsedMs:number;rows:Array<[string,'directory']|[string,'file',number,Sha256]>;
}
export interface TaskDecision {
 task:'discovery'|'frontend'|'pch'|'compile'|'archive'|'link'|'image'|'metadata';
 decision:'Reuse'|'Rebuild'|'Replay'|'Restore'|'Compile'|'Link'|'Generate'|'UseDiscoveryObject'|'UsePipelinedObject';
 reason:string;output?:string;actualWrites?:number;
}
export interface Artifact {name:string;file:string;bytes:number;sha256:Sha256;}
export interface BuildResourceEvidence {
 flash:number;ram:number;flashLimit:number;ramLimit:number;warningCount:number;
 source:'qualified-size-recipe';warningScope:'observed-build-process-output';
}
export interface ResultIdentity {
 protocolVersion:1;engineVersion:'9.1.0-alpha.22';cacheSchema:1;threatModel:'T1-session';
 requestId:string;sourceSha256:Sha256;fqbn:string;
}
export type BuildResult = ResultIdentity & (
 {success:true;sessionId:string;artifacts:Artifact[];resources:BuildResourceEvidence;taskDecisions:TaskDecision[];phases:Record<string,number>;counts:Record<string,number|null>} |
 {success:false;artifacts:[];error:{code:string;message:string;fallbackSafe:boolean}});
export interface AssetEngine {validate(roots:string[]):AssetProof;}
export interface Frontend {qualify(request:BuildRequest):{qualified:boolean;reason?:string};}
export interface SessionCache {reset():void;/* memory only, bounded per workspace */}
export interface Scheduler {execute(config:unknown,plan:unknown,identity:unknown):Promise<{decisions:TaskDecision[];commit():void}>;}
export interface ProcessManager {cancel(requestId:string):Promise<void>;close():Promise<void>;}
export interface HostAdapter {verifyAndExport(result:BuildResult):Promise<string>;}
export interface ExportAck {requestId:string;sourceSha256:Sha256;success:boolean;}
