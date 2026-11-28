import i18n from 'i18next';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { normalizeUiLocale, readLocalePreferences } from './preferences';

/**
 * Resolve whether the active UI locale is English.
 * Falls back to stored locale preferences when called outside initialized i18next
 * (for example, pure unit tests or early boot helpers).
 */
export function isEnglishLocale(language?: string): boolean {
  const candidate =
    language ??
    (i18n.isInitialized ? i18n.resolvedLanguage || i18n.language : undefined) ??
    readLocalePreferences().uiLocale;
  return normalizeUiLocale(candidate) === 'en-US';
}

/**
 * Pick localized UI copy for non-React services and helpers.
 */
export function uiText(zh: string, en: string, language?: string): string {
  return isEnglishLocale(language) ? en : zh;
}

/**
 * Reactive hook for React components so inline bilingual strings re-render
 * immediately whenever the user switches the interface language.
 */
export function useUiText() {
  const { i18n: activeI18n } = useTranslation();
  const isEn = isEnglishLocale(activeI18n.resolvedLanguage || activeI18n.language);
  const tr = useCallback((zh: string, en: string) => (isEn ? en : zh), [isEn]);
  return { isEn, tr };
}
