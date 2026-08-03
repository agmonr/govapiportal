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

/**
 * A sortable-by-nothing (pre-sorted by caller), expandable list of plans -
 * name, number, status badge, ימים (total duration), שטח (דונם, optionally
 * colored via `areaColor`). Each row expands into its own step timeline
 * (renderPlanTimelineHtml) plus a link to pl_url. `tableId` must be unique
 * per call on the page (used to scope the expand/collapse wiring via
 * bindExpandableRows in ui.js).
 */
export function renderPlanListHtml(plans, { areaColor } = {}) {
  const withTotals = plans.map((p) => ({ plan: p, totalDays: planTimeline(p).totalDays }));
  withTotals.sort((a, b) => {
    if (a.totalDays == null && b.totalDays == null) return 0;
    if (a.totalDays == null) return 1;
    if (b.totalDays == null) return -1;
    return b.totalDays - a.totalDays;
  });
  const capped = withTotals.slice(0, PLANS_PER_LIST_CAP);
  const capNote = withTotals.length > capped.length
    ? `<p class="acc-hint">מוצגות ${num(capped.length)} מתוך ${num(withTotals.length)} - השתמשו בהורדת ה-Excel לקבלת הכול.</p>` : '';

  const rows = capped.map(({ plan, totalDays }, i) => {
    const badge = statusBadge(plan, totalDays);
    const area = plan.pl_area_dunam;
    const areaStyle = areaColor ? areaColor(area) : '';
    return `
    <tr class="has-detail" data-plan-row="${i}" tabindex="0" role="button">
      <td class="c-x"><span class="x-mark">▾</span></td>
      <td dir="auto">${esc(plan.pl_name || plan.pl_number)}</td>
      <td dir="ltr">${esc(plan.pl_number || '')}</td>
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

  return `
    ${capNote}
    <div class="matrix-wrap">
      <table class="matrix preview expandable">
        <thead><tr>
          <th class="c-x"></th>
          <th scope="col">שם תכנית</th>
          <th scope="col">מספר תכנית</th>
          <th scope="col">סטטוס</th>
          <th scope="col">ימים (הגשה→אישור)</th>
          <th scope="col">שטח (דונם)</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}
