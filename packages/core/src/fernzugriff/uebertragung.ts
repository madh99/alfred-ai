/**
 * Spec Infrastruktur-Vorhaben, I6 (Owner 22.10.2026 „I6 wie vorgeschlagen umsetzen“) — Daten übertragen (E4-D), ohne Modell.
 *
 * Ordner/Volumes: Abgleich nach rsync-Art über den Server. Beide Seiten liefern eine Dateiliste (Typ, Größe, Zeit, Rechte, Eigentümer,
 * Link-Ziel); übertragen wird nur, was neu ist oder sich unterscheidet — als tar-Strom Quelle → Server → Ziel (Daten erreichen nie das
 * Modell, nie die Platte des Servers). Damit ist der zweite Durchgang (nach dem Stoppen des Dienstes) kurz, ein Abbruch wird beim
 * nächsten Aufruf fortgesetzt, und mit `loeschen` verschwindet am Ziel, was es an der Quelle nicht mehr gibt. Prüfsumme danach:
 * SHA-256 über alle Dateien (sortiert) beider Seiten + Anzahl.
 *
 * Datenbanken: PostgreSQL per pg_dump -Fc | pg_restore als Strom; Prüfung: exakte Zeilenzahl je Tabelle auf beiden Seiten.
 */
import { fernBefehl } from './regeln.js';

export interface Eintrag { typ: string; groesse: number; zeit: number; modus: string; uid: string; gid: string; link: string }
export type Liste = Map<string, Eintrag>;

/** Erlaubte Pfade: absolut, nur sichere Zeichen, kein „..“, keine Systembereiche */
const PFAD = /^\/[A-Za-z0-9._@+-]+(\/[A-Za-z0-9._@+-]+)*$/;
const SYSTEM = /^\/(proc|sys|dev|run|boot|bin|sbin|lib|lib64|usr|etc|root|var\/lib\/docker(?!\/volumes\/))(\/|$)/;
/** Ziele: nur Daten-Bereiche (neue Hosts) — nie Systemordner */
const ZIEL = /^(\/(srv|opt|data|mnt)\/[^/]+|\/home\/[^/]+\/[^/]+|\/var\/lib\/docker\/volumes\/[^/]+\/_data)(\/.*)?$/;
const NAME = /^[a-zA-Z0-9][\w.-]{0,62}$/;

export function pruefePfad(p: unknown, art: 'quelle' | 'ziel'): string | undefined {
  if (typeof p !== 'string' || !PFAD.test(p) || p.split('/').includes('..')) return `${art}_pfad: absoluter Pfad aus Buchstaben, Ziffern, . _ @ + - (ohne ..)`;
  if (SYSTEM.test(p)) return `${art}_pfad ${p}: Systembereich — nicht erlaubt`;
  if (art === 'ziel' && !ZIEL.test(p)) return `ziel_pfad ${p}: nur unter /srv/<x>, /opt/<x>, /data/<x>, /mnt/<x>, /home/<benutzer>/<x> oder einem Docker-Volume`;
  return undefined;
}
export const gueltigerName = (x: unknown): x is string => typeof x === 'string' && NAME.test(x);

/** Dateiliste eines Ordners (fehlt er, ist die Ausgabe leer) — NUL-getrennt: „typ größe zeit modus uid gid pfad\0linkziel\0“ */
export const listenBefehl = (p: string) => `if [ -d '${p}' ]; then cd -- '${p}' && find . -xdev -printf '%y %s %T@ %m %U %G %p\\0%l\\0'; fi`;

export function leseListe(text: string): Liste {
  const l: Liste = new Map();
  const teile = text.split('\0');
  for (let i = 0; i + 1 < teile.length; i += 2) {
    const m = /^(\S) (\d+) ([\d.]+) (\d+) (\d+) (\d+) (\..*)$/s.exec(teile[i]!);
    if (!m) continue;
    l.set(m[7]!, { typ: m[1]!, groesse: Number(m[2]), zeit: Math.floor(Number(m[3])), modus: m[4]!, uid: m[5]!, gid: m[6]!, link: teile[i + 1] ?? '' });
  }
  return l;
}

export interface Abgleich { uebertragen: string[]; loeschen: string[]; neu: number; geaendert: number; uebersprungen: number; bytes: number }

/** Was muss übertragen bzw. am Ziel entfernt werden? (Ordner nur bei fehlend/Rechten; Sockets/Geräte werden übersprungen) */
export function abgleich(quelle: Liste, ziel: Liste, loeschen: boolean): Abgleich {
  const a: Abgleich = { uebertragen: [], loeschen: [], neu: 0, geaendert: 0, uebersprungen: 0, bytes: 0 };
  const typwechsel: string[] = [];
  for (const [p, q] of quelle) {
    if (p === '.') continue;
    if (!['f', 'd', 'l'].includes(q.typ)) { a.uebersprungen++; continue; }
    const z = ziel.get(p);
    const rechte = !z || z.modus !== q.modus || z.uid !== q.uid || z.gid !== q.gid;
    let noetig = false;
    if (!z) { noetig = true; a.neu++; }
    else if (z.typ !== q.typ) { noetig = true; a.geaendert++; typwechsel.push(p); }
    else if (q.typ === 'f' && (z.groesse !== q.groesse || z.zeit !== q.zeit)) { noetig = true; a.geaendert++; }
    else if (q.typ === 'l' && z.link !== q.link) { noetig = true; a.geaendert++; }
    else if (rechte) { noetig = true; a.geaendert++; }
    if (noetig) { a.uebertragen.push(p); if (q.typ === 'f') a.bytes += q.groesse; }
  }
  const weg = loeschen ? [...ziel.keys()].filter(p => p !== '.' && !quelle.has(p)) : [];
  // nur oberste Einträge löschen (Kinder gehen mit) — plus Einträge, deren Typ wechselt
  const alle = [...new Set([...weg, ...typwechsel])].sort();
  for (const p of alle) if (!a.loeschen.some(x => p.startsWith(`${x}/`))) a.loeschen.push(p);
  a.uebertragen.sort();
  return a;
}

/** NUL-getrennte Liste für tar -T / xargs -0 — nur Pfade aus der Dateiliste („./…“, ohne „..“) */
export function nulListe(pfade: string[]): string {
  for (const p of pfade) if (!p.startsWith('./') || p.split('/').includes('..') || p.includes('\0')) throw new Error(`unzulässiger Pfad in der Liste: ${p.slice(0, 80)}`);
  return pfade.map(p => `${p}\0`).join('');
}

export const sendeBefehl = (p: string) => `tar -C '${p}' --numeric-owner --no-recursion --null -T - -cf -`;
export const empfangeBefehl = (p: string) => `mkdir -p '${p}' && tar -C '${p}' --numeric-owner -xpf -`;
export const loeschBefehl = (p: string) => `cd -- '${p}' && xargs -0 -r rm -rf --`;
export const summenBefehl = (p: string) => `cd -- '${p}' && find . -xdev -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum | sha256sum | cut -d' ' -f1 && find . -xdev -type f | wc -l`;
export const volumeBefehl = (v: string, anlegen: boolean) => `${anlegen ? `docker volume inspect ${v} >/dev/null 2>&1 || docker volume create ${v} >/dev/null; ` : ''}docker volume inspect --format '{{ .Mountpoint }}' ${v}`;

export function leseSumme(t: string): { summe: string; dateien: number } | undefined {
  const [s, n] = t.trim().split(/\s+/);
  return s && /^[0-9a-f]{64}$/.test(s) && n && /^\d+$/.test(n) ? { summe: s, dateien: Number(n) } : undefined;
}

// ── PostgreSQL ────────────────────────────────────────────────────────────────────────────────────────────────
export const pgDumpBefehl = (c: string, u: string, db: string) => `docker exec ${c} pg_dump -U ${u} -Fc ${db}`;
export const pgRestoreBefehl = (c: string, u: string, db: string) => `docker exec -i ${c} pg_restore -U ${u} -d ${db} --clean --if-exists --no-owner --exit-on-error`;
export const pgZaehlBefehl = (c: string, u: string, db: string) => `docker exec -i ${c} psql -U ${u} -d ${db} -At -v ON_ERROR_STOP=1`;
export const PG_ZAEHL_SQL = "SELECT format('SELECT %L || ''|'' || count(*) FROM %I.%I', schemaname || '.' || tablename, schemaname, tablename) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY 1 \\gexec\n";

export function leseZaehlung(t: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const z of t.split(/\r?\n/)) { const x = /^(.+)\|(\d+)$/.exec(z.trim()); if (x) m.set(x[1]!, Number(x[2])); }
  return m;
}
export function vergleicheZaehlung(q: Map<string, number>, z: Map<string, number>): string[] {
  const f: string[] = [];
  for (const [t, n] of q) { const m = z.get(t); if (m === undefined) f.push(`${t} fehlt am Ziel`); else if (m !== n) f.push(`${t}: ${n} → ${m} Zeilen`); }
  for (const t of z.keys()) if (!q.has(t)) f.push(`${t} gibt es nur am Ziel`);
  return f;
}

// ── Ablauf mit eingespeisten Wegen (SSH) ──────────────────────────────────────────────────────────────────────
export interface StromErgebnis { codeQuelle: number; codeZiel: number; bytes: number; stderrQuelle: string; stderrZiel: string }
export interface Wege<Z> {
  lauf(z: Z, befehl: string, eingabe: string, timeoutMs: number, max?: number): Promise<{ code: number; stdout: string; stderr: string }>;
  strom(q: Z, qBefehl: string, qEingabe: string, z: Z, zBefehl: string, o: { timeoutMs: number; kbps?: number; fortschritt?: (bytes: number) => void }): Promise<StromErgebnis>;
  protokoll?(msg: string, daten: Record<string, unknown>): void;
}
const LISTE_MAX = 256 * 1024 * 1024;
const root = (b: string) => fernBefehl(b, true);

export interface KopierErgebnis { neu: number; geaendert: number; geloescht: number; uebersprungen: number; bytes: number; sekunden: number; restUnterschiede: number; summe?: { quelle: string; ziel: string; dateien: number; gleich: boolean } }

export async function kopiere<Z>(w: Wege<Z>, q: Z, qPfad: string, z: Z, zPfad: string, o: { loeschen: boolean; pruefsumme: boolean; timeoutMs: number; kbps?: number }): Promise<KopierErgebnis> {
  const start = Date.now();
  const bis = () => Math.max(30_000, o.timeoutMs - (Date.now() - start));
  const liste = async (x: Z, p: string, wer: string) => {
    const r = await w.lauf(x, root(listenBefehl(p)), '', bis(), LISTE_MAX);
    if (r.code !== 0) throw new Error(`Dateiliste ${wer} (${p}) gescheitert: ${r.stderr.trim().slice(-200)}`);
    return leseListe(r.stdout);
  };
  const ql = await liste(q, qPfad, 'Quelle');
  if (!ql.has('.')) throw new Error(`Quelle ${qPfad} gibt es nicht oder ist kein Ordner`);
  const a = abgleich(ql, await liste(z, zPfad, 'Ziel'), o.loeschen);
  if (a.loeschen.length) {
    const r = await w.lauf(z, root(loeschBefehl(zPfad)), nulListe(a.loeschen), bis());
    if (r.code !== 0) throw new Error(`Entfernen am Ziel gescheitert: ${r.stderr.trim().slice(-200)}`);
  }
  if (a.uebertragen.length) {
    let zuletzt = Date.now();
    const s = await w.strom(q, root(sendeBefehl(qPfad)), nulListe(a.uebertragen), z, root(empfangeBefehl(zPfad)), {
      timeoutMs: bis(), ...(o.kbps ? { kbps: o.kbps } : {}),
      fortschritt: b => { if (Date.now() - zuletzt > 30_000) { zuletzt = Date.now(); w.protokoll?.('I6 Übertragung läuft', { quelle: qPfad, ziel: zPfad, bytes: b, von: a.bytes }); } },
    });
    if (s.codeQuelle !== 0 || s.codeZiel !== 0) throw new Error(`Übertragung gescheitert (Quelle Exit ${s.codeQuelle}, Ziel Exit ${s.codeZiel}): ${(s.stderrQuelle + ' ' + s.stderrZiel).trim().slice(-300)}`);
  }
  // Nachkontrolle: was jetzt noch abweicht (bei laufendem Dienst normal, nach dem Stoppen muss es 0 sein)
  const rest = abgleich(await liste(q, qPfad, 'Quelle'), await liste(z, zPfad, 'Ziel'), o.loeschen);
  const ergebnis: KopierErgebnis = { neu: a.neu, geaendert: a.geaendert, geloescht: a.loeschen.length, uebersprungen: a.uebersprungen, bytes: a.bytes, sekunden: Math.round((Date.now() - start) / 1000), restUnterschiede: rest.uebertragen.length + rest.loeschen.length };
  if (o.pruefsumme) {
    const [rq, rz] = await Promise.all([w.lauf(q, root(summenBefehl(qPfad)), '', bis()), w.lauf(z, root(summenBefehl(zPfad)), '', bis())]);
    const sq = leseSumme(rq.stdout), sz = leseSumme(rz.stdout);
    if (!sq || !sz) throw new Error(`Prüfsumme nicht lesbar (${(rq.stderr + rz.stderr).trim().slice(-200)})`);
    ergebnis.summe = { quelle: sq.summe, ziel: sz.summe, dateien: sq.dateien, gleich: sq.summe === sz.summe && sq.dateien === sz.dateien };
  }
  return ergebnis;
}

export async function volumePfad<Z>(w: Wege<Z>, x: Z, volume: string, anlegen: boolean): Promise<string> {
  if (!gueltigerName(volume)) throw new Error(`ungültiger Volume-Name ${volume}`);
  const r = await w.lauf(x, root(volumeBefehl(volume, anlegen)), '', 60_000);
  const p = r.stdout.trim();
  if (r.code !== 0 || !/^\/var\/lib\/docker\/volumes\/[\w.-]+\/_data$/.test(p)) throw new Error(`Volume ${volume}: ${anlegen ? 'nicht anlegbar' : 'nicht gefunden'} (${(r.stderr || p).trim().slice(-160)})`);
  return p;
}

export interface DbErgebnis { bytes: number; sekunden: number; tabellen: number; zeilen: number; abweichungen: string[] }

export async function kopiereDatenbank<Z>(w: Wege<Z>, q: Z, qC: string, z: Z, zC: string, db: string, benutzer: string, o: { timeoutMs: number; kbps?: number }): Promise<DbErgebnis> {
  for (const n of [qC, zC, db, benutzer]) if (!gueltigerName(n)) throw new Error(`ungültiger Name ${String(n).slice(0, 40)}`);
  const start = Date.now();
  const s = await w.strom(q, root(pgDumpBefehl(qC, benutzer, db)), '', z, root(pgRestoreBefehl(zC, benutzer, db)), { timeoutMs: o.timeoutMs, ...(o.kbps ? { kbps: o.kbps } : {}) });
  if (s.codeQuelle !== 0 || s.codeZiel !== 0) throw new Error(`Dump/Restore gescheitert (Quelle Exit ${s.codeQuelle}, Ziel Exit ${s.codeZiel}): ${(s.stderrQuelle + ' ' + s.stderrZiel).trim().slice(-300)}`);
  const [rq, rz] = await Promise.all([w.lauf(q, root(pgZaehlBefehl(qC, benutzer, db)), PG_ZAEHL_SQL, 600_000), w.lauf(z, root(pgZaehlBefehl(zC, benutzer, db)), PG_ZAEHL_SQL, 600_000)]);
  if (rq.code !== 0 || rz.code !== 0) throw new Error(`Zeilenzählung gescheitert: ${(rq.stderr + rz.stderr).trim().slice(-200)}`);
  const zq = leseZaehlung(rq.stdout);
  return { bytes: s.bytes, sekunden: Math.round((Date.now() - start) / 1000), tabellen: zq.size, zeilen: [...zq.values()].reduce((x, y) => x + y, 0), abweichungen: vergleicheZaehlung(zq, leseZaehlung(rz.stdout)) };
}
