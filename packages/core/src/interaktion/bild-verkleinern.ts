/**
 * v1470 — Bilder für das Modell verkleinern (Owner 15.10.: „A+B+C und auch für Nachrichtenbilder“).
 * Handy- und Retina-Screenshots sind oft größer als die Grenzen (Nachricht 5 MB, Werkzeug 2 MB) und fielen dann ganz weg.
 * Lange Kante höchstens BILD_MAX_KANTE Pixel; PNG bleibt PNG (Text bleibt scharf), wird es zu groß, JPEG.
 * Ohne sharp (Bundle ohne native Bibliothek) gilt das Original, sofern es in die Grenze passt.
 */
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';

export const BILD_MAX_KANTE = 2000;

interface SharpBild {
  metadata(): Promise<{ width?: number; height?: number }>;
  rotate(): SharpBild;
  resize(o: { width: number; height: number; fit: 'inside'; withoutEnlargement: boolean }): SharpBild;
  png(o: { compressionLevel: number }): SharpBild;
  jpeg(o: { quality: number; mozjpeg?: boolean }): SharpBild;
  toBuffer(): Promise<Buffer>;
}
type Sharp = (b: Buffer, o?: { animated?: boolean; limitInputPixels?: number }) => SharpBild;

let sharpCache: Sharp | null | undefined;
async function ladeSharp(): Promise<Sharp | null> {
  if (sharpCache !== undefined) return sharpCache;
  try {
    sharpCache = ((await import('sharp')) as unknown as { default: Sharp }).default;
  } catch {
    try { sharpCache = createRequire(realpathSync(process.argv[1] || ''))('sharp') as Sharp; } catch { sharpCache = null; }
  }
  return sharpCache;
}

/** Nur für Tests: sharp-Ersatz setzen (null = nicht vorhanden). */
export function _setzeSharp(s: Sharp | null | undefined): void { sharpCache = s; }

/**
 * Bild so vorbereiten, dass es höchstens `maxBytes` groß ist und die lange Kante höchstens BILD_MAX_KANTE misst.
 * undefined = nicht verwendbar (zu groß und nicht verkleinerbar, oder kein Bild).
 */
export async function bildFuersModell(data: Buffer, mimeType: string, maxBytes: number): Promise<{ data: Buffer; mimeType: string; verkleinert: boolean } | undefined> {
  const mime = mimeType.toLowerCase();
  if (!/^image\/(png|jpeg|webp|gif)$/.test(mime) || data.length === 0) return undefined;
  const sharp = await ladeSharp();
  if (!sharp) return data.length <= maxBytes ? { data, mimeType: mime, verkleinert: false } : undefined;
  try {
    const meta = await sharp(data).metadata();
    const kante = Math.max(meta.width ?? 0, meta.height ?? 0);
    if (kante > 0 && kante <= BILD_MAX_KANTE && data.length <= maxBytes) return { data, mimeType: mime, verkleinert: false };
    const basis = () => sharp(data, { animated: false }).rotate().resize({ width: BILD_MAX_KANTE, height: BILD_MAX_KANTE, fit: 'inside', withoutEnlargement: true });
    if (mime === 'image/png') {
      const png = await basis().png({ compressionLevel: 9 }).toBuffer();
      if (png.length <= maxBytes) return { data: png, mimeType: 'image/png', verkleinert: true };
    }
    for (const quality of [85, 70]) {
      const jpg = await basis().jpeg({ quality, mozjpeg: true }).toBuffer();
      if (jpg.length <= maxBytes) return { data: jpg, mimeType: 'image/jpeg', verkleinert: true };
    }
    return undefined;
  } catch {
    return data.length <= maxBytes ? { data, mimeType: mime, verkleinert: false } : undefined;
  }
}
