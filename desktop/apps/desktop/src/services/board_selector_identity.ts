export const BOARD_SOURCE_TYPES = {
    CUSTOM: 'custom',
    CATALOG: 'catalog',
} as const;

export const BOARD_CATEGORY_IDS = {
    ALL: 'all',
    CUSTOM: 'custom',
    ESP32: 'esp32',
    ARDUINO: 'arduino',
    OTHER: 'other',
} as const;

export const BOARD_CATEGORY_ORDER: readonly BoardCategoryId[] = [
    BOARD_CATEGORY_IDS.CUSTOM,
    BOARD_CATEGORY_IDS.ESP32,
    BOARD_CATEGORY_IDS.ARDUINO,
    BOARD_CATEGORY_IDS.OTHER,
];

export const CORE_INSTALL_PHASES = {
    INITIALIZING: 'initializing',
    DOWNLOADING: 'downloading',
    INSTALLING: 'installing',
} as const;

export const CORE_INSTALL_EVENT_TYPES = {
    DOWNLOAD_PROGRESS: 'download_progress',
    INSTALL_PROGRESS: 'install_progress',
} as const;

export type BoardSourceType = typeof BOARD_SOURCE_TYPES[keyof typeof BOARD_SOURCE_TYPES];
export type BoardCategoryId = typeof BOARD_CATEGORY_IDS[keyof typeof BOARD_CATEGORY_IDS];
export type CatalogCategoryId = BoardCategoryId | `vendor:${string}`;
export type CoreInstallPhase = typeof CORE_INSTALL_PHASES[keyof typeof CORE_INSTALL_PHASES];

export interface BoardCategoryIdentityInput {
    is_custom?: boolean;
    fqbn?: string;
    catalog_vendor?: string;
}

export interface CoreInstallProgress {
    phase: CoreInstallPhase;
    percent: number;
    message: string;
}

export const boardSourceType = (board: BoardCategoryIdentityInput): BoardSourceType => (
    board.is_custom ? BOARD_SOURCE_TYPES.CUSTOM : BOARD_SOURCE_TYPES.CATALOG
);

export const boardCategoryId = (
    board: BoardCategoryIdentityInput,
): Exclude<CatalogCategoryId, 'all'> => {
    const vendor = board.catalog_vendor?.trim();
    if (board.is_custom && vendor) return `vendor:${vendor.normalize('NFKC').toLowerCase()}`;
    if (boardSourceType(board) === BOARD_SOURCE_TYPES.CUSTOM) return BOARD_CATEGORY_IDS.CUSTOM;
    const fqbn = String(board.fqbn || '');
    if (fqbn.startsWith('esp32:')) return BOARD_CATEGORY_IDS.ESP32;
    if (fqbn.startsWith('arduino:')) return BOARD_CATEGORY_IDS.ARDUINO;
    return BOARD_CATEGORY_IDS.OTHER;
};

export const compareBoardCategoryIds = (
    left: BoardCategoryId,
    right: BoardCategoryId,
): number => BOARD_CATEGORY_ORDER.indexOf(left) - BOARD_CATEGORY_ORDER.indexOf(right);

export interface CatalogCategory {
    id: CatalogCategoryId;
    name?: string;
    logoPath?: string;
}

export function boardCatalogCategories(
    boards: readonly (BoardCategoryIdentityInput & { id: string; vendor_logo_path?: string })[],
): CatalogCategory[] {
    const groups = new Map<CatalogCategoryId, CatalogCategory>();
    // Package enumeration order varies across filesystems. Pick the first
    // available logo in stable package-id order when a vendor ships several.
    for (const board of [...boards].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
        const id = boardCategoryId(board);
        const existing = groups.get(id);
        if (!existing) groups.set(id, { id, name: board.catalog_vendor?.trim(), logoPath: board.vendor_logo_path });
        else if (!existing.logoPath) existing.logoPath = board.vendor_logo_path;
    }
    const order = (id: CatalogCategoryId) => id.startsWith('vendor:') ? 2.5 : BOARD_CATEGORY_ORDER.indexOf(id as BoardCategoryId);
    return [{ id: 'all' }, ...[...groups.values()].sort((a, b) =>
        order(a.id) - order(b.id) || a.id.localeCompare(b.id))];
}

/** Map backend event identity to presentation-independent UI phase identity. */
export const coreInstallPhaseForEventType = (eventType: unknown): CoreInstallPhase | null => {
    if (eventType === CORE_INSTALL_EVENT_TYPES.DOWNLOAD_PROGRESS) return CORE_INSTALL_PHASES.DOWNLOADING;
    if (eventType === CORE_INSTALL_EVENT_TYPES.INSTALL_PROGRESS) return CORE_INSTALL_PHASES.INSTALLING;
    return null;
};

export const shouldAppendCoreInstallPhaseLog = (
    previous: CoreInstallPhase | null,
    next: CoreInstallPhase,
): boolean => previous !== next;
