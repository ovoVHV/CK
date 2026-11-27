// A deliberately bounded fast frontend. Library selection is still performed
// by the official frontend whenever directives or discovery inputs change.
// Prototype generation uses the installed Arduino ctags and the actual target
// compiler preprocessor, not regex extraction of C++ function signatures.
import fs from 'node:fs';
import {readPreprocessed} from './tool-text.mjs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { nonInteractiveStdio } from '../process-stdio.mjs';
import { executable, sha, writeChanged } from './plan.mjs';
import {reusablePreprocess} from './preprocess-proof.mjs';
import {observeCommandDiagnostics} from '../build-resource-evidence.mjs';
import {sketchSnapshot} from '../sketch-files.mjs';

export class NeedsOfficialFrontend extends Error {}
const literalInclude = /^\s*#\s*include\s*(?:<[^>\r\n]+>|"[^"\r\n]+")\s*$/;
// Only ordinary, object-like constants in the sketch preamble. The complete
// directive (including its value and position among includes) keys discovery.
const integerDefine = /^\s*#\s*define\s+([A-Z][A-Z0-9_]*)\s+[+-]?(?:0[xX][\da-fA-F]+|0[bB][01]+|0[0-7]*|[1-9]\d*)(?:[uU](?:ll|LL|[lL])?|(?:ll|LL|[lL])[uU]?)?\s*$/;
const directiveNames = new Set('include define undef if ifdef ifndef elif else endif line error warning pragma include_next import'.split(' '));
function rejectDirective(line, number, detail) {
  const word = line.match(/^\s*#\s*([a-z_]+)/i)?.[1];
  const kind = directiveNames.has(word) ? '#' + word : 'preprocessor directive';
  throw new NeedsOfficialFrontend(`${kind} at line ${number}: ${detail}`);
}
export function contractText(code) {
  let commentsMasked = '', syntax = '';
  const spaces = text => text.replace(/[^\r\n]/g, ' ');
  for (let i = 0; i < code.length;) {
    if (code.startsWith('//', i) || code.startsWith('/*', i)) {
      const line = code.startsWith('//', i);
      let end = line ? code.indexOf('\n', i + 2) : code.indexOf('*/', i + 2);
      if (end < 0) {
        if (!line) throw new NeedsOfficialFrontend('Unterminated source comment');
        end = code.length;
      } else if (!line) end += 2;
      const masked = spaces(code.slice(i, end)); commentsMasked += masked; syntax += masked; i = end;
      continue;
    }
    // Header-name tokens are not C++ comments or strings. In particular a
    // slash inside <...> must never be erased from the discovery identity.
    if (code[i] === '<' && /^\s*#\s*include\s*$/.test(commentsMasked.slice(commentsMasked.lastIndexOf('\n') + 1))) {
      const end = code.indexOf('>', i + 1);
      if (end < 0 || /[\r\n]/.test(code.slice(i, end))) throw new NeedsOfficialFrontend('Unterminated header name');
      const token = code.slice(i, end + 1); commentsMasked += token; syntax += spaces(token); i = end + 1; continue;
    }
    if (code.startsWith('R"', i)) throw new NeedsOfficialFrontend('Raw string outside frontend contract');
    if (code[i] === '"' || code[i] === "'") {
      const begin = i, quote = code[i++]; let closed = false;
      while (i < code.length) {
        if (code[i] === '\\') { i += 2; continue; }
        if (code[i] === quote) { i++; closed = true; break; }
        if (code[i] === '\n' || code[i] === '\r') break;
        i++;
      }
      if (!closed) throw new NeedsOfficialFrontend('Unterminated source literal');
      const token = code.slice(begin, i); commentsMasked += token; syntax += spaces(token); continue;
    }
    commentsMasked += code[i]; syntax += code[i++];
  }
  return { commentsMasked, syntax };
}
export function sourceContract(code) {
  // Restrict this adapter to a single ordinary generated sketch. Unsupported
  // syntax continues through the official frontend, never a guessed prototype.
  // GCC also splices a backslash followed by horizontal whitespace and LF.
  if (/\?\?|%:|\\[^\S\r\n]*\r?\n|\r(?!\n)/.test(code)) throw new NeedsOfficialFrontend('Complex sketch syntax');
  const { commentsMasked, syntax } = contractText(code);
  const directives = [], names = new Set(); let seenCode = false, number = 0;
  for (const line of commentsMasked.split(/\r?\n/)) {
    number++;
    if (!/^\s*#/.test(line)) { if (line.trim()) seenCode = true; continue; }
    if (!literalInclude.test(line)) {
      const name = line.match(integerDefine)?.[1];
      if (!name || seenCode || name.includes('__') || names.has(name))
        rejectDirective(line, number, 'outside the literal include / integer constant preamble');
      names.add(name);
    }
    directives.push(line.trimEnd());
  }
  if (/\b(namespace|class|struct|union|template|typedef|extern)\b|_Pragma/.test(syntax)) throw new NeedsOfficialFrontend('Complex sketch syntax');
  return sha(directives.join('\n'));
}
export function literalSketchIncludes(code){sourceContract(code);const {commentsMasked}=contractText(code);return [...commentsMasked.matchAll(/^\s*#\s*include\s*[<"]([^>"\r\n]+)[>"]/gm)].map(m=>m[1]);}
export function generateSketch(config, plan, preprocessing=null) {
  const sketch = path.resolve(config.sketchDir, path.basename(config.sketchDir) + '.ino');
  const code = fs.readFileSync(sketch, 'utf8').replace(/^\uFEFF/, '').replaceAll('\r\n', '\n');
  sourceContract(code);
  if (sketchSnapshot(config.sketchDir).other.length) throw new NeedsOfficialFrontend('Unsupported sketch inputs');
  const entry = plan.db.find(row => path.basename(row.file) === path.basename(sketch) + '.cpp');
  if (!entry) throw new NeedsOfficialFrontend('Missing sketch compilation unit');
  const generated = entry.file, scratch = path.join(plan.graph, 'frontend');
  fs.mkdirSync(scratch, { recursive: true });
  const escaped = sketch.replaceAll('\\', '\\\\');
  const line = n => '#line ' + n + ' "' + escaped + '"\n';
  const header = /^\s*#\s*include\s*[<"]Arduino\.h[>"]/m.test(code) ? '' : '#include <Arduino.h>\n';
  const raw = header + line(1) + code + '\n';
  const original = fs.existsSync(generated) ? fs.readFileSync(generated) : null;
  const originalStat = original === null ? null : fs.statSync(generated);
  writeChanged(generated, raw);
  const preprocessed = path.join(scratch, 'sketch_merged.cpp');
  const argv = entry.arguments.slice(1).filter(arg => arg !== '-MMD').map((arg, index, all) => all[index - 1] === '-o' ? preprocessed :
    arg.startsWith('@') && path.basename(arg.slice(1)) === 'file_opts' ? '@' + path.join(plan.graph, 'normal-file-options.rsp') : arg);
  argv.unshift('-E', '-CC', '-dD', '-x', 'c++');
  let candidate, macroNames,preprocessedText,preprocessReused=false;
  try {
    if(reusablePreprocess(preprocessing,[entry.arguments[0],...argv],entry.directory,raw)){
      fs.writeFileSync(preprocessed,preprocessing.bytes);preprocessReused=true;
    }else{
      const pre = spawnSync(executable(entry.arguments[0]), argv, { cwd: entry.directory, encoding: 'utf8', windowsHide: true, stdio: nonInteractiveStdio(), maxBuffer: 32 * 1024 * 1024, timeout: 60000 });
      if (pre.status !== 0) throw new NeedsOfficialFrontend('Preprocessing requires official resolution: ' + (pre.stderr ?? '').slice(-2000));
      observeCommandDiagnostics({stderr:pre.stderr});
    }
    // Ctags sees only sketch-origin preprocessed tokens, not the entire C++ SDK.
    // Preserve line markers so prototypes retain the original diagnostic lines.
    let active = false; const filtered = [];
    preprocessedText = readPreprocessed(preprocessed,entry.directory);
    macroNames = [...new Set([...preprocessedText.matchAll(/^#define\s+([A-Za-z_]\w*)/gm)].map(match => match[1]))];
    for (const text of preprocessedText.split(/\r?\n/)) {
      const marker = text.match(/^#(?:line)?\s+(\d+)\s+("(?:\\.|[^"\\])*")/);
      if (marker) {
        active = path.resolve(JSON.parse(marker[2])).toLowerCase() === sketch.toLowerCase();
        if (active) filtered.push('#line ' + marker[1] + ' ' + marker[2]);
      } else if (active) filtered.push(text);
    }
    const filteredFile = path.join(scratch, 'sketch_filtered.cpp');
    writeChanged(filteredFile, filtered.join('\n') + '\n');
    const ctags = executable(path.join(config.sysroot, 'packages/builtin/tools/ctags/5.8-arduino11/ctags'));
    const tags = spawnSync(ctags, ['-u', '--language-force=c++', '-f', '-', '--c++-kinds=svpf', '--fields=KSTtzns', '--line-directives', filteredFile],
      { cwd: entry.directory, encoding: 'utf8', windowsHide: true, stdio: nonInteractiveStdio(), maxBuffer: 32 * 1024 * 1024, timeout: 30000 });
    if (tags.status !== 0) throw new NeedsOfficialFrontend('ctags failed');
    const records = tags.stdout.split(/\r?\n/).filter(Boolean).map(text => {
      const columns = text.split('\t');
      return { name: columns[0], file: columns[1], ...Object.fromEntries(columns.slice(3).map(field => {
        const i = field.indexOf(':'); return [field.slice(0, i), field.slice(i + 1)];
      })) };
    }).filter(tag => path.resolve(tag.file).toLowerCase() === sketch.toLowerCase());
    const declarations = new Set(records.filter(tag => tag.kind === 'prototype').map(tag => tag.name + tag.signature));
    const functions = records.filter(tag => tag.kind === 'function' && !declarations.has(tag.name + tag.signature));
    const sourceLines = code.split('\n');
    for (const tag of functions) {
      if (!/^[A-Za-z_]\w*$/.test(tag.name) || !tag.signature || !tag.returntype || tag.signature.includes('=') ||
          tag.namespace || tag.class || tag.struct || tag.signature.includes('...') ||
          !new RegExp('\\b' + tag.name + '\\s*\\(').test(sourceLines[Number(tag.line) - 1] ?? '')) {
        throw new NeedsOfficialFrontend('Unqualified prototype form');
      }
    }
    const first = functions.length ? Math.min(...functions.map(tag => Number(tag.line))) : 0;
    if (!first) candidate = raw;
    else {
      const before = sourceLines.slice(0, first - 1).join('\n');
      const after = sourceLines.slice(first - 1).join('\n');
      const prototypes = functions.map(tag => line(tag.line) + tag.returntype + ' ' + tag.name + tag.signature + ';\n').join('');
      candidate = header + line(1) + (before ? before + '\n' : '') + prototypes + line(first) + after + '\n';
    }
  } finally {
    // Restore before deciding whether to publish the new generated input. This
    // preserves Ninja timestamps for unchanged source and for rejected paths.
    if (original !== null) { fs.writeFileSync(generated, original); fs.utimesSync(generated, originalStat.atime, originalStat.mtime); }
  }
  return { generated, code: candidate, sourceHash: sha(code), directivesHash: sourceContract(code),preprocessReused,preprocessedText,
    literalTemplate: { source: code, generated: candidate, macroNames } };
}

// Complex sketches keep the official prototype transformation. A deliberately
// narrower replay can still handle a literal delay()/delayMicroseconds() call:
// it cannot change a declaration, include, preprocessor condition or macro.
// Capture all macro definitions with the actual target compiler (including
// definitions later undefined), and never synthesize prototypes for this path.
export function qualifiesOfficialDelaySource(source) {
  if (/\\\r?\n|\?\?|%:|_Pragma/.test(source)) return false;
  // Limit the complex path to literal includes and simple object-like
  // constants. Conditional branches and structural/function macros can make
  // raw-source delimiter depth differ from the compiler's active token stream.
  for (const line of source.split('\n').filter(line => /^\s*#/.test(line))) {
    if (/^\s*#\s*include\s*[<"][^>"\r\n]+[>"]\s*(?:\/\/.*)?$/.test(line)) continue;
    if (/^\s*#\s*define\s+[A-Za-z_]\w*(?:\s+(?:[A-Za-z_]\w*|(?:0[xX][\dA-Fa-f]+|\d+)[uUlL]*|"(?:\\.|[^"\\])*"))?\s*(?:\/\/.*)?$/.test(line)) continue;
    return false;
  }
  const tokens = lexical(source);
  if (!tokens || tokens.some(t => t.depth < 0 || t.parens < 0 || t.brackets < 0)) return false;
  const last = tokens.at(-1);
  if (!last) return false;
  return last.depth + (last.value === '{' ? 1 : last.value === '}' ? -1 : 0) === 0 &&
    last.parens + (last.value === '(' ? 1 : last.value === ')' ? -1 : 0) === 0 &&
    last.brackets + (last.value === '[' ? 1 : last.value === ']' ? -1 : 0) === 0;
}
export function captureOfficialDelayTemplate(config, plan) {
  const sketch = path.resolve(config.sketchDir, path.basename(config.sketchDir) + '.ino');
  const source = fs.readFileSync(sketch, 'utf8').replace(/^\uFEFF/, '').replaceAll('\r\n', '\n');
  if (!qualifiesOfficialDelaySource(source)) return null;
  const sources = fs.readdirSync(config.sketchDir).filter(name => /\.(ino|pde|cpp|c|h|hpp|s)$/i.test(name));
  if (sources.length !== 1 || sources[0] !== path.basename(sketch)) return null;
  const entry = plan.db.find(row => path.basename(row.file) === path.basename(sketch) + '.cpp');
  if (!entry) return null;
  const generated = fs.readFileSync(entry.file, 'utf8');
  const scratch = path.join(plan.graph, 'frontend');
  fs.mkdirSync(scratch, { recursive: true });
  const preprocessed = path.join(scratch, 'official-delay-macros.cpp');
  const argv = entry.arguments.slice(1).filter(arg => arg !== '-MMD').map((arg, index, all) => all[index - 1] === '-o' ? preprocessed :
    arg.startsWith('@') && path.basename(arg.slice(1)) === 'file_opts' ? '@' + path.join(plan.graph, 'normal-file-options.rsp') : arg);
  argv.unshift('-E', '-dD', '-x', 'c++');
  const pre = spawnSync(executable(entry.arguments[0]), argv, { cwd: entry.directory, encoding: 'utf8', windowsHide: true, stdio: nonInteractiveStdio(), maxBuffer: 32 * 1024 * 1024, timeout: 60000 });
  if (pre.status !== 0) return null;
  const macroNames = [...new Set([...readPreprocessed(preprocessed,entry.directory).matchAll(/^#define\s+([A-Za-z_]\w*)/gm)].map(match => match[1]))];
  return { source, generated, macroNames, contract: 'official-delay-calls-v1' };
}

// Numeric field edits are common in Blockly. When token structure, line layout
// and all identifiers remain identical, and edited lines contain no macros,
// Arduino's prototype transformation is unchanged. Reuse that proven transform;
// the compiler still rebuilds the changed translation unit normally.
function lexical(text) {
  const result = []; let i = 0, line = 0, depth = 0, parens = 0, brackets = 0;
  if (text.includes('R"')) return null;
  while (i < text.length) {
    const tail = text.slice(i);
    const match = tail.match(/^(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[A-Za-z_]\w*|(?:0[xX][\dA-Fa-f]+|0[bB][01]+|\d+)(?:[uUlL]+)?|.)/);
    if (!match) return null;
    const value = match[0];
    result.push({ value, line, depth, parens, brackets, number: /^(?:0[xX][\dA-Fa-f]+|0[bB][01]+|\d+)(?:[uUlL]+)?$/.test(value) });
    if (value === '{') depth++; else if (value === '}') depth--;
    if (value === '(') parens++; else if (value === ')') parens--;
    if (value === '[') brackets++; else if (value === ']') brackets--;
    line += (value.match(/\n/g) ?? []).length; i += value.length;
  }
  return result;
}
export function reuseLiteralTransformation(template, nextSource) {
  if (!template) return null;
  const before = lexical(template.source), after = lexical(nextSource);
  if (!before || !after || before.length !== after.length) return null;
  const touched = new Set(), macros = new Set(template.macroNames);
  const significant = before.map((token, index) => ({ ...token, index }))
    .filter(token => !/^\s+$|^\/\/|^\/\*/.test(token.value));
  const positions = new Map(significant.map((token, position) => [token.index, position]));
  for (let i = 0; i < before.length; i++) {
    if (before[i].value === after[i].value) continue;
    if (!before[i].number || !after[i].number || before[i].line !== after[i].line || before[i].depth < 1) return null;
    if (template.contract === 'official-delay-calls-v1') {
      if (before[i].parens !== 1 || before[i].brackets !== 0) return null;
      const at = positions.get(i), call = significant[at - 2]?.value;
      if (!['delay', 'delayMicroseconds'].includes(call) || significant[at - 1]?.value !== '(' ||
          significant[at + 1]?.value !== ')' || significant[at + 2]?.value !== ';') return null;
      // A preceding macro on another line could stringize or interpret the
      // call. Only complete standalone statements inside an existing body are
      // admitted; comments and layout remain byte-for-byte unchanged.
      const prefix = significant[at - 3]?.value;
      if (!['{', '}', ';'].includes(prefix)) return null;
      if (/^\s*#/.test(template.source.split('\n')[before[i].line])) return null;
      if (macros.has(call)) return null;
    }
    touched.add(before[i].line);
  }
  if (!touched.size) return null;
  for (const token of before) if (touched.has(token.line) && macros.has(token.value)) return null;
  const original = template.source.split('\n'), next = nextSource.split('\n'), generated = template.generated.split('\n');
  if (original.length !== next.length) return null;
  let cursor = generated.length - 1;
  for (let line = original.length - 1; line >= 0; line--) {
    while (cursor >= 0 && generated[cursor] !== original[line]) cursor--;
    if (cursor < 0) return null;
    if (touched.has(line)) generated[cursor] = next[line];
    cursor--;
  }
  return { ...template, source: nextSource, generated: generated.join('\n') };
}
