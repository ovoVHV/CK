import assert from 'node:assert/strict';
import test from 'node:test';
import {verifyMergedApp} from './merged-app-proof.mjs';

test('an individually valid but stale merged image fails after a same-length edit', () => {
  const flash = '0x00 boot.bin\r\n0x10 "sketch.ino.bin"\r\n';
  const app = Buffer.from([0xa1, 0xb2]), merged = Buffer.alloc(64, 0xff);
  app.copy(merged, 16);
  assert.deepEqual(verifyMergedApp(flash, app, merged), {offset: 16, bytes: 2});
  assert.throws(() => verifyMergedApp(flash, Buffer.from([0xa1, 0xb3]), merged), /current application/);
  assert.throws(() => verifyMergedApp(flash, app, merged.subarray(0, 17)), /extent/);
  assert.throws(() => verifyMergedApp(flash + flash, app, merged), /exactly one/);
});
