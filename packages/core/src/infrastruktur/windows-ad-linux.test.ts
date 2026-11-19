import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { dienstkontoSkript, dienstkontoGehaertet } from './windows-ad.js';
import {
  pruefeSpns, spnSetzenSkript, spnEntfernenSkript, spnLesenSkript, computerkontoSkript, computerkontoEntfernenSkript, pruefeComputerkonto,
  pruefePtr, dnsPtrSkript, dnsPtrLoeschenSkript, gruppeSkript, gruppeEntfernenSkript, pruefeGruppe, sqlAnmeldungSkript, sqlAnmeldungAuswerten,
  SQLCMD_PFADE, joinTresorName,
} from './windows-ad-linux.js';
import { WindowsAdSkill, einmalKennwort } from './windows-ad-skill.js';
import { aktionsArt } from './change-schritte.js';

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
    expect(h).toContain("-LogonWorkstations 'KEINEANMELDUNG'");
  });
  it('Anmeldeprobe: sqlcmd nur aus festen Pfaden, -E -N ohne -C, Aufgabe und Datei werden entfernt', () => {
    expect(SQLCMD_PFADE).toEqual(['C:\\Program Files\\SqlCmd\\sqlcmd.exe', 'C:\\Program Files\\Microsoft SQL Server\\Client SDK\\ODBC\\180\\Tools\\Binn\\SQLCMD.EXE', 'C:\\Program Files\\Microsoft SQL Server\\Client SDK\\ODBC\\170\\Tools\\Binn\\SQLCMD.EXE']);
    const s = sqlAnmeldungSkript({ server: 'sqllnx01.ad.3033.at', konto: 'svc-sqllnx-test' });
    expect(s).toContain('$e.kennwort');
    expect(s).toContain('-E -N');
    expect(s).not.toMatch(/ -C\b/);
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
  });
  it('computerkonto_vorbereiten: Nachprüfung scheitert → Fehler ohne Kennwort', async () => {
    const w = welt([{ zustand: 'angelegt', konto: 'AD3033\\SQLLNX01$', dn: 'x', aktiv: true, inOu: true, kennwortGesetzt: false, ohneAnmeldung: true }], ['win-dc01-admin']);
    const r = await w.skill.execute({ action: 'computerkonto_vorbereiten', zugang: 'dc01', name: 'sqllnx01', ou: 'Server' }, imChange);
    expect(r.success).toBe(false);
    expect(r.error).toContain('Nachprüfung');
    expect(r.error).not.toContain(w.tresor.get('ad-join-sqllnx01')!);
  });
  it('dienstkonto_anlegen mit haerten: Flags zurückgelesen, fehlende Härtung → Fehler', async () => {
    const gut = { zustand: 'angelegt', konto: 'AD3033\\svc-sqllnx', dn: 'CN=svc-sqllnx,OU=Dienstkonten,DC=ad,DC=3033,DC=at', aktiv: true, laeuftNieAb: true, kannNichtAendern: true, inOu: true, anmeldung: true, verschluesselung: 24, keineDelegierung: true, arbeitsstationen: 'KEINEANMELDUNG' };
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

// PowerShell-Parser (Windows PowerShell 5.1), wenn vorhanden: jedes neue Skript ist syntaktisch gültig (Muster i8e-fs01.test.ts)
const POWERSHELL = (() => {
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' });
  return r.status === 0 && /^\d+/.test(r.stdout.trim());
})();
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
    for (const [name, s] of Object.entries(skripte)) {
      const b64 = Buffer.from(s, 'utf8').toString('base64');
      const prog = `$t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')); $f = $null; [void][System.Management.Automation.Language.Parser]::ParseInput($t, [ref]$null, [ref]$f); if ($f.Count) { $f | ForEach-Object { $_.Message }; exit 1 }; 'OK'`;
      const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(prog, 'utf16le').toString('base64')], { encoding: 'utf8' });
      expect(r.stdout.trim(), `${name}: ${r.stdout} ${r.stderr}`).toBe('OK');
    }
  }, 60_000);
});
