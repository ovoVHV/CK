// One request per host-owned process. The structured stdout result is the
// authoritative return channel; disk receipts are diagnostics only.
import fs from 'node:fs';import http from 'node:http';import {failure,digest,normalize} from './protocol.mjs';import {PROTOCOL_VERSION} from './version.mjs';
import {formatBuildDiagnostics} from './build-diagnostics.mjs';
import {createBuildStreamReader} from './build-stream.mjs';
const at=process.argv.indexOf('--config');const request=JSON.parse(fs.readFileSync(process.argv[at+1],'utf8'));
try{
 const profile=JSON.parse(fs.readFileSync(process.env.CK_V9_CONFIG,'utf8'));
 const ack=process.argv.includes('--ack'),cancel=process.argv.includes('--cancel');
 const data=ack||cancel?request:{protocolVersion:PROTOCOL_VERSION,request,source:fs.readFileSync(request.sourceFile,'utf8')};
 // A diagnostic switch may disable the optimization for matched desktop A/B.
 // It only requests the full scheduler; it cannot relax content checks.
 if(!ack&&!cancel&&profile.noOpReference===true)data.request={...request,noOpReference:true};
 if(!ack&&!cancel&&profile.validationReference===true)data.request={...data.request,validationReference:true};
 for(const key of ['frontendReference','historyReference','discoveryPreprocessReference','discoveryCompileReference','coldPipelineReference','nativeImageReference','discoveryBatchReference','assetOpenReference','coldReference','avrPropertiesReference','esp32PropertiesReference','directExecutionReference'])if(!ack&&!cancel&&profile[key]===true)data.request={...data.request,[key]:true};
 if(!ack&&!cancel&&typeof profile.discoveryBatchReference==='boolean')data.request={...data.request,discoveryBatchReference:profile.discoveryBatchReference};
 if(!ack&&!cancel&&typeof profile.coldLibraryPchReference==='boolean')data.request={...data.request,coldLibraryPchReference:profile.coldLibraryPchReference};
 const body=JSON.stringify(data);
 const result=await new Promise((resolve,reject)=>{
  const req=http.request({host:'127.0.0.1',port:profile.port,path:ack?'/ack':cancel?'/cancel':'/build',method:'POST',agent:false,headers:{Authorization:'Bearer '+profile.token,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body),...(!ack&&!cancel?{Accept:'application/x-ndjson'}:{})}},res=>{
   const stream=res.headers['content-type']==='application/x-ndjson'?createBuildStreamReader(request.requestId,messages=>{
    process.stderr.write(messages.map(message=>'[V9 进度] '+message.replace(/[\r\n]+/g,' ')+'\n').join(''));
   }):null;
   const out=[];let bytes=0;res.on('data',b=>{try{if(stream){stream.push(b);return;}bytes+=b.length;if(bytes>32*1024*1024)throw Error('Oversized engine response');out.push(b);}catch(e){res.destroy(e);}});res.on('error',reject);res.on('end',()=>{try{resolve(stream?stream.finish():JSON.parse(Buffer.concat(out)));}catch(e){reject(e);}});
  });req.on('error',reject);req.setTimeout(1000000,()=>req.destroy(Error('Engine response timeout')));req.end(body);
 });
 if(!ack&&!cancel&&result.success)process.stderr.write(formatBuildDiagnostics(result));
 console.log(JSON.stringify(result));if(!result.success)process.exitCode=1;
}catch(e){
 // Connection refusal before dispatch is the only transport failure eligible
 // for automatic v6 fallback. Unknown completion must never race a rebuild.
 e.fallbackSafe=e.code==='ECONNREFUSED';e.code=e.fallbackSafe?'ENGINE_UNAVAILABLE':'TRANSPORT_FAILURE';
 console.log(JSON.stringify(failure(request,e)));process.exitCode=1;
}
