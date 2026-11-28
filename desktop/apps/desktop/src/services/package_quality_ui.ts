import type { PackageQualityReport, PackageQualityStatus, QualityCheckStatus } from '../types/packageQuality';

export type PackageQualityTone = 'neutral' | 'success' | 'warning' | 'danger';

export interface PackageQualitySummary {
    label: string;
    detail: string;
    tone: PackageQualityTone;
    trusted: boolean;
}

const isEnUi = (): boolean => {
    try {
        const lang = typeof document !== 'undefined' ? document.documentElement?.lang : '';
        const stored = typeof window !== 'undefined' ? window.localStorage?.getItem('ck.i18n.uiLocale') : '';
        return /^en(?:-|$)/i.test(String(lang || stored || ''));
    } catch { return false; }
};
const uiText = (zh: string, en: string): string => (isEnUi() ? en : zh);

const STATUS_SUMMARY_ZH: Record<PackageQualityStatus, PackageQualitySummary> = {
    pending: {
        label: '尚未检查',
        detail: '还没有可用的本地质量报告',
        tone: 'neutral',
        trusted: false,
    },
    passed: {
        label: '本地检查通过',
        detail: '未发现会阻止加载的确定性问题',
        tone: 'success',
        trusted: true,
    },
    passed_with_warnings: {
        label: '通过但有警告',
        detail: '允许加载，但仍有兼容性或可维护性风险',
        tone: 'warning',
        trusted: true,
    },
    failed: {
        label: '已阻止',
        detail: '存在确定性错误，不会作为可信扩展加载',
        tone: 'danger',
        trusted: false,
    },
};

const STATUS_SUMMARY_EN: Record<PackageQualityStatus, PackageQualitySummary> = {
    pending: {
        label: 'Not checked',
        detail: 'No local quality report is available yet',
        tone: 'neutral',
        trusted: false,
    },
    passed: {
        label: 'Local check passed',
        detail: 'No deterministic issues that block loading were found',
        tone: 'success',
        trusted: true,
    },
    passed_with_warnings: {
        label: 'Passed with warnings',
        detail: 'Allowed to load, but compatibility or maintenance risks remain',
        tone: 'warning',
        trusted: true,
    },
    failed: {
        label: 'Blocked',
        detail: 'Deterministic errors found; not loaded as a trusted extension',
        tone: 'danger',
        trusted: false,
    },
};

export const qualityStatusSummary = (
    report: PackageQualityReport | null | undefined,
): PackageQualitySummary => {
    const map = isEnUi() ? STATUS_SUMMARY_EN : STATUS_SUMMARY_ZH;
    if (!report) return map.pending;
    return map[report.status] || map.pending;
};

export const qualityCheckLabel = (status: QualityCheckStatus): string => {
    if (status === 'error') return uiText('阻止', 'Blocked');
    if (status === 'warning') return uiText('警告', 'Warning');
    return uiText('通过', 'Passed');
};

/**
 * Quality diagnostics can originate in native validators and may contain an
 * absolute extraction path. The UI only needs the actionable message, never a
 * username or temporary directory, so local paths are redacted before render.
 */
export const redactQualityMessage = (
    value: unknown,
    options: { emptyLabel?: string; pathPlaceholder?: string } = {},
): string => {
    const emptyLabel = options.emptyLabel || uiText('检查已完成', 'Check completed');
    const pathPlaceholder = options.pathPlaceholder || uiText('[本机路径]', '[local path]');
    const raw = String(value || '').trim();
    if (!raw) return emptyLabel;
    return raw
        .replace(/(["'])(?:[a-zA-Z]:\\|\/(?:Users|home|tmp|private\/tmp|var\/tmp)\/)[^"'\r\n]*\1/g, `$1${pathPlaceholder}$1`)
        .replace(/[a-zA-Z]:\\(?:[^\s,，;；"'()（）]+\\)*[^\s,，;；"'()（）]*/g, pathPlaceholder)
        .replace(/\/(?:Users|home|tmp|private\/tmp|var\/tmp)\/[^\s,，;；"'()（）]*/g, pathPlaceholder)
        .replace(/file:\/\/\/[^\s,，;；"'()（）]*/gi, pathPlaceholder);
};

export const qualityHashLabel = (value: unknown): string | null => {
    const hash = String(value || '').trim().toLowerCase();
    return /^[a-f0-9]{64}$/.test(hash) ? hash : null;
};
