import type { BoardPackage } from '../types/board';
import type { BoardPassportView } from './board_passport';
import { projectHealthCapabilities } from './project_health_capabilities';

export interface BoardSuccess {
    boardPackageId: string;
    fqbn: string;
    coreVersion: string;
    operation: 'compile' | 'upload';
    completedAt: string;
}

const baseFqbn = (fqbn: string) => fqbn.trim().split(':').slice(0, 3).join(':');

/** Display history only: an observation covers its exact configuration, never all menus. */
export const resolveBoardActivity = (board: BoardPackage, core: string | undefined, input: unknown) => {
    const rows = (Array.isArray(input) ? input : []).filter((r): r is BoardSuccess => (
        r && typeof r === 'object'
        && typeof r.boardPackageId === 'string' && r.boardPackageId === (board.id || board.fqbn)
        && typeof r.fqbn === 'string' && baseFqbn(r.fqbn) === baseFqbn(board.fqbn_base || board.fqbn)
        && typeof r.coreVersion === 'string' && !!r.coreVersion.trim()
        && ['compile', 'upload'].includes(r.operation)
        && typeof r.completedAt === 'string' && Number.isFinite(Date.parse(r.completedAt))
    )).sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt));
    return (['compile', 'upload'] as const).map(operation => {
        const history = rows.filter(r => r.operation === operation);
        const current = history.filter(r => !!core && r.coreVersion === core);
        return { operation, history, current, count: new Set(current.map(r => r.fqbn)).size };
    });
};

/** Builtins have no profile certification command. AVR has no device health workflow. */
export const boardCardPassportStages = (board: BoardPackage, view: BoardPassportView) => (
    view.stages.filter(stage => {
        if (stage.id === 'compile') return !!board.is_custom;
        if (stage.id === 'device') return !!board.is_custom && projectHealthCapabilities(board.fqbn_base || board.fqbn).deviceHealth;
        return true;
    })
);
