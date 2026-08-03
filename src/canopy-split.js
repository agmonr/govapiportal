/**
 * Entry point for canopy-split.html - עצים: ציבורי מול פרטי.
 *
 * Not a new data source - tree-canopy.html's own city/neighborhood totals
 * (see tools/canopy_build.py) already sum ALL canopy in the area, private
 * gardens included. This page just splits that total in two: how much of it
 * sits inside a street's 7.5m public-road buffer ("public", already computed
 * per-street on tree-canopy.html) versus everywhere else ("private" - by
 * subtraction). See tools/canopy_split_build.py for the aggregation.
 *
 * Only two levels here, not three: a street IS the public strip by
 * definition, so a public/private split at street level would trivially
 * read ~100%/0% - not a useful comparison.
 */

import { el, esc, num, debounce, buildCsv, saveCsv } from './ui.js';
import { initThemePicker } from './theme.js';
import { renderHBarChart, citySwatchCell } from './charts.js';
import { CITY_CANOPY_SPLIT } from './canopy-split-cities.js';
import { NEIGHBORHOOD_CANOPY_SPLIT } from './canopy-split-neighborhoods.js';
import { renderAppContext, loadAppsData } from './apps.js';

initThemePicker(el('themePick'));
loadAppsData().then((data) => renderAppContext(el('appContext'), data.apps, 'canopy-split')).catch(() => {});

const created = new Date(document.lastModified);
if (!Number.isNaN(created.getTime())) {
  el('created').textContent = `נוצר: ${created.toLocaleDateString('he-IL')} ${created.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}`;
  el('created').title = created.toISOString();
}

/* ---------- levels: one shape, two sources ---------- */

const LEVELS = {
  city: {
    label: 'עיר', labelPlural: 'ערים', pickLabel: 'עיר:',
    boardTitle: 'ערים מובילות', rankedWord: 'מדורגות',
    entries: () => Object.entries(CITY_CANOPY_SPLIT).map(([name, v]) => ({
      key: name, label: name, name, city: name,
      totalPct: v.totalPct, publicPct: v.publicPct, privatePct: v.privatePct,
      areaM2: v.areaM2, totalM2: v.totalM2, publicM2: v.publicM2, privateM2: v.privateM2,
    })),
  },
  neighborhood: {
    label: 'שכונה', labelPlural: 'שכונות', pickLabel: 'שכונה:',
    boardTitle: 'שכונות מובילות', rankedWord: 'מדורגות',
    entries: () => Object.entries(NEIGHBORHOOD_CANOPY_SPLIT).map(([key, v]) => {
      const [city, name] = key.split('::');
      return {
        key, label: `${name} (${city === '—' ? 'ללא עיר מזוהה' : city})`, name, city,
        totalPct: v.totalPct, publicPct: v.publicPct, privatePct: v.privatePct,
        areaM2: v.areaM2, totalM2: v.totalM2, publicM2: v.publicM2, privateM2: v.privateM2,
        approx: v.approx, publicUnknown: v.publicUnknown,
      };
    }),
  },
};

const entriesCache = {};
const labelMapCache = {};
function levelEntries(level) {
  if (!entriesCache[level]) entriesCache[level] = LEVELS[level].entries();
  return entriesCache[level];
}
function labelMap(level) {
  if (!labelMapCache[level]) {
    const map = new Map();
    for (const e of levelEntries(level)) map.set(e.label, e);
    labelMapCache[level] = map;
  }
  return labelMapCache[level];
}

// Same rule tree-canopy.js uses: a zero is a data gap unless it's a
// neighborhood whose own city clearly has canopy somewhere (the survey
// reached that city - a zero sub-area of it is real, not a gap).
function isCredible(level, e) {
  if (e.totalM2 > 0) return true;
  return level === 'neighborhood' && Boolean(CITY_CANOPY_SPLIT[e.city]?.totalM2 > 0);
}

const PICK_COLORS = [
  'var(--accent)',
  'color-mix(in srgb, var(--accent) 70%, var(--bg) 30%)',
  'color-mix(in srgb, var(--accent) 45%, var(--bg) 55%)',
  'color-mix(in srgb, var(--accent) 22%, var(--bg) 78%)',
];
const MAX_PICKS = 4;

/* ---------- state + URL ---------- */

const state = { level: 'city', picks: [null, null, null, null], cityFilter: null };

function readStateFromUrl() {
  const p = new URLSearchParams(location.search);
  if (LEVELS[p.get('level')]) state.level = p.get('level');
  for (let i = 0; i < MAX_PICKS; i += 1) {
    const v = p.get(`p${i + 1}`);
    if (v) state.picks[i] = v;
  }
  if (p.get('city')) state.cityFilter = p.get('city');
}

function syncUrl() {
  const p = new URLSearchParams();
  p.set('level', state.level);
  state.picks.forEach((v, i) => { if (v) p.set(`p${i + 1}`, v); });
  if (state.cityFilter) p.set('city', state.cityFilter);
  history.replaceState(null, '', `?${p}`);
}

/* ---------- roster (datalist) ---------- */

function candidateEntries(query) {
  let candidates = levelEntries(state.level).filter((e) => isCredible(state.level, e));
  if (state.cityFilter) candidates = candidates.filter((e) => e.city === state.cityFilter);
  const q = query.trim().toLowerCase();
  if (!q) return candidates;
  const nameHits = [];
  const otherHits = [];
  for (const e of candidates) {
    if (e.name.toLowerCase().includes(q)) nameHits.push(e);
    else if (e.label.toLowerCase().includes(q)) otherHits.push(e);
  }
  return [...nameHits, ...otherHits];
}

function updateRosterOptions(query) {
  const top = candidateEntries(query).slice(0, 40);
  el('csRoster').innerHTML = top.map((e) => `<option value="${esc(e.label)}">`).join('');
}

function updateRosterHint() {
  const lvl = LEVELS[state.level];
  const all = levelEntries(state.level);
  const withTrees = all.filter((e) => isCredible(state.level, e));
  const excludedNote = all.length > withTrees.length
    ? ` (${num(all.length - withTrees.length)} ללא חופה שזוהתה כלל אינן ברשימה)` : '';
  if (state.cityFilter) {
    const scoped = withTrees.filter((e) => e.city === state.cityFilter).length;
    el('csRosterHint').innerHTML = `מסונן ל<strong dir="auto">${esc(state.cityFilter)}</strong> `
      + `(${num(scoped)} מתוך ${num(withTrees.length)})${esc(excludedNote)} — <button type="button" id="csClearFilter" class="ck-crumb">נקה סינון</button>`;
    el('csClearFilter').addEventListener('click', () => {
      state.cityFilter = null; syncUrl(); renderAll();
    });
  } else {
    el('csRosterHint').textContent = `${num(withTrees.length)} ${lvl.labelPlural} סה״כ${excludedNote}`;
  }
}

/* ---------- comparison ---------- */

function noteBadges(e) {
  const notes = [];
  if (e.approx) notes.push('שכונה משוערת');
  if (e.publicUnknown) notes.push('אין רחוב מיוחס - חלק הציבורי לא ידוע כאן');
  return notes.length ? ` <span class="acc-hint">(${notes.join(', ')})</span>` : '';
}

function renderCompareTable(entries) {
  const rows = entries.map((e, i) => `
    <tr class="has-files" data-row="${i}" tabindex="0" role="button">
      <td class="c-x"><span class="x-mark">▾</span></td>
      ${citySwatchCell(e.label, PICK_COLORS[i])}
      <td>${e.totalPct.toFixed(2)}%</td>
      <td>${e.privatePct.toFixed(2)}%</td>
      <td>${e.publicPct.toFixed(2)}%${noteBadges(e)}</td>
    </tr>
    <tr class="files-row" data-files="${i}" hidden>
      <td colspan="5">
        <dl class="ck-facts" dir="auto">
          <dt>שטח (דונם)</dt><dd>${num(Math.round(e.areaM2 / 1000))}</dd>
          <dt>שטח חופה כולל (מ״ר)</dt><dd>${num(Math.round(e.totalM2))}</dd>
          <dt>מתוכו פרטי (מ״ר)</dt><dd>${num(Math.round(e.privateM2))}</dd>
          <dt>מתוכו ציבורי - רצועת רחוב (מ״ר)</dt><dd>${num(Math.round(e.publicM2))}</dd>
        </dl>
      </td>
    </tr>`).join('');
  el('csTable').innerHTML = `
    <div class="matrix-wrap">
      <table class="matrix preview expandable">
        <thead><tr>
          <th class="c-x"></th>
          <th scope="col">${esc(LEVELS[state.level].label)}</th>
          <th scope="col">כיסוי כולל (%)</th>
          <th scope="col">פרטי (%)</th>
          <th scope="col">ציבורי (%)</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  el('csTable').querySelectorAll('tr.has-files').forEach((tr) => {
    const toggle = () => {
      const target = el('csTable').querySelector(`tr[data-files="${tr.dataset.row}"]`);
      if (!target) return;
      target.hidden = !target.hidden;
      const mark = tr.querySelector('.x-mark');
      if (mark) mark.textContent = target.hidden ? '▾' : '▴';
    };
    tr.addEventListener('click', toggle);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  });
}

function renderDrill(entries) {
  const section = el('csDrillSection');
  if (state.level !== 'city' || !entries.length) { section.hidden = true; return; }
  section.hidden = false;
  el('csDrillBtns').innerHTML = entries.map((e, i) => `
    <span class="tc-drill-group">
      <span class="acc-legend-swatch" style="background:${PICK_COLORS[i]}"></span>
      <button type="button" data-idx="${i}">שכונות של <span dir="auto">${esc(e.label)}</span> ←</button>
    </span>`).join('');
  el('csDrillBtns').querySelectorAll('button[data-idx]').forEach((btn) => {
    const e = entries[Number(btn.dataset.idx)];
    btn.addEventListener('click', () => drillInto(e.label));
  });
}

function drillInto(cityName) {
  state.level = 'neighborhood';
  state.cityFilter = cityName;
  const top = levelEntries('neighborhood').filter((e) => e.city === cityName).sort((x, y) => y.privatePct - x.privatePct);
  state.picks = [top[0]?.label || null, top[1]?.label || null, null, null];
  syncUrl();
  renderAll();
}

const TOP_NEIGHBORHOODS_N = 20;

function renderTopNeighborhoods(entries) {
  const section = el('csTopNeighborhoodsSection');
  if (state.level !== 'city' || entries.length !== 1) { section.hidden = true; return; }
  const cityName = entries[0].label;
  const items = levelEntries('neighborhood').filter((e) => e.city === cityName && isCredible('neighborhood', e));
  if (!items.length) { section.hidden = true; return; }
  section.hidden = false;
  el('csTopNeighborhoodsCity').textContent = cityName;
  const top = [...items].sort((a, b) => b.privatePct - a.privatePct).slice(0, TOP_NEIGHBORHOODS_N);
  const chartEntries = top.map((e) => ({ label: e.name, value: Number(e.privatePct.toFixed(1)) }));
  renderHBarChart('csTopNeighborhoodsChart', `${num(top.length)} שכונות מובילות בכיסוי פרטי${top.length < items.length ? ` (מתוך ${num(items.length)})` : ''}`, chartEntries, '%');
}

function renderCompare() {
  const lvl = LEVELS[state.level];
  const map = labelMap(state.level);
  const resolved = state.picks.map((label) => (label ? map.get(label) : null));
  const entries = resolved.filter(Boolean);

  const warn = el('csWarn');
  const missing = state.picks.filter((label, i) => label && !resolved[i]);
  warn.hidden = !missing.length;
  if (missing.length) warn.textContent = `לא נמצא/ו: ${missing.join(', ')} ב${lvl.labelPlural}.`;

  const section = el('csCompareSection');
  if (!entries.length) {
    section.hidden = true;
    renderDrill([]);
    el('csTopNeighborhoodsSection').hidden = true;
    return;
  }
  section.hidden = false;

  const chartEntries = entries.map((e, i) => ({ label: e.label, value: Number(e.privatePct.toFixed(1)), color: PICK_COLORS[i] }));
  renderHBarChart('csChart', `אחוז כיסוי פרטי (גינות וחצרות)${entries.length > 1 ? ' — השוואה' : ''}`, chartEntries, '%');
  renderCompareTable(entries);
  renderDrill(entries);
  renderTopNeighborhoods(entries);
}

/* ---------- leaderboard ---------- */

const BOARD_CHUNK = 300;
let boardRenderGen = 0;

function renderBoardChart(figId, caption, entries, unit) {
  const myGen = (boardRenderGen += 1);
  const fig = el(figId);
  if (!entries.length) { fig.innerHTML = `<figcaption>${esc(caption)}</figcaption><p class="acc-hint">אין נתונים להצגה.</p>`; return; }

  const peak = Math.max(...entries.map((e) => e.value));
  const rowHtml = (e) => `
    <div class="acc-hbar" title="${esc(e.label)}: ${num(e.value)} ${esc(unit)}">
      <span class="acc-hbar-y" dir="auto">${esc(e.label)}</span>
      <div class="acc-hbar-track"><div class="acc-hbar-fill" style="inline-size:${peak ? (e.value / peak) * 100 : 0}%"></div></div>
      <span class="acc-hbar-v">${num(e.value)}</span>
    </div>`;

  fig.innerHTML = `<figcaption>${esc(caption)}</figcaption><div class="acc-hbars"></div>`;
  const body = fig.querySelector('.acc-hbars');
  let i = 0;
  function appendChunk() {
    if (myGen !== boardRenderGen) return;
    const end = Math.min(i + BOARD_CHUNK, entries.length);
    const wrap = document.createElement('div');
    wrap.innerHTML = entries.slice(i, end).map(rowHtml).join('');
    const frag = document.createDocumentFragment();
    while (wrap.firstChild) frag.appendChild(wrap.firstChild);
    body.appendChild(frag);
    i = end;
    if (i < entries.length) requestAnimationFrame(appendChunk);
  }
  appendChunk();
}

function renderBoard() {
  const lvl = LEVELS[state.level];
  el('csBoardLevel').textContent = lvl.boardTitle;
  let entries = levelEntries(state.level);
  const scopeNote = [];
  if (state.cityFilter) {
    entries = entries.filter((e) => e.city === state.cityFilter);
    scopeNote.push(`מוצג בתוך ${state.cityFilter} בלבד`);
  }
  const withTrees = entries.filter((e) => isCredible(state.level, e));
  scopeNote.push(`${num(entries.length - withTrees.length)} מתוך ${num(entries.length)} ללא חופה שזוהתה כלל - לא נכללות`);
  el('csBoardHint').textContent = scopeNote.join(' · ');

  const BOARD_CAP = 100;
  const sorted = [...withTrees].sort((x, y) => y.privatePct - x.privatePct);
  const capped = state.level === 'city' ? sorted : sorted.slice(0, BOARD_CAP);
  const ranked = capped.map((e) => ({ label: e.label, value: Number(e.privatePct.toFixed(1)) }));
  const capNote = capped.length < sorted.length ? ` (${num(BOARD_CAP)} מתוך ${num(sorted.length)})` : '';
  renderBoardChart('csBoardChart', `${num(ranked.length)} ${lvl.labelPlural} ${lvl.rankedWord} לפי אחוז כיסוי פרטי${capNote}`, ranked, '%');
}

/* ---------- CSV ---------- */

el('csCsv').addEventListener('click', () => {
  const lvl = LEVELS[state.level];
  let entries = levelEntries(state.level);
  if (state.cityFilter) entries = entries.filter((e) => e.city === state.cityFilter);
  const fields = [lvl.label, 'עיר', 'כיסוי_כולל_אחוז', 'כיסוי_פרטי_אחוז', 'כיסוי_ציבורי_אחוז', 'שטח_דונם', 'שטח_חופה_כולל_מר', 'שטח_חופה_פרטי_מר', 'שטח_חופה_ציבורי_מר'];
  const records = entries.map((e) => ({
    [lvl.label]: e.label, עיר: e.city || '',
    כיסוי_כולל_אחוז: e.totalPct, כיסוי_פרטי_אחוז: e.privatePct, כיסוי_ציבורי_אחוז: e.publicPct,
    שטח_דונם: Math.round(e.areaM2 / 1000), שטח_חופה_כולל_מר: Math.round(e.totalM2),
    שטח_חופה_פרטי_מר: Math.round(e.privateM2), שטח_חופה_ציבורי_מר: Math.round(e.publicM2),
  }));
  const name = `כיסוי_חופות_ציבורי_פרטי_${lvl.labelPlural}${state.cityFilter ? `_${state.cityFilter}` : ''}`
    .replace(/[\\/:*?"<>|]/g, '_');
  saveCsv(buildCsv(fields, records), `${name}.csv`);
});

/* ---------- share ---------- */

el('csShare').addEventListener('click', () => {
  const map = labelMap(state.level);
  const entries = state.picks.map((label) => (label ? map.get(label) : null)).filter(Boolean);
  const lines = entries.map((e) => `${e.label}: ${e.totalPct.toFixed(1)}% כיסוי כולל (${e.privatePct.toFixed(1)}% פרטי, ${e.publicPct.toFixed(1)}% ציבורי)`);
  const text = `עצים: ציבורי מול פרטי 🌳\n${lines.join('\n')}\n${location.href}`;
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
});

/* ---------- wiring ---------- */

const pickInputs = Array.from({ length: MAX_PICKS }, (_, i) => el(`csPick${i}`));
const PICK_LABELS = ['', ' 2', ' 3', ' 4'];

function renderAll() {
  for (const btn of document.querySelectorAll('.cs-level-btn')) {
    btn.classList.toggle('active', btn.dataset.level === state.level);
  }
  const lvl = LEVELS[state.level];
  pickInputs.forEach((input, i) => {
    el(`csPickLabel${i}`).textContent = i === 0 ? lvl.pickLabel : `השוואה${PICK_LABELS[i]} (אופציונלי):`;
    input.value = state.picks[i] || '';
  });
  updateRosterOptions('');
  updateRosterHint();
  renderCompare();
  renderBoard();
}

document.querySelectorAll('.cs-level-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (state.level === btn.dataset.level) return;
    state.level = btn.dataset.level;
    state.picks = [null, null, null, null];
    state.cityFilter = null;
    syncUrl();
    renderAll();
  });
});

const pickConfirmTimers = [];
function showPickConfirm(i, ok) {
  const confirmEl = el(`csPickConfirm${i}`);
  clearTimeout(pickConfirmTimers[i]);
  confirmEl.classList.remove('tc-pick-confirm-show');
  if (!ok) return;
  confirmEl.textContent = '✓ נטען';
  void confirmEl.offsetWidth;
  confirmEl.classList.add('tc-pick-confirm-show');
  pickConfirmTimers[i] = setTimeout(() => confirmEl.classList.remove('tc-pick-confirm-show'), 1500);
}

pickInputs.forEach((input, i) => {
  input.addEventListener('input', debounce(() => updateRosterOptions(input.value), 120));
  const commit = () => {
    state.picks[i] = input.value.trim() || null;
    syncUrl();
    renderCompare();
    showPickConfirm(i, Boolean(state.picks[i] && labelMap(state.level).has(state.picks[i])));
  };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
});

readStateFromUrl();
renderAll();
