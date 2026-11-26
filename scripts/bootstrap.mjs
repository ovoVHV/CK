import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {ENGINE_VERSION} from '../src/version.mjs';
import {readStorage} from '../src/storage.mjs';
import {copyDirectory} from '../src/filesystem.mjs';
import {defaultJobs} from '../src/config.mjs';
import {installedPlatforms,TARGET_FAMILIES} from '../src/targets.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const install=path.dirname(root),args=process.argv.slice(2);
const unicodeCheck=args.includes('--unicode-path-check');
const qualify=args.includes('--update-check')||unicodeCheck||args.includes('--qualify')||args.includes('--smoke')||args.includes('--lifecycle')||args.includes('--configuration-check')||args.includes('--avr-performance-check')||args.includes('--avr-workflow-check')||args.includes('--wifi-check')||args.includes('--wifi-wait-check')||args.includes('--cold-discovery-check')||args.includes('--button-cold-check'),setup=args.includes('--install-assets'),doctor=args.includes('--doctor');
const storage=process.env.CK_STORAGE_CONFIG_PATH?readStorage(process.env.CK_STORAGE_CONFIG_PATH):null;
const local=process.env.CK_V91_TEST_DATA_ROOT||storage?.root||path.join(process.env.LOCALAPPDATA,'CKBuildEngineV91');
fs.mkdirSync(local,{recursive:true});
const log=(...values)=>console.log(new Date().toISOString(),...values);
const json=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value,null,2));};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const node=path.join(root,'runtime/node.exe'),ninja=path.join(root,'runtime/ninja.exe');
const desktop=path.join(install,'desktop/CK-V9-Preview.exe');
const cli=path.join(install,'desktop/bin/arduino-cli.exe');
const ps=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
function run(exe,argv){const r=spawnSync(exe,argv,{windowsHide:true,encoding:'utf8',maxBuffer:4e6});if(r.error||r.status!==0)throw Error(r.error?.message||r.stderr||`Command failed: ${exe}`);return r.stdout.trim();}
function documents(){return run(ps,['-NoProfile','-Command',"[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); [Environment]::GetFolderPath('MyDocuments')"]);}
const candidates=[process.env.CK_V91_ASSET_ROOT,path.join(documents(),'CK'),path.join(process.env.LOCALAPPDATA,'Arduino15'),path.join(local,'assets')].filter(Boolean);
const ready=p=>['esp32','avr'].some(arch=>installedPlatforms(p,arch).length>0);
const sysroot=path.resolve(process.env.CK_V91_ASSET_ROOT||storage?.assets||candidates.find(ready)||candidates.find(p=>fs.existsSync(path.join(p,'packages')))||candidates[0]);
fs.mkdirSync(sysroot,{recursive:true});
const user=path.join(sysroot,'sketchbook');fs.mkdirSync(path.join(user,'libraries'),{recursive:true});
const profile=path.join(local,'profile');fs.mkdirSync(profile,{recursive:true});
const yamlPath=path.join(profile,'arduino-cli.yaml');
function yaml(file,userRoot){
 // Reject YAML metacharacters/newlines rather than misparse a user-selected path.
 for(const p of [sysroot,userRoot])if(/[\r\n]/.test(p))throw Error('Asset path contains unsupported YAML characters');
 fs.writeFileSync(file,`directories:\n  data: ${JSON.stringify(sysroot.replaceAll('\\','/'))}\n  downloads: ${JSON.stringify(path.join(local,'downloads').replaceAll('\\','/'))}\n  user: ${JSON.stringify(userRoot.replaceAll('\\','/'))}\nbuild_cache:\n  compilations_before_purge: 0\n  ttl: 87600h\n`);
}
yaml(yamlPath,user);
if(storage&&!fs.existsSync(path.join(sysroot,'arduino-cli.yaml'))){
 // Initialize the desktop's companion profile with the same quoted paths.
 // Existing external Arduino profiles are never overwritten.
 fs.writeFileSync(path.join(sysroot,'arduino-cli.yaml'),'board_manager:\n  additional_urls:\n    - https://espressif.github.io/arduino-esp32/package_esp32_index.json\n    - https://jihulab.com/esp-mirror/espressif/arduino-esp32/-/raw/gh-pages/package_esp32_index_cn.json\n'+fs.readFileSync(yamlPath,'utf8'),{flag:'wx'});
}
function toolReport(){
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'runtime-versions.json')));
 for(const [name,tool] of Object.entries(manifest.tools)){
  const f=path.join(root,tool.path),actual=createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  if(actual!==tool.sha256)throw Error(`Bundled ${name} differs; reinstall this test package`);
 }
 // Complete CLI inventory initialization before any request begins its
 // before/after content proof. New inventory files must not be exempted.
 try{run(cli,['core','list','--config-file',yamlPath,'--json']);}
 catch(error){if(ready(sysroot))throw error;log('No installed Core inventory yet; opening desktop Core manager remains available',String(error));}
 const compilers=[];
 for(const [vendor,family,driver]of [['esp32','esp-x32','xtensa-esp32-elf-g++'],['esp32','esp-rv32','riscv32-esp-elf-g++'],['arduino','avr-gcc','avr-g++']]){
  const compilerRoot=path.join(sysroot,'packages',vendor,'tools',family);
  if(fs.existsSync(compilerRoot))for(const version of fs.readdirSync(compilerRoot)){
   const f=path.join(compilerRoot,version,'bin',driver+'.exe');
   if(fs.existsSync(f))try{compilers.push({family,path:f,version:run(f,['--version']).split('\n')[0]});}catch(error){log('GCC probe rejected; keep compatibility desktop available',String(error));}
  }
 }
 return {engineVersion:ENGINE_VERSION,platform:process.platform,arch:process.arch,node:process.version,ninja:run(ninja,['--version']),arduinoCli:run(cli,['version']),gcc:compilers[0]??null,compilers,core:['esp32','avr'].flatMap(arch=>installedPlatforms(sysroot,arch).map(p=>({arch,version:path.basename(p)}))),sysroot,adminRequired:false,compilerQualification:'ESP32 Core 3.3.6 / 3.3.6-cn and Arduino AVR 1.8.6 / 1.8.7 / 1.8.8; full board/menu identity and expanded recipe checks required',tools:manifest.tools};
}
async function child(exe,argv,options={}){
 const proc=spawn(exe,argv,{windowsHide:true,stdio:'inherit',...options});
 return await new Promise((resolve,reject)=>{proc.once('error',reject);proc.once('exit',code=>resolve(code));});
}
let app,runner,cancelFile,fastReady=false;
try{
 if(process.version!=='v24.13.0'||path.resolve(process.execPath).toLowerCase()!==node.toLowerCase())throw Error('Use the bundled Node 24.13.0 runtime');
 const report=toolReport();json(path.join(local,'environment.json'),report);log('Environment',report);
 if(setup){
  const base=['--config-file',yamlPath,'--additional-urls','https://espressif.github.io/arduino-esp32/package_esp32_index.json'];
  if(!args.includes('--avr-only')&&(!installedPlatforms(sysroot).length||!report.compilers.some(c=>c.family.startsWith('esp-')))){
   log('Installing ESP32 Core 3.3.6 into current-user assets');
   if(await child(cli,['core','update-index',...base])!==0)throw Error('Core index update failed');
   if(await child(cli,['core','install','esp32:esp32@3.3.6',...base])!==0)throw Error('Core installation failed');
  }
  if(!installedPlatforms(sysroot,'avr').length||!report.compilers.some(c=>c.family==='avr-gcc')){
   log('Installing Arduino AVR Core 1.8.8 into current-user assets');
   if(await child(cli,['core','update-index','--config-file',yamlPath])!==0)throw Error('AVR index update failed');
   if(await child(cli,['core','install','arduino:avr@1.8.8','--config-file',yamlPath])!==0)throw Error('AVR Core installation failed');
  }
  json(path.join(local,'environment.json'),toolReport());log('Asset preparation complete');
 }else if(!doctor){
  const enabled=!args.includes('--compat');
  const supported=enabled&&ready(sysroot)&&report.gcc;
  if(qualify&&!supported)throw Error('A supported Core and its GCC toolchain are missing. Run the Prepare Toolchain shortcut, then retry.');
  const sessionName=randomUUID(),session=path.join(local,'sessions',sessionName);fs.mkdirSync(session,{recursive:true});
  // GCC/Ninja still contain MAX_PATH-sensitive operations. Keep the execution
  // root short; diagnostic evidence stays under the full product/session path.
  // Only the V9 namespace varies per launch, never the compatibility cache root.
  const tempRoot=unicodeCheck?path.resolve(process.env.CK_PATH_TEST_TEMP||path.join(process.env.LOCALAPPDATA,'CKV91','中文 临时')):(storage?.temp||path.join(process.env.LOCALAPPDATA,'CKV91','tmp'));fs.mkdirSync(tempRoot,{recursive:true});
  const workspaceParent=path.join(tempRoot,'CK_Builds/v9');fs.mkdirSync(workspaceParent,{recursive:true});
  const workspaceNamespace=path.basename(fs.mkdtempSync(path.join(workspaceParent,'s')));
  let buildUser=user,configPath=yamlPath;
  if(qualify&&!unicodeCheck&&!args.includes('--configuration-check')&&!args.includes('--avr-performance-check')&&!args.includes('--avr-workflow-check')&&!args.includes('--wifi-check')&&!args.includes('--wifi-wait-check')&&!args.includes('--cold-discovery-check')&&!args.includes('--button-cold-check')){
   // A private fixture copies WiFi so both computers exercise the same
   // 73-unit project without installing into or changing the user's libraries.
   buildUser=path.join(session,'qualification-sketchbook');fs.mkdirSync(path.join(buildUser,'libraries'),{recursive:true});
   copyDirectory(path.join(installedPlatforms(sysroot).at(-1),'libraries/WiFi'),path.join(buildUser,'libraries/WiFi'));
   configPath=path.join(session,'arduino-cli.yaml');yaml(configPath,buildUser);
  }
  const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
  let cdpPort=0;if(qualify){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));cdpPort=s.address().port;await new Promise(r=>s.close(r));}
  const token=randomBytes(32).toString('hex'),host=path.join(session,'host.json');
  const config={schemaVersion:1,engineVersion:ENGINE_VERSION,paths:{sysroot,node,cli,ninja,cliConfig:configPath,userLibraries:path.join(buildUser,'libraries'),workspaceRoot:path.join(tempRoot,'CK_Builds/v9',workspaceNamespace,'sessions'),evidenceRoot:path.join(session,'evidence')},features:{enabled,independentDiscovery:true,frontendReplay:true,sessionHistory:true,assetBackend:'rust',receiptOptimize:false,noOpFastPath:true},limits:{jobs:defaultJobs(),maxWorkspaces:4,historyBytes:134217728,leaseTimeoutMs:120000,requestTimeoutMs:900000},allowedFqbns:TARGET_FAMILIES,sourceDateEpoch:1792800000};
  const engineConfig=path.join(session,'engine.json');json(engineConfig,config);
  json(host,{enabled,disabledReason:enabled?null:'启动参数 --compat 明确选择了兼容编译',engineVersion:ENGINE_VERSION,protocolVersion:1,nodePath:node,enginePath:path.join(root,'src/desktop-bridge.mjs'),ninjaPath:ninja,allowedFqbns:config.allowedFqbns,workspaceNamespace,port,token});
  const env={...process.env,TEMP:tempRoot,TMP:tempRoot,CK_V91_DATA_ROOT:sysroot,CK_V9_CONFIG:host,CK_V9_ENGINE_CONFIG:engineConfig,CK_V91_PRODUCT_ROOT:local,CK_INSTALL_ROOT:install};
  if(storage){env.CK_V91_DESKTOP_DATA_ROOT=storage.desktop;env.CK_V91_PROJECTS_ROOT=storage.projects;env.CK_V91_EXAMPLES_ROOT=storage.examples;env.WEBVIEW2_USER_DATA_FOLDER=storage.webview;}
  delete env.CK_NATIVE_GRAPH_CONFIG;delete env.CK_LINUX_BACKEND_CONFIG;
  if(qualify){env.CK_FORGE_NATIVE_RELINK_QUALIFICATION_TOKEN=randomBytes(32).toString('hex');env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=`--remote-debugging-port=${cdpPort}`;env.CK_CDP_LIST_URL=`http://127.0.0.1:${cdpPort}/json/list`;env.WEBVIEW2_USER_DATA_FOLDER=path.join(session,'webview');}
  app=spawn(desktop,args.filter(a=>!a.startsWith('--')),{cwd:sysroot,windowsHide:true,env,stdio:'ignore'});
  const appExit=new Promise((resolve,reject)=>{app.once('error',reject);app.once('exit',resolve);});
  env.CK_V9_DESKTOP_PID=String(app.pid);
  if(enabled){
   cancelFile=path.join(session,'cancel');const job=path.join(session,'controller-job.json');
   json(job,{argv:[node,path.join(root,'src/server.mjs'),'--config',engineConfig,'--profile',host,'--desktop-pid',String(app.pid)],cwd:root,owners:[process.pid,app.pid],cancelFile,metricsFile:path.join(session,'controller-metrics.json')});
   runner=spawn(path.join(root,'bin/job.exe'),[job],{windowsHide:true,env,stdio:['pipe','pipe','pipe']});
   runner.stdout.pipe(fs.createWriteStream(path.join(session,'controller-stdout.log')));runner.stderr.pipe(fs.createWriteStream(path.join(session,'controller-stderr.log')));
   runner.on('error',e=>log('Controller error',String(e)));
   let online=false;for(let i=0;i<150;i++){if(app.exitCode!==null)throw Error('Desktop exited during startup');if(runner.exitCode!==null)break;try{const r=await fetch(`http://127.0.0.1:${port}/health`,{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(1000)});if((await r.json()).engineVersion===ENGINE_VERSION){online=true;break;}}catch{}await delay(200);}
   if(!online){
    if(qualify)throw Error('Controller unavailable; qualification cannot proceed');
    const disabled=JSON.parse(fs.readFileSync(host));disabled.enabled=false;disabled.disabledReason='V9 本地服务启动失败，请查看当前数据目录的 sessions 中 controller-stderr.log';json(host,disabled);fs.writeFileSync(cancelFile,'cancel');
    log('V9 initialization rejected this environment. Desktop remains available with the compatibility backend.');
   }
   fastReady=online;
  }
  json(path.join(local,'last-session.json'),{session,engineVersion:ENGINE_VERSION,desktopPid:app.pid,fastEngineEnabled:fastReady,coreReadyAtLaunch:!!supported,initialization:'validate-current-assets-on-build'});
  if(qualify){
   const harness=args.includes('--update-check')?'tests/desktop-updates.mjs':unicodeCheck?'tests/desktop-unicode-paths.mjs':args.includes('--avr-workflow-check')?'tests/desktop-avr-workflow.mjs':args.includes('--avr-performance-check')?'tests/desktop-avr-performance.mjs':args.includes('--button-cold-check')?'tests/desktop-button-cold.mjs':args.includes('--cold-discovery-check')?'tests/desktop-cold-discovery.mjs':args.includes('--wifi-wait-check')?'tests/desktop-wifi-wait.mjs':args.includes('--wifi-check')?'tests/desktop-blockly-wifi.mjs':args.includes('--configuration-check')?'tests/desktop-configurations.mjs':args.includes('--smoke')?'tests/desktop.mjs':args.includes('--lifecycle')?'tests/desktop-lifecycle.mjs':'scripts/machine-qualification.mjs';
   // Closing the test desktop also drains the harness (including the result
   // archiver), rather than leaving its CDP request waiting in the background.
   const harnessJob=path.join(session,'qualification-job.json');
   json(harnessJob,{argv:[node,path.join(root,harness)],cwd:root,owners:[process.pid,app.pid],metricsFile:path.join(session,'qualification-job-metrics.json')});
   const harnessRunner=spawn(path.join(root,'bin/job.exe'),[harnessJob],{cwd:root,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
   harnessRunner.stdout.pipe(process.stdout);harnessRunner.stderr.pipe(process.stderr);
   const code=await new Promise((resolve,reject)=>{harnessRunner.once('error',reject);harnessRunner.once('exit',resolve);});
   if(code!==0)throw Error('Qualification run failed; raw samples retained');
  }else await appExit;
 }
}catch(error){log(error.stack||error);process.exitCode=1;}
finally{
 if(cancelFile)fs.writeFileSync(cancelFile,'cancel');
 if(runner&&runner.exitCode===null)for(let i=0;i<150&&runner.exitCode===null;i++)await delay(100);
 if(runner&&runner.exitCode===null&&((process.env.CK_UPDATE_REQUEST_PATH&&fs.existsSync(process.env.CK_UPDATE_REQUEST_PATH))||(process.env.CK_STORAGE_CONFIG_PATH&&fs.existsSync(path.join(path.dirname(process.env.CK_STORAGE_CONFIG_PATH),'storage-pending.json'))))){log('Update/migration stopped: controller has not exited');process.exitCode=1;}
 if(app&&app.exitCode===null)app.kill();
}
