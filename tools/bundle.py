#!/usr/bin/env python3
"""
Builds dist/map.html - the whole API map as one self-contained file.

Why this exists: a page opened from disk cannot load its own files. The browser
refuses ES module scripts and fetch() from origin 'null', so index.html renders
blank when double-clicked. Inlining everything sidesteps both.

What survives the trip: the live explorer. Access-Control-Allow-Origin: * accepts
origin 'null', so the browser-callable APIs answer a file:// page exactly as they
answer the hosted one (probed - data.gov.il, CBS and Open Bus all return 200 from
file://; Knesset still fails on CORS, as it should). The offline copy is the
whole thing, not a degraded preview.

The site itself is untouched and still has no build step. Only this extra
artifact is generated.

Usage:
    ./tools/bundle.py           write dist/map.html
    ./tools/bundle.py --check   exit non-zero if dist/map.html is stale
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "dist" / "map.html"

# Dependency order: dependencies before dependents, since flattening drops the
# imports that would otherwise order them. Every module reachable from map.js
# must be listed - a missing one still produces a bundle, but one that throws on
# load because the symbol it imported was never defined. verify_symbols() below
# turns that silent break into a build failure.
SOURCES = ["src/ui.js", "src/explorer.js", "src/portal.js", "src/ckan.js", "src/map.js"]

IMPORT_RE = re.compile(r"^\s*import\s.*?;\s*$", re.M)
EXPORT_RE = re.compile(r"^export\s+", re.M)
# Anything left after stripping means an assumption above has broken.
LEFTOVER_RE = re.compile(r"^\s*(?:import\s|export\s)", re.M)


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def flatten(rel: str) -> str:
    """Strip module syntax so several files can share one inline module scope."""
    src = IMPORT_RE.sub("", read(rel))
    src = EXPORT_RE.sub("", src)
    if LEFTOVER_RE.search(src):
        bad = LEFTOVER_RE.search(src).group(0).strip()
        sys.exit(f"error: {rel} still has module syntax after stripping: {bad!r}\n"
                 f"       bundle.py flattens files into one scope and cannot keep it.")
    return src


def verify_symbols() -> None:
    """Every symbol imported across SOURCES must be defined by one of them.

    Flattening deletes the import statements, so a module left out of SOURCES
    does not fail the build - it produces a page that throws ReferenceError on
    load. That happened once (portal.js), and the bundle looked fine. Catch it
    here instead of in a browser.
    """
    imported: set[str] = set()
    defined: set[str] = set()

    for rel in SOURCES:
        src = read(rel)
        for names, _mod in re.findall(r"import\s*\{([^}]*)\}\s*from\s*['\"]([^'\"]+)['\"]", src):
            for name in names.split(","):
                name = name.strip().split(" as ")[-1].strip()
                if name:
                    imported.add(name)
        for kind in ("function", "const", "let", "var", "class"):
            defined.update(re.findall(rf"^export\s+(?:async\s+)?{kind}\s+([A-Za-z_$][\w$]*)", src, re.M))
        defined.update(re.findall(r"^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)", src, re.M))

    missing = imported - defined
    if missing:
        sys.exit(f"error: {', '.join(sorted(missing))} imported but not defined by any file in "
                 f"SOURCES.\n       Add the module that exports it to SOURCES in bundle.py.")


def verify_no_collisions() -> None:
    """No two sources may define the same top-level name.

    Flattening puts every file in one scope, so two modules that each declare
    `state` are a redeclaration that kills the whole inline script, and two that
    each declare `function renderList` silently resolve to whichever came last.
    Both are invisible in the unbundled site, where modules have their own
    scopes - the served page works and only the offline copy breaks.

    That is exactly how ckan.js shipped broken once: `state`, `renderList` and
    `pager` each collided with an existing module, #ckan rendered empty in
    dist/map.html, and the build reported success.
    """
    owners: dict[str, list[str]] = {}
    for rel in SOURCES:
        src = read(rel)
        names = set(re.findall(r"^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)", src, re.M))
        names |= set(re.findall(r"^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)", src, re.M))
        for name in names:
            owners.setdefault(name, []).append(rel)

    clashes = {n: fs for n, fs in owners.items() if len(fs) > 1}
    if clashes:
        lines = "\n".join(f"       {n}: {', '.join(fs)}" for n, fs in sorted(clashes.items()))
        sys.exit("error: top-level names defined in more than one source file.\n"
                 "       bundle.py flattens them into one scope, so these collide:\n"
                 f"{lines}\n"
                 "       Rename them, or move the shared one into src/ui.js and import it.")


def build() -> str:
    verify_symbols()
    verify_no_collisions()
    html = read("index.html")
    data = json.loads(read("apis.json"))  # parse to validate, not just to embed

    # </script> inside the data would close the tag early. JSON has no business
    # containing one, but the cost of being wrong here is a silently broken file.
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")

    # Inline the stylesheet.
    css = "<style>\n" + read("src/style.css").strip() + "\n</style>"
    html, n = re.subn(
        r'<link rel="stylesheet" href="\./src/style\.css">',
        lambda _m: css,
        html,
    )
    if n != 1:
        sys.exit("error: stylesheet <link> not found in index.html - bundler is out of date")

    # The file:// notice and its guard are about *this* limitation. In the
    # bundle the limitation does not exist, so showing either would be a lie.
    html, n = re.subn(r"\n\s*<!--\n\s*Opened by double-clicking.*?</script>\n", "\n", html, flags=re.S)
    if n != 1:
        sys.exit("error: file:// guard block not found in index.html - bundler is out of date")
    html, n = re.subn(r'\s*<div id="fileproto".*?</div>\n\n', "\n", html, flags=re.S)
    if n != 1:
        sys.exit("error: #fileproto notice not found in index.html - bundler is out of date")

    # Replace the module <script> with data + flattened sources. Inline modules
    # are exempt from the origin-'null' block (verified in headless Chromium),
    # so type="module" is kept and the sources need no further rewriting.
    bundled = "\n".join(flatten(s) for s in SOURCES)
    script = (
        '<script type="module">\n'
        "// Generated by tools/bundle.py - edit src/ and apis.json, then regenerate.\n"
        f"globalThis.__API_DATA__ = {payload};\n\n"
        f"{bundled}\n"
        "</script>"
    )
    html, n = re.subn(r'<script type="module" src="\./src/map\.js"></script>',
                      lambda _m: script, html)
    if n != 1:
        sys.exit("error: module <script> not found in index.html - bundler is out of date")

    note = ("<!--\n  Self-contained build of the Israeli government API map.\n"
            "  Generated by tools/bundle.py from apis.json + src/ - do not edit by hand.\n"
            f"  Data probed: {data['probed']} | {len(data['apis'])} APIs across "
            f"{len(data['portals'])} portals.\n-->\n")
    return note + html


def main() -> int:
    html = build()
    check = "--check" in sys.argv[1:]

    if check:
        if not OUT.exists():
            print(f"STALE: {OUT.relative_to(ROOT)} does not exist. Run ./tools/bundle.py")
            return 1
        if OUT.read_text(encoding="utf-8") != html:
            print(f"STALE: {OUT.relative_to(ROOT)} does not match apis.json + src/. "
                  "Run ./tools/bundle.py")
            return 1
        print(f"ok: {OUT.relative_to(ROOT)} is in sync with apis.json + src/")
        return 0

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(html, encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)} ({len(html.encode('utf-8')) / 1024:.1f} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
