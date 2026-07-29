/**
 * Best-effort, hand-rolled PDF text extraction - no library, matching this
 * site's no-CDN policy. Reads a PDF's own object streams directly: finds
 * every FlateDecode stream, inflates it with the browser's own
 * DecompressionStream('deflate') (zlib format, exactly what /FlateDecode
 * is), then regex-parses PDF's text-showing operators (Tj/TJ, spec 9.4.3)
 * and any /ToUnicode CMap streams (beginbfchar/beginbfrange, spec 9.10.3)
 * to turn glyph codes back into real Unicode text.
 *
 * Written and tuned against a real protocol PDF pulled from
 * archive.gis-net.co.il (committees.js's own document source): 14 pages,
 * FlateDecode content streams, a /Type0 /Identity-H embedded TrueType font
 * with a /ToUnicode CMap - confirmed with `pdftotext` that the file's own
 * text is cleanly extractable, so a 2-byte-per-glyph reading through the
 * merged CMap is the primary path, not a guess.
 *
 * Deliberately NOT a PDF renderer: no font metrics, no layout, no encrypted-
 * PDF support, no non-Flate filters (ASCIIHex/LZW/CCITT/JBIG2 etc. are
 * skipped, not guessed at). ToUnicode maps from every embedded font are
 * merged into one global lookup rather than tracked per-font/per-resource -
 * correct for the common case of one or two embedded fonts per document,
 * but can misattribute a glyph code shared by two different fonts in the
 * same file. This is a search index, not a transcript: good enough to find
 * a document by a phrase it contains, not to quote it reliably.
 */

const CHUNK = 0x8000; // String.fromCharCode.apply's argument-count ceiling is well above this; kept small purely for steady memory use over a multi-MB file

function bytesToBinaryString(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return s;
}

function binaryStringToBytes(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i += 1) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Every `N G obj ... endobj` block's raw text - the only structural fact
 *  this needs from the file. A full linear scan skips the xref table and
 *  trailer entirely (built for random access, which a one-shot extraction
 *  never needs) and is just as complete for finding every object. */
function findObjects(fileStr) {
  const objs = [];
  const re = /\d+\s+\d+\s+obj([\s\S]*?)endobj/g;
  let m;
  while ((m = re.exec(fileStr))) objs.push(m[1]);
  return objs;
}

/** Pulls the raw stream payload out of one object body, honouring the
 *  spec's exact "stream" + EOL .. EOL + "endstream" framing (the EOL run
 *  right before endstream is not part of the payload). The /Length value is
 *  ignored on purpose: in a single linear pass it may be an indirect
 *  reference this scan hasn't resolved yet, while endstream is a simpler,
 *  self-contained anchor - the rare false match inside binary image data is
 *  an acceptable cost for a best-effort text search. */
function streamPayload(body) {
  const m = /stream(?:\r\n|\n|\r)([\s\S]*?)(?:\r\n|\n|\r)?endstream/.exec(body);
  return m ? m[1] : null;
}

function isFlate(head) {
  return /\/Filter\s*(?:\/FlateDecode|\[[^\]]*\/FlateDecode)/.test(head);
}

/* ---------- ToUnicode CMaps ---------- */

function hexToUtf16String(hex) {
  const clean = hex.replace(/\s+/g, '');
  const units = [];
  for (let i = 0; i + 4 <= clean.length; i += 4) units.push(parseInt(clean.slice(i, i + 4), 16));
  return String.fromCharCode(...units);
}

/** beginbfchar/endbfchar: literal <src> <dst> pairs. beginbfrange/endbfrange:
 *  either <srcLo> <srcHi> <dst> (dst increments per code in the range) or
 *  <srcLo> <srcHi> [<dst> <dst> ...] (explicit per-code list). Both range
 *  forms are mutually exclusive to match (one needs a bare <...> third
 *  group, the other a [...]), so scanning the same body with both regexes
 *  never double-counts an entry. */
function parseCMap(cmapText, map) {
  const charRe = /beginbfchar([\s\S]*?)endbfchar/g;
  let cm;
  while ((cm = charRe.exec(cmapText))) {
    const pairRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let p;
    while ((p = pairRe.exec(cm[1]))) map.set(p[1].toUpperCase().padStart(4, '0').slice(-4), hexToUtf16String(p[2]));
  }

  const rangeRe = /beginbfrange([\s\S]*?)endbfrange/g;
  let rm;
  while ((rm = rangeRe.exec(cmapText))) {
    const body = rm[1];

    const singleRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let s;
    while ((s = singleRe.exec(body))) {
      const lo = parseInt(s[1], 16); const hi = parseInt(s[2], 16);
      const dstBase = parseInt(s[3], 16);
      for (let code = lo; code <= hi && code - lo < 65536; code += 1) {
        const dstHex = (dstBase + (code - lo)).toString(16).padStart(s[3].length, '0');
        map.set(code.toString(16).toUpperCase().padStart(4, '0').slice(-4), hexToUtf16String(dstHex));
      }
    }

    const arrRe = /<([0-9A-Fa-f]+)>\s*<[0-9A-Fa-f]+>\s*\[([\s\S]*?)\]/g;
    let a;
    while ((a = arrRe.exec(body))) {
      const lo = parseInt(a[1], 16);
      const dsts = [...a[2].matchAll(/<([0-9A-Fa-f]+)>/g)].map((x) => x[1]);
      dsts.forEach((dstHex, i) => map.set((lo + i).toString(16).toUpperCase().padStart(4, '0').slice(-4), hexToUtf16String(dstHex)));
    }
  }
}

/* ---------- content-stream text extraction ---------- */

/** PDF literal-string escapes, spec 7.3.4.2: \n \r \t \b \f \( \) \\ , a
 *  backslash-newline line continuation (produces nothing), and octal \ddd. */
function unescapePdfLiteral(inner) {
  return inner.replace(/\\(?:(n|r|t|b|f|\(|\)|\\)|(\r\n|\r|\n)|([0-7]{1,3}))/g, (_, esc1, cont, oct) => {
    if (cont != null) return '';
    if (oct != null) return String.fromCharCode(parseInt(oct, 8));
    return { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }[esc1];
  });
}

function binaryStringFromHex(hex) {
  let clean = hex.replace(/\s+/g, '');
  if (clean.length % 2) clean += '0';
  let s = '';
  for (let i = 0; i < clean.length; i += 2) s += String.fromCharCode(parseInt(clean.slice(i, i + 2), 16));
  return s;
}

/** raw: bytes straight off the page, as a binary string. Two bytes per
 *  glyph code is the near-universal reading for an embedded Identity-H
 *  subset font (confirmed against a real protocol PDF, see file header
 *  above) and is tried first; if that yields zero mapped characters at all,
 *  falls back to one byte per code for whatever simple/non-Type0 font this
 *  wasn't tested against - unmapped bytes in that fallback still get shown
 *  as-is when they're plain printable ASCII (numbers, Latin headings are
 *  common even in Hebrew documents), never invented for anything else. */
function decodeCodes(raw, cmap) {
  let out = '';
  let hits = 0;
  for (let i = 0; i + 2 <= raw.length; i += 2) {
    const code = ((raw.charCodeAt(i) << 8) | raw.charCodeAt(i + 1)).toString(16).toUpperCase().padStart(4, '0');
    const ch = cmap.get(code);
    if (ch) { out += ch; hits += 1; } else out += ' ';
  }
  if (hits > 0) return out;

  let fallback = '';
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0');
    const ch = cmap.get(code);
    const byte = raw.charCodeAt(i);
    fallback += ch || (byte >= 32 && byte < 127 ? raw[i] : ' ');
  }
  return fallback;
}

/** PDF text positioning always advances left-to-right per glyph shown,
 *  regardless of script - so a generator writing a right-to-left Hebrew run
 *  feeds its characters in reverse (last logical character first) to make
 *  it land correctly on the page. decodeCodes() above decodes each glyph
 *  code to the right Unicode character via the CMap, but in that same
 *  reversed order - confirmed against a real protocol PDF, where every
 *  Hebrew word came out spelled backwards until this reversal was added.
 *  Only reversed when the run actually contains Hebrew: a pure-digit/Latin
 *  run (a date, a plan number) is generally NOT written in reverse to begin
 *  with, so reversing it too would scramble it instead of fixing it. A run
 *  that mixes Hebrew and digits in one Tj call (rather than the generator
 *  splitting them into separate calls) is the one case this still gets
 *  wrong - full bidi reordering (UAX #9) is out of scope for a search
 *  index. */
function reverseIfHebrew(s) {
  return /[֐-׿]/.test(s) ? [...s].reverse().join('') : s;
}

function extractStreamText(streamStr, cmap) {
  let text = '';

  const litRe = /\(((?:\\.|[^()\\])*)\)\s*(?:Tj|'|")/g;
  let m;
  while ((m = litRe.exec(streamStr))) text += `${reverseIfHebrew(decodeCodes(unescapePdfLiteral(m[1]), cmap))} `;

  const hexRe = /<([0-9A-Fa-f\s]*)>\s*Tj/g;
  while ((m = hexRe.exec(streamStr))) text += `${reverseIfHebrew(decodeCodes(binaryStringFromHex(m[1]), cmap))} `;

  const tjArrRe = /\[((?:[^[\]]|\\.)*)\]\s*TJ/g;
  while ((m = tjArrRe.exec(streamStr))) {
    const partRe = /\(((?:\\.|[^()\\])*)\)|<([0-9A-Fa-f\s]*)>/g;
    let p;
    let line = '';
    while ((p = partRe.exec(m[1]))) {
      line += p[1] != null ? decodeCodes(unescapePdfLiteral(p[1]), cmap) : decodeCodes(binaryStringFromHex(p[2]), cmap);
    }
    text += `${reverseIfHebrew(line)} `;
  }

  return `${text}\n`;
}

/**
 * @param {ArrayBuffer|Uint8Array} data raw PDF bytes
 * @returns {Promise<string>} best-effort extracted text (order follows
 *   object order in the file, which usually but not necessarily matches
 *   visual page order)
 */
export async function extractPdfText(data) {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('הדפדפן הזה לא תומך ב-DecompressionStream, הדרוש לפענוח PDF (זמין בכל דפדפן מודרני).');
  }
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const fileStr = bytesToBinaryString(bytes);
  const bodies = findObjects(fileStr);

  const streams = [];
  for (const body of bodies) {
    const payload = streamPayload(body);
    if (!payload) continue;
    const head = body.slice(0, body.indexOf('stream'));
    if (/\/Subtype\s*\/Image/.test(head)) continue; // pixels, not text
    if (!isFlate(head)) { streams.push(payload); continue; } // uncompressed content stream - rare but valid
    try { streams.push(bytesToBinaryString(await inflate(binaryStringToBytes(payload)))); } catch { /* not really Flate, or corrupt - skip */ }
  }

  const cmap = new Map();
  for (const s of streams) if (s.includes('beginbfchar') || s.includes('beginbfrange')) parseCMap(s, cmap);

  let out = '';
  for (const s of streams) {
    if (s.includes('beginbfchar') || s.includes('beginbfrange')) continue;
    if (!/\b(?:Tj|TJ)\b/.test(s)) continue;
    out += extractStreamText(s, cmap);
  }
  return out;
}
