'use client';

import { useEffect } from 'react';
import { THEME_STORAGE_KEY } from './theme-script';

export function ThemeSyncEffect(): null {
  useEffect(() => {
    try {
      const stored = localStorage.getItem(THEME_STORAGE_KEY);
      if (stored === 'light' || stored === 'dark') {
        document.documentElement.setAttribute('data-theme', stored);
      }
    } catch {
      // Storage denial intentionally preserves the server-selected theme.
    }
  }, []);

  return null;
}
