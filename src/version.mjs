export const ENGINE_VERSION = '1.0.64';
export const PROTOCOL_VERSION = 1;
export const CACHE_SCHEMA = 1;
export const THREAT_MODEL = 'T1-session';
export const ARTIFACTS = Object.freeze(['sketch.ino.elf','sketch.ino.bin','sketch.ino.partitions.bin','sketch.ino.merged.bin','flash_args','boot_app0.bin','sketch.ino.bootloader.bin','sdkconfig','build.options.json','partitions.csv']);
export const AVR_ARTIFACTS = Object.freeze(['sketch.ino.elf','sketch.ino.hex','sketch.ino.eep','build.options.json']);
export function artifactsFor(fqbn) {
  const [vendor,arch]=String(fqbn).split(':');
  if(vendor==='arduino'&&arch==='avr')return AVR_ARTIFACTS;
  if(vendor==='esp32'&&arch==='esp32')return ARTIFACTS;
  throw Error('Unsupported artifact target');
}
