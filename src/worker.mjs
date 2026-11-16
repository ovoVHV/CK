import fs from 'node:fs';import path from 'node:path';import readline from 'node:readline';
import {BuildSession} from './engine.mjs';import {envelope,normalize,failure,validateArtifacts} from './protocol.mjs';
import {targetAssetRoots} from './targets.mjs';
import {createActivityReporter} from './build-activity.mjs';
let session;let busy=false;
const send=x=>process.stdout.write(JSON.stringify(x)+'\n');
send({type:'ready',pid:process.pid});
readline.createInterface({input:process.stdin}).on('line',async line=>{
 let msg;try{msg=JSON.parse(line);}catch{process.exitCode=1;process.stdin.destroy();return;}
 if(busy){send({type:'error',id:msg.id,error:'Concurrent worker write rejected'});return;}
 busy=true;const activity=createActivityReporter(messages=>send({type:'activity',id:msg.id,messages}));try{const {c,options,code}=msg;
  c.onActivity=message=>activity.push(message);
  // Availability only routes the request; full pre/post proofs still run.
  try{targetAssetRoots(c.sysroot,c.fqbn);}catch(e){e.code='NOT_QUALIFIED';e.fallbackSafe=true;throw e;}
  if(c.sourceDateEpoch!==undefined)process.env.SOURCE_DATE_EPOCH=String(c.sourceDateEpoch);else delete process.env.SOURCE_DATE_EPOCH;
  process.env.TZ='UTC';session??=new BuildSession({historyBytes:c.historyBytes});if(c.forceClean)session.reset();
  fs.mkdirSync(c.sketchDir,{recursive:true});fs.writeFileSync(path.join(c.sketchDir,'sketch.ino'),normalize(code));
  const receipt=await session.build(c,{label:msg.id,...options});validateArtifacts(receipt.artifacts,c.fqbn);
  activity.close();send({type:'result',id:msg.id,receipt:envelope(c,{...receipt,requestId:msg.id})});
 }catch(e){activity.close();session?.reset();send({type:'result',id:msg.id,receipt:failure(msg.c,e)});}finally{busy=false;}
});
