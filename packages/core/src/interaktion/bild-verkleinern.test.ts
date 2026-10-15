import { describe, it, expect, afterEach } from 'vitest';
import sharp from 'sharp';
import { bildFuersModell, BILD_MAX_KANTE, _setzeSharp } from './bild-verkleinern.js';
import { zuzustellen, bildBloeckeAusAnhaengen } from './werkzeug-bilder.js';

const bild = (w: number, h: number, fmt: 'png' | 'jpeg' = 'png') =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 30, b: 90 } } })[fmt]().toBuffer();

describe('v1470 Bilder fürs Modell verkleinern', () => {
  afterEach(() => _setzeSharp(undefined));

  it('kleines Bild bleibt unverändert', async () => {
    const b = await bild(800, 600);
    const r = await bildFuersModell(b, 'image/png', 5 * 1024 * 1024);
    expect(r).toMatchObject({ verkleinert: false, mimeType: 'image/png' });
    expect(r!.data).toBe(b);
  });

  it('großes Bild wird auf die lange Kante verkleinert, PNG bleibt PNG', async () => {
    const b = await bild(4000, 1500);
    const r = await bildFuersModell(b, 'image/png', 5 * 1024 * 1024);
    expect(r).toMatchObject({ verkleinert: true, mimeType: 'image/png' });
    const m = await sharp(r!.data).metadata();
    expect(m.width).toBe(BILD_MAX_KANTE);
    expect(m.height).toBe(750);
  });

  it('über der Bytegrenze → verkleinert/JPEG; kein Bild → undefined', async () => {
    const b = await bild(1200, 900, 'jpeg');
    const r = await bildFuersModell(b, 'image/jpeg', 2_000);
    expect(r === undefined || r.data.length <= 2_000).toBe(true);
    expect(await bildFuersModell(Buffer.from('x'), 'application/pdf', 1e6)).toBeUndefined();
  });

  it('ohne sharp: Original nur, wenn es in die Grenze passt', async () => {
    _setzeSharp(null);
    const b = Buffer.alloc(100, 1);
    expect(await bildFuersModell(b, 'image/png', 1000)).toMatchObject({ verkleinert: false });
    expect(await bildFuersModell(b, 'image/png', 50)).toBeUndefined();
  });

  it('„nur fürs Modell“ wird nicht zugestellt, aber gesehen', () => {
    const a = [{ fileName: 'a.png', mimeType: 'image/png', data: Buffer.alloc(10, 1), nurModell: true }, { fileName: 'b.pdf', mimeType: 'application/pdf', data: Buffer.alloc(10, 1) }];
    expect(zuzustellen(a).map(x => x.fileName)).toEqual(['b.pdf']);
    expect(bildBloeckeAusAnhaengen(a).filter(x => x.type === 'image')).toHaveLength(1);
  });
});
