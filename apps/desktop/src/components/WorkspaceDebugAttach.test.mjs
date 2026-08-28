import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./Workspace.tsx', import.meta.url), 'utf8');

test('retries initial debug ATTACH across ESP32 USB re-enumeration and clears every timer', () => {
    assert.match(source, /INITIAL_DEBUG_ATTACH_TIMEOUT_MS = 10_000/);
    assert.match(source, /INITIAL_DEBUG_ATTACH_RETRY_MS = 500/);
    assert.match(source, /debugAttachRetryTimerRef\.current = setInterval\([\s\S]*retryAttach[\s\S]*INITIAL_DEBUG_ATTACH_RETRY_MS/);
    assert.match(source, /retryAttach\(\);[\s\S]*debugAttachRetryTimerRef\.current = setInterval/);
    assert.match(source, /const clearInitialDebugAttachTimers = useCallback\(\(\) => \{[\s\S]*clearTimeout\(debugAttachTimeoutRef\.current\)[\s\S]*clearInterval\(debugAttachRetryTimerRef\.current\)/);
    assert.match(source, /if \(frame\.kind === 'attached'\) \{[\s\S]*clearInitialDebugAttachTimers\(\)/);
    assert.match(source, /if \(frame\.kind === 'paused'\) \{[\s\S]*clearInitialDebugAttachTimers\(\)/);
    assert.match(source, /const finishBlockDebugSession = useCallback[\s\S]*clearInitialDebugAttachTimers\(\)/);
});
