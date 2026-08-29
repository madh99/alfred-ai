import { describe, it, expect } from 'vitest';
import { istUnterdrueckungsAussage, kernwoerterAusKorrektur, verletztUnterdrueckungsKorrektur } from '../reasoning-engine.js';

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
