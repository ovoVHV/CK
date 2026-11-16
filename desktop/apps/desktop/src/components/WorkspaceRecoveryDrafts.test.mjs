import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./Workspace.tsx', import.meta.url), 'utf8');
const contract = readFileSync(new URL('../../../../docs/recovery-drafts-v1.md', import.meta.url), 'utf8');

test('semantic Blockly edits schedule a bounded rolling recovery draft', () => {
    assert.match(source, /scheduleRecoveryDraftRef\.current\(\)/);
    assert.match(source, /setTimeout\(\(\) => \{/);
    assert.match(source, /12_000/);
    assert.match(source, /saveRecoveryDraft\(\{/);
    assert.match(source, /diskBaseline:/);
});

test('startup only offers a newer changed draft for the same disk baseline', () => {
    assert.match(source, /getProjectRecoveryBaseline\(currentPath\)/);
    assert.match(source, /computeRecoveryDraftFullStateHash\(state\)/);
    assert.match(source, /selectLatestRecoveryDraftForSession/);
    assert.match(source, /loadRecoveryDraft\(currentPath, decision\.candidate\.id\)/);
    assert.match(source, /recoveryProjectSessionIsCurrent\(inspectionSession\)/);
    assert.match(source, /projectLoadedKeyRef\.current = null/);
    assert.match(source, /currentState: state/);
    assert.match(source, /currentState=\{recoveryCandidate\.currentState\}/);
});

test('candidate discovery and actions stay bound to the completed project load session', () => {
    assert.match(source, /loadKey: `\$\{currentPath\}::\$\{reloadTrigger\}`/);
    assert.match(source, /const sessionIsCurrent = \(\) => !cancelled/);
    assert.match(source, /if \(!sessionIsCurrent\(\)\) return/);
    assert.match(source, /session: inspectionSession/);
    assert.match(source, /deleteRecoveryDraft\(candidate\.metadata\.projectPath, candidate\.metadata\.id\)/);
    assert.match(source, /工程会话已经变化，已停止恢复旧稿/);
});

test('ordinary save and save-as stop before backend calls during an A to B load window', () => {
    assert.match(source, /requestedLoadKey: `\$\{projectPath\}::\$\{reloadTriggerRef\.current\}`/);
    const beginLoadAt = source.indexOf('const beginProjectLoad = useCallback');
    const invalidateAt = source.indexOf('projectLoadedKeyRef.current = null', beginLoadAt);
    const setPathAt = source.indexOf('setCurrentPath(nextProjectPath)', beginLoadAt);
    assert.ok(beginLoadAt >= 0 && invalidateAt > beginLoadAt && setPathAt > invalidateAt);

    const ordinaryAt = source.indexOf('const performFormalSave = useCallback');
    const ordinaryGuardAt = source.indexOf('if (projectLoadingRef.current || !workspaceRef.current || !formalSaveSession)', ordinaryAt);
    const ordinaryInvokeAt = source.indexOf("await invoke('save_project", ordinaryAt);
    assert.ok(ordinaryGuardAt > ordinaryAt && ordinaryInvokeAt > ordinaryGuardAt);

    const saveAsAt = source.indexOf('const handleSaveAs = async');
    const saveAsGuardAt = source.indexOf('if (projectLoadingRef.current || !workspaceRef.current || !saveAsSession)', saveAsAt);
    const pickerAt = source.indexOf('const selectedPath = await save({', saveAsAt);
    const sessionRecheckAt = source.indexOf('recoveryProjectSessionIsCurrent(saveAsSession)', pickerAt);
    const saveAsInvokeAt = source.indexOf("await invoke('save_project_as'", saveAsAt);
    assert.ok(saveAsGuardAt > saveAsAt && pickerAt > saveAsGuardAt);
    assert.ok(sessionRecheckAt > pickerAt && saveAsInvokeAt > sessionRecheckAt);
});

test('save-as keeps the current project and recovery state when edits arrive during the write', () => {
    const saveAsAt = source.indexOf('const handleSaveAs = async');
    const saveAsEnd = source.indexOf('const retryProtectedProjectLoad', saveAsAt);
    const saveAsSource = source.slice(saveAsAt, saveAsEnd);
    const busyGuardAt = saveAsSource.indexOf('if (saveAsBusyRef.current)');
    const busySetAt = saveAsSource.indexOf('saveAsBusyRef.current = true');
    const pickerAt = saveAsSource.indexOf('const selectedPath = await save({');
    const capturedAt = saveAsSource.indexOf('const savedCopyFingerprint = createProjectFingerprint');
    const invokeAt = saveAsSource.indexOf("await invoke('save_project_as'");
    const latestAt = saveAsSource.indexOf('const latestFingerprint = createProjectFingerprint');
    const changedAt = saveAsSource.indexOf('if (latestFingerprint !== savedCopyFingerprint)');
    const cleanupAt = saveAsSource.indexOf('cancelRecoveryDraftTimer()', changedAt);
    const switchAt = saveAsSource.indexOf('beginProjectLoad(selectedPath)', cleanupAt);
    const asyncCleanupAt = saveAsSource.indexOf('await discardProjectRecoveryDrafts(selectedPath)', switchAt);
    assert.ok(busyGuardAt >= 0 && busySetAt > busyGuardAt && pickerAt > busySetAt);
    assert.ok(capturedAt > pickerAt && invokeAt > capturedAt && latestAt > invokeAt);
    assert.ok(changedAt > latestAt && cleanupAt > changedAt);
    assert.match(saveAsSource.slice(changedAt, cleanupAt), /副本已写入但期间有新修改，当前工程未切换，请再次另存[\s\S]*return;/);
    assert.ok(switchAt > cleanupAt && asyncCleanupAt > switchAt, 'no await may reopen an edit race before switching');
    assert.match(saveAsSource, /finally \{\s*saveAsBusyRef\.current = false/);
});

test('automatic prompts are latest-only and suppressed for one loaded project baseline', () => {
    assert.match(source, /recoveryOfferSuppressedSessionRef/);
    assert.match(source, /older rolling snapshots into an automatic modal queue/);
    assert.match(source, /recoveryOfferSuppressedSessionRef\.current = decision\.sessionKey/);
    const loadAt = source.indexOf('const loadKey = `${currentPath}::${reloadTrigger}`');
    const resetAt = source.indexOf('recoveryOfferSuppressedSessionRef.current = null', loadAt);
    assert.ok(loadAt >= 0 && resetAt > loadAt, 'an explicit project load/reopen must reset suppression');
});

test('restoring current state is guarded by unknown blocks and a formal checkpoint', () => {
    const restoreAt = source.indexOf('const handleRestoreRecoveryCurrent');
    const checkpointAt = source.indexOf("captureWorkspaceCheckpoint('before_restore')", restoreAt);
    const sessionRecheckAt = source.indexOf('recoveryProjectSessionIsCurrent(candidate.session)', checkpointAt);
    const pauseAt = source.indexOf('recoveryRestoreInProgressRef.current = true', sessionRecheckAt);
    const clearAt = source.indexOf('workspace.clear()', restoreAt);
    const resumeAt = source.indexOf('recoveryRestoreResumeTimerRef.current = window.setTimeout(() => {', clearAt);
    const scheduleAt = source.indexOf('scheduleRecoveryDraftRef.current()', resumeAt);
    assert.ok(restoreAt >= 0 && checkpointAt > restoreAt && sessionRecheckAt > checkpointAt && pauseAt > sessionRecheckAt && clearAt > pauseAt);
    assert.ok(resumeAt > clearAt && scheduleAt > resumeAt, 'restore must resume with one deferred debounce');
    assert.match(source.slice(restoreAt, checkpointAt), /inspection\.canDeserializeIntoBlockly/);
    assert.match(source.slice(restoreAt, checkpointAt), /恢复稿也仍完整保留/);
    const restoreEnd = source.indexOf('const handleRestoreRecoveryAsNew', restoreAt);
    assert.doesNotMatch(
        source.slice(restoreAt, restoreEnd),
        /deleteRecoveryDraft\(/,
        'restoring into the current workspace retains the selected draft until formal save',
    );
});

test('rolling writes and formal-save cleanup are scoped to one project session', () => {
    assert.match(source, /recoveryDraftWritesRef = useRef<Map<string, Promise<void>>>/);
    assert.match(source, /cached\?\.sessionKey === sessionKey/);
    assert.match(source, /if \(!recoveryProjectSessionIsCurrent\(session\)\) return/);
    assert.doesNotMatch(source, /recoveryDraftWriteRef/);
    const saveAt = source.indexOf('const performFormalSave = useCallback');
    const gateAt = source.indexOf('recoveryFormalSaveGatesRef.current.set(ownerToken, ownerSessionKeys)', saveAt);
    const waitAt = source.indexOf('await waitForRecoveryDraftWrite(formalSaveSession)', saveAt);
    const discardAt = source.indexOf('await discardProjectRecoveryDrafts(formalSaveProjectPath)', saveAt);
    assert.ok(saveAt >= 0 && gateAt > saveAt && waitAt > gateAt && discardAt > waitAt);
    assert.match(source.slice(saveAt, discardAt), /cancelRecoveryDraftTimer\(\)/);
    assert.match(source, /Formal save succeeded but baseline refresh failed/);
});

test('formal saves use one deferred single-flight owner and rerun the latest implementation', () => {
    assert.match(source, /createDeferredSingleFlightQueue\(\{/);
    assert.match(source, /runLatest: ownerToken => performFormalSaveRef\.current\(ownerToken\)/);
    assert.match(source, /performFormalSaveRef\.current = performFormalSave/);
    assert.match(source, /formalSaveQueueRef\.current!\.request\(\)/);
    assert.doesNotMatch(source, /const handleSave = useCallback\(async/);
});

test('one owner token holds the recovery gate across every deferred save pass', () => {
    const performAt = source.indexOf('const performFormalSave = useCallback');
    const finishAt = source.indexOf('const finishFormalSaveOwner = useCallback', performAt);
    assert.ok(performAt >= 0 && finishAt > performAt);
    assert.match(source.slice(performAt, finishAt), /recoveryFormalSaveGatesRef\.current\.get\(ownerToken\)/);
    assert.doesNotMatch(source.slice(performAt, finishAt), /recoveryFormalSaveGatesRef\.current\.delete\(ownerToken\)/);
    assert.match(source.slice(finishAt), /recoveryFormalSaveGatesRef\.current\.delete\(ownerToken\)/);
    assert.match(source, /recoveryFormalSaveSessionIsGated\(sessionKey\)/);
    assert.match(source, /recoveryDraftRescheduleAfterSaveRef\.current\.add\(sessionKey\)/);
});

test('restore resume timer is cancellable and cannot schedule another project', () => {
    assert.match(source, /recoveryRestoreResumeTimerRef = useRef/);
    assert.match(source, /window\.clearTimeout\(recoveryRestoreResumeTimerRef\.current\)/);
    assert.match(source, /if \(recoveryProjectSessionIsCurrent\(candidate\.session\)\) \{\s*scheduleRecoveryDraftRef\.current\(\)/);
});

test('board and options-only edits schedule recovery only after initial loading', () => {
    assert.match(source, /const boardStateChanged = createProjectFingerprint/);
    assert.match(source, /\(boardStateChanged \|\| targetMetadataChanged\)\s*&& dirtyTrackingReadyRef\.current\s*&& !recoveryRestoreInProgressRef\.current/);
    assert.match(source, /Board\/options-only edits use the same bounded 12s debounce/);
    const loadAt = source.indexOf('const loadKey = `${currentPath}::${reloadTrigger}`');
    const loadingGuardAt = source.indexOf('dirtyTrackingReadyRef.current = false', loadAt);
    const loadedOptionsAt = source.indexOf('setBoardOptions(loadedBoardOptions)', loadAt);
    assert.ok(loadingGuardAt > loadAt && loadedOptionsAt > loadingGuardAt);
});

test('a successful formal save discards drafts and refreshes the disk baseline', () => {
    const drainAt = source.indexOf('await waitForRecoveryDraftWrite(formalSaveSession)');
    const discardAt = source.indexOf('await discardProjectRecoveryDrafts(formalSaveProjectPath)', drainAt);
    assert.ok(drainAt >= 0 && discardAt > drainAt);
    assert.match(source, /const baseline = await getProjectRecoveryBaseline\(formalSaveProjectPath\)/);
    assert.match(source, /sessionKey: recoveryProjectSessionKey\(formalSaveSession\),\s*baseline,/);
    assert.match(source, /Formal save succeeded but baseline refresh failed/);
    assert.match(source, /setIsProjectDirty\(false\);\s*scheduleProjectDirtyComparison\(workspaceRef\.current, 0\)/);
    assert.match(source, /恢复稿已保存为新工程，原工程未修改/);
});

test('the written recovery contract records retention, reopen, and non-queue boundaries', () => {
    assert.match(contract, /最新的一份有效恢复稿/);
    assert.match(contract, /旧稿只是有界安全冗余，不是自动恢复队列/);
    assert.match(contract, /同一磁盘基线下更旧的稿件均不再自动提示/);
    assert.match(contract, /所选稿继续保存在磁盘，直到该工程完成一次正式保存/);
    assert.match(contract, /关闭并重新打开原工程会建立新会话/);
});
