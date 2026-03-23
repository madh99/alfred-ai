import type { SkillCategory, SkillMetadata } from '@alfred/types';

// Regex-based keyword map per category.
// 'core' is always active and not listed here.
const CATEGORY_KEYWORDS: Record<Exclude<SkillCategory, 'core'>, RegExp> = {
  productivity: /\b(todo|note|notiz|remind|erinner|calendar|kalender|termin|event|email|e-mail|mail|contact|kontakt|briefing|morgenbriefing|tagesbriefing|einkaufsliste|einkauf|shopping|liste|rezept|kochen|zutat|küche|meal|mahlzeit|frühstück|mittagessen|abendessen|wochenplan|diät|ernährung|nährwert|vegetarisch|vegan|reise|flug|hotel|urlaub|reiseplan|packliste|flugsuche|hotelsuche|mietwagen|buchung|barcelona|lissabon|airport|flughafen)\b/i,
  information:  /\b(search|such|weather|wetter|calculat|rechn|time|date|zeit|datum|uhrzeit|system.?info|transit|bahn|zug|bus|tram|u.?bahn|s.?bahn|abfahrt|verbindung|haltestelle|öffi|fahrplan|route|routing|fahrzeit\w*|anfahrt|heimfahrt|fahrt|navigation|navi|strom|energy|preis|price|kwh|awattar|marktpreis|spot|günstig|cheapest|netzentgelt|rss|feed|atom|news|nachricht|schlagzeil|headline|youtube|video|transkript|transcript|channel|kanal|zusammenfass|crypto|krypto|bitcoin|btc|ethereum|eth|coin|token|blockchain|solana|cardano|altcoin|market.?cap|bitpanda|portfolio|aktie|stock|etf|gold|silber|metall|depot|holding|trade|trading|exchange|binance|kraken|coinbase|order|limit.?order|kauf|verkauf)\b/i,
  media:        /\b(voice|stimme|tts|speak|sprech|sprich|screenshot|clipboard|zwischenablage|brows\w*|öffne|webseite|website|seite|url|bild|image|generier|photo|foto|spotify|musik|music|song|track|artist|album|playlist|wiedergabe|abspielen|pause|skip|lautstärke|volume|shuffle|repeat|sonos|speaker|lautsprecher|gruppier|raum|radio|tunein|sleep.?timer|nachtmodus|stereo)\b/i,
  automation:   /\b(background|hintergrund|shell|bash|cron|schedul|code.?agent|sandbox|automat|watch|alert|benachrichtig|bescheid|meld|überwach|monitor|script|skript|befehl|kommando|tägliche?r?s?|stündliche?r?s?|wöchentliche?r?s?|monatliche?r?s?|jeden\s+(tag|morgen|abend|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)|um\s+\d{1,2}\s*(uhr|:|h)|alle\s+\d+\s*(min|stund|sekund)|in\s+\d+\s*(minuten?|stunden?|sekunden?|hours?|minutes?|seconds?|min)|daily|hourly|weekly|every\s+(day|hour|morning|evening|night|\d+\s*min)|führ.{0,5}aus|execut|ausführ)\b/i,
  files:        /\b(file|datei|document|dokument|pdf|http|download|upload|herunterlad|hochlad|anhang|attachment)\b/i,
  infrastructure: /\b(proxmox|vm|container|docker|unifi|wifi|wlan|netzwerk|network|homeassistant|home.?assistant|smarthome|smart.?home|licht|light|schalter|switch|solar|photovoltaik|pv|wechselrichter|inverter|batterie.?speicher|wallbox|energieverbrauch|stromverbrauch|verbrauch.{0,5}kwh|einspeis|netzeinspeis|autarkie|eigenverbrauch|bmw|auto|fahrzeug|ladestand|reichweite|laden(?!e)|charging|vehicle|soc|ladehistorie|ladesession|ladevorgang|ladezyklus|ladekurve|km|kilometer|kilometerstand|mileage|tachostand|database|datenbank|sql|query|tabelle|table|schema|postgres|mysql|mariadb|mongodb|mongo|influx|redis|mssql|select|insert|verbindung.{0,5}db)\b/i,
  identity:     /\b(link|verknüpf|cross.?platform|identity|identität|user|benutzer|nutzer|rolle|role|invite|einlad|connect|verbinde?|whoami|wer\s+bin\s+ich|profil|registrier|onboard|deaktiv|aktivier|einrichte?n?|richte?\s+.*\s+ein|konfigur\w*|setup.?service|postfach|account|microsoft|outlook|o365|office.?365|auth.?microsoft|matrix|telegram|whatsapp|discord|signal|schick\w*\s+.*\s+(auf|per|via|über)|sende\w*\s+.*\s+(auf|per|via|über)|nachricht\s+an)/i,
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
