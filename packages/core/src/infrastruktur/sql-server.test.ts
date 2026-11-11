import { describe, it, expect } from 'vitest';
import {
  pruefeMedien, pruefeInstallation, installierenSkript, pruefeKonfiguration, konfigurierenSkript, endpunktSkript, pruefeAg, agAnlegenSkript, pruefeListener, failoverSkript,
  pruefeSicherung, sicherungTsql, pruefeJobs, jobsSkript, pruefeWiederherstellung, wiederherstellungSkript, pruefdatenSchreibenSkript as pruefdatenSchreiben, sqlStatusText, nText, psDq, medienSkript, SQL_FN, type SqlStatus,
} from './sql-server.js';
import { SqlServerSkill } from './sql-server-skill.js';
import { aktionsArt, pruefeChangePlan } from './change-schritte.js';

// I8d (Architektur 3ca3873e v3) — SQL Server über feste Bausteine
const INST = { engine_konto: 'AD3033\\gmsa-sqleng$', agent_konto: 'AD3033\\gmsa-sqlagt$', sysadmins: ['AD3033\\alfred'], daten: 'D:\\SQLData', log: 'L:\\SQLLog', tempdb: 'T:\\TempDB', sicherung: 'B:\\SQLBackup' };

describe('I8d Bausteine sql_server', () => {
  it('Medien nur von Microsoft, Signatur wird geprüft', () => {
    expect(pruefeMedien({ url: 'https://go.microsoft.com/fwlink/?linkid=123456' })).toEqual({ url: 'https://go.microsoft.com/fwlink/?linkid=123456', art: 'installation' });
    expect(pruefeMedien({ url: 'https://example.com/sql.exe' })).toContain('Microsoft');
    expect(pruefeMedien({ url: 'http://download.microsoft.com/x.exe' })).toContain('Microsoft');
    expect(pruefeMedien({ url: 'https://download.microsoft.com/x.exe', sha256: 'abc' })).toContain('sha256');
    const m = medienSkript({ url: 'https://download.microsoft.com/x.exe', art: 'installation' });
    expect(m).toContain("O=Microsoft Corporation");
    expect(m).toContain("'/ACTION=Download'");
    expect(m).not.toContain('ReadAllBytes'); // ISO nicht komplett in den Speicher
    // v1795 Realfall E2: Zielordner vor Copy-Item anlegen; ISO eines früheren Laufs wiederverwenden
    expect(m.indexOf("New-Item -ItemType Directory -Path $setup -Force")).toBeLessThan(m.indexOf('Copy-Item -Path ($lw'));
    expect(m).toContain('$r.isoWiederverwendet = $true');
  });
  it('Installation: gMSA-Dienste, getrennte Platten, Werte der Architektur als Standard, als Domänenkonto', () => {
    const p = pruefeInstallation(INST);
    expect(p).toMatchObject({ tempdb_dateien: 4, tempdb_mb: 1024, tempdb_log_mb: 2048, max_speicher_mb: 12288, maxdop: 4 });
    expect(pruefeInstallation({ ...INST, engine_konto: 'AD3033\\Administrator' })).toContain('gMSA');
    expect(pruefeInstallation({ ...INST, log: 'D:\\SQLLog' })).toContain('getrennten');
    expect(pruefeInstallation({ ...INST, tempdb_dateien: 16 })).toContain('höchstens 8');
    const s = installierenSkript(p as never);
    expect(s).toContain("$nb + '\\alfred' })) $e.kennwort");
    for (const x of ['/SQLSVCINSTANTFILEINIT=True', '/TCPENABLED=1', '/NPENABLED=0', '/SQLUSERDBLOGDIR=', '/SQLTEMPDBFILECOUNT=', '/UPDATESOURCE=']) expect(s).toContain(x);
    expect(s).toMatch(/Ergebnis \$w\nif \(\$w\.neustart\) \{ shutdown\.exe/);
  });
  it('Konfiguration nennt die vorherigen Werte; Endpunkt mit AES und CONNECT für das Partnerkonto', () => {
    expect(pruefeKonfiguration({ max_speicher_mb: 12288, maxdop: 4, kostenschwelle: 50 })).toEqual({ max_speicher_mb: 12288, maxdop: 4, kostenschwelle: 50 });
    expect(pruefeKonfiguration({})).toContain('mindestens');
    expect(konfigurierenSkript({ kostenschwelle: 50 })).toContain("EXEC sp_configure N'cost threshold for parallelism', 50;");
    const e = endpunktSkript({ port: 5022, partner_konto: 'AD3033\\gmsa-sqleng$' });
    expect(e).toContain('ENCRYPTION = REQUIRED ALGORITHM AES');
    expect(e).toContain('GRANT CONNECT ON ENDPOINT::[Hadr_endpoint] TO [AD3033\\gmsa-sqleng`$]'); // $ für PowerShell maskiert
  });
  it('AG: primär zuerst, synchron/automatisch, Sicherungsvorzug PRIMARY; Failover nie mit Datenverlust', () => {
    const p = pruefeAg({ name: 'ag01', datenbanken: ['alfredtest'], replikate: [{ server: 'sql01', fqdn: 'sql01.ad.3033.at' }, { server: 'SQL02', fqdn: 'sql02.ad.3033.at' }] });
    expect(p).toMatchObject({ name: 'ag01', port: 5022, replikate: [{ server: 'SQL01' }, { server: 'SQL02' }] });
    expect(pruefeAg({ name: 'ag01', datenbanken: ['x'], replikate: [{ server: 'SQL01', fqdn: 'sql02.ad.3033.at' }, { server: 'SQL02', fqdn: 'sql02.ad.3033.at' }] })).toContain('replikate');
    const a = agAnlegenSkript(p as never);
    expect(a).toContain("N'TCP://sql02.ad.3033.at:5022'");
    expect(a).toContain('AUTOMATED_BACKUP_PREFERENCE = PRIMARY');
    expect(a).toContain('SEEDING_MODE = AUTOMATIC');
    const f = failoverSkript({ ag: 'ag01' });
    expect(f).toContain('ALTER AVAILABILITY GROUP [ag01] FAILOVER');
    expect(f).not.toContain('FORCE_ALLOW_DATA_LOSS');
    expect(f).toContain("synchronization_state_desc <> 'SYNCHRONIZED'");
    expect(pruefeListener({ ag: 'ag01', name: 'sqlag01', ip: '10.203.30.5', maske: '255.255.255.224' })).toEqual({ ag: 'ag01', name: 'sqlag01', ip: '10.203.30.5', maske: '255.255.255.224', port: 1433 });
  });
  it('Sicherung: Unterordner je Datenbank, Zeitstempel im Namen, Prüfsumme; Jobs nur auf dem bevorzugten Replikat, ohne Löschen', () => {
    expect(pruefeSicherung({ datenbank: 'alfredtest', art: 'log', ziel: '\\\\fs01.ad.3033.at\\SQLBackup$\\' })).toEqual({ datenbank: 'alfredtest', art: 'log', ziel: '\\\\fs01.ad.3033.at\\SQLBackup$' });
    expect(pruefeSicherung({ datenbank: 'x', art: 'voll', ziel: 'C:\\Temp' })).toContain('ziel');
    const t = sicherungTsql('\\\\fs01\\SQLBackup$', 'diff', nText('alfredtest'));
    expect(t).toContain('BACKUP DATABASE @db TO DISK = @f WITH DIFFERENTIAL, CHECKSUM, COMPRESSION, INIT');
    expect(t).toContain("N'_diff_' + FORMAT(SYSDATETIME(), 'yyyyMMdd_HHmmss') + N'.dif'");
    const j = jobsSkript(pruefeJobs({ datenbanken: ['alfredtest'], ziel: '\\\\fs01\\SQLBackup$' }) as never);
    expect(j).toContain('sys.fn_hadr_backup_is_preferred_replica(@d) = 1');
    expect(j).toContain("Alfred Sicherung log");
    expect(j).not.toMatch(/xp_delete_file|sp_delete_backuphistory/);
    expect(pruefeJobs({ datenbanken: ['x'], ziel: 'B:\\SQLBackup', log_minuten: 7 })).toContain('log_minuten');
  });
  it('Wiederherstellungstest: neben der AG, Liste über den Datenbankdienst, Platzprüfung, CHECKDB', () => {
    expect(pruefeWiederherstellung({ datenbank: 'alfredtest', ordner: '\\\\fs01\\SQLBackup$\\alfredtest', ziel_name: 'alfredtest' })).toContain('unterscheiden');
    const w = wiederherstellungSkript(pruefeWiederherstellung({ datenbank: 'alfredtest', ordner: '\\\\fs01\\SQLBackup$\\alfredtest', ziel_name: 'alfredtest_wh' }) as never);
    expect(w).toContain('xp_dirtree');
    expect(w).toContain('zu wenig Platz');
    expect(w).toContain('DBCC CHECKDB');
    // v1796 Realfall E3 1e1cdb4e Schritt 21: gepoolte Verbindung hielt die Test-Kopie offen (DROP „in use“)
    expect(SQL_FN).toContain('Pooling=false');
    expect(w).toContain('WITH CHECKSUM, NORECOVERY');
    expect(psDq('a$b"c')).toBe('a`$b`"c');
    // freie Notiz kann weder aus dem T-SQL- noch aus dem PowerShell-String ausbrechen
    expect(pruefdatenSchreiben({ datenbank: 'alfredtest', notiz: "x'$(Remove-Item C:\)\"" })).toContain("VALUES (N'x''`$(Remove-Item C:\)`\"')");
  });
  it('Statustext im prüfbaren Wortlaut', () => {
    const s: SqlStatus = { rechner: 'SQL01', installiert: true, version: '17.0.1000.7', stufe: 'RTM', cu: 'CU1', edition: 'Enterprise Developer Edition (64-bit)', hadr: true, maxSpeicherMb: 12288, maxdop: 4, kostenschwelle: 50, tempdbDateien: 4, ifi: true,
      dienste: [{ name: 'SQL Server (MSSQLSERVER)', zustand: 'Running', konto: 'AD3033\\gmsa-sqleng$' }], datenbanken: [{ name: 'alfredtest', zustand: 'ONLINE', modell: 'FULL', mb: 16 }],
      ags: [{ name: 'ag01', replikat: 'SQL01', rolle: 'PRIMARY', modus: 'SYNCHRONOUS_COMMIT', failover: 'AUTOMATIC', gesundheit: 'HEALTHY', verbunden: 'CONNECTED' }, { name: 'ag01', replikat: 'SQL02', rolle: 'SECONDARY', modus: 'SYNCHRONOUS_COMMIT', failover: 'AUTOMATIC', gesundheit: 'HEALTHY', verbunden: 'CONNECTED' }],
      agDbs: [{ db: 'alfredtest', replikat: 'SQL02', zustand: 'SYNCHRONIZED' }], listener: [{ name: 'sqlag01', port: 1433, ip: '10.203.30.5' }] };
    const t = sqlStatusText(s);
    for (const x of ['HADR an', 'max Speicher 12288 MB, MAXDOP 4, Kostenschwelle 50', 'TempDB 4 Dateien; IFI an', 'AG ag01: SQL01 PRIMARY HEALTHY synchron automatisch, SQL02 SECONDARY HEALTHY', 'alfredtest@SQL02 SYNCHRONIZED', 'Listener sqlag01:1433 10.203.30.5']) expect(t).toContain(x);
    expect(sqlStatusText({ rechner: 'SQL01', installiert: false })).toBe('SQL01: SQL Server nicht installiert');
  });
});

describe('I8d Skill sql_server', () => {
  const imChange = { ausChange: true } as never;
  function welt(antworten: object[]) {
    const aufrufe: Array<{ befehl: string; eingabe?: string }> = [];
    const skill = new SqlServerSkill({
      skript: async (_z, befehl, eingabe) => { aufrufe.push({ befehl, ...(eingabe !== undefined ? { eingabe } : {}) }); return { code: 0, stdout: `ALFRED-AD ${JSON.stringify(antworten.shift() ?? {})}`, stderr: '' }; },
      tresor: { namen: async () => new Set(['win-dc01-admin']), lies: async n => `geheim-${n}` },
      schlafe: async () => undefined,
    });
    return { skill, aufrufe };
  }
  it('ändernd nur im Change; Installation mit Kennwort nur über die Standardeingabe, wartet nach Neustart', async () => {
    const { skill, aufrufe } = welt([{ zustand: 'installiert', code: 3010, neustart: true, summary: ['Final result: Passed'] }, { rechner: 'SQL01', installiert: true, version: '17.0.1', stufe: 'RTM', edition: 'Dev' }]);
    expect((await skill.execute({ action: 'sql_installieren', zugang: 'sql01', ...INST, konto_tresor: 'win-dc01-admin' }, {} as never)).error).toContain('nur als Schritt');
    const r = await skill.execute({ action: 'sql_installieren', zugang: 'sql01', ...INST, konto_tresor: 'win-dc01-admin' }, imChange);
    expect(r.success).toBe(true);
    expect(r.display).toContain('(Neustart)');
    expect(aufrufe[0]!.eingabe).toBe('{"kennwort":"geheim-win-dc01-admin"}');
    expect(Buffer.from(aufrufe[0]!.befehl.split(' ').pop()!, 'base64').toString('utf16le')).not.toContain('geheim-');
  });
  it('status und pruefdaten_lesen auch außerhalb; Failover-Ergebnis mit Dauer', async () => {
    const { skill } = welt([{ rechner: 'SQL02', installiert: false }, { zustand: 'Failover', primaer: 'SQL02', ms: 2300 }]);
    expect((await skill.execute({ action: 'status', zugang: 'sql02' }, {} as never)).display).toBe('SQL02: SQL Server nicht installiert');
    expect((await skill.execute({ action: 'failover', zugang: 'sql02', ag: 'ag01' }, imChange)).display).toBe('✅ Failover: SQL02 ist primär in ag01 (2.3 s)');
  });
  it('Change-Plan: status lesend, Installation ohne Rückweg zulässig, AG nur mit Rückweg', () => {
    expect(aktionsArt('sql_server', 'status')).toBe('lesen');
    expect(aktionsArt('sql_server', 'pruefdaten_lesen')).toBe('lesen');
    expect(aktionsArt('sql_server', 'sql_sicherung')).toBe('aendern');
    const sk = new SqlServerSkill({ skript: async () => ({ code: 0, stdout: '', stderr: '' }) });
    const pr = { typ: 'skill', skill: 'sql_server', aktion: 'status', parameter: { zugang: 'sql01' }, erwartet: 'HADR an' };
    const plan = (rueckweg: object) => ({ titel: 'sql01 Installation und AG', begruendung: 'I8d Architektur 3ca3873e v3', typ: 'normal', risiko: 'mittel', ausfallMinuten: 0, betroffen: ['sql01'],
      schritte: [
        { titel: 'SQL installieren', art: 'aktion', skill: 'sql_server', aktion: 'sql_installieren', parameter: { zugang: 'sql01', ...INST, konto_tresor: 'win-dc01-admin' }, zeitlimitS: 7200, rueckweg: { keiner: 'Deinstallation ist ein eigener Change' }, pruefung: { ...pr, erwartet: 'SQL01: SQL Server' } },
        { titel: 'AG anlegen', art: 'aktion', skill: 'sql_server', aktion: 'ag_anlegen', parameter: { zugang: 'sql01', name: 'ag01', datenbanken: ['alfredtest'], replikate: [{ server: 'SQL01', fqdn: 'sql01.ad.3033.at' }, { server: 'SQL02', fqdn: 'sql02.ad.3033.at' }] }, rueckweg, pruefung: { ...pr, erwartet: 'SQL01 PRIMARY' } },
      ] });
    const ctx = { skill: (n: string) => (n === 'sql_server' ? sk as never : undefined), asset: (n: string) => ({ id: `a-${n}`, name: n }), changes: [] };
    expect(pruefeChangePlan(plan({ skill: 'sql_server', aktion: 'ag_entfernen', parameter: { zugang: 'sql01', name: 'ag01' } }), ctx).fehler.filter(x => /Rückweg|sql_server|rueckweg/.test(x))).toEqual([]);
    expect(pruefeChangePlan(plan({ keiner: 'egal' }), ctx).fehler.some(x => x.includes('Schritt 2') && x.includes('ohne Rückweg nur bei'))).toBe(true);
  });
});

describe('v1789 benannte Instanzen', () => {
  it('Instanz steuert Dienste, Verbindung und Setup; AG-Replikat SQL01\INST', async () => {
    const { INSTANZ_VOR, sqlStatusSkript } = await import('./sql-server.js');
    expect(sqlStatusSkript('PROD')).toContain('"instanz":"PROD"');
    expect(INSTANZ_VOR.join('\n')).toContain("'MSSQL$' + $inst");
    expect(installierenSkript({ ...(pruefeInstallation(INST) as object), instanz: 'PROD' } as never)).toContain("(''/INSTANCENAME='' + $inst)");
    expect(pruefeAg({ name: 'ag01', datenbanken: ['x'], replikate: [{ server: 'SQL01\\PROD', fqdn: 'sql01.ad.3033.at' }, { server: 'SQL02\\PROD', fqdn: 'sql02.ad.3033.at' }], port: 5023 })).toMatchObject({ port: 5023 });
    expect(sqlStatusText({ rechner: 'SQL01', instanz: 'PROD', installiert: false })).toBe('SQL01\\PROD: SQL Server nicht installiert');
    const aufrufe: string[] = [];
    const skill = new SqlServerSkill({ skript: async (_z, b) => { aufrufe.push(Buffer.from(b.split(' ').pop()!, 'base64').toString('utf16le')); return { code: 0, stdout: 'ALFRED-AD {"zustand":"neu","name":"x","dateien":[]}', stderr: '' }; } });
    await skill.execute({ action: 'datenbank_anlegen', zugang: 'sql01', name: 'x', instanz: 'prod' }, { ausChange: true } as never);
    expect(aufrufe[0]).toContain('"instanz":"PROD"');
    expect((await skill.execute({ action: 'status', zugang: 'sql01', instanz: 'a b' }, {} as never)).error).toContain('instanz');
  });
});

describe('v1790 listener_testen', () => {
  it('lesend auch außerhalb von Changes, als Domänenkonto per Kennwort-Anmeldung, Text mit Kerberos-Nachweis', async () => {
    const { listenerTestSkript } = await import('./sql-server.js');
    const s = listenerTestSkript({ listener: 'sqlag01.ad.3033.at', port: 1433 });
    expect(s).toContain('MitKonto');
    expect(s).toContain("Server=tcp:'' + $p.listener");
    expect(s).toContain('auth_scheme');
    expect(aktionsArt('sql_server', 'listener_testen')).toBe('lesen');
    const aufrufe: Array<{ eingabe?: string }> = [];
    const skill = new SqlServerSkill({
      skript: async (_z, _b, eingabe) => { aufrufe.push({ ...(eingabe !== undefined ? { eingabe } : {}) }); return { code: 0, stdout: 'ALFRED-AD {"server":"SQL01","rolle":"PRIMARY","anmeldung":"KERBEROS","konto":"AD3033\\\\alfred","verschluesselt":true,"transport":"TCP","adresse":"10.203.30.5","port":1433,"ms":85}', stderr: '' }; },
      tresor: { namen: async () => new Set(['win-dc01-admin']), lies: async () => 'pw' },
    });
    const r = await skill.execute({ action: 'listener_testen', zugang: 'probe-win25b', listener: 'sqlag01.ad.3033.at', konto_tresor: 'win-dc01-admin' }, {} as never);
    expect(r.display).toBe('Listener sqlag01.ad.3033.at:1433 → SQL01 (PRIMARY), Anmeldung AD3033\\alfred über KERBEROS, verschlüsselt (Zertifikat nicht geprüft), TCP 10.203.30.5:1433, 85 ms');
    expect(aufrufe[0]!.eingabe).toBe('{"kennwort":"pw"}');
    expect((await skill.execute({ action: 'listener_testen', zugang: 'x', listener: 'sqlag01', konto_tresor: 'win-dc01-admin' }, {} as never)).error).toContain('listener');
  });
});

// v1799 — Realfall F2 863292a9 Schritt 9: SQL-Dienst-SID fehlte in Get-ClusterAccess (HadrManagerStatus 0)
describe('v1799 hadr_aktivieren mit Clusterzugriff', () => {
  it('gibt dem Dienstkonto Clusterzugriff, startet neu und wartet auf HadrManagerStatus 1', async () => {
    const { hadrSkript } = await import('./sql-server.js');
    const s = hadrSkript();
    expect(s).toContain("$konto = 'NT SERVICE\\' + $svc");
    expect(s).toContain('Grant-ClusterAccess -User $konto -Full');
    expect(s.indexOf('Grant-ClusterAccess')).toBeLessThan(s.indexOf('Restart-Service -Name $svc'));
    expect(s).toContain("HadrManagerStatus");
    expect(s).toContain("if ($s.h -eq 1 -and $s.m -eq 1 -and $hatZugriff -and -not $p.neustart) {");
    expect(hadrSkript('PROD')).toContain('"instanz":"PROD"');
  });
});

// v1800 — Realfall F2 863292a9 Schritt 11: Fehler 41105, Cluster-Ressourcentyp „SQL Server Availability Group“ fehlte
describe('v1800 hadr_aktivieren registriert den AG-Ressourcentyp', () => {
  it('prüft den Typ im Schon-Fall und registriert hadrres.dll aus dem Binn-Verzeichnis', async () => {
    const { hadrSkript } = await import('./sql-server.js');
    const s = hadrSkript();
    expect(s).toContain("$rtName = 'SQL Server Availability Group'");
    expect(s).toContain("Join-Path $bin 'hadrres.dll'");
    // v1801: das SSH-Skript registriert nicht selbst (Doppel-Hop), sondern meldet „fehlt“ + dll
    expect(s).not.toContain('Add-ClusterResourceType');
    expect(s).toContain("ressourcentyp = 'fehlt'; dll = (DllPfad)");
    expect(s).toContain("if ($hatTyp) { Ergebnis @{ zustand = 'schon'");
    expect(s.indexOf('$instId =')).toBeLessThan(s.indexOf('function DllPfad'));
  });
  it('v1801 registriert per Kennwort-Anmeldung und prüft den dll-Pfad', async () => {
    const { ressourcentypSkript } = await import('./sql-server.js');
    const r = ressourcentypSkript({ dll: 'C:\\Program Files\\Microsoft SQL Server\\MSSQL17.MSSQLSERVER\\MSSQL\\Binn\\hadrres.dll' });
    expect(r).toContain('MitKonto');
    expect(r).toContain('Add-ClusterResourceType -Name $rt -Dll $p.dll');
    expect(() => ressourcentypSkript({ dll: "C:\\x\\evil'.dll" })).toThrow();
  });
});

// v1802 — Realfall F2 863292a9 Schritt 12: Fehler 35222, SQL lief seit vor der Registrierung des AG-Ressourcentyps
describe('v1802 hadr_aktivieren mit Neustart', () => {
  it('neustart überspringt den Schon-Fall und startet den Dienst neu', async () => {
    const { hadrSkript } = await import('./sql-server.js');
    expect(hadrSkript()).not.toContain('"neustart":true');
    const s = hadrSkript(undefined, true);
    expect(s).toContain('"neustart":true');
    expect(s).toContain('$hatZugriff -and -not $p.neustart)');
    expect(s).toContain("'neu gestartet'");
    expect(hadrSkript('PROD', true)).toContain('"instanz":"PROD"');
  });
});

// v1803 — Realfall F2 863292a9 Schritt 14: 35222 trotz Neustart, Clusterprotokoll HadrAgNameToIdMap error 5
describe('v1803 hadr_aktivieren über WMI ChangeHADRService', () => {
  it('schaltet wie der Configuration Manager aus und ein, Registry nur als Rückfall', async () => {
    const { hadrSkript } = await import('./sql-server.js');
    const s = hadrSkript(undefined, true);
    expect(s).toContain("$ns = 'root\\Microsoft\\SqlServer\\ComputerManagement' + ($instId -replace '^MSSQL(\\d+)\\..*$', '$1')");
    expect(s).toContain('-MethodName ChangeHADRService');
    expect(s).toContain("if ($p.neustart -and @(Hs)[0].HADRServiceEnabled) { Hadr 0; $r.ausUndEin = $true }; Hadr 1; $r.weg = 'wmi'");
    expect(s.indexOf('Hadr 1')).toBeLessThan(s.indexOf("Set-ItemProperty -Path $k -Name 'HADR_Enabled'"));
    expect(s.indexOf("$r.weg = 'registry'")).toBeLessThan(s.indexOf('Restart-Service -Name $svc'));
  });
});

// v1804 — Realfall F2 Schritt 14/15: (Hs).Count war leer (PS 5.1 entrollt das Ein-Element-Array, CimInstance ohne Count) → Registry-Weg
describe('v1804 HADRServiceSettings als Array zählen', () => {
  it('nutzt @(Hs) für Count und Index', async () => {
    const { hadrSkript } = await import('./sql-server.js');
    const s = hadrSkript(undefined, true);
    expect(s).toContain('if (@(Hs).Count)');
    expect(s).toContain('-InputObject @(Hs)[0]');
    expect(s).not.toMatch(/[^@]\(Hs\)(\.Count|\[0\])/);
  });
});
