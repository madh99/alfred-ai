import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { SkillResultAttachment } from '@alfred/types';

/**
 * v1347 — Ablage zugestellter Anhänge (Owner 10.10. 23:40: Foto verschwand nach erneutem Öffnen des Hauptgesprächs,
 * weil `messages` nur Text kennt). Je Anhang zwei Dateien unter `data/anhaenge/`: `<id>` (Inhalt) und `<id>.json`
 * (Name, Typ, Gespräch). Die Nachricht trägt in `messages.anhaenge` die Verweise; der Verlauf liefert sie mit, die App
 * holt den Inhalt über `/api/geraete/anhang/<id>`. Aufbewahrung: `conversation.anhangAufbewahrungTage` (Standard 30).
 */
export interface AnhangVerweis { id: string; name: string; mime: string; groesse: number }
interface AnhangMeta { name: string; mime: string; groesse: number; gespraech: string; zeit: string }

export const ANHANG_ID_RE = /^[0-9a-f]{32}$/;
/** Größter abgelegter Anhang (wie die Zustellung an Geräte, http.ts anGeraet). */
const MAX_BYTES = 8 * 1024 * 1024;

export class AnhangAblage {
  constructor(private readonly verzeichnis: string) {}

  /** Legt die Anhänge ab und liefert die Verweise; zu große oder leere Anhänge werden übersprungen. */
  lege(anhaenge: SkillResultAttachment[], gespraech: string): AnhangVerweis[] {
    const verweise: AnhangVerweis[] = [];
    if (anhaenge.length === 0) return verweise;
    fs.mkdirSync(this.verzeichnis, { recursive: true });
    for (const a of anhaenge) {
      if (!a.data || a.data.length === 0 || a.data.length > MAX_BYTES) continue;
      const id = crypto.randomBytes(16).toString('hex');
      const meta: AnhangMeta = { name: path.basename(a.fileName || 'anhang'), mime: a.mimeType || 'application/octet-stream', groesse: a.data.length, gespraech, zeit: new Date().toISOString() };
      fs.writeFileSync(path.join(this.verzeichnis, id), a.data);
      fs.writeFileSync(path.join(this.verzeichnis, `${id}.json`), JSON.stringify(meta));
      verweise.push({ id, name: meta.name, mime: meta.mime, groesse: meta.groesse });
    }
    return verweise;
  }

  /** Inhalt und Kopfdaten eines Anhangs; undefined bei unbekannter/abgelaufener Kennung. */
  lies(id: string): { daten: Buffer; name: string; mime: string; gespraech: string } | undefined {
    if (!ANHANG_ID_RE.test(id)) return undefined;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(this.verzeichnis, `${id}.json`), 'utf8')) as AnhangMeta;
      return { daten: fs.readFileSync(path.join(this.verzeichnis, id)), name: meta.name, mime: meta.mime, gespraech: meta.gespraech };
    } catch { return undefined; }
  }

  vorhanden(id: string): boolean {
    return ANHANG_ID_RE.test(id) && fs.existsSync(path.join(this.verzeichnis, id));
  }

  /** Entfernt Anhänge, die älter als `tage` sind; liefert die Anzahl. */
  aufraeumen(tage: number, jetzt = Date.now()): number {
    let n = 0;
    let dateien: string[];
    try { dateien = fs.readdirSync(this.verzeichnis); } catch { return 0; }
    const grenze = jetzt - tage * 86_400_000;
    for (const d of dateien) {
      if (!ANHANG_ID_RE.test(d)) continue;
      const p = path.join(this.verzeichnis, d);
      try {
        if (fs.statSync(p).mtimeMs >= grenze) continue;
        fs.rmSync(p, { force: true });
        fs.rmSync(`${p}.json`, { force: true });
        n++;
      } catch { /* nächste Datei */ }
    }
    return n;
  }
}

/** Verweise aus der Spalte `messages.anhaenge` (JSON) lesen; fehlerhafte Einträge fallen weg. */
export function verweiseAus(json: string | undefined): AnhangVerweis[] {
  if (!json) return [];
  try {
    const a = JSON.parse(json) as unknown;
    return Array.isArray(a) ? a.filter((v): v is AnhangVerweis => !!v && typeof v === 'object' && ANHANG_ID_RE.test(String((v as AnhangVerweis).id))) : [];
  } catch { return []; }
}
