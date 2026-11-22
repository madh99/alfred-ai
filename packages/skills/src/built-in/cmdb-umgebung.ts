/**
 * Owner 22.11. (K2/K3) — Umgebung (CMDB `environment`) deterministisch bestimmen. Befund 22.11.: von 3 391 Assets hatten
 * nur 12 eine Umgebung, keine Quelle setzte sie. Die Gegenprüfung behandelt fehlende Einordnung als produktiv (K1); diese
 * Regeln füllen die Lücke, ohne dass ein Modell entscheidet.
 */
export type Umgebung = 'production' | 'staging' | 'development' | 'test' | 'lab';

/**
 * Umgebungen, die die feste Gegenprüfung (G1) ausnehmen. Sie setzt nur der Owner (Web-CMDB, Proxmox-Tag) — der Skill
 * (also ein Modell) darf nur production/staging setzen, sonst könnte es sich die Gegenprüfung selbst ersparen.
 */
export const NICHT_PRODUKTIV_UMGEBUNGEN = new Set<string>(['lab', 'test', 'development']);

const TAG_ZU_UMGEBUNG: Record<string, Umgebung> = {
  prod: 'production', production: 'production', produktiv: 'production',
  staging: 'staging', stage: 'staging',
  dev: 'development', development: 'development', entwicklung: 'development',
  test: 'test',
  lab: 'lab',
};

/**
 * K2 — Proxmox-Tags („prod;web“, „lab“) → Umgebung. Mehrere widersprüchliche Umgebungs-Tags → production (fail-closed);
 * kein Umgebungs-Tag → undefined (der Abgleich lässt den gepflegten Wert dann unverändert).
 */
export function umgebungAusTags(tags: unknown): Umgebung | undefined {
  if (typeof tags !== 'string' || !tags.trim()) return undefined;
  const gefunden = new Set<Umgebung>();
  for (const t of tags.toLowerCase().split(/[;,\s]+/)) { const u = TAG_ZU_UMGEBUNG[t]; if (u) gefunden.add(u); }
  if (gefunden.size === 0) return undefined;
  if (gefunden.size > 1) return 'production';
  return [...gefunden][0];
}

/**
 * K3 — Vorschlag aus dem Namen für die einmalige Einordnung durch den Owner (nie ohne Bestätigung gesetzt).
 * Nur eindeutige Namensteile; alles andere → production (fail-closed).
 */
export function umgebungsVorschlag(name: string): Umgebung {
  const n = name.toLowerCase();
  if (/(^|[-_.])lab([-_.\d]|$)|pki-?lab/.test(n)) return 'lab';
  if (/restoretest|(^|[-_.])probe[-_]|(^|[-_.])test([-_.\d]|$)|^test|test\d*$/.test(n)) return 'test';
  if (/(^|[-_.])dev([-_.\d]|$)|-dev$/.test(n)) return 'development';
  return 'production';
}
