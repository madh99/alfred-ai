import type { Vorgang, VorgangSchritt } from '@alfred/storage';

/**
 * Jarvis Schicht 3 — Ausführungsgedächtnis als Kontext.
 *
 * Was Alfred getan, vorgeschlagen oder zur Bestätigung gestellt hat, steht als
 * Abschnitt „Bereits getan" im Reasoning-Kontext. Das beendet die Wiederholungs-
 * vorschläge, die bisher nur über 48-h-Memories gebremst wurden. Rein, testbar.
 */

const ART_TEXT: Record<string, string> = {
  ausgefuehrt: 'ausgeführt', vorgeschlagen: 'vorgeschlagen', zur_bestaetigung: 'zur Bestätigung gestellt',
  bestaetigt: 'bestätigt', abgelehnt: 'abgelehnt', fehlgeschlagen: 'FEHLGESCHLAGEN', blockiert: 'blockiert (Autonomie: nie)',
  uebersprungen: 'übersprungen', notiz: 'Notiz',
};

const zeitKurz = (iso: string) => { const d = new Date(iso); return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}. ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

export function formatiereGedaechtnis(schritte: VorgangSchritt[], offene: Vorgang[], opts: { maxSchritte?: number; maxOffene?: number } = {}): string {
  const zeilen: string[] = [];
  const maxS = opts.maxSchritte ?? 15; const maxO = opts.maxOffene ?? 10;
  if (offene.length) {
    zeilen.push(`Offene Vorgänge (${offene.length}):`);
    for (const v of offene.slice(0, maxO)) {
      zeilen.push(`- [${v.besitzer === 'alfred' ? 'Alfred' : 'User'} · ${v.autonomie}] ${v.titel}${v.naechsterSchritt ? ` → nächster Schritt: ${v.naechsterSchritt}` : ''}${v.frist ? ` (Frist ${zeitKurz(v.frist)})` : ''}`);
    }
  }
  if (schritte.length) {
    zeilen.push(`Bereits getan (letzte 14 Tage, ${schritte.length} Schritte) — NICHT erneut vorschlagen:`);
    // gleiche Beschreibung nur einmal, jüngste zuerst
    const gesehen = new Set<string>();
    for (const s of schritte) {
      const k = `${s.skill ?? ''}|${s.beschreibung.toLowerCase().slice(0, 80)}`;
      if (gesehen.has(k)) continue;
      gesehen.add(k);
      zeilen.push(`- ${zeitKurz(s.zeit)} ${ART_TEXT[s.art] ?? s.art}: ${s.beschreibung}${s.skill ? ` [${s.skill}${s.aktion ? `/${s.aktion}` : ''}]` : ''}${s.art === 'fehlgeschlagen' && s.ergebnis ? ` — ${s.ergebnis.slice(0, 80)}` : ''}`);
      if (gesehen.size >= maxS) break;
    }
  }
  return zeilen.join('\n');
}
