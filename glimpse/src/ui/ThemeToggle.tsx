/* Theme plumbing. The visible switch is the placeholder logo in the editor
   top bar (see Editor.tsx) — clicking it swaps light/dark. */

const KEY = 'glimpse.theme';

export function initTheme(): void {
  document.documentElement.dataset.theme = localStorage.getItem(KEY) ?? 'light';
}

export function toggleTheme(): void {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem(KEY, next);
}
