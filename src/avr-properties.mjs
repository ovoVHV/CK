// Compile property expansion for the qualified, unmodified AVR platform.
// Reads actual platform/board/index content on every cold request. No disk
// property cache confers authority; the caller still proves all assets twice.
import fs from 'node:fs';
import path from 'node:path';
import {sha} from './resolver.mjs';
import {parseFqbn,platformInstallations,AVR_PLATFORMS} from './targets.mjs';

export const AVR_BOARDS_SHA256='e49283dc7a276291e24e91d04b883ea4e884ea2375ed80ede0d69cbf25d40a5d';
function parse(text){
 const p=Object.create(null);
 for(const line of text.replace(/^\uFEFF/,'').split(/\r?\n/)){
  if(!line.trim()||line.trimStart().startsWith('#'))continue;
  const i=line.indexOf('=');if(i<1||line.endsWith('\\'))throw Error('Unsupported property syntax');
  const key=line.slice(0,i).trim();if(Object.hasOwn(p,key))throw Error('Duplicate property');p[key]=line.slice(i+1).trim();
 }
 return p;
}
export function expandProperties(raw){
 const memo=Object.create(null);
 function expand(key,stack=[]){
  if(Object.hasOwn(memo,key))return memo[key];
  if(!Object.hasOwn(raw,key))return '{'+key+'}';
  if(stack.includes(key)||stack.length>32)throw Error('Property expansion cycle');
  return memo[key]=raw[key].replace(/\{([^{}]+)\}/g,(_,name)=>expand(name,[...stack,key]));
 }
 return Object.fromEntries(Object.keys(raw).map(key=>[key,expand(key)]));
}
export function selectBoard(all,target){
 const board=Object.fromEntries(Object.entries(all).filter(([k])=>k.startsWith(target.board+'.')).map(([k,v])=>[k.slice(target.board.length+1),v]));
 if(!board.name)throw Error('Missing board');
 const menus=new Map();
 for(const key of Object.keys(board)){const m=/^menu\.([^.]+)\.([^.]+)$/.exec(key);if(m){if(!menus.has(m[1]))menus.set(m[1],[]);menus.get(m[1]).push(m[2]);}}
 for(const name of target.options.keys())if(!menus.has(name))throw Error('Unknown board menu');
 const selected=new Map();
 for(const [name,values]of menus){const value=target.options.get(name)??values[0];if(!values.includes(value))throw Error('Unknown menu value');selected.set(name,value);
  const prefix=`menu.${name}.${value}.`;for(const [k,v]of Object.entries(board))if(k.startsWith(prefix))board[k.slice(prefix.length)]=v;
 }
 return {board,selected};
}
export function avrProperties(c){
 const target=parseFqbn(c.fqbn);if(target?.arch!=='avr')return {hit:false,reason:'non-avr-target'};
 try{
  if(c.buildProperties?.length)throw Error('Custom properties require official expansion');
  const platforms=platformInstallations(c.sysroot,'avr');if(platforms.length!==1)throw Error('Ambiguous installed platform');
  const platform=platforms[0],platformBytes=fs.readFileSync(path.join(platform,'platform.txt')),boardBytes=fs.readFileSync(path.join(platform,'boards.txt'));
  const version=path.basename(platform),qualified=AVR_PLATFORMS[version];
  if(!qualified||sha(platformBytes)!==qualified.platformSha256||sha(boardBytes)!==qualified.boardsSha256)throw Error('Platform/board definition not qualified for AVR '+version);
  for(const f of ['platform.local.txt','boards.local.txt'])if(fs.existsSync(path.join(platform,f)))throw Error('Local platform override');
  if(fs.existsSync(path.join(path.dirname(c.userLibraries),'hardware')))throw Error('User hardware may override platform');
  const {board}=selectBoard(parse(boardBytes.toString()),target);
  for(const key of ['build.core','build.variant'])if(!/^[A-Za-z0-9_-]+$/.test(board[key]??''))throw Error('Referenced core or variant requires official expansion');
  const dependencies=[];
  for(const file of fs.readdirSync(c.sysroot).filter(n=>/^package.*\.json$/.test(n)&&!n.endsWith('.sig'))){
   const index=JSON.parse(fs.readFileSync(path.join(c.sysroot,file),'utf8'));
   for(const pkg of index.packages??[])if(pkg.name==='arduino')for(const p of pkg.platforms??[])if(p.architecture==='avr'&&p.version===version){
    const gcc=p.toolsDependencies?.filter(d=>d.name==='avr-gcc');if(gcc?.length!==1)throw Error('Ambiguous compiler dependency');dependencies.push(gcc[0]);
   }
  }
  if(!dependencies.length||dependencies.some(d=>d.packager!=='arduino'||d.version!==dependencies[0].version))throw Error('Unresolved compiler package');
  const gcc=path.join(c.sysroot,'packages/arduino/tools/avr-gcc',dependencies[0].version);
  if(!fs.existsSync(path.join(gcc,'bin/avr-g++.exe')))throw Error('Compiler package missing');
  const build=path.join(c.workspace,'build'),raw={...parse(platformBytes.toString()),...board,
   _id:target.board,'runtime.platform.path':platform,'runtime.hardware.path':path.dirname(platform),'runtime.ide.path':path.dirname(c.cli),'runtime.ide.version':'10607','runtime.os':'windows',ide_version:'10607',software:'ARDUINO',
   'runtime.tools.avr-gcc.path':gcc,'build.arch':'AVR','build.board.platform.path':platform,'build.core.platform.path':platform,
   'build.core.path':path.join(platform,'cores',board['build.core']),'build.variant.path':path.join(platform,'variants',board['build.variant']),'build.system.path':path.join(platform,'system'),
   'build.path':build,'build.source.path':path.resolve(c.sketchDir),sketch_path:path.resolve(c.sketchDir),'build.project_name':'sketch.ino','build.library_discovery_phase':'0',
   'build.fqbn':c.fqbn,
   archive_file_path:build+'/{archive_file}',
  };
  return {hit:true,reason:'qualified-avr-platform-and-board-content',coreVersion:version,properties:expandProperties(raw)};
 }catch(error){return {hit:false,reason:String(error.message)};}
}
