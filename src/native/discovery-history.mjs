// Reuse a previously successful official discovery for an exact source/config.
// No compiler outputs are cached here. Ninja still evaluates and builds every
// required action. The ordinary identity lease and discovery guard stay active.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {toolchainFingerprint} from './object-cache.mjs';
import {responses} from './plan.mjs';

const VERSION=3, LIMIT=3, MAX_BYTES=16*1024*1024;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const metadata=['build.options.json','compile_commands.json','includes.cache','libraries.cache','build_opt.h','file_opts','sdkconfig','partitions.csv'];
function inside(root,file){const rel=path.relative(root,file);return rel!==''&&!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel);}
function sketchFile(config){return path.join(config.sketchDir,path.basename(config.sketchDir)+'.ino');}
function generatedFile(config){return 'sketch/'+path.basename(config.sketchDir)+'.ino.cpp';}
function allowedFiles(config){return [...metadata,generatedFile(config),path.basename(config.sketchDir)+'.ino.bootloader.bin'];}
function cachePath(config){return path.join(config.workspace,'discovery-history.json');}
function discoveryPolicyFiles(config,props,guard){
  const result=[config.cliConfig,config.cli];
  for(const file of ['platform.txt','boards.txt','programmers.txt']){
    const target=path.join(props['runtime.platform.path'],file);if(fs.existsSync(target))result.push(target);
  }
  const ctags=path.join(config.sysroot,'packages/builtin/tools/ctags/5.8-arduino11/ctags.exe');if(fs.existsSync(ctags))result.push(ctags);
  const seen=new Set();
  function visit(dir){
    if(!fs.existsSync(dir)||seen.has(path.resolve(dir)))return;seen.add(path.resolve(dir));
    if(fs.lstatSync(dir).isSymbolicLink())throw new Error('Linked discovery policy');
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
      if(['.git','__pycache__','examples','test','tests'].includes(entry.name))continue;
      const file=path.join(dir,entry.name);if(entry.isSymbolicLink())throw new Error('Linked discovery policy');
      if(entry.isDirectory())visit(file);else if(['library.properties','library.json'].includes(entry.name.toLowerCase()))result.push(file);
    }
  }
  // The mandatory discovery guard already enumerated the complete roots.
  // Reuse its manifest list instead of walking those directories a second time.
  if(Array.isArray(guard.libraryManifests))result.push(...guard.libraryManifests);
  else for(const root of [path.join(config.sysroot,'sketchbook/libraries'),path.join(props['runtime.platform.path'],'libraries'),...(config.libraries??[])])visit(root);
  return result;
}
function compilerHasClockMacros(root){
  for(const entry of fs.readdirSync(root,{withFileTypes:true})){
    const file=path.join(root,entry.name);if(entry.isSymbolicLink())throw new Error('Linked compiler input');
    if(entry.isDirectory()){if(compilerHasClockMacros(file))return true;}
    else if(['','.h','.hh','.hpp','.hxx','.inc','.tcc','.ipp'].includes(path.extname(file).toLowerCase())&&/\b__(?:DATE|TIME)__\b/.test(fs.readFileSync(file,'utf8')))return true;
  }
  return false;
}
function readHistory(config){
  try {
    const file=cachePath(config);if(fs.statSync(file).size>MAX_BYTES)return [];
    const wrapper=JSON.parse(fs.readFileSync(file,'utf8'));
    if(wrapper.version!==VERSION||hash(JSON.stringify(wrapper.entries))!==wrapper.sha256||!Array.isArray(wrapper.entries))return [];
    return wrapper.entries.slice(0,LIMIT);
  } catch{return [];}
}
export {parseNativeDependencies} from './depfile.mjs';
import {readNativeDependencies} from './depfile.mjs';
function qualify(config,plan){
  if(config.discoveryHistory===false)return false;
  if(config.fqbn!=='esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB')return false;
  if(['CPATH','C_INCLUDE_PATH','CPLUS_INCLUDE_PATH','COMPILER_PATH','GCC_EXEC_PREFIX','GCC_COMPARE_DEBUG','LIBRARY_PATH'].some(k=>process.env[k]))return false;
  const sketch=sketchFile(config),files=fs.readdirSync(config.sketchDir);
  if(files.length!==1||files[0]!==path.basename(sketch))return false;
  const generated=path.resolve(config.workspace,'build',generatedFile(config));
  const units=plan.db.filter(e=>inside(path.resolve(config.workspace,'build/sketch'),path.resolve(e.file)));
  return units.length===1&&path.resolve(units[0].file)===generated;
}
export function saveDiscoverySnapshot(config,{identity,sourceSha256,guard,plan,frontend,fastFrontendQualified,literalTemplate}){
  if(!qualify(config,plan))return {stored:false,reason:'unqualified'};
  const build=path.resolve(config.workspace,'build'),sketch=path.resolve(sketchFile(config));
  const paths=new Set();
  for(const rule of plan.rules.filter(r=>r.kind==='compile'||r.kind==='pch')){
    for(const file of rule.inputs)if(!inside(build,path.resolve(file)))paths.add(path.resolve(file));
    for(const file of responses((rule.argv??[]).slice(1),rule.directory).files)if(!inside(build,path.resolve(file)))paths.add(path.resolve(file));
    if(rule.depfile){
      for(const file of readNativeDependencies(rule.depfile,rule.directory,rule.output)){
        const resolved=path.resolve(rule.directory,file);if(!inside(build,resolved))paths.add(resolved);
      }
    }
  }
  const props=plan.props;
  for(const file of discoveryPolicyFiles(config,props,guard))paths.add(path.resolve(file));
  paths.add(path.join(props['compiler.sdk.path'],'sdkconfig'));
  for(const file of [path.join(props['runtime.platform.path'],'tools/partitions',props['build.partitions']+'.csv'),path.join(props['build.variant.path'],'partitions.csv')])if(fs.existsSync(file))paths.add(file);
  for(const [key,value] of Object.entries(props))if(/^recipe\.hooks\.prebuild\./.test(key)){
    for(const match of value.matchAll(/"([^"\r\n]+\.(?:elf|exe))"/g))paths.add(path.resolve(match[1]));
  }
  paths.delete(sketch);
  const inputProofs=[];
  for(const file of [...paths].sort()){
    const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())return {stored:false,reason:'linked-input'};
    const bytes=fs.readFileSync(file);
    // Without a fixed epoch, time-sensitive preprocessing is deliberately not
    // replayed. The sketch itself is checked as well as all dependency inputs.
    if(!process.env.SOURCE_DATE_EPOCH&&/\b__(?:DATE|TIME)__\b/.test(bytes.toString('utf8')))return {stored:false,reason:'time-sensitive-input'};
    inputProofs.push({file,sha256:hash(bytes)});
  }
  if(!process.env.SOURCE_DATE_EPOCH&&/\b__(?:DATE|TIME)__\b/.test(fs.readFileSync(sketch,'utf8')))return {stored:false,reason:'time-sensitive-sketch'};
  const files=allowedFiles(config).map(relative=>{
    const file=path.join(build,relative),stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Invalid official discovery output');
    return {relative,base64:fs.readFileSync(file).toString('base64')};
  });
  // -MMD omits compiler-provided system headers. Bind the complete installed
  // distribution as well, including those headers, cc1, assembler and plugins.
  const toolchainRoot=path.dirname(path.dirname(path.resolve(plan.db[0].arguments[0])));
  if(!process.env.SOURCE_DATE_EPOCH&&compilerHasClockMacros(toolchainRoot))return {stored:false,reason:'time-sensitive-compiler-header'};
  const toolchainSha256=toolchainFingerprint(toolchainRoot);
  const entry={identity,sourceSha256,guardHash:guard.hash,files,inputProofs,toolchainRoot,toolchainSha256,
    frontend:{success:true,builder_result:frontend.builder_result},fastFrontendQualified,literalTemplate};
  const entries=[entry,...readHistory(config).filter(e=>!(e.identity===identity&&e.sourceSha256===sourceSha256))].slice(0,LIMIT);
  const encoded=JSON.stringify({version:VERSION,entries,sha256:hash(JSON.stringify(entries))});
  if(Buffer.byteLength(encoded)>MAX_BYTES)return {stored:false,reason:'history-size-limit'};
  fs.writeFileSync(cachePath(config),encoded);return {stored:true,entries:entries.length,inputProofs:inputProofs.length};
}
export function restoreDiscoverySnapshot(config,{identity,sourceSha256,guard}){
  if(config.discoveryHistory===false)return {hit:false,reason:'disabled'};
  const entry=readHistory(config).find(e=>e.identity===identity&&e.sourceSha256===sourceSha256&&e.guardHash===guard.hash);
  if(!entry)return {hit:false,reason:'no-matching-successful-source'};
  const allowed=allowedFiles(config);
  if(!Array.isArray(entry.files)||entry.files.length!==allowed.length||!entry.files.every((f,i)=>f.relative===allowed[i]&&typeof f.base64==='string'))return {hit:false,reason:'invalid-materialization'};
  if(!Array.isArray(entry.inputProofs)||!entry.inputProofs.length)return {hit:false,reason:'missing-input-proofs'};
  if(typeof entry.toolchainRoot!=='string'||!path.isAbsolute(entry.toolchainRoot)||typeof entry.toolchainSha256!=='string')return {hit:false,reason:'missing-toolchain-proof'};
  try {if(toolchainFingerprint(entry.toolchainRoot)!==entry.toolchainSha256)return {hit:false,reason:'toolchain-content-changed'};}
  catch{return {hit:false,reason:'toolchain-unavailable'};}
  for(const proof of entry.inputProofs){
    try {const stat=fs.lstatSync(proof.file);if(!stat.isFile()||stat.isSymbolicLink()||hash(fs.readFileSync(proof.file))!==proof.sha256)return {hit:false,reason:'dependency-content-changed'};}
    catch{return {hit:false,reason:'dependency-missing'};}
  }
  // Validate every destination before materializing. Never restore objects,
  // archives, ELF files or application images; existing proofs stay in force.
  const build=path.resolve(config.workspace,'build');
  const materialized=entry.files.map(({relative,base64})=>({file:path.resolve(build,relative),bytes:Buffer.from(base64,'base64')}));
  for(const {file} of materialized){
    for(let parent=path.dirname(file);parent===build||inside(build,parent);parent=path.dirname(parent)){
      if(fs.existsSync(parent)&&fs.lstatSync(parent).isSymbolicLink())return {hit:false,reason:'linked-output-directory'};
      if(parent===build)break;
    }
    if(fs.existsSync(file)){const stat=fs.lstatSync(file);if(stat.isSymbolicLink()||!stat.isFile())return {hit:false,reason:'invalid-output-file'};}
  }
  for(const {file,bytes} of materialized){
    if(fs.existsSync(file)&&fs.readFileSync(file).equals(bytes))continue;
    fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);
  }
  return {hit:true,entry,inputProofs:entry.inputProofs.length};
}
