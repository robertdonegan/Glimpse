import { useEffect, useState } from 'react';

const KEY = 'glimpse.theme';

export function initTheme(): void {
  document.documentElement.dataset.theme = localStorage.getItem(KEY) ?? 'dark';
}

export function ThemeToggle() {
  const [theme, setTheme] = useState(
    () => document.documentElement.dataset.theme ?? 'dark',
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(KEY, theme);
  }, [theme]);

  return (
    <button
      className="btn quiet"
      onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
      title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      aria-label="Toggle colour theme"
    >
      {theme === 'dark' ? '☀︎' : '☾'}
    </button>
  );
}
