import { useCallback, useEffect, useState } from 'react';

export const THEME_STORAGE_KEY = 'ace_theme';
export type ThemeMode = 'dark' | 'light';

const THEME_CHANGE_EVENT = 'ace-theme-change';

export function getSavedTheme(storage?: Pick<Storage, 'getItem'> | null): ThemeMode {
  try {
    const store = storage === undefined ? (typeof window !== 'undefined' ? window.localStorage : null) : storage;
    const raw = store?.getItem(THEME_STORAGE_KEY);
    return raw === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function applyTheme(
  mode: ThemeMode,
  root: HTMLElement | null = typeof document !== 'undefined' ? document.documentElement : null,
  storage: Pick<Storage, 'setItem'> | null = typeof window !== 'undefined' ? window.localStorage : null,
): ThemeMode {
  if (root) {
    root.classList.toggle('ace-light', mode === 'light');
    root.classList.toggle('dark', mode === 'dark');
    root.style.colorScheme = mode;
  }
  try {
    storage?.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // Ignore restricted storage contexts
  }
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent<ThemeMode>(THEME_CHANGE_EVENT, { detail: mode }));
  }
  return mode;
}

export function toggleThemePreference(): ThemeMode {
  const current =
    typeof document !== 'undefined' && document.documentElement.classList.contains('ace-light')
      ? 'light'
      : getSavedTheme();
  const next: ThemeMode = current === 'light' ? 'dark' : 'light';
  return applyTheme(next);
}

export function useThemeMode() {
  const [theme, setTheme] = useState<ThemeMode>(() => {
    if (typeof document !== 'undefined' && document.documentElement.classList.contains('ace-light')) {
      return 'light';
    }
    return getSavedTheme();
  });

  useEffect(() => {
    const sync = () => setTheme(getSavedTheme());
    const onThemeEvent = (e: Event) => {
      const custom = e as CustomEvent<ThemeMode>;
      if (custom.detail === 'light' || custom.detail === 'dark') {
        setTheme(custom.detail);
      } else {
        sync();
      }
    };
    const onStorage = (e: StorageEvent) => {
      if (!e.key || e.key === THEME_STORAGE_KEY) {
        const next = getSavedTheme();
        applyTheme(next);
        setTheme(next);
      }
    };
    window.addEventListener(THEME_CHANGE_EVENT, onThemeEvent);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(THEME_CHANGE_EVENT, onThemeEvent);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const setMode = useCallback((mode: ThemeMode) => {
    applyTheme(mode);
    setTheme(mode);
  }, []);

  const toggleTheme = useCallback(() => {
    const next = toggleThemePreference();
    setTheme(next);
    return next;
  }, []);

  return {
    theme,
    isLight: theme === 'light',
    setTheme: setMode,
    toggleTheme,
  };
}

export function getChartTheme(isLight: boolean) {
  return {
    gridStroke: isLight ? '#E2E8F0' : '#292D36',
    axisStroke: isLight ? '#64748B' : '#A1A1AA',
    tickFill: isLight ? '#475569' : '#C4C4CC',
    tooltipBg: isLight ? '#FFFFFF' : '#151922',
    tooltipBorder: isLight ? '#CBD5E1' : '#292D36',
    tooltipText: isLight ? '#0F172A' : '#FFFFFF',
    tooltipMuted: isLight ? '#475569' : '#A1A1AA',
    cursorFill: isLight ? 'rgba(15, 23, 42, 0.05)' : 'rgba(255, 255, 255, 0.04)',
    trackBg: isLight ? '#E2E8F0' : '#1B1F28',
  };
}
