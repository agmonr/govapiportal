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
import { dsFilter } from './datastore.js';

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
