/**
 * v1467 — Bilder im Gespräch sichtbar (Realfall 15.10. 18:21: vier Screenshots in der App → „Alle vier Screenshots sind angekommen“,
 * auf Nachfrage las Alfred sie per read_store als „Binary file“ und rief sogar `ls -la /` auf).
 * Die App schickt nur die Upload-Zeile mit dem Dateispeicher-Schlüssel; Telegram & Co. hängen Bilder nur der ersten Nachricht an.
 * Reine Regeln ohne Modell: welche Bild-Schlüssel gehören zu dieser Nachricht, und wann werden Bilder aus den letzten Nachrichten
 * erneut angehängt.
 */
import { anhangSchluessel } from '../projekt/anhaenge.js';

export const BILDER_MAX = 6;
export const BILD_MAX_BYTES = 5 * 1024 * 1024;
/** v1470 — bis zu dieser Größe wird gelesen und gespeichert; ans Modell geht das Bild verkleinert (bild-verkleinern.ts). */
export const BILD_LESEN_MAX_BYTES = 25 * 1024 * 1024;
/** Bilder der letzten Nachricht gelten so lange als Teil des Gesprächs … */
export const NACHFASS_MIN = 10;
/** … und mit ausdrücklichem Bezug („auf dem Bild“, „schau dir … an“) so lange. */
export const BEZUG_MIN = 30;

const BILD = /\.(png|jpe?g|gif|webp)$/i;
const BEZUG = /\b(bild\w*|screenshots?|fotos?|anh(ä|ae)ng\w*|sieh\w*|schau\w*|ansehen|anschauen)/i;

export function istBild(schluessel: string): boolean { return BILD.test(schluessel); }

export function bildMime(schluessel: string): string {
  const e = (BILD.exec(schluessel)?.[1] ?? '').toLowerCase();
  return e === 'png' ? 'image/png' : e === 'gif' ? 'image/gif' : e === 'webp' ? 'image/webp' : 'image/jpeg';
}

/** Bild-Schlüssel des Owners im Text (Upload-Zeile der App, „(Bild: …)“ aus dem Verlauf), ohne Dubletten. */
export function bildSchluessel(text: string, owner: string): string[] {
  return anhangSchluessel(text ?? '', owner).filter(istBild).slice(0, BILDER_MAX);
}

/** Vermerk im gespeicherten Text eingehender Bilder (Telegram & Co.), damit Folgefragen sie wiederfinden. */
export function bildVermerk(schluessel: string[]): string {
  return schluessel.length ? `\n${schluessel.map(k => `(Bild: ${k})`).join('\n')}` : '';
}

/**
 * Bilder aus den letzten Nachrichten für eine Folgefrage ohne eigene Bilder: die jüngste Owner-Nachricht mit Bildern zählt,
 * wenn sie höchstens NACHFASS_MIN Minuten alt ist — oder höchstens BEZUG_MIN Minuten, wenn die neue Nachricht sich auf Bilder bezieht.
 */
export function nachfassSchluessel(o: { text: string; owner: string; verlauf: Array<{ role: string; content: string; createdAt: string }>; jetzt: Date }): string[] {
  const bezug = BEZUG.test(o.text ?? '');
  for (let i = o.verlauf.length - 1; i >= 0; i--) {
    const m = o.verlauf[i]!;
    if (m.role !== 'user') continue;
    const k = bildSchluessel(m.content, o.owner);
    if (!k.length) continue;
    const t = Date.parse(m.createdAt.includes('T') || m.createdAt.endsWith('Z') ? m.createdAt : `${m.createdAt.replace(' ', 'T')}Z`);
    if (!Number.isFinite(t)) return [];
    const alterMin = (o.jetzt.getTime() - t) / 60_000;
    return alterMin <= (bezug ? BEZUG_MIN : NACHFASS_MIN) ? k : [];
  }
  return [];
}
