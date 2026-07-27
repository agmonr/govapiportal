/**
 * Entry point for moag.html - the Ministry of Agriculture equivalent of
 * datagov.js. Its own page for the same reason: it is the one other portal
 * here whose records can be read, not just a catalogue of files.
 */

import { el } from './ui.js';
import { mountMoag } from './moag-explorer.js';
import { initThemePicker } from './theme.js';

initThemePicker(el('themePick'));
mountMoag(el('moag'));
