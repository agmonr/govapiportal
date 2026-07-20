/**
 * Entry point for accidents.html.
 *
 * This app has its own page rather than a slot in the map's portal grid: it
 * isn't a government API in itself (the underlying API is data.gov.il's, and
 * is catalogued under that portal on the map) - it's a thing built on top of
 * one. openPortal() is reused as-is from portal.js in standalone mode, so
 * the live table, search-by-city and CSV download are exactly the same code
 * already exercised on the map, just given a page of its own.
 */

import { el, esc } from './ui.js';
import { openPortal } from './portal.js';
import { initThemePicker } from './theme.js';

initThemePicker(el('themePick'));

async function load() {
  const mount = el('accidents');
  try {
    const data = globalThis.__API_DATA__ || await (async () => {
      const res = await fetch(new URL('../apis.json', import.meta.url));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })();
    const app = data.apps.find((a) => a.id === 'accidents');
    if (!app) throw new Error('accidents app entry not found in apis.json');
    await openPortal(mount, app, { standalone: true });
  } catch (err) {
    mount.innerHTML = `<div class="notice error">טעינת הנתונים נכשלה: ${esc(err.message)}</div>`;
  }
}

load();
