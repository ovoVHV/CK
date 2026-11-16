// Narrow ESP32-S3 application-image encoder. Format reference and parity oracle:
// espressif/esptool v5.1.0 (elf2image, ESP32S3FirmwareImage). No toolchain or
// compiler semantics are changed. Unsupported recipes/layouts use esptool.
import fs from 'node:fs';
import {removeOptionalFile} from '../filesystem.mjs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {parseEsp32Fqbn} from '../targets.mjs';
import {qualifiedEsptool} from './image-recipe.mjs';

const FLASH_MODES={qio:0,qout:1,dio:2,dout:3};
const FLASH_FREQUENCIES={'80m':15,'40m':0,'26m':1,'20m':2};
const FLASH_SIZES=Object.fromEntries([1,2,4,8,16,32,64,128].map((n,i)=>[n+'MB',i*16]));
const PAGE = 0x10000;
const MAX_IMAGE = 16 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest();
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const isFlash = address => (address >= 0x3c000000 && address < 0x3e000000)
  || (address >= 0x42000000 && address < 0x44000000);
// Matching memory classes matter when joining adjacent ELF sections.
const MEMORY = [[0, 0x10000], [0x3c000000, 0x3d000000], [0x3d000000, 0x3e000000],
  [0x600fe000, 0x60100000], [0x3fc88000, 0x3fd00000], [0x3fc88000, 0x403e2000],
  [0x3fc88000, 0x3fd00000], [0x40000000, 0x4001a100], [0x40370000, 0x403e0000],
  [0x600fe000, 0x60100000], [0x42000000, 0x42800000], [0x50000000, 0x50002000]];
const memoryClass = address => MEMORY.reduce((mask, [start, end], i) =>
  mask | (address >= start && address < end ? 1 << i : 0), 0);

export function qualifyNativeElfRecipe({ fqbn, argv, build, sysroot,expanded=false }) {
  if (!parseEsp32Fqbn(fqbn) || !Array.isArray(argv) || argv.length !== 15) return null;
  if(!expanded&&(fqbn!=='esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB'||!samePath(argv[0],path.join(sysroot,'packages/esp32/tools/esptool_py/5.1.0/esptool.exe'))||argv[5]!=='dio'||argv[7]!=='80m'||argv[9]!=='16MB'))return null;
  if (!qualifiedEsptool(argv[0],sysroot)) return null;
  if (!Object.hasOwn(FLASH_MODES,argv[5]) || !Object.hasOwn(FLASH_FREQUENCIES,argv[7]) || !Object.hasOwn(FLASH_SIZES,argv[9])) return null;
  if (argv.slice(1, 13).join('\0') !== ['--chip', 'esp32s3', 'elf2image', '--flash-mode', argv[5],
    '--flash-freq', argv[7], '--flash-size', argv[9], '--elf-sha256-offset', '0xb0', '-o'].join('\0')) return null;
  const input = path.join(build, 'sketch.ino.elf'), output = path.join(build, 'sketch.ino.bin');
  if (!samePath(argv[13], output) || !samePath(argv[14], input)) return null;
  return { input, output, format: 'esp32s3-recipe-v2',flashMode:argv[5],flashFrequency:argv[7],flashSize:argv[9] };
}

function checkedSlice(bytes, offset, size) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0
    || offset + size > bytes.length) throw new Error('Truncated ELF data');
  return bytes.subarray(offset, offset + size);
}

export function encodeEsp32S3App(elf,{flashMode='dio',flashFrequency='80m',flashSize='16MB'}={}) {
  if(!Object.hasOwn(FLASH_MODES,flashMode)||!Object.hasOwn(FLASH_FREQUENCIES,flashFrequency)||!Object.hasOwn(FLASH_SIZES,flashSize))throw Error('Unsupported flash configuration');
  if (!Buffer.isBuffer(elf) || elf.length < 52 || elf.length > 256 * 1024 * 1024) throw new Error('Invalid ELF size');
  if (!elf.subarray(0, 7).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1]))
    || elf.readUInt16LE(16) !== 2 || elf.readUInt16LE(18) !== 94
    || elf.readUInt32LE(20) !== 1 || elf.readUInt16LE(40) !== 52
    || elf.readUInt16LE(46) !== 40) throw new Error('Expected executable ELF32 little-endian Xtensa');
  const count = elf.readUInt16LE(48), tableAt = elf.readUInt32LE(32), namesIndex = elf.readUInt16LE(50);
  if (!count || namesIndex >= count) throw new Error('Invalid ELF section table');
  checkedSlice(elf, tableAt, count * 40);
  const phCount = elf.readUInt16LE(44);
  if (phCount) {
    if (elf.readUInt16LE(42) !== 32) throw new Error('Invalid ELF program table');
    checkedSlice(elf, elf.readUInt32LE(28), phCount * 32);
  }
  const namesHeader = tableAt + namesIndex * 40;
  if (elf.readUInt32LE(namesHeader + 4) !== 3) throw new Error('Invalid ELF section names');
  const names = checkedSlice(elf, elf.readUInt32LE(namesHeader + 16), elf.readUInt32LE(namesHeader + 20));
  const segments = [];
  for (let index = 0; index < count; index++) {
    const at = tableAt + index * 40, type = elf.readUInt32LE(at + 4);
    const address = elf.readUInt32LE(at + 12), size = elf.readUInt32LE(at + 20);
    if (!address || !size || type === 8 || type === 3) continue;
    if (![1, 14, 15, 16].includes(type)) throw new Error('Unsupported addressed ELF section');
    if (!memoryClass(address) || size >= MAX_IMAGE || address + size > 0x100000000) throw new Error('Unsupported ELF section range');
    const nameAt = elf.readUInt32LE(at), end = names.indexOf(0, nameAt);
    if (nameAt >= names.length || end < nameAt) throw new Error('Invalid ELF section name');
    const name = names.toString('utf8', nameAt, end);
    const data = Buffer.alloc(Math.ceil(size / 4) * 4);
    checkedSlice(elf, elf.readUInt32LE(at + 16), size).copy(data);
    const previous = segments.at(-1);
    if (previous && previous.address + previous.data.length === address
      && memoryClass(previous.address) === memoryClass(address)) {
      if (previous.data.length + data.length >= MAX_IMAGE) throw new Error('Image section too large');
      previous.data = Buffer.concat([previous.data, data]);
    } else segments.push({ address, data, name });
  }
  if (!segments.length || segments.length > 16) throw new Error('Unsupported image segment count');
  const sorted = [...segments].sort((a, b) => a.address - b.address);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i - 1].address + sorted[i - 1].data.length > sorted[i].address) throw new Error('Overlapping ELF sections');
  }
  const flash = sorted.filter(x => isFlash(x.address)), ram = sorted.filter(x => !isFlash(x.address));
  const moveFirst = (items, name) => { const i = items.findIndex(x => x.name === name); if (i > 0) items.unshift(items.splice(i, 1)[0]); };
  moveFirst(flash, '.flash.appdesc'); moveFirst(ram, '.dram0.bootdesc');
  for (let i = 1; i < flash.length; i++) {
    if (Math.floor(flash[i - 1].address / PAGE) === Math.floor(flash[i].address / PAGE)) throw new Error('Conflicting flash mapping pages');
  }
  const header = Buffer.alloc(24);
  header[0] = 0xe9; header[2] = FLASH_MODES[flashMode]; header[3] = FLASH_SIZES[flashSize]|FLASH_FREQUENCIES[flashFrequency];
  header.writeUInt32LE(elf.readUInt32LE(24), 4);
  header[8] = 0xee; header.writeUInt16LE(9, 12);
  header.writeUInt16LE(0xffff, 17); header[23] = 1;
  const chunks = [header], elfHash = digest(elf);
  let position = 24, checksum = 0xef, segmentCount = 0, patched = false;
  function appendSegment(address, bytes) {
    if ((bytes.length & 3) || bytes.length >= MAX_IMAGE || position + 8 + bytes.length >= MAX_IMAGE) throw new Error('Invalid image segment size');
    if (0xb0 >= position && 0xb0 < position + bytes.length) {
      const patch = 0xb0 - position;
      if (patch < 8 || patch + 32 > bytes.length || !bytes.subarray(patch - 8, patch + 24).equals(Buffer.alloc(32)))
        throw new Error('ELF digest destination is not an empty segment field');
      bytes = Buffer.from(bytes); elfHash.copy(bytes, patch - 8); patched = true;
    }
    const prefix = Buffer.alloc(8); prefix.writeUInt32LE(address); prefix.writeUInt32LE(bytes.length, 4);
    chunks.push(prefix, bytes); position += 8 + bytes.length;
    for (const byte of bytes) checksum ^= byte;
    if (++segmentCount > 16) throw new Error('Too many image segments after alignment');
  }
  for (const segment of flash) {
    let iterations = 0;
    while ((position + 8) % PAGE !== segment.address % PAGE) {
      if (++iterations > 32) throw new Error('Unsupported flash alignment');
      // Preserve esptool's next-page placement at exact page boundaries;
      // reducing this gap modulo PAGE would emit a different segment layout.
      const gap = PAGE - (position % PAGE) + (segment.address % PAGE) - 16;
      const padding = gap < 0 ? gap + PAGE : gap;
      if (!padding || (padding & 3)) throw new Error('Unsupported flash padding');
      if (ram.length && padding > 8) {
        const part = ram[0], take = Math.min(padding, part.data.length);
        appendSegment(part.address, part.data.subarray(0, take));
        part.address += take; part.data = part.data.subarray(take);
        if (!part.data.length) ram.shift();
      } else appendSegment(0, Buffer.alloc(padding));
    }
    appendSegment(segment.address, segment.data);
  }
  for (const segment of ram) appendSegment(segment.address, segment.data);
  if (!patched) throw new Error('ELF digest field was not materialized');
  header[1] = segmentCount;
  const tail = Buffer.alloc(16 - (position % 16)); tail[tail.length - 1] = checksum;
  chunks.push(tail);
  const image = Buffer.concat(chunks);
  return Buffer.concat([image, digest(image)]);
}

export function writeEsp32S3App(spec) {
  if (!spec || !['esp32s3-dio-80m-16MB-v1','esp32s3-recipe-v2'].includes(spec.format) || !path.isAbsolute(spec.input)
    || !path.isAbsolute(spec.output) || samePath(spec.input, spec.output)) throw new Error('Invalid native application image specification');
  const stat = fs.lstatSync(spec.input);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('ELF input must be a regular file');
  const bytes = encodeEsp32S3App(fs.readFileSync(spec.input),spec.format==='esp32s3-recipe-v2'?spec:undefined);
  const temporary = `${spec.output}.ck-image-${process.pid}-${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx' });
    fs.renameSync(temporary, spec.output);
  } finally {
    removeOptionalFile(temporary);
  }
}
