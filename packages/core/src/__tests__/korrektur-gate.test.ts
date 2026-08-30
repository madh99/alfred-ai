import { describe, it, expect } from 'vitest';
import { istUnterdrueckungsAussage, kernwoerterAusKorrektur, verletztUnterdrueckungsKorrektur, findeVerletzteUnterdrueckungsKorrektur, annotiereKontextMitKorrekturen } from '../reasoning-engine.js';

// v1148 — Korrektur-Durchsetzung. Realfall: „BMW MQTT offline" wurde immer
// wieder gemeldet, obwohl der User MEHRFACH erklärt hatte, dass der Stream nur
// bei aktivem Fahrzeug sendet. Korrekturen sind ab jetzt ein HARTES Gate.

const MQTT_KORREKTUR = 'BMW MQTT/API-Datenalter ist kein Fehler: der MQTT-Stream sendet nur, wenn das Fahrzeug aktiv ist. Veraltete SoC-/Reichweiten-Daten bei stehendem Fahrzeug sind normal — nicht melden, nicht warnen.';

describe('istUnterdrueckungsAussage', () => {
  it('erkennt die typischen User-Formulierungen', () => {
    expect(istUnterdrueckungsAussage('mqtt sendet nur wenn das fahrzeug aktiv ist')).toBe(true);
    expect(istUnterdrueckungsAussage('das ist normal, bitte nicht mehr melden')).toBe(true);
    expect(istUnterdrueckungsAussage('Falschalarm — die Batterien wurden getauscht')).toBe(true);
    expect(istUnterdrueckungsAussage('kein Fehler, der Wert ist der konfigurierte Mindest-SoC')).toBe(true);
  });

  it('normale Aussagen lösen nicht aus', () => {
    expect(istUnterdrueckungsAussage('wie ist der SoC vom BMW?')).toBe(false);
    expect(istUnterdrueckungsAussage('lege bitte eine Erinnerung für morgen an')).toBe(false);
  });
});

describe('verletztUnterdrueckungsKorrektur — MQTT-Realfall', () => {
  const realeInsights = [
    '🔌 BMW i4: SoC 24% (85 km Reichweite) – API/MQTT seit 1h offline → JETZT handeln',
    '🚗 BMW-API/MQTT-Stream seit 2h offline – Datenaktualität gefährdet',
    '⚠️ HIGH: BMW API/MQTT-Stream seit 1–10h nicht erreichbar (SoC-Daten veraltet)',
    '🔴 CRITICAL: BMW API/MQTT-Stream seit 2–12h offline – Echtzeitdaten fehlen',
  ];

  it('unterdrückt JEDE der real gesendeten MQTT-Varianten', () => {
    for (const insight of realeInsights) {
      expect(verletztUnterdrueckungsKorrektur(insight, [MQTT_KORREKTUR]), insight).toBe(true);
    }
  });

  it('unterdrückt KEINE fremden Meldungen', () => {
    expect(verletztUnterdrueckungsKorrektur('📅 Termin morgen 09:00: Zahnarzt', [MQTT_KORREKTUR])).toBe(false);
    expect(verletztUnterdrueckungsKorrektur('🔋 Sensor-Batterien kritisch: 3 Sensoren unter 5%', [MQTT_KORREKTUR])).toBe(false);
  });
});

describe('verletztUnterdrueckungsKorrektur — Präzision', () => {
  it('ESS-Realfall: Mindest-SoC-Korrektur unterdrückt die Mindest-SoC-Fehlmeldung', () => {
    const essKorrektur = 'Der Wert 15 % bei der ESS-Batterie ist der konfigurierte Mindest-SoC (Minimum SoC), kein Fehler — nicht als kritisch melden.';
    expect(verletztUnterdrueckungsKorrektur('🔋 LOW: ESS-Batterie Mindest-SoC (15%) konfiguriert – SoC kritisch?', [essKorrektur])).toBe(true);
  });

  it('False-Positive-Schutz: Handy-Batterie-Korrektur verschluckt keine Sensor-Batterie-Warnung', () => {
    const handyKorrektur = 'Das Handy SM-S928B wird geladen. Nicht mehr als kritischen Batteriestand melden.';
    expect(verletztUnterdrueckungsKorrektur('🔋 Sensor-Batterien kritisch: 3 Sensoren unter 5%', [handyKorrektur])).toBe(false);
    expect(verletztUnterdrueckungsKorrektur('📱 SM-S928B Batteriestand kritisch (8%)', [handyKorrektur])).toBe(true);
  });

  it('Nicht-Unterdrückungs-Korrekturen (Skill-Action-Fixes) unterdrücken nichts', () => {
    const skillKorrektur = 'Skill proxmox: Action "get_node_stats" existiert nicht — verwende stattdessen "node_status".';
    expect(verletztUnterdrueckungsKorrektur('🖥 Proxmox git-server RAM kritisch (92%)', [skillKorrektur])).toBe(false);
  });

  it('kernwoerterAusKorrektur filtert Füllwörter', () => {
    const kern = kernwoerterAusKorrektur(MQTT_KORREKTUR);
    expect(kern).toContain('mqtt-stream');
    expect(kern).not.toContain('nicht');
    expect(kern).not.toContain('wenn');
  });
});

// v1149 — Realfall 30.08.: Die ESS-Korrektur enthielt „aktuelle" UND „aktuellen";
// zwei Beugungen zählten als 2 Treffer + „spezifisch" → JEDER Text mit
// „…aktuellen…" wurde geblockt (52 Unterdrückungen in einer Nacht, inkl.
// Kopfzeilen wie „basierend auf den aktuellen Daten").
describe('v1149 — Stamm-Dedupe gegen Beugungs-Doppelzählung', () => {
  const ESS_REAL = 'Der Wert 15 % bei der ESS-Batterie ist der konfigurierte Mindest-SoC (Minimum SoC), nicht der aktuelle Batterie-Ladezustand. 15 % daher nicht als kritischen aktuellen SoC oder Batteriealarm melden. Für den aktuellen SoC ausschließlich den tatsächlichen SoC-Sensor verwenden.';

  it('Kopfzeile mit „aktuellen Daten" wird NICHT geblockt', () => {
    expect(verletztUnterdrueckungsKorrektur('Hier sind die priorisierten Insights basierend auf den aktuellen Daten:', [ESS_REAL])).toBe(false);
  });

  it('der echte ESS-Fall wird weiter geblockt', () => {
    expect(verletztUnterdrueckungsKorrektur('🔋 LOW: ESS-Batterie Mindest-SoC (15%) konfiguriert – SoC kritisch?', [ESS_REAL])).toBe(true);
  });

  it('fremde Meldung mit Allerweltsworten wird nicht verschluckt', () => {
    const AWATTAR_PAY = 'Die aWATTar-Zahlungskrise (April–Juni 2026, 136,36€) wurde am 19.08.2026 durch Sofortüberweisung vollständig beglichen. Es gibt keine offenen Forderungen mehr. Nicht mehr als Handlungsbedarf melden.';
    expect(verletztUnterdrueckungsKorrektur('🔴 5 kritische ITSM-Incidents + 22 offene Tickets – kein direkter Handlungsbedarf', [AWATTAR_PAY])).toBe(false);
  });

  it('Geräte-Kennung (SM-S928B) wirkt objektweit — ein Treffer genügt', () => {
    const HANDY_REAL = 'Das Handy SM-S928B wird am 16.08.2026 geladen. Nicht mehr als kritischen Batterie-Handlungsbedarf melden.';
    expect(verletztUnterdrueckungsKorrektur('📱 SM-S928B: Akku bei 8% – laden empfohlen', [HANDY_REAL])).toBe(true);
    expect(verletztUnterdrueckungsKorrektur('🔋 Sensor-Batterien kritisch: 3 Sensoren unter 5%', [HANDY_REAL])).toBe(false);
  });
});

// v1150 — beweisbare Logs: der Finder nennt Korrektur-Key und Grund, damit jede
// Unterdrückung im Log einer konkreten Korrektur zuordenbar ist (30.08.: zwei
// Blocks waren mangels Key/Volltext nicht zuordenbar).
describe('v1150 — findeVerletzteUnterdrueckungsKorrektur', () => {
  it('liefert Key und Grund des Treffers', () => {
    const t = findeVerletzteUnterdrueckungsKorrektur(
      '🚗 BMW API/MQTT-Stream seit 6h offline',
      [{ key: 'unterdruecke_mqtt_stream_fahrzeug', value: 'BMW MQTT: der Stream sendet nur, wenn das Fahrzeug aktiv ist — nicht melden.' }],
    );
    expect(t).not.toBeNull();
    expect(t!.key).toBe('unterdruecke_mqtt_stream_fahrzeug');
    expect(t!.grund).toBe('direkt-objekt:mqtt');
  });

  it('liefert null, wenn nichts greift', () => {
    expect(findeVerletzteUnterdrueckungsKorrektur('📅 Termin morgen 09:00: Zahnarzt',
      [{ key: 'x', value: 'MQTT sendet nur bei aktivem Fahrzeug — nicht melden.' }])).toBeNull();
  });
});

// v1152 — Anker-Regel: Kernwörter-Blocks brauchen ein Fach-Objekt (Geräte-Kennung,
// Bindestrich- oder langes Kompositum). Realfälle 30.08. nach .1151-Deploy: das
// Gate verschluckte 4× die echte Domain-Ablauf-Frist (Match `2026+werden`), einen
// kritischen MikroTik-Incident (`kein+bestätigt`) und eine Wallbox-Warnung
// (`kein+fahrzeug+aktiv`) — lauter Allerwelts-Wortpaare ohne Fach-Objekt.
describe('v1152 — Fach-Anker-Regel', () => {
  const SOMMERCAMP = 'Es gibt aktuell KEIN Sommercamp für Linus. Wenn künftig eines geplant wird, steht es ausdrücklich im Kalender bzw. wird neu bestätigt. Nicht mehr als Termin oder Handlungsbedarf melden.';
  const AWATTAR_PAY = 'Die aWATTar-Zahlungskrise (April–Juni 2026, 136,36€) wurde am 19.08.2026 durch Sofortüberweisung vollständig beglichen. Es gibt keine offenen Forderungen mehr. Nicht mehr als Handlungsbedarf melden.';

  it('Domain-Ablauf-Frist wird NICHT von der aWATTar-Zahlungs-Korrektur verschluckt', () => {
    expect(verletztUnterdrueckungsKorrektur(
      '🔴 Domain pinkribbons.club läuft am Fr 04.09.2026 ab – Verlängerung muss bis 31.08.2026 durchgeführt werden',
      [AWATTAR_PAY])).toBe(false);
  });

  it('MikroTik-Incident und Wallbox-Warnung werden NICHT von fremden Korrekturen verschluckt', () => {
    expect(verletztUnterdrueckungsKorrektur(
      '⚠️ MikroTik: 4 Interfaces down (kritischer Infrastruktur-Status) – kein aktiver Bond bestätigt',
      [SOMMERCAMP])).toBe(false);
    expect(verletztUnterdrueckungsKorrektur(
      '🔌 Wallbox läuft im PV-Überschussmodus (16A) – aber kein Auto angeschlossen, Fahrzeug nicht aktiv',
      [MQTT_KORREKTUR])).toBe(false);
  });

  it('echte Fach-Objekt-Treffer blocken weiter (Sommercamp-Insight vs. Sommercamp-Korrektur)', () => {
    expect(verletztUnterdrueckungsKorrektur(
      '📅 Sommercamp für Linus: Anmeldung prüfen – Termin im Kalender geplant?',
      [SOMMERCAMP])).toBe(true);
  });
});

// v1151 — Korrektur-Anwendung an der QUELLE: Die Deutung wird direkt an die
// Datenzeile geheftet, damit der falsche Insight gar nicht erst entsteht
// (der entfernte „ABSOLUTER VORRANG"-Block wurde nachweislich ignoriert).
describe('v1151 — annotiereKontextMitKorrekturen', () => {
  const KORREKTUREN = [
    { key: 'unterdruecke_mqtt_stream_fahrzeug', value: MQTT_KORREKTUR },
    { key: 'correction_sm_s928b_battery_resolved', value: 'Das Handy SM-S928B wird geladen. Nicht mehr als kritischen Batteriestand melden.' },
  ];

  it('heftet die Deutung direkt an die getroffene Datenzeile', () => {
    const ctx = { sections: [{ key: 'vehicle', label: 'Fahrzeug', content: 'BMW i4: SoC 44%\nMQTT-Stream: seit 6h keine Daten' }] };
    const getroffen = annotiereKontextMitKorrekturen(ctx, KORREKTUREN);
    expect(getroffen).toContain('unterdruecke_mqtt_stream_fahrzeug');
    const zeilen = ctx.sections[0].content.split('\n');
    expect(zeilen[2]).toContain('↳ NORMAL laut User-Korrektur [unterdruecke_mqtt_stream_fahrzeug]');
    expect(zeilen[2]).toContain('NICHT als Problem/Insight melden');
  });

  it('lässt fremde Sektionen und die memories-Sektion unangetastet', () => {
    const kalender = 'Mo 09:00 Zahnarzt\nDi 14:00 Meeting';
    const memories = '- [correction] MQTT sendet nur bei aktivem Fahrzeug';
    const ctx = { sections: [
      { key: 'calendar', label: 'Kalender', content: kalender },
      { key: 'memories', label: 'Memories', content: memories },
    ] };
    annotiereKontextMitKorrekturen(ctx, KORREKTUREN);
    expect(ctx.sections[0].content).toBe(kalender);
    expect(ctx.sections[1].content).toBe(memories);
  });

  it('Sektions-Fußnote, wenn die Kernwörter über mehrere Zeilen verteilt sind', () => {
    const ctx = { sections: [{ key: 'smarthome', label: 'Smart Home', content: 'Handy SM-S928B: 8%\nLadegerät verbunden' }] };
    const getroffen = annotiereKontextMitKorrekturen(ctx, KORREKTUREN);
    expect(getroffen).toContain('correction_sm_s928b_battery_resolved');
    expect(ctx.sections[0].content).toContain('[correction_sm_s928b_battery_resolved]');
  });

  it('annotiert idempotent nur einmal je Korrektur und Sektion', () => {
    const ctx = { sections: [{ key: 'vehicle', label: 'Fahrzeug', content: 'MQTT offline\nMQTT weiterhin offline' }] };
    annotiereKontextMitKorrekturen(ctx, KORREKTUREN);
    annotiereKontextMitKorrekturen(ctx, KORREKTUREN);
    const marker = ctx.sections[0].content.split('↳ NORMAL laut User-Korrektur').length - 1;
    expect(marker).toBe(1);
  });
});
