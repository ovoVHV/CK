// Run against a retained ESP32 desktop session: node tests/recheck-merge-dependencies.mjs <graph/plan.json> <cold.receipt.json>
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createPlan, tokens} from '../src/native/plan.mjs';
import {verifyMergedApp} from './merged-app-proof.mjs';

const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const saved = json(process.argv[2]), receipt = json(process.argv[3]);
assert.ok(receipt.success && receipt.fqbn.startsWith('esp32:esp32:'));
const cwd = saved.db[0].directory, props = saved.props;
const key = 'recipe.hooks.objcopy.postobjcopy.3.pattern';
const platform = props['runtime.platform.path'];
const bootApp = path.resolve(platform, 'tools/partitions/boot_app0.bin');
const mixed = file => path.dirname(file) + '/' + path.basename(file);
const relative = path.relative(cwd, bootApp);
assert.ok(!path.isAbsolute(relative), 'this fixture needs a recipe-local boot_app0 path');
const argv = tokens(props[key]).map(arg => {
  if (!/\.bin$/i.test(arg)) return arg;
  const resolved = path.resolve(cwd, arg);
  return resolved === bootApp ? relative : mixed(resolved);
});
const recipe = argv.map(a => `"${a}"`).join(' ');
const plan = createPlan({workspace:path.dirname(saved.build), sysroot:cwd, fqbn:receipt.fqbn, nativeImageReference:true}, {
  success:true, builder_result:{
    build_properties:Object.entries({...props, [key]:recipe}).map(([k,v]) => `${k}=${v}`),
    used_libraries:receipt.selectedLibraries
  }
});
const rule = name => plan.rules.find(r => r.name === name);
const merge = rule('merge');
assert.deepEqual(merge.argv.slice(1), argv.slice(1), 'official tool operands changed');
assert.deepEqual(merge.inputs, [path.join(plan.build, 'sketch.ino.bootloader.bin'), rule('partitions').output, bootApp, rule('app-image').output]);
assert.ok(!merge.inputs.includes(merge.output), 'self-dependency');
const read = name => fs.readFileSync(path.join(plan.build, name));
const result = verifyMergedApp(read('flash_args').toString('utf8'), read('sketch.ino.bin'), read('sketch.ino.merged.bin'));
console.log(`${receipt.fqbn}: verified both producer edges, relative static input, no self-edge, current ${result.bytes} application bytes at ${result.offset}`);
