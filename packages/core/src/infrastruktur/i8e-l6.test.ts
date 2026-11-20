import { describe, it, expect } from 'vitest';
import { powershellVorhanden, parseSkripte } from './powershell-parser.testhilfe.js';
import { SQL_PROBE_ZUGAENGE, SQLCMD_PFADE, sqlAnmeldungSkript, ADMIN_ANMELDUNG_GRUPPEN, pruefeAdminAnmeldung, adminAnmeldungSkript, adminAnmeldungEntfernenSkript, RDP_REGELGRUPPE, REMOTEDESKTOPBENUTZER_SID } from './windows-ad-linux.js';
import { WindowsAdSkill } from './windows-ad-skill.js';
import { SqlServerSkill } from './sql-server-skill.js';
import { MEDIEN_URL, medienSkript } from './sql-server.js';
import { SSMS_QUELLEN, SSMS_INSTALLATIONSPFAD, SSMS_EXE, ODBC_TREIBER, SQLCMD_ODBC_PFADE, ssmsInstallierenSkript, ssmsEntfernenSkript, ssmsText } from './sql-ssms.js';
import { aktionsArt, pruefeChangePlan, type PruefKontext } from './change-schritte.js';
import { selectCategoriesOhneRueckfall } from '../skill-filter.js';
import { schwaerze } from '../fernzugriff/kaefig.js';

// I8e Etappe 3, Paket L6 — Admin-Clients sqladmw11 (Windows 11) und sqladm25 (Server 2025) mit SSMS, Kerberos und erzwungenem TLS
const roh = (befehl: string) => Buffer.from(befehl.split(' ').pop()!, 'base64').toString('utf16le');
const imChange = { ausChange: true } as never;

function adWelt(antworten: object[], tresorDa: string[] = []) {
  const aufrufe: Array<{ zugang: string; befehl: string; eingabe?: string; zweck: string }> = [];
  const tresor = new Map<string, string>(tresorDa.map(n => [n, `wert-${n}`]));
  const skill = new WindowsAdSkill({
    skript: async (zugang, befehl, eingabe, _t, zweck) => {
      aufrufe.push({ zugang, befehl, ...(eingabe !== undefined ? { eingabe } : {}), zweck });
      const a = antworten.shift();
      if (!a) throw new Error('keine Antwort');
      return { code: 0, stdout: `ALFRED-AD ${JSON.stringify(a)}`, stderr: '' };
    },
    tresor: { namen: async () => new Set(tresor.keys()), lies: async n => tresor.get(n)!, setze: async (n, w) => { tresor.set(n, w); } },
    schlafe: async () => undefined,
  });
  return { skill, aufrufe };
}

function sqlWelt(antworten: object[]) {
  const aufrufe: Array<{ zugang: string; befehl: string; eingabe?: string; timeoutMs: number; zweck: string }> = [];
  const skill = new SqlServerSkill({
    skript: async (zugang, befehl, eingabe, timeoutMs, zweck) => {
      aufrufe.push({ zugang, befehl, ...(eingabe !== undefined ? { eingabe } : {}), timeoutMs, zweck });
      const a = antworten.shift();
      if (!a) throw new Error('keine Antwort');
      return { code: 0, stdout: `ALFRED-AD ${JSON.stringify(a)}`, stderr: '' };
    },
    schlafe: async () => undefined,
  });
  return { skill, aufrufe };
}

const plan = (schritte: unknown[]) => ({ titel: 'L6 Admin-Clients', begruendung: 'I8e Etappe 3 Paket L6', typ: 'normal', risiko: 'niedrig', ausfallMinuten: 0, betroffen: ['sqladmw11'], ohneSicherungGrund: 'frische Admin-Clients, nur Neues mit Rückweg', schritte });
const ctx = (): PruefKontext => {
  const ad = new WindowsAdSkill({ skript: async () => ({ code: 0, stdout: '', stderr: '' }) });
  const sql = new SqlServerSkill({ skript: async () => ({ code: 0, stdout: '', stderr: '' }) });
  return {
    skill: n => (n === 'windows_ad' ? ad : n === 'sql_server' ? sql : undefined) as never,
    asset: n => ({ id: `a-${n}`, name: n }),
    changes: [],
    jetzt: new Date('2026-11-20T10:00:00Z'),
    zugaenge: new Set(['sqladmw11', 'sqladm25', 'sqllnx01', 'sql01']),
    zugangSystem: new Map<string, 'linux' | 'windows'>([['sqladmw11', 'windows'], ['sqladm25', 'windows'], ['sql01', 'windows'], ['sqllnx01', 'linux']]),
  };
};

// ── R32 — Anmeldeprobe auch von den Admin-Clients ───────────────────────────────────────────────────────────────────────────────────

describe('Ruling R32 — sql_anmeldung_pruefen von sqladmw11/sqladm25', () => {
  it('Zugänge: sql01, sql02 und die beiden Admin-Clients — sonst nichts', () => {
    expect([...SQL_PROBE_ZUGAENGE].sort()).toEqual(['sql01', 'sql02', 'sqladm25', 'sqladmw11']);
  });
  it('Admin-Client: Probe läuft, Kennwort nur über die Standardeingabe; fremder Rechner abgewiesen ohne Aufruf', async () => {
    for (const zugang of ['sqladmw11', 'sqladm25']) {
      const w = adWelt([{ sqlcmd: SQLCMD_PFADE[1], exit: 0, ausgabe: 'KERBEROS|TRUE|SQLLNX01' }], ['ad-svc-sqllnx-test']);
      const r = await w.skill.execute({ action: 'sql_anmeldung_pruefen', zugang, server: 'sqllnxag01.ad.3033.at', konto_tresor: 'ad-svc-sqllnx-test' }, {} as never);
      expect(r.success, r.error).toBe(true);
      expect(r.display).toContain('SQL_KERBEROS_OK sqllnxag01.ad.3033.at');
      expect(w.aufrufe[0]!.zugang).toBe(zugang);
      expect(roh(w.aufrufe[0]!.befehl)).not.toContain('wert-ad-svc-sqllnx-test');
    }
    const f = adWelt([], ['ad-svc-sqllnx-test']);
    const r = await f.skill.execute({ action: 'sql_anmeldung_pruefen', zugang: 'sqladm26', server: 'sqllnxag01.ad.3033.at', konto_tresor: 'ad-svc-sqllnx-test' }, {} as never);
    expect(r.success).toBe(false);
    expect(r.error).toContain('sqladmw11');
    expect(f.aufrufe).toEqual([]);
  });
  it('sqlcmd: die ODBC-Pfade sind dieselben, die ssms_installieren belegt; fehlt sqlcmd → klarer Fehler mit Hinweis auf ssms_installieren', () => {
    expect(SQLCMD_ODBC_PFADE).toEqual(SQLCMD_PFADE.slice(1));
    const s = sqlAnmeldungSkript({ server: 'sqllnxag01.ad.3033.at', konto: 'svc-sqllnx-test' });
    expect(s).toContain('sqlcmd nicht gefunden');
    expect(s).toContain('sql_server ssms_installieren');
    // fail-closed: ohne Fund kein Aufruf, keine Ergebniszeile (throw vor dem Aufruf)
    expect(s.indexOf('sqlcmd nicht gefunden')).toBeLessThan(s.indexOf('& $x[0].pfad @sa'));
  });
  it('Beschreibung nennt die Admin-Clients', () => {
    const d = new WindowsAdSkill({ skript: async () => ({ code: 0, stdout: '', stderr: '' }) }).metadata.description;
    expect(d).toMatch(/sql_anmeldung_pruefen \(lesend; zugang nur sql01, sql02, sqladmw11 oder sqladm25/);
  });
});

// ── R33 — SSMS, sqlcmd und ODBC 18 auf einem Windows-Zugang ───────────────────────────────────────────────────────────────────────

const SSMS_OK = {
  rechner: 'SQLADMW11', neu: ['odbc', 'sqlcmd', 'ssms'], vorhanden: [], neustartNoetig: false,
  ssms: { pfad: SSMS_EXE, version: '22.12.1.0', produktVersion: '22.12.1' },
  sqlcmd: { pfad: SQLCMD_PFADE[1], version: '17.0.4055.5' },
  odbc: { dll: 'C:\\Windows\\system32\\msodbcsql18.dll', version: '2018.187.1.1' },
  downloads: [{ teil: 'odbc', signatur: 'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond' }],
};

describe('Ruling R33 — ssms_installieren / ssms_entfernen', () => {
  it('Quellen: nur Microsoft-URLs (gleiche Prüfung wie sql_medien_laden), feste Pfade', () => {
    for (const u of Object.values(SSMS_QUELLEN)) expect(MEDIEN_URL.test(u), u).toBe(true);
    expect(SSMS_QUELLEN.ssms).toBe('https://aka.ms/ssms/22/release/vs_SSMS.exe');
    expect(SSMS_QUELLEN.odbc).toMatch(/^https:\/\/go\.microsoft\.com\/fwlink\/\?linkid=\d+$/);
    expect(SSMS_QUELLEN.sqlcmd).toMatch(/^https:\/\/go\.microsoft\.com\/fwlink\/\?linkid=\d+$/);
    expect(SSMS_INSTALLATIONSPFAD).toBe('C:\\Program Files\\Microsoft SQL Server Management Studio 22\\Release');
    expect(SSMS_EXE).toBe(`${SSMS_INSTALLATIONSPFAD}\\Common7\\IDE\\SSMS.exe`);
    expect(ODBC_TREIBER).toBe('ODBC Driver 18 for SQL Server');
  });
  it('Skript: Signaturprüfung wie sql_medien_laden vor jedem Start, stille Parameter, wiederholbar, Selbstprüfung aller drei', () => {
    const s = ssmsInstallierenSkript();
    // dieselbe Signaturfunktion wie medienSkript (Valid + O=Microsoft Corporation)
    const sig = /function Signiert\(\$f\) \{[^\n]*\}/.exec(medienSkript({ url: SSMS_QUELLEN.ssms, art: 'installation' }))![0];
    expect(s).toContain(sig);
    expect(sig).toContain("$s.Status -ne 'Valid'");
    expect(sig).toContain("-notmatch 'O=Microsoft Corporation'");
    // jede geladene Datei wird geprüft, bevor sie startet
    for (const t of ['odbc', 'sqlcmd', 'ssms']) expect(s).toContain(`Laden '${t}'`);
    expect(s.indexOf('Signiert $f')).toBeLessThan(s.indexOf('Start-Process'));
    expect(s).toContain('IACCEPTMSODBCSQLLICENSETERMS=YES');
    expect(s).toContain('IACCEPTMSSQLCMDLNUTILSLICENSETERMS=YES');
    expect(s).toContain("'--quiet', '--norestart', '--wait'");
    expect(s).toContain("'/qn', '/norestart'");
    expect(s).not.toMatch(/shutdown|Restart-Computer/);
    // Reihenfolge: ODBC vor den Befehlszeilenwerkzeugen (die brauchen den Treiber), SSMS zuletzt
    expect(s.indexOf("Laden 'odbc'")).toBeLessThan(s.indexOf("Laden 'sqlcmd'"));
    expect(s.indexOf("Laden 'sqlcmd'")).toBeLessThan(s.indexOf("Laden 'ssms'"));
    // wiederholbar: nur Fehlendes laden, Merker hält fest, was Alfred installiert hat
    expect(s).toContain('if (-not (Odbc))');
    expect(s).toContain('if (-not (SqlcmdFund))');
    expect(s).toContain('if (-not (Ssms))');
    expect(s).toContain('installiert.json');
    // Selbstprüfung: Versionen aus Registry/Datei bzw. sqlcmd -?
    expect(s).toContain(`ODBCINST.INI\\\\${ODBC_TREIBER}`.replace(/\\\\/g, '\\'));
    expect(s).toContain("'-?'");
    expect(s).toContain('VersionInfo.FileVersion');
    expect(s).toContain('Selbstprüfung');
    // sqlcmd nur an den festen ODBC-Pfaden der Anmeldeprobe (R32)
    for (const p of SQLCMD_ODBC_PFADE) expect(s).toContain(p.replace(/'/g, "''"));
  });
  it('Rückweg-Skript entfernt nur, was der Merker nennt, in umgekehrter Reihenfolge, mit Selbstprüfung', () => {
    const s = ssmsEntfernenSkript();
    expect(s).toContain('installiert.json');
    expect(s).toContain("'uninstall', '--installPath'");
    expect(s).toContain("'/x'");
    expect(s.indexOf("'uninstall', '--installPath'")).toBeLessThan(s.indexOf('$m.sqlcmd'));
    expect(s.lastIndexOf('$m.sqlcmd')).toBeLessThan(s.lastIndexOf('$m.odbc'));
    expect(s).toContain('nach dem Entfernen noch');
  });
  it('Ergebniszeile fest; Erfolg nur mit allen drei belegten Versionen', () => {
    expect(ssmsText('sqladmw11', SSMS_OK)).toEqual({ ok: true, text: 'SSMS_INSTALLIERT sqladmw11: SSMS 22.12.1.0, sqlcmd 17.0.4055.5, ODBC 18 2018.187.1.1 — neu: odbc, sqlcmd, ssms' });
    expect(ssmsText('sql01', { ...SSMS_OK, neu: [], vorhanden: ['odbc', 'sqlcmd', 'ssms'] }).text).toBe('SSMS_INSTALLIERT sql01: SSMS 22.12.1.0, sqlcmd 17.0.4055.5, ODBC 18 2018.187.1.1 — alles vorhanden, nichts neu');
    expect(ssmsText('x', { ...SSMS_OK, neustartNoetig: true }).text).toContain('Neustart ausstehend');
    for (const kaputt of [{ ...SSMS_OK, ssms: { pfad: SSMS_EXE, version: '' } }, { ...SSMS_OK, sqlcmd: undefined }, { ...SSMS_OK, odbc: { dll: 'x', version: 'unbekannt' } }]) {
      const t = ssmsText('x', kaputt as never);
      expect(t.ok).toBe(false);
      expect(t.text).not.toContain('SSMS_INSTALLIERT');
    }
  });
  it('Skill: nur im Change, Zugang ohne Linux-Namen, Zeitgrenzen; Ergebnis aus dem Baustein', async () => {
    const w = sqlWelt([SSMS_OK]);
    expect((await w.skill.execute({ action: 'ssms_installieren', zugang: 'sqladmw11' }, {} as never)).error).toContain('nur als Schritt eines freigegebenen Changes');
    expect(w.aufrufe).toEqual([]);
    const r = await w.skill.execute({ action: 'ssms_installieren', zugang: 'sqladmw11' }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(r.display).toContain('SSMS_INSTALLIERT sqladmw11: SSMS 22.12.1.0, sqlcmd 17.0.4055.5, ODBC 18 2018.187.1.1');
    expect(r.display).toContain('Rückweg ssms_entfernen');
    expect(w.aufrufe[0]!.timeoutMs).toBe(3_600_000);
    expect(roh(w.aufrufe[0]!.befehl)).toContain('vs_SSMS.exe');
    const k = sqlWelt([{ ...SSMS_OK, ssms: null }]);
    const rk = await k.skill.execute({ action: 'ssms_installieren', zugang: 'sqladmw11' }, imChange);
    expect(rk.success).toBe(false);
    expect(rk.error).toContain('Selbstprüfung');
    const e = sqlWelt([{ rechner: 'SQLADMW11', entfernt: ['ssms', 'sqlcmd', 'odbc'], unveraendert: [], neustartNoetig: false }]);
    const re = await e.skill.execute({ action: 'ssms_entfernen', zugang: 'sqladmw11' }, imChange);
    expect(re.success, re.error).toBe(true);
    expect(re.display).toBe('SSMS_ENTFERNT sqladmw11: entfernt ssms, sqlcmd, odbc');
    const sk = new SqlServerSkill({ skript: async () => ({ code: 0, stdout: '', stderr: '' }) });
    expect(sk.mindestZeitlimitS('ssms_installieren')).toBe(3660);
    expect(sk.mindestZeitlimitS('ssms_entfernen')).toBe(1260);
    expect(sk.mindestZeitlimitS('status')).toBeUndefined();
    expect(sk.metadata.description).toContain('ssms_installieren');
  });
});

// ── R34 — Windows-Anmeldung für die Admin-Gruppe ──────────────────────────────────────────────────────────────────────────────────

const ANMELDUNG_OK = {
  rechner: 'SQLADMW11', konto: 'AD3033\\SQL-Linux-Admins', sid: 'S-1-5-21-1-2-3-1105', gruppeLokal: 'Remotedesktopbenutzer', zustand: 'eingerichtet',
  geaendert: ['rdp', 'nla', 'firewall', 'mitglied'], nachher: { rdp: true, nla: true, regel: true, mitglied: true },
};

describe('Ruling R34 — admin_anmeldung_einrichten / admin_anmeldung_entfernen', () => {
  it('Eingabe: nur SQL-Linux-Admins (Allowlist, Regex), nie Administratoren o. ä.', () => {
    expect([...ADMIN_ANMELDUNG_GRUPPEN]).toEqual(['SQL-Linux-Admins']);
    expect(pruefeAdminAnmeldung({ gruppe: 'SQL-Linux-Admins' })).toEqual({ gruppe: 'SQL-Linux-Admins' });
    expect(pruefeAdminAnmeldung({ gruppe: 'sql-linux-admins' })).toEqual({ gruppe: 'SQL-Linux-Admins' });
    for (const g of ['Domain Admins', 'Domänen-Admins', 'Administrators', 'SQL-Linux-Admins2', "SQL-Linux-Admins'; x", 'AD3033\\SQL-Linux-Admins', '', undefined]) expect(typeof pruefeAdminAnmeldung({ gruppe: g }), String(g)).toBe('string');
  });
  it('Skript: SID S-1-5-32-555 statt Gruppenname, NLA, Regelgruppe sprachunabhängig, nie Administratoren, Vorzustand vor jeder Änderung gemerkt', () => {
    const s = adminAnmeldungSkript({ gruppe: 'SQL-Linux-Admins' });
    expect(REMOTEDESKTOPBENUTZER_SID).toBe('S-1-5-32-555');
    expect(RDP_REGELGRUPPE).toBe('@FirewallAPI.dll,-28752');
    expect(s).toContain("-SID 'S-1-5-32-555'");
    expect(s).toContain("-Group '@FirewallAPI.dll,-28752'");
    expect(s).toContain('fDenyTSConnections');
    expect(s).toContain('UserAuthentication');
    expect(s).not.toMatch(/S-1-5-32-544|Administrators|Administratoren/);
    expect(s).not.toMatch(/Remote Desktop Users|Remotedesktopbenutzer'/);
    // nur Mitgliedsrechner, nie DC
    expect(s).toContain('DomainRole');
    // Vorzustand vor der ersten Änderung, nie überschrieben
    expect(s.indexOf('WriteAllText($merk')).toBeLessThan(s.indexOf('Set-ItemProperty'));
    expect(s).toContain('if (-not (Test-Path -LiteralPath $merk))');
    // GPO-Sperre → Abbruch vor jeder Änderung
    expect(s.indexOf('Richtlinie')).toBeLessThan(s.indexOf('Set-ItemProperty'));
  });
  it('Rückweg-Skript: Gruppe raus, RDP/NLA/Regeln nur nach gemerktem Vorzustand, Selbstprüfung', () => {
    const s = adminAnmeldungEntfernenSkript({ gruppe: 'SQL-Linux-Admins' });
    expect(s).toContain("Remove-LocalGroupMember -SID 'S-1-5-32-555'");
    expect(s).toContain('$v.vorher.deny');
    expect(s).toContain('Disable-NetFirewallRule');
    expect(s).toContain('nach dem Entfernen noch');
    expect(s).not.toMatch(/S-1-5-32-544/);
  });
  it('Skill: nur im Change, feste Ergebniszeile, Nachprüfung im Skill, kein Kennwort nötig', async () => {
    const w = adWelt([ANMELDUNG_OK]);
    expect((await w.skill.execute({ action: 'admin_anmeldung_einrichten', zugang: 'sqladmw11', gruppe: 'SQL-Linux-Admins' }, {} as never)).error).toContain('nur als Schritt eines freigegebenen Changes');
    const r = await w.skill.execute({ action: 'admin_anmeldung_einrichten', zugang: 'sqladmw11', gruppe: 'SQL-Linux-Admins' }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(r.display).toContain('ADMIN_ANMELDUNG_OK sqladmw11: RDP an (NLA), AD3033\\SQL-Linux-Admins in Remotedesktopbenutzer');
    expect(r.display).toContain('Rückweg admin_anmeldung_entfernen gruppe SQL-Linux-Admins');
    expect(w.aufrufe[0]!.eingabe).toBeUndefined();
    const schon = adWelt([{ ...ANMELDUNG_OK, zustand: 'schon', geaendert: [] }]);
    expect((await schon.skill.execute({ action: 'admin_anmeldung_einrichten', zugang: 'sqladm25', gruppe: 'SQL-Linux-Admins' }, imChange)).display).toContain('— nichts zu tun');
    const halb = adWelt([{ ...ANMELDUNG_OK, nachher: { rdp: true, nla: false, regel: true, mitglied: true } }]);
    const rh = await halb.skill.execute({ action: 'admin_anmeldung_einrichten', zugang: 'sqladmw11', gruppe: 'SQL-Linux-Admins' }, imChange);
    expect(rh.success).toBe(false);
    expect(rh.error).toContain('NLA');
    const f = adWelt([]);
    const rf = await f.skill.execute({ action: 'admin_anmeldung_einrichten', zugang: 'sqladmw11', gruppe: 'Domain Admins' }, imChange);
    expect(rf.success).toBe(false);
    expect(f.aufrufe).toEqual([]);
    const e = adWelt([{ rechner: 'SQLADMW11', konto: 'AD3033\\SQL-Linux-Admins', zustand: 'entfernt', rdp: 'aus (wie vorher)', mitglied: false }]);
    const re = await e.skill.execute({ action: 'admin_anmeldung_entfernen', zugang: 'sqladmw11', gruppe: 'SQL-Linux-Admins' }, imChange);
    expect(re.success, re.error).toBe(true);
    expect(re.display).toBe('ADMIN_ANMELDUNG_ENTFERNT sqladmw11: AD3033\\SQL-Linux-Admins nicht mehr in Remotedesktopbenutzer; RDP aus (wie vorher)');
  });
});

describe('L6 — Ergebniszeilen überstehen die Transport-Schwärzung (Ruling R26)', () => {
  it('ssms_installieren und admin_anmeldung_einrichten: realistische Zeilen unverändert', () => {
    const ssms = { ...SSMS_OK, downloads: [{ teil: 'ssms', signatur: 'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US', sha256: 'a3f1c2d4e5b60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90' }], sqlcmd: { ...SSMS_OK.sqlcmd, signatur: 'CN=Microsoft Corporation, O=Microsoft Corporation' } };
    const anm = { ...ANMELDUNG_OK, vorher: { deny: 1, nla: 1, regeln: [{ name: 'RemoteDesktop-UserMode-In-TCP', an: false }], mitglied: false } };
    for (const o of [ssms, anm, { rechner: 'SQLADMW11', entfernt: ['ssms'], unveraendert: [], neustartNoetig: false }, { rechner: 'SQLADMW11', konto: 'AD3033\\SQL-Linux-Admins', zustand: 'entfernt', zurueck: ['mitglied', 'rdp'], rdp: 'aus (wie vorher)', mitglied: false }]) {
      const z = `ALFRED-AD ${JSON.stringify(o)}`;
      expect(schwaerze(z).text).toBe(z);
    }
  });
});

describe('L6 — Werkzeugwahl (skill-filter)', () => {
  it('SSMS, ODBC und Remotedesktop holen die Infrastruktur-Skills', () => {
    for (const t of ['installiere SSMS auf dem Admin-Client', 'Management Studio fehlt', 'ODBC-Treiber aktualisieren', 'Remotedesktop für die Admins', 'RDP einschalten']) {
      expect(selectCategoriesOhneRueckfall(t, new Set(['infrastructure', 'core'] as never))?.has('infrastructure' as never), t).toBe(true);
    }
  });
});

// ── Planprüfung (change-schritte) ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('L6 — Planprüfung', () => {
  const ssms = (zugang: string, extra: Record<string, unknown> = {}) => ({ titel: 'SSMS', art: 'aktion', skill: 'sql_server', aktion: 'ssms_installieren', parameter: { zugang }, zeitlimitS: 3660, rueckweg: { skill: 'sql_server', aktion: 'ssms_entfernen', parameter: { zugang } }, ...extra });
  const anm = (zugang: string, extra: Record<string, unknown> = {}) => ({ titel: 'RDP', art: 'aktion', skill: 'windows_ad', aktion: 'admin_anmeldung_einrichten', parameter: { zugang, gruppe: 'SQL-Linux-Admins' }, rueckweg: { skill: 'windows_ad', aktion: 'admin_anmeldung_entfernen', parameter: { zugang, gruppe: 'SQL-Linux-Admins' } }, ...extra });
  it('Einordnung: ändernd; selbst geprüft (keine eigene Prüfung nötig)', () => {
    for (const [s, a] of [['sql_server', 'ssms_installieren'], ['sql_server', 'ssms_entfernen'], ['windows_ad', 'admin_anmeldung_einrichten'], ['windows_ad', 'admin_anmeldung_entfernen']]) expect(aktionsArt(s!, a!)).toBe('aendern');
    const r = pruefeChangePlan(plan([ssms('sqladmw11'), anm('sqladmw11')]), ctx());
    expect(r.fehler).toEqual([]);
  });
  it('Rückweg Pflicht und genau gepaart (Zugang, Gruppe)', () => {
    const f = (s: unknown) => pruefeChangePlan(plan([s]), ctx()).fehler.join(' | ');
    expect(f(ssms('sqladmw11', { rueckweg: { keiner: 'additiv' } }))).toContain('sql_server.ssms_installieren braucht immer einen Rückweg');
    expect(f(ssms('sqladmw11', { rueckweg: { skill: 'sql_server', aktion: 'ssms_entfernen', parameter: { zugang: 'sqladm25' } } }))).toContain('ssms_entfernen muss auf demselben Zugang laufen');
    expect(f(anm('sqladmw11', { rueckweg: { keiner: 'egal' } }))).toContain('windows_ad.admin_anmeldung_einrichten braucht immer einen Rückweg');
    expect(f(anm('sqladmw11', { rueckweg: { skill: 'windows_ad', aktion: 'status', parameter: { zugang: 'sqladmw11' } } }))).toContain('braucht als Rückweg genau windows_ad.admin_anmeldung_entfernen');
    expect(f(anm('sqladmw11', { rueckweg: { skill: 'windows_ad', aktion: 'admin_anmeldung_entfernen', parameter: { zugang: 'sqladm25', gruppe: 'SQL-Linux-Admins' } } }))).toContain('admin_anmeldung_entfernen muss auf demselben Zugang laufen');
  });
  it('Zeitgrenze, Linux-Zugang und fremde Gruppe schon beim Planen abgewiesen', () => {
    const f = (s: unknown) => pruefeChangePlan(plan([s]), ctx()).fehler.join(' | ');
    expect(f(ssms('sqladmw11', { zeitlimitS: 600 }))).toContain('mindestens 3660 s');
    expect(f(ssms('sqllnx01'))).toContain('sqllnx01 ist Linux — sql_server gehört auf einen Windows-Zugang');
    expect(f(anm('sqllnx01'))).toContain('sqllnx01 ist Linux — windows_ad gehört auf einen Windows-Zugang');
    expect(f(anm('sqladmw11', { parameter: { zugang: 'sqladmw11', gruppe: 'Domain Admins' } }))).toContain('gruppe');
  });
});

// PowerShell-Parser (Windows PowerShell 5.1), wenn vorhanden
const POWERSHELL = powershellVorhanden();
describe.skipIf(!POWERSHELL)('L6 — PowerShell-Parser', { timeout: 120_000 }, () => {
  it('alle neuen Bausteine ohne Parserfehler', () => {
    const p = parseSkripte({
      ssmsInstallieren: ssmsInstallierenSkript(),
      ssmsEntfernen: ssmsEntfernenSkript(),
      adminAnmeldung: adminAnmeldungSkript({ gruppe: 'SQL-Linux-Admins' }),
      adminAnmeldungEntfernen: adminAnmeldungEntfernenSkript({ gruppe: 'SQL-Linux-Admins' }),
      sqlAnmeldung: sqlAnmeldungSkript({ server: 'sqllnxag01.ad.3033.at', konto: 'svc-sqllnx-test' }),
    });
    expect(p.gegenprobeErkannt, `Gegenprobe (fehlerhaftes Skript) nicht erkannt: ${p.roh}`).toBe(true);
    for (const [name, ergebnis] of Object.entries(p.ergebnisse)) expect(ergebnis, name).toBe('OK');
  }, 60_000);
});
