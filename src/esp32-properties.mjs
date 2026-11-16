// Native property expansion for the exact ESP32 3.3.6 platform definitions.
// Reads installed packages and board menus; no persistent property authority.
import fs from 'node:fs';
import path from 'node:path';
import {sha} from './resolver.mjs';
import {selectBoard} from './avr-properties.mjs';
import {parseFqbn,platformInstallations,coreVersionSupported,ESP32_PLATFORM_SHA256} from './targets.mjs';
export const ESP32_BOARDS_SHA256='e5a076af9323d82ceae6287479f2aa3ec44db9ffda509c2b86815b642c3446a3';
export function dependencyIdentity(dependencies){
 if(!Array.isArray(dependencies)||dependencies.some(d=>!d||[d.packager,d.name,d.version].some(x=>typeof x!=='string'||!/^[-A-Za-z0-9_.+]+$/.test(x))))throw Error('Unsafe tool dependency');
 if(new Set(dependencies.map(d=>d.name)).size!==dependencies.length)throw Error('Ambiguous tool name');
 return JSON.stringify(dependencies.map(d=>[d.packager,d.name,d.version]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));
}
export function windowsProperties(text){
 const p=Object.create(null),overrides=[];
 for(const line of text.replace(/^\uFEFF/,'').split(/\r?\n/)){
  if(!line.trim()||line.trimStart().startsWith('#'))continue;
  const i=line.indexOf('=');if(i<1)throw Error('Unsupported property syntax');
  const key=line.slice(0,i).trim(),value=line.slice(i+1).trim();p[key]=value;
  if(key.endsWith('.windows'))overrides.push([key.slice(0,-8),value]);
 }
 for(const [key,value]of overrides)p[key]=value;return p;
}
export function expandNestedProperties(raw){
 const memo=Object.create(null);
 function expand(key,stack=[]){
  if(Object.hasOwn(memo,key))return memo[key];if(!Object.hasOwn(raw,key))return '{'+key+'}';
  if(stack.includes(key)||stack.length>32)throw Error('Property expansion cycle');
  let value=raw[key];for(let n=0;n<32;n++){const next=value.replace(/\{([^{}]+)\}/g,(_,name)=>expand(name,[...stack,key]));if(next===value)return memo[key]=value;value=next;}
  throw Error('Property expansion bound');
 }
 return Object.fromEntries(Object.keys(raw).map(k=>[k,expand(k)]));
}
export function esp32Properties(c){
 const target=parseFqbn(c.fqbn);if(target?.arch!=='esp32')return {hit:false,reason:'non-esp32-target'};
 try{
  if(c.buildProperties?.length)throw Error('Custom properties require official expansion');
  const installed=platformInstallations(c.sysroot,'esp32');if(installed.length!==1)throw Error('Ambiguous installed platform');
  const platform=installed[0],version=path.basename(platform),platformBytes=fs.readFileSync(path.join(platform,'platform.txt')),boardsBytes=fs.readFileSync(path.join(platform,'boards.txt'));
  if(!coreVersionSupported(version)||sha(platformBytes)!==ESP32_PLATFORM_SHA256||sha(boardsBytes)!==ESP32_BOARDS_SHA256)throw Error('Platform/board definition not qualified for ESP32 '+version);
  for(const f of ['platform.local.txt','boards.local.txt'])if(fs.existsSync(path.join(platform,f)))throw Error('Local platform override');
  if(fs.existsSync(path.join(path.dirname(c.userLibraries),'hardware')))throw Error('User hardware may override platform');
  const {board}=selectBoard(windowsProperties(boardsBytes.toString()),target);
  for(const key of ['build.core','build.variant'])if(!/^[A-Za-z0-9_-]+$/.test(board[key]??''))throw Error('Referenced core or variant requires official expansion');
  const dependencySets=[];
  for(const file of fs.readdirSync(c.sysroot).filter(n=>/^package.*\.json$/.test(n)&&!n.endsWith('.sig'))){
   const index=JSON.parse(fs.readFileSync(path.join(c.sysroot,file),'utf8'));
   for(const pkg of index.packages??[])if(pkg.name==='esp32')for(const p of pkg.platforms??[])if(p.architecture==='esp32'&&p.version===version)dependencySets.push(p.toolsDependencies);
  }
  if(!dependencySets.length||dependencySets.some(x=>dependencyIdentity(x)!==dependencyIdentity(dependencySets[0])))throw Error('Ambiguous platform tool dependencies');
  const tools={};for(const d of dependencySets[0]){
   if([d.packager,d.name,d.version].some(x=>typeof x!=='string'||!/^[-A-Za-z0-9_.+]+$/.test(x)))throw Error('Unsafe tool dependency');
   const dir=path.join(c.sysroot,'packages',d.packager,'tools',d.name,d.version);
   if(fs.existsSync(dir)){tools['runtime.tools.'+d.name+'.path']=dir;tools['runtime.tools.'+d.name+'-'+d.version+'.path']=dir;}
  }
  const build=path.join(c.workspace,'build');
  const raw={...windowsProperties(platformBytes.toString()),...board,...tools,
   _id:target.board,'runtime.platform.path':platform,'runtime.hardware.path':path.dirname(platform),'runtime.ide.path':path.dirname(c.cli),'runtime.ide.version':'10607','runtime.os':'windows',ide_version:'10607',software:'ARDUINO',
   'build.arch':'ESP32','build.board.platform.path':platform,'build.core.platform.path':platform,'build.core.path':path.join(platform,'cores',board['build.core']),'build.variant.path':path.join(platform,'variants',board['build.variant']),'build.system.path':path.join(platform,'system'),
   'build.path':build,'build.source.path':path.resolve(c.sketchDir),sketch_path:path.resolve(c.sketchDir),'build.project_name':'sketch.ino','build.library_discovery_phase':'0','build.fqbn':c.fqbn,
  };
  const properties=expandNestedProperties(raw);
  for(const key of ['compiler.path','compiler.sdk.path'])if(!path.isAbsolute(properties[key])||!fs.existsSync(properties[key])||properties[key].includes('{'))throw Error('Unresolved compiler/SDK package');
  return {hit:true,reason:'qualified-esp32-platform-board-and-package-content',coreVersion:version,properties};
 }catch(error){return {hit:false,reason:String(error.message)};}
}
