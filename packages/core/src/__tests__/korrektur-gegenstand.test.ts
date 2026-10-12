import { describe, it, expect } from 'vitest';
import { findeVerletzteUnterdrueckungsKorrektur, gegenstandAusKorrekturSchluessel } from '../reasoning-engine.js';

// v1368 — Realfälle 06.–12.10.: Korrekturen schluckten fremde, echte Hinweise, weil lange Alltagswörter („erreichbar",
// „Bestätigung", „verlängert") als Fach-Objekt galten. Korrekturen und Hinweise wörtlich aus Datenbank und Log.
const K = [
  { key: 'correction_bmw_api_token_resolved', value: 'User bestätigt: BMW API-Token erneuert, OAuth-/Token-Problem erledigt. Alte Aufforderungen zur Token-Erneuerung nicht mehr als Handlungsbedarf melden. Neue, nach dieser Bestätigung auftretende Auth-Fehler separat prüfen.' },
  { key: 'correction_pinkribbons_domain_renewal_resolved', value: 'User bestätigt: pinkribbons.club (in Nachricht pinkribons.club geschrieben) wurde verlängert. Alte Verlängerungsaufforderungen hierzu nicht mehr melden. Rechnungen/Mahnungen zu anderen Domains separat prüfen.' },
  { key: 'correction_shelly_68c63afadba8_alert_resolved', value: 'Prüfung 12.10.2026 00:15: Shelly 68C63AFADBA8 (172.16.0.38) in HA und direkt erreichbar, Überlast off/false, Überhitzung off/false, Temperaturstatus Normal. Frühere Behauptung aktiver Überlast/Überhitzung war unbelegt: unavailable Problem-Entitäten bedeuten nicht aktive Alarme. Alte Warnung und daraus abgeleitete Prüffrist 25.10. nicht erneut melden ohne neuen belegten Befund. Verbraucher unbekannt, kein Raum oder Gerätename hinterlegt.' },
  { key: 'correction_house_battery_low_soc_resolved', value: 'Nutzer bestätigt zum Hausbatterie-Hinweis vom 11.10.2026: Die Batterie wird in Home Assistant per EMS gesteuert und lädt gerade; der gemeldete niedrige SoC ist damit kein aktueller Handlungsbedarf. Niedrigen SoC allein bei regulärer EMS-Steuerung nicht als Störung melden; Ladezustand und EMS-Kontext berücksichtigen.' },
  { key: 'correction_no_sommercamp', value: 'Es gibt aktuell KEIN Sommercamp für Linus. Wenn künftig eines geplant wird, steht es ausdrücklich im Kalender bzw. wird neu bestätigt. Nicht mehr als Termin oder Handlungsbedarf melden.' },
  { key: 'unterdruecke_mqtt_stream_fahrzeug', value: 'BMW MQTT/API-Datenalter ist kein Fehler: der MQTT-Stream sendet nur, wenn das Fahrzeug aktiv ist. Veraltete SoC-/Reichweiten-Daten bei stehendem Fahrzeug sind normal — nicht melden, nicht warnen.' },
];

describe('Gegenstand aus dem Korrektur-Schlüssel', () => {
  it('Füllteile fallen weg, englische Teile werden deutsch', () => {
    expect(gegenstandAusKorrekturSchluessel('correction_bmw_api_token_resolved')).toEqual(['bmw']);
    expect(gegenstandAusKorrekturSchluessel('correction_shelly_68c63afadba8_alert_resolved')).toEqual(['shelly', '68c63afadba8']);
    expect(gegenstandAusKorrekturSchluessel('correction_house_battery_low_soc_resolved')).toEqual(['haus', 'batterie']);
    expect(gegenstandAusKorrekturSchluessel('#0')).toEqual([]);
  });
  it('Hausbatterie-Korrektur schluckt keine Sensor-Batterien', () => {
    expect(findeVerletzteUnterdrueckungsKorrektur('🔋 Sensor-Batterien kritisch: 3 Sensoren unter 5 %, niedrige Werte bei EMS-Steuerung prüfen', K)).toBeNull();
  });
});

describe('Korrektur-Sperre — echte Hinweise kommen durch', () => {
  for (const [name, text] of [
    ['BMW unverriegelt (Sicherheit)', '**1. [Handlungsbedarf · hoch] BMW unverriegelt**\nBMW steht seit 15:40 unverriegelt zu Hause (Türen/Fenster geschlossen, nicht angesteckt). Vorgang wartet auf deine Bestätigung zum Verriegeln.'],
    ['Claude-API', '1. **Claude-API-Zugang deaktiviert – prüfen.** Laut Anthropic-Mail vom 11.10. um 15:31 wurde dein API-Zugang deaktiviert. Gleichzeitig ist eine Zahlungsbestätigung (Receipt #2399-0609) eingegangen, die zeitlich danach liegt. Ob die Deaktivierung durc'],
    ['Microsoft-Token', '**3. Microsoft-Token-Erneuerung fällig**\nHandlungsbedarf: Token erneuern, die E-Mail-/Dateifehlerquote steht laut Daten bei 50 % bzw. 75 %. Erinnerung steht für 12.10. 09:00 — das ist heute, also zeitnah erledigen.'],
    ['Wallbox (Shelly-Korrektur)', 'Hinweis: Die Wallbox (go-echarger_402636, 192.168.1.175) ist seit 31.08. nicht erreichbar. Das ist ein offener Vorgang mit Frist 16.10., aber keine neue Auffälligkeit.'],
    ['Wallbox (BMW-Korrektur)', '1. **Wallbox nicht erreichbar seit 31.08.** – Die Wallbox go-echarger_402636 (192.168.1.175) ist seit über sechs Wochen offline, die Bestätigungsfrist läuft am 16.10. 21:31 ab. Ladeplanung hängt davon ab – Erreichbarkeit prüfen und Status bestätigen.'],
    ['andere Domains', '**Handlungsbedarf: Domain-Verlängerungen offen.** easyname-Produkte (Frist 13.10.) und nic.at (3051.at, markusdohnal.at, markus-dohnal.at, unterthurm.at; Frist 14.10.) sind nicht als verlängert bestätigt, die zugehörigen Todos sind seit Juni überfäll'],
    ['Skill shell', '2. **Skill „shell“ scheitert bei cwd=/root/alfred** (Fehlerquote 19 Fehler gegenüber 146 Erfolgen in 24 h). Der Runbook-Vorschlag liegt in der Bestätigungs-Queue und sollte bestätigt werden, damit der Umweg dokumentiert ist.'],
    ['Autonomie', '3. **[Handlungsbedarf · niedrig]** Die Autonomie-Akzeptanzrate liegt bei 13 %. Ich empfehle, Aktionen vorerst nur nach Bestätigung auszuführen, damit du die Kontrolle behältst.'],
  ] as const) {
    it(name, () => expect(findeVerletzteUnterdrueckungsKorrektur(text, K)).toBeNull());
  }
});

describe('Korrektur-Sperre — was der Owner korrigiert hat, bleibt unterdrückt', () => {
  it('Hausbatterie bei EMS-Steuerung (Korrektur 11.10.)', () => {
    // Log kürzt auf 250 Zeichen; laut Logzeile (grund „…+niedrige+ems-steuerung") stand „EMS-Steuerung" im vollen Text
    const t = '- **Hausbatterie prüfen:** SoC liegt bei 18 % (unter 20 %), die letzte Vollladung ist 5 Tage her. Laut Nutzerbestätigung wird die Batterie aktuell per EMS in Home Assistant geladen, daher ist der niedrige Wert nur zu beobachten: Sollte der SoC in den … (EMS-Steuerung)';
    expect(findeVerletzteUnterdrueckungsKorrektur(t, K)?.key).toBe('correction_house_battery_low_soc_resolved');
  });
  it('MQTT-Stream (Direkt-Objekt), BMW-Token, pinkribbons, Shelly-Kennung, Sommercamp', () => {
    expect(findeVerletzteUnterdrueckungsKorrektur('🚗 BMW-API/MQTT-Stream seit 2h offline – Datenaktualität gefährdet', K)).not.toBeNull();
    expect(findeVerletzteUnterdrueckungsKorrektur('BMW: Token-Erneuerung nötig — neue Anmeldung erforderlich, Handlungsbedarf', K)?.key).toBe('correction_bmw_api_token_resolved');
    expect(findeVerletzteUnterdrueckungsKorrektur('Domain pinkribbons.club läuft ab — Verlängerung prüfen, alte Aufforderung offen', K)?.key).toBe('correction_pinkribbons_domain_renewal_resolved');
    expect(findeVerletzteUnterdrueckungsKorrektur('Shelly 68C63AFADBA8: Überlast und Überhitzung aktiv, Prüffrist 25.10.', K)?.key).toBe('correction_shelly_68c63afadba8_alert_resolved');
    expect(findeVerletzteUnterdrueckungsKorrektur('Sommercamp für Linus: Anmeldung als Termin eintragen, Handlungsbedarf', K)?.key).toBe('correction_no_sommercamp');
  });
});
