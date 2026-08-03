/**
 * Entry point for moag.html - the Ministry of Agriculture equivalent of
 * datagov.js. Its own page for the same reason: it is the one other portal
 * here whose records can be read, not just a catalogue of files.
 */

import { el, probedAt } from './ui.js';
import { mountMoag } from './moag-explorer.js';
import { initThemePicker } from './theme.js';

initThemePicker(el('themePick'));

// When this page itself was built/published, distinct from any "when was
// the underlying data checked" stamp - document.lastModified is the file's
// Last-Modified (the GitHub Pages deploy time when served, the file's mtime
// when opened offline). Same idiom as accidents.js/committees.js/etc.
const built = new Date(document.lastModified);
if (!Number.isNaN(built.getTime())) {
  el('created').textContent = `נוצר: ${probedAt(document.lastModified)}`;
  el('created').title = built.toISOString();
}
mountMoag(el('moag'));
