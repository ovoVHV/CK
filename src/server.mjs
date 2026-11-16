import http from 'node:http';import fs from 'node:fs';import path from 'node:path';
import {loadConfig} from './config.mjs';import {LazyBuildController} from './lazy-controller.mjs';import {failure} from './protocol.mjs';import {ENGINE_VERSION,PROTOCOL_VERSION} from './version.mjs';
import {rejectReparse} from './paths.mjs';
const arg=k=>process.argv[process.argv.indexOf(k)+1];
const configFile=arg('--config'),profile=JSON.parse(fs.readFileSync(arg('--profile'),'utf8'));
// Read the session's diagnostic destination without requiring installed Cores.
// Start-Preview and other hosts may keep evidence outside the config folder.
const startup=JSON.parse(fs.readFileSync(configFile,'utf8').replace(/^\uFEFF/,''));
const evidence=startup.paths?.evidenceRoot;
if(typeof evidence!=='string'||!path.isAbsolute(evidence))throw Error('Absolute evidenceRoot required');
rejectReparse(evidence);
if(!/^[0-9a-f]{64}$/.test(profile.token)||!Number.isInteger(profile.port)||profile.port<1024)throw Error('Invalid local session endpoint');
const desktopPid=Number(arg('--desktop-pid'));if(!Number.isInteger(desktopPid)||desktopPid<1)throw Error('Desktop owner required');
const controller=new LazyBuildController(()=>loadConfig(configFile),{desktopPid,onStatus:status=>{
 fs.mkdirSync(evidence,{recursive:true});fs.writeFileSync(path.join(evidence,'readiness.json'),JSON.stringify({...status,at:new Date().toISOString()}));
}});let closing=false;
const server=http.createServer(async(req,res)=>{
 const abort=new AbortController();let msg={},stream=false;res.on('close',()=>{if(!res.writableEnded){abort.abort();if(msg.request?.requestId)controller.cancel(msg.request.requestId).catch(()=>{});}});
 const frame=(type,data)=>res.write(JSON.stringify({type,requestId:msg.request?.requestId,...data})+'\n');
 try{
  if(req.headers.authorization!=='Bearer '+profile.token)throw Error('Unauthorized session');
  if(req.method==='GET'&&req.url==='/health'){res.end(JSON.stringify({engineVersion:ENGINE_VERSION,protocolVersion:PROTOCOL_VERSION,desktopPid,initialized:!!controller.controller,readinessError:controller.readinessError}));return;}
  if(req.method!=='POST')throw Error('Invalid method');const chunks=[];let size=0;
  for await(const b of req){size+=b.length;if(size>5*1024*1024)throw Error('Oversized request');chunks.push(b);}msg=JSON.parse(Buffer.concat(chunks));
  let result;
  if(req.url==='/build'){
   stream=req.headers.accept==='application/x-ndjson';
   if(stream){res.writeHead(200,{'Content-Type':'application/x-ndjson'});res.flushHeaders();}
   result=await controller.submit(msg,{signal:abort.signal,onActivity:stream?messages=>{
    // Slow readers must never stall native compilation or grow an unbounded queue.
    if(!res.destroyed&&res.writableLength<64*1024)frame('activity',{messages});
   }:undefined});
  }
  else if(req.url==='/ack'){await controller.acknowledge(msg.requestId,msg);result={success:true};}
  else if(req.url==='/cancel'){await controller.cancel(msg.requestId);result={success:true};}
  else throw Error('Unknown route');
  if(stream){frame('result',{receipt:result});res.end();}else{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(result));}
 }catch(e){if(!res.destroyed){if(stream){frame('result',{receipt:failure(msg.request??{},e)});res.end();}else{res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify(failure(msg.request??{},e)));}}}
});
server.requestTimeout=0;
async function close(){if(closing)return;closing=true;clearInterval(ownerWatch);server.close();try{await controller.close();}finally{server.closeAllConnections();process.exitCode=0;}}
const ownerWatch=setInterval(()=>{try{process.kill(desktopPid,0);}catch{close();}},500);
process.on('SIGINT',close);process.on('SIGTERM',close);
server.listen(profile.port,'127.0.0.1',()=>{fs.mkdirSync(evidence,{recursive:true});fs.writeFileSync(path.join(evidence,'server-ready.json'),JSON.stringify({pid:process.pid,desktopPid,version:ENGINE_VERSION,initialization:'on-build'}));});
