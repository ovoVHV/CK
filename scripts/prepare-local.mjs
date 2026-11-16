import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const [sysroot,storage,ninja]=process.argv.slice(2);if(!sysroot||!storage||!ninja)throw Error('Usage: prepare-local SYSROOT STORAGE NINJA');
for(const p of [sysroot,storage,ninja])if(!path.isAbsolute(p))throw Error('Absolute path required');
const local=path.join(root,'local');fs.mkdirSync(local,{recursive:true});
const user=path.join(storage,'profile/sketchbook');fs.mkdirSync(path.join(user,'libraries'),{recursive:true});
// A local qualification fixture matching the reviewed 73-unit project.
fs.cpSync(path.join(sysroot,'packages/esp32/hardware/esp32/3.3.6/libraries/WiFi'),path.join(user,'libraries/WiFi'),{recursive:true});
const cliConfig=path.join(storage,'profile/arduino-cli.yaml');
fs.writeFileSync(cliConfig,`directories:\n  data: ${sysroot.replaceAll('\\','/')}\n  downloads: ${sysroot.replaceAll('\\','/')}/cache\n  user: ${user.replaceAll('\\','/')}\nbuild_cache:\n  compilations_before_purge: 0\n  ttl: 87600h\n`);
const c={schemaVersion:1,engineVersion:'9.1.0-alpha.26',paths:{sysroot,node:process.execPath,cli:path.join(sysroot,'bin/arduino-cli.exe'),ninja,cliConfig,userLibraries:path.join(user,'libraries'),workspaceRoot:path.join(storage,'runtime/CK_Builds/v9/sessions'),evidenceRoot:path.join(storage,'evidence')},features:{enabled:true,independentDiscovery:true,frontendReplay:true,sessionHistory:true,assetBackend:'rust',receiptOptimize:false},limits:{jobs:8,maxWorkspaces:4,historyBytes:134217728,leaseTimeoutMs:120000,requestTimeoutMs:900000},allowedFqbns:['esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB'],sourceDateEpoch:1792800000};
fs.writeFileSync(path.join(local,'engine.json'),JSON.stringify(c,null,2)+'\n');
console.log(path.join(local,'engine.json'));
