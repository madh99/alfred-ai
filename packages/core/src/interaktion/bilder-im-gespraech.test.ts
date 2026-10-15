import { describe, it, expect } from 'vitest';
import { bildSchluessel, bildMime, bildVermerk, nachfassSchluessel } from './bilder-im-gespraech.js';
import { SpeechTranscriber } from '../speech-transcriber.js';

const OWNER = 'f165df7a-0000-4000-8000-000000000001';
const K1 = `${OWNER}/2026-10-15T18-21-00-000Z_Bildschirmfoto 1.png`.replace(' ', '_');
const APP = `Datei „Bildschirmfoto_1.png“ (120 Bytes, SHA-256 ab12) liegt in deinem Dateispeicher, Schlüssel: ${K1}.`;

describe('v1467 Bilder im Gespräch', () => {
  it('liest Bild-Schlüssel aus der Upload-Zeile der App, nur eigene, nur Bilder', () => {
    expect(bildSchluessel(APP, OWNER)).toEqual([K1]);
    expect(bildSchluessel(APP, 'e9af76d3-0000-4000-8000-000000000002')).toEqual([]);
    expect(bildSchluessel(`Schlüssel: ${OWNER}/2026-10-15T18-21-00-000Z_bericht.pdf`, OWNER)).toEqual([]);
    expect(bildMime(K1)).toBe('image/png');
    expect(bildMime('x/y.JPG')).toBe('image/jpeg');
  });

  it('Realfall 15.10.: Schlüssel mit Leerzeichen aus der Upload-Zeile, mehrere Zeilen', () => {
    const a = `${OWNER}/2026-10-15T18-21-52-740Z_Screenshot 2026-10-15 202133.png`;
    const b = `${OWNER}/2026-10-15T18-21-52-801Z_Screenshot 2026-10-15 202140.png`;
    const t = `Datei „Screenshot 2026-10-15 202133.png“ (1 Bytes, SHA-256 ab) liegt in deinem Dateispeicher, Schlüssel: ${a}.\nDatei „Screenshot 2026-10-15 202140.png“ (1 Bytes, SHA-256 cd) liegt in deinem Dateispeicher, Schlüssel: ${b}.\nWas siehst du?`;
    expect(bildSchluessel(t, OWNER)).toEqual([a, b]);
    expect(bildSchluessel(`[Photo]${bildVermerk([a])}`, OWNER)).toEqual([a]);
    expect(bildSchluessel(`Schlüssel: ${OWNER}/x_mein.datei name.png.`, OWNER)).toEqual([`${OWNER}/x_mein.datei name.png`]);
  });

  it('Vermerk im Verlauf wird wiedergefunden', () => {
    const k = `${OWNER}/2026-10-15T18-14-00-000Z_bild-1.jpg`;
    expect(bildSchluessel(`[Photo]${bildVermerk([k])}`, OWNER)).toEqual([k]);
    expect(bildVermerk([])).toBe('');
  });

  it('Folgefrage: jüngste Nachricht mit Bildern binnen 10 min, mit Bezug binnen 30 min', () => {
    const verlauf = [
      { role: 'user', content: APP, createdAt: '2026-10-15T18:21:00.000Z' },
      { role: 'assistant', content: 'Alle vier Screenshots sind angekommen.', createdAt: '2026-10-15T18:21:30.000Z' },
    ];
    const t = (min: number) => new Date(Date.parse('2026-10-15T18:21:00.000Z') + min * 60_000);
    expect(nachfassSchluessel({ text: 'und was meinst du?', owner: OWNER, verlauf, jetzt: t(5) })).toEqual([K1]);
    expect(nachfassSchluessel({ text: 'und was meinst du?', owner: OWNER, verlauf, jetzt: t(20) })).toEqual([]);
    expect(nachfassSchluessel({ text: 'Schau dir die Screenshots nochmal an', owner: OWNER, verlauf, jetzt: t(20) })).toEqual([K1]);
    expect(nachfassSchluessel({ text: 'Schau dir die Screenshots nochmal an', owner: OWNER, verlauf, jetzt: t(45) })).toEqual([]);
    expect(nachfassSchluessel({ text: 'hallo', owner: OWNER, verlauf: [{ role: 'user', content: 'ohne Bild', createdAt: '2026-10-15T18:21:00Z' }], jetzt: t(1) })).toEqual([]);
    expect(nachfassSchluessel({ text: 'hallo', owner: OWNER, verlauf: [{ role: 'user', content: APP, createdAt: '2026-10-15 18:21:00' }], jetzt: t(1) })).toEqual([K1]);
  });

  it('Spracherkennung: Sprache aus personality.language', () => {
    expect(SpeechTranscriber.spracheIso('Deutsch')).toBe('de');
    expect(SpeechTranscriber.spracheIso('de-AT')).toBe('de');
    expect(SpeechTranscriber.spracheIso('English')).toBe('en');
    expect(SpeechTranscriber.spracheIso(undefined)).toBeUndefined();
    expect(SpeechTranscriber.spracheIso('Klingonisch')).toBeUndefined();
  });
});
