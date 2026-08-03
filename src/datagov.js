/**
 * Entry point for datagov.html.
 *
 * The explorer lives on its own page rather than in the map: it is the only
 * source here whose records can be read, and giving it a URL means it can be
 * linked to directly instead of being scrolled to. The map stays a map.
 */

import { el, probedAt } from './ui.js';
import { mountCkan } from './ckan.js';
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
mountCkan(el('ckan'));
