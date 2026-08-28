import { useState } from "react";
import "./App.css";
import UserDashboard from "./components/Dashboard";
import Workspace from "./components/Workspace";
import BoardSelector from "./components/BoardSelector";
import DetachedConsoleWindow from "./components/DetachedConsoleWindow";
import { ErrorBoundary } from "./components/ErrorBoundary";

import { DialogProvider } from "./contexts/DialogContext";
import { useAppTheme } from "./contexts/ThemeContext";

function App() {
  // View routing: 'dashboard' | 'board-selector' | 'workspace'
  const [view, setView] = useState<'dashboard' | 'board-selector' | 'workspace'>('dashboard');
  const [activeProject, setActiveProject] = useState<string | null>(null);
  const [openOptions, setOpenOptions] = useState<{ forceBoard?: string; forceBoardPackageId?: string; missingBoard?: string }>({});
  const { mode: theme, resolvedTheme } = useAppTheme();

  const handleOpenProject = (path: string, options?: { forceBoard?: string; forceBoardPackageId?: string; missingBoard?: string }) => {
    setActiveProject(path);
    setOpenOptions(options || {});
    setView('workspace');
  };

  const handleBackToDashboard = () => {
    setActiveProject(null);
    setOpenOptions({});
    setView('dashboard');
  };

  const isDetachedConsoleMode = new URLSearchParams(window.location.search).get('console') === 'detached';

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
      <DialogProvider>
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
              forceBoard={openOptions.forceBoard}
              forceBoardPackageId={openOptions.forceBoardPackageId}
              missingBoard={openOptions.missingBoard}
              theme={theme}
            />
          )}
        </ErrorBoundary>
      </DialogProvider>
    </div>
  );
}

export default App;
