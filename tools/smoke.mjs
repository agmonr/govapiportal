/**
 * Loads the API map in a real browser and exercises the top view.
 *
 * Runs twice: once over HTTP against the served site, once over file:// against
 * dist/map.html. The second pass is the one that matters for the offline copy —
 * a page opened from disk is refused ES module scripts and fetch() from origin
 * 'null', which is exactly the failure the bundle exists to sidestep.
 *
 * Expectations are derived from apis.json rather than hardcoded, so adding a
 * source does not require editing this file.
 *
 * Any console error, page error or failed request fails the run.
 */
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const HTTP_BASE = process.argv[2] || 'http://localhost:8123';
const FILE_BASE = new URL('../dist/map.html', import.meta.url).href;
const data = JSON.parse(readFileSync(new URL('../apis.json', import.meta.url)));

/** Mirrors verdict() in src/map.js. If these drift, the assertions below catch it. */
function verdict(api) {
  if (api.browser) return 'ok';
  if (api.status === 200 && !api.cors) return 'warn';
  if (api.status === 403) return 'bad';
  if (api.endpoint === 'unknown' || api.status === 404) return 'unknown';
  return 'limited';
}

const expected = data.apis.reduce((acc, a) => {
  acc[verdict(a)] = (acc[verdict(a)] || 0) + 1;
  return acc;
}, {});

// Not every portal has an API row - one (the tree-objections tracker) is
// deliberately API-less, and the matrix skips empty groups (see map.js), so
// the group count is portals-with-an-api, not portals.length.
const portalsWithApis = new Set(data.apis.map((a) => a.portal)).size;

const failures = [];
const browser = await chromium.launch();

async function runPass(label, url, { bundled = false } = {}) {
  console.log(`\n\x1b[1m${label}\x1b[0m  ${url}`);
  const problems = [];
  const ok = (cond, msg) => {
    console.log(`${cond ? '\x1b[32m  PASS\x1b[0m' : '\x1b[31m  FAIL\x1b[0m'}  ${msg}`);
    if (!cond) problems.push(`${label}: ${msg}`);
  };

  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`${label} console: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`${label} pageerror: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`${label} requestfailed: ${r.url()} ${r.failure()?.errorText}`));

  await page.goto(url, { waitUntil: 'load' });
  await page.waitForSelector('#matrix tr.row', { timeout: 10000 });

  /* --- every API is represented, once, in both views --- */
  const n = data.apis.length;
  ok(await page.locator('#matrix tr.row').count() === n, `matrix lists all ${n} APIs`);
  ok(await page.locator('.card.api').count() === n, `detail list holds all ${n} APIs`);
  ok(await page.locator('#matrix tr.grp').count() === portalsWithApis,
    `matrix groups by all ${portalsWithApis} portals that have an API`);

  /* --- tile counts must agree with both views, or the top view is lying --- */
  for (const [cls, count] of Object.entries(expected)) {
    const tile = page.locator(`.stat.${cls} .stat-n`);
    ok(await tile.count() === 1, `${cls}: has a tile`);
    if (!(await tile.count())) continue;
    const shown = Number(await tile.textContent());
    const cards = await page.locator(`.card.api.${cls}`).count();
    const rows = await page.locator(`#matrix tr.row.${cls}`).count();
    ok(shown === count && cards === count && rows === count,
      `${cls}: tile ${shown} == cards ${cards} == rows ${rows} == apis.json ${count}`);
  }

  /* --- states stay distinct: nothing may carry two verdicts --- */
  const classes = ['ok', 'warn', 'limited', 'bad', 'unknown'];
  const doubles = await page.locator(
    classes.flatMap((a) => classes.filter((b) => b !== a).map((b) => `.card.api.${a}.${b}`)).join(',')
  ).count();
  ok(doubles === 0, `no API carries two verdicts (found ${doubles})`);

  /* --- a tile filters the list --- */
  await page.locator('.stat.ok').click();
  await page.waitForTimeout(120);
  ok(await page.locator('.card.api').count() === expected.ok,
    `ok tile narrows the list to ${expected.ok}`);
  ok(await page.locator('.stat.ok.active').count() === 1, 'active tile is marked');

  /* --- a matrix row clears filters and reaches its card --- */
  const id = await page.locator('#matrix tr.row.unknown').first().getAttribute('data-id');
  await page.locator(`#matrix tr.row[data-id="${id}"]`).click();
  await page.waitForTimeout(300);
  ok(await page.locator('.card.api').count() === n, 'row click cleared the tile filter');
  const target = page.locator(`.card.api[data-id="${id}"]`);
  ok(await target.count() === 1, `jump target ${id} resolves to one card`);
  ok(await target.evaluate((el) => el.classList.contains('flash')), 'jump target is highlighted');
  ok(await target.isVisible(), 'jump target scrolled into view');

  /* --- the offline copy must be genuinely self-contained --- */
  if (bundled) {
    ok(await page.locator('#fileproto').count() === 0,
      'no "run a server" notice in the bundle - it does not apply there');
    const external = await page.evaluate(() =>
      [...document.querySelectorAll('script[src], link[rel="stylesheet"][href], img[src]')]
        .map((e) => e.getAttribute('src') || e.getAttribute('href')));
    ok(external.length === 0, `no external asset references (found ${external.join(', ') || 'none'})`);
  } else {
    ok(await page.locator('#fileproto').isVisible() === false,
      'file:// notice stays hidden when served over HTTP');
  }

  // The stamp carries an hour now; a bad parse would render "Invalid Date".
  const stamp = (await page.locator('#probed').innerText()).trim();
  ok(/^נבדק: \d{2}\.\d{2}\.\d{4} \d{2}:\d{2}$/.test(stamp), `probe stamp shows date and hour (got "${stamp}")`);

  /* --- portal drill-in ---
     Only structure and wiring are asserted. Whether the live request succeeds
     depends on five government hosts being up, and this suite deliberately does
     not fail because someone else's server is down. */
  // Hand-maintained, like verdict() above: bump this when a PREVIEWS entry
  // is added to or removed from src/portal.js.
  const EXPECTED_PREVIEWS = 6;
  const withPreview = await page.locator('.portal .p-open').count();
  ok(withPreview === EXPECTED_PREVIEWS,
    `${EXPECTED_PREVIEWS} portals advertise a live preview (found ${withPreview})`);

  /* data.gov.il carries the column sort and column filters, and is the only
     portal whose rows expand into files.

     It is opened before the `download` assertion below on purpose: that check
     used to run against an empty #drill and passed vacuously - there were no
     links for it to look at, so it would have stayed green if the attribute
     came back. Everything here is skipped rather than failed when data.gov.il
     does not answer, per the note above. */
  await page.locator('.portal[data-portal="datagov"]').click();
  const answered = await page.locator('#drill .matrix.preview tbody tr').first()
    .waitFor({ timeout: 30000 }).then(() => true, () => false);

  if (!answered) {
    console.log('\x1b[33m  SKIP\x1b[0m  data.gov.il did not answer - column controls not asserted');
  } else {
    ok(await page.locator('#drill .matrix-wrap.scroll').count() === 1,
      'the long preview scrolls inside its own box, not the page');
    ok(await page.locator('#drill .matrix-wrap.scroll')
      .evaluate((e) => e.scrollHeight > e.clientHeight),
      'the scroll box actually has something to scroll');
    // Only title_string and organization are single-valued indexed Solr fields.
    // A third control would mean a column being sorted client-side while looking
    // exactly like the two that sort all 1,197.
    ok(await page.locator('#drill th.sortable').count() === 2,
      'exactly the 2 server-sortable columns are interactive');
    ok(await page.locator('#drill .col-f').count() === 2,
      'both column filters rendered from the response facets');
    ok(await page.locator('#drill .col-f').first().locator('option').count() > 1,
      'the column filter is populated, not an empty dropdown');
    // Cross-origin `download` is ignored by browsers; if it reappears the links
    // are silently not doing what the attribute claims.
    ok(await page.locator('#drill .files a[download]').count() === 0,
      'file links do not rely on the cross-origin-ignored download attribute');

    /* Paging is a server offset, so the first page must not send one and the
       range must describe the collection rather than the fetched rows. */
    ok(await page.locator('#drill .pager .pg[data-start]').count() > 0, 'pager rendered');
    ok(await page.locator('#drill .pager .pg.cur').innerText() === '1', 'opens on page 1');
    ok(await page.locator('#drill .pager .pg:disabled').count() === 1,
      'prev is disabled on the first page');
    ok(!(await page.locator('#drill .drill-url code').innerText()).includes('start='),
      'page 1 sends no start offset');
    // The explorer moved to its own page; the preview must point at it.
    const more = page.locator('#drill .drill-more');
    ok(await more.count() === 1, 'the preview links on to the full explorer');
    ok(await more.getAttribute('href') === './datagov.html',
      'and links relatively, so the offline copies reach each other');
  }
  await page.locator('#drill .drill-close').click();

  // Every portal offering a preview must offer a filter with it, and must say
  // whether that filter runs server-side or over already-fetched rows.
  await page.locator('.portal[data-portal="cbs"]').click();
  await page.waitForSelector('#drill .drill-q', { timeout: 10000 });
  ok(await page.locator('#drill .drill-scope').count() === 1, 'filter states its scope (server vs local)');
  await page.locator('#drill .drill-close').click();

  await page.locator('.portal[data-portal="knesset"]').click();
  await page.waitForSelector('#drill .drill', { timeout: 10000 });
  ok(await page.locator('#drill .matrix.preview').count() === 0,
    'a portal with no browser-callable API shows an explanation, not a table');
  await page.locator('#drill .drill-close').click();
  ok(await page.locator('#drill .drill').count() === 0, 'close button dismisses the drill-in');
  ok(await page.locator('.card.api').count() === n, 'closing the drill-in also clears its filter');

  /* --- explorer: the method badge opens the request, and only when it can ---
     A new tab can only issue GET, so a POST endpoint must not offer one; sending
     a different request than the one displayed would be worse than not offering
     it at all. */
  await page.locator('.card.api', { hasText: 'OData — ParliamentInfo' }).first()
    .locator('.toggle-ex').click();
  await page.waitForSelector('.explorer', { timeout: 10000 });
  const getBadge = page.locator('.card.api', { hasText: 'OData — ParliamentInfo' }).first()
    .locator('.ex-method');
  ok(await getBadge.evaluate((e) => e.tagName) === 'A', 'GET endpoints offer an open-in-tab link');
  ok(await getBadge.getAttribute('target') === '_blank', 'the link opens in a new tab');

  const postCard = page.locator('.card.api', { hasText: 'Real estate transactions' }).first();
  await postCard.locator('.toggle-ex').click();
  await page.waitForTimeout(200);
  ok(await postCard.locator('.ex-method').evaluate((e) => e.tagName) === 'SPAN',
    'POST endpoints do not offer a tab a browser could only issue as GET');
  ok((await page.locator('.ex-run').first().innerText()).trim() === 'בקשה',
    'the inline-request button reads בקשה');

  /* --- RTL body must never scroll sideways, however wide the table gets --- */
  for (const width of [380, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(150);
    const over = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(over <= 0, `no horizontal body scroll at ${width}px (overflow ${over}px)`);
  }

  await page.close();
  failures.push(...problems);
}

/**
 * The explorer is its own page now, so it gets its own pass - over HTTP and
 * from disk, exactly like the map. Soft-skipped when data.gov.il does not
 * answer: this suite never fails because someone else's server is down.
 */
async function runCkanPass(label, url) {
  console.log(`\n\x1b[1m${label}\x1b[0m  ${url}`);
  const problems = [];
  const ok = (cond, msg) => {
    console.log(`${cond ? '\x1b[32m  PASS\x1b[0m' : '\x1b[31m  FAIL\x1b[0m'}  ${msg}`);
    if (!cond) problems.push(`${label}: ${msg}`);
  };

  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`${label} console: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`${label} pageerror: ${e.message}`));

  await page.goto(url, { waitUntil: 'load' });
  const live = await page.locator('#ckan .ck-card').first()
    .waitFor({ timeout: 30000 }).then(() => true, () => false);

  if (!live) {
    console.log('\x1b[33m  SKIP\x1b[0m  data.gov.il did not answer - explorer not asserted');
  } else {
    ok(await page.locator('#ckan .ck-card').count() === 20, 'catalogue shows a page of datasets');
    ok((await page.locator('#ckan .ck-count').innerText()).includes('1,197'),
      'catalogue states the full total, not the fetched count');
    ok(await page.locator('#ckan .ck-controls select').count() === 3,
      'org / format / sort controls present');
    ok((await page.locator('#ckan .drill-url code').innerText()).includes('package_search'),
      'the exact request is shown');
    ok(await page.locator('#ckan .drill-scope').count() === 1, 'the page states its filtering scope');
    ok(await page.locator('#ckan .pager .pg[data-page]').count() > 0, 'catalogue is paged');
    // It holds no snapshot - every row is fetched live, so a stale bundle
    // cannot serve stale data here the way it could on the map.
    ok(!(await page.content()).includes('__API_DATA__'),
      'the explorer embeds no data snapshot');

    /* The resource URL data.gov.il advertises is WAF-challenged for CSV/XLSX -
       measured 200 text/html with 42 KB of challenge script instead of a 1.4 MB
       file. DataStore resources therefore get a CSV built in the browser from
       datastore_search, which is not challenged. The full download is exercised
       by hand (116,673 rows verified); asserted here is that the control exists
       and that the raw link no longer poses as a working download. */
    const card = page.locator('#ckan .ck-card', { has: page.locator('.f-tag') }).first();
    if (await card.count()) {
      await card.click();
      await page.waitForSelector('#ckan .ck-detail', { timeout: 20000 });
      ok(await page.locator('#ckan .ck-dl').count() > 0,
        'DataStore resources offer a CSV built here, not just the WAF-blocked link');
      const raw = page.locator('#ckan .files a.f-go').first();
      ok((await raw.innerText()).includes('מקור'),
        'the origin-file link is labelled as such rather than as the download');
      ok(await page.locator('#ckan .files-note').count() === 1,
        'the WAF caveat is stated next to the files');
      await page.locator('#ckan .ck-crumb').first().click();
      await page.waitForSelector('#ckan .ck-card', { timeout: 20000 });
    }
  }

  for (const width of [380, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(150);
    const over = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(over <= 0, `no horizontal body scroll at ${width}px (overflow ${over}px)`);
  }

  await page.close();
  failures.push(...problems);
}

await runPass('served over HTTP', HTTP_BASE);
await runPass('opened from disk', FILE_BASE, { bundled: true });
await runCkanPass('explorer over HTTP', `${HTTP_BASE}/datagov.html`);
await runCkanPass('explorer from disk', new URL('../dist/datagov.html', import.meta.url).href);

await browser.close();

if (failures.length) {
  console.log(`\n\x1b[31m${failures.length} problem(s)\x1b[0m\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('\n\x1b[32mAll checks passed across all four passes. No console errors.\x1b[0m');
