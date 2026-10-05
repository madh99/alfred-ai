import { describe, it, expect } from 'vitest';
import { Kennzahlen, berechneQuoten, formatiereKennzahlen, summiereKennzahlMesswerte, formatiereErledigungJeKategorie, SCHRITT_ZU_KENNZAHL, KENNZAHL_NAMEN } from '../kennzahlen/kennzahlen.js';

// v1186 — Erledigungsquote je Kategorie, Kandidaten nur markiert (beobachtend)
describe('formatiereErledigungJeKategorie', () => {
  it('markiert Kategorien unter 25 % Erledigung erst ab 4 abgeschlossenen Vorgängen', () => {
    const z = formatiereErledigungJeKategorie([
      { kategorie: 'energy', angelegt: 6, erledigt: 0, verworfen: 5, offen: 1 },
      { kategorie: 'vehicle', angelegt: 3, erledigt: 0, verworfen: 2, offen: 1 },
      { kategorie: 'itsm', angelegt: 4, erledigt: 3, verworfen: 1, offen: 0 },
      { kategorie: 'general', angelegt: 2, erledigt: 0, verworfen: 0, offen: 2 },
    ], 28);
    expect(z[0]).toContain('28 Tage');
    expect(z[1]).toBe('- energy: 0/5/1 · Quote 0 % → Kandidat Digest-Modus');
    expect(z[2]).toBe('- vehicle: 0/2/1 · Quote 0 %');
    expect(z[3]).toBe('- itsm: 3/1/0 · Quote 75 %');
    expect(z[4]).toBe('- general: 0/0/2');
    expect(formatiereErledigungJeKategorie([], 28)).toEqual([]);
  });
});

// Jarvis Schicht 4 — Messen & Lernen, Teil 1.
describe('Kennzahlen (Zähler)', () => {
  it('zählt, liefert vollständige Snapshots und setzt zurück', () => {
    const k = new Kennzahlen();
    k.zaehle('vollpaesse');
    k.zaehle('insightsGesendet', 3);
    k.zaehle('insightsGesendet', 0);
    k.zaehle(undefined);
    const s = k.snapshot();
    expect(s.werte.vollpaesse).toBe(1);
    expect(s.werte.insightsGesendet).toBe(3);
    expect(s.werte.rundgaenge).toBe(0);
    expect(Object.keys(s.werte).sort()).toEqual([...KENNZAHL_NAMEN].sort());
    k.reset(new Date('2026-10-06T21:50:00Z'));
    expect(k.wert('insightsGesendet')).toBe(0);
    expect(k.snapshot().seit).toBe('2026-10-06T21:50:00.000Z');
  });
  it('Schritt-Ausgänge sind den Aktions-Kennzahlen zugeordnet, Vorschläge nicht', () => {
    expect(SCHRITT_ZU_KENNZAHL.ausgefuehrt).toBe('aktionenAusgefuehrt');
    expect(SCHRITT_ZU_KENNZAHL.blockiert).toBe('aktionenBlockiert');
    expect(SCHRITT_ZU_KENNZAHL.vorgeschlagen).toBeUndefined();
    expect(SCHRITT_ZU_KENNZAHL.notiz).toBeUndefined();
  });
});

describe('berechneQuoten', () => {
  it('Präzision = reagiert / (reagiert + verworfen + abgelaufen)', () => {
    const q = berechneQuoten({ insightsReagiert: 2, insightsVerworfen: 1, insightsAbgelaufen: 5, vorgaengeAngelegt: 4, vorgaengeErledigt: 1, kostenUsd: 6 });
    expect(q.praezision).toBeCloseTo(0.25);
    expect(q.erledigungsquote).toBeCloseTo(0.25);
    expect(q.kostenJeVorgangUsd).toBeCloseTo(1.5);
  });
  it('ohne Grundgesamtheit keine Quote statt Division durch null', () => {
    const q = berechneQuoten({ insightsReagiert: 0, insightsVerworfen: 0, insightsAbgelaufen: 0, vorgaengeAngelegt: 0, vorgaengeErledigt: 0, kostenUsd: 3 });
    expect(q).toEqual({});
  });
  it('Erledigungsquote ist bei Altbestand-Erledigungen auf 100 % begrenzt', () => {
    expect(berechneQuoten({ insightsReagiert: 0, insightsVerworfen: 0, insightsAbgelaufen: 0, vorgaengeAngelegt: 2, vorgaengeErledigt: 5, kostenUsd: 0 }).erledigungsquote).toBe(1);
  });
});

describe('summiereKennzahlMesswerte / formatiereKennzahlen', () => {
  it('summiert Tages-Messwerte je Kennzahl und ignoriert fremde Entitäten', () => {
    const s = summiereKennzahlMesswerte([
      { entity: 'kennzahl.vollpaesse', wert: 10 }, { entity: 'kennzahl.vollpaesse', wert: 12 },
      { entity: 'kennzahl.miniPaesse', wert: 3 }, { entity: 'kennzahl.unbekannt', wert: 99 }, { entity: 'sensor.x', wert: 1 },
    ]);
    expect(s).toEqual({ vollpaesse: 22, miniPaesse: 3 });
  });
  it('liefert fünf lesbare Zeilen mit Anteil der Mini-Pässe und Platzhaltern', () => {
    const zeilen = formatiereKennzahlen({ vollpaesse: 30, rundgaenge: 10, miniPaesse: 10, insightsGesendet: 12, gateTreffer: 4 }, { praezision: 0.5 }, 7);
    expect(zeilen).toHaveLength(5);
    expect(zeilen[0]).toContain('30 Vollpässe');
    expect(zeilen[0]).toContain('Anteil 20 %');
    expect(zeilen[1]).toContain('Präzision 50 %');
    expect(zeilen[4]).toContain('Erledigungsquote –');
    expect(zeilen[4]).toContain('Kosten je Vorgang –');
    expect(zeilen[0]).not.toContain('Ø Mini-Pass');
  });
  it('v1192 — Ø Mini-Pass-Dauer und Kosten je Vollpass, wenn Daten vorliegen', () => {
    const zeilen = formatiereKennzahlen({ vollpaesse: 40, miniPaesse: 4, miniPassDauerMs: 18_000 }, {}, 7, 2.0);
    expect(zeilen[0]).toContain('Ø Mini-Pass 4.5 s');
    expect(zeilen[0]).toContain('Kosten je Vollpass $0.050');
  });
});
