// Shared constants for both POLICE_CITIES and POLICE_NEIGHBORHOODS above -
// generated together by tools/police_build.py so they can never drift apart.
export const STATISTIC_GROUPS = ["עבירות סדר ציבורי", "עבירות כלפי הרכוש", "עבירות נגד גוף", "עבירות מרמה", "עבירות כלפי המוסר", "עבירות בטחון", "עבירות מין", "עבירות כלכליות", "עבירות תנועה", "עבירות רשוי", "עבירות נגד אדם", "סעיפי הגדרה", "שגיאת הזנה", "עבירות מנהליות", "שאר עבירות"];
export const YEARS = ["2021", "2022", "2023", "2024", "2025"];
export const YEAR_QUARTERS = {"2021": 4, "2022": 4, "2023": 4, "2024": 4, "2025": 4};
export const NATIONAL_UNRESOLVED = {"cases": 162114, "pct": 13.3};
// Offense-family buckets for the compare page's breakdown charts (a product
// decision, not derived from the source) - BUCKET_IDS is the fixed display order,
// BUCKET_LABELS the Hebrew heading per bucket, BUCKET_GROUPS which STATISTIC_GROUPS
// (by name) feed each bucket's own sub-bars. EXCLUDED_GROUPS lists the 3 groups in
// neither a bucket nor these charts at all (still present in `categories` above).
export const BUCKET_IDS = ["regulatory", "violent", "nonviolent", "security"];
export const BUCKET_LABELS = {"regulatory": "עבירות שגרתיות (תנועה, רישוי, מנהליות)", "violent": "עבירות אלימות", "nonviolent": "עבירות לא-אלימות (רכוש, מרמה, מוסר, כלכליות, סדר ציבורי)", "security": "עבירות בטחון"};
export const BUCKET_GROUPS = {"regulatory": ["עבירות תנועה", "עבירות רשוי", "עבירות מנהליות"], "violent": ["עבירות נגד גוף", "עבירות מין", "עבירות נגד אדם"], "nonviolent": ["עבירות כלפי הרכוש", "עבירות מרמה", "עבירות כלפי המוסר", "עבירות כלכליות", "עבירות סדר ציבורי"], "security": ["עבירות בטחון"]};
export const EXCLUDED_GROUPS = ["סעיפי הגדרה", "שאר עבירות", "שגיאת הזנה"];
