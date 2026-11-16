import { useEffect, useRef } from 'react';
import { Loader2 } from 'lucide-react';
import { subscribeBuildActivity } from '../services/build_activity_animation';

export function BuildActivitySpinner({ size = 17 }: { size?: number }) {
    const ref = useRef<HTMLSpanElement>(null);
    useEffect(() => subscribeBuildActivity(phase => {
        if (ref.current) ref.current.style.transform = phase === null ? 'none' : `rotate(${phase * 360}deg)`;
    }), []);
    return <span ref={ref} data-ck-role="build-action-spinner" aria-hidden="true"
        className="inline-flex shrink-0 [contain:strict]" style={{ width: size, height: size, willChange: 'transform' }}>
        <Loader2 size={size} />
    </span>;
}
