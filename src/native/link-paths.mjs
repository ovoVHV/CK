import path from 'node:path';
export function buildFileExecution(argv,cwd,build){
 if(!/[^\x00-\x7f]/.test(build))return {argv,directory:cwd};
 const prefix=build.replaceAll('\\','/').replace(/\/$/,'')+'/';
 return {argv:argv.map((a,i)=>{const n=a.replaceAll('\\','/');return i&&n.toLowerCase().startsWith(prefix.toLowerCase())?'./'+n.slice(prefix.length):a;}),directory:build};
}
// Some Windows GCC/collect2/ld distributions disagree on the encoding of
// absolute Unicode arguments passed between processes. Keep build-local link
// paths relative to the actual (Unicode-capable) working directory. No copies,
// aliases or reduced input proofs; the scheduler still tracks absolute files.
export function linkExecution(argv,cwd,build,{expanded,resolveScript}){
 if(!/[^\x00-\x7f]/.test(build))return {argv,directory:cwd};
 const prefix=build.replaceAll('\\','/').replace(/\/$/,'')+'/';
 const local=value=>{
  const normalized=value.replaceAll('\\','/');
  return normalized.toLowerCase().startsWith(prefix.toLowerCase())?'./'+normalized.slice(prefix.length):value;
 };
 const args=[argv[0]];
 for(let i=0;i<expanded.length;i++){
  const a=expanded[i];
  if(a==='-T'){args.push(a,local(resolveScript(expanded[++i])));continue;}
  if(a.startsWith('-T')){args.push('-T'+local(resolveScript(a.slice(2))));continue;}
  if(a.startsWith('-L')){args.push('-L'+local(path.resolve(cwd,a.slice(2))));continue;}
  if(a.startsWith('-Wl,--Map=')||a.startsWith('-Wl,-Map=')){const at=a.indexOf('=');args.push(a.slice(0,at+1)+local(path.resolve(cwd,a.slice(at+1))));continue;}
  args.push(local(a));
 }
 return {argv:args,directory:build};
}
