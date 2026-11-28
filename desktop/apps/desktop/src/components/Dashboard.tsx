import { lazy, Suspense, useEffect, useState } from 'react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { uiText } from '../i18n/uiText';
import { useHardware } from '../contexts/HardwareContext';
import { getBoardIcon, getBoardName } from '../constants/boards';
import DeviceSelectorModal from './DeviceSelectorModal';
import AppearanceSettingsModal from './AppearanceSettingsModal';
import DataStorageSettings from './DataStorageSettings';
import { useDashboardUpdate } from './DashboardUpdate';
import { BrandLogo } from './BrandLogo';
import { DashboardResources } from './DashboardResources';
import { CK_LAB, CK_OFFICIAL_QQ_GROUP } from '../data/ck_lab';
import { DashboardProjectStatus } from './DashboardProjectStatus';
import { useRecentProjectPath } from './project_status_session';
import {
  Plus,
  Search,
  LayoutGrid,
  List,
  Clock,
  Cpu,
  Usb,
  Box,
  Loader2,
  Trash2,
  FileEdit,
  AlertTriangle,
  X,
  Copy,
  FolderOpen,
  MoreVertical,
  ArrowDown,
  BookOpen,
  Download,
  ArrowUp,
  ExternalLink,
  HardDrive,
  CheckCircle2,
  XCircle,
  ChevronRight,
  Pin,
  PinOff,
  Settings,
} from 'lucide-react';
import { useDialog } from '../contexts/DialogContext';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import ThemeModeControl from './ThemeModeControl';
import { boardPackageKey, resolveBoardPackage } from '../services/board_identity';
import {
  projectPinKey,
  readPinnedProjectPaths,
  togglePinnedProjectPath,
  writePinnedProjectPaths,
} from '../services/project_pins';
import {
  getBrowserBlocklyVisualStyleStorage,
  persistBlocklyVisualStyle,
  readBlocklyVisualStyle,
  type BlocklyVisualStyle,
} from '../services/blockly_visual_style';

const DashboardLibraryManager = lazy(() => import('./LibraryManagerModal'));

interface ProjectInfo {
  name: string;
  path: string;
  board: string;
  board_package_id?: string;
  last_modified: string;
  block_count?: number;
}

interface DashboardProps {
  onOpenProject: (path: string, options?: { forceBoard?: string; forceBoardPackageId?: string; missingBoard?: string; openCheck?: boolean }) => void;
  onNewProject: () => void;
}

const projectBoardExists = (project: ProjectInfo, availableBoards: any[]): boolean => {
  const packageId = String(project.board_package_id || '').trim();
  if (packageId) {
    return availableBoards.some(board => (
      boardPackageKey(board) === packageId
      && String(board?.fqbn || '') === String(project.board || '')
    ));
  }
  return availableBoards.some(board => (
    String(board?.fqbn || '') === String(project.board || '')
    || boardPackageKey(board) === String(project.board || '')
  ));
};

interface ProjectCardGridProps {
  data: ProjectInfo;
  onClick: () => void;
  onRename: () => void;
  onDelete: () => void;
  isSelectionMode: boolean;
  isSelected: boolean;
  availableBoards: any[];
  isPinned: boolean;
  onTogglePin: () => void;
  canPin: boolean;
}

interface ProjectRowListProps {
  data: ProjectInfo;
  onClick: () => void;
  onRename: () => void;
  onDelete: () => void;
  isSelectionMode: boolean;
  isSelected: boolean;
  availableBoards: any[];
  dialog: ReturnType<typeof useDialog>;
  isPinned: boolean;
  onTogglePin: () => void;
  canPin: boolean;
}

function resolveBoardArtworkSrc(board: string, boardPkg?: any): string {
  const rawIcon = String(boardPkg?.icon || '').trim();
  if (rawIcon) {
    if (rawIcon.startsWith('/') || rawIcon.startsWith('http://') || rawIcon.startsWith('https://')) {
      return rawIcon;
    }
    try {
      const isAbsolute = /^[a-zA-Z]:/.test(rawIcon);
      if (isAbsolute) {
        return convertFileSrc(rawIcon);
      }
      const rawPath = String(boardPkg?.path || '').trim();
      if (rawPath) {
        const cleanPath = rawPath.replace(/\\/g, '/');
        const prefix = cleanPath.endsWith('/') ? cleanPath : `${cleanPath}/`;
        return convertFileSrc(prefix + rawIcon.replace(/\\/g, '/'));
      }
      return convertFileSrc(rawIcon);
    } catch {
      // Fall through to built-in board icon
    }
  }
  return getBoardIcon(String(board || '').split(':').slice(0, 3).join(':'));
}

function isImageArtworkSrc(src: string): boolean {
  return src.startsWith('/') || src.includes('://') || src.includes('asset');
}

function getBoardTag(board: string, boardPkg?: any): string {
  if (boardPkg?.is_custom && typeof boardPkg?.name === 'string' && boardPkg.name.trim()) {
    const fullName = boardPkg.name.trim();
    const vendor = String(boardPkg?.catalog_vendor || boardPkg?.vendor || '').trim();
    if (vendor && fullName.toLowerCase().startsWith(`${vendor.toLowerCase()} `)) {
      const shortName = fullName.slice(vendor.length).trim();
      if (shortName) return shortName;
    }
    return fullName;
  }
  try {
    const parts = String(board || '').split(':');
    return parts[2] || board;
  } catch {
    return board;
  }
}

function boardFamily(board: string) {
  const [vendor, arch] = board.toLowerCase().split(':');
  if (!arch) return '';
  if (vendor === 'arduino' && arch === 'avr') return 'Arduino AVR';
  return vendor === arch ? arch.toUpperCase() : `${vendor} ${arch.toUpperCase()}`;
}

function BoardArtwork({ board, boardPkg, missing = false }: { board: string; boardPkg?: any; missing?: boolean }) {
  const primary = resolveBoardArtworkSrc(board, boardPkg);
  const fallback = getBoardIcon(String(board || '').split(':').slice(0, 3).join(':'));
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const icon = primary && primary !== failedSrc ? primary : fallback;
  return missing ? <AlertTriangle aria-hidden size={28} /> : isImageArtworkSrc(icon)
    ? <img src={icon} alt="" draggable={false} loading="lazy" onError={() => { if (icon !== fallback) setFailedSrc(icon); }} />
    : <Cpu aria-hidden size={36} />;
}

function inferBoardSolidColor(board: string, boardExists: boolean): string {
  if (!boardExists) return 'bg-slate-400';
  const lower = board.toLowerCase();
  if (lower.includes('esp32')) return 'bg-[#5578a3]';
  if (lower.includes('esp8266')) return 'bg-[#6b7f99]';
  if (lower.includes('arduino')) return 'bg-[#5e8ea3]';
  return 'bg-slate-500';
}




export default function UserDashboard({ onOpenProject, onNewProject }: DashboardProps) {
  const softwareUpdate = useDashboardUpdate();
  const { t } = useTranslation();
  const recentSessionPath = useRecentProjectPath();
  const [resourceTab, setResourceTab] = useState<'projects' | 'community' | 'guide' | 'drivers'>('projects');
  const [isLibraryManagerOpen, setIsLibraryManagerOpen] = useState(false);
  const [resourceNotice, setResourceNotice] = useState<{ message: string; error: boolean } | null>(null);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [searchQuery, setSearchQuery] = useState('');
  const [family, setFamily] = useState('all');
  const [visibleCount, setVisibleCount] = useState(20);

  const [isDeviceModalOpen, setIsDeviceModalOpen] = useState(false);
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());

  const { activePort, availableBoards } = useHardware();
  const dialog = useDialog();

  const openResourceLink = async (url: string) => {
    try {
      if ((window as any).__TAURI_INTERNALS__) {
        const { openUrl } = await import('@tauri-apps/plugin-opener');
        await openUrl(url);
      } else {
        const opened = window.open(url, '_blank');
        if (!opened) throw new Error(t('dashboard.resources.browserBlocked'));
        opened.opener = null;
      }
      setResourceNotice(null);
    } catch (error) {
      setResourceNotice({ message: `${t('dashboard.resources.openFailed')} ${url}\n${String(error)}`, error: true });
    }
  };

  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [communityCases, setCommunityCases] = useState<ProjectInfo[]>([]);
  const [pinnedProjectPaths, setPinnedProjectPaths] = useState<string[]>(() => readPinnedProjectPaths());
  const [isLoading, setIsLoading] = useState(true);

  const [actionModal, setActionModal] = useState<{
    type: 'delete' | 'rename' | null;
    project: ProjectInfo | null;
    isOpen: boolean;
  }>({ type: null, project: null, isOpen: false });
  const [isPathSettingsOpen, setIsPathSettingsOpen] = useState(false);
  const [isAppearanceSettingsOpen, setIsAppearanceSettingsOpen] = useState(false);
  const [blocklyVisualStyle, setBlocklyVisualStyle] = useState<BlocklyVisualStyle>(() => (
    readBlocklyVisualStyle(getBrowserBlocklyVisualStyleStorage())
  ));

  useEffect(() => {
    setVisibleCount(20);
  }, [searchQuery, family]);

  const handleLoadMore = () => setVisibleCount((prev) => prev + 20);

  const loadProjects = async () => {
    setIsLoading(true);
    try {
      const isTauri =
        typeof window !== 'undefined' &&
        (((window as any).__TAURI_IPC__ as unknown) ||
          ((window as any).__TAURI_INTERNALS__ as unknown) ||
          ((window as any).__TAURI__ as unknown));

      if (isTauri) {
        const list: ProjectInfo[] = await invoke('list_projects');
        setProjects(list);
      } else {
        // Browser fallback: keep list empty instead of injecting mock entries.
        setProjects([]);
      }
    } catch (e) {
      console.error('Failed to list projects:', e);
    } finally {
      setIsLoading(false);
    }
  };

  const loadCommunityCases = async () => {
    setIsLoading(true);
    try {
      const isTauri =
        typeof window !== 'undefined' &&
        (((window as any).__TAURI_IPC__ as unknown) ||
          ((window as any).__TAURI_INTERNALS__ as unknown) ||
          ((window as any).__TAURI__ as unknown));

      if (isTauri) {
        const list: ProjectInfo[] = await invoke('list_community_examples');
        setCommunityCases(list);
      } else {
        setCommunityCases([]);
      }
    } catch (e) {
      console.error('Failed to list community examples:', e);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (resourceTab === 'projects') {
      void loadProjects();
    } else if (resourceTab === 'community') {
      void loadCommunityCases();
    }
  }, [resourceTab]);

  const handleCreateProject = () => {
    onNewProject();
  };

  const confirmDelete = (project: ProjectInfo) => {
    setActionModal({ type: 'delete', project, isOpen: true });
  };

  const confirmRename = (project: ProjectInfo) => {
    setActionModal({ type: 'rename', project, isOpen: true });
  };

  const handleActionComplete = () => {
    const completedProject = actionModal.project;
    const completedType = actionModal.type;
    setActionModal({ type: null, project: null, isOpen: false });
    if (completedType === 'delete' && completedProject) {
      removeProjectPin(completedProject.path);
    }
    if (resourceTab === 'projects') {
      void loadProjects();
    } else {
      void loadCommunityCases();
    }
  };

  const toggleSelectionMode = () => {
    setIsSelectionMode((prev) => !prev);
    setSelectedPaths(new Set());
  };

  const toggleProjectSelection = (path: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const toggleProjectPin = (path: string) => {
    setPinnedProjectPaths((previous) => {
      const next = togglePinnedProjectPath(previous, path);
      writePinnedProjectPaths(next);
      return next;
    });
  };

  const removeProjectPin = (path: string) => {
    const key = projectPinKey(path);
    setPinnedProjectPaths((previous) => {
      const next = previous.filter((candidate) => projectPinKey(candidate) !== key);
      writePinnedProjectPaths(next);
      return next;
    });
  };

  const sourceItems = resourceTab === 'community' ? communityCases : projects;
  const labelFor = (project: ProjectInfo) => resolveBoardPackage(availableBoards, project.board, project.board_package_id)?.name
    || getBoardName(project.board.split(':').slice(0, 3).join(':'));
  const query = searchQuery.trim().toLowerCase();
  const matches = sourceItems.filter(p => !query || [p.name, p.board, labelFor(p)].some(value => value.toLowerCase().includes(query)));
  const families = [...new Set(projects.map(p => boardFamily(p.board)))].sort();
  const isProjectPinned = (project: ProjectInfo): boolean => pinnedProjectPaths.some(
    (path) => projectPinKey(path) === projectPinKey(project.path),
  );
  const filteredProjects = matches.filter(p => resourceTab !== 'projects' || family === 'all'
    || (family === 'pinned' ? isProjectPinned(p) : boardFamily(p.board) === family)).sort((left, right) => {
    if (resourceTab !== 'projects') return 0;
    const leftPinOrder = pinnedProjectPaths.findIndex(path => projectPinKey(path) === projectPinKey(left.path));
    const rightPinOrder = pinnedProjectPaths.findIndex(path => projectPinKey(path) === projectPinKey(right.path));
    const leftPinned = leftPinOrder >= 0;
    const rightPinned = rightPinOrder >= 0;
    if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
    if (leftPinned && rightPinned) return leftPinOrder - rightPinOrder;
    return 0;
  });

  const latestProject = projects.find(project => project.path === recentSessionPath) || projects[0] || null;
  const latestBoard = latestProject
    ? resolveBoardPackage(availableBoards, latestProject.board, latestProject.board_package_id)
    : undefined;

  const selectedProjects = projects.filter((p) => selectedPaths.has(p.path));
  const selectedCount = selectedProjects.length;
  const allFilteredSelected =
    filteredProjects.length > 0 && filteredProjects.every((p) => selectedPaths.has(p.path));

  const toggleSelectAllFiltered = () => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        filteredProjects.forEach((p) => next.delete(p.path));
      } else {
        filteredProjects.forEach((p) => next.add(p.path));
      }
      return next;
    });
  };

  const handleRenameSelected = () => {
    if (selectedCount !== 1) return;
    confirmRename(selectedProjects[0]);
  };

  const handleDeleteSelected = async () => {
    if (selectedCount === 0) return;

    const confirmed = await dialog.confirm({
      title: t('dashboard.dialog.bulkDelete.title'),
      message: t('dashboard.dialog.bulkDelete.message', { count: selectedCount }),
      type: 'warning',
      confirmLabel: t('common.actions.delete'),
      cancelLabel: t('common.actions.cancel'),
    });
    if (!confirmed) return;

    const failures: string[] = [];
    for (const project of selectedProjects) {
      try {
        await invoke('delete_project', { path: project.path });
        removeProjectPin(project.path);
      } catch (e) {
        failures.push(`${project.name}: ${e}`);
      }
    }

    if (failures.length > 0) {
      await dialog.alert({
        title: t('dashboard.dialog.bulkDelete.partialFailure'),
        message: failures.join('\n'),
        type: 'warning',
      });
    }

    setSelectedPaths(new Set());
    await loadProjects();
  };

  useEffect(() => {
    setIsSelectionMode(false);
    setSelectedPaths(new Set());
  }, [resourceTab]);

  const openProjectWithBoardCheck = (project: ProjectInfo, openCheck = false) => {
    const boardExists = projectBoardExists(project, availableBoards);
    if (!boardExists) {
      onOpenProject(project.path, {
        missingBoard: project.board_package_id || project.board,
        openCheck,
      });
      return;
    }
    onOpenProject(project.path, { openCheck });
  };

  return (
    <div className="ck-home h-screen bg-slate-100 dark:bg-slate-950 flex flex-col overflow-hidden">
      <header className="ck-home-header bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 flex items-center shrink-0">
        {/* Logo */}
        <div className="ck-home-brand flex items-center gap-2.5 shrink-0">
          <BrandLogo className="h-8 w-[52px]" />
          <div className="min-w-0">
            <h1 className="text-sm font-bold">{t('dashboard.home.title')}</h1>
            <p className="text-xs text-slate-500 dark:text-slate-400">{t('dashboard.home.modes')}</p>
          </div>
        </div>

        {/* Search - 占满中间 */}
        <div className={`relative min-w-0 flex-1 max-w-md mr-auto ${resourceTab === 'guide' || resourceTab === 'drivers' ? 'invisible' : ''}`}>
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('dashboard.search.placeholder')}
            aria-label={t('dashboard.search.placeholder')}
            type="search"
            className="w-full h-9 pl-9 pr-3 rounded-full bg-slate-100/80 dark:bg-slate-800 text-sm text-slate-700 dark:text-slate-200 outline-none border border-transparent focus:border-brand-400/60 focus:bg-white dark:focus:bg-slate-900 focus:shadow-sm transition-all duration-200 placeholder:text-slate-400"
          />
        </div>

        <ThemeModeControl />

        <button
          type="button"
          onClick={() => setIsAppearanceSettingsOpen(true)}
          title={t('settings.title')}
          aria-label={t('settings.openAria')}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 transition-colors hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400 dark:hover:border-brand-700 dark:hover:bg-brand-950/40 dark:hover:text-brand-300"
        >
          <Settings size={16} />
        </button>

        {/* COM Port Capsule */}
        <button
          onClick={() => setIsDeviceModalOpen(true)}
          className={`com-capsule h-9 px-4 rounded-full flex items-center gap-2.5 transition-all duration-300 cursor-pointer select-none shrink-0
            ${activePort
              ? 'bg-gradient-to-r from-emerald-600 to-emerald-700 text-white shadow-md shadow-emerald-500/25 hover:shadow-lg hover:shadow-emerald-500/30 hover:scale-[1.02] active:scale-[0.98]'
              : 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-200/80 dark:border-slate-700 hover:border-brand-300 dark:hover:border-brand-700 hover:bg-brand-50 dark:hover:bg-brand-900/20 hover:text-brand-600 dark:hover:text-brand-400 hover:shadow-sm active:scale-[0.97]'
            }`}
          title={t('dashboard.header.connectDevice')}
        >
          {/* Status Dot */}
          <span className={`relative flex h-2 w-2`}>
            <span className={`relative inline-flex rounded-full h-2 w-2 ${activePort ? 'bg-white' : 'bg-amber-400'}`}></span>
          </span>
          <Usb size={14} strokeWidth={2.5} />
          <span className="text-xs font-semibold">{activePort || t('dashboard.home.awaitDevice')}</span>
        </button>
        <button type="button" onClick={handleCreateProject} className="ck-home-primary"><Plus size={16} />{t('dashboard.actions.newProject')}</button>
      </header>

      <main className="flex-1 min-h-0 flex overflow-hidden">
        <aside className="ck-home-sidebar flex shrink-0 border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-5 flex-col gap-1.5 overflow-y-auto">
          <p className="text-xs font-bold text-slate-400 px-2 tracking-wide">{t('dashboard.sidebar.resourceManager')}</p>
          <button
            onClick={() => setResourceTab('projects')}
            className={`h-10 px-3 rounded-xl font-semibold text-left flex items-center gap-2 ${resourceTab === 'projects'
              ? 'bg-brand-50 text-brand-700 dark:bg-brand-900/30 dark:text-brand-300'
              : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
          >
            <Box size={16} /> {t('dashboard.sidebar.myProjects')}
            <span className="ml-auto text-xs tabular-nums">{projects.length}</span>
          </button>
          <button type="button" onClick={() => setIsLibraryManagerOpen(true)} className="h-10 px-3 rounded-xl text-slate-600 dark:text-slate-300 text-left flex items-center gap-2 hover:bg-slate-100 dark:hover:bg-slate-800">
            <Cpu size={16} /> {t('dashboard.sidebar.componentLibrary')}
          </button>

          <p className="text-xs font-bold text-slate-400 px-2 mt-3 tracking-wide">{t('dashboard.sidebar.hardwareEcosystem')}</p>
          <button
            onClick={() => setResourceTab('community')}
            className={`h-10 px-3 rounded-xl text-left flex items-center gap-2 ${resourceTab === 'community'
              ? 'bg-brand-50 text-brand-700 dark:bg-brand-900/30 dark:text-brand-300 font-semibold'
              : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
          >
            <Copy size={16} /> {t('dashboard.sidebar.communityExamples')}
          </button>
          <button type="button" onClick={() => setResourceTab('guide')} aria-current={resourceTab === 'guide' ? 'page' : undefined} className={`h-10 px-3 rounded-xl text-left flex items-center gap-2 ${resourceTab === 'guide' ? 'bg-brand-50 text-brand-700 dark:bg-brand-900/30 dark:text-brand-300 font-semibold' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'}`}>
            <BookOpen size={16} /> {t('dashboard.sidebar.wiki')}
          </button>
          <button type="button" onClick={() => setResourceTab('drivers')} aria-current={resourceTab === 'drivers' ? 'page' : undefined} className={`h-10 px-3 rounded-xl text-left flex items-center gap-2 ${resourceTab === 'drivers' ? 'bg-brand-50 text-brand-700 dark:bg-brand-900/30 dark:text-brand-300 font-semibold' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'}`}>
            <Download size={16} /> {t('dashboard.sidebar.driverDownloads')}
          </button>
          <div className="mt-auto border-t border-slate-200 pt-4 dark:border-slate-800">
            <button type="button" onClick={() => setIsPathSettingsOpen(true)} aria-label={t('dashboard.storage.openAria')} className="ck-home-storage">
              <FolderOpen size={16}/>{t('dashboard.storage.title')}<ChevronRight size={14} className="ml-auto"/>
            </button>
            <button type="button" data-ck-action="copy-official-qq-group" onClick={async () => {
              try { await navigator.clipboard.writeText(CK_OFFICIAL_QQ_GROUP); setResourceNotice({ message: uiText(`已复制 CK LAB 官方QQ群：${CK_OFFICIAL_QQ_GROUP}`, `Copied CK LAB QQ Group: ${CK_OFFICIAL_QQ_GROUP}`), error: false }); }
              catch { setResourceNotice({ message: uiText(`请在 QQ 搜索群号：${CK_OFFICIAL_QQ_GROUP}`, `Search QQ Group ID: ${CK_OFFICIAL_QQ_GROUP}`), error: false }); }
            }} className="mb-2 flex w-full items-center justify-between gap-2 rounded-xl border border-brand-100 bg-brand-50 px-3 py-3 text-left text-brand-700 hover:bg-brand-100 dark:border-brand-900 dark:bg-brand-950/40 dark:text-brand-300">
              <span><span className="block text-xs font-bold">{uiText('CK LAB 官方QQ群', 'CK LAB Official QQ Group')}</span><span className="mt-1 block text-sm font-semibold tracking-wide">{CK_OFFICIAL_QQ_GROUP}</span></span><Copy size={15} />
            </button>
            <button type="button" onClick={() => void openResourceLink(CK_LAB)} className="flex w-full items-center justify-between rounded-xl px-3 py-3 text-sm font-bold text-slate-700 hover:bg-brand-50 hover:text-brand-700 dark:text-slate-200 dark:hover:bg-slate-800">
              CK LAB <ExternalLink size={14} />
            </button>
            <p className="px-3 text-[11px] leading-5 text-slate-400">{t('dashboard.resources.labSubtitle')}</p>
          </div>
        </aside>

        <section className="min-w-0 flex-1 overflow-auto">
          <div className="ck-home-canvas">
          {resourceNotice && <div role={resourceNotice.error ? 'alert' : 'status'} className="mb-4 flex items-start justify-between gap-3 whitespace-pre-wrap break-all rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
            {resourceNotice.message}<button type="button" aria-label={t('common.actions.close')} onClick={() => setResourceNotice(null)}><X size={16} /></button>
          </div>}
          {resourceTab === 'guide' || resourceTab === 'drivers' ? <DashboardResources section={resourceTab} onOpenLink={url => void openResourceLink(url)} /> : <>
          {resourceTab === 'projects' && latestProject && !query && !isLoading ? (
            <div key={latestProject.path} className="mb-5 min-w-0 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
            <div className="flex min-w-0 flex-wrap items-center gap-3">
              <span className="ck-home-thumb"><BoardArtwork board={latestProject.board} boardPkg={latestBoard} missing={!latestBoard}/></span>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-bold text-brand-600 dark:text-brand-300">{t('dashboard.home.lastProject')}</p>
                <h2 className="truncate text-lg font-bold text-slate-900 dark:text-slate-100" title={latestProject.name}>
                  {latestProject.name}
                </h2>
                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                  {t('dashboard.hero.lastModified', {
                      boardName: labelFor(latestProject),
                      date: latestProject.last_modified,
                    })}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <button type="button" className="ck-home-secondary" onClick={() => openProjectWithBoardCheck(latestProject, true)}>{t('dashboard.home.check')}</button>
                  <button
                    type="button"
                    onClick={() => openProjectWithBoardCheck(latestProject)}
                    className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand-600 px-4 text-sm font-bold text-white shadow-sm transition-colors hover:bg-brand-700"
                  >
                    {t('dashboard.actions.continueProject')} <ChevronRight size={16} />
                  </button>
              </div>
            </div>
            <details className="ck-home-history"><summary>{t('dashboard.home.history')}</summary>
              <DashboardProjectStatus path={latestProject.path} name={latestProject.name}
                board={latestBoard?.name || latestProject.board}
                onOpenCheck={() => openProjectWithBoardCheck(latestProject, true)} />
            </details>
            </div>
          ) : null}

          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h2 className="text-lg font-bold tracking-tight text-slate-800 dark:text-slate-100">
                {t(resourceTab === 'projects' ? 'dashboard.sidebar.myProjects' : 'dashboard.sidebar.communityExamples')}
              </h2>
              {resourceTab === 'projects' && projects.length > 0 && <div className="ck-home-filters" role="group" aria-label={t('dashboard.home.filter')}>
                {['all', ...families, 'pinned'].map(key => <button type="button" key={key} aria-pressed={family === key}
                  onClick={() => {setFamily(key); setSelectedPaths(new Set());}}>
                  {key === 'pinned' && <Pin size={12}/>}
                  {key === 'all' ? t('dashboard.home.all') : key === 'pinned' ? t('dashboard.project.pinned') : key || t('dashboard.home.other')}
                  <small>{key === 'all' ? matches.length : matches.filter(p => key === 'pinned' ? isProjectPinned(p) : boardFamily(p.board) === key).length}</small>
                </button>)}
              </div>}
            </div>
            <div className="flex items-center gap-2">
              {resourceTab === 'community' ? (
                <button
                  onClick={async () => {
                    try {
                      const dir = await invoke<string>('get_community_examples_dir_cmd');
                      await invoke('show_in_folder', { path: dir });
                    } catch (e) {
                      console.error('Failed to open community examples dir', e);
                    }
                  }}
                  className="h-10 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 text-sm font-medium hover:text-brand-600 dark:hover:text-brand-400 transition-colors flex items-center gap-2"
                >
                  <FolderOpen size={16} />
                  {t('dashboard.actions.openExamplesFolder')}
                </button>
              ) : null}
              {resourceTab === 'projects' ? (
                <button
                  onClick={toggleSelectionMode}
                  className="h-10 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 text-sm font-medium hover:border-brand-200 dark:hover:border-brand-800 hover:text-brand-600 dark:hover:text-brand-400 transition-colors"
                >
                  {t(isSelectionMode ? 'dashboard.actions.exitMultiSelect' : 'dashboard.actions.selectMultiple')}
                </button>
              ) : null}
              <div className="ck-home-switch">
                {(['grid','list'] as const).map(mode => <button key={mode} type="button" onClick={() => setViewMode(mode)} aria-pressed={viewMode === mode}>
                  {mode === 'grid' ? <LayoutGrid size={15}/> : <List size={15}/>} {t(`dashboard.view.${mode}`)}
                </button>)}
              </div>
            </div>
          </div>

          {resourceTab === 'community' && <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-brand-100 bg-brand-50/70 p-4 text-sm dark:border-brand-900 dark:bg-brand-950/30">
            <p className="text-slate-600 dark:text-slate-300">{t('dashboard.resources.examplesHint')}</p>
            <button type="button" onClick={() => void openResourceLink(`${CK_LAB}/examples/`)} className="inline-flex items-center gap-2 font-bold text-brand-700 dark:text-brand-300">{t('dashboard.resources.onlineExamples')}<ExternalLink size={14} /></button>
          </div>}

          {resourceTab === 'projects' && isSelectionMode ? (
            <div className="mb-4 rounded-xl border border-brand-200/80 bg-brand-50/70 dark:border-brand-800/60 dark:bg-brand-950/30 px-3 py-2 flex items-center justify-between gap-2">
              <div className="text-sm font-medium text-slate-700 dark:text-slate-200">
                {t('dashboard.selection.selected', { count: selectedCount })}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={toggleSelectAllFiltered}
                  className="h-8 px-3 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:text-brand-600 dark:hover:text-brand-300 hover:border-brand-200 dark:hover:border-brand-800 text-sm transition-colors"
                >
                  {t(allFilteredSelected ? 'dashboard.actions.deselectAll' : 'dashboard.actions.selectAllCurrent')}
                </button>
                <button
                  onClick={handleRenameSelected}
                  disabled={selectedCount !== 1}
                  className="h-8 px-3 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:text-brand-600 dark:hover:text-brand-300 hover:border-brand-200 dark:hover:border-brand-800 text-sm disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1 transition-colors"
                >
                  <FileEdit size={14} />
                  {t('common.actions.rename')}
                </button>
                <button
                  onClick={handleDeleteSelected}
                  disabled={selectedCount === 0}
                  className="h-8 px-3 rounded-lg bg-red-600 text-white hover:bg-red-700 text-sm disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1 transition-colors"
                >
                  <Trash2 size={14} />
                  {t('common.actions.delete')}
                </button>
              </div>
            </div>
          ) : null}

          {isLoading ? (
            <div className="flex flex-col items-center justify-center h-40 text-slate-400">
              <Loader2 size={32} className="animate-spin mb-2" />
              <p>{t('common.status.loading')}</p>
            </div>
          ) : filteredProjects.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-52 text-slate-400 bg-slate-100/60 dark:bg-slate-900 border border-dashed border-slate-300 dark:border-slate-700 rounded-xl">
              <Box size={40} className="mb-2 opacity-60" />
              <p>{t(resourceTab === 'projects' ? 'dashboard.empty.noProjects' : 'dashboard.empty.noExamples')}</p>
              {resourceTab === 'projects' && projects.length === 0 ? (
                <button onClick={handleCreateProject} className="text-brand-600 dark:text-brand-300 font-bold hover:underline mt-2">
                  {t('dashboard.actions.newProject')}
                </button>
              ) : resourceTab === 'projects' && (query || family !== 'all') ? <button type="button" className="ck-home-secondary mt-2" onClick={() => {setSearchQuery(''); setFamily('all');}}>{t('dashboard.home.clear')}</button> : null}
            </div>
          ) : viewMode === 'grid' ? (
            <div className="ck-home-grid">
              {filteredProjects.slice(0, visibleCount).map((project) => (
                <ProjectCardGrid
                  key={project.path}
                  data={project}
                  onClick={() => {
                    if (isSelectionMode) {
                      toggleProjectSelection(project.path);
                      return;
                    }
                    openProjectWithBoardCheck(project);
                  }}
                  onRename={() => confirmRename(project)}
                  onDelete={() => confirmDelete(project)}
                  onTogglePin={() => toggleProjectPin(project.path)}
                  isSelectionMode={isSelectionMode}
                  isSelected={selectedPaths.has(project.path)}
                  availableBoards={availableBoards}
                  isPinned={resourceTab === 'projects' && isProjectPinned(project)}
                  canPin={resourceTab === 'projects'}
                />
              ))}
            </div>
          ) : (
            <div className="relative bg-white dark:bg-slate-900 rounded-xl shadow-sm border border-slate-200 dark:border-slate-800 overflow-visible pb-10">
              <div className="grid grid-cols-12 gap-4 px-6 py-3 border-b border-slate-100 dark:border-slate-800 text-xs font-bold text-slate-400 uppercase tracking-wider">
                {isSelectionMode && <div className="col-span-1">{t('dashboard.table.select')}</div>}
                <div className={isSelectionMode ? 'col-span-3' : 'col-span-4'}>{t('dashboard.table.projectName')}</div>
                <div className="col-span-3">{t('dashboard.table.board')}</div>
                <div className="col-span-3">{t('dashboard.table.lastModified')}</div>
                <div className="col-span-2 text-right">{t('dashboard.table.actions')}</div>
              </div>
              {filteredProjects.slice(0, visibleCount).map((project) => (
                <ProjectRowList
                  key={project.path}
                  data={project}
                  onClick={() => {
                    if (isSelectionMode) {
                      toggleProjectSelection(project.path);
                      return;
                    }
                    openProjectWithBoardCheck(project);
                  }}
                  onRename={() => confirmRename(project)}
                  onDelete={() => confirmDelete(project)}
                  onTogglePin={() => toggleProjectPin(project.path)}
                  isSelectionMode={isSelectionMode}
                  isSelected={selectedPaths.has(project.path)}
                  dialog={dialog}
                  availableBoards={availableBoards}
                  isPinned={resourceTab === 'projects' && isProjectPinned(project)}
                  canPin={resourceTab === 'projects'}
                />
              ))}
            </div>
          )}

          {!isLoading && filteredProjects.length > visibleCount && (
            <div className="flex justify-center mt-6 pb-8">
              <button
                onClick={handleLoadMore}
                className="px-6 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 rounded-full shadow-sm hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-brand-600 dark:hover:text-brand-400 font-medium transition-all duration-200 flex items-center"
              >
                <ArrowDown size={16} className="mr-2" />
                {t('dashboard.actions.loadMore', { count: filteredProjects.length - visibleCount })}
              </button>
            </div>
          )}
          </>}
          </div>
        </section>
      </main>

      <ActionModal
        isOpen={actionModal.isOpen}
        type={actionModal.type}
        project={actionModal.project}
        onClose={() => setActionModal({ type: null, project: null, isOpen: false })}
        onSuccess={handleActionComplete}
      />

      <ProjectPathSettingsModal
        isOpen={isPathSettingsOpen}
        onClose={() => setIsPathSettingsOpen(false)}
        onSaved={() => {
          setIsPathSettingsOpen(false);
          if (resourceTab === 'projects') void loadProjects();
        }}
      />
      <DeviceSelectorModal isOpen={isDeviceModalOpen} onClose={() => setIsDeviceModalOpen(false)} />
      {isLibraryManagerOpen && <Suspense fallback={<div role="status" className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 text-white"><Loader2 className="animate-spin" />{t('common.status.loading')}</div>}>
        <DashboardLibraryManager isOpen projectPath="" onClose={() => setIsLibraryManagerOpen(false)} showToast={(message, type) => setResourceNotice({ message, error: type === 'error' })} />
      </Suspense>}
      <AppearanceSettingsModal
        updateSettings={<>{softwareUpdate.settings}<DataStorageSettings /></>}
        isOpen={isAppearanceSettingsOpen}
        blocklyVisualStyle={blocklyVisualStyle}
        onBlocklyVisualStyleChange={(style) => {
          const persisted = persistBlocklyVisualStyle(style, getBrowserBlocklyVisualStyleStorage());
          setBlocklyVisualStyle(persisted);
        }}
        onClose={() => setIsAppearanceSettingsOpen(false)}
      />
      {softwareUpdate.dialog}
    </div>
  );
}

const ProjectCardGrid = ({
  data,
  onClick,
  onRename,
  onDelete,
  onTogglePin,
  isSelectionMode,
  isSelected,
  availableBoards,
  isPinned,
  canPin,
}: ProjectCardGridProps) => {
  const { t } = useTranslation();
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  const boardExists = availableBoards ? projectBoardExists(data, availableBoards) : true;
  const boardPkg = resolveBoardPackage(availableBoards, data.board, data.board_package_id);
  const label = boardPkg?.name || getBoardName(data.board.split(':').slice(0,3).join(':'));

  return (
    <div
      onClick={onClick}
      className={`bg-white dark:bg-slate-900 rounded-2xl border shadow-sm hover:shadow-lg hover:-translate-y-0.5 transition-all duration-200 group cursor-pointer overflow-hidden flex flex-col min-w-0 relative ${isSelected ? 'ring-2 ring-brand-500 border-brand-500 dark:border-brand-500' : 'border-slate-200 dark:border-slate-800'
        }`}
    >
      {!boardExists && (
        <div className={`absolute top-2 z-30 bg-red-500 text-white text-[10px] px-2 py-0.5 rounded-full font-bold shadow-sm uppercase tracking-wider flex items-center ${isPinned ? 'left-12' : 'left-2'}`}>
          <AlertTriangle size={10} className="mr-1" /> {t('dashboard.project.missing')}
        </div>
      )}

      {canPin && isPinned && !isSelectionMode && (
        <span
          className="absolute left-3 top-3 z-30 inline-flex h-7 w-7 items-center justify-center rounded-full border border-white/70 bg-brand-600 text-white shadow-md"
          title={t('dashboard.project.pinned')}
          aria-label={t('dashboard.project.pinned')}
        >
          <Pin size={13} fill="currentColor" />
        </span>
      )}

      {isSelectionMode && (
        <div className="absolute top-2 left-2 z-30">
          <div
            className={`w-5 h-5 rounded border flex items-center justify-center ${isSelected ? 'bg-brand-500 border-brand-500' : 'bg-white dark:bg-slate-800 border-slate-300 dark:border-slate-600'
              }`}
          >
            {isSelected && <div className="w-2.5 h-1.5 border-b-2 border-l-2 border-white transform -rotate-45 mb-0.5"></div>}
          </div>
        </div>
      )}

      <div className="ck-home-cover relative" data-family={boardFamily(data.board)}>
        <BoardArtwork board={data.board} boardPkg={boardPkg} missing={!boardExists}/>

        <div className="absolute top-2 right-2 max-w-[80%] flex justify-end z-20">
          <span
            className="bg-black/60 text-white text-[10px] px-2 py-0.5 rounded-full font-mono border border-white/20 truncate max-w-full shadow-sm"
            title={boardPkg?.name || data.board}
          >
            {getBoardTag(data.board, boardPkg).toUpperCase()}
          </span>
        </div>
      </div>

      <div className="p-3 flex-1 flex flex-col bg-white dark:bg-slate-900">
        <h3 className="font-bold text-slate-800 dark:text-slate-200 truncate" title={data.name}>
          <button type="button" className="block w-full truncate text-left" onClick={e => {e.stopPropagation(); onClick();}}>{data.name}</button>
        </h3>
        <p className="mb-3 truncate text-xs text-slate-500 dark:text-slate-400" title={label}>{typeof data.block_count === 'number' && `${t('dashboard.home.blocks', {count:data.block_count})} · `}{label}</p>

        <div className="flex justify-between items-center mt-auto pt-1 border-t border-slate-100 dark:border-slate-800">
          <span className="text-xs text-slate-500 dark:text-slate-500 flex items-center">
            <Clock size={12} className="mr-1" /> {data.last_modified}
          </span>

          {!isSelectionMode && (
            <div className="flex items-center gap-1">
              {canPin ? <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onTogglePin();
                }}
                title={t(isPinned ? 'dashboard.project.unpin' : 'dashboard.project.pin')}
                aria-label={t(isPinned ? 'dashboard.project.unpinNamed' : 'dashboard.project.pinNamed', { projectName: data.name })}
                aria-pressed={isPinned}
                className={`inline-flex h-9 w-9 items-center justify-center rounded-lg transition-colors ${isPinned
                  ? 'text-brand-600 hover:bg-brand-50 dark:text-brand-300 dark:hover:bg-brand-950/50'
                  : 'text-slate-300 hover:bg-slate-100 hover:text-brand-600 dark:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-brand-300'
                  }`}
              >
                {isPinned ? <Pin size={16} fill="currentColor" /> : <Pin size={16} />}
              </button> : null}
              <div
                className="relative"
              tabIndex={0}
              onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                  setIsMenuOpen(false);
                }
              }}
            >
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setIsMenuOpen(!isMenuOpen);
                }}
                title={t('common.actions.more')}
                className={`h-9 w-9 flex items-center justify-center rounded-lg transition-colors ${isMenuOpen
                  ? 'bg-slate-100 dark:bg-slate-800 text-brand-600 dark:text-brand-400'
                  : 'text-slate-500 dark:text-slate-400 hover:text-brand-600 dark:hover:text-brand-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                  }`}
              >
                <MoreVertical size={20} />
              </button>

              {isMenuOpen && (
                <div className="absolute right-0 bottom-full mb-1 w-32 bg-white dark:bg-slate-800 rounded-lg shadow-xl border border-slate-100 dark:border-slate-700 overflow-hidden py-1 z-50 animate-in fade-in zoom-in-95 duration-100 origin-bottom-right">
                  {canPin ? <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onTogglePin();
                      setIsMenuOpen(false);
                    }}
                    className="w-full text-left px-4 py-2 text-sm text-slate-600 dark:text-slate-300 hover:bg-brand-50 dark:hover:bg-brand-900/20 hover:text-brand-600 dark:hover:text-brand-400 flex items-center"
                  >
                    {isPinned ? <PinOff size={14} className="mr-2" /> : <Pin size={14} className="mr-2" />}
                    {t(isPinned ? 'dashboard.project.unpinShort' : 'dashboard.project.pin')}
                  </button> : null}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onRename();
                      setIsMenuOpen(false);
                    }}
                    className="w-full text-left px-4 py-2 text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 hover:text-brand-600 dark:hover:text-brand-400 flex items-center"
                  >
                    <FileEdit size={14} className="mr-2" /> {t('common.actions.rename')}
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete();
                      setIsMenuOpen(false);
                    }}
                    className="w-full text-left px-4 py-2 text-sm text-slate-600 dark:text-slate-300 hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-500 dark:hover:text-red-400 flex items-center"
                  >
                    <Trash2 size={14} className="mr-2" /> {t('common.actions.delete')}
                  </button>
                </div>
              )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const ProjectRowList = ({ data, onClick, onRename, onDelete, onTogglePin, isSelectionMode, isSelected, dialog, availableBoards, isPinned, canPin }: ProjectRowListProps) => {
  const { t } = useTranslation();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const boardExists = availableBoards ? projectBoardExists(data, availableBoards) : true;
  const boardPkg = resolveBoardPackage(availableBoards, data.board, data.board_package_id);
  const icon = boardExists ? resolveBoardArtworkSrc(data.board, boardPkg) : '';
  const color = inferBoardSolidColor(data.board, boardExists);

  return (
    <div
      onClick={onClick}
      className={`grid grid-cols-12 gap-4 px-6 py-4 border-b border-slate-50 dark:border-slate-800 items-center hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors cursor-pointer group ${isSelected ? 'bg-brand-50/50 dark:bg-brand-900/20' : ''
        }`}
    >
      {isSelectionMode && (
        <div className="col-span-1">
          <div
            className={`w-5 h-5 rounded border flex items-center justify-center ${isSelected ? 'bg-brand-500 border-brand-500' : 'bg-white dark:bg-slate-800 border-slate-300 dark:border-slate-600'
              }`}
          >
            {isSelected && <div className="w-2.5 h-1.5 border-b-2 border-l-2 border-white transform -rotate-45 mb-0.5"></div>}
          </div>
        </div>
      )}

      <div className={isSelectionMode ? 'col-span-3 flex items-center' : 'col-span-4 flex items-center'}>
        <div className={`w-10 h-10 ${color} rounded-md flex items-center justify-center text-sm shadow-sm mr-3 text-white overflow-hidden relative`}>
          {!boardExists && (
            <div className="absolute inset-0 bg-red-500/50 flex items-center justify-center">
              <AlertTriangle size={16} />
            </div>
          )}
          {boardExists && isImageArtworkSrc(icon) ? (
            <img src={icon} alt={boardPkg?.name || data.board} loading="lazy" decoding="async" className="max-w-full max-h-full w-auto h-auto object-contain p-1" />
          ) : !boardExists ? (
            <AlertTriangle size={16} />
          ) : (
            <span>{icon}</span>
          )}
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <div className="font-bold text-slate-700 dark:text-slate-200 text-sm truncate">{data.name}</div>
          {canPin && isPinned && !isSelectionMode ? <Pin size={13} className="shrink-0 text-brand-600 dark:text-brand-300" fill="currentColor" aria-label={t('dashboard.project.pinned')} /> : null}
        </div>
      </div>

      <div className="col-span-3 flex flex-col justify-center space-y-1 overflow-hidden">
        <div>
          <span
            className="inline-flex items-center px-2 py-0.5 rounded text-xs font-mono font-medium bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700 truncate"
            title={boardPkg?.name || data.board}
          >
            {getBoardTag(data.board, boardPkg)}
          </span>
        </div>

        <div className="flex items-center group/path w-full">
          <div
            className="text-[10px] text-slate-400 font-mono truncate mr-1.5 cursor-pointer hover:text-brand-600 dark:hover:text-brand-400"
            title={data.path}
          >
            {data.path}
          </div>
          <div className="flex opacity-0 group-hover/path:opacity-100 transition-opacity space-x-0.5 shrink-0 bg-white dark:bg-slate-800">
            <button
              onClick={(e) => {
                e.stopPropagation();
                navigator.clipboard.writeText(data.path);
                dialog.alert({
                  type: 'success',
                  message: t('dashboard.project.pathCopied'),
                  title: t('dashboard.project.copiedTitle'),
                });
              }}
              title={t('common.actions.copyPath')}
              className="p-0.5 text-slate-400 hover:text-brand-600 dark:hover:text-brand-400 rounded hover:bg-slate-100 dark:hover:bg-slate-700"
            >
              <Copy size={10} />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                invoke('show_in_folder', { path: data.path }).catch(console.error);
              }}
              title={t('common.actions.openFolder')}
              className="p-0.5 text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 rounded hover:bg-slate-100 dark:hover:bg-slate-700"
            >
              <FolderOpen size={10} />
            </button>
          </div>
        </div>
      </div>

      <div className="col-span-3 text-sm text-slate-500 dark:text-slate-500 text-xs">{data.last_modified}</div>
      <div className="col-span-2 text-right flex justify-end space-x-2 relative">
        {!isSelectionMode && (
          <div
            className="flex items-center gap-1 relative"
            tabIndex={0}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node)) setIsMenuOpen(false);
            }}
          >
            {canPin ? <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onTogglePin();
              }}
              title={t(isPinned ? 'dashboard.project.unpin' : 'dashboard.project.pin')}
              aria-label={t(isPinned ? 'dashboard.project.unpinNamed' : 'dashboard.project.pinNamed', { projectName: data.name })}
              aria-pressed={isPinned}
              className={`inline-flex h-8 w-8 items-center justify-center rounded-lg transition-colors ${isPinned
                ? 'text-brand-600 hover:bg-brand-50 dark:text-brand-300 dark:hover:bg-brand-950/50'
                : 'text-slate-400 hover:bg-slate-100 hover:text-brand-600 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-brand-300'
                }`}
            >
              {isPinned ? <Pin size={16} fill="currentColor" /> : <Pin size={16} />}
            </button> : null}
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setIsMenuOpen((previous) => !previous);
              }}
              className="h-8 w-8 flex items-center justify-center hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg text-slate-400 hover:text-brand-600 dark:hover:text-brand-400 transition-colors"
              title={t('common.actions.more')}
            >
              <MoreVertical size={18} />
            </button>
            {isMenuOpen && <div className="absolute right-0 bottom-full mb-1 w-32 bg-white dark:bg-slate-800 rounded-lg shadow-xl border border-slate-100 dark:border-slate-700 overflow-hidden py-1 z-50 animate-in fade-in zoom-in-95 duration-100 origin-bottom-right">
              {canPin ? <button
                onClick={(e) => {
                  e.stopPropagation();
                  onTogglePin();
                  setIsMenuOpen(false);
                }}
                className="w-full text-left px-4 py-2 text-sm text-slate-600 dark:text-slate-300 hover:bg-brand-50 dark:hover:bg-brand-900/20 hover:text-brand-600 dark:hover:text-brand-400 flex items-center"
              >
                {isPinned ? <PinOff size={14} className="mr-2" /> : <Pin size={14} className="mr-2" />}
                {t(isPinned ? 'dashboard.project.unpinShort' : 'dashboard.project.pin')}
              </button> : null}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onRename();
                  setIsMenuOpen(false);
                }}
                className="w-full text-left px-4 py-2 text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 hover:text-brand-600 dark:hover:text-brand-400 flex items-center"
              >
                <FileEdit size={14} className="mr-2" /> {t('common.actions.rename')}
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete();
                  setIsMenuOpen(false);
                }}
                className="w-full text-left px-4 py-2 text-sm text-slate-600 dark:text-slate-300 hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-500 dark:hover:text-red-400 flex items-center"
              >
                <Trash2 size={14} className="mr-2" /> {t('common.actions.delete')}
              </button>
            </div>}
          </div>
        )}
      </div>
    </div>
  );
};

const ProjectPathSettingsModal = ({
  isOpen,
  onClose,
  onSaved,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
}) => {
  const { t } = useTranslation();
  const [view, setView] = useState<'storage' | 'diagnostics'>('storage');
  const [paths, setPaths] = useState<string[]>([]);
  const [systemPaths, setSystemPaths] = useState<[string, string, boolean][]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDiagnosticsLoading, setIsDiagnosticsLoading] = useState(false);
  const [error, setError] = useState('');

  const loadPaths = async () => {
    setIsLoading(true);
    setError('');
    try {
      const roots = await invoke<string[]>('get_project_roots');
      setPaths(Array.isArray(roots) ? roots.filter((path) => typeof path === 'string' && path.trim()) : []);
    } catch (cause) {
      setError(t('dashboard.storage.errors.readRoots', { cause: String(cause) }));
    } finally {
      setIsLoading(false);
    }
  };

  const loadDiagnostics = async () => {
    setIsDiagnosticsLoading(true);
    setError('');
    try {
      const result = await invoke<[string, string, boolean][]>('get_system_paths');
      setSystemPaths(Array.isArray(result) ? result : []);
    } catch (cause) {
      setSystemPaths([]);
      setError(t('dashboard.storage.errors.readDiagnostics', { cause: String(cause) }));
    } finally {
      setIsDiagnosticsLoading(false);
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    setView('storage');
    setSystemPaths([]);
    void loadPaths();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || isSaving) return;
      event.preventDefault();
      if (view === 'diagnostics') setView('storage');
      else onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isSaving, onClose, view]);

  const handleAddPath = async () => {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: t('dashboard.storage.chooseFolder'),
      });
      if (typeof selected !== 'string' || !selected.trim()) return;
      const normalized = selected.trim();
      setPaths((previous) => (
        previous.some((path) => path.toLocaleLowerCase() === normalized.toLocaleLowerCase())
          ? previous
          : [...previous, normalized]
      ));
    } catch (cause) {
      setError(t('dashboard.storage.errors.chooseFolder', { cause: String(cause) }));
    }
  };

  const makeDefault = (index: number) => {
    if (index <= 0) return;
    setPaths((previous) => {
      const next = [...previous];
      const [selected] = next.splice(index, 1);
      if (!selected) return previous;
      next.unshift(selected);
      return next;
    });
  };

  const removePath = (index: number) => {
    setPaths((previous) => previous.filter((_, pathIndex) => pathIndex !== index));
  };

  const handleSave = async () => {
    const cleaned = paths
      .map((path) => path.trim())
      .filter((path, index, all) => (
        Boolean(path)
        && all.findIndex((candidate) => candidate.toLocaleLowerCase() === path.toLocaleLowerCase()) === index
      ));
    if (cleaned.length === 0) {
      setError(t('dashboard.storage.errors.keepOne'));
      return;
    }

    setIsSaving(true);
    setError('');
    try {
      await invoke('set_project_roots', { paths: cleaned });
      onSaved();
    } catch (cause) {
      setError(t('dashboard.storage.errors.saveRoots', { cause: String(cause) }));
    } finally {
      setIsSaving(false);
    }
  };

  const openDiagnostics = () => {
    setView('diagnostics');
    if (systemPaths.length === 0) void loadDiagnostics();
  };

  const openInExplorer = async (path: string) => {
    try {
      await invoke('open_path_in_explorer', { path });
    } catch (cause) {
      setError(t('dashboard.storage.errors.openPath', { cause: String(cause) }));
    }
  };

  if (!isOpen) return null;

  const title = t(view === 'storage' ? 'dashboard.storage.title' : 'dashboard.storage.diagnostics.title');
  const subtitle = view === 'storage'
    ? t('dashboard.storage.subtitle')
    : t('dashboard.storage.diagnostics.subtitle');

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-[2px] dark:bg-black/65"
      onMouseDown={isSaving ? undefined : onClose}
    >
      <div
        className="flex max-h-[84vh] w-full max-w-[760px] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ck-project-storage-title"
        data-ck-role="project-storage-dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex min-h-16 shrink-0 items-center justify-between gap-3 border-b border-slate-200 px-5 dark:border-slate-700">
          <div className="flex min-w-0 items-center gap-3">
            {view === 'diagnostics' ? (
              <button
                type="button"
                onClick={() => setView('storage')}
                className="inline-flex h-9 items-center gap-1 rounded-lg px-2 text-xs font-bold text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
              >
                <ChevronRight size={16} className="rotate-180" />
                {t('common.actions.back')}
              </button>
            ) : (
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-950/50 dark:text-brand-300">
                <FolderOpen size={18} />
              </span>
            )}
            <div className="min-w-0">
              <h3 id="ck-project-storage-title" className="truncate text-base font-bold text-slate-900 dark:text-slate-100">{title}</h3>
              <p className="mt-0.5 truncate text-[11px] text-slate-400 dark:text-slate-500">{subtitle}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isSaving}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-50 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            title={t('common.actions.close')}
            aria-label={t('dashboard.storage.closeAria')}
          >
            <X size={18} />
          </button>
        </div>

        {view === 'storage' ? (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <div className="mb-4 rounded-xl border border-brand-100 bg-brand-50/60 px-4 py-3 text-sm leading-6 text-slate-600 dark:border-brand-900/60 dark:bg-brand-950/25 dark:text-slate-300">
                {t('dashboard.storage.description')}
              </div>

              {isLoading ? (
                <div className="flex h-32 items-center justify-center text-sm text-slate-400 dark:text-slate-500">
                  <Loader2 size={20} className="mr-2 animate-spin" />
                  {t('dashboard.storage.loadingRoots')}
                </div>
              ) : (
                <div className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700">
                  {paths.length === 0 ? (
                    <div className="px-4 py-10 text-center text-sm text-slate-400 dark:text-slate-500">{t('dashboard.storage.empty')}</div>
                  ) : paths.map((path, index) => (
                    <div
                      key={`${path}-${index}`}
                      className="flex min-h-14 items-center gap-2 border-b border-slate-100 px-3 py-2 last:border-b-0 dark:border-slate-800"
                    >
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${index === 0
                        ? 'bg-brand-100 text-brand-700 dark:bg-brand-900/55 dark:text-brand-200'
                        : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'}`}>
                        {index === 0
                          ? t('dashboard.storage.default')
                          : t('dashboard.storage.folderIndex', { index: index + 1 })}
                      </span>
                      <button
                        type="button"
                        onClick={() => void openInExplorer(path)}
                        disabled={isSaving}
                        className="min-w-0 flex-1 truncate text-left text-sm font-medium text-slate-700 hover:text-brand-700 disabled:cursor-not-allowed disabled:opacity-60 dark:text-slate-200 dark:hover:text-brand-300"
                        title={t('dashboard.storage.openInExplorer', { path })}
                      >
                        {path}
                      </button>
                      {index > 0 && (
                          <button
                            type="button"
                            onClick={() => makeDefault(index)}
                            disabled={isSaving}
                            className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-slate-200 px-2 text-xs font-semibold text-slate-500 transition-colors hover:border-brand-200 hover:bg-brand-50 hover:text-brand-700 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:text-slate-400 dark:hover:border-brand-800 dark:hover:bg-brand-950/35 dark:hover:text-brand-300"
                        >
                          <ArrowUp size={13} />
                          {t('dashboard.storage.makeDefault')}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => removePath(index)}
                        disabled={isSaving}
                        className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-slate-200 px-2 text-xs font-semibold text-slate-500 transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:text-slate-400 dark:hover:border-red-900/60 dark:hover:bg-red-950/35 dark:hover:text-red-300"
                        title={t('dashboard.storage.removeHint')}
                        aria-label={t('dashboard.storage.removeAria', { path })}
                      >
                        <Trash2 size={13} />
                        {t('common.actions.remove')}
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <p className="mt-3 text-xs text-slate-400 dark:text-slate-500">
                {t('dashboard.storage.removeExplanation')}
              </p>
              {error && (
                <div className="mt-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/35 dark:text-red-300">
                  {error}
                </div>
              )}
            </div>

            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-slate-200 bg-slate-50/70 px-5 py-3 dark:border-slate-700 dark:bg-slate-900">
              <button
                type="button"
                onClick={openDiagnostics}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2 text-xs font-bold text-slate-500 transition-colors hover:bg-slate-200/70 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
              >
                <HardDrive size={15} />
                {t('dashboard.storage.diagnostics.title')}
                <ChevronRight size={14} />
              </button>
              <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => void handleAddPath()}
                  disabled={isSaving}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-bold text-slate-600 transition-colors hover:border-brand-200 hover:text-brand-700 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:border-brand-800 dark:hover:text-brand-300"
                >
                  <Plus size={15} />
                  {t('dashboard.storage.addFolder')}
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  disabled={isSaving}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-bold text-slate-600 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                >
                  <X size={14} />
                  {t('common.actions.cancel')}
                </button>
                <button
                  type="button"
                  onClick={() => void handleSave()}
                  disabled={isSaving || isLoading}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand-600 px-4 text-xs font-bold text-white transition-colors hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isSaving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                  {t(isSaving ? 'dashboard.storage.saving' : 'common.actions.save')}
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
                {t('dashboard.storage.diagnostics.notice')}
              </div>

              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <h4 className="text-sm font-bold text-slate-800 dark:text-slate-200">{t('dashboard.storage.diagnostics.pathsTitle')}</h4>
                  <p className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">{t('dashboard.storage.diagnostics.pathsDescription')}</p>
                </div>
                <button
                  type="button"
                  onClick={() => void loadDiagnostics()}
                  disabled={isDiagnosticsLoading}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 text-xs font-bold text-slate-500 transition-colors hover:bg-slate-50 disabled:opacity-60 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800"
                >
                  {isDiagnosticsLoading ? <Loader2 size={13} className="animate-spin" /> : <HardDrive size={13} />}
                  {t('dashboard.storage.diagnostics.recheck')}
                </button>
              </div>

              <div className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700">
                {isDiagnosticsLoading ? (
                  <div className="flex h-36 items-center justify-center text-sm text-slate-400 dark:text-slate-500">
                    <Loader2 size={20} className="mr-2 animate-spin" />
                    {t('dashboard.storage.diagnostics.loading')}
                  </div>
                ) : systemPaths.length === 0 ? (
                  <div className="px-4 py-10 text-center text-sm text-slate-400 dark:text-slate-500">{t('dashboard.storage.diagnostics.empty')}</div>
                ) : systemPaths.map(([label, systemPath, exists], index) => (
                  <button
                    key={`${label}-${index}`}
                    type="button"
                    onClick={() => exists && void openInExplorer(systemPath)}
                    disabled={!exists}
                    className="flex min-h-14 w-full items-center gap-2.5 border-b border-slate-100 px-3 py-2.5 text-left transition-colors last:border-b-0 enabled:hover:bg-slate-50 disabled:opacity-55 dark:border-slate-800 dark:enabled:hover:bg-slate-800/70"
                    title={t(exists
                      ? 'dashboard.storage.diagnostics.openPath'
                      : 'dashboard.storage.diagnostics.missingPath', { path: systemPath })}
                  >
                    {exists
                      ? <CheckCircle2 size={15} className="shrink-0 text-emerald-500" />
                      : <XCircle size={15} className="shrink-0 text-slate-300 dark:text-slate-600" />}
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs font-semibold text-slate-500 dark:text-slate-400">{label}</span>
                      <span className="mt-0.5 block truncate text-sm text-slate-700 dark:text-slate-200">{systemPath}</span>
                    </span>
                    {exists && <ExternalLink size={14} className="shrink-0 text-slate-400 dark:text-slate-500" />}
                  </button>
                ))}
              </div>

              {error && (
                <div className="mt-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/35 dark:text-red-300">
                  {error}
                </div>
              )}
            </div>

            <div className="flex shrink-0 items-center justify-between gap-2 border-t border-slate-200 bg-slate-50/70 px-5 py-3 dark:border-slate-700 dark:bg-slate-900">
              <button
                type="button"
                onClick={() => setView('storage')}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-bold text-slate-600 transition-colors hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
              >
                <ChevronRight size={14} className="rotate-180" />
                {t('dashboard.storage.diagnostics.backToStorage')}
              </button>
              <button
                type="button"
                onClick={onClose}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-slate-800 px-4 text-xs font-bold text-white transition-colors hover:bg-slate-700 dark:bg-slate-700 dark:hover:bg-slate-600"
              >
                <X size={14} />
                {t('common.actions.close')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

const ActionModal = ({
  isOpen,
  type,
  project,
  onClose,
  onSuccess,
}: {
  isOpen: boolean;
  type: 'delete' | 'rename' | null;
  project: ProjectInfo | null;
  onClose: () => void;
  onSuccess: () => void;
}) => {
  const { t } = useTranslation();
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && type === 'rename' && project) {
      setInputValue(project.name);
    } else {
      setInputValue('');
    }
    setError(null);
  }, [isOpen, type, project]);

  if (!isOpen || !project) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);

    try {
      if (type === 'delete') {
        await invoke('delete_project', { path: project.path });
      } else if (type === 'rename') {
        await invoke('rename_project', { path: project.path, newName: inputValue.trim() });
      }
      onSuccess();
    } catch (err: any) {
      setError(err?.toString?.() || String(err));
    } finally {
      setIsLoading(false);
    }
  };

  const isDelete = type === 'delete';

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-950/45 dark:bg-black/65 backdrop-blur-[2px] animate-in fade-in duration-200">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-2xl w-full max-w-sm overflow-hidden transform transition-all scale-100 p-6">
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center space-x-3">
            <div className={`p-2 rounded-full ${isDelete ? 'bg-red-100 text-red-600 dark:bg-red-950/50 dark:text-red-300' : 'bg-brand-50 text-brand-600 dark:bg-brand-950/50 dark:text-brand-300'}`}>
              {isDelete ? <AlertTriangle size={24} /> : <FileEdit size={24} />}
            </div>
            <h3 className="text-lg font-bold text-slate-800 dark:text-slate-100">{t(isDelete
              ? 'dashboard.actionModal.deleteTitle'
              : 'dashboard.actionModal.renameTitle')}</h3>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors">
            <X size={20} />
          </button>
        </div>

        <div className="mb-6">
          {isDelete ? (
            <p className="text-slate-600 dark:text-slate-300 text-sm">
              {t('dashboard.actionModal.deletePrompt', { projectName: project.name })}
              <br />
              {t('dashboard.actionModal.irreversible')}
            </p>
          ) : (
            <div>
              <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">{t('dashboard.actionModal.newName')}</label>
              <input
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                className="w-full px-4 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-100 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-400 outline-none transition-colors"
                autoFocus
              />
            </div>
          )}
        </div>

        {error && <div className="text-sm text-red-600 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border border-red-100 dark:border-red-900/60 p-2 rounded-lg mb-4">{error}</div>}

        <div className="flex justify-end space-x-3">
          <button onClick={onClose} className="px-4 py-2 text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg font-medium text-sm transition-colors">
            {t('common.actions.cancel')}
          </button>
          <button
            onClick={handleSubmit}
            disabled={isLoading || (!isDelete && !inputValue.trim())}
            className={`px-4 py-2 rounded-lg text-white font-bold text-sm shadow-md flex items-center transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${isDelete ? 'bg-red-600 hover:bg-red-700' : 'bg-brand-600 hover:bg-brand-700'
              }`}
          >
            {isLoading && <Loader2 size={14} className="animate-spin mr-2" />}
            {t(isDelete ? 'dashboard.actionModal.confirmDelete' : 'dashboard.actionModal.saveChanges')}
          </button>
        </div>
      </div>
    </div>
  );
};
