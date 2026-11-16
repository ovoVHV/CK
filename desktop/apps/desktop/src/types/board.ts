import type { BoardResourceGraph } from '../services/hardware_resource_graph';
export type BoardPinRiskSeverity = 'blocker' | 'warning' | 'notice';
export type BoardPinSharing = 'exclusive' | 'shared' | 'board-defined';
export type BoardPinEvidenceKind =
    | 'datasheet'
    | 'schematic'
    | 'board-definition'
    | 'publisher-test'
    | 'other';

export interface BoardPinRiskCondition {
    /**
     * The risk applies when each named Arduino menu has one of these values.
     * Import validation resolves every key/value against custom_menus.
     */
    options?: Record<string, string | string[]>;
    /**
     * The risk applies when every named project feature is present.  Built-in
     * feature IDs are derived from registered blocks (for example `wifi`).
     * Package authors may use this only with a documented runtime feature.
     */
    features?: string[];
}

export interface BoardPinRisk {
    code: string;
    severity: BoardPinRiskSeverity;
    title: string;
    detail?: string;
    roles?: string[];
    when?: BoardPinRiskCondition;
}

export interface BoardPinConnector {
    id: string;
    side?: 'left' | 'right' | 'top' | 'bottom';
    position?: number;
}

export interface BoardPinEvidence {
    kind: BoardPinEvidenceKind;
    reference: string;
    locator?: string;
    sha256?: string;
}

/**
 * A board pin remains backward compatible with the legacy label/value pair.
 * Optional detail is publisher-declared evidence consumed only after package
 * quality validation; consumers must not infer missing capabilities or risks.
 */
export interface PinConfig {
    label: string;
    value: string;
    aliases?: string[];
    capabilities?: string[];
    risks?: BoardPinRisk[];
    /** One or more board resources that reserve this pin. */
    reserved_by?: string | string[];
    sharing?: BoardPinSharing;
    connector?: BoardPinConnector;
    source?: string;
    evidence?: BoardPinEvidence[];
}

export interface CoreDependency {
    index_url: string;
    package: string;
    version?: string;
}

export interface BoardExtensions {
    toolbox_category?: string; // XML content
    blocks_code?: string;     // JS content
    generator_code?: string;  // JS content
}

export interface BoardOptionValue {
    value: string;
    value_label: string;
    selected?: boolean;
}

export interface BoardOption {
    option: string;
    option_label: string;
    values: BoardOptionValue[];
}

export interface ArduinoCoreConfig {
    index_url?: string;
    platform_index_url?: string; // For 3rd party cores
    package: string;
    /** Recommended / last verified version, not a mandatory exact pin. */
    version?: string;
    recommended_version?: string;
    min_version?: string;
    max_tested_version?: string;
    compatible_versions?: string[];
    known_incompatible_versions?: string[];
    version_range?: {
        minimum?: string;
        maximum_exclusive?: string;
    };
    tested_versions?: string[];
    known_incompatible?: Array<{
        version?: string;
        version_range?: {
            minimum?: string;
            maximum_exclusive?: string;
        };
        reason?: string;
    }>;
}

export type BoardPassportStatus =
    | 'passed'
    | 'warning'
    | 'failed'
    | 'pending'
    | 'ready'
    | 'verified'
    | 'stale'
    | 'expired'
    | 'not_run'
    | 'not_verified'
    | string;

export interface BoardPassportCheck {
    status?: BoardPassportStatus;
    message?: string;
    reason?: string;
    checked_at?: string;
    evidence?: unknown;
    actions?: Array<string | { label?: string; message?: string; action?: string }>;
    [key: string]: unknown;
}

export interface BoardPassportLock {
    status?: BoardPassportStatus;
    verified_core_version?: string;
    core_version?: string;
    package_sha256?: string;
    reason?: string;
    [key: string]: unknown;
}

/**
 * Optional board-passport data returned by newer backends.  Fields stay
 * permissive so an older desktop can still load a package while the passport
 * schema evolves.
 */
export interface BoardPassport {
    schema_version?: number;
    /** Compiler/evidence contract used to produce local certification; absent on legacy locks. */
    certification_engine_contract?: string;
    structure?: BoardPassportCheck | BoardPassportStatus | boolean;
    structure_check?: BoardPassportCheck | BoardPassportStatus | boolean;
    environment?: BoardPassportCheck | BoardPassportStatus | boolean;
    environment_ready?: BoardPassportCheck | BoardPassportStatus | boolean;
    compile?: BoardPassportCheck | BoardPassportStatus | boolean;
    local_compile?: BoardPassportCheck | BoardPassportStatus | boolean;
    device?: BoardPassportCheck | BoardPassportStatus | boolean;
    device_verification?: BoardPassportCheck | BoardPassportStatus | boolean;
    ck_lock?: BoardPassportLock;
    lock?: BoardPassportLock;
    can_create_project?: boolean;
    usable?: boolean;
    blocked_reason?: string;
    actions?: Array<string | { label?: string; message?: string; action?: string }>;
    certification_status?: string;
    invalidated_reasons?: string[];
    core?: BoardPassportCheck & {
        usable?: boolean;
        requires_revalidation?: boolean;
        installed_version?: string;
        recommended_version?: string;
    };
    core_requirement?: Record<string, unknown>;
    profiles?: Array<{
        id?: string;
        name?: string;
        fqbn?: string;
        status?: string;
        checked_at?: string;
        core_version?: string;
        evidence?: unknown;
    }>;
    [key: string]: unknown;
}

export interface BoardPackage {
    id: string; // Unique ID (folder name or FQBN)
    name: string;
    version: string;
    vendor?: string;
    fqbn: string;
    /** Arduino CLI target without menu options. */
    fqbn_base: string;
    description?: string;
    author?: string;
    pins: PinConfig[];
    extensions?: BoardExtensions;
    // Runtime Paths (Populated by System)
    path?: string;       // Legacy alias used by some UI flows
    dir_path?: string;   // Absolute path to the board package directory
    assets_path?: string;// Absolute path to assets
    arduino_core?: ArduinoCoreConfig;
    is_custom?: boolean;
    icon?: string;
    isolate_toolbox?: boolean;
    config_options?: any[];
    quality_report?: import('./packageQuality').PackageQualityReport;
    /** Backend compatibility result for the currently installed core. */
    core_status?: BoardPassportCheck | BoardPassportStatus | boolean;
    passport?: BoardPassport;
    ck_lock?: BoardPassportLock;
    usable?: boolean;
    availability_error?: string;
    manifest?: Record<string, unknown>;
    resource_graph?: BoardResourceGraph;
}
