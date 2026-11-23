/**
 * v1937 — Schleife 2 Digest-Modus (Owner 23.11. „ok“ nach Auswertung Block 26.10.): Kategorien mit Erledigungsquote < 25 %
 * (commvault 13 Vorschläge/12 verworfen, unifi 4/4) bekommen keine Einzel-Vorgänge und keine Einzel-Rückfragen mehr.
 * Ihre Vorschläge werden gesammelt und einmal täglich gebündelt gemeldet.
 */
export const DIGEST_KATEGORIEN: ReadonlySet<string> = new Set(['commvault', 'unifi']);

export interface DigestEintrag { skill: string; beschreibung: string; zeit: string }

export function trenneDigest<T extends { skillName: string }>(actions: T[]): { sofort: T[]; digest: T[] } {
  const sofort: T[] = []; const digest: T[] = [];
  for (const a of actions) (DIGEST_KATEGORIEN.has(a.skillName) ? digest : sofort).push(a);
  return { sofort, digest };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-zäöüß0-9]+/g, ' ').trim();

/** Ein Text je Tag: je Kategorie die Vorschläge, gleiche zusammengefasst mit Anzahl. Leer → '' (dann keine Meldung). */
export function digestText(eintraege: DigestEintrag[]): string {
  if (!eintraege.length) return '';
  const jeSkill = new Map<string, Map<string, { text: string; n: number }>>();
  for (const e of eintraege) {
    const m = jeSkill.get(e.skill) ?? new Map<string, { text: string; n: number }>();
    const k = norm(e.beschreibung);
    const x = m.get(k);
    if (x) x.n++; else m.set(k, { text: e.beschreibung.trim(), n: 1 });
    jeSkill.set(e.skill, m);
  }
  const zeilen = [`📰 Tages-Digest — ${eintraege.length} gesammelte Vorschläge (keine Einzel-Rückfragen):`];
  for (const [skill, m] of [...jeSkill].sort(([a], [b]) => a.localeCompare(b))) {
    zeilen.push(`\n**${skill}**`);
    for (const { text, n } of m.values()) zeilen.push(`- ${text}${n > 1 ? ` (${n}×)` : ''}`);
  }
  return zeilen.join('\n');
}
