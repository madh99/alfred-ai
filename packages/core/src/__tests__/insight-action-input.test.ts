import { describe, it, expect } from 'vitest';
import { extractInputFields, applyActionInputs } from '../insight-action-input.js';

describe('extractInputFields', () => {
  it('liest deklarierte Felder aus sourceData', () => {
    const fields = extractInputFields({
      inputFields: [{ key: 'birthday', label: 'Geburtsdatum', type: 'date' }],
    });
    expect(fields).toEqual([{ key: 'birthday', label: 'Geburtsdatum', type: 'date' }]);
  });

  it('toleriert fehlende/kaputte Formate', () => {
    expect(extractInputFields(undefined)).toEqual([]);
    expect(extractInputFields({})).toEqual([]);
    expect(extractInputFields({ inputFields: 'kaputt' })).toEqual([]);
    expect(extractInputFields({ inputFields: [null, 42, { label: 'ohne key' }] })).toEqual([]);
  });

  it('füllt fehlende label/type mit Defaults', () => {
    const fields = extractInputFields({ inputFields: [{ key: 'x' }, { key: 'y', type: 'quatsch' }] });
    expect(fields).toEqual([
      { key: 'x', label: 'x', type: 'text' },
      { key: 'y', label: 'y', type: 'text' },
    ]);
  });
});

describe('applyActionInputs', () => {
  const FIELDS = [{ key: 'birthday', label: 'Geburtsdatum', type: 'date' as const }];

  it('ohne inputFields: params unverändert durchreichen', () => {
    const params = { action: 'save', value: 'statisch' };
    const r = applyActionInputs(params, [], { birthday: '2000-01-01' });
    expect(r).toEqual({ ok: true, params });
  });

  it('füllt {{key}}-Platzhalter mit der User-Eingabe', () => {
    const r = applyActionInputs(
      { action: 'save', key: 'geburtstag_hannah', value: 'Geburtstag von Hannah ist {{birthday}}' },
      FIELDS,
      { birthday: '2014-05-03' },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.value).toBe('Geburtstag von Hannah ist 2014-05-03');
  });

  it('fehlende oder leere Eingabe → ok:false mit missing-Liste', () => {
    const r1 = applyActionInputs({ value: '{{birthday}}' }, FIELDS, undefined);
    expect(r1).toEqual({ ok: false, missing: ['birthday'] });
    const r2 = applyActionInputs({ value: '{{birthday}}' }, FIELDS, { birthday: '   ' });
    expect(r2).toEqual({ ok: false, missing: ['birthday'] });
  });

  it('substituiert rekursiv in Objekten und Arrays', () => {
    const r = applyActionInputs(
      { nested: { text: 'Wert: {{v}}' }, list: ['{{v}}', 7] },
      [{ key: 'v', label: 'V', type: 'text' }],
      { v: '42' },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.params.nested as Record<string, unknown>).text).toBe('Wert: 42');
      expect(r.params.list).toEqual(['42', 7]);
    }
  });

  it('nicht deklarierte Eingaben werden ignoriert (kein Injection-Kanal)', () => {
    const r = applyActionInputs(
      { value: '{{birthday}} und {{evil}}' },
      FIELDS,
      { birthday: '2014-05-03', evil: 'HACK' },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.value).toBe('2014-05-03 und {{evil}}');
  });

  it('mehrere Felder, mehrfache Verwendung desselben Platzhalters', () => {
    const r = applyActionInputs(
      { a: '{{x}}-{{x}}', b: '{{y}}' },
      [
        { key: 'x', label: 'X', type: 'text' },
        { key: 'y', label: 'Y', type: 'number' },
      ],
      { x: 'ab', y: 5 },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.a).toBe('ab-ab');
      expect(r.params.b).toBe('5');
    }
  });
});
