#!/usr/bin/env python3
"""
Builds tools/arnona_authorities.json - the roster tools/arnona_fetch.py reads:
one row per Israeli local authority, with a guessed `<slug>.muni.il` domain
to try first.

Name source: the exact same CKAN "local-authorities" resource
src/finance-data.js already trusts for its own roster (see ROSTER_YEAR/
ROSTER_FILTERS there) - `dsFilter`'s server-side equivalent, one cheap
filtered query instead of local-finance.js's client-side dedup over the full
resource. Confirmed live this session: 259 unique שם_רשות values, matching
the known total exactly.

Domain guessing is inherently lossy: Hebrew spelling omits vowels
(e.g. כפר סבא is consonants k-p-r s-b-<silent-א>), so there is no mechanical
way to recover "kfar-saba" from the letters alone. This script instead uses
a hand-built dictionary of the ~150 most common recurring place-name words/
prefixes (covers most cities and large local councils - the compound words
Israeli place names are actually built from), falling back to a plain
consonant transliteration for anything not in the dictionary (mostly smaller
Arab/Druze/Bedouin towns and regional councils, where accuracy is expected
to be lower). This is a *first guess* for tools/arnona_fetch.py to try,
not asserted to be correct - fetch.py logs a domain that doesn't resolve
into results.csv same as any other miss, for a human to fill into
`website_override` below.

Usage:
    python3 tools/arnona_authorities.py
"""
import json
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_FILE = ROOT / "tools" / "arnona_authorities.json"
OVERRIDES_FILE = ROOT / "tools" / "arnona_overrides.json"

DATASTORE = "https://data.gov.il/api/3/action/datastore_search"
ROSTER_RESOURCE_ID = "6e153ddd-d4d4-4450-a78c-20f594a7986a"  # 2024 local-authorities, same as src/finance-data.js YEAR_RESOURCES[2024]
ROSTER_FILTERS = {"גליון": "נתונים לטופס 1", "שורה": "יתרה לתחילת שנה", "עמודה": "שנה נוכחית"}
EXPECTED_COUNT_RANGE = (255, 262)  # sanity check - 259 confirmed live this session, allow drift


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def fetch_roster_names():
    params = {
        "resource_id": ROSTER_RESOURCE_ID,
        "filters": json.dumps(ROSTER_FILTERS, ensure_ascii=False),
        "limit": "10000",
    }
    url = f"{DATASTORE}?{urllib.parse.urlencode(params)}"
    with urllib.request.urlopen(url, timeout=25) as r:
        data = json.loads(r.read())
    if not data.get("success"):
        raise RuntimeError(f"datastore_search failed: {data.get('error')}")
    names = sorted({rec["שם_רשות"] for rec in data["result"]["records"]}, key=lambda s: s)
    return names


# Known-correct domains, confirmed live this session (via search results
# actually showing PDFs at these hosts) - short-circuits the word-dictionary
# guess entirely for these, since a guess is unnecessary when the real
# answer is already known.
KNOWN_DOMAINS = {
    "תל אביב-יפו": "tel-aviv.gov.il",  # confirmed exception - does NOT use muni.il
    "הוד השרון": "hod-hasharon.muni.il",
    "כפר סבא": "kfar-saba.muni.il",
    "אריאל": "ariel.muni.il",
    "אזור": "azor.muni.il",
    "רחובות": "rehovot.muni.il",
    "רמת השרון": "ramat-hasharon.muni.il",
    "חיפה": "haifa.muni.il",
    "מצפה רמון": "mitzpe-ramon.muni.il",
}

# Word/prefix -> Latin, longest Hebrew keys matched first. Covers the
# recurring building blocks of Israeli place names (geographic terms, common
# first/second components) - NOT a general transliteration table, since
# Hebrew's missing vowels make general letter-by-letter transliteration
# produce wrong results for anything but single, well-known whole names.
WORD_MAP = {
    "תל אביב": "tel-aviv", "אביב": "aviv", "יפו": "yafo",
    "כפר סבא": "kfar-saba", "כפר": "kfar", "סבא": "saba",
    "בת ים": "bat-yam", "בת": "bat", "ים": "yam",
    "פתח תקווה": "petah-tikva", "פתח": "petah", "תקווה": "tikva",
    "ראשון לציון": "rishon-lezion", "ראשון": "rishon", "לציון": "lezion", "ציון": "zion", "ציונה": "ziona",
    "רמת גן": "ramat-gan", "רמת השרון": "ramat-hasharon", "רמת": "ramat", "רמת ישי": "ramat-yishay",
    "גן": "gan", "השרון": "hasharon", "שרון": "sharon",
    "בני ברק": "bnei-brak", "בני": "bnei", "ברק": "brak",
    "גבעת שמואל": "givat-shmuel", "גבעת זאב": "givat-zeev", "גבעת": "givat", "שמואל": "shmuel", "זאב": "zeev",
    "גבעתיים": "givatayim",
    "הרצליה": "herzliya", "רעננה": "raanana",
    "נס ציונה": "ness-ziona", "נס": "ness",
    "מודיעין עילית": "modiin-illit", "מודיעין-מכבים-רעות": "modiin-maccabim-reut", "מודיעין": "modiin", "מכבים": "maccabim", "רעות": "reut", "עילית": "illit",
    "נהריה": "nahariya", "עכו": "akko", "טבריה": "tiberias", "צפת": "zefat",
    "חיפה": "haifa", "ירושלים": "jerusalem",
    "באר שבע": "beer-sheva", "באר טוביה": "beer-tuvia", "באר יעקב": "beer-yaakov", "באר": "beer", "שבע": "sheva",
    "אשקלון": "ashkelon", "אשדוד": "ashdod", "חולון": "holon",
    "בית שמש": "beit-shemesh", "בית שאן": "beit-shean", "בית דגן": "beit-dagan", "בית אריה": "beit-arye", "בית": "beit",
    "נתניה": "netanya", "חדרה": "hadera", "רמלה": "ramla", "לוד": "lod",
    "הוד השרון": "hod-hasharon", "הוד": "hod",
    "אור יהודה": "or-yehuda", "אור עקיבא": "or-akiva", "אור": "or", "עקיבא": "akiva", "יהודה": "yehuda",
    "אריאל": "ariel", "אלעד": "elad", "יבנה": "yavne", "גדרה": "gedera",
    "נתיבות": "netivot", "שדרות": "sderot", "דימונה": "dimona", "ערד": "arad",
    "מצפה רמון": "mitzpe-ramon", "מצפה": "mitzpe", "רמון": "ramon", "ירוחם": "yeruham",
    "קרית שמונה": "kiryat-shmona", "קריית שמונה": "kiryat-shmona",
    "קרית אונו": "kiryat-ono", "קרית ארבע": "kiryat-arba", "קרית אתא": "kiryat-ata",
    "קרית ביאליק": "kiryat-bialik", "קרית גת": "kiryat-gat", "קרית טבעון": "kiryat-tivon",
    "קרית ים": "kiryat-yam", "קרית יערים": "kiryat-yearim", "קרית מוצקין": "kiryat-motzkin",
    "קרית מלאכי": "kiryat-malachi", "קרית עקרון": "kiryat-ekron",
    "קרית": "kiryat", "קריית": "kiryat",
    "מעלות-תרשיחא": "maalot-tarshiha", "מעלות": "maalot", "תרשיחא": "tarshiha",
    "כרמיאל": "karmiel", "נשר": "nesher",
    "מגדל העמק": "migdal-haemek", "מגדל": "migdal", "העמק": "haemek", "עמק": "emek",
    "עפולה": "afula", "יקנעם עילית": "yokneam", "יקנעם": "yokneam",
    "זכרון יעקב": "zichron-yaakov", "זכרון": "zichron", "יעקב": "yaakov",
    "בנימינה-גבעת עדה": "binyamina-givat-ada", "בנימינה": "binyamina", "עדה": "ada",
    "פרדס חנה-כרכור": "pardes-hana-karkur", "פרדס חנה": "pardes-hana", "כרכור": "karkur", "פרדס": "pardes",
    "טירת כרמל": "tirat-carmel", "טירת": "tirat", "כרמל": "carmel",
    "אילת": "eilat", "עומר": "omer", "להבים": "lehavim", "מיתר": "meitar",
    "רהט": "rahat", "שגב-שלום": "segev-shalom", "שגב": "segev", "שלום": "shalom",
    "תל שבע": "tel-sheva", "לקיה": "laqiya", "חורה": "hura", "כסיפה": "kseife",
    "מבשרת ציון": "mevaseret-zion", "מבשרת": "mevaseret",
    "צור הדסה": "tzur-hadassah", "צור": "tzur", "הדסה": "hadassah",
    "אבן יהודה": "even-yehuda", "אבן": "even",
    "כפר יונה": "kfar-yona", "כפר סאבא": "kfar-saba",
    "כפר קאסם": "kafr-qasim", "כפר קרע": "kafr-qara", "כפר ברא": "kafr-bara",
    "כפר יאסיף": "kafr-yasif", "כפר מנדא": "kafr-manda", "כפר כנא": "kafr-kanna",
    "טייבה": "tayibe", "טירה": "tira", "טמרה": "tamra",
    "באקה אל-גרבייה": "baqa-al-gharbiyye", "אום אל-פחם": "umm-al-fahm",
    "שפרעם": "shefaram", "נצרת": "nazareth", "נוף הגליל": "nof-hagalil", "הגליל": "hagalil", "גליל": "galil",
    "מודיעין-מכבים-רעות": "modiin-maccabim-reut",
    "אלונה": "alona", "אלפי מנשה": "alfei-menashe", "מנשה": "menashe",
    "אלקנה": "elkana", "אפרתה": "efrat", "ביתר עילית": "beitar-illit", "ביתר": "beitar",
    "גבעת זאב": "givat-zeev", "הר אדר": "har-adar", "הר": "har",
    "מעלה אדומים": "maale-adumim", "מעלה אפרים": "maale-efraim", "מעלה": "maale", "אדומים": "adumim", "אפרים": "efraim",
    "קדומים": "kedumim", "קדימה-צורן": "kadima-zoran", "קדימה": "kadima", "צורן": "zoran",
    "קרני שומרון": "karnei-shomron", "קרני": "karnei", "שומרון": "shomron",
    "עמנואל": "emanuel", "עמק חפר": "emek-hefer", "חפר": "hefer",
    "עמק יזרעאל": "emek-yizreel", "יזרעאל": "yizreel", "עמק הירדן": "emek-hayarden", "הירדן": "hayarden", "ירדן": "yarden",
    "דרום השרון": "drom-hasharon", "דרום": "drom", "לב השרון": "lev-hasharon", "לב": "lev",
    "חוף השרון": "hof-hasharon", "חוף הכרמל": "hof-hacarmel", "חוף אשקלון": "hof-ashkelon", "חוף": "hof",
    "גני תקווה": "ganei-tikva", "גני": "ganei",
    "יהוד-מונוסון": "yehud-monosson", "יהוד": "yehud",
    "כוכב יאיר צור יגאל": "kochav-yair", "כוכב יאיר": "kochav-yair",
    "כפר ורדים": "kfar-vradim", "כפר שמריהו": "kfar-shmaryahu", "כפר תבור": "kfar-tavor",
    "סביון": "savyon", "שוהם": "shoham", "חריש": "harish",
    "בוסתאן אל-מרג'": "bustan-al-marj", "ג'לג'וליה": "jaljulia", "ג'סר א-זרקא": "jisr-az-zarqa",
    "מגאר": "maghar", "עספיא": "ussefiya", "דאלית אל-כרמל": "daliyat-al-karmel",
    "ראש העין": "rosh-haayin", "ראש פינה": "rosh-pina", "ראש": "rosh",
    "יסוד המעלה": "yesod-hamaala", "מגדל תפן": "migdal-tefen", "תפן": "tefen",
    "אבו גוש": "abu-ghosh", "אבו סנאן": "abu-snan",
    "חצור הגלילית": "hazor-haglilit", "חצור": "hazor",
    "ערערה": "arara", "ערערה-בנגב": "arara-banegev", "בנגב": "banegev", "נגב": "negev",
    "מזכרת בתיה": "mazkeret-batya", "מזכרת": "mazkeret",
    "תל מונד": "tel-mond", "מונד": "mond",
    "מטולה": "metula", "מגדל": "migdal", "יבנאל": "yavniel",
    "פרדסיה": "pardesiya", "זמר": "zemer", "אליכין": "eliakhin",
    "שלומי": "shlomi", "מטה אשר": "mateh-asher", "מטה בנימין": "mateh-binyamin", "מטה יהודה": "mateh-yehuda", "מטה": "mateh",
    "משגב": "misgav", "מגידו": "megiddo", "רכסים": "rechasim",
    "רמת נגב": "ramat-negev", "בני שמעון": "bnei-shimon", "שמעון": "shimon",
    "אשכול": "eshkol", "יואב": "yoav", "ברנר": "brenner", "גדרות": "gderot",
    "גזר": "gezer", "חבל יבנה": "hevel-yavne", "חבל": "hevel", "חבל אילות": "hevel-eilot", "אילות": "eilot",
    "חבל מודיעין": "hevel-modiin", "גוש עציון": "gush-etzion", "גוש": "gush", "עציון": "etzion",
    "הגלבוע": "hagilboa", "גלבוע": "gilboa", "עמק המעיינות": "emek-hamaayanot", "המעיינות": "hamaayanot",
    "מרום הגליל": "merom-hagalil", "מרום": "merom", "מרחבים": "merhavim",
    "שער הנגב": "shaar-hanegev", "שער שומרון": "shaar-shomron", "שער": "shaar",
    "גולן": "golan", "שומרון": "shomron", "לכיש": "lachish", "יואב": "yoav",
    "מבואות החרמון": "mevoot-hermon", "החרמון": "hachermon", "חרמון": "hermon",
    "הגליל העליון": "hagalil-haelyon", "העליון": "haelyon", "הגליל התחתון": "hagalil-hatahton", "התחתון": "hatahton",
    "נאות חובב": "neot-hovav", "נווה מדבר": "neve-midbar", "נווה": "neve", "מדבר": "midbar",
    "עין מאהל": "ein-mahel", "עין": "ein",
    "כרמי": "carmey", "תמר": "tamar", "מגילות ים המלח": "megilot", "ים המלח": "yam-hamelah",
    "שדות דן": "sdot-dan", "שדות": "sdot", "מעלה יוסף": "maale-yosef", "יוסף": "yosef",
    "מעלה עירון": "maale-iron", "עירון": "iron",
    "נחל שורק": "nahal-sorek", "נחל": "nahal", "שורק": "sorek",
    "הערבה התיכונה": "arava-tichona", "הערבה": "arava", "התיכונה": "tichona",
    "ערבות הירדן": "arvot-hayarden", "ערבות": "arvot",
    "עמק חפר": "emek-hefer",
}
WORD_KEYS_BY_LEN = sorted(WORD_MAP, key=len, reverse=True)

HEB_LETTER_MAP = {
    "א": "", "ב": "b", "ג": "g", "ד": "d", "ה": "h", "ו": "v", "ז": "z", "ח": "h",
    "ט": "t", "י": "y", "כ": "k", "ך": "k", "ל": "l", "מ": "m", "ם": "m", "נ": "n",
    "ן": "n", "ס": "s", "ע": "", "פ": "p", "ף": "f", "צ": "tz", "ץ": "tz", "ק": "k",
    "ר": "r", "ש": "sh", "ת": "t", "'": "", '"': "",
}


def transliterate_word(word):
    """Plain consonant transliteration fallback for a word not in WORD_MAP -
    lossy (no vowels), only expected to be roughly right, see module
    docstring."""
    return "".join(HEB_LETTER_MAP.get(ch, ch) for ch in word if ch not in "-()")


def slug_guess(name_he):
    """Greedy longest-match over WORD_MAP first (handles whole known names
    and multi-word combos), falling back to per-word transliteration for
    anything left over."""
    remaining = name_he
    parts = []
    while remaining.strip():
        remaining = remaining.strip()
        matched = None
        for key in WORD_KEYS_BY_LEN:
            if remaining == key or remaining.startswith(key + " ") or remaining.startswith(key + "-"):
                matched = key
                break
        if matched:
            parts.append(WORD_MAP[matched])
            remaining = remaining[len(matched):]
        else:
            # consume one word (space or hyphen separated) via letter fallback
            m = re.match(r"^([^\s\-]+)(.*)$", remaining)
            if not m:
                break
            word, remaining = m.group(1), m.group(2)
            translit = transliterate_word(word)
            if translit:
                parts.append(translit)
    slug = "-".join(p for p in parts if p)
    slug = re.sub(r"-+", "-", slug).strip("-")
    return slug


def main():
    log("fetching authority roster from data.gov.il...")
    names = fetch_roster_names()
    log(f"{len(names)} unique authorities (expected {EXPECTED_COUNT_RANGE[0]}-{EXPECTED_COUNT_RANGE[1]})")
    if not (EXPECTED_COUNT_RANGE[0] <= len(names) <= EXPECTED_COUNT_RANGE[1]):
        raise SystemExit(f"roster count {len(names)} outside expected range - CKAN query/filters likely changed, check before trusting this list")

    overrides = {}
    if OVERRIDES_FILE.exists():
        overrides = json.loads(OVERRIDES_FILE.read_text())
        log(f"{len(overrides)} manual overrides loaded from {OVERRIDES_FILE.name}")

    roster = []
    n_known = 0
    for name in names:
        website = overrides.get(name) or KNOWN_DOMAINS.get(name)
        if website:
            n_known += 1
        guess = slug_guess(name)
        roster.append({
            "name_he": name,
            "slug_guess": guess,
            "domain_guess": f"{guess}.muni.il" if guess else None,
            "website_override": website,
        })

    OUT_FILE.write_text(json.dumps(roster, ensure_ascii=False, indent=1), encoding="utf-8")
    log(f"wrote {OUT_FILE.relative_to(ROOT)} ({len(roster)} authorities, "
        f"{n_known} with a known/override website)")

    if not OVERRIDES_FILE.exists():
        OVERRIDES_FILE.write_text(json.dumps({}, ensure_ascii=False, indent=1), encoding="utf-8")
        log(f"created empty {OVERRIDES_FILE.relative_to(ROOT)} - fill in "
            f"{{\"<name_he>\": \"<website>\"}} entries here as arnona_fetch.py's "
            f"results.csv reveals wrong domain guesses")


if __name__ == "__main__":
    main()
