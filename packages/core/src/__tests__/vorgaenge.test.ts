import { describe, it, expect } from 'vitest';
import { klassifiziereAktion } from '../vorgaenge/autonomie.js';
import { formatiereGedaechtnis } from '../vorgaenge/ausfuehrungsgedaechtnis.js';

// Jarvis Schicht 3 — Autonomie-Klassen (Freigabe Owner 05.10.) und Ausführungsgedächtnis.
describe('klassifiziereAktion', () => {
  it('auto: Reminder, Watch, Todo, Dokument, Notiz, Memory', () => {
    expect(klassifiziereAktion('reminder', { action: 'set', message: 'Müll' })).toBe('auto');
    expect(klassifiziereAktion('watch', { action: 'create', name: 'BMW SoC' })).toBe('auto');
    expect(klassifiziereAktion('todo', { action: 'create', title: 'Batterie kaufen' })).toBe('auto');
    expect(klassifiziereAktion('document', { action: 'store' })).toBe('auto');
    expect(klassifiziereAktion('memory', { key: 'x', value: 'y' })).toBe('auto');
  });
  it('bestaetigen: E-Mail senden, Kalender ändern, Smart Home schalten, Social, Infra-Schreibzugriffe, Unbekanntes', () => {
    expect(klassifiziereAktion('email', { action: 'send', to: 'x@y.z' })).toBe('bestaetigen');
    expect(klassifiziereAktion('calendar', { action: 'create_event' })).toBe('bestaetigen');
    expect(klassifiziereAktion('calendar', { action: 'list' })).toBe('auto');
    expect(klassifiziereAktion('homeassistant', { action: 'turn_on', entityId: 'light.x' })).toBe('bestaetigen');
    expect(klassifiziereAktion('social', { action: 'publish_now' })).toBe('bestaetigen');
    expect(klassifiziereAktion('proxmox', { action: 'start_vm' })).toBe('bestaetigen');
    expect(klassifiziereAktion('irgendwas_neues', { action: 'foo' })).toBe('bestaetigen');
    expect(klassifiziereAktion('reminder', { action: 'cancel' })).toBe('bestaetigen'); // Löschen eines Reminders ist nicht nie, aber auch nicht auto
  });
  it('nie: Konfig-Löschungen, Zahlungen, destruktive Shell/DB/Infra', () => {
    expect(klassifiziereAktion('configure', { action: 'delete_service' })).toBe('nie');
    expect(klassifiziereAktion('environments', { action: 'delete' })).toBe('nie');
    expect(klassifiziereAktion('bitpanda', { action: 'buy', amount: 100 })).toBe('nie');
    expect(klassifiziereAktion('trading', { action: 'anything' })).toBe('nie');
    expect(klassifiziereAktion('shell', { command: 'rm -rf /var/lib/alfred' })).toBe('nie');
    expect(klassifiziereAktion('database', { action: 'drop_table' })).toBe('nie');
    expect(klassifiziereAktion('proxmox', { action: 'delete_vm' })).toBe('nie');
    expect(klassifiziereAktion('marketplace', { action: 'order' })).toBe('nie');
    expect(klassifiziereAktion('cmdb', { action: 'delete_asset' })).toBe('nie');
  });
  it('Shell ohne destruktives Muster bleibt bestaetigen', () => {
    expect(klassifiziereAktion('shell', { command: 'df -h' })).toBe('bestaetigen');
  });
});

describe('formatiereGedaechtnis', () => {
  it('offene Vorgänge + dedupliziertes „Bereits getan"', () => {
    const t = formatiereGedaechtnis(
      [
        { id: '1', userId: 'u', zeit: '2026-10-05T09:02:00Z', art: 'ausgefuehrt', skill: 'reminder', aktion: 'set', beschreibung: 'Reminder Batterie Terrasse tauschen', quelle: 'reasoning' },
        { id: '2', userId: 'u', zeit: '2026-10-05T08:32:00Z', art: 'ausgefuehrt', skill: 'reminder', aktion: 'set', beschreibung: 'Reminder Batterie Terrasse tauschen', quelle: 'reasoning' },
        { id: '3', userId: 'u', zeit: '2026-10-05T08:30:00Z', art: 'fehlgeschlagen', skill: 'scheduled_task', aktion: 'create', beschreibung: 'Scheduled Task MikroTik-Probe', ergebnis: 'Missing required field "schedule"', quelle: 'reasoning' },
        { id: '4', userId: 'u', zeit: '2026-10-05T08:00:00Z', art: 'blockiert', skill: 'configure', aktion: 'delete_service', beschreibung: 'Service x löschen', autonomie: 'nie', quelle: 'reasoning' },
      ],
      [{ id: 'v1', userId: 'u', titel: 'BMW-MQTT-Stream prüfen', besitzer: 'user', status: 'offen', naechsterSchritt: 'CarData-Portal prüfen', quelle: 'reasoning', autonomie: 'bestaetigen', erstellt: '', aktualisiert: '' }],
    );
    expect(t).toMatch(/Offene Vorgänge \(1\):\n- \[User · bestaetigen\] BMW-MQTT-Stream prüfen → nächster Schritt: CarData-Portal prüfen/);
    expect(t).toMatch(/Bereits getan \(letzte 14 Tage, 4 Schritte\) — NICHT erneut vorschlagen:/);
    expect(t.match(/Reminder Batterie Terrasse tauschen/g)).toHaveLength(1);
    expect(t).toMatch(/FEHLGESCHLAGEN: Scheduled Task MikroTik-Probe \[scheduled_task\/create\] — Missing required field/);
    expect(t).toMatch(/blockiert \(Autonomie: nie\): Service x löschen/);
  });
  it('leer → leerer Text', () => {
    expect(formatiereGedaechtnis([], [])).toBe('');
  });
});
