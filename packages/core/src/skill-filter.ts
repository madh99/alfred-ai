import type { SkillCategory, SkillMetadata } from '@alfred/types';

// Regex-based keyword map per category.
// 'core' is always active and not listed here.
// NOTE: Use \w* suffix on keywords to match plurals and compound forms (Rezept→Rezepte, Hotel→Hotels, Flug→Flüge etc.)
// Without \w*, \b(rezept)\b does NOT match "Rezepte" — causing FALLBACK (all 43 skills, ~13K tokens).
const CATEGORY_KEYWORDS: Record<Exclude<SkillCategory, 'core'>, RegExp> = {
  productivity: /\b(todos?\w*|notes?\w*|notiz\w*|remind\w*|erinner\w*|calend\w*|kalender\w*|termin\w*|events?\w*|e?-?mail\w*|kontakt\w*|contact\w*|briefing\w*|einkauf\w*|shopping\w*|liste\w*|rezept\w*|koch\w*|zutat\w*|küche\w*|meals?\w*|mahlzeit\w*|frühstück\w*|mittag\w*|abendessen\w*|wochenplan\w*|diät\w*|ernähr\w*|nährwert\w*|vegetari\w*|vegan\w*|reis\w{2,}|flug\w*|flüge\w*|hotels?\w*|urlaub\w*|reiseplan\w*|packli\w*|mietwag\w*|buch\w{3,}|barcelona|lissabon|airport\w*|flughafen\w*)\b/i,
  information:  /\b(search\w*|such\w*|weather|wetter\w*|calculat\w*|rechn\w*|time|date|zeit\w*|datum|uhrzeit|system.?info|transit\w*|bahn\w*|zug\w*|bus\w*|tram|u.?bahn|s.?bahn|abfahrt\w*|verbindung\w*|haltestell\w*|öffi\w*|fahrplan\w*|rout\w*|fahrzeit\w*|anfahrt|heimfahrt|fahrt\w*|navig\w*|navi|strom\w*|energy|preis\w*|price\w*|kwh|awattar|marktpreis\w*|spot|günstig\w*|cheapest|netzentgelt\w*|rss|feed\w*|atom|news|nachricht\w*|schlagzeil\w*|headline\w*|youtube|video\w*|transkript\w*|transcript\w*|channel|kanal\w*|zusammenfass\w*|crypto\w*|krypto\w*|bitcoin|btc|ethereum|eth|coin\w*|token|blockchain|solana|cardano|altcoin\w*|market.?cap|bitpanda|portfolio\w*|aktie\w*|stock\w*|etf|gold|silber|metall\w*|depot|holding\w*|trad\w{2,}|exchange\w*|binance|kraken|coinbase|order\w*|limit.?order|kauf\w*|verkauf\w*|preisvergleich\w*|geizhals\w*|produkt\w*|notebook\w*|laptop\w*|smartphone\w*|handy\w*|fernseh\w*|grafikkart\w*|gpu\w*|cpu\w*|prozessor\w*|monitor\w*|ssd\w*|festplatt\w*|kopfhörer\w*|tablet\w*|smartwatch\w*|staubsaug\w*|waschmaschine\w*|kühlschrank\w*|kaffeemaschine\w*)\b/i,
  media:        /\b(voice|stimme\w*|tts|speak\w*|sprech\w*|sprich\w*|spiel\w*|screenshot\w*|clipboard|zwischenablage|brows\w*|öffne\w*|webseite\w*|website\w*|seite\w*|url|bild\w*|image\w*|generier\w*|photo\w*|foto\w*|spotify\w*|musik\w*|music\w*|songs?\w*|tracks?\w*|artists?\w*|albums?\w*|playlists?\w*|wiedergab\w*|abspiel\w*|pause\w*|skip\w*|lautstärke\w*|volume\w*|shuffle|repeat|sonos\w*|speaker\w*|lautsprech\w*|gruppier\w*|raum\w*|radio\w*|tunein|sleep.?timer|nachtmodus|stereo|halle|küche|wohnzimmer|schlafzimmer|bad)\b/i,
  automation:   /\b(background\w*|hintergrund\w*|shell\w*|bash|cron\w*|schedul\w*|code.?agent\w*|sandbox\w*|automat\w*|watch\w*|alert\w*|benachrichtig\w*|bescheid\w*|meld\w*|überwach\w*|monitor\w*|script\w*|skript\w*|befehl\w*|kommando\w*|tägliche?r?s?|stündliche?r?s?|wöchentliche?r?s?|monatliche?r?s?|jeden\s+(tag|morgen|abend|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)|um\s+\d{1,2}\s*(uhr|:|h)|alle\s+\d+\s*(min|stund|sekund)|in\s+\d+\s*(minuten?|stunden?|sekunden?|hours?|minutes?|seconds?|min)|daily|hourly|weekly|every\s+(day|hour|morning|evening|night|\d+\s*min)|führ\w*aus|execut\w*|ausführ\w*)\b/i,
  files:        /\b(files?\w*|datei\w*|dokument\w*|document\w*|pdfs?\w*|https?\w*|download\w*|upload\w*|herunterlad\w*|hochlad\w*|anhäng\w*|anhang\w*|attachment\w*|onedrive\w*|cloud.?speicher\w*|cloud.?drive\w*|sharepoint\w*|ablage\w*|verzeichnis\w*)\b/i,
  infrastructure: /\b(proxmox\w*|vms?\w*|container\w*|docker\w*|unifi\w*|wifi|wlan\w*|netzwerk\w*|network\w*|homeassistant|home.?assistant|smarthome|smart.?home|licht\w*|light\w*|schalter\w*|switch\w*|solar\w*|photovoltaik\w*|pv|wechselrichter\w*|inverter\w*|batterie.?speicher\w*|wallbox\w*|energieverbrauch\w*|stromverbrauch\w*|verbrauch\w{0,10}kwh|einspeis\w*|netzeinspeis\w*|autarkie\w*|eigenverbrauch\w*|bmw|auto\w*|fahrzeug\w*|ladestand\w*|reichweite\w*|laden(?!e)\w*|charging\w*|vehicle\w*|soc|ladehistori\w*|ladesession\w*|ladevorgang\w*|ladezyklus\w*|ladekurve\w*|km|kilometer\w*|mileage|tachostand\w*|charger\w*|ladest\w*|go.?e\w*|database\w*|datenbank\w*|sql\w*|query\w*|tabell\w*|table\w*|schema\w*|postgres\w*|mysql\w*|mariadb|mongodb|mongo\w*|influx\w*|redis|mssql|select\w*|insert\w*|verbindung\w{0,5}db|mqtt\w*|zigbee\w*|sensor\w*|temperatur\w*|luftfeucht\w*|tasmota\w*|shelly\w*|esphome\w*)\b/i,
  identity:     /\b(link\w*|verknüpf\w*|cross.?platform|identity\w*|identität\w*|user\w*|benutzer\w*|nutzer\w*|rolle\w*|role\w*|invite\w*|einlad\w*|connect\w*|verbinde?\w*|whoami|wer\s+bin\s+ich|profil\w*|registrier\w*|onboard\w*|deaktiv\w*|aktivier\w*|einrichte?\w*|richte?\s+.*\s+ein|konfigur\w*|setup.?service|postfach\w*|account\w*|microsoft|outlook|o365|office.?365|auth.?microsoft|matrix|telegram|whatsapp|discord|signal|schick\w*\s+.*\s+(auf|per|via|über)|sende\w*\s+.*\s+(auf|per|via|über)|nachricht\w*\s+an)/i,
  mcp:          /\bmcp\b/i,
};

/**
 * Determine which skill categories are relevant for a given message.
 * 'core' is always included. If no keywords match, ALL categories are returned
 * (safe fallback — never risks filtering out a relevant skill).
 */
export function selectCategories(
  message: string,
  availableCategories: Set<SkillCategory>,
): Set<SkillCategory> {
  const selected = new Set<SkillCategory>(['core']);

  let anyMatch = false;
  for (const [category, pattern] of Object.entries(CATEGORY_KEYWORDS) as [Exclude<SkillCategory, 'core'>, RegExp][]) {
    if (!availableCategories.has(category)) continue;
    if (pattern.test(message)) {
      selected.add(category);
      anyMatch = true;
    }
  }

  // When automation is selected, include ALL categories because watches/schedules
  // can reference any skill (e.g. "watch RSS feed" needs information + automation).
  if (selected.has('automation')) {
    for (const cat of availableCategories) selected.add(cat);
    return selected;
  }

  // files needs automation because code_sandbox (automation) generates files (PDF, DOCX, Excel)
  if (selected.has('files')) {
    selected.add('automation');
  }

  // Fallback: if nothing matched, include common categories instead of ALL.
  // Heavy categories (infrastructure, identity, mcp) only appear when keywords match,
  // saving ~1500-2000 tokens per request on generic messages.
  if (!anyMatch) {
    const commonCategories: SkillCategory[] = ['productivity', 'information', 'media', 'automation', 'files'];
    for (const cat of commonCategories) {
      if (availableCategories.has(cat)) selected.add(cat);
    }
  }

  return selected;
}

/**
 * Filter a list of SkillMetadata to only those whose category is in the given set.
 * Skills without a category default to 'core'.
 */
export function filterSkills(
  skills: SkillMetadata[],
  categories: Set<SkillCategory>,
): SkillMetadata[] {
  return skills.filter(s => categories.has(s.category ?? 'core'));
}
