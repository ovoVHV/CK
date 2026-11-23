// Windows-native ESP32 graph adapter. Input is an official CLI frontend result;
// compilation, archive, link and image actions are executed by Ninja.
import fs from 'node:fs';
import {linkExecution,buildFileExecution} from './link-paths.mjs';
import {parseFqbn,platformVersionSupported,platformRecipeHash} from '../targets.mjs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { nonInteractiveStdio } from '../process-stdio.mjs';
import {decodeToolPath} from './tool-text.mjs';
import { fileURLToPath } from 'node:url';
import { qualifyNativeMergeRecipe } from './merge-bin.mjs';
import { qualifyNativeElfRecipe } from './elf-image.mjs';
import { toolchainFingerprint, objectCacheConfig, nativeDependencyTarget, compilerInvocationCacheable } from './object-cache.mjs';

export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const PLAN_SEMANTICS_VERSION = 9;
export const slash = value => String(value).replaceAll('\\', '/');
// Arduino's Windows builder orders native paths. Replacing '\\' with '/'
// before sorting changes directory-prefix order (epd3c\\ precedes epd\\),
// which also changes linked read-only/unwind data even when .text is equal.
export const officialObjectPathKey = file => path.win32.normalize(String(file));
export const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
export function writeChanged(file, value) {
  const bytes = Buffer.from(value);
  if (fs.existsSync(file) && fs.readFileSync(file).equals(bytes)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return true;
}
// This caches a pure string parse, never filesystem identities. responses()
// still reads every response file; changed content gets a different key.
const tokenMemo=new Map();let tokenMemoEnabled=false,tokenMemoBytes=0;
export function setRecipeTokenMemo(enabled){tokenMemoEnabled=enabled;tokenMemo.clear();tokenMemoBytes=0;}
export function tokens(text) {
  if(tokenMemoEnabled&&tokenMemo.has(text))return [...tokenMemo.get(text)];
  const result = []; let token = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { quoted = !quoted; continue; }
    if (/\s/.test(c) && !quoted) { if (token) result.push(token); token = ''; }
    else token += c;
  }
  if (quoted) throw new Error('Unclosed recipe quote');
  if (token) result.push(token);
  if(tokenMemoEnabled&&text.length<1024*1024){if(tokenMemo.size>=64||tokenMemoBytes+text.length>4*1024*1024){tokenMemo.clear();tokenMemoBytes=0;}tokenMemo.set(text,Object.freeze([...result]));tokenMemoBytes+=text.length;}
  return result;
}
export function executable(file) {
  if (fs.existsSync(file)) return path.resolve(file);
  if (fs.existsSync(file + '.exe')) return path.resolve(file + '.exe');
  throw new Error('Missing tool: ' + file);
}
export function properties(lines) {
  return Object.fromEntries(lines.map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
}
export function responses(argv, cwd, seen = new Set()) {
  const files = [], expanded = [];
  for (const arg of argv) {
    if (!arg.startsWith('@')) { expanded.push(arg); continue; }
    const file = path.resolve(cwd, arg.slice(1));
    if (seen.has(file)) throw new Error('Response-file cycle: ' + file);
    const next = responses(tokens(fs.readFileSync(file, 'utf8')), cwd, new Set([...seen, file]));
    files.push(file, ...next.files); expanded.push(...next.expanded);
  }
  return { files: [...new Set(files)], expanded };
}
function within(root, file) {
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Output outside build directory: ' + file);
  return path.resolve(file);
}
function output(argv) { const i = argv.indexOf('-o'); if (i < 0) throw new Error('Missing -o'); return argv[i + 1]; }

export function createPlan(config, frontend) {
  if (!frontend.success) throw new Error('Official frontend failed');
  const build = path.resolve(config.workspace, 'build'), graph = path.resolve(config.workspace, 'graph');
  const props = properties(frontend.builder_result.build_properties);
  const platform = props['runtime.platform.path'];
  const target=parseFqbn(config.fqbn),arch=props['build.arch']?.toLowerCase();
  if (!target || target.arch!==arch || !platformVersionSupported(arch,path.basename(platform))) throw new Error('Unsupported target/Core');
  for (const file of ['platform.local.txt', 'boards.local.txt']) if (fs.existsSync(path.join(platform, file))) throw new Error('Local platform overrides need qualification');
  if (sha(fs.readFileSync(path.join(platform, 'platform.txt'))) !== platformRecipeHash(arch,path.basename(platform))) throw new Error('Platform recipes changed; qualification required');
  for (const library of frontend.builder_result.used_libraries ?? []) {
    if (library.precompiled || library.dot_a_linkage || library.ldflags || ['Insights', 'ESP_SR'].includes(path.basename(library.install_dir))) throw new Error('Library archive or active special hooks need qualification');
  }
  if (props['compiler.libraries.ldflags']?.trim()) throw new Error('Precompiled/library linker flags require separate qualification');
  if (/^build\.library_discovery_phase=/m.test(fs.readFileSync(path.join(platform, 'platform.txt'), 'utf8'))) throw new Error('Discovery-specific semantics unsupported');
  const db = readJson(path.join(build, 'compile_commands.json'));
  const rules = [], cwd = db[0].directory;
  const archive = path.join(build, 'core', 'core.a');
  const coreObjects = [], directObjects = [], directOrder = new Map();
  const coreOptions = path.join(graph, 'core-file-options.rsp'), normalOptions = path.join(graph, 'normal-file-options.rsp');
  writeChanged(coreOptions, '-DARDUINO_CORE_BUILD\n'); writeChanged(normalOptions, '');
  // The official hooks mutate a shared file_opts between sketch/library/core
  // phases. Parallel graph actions need distinct, immutable response files.
  for (const [index, entry] of db.entries()) {
    if (!entry.arguments?.includes('-MMD') || entry.arguments.includes('-MF')) throw new Error('Unsupported dependency recipe');
    const target = within(build, path.resolve(entry.directory, output(entry.arguments)));
    const isCore = path.relative(path.join(build, 'core'), target).split(path.sep)[0] !== '..' && target.startsWith(path.join(build, 'core') + path.sep);
    const argv = entry.arguments.map(arg => arg.startsWith('@') && path.basename(arg.slice(1)) === 'file_opts' ? '@' + (isCore ? coreOptions : normalOptions) : arg);
    argv[0] = executable(argv[0]);
    (isCore ? coreObjects : directObjects).push(target);
    if (!isCore) {
      const source = path.resolve(entry.file);
      const libraryIndex = (frontend.builder_result.used_libraries ?? []).findIndex(lib => source.startsWith(path.resolve(lib.source_dir) + path.sep));
      const sketchUnit = source.startsWith(path.join(build, 'sketch') + path.sep);
      if (!sketchUnit && libraryIndex < 0) throw new Error('Cannot establish official object group: ' + source);
      directOrder.set(target, (sketchUnit ? '00000' : String(libraryIndex + 1).padStart(5, '0')) + ':' + officialObjectPathKey(target));
    }
    rules.push({ name: 'compile-' + sha(target).slice(0, 16), kind: 'compile', argv, directory: entry.directory,
      inputs: [path.resolve(entry.directory, entry.file)], output: target, depfile: target.replace(/\.o$/, '.d') });
  }
  // GCC's pipe transport retains every output byte while avoiding the temporary
  // assembly file. Only the locally qualified compiler/target uses this path.
  const qualifiedS3 = config.fqbn === 'esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB';
  if (qualifiedS3 && config.pipeCompilation === true) {
    for (const rule of rules.filter(rule => rule.kind === 'compile')) {
      if (!rule.argv.includes('-pipe')) rule.argv.push('-pipe');
    }
  }
  // The ESP32-S3 sketch is the dominant edit-time compile unit. A persistent
  // Arduino.h PCH is safe only for the already-qualified recipe: the strict
  // probe established byte-identical objects when the PCH include path and
  // debug-prefix mapping are identical to the baseline command.
  if (config.fqbn === 'esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB') {
    const sketchRule = rules.find(rule => rule.kind === 'compile'
      && rule.inputs[0] === path.join(build, 'sketch','sketch.ino.cpp'));
    if (!sketchRule) throw new Error('Qualified sketch compile command missing for PCH');
    const coreInclude = sketchRule.argv.find(arg => arg.startsWith('-I') && /cores[/\\]esp32$/i.test(arg.slice(2)));
    if (!coreInclude) throw new Error('Qualified ESP32 core include path missing for PCH');
    const core = path.resolve(coreInclude.slice(2));
    const sourceHeader = path.join(core, 'Arduino.h');
    const pchDir = path.join(build, '.ck-pch');
    const header = path.join(pchDir, 'Arduino.h');
    const output = header + '.gch';
    const depfile = path.join(pchDir, 'Arduino.h.d');
    fs.mkdirSync(pchDir, { recursive: true });
    writeChanged(header, fs.readFileSync(sourceHeader));

    const pchArgs = sketchRule.argv.slice(1);
    for (const flag of ['-c', '-MMD']) {
      const index = pchArgs.indexOf(flag);
      if (index >= 0) pchArgs.splice(index, 1);
    }
    const source = sketchRule.inputs[0];
    const sourceIndex = pchArgs.findIndex(arg => {
      try { return path.resolve(sketchRule.directory, arg) === source; } catch { return false; }
    });
    if (sourceIndex < 0) throw new Error('Sketch source operand missing from PCH command');
    pchArgs.splice(sourceIndex, 1);
    const outputIndex = pchArgs.indexOf('-o');
    if (outputIndex < 0) throw new Error('Sketch output operand missing from PCH command');
    pchArgs.splice(outputIndex, 2);
    const includeIndex = pchArgs.findIndex(arg => arg.startsWith('-I'));
    if (includeIndex < 0) throw new Error('Sketch include operands missing from PCH command');
    pchArgs.splice(includeIndex, 0, '-I' + pchDir, '-fdebug-prefix-map=' + pchDir + '=' + core);
    const pchArgv = [sketchRule.argv[0], ...pchArgs, '-x', 'c++-header', '-MMD', '-MF', depfile, header, '-o', output];
    rules.push({ name: 'sketch-pch', kind: 'pch', argv: pchArgv, directory: sketchRule.directory,
      inputs: [header, sourceHeader], output, depfile });
    const compileIncludeIndex = sketchRule.argv.findIndex(arg => arg.startsWith('-I'));
    sketchRule.argv.splice(compileIncludeIndex, 0, '-I' + pchDir, '-fdebug-prefix-map=' + pchDir + '=' + core);
    sketchRule.inputs.push(output);
  }
  const cacheExecutable = path.join(config.sysroot, 'bin/ccache.exe');
  const cacheRules = qualifiedS3 && config.objectCache === true ? rules.filter(rule => rule.kind === 'compile'
    && rule.output.startsWith(path.join(build, 'libraries') + path.sep)
    && !rule.argv.some(arg => /^-M[QT]/.test(arg))
    && compilerInvocationCacheable(responses(rule.argv.slice(1), rule.directory).expanded)) : [];
  if (cacheRules.length && fs.existsSync(cacheExecutable)) {
    // The host identity lease remains mandatory. Also bind every compiler
    // component here, so direct standalone sessions cannot reuse an object
    // across a cc1/as/plugin upgrade just because the driver stayed unchanged.
    const toolchainRoot = path.dirname(path.dirname(rules.find(rule => rule.kind === 'compile').argv[0]));
    const namespace = sha(JSON.stringify([toolchainFingerprint(toolchainRoot), config.fqbn, config.buildSignature ?? null]));
    const configFile = path.join(graph, 'object-cache.conf');
    writeChanged(configFile, objectCacheConfig(path.join(config.workspace, 'object-cache'), namespace));
    // Unchanged Core objects already survive discovery transitions in Ninja.
    // Cache the library units whose include-search argv changes on discovery;
    // do not charge the Core or PCH sketch an extra preprocessing pass.
    for (const rule of cacheRules) {
      rule.argv.push('-MT', nativeDependencyTarget(rule.output));
      rule.compilerCache = { executable: cacheExecutable, configFile, namespace };
    }
  }
  // CCDB append order follows parallel completions. Official archive members
  // are Windows-path-sorted; link inputs are sketch first, then discovery-order
  // library groups, with each group's objects in that same native-path order.
  coreObjects.sort((a, b) => officialObjectPathKey(a) < officialObjectPathKey(b) ? -1 : officialObjectPathKey(a) > officialObjectPathKey(b) ? 1 : 0);
  directObjects.sort((a, b) => directOrder.get(a) < directOrder.get(b) ? -1 : directOrder.get(a) > directOrder.get(b) ? 1 : 0);
  function recipe(key, replacements = {}) {
    let text = props[key]; if (!text) throw new Error('Missing recipe: ' + key);
    for (const [name, value] of Object.entries(replacements)) text = text.replaceAll('{' + name + '}', value);
    if (/\{[^}]+\}/.test(text)) throw new Error('Unresolved recipe: ' + key);
    const argv = tokens(text); argv[0] = executable(argv[0]); return argv;
  }
  const ar = recipe('recipe.ar.pattern', { archive_file_path: archive + '.ck-tmp', archive_file:'core/core.a.ck-tmp', object_file: '__CK_MEMBER__' });
  if (ar[1] !== (arch==='avr'?'rcs':'cr') || ar.at(-1) !== '__CK_MEMBER__') throw new Error('Unqualified archive recipe');
  rules.push({ name: 'core-archive', kind: 'archive', directory: cwd, argv: [...ar.slice(0, -1), ...coreObjects],
    output: archive, inputs: coreObjects, archiveTemporary: archive + '.ck-tmp', archiveOutput: archive });
  const link = recipe('recipe.c.combine.pattern', { object_files: directObjects.map(file => '"' + file + '"').join(' '), archive_file_path: archive, archive_file:'core/core.a' });
  const linkResponses = responses(link.slice(1), cwd), expanded = linkResponses.expanded;
  const dirs = expanded.filter(x => x.startsWith('-L')).map(x => path.resolve(cwd, x.slice(2)));
  function resolveLink(name) {
    const found = [cwd, ...dirs].map(dir => path.resolve(dir, name)).find(file => fs.existsSync(file));
    if (found) return found;
    const result = spawnSync(link[0], [...expanded.filter(x=>x.startsWith('-mmcu=')||x.startsWith('-march=')||x.startsWith('-mabi=')), '-print-file-name=' + name], { cwd, windowsHide: true, stdio: nonInteractiveStdio() });
    const raw = result.stdout && Buffer.from(result.stdout.toString('latin1').trim(), 'latin1');
    const file = result.status === 0 && raw?.length ? decodeToolPath(raw, {cwd}) : null;
    if (result.status === 0 && file && file !== name && fs.existsSync(file)) return path.resolve(file);
    throw new Error('Unresolved link input: ' + name);
  }
  const linkInputs = [...directObjects, archive, ...linkResponses.files];
  for (let i = 0; i < expanded.length; i++) {
    const value = expanded[i];
    if (value.startsWith('-l')) linkInputs.push(resolveLink(value.startsWith('-l:') ? value.slice(3) : 'lib' + value.slice(2) + '.a'));
    if (value === '-T') linkInputs.push(resolveLink(expanded[++i]));
    else if (value.startsWith('-T')) linkInputs.push(resolveLink(value.slice(2)));
  }
  rules.push({ name: 'link', kind: 'link', ...linkExecution(link,cwd,build,{expanded,resolveScript:resolveLink}), output: within(build, output(link)), inputs: linkInputs });
  const sizeOutput=path.join(build,'ck-size-check.json');
  const sizePolicy={flashRegex:props['recipe.size.regex'],ramRegex:props['recipe.size.regex.data'],
    flashLimit:Number(props['upload.maximum_size']),ramLimit:Number(props['upload.maximum_data_size'])};
  if(!sizePolicy.flashRegex||!sizePolicy.ramRegex||!Number.isSafeInteger(sizePolicy.flashLimit)||sizePolicy.flashLimit<=0
    ||!Number.isSafeInteger(sizePolicy.ramLimit)||sizePolicy.ramLimit<=0)throw Error('Platform size limits are not defined');
  rules.push({name:'size-check',kind:'metadata',...buildFileExecution(recipe('recipe.size.pattern'),cwd,build),
    output:sizeOutput,inputs:[output(link)],sizePolicy,sizeOutput});
  if(arch==='avr'){
    const outputs=[];
    for(const format of ['eep','hex']){
      const argv=recipe('recipe.objcopy.'+format+'.pattern'),file=within(build,argv.at(-1));outputs.push(file);
      rules.push({name:format+'-image',kind:'image',...buildFileExecution(argv,cwd,build),output:file,inputs:[output(link)]});
    }
    return {version:PLAN_SEMANTICS_VERSION,build,graph,props,db,rules,finalOutput:outputs[1],finalOutputs:[...outputs,sizeOutput],coreObjects:coreObjects.length,scope:'Arduino AVR '+path.basename(platform)+' standard compile/archive/LTO/objcopy recipes'};
  }
  const app = recipe('recipe.objcopy.bin.pattern');
  const nativeElfImage = config.nativeImageReference?null:qualifyNativeElfRecipe({ expanded:config.features?.nativeImageRecipes===true,fqbn: config.fqbn, argv: app, build, sysroot: config.sysroot });
  rules.push({ name: 'app-image', kind: 'image', argv: app, directory: cwd, output: within(build, output(app)), inputs: [output(link)], nativeElfImage });
  const partitions = recipe('recipe.objcopy.partitions.bin.pattern');
  rules.push({ name: 'partitions', kind: 'image', argv: partitions, directory: cwd, output: within(build, partitions.at(-1)), inputs: [partitions.at(-2)] });
  const merge = recipe('recipe.hooks.objcopy.postobjcopy.3.pattern');
  const merged = within(build, output(merge));
  const nativeMergeBin = config.nativeImageReference?null:qualifyNativeMergeRecipe({ expanded:config.features?.nativeImageRecipes===true,fqbn: config.fqbn, argv: merge, build, sysroot: config.sysroot, platform });
  rules.push({ name: 'merge', kind: 'image', argv: merge, directory: cwd, output: merged,
    inputs: merge.filter(x => /\.bin$/i.test(x) && path.resolve(x) !== merged), nativeMergeBin });
  const flash = props['recipe.hooks.objcopy.postobjcopy.4.pattern'];
  if (!flash?.startsWith('cmd /c echo ')) throw new Error('Unqualified flash argument hook');
  rules.push({ name: 'flash-arguments', kind: 'metadata', directory: cwd,
    argv: [process.env.ComSpec ?? path.join(process.env.SystemRoot, 'System32/cmd.exe'), '/d', '/s', '/c', '"' + flash.slice('cmd /c '.length) + '"'],
    windowsVerbatimArguments: true, output: path.join(build, 'flash_args'), inputs: [path.join(platform, 'platform.txt')] });
  return { version: PLAN_SEMANTICS_VERSION, build, graph, props, db, rules, finalOutput: merged, finalOutputs: [merged, path.join(build, 'flash_args'),sizeOutput], coreObjects: coreObjects.length,
    scope: 'qualified ESP32 Core 3.3.6 standard recipes; official frontend owns graph discovery' };
}

export function emitGraph(plan) {
  const runner = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../execute-command.mjs');
  const esc = text => slash(text).replaceAll('$', '$$');
  const p = file => esc(file).replaceAll(':', '$:').replaceAll(' ', '$ ');
  const lines = ['ninja_required_version = 1.10', 'rule compile', '  command = $command', '  depfile = $depfile', '  deps = gcc', '  description = $label',
    'rule pch', '  command = $command', '  depfile = $depfile', '  deps = gcc', '  description = $label',
    'rule step', '  command = $command', '  description = $label'];
  fs.mkdirSync(path.join(plan.graph, 'timings'), { recursive: true });
  for (const rule of plan.rules) {
    const environment = Object.fromEntries(['SOURCE_DATE_EPOCH', 'CPATH', 'C_INCLUDE_PATH', 'CPLUS_INCLUDE_PATH', 'GCC_EXEC_PREFIX', 'LIBRARY_PATH', 'COMPILER_PATH', 'GCC_COMPARE_DEBUG']
      .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    const data = JSON.stringify({ argv: rule.argv, directory: rule.directory, environment, windowsVerbatimArguments: rule.windowsVerbatimArguments, nativeMergeBin: rule.nativeMergeBin, nativeElfImage: rule.nativeElfImage, compilerCache: rule.compilerCache, timingFile: path.join(plan.graph, 'timings', rule.name + '.json'),
      archiveTemporary: rule.archiveTemporary, archiveOutput: rule.archiveOutput, sizePolicy:rule.sizePolicy,sizeOutput:rule.sizeOutput });
    const command = path.join(plan.graph, '.commands', rule.name + '-' + sha(data).slice(0, 20) + '.json');
    writeChanged(command, data + '\n');
    const mergeExecutor = rule.nativeMergeBin ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'merge-bin.mjs') : null;
    const imageExecutor = rule.nativeElfImage ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'elf-image.mjs') : null;
    const cacheInputs = rule.compilerCache ? [rule.compilerCache.executable, rule.compilerCache.configFile, path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'object-cache.mjs')] : [];
    const dependencies = [...new Set([...rule.inputs, ...responses(rule.argv.slice(1), rule.directory).files, command, runner, ...cacheInputs, ...(mergeExecutor ? [mergeExecutor] : []), ...(imageExecutor ? [imageExecutor] : []), rule.argv[0]])];
    const ninjaRule = rule.kind === 'compile' ? 'compile' : rule.kind === 'pch' ? 'pch' : 'step';
    lines.push('build ' + p(rule.output) + ': ' + ninjaRule + ' ' + dependencies.map(p).join(' '),
      '  command = "' + esc(process.execPath) + '" "' + esc(runner) + '" "' + esc(command) + '"',
      '  label = ' + rule.kind.toUpperCase() + ' ' + path.basename(rule.output));
    if (rule.depfile) lines.push('  depfile = ' + p(rule.depfile));
  }
  lines.push('build firmware: phony ' + plan.finalOutputs.map(p).join(' '), 'default firmware');
  const file = path.join(plan.graph, 'build.ninja');
  writeChanged(file, lines.join('\n') + '\n');
  writeChanged(path.join(plan.graph, 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
  return file;
}
