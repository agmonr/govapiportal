/**
 * דוח נסיעה - live vehicle monitoring. GPS + accelerometer -> a driving
 * score and route map, computed entirely client-side. Scope is still MVP +
 * OSM + PDF/raw-data export - no background Service Worker tracking, no
 * IndexedDB trip history - those remain explicitly deferred, not forgotten.
 *
 * ---------- why harsh-event direction (brake vs accelerate) isn't read
 * straight off the accelerometer sign ----------
 * A phone's mounting angle/orientation in the vehicle is unknown and
 * arbitrary, so "positive x" carries no fixed meaning ("forward" for one
 * mount is "sideways" for another). What IS reliable is GPS ground speed:
 * if speed is falling sharply at the same moment the accelerometer spikes,
 * that is a brake, full stop. So the accelerometer supplies the magnitude
 * and timing (matching the spec's >0.5g / <-0.5g thresholds exactly); GPS's
 * own speed trend supplies the direction. An accel spike with no
 * corroborating GPS trend (e.g. right at trip start, or a pothole jolt with
 * no speed change) is dropped rather than mislabeled.
 */

import { el, esc } from './ui.js';
import { initThemePicker } from './theme.js';
import { renderAppContext, loadAppsData } from './apps.js';
import { getSpeedLimitAt, hasSchoolNearby } from './trip-speed-limits.js';
import { createTripMap, renderStaticRouteCanvas } from './trip-map.js';
import { buildPdf, downloadBlob } from './pdf.js';
import { saveTripToHistory, listTripHistory, deleteTripFromHistory } from './trip-history.js';
import { computeScore, scoreBand, speedZoneDistribution, SPEED_BANDS, SCORE_EXPLANATION, violationSeverity } from './trip-score.js';

const STORAGE_ACTIVE = 'tripReport:activeTrip';
const STORAGE_LAST_COMPLETE = 'tripReport:lastCompletedTrip';
const STORAGE_SENSITIVITY_PCT = 'tripReport:sensitivityPct';
const AUTOSAVE_MS = 5000;
const HARSH_ACCEL_MPS2 = 0.5 * 9.80665; // spec's own threshold, verbatim - the 100% ("אדיש") baseline
const EVENT_COOLDOWN_MS = 2000; // one hard stop shouldn't log a dozen events around the threshold
const SPEED_TREND_THRESHOLD_KMH_S = 3; // corroborating GPS trend, alongside an accel spike - 100% baseline
const GPS_ONLY_TREND_THRESHOLD_KMH_S = 8; // no accelerometer at all - GPS alone is noisier, so the bar is higher (100% baseline)
const VIOLATION_MIN_DURATION_MS = 3000; // below this, it's GPS jitter over the line, not a real violation
const VIOLATION_RATIO_MARGIN = 1.03; // 3% buffer so a limit's own rounding doesn't flap true/false - 100% baseline
const GRAVITY_ALPHA = 0.8;

/* ---------- detection sensitivity - a single 100%-150% dial (default
 * 100%, labeled "אדיש" in the UI - today's fixed thresholds, unchanged)
 * that scales every trigger threshold above at once: HARSH_ACCEL_MPS2,
 * *_TREND_THRESHOLD_KMH_S and VIOLATION_RATIO_MARGIN. "More sensitive"
 * means triggering more easily, i.e. a LOWER effective threshold - each
 * effective* function below divides its base constant (or, for the
 * violation margin, just the buffer *above* 1.0) by the sensitivity
 * multiplier, so 150% cuts the gap to the trigger point by a third.
 * Persisted in localStorage so it carries over between trips; deliberately
 * NOT scaling DEDUCTIONS/severity tiers in trip-score.js - those score an
 * event already logged, they don't decide whether one gets logged at all,
 * and leaving them fixed keeps the printed SCORE_EXPLANATION text accurate
 * regardless of this setting. */
let sensitivity = 1;

function loadSensitivityPct() {
  const raw = Number(localStorage.getItem(STORAGE_SENSITIVITY_PCT));
  return Number.isFinite(raw) && raw >= 100 && raw <= 150 ? raw : 100;
}

function effectiveHarshAccelMps2() { return HARSH_ACCEL_MPS2 / sensitivity; }
function effectiveSpeedTrendThresholdKmhS() { return SPEED_TREND_THRESHOLD_KMH_S / sensitivity; }
function effectiveGpsOnlyTrendThresholdKmhS() { return GPS_ONLY_TREND_THRESHOLD_KMH_S / sensitivity; }
function effectiveViolationRatioMargin() { return 1 + (VIOLATION_RATIO_MARGIN - 1) / sensitivity; }

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

function formatStartTime(ms) {
  return new Date(ms).toLocaleString('he-IL', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

/** date/time/vehicle-type filename stem, shared by the PDF and JSON
 * exports - spec's own `trip_[YYYY-MM-DD]_[HH-MM-SS]_[vehicletype]` format. */
function tripFilenameBase(t) {
  const d = new Date(t.startTime);
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  return `trip_${date}_${time}_${t.vehicleType}`;
}

/** Hides (driving) / restores (setup, complete) the site header and the
 * app-context sibling strip - a screen meant to be glanced at hands-free
 * while moving shouldn't also be a page you could navigate away from by
 * accident, and the extra chrome is one more thing competing for
 * attention it doesn't need while a trip is actually running. */
function setChromeVisible(visible) {
  el('trSiteHeader').hidden = !visible;
  el('appContext').hidden = !visible;
}

/* ---------- trip state ---------- */

let trip = null;
let tripMap = null;
let watchId = null;
let tickTimer = null;
let autosaveTimer = null;
let activeMs = 0;
let lastTickAt = null;
let motionAvailable = false;
let gravity = null;
let accelSensor = null;
let lastEventAt = 0;
let violationState = { active: false };
// Most recent RESOLVED speed-limit lookup, separate from trip.points' own
// newest entry - getSpeedLimitAt() is async and GPS fixes can arrive faster
// than it resolves, so "the last point" is very often still mid-lookup
// (limitKmh: null) even though an earlier point's lookup just came back.
// Reading trip.points[len-1] directly for display meant the on-screen
// "מהירות מותרת" could sit on "—" indefinitely under exactly that timing,
// even though every individual OSM lookup was succeeding - see
// renderStatsPanel below, which reads this instead.
let lastKnownLimit = null;
let storageDegraded = false;
let wakeLock = null;
let historyMode = false;
let screenWarningTimer = null;

/** Best-effort - GPS + accelerometer tracking is useless if the OS locks
 * the screen mid-trip and suspends the tab; the on-screen reminder (see
 * trip-report.html's .tr-screen-warning) covers browsers/situations where
 * this API isn't available or the lock gets silently released (e.g. the
 * visibility change docs describe), but this makes the common case need no
 * reminder at all. Never throws - a rejected request just means the
 * reminder text is now doing all the work, same as browsers without the
 * API at all. */
async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch (err) {
    console.warn('trip-report: wake lock unavailable', err);
  }
}

async function releaseWakeLock() {
  try {
    await wakeLock?.release();
  } catch { /* already released or never acquired - nothing to do */ }
  wakeLock = null;
}

function newTrip(vehicleType, busLine) {
  return {
    tripId: uid(),
    startTime: Date.now(),
    endTime: null,
    vehicleType,
    busLine: busLine || null,
    city: null,
    status: 'active',
    points: [],
    events: [],
  };
}

/** Nominatim reverse geocode - lat/lon -> a city name, same OSM service
 * (forward direction) blue-lines.js/area-cleanup.js already use for address
 * search. Fired once per bus trip (see onPosition's first-fix check), not
 * on every fix - a city doesn't change fix-to-fix, and Nominatim's usage
 * policy is 1 request/second, not a live-tracking budget. */
const NOMINATIM_REVERSE = 'https://nominatim.openstreetmap.org/reverse';
async function reverseGeocodeCity(lat, lon) {
  const params = new URLSearchParams({
    lat, lon, format: 'jsonv2', 'accept-language': 'he', zoom: '10',
  });
  const res = await fetch(`${NOMINATIM_REVERSE}?${params}`);
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  const data = await res.json();
  const a = data.address || {};
  return a.city || a.town || a.village || a.municipality || null;
}

function recentSpeedTrendKmhPerS() {
  const pts = trip.points.filter((p) => p.speedKmh != null);
  if (pts.length < 2) return null;
  const a = pts[pts.length - 2];
  const b = pts[pts.length - 1];
  const dtS = (b.t - a.t) / 1000;
  return dtS > 0 ? (b.speedKmh - a.speedKmh) / dtS : null;
}

/** Calm, silent feedback for a just-logged event - a brief color pulse on
 * the score gauge (already on screen, so this adds no new visual element)
 * plus a vibration where supported. Deliberately NOT sound or a flashing
 * full-screen takeover: those would be a bigger distraction, mid-drive,
 * than the event they're reacting to. */
function pulseAlert() {
  const gauge = el('trScoreGauge');
  if (!gauge) return;
  gauge.classList.remove('tr-score-pulse');
  // eslint-disable-next-line no-void
  void gauge.offsetWidth; // restart the CSS animation if it's still running from a previous event
  gauge.classList.add('tr-score-pulse');
  if (navigator.vibrate) navigator.vibrate(200);
}

function logHarshEvent(type, magnitude) {
  const last = trip.points[trip.points.length - 1];
  trip.events.push({
    eventId: uid(), t: Date.now(), lat: last?.lat, lon: last?.lon, type, magnitude,
  });
  lastEventAt = Date.now();
  pulseAlert();
  renderAll();
}

/** Shared by both sensor sources below (Generic Sensor API and the
 * DeviceMotionEvent fallback) - same threshold/cooldown/GPS-trend-direction
 * logic regardless of which API actually supplied the sample. `ax/ay/az`
 * must already be gravity-compensated (linear acceleration only). */
function handleAccelSample(ax, ay, az) {
  if (!trip || trip.status !== 'active') return;
  motionAvailable = true;
  const magnitude = Math.sqrt(ax * ax + ay * ay + az * az);
  const now = Date.now();
  if (magnitude < effectiveHarshAccelMps2() || now - lastEventAt < EVENT_COOLDOWN_MS) return;

  const trend = recentSpeedTrendKmhPerS();
  if (trend == null) return;
  const trendThreshold = effectiveSpeedTrendThresholdKmhS();
  if (trend <= -trendThreshold) logHarshEvent('brake', -magnitude);
  else if (trend >= trendThreshold) logHarshEvent('accel', magnitude);
}

function onMotion(e) {
  let ax, ay, az;
  if (e.acceleration && e.acceleration.x != null) {
    ({ x: ax, y: ay, z: az } = e.acceleration);
  } else if (e.accelerationIncludingGravity && e.accelerationIncludingGravity.x != null) {
    const g = e.accelerationIncludingGravity;
    if (!gravity) gravity = { x: g.x, y: g.y, z: g.z };
    else {
      gravity.x = gravity.x * GRAVITY_ALPHA + g.x * (1 - GRAVITY_ALPHA);
      gravity.y = gravity.y * GRAVITY_ALPHA + g.y * (1 - GRAVITY_ALPHA);
      gravity.z = gravity.z * GRAVITY_ALPHA + g.z * (1 - GRAVITY_ALPHA);
    }
    ax = g.x - gravity.x; ay = g.y - gravity.y; az = g.z - gravity.z;
  } else return;
  handleAccelSample(ax, ay, az);
}

/** Generic Sensor API (LinearAccelerationSensor/Accelerometer) - Chrome/
 * Android only today, no Safari/iOS support at all, which is why this is a
 * preferred path attempted FIRST rather than a replacement for the
 * DeviceMotionEvent fallback below: startTrip() falls back to devicemotion
 * whenever this returns false. LinearAccelerationSensor (gravity already
 * removed by the platform) is preferred over the raw Accelerometer class,
 * which - like accelerationIncludingGravity - needs this file's own
 * gravity low-pass filter. Returns whether it actually started; never
 * throws (a permission denial or missing Permissions-Policy is exactly the
 * "fall back to devicemotion" case, not an error to surface). */
async function startAccelerometer() {
  const SensorClass = window.LinearAccelerationSensor || window.Accelerometer;
  if (!SensorClass) return false;
  const isLinear = SensorClass === window.LinearAccelerationSensor;
  try {
    if (navigator.permissions?.query) {
      const status = await navigator.permissions.query({ name: 'accelerometer' });
      if (status.state === 'denied') return false;
    }
    const sensor = new SensorClass({ frequency: 30 });
    let sensorGravity = null;
    sensor.addEventListener('reading', () => {
      if (isLinear) { handleAccelSample(sensor.x, sensor.y, sensor.z); return; }
      if (!sensorGravity) sensorGravity = { x: sensor.x, y: sensor.y, z: sensor.z };
      else {
        sensorGravity.x = sensorGravity.x * GRAVITY_ALPHA + sensor.x * (1 - GRAVITY_ALPHA);
        sensorGravity.y = sensorGravity.y * GRAVITY_ALPHA + sensor.y * (1 - GRAVITY_ALPHA);
        sensorGravity.z = sensorGravity.z * GRAVITY_ALPHA + sensor.z * (1 - GRAVITY_ALPHA);
      }
      handleAccelSample(sensor.x - sensorGravity.x, sensor.y - sensorGravity.y, sensor.z - sensorGravity.z);
    });
    sensor.addEventListener('error', (ev) => {
      console.warn('trip-report: accelerometer sensor error', ev.error);
      // start() can resolve without throwing even when no physical sensor
      // ever answers (e.g. desktop Chrome, no hardware) - the failure only
      // shows up here, asynchronously. No devicemotion fallback is wired
      // up at this point (startAccelerometer already reported success), but
      // checkGpsOnlyHarshEvent()'s own motionAvailable guard already covers
      // this case functionally - this notice is purely so the driver knows
      // detection is running on GPS alone, not silently degraded.
      if (!motionAvailable) showNotice('trPermStatus', 'לא ניתן להתחבר לחיישן התאוצה - זיהוי בלימות/האצות חדות יתבסס על מהירות ה-GPS בלבד.', 'info');
    });
    sensor.start();
    accelSensor = sensor;
    return true;
  } catch (err) {
    console.warn('trip-report: Generic Sensor API accelerometer unavailable', err);
    accelSensor = null;
    return false;
  }
}

/** Only runs when no accelerometer data has ever arrived (denied permission,
 * unsupported browser) - per spec's own "Fallback for Non-SW Browsers"-
 * adjacent limitation table entry for iOS/no-motion devices. Coarser (GPS
 * updates every 1-5s, not 50-100Hz) so the bar for "harsh" is higher. */
function checkGpsOnlyHarshEvent() {
  if (motionAvailable) return;
  const trend = recentSpeedTrendKmhPerS();
  if (trend == null) return;
  const now = Date.now();
  if (now - lastEventAt < EVENT_COOLDOWN_MS) return;
  const magnitude = (trend / 3.6); // km/h/s -> m/s²-ish, for the score's severity check
  const gpsOnlyThreshold = effectiveGpsOnlyTrendThresholdKmhS();
  if (trend <= -gpsOnlyThreshold) logHarshEvent('brake', -Math.abs(magnitude));
  else if (trend >= gpsOnlyThreshold) logHarshEvent('accel', Math.abs(magnitude));
}

function evaluateViolation(point) {
  if (point.limitKmh == null) return;
  const ratio = point.speedKmh / point.limitKmh;
  if (ratio > effectiveViolationRatioMargin()) {
    if (!violationState.active) {
      violationState = {
        active: true, startT: point.t, lat: point.lat, lon: point.lon, peakRatio: ratio,
      };
    } else {
      violationState.peakRatio = Math.max(violationState.peakRatio, ratio);
    }
  } else if (violationState.active) {
    closeViolation(point.t);
  }
}

function closeViolation(atT) {
  const durationMs = atT - violationState.startT;
  if (durationMs >= VIOLATION_MIN_DURATION_MS) {
    const percentOver = Math.round((violationState.peakRatio - 1) * 100);
    trip.events.push({
      eventId: uid(),
      t: violationState.startT,
      lat: violationState.lat,
      lon: violationState.lon,
      type: 'violation',
      severity: violationSeverity(percentOver, durationMs),
      durationMs,
      data: { percentOver },
    });
    pulseAlert();
  }
  violationState = { active: false };
}

function onPosition(position) {
  if (!trip || trip.status !== 'active') return;
  const {
    latitude: lat, longitude: lon, accuracy, speed, heading,
  } = position.coords;
  const t = position.timestamp || Date.now();
  let speedMps = speed;
  const prev = trip.points[trip.points.length - 1];
  if (speedMps == null && prev) {
    const dtS = (t - prev.t) / 1000;
    if (dtS > 0) speedMps = haversineM(prev.lat, prev.lon, lat, lon) / dtS;
  }
  const point = {
    t, lat, lon, accuracy, speedKmh: speedMps != null ? speedMps * 3.6 : null, headingDeg: heading, limitKmh: null, limitSource: null,
  };
  trip.points.push(point);
  checkGpsOnlyHarshEvent();
  tripMap.update(trip.points, trip.events, { lat, lon });
  renderAll();

  if (trip.vehicleType === 'bus' && !trip.city && trip.points.length === 1) {
    reverseGeocodeCity(lat, lon)
      .then((city) => { if (city) { trip.city = city; renderAll(); } })
      .catch(() => {});
  }

  getSpeedLimitAt(lat, lon).then(async (res) => {
    if (res) {
      point.limitKmh = res.kmh; point.limitSource = res.source;
      // Only worth checking when the road's own limit already reads 30 -
      // a school existing nearby says nothing about a DIFFERENT road's
      // limit, so this never runs (or renders) otherwise.
      if (res.kmh === 30) point.schoolZone = await hasSchoolNearby(lat, lon).catch(() => false);
      lastKnownLimit = { limitKmh: point.limitKmh, limitSource: point.limitSource, schoolZone: point.schoolZone };
    }
    evaluateViolation(point);
    renderAll();
  }).catch(() => {});
}

function onPositionError(err) {
  showNotice('trPermStatus', `שגיאת מיקום: ${esc(err.message)} - המעקב ממשיך, אך ייתכן שהנתונים יהיו חלקיים.`, 'error');
}

/* ---------- persistence ---------- */

function persistActive() {
  if (storageDegraded || !trip) return;
  try {
    localStorage.setItem(STORAGE_ACTIVE, JSON.stringify(trip));
  } catch (err) {
    storageDegraded = true;
    showNotice('trPermStatus', 'אחסון מקומי מלא - הנסיעה ממשיכה, אך לא תישמר אם הדף ייסגר.', 'error');
  }
}

function loadActiveFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_ACTIVE);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function loadLastCompleted() {
  try {
    const raw = localStorage.getItem(STORAGE_LAST_COMPLETE);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

/* ---------- stats ---------- */

function computeStats() {
  let distanceM = 0;
  let maxSpeedKmh = 0;
  const speeds = [];
  for (let i = 0; i < trip.points.length; i += 1) {
    const p = trip.points[i];
    if (p.speedKmh != null) { maxSpeedKmh = Math.max(maxSpeedKmh, p.speedKmh); speeds.push(p.speedKmh); }
    if (i > 0) distanceM += haversineM(trip.points[i - 1].lat, trip.points[i - 1].lon, p.lat, p.lon);
  }
  const durationMs = trip.status === 'completed' ? trip.endTime - trip.startTime : activeMs;
  const avgSpeedKmh = durationMs > 0 ? distanceM / (durationMs / 1000) * 3.6 : 0;
  const violations = trip.events.filter((e) => e.type === 'violation');
  const brakes = trip.events.filter((e) => e.type === 'brake');
  const accels = trip.events.filter((e) => e.type === 'accel');
  return {
    distanceM, maxSpeedKmh, avgSpeedKmh, durationMs, violations, brakes, accels,
  };
}

/* ---------- rendering ---------- */

function showNotice(id, text, kind = 'info') {
  const node = el(id);
  if (!node) return;
  node.className = `notice ${kind}`;
  node.textContent = text;
  node.hidden = false;
}

function renderScoreGauge(score) {
  const band = scoreBand(score);
  const gauge = el('trScoreGauge');
  gauge.style.setProperty('--score-deg', `${(score / 100) * 360}deg`);
  gauge.className = `tr-score-gauge ${band.cls}`;
  el('trScoreNum').textContent = score;
  el('trScoreLabel').textContent = band.label;
}

function renderProblemMeter(stats) {
  el('trViolationCount').textContent = stats.violations.length;
  el('trBrakeCount').textContent = stats.brakes.length;
  el('trAccelCount').textContent = stats.accels.length;

  const { msByBand, unknownMs } = speedZoneDistribution(trip.points);
  const totalMs = Object.values(msByBand).reduce((a, b) => a + b, 0) + unknownMs;
  const segs = SPEED_BANDS.map((b) => {
    const pct = totalMs ? (msByBand[b.key] / totalMs) * 100 : 0;
    return `<div class="tr-meter-seg" style="inline-size:${pct}%;background:${b.color}" title="${esc(b.label)}: ${Math.round(pct)}%"></div>`;
  }).join('');
  const unknownPct = totalMs ? (unknownMs / totalMs) * 100 : 0;
  el('trProblemMeter').innerHTML = segs + (unknownPct
    ? `<div class="tr-meter-seg tr-meter-unknown" style="inline-size:${unknownPct}%" title="אין נתוני מהירות מותרת: ${Math.round(unknownPct)}%"></div>` : '');
  el('trProblemLegend').innerHTML = SPEED_BANDS.map((b) => `
    <span class="tr-legend-item"><span class="tr-legend-swatch" style="background:${b.color}"></span>${esc(b.label)}</span>
  `).join('') + '<span class="tr-legend-item"><span class="tr-legend-swatch tr-legend-swatch-unknown"></span>ללא נתוני מהירות מותרת</span>';
}

function renderStatsPanel(stats) {
  el('trDistance').textContent = `${(stats.distanceM / 1000).toFixed(2)} ק"מ`;
  el('trMaxSpeed').textContent = `${Math.round(stats.maxSpeedKmh)} קמ"ש`;
  el('trAvgSpeed').textContent = `${Math.round(stats.avgSpeedKmh)} קמ"ש`;
  el('trElapsed').textContent = formatDuration(stats.durationMs);
  const last = trip.points[trip.points.length - 1];
  el('trSpeedNow').textContent = last?.speedKmh != null ? Math.round(last.speedKmh) : '—';
  el('trSpeedLimit').textContent = lastKnownLimit?.limitKmh != null ? Math.round(lastKnownLimit.limitKmh) : '—';
  el('trSchoolBadge').hidden = !lastKnownLimit?.schoolZone;
}

function renderBusInfo() {
  const node = el('trBusInfo');
  if (trip.vehicleType !== 'bus') { node.hidden = true; return; }
  const parts = [];
  if (trip.busLine) parts.push(`קו ${trip.busLine}`);
  if (trip.city) parts.push(trip.city);
  node.textContent = parts.join(' · ');
  node.hidden = parts.length === 0;
}

function renderAll() {
  if (!trip) return;
  const stats = computeStats();
  const score = computeScore(trip.events);
  renderScoreGauge(score);
  renderProblemMeter(stats);
  renderStatsPanel(stats);
  renderBusInfo();
}

/* ---------- screens ---------- */

function showScreen(name) {
  ['Setup', 'Active', 'Complete', 'History'].forEach((s) => {
    el(`trScreen${s}`).hidden = s.toLowerCase() !== name;
  });
}

function renderCompleteScreen() {
  const stats = computeStats();
  const score = computeScore(trip.events);
  const band = scoreBand(score);
  const busLine = trip.vehicleType === 'bus' && (trip.busLine || trip.city)
    ? ` (${[trip.busLine ? `קו ${trip.busLine}` : null, trip.city].filter(Boolean).join(' · ')})` : '';
  el('trCompleteSummary').innerHTML = `
    <p class="tr-complete-score ${band.cls}">ציון הנסיעה: <strong>${score}</strong> - ${esc(band.label)}</p>
    <p>${trip.vehicleType === 'bus' ? 'אוטובוס' : 'רכב פרטי'}${esc(busLine)} · התחלה: ${esc(formatStartTime(trip.startTime))}</p>
    <p>${formatDuration(stats.durationMs)} · ${(stats.distanceM / 1000).toFixed(2)} ק"מ</p>
    <p>מהירות מרבית: ${Math.round(stats.maxSpeedKmh)} קמ"ש · ממוצעת: ${Math.round(stats.avgSpeedKmh)} קמ"ש</p>
    <p>חריגות מהירות: ${stats.violations.length}</p>
    <p>בלימות חדות: ${stats.brakes.length} · האצות חדות: ${stats.accels.length}</p>`;

  const sorted = [...trip.events].sort((a, b) => a.t - b.t);
  const typeLabel = { brake: '🟣 בלימה חדה', accel: '🔵 האצה חדה', violation: '🔴 חריגת מהירות' };
  el('trEventLog').innerHTML = sorted.length ? sorted.map((e) => `
    <li>
      <span class="tr-ev-type">${typeLabel[e.type] || e.type}${e.severity === 'sustained' ? ' ממושכת' : ''}</span>
      <span class="tr-ev-time">${new Date(e.t).toLocaleTimeString('he-IL')}</span>
      ${e.type === 'violation' ? `<span>${e.data.percentOver}% מעל המותר, ${Math.round(e.durationMs / 1000)} שנ'</span>` : ''}
    </li>`).join('') : '<li class="acc-hint">לא נרשמו אירועים בנסיעה זו.</li>';
}

/* ---------- trip history (view / export / delete past rides) ---------- */

/** Loads `record` as the "current" trip purely for review/export - never a
 * live trip (no watchers/timers attached, no localStorage write) - reuses
 * renderCompleteScreen()/exportTripPdf()/exportTripJson() as-is rather than
 * duplicating them, since all three already just read the module-level
 * `trip` variable. */
function viewHistoryTrip(record) {
  trip = record;
  historyMode = true;
  renderCompleteScreen();
  el('trBackToHistory').hidden = false;
  showScreen('complete');
}

function renderHistoryList() {
  listTripHistory().then((records) => {
    const list = el('trHistoryList');
    if (!records.length) { list.innerHTML = '<li class="acc-hint">אין עדיין נסיעות שמורות.</li>'; return; }
    list.innerHTML = records.map((r) => {
      const score = computeScoreFor(r);
      const distanceKm = totalDistanceFor(r);
      const busLine = r.vehicleType === 'bus' && (r.busLine || r.city)
        ? ` · ${[r.busLine ? `קו ${r.busLine}` : null, r.city].filter(Boolean).join(' · ')}` : '';
      return `
        <li class="tr-history-item" data-trip-id="${esc(r.tripId)}">
          <div class="tr-history-info">
            <span class="tr-history-date">${esc(formatStartTime(r.startTime))}</span>
            <span>${r.vehicleType === 'bus' ? 'אוטובוס' : 'רכב פרטי'}${esc(busLine)} · ${distanceKm} ק"מ · ציון ${score}</span>
          </div>
          <div class="fin-export-row">
            <button type="button" class="drill-dl tr-hist-view">👁 צפייה</button>
            <button type="button" class="drill-dl tr-hist-pdf">📄 PDF</button>
            <button type="button" class="drill-dl tr-hist-json">⬇ JSON</button>
            <button type="button" class="drill-dl tr-hist-delete">🗑 מחיקה</button>
          </div>
        </li>`;
    }).join('');

    list.querySelectorAll('.tr-history-item').forEach((li) => {
      const tripId = li.dataset.tripId;
      const record = records.find((r) => r.tripId === tripId);
      li.querySelector('.tr-hist-view').addEventListener('click', () => viewHistoryTrip(record));
      li.querySelector('.tr-hist-pdf').addEventListener('click', () => {
        trip = record; historyMode = true;
        exportTripPdf().catch((err) => console.warn('trip-report: history PDF export failed', err));
      });
      li.querySelector('.tr-hist-json').addEventListener('click', () => {
        trip = record; historyMode = true;
        exportTripJson();
      });
      const delBtn = li.querySelector('.tr-hist-delete');
      delBtn.addEventListener('click', () => {
        if (delBtn.dataset.armed) {
          deleteTripFromHistory(tripId).then(renderHistoryList)
            .catch((err) => console.warn('trip-report: delete from history failed', err));
          return;
        }
        delBtn.dataset.armed = '1';
        delBtn.textContent = 'למחוק בוודאות?';
        setTimeout(() => { delBtn.dataset.armed = ''; delBtn.textContent = '🗑 מחיקה'; }, 3000);
      });
    });
  }).catch((err) => {
    el('trHistoryList').innerHTML = `<li class="notice error">טעינת ההיסטוריה נכשלה: ${esc(err.message)}</li>`;
  });
}

/** computeStats()/computeScore() both read the module-level `trip` - these
 * two one-line wrappers let the history list compute a score/distance per
 * row without swapping `trip` in and out of scope for every row it draws. */
function computeScoreFor(record) { return computeScore(record.events); }
function totalDistanceFor(record) {
  let m = 0;
  for (let i = 1; i < record.points.length; i += 1) {
    m += haversineM(record.points[i - 1].lat, record.points[i - 1].lon, record.points[i].lat, record.points[i].lon);
  }
  return (m / 1000).toFixed(1);
}

/* ---------- PDF / raw-data export ----------
 * Same hand-rolled approach as area-cleanup.html/blue-lines.html (src/pdf.js
 * - no jsPDF, no CDN): a JPEG-encoded canvas page for the map (the current
 * #trCanvas snapshot, whatever it last drew - no separate re-render step),
 * plus a second canvas page with the summary/event log rendered as text
 * (a canvas already gets Hebrew right via the browser's own font stack,
 * which this hand-written PDF writer has no font embedding to do itself). */

function canvasToJpegBytes(canvas, quality = 0.85) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
    .then((blob) => blob.arrayBuffer())
    .then((buf) => new Uint8Array(buf));
}

function wrapText(ctx, text, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = word; } else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

function buildTripSummaryLines(stats, score, band) {
  const busLine = trip.vehicleType === 'bus' && (trip.busLine || trip.city)
    ? ` (${[trip.busLine ? `קו ${trip.busLine}` : null, trip.city].filter(Boolean).join(' · ')})` : '';
  return [
    `ציון הנסיעה: ${score} - ${band.label}`,
    `${trip.vehicleType === 'bus' ? 'אוטובוס' : 'רכב פרטי'}${busLine}`,
    `התחלה: ${formatStartTime(trip.startTime)}`,
    `משך: ${formatDuration(stats.durationMs)} · מרחק: ${(stats.distanceM / 1000).toFixed(2)} ק"מ`,
    `מהירות מרבית: ${Math.round(stats.maxSpeedKmh)} קמ"ש · ממוצעת: ${Math.round(stats.avgSpeedKmh)} קמ"ש`,
    `חריגות מהירות: ${stats.violations.length}`,
    `בלימות חדות: ${stats.brakes.length} · האצות חדות: ${stats.accels.length}`,
    '',
    'יומן אירועים:',
    ...(trip.events.length ? [...trip.events].sort((a, b) => a.t - b.t).map((e) => {
      const time = new Date(e.t).toLocaleTimeString('he-IL');
      const type = { brake: 'בלימה חדה', accel: 'האצה חדה', violation: 'חריגת מהירות' }[e.type] || e.type;
      const sustained = e.severity === 'sustained' ? ' ממושכת' : '';
      const detail = e.type === 'violation' ? ` - ${e.data.percentOver}% מעל המותר, ${Math.round(e.durationMs / 1000)} שנ'` : '';
      return `${time} - ${type}${sustained}${detail}`;
    }) : ['לא נרשמו אירועים בנסיעה זו.']),
  ];
}

/** Text-only PDF page: title + buildTripSummaryLines(), word-wrapped to the
 * map page's own width so both pages read as one document. */
function buildTripDataPageCanvas(stats, score, band) {
  const width = 640;
  const pad = 28;
  const lineH = 24;
  const titleH = 44;
  const measurer = document.createElement('canvas').getContext('2d');
  measurer.font = '15px sans-serif';
  const rendered = buildTripSummaryLines(stats, score, band)
    .flatMap((line) => (line === '' ? [''] : wrapText(measurer, line, width - pad * 2)));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = titleH + pad * 2 + rendered.length * lineH;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.direction = 'rtl';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#2e7d46';
  ctx.font = 'bold 19px sans-serif';
  ctx.fillText('דוח נסיעה — סיכום', width - pad, pad);

  let y = pad + titleH;
  ctx.font = '15px sans-serif';
  ctx.fillStyle = '#24331f';
  for (const line of rendered) {
    ctx.fillText(line, width - pad, y);
    y += lineH;
  }
  return canvas;
}

async function buildTripPdfBlob() {
  const stats = computeStats();
  const score = computeScore(trip.events);
  const band = scoreBand(score);
  const pages = [];
  // A fresh fit-to-route render, not a snapshot of whatever #trCanvas
  // currently shows - the live map used to only ever display a small area
  // around the *current* position, so a long trip's PDF map page showed
  // almost none of the actual route. This also fixes historyMode, which
  // used to skip the map page entirely (the live canvas belongs to
  // whichever trip was last actively driven, not necessarily the one being
  // re-exported from history) - a standalone render has no such
  // dependency, so a past trip reopened from history gets a real map too.
  const mapCanvas = await renderStaticRouteCanvas(trip.points, trip.events);
  if (mapCanvas) {
    pages.push({ jpegBytes: await canvasToJpegBytes(mapCanvas), width: mapCanvas.width, height: mapCanvas.height });
  }
  const dataCanvas = buildTripDataPageCanvas(stats, score, band);
  pages.push({ jpegBytes: await canvasToJpegBytes(dataCanvas), width: dataCanvas.width, height: dataCanvas.height });
  return buildPdf({ pages });
}

/** `silent`: true for the automatic on-stop download (no button-label
 * feedback to restore - there is no button click to react to). */
async function exportTripPdf({ silent = false } = {}) {
  const btn = el('trExportPdf');
  const prevLabel = btn?.textContent;
  if (!silent && btn) { btn.disabled = true; btn.textContent = 'בונה PDF…'; }
  try {
    const pdfBlob = await buildTripPdfBlob();
    downloadBlob(pdfBlob, `${tripFilenameBase(trip)}.pdf`);
    return pdfBlob;
  } finally {
    if (!silent && btn) { btn.disabled = false; btn.textContent = prevLabel; }
  }
}

/** Same navigator.share()-with-files-first, wa.me-fallback pattern as
 * area-cleanup.js's shareToWhatsApp - WhatsApp registers as a native OS
 * share target, so the PDF goes along as a real attachment wherever that's
 * supported; wa.me is a plain link with no file-carrying capability at all,
 * so on a desktop browser without file-sharing the PDF is downloaded first
 * and the visitor attaches it by hand. */
function canShareFiles(type) {
  return !!(navigator.canShare && navigator.canShare({ files: [new File([], 'x', { type })] }));
}

async function shareTripToWhatsApp() {
  const status = el('trExportStatus');
  const filename = `${tripFilenameBase(trip)}.pdf`;
  if (canShareFiles('application/pdf')) {
    status.textContent = 'בונה PDF לשיתוף…';
    try {
      const pdfBlob = await buildTripPdfBlob();
      const file = new File([pdfBlob], filename, { type: 'application/pdf' });
      status.textContent = '';
      await navigator.share({ files: [file] });
    } catch (err) {
      if (err.name !== 'AbortError') showNotice('trExportStatus', `שיתוף נכשל: ${esc(err.message)}`, 'error');
      else status.textContent = '';
    }
    return;
  }
  status.textContent = 'בונה PDF…';
  try {
    const pdfBlob = await buildTripPdfBlob();
    downloadBlob(pdfBlob, filename);
    const score = computeScore(trip.events);
    const text = `דוח נסיעה - ציון ${score}/100`;
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
    status.textContent = `נפתח וואטסאפ; קובץ ה-PDF גם הורד למכשיר (${filename}) - צרפו אותו ידנית (לחצו על סיכת הנייר 📎 בוואטסאפ).`;
  } catch (err) {
    showNotice('trExportStatus', `בניית ה-PDF נכשלה: ${esc(err.message)}`, 'error');
  }
}

/** The full trip object as-is (points + events + everything derived from
 * them) - a JSON dump, not a curated export, since anyone wanting the raw
 * data wants exactly what was recorded, not a lossy summary of it. */
function exportTripJson() {
  const blob = new Blob([JSON.stringify(trip, null, 2)], { type: 'application/json' });
  downloadBlob(blob, `${tripFilenameBase(trip)}.json`);
}

/* ---------- lifecycle ---------- */

async function requestMotionPermission() {
  if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
    try {
      const result = await DeviceMotionEvent.requestPermission();
      return result === 'granted';
    } catch { return false; }
  }
  return typeof DeviceMotionEvent !== 'undefined';
}

function startTicking() {
  lastTickAt = Date.now();
  tickTimer = setInterval(() => {
    if (trip.status === 'active') {
      activeMs += Date.now() - lastTickAt;
      trip.activeMs = activeMs; // kept on the trip object so a reload can resume the clock, not just the points
      renderAll();
    }
    lastTickAt = Date.now();
  }, 1000);
  autosaveTimer = setInterval(persistActive, AUTOSAVE_MS);
}

function stopTicking() {
  clearInterval(tickTimer);
  clearInterval(autosaveTimer);
  tickTimer = null;
  autosaveTimer = null;
}

async function startTrip(vehicleType, resumed, busLine) {
  // DeviceMotionEvent.requestPermission() must run synchronously within the
  // click gesture on iOS - called first, before the geolocation permission
  // prompt (which can itself take a moment) has any chance to consume it.
  const motionPromise = requestMotionPermission();

  trip = resumed || newTrip(vehicleType, busLine);
  historyMode = false;
  activeMs = resumed ? (resumed.activeMs || 0) : 0;
  // A brand-new trip has no prior limit to show; a resumed one might -
  // seed from its last point instead of blanking a value that was already
  // known before the pause, same reasoning as lastKnownLimit's own comment.
  const priorLast = trip.points[trip.points.length - 1];
  lastKnownLimit = priorLast?.limitKmh != null
    ? { limitKmh: priorLast.limitKmh, limitSource: priorLast.limitSource, schoolZone: priorLast.schoolZone }
    : null;
  tripMap = createTripMap(el('trCanvas'));
  setChromeVisible(false);
  acquireWakeLock();
  showScreen('active');
  el('trStartTime').textContent = formatStartTime(trip.startTime);
  el('trPauseResume').textContent = trip.status === 'paused' ? '▶' : '⏸';
  el('trStopConfirm').hidden = true;
  el('trScreenWarning').classList.remove('tr-warning-shrink');
  clearTimeout(screenWarningTimer);
  screenWarningTimer = setTimeout(() => el('trScreenWarning').classList.add('tr-warning-shrink'), 30000);

  const sensorStarted = await startAccelerometer();
  if (!sensorStarted) {
    const motionGranted = await motionPromise;
    if (motionGranted) window.addEventListener('devicemotion', onMotion);
    else showNotice('trPermStatus', 'אין גישה לחיישן התאוצה - זיהוי בלימות/האצות חדות יתבסס על מהירות ה-GPS בלבד.', 'info');
  }

  watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true, maximumAge: 0, timeout: 15000,
  });

  if (trip.points.length) {
    const last = trip.points[trip.points.length - 1];
    await tripMap.recenter(last.lat, last.lon);
  }
  startTicking();
  renderAll();
  persistActive();
}

function pauseTrip() {
  trip.status = 'paused';
  if (violationState.active) closeViolation(Date.now());
  el('trPauseResume').textContent = '▶';
  persistActive();
}

function resumeTrip() {
  trip.status = 'active';
  el('trPauseResume').textContent = '⏸';
  persistActive();
}

function stopTrip() {
  if (violationState.active) closeViolation(Date.now());
  trip.status = 'completed';
  trip.endTime = Date.now();
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  window.removeEventListener('devicemotion', onMotion);
  if (accelSensor) { accelSensor.stop(); accelSensor = null; }
  stopTicking();
  releaseWakeLock();
  clearTimeout(screenWarningTimer);
  try {
    localStorage.setItem(STORAGE_LAST_COMPLETE, JSON.stringify(trip));
    localStorage.removeItem(STORAGE_ACTIVE);
  } catch { /* best-effort only - the complete screen already has everything in memory */ }
  saveTripToHistory(trip).catch((err) => console.warn('trip-report: saving to history failed', err));
  setChromeVisible(true);
  renderCompleteScreen();
  showScreen('complete');
  exportTripPdf({ silent: true }).catch((err) => console.warn('trip-report: auto PDF export failed', err));
}

/* ---------- wiring ---------- */

document.querySelectorAll('input[name="vehicleType"]').forEach((r) => r.addEventListener('change', () => {
  el('trBusLineRow').hidden = document.querySelector('input[name="vehicleType"]:checked')?.value !== 'bus';
}));

// Restored from localStorage on load, applied live to `sensitivity` (read
// by effectiveHarshAccelMps2() etc.) on every drag - takes effect on the
// very next accelerometer sample/GPS fix, even mid-trip, not just for a
// trip started after changing it.
(() => {
  const pct = loadSensitivityPct();
  sensitivity = pct / 100;
  el('trSensitivity').value = pct;
  el('trSensitivityValue').textContent = `${pct}%`;
})();
el('trSensitivity').addEventListener('input', (e) => {
  const pct = Number(e.target.value);
  sensitivity = pct / 100;
  el('trSensitivityValue').textContent = `${pct}%`;
  try { localStorage.setItem(STORAGE_SENSITIVITY_PCT, String(pct)); } catch { /* private mode/full storage - setting still applies this session, just won't persist */ }
});

el('trStart').addEventListener('click', () => {
  const vehicleType = document.querySelector('input[name="vehicleType"]:checked')?.value || 'car';
  const busLine = vehicleType === 'bus' ? el('trBusLine').value.trim() : null;
  startTrip(vehicleType, null, busLine);
});

el('trPauseResume').addEventListener('click', () => {
  if (trip.status === 'active') pauseTrip(); else resumeTrip();
});

el('trStop').addEventListener('click', () => { el('trStopConfirm').hidden = false; });
el('trStopYes').addEventListener('click', () => stopTrip());
el('trStopNo').addEventListener('click', () => { el('trStopConfirm').hidden = true; });

el('trAutoPan').addEventListener('change', (e) => tripMap?.setAutoPan(e.target.checked));

el('trExportPdf').addEventListener('click', () => {
  exportTripPdf().catch((err) => showNotice('trExportStatus', `ייצוא ה-PDF נכשל: ${esc(err.message)}`, 'error'));
});
el('trShareWhatsapp').addEventListener('click', () => shareTripToWhatsApp());
el('trExportJson').addEventListener('click', () => exportTripJson());

el('trNewTrip').addEventListener('click', () => {
  trip = null;
  historyMode = false;
  el('trPermStatus').hidden = true;
  el('trBusLine').value = '';
  el('trBusLineRow').hidden = true;
  el('trBackToHistory').hidden = true;
  setChromeVisible(true);
  showScreen('setup');
});

function openHistory() {
  showScreen('history');
  renderHistoryList();
}
el('trShowHistorySetup').addEventListener('click', openHistory);
el('trShowHistoryComplete').addEventListener('click', openHistory);
el('trHistoryBack').addEventListener('click', () => showScreen('setup'));
el('trBackToHistory').addEventListener('click', () => {
  el('trBackToHistory').hidden = true;
  openHistory();
});

el('trScoreExplain').textContent = SCORE_EXPLANATION;

/* ---------- resume-after-reload prompt ---------- */

function initResumePrompt() {
  const saved = loadActiveFromStorage();
  if (!saved || saved.status === 'completed') return;
  const box = el('trResumeBox');
  box.hidden = false;
  box.querySelector('.tr-resume-yes').addEventListener('click', () => {
    box.hidden = true;
    startTrip(saved.vehicleType, saved);
  });
  box.querySelector('.tr-resume-no').addEventListener('click', () => {
    localStorage.removeItem(STORAGE_ACTIVE);
    box.hidden = true;
  });
}

function initLastCompletedBanner() {
  const last = loadLastCompleted();
  if (!last) return;
  trip = last;
  renderCompleteScreen();
  showScreen('complete');
}

/* ---------- boot ---------- */

initThemePicker(el('themePick'));
loadAppsData().then((data) => renderAppContext(el('appContext'), data.apps, 'trip-report')).catch(() => {});
if (loadActiveFromStorage()) initResumePrompt();
else initLastCompletedBanner();
