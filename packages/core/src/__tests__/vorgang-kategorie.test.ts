import { describe, it, expect } from 'vitest';
import { kategorieAus } from '../vorgaenge/kategorie.js';

// v1195 — Realfälle 05.10. (vorher: general/general/vehicle/—)
describe('kategorieAus', () => {
  it('ordnet die heutigen Vorgänge den Weltmodell-Quellen zu', () => {
    expect(kategorieAus('9 unbeantwortete E-Mails mit dringendem Follow-up (u.a. TeamViewer, Pinterest)')).toBe('email');
    expect(kategorieAus('Kritische Systemfehler: E-Mail (50% Error-Rate) und File-Zugriff (75% Error-Rate) → Infrastruktur prüfen')).toBe('alfred');
    expect(kategorieAus('BMW REST-API ausgefallen: Letzter Abruf vor 2h – Fahrzeugdaten nicht aktuell')).toBe('bmw');
    expect(kategorieAus('Proxmox-Server `git-server` RAM-Auslastung 95,1% (kritisch)')).toBe('infra');
    expect(kategorieAus('Smart-Home-Sensor "Temp Terrasse" Batterie 0%')).toBe('haus');
    expect(kategorieAus('Strompreis aktuell günstig (27,97 ct/kWh brutto)')).toBe('energie');
    expect(kategorieAus('Incident für Proxmox-RAM-Überlastung aktualisieren (ID aus ITSM-Dashboard)')).toBe('itsm');
    expect(kategorieAus('Erinnerung für E-Mail-Follow-up (TeamViewer) setzen.')).toBe('email');
  });
  it('Priorität: eigene Fehlerraten vor Infra, Incident vor Quelle, Rest sonstiges', () => {
    expect(kategorieAus('Server git-server: Skill-Fehlerrate 50 %')).toBe('alfred');
    expect(kategorieAus('Incident zu BMW-Stream anlegen')).toBe('itsm');
    expect(kategorieAus('Domain pinkribbons.club verlängern')).toBe('sonstiges');
    expect(kategorieAus('Termin mit Zahnarzt verschieben')).toBe('kalender');
    expect(kategorieAus('Überweisung an den Verein freigeben')).toBe('finanzen');
    expect(kategorieAus('Tür zur Terrasse seit 40 min offen')).toBe('haus');
    expect(kategorieAus('Reposition des Sensors prüfen')).toBe('haus'); // „Repo" greift nicht in „Reposition"
  });
});
