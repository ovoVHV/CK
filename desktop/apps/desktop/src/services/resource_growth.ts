const isEnUi = (): boolean => {
    try {
        const lang = typeof document !== 'undefined' ? document.documentElement?.lang : '';
        const stored = typeof window !== 'undefined' ? window.localStorage?.getItem('ck.i18n.uiLocale') : '';
        return /^en(?:-|$)/i.test(String(lang || stored || ''));
    } catch { return false; }
};
const uiText = (zh: string, en: string): string => (isEnUi() ? en : zh);
import type {
    CompileResourceReport,
    LinkerMapResourceGroup,
    LinkerMapResourceSummary,
} from './compile_resources';

export type ResourceGrowthAttributionStatus =
    | 'verified'
    | 'total-only'
    | 'no-baseline'
    | 'incomparable'
    | 'rejected';

export interface ResourceGrowthContribution {
    id: string;
    label: string;
    kind: 'library' | 'object' | 'section' | 'generated-code' | 'linker-overhead';
    flashDeltaBytes: number;
    ramDeltaBytes: number | null;
    evidence: {
        kind: 'gnu-linker-map' | 'section-size-report';
        locator: string;
        sha256: string;
        baselineSha256: string;
    };
}

/**
 * Optional evidence produced by a future linker-map/section collector.
 * Merely observing a changed library version is not byte attribution and must
 * never be converted into this structure.
 */
export interface ResourceGrowthEvidence {
    schemaVersion: 1;
    fqbn: string;
    recordedAt: string;
    currentMapSha256: string;
    baselineMapSha256: string;
    contributions: ResourceGrowthContribution[];
}

export interface ResourceGrowthExplanation {
    status: ResourceGrowthAttributionStatus;
    flashDeltaBytes: number | null;
    ramDeltaBytes: number | null;
    summary: string;
    detail: string;
    contributions: ResourceGrowthContribution[];
    evidenceKind: ResourceGrowthContribution['evidence']['kind'] | null;
}

const validSha256 = (value: unknown): value is string => (
    typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value.trim())
);

const safeDelta = (value: number | null | undefined): number | null => (
    typeof value === 'number' && Number.isSafeInteger(value) ? value : null
);

const validContribution = (value: ResourceGrowthContribution): boolean => (
    Boolean(value.id.trim())
    && Boolean(value.label.trim())
    && Number.isSafeInteger(value.flashDeltaBytes)
    && (value.ramDeltaBytes == null || Number.isSafeInteger(value.ramDeltaBytes))
    && Boolean(value.evidence.locator.trim())
    && validSha256(value.evidence.sha256)
    && validSha256(value.evidence.baselineSha256)
);

const contributionKind = (group: LinkerMapResourceGroup): ResourceGrowthContribution['kind'] => {
    if (group.kind === 'library') return 'library';
    if (group.kind === 'generated-code') return 'generated-code';
    if (group.kind === 'other') return 'object';
    return 'section';
};

const summariesMatchReport = (
    report: CompileResourceReport,
    current: LinkerMapResourceSummary,
    baseline: LinkerMapResourceSummary,
): boolean => {
    if (current.fqbn !== report.fqbn || baseline.fqbn !== report.fqbn) return false;
    if (current.classifierId !== baseline.classifierId) return false;
    const currentFlash = report.flash?.usedBytes ?? null;
    const currentRam = report.ram?.usedBytes ?? null;
    const flashDelta = report.flash?.deltaBytes ?? null;
    const ramDelta = report.ram?.deltaBytes ?? null;
    if (currentFlash == null || currentRam == null || flashDelta == null || ramDelta == null) return false;
    return current.programOutputBytes === currentFlash
        && current.ramOutputBytes === currentRam
        && baseline.programOutputBytes === currentFlash - flashDelta
        && baseline.ramOutputBytes === currentRam - ramDelta;
};

/**
 * Converts two backend-verified absolute map summaries into exact deltas. A
 * residual row is explicit linker/alignment overhead, never assigned to a
 * library. Both map hashes are bound into every displayed contribution.
 */
export const createResourceGrowthEvidenceFromLinkerMaps = (
    report: CompileResourceReport,
): ResourceGrowthEvidence | null => {
    const current = report.linkerMapSummary;
    const baseline = report.baselineLinkerMapSummary;
    if (!current || !baseline || !summariesMatchReport(report, current, baseline)) return null;
    const before = new Map(baseline.groups.map(group => [group.id, group]));
    const after = new Map(current.groups.map(group => [group.id, group]));
    const ids = [...new Set([...before.keys(), ...after.keys()])].sort();
    const contributions: ResourceGrowthContribution[] = [];
    for (const id of ids) {
        const previous = before.get(id);
        const next = after.get(id);
        const flashDeltaBytes = (next?.programBytes || 0) - (previous?.programBytes || 0);
        const ramDeltaBytes = (next?.ramBytes || 0) - (previous?.ramBytes || 0);
        if (flashDeltaBytes === 0 && ramDeltaBytes === 0) continue;
        const group = next || previous!;
        contributions.push({
            id,
            label: group.label,
            kind: contributionKind(group),
            flashDeltaBytes,
            ramDeltaBytes,
            evidence: {
                kind: 'gnu-linker-map',
                locator: `${baseline.mapFileName} -> ${current.mapFileName} :: ${id}`,
                sha256: current.mapSha256,
                baselineSha256: baseline.mapSha256,
            },
        });
    }
    const flashDelta = report.flash!.deltaBytes!;
    const ramDelta = report.ram!.deltaBytes!;
    const attributedFlash = contributions.reduce((sum, item) => sum + item.flashDeltaBytes, 0);
    const attributedRam = contributions.reduce((sum, item) => sum + Number(item.ramDeltaBytes), 0);
    const residualFlash = flashDelta - attributedFlash;
    const residualRam = ramDelta - attributedRam;
    if (residualFlash !== 0 || residualRam !== 0) {
        contributions.push({
            id: 'linker-overhead-unassigned',
            label: uiText('链接布局、对齐及未分组段', 'Link layout, alignment, and ungrouped sections'),
            kind: 'linker-overhead',
            flashDeltaBytes: residualFlash,
            ramDeltaBytes: residualRam,
            evidence: {
                kind: 'gnu-linker-map',
                locator: `${baseline.mapFileName} -> ${current.mapFileName} :: unassigned-residual`,
                sha256: current.mapSha256,
                baselineSha256: baseline.mapSha256,
            },
        });
    }
    // A byte-identical resource result has nothing useful to attribute.
    if (contributions.length === 0) return null;
    return {
        schemaVersion: 1,
        fqbn: report.fqbn,
        recordedAt: current.recordedAt,
        currentMapSha256: current.mapSha256,
        baselineMapSha256: baseline.mapSha256,
        contributions,
    };
};

const growthSummary = (flashDelta: number | null, ramDelta: number | null): string => {
    const parts: string[] = [];
    if (flashDelta != null) parts.push(`Flash ${flashDelta >= 0 ? '+' : ''}${flashDelta} B`);
    if (ramDelta != null) parts.push(`RAM ${ramDelta >= 0 ? '+' : ''}${ramDelta} B`);
    return parts.length > 0 ? parts.join(uiText('，', ', ')) : uiText('暂无可比较的资源变化', 'No comparable resource change');
};

/**
 * Builds an explanation without inventing causality. Attribution is accepted
 * only when every contribution has content-addressed linker/section evidence
 * and its exact sum reconciles with the compiler's total delta.
 */
export const explainResourceGrowth = (
    report: CompileResourceReport | null | undefined,
    evidence?: ResourceGrowthEvidence | null,
): ResourceGrowthExplanation => {
    const flashDelta = safeDelta(report?.flash?.deltaBytes);
    const ramDelta = safeDelta(report?.ram?.deltaBytes);
    const capacityChanged = Boolean(
        report?.flash?.baselineCapacityChanged || report?.ram?.baselineCapacityChanged,
    );

    if (capacityChanged) {
        return {
            status: 'incomparable',
            flashDeltaBytes: null,
            ramDeltaBytes: null,
            summary: uiText('容量配置已变化，不能比较增长', 'Capacity configuration changed; growth cannot be compared'),
            detail: uiText('APP 分区或 RAM 上限发生变化，CK 已重建基线，不会把容量变化误报成代码增长。', 'The APP partition or RAM limit changed. CK rebuilt the baseline instead of misreporting a capacity change as code growth.'),
            contributions: [],
            evidenceKind: null,
        };
    }

    if (flashDelta == null && ramDelta == null) {
        return {
            status: 'no-baseline',
            flashDeltaBytes: null,
            ramDeltaBytes: null,
            summary: uiText('暂无资源对比基线', 'No resource comparison baseline yet'),
            detail: uiText('同一工程和完整 FQBN 再成功编译一次后，CK 才能比较总 Flash/RAM 变化。', 'Build this project with the same complete FQBN once more to compare total Flash/RAM changes.'),
            contributions: [],
            evidenceKind: null,
        };
    }

    if (!evidence) {
        return {
            status: 'total-only',
            flashDeltaBytes: flashDelta,
            ramDeltaBytes: ramDelta,
            summary: growthSummary(flashDelta, ramDelta),
            detail: uiText('当前构建没有可校验的 linker map 或 section 报告，只能确认总量变化，不能精确归因到某个库、字体或积木。', 'This build has no verifiable linker map or section report. Only total deltas are confirmed; growth cannot be attributed to a specific library, font, or block.'),
            contributions: [],
            evidenceKind: null,
        };
    }

    const invalidReason = evidence.schemaVersion !== 1
        ? uiText('归因证据版本不受支持', 'Unsupported attribution evidence version')
        : !validSha256(evidence.currentMapSha256) || !validSha256(evidence.baselineMapSha256)
            ? uiText('归因证据缺少当前或基线 map 哈希', 'Attribution evidence is missing current or baseline map hashes')
        : evidence.fqbn.trim() !== String(report?.fqbn || '').trim()
            ? uiText('归因证据与本次完整 FQBN 不一致', 'Attribution evidence does not match the current complete FQBN')
            : !Number.isFinite(Date.parse(evidence.recordedAt))
                ? uiText('归因证据时间无效', 'Attribution evidence timestamp is invalid')
                : evidence.contributions.length === 0
                    ? uiText('归因证据没有贡献项', 'Attribution evidence contains no contributions')
                    : evidence.contributions.some(item => !validContribution(item))
                        ? uiText('归因证据缺少有效哈希、定位信息或字节数', 'Attribution evidence is missing valid hashes, locators, or byte counts')
                        : null;
    if (invalidReason) {
        return {
            status: 'rejected',
            flashDeltaBytes: flashDelta,
            ramDeltaBytes: ramDelta,
            summary: growthSummary(flashDelta, ramDelta),
            detail: uiText(`${invalidReason}，已拒绝展示来源分摊；总量变化仍采用编译器报告。`, `${invalidReason}; source breakdown was rejected while compiler totals remain shown.`),
            contributions: [],
            evidenceKind: null,
        };
    }

    const flashSum = evidence.contributions.reduce((sum, item) => sum + item.flashDeltaBytes, 0);
    const ramContributions = evidence.contributions.map(item => item.ramDeltaBytes);
    const hasCompleteRamEvidence = ramContributions.every(value => value != null);
    const ramSum = hasCompleteRamEvidence
        ? ramContributions.reduce((sum, value) => sum + Number(value), 0)
        : null;
    const flashMatches = flashDelta == null || flashSum === flashDelta;
    const ramMatches = ramDelta == null || (ramSum != null && ramSum === ramDelta);
    if (!flashMatches || !ramMatches) {
        return {
            status: 'rejected',
            flashDeltaBytes: flashDelta,
            ramDeltaBytes: ramDelta,
            summary: growthSummary(flashDelta, ramDelta),
            detail: uiText('来源分摊之和与编译器总量不一致，已拒绝归因；不会用近似数字冒充精确解释。', 'The sum of attributed sources does not match the compiler total; attribution was rejected.'),
            contributions: [],
            evidenceKind: null,
        };
    }

    const kinds = new Set(evidence.contributions.map(item => item.evidence.kind));
    return {
        status: 'verified',
        flashDeltaBytes: flashDelta,
        ramDeltaBytes: ramDelta,
        summary: growthSummary(flashDelta, ramDelta),
        detail: uiText('以下来源均由内容哈希绑定的 linker/section 证据复核，分摊之和与编译器总量完全一致。', 'All sources below were verified against content-hashed linker/section evidence and reconcile exactly with the compiler total.'),
        contributions: [...evidence.contributions].sort((left, right) => (
            Math.abs(right.flashDeltaBytes) - Math.abs(left.flashDeltaBytes)
        )),
        evidenceKind: kinds.size === 1 ? evidence.contributions[0].evidence.kind : null,
    };
};

export const explainCompileResourceGrowth = (
    report: CompileResourceReport | null | undefined,
): ResourceGrowthExplanation => explainResourceGrowth(
    report,
    report ? createResourceGrowthEvidenceFromLinkerMaps(report) : null,
);
