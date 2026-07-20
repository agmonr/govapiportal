/**
 * Entry point for datagov.html.
 *
 * The explorer lives on its own page rather than in the map: it is the only
 * source here whose records can be read, and giving it a URL means it can be
 * linked to directly instead of being scrolled to. The map stays a map.
 */

import { el } from './ui.js';
import { mountCkan } from './ckan.js';

mountCkan(el('ckan'));
