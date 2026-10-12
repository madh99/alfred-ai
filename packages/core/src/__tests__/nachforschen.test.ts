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
    // jedes Referenzrezept besteht die Prüfung vor dem Lauf (v1376: auch Infra)
    for (const x of REFERENZ_REZEPTE) expect(pruefeRezept(x, { entity: 'light.x', raum: 'R', ort: 'Altlengbach' }), x.id).toEqual([]);
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

describe('v1376 — Infra-Rezepte', () => {
  it('UniFi „AC Mesh nicht verbunden" (Realfall 12.10.: erster Lauf „kein Rezept") und Proxmox-RAM haben jetzt ein Rezept', () => {
    expect(rezeptFuer({ ...LICHT, quelle: 'infra', gegenstand: 'unifi:device:ac-mesh', titel: 'unifi: Device "AC Mesh" is not connected' })?.id).toBe('unifi-geraet-getrennt');
    expect(rezeptFuer({ ...LICHT, quelle: 'infra', gegenstand: 'proxmox:git-server:ram', titel: 'proxmox: git-server RAM usage 95.2%' })?.id).toBe('proxmox-ressource');
  });
  it('UniFi- und Proxmox-Schaltaktionen sind nie erlaubt; Listen nur begrenzt', () => {
    expect(pruefeSchritt('unifi', 'restart_device', { mac: 'x' })).toMatch(/keine erlaubte/);
    expect(pruefeSchritt('unifi', 'block_client', {})).toMatch(/keine erlaubte/);
    expect(pruefeSchritt('proxmox', 'reboot_vm', {})).toMatch(/keine erlaubte/);
    expect(pruefeSchritt('unifi', 'list_events', {})).toMatch(/limit/);
    expect(pruefeSchritt('unifi', 'list_events', { limit: 30 })).toBeNull();
  });
});

describe('v1378 — abgeschnittene Deutung (Realfall 12.10. 14:46: 900 von 900 Ausgabe-Tokens)', () => {
  it('wird als „am Token-Limit abgeschnitten" gemeldet; das Limit liegt jetzt bei 2000', async () => {
    const llm = { complete: vi.fn().mockResolvedValue({ content: '{"lage":"AC Mesh getrennt","belege":[{"text":"…', usage: { inputTokens: 1561, outputTokens: 2000 }, stopReason: 'max_tokens' }) };
    const n = new Nachforscher({ lese: vi.fn().mockResolvedValue('AC Mesh: disconnected 1'), llm, logger: { info: vi.fn() } as never });
    const e = await n.untersuche({ ...LICHT, quelle: 'infra', gegenstand: 'unifi:device:ac-mesh', titel: 'unifi: Device "AC Mesh" is not connected' });
    expect(e).toMatchObject({ status: 'deutung_ungueltig', fehler: 'Antwort am Token-Limit abgeschnitten' });
    expect(llm.complete.mock.calls[0]![0].maxTokens).toBe(2000);
  });
});

describe('v1380 — PV-Rezept', () => {
  it('„PV unter der Baseline" hat ein Rezept mit Wetter am Wohnort und PV-Sensoren', () => {
    const pv = { ...LICHT, quelle: 'energie', gegenstand: 'pv:baseline', titel: 'PV: PV 736 W — deutlich unter der Baseline dieser Stunde' };
    const r = rezeptFuer(pv)!;
    expect(r.id).toBe('pv-unter-baseline');
    expect(pruefeRezept(r, { ...platzhalterAus(pv), ort: 'Altlengbach' })).toEqual([]);
    expect(pruefeRezept(r, platzhalterAus(pv)).join()).toMatch(/Platzhalter fehlt \(ort\)/);
  });
});
