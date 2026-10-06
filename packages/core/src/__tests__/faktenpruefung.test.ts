import { describe, it, expect } from 'vitest';
import { widersprichtWeltmodell, datenlageNormal } from '../vorgaenge/faktenpruefung.js';

// v1214 — Realfall 06.10.: „BMW OAuth-Flow neu starten" dreimal als Vorgang, obwohl REST-Abruf und Stream liefen.
const BMW_NORMAL = '**Fahrzeug:** steht · zu Hause\n**Datenlage:** MQTT-Stream still seit 08:12 (2 h) ↳ NORMAL: der Stream sendet nur bei aktivem Fahrzeug · REST-Abruf vor 20 min';
const BMW_GESTOERT = '**Fahrzeug:** steht\n**Datenlage:** MQTT-Stream still ↳ NORMAL · REST-Abruf überfällig seit 4 h (erwartet stündlich)';

describe('datenlageNormal', () => {
  it('NORMAL ohne Störwort ist normal, mit Störwort nicht, ohne Inhalt nicht', () => {
    expect(datenlageNormal(BMW_NORMAL)).toBe(true);
    expect(datenlageNormal(BMW_GESTOERT)).toBe(false);
    expect(datenlageNormal(undefined)).toBe(false);
    expect(datenlageNormal('**Fahrzeug:** fährt')).toBe(false);
  });
});

describe('widersprichtWeltmodell', () => {
  const inhalte = new Map([['bmw', BMW_NORMAL]]);
  it('Ausfall-Behauptung über BMW bei normaler Datenlage → Widerspruch', () => {
    const w = widersprichtWeltmodell('BMW API-Token erneuern: Der OAuth-Flow muss neu gestartet werden, sonst sind keine Fahrzeugdaten mehr abrufbar.', inhalte);
    expect(w?.sektion).toBe('bmw');
    expect(w?.grund).toContain('Weltmodell bmw');
    expect(widersprichtWeltmodell('BMW REST-API ausgefallen: Letzter Abruf vor 2h', inhalte)?.sektion).toBe('bmw');
  });
  it('kein Widerspruch ohne Ausfall-Behauptung, bei gestörter Datenlage oder bei fremder Quelle', () => {
    expect(widersprichtWeltmodell('BMW laden: Strompreis günstig, Ladefenster aktivieren', inhalte)).toBeNull();
    expect(widersprichtWeltmodell('BMW REST-API ausgefallen', new Map([['bmw', BMW_GESTOERT]]))).toBeNull();
    expect(widersprichtWeltmodell('Proxmox git-server nicht erreichbar', inhalte)).toBeNull();
    expect(widersprichtWeltmodell('BMW Token erneuern', new Map())).toBeNull();
  });
  it('funktioniert mit einer Nachschlagefunktion statt Map', () => {
    expect(widersprichtWeltmodell('Fahrzeug offline', (k) => (k === 'bmw' ? BMW_NORMAL : undefined))?.sektion).toBe('bmw');
  });
});
