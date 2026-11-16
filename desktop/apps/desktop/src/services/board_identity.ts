import type { BoardPackage } from '../types/board';

const clean = (value: unknown): string => String(value || '').trim();

/** Stable UI/project identity. FQBN remains the separate compiler target. */
export const boardPackageKey = (board: Pick<BoardPackage, 'id' | 'fqbn'>): string => (
    clean(board.id) || clean(board.fqbn)
);

/**
 * Resolve the concrete package first, then fall back to the built-in package
 * whose id equals the FQBN. This prevents a custom package sharing an Arduino
 * target from being silently replaced by another package with the same FQBN.
 */
export const resolveBoardPackage = (
    boards: readonly BoardPackage[],
    fqbn: string,
    packageId?: string | null,
): BoardPackage | undefined => {
    const targetFqbn = clean(fqbn);
    const targetPackageId = clean(packageId);
    if (targetPackageId) {
        const exact = boards.find(board => (
            boardPackageKey(board) === targetPackageId
            && (!targetFqbn || clean(board.fqbn) === targetFqbn)
        ));
        // An explicit package id is authoritative. Falling back to another
        // package with the same compiler FQBN can silently substitute its pin
        // map, libraries and hardware contract after a custom package is
        // removed or its target changes.
        return exact;
    }
    return boards.find(board => boardPackageKey(board) === targetFqbn)
        || boards.find(board => clean(board.fqbn) === targetFqbn);
};

export const boardPackageMatches = (
    board: Pick<BoardPackage, 'id' | 'fqbn'>,
    fqbn: string,
    packageId?: string | null,
): boolean => {
    const targetPackageId = clean(packageId);
    if (targetPackageId) return boardPackageKey(board) === targetPackageId;
    return clean(board.fqbn) === clean(fqbn) || boardPackageKey(board) === clean(fqbn);
};

export interface BoardPackageBuildGate {
    canBuild: boolean;
    status: 'ready' | 'missing' | 'uncertified' | 'quality-failed' | 'unusable';
    board: BoardPackage | undefined;
    reason: string;
}

/** Opening remains allowed, but compile/upload requires the exact package and a usable gate. */
export const evaluateBoardPackageBuildGate = (
    boards: readonly BoardPackage[],
    fqbn: string,
    packageId?: string | null,
): BoardPackageBuildGate => {
    const requestedPackageId = clean(packageId);
    const board = resolveBoardPackage(boards, fqbn, requestedPackageId || null);
    if (!board) {
        return {
            canBuild: false,
            status: 'missing',
            board: undefined,
            reason: requestedPackageId
                ? `工程需要板卡包 ${requestedPackageId}，但当前没有安装该精确包。`
                : `当前编译目标 ${clean(fqbn) || '未知'} 没有可用的板卡定义。`,
        };
    }
    const isCustom = (board as any).is_custom === true;
    const qualityReport = (board as any).quality_report || (board as any).qualityReport;
    const qualityStatus = clean(qualityReport?.status).toLowerCase();
    const integrityInvalid = Array.isArray(qualityReport?.checks)
        && qualityReport.checks.some((check: any) => [
            'installed-content-changed',
            'installed-content-check-failed',
            'installed-content-unverifiable',
            'missing-certified-content-hash',
        ].includes(clean(check?.code)));
    const runtimeCertified = Array.isArray(qualityReport?.validated_consumers)
        && qualityReport.validated_consumers.includes('runtime-loader');
    if (isCustom && (!qualityReport
        || !['passed', 'passed_with_warnings'].includes(qualityStatus)
        || !runtimeCertified
        || integrityInvalid)) {
        return {
            canBuild: false,
            status: qualityStatus === 'failed' || integrityInvalid
                ? 'quality-failed'
                : 'uncertified',
            board,
            reason: `板卡包 ${boardPackageKey(board)} 缺少有效、完整且可供运行时加载器信任的质量认证。`,
        };
    }
    if (qualityStatus === 'failed') {
        return {
            canBuild: false,
            status: 'quality-failed',
            board,
            reason: `板卡包 ${boardPackageKey(board)} 未通过结构与质量门禁，已阻止编译和上传。`,
        };
    }
    if ((isCustom && (board as any).usable !== true) || (board as any).usable === false) {
        return {
            canBuild: false,
            status: 'unusable',
            board,
            reason: clean((board as any).availability_error || (board as any).availabilityError)
                || `板卡包 ${boardPackageKey(board)} 的 Core、依赖或认证环境尚未就绪。`,
        };
    }
    return { canBuild: true, status: 'ready', board, reason: '' };
};
