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

import { idbGet, idbSet } from './idb-cache.js';

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
// The underlying government data changes daily (plans move between stages,
// new ones get submitted) - long enough that a same-day revisit reuses the
// cache instead of re-fetching ~20-27k rows, short enough that the cache
// doesn't go stale for weeks. See src/idb-cache.js for why IndexedDB rather
// than sessionStorage/localStorage.
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Same "a couple of retries before giving up" convention as the sister
// repo's own xplan_paginated_query() (Python) - a full fetch is ~27
// sequential requests against a live government ArcGIS server, and a single
// transient hiccup on any one of them (observed in practice: an occasional
// {"error":{"message":"Failed to execute query."}} with no HTTP-level
// signal at all - not a timeout, not a non-200 status) would otherwise abort
// the whole load, silently leaving every page that reads from it (city
// roster, year picker, both compare pages) empty.
const FETCH_ATTEMPTS = 3;
const RETRY_PAUSE_MS = 700;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** One page of an ArcGIS resultOffset/exceededTransferLimit query loop, same
 *  shape as the sister repo's own xplan_paginated_query() (Python), just in
 *  the browser and against outFields fixed to OUT_FIELDS above. Retries on
 *  any failure - a bad HTTP status, a network error, or (seen in practice,
 *  see FETCH_ATTEMPTS above) a 200 response whose JSON body is itself an
 *  ArcGIS error object. */
async function fetchPage(where, offset) {
  let lastErr;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    try {
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
      // Two distinct ArcGIS error shapes seen in practice, neither optional
      // to check: a query-specific failure comes back as {error:{message}}
      // (caught below), but a full backend outage - observed live: "Could
      // not access any server machines" - comes back as {status:"error",
      // messages:[...]} instead, with NO `error` key at all. Missing this
      // second shape would silently fall through to `data.features || []`
      // below and read as "zero plans found", not as the outage it is.
      if (data.error) throw new Error(data.error.message || 'שגיאת שרת Xplan');
      if (data.status === 'error') throw new Error((data.messages || []).join('; ') || 'שגיאת שרת Xplan');
      return data;
    } catch (err) {
      lastErr = err;
      if (attempt < FETCH_ATTEMPTS) await sleep(RETRY_PAUSE_MS * attempt);
    }
  }
  throw lastErr;
}

/**
 * Every plan matching `where`, paginated to completion. Cached in IndexedDB
 * (keyed by `where`, see src/idb-cache.js) for CACHE_MAX_AGE_MS - persists
 * across reloads and new tabs, not just within one, so a same-day revisit
 * to either plan-timeline.html or plan-compare.html reuses the ~20-27k rows
 * already fetched rather than re-fetching from Xplan.
 */
export async function fetchPlans(where, onProgress) {
  const cacheKey = CACHE_PREFIX + where;
  // An empty cached array is never a legitimate result for the broad
  // queries this is actually called with (every plan, or every approved
  // plan) - only ever seen from a fetch that silently swallowed a server
  // outage as "zero results" (a real bug, since fixed - see fetchPage's
  // {status:"error"} handling above). Treating [] as "not really cached"
  // means a cache poisoned by that old bug during an outage self-heals on
  // the next load rather than being stuck showing nothing for a full day.
  const cached = await idbGet(cacheKey, CACHE_MAX_AGE_MS);
  if (cached && cached.length) return cached;

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

  // Same reasoning as the read side above: don't write a result that would
  // only poison a future load.
  if (plans.length) await idbSet(cacheKey, plans);
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
 * Duration stats (count/withTimeline/avgDays/medianDays/minDays/maxDays) for
 * one flat list of plans - the per-bucket computation shared by
 * aggregateByKey below and by the size-band breakdown (see sizeBandOf),
 * which needs the same numbers re-scoped to an already-picked city's plans
 * rather than a fresh grouping pass.
 */
export function summarizePlans(plans) {
  const days = [];
  for (const plan of plans) {
    const { totalDays } = planTimeline(plan);
    if (totalDays != null && totalDays >= 0) days.push(totalDays);
  }
  const sorted = days.sort((a, b) => a - b);
  const sum = sorted.reduce((acc, d) => acc + d, 0);
  return {
    count: plans.length,
    withTimeline: sorted.length,
    avgDays: sorted.length ? Math.round(sum / sorted.length) : null,
    medianDays: sorted.length ? Math.round(median(sorted)) : null,
    minDays: sorted.length ? sorted[0] : null,
    maxDays: sorted.length ? sorted[sorted.length - 1] : null,
    plans,
  };
}

/**
 * Aggregates `plans` by whatever `keyFn` returns (null/undefined keys are
 * dropped), same duration stats either way. Shared by groupByCity (key =
 * city) and groupByYear (key = הגשה year) below - only the grouping key
 * differs between them.
 */
function aggregateByKey(plans, keyFn, keyName) {
  const buckets = new Map();
  for (const plan of plans) {
    const key = keyFn(plan);
    if (key == null) continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(plan);
  }
  return [...buckets.entries()].map(([key, bucketPlans]) => ({ [keyName]: key, ...summarizePlans(bucketPlans) }));
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

/** Plan-size bands by pl_area_dunam, same "small/medium/large/very-large"
 *  idiom local-finance.js uses for population tiers - plan-compare.html's
 *  per-size-band comparison charts/tables. A plan with no numeric area
 *  belongs to no band (sizeBandOf returns null) rather than being guessed
 *  into one. */
export const SIZE_SMALL_MAX = 2;
export const SIZE_MEDIUM_MAX = 10;
export const SIZE_BIG_MAX = 50;

export const SIZE_BANDS = ['small', 'medium', 'big', 'huge'];

export function sizeBandOf(plan) {
  const a = plan.pl_area_dunam;
  if (typeof a !== 'number' || a < 0) return null;
  if (a <= SIZE_SMALL_MAX) return 'small';
  if (a <= SIZE_MEDIUM_MAX) return 'medium';
  if (a <= SIZE_BIG_MAX) return 'big';
  return 'huge';
}

export function sizeBandLabel(band) {
  return {
    small: `תכניות קטנות (עד ${SIZE_SMALL_MAX} דונם)`,
    medium: `תכניות בינוניות (${SIZE_SMALL_MAX}–${SIZE_MEDIUM_MAX} דונם)`,
    big: `תכניות גדולות (${SIZE_MEDIUM_MAX}–${SIZE_BIG_MAX} דונם)`,
    huge: `תכניות ענקיות (מעל ${SIZE_BIG_MAX} דונם)`,
  }[band];
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
