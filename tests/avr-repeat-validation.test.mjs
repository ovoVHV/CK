import test from 'node:test';
import assert from 'node:assert/strict';
import {avrRepeatValidation} from '../src/avr-repeat-validation.mjs';

test('AVR repeat tuning preserves the reference, resource limits and user overrides',()=>{
 const validation={mode:'rust',workers:4,openWorkers:16,bufferBytes:1048576,sizeGrouped:true};
 const c={fqbn:'arduino:avr:nano:cpu=atmega328old',jobs:16,validation};
 assert.deepEqual(avrRepeatValidation({...c,jobs:8},true,8),{...validation,workers:8,bufferBytes:262144});
 for(const [overrides,same,cpus] of [[{},false,16],[{},true,4],[{jobs:4},true,16],
   [{fqbn:'esp32:esp32:esp32s3'},true,16],[{validationReference:true},true,16],
   [{assetOpenReference:true},true,16],[{features:{avrRepeatValidation:false}},true,16],
   [{validation:{...validation,workers:2}},true,16],[{validation:{...validation,mode:'node'}},true,16]]){
  const cfg={...c,...overrides};assert.equal(avrRepeatValidation(cfg,same,cpus),cfg.validation);
 }
});
