import { CheckCircle, Loader2, XCircle, X, Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface ToastProps {
    message: string;
    type: 'info' | 'loading' | 'success' | 'error';
    show: boolean;
    onClose: () => void;
}

export const Toast = ({ message, type, show, onClose }: ToastProps) => {
    const { t } = useTranslation();
    if (!show) return null;

    let icon = <Info size={20} className="text-blue-500" />;
    let bgColor = "bg-white dark:bg-slate-800";
    let textColor = "text-slate-800 dark:text-slate-200";
    let borderColor = "border-slate-200 dark:border-slate-700";

    if (type === 'loading') {
        icon = <Loader2 size={20} className="text-blue-500 animate-spin" />;
    } else if (type === 'error') {
        icon = <XCircle size={20} className="text-red-500" />;
        borderColor = "border-red-100 dark:border-red-900/60";
    } else if (type === 'success') {
        icon = <CheckCircle size={20} className="text-green-500" />;
        borderColor = "border-green-100 dark:border-green-900/60";
    }

    return (
        <div className={`fixed top-20 left-1/2 transform -translate-x-1/2 z-50 flex items-center space-x-3 px-6 py-4 rounded-xl shadow-2xl border ${borderColor} ${bgColor} ${textColor} animate-in fade-in slide-in-from-top-4 duration-300 min-w-[300px]`}>
            {icon}
            <span className="text-sm font-medium flex-1">{message}</span>
            {type !== 'loading' && (
                <button
                    onClick={onClose}
                    aria-label={t('common.actions.close')}
                    className="ml-4 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors"
                >
                    <X size={16} />
                </button>
            )}
        </div>
    );
};
