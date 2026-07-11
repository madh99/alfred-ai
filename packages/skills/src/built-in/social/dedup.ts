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
/**
 * v1090 — Floskel-/Funktionswörter zählen NICHT als Identitäts-Signal:
 * Realfall 11.07.: „Spanien zittert sich ins Halbfinale" wurde als Duplikat
 * von „Argentinien zittert sich weiter" geblockt — {zittert, sich} = 2
 * gemeinsame Tokens bei 50% Überlappung reichten der v958-Regel. Die Liste
 * ist bewusst auf Funktionswörter/Adverbien beschränkt (Substantive/Namen
 * bleiben Signal); Tokens <4 Zeichen filtert ohnehin die Längenregel.
 */
const TITLE_STOPWORDS = new Set([
  'sich', 'wird', 'werden', 'wurde', 'wurden', 'lässt', 'lassen', 'kann', 'können', 'muss', 'müssen', 'soll', 'sollen', 'will', 'wollen',
  'nach', 'beim', 'gegen', 'ohne', 'über', 'unter', 'durch', 'zwischen', 'wegen',
  'dass', 'mehr', 'alle', 'alles', 'allem', 'auch', 'noch', 'jetzt', 'dann', 'weiter', 'wieder', 'schon', 'erst', 'ganz',
  'heute', 'morgen', 'gestern', 'diese', 'dieser', 'dieses', 'diesem', 'sein', 'seine', 'seinem', 'seiner', 'ihre', 'ihrer', 'ihrem',
  'eine', 'einen', 'einem', 'einer', 'eines', 'beide', 'beiden', 'nicht', 'kein', 'keine', 'sind', 'bleibt', 'bleiben',
]);

export function isNearDuplicateTitle(candidate: string, existingTitles: string[]): boolean {
  // v1022 — Buchstabenklasse ß-ö/ø-ÿ statt ä-ü: „ß" war Trennzeichen
  // („Fußball" zerfiel zu „fu"+„ball") und à-ã fehlten ganz
  const norm = (s: string) => s.toLowerCase().split(/[^a-zß-öø-ÿ0-9]+/).filter(Boolean).join(' ');
  const tokensAll = (s: string) => new Set(s.toLowerCase().split(/[^a-zß-öø-ÿ0-9]+/).filter(t => t.length >= 4));
  const tokensContent = (all: Set<string>) => new Set([...all].filter(t => !TITLE_STOPWORDS.has(t)));
  const candNorm = norm(candidate);
  const candAll = tokensAll(candidate);
  const candContent = tokensContent(candAll);
  if (candAll.size === 0) return false;
  for (const existing of existingTitles) {
    // Wörtlich identischer Titel ist IMMER ein Duplikat (auch Zwei-Wort-Titel
    // wie „Alaba bleibt", deren Inhalts-Tokens nach dem Stopwort-Filter
    // unter die 2er-Schwelle fielen)
    if (candNorm && norm(existing) === candNorm) return true;
    const exAll = tokensAll(existing);
    if (exAll.size === 0) continue;
    // v958-Starkregel bleibt auf ALLEN Tokens: ≥3 gemeinsame = Duplikat
    let commonAll = 0;
    for (const t of candAll) if (exAll.has(t)) commonAll++;
    if (commonAll >= 3) return true;
    // v1090 — die 50%-Regel zählt nur noch INHALTS-Tokens: Floskeln wie
    // „zittert sich"/„weiter" machten Spanien- und Argentinien-Titel zu
    // „Duplikaten" (Realfall 11.07., legitimer Post permanent geblockt)
    const exContent = tokensContent(exAll);
    if (candContent.size === 0 || exContent.size === 0) continue;
    let common = 0;
    for (const t of candContent) if (exContent.has(t)) common++;
    const overlap = common / Math.min(candContent.size, exContent.size);
    if (overlap >= 0.5 && common >= 2) return true;
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
