import { readProjectBuildTarget, sourceWithBuildTarget, type ProjectBuildTarget } from './project_build_target';
import { normalizeProjectIdentityPath } from './project_identity';

export const SOURCE_NAVIGATION_EVENT = 'ck-source-before-navigation';
export const EMPTY_SOURCE = 'void setup() {\n  // 初始化硬件\n}\n\nvoid loop() {\n  // 编写循环逻辑\n}\n';
export interface SourceDocument {
    format: 'ck-source-project'; schemaVersion: 1; code: string; target: ProjectBuildTarget | null;
}
export interface LoadedSource { path: string; revision: string; document: SourceDocument }
export interface SourceDiagnostic { line: number; column: number; severity: 'error' | 'warning'; message: string }

export function sourceDocument(code: string, target: ProjectBuildTarget | null): SourceDocument {
    if (new TextEncoder().encode(code).length > 1024 * 1024 || code.includes('\0')) throw Error('源码限 1 MiB，且不能包含空字符');
    return { format: 'ck-source-project', schemaVersion: 1, code, target: readProjectBuildTarget(target) };
}
export const sourceProjectIdentity = (path: string, unsavedId: string) => `source:${path ? normalizeProjectIdentityPath(path) : unsavedId}`;
export const sourceExport = (document: SourceDocument) => document.target ? sourceWithBuildTarget(document.code, document.target) : document.code;

/** Only map the original Sketch file. Generated .ino.cpp and library locations are not interchangeable. */
export function sourceDiagnostics(log: string, code: string): SourceDiagnostic[] {
    const lines = code.split('\n'); const output: SourceDiagnostic[] = []; const seen = new Set<string>();
    for (const row of log.split(/\r?\n/)) {
        const match = row.match(/(?:^|[\\/])sketch\.ino:(\d+):(\d+):\s*(?:fatal )?(error|warning):\s*(.+)$/);
        if (!match) continue;
        const line = Number(match[1]), column = Number(match[2]);
        if (line < 1 || line > lines.length || column < 1) continue;
        const key = `${line}:${column}:${match[4]}`;
        if (seen.has(key)) continue;
        seen.add(key); output.push({ line, column, severity: match[3] as 'error' | 'warning', message: match[4] });
        if (output.length >= 80) break;
    }
    return output;
}

export function appendSourceLog(previous: string, next: string): string {
    const value = previous + next;
    if (value.length <= 160000) return value;
    const start = value.indexOf('\n', value.length - 140000);
    return '[信息] 较早的输出已折叠，保留最近的编译诊断。\n' + value.slice(start < 0 ? -140000 : start + 1);
}
