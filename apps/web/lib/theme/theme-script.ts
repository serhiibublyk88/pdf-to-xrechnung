export const THEME_STORAGE_KEY = 'theme';

export type Theme = 'dark' | 'light';

export function resolveTheme(attributeValue: string | null): Theme {
  return attributeValue === 'light' ? 'light' : 'dark';
}
export const themeInitScript = `
(function () {
  try {
    var stored = localStorage.getItem('${THEME_STORAGE_KEY}');
    if (stored === 'light' || stored === 'dark') {
      document.documentElement.setAttribute('data-theme', stored);
    }
  } catch {}
})();
`;
