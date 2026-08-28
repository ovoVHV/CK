import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import {
    baseBoardFqbn,
    boardOptionSchemaCacheKey,
    boardOptionsFallbackStatus,
    createBoardOptionSwitchState,
    extractSelectedBoardOptionDefaults,
    mergeBoardOptionSchemas,
    normalizeBoardOptionValue,
    parseBoardFqbnOptions,
    resolveBoardOptions,
    resolveBoardOptionsWithDiagnostics,
    sanitizeBoardOptions,
    updateExplicitBoardOption,
} from '../services/board_fqbn';
import { clearBoardDetailsCache, getBoardDetailsCached } from '../services/board_details_cache';
import { clearInstalledCorePinAliasCache } from '../services/core_pin_aliases';
import {
    evaluateBoardPackageBuildGate,
    resolveBoardPackage,
} from '../services/board_identity';

export { composeBoardFqbn } from '../services/board_fqbn';

export type BoardOptionsStatus = 'loading' | 'resolved' | 'core-default' | 'unverified';

interface BoardOptionSchema {
    defaults: Record<string, string>;
    allowedKeys: Set<string>;
    allowedValues: Map<string, Set<string>>;
}

const BOARD_OPTION_SCHEMA_CACHE = new Map<string, BoardOptionSchema>();
const BOARD_OPTION_SCHEMA_REQUESTS = new Map<string, Promise<BoardOptionSchema>>();
let boardOptionSchemaGeneration = 0;

const loadBoardOptionSchema = async (
    fqbn: string,
    boardPackageId: string,
    packageConfigOptions?: unknown,
): Promise<BoardOptionSchema> => {
    const cacheKey = boardOptionSchemaCacheKey(fqbn, boardPackageId);
    const cached = BOARD_OPTION_SCHEMA_CACHE.get(cacheKey);
    if (cached) return cached;
    const pending = BOARD_OPTION_SCHEMA_REQUESTS.get(cacheKey);
    if (pending) return pending;

    const requestGeneration = boardOptionSchemaGeneration;
    const request = (async () => {
        const details = await getBoardDetailsCached(fqbn);
        const schema = packageConfigOptions === undefined
            ? extractSelectedBoardOptionDefaults(details?.config_options)
            : mergeBoardOptionSchemas(details?.config_options, packageConfigOptions);
        if (requestGeneration === boardOptionSchemaGeneration) {
            BOARD_OPTION_SCHEMA_CACHE.set(cacheKey, schema);
        }
        return schema;
    })();
    BOARD_OPTION_SCHEMA_REQUESTS.set(cacheKey, request);
    try {
        return await request;
    } finally {
        if (BOARD_OPTION_SCHEMA_REQUESTS.get(cacheKey) === request) {
            BOARD_OPTION_SCHEMA_REQUESTS.delete(cacheKey);
        }
    }
};

const cachedBoardOptionSchema = (fqbn: string, boardPackageId: string): BoardOptionSchema | null => (
    BOARD_OPTION_SCHEMA_CACHE.get(boardOptionSchemaCacheKey(fqbn, boardPackageId)) || null
);

const packageConfigOptionsForIdentity = (
    boards: readonly any[],
    fqbn: string,
    boardPackageId: string,
): unknown => {
    const board = resolveBoardPackage(boards, fqbn, boardPackageId) as any;
    return board && (board.is_custom === true || board.isCustom === true)
        ? board.config_options
        : undefined;
};

const clearBoardOptionSchemaCache = (): void => {
    boardOptionSchemaGeneration += 1;
    BOARD_OPTION_SCHEMA_CACHE.clear();
    BOARD_OPTION_SCHEMA_REQUESTS.clear();
    clearBoardDetailsCache();
    clearInstalledCorePinAliasCache();
};

export interface SerialPortInfo {
    port_name: string;
    description: string;
    hardware_id?: string;
}

interface HardwareContextType {
    ports: SerialPortInfo[];
    activePort: string | null;
    isScanning: boolean;
    activeBoard: string;
    /** Concrete board-package identity; may differ from FQBN for imported boards. */
    activeBoardPackageId: string;
    setActiveBoard: (fqbn: string, boardPackageId?: string) => void;
    /** Project/user choices only; used for persistence. */
    boardOptions: Record<string, string>;
    /** Validated project choices only; used for compile/cache identity. */
    resolvedBoardOptions: Record<string, string>;
    /** Complete defaults plus choices for read-only configuration display. */
    displayBoardOptions: Record<string, string>;
    boardOptionsStatus: BoardOptionsStatus;
    /** Saved values rejected by the active board schema (unsupported key or value). */
    droppedBoardOptions: Record<string, string>;
    setBoardOption: (key: string, value: string) => void;
    setBoardOptions: (opts: Record<string, unknown>) => void;
    connectDevice: (portName: string) => void;
    disconnectDevice: () => void;
    scanPorts: (silent?: boolean) => Promise<boolean>;
    availableBoards: any[]; // Using any to avoid circular deps or complex imports for now, or Import BoardPackage
    reloadBoards: () => Promise<void>;
    availableLibraries: import('../types/library').LibraryInfo[];
    reloadLibraries: (board?: string, boardPackageId?: string) => Promise<void>;
    installedCores: string[];
    installedCoreVersions: Record<string, string>;
    refreshInstalledCores: (options?: { invalidateBoardSchemas?: boolean }) => Promise<void>;
}

const HardwareContext = createContext<HardwareContextType | null>(null);

export const HardwareProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [ports, setPorts] = useState<SerialPortInfo[]>([]);
    const [activePort, setActivePort] = useState<string | null>(null);
    const lastActivePort = useRef<string | null>(null);
    const [isScanning, setIsScanning] = useState(false);

    // For now, if a device is connected, we assume it's the target board.
    const [activeBoard, setActiveBoardState] = useState('esp32:esp32:esp32c5');
    const activeBoardRef = useRef(activeBoard);
    const [activeBoardPackageId, setActiveBoardPackageIdState] = useState(activeBoard);
    const activeBoardPackageIdRef = useRef(activeBoardPackageId);
    const [availableBoards, setAvailableBoards] = useState<any[]>([]);
    const availableBoardsRef = useRef<any[]>(availableBoards);
    const [boardOptions, setBoardOptionsState] = useState<Record<string, string>>({});
    const boardOptionsRef = useRef(boardOptions);
    const [resolvedBoardOptions, setResolvedBoardOptions] = useState<Record<string, string>>({});
    const resolvedBoardOptionsRef = useRef(resolvedBoardOptions);
    const [displayBoardOptions, setDisplayBoardOptions] = useState<Record<string, string>>({});
    const [boardOptionsStatus, setBoardOptionsStatus] = useState<BoardOptionsStatus>('loading');
    const boardOptionsStatusRef = useRef<BoardOptionsStatus>('loading');
    const boardOptionDefaultsRef = useRef<Record<string, string>>({});
    const boardOptionKeysRef = useRef<Set<string>>(new Set());
    const boardOptionValuesRef = useRef<Map<string, Set<string>>>(new Map());
    const [droppedBoardOptions, setDroppedBoardOptions] = useState<Record<string, string>>({});
    const boardOptionLoadSeqRef = useRef(0);
    const [boardOptionsReloadSeq, setBoardOptionsReloadSeq] = useState(0);

    // Cache for Libraries to prevent redundant scanning
    const libraryCacheRef = useRef<Record<string, any[]>>({});
    const reloadLibSeqRef = useRef(0);

    useEffect(() => {
        activeBoardRef.current = activeBoard;
    }, [activeBoard]);
    useEffect(() => {
        activeBoardPackageIdRef.current = activeBoardPackageId;
    }, [activeBoardPackageId]);
    useEffect(() => {
        availableBoardsRef.current = availableBoards;
    }, [availableBoards]);
    useEffect(() => {
        boardOptionsRef.current = boardOptions;
    }, [boardOptions]);

    useEffect(() => {
        resolvedBoardOptionsRef.current = resolvedBoardOptions;
    }, [resolvedBoardOptions]);

    // Changing boards invalidates every option from the previous board before
    // React renders the new selection. Compilation/warmup stays gated until
    // the new board's option schema has been resolved.
    const setActiveBoard = useCallback((fqbn: string, boardPackageId?: string) => {
        const baseFqbn = baseBoardFqbn(fqbn);
        const inlineOptions = parseBoardFqbnOptions(fqbn);
        const boardChanged = baseFqbn !== activeBoardRef.current;
        const requestedPackageId = String(boardPackageId || '').trim();
        const nextPackageId = requestedPackageId
            || (boardChanged ? baseFqbn : activeBoardPackageIdRef.current || baseFqbn);
        const packageChanged = nextPackageId !== activeBoardPackageIdRef.current;
        if (!boardChanged && !packageChanged && Object.keys(inlineOptions).length === 0) return;
        boardOptionLoadSeqRef.current += 1;
        const cachedSchema = cachedBoardOptionSchema(baseFqbn, nextPackageId);
        const switchState = createBoardOptionSwitchState(cachedSchema, inlineOptions);
        boardOptionsRef.current = switchState.projectOptions;
        resolvedBoardOptionsRef.current = switchState.compileOptions;
        boardOptionDefaultsRef.current = cachedSchema?.defaults || {};
        boardOptionKeysRef.current = cachedSchema?.allowedKeys || new Set();
        boardOptionValuesRef.current = cachedSchema?.allowedValues || new Map();
        boardOptionsStatusRef.current = switchState.status;
        setBoardOptionsState(switchState.projectOptions);
        setDroppedBoardOptions(switchState.dropped);
        setResolvedBoardOptions(switchState.compileOptions);
        setDisplayBoardOptions(switchState.displayOptions);
        setBoardOptionsStatus(switchState.status);
        setActiveBoardState(baseFqbn);
        activeBoardRef.current = baseFqbn;
        activeBoardPackageIdRef.current = nextPackageId;
        setActiveBoardPackageIdState(nextPackageId);
        if (!boardChanged) setBoardOptionsReloadSeq(value => value + 1);
    }, []);

    useEffect(() => {
        if (!activeBoard) return;
        const requestedBoard = activeBoard;
        const requestedPackageId = activeBoardPackageId || requestedBoard;
        const seq = boardOptionLoadSeqRef.current + 1;
        boardOptionLoadSeqRef.current = seq;
        const packageGate = evaluateBoardPackageBuildGate(
            availableBoardsRef.current,
            requestedBoard,
            requestedPackageId,
        );
        if (!packageGate.canBuild) {
            boardOptionDefaultsRef.current = {};
            boardOptionKeysRef.current = new Set();
            boardOptionValuesRef.current = new Map();
            boardOptionsStatusRef.current = 'unverified';
            resolvedBoardOptionsRef.current = {};
            setResolvedBoardOptions({});
            setDisplayBoardOptions({});
            setDroppedBoardOptions({ ...boardOptionsRef.current });
            setBoardOptionsStatus('unverified');
            return;
        }
        const packageConfigOptions = packageConfigOptionsForIdentity(
            availableBoardsRef.current,
            requestedBoard,
            requestedPackageId,
        );
        const cachedSchema = cachedBoardOptionSchema(requestedBoard, requestedPackageId);
        if (cachedSchema) {
            boardOptionDefaultsRef.current = cachedSchema.defaults;
            boardOptionKeysRef.current = cachedSchema.allowedKeys;
            boardOptionValuesRef.current = cachedSchema.allowedValues;
            const resolution = resolveBoardOptionsWithDiagnostics(
                cachedSchema.defaults,
                boardOptionsRef.current,
                cachedSchema.allowedKeys,
                cachedSchema.allowedValues,
            );
            resolvedBoardOptionsRef.current = resolution.explicitOptions;
            setResolvedBoardOptions(resolution.explicitOptions);
            setDisplayBoardOptions(resolution.options);
            setDroppedBoardOptions(resolution.dropped);
            boardOptionsStatusRef.current = 'resolved';
            setBoardOptionsStatus('resolved');
            return;
        }
        boardOptionsStatusRef.current = 'loading';
        setBoardOptionsStatus('loading');
        resolvedBoardOptionsRef.current = {};
        setResolvedBoardOptions({});
        setDisplayBoardOptions({});

        const loadDefaults = async () => {
            try {
                const { defaults, allowedKeys, allowedValues } = await loadBoardOptionSchema(
                    requestedBoard,
                    requestedPackageId,
                    packageConfigOptions,
                );
                if (boardOptionLoadSeqRef.current !== seq
                    || activeBoardRef.current !== requestedBoard
                    || activeBoardPackageIdRef.current !== requestedPackageId) return;
                boardOptionDefaultsRef.current = defaults;
                boardOptionKeysRef.current = allowedKeys;
                boardOptionValuesRef.current = allowedValues;
                const resolution = resolveBoardOptionsWithDiagnostics(
                    defaults,
                    boardOptionsRef.current,
                    allowedKeys,
                    allowedValues,
                );
                resolvedBoardOptionsRef.current = resolution.explicitOptions;
                setResolvedBoardOptions(resolution.explicitOptions);
                setDisplayBoardOptions(resolution.options);
                setDroppedBoardOptions(resolution.dropped);
                boardOptionsStatusRef.current = 'resolved';
                setBoardOptionsStatus('resolved');
            } catch (error) {
                if (boardOptionLoadSeqRef.current !== seq
                    || activeBoardRef.current !== requestedBoard
                    || activeBoardPackageIdRef.current !== requestedPackageId) return;
                // With no trustworthy schema, saved options are retained but
                // never sent blindly. A custom package/Core contract mismatch
                // is always unverified even when the project has no overrides.
                boardOptionDefaultsRef.current = {};
                boardOptionKeysRef.current = new Set();
                boardOptionValuesRef.current = new Map();
                resolvedBoardOptionsRef.current = {};
                setResolvedBoardOptions({});
                setDisplayBoardOptions({});
                setDroppedBoardOptions({ ...boardOptionsRef.current });
                const fallbackStatus = packageConfigOptions !== undefined
                    ? 'unverified'
                    : boardOptionsFallbackStatus(boardOptionsRef.current);
                boardOptionsStatusRef.current = fallbackStatus;
                setBoardOptionsStatus(fallbackStatus);
                console.warn(`[HardwareContext] Board option details unavailable for ${requestedBoard}/${requestedPackageId}`, error);
            }
        };
        void loadDefaults();
    }, [activeBoard, activeBoardPackageId, boardOptionsReloadSeq]);

    // Workspace owns project/config warmup because it has both the complete
    // resolved FQBN and the exact generated sketch. Starting a second
    // board-only warmup here used to race that code-aware request whenever a
    // project was remounted, repeatedly replacing the same ESP32 cache slot.

    const setBoardOption = useCallback((key: string, value: string) => {
        const cleanKey = String(key || '').trim();
        const cleanValue = normalizeBoardOptionValue(value);
        if (!cleanKey || !cleanValue) return;
        const explicit = updateExplicitBoardOption(
            boardOptionsRef.current,
            cleanKey,
            cleanValue,
            boardOptionDefaultsRef.current,
        );
        boardOptionsRef.current = explicit;
        setBoardOptionsState(explicit);
        if (boardOptionsStatusRef.current === 'resolved') {
            const resolution = resolveBoardOptionsWithDiagnostics(
                boardOptionDefaultsRef.current,
                explicit,
                boardOptionKeysRef.current,
                boardOptionValuesRef.current,
            );
            resolvedBoardOptionsRef.current = resolution.explicitOptions;
            setResolvedBoardOptions(resolution.explicitOptions);
            setDisplayBoardOptions(resolution.options);
            setDroppedBoardOptions(resolution.dropped);
        } else if (boardOptionsStatusRef.current === 'core-default' || boardOptionsStatusRef.current === 'unverified') {
            const fallbackStatus = boardOptionsFallbackStatus(explicit);
            boardOptionsStatusRef.current = fallbackStatus;
            setBoardOptionsStatus(fallbackStatus);
            resolvedBoardOptionsRef.current = {};
            setResolvedBoardOptions({});
            setDisplayBoardOptions({});
            setDroppedBoardOptions({ ...explicit });
        }
    }, []);

    const setBoardOptions = useCallback((opts: Record<string, unknown>) => {
        const next = sanitizeBoardOptions(opts);
        boardOptionsRef.current = next;
        setBoardOptionsState(next);
        if (boardOptionsStatusRef.current === 'resolved') {
            const resolution = resolveBoardOptionsWithDiagnostics(
                boardOptionDefaultsRef.current,
                next,
                boardOptionKeysRef.current,
                boardOptionValuesRef.current,
            );
            resolvedBoardOptionsRef.current = resolution.explicitOptions;
            setResolvedBoardOptions(resolution.explicitOptions);
            setDisplayBoardOptions(resolution.options);
            setDroppedBoardOptions(resolution.dropped);
        } else if (boardOptionsStatusRef.current === 'loading') {
            // Keep the pending project values separate; compilation is gated
            // until they can be validated against the new board's schema.
            resolvedBoardOptionsRef.current = {};
            setResolvedBoardOptions({});
            setDisplayBoardOptions({});
            setDroppedBoardOptions({});
        } else {
            const fallbackStatus = boardOptionsFallbackStatus(next);
            boardOptionsStatusRef.current = fallbackStatus;
            setBoardOptionsStatus(fallbackStatus);
            resolvedBoardOptionsRef.current = {};
            setResolvedBoardOptions({});
            setDisplayBoardOptions({});
            setDroppedBoardOptions({ ...next });
        }
    }, []);

    const invalidateCurrentBoardOptionSchema = useCallback(() => {
        // Invalidate the currently running effect synchronously. React state
        // updates below are scheduled, so without this guard an older schema
        // promise could resolve in the gap and publish `resolved` again.
        boardOptionLoadSeqRef.current += 1;
        clearBoardOptionSchemaCache();
        boardOptionsStatusRef.current = 'loading';
        resolvedBoardOptionsRef.current = {};
        setBoardOptionsStatus('loading');
        setResolvedBoardOptions({});
        setDisplayBoardOptions({});
        setDroppedBoardOptions({});
        setBoardOptionsReloadSeq(value => value + 1);
    }, []);

    const scanPorts = useCallback(async (silent = false) => {
        if (!silent) {
            setIsScanning(true);
        }
        let currentList: SerialPortInfo[] = [];
        try {
            // Robust Tauri v2 detection
            const isTauri = typeof window !== 'undefined' &&
                ((window as any).__TAURI_IPC__ || (window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__);

            if (isTauri) {
                const { invoke } = await import('@tauri-apps/api/core');
                currentList = await invoke('list_serial_ports');
                setPorts(currentList);
            } else {
                console.warn("Tauri environment not detected, using mock ports list");
                // Provide mock ports for browser testing
                currentList = [
                    { port_name: 'COM3', description: 'ESP32-C5 (Simulation)' },
                    { port_name: 'COM5', description: 'Arduino Uno (Simulation)' }
                ];
                setPorts(currentList);
            }

            // Auto-disconnect if active port is gone
            if (activePort && !currentList.find((p: any) => p.port_name === activePort)) {
                lastActivePort.current = activePort; // Remember disconnected port
                setActivePort(null);
            }

            // Auto-reconnect if port comes back (and we are not connected)
            if (!activePort && lastActivePort.current) {
                if (currentList.find((p: any) => p.port_name === lastActivePort.current)) {
                    setActivePort(lastActivePort.current);
                }
            }
            return true;
        } catch (e) {
            console.error("Failed to scan ports:", e);
            return false;
        } finally {
            if (!silent) {
                setIsScanning(false);
            }
        }
    }, [activePort]);

    // Initial scan and periodic polling
    useEffect(() => {
        void scanPorts();
        const interval = setInterval(() => {
            if (!document.hidden) {
                void scanPorts(true);
            }
        }, 5000);
        return () => clearInterval(interval);
    }, [scanPorts]);

    const connectDevice = (portName: string) => {
        setActivePort(portName);
    };

    const disconnectDevice = () => {
        setActivePort(null);
        lastActivePort.current = null; // Clear auto-reconnect memory on manual disconnect
    };

    const reloadBoards = async () => {
        try {
            const { BoardManager } = await import('../services/board_manager');
            const all = await BoardManager.getAllBoards();
            availableBoardsRef.current = all;
            setAvailableBoards(all);
            invalidateCurrentBoardOptionSchema();
        } catch (e) {
            console.error("Failed to reload boards", e);
        }
    };

    // Library Logic
    const [availableLibraries, setAvailableLibraries] = useState<any[]>([]);

    const reloadLibraries = async (board?: string, boardPackageId?: string) => {
        const boardToUse = board || activeBoard;
        const packageToUse = String(
            boardPackageId
            || (baseBoardFqbn(boardToUse) === activeBoard ? activeBoardPackageId : ''),
        ).trim();
        const cacheKey = `${boardToUse}::${packageToUse}`;
        const seq = ++reloadLibSeqRef.current;
        try {
            // New Backend API
            const { invoke } = await import('@tauri-apps/api/core');
            const libs: any[] = await invoke('get_all_libraries', {
                board: boardToUse,
                boardPackageId: packageToUse || null,
            });
            // Discard stale result if a newer reload was triggered
            // Update Cache
            libraryCacheRef.current[cacheKey] = libs;
            if (reloadLibSeqRef.current !== seq
                || baseBoardFqbn(boardToUse) !== activeBoardRef.current
                || packageToUse !== activeBoardPackageIdRef.current) return;
            setAvailableLibraries(libs);
        } catch (e) {
            console.error("Failed to reload libraries", e);
        }
    };

    // Installed Cores State (Centralized)
    const [installedCores, setInstalledCores] = useState<string[]>([]);
    const [installedCoreVersions, setInstalledCoreVersions] = useState<Record<string, string>>({});
    const installedCoreSignatureRef = useRef('');

    const applyInstalledCores = useCallback((cores: any[]) => {
        setInstalledCores(cores.map((core) => String(core?.id || '')).filter(Boolean));
        const versions: Record<string, string> = {};
        for (const core of cores) {
            const id = String(core?.id || '').trim();
            const version = String(core?.installed || '').trim();
            if (id && version) versions[id] = version;
        }
        setInstalledCoreVersions(versions);
        const signature = Object.entries(versions)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([id, version]) => `${id}@${version}`)
            .join('|');
        const changed = installedCoreSignatureRef.current === ''
            ? BOARD_OPTION_SCHEMA_CACHE.size > 0
            : installedCoreSignatureRef.current !== signature;
        installedCoreSignatureRef.current = signature;
        return changed;
    }, []);

    const refreshInstalledCores = useCallback(async (
        options: { invalidateBoardSchemas?: boolean } = {},
    ) => {
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            const cores: any[] = await invoke('get_installed_cores');
            const versionsChanged = applyInstalledCores(cores);
            // Known install/uninstall/repair callers explicitly invalidate so
            // a same-version replacement of boards.txt is picked up. Routine
            // selector refreshes retain the per-FQBN cache and avoid a 4-6s
            // board-details reload.
            if (versionsChanged || options.invalidateBoardSchemas === true) {
                invalidateCurrentBoardOptionSchema();
            }
        } catch (e) {
            console.error("Failed to refresh installed cores", e);
        }
    }, [applyInstalledCores, invalidateCurrentBoardOptionSchema]);

    useEffect(() => {
        const initBoards = async () => {
            try {
                // Dynamic import to avoid SSR/Initial load issues if FS not ready
                const { BoardManager } = await import('../services/board_manager');
                await BoardManager.init();
                const all = await BoardManager.getAllBoards();
                availableBoardsRef.current = all;
                setAvailableBoards(all);
                invalidateCurrentBoardOptionSchema();

                // The active-board effect below owns library loading. Keeping a
                // second default-board request here allowed its late response to
                // overwrite libraries after a user selected another package.
                const { invoke } = await import('@tauri-apps/api/core');

                // Initial core list fetch
                try {
                    const cores: any[] = await invoke('get_installed_cores');
                    applyInstalledCores(cores);
                } catch (e) { console.error("Initial core fetch failed", e); }
            } catch (e) {
                console.error("Failed to load boards/libraries", e);
            }
        };
        initBoards();
    }, [applyInstalledCores, invalidateCurrentBoardOptionSchema]);

    // Reload libraries whenever activeBoard changes
    useEffect(() => {
        const loadLibsForBoard = async () => {
            const cacheKey = `${activeBoard}::${activeBoardPackageId}`;
            // Every identity change revokes older automatic *and* explicit
            // reloads, including when this package is already cached.
            const seq = ++reloadLibSeqRef.current;
            // 1. Check Cache
            if (libraryCacheRef.current[cacheKey]) {
                console.log(`[HardwareContext] Library Cache HIT for ${activeBoard} (${activeBoardPackageId})`);
                setAvailableLibraries(libraryCacheRef.current[cacheKey]);
                return;
            }

            // Never expose the previous package's board-scoped libraries while
            // the exact package request is in flight (especially when two
            // custom boards share one compiler FQBN).
            setAvailableLibraries([]);

            // 2. Scan if Miss (single source of truth: backend get_all_libraries)
            try {
                const { invoke } = await import('@tauri-apps/api/core');
                const libs: any[] = await invoke('get_all_libraries', {
                    board: activeBoard,
                    boardPackageId: activeBoardPackageId,
                });

                // 3. Save to Cache
                libraryCacheRef.current[cacheKey] = libs;
                if (reloadLibSeqRef.current !== seq
                    || activeBoardRef.current !== activeBoard
                    || activeBoardPackageIdRef.current !== activeBoardPackageId) return;
                setAvailableLibraries(libs);
                console.log(`[HardwareContext] Reloaded ${libs.length} libraries for board: ${activeBoard} (${activeBoardPackageId})`);
            } catch (e) {
                if (reloadLibSeqRef.current !== seq) return;
                console.error("Failed to reload libraries for board", activeBoard, e);
            }
        };
        // Only reload if activeBoard is set and not the initial default (avoid double load on mount)
        if (activeBoard) {
            loadLibsForBoard();
        }
    }, [activeBoard, activeBoardPackageId]);

    return (
        <HardwareContext.Provider value={{
            ports,
            activePort,
            isScanning,
            activeBoard,
            activeBoardPackageId,
            setActiveBoard,
            boardOptions,
            resolvedBoardOptions,
            displayBoardOptions,
            boardOptionsStatus,
            droppedBoardOptions,
            setBoardOption,
            setBoardOptions,
            connectDevice,
            disconnectDevice,
            scanPorts,
            availableBoards,
            reloadBoards,
            availableLibraries,
            reloadLibraries,
            installedCores,
            installedCoreVersions,
            refreshInstalledCores
        }}>
            {children}
        </HardwareContext.Provider>
    );
};

export const useHardware = () => {
    const context = useContext(HardwareContext);
    if (!context) {
        throw new Error("useHardware must be used within a HardwareProvider");
    }
    return context;
};
