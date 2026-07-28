#!/usr/bin/env python3
"""
Generates dist/wordpress-embed.html - a self-contained HTML fragment meant
to be pasted into a WordPress "Custom HTML" block (not a full document: no
<!doctype>/<html>/<head>, since WordPress supplies those itself).

Every app in apis.json becomes one card, grouped by category exactly like
apps.html (see src/apps.js - CATEGORY_ORDER below is kept in sync with it
by hand, not imported, since this script has no JS runtime). "Future apps"
just means: add the entry to apis.json, re-run this script, re-paste the
output - the same discipline already used for dist/*.html (tools/bundle.py).

All text (name, kind, full description) is baked in as real HTML at
generation time - nothing here depends on JavaScript running for the
content to exist, which matters both for search engines that don't execute
JS and for WordPress installs that strip <script> tags from untrusted
authors. A JSON-LD ItemList is included too, for search engines that do
parse structured data.

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

# Kept in the same order as CATEGORY_ORDER in src/apps.js - whatever's tied
# to your own address first, then civic-action items, then money/
# accountability. Anything outside this list (currently just "external")
# still renders, after these, under its own category_he heading.
CATEGORY_ORDER = ["home", "civic", "money"]

WRAP = "ram-govapps-embed"


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
        key = a.get("category") or "other"
        label = a.get("category_he") or "אחר"
        buckets.setdefault(key, (label, []))[1].append(a)
    ordered_keys = [k for k in CATEGORY_ORDER if k in buckets] + [
        k for k in buckets if k not in CATEGORY_ORDER
    ]
    return [(k, buckets[k][0], buckets[k][1]) for k in ordered_keys]


def render_card(a: dict) -> str:
    url = abs_url(a["href"])
    name_he = escape(a["name_he"])
    name_en = escape(a["name"])
    kind = escape(a["kind"])
    about = escape(a["about"])
    home_link = ""
    if a.get("home"):
        home_link = (
            f' · <a href="{escape(abs_url(a["home"]))}" target="_blank" rel="noopener nofollow">'
            f"מקור הנתונים ↗</a>"
        )
    return f"""
      <article class="{WRAP}-card">
        <h4 class="{WRAP}-card-title">
          <a href="{escape(url)}" target="_blank" rel="noopener">{name_he}</a>
        </h4>
        <p class="{WRAP}-card-meta" dir="auto">{kind} · <span lang="en">{name_en}</span></p>
        <p class="{WRAP}-card-desc" dir="auto">{about}</p>
        <p class="{WRAP}-card-links">
          <a href="{escape(url)}" target="_blank" rel="noopener">פתיחת האפליקציה ↗</a>{home_link}
        </p>
      </article>"""


def render_section(key: str, label: str, items: list[dict]) -> str:
    cards = "".join(render_card(a) for a in items)
    return f"""
    <section class="{WRAP}-section" aria-labelledby="{WRAP}-cat-{escape(key)}">
      <h3 class="{WRAP}-section-h" id="{WRAP}-cat-{escape(key)}" dir="auto">{escape(label)}</h3>
      <div class="{WRAP}-grid">{cards}
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


def render(apps: list[dict]) -> str:
    sections = "".join(render_section(k, label, items) for k, label, items in group_by_category(apps))
    jsonld = render_jsonld(apps)
    return f"""<!--
  Generated by tools/wp_embed.py from apis.json - do not hand-edit.
  To pick up new or changed apps: update apis.json, run
  ./tools/wp_embed.py, and re-paste this file's contents into the
  WordPress "Custom HTML" block.
-->
<div class="{WRAP}" dir="rtl" lang="he">
  <style>
    .{WRAP} {{
      --ram-bg: #f2f7ee; --ram-fg: #24331f; --ram-muted: #5b6f56; --ram-border: #dfe9d8;
      --ram-accent: #2e7d46; --ram-surface: #eaf3e6; --ram-card: #ffffff;
      --ram-forest-dark: #1b5e34; --ram-leaf: #4caf50; --ram-shadow: rgba(27, 94, 52, .16);
      font-family: -apple-system, "Segoe UI", Arial, sans-serif; color: var(--ram-fg);
      background: var(--ram-bg); border-radius: 14px; padding: 1.5rem 1.25rem;
      max-width: 100%; box-sizing: border-box;
    }}
    .{WRAP} * {{ box-sizing: border-box; }}
    .{WRAP}-intro {{ margin: 0 0 1.5rem; line-height: 1.6; color: var(--ram-fg); }}
    .{WRAP}-intro a {{ color: var(--ram-accent); font-weight: 600; }}
    .{WRAP}-section {{ margin-block-end: 2rem; }}
    .{WRAP}-section-h {{
      font-size: 1.05rem; margin: 0 0 .75rem; padding-inline-start: .6rem;
      border-inline-start: 4px solid var(--ram-leaf); color: var(--ram-forest-dark);
    }}
    .{WRAP}-grid {{
      display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 1rem;
    }}
    .{WRAP}-card {{
      background: var(--ram-card); border: 1px solid var(--ram-border); border-radius: 10px;
      padding: 1rem 1.1rem; box-shadow: 0 2px 8px var(--ram-shadow); display: flex;
      flex-direction: column; gap: .4rem;
    }}
    .{WRAP}-card-title {{ margin: 0; font-size: 1rem; }}
    .{WRAP}-card-title a {{ color: var(--ram-forest-dark); text-decoration: none; }}
    .{WRAP}-card-title a:hover {{ text-decoration: underline; }}
    .{WRAP}-card-meta {{ margin: 0; font-size: .78rem; color: var(--ram-muted); }}
    .{WRAP}-card-desc {{ margin: 0; font-size: .88rem; line-height: 1.55; color: var(--ram-fg); }}
    .{WRAP}-card-links {{ margin: .3rem 0 0; font-size: .82rem; }}
    .{WRAP}-card-links a {{ color: var(--ram-accent); font-weight: 600; text-decoration: none; }}
    .{WRAP}-card-links a:hover {{ text-decoration: underline; }}
  </style>

  <p class="{WRAP}-intro">
    כל האפליקציות שבנויות על גבי נתונים ממשלתיים פתוחים (data.gov.il ומקורות רשמיים נוספים) בפרויקט
    "מפת ה-API הממשלתי" - מקובצות לפי מה שרלוונטי לכם, לא לפי מקור הנתונים הטכני. הרשימה המלאה והעדכנית
    ביותר, כולל אפליקציות עתידיות, נמצאת תמיד ב<a href="{escape(BASE_URL)}apps.html" target="_blank" rel="noopener">עמוד כל האפליקציות</a>.
  </p>
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
