import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {loadLibrary} from '../src/resolver.mjs';
import {libraryLinkage} from '../src/native/library-linkage.mjs';
import {loadConfig} from '../src/config.mjs';
import {BuildController} from '../src/controller.mjs';
import {digest} from '../src/protocol.mjs';

const put=(file,text)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);};
function library(dir,settings) {
  const name=path.basename(dir);
  put(path.join(dir,'library.properties'),`name=${name}\nversion=1.0.0\nauthor=CK\nmaintainer=CK\nsentence=Fixture.\nparagraph=Fixture.\ncategory=Other\nurl=https://example.invalid\narchitectures=*\n${settings}\n`);
}
test('classify the selected MCU only; reject active nonstandard linker inputs',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ck-lib-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const p={'build.mcu':'atmega328p','compiler.libraries.ldflags':''};
  library(dir,'precompiled=full\nldflags=-Tvendor.ld');
  const src=path.join(dir,'src'), target=path.join(src,p['build.mcu']);
  put(path.join(src,'other','libprobe.a'),'not an archive for this board');
  const lib=loadLibrary(dir,'unmanaged');
  assert.equal(libraryLinkage(lib,p).sources,true);
  fs.mkdirSync(path.join(target,'empty'),{recursive:true});
  assert.equal(libraryLinkage(lib,p).directory,null);
  put(path.join(target,'libprobe.a'),'!<arch>\n');
  assert.throws(()=>libraryLinkage(lib,p),e=>e.fallbackSafe&&e.message.includes('-Tvendor.ld'));
  lib.ldflags=''; put(path.join(target,'libprobe.a'),'!<thin>\n');
  assert.throws(()=>libraryLinkage(lib,p),/self-contained/);
  fs.unlinkSync(path.join(target,'libprobe.a'));put(path.join(target,'libprobe.so'),'not static');
  assert.throws(()=>libraryLinkage(lib,p),/standard static/);
});

for (const [env,fqbn,mcu] of [['CK_ARCHIVE_AVR_CONFIG','arduino:avr:uno','atmega328p'],
  ['CK_ARCHIVE_S3_CONFIG','esp32:esp32:esp32s3','esp32s3']]) {
  test(`${fqbn}: source fallback, duplicate archive members, mixed and full binary libraries`,{skip:!process.env[env]},async t=>{
    const cfg=loadConfig(process.env[env]);
    fs.mkdirSync(cfg.paths.workspaceRoot,{recursive:true});
    const workspace=fs.mkdtempSync(path.join(cfg.paths.workspaceRoot,'link-'));
    const sketchDir=path.join(workspace,'source','sketch'), libs=['FullProbe','MixedProbe','PackedProbe','FlatProbe'].map(n=>path.join(workspace,'fixture',n));
    const [full,mixed,packed,flat]=libs, file=(lib,...names)=>path.join(lib,'src',...names);
    library(full,'precompiled=full\nldflags=-lfullprobe'); library(mixed,'precompiled=true');
    library(packed,'dot_a_linkage=true\nldflags=-Tignored.ld'); library(flat,'dot_a_linkage=true');
    put(file(full,'other','libfullprobe.a'),'wrong architecture');
    put(file(full,'FullProbe.h'),'int fullValue();\n');put(file(full,'fallback.cpp'),'int fullValue(){return 10;}\n');
    put(file(mixed,'MixedProbe.h'),'int mixedValue(); int vendor();\n');put(file(mixed,'wrapper.cpp'),'int mixedValue(){return 5;} int vendor(){return 2;}\n');
    put(file(packed,'PackedProbe.h'),'int packedValue();\n');
    put(file(packed,'a','same.cpp'),'int packedValue(){return 3;}\n');
    put(file(packed,'z','same.cpp'),'int packedValue(){return 35;}\n');
    put(path.join(flat,'FlatProbe.h'),'int flatValue();\n');
    put(path.join(flat,'zz.cpp'),'#include "helper.h"\nint flatValue(){return helper();}\n');
    put(path.join(flat,'utility','helper.h'),'int helper();\n');
    put(path.join(flat,'utility','helper.cpp'),'int helper(){return 9;}\n');
    const code=n=>`#include <FullProbe.h>\n#include <MixedProbe.h>\n#include <PackedProbe.h>\n#include <FlatProbe.h>\nvolatile int result;\nvoid setup(){result=fullValue()+mixedValue()+vendor()+packedValue()+flatValue()+${n};}\nvoid loop(){}\n`;
    const controller=new BuildController(cfg); t.after(()=>controller.close());
    async function build(label,n,forceOfficial=false) {
      const source=code(n), sourceSha256=digest(source), requestId=path.basename(workspace)+'-'+label;
      const r=await controller.submit({protocolVersion:1,source,request:{requestId,sourceSha256,fqbn,workspace,sketchDir,sysroot:cfg.paths.sysroot,libraries:libs,forceOfficial}});
      assert.equal(r.success,true,JSON.stringify(r.error));await controller.acknowledge(requestId,{sourceSha256,success:true});
      assert.equal(r.officialFrontendInvoked,forceOfficial);
      return r;
    }
    const run=(argv,options={})=>{
      const r=spawnSync(argv[0],argv.slice(1),{windowsHide:true,encoding:'utf8',
        env:{...process.env,TZ:'UTC',SOURCE_DATE_EPOCH:String(cfg.sourceDateEpoch)},...options});
      assert.equal(r.status,0,r.error?.message??r.stderr);return r;
    };
    const avr=fqbn.startsWith('arduino:'), image=avr?'sketch.ino.hex':'sketch.ino.bin';
    const cliRef=receipt=>{
      const out=path.join(workspace,'official');
      run([cfg.paths.cli,'compile','--clean','--config-file',cfg.paths.cliConfig,'--jobs','8','--fqbn',fqbn,'--build-path',out,...libs.flatMap(l=>['--library',l]),sketchDir]);
      const actual=fs.readFileSync(receipt.artifacts.find(f=>f.name===image).file), expected=fs.readFileSync(path.join(out,image));
      if(avr) assert.ok(actual.equals(expected),'official HEX differs');
      else {
        // The app descriptor contains the SHA of its own (path-dependent) ELF;
        // verify both embedded digests and both image trailers before comparing.
        for(const [bytes,elf] of [[actual,receipt.artifacts.find(f=>f.name==='sketch.ino.elf').file],[expected,path.join(out,'sketch.ino.elf')]]) {
          assert.equal(bytes.readUInt32LE(32),0xabcd5432);
          assert.equal(bytes.subarray(176,208).toString('hex'),digest(fs.readFileSync(elf)));
          assert.equal(bytes.subarray(-32).toString('hex'),digest(bytes.subarray(0,-32)));
          let offset=24, checksum=0xef;
          for(let i=0;i<bytes[1];i++){const size=bytes.readUInt32LE(offset+4);offset+=8;for(const v of bytes.subarray(offset,offset+size))checksum^=v;offset+=size;}
          assert.equal(bytes.at(-33),checksum);
        }
        assert.ok(actual.subarray(0,176).equals(expected.subarray(0,176)) && actual.subarray(208,-33).equals(expected.subarray(208,-33)),'official application payload differs');
      }
    };
    const cold=await build('source',1);cliRef(cold);
    const row=cold.compileDatabase.find(e=>e.file.endsWith('fallback.cpp')), ar=path.join(path.dirname(row.arguments[0]),path.basename(row.arguments[0]).replace(/g\+\+(?:\.exe)?$/,'gcc-ar.exe'));
    function binary(lib,name,body) {
      const scratch=path.join(workspace,'producer'), src=path.join(scratch,'impl.cpp'), obj=src+'.o', dest=file(lib,mcu,name);
      put(src,body);
      const args=row.arguments.map((s,i)=>s===row.file?src:row.arguments[i-1]==='-o'?obj:s);
      run([...args,'-fno-lto'],{cwd:row.directory});fs.mkdirSync(path.dirname(dest),{recursive:true});run([ar,'rcs',dest,obj]);
    }
    binary(full,'libfullprobe.a','int fullValue(){return 87;}\n');
    binary(mixed,'vendor.a','int vendor(){return 29;}\n');
    put(file(full,'fallback.cpp'),'#error full library must omit source on this board\n');
    put(file(mixed,'wrapper.cpp'),'extern int vendor(); int mixedValue(){return vendor();}\n');
    const b=await build('binary',1);cliRef(b);
    const hash=r=>r.artifacts.find(f=>f.name===image).sha256;
    assert.notEqual(hash(cold),hash(b));
    assert.ok(!b.compileDatabase.some(e=>e.file.endsWith('fallback.cpp')));
    const edit=await build('edit',2);assert.equal(edit.counts.CompileGCC,1);
    const repeat=await build('repeat',2);assert.equal(repeat.counts.CompileGCC,0);assert.equal(hash(edit),hash(repeat));
    binary(full,'libfullprobe.a','int fullValue(){return 98;}\n');
    const change=await build('changed-archive',2);assert.notEqual(hash(change),hash(edit));cliRef(change);
    if(avr){const official=await build('official-frontend',2,true); assert.equal(hash(official),hash(change));}
  });
}
