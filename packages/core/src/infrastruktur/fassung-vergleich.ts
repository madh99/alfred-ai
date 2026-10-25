/**
 * App 1.77.0 / v1657 — Owner 25.10. („man kann sich NICHT ansehen was man annimmt“): Zeilenvergleich zweier Architektur-Fassungen.
 * Geliefert werden nur geänderte Zeilen und als Orientierung die Überschrift ihres Abschnitts. Ohne I/O, ohne Modell.
 */
export interface UnterschiedZeile { art: 'neu' | 'weg' | 'abschnitt'; zeile: string }

/** Zeilenweiser Vergleich (längste gemeinsame Teilfolge); Leerzeilen zählen nicht als Änderung. */
export function zeilenUnterschied(alt: string, neu: string, maxZeilen = 4000): UnterschiedZeile[] {
  const a = alt.split('\n').slice(0, maxZeilen), b = neu.split('\n').slice(0, maxZeilen);
  const n = a.length, m = b.length;
  // LCS-Tabelle von hinten (Uint32 genügt für ≤ 4000 Zeilen)
  const l = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) l[i]![j] = a[i] === b[j] ? l[i + 1]![j + 1]! + 1 : Math.max(l[i + 1]![j]!, l[i]![j + 1]!);
  const roh: Array<{ art: 'gleich' | 'neu' | 'weg'; zeile: string }> = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { roh.push({ art: 'gleich', zeile: b[j]! }); i++; j++; }
    else if (l[i + 1]![j]! >= l[i]![j + 1]!) roh.push({ art: 'weg', zeile: a[i++]! });
    else roh.push({ art: 'neu', zeile: b[j++]! });
  }
  while (i < n) roh.push({ art: 'weg', zeile: a[i++]! });
  while (j < m) roh.push({ art: 'neu', zeile: b[j++]! });
  // Nur Änderungen, jeweils mit der zuletzt gesehenen Überschrift (einmal je Abschnitt)
  const aus: UnterschiedZeile[] = [];
  let ueberschrift = '', gezeigt = '';
  for (const z of roh) {
    if (/^#{1,6}\s/.test(z.zeile) && z.art !== 'weg') { ueberschrift = z.zeile; if (z.art === 'neu') gezeigt = z.zeile; } // geänderte Überschrift steht schon als Zeile da
    if (z.art === 'gleich' || !z.zeile.trim()) continue;
    if (ueberschrift && ueberschrift !== gezeigt && z.zeile !== ueberschrift) { aus.push({ art: 'abschnitt', zeile: ueberschrift }); gezeigt = ueberschrift; }
    aus.push({ art: z.art, zeile: z.zeile });
  }
  return aus;
}

/** Versionsnummer aus dem Dokumenttitel „Zielarchitektur … vN“. */
export function fassungAusTitel(titel: string): number | undefined {
  const m = /\bv(\d+)\s*$/.exec(titel);
  return m ? Number(m[1]) : undefined;
}

/** Vergleichsbasis: die zuletzt angenommene Fassung, sonst die vorige. */
export function vergleichsBasis(version: number, entscheidungen: Array<{ entscheidung: string; architekturVersion: number }>): { version: number; angenommen: boolean } | undefined {
  const an = [...entscheidungen].reverse().find(e => e.entscheidung === 'annehmen' && e.architekturVersion < version);
  if (an) return { version: an.architekturVersion, angenommen: true };
  return version > 1 ? { version: version - 1, angenommen: false } : undefined;
}
