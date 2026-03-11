import type { SkillCategory, SkillMetadata } from '@alfred/types';

// Regex-based keyword map per category.
// 'core' is always active and not listed here.
const CATEGORY_KEYWORDS: Record<Exclude<SkillCategory, 'core'>, RegExp> = {
  productivity: /\b(todo|note|notiz|remind|erinner|calendar|kalender|termin|event|email|e-mail|mail|contact|kontakt|briefing|morgenbriefing|tagesbriefing)\b/i,
  information:  /\b(search|such|weather|wetter|calculat|rechn|time|date|zeit|datum|uhrzeit|system.?info|transit|bahn|zug|bus|tram|u.?bahn|s.?bahn|abfahrt|verbindung|haltestelle|öffi|fahrplan|strom|energy|preis|price|kwh|awattar|marktpreis|spot|günstig|cheapest|netzentgelt)\b/i,
  media:        /\b(voice|stimme|tts|speak|sprech|sprich|screenshot|clipboard|zwischenablage|brows|bild|image|generier|photo|foto)\b/i,
  automation:   /\b(background|hintergrund|shell|bash|cron|schedul|code.?agent|sandbox|automat|watch|alert|benachrichtig|bescheid|meld|überwach|monitor|script|skript|befehl|kommando|tägliche?r?s?|stündliche?r?s?|wöchentliche?r?s?|monatliche?r?s?|jeden\s+(tag|morgen|abend|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)|um\s+\d{1,2}\s*(uhr|:|h)|alle\s+\d+\s*(min|stund|sekund)|in\s+\d+\s*(minuten?|stunden?|sekunden?|hours?|minutes?|seconds?|min)|daily|hourly|weekly|every\s+(day|hour|morning|evening|night|\d+\s*min)|führ.{0,5}aus|execut|ausführ)\b/i,
  files:        /\b(file|datei|document|dokument|pdf|http|download|upload|herunterlad|hochlad|anhang|attachment)\b/i,
  infrastructure: /\b(proxmox|vm|container|docker|unifi|wifi|wlan|netzwerk|network|homeassistant|home.?assistant|smarthome|smart.?home|licht|light|schalter|switch|solar|photovoltaik|pv|wechselrichter|inverter|batterie.?speicher|wallbox|energieverbrauch|stromverbrauch|verbrauch.{0,5}kwh|einspeis|netzeinspeis|autarkie|eigenverbrauch|bmw|auto|fahrzeug|ladestand|reichweite|laden(?!e)|charging|vehicle|soc|ladehistorie|ladesession|ladevorgang|ladezyklus|ladekurve|km|kilometer|kilometerstand|mileage|tachostand)\b/i,
  identity:     /\b(link|verknüpf|cross.?platform|identity|identität)\b/i,
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
