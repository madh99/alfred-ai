import { describe, it, expect } from 'vitest';
import { istDurchKorrekturWiderlegt, bewerteStaleKandidat, staleAnfrageDatum, STALE_ANFRAGE_MARKER } from '../itsm-hygiene.js';

// v1153 — ITSM-Hygiene. Realfall 30.08.: 31 offene Incidents, alle 120+ Tage
// alt, 25 davon user_report ohne jeden Lifecycle; darunter Incidents, die der
// User längst per Korrektur widerlegt hatte (ESS 15% = Mindest-SoC).

const TAG = 86_400_000;
const JETZT = Date.parse('2026-08-30T12:00:00Z');

function inc(overrides: Partial<Parameters<typeof bewerteStaleKandidat>[0]> = {}) {
  return {
    id: 'i1', title: 'Testincident', status: 'open', detectedBy: 'user_report',
    updatedAt: new Date(JETZT - 30 * TAG).toISOString(), investigationNotes: undefined,
    ...overrides,
  };
}

describe('istDurchKorrekturWiderlegt — C (Realfall ESS 15%)', () => {
  const ESS = { key: 'correction_ess_minimum_soc_not_current_soc', value: 'Der Wert 15 % bei der ESS-Batterie ist der konfigurierte Mindest-SoC (Minimum SoC), nicht der aktuelle Batterie-Ladezustand. 15 % daher nicht als kritischen aktuellen SoC oder Batteriealarm melden.' };

  it('Incident mit gemeinsamem Fach-Vokabular wird als widerlegt erkannt', () => {
    const t = istDurchKorrekturWiderlegt(
      { title: 'ESS-Batterie: Mindest-SoC 15% erreicht', description: 'Batteriealarm — SoC kritisch?' },
      [ESS],
    );
    expect(t).not.toBeNull();
    expect(t!.key).toBe('correction_ess_minimum_soc_not_current_soc');
  });

  it('MQTT-Incident wird über das Direkt-Objekt widerlegt', () => {
    const MQTT = { key: 'unterdruecke_mqtt_stream_fahrzeug', value: 'BMW MQTT: der Stream sendet nur, wenn das Fahrzeug aktiv ist — nicht melden.' };
    const t = istDurchKorrekturWiderlegt(
      { title: 'BMW API/MQTT-Stream seit 6h offline', description: 'Datenaktualität gefährdet' },
      [MQTT],
    );
    expect(t?.grund).toBe('direkt-objekt:mqtt');
  });

  it('englischer Monitor-Titel OHNE gemeinsames Fach-Wort bleibt bewusst unberührt (konservativ)', () => {
    expect(istDurchKorrekturWiderlegt(
      { title: 'homeassistant: Low battery: settings ess batterylife soclimit at 15%' },
      [ESS],
    )).toBeNull();
  });

  it('ein fremder Incident bleibt unberührt', () => {
    expect(istDurchKorrekturWiderlegt(
      { title: 'git-server RAM-Auslastung kritisch', description: 'proxmox: RAM 95%' },
      [ESS],
    )).toBeNull();
  });
});

describe('bewerteStaleKandidat — B', () => {
  it('user_report ohne Update seit ≥21 Tagen → fragen', () => {
    expect(bewerteStaleKandidat(inc(), JETZT)).toBe('fragen');
  });

  it('frischer Incident → null', () => {
    expect(bewerteStaleKandidat(inc({ updatedAt: new Date(JETZT - 5 * TAG).toISOString() }), JETZT)).toBeNull();
  });

  it('monitor-Incidents sind ausgenommen (eigenes Auto-Recovery)', () => {
    expect(bewerteStaleKandidat(inc({ detectedBy: 'monitor' }), JETZT)).toBeNull();
  });

  it('Rückfrage gestellt, Frist läuft → null; Frist abgelaufen → resolven', () => {
    const frisch = inc({ investigationNotes: `${STALE_ANFRAGE_MARKER}2026-08-25]` });
    expect(bewerteStaleKandidat(frisch, JETZT)).toBeNull();
    const abgelaufen = inc({ investigationNotes: `Notizen\n${STALE_ANFRAGE_MARKER}2026-08-10]` });
    expect(bewerteStaleKandidat(abgelaufen, JETZT)).toBe('resolven');
  });

  it('resolved/closed werden nie angefasst', () => {
    expect(bewerteStaleKandidat(inc({ status: 'resolved' }), JETZT)).toBeNull();
  });
});

describe('staleAnfrageDatum', () => {
  it('parst den Marker aus investigation_notes', () => {
    expect(staleAnfrageDatum(`RCA läuft\n${STALE_ANFRAGE_MARKER}2026-08-15]`)).toBe('2026-08-15');
    expect(staleAnfrageDatum('keine Marker')).toBeNull();
    expect(staleAnfrageDatum(undefined)).toBeNull();
  });
});
