import type { LastWorkingDiffGroup } from './last_working_version';

export type LastWorkingDiffGroupLabels = Readonly<Record<LastWorkingDiffGroup, string>>;

export const LAST_WORKING_DIFF_GROUP_LABELS_ZH_CN: LastWorkingDiffGroupLabels = {
    workspace: '代码与积木',
    environment: '环境与配置',
    dependencies: '依赖',
    device: '真机',
    resources: '资源',
};

export const LAST_WORKING_DIFF_GROUP_LABELS_EN_US: LastWorkingDiffGroupLabels = {
    workspace: 'Code & Blocks',
    environment: 'Environment & Configuration',
    dependencies: 'Dependencies',
    device: 'Device',
    resources: 'Resources',
};

export type LastWorkingPresentationLocale = 'zh-CN' | 'en-US';

export const resolveLastWorkingPresentationLocale = (
    locale: string | null | undefined,
): LastWorkingPresentationLocale => locale?.toLowerCase().startsWith('en') ? 'en-US' : 'zh-CN';

export const lastWorkingDiffGroupLabelsForLocale = (
    locale: string | null | undefined,
): LastWorkingDiffGroupLabels => resolveLastWorkingPresentationLocale(locale) === 'en-US'
    ? LAST_WORKING_DIFF_GROUP_LABELS_EN_US
    : LAST_WORKING_DIFF_GROUP_LABELS_ZH_CN;

/**
 * Resolve presentation copy from an injected locale map. The group itself is
 * always the stable ASCII identity, so changing labels is hot-switch safe.
 */
export const lastWorkingDiffGroupLabel = (
    group: LastWorkingDiffGroup,
    labels: LastWorkingDiffGroupLabels,
): string => labels[group];
