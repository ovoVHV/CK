import fs from 'node:fs';
import path from 'node:path';

export const ESP32_PLATFORM_SHA256 = '660002bf705069e84c7e451b6ae683bf2a5a998154e0f9b01413064fb3e54816';
export const DEFAULT_FQBN = 'esp32:esp32:esp32s3';
export const ESP32_FAMILY = 'esp32:esp32:*';
export const AVR_FAMILY = 'arduino:avr:*';
export const AVR_PLATFORM_SHA256 = 'afc8745a57fcb6e88a818aebfdee241bf758c2f665cfd6541f00472809c5522a';
// Qualification is bound to the installed version AND actual definition bytes.
// Never substitute a different Core version for the user's selected platform.
export const AVR_PLATFORMS = Object.freeze({
  '1.8.6': Object.freeze({platformSha256:'513b2ee073e686a9e823a6a512e64a5a0ee33af3e1d7108e0fc869a11485a7aa',boardsSha256:'8d9bfed2385fefb4cfc1999ccf9f70ad097f8fd32f8e4b299a49ea3d1f1de8de'}),
  '1.8.7': Object.freeze({platformSha256:'6dd40c95796913de6b2e68f3a1e7c4a9204ccd328b7d9063430b73921ee64eb2',boardsSha256:'e49283dc7a276291e24e91d04b883ea4e884ea2375ed80ede0d69cbf25d40a5d'}),
  '1.8.8': Object.freeze({platformSha256:AVR_PLATFORM_SHA256,boardsSha256:'e49283dc7a276291e24e91d04b883ea4e884ea2375ed80ede0d69cbf25d40a5d'}),
});
export const TARGET_FAMILIES = Object.freeze([ESP32_FAMILY, AVR_FAMILY]);
export const coreVersionSupported = version => /^(?:3\.3\.6|3\.3\.6-cn)$/.test(version);
export const platformVersionSupported = (arch, version) => arch === 'esp32' ? coreVersionSupported(version) : arch === 'avr' && Object.hasOwn(AVR_PLATFORMS,version);
export const platformRecipeHash = (arch,version) => arch === 'avr' ? AVR_PLATFORMS[version]?.platformSha256??null : arch === 'esp32' ? ESP32_PLATFORM_SHA256 : null;

// Menu values stay in the request identity. A family selector only routes a
// request; it never makes two Flash/partition/USB/PSRAM configurations equal.
export function parseEsp32Fqbn(value) {
  const parsed = parseFqbn(value);
  return parsed?.arch === 'esp32' ? {board: parsed.board, options: parsed.options} : null;
}
export function parseFqbn(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  const fields = value.split(':');
  if (fields.length < 3 || fields.length > 4 || !TARGET_FAMILIES.includes(fields[0] + ':' + fields[1] + ':*')
    || !/^[A-Za-z0-9_.-]+$/.test(fields[2])) return null;
  const options = new Map();
  if (fields.length === 4) {
    if (!fields[3]) return null;
    for (const item of fields[3].split(',')) {
      const match = /^([A-Za-z0-9_.-]+)=([A-Za-z0-9_.-]+)$/.exec(item);
      if (!match || options.has(match[1])) return null;
      options.set(match[1], match[2]);
    }
  }
  return { vendor:fields[0], arch:fields[1], family:fields[0]+':'+fields[1]+':*', board: fields[2], options };
}
export const allowsFqbn = (allowed, fqbn) => !!parseFqbn(fqbn)
  && allowed.some(value => value === parseFqbn(fqbn).family || value === fqbn);

export function platformInstallations(sysroot, arch = 'esp32') {
  const root = path.join(sysroot, arch === 'avr' ? 'packages/arduino/hardware/avr' : 'packages/esp32/hardware/esp32');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter(version =>
    fs.existsSync(path.join(root, version, 'platform.txt'))).sort().map(version => path.join(root, version));
}
export const installedPlatforms = (sysroot,arch='esp32') => platformInstallations(sysroot,arch).filter(p=>platformVersionSupported(arch,path.basename(p)));

// Read all installed 3.3.6 board definitions. Include every chip variant that
// this board's menus can select, and all versions of the selected tool roots.
// The complete platform tree is also hashed, so changing these definitions
// invalidates the graph. Expanded recipes are checked against this closure.
export function targetAssetRoots(sysroot, fqbn) {
  const target = parseFqbn(fqbn);
  if (!target) throw Error('Invalid native target');
  if (target.arch === 'avr') {
    const platforms=installedPlatforms(sysroot,'avr');
    if(!platforms.length){const versions=platformInstallations(sysroot,'avr').map(p=>path.basename(p));throw Error(versions.length?'Unsupported installed AVR Core version(s): '+versions.join(', '):'Arduino AVR Core is not installed');}
    if (!platforms.some(p=>fs.readFileSync(path.join(p,'boards.txt'),'utf8').split(/\r?\n/).some(line=>line.startsWith(target.board+'.build.')))) throw Error('Board absent from installed AVR definitions: '+target.board);
    const roots=[path.join(sysroot,'packages/arduino/hardware/avr'),path.join(sysroot,'packages/arduino/tools/avr-gcc')];
    for(const root of roots)if(!fs.existsSync(root))throw Error('Missing target asset: '+root);
    return roots;
  }
  const mcus = new Set(), variants = new Set();
  for (const platform of installedPlatforms(sysroot)) {
    for (const line of fs.readFileSync(path.join(platform, 'boards.txt'), 'utf8').split(/\r?\n/)) {
      if (!line.startsWith(target.board + '.')) continue;
      const match = /\.build\.(mcu|chip_variant)=([a-z0-9_]+)\s*$/.exec(line);
      if (match) (match[1] === 'mcu' ? mcus : variants).add(match[2]);
    }
  }
  if (!mcus.size) throw Error('Board absent from installed ESP32 3.3.6 definitions: ' + target.board);
  const tools = path.join(sysroot, 'packages/esp32/tools');
  const roots = new Set([path.join(sysroot,'packages/esp32/hardware/esp32'),path.join(tools,'esptool_py')]);
  let sdkFound=false;
  for (const mcu of mcus) {
    roots.add(path.join(tools, ['esp32', 'esp32s2', 'esp32s3'].includes(mcu) ? 'esp-x32' : 'esp-rv32'));
    variants.add(mcu);
  }
  for (const variant of variants) {
    const root = path.join(tools, variant + '-libs');
    if (fs.existsSync(root)) {roots.add(root);sdkFound=true;}
  }
  if (!sdkFound) throw Error('Installed SDK is missing for ' + target.board);
  for (const root of roots) if (!fs.existsSync(root)) throw Error('Missing target asset: ' + root);
  return [...roots].sort();
}

export function propertiesCovered(props, roots) {
  const inside = file => typeof file === 'string' && roots.some(root => {
    const relative = path.relative(path.resolve(root), path.resolve(file));
    return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
  return ['runtime.platform.path', 'build.core.path', 'build.variant.path', 'compiler.path', ...(props['build.arch']?.toLowerCase()==='esp32'?['compiler.sdk.path']:[])]
    .every(key => inside(props[key]));
}
