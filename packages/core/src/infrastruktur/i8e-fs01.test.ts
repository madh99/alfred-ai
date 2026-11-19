import { describe, it, expect, afterEach } from 'vitest';
import { powershellVorhanden, parseSkripte } from './powershell-parser.testhilfe.js';
import { pruefeDienstkonto, dienstkontoSkript, dienstkontoEntfernenSkript, dienstkontoTresorName } from './windows-ad.js';
import { WindowsAdSkill } from './windows-ad-skill.js';
import { pruefeFreigabe, freigabeSkript, FEATURES } from './windows-cluster.js';
import { WindowsClusterSkill } from './windows-cluster-skill.js';
import { aktionsArt, pruefeChangePlan } from './change-schritte.js';

// Prozess-Tests: Ereignisschleife zwischen Tests freigeben (sonst „Timeout calling onTaskUpdate“ unter Last)
afterEach(() => new Promise<void>(r => setImmediate(r)));

// I8e Task 4 — fs01-Seite der Linux-SQL-Sicherung: Domänen-Dienstkonto und Freigabe mit Kontingent als feste Bausteine

const BOESE = ['; rm -rf /', '$(id)', '`id`', "a'b", 'a\nb', '../x', 'a"b', 'x$y', 'a b'];
const ps = (befehl: string) => Buffer.from(befehl.split(' ').pop()!, 'base64').toString('utf16le');

describe('I8e fs01 — windows_ad.dienstkonto_anlegen (Bausteine)', { timeout: 120_000 }, () => {
  it('Validator: sAMAccountName, OU, Beschreibung fest; Einschleusversuche abgewiesen', () => {
    expect(pruefeDienstkonto({ konto: 'svc-sqllnx-backup' })).toEqual({ konto: 'svc-sqllnx-backup', ou: 'Dienstkonten' });
    expect(pruefeDienstkonto({ konto: 'svc-sqllnx-backup', ou: 'Dienstkonten' })).toEqual({ konto: 'svc-sqllnx-backup', ou: 'Dienstkonten' });
    expect(pruefeDienstkonto({ konto: 'a' })).toContain('konto');
    expect(pruefeDienstkonto({ konto: 'x'.repeat(21) })).toContain('konto');
    expect(pruefeDienstkonto({ konto: 'svc$' })).toContain('konto');
    for (const b of BOESE) {
      expect(pruefeDienstkonto({ konto: `svc${b}` }), b).toContain('konto');
      if (b !== 'a b') expect(pruefeDienstkonto({ konto: 'svc-a', ou: `Dienstkonten${b}` }), b).toEqual(expect.stringContaining('ou'));
    }
    expect(dienstkontoTresorName('svc-SQLlnx-Backup')).toBe('ad-svc-sqllnx-backup');
  });
  it('Skript: Kennwörter nur aus der Standardeingabe, nie zurückgesetzt, Flags gesetzt, Anmeldung nachgeprüft', () => {
    const s = dienstkontoSkript({ konto: 'svc-sqllnx-backup', ou: 'Dienstkonten' });
    expect(s).toContain('[Console]::In.ReadLine()');
    expect(s).toContain('$e.dienstkennwort');
    expect(s).toContain('$e.kennwort');
    expect(s).toContain(`$p = '{"konto":"svc-sqllnx-backup","ou":"Dienstkonten"}' | ConvertFrom-Json`);
    expect(s).toContain('-PasswordNeverExpires $true');
    expect(s).toContain('-CannotChangePassword $true');
    expect(s).toContain("'Alfred I8e Dienstkonto'");
    // fremdes Konto gleichen Namens → Abbruch; abweichendes Kennwort → Abbruch statt Zurücksetzen
    expect(s).toContain('ist nicht von Alfred angelegt');
    expect(s).toContain('nicht still zurückgesetzt');
    expect(s).not.toMatch(/Set-ADAccountPassword/);
    // Selbstprüfung: LDAP-Anmeldung mit dem neuen Kennwort, Flags, OU
    expect(s).toContain('System.DirectoryServices.DirectoryEntry');
    // Fix-Runde 1 (Minor 7): Anlage und Anmeldeprüfung gegen diesen DC
    expect(s).toContain("$dc = $env:COMPUTERNAME + '.' + $d.DNSRoot");
    expect(s).toContain("('LDAP://' + $dc + '/' + $d.DistinguishedName)");
    expect(s).toMatch(/New-ADUser [^\n]*-Server \$dc/);
    expect(s).toContain('.NativeObject');
  });
  it('Entfernen nur für von Alfred angelegte Konten', () => {
    const s = dienstkontoEntfernenSkript({ konto: 'svc-sqllnx-backup' });
    expect(s).toContain("-ne 'Alfred I8e Dienstkonto'");
    expect(s).toContain('Remove-ADUser');
  });
});

describe('I8e fs01 — windows_ad.dienstkonto_anlegen (Skill)', { timeout: 120_000 }, () => {
  function welt(antworten: object[], tresorDa: string[] = ['win-dc01-admin']) {
    const aufrufe: Array<{ befehl: string; eingabe?: string; zweck: string }> = [];
    const tresor = new Map<string, string>(tresorDa.map(n => [n, `wert-${n}`]));
    const gesetzt: string[] = [];
    const skill = new WindowsAdSkill({
      skript: async (_z, befehl, eingabe, _t, zweck) => {
        aufrufe.push({ befehl, ...(eingabe !== undefined ? { eingabe } : {}), zweck });
        return { code: 0, stdout: `ALFRED-AD ${JSON.stringify(antworten.shift() ?? {})}`, stderr: '' };
      },
      tresor: { namen: async () => new Set(tresor.keys()), lies: async n => tresor.get(n)!, setze: async (n, w) => { gesetzt.push(n); tresor.set(n, w); } },
      schlafe: async () => undefined,
    });
    return { skill, aufrufe, tresor, gesetzt };
  }
  const imChange = { ausChange: true } as never;
  const ANLEGEN = { action: 'dienstkonto_anlegen', zugang: 'dc01', konto: 'svc-sqllnx-backup' };

  it('nur im Change; Kennwort erzeugt und im Tresor ad-<konto>, nur über die Standardeingabe', async () => {
    const w = welt([{ zustand: 'angelegt', konto: 'AD3033\\svc-sqllnx-backup', dn: 'CN=svc-sqllnx-backup,OU=Dienstkonten,DC=ad,DC=3033,DC=at', aktiv: true, laeuftNieAb: true, kannNichtAendern: true, anmeldung: true, inOu: true }]);
    expect((await w.skill.execute(ANLEGEN, {} as never)).error).toContain('nur als Schritt');
    expect(w.aufrufe).toHaveLength(0);
    const r = await w.skill.execute(ANLEGEN, imChange);
    expect(r.error).toBeUndefined();
    const kw = w.tresor.get('ad-svc-sqllnx-backup')!;
    expect(kw).toMatch(/^Al-[A-Za-z0-9]{24}9a$/);
    expect(w.gesetzt).toEqual(['ad-svc-sqllnx-backup']);
    expect(JSON.parse(w.aufrufe[0]!.eingabe!)).toEqual({ kennwort: 'wert-win-dc01-admin', dienstkennwort: kw });
    expect(w.aufrufe[0]!.befehl).not.toContain(kw);
    expect(ps(w.aufrufe[0]!.befehl)).not.toContain(kw);
    expect(r.display).toContain('svc-sqllnx-backup');
    expect(r.display).toContain('ad-svc-sqllnx-backup');
    expect(JSON.stringify(r)).not.toContain(kw);
  });
  it('zweiter Lauf liest das Kennwort aus dem Tresor (kein neues), „schon“ → nichts zu tun', async () => {
    const w = welt([{ zustand: 'schon', konto: 'AD3033\\svc-sqllnx-backup', dn: 'CN=x', aktiv: true, laeuftNieAb: true, kannNichtAendern: true, anmeldung: true, inOu: true }], ['win-dc01-admin', 'ad-svc-sqllnx-backup']);
    const r = await w.skill.execute(ANLEGEN, imChange);
    expect(r.display).toContain('nichts zu tun');
    expect(w.gesetzt).toEqual([]);
    expect(JSON.parse(w.aufrufe[0]!.eingabe!).dienstkennwort).toBe('wert-ad-svc-sqllnx-backup');
  });
  it('Selbstprüfung: fehlt Anmeldung oder ein Flag im Ergebnis → Fehler', async () => {
    const w = welt([{ zustand: 'angelegt', konto: 'x', dn: 'x', aktiv: true, laeuftNieAb: true, kannNichtAendern: true, anmeldung: false, inOu: true }]);
    expect((await w.skill.execute(ANLEGEN, imChange)).error).toContain('Nachprüfung');
    const v = welt([{ zustand: 'angelegt', konto: 'x', dn: 'x', aktiv: true, laeuftNieAb: false, kannNichtAendern: true, anmeldung: true, inOu: true }]);
    expect((await v.skill.execute(ANLEGEN, imChange)).error).toContain('Nachprüfung');
    // Fix-Runde 1 (Minor 8): fehlende OU-Angabe im Ergebnis zählt als Fehlschlag
    const o = welt([{ zustand: 'angelegt', konto: 'x', dn: 'x', aktiv: true, laeuftNieAb: true, kannNichtAendern: true, anmeldung: true }]);
    expect((await o.skill.execute(ANLEGEN, imChange)).error).toContain('Nachprüfung');
  });
  it('Einschleusversuche in konto/ou → Fehler vor jedem Aufruf und vor jedem Tresor-Eintrag', async () => {
    for (const b of BOESE) {
      const w = welt([]);
      expect((await w.skill.execute({ ...ANLEGEN, konto: `svc${b}` }, imChange)).error, b).toContain('konto');
      if (b !== 'a b') expect((await w.skill.execute({ ...ANLEGEN, ou: `x${b}` }, imChange)).error, b).toContain('ou');
      expect(w.aufrufe).toHaveLength(0);
      expect(w.gesetzt).toHaveLength(0);
    }
  });
  it('dienstkonto_entfernen ist der Rückweg (nur im Change)', async () => {
    const w = welt([{ zustand: 'entfernt' }]);
    expect((await w.skill.execute({ action: 'dienstkonto_entfernen', zugang: 'dc01', konto: 'svc-sqllnx-backup' }, {} as never)).error).toContain('nur als Schritt');
    const r = await w.skill.execute({ action: 'dienstkonto_entfernen', zugang: 'dc01', konto: 'svc-sqllnx-backup' }, imChange);
    expect(r.display).toContain('entfernt');
    expect(JSON.parse(w.aufrufe[0]!.eingabe!)).toEqual({ kennwort: 'wert-win-dc01-admin' });
    expect(aktionsArt('windows_ad', 'dienstkonto_anlegen')).toBe('aendern');
    expect(aktionsArt('windows_ad', 'dienstkonto_entfernen')).toBe('aendern');
  });
});

describe('I8e fs01 — windows_cluster.freigabe_anlegen mit Kontingent', { timeout: 120_000 }, () => {
  const F = { name: 'SQLLinuxBackup$', pfad: 'S:\\SQLLinuxBackup', aendern: ['AD3033\\svc-sqllnx-backup'] };
  it('kontingent_gib: ganze Zahl 1–16384, optional; ohne Angabe unverändert', () => {
    expect(pruefeFreigabe(F)).toEqual({ ...F, vollzugriff: [] });
    expect(pruefeFreigabe({ ...F, kontingent_gib: 64 })).toEqual({ ...F, vollzugriff: [], kontingentGib: 64 });
    expect(pruefeFreigabe({ ...F, kontingent_gib: '64' })).toEqual({ ...F, vollzugriff: [], kontingentGib: 64 });
    for (const k of [0, -1, 1.5, 20000, '64; rm', '$(id)', 'x']) expect(pruefeFreigabe({ ...F, kontingent_gib: k }), String(k)).toContain('kontingent_gib');
  });
  it('Skript: FSRM-Kontingent hart nur, wenn die Rolle da ist — nie still installiert; sonst „fehlt“ im Ergebnis', () => {
    const s = freigabeSkript({ ...F, vollzugriff: [], kontingentGib: 64 });
    expect(s).toContain("Get-WindowsFeature -Name 'FS-Resource-Manager'");
    expect(s).toContain('New-FsrmQuota -Path $p.pfad -Size');
    expect(s).toContain('-SoftLimit:$false');
    expect(s).toContain('die Rolle FS-Resource-Manager fehlt');
    expect(s).not.toMatch(/Install-WindowsFeature/);
    // ohne Kontingent kein FSRM-Teil
    expect(freigabeSkript({ ...F, vollzugriff: [] })).not.toContain('Fsrm');
  });
  it('Skript: Rechte exakt (Freigabe und NTFS) nachgeprüft; unverändert → „schon“', () => {
    const s = freigabeSkript({ ...F, vollzugriff: [], kontingentGib: 64 });
    expect(s).toContain('$acl.SetAccessRuleProtection($true, $false)');
    expect(s).toContain("'Modify'");
    expect(s).toContain('NTFS-Rechte nach dem Setzen');
    expect(s).toContain('Freigaberechte nach dem Setzen');
    expect(s).toContain("{ 'schon' } else { 'Rechte erneuert' }");
    // Fix-Runde 1 (Minor 5): Freigabe/Ordner vor Set-Acl geprüft; fremder gefüllter Ordner → Abbruch
    expect(s.indexOf('ist nicht leer und keine Alfred-Freigabe')).toBeGreaterThan(0);
    expect(s.indexOf('ist nicht leer und keine Alfred-Freigabe')).toBeLessThan(s.indexOf('Set-Acl -Path'));
    expect(s.indexOf("zeigt schon auf")).toBeLessThan(s.indexOf('Set-Acl -Path'));
    // Minor 6: Rechte je SID verglichen (Vollzugriff/Ändern), keine Verweigern-Regeln
    expect(s).toContain("$sollR = @{ 'S-1-5-18' = 'F'; 'S-1-5-32-544' = 'F' }");
    expect(s).toContain("$sollR[$sid] = 'M'");
    expect(s).toContain("$frSoll[$sid] = 'Change'");
    expect(s).toContain('Verweigern-Regel');
  });
  it('FS-Resource-Manager lässt sich als Feature ausdrücklich installieren (eigener Schritt)', () => {
    expect(FEATURES.has('FS-Resource-Manager')).toBe(true);
  });
  it('Skill reicht kontingent_gib durch und nennt den Kontingent-Zustand', async () => {
    const aufrufe: string[] = [];
    const skill = new WindowsClusterSkill({
      skript: async (_z, befehl) => { aufrufe.push(befehl); return { code: 0, stdout: `ALFRED-AD ${JSON.stringify({ unc: '\\\\fs01.ad.3033.at\\SQLLinuxBackup$', zustand: 'neu', rechte: ['BUILTIN\\Administrators:Full', 'AD3033\\svc-sqllnx-backup:Change'], kontingent: 'fehlt' })}`, stderr: '' }; },
      schlafe: async () => undefined,
    });
    const r = await skill.execute({ action: 'freigabe_anlegen', zugang: 'fs01', name: 'SQLLinuxBackup$', pfad: 'S:\\SQLLinuxBackup', aendern: ['AD3033\\svc-sqllnx-backup'], kontingent_gib: 64 }, { ausChange: true } as never);
    // Fix-Welle M-7: „fehlt“ ist ein Fehler, nicht grün
    expect(r.success).toBe(false);
    expect(r.error).toContain('features_installieren');
    expect(ps(aufrufe[0]!)).toContain('"kontingentGib":64');
  });
});

describe('I8e fs01 — Change „Sicherungsziel auf fs01“', { timeout: 120_000 }, () => {
  const ad = new WindowsAdSkill({ skript: async () => ({ code: 0, stdout: '', stderr: '' }) });
  const cl = new WindowsClusterSkill({ skript: async () => ({ code: 0, stdout: '', stderr: '' }) });
  const ctx = { skill: (n: string) => (n === 'windows_ad' ? ad : n === 'windows_cluster' ? cl : undefined) as never, asset: (n: string) => ({ id: `a-${n}`, name: n }), changes: [] };
  const schritte = [
    { titel: 'Dienstkonto', art: 'aktion', skill: 'windows_ad', aktion: 'dienstkonto_anlegen', parameter: { zugang: 'dc01', konto: 'svc-sqllnx-backup' }, zeitlimitS: 600,
      rueckweg: { skill: 'windows_ad', aktion: 'dienstkonto_entfernen', parameter: { zugang: 'dc01', konto: 'svc-sqllnx-backup' } } },
    { titel: 'Freigabe', art: 'aktion', skill: 'windows_cluster', aktion: 'freigabe_anlegen', zeitlimitS: 600,
      parameter: { zugang: 'fs01', name: 'SQLLinuxBackup$', pfad: 'S:\SQLLinuxBackup', aendern: ['AD3033\svc-sqllnx-backup'], kontingent_gib: 64 },
      rueckweg: { skill: 'windows_cluster', aktion: 'freigabe_entfernen', parameter: { zugang: 'fs01', name: 'SQLLinuxBackup$' } },
      pruefung: { typ: 'skill', skill: 'windows_cluster', aktion: 'status', parameter: { zugang: 'fs01' }, erwartet: 'SQLLinuxBackup$=S:\SQLLinuxBackup' } },
  ];
  const plan = (s: unknown[]) => ({ titel: 'Sicherungsziel fs01', begruendung: 'I8e Task 4', typ: 'normal', risiko: 'low', ausfallMinuten: 0, betroffen: ['fs01', 'dc01'], ohneSicherungGrund: 'nur additive Objekte (Konto, Ordner, Freigabe)', schritte: s });
  it('Dienstkonto prüft sich selbst (keine eigene Prüfung nötig), Freigabe mit Rückweg: 0 Fehler', () => {
    expect(pruefeChangePlan(plan(schritte), ctx).fehler).toEqual([]);
  });
  it('kontingent_gib mit Einschleusversuch scheitert schon beim Planen', () => {
    const f = pruefeChangePlan(plan([schritte[0], { ...schritte[1], parameter: { ...schritte[1]!.parameter, kontingent_gib: '64; rm' } }]), ctx).fehler;
    expect(f.join(' | ')).toContain('kontingent_gib');
  });
});

// PowerShell-Parser (Windows PowerShell 5.1), wenn vorhanden: jedes neue Skript ist syntaktisch gültig (gemeinsame Testhilfe, Skripte als Datei)
const POWERSHELL = powershellVorhanden();
describe.skipIf(!POWERSHELL)('I8e fs01 — PowerShell-Parser', { timeout: 120_000 }, () => {
  it('dienstkonto_anlegen/-entfernen und freigabe_anlegen (mit/ohne Kontingent) ohne Parserfehler', () => {
    const skripte = {
      dienstkonto: dienstkontoSkript({ konto: 'svc-sqllnx-backup', ou: 'Dienstkonten' }),
      dienstkontoEntfernen: dienstkontoEntfernenSkript({ konto: 'svc-sqllnx-backup' }),
      freigabeKontingent: freigabeSkript({ name: 'SQLLinuxBackup$', pfad: 'S:\SQLLinuxBackup', vollzugriff: [], aendern: ['AD3033\svc-sqllnx-backup'], kontingentGib: 64 }),
      freigabe: freigabeSkript({ name: 'Witness$', pfad: 'W:\Witness', vollzugriff: ['AD3033\SQLCL01$'], aendern: [] }),
    };
    const p = parseSkripte(skripte);
    expect(p.gegenprobeErkannt, `Gegenprobe (fehlerhaftes Skript) nicht erkannt: ${p.roh}`).toBe(true);
    for (const [name, ergebnis] of Object.entries(p.ergebnisse)) expect(ergebnis, name).toBe('OK');
  }, 60_000);
});
