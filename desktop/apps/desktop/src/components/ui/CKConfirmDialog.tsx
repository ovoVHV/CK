import {
    AlertTriangle,
    Check,
    CircleHelp,
    LoaderCircle,
    OctagonAlert,
    X,
} from 'lucide-react';
import {
    type KeyboardEvent as ReactKeyboardEvent,
    type MouseEvent as ReactMouseEvent,
    type ReactNode,
    useCallback,
    useEffect,
    useId,
    useRef,
    useState,
} from 'react';
import { useTranslation } from 'react-i18next';

export type CKConfirmDialogTone = 'normal' | 'warning' | 'danger';

export type CKConfirmDialogDismissReason = 'cancel' | 'escape' | 'backdrop';

export interface CKConfirmDialogProps {
    open: boolean;
    title?: string;
    message: ReactNode;
    tone?: CKConfirmDialogTone;
    confirmLabel?: string;
    cancelLabel?: string;
    pendingLabel?: string;
    busy?: boolean;
    confirmDisabled?: boolean;
    initialFocus?: 'confirm' | 'cancel';
    closeOnEscape?: boolean;
    dismissOnBackdrop?: boolean;
    confirmOnEnter?: boolean;
    onConfirm: () => void | Promise<void>;
    onCancel: (reason: CKConfirmDialogDismissReason) => void;
    onConfirmError?: (error: unknown) => void;
}

const TONE_CONTENT = {
    normal: {
        defaultTitleKey: 'dialog.confirm.title',
        icon: CircleHelp,
        iconWrapClass: 'bg-brand-50 dark:bg-brand-950/50',
        iconClass: 'text-brand-700 dark:text-brand-300',
        confirmClass: 'border-brand-700 bg-brand-700 hover:bg-brand-800 focus-visible:ring-brand-300 dark:border-brand-600 dark:bg-brand-600 dark:hover:bg-brand-500',
    },
    warning: {
        defaultTitleKey: 'dialog.confirm.warningTitle',
        icon: AlertTriangle,
        iconWrapClass: 'bg-amber-50 dark:bg-amber-950/50',
        iconClass: 'text-amber-700 dark:text-amber-300',
        confirmClass: 'border-amber-600 bg-amber-600 hover:bg-amber-700 focus-visible:ring-amber-300 dark:border-amber-500 dark:bg-amber-500 dark:hover:bg-amber-400',
    },
    danger: {
        defaultTitleKey: 'dialog.confirm.dangerTitle',
        icon: OctagonAlert,
        iconWrapClass: 'bg-red-50 dark:bg-red-950/50',
        iconClass: 'text-red-700 dark:text-red-300',
        confirmClass: 'border-red-600 bg-red-600 hover:bg-red-700 focus-visible:ring-red-300 dark:border-red-500 dark:bg-red-500 dark:hover:bg-red-400',
    },
} as const satisfies Record<CKConfirmDialogTone, {
    defaultTitleKey: string;
    icon: typeof CircleHelp;
    iconWrapClass: string;
    iconClass: string;
    confirmClass: string;
}>;

const FOCUSABLE_SELECTOR = [
    'button:not([disabled])',
    '[href]',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(',');

const isTextAreaOrEditable = (target: EventTarget | null): boolean => (
    target instanceof HTMLTextAreaElement
    || (target instanceof HTMLElement && target.isContentEditable)
);

export function CKConfirmDialog({
    open,
    title,
    message,
    tone = 'normal',
    confirmLabel,
    cancelLabel,
    pendingLabel,
    busy = false,
    confirmDisabled = false,
    initialFocus,
    closeOnEscape = true,
    dismissOnBackdrop = false,
    confirmOnEnter = true,
    onConfirm,
    onCancel,
    onConfirmError,
}: CKConfirmDialogProps) {
    const { t } = useTranslation();
    const [internalSubmitting, setInternalSubmitting] = useState(false);
    const mountedRef = useRef(true);
    const submittingRef = useRef(false);
    const dialogRef = useRef<HTMLDivElement>(null);
    const confirmButtonRef = useRef<HTMLButtonElement>(null);
    const cancelButtonRef = useRef<HTMLButtonElement>(null);
    const previousFocusRef = useRef<HTMLElement | null>(null);
    const titleId = useId();
    const messageId = useId();
    const effectiveBusy = busy || internalSubmitting;
    const toneContent = TONE_CONTENT[tone];
    const ToneIcon = toneContent.icon;
    const effectiveConfirmLabel = confirmLabel ?? t('common.actions.confirm');
    const effectiveCancelLabel = cancelLabel ?? t('common.actions.cancel');
    const effectivePendingLabel = pendingLabel ?? t('common.status.processing');
    const preferredInitialFocus = initialFocus || (tone === 'normal' ? 'confirm' : 'cancel');

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    useEffect(() => {
        if (!open) {
            submittingRef.current = false;
            setInternalSubmitting(false);
            return;
        }

        previousFocusRef.current = document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        const focusFrame = window.requestAnimationFrame(() => {
            const preferred = effectiveBusy
                ? dialogRef.current
                : preferredInitialFocus === 'confirm' && !confirmDisabled
                    ? confirmButtonRef.current
                    : cancelButtonRef.current;
            (preferred || confirmButtonRef.current || dialogRef.current)?.focus();
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
        // Focus is intentionally selected once when the dialog opens. Changing
        // tone while open must not overwrite the element that receives focus back.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    const attemptConfirm = useCallback(async () => {
        if (!open || confirmDisabled || busy || submittingRef.current) return;
        submittingRef.current = true;
        setInternalSubmitting(true);
        try {
            await onConfirm();
        } catch (error) {
            if (onConfirmError) onConfirmError(error);
            else console.error('CK confirmation action failed', error);
        } finally {
            submittingRef.current = false;
            if (mountedRef.current) setInternalSubmitting(false);
        }
    }, [busy, confirmDisabled, onConfirm, onConfirmError, open]);

    const attemptCancel = useCallback((reason: CKConfirmDialogDismissReason) => {
        if (!open || effectiveBusy || submittingRef.current) return;
        onCancel(reason);
    }, [effectiveBusy, onCancel, open]);

    useEffect(() => {
        if (!open) return;

        const handleDocumentKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                if (!closeOnEscape || effectiveBusy) return;
                event.preventDefault();
                event.stopPropagation();
                attemptCancel('escape');
                return;
            }

            if (event.key !== 'Enter' || !confirmOnEnter || event.isComposing) return;
            if (isTextAreaOrEditable(event.target)) return;
            const targetButton = event.target instanceof HTMLElement
                ? event.target.closest('button')
                : null;
            if (targetButton && targetButton !== confirmButtonRef.current) return;
            event.preventDefault();
            event.stopPropagation();
            void attemptConfirm();
        };

        document.addEventListener('keydown', handleDocumentKeyDown, true);
        return () => document.removeEventListener('keydown', handleDocumentKeyDown, true);
    }, [attemptCancel, attemptConfirm, closeOnEscape, confirmOnEnter, effectiveBusy, open]);

    const handleDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'Tab') return;
        const dialog = dialogRef.current;
        if (!dialog) return;
        const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
            .filter(element => !element.hasAttribute('disabled') && element.getAttribute('aria-hidden') !== 'true');
        if (focusable.length === 0) {
            event.preventDefault();
            dialog.focus();
            return;
        }

        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        if (event.shiftKey && (active === first || !dialog.contains(active))) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
            event.preventDefault();
            first.focus();
        }
    };

    const handleBackdropMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
        if (event.target === event.currentTarget && dismissOnBackdrop) attemptCancel('backdrop');
    };

    if (!open) return null;

    return (
        <div
            className="fixed inset-0 z-[10000] flex items-center justify-center bg-slate-950/55 p-4 backdrop-blur-[2px]"
            data-ck-role="confirm-backdrop"
            onMouseDown={handleBackdropMouseDown}
        >
            <div
                ref={dialogRef}
                role={tone === 'normal' ? 'dialog' : 'alertdialog'}
                aria-modal="true"
                aria-labelledby={titleId}
                aria-describedby={messageId}
                aria-busy={effectiveBusy}
                tabIndex={-1}
                data-ck-role="confirm-dialog"
                data-ck-confirm-tone={tone}
                className="w-full max-w-[440px] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl outline-none dark:border-slate-700 dark:bg-slate-900"
                onKeyDown={handleDialogKeyDown}
            >
                <div className="flex items-start gap-3 px-5 pb-4 pt-5">
                    <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${toneContent.iconWrapClass}`}>
                        <ToneIcon size={21} className={toneContent.iconClass} aria-hidden="true" />
                    </div>
                    <div className="min-w-0 flex-1">
                        <h2 id={titleId} className="text-base font-bold text-slate-900 dark:text-slate-100">
                            {title || t(toneContent.defaultTitleKey)}
                        </h2>
                        <div
                            id={messageId}
                            className="mt-1.5 max-h-[50vh] overflow-y-auto whitespace-pre-wrap break-words pr-1 text-sm leading-6 text-slate-600 dark:text-slate-300"
                        >
                            {message}
                        </div>
                    </div>
                </div>

                <div className="flex flex-col-reverse gap-2 border-t border-slate-100 bg-slate-50/80 px-5 py-3 sm:flex-row sm:justify-end dark:border-slate-800 dark:bg-slate-950/40">
                    <button
                        ref={cancelButtonRef}
                        type="button"
                        disabled={effectiveBusy}
                        data-ck-action="cancel-confirm"
                        className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                        onClick={() => attemptCancel('cancel')}
                    >
                        <X size={15} aria-hidden="true" />
                        <span>{effectiveCancelLabel}</span>
                    </button>
                    <button
                        ref={confirmButtonRef}
                        type="button"
                        disabled={effectiveBusy || confirmDisabled}
                        data-ck-action="submit-confirm"
                        className={`inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border px-4 text-sm font-bold text-white shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50 ${toneContent.confirmClass}`}
                        onClick={() => void attemptConfirm()}
                    >
                        {effectiveBusy
                            ? <LoaderCircle size={15} className="animate-spin" aria-hidden="true" />
                            : <Check size={15} aria-hidden="true" />}
                        <span>{effectiveBusy ? effectivePendingLabel : effectiveConfirmLabel}</span>
                    </button>
                </div>
            </div>
        </div>
    );
}

export default CKConfirmDialog;
