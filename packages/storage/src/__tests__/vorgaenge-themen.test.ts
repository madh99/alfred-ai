import { describe, it, expect } from 'vitest';
import { themenGleich, titelAnker } from '../repositories/vorgaenge-repository.js';

// v1214 — Realfall 06.10.: 42 offene Vorgänge, dieselben drei Themen fünf- bis sechsmal in neuem Wortlaut.
describe('titelAnker', () => {
  it('erkennt Hostnamen, Domains, Zitate, Kürzel und Markennamen — nicht aber deutsche Substantive', () => {
    expect(titelAnker('Proxmox-Server `git-server` RAM-Auslastung 95,1%')).toEqual(expect.any(Set));
    const a = titelAnker('Proxmox git-server bei 95,0 % RAM: Der Alert ist seit gestern offen');
    expect(a.has('git-server')).toBe(true);
    expect(a.has('ram')).toBe(true);
    expect(a.has('proxmox')).toBe(false); // schlichtes Wort, kein Kürzel
    const d = titelAnker('Domain-Verlust droht: easyname-Verlängerung (Mail 21.06.) sowie nic.at-Rechnungen für 3051.at');
    expect(d.has('nic.at')).toBe(true);
    expect(d.has('3051.at')).toBe(true);
    expect(d.has('easyname-verlängerung')).toBe(true);
    expect(titelAnker('Smart-Home-Sensor "Temp Terrasse" Batterie 0%').has('temp terrasse')).toBe(true);
    const b = titelAnker('BMW OAuth-Flow neu starten, damit wieder Fahrzeugdaten abrufbar sind');
    expect(b.has('bmw')).toBe(true);
    expect(b.has('oauth-flow')).toBe(true);
    expect(titelAnker('Batterie Terrasse tauschen').size).toBe(0);
  });
});

describe('themenGleich', () => {
  it('Realfälle gleichen Themas in neuem Wortlaut werden zusammengeführt', () => {
    expect(themenGleich('Proxmox-Server `git-server` RAM-Auslastung 95,1%', 'Proxmox git-server bei 95,0 % RAM: Der Alert ist seit mindestens gestern offen')).toBe(true);
    expect(themenGleich('Handlungsbedarf – Proxmox git-server RAM: Der Server, auf dem die fussball-cc-Entwicklung läuft', 'Proxmox „git-server" bei 95,1 % RAM')).toBe(true);
    expect(themenGleich('Domain-Verlust droht: easyname-Verlängerung (Mail 21.06.) sowie die nic.at-Rechnungen für 3051.at', 'Domains seit Juni überfällig: easyname-Verlängerung (Mail 21.06.) sowie nic.at-Rechnungen für 3051.at')).toBe(true);
    expect(themenGleich('Domain-Check: easyname, nic.at und pinkribbons.club prüfen (Zahlung/Verlängerung)', 'Überfällige Domain-Todos mit Verlustrisiko: easyname-Produkte (Verlängerungsfrist) und nic.at-Rechnungen')).toBe(true);
    expect(themenGleich('BMW API-Token erneuern (OAuth-Flow starten).', 'BMW OAuth-Flow neu starten, damit wieder Fahrzeugdaten abrufbar sind')).toBe(true);
    expect(themenGleich('ITSM Incident für E-Mail/File-Error-Rate erstellen (Severity: urgent).', 'ITSM-Incident für erhöhte Fehlerraten bei E-Mail- und File-Skill anlegen')).toBe(true);
    expect(themenGleich('Smart-Home-Sensor "Temp Terrasse" Batterie 0%', 'ITSM Incident für Smart-Home-Sensor \'Temp Terrasse\' erstellen (Batterie 0%). Severity: high.')).toBe(true);
  });
  it('verschiedene Themen bleiben getrennt', () => {
    expect(themenGleich('Batterie Terrasse tauschen', 'Batterie Wohnzimmer tauschen')).toBe(false);
    expect(themenGleich('Proxmox git-server bei 95 % RAM', 'Proxmox Backup fehlgeschlagen')).toBe(false);
    expect(themenGleich('BMW REST-API prüfen: Letzter Abruf vor 2 Stunden', 'BMW Ladeplan für die Nacht setzen')).toBe(false);
    expect(themenGleich('9 unbeantwortete E-Mails mit Follow-up-Bedarf', 'Kritische Systemfehler: E-Mail- und File-Zugriff blockiert')).toBe(false);
    expect(themenGleich('Strompreis aktuell günstig (27,97 ct/kWh brutto)', 'Hausbatterie-Ladefenster aktivieren (Strompreis günstig: 27,97 ct/kWh)')).toBe(false);
  });
});
