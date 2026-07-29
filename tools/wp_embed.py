#!/usr/bin/env python3
"""
Generates dist/wordpress-embed.html - a self-contained HTML fragment meant
to be pasted into a WordPress "Custom HTML" block (not a full document: no
<!doctype>/<html>/<head>, since WordPress supplies those itself).

Visually this must look exactly like the "אפליקציות" grid on apps.html -
same icon+name tiles, same grouping/heading/colors - so the markup and CSS
values below are ported by hand from src/apps.js (appCard,
renderAppsByCategory) and src/style.css (.apps-grid/.app-tile/.app-icon/
.app-name/.apps-category-h and friends), scoped under one wrapper class so
they can't leak into - or be overridden by - the host WordPress theme.

Every app's long "about" text is NOT rendered as visible copy (that would
no longer look like apps.html's plain icon tiles) - it exists only as
metadata for search engines: the JSON-LD ItemList's "description" field.
The only visible per-tile text mirrors the real site exactly too: a
one-line hover title (oneLineSummary, same first-sentence/90-char rule as
src/apps.js), not the full paragraph.

Every app in apis.json becomes one tile, grouped by category exactly like
apps.html (CATEGORY_ORDER below is kept in sync with src/apps.js by hand,
since this script has no JS runtime). "Future apps" just means: add the
entry to apis.json, re-run this script, re-paste the output - the same
discipline already used for dist/*.html (tools/bundle.py).

Usage:
    ./tools/wp_embed.py           # write dist/wordpress-embed.html
    ./tools/wp_embed.py --check   # exit non-zero if the checked-in copy is stale
"""
from __future__ import annotations

import json
import sys
from html import escape
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APIS_JSON = ROOT / "apis.json"
OUT = ROOT / "dist" / "wordpress-embed.html"

# GitHub Pages default for this repo - no CNAME file in the repo, so this is
# the live URL unless a custom domain has since been configured in the
# repo's own Pages settings (in which case update this one constant).
BASE_URL = "https://agmonr.github.io/govapiportal/"

# Kept in the same order as CATEGORY_ORDER in src/apps.js - civic-action
# items first, then whatever's tied to your own address, then the
# tree-specific tools, then money/accountability. Anything outside this list
# (currently just "external") still renders, after these, under its own
# category_he heading.
CATEGORY_ORDER = ["civic", "home", "trees", "money"]

# Kept in sync with PINNED_APP_ID in src/apps.js - pulled out of its own
# category and rendered first, standalone, with no category heading.
PINNED_APP_ID = "accidents"

WRAP = "ram-govapps-embed"

# Ported verbatim from APP_ICON in src/apps.js - same glyph per app id, so
# the tiles read identically to the live site. Not escaped when interpolated
# below (matching apps.js), since tree/tree-canopy embed real markup, not text.
APP_ICON = {
    "accidents": "🚦",
    "trees": '🌳<span class="{w}-icon-small">🚑</span>',
    "committees": "🏛️",
    "local-finance": "💰",
    "agriculture": "🌾",
    "companies": "🏢",
    "welfare": "🤝",
    "budgetkey": "🔑",
    "blue-lines": "🚇",
    "area-cleanup": "🧹",
    "tree-canopy": '<span class="{w}-tc-icon">🌳<span class="{w}-tc-icon-badge">🏠</span></span>',
    "tree-plans": '🌳<span class="{w}-icon-small">📋</span>',
    "trip-report": '🚗<span class="{w}-icon-small">🎯</span>',
}

# Same rule as oneLineSummary in src/apps.js: the native title= tooltip
# can't be styled, so it gets one real sentence rather than the full
# (sometimes 500+ character) about text, with a hard length cap as backstop.
HOVER_MAX = 90


def abs_url(href: str) -> str:
    if href.startswith("http://") or href.startswith("https://"):
        return href
    return BASE_URL + href.removeprefix("./")


def load_apps() -> list[dict]:
    data = json.loads(APIS_JSON.read_text(encoding="utf-8"))
    return data["apps"]


def group_by_category(apps: list[dict]) -> list[tuple[str, str, list[dict]]]:
    buckets: dict[str, tuple[str, list[dict]]] = {}
    for a in apps:
        if a["id"] == PINNED_APP_ID:
            continue
        key = a.get("category") or "other"
        label = a.get("category_he") or "אחר"
        buckets.setdefault(key, (label, []))[1].append(a)
    ordered_keys = [k for k in CATEGORY_ORDER if k in buckets] + [
        k for k in buckets if k not in CATEGORY_ORDER
    ]
    return [(k, buckets[k][0], buckets[k][1]) for k in ordered_keys]


def one_line_summary(about: str) -> str:
    first_sentence = about.split(". ")[0]
    return first_sentence if len(first_sentence) <= HOVER_MAX else f"{first_sentence[:HOVER_MAX]}…"


def render_tile(a: dict) -> str:
    url = abs_url(a["href"])
    icon = APP_ICON.get(a["id"], "🔗").format(w=WRAP)
    title = escape(one_line_summary(a["about"]))
    name_he = escape(a["name_he"])
    return f"""
        <a class="{WRAP}-app-tile" href="{escape(url)}" target="_blank" rel="noopener"
           title="{title}" dir="auto">
          <span class="{WRAP}-app-icon" aria-hidden="true">{icon}</span>
          <span class="{WRAP}-app-name" dir="auto">{name_he}</span>
        </a>"""


def render_section(key: str, label: str, items: list[dict]) -> str:
    tiles = "".join(render_tile(a) for a in items)
    return f"""
      <section class="{WRAP}-apps-category" aria-labelledby="{WRAP}-cat-{escape(key)}">
        <h3 class="{WRAP}-apps-category-h" id="{WRAP}-cat-{escape(key)}" dir="auto">{escape(label)}</h3>
        <div class="{WRAP}-apps-grid">{tiles}
        </div>
      </section>"""


def render_jsonld(apps: list[dict]) -> str:
    items = []
    for i, a in enumerate(apps, start=1):
        item_type = "WebApplication" if a["kind"] == "אפליקציה" else "WebSite"
        items.append({
            "@type": "ListItem",
            "position": i,
            "item": {
                "@type": item_type,
                "name": a["name_he"],
                "alternateName": a["name"],
                "description": a["about"],
                "url": abs_url(a["href"]),
            },
        })
    payload = {
        "@context": "https://schema.org",
        "@type": "ItemList",
        "name": "כל האפליקציות מבוססות נתונים ממשלתיים פתוחים",
        "itemListElement": items,
    }
    # </script> can't appear inside a script body even inside a JSON string;
    # none of these values contain it, but escaping the slash is a cheap,
    # correct guard against a future about-text that happens to.
    return json.dumps(payload, ensure_ascii=False, indent=2).replace("</", "<\\/")


# A ready-to-copy alternative to pasting the whole fragment into a Custom
# HTML block: an <iframe> pointing straight at this generated file, for
# whoever would rather embed it as a live, always-current include than
# paste (and eventually go stale against) a snapshot of the markup.
def render_iframe_example() -> str:
    src = escape(f"{BASE_URL}dist/wordpress-embed.html")
    return (
        f'<iframe src="{src}" loading="lazy" style="width:100%;border:0;min-height:900px" '
        f'title="כל האפליקציות"></iframe>'
    )


def render(apps: list[dict]) -> str:
    pinned = next((a for a in apps if a["id"] == PINNED_APP_ID), None)
    pinned_html = (
        f'<div class="{WRAP}-apps-grid {WRAP}-apps-pinned">{render_tile(pinned)}\n        </div>'
        if pinned
        else ""
    )
    sections = pinned_html + "".join(render_section(k, label, items) for k, label, items in group_by_category(apps))
    jsonld = render_jsonld(apps)
    iframe_example = render_iframe_example()
    return f"""<!--
  Generated by tools/wp_embed.py from apis.json - do not hand-edit.
  To pick up new or changed apps: update apis.json, run
  ./tools/wp_embed.py, and re-paste this file's contents into the
  WordPress "Custom HTML" block. Every app's long description lives only
  in the JSON-LD block below (search-engine metadata) - it is deliberately
  not rendered as visible text, to match apps.html's plain icon tiles.

  Alternative to pasting the fragment itself: embed this file live via
  iframe (always current, no re-pasting needed when apis.json changes):
  {iframe_example}
-->
<div class="{WRAP}" dir="rtl" lang="he">
  <style>
    .{WRAP} {{
      font: 16px/1.55 system-ui, "Segoe UI", Arial, sans-serif;
      color: #24331f; max-width: 100%;
    }}
    .{WRAP} * {{ box-sizing: border-box; }}
    .{WRAP}-apps-category + .{WRAP}-apps-category {{ margin-block-start: 1.5rem; }}
    .{WRAP}-apps-pinned {{ margin-block-end: 1.5rem; }}
    .{WRAP}-apps-category-h {{ font-size: 1rem; margin-block: 0 .6rem; color: #5b6f56; font-weight: 600; }}
    .{WRAP}-apps-grid {{
      display: grid; grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr)); gap: .85rem;
    }}
    .{WRAP}-app-tile {{
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: .5rem; text-align: center; text-decoration: none; padding: 1.5rem 1rem;
      border-radius: 1.1rem; border: 1px solid #f0d9bc;
      background: linear-gradient(160deg, #fffaf3, #ffe6c2); color: #3a2c17;
      box-shadow: 0 3px 10px -6px rgba(0, 0, 0, .35);
      transition: transform .15s ease, box-shadow .15s ease;
    }}
    .{WRAP}-app-tile:hover, .{WRAP}-app-tile:focus-visible {{
      transform: translateY(-3px); box-shadow: 0 10px 22px -10px rgba(0, 0, 0, .4);
    }}
    .{WRAP}-app-icon {{ font-size: 2.3rem; line-height: 1; }}
    .{WRAP}-app-name {{ font-weight: 600; font-size: .95rem; }}
    .{WRAP}-tc-icon {{ position: relative; display: inline-block; }}
    .{WRAP}-tc-icon-badge {{
      position: absolute; inset-block-end: -.15em; inset-inline-end: -.15em;
      font-size: .55em; line-height: 1; background: #fff; border-radius: 999px;
      box-shadow: 0 0 0 2px #fff;
    }}
    .{WRAP}-icon-small {{ font-size: .6em; vertical-align: middle; }}
  </style>
{sections}
  <script type="application/ld+json">
{jsonld}
  </script>
</div>
"""


def main() -> int:
    check = "--check" in sys.argv[1:]
    apps = load_apps()
    content = render(apps)
    if check:
        if not OUT.exists() or OUT.read_text(encoding="utf-8") != content:
            print(f"STALE: {OUT.relative_to(ROOT)} does not match apis.json - run ./tools/wp_embed.py")
            return 1
        print(f"ok: {OUT.relative_to(ROOT)} is in sync")
        return 0
    OUT.write_text(content, encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)} ({len(content) / 1024:.1f} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
