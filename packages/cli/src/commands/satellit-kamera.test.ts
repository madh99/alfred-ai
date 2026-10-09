import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { photoBoothBilderOrdner, neuestesFotoSeit } from './satellit-kamera.js';

describe('satellit-kamera (v1325/v1326)', () => {
  it('findet lokalisierte Photo-Booth-Ordner (Library, Mediathek) und ignoriert andere', () => {
    const heim = mkdtempSync(path.join(os.tmpdir(), 'alfred-kamera-'));
    mkdirSync(path.join(heim, 'Pictures', 'Photo Booth-Mediathek', 'Pictures'), { recursive: true });
    mkdirSync(path.join(heim, 'Pictures', 'Photo Booth Library', 'Pictures'), { recursive: true });
    mkdirSync(path.join(heim, 'Pictures', 'Photos Library.photoslibrary'), { recursive: true });
    const o = photoBoothBilderOrdner(heim).map(p => path.basename(path.dirname(p))).sort();
    expect(o).toEqual(['Photo Booth Library', 'Photo Booth-Mediathek']);
  });

  it('liefert nur Bilder, die nach dem Startzeitpunkt entstanden sind — das neueste zuerst', () => {
    const o = mkdtempSync(path.join(os.tmpdir(), 'alfred-kamera-bilder-'));
    const alt = path.join(o, 'Foto am 09.10.26 um 15.21.jpg');
    const neu = path.join(o, 'Foto am 09.10.26 um 15.40.jpg');
    writeFileSync(alt, 'x'); writeFileSync(neu, 'y'); writeFileSync(path.join(o, 'Recents.plist'), 'z');
    const t0 = Date.now();
    utimesSync(alt, new Date(t0 - 60_000), new Date(t0 - 60_000));
    utimesSync(neu, new Date(t0 + 2_000), new Date(t0 + 2_000));
    expect(neuestesFotoSeit([o], t0)).toBe(neu);
    expect(neuestesFotoSeit([o], t0 + 10_000)).toBeUndefined();
    expect(neuestesFotoSeit([path.join(o, 'gibt-es-nicht')], 0)).toBeUndefined();
  });
});
