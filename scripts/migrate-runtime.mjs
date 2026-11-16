import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
function edit(n,fn){const f=path.join(root,'src',n);fs.writeFileSync(f,fn(fs.readFileSync(f,'utf8')));}
edit('engine.mjs',s=>{
 s="import {ENGINE_VERSION,CACHE_SCHEMA} from './version.mjs';\n"+s;
 s=s.replace(/export function roots\(c\)\{[^\n]+/,"export function roots(c){return [...new Set([...c.assetRoots,...(c.collections??[]),...(c.explicitLibraries??[])])];}");
 s=s.replace('JSON.stringify([c.workspace','JSON.stringify([ENGINE_VERSION,CACHE_SCHEMA,c.features,c.workspace');
 s=s.replace("#scheduler=new NativeScheduler();#state=null;id=randomUUID();","#scheduler;#state=null;id=randomUUID();\n constructor({historyBytes=128*1024*1024}={}){this.#scheduler=new NativeScheduler({historyBytes});}");
 const start=s.indexOf('  if(c.linkVariant)');const end=s.indexOf('  // Diagnostic-only',start);s=s.slice(0,start)+s.slice(end);
 s=s.replace("const before=validateAssets", "const before=validateAssets");
 s=s.replace("mode==='official'||!q.qualified||!directives","mode==='official'||!c.features.independentDiscovery||!q.qualified||!directives");
 s=s.replace("const destination=path.join(c.evidence,label,'artifacts');fs.mkdirSync(destination,{recursive:true});", "const destination=path.join(c.evidence,label,'artifacts');if(c.captureEvidence)fs.mkdirSync(destination,{recursive:true});");
 s=s.replace("fs.writeFileSync(path.join(destination,name),bytes);","if(c.captureEvidence)fs.writeFileSync(path.join(destination,name),bytes);");
 s=s.replace("fs.mkdirSync(objects,{recursive:true});","if(c.captureEvidence)fs.mkdirSync(objects,{recursive:true});");
 s=s.replace("if(c.receiptOptimize)fs.writeFileSync(path.join(objects,dest),scheduled.bytesFor(r.output));else fs.copyFileSync(r.output,path.join(objects,dest));","if(c.captureEvidence){if(c.receiptOptimize)fs.writeFileSync(path.join(objects,dest),scheduled.bytesFor(r.output));else fs.copyFileSync(r.output,path.join(objects,dest));}");
 s=s.replace("write(path.join(c.workspace,'candidate-graph.json'),{authorized:false,explanation:'Debug candidate only. Session never reads this file.',sourceSha256:receipt.sourceSha256,plan});", "");
 return s;
});
edit('discovery.mjs',s=>"import {checkedBuildPath} from './paths.mjs';\n"+s.replace(/export function assetRoots\(c\)\{[^\n]+\n/,'').replace("if(path.dirname(target)!==base||!base.toLowerCase().includes('ck-g-'))throw Error('Refuse non-isolated cleanup');", "checkedBuildPath(c,target,true);"));
edit('scheduler.mjs',s=>{
 s="import {checkedBuildPath} from './paths.mjs';\n"+s.replace("||!base.toLowerCase().includes('ck-g-')",'').replace("if(fs.existsSync(f))fs.unlinkSync(f);","checkedBuildPath(c,f);if(fs.existsSync(f))fs.unlinkSync(f);");
 s=s.replace('#historyBytes=0;', '#historyBytes=0;#capacity;\n constructor({historyBytes=128*1024*1024}={}){this.#capacity=historyBytes;}');
 s=s.replace('this.#historyBytes>128*1024*1024','this.#historyBytes>this.#capacity').replace('observation.historyCapacityBytes=128*1024*1024','observation.historyCapacityBytes=this.#capacity');
 s=s.replace("this.#history.set(x.historyKey,rows.filter(r=>r.version!==x.version));", "const rest=rows.filter(r=>r.version!==x.version);if(rest.length)this.#history.set(x.historyKey,rest);else this.#history.delete(x.historyKey);");
 return s;
});
edit('worker.mjs',()=>`import fs from 'node:fs';import path from 'node:path';import readline from 'node:readline';
import {BuildSession} from './engine.mjs';import {envelope,normalize,failure,validateArtifacts} from './protocol.mjs';
let session;let busy=false;
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
send({type:'ready',pid:process.pid});
readline.createInterface({input:process.stdin}).on('line',async line=>{
 let msg;try{msg=JSON.parse(line);}catch{process.exitCode=1;process.stdin.destroy();return;}
 if(busy){send({type:'error',id:msg.id,error:'Concurrent worker write rejected'});return;}
 busy=true;try{const {c,options,code}=msg;
  if(c.sourceDateEpoch!==undefined)process.env.SOURCE_DATE_EPOCH=String(c.sourceDateEpoch);else delete process.env.SOURCE_DATE_EPOCH;
  process.env.TZ='UTC';session??=new BuildSession({historyBytes:c.historyBytes});if(c.forceClean)session.reset();
  fs.mkdirSync(c.sketchDir,{recursive:true});fs.writeFileSync(path.join(c.sketchDir,'sketch.ino'),normalize(code));
  const receipt=await session.build(c,{label:msg.id,...options});validateArtifacts(receipt.artifacts);
  send({type:'result',id:msg.id,receipt:envelope(c,{...receipt,requestId:msg.id})});
 }catch(e){session?.reset();send({type:'result',id:msg.id,receipt:failure(msg.c,e)});}finally{busy=false;}
});
`);
