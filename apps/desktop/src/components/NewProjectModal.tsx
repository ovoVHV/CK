import { useState, useEffect } from 'react';
import { X, ChevronDown, Check, Loader2, Search } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { BOARDS } from '../constants/boards';

interface NewProjectModalProps {
    isOpen: boolean;
    onClose: () => void;
    onCreated: (path: string, board: string) => void;
    initialTemplate?: string;
}

const TEMPLATES = [
    { id: 'empty', name: '空工程', desc: '创建一个空白的 Arduino 工程' },
    { id: 'blink', name: 'Blink (点灯)', desc: '经典的 LED 闪烁示例' },
    { id: 'servo', name: '舵机控制', desc: '简单的舵机扫掠控制' },
];

export default function NewProjectModal({ isOpen, onClose, onCreated, initialTemplate = 'empty' }: NewProjectModalProps) {
    const [projectName, setProjectName] = useState('');
    const [selectedBoard, setSelectedBoard] = useState(BOARDS[0].id);
    const [selectedTemplate, setSelectedTemplate] = useState(initialTemplate);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Board Dropdown State
    const [isBoardDropdownOpen, setIsBoardDropdownOpen] = useState(false);
    const [boardSearchQuery, setBoardSearchQuery] = useState('');

    const [customBoards, setCustomBoards] = useState<any[]>([]);

    // Reset or Update state when modal opens or props change
    useEffect(() => {
        if (isOpen) {
            setSelectedTemplate(initialTemplate);
            setProjectName('');

            // Fetch custom boards
            invoke('get_custom_boards_v2').then((boards: any) => {
                setCustomBoards(boards);
            }).catch(console.error);
        }
    }, [isOpen, initialTemplate]);

    const allBoards = [...customBoards, ...BOARDS];



    if (!isOpen) return null;

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        setIsLoading(true);

        try {
            // Call Backend
            const result: any = await invoke('create_project', {
                name: projectName,
                board: selectedBoard,
                templateId: selectedTemplate
            });

            // Success
            onCreated(result.path, result.board);
            onClose();
        } catch (err: any) {
            setError(err.toString());
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 animate-in fade-in duration-200">
            <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl w-full max-w-md overflow-hidden transform transition-all scale-100 border border-slate-200 dark:border-slate-800">

                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/50">
                    <h3 className="text-lg font-bold text-slate-800 dark:text-slate-100">新建工程</h3>
                    <button onClick={onClose} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors">
                        <X size={20} />
                    </button>
                </div>

                <form onSubmit={handleSubmit} className="p-6 space-y-5">

                    {/* Project Name */}
                    <div>
                        <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">
                            工程名称
                        </label>
                        <input
                            type="text"
                            value={projectName}
                            onChange={(e) => setProjectName(e.target.value)}
                            placeholder="例如: MyRobot_01"
                            className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg focus:bg-white dark:focus:bg-slate-800 focus:ring-2 focus:ring-teal-500 focus:border-teal-500 outline-none transition-all font-medium text-slate-800 dark:text-slate-200 placeholder:text-slate-400"
                            required
                            autoFocus
                        />
                    </div>

                    {/* Board Selection */}
                    <div className="relative">
                        <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">
                            选择开发板
                        </label>
                        <div className="relative">
                            <button
                                type="button"
                                onClick={() => setIsBoardDropdownOpen(!isBoardDropdownOpen)}
                                className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-left focus:ring-2 focus:ring-teal-500 outline-none flex items-center justify-between transition-colors hover:bg-slate-100 dark:hover:bg-slate-700"
                            >
                                <span className="flex items-center font-medium text-slate-700 dark:text-slate-200">
                                    {allBoards.find(b => b.id === selectedBoard)?.name}
                                </span>
                                <ChevronDown size={16} className={`text-slate-400 transition-transform ${isBoardDropdownOpen ? 'rotate-180' : ''}`} />
                            </button>

                            {isBoardDropdownOpen && (
                                <div className="absolute z-10 w-full mt-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-lg animate-in fade-in zoom-in-95 duration-100 overflow-hidden">
                                    <div className="p-2 border-b border-slate-100 dark:border-slate-700 sticky top-0 bg-white dark:bg-slate-800">
                                        <div className="relative">
                                            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                                            <input
                                                type="text"
                                                placeholder="搜索开发板..."
                                                className="w-full pl-9 pr-3 py-1.5 text-sm bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-500/50 text-slate-800 dark:text-slate-200 placeholder:text-slate-500"
                                                value={boardSearchQuery}
                                                onChange={(e) => setBoardSearchQuery(e.target.value)}
                                                autoFocus
                                            />
                                        </div>
                                    </div>
                                    <div className="max-h-48 overflow-y-auto p-1 custom-scrollbar">
                                        {allBoards.filter(b => b.name.toLowerCase().includes(boardSearchQuery.toLowerCase())).map(b => (
                                            <div
                                                key={b.id}
                                                onClick={() => {
                                                    setSelectedBoard(b.id);
                                                    setIsBoardDropdownOpen(false);
                                                    setBoardSearchQuery('');
                                                }}
                                                className={`
                                                    flex items-center px-3 py-2 rounded-lg cursor-pointer transition-colors
                                                    ${selectedBoard === b.id ? 'bg-teal-50 dark:bg-teal-900/30 text-teal-700 dark:text-teal-400' : 'hover:bg-slate-50 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300'}
                                                `}
                                            >
                                                <span className="font-medium text-sm flex-1">{b.name}</span>
                                                {selectedBoard === b.id && <Check size={14} className="text-teal-600 dark:text-teal-400" />}
                                                {/* Badge for Custom Boards */}
                                                {!BOARDS.some(staticB => staticB.id === b.id) && (
                                                    <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-400">自定义</span>
                                                )}
                                            </div>
                                        ))}
                                        {allBoards.filter(b => b.name.toLowerCase().includes(boardSearchQuery.toLowerCase())).length === 0 && (
                                            <div className="px-4 py-3 text-center text-xs text-slate-400">
                                                未找到相关开发板
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                        {/* Backdrop to close dropdown */}
                        {isBoardDropdownOpen && (
                            <div className="fixed inset-0 z-0" onClick={() => setIsBoardDropdownOpen(false)}></div>
                        )}
                    </div>

                    {/* Template Selection */}
                    <div>
                        <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">
                            起始模板
                        </label>
                        <div className="grid grid-cols-3 gap-3">
                            {TEMPLATES.map(t => (
                                <div
                                    key={t.id}
                                    onClick={() => setSelectedTemplate(t.id)}
                                    className={`
                                        relative group cursor-pointer rounded-xl border-2 transition-all duration-200 p-3 flex flex-col items-center text-center
                                        ${selectedTemplate === t.id
                                            ? 'bg-teal-50 dark:bg-teal-900/20 border-teal-500 shadow-sm'
                                            : 'bg-white dark:bg-slate-800 border-slate-100 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600 hover:shadow-sm hover:bg-slate-50 dark:hover:bg-slate-700'}
                                    `}
                                >
                                    {/* Selection Ring */}
                                    {selectedTemplate === t.id && (
                                        <div className="absolute top-2 right-2 text-teal-600 dark:text-teal-400 animate-in zoom-in duration-200">
                                            <Check size={14} strokeWidth={3} />
                                        </div>
                                    )}

                                    {/* Icon Placeholder (Dynamic Initials) */}
                                    <div className={`
                                        w-10 h-10 rounded-full flex items-center justify-center mb-2 text-lg font-bold transition-colors
                                        ${selectedTemplate === t.id ? 'bg-teal-200 dark:bg-teal-800 text-teal-700 dark:text-teal-200' : 'bg-slate-100 dark:bg-slate-700 text-slate-400 group-hover:bg-slate-200 dark:group-hover:bg-slate-600'}
                                    `}>
                                        {t.name.slice(0, 1)}
                                    </div>

                                    <div className={`font-bold text-sm mb-1 line-clamp-1 ${selectedTemplate === t.id ? 'text-teal-800 dark:text-teal-300' : 'text-slate-700 dark:text-slate-300'}`}>
                                        {t.name}
                                    </div>
                                    <div className="text-[10px] text-slate-400 dark:text-slate-500 leading-tight line-clamp-2 min-h-[2.5em]">
                                        {t.desc}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Error Message */}
                    {error && (
                        <div className="text-red-500 dark:text-red-400 text-sm bg-red-50 dark:bg-red-900/20 p-3 rounded-lg border border-red-100 dark:border-red-900/50">
                            错误: {error}
                        </div>
                    )}

                    {/* Footer Actions */}
                    <div className="pt-2 flex items-center justify-end space-x-3">
                        <button
                            type="button"
                            onClick={onClose}
                            className="px-4 py-2 text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800 rounded-lg transition-colors font-medium"
                        >
                            取消
                        </button>
                        <button
                            type="submit"
                            disabled={isLoading || !projectName.trim()}
                            className="px-6 py-2 bg-teal-600 hover:bg-teal-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold rounded-lg shadow-md hover:shadow-lg transition-all flex items-center"
                        >
                            {isLoading && <Loader2 size={16} className="animate-spin mr-2" />}
                            创建工程
                        </button>
                    </div>

                </form>
            </div>
        </div>
    );
}
