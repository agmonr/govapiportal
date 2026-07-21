/**
 * Local & regional planning-committee sites reachable through the Complot
 * engine (handasi.complot.co.il) - the same public, no-auth, CORS-open API a
 * scraper mapped by sweeping siteid 1-120 and recording which ones served a
 * document archive (see /home/ram/Documents/scrapers/FINDINGS.md). 68 sites
 * responded; siteid > 120 was never swept, so this is a floor, not a claim of
 * completeness.
 *
 * Every site only carries what was actually verified: the siteid, its archive
 * folder slug (the one string the API itself exposes), and a real meeting
 * count from one probed 2024 H1 window - never a total. name_he is filled in
 * only where the slug unambiguously names a real Israeli municipality or
 * regional council; where it doesn't, name_he is null and the UI falls back
 * to the slug rather than guess at a civic institution's name.
 *
 * kind is best-effort from the slug/known geography, 'local' (municipal) or
 * 'regional' (מועצה אזורית - multiple settlements under one planning
 * committee) - not from any field the API returns.
 */
export const COMMITTEE_SITES = [
  { siteid: 1, slug: 'Amakim', name_he: 'עמקים', kind: 'regional' },
  { siteid: 2, slug: 'Maale-Naftali', name_he: 'מעלה נפתלי', kind: 'regional' },
  { siteid: 3, slug: 'RamatGan', name_he: 'רמת גן', kind: 'local' },
  { siteid: 4, slug: 'metar', name_he: 'מיתר', kind: 'local' },
  { siteid: 5, slug: 'Modiin_ilit', name_he: 'מודיעין עילית', kind: 'local' },
  { siteid: 6, slug: 'GushEtzion', name_he: 'גוש עציון', kind: 'regional' },
  { siteid: 7, slug: 'Hevel_Eilot', name_he: 'חבל אילות', kind: 'regional' },
  { siteid: 8, slug: 'Migdal_Haemek', name_he: 'מגדל העמק', kind: 'local' },
  { siteid: 9, slug: 'K_Shomron', name_he: null, kind: 'unknown' },
  { siteid: 10, slug: 'Galil-Tachton', name_he: 'הגליל התחתון', kind: 'regional' },
  { siteid: 11, slug: 'Dimona', name_he: 'דימונה', kind: 'local' },
  { siteid: 12, slug: 'Eyarden', name_he: 'עמק הירדן', kind: 'regional' },
  { siteid: 13, slug: 'Ksaba', name_he: null, kind: 'unknown' },
  { siteid: 14, slug: 'Shomron', name_he: 'שומרון', kind: 'regional' },
  { siteid: 15, slug: 'Raanana', name_he: 'רעננה', kind: 'local' },
  { siteid: 16, slug: 'Haifa', name_he: 'חיפה', kind: 'local' },
  { siteid: 20, slug: 'GalilMerkazi', name_he: 'הגליל המרכזי', kind: 'regional' },
  { siteid: 22, slug: 'Rehovot', name_he: 'רחובות', kind: 'local' },
  { siteid: 24, slug: 'Tira', name_he: 'טירה', kind: 'local' },
  { siteid: 25, slug: 'Bet-Hakerem', name_he: 'בית הכרם', kind: 'regional' },
  { siteid: 27, slug: 'Aloneem', name_he: 'אלונים', kind: 'regional' },
  { siteid: 31, slug: 'Emek_lod', name_he: 'עמק לוד', kind: 'regional' },
  { siteid: 32, slug: 'Kiryat_Ata', name_he: 'קריית אתא', kind: 'local' },
  { siteid: 33, slug: 'HadHasharon', name_he: 'הוד השרון', kind: 'local' },
  { siteid: 34, slug: 'Holon', name_he: 'חולון', kind: 'local' },
  { siteid: 35, slug: 'Beitar-Ilit', name_he: 'ביתר עילית', kind: 'local' },
  { siteid: 38, slug: 'sderot', name_he: 'שדרות', kind: 'local' },
  { siteid: 43, slug: 'LevHasharon', name_he: 'לב השרון', kind: 'regional' },
  { siteid: 46, slug: 'k-gat', name_he: 'קריית גת', kind: 'local' },
  { siteid: 49, slug: 'Sharonim', name_he: 'שרונים', kind: 'regional' },
  { siteid: 54, slug: 'BeitShean', name_he: 'בית שאן', kind: 'local' },
  { siteid: 55, slug: 'Kfar-Yona', name_he: 'כפר יונה', kind: 'local' },
  { siteid: 56, slug: 'Eilat', name_he: 'אילת', kind: 'local' },
  { siteid: 57, slug: 'Iron', name_he: 'עירון', kind: 'regional' },
  { siteid: 61, slug: 'MordotHacarmel', name_he: 'מורדות הכרמל', kind: 'regional' },
  { siteid: 63, slug: 'Yoqneam', name_he: 'יקנעם עילית', kind: 'local' },
  { siteid: 66, slug: 'Tiberias', name_he: 'טבריה', kind: 'local' },
  { siteid: 67, slug: 'Ofakim', name_he: 'אופקים', kind: 'local' },
  { siteid: 70, slug: 'MaaleHagalil', name_he: 'מעלה הגליל', kind: 'regional' },
  { siteid: 73, slug: 'Or-Yehuda', name_he: 'אור יהודה', kind: 'local' },
  { siteid: 75, slug: 'bneybrak', name_he: 'בני ברק', kind: 'local' },
  { siteid: 77, slug: 'M_Sharon', name_he: null, kind: 'unknown' },
  { siteid: 78, slug: 'Ashdod', name_he: 'אשדוד', kind: 'local' },
  { siteid: 80, slug: 'Nahariya', name_he: 'נהריה', kind: 'local' },
  { siteid: 81, slug: 'BatYam', name_he: 'בת ים', kind: 'local' },
  { siteid: 82, slug: 'Modiin', name_he: 'מודיעין-מכבים-רעות', kind: 'local' },
  { siteid: 83, slug: 'Emanuel', name_he: 'עמנואל', kind: 'local' },
  { siteid: 84, slug: 'pt', name_he: 'פתח תקווה', kind: 'local' },
  { siteid: 86, slug: 'Maale-Hermon', name_he: 'מעלה החרמון', kind: 'regional' },
  { siteid: 87, slug: 'Yavne', name_he: 'יבנה', kind: 'local' },
  { siteid: 88, slug: 'Tzfat', name_he: 'צפת', kind: 'local' },
  { siteid: 89, slug: 'Shfelat-hagalil', name_he: 'שפלת הגליל', kind: 'regional' },
  { siteid: 90, slug: 'Gilboa', name_he: 'גלבוע', kind: 'regional' },
  { siteid: 93, slug: 'bshemesh', name_he: 'בית שמש', kind: 'local' },
  { siteid: 94, slug: 'recheshacarmel', name_he: 'רכס הכרמל', kind: 'regional' },
  { siteid: 95, slug: 'Ashkelon', name_he: 'אשקלון', kind: 'local' },
  { siteid: 97, slug: 'rahat', name_he: 'רהט', kind: 'local' },
  { siteid: 98, slug: 'Givatayim', name_he: 'גבעתיים', kind: 'local' },
  { siteid: 100, slug: 'Yeruham', name_he: 'ירוחם', kind: 'local' },
  { siteid: 102, slug: 'omer', name_he: 'עומר', kind: 'local' },
  { siteid: 103, slug: 'GalilMiz', name_he: 'הגליל המזרחי', kind: 'regional' },
  { siteid: 104, slug: 'GaneyTickva', name_he: 'גני תקווה', kind: 'local' },
  { siteid: 105, slug: 'Beer-Sheva', name_he: 'באר שבע', kind: 'local' },
  { siteid: 106, slug: 'M_Adumim', name_he: 'מעלה אדומים', kind: 'local' },
  { siteid: 107, slug: 'kmalachi', name_he: 'קריית מלאכי', kind: 'local' },
  { siteid: 108, slug: 'Rishon', name_he: 'ראשון לציון', kind: 'local' },
  { siteid: 118, slug: 'RamatHasharon', name_he: 'רמת השרון', kind: 'local' },
  { siteid: 120, slug: 'Maalot', name_he: 'מעלות-תרשיחא', kind: 'local' },
];

/**
 * MEETING_TYPES ('v' parameter): every code the scraper found by directly
 * probing the engine, not a documented enum - a code missing here still works
 * as a filter value, it just has no Hebrew label to show.
 */
export const MEETING_TYPES = {
  0: 'הכל', 1: 'רשות רישוי', 2: 'מליאת הועדה המקומית', 3: 'הועדה המחוזית',
  4: 'מכינה למליאה', 5: 'ועדת הקצאות', 6: 'ועדת משנה', 7: 'ועדת השבחה',
  9: 'סדר יום לישיבת צוות היטל השבחה', 15: 'ועדת ערר',
};
