import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {asyncRun} from '../src/discovery.mjs';import {digest} from '../src/protocol.mjs';
import {qualifyNativeElfRecipe,writeEsp32S3App} from '../src/native/elf-image.mjs';
import {qualifyNativeMergeRecipe,mergeImage} from '../src/native/merge-bin.mjs';
const [oldEvidence,out]=process.argv.slice(2);
if(!oldEvidence||!out)throw Error('Usage: image-recipe-qualification EXISTING_SHARED_PCH_EVIDENCE NEW_OUTPUT_DIRECTORY');
const a=JSON.parse(fs.readFileSync(path.join(oldEvidence,'runs/q0-cold.receipt.json'))),sysroot=a.compileDatabase[0].directory,tool=a.stageTimings.find(x=>x.rule==='app-image').executable;
fs.mkdirSync(out,{recursive:true});const report={status:'RUNNING',rows:[],reference:'esptool v5.1.0 actual executable; all output bytes compared'},file=path.join(out,'image-recipe-qualification.json'),save=()=>fs.writeFileSync(file,JSON.stringify(report,null,2));
try{
 const elf=a.artifacts.find(a=>a.name==='sketch.ino.elf').file,build=path.dirname(elf);
 const imageCases=[...['1MB','2MB','4MB','8MB','16MB','32MB','64MB','128MB'].map(size=>['dio','80m',size]),...['qio','qout','dout'].flatMap(mode=>[['40m','4MB'],['80m','8MB']].map(([freq,size])=>[mode,freq,size])),['dio','26m','4MB'],['dio','20m','4MB']];
 for(const [mode,freq,size] of imageCases){
  const argv=[tool,'--chip','esp32s3','elf2image','--flash-mode',mode,'--flash-freq',freq,'--flash-size',size,'--elf-sha256-offset','0xb0','-o',path.join(build,'sketch.ino.bin'),elf];
  const spec=qualifyNativeElfRecipe({expanded:true,fqbn:'esp32:esp32:esp32s3:FlashSize='+size.replace('MB','M'),argv,build,sysroot});assert(spec);
  spec.output=path.join(out,'native.bin');writeEsp32S3App(spec);const cmd=[...argv];cmd[13]=path.join(out,'official.bin');const r=await asyncRun(cmd,sysroot);assert.equal(r.code,0,r.stderr);
  const native=fs.readFileSync(spec.output),official=fs.readFileSync(cmd[13]);assert(native.equals(official),[mode,freq,size].join('/'));report.rows.push({kind:'elf2image',mode,freq,size,sha256:digest(native),bytes:native.length});save();console.log('PASS image '+[mode,freq,size].join('/'));
 }
 for(const [i,chip] of ['esp32s3','esp32','esp32c3'].entries()){
  const r=JSON.parse(fs.readFileSync(path.join(oldEvidence,'runs/q'+i+'-cold.receipt.json'))),build=path.dirname(r.artifacts.find(a=>a.name==='sketch.ino.elf').file),core=r.compileDatabase.find(x=>/[/\\]cores[/\\]esp32[/\\]/.test(x.file)),platform=path.resolve(path.dirname(core.file),'../..');
  for(const size of ['2MB','4MB','8MB','16MB','32MB']){
   const argv=[tool,'--chip',chip,'merge-bin','-o',path.join(build,'sketch.ino.merged.bin'),'--pad-to-size',size,'--flash-mode','keep','--flash-freq','keep','--flash-size','keep',chip==='esp32'?'0x1000':'0x0',path.join(build,'sketch.ino.bootloader.bin'),'0x8000',path.join(build,'sketch.ino.partitions.bin'),'0xe000',path.join(platform,'tools/partitions/boot_app0.bin'),'0x10000',path.join(build,'sketch.ino.bin')];
   const spec=qualifyNativeMergeRecipe({expanded:true,fqbn:'esp32:esp32:'+chip,argv,build,sysroot,platform});assert(spec);spec.output=path.join(out,'native-merged.bin');mergeImage(spec);const cmd=[...argv];cmd[5]=path.join(out,'official-merged.bin');const result=await asyncRun(cmd,sysroot);assert.equal(result.code,0,result.stderr);
   const native=fs.readFileSync(spec.output),official=fs.readFileSync(cmd[5]);assert(native.equals(official),chip+'/'+size);report.rows.push({kind:'merge',chip,size,sha256:digest(native),bytes:native.length});save();console.log('PASS merge '+chip+'/'+size);
  }
 }
 report.status='PASS';
}catch(e){report.status='FAIL';report.error=String(e.stack);console.error(e);process.exitCode=1;}finally{save();}
