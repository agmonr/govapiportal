/** Shared DOM helpers. */

export const el = (id) => document.getElementById(id);

/* Shared by every renderer. They live here rather than in one module because
   bundle.py flattens all sources into a single scope - a second `const num`
   anywhere would be a redeclaration, not a shadow. */

export const num = (v) => (v == null ? '—' : Number(v).toLocaleString('he-IL'));

/** Bytes -> a size someone can judge a download by. */
export function bytes(n) {
  if (n == null || Number.isNaN(Number(n))) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let v = Number(n), i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v < 10 && i ? 1 : 0)} ${u[i]}`;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

/** Renders CkanError.kind as something a user can act on. */
export function showError(node, err) {
  const messages = {
    blocked:
      'החסימה מגיעה מ-data.gov.il (403). נסה שוב בעוד מספר דקות.',
    rate_limit: 'יותר מדי בקשות. ממתין ומנסה שוב…',
    network: 'שגיאת רשת. בדוק את החיבור לאינטרנט.',
  };
  const hint = messages[err?.kind] || err?.message || 'אירעה שגיאה.';
  node.innerHTML = `<div class="notice error" dir="auto">${esc(hint)}</div>`;
  if (err) console.error(err);
}

export function showInfo(node, text) {
  node.innerHTML = `<div class="notice info" dir="auto">${esc(text)}</div>`;
}

export function showLoading(node, text = 'טוען…') {
  node.innerHTML = `<div class="skeleton" dir="auto">${esc(text)}</div>`;
}

export const clear = (node) => { node.innerHTML = ''; };

export const param = (name) => new URLSearchParams(location.search).get(name);

/** Debounce for search-as-you-type without hammering the API. */
export function debounce(fn, ms = 300) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
