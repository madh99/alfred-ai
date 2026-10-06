/**
 * v1216 — Interne Memories sind Buchhaltung, kein Wissen über den Owner.
 *
 * Dedup-Marker (insight_delivered:*), Aktions-Feedback, KG-Verbindungen, Nutzungszähler und
 * Skill-Regeln werden als Memories gespeichert, gehören aber nicht in den Chat-Prompt.
 * Realfall 06.10.: 394 Marker „insight_delivered:…" (Kopien zugestellter Meldungen seit April)
 * liefen als „Behavior Feedback" in den Prompt — das Modell machte aus „E-Mail-Fehlerrate"
 * von gestern und „Smart-Home Skill deaktiviert" vom Mai eine Gegenwart („E-Mail-Skill ist
 * deaktiviert"). Die Liste stammt aus dem Knowledge-Graph (v1141) und gilt jetzt überall.
 */
export const INTERNAL_MEMORY_KEY_PREFIXES = /^(kg_connection_|kg_|insight_|pattern_|temporal_|action_feedback_|connection_|llm_usage_|service_usage_|rule_skill_|open_item_|_alfred_internal_)/i;

export function istInterneMemory(key: string | undefined | null): boolean {
  return !!key && INTERNAL_MEMORY_KEY_PREFIXES.test(key);
}
