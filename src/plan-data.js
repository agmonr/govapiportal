/**
 * Shared data layer for plan-timeline.html and plan-compare.html: how long a
 * building plan (תוכנית) takes from submission (הגשה) to approval (אישור),
 * with a per-plan drill-down into every intermediate milestone.
 *
 * The Xplan plan layer already catalogued in apis.json under the "iplan"
 * portal (used elsewhere for plan boundaries - see blue-lines.js) turns out
 * to carry nine real per-plan milestone DATE fields, not just the current
 * station_desc the sister "tree objections" tracker reads - verified live:
 * of the ~27k plans whose station_desc is "אישור" (approved), ~90% have both
 * receiving_date (the plan's own הגשה/קבלה date) and pl_date_8 (פרסום
 * ברשומות - the actual legal approval/effective date) populated. So a real
 * historical הגשה→אישור duration is computable today from a single live
 * query - no daily snapshot crawler needed, unlike the sister project's own
 * by_city.html generator (which only has station_desc + pl_date_advertise
 * to work with).
 */

const XPLAN_URL = 'https://ags.iplan.gov.il/arcgisiplan/rest/services/PlanningPublic/Xplan/MapServer/1/query';
const PAGE_SIZE = 1000;
const DAY_MS = 86400000;

const OUT_FIELDS = [
  'pl_number', 'pl_name', 'plan_county_name', 'ja_concat', 'plan_area_name',
  'pl_area_dunam', 'pl_url', 'station_desc', 'internet_short_status',
  'receiving_date', 'date_saf', 'depositing_date', 'pl_date_advertise',
  'pl_rejection_date', 'on_hold_date', 'open_date', 'pl_date7', 'pl_date_8',
  'last_update_date',
].join(',');

/** Order matters: this is the pipeline a plan walks through, earliest first.
 *  Used both by planTimeline() (the per-plan drill-down) and by the Excel
 *  export's column order. `field` is the raw Xplan attribute name. */
export const PLAN_STEPS = [
  { field: 'receiving_date', label: 'הגשה (קבלת תכנית)' },
  { field: 'date_saf', label: 'עמידה בתנאי סף' },
  { field: 'depositing_date', label: 'דיון בהפקדה' },
  { field: 'pl_date_advertise', label: 'פרסום בעיתונים (תחילת התנגדויות)' },
  { field: 'pl_rejection_date', label: 'מועד אחרון להתנגדויות' },
  { field: 'on_hold_date', label: 'תחילת טיפול באישור' },
  { field: 'pl_date7', label: 'דיון באישור' },
  { field: 'open_date', label: 'סיום טיפול באישור' },
  { field: 'pl_date_8', label: 'פרסום ברשומות (אישור)' },
];

const FIRST_STEP_FIELD = PLAN_STEPS[0].field;
const LAST_STEP_FIELD = PLAN_STEPS[PLAN_STEPS.length - 1].field;

const CACHE_PREFIX = 'planData:v1:';

/** One page of an ArcGIS resultOffset/exceededTransferLimit query loop, same
 *  shape as the sister repo's own xplan_paginated_query() (Python), just in
 *  the browser and against outFields fixed to OUT_FIELDS above. */
async function fetchPage(where, offset) {
  const params = new URLSearchParams({
    where,
    outFields: OUT_FIELDS,
    returnGeometry: 'false',
    resultRecordCount: String(PAGE_SIZE),
    resultOffset: String(offset),
    f: 'json',
  });
  const res = await fetch(`${XPLAN_URL}?${params}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'שגיאת שרת Xplan');
  return data;
}

/**
 * Every plan matching `where`, paginated to completion. Cached in
 * sessionStorage (keyed by `where`) so navigating between the timeline and
 * compare pages in the same visit doesn't re-fetch ~27k rows twice.
 */
export async function fetchPlans(where, onProgress) {
  const cacheKey = CACHE_PREFIX + where;
  try {
    const cached = sessionStorage.getItem(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch { /* private mode / storage full - just refetch */ }

  const plans = [];
  let offset = 0;
  for (;;) {
    const data = await fetchPage(where, offset);
    const feats = data.features || [];
    for (const f of feats) plans.push(f.attributes);
    if (onProgress) onProgress(plans.length);
    if (!feats.length || !data.exceededTransferLimit) break;
    offset += feats.length;
  }

  try { sessionStorage.setItem(cacheKey, JSON.stringify(plans)); } catch { /* too large for storage - fine, just not cached */ }
  return plans;
}

/** Every plan currently marked approved (station_desc = 'אישור') - the
 *  subset a הגשה→אישור duration can be computed for at all. */
export const APPROVED_WHERE = "station_desc='אישור'";

/** The ordered, populated milestones for one plan: [{ label, date, daysSincePrev }],
 *  skipping any step whose date field is null. `daysSincePrev` is measured
 *  against the previous *populated* step, not the previous step in the full
 *  pipeline, so a plan missing an intermediate date still gets meaningful
 *  deltas rather than a gap silently attributed to the wrong step. Also
 *  returns `totalDays` (receiving_date -> pl_date_8), only when both ends
 *  are present. */
export function planTimeline(plan) {
  const steps = [];
  let prevDate = null;
  for (const { field, label } of PLAN_STEPS) {
    const raw = plan[field];
    if (raw == null) continue;
    const date = new Date(raw);
    const daysSincePrev = prevDate == null ? null : Math.round((date - prevDate) / DAY_MS);
    steps.push({ field, label, date, daysSincePrev });
    prevDate = date;
  }
  const start = plan[FIRST_STEP_FIELD];
  const end = plan[LAST_STEP_FIELD];
  const totalDays = start != null && end != null ? Math.round((end - start) / DAY_MS) : null;
  return { steps, totalDays };
}

/** The calendar year a plan was first submitted (הגשה) - null if
 *  receiving_date itself is null, same "don't guess a missing date" rule as
 *  planTimeline(). */
export function receivingYear(plan) {
  return plan.receiving_date == null ? null : new Date(plan.receiving_date).getFullYear();
}

/** Every distinct הגשה year present in `plans`, newest first - the option
 *  list for the year picker on both plan-timeline.html and
 *  plan-compare.html, derived from whatever's actually in hand rather than
 *  a hardcoded range. */
export function availableYears(plans) {
  const years = new Set();
  for (const p of plans) {
    const y = receivingYear(p);
    if (y != null) years.add(y);
  }
  return [...years].sort((a, b) => b - a);
}

export function median(sortedNums) {
  const n = sortedNums.length;
  if (!n) return null;
  const mid = Math.floor(n / 2);
  return n % 2 ? sortedNums[mid] : (sortedNums[mid - 1] + sortedNums[mid]) / 2;
}

/**
 * Aggregates `plans` by whatever `keyFn` returns (null/undefined keys are
 * dropped), same duration stats either way. Shared by groupByCity (key =
 * city) and groupByYear (key = הגשה year) below - only the grouping key
 * differs between them. Only plans with a computable totalDays contribute to
 * the duration stats; `withTimeline` tracks how many of a bucket's plans
 * that was, out of `count` total, so a thin sample is visible rather than
 * silently averaged over a handful of plans.
 */
function aggregateByKey(plans, keyFn, keyName) {
  const buckets = new Map();
  for (const plan of plans) {
    const key = keyFn(plan);
    if (key == null) continue;
    if (!buckets.has(key)) buckets.set(key, { count: 0, plans: [], days: [] });
    const bucket = buckets.get(key);
    bucket.count += 1;
    bucket.plans.push(plan);
    const { totalDays } = planTimeline(plan);
    if (totalDays != null && totalDays >= 0) bucket.days.push(totalDays);
  }

  return [...buckets.entries()].map(([key, bucket]) => {
    const sorted = [...bucket.days].sort((a, b) => a - b);
    const sum = sorted.reduce((acc, d) => acc + d, 0);
    return {
      [keyName]: key,
      count: bucket.count,
      withTimeline: sorted.length,
      avgDays: sorted.length ? Math.round(sum / sorted.length) : null,
      medianDays: sorted.length ? Math.round(median(sorted)) : null,
      minDays: sorted.length ? sorted[0] : null,
      maxDays: sorted.length ? sorted[sorted.length - 1] : null,
      plans: bucket.plans,
    };
  });
}

/** Aggregates `plans` by plan_county_name (the settlement/city field - same
 *  field the sister repo's by_city.html groups by). */
export function groupByCity(plans) {
  return aggregateByKey(plans, (p) => p.plan_county_name || 'לא ידוע', 'city');
}

/** Aggregates `plans` by the calendar year they were first submitted
 *  (הגשה) - the per-city year-over-year trend view on plan-compare.html
 *  when exactly one city is picked. Sorted chronologically, oldest first. */
export function groupByYear(plans) {
  return aggregateByKey(plans, receivingYear, 'year').sort((a, b) => a.year - b.year);
}

/** Average days spent in each PLAN_STEPS segment, across every plan with a
 *  populated pair for that segment - used by plan-compare.html's optional
 *  stage-by-stage breakdown chart. Segment i is "step i -> step i+1" in
 *  PLAN_STEPS order (pipeline order, not per-plan populated order - a gap in
 *  one plan just contributes nothing to that segment, rather than being
 *  bridged to whichever step happens to be next for that plan). */
export function avgStageDurations(plans) {
  const sums = PLAN_STEPS.slice(0, -1).map(() => ({ sum: 0, n: 0 }));
  for (const plan of plans) {
    for (let i = 0; i < PLAN_STEPS.length - 1; i += 1) {
      const a = plan[PLAN_STEPS[i].field];
      const b = plan[PLAN_STEPS[i + 1].field];
      if (a == null || b == null) continue;
      const days = (b - a) / DAY_MS;
      if (days < 0) continue;
      sums[i].sum += days;
      sums[i].n += 1;
    }
  }
  return PLAN_STEPS.slice(0, -1).map((step, i) => ({
    from: step.label,
    to: PLAN_STEPS[i + 1].label,
    avgDays: sums[i].n ? Math.round(sums[i].sum / sums[i].n) : null,
    n: sums[i].n,
  }));
}
