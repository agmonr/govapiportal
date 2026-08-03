/**
 * Shared per-plan/per-plan-list HTML renderers, used by both
 * plan-timeline.js (per-city drill-down) and plan-compare.js (per-picked-
 * city drill-down) - split out once the same table/timeline markup was
 * needed in both places, rather than duplicating it (see charts.js's own
 * docstring for the same reasoning applied to chart renderers).
 */

import { esc, num } from './ui.js';
import { planTimeline } from './plan-data.js';

const fmtDate = (d) => (d ? d.toLocaleDateString('he-IL') : '—');

/** Current-status badge for one plan: {cls, text} - `cls` matches the
 *  site-wide .badge.ok/warn/bad/limited/unknown vocabulary (see style.css). */
export function statusBadge(plan, totalDays) {
  if (plan.station_desc === 'אישור') {
    return totalDays != null
      ? { cls: 'ok', text: `אושרה — ${totalDays.toLocaleString('he-IL')} ימים` }
      : { cls: 'limited', text: 'אושרה (חסרים תאריכים)' };
  }
  const rejecting = plan.station_desc === 'התכנית נדחתה' || plan.internet_short_status === 'התכנית נדחתה';
  if (rejecting) return { cls: 'bad', text: 'נדחתה' };
  return { cls: 'warn', text: plan.internet_short_status || plan.station_desc || 'לא ידוע' };
}

/** The deepest drill-down: one plan's own step-by-step milestone timeline. */
export function renderPlanTimelineHtml(plan) {
  const { steps } = planTimeline(plan);
  if (!steps.length) return '<p class="acc-hint">אין אף תאריך ציר-זמן רשום לתכנית זו.</p>';
  const rows = steps.map((s) => `
    <tr>
      <td>${esc(s.label)}</td>
      <td>${fmtDate(s.date)}</td>
      <td>${s.daysSincePrev == null ? '—' : `${s.daysSincePrev >= 0 ? '+' : ''}${num(s.daysSincePrev)}`}</td>
    </tr>`).join('');
  return `
    <div class="matrix-wrap">
      <table class="matrix preview">
        <thead><tr>
          <th scope="col">שלב</th>
          <th scope="col">תאריך</th>
          <th scope="col">ימים מהשלב הקודם</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

/**
 * A percentile-rank color scale for pl_area_dunam, not a raw-value one -
 * plan area spans from a fraction of a dunam to whole-district plans of
 * thousands of dunam, so a linear (or even log) scale keyed to the raw
 * value would leave nearly every ordinary plan looking identical and only
 * the single largest outlier colored. Rank-within-the-pool instead: the
 * biggest plan currently on screen is always the deepest color, the
 * smallest always the lightest, regardless of the absolute numbers this
 * particular set of cities/years happens to contain.
 *
 * Returns a function (area) -> CSS `background` value (empty string for a
 * missing area), built once from `pool` (every plan the caller wants ranked
 * together - e.g. all picked cities' plans pooled, so size reads consistently
 * across cities rather than each city scaling against only itself).
 */
export function planAreaColorScale(pool) {
  const sorted = pool.map((p) => p.pl_area_dunam).filter((a) => typeof a === 'number' && a >= 0).sort((a, b) => a - b);
  return (area) => {
    if (typeof area !== 'number' || !sorted.length) return '';
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < area) lo = mid + 1; else hi = mid;
    }
    const pct = sorted.length <= 1 ? 1 : lo / (sorted.length - 1);
    // 12%..85% of accent - even the smallest plan gets a faint tint (so the
    // column doesn't read as "blank = no data"), the largest a strong one.
    const strength = Math.round(12 + pct * 73);
    return `background:color-mix(in srgb, var(--accent) ${strength}%, transparent)`;
  };
}

const PLANS_PER_LIST_CAP = 300;

// Three sortable columns - שם תכנית (name), ימים (totalDays) and שטח
// (pl_area_dunam). `key` also doubles as the data-sort-key value read back
// by the caller's click handler (see plan-timeline.js). Nulls always sort
// last regardless of direction, same convention as plan-timeline.js's own
// sortCities() - which also supplies the string-vs-number branch below.
const PLAN_LIST_SORT_COLUMNS = [
  { key: 'name', label: 'שם תכנית', get: (p) => p.pl_name || p.pl_number || '' },
  { key: 'days', label: 'ימים (הגשה→אישור)', get: (p, totalDays) => totalDays },
  { key: 'area', label: 'שטח (דונם)', get: (p) => p.pl_area_dunam },
];

function sortTh(col, sortKey, sortDir) {
  const active = sortKey === col.key;
  const nextDir = active && sortDir === 'asc' ? 'desc' : 'asc';
  return `<th class="sortable${active ? ' sorted' : ''}" data-sort-key="${col.key}" data-sort-dir="${nextDir}"
              tabindex="0" role="button"
              aria-sort="${active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}">
    ${esc(col.label)}<span class="s-mark">${active ? (sortDir === 'asc' ? '▲' : '▼') : '↕'}</span>
  </th>`;
}

/**
 * An expandable list of plans - name, number, status badge, ימים (total
 * duration), שטח (דונם, optionally colored via `areaColor`) - sorted by
 * `sortKey`/`sortDir` (default: ימים, descending - the original fixed
 * order this always had). Each row expands into its own step timeline
 * (renderPlanTimelineHtml) plus a link to pl_url.
 */
export function renderPlanListHtml(plans, { areaColor, sortKey = 'days', sortDir = 'desc' } = {}) {
  const withTotals = plans.map((p) => ({ plan: p, totalDays: planTimeline(p).totalDays }));
  const sortCol = PLAN_LIST_SORT_COLUMNS.find((c) => c.key === sortKey) || PLAN_LIST_SORT_COLUMNS[0];
  const dir = sortDir === 'asc' ? 1 : -1;
  withTotals.sort((a, b) => {
    const av = sortCol.get(a.plan, a.totalDays);
    const bv = sortCol.get(b.plan, b.totalDays);
    if (av == null && bv == null) return 0;
    if (av == null) return 1; // nulls always last, regardless of direction
    if (bv == null) return -1;
    if (typeof av === 'string') return dir * av.localeCompare(bv, 'he');
    return dir * (av - bv);
  });
  const capped = withTotals.slice(0, PLANS_PER_LIST_CAP);
  const capNote = withTotals.length > capped.length
    ? `<p class="acc-hint">מוצגות ${num(capped.length)} מתוך ${num(withTotals.length)} - השתמשו בהורדת ה-Excel לקבלת הכול.</p>` : '';

  const rows = capped.map(({ plan, totalDays }, i) => {
    const badge = statusBadge(plan, totalDays);
    const area = plan.pl_area_dunam;
    const areaStyle = areaColor ? areaColor(area) : '';
    const name = plan.pl_name || plan.pl_number || '';
    // Two distinct links per plan, not one: the name searches Google for it
    // (finding news/discussion, since the plan's own name is rarely
    // enough on its own to place it) - the number instead goes straight to
    // the plan's own page on מבא"ת (מנהל התכנון), when pl_url exists.
    // bindExpandableRows (see ui.js) skips its own toggle for any click
    // that lands on a real <a>, so these navigate instead of just
    // expanding/collapsing the row underneath them.
    const googleHref = `https://www.google.com/search?q=${encodeURIComponent(name)}`;
    const numberCell = plan.pl_url
      ? `<a href="${esc(plan.pl_url)}" target="_blank" rel="noopener">${esc(plan.pl_number || '')}</a>`
      : esc(plan.pl_number || '');
    return `
    <tr class="has-detail" data-plan-row="${i}" tabindex="0" role="button">
      <td class="c-x"><span class="x-mark">▾</span></td>
      <td dir="auto"><a href="${esc(googleHref)}" target="_blank" rel="noopener">${esc(name)}</a></td>
      <td dir="ltr">${numberCell}</td>
      <td><span class="badge ${badge.cls}">${esc(badge.text)}</span></td>
      <td>${totalDays == null ? '—' : num(totalDays)}</td>
      <td${areaStyle ? ` style="${areaStyle}"` : ''}>${area == null ? '—' : num(area)}</td>
    </tr>
    <tr class="detail-row" data-detail="${i}" hidden>
      <td colspan="6">
        ${renderPlanTimelineHtml(plan)}
        ${plan.pl_url ? `<p class="acc-hint"><a href="${esc(plan.pl_url)}" target="_blank" rel="noopener">מסמכי התכנית במבא"ת ↗</a></p>` : ''}
      </td>
    </tr>`;
  }).join('');

  const [nameCol, daysCol, areaCol] = PLAN_LIST_SORT_COLUMNS;

  return `
    ${capNote}
    <div class="matrix-wrap plan-list-wrap">
      <table class="matrix preview expandable">
        <thead><tr>
          <th class="c-x"></th>
          ${sortTh(nameCol, sortKey, sortDir)}
          <th scope="col">מספר תכנית</th>
          <th scope="col">סטטוס</th>
          ${sortTh(daysCol, sortKey, sortDir)}
          ${sortTh(areaCol, sortKey, sortDir)}
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}
