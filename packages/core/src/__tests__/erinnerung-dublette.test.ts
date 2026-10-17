import { describe, it, expect } from 'vitest';
import { gleicheErinnerung, gleicherGegenstand, istSammelErinnerung, unterscheidendeMerkmale } from '../vorgaenge/erinnerung-dublette.js';

// v1492 — Realfälle aus der Kalibrierung an 95 Erinnerungen und 103 Aktions-Vorgängen (16.09.–17.10.)
const e = (text: string, id = 'alt') => [{ id, text }];

describe('Gleiche Erinnerung', () => {
  it('dieselbe Sache in anderer Formulierung (Frist/Prozent dürfen sich ändern)', () => {
    for (const [neu, alt] of [
      ['Domains noahhabel.com/.at bei easyname verlängern (Frist 19.10. 09:00)', 'Domains noahhabel.com/.at bei easyname verlängern – Frist 18.10. 10:00'],
      ['Domain noahhabel.com bei easyname verlängern – Frist 20.10. 20:30', 'Domains noahhabel.com/.at bei easyname verlängern – Frist 18.10. 10:00'],
      ["Batterie Sensor 'Temp Terrasse' wechseln — Frist 20.10.", "Batterie des Sensors 'Temp Terrasse' wechseln (Stand 0 %)"],
      ['Domain dohnal.dev wiederherstellen (Ticket #18701726). Easyname-Portal', 'Domain dohnal.dev abgelaufen (28.08.2026). Ticket #18701726 im easyname-Portal'],
      ['aWATTar Juli-Rechnung (179,57 €) klären. Kontodeckung prüfen und ggf. anpassen', 'aWATTar-Rechnung Juli 2026 anfordern (E-Mail) und Kontodeckung für SEPA-Lastschrift prüfen'],
      ['Claude-API-Zugang prüfen (Anthropic-Mail vom 11.10., Handlung erforderlich)', 'Anthropic-Konto prüfen: Claude-API-Zugang wurde laut Mail vom 11.10. deaktiviert'],
    ]) expect(gleicheErinnerung(neu!, e(alt!)), neu).not.toBeNull();
  });

  it('anderer Gegenstand bleibt getrennt (lieber einmal zu oft erinnern als eine fehlt)', () => {
    for (const [neu, alt] of [
      // andere Domain (der Registrar easyname.com zählt nicht als Gegenstand)
      ["Domain 'pinkribbons.club' dringend prüfen und verlängern. Notiz vom 03.09.", 'Domain dohnal.dev abgelaufen (28.08.2026). Ticket #18701726 im easyname-Portal: https://www.easyname.com'],
      // anderer Monat
      ['aWATTar-Rechnung September (179,57 €) ausstehend. Kontodeckung für SEPA prüfen', 'aWATTar Juli-Rechnung (179,57 €) klären. Kontodeckung prüfen und ggf. anpassen'],
      // gleiches Gerät, anderer Zustand
      ['Wallbox go-echarger_402636 (IP 192.168.1.175) seit 31.08.2026 nicht erreichbar — Homeassistant-Skill konfigurieren', 'Wallbox go-echarger_402636: Temperatur 34.5°C (ungewöhnlich hoch). Skill Homeassistant konfigurieren'],
      // allgemein ≠ konkret
      ['Domain-Verlängerungen bei easyname.com prüfen und zahlen. Frist heute!', "Domain 'pinkribbons.club' dringend prüfen und verlängern. Notiz vom 03.09."],
      // Sammel-Erinnerung sperrt keine einzelne
      ["MikroTik-Router 'default' seit 24.06.2026 offline. Incident prüfen", 'Priorisiere heute: 1) fussball-cc FWC-11 Root-Cause-Analyse 2) MikroTik-Interfaces prüfen 3) Domains'],
      // Sammeltext deckt den neuen nicht ab
      ['9 unbeantwortete E-Mails mit dringendem Follow-up: TeamViewer, Pinterest, GitHub, aWATTar', 'TeamViewer-E-Mail (05.10., 10:14) zur KI-Fehlerbehebung beantworten'],
    ]) expect(gleicheErinnerung(neu!, e(alt!)), neu).toBeNull();
  });

  it('Merkmale und Sammel-Erkennung', () => {
    expect([...unterscheidendeMerkmale('Rechnung RE1788668 für pinkribbons.club, Link https://www.easyname.com/x, Juli').domain]).toEqual(['pinkribbons.club']);
    expect([...unterscheidendeMerkmale('Rechnung RE1788668, Ticket #18701726').kennung].sort()).toEqual(['#18701726', 'RE1788668']);
    expect(istSammelErinnerung('Top 3: 1) MikroTik prüfen, 2) FWC-11, 3) Domains')).toBe(true);
    expect(istSammelErinnerung('Batterie Temp Terrasse wechseln (Stand 0 %)')).toBe(false);
  });

  it('Vorgänge: Aktion gehört zu offenem Befund-Vorgang (dieselbe Prüfung)', () => {
    expect(gleicherGegenstand('Batterie des Temp-Terrasse-Sensors tauschen', [{ id: 'b', text: 'Temp Terrasse Batterie: 0 % leer → Batterie tauschen' }])?.id).toBe('b');
    expect(gleicherGegenstand('Incident für Proxmox git-server RAM 95,5 % anlegen', [{ id: 'p', text: 'proxmox: git-server RAM usage 95.7%' }])?.id).toBe('p');
    expect(gleicherGegenstand('Watch für günstige Strompreise erstellen', [{ id: 'x', text: 'Temp Terrasse Batterie: 0 % leer → Batterie tauschen' }])).toBeNull();
  });
});
