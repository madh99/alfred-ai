import { describe, it, expect } from 'vitest';
import { istPlausiblerPersonenName, istPlausiblerOrgName, istPlausiblerEntitaetsName, KEIN_PERSONEN_MEMORY_KEY, KEIN_ORG_MEMORY_KEY } from '../wissens-schema.js';
import { istVorgangsbezogeneKorrektur, findeVerletzteUnterdrueckungsKorrektur, filtereSegmentMitKorrekturen } from '../reasoning-engine.js';

// v1157 — Realfälle 16.09.: Der Memory→KG-Extraktor legte „Mistral" und
// „Sportverein" (aus organization_*-Memories) als Personen und „Erinnerung
// aktiv seit" als Organisation an; der Frage-Generator fragte danach
// („Wann hat Mistral Geburtstag?"). Das Gate schluckte über das Direkt-Objekt
// „awattar" jede Strompreis-Info und warf Multi-Thema-Sektionen komplett weg.

describe('v1157 Namens-Schema — Personen', () => {
  it('echte Namen passieren (inkl. Titel, Rollen-Präfix, Bindestrich)', () => {
    for (const n of ['Hannah Dohnal', 'Elisabeth', 'Dr. Alfred Steindl', 'Tochter Lena', 'Anna-Maria Huber', 'Noah Habel', 'User']) {
      expect(istPlausiblerPersonenName(n), n).toBe(true);
    }
  });

  it('System-, Gattungs- und Fragment-Namen fallen durch (Realfälle)', () => {
    for (const n of ['Mistral', 'Sportverein', 'Alfred', 'OpenAI', 'Verein', 'madh', 'Shelly_1PM', 'Erinnerung aktiv seit', 'Der', 'Ein Zwei Drei Vier']) {
      expect(istPlausiblerPersonenName(n), n).toBe(false);
    }
  });
});

describe('v1157 Namens-Schema — Organisationen', () => {
  it('echte Organisationen passieren (auch aWATTar/KSV 1919/Mistral)', () => {
    for (const n of ['Axians ICT Austria GmbH', 'aWATTar GmbH', 'KSV 1919', 'SV Altlengbach', 'Mistral', 'go-e GmbH']) {
      expect(istPlausiblerOrgName(n), n).toBe(true);
    }
  });

  it('Satzfragmente fallen durch', () => {
    for (const n of ['Erinnerung aktiv seit', 'Easyname confirmation: Domain', 'wurde gestern bezahlt', 'Termin mit Zahnarzt', 'IT BOLTWISE: News (Sport)']) {
      expect(istPlausiblerOrgName(n), n).toBe(false);
    }
  });

  it('Typ-Dispatch lässt andere Typen unangetastet', () => {
    expect(istPlausiblerEntitaetsName('location', 'Erinnerung aktiv seit')).toBe(true);
    expect(istPlausiblerEntitaetsName('person', 'Mistral')).toBe(false);
  });

  it('Memory-Schlüssel-Zuständigkeit: organization_* nie Person, aktiv_* nie Organisation', () => {
    expect(KEIN_PERSONEN_MEMORY_KEY.test('organization_mistral')).toBe(true);
    expect(KEIN_PERSONEN_MEMORY_KEY.test('organization_sv_altlengbach')).toBe(true);
    expect(KEIN_PERSONEN_MEMORY_KEY.test('child_hannah')).toBe(false);
    expect(KEIN_PERSONEN_MEMORY_KEY.test('friend_bernhard_spouse_name')).toBe(false);
    expect(KEIN_ORG_MEMORY_KEY.test('aktiv_erinnerung_ursula_email_calendar')).toBe(true);
    expect(KEIN_ORG_MEMORY_KEY.test('employment_axians')).toBe(false);
  });
});

describe('v1157 Gate — vorgangsbezogene Korrekturen wirken nicht objektweit', () => {
  const AWATTAR_PAY = { key: 'correction_awattar_payment_resolved', value: 'Die aWATTar-Zahlungskrise (April–Juni 2026, 136,36€) wurde am 19.08.2026 durch Sofortüberweisung vollständig beglichen. Es gibt keine offenen Forderungen mehr. Nicht mehr als Handlungsbedarf melden.' };
  const MQTT = { key: 'unterdruecke_mqtt_stream_fahrzeug', value: 'BMW MQTT: der Stream sendet nur, wenn das Fahrzeug aktiv ist — nicht melden.' };

  it('erkennt Vorgangsbezug an Schlüssel und Wortlaut', () => {
    expect(istVorgangsbezogeneKorrektur(AWATTAR_PAY)).toBe(true);
    expect(istVorgangsbezogeneKorrektur({ key: 'x', value: 'Die Sensorbatterien wurden ausgetauscht. Nicht mehr melden.' })).toBe(true);
    expect(istVorgangsbezogeneKorrektur(MQTT)).toBe(false);
  });

  it('Strompreis-Info wird NICHT mehr von der Zahlungs-Korrektur verschluckt (Realfall 14.09.)', () => {
    const strompreis = '### 5. Energiepreise & Wallbox-Optimierung\nAktueller Strompreis (04:00–05:00): 35,72 ct/kWh (EPEX 18,38 ct + aWATTar-Aufschlag). Wallbox läuft im PV-Überschussmodus.';
    expect(findeVerletzteUnterdrueckungsKorrektur(strompreis, [AWATTAR_PAY])).toBeNull();
  });

  it('eine echte Mahnungs-Meldung zum selben Vorgang bleibt geblockt', () => {
    const mahnung = '🔴 aWATTar-Zahlungskrise: offene Forderungen aus April–Juni, Sofortüberweisung prüfen';
    expect(findeVerletzteUnterdrueckungsKorrektur(mahnung, [AWATTAR_PAY])).not.toBeNull();
  });

  it('Geräte-Korrekturen (MQTT) wirken weiter objektweit', () => {
    expect(findeVerletzteUnterdrueckungsKorrektur('BMW SoC 40% – MQTT seit 3h keine Daten', [MQTT])?.grund).toBe('direkt-objekt:mqtt');
  });
});

describe('v1157 Gate — feinkörnig je Bullet', () => {
  const ELTERN = { key: 'correction_elternaufsicht_linus_resolved', value: 'Die Elternaufsicht für Linus\' Google-Konto wurde bewusst deaktiviert — ist erledigt, nicht mehr als Handlungsbedarf melden.' };
  const sektion = [
    '### 2. Hoher Handlungsbedarf: Projekt-Blockade & Sicherheit',
    '- Projekt fussball-cc hat 30 überfällige Todos (FWC-11 Root-Cause-Analyse, Git-Verifikationen).',
    '- Elternaufsicht für Linus\' Google-Konto deaktiviert – 21 Apps installiert, Sicherheit prüfen.',
    '  Details: E-Mail von Google vom 29.08.',
    '- Domain pinkribbons.club läuft am 05.09. ab – Verlängerung einleiten.',
  ].join('\n');

  it('entfernt nur den getroffenen Bullet, der Rest der Sektion bleibt (Realfall 14.09.)', () => {
    const { text, entfernt } = filtereSegmentMitKorrekturen(sektion, [ELTERN]);
    expect(entfernt).toHaveLength(1);
    expect(entfernt[0].treffer.key).toBe('correction_elternaufsicht_linus_resolved');
    expect(text).toContain('30 überfällige Todos');
    expect(text).toContain('pinkribbons.club');
    expect(text).not.toContain('Elternaufsicht');
    expect(text).not.toContain('Details: E-Mail von Google');
  });

  it('Kopfzeilen-Treffer wirft die ganze Sektion; ohne verbleibende Bullets ebenso', () => {
    const kopf = '### Elternaufsicht Linus Google-Konto\n- Punkt A\n- Punkt B';
    expect(filtereSegmentMitKorrekturen(kopf, [ELTERN]).text).toBeNull();
    const nurTreffer = '### Sicherheit\n- Elternaufsicht Linus Google-Konto deaktiviert\n- Elternaufsicht Google-Konto: 21 Apps';
    expect(filtereSegmentMitKorrekturen(nurTreffer, [ELTERN]).text).toBeNull();
  });

  it('Segmente ohne ≥2 Bullets bleiben unverändert (Ganzsegment-Gate zuständig)', () => {
    const einzel = '📱 Elternaufsicht Linus Google-Konto deaktiviert – prüfen';
    expect(filtereSegmentMitKorrekturen(einzel, [ELTERN]).text).toBe(einzel);
  });
});
