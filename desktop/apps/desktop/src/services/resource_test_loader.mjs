import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const cache = new Map();
export async function resourceModuleUrl(url) {
  if (cache.has(url.href)) return cache.get(url.href);
  const source = await readFile(url, 'utf8');
  let code = url.pathname.endsWith('.json') ? `export default ${source};` : ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText;
  for (const match of [...code.matchAll(/from\s+['"]([^'"]+)['"]/g)]) {
    const spec = match[1];
    const target = spec.startsWith('.') ? await resourceModuleUrl(new URL(spec.endsWith('.json') ? spec : `${spec}.ts`, url)) : pathToFileURL(require.resolve(spec)).href;
    code = code.replaceAll(`'${spec}'`, `'${target}'`).replaceAll(`"${spec}"`, `"${target}"`);
  }
  const result = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  cache.set(url.href, result);
  return result;
}
export async function loadResourceModule(name) { return import(await resourceModuleUrl(new URL(name, import.meta.url))); }
export async function loadResourceBoardNormalizer() {
  const source = await readFile(new URL('./board_manager.ts', import.meta.url), 'utf8');
  const helper = await resourceModuleUrl(new URL('./resource_contract.ts', import.meta.url));
  const pin = await resourceModuleUrl(new URL('./pin_code_token.ts', import.meta.url));
  const code = `import { validateResourceGraph } from '${helper}';\nimport { normalizePinCodeToken } from '${pin}';\n${source.slice(source.indexOf('type UnknownRecord'), source.indexOf('export class BoardManager'))}`;
  const output = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);
}
