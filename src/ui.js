/** Shared DOM helpers. */

export const el = (id) => document.getElementById(id);

/* Shared by every renderer. They live here rather than in one module because
   bundle.py flattens all sources into a single scope - a second `const num`
   anywhere would be a redeclaration, not a shadow. */

// maximumFractionDigits: 0 - every figure shown via this helper rounds to a
// whole number site-wide (revenue in thousands, area in sqm, rates per m²,
// etc.) - a fractional digit never carries enough meaning here to be worth
// the visual noise, consistently, not just for one table.
export const num = (v) => (v == null ? '—' : Number(v).toLocaleString('he-IL', { maximumFractionDigits: 0 }));

/** Bytes -> a size someone can judge a download by. */
export function bytes(n) {
  if (n == null || Number.isNaN(Number(n))) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let v = Number(n), i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v < 10 && i ? 1 : 0)} ${u[i]}`;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

/** Renders CkanError.kind as something a user can act on. */
export function showError(node, err) {
  const messages = {
    blocked:
      'החסימה מגיעה מ-data.gov.il (403). נסה שוב בעוד מספר דקות.',
    rate_limit: 'יותר מדי בקשות. ממתין ומנסה שוב…',
    network: 'שגיאת רשת. בדוק את החיבור לאינטרנט.',
  };
  const hint = messages[err?.kind] || err?.message || 'אירעה שגיאה.';
  node.innerHTML = `<div class="notice error" dir="auto">${esc(hint)}</div>`;
  if (err) console.error(err);
}

export function showInfo(node, text) {
  node.innerHTML = `<div class="notice info" dir="auto">${esc(text)}</div>`;
}

export function showLoading(node, text = 'טוען…') {
  node.innerHTML = `<div class="skeleton" dir="auto">${esc(text)}</div>`;
}

export const clear = (node) => { node.innerHTML = ''; };

export const param = (name) => new URLSearchParams(location.search).get(name);

/** Formats an apis.json `probed` (or app `computed_at`) timestamp for display. */
export function probedAt(raw) {
  const t = new Date(raw);
  if (Number.isNaN(t.getTime())) return raw;
  const date = t.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const time = t.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
  return `${date} ${time}`;
}

/** Debounce for search-as-you-type without hammering the API. */
export function debounce(fn, ms = 300) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/**
 * Wires click/keyboard toggling for a "▾ summary row -> hidden detail row"
 * pair, the expandable-row idiom used by tree-canopy.js's compare table,
 * moag-explorer.js's dataset list and plan-timeline.js/plan-compare.js's
 * plan drill-downs alike. `rowSelector` matches each summary `<tr>`;
 * `detailAttr`/`rowAttr` are the matching data-attribute pair linking a
 * summary row to its detail row (e.g. `data-plan-row`/`data-detail`) - the
 * summary row's own `dataset[rowAttr]` value is looked up as
 * `[detailAttr="<value>"]` within the same `container`, so unrelated pairs
 * elsewhere on the page (a different table using the same attribute names)
 * never cross-toggle. A `.x-mark` element inside the summary row, if
 * present, flips between ▾/▴.
 */
export function bindExpandableRows(container, rowSelector, detailAttr, rowAttr) {
  container.querySelectorAll(rowSelector).forEach((tr) => {
    const toggle = () => {
      const target = container.querySelector(`[${detailAttr}="${tr.dataset[rowAttr]}"]`);
      if (!target) return;
      target.hidden = !target.hidden;
      const mark = tr.querySelector('.x-mark');
      if (mark) mark.textContent = target.hidden ? '▾' : '▴';
    };
    tr.addEventListener('click', toggle);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  });
}

/* ---------- CSV, built here rather than trusting an advertised download ----------
 * Shared by the data.gov.il explorer and any live-preview download button:
 * some CKAN resource downloads are WAF-challenged (see ckan.js), and some
 * data (e.g. accidents) never had a direct file link to begin with - either
 * way, datastore_search is the call already in use to show the rows, so the
 * CSV is assembled here from data actually in hand.
 */

/** RFC 4180 quoting, and a BOM so Excel reads Hebrew as UTF-8 rather than mojibake. */
export function buildCsv(fields, records) {
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = records.map((r) => fields.map((f) => cell(r[f])).join(','));
  return `﻿${fields.map(cell).join(',')}\r\n${rows.join('\r\n')}\r\n`;
}

/**
 * `download` is ignored for cross-origin URLs, which is why file links open
 * in a tab elsewhere on this site. A blob: URL is same-origin, so here the
 * attribute does work and the browser saves rather than navigates.
 */
export function saveCsv(text, name) {
  const href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10000);
}

/* ---------- a real .xls, for pages where "export to Excel" needs to be more
 * than a renamed CSV (hyperlink cells, a sheet name Excel shows on the tab) -
 * SpreadsheetML 2003 XML, which Excel opens natively with no ZIP/OOXML and no
 * bundled library. `headers`: string[]. `records`: array of row-objects keyed
 * by header. A header/value that IS an {href, text} object becomes a real
 * =HYPERLINK() formula cell instead of plain text - used for a plan's own
 * pl_url link in its exported row. */
function xlsEscape(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Same as xlsEscape, plus quotes - needed wherever the escaped text lands
// inside a double-quoted XML *attribute* (ss:Formula="...") rather than
// element content, since a raw '"' there would close the attribute early
// and corrupt the XML (Excel's own doubled-"" quoting inside the formula
// text is a separate, inner escaping step - this is the outer XML one).
function xlsAttrEscape(s) {
  return xlsEscape(s).replace(/"/g, '&quot;');
}

function xlsCell(v) {
  if (v && typeof v === 'object' && 'href' in v) {
    const formula = `HYPERLINK("${String(v.href).replace(/"/g, '""')}","${String(v.text ?? v.href).replace(/"/g, '""')}")`;
    return `<Cell ss:Formula="=${xlsAttrEscape(formula)}"><Data ss:Type="String">${xlsEscape(v.text ?? v.href)}</Data></Cell>`;
  }
  const isNum = typeof v === 'number' && Number.isFinite(v);
  return `<Cell><Data ss:Type="${isNum ? 'Number' : 'String'}">${xlsEscape(isNum ? v : (v ?? ''))}</Data></Cell>`;
}

export function buildXlsBlob(sheetName, headers, records) {
  const row = (cells) => `<Row>${cells.join('')}</Row>`;
  const headerRow = row(headers.map((h) => xlsCell(h)));
  const dataRows = records.map((r) => row(headers.map((h) => xlsCell(r[h])))).join('');
  const xml = `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Worksheet ss:Name="${xlsEscape(sheetName).slice(0, 31)}">
  <Table>
   ${headerRow}
   ${dataRows}
  </Table>
 </Worksheet>
</Workbook>`;
  return new Blob([xml], { type: 'application/vnd.ms-excel;charset=utf-8;' });
}

export function saveXls(sheetName, headers, records, filename) {
  const href = URL.createObjectURL(buildXlsBlob(sheetName, headers, records));
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10000);
}
