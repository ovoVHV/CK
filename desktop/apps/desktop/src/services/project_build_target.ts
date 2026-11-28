import { baseBoardFqbn, composeBoardFqbn, parseBoardFqbnOptions, sanitizeBoardOptions } from './board_fqbn';
const uiText = (zh: string, en: string): string => {
    try {
        const lang = typeof document !== 'undefined' ? document.documentElement?.lang : '';
        const stored = typeof window !== 'undefined' ? window.localStorage?.getItem('ck.i18n.uiLocale') : '';
        return /^en(?:-|$)/i.test(String(lang || stored || '')) ? en : zh;
    } catch { return zh; }
};

/** Reproducible project settings, not a cache authorization or a toolchain lock. */
export interface ProjectBuildTarget {
    schemaVersion: 1;
    board: string;
    boardPackageId: string;
    coreId: string;
    coreVersion: string | null;
    fqbn: string;
    options: Record<string, string>;
    optionsComplete: boolean;
}

export interface ProjectBuildEnvironment {
    board: string;
    boardPackageId: string;
    coreVersion: string;
    options: Record<string, unknown>;
    effectiveOptions: Record<string, string>;
    resolved: boolean;
}

const sortedOptions = (input: Record<string, unknown>): Record<string, string> =>
    Object.fromEntries(Object.entries(sanitizeBoardOptions(input)).sort(([a], [b]) => a.localeCompare(b)));

export const readProjectBuildTarget = (raw: unknown): ProjectBuildTarget | null => {
    if (raw === undefined || raw === null || raw === '') return null;
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || value.schemaVersion !== 1 || typeof value.board !== 'string'
        || !/^[\w.-]+:[\w.-]+:[\w.-]+$/.test(value.board)
        || typeof value.boardPackageId !== 'string' || !value.boardPackageId.trim()
        || value.coreId !== value.board.split(':').slice(0, 2).join(':')
        || !(value.coreVersion === null || (typeof value.coreVersion === 'string' && value.coreVersion.trim()))
        || typeof value.optionsComplete !== 'boolean'
        || !value.options || typeof value.options !== 'object' || Array.isArray(value.options)) {
        throw new Error(uiText('工程板卡配置记录损坏或版本不受支持', 'Project board target record is corrupted or unsupported'));
    }
    const options = sortedOptions(value.options);
    if (Object.keys(options).length !== Object.keys(value.options).length
        || Object.entries(value.options).some(([key, val]) => options[key] !== val)
        || value.fqbn !== composeBoardFqbn(value.board, options)) {
        throw new Error(uiText('工程板卡配置与完整 FQBN 不一致', 'Project board options do not match the full FQBN'));
    }
    return { schemaVersion: 1, board: value.board, boardPackageId: value.boardPackageId,
        coreId: value.coreId, coreVersion: value.coreVersion, fqbn: value.fqbn,
        options, optionsComplete: value.optionsComplete };
};

const sameBoard = (saved: ProjectBuildTarget, env: ProjectBuildEnvironment): boolean =>
    saved.board === baseBoardFqbn(env.board) && saved.boardPackageId === (env.boardPackageId || baseBoardFqbn(env.board));

export const projectBuildTargetDifference = (
    saved: ProjectBuildTarget | null, env: ProjectBuildEnvironment,
): string | null => {
    if (!saved || !sameBoard(saved, env)) return null; // An explicit board switch starts a new target.
    if (saved.coreVersion && saved.coreVersion !== env.coreVersion) {
        return uiText(`工程记录 ${saved.coreId} @ ${saved.coreVersion}；当前为 ${env.coreVersion || '未安装或尚未识别'}。`, `Project expects ${saved.coreId} @ ${saved.coreVersion}; current is ${env.coreVersion || 'not installed or unrecognized'}.`);
    }
    if (saved.optionsComplete && env.resolved) {
        const newMenus = Object.keys(env.effectiveOptions).filter(key => !(key in saved.options));
        if (newMenus.length) return uiText(`当前板卡增加了工程未记录的配置项：${newMenus.join('、')}。`, `Current board added options not recorded in project: ${newMenus.join(', ')}.`);
    }
    return null;
};

export const captureProjectBuildTarget = (
    env: ProjectBuildEnvironment, saved: ProjectBuildTarget | null,
): ProjectBuildTarget => {
    const board = baseBoardFqbn(env.board);
    const previous = saved && sameBoard(saved, env) ? saved : null;
    const changedEnvironment = projectBuildTargetDifference(previous, env);
    // Saving code while the original Core is absent must not silently adopt a new Core/defaults.
    const canResolve = env.resolved && !changedEnvironment;
    const options = sortedOptions(canResolve
        ? { ...env.effectiveOptions, ...env.options }
        : { ...previous?.options, ...env.options });
    const complete = canResolve || Boolean(previous?.optionsComplete
        && Object.keys(previous.options).every(key => key in options));
    return {
        schemaVersion: 1, board, boardPackageId: env.boardPackageId || board,
        coreId: board.split(':').slice(0, 2).join(':'),
        coreVersion: previous?.coreVersion || env.coreVersion || null,
        fqbn: composeBoardFqbn(board, options), options, optionsComplete: complete,
    };
};

/** A previous successful firmware already records the concrete Core and full FQBN. */
export const targetFromRecordedFqbn = (board: string, boardPackageId: string, fqbn: string, coreVersion: string): ProjectBuildTarget =>
    captureProjectBuildTarget({ board, boardPackageId, coreVersion, options: parseBoardFqbnOptions(fqbn),
        effectiveOptions: {}, resolved: false }, null);

/** Clipboard/export annotation only. Never feed it back into the live compile source. */
export const sourceWithBuildTarget = (code: string, target: ProjectBuildTarget): string =>
    `// CK build configuration (select the matching board and Core in your IDE):\n`
    + `// ${JSON.stringify(target)}\n\n${code}`;
