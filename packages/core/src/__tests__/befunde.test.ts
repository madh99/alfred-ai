import { describe, it, expect } from 'vitest';
import { befundeAusDeutung, quelleZuKategorie, bereinigeZeile, infraAlertSchluessel, infraDeutungAus } from '../ereignisse/befunde.js';

// v1217 — Jarvis Schicht 3: Befunde mit Identität aus den Deutungen des Weltmodells.
describe('infraAlertSchluessel (v1219)', () => {
  it('Proxmox/UniFi/HA-Alerts bekommen Schlüssel ohne Messwerte — gleicher Server, anderer Prozentwert = gleicher Befund', () => {
    expect(infraAlertSchluessel({ source: 'proxmox', message: 'git-server RAM usage 95.1%' })).toBe('proxmox:git-server:ram');
    expect(infraAlertSchluessel({ source: 'proxmox', message: 'git-server RAM usage 96.0%' })).toBe('proxmox:git-server:ram');
    expect(infraAlertSchluessel({ source: 'proxmox', message: 'git-server disk usage 91.2%' })).toBe('proxmox:git-server:disk');
    expect(infraAlertSchluessel({ source: 'proxmox', message: 'Node "pve2" is offline' })).toBe('proxmox:pve2:offline');
    expect(infraAlertSchluessel({ source: 'unifi', message: 'Device "AC Mesh" is not connected (state: 0)' })).toBe('unifi:device:ac-mesh');
    expect(infraAlertSchluessel({ source: 'unifi', message: 'Subsystem "wlan" status: warning' })).toBe('unifi:subsystem:wlan');
    expect(infraAlertSchluessel({ source: 'unifi', message: '3 open alert(s): EVT_AP_Lost_Contact' })).toBe('unifi:alarms');
    expect(infraAlertSchluessel({ source: 'homeassistant', message: 'Low battery: Temp Terrasse at 12%' })).toBe('homeassistant:battery:temp-terrasse');
    expect(infraAlertSchluessel({ source: 'commvault', message: 'Health check failed: timeout after 30000ms' })).toBe('commvault:health-check-failed-timeout-after-30000ms');
  });
  it('infraDeutungAus liefert eine ⚠️-Zeile je Alert und dedupliziert gleiche Schlüssel; Titel nennt Host', () => {
    const d = infraDeutungAus([{ source: 'proxmox', message: 'git-server RAM usage 95.1%' }, { source: 'proxmox', message: 'git-server RAM usage 95.3%' }, { source: 'unifi', message: 'Device "AC Mesh" is not connected (state: 0)' }]);
    expect(d.auffaellig).toEqual(['proxmox:git-server:ram', 'unifi:device:ac-mesh']);
    expect(d.zeilen).toHaveLength(2);
    const b = befundeAusDeutung('infra', d);
    expect(b[0].titel).toBe('proxmox: git-server RAM usage 95.1%');
    expect(b[1].titel).toBe('unifi: Device "AC Mesh" is not connected (state: 0)');
  });
});

describe('befundeAusDeutung', () => {
  it('ordnet jedem auffälligen Schlüssel die passende ⚠️-Zeile als Titel zu', () => {
    const d = {
      zeilen: [
        '**Sensorbatterien:** 12 Sensoren · niedrigster ok 61 %',
        '⚠️ Temp Terrasse: nicht erreichbar (zuletzt 05.10. 13:20) → Sensor prüfen',
        '⚠️ Wohnzimmer Fenster: 8 % (−3 %/Tag) → in ~2 Tagen tauschen',
      ],
      auffaellig: ['sensorbatterie:sensor.temp_terrasse_battery:offline', 'sensorbatterie:sensor.wohnzimmer_fenster_battery:niedrig'],
    };
    const b = befundeAusDeutung('sensorbatterien', d);
    expect(b.map(x => x.gegenstand)).toEqual(d.auffaellig);
    expect(b[0].titel).toBe('Temp Terrasse: nicht erreichbar (zuletzt 05.10. 13:20) → Sensor prüfen');
    expect(b[1].titel).toBe('Wohnzimmer Fenster: 8 % (−3 %/Tag) → in ~2 Tagen tauschen');
    expect(b[0].detail).toContain('Sensorbatterien: 12 Sensoren');
  });
  it('v1218 Realfall: mehrere Sensoren in EINER Zeile mit „ · " → Titel ist das passende ⚠️-Segment', () => {
    const zeile = '**Sensorbatterien:** 20 Sensoren · Holztüre Garage Batterie: 50 % (Trend im Aufbau) ↳ beobachten · ⚠️ Terrasse Temp Terrasse Batterie: nicht erreichbar (zuletzt 05.10. 13:20) → Sensor prüfen · niedrigster ok 61 %';
    const b = befundeAusDeutung('sensorbatterien', { zeilen: [zeile], auffaellig: ['sensorbatterie:sensor.terrasse_temp_terrasse_batterie:offline'] });
    expect(b[0].titel).toBe('Terrasse Temp Terrasse Batterie: nicht erreichbar (zuletzt 05.10. 13:20) → Sensor prüfen');
  });
  it('eine einzige ⚠️-Zeile gilt für den einen Schlüssel; ohne Zeile generischer Titel; Duplikate und leer', () => {
    expect(befundeAusDeutung('energie', { zeilen: ['**Hausbatterie:** 12 % ⚠️ niedrig (≤ 15 %)'], auffaellig: ['hausbatterie:niedrig'] })[0].titel).toBe('Hausbatterie: 12 % ⚠️ niedrig (≤ 15 %)');
    expect(befundeAusDeutung('mikrotik', { zeilen: ['Interfaces: 8 up'], auffaellig: ['mikrotik:ether5:neu-down'] })[0].titel).toBe('mikrotik: mikrotik:ether5:neu-down');
    expect(befundeAusDeutung('bmw', { zeilen: [], auffaellig: ['mqtt', 'mqtt'] })).toHaveLength(1);
    expect(befundeAusDeutung('bmw', undefined)).toEqual([]);
  });
  it('Quelle → Kategorie der Vorgänge; Zeilen werden bereinigt', () => {
    expect(quelleZuKategorie('sensorbatterien')).toBe('haus');
    expect(quelleZuKategorie('mikrotik')).toBe('infra');
    expect(quelleZuKategorie('bmw')).toBe('bmw');
    expect(bereinigeZeile('**⚠️ ALARM:** Rauch Küche ausgelöst')).toBe('ALARM: Rauch Küche ausgelöst');
  });
});
