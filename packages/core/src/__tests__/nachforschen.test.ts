import { describe, it, expect, vi } from 'vitest';
import { pruefeSchritt, pruefeRezept, platzhalterAus, rezeptFuer, REFERENZ_REZEPTE, type Rezept } from '../nachforschen/rezepte.js';
import { belegblock, pruefeDeutung } from '../nachforschen/deutung.js';
import { Nachforscher, BUDGET } from '../nachforschen/lauf.js';

// v1372 — Nachforschen N1/N2 (beobachtend). Messlatte: Waschkammerl 11.10. (Licht 14,8 statt 9,8 h/Tag, Melder stumm seit 04.10.)
const LICHT = { id: 'b1', quelle: 'licht', gegenstand: 'licht:lange-an:light.waschkammerl', titel: 'Licht Waschkammerl (Waschkammerl): an 14,8 statt 9,8 h/Tag', entstanden: '2026-10-11T03:40:00Z' };

describe('Lese-Katalog und Rezepte', () => {
  it('nur Leseaktionen; Logbuch nur mit Entität und kurz; Schreibaktionen nie', () => {
    expect(pruefeSchritt('homeassistant', 'history_summary', { entityId: 'light.x', period: '3d' })).toBeNull();
    expect(pruefeSchritt('homeassistant', 'call_service', { domain: 'light' })).toMatch(/keine erlaubte Leseaktion/);
    expect(pruefeSchritt('homeassistant', 'trigger_automation', {})).toMatch(/keine erlaubte/);
    expect(pruefeSchritt('homeassistant', 'logbook', {})).toMatch(/nur mit entityId/);
    expect(pruefeSchritt('homeassistant', 'logbook', { entityId: 'light.x', period: '7d' })).toMatch(/höchstens 3 Tage/);
    expect(pruefeSchritt('shell', 'run', {})).toMatch(/nicht im Lese-Katalog/);
  });

  it('Platzhalter aus dem Befund; Referenzrezept passt und ist gültig', () => {
    expect(platzhalterAus(LICHT)).toEqual({ entity: 'light.waschkammerl', raum: 'Waschkammerl' });
    expect(platzhalterAus({ ...LICHT, quelle: 'sensorbatterien', gegenstand: 'sensorbatterie:sensor.temp_terrasse_battery:offline', titel: 'Temp Terrasse Batterie: 0 %' }).entity).toBe('sensor.temp_terrasse_battery');
    const r = rezeptFuer(LICHT)!;
    expect(r.id).toBe('licht-lange-an');
    expect(pruefeRezept(r, platzhalterAus(LICHT))).toEqual([]);
    for (const x of REFERENZ_REZEPTE) expect(x.schritte.every(s => s.werkzeug === 'homeassistant')).toBe(true);
  });

  it('ein Rezept mit Schreibschritt ist ungültig (auch künftig dynamisch erstellte)', () => {
    const boese: Rezept = { ...REFERENZ_REZEPTE[0]!, schritte: [{ werkzeug: 'homeassistant', aktion: 'call_service', params: { entityId: '{entity}' }, zweck: 'aus' }] };
    expect(pruefeRezept(boese, { entity: 'light.x' }).join()).toMatch(/keine erlaubte Leseaktion/);
  });
});

describe('Deutung — Gegenprobe', () => {
  const { zeilen } = belegblock([{ zweck: 'Melder', text: 'Melder Waschkammerl: letzte Bewegung 04.10. 18:12\nAutomation „Licht aus" zuletzt 23.09. 21:05' }]);
  it('Belege müssen auf eine Zeile zeigen und deren Zahl/Zeit tragen; Alfreds Schritte nur aus dem Rezept', () => {
    const antwort = JSON.stringify({
      lage: 'Licht bleibt an', hypothese: 'Melder meldet nicht mehr', sicherheit: 'hoch',
      belege: [{ text: 'letzte Bewegung am 04.10. um 18:12', zeile: 'B1' }, { text: 'Melder-Batterie 3 %', zeile: 'B9' }, { text: 'Automation lief am 30.09.', zeile: 'B2' }],
      owner_aufgaben: [{ titel: 'Waschkammerl betreten, Zigbee2MQTT prüfen' }], alfred_schritte: ['Lampe ausschalten', REFERENZ_REZEPTE[0]!.eigeneSchritte[0]],
    });
    const g = pruefeDeutung(antwort, REFERENZ_REZEPTE[0]!, zeilen)!;
    expect(g.u.belege).toEqual([{ text: 'letzte Bewegung am 04.10. um 18:12', zeile: 'B1' }]);
    expect(g.u.alfred_schritte).toEqual([REFERENZ_REZEPTE[0]!.eigeneSchritte[0]]);
    expect(g.gestrichen).toBe(3);
    expect(g.u.sicherheit).toBe('hoch');
  });
  it('ohne gültigen Beleg ist die Sicherheit niedrig; kein JSON → null', () => {
    const g = pruefeDeutung('{"hypothese":"x","sicherheit":"hoch","belege":[{"text":"frei erfunden","zeile":"B7"}]}', REFERENZ_REZEPTE[0]!, zeilen)!;
    expect(g.u.sicherheit).toBe('niedrig');
    expect(pruefeDeutung('Ich habe die Daten geprüft.', REFERENZ_REZEPTE[0]!, zeilen)).toBeNull();
  });
});

describe('Nachforscher', () => {
  const llm = { complete: vi.fn().mockResolvedValue({ content: '{"hypothese":"Melder stumm","sicherheit":"mittel","belege":[{"text":"letzte Bewegung 04.10. 18:12","zeile":"B1"}],"owner_aufgaben":[{"titel":"Waschkammerl betreten"}]}', usage: { inputTokens: 2000, outputTokens: 200 }, stopReason: 'end_turn' }) };
  const logger = { info: vi.fn(), warn: vi.fn() } as never;

  it('Lauf: liest nur die Rezeptschritte, deutet einmal, liefert Untersuchung', async () => {
    const lese = vi.fn().mockResolvedValue('Melder Waschkammerl: letzte Bewegung 04.10. 18:12');
    const n = new Nachforscher({ lese, llm, logger });
    const e = await n.untersuche(LICHT);
    expect(e.status).toBe('untersucht');
    expect(lese.mock.calls.map(c => `${c[0]}.${c[1]}`)).toEqual(['homeassistant.relations', 'homeassistant.history_summary', 'homeassistant.history_summary']);
    expect(lese.mock.calls[2]![2]).toMatchObject({ area: 'Waschkammerl', period: '3d' });
    expect(e.untersuchung?.owner_aufgaben[0]?.titel).toBe('Waschkammerl betreten');
    expect(llm.complete).toHaveBeenCalledTimes(1);
  });

  it('ohne Rezept kein Lauf; Tagesbudget greift', async () => {
    const lese = vi.fn().mockResolvedValue('x 1');
    const n = new Nachforscher({ lese, llm, logger, jetzt: () => Date.parse('2026-10-12T10:00:00Z') });
    expect((await n.untersuche({ ...LICHT, quelle: 'infra', gegenstand: 'unifi:ac-mesh' })).status).toBe('kein_rezept');
    for (let i = 0; i < BUDGET.laeufeJeTag; i++) await n.untersuche(LICHT);
    expect((await n.untersuche(LICHT)).status).toBe('budget');
  });
});

describe('v1373 — Lichter über Schalter', () => {
  it('Licht-Rezept passt auch auf Shelly-Schalter (Realfall: Abstellkammerl über switch.shellywalldisplay_…)', () => {
    expect(rezeptFuer({ ...LICHT, gegenstand: 'licht:lange-an:switch.shellywalldisplay_00082201697b_switch_0' })?.id).toBe('licht-lange-an');
  });
});
