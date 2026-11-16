import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { connectDesktop } from './desktop-client.mjs';
const config = JSON.parse(fs.readFileSync(process.env.CK_V9_ENGINE_CONFIG, 'utf8'));
const client = await connectDesktop();
try {
    const result = await client.build('void setup() {}\nvoid loop() { delay(100); }\n', 'esp32:esp32:esp32s3');
    fs.writeFileSync(path.join(config.paths.evidenceRoot, 'esp32-size-ipc.json'), JSON.stringify(result, null, 2));
    assert(result.success, result.error);
    const data = JSON.parse(result.value);
    assert.match(data.log, /Sketch uses \d+ bytes .*Maximum is \d+ bytes/);
    assert.match(data.log, /Global variables use \d+ bytes .*Maximum is \d+ bytes/);
    assert.match(data.log, /\[DIAG\] Compile evidence: warning_count=\d+/);
    assert.equal(data.diagnostics.resources.evidenceComplete, true);
    console.log(JSON.stringify({ status: 'PASS', target: data.diagnostics.fqbn, resources: data.diagnostics.resources, wallMs: result.wallMs }));
} finally { client.close(); }
