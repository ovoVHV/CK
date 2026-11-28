const isEnUi = (): boolean => {
    try {
        const lang = typeof document !== 'undefined' ? document.documentElement?.lang : '';
        const stored = typeof window !== 'undefined' ? window.localStorage?.getItem('ck.i18n.uiLocale') : '';
        return /^en(?:-|$)/i.test(String(lang || stored || ''));
    } catch { return false; }
};
const uiText = (zh: string, en: string): string => (isEnUi() ? en : zh);

export type BuildProgressMode = 'compile' | 'upload';
export type BuildProgressStage =
    | 'idle'
    | 'preparing'
    | 'cache-check'
    | 'waiting'
    | 'full-build'
    | 'sketch'
    | 'linking'
    | 'artifacts'
    | 'finalizing'
    | 'uploading';

export interface BuildProgressState {
    percentage: number;
    /** Legacy zh-CN presentation fallback. Never use this field as identity. */
    message: string;
    /** Stable presentation code resolved by the React layer at render time. */
    messageCode: string | null;
    messageParams: Record<string, string | number>;
    /** Original backend/compiler progress text retained as non-localized evidence. */
    rawMessage: string;
    mode: BuildProgressMode;
    stage: BuildProgressStage;
    indeterminate: boolean;
    fullBuildKind: 'first' | 'rebuild' | null;
    startedAt: number;
    elapsedMs: number;
    lastActivityAt: number;
    quietMs: number;
}

const clampPercentage = (value: unknown): number => {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.min(100, Math.max(0, number));
};

export const formatBuildPercentage = (value: unknown): string =>
    `${Math.round(clampPercentage(value))}%`;

export const createBuildProgressState = (
    mode: BuildProgressMode = 'compile',
    now = Date.now(),
): BuildProgressState => ({
    percentage: mode === 'upload' ? 0 : 2,
    message: mode === 'upload' ? '正在准备上传' : '正在初始化编译环境',
    messageCode: mode === 'upload'
        ? 'progress.message.preparingUpload'
        : 'progress.message.initializingCompiler',
    messageParams: {},
    rawMessage: '',
    mode,
    stage: mode === 'upload' ? 'uploading' : 'preparing',
    indeterminate: mode === 'compile',
    fullBuildKind: null,
    startedAt: now,
    elapsedMs: 0,
    lastActivityAt: now,
    quietMs: 0,
});

export const createIdleBuildProgress = (): BuildProgressState => ({
    ...createBuildProgressState('compile', 0),
    percentage: 0,
    message: '',
    messageCode: null,
    messageParams: {},
    rawMessage: '',
    stage: 'idle',
    indeterminate: false,
    startedAt: 0,
    lastActivityAt: 0,
});

const friendlyProgressMessage = (rawMessage: string, stage: BuildProgressStage): string => {
    const message = String(rawMessage || '').trim();
    const lower = message.toLowerCase();

    if (stage === 'full-build') return '正在编译核心与依赖';
    if (stage === 'waiting') return '正在为前台编译释放后台任务';
    if (stage === 'sketch') return '正在编译当前草图';
    if (stage === 'linking') return '正在链接固件';
    if (stage === 'artifacts') return '正在生成烧录文件';
    if (stage === 'finalizing') return '正在检查固件大小与产物';
    if (stage === 'uploading') {
        if (lower.includes('connecting')) return '正在连接开发板';
        if (lower.includes('resetting')) return '正在复位开发板';
        return message || '正在上传固件';
    }
    if (lower.includes('cache')) return '正在检查可复用缓存';
    if (lower.includes('initial')) return '正在初始化编译环境';
    if (message.startsWith('[Compiling]')) {
        return `正在编译 ${message.slice('[Compiling]'.length).trim() || '源文件'}`;
    }
    return message.length > 90 ? '编译器正在处理当前阶段' : (message || '正在准备编译');
};

const progressMessageDescriptor = (
    rawMessage: string,
    stage: BuildProgressStage,
): { code: string | null; params: Record<string, string | number> } => {
    const message = String(rawMessage || '').trim();
    const lower = message.toLowerCase();

    if (stage === 'full-build') return { code: 'progress.message.compilingCore', params: {} };
    if (stage === 'waiting') return { code: 'progress.message.waitingForeground', params: {} };
    if (stage === 'sketch') return { code: 'progress.message.compilingSketch', params: {} };
    if (stage === 'linking') return { code: 'progress.message.linkingFirmware', params: {} };
    if (stage === 'artifacts') return { code: 'progress.message.generatingArtifacts', params: {} };
    if (stage === 'finalizing') return { code: 'progress.message.checkingArtifacts', params: {} };
    if (stage === 'uploading') {
        if (lower.includes('connecting')) return { code: 'progress.message.connectingBoard', params: {} };
        if (lower.includes('resetting')) return { code: 'progress.message.resettingBoard', params: {} };
        return { code: 'progress.message.uploadingFirmware', params: {} };
    }
    if (lower.includes('cache')) return { code: 'progress.message.checkingCache', params: {} };
    if (lower.includes('initial')) return { code: 'progress.message.initializingCompiler', params: {} };
    if (message.startsWith('[Compiling]')) {
        return {
            code: 'progress.message.compilingSource',
            params: { source: message.slice('[Compiling]'.length).trim() || 'source' },
        };
    }
    if (message.length > 90) return { code: 'progress.message.processingStage', params: {} };
    return message
        ? { code: null, params: {} }
        : { code: 'progress.message.preparingBuild', params: {} };
};

const classifyProgressMessage = (
    message: string,
    previous: BuildProgressState,
): Pick<BuildProgressState, 'mode' | 'stage' | 'indeterminate' | 'fullBuildKind'> => {
    const lower = String(message || '').toLowerCase();

    if (
        previous.mode === 'upload'
        || lower.includes('starting upload')
        || lower.includes('uploading')
        || lower.includes('connecting to board')
        || lower.includes('resetting board')
    ) {
        return {
            mode: 'upload',
            stage: 'uploading',
            indeterminate: false,
            fullBuildKind: previous.fullBuildKind,
        };
    }
    if (lower.includes('forced rebuild') || lower.includes('cache cleaned')) {
        return {
            mode: previous.mode,
            stage: 'full-build',
            indeterminate: true,
            fullBuildKind: 'rebuild',
        };
    }
    if (lower.includes('first build') || lower.includes('compiling all dependencies')) {
        return {
            mode: previous.mode,
            stage: 'full-build',
            indeterminate: true,
            fullBuildKind: previous.fullBuildKind || 'first',
        };
    }
    if (lower === 'compiling...' || lower === 'compiling') {
        return {
            mode: previous.mode,
            stage: 'full-build',
            indeterminate: true,
            fullBuildKind: previous.fullBuildKind,
        };
    }
    if (lower.includes('fast relink: compiling') || lower.includes('compiling sketch unit')) {
        return {
            mode: previous.mode,
            stage: 'sketch',
            indeterminate: false,
            fullBuildKind: previous.fullBuildKind,
        };
    }
    if (lower.includes('linking firmware') || lower.includes('fast relink: linking')) {
        return {
            mode: previous.mode,
            stage: 'linking',
            indeterminate: false,
            fullBuildKind: previous.fullBuildKind,
        };
    }
    if (lower.includes('generating upload artifacts')) {
        return {
            mode: previous.mode,
            stage: 'artifacts',
            indeterminate: false,
            fullBuildKind: previous.fullBuildKind,
        };
    }
    if (lower.includes('calculating size') || lower.includes('sketch uses') || lower.includes('global variables')) {
        return {
            mode: previous.mode,
            stage: 'finalizing',
            indeterminate: false,
            fullBuildKind: previous.fullBuildKind,
        };
    }
    if (lower.includes('cached') || lower.includes('exact match')) {
        return {
            mode: previous.mode,
            stage: 'finalizing',
            indeterminate: false,
            fullBuildKind: previous.fullBuildKind,
        };
    }
    if (lower.includes('cache') || lower.includes('resolving')) {
        return {
            mode: previous.mode,
            stage: 'cache-check',
            indeterminate: true,
            fullBuildKind: previous.fullBuildKind,
        };
    }
    return {
        mode: previous.mode,
        stage: previous.stage === 'idle' ? 'preparing' : previous.stage,
        indeterminate: previous.indeterminate,
        fullBuildKind: previous.fullBuildKind,
    };
};

export const applyBuildProgressEvent = (
    previous: BuildProgressState,
    percentage: unknown,
    rawMessage: unknown,
    now = Date.now(),
): BuildProgressState => {
    const message = String(rawMessage || '');
    const classification = classifyProgressMessage(message, previous);
    const presentation = progressMessageDescriptor(message, classification.stage);
    const reported = clampPercentage(percentage);
    const phaseChanged = classification.mode !== previous.mode;
    // ESP uploaders report one 0-100 range per image (bootloader,
    // partitions, application, filesystem).  Keeping the compile-time
    // monotonic guard across those image boundaries leaves the UI pinned at
    // 100% after the first tiny image.  Backend upload percentages are
    // wrapped in this stable message, so accept the current image's value
    // verbatim while preserving monotonic progress for compile events.
    const isUploadImageProgress = classification.mode === 'upload'
        && /^uploading\s*\(/i.test(message.trim());
    const nextPercentage = phaseChanged || isUploadImageProgress
        ? reported
        : reported >= 100
        ? 100
        : Math.max(previous.percentage, reported);

    return {
        ...previous,
        ...classification,
        percentage: nextPercentage,
        message: friendlyProgressMessage(message, classification.stage),
        messageCode: presentation.code,
        messageParams: presentation.params,
        rawMessage: message,
        elapsedMs: previous.startedAt ? Math.max(0, now - previous.startedAt) : 0,
        lastActivityAt: now,
        quietMs: 0,
    };
};

export const applyBuildLogLine = (
    previous: BuildProgressState,
    rawLine: string,
    now = Date.now(),
): BuildProgressState => {
    const line = String(rawLine || '').trim();
    const lower = line.toLowerCase();
    if (!line) return previous;
    // A host wait notice is not evidence of compiler activity or completion.
    if (line.startsWith('[V9 等待]')) return previous;
    const activity = line.split(/\r?\n/).filter(part => part.startsWith('[V9 进度] ')).slice(-1)[0];
    if (activity) {
        const message = activity.slice('[V9 进度] '.length);
        const stage: BuildProgressStage = /^链接固件/.test(message) ? 'linking'
            : /^(生成镜像|产物元数据)/.test(message) ? 'artifacts'
            : /^(资产复核|固件验证|宿主交付|收据验证)/.test(message) ? 'finalizing'
            : /^编译 Sketch/.test(message) ? 'sketch'
            : /^(发现\/编译|对象编译|静态归档|预编译头)/.test(message) ? 'full-build'
            : /^(资产校验|相同源码|任务调度)/.test(message) ? 'cache-check' : 'preparing';
        const enActivity = stage === 'linking' ? 'Linking firmware'
            : stage === 'artifacts' ? 'Generating upload artifacts'
            : stage === 'finalizing' ? 'Checking firmware size and artifacts'
            : stage === 'sketch' ? 'Compiling the current sketch'
            : stage === 'full-build' ? 'Compiling the Core and dependencies'
            : stage === 'cache-check' ? 'Checking reusable cache'
            : 'Preparing compilation';
        return { ...previous, stage, indeterminate: true, message: uiText(message, enActivity), messageCode: null,
            messageParams: {}, rawMessage: activity, lastActivityAt: now, quietMs: 0,
            elapsedMs: previous.startedAt ? Math.max(0, now - previous.startedAt) : 0 };
    }

    let classification: Pick<BuildProgressState, 'stage' | 'indeterminate' | 'fullBuildKind'> | null = null;
    let message = previous.message;
    let messageCode = previous.messageCode;
    let messageParams = previous.messageParams;

    if (
        lower.includes('reusing compatible same-board warmup')
        || lower.includes('waiting for matching warmup')
    ) {
        classification = {
            stage: 'waiting',
            indeterminate: true,
            fullBuildKind: previous.fullBuildKind,
        };
        message = '正在等待后台预热移交可复用缓存';
        messageCode = 'progress.message.waitingWarmupHandoff';
        messageParams = {};
    } else if (lower.includes('forced rebuild')) {
        classification = { stage: 'full-build', indeterminate: true, fullBuildKind: 'rebuild' };
        message = '正在强制重建当前配置';
        messageCode = 'progress.message.forcedRebuild';
        messageParams = {};
    } else if (lower.includes('[info] full build:')) {
        classification = {
            stage: 'full-build',
            indeterminate: true,
            fullBuildKind: previous.fullBuildKind || 'first',
        };
        message = '正在编译核心与依赖';
        messageCode = 'progress.message.compilingCore';
        messageParams = {};
    } else if (lower.includes('core cache injected')) {
        classification = { stage: 'cache-check', indeterminate: true, fullBuildKind: previous.fullBuildKind };
        message = '核心缓存已就绪，正在准备依赖';
        messageCode = 'progress.message.coreCacheReady';
        messageParams = {};
    } else if (lower.includes('fast relink: directly updated') || lower.includes('fast relink: compiling')) {
        classification = { stage: 'sketch', indeterminate: false, fullBuildKind: previous.fullBuildKind };
        message = '正在编译当前草图';
        messageCode = 'progress.message.compilingSketch';
        messageParams = {};
    } else if (lower.includes('gcc link') || lower.includes('fast relink: linking')) {
        classification = { stage: 'linking', indeterminate: false, fullBuildKind: previous.fullBuildKind };
        message = '正在链接固件';
        messageCode = 'progress.message.linkingFirmware';
        messageParams = {};
    } else if (lower.includes('firmware artifacts') || lower.includes('calculating size')) {
        classification = { stage: 'finalizing', indeterminate: false, fullBuildKind: previous.fullBuildKind };
        message = '正在检查固件产物';
        messageCode = 'progress.message.checkingArtifacts';
        messageParams = {};
    } else if (lower.includes('exact-match cache miss')) {
        classification = { stage: 'cache-check', indeterminate: true, fullBuildKind: previous.fullBuildKind };
        message = '缓存条件发生变化，正在选择安全编译路径';
        messageCode = 'progress.message.cacheChanged';
        messageParams = {};
    } else if (
        lower.includes('falling back to arduino-cli compile')
        || lower.includes('trying shared-fast')
        || lower.includes('release-fallback')
    ) {
        classification = {
            stage: 'full-build',
            indeterminate: true,
            fullBuildKind: previous.fullBuildKind,
        };
        message = '快速路径不可用，正在执行兼容编译';
        messageCode = 'progress.message.compatibilityBuild';
        messageParams = {};
    }

    return {
        ...previous,
        ...(classification || {}),
        message,
        messageCode,
        messageParams,
        rawMessage: line,
        elapsedMs: previous.startedAt ? Math.max(0, now - previous.startedAt) : 0,
        lastActivityAt: now,
        quietMs: 0,
    };
};

export const tickBuildProgress = (
    previous: BuildProgressState,
    now = Date.now(),
): BuildProgressState => ({
    ...previous,
    elapsedMs: previous.startedAt ? Math.max(0, now - previous.startedAt) : 0,
    quietMs: previous.lastActivityAt ? Math.max(0, now - previous.lastActivityAt) : 0,
});

export const formatBuildElapsed = (milliseconds: number): string => {
    const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
};

export const buildStageIndex = (stage: BuildProgressStage): number => {
    if (stage === 'preparing' || stage === 'cache-check' || stage === 'waiting') return 0;
    if (stage === 'full-build' || stage === 'sketch') return 1;
    if (stage === 'linking') return 2;
    if (stage === 'artifacts' || stage === 'finalizing' || stage === 'uploading') return 3;
    return 0;
};
