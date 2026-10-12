import { describe, it, expect } from 'vitest';
import { alsAlarm, eintragText, istInfraEreignis, istWarnung, nachSchwere } from '../built-in/unifi-systemlog.js';

// v1381 — Einträge wie live vom UDM Pro (System-Log v2, 12.10.)
describe('UniFi System-Log', () => {
  const block = {
    key: 'TRAFFIC_BLOCKED_BY_FIREWALL', severity: 'MEDIUM', category: 'SECURITY', timestamp: 1_760_270_000_000,
    message_raw: '{CLIENT} was blocked from reaching {DESTINATION}',
    parameters: { CLIENT: { id: 'aa:bb', name: 'Handy' }, DESTINATION: { value: '1.2.3.4' } },
  };

  it('setzt Platzhalter aus den Parametern ein, unbekannte bleiben stehen', () => {
    expect(eintragText(block)).toBe('Handy was blocked from reaching 1.2.3.4');
    expect(eintragText({ message_raw: '{DEVICE} offline' })).toBe('{DEVICE} offline');
  });

  it('bildet das bisherige Alarm-Format', () => {
    const a = alsAlarm(block);
    expect(a.key).toBe('TRAFFIC_BLOCKED_BY_FIREWALL');
    expect(a.device_name).toBe('Handy');
    expect(a.archived).toBe(false);
    expect(a.datetime).toMatch(/^2025-|^2026-|^\d{4}-/);
  });

  it('Routine (LOW) ist keine Warnung', () => {
    expect(istWarnung({ severity: 'LOW' })).toBe(false);
    expect(istWarnung({ severity: 'MEDIUM' })).toBe(true);
    expect(istWarnung({})).toBe(false);
  });

  it('schwerste zuerst — HIGH wird nicht von Firewall-Blocks verdrängt', () => {
    const l = nachSchwere([
      { key: 'TRAFFIC_BLOCKED_X', severity: 'MEDIUM', timestamp: 3 },
      { key: 'SFP_RECEIVED_FAULT', severity: 'HIGH', timestamp: 1 },
      { key: 'TRAFFIC_BLOCKED_Y', severity: 'MEDIUM', timestamp: 5 },
    ]);
    expect(l.map(e => e.key)).toEqual(['SFP_RECEIVED_FAULT', 'TRAFFIC_BLOCKED_Y', 'TRAFFIC_BLOCKED_X']);
  });

  it('Infra-Ereignisse ohne Client- und Firewall-Rauschen', () => {
    expect(istInfraEreignis({ key: 'CLIENT_ROAMED_2' })).toBe(false);
    expect(istInfraEreignis({ key: 'TRAFFIC_BLOCKED_KNOWN_SOURCE_CLIENT_AND_DESTINATION_DEVICE' })).toBe(false);
    expect(istInfraEreignis({ key: 'AP_CHANGED_CHANNELS' })).toBe(true);
    expect(istInfraEreignis({ key: 'ISP_HIGH_LATENCY_2' })).toBe(true);
  });
});
