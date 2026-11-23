import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { unlink } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorView } from '@codemirror/view';

test('long generated code is read-only, virtualized and still highlighted',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{pretendToBeVisual:true,url:'http://localhost'});
 for(const key of ['window','Window','document','HTMLElement','Element','Node','MutationObserver','Range','getComputedStyle'])globalThis[key]=dom.window[key];
 globalThis.ResizeObserver=class{observe(){}disconnect(){}unobserve(){}};
 globalThis.requestAnimationFrame=dom.window.requestAnimationFrame.bind(dom.window);
 globalThis.cancelAnimationFrame=dom.window.cancelAnimationFrame.bind(dom.window);
 dom.window.Range.prototype.getClientRects=()=>[];
 dom.window.Range.prototype.getBoundingClientRect=()=>({top:0,left:0,right:0,bottom:0,width:0,height:0});
 globalThis.IS_REACT_ACT_ENVIRONMENT=true;
 const output=new URL(`./.preview-test-${process.pid}.mjs`,import.meta.url);
 await build({entryPoints:[fileURLToPath(new URL('./SketchCodePreview.tsx',import.meta.url))],outfile:fileURLToPath(output),
  bundle:true,packages:'external',platform:'node',format:'esm',jsx:'automatic',logLevel:'silent'});
 const {SketchCodePreview}=await import(output.href);await unlink(output);
 const root=createRoot(document.querySelector('#root'));
 const code='#define MOTOR_PIN 5\nvoid setup() {\n'+'  delay(MOTOR_PIN);\n'.repeat(6000)+'}';
 try{
  await act(async()=>root.render(React.createElement(SketchCodePreview,{code,dark:false})));
  const view=EditorView.findFromDOM(document.querySelector('.cm-editor'));
  assert.ok(code.length>100000);assert.equal(view.state.doc.toString(),code);
  assert.equal(view.contentDOM.contentEditable,'false'===view.contentDOM.contentEditable?'false':undefined); // JSDOM may omit the IDL property.
  assert.equal(view.contentDOM.getAttribute('contenteditable'),'false');assert.equal(view.state.readOnly,true);
  assert.ok(view.contentDOM.querySelectorAll('.cm-line').length<150);
  assert.ok(view.contentDOM.querySelector('.ck-cpp-constant'));
 }finally{await act(async()=>root.unmount());dom.window.close();}
});
