import path from 'node:path';
export function qualifiedEsptool(executable,sysroot){
 const relative=path.relative(path.join(sysroot,'packages/esp32/tools/esptool_py'),path.resolve(executable)).replaceAll('\\','/');
 return /^5\.1\.0(?:-cn)?\/esptool\.exe$/i.test(relative);
}
