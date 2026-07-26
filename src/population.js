/**
 * Shared per-locality population lookup, used by local-finance.js and
 * welfare.js (each had its own near-identical fetchPopulation() before this
 * - the same duplication pattern the chart renderers had, see charts.js).
 *
 * Single source: CBS's 2022 Population and Housing Census
 * ("מפקד האוכלוסין והדיור 2022", package id "2022" on data.gov.il) - a
 * one-time snapshot, not an annual series. CBS has not published a live-
 * queryable per-locality population dataset for any other year on
 * data.gov.il (confirmed by search when local-finance.js first added this).
 * LocNameHeb usually matches a caller's own spelling directly (confirmed for
 * הוד השרון/רעננה) - but not always: CBS spells Tel Aviv-Yafo
 * "תל אביב -יפו" (space BEFORE the hyphen), while welfare.js's own source
 * spells it "תל אביב-יפו" (no space) - confirmed directly when the default
 * comparison city came back "not found" despite genuinely being in the
 * census. fetchPopulation() retries once with that space toggled before
 * giving up, rather than surfacing a cross-source spelling difference as if
 * the locality were missing. Total_Population arrives as a comma-formatted
 * string ("65,020"), not a number - stripped here so every caller gets a
 * plain int.
 */
import { dsFilter, dsQuery } from './datastore.js';

export const CBS_POPULATION_RESOURCE_ID = '38207cf8-afe2-48ed-a3b0-c8f70c796015';
export const CBS_POPULATION_FIELD = 'LocNameHeb';
export const CBS_POPULATION_YEAR = 2022;

async function queryPopulation(name) {
  try {
    const { records } = await dsFilter(CBS_POPULATION_RESOURCE_ID, { [CBS_POPULATION_FIELD]: name });
    if (!records.length) return null;
    const n = Number(String(records[0]['Total_Population']).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

/** Returns a single population figure for one authority, or null if the
 *  name genuinely isn't in CBS's census even after the hyphen-spacing retry
 *  (a real gap - callers must not divide by it, only skip the per-resident
 *  figure it would have fed). */
export async function fetchPopulation(authority) {
  const direct = await queryPopulation(authority);
  if (direct != null) return direct;
  const toggled = authority.includes(' -') ? authority.replace(' -', '-') : authority.replace('-', ' -');
  return toggled !== authority ? queryPopulation(toggled) : null;
}

/** Every locality's population, for classifying many authorities at once
 *  (e.g. small/medium/large tiers) - the whole census table is only ~1,222
 *  rows, fetched here with no filter at all rather than an OR-match on 260+
 *  authority names: that filter, JSON-stringified and URL-encoded into a
 *  GET query string, was measured well past 10,000 characters and failed
 *  outright ("Failed to fetch") - a plain unfiltered fetch of everything is
 *  both simpler and smaller on the wire. Cached at module scope since the
 *  census itself never changes within a page load. Does not retry the
 *  hyphen-spacing quirk per name the way fetchPopulation() does - a name
 *  missing from the result is a real gap, same as fetchPopulation()
 *  returning null. */
let allPopulationsCache = null;
export async function fetchPopulations() {
  if (!allPopulationsCache) {
    allPopulationsCache = (async () => {
      const { records } = await dsQuery(CBS_POPULATION_RESOURCE_ID, { limit: '2000' });
      const byName = new Map();
      for (const rec of records) {
        const n = Number(String(rec['Total_Population']).replace(/,/g, ''));
        if (Number.isFinite(n)) byName.set(rec[CBS_POPULATION_FIELD], n);
      }
      return byName;
    })();
  }
  return allPopulationsCache;
}
