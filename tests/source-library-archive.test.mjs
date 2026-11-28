import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BuildController } from '../src/controller.mjs';
import { loadConfig } from '../src/config.mjs';
import { digest } from '../src/protocol.mjs';

// Set CK_ARCHIVE_AVR_CONFIG to a local V9 engine config with an installed Uno.
// A direct-object link would pull in the unreferenced global constructor.
test('source archive preserves Arduino member selection and invalidates on library edits',
  {skip: !process.env.CK_ARCHIVE_AVR_CONFIG}, async () => {
    const cfg = loadConfig(process.env.CK_ARCHIVE_AVR_CONFIG);
    fs.mkdirSync(cfg.paths.workspaceRoot,{recursive:true});
    const workspace = fs.mkdtempSync(path.join(cfg.paths.workspaceRoot,'archive-'));
    const sketchDir = path.join(workspace,'source','sketch');
    const lib = path.join(workspace,'fixture','ArchiveProbe'), src = path.join(lib,'src');
    fs.mkdirSync(src,{recursive:true});
    fs.writeFileSync(path.join(lib,'library.properties'),
      'name=ArchiveProbe\nversion=1.0.0\nauthor=CK\nmaintainer=CK\nsentence=Regression fixture.\nparagraph=Regression fixture.\ncategory=Other\nurl=https://example.invalid\narchitectures=*\ndot_a_linkage=true\n');
    fs.writeFileSync(path.join(src,'ArchiveProbe.h'),'int reading();\n');
    const setValue = value => fs.writeFileSync(path.join(src,'value.cpp'),`int reading(){return ${value};}\n`);
    setValue(7);
    fs.writeFileSync(path.join(src,'unused.cpp'),
      'extern void must_not_be_linked(); struct Unused { Unused(){must_not_be_linked();} }; Unused unused;\n');
    const c = new BuildController(cfg), fqbn = 'arduino:avr:uno';
    const program = n => `#include <ArchiveProbe.h>\nvoid setup(){Serial.begin(9600);}\nvoid loop(){Serial.println(reading()+${n});}\n`;
    const hashes = [];
    try {
      for (const [label,n,archiveDecision] of [['cold',1,'Rebuild'],['edit',2,'Reuse'],['libedit',2,'Rebuild'],['repeat',2,'Reuse']]) {
        if (label === 'libedit') setValue(25);
        const source = program(n), sourceSha256 = digest(source), requestId = path.basename(workspace)+'-'+label;
        const r = await c.submit({protocolVersion:1,source,request:{
          requestId,sourceSha256,fqbn,workspace,sketchDir,sysroot:cfg.paths.sysroot,libraries:[lib]
        }});
        assert.equal(r.success,true,JSON.stringify(r.error));
        await c.acknowledge(requestId,{sourceSha256,success:true});
        assert.equal(r.officialFrontendInvoked,false);
        const archive = r.taskDecisions.find(x => x.task==='archive' && path.basename(x.output)==='ArchiveProbe.a');
        assert.equal(archive?.decision,archiveDecision);
        if (label==='edit' || label==='repeat') assert.equal(r.counts.CompileGCC,label==='edit'?1:0);
        hashes.push(r.artifacts.find(f=>f.name==='sketch.ino.hex').sha256);
      }
      assert.equal(new Set(hashes.slice(0,3)).size,3);
      assert.equal(hashes[2],hashes[3]);
      const official = path.join(workspace,'reference');
      const cli = spawnSync(cfg.paths.cli,['compile','--config-file',cfg.paths.cliConfig,'--fqbn',fqbn,
        '--build-path',official,'--library',lib,sketchDir],{encoding:'utf8',windowsHide:true,
        env:{...process.env,SOURCE_DATE_EPOCH:String(cfg.sourceDateEpoch),TZ:'UTC'}});
      assert.equal(cli.status,0,cli.stderr);
      assert.equal(digest(fs.readFileSync(path.join(official,'sketch.ino.hex'))),hashes[3]);
    } finally { await c.close(); }
  });
