import { describe, it, expect } from 'vitest';
import {
  homeFlagsForCity, istMomentzustandsName, istDateiFragmentName,
  istUngueltigeEntitaet, waehleKanonischesZuhause, istVerlaesslichePerson,
  INTERNAL_MEMORY_KEY_PREFIXES,
} from '../knowledge-graph.js';
import { bereinigeKorrekturAttribute } from '../llm-entity-linker.js';

// v1141 — Regressionstests gegen die dokumentierten Wissens-Korruptions-Realfälle
// (Analyse 29.08.2026). Jeder describe-Block bindet einen konkreten Vorfall.

describe('Wien-Test — homeFlagsForCity (satz-genau statt Key-pauschal)', () => {
  const key = 'home_location_altlengbach';
  const value = 'Altlengbach ist der Wohnort des Users. Wien (Gugelgasse 15, 1110 Wien) ist die Büroadresse, nicht der Wohnort.';

  it('Realfall: Altlengbach bekommt die Flags, Wien NICHT (Negation im eigenen Satz)', () => {
    expect(homeFlagsForCity(key, value, 'Altlengbach', 2)).toEqual({ isHome: true, isUserHome: true });
    expect(homeFlagsForCity(key, value, 'Wien', 2)).toEqual({});
  });

  it('reines Adress-Memory ohne Wohn-Wort: Key-Stempel nur bei genau EINER Stadt', () => {
    expect(homeFlagsForCity('heim_adresse', '3033 Altlengbach', 'Altlengbach', 1)).toEqual({ isHome: true, isUserHome: true });
    expect(homeFlagsForCity('heim_adresse', '3033 Altlengbach und 1110 Wien', 'Wien', 2)).toEqual({});
  });

  it('Fremdpersonen-Marker im Key oder Satz verhindert die Flags', () => {
    expect(homeFlagsForCity('home_mutter', 'Eichgraben', 'Eichgraben', 1)).toEqual({});
    expect(homeFlagsForCity('home_info', 'Die Mutter wohnt in Eichgraben. Der User wohnt in Altlengbach.', 'Eichgraben', 2)).toEqual({});
    expect(homeFlagsForCity('home_info', 'Die Mutter wohnt in Eichgraben. Der User wohnt in Altlengbach.', 'Altlengbach', 2)).toEqual({ isHome: true, isUserHome: true });
  });
});

describe('BOLTWISE-Test — INTERNAL_MEMORY_KEY_PREFIXES deckt alle internen Key-Formen', () => {
  it('interne Keys werden erkannt (News-Zustellung, Skill-Regeln, Eskalationen, Migrationen)', () => {
    for (const k of [
      'insight_delivered:boltwise_techaktien_tr',
      'rule_skill_homeassistant_8861bab51df9',
      'open_item_escalated:xyz',
      '_alfred_internal_migration_v582_dates_done',
      'pattern_email_zentriert',
      'kg_connection_kapfenberg_bmw',
    ]) {
      expect(INTERNAL_MEMORY_KEY_PREFIXES.test(k), k).toBe(true);
    }
  });

  it('echte User-Memory-Keys bleiben durch', () => {
    for (const k of ['child_noah', 'home_location_altlengbach', 'spouse_alex', 'employment_axians']) {
      expect(INTERNAL_MEMORY_KEY_PREFIXES.test(k), k).toBe(false);
    }
  });
});

describe('Momentzustands-Test — HA-Zustände sind keine Dinge', () => {
  it('Realfälle werden erkannt', () => {
    expect(istMomentzustandsName('Geschirrspüler läuft')).toBe(true);
    expect(istMomentzustandsName('Pool Stillstandslauf aktiv')).toBe(true);
    expect(istMomentzustandsName('EMS Boden: Empfehlung übernehmen')).toBe(true);
  });

  it('echte Gerätenamen bleiben erlaubt', () => {
    expect(istMomentzustandsName('SubSwitch8_Wohnzimmer LED')).toBe(false);
    expect(istMomentzustandsName('Wallbox')).toBe(false);
    expect(istMomentzustandsName('Auto-Aus Eingang')).toBe(false);
  });
});

describe('CV-Datei-Test — Datei-/Fragment-Namen sind keine Entitäten', () => {
  it('Realfall und Datei-Endungen werden erkannt', () => {
    expect(istDateiFragmentName('Markus_Dohnal_CV_aktuelle_')).toBe(true);
    expect(istDateiFragmentName('lebenslauf.pdf')).toBe(true);
    expect(istDateiFragmentName('connection_wallbox_config_export_v2')).toBe(true);
  });

  it('normale Namen mit einzelnem Unterstrich bleiben erlaubt', () => {
    expect(istDateiFragmentName('AP_Garage LED')).toBe(false);
    expect(istDateiFragmentName('U7-Pro')).toBe(false);
    expect(istDateiFragmentName('Maria Dohnal')).toBe(false);
  });
});

describe('Altand-Test — selbst-diagnostizierter Müll fliegt raus', () => {
  it('is_typo/is_valid-Marker werden erkannt', () => {
    expect(istUngueltigeEntitaet({ is_typo: true, alias: ['Alland'] })).toBe(true);
    expect(istUngueltigeEntitaet({ is_valid: false })).toBe(true);
  });

  it('normale Attribute lösen nicht aus', () => {
    expect(istUngueltigeEntitaet({ city: 'Altlengbach' })).toBe(false);
    expect(istUngueltigeEntitaet(undefined)).toBe(false);
  });
});

describe('Zuhause-Wahl — nur isUserHome, deterministischer Tie-Break, kein Fallback', () => {
  const loc = (name: string, attrs: Record<string, unknown>, seen = '2026-04-01T07:18:19') =>
    ({ name, firstSeenAt: seen, attributes: attrs });

  it('isHome-only-Orte (Büro Wien) werden NIE gewählt — lieber kein Zuhause als ein falsches', () => {
    expect(waehleKanonischesZuhause([loc('Wien', { isHome: true, isWork: true })])).toBeUndefined();
  });

  it('Realfall sekundengleicher Zeitstempel: Name entscheidet deterministisch', () => {
    const altlengbach = loc('Altlengbach', { isUserHome: true });
    const wien = loc('Wien', { isUserHome: true });
    expect(waehleKanonischesZuhause([wien, altlengbach])?.name).toBe('Altlengbach');
    expect(waehleKanonischesZuhause([altlengbach, wien])?.name).toBe('Altlengbach');
  });

  it('früherer firstSeenAt gewinnt vor dem Namen', () => {
    const spaeter = loc('Aaa', { isUserHome: true }, '2026-05-01T00:00:00');
    const frueher = loc('Zzz', { isUserHome: true }, '2026-04-01T00:00:00');
    expect(waehleKanonischesZuhause([spaeter, frueher])?.name).toBe('Zzz');
  });
});

describe('Personen-Gate — Inferenz nur auf verifizierten Personen', () => {
  it('Realfall „Stiefkinder" (llm_linking, conf 0.7) wird abgelehnt', () => {
    expect(istVerlaesslichePerson({ entityType: 'person', sources: ['llm_linking'], confidence: 0.7 })).toBe(false);
  });

  it('Memory-Personen mit hoher Confidence passieren', () => {
    expect(istVerlaesslichePerson({ entityType: 'person', sources: ['memories', 'smarthome'], confidence: 1 })).toBe(true);
    expect(istVerlaesslichePerson({ entityType: 'person', sources: ['calendar'], confidence: 0.95 })).toBe(true);
  });

  it('niedrige Confidence oder falscher Typ fallen durch', () => {
    expect(istVerlaesslichePerson({ entityType: 'person', sources: ['memories'], confidence: 0.5 })).toBe(false);
    expect(istVerlaesslichePerson({ entityType: 'location', sources: ['memories'], confidence: 1 })).toBe(false);
    expect(istVerlaesslichePerson(undefined)).toBe(false);
  });
});

describe('Attribut-Schutz — LLM darf keine Stammdaten erfinden', () => {
  it('Realfall: erfundenes Geburtsdatum und „sachverständiger"-Rolle werden verworfen, Rest bleibt', () => {
    expect(bereinigeKorrekturAttribute('person', {
      birthdate: '2015-01-01', role: 'sachverständiger', relation_to_user: 'step_son', sport: 'Fußball',
    })).toEqual({ sport: 'Fußball' });
  });

  it('Orts-Flags entscheidet nur der Memory-Pfad', () => {
    expect(bereinigeKorrekturAttribute('location', { isHome: true, isUserHome: true, city: 'Altlengbach' }))
      .toEqual({ city: 'Altlengbach' });
  });

  it('Log-Sätze (>120 Zeichen) sind keine Attribute; Organisationen dürfen role behalten', () => {
    const logSatz = 'IT BOLTWISE Feed scanned (27-30 neue Artikel): Topics included KI-Startups, Unterwasser-Rechenzentren, humanoide Roboter und weitere Meldungen';
    expect(bereinigeKorrekturAttribute('location', { address: logSatz })).toEqual({});
    expect(bereinigeKorrekturAttribute('organization', { role: 'Teamlead' })).toEqual({ role: 'Teamlead' });
  });
});
