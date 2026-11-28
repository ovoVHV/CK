import fs from 'node:fs';
import path from 'node:path';
import {loadLibrary} from '../resolver.mjs';

function reject(lib, why) {
  throw Object.assign(Error(`${lib.name || path.basename(lib.install_dir)}: ${why}`),
    {code:'NOT_QUALIFIED', fallbackSafe:true});
}

// The CLI's compilation database omits the distinction between true and full.
// On that route read the same manifest from the verified library asset tree.
export function libraryLinkage(lib, props) {
  const none = {sources:true, discover:true, directory:null, archives:[], flags:[]};
  if (!lib.precompiled) return none;
  const manifest = lib.properties?.precompiled ? lib.properties : loadLibrary(lib.install_dir,'unmanaged')?.properties;
  const full = manifest?.precompiled === 'full';
  if (!['true','full'].includes(manifest?.precompiled)) reject(lib,'inconsistent precompiled manifest');
  none.discover = !full;
  if (!Object.hasOwn(props,'compiler.libraries.ldflags')) return none;
  const mcu = props['build.mcu'];
  if (!/^[a-zA-Z0-9_-]+$/.test(mcu) || /(?:float-abi|fpu)/i.test(props['recipe.cpp.o.pattern'] ?? ''))
    reject(lib,'unqualified target/FPU directory selection');
  const directory = path.join(lib.source_dir,mcu);
  let entries;
  try { entries = fs.readdirSync(directory,{withFileTypes:true}); }
  catch (e) { if (e.code === 'ENOENT') return none; throw e; }
  if (entries.some(e=>e.isSymbolicLink())) reject(lib,'linked precompiled input');
  const files = entries.filter(e=>e.isFile()).map(e=>e.name).sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
  if (!files.length) return none;
  // Keep loader scripts, shared libraries and thin archives (external members)
  // on the CLI route. Never guess which file they would read.
  if (!files.every(n=>/^[a-zA-Z0-9_+.-]+\.a$/.test(n))) reject(lib,'target binary directory contains files other than standard static archives');
  const archives = files.map(n=>path.join(directory,n));
  for (const file of archives) {
    const fd=fs.openSync(file,'r'), magic=Buffer.alloc(8);
    try { if (fs.readSync(fd,magic,0,8,0)!==8 || magic.toString()!=='!<arch>\n') reject(lib,'not a self-contained static archive: '+path.basename(file)); }
    finally { fs.closeSync(fd); }
  }
  const flags = (lib.ldflags ?? lib.ld_flags ?? manifest.ldflags ?? '').trim().split(/\s+/).filter(Boolean);
  if (!flags.every(f=>/^-l[a-zA-Z0-9_+.-]+$/.test(f))) reject(lib,'custom linker options require Arduino CLI: '+flags.join(' '));
  return {sources:!full,discover:!full,directory,archives,flags};
}

// GCC ar replaces a same-named member in its original slot when the CLI
// submits one object at a time. A single ar process needs the winning list.
export function archiveMembers(ordered) {
  const slots=new Map(), caseNames=new Map();
  for (const file of ordered) {
    const name=path.basename(file), folded=name.toLowerCase();
    if (caseNames.has(folded) && caseNames.get(folded)!==name) throw Error('Archive members differ only by case: '+name);
    caseNames.set(folded,name); slots.set(name,file);
  }
  return [...slots.values()];
}
