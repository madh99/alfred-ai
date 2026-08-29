import { describe, it, expect } from 'vitest';
import { istInhaltlichesInsightDuplikat } from '../reasoning-engine.js';
import { beschreibungsAehnlichkeit, istGleicheConfirmationsIdentitaet } from '../confirmation-queue.js';
import { QuellenSchalter } from '../reasoning-context-collector.js';
import { istVorKonsolidierungGeschuetzt, waehleMergeKey } from '../active-learning/memory-consolidator.js';
import { findeAehnlichenPatternKey } from '../active-learning/pattern-analyzer.js';

// v1142 — Regressionstests gegen die Realfälle aus Audit Teil 2 (29.08.2026):
// Dedup-/Lern-Identität darf NIE aus LLM-Wortlaut allein abgeleitet werden.

describe('H1 — Wallbox-Test: inhaltlicher Zustell-Dedup', () => {
  const geliefert = [
    '🔌 Wallbox im PV-Überschussmodus – aktuell kein Ladevorgang',
    '🔋 LOW: ESS-Batterie Mindest-SoC (15%) konfiguriert – aktueller SoC nicht kritisch',
  ];

  it('Realfall: umformulierte Wallbox-Meldung wird als Duplikat erkannt', () => {
    expect(istInhaltlichesInsightDuplikat(
      '🔌 Wallbox: PV-Überschussmodus aktiv (16A/1 Phase) – Kein Ladevorgang gestartet', geliefert)).toBe(true);
    expect(istInhaltlichesInsightDuplikat(
      'Wallbox im PV-Überschuss-Modus, aber kein Ladevorgang aktiv', geliefert)).toBe(true);
  });

  it('ECHTE neue Meldung zum selben Objekt bleibt durch', () => {
    expect(istInhaltlichesInsightDuplikat(
      '🔌 Wallbox: Firmware-Update 2.4 verfügbar — Changelog prüfen', geliefert)).toBe(false);
  });

  it('fremdes Thema bleibt durch', () => {
    expect(istInhaltlichesInsightDuplikat(
      '📅 Termin morgen 09:00: Zahnarzt — Anfahrt 25 Minuten', geliefert)).toBe(false);
  });
});

describe('H2 — BMW-Test: Confirmation-Identität statt Wortgleichheit', () => {
  it('Realfall: die 25 BMW-Token-Varianten sind EINE Identität', () => {
    const varianten = [
      'BMW API-Token erneuern (OAuth-Flow starten).',
      'BMW API-Token erneuern (OAuth-Flow starten)',
      'BMW-API-Token erneuern (OAuth-Flow starten).',
      'BMW API-Token erneuern (OAuth-Flow starten), um Echtzeitdaten wiederherzustellen',
    ];
    for (let i = 1; i < varianten.length; i++) {
      expect(istGleicheConfirmationsIdentitaet(
        { description: varianten[0], skillName: 'bmw', skillParams: { action: 'reauth' } },
        { description: varianten[i], skillName: 'bmw', skillParams: { action: 'reauth' } },
      ), varianten[i]).toBe(true);
    }
  });

  it('verschiedene ITSM-Incidents bleiben verschieden (Titel-Signal)', () => {
    expect(istGleicheConfirmationsIdentitaet(
      { description: 'Incident anlegen', skillName: 'itsm', skillParams: { action: 'create_incident', title: 'UniFi IPS-Alert-Flut' } },
      { description: 'Incident anlegen', skillName: 'itsm', skillParams: { action: 'create_incident', title: 'MikroTik Interfaces down' } },
    )).toBe(false);
  });

  it('beschreibungsAehnlichkeit: unähnliche Texte bleiben unter der Schwelle', () => {
    expect(beschreibungsAehnlichkeit(
      'BMW API-Token erneuern (OAuth-Flow starten).',
      'Wallbox-Ladefenster für BMW i4 aktivieren (Ziel-SoC: 70%)',
    )).toBeLessThan(0.6);
  });
});

describe('H5 — Circuit-Breaker: tote Quellen pausieren', () => {
  it('12 Fehlschläge in Folge → pausiert; Pausenbeginn wird genau einmal gemeldet', () => {
    const s = new QuellenSchalter(12, 1_000_000);
    for (let i = 1; i <= 11; i++) expect(s.fehlschlag('bmw')).toBe(false);
    expect(s.istPausiert('bmw')).toBe(false);
    expect(s.fehlschlag('bmw')).toBe(true); // 12. → Pause beginnt
    expect(s.istPausiert('bmw')).toBe(true);
    expect(s.fehlschlag('bmw')).toBe(false); // weitere melden nicht erneut
  });

  it('Erfolg setzt die Quelle vollständig zurück', () => {
    const s = new QuellenSchalter(3, 1_000_000);
    s.fehlschlag('x'); s.fehlschlag('x');
    s.erfolg('x');
    expect(s.fehlversuche('x')).toBe(0);
    expect(s.istPausiert('x')).toBe(false);
  });

  it('half-open: nach Pausen-Ablauf genau ein Probe-Versuch', () => {
    const s = new QuellenSchalter(2, -1); // Pause sofort abgelaufen
    s.fehlschlag('y'); s.fehlschlag('y');
    expect(s.istPausiert('y')).toBe(false); // Probe erlaubt (verschiebt pauseBis)
    s.fehlschlag('y');
    expect(s.fehlversuche('y')).toBe(3);
  });

  it('andere Quellen bleiben unberührt', () => {
    const s = new QuellenSchalter(2, 1_000_000);
    s.fehlschlag('a'); s.fehlschlag('a');
    expect(s.istPausiert('a')).toBe(true);
    expect(s.istPausiert('b')).toBe(false);
  });
});

describe('H3 — Consolidator-Schutz + deterministischer Merge-Key', () => {
  it('Realfall kg_connection_*: interne Keys sind vor Konsolidierung geschützt', () => {
    expect(istVorKonsolidierungGeschuetzt({ type: 'general', source: 'auto', key: 'kg_connection_wien' })).toBe(true);
    expect(istVorKonsolidierungGeschuetzt({ type: 'feedback', source: 'auto', key: 'insight_delivered:wallbox_ladung' })).toBe(true);
  });

  it('relationship/pattern/manual sind geschützt, freie general-Memories nicht', () => {
    expect(istVorKonsolidierungGeschuetzt({ type: 'relationship', source: 'auto', key: 'child_noah' })).toBe(true);
    expect(istVorKonsolidierungGeschuetzt({ type: 'pattern', source: 'auto', key: 'abends_aktiv' })).toBe(true);
    expect(istVorKonsolidierungGeschuetzt({ type: 'general', source: 'manual', key: 'notiz' })).toBe(true);
    expect(istVorKonsolidierungGeschuetzt({ type: 'general', source: 'auto', key: 'urlaubsplanung_sommer' })).toBe(false);
  });

  it('Merge-Key kommt deterministisch aus der Gruppe (höchste Confidence, dann jüngstes Update)', () => {
    const g = [
      { key: 'alt_key', confidence: 0.6, updatedAt: '2026-08-01', category: 'a' },
      { key: 'gewinner_key', confidence: 0.9, updatedAt: '2026-07-01', category: 'b' },
      { key: 'mittel_key', confidence: 0.9, updatedAt: '2026-06-01', category: 'c' },
    ];
    expect(waehleMergeKey(g)).toEqual({ key: 'gewinner_key', category: 'b' });
  });
});

describe('H4 — Pattern-Dedup: gleiche Aussage aktualisiert den bestehenden Key', () => {
  const bestehend = [
    { key: 'pattern_email_dominant', value: 'E-Mail ist mit 210 von 370 Aufrufen der dominierende Kommunikationskanal' },
    { key: 'pattern_abends_aktiv', value: 'User ist hauptsächlich abends aktiv (18-23 Uhr)' },
  ];

  it('Realfall: die E-Mail-Varianten matchen auf den bestehenden Key', () => {
    expect(findeAehnlichenPatternKey(bestehend, 'pattern_email_zentriert', 'Der User nutzt den AI-Assistenten E-Mail-zentriert — E-Mail ist der dominierende Kommunikationskanal'))
      .toBe('pattern_email_dominant');
    expect(findeAehnlichenPatternKey(bestehend, 'pattern_email_primary_comm', 'E-Mail ist der primäre Kommunikationskanal des Users'))
      .toBe('pattern_email_dominant');
  });

  it('neues Muster bleibt neu', () => {
    expect(findeAehnlichenPatternKey(bestehend, 'pattern_crypto_interesse', 'User verfolgt Kryptokurse mehrmals täglich (BTC, ETH)'))
      .toBe(null);
  });
});
