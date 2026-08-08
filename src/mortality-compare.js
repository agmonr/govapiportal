/**
 * Entry point for mortality-compare.html - cause-of-death data at three
 * genuinely different precision levels, kept in three separate sections on
 * purpose rather than merged into one table/map (see mortality-data.js's
 * own header comment and the page's own "מה יש כאן" notice for why):
 *
 *  - CITY: two very different coverage levels sharing one leaderboard UI.
 *    Most metrics (overall/infant mortality, life expectancy, diabetes,
 *    cancer INCIDENCE, socio-economic/peripherality index) come from CBS's
 *    real per-locality "הרשויות המקומיות בישראל" processing file - up to
 *    256 localities, a real parsed spreadsheet (see tools/mortality_build.py).
 *    Two metrics (heart disease and cancer MORTALITY) still come only from
 *    the older "פרופיל בריאותי-חברתי" press release's top-10/bottom-10
 *    extremes (~20 localities each) - that publication was never released
 *    as a fuller file (checked directly, see that script's own docstring).
 *    A choropleth map (this site's usual idiom - see canopy-map.js) was
 *    deliberately NOT used here: boundary geometry doesn't exist for most
 *    of these smaller towns anyway (MAP_CITIES only covers the cities
 *    canopy_build.py/real_estate_build.py needed). A leaderboard naturally
 *    just lists whoever has data for the metric currently picked, the same
 *    reasoning real-estate-compare.js already established for this repo.
 *  - ZONE: district (מחוז)/sub-district (נפה) - some real rates, some
 *    qualitative-rank-only (see ZONE_DISTRICT/ZONE_SUBDISTRICT `rank`-only
 *    entries in mortality-data.js) because the source only ever published
 *    those as a chart, not a table.
 *  - NATIONAL: population-wide, including stroke (מחלות כלי דם במוח) -
 *    the only level where stroke has a real number anywhere.
 *
 * No picker/compare-N-entities UI for zone/national (unlike the city
 * section, or real-estate-compare.js's own city/neighborhood/street
 * pickers) - there are only 6 districts and ~15 sub-districts, so showing
 * all of them at once is simpler and more honest than making the user pick.
 */

import { el, esc, num, param, buildCsv, saveCsv } from './ui.js';
import { initThemePicker } from './theme.js';
import { renderAppContext, loadAppsData } from './apps.js';
import { renderBarChart, renderHBarChart } from './charts.js';
import {
  SOURCES,
  CITY_MORTALITY, CITY_METRIC_META, CITY_CONTEXT_METRIC_META,
  ZONE_DISTRICT, ZONE_SUBDISTRICT, ZONE_META,
  NATIONAL_TOP_CAUSES, NATIONAL_BY_POPULATION_GROUP,
  NATIONAL_INFANT_MORTALITY_BY_SECTOR, NATIONAL_MATERNAL_MORTALITY, NATIONAL_META,
  NATIONAL_MDA_DROWNING, NATIONAL_POLICE_VIOLENCE_BY_DISTRICT, NATIONAL_POLICE_VIOLENCE_META, NATIONAL_POLICE_MURDER,
  NATIONAL_LIFE_EXPECTANCY_BY_RELIGION, NATIONAL_HAREDI_NOTE,
} from './mortality-data.js';

// Looks up a source's URL by its label text (SOURCES is the single place
// that pairs the two - every other `source` string sprinkled through
// CITY_METRIC_META/ZONE_META/NATIONAL_META etc. is one of these same four
// labels verbatim, so a plain map lookup is enough - no per-call-site URL
// duplication).
const SOURCE_URL = new Map(SOURCES.map((s) => [s.label, s.url]));
function sourceLink(label) {
  const url = SOURCE_URL.get(label);
  return url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(label)}</a>` : esc(label);
}

function renderSources() {
  el('sourcesList').innerHTML = `
    <ul>
      ${SOURCES.map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)}</a> - ${esc(s.covers)}</li>`).join('')}
    </ul>`;
}

initThemePicker(el('themePick'));
loadAppsData().then((data) => renderAppContext(el('appContext'), data.apps, 'mortality-compare')).catch(() => {});

const created = new Date(document.lastModified);
if (!Number.isNaN(created.getTime())) {
  el('created').textContent = `נוצר: ${created.toLocaleDateString('he-IL')} ${created.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}`;
  el('created').title = created.toISOString();
}

/* ===================== CITIES ===================== */

// Mortality/health metrics first, then the two context-only ones
// (socioEconomic/peripherality have no `national` average - they're an
// index, not a rate - see CITY_CONTEXT_METRIC_META's own comment).
const ALL_CITY_METRIC_META = { ...CITY_METRIC_META, ...CITY_CONTEXT_METRIC_META };
// "תמותה מ<cause>" reads redundant once the picker/board caption already
// says "תמותה" via context (every metric here already is one) - drop the
// prefix for these 2 cause-specific labels, leaving just the cause itself
// (user request). Metrics that aren't "מ<cause>" shaped (overallMortality/
// infantMortality's own wording, cancerIncidence's own "(לא תמותה)"
// qualifier) are untouched. A UI-layer relabel, not touching
// mortality-data.js (generated straight from the CBS source).
ALL_CITY_METRIC_META.heartDisease = { ...ALL_CITY_METRIC_META.heartDisease, label: 'מחלות לב' };
ALL_CITY_METRIC_META.cancerMortality = { ...ALL_CITY_METRIC_META.cancerMortality, label: 'סרטן' };
const CITY_METRIC_ORDER = [
  'lifeExpectancy', 'overallMortality', 'heartDisease', 'cancerMortality', 'infantMortality',
  'diabetes', 'cancerIncidenceMen', 'cancerIncidenceWomen',
  'socioEconomic', 'peripherality',
];

// socioEconomic/peripherality are a small-magnitude continuous index
// (typically -2..4), not a rate/count - num()'s 0-decimal rounding
// collapsed nearly every row to "0"/"-0". These two decimals keep real
// differences visible without matching the false precision of the raw
// float (12+ digits).
const INDEX_METRICS = new Set(['socioEconomic', 'peripherality']);
const formatIndexValue = (v) => (v == null ? '—' : Number(v).toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

// A label like "היארעות סרטן, גברים (לא תמותה)" reads as one crowded line
// in a picker button, and the "(לא תמותה)"/"(מקרים)" qualifier is easy to
// misread as attached to a neighboring button's "תמותה" - split any
// trailing "(...)" onto its own (smaller, muted) line instead.
function metricButtonLabel(label) {
  const m = label.match(/^(.*?)\s*(\([^)]*\))$/);
  if (!m) return esc(label);
  return `${esc(m[1])}<br><span class="cm-metric-qualifier">${esc(m[2])}</span>`;
}

// socioEconomic/peripherality store their continuous number as `.value`
// (alongside `.cluster`/`.rank`), every mortality/health metric as `.rate`
// (alongside `.ci`/`.low_n`) - `.rate ?? .value` reads whichever this
// metric actually has, so the rest of the UI doesn't need to know which
// of the two metric families it's currently showing.
function cityEntriesFor(metricId) {
  return Object.entries(CITY_MORTALITY)
    .filter(([, v]) => (v[metricId]?.rate ?? v[metricId]?.value) != null)
    .map(([city, v]) => ({ city, ...v[metricId], rate: v[metricId].rate ?? v[metricId].value }));
}

// Both read from and written to the URL (?metric=&city=) so any view is
// linkable/bookmarkable/shareable - see also each city bar's own `href`
// below, and the "מה ייחודי כאן" page notice's general theme of citing
// where a number came from, extended here to where a *view* came from.
let activeCityMetric = CITY_METRIC_ORDER.includes(param('metric')) ? param('metric') : CITY_METRIC_ORDER[0];
let selectedCity = param('city') || null;
// A city linked in from a metric that doesn't cover it would otherwise
// just highlight nothing - jump to the first metric that actually has
// this city instead, so the link always lands somewhere meaningful.
if (selectedCity && !(CITY_MORTALITY[selectedCity]?.[activeCityMetric]?.rate ?? CITY_MORTALITY[selectedCity]?.[activeCityMetric]?.value)) {
  const withData = CITY_METRIC_ORDER.find((id) => (CITY_MORTALITY[selectedCity]?.[id]?.rate ?? CITY_MORTALITY[selectedCity]?.[id]?.value) != null);
  if (withData) activeCityMetric = withData;
}

function updateCityUrl() {
  const url = new URL(location.href);
  url.searchParams.set('metric', activeCityMetric);
  if (selectedCity) url.searchParams.set('city', selectedCity); else url.searchParams.delete('city');
  history.replaceState(null, '', url);
}

function renderCityMetricPicker() {
  const box = el('cityMetricPick');
  box.innerHTML = CITY_METRIC_ORDER.map((id) => `<button type="button" data-metric="${id}" class="tc-level-btn${id === activeCityMetric ? ' active' : ''}">${metricButtonLabel(ALL_CITY_METRIC_META[id].label)}</button>`).join('');
  box.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => { activeCityMetric = btn.dataset.metric; renderCityBoard(); updateCityUrl(); });
  });
}

// City -> its bar element, rebuilt on every render - used both to jump to
// a just-selected city and to scroll to it once on initial load (see boot).
function cityBarEl(city) {
  return document.querySelector(`#cityBoardCharts a[href*="city=${encodeURIComponent(city)}"]`);
}

function selectCity(city) {
  selectedCity = city;
  renderCityBoard();
  updateCityUrl();
  cityBarEl(city)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function renderCityBoard() {
  renderCityMetricPicker();
  const meta = ALL_CITY_METRIC_META[activeCityMetric];
  const entries = cityEntriesFor(activeCityMetric).sort((a, b) => b.rate - a.rate);
  const nationalPart = meta.national != null ? ` ממוצע ארצי: ${num(meta.national)} ${esc(meta.unit)}.` : '';
  el('cityHint').innerHTML = `${entries.length} יישובים עם נתון ל"${esc(meta.label)}" (${esc(meta.period)}) - ${sourceLink(meta.source)}.${nationalPart} ערכים עם רקע קווקוו הם על סמך פחות מ-20 מקרים ולכן פחות יציבים. לחיצה על ישוב מסמנת אותו ומקשרת לתצוגה הזו.`;
  const formatValue = INDEX_METRICS.has(activeCityMetric) ? formatIndexValue : num;
  renderHBarChart('cityBoardCharts', `${meta.label} - כל הערים עם נתון, ${meta.unit}`,
    entries.map((e) => ({
      label: e.city + (e.low_n ? ' *' : ''),
      value: e.rate,
      href: `?${new URLSearchParams({ metric: activeCityMetric, city: e.city })}`,
      color: e.city === selectedCity ? 'var(--danger)' : undefined,
    })),
    meta.unit, { formatValue });

  // Bars are real links (right-click "copy link address" works, middle-
  // click opens in a new tab already pre-selected) - intercepted on plain
  // click to update in place instead of a full page reload.
  document.querySelectorAll('#cityBoardCharts a.acc-hbar-y').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      selectCity(new URL(a.href).searchParams.get('city'));
    });
  });
}

function renderCityRoster() {
  const roster = el('cityRoster');
  roster.innerHTML = Object.keys(CITY_MORTALITY).sort((a, b) => a.localeCompare(b, 'he')).map((c) => `<option value="${esc(c)}">`).join('');
}

el('citySearch').addEventListener('input', function () {
  const city = this.value.trim();
  if (!CITY_MORTALITY[city]) return;
  if (!(CITY_MORTALITY[city][activeCityMetric]?.rate ?? CITY_MORTALITY[city][activeCityMetric]?.value)) {
    const withData = CITY_METRIC_ORDER.find((id) => (CITY_MORTALITY[city][id]?.rate ?? CITY_MORTALITY[city][id]?.value) != null);
    if (withData) activeCityMetric = withData;
  }
  selectCity(city);
});

function cityCsvRows() {
  const rows = [];
  for (const [city, metrics] of Object.entries(CITY_MORTALITY)) {
    for (const metricId of CITY_METRIC_ORDER) {
      const m = metrics[metricId];
      const rate = m?.rate ?? m?.value;
      if (rate == null) continue;
      rows.push({
        city, metric: ALL_CITY_METRIC_META[metricId].label, rate,
        unit: ALL_CITY_METRIC_META[metricId].unit, ci_low: m.ci?.[0] ?? '', ci_high: m.ci?.[1] ?? '',
        low_n: m.low_n ? 'כן' : '', period: ALL_CITY_METRIC_META[metricId].period,
      });
    }
  }
  return rows;
}

el('cityCsv').addEventListener('click', () => {
  const rows = cityCsvRows();
  const csv = buildCsv(['city', 'metric', 'rate', 'unit', 'ci_low', 'ci_high', 'low_n', 'period'], rows);
  saveCsv(csv, 'mortality-cities.csv');
});

/* ===================== ZONE ===================== */

function zoneBadge(entry) {
  if (!entry) return '<span class="badge unknown">אין נתון</span>';
  if (entry.rate != null) {
    const cls = entry.aboveNational || entry.rank === 'highest' ? 'bad' : (entry.rank === 'lowest' ? 'ok' : 'unknown');
    return `<span class="badge ${cls}">${num(entry.rate)}</span>`;
  }
  if (entry.rank) {
    const cls = entry.rank === 'high' || entry.rank === 'highest' ? 'bad' : 'ok';
    const label = { high: 'גבוה יחסית', highest: 'הגבוה ביותר', low: 'נמוך יחסית', lowest: 'הנמוך ביותר' }[entry.rank] || entry.rank;
    return `<span class="badge limited" title="דירוג בלבד, אין שיעור מספרי">${esc(label)}</span>`;
  }
  return '<span class="badge unknown">אין נתון</span>';
}

const ZONE_METRICS = [
  { id: 'lifeExpectancy', label: 'תוחלת חיים' },
  { id: 'overallMortality', label: 'תמותה כללית' },
  { id: 'infantMortality', label: 'תמותת תינוקות' },
  { id: 'cancer', label: 'תמותה מסרטן' },
  { id: 'heartDisease', label: 'תמותה ממחלות לב' },
  { id: 'diabetes', label: 'סוכרת' },
];

function renderZoneTable(containerId, data) {
  const rows = Object.entries(data).map(([name, metrics]) => `
    <tr>
      <td>${esc(name)}</td>
      ${ZONE_METRICS.map((m) => `<td>${zoneBadge(metrics[m.id])}</td>`).join('')}
    </tr>`).join('');
  el(containerId).innerHTML = `
    <div class="matrix-wrap">
      <table class="matrix">
        <thead><tr><th></th>${ZONE_METRICS.map((m) => `<th>${esc(m.label)}</th>`).join('')}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function renderZone() {
  renderZoneTable('zoneDistrictTable', ZONE_DISTRICT);
  renderZoneTable('zoneSubdistrictTable', ZONE_SUBDISTRICT);
  const note = document.createElement('p');
  note.className = 'acc-hint';
  note.dir = 'auto';
  note.innerHTML = `${esc(ZONE_META.note)} מקור: ${sourceLink(ZONE_META.source)}`;
  el('zoneSubdistrictTable').after(note);
}

/* ===================== NATIONAL ===================== */

function renderNationalCauses() {
  const y = 'y2022';
  const withoutTotal = NATIONAL_TOP_CAUSES.filter((c) => c.cause !== 'סך הכל' && c.cause !== 'כל שאר המחלות');
  renderBarChart('natCausesChart', `סיבות מוות מובילות, 2022 (% מכלל הפטירות)`,
    withoutTotal.map((c) => ({ label: c.cause, value: c[y].pct })), '%');

  const rows = NATIONAL_TOP_CAUSES.map((c) => `
    <tr${c.cause === 'סך הכל' ? ' style="font-weight:700"' : ''}>
      <td>${esc(c.cause)}</td>
      <td>${num(c.y2022.n)} (${c.y2022.pct}%)</td>
      <td>${num(c.y2021.n)} (${c.y2021.pct}%)</td>
      <td>${num(c.y2020.n)} (${c.y2020.pct}%)</td>
    </tr>`).join('');
  el('natCausesTable').innerHTML = `
    <div class="matrix-wrap">
      <table class="matrix">
        <thead><tr><th>סיבת מוות</th><th>2022</th><th>2021</th><th>2020</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="acc-hint" dir="auto">מקור: ${sourceLink(NATIONAL_META.causesSource)}. שבץ מוחי (מחלות כלי דם במוח) הוא הרמה היחידה בדף הזה שבה יש לו מספר אמיתי.</p>`;
}

function renderNationalPopGroup() {
  const le = NATIONAL_BY_POPULATION_GROUP.lifeExpectancy;
  el('natPopGroupTable').innerHTML = `
    <div class="matrix-wrap">
      <table class="matrix">
        <thead><tr><th>תוחלת חיים (${esc(le.period)})</th><th>סה״כ</th><th>גברים</th><th>נשים</th></tr></thead>
        <tbody>
          <tr><td>יהודים ואחרים</td><td>${le.jewish.total}</td><td>${le.jewish.men}</td><td>${le.jewish.women}</td></tr>
          <tr><td>ערבים</td><td>${le.arab.total}</td><td>${le.arab.men}</td><td>${le.arab.women}</td></tr>
        </tbody>
      </table>
    </div>`;

  const list = (title, items) => `
    <div style="flex:1 1 16rem">
      <h4>${esc(title)}</h4>
      <ul>${items.map((i) => `<li>${esc(i.cause)} - פי ${i.multiplier}</li>`).join('')}</ul>
    </div>`;
  el('natRatiosLists').innerHTML = `
    <p class="acc-hint" dir="auto">שיעורי תמותה מתוקננים לגיל, ${esc(NATIONAL_BY_POPULATION_GROUP.period)}. מקור: ${sourceLink(NATIONAL_BY_POPULATION_GROUP.source)}.</p>
    <div style="display:flex; gap:2rem; flex-wrap:wrap">
      ${list('גבוה יותר בקרב ערבים', NATIONAL_BY_POPULATION_GROUP.higherAmongArabs)}
      ${list('גבוה יותר בקרב יהודים', NATIONAL_BY_POPULATION_GROUP.higherAmongJews)}
    </div>`;
}

function renderNationalReligion() {
  const d = NATIONAL_LIFE_EXPECTANCY_BY_RELIGION;
  const entries = [];
  for (const g of d.groups) {
    entries.push({ label: `${g.label} - גברים`, value: g.men });
    entries.push({ label: `${g.label} - נשים`, value: g.women });
  }
  renderHBarChart('natReligionChart', `תוחלת חיים לפי דת, ${d.period}`, entries, 'שנים');
  el('natReligionNote').innerHTML = `פילוח שונה מ"יהודים מול ערבים" למעלה - כאן ערבים מפוצלים למוסלמים/דרוזים/נוצרים. מקור: ${sourceLink(d.source)}`;
}

function renderNationalHaredi() {
  const h = NATIONAL_HAREDI_NOTE;
  const cityRows = h.cities.map((city) => {
    const v = CITY_MORTALITY[city];
    const le = v?.lifeExpectancy?.rate;
    const se = v?.socioEconomic;
    const parts = [];
    if (le != null) parts.push(`תוחלת חיים ${le}`);
    if (se) parts.push(`אשכול חברתי-כלכלי ${se.cluster}/10`);
    return `<li><strong>${esc(city)}</strong>${parts.length ? ' - ' + esc(parts.join(', ')) : ''}</li>`;
  }).join('');
  el('natHaredi').innerHTML = `
    <p>${esc(h.note)}</p>
    <ul>${cityRows}</ul>
    <p class="acc-hint" dir="auto">נתוני תוחלת חיים ומדד חברתי-כלכלי לכל עיר - ראו את אותן ערים בלוח "ערים" למעלה. מקור: ${sourceLink(h.source)}</p>`;
}

function renderNationalInfantSector() {
  const d = NATIONAL_INFANT_MORTALITY_BY_SECTOR;
  renderBarChart('natInfantSectorChart', `תמותת תינוקות לפי מגזר, ${d.unit}`, [
    { label: 'יהודים', value: d.jewish },
    { label: 'ערבים', value: d.arab },
    { label: 'בדואים בנגב', value: d.bedouinNegev },
  ], d.unit);
  const note = document.createElement('p');
  note.className = 'acc-hint';
  note.dir = 'auto';
  note.innerHTML = `מקור: ${sourceLink(d.source)}`;
  el('natInfantSectorChart').after(note);
}

function renderNationalMaternal() {
  const m = NATIONAL_MATERNAL_MORTALITY;
  el('natMaternal').innerHTML = `
    <p><strong>${m.ratePer100k} ל-100,000 לידות</strong> - כ-${m.deathsPerYear} מקרי מוות בשנה בכלל הארץ.</p>
    <p>${esc(m.note)}</p>
    <p class="acc-hint" dir="auto">מקור: ${sourceLink(m.source)}</p>`;
}

function renderMdaDrowning() {
  const d = NATIONAL_MDA_DROWNING;
  // treatedByWaterBody2024 is the 366-treated count split by water body -
  // NOT a deaths breakdown (MDA never published one) - the chart title
  // says "טופלו" (treated), not "הרוגי" (deaths), to keep that distinction
  // visible on the chart itself, not just in the note below it.
  const byWater = Object.entries(d.treatedByWaterBody2024).map(([label, value]) => ({ label, value }));
  renderBarChart('mdaDrowningChart', 'מקרי טביעה שטופלו, 2024 - לפי סוג גוף מים', byWater, 'מקרים');
  el('mdaDrowningNote').innerHTML =
    `סה״כ <strong>הרוגי טביעה (ארצי)</strong>: ${d.y2023.deaths} ב-2023 (מתוך ${d.y2023.treated} שטופלו), ${d.y2024.deaths} ב-2024 (מתוך ${d.y2024.treated} שטופלו). התרשים למעלה הוא פילוח כלל הנטפלים (לא רק הרוגים) לפי סוג גוף מים - מד"א לא פרסם פילוח הרוגים בלבד. ` +
    `${esc(d.note)} מקור: ${sourceLink(d.source)}`;
}

function renderPoliceViolence() {
  const entries = Object.entries(NATIONAL_POLICE_VIOLENCE_BY_DISTRICT)
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);
  renderHBarChart('policeViolenceChart', `קורבנות אלימות חמורה, ${NATIONAL_POLICE_VIOLENCE_META.period}`, entries, 'קורבנות');
  el('policeViolenceNote').innerHTML = `${esc(NATIONAL_POLICE_VIOLENCE_META.note)} מקור: ${sourceLink(NATIONAL_POLICE_VIOLENCE_META.source)}`;

  const p = NATIONAL_POLICE_MURDER;
  el('policeMurderNote').innerHTML =
    `<p><strong>${num(p.total)} נרצחו בישראל, ${esc(p.period)}</strong> - ${esc(p.note)}</p>
     <p class="acc-hint" dir="auto">מקור: ${sourceLink(p.source)}</p>`;
}

/* ===================== boot ===================== */

renderSources();
renderCityRoster();
renderCityBoard();
updateCityUrl();
// Deep link (?metric=&city=) lands straight on the right row, no
// animation on first paint (unlike selectCity()'s own smooth scroll for
// a live click) - the page hasn't settled yet, so this jumps instantly.
if (selectedCity) cityBarEl(selectedCity)?.scrollIntoView({ block: 'center' });
renderZone();
renderNationalCauses();
renderNationalPopGroup();
renderNationalReligion();
renderNationalHaredi();
renderNationalInfantSector();
renderNationalMaternal();
renderMdaDrowning();
renderPoliceViolence();
