import fs from 'node:fs';
import path from 'node:path';
import {sha} from './resolver.mjs';
import {rejectReparse} from './paths.mjs';
import {writeChanged} from './native/plan.mjs';

const unit = /\.(?:cpp|c|cc|cxx|S)$/;
const allowed = name=>unit.test(name)||/\.(?:h|hh|hpp|hxx|inc|ipp|tpp)$/i.test(name);
export function validMember(name) {
 if(typeof name!=='string'||name.length>240||!allowed(name)||name.toLowerCase()==='sketch.ino.cpp')return false;
 const parts=name.split('/');
 return (parts.length===1||parts[0]==='src')&&parts.every(p=>p.length>0&&!p.startsWith('.')&&!/[. ]$|[<>:"\\|?*\x00-\x1f]/.test(p)&&! /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p));
}
export function validateMembers(files) {
 if(!Array.isArray(files)||files.length>256)throw Error('Invalid project file count');
 const keys=new Set();let size=0;
 for(const {name,hex} of files){
  if(!validMember(name)||keys.has(name.toLowerCase())||typeof hex!=='string'||hex.length>2*1024*1024||hex.length%2!==0||/[^0-9a-f]/.test(hex))throw Error('Invalid or duplicate project file: '+name);
  keys.add(name.toLowerCase());size+=hex.length/2;
 }
 if(size>4*1024*1024)throw Error('Project sources exceed 4 MiB');
 return files;
}
export function sketchSnapshot(dir){
 const files=[],other=[];rejectReparse(dir);
 function visit(d,prefix){
  for(const e of fs.readdirSync(d,{withFileTypes:true})){
   const name=prefix+e.name,file=path.join(d,e.name);
   if(e.isSymbolicLink())throw Error('Linked sketch file: '+name);
   if(e.isDirectory()&&(name==='src'||prefix)){visit(file,name+'/');continue;}
   if(name==='sketch.ino'&&e.isFile())continue;
   if(!e.isFile()||!validMember(name)){other.push(name);continue;}
   const bytes=fs.readFileSync(file);files.push({name,bytes,digest:sha(bytes)});
  }
 }
 visit(dir,'');files.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
 const names=files.map(f=>f.name),identity=sha(JSON.stringify(files.map(f=>[f.name,f.digest])));
 return {files,names,identity,other,units:names.filter(n=>unit.test(n))};
}
// Only explicit folder requests use this separate managed sketch workspace.
export function installMembers(dir,files){
 validateMembers(files);const prior=sketchSnapshot(dir),names=new Set(files.map(f=>f.name));
 if(prior.other.length)throw Error('Unexpected project staging files: '+prior.other.join(', '));
 for(const f of prior.files)if(!names.has(f.name))fs.unlinkSync(path.join(dir,f.name));
 for(const {name,hex} of files){const dest=path.join(dir,name);rejectReparse(dest);writeChanged(dest,Buffer.from(hex,'hex'));}
}
export function mirrorMembers(c,snapshot){
 for(const {name,bytes} of snapshot.files){
  const marker=Buffer.from('#line 1 '+JSON.stringify(path.join(c.sketchDir,name))+'\n');
  writeChanged(path.join(c.workspace,'build','sketch',name),Buffer.concat([marker,bytes]));
 }
}
