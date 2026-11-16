import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
let systemEncoding;
export function windowsToolEncoding(){
 if(systemEncoding)return systemEncoding;
 if(process.platform!=='win32')return 'utf-8';
 const exe=fileURLToPath(new URL('../../bin/text-codec.exe',import.meta.url));
 const r=spawnSync(exe,[],{encoding:'utf8',windowsHide:true,timeout:10000});
 if(r.error||r.status!==0||!/^\d+\s*$/.test(r.stdout))throw Error('Cannot determine Windows tool output code page');
 const cp=Number(r.stdout),label=({65001:'utf-8',936:'gbk',932:'shift_jis',949:'euc-kr',950:'big5',874:'windows-874'})[cp]??(cp>=1250&&cp<=1258?'windows-'+cp:null);
 if(!label)throw Error('Unsupported Windows tool output code page '+cp);
 new TextDecoder(label,{fatal:true});return systemEncoding=label;
}
export function strictText(bytes,encoding='utf-8'){
 const text=new TextDecoder(encoding,{fatal:true}).decode(bytes);
 if(text.includes('\uFFFD')||text.includes('\0'))throw Error('Invalid tool text');
 return text;
}
export function toolTextCandidates(bytes,encoding=windowsToolEncoding()){
 const result=[];
 for(const label of new Set(['utf-8',encoding]))try{const text=strictText(bytes,label);if(!result.some(x=>x.text===text))result.push({encoding:label,text});}catch{}
 return result;
}
// A path from a compiler is usable only when its interpretation is unique.
// Never silently replace invalid bytes or select a different existing file.
export function decodeToolPath(bytes,{cwd=process.cwd(),encoding=windowsToolEncoding(),expected}={}){
 if(!bytes.some(b=>b>=128))return strictText(bytes);
 const rows=toolTextCandidates(bytes,encoding).map(x=>({...x,file:path.resolve(cwd,x.text)}));
 const valid=rows.filter(x=>expected?x.file.toLowerCase()===path.resolve(expected).toLowerCase():fs.existsSync(x.file));
 const unique=[...new Set(valid.map(x=>x.file))];
 if(unique.length!==1)throw Error('Missing or ambiguous compiler path encoding');
 return valid[0].text;
}
export function compilerIncludes(bytes,cwd){
 const result=[];
 for(const line of bytes.toString('latin1').split(/\r?\n/)){
  const match=line.match(/^\.+ (.+)$/);if(match)result.push(decodeToolPath(Buffer.from(match[1],'latin1'),{cwd}));
 }
 return result;
}
export function readPreprocessed(file,cwd){
 // GCC mixes native-encoded filesystem markers with unchanged UTF-8 source
 // tokens. Transcoding the whole stream would corrupt Chinese string values.
 const repaired=fs.readFileSync(file).toString('latin1').replace(/^(#(?:line)?[ \t]+\d+[ \t]+)("(?:\\.|[^"\\\r\n])*")([^\r\n]*)/gm,(line,prefix,quoted,suffix)=>{
  if(!/[\x80-\xff]/.test(quoted))return line;
  const candidates=toolTextCandidates(Buffer.from(quoted,'latin1')).flatMap(({text})=>{try{return [JSON.parse(text)];}catch{return [];}});
  const valid=[...new Set(candidates.filter(p=>/^<[^>]+>$/.test(p)||fs.existsSync(path.resolve(cwd,p))))];
  if(valid.length!==1)throw Error('Missing or ambiguous preprocessor path encoding');
  return prefix+Buffer.from(JSON.stringify(valid[0]),'utf8').toString('latin1')+suffix;
 });
 return Buffer.from(repaired,'latin1').toString('utf8');
}
