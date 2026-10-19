/**
 * v1505 — eigene Anhänge im Chat als Vorschau statt Upload-Zeilen (Owner 19.10., Vorbild: Bilder über der Blase).
 * Erkennt die Zeilen von App und Web („Datei „…" (… Bytes[, SHA-256 …]) liegt in deinem Dateispeicher, Schlüssel: ….")
 * sowie die lokale Vorschau direkt nach dem Senden (`![name](data:…)`, `📎 name`). „Bestätige kurz den Empfang." entfällt.
 * Die Nachricht an Alfred bleibt unverändert, nur die Anzeige ändert sich.
 */
export interface UploadVerweis {
  name: string;
  /** Schlüssel im Dateispeicher (aus dem Verlauf) */
  key?: string;
  groesse?: number;
  /** lokale Daten-URL (gerade gesendet) */
  src?: string;
}

const UPLOAD = /^Datei „(.+?)["“”](?: \((\d+) Bytes(?:, SHA-256 [0-9a-f]+)?\))? liegt in deinem Dateispeicher, Schlüssel: (\S.*)\.$/;
const LOKALES_BILD = /^!\[(.*)\]\((data:image\/[a-z+.-]+;base64,[A-Za-z0-9+/=]+)\)$/;
const LOKALE_DATEI = /^📎 (\S.*\.[A-Za-z0-9]{1,8})$/; // nur mit Dateiendung, damit eigener Text mit 📎 Text bleibt
const BESTAETIGEN = 'Bestätige kurz den Empfang.';

export function istBildName(name: string): boolean {
  return /\.(png|jpe?g|gif|webp)$/i.test(name);
}

export function uploadZeilenTrennen(text: string): { text: string; dateien: UploadVerweis[] } {
  if (!text.includes('liegt in deinem Dateispeicher') && !text.includes('](data:image/') && !text.includes('📎 ')) return { text, dateien: [] };
  const dateien: UploadVerweis[] = [];
  const rest: string[] = [];
  for (const zeile of text.split('\n')) {
    const z = zeile.trim();
    const u = UPLOAD.exec(z);
    if (u) { dateien.push({ name: u[1], groesse: u[2] ? Number(u[2]) : undefined, key: u[3] }); continue; }
    const b = LOKALES_BILD.exec(z);
    if (b) { dateien.push({ name: b[1], src: b[2] }); continue; }
    const d = LOKALE_DATEI.exec(z);
    if (d) { dateien.push({ name: d[1] }); continue; }
    rest.push(zeile);
  }
  if (dateien.length === 0) return { text, dateien: [] };
  return { text: rest.filter(z => z.trim() !== BESTAETIGEN).join('\n').trim(), dateien };
}

export function groesseText(b: number): string {
  return b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${Math.round(b / 1024)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`;
}
