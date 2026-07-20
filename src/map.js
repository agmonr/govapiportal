/** Renders apis.json as a filterable reference map. */

import { el, esc } from './ui.js';

const list = el('list');
const summary = el('summary');

let apis = [];
const state = { q: '', browserOnly: false };

/** Three states, not two: usable / blocked / unknown. Conflating the last two lies. */
function verdict(api) {
  if (api.browser) return { cls: 'ok', label: 'דפדפן ✓' };
  if (api.status === 200 && !api.cors) return { cls: 'warn', label: 'שרת בלבד' };
  if (api.status === 403) return { cls: 'bad', label: 'חסום' };
  if (api.endpoint === 'unknown' || api.status === 404) return { cls: 'unknown', label: 'לא אותר' };
  return { cls: 'warn', label: 'מוגבל' };
}

function row(api) {
  const v = verdict(api);
  const url = api.endpoint !== 'unknown' ? api.endpoint : null;

  return `
    <article class="card api ${v.cls}">
      <div class="api-head">
        <h3 dir="auto">${esc(api.name)}</h3>
        <span class="badge ${v.cls}">${esc(v.label)}</span>
      </div>
      <div class="meta">
        <span class="tag" dir="auto">${esc(api.source_he || api.source)}</span>
        <span class="tag">${esc(api.domain)}</span>
        <span class="tag">${esc(api.format)}</span>
        <span class="tag">auth: ${esc(api.auth)}</span>
        <span class="tag">HTTP ${api.status ?? '—'}</span>
        <span class="tag">CORS: ${api.cors ? esc(api.cors) : '✗'}</span>
      </div>
      ${url ? `<p class="endpoint" dir="ltr"><code>${esc(api.method)} ${esc(url)}</code></p>` : ''}
      <p dir="auto">${esc(api.notes)}</p>
      ${api.example ? `<p><a href="${esc(api.example)}" target="_blank" rel="noopener" dir="ltr">נסה →</a></p>` : ''}
    </article>`;
}

function render() {
  const q = state.q.toLowerCase();
  const shown = apis.filter((a) => {
    if (state.browserOnly && !a.browser) return false;
    if (!q) return true;
    return [a.name, a.source, a.source_he, a.domain, a.endpoint, a.notes]
      .join(' ').toLowerCase().includes(q);
  });

  const callable = apis.filter((a) => a.browser).length;
  summary.textContent =
    `${shown.length} מתוך ${apis.length} ממשקים · ${callable} ניתנים לקריאה ישירה מהדפדפן`;

  list.innerHTML = shown.length
    ? shown.map(row).join('')
    : '<div class="notice info">לא נמצאו תוצאות.</div>';
}

el('q').addEventListener('input', (e) => { state.q = e.target.value.trim(); render(); });
el('browser-only').addEventListener('change', (e) => {
  state.browserOnly = e.target.checked; render();
});

async function load() {
  try {
    // Resolved against this module, not the document, so it survives being
    // imported from a page at any path.
    const res = await fetch(new URL('../apis.json', import.meta.url));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    apis = data.apis;
    // Browser-callable first - that is the decision most visitors are here to make.
    apis.sort((a, b) => Number(b.browser) - Number(a.browser) || a.source.localeCompare(b.source));
    el('probed').textContent = `נבדק: ${data.probed}`;
    render();
  } catch (err) {
    list.innerHTML = `<div class="notice error">טעינת apis.json נכשלה: ${esc(err.message)}</div>`;
  }
}

load();
