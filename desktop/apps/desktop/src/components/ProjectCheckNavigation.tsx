import { useTranslation } from 'react-i18next';
export type ProjectCheckSection = 'compile' | 'hardware' | 'resources' | 'recovery' | 'dependencies';
export interface ProjectCheckActions {
    onOpenLibraries?: () => void;
    onOpenCheckpoints?: () => void;
    onOpenLastWorking?: () => void;
}
export function ProjectCheckNavigation({ onSelect }: { onSelect: (section: ProjectCheckSection) => void }) {
    const { t } = useTranslation('health');
    return <nav aria-label={t('productV2.check')} className="sticky top-0 z-10 flex flex-wrap gap-1 border-b border-slate-200 bg-white p-2 dark:border-slate-700 dark:bg-slate-900">
        {(['compile', 'hardware', 'resources', 'recovery', 'dependencies'] as const).map(section => (
            <button key={section} type="button" onClick={() => onSelect(section)}
                className="rounded px-2 py-1.5 text-[11px] font-medium text-slate-600 hover:bg-brand-50 hover:text-brand-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500 dark:text-slate-300 dark:hover:bg-brand-950 dark:hover:text-brand-200">
                {t(`productV2.section.${section}`)}
            </button>
        ))}
    </nav>;
}
export function ProjectRecoveryLinks({ onOpenCheckpoints, onOpenLastWorking }: ProjectCheckActions) {
    const { t } = useTranslation('health');
    return <section className="border-t border-slate-200 p-3 dark:border-slate-700" data-ck-role="health-recovery">
        <h3 className="text-xs font-semibold text-slate-800 dark:text-slate-100">{t('productV2.section.recovery')}</h3>
        <p className="my-2 text-[11px] text-slate-500 dark:text-slate-400">{t('productV2.recoveryHint')}</p>
        <div className="flex flex-wrap gap-2">
            {([['checkpoints', onOpenCheckpoints], ['lastWorking', onOpenLastWorking]] as const).filter(([, action]) => Boolean(action)).map(([key, action]) => (
                <button key={key} type="button" disabled={!action} onClick={action}
                    className="min-w-0 max-w-full rounded border border-slate-300 px-2 py-1.5 text-left text-[11px] text-brand-700 disabled:opacity-50 dark:border-slate-600 dark:text-brand-300">
                    {t(`productV2.${key}`)}
                </button>
            ))}
        </div>
    </section>;
}
