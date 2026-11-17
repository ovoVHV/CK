import type { KeyboardEvent } from 'react';

export function WorkspaceModeSwitch({ source, disabled, onChange, onPrepareSource }: {
    source: boolean; disabled: boolean;
    onChange: (mode: 'blocks' | 'source') => void; onPrepareSource: () => void;
}) {
    const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
        if (disabled || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const nextSource = event.key === 'Home' ? false : event.key === 'End' ? true : !source;
        onChange(nextSource ? 'source' : 'blocks');
        event.currentTarget.querySelector<HTMLButtonElement>(`[data-ck-role="edit-${nextSource ? 'source' : 'blocks'}"]`)?.focus();
    };
    return <div className="ck-editor-tabs" role="tablist" aria-label="编程模式" onKeyDown={navigate}>
        <button type="button" role="tab" id="ck-blocks-tab" aria-controls="ck-blocks-panel" data-ck-role="edit-blocks"
            aria-selected={!source} tabIndex={source ? -1 : 0} disabled={disabled} onClick={() => onChange('blocks')}
            title="积木编程 · 编译当前积木">积木</button>
        <button type="button" role="tab" id="ck-source-tab" aria-controls="ck-source-panel" data-ck-role="edit-source"
            aria-selected={source} tabIndex={source ? 0 : -1} disabled={disabled} onClick={() => onChange('source')}
            onPointerEnter={onPrepareSource} onFocus={onPrepareSource} title="源码编程 · 编译当前手写源码">源码</button>
    </div>;
}
