#!/usr/bin/env python3
"""
Builds src/mortality-data.js - cause-of-death data for mortality-compare.html,
across three separate granularities (see that page's own header comment for
why they're kept apart rather than one merged table): city, zone (district/
sub-district), and national.

Unlike every other *_build.py in this directory, there is no bulk raw source
file to parse - the underlying CBS publications only ever printed the top-10/
bottom-10 localities per table (confirmed against both the PDF and DOCX
renditions of the 2019 press release - not a PDF-conversion artifact), so the
full ~127-locality table was never public. The data below is hand-transcribed
directly from those publications, which is why this script is a plain literal
dict rather than a fetch-and-parse pipeline - there's nothing bigger to
automate against. Re-run only if a source value is corrected.

Sources (see scratchpad research session, 2026-08-07):
  CITY   - "פרופיל בריאותי-חברתי של היישובים בישראל, 2011-2017", CBS pub.
           370/2019 (4/12/2019). Localities with 10,000+ residents (127
           examined); tables only list the 10 highest + 10 lowest per metric,
           plus the national average - not the full 127.
           https://www.cbs.gov.il/he/mediarelease/DocLib/2019/370/05_19_370b.pdf
  ZONE   - Same publication's district (מחוז)/sub-district (נפה) figures -
           some are real numbers (life expectancy, overall mortality, infant
           mortality, diabetes extremes), others are chart-only in the PDF
           (cancer/heart disease by נפה) and so are recorded here as a
           qualitative rank, not a rate - see `note` on those entries.
  NATIONAL - "סיבות מוות בישראל, 2020-2022", CBS pub. 125/2024 (17/4/2024),
           table א (top 10 causes, 2020-2022) - this is the ONLY source with
           real stroke numbers at all; stroke never appears in the CITY or
           ZONE tables (checked - the localities publication's נפה-level
           mention of it is prose ranking only, no figures). Population-
           group (Jewish/Arab) ratios and life expectancy from the same
           report. Bedouin-specific infant mortality and maternal mortality
           are one-off figures from Ynet/Israel Hayom health reporting citing
           CBS/Ministry of Health (no single CBS publication page covers both
           - kept as a `source` string per fact instead of one shared URL).

Usage:
    python3 tools/mortality_build.py
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"

CBS_LOCALITIES_2019 = "CBS 370/2019, פרופיל בריאותי-חברתי של היישובים בישראל 2011-2017"
CBS_LOCALITIES_2019_URL = "https://www.cbs.gov.il/he/mediarelease/DocLib/2019/370/05_19_370b.pdf"
CBS_CAUSES_2024 = "CBS 125/2024, סיבות מוות בישראל 2020-2022"
CBS_CAUSES_2024_URL = "https://www.cbs.gov.il/he/mediarelease/DocLib/2024/125/05_24_125b.pdf"
YNET_BEDOUIN_INFANT_URL = "https://www.ynet.co.il/news/article/Skzl11ziLD"
ISRAELHAYOM_MATERNAL_URL = "https://www.israelhayom.co.il/health/article/18306603"
MDA_DROWNING_URL = "https://www.kikar.co.il/israel-news/sm805p"
POLICE_VIOLENCE_MAP_URL = "https://www.meida.org.il/17146"

# Rendered as a clickable source list at the top of the page - every fact on
# this page traces back to one of these four (the first two cover nearly
# everything; the last two are the only facts NOT drawn from a single CBS
# publication - see their own `source` fields below and the page's own "מה
# ייחודי כאן" explainer for why that distinction matters).
SOURCES = [
    {"label": CBS_LOCALITIES_2019, "url": CBS_LOCALITIES_2019_URL,
     "covers": "ערים (65 יישובים), אזור (מחוז/נפה), תוחלת חיים לפי מגזר"},
    {"label": CBS_CAUSES_2024, "url": CBS_CAUSES_2024_URL,
     "covers": "ארצי: התפלגות סיבות מוות (היחיד עם מספר לשבץ מוחי), פערי תמותה יהודים/ערבים"},
    {"label": "ynet, מבוסס על נתוני הלמ\"ס/משרד הבריאות", "url": YNET_BEDOUIN_INFANT_URL,
     "covers": "תמותת תינוקות בדואים בנגב - אינו בפרסום למ\"ס יחיד, ראו הסבר"},
    {"label": "ישראל היום, מבוסס על נתוני משרד הבריאות", "url": ISRAELHAYOM_MATERNAL_URL,
     "covers": "תמותת יולדות - אינו בפרסום למ\"ס יחיד, ראו הסבר"},
    {"label": "מגן דוד אדום, סיכום עונת הרחצה 2024", "url": MDA_DROWNING_URL,
     "covers": "טביעה - הרוגים, ארצי בלבד (מד\"א אינו מפרסם לפי מחוז)"},
    {"label": "התנועה לחופש המידע, מפת הפשיעה בישראל", "url": POLICE_VIOLENCE_MAP_URL,
     "covers": "אלימות חמורה לפי מחוז, רצח ארצי - נתוני משטרה שפורסמו רק בעקבות בקשת חופש מידע"},
]

# ---------------------------------------------------------------------------
# CITY level - only localities that were actually named in a CBS top/bottom-10
# table appear here; every other Israeli locality simply has no publicly
# published cause-specific figure (see mortality-compare.html's own notice).
# `n` = national average for that metric, repeated on every entry it applies
# to would be redundant - stored once in CITY_METRICS below instead.
# ---------------------------------------------------------------------------

# rate/ci are as printed; a `low_n` flag marks values CBS itself parenthesised
# as based on 5-19 cases (statistically unstable, still shown but flagged).
CITY_MORTALITY = {
    # --- לוח א: שיעור תמותה מתוקנן לגיל (ל-1,000 תושבים), ממוצע 2013-2017 ---
    "מודיעין-מכבים-רעות": {"overallMortality": {"rate": 3.2, "ci": [2.9, 3.4]},
        "heartDisease": {"rate": 154.5, "ci": [121.4, 187.5]},
        "infantMortality": {"rate": 1.7, "low_n": True}},
    "שוהם": {"overallMortality": {"rate": 3.2, "ci": [2.7, 3.7]},
        "heartDisease": {"rate": 157.5, "ci": [84.0, 231.0]}},
    "מודיעין עילית": {"overallMortality": {"rate": 3.3, "ci": [2.7, 3.8]},
        "lifeExpectancy": {"total": 87.6, "sizeClass": "50k-99999", "rank": "highest"}},
    "גבעת זאב": {"overallMortality": {"rate": 3.4, "ci": [2.8, 3.9]}},
    "מבשרת ציון": {"overallMortality": {"rate": 3.6, "ci": [3.3, 3.9]}},
    "באר יעקב": {"overallMortality": {"rate": 3.6, "ci": [3.1, 4.1]},
        "heartDisease": {"rate": 163.9, "ci": [97.5, 230.3]}},
    "גדרה": {"overallMortality": {"rate": 3.7, "ci": [3.4, 4.1]}},
    "רמת השרון": {"overallMortality": {"rate": 3.7, "ci": [3.5, 3.9]},
        "heartDisease": {"rate": 168.1, "ci": [143.5, 192.8]},
        "diabetes": {"rate": 39.6, "ci": [38.6, 40.6]},
        "infantMortality": {"rate": 1.4, "low_n": True}},
    "גני תקווה": {"overallMortality": {"rate": 3.8, "ci": [3.4, 4.3]},
        "heartDisease": {"rate": 137.6, "ci": [87.3, 187.8]}},
    "קריית טבעון": {"overallMortality": {"rate": 3.9, "ci": [3.5, 4.2]}},
    "ג'סר א-זרקא": {"overallMortality": {"rate": 9.3, "ci": [8.1, 10.5]},
        "cancer": {"rate": 550.5, "ci": [340.2, 760.9]},
        "heartDisease": {"rate": 403.3, "ci": [196.5, 610.1]},
        "diabetes": {"rate": 138.1, "ci": [136.2, 140.0]},
        "infantMortality": {"rate": 8.6, "low_n": True}},
    "לקיה": {"overallMortality": {"rate": 7.5, "ci": [6.2, 8.7]},
        "cancer": {"rate": 285.0, "ci": [92.5, 478.4], "low_n": True},
        "diabetes": {"rate": 107.1, "ci": [105.6, 108.6]},
        "infantMortality": {"rate": 8.6}},
    "תל שבע": {"overallMortality": {"rate": 6.9, "ci": [6.0, 7.9]},
        "cancer": {"rate": 314.0, "ci": [137.9, 490.6], "low_n": True},
        "diabetes": {"rate": 111.7, "ci": [108.2, 115.2]},
        "infantMortality": {"rate": 11.9}},
    "אכסאל": {"overallMortality": {"rate": 6.9, "ci": [5.9, 7.9]},
        "heartDisease": {"rate": 470.3, "ci": [282.6, 658.0]},
        "diabetes": {"rate": 104.1, "ci": [102.3, 105.8]}},
    "פוריידיס": {"overallMortality": {"rate": 6.8, "ci": [5.9, 7.7]}},
    "טייבה": {"overallMortality": {"rate": 6.7, "ci": [6.2, 7.2]},
        "diabetes": {"rate": 103.3, "ci": [101.7, 105.0]}},
    "כפר קאסם": {"overallMortality": {"rate": 6.7, "ci": [6.0, 7.5]},
        "diabetes": {"rate": 109.0, "ci": [106.6, 111.3]},
        "infantMortality": {"rate": 8.3}},
    "דימונה": {"overallMortality": {"rate": 6.7, "ci": [6.3, 7.0]}},
    "ג'דיידה-מכר": {"overallMortality": {"rate": 6.6, "ci": [5.9, 7.3]},
        "heartDisease": {"rate": 508.5, "ci": [373.8, 643.1]},
        "cancer": {"rate": 501.8, "ci": [374.1, 629.4]}},
    "אופקים": {"overallMortality": {"rate": 6.5, "ci": [6.0, 6.9]},
        "cancer": {"rate": 511.3, "ci": [436.0, 586.7]}},

    # --- לוח ב: תמותה ממחלות לב (ל-100,000, גיל 45+), ממוצע 2012-2016 ---
    "מג'דל שמס": {"heartDisease": {"rate": 106.0, "ci": [32.5, 179.0], "low_n": True},
        "cancer": {"rate": 186.0, "ci": [94.4, 276.8], "low_n": True}},
    "קריית עקרון": {"heartDisease": {"rate": 110.0, "ci": [55.9, 164.3], "low_n": True}},
    "מעלה אדומים": {"heartDisease": {"rate": 146.9, "ci": [107.9, 185.9]}},
    "כסיפה": {"heartDisease": {"rate": 154.0, "ci": [45.7, 262.7], "low_n": True},
        "cancer": {"rate": 291.0, "ci": [147.0, 435.7], "low_n": True},
        "infantMortality": {"rate": 16.0}},
    "גבעת שמואל": {"heartDisease": {"rate": 167.8, "ci": [123.8, 211.8]}},
    "אבו סנאן": {"heartDisease": {"rate": 434.1, "ci": [297.6, 570.6]}},
    "טורעאן": {"heartDisease": {"rate": 416.2, "ci": [265.8, 566.6]}},
    "מג'ד אל-כרום": {"heartDisease": {"rate": 413.4, "ci": [267.4, 559.3]}},
    "דאלית אל-כרמל": {"heartDisease": {"rate": 413.3, "ci": [300.3, 526.3]}},
    "קלנסווה": {"heartDisease": {"rate": 403.9, "ci": [274.5, 533.3]},
        "diabetes": {"rate": 122.5, "ci": [119.9, 125.1]}},
    "כפר כנא": {"heartDisease": {"rate": 402.1, "ci": [273.1, 531.1]},
        "infantMortality": {"rate": 7.5, "low_n": True}},
    "טירה": {"heartDisease": {"rate": 397.4, "ci": [304.1, 490.8]}},

    # --- לוח ג: תמותה מסרטן (ל-100,000, גיל 45+), ממוצע 2012-2016 ---
    "ערערה-בנגב": {"cancer": {"rate": 358.0, "ci": [159.7, 555.7], "low_n": True}},
    "דייר אל-אסד": {"cancer": {"rate": 216.0, "ci": [107.0, 325.0], "low_n": True}},
    "חורה": {"cancer": {"rate": 202.0, "ci": [78.4, 324.8], "low_n": True},
        "infantMortality": {"rate": 9.7}},
    "ירכא": {"cancer": {"rate": 264.1, "ci": [178.6, 349.7]}},
    "כפר קרע": {"cancer": {"rate": 266.8, "ci": [176.4, 357.2]},
        "infantMortality": {"rate": 7.4, "low_n": True}},
    "גן יבנה": {"cancer": {"rate": 267.9, "ci": [190.6, 345.2]}},
    "שדרות": {"cancer": {"rate": 530.8, "ci": [453.8, 607.8]}},
    "אור עקיבא": {"cancer": {"rate": 516.8, "ci": [435.9, 597.7]}},
    "נצרת עילית": {"cancer": {"rate": 505.1, "ci": [461.0, 549.1]}},
    "בת ים": {"cancer": {"rate": 497.8, "ci": [473.0, 521.8]},
        "lifeExpectancy": {"total": 81.0, "men": 78.4, "women": 83.3, "sizeClass": "100k+", "rank": "lowest"}},
    "אילת": {"cancer": {"rate": 495.7, "ci": [435.6, 555.8]},
        "infantMortality": {"rate": 1.3, "low_n": True},
        "lifeExpectancy": {"total": 80.0, "sizeClass": "50k-99999"}},
    "עכו": {"cancer": {"rate": 494.5, "ci": [447.0, 542.0]}},
    "בית שאן": {"cancer": {"rate": 491.9, "ci": [401.6, 528.1]}},

    # --- לוח ד: תמותת תינוקות (ל-1,000 לידות חי), ממוצע 2013-2017 ---
    "כפר סבא": {"infantMortality": {"rate": 0.9, "low_n": True}},
    "רעננה": {"infantMortality": {"rate": 1.3, "low_n": True},
        "diabetes": {"rate": 40.3, "ci": [40.0, 40.5]}},
    "תל אביב-יפו": {"infantMortality": {"rate": 1.6}},
    "רמת גן": {"infantMortality": {"rate": 1.6},
        "diabetes": {"rate": 42.0, "ci": [41.2, 42.8]},
        "lifeExpectancy": {"total": 84.6, "men": 82.6, "women": 86.4, "sizeClass": "100k+", "rank": "highest"}},
    "פתח תקווה": {"infantMortality": {"rate": 1.6}},
    "הרצלייה": {"infantMortality": {"rate": 1.7, "low_n": True},
        "diabetes": {"rate": 43.5, "ci": [43.1, 44.0]}},
    "ראשון לציון": {"infantMortality": {"rate": 1.9}},
    "רהט": {"infantMortality": {"rate": 10.5}},
    "רכסים": {"infantMortality": {"rate": 7.7, "low_n": True}},
    "ערערה": {"infantMortality": {"rate": 7.4, "low_n": True}},

    # --- לוח ה: הימצאות סוכרת (ל-1,000 תושבים), ממוצע 2012-2016 ---
    "בנימינה-גבעת עדה": {"diabetes": {"rate": 37.4, "ci": [37.0, 37.8]}},
    "קריית טבעון ": {"diabetes": {"rate": 40.2, "ci": [39.5, 40.9]}},  # distinct key spacing avoided below
    "גבעתיים": {"diabetes": {"rate": 41.1, "ci": [40.7, 41.4]}},
    "קדימה-צורן": {"diabetes": {"rate": 41.2, "ci": [40.4, 42.0]}},
    "מבשרת ציון ": {"diabetes": {"rate": 41.5, "ci": [40.9, 42.1]}},
    "זכרון יעקב": {"diabetes": {"rate": 44.2, "ci": [44.1, 44.4]}},
    "אום אל-פחם": {"diabetes": {"rate": 110.9, "ci": [108.7, 113.1]},
        "lifeExpectancy": {"total": 79.0, "sizeClass": "50k-99999", "rank": "lowest"}},
    "נחף": {"diabetes": {"rate": 108.3, "ci": [107.1, 109.5]}},
    "מעלה עירון": {"diabetes": {"rate": 106.1, "ci": [103.9, 108.4]}},

    # --- תרשים 2/3: תוחלת חיים ביישובים (בלבד, אין להם נתון סיבת-מוות אחר) ---
    "הוד השרון": {"lifeExpectancy": {"total": 86.0, "sizeClass": "50k-99999"}},
    "לוד": {"lifeExpectancy": {"total": 80.3, "sizeClass": "50k-99999"}, "note": "עיר מעורבת"},
    "רמלה": {"lifeExpectancy": {"total": 80.9, "sizeClass": "50k-99999"}, "note": "עיר מעורבת"},
}

# Fix the two accidental trailing-space duplicate keys above (קריית טבעון /
# מבשרת ציון already exist from earlier tables) by merging instead of
# shadowing - Python dict literals would otherwise just silently keep only
# the first "קריית טבעון" as one entry.
CITY_MORTALITY["קריית טבעון"].update(CITY_MORTALITY.pop("קריית טבעון "))
CITY_MORTALITY["מבשרת ציון"].update(CITY_MORTALITY.pop("מבשרת ציון "))

CITY_METRIC_META = {
    "overallMortality": {"label": "תמותה כללית (מתוקננת)", "unit": "ל-1,000 תושבים", "national": 4.9, "source": CBS_LOCALITIES_2019, "period": "ממוצע 2013-2017"},
    "heartDisease": {"label": "תמותה ממחלות לב", "unit": "ל-100,000 (גיל 45+)", "national": 247.05, "source": CBS_LOCALITIES_2019, "period": "ממוצע 2012-2016"},
    "cancer": {"label": "תמותה מסרטן", "unit": "ל-100,000 (גיל 45+)", "national": 412.31, "source": CBS_LOCALITIES_2019, "period": "ממוצע 2012-2016"},
    "infantMortality": {"label": "תמותת תינוקות", "unit": "ל-1,000 לידות חי", "national": 3.1, "source": CBS_LOCALITIES_2019, "period": "ממוצע 2013-2017"},
    "diabetes": {"label": "הימצאות סוכרת", "unit": "ל-1,000 תושבים", "national": 56.2, "source": CBS_LOCALITIES_2019, "period": "ממוצע 2012-2016"},
}

# ---------------------------------------------------------------------------
# ZONE level - district (מחוז, 6 + יהודה ושומרון) and sub-district (נפה, ~15).
# `rank`-only entries (no `rate`) mean the source only gave a qualitative
# ranking (chart-only in the PDF, no extractable value) - see module
# docstring. Never treat a `rank`-only entry as a number.
# ---------------------------------------------------------------------------
ZONE_DISTRICT = {
    "ירושלים": {"lifeExpectancy": {"total": None, "note": "גבוה ביותר בקרב יהודים (84.4)"}, "infantMortality": {"rate": 3.3, "aboveNational": True}},
    "הצפון": {"overallMortality": {"rate": 5.3, "aboveNational": True}, "infantMortality": {"rate": 3.9, "aboveNational": True}, "heartDisease": {"rank": "high"}, "diabetes": {"rank": "high"}},
    "חיפה": {"overallMortality": {"rate": 5.1, "aboveNational": True}, "heartDisease": {"rank": "high"}},
    "המרכז": {},
    "תל אביב": {"lifeExpectancy": {"total": 81.1, "rank": "lowest"}},
    "הדרום": {"overallMortality": {"rate": 5.3, "aboveNational": True}, "infantMortality": {"rate": 5.9, "aboveNational": True}, "cancer": {"rank": "high"}},
    "יהודה ושומרון": {"lifeExpectancy": {"total": 84.1, "rank": "highest"}, "overallMortality": {"rate": 4.0, "rank": "lowest"}, "infantMortality": {"rank": "low"}},
}

ZONE_SUBDISTRICT = {
    "באר שבע": {"infantMortality": {"rate": 6.9, "rank": "highest"}, "lifeExpectancy": {"rank": "lowest"}},
    "גולן": {"infantMortality": {"rate": 1.8, "rank": "lowest"}, "diabetes": {"rate": 70.5, "rank": "highest"}, "cancer": {"rank": "high"}},
    "פתח תקווה": {"infantMortality": {"rate": 1.9}, "heartDisease": {"rank": "low"}},
    "יזרעאל": {"diabetes": {"rate": 33.1, "rank": "lowest"}, "heartDisease": {"rank": "high"}},
    "חדרה": {"diabetes": {"rank": "high"}},
    "תל אביב": {"cancer": {"rank": "low"}},
    "ירושלים": {"cancer": {"rank": "low"}, "heartDisease": {"rank": "low"}},
    "אשקלון": {"cancer": {"rank": "high"}, "heartDisease": {"rank": "low"}},
    "עכו": {"heartDisease": {"rank": "high"}},
}

ZONE_META = {"source": CBS_LOCALITIES_2019, "note": "רמת דיוק שונה מרמת העיר: חלק מהערכים הם דירוג איכותני בלבד (\"גבוה\"/\"נמוך\" יחסית לשאר הארץ), לא שיעור מספרי - כך פורסמו במקור (תרשים, לא טבלה)."}

# ---------------------------------------------------------------------------
# NATIONAL level
# ---------------------------------------------------------------------------
NATIONAL_TOP_CAUSES = [
    # order matches table א, sorted by 2022
    {"cause": "כל המחלות הממאירות", "y2020": {"n": 11758, "pct": 24.1}, "y2021": {"n": 11583, "pct": 22.8}, "y2022": {"n": 11650, "pct": 22.5}},
    {"cause": "מחלות לב", "y2020": {"n": 6531, "pct": 13.4}, "y2021": {"n": 6393, "pct": 12.6}, "y2022": {"n": 6455, "pct": 12.5}},
    {"cause": "מחלת נגיף קורונה (COVID-19)", "y2020": {"n": 3160, "pct": 6.5}, "y2021": {"n": 4800, "pct": 9.5}, "y2022": {"n": 4344, "pct": 8.4}},
    {"cause": "מחלות זיהומיות", "y2020": {"n": 2169, "pct": 4.4}, "y2021": {"n": 2322, "pct": 4.6}, "y2022": {"n": 2545, "pct": 4.9}},
    {"cause": "סוכרת", "y2020": {"n": 2598, "pct": 5.3}, "y2021": {"n": 2497, "pct": 4.9}, "y2022": {"n": 2472, "pct": 4.8}},
    {"cause": "דמנציה", "y2020": {"n": 2094, "pct": 4.3}, "y2021": {"n": 2007, "pct": 4.0}, "y2022": {"n": 2160, "pct": 4.2}},
    {"cause": "מחלות כלי דם במוח (שבץ מוחי)", "y2020": {"n": 2178, "pct": 4.5}, "y2021": {"n": 2120, "pct": 4.2}, "y2022": {"n": 2060, "pct": 4.0}},
    {"cause": "סיבות חיצוניות", "y2020": {"n": 1840, "pct": 3.8}, "y2021": {"n": 1946, "pct": 3.8}, "y2022": {"n": 1920, "pct": 3.7}},
    {"cause": "מחלות כליה", "y2020": {"n": 1485, "pct": 3.0}, "y2021": {"n": 1552, "pct": 3.1}, "y2022": {"n": 1565, "pct": 3.0}},
    {"cause": "דלקת ריאות", "y2020": {"n": 1407, "pct": 2.9}, "y2021": {"n": 1446, "pct": 2.8}, "y2022": {"n": 1553, "pct": 3.0}},
    {"cause": "כל שאר המחלות", "y2020": {"n": 13577, "pct": 27.8}, "y2021": {"n": 14106, "pct": 27.8}, "y2022": {"n": 15029, "pct": 29.0}},
    {"cause": "סך הכל", "y2020": {"n": 48797, "pct": 100.0}, "y2021": {"n": 50772, "pct": 100.0}, "y2022": {"n": 51753, "pct": 100.0}},
]

NATIONAL_BY_POPULATION_GROUP = {
    "lifeExpectancy": {
        "jewish": {"total": 83.1, "men": 81.1, "women": 84.9},
        "arab": {"total": 79.5, "men": 77.4, "women": 81.4},
        "period": "ממוצע 2013-2017", "source": CBS_LOCALITIES_2019,
    },
    "higherAmongArabs": [
        {"cause": "סוכרת", "multiplier": 2.2},
        {"cause": "מחלות כרוניות של דרכי הנשימה העליונות", "multiplier": 2.0},
        {"cause": "תאונות דרכים", "multiplier": 2.5},
        {"cause": "רצח", "multiplier": 8.2},
    ],
    "higherAmongJews": [
        {"cause": "התאבדויות", "multiplier": 2.1},
        {"cause": "דמנציה (קיהיון)", "multiplier": 1.3},
    ],
    "source": CBS_CAUSES_2024, "period": "2020-2022, שיעורים מתוקננים לגיל",
}

NATIONAL_INFANT_MORTALITY_BY_SECTOR = {
    "jewish": 2.3, "arab": 5.4, "bedouinNegev": 9.0,
    "unit": "ל-1,000 לידות חי",
    "source": "ynet, מבוסס על נתוני הלמ\"ס/משרד הבריאות (אין דף פרסום למ\"ס יחיד לנתון זה)",
    "sourceUrl": YNET_BEDOUIN_INFANT_URL,
}

NATIONAL_MATERNAL_MORTALITY = {
    "ratePer100k": 3, "deathsPerYear": 5,
    "note": "מספר קטן מדי (כ-5 מקרים בשנה בכלל הארץ) לפילוח אמין לפי עיר, אזור או מגזר - נשאר כנתון ארצי יחיד.",
    "source": "ישראל היום, מבוסס על נתוני משרד הבריאות",
    "sourceUrl": ISRAELHAYOM_MATERNAL_URL,
}

# Magen David Adom's own end-of-bathing-season tallies - no district/מחוז
# breakdown exists for this (checked): MDA only publishes by water-body
# type (sea/pool/etc.) and age group, never by region. y2023/y2024.deaths
# are actual deaths; byWaterBody2024 is NOT a deaths breakdown - MDA never
# published deaths-per-water-body, only how the larger treated/rescued
# count (366 in 2024) splits by water-body type. Keep these visually
# distinct on the page - a by-water-body chart of the treated count must
# not be labeled or read as a deaths chart.
NATIONAL_MDA_DROWNING = {
    "y2023": {"treated": 266, "deaths": 51},
    "y2024": {"treated": 366, "deaths": 54},
    "treatedByWaterBody2024": {
        "הים התיכון": 189, "ים המלח": 28, "הכנרת": 26, "ים סוף": 12,
        "בריכות ציבוריות": 52, "בריכות פרטיות": 43,
    },
    "note": "מד\"א אינו מפרסם פילוח לפי מחוז - רק לפי סוג גוף המים וגיל.",
    "source": "מגן דוד אדום, סיכום עונת הרחצה 2024",
    "sourceUrl": MDA_DROWNING_URL,
}

# Israel Police stopped publishing crime statistics in 2023 (under Minister
# Ben Gvir); this district breakdown exists only because "התנועה לחופש
# המידע" (Movement for Freedom of Information) forced release via a
# freedom-of-information request. "victims" here is broader than deaths -
# the underlying category is severe violent offenses combined (murder,
# attempted murder, robbery, threats, assault) - the police data doesn't
# break murder out on its own at district level, only nationally and by
# city (and the page doesn't show city-level here per the user's own
# scope choice - see NATIONAL_POLICE_MURDER below for the national figure).
NATIONAL_POLICE_VIOLENCE_BY_DISTRICT = {
    "הדרום": 44000, "ירושלים": 38000, "תל אביב": 30000, "הצפון": 9000, "חיפה": 5756,
}
NATIONAL_POLICE_VIOLENCE_META = {
    "period": "5 שנים (עד 2025)",
    "note": "קורבנות עבירות אלימות חמורות (רצח, ניסיון רצח, שוד, איומים ותקיפה יחד) - המשטרה אינה מפרסמת רצח בלבד לפי מחוז, רק ארצית ולפי עיר. הנתונים פורסמו רק בעקבות בקשת חופש מידע - המשטרה הפסיקה לפרסם נתוני פשיעה ב-2023.",
    "source": "התנועה לחופש המידע, מפת הפשיעה בישראל",
    "sourceUrl": POLICE_VIOLENCE_MAP_URL,
}
NATIONAL_POLICE_MURDER = {
    "total": 479, "period": "2023-2024",
    "note": "עלייה של 85% לעומת השנתיים שקדמו לכך.",
    "source": "התנועה לחופש המידע, מפת הפשיעה בישראל",
    "sourceUrl": POLICE_VIOLENCE_MAP_URL,
}

NATIONAL_META = {"causesSource": CBS_CAUSES_2024, "causesPeriod": "2020-2022"}


def write_js(varname, data, header_comment=None):
    lines = []
    if header_comment:
        for c in header_comment.split("\n"):
            lines.append(f"// {c}")
    lines.append(f"export const {varname} = {json.dumps(data, ensure_ascii=False, indent=2)};")
    return "\n".join(lines)


def main():
    out = SRC / "mortality-data.js"
    header = (
        "Cause-of-death data for mortality-compare.html - hand-transcribed from CBS\n"
        "publications, not fetched/parsed (see tools/mortality_build.py's own\n"
        "docstring for exactly why, and full source citations).\n"
        "Generated by tools/mortality_build.py - do not edit by hand."
    )
    blocks = [
        write_js("SOURCES", SOURCES),
        write_js("CITY_MORTALITY", CITY_MORTALITY),
        write_js("CITY_METRIC_META", CITY_METRIC_META),
        write_js("ZONE_DISTRICT", ZONE_DISTRICT),
        write_js("ZONE_SUBDISTRICT", ZONE_SUBDISTRICT),
        write_js("ZONE_META", ZONE_META),
        write_js("NATIONAL_TOP_CAUSES", NATIONAL_TOP_CAUSES),
        write_js("NATIONAL_BY_POPULATION_GROUP", NATIONAL_BY_POPULATION_GROUP),
        write_js("NATIONAL_INFANT_MORTALITY_BY_SECTOR", NATIONAL_INFANT_MORTALITY_BY_SECTOR),
        write_js("NATIONAL_MATERNAL_MORTALITY", NATIONAL_MATERNAL_MORTALITY),
        write_js("NATIONAL_MDA_DROWNING", NATIONAL_MDA_DROWNING),
        write_js("NATIONAL_POLICE_VIOLENCE_BY_DISTRICT", NATIONAL_POLICE_VIOLENCE_BY_DISTRICT),
        write_js("NATIONAL_POLICE_VIOLENCE_META", NATIONAL_POLICE_VIOLENCE_META),
        write_js("NATIONAL_POLICE_MURDER", NATIONAL_POLICE_MURDER),
        write_js("NATIONAL_META", NATIONAL_META),
    ]
    commented_header = "\n".join(f"// {line}" for line in header.split("\n"))
    out.write_text(commented_header + "\n\n" + "\n\n".join(blocks) + "\n", encoding="utf-8")
    kb = out.stat().st_size / 1024
    print(f"wrote {out.relative_to(ROOT)} ({kb:.1f} KB, {len(CITY_MORTALITY)} cities)")


if __name__ == "__main__":
    main()
