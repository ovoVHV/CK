// Test-only comparison. Production receipts always hash the unmodified object.
// GCC 7 LTO emits a new section identifier even for identical command/input.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const hash=b=>createHash('sha256').update(b).digest('hex');
export function avrObjectStructure(b){
 assert.equal(b.subarray(0,7).toString('hex'),'7f454c46010101');
 assert.equal(b.readUInt16LE(16),1,'relocatable object');assert.equal(b.readUInt16LE(18),83,'AVR machine');
 const offset=b.readUInt32LE(32),size=b.readUInt16LE(46),count=b.readUInt16LE(48),names=b.readUInt16LE(50);
 assert.equal(size,40);assert(offset+size*count<=b.length);
 const rows=Array.from({length:count},(_,i)=>{
  const p=offset+i*size,start=b.readUInt32LE(p+16),length=b.readUInt32LE(p+20),type=b.readUInt32LE(p+4);
  assert(type===8||start+length<=b.length);return {nameOffset:b.readUInt32LE(p),type,flags:b.readUInt32LE(p+8),address:b.readUInt32LE(p+12),link:b.readUInt32LE(p+24),info:b.readUInt32LE(p+28),align:b.readUInt32LE(p+32),entrySize:b.readUInt32LE(p+36),length,data:type===8?Buffer.alloc(0):b.subarray(start,start+length)};
 });
 const string=(buf,n)=>{assert(n<buf.length);const end=buf.indexOf(0,n);assert(end>=n);return buf.subarray(n,end).toString();};
 const normalize=s=>s.replace(/(\.gnu\.lto_[\w.$]+)\.[0-9a-f]{1,16}$/i,'$1.<gcc-lto-id>');
 const name=i=>normalize(string(rows[names].data,rows[i].nameOffset));
 return {header:b.subarray(0,32).toString('hex'),flags:b.readUInt32LE(36),headerSize:b.readUInt16LE(40),programEntrySize:b.readUInt16LE(42),programCount:b.readUInt16LE(44),sectionEntrySize:size,sectionCount:count,sectionNamesIndex:names,sections:rows.map((r,i)=>{
  let data;
  if(r.type===3)data=r.data.toString().split('\0').map(normalize);
  else if(r.type===2){assert.equal(r.entrySize,16);data=[];for(let n=0;n<r.length;n+=16)data.push([normalize(string(rows[r.link].data,r.data.readUInt32LE(n))),r.data.readUInt32LE(n+4),r.data.readUInt32LE(n+8),r.data[n+12],r.data[n+13],r.data.readUInt16LE(n+14)]);}
  else data=hash(r.data);
  return {name:name(i),type:r.type,flags:r.flags,address:r.address,link:r.link,info:r.info,align:r.align,entrySize:r.entrySize,...(r.type!==3?{length:r.length}:{}),data};
 })};
}
