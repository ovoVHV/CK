import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {packageRoot,validateConfig} from '../src/config.mjs';import path from 'node:path';
import {ENGINE_VERSION} from '../src/version.mjs';
test('candidate config never enables hash exemptions, G3 or unbounded caches',t=>{
 const f=path.join(packageRoot,'local/engine.json');if(!fs.existsSync(f)){t.skip('Local platform fixture not configured');return;}
 const c={...JSON.parse(fs.readFileSync(f)),engineVersion:ENGINE_VERSION};assert.equal(validateConfig(c).features.assetBackend,'rust');
 for(const patch of [{features:{...c.features,skipHash:true}},{features:{...c.features,receiptOptimize:true}},{limits:{...c.limits,maxWorkspaces:500}},{assetValidation:{openWorkers:64}},{engineVersion:'8.0.0'},{schemaVersion:99}])assert.throws(()=>validateConfig({...c,...patch}));
 const disabled=validateConfig({...c,features:{}});assert.equal(disabled.features.enabled,false);assert.equal(disabled.features.nativeImageRecipes,true);assert.equal(disabled.features.coldScheduling,true);
 const reference=validateConfig({...c,features:{...c.features,nativeImageRecipes:false,coldScheduling:false}});assert.equal(reference.features.nativeImageRecipes,false);assert.equal(reference.features.coldScheduling,false);
 const prior=process.env.CPATH;try{process.env.CPATH=path.resolve('external-headers');assert.throws(()=>validateConfig(c),/External search environment/);}finally{if(prior===undefined)delete process.env.CPATH;else process.env.CPATH=prior;}
});
