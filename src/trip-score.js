/**
 * The driving score's entire formula, kept in one small file on purpose -
 * trip-report.html has a "how is this built?" panel that shows the same
 * numbers used here, so the score has to be legible enough to print, not
 * just correct enough to compute. If the formula ever changes, that panel's
 * text (SCORE_EXPLANATION below) must change with it - they are meant to be
 * read side by side.
 *
 * Deductions apply once per closed event (a whole braking episode, a whole
 * over-limit stretch), not once per 100ms sample - a 4-second hard stop
 * costs the same as a 1-second one, matching how a human passenger would
 * judge it ("that was one scary stop"), not how the sensor sampled it.
 */

export const SCORE_START = 100;

export const DEDUCTIONS = {
  brake: 3,
  brake_severe: 5,
  accel: 2,
  accel_severe: 4,
  violation_minor: 1,
  violation_moderate: 3,
  violation_severe: 6,
};

/** magnitude in m/s²; severe past 0.8g (~7.84 m/s²), the point past which
 * spec's own 0.5g threshold reads more like "hard" than "firm". */
const SEVERE_ACCEL_MPS2 = 0.8 * 9.80665;

export function violationSeverity(percentageOver) {
  if (percentageOver >= 30) return 'severe';
  if (percentageOver >= 10) return 'moderate';
  return 'minor';
}

/** One deduction per event object (as logged by trip-report.js's
 * EventDetector): {type: 'brake'|'accel'|'violation', magnitude?, severity?}. */
export function deductionFor(event) {
  if (event.type === 'brake') return Math.abs(event.magnitude) >= SEVERE_ACCEL_MPS2 ? DEDUCTIONS.brake_severe : DEDUCTIONS.brake;
  if (event.type === 'accel') return Math.abs(event.magnitude) >= SEVERE_ACCEL_MPS2 ? DEDUCTIONS.accel_severe : DEDUCTIONS.accel;
  if (event.type === 'violation') return DEDUCTIONS[`violation_${event.severity}`] ?? DEDUCTIONS.violation_minor;
  return 0;
}

/** The live score itself: 100 minus every closed event's deduction so far,
 * never below 0 (a terrible trip reads as 0, not negative - there's no
 * meaningful "worse than the floor"). */
export function computeScore(events) {
  const total = events.reduce((sum, e) => sum + deductionFor(e), 0);
  return Math.max(0, Math.round(SCORE_START - total));
}

export function scoreBand(score) {
  if (score >= 90) return { cls: 'sc-great', label: 'נהיגה מצוינת' };
  if (score >= 75) return { cls: 'sc-good', label: 'נהיגה טובה' };
  if (score >= 55) return { cls: 'sc-fair', label: 'יש מקום לשיפור' };
  return { cls: 'sc-poor', label: 'נהיגה מסוכנת' };
}

/* ---------- the "problem meter" - time spent in each speed-vs-limit band --------
 * Same five bands the route polyline itself is colored by (see trip-map.js),
 * so the meter and the map read as the same fact told two ways: a bar you
 * can scan at a glance, and a trace you can point to on the road. Bucketed
 * by TIME (seconds at that ratio), not by point count - GPS fixes don't
 * arrive at a fixed rate, so counting points would silently overweight
 * whatever stretch happened to get denser sampling. */
export const SPEED_BANDS = [
  { key: 'under50', max: 0.5, color: '#00AA00', label: 'עד 50% מהמותר' },
  { key: 'under80', max: 0.8, color: '#FFD400', label: '50%–80% מהמותר' },
  { key: 'under100', max: 1.0, color: '#FF8800', label: '80%–100% מהמותר' },
  { key: 'under120', max: 1.2, color: '#DD0000', label: '100%–120% מהמותר' },
  { key: 'over120', max: Infinity, color: '#990000', label: 'מעל 120% מהמותר' },
];

function bandFor(ratio) {
  return SPEED_BANDS.find((b) => ratio <= b.max) || SPEED_BANDS[SPEED_BANDS.length - 1];
}

/** `points`: [{t, speedKmh, limitKmh}], limitKmh nullable when no OSM data
 * was resolved for that fix - such stretches are excluded from the
 * distribution rather than guessed into a band, and their total time is
 * returned separately as `unknownMs` so the caller can still show "X min
 * without speed-limit data" instead of silently understating the trip. */
export function speedZoneDistribution(points) {
  const msByBand = Object.fromEntries(SPEED_BANDS.map((b) => [b.key, 0]));
  let unknownMs = 0;
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const cur = points[i];
    const dt = cur.t - prev.t;
    if (dt <= 0 || dt > 15000) continue; // a gap this large is a dropped fix, not driving
    if (!cur.limitKmh) { unknownMs += dt; continue; }
    const ratio = cur.speedKmh / cur.limitKmh;
    msByBand[bandFor(ratio).key] += dt;
  }
  return { msByBand, unknownMs };
}

export const SCORE_EXPLANATION = `
הציון מתחיל מ-100 ויורד עם כל אירוע שנרשם בנסיעה (לא לפי כל דגימה בנפרד, אלא פעם אחת לכל אירוע שלם):
בלימה חדה: −3 נק' (−5 אם עוצמתה מעל 0.8g) · האצה חדה: −2 נק' (−4 אם מעל 0.8g) · חריגת מהירות: −1 נק' (קלה, עד 10% מעל המותר), −3 (בינונית, 10%–30%) או −6 (חמורה, מעל 30%).
הציון לא יורד מתחת ל-0 ומתעדכן חי לאורך הנסיעה. מד הבעיות שלמטה מציג את אותם חמישה טווחי מהירות שצובעים את המסלול על המפה, לפי זמן נהיגה בפועל בכל טווח - לא לפי מספר הדגימות.
`.trim();
