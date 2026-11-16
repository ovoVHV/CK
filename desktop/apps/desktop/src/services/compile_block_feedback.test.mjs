import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';
import { JSDOM } from 'jsdom';
const source = (await fs.readFile(new URL('./compile_block_feedback.ts', import.meta.url), 'utf8')).replace("from 'blockly'", `from '${import.meta.resolve('blockly')}'`);
const { markCompileError, clearCompileErrors, revealCompileError } = await import('data:text/javascript;base64,' + Buffer.from(ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.ESNext}}).outputText).toString('base64'));
const dom = new JSDOM('<svg></svg>');
function block(id, parent=null) {
 const root = dom.window.document.createElementNS('http://www.w3.org/2000/svg','g');
 return {id, root, warnings:new Map(), collapsed:false, getSvgRoot:()=>root,
  setWarningText(text,key){if(text==null)this.warnings.delete(key);else this.warnings.set(key,text);},
  getSurroundParent:()=>parent, isCollapsed(){return this.collapsed;},setCollapsed(value){this.collapsed=value;}};
}
test('compile feedback clears its own icon text and red class without clearing library warnings',()=>{
 const b=block('third-party'), untouched=block('other');
 b.setWarningText('Library warning','vendor');
 markCompileError(b,'Unknown symbol');
 assert(b.root.classList.contains('ck-block-compile-error'));
 assert.equal(b.warnings.get('ck-compile-error'),'Unknown symbol');
 clearCompileErrors({getAllBlocks:()=>[b,untouched]});
 assert(!b.root.classList.contains('ck-block-compile-error'));
 assert.deepEqual([...b.warnings], [['vendor','Library warning']]);
});
test('locating expands collapsed ancestors before centering the reported block',()=>{
 const outer=block('outer'), inner=block('inner',outer), target=block('target',inner);
 outer.collapsed=inner.collapsed=target.collapsed=true;
 let centered=null;
 revealCompileError({getBlockById:id=>id==='target'?target:null,centerOnBlock(id){assert(!outer.collapsed&&!inner.collapsed&&!target.collapsed);centered=id;}},'target');
 assert.equal(centered,'target');
});
