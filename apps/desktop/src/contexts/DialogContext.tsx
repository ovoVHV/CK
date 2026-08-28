import {
    createContext,
    useContext,
    useEffect,
    useId,
    useRef,
    useState,
    type KeyboardEvent as ReactKeyboardEvent,
    type ReactNode,
} from 'react';
import {
    AlertTriangle,
    Check,
    CheckCircle,
    Info,
    X,
    XCircle,
} from 'lucide-react';
import {
    CKConfirmDialog,
    type CKConfirmDialogTone,
} from '../components/ui/CKConfirmDialog';

type DialogType = 'info' | 'success' | 'warning' | 'error';

export interface DialogOptions {
    title?: string;
    message: string;
    type?: DialogType;
    tone?: CKConfirmDialogTone;
    confirmLabel?: string;
    cancelLabel?: string;
}

interface PromptDialogOptions extends DialogOptions {
    defaultValue?: string;
    placeholder?: string;
    inputLabel?: string;
}

interface DialogContextType {
    confirm: (options: DialogOptions | string) => Promise<boolean>;
    alert: (options: DialogOptions | string) => Promise<void>;
    prompt: (options: PromptDialogOptions | string) => Promise<string | null>;
}

const DialogContext = createContext<DialogContextType | undefined>(undefined);

export const useDialog = () => {
    const context = useContext(DialogContext);
    if (!context) {
        throw new Error('useDialog must be used within a DialogProvider');
    }
    return context;
};

type DialogMode = 'confirm' | 'alert' | 'prompt';

interface DialogState extends DialogOptions {
    isOpen: boolean;
    mode: DialogMode;
    resolve: (value: any) => void;
    inputValue?: string;
    placeholder?: string;
    inputLabel?: string;
}

const confirmTone = (dialog: DialogOptions): CKConfirmDialogTone => {
    if (dialog.tone) return dialog.tone;
    if (dialog.type === 'error') return 'danger';
    if (dialog.type === 'warning') return 'warning';
    return 'normal';
};

const DIALOG_PRESENTATION = {
    info: {
        defaultTitle: '提示',
        icon: Info,
        iconWrapClass: 'bg-blue-50 dark:bg-blue-950/50',
        iconClass: 'text-blue-700 dark:text-blue-300',
        actionClass: 'border-blue-700 bg-blue-700 hover:bg-blue-800 focus-visible:ring-blue-300 dark:border-blue-600 dark:bg-blue-600 dark:hover:bg-blue-500',
    },
    success: {
        defaultTitle: '操作成功',
        icon: CheckCircle,
        iconWrapClass: 'bg-emerald-50 dark:bg-emerald-950/50',
        iconClass: 'text-emerald-700 dark:text-emerald-300',
        actionClass: 'border-emerald-700 bg-emerald-700 hover:bg-emerald-800 focus-visible:ring-emerald-300 dark:border-emerald-600 dark:bg-emerald-600 dark:hover:bg-emerald-500',
    },
    warning: {
        defaultTitle: '请注意',
        icon: AlertTriangle,
        iconWrapClass: 'bg-amber-50 dark:bg-amber-950/50',
        iconClass: 'text-amber-700 dark:text-amber-300',
        actionClass: 'border-amber-600 bg-amber-600 hover:bg-amber-700 focus-visible:ring-amber-300 dark:border-amber-500 dark:bg-amber-500 dark:hover:bg-amber-400',
    },
    error: {
        defaultTitle: '发生错误',
        icon: XCircle,
        iconWrapClass: 'bg-red-50 dark:bg-red-950/50',
        iconClass: 'text-red-700 dark:text-red-300',
        actionClass: 'border-red-600 bg-red-600 hover:bg-red-700 focus-visible:ring-red-300 dark:border-red-500 dark:bg-red-500 dark:hover:bg-red-400',
    },
} as const;

const FOCUSABLE_SELECTOR = [
    'button:not([disabled])',
    '[href]',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(',');

interface MessageDialogProps {
    dialog: DialogState;
    onCancel: () => void;
    onConfirm: () => void;
    onInputChange: (value: string) => void;
}

const MessageDialog = ({ dialog, onCancel, onConfirm, onInputChange }: MessageDialogProps) => {
    const dialogRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const confirmButtonRef = useRef<HTMLButtonElement>(null);
    const previousFocusRef = useRef<HTMLElement | null>(null);
    const titleId = useId();
    const messageId = useId();
    const inputId = useId();
    const type = dialog.type || 'info';
    const presentation = DIALOG_PRESENTATION[type];
    const DialogIcon = presentation.icon;
    const isPrompt = dialog.mode === 'prompt';
    const role = !isPrompt && (type === 'warning' || type === 'error')
        ? 'alertdialog'
        : 'dialog';

    useEffect(() => {
        previousFocusRef.current = document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        const focusFrame = window.requestAnimationFrame(() => {
            (isPrompt ? inputRef.current : confirmButtonRef.current)?.focus();
        });

        return () => {
            window.cancelAnimationFrame(focusFrame);
            document.body.style.overflow = previousOverflow;
            const previousFocus = previousFocusRef.current;
            previousFocusRef.current = null;
            window.requestAnimationFrame(() => {
                if (previousFocus?.isConnected) previousFocus.focus();
            });
        };
    }, [isPrompt]);

    useEffect(() => {
        const handleDocumentKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            onCancel();
        };

        document.addEventListener('keydown', handleDocumentKeyDown, true);
        return () => document.removeEventListener('keydown', handleDocumentKeyDown, true);
    }, [onCancel]);

    const handleDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            const target = event.target;
            const targetButton = target instanceof HTMLElement ? target.closest('button') : null;
            if (!targetButton && (isPrompt || document.activeElement === dialogRef.current)) {
                event.preventDefault();
                event.stopPropagation();
                onConfirm();
                return;
            }
        }

        if (event.key !== 'Tab') return;
        const modal = dialogRef.current;
        if (!modal) return;
        const focusable = Array.from(modal.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
            .filter(element => !element.hasAttribute('disabled') && element.getAttribute('aria-hidden') !== 'true');
        if (focusable.length === 0) {
            event.preventDefault();
            modal.focus();
            return;
        }

        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        if (event.shiftKey && (active === first || !modal.contains(active))) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && (active === last || !modal.contains(active))) {
            event.preventDefault();
            first.focus();
        }
    };

    return (
        <div
            className="fixed inset-0 z-[10000] flex items-center justify-center bg-slate-950/55 p-4 backdrop-blur-[2px]"
            data-ck-role="message-backdrop"
        >
            <div
                ref={dialogRef}
                role={role}
                aria-modal="true"
                aria-labelledby={titleId}
                aria-describedby={messageId}
                tabIndex={-1}
                data-ck-role="message-dialog"
                data-ck-dialog-mode={dialog.mode}
                data-ck-dialog-type={type}
                className="w-full max-w-[460px] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl outline-none dark:border-slate-700 dark:bg-slate-900"
                onKeyDown={handleDialogKeyDown}
            >
                <div className="flex items-start gap-3 px-5 pb-5 pt-5">
                    <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${presentation.iconWrapClass}`}>
                        <DialogIcon size={21} className={presentation.iconClass} aria-hidden="true" />
                    </div>
                    <div className="min-w-0 flex-1">
                        <h2 id={titleId} className="text-base font-bold text-slate-900 dark:text-slate-100">
                            {dialog.title || presentation.defaultTitle}
                        </h2>
                        <p
                            id={messageId}
                            className="mt-1.5 max-h-[45vh] overflow-y-auto whitespace-pre-wrap break-words pr-1 text-sm leading-6 text-slate-600 dark:text-slate-300"
                        >
                            {dialog.message}
                        </p>
                        {isPrompt && (
                            <div className="mt-4">
                                <label
                                    htmlFor={inputId}
                                    className="mb-1.5 block text-xs font-semibold text-slate-700 dark:text-slate-300"
                                >
                                    {dialog.inputLabel || '输入内容'}
                                </label>
                                <input
                                    ref={inputRef}
                                    id={inputId}
                                    type="text"
                                    value={dialog.inputValue ?? ''}
                                    placeholder={dialog.placeholder || ''}
                                    onChange={(event) => onInputChange(event.target.value)}
                                    className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-blue-600 focus:ring-2 focus:ring-blue-100 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100 dark:placeholder:text-slate-500 dark:focus:border-blue-400 dark:focus:ring-blue-950"
                                />
                            </div>
                        )}
                    </div>
                </div>

                <div className="flex flex-col-reverse gap-2 border-t border-slate-100 bg-slate-50/80 px-5 py-3 sm:flex-row sm:justify-end dark:border-slate-800 dark:bg-slate-950/40">
                    {isPrompt && (
                        <button
                            type="button"
                            data-ck-action="cancel-dialog"
                            onClick={onCancel}
                            className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                        >
                            <X size={15} aria-hidden="true" />
                            <span>{dialog.cancelLabel || '取消'}</span>
                        </button>
                    )}
                    <button
                        ref={confirmButtonRef}
                        type="button"
                        data-ck-action="submit-dialog"
                        onClick={onConfirm}
                        className={`inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border px-4 text-sm font-bold text-white shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 ${presentation.actionClass}`}
                    >
                        <Check size={15} aria-hidden="true" />
                        <span>{dialog.confirmLabel || (isPrompt ? '确定' : '知道了')}</span>
                    </button>
                </div>
            </div>
        </div>
    );
};

export const DialogProvider = ({ children }: { children: ReactNode }) => {
    const [dialog, setDialog] = useState<DialogState | null>(null);

    const confirm = (options: DialogOptions | string): Promise<boolean> => {
        const opts = typeof options === 'string' ? { message: options } : options;
        return new Promise((resolve) => {
            setDialog({
                ...opts,
                isOpen: true,
                mode: 'confirm',
                resolve,
            });
        });
    };

    const alert = (options: DialogOptions | string): Promise<void> => {
        const opts = typeof options === 'string' ? { message: options } : options;
        return new Promise((resolve) => {
            setDialog({
                ...opts,
                isOpen: true,
                mode: 'alert',
                resolve: () => resolve(),
            });
        });
    };

    const prompt = (options: PromptDialogOptions | string): Promise<string | null> => {
        const opts = typeof options === 'string' ? { message: options } : options;
        return new Promise((resolve) => {
            setDialog({
                ...opts,
                isOpen: true,
                mode: 'prompt',
                inputValue: opts.defaultValue ?? '',
                placeholder: opts.placeholder || '',
                inputLabel: opts.inputLabel,
                resolve,
            });
        });
    };

    const handleCancel = () => {
        if (!dialog) return;
        if (dialog.mode === 'prompt') dialog.resolve(null);
        else if (dialog.mode === 'alert') dialog.resolve(undefined);
        else dialog.resolve(false);
        setDialog(null);
    };

    const handleConfirm = () => {
        if (!dialog) return;
        if (dialog.mode === 'prompt') dialog.resolve(dialog.inputValue ?? '');
        else if (dialog.mode === 'alert') dialog.resolve(undefined);
        else dialog.resolve(true);
        setDialog(null);
    };

    const handlePromptInputChange = (value: string) => {
        setDialog((previous) => {
            if (!previous || previous.mode !== 'prompt') return previous;
            return { ...previous, inputValue: value };
        });
    };

    return (
        <DialogContext.Provider value={{ confirm, alert, prompt }}>
            {children}
            {dialog && dialog.isOpen && dialog.mode === 'confirm' && (
                <CKConfirmDialog
                    open
                    title={dialog.title}
                    message={dialog.message}
                    tone={confirmTone(dialog)}
                    confirmLabel={dialog.confirmLabel}
                    cancelLabel={dialog.cancelLabel}
                    onConfirm={handleConfirm}
                    onCancel={handleCancel}
                />
            )}
            {dialog && dialog.isOpen && dialog.mode !== 'confirm' && (
                <MessageDialog
                    dialog={dialog}
                    onCancel={handleCancel}
                    onConfirm={handleConfirm}
                    onInputChange={handlePromptInputChange}
                />
            )}
        </DialogContext.Provider>
    );
};
