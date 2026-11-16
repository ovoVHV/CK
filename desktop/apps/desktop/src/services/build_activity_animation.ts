type Paint = (phase: number | null) => void;
const paints = new Set<Paint>();
let stop: (() => void) | undefined;

/** One display-synchronized 60 Hz loop for all small build activity elements. */
export function subscribeBuildActivity(paint: Paint): () => void {
    paints.add(paint);
    if (!stop) {
        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
        let frame: number | undefined;
        let nextPaintAt = 0;
        const startedAt = performance.now();
        const draw = (phase: number | null) => paints.forEach(callback => callback(phase));
        const animate = (now: number) => {
            frame = undefined;
            if (document.hidden || reduced.matches) return;
            if (now + 0.5 >= nextPaintAt) {
                draw(((now - startedAt) % 2000) / 2000);
                nextPaintAt += 1000 / 60;
                if (nextPaintAt < now) nextPaintAt = now + 1000 / 60;
            }
            frame = requestAnimationFrame(animate);
        };
        const update = () => {
            if (frame !== undefined) cancelAnimationFrame(frame);
            frame = undefined;
            if (reduced.matches) draw(null);
            else if (!document.hidden) {
                nextPaintAt = performance.now();
                frame = requestAnimationFrame(animate);
            }
        };
        stop = () => {
            if (frame !== undefined) cancelAnimationFrame(frame);
            reduced.removeEventListener('change', update);
            document.removeEventListener('visibilitychange', update);
        };
        reduced.addEventListener('change', update);
        document.addEventListener('visibilitychange', update);
        update();
    }
    return () => {
        paints.delete(paint);
        if (!paints.size) { stop?.(); stop = undefined; }
    };
}
