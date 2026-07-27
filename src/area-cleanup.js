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

import { el, esc, debounce, showError, showLoading, param } from './ui.js';
import { initThemePicker } from './theme.js';
import { ITM_WKID, WGS84_WKID, projectPoints, bboxAround, fetchBasemapCanvas, drawAddressPin } from './geo-utils.js';
import { buildPdf, downloadBlob, safeFilename } from './pdf.js';
import { renderAppContext, loadAppsData } from './apps.js';
import { STREET_CANOPY } from './tree-canopy-streets.js';

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

/* ---------- address autocomplete - a suggestion list, not a constraint:
   #acAddress keeps <input list=...>'s normal free-text editing (adding a
   house number the roster itself doesn't carry, since it's a street/city
   directory, not a building-level one), same convention tree-canopy.html's
   own roster uses for its street level. Reuses that exact dataset
   (tree-canopy-streets.js's STREET_CANOPY, keyed "city::street") rather than
   building a separate one - the canopy numbers on each entry go unused
   here, but a second street/city directory generated independently would
   drift from this one over time in a way reusing the same source can't. ---- */

const ADDRESS_ROSTER = Object.entries(STREET_CANOPY).map(([key]) => {
  const [city, name] = key.split('::');
  return { name, city, label: `${name}, ${city}` };
});

/** Same ranking as tree-canopy.js's own candidateEntries(): a street-NAME
 * match ranks before a match that only hits because the city name happens
 * to contain the query (e.g. "הרצל" as a street vs. as a substring of
 * "הרצליה") - both stay available, just ordered so the likely intent wins
 * the top-40 slice a <datalist> can usefully show at once. */
function addressCandidates(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const nameHits = [];
  const otherHits = [];
  for (const e of ADDRESS_ROSTER) {
    if (e.name.toLowerCase().includes(q)) nameHits.push(e);
    else if (e.label.toLowerCase().includes(q)) otherHits.push(e);
  }
  return [...nameHits, ...otherHits].slice(0, 40);
}

function updateAddressRoster(query) {
  el('acRoster').innerHTML = addressCandidates(query).map((e) => `<option value="${esc(e.label)}">`).join('');
}

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

// Holds what the last successful lookup found - lat/lon/timestamp for
// copyResult()'s text, `result` (muni/basin) so downloadPdf() can render the
// same responsibility text again without re-querying, and `photos` (the
// attached-image objects, see addPhotos below).
const state = {
  lat: null, lon: null, displayName: '', result: null, photos: [],
};

/* ---------- attached photos - shown on screen, and each turned into its own
   page in the PDF (see downloadPdf) ---------- */

/** Re-draws the thumbnail strip from state.photos - called after every add
 * or remove, never patched incrementally, since the list is short (a few
 * photos of one problem spot, not a gallery) and a full re-render keeps the
 * index-based remove button below trivially correct. */
function renderPhotoThumbs() {
  const box = el('acPhotoThumbs');
  box.innerHTML = state.photos.map((p, i) => `
    <span class="ac-photo-thumb">
      <img src="${p.url}" alt="" dir="auto">
      <button type="button" class="ac-photo-remove" data-idx="${i}" aria-label="הסרת התמונה">✕</button>
    </span>`).join('');
  box.querySelectorAll('.ac-photo-remove').forEach((btn) => {
    btn.addEventListener('click', () => removePhoto(Number(btn.dataset.idx)));
  });
}

/** `files` straight from the file input's FileList - object URLs are cheap
 * (just a reference into the already-decoded file), revoked on removal/
 * clearPhotos below rather than left to pile up for the life of the page. */
function addPhotos(files) {
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue; // the input already filters via accept=, but a picker can still be overridden
    state.photos.push({ file, url: URL.createObjectURL(file) });
  }
  renderPhotoThumbs();
}

function removePhoto(idx) {
  const [removed] = state.photos.splice(idx, 1);
  if (removed) URL.revokeObjectURL(removed.url);
  renderPhotoThumbs();
}

function clearPhotos() {
  state.photos.forEach((p) => URL.revokeObjectURL(p.url));
  state.photos = [];
  renderPhotoThumbs();
}

/** A location/date caption baked directly into the image itself (a banner
 * strip at the top, not just a DOM label) - WhatsApp/Mail each decide for
 * themselves which clipboard representation to paste (image vs. text), so
 * there's no reliable way to guarantee the plain-text representation
 * (copyResult() below) tags along with the image every time. Baking the
 * location into the picture means whichever one a paste target picks, the
 * info that matters (where, when) is still readable in it. */
function drawLocationCaption(ctx, size, text) {
  ctx.save();
  // The canvas inherits the page's dir="rtl" as its own CSS 'direction',
  // which Canvas2D's default direction:"inherit" picks up too - left
  // unset, textAlign 'start' anchors at the RIGHT edge instead and the text
  // (measured/boxed as if LTR below) draws mostly off-canvas to the left.
  // Forcing both explicitly makes "draw left-to-right from x=pad" true
  // regardless of the page's own direction.
  ctx.direction = 'ltr';
  ctx.textAlign = 'left';
  ctx.font = 'bold 13px sans-serif';
  const pad = 6;
  const lineH = 16;
  const lines = text.split('\n');
  const tw = Math.max(...lines.map((l) => ctx.measureText(l).width));
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(0, 0, tw + pad * 2, lineH * lines.length + pad * 2);
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'top';
  lines.forEach((line, i) => ctx.fillText(line, pad, pad + i * lineH));
  ctx.restore();
}

/** Draws the OSM basemap (±MAP_RADIUS around the point, MAP_SIZE px square)
 * with a pin at centre - same fetchBasemapCanvas/drawAddressPin blue-lines.js
 * uses, just a plain always-1km view here rather than a user-adjustable
 * radius, since this app's own question ("who do I call") doesn't need one. */
async function renderMap(itmX, itmY, displayName) {
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
  drawLocationCaption(ctx, MAP_SIZE, `${displayName}\n${new Date().toLocaleString('he-IL')}`);
  el('acCopy').disabled = false;
  el('acShareMail').disabled = false;
  el('acShareWhatsapp').disabled = false;
  el('acDownloadPdf').disabled = false;
}

async function runFor(lon, lat, displayName) {
  const status = el('acStatus');
  el('acResult').hidden = true;
  el('acMapWrap').hidden = true;
  el('acCopy').disabled = true;
  el('acShareMail').disabled = true;
  el('acShareWhatsapp').disabled = true;
  el('acDownloadPdf').disabled = true;
  showLoading(status, 'בודק אחריות...');
  const result = await lookup(lon, lat);
  status.innerHTML = '';
  state.lat = lat;
  state.lon = lon;
  state.displayName = displayName;
  state.result = result;
  clearPhotos(); // a new location's PDF shouldn't drag along the previous spot's photos
  renderResult(displayName, result);
  showLoading(status, 'טוען מפה...');
  await renderMap(result.itmX, result.itmY, displayName);
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

/** The map PNG + its caption text, built fresh each time (canvas.toBlob is
 * cheap and the canvas may have re-rendered since the last export) - shared
 * by copyResult() and shareResult() below so both send the exact same
 * content out, just through a different channel. */
async function exportResult() {
  const canvas = el('acCanvas');
  const pngBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  const text = `${state.displayName}\nנבדק בתאריך: ${new Date().toLocaleString('he-IL')}`;
  return { pngBlob, text };
}

/** Copies BOTH the map image and the location/timestamp text in one action,
 * as two representations of the same ClipboardItem - not two separate
 * copies. Pasting into an image target (WhatsApp, an email body, an image
 * field) gets the map; pasting into a plain text field gets the location/
 * timestamp text instead - whichever the paste target actually accepts,
 * without the user having to choose which to copy first. The map image
 * itself also carries this same text baked in (drawLocationCaption in
 * renderMap), since WhatsApp/Mail each pick their own representation and
 * there's no way to force both to show up in a single paste - so an
 * image-only paste still isn't missing the location/date. */
async function copyResult() {
  if (state.lat == null) return;
  const btn = el('acCopy');
  const prevLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'מעתיק…';
  try {
    const { pngBlob, text } = await exportResult();
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

/** Same PNG+text pair as exportResult(), but built with ZERO `await` before
 * returning - via canvas.toDataURL() (synchronous) instead of toBlob() (a
 * promise). shareToMail()/shareToWhatsApp() below need this: the Clipboard
 * API only grants clipboard-write access to a focused document, and
 * window.open() (called right after, to open Gmail/WhatsApp) shifts focus
 * to the new tab - so navigator.clipboard.write() has to already be KICKED
 * OFF, synchronously, before window.open() runs, or it silently never
 * resolves once focus has moved on. */
function exportResultSync() {
  const canvas = el('acCanvas');
  const dataUrl = canvas.toDataURL('image/png');
  const byteString = atob(dataUrl.split(',')[1]);
  const bytes = new Uint8Array(byteString.length);
  for (let i = 0; i < byteString.length; i += 1) bytes[i] = byteString.charCodeAt(i);
  const pngBlob = new Blob([bytes], { type: 'image/png' });
  const text = `${state.displayName}\nנבדק בתאריך: ${new Date().toLocaleString('he-IL')}`;
  return { pngBlob, text };
}

/** Starts copying the map image + caption text to the clipboard - same
 * pairing as copyResult() - and returns the still-pending promise WITHOUT
 * awaiting it, so the caller (shareToMail/shareToWhatsApp) can call
 * window.open() immediately after, synchronously, rather than losing the
 * click's "this is a direct user action" status to an async gap (the exact
 * bug that made the mail button silently do nothing before this fix).
 * A courtesy, not a guarantee: Gmail/WhatsApp's own compose links can't
 * accept a file via the URL at all (mailto: and wa.me only ever carry a
 * subject/body STRING), so the actual attach still needs one manual paste
 * (Ctrl+V) once the compose window/chat is open - both accept a pasted
 * image directly. */
function startCopyImageForPasting(pngBlob, text) {
  return navigator.clipboard.write([
    new ClipboardItem({ 'image/png': pngBlob, 'text/plain': new Blob([text], { type: 'text/plain' }) }),
  ]).then(() => true).catch(() => false);
}

/** On Android/iPhone with a real mail app installed, navigator.share() with
 * files opens the OS's native share sheet - the user picks Mail/Gmail/
 * Outlook/whatever's installed, and the image goes along as a REAL
 * attachment, no manual paste needed; tried first for exactly that reason.
 * Falls back to Gmail's web compose (not a plain mailto:, which only works
 * if a default mail handler happens to be registered - a lot of desktop
 * users who read mail through a browser tab simply don't have one, and
 * clicking it then does nothing whatsoever, no error) when file-sharing
 * isn't available at all - opening a literal browser tab rather than an
 * app is an inherent limitation of that fallback, not something a web page
 * can route around; it's what "no native share support" actually means.
 * In the fallback, the map image is separately copied to the clipboard for
 * a one-paste attach into the compose body.
 *
 * Every branch builds the PNG synchronously (exportResultSync) and calls
 * share()/clipboard.write()/window.open() with zero `await` first - see
 * those two helpers' own comments for why (user-activation, clipboard
 * focus). Only the eventual status-text update is actually asynchronous. */
function shareToMail() {
  if (state.lat == null) return;
  const { pngBlob, text } = exportResultSync();
  const file = new File([pngBlob], 'map-location.png', { type: 'image/png' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    // files ALONE, no text/title alongside it - some share targets (WhatsApp
    // confirmed) silently keep only the text and drop the image when both
    // are handed to navigator.share() together. The location/date is
    // already baked into the image itself (drawLocationCaption), so nothing
    // is actually lost by not passing it here too.
    navigator.share({ files: [file] })
      .catch((err) => { if (err.name !== 'AbortError') showError(el('acStatus'), err); }); // AbortError: the user closed the share sheet - not a failure
    return;
  }
  downloadBlob(pngBlob, 'map-location.png');
  const copyPromise = startCopyImageForPasting(pngBlob, text);
  const params = new URLSearchParams({ view: 'cm', fs: '1', su: 'מי אחראי על ניקיון האזור?', body: text });
  window.open(`https://mail.google.com/mail/?${params}`, '_blank', 'noopener');
  copyPromise.then((copied) => {
    el('acStatus').textContent = `נפתח Gmail; תמונת המפה גם הורדה למכשיר (map-location.png)${copied ? ' וגם הועתקה - הדביקו (Ctrl+V) בגוף ההודעה' : ''} - צרפו אותה ידנית להודעה.`;
  });
}

/** WhatsApp specifically registers as a share TARGET for the OS's native
 * share sheet (files included) on Android/iOS - unlike Gmail, there's a real
 * "actually attaches the file, zero manual steps" path here when
 * navigator.share() with files is supported, so it's tried first. wa.me (the
 * fallback below) is a plain web link with no file-carrying capability at
 * all - on a desktop browser without file-sharing support (this file's own
 * canShare check fails), that fallback is all that's left, hence the
 * copy-then-paste courtesy same as shareToMail(). Both branches build the
 * PNG synchronously (exportResultSync) and call share()/clipboard.write()
 * with zero `await` first, for the same user-activation/focus reasons
 * documented on those two helpers. */
function shareToWhatsApp() {
  if (state.lat == null) return;
  const { pngBlob, text } = exportResultSync();
  const file = new File([pngBlob], 'map-location.png', { type: 'image/png' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    // files ALONE - see shareToMail()'s identical comment: WhatsApp's own
    // share-target handler has been observed to keep only the text and
    // drop the image when navigator.share() is called with both at once.
    navigator.share({ files: [file] })
      .catch((err) => { if (err.name !== 'AbortError') showError(el('acStatus'), err); }); // AbortError: the user closed the share sheet - not a failure
    return;
  }
  downloadBlob(pngBlob, 'map-location.png');
  const copyPromise = startCopyImageForPasting(pngBlob, text);
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
  copyPromise.then((copied) => {
    el('acStatus').textContent = `נפתח וואטסאפ; תמונת המפה גם הורדה למכשיר (map-location.png)${copied ? ' וגם הועתקה - הדביקו (Ctrl+V) בשיחה' : ''} - צרפו אותה ידנית (לחצו על סיכת הנייר 📎 בוואטסאפ).`;
  });
}

/** The PDF's own image: the map canvas (already carrying the pin + baked-in
 * location/date caption) plus an extra footer strip with three clickable-
 * looking buttons drawn directly into the picture - a PDF has no DOM, so
 * "a button" here just means "a coloured rect + label, with a matching Link
 * annotation rect handed to buildPdf() at the same pixel coordinates".
 * Returns the composited canvas plus each button's own rect, in that same
 * top-down pixel space buildPdf() expects. */
function buildDownloadCanvas() {
  const mapCanvas = el('acCanvas');
  const footerH = 80;
  const canvas = document.createElement('canvas');
  canvas.width = MAP_SIZE;
  canvas.height = MAP_SIZE + footerH;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(mapCanvas, 0, 0);

  const gap = 10;
  const btnW = (MAP_SIZE - gap * 4) / 3;
  const btnH = 50;
  const y0 = MAP_SIZE + (footerH - btnH) / 2;
  const labels = ['📍 מפה ב-OpenStreetMap', '💬 וואטסאפ', '📧 מייל'];
  ctx.direction = 'ltr';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 13px sans-serif';
  const rects = labels.map((label, i) => {
    const x0 = gap + i * (btnW + gap);
    ctx.fillStyle = '#2e7d46';
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x0, y0, btnW, btnH, 8); ctx.fill(); } else { ctx.fillRect(x0, y0, btnW, btnH); }
    ctx.fillStyle = '#fff';
    ctx.fillText(label, x0 + btnW / 2, y0 + btnH / 2, btnW - 10);
    return { x0, y0, x1: x0 + btnW, y1: y0 + btnH };
  });
  return { canvas, rects };
}

function canvasToJpegBytes(canvas, quality = 0.9) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
    .then((blob) => blob.arrayBuffer())
    .then((buf) => new Uint8Array(buf));
}

/** Plain-text version of renderResult()'s two paragraphs (muni + basin), for
 * the PDF's own data page below - no HTML/links there (a canvas can't draw
 * a clickable <a>, and this page isn't meant to duplicate the footer
 * buttons' own live links anyway), just the same finding in the same words.
 * Reads off state.result directly rather than re-querying, so the PDF always
 * matches whatever's currently on screen. */
function resultLines() {
  const { muni, basin } = state.result;
  const lines = [
    `מיקום: ${state.displayName}`,
    `קואורדינטות (WGS84): ${state.lat.toFixed(6)}, ${state.lon.toFixed(6)}`,
    `נבדק בתאריך: ${new Date().toLocaleString('he-IL')}`,
    '',
  ];
  lines.push(muni
    ? `לניקיון כללי (רחובות, מדרכות, פחי אשפה) - פנו למוקד העירוני של ${muni.Muni_Heb} (${muni.Sug_Muni}).`
    : 'לניקיון כללי - לא זוהתה רשות מקומית עבור נקודה זו (ייתכן ומחוץ לתחום שיפוט מוניציפלי, למשל שטח פתוח/מדינה).');
  lines.push('');
  if (!basin) {
    lines.push('לזיהום/פסולת בנחל או בתעלת ניקוז - לא זוהה אגן ניקוז עבור נקודה זו.');
  } else {
    const authority = BASIN_TO_AUTHORITY[basin];
    lines.push(authority
      ? `לזיהום/פסולת בנחל או בתעלת ניקוז - האחראי/ת הוא/י ${authority} (אגן ניקוז: ${basin}), לא העירייה.`
      : `לזיהום/פסולת בנחל או בתעלת ניקוז - נקודה זו נמצאת באגן ניקוז "${basin}", אך הרשות האחראית עבור אגן זה לא אומתה כאן. ראו dsda.org.il לזיהוי הרשות הרלוונטית.`);
  }
  lines.push('', 'זיהוי הרשות מבוסס על גבולות שיפוט/אגני ניקוז פומביים (GovMap) - בדקו מול הרשות עצמה לפני פנייה אם יש ספק.');
  return lines;
}

/** Greedy word-wrap to `maxWidth` in `ctx`'s current font - plain space-
 * splitting works regardless of RTL/LTR (Hebrew words are space-separated
 * same as any other script here); the caller draws each returned line
 * right-aligned, so wrapping itself only needs to know where to BREAK, not
 * which direction to draw in. */
function wrapText(ctx, text, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(test).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** The PDF's plain-text "everything found" page - address, coordinates,
 * timestamp and both responsibility paragraphs (see resultLines above) -
 * added because the map+links page alone doesn't carry the actual finding
 * in words anyone could read without opening the site again. A canvas page
 * (like every other page here), not real PDF text objects: this hand-rolled
 * writer has no font embedding, and Hebrew text needs one - a canvas already
 * renders it correctly via the browser's own font stack, same trick
 * drawLocationCaption uses for the map's baked-in caption. */
function buildDataPageCanvas() {
  const width = MAP_SIZE;
  const pad = 28;
  const lineH = 24;
  const titleH = 44;
  const measurer = document.createElement('canvas').getContext('2d');
  measurer.font = '15px sans-serif';
  const wrapped = resultLines().flatMap((line) => (line === '' ? [''] : wrapText(measurer, line, width - pad * 2)));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = titleH + pad * 2 + wrapped.length * lineH;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.direction = 'rtl';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#1b5e34';
  ctx.font = 'bold 19px sans-serif';
  ctx.fillText('מי אחראי על ניקיון האזור? — פרטים מלאים', width - pad, pad);
  ctx.font = '15px sans-serif';
  ctx.fillStyle = '#24331f';
  let y = pad + titleH;
  for (const line of wrapped) {
    ctx.fillText(line, width - pad, y);
    y += lineH;
  }
  return canvas;
}

/** One attached photo -> one PDF page - downscaled to PHOTO_MAX_DIM on its
 * long side (a phone camera photo straight off the sensor can be 10+MB at
 * 4000px+; nothing here needs print resolution) via a plain <img> element
 * rather than createImageBitmap, since an <img>'s decode already applies the
 * file's own EXIF orientation - drawing it onto a canvas bakes that
 * orientation in as real pixels, so the PDF page (which has no EXIF concept
 * of its own) still comes out right-side up. */
const PHOTO_MAX_DIM = 1600;
async function photoToPage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, PHOTO_MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight));
    const width = Math.round(img.naturalWidth * scale);
    const height = Math.round(img.naturalHeight * scale);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(img, 0, 0, width, height);
    const jpegBytes = await canvasToJpegBytes(canvas, 0.85);
    return { jpegBytes, width, height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Builds a multi-page PDF and downloads it: page 1 is the map image (pin +
 * baked-in location/date) with three live links drawn as buttons in a footer
 * strip - an OpenStreetMap permalink centred on the checked point, and the
 * same WhatsApp/mail targets the two share buttons use; page 2 is the plain-
 * text finding (buildDataPageCanvas); pages 3+ are each attached photo,
 * unchanged order. A PDF has no script/clipboard access of its own, so
 * unlike the on-page share buttons there's no copy-image-for-pasting
 * courtesy possible here; the mail link is a plain mailto: (not the Gmail-
 * web fallback shareToMail() uses) since a PDF is as likely to be opened
 * outside a browser entirely (a phone's own PDF viewer, a printed page's QR
 * code, etc.), where the OS's own mailto: handler is the more universal
 * choice, not a browser default-handler gap. */
async function downloadPdf() {
  if (state.lat == null) return;
  const btn = el('acDownloadPdf');
  const prevLabel = btn.textContent;
  btn.disabled = true;
  try {
    btn.textContent = 'בונה PDF…';
    const { canvas: mapCanvas, rects } = buildDownloadCanvas();
    const mapJpegBytes = await canvasToJpegBytes(mapCanvas);
    const text = `${state.displayName}\nנבדק בתאריך: ${new Date().toLocaleString('he-IL')}`;
    const osmUrl = `https://www.openstreetmap.org/?mlat=${state.lat}&mlon=${state.lon}#map=17/${state.lat}/${state.lon}`;
    const waUrl = `https://wa.me/?text=${encodeURIComponent(text)}`;
    const mailParams = new URLSearchParams({ subject: 'מי אחראי על ניקיון האזור?', body: text });
    const mailUrl = `mailto:?${mailParams}`.replace(/\+/g, '%20');
    const links = [
      { url: osmUrl, ...rects[0] },
      { url: waUrl, ...rects[1] },
      { url: mailUrl, ...rects[2] },
    ];
    const mapPage = { jpegBytes: mapJpegBytes, width: mapCanvas.width, height: mapCanvas.height, links };

    const dataCanvas = buildDataPageCanvas();
    const dataPage = { jpegBytes: await canvasToJpegBytes(dataCanvas), width: dataCanvas.width, height: dataCanvas.height };

    const pages = [mapPage, dataPage];
    for (let i = 0; i < state.photos.length; i += 1) {
      btn.textContent = `בונה PDF… (תמונה ${i + 1}/${state.photos.length})`;
      pages.push(await photoToPage(state.photos[i].file));
    }

    const pdfBlob = buildPdf({ pages });
    downloadBlob(pdfBlob, `${safeFilename(state.displayName, 'area-cleanup')}.pdf`);
  } finally {
    btn.disabled = false;
    btn.textContent = prevLabel;
  }
}

function start() {
  initThemePicker(el('themePick'));
  loadAppsData().then((data) => renderAppContext(el('appContext'), data.apps, 'area-cleanup')).catch(() => {});
  el('created').textContent = document.lastModified;

  const urlAddress = param('address');
  if (urlAddress) el('acAddress').value = urlAddress;

  el('acAddress').addEventListener('input', debounce(() => updateAddressRoster(el('acAddress').value), 120));

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

  el('acShareMail').addEventListener('click', () => {
    try { shareToMail(); } catch (err) { showError(el('acStatus'), err); }
  });

  el('acShareWhatsapp').addEventListener('click', () => {
    try { shareToWhatsApp(); } catch (err) { showError(el('acStatus'), err); }
  });

  el('acDownloadPdf').addEventListener('click', () => {
    downloadPdf().catch((err) => showError(el('acStatus'), err));
  });

  el('acAddPhoto').addEventListener('click', () => el('acPhotoInput').click());
  el('acPhotoInput').addEventListener('change', (e) => {
    addPhotos(e.target.files);
    e.target.value = ''; // so picking the exact same file again still fires 'change'
  });

  if (urlAddress) runAddress(urlAddress).catch((err) => showError(el('acStatus'), err));
}

start();
