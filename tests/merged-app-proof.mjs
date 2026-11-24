import assert from 'node:assert/strict';

// In this desktop test the official recipe emits a raw, zero-based merged image.
// The board's flash_args determines where the current sketch belongs.
export function verifyMergedApp(flashArgs, app, merged) {
  const entries = [...flashArgs.matchAll(/(?:^|\s)(0x[\da-f]+)\s+(?:"sketch\.ino\.bin"|sketch\.ino\.bin)(?=\s|$)/gi)];
  assert.equal(entries.length, 1, 'expected exactly one application offset in flash_args');
  const offset = Number(entries[0][1]);
  assert.ok(Number.isSafeInteger(offset) && app.length > 0 && offset + app.length <= merged.length,
    'application extent outside merged image');
  assert.ok(merged.subarray(offset, offset + app.length).equals(app),
    'merged image does not contain the current application');
  return {offset, bytes: app.length};
}
