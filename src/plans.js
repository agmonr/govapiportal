/**
 * Address -> parcel -> plan.
 *
 * Two entry points feed one chain. The address path goes through a geocoder and
 * is therefore fallible; the גוש/חלקה path is exact. The UI has to make which
 * one you got obvious, because a confidently wrong parcel would send someone to
 * the wrong plan entirely.
 */

import { el, esc, showError, showLoading } from './ui.js';
import { geocode, parcelAt, parcelByGush, plansAt, GeoError } from './geo.js';

const parcelCard = el('parcel-card');
const out = el('out');

/* ---------- tabs ---------- */

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('[data-panel]').forEach((p) => {
      p.hidden = p.dataset.panel !== tab.dataset.mode;
    });
    clear();
  });
});

function clear() {
  parcelCard.innerHTML = '';
  out.innerHTML = '';
}

/* ---------- rendering ---------- */

/**
 * `provisional` means the parcel came from a geocoded address rather than an
 * exact גוש/חלקה. Never render the two the same way.
 */
function parcelPanel(parcel, { provisional, geoLabel } = {}) {
  return `
    <article class="card parcel${provisional ? ' provisional' : ''}">
      <div class="api-head">
        <h3 dir="auto">גוש ${esc(parcel.gush)} · חלקה ${esc(parcel.parcel)}</h3>
        <span class="badge ${provisional ? 'warn' : 'ok'}">${provisional ? 'זיהוי משוער' : 'זיהוי מדויק'}</span>
      </div>
      <div class="meta">
        <span class="tag" dir="auto">${esc(parcel.locality || '—')}</span>
        <span class="tag">${parcel.area ? Number(parcel.area).toLocaleString('he-IL') + ' מ״ר' : '—'}</span>
        <span class="tag" dir="auto">${esc(parcel.status || '—')}</span>
      </div>
      ${provisional ? `
        <p class="warnnote" dir="auto">
          הכתובת אותרה דרך OpenStreetMap — מקור חיצוני, לא ממשלתי
          ${geoLabel ? `(<span dir="auto">${esc(geoLabel)}</span>)` : ''}.
          <strong>ודא שהגוש והחלקה נכונים</strong> לפני הסתמכות על התוצאה; אם לא — הזן גוש/חלקה ידנית.
        </p>` : ''}
    </article>`;
}

function planCard(plan) {
  const dunam = plan.dunam == null ? '—' : `${Number(plan.dunam).toLocaleString('he-IL', { maximumFractionDigits: 1 })} דונם`;
  const dates = [
    plan.published ? `פרסום ברשומות ${plan.published}` : null,
    plan.deposited ? `הפקדה ${plan.deposited}` : null,
  ].filter(Boolean).join(' · ');

  return `
    <article class="card plan${plan.national ? ' national' : ''}">
      <div class="api-head">
        <h3 dir="auto">${esc(plan.number)}</h3>
        <span class="badge ${plan.national ? 'unknown' : 'ok'}">${plan.national ? 'ארצית' : dunam}</span>
      </div>
      <p class="plan-name" dir="auto">${esc(plan.name)}</p>
      <div class="meta">
        ${plan.kind ? `<span class="tag" dir="auto">${esc(plan.kind)}</span>` : ''}
        ${plan.national ? `<span class="tag">${esc(dunam)}</span>` : ''}
        ${plan.committee ? `<span class="tag" dir="auto">ועדה: ${esc(plan.committee.slice(0, 40))}</span>` : ''}
      </div>
      ${plan.landuse ? `<p class="landuse" dir="auto" title="${esc(plan.landuse)}">ייעוד: ${esc(plan.landuse)}</p>` : ''}
      ${dates ? `<p class="dates" dir="auto">${esc(dates)}</p>` : ''}
      ${plan.url
        ? `<p><a class="doclink" href="${esc(plan.url)}" target="_blank" rel="noopener">מסמכי התכנית במבא״ת ↗</a></p>`
        : '<p class="dates">אין קישור למסמכים.</p>'}
    </article>`;
}

function renderPlans(plans) {
  if (!plans.length) {
    out.innerHTML = '<div class="notice info" dir="auto">לא נמצאו תכניות החלות על החלקה הזו.</div>';
    return;
  }
  const local = plans.filter((p) => !p.national);
  const national = plans.filter((p) => p.national);

  out.innerHTML = `
    <h2 class="section">תכניות החלות על החלקה (${plans.length})</h2>
    ${local.length ? `
      <p class="hint" dir="auto">
        מסודרות מהקטנה לגדולה — התכנית הרלוונטית לכתובת היא כמעט תמיד המפורטת ביותר.
      </p>
      ${local.map(planCard).join('')}` : ''}
    ${national.length ? `
      <h2 class="section">תכניות ארציות ומחוזיות (${national.length})</h2>
      <p class="hint" dir="auto">
        חלות על שטח נרחב וכוללות את החלקה, אך אינן מתארות את הבנייה בה.
      </p>
      ${national.map(planCard).join('')}` : ''}`;
}

/* ---------- the chain ---------- */

async function fromPoint(lon, lat, meta) {
  showLoading(parcelCard, 'מאתר גוש וחלקה…');
  const parcels = await parcelAt(lon, lat);
  if (!parcels.length) {
    parcelCard.innerHTML =
      '<div class="notice error" dir="auto">לא נמצאה חלקה בנקודה הזו. נסה כתובת מדויקת יותר, או הזן גוש/חלקה ידנית.</div>';
    return;
  }
  parcelCard.innerHTML = parcelPanel(parcels[0], meta);

  showLoading(out, 'מאתר תכניות…');
  renderPlans(await plansAt(lon, lat));
}

async function run(fn) {
  try {
    await fn();
  } catch (err) {
    // showError already phrases blocked / rate_limit / network usefully.
    showError(out, err instanceof GeoError ? err : new GeoError('network', err.message));
    parcelCard.innerHTML = '';
  }
}

async function byAddress(query) {
  clear();
  showLoading(parcelCard, 'מאתר את הכתובת…');

  const hits = await geocode(query);
  if (!hits.length) {
    parcelCard.innerHTML = `
      <div class="notice error" dir="auto">
        הכתובת <strong>${esc(query)}</strong> לא אותרה. שמות שכונות חדשות לרוב אינם מזוהים —
        נסה רחוב ומספר, או עבור ללשונית <strong>גוש / חלקה</strong>.
      </div>`;
    out.innerHTML = '';
    return;
  }
  const best = hits[0];
  await fromPoint(best.lon, best.lat, { provisional: true, geoLabel: best.label });
}

el('addr-go').addEventListener('click', () => run(() => byAddress(el('addr-in').value.trim())));

el('gush-go').addEventListener('click', () => run(async () => {
  const gush = el('gush-in').value.trim();
  const parcel = el('parcel-in').value.trim();
  if (!gush || !parcel) return;

  clear();
  showLoading(parcelCard, 'מאתר את החלקה…');
  const parcels = await parcelByGush(gush, parcel);
  if (!parcels.length) {
    parcelCard.innerHTML = `<div class="notice error" dir="auto">גוש ${esc(gush)} חלקה ${esc(parcel)} לא נמצאו.</div>`;
    return;
  }
  const p = parcels[0];
  parcelCard.innerHTML = parcelPanel(p, { provisional: false });

  showLoading(out, 'מאתר תכניות…');
  renderPlans(await plansAt(p.centre.lon, p.centre.lat));
}));

// Enter submits from any single-line field.
document.querySelectorAll('#addr-in, #gush-in, #parcel-in').forEach((input) => {
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    (input.id === 'addr-in' ? el('addr-go') : el('gush-go')).click();
  });
});
