#!/usr/bin/env node
// Explicit native graph experiment helper. Preserve official fallback argv/cwd.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mergeImage } from './native/merge-bin.mjs';
import { writeEsp32S3App } from './native/elf-image.mjs';
import { objectCacheEnvironment, objectCacheMode } from './native/object-cache.mjs';
import {checkSize} from './native/size-check.mjs';
import {nonInteractiveStdio} from './process-stdio.mjs';
import {removeOptionalFile} from './filesystem.mjs';
const command = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (command.archiveTemporary) removeOptionalFile(command.archiveTemporary);
const started = performance.now();
let exitCode, mode = 'official';
if (command.nativeMergeBin || command.nativeElfImage) {
  try {
    if (command.nativeElfImage) writeEsp32S3App(command.nativeElfImage);
    else mergeImage(command.nativeMergeBin);
    exitCode = 0; mode = 'native-byte-exact';
  }
  catch (error) {
    console.error(`[${command.nativeElfImage ? 'NativeImage' : 'NativeMerge'}] Qualified fast path rejected input (${error.message}); using official esptool`);
    const fallback = spawnSync(command.argv[0], command.argv.slice(1), {
      cwd: command.directory, stdio: 'inherit', windowsHide: true, shell: false, windowsVerbatimArguments: command.windowsVerbatimArguments === true,
      env: { ...process.env, ...command.environment },
    });
    if (fallback.error) console.error(fallback.error.message);
    exitCode = fallback.status ?? 1;
    mode = 'official-esptool-fallback';
  }
} else if(command.sizePolicy){
  const result=spawnSync(command.argv[0],command.argv.slice(1),{cwd:command.directory,windowsHide:true,stdio:nonInteractiveStdio(),encoding:'utf8',env:{...process.env,...command.environment}});
  exitCode=result.status??1;mode='official-size-validation';
  try{if(result.error||exitCode!==0)throw Error(result.error?.message||result.stderr||'Size tool failed');fs.writeFileSync(command.sizeOutput,JSON.stringify(checkSize(result.stdout,command.sizePolicy))+'\n');}
  catch(error){console.error(error.message);exitCode=1;}
} else {
  const statsFile = command.timingFile + '.ccache';
  if (command.compilerCache && fs.existsSync(statsFile)) fs.unlinkSync(statsFile);
  const environment = { ...process.env, ...command.environment };
  const result = spawnSync(command.compilerCache?.executable ?? command.argv[0], command.compilerCache ? command.argv : command.argv.slice(1), {
    cwd: command.directory, stdio: 'inherit', windowsHide: true, shell: false, windowsVerbatimArguments: command.windowsVerbatimArguments === true,
    env: command.compilerCache ? objectCacheEnvironment(environment, command.compilerCache.configFile, statsFile) : environment,
  });
  if (result.error) console.error(result.error.message);
  exitCode = result.status ?? 1;
  if (command.compilerCache) mode = objectCacheMode(fs.existsSync(statsFile) ? fs.readFileSync(statsFile, 'utf8') : '');
}
if (command.timingFile) fs.writeFileSync(command.timingFile, JSON.stringify({
  elapsedMs: performance.now() - started, exitCode, mode, executable: mode === 'native-byte-exact'
    ? (command.nativeElfImage ? 'node-native-esp32s3-elf2image' : 'node-native-esp32-merge') : command.argv[0],
}) + '\n');
if (exitCode !== 0) process.exit(exitCode);
if (command.archiveTemporary) fs.renameSync(command.archiveTemporary, command.archiveOutput);
