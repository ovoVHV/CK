import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'scripts/source-tools.json'),'utf8'));
const verifyOnly=process.argv.includes('--verify-only');
if(process.platform!=='win32'||process.arch!=='x64')throw Error('This source build targets Windows x64.');
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const matches=(file,expected)=>fs.existsSync(file)&&hash(file)===expected;
const inside=relative=>{const result=path.resolve(root,relative);if(!result.startsWith(root+path.sep))throw Error('Path escapes source root');return result;};
for(const tool of manifest.tools){
  if(tool.files.every(file=>matches(inside(file.target),file.sha256))){console.log(`Verified ${tool.name}`);continue;}
  if(verifyOnly)throw Error(`Missing or changed tool: ${tool.name}. Run node scripts/prepare-source.mjs.`);
  const cache=inside('local/source-tools/'+tool.sha256);
  fs.mkdirSync(path.dirname(cache),{recursive:true});
  if(!matches(cache,tool.sha256)){
    console.log(`Downloading ${tool.name} from ${new URL(tool.url).host}`);
    const response=await fetch(tool.url,{signal:AbortSignal.timeout(180000)});
    if(!response.ok)throw Error(`Download failed: ${tool.name}, HTTP ${response.status}`);
    const bytes=Buffer.from(await response.arrayBuffer());
    if(createHash('sha256').update(bytes).digest('hex')!==tool.sha256)throw Error(`Distribution hash mismatch: ${tool.name}`);
    fs.writeFileSync(cache,bytes);
  }
  if(tool.archive){
    const extracted=inside('local/source-tools/'+tool.sha256+'-files');
    fs.mkdirSync(extracted,{recursive:true});
    execFileSync('tar.exe',['-xf',cache,'-C',extracted,...tool.files.map(file=>file.entry)],{windowsHide:true,stdio:'inherit'});
    for(const file of tool.files){
      const source=path.join(extracted,file.entry);
      if(!matches(source,file.sha256))throw Error(`Extracted file hash mismatch: ${file.target}`);
      const target=inside(file.target);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(source,target);
    }
  }else{
    const target=inside(tool.files[0].target);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(cache,target);
  }
  console.log(`Prepared ${tool.name}`);
}
console.log('Source tools verified. No board Core or user configuration was changed.');
