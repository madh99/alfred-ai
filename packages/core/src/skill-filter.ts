import type { SkillCategory, SkillMetadata } from '@alfred/types';

// Regex-based keyword map per category.
// 'core' is always active and not listed here.
const CATEGORY_KEYWORDS: Record<Exclude<SkillCategory, 'core'>, RegExp> = {
  productivity: /\b(todo|note|remind|calendar|termin|event|email|e-mail|mail|contact|kontakt)\b/i,
  information:  /\b(search|such|weather|wetter|calculat|rechn|time|date|zeit|datum|uhrzeit|system.?info)\b/i,
  media:        /\b(voice|stimme|tts|speak|sprech|sprich|screenshot|clipboard|zwischenablage|brows)\b/i,
  automation:   /\b(background|hintergrund|shell|bash|cron|schedul|code.?agent|sandbox|automat)\b/i,
  files:        /\b(file|datei|document|dokument|pdf|http|download|upload)\b/i,
  infrastructure: /\b(proxmox|vm|container|docker|unifi|wifi|wlan|homeassistant|home.?assistant|smarthome|smart.?home|licht|light|schalter|switch)\b/i,
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

  // Fallback: if nothing matched, include ALL available categories
  if (!anyMatch) {
    for (const cat of availableCategories) {
      selected.add(cat);
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
