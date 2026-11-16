/**
 * I8e Paket 1 (Vorhaben c7e02aff v2) — SQL Server 2025 Enterprise Developer auf Ubuntu 24.04 über feste Bash-Bausteine:
 * Platten (XFS, Einhängen per UUID), Installation aus der signierten Microsoft-Paketquelle mit fester Version, Konfiguration
 * (mssql-conf), T-SQL-Bausteine (tempdb, max server memory, SQL-Login) und Status.
 *
 * Alle Erzeuger sind reine Funktionen und werden beim Laden des Moduls im Linux-Baustein-Register angemeldet
 * (`registriereLinuxBaustein`); `FernzugriffSkill.linuxSkript(…, baustein, parameter, eingabe, timeoutMs, zweck)` führt sie aus.
 * Regeln:
 * - Parameter werden streng geprüft (Ganzzahlen, feste Pfad-Listen, Versions-Muster) und nur über `shQ` in den Text gesetzt;
 *   zusätzlich steht der Parameter-Satz als JSON-Literal `ALFRED_P` im Kopf.
 * - Geheimnisse (sa-Kennwort `sa`, Login-Kennwort `kennwort`) kommen ausschließlich als JSON in der ersten stdin-Zeile
 *   ("$ALFRED_EINGABE", vom Transport gelesen) und werden nur per Here-String an python3 gereicht. Danach leben sie in einer
 *   Shell-Variablen und gehen nur als Umgebung des einen Prozesses weiter (`MSSQL_SA_PASSWORD` an mssql-conf setup,
 *   `SQLCMDPASSWORD` an sqlcmd) bzw. als T-SQL über stdin an sqlcmd — nie Befehlszeile, nie Ausgabe.
 * - Kennwort-Alphabet (Aufrufer, Task 3): ohne `"` und `\` (Schwärzung im Transport vergleicht JSON-Zeichenketten);
 *   `'` wäre im Login-Baustein sicher verdoppelt, wird aber ebenfalls nicht benötigt.
 * - Genau eine Ergebniszeile `ALFRED-SQL {json}`; Fehler → `{"zustand":"fehler","fehler":…}` und Exit 1.
 * - Jeder Baustein ist idempotent (`zustand: 'schon'`) und prüft sein Ergebnis selbst.
 */
import { createHash } from 'node:crypto';
import { registriereLinuxBaustein } from '../fernzugriff/linux-bausteine.js';

// ── Feste Werte (Quellen im Bericht task-2-report.md) ────────────────────────────────────────────────────────────────────────

export const LINUX_SQL_ZIELE = ['/var/opt/mssql/data', '/var/opt/mssql/log', '/var/opt/mssql/tempdb', '/var/opt/mssql/backup'] as const;
export type LinuxSqlZiel = typeof LINUX_SQL_ZIELE[number];
const LABEL: Record<LinuxSqlZiel, string> = {
  '/var/opt/mssql/data': 'mssql-data', '/var/opt/mssql/log': 'mssql-log', '/var/opt/mssql/tempdb': 'mssql-tempdb', '/var/opt/mssql/backup': 'mssql-backup',
};
export const TEMPDB_PFAD = '/var/opt/mssql/tempdb/';

/** Microsoft-Paketschlüssel (signiert mssql-server-2025 und prod für noble; geprüft 16.11.2026 per gpg --verify InRelease) */
export const MS_SCHLUESSEL_URL = 'https://packages.microsoft.com/keys/microsoft.asc';
export const MS_SCHLUESSEL_FPR = 'BC528686B50D79E339D3721CEB3E94ADBE1229CF';
export const MS_KEYRING = '/usr/share/keyrings/microsoft-prod.gpg';
/** Inhalt von packages.microsoft.com/config/ubuntu/24.04/mssql-server-2025.list bzw. prod.list, fest auf amd64 */
export const MS_QUELLE_SERVER = `deb [arch=amd64 signed-by=${MS_KEYRING}] https://packages.microsoft.com/ubuntu/24.04/mssql-server-2025 noble main`;
export const MS_QUELLE_WERKZEUGE = `deb [arch=amd64 signed-by=${MS_KEYRING}] https://packages.microsoft.com/ubuntu/24.04/prod noble main`;
export const SQLCMD = '/opt/mssql-tools18/bin/sqlcmd';
/** feste Werkzeug-Versionen (prod noble, 16.11.2026 vorhanden) */
export const MSSQL_TOOLS18_VERSION = '18.6.2.1-1';
export const MSODBCSQL18_VERSION = '18.6.2.1-1';
/** erster CU-Build von SQL Server 2025 (CU1 = 17.0.4006.2, KB5078298) */
export const SQL2025_CU1_BUILD = 4006;

export const LINUX_SQL_BAUSTEINE = {
  platten: 'sql.platten', installation: 'sql.installation', konfiguration: 'sql.konfiguration',
  tempdb: 'sql.tempdb', maxspeicher: 'sql.maxspeicher', login: 'sql.login', status: 'sql.status', pruefdaten: 'sql.pruefdaten',
} as const;

/** Zeitgrenzen für `linuxSkript(…, timeoutMs, …)` — am Host läuft das Skript bis timeoutMs − 20 s */
export const LINUX_SQL_ZEIT_MS = {
  platten: 180_000, installation: 1_500_000, konfiguration: 300_000, tempdb: 300_000, maxspeicher: 90_000, login: 90_000, status: 90_000, pruefdaten: 180_000,
} as const;

// ── Hilfen ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Shell-Literal in einfachen Anführungszeichen (' → '\'') */
export const shQ = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const ganz = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const istZiel = (v: unknown): v is LinuxSqlZiel => typeof v === 'string' && (LINUX_SQL_ZIELE as readonly string[]).includes(v);
const obj = (p: unknown): Record<string, unknown> => (p && typeof p === 'object' && !Array.isArray(p) ? p as Record<string, unknown> : {});
const pruefe = (f: string | undefined) => { if (f) throw new Error(f); };

/** letzte Ergebniszeile `ALFRED-SQL {json}` aus der Ausgabe */
export function sqlErgebnis<T = Record<string, unknown>>(aus: string): T | undefined {
  const zeilen = aus.split(/\r?\n/).filter(z => z.startsWith('ALFRED-SQL '));
  if (!zeilen.length) return undefined;
  try { return JSON.parse(zeilen[zeilen.length - 1].slice('ALFRED-SQL '.length)) as T; } catch { return undefined; }
}

/** python3: Feld argv[1] aus dem JSON auf stdin (nur Zeichenketten) */
export const PY_FELD = [
  'import json, sys',
  'try:',
  '    v = json.loads(sys.stdin.read() or "{}").get(sys.argv[1])',
  'except Exception:',
  '    v = None',
  'if not isinstance(v, str):',
  '    v = ""',
  '# nie still kürzen: Zeilenumbruch, NUL, Tab, Steuerzeichen → Exit 3 ohne Ausgabe',
  'if not all(c.isprintable() for c in v):',
  '    sys.exit(3)',
  'sys.stdout.write(v)',
].join('\n');

/** python3: Wert [argv[1]] argv[2] aus /var/opt/mssql/mssql.conf */
export const PY_CONF = [
  'import configparser, sys',
  'c = configparser.ConfigParser(interpolation=None)',
  'c.read("/var/opt/mssql/mssql.conf")',
  'sys.stdout.write(c.get(sys.argv[1], sys.argv[2], fallback=""))',
].join('\n');

/**
 * gemeinsamer Kopf: strikter Modus, Parameter-Literal, Ergebnis-/Fehlerzeile, Aufräumen.
 * `p` ist immer der vom Erzeuger neu gebaute Satz NUR geprüfter Felder — nie das Eingabeobjekt (fremde Schlüssel wie
 * `kennwort` dürfen nie in den Skripttext).
 */
function kopf(baustein: string, p: Record<string, unknown>): string[] {
  return [
    'set -euo pipefail',
    'export LC_ALL=C PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    `ALFRED_BAUSTEIN=${shQ(baustein)}`,
    `ALFRED_P=${shQ(JSON.stringify(p))}`,
    "ALFRED_ZEILE=''",
    "ALFRED_TMP=''",
    `ergebnis() { ALFRED_ZEILE=1; printf 'ALFRED-SQL %s\\n' "$1"; }`,
    `json_text() { python3 -c 'import json,sys; sys.stdout.write(json.dumps(sys.stdin.read()))'; }`,
    `abbruch() { local t; t=$(printf '%s' "$1" | json_text); ergebnis "{\\"zustand\\":\\"fehler\\",\\"baustein\\":\\"$ALFRED_BAUSTEIN\\",\\"fehler\\":$t}"; exit 1; }`,
    `trap 'ALFRED_RC=$?; [ -z "$ALFRED_TMP" ] || rm -rf -- "$ALFRED_TMP"; if [ "$ALFRED_RC" -ne 0 ] && [ -z "$ALFRED_ZEILE" ]; then printf "ALFRED-SQL {\\"zustand\\":\\"fehler\\",\\"baustein\\":\\"%s\\",\\"fehler\\":\\"unerwarteter Abbruch (Exit %s)\\"}\\n" "$ALFRED_BAUSTEIN" "$ALFRED_RC"; fi' EXIT`,
    `feld() { python3 -c ${shQ(PY_FELD)} "$1" <<<"$ALFRED_EINGABE"; }`,
  ];
}

/** sqlcmd lokal als sa: Kennwort nur in SQLCMDPASSWORD des einen Prozesses, T-SQL über stdin, ohne Variablenersetzung (-x) */
const SQL_HILFE = [
  `SQLCMD=${shQ(SQLCMD)}`,
  'sql() { SQLCMDPASSWORD="$SA" "$SQLCMD" -C -b -x -S localhost -U sa -l 30 -h -1 -W -w 65535 <<<"$1"; }',
  'bereit() { local i; for i in $(seq 1 60); do if sql "SELECT 1" >/dev/null 2>&1; then return 0; fi; sleep 2; done; return 1; }',
  'alfred_zeile() { grep "^ALFRED|" <<<"$1" | head -n 1 | tr -d "\\r" || true; }',
  'kurz() { printf "%s" "$1" | tail -n 6 | tr "\\r\\n" "  "; }',
];
/** Stubs für Tests setzen hier ein (nach den Hilfsfunktionen, vor dem Lesen der Eingabe) */
const MARKE = '# ALFRED-ABLAUF';
const SA_LESEN = [
  MARKE,
  'SA=$(feld sa) || abbruch "sa-Kennwort enthält nicht druckbare Zeichen"',
  '[ -n "$SA" ] || abbruch "sa-Kennwort fehlt in der Eingabe (erste stdin-Zeile, JSON-Feld sa)"',
  // nur druckbare Zeichen: kein Zeilenumbruch (sqlcmd-Befehle wie !! am Zeilenanfang), keine Steuerzeichen
  '[[ "$SA" =~ ^[[:print:]]+$ ]] || abbruch "sa-Kennwort enthält nicht druckbare Zeichen"',
];

// ── Platten ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface PlattenParameter { platten: Array<{ scsi: number; groesseGiB: number; ziel: LinuxSqlZiel }> }

export function pruefePlatten(p: unknown): string | undefined {
  const pl = obj(p).platten;
  if (!Array.isArray(pl) || pl.length < 1 || pl.length > 4) return 'platten: 1–4 Einträge erwartet';
  const scsi = new Set<number>(); const ziele = new Set<string>();
  for (const [i, e] of pl.entries()) {
    const x = obj(e);
    if (!ganz(x.scsi, 1, 6)) return `platten[${i}].scsi: ganze Zahl 1–6 (scsi0 = Systemplatte, scsi7 = Cloud-Init)`;
    if (!ganz(x.groesseGiB, 1, 4096)) return `platten[${i}].groesseGiB: ganze Zahl 1–4096`;
    if (!istZiel(x.ziel)) return `platten[${i}].ziel: nur ${LINUX_SQL_ZIELE.join(', ')}`;
    if (scsi.has(x.scsi as number)) return `platten: scsi${x.scsi} doppelt`;
    if (ziele.has(x.ziel)) return `platten: Ziel ${x.ziel} doppelt`;
    scsi.add(x.scsi as number); ziele.add(x.ziel);
  }
  return undefined;
}

const PLATTEN_KOERPER = `FSTAB=/etc/fstab
BYPATH=/dev/disk/by-path
# Proxmox virtio-scsi(-single): Laufwerk scsiN hängt an scsi-id=0, lun=N → Gast-Adresse H:0:0:N, Pfad …-scsi-0:0:0:N
geraet_zu_scsi() {
  local t=() x
  shopt -s nullglob
  for x in "$BYPATH"/*-scsi-0:0:0:"$1"; do [ -b "$x" ] && t+=("$x"); done
  shopt -u nullglob
  if [ "\${#t[@]}" -ne 1 ]; then echo "\${#t[@]} -"; return 0; fi
  echo "1 $(readlink -f "\${t[0]}")"
}
geraete_liste() {
  { ls -1 "$BYPATH" 2>/dev/null | grep -v -- '-part[0-9]*$' | tr '\\n' ' '; lsblk -dnpo NAME,SIZE,HCTL,TYPE,FSTYPE 2>/dev/null | tr -s ' ' | tr '\\n' ';'; } || true
}
ziel_leer() { [ ! -e "$1" ] || { [ -d "$1" ] && [ -z "$(ls -A "$1")" ]; }; }
quelle_von() { findmnt -rn -o SOURCE --mountpoint "$1" 2>/dev/null || true; }
fstab_eintrag() { awk -v z="$1" '$1 !~ /^#/ && $2 == z { print $1 }' "$FSTAB"; }
eingehaengt_an() { findmnt -rn -o TARGET -S "$1" 2>/dev/null || true; }
# ALFRED-ABLAUF
# Phase 1: alle Platten prüfen — bis hierhin wird nichts geändert
AKTION=(); GERAET=(); UUIDS=()
for i in "\${!SCSI[@]}"; do
  n=\${SCSI[$i]}; z=\${ZIEL[$i]}; soll=$(( GIB[i] * 1073741824 ))
  read -r anzahl dev <<<"$(geraet_zu_scsi "$n")"
  [ "$anzahl" = 1 ] || abbruch "scsi$n: $anzahl Geräte mit SCSI-Adresse 0:0:0:$n unter $BYPATH (erwartet genau 1) — nichts geändert. Vorhanden: $(geraete_liste)"
  [[ "$dev" =~ ^/dev/[a-z][a-z0-9]*$ ]] || abbruch "scsi$n: unerwarteter Gerätename $dev — nichts geändert"
  [ "$(lsblk -dno TYPE "$dev")" = disk ] || abbruch "scsi$n: $dev ist keine Platte — nichts geändert"
  hctl=$(lsblk -dno HCTL "$dev" | tr -d ' ')
  [ "\${hctl#*:}" = "0:0:$n" ] || abbruch "scsi$n: $dev hat SCSI-Adresse $hctl — nichts geändert"
  ist=$(blockdev --getsize64 "$dev")
  ab=$(( ist - soll )); ab=\${ab#-}
  [ $(( ab * 100 )) -le "$soll" ] || abbruch "scsi$n: $dev hat $ist Bytes, erwartet \${GIB[$i]} GiB (±1 %) — nichts geändert. Vorhanden: $(geraete_liste)"
  for j in "\${!GERAET[@]}"; do [ "\${GERAET[$j]}" != "$dev" ] || abbruch "scsi$n: $dev ist schon scsi\${SCSI[$j]} zugeordnet — nichts geändert"; done
  GERAET[i]=$dev
  [ "$(lsblk -nro NAME "$dev" | wc -l)" -eq 1 ] || abbruch "scsi$n: $dev hat Partitionen oder Unterlaufwerke — nichts geändert"
  sig=$(blkid -p -o export "$dev" 2>/dev/null || true)
  ws=$(wipefs --noheadings --output TYPE "$dev" 2>/dev/null || true)
  typ=$(blkid -p -s TYPE -o value "$dev" 2>/dev/null || true)
  lab=$(blkid -p -s LABEL -o value "$dev" 2>/dev/null || true)
  uid=$(blkid -p -s UUID -o value "$dev" 2>/dev/null || true)
  q=$(quelle_von "$z"); fe=$(fstab_eintrag "$z"); woanders=$(eingehaengt_an "$dev")
  if [ -z "$sig" ] && [ -z "$ws" ]; then
    [ -z "$woanders" ] || abbruch "scsi$n: $dev ist an $woanders eingehängt — nichts geändert"
    [ -z "$q" ] || abbruch "$z ist schon eingehängt ($q) — nichts geändert"
    [ -z "$fe" ] || abbruch "$FSTAB enthält schon $z ($fe) — nichts geändert"
    ziel_leer "$z" || abbruch "$z ist nicht leer — nichts geändert"
    AKTION[i]=leer; UUIDS[i]=''
  elif [ "$typ" = xfs ] && [ "$lab" = "\${LABEL[$i]}" ] && [[ "$uid" =~ ^[0-9a-f-]{36}$ ]]; then
    [ -z "$fe" ] || [ "$fe" = "UUID=$uid" ] || abbruch "$FSTAB hängt $z anders ein ($fe) — nichts geändert"
    [ -z "$woanders" ] || [ "$woanders" = "$z" ] || abbruch "scsi$n: $dev ist an $woanders eingehängt — nichts geändert"
    if [ -n "$q" ]; then
      [ "$(readlink -f "$q")" = "$dev" ] || abbruch "$z ist mit $q eingehängt, erwartet $dev — nichts geändert"
    else
      ziel_leer "$z" || abbruch "$z ist nicht leer — nichts geändert"
    fi
    AKTION[i]=unser; UUIDS[i]=$uid
  else
    abbruch "scsi$n: $dev ist nicht leer (Signatur: \${typ:-$(printf '%s' "$ws" | tr '\\n' ' ')}\${lab:+, Label $lab}) — nichts geändert"
  fi
done
# Phase 2: formatieren (nur leere Platten), fstab per UUID, einhängen, nachprüfen
GEAENDERT=0; FSTAB_NEU=0
for i in "\${!SCSI[@]}"; do
  dev=\${GERAET[$i]}; z=\${ZIEL[$i]}
  if [ "\${AKTION[$i]}" = leer ]; then
    mkfs.xfs -q -K -L "\${LABEL[$i]}" "$dev"
    udevadm settle || true
    UUIDS[i]=$(blkid -p -s UUID -o value "$dev" 2>/dev/null || true)
    [[ "\${UUIDS[$i]}" =~ ^[0-9a-f-]{36}$ ]] || abbruch "scsi\${SCSI[$i]}: nach mkfs.xfs keine UUID auf $dev"
    AKTION[i]=formatiert; GEAENDERT=1
  fi
  if [ -z "$(fstab_eintrag "$z")" ]; then
    if [ "$FSTAB_NEU" = 0 ]; then
      cp -p "$FSTAB" "$FSTAB.alfred-$(date +%Y%m%d%H%M%S)"
      # letzte Zeile ohne Zeilenende nie mit dem neuen Eintrag verschmelzen
      [ -z "$(tail -c1 "$FSTAB")" ] || printf '\\n' >>"$FSTAB"
    fi
    printf 'UUID=%s %s xfs defaults,noatime,nofail 0 0\\n' "\${UUIDS[$i]}" "$z" >>"$FSTAB"
    FSTAB_NEU=1; GEAENDERT=1
    [ "\${AKTION[$i]}" != unser ] || AKTION[i]=eingetragen
  fi
done
[ "$FSTAB_NEU" = 0 ] || systemctl daemon-reload
ERG=''
for i in "\${!SCSI[@]}"; do
  dev=\${GERAET[$i]}; z=\${ZIEL[$i]}
  mkdir -p "$z"
  if [ -z "$(quelle_von "$z")" ]; then
    mount "$z"; GEAENDERT=1
    [ "\${AKTION[$i]}" != unser ] || AKTION[i]=eingehaengt
  fi
  { [ "$(readlink -f "$(quelle_von "$z")")" = "$dev" ] && [ "$(findmnt -rn -o FSTYPE --mountpoint "$z")" = xfs ]; } || abbruch "$z: nach dem Einhängen nicht $dev mit XFS"
  [ "\${AKTION[$i]}" != unser ] || AKTION[i]=schon
  ERG+="\${ERG:+,}{\\"scsi\\":\${SCSI[$i]},\\"geraet\\":\\"$dev\\",\\"ziel\\":\\"$z\\",\\"uuid\\":\\"\${UUIDS[$i]}\\",\\"groesseGiB\\":\${GIB[$i]},\\"aktion\\":\\"\${AKTION[$i]}\\"}"
done
if [ "$GEAENDERT" = 1 ]; then Z=geaendert; else Z=schon; fi
ergebnis "{\\"zustand\\":\\"$Z\\",\\"platten\\":[$ERG]}"`;

/** Platten finden (SCSI-Adresse + Größe ±1 %), nur leere formatieren (XFS), fstab per UUID mit nofail, einhängen. Zeit: LINUX_SQL_ZEIT_MS.platten */
export function plattenSkript(p: PlattenParameter): string {
  pruefe(pruefePlatten(p));
  const ps = p.platten;
  return [
    ...kopf(LINUX_SQL_BAUSTEINE.platten, { platten: ps.map(x => ({ scsi: x.scsi, groesseGiB: x.groesseGiB, ziel: x.ziel })) }),
    `SCSI=(${ps.map(x => x.scsi).join(' ')})`,
    `GIB=(${ps.map(x => x.groesseGiB).join(' ')})`,
    `ZIEL=(${ps.map(x => shQ(x.ziel)).join(' ')})`,
    `LABEL=(${ps.map(x => shQ(LABEL[x.ziel])).join(' ')})`,
    PLATTEN_KOERPER,
  ].join('\n');
}

// ── Installation ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface InstallParameter {
  version: string; edition: 'EnterpriseDeveloper'; werkzeugVersion?: string; odbcVersion?: string;
  /** vor setup Pflicht-Einhängepunkte (Standard: alle vier Plattenziele); data immer dabei */
  einhaengepunkte?: LinuxSqlZiel[];
}
const SQL_VERSION = /^17\.0\.(\d{4})\.\d{1,3}-\d{1,3}$/;
const WERKZEUG_VERSION = /^18\.\d{1,2}\.\d{1,2}\.\d{1,2}-\d{1,2}$/;

export function pruefeInstallation(p: unknown): string | undefined {
  const x = obj(p);
  const m = typeof x.version === 'string' ? SQL_VERSION.exec(x.version) : null;
  if (!m) return 'version: Paketversion wie 17.0.4006.2-1 erwartet (apt-Version mit Revision)';
  if (Number(m[1]) < SQL2025_CU1_BUILD) return `version: erst ab CU1 (Build ≥ 17.0.${SQL2025_CU1_BUILD}), ${x.version} ist älter oder ein RTM-GDR`;
  if (x.edition !== 'EnterpriseDeveloper') return 'edition: nur EnterpriseDeveloper';
  if (x.werkzeugVersion !== undefined && !(typeof x.werkzeugVersion === 'string' && WERKZEUG_VERSION.test(x.werkzeugVersion))) return 'werkzeugVersion: wie 18.6.2.1-1';
  if (x.odbcVersion !== undefined && !(typeof x.odbcVersion === 'string' && WERKZEUG_VERSION.test(x.odbcVersion))) return 'odbcVersion: wie 18.6.2.1-1';
  if (x.einhaengepunkte !== undefined) {
    const e = x.einhaengepunkte;
    if (!Array.isArray(e) || !e.every(istZiel) || new Set(e).size !== e.length || !e.includes('/var/opt/mssql/data')) {
      return `einhaengepunkte: Teilmenge von ${LINUX_SQL_ZIELE.join(', ')} ohne Dubletten, /var/opt/mssql/data Pflicht`;
    }
  }
  return undefined;
}

const INSTALL_KOERPER = `export DEBIAN_FRONTEND=noninteractive
paket_version() { dpkg-query -W -f='\${Status}|\${Version}' "$1" 2>/dev/null | awk -F'|' '$1 == "install ok installed" { print $2 }' || true; }
schreibe_wenn_anders() { if [ "$(cat "$1" 2>/dev/null || true)" != "$2" ]; then printf '%s\\n' "$2" >"$1.alfred-neu"; chmod 0644 "$1.alfred-neu"; mv -f "$1.alfred-neu" "$1"; GEAENDERT=1; fi; }
GEAENDERT=0
# vorhandene, abweichende Version wird hier nie geändert (Update = eigener Change)
for pv in "mssql-server=$V" "mssql-tools18=$VT" "msodbcsql18=$VO"; do
  pk=\${pv%%=*}; sv=\${pv#*=}; iv=$(paket_version "$pk")
  [ -z "$iv" ] || [ "$iv" = "$sv" ] || abbruch "$pk ist in Version $iv installiert, erwartet $sv — die Installation ändert keine vorhandene Version"
done
if [ "$(paket_version mssql-server)" = "$V" ] && [ "$(paket_version mssql-tools18)" = "$VT" ] && [ "$(paket_version msodbcsql18)" = "$VO" ] \\
   && [ -f /var/opt/mssql/data/master.mdf ] && systemctl is-active --quiet mssql-server && systemctl is-enabled --quiet mssql-server; then
  Z=schon
else
  # Plattenziele müssen eingehängt sein, bevor setup die Systemdatenbanken anlegt (sonst landen sie auf der OS-Platte)
  for d in "\${EINHAENGEN[@]}"; do mountpoint -q "$d" || abbruch "$d ist kein eigener Einhängepunkt (Platten-Schritt fehlt) — nichts geändert"; done
  command -v curl >/dev/null && command -v gpg >/dev/null || abbruch "curl oder gpg fehlt"
  ALFRED_TMP=$(mktemp -d /run/alfred-sql.XXXXXX)
  # Microsoft-Schlüssel: genau ein Primärschlüssel mit festem Fingerabdruck
  curl -fsSL --proto '=https' --tlsv1.2 --max-time 60 -o "$ALFRED_TMP/ms.asc" "$SCHLUESSEL_URL" || abbruch "Microsoft-Schlüssel nicht ladbar ($SCHLUESSEL_URL)"
  mkdir -m 700 "$ALFRED_TMP/gnupg"
  fprs=$(GNUPGHOME="$ALFRED_TMP/gnupg" gpg --batch --with-colons --show-keys "$ALFRED_TMP/ms.asc" 2>/dev/null | awk -F: '$1 == "pub" { n = 1; next } n && $1 == "fpr" { print $10; n = 0 }' | tr '\\n' ' ' | sed 's/ $//')
  [ "$fprs" = "$FPR" ] || abbruch "Microsoft-Schlüssel hat Fingerabdruck '$fprs', erwartet $FPR — nichts geändert"
  GNUPGHOME="$ALFRED_TMP/gnupg" gpg --batch --yes --dearmor -o "$ALFRED_TMP/microsoft-prod.gpg" "$ALFRED_TMP/ms.asc"
  if ! cmp -s "$ALFRED_TMP/microsoft-prod.gpg" "$KEYRING"; then install -m 0644 -o root -g root "$ALFRED_TMP/microsoft-prod.gpg" "$KEYRING"; GEAENDERT=1; fi
  schreibe_wenn_anders /etc/apt/sources.list.d/mssql-server-2025.list "$Q_SERVER"
  schreibe_wenn_anders /etc/apt/sources.list.d/mssql-release.list "$Q_WERKZEUGE"
  apt-get -o DPkg::Lock::Timeout=300 update -q >"$ALFRED_TMP/apt.log" 2>&1 || abbruch "apt-get update fehlgeschlagen: $(kurz "$(cat "$ALFRED_TMP/apt.log")")"
  for pv in "mssql-server=$V" "mssql-tools18=$VT" "msodbcsql18=$VO"; do
    pk=\${pv%%=*}; sv=\${pv#*=}
    vs=$(apt-cache madison "$pk" | awk -F'|' '{ gsub(/ /, "", $2); print $2 }')
    grep -qxF "$sv" <<<"$vs" || abbruch "$pk=$sv ist in der Paketquelle nicht verfügbar — nichts installiert"
  done
  if ! ACCEPT_EULA=Y apt-get -o DPkg::Lock::Timeout=300 install -y -q --no-install-recommends -o Dpkg::Options::=--force-confold "mssql-server=$V" "mssql-tools18=$VT" "msodbcsql18=$VO" >"$ALFRED_TMP/apt.log" 2>&1; then
    abbruch "apt-get install fehlgeschlagen: $(kurz "$(cat "$ALFRED_TMP/apt.log")")"
  fi
  apt-mark -o DPkg::Lock::Timeout=300 hold mssql-server mssql-tools18 msodbcsql18 >/dev/null
  GEAENDERT=1
  id mssql >/dev/null 2>&1 || abbruch "Benutzer mssql fehlt nach der Installation"
  # Plattenziele (schon eingehängt, root-eigen) dem Dienstkonto geben, bevor setup die Systemdatenbanken anlegt
  [ "$(stat -c %U /var/opt/mssql)" = mssql ] || chown mssql:mssql /var/opt/mssql
  for d in "\${ZIELE[@]}"; do if [ -d "$d" ]; then chown mssql:mssql "$d"; chmod 0750 "$d"; fi; done
  if [ ! -f /var/opt/mssql/data/master.mdf ]; then
    if ! MSSQL_SA_PASSWORD="$SA" MSSQL_PID="$PID" /opt/mssql/bin/mssql-conf -n setup accept-eula >"$ALFRED_TMP/setup.log" 2>&1; then
      abbruch "mssql-conf setup fehlgeschlagen: $(kurz "$(cat "$ALFRED_TMP/setup.log")")"
    fi
  fi
  systemctl enable --now mssql-server >/dev/null 2>&1 || abbruch "mssql-server lässt sich nicht aktivieren/starten"
  Z=geaendert
fi
# Selbstprüfung: Dienst aktiv + aktiviert, Anmeldung als sa, Version und Edition
bereit || abbruch "SQL Server antwortet nicht als sa (120 s)"
systemctl is-enabled --quiet mssql-server || abbruch "mssql-server ist nicht aktiviert"
z=$(alfred_zeile "$(sql "SET NOCOUNT ON; SELECT N'ALFRED|' + CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(40)) + N'|' + CAST(SERVERPROPERTY('EngineEdition') AS nvarchar(5)) + N'|' + CAST(SERVERPROPERTY('Edition') AS nvarchar(80))")")
IFS='|' read -r _ pv ee ed <<<"$z"
[ "$pv" = "\${V%-*}" ] || abbruch "SQL Server meldet Version '$pv', erwartet \${V%-*}"
{ [ "$ee" = 3 ] && [[ "$ed" == *Developer* ]]; } || abbruch "SQL Server meldet Edition '$ed' (EngineEdition $ee), erwartet Enterprise Developer"
ergebnis "{\\"zustand\\":\\"$Z\\",\\"paket\\":\\"$V\\",\\"version\\":\\"$pv\\",\\"edition\\":$(printf '%s' "$ed" | json_text),\\"dienst\\":\\"active\\"}"`;

/** Microsoft-Quelle (Schlüssel mit festem Fingerabdruck), feste Paketversionen, mssql-conf setup (sa aus stdin). Zeit: LINUX_SQL_ZEIT_MS.installation */
export function installSkript(p: InstallParameter): string {
  pruefe(pruefeInstallation(p));
  return [
    ...kopf(LINUX_SQL_BAUSTEINE.installation, {
      version: p.version, edition: p.edition, werkzeugVersion: p.werkzeugVersion ?? MSSQL_TOOLS18_VERSION,
      odbcVersion: p.odbcVersion ?? MSODBCSQL18_VERSION, einhaengepunkte: p.einhaengepunkte ?? [...LINUX_SQL_ZIELE],
    }),
    `V=${shQ(p.version)}`,
    `VT=${shQ(p.werkzeugVersion ?? MSSQL_TOOLS18_VERSION)}`,
    `VO=${shQ(p.odbcVersion ?? MSODBCSQL18_VERSION)}`,
    `PID=${shQ(p.edition)}`,
    `FPR=${shQ(MS_SCHLUESSEL_FPR)}`,
    `SCHLUESSEL_URL=${shQ(MS_SCHLUESSEL_URL)}`,
    `KEYRING=${shQ(MS_KEYRING)}`,
    `Q_SERVER=${shQ(MS_QUELLE_SERVER)}`,
    `Q_WERKZEUGE=${shQ(MS_QUELLE_WERKZEUGE)}`,
    `ZIELE=(${LINUX_SQL_ZIELE.map(shQ).join(' ')})`,
    `EINHAENGEN=(${(p.einhaengepunkte ?? [...LINUX_SQL_ZIELE]).map(shQ).join(' ')})`,
    ...SQL_HILFE,
    ...SA_LESEN,
    INSTALL_KOERPER,
  ].join('\n');
}

// ── Konfiguration ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface KonfigParameter { speicherLimitMB: number; datenPfad: string; logPfad: string; sicherungsPfad: string; agent: boolean }

export function pruefeKonfig(p: unknown): string | undefined {
  const x = obj(p);
  if (!ganz(x.speicherLimitMB, 2048, 1_048_576)) return 'speicherLimitMB: ganze Zahl 2048–1048576';
  for (const k of ['datenPfad', 'logPfad', 'sicherungsPfad'] as const) if (!istZiel(x[k])) return `${k}: nur ${LINUX_SQL_ZIELE.join(', ')}`;
  if (new Set([x.datenPfad, x.logPfad, x.sicherungsPfad]).size !== 3) return 'datenPfad, logPfad, sicherungsPfad: Pfad doppelt';
  if (typeof x.agent !== 'boolean') return 'agent: true oder false';
  return undefined;
}

const KONFIG_KOERPER = `MSSQLCONF=/opt/mssql/bin/mssql-conf
lies() { python3 -c "$PY_CONF" "$1" "$2"; }
setze() {
  local s=$1 k=$2 v=$3 aus
  if [ "$(lies "$s" "$k")" != "$v" ]; then
    aus=$("$MSSQLCONF" set "$s.$k" "$v" 2>&1) || abbruch "mssql-conf set $s.$k fehlgeschlagen: $(kurz "$aus")"
    NEUSTART=1
  fi
}
[ -x "$MSSQLCONF" ] || abbruch "SQL Server ist nicht installiert — nichts geändert"
id mssql >/dev/null 2>&1 || abbruch "Benutzer mssql fehlt — nichts geändert"
for d in "$DATEN" "$LOGD" "$SICHERUNG"; do mountpoint -q "$d" || abbruch "$d ist kein eigener Einhängepunkt (Platten-Schritt fehlt) — nichts geändert"; done
GEAENDERT=0; NEUSTART=0; EINHAENGE=()
for d in "\${ZIELE[@]}"; do
  if mountpoint -q "$d"; then
    EINHAENGE+=("$d")
    if [ "$(stat -c '%U:%G:%a' "$d")" != mssql:mssql:750 ]; then chown mssql:mssql "$d"; chmod 0750 "$d"; GEAENDERT=1; fi
  fi
done
# Dienst startet nur mit eingehängten Platten (fstab nutzt nofail)
DROPIN_DIR=/etc/systemd/system/mssql-server.service.d; DROPIN=$DROPIN_DIR/alfred-platten.conf
soll=$(printf '[Unit]\\nRequiresMountsFor=%s' "\${EINHAENGE[*]}")
if [ "$(cat "$DROPIN" 2>/dev/null || true)" != "$soll" ]; then mkdir -p "$DROPIN_DIR"; printf '%s\\n' "$soll" >"$DROPIN"; systemctl daemon-reload; GEAENDERT=1; fi
setze memory memorylimitmb "$MEM"
setze filelocation defaultdatadir "$DATEN"
setze filelocation defaultlogdir "$LOGD"
setze filelocation defaultbackupdir "$SICHERUNG"
setze sqlagent enabled "$AGENT"
if [ "$NEUSTART" = 1 ]; then
  systemctl restart mssql-server || abbruch "Neustart von mssql-server fehlgeschlagen: $(kurz "$(journalctl -u mssql-server -n 6 --no-pager 2>&1 || true)")"
  ok=0; for i in $(seq 1 60); do if ss -Htln 'sport = :1433' | grep -q .; then ok=1; break; fi; sleep 2; done
  [ "$ok" = 1 ] || abbruch "SQL Server lauscht nach dem Neustart nicht auf 1433 (120 s)"
  GEAENDERT=1
fi
# Selbstprüfung
for sk in "memory memorylimitmb $MEM" "filelocation defaultdatadir $DATEN" "filelocation defaultlogdir $LOGD" "filelocation defaultbackupdir $SICHERUNG" "sqlagent enabled $AGENT"; do
  read -r s k v <<<"$sk"
  [ "$(lies "$s" "$k")" = "$v" ] || abbruch "mssql.conf: $s.$k ist '$(lies "$s" "$k")', erwartet $v"
done
systemctl is-active --quiet mssql-server || abbruch "mssql-server läuft nicht"
if [ "$GEAENDERT" = 1 ]; then Z=geaendert; else Z=schon; fi
if [ "$NEUSTART" = 1 ]; then N=true; else N=false; fi
ergebnis "{\\"zustand\\":\\"$Z\\",\\"neustart\\":$N,\\"speicherLimitMB\\":$MEM,\\"daten\\":\\"$DATEN\\",\\"log\\":\\"$LOGD\\",\\"sicherung\\":\\"$SICHERUNG\\",\\"agent\\":$AGENT,\\"einhaengepunkte\\":\\"\${EINHAENGE[*]}\\"}"`;

/** mssql-conf set (Speicherlimit, Standardpfade, Agent) nur bei Abweichung, Rechte, RequiresMountsFor, Neustart nur wenn geändert. Zeit: LINUX_SQL_ZEIT_MS.konfiguration */
export function konfigSkript(p: KonfigParameter): string {
  pruefe(pruefeKonfig(p));
  return [
    ...kopf(LINUX_SQL_BAUSTEINE.konfiguration, {
      speicherLimitMB: p.speicherLimitMB, datenPfad: p.datenPfad, logPfad: p.logPfad, sicherungsPfad: p.sicherungsPfad, agent: p.agent,
    }),
    `MEM=${p.speicherLimitMB}`,
    `DATEN=${shQ(p.datenPfad)}`,
    `LOGD=${shQ(p.logPfad)}`,
    `SICHERUNG=${shQ(p.sicherungsPfad)}`,
    `AGENT=${shQ(p.agent ? 'true' : 'false')}`,
    `ZIELE=(${LINUX_SQL_ZIELE.map(shQ).join(' ')})`,
    `PY_CONF=${shQ(PY_CONF)}`,
    'kurz() { printf "%s" "$1" | tail -n 6 | tr "\\r\\n" "  "; }',
    KONFIG_KOERPER,
  ].join('\n');
}

// ── T-SQL-Bausteine ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface TempdbParameter { dateien: number; groesseMB: number; wachstumMB: number; logGroesseMB: number }
export interface MaxSpeicherParameter { mb: number }
export interface LoginParameter { name: string; serverrollen?: string[] }
export interface PruefdatenParameter { datenbank: string }
export type SqlBausteinName = 'tempdb' | 'maxspeicher' | 'login' | 'status' | 'pruefdaten';

export function pruefeTempdb(p: unknown): string | undefined {
  const x = obj(p);
  if (!ganz(x.dateien, 1, 8)) return 'dateien: ganze Zahl 1–8';
  if (!ganz(x.groesseMB, 8, 262_144)) return 'groesseMB: ganze Zahl 8–262144';
  if (!ganz(x.wachstumMB, 1, 65_536)) return 'wachstumMB: ganze Zahl 1–65536';
  if (!ganz(x.logGroesseMB, 8, 262_144)) return 'logGroesseMB: ganze Zahl 8–262144';
  return undefined;
}

export function pruefeMaxSpeicher(p: unknown): string | undefined {
  return ganz(obj(p).mb, 1024, 1_048_576) ? undefined : 'mb: ganze Zahl 1024–1048576';
}

const SERVERROLLEN = ['sysadmin', 'serveradmin', 'securityadmin', 'processadmin', 'setupadmin', 'bulkadmin', 'diskadmin', 'dbcreator'];
const LOGIN_NAME = /^[A-Za-z][A-Za-z0-9_]{2,63}$/;

export function pruefeLogin(p: unknown): string | undefined {
  const x = obj(p);
  if (typeof x.name !== 'string' || !LOGIN_NAME.test(x.name) || x.name.toLowerCase() === 'sa') return 'name: Buchstabe, dann Buchstaben/Ziffern/_ (3–64 Zeichen), nicht sa';
  if (x.serverrollen !== undefined) {
    if (!Array.isArray(x.serverrollen) || x.serverrollen.some(r => typeof r !== 'string' || !SERVERROLLEN.includes(r))) return `serverrollen: nur ${SERVERROLLEN.join(', ')}`;
  }
  return undefined;
}

function tempdbSkript(p: TempdbParameter): string {
  pruefe(pruefeTempdb(p));
  const tsql = [
    'SET NOCOUNT ON; SET XACT_ABORT ON;',
    `DECLARE @pfad nvarchar(200) = N'${TEMPDB_PFAD}', @n int = ${p.dateien}, @mb int = ${p.groesseMB}, @wmb int = ${p.wachstumMB}, @logmb int = ${p.logGroesseMB};`,
    'DECLARE @c int = 0, @verschoben int = 0, @i int = 0, @sql nvarchar(max), @name sysname, @typ tinyint, @fid int, @size bigint, @akt bigint, @growth int, @pct bit, @phys nvarchar(260), @soll nvarchar(260), @ziel int;',
    'IF (SELECT COUNT(*) FROM sys.master_files WHERE database_id = 2 AND type = 0) > @n',
    "  THROW 50001, N'tempdb hat mehr Datendateien als gewuenscht - Dateien werden nie automatisch entfernt', 1;",
    'DECLARE f CURSOR LOCAL FAST_FORWARD FOR',
    '  SELECT m.name, m.type, m.file_id, CAST(m.size AS bigint) * 8 / 1024, ISNULL(CAST(d.size AS bigint) * 8 / 1024, 0), m.growth, m.is_percent_growth, m.physical_name',
    '  FROM sys.master_files m LEFT JOIN tempdb.sys.database_files d ON d.file_id = m.file_id',
    '  WHERE m.database_id = 2 ORDER BY m.type, m.file_id;',
    'OPEN f;',
    'FETCH NEXT FROM f INTO @name, @typ, @fid, @size, @akt, @growth, @pct, @phys;',
    'WHILE @@FETCH_STATUS = 0',
    'BEGIN',
    '  IF @typ = 0 SET @i += 1;',
    "  SET @soll = @pfad + CASE WHEN @typ = 1 THEN N'templog.ldf' WHEN @i = 1 THEN N'tempdb.mdf' ELSE N'tempdb' + CAST(@i AS nvarchar(3)) + N'.ndf' END;",
    '  SET @ziel = CASE WHEN @typ = 1 THEN @logmb ELSE @mb END;',
    "  SET @sql = N'';",
    "  IF @phys <> @soll BEGIN SET @sql += N', FILENAME = N''' + @soll + N''''; SET @verschoben += 1; END",
    "  IF @size < @ziel AND @akt < @ziel SET @sql += N', SIZE = ' + CAST(@ziel AS nvarchar(10)) + N'MB';",
    "  IF @pct = 1 OR @growth <> @wmb * 128 SET @sql += N', FILEGROWTH = ' + CAST(@wmb AS nvarchar(10)) + N'MB';",
    "  IF @sql <> N''",
    '  BEGIN',
    "    SET @sql = N'ALTER DATABASE tempdb MODIFY FILE (NAME = ' + QUOTENAME(@name) + @sql + N')';",
    '    EXEC (@sql); SET @c += 1;',
    '  END',
    '  FETCH NEXT FROM f INTO @name, @typ, @fid, @size, @akt, @growth, @pct, @phys;',
    'END',
    'CLOSE f; DEALLOCATE f;',
    'WHILE @i < @n',
    'BEGIN',
    '  SET @i += 1;',
    "  SET @name = N'tempdev' + CAST(@i AS nvarchar(3));",
    "  IF EXISTS (SELECT 1 FROM sys.master_files WHERE database_id = 2 AND name = @name) SET @name = N'alfred_tempdev' + CAST(@i AS nvarchar(3));",
    "  SET @sql = N'ALTER DATABASE tempdb ADD FILE (NAME = ' + QUOTENAME(@name) + N', FILENAME = N''' + @pfad + N'tempdb' + CAST(@i AS nvarchar(3)) + N'.ndf'', SIZE = ' + CAST(@mb AS nvarchar(10)) + N'MB, FILEGROWTH = ' + CAST(@wmb AS nvarchar(10)) + N'MB)';",
    '  EXEC (@sql); SET @c += 1;',
    'END',
    "SELECT N'ALFRED|' + CAST(@c AS nvarchar(10)) + N'|' + CAST(@verschoben AS nvarchar(10));",
  ].join('\n');
  const lage = `SET NOCOUNT ON; SELECT N'ALFRED|' + CAST(SUM(CASE WHEN type = 0 THEN 1 ELSE 0 END) AS nvarchar(5)) + N'|' + CAST(SUM(CASE WHEN physical_name LIKE N'${TEMPDB_PFAD}%' THEN 0 ELSE 1 END) AS nvarchar(5)) FROM tempdb.sys.database_files`;
  return [
    ...kopf(LINUX_SQL_BAUSTEINE.tempdb, { dateien: p.dateien, groesseMB: p.groesseMB, wachstumMB: p.wachstumMB, logGroesseMB: p.logGroesseMB }),
    ...SQL_HILFE,
    ...SA_LESEN,
    `TSQL=${shQ(tsql)}`,
    `LAGE=${shQ(lage)}`,
    `N=${p.dateien}`,
    `mountpoint -q ${shQ(TEMPDB_PFAD.replace(/\/$/, ''))} || abbruch "${TEMPDB_PFAD} ist kein eigener Einhängepunkt — nichts geändert"`,
    'bereit || abbruch "SQL Server antwortet nicht als sa"',
    'aus=$(sql "$TSQL" 2>&1) || abbruch "tempdb-Anpassung fehlgeschlagen: $(kurz "$aus")"',
    'IFS="|" read -r _ c verschoben <<<"$(alfred_zeile "$aus")"',
    '[[ "$c" =~ ^[0-9]+$ ]] || abbruch "tempdb: keine Ergebniszeile: $(kurz "$aus")"',
    'lage() { local a; a=$(sql "$LAGE" 2>&1) || { printf "%s" "$a"; return 1; }; alfred_zeile "$a"; }',
    'l=$(lage) || abbruch "tempdb-Lage nicht lesbar: $(kurz "$l")"',
    'IFS="|" read -r _ anzahl aussen <<<"$l"',
    'NS=false',
    'if [ "${aussen:-1}" != 0 ]; then',
    '  systemctl restart mssql-server || abbruch "Neustart von mssql-server fehlgeschlagen"',
    '  bereit || abbruch "SQL Server antwortet nach dem Neustart nicht"',
    '  NS=true',
    '  l=$(lage) || abbruch "tempdb-Lage nach dem Neustart nicht lesbar: $(kurz "$l")"',
    '  IFS="|" read -r _ anzahl aussen <<<"$l"',
    'fi',
    `{ [ "$anzahl" = "$N" ] && [ "$aussen" = 0 ]; } || abbruch "tempdb hat $anzahl Datendateien, $aussen außerhalb ${TEMPDB_PFAD} (erwartet $N, 0)"`,
    'if [ "$c" = 0 ] && [ "$NS" = false ]; then Z=schon; else Z=geaendert; fi',
    'ergebnis "{\\"zustand\\":\\"$Z\\",\\"dateien\\":$anzahl,\\"aenderungen\\":$c,\\"neustart\\":$NS}"',
  ].join('\n');
}

function maxSpeicherSkript(p: MaxSpeicherParameter): string {
  pruefe(pruefeMaxSpeicher(p));
  const wert = "(SELECT CAST(value_in_use AS int) FROM sys.configurations WHERE name = N'max server memory (MB)')";
  const tsql = [
    'SET NOCOUNT ON;',
    `DECLARE @alt int = ${wert};`,
    "DECLARE @adv int = (SELECT CAST(value_in_use AS int) FROM sys.configurations WHERE name = N'show advanced options');",
    `IF @alt <> ${p.mb}`,
    'BEGIN',
    "  IF @adv = 0 BEGIN EXEC sp_configure N'show advanced options', 1; RECONFIGURE; END",
    `  EXEC sp_configure N'max server memory (MB)', ${p.mb}; RECONFIGURE;`,
    "  IF @adv = 0 BEGIN EXEC sp_configure N'show advanced options', 0; RECONFIGURE; END",
    'END',
    `SELECT N'ALFRED|' + CASE WHEN @alt = ${p.mb} THEN N'schon' ELSE N'geaendert' END + N'|' + CAST(${wert} AS nvarchar(20));`,
  ].join('\n');
  return [
    ...kopf(LINUX_SQL_BAUSTEINE.maxspeicher, { mb: p.mb }),
    ...SQL_HILFE,
    ...SA_LESEN,
    `TSQL=${shQ(tsql)}`,
    'bereit || abbruch "SQL Server antwortet nicht als sa"',
    'aus=$(sql "$TSQL" 2>&1) || abbruch "max server memory: $(kurz "$aus")"',
    'IFS="|" read -r _ Z neu <<<"$(alfred_zeile "$aus")"',
    `[ "$neu" = ${p.mb} ] || abbruch "max server memory ist $neu, erwartet ${p.mb}"`,
    'ergebnis "{\\"zustand\\":\\"$Z\\",\\"maxSpeicherMb\\":$neu}"',
  ].join('\n');
}

function loginSkript(p: LoginParameter): string {
  pruefe(pruefeLogin(p));
  const n = p.name; // geprüft: [A-Za-z][A-Za-z0-9_]* — sicher in [] und N'…'
  // Nachprüfung der Rollen: Anzahl der verlangten Serverrollen, in denen der Login danach NICHT Mitglied ist (soll 0)
  const fehlend = (p.serverrollen ?? []).map(r => `(CASE WHEN ISNULL(IS_SRVROLEMEMBER(N'${r}', N'${n}'), 0) = 1 THEN 0 ELSE 1 END)`).join(' + ') || '0';
  const ausgenommen = p.serverrollen?.length ? `r.name NOT IN (${p.serverrollen.map(r => `N'${r}'`).join(', ')})` : '1 = 1';
  const rollen = (p.serverrollen ?? []).map(r => `IF ISNULL(IS_SRVROLEMEMBER(N'${r}', N'${n}'), 0) <> 1 BEGIN ALTER SERVER ROLE [${r}] ADD MEMBER [${n}]; IF @z = N'schon' SET @z = N'geaendert'; END`);
  // T-SQL entsteht erst im Skript: Kennwort (verdoppelte ') wird dort eingesetzt; Vorlage mit Platzhalter @@KW@@
  const vorlage = [
    'SET NOCOUNT ON;',
    "DECLARE @z nvarchar(20) = N'schon';",
    `IF EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'${n}' AND type <> 'S') THROW 50002, N'${n} ist kein SQL-Login', 1;`,
    // Task 3 Fix 1 — Rollen werden nie still entfernt: hat ein bestehender Login mehr Serverrollen als verlangt, Abbruch vor jeder Änderung
    `IF EXISTS (SELECT 1 FROM sys.sql_logins WHERE name = N'${n}')`,
    'BEGIN',
    "  DECLARE @extra nvarchar(1000) = N'';",
    `  SELECT @extra = @extra + N' ' + r.name FROM sys.server_role_members m JOIN sys.server_principals r ON r.principal_id = m.role_principal_id JOIN sys.server_principals l ON l.principal_id = m.member_principal_id WHERE l.name = N'${n}' AND ${ausgenommen};`,
    `  IF @extra <> N'' BEGIN DECLARE @msg nvarchar(2048) = N'Login ${n} hat zusaetzlich' + @extra + N' - nicht still entfernt; bitte bewusst entscheiden'; THROW 50003, @msg, 1; END`,
    'END',
    `IF NOT EXISTS (SELECT 1 FROM sys.sql_logins WHERE name = N'${n}')`,
    `BEGIN CREATE LOGIN [${n}] WITH PASSWORD = N'@@KW@@', CHECK_POLICY = ON, CHECK_EXPIRATION = OFF, DEFAULT_DATABASE = [master]; SET @z = N'angelegt'; END`,
    `ELSE IF PWDCOMPARE(N'@@KW@@', (SELECT password_hash FROM sys.sql_logins WHERE name = N'${n}')) = 0`,
    `BEGIN ALTER LOGIN [${n}] WITH PASSWORD = N'@@KW@@'; SET @z = N'geaendert'; END`,
    `IF (SELECT is_disabled FROM sys.server_principals WHERE name = N'${n}') = 1 BEGIN ALTER LOGIN [${n}] ENABLE; IF @z = N'schon' SET @z = N'geaendert'; END`,
    ...rollen,
    `SELECT N'ALFRED|' + @z + N'|' + CAST((SELECT COUNT(*) FROM sys.sql_logins WHERE name = N'${n}' AND is_disabled = 0 AND PWDCOMPARE(N'@@KW@@', password_hash) = 1) AS nvarchar(5)) + N'|' + CAST(${fehlend} AS nvarchar(5));`,
  ].join('\n');
  return [
    ...kopf(LINUX_SQL_BAUSTEINE.login, { name: p.name, serverrollen: p.serverrollen ?? [] }),
    ...SQL_HILFE,
    ...SA_LESEN,
    'KW=$(feld kennwort) || abbruch "Kennwort enthält nicht druckbare Zeichen"',
    '[ -n "$KW" ] || abbruch "Kennwort fehlt in der Eingabe (JSON-Feld kennwort)"',
    '[[ "$KW" =~ ^[[:print:]]+$ ]] || abbruch "Kennwort enthält nicht druckbare Zeichen"',
    "Q1=\"'\"",
    // Ersetzungstext in Anführungszeichen: bash 5.2 (patsub_replacement) setzt sonst für & den Treffer ein
    'KW_SQL=${KW//"$Q1"/"$Q1$Q1"}',
    `VORLAGE=${shQ(vorlage)}`,
    'TSQL=${VORLAGE//@@KW@@/"$KW_SQL"}',
    'bereit || abbruch "SQL Server antwortet nicht als sa"',
    'aus=$(sql "$TSQL" 2>&1) || abbruch "Login: $(kurz "$aus")"',
    'unset TSQL',
    'IFS="|" read -r _ Z ok fehlend <<<"$(alfred_zeile "$aus")"',
    `[ "$ok" = 1 ] || abbruch "Login ${n}: Nachprüfung (Kennwort, aktiv) fehlgeschlagen"`,
    `[ "$fehlend" = 0 ] || abbruch "Login ${n}: Nachprüfung der Serverrollen fehlgeschlagen ($fehlend fehlen)"`,
    `ergebnis "{\\"zustand\\":\\"$Z\\",\\"login\\":\\"${n}\\",\\"serverrollen\\":${JSON.stringify(JSON.stringify(p.serverrollen ?? [])).slice(1, -1)}}"`,
  ].join('\n');
}

/** T-SQL-Bausteine als sa (Kennwort aus stdin). Zeit: LINUX_SQL_ZEIT_MS[name] */
export function sqlSkript(name: 'tempdb', p: TempdbParameter): string;
export function sqlSkript(name: 'maxspeicher', p: MaxSpeicherParameter): string;
export function sqlSkript(name: 'login', p: LoginParameter): string;
export function sqlSkript(name: 'status', p?: unknown): string;
export function sqlSkript(name: 'pruefdaten', p: PruefdatenParameter): string;
export function sqlSkript(name: SqlBausteinName, p?: unknown): string {
  switch (name) {
    case 'tempdb': return tempdbSkript(p as TempdbParameter);
    case 'maxspeicher': return maxSpeicherSkript(p as MaxSpeicherParameter);
    case 'login': return loginSkript(p as LoginParameter);
    case 'status': return statusSkript();
    case 'pruefdaten': return pruefdatenSkript(p as PruefdatenParameter);
    default: throw new Error(`Unbekannter SQL-Baustein „${String(name)}“`);
  }
}

// ── Prüfdaten (Task 3) ───────────────────────────────────────────────────────────────────────────────────────────────────────

const DB_NAME = /^[A-Za-z][A-Za-z0-9_]{2,63}$/;
const SYSTEM_DBS = new Set(['master', 'model', 'msdb', 'tempdb']);
/** feste Prüftabelle: id 1…N, wert „alfred-pruefung-<id>“, zahl (id·7919) mod 1000 */
export const PRUEFDATEN_ZEILEN = 1000;
export const PRUEFDATEN_TABELLE = 'dbo.alfred_pruefung';
const pruefZeile = (i: number) => `${i}|alfred-pruefung-${i}|${(i * 7919) % 1000}`;
/**
 * Soll-Prüfsumme wie in SQL: HASHBYTES('SHA2_256', STRING_AGG(CONCAT(id,'|',wert,'|',zahl), ';') WITHIN GROUP (ORDER BY id)) über
 * nvarchar (UTF-16LE), als Großbuchstaben-Hex (CONVERT(…, 2)). Der Restore-Beweis vergleicht damit.
 */
export const PRUEFDATEN_SHA256 = createHash('sha256')
  .update(Buffer.from(Array.from({ length: PRUEFDATEN_ZEILEN }, (_, i) => pruefZeile(i + 1)).join(';'), 'utf16le')).digest('hex').toUpperCase();

export function pruefePruefdaten(p: unknown): string | undefined {
  const d = obj(p).datenbank;
  if (typeof d !== 'string' || !DB_NAME.test(d) || SYSTEM_DBS.has(d.toLowerCase())) return 'datenbank: Buchstabe, dann Buchstaben/Ziffern/_ (3–64 Zeichen), keine Systemdatenbank';
  return undefined;
}

/**
 * Datenbank (falls fehlend, markiert mit der Eigenschaft alfred_pruefdaten=1) mit Wiederherstellungsmodell FULL, darin die Prüftabelle —
 * nur wenn sie fehlt, in einer Transaktion. Eine bestehende Datenbank ohne Markierung wird nie verändert (ohne Prüftabelle: Abbruch).
 * Eine vorhandene Tabelle wird nie verändert: weicht sie ab (Zeilen/Prüfsumme), bricht der Baustein ab. Zeit: LINUX_SQL_ZEIT_MS.pruefdaten
 */
function pruefdatenSkript(p: PruefdatenParameter): string {
  pruefe(pruefePruefdaten(p));
  const n = p.datenbank; // geprüft: [A-Za-z][A-Za-z0-9_]* — sicher in [] und N'…'
  // läuft per sp_executesql in der Ziel-Datenbank (Text steht in N'…', daher verdoppelte ')
  const innen = [
    'SET NOCOUNT ON; SET XACT_ABORT ON;',
    "IF @darf = 1 AND OBJECT_ID(N''dbo.alfred_pruefung'', N''U'') IS NULL",
    'BEGIN',
    '  BEGIN TRAN;',
    '  CREATE TABLE dbo.alfred_pruefung (id int NOT NULL PRIMARY KEY, wert nvarchar(100) NOT NULL, zahl int NOT NULL);',
    "  INSERT dbo.alfred_pruefung (id, wert, zahl) SELECT n, N''alfred-pruefung-'' + CAST(n AS nvarchar(10)), (n * 7919) % 1000",
    `    FROM (SELECT TOP (${PRUEFDATEN_ZEILEN}) CAST(ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS int) AS n FROM sys.all_objects a CROSS JOIN sys.all_objects b) x;`,
    '  COMMIT;',
    '  SET @neu = 1;',
    'END',
    "SELECT @anzahl = COUNT(*), @hash = CONVERT(nvarchar(64), HASHBYTES(N''SHA2_256'', STRING_AGG(CAST(CONCAT(id, N''|'', wert, N''|'', zahl) AS nvarchar(max)), N'';'') WITHIN GROUP (ORDER BY id)), 2) FROM dbo.alfred_pruefung;",
  ].join('\n');
  const tsql = [
    'SET NOCOUNT ON; SET XACT_ABORT ON;',
    "DECLARE @z nvarchar(20) = N'schon', @neuDb bit = 0, @eigen int = 0, @tab int = 0, @neu bit = 0, @anzahl int, @hash nvarchar(64), @sql nvarchar(max);",
    `IF DB_ID(N'${n}') IS NULL BEGIN CREATE DATABASE [${n}]; SET @neuDb = 1; SET @z = N'geaendert'; END`,
    // Fix 1 — eigene Datenbanken tragen die Markierung alfred_pruefdaten=1 (beim Anlegen gesetzt); fremde werden nie verändert
    `EXEC [${n}].sys.sp_executesql N'SELECT @eigen = COUNT(*) FROM sys.extended_properties WHERE class = 0 AND name = N''alfred_pruefdaten'' AND CAST(value AS nvarchar(10)) = N''1''; SET @tab = CASE WHEN OBJECT_ID(N''dbo.alfred_pruefung'', N''U'') IS NULL THEN 0 ELSE 1 END;', N'@eigen int OUTPUT, @tab int OUTPUT', @eigen = @eigen OUTPUT, @tab = @tab OUTPUT;`,
    `IF @neuDb = 1 AND @eigen = 0 BEGIN EXEC [${n}].sys.sp_addextendedproperty @name = N'alfred_pruefdaten', @value = N'1'; SET @eigen = 1; END`,
    `IF @eigen = 0 AND @tab = 0 THROW 50004, N'Datenbank ${n} ist eine fremde Datenbank (ohne Alfred-Markierung und ohne dbo.alfred_pruefung) - nichts geaendert', 1;`,
    // eine fremde Datenbank mit Prüftabelle (z. B. Kopie) wird nur gelesen — Wiederherstellungsmodell und Tabelle nur bei eigenen
    `IF @eigen = 1 AND (SELECT recovery_model_desc FROM sys.databases WHERE name = N'${n}') <> N'FULL' BEGIN ALTER DATABASE [${n}] SET RECOVERY FULL; SET @z = N'geaendert'; END`,
    `SET @sql = N'${innen}';`,
    // Prozedur der Ziel-Datenbank: der Name wird erst zur Laufzeit aufgelöst (die Datenbank kann in diesem Batch entstanden sein)
    `EXEC [${n}].sys.sp_executesql @sql, N'@darf bit, @neu bit OUTPUT, @anzahl int OUTPUT, @hash nvarchar(64) OUTPUT', @darf = @eigen, @neu = @neu OUTPUT, @anzahl = @anzahl OUTPUT, @hash = @hash OUTPUT;`,
    "IF @neu = 1 SET @z = N'geaendert';",
    `SELECT N'ALFRED|' + @z + N'|' + CAST(@anzahl AS nvarchar(10)) + N'|' + ISNULL(@hash, N'-') + N'|' + (SELECT recovery_model_desc FROM sys.databases WHERE name = N'${n}');`,
  ].join('\n');
  return [
    ...kopf(LINUX_SQL_BAUSTEINE.pruefdaten, { datenbank: n }),
    ...SQL_HILFE,
    ...SA_LESEN,
    `TSQL=${shQ(tsql)}`,
    `SOLL=${PRUEFDATEN_SHA256}`,
    `N_SOLL=${PRUEFDATEN_ZEILEN}`,
    'bereit || abbruch "SQL Server antwortet nicht als sa"',
    'aus=$(sql "$TSQL" 2>&1) || abbruch "Prüfdaten: $(kurz "$aus")"',
    'IFS="|" read -r _ Z anzahl hash modell <<<"$(alfred_zeile "$aus")"',
    `{ [ "$anzahl" = "$N_SOLL" ] && [ "$hash" = "$SOLL" ]; } || abbruch "Prüftabelle ${PRUEFDATEN_TABELLE} in ${n} weicht ab: $anzahl Zeilen, Prüfsumme $hash (erwartet $N_SOLL, $SOLL) — vorhandene Daten werden nie geändert"`,
    `[ "$modell" = FULL ] || abbruch "Datenbank ${n} hat Wiederherstellungsmodell $modell, erwartet FULL"`,
    `ergebnis "{\\"zustand\\":\\"$Z\\",\\"datenbank\\":\\"${n}\\",\\"tabelle\\":\\"${PRUEFDATEN_TABELLE}\\",\\"zeilen\\":$anzahl,\\"pruefsumme\\":\\"$hash\\",\\"wiederherstellungsmodell\\":\\"FULL\\"}"`,
  ].join('\n');
}

// ── Status ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const STATUS_TSQL = [
  'SET NOCOUNT ON;',
  'SELECT (SELECT',
  "  CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(40)) AS version,",
  "  CAST(SERVERPROPERTY('ProductLevel') AS nvarchar(40)) AS stufe,",
  "  CAST(SERVERPROPERTY('ProductUpdateLevel') AS nvarchar(40)) AS cu,",
  "  CAST(SERVERPROPERTY('Edition') AS nvarchar(80)) AS edition,",
  "  CAST(SERVERPROPERTY('EngineEdition') AS int) AS engineEdition,",
  "  (SELECT CAST(value_in_use AS int) FROM sys.configurations WHERE name = N'max server memory (MB)') AS maxSpeicherMb,",
  '  (SELECT cpu_count FROM sys.dm_os_sys_info) AS kerne,',
  '  (SELECT name, physical_name AS pfad, type_desc AS typ, CAST(size AS bigint) * 8 / 1024 AS mb,',
  '     CASE WHEN is_percent_growth = 1 THEN NULL ELSE CAST(growth AS bigint) * 8 / 1024 END AS wachstumMb',
  '   FROM tempdb.sys.database_files ORDER BY file_id FOR JSON PATH) AS tempdb,',
  '  (SELECT d.name, d.recovery_model_desc AS modell, d.state_desc AS zustand,',
  "     (SELECT MAX(b.backup_finish_date) FROM msdb.dbo.backupset b WHERE b.database_name = d.name AND b.type = 'D') AS letzteVoll,",
  "     (SELECT MAX(b.backup_finish_date) FROM msdb.dbo.backupset b WHERE b.database_name = d.name AND b.type = 'I') AS letzteDiff,",
  "     (SELECT MAX(b.backup_finish_date) FROM msdb.dbo.backupset b WHERE b.database_name = d.name AND b.type = 'L') AS letztesLog",
  '   FROM sys.databases d ORDER BY d.name FOR JSON PATH, INCLUDE_NULL_VALUES) AS datenbanken',
  ' FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES) AS j;',
].join('\n');

/** python3-Statusprogramm: stdin = Eingabe-JSON (optional sa) */
export const PY_STATUS = [
  'import configparser, json, os, subprocess, sys',
  `ZIELE = ${JSON.stringify([...LINUX_SQL_ZIELE])}`,
  `SQLCMD = ${JSON.stringify(SQLCMD)}`,
  `TSQL = ${JSON.stringify(STATUS_TSQL)}`,
  'roh = sys.stdin.read().strip()',
  'sa = ""',
  'if roh:',
  '    try:',
  '        v = json.loads(roh).get("sa")',
  '        sa = v if isinstance(v, str) else ""',
  '    except Exception:',
  '        sa = ""',
  'def lauf(*a):',
  '    try:',
  '        p = subprocess.run(list(a), capture_output=True, text=True, timeout=30)',
  '        return p.returncode, p.stdout.strip()',
  '    except Exception:',
  '        return 1, ""',
  'r = {"zustand": "gelesen"}',
  'pakete = {}',
  'for pk in ("mssql-server", "mssql-tools18", "msodbcsql18"):',
  '    c, v = lauf("dpkg-query", "-W", "-f=${Status}|${Version}", pk)',
  '    pakete[pk] = v.split("|", 1)[1] if c == 0 and v.startswith("install ok installed|") else None',
  'r["pakete"] = pakete',
  'r["installiert"] = pakete["mssql-server"] is not None',
  'r["dienst"] = lauf("systemctl", "is-active", "mssql-server")[1] or "unbekannt"',
  'r["aktiviert"] = lauf("systemctl", "is-enabled", "mssql-server")[1] or "unbekannt"',
  'cp = configparser.ConfigParser(interpolation=None)',
  'try:',
  '    cp.read("/var/opt/mssql/mssql.conf")',
  'except Exception:',
  '    pass',
  'g = lambda s, k: cp.get(s, k, fallback=None)',
  'r["konfig"] = {"memorylimitmb": g("memory", "memorylimitmb"), "defaultdatadir": g("filelocation", "defaultdatadir"), "defaultlogdir": g("filelocation", "defaultlogdir"), "defaultbackupdir": g("filelocation", "defaultbackupdir"), "sqlagent": g("sqlagent", "enabled")}',
  'platz = []',
  'for z in ZIELE + ["/var/opt/mssql", "/"]:',
  '    if os.path.isdir(z):',
  '        st = os.statvfs(z)',
  '        platz.append({"pfad": z, "eingehaengt": os.path.ismount(z), "gesamtMB": st.f_blocks * st.f_frsize // 1048576, "freiMB": st.f_bavail * st.f_frsize // 1048576})',
  'r["platz"] = platz',
  'if not sa:',
  '    r["sql"] = None',
  '    r["sqlHinweis"] = "ohne sa-Kennwort nur Betriebssystem-Sicht"',
  'elif r["dienst"] != "active":',
  '    r["sql"] = None',
  '    r["sqlHinweis"] = "Dienst nicht aktiv"',
  'else:',
  '    try:',
  '        p = subprocess.run([SQLCMD, "-C", "-b", "-x", "-S", "localhost", "-U", "sa", "-l", "30", "-h", "-1", "-y", "0"], input=TSQL, capture_output=True, text=True, timeout=60, env=dict(os.environ, SQLCMDPASSWORD=sa))',
  '        aus = "".join(z.strip() for z in p.stdout.splitlines())',
  '        if p.returncode == 0 and aus.startswith("{"):',
  '            r["sql"] = json.loads(aus)',
  '        else:',
  '            r["sql"] = None',
  '            r["sqlFehler"] = ((p.stderr or "") + " " + (p.stdout or "")).strip()[-400:]',
  '    except Exception as e:',
  '        r["sql"] = None',
  '        r["sqlFehler"] = type(e).__name__',
  'print("ALFRED-SQL " + json.dumps(r))',
].join('\n');

/** Version, Edition, Dienst, mssql.conf, Platz je Einhängepunkt; mit sa (stdin) zusätzlich tempdb, Datenbanken, letzte Sicherungen. Zeit: LINUX_SQL_ZEIT_MS.status */
export function statusSkript(): string {
  return [
    ...kopf(LINUX_SQL_BAUSTEINE.status, {}),
    `PY_STATUS=${shQ(PY_STATUS)}`,
    'python3 -c "$PY_STATUS" <<<"$ALFRED_EINGABE"',
    'ALFRED_ZEILE=1',
  ].join('\n');
}

// ── Register ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

registriereLinuxBaustein<PlattenParameter>(LINUX_SQL_BAUSTEINE.platten, plattenSkript);
registriereLinuxBaustein<InstallParameter>(LINUX_SQL_BAUSTEINE.installation, installSkript);
registriereLinuxBaustein<KonfigParameter>(LINUX_SQL_BAUSTEINE.konfiguration, konfigSkript);
registriereLinuxBaustein<TempdbParameter>(LINUX_SQL_BAUSTEINE.tempdb, p => sqlSkript('tempdb', p));
registriereLinuxBaustein<MaxSpeicherParameter>(LINUX_SQL_BAUSTEINE.maxspeicher, p => sqlSkript('maxspeicher', p));
registriereLinuxBaustein<LoginParameter>(LINUX_SQL_BAUSTEINE.login, p => sqlSkript('login', p));
registriereLinuxBaustein(LINUX_SQL_BAUSTEINE.status, () => statusSkript());
registriereLinuxBaustein<PruefdatenParameter>(LINUX_SQL_BAUSTEINE.pruefdaten, p => sqlSkript('pruefdaten', p));
