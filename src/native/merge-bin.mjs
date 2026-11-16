import fs from 'node:fs';
import {removeOptionalFile} from '../filesystem.mjs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {parseEsp32Fqbn} from '../targets.mjs';
import {qualifiedEsptool} from './image-recipe.mjs';

const FLASH_SIZES = new Set([1,2,4,8,16,32,64,128].map(n=>n*1024*1024));
const PROJECT = 'sketch.ino';

function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

// esptool's raw merge with all flash parameters set to keep is byte copying
// plus 0xff padding. Qualify that complete recipe, not a single board menu.
export function qualifyNativeMergeRecipe({ fqbn, argv, build, sysroot, platform,expanded=false }) {
  if (!parseEsp32Fqbn(fqbn)) return null;
  if (!Array.isArray(argv) || argv.length !== 22 || path.basename(argv[0]).toLowerCase() !== 'esptool.exe') return null;
  if(!expanded&&(fqbn!=='esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB'||!samePath(argv[0],path.join(sysroot,'packages/esp32/tools/esptool_py/5.1.0/esptool.exe'))||argv[7]!=='16MB'||argv[2]!=='esp32s3'))return null;
  if (!qualifiedEsptool(argv[0],sysroot)) return null;
  if (argv[1] !== '--chip' || !/^esp32(?:s[23]|c[2356]|h2|p4)?$/.test(argv[2]) || argv[3] !== 'merge-bin' || argv[4] !== '-o') return null;
  const output = path.join(build, `${PROJECT}.merged.bin`);
  if (!samePath(argv[5], output)) return null;
  const size=/^(1|2|4|8|16|32|64|128)MB$/.exec(argv[7]);
  if (!size || argv.slice(6, 14).join('\0') !== ['--pad-to-size', argv[7], '--flash-mode', 'keep', '--flash-freq', 'keep', '--flash-size', 'keep'].join('\0')) return null;
  const expected = [
    [argv[2]==='esp32'?'0x1000':'0x0', path.join(build, `${PROJECT}.bootloader.bin`)],
    ['0x8000', path.join(build, `${PROJECT}.partitions.bin`)],
    ['0xe000', path.join(platform, 'tools/partitions/boot_app0.bin')],
    ['0x10000', path.join(build, `${PROJECT}.bin`)],
  ];
  for (let i = 0; i < expected.length; i++) {
    if (argv[14 + i * 2] !== expected[i][0] || !samePath(argv[15 + i * 2], expected[i][1])) return null;
  }
  return { output, padBytes: Number(size[1])*1024*1024, inputs: expected.map(([offset, file]) => ({ offset: Number.parseInt(offset, 16), file })) };
}

export function mergeImage(spec) {
  if (!spec || !FLASH_SIZES.has(spec.padBytes) || !path.isAbsolute(spec.output) || !Array.isArray(spec.inputs)) {
    throw new Error('Invalid qualified ESP32 merge specification');
  }
  const output = path.resolve(spec.output);
  const ranges = [];
  const image = Buffer.alloc(spec.padBytes, 0xff);
  if (spec.inputs.length !== 4) throw new Error('Qualified ESP32 merge requires exactly four inputs');
  for (const input of spec.inputs) {
    if (!input || !Number.isSafeInteger(input.offset) || input.offset < 0 || !path.isAbsolute(input.file)) throw new Error('Invalid merge input');
    const file = path.resolve(input.file);
    if (samePath(file, output)) throw new Error('Merge output cannot also be an input');
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Merge input must be a regular file');
    const bytes = fs.readFileSync(file);
    if (!bytes.length || input.offset + bytes.length > image.length) throw new Error('Merge input exceeds qualified flash image');
    ranges.push({ start: input.offset, end: input.offset + bytes.length, file });
    bytes.copy(image, input.offset);
  }
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end) throw new Error('Overlapping ESP32 merge inputs');
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temporary = `${output}.ck-merge-${process.pid}-${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, image, { flag: 'wx' });
    fs.renameSync(temporary, output);
  } finally {
    removeOptionalFile(temporary);
  }
}
