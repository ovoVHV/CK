// Run from the source checkout after installing the pinned desktop dependencies.
import {build} from '../desktop/apps/desktop/node_modules/esbuild/lib/main.js';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
await build({entryPoints:[path.join(root,'desktop/apps/desktop/src/services/ai_avr_simulator.ts')],
 outfile:path.join(root,'tests/fixtures/ai-phase3/simulator.mjs'),bundle:true,platform:'node',format:'esm',logLevel:'silent'});
console.log('Built bounded offline firmware verifier for regression fixtures.');
