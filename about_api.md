# Ministry of Health datasets — findings

Notes from scouting data.gov.il for a possible "משרד הבריאות" app (light-blue
accent, accidents/committees-style). The app itself was not built; this is
what was confirmed before the task was dropped. Checked 2026-07-21.

Organization slug: **`ministry-health`** (54 packages). Note: the underscored
form `ministry_of_health` silently returns `count: 0` — no error, just empty —
so it's easy to conclude the org doesn't exist when it does.

## 1. נתוני הערכת גדילה: תלמידים עם השמנה לפי מגזרים

- **Package**: `bichildrengrowth2016` — "נתוני הערכת גדילה של תלמידים בישראל
  - משרד הבריאות"
- **Resource**: `2c181d7b-be3a-41be-a99a-7228eccb665b`, format XLSX,
  `datastore_active: false`
- **Coverage**: 2016 only. Growth measurements taken in schools by public
  health nurses, grades א׳ and ז׳.
- **Status: blocked, unverified.** No DataStore API exists for this resource
  (single XLSX file only). The download URL
  (`e.data.gov.il/dataset/54b90478-.../download/bichildrengrowth2016.xlsx`)
  returned an obfuscated JS challenge page instead of the file — a WAF
  blocking the request's datacentre IP, the same block already documented for
  `datastore_search_sql` on the accidents pipeline. `gov.il`'s own page
  describing the dataset (`gov.il/he/pages/kidsmatures-bi`) also returned
  403 for the same reason.
- **Open question**: whether the file actually has a sector ("מגזר") column
  was never confirmed — the columns were never seen. A real browser (not a
  server-side probe) would likely get past the block, per this project's
  established pattern (`file://` / browser origin `null` is accepted where
  datacentre IPs are not) — untested here.

## 2. תופעות לוואי אחרי חיסון קורונה

- **Package**: `vacseffect` — "תופעות לאחר חיסוני קורונה"
- **7 resources** in the package, 3 of which are live DataStore tables
  (queryable via `datastore_search`), the rest are static PDF/XLSX:

| Resource ID | Name | Format | Live? |
|---|---|---|---|
| `425ce312-22d9-4166-a8ec-eb14c6d7aad8` | ReadMe דיווחים מהציבור.pdf | PDF | no |
| `ef7d5284-db2e-4db9-b0df-01ed9ba92ed8` | Effects from Public | XLSX | no |
| `b7c1a598-7c3c-4261-9dba-11e04e1621cc` | ReadMe דיווחים מצוותים רפואיים לפי גיל מין ויצרן.pdf | PDF | no |
| `0e804f1f-2b9e-4e97-8ac5-cefb6aecf730` | Effect By Sex and Type | XLSX | **yes** |
| `7b821b6b-3645-433a-a660-660c0cc47372` | Effect By Age and Type | XLSX | **yes** |
| `5d29e00f-458c-4552-a46c-76e703b3d27b` | ReadMe דיווחים מצוותים רפואיים לפי זמן.pdf | PDF | no |
| `3f9e53e9-3a0f-4793-98f6-79d7083e712f` | Effect by Timing | XLSX | **yes** |

**`Effect by Timing` (`3f9e53e9…`) — reliable.** 55,499 individual reports.
Fields: `#`, `PortionNum`, `SideEffectStartTime`, `DetailsStartTimeType`,
`SideEffectDurationTime`, `DetailsDurationTimeType`, `תופעות שאירעו בסמיכות
לקבלת חיסון`. Clean per-report rows — no structural issues found. This is
the one worth building on if the app is revisited.

**`Effect By Sex and Type` (`0e804f1f…`) and `Effect By Age and Type`
(`7b821b6b…`) — look like partial pivot exports, not safe to present as-is.**
Both share fields `ספירה של PersonId`, `Pfizer`, `Moderna`, `AstraZeneca` (179
rows each). Row 1 in each is a mislabeled header: instead of real column
names it carries a single category value repeated across all three
manufacturer columns — `"זכר"` (male) for the sex table, `"גיל 5-59"` for the
age table. Fetching all 179 rows of the sex table found no second block for
`"נקבה"` (female), and no other age bracket appears in the age table either.
Reads like an Excel workbook where only one sheet/section of a larger pivot
survived the export. **Do not present as a full sex/age breakdown without
cross-checking against the PDF readme** (`b7c1a598-7c3c-4261-9dba-
11e04e1621cc`, which documents the intended breakdown by age, sex, and
manufacturer).

## Design mockup (not committed)

A visual mockup was built for a two-section page ("משרד הבריאות") covering
both datasets, with a light-blue `--accent` (`#0f96bd` light / `#5cc9ea`
dark) following this repo's existing per-page accent-override pattern
(`body.accidents-page`, `body.committees-page`, `body.finance-page` in
`src/style.css`, each overriding only `--accent`). It was a Claude-side
Artifact only, never added to the repo. `SESSION.md` (`## 2026-07-21`) has
the full build-log entry; nothing under `src/` or `apis.json` was touched.
