import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HandyFokus } from './handy-fokus.js';
import { entscheideZustellung } from '../delivery-scheduler.js';
import { fokusText } from '../normalzustaende/geraete.js';

describe('HandyFokus — v1528 Fokusfilter', () => {
  it('an mit Name/Hinweisen, gleiche Meldung ändert nichts, aus löscht; übersteht Neustart', () => {
    const datei = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'alfred-fokus-')), 'f.json');
    let jetzt = Date.parse('2026-10-20T06:30:00Z');
    const f = new HandyFokus(datei, () => jetzt);
    expect(f.melde('g', { aktiv: true, name: 'Arbeit', hinweise: 'nurDringend', vorlesen: false })).toBe(true);
    jetzt += 60_000;
    expect(f.melde('g', { aktiv: true, name: 'Arbeit', hinweise: 'nurDringend', vorlesen: false })).toBe(false);
    expect(f.von('g')?.seit).toBe('2026-10-20T06:30:00.000Z');
    expect(new HandyFokus(datei).aktiv()?.name).toBe('Arbeit');
    expect(f.melde('g', { aktiv: true, hinweise: 'quatsch' })).toBe(true); // unbekannt → Standard
    expect(f.von('g')).toMatchObject({ name: 'Fokus', hinweise: 'nurDringend' });
    expect(f.melde('g', { aktiv: false })).toBe(true);
    expect(f.aktiv()).toBeUndefined();
    expect(f.melde('g', { aktiv: false })).toBe(false);
  });
});

describe('Zustellung im Fokus (v1528)', () => {
  const basis = { chatAktiv: true, imRuhefenster: false, profilErlaubt: true, profilText: 'Profil' };
  it('„nur Dringendes“: hoch kommt, normal wird aufgeschoben — auch wenn der Owner gerade chattet', () => {
    const a = { fokus: { name: 'Arbeit', hinweise: 'nurDringend' as const } };
    expect(entscheideZustellung({ ...basis, urgency: 'high', anwesenheit: a }).liefern).toBe(true);
    expect(entscheideZustellung({ ...basis, urgency: 'normal', anwesenheit: a })).toEqual({ liefern: false, grund: 'Fokus „Arbeit“: nur Dringendes' });
  });
  it('„keine“: nur Notfälle (dringend)', () => {
    const a = { fokus: { name: 'Schlafen', hinweise: 'keine' as const } };
    expect(entscheideZustellung({ ...basis, urgency: 'urgent', anwesenheit: a }).liefern).toBe(true);
    expect(entscheideZustellung({ ...basis, urgency: 'high', anwesenheit: a }).liefern).toBe(false);
  });
  it('„alle“ und ohne Fokus: wie bisher', () => {
    expect(entscheideZustellung({ ...basis, urgency: 'normal', anwesenheit: { fokus: { name: 'X', hinweise: 'alle' } } }).liefern).toBe(true);
    expect(entscheideZustellung({ ...basis, urgency: 'normal' }).liefern).toBe(true);
  });
  it('Weltmodell-Text', () => {
    expect(fokusText({ name: 'Arbeit', hinweise: 'nurDringend', seit: '2026-10-20T06:30:00Z' })).toMatch(/^Fokus „Arbeit“ \(nur Dringendes\) seit \d\d:\d\d$/);
  });
});
