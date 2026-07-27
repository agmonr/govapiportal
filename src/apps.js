/**
 * Shared "app card" rendering - the grid of tools built on top of (or, for
 * the tree tracker, adjacent to) a government API, as opposed to the portal/
 * API map itself. Grouped by what a visitor is actually trying to do
 * (category/category_he in apis.json), not by data source - "מי אחראי על
 * ניקיון" and "עצים והשגות" have nothing in common technically, but both are
 * things a citizen might act on, so both sit under the same heading.
 *
 * Used by index.html's map (every category, above the portal/API detail) and
 * by apps.html (the same grid, its own page - see there for why a page of
 * its own is worth having).
 */

import { esc } from './ui.js';

// One glyph each - a welcoming button reads as a destination, not a
// document, so the icon carries it rather than a URL or an arrow-hint line.
export const APP_ICON = {
  accidents: '🚦', trees: '🌳', committees: '🏛️', 'local-finance': '💰', agriculture: '🌾',
  companies: '🏢', welfare: '🤝', budgetkey: '🔑', 'blue-lines': '🚇', 'area-cleanup': '🧹',
  'tree-canopy': '🌳',
};

// Render order for categories - not alphabetical on the Hebrew label, and
// not apis.json's own app order. Civic-action items first (things asking
// something OF you), then money/accountability, then whatever's tied to
// your own address. A category outside this list still renders (under its
// own heading, after these) rather than silently dropping its apps.
const CATEGORY_ORDER = ['civic', 'money', 'home'];

export function appCard(a) {
  return `
    <a class="app-tile" href="${esc(a.href)}"${a.external ? ' target="_blank" rel="noopener"' : ''}
       title="${esc(a.about)}" dir="auto">
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
