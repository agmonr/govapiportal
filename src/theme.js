/**
 * The theme picker. Three looks, labeled יום/לילה/זברה in the markup: "clouds"
 * (יום, default - see [data-theme="clouds"] in style.css), "fashion" (לילה,
 * opt-in black/gold - see [data-theme="fashion"]) and "zebra" (זברה, opt-in
 * black/white - see [data-theme="zebra"]). An explicit choice always sets
 * data-theme (even for clouds) so it pins the palette regardless of the
 * visitor's OS color-scheme preference - a page with no saved choice at all
 * has no attribute and follows prefers-color-scheme instead. The choice is
 * applied to <html> before first paint by an inline script in <head> - see
 * index.html/datagov.html - so switching pages or reloading never flashes
 * another theme first.
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
      document.documentElement.setAttribute('data-theme', choice);
      try { localStorage.setItem(KEY, choice); } catch { /* private mode, etc. - theme just won't persist */ }
      sync();
    });
  });

  sync();
}
