import { exists, mkdir } from '@tauri-apps/plugin-fs';
import { appDataDir, join } from '@tauri-apps/api/path';
import { ArduinoCoreConfig, BoardPackage, BoardPassport, PinConfig } from '../types/board';
import { BOARDS as INTERNAL_BOARDS } from '../constants/boards';
import { BOARDS as LEGACY_BOARDS } from '../config/boards';
import { normalizePinCodeToken } from './pin_code_token';
import { validateResourceGraph } from './resource_contract';

const CUSTOM_DIR_NAME = 'CK'; // Parent folder
const BOARDS_DIR_NAME = 'boards';

type UnknownRecord = Record<string, any>;

const textValue = (...values: unknown[]): string => {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
};

const stringList = (candidate: unknown): string[] | undefined => {
    if (!Array.isArray(candidate)) return undefined;
    const seen = new Set<string>();
    const result: string[] = [];
    for (const item of candidate) {
        const value = textValue(item);
        if (!value || seen.has(value)) continue;
        seen.add(value);
        result.push(value);
    }
    return result.length > 0 ? result : undefined;
};

const stringOrStringList = (...candidates: unknown[]): string | string[] | undefined => {
    for (const candidate of candidates) {
        const text = textValue(candidate);
        if (text) return text;
        const values = stringList(candidate);
        if (values) return values;
    }
    return undefined;
};

const normalizePinRisks = (candidate: unknown): PinConfig['risks'] => {
    if (!Array.isArray(candidate)) return undefined;
    const severities = new Set(['blocker', 'warning', 'notice']);
    const result: NonNullable<PinConfig['risks']> = [];
    for (const item of candidate) {
        if (!item || typeof item !== 'object') continue;
        const raw = item as UnknownRecord;
        const code = textValue(raw.code);
        const severity = textValue(raw.severity);
        const title = textValue(raw.title);
        if (!code || !severities.has(severity) || !title) continue;
        const rawOptions = raw.when && typeof raw.when === 'object'
            ? (raw.when as UnknownRecord).options
            : undefined;
        const rawFeatures = raw.when && typeof raw.when === 'object'
            ? (raw.when as UnknownRecord).features
            : undefined;
        let options: Record<string, string | string[]> | undefined;
        if (rawOptions && typeof rawOptions === 'object' && !Array.isArray(rawOptions)) {
            const normalizedOptions: Record<string, string | string[]> = {};
            for (const [key, value] of Object.entries(rawOptions as UnknownRecord)) {
                const menu = textValue(key);
                if (!menu) continue;
                if (typeof value === 'string' && value.trim()) {
                    normalizedOptions[menu] = value.trim();
                    continue;
                }
                const values = stringList(value);
                if (values) normalizedOptions[menu] = values;
            }
            if (Object.keys(normalizedOptions).length > 0) options = normalizedOptions;
        }
        const features = stringList(rawFeatures);
        result.push({
            code,
            severity: severity as NonNullable<PinConfig['risks']>[number]['severity'],
            title,
            detail: textValue(raw.detail) || undefined,
            roles: stringList(raw.roles),
            when: options || features
                ? {
                    ...(options && Object.keys(options).length > 0 ? { options } : {}),
                    ...(features ? { features } : {}),
                }
                : undefined,
        });
    }
    return result.length > 0 ? result : undefined;
};

const normalizePinEvidence = (candidate: unknown): PinConfig['evidence'] => {
    if (!Array.isArray(candidate)) return undefined;
    const kinds = new Set(['datasheet', 'schematic', 'board-definition', 'publisher-test', 'other']);
    const result: NonNullable<PinConfig['evidence']> = [];
    for (const item of candidate) {
        if (!item || typeof item !== 'object') continue;
        const raw = item as UnknownRecord;
        const kind = textValue(raw.kind);
        const reference = textValue(raw.reference);
        if (!kinds.has(kind) || !reference) continue;
        result.push({
            kind: kind as NonNullable<PinConfig['evidence']>[number]['kind'],
            reference,
            locator: textValue(raw.locator) || undefined,
            sha256: textValue(raw.sha256) || undefined,
        });
    }
    return result.length > 0 ? result : undefined;
};

const normalizePins = (value: unknown): PinConfig[] => {
    if (!Array.isArray(value)) return [];
    return value.flatMap((pin): PinConfig[] => {
        if (Array.isArray(pin) && pin.length >= 2) {
            const label = textValue(pin[0]);
            const value = normalizePinCodeToken(pin[1]);
            return label && value ? [{ label, value }] : [];
        }
        if (!pin || typeof pin !== 'object') return [];
        const entry = pin as UnknownRecord;
        const label = textValue(entry.label, entry.name, entry.display_name, entry.displayName);
        const rawPinValue = [entry.value, entry.pin, entry.id].find(candidate => (
            (typeof candidate === 'string' && candidate.trim().length > 0)
            || typeof candidate === 'number'
        ));
        const pinValue = normalizePinCodeToken(rawPinValue);
        if (!label || !pinValue) return [];
        const sharing = textValue(entry.sharing);
        const connectorRaw = entry.connector && typeof entry.connector === 'object'
            ? entry.connector as UnknownRecord
            : undefined;
        const connectorId = textValue(connectorRaw?.id);
        const connectorSide = textValue(connectorRaw?.side);
        const connectorPosition = typeof connectorRaw?.position === 'number' && Number.isFinite(connectorRaw.position)
            ? connectorRaw.position
            : undefined;
        const connector = connectorId ? {
            id: connectorId,
            side: ['left', 'right', 'top', 'bottom'].includes(connectorSide)
                ? connectorSide as NonNullable<PinConfig['connector']>['side']
                : undefined,
            position: connectorPosition,
        } : undefined;
        return [{
            label,
            value: pinValue,
            aliases: stringList(entry.aliases),
            capabilities: stringList(entry.capabilities),
            risks: normalizePinRisks(entry.risks),
            // The package contract accepts either the legacy single owner or a
            // list of independently reserved board resources. Keep the list
            // intact so pin preflight can report every declared reservation.
            reserved_by: stringOrStringList(entry.reserved_by, entry.reservedBy),
            sharing: ['exclusive', 'shared', 'board-defined'].includes(sharing)
                ? sharing as PinConfig['sharing']
                : undefined,
            connector,
            source: textValue(entry.source) || undefined,
            evidence: normalizePinEvidence(entry.evidence),
        }];
    });
};

const normalizeCore = (value: unknown): ArduinoCoreConfig | undefined => {
    if (!value || typeof value !== 'object') return undefined;
    const raw = value as UnknownRecord;
    const packageId = textValue(raw.package, raw.id);
    if (!packageId) return undefined;
    const versionRangeRaw = (raw.version_range ?? raw.versionRange) as UnknownRecord | undefined;
    const versionRange = versionRangeRaw && typeof versionRangeRaw === 'object'
        ? {
            minimum: textValue(versionRangeRaw.minimum, versionRangeRaw.min) || undefined,
            maximum_exclusive: textValue(versionRangeRaw.maximum_exclusive, versionRangeRaw.maximumExclusive) || undefined,
        }
        : undefined;
    const knownIncompatible = Array.isArray(raw.known_incompatible ?? raw.knownIncompatible)
        ? (raw.known_incompatible ?? raw.knownIncompatible) as ArduinoCoreConfig['known_incompatible']
        : undefined;
    return {
        package: packageId,
        version: textValue(raw.version, raw.recommended_version, raw.recommendedVersion) || undefined,
        recommended_version: textValue(raw.recommended_version, raw.recommendedVersion) || undefined,
        min_version: textValue(raw.min_version, raw.minVersion, raw.minimum_version) || undefined,
        max_tested_version: textValue(raw.max_tested_version, raw.maxTestedVersion) || undefined,
        compatible_versions: stringList(raw.compatible_versions ?? raw.compatibleVersions),
        known_incompatible_versions: stringList(raw.known_incompatible_versions ?? raw.knownIncompatibleVersions),
        version_range: versionRange,
        tested_versions: stringList(raw.tested_versions ?? raw.testedVersions),
        known_incompatible: knownIncompatible,
        index_url: textValue(raw.index_url, raw.indexUrl) || undefined,
        platform_index_url: textValue(raw.platform_index_url, raw.platformIndexUrl) || undefined,
    };
};

/** Normalize both the legacy and board-passport backend response shapes. */
export const normalizeUserBoard = (rawBoard: unknown): BoardPackage => {
    const b = (rawBoard && typeof rawBoard === 'object' ? rawBoard : {}) as UnknownRecord;
    const manifest = (b.manifest && typeof b.manifest === 'object' ? b.manifest : {}) as UnknownRecord;
    const fqbnBase = textValue(
        b.fqbn_base,
        b.fqbnBase,
        b.fqbn,
        manifest.fqbn_base,
        manifest.fqbnBase,
    );
    const vendor = textValue(b.vendor, manifest.vendor, b.author, manifest.author);
    const author = textValue(b.author, manifest.author, vendor);
    const packagePath = textValue(b.dir_path, b.dirPath, b.package_path, b.packagePath, b.path);
    const assetsPath = textValue(b.assets_path, b.assetsPath, b.asset_path, b.assetPath, b.path, packagePath);
    const core = normalizeCore(b.arduino_core ?? b.arduinoCore ?? manifest.arduino_core ?? manifest.arduinoCore);
    const passport = (b.passport ?? b.board_passport ?? b.boardPassport ?? b.verification_report) as BoardPassport | undefined;

    return {
        id: textValue(b.id, manifest.id),
        name: textValue(b.name, manifest.name) || '未命名开发板',
        version: textValue(b.version, manifest.version),
        vendor: vendor || undefined,
        author: author || undefined,
        fqbn: fqbnBase,
        fqbn_base: fqbnBase,
        description: textValue(b.description, manifest.description) || undefined,
        icon: textValue(b.icon, manifest.icon) || undefined,
        dir_path: packagePath || undefined,
        assets_path: assetsPath || undefined,
        // Workspace resolves custom relative assets through this legacy alias.
        path: assetsPath || packagePath || undefined,
        is_custom: true,
        pins: normalizePins(b.pins ?? manifest.pins),
        resource_graph: b.resource_graph !== undefined || manifest.resource_graph !== undefined
            ? validateResourceGraph(b.resource_graph !== undefined ? b.resource_graph : manifest.resource_graph) : undefined,
        arduino_core: core,
        isolate_toolbox: Boolean(b.isolate_toolbox ?? b.isolateToolbox ?? manifest.isolate_toolbox),
        config_options: b.config_options ?? b.configOptions ?? manifest.config_options,
        quality_report: b.quality_report ?? b.qualityReport,
        core_status: b.core_status ?? b.coreStatus,
        passport,
        ck_lock: b.ck_lock ?? b.ckLock ?? passport?.ck_lock ?? passport?.lock,
        usable: typeof b.usable === 'boolean' ? b.usable : undefined,
        availability_error: textValue(b.availability_error, b.availabilityError, b.unusable_reason) || undefined,
        manifest: Object.keys(manifest).length > 0 ? manifest : undefined,
    };
};

export class BoardManager {
    /**
     * Get the absolute path to the user's custom boards directory.
     * usually: C:\Users\User\AppData\Roaming\CK\boards
     */
    static async getBoardsRootPath(): Promise<string> {
        const appData = await appDataDir();
        return await join(appData, CUSTOM_DIR_NAME, BOARDS_DIR_NAME);
    }

    /**
     * Ensure the directory exists.
     */
    static async init(): Promise<void> {
        const path = await this.getBoardsRootPath();
        try {
            if (!(await exists(path))) {
                await mkdir(path, { recursive: true });
                console.log('Created custom boards directory:', path);
            }
        } catch (e) {
            console.error('Failed to initialize boards directory:', e);
        }
    }

    /**
     * Load all custom boards from the user directory.
     */
    static async loadUserBoards(): Promise<BoardPackage[]> {
        const packages: BoardPackage[] = [];
        try {
            // Robust Tauri detection
            const isTauri = typeof window !== 'undefined' &&
                ((window as any).__TAURI_IPC__ || (window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__);

            if (isTauri) {
                const { invoke } = await import('@tauri-apps/api/core');
                const boards: any[] = await invoke('get_custom_boards_v2');

                for (const board of boards) packages.push(normalizeUserBoard(board));
            }
        } catch (e) {
            console.error('[BoardManager] Error loading user boards from backend', e);
        }
        return packages;
    }

    /**
     * Get built-in boards mapped to the new Package format.
     */
    static getSystemBoards(): BoardPackage[] {
        return INTERNAL_BOARDS.map(b => {
            let coreConfig: any = undefined;
            if (b.id.startsWith("arduino:avr")) {
                coreConfig = { package: "arduino:avr" };
            } else if (b.id.startsWith("esp32:esp32")) {
                coreConfig = {
                    package: "esp32:esp32",
                    index_url: "https://espressif.github.io/arduino-esp32/package_esp32_index.json"
                };
            }

            // Lookup pins from legacy config to ensure pin dropdowns work
            const legacy = LEGACY_BOARDS.find(lb => lb.fqbn === b.id);
            const pins = legacy ? legacy.pins : [];

            return {
                id: b.id, // Fallback ID
                name: b.name,
                version: "",
                vendor: "CK",
                fqbn: b.id,
                fqbn_base: b.id,
                pins: pins,
                author: "CK",
                description: b.description || "系统内置板卡",
                extensions: {},
                icon: b.icon,
                arduino_core: coreConfig
            };
        });
    }

    /**
     * Merge System and User boards
     */
    static async getAllBoards(): Promise<BoardPackage[]> {
        const system = this.getSystemBoards();
        const user = await this.loadUserBoards();
        return [...system, ...user];
    }
    /**
     * Delete a custom board package.
     */
    static async deleteBoard(boardId: string): Promise<string> {
        try {
            // Robust Tauri detection
            const isTauri = typeof window !== 'undefined' &&
                ((window as any).__TAURI_IPC__ || (window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__);

            if (isTauri) {
                const { invoke } = await import('@tauri-apps/api/core');
                console.log(`[BoardManager] Deleting board: ${boardId}`);
                // Call backend command
                // Backend expects 'boardId' (camelCase) based on error message "missing required key boardId"
                const result = await invoke<string>('uninstall_board', { boardId });
                return typeof result === 'string' ? result : String(result ?? '');
            }
            return "Not running in Tauri";
        } catch (e: any) {
            console.error('Failed to delete board:', e);
            throw new Error(e.toString());
        }
    }
}
