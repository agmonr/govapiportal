/**
 * Shared chart-rendering primitives, used by accidents.js, committees.js,
 * companies.js, local-finance.js and welfare.js.
 *
 * Until today each page kept its own copy (renderBarChart existed nearly
 * verbatim in three files; renderGroupedChart + its axis/color helpers were
 * copy-pasted whole from local-finance.js into welfare.js). That was a
 * deliberate choice early on, mirroring portal.js's per-API renderers
 * ("each returns a completely different shape") - but these three functions
 * were never actually different shapes, just different call sites. Sharing
 * them means a visual/behavioral fix (the peak-zero NaN guard below, for
 * instance - present in some copies, missing in others) now has one place
 * to land instead of three-to-five.
 *
 * What's deliberately NOT here: any page's own data-fetching or business
 * logic (what counts as "revenue", which resource to query, how to filter a
 * table row) - that part really does differ per page and stays in each
 * page's own file.
 */

import { el, esc, num } from './ui.js';

/* ---------- single-series vertical bar chart -------------------------------
 * Used for: accidents.html (killed/total per year, with an active-year
 * highlight), committees.html (meetings by year/type), companies.html
 * (status/type distribution), local-finance.html (national YoY surplus).
 *
 * `entries`: [{ label, value, active? }]. `unit` is optional - the tooltip
 * only appends it when non-empty, so callers with no natural unit (a plain
 * count) don't get a trailing space. `opts.ariaLabel` and
 * `opts.emptyMessage` cover the two things that varied between the original
 * per-page copies (accidents.js set an aria-label; committees.js had a more
 * specific "no data in the selected range" empty message). */
export function renderBarChart(figId, caption, entries, unit = '', colorClass = '', opts = {}) {
  const { ariaLabel, emptyMessage = 'אין נתונים להצגה.' } = opts;
  const fig = el(figId);
  if (!entries.length) { fig.innerHTML = `<figcaption>${esc(caption)}</figcaption><p class="acc-hint">${esc(emptyMessage)}</p>`; return; }
  // abs() so a signed series (local-finance's deficit years) scales the same
  // way an unsigned one does; a no-op for callers that never have negatives.
  const peak = Math.max(...entries.map((e) => Math.abs(e.value)));
  const bars = entries.map((e) => {
    const h = peak ? Math.round((Math.abs(e.value) / peak) * 150) : 0; // guards a peak of 0 -> NaN height, missing from some of the original copies
    return `
      <div class="acc-bar${e.active ? ' active' : ''}" title="${esc(e.label)}: ${num(e.value)}${unit ? ` ${esc(unit)}` : ''}">
        <div class="acc-bar-track">
          <span class="acc-bar-v">${num(e.value)}</span>
          <div class="acc-bar-fill" style="block-size:${h}px"></div>
        </div>
        <span class="acc-bar-y">${esc(e.label)}</span>
      </div>`;
  }).join('');
  fig.className = `acc-chart${colorClass ? ` ${colorClass}` : ''}`;
  if (ariaLabel) fig.setAttribute('aria-label', ariaLabel);
  else fig.removeAttribute('aria-label');
  fig.innerHTML = `<figcaption>${esc(caption)}</figcaption><div class="acc-bars">${bars}</div>`;
}

/* ---------- horizontal leaderboard ------------------------------------------
 * A ranked top-N reads far better as rows stacked top-to-bottom than as N
 * vertical bars squeezed into one fixed-height row - a different mark from
 * renderBarChart, not that same one rotated. `entries`: [{ label, value,
 * compare? }] - `compare: true` renders a row in the same grayed-out accent
 * used for a compare authority everywhere else, so two authorities can sit
 * as adjacent rows per category without a legend to look up. */
export function renderHBarChart(figId, caption, entries, unit) {
  const fig = el(figId);
  if (!entries.length) { fig.innerHTML = `<figcaption>${esc(caption)}</figcaption><p class="acc-hint">אין נתונים להצגה.</p>`; return; }
  const peak = Math.max(...entries.map((e) => e.value));
  const rows = entries.map((e) => `
    <div class="acc-hbar${e.compare ? ' acc-hbar-compare' : ''}" title="${esc(e.label)}: ${num(e.value)} ${esc(unit)}">
      <span class="acc-hbar-y" dir="auto">${esc(e.label)}</span>
      <div class="acc-hbar-track"><div class="acc-hbar-fill" style="inline-size:${peak ? (e.value / peak) * 100 : 0}%"></div></div>
      <span class="acc-hbar-v">${num(e.value)}</span>
    </div>`).join('');
  fig.innerHTML = `<figcaption>${esc(caption)}</figcaption><div class="acc-hbars">${rows}</div>`;
}

/* ---------- grouped bar chart with an optional "compare" backdrop ----------
 * Two series (labels.front/back) per x-axis point, plus an optional second
 * entity's own two series drawn as a third, distinctly-colored bar group -
 * local-finance.html's revenue/expense-per-authority chart, reused as-is by
 * welfare.html's payments-per-authority chart. */

// Identity color for the "main" vs "compare" entity - solid accent for main,
// a grayed-out tint of the same accent for compare, used identically in
// every chart AND table row that needs to say "which city/entity is this"
// without a legend the reader has to look up chart-to-chart.
export const CITY_COLOR_MAIN = 'var(--accent)';
export const CITY_COLOR_COMPARE = 'color-mix(in srgb, var(--accent) 55%, var(--bg) 45%)';
export const citySwatchCell = (name, color) => `<td class="fin-city-cell"><span class="acc-legend-swatch" style="background:${color}"></span>${esc(name)}</td>`;

const FIN_PLOT_PX_DESKTOP = 200;
const FIN_PLOT_PX_MOBILE = 130; // shorter too, not just narrower - "smaller" on mobile means both axes, not just fitting the width
/** Checked once per render, same convention as index.html's own
 *  matchMedia('(max-width: 640px)') check for the "#more" section - not a
 *  live-updating listener, so a mid-session resize/rotation only takes
 *  effect on the NEXT re-render (a new authority/year/compare pick), not
 *  instantly. Consistent with the rest of this site rather than a special
 *  case for charts. */
const plotPx = () => (window.matchMedia('(max-width: 640px)').matches ? FIN_PLOT_PX_MOBILE : FIN_PLOT_PX_DESKTOP);

/** Rounds a peak value up to a "nice" axis maximum (1/2/2.5/5 x 10^n steps) -
 *  a gridline at 683,417 would tell a reader nothing an unlabeled bar didn't
 *  already; a gridline at 700,000 does. */
function niceAxisStep(max, targetSteps = 5) {
  if (!max || max <= 0) return { step: 1, steps: 1, axisMax: 1 };
  const roughStep = max / targetSteps;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const residual = roughStep / magnitude;
  const niceResidual = residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 2.5 ? 2.5 : residual <= 5 ? 5 : 10;
  const step = niceResidual * magnitude;
  const steps = Math.ceil(max / step);
  return { step, steps, axisMax: step * steps };
}

/** Splits a point series into real years and internal gap runs (a year
 *  between the earliest and latest point that has no data of its own) - a
 *  gap gets its own dashed slot on the chart; years outside the covered span
 *  simply don't appear, since there's no "gap" to mark at the edge of what
 *  the series covers in the first place. A series with no internal gaps
 *  (welfare.html's authority data, checked directly) just returns one slot
 *  per point, same as not having this step at all. */
function buildYearSlots(points) {
  const years = points.map((p) => p.year);
  const minYear = Math.min(...years);
  const maxYear = Math.max(...years);
  const present = new Set(years);
  const slots = [];
  let gapFrom = null;
  for (let y = minYear; y <= maxYear; y++) {
    if (present.has(y)) {
      if (gapFrom != null) { slots.push({ type: 'gap', from: gapFrom, to: y - 1 }); gapFrom = null; }
      slots.push({ type: 'year', year: y });
    } else if (gapFrom == null) {
      gapFrom = y;
    }
  }
  return slots;
}

/**
 * `points`: [{ year, revenue, expense }] for the main entity (`revenue`/
 * `expense` are just the front/back series' values - the names are
 * historical, from local-finance.html's original use, and don't imply money
 * on every page: welfare.html plots recipient-category ₪ through the same
 * two fields).
 *
 * `mainName` (nullable): the main entity's own label, shown in the legend
 * and every group's hover title. Null when the chart has no single named
 * subject (welfare.html's national trend, summed across all authorities) -
 * the legend then shows just the series labels with no name prefix.
 *
 * `compare` (optional): { name, points } - a second entity's own two
 * series, drawn as a third, distinctly-colored bar group per year purely
 * for scale/comparison. Keyed by year, not assumed to line up positionally
 * with `points` - the two entities can easily cover different years.
 *
 * Color encodes WHICH ENTITY (main vs compare), not which series - which of
 * the two series a bar is (front vs back) is carried by position (front
 * always first) and a lighter tint of that entity's own color, not a second
 * hue. When `compare` is set, each year also gets a small "X% מ-<name>"
 * label: the main entity's total (front+back) as a percentage of compare's
 * same total.
 */
export function renderGroupedChart(figId, caption, points, unit, mainName, labels = { front: 'הכנסות', back: 'הוצאות' }, compare = null) {
  const fig = el(figId);
  if (!points.length) { fig.innerHTML = `<figcaption>${esc(caption)}</figcaption><p class="acc-hint">אין נתונים להצגה.</p>`; return; }
  const compareByYear = new Map((compare?.points || []).map((p) => [p.year, p]));
  const peak = Math.max(
    ...points.flatMap((p) => [p.revenue, p.expense]),
    ...[...compareByYear.values()].flatMap((p) => [p.revenue, p.expense]),
  );
  const { steps, axisMax } = niceAxisStep(peak);
  const byYear = new Map(points.map((p) => [p.year, p]));
  const slots = buildYearSlots(points);
  const plotHeight = plotPx();

  const barH = (v) => (axisMax ? Math.round((v / axisMax) * plotHeight) : 0);
  const cityBars = (p, mainEntity) => `
    <div class="fin-chart-bars">
      <div class="fin-chart-bar${mainEntity ? '' : ' fin-chart-bar-compare'}" style="block-size:${barH(p.revenue)}px"></div>
      <div class="fin-chart-bar fin-chart-bar-light${mainEntity ? '' : ' fin-chart-bar-compare'}" style="block-size:${barH(p.expense)}px"></div>
    </div>`;

  const groups = slots.map((slot) => {
    if (slot.type === 'gap') {
      const label = slot.from === slot.to ? String(slot.from) : `${slot.from}-${slot.to}`;
      return `
        <div class="fin-chart-group" title="אין נתונים לשנים ${esc(label)}">
          <div class="fin-chart-gap-box" style="block-size:${plotHeight}px"></div>
          <span class="fin-chart-y fin-chart-gap-label">${esc(label)}<br>אין נתונים</span>
        </div>`;
    }
    const p = byYear.get(slot.year);
    const cmp = compareByYear.get(slot.year);
    const mainTotal = p.revenue + p.expense;
    const cmpTotal = cmp ? cmp.revenue + cmp.expense : null;
    const pct = cmp && cmpTotal ? Math.round((mainTotal / cmpTotal) * 100) : null;
    // A falsy labels.back means a genuine single-series chart (welfare.js's
    // recipients-only comparison, where `expense` is always 0 by
    // construction, not a real second series) - the back half of every
    // title/legend line is dropped rather than describing a series that
    // was never real.
    const title = `${slot.year}${mainName ? ` — ${esc(mainName)}` : ''}: ${esc(labels.front)} ${num(p.revenue)}${labels.back ? `, ${esc(labels.back)} ${num(p.expense)}` : ''} ${esc(unit)}`
      + (cmp ? `; ${esc(compare.name)}: ${esc(labels.front)} ${num(cmp.revenue)}${labels.back ? `, ${esc(labels.back)} ${num(cmp.expense)}` : ''} ${esc(unit)}` : '');
    return `
      <div class="fin-chart-group" title="${title}">
        <span class="fin-chart-pct">${pct != null ? `${pct}%<span class="fin-chart-pct-name"> מ-${esc(compare.name)}</span>` : ''}</span>
        <div class="fin-chart-bars-wrap" style="block-size:${plotHeight}px; background-size:100% ${plotHeight / steps}px">
          ${cityBars(p, true)}
          ${cmp ? cityBars(cmp, false) : ''}
        </div>
        <span class="fin-chart-y">${slot.year}</span>
      </div>`;
  }).join('');

  const axisLabels = Array.from({ length: steps + 1 }, (_, i) => axisMax - i * (axisMax / steps))
    .map((v) => `<span>${num(Math.round(v))}</span>`).join('');

  fig.className = 'acc-chart acc-chart-wide';
  fig.innerHTML = `
    <figcaption>${esc(caption)}</figcaption>
    <div class="acc-legend">
      <span class="acc-legend-item"><span class="acc-legend-swatch" style="background:var(--accent)"></span>${mainName ? `${esc(mainName)} - ` : ''}${esc(labels.front)}${labels.back ? ` (מלא, ראשון) / ${esc(labels.back)} (בהיר, שני)` : ''}</span>
      ${compare ? `<span class="acc-legend-item"><span class="acc-legend-swatch" style="background:var(--fin-compare)"></span>${esc(compare.name)} - אותו סדר</span>` : ''}
    </div>
    <div class="fin-chart-body">
      <div class="fin-chart-axis">
        <span class="fin-chart-pct">&nbsp;</span>
        <div class="fin-chart-axis-scale" style="block-size:${plotHeight}px">${axisLabels}</div>
      </div>
      <div class="fin-chart-plot">${groups}</div>
    </div>
    <p class="acc-hint">${esc(unit)}${compare && mainName ? ` - האחוז מעל כל שנה: הסה"כ של ${esc(mainName)} כאחוז מהסה"כ של ${esc(compare.name)} אותה שנה` : ''}</p>`;
}
