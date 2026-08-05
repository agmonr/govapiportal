/**
 * Entry point for arnona-compare.html - מחשבון ארנונה.
 *
 * Data source: src/arnona-rates-data.js (generated from tools/arnona_rates.json
 * - see that file's own header for how to regenerate), hand-transcribed from
 * each city's צו ארנונה PDF (see tools/arnona_fetch.py / arnona_rates.json's
 * own _meta block for how and with what caveats). Not a government API -
 * there is no live arnona-rate API, this is manually curated from PDF text.
 * Imported as a JS module rather than fetched at runtime so this page also
 * works as a self-contained dist/ bundle opened from disk.
 *
 * Address input only resolves a CITY (via Nominatim, same pattern as
 * src/area-cleanup.js's geocode()) - it does NOT resolve which zone within
 * that city the address falls in, because no city publishes its zone
 * boundaries as geodata (only as a map image inside the PDF). The zone/
 * building-type is picked manually from a dropdown once the city is known.
 *
 * Calculator engine: one function per `rate_model` (see arnona_rates.json's
 * _meta.rate_models for what each shape means) - this mirrors the exact
 * by-hand math already verified against the PDFs earlier in this project
 * (marginal ladders, flat-per-bracket, zone×type grids, etc.), not a generic
 * formula, because the underlying cities genuinely use different formulas.
 *
 * Discount application is a simplification worth stating plainly: for
 * marginal/bracket cities, the "effective average ₪/m²" (annual total ÷
 * size) is used as the per-m² rate for the discounted portion, rather than
 * re-deriving which specific bracket-slice the discount's own m² cap lands
 * in. Good enough for a stage-1 comparison; not a substitute for an actual
 * bill.
 */

import { el, esc, num } from './ui.js';
import { initThemePicker } from './theme.js';
import { renderHBarChart } from './charts.js';
import { renderAppContext, loadAppsData } from './apps.js';
import { ARNONA_DATA } from './arnona-rates-data.js';

initThemePicker(el('themePick'));
loadAppsData().then((data) => renderAppContext(el('appContext'), data.apps, 'arnona-compare')).catch(() => {});

const created = new Date(document.lastModified);
if (!Number.isNaN(created.getTime())) {
  el('created').textContent = `נוצר: ${created.toLocaleDateString('he-IL')} ${created.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}`;
  el('created').title = created.toISOString();
}

const NOMINATIM = 'https://nominatim.openstreetmap.org';

function fetchJson(url, opts) {
  return fetch(url, opts).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
}

/* ---------- calculator engine ---------- */

function sumMarginal(brackets, size) {
  let total = 0;
  let prev = 0;
  for (const b of brackets) {
    const upTo = b.up_to == null ? size : b.up_to;
    if (size <= prev) break;
    const slice = Math.min(size, upTo) - prev;
    if (slice > 0 && b.rate != null) total += slice * b.rate;
    prev = upTo;
    if (size <= upTo) break;
  }
  return total;
}

function flatBracketRate(brackets, size) {
  for (const b of brackets) {
    if (b.up_to == null || size <= b.up_to) return b.rate;
  }
  return brackets[brackets.length - 1]?.rate ?? null;
}

/** One entry point for every rate_model shape. `sel`: { zoneId, typeId,
 * isVilla }. Returns { total, perSqm, explain } or null if the model/
 * selection can't compute (e.g. unavailable city, or a zone/type wasn't
 * picked yet). */
function computeAnnualTotal(city, sel, size) {
  if (!size || size <= 0) return null;
  switch (city.rate_model) {
    case 'marginal_no_zone': {
      const total = sumMarginal(city.brackets, size);
      return { total, perSqm: total / size };
    }
    case 'flat_bracket_no_zone': {
      const rate = flatBracketRate(city.brackets, size);
      if (rate == null) return null;
      return { total: rate * size, perSqm: rate };
    }
    case 'marginal_by_zone':
    case 'flat_bracket_by_zone': {
      const zone = city.zones.find((z) => z.id === sel.zoneId) || city.zones.find((z) => z.is_default);
      if (!zone) return null;
      if (zone.size_brackets) { // Holon-style: per-bracket base+marginal split
        const b = zone.size_brackets.find((sb) => size <= (sb.range[1] ?? Infinity)) || zone.size_brackets[zone.size_brackets.length - 1];
        let total;
        if (b.flat_rate != null) total = b.flat_rate * size;
        else total = b.base_up_to * b.base_rate + (size - b.base_up_to) * b.marginal_rate;
        return { total, perSqm: total / size };
      }
      const total = city.rate_model === 'marginal_by_zone' ? sumMarginal(zone.brackets, size) : flatBracketRate(zone.brackets, size) * size;
      return { total, perSqm: total / size };
    }
    case 'flat_by_zone_type': {
      const zone = city.zones.find((z) => z.id === sel.zoneId) || city.zones.find((z) => z.is_default);
      const typeId = sel.typeId || Object.keys(zone?.types || {})[0];
      const rate = zone?.types?.[typeId];
      if (rate == null) return null;
      return { total: rate * size, perSqm: rate };
    }
    case 'flat_by_type_no_zone': {
      const t = city.building_types.find((bt) => bt.id === sel.typeId) || city.building_types[city.building_types.length - 1];
      if (!t) return null;
      return { total: t.rate * size, perSqm: t.rate };
    }
    case 'zone_type_size_villa_grid': {
      const zone = city.zones.find((z) => z.id === sel.zoneId) || city.zones.find((z) => z.is_default);
      // Tel Aviv's own building_types[] lists individual year-bands (א/ב/ג/ד/ה),
      // but its rate table (zones[].rates) only prices ב+ג and ה+ו as combined
      // rows (see arnona_rates.json's tel-aviv.rate_table_note) - a dropdown
      // built straight off building_types would otherwise offer 'ב'/'ג'/'ה'
      // values that don't exist as rates-object keys and silently fail.
      const TYPE_ALIAS = { 'ב': 'ב_ג', 'ג': 'ב_ג', 'ה': 'ה_ו', 'ו': 'ה_ו' };
      const typeId = TYPE_ALIAS[sel.typeId] || sel.typeId || 'ב_ג';
      const rates = zone?.rates?.[typeId];
      if (!rates) return null;
      let rate;
      if (rates.apt_flat != null) rate = rates.apt_flat;
      else if (sel.isVilla && size > 140) rate = rates.villa_gt140 ?? rates.villa_or_apt_gt140;
      else if (!sel.isVilla && size <= 140) rate = rates.apt_le140;
      else rate = rates.villa_or_apt_gt140 ?? rates.villa_gt140 ?? rates.apt_le140; // large non-villa apartment: closest available rate, not a distinct source column
      if (rate == null) return null;
      return { total: rate * size, perSqm: rate };
    }
    default:
      return null;
  }
}

/** Simplified discount application - see module docstring. `discount`:
 * one entry from a city's `discounts[]`. Returns the reduced total, or the
 * original total unchanged if the discount's percent isn't a number
 * (e.g. "per table"/"discretionary" - we know it exists but not by how
 * much, so we don't guess). */
function applyDiscount(baseResult, discount, size) {
  if (typeof discount.percent !== 'number') return { ...baseResult, note: 'הנחה קיימת, אך האחוז לא צוין במפורש בצו (למשל טבלה מדורגת) - לא חושב' };
  const cappedArea = discount.cap_m2 ? Math.min(size, discount.cap_m2) : size;
  const reduction = baseResult.perSqm * cappedArea * (discount.percent / 100);
  return { total: Math.max(0, baseResult.total - reduction), perSqm: baseResult.perSqm, reduction };
}

/* ---------- state ---------- */

let RATES = null; // loaded arnona_rates.json .cities
let CITY_IDS = [];

const state = {
  size: 100,
  mode: 'address', // 'address' | 'known'
  myCity: null, myZone: null, myType: null,
  knownRate: null,
  picks: [], // city ids compared against
  checkedDiscounts: new Set(),
};

function usableCities() {
  return CITY_IDS.filter((id) => RATES[id].rate_model && RATES[id].rate_model !== 'unavailable');
}

/* ---------- geocoding (city only - see module docstring) ---------- */

async function geocodeToCity(address) {
  const params = new URLSearchParams({ q: address, format: 'jsonv2', limit: 1, countrycodes: 'il', addressdetails: 1 });
  const results = await fetchJson(`${NOMINATIM}/search?${params}`);
  if (!results.length) throw new Error(`לא נמצאה כתובת תואמת ל"${address}"`);
  const a = results[0].address || {};
  const cityRaw = a.city || a.town || a.village || a.municipality || '';
  // match against our roster by name_he, tolerating the same "-יפו"/space
  // and hyphen quirks documented in tools/arnona_authorities.py's own header.
  const norm = (s) => (s || '').replace(/\s*-\s*/g, '-').trim();
  const target = norm(cityRaw);
  const hit = usableCities().find((id) => norm(RATES[id].name_he) === target || target.includes(norm(RATES[id].name_he)) || norm(RATES[id].name_he).includes(target));
  if (!hit) throw new Error(`הכתובת זוהתה כ"${cityRaw || results[0].display_name}", שאינה ברשימת ${usableCities().length} הערים הזמינות כרגע`);
  return hit;
}

/* ---------- UI: my city/zone/type ---------- */

function populateCitySelect() {
  const sel = el('arCityPick');
  sel.innerHTML = '<option value="">— בחרו עיר —</option>' + usableCities()
    .map((id) => `<option value="${esc(id)}">${esc(RATES[id].name_he)}</option>`).join('');
}

function zoneOptionsFor(city) {
  if (city.zones) return city.zones.map((z) => ({ id: z.id, label: z.label }));
  return [];
}
function typeOptionsFor(city) {
  if (city.building_types && Array.isArray(city.building_types)) {
    return city.building_types.map((t) => ({ id: t.id, label: t.label || t.id }));
  }
  return [];
}

function renderMySelectors() {
  const cityId = el('arCityPick').value || null;
  state.myCity = cityId;
  const zoneRow = el('arZoneRow');
  const typeRow = el('arTypeRow');
  if (!cityId) { zoneRow.hidden = true; typeRow.hidden = true; renderMyResult(); return; }
  const city = RATES[cityId];

  const zones = zoneOptionsFor(city);
  if (zones.length) {
    zoneRow.hidden = false;
    el('arZoneLabel').textContent = city.rate_model === 'flat_by_type_no_zone' ? 'סוג בניין:' : 'אזור:';
    el('arZonePick').innerHTML = zones.map((z) => `<option value="${esc(z.id)}">${esc(z.label)}</option>`).join('');
    state.myZone = zones[0].id;
  } else { zoneRow.hidden = true; state.myZone = null; }

  if (city.rate_model === 'flat_by_type_no_zone') {
    // Givatayim: the "zone" dropdown above is actually building type, already handled
    typeRow.hidden = true;
  } else {
    const types = typeOptionsFor(city);
    if (types.length) {
      typeRow.hidden = false;
      el('arTypeLabel').textContent = 'סוג בניין:';
      el('arTypePick').innerHTML = types.map((t) => `<option value="${esc(t.id)}">${esc(t.label)}</option>`).join('');
      state.myType = types[0].id;
    } else { typeRow.hidden = true; state.myType = null; }
  }
  renderMyResult();
  renderCompare();
}

function myBaseResult() {
  if (state.mode === 'known') {
    if (state.knownRate == null || Number.isNaN(state.knownRate)) return null;
    return { total: state.knownRate * state.size, perSqm: state.knownRate };
  }
  if (!state.myCity) return null;
  const city = RATES[state.myCity];
  const sel = { zoneId: city.rate_model === 'flat_by_type_no_zone' ? null : state.myZone, typeId: city.rate_model === 'flat_by_type_no_zone' ? state.myZone : state.myType, isVilla: false };
  return computeAnnualTotal(city, sel, state.size);
}

function renderMyResult() {
  const out = el('arMyResult');
  const r = myBaseResult();
  if (!r) { out.textContent = state.mode === 'known' ? 'הזינו שיעור ידוע.' : 'בחרו עיר (וכתובת/אזור) כדי לחשב.'; return; }
  out.textContent = `לפי ${num(state.size)} מ"ר: כ-${num(Math.round(r.total))} ₪ לשנה (${r.perSqm.toFixed(2)} ₪ למ"ר).`;
}

/* ---------- compare picks (chip pattern, same idiom as real-estate-compare.js) ---------- */

const MAX_PICKS = 4;
const PICK_COLORS = ['var(--accent)', 'var(--danger)', 'var(--fin-compare, #999)', '#8a6dcf'];

function updateRosterOptions(query) {
  const q = (query || '').trim();
  const candidates = usableCities().filter((id) => id !== state.myCity && !state.picks.includes(id));
  const matches = q ? candidates.filter((id) => RATES[id].name_he.includes(q)) : candidates;
  el('arRoster').innerHTML = matches.slice(0, 30).map((id) => `<option value="${esc(RATES[id].name_he)}">`).join('');
}

function idByLabel(label) {
  return usableCities().find((id) => RATES[id].name_he === label);
}

function renderPickChips() {
  const chips = el('arPickChips');
  if (!state.picks.length) { chips.hidden = true; chips.innerHTML = ''; return; }
  chips.hidden = false;
  chips.innerHTML = state.picks.map((id, i) => `
    <span class="cm-chip" style="border-color:${PICK_COLORS[i]}">
      <span class="acc-legend-swatch" style="background:${PICK_COLORS[i]}"></span>
      <span dir="auto">${esc(RATES[id].name_he)}</span>
      <button type="button" class="cm-chip-remove" data-idx="${i}" aria-label="הסרה">✕</button>
    </span>`).join('');
  chips.querySelectorAll('.cm-chip-remove').forEach((btn) => {
    btn.addEventListener('click', () => { state.picks.splice(Number(btn.dataset.idx), 1); renderPickChips(); renderCompare(); });
  });
}

function commitPick() {
  const input = el('arPick');
  const label = input.value.trim();
  const id = idByLabel(label);
  if (id && state.picks.length < MAX_PICKS && !state.picks.includes(id) && id !== state.myCity) {
    state.picks.push(id);
    renderPickChips();
    renderCompare();
  }
  input.value = '';
  updateRosterOptions('');
}

/* ---------- discount checkboxes + cross-city gap notes ---------- */

function activeCityIds() {
  const me = state.mode === 'known' ? null : state.myCity;
  return [me, ...state.picks].filter(Boolean);
}

function unionDiscounts() {
  const map = new Map(); // id -> { label_he, citiesWith: [id] }
  for (const id of activeCityIds()) {
    for (const d of RATES[id].discounts || []) {
      if (!map.has(d.id)) map.set(d.id, { label_he: d.label_he, citiesWith: [] });
      map.get(d.id).citiesWith.push(id);
    }
  }
  return map;
}

function renderDiscountChecks() {
  const box = el('arDiscountChecks');
  const union = unionDiscounts();
  if (!union.size) { box.innerHTML = '<p class="acc-hint" dir="auto">בחרו עיר כדי לראות הנחות זמינות.</p>'; return; }
  const rows = [...union.entries()].sort((a, b) => a[1].label_he.localeCompare(b[1].label_he, 'he'));
  box.innerHTML = rows.map(([id, info]) => `
    <label class="cm-chip" style="cursor:pointer">
      <input type="checkbox" data-discount="${esc(id)}" ${state.checkedDiscounts.has(id) ? 'checked' : ''}>
      <span dir="auto">${esc(info.label_he)}</span>
    </label>`).join('');
  box.querySelectorAll('input[data-discount]').forEach((cb) => {
    cb.addEventListener('change', () => {
      if (cb.checked) state.checkedDiscounts.add(cb.dataset.discount);
      else state.checkedDiscounts.delete(cb.dataset.discount);
      renderCompare();
    });
  });
}

/* ---------- compare render ---------- */

function labelForCity(id) { return RATES[id].name_he; }

function resultForCity(id, isMe) {
  let base;
  if (isMe) base = myBaseResult();
  else {
    const city = RATES[id];
    const zones = zoneOptionsFor(city);
    const defaultZone = (city.zones || []).find((z) => z.is_default) || zones[0];
    const types = typeOptionsFor(city);
    const sel = { zoneId: city.rate_model === 'flat_by_type_no_zone' ? null : defaultZone?.id, typeId: city.rate_model === 'flat_by_type_no_zone' ? defaultZone?.id : types[0]?.id, isVilla: false };
    base = computeAnnualTotal(city, sel, state.size);
  }
  if (!base) return null;

  let result = base;
  const notes = [];
  // "Known rate" mode: the citizen typed their own number, not tied to any
  // specific city's discount rules - skip discount matching for "my" row
  // entirely rather than checking it against whatever city was last picked
  // in address mode (state.myCity is stale/irrelevant once mode is 'known').
  if (!(isMe && state.mode === 'known')) {
    const cityDiscounts = new Map((RATES[id]?.discounts || []).map((d) => [d.id, d]));
    for (const discId of state.checkedDiscounts) {
      if (cityDiscounts.has(discId)) {
        const applied = applyDiscount(result, cityDiscounts.get(discId), state.size);
        result = { ...result, total: applied.total };
        if (applied.note) notes.push(applied.note);
      } else {
        const union = unionDiscounts();
        const definedIn = (union.get(discId)?.citiesWith || []).filter((cid) => cid !== id).map((cid) => labelForCity(cid));
        notes.push(`הנחת "${union.get(discId)?.label_he || discId}" אינה מוגדרת עבור ${labelForCity(id)}${definedIn.length ? ` - קיימת רק עבור: ${definedIn.join(', ')}` : ''}`);
      }
    }
  }
  return { ...result, notes };
}

function renderCompare() {
  const entries = [];
  const details = [];

  const meLabel = state.mode === 'known' ? 'השיעור שלי' : (state.myCity ? labelForCity(state.myCity) : null);
  if (meLabel) {
    const r = resultForCity(state.myCity, true);
    if (r) {
      entries.push({ label: `${meLabel} (אני)`, value: Math.round(r.total), color: PICK_COLORS[0] });
      details.push(detailBlock(meLabel, r));
    }
  }
  state.picks.forEach((id, i) => {
    const r = resultForCity(id, false);
    if (r) {
      entries.push({ label: labelForCity(id), value: Math.round(r.total), color: PICK_COLORS[(meLabel ? 1 : 0) + i] || PICK_COLORS[i] });
      details.push(detailBlock(labelForCity(id), r));
    }
  });

  renderHBarChart('arCompareChart', `ארנונה שנתית משוערת - ${num(state.size)} מ"ר`, entries, '₪/שנה');
  el('arCompareDetails').innerHTML = details.join('');
  renderDiscountChecks();
}

function detailBlock(label, r) {
  const notesHtml = (r.notes || []).map((n) => `<li dir="auto">${esc(n)}</li>`).join('');
  return `
    <div class="notice info" dir="auto" style="margin-block-end:.75rem">
      <strong>${esc(label)}:</strong> ${num(Math.round(r.total))} ₪ לשנה
      ${notesHtml ? `<ul>${notesHtml}</ul>` : ''}
    </div>`;
}

/* ---------- wiring ---------- */

function setMode(mode) {
  state.mode = mode;
  el('arModePick').querySelectorAll('.tc-level-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  el('arAddressRow').hidden = mode !== 'address';
  el('arCityRow').hidden = mode !== 'address';
  el('arKnownRow').hidden = mode !== 'known';
  el('arZoneRow').hidden = mode !== 'address' || !zoneOptionsFor(RATES[state.myCity] || {}).length;
  el('arTypeRow').hidden = mode !== 'address' || !typeOptionsFor(RATES[state.myCity] || {}).length;
  renderMyResult();
  renderCompare();
}

async function init() {
  RATES = ARNONA_DATA.cities;
  CITY_IDS = Object.keys(RATES);
  el('arCityCount').textContent = String(usableCities().length);

  populateCitySelect();
  setMode('address');

  el('arSize').addEventListener('input', () => {
    const v = Number(el('arSize').value);
    state.size = v > 0 ? v : 100;
    renderMyResult();
    renderCompare();
  });

  el('arModePick').addEventListener('click', (e) => {
    const btn = e.target.closest('.tc-level-btn');
    if (btn) setMode(btn.dataset.mode);
  });

  el('arKnownRate').addEventListener('input', () => {
    state.knownRate = Number(el('arKnownRate').value);
    renderMyResult();
    renderCompare();
  });

  el('arGeocode').addEventListener('click', async () => {
    const status = el('arGeocodeStatus');
    const address = el('arAddress').value.trim();
    if (!address) return;
    status.textContent = 'מאתר…';
    try {
      const cityId = await geocodeToCity(address);
      el('arCityPick').value = cityId;
      renderMySelectors();
      status.textContent = `זוהתה: ${RATES[cityId].name_he}`;
    } catch (err) {
      status.textContent = err.message;
    }
  });

  el('arCityPick').addEventListener('change', renderMySelectors);
  el('arZonePick').addEventListener('change', () => { state.myZone = el('arZonePick').value; renderMyResult(); renderCompare(); });
  el('arTypePick').addEventListener('change', () => { state.myType = el('arTypePick').value; renderMyResult(); renderCompare(); });

  el('arPick').addEventListener('input', () => updateRosterOptions(el('arPick').value));
  el('arPick').addEventListener('change', commitPick);

  renderCompare();
}

init().catch((err) => {
  el('arMyResult').textContent = `שגיאה בטעינת הנתונים: ${err.message}`;
});
