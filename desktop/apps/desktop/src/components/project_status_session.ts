import { useSyncExternalStore } from 'react';
import type { CompileDoctorReport } from '../services/compile_doctor';
import type { CompileIssueCard } from '../services/compile_issue_cards';
import type { ResourcePreflightReport } from '../services/resource_preflight';

/** Ephemeral presentation only. Never persisted in project, evidence, or preferences. */
export interface ProjectStatusSnapshot {
    compileReport: CompileDoctorReport | null;
    resourceReport: ResourcePreflightReport | null;
    issues: CompileIssueCard[];
    dirty: boolean;
    observedAt: number;
}
const snapshots = new Map<string, ProjectStatusSnapshot>();
const listeners = new Set<() => void>();
export function publishProjectStatus(path: string, snapshot: ProjectStatusSnapshot) {
    if (!path) return;
    snapshots.delete(path);
    snapshots.set(path, snapshot);
    // Bound session-only history; do not retain every project's raw reports.
    if (snapshots.size > 12) snapshots.delete(snapshots.keys().next().value!);
    listeners.forEach(listener => listener());
}
export function readProjectStatus(path: string) { return snapshots.get(path) ?? null; }
function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
export function useProjectStatus(path: string) {
    return useSyncExternalStore(subscribe, () => readProjectStatus(path), () => null);
}
export function readRecentProjectPath() { return [...snapshots.keys()].pop() ?? null; }
export function useRecentProjectPath() {
    return useSyncExternalStore(subscribe, readRecentProjectPath, () => null);
}
