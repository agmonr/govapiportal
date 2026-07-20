/**
 * The theme picker. Two looks: "clouds" (default, calm blue, unset
 * data-theme) and "fashion" (opt-in, black/gold - see [data-theme="fashion"]
 * in style.css). The choice is applied to <html> before first paint by an
 * inline script in <head> - see index.html/datagov.html - so switching pages
 * or reloading never flashes the other theme first.
 */
const KEY = 'theme';
const DEFAULT = 'clouds';

export function currentTheme() {
  return document.documentElement.getAttribute('data-theme') || DEFAULT;
}

export function initThemePicker(root) {
  if (!root) return;

  const sync = () => {
    const active = currentTheme();
    root.querySelectorAll('button[data-theme]').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.theme === active));
    });
  };

  root.querySelectorAll('button[data-theme]').forEach((b) => {
    b.addEventListener('click', () => {
      const choice = b.dataset.theme;
      if (choice === DEFAULT) document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', choice);
      try { localStorage.setItem(KEY, choice); } catch { /* private mode, etc. - theme just won't persist */ }
      sync();
    });
  });

  sync();
}
