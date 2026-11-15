import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import type { CmdbChangeRequest } from '@alfred/types';
import { kanonisch, geschwaerzt, zeitText, beweisAnhang, pruefAnleitung } from './beweis.js';

function change(ausgabe: string, extra: Record<string, unknown> = {}): CmdbChangeRequest {
  return {
    id: '288c3716-aaaa-bbbb-cccc-000000000000', userId: 'u', title: 't', type: 'normal', status: 'completed', riskLevel: 'low',
    affectedAssetIds: [], affectedServiceIds: [], createdAt: '', updatedAt: '',
    schritte: [{ nr: 1, titel: 'Dienst starten', art: 'aktion', skill: 'proxmox', aktion: 'start', zeitlimitS: 60, beiFehler: 'anhalten' }],
    lauf: {
      phase: 'fertig', schritt: 1, start: '2026-11-15T08:27:53.000Z',
      ergebnisse: [{ nr: 1, ok: true, start: '2026-11-15T08:27:53.000Z', ende: '2026-11-15T08:28:10.000Z', ausgabe, pruefung: { ok: true, text: 'ok', versuche: 1 } }],
      ...extra,
    },
  } as CmdbChangeRequest;
}

describe('Beweis-Anhang', () => {
  it('kanonisch sortiert Schlüssel rekursiv ohne Leerraum', () => {
    expect(kanonisch({ b: 1, a: { d: 2, c: [3, { f: 1, e: 0 }] } })).toBe('{"a":{"c":[3,{"e":0,"f":1}],"d":2},"b":1}');
  });

  it('schwärzt Geheimnisse in Blöcken und Rohlauf und zählt sie', () => {
    const r = beweisAnhang(change('password=Geheim123!'));
    expect(JSON.stringify(r.bloecke)).not.toContain('Geheim123!');
    expect(r.rohlauf!.inhalt).not.toContain('Geheim123!');
    expect(r.schwaerzungen).toBeGreaterThan(0);
  });

  it('geschwaerzt liefert eine tiefe Kopie', () => {
    const o = { a: ['password=Geheim123!'] };
    const k = geschwaerzt(o);
    expect(k.a[0]).not.toContain('Geheim123!');
    expect(o.a[0]).toContain('Geheim123!');
  });

  it('Prüfsumme ist SHA-256 über den Rohlauf-Inhalt', () => {
    const r = beweisAnhang(change('alles gut'));
    expect(createHash('sha256').update(r.rohlauf!.inhalt, 'utf8').digest('hex')).toBe(r.pruefsumme);
    expect(r.rohlauf!.name).toBe('rohlauf-288c3716.json');
    expect(r.rohlauf!.mime).toBe('application/json');
  });

  it('kürzt lange Ausgaben nach dem Schwärzen', () => {
    const hinweis = '\n[gekürzt — Volltext im Rohlauf]';
    const r = beweisAnhang(change('x'.repeat(100000)));
    const code = r.bloecke.filter(b => b.art === 'code') as Array<{ art: 'code'; text: string }>;
    expect(code).toHaveLength(1);
    expect(code[0]!.text.length).toBeLessThanOrEqual(1500 + hinweis.length);
    expect(code[0]!.text.endsWith('[gekürzt — Volltext im Rohlauf]')).toBe(true);
  });

  it('Geheimnis an der Kürzungsgrenze leckt nicht', () => {
    const r = beweisAnhang(change('a'.repeat(1490) + '\npassword=Geheim123!'), 1500);
    expect(JSON.stringify(r.bloecke)).not.toContain('Geheim');
  });

  it('Change ohne Lauf: nichtBelegt, keine Prüfsumme', () => {
    const c = change('x'); delete (c as { lauf?: unknown }).lauf;
    const r = beweisAnhang(c);
    expect(r.bloecke).toEqual([{ art: 'nichtBelegt', grund: 'Change ohne Lauf' }]);
    expect(r.pruefsumme).toBeUndefined();
    expect(r.rohlauf).toBeUndefined();
  });

  it('Tabelle enthält Titel und Aktion aus dem Plan', () => {
    const r = beweisAnhang(change('ok'));
    const t = r.bloecke.find(b => b.art === 'tabelle') as { kopf: string[]; zeilen: string[][] };
    expect(t.kopf).toEqual(['Nr', 'Titel', 'Aktion', 'Start', 'Ende', 'Ergebnis', 'Prüfung']);
    expect(t.zeilen[0]![1]).toBe('Dienst starten');
    expect(t.zeilen[0]![2]).toBe('proxmox.start');
  });

  it('zeitText zeigt UTC und Wiener Zeit (Sommer- und Winterzeit)', () => {
    expect(zeitText('2026-11-15T08:27:53.000Z')).toBe('2026-11-15 08:27:53 UTC (09:27:53 Wien)');
    expect(zeitText('2026-07-15T08:27:53.000Z')).toBe('2026-07-15 08:27:53 UTC (10:27:53 Wien)');
    expect(zeitText(undefined)).toBe('—');
  });

  it('pruefAnleitung im sha256sum-Format', () => {
    const a = pruefAnleitung([{ name: 'rohlauf-288c3716.json', pruefsumme: 'ab' }]);
    expect(a.name).toBe('PRUEFUNG.txt');
    expect(a.inhalt).toContain('ab  rohlauf-288c3716.json');
  });
});
