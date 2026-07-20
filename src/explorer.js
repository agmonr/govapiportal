/**
 * Live API browser.
 *
 * Issues the request straight from the page. That is the point: for a
 * CORS-blocked API the failure IS the demonstration, so failures are reported
 * precisely rather than swallowed.
 */

import { esc } from './ui.js';

const MAX_RENDER = 400_000; // don't try to pretty-print a 10 MB body

/**
 * A cross-origin block surfaces as an opaque TypeError with no status - the
 * browser refuses to expose the response. Distinguish that from a real network
 * failure so the message isn't misleading.
 */
function describeFailure(err, api) {
  if (err.name === 'AbortError') return 'הבקשה בוטלה (timeout).';
  if (err instanceof TypeError) {
    return api && !api.cors
      ? 'הבקשה נחסמה על ידי הדפדפן (CORS). ל-API הזה אין כותרת Access-Control-Allow-Origin, ' +
        'ולכן לא ניתן לקרוא לו מדף סטטי — נדרש proxy או שליפה בזמן build.'
      : 'הבקשה נכשלה: חסימת CORS או תקלת רשת. הדפדפן לא חושף את הסיבה המדויקת.';
  }
  return err.message;
}

function highlight(text) {
  // Minimal JSON colouring; escaped first, so this only ever wraps safe text.
  return esc(text)
    .replace(/(&quot;[^&]*?&quot;)(\s*:)/g, '<span class="j-key">$1</span>$2')
    .replace(/:\s*(&quot;.*?&quot;)/g, ': <span class="j-str">$1</span>')
    .replace(/:\s*(-?\d+\.?\d*)/g, ': <span class="j-num">$1</span>')
    .replace(/:\s*(true|false|null)/g, ': <span class="j-bool">$1</span>');
}

function renderBody(text, ctype) {
  if (text.length > MAX_RENDER) {
    return `<pre dir="ltr">${esc(text.slice(0, MAX_RENDER))}\n\n… (${text.length.toLocaleString()} תווים, נחתך)</pre>`;
  }
  if (/json/.test(ctype)) {
    try {
      return `<pre dir="ltr">${highlight(JSON.stringify(JSON.parse(text), null, 2))}</pre>`;
    } catch { /* fall through to raw */ }
  }
  return `<pre dir="ltr">${esc(text)}</pre>`;
}

/** Builds the try-it panel for one API and wires it up. */
export function attachExplorer(container, api) {
  container.innerHTML = `
    <div class="explorer">
      <div class="ex-bar">
        <span class="ex-method">${esc(api.method)}</span>
        <input type="text" class="ex-url" dir="ltr" value="${esc(api.example || api.endpoint)}"
               spellcheck="false" aria-label="כתובת הבקשה">
        <button class="ex-run" type="button">שלח</button>
      </div>
      <div class="ex-out" aria-live="polite"></div>
    </div>`;

  const urlInput = container.querySelector('.ex-url');
  const btn = container.querySelector('.ex-run');
  const out = container.querySelector('.ex-out');

  async function send() {
    const url = urlInput.value.trim();
    if (!url) return;

    btn.disabled = true;
    out.innerHTML = '<div class="skeleton">שולח…</div>';

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    const t0 = performance.now();

    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json,*/*' } });
      const text = await res.text();
      const ms = Math.round(performance.now() - t0);
      const ctype = res.headers.get('content-type') || '';
      const ok = res.ok ? 'ok' : 'bad';

      out.innerHTML = `
        <div class="ex-status">
          <span class="badge ${ok}">HTTP ${res.status}</span>
          <span class="tag">${ms} ms</span>
          <span class="tag" dir="ltr">${esc(ctype.split(';')[0] || '—')}</span>
          <span class="tag">${text.length.toLocaleString()} תווים</span>
        </div>
        ${renderBody(text, ctype)}`;
    } catch (err) {
      out.innerHTML = `<div class="notice error" dir="auto">${esc(describeFailure(err, api))}</div>`;
    } finally {
      clearTimeout(timer);
      btn.disabled = false;
    }
  }

  btn.addEventListener('click', send);
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); send(); }
  });
}
