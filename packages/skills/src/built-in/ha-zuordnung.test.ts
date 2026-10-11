import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bezuegeAus, baueZuordnung, zuordnungsAenderungen, zuordnungsZeilen, type EntitaetInfo, type AutoQuelle } from './ha-zuordnung.js';
import { HomeAssistantSkill } from './home-assistant.js';
import type { SkillContext, HomeAssistantConfig } from '@alfred/types';

// v1358 — Realfall 11.10.: Lichtschalter heißen technisch (shelly…), die Zuordnung steht in den Automationen.
// Beide Formate wie live gelesen: Entitäts-Verweise (neueres YAML/Claude) und Geräte-Trigger aus dem Editor.
const WK_AUS = {
  id: 'claude_licht_waschkammerl_aus', alias: 'Licht Waschkammerl AUS (60 s Nachlauf)', description: 'Licht aus, wenn 60 s keine Bewegung (switch.irrelevant im Text zählt nicht)',
  trigger: [{ platform: 'state', entity_id: ['binary_sensor.wk_occupancy'], to: 'off', for: { seconds: 60 } }],
  condition: [{ condition: 'state', entity_id: 'input_boolean.lichtautomatic', state: 'on' }, { condition: 'template', value_template: "{{ is_state('switch.lichtwaschkammerl', 'on') }}" }],
  action: [{ action: 'switch.turn_off', target: { entity_id: 'switch.lichtwaschkammerl' }, data: {} }],
};
const EINGANG_EIN = {
  id: '1722780891873', alias: 'LichtEingangsbereichBEWein',
  triggers: [{ type: 'motion', device_id: 'b6b1c9dbe792865544a9e48e1adfc7be', entity_id: '4ae6ff73c4c060203af64d54bd231657', domain: 'binary_sensor', trigger: 'device' }],
  conditions: [{ condition: 'and', conditions: [{ condition: 'sun', after: 'sunset', before: 'sunrise' }] }, { condition: 'state', entity_id: 'input_boolean.lichtautomatic', state: 'on' }],
  actions: [{ type: 'turn_on', device_id: 'b51c0708fc489009e2b30d906b2e2869', entity_id: 'b2b8e0641696cbd421ec6a3504e32801', domain: 'switch' }],
};
const geraete = new Map([
  ['b6b1c9dbe792865544a9e48e1adfc7be', ['sensor.eg_battery', 'binary_sensor.eg_occupancy', 'sensor.eg_power_outage_count']],
  ['b51c0708fc489009e2b30d906b2e2869', ['binary_sensor.sh_overheating', 'button.sh_reboot', 'sensor.sh_power', 'switch.shelly1pmminig3_54320440b000_switch_0', 'event.licht_eingangsbereich']],
]);
const info = (fehlt: string[] = []) => new Map<string, EntitaetInfo>(
  ['binary_sensor.wk_occupancy', 'input_boolean.lichtautomatic', 'switch.lichtwaschkammerl', 'sensor.eg_battery', 'binary_sensor.eg_occupancy', 'sensor.eg_power_outage_count',
    'binary_sensor.sh_overheating', 'button.sh_reboot', 'sensor.sh_power', 'switch.shelly1pmminig3_54320440b000_switch_0', 'event.licht_eingangsbereich', 'automation.wk_aus', 'automation.eingang_ein']
    .filter(e => !fehlt.includes(e))
    .map(e => [e, { state: 'off', deviceClass: e.endsWith('_occupancy') ? 'occupancy' : undefined }]),
);
const quellen = (wk: object = WK_AUS, aktiv = true): AutoQuelle[] => [
  { entityId: 'automation.wk_aus', name: 'Licht Waschkammerl AUS', aktiv, konfig: wk as unknown as Record<string, unknown> },
  { entityId: 'automation.eingang_ein', name: 'LichtEingangsbereichBEWein', aktiv: true, konfig: EINGANG_EIN as unknown as Record<string, unknown> },
];

describe('bezuegeAus', () => {
  it('Entitäten aus entity_id, Zielen und Templates — keine Dienstnamen, keine Beschreibung, keine Registry-IDs', () => {
    const domains = new Set(['binary_sensor', 'switch', 'input_boolean']);
    expect(bezuegeAus(WK_AUS.action, domains)).toEqual([{ entity: 'switch.lichtwaschkammerl' }]);
    expect(bezuegeAus(WK_AUS.condition, domains).map(b => b.entity)).toEqual(['input_boolean.lichtautomatic', 'switch.lichtwaschkammerl']);
    expect(bezuegeAus(WK_AUS, domains).some(b => b.entity === 'switch.irrelevant' || b.entity === 'switch.turn_off')).toBe(false);
    expect(bezuegeAus(EINGANG_EIN.triggers, domains)).toEqual([{ geraet: 'b6b1c9dbe792865544a9e48e1adfc7be', domain: 'binary_sensor', typ: 'motion' }]);
  });
});

describe('baueZuordnung', () => {
  it('löst Geräte-Trigger auf den Melder und Geräte-Aktionen auf den Schalter auf', () => {
    const z = baueZuordnung(quellen(), geraete, info());
    const ein = z.automationen.find(a => a.entityId === 'automation.eingang_ein')!;
    expect(ein.ausloeser).toEqual(['binary_sensor.eg_occupancy']);
    expect(ein.ziele).toEqual(['switch.shelly1pmminig3_54320440b000_switch_0']);
    expect(ein.fehlend).toEqual([]);
    const zeilen = zuordnungsZeilen(z, 'switch.shelly1pmminig3_54320440b000_switch_0', e => e);
    expect(zeilen).toEqual(['geschaltet von Automation „LichtEingangsbereichBEWein" (Auslöser: binary_sensor.eg_occupancy)']);
    expect(zuordnungsZeilen(z, 'binary_sensor.wk_occupancy', e => e)[0]).toContain('löst Automation „Licht Waschkammerl AUS" aus → switch.lichtwaschkammerl');
  });

  it('Sensortausch: alte Entität fehlt → Verweis gemeldet, Änderung im Vergleich sichtbar', () => {
    const alt = baueZuordnung(quellen(), geraete, info());
    const neuWk = { ...WK_AUS, trigger: [{ platform: 'state', entity_id: ['binary_sensor.wk_neu_occupancy'], to: 'off' }] };
    const neu1 = baueZuordnung(quellen(WK_AUS), geraete, info(['binary_sensor.wk_occupancy']));
    expect(neu1.automationen.find(a => a.entityId === 'automation.wk_aus')!.fehlend).toEqual(['binary_sensor.wk_occupancy']);
    expect(zuordnungsZeilen(neu1, 'switch.lichtwaschkammerl', e => e)[0]).toContain('VERWEIST AUF FEHLENDE binary_sensor.wk_occupancy');
    expect(zuordnungsAenderungen(alt, neu1)).toEqual(['Automation „Licht Waschkammerl AUS": verweist jetzt auf fehlende binary_sensor.wk_occupancy']);
    const neu2 = baueZuordnung(quellen(neuWk, false), geraete, info());
    expect(zuordnungsAenderungen(alt, neu2)).toEqual(['Automation „Licht Waschkammerl AUS": deaktiviert; Auslöser − binary_sensor.wk_occupancy + binary_sensor.wk_neu_occupancy; verweist jetzt auf fehlende binary_sensor.wk_neu_occupancy']);
    expect(zuordnungsAenderungen(alt, { ...alt, automationen: alt.automationen.filter(a => a.entityId !== 'automation.wk_aus') })).toEqual(['Automation „Licht Waschkammerl AUS" (automation.wk_aus) entfernt']);
  });

  it('Geräte, die es nicht mehr gibt, werden als fehlend gemeldet', () => {
    const z = baueZuordnung(quellen(), new Map(), info());
    expect(z.automationen.find(a => a.entityId === 'automation.eingang_ein')!.fehlend).toEqual(['Gerät b51c0708fc489009e2b30d906b2e2869 (switch)', 'Gerät b6b1c9dbe792865544a9e48e1adfc7be (binary_sensor)']);
  });
});

describe('HomeAssistantSkill relations / match über Automationen', () => {
  afterEach(() => vi.unstubAllGlobals());

  function haAttrappe(wk: Record<string, unknown>) {
    const aufrufe: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, opt?: { body?: string }) => {
      aufrufe.push(url);
      const antwort = (body: unknown) => ({ ok: true, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
      if (url.endsWith('/api/states')) return antwort([...info().keys()].map(e => ({
        entity_id: e, state: 'off', last_changed: new Date(Date.now() - 3_600_000).toISOString(),
        attributes: e === 'automation.wk_aus' ? { id: 'claude_licht_waschkammerl_aus', friendly_name: 'Licht Waschkammerl AUS' }
          : e === 'automation.eingang_ein' ? { id: '1722780891873', friendly_name: 'LichtEingangsbereichBEWein' }
          : { friendly_name: e, ...(e.endsWith('_occupancy') ? { device_class: 'occupancy' } : {}) },
      })));
      if (url.includes('/api/config/automation/config/claude_licht_waschkammerl_aus')) return antwort(wk);
      if (url.includes('/api/config/automation/config/1722780891873')) return antwort(EINGANG_EIN);
      if (url.includes('/api/template')) {
        const t = String(JSON.parse(opt?.body ?? '{}').template);
        if (t.includes('device_entities')) return antwort([...geraete.entries()].map(([g, e]) => `${g}|${e.join(',')}`).join('\n'));
        if (t.includes('area_name')) return antwort('switch.shelly1pmminig3_54320440b000_switch_0|Eingangsbereich|shelly1pmminig3\nswitch.lichtwaschkammerl|Waschkammerl|LichtWaschkammerl');
      }
      if (url.includes('/api/history/period/')) return antwort([]);
      if (url.includes('/api/logbook/')) return antwort([]);
      throw new Error(`unerwartet ${url}`);
    }));
    return aufrufe;
  }

  it('match „licht" findet den technisch benannten Shelly über die Automation; relations zeigt die Kette', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ha-zuo-'));
    try {
      const aufrufe = haAttrappe(WK_AUS);
      const skill = new HomeAssistantSkill({ baseUrl: 'http://ha', accessToken: 'x' } as HomeAssistantConfig, { zuordnungDatei: path.join(dir, 'z.json') });
      const r = await skill.execute({ action: 'history_summary', domain: 'switch', match: 'licht', period: '1d' }, {} as SkillContext);
      expect(r.success).toBe(true);
      expect(aufrufe.find(u => u.includes('/api/history/period/'))).toContain('switch.shelly1pmminig3_54320440b000_switch_0');
      expect(r.display).toContain('— Eingangsbereich');
      expect(r.display).toContain('geschaltet von Automation „LichtEingangsbereichBEWein"');
      // Bewegungslicht-Regel: auch ohne „licht" im Namen der Automation
      const r2 = await skill.execute({ action: 'history_summary', domain: 'switch', match: 'bewegungslicht', period: '1d' }, {} as SkillContext);
      expect(r2.display).toContain('switch.shelly1pmminig3_54320440b000_switch_0');
      expect(r2.display).not.toContain('Unbekannte');
      const rel = await skill.execute({ action: 'relations', area: 'Eingangsbereich' }, {} as SkillContext);
      expect(rel.display).toContain('(Auslöser: binary_sensor.eg_occupancy)');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('erkennt einen Sensortausch über einen Neustart hinweg (Datei) und zeigt ihn in der Übersicht', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ha-zuo-'));
    try {
      const datei = path.join(dir, 'z.json');
      haAttrappe(WK_AUS);
      await new HomeAssistantSkill({ baseUrl: 'http://ha', accessToken: 'x' } as HomeAssistantConfig, { zuordnungDatei: datei }).execute({ action: 'relations' }, {} as SkillContext);
      vi.unstubAllGlobals();
      haAttrappe({ ...WK_AUS, trigger: [{ platform: 'state', entity_id: 'binary_sensor.wk_neu_occupancy', to: 'off' }] });
      const logs: string[] = [];
      const skill = new HomeAssistantSkill({ baseUrl: 'http://ha', accessToken: 'x' } as HomeAssistantConfig, { zuordnungDatei: datei });
      skill.logger = { info: (_o, msg) => { logs.push(msg); } };
      const r = await skill.execute({ action: 'relations' }, {} as SkillContext);
      expect(r.display).toContain('Licht Waschkammerl AUS (`automation.wk_aus`): binary_sensor.wk_neu_occupancy');
      expect(r.display).toContain('Auslöser − binary_sensor.wk_occupancy + binary_sensor.wk_neu_occupancy');
      expect(logs).toContain('v1358 HA-Zuordnung geändert');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
