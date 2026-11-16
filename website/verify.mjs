import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url)),repo=path.dirname(root);
const require=createRequire(path.join(repo,'desktop/apps/desktop/package.json'));
const {JSDOM}=require('jsdom');const {build}=require('esbuild');
const dist=path.join(root,'dist');
const htmlFiles=[];const collect=dir=>{for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())collect(p);else if(p.endsWith('.html'))htmlFiles.push(p);}};collect(dist);
let links=0;
for(const file of htmlFiles){
 const doc=new JSDOM(fs.readFileSync(file,'utf8')).window.document;
 assert(doc.querySelector('title')?.textContent?.includes('CK LAB'));
 for(const el of doc.querySelectorAll('[src],link[href],a[href]')){
  const url=el.getAttribute('src')||el.getAttribute('href');
  if(!url||url.startsWith('#')||/^https?:/.test(url))continue;
  let pathname=url.split(/[?#]/)[0];if(!pathname)continue;
  const target=pathname.startsWith('/')?path.join(dist,pathname):path.resolve(path.dirname(file),pathname);
  assert(fs.existsSync(target),`${file}: missing ${url}`);links++;
 }
}
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://ckswitch.site'});
for(const key of ['window','document','HTMLElement','Element','Node','DOMParser','XMLSerializer','localStorage'])globalThis[key]=dom.window[key];
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
const bundled=path.join(repo,'desktop/apps/desktop/.ck-lab-verify.mjs');
await build({stdin:{contents:`export * as Blockly from 'blockly'; export {examples} from ${JSON.stringify(path.join(root,'demo.js'))}; export {arduinoGenerator,stripBlockMarkers,setArduinoGeneratorTarget} from './src/components/arduino_generator'; export {setBlocklyBoard} from './src/components/blockly_setup';`,resolveDir:path.join(repo,'desktop/apps/desktop'),loader:'ts'},bundle:true,platform:'browser',format:'esm',nodePaths:[path.join(repo,'desktop/apps/desktop/node_modules')],outfile:bundled,logLevel:'silent'});
const mod=await import(pathToFileURL(bundled));fs.unlinkSync(bundled);
const Blockly=mod.Blockly;
const expected={blink:['pinMode(13, OUTPUT)','digitalWrite(13, HIGH)','digitalWrite(13, LOW)','delay(500)'],serial:['Serial.begin(115200)','Serial.println("Hello, CK LAB!")','delay(500)'],wifi:['#include <WiFi.h>','WiFi.begin("MyWiFi", "12345678")','while (WiFi.status() != WL_CONNECTED)']};
const evidence=process.env.CK_LAB_EVIDENCE_DIR||path.join(repo,'local/alpha30-evidence');fs.mkdirSync(evidence,{recursive:true});
const results=[];
for(const [id,example] of Object.entries(mod.examples)){
 mod.setBlocklyBoard(example.board);mod.setArduinoGeneratorTarget(example.board,id==='wifi'?'3.3.6':'1.8.6');
 const ws=new Blockly.Workspace();
 const xml=`<xml xmlns="https://developers.google.com/blockly/xml">${example.xml}</xml>`;
 Blockly.Xml.domToWorkspace(Blockly.utils.xml.textToDom(xml),ws);
 const code=mod.stripBlockMarkers(mod.arduinoGenerator.workspaceToCode(ws));
 expected[id].forEach(value=>assert(code.includes(value),`${id}: ${value}`));
 assert(!code.includes('undefined'));assert(ws.getAllBlocks(false).length>2);
 const saved=Blockly.Xml.domToText(Blockly.Xml.workspaceToDom(ws));
 const roundtrip=new Blockly.Workspace();Blockly.Xml.domToWorkspace(Blockly.utils.xml.textToDom(saved),roundtrip);
 assert.equal(mod.stripBlockMarkers(mod.arduinoGenerator.workspaceToCode(roundtrip)),code);
 fs.writeFileSync(path.join(evidence,`CK-LAB-${id}.ck`),JSON.stringify({format:'ck-project',schema_version:1,migration_version:1,name:example.name,board:example.board,board_package_id:example.board,xml:saved,code,options:''},null,2));
 fs.writeFileSync(path.join(evidence,id+'.ino'),code);
 if(id==='blink'){
  const number=ws.getAllBlocks(false).find(b=>b.type==='math_number'&&b.getFieldValue('NUM')===500);
  number.setFieldValue(750,'NUM');
  assert(mod.arduinoGenerator.workspaceToCode(ws).includes('delay(750)'));
 }
 results.push({id,blocks:ws.getAllBlocks(false).length,code:true,xmlRoundtrip:true});ws.dispose();roundtrip.dispose();
}
const result={status:'PASS',pages:htmlFiles.length,localLinks:links,examples:results};
fs.writeFileSync(path.join(evidence,'website-checks.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
