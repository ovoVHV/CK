export const LIBRARY_CATEGORY_IDS = {
    ALL: 'all',
    GENERAL: 'general',
} as const;

export type LibraryBaseCategoryId = typeof LIBRARY_CATEGORY_IDS[keyof typeof LIBRARY_CATEGORY_IDS];
export type LibraryCatalogCategoryId = LibraryBaseCategoryId | `vendor:${string}`;

export interface LibraryCatalogIdentityInput {
    id?: string;
    name?: string;
    vendor?: string;
    vendor_logo_path?: string;
    vendor_logo_url?: string;
    icon_path?: string;
    icon_url?: string;
    icon?: string;
    manifest?: {
        vendor?: string;
    };
}

export interface LibraryImageRef {
    kind: 'local' | 'remote';
    value: string;
}

export interface LibraryCatalogCategory {
    id: LibraryCatalogCategoryId;
    name?: string;
    logoPath?: string;
    logoUrl?: string;
    count: number;
}

const trimText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

export const safeRemoteLibraryImageUrl = (value: unknown): string | undefined => {
    const trimmed = trimText(value);
    if (!trimmed || !trimmed.startsWith('https://')) return undefined;
    try {
        const parsed = new URL(trimmed);
        return parsed.protocol === 'https:' ? trimmed : undefined;
    } catch {
        return undefined;
    }
};

/**
 * Only explicit `vendor` declares a brand/company category.
 * Package `author` / `maintainer` intentionally remain in the General category.
 */
export const libraryVendorName = (lib: LibraryCatalogIdentityInput): string => (
    trimText(lib.vendor) || trimText(lib.manifest?.vendor)
);

export const libraryCategoryId = (
    lib: LibraryCatalogIdentityInput,
): Exclude<LibraryCatalogCategoryId, 'all'> => {
    const vendor = libraryVendorName(lib);
    if (!vendor) return LIBRARY_CATEGORY_IDS.GENERAL;
    return `vendor:${vendor.normalize('NFKC').toLowerCase()}`;
};

export const libraryRowImageSource = (
    lib: LibraryCatalogIdentityInput,
): LibraryImageRef | null => {
    const localIcon = trimText(lib.icon_path);
    if (localIcon) return { kind: 'local', value: localIcon };
    const localVendorLogo = trimText(lib.vendor_logo_path);
    if (localVendorLogo) return { kind: 'local', value: localVendorLogo };
    const remoteIcon = safeRemoteLibraryImageUrl(lib.icon_url) || safeRemoteLibraryImageUrl(lib.icon);
    if (remoteIcon) return { kind: 'remote', value: remoteIcon };
    const remoteVendorLogo = safeRemoteLibraryImageUrl(lib.vendor_logo_url);
    if (remoteVendorLogo) return { kind: 'remote', value: remoteVendorLogo };
    return null;
};

export const libraryVendorLogoSource = (
    lib: LibraryCatalogIdentityInput,
): LibraryImageRef | null => {
    const localVendorLogo = trimText(lib.vendor_logo_path);
    if (localVendorLogo) return { kind: 'local', value: localVendorLogo };
    const remoteVendorLogo = safeRemoteLibraryImageUrl(lib.vendor_logo_url);
    if (remoteVendorLogo) return { kind: 'remote', value: remoteVendorLogo };
    return null;
};

export const libraryHasBrandVisual = (lib: LibraryCatalogIdentityInput): boolean => (
    Boolean(libraryVendorName(lib) || libraryRowImageSource(lib))
);

export function libraryCatalogCategories(
    libraries: readonly LibraryCatalogIdentityInput[],
): LibraryCatalogCategory[] {
    if (libraries.length === 0) return [{ id: LIBRARY_CATEGORY_IDS.ALL, count: 0 }];

    const sorted = [...libraries].sort((left, right) => {
        const leftKey = trimText(left.id) || trimText(left.name);
        const rightKey = trimText(right.id) || trimText(right.name);
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });

    let generalCount = 0;
    const vendorGroups = new Map<LibraryCatalogCategoryId, LibraryCatalogCategory>();

    for (const lib of sorted) {
        const id = libraryCategoryId(lib);
        if (id === LIBRARY_CATEGORY_IDS.GENERAL) {
            generalCount += 1;
            continue;
        }
        const vendorName = libraryVendorName(lib);
        const logoPath = trimText(lib.vendor_logo_path) || undefined;
        const logoUrl = safeRemoteLibraryImageUrl(lib.vendor_logo_url);
        const existing = vendorGroups.get(id);
        if (!existing) {
            vendorGroups.set(id, {
                id,
                name: vendorName,
                logoPath,
                logoUrl,
                count: 1,
            });
        } else {
            existing.count += 1;
            if (!existing.logoPath && logoPath) existing.logoPath = logoPath;
            if (!existing.logoUrl && logoUrl) existing.logoUrl = logoUrl;
        }
    }

    const categories: LibraryCatalogCategory[] = [
        { id: LIBRARY_CATEGORY_IDS.ALL, count: libraries.length },
    ];
    if (generalCount > 0) {
        categories.push({ id: LIBRARY_CATEGORY_IDS.GENERAL, count: generalCount });
    }
    categories.push(
        ...[...vendorGroups.values()].sort((left, right) => left.id.localeCompare(right.id)),
    );
    return categories;
}

export const resolveActiveLibraryCategory = (
    categories: readonly LibraryCatalogCategory[],
    selectedId: LibraryCatalogCategoryId,
): LibraryCatalogCategoryId => (
    categories.some((category) => category.id === selectedId)
        ? selectedId
        : LIBRARY_CATEGORY_IDS.ALL
);

export const filterLibrariesByCategory = <T extends LibraryCatalogIdentityInput>(
    libraries: readonly T[],
    activeCategoryId: LibraryCatalogCategoryId,
): T[] => {
    if (activeCategoryId === LIBRARY_CATEGORY_IDS.ALL) return [...libraries];
    return libraries.filter((lib) => libraryCategoryId(lib) === activeCategoryId);
};
