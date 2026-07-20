#!/usr/bin/env python3
"""
Re-probes every endpoint in apis.json and reports drift.

apis.json is a snapshot of live server behaviour taken on one day. Those claims
rot silently: a WAF rule lifts, a CORS header appears, an endpoint moves. Nothing
in the repo notices, and a reference map that is quietly wrong is worse than one
that admits it does not know.

This does NOT rewrite apis.json. A probe from a GitHub runner is not the same
observation as a probe from a person's machine — datacentre IPs get WAF-blocked
and geo-filtered in ways a local request is not, and data.gov.il already runs a
WAF that returns 403 HTML. Auto-committing would let one bad run overwrite
curated verdicts with an artefact of where the probe ran from. So: report,
and let a human confirm before the map changes.

CORS is checked the way the original probes checked it - by sending an Origin
header and reading back access-control-allow-origin. It is the field the whole
map turns on.

Usage:
    ./tools/probe.py                  probe and print a table
    ./tools/probe.py --check          exit 1 if anything drifted
    ./tools/probe.py --report OUT.md  write a markdown report
    ./tools/probe.py --json OUT.json  write raw results
"""

import argparse
import json
import ssl
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APIS = ROOT / "apis.json"

ORIGIN = "https://agmonr.github.io"
UA = "govapiportal-probe/1.0 (+https://github.com/agmonr/govapiportal)"
TIMEOUT = 25
ATTEMPTS = 3          # a single failure is usually the network, not the API
PAUSE = 0.7           # be a polite guest on someone else's servers


def family(value: str) -> str:
    """Coarse content family. Recorded formats are prose ('XML (SDMX)'), so
    comparing them literally would be noise; the family is the real signal."""
    v = (value or "").lower()
    for name in ("json", "xml", "html"):
        if name in v:
            return name
    return "other"


def probe_url(api: dict) -> str:
    """The example, when there is one - not the bare endpoint.

    Several of these APIs require parameters: datastore_search answers 409
    without a resource_id, CBS index/data/price answers 500 without an id. The
    recorded 200s describe the parameterised call, so probing the bare endpoint
    compares two different questions and reports drift that isn't there. (It
    did, on the first run.)
    """
    return api.get("example") or api["endpoint"]


def probe_once(api: dict) -> dict:
    """One request. Returns what the server actually did, or how it refused."""
    req = urllib.request.Request(
        probe_url(api),
        method=api.get("method", "GET"),
        # Nadlan's endpoint is a POST search; an empty body is what the original
        # probe sent and what the recorded 200 describes.
        data=b"" if api.get("method") == "POST" else None,
        headers={
            "User-Agent": UA,
            "Accept": "application/json, application/xml;q=0.9, */*;q=0.8",
            # Server-side CORS check: without an Origin, most servers omit the
            # header entirely and every API would look browser-hostile.
            "Origin": ORIGIN,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
            body = res.read(4096)
            return {
                "status": res.status,
                "cors": res.headers.get("access-control-allow-origin"),
                "ctype": (res.headers.get("content-type") or "").split(";")[0].strip(),
                "bytes": len(body),
                "error": None,
            }
    except urllib.error.HTTPError as e:
        # A 403/404 is a real answer about the endpoint, not a failed probe.
        return {
            "status": e.code,
            "cors": e.headers.get("access-control-allow-origin") if e.headers else None,
            "ctype": (e.headers.get("content-type") or "").split(";")[0].strip() if e.headers else "",
            "bytes": 0,
            "error": None,
        }
    except (urllib.error.URLError, ssl.SSLError, TimeoutError, OSError) as e:
        # No answer at all - unreachable, DNS, TLS, timeout.
        return {"status": None, "cors": None, "ctype": "", "bytes": 0,
                "error": type(e).__name__ + ": " + str(getattr(e, "reason", e))[:120]}


def probe(api: dict) -> dict:
    """Retry only unreachability. An HTTP status is an answer - retrying it
    would just mean asking a question we already got a reply to."""
    result = probe_once(api)
    for attempt in range(2, ATTEMPTS + 1):
        if result["error"] is None:
            break
        time.sleep(PAUSE * attempt)
        result = probe_once(api)
        result["attempts"] = attempt
    result.setdefault("attempts", 1)
    return result


def compare(api: dict, got: dict) -> list[str]:
    """Only the decision-relevant fields. Byte counts and exact content-types
    wobble harmlessly and would drown the real signal."""
    drift = []

    if got["error"]:
        drift.append(f"unreachable after {ATTEMPTS} attempts ({got['error']})")
        return drift

    if got["status"] != api["status"]:
        drift.append(f"HTTP {api['status']} → {got['status']}")

    was, now = api.get("cors"), got["cors"]
    # Some servers echo the requesting Origin instead of sending '*'. That value
    # is by definition different on every probe, so it is recorded as the
    # sentinel 'origin' and normalised here - otherwise iplan would report drift
    # every single week for behaving exactly as recorded.
    if now and now == ORIGIN:
        now = "origin"
    if bool(was) != bool(now):
        drift.append(f"CORS {was or 'absent'} → {now or 'absent'}"
                     + ("  ← now browser-callable" if now else "  ← no longer browser-callable"))
    elif was and now and was != now:
        drift.append(f"CORS value {was} → {now}")

    if got["status"] == 200:
        was_f, now_f = family(api["format"]), family(got["ctype"])
        if was_f != now_f and now_f != "other":
            drift.append(f"format {was_f} → {now_f} ({got['ctype']})")

    return drift


def run() -> tuple[list, list]:
    data = json.loads(APIS.read_text(encoding="utf-8"))
    rows, drifted = [], []

    for api in data["apis"]:
        if api["endpoint"] == "unknown":
            # Nothing to re-probe. Still listed so the report accounts for
            # every entry rather than quietly covering 11 of 13.
            rows.append({"api": api, "got": None, "drift": [], "skipped": True})
            continue

        got = probe(api)
        drift = compare(api, got)
        rows.append({"api": api, "got": got, "drift": drift, "skipped": False})
        if drift:
            drifted.append(rows[-1])
        time.sleep(PAUSE)

    return rows, drifted


def table(rows: list) -> str:
    out = []
    for r in rows:
        api, got = r["api"], r["got"]
        name = f"{api['source']} — {api['name']}"[:52]
        if r["skipped"]:
            out.append(f"  SKIP  {name:54} endpoint not identified")
        elif r["drift"]:
            out.append(f"  DRIFT {name:54} {'; '.join(r['drift'])}")
        else:
            out.append(f"  ok    {name:54} HTTP {got['status']} cors={got['cors'] or '✗'}")
    out.append("")
    out.append("Probed URLs:")
    for r in rows:
        if not r["skipped"]:
            out.append(f"  {r['api']['source']}: {probe_url(r['api'])}")
    return "\n".join(out)


def report(rows: list, drifted: list) -> str:
    probed = [r for r in rows if not r["skipped"]]
    # An outage and a changed contract both count as drift, but they call for
    # different actions - wait, versus edit the map. Reporting them in one
    # undifferentiated list would put that judgement on the reader every time.
    down = [r for r in drifted if r["got"] and r["got"]["error"]]
    changed = [r for r in drifted if r not in down]

    lines = [
        "## API drift detected",
        "",
        f"Re-probed {len(probed)} of {len(rows)} endpoints in `apis.json`. "
        f"**{len(changed)} changed**, **{len(down)} unreachable**.",
        "",
    ]

    if changed:
        lines += [
            "### Contract changed — the map may now be wrong",
            "",
            "| API | Change | Probed |",
            "|---|---|---|",
        ]
        for r in changed:
            api = r["api"]
            lines.append(f"| `{api['source']}` — {api['name']} | " + "<br>".join(r["drift"])
                         + f" | `{probe_url(api)}` |")
        lines.append("")

    if down:
        lines += [
            "### Unreachable — probably an outage, not a change",
            "",
            "No answer at all after retries. Usually the host is down and the recorded",
            "values are still correct; only edit the map if this persists for weeks.",
            "",
            "| API | Error | Probed |",
            "|---|---|---|",
        ]
        for r in down:
            api = r["api"]
            lines.append(f"| `{api['source']}` — {api['name']} | {r['got']['error']} | `{probe_url(api)}` |")
        lines.append("")

    lines += [
        "",
        "### Before editing `apis.json`",
        "",
        "This probe ran from a GitHub runner. A datacentre IP is not the same",
        "client as a person's browser — WAFs and geo-filters treat it differently,",
        "and data.gov.il already runs a WAF that answers 403 with an HTML page.",
        "**Re-probe by hand from a normal connection before changing the map:**",
        "",
        "```bash",
        f'curl -s -i -H "Origin: {ORIGIN}" "<endpoint>" | head -20',
        "```",
        "",
        "A CORS change is the one that matters most: it moves an API between",
        "*browser-callable* and *server-only*, which is the decision the map exists",
        "to answer.",
        "",
        "<details><summary>Full probe results</summary>",
        "",
        "```",
        table(rows),
        "```",
        "",
        "</details>",
        "",
        "---",
        "*Opened by `tools/probe.py` via the scheduled `probe.yml` workflow.*",
    ]
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description="Re-probe apis.json and report drift.")
    ap.add_argument("--check", action="store_true", help="exit 1 if anything drifted")
    ap.add_argument("--report", metavar="FILE", help="write a markdown report")
    ap.add_argument("--json", metavar="FILE", help="write raw results")
    args = ap.parse_args()

    print(f"Probing endpoints in apis.json (Origin: {ORIGIN})\n")
    rows, drifted = run()
    print(table(rows))

    probed = [r for r in rows if not r["skipped"]]
    print(f"\n{len(probed)} probed, {len(rows) - len(probed)} skipped, {len(drifted)} drifted")

    if args.json:
        Path(args.json).write_text(json.dumps(
            [{"name": r["api"]["name"], "source": r["api"]["source"],
              "endpoint": r["api"]["endpoint"], "recorded": {
                  "status": r["api"]["status"], "cors": r["api"]["cors"], "format": r["api"]["format"]},
              "observed": r["got"], "drift": r["drift"]} for r in rows],
            ensure_ascii=False, indent=2), encoding="utf-8")

    if args.report and drifted:
        Path(args.report).write_text(report(rows, drifted), encoding="utf-8")
        print(f"wrote {args.report}")

    if args.check and drifted:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
