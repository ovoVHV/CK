// Local mirror-layout fixture. Payload files are read-only test inputs linked
// from the checksum-matched installed distribution; metadata is copied anew.
import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';
const [source,destination]=process.argv.slice(2);
if(!source||!destination||fs.existsSync(destination))throw Error('Use a new isolated fixture directory');
const a=JSON.parse(fs.readFileSync(path.join(source,'package_esp32_index.json'))),b=JSON.parse(fs.readFileSync(path.join(source,'package_esp32_index_cn.json')));
const ap=a.packages.find(p=>p.name==='esp32'),bp=b.packages.find(p=>p.name==='esp32');
const official=ap.platforms.find(p=>p.version==='3.3.6'),mirror=bp.platforms.find(p=>p.version==='3.3.6-cn');
if(official.checksum!==mirror.checksum)throw Error('Core mirror payload differs');
const dependencies=[];
for(const dep of mirror.toolsDependencies.filter(d=>d.packager==='esp32')){
 const original=official.toolsDependencies.find(d=>d.name===dep.name),at=ap.tools.find(t=>t.name===dep.name&&t.version===original.version),bt=bp.tools.find(t=>t.name===dep.name&&t.version===dep.version);
 if(!at||!bt)throw Error('Missing tool metadata '+dep.name);
 for(const system of bt.systems){const baseline=at.systems.find(s=>s.host===system.host);if(!baseline||baseline.checksum!==system.checksum)throw Error('Tool mirror differs '+dep.name+'/'+system.host);}
 dependencies.push({name:dep.name,original:original.version,mirror:dep.version,systems:bt.systems.length});
}
fs.mkdirSync(destination,{recursive:true});
let files=0;function linkTree(from,to){fs.mkdirSync(to,{recursive:true});for(const e of fs.readdirSync(from,{withFileTypes:true})){const src=path.join(from,e.name),out=path.join(to,e.name);if(e.isDirectory())linkTree(src,out);else if(e.isFile()){if(e.name==='installed.json')continue;fs.linkSync(src,out);files++;}else throw Error('Nonregular fixture input '+src);}}
for(const file of fs.readdirSync(source).filter(n=>/^package.*\.json$/.test(n)))fs.copyFileSync(path.join(source,file),path.join(destination,file));
linkTree(path.join(source,'packages/esp32/hardware/esp32/3.3.6'),path.join(destination,'packages/esp32/hardware/esp32/3.3.6-cn'));
const receipt=structuredClone(b);receipt.packages=receipt.packages.filter(p=>p.name==='esp32');receipt.packages[0].platforms=[mirror];
fs.writeFileSync(path.join(destination,'packages/esp32/hardware/esp32/3.3.6-cn/installed.json'),JSON.stringify(receipt));
for(const dep of dependencies){const src=path.join(source,'packages/esp32/tools',dep.name,dep.original);if(fs.existsSync(src))linkTree(src,path.join(destination,'packages/esp32/tools',dep.name,dep.mirror));}
for(const group of ['builtin','arduino']){const src=path.join(source,'packages',group);if(fs.existsSync(src))linkTree(src,path.join(destination,'packages',group));}
fs.mkdirSync(path.join(destination,'bin'),{recursive:true});fs.copyFileSync(path.join(source,'bin/arduino-cli.exe'),path.join(destination,'bin/arduino-cli.exe'));
fs.mkdirSync(path.join(destination,'sketchbook/libraries'),{recursive:true});
fs.writeFileSync(path.join(destination,'arduino-cli.yaml'),`directories:\n  data: ${destination.replaceAll('\\','/')}\n  downloads: ${destination.replaceAll('\\','/')}/downloads\n  user: ${destination.replaceAll('\\','/')}/sketchbook\n`);
// Arduino initializes inventory.yaml on first use. Finish that initialization
// before the first complete asset proof rather than ignoring the new file.
const initialized=spawnSync(path.join(destination,'bin/arduino-cli.exe'),['core','list','--config-file',path.join(destination,'arduino-cli.yaml'),'--json'],{windowsHide:true,encoding:'utf8'});
if(initialized.status!==0)throw Error(initialized.stderr);
fs.writeFileSync(path.join(destination,'fixture-provenance.json'),JSON.stringify({source,destination,coreChecksum:official.checksum,dependencies,files,method:'local hardlink mirror layout; not an independent downloaded installation'},null,2));
console.log(JSON.stringify({destination,files,dependencies:dependencies.length,coreChecksum:official.checksum}));
