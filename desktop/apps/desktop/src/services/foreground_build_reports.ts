import type { ForegroundBuildEvidence } from '../components/CompileProgressOverlay';
import { diagnoseCompile, saveCompileEnvironmentSnapshot, compareCompileEnvironment, type CompileDiagnosticsPayload, type CompileDoctorReport, type CompileEnvironmentSnapshot, type CurrentCompileEnvironment } from './compile_doctor';
import { analyzeCompileIssues, type CompileIssueCard } from './compile_issue_cards';
import { bindProjectBuildEvidence } from './project_acceptance_report';
import { createCompileResourceReport, createCompileResourceSnapshot, loadCompileResourceSnapshot, isSameCompileResourceTarget, parseLinkerMapResourceSummary, parseCompileResourceUsage, parseResolvedCompileFqbn, saveCompileResourceSnapshot, type CompileResourceTargetIdentity, type CompileResourceReport, type CompileResourceSnapshot, type LinkerMapResourceSummary } from './compile_resources';

interface ReportContext {
    buildEvidence: ForegroundBuildEvidence;
    compileEnvironment: CurrentCompileEnvironment;
    compileEnvironmentSnapshot: CompileEnvironmentSnapshot | null;
    resourceTargetIdentity: CompileResourceTargetIdentity;
    currentTarget: () => CompileResourceTargetIdentity;
    runEvidenceIsCurrent: () => boolean;
    readLog: () => string;
    appendCompileLog: (line: string) => void;
    setCompileDoctorReport: (report: CompileDoctorReport) => void;
    setCompileEnvironmentSnapshot: (snapshot: CompileEnvironmentSnapshot) => void;
    setCompileResourceReport: (report: CompileResourceReport | null) => void;
    publishSnapshot: (snapshot: CompileResourceSnapshot) => void;
    reconcileCompileIssueBlocks: (issues: CompileIssueCard[]) => CompileIssueCard[];
    setCompileIssues: (issues: CompileIssueCard[]) => void;
}

export function createBuildReports({buildEvidence, compileEnvironment, compileEnvironmentSnapshot,
    resourceTargetIdentity, currentTarget, runEvidenceIsCurrent, readLog, appendCompileLog,
    setCompileDoctorReport, setCompileEnvironmentSnapshot, setCompileResourceReport, publishSnapshot,
    reconcileCompileIssueBlocks, setCompileIssues}: ReportContext) {
    let staleEvidenceNoticeWritten = false;
    const noteStaleEvidence = () => {
        if (staleEvidenceNoticeWritten) return;
        staleEvidenceNoticeWritten = true;
        let isEn = false;
        try {
            const lang = typeof document !== 'undefined' ? document.documentElement?.lang : '';
            const stored = typeof window !== 'undefined' ? window.localStorage?.getItem('ck.i18n.uiLocale') : '';
            isEn = /^en(?:-|$)/i.test(String(lang || stored || ''));
        } catch { /* ignore */ }
        appendCompileLog(isEn
            ? '[INFO] Project was edited during compilation; this log and artifact are kept, but will not overwrite current health, resource, or error location evidence.\n'
            : '[信息] 编译期间工程已编辑；本次日志与产物保留，但不会覆盖当前工程的体检、资源或错误定位证据。\n');
    };

    const publishCompileDoctor = (
        success: boolean,
        diagnostics: CompileDiagnosticsPayload | null,
        durationMs: number,
        extraLog = '',
    ): CompileDoctorReport | null => {
        if (!runEvidenceIsCurrent()) {
            noteStaleEvidence();
            return null;
        }
        const resolvedFqbn = String(diagnostics?.fqbn || '').trim()
            || parseResolvedCompileFqbn(`${readLog()}\n${extraLog}`);
        const resolvedEnvironment = resolvedFqbn
            ? { ...compileEnvironment, fqbn: resolvedFqbn }
            : compileEnvironment;
        const diagnosed = diagnoseCompile({
            success,
            log: `${readLog()}\n${extraLog}`,
            durationMs,
            diagnostics,
            currentEnvironment: resolvedEnvironment,
            previousSnapshot: compileEnvironmentSnapshot,
        });
        const report = bindProjectBuildEvidence(diagnosed, buildEvidence, diagnosed.recordedAt);
        setCompileDoctorReport(report);
        if (success) {
            const nextSnapshot = saveCompileEnvironmentSnapshot(
                resourceTargetIdentity.projectPath,
                resolvedEnvironment,
                diagnostics,
            );
            if (nextSnapshot) setCompileEnvironmentSnapshot(nextSnapshot);
        }
        return report;
    };

    const publishCompileResources = (
        extraLog = '',
        includeUploaderMemory = false,
        resolvedFqbnOverride = '',
        linkerMapSummaryOverride: LinkerMapResourceSummary | null = null,
    ) => {
        if (!runEvidenceIsCurrent()) {
            noteStaleEvidence();
            return;
        }
        const combinedLog = `${readLog()}\n${extraLog}`;
        const capturedAt = new Date().toISOString();
        const usage = parseCompileResourceUsage(
            combinedLog,
            { includeUploaderMemory, uploaderMeasuredAt: capturedAt },
        );
        if (!usage) {
            setCompileResourceReport(null);
            return;
        }

        const resolvedFqbn = String(resolvedFqbnOverride || '').trim()
            || parseResolvedCompileFqbn(combinedLog)
            || compileEnvironment.fqbn;
        const linkerMapSummary = linkerMapSummaryOverride
            || parseLinkerMapResourceSummary(combinedLog, resolvedFqbn);

        const currentTargetIdentity = currentTarget();
        if (!isSameCompileResourceTarget(resourceTargetIdentity, currentTargetIdentity)) {
            noteStaleEvidence();
            return;
        }

        const persistedSnapshot = loadCompileResourceSnapshot(
            resourceTargetIdentity.projectPath,
            resourceTargetIdentity.requestedFqbn,
        );
        // The live ref may already belong to another project after a
        // navigation. Only the captured project/config storage key is a
        // safe comparison baseline for this async result.
        const previousSnapshot = persistedSnapshot?.fqbn === resolvedFqbn
            ? persistedSnapshot
            : null;
        const report = bindProjectBuildEvidence(createCompileResourceReport(
            usage,
            previousSnapshot,
            capturedAt,
            resolvedFqbn,
            linkerMapSummary,
        ), buildEvidence, capturedAt);
        const nextSnapshot = createCompileResourceSnapshot(
            resolvedFqbn,
            { ...usage, uploaderMemory: report.uploaderMemory },
            capturedAt,
            resourceTargetIdentity.requestedFqbn,
            linkerMapSummary,
        );
        saveCompileResourceSnapshot(resourceTargetIdentity.projectPath, nextSnapshot);

        publishSnapshot(nextSnapshot);
        setCompileResourceReport(report);
    };

    const publishCompileIssues = (
        operation: 'compile' | 'upload',
        extraLog = '',
        environmentChanges = compareCompileEnvironment(
            compileEnvironmentSnapshot,
            compileEnvironment,
        ),
    ) => {
        if (!runEvidenceIsCurrent()) {
            noteStaleEvidence();
            return [];
        }
        const analyzedIssues = analyzeCompileIssues({
            log: `${readLog()}\n${extraLog}`,
            operation,
            fqbn: compileEnvironment.fqbn,
            activePort: buildEvidence.port,
            environmentChanges,
        });
        const issues = reconcileCompileIssueBlocks(analyzedIssues);
        setCompileIssues(issues);
        return issues;
    };
    return {publishCompileDoctor, publishCompileResources, publishCompileIssues};
}
