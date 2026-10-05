import { describe, it, expect, vi } from 'vitest';
import { deuteHaus, klassifiziereHausEreignis, type HaZustand } from '../normalzustaende/haus.js';
import { verarbeiteNachricht, wsUrlAus, HaEreignisQuelle, type WebSocketArtig } from '../ereignisse/ha-ereignisse.js';

// Jarvis Schicht 2 Teil 2 — Live-Entitäten Home Assistant 05.10.2026 10:58.
const S = (entity_id: string, state: string, device_class?: string, friendly_name?: string, last_changed = '2026-10-05T08:30:00Z'): HaZustand =>
  ({ entity_id, state, attributes: { device_class, friendly_name }, last_changed });

const LIVE: HaZustand[] = [
  S('person.madh', 'home', undefined, 'madh'), S('person.alexandra', 'home', undefined, 'Alexandra'), S('person.lena', 'not_home', undefined, 'Lena'),
  S('binary_sensor.smokelinus_smoke', 'off', 'smoke', 'SmokeLinus smoke'),
  S('binary_sensor.0x00158d00047e1911_0x00158d00047e1911_contact', 'on', 'door', 'Fenster Lena Tür', '2026-10-05T07:12:00Z'),
  S('binary_sensor.0x00158d00045cce2b_0x00158d00045cce2b_contact', 'off', 'door', 'Eingangstüre Tür'),
  S('binary_sensor.b_kueche_occupancy', 'on', 'occupancy', 'B_KUECHE Belegung'),
  S('binary_sensor.g4_doorbell_pro_motion', 'on', 'motion', 'G4 Doorbell Pro Bewegung'),
  S('binary_sensor.wetterstation_rain_status', 'on', 'moisture', 'Wetterstation Feuchte'),
  S('alarm_control_panel.udmpro_alarm_manager', 'disarmed', undefined, 'UDMPRO Alarm-Manager'),
  S('sensor.victron_vebus_soc_227', 'unavailable'),
];

describe('deuteHaus', () => {
  it('jemand zu Hause: offenes Fenster NORMAL, Regen-Sensor keine Wasser-Warnung, Kamera-Bewegung ignoriert', () => {
    const d = deuteHaus(LIVE);
    const t = d.zeilen.join('\n');
    expect(d.alleAbwesend).toBe(false);
    expect(t).toMatch(/\*\*Anwesenheit:\*\* madh: zuhause, alexandra: zuhause, lena: abwesend/);
    expect(t).toMatch(/\*\*Offen:\*\* Fenster Lena \(seit 09:12\) ↳ NORMAL \(jemand zu Hause\)/);
    expect(t).not.toMatch(/WASSER|Bewegung bei Abwesenheit|RAUCH/);
    expect(t).toMatch(/\*\*Alarmanlage:\*\* UDMPRO Alarm-Manager disarmed ↳ NORMAL/);
    expect(d.auffaellig).toEqual([]);
  });
  it('alle abwesend: offene Tür + Innenraum-Bewegung sind Signal, Kamera nicht; Alarm nicht scharf = Hinweis', () => {
    const weg = LIVE.map(z => z.entity_id.startsWith('person.') ? { ...z, state: 'not_home' } : z);
    const d = deuteHaus(weg);
    const t = d.zeilen.join('\n');
    expect(d.alleAbwesend).toBe(true);
    expect(t).toMatch(/⚠️ Offen bei Abwesenheit:\*\* Fenster Lena/);
    expect(t).toMatch(/⚠️ Bewegung bei Abwesenheit:\*\* B_KUECHE Belegung/);
    expect(t).not.toMatch(/Doorbell/);
    expect(t).toMatch(/Hinweis: niemand zu Hause, nicht scharf/);
    expect(d.auffaellig.sort()).toEqual(['haus:bewegung-bei-abwesenheit:binary_sensor.b_kueche_occupancy', 'haus:offen-bei-abwesenheit:binary_sensor.0x00158d00047e1911_0x00158d00047e1911_contact']);
  });
  it('Rauch und CO sind immer Signal', () => {
    const d = deuteHaus([S('binary_sensor.smokelinus_smoke', 'on', 'smoke', 'SmokeLinus'), S('binary_sensor.g4_doorbell_pro_co_alarm_detected', 'on', 'carbon_monoxide', 'G4 CO')]);
    expect(d.zeilen.join('\n')).toMatch(/⚠️ RAUCH:\*\* SmokeLinus meldet Rauch .* SOFORT prüfen/);
    expect(d.auffaellig).toEqual(['haus:rauch:binary_sensor.smokelinus_smoke', 'haus:co:binary_sensor.g4_doorbell_pro_co_alarm_detected']);
  });
});

describe('klassifiziereHausEreignis', () => {
  it('nur echte Zustandswechsel relevanter Entitäten', () => {
    expect(klassifiziereHausEreignis(S('person.madh', 'home'), S('person.madh', 'not_home'))).toEqual({ typ: 'anwesenheit', cooldownMin: 30 });
    expect(klassifiziereHausEreignis(S('person.madh', 'home'), S('person.madh', 'home'))).toBeUndefined();
    expect(klassifiziereHausEreignis(undefined, S('binary_sensor.x', 'on', 'smoke'))).toEqual({ typ: 'rauch', cooldownMin: 10 });
    expect(klassifiziereHausEreignis(S('binary_sensor.t', 'off', 'door'), S('binary_sensor.t', 'on', 'door'))).toEqual({ typ: 'oeffnung', cooldownMin: 30 });
    expect(klassifiziereHausEreignis(undefined, S('binary_sensor.g4_doorbell_pro_motion', 'on', 'motion'))).toBeUndefined();
    expect(klassifiziereHausEreignis(undefined, S('sensor.temp', '21.5'))).toBeUndefined();
    expect(klassifiziereHausEreignis(undefined, S('binary_sensor.x', 'unavailable', 'smoke'))).toBeUndefined();
  });
});

describe('HaEreignisQuelle', () => {
  it('wsUrlAus', () => {
    expect(wsUrlAus('https://ha.example.at/')).toBe('wss://ha.example.at/api/websocket');
    expect(wsUrlAus('http://192.168.1.5:8123')).toBe('ws://192.168.1.5:8123/api/websocket');
  });
  it('verarbeiteNachricht: Auth-Phasen und state_changed-Filter', () => {
    const letzte = new Map();
    expect(verarbeiteNachricht('{"type":"auth_required"}', letzte).art).toBe('auth_required');
    expect(verarbeiteNachricht('{"type":"auth_ok"}', letzte).art).toBe('auth_ok');
    expect(verarbeiteNachricht('kein json', letzte).art).toBe('sonst');
    const ev = { type: 'event', event: { event_type: 'state_changed', data: { entity_id: 'person.madh', old_state: S('person.madh', 'home'), new_state: S('person.madh', 'not_home') } } };
    const r = verarbeiteNachricht(JSON.stringify(ev), letzte);
    expect(r.art).toBe('ereignis');
    expect(r.ereignis?.typ).toBe('anwesenheit');
    const temp = { type: 'event', event: { event_type: 'state_changed', data: { entity_id: 'sensor.temp', new_state: S('sensor.temp', '22') } } };
    expect(verarbeiteNachricht(JSON.stringify(temp), letzte).art).toBe('sonst');
  });
  it('Handshake über eine Fake-WebSocket: auth → subscribe → Ereignis → Callback; Entprellen', async () => {
    const gesendet: string[] = [];
    let sock!: WebSocketArtig;
    const fabrik = (): WebSocketArtig => { sock = { send: (d) => { gesendet.push(d); }, close: () => undefined, onopen: null, onmessage: null, onclose: null, onerror: null }; return sock; };
    const onEreignis = vi.fn(async () => undefined);
    const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn() } as never;
    const q = new HaEreignisQuelle({ baseUrl: 'https://ha.example.at', accessToken: 'tok', logger: log, onEreignis, wsFabrik: fabrik });
    q.start();
    sock.onopen!({});
    sock.onmessage!({ data: '{"type":"auth_required"}' });
    expect(JSON.parse(gesendet[0])).toEqual({ type: 'auth', access_token: 'tok' });
    sock.onmessage!({ data: '{"type":"auth_ok"}' });
    expect(JSON.parse(gesendet[1])).toMatchObject({ type: 'subscribe_events', event_type: 'state_changed' });
    expect(q.status().verbunden).toBe(true);
    expect(q.ensureConnected()).toBe('ok');
    const ev = JSON.stringify({ type: 'event', event: { event_type: 'state_changed', data: { entity_id: 'binary_sensor.smokelinus_smoke', old_state: S('binary_sensor.smokelinus_smoke', 'off', 'smoke'), new_state: S('binary_sensor.smokelinus_smoke', 'on', 'smoke') } } });
    sock.onmessage!({ data: ev });
    sock.onmessage!({ data: ev }); // entprellt
    await new Promise(r => setTimeout(r, 5));
    expect(onEreignis).toHaveBeenCalledTimes(1);
    expect(q.status().ereignisse).toBe(1);
    q.stop();
  });
});
