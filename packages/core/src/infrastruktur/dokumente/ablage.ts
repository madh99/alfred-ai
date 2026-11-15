// Ablage der Dokument-Dateien: lokal unter <datenOrdner>/dokumente/<ordner>/v<version>/ und als Kopie auf pve2
// unter /srv/alfred-dokumente/<ordner>/v<version>/. Namen werden vor jedem Schreiben geprüft.
import path from 'node:path';
import type { Dokument } from './modell.js';

export interface AblageDeps {
  schreibeLokal(pfad: string, inhalt: Buffer): Promise<void>;
  sendeAnPve2(zielPfad: string, lokalPfad: string): Promise<{ ok: boolean; fehler?: string }>;
}

export const PVE2_WURZEL = '/srv/alfred-dokumente';
/** nur Buchstaben, Ziffern, _ . - und nie nur Punkte („.“, „..“) */
const NAME = /^(?!\.+$)[\w.-]{1,120}$/;

/** Fehlertext für einen ungültigen Ordner-/Dateinamen, sonst undefined. */
export function pruefeAblageNamen(ordner: string, namen: string[]): string | undefined {
  if (!NAME.test(ordner)) return `Ablage-Ordner „${ordner}“ ungültig (nur Buchstaben, Ziffern, _ . -)`;
  for (const n of namen) if (!NAME.test(n)) return `Ablage-Datei „${n}“ ungültig (nur Buchstaben, Ziffern, _ . -)`;
  return undefined;
}

/** Lokales Schreiben: Verzeichnisse 0700, Dateien 0600, Bytes unverändert. */
export async function schreibeLokalDatei(pfad: string, inhalt: Buffer): Promise<void> {
  const { mkdir, writeFile, chmod } = await import('node:fs/promises');
  await mkdir(path.dirname(pfad), { recursive: true, mode: 0o700 });
  await writeFile(pfad, inhalt, { mode: 0o600 });
  // mode greift nur beim Anlegen — eine überschriebene Datei behält sonst ihre alten Rechte
  await chmod(pfad, 0o600).catch(() => undefined);
}

export async function lege(
  d: Dokument,
  version: number,
  dateien: Array<{ name: string; inhalt: Buffer }>,
  deps: AblageDeps,
  datenOrdner: string,
): Promise<{ lokal: string; pve2: { ok: boolean; fehler?: string } }> {
  const ordner = d.kopf.ordner;
  const f = pruefeAblageNamen(ordner, dateien.map(x => x.name));
  if (f) throw new Error(f);
  if (!Number.isInteger(version) || version < 1) throw new Error(`Ablage: ungültige Version ${version}`);
  const unter = `v${version}`;
  const lokal = path.join(datenOrdner, 'dokumente', ordner, unter);
  for (const x of dateien) await deps.schreibeLokal(path.join(lokal, x.name), x.inhalt);

  // Kopie auf pve2: erster Fehler bricht ab; die lokale Ablage bleibt bestehen
  for (const x of dateien) {
    let r: { ok: boolean; fehler?: string };
    try {
      r = await deps.sendeAnPve2(`${PVE2_WURZEL}/${ordner}/${unter}/${x.name}`, path.join(lokal, x.name));
    } catch (err) {
      r = { ok: false, fehler: (err as Error).message };
    }
    if (!r.ok) return { lokal, pve2: { ok: false, fehler: `${x.name}: ${r.fehler ?? 'unbekannter Fehler'}` } };
  }
  return { lokal, pve2: { ok: true } };
}
