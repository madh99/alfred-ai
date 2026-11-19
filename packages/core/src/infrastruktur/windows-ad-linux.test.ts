import { describe, it, expect } from 'vitest';
import { powershellVorhanden, parseSkripte } from './powershell-parser.testhilfe.js';
import { dienstkontoSkript, dienstkontoGehaertet } from './windows-ad.js';
import {
  pruefeSpns, spnSetzenSkript, spnEntfernenSkript, spnLesenSkript, computerkontoSkript, computerkontoEntfernenSkript, pruefeComputerkonto,
  pruefePtr, dnsPtrSkript, dnsPtrLoeschenSkript, gruppeSkript, gruppeEntfernenSkript, pruefeGruppe, sqlAnmeldungSkript, sqlAnmeldungAuswerten,
  SQLCMD_PFADE, joinTresorName, sqlcmdArgumente, SQL_PROBE_TSQL,
} from './windows-ad-linux.js';
import { WindowsAdSkill, einmalKennwort } from './windows-ad-skill.js';
import { aktionsArt, pruefeChangePlan } from './change-schritte.js';

// I8e Etappe 3 Task 2 — AD-Objekte für Kerberos der Linux-SQL-Instanzen (Spec docs/specs/2026-11-19-i8e-linux-sql-ad-tls.md)
const roh = (befehl: string) => Buffer.from(befehl.split(' ').pop()!, 'base64').toString('utf16le');

function welt(antworten: object[], tresorDa: string[] = []) {
  const aufrufe: Array<{ zugang: string; befehl: string; eingabe?: string; zweck: string }> = [];
  const tresor = new Map<string, string>(tresorDa.map(n => [n, `wert-${n}`]));
  const gesetzt: Array<{ name: string; wert: string }> = [];
  const skill = new WindowsAdSkill({
    skript: async (zugang, befehl, eingabe, _t, zweck) => {
      aufrufe.push({ zugang, befehl, ...(eingabe !== undefined ? { eingabe } : {}), zweck });
      const a = antworten.shift();
      if (!a) throw new Error('keine Antwort');
      return { code: 0, stdout: `ALFRED-AD ${JSON.stringify(a)}`, stderr: '' };
    },
    tresor: { namen: async () => new Set(tresor.keys()), lies: async n => tresor.get(n)!, setze: async (n, w) => { tresor.set(n, w); gesetzt.push({ name: n, wert: w }); } },
    schlafe: async () => undefined,
  });
  return { skill, aufrufe, tresor, gesetzt };
}
const imChange = { ausChange: true } as never;

describe('I8e Etappe 3 — Eingabeprüfung', () => {
  it('SPNs nur MSSQLSvc/<name>.ad.3033.at[:1433]', () => {
    expect(pruefeSpns(['MSSQLSvc/sqllnx01.ad.3033.at:1433'])).toEqual(['MSSQLSvc/sqllnx01.ad.3033.at:1433']);
    expect(pruefeSpns(['MSSQLSvc/sqllnx01.ad.3033.at', 'MSSQLSvc/sqllnx01.ad.3033.at'])).toEqual(['MSSQLSvc/sqllnx01.ad.3033.at']);
    expect(typeof pruefeSpns(['HTTP/x'])).toBe('string');
    expect(typeof pruefeSpns(['MSSQLSvc/sqllnx01.ad.3033.at:1434'])).toBe('string');
    expect(typeof pruefeSpns(['MSSQLSvc/SQLLNX01.ad.3033.at'])).toBe('string');
    expect(typeof pruefeSpns(['MSSQLSvc/sqllnx01.example.com'])).toBe('string');
    expect(typeof pruefeSpns([])).toBe('string');
  });
  it('Computerkonto, PTR, Gruppe', () => {
    expect(pruefeComputerkonto({ name: 'sqllnx01', ou: 'Server' })).toEqual({ name: 'SQLLNX01', ou: 'Server' });
    expect(typeof pruefeComputerkonto({ name: 'viel-zu-langer-rechnername', ou: 'Server' })).toBe('string');
    expect(typeof pruefeComputerkonto({ name: "a'b", ou: 'Server' })).toBe('string');
    expect(joinTresorName('SQLLNX01')).toBe('ad-join-sqllnx01');
    expect(pruefePtr({ zone: '30.203.10.in-addr.arpa', ip: '10.203.30.11', fqdn: 'sqllnx01.ad.3033.at' })).toEqual({ zone: '30.203.10.in-addr.arpa', ip: '10.203.30.11', fqdn: 'sqllnx01.ad.3033.at', name: '11' });
    expect(typeof pruefePtr({ zone: '30.203.10.in-addr.arpa', ip: '10.203.29.11', fqdn: 'sqllnx01.ad.3033.at' })).toBe('string');
    expect(typeof pruefePtr({ zone: 'ad.3033.at', ip: '10.203.30.11', fqdn: 'sqllnx01.ad.3033.at' })).toBe('string');
    expect(pruefeGruppe({ gruppe: 'SQL-Linux-Admins', ou: 'Dienstkonten', mitglieder: ['svc-sqllnx-test'] })).toEqual({ gruppe: 'SQL-Linux-Admins', ou: 'Dienstkonten', mitglieder: ['svc-sqllnx-test'] });
    expect(typeof pruefeGruppe({ gruppe: 'SQL-Linux-Admins', ou: 'Dienstkonten', mitglieder: ["x'; rm"] })).toBe('string');
  });
  it('Einmal-Kennwort: 24 Zeichen, alle Zeichenklassen, ohne Anführungszeichen', () => {
    for (let i = 0; i < 50; i++) {
      const k = einmalKennwort();
      expect(k).toHaveLength(24);
      expect(k).toMatch(/^[A-Za-z0-9_-]{24}$/);
      expect(k).toMatch(/[A-Z]/); expect(k).toMatch(/[a-z]/); expect(k).toMatch(/\d/); expect(k).toMatch(/[-_]/);
    }
  });
});

describe('I8e Etappe 3 — Skripttexte', () => {
  it('Domänen-Operationen mit dem Domänen-Administrator, Geheimnisse nur über die Standardeingabe', () => {
    const s = spnSetzenSkript({ konto: 'svc-sqllnx', spns: ['MSSQLSvc/sqllnx01.ad.3033.at:1433'] });
    expect(s).toContain('[Console]::In.ReadLine()');
    expect(s).toMatch(/Set-ADUser -Identity \$u -ServicePrincipalNames @\{ Add = \$s \}[^\n]*-Credential \$c/);
    expect(s).toContain(":3268"); // Wald-weite Prüfung über den globalen Katalog
    expect(s).toContain('nichts geändert');
    const k = computerkontoSkript({ name: 'SQLLNX01', ou: 'Server' });
    expect(k).toContain('$e.einmal');
    expect(k).toMatch(/New-ADComputer [^\n]*-Credential \$c/);
    expect(k).toContain('lastLogonTimestamp');
    const z = dnsPtrSkript({ zone: '30.203.10.in-addr.arpa', name: '11', ip: '10.203.30.11', fqdn: 'sqllnx01.ad.3033.at' });
    expect(z).toContain('Add-DnsServerPrimaryZone -Name $p.zone -ReplicationScope Forest');
    expect(z).toContain('-CimSession $cs');
    expect(z).toContain('Resolve-DnsName -Name $p.ip -Type PTR');
    const g = gruppeSkript({ gruppe: 'SQL-Linux-Admins', ou: 'Dienstkonten', mitglieder: ['svc-sqllnx-test'] });
    expect(g).toMatch(/New-ADGroup [^\n]*-GroupScope Global -GroupCategory Security[^\n]*-Credential \$c/);
    const h = dienstkontoSkript({ konto: 'svc-sqllnx', ou: 'Dienstkonten', haerten: true });
    expect(h).toContain("'msDS-SupportedEncryptionTypes' = 24");
    expect(h).toContain('-AccountNotDelegated $true');
    // Ruling R3: keine userWorkstations-Sperre mehr, sondern Gruppe + GPO mit beiden Verweigerungsrechten
    expect(h).not.toContain('LogonWorkstations');
    expect(h).not.toContain('userWorkstations');
    expect(h).toContain('Dienstkonten-KeineAnmeldung');
    expect(h).toContain('AD3033 Dienstkonten keine Anmeldung');
    expect(h).toContain("('SeDenyInteractiveLogonRight = *' + $sid)");
    expect(h).toContain("('SeDenyRemoteInteractiveLogonRight = *' + $sid)");
    expect(h).toContain('Machine\\Microsoft\\Windows NT\\SecEdit');
    expect(h).toContain("'GptTmpl.inf'");
    expect(h).toContain('{827D319E-6EAC-11D2-A4EA-00C04F79F83A}');
    expect(h).toContain('versionNumber');
    expect(h).toContain("'GPT.INI'");
    expect(h).toContain('New-GPLink -Guid $g.Id -Target $dn -LinkEnabled Yes');
    expect(h).toContain('Invoke-Command -ComputerName $env:COMPUTERNAME -Credential $c');
    expect(h).toMatch(/Add-ADGroupMember -Identity \$sg -Members \$p\.konto[^\n]*-Credential \$c/);
    expect(h).toContain('nicht von Alfred angelegt');
    expect(dienstkontoSkript({ konto: 'svc-sqllnx-backup', ou: 'Dienstkonten' })).toContain('if ($p.haerten) {');
    // Fix-Runde 2 (R6): fremde gleichnamige GPO nie übernehmen; Inhalt und Rechte prüfen, bevor geschrieben oder verknüpft wird
    const eigen = h.indexOf("[string]$g.Description -ne $kommentar) { throw ('GPO ' + $name + ' ist nicht von Alfred angelegt - nichts geändert') }");
    expect(eigen).toBeGreaterThan(0);
    expect(eigen).toBeLessThan(h.indexOf('New-GPO -Name $name'));
    expect(h).toContain("'Alfred I8e: Dienstkonten ohne interaktive und RDP-Anmeldung'");
    // Prüfungen (Fix-Runde 2 + 3) stehen alle in der Funktion Pruefe, die vor jedem Anlegen/Schreiben/Verknüpfen definiert ist
    const pruefungen = ["[string]$po.gPCUserExtensionNames) { [void]$abw.Add('Benutzer-Erweiterungen", "-ne $cse) { [void]$abw.Add('Computer-Erweiterungen", 'fremde Dateien', "-ine 'GPT.INI'", "'Machine\\Microsoft\\Windows NT\\SecEdit\\GptTmpl.inf'", 'GptTmpl.inf-Abschnitt', 'GptTmpl.inf-Eintrag',
      "@('SeDenyInteractiveLogonRight', 'SeDenyRemoteInteractiveLogonRight')", 'Get-GPPermission -Guid $g.Id -All', "@('GpoEdit', 'GpoEditDeleteModifySecurity', 'GpoCustom')",
      // Fix-Runde 3 (R7): Werte der Rechte, Besitzer, AD-DACL, SYSVOL-Rechte; ERSTELLER-BESITZER bei Get-GPPermission erlaubt
      "$wert -ne ('*' + $sid)", "'Wert von ' + $schl", "$mitCO -notcontains [string]$x.Trustee.Sid.Value",
      "Get-Acl -Path ('AD:' + $pad)", 'GetOwner([System.Security.Principal.SecurityIdentifier])', "'Besitzer des GPO-Objekts '", '$rr -band 0xC0003', '($rr -band 0x20) -and $a.ObjectType -eq [guid]::Empty', "'AD-Recht '",
      '[int64]0x500D0156', 'Get-Acl -LiteralPath $ele.FullName', "'SYSVOL-Schreibrecht '"];
    // Berechtigte (DA -512, EA -519 der Stammdomäne, SYSTEM, Administratoren, ERSTELLER-BESITZER) vor der Prüffunktion festgelegt
    for (const t of ["($domSid + '-512')", "($rootSid + '-519')", "'S-1-5-18'", "'S-1-5-32-544'", "$mitCO = $admins + @('S-1-3-0')"]) { expect(h.indexOf(t), t).toBeGreaterThan(0); expect(h.indexOf(t), t).toBeLessThan(h.indexOf('function Pruefe($g, $abw)')); }
    const pruefeEnde = h.indexOf('    $g = Get-GPO -Name $name');
    expect(h.indexOf('function Pruefe($g, $abw)')).toBeGreaterThan(0);
    for (const t of pruefungen) { const i = h.indexOf(t); expect(i, t).toBeGreaterThan(h.indexOf('function Pruefe($g, $abw)')); expect(i, t).toBeLessThan(pruefeEnde); }
    // Reihenfolge: Gruppe fremd? → GPO fremd? → vorhandene GPO prüfen (Abbruch „nichts geändert“) → Gruppe/GPO anlegen → neue GPO prüfen → schreiben/verknüpfen
    const gruppeFremd = h.indexOf("ist nicht von Alfred angelegt - nichts geändert') }\n    $sid =");
    const ersteAbbruch = h.indexOf("weicht ab (' + ($abw -join '; ') + ') - nichts geändert')");
    const gruppeNeu = h.indexOf('New-ADGroup -Name $gname');
    const gpoNeu = h.indexOf('New-GPO -Name $name');
    const zweiteAbbruch = h.indexOf('weicht nach dem Anlegen ab');
    expect(gruppeFremd).toBeGreaterThan(0);
    expect(gruppeFremd).toBeLessThan(eigen);
    expect(eigen).toBeLessThan(ersteAbbruch);
    expect(ersteAbbruch).toBeLessThan(gruppeNeu);
    expect(gruppeNeu).toBeLessThan(gpoNeu);
    expect(gpoNeu).toBeLessThan(zweiteAbbruch);
    expect(h.slice(zweiteAbbruch, zweiteAbbruch + 200)).toContain('in diesem Lauf angelegt');
    for (const schreiben of ['New-GPLink', 'Set-GPLink', 'WriteAllText($datei', 'WriteAllText($ini', 'Set-ADObject -Identity $ad', 'New-Item -ItemType Directory -Path $sec']) expect(zweiteAbbruch, schreiben).toBeLessThan(h.indexOf(schreiben));
    // Fix-Runde 3: gruppe im Ergebnis ist ein echter Wert (vorher ${…} im gewöhnlichen String)
    expect(h).toContain("$sperre = [ordered]@{ gruppe = 'Dienstkonten-KeineAnmeldung';");
    expect(h).not.toContain('${psText');
  });
  it('Fix-Runde 1: Computerkonto — fremdes nie übernehmen, eigenes in Gebrauch nie zurücksetzen', () => {
    const k = computerkontoSkript({ name: 'SQLLNX01', ou: 'Server' });
    expect(k).toContain('besteht schon (nicht von Alfred) - nichts geändert');
    expect(k).not.toContain('uebernommen');
    expect(k).not.toContain('-DNSHostName'); // dNSHostName setzt nur adcli → Beitritts-Merkmal
    for (const t of ["$_ -like 'host/*'", "'RestrictedKrbHost/*'", '$k.dNSHostName -or $k.operatingSystem', '$k.lastLogonTimestamp', "Kennwort seit Alfreds Vergabe geändert", 'ist in Gebrauch']) expect(k).toContain(t);
    // Vermerk des eigenen pwdLastSet in info; ein Zurücksetzen nur mit neuem Tresor-Wert
    expect(k).toContain("'Alfred-Einmal-Kennwort pwdLastSet='");
    expect(k).toContain('Set-ADComputer -Identity $n -Replace @{ info = ');
    expect(k).toContain('if ($p.neu) { Set-ADAccountPassword');
    // die Gebrauchs-Prüfung steht vor jedem Zurücksetzen
    expect(k.indexOf('ist in Gebrauch')).toBeLessThan(k.indexOf('Set-ADAccountPassword'));
  });
  it('Anmeldeprobe: sqlcmd nur aus festen Pfaden, -N je Programm, ohne -C, Aufgabe und Datei werden entfernt', () => {
    expect(SQLCMD_PFADE).toEqual(['C:\\Program Files\\SqlCmd\\sqlcmd.exe', 'C:\\Program Files\\Microsoft SQL Server\\Client SDK\\ODBC\\180\\Tools\\Binn\\SQLCMD.EXE', 'C:\\Program Files\\Microsoft SQL Server\\Client SDK\\ODBC\\170\\Tools\\Binn\\SQLCMD.EXE']);
    const rest = ['-b', '-l', '15', '-h', '-1', '-W', '-s', '|', '-Q', SQL_PROBE_TSQL];
    expect(sqlcmdArgumente(SQLCMD_PFADE[0]!, 'sqllnx01.ad.3033.at')).toEqual(['-S', 'sqllnx01.ad.3033.at', '-E', '-N', 'm', ...rest]);
    expect(sqlcmdArgumente(SQLCMD_PFADE[1]!, 'sqllnx01.ad.3033.at')).toEqual(['-S', 'sqllnx01.ad.3033.at', '-E', '-N', ...rest]);
    expect(sqlcmdArgumente(SQLCMD_PFADE[2]!, 'sqllnx01.ad.3033.at')).toEqual(['-S', 'sqllnx01.ad.3033.at', '-E', '-N', ...rest]);
    for (const p of SQLCMD_PFADE) expect(sqlcmdArgumente(p, 'x.ad.3033.at')).not.toContain('-C');
    const s = sqlAnmeldungSkript({ server: 'sqllnx01.ad.3033.at', konto: 'svc-sqllnx-test' });
    expect(s).toContain('$e.kennwort');
    expect(s).toContain('& $x[0].pfad @sa');
    expect(s).toContain('"-N","m"');
    expect(s).not.toContain('"-C"');
    expect(s).toContain('sys.dm_exec_connections WHERE session_id = @@SPID');
    expect(s).toContain('Unregister-ScheduledTask');
    expect(s).toContain('Remove-Item -LiteralPath $dir -Recurse -Force');
    expect(s).toContain('sqlcmd nicht gefunden');
  });
  it('Auswertung: SQL_KERBEROS_OK nur mit KERBEROS und TRUE', () => {
    expect(sqlAnmeldungAuswerten({ exit: 0, ausgabe: 'KERBEROS|TRUE|SQLLNX01' }, 'sqllnx01.ad.3033.at')).toMatchObject({ ok: true, auth: 'KERBEROS', verschluesselt: 'TRUE', servername: 'SQLLNX01' });
    expect(sqlAnmeldungAuswerten({ exit: 0, ausgabe: 'KERBEROS|TRUE|SQLLNX01' }, 's').text).toContain('SQL_KERBEROS_OK');
    const n = sqlAnmeldungAuswerten({ exit: 0, ausgabe: 'NTLM|TRUE|SQLLNX01' }, 's');
    expect(n.ok).toBe(false); expect(n.text).toContain('NICHT KERBEROS'); expect(n.text).not.toContain('SQL_KERBEROS_OK');
    expect(sqlAnmeldungAuswerten({ exit: 0, ausgabe: 'KERBEROS|FALSE|SQLLNX01' }, 's').text).toContain('NICHT VERSCHLÜSSELT');
    const f = sqlAnmeldungAuswerten({ exit: 1, ausgabe: 'Sqlcmd: Error: SSL Provider: The certificate chain was issued by an authority that is not trusted.' }, 's');
    expect(f.ok).toBe(false); expect(f.text).toContain('not trusted');
  });
});

describe('I8e Etappe 3 — Skill windows_ad', () => {
  it('computerkonto_vorbereiten: Einmal-Kennwort im Tresor, nur über die Standardeingabe, nie in Ergebnis oder Anzeige', async () => {
    const w = welt([{ zustand: 'angelegt', konto: 'AD3033\\SQLLNX01$', dn: 'CN=SQLLNX01,OU=Server,DC=ad,DC=3033,DC=at', aktiv: true, inOu: true, kennwortGesetzt: true, ohneAnmeldung: true }], ['win-dc01-admin']);
    expect((await w.skill.execute({ action: 'computerkonto_vorbereiten', zugang: 'dc01', name: 'sqllnx01', ou: 'Server' }, {} as never)).error).toContain('nur als Schritt');
    const r = await w.skill.execute({ action: 'computerkonto_vorbereiten', zugang: 'dc01', name: 'sqllnx01', ou: 'Server' }, imChange);
    expect(r.error).toBeUndefined();
    expect(w.gesetzt.map(g => g.name)).toEqual(['ad-join-sqllnx01']);
    const einmal = w.tresor.get('ad-join-sqllnx01')!;
    expect(einmal).toHaveLength(24);
    expect(JSON.parse(w.aufrufe[0]!.eingabe!)).toEqual({ kennwort: 'wert-win-dc01-admin', einmal });
    expect(roh(w.aufrufe[0]!.befehl)).not.toContain(einmal);
    expect(JSON.stringify(r.data)).not.toContain(einmal);
    expect(r.display).not.toContain(einmal);
    expect(r.display).toContain('ad-join-sqllnx01');
    expect(r.display).toContain('COMPUTERKONTO_BEREIT');
    expect(r.display).toContain('computerkonto_entfernen');
    expect(roh(w.aufrufe[0]!.befehl)).toContain('"neu":true');
    // Wiederholung mit vorhandenem Tresor-Wert: kein neues Kennwort, kein Zurücksetzen angefordert
    const nochmal = welt([{ zustand: 'schon', konto: 'AD3033\\SQLLNX01$', dn: 'x', aktiv: true, inOu: true, kennwortGesetzt: true, ohneAnmeldung: true }], ['win-dc01-admin', 'ad-join-sqllnx01']);
    const n = await nochmal.skill.execute({ action: 'computerkonto_vorbereiten', zugang: 'dc01', name: 'sqllnx01', ou: 'Server' }, imChange);
    expect(n.display).toContain('nichts zu tun');
    expect(nochmal.gesetzt).toEqual([]);
    expect(roh(nochmal.aufrufe[0]!.befehl)).not.toContain('"neu"');
  });
  it('computerkonto_vorbereiten: Nachprüfung scheitert → Fehler ohne Kennwort', async () => {
    const w = welt([{ zustand: 'angelegt', konto: 'AD3033\\SQLLNX01$', dn: 'x', aktiv: true, inOu: true, kennwortGesetzt: false, ohneAnmeldung: true }], ['win-dc01-admin']);
    const r = await w.skill.execute({ action: 'computerkonto_vorbereiten', zugang: 'dc01', name: 'sqllnx01', ou: 'Server' }, imChange);
    expect(r.success).toBe(false);
    expect(r.error).toContain('Nachprüfung');
    expect(r.error).not.toContain(w.tresor.get('ad-join-sqllnx01')!);
  });
  it('dienstkonto_anlegen mit haerten: Flags zurückgelesen, fehlende Härtung → Fehler', async () => {
    const sperre = { gruppe: 'Dienstkonten-KeineAnmeldung', gpo: 'AD3033 Dienstkonten keine Anmeldung', gpoId: '{X}', verknuepft: true, lokal: true, rdp: true, erweiterung: true, mitglied: true };
    const gut = { zustand: 'angelegt', konto: 'AD3033\\svc-sqllnx', dn: 'CN=svc-sqllnx,OU=Dienstkonten,DC=ad,DC=3033,DC=at', aktiv: true, laeuftNieAb: true, kannNichtAendern: true, inOu: true, anmeldung: true, verschluesselung: 24, keineDelegierung: true, anmeldesperre: sperre };
    for (const feld of ['mitglied', 'verknuepft', 'lokal', 'rdp', 'erweiterung'] as const) expect(dienstkontoGehaertet({ ...gut, anmeldesperre: { ...sperre, [feld]: false } }), feld).toBeDefined();
    expect(dienstkontoGehaertet({ ...gut, anmeldesperre: null })).toContain('Dienstkonten-KeineAnmeldung');
    expect(dienstkontoGehaertet(gut)).toBeUndefined();
    const w = welt([gut], ['win-dc01-admin']);
    const r = await w.skill.execute({ action: 'dienstkonto_anlegen', zugang: 'dc01', konto: 'svc-sqllnx', haerten: true }, imChange);
    expect(r.error).toBeUndefined();
    expect(r.display).toContain('DIENSTKONTO_GEHAERTET');
    expect(r.display).toContain('ad-svc-sqllnx');
    expect(roh(w.aufrufe[0]!.befehl)).toContain('"haerten":true');
    const k = w.tresor.get('ad-svc-sqllnx')!;
    expect(roh(w.aufrufe[0]!.befehl)).not.toContain(k);
    const schlecht = welt([{ ...gut, keineDelegierung: false }], ['win-dc01-admin']);
    const f = await schlecht.skill.execute({ action: 'dienstkonto_anlegen', zugang: 'dc01', konto: 'svc-sqllnx', haerten: true }, imChange);
    expect(f.success).toBe(false);
    expect(f.error).toContain('Delegierung');
  });
  it('spn_setzen: jeder SPN genau einmal im Wald und am Konto; spn_lesen lesend', async () => {
    const spns = ['MSSQLSvc/sqllnx01.ad.3033.at:1433', 'MSSQLSvc/sqllnx01.ad.3033.at'];
    const w = welt([{ konto: 'svc-sqllnx', dn: 'CN=svc-sqllnx,OU=Dienstkonten,DC=ad,DC=3033,DC=at', neu: spns, spns: spns.map(spn => ({ spn, traeger: 1, amKonto: true })) }], ['win-dc01-admin']);
    const r = await w.skill.execute({ action: 'spn_setzen', zugang: 'dc01', konto: 'svc-sqllnx', spns }, imChange);
    expect(r.error).toBeUndefined();
    expect(r.display).toContain('SPN_EINDEUTIG');
    expect(r.display).toContain('spn_entfernen');
    const d = welt([{ konto: 'svc-sqllnx', dn: 'x', neu: [], spns: [{ spn: spns[0], traeger: 2, amKonto: false }] }], ['win-dc01-admin']);
    expect((await d.skill.execute({ action: 'spn_setzen', zugang: 'dc01', konto: 'svc-sqllnx', spns: [spns[0]] }, imChange)).success).toBe(false);
    expect((await w.skill.execute({ action: 'spn_setzen', zugang: 'dc01', konto: 'svc-sqllnx', spns: ['HTTP/x'] }, imChange)).error).toContain('spns');
    const l = welt([{ spns: [{ spn: spns[0], traeger: ['CN=svc-sqllnx,OU=Dienstkonten,DC=ad,DC=3033,DC=at'] }] }], ['win-dc01-admin']);
    const lr = await l.skill.execute({ action: 'spn_lesen', zugang: 'dc01', spns: [spns[0]] }, {} as never);
    expect(lr.error).toBeUndefined();
    expect(lr.display).toContain('SPN_EINDEUTIG');
    const l2 = welt([{ spns: [{ spn: spns[0], traeger: [] }] }], ['win-dc01-admin']);
    expect((await l2.skill.execute({ action: 'spn_lesen', zugang: 'dc01', spns: [spns[0]] }, {} as never)).display).not.toContain('SPN_EINDEUTIG');
    expect(aktionsArt('windows_ad', 'spn_lesen')).toBe('lesen');
    expect(aktionsArt('windows_ad', 'sql_anmeldung_pruefen')).toBe('lesen');
    expect(aktionsArt('windows_ad', 'spn_setzen')).toBe('aendern');
  });
  it('dns_ptr: beide DCs müssen antworten', async () => {
    const ok = welt([{ zone: 'angelegt', ptr: 'angelegt', dcs: [{ name: 'dc01.ad.3033.at', ip: '10.203.29.2', antwort: 'sqllnx01.ad.3033.at' }, { name: 'dc02.ad.3033.at', ip: '10.203.29.3', antwort: 'sqllnx01.ad.3033.at' }], offen: [] }], ['win-dc01-admin']);
    const r = await ok.skill.execute({ action: 'dns_ptr', zugang: 'dc01', zone: '30.203.10.in-addr.arpa', ip: '10.203.30.11', fqdn: 'sqllnx01.ad.3033.at' }, imChange);
    expect(r.error).toBeUndefined();
    expect(r.display).toContain('PTR_OK');
    const halb = welt([{ zone: 'schon', ptr: 'angelegt', dcs: [{ name: 'dc01.ad.3033.at', ip: '10.203.29.2', antwort: 'sqllnx01.ad.3033.at' }, { name: 'dc02.ad.3033.at', ip: '10.203.29.3', antwort: '' }], offen: ['dc02.ad.3033.at'] }], ['win-dc01-admin']);
    const f = await halb.skill.execute({ action: 'dns_ptr', zugang: 'dc01', zone: '30.203.10.in-addr.arpa', ip: '10.203.30.11', fqdn: 'sqllnx01.ad.3033.at' }, imChange);
    expect(f.success).toBe(false);
    expect(f.error).toContain('dc02.ad.3033.at');
  });
  it('gruppe_anlegen: alle Mitglieder zurückgelesen', async () => {
    const w = welt([{ zustand: 'angelegt', gruppe: 'AD3033\\SQL-Linux-Admins', dn: 'CN=SQL-Linux-Admins,OU=Dienstkonten,DC=ad,DC=3033,DC=at', inOu: true, mitglieder: ['svc-sqllnx-test'], neu: ['svc-sqllnx-test'], fehlt: [] }], ['win-dc01-admin']);
    const r = await w.skill.execute({ action: 'gruppe_anlegen', zugang: 'dc01', gruppe: 'SQL-Linux-Admins', ou: 'Dienstkonten', mitglieder: ['svc-sqllnx-test'] }, imChange);
    expect(r.error).toBeUndefined();
    expect(r.display).toContain('GRUPPE_OK');
    const f = welt([{ zustand: 'schon', gruppe: 'x', dn: 'x', inOu: true, mitglieder: [], neu: [], fehlt: ['svc-sqllnx-test'] }], ['win-dc01-admin']);
    expect((await f.skill.execute({ action: 'gruppe_anlegen', zugang: 'dc01', gruppe: 'SQL-Linux-Admins', ou: 'Dienstkonten', mitglieder: ['svc-sqllnx-test'] }, imChange)).success).toBe(false);
  });
  it('sql_anmeldung_pruefen: lesend, Kennwort des Test-Kontos nur über die Standardeingabe, NTLM → Fehler NICHT KERBEROS', async () => {
    const w = welt([{ sqlcmd: SQLCMD_PFADE[0], exit: 0, ausgabe: 'NTLM|TRUE|SQLLNX01' }], ['ad-svc-sqllnx-test']);
    const r = await w.skill.execute({ action: 'sql_anmeldung_pruefen', zugang: 'sql01', server: 'sqllnx01.ad.3033.at', konto_tresor: 'ad-svc-sqllnx-test' }, {} as never);
    expect(r.success).toBe(false);
    expect(r.error).toContain('NICHT KERBEROS');
    expect(JSON.parse(w.aufrufe[0]!.eingabe!)).toEqual({ kennwort: 'wert-ad-svc-sqllnx-test' });
    expect(roh(w.aufrufe[0]!.befehl)).not.toContain('wert-ad-svc-sqllnx-test');
    expect(roh(w.aufrufe[0]!.befehl)).toContain('"konto":"svc-sqllnx-test"');
    const ok = welt([{ sqlcmd: SQLCMD_PFADE[0], exit: 0, ausgabe: 'KERBEROS|TRUE|SQLLNX01' }], ['ad-svc-sqllnx-test']);
    const o = await ok.skill.execute({ action: 'sql_anmeldung_pruefen', zugang: 'sql01', server: 'sqllnx01.ad.3033.at', konto_tresor: 'ad-svc-sqllnx-test' }, {} as never);
    expect(o.success).toBe(true);
    expect(o.display).toContain('SQL_KERBEROS_OK');
    expect((await ok.skill.execute({ action: 'sql_anmeldung_pruefen', zugang: 'sql01', server: 'x; whoami', konto_tresor: 'ad-svc-sqllnx-test' }, {} as never)).error).toContain('server');
  });
  it('Fix-Runde 1 (R5): sql_anmeldung_pruefen nur Test-Konten, nur sql01/sql02, nur Instanzen in ad.3033.at', async () => {
    const fall = async (input: Record<string, unknown>) => {
      const w = welt([{ sqlcmd: SQLCMD_PFADE[0], exit: 0, ausgabe: 'KERBEROS|TRUE|SQLLNX01' }], ['ad-svc-sqllnx-test', 'win-dc01-admin', 'ad-svc-sqllnx', 'ad-administrator-test']);
      const r = await w.skill.execute({ action: 'sql_anmeldung_pruefen', zugang: 'sql01', server: 'sqllnx01.ad.3033.at', konto_tresor: 'ad-svc-sqllnx-test', ...input }, {} as never);
      return { r, aufrufe: w.aufrufe.length };
    };
    for (const [input, wort] of [
      [{ konto_tresor: 'win-dc01-admin' }, 'konto_tresor'],
      [{ konto_tresor: 'ad-svc-sqllnx' }, 'konto_tresor'],
      [{ konto_tresor: 'ad-administrator-test' }, 'konto_tresor'],
      [{ konto: 'Administrator' }, 'konto'],
      [{ konto: 'svc-sqllnx' }, 'konto'],
      [{ server: 'sqllnx01.example.com' }, 'server'],
      [{ server: 'sqllnx01.ad.3033.at,1433' }, 'server'],
      [{ server: 'evil.ad.3033.at.example.com' }, 'server'],
      [{ zugang: 'dc01' }, 'zugang'],
      [{ zugang: 'fs01' }, 'zugang'],
    ] as Array<[Record<string, unknown>, string]>) {
      const { r, aufrufe } = await fall(input);
      expect(r.success, JSON.stringify(input)).toBe(false);
      expect(r.error, JSON.stringify(input)).toContain(wort);
      expect(aufrufe, JSON.stringify(input)).toBe(0); // nichts ausgeführt, kein Kennwort weitergegeben
    }
    expect((await fall({ zugang: 'sql02', konto: 'svc-sqllnx-test' })).r.success).toBe(true);
  });
  it('Fix-Runde 1 (R4): dns_ptr braucht in der Planprüfung zeitlimitS ≥ 960', () => {
    const sk = new WindowsAdSkill({ skript: async () => ({ code: 0, stdout: '', stderr: '' }) });
    expect(sk.mindestZeitlimitS('dns_ptr')).toBe(960);
    expect(sk.mindestZeitlimitS('status')).toBeUndefined();
    const plan = (zeitlimitS: number) => ({ titel: 'PTR sqllnx01', begruendung: 'I8e Etappe 3', typ: 'normal', risiko: 'niedrig', ausfallMinuten: 0, betroffen: ['dc01'],
      schritte: [{ titel: 'PTR', art: 'aktion', skill: 'windows_ad', aktion: 'dns_ptr', parameter: { zugang: 'dc01', zone: '30.203.10.in-addr.arpa', ip: '10.203.30.11', fqdn: 'sqllnx01.ad.3033.at' }, zeitlimitS,
        rueckweg: { skill: 'windows_ad', aktion: 'dns_ptr_loeschen', parameter: { zugang: 'dc01', zone: '30.203.10.in-addr.arpa', ip: '10.203.30.11', fqdn: 'sqllnx01.ad.3033.at' } } }] });
    const ctx = { skill: (n: string) => (n === 'windows_ad' ? sk as never : undefined), asset: (n: string) => ({ id: `a-${n}`, name: n }), changes: [], zugangSystem: new Map([['dc01', 'windows']]) } as never;
    expect(pruefeChangePlan(plan(600), ctx).fehler.join(' | ')).toContain('mindestens 960 s');
    expect(pruefeChangePlan(plan(960), ctx).fehler.join(' | ')).not.toContain('mindestens 960 s');
  });
  it('Rückwege: spn_entfernen, computerkonto_entfernen, dns_ptr_loeschen, gruppe_entfernen nur im Change', async () => {
    const faelle: Array<[Record<string, unknown>, object]> = [
      [{ action: 'spn_entfernen', konto: 'svc-sqllnx', spns: ['MSSQLSvc/sqllnx01.ad.3033.at'] }, { konto: 'svc-sqllnx', entfernt: ['MSSQLSvc/sqllnx01.ad.3033.at'] }],
      [{ action: 'computerkonto_entfernen', name: 'sqllnx01' }, { konto: 'SQLLNX01$', zustand: 'entfernt' }],
      [{ action: 'dns_ptr_loeschen', zone: '30.203.10.in-addr.arpa', ip: '10.203.30.11', fqdn: 'sqllnx01.ad.3033.at' }, { zustand: 'entfernt' }],
      [{ action: 'gruppe_entfernen', gruppe: 'SQL-Linux-Admins' }, { gruppe: 'SQL-Linux-Admins', zustand: 'entfernt' }],
    ];
    for (const [input, antwort] of faelle) {
      const w = welt([antwort], ['win-dc01-admin']);
      expect((await w.skill.execute({ ...input, zugang: 'dc01' }, {} as never)).success, String(input.action)).toBe(false);
      const r = await w.skill.execute({ ...input, zugang: 'dc01' }, imChange);
      expect(r.error, String(input.action)).toBeUndefined();
      expect(JSON.parse(w.aufrufe[0]!.eingabe!)).toEqual({ kennwort: 'wert-win-dc01-admin' });
    }
  });
});

// PowerShell-Parser (Windows PowerShell 5.1), wenn vorhanden: jedes neue Skript ist syntaktisch gültig (gemeinsame Testhilfe, Skripte als Datei)
const POWERSHELL = powershellVorhanden();
describe.skipIf(!POWERSHELL)('I8e Etappe 3 — PowerShell-Parser', () => {
  it('alle neuen Bausteine ohne Parserfehler', () => {
    const skripte = {
      dienstkontoGehaertet: dienstkontoSkript({ konto: 'svc-sqllnx', ou: 'Dienstkonten', haerten: true }),
      spnSetzen: spnSetzenSkript({ konto: 'svc-sqllnx', spns: ['MSSQLSvc/sqllnx01.ad.3033.at:1433', 'MSSQLSvc/sqllnx01.ad.3033.at'] }),
      spnEntfernen: spnEntfernenSkript({ konto: 'svc-sqllnx', spns: ['MSSQLSvc/sqllnx01.ad.3033.at'] }),
      spnLesen: spnLesenSkript({ spns: ['MSSQLSvc/sqllnx01.ad.3033.at'] }),
      computerkonto: computerkontoSkript({ name: 'SQLLNX01', ou: 'Server' }),
      computerkontoEntfernen: computerkontoEntfernenSkript({ name: 'SQLLNX01' }),
      ptr: dnsPtrSkript({ zone: '30.203.10.in-addr.arpa', name: '11', ip: '10.203.30.11', fqdn: 'sqllnx01.ad.3033.at' }),
      ptrLoeschen: dnsPtrLoeschenSkript({ zone: '30.203.10.in-addr.arpa', name: '11', ip: '10.203.30.11', fqdn: 'sqllnx01.ad.3033.at' }),
      gruppe: gruppeSkript({ gruppe: 'SQL-Linux-Admins', ou: 'Dienstkonten', mitglieder: ['svc-sqllnx-test'] }),
      gruppeEntfernen: gruppeEntfernenSkript({ gruppe: 'SQL-Linux-Admins' }),
      sqlAnmeldung: sqlAnmeldungSkript({ server: 'sqllnx01.ad.3033.at', konto: 'svc-sqllnx-test' }),
    };
    const p = parseSkripte(skripte);
    expect(p.gegenprobeErkannt, `Gegenprobe (fehlerhaftes Skript) nicht erkannt: ${p.roh}`).toBe(true);
    for (const [name, ergebnis] of Object.entries(p.ergebnisse)) expect(ergebnis, name).toBe('OK');
  }, 60_000);
});
