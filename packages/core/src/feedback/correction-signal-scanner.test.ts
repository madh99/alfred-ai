import { describe, it, expect } from 'vitest';
import { scanCorrectionSignal } from './correction-signal-scanner.js';

describe('scanCorrectionSignal — true positives (echte Korrekturen)', () => {
  it('matches "Nein, das ist falsch"', () => {
    expect(scanCorrectionSignal('Nein, das ist falsch').level).toBe('high');
  });
  it('matches "Das war falsch"', () => {
    expect(scanCorrectionSignal('Das war falsch').level).toBe('high');
  });
  it('matches "Ich meinte ..."', () => {
    expect(scanCorrectionSignal('Ich meinte alle unter 3001€').level).toBe('high');
  });
  it('matches "Mach das nicht"', () => {
    expect(scanCorrectionSignal('Mach das nicht so').level).toBe('high');
  });
  it('matches English "that was wrong"', () => {
    expect(scanCorrectionSignal("that was wrong").level).toBe('high');
  });
  it('matches behavioral phrases like "Beim nächsten Mal anders machen"', () => {
    expect(scanCorrectionSignal('Beim nächsten Mal bitte anders machen').level).toBe('high');
  });
  it('matches "Hör auf damit"', () => {
    expect(scanCorrectionSignal('Hör auf damit').level).toBe('high');
  });
});

describe('scanCorrectionSignal — false positives (sollte NICHT triggern)', () => {
  it('does NOT match procedural runbook with "Wenn JA"', () => {
    const msg = `Batterie-Lademanagement — tägliche Prüfung:
1. PRÜFUNG: Rufe den SoC-Verlauf der letzten 30 Tage ab. Wurde 100% erreicht?
   - Wenn JA → melde 'Vollladung am [Datum], kein Handlungsbedarf' und STOPPE.`;
    expect(scanCorrectionSignal(msg).level).toBe('low');
  });

  it('does NOT match question "Wie kann man das in Zukunft vermeiden?"', () => {
    expect(scanCorrectionSignal('Wie kam es zu dem Fehler und wie kann man ihn in Zukunft vermeiden?').level).toBe('low');
  });

  it('does NOT match documentation "nur wenn X dann Y"', () => {
    expect(scanCorrectionSignal('input_boolean.x ist nur dann aktiv wenn input_datetime.y in Zukunft liegt').level).toBe('low');
  });

  it('does NOT match technical text mentioning "threshold ändern"', () => {
    expect(scanCorrectionSignal('Die Dokumentation beschreibt wann man den Schwellenwert ändern darf').level).toBe('low');
  });

  it('does NOT match casual mention of "in zukunft"', () => {
    expect(scanCorrectionSignal('Vielleicht wäre das in Zukunft interessant').level).toBe('low');
  });
});

describe('scanCorrectionSignal — sentence anchors', () => {
  it('matches "Beim nächsten Mal" at the start', () => {
    expect(scanCorrectionSignal('Beim nächsten Mal bitte direkt fragen statt vermuten').level).toBe('high');
  });

  it('matches "In Zukunft" at start when followed by command verb', () => {
    expect(scanCorrectionSignal('In Zukunft IMMER zuerst nachfragen.').level).toBe('high');
  });

  it('does NOT match "in zukunft" inside a descriptive sentence', () => {
    expect(scanCorrectionSignal('Wir hatten überlegt das in zukunft anders zu lösen.').level).toBe('low');
  });
});

describe('scanCorrectionSignal — minimum length guard', () => {
  it('returns low for messages under 8 chars', () => {
    expect(scanCorrectionSignal('Nein!').level).toBe('low');
  });
});
