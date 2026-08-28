import type { ComponentType } from 'react';
import {
  Bug,
  Cable,
  CheckCircle2,
  Clock,
  Cpu,
  Gauge,
  History,
  Info,
  X,
} from 'lucide-react';
import {
  LATEST_RELEASE_NOTE,
  type ReleaseNoteSectionKind,
} from '../data/release_notes';

interface ChangelogModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const sectionIcons: Record<ReleaseNoteSectionKind, ComponentType<{ size?: number; className?: string }>> = {
  debug: Bug,
  cache: Gauge,
  progress: Clock,
  serial: Cable,
};

const sectionStyles: Record<ReleaseNoteSectionKind, string> = {
  debug: 'border-violet-200 bg-violet-50/70 text-violet-700 dark:border-violet-800 dark:bg-violet-950/30 dark:text-violet-300',
  cache: 'border-teal-200 bg-teal-50/70 text-teal-700 dark:border-teal-800 dark:bg-teal-950/30 dark:text-teal-300',
  progress: 'border-amber-200 bg-amber-50/70 text-amber-700 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300',
  serial: 'border-sky-200 bg-sky-50/70 text-sky-700 dark:border-sky-800 dark:bg-sky-950/30 dark:text-sky-300',
};

export default function ChangelogModal({ isOpen, onClose }: ChangelogModalProps) {
  if (!isOpen) return null;

  const release = LATEST_RELEASE_NOTE;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/50 p-3 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      data-ck-role="changelog-modal"
    >
      <div className="flex max-h-[86vh] w-full max-w-4xl flex-col overflow-hidden rounded-3xl border border-white/70 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900">
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-200 px-5 py-4 dark:border-slate-800">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">
              <History size={20} />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="truncate text-lg font-black text-slate-900 dark:text-slate-100">软件更新日志</h2>
                <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-bold text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">
                  {release.date}
                </span>
              </div>
              <p className="truncate text-xs text-slate-500 dark:text-slate-400">{release.title}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="关闭更新日志"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          >
            <X size={18} />
          </button>
        </header>

        <div className="overflow-y-auto px-5 py-5">
          <section className="overflow-hidden rounded-2xl border border-violet-200/80 bg-gradient-to-br from-violet-50 via-white to-teal-50 p-5 dark:border-violet-800 dark:from-violet-950/40 dark:via-slate-900 dark:to-teal-950/30">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-violet-600 text-white shadow-sm">
                <Bug size={18} />
              </div>
              <div>
                <h3 className="text-xl font-black text-slate-900 dark:text-slate-100">{release.title}</h3>
                <p className="mt-1 text-sm leading-6 text-slate-600 dark:text-slate-300">{release.summary}</p>
              </div>
            </div>
          </section>

          <section className="mt-5">
            <div className="mb-2 flex items-center gap-2 text-sm font-bold text-slate-800 dark:text-slate-200">
              <Cpu size={16} className="text-teal-600" /> 真板验证范围
            </div>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3">
              {release.boardSupport.map((board) => (
                <div key={board.name} className="rounded-xl border border-slate-200 bg-slate-50/70 p-3 dark:border-slate-700 dark:bg-slate-800/60">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-bold text-slate-800 dark:text-slate-100">{board.name}</span>
                    {board.verified && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[9px] font-bold text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                        <CheckCircle2 size={10} /> 真板验证
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-[11px] leading-4 text-slate-500 dark:text-slate-400">{board.detail}</p>
                </div>
              ))}
            </div>
          </section>

          <section className="mt-5 grid grid-cols-1 gap-3 lg:grid-cols-2">
            {release.sections.map((section) => {
              const Icon = sectionIcons[section.kind];
              return (
                <article key={section.kind} className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
                  <div className="flex items-start gap-2.5">
                    <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border ${sectionStyles[section.kind]}`}>
                      <Icon size={16} />
                    </div>
                    <div>
                      <h4 className="text-sm font-black text-slate-800 dark:text-slate-100">{section.title}</h4>
                      <p className="mt-0.5 text-[11px] leading-4 text-slate-500 dark:text-slate-400">{section.summary}</p>
                    </div>
                  </div>
                  <ul className="mt-3 space-y-1.5">
                    {section.items.map((item) => (
                      <li key={item} className="flex items-start gap-2 text-xs leading-5 text-slate-600 dark:text-slate-300">
                        <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-slate-400" />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </article>
              );
            })}
          </section>

          <section className="mt-5 rounded-2xl border border-amber-200 bg-amber-50/70 p-4 dark:border-amber-800 dark:bg-amber-950/30">
            <div className="flex items-center gap-2 text-sm font-bold text-amber-800 dark:text-amber-200">
              <Info size={16} /> 使用说明
            </div>
            <ul className="mt-2 space-y-1.5">
              {release.notices.map((notice) => (
                <li key={notice} className="flex items-start gap-2 text-xs leading-5 text-amber-900/80 dark:text-amber-100/80">
                  <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-amber-500" />
                  <span>{notice}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-slate-200 bg-slate-50/70 px-5 py-3 dark:border-slate-800 dark:bg-slate-900">
          <span className="text-[11px] text-slate-400">更多改进会继续记录在这里。</span>
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-xl bg-slate-900 px-4 text-xs font-bold text-white transition-colors hover:bg-slate-700 dark:bg-violet-600 dark:hover:bg-violet-500"
          >
            我知道了
          </button>
        </footer>
      </div>
    </div>
  );
}
