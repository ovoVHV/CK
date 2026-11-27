import fs from 'node:fs';import {bodyContract} from './source-contract.mjs';import {sha} from './resolver.mjs';
import {contractText,reuseLiteralTransformation} from './native/frontend.mjs';
// The prototype transform is observed once. Only fixed setup/loop bodies may change.
// Unknown macros and source topology require the real frontend again. Line
// changes qualify only through a renderer matched to an observed transform.
const tokens=s=>s.match(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z_]\w*|\S/g)??[];
const identifiers=s=>tokens(s).filter(x=>/^[A-Za-z_]\w*$/.test(x));
function ordinaryStructure(source, contract) {
 if(!contract.qualified)return null;
 const {commentsMasked}=contractText(source);let outer=commentsMasked;
 for(const span of [...contract.spans].reverse())outer=outer.slice(0,span.begin)+outer.slice(span.end);
 // bodyContract has already validated every directive and bound its full text.
 outer=outer.replace(/^[^\S\r\n]*#[^\r\n]*$/gm,'').replace(/\s+/g,'');
 const names=contract.spans.map(s=>s.function);
 if(outer!==names.map(name=>'void'+name+'(){}').join(''))return null;
 const functions=[];
 for(const span of contract.spans){
  const lineStart=source.lastIndexOf('\n',span.begin-1)+1;
  const signature=commentsMasked.slice(lineStart,span.begin);
  if(!new RegExp('^\\s*void\\s+'+span.function+'\\s*\\(\\s*\\)\\s*\\{$').test(signature))return null;
  functions.push({name:span.function,line:source.slice(0,lineStart).split('\n').length});
 }
 return {functions,directives:contract.directivesSha256,includesArduino:/^\s*#\s*include\s*[<"]Arduino\.h[>"]/m.test(commentsMasked)};
}
function renderOrdinary(source,structure,fileLiteral){
 const lines=source.split('\n'),first=structure.functions[0].line;
 const line=n=>'#line '+n+' '+fileLiteral+'\n';
 const header=structure.includesArduino?'':'#include <Arduino.h>\n';
 const before=lines.slice(0,first-1).join('\n');
 return header+line(1)+(before?before+'\n':'')+structure.functions.map(f=>line(f.line)+'void '+f.name+'();\n').join('')+line(first)+lines.slice(first-1).join('\n')+'\n';
}
function unsafeBody(t,source,contract){
 const unsafe=new Set([...t.unsafe,'__LINE__','enum','concept','requires']);
 for(const span of contract.spans){
  const body=source.slice(span.begin,span.end),items=tokens(body),code=items.filter(x=>!/^['"/]/.test(x)).join(' ');
  if(identifiers(body).some(x=>unsafe.has(x)))return 'unqualified-body-macro-or-syntax';
  if(/\b[A-Za-z_]\w*\s+[A-Za-z_]\w*\s*\(/.test(code))return 'body-declaration-unqualified';
  if(items.some(x=>x==='<'||x==='>')||code.includes(': :'))return 'scoped-or-template-body-unqualified';
  if(/[\[\]]/.test(code))return 'lambda-or-array-syntax-unqualified';
 }
 return null;
}
function rebase(t,source,generated,contract){
 const sourceStart=source.lastIndexOf('\n',contract.spans[0].begin-1)+1;
 return {...t,source,generated,contract,sourceStart,generatedStart:generated.length-(source.length-sourceStart+1),sourceSha256:sha(source),generatedSha256:sha(generated)};
}
export function captureTemplate(source,generated,preprocessed){
 const contract=bodyContract(source);if(!contract.qualified)return null;
 const aliases=[],waitMacros=new Set();const unsafe=new Set(['__COUNTER__','__TIME__','__DATE__','__TIMESTAMP__','_Pragma','asm','__asm__','class','struct','union','template','namespace','typedef','decltype','typename','using','__attribute__']);
 for(const m of preprocessed.matchAll(/^#define\s+([A-Za-z_]\w*)([^\n]*)/gm)){
  if(m[1]==='delay'||m[1]==='delayMicroseconds')waitMacros.add(m[1]);
  const replacement=m[2].trim();if(/^[A-Za-z_]\w*$/.test(replacement))aliases.push([m[1],replacement]);
  if(m[2].startsWith('(')||!(/^(?:[A-Za-z_]\w*|[+-]?(?:0[xX][0-9a-fA-F]+|\d+)[uUlL]*|"(?:\\.|[^"\\])*")$/.test(replacement)))unsafe.add(m[1]);
 }
 let changed=true;while(changed){changed=false;for(const [name,target] of aliases)if(unsafe.has(target)&&!unsafe.has(name)){unsafe.add(name);changed=true;}}
 // The source suffix begins on the line containing the first function body.
 const start=source.lastIndexOf('\n',contract.spans[0].begin-1)+1,suffix=source.slice(start)+'\n';
 if(!generated.endsWith(suffix))return null;
 const structure=ordinaryStructure(source,contract),marker=generated.match(/^(?:#include <Arduino\.h>\n)?#line 1 ("(?:\\.|[^"\\])*")\n/);
 // No synthesized transform becomes authoritative: qualify the renderer only
 // when it reproduces the observed GCC/ctags result byte for byte.
 const ordinary=structure&&marker&&!unsafe.has('setup')&&!unsafe.has('loop')&&renderOrdinary(source,structure,marker[1])===generated?{fileLiteral:marker[1],structure}:null;
 return {source,generated,contract,sourceStart:start,generatedStart:generated.length-suffix.length,unsafe:[...unsafe],waitMacros:[...waitMacros],sourceSha256:sha(source),generatedSha256:sha(generated),ordinary};
}
function replayWait(t,next,c){
 if(!t.waitMacros||!c.qualified||c.skeletonSha256!==t.contract.skeletonSha256||next.length>64*1024)return null;
 const unsafe=new Set(t.unsafe);
 if(identifiers(contractText(t.source).commentsMasked.replace(/^[^\S\r\n]*#[^\r\n]*$/gm,'')).some(id=>unsafe.has(id)))return null;
 // Compare exact tokens and call context; a comparison elsewhere in an
 // unchanged for-loop need not force a new GCC/ctags transformation.
 const r=reuseLiteralTransformation({source:t.source,generated:t.generated,macroNames:[...unsafe,...t.waitMacros],contract:'official-delay-calls-v1'},next);
 if(!r)return null;
 const start=next.lastIndexOf('\n',c.spans[0].begin-1)+1;
 if(r.generated!==t.generated.slice(0,t.generatedStart)+next.slice(start)+'\n')return null;
 return {hit:true,reason:'observed-standalone-wait-literal-edit',code:r.generated,template:rebase(t,next,r.generated,c)};
}
export function replayTemplate(t,next){
 if(!t)return {hit:false,reason:'no-authorized-template'};
 if(next===t.source)return {hit:true,reason:'identical-source',code:t.generated};
 const c=bodyContract(next);
 if(t.ordinary&&c.qualified){
  const shape=ordinaryStructure(next,c);
  if(shape&&shape.directives===t.ordinary.structure.directives&&JSON.stringify(shape.functions.map(x=>x.name))===JSON.stringify(t.ordinary.structure.functions.map(x=>x.name))){
   const reason=unsafeBody(t,t.source,t.contract)||unsafeBody(t,next,c);
   if(reason)return (reason==='scoped-or-template-body-unqualified'&&replayWait(t,next,c))||{hit:false,reason};
   const code=renderOrdinary(next,shape,t.ordinary.fileLiteral),template=rebase(t,next,code,c);
   template.ordinary={...t.ordinary,structure:shape};
   return {hit:true,reason:'observed-setup-loop-prototypes-with-updated-source-lines',code,template};
  }
 }
 if(!c.qualified||c.skeletonSha256!==t.contract.skeletonSha256)return {hit:false,reason:'top-level-or-directives-changed'};
 const unsafe=new Set(t.unsafe);let generated=t.generated;
 for(let i=c.spans.length-1;i>=0;i--){const old=t.contract.spans[i],now=c.spans[i],a=t.source.slice(old.begin,old.end),b=next.slice(now.begin,now.end);if(a===b)continue;
  if(a.split('\n').length!==b.split('\n').length)return {hit:false,reason:'body-line-layout-changed'};
  if([...identifiers(a),...identifiers(b)].some(x=>unsafe.has(x)))return {hit:false,reason:'unqualified-body-macro-or-syntax'};
  if(/\b[A-Za-z_]\w*\s+[A-Za-z_]\w*\s*\(/.test(tokens(b).filter(x=>!/^['"/]/.test(x)).join(' ')))return {hit:false,reason:'body-declaration-unqualified'};
  if(tokens(b).some(x=>x==='<'||x==='>')||b.includes('::'))return replayWait(t,next,c)??{hit:false,reason:'scoped-or-template-body-unqualified'};
  if(/[\[\]]/.test(tokens(b).filter(x=>!/^['"/]/.test(x)).join('')))return {hit:false,reason:'lambda-or-array-syntax-unqualified'};
  const at=t.generatedStart+old.begin-t.sourceStart,end=t.generatedStart+old.end-t.sourceStart;
  if(generated.slice(at,end)!==a)return {hit:false,reason:'template-offset-mismatch'};
  generated=generated.slice(0,at)+b+generated.slice(end);
 }
 return {hit:true,reason:'fixed-prototypes-macro-guarded-bodies',code:generated};
}
