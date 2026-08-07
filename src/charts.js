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
  // classList.add, not a className reset - a caller's own extra class already
  // on the figure in the HTML (e.g. plan-compare.html's acc-chart-wide) would
  // otherwise get silently wiped on every re-render.
  fig.classList.add('acc-chart');
  if (colorClass) fig.classList.add(colorClass);
  if (ariaLabel) fig.setAttribute('aria-label', ariaLabel);
  else fig.removeAttribute('aria-label');
  fig.innerHTML = `<figcaption>${esc(caption)}</figcaption><div class="acc-bars">${bars}</div>`;
}

/* ---------- horizontal leaderboard ------------------------------------------
 * A ranked top-N reads far better as rows stacked top-to-bottom than as N
 * vertical bars squeezed into one fixed-height row - a different mark from
 * renderBarChart, not that same one rotated. `entries`: [{ label, value,
 * compare? , color?, href? }] - `compare: true` renders a row in the same
 * grayed-out accent used for a compare authority everywhere else, so two
 * authorities can sit as adjacent rows per category without a legend to
 * look up. `color` (optional) overrides the bar's fill with a specific CSS
 * color instead - tree-canopy.html's comparison chart uses this to match
 * each bar to the same per-entity color used in its stat tiles/table rows,
 * rather than every bar sharing one accent regardless of which entity it
 * is. `href` (optional) turns the row's own label into a link (e.g.
 * canopy-heat-compare.js linking a city/neighborhood/street name out to its
 * own canopy-map.html view) - taught to renderHBarChart itself rather than
 * a plan-compare.js-style post-render DOM swap, since that trick only works
 * when `entries` maps 1:1 by array index onto the rendered rows; several
 * callers here (canopy-heat-compare.js's own compare charts) FILTER entries
 * with missing values before rendering, which breaks that index assumption.
 * Existing callers that never pass `color`/`href` are unaffected.
 *
 * `opts.formatValue` (optional, default `num`) overrides how the printed
 * number is formatted - `num` itself rounds to 0 decimals, which silently
 * collapses a small-magnitude index (mortality-compare.js's socio-economic/
 * peripherality values, typically -2..4) into "0"/"-0" for nearly every
 * row. Every existing caller leaves this unset, so behavior is unchanged
 * for them. */
export function renderHBarChart(figId, caption, entries, unit, opts = {}) {
  const { formatValue = num } = opts;
  const fig = el(figId);
  if (!entries.length) { fig.innerHTML = `<figcaption>${esc(caption)}</figcaption><p class="acc-hint">אין נתונים להצגה.</p>`; return; }
  // `groupHeader` (optional) entries are a label-only divider row - no bar,
  // no value - used to break a flat list into named sub-sections within one
  // chart (police-compare.js's category breakdown: one offense-group's
  // header, then that group's cities as ordinary rows right under it).
  // Excluded from peak/floor since they carry no value to scale against.
  const valueEntries = entries.filter((e) => !e.groupHeader);
  const peak = Math.max(...valueEntries.map((e) => e.value));
  // floor is 0 for every existing caller (counts/rates never go negative),
  // reproducing the old value/peak*100 scaling exactly. mortality-
  // compare.js's socio-economic/peripherality index is the first caller
  // whose values can be negative - Math.min(0, ...) picks up the true
  // (negative) minimum only then, so a value below 0 gets a valid
  // proportional width instead of an invalid negative inline-size.
  const floor = Math.min(0, ...valueEntries.map((e) => e.value));
  const range = peak - floor;
  const rows = entries.map((e) => {
    if (e.groupHeader) return `<div class="acc-hbar-group-header">${esc(e.groupHeader)}</div>`;
    const label = e.href
      ? `<a class="acc-hbar-y" dir="auto" href="${esc(e.href)}">${esc(e.label)}</a>`
      : `<span class="acc-hbar-y" dir="auto">${esc(e.label)}</span>`;
    // `displayValue` (optional) lets a caller stretch the bar's length/peak
    // scaling past its "real" number - arnona-compare.js's bruto_bruto
    // reference bars are the first user: `value` reaches to a +25% estimate
    // so the bar visually extends, but the printed number stays the actual
    // computed total, not the stretched one. Every existing caller leaves
    // this unset, so `?? e.value` reproduces prior behavior exactly.
    const shown = e.displayValue ?? e.value;
    return `
    <div class="acc-hbar${e.compare ? ' acc-hbar-compare' : ''}" title="${esc(e.label)}: ${formatValue(shown)} ${esc(unit)}">
      ${label}
      <div class="acc-hbar-track"><div class="acc-hbar-fill" style="inline-size:${range ? ((e.value - floor) / range) * 100 : 0}%${e.color ? `;background:${e.color}` : ''}"></div></div>
      <span class="acc-hbar-v">${formatValue(shown)}</span>
    </div>`;
  }).join('');
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
// A 2nd/3rd compare entity's own table-row swatch (local-finance.html's
// up-to-3-cities compare) - same --accent tint family CITY_COLOR_COMPARE
// already uses (not --fin-compare, which is the CHART bars' own separate
// color system for "compare"), just fading further per extra entity.
export const CITY_COMPARE_COLORS = [
  CITY_COLOR_COMPARE,
  'color-mix(in srgb, var(--accent) 35%, var(--bg) 65%)',
  'color-mix(in srgb, var(--accent) 20%, var(--bg) 80%)',
];
export const cityCompareColor = (i) => CITY_COMPARE_COLORS[i] ?? CITY_COMPARE_COLORS[CITY_COMPARE_COLORS.length - 1];
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

// Tint step for the 2nd/3rd compare entity's own bars, layered on top of
// --fin-compare via color-mix rather than new theme variables - same
// 100/70/45% fade idiom real-estate-compare.js's/canopy-heat-compare.js's
// own PICK_COLORS already use against --accent. Index 0 (the first/only
// compare, the sole case that existed before multi-compare) deliberately
// stays null here and keeps using the original .fin-chart-bar-compare CSS
// class instead of an inline color - zero visual change for every existing
// single-compare chart (local-finance.html before this feature, and
// welfare.html, which still only ever passes one compare entity).
const COMPARE_TINT_PCT = [null, 70, 45];
function compareBarColors(i) {
  const pct = COMPARE_TINT_PCT[i];
  if (pct == null) return null;
  // The "light" (second-series) bar mirrors .fin-chart-bar-compare.fin-
  // chart-bar-light's own 45%-of-compare-color formula, scaled by this same
  // pct instead of a flat 45% - so compare #2/#3 fade the same way compare
  // #1 already does, just starting from a dimmer base.
  const lightPct = Math.round(pct * 0.45);
  return {
    dark: `color-mix(in srgb, var(--fin-compare) ${pct}%, var(--bg) ${100 - pct}%)`,
    light: `color-mix(in srgb, var(--fin-compare) ${lightPct}%, var(--bg) ${100 - lightPct}%)`,
  };
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
 * `compare` (optional): a second entity's own two series, drawn as extra,
 * distinctly-colored bar groups per year purely for scale/comparison. Two
 * shapes both work: a single `{ name, points }` object (welfare.js's own
 * calls, and local-finance.html before multi-compare) or an array of up to
 * 3 such objects (local-finance.html's own up-to-3-cities compare) - always
 * normalized to an array internally. Each compare entity is keyed by year,
 * not assumed to line up positionally with `points` - entities can easily
 * cover different years.
 *
 * Color encodes WHICH ENTITY (main vs. which compare), not which series -
 * which of the two series a bar is (front vs back) is carried by position
 * (front always first) and a lighter tint of that entity's own color, not a
 * second hue. When exactly one compare entity is present (still the common
 * case), each year also gets a small "X% מ-<name>" label: the main entity's
 * total (front+back) as a percentage of that compare's same total - dropped
 * when 2+ compare entities are active, since a single ratio would only ever
 * describe one of them and reads as if it applied to all.
 */
export function renderGroupedChart(figId, caption, points, unit, mainName, labels = { front: 'הכנסות', back: 'הוצאות' }, compare = null) {
  const fig = el(figId);
  if (!points.length) { fig.innerHTML = `<figcaption>${esc(caption)}</figcaption><p class="acc-hint">אין נתונים להצגה.</p>`; return; }
  const compares = Array.isArray(compare) ? compare.filter(Boolean) : (compare ? [compare] : []);
  const compareByYearList = compares.map((c) => new Map((c.points || []).map((p) => [p.year, p])));
  const soloCompare = compares.length === 1 ? compares[0] : null;
  const soloCompareByYear = soloCompare ? compareByYearList[0] : null;
  const peak = Math.max(
    ...points.flatMap((p) => [p.revenue, p.expense]),
    ...compareByYearList.flatMap((byYear) => [...byYear.values()].flatMap((p) => [p.revenue, p.expense])),
  );
  const { steps, axisMax } = niceAxisStep(peak);
  const byYear = new Map(points.map((p) => [p.year, p]));
  const slots = buildYearSlots(points);
  const plotHeight = plotPx();

  const barH = (v) => (axisMax ? Math.round((v / axisMax) * plotHeight) : 0);
  // `compareIdx` null = main entity (plain accent); 0/1/2 = which compare
  // entity, in the same order as `compares`.
  const cityBars = (p, compareIdx) => {
    const tint = compareIdx == null ? null : compareBarColors(compareIdx);
    const cls = compareIdx == null ? '' : ' fin-chart-bar-compare';
    return `
    <div class="fin-chart-bars">
      <div class="fin-chart-bar${cls}" style="block-size:${barH(p.revenue)}px${tint ? `;background:${tint.dark}` : ''}"></div>
      <div class="fin-chart-bar fin-chart-bar-light${cls}" style="block-size:${barH(p.expense)}px${tint ? `;background:${tint.light}` : ''}"></div>
    </div>`;
  };

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
    const cmpPoints = compares.map((c, i) => ({ i, name: c.name, pt: compareByYearList[i].get(slot.year) })).filter((c) => c.pt);
    const soloCmp = soloCompareByYear ? soloCompareByYear.get(slot.year) : null;
    const mainTotal = p.revenue + p.expense;
    const soloCmpTotal = soloCmp ? soloCmp.revenue + soloCmp.expense : null;
    const pct = soloCmp && soloCmpTotal ? Math.round((mainTotal / soloCmpTotal) * 100) : null;
    // A falsy labels.back means a genuine single-series chart (welfare.js's
    // recipients-only comparison, where `expense` is always 0 by
    // construction, not a real second series) - the back half of every
    // title/legend line is dropped rather than describing a series that
    // was never real.
    const title = `${slot.year}${mainName ? ` — ${esc(mainName)}` : ''}: ${esc(labels.front)} ${num(p.revenue)}${labels.back ? `, ${esc(labels.back)} ${num(p.expense)}` : ''} ${esc(unit)}`
      + cmpPoints.map(({ name, pt }) => `; ${esc(name)}: ${esc(labels.front)} ${num(pt.revenue)}${labels.back ? `, ${esc(labels.back)} ${num(pt.expense)}` : ''} ${esc(unit)}`).join('');
    return `
      <div class="fin-chart-group" title="${title}">
        <span class="fin-chart-pct">${pct != null ? `${pct}%<span class="fin-chart-pct-name"> מ-${esc(soloCompare.name)}</span>` : ''}</span>
        <div class="fin-chart-bars-wrap" style="block-size:${plotHeight}px; background-size:100% ${plotHeight / steps}px">
          ${cityBars(p, null)}
          ${cmpPoints.map(({ i, pt }) => cityBars(pt, i)).join('')}
        </div>
        <span class="fin-chart-y">${slot.year}</span>
      </div>`;
  }).join('');

  const axisLabels = Array.from({ length: steps + 1 }, (_, i) => axisMax - i * (axisMax / steps))
    .map((v) => `<span>${num(Math.round(v))}</span>`).join('');

  const legendSwatch = (i) => compareBarColors(i)?.dark || 'var(--fin-compare)';

  fig.className = 'acc-chart acc-chart-wide';
  fig.innerHTML = `
    <figcaption>${esc(caption)}</figcaption>
    <div class="acc-legend">
      <span class="acc-legend-item"><span class="acc-legend-swatch" style="background:var(--accent)"></span>${mainName ? `${esc(mainName)} - ` : ''}${esc(labels.front)}${labels.back ? ` (מלא, ראשון) / ${esc(labels.back)} (בהיר, שני)` : ''}</span>
      ${compares.map((c, i) => `<span class="acc-legend-item"><span class="acc-legend-swatch" style="background:${legendSwatch(i)}"></span>${esc(c.name)} - אותו סדר</span>`).join('')}
    </div>
    <div class="fin-chart-body">
      <div class="fin-chart-axis">
        <span class="fin-chart-pct">&nbsp;</span>
        <div class="fin-chart-axis-scale" style="block-size:${plotHeight}px">${axisLabels}</div>
      </div>
      <div class="fin-chart-plot">${groups}</div>
    </div>
    <p class="acc-hint">${esc(unit)}${soloCompare && mainName ? ` - האחוז מעל כל שנה: הסה"כ של ${esc(mainName)} כאחוז מהסה"כ של ${esc(soloCompare.name)} אותה שנה` : ''}</p>`;
}

/* ---------- multi-series year-trend chart -----------------------------
 * N entities' own single value-per-year series, drawn as adjacent
 * distinctly-colored bars per year group in one shared chart - reuses the
 * same axis/plot/group scaffold (.fin-chart-*) as renderGroupedChart, but
 * for callers with exactly one series per entity (not a front/back pair)
 * and an arbitrary entity count (not "main + up to 3 compare"). First use:
 * police-compare.js's year-trend, which previously rendered a fully
 * separate single-series renderBarChart per picked city/neighborhood -
 * each on its own independent y-axis scale, so shapes weren't actually
 * comparable across cities at a glance the way one shared chart is.
 *
 * `series`: [{ name, color, points: [{ year, value, active? }] }]. `year`
 * must be numeric (buildYearSlots's gap-fill does arithmetic on it).
 * `active` is this page's convention for "partial-year data" - it marks
 * that year's x-axis label with an asterisk rather than tinting the bar,
 * since color here already means "which entity", not "highlighted". A
 * series with no point for a given year renders no bar in that year's
 * group (not a zero-height one) - genuinely missing data, not a real 0. */
export function renderMultiSeriesChart(figId, caption, series, unit, opts = {}) {
  const { emptyMessage = 'אין נתונים להצגה.' } = opts;
  const fig = el(figId);
  const nonEmpty = series.filter((s) => s.points?.length);
  if (!nonEmpty.length) { fig.innerHTML = `<figcaption>${esc(caption)}</figcaption><p class="acc-hint">${esc(emptyMessage)}</p>`; return; }

  const allYears = [...new Set(nonEmpty.flatMap((s) => s.points.map((p) => p.year)))].sort((a, b) => a - b);
  const slots = buildYearSlots(allYears.map((year) => ({ year })));
  const byYearPerSeries = nonEmpty.map((s) => new Map(s.points.map((p) => [p.year, p])));
  const peak = Math.max(...nonEmpty.flatMap((s) => s.points.map((p) => p.value)));
  const { steps, axisMax } = niceAxisStep(peak);
  const plotHeight = plotPx();
  const barH = (v) => (axisMax ? Math.round((v / axisMax) * plotHeight) : 0);

  const groups = slots.map((slot) => {
    if (slot.type === 'gap') {
      const label = slot.from === slot.to ? String(slot.from) : `${slot.from}-${slot.to}`;
      return `
        <div class="fin-chart-group" title="אין נתונים לשנים ${esc(label)}">
          <div class="fin-chart-gap-box" style="block-size:${plotHeight}px"></div>
          <span class="fin-chart-y fin-chart-gap-label">${esc(label)}<br>אין נתונים</span>
        </div>`;
    }
    const { year } = slot;
    const bars = nonEmpty.map((s, i) => {
      const p = byYearPerSeries[i].get(year);
      if (!p) return '';
      return `<div class="fin-chart-bar" style="block-size:${barH(p.value)}px;background:${s.color}" title="${esc(s.name)} — ${year}: ${num(p.value)}${unit ? ` ${esc(unit)}` : ''}"></div>`;
    }).join('');
    const anyActive = nonEmpty.some((s, i) => byYearPerSeries[i].get(year)?.active);
    return `
      <div class="fin-chart-group" title="${esc(String(year))}">
        <div class="fin-chart-bars-wrap" style="block-size:${plotHeight}px; background-size:100% ${plotHeight / steps}px">
          <div class="fin-chart-bars">${bars}</div>
        </div>
        <span class="fin-chart-y">${year}${anyActive ? ' *' : ''}</span>
      </div>`;
  }).join('');

  const axisLabels = Array.from({ length: steps + 1 }, (_, i) => axisMax - i * (axisMax / steps))
    .map((v) => `<span>${num(Math.round(v))}</span>`).join('');

  const hasPartial = slots.some((slot) => slot.type === 'year' && nonEmpty.some((s, i) => byYearPerSeries[i].get(slot.year)?.active));

  fig.className = 'acc-chart acc-chart-wide';
  fig.innerHTML = `
    <figcaption>${esc(caption)}</figcaption>
    <div class="acc-legend">
      ${nonEmpty.map((s) => `<span class="acc-legend-item"><span class="acc-legend-swatch" style="background:${s.color}"></span>${esc(s.name)}</span>`).join('')}
    </div>
    <div class="fin-chart-body">
      <div class="fin-chart-axis">
        <span class="fin-chart-pct">&nbsp;</span>
        <div class="fin-chart-axis-scale" style="block-size:${plotHeight}px">${axisLabels}</div>
      </div>
      <div class="fin-chart-plot">${groups}</div>
    </div>
    <p class="acc-hint">${esc(unit)}${hasPartial ? ' · * שנה עם נתונים חלקיים בלבד' : ''}</p>`;
}
