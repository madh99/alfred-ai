import { describe, it, expect } from 'vitest';
import { anhangSchluessel, anhangHinweis, anhangName, ANHANG_MAX_DATEIEN } from '../anhaenge.js';

const OWNER = 'f165df7a-8689-49b6-9318-41839913846f';
const K1 = `${OWNER}/2026-10-13T10-56-59-097Z_eingefuegt-20261013-125559.png`;
const K2 = `${OWNER}/2026-10-13T10-56-59-141Z_eingefuegt-20261013-125620.png`;

describe('v1424 Anhänge für Claude-Code-Aufträge', () => {
  it('liest die Schlüssel aus der Upload-Zeile (Realfall 13.10.)', () => {
    const text = `kannst du prüfen …\n\nDatei „eingefuegt-20261013-125559.png" (23642 Bytes) liegt in deinem Dateispeicher, Schlüssel: ${K1}.\nDatei „eingefuegt-20261013-125620.png" liegt in deinem Dateispeicher, Schlüssel: ${K2}.`;
    expect(anhangSchluessel(text, OWNER)).toEqual([K1, K2]);
  });

  it('erkennt Schlüssel mitten im Satz und in Klammern, ohne Satzzeichen', () => {
    expect(anhangSchluessel(`siehe FileStore ${K1}, und (${K2}) bitte`, OWNER)).toEqual([K1, K2]);
  });

  it('nimmt den ausdrücklichen Parameter, ohne Dubletten', () => {
    expect(anhangSchluessel(`Text mit ${K1}`, OWNER, [K1, K2])).toEqual([K1, K2]);
    expect(anhangSchluessel('', OWNER, `${K1}, ${K2}`)).toEqual([K1, K2]);
  });

  it('lässt fremde Dateien und Pfad-Ausbrüche weg', () => {
    const fremd = 'e9af76d3-0000-4000-8000-000000000000/bild.png';
    expect(anhangSchluessel(`${fremd} ${OWNER}/../x/y.png`, OWNER, [fremd, `${OWNER}/..\\a.png`])).toEqual([]);
    expect(anhangSchluessel(K1, '')).toEqual([]);
  });

  it('begrenzt die Zahl der Dateien', () => {
    const viele = Array.from({ length: 10 }, (_, i) => `${OWNER}/b${i}.png`);
    expect(anhangSchluessel('', OWNER, viele)).toHaveLength(ANHANG_MAX_DATEIEN);
  });

  it('Hinweis und Dateiname', () => {
    expect(anhangHinweis([])).toBe('');
    expect(anhangHinweis(['.alfred-anhaenge/x/a.png'])).toContain('.alfred-anhaenge/x/a.png');
    expect(anhangName(K1)).toBe('eingefuegt-20261013-125559.png');
  });
});
