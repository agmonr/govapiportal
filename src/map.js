/**
 * Two-level map: portals at the top, APIs underneath, each with a live
 * request panel.
 */

import { el, esc } from './ui.js';
import { attachExplorer } from './explorer.js';
import { openPortal, hasPreview } from './portal.js';

const portalGrid = el('portals');
const list = el('list');
const summary = el('summary');
const stats = el('stats');
const matrix = el('matrix');
const drill = el('drill');
const more = el('more');

let data = { portals: [], apis: [] };
const state = { q: '', browserOnly: false, portal: null, verdict: null };

/**
 * The probe stamp carries an hour now, so an ISO string with an offset is what
 * apis.json holds. Render it in local terms; fall back to the raw value rather
 * than showing "Invalid Date" if the field is ever a bare date again.
 */
function probedAt(raw) {
  const t = new Date(raw);
  if (Number.isNaN(t.getTime())) return raw;
  const date = t.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const time = t.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
  return `${date} ${time}`;
}

/** Three states, not two: usable / blocked / unknown. Conflating the last two lies. */
function verdict(api) {
  if (api.browser) return { cls: 'ok', label: 'דפדפן ✓' };
  if (api.status === 200 && !api.cors) return { cls: 'warn', label: 'שרת בלבד' };
  if (api.status === 403) return { cls: 'bad', label: 'חסום' };
  if (api.endpoint === 'unknown' || api.status === 404) return { cls: 'unknown', label: 'לא אותר' };
  // Reachable and CORS-clean, but the contract itself is unresolved (auth, shape).
  // Its own state - folding it into 'server only' would misreport why it fails.
  return { cls: 'limited', label: 'מוגבל' };
}

/* ---------- top view ---------- */

/**
 * One screen holding every API. The detail list below answers "how do I call
 * this"; this answers "what exists, and which of it can I actually use".
 */

const VERDICTS = [
  { cls: 'ok', label: 'ניתן מהדפדפן', hint: '200 + CORS — קריא מדף סטטי' },
  { cls: 'warn', label: 'שרת בלבד', hint: 'עונה, אך ללא CORS — נדרש proxy' },
  { cls: 'limited', label: 'מוגבל', hint: 'נגיש, אך החוזה לא אומת (auth / מבנה)' },
  { cls: 'bad', label: 'חסום', hint: 'נדחה אקטיבית (403)' },
  { cls: 'unknown', label: 'לא אותר', hint: 'הבדיקות החזירו 404 — לא הופרך' },
];

function renderStats() {
  const counts = data.apis.reduce((acc, a) => {
    acc[verdict(a).cls] = (acc[verdict(a).cls] || 0) + 1;
    return acc;
  }, {});

  const total = `
    <div class="stat">
      <span class="stat-n">${data.apis.length}</span>
      <span class="stat-l">ממשקים ב-${data.portals.length} פורטלים</span>
    </div>`;

  // Each tile doubles as a filter - the count is the question, the list is the answer.
  const tiles = VERDICTS.map((v) => {
    const active = state.verdict === v.cls ? ' active' : '';
    return `
      <button class="stat ${v.cls}${active}" type="button" data-verdict="${v.cls}" title="${esc(v.hint)}">
        <span class="stat-n">${counts[v.cls] || 0}</span>
        <span class="stat-l">${esc(v.label)}</span>
      </button>`;
  }).join('');

  stats.innerHTML = total + tiles;
  stats.querySelectorAll('[data-verdict]').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.verdict = state.verdict === btn.dataset.verdict ? null : btn.dataset.verdict;
      renderStats();
      renderList();
    })
  );
}

function renderMatrix() {
  const head = `
    <thead>
      <tr>
        <th>ממשק</th><th>תחום</th><th>פורמט</th><th>auth</th>
        <th>HTTP</th><th>CORS</th><th>מצב</th>
      </tr>
    </thead>`;

  // Grouped by portal so the table reads as the same hierarchy as the page.
  const body = data.portals.map((p) => {
    const rows = data.apis.filter((a) => a.portal === p.id);
    if (!rows.length) return '';
    return `
      <tbody>
        <tr class="grp">
          <th colspan="7" dir="auto">${esc(p.name_he)} <span class="grp-sub" dir="ltr">${esc(p.name)}</span></th>
        </tr>
        ${rows.map((a) => {
          const v = verdict(a);
          return `
            <tr class="row ${v.cls}" data-id="${esc(a._id)}" tabindex="0" role="button">
              <td dir="auto">${esc(a.name)}</td>
              <td>${esc(a.domain)}</td>
              <td>${esc(a.format)}</td>
              <td>${esc(a.auth)}</td>
              <td>${a.status ?? '—'}</td>
              <td>${a.cors ? esc(a.cors) : '✗'}</td>
              <td><span class="badge ${v.cls}">${esc(v.label)}</span></td>
            </tr>`;
        }).join('')}
      </tbody>`;
  }).join('');

  matrix.innerHTML = head + body;

  const jump = (id) => {
    // A row can point at a card the current filters hide, so clear them first.
    reset();
    const card = list.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.add('flash');
    setTimeout(() => card.classList.remove('flash'), 1200);
  };

  matrix.querySelectorAll('.row').forEach((tr) => {
    tr.addEventListener('click', () => jump(tr.dataset.id));
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); jump(tr.dataset.id); }
    });
  });
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
      ${hasPreview(p.id) ? '<span class="p-open">צפה בנתונים חיים ←</span>' : ''}
    </button>`;
}

function renderPortals() {
  portalGrid.innerHTML = data.portals.map(portalCard).join('');
  portalGrid.querySelectorAll('.portal').forEach((btn) =>
    btn.addEventListener('click', () => {
      // Second click on the same portal clears both the filter and the drill-in.
      const same = state.portal === btn.dataset.portal;
      state.portal = same ? null : btn.dataset.portal;
      renderPortals();
      renderList();

      if (same) {
        drill.innerHTML = '';
        return;
      }
      // The drill-in lives past the mobile "continue" cut - a collapsed
      // <details> hides it regardless of what's written into it, so open
      // it first or the tap looks like it did nothing.
      more.open = true;
      const portal = data.portals.find((p) => p.id === state.portal);
      openPortal(drill, portal);
      drill.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
    <article class="card api ${v.cls}" data-id="${esc(api._id)}">
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
    if (state.verdict && verdict(a).cls !== state.verdict) return false;
    if (state.browserOnly && !a.browser) return false;
    if (!q) return true;
    return [a.name, a.source, a.source_he, a.domain, a.endpoint, a.notes]
      .join(' ').toLowerCase().includes(q);
  });

  const callable = data.apis.filter((a) => a.browser).length;
  const scope = [
    state.portal ? data.portals.find((p) => p.id === state.portal)?.name_he : null,
    state.verdict ? VERDICTS.find((v) => v.cls === state.verdict)?.label : null,
  ].filter(Boolean).join(' · ') || 'הכל';
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
drill.addEventListener('click', (e) => {
  if (!e.target.closest('.drill-close')) return;
  drill.innerHTML = '';
  state.portal = null;
  renderPortals();
  renderList();
});

function reset() {
  state.portal = null; state.q = ''; state.browserOnly = false; state.verdict = null;
  drill.innerHTML = '';
  el('q').value = ''; el('browser-only').checked = false;
  renderStats(); renderPortals(); renderList();
}

el('clear').addEventListener('click', reset);

/**
 * The single-file build (dist/map.html) embeds the map, because a page opened
 * from disk cannot fetch its own apis.json — origin 'null' is refused. Served
 * builds fetch it as normal. Keeping the choice here means the bundler only
 * prepends data and never rewrites control flow.
 */
async function loadData() {
  if (globalThis.__API_DATA__) return globalThis.__API_DATA__;
  const res = await fetch(new URL('../apis.json', import.meta.url));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function load() {
  try {
    data = await loadData();
    // Browser-callable first - that is the decision most visitors are here to make.
    data.apis.sort((a, b) => Number(b.browser) - Number(a.browser) || a.source.localeCompare(b.source));
    // Identity that survives re-sorting and re-filtering, so a matrix row can
    // still find its card. Endpoints repeat across entries; name does not.
    data.apis.forEach((a, i) => { a._id = `${a.portal}-${i}`; });
    el('probed').textContent = `נבדק: ${probedAt(data.probed)}`;
    // The exact recorded value, offset and all, stays reachable on hover.
    el('probed').title = data.probed;
    renderStats();
    renderMatrix();
    renderPortals();
    renderList();
  } catch (err) {
    list.innerHTML = `<div class="notice error">טעינת apis.json נכשלה: ${esc(err.message)}</div>`;
  }
}

load();
