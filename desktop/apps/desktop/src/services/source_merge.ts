/** Bounded three-way text merge. Ambiguous edits are presented, never guessed. */
type Edit = { from: number; to: number; text: string };
export type SourceConflict = { id: number; line: number; base: string; manual: string; generated: string; before: string; after: string };
type Part = string | SourceConflict;
export interface SourceMerge { parts: Part[]; conflicts: SourceConflict[]; wholeFile?: boolean }
export const MAX_SOURCE_BYTES = 1024 * 1024;

function changes(a: string[], b: string[], budget: { remaining: number }): Edit[] {
    let start = 0, endA = a.length, endB = b.length;
    while (start < endA && start < endB && a[start] === b[start]) start++;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
    const prefix = a.slice(0, start).join('').length;
    const n = endA - start, m = endB - start;
    if (!n && !m) return [];
    if (!n || !m || (n + 1) * (m + 1) > budget.remaining) {
        return [{ from: prefix, to: prefix + a.slice(start, endA).join('').length, text: b.slice(start, endB).join('') }];
    }
    budget.remaining -= (n + 1) * (m + 1);
    const stride = m + 1, lcs = new Uint32Array((n + 1) * stride);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
        lcs[i * stride + j] = a[start + i] === b[start + j]
            ? 1 + lcs[(i + 1) * stride + j + 1]
            : Math.max(lcs[(i + 1) * stride + j], lcs[i * stride + j + 1]);
    }
    const edits: Edit[] = []; let i = 0, j = 0, offset = prefix, edit: Edit | undefined;
    const flush = () => { if (edit) edits.push(edit); edit = undefined; };
    while (i < n || j < m) {
        if (i < n && j < m && a[start + i] === b[start + j]) {
            flush(); offset += a[start + i++].length; j++;
        } else {
            edit ||= { from: offset, to: offset, text: '' };
            if (j < m && (i === n || lcs[i * stride + j + 1] > lcs[(i + 1) * stride + j])) edit.text += b[start + j++];
            else { offset += a[start + i++].length; edit.to = offset; }
        }
    }
    flush(); return edits;
}
function diff(base: string, next: string, budget: { remaining: number }): Edit[] {
    const lines = (s: string) => s.match(/[^\n]*\n|[^\n]+$/g) || [];
    // Keep literals and identifiers atomic: two independent digits of a pin
    // number must never silently become a third, unintended pin.
    const tokens = (s: string) => s.match(/"(?:\\[\s\S]|[^"\\\r\n])*"?|'(?:\\[\s\S]|[^'\\\r\n])*'?|(?:\d|\.\d)(?:[eEpP][+-]|[\w.'])*|[\p{L}_$][\p{L}\p{N}_$]*|[!%&*+\-./:<=>?^|~]+|\r?\n|[ \t]+|[\s\S]/gu) || [];
    return changes(lines(base), lines(next), budget).flatMap(edit => {
        if (edit.to - edit.from + edit.text.length > 65536) return [edit];
        return changes(tokens(base.slice(edit.from, edit.to)), tokens(edit.text), budget)
            .map(inner => ({ ...inner, from: edit.from + inner.from, to: edit.from + inner.to }));
    });
}
function overlaps(a: Edit, b: Edit) {
    if (a.from === a.to || b.from === b.to) return a.from <= b.to && b.from <= a.to;
    return a.from < b.to && b.from < a.to;
}
function apply(base: string, from: number, to: number, edits: Edit[]) {
    let result = '', at = from;
    for (const edit of edits) { result += base.slice(at, edit.from) + edit.text; at = edit.to; }
    return result + base.slice(at, to);
}
export function mergeSource(base: string, manual: string, generated: string): SourceMerge {
    if (manual === base || manual === generated) return { parts: [generated], conflicts: [] };
    if (generated === base) return { parts: [manual], conflicts: [] };
    const budget = { remaining: 2_000_000 };
    const left = diff(base, manual, budget), right = diff(base, generated, budget);
    const all = [...left.map(edit => ({ ...edit, side: 'manual' })), ...right.map(edit => ({ ...edit, side: 'generated' }))]
        .sort((a, b) => a.from - b.from || a.to - b.to);
    const parts: Part[] = [], conflicts: SourceConflict[] = []; let at = 0;
    for (let i = 0; i < all.length;) {
        const group = [all[i++]];
        let from = group[0].from, to = group[0].to;
        while (i < all.length && group.some(edit => overlaps(edit, all[i]))) { group.push(all[i]); to = Math.max(to, all[i++].to); }
        parts.push(base.slice(at, from));
        const m = group.filter(edit => edit.side === 'manual'), g = group.filter(edit => edit.side === 'generated');
        const a = apply(base, from, to, m), b = apply(base, from, to, g);
        if (!m.length) parts.push(b);
        else if (!g.length || a === b) parts.push(a);
        else {
            const lineStart = base.lastIndexOf('\n', from - 1) + 1, lineEnd = base.indexOf('\n', to);
            const conflict = { id: conflicts.length, line: base.slice(0, from).split('\n').length, base: base.slice(from, to), manual: a, generated: b,
                before: base.slice(Math.max(lineStart, from - 200), from), after: base.slice(to, Math.min(lineEnd < 0 ? base.length : lineEnd, to + 200)) };
            conflicts.push(conflict); parts.push(conflict);
        }
        at = to;
    }
    parts.push(base.slice(at));
    const encoder = new TextEncoder();
    const bytes = (s: string) => encoder.encode(s).length;
    if (parts.reduce((sum, p) => sum + (typeof p === 'string' ? bytes(p) : Math.max(bytes(p.manual), bytes(p.generated))), 0) > MAX_SOURCE_BYTES) {
        const choice = { id: 0, line: 1, before: '', after: '', base, manual, generated };
        return { parts: [choice], conflicts: [choice], wholeFile: true };
    }
    return { parts, conflicts };
}
export function resolveSourceMerge(merge: SourceMerge, choices: Record<number, 'manual' | 'generated'>): string {
    return merge.parts.map(part => {
        if (typeof part === 'string') return part;
        if (!choices[part.id]) throw Error('请先处理全部源码同步冲突。');
        return part[choices[part.id]];
    }).join('');
}
