import boardsData from './boards.json';
import type { PinConfig } from '../types/board';

export interface BoardConfig {
    name: string;
    fqbn: string; // Acts as ID
    pins: PinConfig[];
}

export const BOARDS: BoardConfig[] = boardsData as BoardConfig[];

export const getBoardConfig = (fqbn: string): BoardConfig | null => {
    const requested = String(fqbn || '').trim();
    if (!requested) return null;
    const exact = BOARDS.find(b => b.fqbn === requested);
    if (exact) return exact;
    // Pin metadata is declared against a board family/base FQBN.  Compile
    // identities may additionally carry Core menu options, so resolve those
    // to the base catalog entry instead of dropping all pin evidence.
    const base = requested.split(':').slice(0, 3).join(':');
    return BOARDS.find(b => b.fqbn === base) || null;
};

export const getPinsAsDropdown = (fqbn: string): [string, string][] => {
    const board = getBoardConfig(fqbn);
    return board ? board.pins.map(p => [p.label, p.value]) : [];
};
