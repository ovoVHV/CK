import { BookOpen, ExternalLink, Usb, ArrowUpRight, Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { CK_DRIVER_SOURCES, CK_LAB } from '../data/ck_lab';

export function DashboardResources({ section, onOpenLink }: {
    section: 'guide' | 'drivers';
    onOpenLink: (url: string) => void;
}) {
    const { t } = useTranslation();
    const isGuide = section === 'guide';
    return <div className="mx-auto max-w-4xl pb-8" data-ck-role={`dashboard-${section}`}>
        <div className="mb-7 border-b border-slate-200 pb-6 dark:border-slate-800">
            <p className="mb-2 text-xs font-bold tracking-widest text-brand-600 dark:text-brand-300">CK LAB / {isGuide ? 'GET STARTED' : 'CONNECT'}</p>
            <h2 className="text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-100">{t(`dashboard.resources.${section}.title`)}</h2>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-500 dark:text-slate-400">{t(`dashboard.resources.${section}.intro`)}</p>
        </div>
        {isGuide ? <div className="grid gap-4 lg:grid-cols-2">
            {(['create', 'core', 'blocks', 'build', 'upload', 'help'] as const).map((step, index) => <article key={step} className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
                <span className="font-mono text-sm font-semibold text-brand-600 dark:text-brand-300">0{index + 1}</span>
                <h3 className="mt-3 font-bold text-slate-900 dark:text-slate-100">{t(`dashboard.resources.guide.${step}Title`)}</h3>
                <p className="mt-2 text-sm leading-7 text-slate-500 dark:text-slate-400">{t(`dashboard.resources.guide.${step}Body`)}</p>
            </article>)}
        </div> : <>
            <div className="mb-5 rounded-xl border border-brand-200 bg-brand-50 p-5 text-sm leading-7 text-slate-700 dark:border-brand-900 dark:bg-brand-950/30 dark:text-slate-300">
                <h3 className="mb-1 flex items-center gap-2 font-bold"><Usb size={17} />{t('dashboard.resources.drivers.beforeTitle')}</h3>
                <p>{t('dashboard.resources.drivers.beforeBody')}</p>
                <button type="button" onClick={() => onOpenLink(`${CK_LAB}/drivers/install/`)} className="mt-3 inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 font-bold text-white hover:bg-brand-700">
                    <BookOpen size={16} />{t('dashboard.resources.drivers.installGuide')}<ArrowUpRight size={15} />
                </button>
            </div>
            <div className="mb-6 grid gap-3 sm:grid-cols-3">
                {(['download', 'extract', 'install'] as const).map((step, index) => <article key={step} className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
                    <img src={`/driver-guide/${['01-download', '02-extract', '07-port'][index]}.svg`} alt={t(`dashboard.resources.drivers.${step}Title`)} className="aspect-[3/2] w-full object-contain bg-white" />
                    <div className="p-4"><h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">{index + 1}. {t(`dashboard.resources.drivers.${step}Title`)}</h3>
                    <p className="mt-2 text-xs leading-6 text-slate-500 dark:text-slate-400">{t(`dashboard.resources.drivers.${step}Body`)}</p></div>
                </article>)}
            </div>
            <div className="space-y-3">
                {CK_DRIVER_SOURCES.map(source => <article key={source.id} className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
                    <div className="min-w-0 flex-1"><h3 className="font-bold text-slate-900 dark:text-slate-100">{source.chip}</h3><p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{source.vendor} · {t(source.official ? 'dashboard.resources.drivers.officialSource' : 'dashboard.resources.drivers.ckSource')}</p><p className="mt-2 text-xs leading-6 text-slate-500 dark:text-slate-400">{t(`dashboard.resources.drivers.methods.${source.id}`)}</p></div>
                    <div className="flex flex-wrap gap-2">
                        <button type="button" onClick={() => onOpenLink(source.url)} className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">
                            <Download size={14} />{t('dashboard.resources.drivers.downloadZip')}
                        </button>
                        <button type="button" onClick={() => onOpenLink(`${CK_LAB}/drivers/install/#${source.id}`)} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-4 py-2 text-sm font-semibold text-brand-700 hover:bg-brand-50 dark:border-slate-700 dark:text-brand-300 dark:hover:bg-slate-800">
                            {t('dashboard.resources.drivers.howToInstall')}<ExternalLink size={14} />
                        </button>
                    </div>
                </article>)}
            </div>
            <p className="mt-4 text-xs leading-6 text-slate-500 dark:text-slate-400">{t('dashboard.resources.drivers.note')}</p>
        </>}
        <button type="button" onClick={() => onOpenLink(`${CK_LAB}/${isGuide ? 'guide' : 'drivers'}/`)} className="mt-7 inline-flex items-center gap-2 rounded-lg bg-brand-600 px-5 py-3 text-sm font-bold text-white hover:bg-brand-700">
            <BookOpen size={16} />{t('dashboard.resources.readOnline')}<ArrowUpRight size={16} />
        </button>
    </div>;
}
