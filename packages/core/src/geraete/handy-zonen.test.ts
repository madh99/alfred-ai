import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HandyZonen } from './handy-zonen.js';
import { deuteGeraete } from '../normalzustaende/geraete.js';

describe('HandyZonen — v1522 Standortzonen', () => {
  it('betreten/verlassen/stand; Verlassen einer fremden Zone ändert nichts; übersteht Neustart', () => {
    const datei = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'alfred-zonen-')), 'z.json');
    let jetzt = Date.parse('2026-10-20T06:00:00Z');
    const z = new HandyZonen(datei, () => jetzt);
    expect(z.melde('g', { art: 'stand', zone: 'Zuhause' })).toEqual({ vorher: null, jetzt: 'Zuhause' });
    jetzt += 60_000;
    expect(z.melde('g', { art: 'stand', zone: 'Zuhause' })).toBeUndefined(); // unverändert
    expect(z.von('g')?.seit).toBe('2026-10-20T06:00:00.000Z');
    expect(z.melde('g', { art: 'verlassen', zone: 'Büro' })).toBeUndefined(); // nicht die aktuelle Zone
    expect(z.melde('g', { art: 'verlassen', zone: 'Zuhause' })).toEqual({ vorher: 'Zuhause', jetzt: null });
    expect(z.melde('g', { art: 'betreten', zone: 'Büro' })).toEqual({ vorher: null, jetzt: 'Büro' });
    expect(z.melde('g', { art: 'unsinn', zone: 'x' })).toBeUndefined();
    expect(new HandyZonen(datei).von('g')?.zone).toBe('Büro');
    expect(z.melde('g', { art: 'aus' })).toEqual({ vorher: 'Büro', jetzt: null });
    expect(z.von('g')).toBeUndefined();
  });

  it('Weltmodell: Zone auch bei geschlossener App, „unterwegs“ ohne Zone', () => {
    const JETZT = new Date('2026-10-20T10:00:00Z');
    const d = deuteGeraete({ jetzt: JETZT, geraete: [
      { name: 'iPhone', plattform: 'ios', online: false, zuletztGesehen: '2026-10-20T07:00:00Z', zone: { name: 'Büro', seit: '2026-10-20T06:30:00Z' } },
      { name: 'iPad', plattform: 'ios', online: false, zuletztGesehen: '2026-10-20T09:50:00Z', zone: { name: null, seit: '2026-10-20T08:15:00Z' } },
    ] })!;
    expect(d.zeilen[0]).toMatch(/^iPhone \(ios\): Zone „Büro“ seit \d\d:\d\d, zuletzt verbunden vor 3 h$/);
    expect(d.zeilen[1]).toMatch(/^iPad \(ios\): unterwegs seit \d\d:\d\d, zuletzt verbunden vor 10 min$/);
    expect(d.auffaellig).toEqual([]);
  });
});
