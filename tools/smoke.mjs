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
  ok(await page.locator('#matrix tr.grp').count() === data.portals.length,
    `matrix groups by all ${data.portals.length} portals`);

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

  /* --- portal drill-in ---
     Only structure and wiring are asserted. Whether the live request succeeds
     depends on five government hosts being up, and this suite deliberately does
     not fail because someone else's server is down. */
  const withPreview = await page.locator('.portal .p-open').count();
  ok(withPreview === 5, `5 portals advertise a live preview (found ${withPreview})`);

  // Every portal offering a preview must offer a filter with it, and must say
  // whether that filter runs server-side or over already-fetched rows.
  // Cross-origin `download` is ignored by browsers; if it reappears the links
  // are silently not doing what the attribute claims.
  ok(await page.locator('#drill .files a[download]').count() === 0,
    'file links do not rely on the cross-origin-ignored download attribute');

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

await runPass('served over HTTP', HTTP_BASE);
await runPass('opened from disk', FILE_BASE, { bundled: true });

await browser.close();

if (failures.length) {
  console.log(`\n\x1b[31m${failures.length} problem(s)\x1b[0m\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('\n\x1b[32mAll checks passed in both passes. No console errors.\x1b[0m');
