export interface LibraryManifest {
    name: string;
    version: string;
    author?: string;
    maintainer?: string;
    sentence?: string;
    paragraph?: string;
    website?: string;
    category?: string;
    architectures?: string[];
    includes?: string[];
    id?: string;
    hardware_validation?: LibraryHardwareValidation;
}

export type LibraryHardwareValidationLevel = 'compile' | 'upload' | 'runtime';

export interface LibraryHardwareValidationTarget {
    /** Complete compiler target identity, including board menu options when used. */
    fqbn: string;
    board_name?: string;
    core_version?: string;
    levels: LibraryHardwareValidationLevel[];
    tested_at: string;
    ck_version?: string;
    example?: string;
    notes?: string;
}

export interface LibraryHardwareValidation {
    /** Author-provided declarations. They are presentation evidence, not CK certification. */
    tested_targets: LibraryHardwareValidationTarget[];
}

export interface BlockPackageManifest {
    schema_version: 1 | 2;
    id: string;
    /** Presentation-only default for the package locale extension. */
    defaultLocale?: string;
    display_name?: string;
    description?: string;
    keywords?: string[];
    license?: BlockPackageLicense;
    compatibility?: BlockPackageCompatibility;
    dependencies?: BlockDependency[];
    entrypoints?: BlockPackageEntrypoints;
    blocks?: BlockManifestEntry[];
}

export interface BlockPackageLicense {
    spdx_id: string;
    file: string;
}

export interface BlockPackageCompatibility {
    boards?: string[];
    architectures?: string[];
}

export interface BlockPackageEntrypoints {
    blocks?: string;
    generator?: string;
    toolbox?: string;
}

export type BlockManifestKind = 'statement' | 'value' | 'hat' | 'terminal';

export interface BlockManifestField {
    name: string;
    kind?: string;
    description?: string;
    required?: boolean;
    default?: unknown;
    options?: Array<{ label: string; value: string }>;
}

export interface BlockManifestInput {
    name: string;
    kind?: 'value' | 'statement';
    description?: string;
    required?: boolean;
    check?: string | string[];
    default?: unknown;
}

export interface BlockSemantics {
    purpose: string;
    behavior: string;
    side_effects?: string[];
    concepts?: string[];
}

export type BlockDependencyKind =
    | 'arduino-library'
    | 'core'
    | 'header'
    | 'tool'
    | 'capability';

export interface BlockDependency {
    kind: BlockDependencyKind;
    id: string;
    version?: string;
    headers?: string[];
    optional?: boolean;
    reason?: string;
    license?: string;
}

export interface BlockOutputContract {
    connection: 'none' | 'value';
    types: string[];
    description?: string;
    unit?: string;
    nullable?: boolean;
}

export type BlockHardwareResourceKind =
    | 'gpio'
    | 'adc'
    | 'pwm'
    | 'i2c'
    | 'spi'
    | 'uart'
    | 'timer'
    | 'interrupt'
    | 'network'
    | 'filesystem'
    | 'flash'
    | 'ram'
    | 'other';

export interface BlockHardwareResourceSource {
    kind: 'field' | 'input' | 'fixed' | 'board-default';
    name?: string;
    value?: string | number;
}

export interface BlockHardwareResource {
    kind: BlockHardwareResourceKind;
    id?: string;
    source?: BlockHardwareResourceSource;
    access?: 'read' | 'write' | 'read-write' | 'reserve';
    sharing?: 'exclusive' | 'shared' | 'board-defined';
    quantity?: number;
    capabilities?: string[];
    description: string;
}

export interface BlockHardwareMetadata {
    claims?: import('../services/resource_contract').ResourceClaimDeclaration;
    resources: BlockHardwareResource[];
    boards?: string[];
    architectures?: string[];
    notes?: string[];
}

export interface BlockGenerationEmission {
    section: 'include' | 'global' | 'setup' | 'loop' | 'statement' | 'expression';
    description: string;
    template?: string;
}

export interface BlockGenerationMetadata {
    language: 'arduino-cpp';
    shape: 'statement' | 'expression' | 'event';
    deterministic: boolean;
    includes?: string[];
    calls?: string[];
    emissions: BlockGenerationEmission[];
    notes?: string[];
}

export interface BlockConstraintCheck {
    target: string;
    operator:
        | 'equals'
        | 'not-equals'
        | 'one-of'
        | 'range'
        | 'matches'
        | 'requires'
        | 'conflicts-with'
        | 'board-capability';
    value?: unknown;
}

export interface BlockConstraint {
    id: string;
    severity: 'info' | 'warning' | 'error';
    description: string;
    check?: BlockConstraintCheck;
    message: string;
    recovery?: string;
}

export interface BlockExample {
    id: string;
    title: string;
    description: string;
    field_values?: Record<string, unknown>;
    input_values?: Record<string, unknown>;
    project?: string;
    generated_code?: string;
    expected_code_contains?: string[];
    expected_behavior: string;
    boards?: string[];
}

export interface BlockErrorMetadata {
    code: string;
    severity: 'info' | 'warning' | 'error';
    message: string;
    cause: string;
    recovery: string;
}

export interface BlockManifestEntry {
    type: string;
    display_name: string;
    description: string;
    category?: string;
    kind?: BlockManifestKind;
    keywords?: string[];
    fields?: BlockManifestField[];
    inputs?: BlockManifestInput[];
    semantics?: BlockSemantics;
    output?: string | string[] | BlockOutputContract | null;
    requires?: string[];
    dependencies?: BlockDependency[];
    hardware?: BlockHardwareMetadata;
    generation?: BlockGenerationMetadata;
    constraints?: BlockConstraint[];
    examples?: Array<string | BlockExample>;
    errors?: BlockErrorMetadata[];
}

export type BlockMetadataSection =
    | 'semantics'
    | 'dependencies'
    | 'output'
    | 'hardware'
    | 'generation'
    | 'constraints'
    | 'examples'
    | 'errors';

export interface BlockSearchEntry {
    type: string;
    /** Runtime catalog identity for a toolbox category; never a translated label. */
    category_id?: string;
    category?: string;
    display_name?: string;
    description?: string;
    kind?: BlockManifestKind;
    keywords: string[];
    fields?: BlockManifestField[];
    inputs?: BlockManifestInput[];
    output?: string | string[] | BlockOutputContract | null;
    requires?: string[];
    metadata_schema_version?: 1 | 2;
    metadata_source?: 'v1-adapted' | 'v2';
    metadata_completeness?: BlockMetadataSection[];
    semantics?: BlockSemantics;
    dependencies?: BlockDependency[];
    output_contract?: BlockOutputContract;
    hardware?: BlockHardwareMetadata;
    generation?: BlockGenerationMetadata;
    constraints?: BlockConstraint[];
    examples?: BlockExample[];
    errors?: BlockErrorMetadata[];
    package_license?: BlockPackageLicense;
    xml_template?: string;
    library_id?: string;
    source: 'manifest' | 'toolbox';
}

export interface LibraryDiagnostic {
    code:
        | 'legacy-layout'
        | 'missing-blocks'
        | 'missing-generator'
        | 'missing-toolbox'
        | 'invalid-manifest'
        | 'unsafe-entrypoint'
        | 'id-mismatch'
        | 'missing-block-catalog'
        | 'invalid-locale'
        | 'invalid-hardware-validation'
        | 'duplicate-block-type'
        | 'untrusted-executable-disabled'
        | 'runtime-approval-required';
    message: string;
    severity: 'info' | 'warning' | 'error';
}

export interface ResolvedBlockEntrypoints {
    blocks?: string;
    generator?: string;
    toolbox?: string;
}

export interface LibraryExtensions {
    blocks_code?: string;
    generator_code?: string;
    toolbox_category?: string;
}

export interface LibraryInfo {
    id: string;
    entry_key: string;
    folder_name: string;
    name: string;
    version: string;
    path: string;
    location: "Bundled" | "BoardPackage" | "Board" | "Arch" | "Global";
    scope_detail?: string | null;
    manifest?: LibraryManifest;
    assets_path?: string;
    extensions?: LibraryExtensions;
    block_manifest?: BlockPackageManifest;
    /** Presentation-only package locale bundle; never used for package identity. */
    block_locale_bundle?: import('../services/block_package_locale').BlockPackageLocaleBundle;
    block_search_entries?: BlockSearchEntry[];
    block_entrypoints?: ResolvedBlockEntrypoints;
    diagnostics?: LibraryDiagnostic[];
    has_blocks?: boolean;
    has_toolbox?: boolean;
    has_generator?: boolean;
    user_installed?: boolean;
    quality_report?: import('./packageQuality').PackageQualityReport;
    runtime_activation?: BlockRuntimeActivation;
}

export type BlockRuntimeActivationState =
    | 'not-applicable'
    | 'declarative-safe'
    | 'quality-blocked'
    | 'legacy-disabled'
    | 'approval-required'
    | 'approved'
    | 'ck-allowlisted';

export interface BlockRuntimeActivation {
    state: BlockRuntimeActivationState;
    executablePresent: boolean;
    packageId: string;
    contentSha256?: string | null;
    approvedAt?: string | null;
    reason: string;
}

export interface LibraryPackage extends LibraryInfo {
    dir_path?: string;
    icon?: string;
}
