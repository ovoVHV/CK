import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useHardware } from '../contexts/HardwareContext';
import { getBoardIcon } from '../constants/boards';
import DeviceSelectorModal from './DeviceSelectorModal';
import ChangelogModal from './ChangelogModal';
import { LATEST_RELEASE_NOTE } from '../data/release_notes';
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
  History,
  ChevronRight,
} from 'lucide-react';
import { useDialog } from '../contexts/DialogContext';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import ThemeModeControl from './ThemeModeControl';
import { boardPackageKey } from '../services/board_identity';

interface ProjectInfo {
  name: string;
  path: string;
  board: string;
  board_package_id?: string;
  last_modified: string;
}

interface DashboardProps {
  onOpenProject: (path: string, options?: { forceBoard?: string; forceBoardPackageId?: string; missingBoard?: string }) => void;
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
}

function getBoardTag(board: string): string {
  try {
    const parts = String(board || '').split(':');
    const last = parts[parts.length - 1] || board;
    if (last.includes('=')) {
      return last.split('=')[1] || last;
    }
    return last;
  } catch {
    return board;
  }
}

function inferBoardColor(board: string, boardExists: boolean): string {
  if (!boardExists) return 'from-slate-300 to-slate-400';
  const lower = board.toLowerCase();
  if (lower.includes('esp32')) return 'from-[#4c6b92] to-[#5f80a8]';
  if (lower.includes('esp8266')) return 'from-[#5f6f8a] to-[#7a8faa]';
  if (lower.includes('arduino')) return 'from-[#4f7d93] to-[#5f92a8]';
  return 'from-[#66788f] to-[#7d8ea5]';
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
  const [resourceTab, setResourceTab] = useState<'projects' | 'community'>('projects');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [searchQuery, setSearchQuery] = useState('');
  const [visibleCount, setVisibleCount] = useState(20);

  const [isDeviceModalOpen, setIsDeviceModalOpen] = useState(false);
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());

  const { activePort, availableBoards } = useHardware();
  const dialog = useDialog();

  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [communityCases, setCommunityCases] = useState<ProjectInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const [actionModal, setActionModal] = useState<{
    type: 'delete' | 'rename' | null;
    project: ProjectInfo | null;
    isOpen: boolean;
  }>({ type: null, project: null, isOpen: false });
  const [isPathSettingsOpen, setIsPathSettingsOpen] = useState(false);
  const [isChangelogOpen, setIsChangelogOpen] = useState(false);

  useEffect(() => {
    setVisibleCount(20);
  }, [searchQuery]);

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
    } else {
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
    setActionModal({ type: null, project: null, isOpen: false });
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

  const sourceItems = resourceTab === 'projects' ? projects : communityCases;
  const filteredProjects = sourceItems.filter(
    (p) => p.name.toLowerCase().includes(searchQuery.toLowerCase()) || p.board.toLowerCase().includes(searchQuery.toLowerCase()),
  );

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
      title: '批量删除工程',
      message: `确定删除选中的 ${selectedCount} 个工程吗？\n此操作不可撤销。`,
      type: 'warning',
      confirmLabel: '删除',
      cancelLabel: '取消',
    });
    if (!confirmed) return;

    const failures: string[] = [];
    for (const project of selectedProjects) {
      try {
        await invoke('delete_project', { path: project.path });
      } catch (e) {
        failures.push(`${project.name}: ${e}`);
      }
    }

    if (failures.length > 0) {
      await dialog.alert({
        title: '部分删除失败',
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

  const openProjectWithBoardCheck = (project: ProjectInfo) => {
    const boardExists = projectBoardExists(project, availableBoards);
    if (!boardExists) {
      onOpenProject(project.path, {
        missingBoard: project.board_package_id || project.board,
      });
      return;
    }
    onOpenProject(project.path);
  };

  return (
    <div className="h-screen bg-[#eef2f7] dark:bg-slate-950 flex flex-col overflow-hidden">
      <header className="h-14 bg-white/98 dark:bg-slate-900 border-b border-slate-200/80 dark:border-slate-800 px-5 flex items-center gap-5 shrink-0 backdrop-blur-sm">
        {/* Logo */}
        <div className="flex items-center gap-2.5 shrink-0">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-teal-500 to-teal-700 text-white flex items-center justify-center shadow-sm shadow-teal-500/20">
            <Cpu size={16} strokeWidth={2.5} />
          </div>
          <div className="min-w-0">
            <h1 className="text-base font-black tracking-tight text-slate-800 dark:text-slate-100 leading-tight">MakerSwitch</h1>
            <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-tight">{sourceItems.length} 个{resourceTab === 'projects' ? '项目' : '案例'}</p>
          </div>
        </div>

        {/* Search - 占满中间 */}
        <div className="relative flex-1">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索工程名或开发板..."
            className="w-full h-9 pl-9 pr-3 rounded-full bg-slate-100/80 dark:bg-slate-800 text-sm text-slate-700 dark:text-slate-200 outline-none border border-transparent focus:border-teal-400/60 focus:bg-white dark:focus:bg-slate-900 focus:shadow-sm transition-all duration-200 placeholder:text-slate-400"
          />
        </div>

        <ThemeModeControl />

        {/* COM Port Capsule */}
        <button
          onClick={() => setIsDeviceModalOpen(true)}
          className={`com-capsule h-9 px-4 rounded-full flex items-center gap-2.5 transition-all duration-300 cursor-pointer select-none shrink-0
            ${activePort
              ? 'bg-gradient-to-r from-teal-500 to-emerald-500 text-white shadow-md shadow-teal-500/25 hover:shadow-lg hover:shadow-teal-500/30 hover:scale-[1.02] active:scale-[0.98]'
              : 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-200/80 dark:border-slate-700 hover:border-teal-300 dark:hover:border-teal-700 hover:bg-teal-50 dark:hover:bg-teal-900/20 hover:text-teal-600 dark:hover:text-teal-400 hover:shadow-sm active:scale-[0.97]'
            }`}
          title="连接设备"
        >
          {/* Status Dot */}
          <span className={`relative flex h-2 w-2`}>
            {activePort && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white/60"></span>}
            <span className={`relative inline-flex rounded-full h-2 w-2 ${activePort ? 'bg-white' : 'bg-amber-400 animate-pulse'}`}></span>
          </span>
          <Usb size={14} strokeWidth={2.5} />
          <span className="text-sm font-semibold tracking-tight">{activePort || 'COM'}</span>
        </button>
      </header>

      <main className="flex-1 min-h-0 flex overflow-hidden">
        <aside className="flex w-52 shrink-0 border-r border-slate-200 dark:border-slate-800 bg-white/90 dark:bg-slate-900 px-3 py-5 flex-col gap-1.5 overflow-y-auto">
          <p className="text-xs font-bold text-slate-400 px-2 tracking-wide">资源管理器</p>
          <button
            onClick={() => setResourceTab('projects')}
            className={`h-10 px-3 rounded-xl font-semibold text-left flex items-center gap-2 ${resourceTab === 'projects'
              ? 'bg-teal-50 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300'
              : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
          >
            <Box size={16} /> 我的工程
          </button>
          <button className="h-10 px-3 rounded-xl text-slate-600 dark:text-slate-300 text-left flex items-center gap-2 hover:bg-slate-100 dark:hover:bg-slate-800">
            <Cpu size={16} /> 元件库
          </button>
          <button className="h-10 px-3 rounded-xl text-slate-600 dark:text-slate-300 text-left flex items-center gap-2 hover:bg-slate-100 dark:hover:bg-slate-800">
            <Clock size={16} /> 最近打开
          </button>

          <p className="text-xs font-bold text-slate-400 px-2 mt-3 tracking-wide">硬件生态</p>
          <button
            onClick={() => setResourceTab('community')}
            className={`h-10 px-3 rounded-xl text-left flex items-center gap-2 ${resourceTab === 'community'
              ? 'bg-teal-50 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300 font-semibold'
              : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
          >
            <Copy size={16} /> 社区案例
          </button>
          <button className="h-10 px-3 rounded-xl text-slate-600 dark:text-slate-300 text-left flex items-center gap-2 hover:bg-slate-100 dark:hover:bg-slate-800">
            <BookOpen size={16} /> Wiki 文档
          </button>
          <button className="h-10 px-3 rounded-xl text-slate-600 dark:text-slate-300 text-left flex items-center gap-2 hover:bg-slate-100 dark:hover:bg-slate-800">
            <Download size={16} /> 驱动下载
          </button>

          <div className="mt-auto pt-4">
            <button
              type="button"
              onClick={() => setIsChangelogOpen(true)}
              className="group w-full overflow-hidden rounded-2xl border border-violet-200/80 dark:border-violet-800 bg-gradient-to-br from-violet-50 via-white to-teal-50 dark:from-violet-950/50 dark:via-slate-900 dark:to-teal-950/40 p-3 text-left shadow-sm hover:shadow-md hover:border-violet-300 dark:hover:border-violet-700 transition-all"
              title="查看软件更新日志"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex min-w-0 items-center gap-1.5 text-xs font-bold text-violet-700 dark:text-violet-300">
                  <History size={14} /> 软件更新日志
                </span>
                <span className="shrink-0 rounded-full bg-violet-600 px-1.5 py-0.5 text-[9px] font-black tracking-wide text-white">NEW</span>
              </div>
              <div className="mt-2 text-sm font-bold leading-5 text-slate-800 dark:text-slate-100">
                {LATEST_RELEASE_NOTE.title}
              </div>
              <p className="mt-1 text-[10px] leading-4 text-slate-500 dark:text-slate-400">
                断点支持 AVR、ESP32、ESP8266；新增继续、单步和可靠结束。
              </p>
              <div className="mt-2 flex items-center justify-between text-[10px] font-semibold text-violet-700 dark:text-violet-300">
                <span>{LATEST_RELEASE_NOTE.date}</span>
                <span className="inline-flex items-center gap-0.5 group-hover:translate-x-0.5 transition-transform">
                  查看详情 <ChevronRight size={12} />
                </span>
              </div>
            </button>
          </div>
        </aside>

        <section className="flex-1 overflow-auto px-6 py-6">


          <div className="mb-5 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-bold tracking-tight text-slate-800 dark:text-slate-100">
                {resourceTab === 'projects' ? '我的工程' : '社区案例'}
              </h2>
              <span className="text-xs text-slate-400 bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded-full font-medium">{filteredProjects.length}</span>
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
                  className="h-10 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 text-sm font-medium hover:text-teal-600 dark:hover:text-teal-400 transition-colors flex items-center gap-2"
                >
                  <FolderOpen size={16} />
                  打开案例目录
                </button>
              ) : null}
              {resourceTab === 'projects' ? (
                <button
                  onClick={toggleSelectionMode}
                  className="h-10 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 text-sm font-medium hover:border-teal-200 dark:hover:border-teal-800 hover:text-teal-600 dark:hover:text-teal-400 transition-colors"
                >
                  {isSelectionMode ? '退出多选' : '多选'}
                </button>
              ) : null}
              <button
                onClick={() => setViewMode(viewMode === 'grid' ? 'list' : 'grid')}
                className="h-10 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:text-teal-600 dark:hover:text-teal-400 transition-colors flex items-center gap-2"
                title={viewMode === 'grid' ? '切换为列表' : '切换为网格'}
              >
                {viewMode === 'grid' ? <List size={16} /> : <LayoutGrid size={16} />}
                <span className="hidden sm:inline text-sm font-medium">{viewMode === 'grid' ? '列表' : '网格'}</span>
              </button>
            </div>
          </div>

          {resourceTab === 'projects' && isSelectionMode ? (
            <div className="mb-4 rounded-xl border border-teal-200/80 bg-teal-50/70 dark:border-teal-800/60 dark:bg-teal-950/30 px-3 py-2 flex items-center justify-between gap-2">
              <div className="text-sm font-medium text-slate-700 dark:text-slate-200">
                已选择 <span className="text-teal-700 dark:text-teal-300 font-bold">{selectedCount}</span> 项
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={toggleSelectAllFiltered}
                  className="h-8 px-3 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:text-teal-600 dark:hover:text-teal-300 hover:border-teal-200 dark:hover:border-teal-800 text-sm transition-colors"
                >
                  {allFilteredSelected ? '取消全选' : '全选当前列表'}
                </button>
                <button
                  onClick={handleRenameSelected}
                  disabled={selectedCount !== 1}
                  className="h-8 px-3 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:text-teal-600 dark:hover:text-teal-300 hover:border-teal-200 dark:hover:border-teal-800 text-sm disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1 transition-colors"
                >
                  <FileEdit size={14} />
                  重命名
                </button>
                <button
                  onClick={handleDeleteSelected}
                  disabled={selectedCount === 0}
                  className="h-8 px-3 rounded-lg bg-red-600 text-white hover:bg-red-700 text-sm disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1 transition-colors"
                >
                  <Trash2 size={14} />
                  删除
                </button>
              </div>
            </div>
          ) : null}

          {isLoading ? (
            <div className="flex flex-col items-center justify-center h-40 text-slate-400">
              <Loader2 size={32} className="animate-spin mb-2" />
              <p>加载中...</p>
            </div>
          ) : filteredProjects.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-52 text-slate-400 bg-slate-100/60 dark:bg-slate-900 border border-dashed border-slate-300 dark:border-slate-700 rounded-xl">
              <Box size={40} className="mb-2 opacity-60" />
              <p>{resourceTab === 'projects' ? '没有找到工程' : '社区案例目录暂无示例'}</p>
              {resourceTab === 'projects' ? (
                <button onClick={handleCreateProject} className="text-teal-600 font-bold hover:underline mt-2">
                  创建新工程
                </button>
              ) : null}
            </div>
          ) : viewMode === 'grid' ? (
            <div className="grid grid-cols-4 gap-5 pb-10">
              {resourceTab === 'projects' ? (
                <div
                  onClick={handleCreateProject}
                  className="bg-white dark:bg-slate-900 rounded-2xl border-2 border-dashed border-slate-200 dark:border-slate-700 hover:border-teal-400 dark:hover:border-teal-600 shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all duration-200 cursor-pointer overflow-hidden flex flex-col items-center justify-center min-h-[240px] group"
                >
                  <div className="w-14 h-14 rounded-2xl bg-teal-50 dark:bg-teal-900/30 flex items-center justify-center mb-3 group-hover:bg-teal-100 dark:group-hover:bg-teal-900/50 group-hover:scale-110 transition-all duration-300">
                    <Plus size={28} className="text-teal-500 dark:text-teal-400" strokeWidth={2} />
                  </div>
                  <span className="text-sm font-bold text-slate-600 dark:text-slate-300 group-hover:text-teal-600 dark:group-hover:text-teal-400 transition-colors">新建工程</span>
                  <span className="text-[11px] text-slate-400 mt-1">创建一个新项目</span>
                </div>
              ) : null}
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
                  isSelectionMode={isSelectionMode}
                  isSelected={selectedPaths.has(project.path)}
                  availableBoards={availableBoards}
                />
              ))}
            </div>
          ) : (
            <div className="bg-white dark:bg-slate-900 rounded-xl shadow-sm border border-slate-200 dark:border-slate-800 overflow-hidden pb-10">
              <div className="grid grid-cols-12 gap-4 px-6 py-3 border-b border-slate-100 dark:border-slate-800 text-xs font-bold text-slate-400 uppercase tracking-wider">
                {isSelectionMode && <div className="col-span-1">选择</div>}
                <div className={isSelectionMode ? 'col-span-3' : 'col-span-4'}>工程名称</div>
                <div className="col-span-3">开发板</div>
                <div className="col-span-3">最近修改</div>
                <div className="col-span-2 text-right">操作</div>
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
                  isSelectionMode={isSelectionMode}
                  isSelected={selectedPaths.has(project.path)}
                  dialog={dialog}
                  availableBoards={availableBoards}
                />
              ))}
            </div>
          )}

          {!isLoading && filteredProjects.length > visibleCount && (
            <div className="flex justify-center mt-6 pb-8">
              <button
                onClick={handleLoadMore}
                className="px-6 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 rounded-full shadow-sm hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-teal-600 dark:hover:text-teal-400 font-medium transition-all duration-200 flex items-center"
              >
                <ArrowDown size={16} className="mr-2" />
                加载更多 ({filteredProjects.length - visibleCount})
              </button>
            </div>
          )}
        </section>
      </main>

      <ActionModal
        isOpen={actionModal.isOpen}
        type={actionModal.type}
        project={actionModal.project}
        onClose={() => setActionModal({ type: null, project: null, isOpen: false })}
        onSuccess={handleActionComplete}
      />

      <button
        type="button"
        onClick={() => setIsPathSettingsOpen(true)}
        title="工程存储位置"
        aria-label="打开工程存储位置"
        className="fixed right-4 sm:right-6 bottom-4 sm:bottom-6 z-40 inline-flex h-11 max-w-[calc(100vw-2rem)] items-center justify-center gap-2 whitespace-nowrap rounded-full border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3.5 text-sm font-semibold text-slate-600 dark:text-slate-300 shadow-lg hover:shadow-xl hover:border-teal-200 dark:hover:border-teal-800 hover:text-teal-600 dark:hover:text-teal-400 transition-all"
      >
        <FolderOpen size={18} className="shrink-0" />
        <span>工程存储位置</span>
      </button>

      <ProjectPathSettingsModal
        isOpen={isPathSettingsOpen}
        onClose={() => setIsPathSettingsOpen(false)}
        onSaved={() => {
          setIsPathSettingsOpen(false);
          if (resourceTab === 'projects') void loadProjects();
        }}
      />
      <DeviceSelectorModal isOpen={isDeviceModalOpen} onClose={() => setIsDeviceModalOpen(false)} />
      <ChangelogModal isOpen={isChangelogOpen} onClose={() => setIsChangelogOpen(false)} />
    </div>
  );
}

const ProjectCardGrid = ({
  data,
  onClick,
  onRename,
  onDelete,
  isSelectionMode,
  isSelected,
  availableBoards,
}: ProjectCardGridProps) => {
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  const boardExists = availableBoards ? projectBoardExists(data, availableBoards) : true;
  const icon = boardExists ? getBoardIcon(data.board) : '';
  const coverTone = inferBoardColor(data.board, boardExists);

  return (
    <div
      onClick={onClick}
      className={`bg-white dark:bg-slate-900 rounded-2xl border shadow-sm hover:shadow-lg hover:-translate-y-0.5 transition-all duration-200 group cursor-pointer overflow-hidden flex flex-col min-w-0 relative ${isSelected ? 'ring-2 ring-teal-500 border-teal-500 dark:border-teal-500' : 'border-slate-200 dark:border-slate-800'
        }`}
    >
      {!boardExists && (
        <div className="absolute top-2 left-2 z-30 bg-red-500 text-white text-[10px] px-2 py-0.5 rounded-full font-bold shadow-sm uppercase tracking-wider flex items-center">
          <AlertTriangle size={10} className="mr-1" /> 丢失
        </div>
      )}

      {isSelectionMode && (
        <div className="absolute top-2 left-2 z-30">
          <div
            className={`w-5 h-5 rounded border flex items-center justify-center ${isSelected ? 'bg-teal-500 border-teal-500' : 'bg-white dark:bg-slate-800 border-slate-300 dark:border-slate-600'
              }`}
          >
            {isSelected && <div className="w-2.5 h-1.5 border-b-2 border-l-2 border-white transform -rotate-45 mb-0.5"></div>}
          </div>
        </div>
      )}

      <div className={`h-40 bg-gradient-to-br ${coverTone} relative overflow-hidden flex items-center justify-center`}>
        <div className="absolute inset-0 bg-black/5"></div>
        {boardExists && icon.startsWith('/') ? (
          <img
            src={icon}
            alt={data.board}
            loading="lazy"
            decoding="async"
            className="w-full h-full object-contain p-2 transform will-change-transform hover:scale-105 transition-transform duration-300 z-10"
          />
        ) : !boardExists ? (
          <div className="z-10 text-center text-slate-700">
            <AlertTriangle size={34} className="mx-auto mb-2 opacity-80" />
            <div className="text-xs font-semibold">板卡已丢失</div>
          </div>
        ) : (
          <span className="text-6xl transform will-change-transform hover:scale-110 transition-transform duration-300 drop-shadow-sm z-10">{icon}</span>
        )}

        <div className="absolute top-2 right-2 max-w-[80%] flex justify-end z-20">
          <span
            className="bg-black/60 text-white text-[10px] px-2 py-0.5 rounded-full font-mono border border-white/20 truncate max-w-full shadow-sm"
            title={data.board}
          >
            {getBoardTag(data.board)}
          </span>
        </div>
      </div>

      <div className="p-4 flex-1 flex flex-col bg-white dark:bg-slate-900">
        <h3 className="font-bold text-slate-800 dark:text-slate-200 mb-1 truncate text-sm" title={data.name}>
          {data.name}
        </h3>

        <div className="flex justify-between items-center mt-auto pt-2">
          <span className="text-xs text-slate-500 dark:text-slate-500 flex items-center">
            <Clock size={12} className="mr-1" /> {data.last_modified}
          </span>

          {!isSelectionMode && (
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
                title="更多操作"
                className={`h-9 w-9 flex items-center justify-center rounded-lg transition-colors ${isMenuOpen
                  ? 'bg-slate-100 dark:bg-slate-800 text-teal-600 dark:text-teal-400'
                  : 'text-slate-500 dark:text-slate-400 hover:text-teal-600 dark:hover:text-teal-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                  }`}
              >
                <MoreVertical size={20} />
              </button>

              {isMenuOpen && (
                <div className="absolute right-0 bottom-full mb-1 w-32 bg-white dark:bg-slate-800 rounded-lg shadow-xl border border-slate-100 dark:border-slate-700 overflow-hidden py-1 z-50 animate-in fade-in zoom-in-95 duration-100 origin-bottom-right">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onRename();
                      setIsMenuOpen(false);
                    }}
                    className="w-full text-left px-4 py-2 text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 hover:text-teal-600 dark:hover:text-teal-400 flex items-center"
                  >
                    <FileEdit size={14} className="mr-2" /> 重命名
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete();
                      setIsMenuOpen(false);
                    }}
                    className="w-full text-left px-4 py-2 text-sm text-slate-600 dark:text-slate-300 hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-500 dark:hover:text-red-400 flex items-center"
                  >
                    <Trash2 size={14} className="mr-2" /> 删除
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const ProjectRowList = ({ data, onClick, onRename, onDelete, isSelectionMode, isSelected, dialog, availableBoards }: ProjectRowListProps) => {
  const boardExists = availableBoards ? projectBoardExists(data, availableBoards) : true;
  const icon = boardExists ? getBoardIcon(data.board) : '';
  const color = inferBoardSolidColor(data.board, boardExists);

  return (
    <div
      onClick={onClick}
      className={`grid grid-cols-12 gap-4 px-6 py-4 border-b border-slate-50 dark:border-slate-800 items-center hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors cursor-pointer group ${isSelected ? 'bg-teal-50/50 dark:bg-teal-900/20' : ''
        }`}
    >
      {isSelectionMode && (
        <div className="col-span-1">
          <div
            className={`w-5 h-5 rounded border flex items-center justify-center ${isSelected ? 'bg-teal-500 border-teal-500' : 'bg-white dark:bg-slate-800 border-slate-300 dark:border-slate-600'
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
          {boardExists && icon.startsWith('/') ? (
            <img src={icon} alt={data.board} loading="lazy" decoding="async" className="w-full h-full object-cover" />
          ) : !boardExists ? (
            <AlertTriangle size={16} />
          ) : (
            <span>{icon}</span>
          )}
        </div>
        <div className="font-bold text-slate-700 dark:text-slate-200 text-sm truncate">{data.name}</div>
      </div>

      <div className="col-span-3 flex flex-col justify-center space-y-1 overflow-hidden">
        <div>
          <span
            className="inline-flex items-center px-2 py-0.5 rounded text-xs font-mono font-medium bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700 truncate"
            title={data.board}
          >
            {getBoardTag(data.board)}
          </span>
        </div>

        <div className="flex items-center group/path w-full">
          <div
            className="text-[10px] text-slate-400 font-mono truncate mr-1.5 cursor-pointer hover:text-teal-600 dark:hover:text-teal-400"
            title={data.path}
          >
            {data.path}
          </div>
          <div className="flex opacity-0 group-hover/path:opacity-100 transition-opacity space-x-0.5 shrink-0 bg-white dark:bg-slate-800">
            <button
              onClick={(e) => {
                e.stopPropagation();
                navigator.clipboard.writeText(data.path);
                dialog.alert({ type: 'success', message: '路径已复制到剪贴板', title: '已复制' });
              }}
              title="复制路径"
              className="p-0.5 text-slate-400 hover:text-teal-600 dark:hover:text-teal-400 rounded hover:bg-slate-100 dark:hover:bg-slate-700"
            >
              <Copy size={10} />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                invoke('show_in_folder', { path: data.path }).catch(console.error);
              }}
              title="打开目录"
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
          <div className="relative group/menu">
            <button
              className="h-8 w-8 flex items-center justify-center hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg text-slate-400 hover:text-teal-600 dark:hover:text-teal-400 transition-colors"
              title="更多操作"
            >
              <MoreVertical size={18} />
            </button>
            <div className="hidden group-hover/menu:block absolute right-0 top-3/4 mt-1 w-32 bg-white dark:bg-slate-800 rounded-lg shadow-xl border border-slate-100 dark:border-slate-700 overflow-hidden py-1 z-50 animate-in fade-in zoom-in-95 duration-100 origin-top-right">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onRename();
                }}
                className="w-full text-left px-4 py-2 text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 hover:text-teal-600 dark:hover:text-teal-400 flex items-center"
              >
                <FileEdit size={14} className="mr-2" /> 重命名
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete();
                }}
                className="w-full text-left px-4 py-2 text-sm text-slate-600 dark:text-slate-300 hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-500 dark:hover:text-red-400 flex items-center"
              >
                <Trash2 size={14} className="mr-2" /> 删除
              </button>
            </div>
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
      setError(`读取工程目录失败：${cause}`);
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
      setError(`读取诊断路径失败：${cause}`);
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
        title: '选择工程目录',
      });
      if (typeof selected !== 'string' || !selected.trim()) return;
      const normalized = selected.trim();
      setPaths((previous) => (
        previous.some((path) => path.toLocaleLowerCase() === normalized.toLocaleLowerCase())
          ? previous
          : [...previous, normalized]
      ));
    } catch (cause) {
      setError(`选择目录失败：${cause}`);
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
      setError('至少保留一个工程目录。');
      return;
    }

    setIsSaving(true);
    setError('');
    try {
      await invoke('set_project_roots', { paths: cleaned });
      onSaved();
    } catch (cause) {
      setError(`保存工程目录失败：${cause}`);
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
      setError(`无法打开路径：${cause}`);
    }
  };

  if (!isOpen) return null;

  const title = view === 'storage' ? '工程存储位置' : '高级诊断';
  const subtitle = view === 'storage'
    ? '管理主页扫描范围和新工程默认位置'
    : '只读查看 CK 当前使用的关键运行路径';

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
                返回
              </button>
            ) : (
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-600 dark:bg-teal-950/50 dark:text-teal-300">
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
            title="关闭"
            aria-label="关闭工程存储位置"
          >
            <X size={18} />
          </button>
        </div>

        {view === 'storage' ? (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <div className="mb-4 rounded-xl border border-teal-100 bg-teal-50/60 px-4 py-3 text-sm leading-6 text-slate-600 dark:border-teal-900/60 dark:bg-teal-950/25 dark:text-slate-300">
                主页会扫描下面的全部目录。第一项用于保存新工程，也是“打开工程”和“另存为”的默认位置。
              </div>

              {isLoading ? (
                <div className="flex h-32 items-center justify-center text-sm text-slate-400 dark:text-slate-500">
                  <Loader2 size={20} className="mr-2 animate-spin" />
                  正在读取工程目录
                </div>
              ) : (
                <div className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700">
                  {paths.length === 0 ? (
                    <div className="px-4 py-10 text-center text-sm text-slate-400 dark:text-slate-500">暂无工程目录，请先添加。</div>
                  ) : paths.map((path, index) => (
                    <div
                      key={`${path}-${index}`}
                      className="flex min-h-14 items-center gap-2 border-b border-slate-100 px-3 py-2 last:border-b-0 dark:border-slate-800"
                    >
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${index === 0
                        ? 'bg-teal-100 text-teal-700 dark:bg-teal-900/55 dark:text-teal-200'
                        : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'}`}>
                        {index === 0 ? '默认' : `目录 ${index + 1}`}
                      </span>
                      <button
                        type="button"
                        onClick={() => void openInExplorer(path)}
                        disabled={isSaving}
                        className="min-w-0 flex-1 truncate text-left text-sm font-medium text-slate-700 hover:text-teal-700 disabled:cursor-not-allowed disabled:opacity-60 dark:text-slate-200 dark:hover:text-teal-300"
                        title={`在资源管理器中打开：${path}`}
                      >
                        {path}
                      </button>
                      {index > 0 && (
                          <button
                            type="button"
                            onClick={() => makeDefault(index)}
                            disabled={isSaving}
                            className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-slate-200 px-2 text-xs font-semibold text-slate-500 transition-colors hover:border-teal-200 hover:bg-teal-50 hover:text-teal-700 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:text-slate-400 dark:hover:border-teal-800 dark:hover:bg-teal-950/35 dark:hover:text-teal-300"
                        >
                          <ArrowUp size={13} />
                          设为默认
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => removePath(index)}
                        disabled={isSaving}
                        className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-slate-200 px-2 text-xs font-semibold text-slate-500 transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:text-slate-400 dark:hover:border-red-900/60 dark:hover:bg-red-950/35 dark:hover:text-red-300"
                        title="只移除目录配置，不删除其中的工程文件"
                        aria-label={`移除工程目录配置：${path}`}
                      >
                        <Trash2 size={13} />
                        移除
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <p className="mt-3 text-xs text-slate-400 dark:text-slate-500">
                移除目录只会让其中的工程不再显示，不会删除磁盘上的工程文件。
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
                高级诊断
                <ChevronRight size={14} />
              </button>
              <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => void handleAddPath()}
                  disabled={isSaving}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-bold text-slate-600 transition-colors hover:border-teal-200 hover:text-teal-700 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:border-teal-800 dark:hover:text-teal-300"
                >
                  <Plus size={15} />
                  添加目录
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  disabled={isSaving}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-bold text-slate-600 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                >
                  <X size={14} />
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => void handleSave()}
                  disabled={isSaving || isLoading}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-teal-600 px-4 text-xs font-bold text-white transition-colors hover:bg-teal-500 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isSaving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                  {isSaving ? '正在保存' : '保存'}
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
                这里仅提供只读诊断。原“Defender 白名单加速”无法可靠验证执行结果且排除范围过大，现已停用；CK 不会在这里修改 Windows 安全设置。
              </div>

              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <h4 className="text-sm font-bold text-slate-800 dark:text-slate-200">关键运行路径</h4>
                  <p className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">点击存在的路径可在资源管理器中打开。</p>
                </div>
                <button
                  type="button"
                  onClick={() => void loadDiagnostics()}
                  disabled={isDiagnosticsLoading}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 text-xs font-bold text-slate-500 transition-colors hover:bg-slate-50 disabled:opacity-60 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800"
                >
                  {isDiagnosticsLoading ? <Loader2 size={13} className="animate-spin" /> : <HardDrive size={13} />}
                  重新检测
                </button>
              </div>

              <div className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700">
                {isDiagnosticsLoading ? (
                  <div className="flex h-36 items-center justify-center text-sm text-slate-400 dark:text-slate-500">
                    <Loader2 size={20} className="mr-2 animate-spin" />
                    正在读取诊断路径
                  </div>
                ) : systemPaths.length === 0 ? (
                  <div className="px-4 py-10 text-center text-sm text-slate-400 dark:text-slate-500">没有可显示的诊断路径。</div>
                ) : systemPaths.map(([label, systemPath, exists], index) => (
                  <button
                    key={`${label}-${index}`}
                    type="button"
                    onClick={() => exists && void openInExplorer(systemPath)}
                    disabled={!exists}
                    className="flex min-h-14 w-full items-center gap-2.5 border-b border-slate-100 px-3 py-2.5 text-left transition-colors last:border-b-0 enabled:hover:bg-slate-50 disabled:opacity-55 dark:border-slate-800 dark:enabled:hover:bg-slate-800/70"
                    title={exists ? `点击打开：${systemPath}` : `路径不存在：${systemPath}`}
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
                返回存储位置
              </button>
              <button
                type="button"
                onClick={onClose}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-slate-800 px-4 text-xs font-bold text-white transition-colors hover:bg-slate-700 dark:bg-slate-700 dark:hover:bg-slate-600"
              >
                <X size={14} />
                关闭
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
            <div className={`p-2 rounded-full ${isDelete ? 'bg-red-100 text-red-600 dark:bg-red-950/50 dark:text-red-300' : 'bg-teal-50 text-teal-600 dark:bg-teal-950/50 dark:text-teal-300'}`}>
              {isDelete ? <AlertTriangle size={24} /> : <FileEdit size={24} />}
            </div>
            <h3 className="text-lg font-bold text-slate-800 dark:text-slate-100">{isDelete ? '删除工程' : '重命名工程'}</h3>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors">
            <X size={20} />
          </button>
        </div>

        <div className="mb-6">
          {isDelete ? (
            <p className="text-slate-600 dark:text-slate-300 text-sm">
              确定删除 <span className="font-bold text-slate-800 dark:text-slate-100">{project.name}</span> 吗？
              <br />
              此操作不可撤销。
            </p>
          ) : (
            <div>
              <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">新名称</label>
              <input
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                className="w-full px-4 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-100 rounded-lg focus:ring-2 focus:ring-teal-500 focus:border-teal-400 outline-none transition-colors"
                autoFocus
              />
            </div>
          )}
        </div>

        {error && <div className="text-sm text-red-600 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border border-red-100 dark:border-red-900/60 p-2 rounded-lg mb-4">{error}</div>}

        <div className="flex justify-end space-x-3">
          <button onClick={onClose} className="px-4 py-2 text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg font-medium text-sm transition-colors">
            取消
          </button>
          <button
            onClick={handleSubmit}
            disabled={isLoading || (!isDelete && !inputValue.trim())}
            className={`px-4 py-2 rounded-lg text-white font-bold text-sm shadow-md flex items-center transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${isDelete ? 'bg-red-600 hover:bg-red-700' : 'bg-teal-600 hover:bg-teal-700'
              }`}
          >
            {isLoading && <Loader2 size={14} className="animate-spin mr-2" />}
            {isDelete ? '确认删除' : '保存修改'}
          </button>
        </div>
      </div>
    </div>
  );
};
