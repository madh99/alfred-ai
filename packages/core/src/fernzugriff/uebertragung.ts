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
import { createHash } from 'node:crypto';
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
/** Docker-Volumes: auch anonyme Volumes mit 64-stelliger ID (Realfall 22.10.: pgAdmin-Volume c3805b…) */
const VOLUME = /^[a-zA-Z0-9][\w.-]{0,127}$/;

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
/** Besitzer (numerisch) und Rechte des Wurzelordners wie an der Quelle */
export const wurzelBefehl = (p: string, e: { uid: string; gid: string; modus: string }) => {
  if (!/^\d+$/.test(e.uid) || !/^\d+$/.test(e.gid) || !/^[0-7]{3,4}$/.test(e.modus)) throw new Error('unzulässige Besitzer-/Rechteangabe');
  return `chown ${e.uid}:${e.gid} '${p}' && chmod ${e.modus} '${p}'`;
};
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

export interface KopierErgebnis { wurzelAngeglichen?: boolean; neu: number; geaendert: number; geloescht: number; uebersprungen: number; bytes: number; sekunden: number; restUnterschiede: number; summe?: { quelle: string; ziel: string; dateien: number; gleich: boolean } }

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
  // Realfall 22.10. (pgAdmin startete nicht: „Permission denied“ beim Umbenennen seiner DB): Besitzer und Rechte des Wurzelordners
  // selbst gehören dazu — die Quelle hatte 5050:0 775, das neu angelegte Volume root 755
  const qw = ql.get('.')!;
  const zw = (await liste(z, zPfad, 'Ziel')).get('.');
  let wurzelAngeglichen = false;
  if (!zw || zw.uid !== qw.uid || zw.gid !== qw.gid || zw.modus !== qw.modus) {
    const r = await w.lauf(z, root(wurzelBefehl(zPfad, qw)), '', bis());
    if (r.code !== 0) throw new Error(`Besitzer/Rechte des Zielordners nicht gesetzt: ${r.stderr.trim().slice(-200)}`);
    wurzelAngeglichen = true;
  }
  // Nachkontrolle: was jetzt noch abweicht (bei laufendem Dienst normal, nach dem Stoppen muss es 0 sein)
  const qRest = await liste(q, qPfad, 'Quelle'), zRest = await liste(z, zPfad, 'Ziel');
  const rest = abgleich(qRest, zRest, o.loeschen);
  const wq = qRest.get('.'), wz = zRest.get('.');
  if (wq && wz && (wq.uid !== wz.uid || wq.gid !== wz.gid || wq.modus !== wz.modus)) rest.uebertragen.push('.');
  const ergebnis: KopierErgebnis = { neu: a.neu, geaendert: a.geaendert, geloescht: a.loeschen.length, uebersprungen: a.uebersprungen, bytes: a.bytes, sekunden: Math.round((Date.now() - start) / 1000), restUnterschiede: rest.uebertragen.length + rest.loeschen.length, ...(wurzelAngeglichen ? { wurzelAngeglichen } : {}) };
  if (o.pruefsumme) {
    const [rq, rz] = await Promise.all([w.lauf(q, root(summenBefehl(qPfad)), '', bis()), w.lauf(z, root(summenBefehl(zPfad)), '', bis())]);
    const sq = leseSumme(rq.stdout), sz = leseSumme(rz.stdout);
    if (!sq || !sz) throw new Error(`Prüfsumme nicht lesbar (${(rq.stderr + rz.stderr).trim().slice(-200)})`);
    ergebnis.summe = { quelle: sq.summe, ziel: sz.summe, dateien: sq.dateien, gleich: sq.summe === sz.summe && sq.dateien === sz.dateien };
  }
  return ergebnis;
}

export async function volumePfad<Z>(w: Wege<Z>, x: Z, volume: string, anlegen: boolean): Promise<string> {
  if (typeof volume !== 'string' || !VOLUME.test(volume)) throw new Error(`ungültiger Volume-Name ${volume}`);
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

// ── v1636 Datenbank-Inventar (fest, nur lesend) ───────────────────────────────────────────────────────────────
// Owner 24.10.: Umzugs-Changes sollen Datenbestände selbst nachweisen statt Owner-Schritten. Kein freies SQL: festes Skript,
// Lese-Transaktion (default_transaction_read_only), Ausgabe nur Namen, Größen, Zeilenzahlen. Der Fingerabdruck (SHA-256 über
// Hauptversion, Datenbanken, Rollen und Zeilenzahl je Tabelle — ohne Größen, die nach einer Kopie schwanken) macht vorher/nachher vergleichbar.
const PG_LESEND = "-e PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=600000'";
/** v1671 — Realfall 25.10. (pgsql-p01, gemeinsamer DB-Host): PostgreSQL läuft nativ, nicht im Container → container=host. */
export const PG_NATIV = 'host';
export const pgInventarBefehl = (c: string, db: string) => c === PG_NATIV
  ? `env PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=600000' runuser -u postgres -- psql -X -w -At -v ON_ERROR_STOP=1 -d ${db}`
  : `docker exec -i ${PG_LESEND} ${c} sh -c 'exec psql -X -w -At -v ON_ERROR_STOP=1 -U "\${POSTGRES_USER:-postgres}" -d ${db}'`;
// v1671 — Encoding/Collation je Datenbank (Synapse verlangt C); nicht Teil des Fingerabdrucks
export const PG_INVENTAR_SQL = "SELECT 'version|' || current_setting('server_version_num');\nSELECT 'db|' || datname || '|' || pg_database_size(oid) FROM pg_database WHERE datallowconn ORDER BY datname;\nSELECT 'enc|' || datname || '|' || pg_encoding_to_char(encoding) || '|' || datcollate || '|' || datctype FROM pg_database WHERE datallowconn ORDER BY datname;\nSELECT 'rolle|' || rolname FROM pg_roles WHERE rolname !~ '^pg_' ORDER BY rolname;\n";
export const redisInventarBefehl = (c: string) => `docker exec ${c} sh -c 'redis-cli --raw INFO server | grep -E "^redis_version:"; redis-cli --raw INFO keyspace | grep -E "^db[0-9]+:" || true'`; // v1637 — leerer Keyspace ist kein Fehler (Realfall redis 24.10.)

/**
 * v1663 — Realfall 25.10. (eedb29a6 Schritt 6): der Fingerabdruck der noah-SQLite lief über `lesen` im Lese-Käfig; nach dem Stopp
 * waren -wal/-shm weg, ohne Schreibrecht ließ sich die WAL-Datenbank nicht öffnen („unable to open database file“). Jetzt als root
 * auf einer Kopie in einem eigenen Ordner unter /tmp: zuerst die Backup-API (konsistent auch im Betrieb), sonst die Dateien samt
 * -wal/-shm. Tabellen und Zeilen der Kopie; scheitert die Zählung einer Tabelle (beschädigte Seiten), steht sie mit „fehler“ im
 * Fingerabdruck — an einer bitgleichen Kopie am Ziel ebenso. Die Kopie wird immer gelöscht, das Original nie geöffnet zum Schreiben.
 */
export const SQLITE_PFAD = /^\/[A-Za-z0-9._@+\/-]{1,250}$/;
export const sqliteInventarBefehl = (pfad: string) => [
  'set -eu', 'd=$(mktemp -d /tmp/alfred-sqlite.XXXXXXXX)', 'trap \'rm -rf "$d"\' EXIT',
  `test -f '${pfad}'`,
  `python3 - '${pfad}' "$d" <<'PY'`,
  'import sqlite3, sys, shutil, os',
  'q, d = sys.argv[1], sys.argv[2]; k = os.path.join(d, "kopie.sqlite"); weg = "backup"',
  'try:',
  '    s = sqlite3.connect("file:" + q + "?mode=ro", uri=True); z = sqlite3.connect(k); s.backup(z); z.close(); s.close()',
  'except Exception:',
  '    weg = "dateien"',
  '    for e in ("", "-wal", "-shm"):',
  '        if os.path.exists(q + e): shutil.copy2(q + e, k + e)',
  'c = sqlite3.connect(k)',
  'print("version|" + sqlite3.sqlite_version); print("weg|" + weg)',
  // v1668 — Integrität der Kopie mitmelden (geht nicht in den Fingerabdruck ein); Realfall 6193af12 Schritt 11: im Käfig nicht öffenbar
  'try: i = c.execute("pragma integrity_check").fetchone()[0]',
  'except Exception as e: i = "fehler " + type(e).__name__',
  'print("integritaet|" + ("ok" if i == "ok" else "fehler"))',
  'for (n,) in c.execute("select name from sqlite_master where type=\'table\' order by name").fetchall():',
  '    try: print("tab|%s|%d" % (n, c.execute(\'select count(*) from "%s"\' % n.replace(\'"\', \'""\')).fetchone()[0]))',
  '    except Exception: print("tab|%s|fehler" % n)',
  'c.close()',
  'PY',
].join('\n');

export function leseSqliteInventar(t: string): { version: string; weg: string; integritaet?: 'ok' | 'fehler'; tabellen: Array<{ name: string; zeilen: number | 'fehler' }> } {
  let version = '', weg = ''; let integritaet: 'ok' | 'fehler' | undefined; const tabellen: Array<{ name: string; zeilen: number | 'fehler' }> = [];
  for (const z of t.split(/\r?\n/)) {
    let m: RegExpExecArray | null;
    if ((m = /^version\|([\d.]+)$/.exec(z))) version = m[1]!;
    else if ((m = /^weg\|(\w+)$/.exec(z))) weg = m[1]!;
    else if ((m = /^integritaet\|(ok|fehler)$/.exec(z))) integritaet = m[1] as 'ok' | 'fehler';
    else if ((m = /^tab\|(.+)\|(\d+|fehler)$/.exec(z))) tabellen.push({ name: m[1]!, zeilen: m[2] === 'fehler' ? 'fehler' : Number(m[2]) });
  }
  return { version, weg, ...(integritaet ? { integritaet } : {}), tabellen };
}

export async function sqliteInventar<Z>(w: Wege<Z>, z: Z, pfad: string): Promise<DbInventar> {
  if (!SQLITE_PFAD.test(pfad) || pfad.split('/').includes('..')) throw new Error('pfad: absoluter Pfad der SQLite-Datei');
  const r = await w.lauf(z, root(sqliteInventarBefehl(pfad)), '', 600_000);
  if (r.code !== 0) throw new Error(`SQLite-Inventar gescheitert (Exit ${r.code}): ${r.stderr.trim().slice(-200)}`);
  const inv = leseSqliteInventar(r.stdout);
  if (!inv.version) throw new Error('SQLite-Version nicht lesbar');
  const zeilen = inv.tabellen.reduce((s, t) => s + (typeof t.zeilen === 'number' ? t.zeilen : 0), 0);
  // Fingerabdruck ohne Version und Kopierweg: nur der Inhalt (Tabellen und Zeilenzahlen) soll vorher und nachher gleich sein
  const teile = ['sqlite', ...inv.tabellen.map(t => `${t.name}|${t.zeilen}`)];
  return { art: 'sqlite', version: inv.version, hauptversion: inv.version.split('.')[0]!, datenbanken: [{ name: pfad, tabellen: inv.tabellen.length, zeilen }], rollen: [], fingerabdruck: inventarFingerabdruck(teile), ...(inv.integritaet ? { integritaet: inv.integritaet } : {}), ...(inv.tabellen.some(t => t.zeilen === 'fehler') ? { hinweis: `nicht zählbar: ${inv.tabellen.filter(t => t.zeilen === 'fehler').map(t => t.name).join(', ')}` } : {}) };
}

export interface DbInventar {
  art: 'postgres' | 'redis' | 'mysql' | 'sqlite'; version: string; hauptversion: string;
  /** v1663 — z. B. SQLite-Tabellen, deren Zählung an beschädigten Seiten scheitert */
  hinweis?: string;
  /** v1668 — SQLite: Ergebnis von integrity_check auf der Kopie (nicht Teil des Fingerabdrucks) */
  integritaet?: 'ok' | 'fehler';
  datenbanken: Array<{ name: string; bytes?: number; tabellen?: number; zeilen?: number; schluessel?: number; encoding?: string; collate?: string; ctype?: string }>;
  rollen: string[]; fingerabdruck: string;
}

export function leseInventarBasis(t: string): { version: string; dbs: Array<{ name: string; bytes: number; encoding?: string; collate?: string; ctype?: string }>; rollen: string[] } {
  let version = ''; const dbs: Array<{ name: string; bytes: number; encoding?: string; collate?: string; ctype?: string }> = []; const rollen: string[] = [];
  const enc = new Map<string, { encoding: string; collate: string; ctype: string }>();
  for (const z of t.split(/\r?\n/).map(x => x.trim())) {
    let m: RegExpExecArray | null;
    if ((m = /^version\|(\d+)$/.exec(z))) version = m[1]!;
    else if ((m = /^db\|([^|]+)\|(\d+)$/.exec(z))) dbs.push({ name: m[1]!, bytes: Number(m[2]) });
    else if ((m = /^enc\|([^|]+)\|([^|]*)\|([^|]*)\|([^|]*)$/.exec(z))) enc.set(m[1]!, { encoding: m[2]!, collate: m[3]!, ctype: m[4]! });
    else if ((m = /^rolle\|(.+)$/.exec(z))) rollen.push(m[1]!);
  }
  return { version, dbs: dbs.map(d => ({ ...d, ...(enc.get(d.name) ?? {}) })), rollen };
}

export function inventarFingerabdruck(teile: string[]): string {
  return createHash('sha256').update(teile.join('\n')).digest('hex');
}

export async function datenbankInventar<Z>(w: Wege<Z>, z: Z, container: string, art: 'postgres' | 'redis' | 'mysql', nur?: string): Promise<DbInventar> {
  if (!gueltigerName(container)) throw new Error(`ungültiger Containername ${String(container).slice(0, 40)}`);
  if (art === 'mysql') return mysqlInventar(w, z, container);
  if (art === 'redis') {
    const r = await w.lauf(z, root(redisInventarBefehl(container)), '', 60_000);
    if (r.code !== 0) throw new Error(`Redis-Inventar gescheitert (Exit ${r.code}): ${r.stderr.trim().slice(-200)}`);
    const version = /redis_version:([\d.]+)/.exec(r.stdout)?.[1] ?? '';
    if (!version) throw new Error('Redis-Version nicht lesbar');
    const dbs = [...r.stdout.matchAll(/^(db\d+):keys=(\d+)/gm)].map(m => ({ name: m[1]!, schluessel: Number(m[2]) }));
    const hauptversion = version.split('.').slice(0, 2).join('.');
    return { art, version, hauptversion, datenbanken: dbs, rollen: [], fingerabdruck: inventarFingerabdruck([`redis ${hauptversion}`, ...dbs.map(d => `${d.name}|${d.schluessel}`)]) };
  }
  const b = await w.lauf(z, root(pgInventarBefehl(container, 'postgres')), PG_INVENTAR_SQL, 120_000);
  if (b.code !== 0) throw new Error(`PostgreSQL-Inventar gescheitert (Exit ${b.code}): ${b.stderr.trim().slice(-200)}`);
  const basis = leseInventarBasis(b.stdout);
  if (!basis.version || !basis.dbs.length) throw new Error('PostgreSQL-Version oder Datenbankliste nicht lesbar');
  const hauptversion = String(Math.floor(Number(basis.version) / 10000));
  const datenbanken: DbInventar['datenbanken'] = [];
  const teile = [`postgres ${hauptversion}`, ...basis.rollen.map(r => `rolle|${r}`)];
  // v1671 — gemeinsamer DB-Host: nur die genannte Datenbank zählen, fremde Datenbanken bleiben unberührt
  const auswahl = nur ? basis.dbs.filter(d => d.name === nur) : basis.dbs;
  if (nur && !auswahl.length) throw new Error(`Datenbank ${nur.slice(0, 60)} nicht gefunden (vorhanden: ${basis.dbs.map(d => d.name).join(', ').slice(0, 300)})`);
  if (nur) teile.push(`nur|${nur}`);
  for (const d of auswahl) {
    if (!gueltigerName(d.name)) { datenbanken.push({ ...d }); teile.push(`db|${d.name}|nicht gezählt`); continue; }
    const r = await w.lauf(z, root(pgInventarBefehl(container, d.name)), PG_ZAEHL_SQL, 600_000);
    if (r.code !== 0) throw new Error(`Zeilenzählung in ${d.name} gescheitert: ${r.stderr.trim().slice(-200)}`);
    const zl = leseZaehlung(r.stdout);
    const zeilen = [...zl.values()].reduce((x, y) => x + y, 0);
    datenbanken.push({ ...d, tabellen: zl.size, zeilen });
    teile.push(`db|${d.name}`, ...[...zl.entries()].sort((a, c) => a[0].localeCompare(c[0])).map(([t, n]) => `${d.name}.${t}|${n}`));
  }
  return { art, version: basis.version, hauptversion, datenbanken, rollen: basis.rollen, fingerabdruck: inventarFingerabdruck(teile) };
}

// ── v1648 MySQL/MariaDB (Vaultwarden-Umzug): Zugangsdaten aus der Umgebung des Containers, nur lesende Transaktion ──
// Passwort nie im Befehl: der Client im Container liest MYSQL_ROOT_PASSWORD bzw. MARIADB_ROOT_PASSWORD selbst (MYSQL_PWD).
export const mysqlInventarBefehl = (c: string) => `docker exec -i ${c} sh -c 'c=$(command -v mariadb || command -v mysql); MYSQL_PWD="\${MARIADB_ROOT_PASSWORD:-\${MYSQL_ROOT_PASSWORD:-}}" exec "$c" -u root -N -B --connect-timeout=10'`;
const MYSQL_SYSTEM = ['information_schema', 'performance_schema', 'mysql', 'sys'];
export const MYSQL_INVENTAR_SQL = [
  'SET SESSION TRANSACTION READ ONLY;',
  "SELECT CONCAT('version|', VERSION());",
  `SELECT CONCAT('db|', s.schema_name, '|', COALESCE(SUM(t.data_length + t.index_length), 0)) FROM information_schema.schemata s LEFT JOIN information_schema.tables t ON t.table_schema = s.schema_name WHERE s.schema_name NOT IN (${MYSQL_SYSTEM.map(x => `'${x}'`).join(',')}) GROUP BY s.schema_name ORDER BY s.schema_name;`,
  `SELECT CONCAT('tab|', table_schema, '|', table_name) FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema NOT IN (${MYSQL_SYSTEM.map(x => `'${x}'`).join(',')}) ORDER BY table_schema, table_name;`,
  "SELECT CONCAT('rolle|', user, '@', host) FROM mysql.user ORDER BY user, host;",
].join('\n') + '\n';
const mysqlName = (x: string) => '`' + x.replace(/`/g, '``') + '`';

async function mysqlInventar<Z>(w: Wege<Z>, z: Z, container: string): Promise<DbInventar> {
  const b = await w.lauf(z, root(mysqlInventarBefehl(container)), MYSQL_INVENTAR_SQL, 120_000);
  if (b.code !== 0) throw new Error(`MySQL-Inventar gescheitert (Exit ${b.code}): ${b.stderr.trim().slice(-200)}`);
  let version = ''; const dbs: Array<{ name: string; bytes: number }> = []; const tabellen: Array<[string, string]> = []; const rollen: string[] = [];
  for (const zl of b.stdout.split(/\r?\n/).map(x => x.trim())) {
    let m: RegExpExecArray | null;
    if ((m = /^version\|(.+)$/.exec(zl))) version = m[1]!;
    else if ((m = /^db\|([^|]+)\|(\d+)$/.exec(zl))) dbs.push({ name: m[1]!, bytes: Number(m[2]) });
    else if ((m = /^tab\|([^|]+)\|(.+)$/.exec(zl))) tabellen.push([m[1]!, m[2]!]);
    else if ((m = /^rolle\|(.+)$/.exec(zl))) rollen.push(m[1]!);
  }
  if (!version) throw new Error('MySQL-Version nicht lesbar');
  const zaehlung = new Map<string, number>();
  // v1648 (Sicherheitsprüfung) — Namen landen in SQL: nur einfache Namen zählen (kein Quote/Backslash möglich), andere als „nicht gezählt“
  // im Fingerabdruck; zusätzlich NO_BACKSLASH_ESCAPES, damit ein Backslash nie ein Literal verlassen kann
  const einfach = (x: string) => /^[A-Za-z0-9_$-]{1,64}$/.test(x);
  const zaehlbar = tabellen.filter(([d, t]) => einfach(d) && einfach(t));
  const nichtGezaehlt = tabellen.filter(([d, t]) => !(einfach(d) && einfach(t))).map(([d, t]) => `${d}.${t}`);
  if (zaehlbar.length) {
    const sql = "SET SESSION sql_mode = CONCAT(@@sql_mode, ',NO_BACKSLASH_ESCAPES');\nSET SESSION TRANSACTION READ ONLY;\n" + zaehlbar.map(([d, t]) => `SELECT CONCAT('${d}.${t}|', COUNT(*)) FROM ${mysqlName(d)}.${mysqlName(t)};`).join('\n') + '\n';
    const r = await w.lauf(z, root(mysqlInventarBefehl(container)), sql, 600_000);
    if (r.code !== 0) throw new Error(`Zeilenzählung (MySQL) gescheitert: ${r.stderr.trim().slice(-200)}`);
    for (const [k, v] of leseZaehlung(r.stdout)) zaehlung.set(k, v);
  }
  const hauptversion = (/^(\d+\.\d+)/.exec(version)?.[1] ?? version) + (/mariadb/i.test(version) ? '-MariaDB' : '');
  const datenbanken: DbInventar['datenbanken'] = dbs.map(d => {
    const eigene = [...zaehlung.entries()].filter(([k]) => k.startsWith(`${d.name}.`));
    return { name: d.name, bytes: d.bytes, tabellen: eigene.length, zeilen: eigene.reduce((x, [, n]) => x + n, 0) };
  });
  const teile = [`mysql ${hauptversion}`, ...rollen.map(r => `rolle|${r}`), ...dbs.map(d => `db|${d.name}`), ...[...zaehlung.entries()].sort((a, c) => a[0].localeCompare(c[0])).map(([t, n]) => `${t}|${n}`), ...nichtGezaehlt.sort().map(t => `${t}|nicht gezählt`)];
  return { art: 'mysql', version, hauptversion, datenbanken, rollen, fingerabdruck: inventarFingerabdruck(teile) };
}
