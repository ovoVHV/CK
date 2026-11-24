import path from 'node:path';
import {sha} from '../resolver.mjs';
import {qualifiedEsptool} from './image-recipe.mjs';

// Only a complete, validated tool/ELF pair and this closed argv shape can
// describe a reusable conversion. The caller owns the bytes in its live session.
export function bootIdentity(argv,c,output,assetProof){
 if(argv.length!==13||!qualifiedEsptool(argv[0],c.sysroot)
  ||argv[1]!=='--chip'||argv[3]!=='elf2image'||argv[4]!=='--flash-mode'
  ||argv[6]!=='--flash-freq'||argv[8]!=='--flash-size'||argv[10]!=='-o'
  ||![2,5,7,9].every(i=>/^[A-Za-z0-9_]+$/.test(argv[i]))
  ||path.resolve(argv[11])!==output||!path.isAbsolute(argv[12])||!Array.isArray(assetProof?.rows))return null;
 const inputs=[argv[0],argv[12]].map(f=>assetProof.rows.find(r=>r[1]==='file'&&r[0]===path.resolve(f))?.[3]);
 if(inputs.some(x=>typeof x!=='string'||!/^[a-f0-9]{64}$/.test(x)))return null;
 return sha(JSON.stringify([c.fqbn,c.sysroot,argv,inputs,assetProof.sha256,c.sourceDateEpoch,process.env.TZ]));
}
