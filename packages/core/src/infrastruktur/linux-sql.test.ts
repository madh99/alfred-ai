import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  plattenSkript, installSkript, konfigSkript, sqlSkript, statusSkript, sqlErgebnis, shQ,
  pruefePlatten, pruefeInstallation, pruefeKonfig, pruefeTempdb, pruefeMaxSpeicher, pruefeLogin,
  LINUX_SQL_BAUSTEINE, LINUX_SQL_ZEIT_MS, MS_SCHLUESSEL_FPR, MS_QUELLE_SERVER, MS_QUELLE_WERKZEUGE, PY_STATUS, PY_FELD, PY_CONF,
} from './linux-sql.js';
import { linuxBausteinBekannt, linuxBausteinSkript } from '../fernzugriff/linux-bausteine.js';

// I8e Paket 1 (Vorhaben c7e02aff v2) — SQL Server 2025 auf Ubuntu 24.04, feste Skripte

const PLATTEN = {
  platten: [
    { scsi: 1, groesseGiB: 160, ziel: '/var/opt/mssql/data' as const },
    { scsi: 2, groesseGiB: 80, ziel: '/var/opt/mssql/log' as const },
    { scsi: 3, groesseGiB: 64, ziel: '/var/opt/mssql/tempdb' as const },
    { scsi: 4, groesseGiB: 128, ziel: '/var/opt/mssql/backup' as const },
  ],
};
const INSTALL = { version: '17.0.4006.2-1', edition: 'EnterpriseDeveloper' as const };
const KONFIG = { speicherLimitMB: 12288, datenPfad: '/var/opt/mssql/data', logPfad: '/var/opt/mssql/log', sicherungsPfad: '/var/opt/mssql/backup', agent: true };
const TEMPDB = { dateien: 4, groesseMB: 1024, wachstumMB: 256, logGroesseMB: 1024 };
const LOGIN = { name: 'app_kunden', serverrollen: ['dbcreator'] };

const BOESE = ['; rm -rf /', '$(id)', '`id`', 'a\nrm -rf /', "x' ; id ; '", '../../etc'];

function alleSkripte(): Array<[string, string]> {
  return [
    ['platten', plattenSkript(PLATTEN)],
    ['installation', installSkript(INSTALL)],
    ['konfiguration', konfigSkript(KONFIG)],
    ['tempdb', sqlSkript('tempdb', TEMPDB)],
    ['maxspeicher', sqlSkript('maxspeicher', { mb: 10240 })],
    ['login', sqlSkript('login', LOGIN)],
    ['status', statusSkript()],
  ];
}

/** bash verfügbar (Git-Bash/Linux)? */
const BASH = (() => {
  const r = spawnSync('bash', ['-c', 'echo "$BASH_VERSION"'], { encoding: 'utf8' });
  return r.status === 0 && /^\d+\./.test(r.stdout.trim());
})();
const PYTHON = (() => {
  for (const p of ['python3', 'python']) {
    const r = spawnSync(p, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim() === '3') return p;
  }
  return undefined;
})();

describe('I8e Linux-SQL — Register und Validatoren', () => {
  it('alle Bausteine sind beim Laden registriert und liefern denselben Text wie die Erzeuger', () => {
    for (const k of Object.values(LINUX_SQL_BAUSTEINE)) expect(linuxBausteinBekannt(k)).toBe(true);
    expect(linuxBausteinSkript(LINUX_SQL_BAUSTEINE.platten, PLATTEN)).toBe(plattenSkript(PLATTEN));
    expect(linuxBausteinSkript(LINUX_SQL_BAUSTEINE.status, {})).toBe(statusSkript());
    expect(() => linuxBausteinSkript(LINUX_SQL_BAUSTEINE.installation, { ...INSTALL, version: '$(id)' })).toThrow(/version/);
  });
  it('Zeitgrenzen für Aufrufer ≥ 65 s', () => {
    for (const ms of Object.values(LINUX_SQL_ZEIT_MS)) expect(ms).toBeGreaterThanOrEqual(65_000);
    expect(LINUX_SQL_ZEIT_MS.installation).toBeGreaterThanOrEqual(900_000);
  });
  it('Platten: nur scsi1–6, Größe ganzzahlig 1–4096 GiB, nur feste Ziele, keine Dubletten', () => {
    expect(pruefePlatten(PLATTEN)).toBeUndefined();
    expect(pruefePlatten({ platten: [] })).toContain('platten');
    expect(pruefePlatten({ platten: [{ ...PLATTEN.platten[0], scsi: 0 }] })).toContain('scsi');
    expect(pruefePlatten({ platten: [{ ...PLATTEN.platten[0], scsi: 7 }] })).toContain('scsi');
    expect(pruefePlatten({ platten: [{ ...PLATTEN.platten[0], scsi: 1.5 }] })).toContain('scsi');
    expect(pruefePlatten({ platten: [{ ...PLATTEN.platten[0], groesseGiB: 0 }] })).toContain('groesseGiB');
    expect(pruefePlatten({ platten: [{ ...PLATTEN.platten[0], groesseGiB: 5000 }] })).toContain('groesseGiB');
    expect(pruefePlatten({ platten: [{ ...PLATTEN.platten[0], groesseGiB: '160' }] })).toContain('groesseGiB');
    expect(pruefePlatten({ platten: [PLATTEN.platten[0], { ...PLATTEN.platten[1], scsi: 1 }] })).toContain('doppelt');
    expect(pruefePlatten({ platten: [PLATTEN.platten[0], { ...PLATTEN.platten[1], ziel: '/var/opt/mssql/data' }] })).toContain('doppelt');
    for (const b of BOESE) expect(pruefePlatten({ platten: [{ ...PLATTEN.platten[0], ziel: `/var/opt/mssql/data${b}` }] })).toContain('ziel');
    expect(pruefePlatten({ platten: [{ ...PLATTEN.platten[0], ziel: '/' }] })).toContain('ziel');
    expect(pruefePlatten({ platten: Array.from({ length: 5 }, (_, i) => ({ scsi: i + 1, groesseGiB: 10, ziel: '/var/opt/mssql/data' })) })).toContain('platten');
    expect(() => plattenSkript({ platten: [{ ...PLATTEN.platten[0], ziel: '/var/opt/mssql/data; rm -rf /' as never }] })).toThrow(/ziel/);
  });
  it('Installation: feste Paketversion ab CU1 (17.0.4006), nur Enterprise Developer', () => {
    expect(pruefeInstallation(INSTALL)).toBeUndefined();
    expect(pruefeInstallation({ ...INSTALL, version: '17.0.5065.9-3' })).toBeUndefined();
    expect(pruefeInstallation({ ...INSTALL, version: '17.0.1155.3-1' })).toContain('CU1'); // GDR-Zweig der RTM
    expect(pruefeInstallation({ ...INSTALL, version: '16.0.4006.2-1' })).toContain('version');
    expect(pruefeInstallation({ ...INSTALL, version: '17.0.4006.2' })).toContain('version'); // ohne Paketrevision
    expect(pruefeInstallation({ ...INSTALL, version: 'latest' })).toContain('version');
    for (const b of BOESE) expect(pruefeInstallation({ ...INSTALL, version: `17.0.4006.2-1${b}` })).toContain('version');
    expect(pruefeInstallation({ ...INSTALL, edition: 'Developer' })).toContain('edition');
    expect(pruefeInstallation({ ...INSTALL, edition: 'Enterprise' })).toContain('edition');
    expect(pruefeInstallation({ ...INSTALL, werkzeugVersion: '18.6.2.1-1', odbcVersion: '18.6.2.1-1' })).toBeUndefined();
    expect(pruefeInstallation({ ...INSTALL, werkzeugVersion: '18.6.2.1-1 mssql-server' })).toContain('werkzeugVersion');
    expect(pruefeInstallation({ ...INSTALL, odbcVersion: '$(id)' })).toContain('odbcVersion');
    expect(() => installSkript({ ...INSTALL, version: '17.0.4006.2-1; id' })).toThrow(/version/);
  });
  it('Konfiguration: Speicherlimit ganzzahlig, nur feste Pfade, agent boolesch', () => {
    expect(pruefeKonfig(KONFIG)).toBeUndefined();
    expect(pruefeKonfig({ ...KONFIG, speicherLimitMB: 1024 })).toContain('speicherLimitMB');
    expect(pruefeKonfig({ ...KONFIG, speicherLimitMB: 12288.5 })).toContain('speicherLimitMB');
    expect(pruefeKonfig({ ...KONFIG, datenPfad: '/tmp' })).toContain('datenPfad');
    expect(pruefeKonfig({ ...KONFIG, logPfad: '/var/opt/mssql/data' })).toContain('doppelt');
    for (const b of BOESE) expect(pruefeKonfig({ ...KONFIG, sicherungsPfad: `/var/opt/mssql/backup${b}` })).toContain('sicherungsPfad');
    expect(pruefeKonfig({ ...KONFIG, agent: 'true' })).toContain('agent');
    expect(() => konfigSkript({ ...KONFIG, datenPfad: '$(id)' })).toThrow(/datenPfad/);
  });
  it('SQL-Bausteine: tempdb 1–8 Dateien, Speicher ganzzahlig, Login-Name und Rollen fest', () => {
    expect(pruefeTempdb(TEMPDB)).toBeUndefined();
    expect(pruefeTempdb({ ...TEMPDB, dateien: 9 })).toContain('dateien');
    expect(pruefeTempdb({ ...TEMPDB, dateien: 0 })).toContain('dateien');
    expect(pruefeTempdb({ ...TEMPDB, groesseMB: '1024; DROP' })).toContain('groesseMB');
    expect(pruefeTempdb({ ...TEMPDB, wachstumMB: 0 })).toContain('wachstumMB');
    expect(pruefeMaxSpeicher({ mb: 10240 })).toBeUndefined();
    expect(pruefeMaxSpeicher({ mb: 100 })).toContain('mb');
    expect(pruefeMaxSpeicher({ mb: '10240' })).toContain('mb');
    expect(pruefeLogin(LOGIN)).toBeUndefined();
    expect(pruefeLogin({ name: 'app_kunden' })).toBeUndefined();
    expect(pruefeLogin({ name: 'sa' })).toContain('name');
    expect(pruefeLogin({ name: 'SA' })).toContain('name');
    expect(pruefeLogin({ name: '##MS_x' })).toContain('name');
    for (const b of [...BOESE, ']; DROP LOGIN sa; --', "x'"]) expect(pruefeLogin({ name: `app${b}` })).toContain('name');
    expect(pruefeLogin({ ...LOGIN, serverrollen: ['sysadmin; DROP'] })).toContain('serverrollen');
    expect(pruefeLogin({ ...LOGIN, serverrollen: ['public'] })).toContain('serverrollen');
    expect(() => sqlSkript('login', { name: 'x]; DROP LOGIN sa' })).toThrow(/name/);
    expect(() => sqlSkript('fremd' as never, {})).toThrow(/Unbekannt/);
  });
  it('shQ setzt jeden Wert in einfache Anführungszeichen', () => {
    expect(shQ("a'b")).toBe(`'a'\\''b'`);
    expect(shQ('$(id)')).toBe(`'$(id)'`);
  });
  it('Ergebniszeile lesen', () => {
    expect(sqlErgebnis('x\nALFRED-SQL {"zustand":"schon"}\ny')).toEqual({ zustand: 'schon' });
    expect(sqlErgebnis('nichts')).toBeUndefined();
    expect(sqlErgebnis('ALFRED-SQL {kaputt')).toBeUndefined();
  });
});

describe('I8e Linux-SQL — Skripttext', () => {
  it('jedes Skript: strikter Modus, Parameter als JSON-Literal, genau eine Ergebniszeile, kein Echo der Eingabe', () => {
    for (const [name, s] of alleSkripte()) {
      expect(s, name).toMatch(/^set -euo pipefail\n/);
      expect(s, name).toContain('ALFRED_P=\'{');
      expect(s, name).toContain("printf 'ALFRED-SQL %s\\n'");
      expect(s, name).not.toMatch(/set -x|set -o xtrace/);
      expect(s, name).not.toMatch(/(echo|printf)[^\n]*\$\{?ALFRED_EINGABE/);
      // Eingabe nur als Here-String an python3 (nie Befehlszeile, nie Umgebung)
      for (const m of s.matchAll(/\$\{?ALFRED_EINGABE\}?/g)) {
        const zeile = s.slice(s.lastIndexOf('\n', m.index!) + 1, s.indexOf('\n', m.index!));
        expect(zeile, `${name}: ${zeile}`).toMatch(/<<<"\$ALFRED_EINGABE"/);
      }
      expect(s, name).not.toMatch(/export (SA|KW|SQLCMDPASSWORD|MSSQL_SA_PASSWORD)/);
      expect(s, name).not.toMatch(/sqlcmd[^\n]* -P /);
    }
  });
  it('Geheimnisse nur als Umgebung des einen Prozesses: sqlcmd über SQLCMDPASSWORD, setup über MSSQL_SA_PASSWORD', () => {
    const i = installSkript(INSTALL);
    expect(i).toContain('SA=$(feld sa)');
    expect(i).toContain('MSSQL_SA_PASSWORD="$SA" MSSQL_PID="$PID" /opt/mssql/bin/mssql-conf -n setup accept-eula');
    expect(i).toContain('SQLCMDPASSWORD="$SA" "$SQLCMD" -C -b -x -S localhost -U sa');
    const l = sqlSkript('login', LOGIN);
    expect(l).toContain('KW=$(feld kennwort)');
    // T-SQL mit Kennwort geht über stdin, nicht -Q
    expect(l).toContain('sql "$TSQL"');
    expect(l).toMatch(/sql\(\) \{[^\n]*<<<"\$1"/);
    expect(l).not.toMatch(/-Q "?\$TSQL/);
    expect(l).toContain('KW_SQL=${KW//"$Q1"/"$Q1$Q1"}');
    expect(l).toContain('TSQL=${VORLAGE//@@KW@@/"$KW_SQL"}');
    expect(l).toContain('PWDCOMPARE');
    expect(statusSkript()).toContain('python3 -c "$PY_STATUS" <<<"$ALFRED_EINGABE"');
    expect(PY_STATUS).toContain("SQLCMDPASSWORD=sa");
  });
  it('Platten: SCSI-Adresse 0:0:0:N, Größe ±1 %, formatiert nur ohne Signatur und Partition, erst alles prüfen', () => {
    const s = plattenSkript(PLATTEN);
    expect(s).toContain('SCSI=(1 2 3 4)');
    expect(s).toContain('GIB=(160 80 64 128)');
    expect(s).toContain('"$BYPATH"/*-scsi-0:0:0:"$1"');
    expect(s).toContain('[ "${hctl#*:}" = "0:0:$n" ]');
    expect(s).toContain('[ $(( ab * 100 )) -le "$soll" ]');
    expect(s).toContain('blkid -p -o export "$dev"');
    expect(s).toContain('wipefs --noheadings --output TYPE "$dev"');
    expect(s).toContain('[ "$(lsblk -nro NAME "$dev" | wc -l)" -eq 1 ]');
    expect(s).toContain('mkfs.xfs -q -K -L "${LABEL[$i]}" "$dev"');
    expect(s).not.toMatch(/mkfs\.xfs[^\n]* -f/);
    expect(s).toContain("printf 'UUID=%s %s xfs defaults,noatime,nofail 0 0\\n'");
    // Prüfphase vollständig vor der ersten Änderung
    expect(s.indexOf('# Phase 1')).toBeLessThan(s.indexOf('mkfs.xfs -q'));
    expect(s.indexOf('done', s.indexOf('# Phase 1'))).toBeLessThan(s.indexOf('mkfs.xfs -q'));
    expect(s).toContain('Z=schon');
  });
  it('Installation: signierte Microsoft-Quelle mit Fingerabdruck, feste Versionen, Halten, schon-Zweig, Selbstprüfung', () => {
    const s = installSkript(INSTALL);
    expect(s).toContain(`FPR='${MS_SCHLUESSEL_FPR}'`);
    expect(MS_SCHLUESSEL_FPR).toBe('BC528686B50D79E339D3721CEB3E94ADBE1229CF');
    expect(MS_QUELLE_SERVER).toBe('deb [arch=amd64 signed-by=/usr/share/keyrings/microsoft-prod.gpg] https://packages.microsoft.com/ubuntu/24.04/mssql-server-2025 noble main');
    expect(MS_QUELLE_WERKZEUGE).toBe('deb [arch=amd64 signed-by=/usr/share/keyrings/microsoft-prod.gpg] https://packages.microsoft.com/ubuntu/24.04/prod noble main');
    expect(s).toContain("V='17.0.4006.2-1'");
    expect(s).toContain('"mssql-server=$V" "mssql-tools18=$VT" "msodbcsql18=$VO"');
    expect(s).toContain('apt-mark -o DPkg::Lock::Timeout=300 hold mssql-server mssql-tools18 msodbcsql18');
    expect(s).toContain('apt-get -o DPkg::Lock::Timeout=300 update');
    expect(s).toContain('ACCEPT_EULA=Y apt-get -o DPkg::Lock::Timeout=300 install');
    expect(s).not.toMatch(/(^\s*|ACCEPT_EULA=Y )apt-(get|mark) (?!-o DPkg::Lock::Timeout=300 )/m);
    // Einhängepunkte vor jeder Änderung (und damit vor setup) Pflicht
    expect(s).toContain("EINHAENGEN=('/var/opt/mssql/data' '/var/opt/mssql/log' '/var/opt/mssql/tempdb' '/var/opt/mssql/backup')");
    expect(s.indexOf('mountpoint -q "$d" || abbruch')).toBeGreaterThan(0);
    expect(s.indexOf('mountpoint -q "$d" || abbruch')).toBeLessThan(s.indexOf('curl -fsSL'));
    expect(s.indexOf('mountpoint -q "$d" || abbruch')).toBeLessThan(s.indexOf('mssql-conf -n setup'));
    expect(installSkript({ ...INSTALL, einhaengepunkte: ['/var/opt/mssql/data'] })).toContain("EINHAENGEN=('/var/opt/mssql/data')");
    expect(s).toContain("PID='EnterpriseDeveloper'");
    expect(s).not.toMatch(/apt-get [^\n]*install[^\n]*mssql-server(?!=)/);
    expect(s).toContain('Z=schon');
    expect(s).toContain('[ "$ee" = 3 ]');
  });
  it('Konfiguration: mssql-conf set nur bei Abweichung, Neustart nur wenn geändert, Einhängepunkte Pflicht', () => {
    const s = konfigSkript(KONFIG);
    expect(s).toContain('setze memory memorylimitmb "$MEM"');
    expect(s).toContain('setze filelocation defaultdatadir "$DATEN"');
    expect(s).toContain('setze filelocation defaultlogdir "$LOGD"');
    expect(s).toContain('setze filelocation defaultbackupdir "$SICHERUNG"');
    expect(s).toContain('setze sqlagent enabled "$AGENT"');
    expect(s).toContain("AGENT='true'");
    expect(s).toContain('if [ "$NEUSTART" = 1 ]; then');
    expect(s).toContain('mountpoint -q "$d" || abbruch');
    expect(s).toContain('RequiresMountsFor=');
    expect(s).toContain('chown mssql:mssql "$d"');
    expect(PY_CONF).toContain('interpolation=None');
  });
  it('SQL: tempdb nur auf die TempDB-Platte, nie Dateien entfernen; Speicher mit Nachprüfung', () => {
    const t = sqlSkript('tempdb', TEMPDB);
    expect(t).toContain("@pfad nvarchar(200) = N'\\''/var/opt/mssql/tempdb/'\\''");
    expect(t).toContain('@n int = 4, @mb int = 1024, @wmb int = 256, @logmb int = 1024');
    expect(t).toContain('THROW 50001');
    expect(t).not.toMatch(/REMOVE FILE/);
    expect(t).toContain('systemctl restart mssql-server');
    const m = sqlSkript('maxspeicher', { mb: 10240 });
    expect(m).toContain("EXEC sp_configure N'\\''max server memory (MB)'\\'', 10240");
    expect(m).toContain('[ "$neu" = 10240 ]');
    expect(m).toContain("IF @adv = 0 BEGIN EXEC sp_configure N'\\''show advanced options'\\'', 0; RECONFIGURE; END");
  });
  it.skipIf(!BASH)('bash -n: jedes erzeugte Skript ist syntaktisch gültig', () => {
    for (const [name, s] of alleSkripte()) {
      const r = spawnSync('bash', ['-n'], { input: s, encoding: 'utf8' });
      expect(r.stderr, name).toBe('');
      expect(r.status, name).toBe(0);
    }
  });
  it('ALFRED_P enthält nur geprüfte Felder — fremde Schlüssel (z. B. kennwort) nie im Skripttext', () => {
    const G = 'GEHEIM-xyz-123';
    const skripte = [
      plattenSkript({ platten: PLATTEN.platten.map(x => ({ ...x, kennwort: G })), kennwort: G } as never),
      installSkript({ ...INSTALL, kennwort: G } as never),
      konfigSkript({ ...KONFIG, kennwort: G } as never),
      sqlSkript('tempdb', { ...TEMPDB, kennwort: G } as never),
      sqlSkript('maxspeicher', { mb: 10240, kennwort: G } as never),
      sqlSkript('login', { ...LOGIN, kennwort: G } as never),
      linuxBausteinSkript(LINUX_SQL_BAUSTEINE.status, { kennwort: G }),
    ];
    for (const s of skripte) { expect(s).not.toContain(G); expect(s).not.toContain('"kennwort"'); }
    expect(plattenSkript(PLATTEN)).toContain(`ALFRED_P='${JSON.stringify(PLATTEN)}'`);
  });
  it('Installation: Einhängepunkte nur aus der festen Liste, data Pflicht', () => {
    expect(pruefeInstallation({ ...INSTALL, einhaengepunkte: ['/var/opt/mssql/data', '/var/opt/mssql/log'] })).toBeUndefined();
    expect(pruefeInstallation({ ...INSTALL, einhaengepunkte: ['/var/opt/mssql/log'] })).toContain('einhaengepunkte');
    expect(pruefeInstallation({ ...INSTALL, einhaengepunkte: ['/var/opt/mssql/data', '/tmp'] })).toContain('einhaengepunkte');
    expect(pruefeInstallation({ ...INSTALL, einhaengepunkte: ['/var/opt/mssql/data', '/var/opt/mssql/data'] })).toContain('einhaengepunkte');
    expect(pruefeInstallation({ ...INSTALL, einhaengepunkte: '/var/opt/mssql/data' })).toContain('einhaengepunkte');
  });
  it.skipIf(!PYTHON)('PY_FELD: Wert mit nicht druckbaren Zeichen (auch \\n am Ende, NUL) → Exit ≠ 0 statt still kürzen', () => {
    const feld = (json: string) => spawnSync(PYTHON!, ['-c', PY_FELD, 'sa'], { input: json, encoding: 'utf8' });
    expect(feld('{"sa":"abc"}').stdout).toBe('abc');
    expect(feld('{"sa":"abc"}').status).toBe(0);
    expect(feld('{"x":1}').status).toBe(0);
    for (const j of ['{"sa":"abc\\n"}', '{"sa":"a\\u0000b"}', '{"sa":"a\\tb"}', '{"sa":"\\n!!rm -rf /"}']) {
      const r = feld(j);
      expect(r.status, j).not.toBe(0);
      expect(r.stdout, j).toBe('');
    }
  });
  it.skipIf(!PYTHON)('eingebettete Python-Programme sind syntaktisch gültig', () => {
    for (const [name, prog] of [['status', PY_STATUS], ['feld', PY_FELD], ['conf', PY_CONF]] as const) {
      const r = spawnSync(PYTHON!, ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: prog, encoding: 'utf8' });
      expect(r.stderr, name).toBe('');
      expect(r.status, name).toBe(0);
    }
  });
});

// ── Login-Skript ausführen (bash): Kennwort landet unverfälscht und verdoppelt im T-SQL auf stdin, nie in der Ausgabe ──────────
function loginLauf(kennwort: string) {
  const skript = sqlSkript('login', LOGIN);
  const stubs = [
    `feld() { case "$1" in sa) printf '%s' 'Sa-Geheim-1234567890!'; ;; kennwort) printf '%s' ${shQ(kennwort)} ;; esac; }`,
    'bereit() { :; }',
    'sql() { [ "$SQLCMD" = /opt/mssql-tools18/bin/sqlcmd ] || return 9; printf "%s\\n" "$1" >>"$T/tsql"; echo "ALFRED|angelegt|1"; }',
    'json_text() { local x; x=$(cat); printf \'"%s"\' "${x//\\"/}"; }',
  ].join('\n');
  const text = skript.replace('# ALFRED-ABLAUF', `${stubs}\n# ALFRED-ABLAUF`);
  const huelle = `T=$(mktemp -d)\nALFRED_EINGABE=''\n( ${text}\n)\necho "RC=$?"\necho '---TSQL'; cat "$T/tsql" 2>/dev/null; rm -rf "$T"`;
  const r = spawnSync('bash', [], { input: huelle, encoding: 'utf8' });
  const [vorne, tsql = ''] = r.stdout.split('---TSQL\n');
  return { rc: Number(/RC=(\d+)/.exec(vorne)?.[1] ?? -1), ergebnis: sqlErgebnis<Record<string, unknown>>(vorne), vorne, tsql };
}

describe.skipIf(!BASH)('I8e Linux-SQL — Login-Skript ausgeführt', () => {
  it("Sonderzeichen & ' $( ` bleiben erhalten, ' wird verdoppelt; Ausgabe ohne Kennwort", () => {
    const kw = "Ab&c'd$(id)`x`&&Z9#%";
    const r = loginLauf(kw);
    expect(r.rc, r.vorne).toBe(0);
    expect(r.ergebnis).toEqual({ zustand: 'angelegt', login: 'app_kunden', serverrollen: ['dbcreator'] });
    expect(r.tsql).toContain("CREATE LOGIN [app_kunden] WITH PASSWORD = N'Ab&c''d$(id)`x`&&Z9#%'");
    expect(r.tsql).toContain("PWDCOMPARE(N'Ab&c''d$(id)`x`&&Z9#%', password_hash) = 1");
    expect(r.tsql).not.toContain('@@KW@@');
    expect(r.vorne).not.toContain('Ab&c');
    expect(r.vorne).not.toContain('Sa-Geheim');
  });
  it('Kennwort mit Zeilenumbruch (z. B. !!-Befehl für sqlcmd) → Abbruch ohne SQL', () => {
    const r = loginLauf('Gut-1234567890\n!!rm -rf /');
    expect(r.rc).toBe(1);
    expect(String(r.ergebnis?.fehler)).toContain('nicht druckbare');
    expect(r.tsql).toBe('');
  });
});

// ── Platten-Skript mit nachgebildeten Geräten ausführen (bash) ────────────────────────────────────────────────────────────────────
interface FakePlatte { scsi: number; dev: string; bytes: number; typ?: string; label?: string; uuid?: string; teile?: number; eingehaengt?: string; treffer?: number }

function plattenLauf(platten: FakePlatte[], p = PLATTEN, fstab = 'UUID=aaaa / ext4 defaults 0 1', ende = '\n') {
  const skript = plattenSkript(p);
  const marke = '# ALFRED-ABLAUF';
  expect(skript).toContain(marke);
  const a = (o: Record<string, string | number | undefined>) => Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => `[${k}]=${shQ(String(v))}`).join(' ');
  const stubs = [
    'FSTAB="$T/fstab"; LOG="$T/log"; : >"$LOG"',
    `printf '%s' ${shQ(fstab + ende)} >"$FSTAB"`,
    `declare -A SCSIDEV=(${a(Object.fromEntries(platten.map(x => [x.scsi, x.dev])))})`,
    `declare -A TREFFER=(${a(Object.fromEntries(platten.map(x => [x.scsi, x.treffer])))})`,
    `declare -A HCTLN=(${a(Object.fromEntries(platten.map(x => [x.dev, x.scsi])))})`,
    `declare -A GROESSE=(${a(Object.fromEntries(platten.map(x => [x.dev, x.bytes])))})`,
    `declare -A TYP=(${a(Object.fromEntries(platten.map(x => [x.dev, x.typ])))})`,
    `declare -A LAB=(${a(Object.fromEntries(platten.map(x => [x.dev, x.label])))})`,
    `declare -A UUIDM=(${a(Object.fromEntries(platten.map(x => [x.dev, x.uuid])))})`,
    `declare -A TEILE=(${a(Object.fromEntries(platten.map(x => [x.dev, x.teile])))})`,
    `declare -A MNT=(${a(Object.fromEntries(platten.filter(x => x.eingehaengt).map(x => [x.eingehaengt!, x.dev])))})`,
    'geraet_zu_scsi() { local n=$1; if [ -n "${TREFFER[$n]:-}" ]; then echo "${TREFFER[$n]} -"; elif [ -n "${SCSIDEV[$n]:-}" ]; then echo "1 ${SCSIDEV[$n]}"; else echo "0 -"; fi; }',
    'geraete_liste() { echo liste; }',
    'ziel_leer() { return 0; }',
    'readlink() { echo "${@: -1}"; }',
    'mkdir() { :; }',
    'udevadm() { :; }',
    'systemctl() { echo "systemctl $*" >>"$LOG"; }',
    'json_text() { local x; x=$(cat); printf \'"%s"\' "${x//\\"/}"; }',
    'lsblk() { local d=${@: -1}; case "$*" in *TYPE*) echo disk ;; *HCTL*) echo "2:0:0:${HCTLN[$d]}" ;; *"-nro NAME"*) for ((k=0; k<=${TEILE[$d]:-0}; k++)); do echo "t$k"; done ;; esac; }',
    'blockdev() { echo "${GROESSE[${@: -1}]}"; }',
    'blkid() { local d=${@: -1}; case "$*" in *"-s TYPE"*) echo "${TYP[$d]:-}" ;; *"-s LABEL"*) echo "${LAB[$d]:-}" ;; *"-s UUID"*) echo "${UUIDM[$d]:-}" ;; *export*) if [ -n "${TYP[$d]:-}" ]; then echo "TYPE=${TYP[$d]}"; fi ;; esac; return 0; }',
    'wipefs() { local d=${@: -1}; if [ -n "${TYP[$d]:-}" ]; then echo "${TYP[$d]}"; fi; }',
    'mkfs.xfs() { echo "mkfs $*" >>"$LOG"; local d=${@: -1}; TYP[$d]=xfs; LAB[$d]=$4; UUIDM[$d]=0123abcd-0000-4000-8000-00000000000${HCTLN[$d]}; }',
    'mount() { echo "mount $*" >>"$LOG"; local z=${@: -1} u d; u=$(awk -v z="$z" \'$2 == z { sub(/^UUID=/, "", $1); print $1 }\' "$FSTAB"); for d in "${!UUIDM[@]}"; do [ "${UUIDM[$d]}" != "$u" ] || MNT[$z]=$d; done; }',
    'findmnt() { case "$*" in *"-o SOURCE --mountpoint"*) echo "${MNT[${@: -1}]:-}" ;; *"-o FSTYPE --mountpoint"*) [ -z "${MNT[${@: -1}]:-}" ] || echo xfs ;; *"-o TARGET -S"*) local z; for z in "${!MNT[@]}"; do [ "${MNT[$z]}" != "${@: -1}" ] || echo "$z"; done ;; esac; }',
  ].join('\n');
  const text = skript.replace(marke, `${stubs}\n${marke}`);
  const huelle = `T=$(mktemp -d)\nALFRED_EINGABE=''\n( ${text}\n)\necho "RC=$?"\necho '---LOG'; cat "$T/log"; echo '---FSTAB'; cat "$T/fstab"; rm -rf "$T"`;
  const r = spawnSync('bash', [], { input: huelle, encoding: 'utf8' });
  const aus = r.stdout;
  const rc = Number(/RC=(\d+)/.exec(aus)?.[1] ?? -1);
  const log = aus.split('---LOG\n')[1]?.split('---FSTAB\n')[0] ?? '';
  const fstabNeu = aus.split('---FSTAB\n')[1] ?? '';
  return { rc, ergebnis: sqlErgebnis<Record<string, unknown>>(aus), log, fstab: fstabNeu, stderr: r.stderr, aus };
}

const GiB = 1073741824;
const LEER: FakePlatte[] = [
  { scsi: 1, dev: '/dev/sdb', bytes: 160 * GiB },
  { scsi: 2, dev: '/dev/sdc', bytes: 80 * GiB },
  { scsi: 3, dev: '/dev/sdd', bytes: 64 * GiB },
  { scsi: 4, dev: '/dev/sde', bytes: 128 * GiB },
];

describe.skipIf(!BASH)('I8e Linux-SQL — Platten-Skript mit nachgebildeten Geräten', () => {
  it('vier leere Platten passender Größe → formatiert, fstab per UUID mit nofail, eingehängt', () => {
    const r = plattenLauf(LEER);
    expect(r.rc, r.aus + r.stderr).toBe(0);
    expect(r.ergebnis?.zustand).toBe('geaendert');
    expect((r.ergebnis?.platten as Array<{ aktion: string }>).map(x => x.aktion)).toEqual(['formatiert', 'formatiert', 'formatiert', 'formatiert']);
    expect(r.log).toContain('mkfs -q -K -L mssql-data /dev/sdb');
    expect(r.log).toContain('mkfs -q -K -L mssql-backup /dev/sde');
    expect(r.fstab).toContain('UUID=0123abcd-0000-4000-8000-000000000001 /var/opt/mssql/data xfs defaults,noatime,nofail 0 0');
    expect(r.fstab).toContain('/var/opt/mssql/backup xfs defaults,noatime,nofail 0 0');
    expect(r.log).toContain('systemctl daemon-reload');
    expect(r.log).toContain('mount /var/opt/mssql/tempdb');
  });
  it('Größe außerhalb ±1 % an der letzten Platte → Abbruch, keine Platte formatiert, fstab unverändert', () => {
    const r = plattenLauf([...LEER.slice(0, 3), { ...LEER[3], bytes: 130 * GiB }]);
    expect(r.rc).toBe(1);
    expect(r.ergebnis?.zustand).toBe('fehler');
    expect(String(r.ergebnis?.fehler)).toContain('scsi4');
    expect(String(r.ergebnis?.fehler)).toContain('nichts geändert');
    expect(r.log).not.toContain('mkfs');
    expect(r.fstab.trim()).toBe('UUID=aaaa / ext4 defaults 0 1');
    // innerhalb ±1 % ist in Ordnung
    expect(plattenLauf([...LEER.slice(0, 3), { ...LEER[3], bytes: 128 * GiB + Math.floor(1.2 * GiB) }]).rc).toBe(0);
  });
  it('vorhandene Signatur, Partitionen, fehlende oder mehrdeutige Platte, falsche SCSI-Adresse → Abbruch ohne Änderung', () => {
    for (const fall of [
      [...LEER.slice(0, 2), { ...LEER[2], typ: 'ext4' }, LEER[3]],
      [...LEER.slice(0, 2), { ...LEER[2], typ: 'xfs', label: 'fremd', uuid: '11111111-2222-3333-4444-555555555555' }, LEER[3]],
      [LEER[0], { ...LEER[1], teile: 1 }, ...LEER.slice(2)],
      [LEER[0], LEER[1], LEER[2]],
      [LEER[0], { ...LEER[1], treffer: 2 }, LEER[2], LEER[3]],
      [LEER[0], { ...LEER[1], dev: '/dev/sdb' }, LEER[2], LEER[3]],
    ] as FakePlatte[][]) {
      const r = plattenLauf(fall);
      expect(r.rc, r.aus).toBe(1);
      expect(r.ergebnis?.zustand).toBe('fehler');
      expect(String(r.ergebnis?.fehler)).toContain('nichts geändert');
      expect(r.log).not.toContain('mkfs');
      expect(r.log).not.toContain('mount');
      expect(r.fstab.trim()).toBe('UUID=aaaa / ext4 defaults 0 1');
    }
  });
  it('erneuter Lauf: eigene XFS-Platten schon eingehängt und eingetragen → schon, nichts geändert', () => {
    const fertig = LEER.map((x, i) => ({ ...x, typ: 'xfs', label: ['mssql-data', 'mssql-log', 'mssql-tempdb', 'mssql-backup'][i], uuid: `0123abcd-0000-4000-8000-00000000000${x.scsi}`, eingehaengt: PLATTEN.platten[i].ziel }));
    const fstab = ['UUID=aaaa / ext4 defaults 0 1', ...fertig.map((x, i) => `UUID=${x.uuid} ${PLATTEN.platten[i].ziel} xfs defaults,noatime,nofail 0 0`)].join('\n');
    const r = plattenLauf(fertig, PLATTEN, fstab);
    expect(r.rc, r.aus).toBe(0);
    expect(r.ergebnis?.zustand).toBe('schon');
    expect((r.ergebnis?.platten as Array<{ aktion: string }>).every(x => x.aktion === 'schon')).toBe(true);
    expect(r.log).toBe('');
    expect(r.fstab.trim()).toBe(fstab);
    // halb fertig (formatiert, nicht eingetragen, nicht eingehängt) → nachgezogen, nicht neu formatiert
    const halb = plattenLauf(fertig.map(x => ({ ...x, eingehaengt: undefined })), PLATTEN);
    expect(halb.rc, halb.aus).toBe(0);
    expect(halb.log).not.toContain('mkfs');
    expect(halb.fstab).toContain('/var/opt/mssql/log xfs defaults,noatime,nofail 0 0');
    expect(halb.ergebnis?.zustand).toBe('geaendert');
  });
  it('fstab hängt das Ziel schon mit fremder UUID ein → Abbruch', () => {
    const r = plattenLauf(LEER, PLATTEN, 'UUID=aaaa / ext4 defaults 0 1\nUUID=ffff /var/opt/mssql/data xfs defaults 0 0');
    expect(r.rc).toBe(1);
    expect(r.log).not.toContain('mkfs');
  });
  it('fstab ohne Zeilenende: letzte Zeile bleibt unverändert, neue Einträge in eigenen Zeilen', () => {
    const r = plattenLauf(LEER, PLATTEN, 'UUID=aaaa / ext4 defaults 0 1', '');
    expect(r.rc, r.aus).toBe(0);
    const zeilen = r.fstab.trimEnd().split('\n');
    expect(zeilen[0]).toBe('UUID=aaaa / ext4 defaults 0 1');
    expect(zeilen).toHaveLength(5);
    expect(zeilen[1]).toBe('UUID=0123abcd-0000-4000-8000-000000000001 /var/opt/mssql/data xfs defaults,noatime,nofail 0 0');
  });
  it('fstab hängt ein anderes Ziel mit fremder UUID ein → Abbruch', () => {
    const r = plattenLauf(LEER, PLATTEN, 'UUID=ffff /var/opt/mssql/log xfs defaults 0 0');
    expect(r.rc).toBe(1);
    expect(r.log).not.toContain('mkfs');
  });
});
