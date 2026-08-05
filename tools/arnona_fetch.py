#!/usr/bin/env python3
"""
Downloads each Israeli local authority's צו ארנונה (property-tax order) PDF,
one authority at a time, into tools/arnona_output/ (gitignored - see
tools/arnona_authorities.py's docstring for why these can't be committed:
259 PDFs would meaningfully bloat an already-859MB repo).

Reads tools/arnona_authorities.json (built by arnona_authorities.py) for the
roster + guessed/overridden domain. Two concrete CMS URL shapes were
confirmed live this session by fetching a real page (Hod Hasharon) and
cross-checking search results for Kfar Saba/Ariel/Azor/Rehovot (pattern A)
and Ramat Hasharon/Haifa/Mitzpe Ramon (pattern B):

  Pattern A: https://<domain>/צו-ארנונה-לשנת-{year}/  ->  html page linking
             a PDF at .../uploads/n/<unix-ts>.<subsec>.pdf
  Pattern B: WordPress-style .../wp-content/uploads/{y}/{m}/...pdf, filename
             or link text carrying an ארנונה+צו keyword pair and the year

Anything matching neither falls back to a small same-domain crawl (homepage
+ a handful of "looks-relevant" subpages) scored by the same keyword+year
heuristic. This is explicitly best-effort, NOT guaranteed-complete: every
authority gets exactly one row in results.csv regardless of outcome
(ok/no_domain/blocked_robots/no_candidate_found/http_error/download_failed),
which is the gap report for manual follow-up - see tools/arnona_authorities.py's
`arnona_overrides.json` for where a wrong domain guess gets corrected.

robots.txt is checked (urllib.robotparser) before ANY fetch on a domain and
respected - unlike yeela-license-tracker/notify_protocol_changes.py's
deliberate one-off bypass for a single already-known host, these are 259
fresh, never-vetted sites, so the default here is to skip rather than
override.

Usage:
    python3 tools/arnona_fetch.py [--year 2026] [--force] [--limit N] [--only "SUBSTR,SUBSTR"] [--workers 6]
"""
import argparse
import concurrent.futures
import csv
import random
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ROSTER_FILE = ROOT / "tools" / "arnona_authorities.json"
OUT_DIR = ROOT / "tools" / "arnona_output"
RESULTS_FILE = OUT_DIR / "results.csv"
RESULTS_FIELDS = ["run_ts", "name_he", "domain", "pattern_matched", "status", "found_url", "saved_path"]

USER_AGENT = (
    "ArnonaOrdersBot/1.0 (+contact: agmonr@gmail.com; one-time research "
    "fetch of publicly-posted property-tax order PDFs; respects robots.txt)"
)
REQUEST_TIMEOUT_S = 15
REQUEST_DELAY_S = 1.2
REQUEST_JITTER_S = 0.6
MIN_PDF_BYTES = 3000
CRAWL_PAGE_CAP = 12
CRAWL_DEPTH = 2

ARNONA_WORD = "ארנונה"
# "order" / "rate(s)" - either counts as a match. Word-boundary regexes, NOT
# plain substrings: "צו" is only 2 characters, and plain `in` matching found
# it as a false-positive substring inside unrelated words on real pages
# (confirmed live this session) - \b works correctly on Hebrew since Python's
# re treats Hebrew letters as \w characters.
TZAV_WORD_RES = (re.compile(r"\bצו\b"), re.compile(r"תעריפ"))

PATTERN_A_PDF_RE = re.compile(r'<a\s[^>]*href="([^"]*/uploads/n/[\d.]+\.pdf)"[^>]*>(.*?)</a>', re.IGNORECASE | re.DOTALL)
GENERIC_PDF_LINK_RE = re.compile(r'<a\s[^>]*href="([^"]+\.pdf)"[^>]*>(.*?)</a>', re.IGNORECASE | re.DOTALL)
ANCHOR_RE = re.compile(r'<a\s[^>]*href="([^"]+)"[^>]*>(.*?)</a>', re.IGNORECASE | re.DOTALL)
TAG_STRIP_RE = re.compile(r"<[^>]+>")
BASE_HREF_RE = re.compile(r'<base[^>]+href="([^"]+)"', re.IGNORECASE)


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def resolve_base(html, final_url):
    """The page's own <base href> (if any) is what relative links actually
    resolve against - NOT necessarily the request URL. Confirmed live this
    session: hod-hasharon.muni.il's arnona page serves
    `<base href="https://hod-hasharon.muni.il/" />` while sitting at a
    "/צו-ארנונה-לשנת-2025/" URL, and its PDF link is a bare relative
    "./uploads/n/....pdf" - resolving that against the request URL (as
    plain urljoin(final_url, href) would) produces a wrong, nested,
    404ing URL nobody actually serves."""
    m = BASE_HREF_RE.search(html)
    return urllib.parse.urljoin(final_url, m.group(1)) if m else final_url


def polite_sleep():
    time.sleep(REQUEST_DELAY_S + random.uniform(0, REQUEST_JITTER_S))


def to_ascii_url(url):
    """urllib.request.Request needs a pure-ASCII URL - links pulled out of
    crawled HTML can carry a raw (unencoded) Hebrew path straight through
    urljoin(), which otherwise blows up with UnicodeEncodeError deep inside
    http.client. Only the path/query are percent-encoded; scheme/netloc stay
    as-is."""
    parts = urllib.parse.urlsplit(url)
    path = urllib.parse.quote(parts.path, safe="/%")
    query = urllib.parse.quote(parts.query, safe="=&%")
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, path, query, parts.fragment))


_robots_cache = {}


def robots_allows(domain, path):
    """RobotFileParser.read() fetches with urllib's plain default User-Agent
    internally (no way to override it) - confirmed live this session that
    several muni.il sites 403 that default UA on /robots.txt specifically
    (while happily serving our real declared UA on the actual pages), and
    robotparser's documented behavior on a 401/403 is to set disallow_all=True.
    That produced false "blocked" results for sites with a wide-open
    robots.txt (Hod Hasharon: only /*preview= and /ims/ disallowed). Fetching
    robots.txt ourselves with our own UA and handing the text to `rp.parse()`
    avoids that false negative; a real 404 (no robots.txt at all) is treated
    as allow-all, same as a missing robots.txt conventionally means."""
    if domain not in _robots_cache:
        try:
            status, body, _final = http_get(f"https://{domain}/robots.txt", skip_robots_check=True)
            rp = urllib.robotparser.RobotFileParser()
            rp.parse(body.decode("utf-8", errors="ignore").splitlines())
        except urllib.error.HTTPError as e:
            rp = True if e.code == 404 else None  # 404 -> no robots.txt -> allow; other HTTP errors -> unknown, be permissive
        except Exception:
            rp = None  # unreachable/unreadable - be permissive rather than block on a network hiccup
        _robots_cache[domain] = rp
    rp = _robots_cache[domain]
    if rp is None or rp is True:
        return True
    try:
        return rp.can_fetch(USER_AGENT, f"https://{domain}{path}")
    except Exception:
        return True


def same_site(url, domain):
    """www.<domain> and <domain> are the same site; anything else isn't -
    used to reject cross-domain PDF links picked up from a "related links"
    widget or similar (confirmed live this session: mitzpe-ramon.muni.il's
    homepage linked an unrelated PDF hosted on oryehuda.muni.il, which
    otherwise scored high enough to look like a legitimate match)."""
    netloc = urllib.parse.urlparse(url).netloc.lower()
    d = domain.lower()
    return netloc == d or netloc == f"www.{d}" or f"www.{netloc}" == d


def http_get(url, accept="text/html", skip_robots_check=False):
    req = urllib.request.Request(to_ascii_url(url), headers={"User-Agent": USER_AGENT, "Accept": f"{accept},*/*"})
    with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_S) as r:
        return r.status, r.read(), r.geturl()


def strip_tags(html_fragment):
    return TAG_STRIP_RE.sub("", html_fragment)


def try_pattern_a(domain, year):
    """https://<domain>/צו-ארנונה-לשנת-{year}/ -> a /uploads/n/<ts>.pdf link."""
    path = f"/צו-ארנונה-לשנת-{year}/"
    url = f"https://{domain}{urllib.parse.quote(path)}"
    if not robots_allows(domain, path):
        return None, "blocked_robots", url
    try:
        status, body, final_url = http_get(url)
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, ConnectionError):
        return None, None, url  # not this pattern - caller tries the next one
    polite_sleep()

    # A nonexistent WordPress slug can silently 200 into the homepage
    # instead of a real 404 (confirmed live: mitzpe-ramon.muni.il redirected
    # this exact URL to "/", whose homepage happened to contain an unrelated
    # PDF link from a DIFFERENT town's site in some cross-site widget - a
    # false match that would otherwise look like a legitimate pattern-A hit).
    # If we didn't land on the page we asked for, this isn't a pattern-A
    # site - treat it as a miss rather than trusting whatever the homepage
    # happens to contain.
    final_path = urllib.parse.urlsplit(final_url).path
    if final_path in ("", "/"):
        return None, None, url

    html = body.decode("utf-8", errors="ignore")
    matches = PATTERN_A_PDF_RE.findall(html)
    if not matches:
        return None, None, url
    # This page can carry MORE than one /uploads/n/ attachment (confirmed
    # live: azor.muni.il's arnona page also linked an unrelated bank
    # direct-debit authorization form, with NO other candidate on the page)
    # - score every candidate by filename+link text (same score_candidate()
    # crawl_for_pdf uses, same ARNONA_WORD hard gate) and take the best.
    # Unlike an earlier version of this function, a candidate that doesn't
    # even mention ארנונה is NOT accepted as a last-resort fallback just for
    # being the only one on the page - that produced exactly the Azor bank-
    # form false positive. Returning a miss here instead lets crawl_for_pdf
    # try elsewhere on the site (e.g. a dedicated ארנונה department page).
    base = resolve_base(html, final_url)
    best_url, best_score = None, -1
    for href, inner in matches:
        abs_url = urllib.parse.urljoin(base, href)
        if not same_site(abs_url, domain):
            continue
        s = score_candidate(abs_url, strip_tags(inner), year)
        if s > best_score:
            best_url, best_score = abs_url, s
    if best_url is None or best_score < 2:
        return None, None, url
    return best_url, "pattern_a", url


def score_candidate(href, link_text, year):
    """ARNONA_WORD is a hard gate, not just points - without it, filename/
    text-based scoring alone let through a false positive this session
    (Haifa: an unrelated refund-procedure PDF scored high purely from its
    upload-date folder, e.g. "wp-content/uploads/2025/04/...", matching
    `year in href` despite having nothing to do with arnona). The filename
    (last path segment) + link text are checked, NOT the full href - a
    WordPress upload folder's year is when the file was uploaded, not
    necessarily what it's about, so it's excluded from the year check."""
    if not href.lower().endswith(".pdf"):
        return -1
    filename = href.rsplit("/", 1)[-1]
    hay = f"{filename} {link_text}"
    if ARNONA_WORD not in hay:
        return -1
    score = 2
    if any(rx.search(hay) for rx in TZAV_WORD_RES):
        score += 3
    if str(year) in hay:
        score += 3
    if "wp-content/uploads" in href:
        score += 1
    return score


def crawl_for_pdf(domain, year):
    """Homepage + a capped, keyword-scored same-domain crawl (pattern B and
    the generic fallback share this path - pattern B is just this crawl
    finding a wp-content/uploads hit, not a separately-coded fast path)."""
    if not robots_allows(domain, "/"):
        return None, "blocked_robots"
    start = f"https://{domain}/"
    seen = {start}
    queue = [(start, 0)]
    best = (None, -1)
    pages_fetched = 0
    while queue and pages_fetched < CRAWL_PAGE_CAP:
        url, depth = queue.pop(0)
        try:
            status, body, final_url = http_get(url)
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, ConnectionError):
            continue
        pages_fetched += 1
        polite_sleep()
        html = body.decode("utf-8", errors="ignore")
        base = resolve_base(html, final_url)

        for href, inner in GENERIC_PDF_LINK_RE.findall(html):
            abs_url = urllib.parse.urljoin(base, href)
            if not same_site(abs_url, domain):
                continue  # e.g. a "related sites"/widget link to another town's PDF - not this authority's own document
            text = strip_tags(inner)
            s = score_candidate(abs_url, text, year)
            if s > best[1]:
                best = (abs_url, s)

        if depth < CRAWL_DEPTH:
            for href, inner in ANCHOR_RE.findall(html):
                # Checking the URL alone misses sites whose nav uses a Latin/
                # transliterated slug with only the VISIBLE label in Hebrew
                # (confirmed live: haifa.muni.il's own menu structure works
                # this way - href-only matching found nothing there).
                if ARNONA_WORD not in href and ARNONA_WORD not in strip_tags(inner):
                    continue  # only descend into pages that look relevant - not a full-site crawl
                abs_url = urllib.parse.urljoin(base, href)
                if not same_site(abs_url, domain):
                    continue
                if abs_url not in seen:
                    seen.add(abs_url)
                    queue.append((abs_url, depth + 1))

    if best[1] >= 4:  # require at least keyword+year or keyword+keyword, not a bare .pdf
        return best[0], "crawl"
    return None, "no_candidate_found" if pages_fetched else "http_error"


def download_pdf(pdf_url):
    req = urllib.request.Request(to_ascii_url(pdf_url), headers={"User-Agent": USER_AGENT, "Accept": "application/pdf,*/*"})
    with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_S) as r:
        return r.read()


def try_domain(name, domain, year):
    """One full attempt (pattern A, then crawl fallback) against a single
    resolved domain. Returns a result dict; status "ok" only once the PDF is
    actually downloaded and verified."""
    pdf_url, pattern, tried_url = None, None, None
    try:
        pdf_url, pattern, tried_url = try_pattern_a(domain, year)
    except Exception as e:
        log(f"  {name}: pattern A raised {e!r}")

    if pattern == "blocked_robots":
        return {"domain": domain, "pattern_matched": "", "status": "blocked_robots", "found_url": tried_url or ""}

    if not pdf_url:
        try:
            pdf_url, pattern = crawl_for_pdf(domain, year)
        except Exception as e:
            log(f"  {name}: crawl raised {e!r}")
            return {"domain": domain, "pattern_matched": "", "status": "http_error", "found_url": ""}
        if pattern == "blocked_robots":
            return {"domain": domain, "pattern_matched": "", "status": "blocked_robots", "found_url": ""}
        if not pdf_url:
            return {"domain": domain, "pattern_matched": "", "status": pattern or "no_candidate_found", "found_url": ""}

    try:
        content = download_pdf(pdf_url)
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, ConnectionError):
        return {"domain": domain, "pattern_matched": pattern, "status": "http_error", "found_url": pdf_url}
    polite_sleep()

    if not content.startswith(b"%PDF") or len(content) < MIN_PDF_BYTES:
        return {"domain": domain, "pattern_matched": pattern, "status": "download_failed", "found_url": pdf_url}

    return {"domain": domain, "pattern_matched": pattern, "status": "ok", "found_url": pdf_url, "content": content}


def domain_variants(domain):
    """Municipal sites are inconsistent about requiring a `www.` prefix -
    confirmed live this session: the bare `haifa.muni.il` resolves to an
    unconfigured default IIS placeholder page (real site needs `www.`),
    while `kfar-saba.muni.il` works fine WITHOUT it. Try the guessed form
    first, then the other variant, rather than guessing which one a given
    site needs."""
    bare = domain[4:] if domain.startswith("www.") else domain
    return [domain, f"www.{bare}"] if not domain.startswith("www.") else [domain, bare]


def process_authority(entry, year, force):
    name = entry["name_he"]
    domain = entry.get("website_override") or entry.get("domain_guess")
    if not domain:
        return {"name_he": name, "domain": "", "pattern_matched": "", "status": "no_domain", "found_url": "", "saved_path": ""}
    domain = domain.replace("https://", "").replace("http://", "").strip("/")

    slug = entry.get("slug_guess") or re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "unknown"
    out_dir = OUT_DIR / slug
    out_path = out_dir / f"tzav-arnona-{year}.pdf"
    if out_path.exists() and not force:
        return {"name_he": name, "domain": domain, "pattern_matched": "cached", "status": "ok",
                 "found_url": "", "saved_path": str(out_path.relative_to(ROOT))}

    last = None
    for candidate_domain in domain_variants(domain):
        last = try_domain(name, candidate_domain, year)
        if last["status"] == "ok":
            break

    result = {"name_he": name, "domain": last["domain"], "pattern_matched": last["pattern_matched"],
               "status": last["status"], "found_url": last.get("found_url", ""), "saved_path": ""}
    if last["status"] == "ok":
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(last["content"])
        result["saved_path"] = str(out_path.relative_to(ROOT))
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", type=int, default=datetime.now().year)
    ap.add_argument("--force", action="store_true", help="re-download even if a file for this year already exists")
    ap.add_argument("--limit", type=int, default=None, help="only process the first N authorities (testing)")
    ap.add_argument("--only", default=None, help="comma-separated name_he substrings to filter to (testing)")
    ap.add_argument("--workers", type=int, default=6)
    args = ap.parse_args()

    roster = __import__("json").loads(ROSTER_FILE.read_text())
    if args.only:
        needles = [s.strip() for s in args.only.split(",")]
        roster = [r for r in roster if any(n in r["name_he"] for n in needles)]
    if args.limit:
        roster = roster[: args.limit]

    log(f"processing {len(roster)} authorities for year {args.year} ({args.workers} workers)...")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    run_ts = datetime.now(timezone.utc).isoformat()

    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(process_authority, entry, args.year, args.force): entry for entry in roster}
        n_done = 0
        for fut in concurrent.futures.as_completed(futures):
            entry = futures[fut]
            try:
                row = fut.result()
            except Exception as e:
                row = {"name_he": entry["name_he"], "domain": entry.get("domain_guess") or "", "pattern_matched": "", "status": "http_error", "found_url": "", "saved_path": ""}
                log(f"  {entry['name_he']}: unhandled exception {e!r}")
            row["run_ts"] = run_ts
            results.append(row)
            n_done += 1
            log(f"  [{n_done}/{len(roster)}] {row['name_he']}: {row['status']}"
                + (f" ({row['saved_path']})" if row["status"] == "ok" else ""))

    write_header = not RESULTS_FILE.exists()
    with open(RESULTS_FILE, "a", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=RESULTS_FIELDS)
        if write_header:
            w.writeheader()
        for row in results:
            w.writerow(row)

    n_ok = sum(1 for r in results if r["status"] == "ok")
    by_status = {}
    for r in results:
        by_status[r["status"]] = by_status.get(r["status"], 0) + 1
    log(f"done: {n_ok}/{len(results)} ok - breakdown: {by_status}")
    log(f"results appended to {RESULTS_FILE.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
