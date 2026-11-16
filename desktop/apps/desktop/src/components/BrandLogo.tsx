/** Shared artwork; CSS theme switching keeps the orange circuit unchanged. */
export function BrandLogo({ className = '' }: { className?: string }) {
    return <span className={`ck-brand-logo inline-flex shrink-0 items-center ${className}`}>
        <img src="/brand/ck-mark-light.png" alt="CK" className="block h-full w-full object-contain dark:hidden" draggable={false} />
        <img src="/brand/ck-mark-dark.png" alt="CK" className="hidden h-full w-full object-contain dark:block" draggable={false} />
    </span>;
}
