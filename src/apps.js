/**
 * Shared "app card" rendering - the grid of tools built on top of (or, for
 * the tree tracker, adjacent to) a government API, as opposed to the portal/
 * API map itself. Grouped by what a visitor is actually trying to do
 * (category/category_he in apis.json), not by data source - "מי אחראי על
 * ניקיון" and "להציל עץ" have nothing in common technically, but both are
 * things a citizen might act on, so both sit under the same heading.
 *
 * Used by index.html's map (every category, above the portal/API detail) and
 * by apps.html (the same grid, its own page - see there for why a page of
 * its own is worth having).
 */

import { esc } from './ui.js';

// One glyph each (occasionally a short sequence, or - trees/tree-canopy/
// tree-plans/trip-report only - a small HTML composition, see .icon-small/
// .tc-icon in style.css) - a welcoming button reads as a destination, not a
// document, so the icon carries it rather than a URL or an arrow-hint line.
// trees (small 🚑), tree-canopy (🏠 badge) and tree-plans (📋 badge) all
// start from the same 🌳 but diverge on purpose: trees is about a tree
// already in trouble (needing rescue - the ambulance is deliberately
// smaller, a detail riding along with the tree rather than an equal second
// subject), tree-canopy is about how much canopy covers a city/
// neighborhood/street - a house tucked in the corner, not a rescue call -
// and tree-plans is earlier still: a building plan (the clipboard) that
// marks trees, years before any tree-felling license (trees' own subject)
// would exist. trip-report is unrelated to the tree family (🚗, with a small
// live-score badge, not a 🌳 variant) - a live per-trip driving score, not a
// government dataset lookup. Not escaped by appCard/renderAppContext (both
// interpolate this directly, no esc()), so raw markup here renders as real
// HTML, not text.
export const APP_ICON = {
  accidents: '🚦', trees: '🌳<span class="icon-small">🚑</span>', committees: '🏛️',
  'local-finance': '💰', agriculture: '🌾',
  companies: '🏢', welfare: '🤝', budgetkey: '🔑', 'blue-lines': '🚇', 'area-cleanup': '🧹',
  'tree-canopy': '<span class="tc-icon">🌳<span class="tc-icon-badge">🏠</span></span>',
  'tree-plans': '🌳<span class="icon-small">📋</span>',
  'trip-report': '🚗<span class="icon-small">🎯</span>',
};

// Render order for categories - not alphabetical on the Hebrew label, and
// not apis.json's own app order. Whatever's tied to your own address first,
// then civic-action items (things asking something OF you), then money/
// accountability. A category outside this list still renders (under its
// own heading, after these) rather than silently dropping its apps.
const CATEGORY_ORDER = ['home', 'civic', 'money'];

// The native hover tooltip (title=) can't be styled - the browser draws it,
// wrapping to as many lines as the full `about` text needs (some run past
// 500 characters). A single short line reads on hover before the tooltip
// even finishes rendering; the full text is one click away on the app's own
// page anyway; splitting on the first ". " keeps it to one real sentence
// rather than cutting mid-word, with a hard length cap as a backstop for
// entries whose first sentence alone still runs long.
const HOVER_MAX = 90;
function oneLineSummary(about) {
  const firstSentence = about.split('. ')[0];
  return firstSentence.length <= HOVER_MAX ? firstSentence : `${firstSentence.slice(0, HOVER_MAX)}…`;
}

export function appCard(a) {
  return `
    <a class="app-tile" href="${esc(a.href)}"${a.external ? ' target="_blank" rel="noopener"' : ''}
       title="${esc(oneLineSummary(a.about))}" dir="auto">
      <span class="app-icon" aria-hidden="true">${APP_ICON[a.id] || '🔗'}</span>
      <span class="app-name" dir="auto">${esc(a.name_he)}</span>
    </a>`;
}

/**
 * Groups `apps` by category and renders one <section> per category into
 * `node` - a heading plus its own .apps-grid, not one flat grid with no
 * structure. An app with no category (shouldn't happen - every entry in
 * apis.json carries one - but a missing field must not make an app vanish)
 * falls into a catch-all "אחר" group at the end.
 */
export function renderAppsByCategory(node, apps) {
  const byCategory = new Map();
  for (const a of apps) {
    const key = a.category || 'other';
    if (!byCategory.has(key)) byCategory.set(key, { label: a.category_he || 'אחר', items: [] });
    byCategory.get(key).items.push(a);
  }
  const orderedKeys = [
    ...CATEGORY_ORDER.filter((k) => byCategory.has(k)),
    ...[...byCategory.keys()].filter((k) => !CATEGORY_ORDER.includes(k)),
  ];

  node.innerHTML = orderedKeys.map((key) => {
    const { label, items } = byCategory.get(key);
    return `
      <section class="apps-category" aria-labelledby="appsCat-${esc(key)}">
        <h3 class="apps-category-h" id="appsCat-${esc(key)}" dir="auto">${esc(label)}</h3>
        <div class="apps-grid">${items.map(appCard).join('')}</div>
      </section>`;
  }).join('');
}

/**
 * apis.json isn't inlined into the browser bundle the same way for every
 * page - some embed it (globalThis.__API_DATA__, set by bundle.py), others
 * are served and fetch it live. One shared loader means every page that
 * wants app data (this context strip, or anything else in future) doesn't
 * re-implement the same fallback.
 */
export async function loadAppsData() {
  if (globalThis.__API_DATA__) return globalThis.__API_DATA__;
  const res = await fetch(new URL('../apis.json', import.meta.url));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Renders, under an app's own page header, a 🏠 icon back to apps.html (the
 * full list, every category) plus small icon-links to every OTHER app in the
 * same category as `currentId` (the current one shown too, but inert - "you
 * are here" - not a link to itself). Cross-navigation between related tools
 * without hand-maintaining it per page.
 */
export function renderAppContext(node, apps, currentId) {
  const current = apps.find((a) => a.id === currentId);
  if (!current) { node.innerHTML = ''; return; }
  const inCategory = apps.filter((a) => a.category === current.category);

  const homeHtml = `
    <a class="app-sibling" href="./apps.html" title="כל האפליקציות" dir="auto">
      <span class="app-sibling-icon" aria-hidden="true">🏠</span>
      <span class="app-sibling-label">כל האפליקציות</span>
    </a>`;

  const siblingsHtml = inCategory.map((a) => (a.id === currentId
    ? `<span class="app-sibling app-sibling-current" title="${esc(a.name_he)}" aria-current="page" dir="auto">
         <span class="app-sibling-icon" aria-hidden="true">${APP_ICON[a.id] || '🔗'}</span>
         <span class="app-sibling-label">${esc(a.name_he)}</span>
       </span>`
    : `<a class="app-sibling" href="${esc(a.href)}"${a.external ? ' target="_blank" rel="noopener"' : ''}
         title="${esc(a.name_he)}" dir="auto">
         <span class="app-sibling-icon" aria-hidden="true">${APP_ICON[a.id] || '🔗'}</span>
         <span class="app-sibling-label">${esc(a.name_he)}</span>
       </a>`)).join('');

  node.innerHTML = `
    <nav class="app-siblings" aria-label="אפליקציות נוספות ב${esc(current.category_he || '')}">
      ${homeHtml}${siblingsHtml}
    </nav>`;
}
