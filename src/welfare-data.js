/**
 * Resource IDs and normalization rules for welfare.html - payments the
 * Ministry of Social Affairs (משרד הרווחה) makes to welfare CARE FRAMEWORKS
 * (elderly homes, disability institutions, foster care, autism frameworks,
 * etc.), not cash benefits or income support paid directly to individuals -
 * package "מאגר תשלומים" (ministry_of_social_affairs org on data.gov.il).
 *
 * Both resources here are small enough to fetch WHOLE, unlike local-finance's
 * per-year/per-authority split - so welfare.js fetches each exactly once and
 * does every authority/year/compare filter client-side. No per-selection
 * network request at all, and so no analog of local-finance's request-count
 * problem to begin with.
 */

// National totals, 2016-2022, one row per year - complete, no gaps, no era
// split in the FIELD NAMES (unlike the per-authority resource below).
export const NATIONAL_RESOURCE_ID = '12a42686-e93c-4753-af68-73c510125e2e';
export const NATIONAL_FIELDS = {
  year: 'שנה',
  community: { recipients: 'מספר מקבלי מענה במסגרות בקהילה', amount: 'סכום התשלומים למסגרות בקהילה' },
  outOfHome: { recipients: 'מספר מקבלי מענה במסגרות חוץ-ביתיות', amount: 'סכום התשלומים למסגרות חוץ-ביתיות' },
};

// Per-authority ₪ breakdown - 232 rows, but only 18 of Israel's ~261 local
// authorities (roughly the ones over 100k population) appear at all; every
// other authority has only recipient COUNTS elsewhere on data.gov.il, no ₪
// figure, so this page doesn't attempt to cover them - see the notice in
// welfare.html.
export const AUTHORITY_RESOURCE_ID = '39a00c6d-5bb4-470c-8fa3-449ba73de309';
export const AUTHORITY_FIELDS = {
  authority: 'רשות שולחת /רשות', year: 'שנה', category: 'סוג סידור',
  recipients: 'מספר מקבלי מענה', amount: 'סכום תשלומים',
};

/**
 * Both the authority NAME and the category LABEL change spelling at the
 * same 2021 boundary in this resource - confirmed directly (Tel Aviv: "313
 * תל אביב" 2016-2020 vs "313 תל אביב-יפו" 2021-2022; category: "מסגרות
 * בקהילה"/"מסגרות חוץ-ביתיות" 2016-2020 vs "בקהילה"/"חוץ ביתי" 2021-2022) -
 * one export-format change touching both fields at once, not two unrelated
 * drifts. Categories normalize to these two canonical keys regardless of era.
 */
export const CATEGORY_COMMUNITY = 'קהילה';
export const CATEGORY_OUT_OF_HOME = 'חוץ-ביתי';
export function normalizeCategory(raw) {
  if (raw === 'בקהילה' || raw === 'מסגרות בקהילה') return CATEGORY_COMMUNITY;
  if (raw === 'חוץ ביתי' || raw === 'מסגרות חוץ-ביתיות') return CATEGORY_OUT_OF_HOME;
  return null; // unrecognized - callers skip rather than misfile it under either category
}

/**
 * "רשות שולחת /רשות" carries a leading numeric locality code before the name
 * ("101 אשקלון") - the code is what's STABLE across the name-spelling drift
 * above (Tel Aviv is code 313 under both spellings), so authorities are
 * keyed by code everywhere in welfare.js, with the display name taken from
 * whichever row is newest (so "תל אביב-יפו" wins over "תל אביב").
 */
export function parseAuthorityField(raw) {
  const m = /^(\d+)\s+(.+)$/.exec(raw || '');
  return m ? { code: m[1], name: m[2] } : null;
}
