import { locale, type Lang } from "./i18n";

// ISO 3166-1 alpha-2 codes
export const COUNTRY_CODES = (
  "AD AE AF AG AI AL AM AO AR AT AU AW AZ BA BB BD BE BF BG BH BI BJ BM BN BO BR BS BT BW BY BZ CA CD CF CG CH CI CL CM CN CO CR CU CV CY CZ " +
  "DE DJ DK DM DO DZ EC EE EG ER ES ET FI FJ FM FR GA GB GD GE GH GM GN GQ GR GT GW GY HK HN HR HT HU ID IE IL IN IQ IR IS IT JM JO JP " +
  "KE KG KH KI KM KN KP KR KW KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MG MH MK ML MM MN MO MR MT MU MV MW MX MY MZ NA NE NG NI NL " +
  "NO NP NR NZ OM PA PE PG PH PK PL PR PS PT PW PY QA RO RS RU RW SA SB SC SD SE SG SI SK SL SM SN SO SR SS ST SV SY SZ TD TG TH TJ TL TM " +
  "TN TO TR TT TV TW TZ UA UG US UY UZ VA VC VE VN VU WS XK YE ZA ZM ZW"
).split(" ");

export function flag(code?: string | null) {
  if (!code || code.length !== 2) return "🌍";
  return String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

const nameCache = new Map<Lang, Intl.DisplayNames | null>();
export function countryName(code: string, lang: Lang) {
  if (!nameCache.has(lang)) {
    try { nameCache.set(lang, new Intl.DisplayNames([locale(lang)], { type: "region" })); }
    catch { nameCache.set(lang, null); }
  }
  return nameCache.get(lang)?.of(code) ?? code;
}

const TZ_COUNTRY: Record<string, string> = {
  "Asia/Tashkent": "UZ", "Asia/Samarkand": "UZ", "Europe/Moscow": "RU", "Asia/Yekaterinburg": "RU", "Asia/Novosibirsk": "RU",
  "Asia/Shanghai": "CN", "Asia/Urumqi": "CN", "Asia/Hong_Kong": "HK", "Asia/Taipei": "TW", "Asia/Singapore": "SG",
  "Asia/Almaty": "KZ", "Asia/Bishkek": "KG", "Asia/Dushanbe": "TJ", "Europe/Kiev": "UA", "Europe/Kyiv": "UA", "Europe/Minsk": "BY",
  "Europe/London": "GB", "Europe/Berlin": "DE", "Europe/Paris": "FR", "Europe/Istanbul": "TR", "Asia/Tokyo": "JP", "Asia/Seoul": "KR",
  "Asia/Kolkata": "IN", "Asia/Jakarta": "ID", "Africa/Cairo": "EG", "Africa/Lagos": "NG", "America/Sao_Paulo": "BR",
  "America/Mexico_City": "MX", "America/New_York": "US", "America/Chicago": "US", "America/Denver": "US", "America/Los_Angeles": "US",
};

// Best guess from the browser; the player can change it on the join screen.
export function guessCountry(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (TZ_COUNTRY[tz]) return TZ_COUNTRY[tz];
  } catch { /* ignore */ }
  for (const l of navigator.languages ?? [navigator.language]) {
    const region = l.split("-")[1]?.toUpperCase();
    if (region && COUNTRY_CODES.includes(region)) return region;
  }
  return "US";
}

export function timeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}
