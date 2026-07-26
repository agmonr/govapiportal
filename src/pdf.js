/**
 * A minimal, hand-rolled single-page PDF writer: one JPEG image filling the
 * page, plus clickable Link annotations over it. No library, no CDN - the
 * one thing this site has never needed until now is genuinely small enough
 * to write by hand: a PDF page is just text-format objects plus one binary
 * stream, and DCTDecode lets a JPEG's own bytes go in as-is, with no need to
 * implement JPEG or Flate compression ourselves.
 *
 * Verified against pypdf (Python) while developing this: image decodes to
 * the exact source pixels, annotation Rects and URIs round-trip exactly,
 * including URLs containing '(', ')' or '\' (escaped per the PDF string
 * spec below).
 */

/**
 * @param {Object} args
 * @param {Uint8Array} args.jpegBytes - raw JPEG file bytes (e.g. from canvas.convertToBlob)
 * @param {number} args.width
 * @param {number} args.height
 * @param {{url: string, x0: number, y0: number, x1: number, y1: number}[]} args.links
 *   Rects in the same pixel space as the image, origin top-left - this
 *   function flips to PDF's bottom-up convention internally.
 * @returns {Blob} application/pdf
 */
export function buildPdf({ jpegBytes, width, height, links }) {
  const chunks = [];
  let offset = 0;
  const enc = new TextEncoder();

  const push = (bytes) => { chunks.push(bytes); offset += bytes.length; };
  const pushText = (s) => push(enc.encode(s));

  const offsets = [];
  const beginObj = (n) => { offsets[n] = offset; pushText(`${n} 0 obj\n`); };
  const endObj = () => pushText('endobj\n');

  const nAnnots = links.length;
  // Object numbering: 1 catalog, 2 pages, 3 page, 4 image, 5 content stream,
  // 6..(5+nAnnots) link annotations.
  const annotRefs = links.map((_, i) => `${6 + i} 0 R`).join(' ');

  pushText('%PDF-1.4\n');

  beginObj(1);
  pushText('<< /Type /Catalog /Pages 2 0 R >>\n');
  endObj();

  beginObj(2);
  pushText('<< /Type /Pages /Kids [3 0 R] /Count 1 >>\n');
  endObj();

  beginObj(3);
  pushText(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] `
    + `/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R `
    + `/Annots [ ${annotRefs} ] >>\n`,
  );
  endObj();

  beginObj(4);
  pushText(
    `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} `
    + `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`,
  );
  push(jpegBytes);
  pushText('\nendstream\n');
  endObj();

  // cm scales the default 1x1 image space to the full page, positioned at
  // the origin - the standard "one image, whole page" content stream.
  const content = `q\n${width} 0 0 ${height} 0 0 cm\n/Im0 Do\nQ\n`;
  beginObj(5);
  pushText(`<< /Length ${enc.encode(content).length} >>\nstream\n${content}endstream\n`);
  endObj();

  links.forEach((link, i) => {
    beginObj(6 + i);
    // PDF literal-string escaping: backslash and parens are the only
    // characters that must be escaped for a URI to round-trip safely.
    const uri = link.url.replace(/[()\\]/g, (c) => `\\${c}`);
    // PDF y is bottom-up; the caller's rect is in top-down pixel space.
    const y0 = height - link.y1;
    const y1 = height - link.y0;
    pushText(
      `<< /Type /Annot /Subtype /Link /Rect [${link.x0.toFixed(2)} ${y0.toFixed(2)} `
      + `${link.x1.toFixed(2)} ${y1.toFixed(2)}] /Border [0 0 0] `
      + `/A << /Type /Action /S /URI /URI (${uri}) >> >>\n`,
    );
    endObj();
  });

  const xrefStart = offset;
  const totalObjs = 5 + nAnnots;
  pushText(`xref\n0 ${totalObjs + 1}\n`);
  pushText('0000000000 65535 f \n');
  for (let i = 1; i <= totalObjs; i++) {
    pushText(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  }
  pushText(`trailer\n<< /Size ${totalObjs + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`);

  return new Blob(chunks, { type: 'application/pdf' });
}
