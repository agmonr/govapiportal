/**
 * "מי אחראי על ניקיון האזור?" - a location (browser geolocation or a typed
 * address) in, the RIGHT body to call out - not always the city.
 *
 * Two separate, genuinely different bodies can be responsible for the same
 * spot: the city's own מוקד for ordinary streets/sidewalks/bins, but a
 * regional רשות ניקוז ונחלים (drainage authority) instead for an actual
 * river/stream/drainage channel - a citizen calling the city about pollution
 * IN a stream is calling the wrong number, since the stream itself sits
 * outside every municipal מוקד's remit by law (חוק הניקוז וההגנה מפני
 * שיטפונות, תשי"ח-1957). Both answers are looked up from the SAME point via
 * two independent live point-in-polygon queries - not a static "which city
 * is near which river" guess.
 *
 * Both queries reuse the exact pattern blue-lines.js's checkMetroZone()
 * already proved out on the same iplan GeometryServer this session: project
 * the address's WGS84 point into whatever the target layer's own SRS is,
 * then ask "does any polygon here contain this point" via a live query - no
 * offline shapefile, no precomputed lookup of coordinates to city/basin.
 *
 * Layers, found via GovMap's own public WFS GetCapabilities (no official
 * doc page links these two together - found this workspace lists both a
 * municipal-boundary layer AND a drainage-basin layer, confirmed against a
 * real point: Hod HaSharon's centroid resolves to muni "הוד השרון" AND
 * Nikuz basin "ירקון", both correct):
 *   - opendata:muni_il  - כל רשויות ישראל, גבולות שיפוט (Muni_Heb, Sug_Muni)
 *   - opendata:Nikuz    - אגני ניקוז טבעיים (FNAME) - הבסיס הגאוגרפי לחלוקה
 *     בין 11 רשויות הניקוז הארציות, אך אינו זהה לה: השכבה עצמה היא
 *     חלוקה הידרולוגית עדינה (191 אגנים), לא שכבה מנהלית של 11 הרשויות.
 *     BASIN_TO_AUTHORITY למטה ממפה רק אגנים שנבדקו ישירות (ראו הערה שם) -
 *     לא ניחוש. אגן שלא מופיע שם מוצג כשמו הגולמי, בלי לשייך אותו לרשות
 *     בניחוש.
 */

import { el, esc, showError, showLoading, param } from './ui.js';
import { initThemePicker } from './theme.js';
import { ITM_WKID, WGS84_WKID, projectPoints, bboxAround, fetchBasemapCanvas, drawAddressPin } from './geo-utils.js';

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const GOVMAP_WFS = 'https://open.govmap.gov.il/geoserver/opendata/wfs';
const MAP_RADIUS = 500; // metres - "1 ק"מ סביב" means ±500m from centre, a 1km-wide box
const MAP_SIZE = 640;

/** NOT the full ~191-basin national catalogue - just the basins this app has
 * actually needed to resolve so far, each checked directly rather than
 * assumed: ירקון/קישון are the basin's own name matching the authority's
 * name exactly (both officially named after that exact river); בשור/שקמה/
 * אבטח are confirmed from רשות ניקוז שקמה-בשור's own site, which lists all
 * three as rivers under its jurisdiction. A basin missing here still gets an
 * honest answer (its raw name, no authority guess) rather than blocking the
 * feature on a complete table that doesn't exist anywhere as one source. */
const BASIN_TO_AUTHORITY = {
  ירקון: 'רשות ניקוז ונחלים ירקון',
  קישון: 'רשות ניקוז קישון',
  בשור: 'רשות ניקוז ונחלים שקמה-בשור',
  שקמה: 'רשות ניקוז ונחלים שקמה-בשור',
  אבטח: 'רשות ניקוז ונחלים שקמה-בשור',
};

function fetchJson(url, opts) {
  return fetch(url, opts).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
}

async function geocode(address) {
  const params = new URLSearchParams({ q: address, format: 'jsonv2', limit: 1, countrycodes: 'il' });
  const results = await fetchJson(`${NOMINATIM}?${params}`);
  if (!results.length) throw new Error(`לא נמצאה כתובת תואמת ל"${address}"`);
  const r = results[0];
  return { lon: Number(r.lon), lat: Number(r.lat), displayName: r.display_name };
}

/** Browser geolocation, wrapped as a promise - see module docstring for why
 * this is one of two ways in (the other being a typed address via geocode
 * above), both landing on the exact same WGS84-point-in downstream logic. */
function getBrowserLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('הדפדפן אינו תומך במיקום גאוגרפי.')); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lon: pos.coords.longitude, lat: pos.coords.latitude }),
      (err) => reject(new Error(`לא ניתן היה לקבל את המיקום: ${err.message}`)),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  });
}

/** Every feature of `typeName` whose polygon contains (x,y) in ITM - same
 * "does a polygon here contain this point" shape as blue-lines.js's
 * checkMetroZone(), just against GovMap's WFS instead of iplan's MapServer. */
async function pointInPolygon(typeName, x, y, propertyNames) {
  const params = new URLSearchParams({
    service: 'WFS', version: '2.0.0', request: 'GetFeature',
    typeName, outputFormat: 'application/json',
    propertyName: propertyNames.join(','),
    CQL_FILTER: `INTERSECTS(the_geom, POINT(${x} ${y}))`,
  });
  const result = await fetchJson(`${GOVMAP_WFS}?${params}`);
  return (result.features || []).map((f) => f.properties);
}

async function lookup(lon, lat) {
  const [[x, y]] = await projectPoints([[lon, lat]], WGS84_WKID, ITM_WKID);
  const [munis, basins] = await Promise.all([
    pointInPolygon('opendata:muni_il', x, y, ['Muni_Heb', 'Sug_Muni']),
    pointInPolygon('opendata:Nikuz', x, y, ['FNAME']),
  ]);
  return {
    muni: munis[0] || null, basin: basins[0]?.FNAME || null, itmX: x, itmY: y,
  };
}

/** A ready-made Google search link for `query` - same "don't make someone
 * retype it" convention blue-lines.js's own aiUrl already uses for its תמ"א
 * 70 explainer link. */
const googleSearch = (query) => `https://www.google.com/search?q=${encodeURIComponent(query)}`;
const googleLink = (query, label) => `<a href="${esc(googleSearch(query))}" target="_blank" rel="noopener">${esc(label)} ↗</a>`;

function renderResult(displayName, { muni, basin }) {
  const box = el('acResult');
  const munLine = muni
    ? `<p><strong>לניקיון כללי</strong> (רחובות, מדרכות, פחי אשפה) — פנו למוקד העירוני של <strong>${esc(muni.Muni_Heb)}</strong> (${esc(muni.Sug_Muni)}).
       ${googleLink(`${muni.Muni_Heb} מוקד`, 'חיפוש המוקד העירוני')}</p>`
    : '<p><strong>לניקיון כללי</strong> — לא זוהתה רשות מקומית עבור נקודה זו (ייתכן ומחוץ לתחום שיפוט מוניציפלי, למשל שטח פתוח/מדינה).</p>';

  let riverLine;
  if (!basin) {
    riverLine = '<p><strong>לזיהום/פסולת בנחל או בתעלת ניקוז</strong> — לא זוהה אגן ניקוז עבור נקודה זו.</p>';
  } else {
    const authority = BASIN_TO_AUTHORITY[basin];
    riverLine = authority
      ? `<p><strong>לזיהום/פסולת בנחל או בתעלת ניקוז</strong> — האחראי/ת הוא/י <strong>${esc(authority)}</strong> (אגן ניקוז: ${esc(basin)}), לא העירייה.
         ${googleLink(`${authority} פרטי קשר`, 'חיפוש פרטי קשר')}</p>`
      : `<p><strong>לזיהום/פסולת בנחל או בתעלת ניקוז</strong> — נקודה זו נמצאת באגן ניקוז "${esc(basin)}", אך הרשות האחראית עבור אגן זה לא אומתה כאן. ראו את
         <a href="https://dsda.org.il/" target="_blank" rel="noopener">רשימת רשויות הניקוז הארציות ↗</a> לזיהוי הרשות הרלוונטית,
         או ${googleLink(`רשות ניקוז ${basin}`, 'חיפוש לפי שם האגן')}.</p>`;
  }

  box.innerHTML = `
    <p class="acc-hint">מיקום: ${esc(displayName)}</p>
    ${munLine}
    ${riverLine}
    <p class="acc-hint">
      זיהוי הרשות מבוסס על גבולות שיפוט/אגני ניקוז פומביים (GovMap) - בדקו מול הרשות עצמה לפני פנייה אם יש ספק.
    </p>`;
  box.hidden = false;
}

// Holds what the last successful lookup found - only what copyResult() needs
// to build its text (lat/lon/timestamp), not a full re-derivation of the
// render above it.
const state = { lat: null, lon: null, displayName: '' };

/** Draws the OSM basemap (±MAP_RADIUS around the point, MAP_SIZE px square)
 * with a pin at centre - same fetchBasemapCanvas/drawAddressPin blue-lines.js
 * uses, just a plain always-1km view here rather than a user-adjustable
 * radius, since this app's own question ("who do I call") doesn't need one. */
async function renderMap(itmX, itmY) {
  const canvasWrap = el('acMapWrap');
  canvasWrap.hidden = false;
  const bbox = bboxAround(itmX, itmY, MAP_RADIUS);
  const basemap = await fetchBasemapCanvas(bbox, MAP_SIZE);
  const canvas = el('acCanvas');
  canvas.width = MAP_SIZE;
  canvas.height = MAP_SIZE;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(basemap, 0, 0);
  drawAddressPin(ctx, MAP_SIZE);
  el('acCopy').disabled = false;
}

async function runFor(lon, lat, displayName) {
  const status = el('acStatus');
  el('acResult').hidden = true;
  el('acMapWrap').hidden = true;
  el('acCopy').disabled = true;
  showLoading(status, 'בודק אחריות...');
  const result = await lookup(lon, lat);
  status.innerHTML = '';
  state.lat = lat;
  state.lon = lon;
  state.displayName = displayName;
  renderResult(displayName, result);
  showLoading(status, 'טוען מפה...');
  await renderMap(result.itmX, result.itmY);
  status.innerHTML = '';
}

async function runAddress(address) {
  showLoading(el('acStatus'), `מאתר כתובת: ${address}…`);
  const geo = await geocode(address);
  await runFor(geo.lon, geo.lat, geo.displayName);
}

async function runMyLocation() {
  showLoading(el('acStatus'), 'מבקש מיקום מהדפדפן…');
  const geo = await getBrowserLocation();
  await runFor(geo.lon, geo.lat, `${geo.lat.toFixed(5)}, ${geo.lon.toFixed(5)}`);
}

/** Copies BOTH the map image and the location/timestamp text in one action,
 * as two representations of the same ClipboardItem - not two separate
 * copies. Pasting into an image target (WhatsApp, an email body, an image
 * field) gets the map; pasting into a plain text field gets the
 * coordinates/timestamp instead - whichever the paste target actually
 * accepts, without the user having to choose which to copy first. */
async function copyResult() {
  if (state.lat == null) return;
  const btn = el('acCopy');
  const prevLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'מעתיק…';
  try {
    const canvas = el('acCanvas');
    const pngBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    const text = `מיקום: ${state.displayName}\n`
      + `קואורדינטות: ${state.lat.toFixed(6)}, ${state.lon.toFixed(6)}\n`
      + `נבדק בתאריך: ${new Date().toLocaleString('he-IL')}`;
    await navigator.clipboard.write([
      new ClipboardItem({ 'image/png': pngBlob, 'text/plain': new Blob([text], { type: 'text/plain' }) }),
    ]);
    btn.textContent = 'הועתק ✓';
    setTimeout(() => { btn.textContent = prevLabel; btn.disabled = false; }, 2000);
  } catch (err) {
    showError(el('acStatus'), err);
    btn.textContent = prevLabel;
    btn.disabled = false;
  }
}

function start() {
  initThemePicker(el('themePick'));
  el('created').textContent = document.lastModified;

  const urlAddress = param('address');
  if (urlAddress) el('acAddress').value = urlAddress;

  el('acForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const address = el('acAddress').value.trim();
    if (!address) return;
    history.replaceState(null, '', `?${new URLSearchParams({ address })}`);
    runAddress(address).catch((err) => showError(el('acStatus'), err));
  });

  el('acMyLocation').addEventListener('click', () => {
    runMyLocation().catch((err) => showError(el('acStatus'), err));
  });

  el('acCopy').addEventListener('click', () => {
    copyResult().catch((err) => showError(el('acStatus'), err));
  });

  if (urlAddress) runAddress(urlAddress).catch((err) => showError(el('acStatus'), err));
}

start();
