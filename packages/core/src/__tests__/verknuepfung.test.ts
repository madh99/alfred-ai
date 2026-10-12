import { describe, it, expect } from 'vitest';
import { ankerAusGeraeten, ankerAusWissen, vorbereiten, verknuepfe, auswahl } from '../interessen/verknuepfung.js';

// v1367 — echte Daten 12.10.: Hersteller/Modelle aus Home Assistant, Wissensgraph, Beiträge der Woche
const ha = [
  { hersteller: 'Home Assistant', modell: 'Home Assistant Backup' }, { hersteller: 'thomasloven', modell: 'plugin' }, { hersteller: 'hacs.xyz' },
  { hersteller: 'Apple', modell: 'iPhone18,2' }, { hersteller: 'samsung', modell: 'SM-S928B' }, { hersteller: 'victron', modell: '100' },
  { hersteller: 'go-e GmbH [Austria]', modell: 'go-eCharger V5 [22 kW]' }, { hersteller: 'Shelly', modell: 'Shelly Pro 3EM' },
  { hersteller: 'Philips', modell: 'Hue motion sensor' }, { hersteller: 'LG', modell: 'OLED55B7V-Z' }, { hersteller: 'Ubiquiti Networks', modell: 'U7PRO' },
  { hersteller: 'Super Micro Computer, Inc.' }, { hersteller: 'Proxmox Server Solutions GmbH' }, { hersteller: 'IEEE Registration Authority' },
  { hersteller: 'Espressif Inc.' }, { hersteller: 'Sonos', modell: 'Play:5' }, { hersteller: 'Aqara', modell: 'Motion sensor' },
];
const kg = [
  { name: 'BMW', typ: 'vehicle' }, { name: 'Axians ICT Austria GmbH', typ: 'organization' }, { name: 'KSV 1980 Kapfenberg', typ: 'organization' },
  { name: 'Altlengbach', typ: 'location' }, { name: 'Österreich', typ: 'location' }, { name: 'Niederösterreich', typ: 'location' },
  { name: 'BTC', typ: 'item' }, { name: 'Archivierung', typ: 'item' }, { name: 'Wallbox', typ: 'item' },
];

describe('Anker', () => {
  it('Geräte: Hersteller ohne Rechtsform; große Marken nur mit Produktlinie; Integrationen, Handys und Netz-Kennungen nicht', () => {
    const w = ankerAusGeraeten(ha).map(a => a.wort).sort();
    expect(w).toEqual(['Aqara', 'LG OLED', 'Philips Hue', 'Proxmox', 'Shelly', 'Sonos', 'Super Micro', 'Ubiquiti', 'go-e', 'victron']);
  });

  it('Wissen: Organisationen, Fahrzeug, konkrete Orte, Kürzel — keine Länder, keine Allerweltswörter', () => {
    const w = ankerAusWissen(kg).map(a => `${a.art}:${a.wort}`).sort();
    expect(w).toEqual(['fahrzeug:BMW', 'kürzel:BTC', 'organisation:Axians ICT Austria', 'organisation:KSV 1980 Kapfenberg', 'ort:Altlengbach']);
  });
});

describe('verknuepfe / auswahl', () => {
  const anker = vorbereiten([...ankerAusGeraeten(ha), ...ankerAusWissen(kg)]);
  const b = (titel: string, zusammenfassung = '') => ({ titel, zusammenfassung, thema: 't' });

  it('Funde der Kalibrierung: im Titel stark', () => {
    expect(verknuepfe(b('Script: Shelly Plug Plus S über stündliche Strompreise steuern'), anker)).toMatchObject({ stark: true, anker: [{ wort: 'Shelly' }] });
    expect(verknuepfe(b('Was der neue Ultraschnellladepark Altlengbach für dich bietet'), anker)?.anker[0]?.wort).toBe('Altlengbach');
    expect(verknuepfe(b('BMW – Diese Modelle können bidirektional laden (V2G, V2H)'), anker)?.anker[0]?.art).toBe('fahrzeug');
    expect(verknuepfe(b('Philips Hue Prime-Angebote: GU10-Spots 38 % günstiger'), anker)?.anker[0]?.wort).toBe('Philips Hue');
  });

  it('nur in der Zusammenfassung schwach; ohne Anker nichts; Kürzel nur großgeschrieben', () => {
    expect(verknuepfe(b('U.S. added just 29,000 jobs in September', 'Markets moved, BTC slipped 2 %.'), anker)).toMatchObject({ stark: false });
    expect(verknuepfe(b('Neue Wärmepumpen-Förderung ab Jänner'), anker)).toBeNull();
    expect(verknuepfe(b('The btc-style naming of the new protocol'), anker)).toBeNull();
    expect(verknuepfe(b('Ein Hue-Farbton'), anker)).toBeNull(); // „Hue" allein ist kein Anker
  });

  it('starke zuerst, je Anker höchstens 3 am Tag, gleicher Titel aus zwei Themen einmal', () => {
    const heute = new Map<string, number>();
    const t = [
      ...Array.from({ length: 5 }, (_, i) => verknuepfe(b(`BTC fällt ${i}`), anker)!),
      verknuepfe(b('Shelly Pro 3EM Update'), anker)!, verknuepfe(b('Shelly Pro 3EM Update'), anker)!,
    ];
    const g = auswahl(t, heute);
    expect(g.filter(x => x.anker[0]!.wort === 'BTC')).toHaveLength(3);
    expect(g.filter(x => x.anker[0]!.wort === 'Shelly')).toHaveLength(1);
    expect(auswahl([verknuepfe(b('BTC steigt'), anker)!], heute)).toHaveLength(0); // Tagesgrenze erreicht
  });
});
