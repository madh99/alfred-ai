import { describe, it, expect, vi, afterEach } from 'vitest';
import { phasenAus, werteAus, naechsteMitternacht, tagSchluessel, zeitText, ursachenAus, berichtText, auffaelligkeiten, type HaZustand, type EntitaetsBericht } from './ha-verlauf.js';
import { HomeAssistantSkill } from './home-assistant.js';
import type { SkillContext, HomeAssistantConfig } from '@alfred/types';

// v1357 — Verlaufsauswertung im Code statt Rechnen im Modell (Vergleichstest 11.10.)
const TZ = 'Europe/Vienna';
const t = (iso: string) => Date.parse(iso);
const z = (state: string, iso: string): HaZustand => ({ state, last_changed: iso });
const H = 3_600_000;

describe('phasenAus', () => {
  it('überbrückt kurze Aussetzer, längere bleiben „nicht verfügbar"', () => {
    const f = { von: t('2026-10-09T00:00:00Z'), bis: t('2026-10-09T10:00:00Z') };
    const r = phasenAus([
      z('on', '2026-10-08T20:00:00Z'),
      z('unavailable', '2026-10-09T01:00:00Z'), z('on', '2026-10-09T01:00:33Z'), // 33 s → Aussetzer
      z('off', '2026-10-09T04:00:00Z'),
      z('unavailable', '2026-10-09T06:00:00Z'), z('off', '2026-10-09T07:00:00Z'), // 1 h → Lücke
    ], f);
    expect(r.aussetzer).toBe(1);
    expect(r.phasen.map(p => [p.zustand, (p.bis - p.von) / H])).toEqual([['on', 4], ['off', 2], ['unavailable', 1], ['off', 3]]);
    expect(r.datenAb).toBe(f.von);
  });

  it('erkennt Datenbeginn nach Fensterbeginn (Aufbewahrung)', () => {
    const f = { von: t('2026-10-01T00:00:00Z'), bis: t('2026-10-11T00:00:00Z') };
    expect(phasenAus([z('off', '2026-10-02T00:00:00Z')], f).datenAb).toBe(t('2026-10-02T00:00:00Z'));
  });
});

describe('Ortszeit', () => {
  it('Mitternacht in Wien, auch über die Umstellung auf Winterzeit (25.10.2026)', () => {
    expect(new Date(naechsteMitternacht(t('2026-10-09T12:00:00Z'), TZ)).toISOString()).toBe('2026-10-09T22:00:00.000Z');
    expect(new Date(naechsteMitternacht(t('2026-10-25T12:00:00Z'), TZ)).toISOString()).toBe('2026-10-25T23:00:00.000Z');
    expect(tagSchluessel(t('2026-10-09T22:30:00Z'), TZ)).toBe('2026-10-10');
    expect(zeitText(t('2026-10-09T22:30:00Z'), TZ)).toBe('10.10. 00:30');
    expect(zeitText(t('2026-10-09T22:30:05Z'), TZ, true)).toBe('10.10.2026 00:30:05');
  });

  it('der 25.10. hat 25 Stunden an', () => {
    const f = { von: t('2026-10-24T22:00:00Z'), bis: t('2026-10-26T23:00:00Z') };
    const a = werteAus([z('on', '2026-10-24T22:00:00Z'), z('off', '2026-10-25T23:00:00Z')], f, TZ);
    expect(a.werte.art).toBe('zustand');
    if (a.werte.art !== 'zustand') return;
    expect(a.werte.tage).toEqual([{ tag: '2026-10-25', an: 25 * H }, { tag: '2026-10-26', an: 0 }]);
  });
});

describe('werteAus', () => {
  it('Schalter: Dauer, Einschaltungen, längste Phase, je Tag', () => {
    const f = { von: t('2026-10-08T22:00:00Z'), bis: t('2026-10-10T22:00:00Z') }; // 09.10. + 10.10. Ortszeit
    const a = werteAus([
      z('off', '2026-10-08T10:00:00Z'),
      z('on', '2026-10-09T04:00:00Z'), z('off', '2026-10-09T06:00:00Z'),
      z('on', '2026-10-09T20:00:00Z'), z('off', '2026-10-10T16:00:00Z'), // 20 h über Mitternacht
    ], f, TZ);
    if (a.werte.art !== 'zustand') throw new Error('art');
    expect(a.werte.dauer.on).toBe(22 * H);
    expect(a.werte.wechsel.on).toBe(2);
    expect((a.werte.laengste.on.bis - a.werte.laengste.on.von) / H).toBe(20);
    expect(a.werte.tage).toEqual([{ tag: '2026-10-09', an: 4 * H }, { tag: '2026-10-10', an: 18 * H }]);
    expect(a.werte.einschaltZeiten).toEqual([t('2026-10-09T04:00:00Z'), t('2026-10-09T20:00:00Z')]);
  });

  it('Messwert: Statistik zeitgewichtet, „unverändert seit" über Aussetzer hinweg', () => {
    const f = { von: t('2026-10-01T00:00:00Z'), bis: t('2026-10-11T00:00:00Z') };
    const a = werteAus([
      z('24.76', '2026-09-30T12:00:00Z'),
      z('unavailable', '2026-10-05T00:00:00Z'), z('24.76', '2026-10-05T02:00:00Z'),
    ], f, TZ);
    if (a.werte.art !== 'messwert') throw new Error('art');
    expect(a.werte.min).toBe(24.76);
    expect(a.werte.unveraendertSeit).toBe(t('2026-09-30T12:00:00Z'));
    expect(a.unverfuegbar).toBe(2 * H);
    const b: EntitaetsBericht = { entityId: 'sensor.kueche', aktuell: a };
    expect(auffaelligkeiten(b, f.bis).join()).toContain('unverändert');
  });
});

describe('ursachenAus', () => {
  it('ordnet Einschaltungen Automation, Person oder „ohne Kontext" zu', () => {
    const e = [t('2026-10-10T22:31:53Z'), t('2026-10-10T23:00:00Z'), t('2026-10-11T01:00:00Z')];
    const u = ursachenAus(e, [
      { state: 'on', when: '2026-10-10T22:31:53.985+00:00', context_event_type: 'automation_triggered', context_name: 'LichtEingang', context_source: 'state of binary_sensor.melder', context_entity_id: 'automation.lichteingang' },
      { state: 'on', when: '2026-10-10T23:00:01+00:00', context_user_id: 'abc' },
    ]);
    expect(u.map(x => [x.anzahl, x.text])).toEqual([
      [1, 'Automation „LichtEingang" (state of binary_sensor.melder)'],
      [1, 'Person (App/Oberfläche)'],
      [1, 'ohne Kontext (Taster/Gerät selbst)'],
    ]);
    expect(u[0].automation).toBe('automation.lichteingang');
  });
});

describe('berichtText', () => {
  it('viele Entitäten → Übersicht, Ruhige gezählt, bleibt unter der Pipeline-Kürzung', () => {
    const f = { von: t('2026-10-08T22:00:00Z'), bis: t('2026-10-11T22:00:00Z') };
    const v = { von: t('2026-10-01T22:00:00Z'), bis: f.von };
    const berichte: EntitaetsBericht[] = [];
    for (let i = 0; i < 200; i++) {
      const reihe = i < 30 ? [z('off', '2026-10-01T00:00:00Z'), z('on', '2026-10-09T10:00:00Z'), z('off', `2026-10-09T${String(11 + (i % 10)).padStart(2, '0')}:00:00Z`)] : [z(i % 2 ? 'off' : 'unavailable', '2026-09-01T00:00:00Z')];
      berichte.push({ entityId: `switch.s${i}`, jetzt: { state: i % 2 ? 'off' : 'unavailable' }, aktuell: werteAus(reihe, f, TZ), vergleich: werteAus(reihe, v, TZ) });
    }
    const text = berichtText(berichte, { tz: TZ, jetzt: f.bis, aktuell: f, vergleich: v });
    expect(text.length).toBeLessThan(11_000);
    expect(text).toContain('170 ohne jede Änderung');
    expect(text).toContain('Details der Auffälligsten');
    expect(text).not.toContain('`switch.s30`'); // dauerhaft weg/ruhig → nur gezählt
  });
});

describe('HomeAssistantSkill history_summary', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('liest Raum, Verlauf ohne Attribute und Logbuch — und berechnet den Vergleich', async () => {
    const jetzt = Date.now();
    const iso = (h: number) => new Date(jetzt - h * H).toISOString();
    const aufrufe: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      aufrufe.push(url);
      const antwort = (body: unknown) => ({ ok: true, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
      if (url.endsWith('/api/states')) return antwort([
        { entity_id: 'switch.licht_wk', state: 'off', last_changed: iso(1), attributes: { friendly_name: 'LichtWaschkammerl' } },
        { entity_id: 'binary_sensor.melder_wk', state: 'off', last_changed: iso(300), attributes: { friendly_name: 'Melder WK', device_class: 'occupancy' } },
        { entity_id: 'button.licht_wk_neustart', state: iso(2), last_changed: iso(2), attributes: {} },
        { entity_id: 'automation.licht_wk', state: 'on', last_changed: iso(500), attributes: { friendly_name: 'Licht WK', last_triggered: iso(30) } },
      ]);
      if (url.includes('/api/template')) return antwort('switch.licht_wk,binary_sensor.melder_wk,button.licht_wk_neustart');
      if (url.includes('/api/history/period/')) return antwort([
        [{ entity_id: 'switch.licht_wk', state: 'off', last_changed: iso(300) }, { state: 'on', last_changed: iso(70) }, { state: 'off', last_changed: iso(50) }, { state: 'on', last_changed: iso(30) }, { state: 'off', last_changed: iso(1) }],
        [{ entity_id: 'binary_sensor.melder_wk', state: 'off', last_changed: iso(300) }],
      ]);
      if (url.includes('/api/logbook/')) return antwort([
        { entity_id: 'switch.licht_wk', state: 'on', when: iso(30), context_event_type: 'automation_triggered', context_name: 'Licht WK', context_entity_id: 'automation.licht_wk' },
      ]);
      throw new Error(`unerwartet ${url}`);
    }));
    const skill = new HomeAssistantSkill({ baseUrl: 'http://ha', accessToken: 'x' } as HomeAssistantConfig);
    const r = await skill.execute({ action: 'history_summary', area: 'Waschkammerl', period: '3d', compareWith: '7d' }, {} as SkillContext);
    expect(r.success).toBe(true);
    const h = aufrufe.find(u => u.includes('/api/history/period/'))!;
    expect(h).toContain('minimal_response');
    expect(h).toContain('no_attributes');
    expect(aufrufe.find(u => u.includes('/api/logbook/'))).toContain('end_time=');
    expect(r.display).toContain('LichtWaschkammerl');
    expect(r.display).toContain('Einschaltungen 2 (Vergleich 0)');
    expect(r.display).toContain('Automation „Licht WK"');
    expect(r.display).toContain('Automation Licht WK: aktiv, zuletzt ausgelöst');
    expect(r.display).toContain('ohne Kontext');
    expect(r.display).toContain('nie ausgelöst (stumm)');
    expect(h).not.toContain('button.'); // Taster haben keinen Zustandsverlauf
  });

  it('viele kurze Aussetzer → „Verbindung instabil"', () => {
    const f = { von: t('2026-10-09T00:00:00Z'), bis: t('2026-10-11T00:00:00Z') };
    const reihe: HaZustand[] = [z('off', '2026-10-08T00:00:00Z')];
    for (let i = 0; i < 12; i++) {
      const a = f.von + i * 4 * H;
      reihe.push(z('unavailable', new Date(a).toISOString()), z('off', new Date(a + 30_000).toISOString()));
    }
    const b: EntitaetsBericht = { entityId: 'switch.x', aktuell: werteAus(reihe, f, TZ) };
    expect(b.aktuell.aussetzer).toBe(12);
    expect(auffaelligkeiten(b, f.bis).join()).toContain('Verbindung instabil (6 kurze Aussetzer/Tag)');
  });

  it('ohne Auswahl → klare Fehlermeldung', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [] })));
    const skill = new HomeAssistantSkill({ baseUrl: 'http://ha', accessToken: 'x' } as HomeAssistantConfig);
    const r = await skill.execute({ action: 'history_summary', period: '3d' }, {} as SkillContext);
    expect(r.success).toBe(false);
    expect(r.error).toContain('needs entities');
  });
});
