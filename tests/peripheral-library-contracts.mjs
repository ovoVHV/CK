// Verify the actual distributable declarations against CK's shipped schemas and
// resource checker. Run with the output of library-kit/peripherals/build.py.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { loadResourceModule } from '../desktop/apps/desktop/src/services/resource_test_loader.mjs';
const require = createRequire(new URL('../desktop/apps/desktop/package.json',import.meta.url));
const Ajv = require('ajv/dist/2020').default;
const ajv = new Ajv({strict:false,allErrors:true});
const read = file => JSON.parse(fs.readFileSync(file,'utf8'));
const ids=['ck_position_servo','ck_dht22','ck_oled_ssd1306'];
const catalog=[];
for(const id of ids){
  const pkg=path.join(process.argv[2],'packages',id);
  const contract=read(path.join(pkg,'ck-blocks.json'));
  for(const [file,schema] of [['ck-blocks.json','ck-blocks-v2'],['library.json','ck-library'],[contract.entrypoints.generator,'ck-generator']]){
    const name=`https://ck.local/schemas/${schema}.schema.json`;
    if(!ajv.getSchema(name))ajv.addSchema(read(new URL(`../desktop/docs/schemas/${schema}.schema.json`,import.meta.url)));
    assert(ajv.validate(name,read(path.join(pkg,file))),`${id}/${file}: ${ajv.errorsText()}`);
  }
  catalog.push({...contract.blocks[0],library_id:id,metadata_source:'v2'});
}
const {analyzeDeclaredHardware}=await loadResourceModule('./resource_claim_binding.ts');
const {resolveAvrResourceModel}=await loadResourceModule('./avr_resource_model.ts');
const {resolveEsp32FamilyResourceModel}=await loadResourceModule('./esp32_resource_family.ts');
function instance(index,id,values){
  return {type:catalog[index].type,id,getFieldValue:()=>null,getInputTargetBlock:name=> name in values ?
    {type:'math_number', getFieldValue:n=>n==='NUM'?String(values[name]):undefined} : null};
}
for(const model of [resolveAvrResourceModel({fqbn:'arduino:avr:uno',options:{},mcu:'atmega328p',variant:'standard',coreVersion:'1.8.8',fCpu:'16000000L'}),resolveEsp32FamilyResourceModel({fqbn:'esp32:esp32:esp32s3',options:{},mcu:'esp32s3',variant:'esp32s3',coreVersion:'3.3.6',fCpu:'240000000L'})]){
  assert.equal(model.status,'ready');
  const check=(...blocks)=>analyzeDeclaredHardware(model,catalog,blocks);
  const servo=instance(0,'motor',{PIN:9});
  const separate=check(servo,instance(1,'sensor',{PIN:2}));
  assert.deepEqual(separate.report.conflicts,[]); assert.equal(separate.claims.length,2);
  assert(separate.claims.every(c=>!c.resource.toLowerCase().includes('timer')));
  assert.equal(separate.report.coverage,'partial');
  assert(check(servo,instance(1,'sensor',{PIN:9})).report.conflicts.length>0);
  const oled=instance(2,'screen',{ADDR:60});
  assert(check(oled,instance(2,'another',{ADDR:60})).report.conflicts.some(c=>c.code==='discriminator-conflict'));
  assert.equal(check(oled,instance(2,'another',{ADDR:61})).report.conflicts.length,0);
  assert(check(instance(1,'variable-pin',{})).gaps.some(g=>g.code==='unresolved-claim'));
}
console.log('PASS: three desktop schemas per package; Uno and S3 GPIO and I2C claims and conflicts');
