import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(path.join(root,'desktop/apps/desktop/package.json'));
const Blockly=require('blockly'),{build}=require('esbuild');
const components=path.join(root,'desktop/apps/desktop/src/components');
const bundle=path.join(components,`.ck-wifi-regression-${process.pid}.tmp.mjs`);
try{
 await build({entryPoints:[path.join(components,'arduino_generator.ts')],bundle:true,format:'esm',platform:'node',packages:'external',target:'node24',outfile:bundle,logLevel:'silent'});
 const {arduinoGenerator,setArduinoGeneratorTarget,stripBlockMarkers}=await import(pathToFileURL(bundle));
 Blockly.defineBlocksWithJsonArray([{type:'wifi_connect',message0:'WiFi %1 %2',args0:[{type:'field_input',name:'SSID',text:'MyWiFi'},{type:'field_input',name:'PASSWORD',text:'12345678'}],previousStatement:null,nextStatement:null},{type:'wifi_wait_until_ready',message0:'Wait for WiFi',previousStatement:null,nextStatement:null}]);
 setArduinoGeneratorTarget('esp32:esp32:esp32s3','3.3.6-cn');
 const workspace=new Blockly.Workspace();workspace.newBlock('wifi_connect','ck-wifi-reproduction');
 const raw=arduinoGenerator.workspaceToCode(workspace),preview=stripBlockMarkers(raw);
 if(raw===preview||!raw.includes('#include <WiFi.h> /* @ck-source-begin:'))throw Error('Fixture must use the actual marked Blockly include');
 fs.writeFileSync(path.join(root,'tests/blockly-wifi-A.ino'),raw);
 fs.writeFileSync(path.join(root,'tests/blockly-wifi-preview.ino'),preview);
 const wait=workspace.newBlock('wifi_wait_until_ready','ck-wifi-wait-reproduction');
 workspace.getBlockById('ck-wifi-reproduction').nextConnection.connect(wait.previousConnection);
 const withWait=arduinoGenerator.workspaceToCode(workspace);
 fs.writeFileSync(path.join(root,'tests/blockly-wifi-wait.ino'),withWait);
 fs.writeFileSync(path.join(root,'tests/blockly-wifi-wait-preview.ino'),stripBlockMarkers(withWait));
 workspace.dispose();console.log('Generated actual Blockly WiFi source with inline provenance comments.');
}finally{if(fs.existsSync(bundle))fs.unlinkSync(bundle);}
