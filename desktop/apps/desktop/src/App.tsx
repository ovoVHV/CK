import { useCallback, useEffect, useRef, useState } from "react";
import { FileInput, TriangleAlert, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import "./App.css";
import UserDashboard from "./components/Dashboard";
import Workspace from "./components/Workspace";
import BoardSelector from "./components/BoardSelector";
import DetachedConsoleWindow from "./components/DetachedConsoleWindow";
import { ErrorBoundary } from "./components/ErrorBoundary";

import { DialogProvider, useDialog } from "./contexts/DialogContext";
import { useAppTheme } from "./contexts/ThemeContext";
import {
  PROJECT_OPEN_BROWSER_EVENT,
  inspectDroppedProjectPaths,
  prepareProjectOpen,
  projectOpenErrorMessage,
  createProjectOpenRequestQueue,
  subscribeProjectOpenRequests,
  type WorkspaceProjectOpenDetail,
  type ProjectOpenRequest,
} from "./services/project_open";

type ProjectDropNotice = {
  state: 'ready' | 'invalid';
  title: string;
  detail: string;
};

type WorkspaceOpenListenerWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
  timeoutId: number;
};

function AppContent() {
  const { t, i18n } = useTranslation();
  // View routing: 'dashboard' | 'board-selector' | 'workspace'
  const [view, setView] = useState<'dashboard' | 'board-selector' | 'workspace'>('dashboard');
  const [activeProject, setActiveProject] = useState<string | null>(null);
  const [openOptions, setOpenOptions] = useState<{ forceBoard?: string; forceBoardPackageId?: string; missingBoard?: string; openCheck?: boolean }>({});
  const [projectDropNotice, setProjectDropNotice] = useState<ProjectDropNotice | null>(null);
  const { mode: theme, resolvedTheme } = useAppTheme();
  const dialog = useDialog();
  const dialogRef = useRef(dialog);
  const viewRef = useRef(view);
  const activeProjectRef = useRef(activeProject);
  // Native open events and drag/drop requests share one queue. Without a
  // single owner, a second event can arrive while the workspace is waiting
  // for the unsaved-work decision and be silently discarded.
  const projectOpenQueueRef = useRef<ReturnType<typeof createProjectOpenRequestQueue> | null>(null);
  const projectDropNoticeTimerRef = useRef<number | null>(null);
  const routeReadyWaitersRef = useRef<Array<{ path: string; resolve: () => void }>>([]);
  const workspaceOpenListenerReadyRef = useRef(false);
  const workspaceOpenListenerWaitersRef = useRef<WorkspaceOpenListenerWaiter[]>([]);
  dialogRef.current = dialog;
  viewRef.current = view;
  activeProjectRef.current = activeProject;

  const handleOpenProject = useCallback((path: string, options?: { forceBoard?: string; forceBoardPackageId?: string; missingBoard?: string; openCheck?: boolean }) => {
    setActiveProject(path);
    setOpenOptions(options || {});
    setView('workspace');
  }, []);

  const waitForWorkspaceRoute = useCallback((path: string): Promise<void> => {
    if (viewRef.current === 'workspace' && activeProjectRef.current === path) {
      // Same-path opens do not remount the route. Yield one task so the
      // current workspace can finish the action before the next queued item.
      return new Promise(resolve => window.setTimeout(resolve, 0));
    }
    return new Promise(resolve => {
      routeReadyWaitersRef.current.push({ path, resolve });
    });
  }, []);

  const waitForWorkspaceOpenListener = useCallback((): Promise<void> => {
    if (workspaceOpenListenerReadyRef.current) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter: WorkspaceOpenListenerWaiter = {
        resolve,
        reject,
        timeoutId: 0,
      };
      waiter.timeoutId = window.setTimeout(() => {
        workspaceOpenListenerWaitersRef.current = workspaceOpenListenerWaitersRef.current
          .filter(candidate => candidate !== waiter);
        reject(new Error(i18n.t('app.projectOpen.editorNotReady')));
      }, 8000);
      workspaceOpenListenerWaitersRef.current.push(waiter);
    });
  }, [i18n]);

  const handleWorkspaceOpenListenerReady = useCallback((ready: boolean) => {
    workspaceOpenListenerReadyRef.current = ready;
    if (!ready || workspaceOpenListenerWaitersRef.current.length === 0) return;
    const waiters = workspaceOpenListenerWaitersRef.current.splice(0);
    waiters.forEach(waiter => {
      window.clearTimeout(waiter.timeoutId);
      waiter.resolve();
    });
  }, []);

  useEffect(() => {
    if (view !== 'workspace' || !activeProject) return;
    const ready = routeReadyWaitersRef.current.filter(item => item.path === activeProject);
    if (ready.length === 0) return;
    routeReadyWaitersRef.current = routeReadyWaitersRef.current.filter(item => item.path !== activeProject);
    // Resolve after the commit's task, when the new Workspace has mounted and
    // installed its browser-event listener.
    window.setTimeout(() => ready.forEach(item => item.resolve()), 0);
  }, [activeProject, view]);

  useEffect(() => () => {
    projectOpenQueueRef.current?.dispose();
    projectOpenQueueRef.current = null;
    routeReadyWaitersRef.current.splice(0).forEach(item => item.resolve());
    workspaceOpenListenerWaitersRef.current.splice(0).forEach(waiter => {
      window.clearTimeout(waiter.timeoutId);
      waiter.reject(new Error(i18n.t('app.projectOpen.appClosed')));
    });
  }, [i18n]);

  const handleRequestedProjectOpen = useCallback(async (request: {
    requestId: string;
    path: string;
    source: string;
  }) => {
    try {
      const target = await prepareProjectOpen(request.path);
      if (viewRef.current === 'workspace' && activeProjectRef.current) {
        // A dashboard/manual open can commit the workspace route one task
        // before the child effect installs its browser-event listener. Wait
        // for the explicit readiness handshake so this request cannot vanish
        // in that narrow mount window.
        await waitForWorkspaceOpenListener();
        await new Promise<void>(resolve => {
          let accepted = false;
          let routeReady: Promise<void> | null = null;
          const detail: WorkspaceProjectOpenDetail = {
            request,
            target,
            // Workspace owns the unsaved-work gate. Only after it accepts do
            // we update the parent route/key and clear old board overrides.
            accept: () => {
              accepted = true;
              routeReady = waitForWorkspaceRoute(target.path);
              handleOpenProject(target.path);
            },
            onSettled: async () => {
              if (accepted && routeReady) await routeReady;
              resolve();
            },
          };
          window.dispatchEvent(new CustomEvent(PROJECT_OPEN_BROWSER_EVENT, { detail }));
        });
        return;
      }
      const routeReady = waitForWorkspaceRoute(target.path);
      handleOpenProject(target.path);
      await routeReady;
    } catch (error) {
      // Do not let the drag affordance sit above the validation dialog.
      setProjectDropNotice(null);
      await dialogRef.current.alert({
        title: i18n.t('app.projectOpen.cannotOpenTitle'),
        message: projectOpenErrorMessage(error),
        type: 'error',
        confirmLabel: i18n.t('common.actions.gotIt'),
      });
    }
  }, [handleOpenProject, i18n, waitForWorkspaceOpenListener, waitForWorkspaceRoute]);

  const enqueueProjectOpenRequest = useCallback((request: ProjectOpenRequest): Promise<void> => {
    if (!projectOpenQueueRef.current) {
      projectOpenQueueRef.current = createProjectOpenRequestQueue(handleRequestedProjectOpen);
    }
    return projectOpenQueueRef.current.enqueue(request);
  }, [handleRequestedProjectOpen]);

  const handleBackToDashboard = () => {
    setActiveProject(null);
    setOpenOptions({});
    setView('dashboard');
  };

  const isDetachedConsoleMode = new URLSearchParams(window.location.search).get('console') === 'detached';

  useEffect(() => {
    if (isDetachedConsoleMode) return;
    let disposed = false;
    let unsubscribe: (() => void) | undefined;

    void subscribeProjectOpenRequests(request => {
      if (disposed) return;
      return enqueueProjectOpenRequest(request);
    }).then(stop => {
      if (disposed) stop();
      else unsubscribe = stop;
    }).catch(error => {
      console.error('[ProjectOpen] Failed to initialize file-open bridge', error);
    });

    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [enqueueProjectOpenRequest, isDetachedConsoleMode]);

  useEffect(() => {
    if (isDetachedConsoleMode) return;
    const isNative = typeof window !== 'undefined' && Boolean(
      (window as any).__TAURI_IPC__
      || (window as any).__TAURI_INTERNALS__
      || (window as any).__TAURI__,
    );
    if (!isNative) return;

    let disposed = false;
    let unlisten: (() => void) | undefined;
    const clearDropNoticeTimer = () => {
      if (projectDropNoticeTimerRef.current === null) return;
      window.clearTimeout(projectDropNoticeTimerRef.current);
      projectDropNoticeTimerRef.current = null;
    };
    const clearDropNotice = () => {
      clearDropNoticeTimer();
      if (!disposed) setProjectDropNotice(null);
    };
    const keepDropNoticeAlive = () => {
      clearDropNoticeTimer();
      projectDropNoticeTimerRef.current = window.setTimeout(() => {
        projectDropNoticeTimerRef.current = null;
        if (!disposed) setProjectDropNotice(null);
      }, 1600);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') clearDropNotice();
    };
    // Native drag events can miss a final `leave` when the pointer crosses a
    // child SVG/webview boundary. These browser/window fallbacks guarantee the
    // affordance never becomes a permanent, click-through page cover.
    window.addEventListener('blur', clearDropNotice);
    window.addEventListener('dragend', clearDropNotice, true);
    window.addEventListener('drop', clearDropNotice, true);
    window.addEventListener('keydown', handleEscape);
    void import('@tauri-apps/api/webview').then(async ({ getCurrentWebview }) => {
      const stopListening = await getCurrentWebview().onDragDropEvent(event => {
        if (disposed) return;
        const payload = event.payload;
        if (payload.type === 'leave') {
          clearDropNotice();
          return;
        }
        if (payload.type === 'over') {
          keepDropNoticeAlive();
          return;
        }

        const inspection = inspectDroppedProjectPaths(payload.paths);
        if (payload.type === 'enter') {
          if (inspection.path) {
            setProjectDropNotice({
              state: 'ready',
              title: i18n.t('app.drop.releaseToOpen', {
                fileName: inspection.fileName || i18n.t('app.drop.projectFallback'),
              }),
              detail: i18n.t('app.drop.validationDescription'),
            });
          } else {
            setProjectDropNotice({
              state: 'invalid',
              title: i18n.t('app.drop.unsupportedTitle'),
              detail: inspection.error || i18n.t('app.drop.supportedFilesHint'),
            });
          }
          keepDropNoticeAlive();
          return;
        }

        if (payload.type !== 'drop') return;
        // The full-page layer is only a drag target affordance. Do not keep it
        // on screen while validation, an unsaved-work decision or recovery
        // dialog is running; those flows own their own progress/error UI.
        clearDropNotice();
        if (!inspection.path) {
          void dialogRef.current.alert({
            title: i18n.t('app.drop.cannotOpenTitle'),
            message: inspection.error || i18n.t('app.drop.supportedFilesHint'),
            type: 'warning',
            confirmLabel: i18n.t('common.actions.gotIt'),
          });
          return;
        }

        void enqueueProjectOpenRequest({
          requestId: `drag-drop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          path: inspection.path,
          source: 'drag-drop',
        });
      });
      if (disposed) stopListening();
      else unlisten = stopListening;
    }).catch(error => {
      clearDropNotice();
      console.warn('[ProjectOpen] Failed to install project file drop bridge', error);
    });

    return () => {
      disposed = true;
      clearDropNoticeTimer();
      window.removeEventListener('blur', clearDropNotice);
      window.removeEventListener('dragend', clearDropNotice, true);
      window.removeEventListener('drop', clearDropNotice, true);
      window.removeEventListener('keydown', handleEscape);
      unlisten?.();
    };
  }, [enqueueProjectOpenRequest, i18n, isDetachedConsoleMode]);

  return (
    <div
      className="app-root bg-white text-slate-800 transition-colors dark:bg-slate-950 dark:text-slate-100"
      data-theme-mode={theme}
      data-theme-resolved={resolvedTheme}
      style={{
        maxWidth: '100%',
        padding: 0,
        margin: 0,
        height: '100vh',
        width: '100vw',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden'
      }}
    >
      {!isDetachedConsoleMode && projectDropNotice && (
        <div
          className="fixed inset-0 z-[10000] flex cursor-pointer items-center justify-center bg-slate-950/35 p-6 backdrop-blur-[2px]"
          role="status"
          aria-live="polite"
          aria-label={t('app.drop.noticeAria')}
          data-project-drop-state={projectDropNotice.state}
          onPointerDown={() => setProjectDropNotice(null)}
        >
          <div className={`relative w-full max-w-md cursor-default rounded-3xl border-2 bg-white/95 px-8 py-9 text-center shadow-2xl dark:bg-slate-900/95 ${
            projectDropNotice.state === 'invalid'
              ? 'border-amber-400 dark:border-amber-500'
              : 'border-brand-400 dark:border-brand-500'
          }`} onPointerDown={event => event.stopPropagation()}>
            <button
              type="button"
              className="absolute right-3 top-3 rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
              onClick={() => setProjectDropNotice(null)}
              aria-label={t('app.drop.closeAria')}
            >
              <X size={17} />
            </button>
            <div className={`mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl ${
              projectDropNotice.state === 'invalid'
                ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/70 dark:text-amber-300'
                : 'bg-brand-100 text-brand-700 dark:bg-brand-950/70 dark:text-brand-300'
            }`}>
              {projectDropNotice.state === 'invalid' ? (
                <TriangleAlert size={32} strokeWidth={2.2} />
              ) : (
                <FileInput size={32} strokeWidth={2.2} />
              )}
            </div>
            <div className="text-lg font-extrabold text-slate-900 dark:text-white">
              {projectDropNotice.title}
            </div>
            <div className="mt-2 text-sm font-medium leading-6 text-slate-600 dark:text-slate-300">
              {projectDropNotice.detail}
            </div>
            <div className="mt-5 inline-flex rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              {t('app.drop.footer')}
            </div>
          </div>
        </div>
      )}
      <ErrorBoundary>
          {isDetachedConsoleMode ? (
            <DetachedConsoleWindow theme={theme} />
          ) : view === 'dashboard' ? (
            <UserDashboard
              onOpenProject={handleOpenProject}
              onNewProject={() => setView('board-selector')}
            />
          ) : view === 'board-selector' ? (
            <BoardSelector
              onBack={() => setView('dashboard')}
              onCreated={(path, options) => handleOpenProject(path, options)}
            />
          ) : (
            <Workspace
              key={activeProject} // Force clean remount on project change
              projectPath={activeProject || ''}
              onBack={handleBackToDashboard}
              onProjectOpenListenerReady={handleWorkspaceOpenListenerReady}
              forceBoard={openOptions.forceBoard}
              forceBoardPackageId={openOptions.forceBoardPackageId}
              missingBoard={openOptions.missingBoard}
              initialCheckOpen={openOptions.openCheck}
              theme={theme}
            />
          )}
      </ErrorBoundary>
    </div>
  );
}

function App() {
  return (
    <DialogProvider>
      <AppContent />
    </DialogProvider>
  );
}

export default App;
