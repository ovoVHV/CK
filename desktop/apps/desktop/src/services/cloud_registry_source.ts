export type CloudRegistryProvider = 'auto' | 'github' | 'gitee';

export const DEFAULT_GITEE_REGISTRY_URL = 'https://gitee.com/manong1234/makerlib.git';
export const DEFAULT_GITHUB_REGISTRY_URL = 'https://github.com/ovoVHV/CK-Libraries.git';

export const CLOUD_REGISTRY_STORAGE_KEYS = {
    provider: 'ck_custom_registry_provider',
    url: 'ck_custom_registry_url',
    giteeUrl: 'ck_custom_registry_url_gitee',
    githubUrl: 'ck_custom_registry_url_github',
} as const;

export interface CloudRegistrySavedUrls {
    gitee?: string;
    github?: string;
}

export interface CloudRegistryStorageLike {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

const trim = (value: unknown): string => String(value ?? '').trim();

export function detectCloudProviderFromUrl(url: string): 'github' | 'gitee' | null {
    const cleaned = trim(url).toLowerCase();
    if (!cleaned) return null;
    if (/(^|\/\/|@)gitee\.com[:/]/.test(cleaned) || cleaned.startsWith('gitee.com/')) {
        return 'gitee';
    }
    if (/(^|\/\/|@)github\.com[:/]/.test(cleaned) || cleaned.startsWith('github.com/')) {
        return 'github';
    }
    return null;
}

export function defaultRegistryUrlForProvider(provider: CloudRegistryProvider): string {
    return provider === 'github' ? DEFAULT_GITHUB_REGISTRY_URL : DEFAULT_GITEE_REGISTRY_URL;
}

function validSavedUrlFor(provider: 'github' | 'gitee', candidate: string | undefined): string {
    const cleaned = trim(candidate);
    if (!cleaned) return '';
    return detectCloudProviderFromUrl(cleaned) === provider ? cleaned : '';
}

export function resolveCloudProviderSwitch(
    nextProvider: CloudRegistryProvider,
    currentProvider: CloudRegistryProvider,
    currentUrl: string,
    savedUrls: CloudRegistrySavedUrls = {},
): {
    provider: CloudRegistryProvider;
    url: string;
    savedUrls: CloudRegistrySavedUrls;
} {
    const cleanedCurrent = trim(currentUrl);
    const detectedCurrent = detectCloudProviderFromUrl(cleanedCurrent);
    const nextSaved: CloudRegistrySavedUrls = {
        gitee: validSavedUrlFor('gitee', savedUrls.gitee) || undefined,
        github: validSavedUrlFor('github', savedUrls.github) || undefined,
    };

    if (detectedCurrent === 'gitee') {
        nextSaved.gitee = cleanedCurrent;
    } else if (detectedCurrent === 'github') {
        nextSaved.github = cleanedCurrent;
    } else if (cleanedCurrent && currentProvider === 'gitee') {
        nextSaved.gitee = cleanedCurrent;
    } else if (cleanedCurrent && currentProvider === 'github') {
        nextSaved.github = cleanedCurrent;
    }

    if (nextProvider === 'gitee') {
        const url = detectedCurrent === 'gitee'
            ? cleanedCurrent
            : (nextSaved.gitee || DEFAULT_GITEE_REGISTRY_URL);
        return { provider: 'gitee', url, savedUrls: nextSaved };
    }

    if (nextProvider === 'github') {
        const url = detectedCurrent === 'github'
            ? cleanedCurrent
            : (nextSaved.github || DEFAULT_GITHUB_REGISTRY_URL);
        return { provider: 'github', url, savedUrls: nextSaved };
    }

    const autoUrl = cleanedCurrent || nextSaved.gitee || nextSaved.github || DEFAULT_GITEE_REGISTRY_URL;
    return { provider: 'auto', url: autoUrl, savedUrls: nextSaved };
}

export function reconcileCloudRegistrySubmit(
    provider: CloudRegistryProvider,
    url: string,
): {
    provider: CloudRegistryProvider;
    url: string;
} {
    const cleanedUrl = trim(url);
    const detected = detectCloudProviderFromUrl(cleanedUrl);
    if (provider !== 'auto' && detected && detected !== provider) {
        return { provider: detected, url: cleanedUrl };
    }
    return { provider, url: cleanedUrl };
}

export function loadInitialCloudRegistryState(storage: CloudRegistryStorageLike): {
    provider: CloudRegistryProvider;
    url: string;
    savedUrls: CloudRegistrySavedUrls;
} {
    const rawProvider = trim(storage.getItem(CLOUD_REGISTRY_STORAGE_KEYS.provider)).toLowerCase();
    const provider: CloudRegistryProvider = rawProvider === 'github' || rawProvider === 'gitee' || rawProvider === 'auto'
        ? rawProvider
        : 'gitee';

    const legacyUrl = trim(storage.getItem(CLOUD_REGISTRY_STORAGE_KEYS.url));
    const legacyHost = detectCloudProviderFromUrl(legacyUrl);

    const savedUrls: CloudRegistrySavedUrls = {
        gitee: validSavedUrlFor('gitee', storage.getItem(CLOUD_REGISTRY_STORAGE_KEYS.giteeUrl) ?? undefined)
            || (legacyHost === 'gitee' ? legacyUrl : undefined),
        github: validSavedUrlFor('github', storage.getItem(CLOUD_REGISTRY_STORAGE_KEYS.githubUrl) ?? undefined)
            || (legacyHost === 'github' ? legacyUrl : undefined),
    };

    if (provider === 'gitee') {
        return {
            provider,
            url: savedUrls.gitee || DEFAULT_GITEE_REGISTRY_URL,
            savedUrls,
        };
    }

    if (provider === 'github') {
        return {
            provider,
            url: savedUrls.github || DEFAULT_GITHUB_REGISTRY_URL,
            savedUrls,
        };
    }

    return {
        provider: 'auto',
        url: legacyUrl || savedUrls.gitee || savedUrls.github || DEFAULT_GITEE_REGISTRY_URL,
        savedUrls,
    };
}

export function persistCloudRegistryState(
    storage: CloudRegistryStorageLike,
    provider: CloudRegistryProvider,
    url: string,
    savedUrls: CloudRegistrySavedUrls = {},
): void {
    const cleanedUrl = trim(url);
    storage.setItem(CLOUD_REGISTRY_STORAGE_KEYS.provider, provider);
    storage.setItem(CLOUD_REGISTRY_STORAGE_KEYS.url, cleanedUrl);

    const detected = detectCloudProviderFromUrl(cleanedUrl);
    const giteeUrl = detected === 'gitee' ? cleanedUrl : validSavedUrlFor('gitee', savedUrls.gitee);
    const githubUrl = detected === 'github' ? cleanedUrl : validSavedUrlFor('github', savedUrls.github);
    if (giteeUrl) {
        storage.setItem(CLOUD_REGISTRY_STORAGE_KEYS.giteeUrl, giteeUrl);
    }
    if (githubUrl) {
        storage.setItem(CLOUD_REGISTRY_STORAGE_KEYS.githubUrl, githubUrl);
    }
}
