import type { DokuArtKey, Dokument } from './modell.js';

interface KapitelDef {
  id: string;
  titel: string;
  pflicht: boolean;
  frei?: { feld: string; max: number };
}

export const DOKU_ARTEN: Record<DokuArtKey, { version: 1; titel: string; kapitel: KapitelDef[] }> = {
  abnahme: {
    version: 1,
    titel: 'Change-Abnahmeprotokoll',
    kapitel: [
      { id: 'kopf', titel: 'Change und Freigabe', pflicht: true },
      { id: 'zweck', titel: 'Zweck', pflicht: false, frei: { feld: 'zweck', max: 600 } },
      { id: 'schritte', titel: 'Schritte und Ergebnis', pflicht: true },
      { id: 'verlauf', titel: 'Halte, Wiederholungen, Planänderungen', pflicht: true },
      { id: 'abweichungen', titel: 'Abweichungen und offene Punkte', pflicht: false, frei: { feld: 'abweichungen', max: 600 } },
      { id: 'beweise', titel: 'Abnahme und Beweise', pflicht: true },
    ],
  },
  testprotokoll: {
    version: 1,
    titel: 'Lab-/Testprotokoll',
    kapitel: [
      { id: 'zweck', titel: 'Zweck', pflicht: false, frei: { feld: 'zweck', max: 600 } },
      { id: 'umgebung', titel: 'Testumgebung und Isolation', pflicht: true },
      { id: 'faelle', titel: 'Testfälle', pflicht: true },
      { id: 'befunde', titel: 'Befunde für die Produktion', pflicht: false, frei: { feld: 'befunde_produktion', max: 1200 } },
      { id: 'abbau', titel: 'Abbau-Nachweis', pflicht: true },
      { id: 'beweise', titel: 'Beweis-Anhang', pflicht: true },
    ],
  },
  betrieb: {
    version: 1,
    titel: 'Betriebsdokument',
    kapitel: [
      { id: 'zweck', titel: 'Zweck und Geltungsbereich', pflicht: false, frei: { feld: 'zweck', max: 600 } },
      { id: 'architektur', titel: 'Architekturüberblick', pflicht: true },
      { id: 'komponenten', titel: 'Komponenten', pflicht: true },
      { id: 'netz', titel: 'Netz und Firewall', pflicht: true },
      { id: 'identitaeten', titel: 'Identitäten und Geheimnisse', pflicht: true },
      { id: 'abhaengigkeiten', titel: 'Abhängigkeiten', pflicht: true },
      { id: 'wiederaufbau', titel: 'Wiederaufbau', pflicht: true },
      { id: 'sicherung', titel: 'Sicherung und Wiederherstellung', pflicht: true },
      { id: 'ueberwachung', titel: 'Überwachung', pflicht: true },
      { id: 'betrieb', titel: 'Betrieb und Wartung', pflicht: true },
      { id: 'historie', titel: 'Änderungshistorie', pflicht: true },
      { id: 'beweise', titel: 'Abnahme und Beweise', pflicht: true },
      { id: 'abweichungen', titel: 'Abweichungen und offene Punkte', pflicht: false, frei: { feld: 'abweichungen', max: 600 } },
    ],
  },
};

/** Prüft ein Dokument gegen seine Dokumentart. Leere Liste = gültig. */
export function pruefeDokument(d: Dokument): string[] {
  const meldungen: string[] = [];
  const art = DOKU_ARTEN[d.kopf.art];
  if (!art) return [`Unbekannte Dokumentart: ${String(d.kopf.art)}`];

  const bekannt = new Map(art.kapitel.map((k, i) => [k.id, i]));
  const vorhanden = new Set(d.kapitel.map((k) => k.id));

  for (const def of art.kapitel) {
    if (def.pflicht && !vorhanden.has(def.id)) {
      meldungen.push(`Pflichtkapitel fehlt: ${def.id} (${def.titel})`);
    }
  }

  let letzte = -1;
  for (const k of d.kapitel) {
    const pos = bekannt.get(k.id);
    if (pos === undefined) {
      meldungen.push(`Unbekanntes Kapitel: ${k.id}`);
      continue;
    }
    if (pos < letzte) {
      meldungen.push(`Kapitel in falscher Reihenfolge: ${k.id}`);
    }
    letzte = Math.max(letzte, pos);

    const def = art.kapitel[pos]!;
    if (def.pflicht && k.bloecke.length === 0) {
      meldungen.push(`Pflichtkapitel ohne Inhalt: ${k.id}`);
    }
    for (const b of k.bloecke) {
      if (b.art === 'frei' && def.frei && b.text !== undefined && b.text.length > def.frei.max) {
        meldungen.push(
          `Freies Feld ${b.feld} im Kapitel ${k.id} zu lang: ${b.text.length} Zeichen, höchstens ${def.frei.max} erlaubt`,
        );
      }
    }
  }
  return meldungen;
}
