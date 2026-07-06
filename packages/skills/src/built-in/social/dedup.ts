/**
 * v973 — Geteilte Story-Dedup-Primitives (Skill braucht sie fürs Publish-Gate,
 * das Content-Studio in core fürs Erzeugungs-Gate).
 */

/**
 * v957 — deterministischer Doppelungs-Check über Kanalgrenzen (Muster v924):
 * Tokens ≥4 Zeichen, Duplikat bei ≥3 gemeinsamen ODER ≥50% Überlappung (min 2).
 * Fängt wortgleiche/nah-wortgleiche Titel — Paraphrasen fängt erst die
 * semantische Schicht (StoryDeduper, core/story-dedup.ts).
 */
export function isNearDuplicateTitle(candidate: string, existingTitles: string[]): boolean {
  // v1022 — Buchstabenklasse ß-ö/ø-ÿ statt ä-ü: „ß" war Trennzeichen
  // („Fußball" zerfiel zu „fu"+„ball") und à-ã fehlten ganz
  const tokens = (s: string) => new Set(s.toLowerCase().split(/[^a-zß-öø-ÿ0-9]+/).filter(t => t.length >= 4));
  const cand = tokens(candidate);
  if (cand.size === 0) return false;
  for (const existing of existingTitles) {
    const ex = tokens(existing);
    if (ex.size === 0) continue;
    let common = 0;
    for (const t of cand) if (ex.has(t)) common++;
    const overlap = common / Math.min(cand.size, ex.size);
    // v958 — Schwelle 0.5: der echte Einzelkritik-Doppelfall hatte nur 2 gemeinsame
    // Tokens bei 50% Overlap. Bewusst leicht aggressiv — lieber eine Idee zu viel
    // verwerfen (Nachschub ist billig) als Doppelungen in der Familie.
    if (common >= 3 || (overlap >= 0.5 && common >= 2)) return true;
  }
  return false;
}

/**
 * v973 — Story-Identität für die semantische Dedup: Titel + Body-Anfang.
 * Die Identität einer Story steckt nicht in Titel-Tokens (Realfall: „Alaba
 * hält sich alle Optionen offen" vs. „Alaba lässt Zukunft offen — Comeback
 * möglich?" = 40% Token-Overlap, dieselbe Story).
 */
export function storyIdentity(story: { title?: string; body?: string }): string {
  const title = (story.title ?? '').trim();
  const lead = (story.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return [title, lead].filter(Boolean).join(' — ');
}

/** Cosine-Ähnlichkeit zweier Vektoren (0..1 bei normierten Embeddings). */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
