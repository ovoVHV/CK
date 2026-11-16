import type { LibraryInfo } from '../types/library';

export interface CloudLibraryInstallItem {
    name: string;
    url: string;
}

export interface CloudLibraryInstallResult extends CloudLibraryInstallItem {
    status: 'checking' | 'installed' | 'failed' | 'unconfirmed';
    packageId?: string;
    reason?: 'refreshFailed' | 'notVisible' | 'runtimeDisabled';
    error?: unknown;
}

/** Installation and inventory refresh are separate outcomes. Never report success
 * just because the download command returned, or discard partial batch results. */
export async function installCloudLibraryQueue(
    items: readonly CloudLibraryInstallItem[],
    dependencies: {
        install: (item: CloudLibraryInstallItem) => Promise<string>;
        refresh: () => Promise<LibraryInfo[] | undefined>;
        onStart: (item: CloudLibraryInstallItem, index: number) => void;
        onRefresh: () => void;
        onResults: (results: CloudLibraryInstallResult[]) => void;
    },
): Promise<CloudLibraryInstallResult[]> {
    let results: CloudLibraryInstallResult[] = [];
    for (const [index, item] of items.entries()) {
        dependencies.onStart(item, index);
        try {
            const packageId = await dependencies.install(item);
            if (!packageId?.trim()) throw new Error('Installer did not return a package ID');
            results.push({ ...item, packageId, status: 'checking' });
        } catch (error) {
            results.push({ ...item, status: 'failed', error });
        }
        dependencies.onResults([...results]);
    }
    if (results.some(result => result.status === 'checking')) {
        dependencies.onRefresh();
        let inventory: LibraryInfo[] | undefined;
        let refreshError: unknown;
        try { inventory = await dependencies.refresh(); } catch (error) { refreshError = error; }
        results = results.map(result => {
            if (result.status !== 'checking') return result;
            if (!inventory) return { ...result, status: 'unconfirmed', reason: 'refreshFailed', error: refreshError };
            const installed = inventory.find(library => library.id === result.packageId && library.user_installed);
            if (!installed) return { ...result, status: 'unconfirmed', reason: 'notVisible' };
            if (['quality-blocked', 'legacy-disabled', 'approval-required'].includes(installed.runtime_activation?.state || '')) {
                return { ...result, status: 'unconfirmed', reason: 'runtimeDisabled', error: installed.runtime_activation?.reason };
            }
            return { ...result, status: 'installed' };
        });
        dependencies.onResults([...results]);
    }
    return results;
}
