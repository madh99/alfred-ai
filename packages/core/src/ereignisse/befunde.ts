/**
 * v1217 — Jarvis Schicht 3: Befunde aus Deutungen des Weltmodells ableiten.
 *
 * Jede Normalzustands-Deutung liefert `auffaellig` (Objekt-Schlüssel wie
 * `sensorbatterie:sensor.temp_terrasse_battery:offline`) und `zeilen` (gedeutete Zeilen,
 * auffällige mit ⚠️). Daraus entsteht je Schlüssel ein Befund: Gegenstand = Schlüssel,
 * Titel = die passende ⚠️-Zeile, sonst ein generischer Titel. Rein, deterministisch.
 */
export interface BefundKandidat { gegenstand: string; titel: string; detail?: string }

const QUELLE_ZU_KATEGORIE: Record<string, string> = {
  bmw: 'bmw', energie: 'energie', sensorbatterien: 'haus', haus: 'haus', mikrotik: 'infra', infra: 'infra',
};

export function quelleZuKategorie(quelle: string): string {
  return QUELLE_ZU_KATEGORIE[quelle] ?? quelle;
}

/** Markdown-Fett, ⚠️ und Pfeile aus einer Deutungszeile entfernen. */
export function bereinigeZeile(z: string): string {
  return z.replace(/\*\*/g, '').replace(/^[\s⚠️🚨↳-]+/u, '').replace(/\s+/g, ' ').trim();
}

/** Wörter (≥ 3 Zeichen) aus einem Objekt-Schlüssel, zum Wiederfinden in den Zeilen. */
function schluesselWoerter(gegenstand: string): string[] {
  return gegenstand.toLowerCase().split(/[:._\-\s/]+/).filter(w => w.length >= 3 && !/^(sensor|binary|switch|light|offline|neu|down|niedrig|baseline|battery|batterie)$/.test(w));
}

export function befundeAusDeutung(quelle: string, deutung: { zeilen: string[]; auffaellig: string[] } | undefined): BefundKandidat[] {
  if (!deutung) return [];
  const warnZeilen = deutung.zeilen.filter(z => /⚠️|🚨|ALARM/u.test(z));
  const out: BefundKandidat[] = [];
  const gesehen = new Set<string>();
  for (const key of deutung.auffaellig) {
    if (!key || gesehen.has(key)) continue;
    gesehen.add(key);
    const woerter = schluesselWoerter(key);
    let zeile = warnZeilen.find(z => woerter.some(w => z.toLowerCase().includes(w)));
    if (!zeile && warnZeilen.length === 1) zeile = warnZeilen[0];
    const titel = zeile ? bereinigeZeile(zeile).slice(0, 200) : `${quelle}: ${key}`;
    out.push({ gegenstand: key, titel, detail: deutung.zeilen.map(bereinigeZeile).filter(Boolean).join('\n').slice(0, 2000) });
  }
  return out;
}
