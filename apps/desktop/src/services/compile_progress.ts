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
    message: string;
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

    let classification: Pick<BuildProgressState, 'stage' | 'indeterminate' | 'fullBuildKind'> | null = null;
    let message = previous.message;

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
    } else if (lower.includes('forced rebuild')) {
        classification = { stage: 'full-build', indeterminate: true, fullBuildKind: 'rebuild' };
        message = '正在强制重建当前配置';
    } else if (lower.includes('[info] full build:')) {
        classification = {
            stage: 'full-build',
            indeterminate: true,
            fullBuildKind: previous.fullBuildKind || 'first',
        };
        message = '正在编译核心与依赖';
    } else if (lower.includes('core cache injected')) {
        classification = { stage: 'cache-check', indeterminate: true, fullBuildKind: previous.fullBuildKind };
        message = '核心缓存已就绪，正在准备依赖';
    } else if (lower.includes('fast relink: directly updated') || lower.includes('fast relink: compiling')) {
        classification = { stage: 'sketch', indeterminate: false, fullBuildKind: previous.fullBuildKind };
        message = '正在编译当前草图';
    } else if (lower.includes('gcc link') || lower.includes('fast relink: linking')) {
        classification = { stage: 'linking', indeterminate: false, fullBuildKind: previous.fullBuildKind };
        message = '正在链接固件';
    } else if (lower.includes('firmware artifacts') || lower.includes('calculating size')) {
        classification = { stage: 'finalizing', indeterminate: false, fullBuildKind: previous.fullBuildKind };
        message = '正在检查固件产物';
    } else if (lower.includes('exact-match cache miss')) {
        classification = { stage: 'cache-check', indeterminate: true, fullBuildKind: previous.fullBuildKind };
        message = '缓存条件发生变化，正在选择安全编译路径';
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
    }

    return {
        ...previous,
        ...(classification || {}),
        message,
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
