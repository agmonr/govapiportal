/**
 * Entry point for apps.html - every app in one place, grouped the same way
 * as the "אפליקציות" section on index.html (src/apps.js), just without the
 * portal/API map underneath it. Its own page/URL because "just the apps,
 * nothing else" is a real thing someone might want to link to or bookmark -
 * the map stays a map.
 */

import { el, showError } from './ui.js';
import { renderAppsByCategory } from './apps.js';
import { initThemePicker } from './theme.js';

initThemePicker(el('themePick'));

/** Copies one embed snippet (HTML/iframe or JS) as plain text - Clipboard
 * API, no fallback textarea/execCommand: every browser this site otherwise
 * targets (Chrome/Edge/Firefox/Safari, all recent enough for the rest of the
 * JS here) already supports navigator.clipboard.writeText over https/
 * localhost. Both snippets share the same button/code pairing, just two of
 * them (btnId/codeId) rather than one. */
[['embedCopyBtnHtml', 'embedCodeHtml'], ['embedCopyBtnJs', 'embedCodeJs']].forEach(([btnId, codeId]) => {
  const btn = el(btnId);
  if (!btn) return;
  const prevLabel = btn.textContent;
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(el(codeId).textContent);
      btn.textContent = 'הועתק ✓';
    } catch {
      btn.textContent = 'ההעתקה נכשלה - יש להעתיק ידנית';
    }
    setTimeout(() => { btn.textContent = prevLabel; }, 2000);
  });
});

async function load() {
  try {
    const data = globalThis.__API_DATA__ || await (async () => {
      const res = await fetch(new URL('../apis.json', import.meta.url));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })();
    renderAppsByCategory(el('apps'), data.apps);
  } catch (err) {
    showError(el('apps'), err);
  }
}

load();
