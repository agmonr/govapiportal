/**
 * דוח נסיעה - live vehicle monitoring. GPS + accelerometer -> a driving
 * score and route map, computed entirely client-side. See CLAUDE-adjacent
 * spec discussion: this file deliberately covers only the MVP + OSM slice
 * (no PDF export, no Service Worker background tracking, no IndexedDB) -
 * those were explicitly deferred, not forgotten.
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
import { getSpeedLimitAt } from './trip-speed-limits.js';
import { createTripMap } from './trip-map.js';
import {
  computeScore, scoreBand, speedZoneDistribution, SPEED_BANDS, SCORE_EXPLANATION, violationSeverity,
} from './trip-score.js';

const STORAGE_ACTIVE = 'tripReport:activeTrip';
const STORAGE_LAST_COMPLETE = 'tripReport:lastCompletedTrip';
const AUTOSAVE_MS = 5000;
const HARSH_ACCEL_MPS2 = 0.5 * 9.80665; // spec's own threshold, verbatim
const EVENT_COOLDOWN_MS = 2000; // one hard stop shouldn't log a dozen events around the threshold
const SPEED_TREND_THRESHOLD_KMH_S = 3; // corroborating GPS trend, alongside an accel spike
const GPS_ONLY_TREND_THRESHOLD_KMH_S = 8; // no accelerometer at all - GPS alone is noisier, so the bar is higher
const VIOLATION_MIN_DURATION_MS = 3000; // below this, it's GPS jitter over the line, not a real violation
const VIOLATION_RATIO_MARGIN = 1.03; // 3% buffer so a limit's own rounding doesn't flap true/false
const GRAVITY_ALPHA = 0.8;

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
let lastEventAt = 0;
let violationState = { active: false };
let storageDegraded = false;

function newTrip(vehicleType) {
  return {
    tripId: uid(),
    startTime: Date.now(),
    endTime: null,
    vehicleType,
    status: 'active',
    points: [],
    events: [],
  };
}

function recentSpeedTrendKmhPerS() {
  const pts = trip.points.filter((p) => p.speedKmh != null);
  if (pts.length < 2) return null;
  const a = pts[pts.length - 2];
  const b = pts[pts.length - 1];
  const dtS = (b.t - a.t) / 1000;
  return dtS > 0 ? (b.speedKmh - a.speedKmh) / dtS : null;
}

function logHarshEvent(type, magnitude) {
  const last = trip.points[trip.points.length - 1];
  trip.events.push({
    eventId: uid(), t: Date.now(), lat: last?.lat, lon: last?.lon, type, magnitude,
  });
  lastEventAt = Date.now();
  renderAll();
}

function onMotion(e) {
  if (!trip || trip.status !== 'active') return;
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

  motionAvailable = true;
  const magnitude = Math.sqrt(ax * ax + ay * ay + az * az);
  const now = Date.now();
  if (magnitude < HARSH_ACCEL_MPS2 || now - lastEventAt < EVENT_COOLDOWN_MS) return;

  const trend = recentSpeedTrendKmhPerS();
  if (trend == null) return;
  if (trend <= -SPEED_TREND_THRESHOLD_KMH_S) logHarshEvent('brake', -magnitude);
  else if (trend >= SPEED_TREND_THRESHOLD_KMH_S) logHarshEvent('accel', magnitude);
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
  if (trend <= -GPS_ONLY_TREND_THRESHOLD_KMH_S) logHarshEvent('brake', -Math.abs(magnitude));
  else if (trend >= GPS_ONLY_TREND_THRESHOLD_KMH_S) logHarshEvent('accel', Math.abs(magnitude));
}

function evaluateViolation(point) {
  if (point.limitKmh == null) return;
  const ratio = point.speedKmh / point.limitKmh;
  if (ratio > VIOLATION_RATIO_MARGIN) {
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
      severity: violationSeverity(percentOver),
      durationMs,
      data: { percentOver },
    });
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

  getSpeedLimitAt(lat, lon).then((res) => {
    if (res) { point.limitKmh = res.kmh; point.limitSource = res.source; }
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
  el('trSpeedLimit').textContent = last?.limitKmh != null ? Math.round(last.limitKmh) : '—';
}

function renderAll() {
  if (!trip) return;
  const stats = computeStats();
  const score = computeScore(trip.events);
  renderScoreGauge(score);
  renderProblemMeter(stats);
  renderStatsPanel(stats);
}

/* ---------- screens ---------- */

function showScreen(name) {
  ['Setup', 'Active', 'Complete'].forEach((s) => {
    el(`trScreen${s}`).hidden = s.toLowerCase() !== name;
  });
}

function renderCompleteScreen() {
  const stats = computeStats();
  const score = computeScore(trip.events);
  const band = scoreBand(score);
  el('trCompleteSummary').innerHTML = `
    <p class="tr-complete-score ${band.cls}">ציון הנסיעה: <strong>${score}</strong> - ${esc(band.label)}</p>
    <p>${trip.vehicleType === 'bus' ? 'אוטובוס' : 'רכב פרטי'} · ${formatDuration(stats.durationMs)} · ${(stats.distanceM / 1000).toFixed(2)} ק"מ</p>
    <p>מהירות מרבית: ${Math.round(stats.maxSpeedKmh)} קמ"ש · ממוצעת: ${Math.round(stats.avgSpeedKmh)} קמ"ש</p>
    <p>חריגות מהירות: ${stats.violations.length} · בלימות חדות: ${stats.brakes.length} · האצות חדות: ${stats.accels.length}</p>`;

  const sorted = [...trip.events].sort((a, b) => a.t - b.t);
  const typeLabel = { brake: '🟣 בלימה חדה', accel: '🔵 האצה חדה', violation: '🔴 חריגת מהירות' };
  el('trEventLog').innerHTML = sorted.length ? sorted.map((e) => `
    <li>
      <span class="tr-ev-type">${typeLabel[e.type] || e.type}</span>
      <span class="tr-ev-time">${new Date(e.t).toLocaleTimeString('he-IL')}</span>
      ${e.type === 'violation' ? `<span>${e.data.percentOver}% מעל המותר, ${Math.round(e.durationMs / 1000)} שנ'</span>` : ''}
    </li>`).join('') : '<li class="acc-hint">לא נרשמו אירועים בנסיעה זו.</li>';
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

async function startTrip(vehicleType, resumed) {
  // DeviceMotionEvent.requestPermission() must run synchronously within the
  // click gesture on iOS - called first, before the geolocation permission
  // prompt (which can itself take a moment) has any chance to consume it.
  const motionPromise = requestMotionPermission();

  trip = resumed || newTrip(vehicleType);
  activeMs = resumed ? (resumed.activeMs || 0) : 0;
  tripMap = createTripMap(el('trCanvas'));
  showScreen('active');
  el('trVehicleBadge').textContent = trip.vehicleType === 'bus' ? '🚌 אוטובוס' : '🚗 רכב פרטי';
  el('trPauseResume').textContent = trip.status === 'paused' ? '▶ המשך' : '⏸ השהה';
  el('trStopConfirm').hidden = true;

  const motionGranted = await motionPromise;
  if (motionGranted) window.addEventListener('devicemotion', onMotion);
  else showNotice('trPermStatus', 'אין גישה לחיישן התאוצה - זיהוי בלימות/האצות חדות יתבסס על מהירות ה-GPS בלבד.', 'info');

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
  el('trPauseResume').textContent = '▶ המשך';
  persistActive();
}

function resumeTrip() {
  trip.status = 'active';
  el('trPauseResume').textContent = '⏸ השהה';
  persistActive();
}

function stopTrip() {
  if (violationState.active) closeViolation(Date.now());
  trip.status = 'completed';
  trip.endTime = Date.now();
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  window.removeEventListener('devicemotion', onMotion);
  stopTicking();
  try {
    localStorage.setItem(STORAGE_LAST_COMPLETE, JSON.stringify(trip));
    localStorage.removeItem(STORAGE_ACTIVE);
  } catch { /* best-effort only - the complete screen already has everything in memory */ }
  renderCompleteScreen();
  showScreen('complete');
}

/* ---------- wiring ---------- */

el('trStart').addEventListener('click', () => {
  const vehicleType = document.querySelector('input[name="vehicleType"]:checked')?.value || 'car';
  startTrip(vehicleType, null);
});

el('trPauseResume').addEventListener('click', () => {
  if (trip.status === 'active') pauseTrip(); else resumeTrip();
});

el('trStop').addEventListener('click', () => { el('trStopConfirm').hidden = false; });
el('trStopYes').addEventListener('click', () => stopTrip());
el('trStopNo').addEventListener('click', () => { el('trStopConfirm').hidden = true; });

el('trAutoPan').addEventListener('change', (e) => tripMap?.setAutoPan(e.target.checked));

el('trNewTrip').addEventListener('click', () => {
  trip = null;
  el('trPermStatus').hidden = true;
  showScreen('setup');
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
