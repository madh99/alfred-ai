import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import { sichererDateiname, TRANSFER_BLOCK_BYTES, TRANSFER_GROSS_MAX_BYTES } from './protokoll.js';

/**
 * v1249 — Dateitransfer Stufe 2 (Spec Geräte-Architektur 5a): Nutzlast über HTTPS mit Gerätetoken,
 * in Blöcken mit Offset, SHA-256-Prüfsumme und Wiederaufnahme (Status liefert den nächsten Offset).
 *
 * Upload (Gerät → Server): starten → Blöcke mit Offset → abschließen (Prüfsumme) → Datei an den Aufrufer.
 * Download (Server → Gerät): bereitstellen (Datei liegt im Transferordner) → Blöcke per Offset/Länge lesen.
 * Einträge leben 60 Minuten; Teildateien liegen im Transferordner und werden beim Abschluss oder Aufräumen gelöscht.
 * Rein synchrones Dateisystem — die Blöcke sind klein (4 MB) und die Grenze liegt bei 50 MB.
 */
export interface TransferEintrag {
  id: string;
  art: 'upload' | 'download';
  geraetId: string;
  name: string;
  groesse: number;
  sha256: string;
  pfad: string;
  empfangen: number;
  erstellt: number;
}

export const TRANSFER_TTL_MS = 60 * 60_000;

export class Transfers {
  private readonly eintraege = new Map<string, TransferEintrag>();

  constructor(private readonly ordner: string, private readonly now: () => number = () => Date.now()) {
    mkdirSync(ordner, { recursive: true });
  }

  starteUpload(geraetId: string, name: unknown, groesse: unknown, sha256: unknown): { id: string; blockGroesse: number } {
    this.raeumeAuf();
    const g = Number(groesse);
    if (!Number.isInteger(g) || g <= 0) throw new Error('groesse fehlt oder ungültig');
    if (g > TRANSFER_GROSS_MAX_BYTES) throw new Error(`Datei zu groß (${g} B, Grenze ${TRANSFER_GROSS_MAX_BYTES} B)`);
    const h = String(sha256 ?? '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(h)) throw new Error('sha256 fehlt oder ungültig');
    const id = randomUUID();
    const pfad = path.join(this.ordner, `${id}.part`);
    writeFileSync(pfad, Buffer.alloc(0), { mode: 0o600 });
    this.eintraege.set(id, { id, art: 'upload', geraetId, name: sichererDateiname(name), groesse: g, sha256: h, pfad, empfangen: 0, erstellt: this.now() });
    return { id, blockGroesse: TRANSFER_BLOCK_BYTES };
  }

  schreibeBlock(id: string, offset: number, data: Buffer, geraetId?: string): { empfangen: number; groesse: number } {
    const e = this.hole(id, 'upload', geraetId);
    if (offset !== e.empfangen) throw new TransferOffsetFehler(e.empfangen, e.groesse);
    if (data.length === 0) throw new Error('leerer Block');
    if (data.length > TRANSFER_BLOCK_BYTES) throw new Error(`Block zu groß (${data.length} B, höchstens ${TRANSFER_BLOCK_BYTES} B)`);
    if (e.empfangen + data.length > e.groesse) throw new Error(`Block überschreitet die angekündigte Größe (${e.groesse} B)`);
    appendFileSync(e.pfad, data);
    e.empfangen += data.length;
    return { empfangen: e.empfangen, groesse: e.groesse };
  }

  status(id: string, geraetId?: string): { id: string; art: 'upload' | 'download'; name: string; empfangen: number; groesse: number; sha256: string; blockGroesse: number } {
    const e = this.hole(id, undefined, geraetId);
    return { id: e.id, art: e.art, name: e.name, empfangen: e.empfangen, groesse: e.groesse, sha256: e.sha256, blockGroesse: TRANSFER_BLOCK_BYTES };
  }

  /** Prüft Vollständigkeit und Prüfsumme, liefert die Datei und räumt den Eintrag ab. */
  schliesseUpload(id: string, geraetId?: string): { name: string; data: Buffer; sha256: string } {
    const e = this.hole(id, 'upload', geraetId);
    if (e.empfangen !== e.groesse) throw new Error(`unvollständig: ${e.empfangen} von ${e.groesse} B`);
    const data = readFileSync(e.pfad);
    const ist = createHash('sha256').update(data).digest('hex');
    this.beende(id);
    if (ist !== e.sha256) throw new Error('Prüfsumme stimmt nicht');
    return { name: e.name, data, sha256: ist };
  }

  bereitstellen(geraetId: string, name: string, data: Buffer): { id: string; groesse: number; sha256: string; blockGroesse: number } {
    this.raeumeAuf();
    if (data.length > TRANSFER_GROSS_MAX_BYTES) throw new Error(`Datei zu groß (${data.length} B, Grenze ${TRANSFER_GROSS_MAX_BYTES} B)`);
    const id = randomUUID();
    const pfad = path.join(this.ordner, `${id}.dl`);
    writeFileSync(pfad, data, { mode: 0o600 });
    const sha256 = createHash('sha256').update(data).digest('hex');
    this.eintraege.set(id, { id, art: 'download', geraetId, name: sichererDateiname(name), groesse: data.length, sha256, pfad, empfangen: data.length, erstellt: this.now() });
    return { id, groesse: data.length, sha256, blockGroesse: TRANSFER_BLOCK_BYTES };
  }

  leseBlock(id: string, offset: number, laenge: number, geraetId?: string): Buffer {
    const e = this.hole(id, 'download', geraetId);
    if (offset < 0 || offset >= e.groesse) throw new Error('Offset außerhalb der Datei');
    const n = Math.min(laenge, TRANSFER_BLOCK_BYTES, e.groesse - offset);
    const fd = openSync(e.pfad, 'r');
    try { const buf = Buffer.alloc(n); const gelesen = readSync(fd, buf, 0, n, offset); return gelesen === n ? buf : buf.subarray(0, gelesen); }
    finally { closeSync(fd); }
  }

  beende(id: string): void {
    const e = this.eintraege.get(id);
    if (!e) return;
    this.eintraege.delete(id);
    try { if (existsSync(e.pfad)) unlinkSync(e.pfad); } catch { /* Aufräumen holt es nach */ }
  }

  anzahl(): number { return this.eintraege.size; }

  private hole(id: string, art?: 'upload' | 'download', geraetId?: string): TransferEintrag {
    const e = this.eintraege.get(id);
    if (!e || (art && e.art !== art)) throw new Error('Transfer unbekannt oder abgelaufen');
    if (geraetId && e.geraetId !== geraetId) throw new Error('Transfer gehört zu einem anderen Gerät');
    if (!existsSync(e.pfad)) { this.eintraege.delete(id); throw new Error('Transferdatei fehlt'); }
    return e;
  }

  private raeumeAuf(): void {
    const jetzt = this.now();
    for (const [id, e] of this.eintraege) if (jetzt - e.erstellt > TRANSFER_TTL_MS) this.beende(id);
  }
}

/** Offset passt nicht: der Aufrufer setzt bei `empfangen` fort. */
export class TransferOffsetFehler extends Error {
  constructor(readonly empfangen: number, readonly groesse: number) { super(`Offset passt nicht — weiter bei ${empfangen}`); }
}

export function dateiGroesse(pfad: string): number { return statSync(pfad).size; }
