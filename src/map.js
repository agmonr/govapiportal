/**
 * Two-level map: portals at the top, APIs underneath, each with a live
 * request panel.
 */

import { el, esc } from './ui.js';
import { attachExplorer } from './explorer.js';

const portalGrid = el('portals');
const list = el('list');
const summary = el('summary');

let data = { portals: [], apis: [] };
const state = { q: '', browserOnly: false, portal: null };

/** Three states, not two: usable / blocked / unknown. Conflating the last two lies. */
function verdict(api) {
  if (api.browser) return { cls: 'ok', label: 'דפדפן ✓' };
  if (api.status === 200 && !api.cors) return { cls: 'warn', label: 'שרת בלבד' };
  if (api.status === 403) return { cls: 'bad', label: 'חסום' };
  if (api.endpoint === 'unknown' || api.status === 404) return { cls: 'unknown', label: 'לא אותר' };
  return { cls: 'warn', label: 'מוגבל' };
}

/* ---------- portal level ---------- */

function portalCard(p) {
  const active = state.portal === p.id ? ' active' : '';
  const cls = p.browser_count ? 'ok' : 'warn';
  return `
    <button class="portal${active}" data-portal="${esc(p.id)}" type="button">
      <span class="p-head">
        <span class="p-name" dir="auto">${esc(p.name_he)}</span>
        <span class="badge ${cls}">${p.browser_count}/${p.api_count}</span>
      </span>
      <span class="p-sub" dir="ltr">${esc(p.name)}</span>
      <span class="p-about" dir="auto">${esc(p.about)}</span>
      <span class="meta">
        <span class="tag">${esc(p.kind)}</span>
        ${p.domains.map((d) => `<span class="tag">${esc(d)}</span>`).join('')}
      </span>
    </button>`;
}

function renderPortals() {
  portalGrid.innerHTML = data.portals.map(portalCard).join('');
  portalGrid.querySelectorAll('.portal').forEach((btn) =>
    btn.addEventListener('click', () => {
      // Second click on the same portal clears the filter.
      state.portal = state.portal === btn.dataset.portal ? null : btn.dataset.portal;
      renderPortals();
      renderList();
    })
  );
}

/* ---------- api level ---------- */

function apiCard(api, i) {
  const v = verdict(api);
  const url = api.endpoint !== 'unknown' ? api.endpoint : null;
  const portal = data.portals.find((p) => p.id === api.portal);
  const canTry = Boolean(api.example || url);

  return `
    <article class="card api ${v.cls}">
      <div class="api-head">
        <h3 dir="auto">${esc(api.name)}</h3>
        <span class="badge ${v.cls}">${esc(v.label)}</span>
      </div>
      <div class="meta">
        <span class="tag" dir="auto">${esc(portal?.name_he || api.source)}</span>
        <span class="tag">${esc(api.domain)}</span>
        <span class="tag">${esc(api.format)}</span>
        <span class="tag">auth: ${esc(api.auth)}</span>
        <span class="tag">HTTP ${api.status ?? '—'}</span>
        <span class="tag">CORS: ${api.cors ? esc(api.cors) : '✗'}</span>
      </div>
      ${url ? `<p class="endpoint" dir="ltr"><code>${esc(api.method)} ${esc(url)}</code></p>` : ''}
      <p dir="auto">${esc(api.notes)}</p>
      ${canTry
        ? `<button class="toggle-ex" type="button" data-i="${i}">נסה בדפדפן ▾</button>
           <div class="ex-slot" data-i="${i}" hidden></div>`
        : ''}
    </article>`;
}

function renderList() {
  const q = state.q.toLowerCase();
  const shown = data.apis.filter((a) => {
    if (state.portal && a.portal !== state.portal) return false;
    if (state.browserOnly && !a.browser) return false;
    if (!q) return true;
    return [a.name, a.source, a.source_he, a.domain, a.endpoint, a.notes]
      .join(' ').toLowerCase().includes(q);
  });

  const callable = data.apis.filter((a) => a.browser).length;
  const scope = state.portal
    ? data.portals.find((p) => p.id === state.portal)?.name_he
    : 'הכל';
  summary.textContent =
    `${scope} · ${shown.length} מתוך ${data.apis.length} ממשקים · ` +
    `${callable} ניתנים לקריאה ישירה מהדפדפן`;

  list.innerHTML = shown.length
    ? shown.map(apiCard).join('')
    : '<div class="notice info">לא נמצאו תוצאות.</div>';

  // Explorers are built on demand - one live panel per API, only once opened.
  list.querySelectorAll('.toggle-ex').forEach((btn) => {
    btn.addEventListener('click', () => {
      const slot = list.querySelector(`.ex-slot[data-i="${btn.dataset.i}"]`);
      const opening = slot.hidden;
      slot.hidden = !opening;
      btn.textContent = opening ? 'נסה בדפדפן ▴' : 'נסה בדפדפן ▾';
      if (opening && !slot.dataset.ready) {
        attachExplorer(slot, shown[Number(btn.dataset.i)]);
        slot.dataset.ready = '1';
      }
    });
  });
}

/* ---------- wiring ---------- */

el('q').addEventListener('input', (e) => { state.q = e.target.value.trim(); renderList(); });
el('browser-only').addEventListener('change', (e) => {
  state.browserOnly = e.target.checked; renderList();
});
el('clear').addEventListener('click', () => {
  state.portal = null; state.q = ''; state.browserOnly = false;
  el('q').value = ''; el('browser-only').checked = false;
  renderPortals(); renderList();
});

async function load() {
  try {
    const res = await fetch(new URL('../apis.json', import.meta.url));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
    // Browser-callable first - that is the decision most visitors are here to make.
    data.apis.sort((a, b) => Number(b.browser) - Number(a.browser) || a.source.localeCompare(b.source));
    el('probed').textContent = `נבדק: ${data.probed}`;
    renderPortals();
    renderList();
  } catch (err) {
    list.innerHTML = `<div class="notice error">טעינת apis.json נכשלה: ${esc(err.message)}</div>`;
  }
}

load();
