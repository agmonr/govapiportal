/**
 * Downloads the Ministry of Interior's own list of "רשויות איתנות"
 * (local authorities meeting the section 232א Municipalities Ordinance
 * financial-stability test) from gov.il and saves it as JSON.
 *
 * gov.il sits behind Cloudflare - confirmed directly with a plain curl
 * (HTTP 403, "Just a moment..." challenge page, no amount of User-Agent
 * spoofing changes that). Reuses the Playwright/Chromium tools/setup.sh
 * already installs for smoke.mjs, since a real browser at least CAN pass
 * the challenge - but not reliably every time: one run here got the actual
 * page cleanly on the first try, then several immediate re-runs all got
 * Cloudflare's harder "Attention Required" block page instead - almost
 * certainly IP/rate-based after repeated automated hits in a short window,
 * not a bug in this script. Re-running it after a real gap, not in a tight
 * loop, is the more honest way to use it. tools/stable_authorities.json is
 * checked into the repo from the one run that did succeed, rather than
 * assumed to regenerate on demand.
 *
 * The list itself is a plain <h3>רשימת הרשויות האיתנות</h3> followed by an
 * <ol><li> per authority - confirmed directly against the live page's DOM,
 * not guessed from the rendered text (which runs every name together with
 * no separators).
 */
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const PAGE_URL = 'https://www.gov.il/he/pages/stable?chapterIndex=2';
const OUT = new URL('../tools/stable_authorities.json', import.meta.url);
const HEADING_TEXT = 'רשימת הרשויות האיתנות';

const extract = (headingText) => {
  const heading = [...document.querySelectorAll('h2, h3, h4')]
    .find((el) => el.textContent.trim() === headingText);
  const list = heading?.nextElementSibling;
  return list ? [...list.querySelectorAll('li')].map((li) => li.textContent.trim()) : [];
};

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Polled rather than a single extraction attempt - Cloudflare's own
  // challenge redirect can still be resolving for the first second or two
  // even after 'domcontentloaded' fires for that interim page.
  let authorities = [];
  for (let i = 0; i < 20 && !authorities.length; i++) {
    authorities = await page.evaluate(extract, HEADING_TEXT);
    if (!authorities.length) await page.waitForTimeout(1000);
  }

  if (!authorities.length) {
    throw new Error('No <li> authorities found under the heading - the page structure may have changed.');
  }

  writeFileSync(OUT, `${JSON.stringify({
    source: PAGE_URL,
    fetched: new Date().toISOString(),
    count: authorities.length,
    authorities,
  }, null, 2)}\n`);

  console.log(`Wrote ${authorities.length} authorities to ${OUT.pathname}`);
} finally {
  await browser.close();
}
