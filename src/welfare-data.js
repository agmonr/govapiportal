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

// Per-authority ₪ breakdown - 232 rows, but only 18 of Israel's 261 local
// authorities (roughly the ones over 100k population) appear at all; every
// other authority only has recipient COUNTS, no ₪ figure - see
// RECIPIENTS_RESOURCE_ID below for those.
export const AUTHORITY_RESOURCE_ID = '39a00c6d-5bb4-470c-8fa3-449ba73de309';
export const AUTHORITY_FIELDS = {
  authority: 'רשות שולחת /רשות', year: 'שנה', category: 'סוג סידור',
  recipients: 'מספר מקבלי מענה', amount: 'סכום תשלומים',
};

/**
 * Recipient counts (no ₪, no קהילה/חוץ-ביתי split) for ALL 261 authorities,
 * 2016-2022, one row per authority (wide format - one column per year,
 * unlike AUTHORITY_RESOURCE_ID's long format). This is the ONLY welfare-
 * payments source that covers the ~243 authorities missing from
 * AUTHORITY_RESOURCE_ID.
 *
 * Its own total for a code ALSO present in AUTHORITY_RESOURCE_ID does not
 * exactly match that resource's community+out-of-home sum (checked
 * directly: אשקלון 2022 - 4,234 here vs. 3,994+372=4,366 there) - close but
 * not identical, likely a different "as of" snapshot or scope between two
 * separately-published ministry tables, not a bug in either. welfare.js
 * therefore never mixes the two for the same authority: a code already in
 * AUTHORITY_RESOURCE_ID keeps using ONLY that resource's numbers, and this
 * one is consulted purely to fill in the codes AUTHORITY_RESOURCE_ID lacks.
 */
export const RECIPIENTS_RESOURCE_ID = 'a9ef87fa-ded4-461d-884d-1976f234f711';
export const RECIPIENTS_AUTHORITY_FIELD = 'רשות שולחת';
// Field names embed the year directly: "מספר מקבלי מענה במסגרות רווחה - 2022".
export function parseRecipientsYearField(fieldName) {
  const m = /-\s*(20\d{2})\s*$/.exec(fieldName || '');
  return m ? Number(m[1]) : null;
}

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
 * ₪ broken down by ACTUAL TARGET/PROGRAM (elderly homes, disability
 * institutions, autism frameworks, foster care, etc.) - up to 109 individual
 * budget lines per year, each with its own ₪ and a male/female recipient
 * split. National only - no per-authority version of this breakdown has
 * been found, so this is a separate national-level section, not part of the
 * per-authority comparison the rest of this page does.
 *
 * Only 2020-2022 are wired up. A 2017-2019 resource exists
 * (7ebc9628-5cf4-4211-811a-e9814d052082) but its column headers don't
 * reliably describe their own contents - checked directly: values under a
 * column literally named "נקבה 2018 תשלום" (female PAYMENT 2018) are
 * headcount-sized numbers (tens), not ₪-sized ones, for the same rows where
 * the correctly-named 2019 payment columns show ₪-sized values. That's a
 * malformed export, not a parsing choice to work around - showing it as fact
 * would be presenting a guess as data, so it's left out rather than guessed.
 */
export const TARGET_BREAKDOWN_RESOURCES = {
  2022: '1a2e0815-b381-4ed8-a1c2-8fb35f3d94d7',
  2021: 'f5f7072e-6ed5-40ea-96f9-f324700a9548',
  2020: 'e130c996-eb85-43e3-b340-1874baf582b5',
};
export function targetBreakdownFields(year) {
  return {
    label: 'תקציב / סעיף תקציבי',
    maleCount: `זכר ${year}`, maleAmount: `סכום לתשלום זכר ${year}`,
    femaleCount: `נקבה ${year}`, femaleAmount: `סכום לתשלום נקבה ${year}`,
    totalCount: `סהכ ${year}`, totalAmount: `סהכ תשלום ${year}`,
  };
}
/**
 * Every real budget line starts with a numeric code ("1039010  ילדים
 * במעונות יום"). 2020's export additionally carries one row with no code at
 * all ("סכום כולל" - a ministry-computed grand total, not a target of its
 * own) - confirmed directly: including it roughly DOUBLES the year's summed
 * total against the trend the other two years show. Returning null for any
 * unrecognized label filters that row out the same way an unrecognized
 * category already gets skipped elsewhere in this file.
 */
export function parseTargetLabel(raw) {
  const m = /^(\d+)\s+(.+)$/.exec((raw || '').trim());
  return m ? { code: m[1], name: m[2].trim() } : null;
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
