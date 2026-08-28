import { useEffect, useState } from 'react';
import {
    CheckCircle2,
    CircleAlert,
    CircleHelp,
    FileJson2,
    FileText,
    FolderInput,
    Loader2,
    PackageCheck,
    RefreshCw,
    ShieldCheck,
    X,
    XCircle,
} from 'lucide-react';
import { open as openFile, save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import {
    projectAcceptanceReportToHtml,
    type ProjectAcceptanceReport,
    type ProjectAcceptanceNotes,
    type ProjectHealthState,
} from '../services/project_acceptance_report';
import { formatResourceBytes } from '../services/compile_resources';
import {
    exportProjectSubmission,
    inspectProjectSubmission,
    type ProjectSubmissionInspection,
    type ProjectSubmissionSourceScope,
} from '../services/project_submission';

export type ProjectAcceptanceReportProvider = (notes?: ProjectAcceptanceNotes) => (
    ProjectAcceptanceReport | Promise<ProjectAcceptanceReport>
);

export interface ProjectSubmissionMaterial {
    workspaceJson: string;
    generatedSource: string;
    ckLock?: string | null;
}

export type ProjectSubmissionMaterialProvider = () => (
    ProjectSubmissionMaterial | Promise<ProjectSubmissionMaterial>
);

interface ProjectAcceptanceReportModalProps {
    isOpen: boolean;
    onClose: () => void;
    reportProvider: ProjectAcceptanceReportProvider;
    submissionMaterialProvider: ProjectSubmissionMaterialProvider;
    suggestedBaseName?: string;
    onExported?: (path: string, format: 'json' | 'html' | 'ckpkg') => void;
}

const stateStyle: Record<ProjectHealthState, {
    Icon: typeof CheckCircle2;
    label: string;
    className: string;
}> = {
    pass: { Icon: CheckCircle2, label: '通过', className: 'text-emerald-700 bg-emerald-50 border-emerald-200 dark:text-emerald-300 dark:bg-emerald-950/45 dark:border-emerald-900' },
    warning: { Icon: CircleAlert, label: '警告', className: 'text-amber-700 bg-amber-50 border-amber-200 dark:text-amber-300 dark:bg-amber-950/45 dark:border-amber-900' },
    error: { Icon: XCircle, label: '问题', className: 'text-red-700 bg-red-50 border-red-200 dark:text-red-300 dark:bg-red-950/45 dark:border-red-900' },
    info: { Icon: CircleHelp, label: '提示', className: 'text-slate-600 bg-slate-100 border-slate-200 dark:text-slate-300 dark:bg-slate-800 dark:border-slate-700' },
};

const safeBaseName = (value: string): string => {
    const normalized = value.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/\s+/g, '-');
    return normalized || 'CK工程';
};

const stateLabel = (state: ProjectAcceptanceReport['build']['state']): string => {
    if (state === 'passed') return '编译通过';
    if (state === 'failed') return '编译失败';
    if (state === 'unverified-target') return '已有结果，但目标不匹配';
    return '尚无编译证据';
};

const submissionScopeLabel: Record<ProjectSubmissionSourceScope, string> = {
    no_source: '不含源码',
    editable_project: '含可编辑积木工程',
    generated_source: '含生成源码',
    editable_and_generated: '含积木工程与生成源码',
};

export function ProjectAcceptanceReportModal({
    isOpen,
    onClose,
    reportProvider,
    submissionMaterialProvider,
    suggestedBaseName = 'CK工程',
    onExported,
}: ProjectAcceptanceReportModalProps) {
    const [report, setReport] = useState<ProjectAcceptanceReport | null>(null);
    const [busy, setBusy] = useState<'load' | 'json' | 'html' | 'ckpkg' | 'import' | null>(null);
    const [error, setError] = useState('');
    const [circuitDescription, setCircuitDescription] = useState('');
    const [testRecords, setTestRecords] = useState('');
    const [sourceScope, setSourceScope] = useState<ProjectSubmissionSourceScope>('no_source');
    const [sourceDisclosureAcknowledged, setSourceDisclosureAcknowledged] = useState(false);
    const [includeLock, setIncludeLock] = useState(false);
    const [includeBuildEvidence, setIncludeBuildEvidence] = useState(true);
    const [importedSubmission, setImportedSubmission] = useState<ProjectSubmissionInspection | null>(null);
    const [exportedPackageIdentity, setExportedPackageIdentity] = useState<{
        fileName: string;
        sha256: string;
    } | null>(null);

    const load = async () => {
        setBusy('load');
        setError('');
        try {
            const nextReport = await reportProvider({ circuitDescription, testRecords });
            setReport(nextReport);
            if (!nextReport.dependencies.lockAvailable) setIncludeLock(false);
        } catch (cause) {
            setReport(null);
            setError(`无法生成验收报告：${String(cause)}`);
        } finally {
            setBusy(null);
        }
    };

    useEffect(() => {
        if (!isOpen) return;
        // A previously inspected package must never look like the file selected
        // in a later modal session.
        setImportedSubmission(null);
        setExportedPackageIdentity(null);
        void load();
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && busy === null) onClose();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
        // reportProvider is intentionally captured only when the modal opens;
        // users can explicitly refresh to create one coherent evidence instant.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen]);

    if (!isOpen) return null;

    const exportReport = async (format: 'json' | 'html') => {
        if (!report || busy) return;
        setBusy(format);
        setError('');
        try {
            const extension = format === 'json' ? 'json' : 'html';
            const freshReport = await reportProvider({ circuitDescription, testRecords });
            setReport(freshReport);
            const path = await save({
                title: format === 'json' ? '导出结构化项目验收报告' : '导出可打印项目验收报告',
                defaultPath: `${safeBaseName(suggestedBaseName)}-项目验收报告.${extension}`,
                filters: [{
                    name: format === 'json' ? 'CK 项目验收 JSON' : '可打印 HTML',
                    extensions: [extension],
                }],
            });
            if (!path) return;
            const content = format === 'json'
                ? `${JSON.stringify(freshReport, null, 2)}\n`
                : projectAcceptanceReportToHtml(freshReport);
            await writeTextFile(path, content);
            onExported?.(path, format);
        } catch (cause) {
            setError(`导出失败：${String(cause)}`);
        } finally {
            setBusy(null);
        }
    };

    const exportSubmission = async () => {
        if (!report || busy) return;
        setBusy('ckpkg');
        setError('');
        try {
            if (sourceScope !== 'no_source' && !sourceDisclosureAcknowledged) {
                throw new Error('包含可编辑工程或生成源码前，请确认其中可能含有 Wi-Fi、令牌或其他敏感信息');
            }
            const [freshReport, material] = await Promise.all([
                reportProvider({ circuitDescription, testRecords }),
                submissionMaterialProvider(),
            ]);
            setReport(freshReport);
            if (includeLock && !material.ckLock) {
                throw new Error('当前工程没有与本次代码、完整 FQBN 和 Core 匹配的 ck.lock');
            }
            const path = await save({
                title: '导出 project.ckpkg 工程提交包',
                defaultPath: `${safeBaseName(suggestedBaseName)}.ckpkg`,
                filters: [{ name: 'CK 工程提交包', extensions: ['ckpkg'] }],
            });
            if (!path) return;
            const includesWorkspace = sourceScope === 'editable_project'
                || sourceScope === 'editable_and_generated';
            const includesGenerated = sourceScope === 'generated_source'
                || sourceScope === 'editable_and_generated';
            const result = await exportProjectSubmission({
                outputPath: path,
                sourceScope,
                sourceDisclosureAcknowledged,
                report: freshReport,
                ...(includesWorkspace ? { workspaceJson: material.workspaceJson } : {}),
                ...(includesGenerated ? { generatedSource: material.generatedSource } : {}),
                ...(includeLock && material.ckLock ? { ckLock: material.ckLock } : {}),
                includeBuildEvidence,
            });
            setExportedPackageIdentity({
                fileName: result.packageFileName,
                sha256: result.packageSha256,
            });
            onExported?.(result.outputPath, 'ckpkg');
        } catch (cause) {
            setError(`提交包导出失败：${String(cause)}`);
        } finally {
            setBusy(null);
        }
    };

    const importSubmission = async () => {
        if (busy) return;
        setBusy('import');
        setError('');
        setImportedSubmission(null);
        try {
            const selected = await openFile({
                title: '只读检查 project.ckpkg 工程提交包',
                multiple: false,
                directory: false,
                filters: [{ name: 'CK 工程提交包', extensions: ['ckpkg'] }],
            });
            const path = Array.isArray(selected) ? selected[0] : selected;
            if (!path) return;
            setImportedSubmission(await inspectProjectSubmission(path));
        } catch (cause) {
            setImportedSubmission(null);
            setError(`提交包检查失败：${String(cause)}`);
        } finally {
            setBusy(null);
        }
    };

    return (
        <div className="fixed inset-0 z-[620] flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-[1px]" role="dialog" aria-modal="true" aria-label="项目验收报告">
            <div className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-slate-50 shadow-2xl dark:border-slate-700 dark:bg-slate-950">
                <header className="flex shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-5 py-3 dark:border-slate-700 dark:bg-slate-900">
                    <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-teal-100 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300"><ShieldCheck size={19} /></span>
                    <div className="min-w-0 flex-1">
                        <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100">工程状态与项目验收报告</h2>
                        <p className="mt-0.5 text-[10px] text-slate-500 dark:text-slate-400">明确检查项，不计算综合分数；无脚本 HTML 可通过系统打印保存 PDF。</p>
                    </div>
                    <button type="button" onClick={() => void load()} disabled={Boolean(busy)} className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:text-slate-300 dark:hover:bg-slate-800"><RefreshCw size={14} />刷新</button>
                    <button type="button" onClick={onClose} disabled={Boolean(busy)} className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-50 dark:hover:bg-slate-800 dark:hover:text-slate-100" aria-label="关闭项目验收报告"><X size={17} /></button>
                </header>

                <main className="min-h-0 flex-1 overflow-y-auto p-4">
                    {busy === 'load' && !report && (
                        <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-slate-500"><Loader2 size={18} className="animate-spin" />正在汇总本地工程证据…</div>
                    )}
                    {error && <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">{error}</div>}
                    <section className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900/75" aria-label="独立只读打开项目提交包">
                        <div className="min-w-0">
                            <div className="text-xs font-bold text-slate-800 dark:text-slate-100">检查别人提交的 project.ckpkg</div>
                            <div className="mt-0.5 text-[9px] text-slate-500 dark:text-slate-400">不依赖当前工程报告；只在内存中校验，载荷不会解压到磁盘。</div>
                        </div>
                        <button type="button" onClick={() => void importSubmission()} disabled={Boolean(busy)} className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 text-[10px] font-semibold text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"><FolderInput size={13} />{busy === 'import' ? '检查中' : '只读打开提交包'}</button>
                    </section>
                    {exportedPackageIdentity && (
                        <section className="mb-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-[10px] leading-4 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/35 dark:text-emerald-200" aria-label="刚导出的项目提交包身份">
                            <strong>工程提交包已生成</strong><br />文件：{exportedPackageIdentity.fileName}<br />包 SHA-256：<code className="break-all">{exportedPackageIdentity.sha256}</code>
                        </section>
                    )}
                    {importedSubmission && (
                        <section className="mb-4 rounded-xl border border-teal-200 bg-teal-50/80 p-3 dark:border-teal-900 dark:bg-teal-950/30" aria-label="只读项目提交包摘要">
                            <div className="flex flex-wrap items-start justify-between gap-2">
                                <div>
                                    <div className="flex items-center gap-1.5 text-xs font-bold text-teal-800 dark:text-teal-200"><PackageCheck size={15} />已完成本地只读完整性检查</div>
                                    <div className="mt-1 text-[9px] text-teal-700/80 dark:text-teal-300/80">未解压到磁盘、执行脚本、联网、烧录或写入当前工程。</div>
                                </div>
                                <button type="button" onClick={() => setImportedSubmission(null)} className="rounded px-2 py-1 text-[10px] font-semibold text-teal-700 hover:bg-teal-100 dark:text-teal-300 dark:hover:bg-teal-900/60">关闭摘要</button>
                            </div>
                            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                                {[
                                    ['工程', `${importedSubmission.summary.projectName} · ${importedSubmission.summary.blockCount} 个积木`],
                                    ['板卡 / Core', `${importedSubmission.summary.boardName} · ${importedSubmission.summary.coreId}@${importedSubmission.summary.coreVersion || '未识别'}`],
                                    ['编译 / 资源', `${stateLabel(importedSubmission.summary.compileState)} · Flash ${formatResourceBytes(importedSubmission.summary.flashUsedBytes ?? Number.NaN)} / ${formatResourceBytes(importedSubmission.summary.flashTotalBytes ?? Number.NaN)} · RAM ${formatResourceBytes(importedSubmission.summary.ramUsedBytes ?? Number.NaN)} / ${formatResourceBytes(importedSubmission.summary.ramTotalBytes ?? Number.NaN)}`],
                                    ['依赖 / 真机 / 检查点', `${importedSubmission.summary.dependencyCount} 项（${importedSubmission.summary.dependenciesAllVersioned ? '版本齐全' : '存在未锁版本'}）· ${importedSubmission.summary.hardwareChip || importedSubmission.summary.hardwareState} · Flash ${formatResourceBytes(importedSubmission.summary.hardwareFlashBytes ?? Number.NaN)} · PSRAM ${formatResourceBytes(importedSubmission.summary.hardwarePsramBytes ?? Number.NaN)} · ${importedSubmission.summary.checkpointCount} 个`],
                                ].map(([label, value]) => (
                                    <div key={label} className="min-w-0 rounded-lg border border-teal-200/70 bg-white/80 p-2 dark:border-teal-900 dark:bg-slate-950/60">
                                        <div className="text-[8px] font-bold uppercase tracking-wide text-teal-600 dark:text-teal-400">{label}</div>
                                        <div className="mt-1 break-words text-[10px] font-semibold leading-4 text-slate-700 dark:text-slate-200">{value}</div>
                                    </div>
                                ))}
                            </div>
                            <div className="mt-2 break-all rounded-lg bg-white/70 px-2 py-1.5 text-[9px] leading-4 text-slate-600 dark:bg-slate-950/60 dark:text-slate-300">
                                文件：{importedSubmission.packageFileName}<br />包 SHA-256：<code>{importedSubmission.packageSha256}</code><br />
                                提交范围：{submissionScopeLabel[importedSubmission.sourceScope]} · 实际附加 ck.lock：{importedSubmission.hasDependencyLock ? '是' : '否'} · 实际附加构建证据：{importedSubmission.hasBuildEvidence ? '是' : '否'}<br />
                                完整 FQBN：{importedSubmission.summary.fqbn}<br />工程健康：{importedSubmission.summary.healthSummary}<br /><strong>{importedSubmission.authenticityMessage}</strong>
                            </div>
                        </section>
                    )}
                    {report && (
                        <div className="grid gap-4">
                            <section className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4" aria-label="项目验收摘要">
                                {[
                                    ['工程', `${report.project.name} · ${report.project.blockCount} 个积木`],
                                    ['板卡 / Core', `${report.target.boardName} · ${report.target.coreId}@${report.target.coreVersion || '未识别'}`],
                                    ['编译', stateLabel(report.build.state)],
                                    ['真机', report.hardware.state === 'verified' ? `${report.hardware.chip || '芯片'} 已验证` : `真机 ${report.hardware.state}`],
                                ].map(([label, value]) => (
                                    <div key={label} className="min-w-0 rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900/75">
                                        <div className="text-[9px] font-bold uppercase tracking-wide text-slate-400">{label}</div>
                                        <div className="mt-1 break-words text-xs font-bold leading-5 text-slate-800 dark:text-slate-100">{value}</div>
                                    </div>
                                ))}
                            </section>

                            <section className="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900/75" aria-label="工程健康检查项">
                                <div className="flex items-center justify-between gap-2">
                                    <h3 className="text-xs font-bold text-slate-800 dark:text-slate-100">工程健康检查</h3>
                                    <span className="text-[10px] text-slate-500 dark:text-slate-400">{report.health.summary}</span>
                                </div>
                                <div className="mt-2 grid gap-2 md:grid-cols-2">
                                    {report.health.checks.map(check => {
                                        const theme = stateStyle[check.state];
                                        return (
                                            <div key={check.id} className={`flex min-w-0 items-start gap-2 rounded-lg border border-slate-100 bg-slate-50/80 p-2.5 dark:border-slate-800 dark:bg-slate-950/50 ${check.stages ? 'md:col-span-2' : ''}`}>
                                                <span className={`flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[9px] font-bold ${theme.className}`}><theme.Icon size={11} />{theme.label}</span>
                                                <div className="min-w-0 flex-1">
                                                    <div className="text-[11px] font-bold text-slate-700 dark:text-slate-200">{check.title}</div>
                                                    <div className="mt-0.5 break-words text-[9px] leading-4 text-slate-500 dark:text-slate-400">{check.detail}</div>
                                                    {check.stages && (
                                                        <div className="mt-2 grid gap-1.5 sm:grid-cols-2 lg:grid-cols-4" aria-label="板卡护照四级状态">
                                                            {check.stages.map(stage => {
                                                                const stageTheme = stateStyle[stage.state];
                                                                const stageIconColor = stage.state === 'pass'
                                                                    ? 'text-emerald-600'
                                                                    : stage.state === 'error'
                                                                        ? 'text-red-600'
                                                                        : stage.state === 'warning'
                                                                            ? 'text-amber-600'
                                                                            : 'text-slate-400';
                                                                return (
                                                                    <div key={stage.id} className="min-w-0 rounded-md border border-slate-200 bg-white/80 px-2 py-1.5 dark:border-slate-700 dark:bg-slate-900/80">
                                                                        <div className="flex items-center gap-1">
                                                                            <stageTheme.Icon size={10} className={stageIconColor} />
                                                                            <span className="truncate text-[9px] font-bold text-slate-700 dark:text-slate-200">{stage.title}</span>
                                                                        </div>
                                                                        <div className="mt-0.5 line-clamp-2 break-words text-[8px] leading-3.5 text-slate-500 dark:text-slate-400" title={stage.detail}>{stage.detail}</div>
                                                                    </div>
                                                                );
                                                            })}
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </section>

                            <section className="grid gap-2 md:grid-cols-2" aria-label="资源与依赖证据">
                                <div className="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900/75">
                                    <h3 className="text-xs font-bold text-slate-800 dark:text-slate-100">资源与增长解释</h3>
                                    <div className="mt-2 grid grid-cols-2 gap-2 text-[10px]"><div>Flash <strong>{formatResourceBytes(report.build.flashUsedBytes ?? Number.NaN)}</strong></div><div>RAM <strong>{formatResourceBytes(report.build.ramUsedBytes ?? Number.NaN)}</strong></div></div>
                                    <div className="mt-2 rounded-lg bg-slate-50 p-2 text-[10px] leading-4 text-slate-600 dark:bg-slate-800/70 dark:text-slate-300"><strong>{report.build.resourceGrowth.summary}</strong><br />{report.build.resourceGrowth.detail}</div>
                                </div>
                                <div className="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900/75">
                                    <h3 className="text-xs font-bold text-slate-800 dark:text-slate-100">依赖与历史</h3>
                                    <div className="mt-2 text-[10px] leading-5 text-slate-600 dark:text-slate-300">依赖锁：{report.dependencies.lockAvailable ? `已记录 ${report.dependencies.entries.length} 项` : '尚无可信锁'}<br />工程检查点：{report.history.checkpointCount}<br />修改次数：未启用审计，保持未知</div>
                                </div>
                            </section>

                            <section className="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900/75" aria-label="项目说明与测试记录">
                                <div className="flex items-center justify-between gap-2"><h3 className="text-xs font-bold text-slate-800 dark:text-slate-100">可选报告内容</h3><span className="text-[9px] text-slate-400">导出时再次脱敏；不会写回工程</span></div>
                                <div className="mt-2 grid gap-2 md:grid-cols-2">
                                    <label className="grid gap-1 text-[10px] font-semibold text-slate-600 dark:text-slate-300">电路说明
                                        <textarea value={circuitDescription} onChange={event => setCircuitDescription(event.target.value)} maxLength={10000} rows={4} placeholder="例如：传感器供电、电平和主要连接关系" className="resize-y rounded-lg border border-slate-200 bg-white p-2 text-[11px] font-normal leading-5 text-slate-800 outline-none focus:border-teal-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100" />
                                    </label>
                                    <label className="grid gap-1 text-[10px] font-semibold text-slate-600 dark:text-slate-300">测试记录
                                        <textarea value={testRecords} onChange={event => setTestRecords(event.target.value)} maxLength={10000} rows={4} placeholder="例如：测试条件、步骤、观察结果和未通过项" className="resize-y rounded-lg border border-slate-200 bg-white p-2 text-[11px] font-normal leading-5 text-slate-800 outline-none focus:border-teal-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100" />
                                    </label>
                                </div>
                            </section>

                            <section className="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900/75" aria-label="project.ckpkg 提交范围">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                    <div><h3 className="text-xs font-bold text-slate-800 dark:text-slate-100">导出 project.ckpkg 工程提交包</h3><p className="mt-0.5 text-[9px] text-slate-500 dark:text-slate-400">独立 schema、固定路径和逐文件 SHA-256；默认不含源码。</p></div>
                                </div>
                                <div className="mt-3 grid gap-3 md:grid-cols-2">
                                    <label className="grid gap-1 text-[10px] font-semibold text-slate-600 dark:text-slate-300">明确选择提交源码范围
                                        <select value={sourceScope} onChange={event => {
                                            const value = event.target.value as ProjectSubmissionSourceScope;
                                            setSourceScope(value);
                                            if (value === 'no_source') setSourceDisclosureAcknowledged(false);
                                        }} className="h-9 rounded-lg border border-slate-200 bg-white px-2 text-[11px] font-normal text-slate-800 outline-none focus:border-teal-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100">
                                            <option value="no_source">不含源码（仅验收报告）</option>
                                            <option value="editable_project">包含可编辑积木工程</option>
                                            <option value="generated_source">仅包含生成源码</option>
                                            <option value="editable_and_generated">包含积木工程和生成源码</option>
                                        </select>
                                    </label>
                                    <div className="grid content-start gap-2 rounded-lg border border-slate-100 bg-slate-50 p-2.5 text-[10px] text-slate-600 dark:border-slate-800 dark:bg-slate-950/50 dark:text-slate-300">
                                        <label className="flex items-center gap-2"><input type="checkbox" checked={includeBuildEvidence} onChange={event => setIncludeBuildEvidence(event.target.checked)} />附加脱敏构建证据摘要</label>
                                        <label className={`flex items-center gap-2 ${!report.dependencies.lockAvailable ? 'opacity-50' : ''}`}><input type="checkbox" checked={includeLock} disabled={!report.dependencies.lockAvailable} onChange={event => setIncludeLock(event.target.checked)} />附加脱敏 ck.lock（移除本机路径）</label>
                                    </div>
                                </div>
                                {sourceScope !== 'no_source' && (
                                    <label className="mt-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-[10px] leading-4 text-amber-800 dark:border-amber-900 dark:bg-amber-950/35 dark:text-amber-200">
                                        <input type="checkbox" className="mt-0.5" checked={sourceDisclosureAcknowledged} onChange={event => setSourceDisclosureAcknowledged(event.target.checked)} />
                                        <span><strong>我确认提交源码范围。</strong>积木字段和生成源码可能包含 Wi-Fi 名称、密码、令牌、服务地址或个人内容；CK 不会为了脱敏而破坏可编辑工程。</span>
                                    </label>
                                )}
                                <p className="mt-2 text-[9px] leading-4 text-slate-500 dark:text-slate-400">提交包不会包含工程路径、完整 MAC、串口内容，也不会自动上传。完整性已校验不等于发布者身份签名。</p>
                            </section>
                        </div>
                    )}
                </main>

                <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-slate-200 bg-white px-5 py-3 dark:border-slate-700 dark:bg-slate-900">
                    <span className="text-[9px] text-slate-400">默认不导出源码、工程路径、完整 MAC 或串口内容。</span>
                    <div className="flex max-w-full flex-wrap items-center justify-end gap-2">
                        <button type="button" onClick={() => void exportReport('json')} disabled={!report || Boolean(busy)} className="flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-xs font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">{busy === 'json' ? <Loader2 size={14} className="animate-spin" /> : <FileJson2 size={14} />}结构化 JSON</button>
                        <button type="button" onClick={() => void exportReport('html')} disabled={!report || Boolean(busy)} title="生成无脚本 HTML 后使用系统打印保存 PDF" className="flex h-8 items-center gap-1.5 rounded-lg bg-teal-700 px-3 text-xs font-bold text-white hover:bg-teal-800 disabled:opacity-50">{busy === 'html' ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />}打印 / 保存 PDF</button>
                        <button type="button" onClick={() => void exportSubmission()} disabled={!report || Boolean(busy) || (sourceScope !== 'no_source' && !sourceDisclosureAcknowledged)} className="flex h-8 items-center gap-1.5 rounded-lg bg-slate-900 px-3 text-xs font-bold text-white hover:bg-slate-800 disabled:opacity-50 dark:bg-teal-700 dark:hover:bg-teal-800">{busy === 'ckpkg' ? <Loader2 size={14} className="animate-spin" /> : <PackageCheck size={14} />}工程提交包</button>
                    </div>
                </footer>
            </div>
        </div>
    );
}

export default ProjectAcceptanceReportModal;
