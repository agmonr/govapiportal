/**
 * Entry point for mortality-compare.html - cause-of-death data at three
 * genuinely different precision levels, kept in three separate sections on
 * purpose rather than merged into one table/map (see mortality-data.js's
 * own header comment and the page's own "מה יש כאן" notice for why):
 *
 *  - CITY: real per-locality figures, but only for the 65 localities CBS
 *    itself named as a top-10/bottom-10 extreme in "פרופיל בריאותי-חברתי
 *    של היישובים בישראל, 2011-2017" - not a national roster. A choropleth
 *    map (this site's usual idiom - see canopy-map.js) was deliberately
 *    NOT used here: with only 65 of ~200 localities having any figure at
 *    all, a map would be mostly empty/gray, and boundary geometry doesn't
 *    exist for most of these small towns anyway (MAP_CITIES only covers
 *    the cities canopy_build.py/real_estate_build.py needed). A leaderboard
 *    naturally just lists whoever has data, the same reasoning
 *    real-estate-compare.js already established for this repo.
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

import { el, esc, num, buildCsv, saveCsv } from './ui.js';
import { initThemePicker } from './theme.js';
import { renderAppContext, loadAppsData } from './apps.js';
import { renderBarChart, renderHBarChart } from './charts.js';
import {
  CITY_MORTALITY, CITY_METRIC_META,
  ZONE_DISTRICT, ZONE_SUBDISTRICT, ZONE_META,
  NATIONAL_TOP_CAUSES, NATIONAL_BY_POPULATION_GROUP,
  NATIONAL_INFANT_MORTALITY_BY_SECTOR, NATIONAL_MATERNAL_MORTALITY,
} from './mortality-data.js';

initThemePicker(el('themePick'));
loadAppsData().then((data) => renderAppContext(el('appContext'), data.apps, 'mortality-compare')).catch(() => {});

const created = new Date(document.lastModified);
if (!Number.isNaN(created.getTime())) {
  el('created').textContent = `נוצר: ${created.toLocaleDateString('he-IL')} ${created.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}`;
  el('created').title = created.toISOString();
}

/* ===================== CITIES ===================== */

const CITY_METRIC_ORDER = ['overallMortality', 'heartDisease', 'cancer', 'infantMortality', 'diabetes'];

function cityEntriesFor(metricId) {
  return Object.entries(CITY_MORTALITY)
    .filter(([, v]) => v[metricId]?.rate != null)
    .map(([city, v]) => ({ city, ...v[metricId] }));
}

let activeCityMetric = CITY_METRIC_ORDER[0];

function renderCityMetricPicker() {
  const box = el('cityMetricPick');
  box.innerHTML = CITY_METRIC_ORDER.map((id) => `<button type="button" data-metric="${id}" class="tc-level-btn${id === activeCityMetric ? ' active' : ''}">${esc(CITY_METRIC_META[id].label)}</button>`).join('');
  box.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => { activeCityMetric = btn.dataset.metric; renderCityBoard(); });
  });
}

function renderCityBoard() {
  renderCityMetricPicker();
  const meta = CITY_METRIC_META[activeCityMetric];
  const entries = cityEntriesFor(activeCityMetric).sort((a, b) => b.rate - a.rate);
  el('cityHint').textContent = `${entries.length} יישובים עם נתון ל"${meta.label}" (${meta.period}) - ${meta.source}. ממוצע ארצי: ${num(meta.national)} ${meta.unit}. ערכים עם רקע קווקוו הם על סמך פחות מ-20 מקרים ולכן פחות יציבים.`;
  renderHBarChart('cityBoardCharts', `${meta.label} - כל הערים עם נתון, ${meta.unit}`,
    entries.map((e) => ({ label: e.city + (e.low_n ? ' *' : ''), value: e.rate })),
    meta.unit);
}

function renderCityRoster() {
  const roster = el('cityRoster');
  roster.innerHTML = Object.keys(CITY_MORTALITY).sort((a, b) => a.localeCompare(b, 'he')).map((c) => `<option value="${esc(c)}">`).join('');
}

el('citySearch').addEventListener('input', function () {
  const city = this.value.trim();
  if (!CITY_MORTALITY[city]) return;
  // title is "<city>[ *]: <value> <unit>" (the " *" low_n suffix, if any,
  // sits before the colon) - substring match tolerates that either way.
  const match = document.querySelector(`#cityBoardCharts [title*="${CSS.escape(city)}"]`);
  if (match) match.scrollIntoView({ behavior: 'smooth', block: 'center' });
});

function cityCsvRows() {
  const rows = [];
  for (const [city, metrics] of Object.entries(CITY_MORTALITY)) {
    for (const metricId of CITY_METRIC_ORDER) {
      const m = metrics[metricId];
      if (m?.rate == null) continue;
      rows.push({
        city, metric: CITY_METRIC_META[metricId].label, rate: m.rate,
        unit: CITY_METRIC_META[metricId].unit, ci_low: m.ci?.[0] ?? '', ci_high: m.ci?.[1] ?? '',
        low_n: m.low_n ? 'כן' : '', period: CITY_METRIC_META[metricId].period,
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
  note.textContent = ZONE_META.note + ' מקור: ' + ZONE_META.source;
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
    <p class="acc-hint" dir="auto">מקור: ${esc(NATIONAL_TOP_CAUSES.length ? 'CBS 125/2024, סיבות מוות בישראל 2020-2022' : '')}. שבץ מוחי (מחלות כלי דם במוח) הוא הרמה היחידה בדף הזה שבה יש לו מספר אמיתי.</p>`;
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
    <p class="acc-hint" dir="auto">שיעורי תמותה מתוקננים לגיל, ${esc(NATIONAL_BY_POPULATION_GROUP.period)}. מקור: ${esc(NATIONAL_BY_POPULATION_GROUP.source)}.</p>
    <div style="display:flex; gap:2rem; flex-wrap:wrap">
      ${list('גבוה יותר בקרב ערבים', NATIONAL_BY_POPULATION_GROUP.higherAmongArabs)}
      ${list('גבוה יותר בקרב יהודים', NATIONAL_BY_POPULATION_GROUP.higherAmongJews)}
    </div>`;
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
  note.textContent = `מקור: ${d.source}`;
  el('natInfantSectorChart').after(note);
}

function renderNationalMaternal() {
  const m = NATIONAL_MATERNAL_MORTALITY;
  el('natMaternal').innerHTML = `
    <p><strong>${m.ratePer100k} ל-100,000 לידות</strong> - כ-${m.deathsPerYear} מקרי מוות בשנה בכלל הארץ.</p>
    <p>${esc(m.note)}</p>
    <p class="acc-hint" dir="auto">מקור: ${esc(m.source)}</p>`;
}

/* ===================== boot ===================== */

renderCityRoster();
renderCityBoard();
renderZone();
renderNationalCauses();
renderNationalPopGroup();
renderNationalInfantSector();
renderNationalMaternal();
