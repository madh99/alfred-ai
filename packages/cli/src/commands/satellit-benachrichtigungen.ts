import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';

/**
 * v1275 — Systembenachrichtigungen lesen (Spec §17 Punkt 5, zweiter Teil).
 * Windows: die Benachrichtigungsdatenbank des Benutzers (%LOCALAPPDATA%\Microsoft\Windows\Notifications\wpndatabase.db,
 * SQLite) — Kopie lesen, Toasts mit App, Zeit und Texten. Braucht Node ≥ 22.13 (node:sqlite). Der WinRT-Listener
 * bliebe Apps mit Paket-Identität vorbehalten; die Datenbank liest der Benutzer selbst.
 * macOS: die Datenbank von usernoted (~/Library/Group Containers/group.com.apple.usernoted/db2/db) über sqlite3 und
 * plutil; braucht ggf. „Voller Festplattenzugriff" für den Satelliten.
 * Linux: kein zentraler Speicher — nicht verfügbar.
 * Lesen ist `bestaetigen`: Benachrichtigungen enthalten Nachrichtenvorschauen und Codes.
 */
export interface Benachrichtigung { app: string; zeit: string; titel?: string; text: string }

function run(cmd: string, args: string[], eingabe?: string, timeout = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const kind = execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => err ? reject(new Error(`${cmd}: ${String(stderr).trim().slice(0, 300) || err.message}`)) : resolve(String(stdout)));
    if (eingabe !== undefined && kind.stdin) kind.stdin.end(eingabe);
  });
}

const entities = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');

/** Texte aus dem Toast-XML: erstes <text> ist der Titel, der Rest der Text. */
export function toastTexte(xml: string): { titel?: string; text: string } {
  const texte = [...xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map(m => entities(m[1]!.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/\s+/g, ' ').trim())).filter(Boolean);
  if (texte.length === 0) return { text: '' };
  if (texte.length === 1) return { text: texte[0]! };
  return { titel: texte[0], text: texte.slice(1).join(' — ') };
}

/** Windows-App-Kennung lesbar: „Microsoft.SkyDrive.Desktop" → „SkyDrive.Desktop", AUMIDs ohne Herausgeber-Hash. */
export function appName(id: string): string {
  let s = id.replace(/^Microsoft\./, '').replace(/^com\./, '');
  s = s.replace(/_[a-z0-9]{13}!.*$/i, '').replace(/!.*$/, '');
  return s || id;
}

async function windows(seitMs: number, anzahl: number): Promise<Benachrichtigung[]> {
  const quelle = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Microsoft', 'Windows', 'Notifications', 'wpndatabase.db');
  if (!existsSync(quelle)) throw new Error('Benachrichtigungsdatenbank nicht gefunden');
  let sqlite: { DatabaseSync: new (p: string, o: { readOnly: boolean }) => { prepare(sql: string): { setReadBigInts(b: boolean): unknown; all(...a: unknown[]): Record<string, unknown>[] }; close(): void } };
  try { sqlite = await import('node:sqlite') as unknown as typeof sqlite; } catch { throw new Error(`node:sqlite fehlt — Node ≥ 22.13 nötig (läuft ${process.version})`); }
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'alfred-wpn-'));
  try {
    const kopie = path.join(tmp, 'wpn.db');
    copyFileSync(quelle, kopie);
    for (const ext of ['-wal', '-shm']) if (existsSync(quelle + ext)) copyFileSync(quelle + ext, kopie + ext);
    const db = new sqlite.DatabaseSync(kopie, { readOnly: true });
    try {
      const st = db.prepare("select n.ArrivalTime as t, h.PrimaryId as app, n.Payload as p from Notification n left join NotificationHandler h on n.HandlerId = h.RecordId where n.Type = 'toast' order by n.ArrivalTime desc limit ?");
      st.setReadBigInts(true);
      const out: Benachrichtigung[] = [];
      for (const r of st.all(anzahl * 3)) {
        const t = typeof r.t === 'bigint' ? Number(r.t / 10000n) - 11644473600000 : Number(r.t) / 10000 - 11644473600000; // FILETIME → Unix ms
        if (t < seitMs) continue;
        const xml = Buffer.from(r.p as Uint8Array).toString('utf8');
        const { titel, text } = toastTexte(xml);
        if (!text && !titel) continue;
        out.push({ app: appName(String(r.app ?? '?')), zeit: new Date(t).toISOString(), titel, text });
        if (out.length >= anzahl) break;
      }
      return out;
    } finally { db.close(); }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

async function macos(seitMs: number, anzahl: number): Promise<Benachrichtigung[]> {
  const dbPfad = path.join(os.homedir(), 'Library', 'Group Containers', 'group.com.apple.usernoted', 'db2', 'db');
  if (!existsSync(dbPfad)) throw new Error('Benachrichtigungsdatenbank nicht gefunden (Voller Festplattenzugriff für den Satelliten nötig?)');
  const seitApple = seitMs / 1000 - 978307200; // Unix → Sekunden seit 2001
  const sql = `select a.identifier, r.delivered_date, hex(r.data) from record r join app a on r.app_id = a.app_id where r.delivered_date > ${Math.floor(seitApple)} order by r.delivered_date desc limit ${anzahl};`;
  const out = await run('sqlite3', ['-readonly', '-separator', '\t', dbPfad, sql]);
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'alfred-noted-'));
  try {
    const liste: Benachrichtigung[] = [];
    for (const zeile of out.split('\n').filter(Boolean)) {
      const [app, datum, hex] = zeile.split('\t');
      if (!hex) continue;
      const plist = path.join(tmp, 'n.plist');
      writeFileSync(plist, Buffer.from(hex, 'hex'));
      let titel: string | undefined; let text = '';
      try {
        const j = JSON.parse(await run('plutil', ['-convert', 'json', '-o', '-', plist])) as { req?: { titl?: string; subt?: string; body?: string } };
        titel = j.req?.titl; text = [j.req?.subt, j.req?.body].filter(Boolean).join(' — ');
      } catch { /* unlesbar */ }
      if (!titel && !text) continue;
      liste.push({ app: String(app), zeit: new Date((Number(datum) + 978307200) * 1000).toISOString(), titel, text });
    }
    return liste;
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

export async function benachrichtigungen(stunden = 24, anzahl = 20): Promise<Benachrichtigung[]> {
  const seit = Date.now() - Math.max(1, Math.min(stunden, 24 * 14)) * 3600_000;
  const n = Math.max(1, Math.min(anzahl, 50));
  if (process.platform === 'win32') return windows(seit, n);
  if (process.platform === 'darwin') return macos(seit, n);
  throw new Error('Unter Linux gibt es keinen zentralen Benachrichtigungsspeicher');
}
