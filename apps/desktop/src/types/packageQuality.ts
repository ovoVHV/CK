export type QualityCheckStatus = 'passed' | 'warning' | 'error';
export type PackageQualityStatus = 'pending' | 'passed' | 'passed_with_warnings' | 'failed';

export interface QualityCheck {
    code: string;
    status: QualityCheckStatus;
    message: string;
}

export interface PackageQualityReport {
    schema_version: 1 | 2;
    package_kind: 'board' | 'block-library' | 'arduino-library' | string;
    package_id?: string | null;
    status: PackageQualityStatus;
    source_content_sha256?: string | null;
    error_count: number;
    warning_count: number;
    checks: QualityCheck[];
    /** Optional v2 provenance. Absence means a legacy local static report. */
    validator_id?: string | null;
    validator_version?: string | null;
    ruleset_version?: string | null;
    generated_at?: string | null;
    contract_sha256?: string | null;
    certification_level?: 'local-static' | 'publisher-signed' | 'ck-verified' | string | null;
    validated_consumers?: string[];
}
