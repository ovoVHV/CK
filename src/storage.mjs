import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {cliDirectories} from './cli-directories.mjs';

export const locatorPath=(env=process.env)=>env.CK_STORAGE_LOCATOR||path.join(env.LOCALAPPDATA,'CKBuildEngineV91','storage.json');
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
export function atomicJson(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const tmp=`${file}.${randomUUID()}.tmp`;
  const fd=fs.openSync(tmp,'wx');
  try{fs.writeFileSync(fd,JSON.stringify(value,null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  fs.renameSync(tmp,file);
}
const same=(a,b)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
const within=(p,root)=>same(p,root)||path.resolve(p).toLowerCase().startsWith(path.resolve(root).toLowerCase()+path.sep);
function absolute(p){if(typeof p!=='string'||!path.isAbsolute(p)||/[\r\n\0]/.test(p))throw Error('请选择绝对路径的数据目录');return path.resolve(p);}
export function readStorage(file=locatorPath()){
  const cfg=read(file);
  if(cfg.schema!==1)throw Error('数据目录配置版本不受支持，已停止启动以保护原数据');
  for(const key of ['root','assets','desktop','webview','temp','projects','examples'])absolute(cfg[key]);
  return cfg;
}
export function defaultDataRoot(install){return path.join(path.dirname(absolute(install)),'CKData');}
function checkLocation(target,install,roots=[]){
  target=absolute(target);
  if(same(target,path.parse(target).root))throw Error('不能直接使用磁盘根目录，请选择 CKData 等专用文件夹');
  for(const root of [install,...roots].filter(Boolean))if(within(target,root)||within(root,target))throw Error('数据目录不能与程序目录或原数据目录互相包含');
  let existing=target;
  while(!fs.existsSync(existing)){const parent=path.dirname(existing);if(parent===existing)throw Error('目标磁盘不存在');existing=parent;}
  // Resolve existing ancestors before accepting a destination; a junction must
  // not redirect a seemingly separate destination into the source tree.
  const real=path.join(fs.realpathSync(existing),path.relative(existing,target));
  for(const root of [install,...roots].filter(Boolean))if(fs.existsSync(root)){
    const rr=fs.realpathSync(root);if(within(real,rr)||within(rr,real))throw Error('目标路径重定向到了程序或原数据目录');
  }
  if(fs.existsSync(target)&&(!fs.statSync(target).isDirectory()||fs.readdirSync(target).length))throw Error('请选择空文件夹，避免覆盖已有文件');
  return {target,existing};
}
function writable(dir){
  fs.mkdirSync(dir,{recursive:true});const probe=path.join(dir,`.ck-write-${randomUUID()}`);
  const fd=fs.openSync(probe,'wx');fs.closeSync(fd);fs.unlinkSync(probe);
}
export function initializeStorage({install,requested,env=process.env,documents}={}){
  const file=locatorPath(env);
  if(fs.existsSync(file))return readStorage(file); // Upgrade never moves data.
  const old=path.join(env.LOCALAPPDATA,'CKBuildEngineV91');
  const legacyFile=path.join(old,'environment.json');
  let legacy=null;
  if(fs.existsSync(legacyFile)){
    try{legacy=read(legacyFile);}catch{throw Error('旧版数据位置记录损坏，已停止初始化以保留原数据');}
    if(!legacy?.sysroot||!path.isAbsolute(legacy.sysroot))throw Error('旧版核心包位置记录无效，已停止初始化以保留原数据');
  }
  let cfg;
  if(legacy?.sysroot&&path.isAbsolute(legacy.sysroot)){
    cfg={schema:1,root:old,assets:legacy.sysroot,desktop:path.join(env.APPDATA,'com.ai.makerblockly.v91alpha'),webview:path.join(env.LOCALAPPDATA,'com.ai.makerblockly.v91alpha'),temp:path.join(env.LOCALAPPDATA,'CKV91','tmp'),projects:path.join(documents||env.USERPROFILE,'RoboFlow','Projects'),examples:path.join(documents||env.USERPROFILE,'RoboFlow','Examples'),legacy:true,generation:randomUUID()};
  }else{
    const root=checkLocation(requested||defaultDataRoot(install),install,[old]).target;
    writable(root);
    cfg={schema:1,root,assets:root,desktop:path.join(root,'desktop'),webview:path.join(root,'webview'),temp:path.join(root,'tmp'),projects:path.join(root,'projects'),examples:path.join(root,'examples'),legacy:false,generation:randomUUID()};
  }
  atomicJson(file,cfg);return cfg;
}

const skipped=new Set(['storage.json','storage-pending.json','storage-progress.json','storage-cancel','storage-last-error.json','launcher.log','last-session.json','environment.json','profile','sessions','tmp','build','cache','downloads','updates','webview','desktop','migration-receipt.json']);
function sources(cfg,includeExternal){
  const list=[{root:cfg.root,prefix:'',kind:'product'},{root:cfg.desktop,prefix:'desktop',kind:'desktop'},{root:cfg.webview,prefix:'webview',kind:'webview'}];
  if(!same(cfg.assets,cfg.root)&&includeExternal)list.push({root:cfg.assets,prefix:'',kind:'assets'});
  return list.filter(s=>fs.existsSync(s.root));
}
async function walk(dir,prefix='',skip=()=>false,found=[]){
  for(const e of await fs.promises.readdir(dir,{withFileTypes:true})){
    const rel=path.join(prefix,e.name),file=path.join(dir,e.name);
    if(skip(rel))continue;
    const st=await fs.promises.lstat(file);
    if(st.isSymbolicLink())throw Error(`发现链接或路径重定向，未迁移：${file}`);
    if(st.isDirectory()){found.push({relative:rel,file,bytes:0,directory:true});await walk(file,rel,skip,found);}
    else if(st.isFile())found.push({relative:rel,file,bytes:st.size});
    else throw Error(`无法迁移特殊文件：${file}`);
  }
  return found;
}
async function inventory(cfg,includeExternal){
  const files=[],destinations=new Map();
  for(const source of sources(cfg,includeExternal)){
    const items=await walk(source.root,'',rel=>{
      const first=rel.split(path.sep)[0];
      if(source.kind==='product')return skipped.has(first)||first.startsWith('storage.json.')||(!same(cfg.assets,cfg.root)&&within(path.join(source.root,rel),cfg.assets));
      if(source.kind==='assets')return ['cache','tmp','build','staging'].includes(first);
      if(source.kind==='webview')return ['Crashpad','ShaderCache','GrShaderCache','DawnCache'].includes(first);
      return false;
    });
    for(const item of items){
      const relative=path.join(source.prefix,item.relative),key=relative.toLowerCase();
      if(destinations.has(key)){
        if(item.directory&&destinations.get(key))continue;
        throw Error(`原目录存在同名文件，不能自动合并：${relative}`);
      }
      destinations.set(key,!!item.directory);files.push({...item,relative});
    }
  }
  // Update preference is user data; installer downloads are disposable.
  const preferences=path.join(cfg.root,'updates','preferences.json');
  if(fs.existsSync(preferences))files.push({file:preferences,relative:path.join('updates','preferences.json'),bytes:fs.statSync(preferences).size});
  return files.sort((a,b)=>a.relative.localeCompare(b.relative));
}
export async function planMigration(cfg,target,install,includeExternal=false){
  const roots=[cfg.root,cfg.assets,cfg.desktop,cfg.webview,cfg.temp,cfg.projects,cfg.examples];
  const checked=checkLocation(target,install,roots),files=await inventory(cfg,includeExternal);
  const bytes=files.reduce((n,f)=>n+f.bytes,0),st=fs.statfsSync(checked.existing),available=Number(st.bavail)*Number(st.bsize);
  if(available<bytes+64*1024*1024)throw Error(`目标磁盘空间不足：需至少 ${Math.ceil(bytes/1048576)+64} MB`);
  writable(checked.existing);
  return {target:checked.target,bytes,files:files.filter(f=>!f.directory).length,directories:files.filter(f=>f.directory).length,available,externalAssets:!same(cfg.assets,cfg.root),includeExternal,sourceRoots:sources(cfg,includeExternal).map(s=>s.root),preservesOriginals:true,rebuildsCache:true};
}
export async function scheduleMigration({file=locatorPath(),target,install,includeExternal=false}){
  const cfg=readStorage(file),plan=await planMigration(cfg,target,install,includeExternal);
  const pending=path.join(path.dirname(file),'storage-pending.json');
  if(fs.existsSync(pending))throw Error('已有待执行的迁移，请先取消或重新启动');
  atomicJson(pending,{schema:1,id:randomUUID(),generation:cfg.generation,target:plan.target,install:absolute(install),includeExternal});
  return plan;
}
async function hash(file,cancel){
  const h=createHash('sha256');for await(const chunk of fs.createReadStream(file)){cancel?.();h.update(chunk);}return h.digest('hex');
}
function repairCliConfig(file,assetRoot,oldAssetRoot){
  if(!fs.existsSync(file))return;
  const text=fs.readFileSync(file,'utf8'),newline=text.includes('\r\n')?'\r\n':'\n';
  const previousUser=cliDirectories(text).user;
  const user=previousUser&&path.isAbsolute(previousUser)?(within(previousUser,oldAssetRoot)?path.join(assetRoot,path.relative(oldAssetRoot,previousUser)):previousUser):path.join(assetRoot,'sketchbook');
  const block=`directories:${newline}  data: ${JSON.stringify(assetRoot.replaceAll('\\','/'))}${newline}  downloads: ${JSON.stringify(path.join(assetRoot,'cache').replaceAll('\\','/'))}${newline}  user: ${JSON.stringify(user.replaceAll('\\','/'))}${newline}`;
  fs.writeFileSync(file,text.match(/^directories:/m)?text.replace(/^directories:[\s\S]*?(?=^\S|$(?![\s\S]))/m,block):text+newline+block);
}
export async function performMigration(file=locatorPath(),{onProgress=()=>{},beforeVerify}={}){
  const control=path.dirname(file),pending=path.join(control,'storage-pending.json'),cancelFile=path.join(control,'storage-cancel');
  if(!fs.existsSync(pending))return readStorage(file);
  const cfg=readStorage(file),request=read(pending);
  if(request.schema!==1||request.generation!==cfg.generation)throw Error('迁移请求已经过期，原数据未修改');
  const cancel=()=>{if(fs.existsSync(cancelFile))throw Error('迁移已取消，继续使用原数据目录');};
  const plan=await planMigration(cfg,request.target,request.install,request.includeExternal);
  const files=await inventory(cfg,request.includeExternal),stage=`${plan.target}.ck-migrating-${request.id}`;
  // Never merge into an interrupted copy or delete it recursively.
  await fs.promises.mkdir(stage);
  let completed=0,bytes=0;const receipt=[];
  const progress=(phase,current)=>onProgress({phase,current,completed,total:plan.files,bytes,totalBytes:plan.bytes});
  progress('copy','准备复制');
  for(const f of files){
    cancel();const dest=path.join(stage,f.relative);
    if(f.directory){await fs.promises.mkdir(dest,{recursive:true});continue;}
    await fs.promises.mkdir(path.dirname(dest),{recursive:true});
    const output=await fs.promises.open(dest,'wx'),h=createHash('sha256');
    try{for await(const chunk of fs.createReadStream(f.file)){cancel();h.update(chunk);let offset=0;while(offset<chunk.length){const w=await output.write(chunk,offset,chunk.length-offset);offset+=w.bytesWritten;}bytes+=chunk.length;progress('copy',f.relative);}await output.sync();}finally{await output.close();}
    receipt.push({...f,sha256:h.digest('hex')});completed++;progress('copy',f.relative);
  }
  await beforeVerify?.();
  const after=await inventory(cfg,request.includeExternal);
  if(JSON.stringify(after)!==JSON.stringify(files))throw Error('迁移过程中原目录成员发生变化，未切换目录');
  completed=0;
  for(const f of receipt){
    cancel();progress('verify',f.relative);
    if(await hash(f.file,cancel)!==f.sha256||await hash(path.join(stage,f.relative),cancel)!==f.sha256)throw Error(`文件内容变化或校验失败，未切换目录：${f.relative}`);
    completed++;
  }
  if(JSON.stringify(await inventory(cfg,request.includeExternal))!==JSON.stringify(files))throw Error('校验过程中原目录成员发生变化，未切换目录');
  cancel();
  const movedAssets=same(cfg.assets,cfg.root)||request.includeExternal;
  const next={schema:1,root:plan.target,assets:movedAssets?plan.target:cfg.assets,desktop:path.join(plan.target,'desktop'),webview:path.join(plan.target,'webview'),temp:path.join(plan.target,'tmp'),projects:within(cfg.projects,cfg.root)?path.join(plan.target,path.relative(cfg.root,cfg.projects)):cfg.projects,examples:within(cfg.examples,cfg.root)?path.join(plan.target,path.relative(cfg.root,cfg.examples)):cfg.examples,legacy:false,generation:randomUUID(),previousRoots:[...(cfg.previousRoots||[]),...plan.sourceRoots],migratedAt:new Date().toISOString()};
  if(movedAssets){repairCliConfig(path.join(stage,'arduino-cli.yaml'),next.assets,cfg.assets);repairCliConfig(path.join(stage,'state','arduino-cli.yaml'),next.assets,cfg.assets);}
  // Relocate saved project folders only when they were actually inside the
  // moved product root. Independently selected projects keep their paths.
  const projectConfig=path.join(stage,'desktop','config.json');
  if(fs.existsSync(projectConfig)){
    const p=read(projectConfig);for(const key of ['project_roots','project_root']){
      const move=v=>typeof v==='string'&&within(v,cfg.root)?path.join(next.root,path.relative(cfg.root,v)):v;
      if(Array.isArray(p[key]))p[key]=p[key].map(move);else if(p[key])p[key]=move(p[key]);
    }atomicJson(projectConfig,p);
  }
  const transformations=[];
  for(const f of receipt){
    if(!['arduino-cli.yaml',path.join('state','arduino-cli.yaml'),path.join('desktop','config.json')].includes(f.relative))continue;
    const finalSha256=await hash(path.join(stage,f.relative),cancel);
    if(finalSha256!==f.sha256)transformations.push({relative:f.relative,sourceSha256:f.sha256,destinationSha256:finalSha256,reason:'relocate-managed-paths'});
  }
  atomicJson(path.join(stage,'migration-receipt.json'),{schema:1,requestId:request.id,source:cfg,destination:next,files:receipt,directories:files.filter(f=>f.directory).map(f=>f.relative),transformations,verifiedAt:new Date().toISOString(),originalsPreserved:true,cacheAuthorityRestored:false});
  cancel();if(fs.existsSync(plan.target))fs.rmdirSync(plan.target); // Empty only.
  fs.renameSync(stage,plan.target);
  atomicJson(file,next); // The only point at which the active location changes.
  fs.unlinkSync(pending);progress('done','迁移完成');return next;
}
