import { describe, it, expect } from 'vitest';
import { formatiereLage, LAGE_MAX_ZEICHEN } from '../interaktion/lage.js';

// v1220 — Jarvis Schicht 3, Teil 3: Lage als Delta aus Befunden und Vorgängen.
const now = new Date('2026-10-06T14:10:00');
const iso = (h: string, d = '2026-10-06') => new Date(`${d}T${h}:00`).toISOString();

describe('formatiereLage', () => {
  it('nennt Befunde mit Kategorie, Dauer und Zähler, Vorgänge je Kategorie, älteste und das 24-h-Delta', () => {
    const t = formatiereLage({
      befundeOffen: [
        { quelle: 'infra', gegenstand: 'unifi:device:ac-mesh', titel: 'unifi: Device „AC Mesh" is not connected', entstanden: iso('14:00'), gesehenAnzahl: 1 },
        { quelle: 'sensorbatterien', gegenstand: 'sensorbatterie:x:offline', titel: 'Temp Terrasse Batterie: nicht erreichbar', entstanden: iso('13:22'), gesehenAnzahl: 2 },
      ],
      befundeErledigt24h: [{ quelle: 'infra', gegenstand: 'proxmox:git-server:ram', titel: 'proxmox: git-server RAM usage 95.1%', entstanden: iso('12:00', '2026-10-05'), erledigtAm: iso('14:00'), gesehenAnzahl: 9 }],
      vorgaengeOffen: [
        { titel: 'Strompreis aktuell günstig', kategorie: 'energie', status: 'offen', erstellt: iso('12:01', '2026-10-05'), aktualisiert: iso('12:01', '2026-10-05'), frist: iso('12:01', '2026-10-12') },
        { titel: 'Erinnerung Sensor-Batterie', kategorie: 'reminder', status: 'wartet', erstellt: iso('15:30', '2026-10-05'), aktualisiert: iso('13:00') },
        { titel: 'AC Mesh prüfen', kategorie: 'infra', status: 'offen', erstellt: iso('14:00'), aktualisiert: iso('14:00') },
      ],
      vorgaengeAbgeschlossen24h: [
        { titel: 'x', status: 'erledigt', erstellt: iso('10:00'), aktualisiert: iso('11:00') },
        { titel: 'y', status: 'verworfen', erstellt: iso('10:00'), aktualisiert: iso('11:17') },
        { titel: 'z', status: 'verworfen', erstellt: iso('10:00'), aktualisiert: iso('11:17') },
      ],
    }, now);
    expect(t).toContain('### Lage (Befunde und Vorgänge, Stand 14:10)');
    expect(t).toContain('Offene Befunde (2): [haus] Temp Terrasse Batterie: nicht erreichbar — seit 13:22, 2× gesehen · [infra] unifi: Device „AC Mesh" is not connected — seit 14:00, 1× gesehen');
    expect(t).toContain('Seit 24 h von selbst erledigt (1): [infra] proxmox: git-server RAM usage 95.1%');
    expect(t).toContain('Offene Vorgänge: 3 (energie 1, reminder 1, infra 1), davon 1 warten auf dich; älteste: „Strompreis aktuell günstig" (seit 05.10., Frist 12.10.)');
    expect(t).toContain('Letzte 24 h: 2 neue Vorgänge, 1 erledigt, 2 verworfen.');
    expect(t).toContain('nichts erfinden');
    expect(t.length).toBeLessThanOrEqual(LAGE_MAX_ZEICHEN);
  });
  it('leer: sagt ausdrücklich, dass nichts auffällig und nichts offen ist', () => {
    const t = formatiereLage({ befundeOffen: [], befundeErledigt24h: [], vorgaengeOffen: [], vorgaengeAbgeschlossen24h: [] }, now);
    expect(t).toContain('Offene Befunde: keine');
    expect(t).toContain('Offene Vorgänge: keine.');
  });
  it('v1359 — Haus-Check erscheint als eine Zeile und verdrängt keine anderen Befunde', () => {
    const hc = Array.from({ length: 40 }, (_, i) => ({ quelle: 'haus-check', gegenstand: `B1:g${i}`, titel: `Gerät ${i} nicht verfügbar`, entstanden: iso('08:00', '2026-10-01'), gesehenAnzahl: 3 }));
    const t = formatiereLage({
      befundeOffen: [...hc, { quelle: 'bmw', gegenstand: 'fahrzeug-unverriegelt', titel: 'Fahrzeug unverriegelt', entstanden: iso('14:00'), gesehenAnzahl: 1 }],
      befundeErledigt24h: [{ quelle: 'haus-check', gegenstand: 'B3:x', titel: 'x', entstanden: iso('08:00', '2026-10-01'), erledigtAm: iso('12:00'), gesehenAnzahl: 2 }],
      vorgaengeOffen: [], vorgaengeAbgeschlossen24h: [],
    }, now);
    expect(t).toContain('Offene Befunde (1): [bmw] Fahrzeug unverriegelt');
    expect(t).toContain('Haus-Check: 40 offene Punkte (40 neu in 7 Tagen, 1 seit 24 h erledigt)');
    expect(t).not.toContain('Gerät 0 nicht verfügbar');
    expect(t).not.toContain('Seit 24 h von selbst erledigt');
    const nurHc = formatiereLage({ befundeOffen: hc.slice(0, 2), befundeErledigt24h: [], vorgaengeOffen: [], vorgaengeAbgeschlossen24h: [] }, now);
    expect(nurHc).toContain('Offene Befunde (ohne Haus-Check): keine.');
  });
  it('viele Befunde werden gekappt („… und N weitere"), Gesamtlänge bleibt begrenzt', () => {
    const viele = Array.from({ length: 12 }, (_, i) => ({ quelle: 'infra', gegenstand: `k${i}`, titel: `Befund Nummer ${i} mit etwas längerem Titel`, entstanden: iso('10:00'), gesehenAnzahl: i + 1 }));
    const t = formatiereLage({ befundeOffen: viele, befundeErledigt24h: [], vorgaengeOffen: [], vorgaengeAbgeschlossen24h: [] }, now);
    expect(t).toContain('… und 6 weitere');
    expect(t.length).toBeLessThanOrEqual(LAGE_MAX_ZEICHEN + 1);
  });
});
