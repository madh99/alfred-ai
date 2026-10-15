/**
 * v1424 — Anhänge des Owners für Claude-Code-Aufträge auf Geräten (Realfall 13.10. 12:56: Frage mit zwei Screenshots im
 * Projektfaden → „ich kann die Screenshots nicht lesen“; die Dateien lagen nur im Dateispeicher des Servers).
 * Reine Regeln ohne Modell: welche Dateispeicher-Schlüssel gehören zum Auftrag, und wie erfährt Claude Code davon.
 */

/** Dateispeicher-Schlüssel `<Owner-UUID>/<Datei mit Endung>`, wie sie die Upload-Zeile der Nachricht nennt. */
const SCHLUESSEL = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[^\s"'„“”‚‘,;()<>[\]]+?\.[A-Za-z0-9]{1,8})(?=$|[\s"'„“”‚‘,;()<>[\]]|\.(?:\s|$))/g;

/**
 * v1467 — Upload-Zeile der App „… Schlüssel: <Schlüssel>.“ bis zum Zeilenende: Dateinamen enthalten Leerzeichen
 * (Realfall 15.10.: `…_Screenshot 2026-10-15 202133.png` — das Muster oben bricht am Leerzeichen ab und fand nichts).
 * Ebenso der Verlaufsvermerk „(Bild: <Schlüssel>)“ eingehender Bilder.
 */
const ZEILE = /(?:Schlüssel:|\(Bild:)[ \t]*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[^\n]+?\.[A-Za-z0-9]{1,8})(?:\.|\))?[ \t]*$/gm;

export const ANHANG_MAX_DATEIEN = 6;

/**
 * Schlüssel aus dem ausdrücklichen Parameter und aus dem Auftragstext (das Modell übernimmt die Upload-Zeile oft wörtlich).
 * Nur Dateien des Owners (Präfix = Owner-ID), ohne Pfad-Ausbruch, ohne Dubletten, höchstens ANHANG_MAX_DATEIEN.
 */
export function anhangSchluessel(text: string, owner: string, explizit?: unknown): string[] {
  const roh: string[] = [];
  if (Array.isArray(explizit)) roh.push(...explizit.map(x => String(x)));
  else if (typeof explizit === 'string' && explizit.trim()) roh.push(...explizit.split(/[\s,]+/));
  const zeilen = [...text.matchAll(ZEILE)].map(m => m[1]!);
  roh.push(...zeilen);
  for (const m of text.matchAll(SCHLUESSEL)) if (!zeilen.some(z => z !== m[1] && z.startsWith(m[1]!))) roh.push(m[1]!); // kein abgeschnittenes Stück eines Zeilen-Schlüssels
  const aus: string[] = [];
  for (const r of roh) {
    const k = r.trim();
    if (!owner || !k.startsWith(`${owner}/`) || k.includes('..') || k.includes('\\')) continue;
    if (!aus.includes(k)) aus.push(k);
  }
  return aus.slice(0, ANHANG_MAX_DATEIEN);
}

/** Zusatz zum Auftrag: wo die Dateien im Projektordner liegen (relativ), damit Claude Code sie mit Read ansieht. */
export function anhangHinweis(pfade: string[]): string {
  if (!pfade.length) return '';
  return `\n\nDer Owner hat Dateien beigelegt (im Projektordner, mit dem Read-Werkzeug ansehen — Bilder werden dir angezeigt; nicht committen, nicht verändern): ${pfade.join(', ')}`;
}

/** Dateiname ohne den Zeitstempel-Präfix des Dateispeichers (`2026-10-13T10-56-59-097Z_bild.png` → `bild.png`). */
export function anhangName(schluessel: string): string {
  const basis = schluessel.split('/').pop() ?? 'anhang';
  return basis.replace(/^\d{4}-\d{2}-\d{2}T[\d-]+Z_/, '') || 'anhang';
}
