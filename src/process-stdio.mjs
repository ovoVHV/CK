import fs from 'node:fs';
import os from 'node:os';

let input;
// Compiler, CLI property queries and image tools read named files, never an
// interactive request from stdin. Passing an existing NUL handle also avoids
// the extra Windows console process seen with three newly-created pipes.
// Keep stdout/stderr captured and the existing Job ownership unchanged.
export function nonInteractiveStdio() {
 if(process.platform!=='win32')return ['ignore','pipe','pipe'];
 input??=fs.openSync(os.devNull,'r');
 return [input,'pipe','pipe'];
}
