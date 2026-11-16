import { useTranslation } from 'react-i18next';
import { ProjectOverview } from './ProjectOverview';
import { useProjectStatus } from './project_status_session';

export function DashboardProjectStatus({ path, name, board, onOpenCheck }: {
    path: string; name: string; board: string; onOpenCheck: () => void;
}) {
    const { t, i18n } = useTranslation('health');
    const snapshot = useProjectStatus(path);
    return <section className="mt-3 min-w-0 overflow-hidden border-t border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900" data-ck-role="dashboard-project-status">
        <div className="px-3 pt-3 text-[11px] text-slate-500 dark:text-slate-400">
            {snapshot
                ? t('productV2.sessionResult', { time: new Date(snapshot.observedAt).toLocaleTimeString(i18n.resolvedLanguage, { hour: '2-digit', minute: '2-digit' }) })
                : t('productV2.noSessionResult')}
        </div>
        <ProjectOverview projectName={name} boardName={board}
            compileReport={snapshot?.compileReport ?? null}
            resourceReport={snapshot?.resourceReport ?? null}
            issues={snapshot?.issues ?? []}
            showIdentity={false}
            historical
            needsRecheck={snapshot?.dirty}
            onOpenHealth={onOpenCheck} />
        <p className="px-3 py-2 text-[11px] text-slate-500 dark:text-slate-400">{t('productV2.historyHint')}</p>
    </section>;
}
