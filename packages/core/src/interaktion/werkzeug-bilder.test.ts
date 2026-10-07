import { describe, it, expect } from 'vitest';
import { bildBloeckeAusAnhaengen, ohneBilder } from './werkzeug-bilder.js';

const jpg = (name: string, bytes = 100) => ({ fileName: name, mimeType: 'image/jpeg', data: Buffer.alloc(bytes, 1) });

describe('bildBloeckeAusAnhaengen', () => {
  it('liefert nichts ohne Bilder', () => {
    expect(bildBloeckeAusAnhaengen(undefined)).toEqual([]);
    expect(bildBloeckeAusAnhaengen([{ fileName: 'a.pdf', mimeType: 'application/pdf', data: Buffer.alloc(10) }])).toEqual([]);
  });

  it('Textblock plus ein Bildblock je Bild, base64, Medientyp klein', () => {
    const out = bildBloeckeAusAnhaengen([{ fileName: 'bildschirm.jpg', mimeType: 'image/JPEG', data: Buffer.from('abc') }]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ type: 'text' });
    expect((out[0] as { text: string }).text).toContain('bildschirm.jpg');
    expect(out[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: Buffer.from('abc').toString('base64') } });
  });

  it('überspringt zu große Bilder und begrenzt die Anzahl', () => {
    const out = bildBloeckeAusAnhaengen([jpg('1.jpg', 10), jpg('gross.jpg', 50), jpg('2.jpg', 10), jpg('3.jpg', 10), jpg('4.jpg', 10)], 2, 40);
    expect(out.filter(b => b.type === 'image')).toHaveLength(2);
    expect((out[0] as { text: string }).text).toContain('1.jpg, 2.jpg');
    expect((out[0] as { text: string }).text).not.toContain('gross');
  });
});

describe('ohneBilder', () => {
  it('behält nur tool_result/tool_use', () => {
    const bloecke = [
      { type: 'tool_result' as const, tool_use_id: '1', content: 'x' },
      ...bildBloeckeAusAnhaengen([jpg('a.jpg')]),
    ];
    expect(ohneBilder(bloecke)).toHaveLength(1);
  });
});
