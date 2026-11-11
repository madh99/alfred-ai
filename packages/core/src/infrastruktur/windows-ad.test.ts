import { describe, it, expect } from 'vitest';
import { adErgebnis, adStatusSkript, dcBereit, mitgliedBereit, waldSkript, dcSkript, beitrittSkript, grundstrukturSkript, sicherungSkript, papierkorbSkript, dnsEintragSkript, pruefeWald, pruefeDns, pruefeGrundstruktur, kodiert, adStatusText, clixmlFehler, type AdStatus } from './windows-ad.js';
import { WindowsAdSkill, dsrmName } from './windows-ad-skill.js';
import { aktionsArt, pruefeChangePlan } from './change-schritte.js';

// I8c (Vorhaben 8cbcf251, Owner 08.11.: „Alfred die Fähigkeit geben“) — Active Directory über feste Bausteine
const DC: AdStatus = { rechner: 'DC01', domaene: 'ad.3033.at', mitglied: true, rolle: 5, dienste: { NTDS: 'Running', DNS: 'Running', ADWS: 'Running', Netlogon: 'Running', Kdc: 'Running', W32Time: 'Running' }, pdc: 'dc01.ad.3033.at', dcs: ['dc01.ad.3033.at'], netbios: 'AD3033', papierkorb: false };
const AG: AdStatus = { rechner: 'DC01', domaene: 'WORKGROUP', mitglied: false, rolle: 2 };

describe('I8c Bausteine', () => {
  it('Ergebniszeile trotz CLIXML-Fortschritt; Bereitschaft nur mit laufenden AD-Diensten', () => {
    const aus = `#< CLIXML\r\nALFRED-AD ${JSON.stringify(DC)}\r\n<Objs Version="1.1.0.1"></Objs>`;
    expect(adErgebnis<AdStatus>(aus)).toEqual(DC);
    expect(adErgebnis('nichts')).toBeUndefined();
    expect(dcBereit(DC, 'AD.3033.at')).toBe(true);
    expect(dcBereit({ ...DC, dienste: { ...DC.dienste, ADWS: 'StartPending' } }, 'ad.3033.at')).toBe(false);
    expect(dcBereit(AG, 'ad.3033.at')).toBe(false);
    expect(mitgliedBereit({ ...AG, mitglied: true, rolle: 3, domaene: 'ad.3033.at' }, 'ad.3033.at')).toBe(true);
    expect(adStatusText(DC)).toBe('DC01: Domänencontroller von ad.3033.at (PDC dc01.ad.3033.at), DCs: dc01.ad.3033.at; Dienste laufen');
    expect(adStatusText(AG)).toBe('DC01: keiner Domäne beigetreten (Arbeitsgruppe WORKGROUP)');
  });
  it('Geheimnisse nur über die Standardeingabe, Parameter als JSON-Literal, Neustart im Skript', () => {
    const w = waldSkript({ domaene: 'ad.3033.at', netbios: 'AD3033' });
    expect(w).toContain('[Console]::In.ReadToEnd()');
    expect(w).toContain('$e.dsrm');
    expect(w).toContain(`$p = '{"domaene":"ad.3033.at","netbios":"AD3033"}' | ConvertFrom-Json`);
    expect(w).toContain('Install-ADDSForest -DomainName $p.domaene -DomainNetbiosName $p.netbios -InstallDns');
    expect(w).toContain('shutdown.exe /r /t 20');
    expect(dcSkript({ domaene: 'ad.3033.at', netbios: 'AD3033', dns: ['10.203.29.2'] })).toContain("else { $p.netbios + '\\alfred' }");
    expect(beitrittSkript({ domaene: 'ad.3033.at', netbios: 'AD3033', dns: ['10.203.29.2', '10.203.29.3'], ou: 'Server' })).toContain('Add-Computer @ziel');
    expect(adStatusSkript()).not.toContain('ReadToEnd');
    // einfache Anführungszeichen in Werten werden verdoppelt (kein Ausbruch aus dem Literal)
    expect(dnsEintragSkript({ zone: 'ad.3033.at', name: "a'b", ip: '1.2.3.4' })).toContain(`"name":"a''b"`);
  });
  it('Grundstruktur: nur am PDC, Papierkorb, alfred über die Domänen-SID -512, NTP; Sicherung nur eine RAW-Platte passender Größe', () => {
    const g = grundstrukturSkript({ ous: ['Server'], ntp: ['0.at.pool.ntp.org'], weiterleiter: ['10.203.29.1'] });
    expect(g).toContain('nur am PDC-Emulator');
    expect(g).toContain("Enable-ADOptionalFeature -Identity 'Recycle Bin Feature'");
    expect(g).toContain("($d.DomainSID.Value + '-512')");
    expect(g).toContain('/syncfromflags:manual /reliable:yes');
    const s = sicherungSkript({ laufwerk: 'S', groesseGb: 64, uhrzeit: '02:30' });
    expect(s).toContain("$_.Number -ne 0 -and $_.PartitionStyle -eq 'RAW'");
    expect(s).toContain('-le 2');
    expect(papierkorbSkript({ kennung: 'x1' })).toContain('Restore-ADObject -Identity $guid');
  });
  it('Eingabeprüfung', () => {
    expect(pruefeWald({ domaene: 'ad.3033.at', netbios: 'AD3033' })).toBeUndefined();
    expect(pruefeWald({ domaene: 'AD', netbios: 'AD3033' })).toContain('domaene');
    expect(pruefeWald({ domaene: 'ad.3033.at', netbios: 'VIEL-ZU-LANGER-NAME' })).toContain('netbios');
    expect(pruefeDns(['10.203.29.2', '10.203.29.3'])).toEqual(['10.203.29.2', '10.203.29.3']);
    expect(pruefeDns('dc01')).toContain('IPv4');
    expect(pruefeGrundstruktur({ ous: ['Server; rm'], ntp: ['x.at'], weiterleiter: [] })).toContain('ous');
    expect(kodiert('Write-Output 1')).toMatch(/^powershell -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/);
  });
});

describe('I8c Skill windows_ad', () => {
  function welt(antworten: Array<object | Error>, tresorDa: string[] = []) {
    const aufrufe: Array<{ befehl: string; eingabe?: string; zweck: string }> = [];
    const tresor = new Map<string, string>(tresorDa.map(n => [n, `wert-${n}`]));
    const skill = new WindowsAdSkill({
      skript: async (_z, befehl, eingabe, _t, zweck) => {
        aufrufe.push({ befehl, ...(eingabe !== undefined ? { eingabe } : {}), zweck });
        const a = antworten.shift();
        if (!a || a instanceof Error) throw a ?? new Error('keine Antwort');
        return { code: 0, stdout: `ALFRED-AD ${JSON.stringify(a)}`, stderr: '' };
      },
      tresor: { namen: async () => new Set(tresor.keys()), lies: async n => tresor.get(n)!, setze: async (n, w) => { tresor.set(n, w); } },
      schlafe: async () => undefined,
    });
    return { skill, aufrufe, tresor };
  }
  const imChange = { ausChange: true } as never;

  it('wald_anlegen: nur im Change, DSRM im Tresor, Kennwort nie im Befehl, wartet über den Neustart hinweg', async () => {
    const w = welt([AG, { zustand: 'hochgestuft', neustart: true }, new Error('SSH weg (Neustart)'), { ...DC, dienste: { ...DC.dienste, ADWS: 'StartPending' } }, DC]);
    expect((await w.skill.execute({ action: 'wald_anlegen', zugang: 'dc01', domaene: 'ad.3033.at', netbios: 'AD3033' }, {} as never)).error).toContain('nur als Schritt');
    const r = await w.skill.execute({ action: 'wald_anlegen', zugang: 'dc01', domaene: 'ad.3033.at', netbios: 'ad3033' }, imChange);
    expect(r.error).toBeUndefined();
    expect(r.display).toContain('Wald ad.3033.at (AD3033) angelegt');
    const dsrm = w.tresor.get(dsrmName('ad.3033.at', 'dc01'))!;
    expect(dsrm).toMatch(/^Al-[A-Za-z0-9]{24}9a$/);
    const wald = w.aufrufe.find(a => a.zweck === 'Neuer Wald')!;
    expect(JSON.parse(wald.eingabe!)).toEqual({ dsrm });
    expect(w.aufrufe.every(a => !a.befehl.includes(dsrm) && !Buffer.from(a.befehl.split(' ').pop()!, 'base64').toString('utf16le').includes(dsrm))).toBe(true);
    expect(w.aufrufe.map(a => a.zweck)).toEqual(['AD-Status', 'Neuer Wald', 'AD-Status', 'AD-Status', 'AD-Status']);
  });
  it('schon DC dieser Domäne → nichts tun; dc_hinzufuegen braucht den Tresor-Eintrag des Kontos', async () => {
    const a = welt([DC]);
    expect((await a.skill.execute({ action: 'wald_anlegen', zugang: 'dc01', domaene: 'ad.3033.at', netbios: 'AD3033' }, imChange)).display).toContain('nichts zu tun');
    const b = welt([AG]);
    expect((await b.skill.execute({ action: 'dc_hinzufuegen', zugang: 'dc02', domaene: 'ad.3033.at', netbios: 'AD3033', dns: ['10.203.29.2'], konto_tresor: 'win-dc01-admin' }, imChange)).error).toContain('gibt es nicht');
    const c = welt([AG, { zustand: 'hochgestuft' }, { ...DC, rechner: 'DC02' }], ['win-dc01-admin']);
    const r = await c.skill.execute({ action: 'dc_hinzufuegen', zugang: 'dc02', domaene: 'ad.3033.at', netbios: 'AD3033', dns: ['10.203.29.2'], konto_tresor: 'win-dc01-admin' }, imChange);
    expect(r.error).toBeUndefined();
    expect(JSON.parse(c.aufrufe[1]!.eingabe!)).toMatchObject({ kennwort: 'wert-win-dc01-admin' });
  });
  it('status liest auch außerhalb eines Changes; Fehler mit Exit und Ausgabe', async () => {
    const w = welt([DC]);
    expect((await w.skill.execute({ action: 'status', zugang: 'dc01' }, {} as never)).display).toContain('Domänencontroller von ad.3033.at');
    const f = new WindowsAdSkill({ skript: async () => ({ code: 1, stdout: '#< CLIXML', stderr: 'Install-ADDSForest : Die Prüfung ist fehlgeschlagen.' }), schlafe: async () => undefined });
    expect((await f.execute({ action: 'status', zugang: 'dc01' }, {} as never)).error).toContain('Exit 1): Install-ADDSForest : Die Prüfung ist fehlgeschlagen.');
  });
  it('v1779 Realfall 3103ec4c: grundstruktur mit dem Domänen-Administrator aus win-<zugang>-admin; Fehler aus CLIXML lesbar', async () => {
    const ohne = welt([]);
    expect((await ohne.skill.execute({ action: 'grundstruktur', zugang: 'dc01', weiterleiter: ['10.203.29.1'] }, imChange)).error).toContain('win-dc01-admin gibt es nicht');
    const w = welt([{ ous: ['Server'], papierkorb: true, alfredAdmin: 'neu', kds: 'neu' }], ['win-dc01-admin']);
    const r = await w.skill.execute({ action: 'grundstruktur', zugang: 'dc01', weiterleiter: ['10.203.29.1'] }, imChange);
    expect(r.error).toBeUndefined();
    expect(JSON.parse(w.aufrufe[0]!.eingabe!)).toEqual({ kennwort: 'wert-win-dc01-admin' });
    const skript = Buffer.from(w.aufrufe[0]!.befehl.split(' ').pop()!, 'base64').toString('utf16le');
    expect(skript).toContain('[Console]::In.ReadToEnd()');
    expect(skript).toContain("else { $d.NetBIOSName + '\\Administrator' }");
    expect(skript).toMatch(/Enable-ADOptionalFeature [^\n]*-Credential \$cred/);
    expect(skript).toMatch(/Add-ADGroupMember [^\n]*-Credential \$cred/);
    expect(skript).not.toContain('wert-win-dc01-admin');
    // S4U-Token der SSH-Sitzung ohne Domänengruppen: KDS über WinRM mit dem Domänen-Administrator
    expect(skript).toMatch(/Invoke-Command -ComputerName \$env:COMPUTERNAME -Credential \$cred -ScriptBlock \{[^\n]*Add-KdsRootKey/);
    const pk = welt([{ konto: 'alfred-pk-x', wiederhergestellt: true }], ['win-dc01-admin']);
    expect((await pk.skill.execute({ action: 'papierkorb_beweis', zugang: 'dc01' }, imChange)).error).toBeUndefined();
    expect(JSON.parse(pk.aufrufe[0]!.eingabe!)).toEqual({ kennwort: 'wert-win-dc01-admin' });
    const pks = Buffer.from(pk.aufrufe[0]!.befehl.split(' ').pop()!, 'base64').toString('utf16le');
    for (const z of pks.split('\n').filter(l => /^(New-ADUser|Remove-ADUser|Restore-ADObject|\$guid =|\$geloescht =|\$zurueck =)/.test(l))) expect(z).toContain('-Credential $c');
    const aus = '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="x"><S S="Error">Enable-ADOptionalFeature : Insufficient access rights_x000D__x000A_</S><S S="Error">    + FullyQualifiedErrorId : 8344_x000D__x000A_</S></Objs>';
    expect(clixmlFehler(aus)).toBe('Enable-ADOptionalFeature : Insufficient access rights + FullyQualifiedErrorId : 8344');
    const f = new WindowsAdSkill({ skript: async () => ({ code: 1, stdout: '', stderr: aus }), schlafe: async () => undefined });
    expect((await f.execute({ action: 'status', zugang: 'dc01' }, {} as never)).error).toContain('Exit 1): Enable-ADOptionalFeature : Insufficient access rights');
  });
  it('Change-Plan: status lesend, Hochstufen ohne Rückweg zulässig', () => {
    expect(aktionsArt('windows_ad', 'status')).toBe('lesen');
    expect(aktionsArt('windows_ad', 'wald_anlegen')).toBe('aendern');
    const sk = new WindowsAdSkill({ skript: async () => ({ code: 0, stdout: '', stderr: '' }) });
    const plan = { titel: 'dc01 Wald', begruendung: 'I8c Vorhaben 8cbcf251', typ: 'normal', risiko: 'mittel', ausfallMinuten: 0, betroffen: ['dc01'],
      schritte: [{ titel: 'Wald anlegen', art: 'aktion', skill: 'windows_ad', aktion: 'wald_anlegen', parameter: { zugang: 'dc01', domaene: 'ad.3033.at', netbios: 'AD3033' }, zeitlimitS: 2400, rueckweg: { keiner: 'Herabstufen ist ein eigener Change' },
        pruefung: { typ: 'skill', skill: 'windows_ad', aktion: 'status', parameter: { zugang: 'dc01' }, erwartet: 'Domänencontroller von ad.3033.at' } }] };
    const f = pruefeChangePlan(plan, { skill: n => (n === 'windows_ad' ? sk as never : undefined), asset: n => ({ id: `a-${n}`, name: n }), changes: [] }).fehler;
    expect(f.filter(x => /Rückweg|windows_ad|wald_anlegen/.test(x))).toEqual([]);
  });
});

describe('I8c dns_client (DCs gegenseitig als DNS)', () => {
  it('setzt in der Reihenfolge, nennt die vorherigen für den Rückweg; nur im Change', async () => {
    const { dnsClientSkript } = await import('./windows-ad.js');
    expect(dnsClientSkript({ dns: ['10.203.29.3', '10.203.29.2'] })).toContain("throw ('DNS nach dem Setzen: '");
    const skill = new WindowsAdSkill({ skript: async () => ({ code: 0, stdout: 'ALFRED-AD {"vorher":["10.203.29.2"],"nachher":["10.203.29.3","10.203.29.2"]}', stderr: '' }) });
    expect((await skill.execute({ action: 'dns_client', zugang: 'dc01', dns: ['10.203.29.3', '10.203.29.2'] }, {} as never)).success).toBe(false);
    const r = await skill.execute({ action: 'dns_client', zugang: 'dc01', dns: ['10.203.29.3', '10.203.29.2'] }, { ausChange: true } as never);
    expect(r.display).toContain('Rückweg: dns_client mit dns ["10.203.29.2"]');
  });
});

// v1782 — Realfall 09.11. (I8c C fec4e344 Schritt 5): Replikation und DNS-Client im Status, Windows-Prüfbefehle wie im Käfig
describe('v1782 Replikation und DNS-Client im AD-Status, Windows-Prüfbefehle in der Planprüfung', () => {
  const dc = (x: Partial<AdStatus>): AdStatus => ({ rechner: 'DC02', domaene: 'ad.3033.at', mitglied: true, rolle: 4, dienste: { NTDS: 'Running' }, pdc: 'dc01.ad.3033.at', dcs: ['dc01.ad.3033.at', 'dc02.ad.3033.at'], ...x });
  it('Statustext nennt Replikation und DNS-Client im prüfbaren Wortlaut', () => {
    expect(adStatusText(dc({ replPartner: 1, replFehler: 0, dnsClient: ['10.203.29.2', '10.203.29.3'] }))).toContain('Replikation fehlerfrei (1 Partner); DNS-Client 10.203.29.2,10.203.29.3');
    expect(adStatusText(dc({ replPartner: 1, replFehler: 1, replMeldung: '8453 (dc01)' }))).toContain('Replikation FEHLER bei 1 von 1 Partner(n): 8453 (dc01)');
    expect(adStatusText(dc({ replPartner: 0 }))).toContain('Replikation: noch kein Partner');
    expect(adStatusText(dc({ replAbfrage: 'ADWS nicht erreichbar' }))).not.toContain('fehlerfrei');
    expect(adStatusText({ rechner: 'P', domaene: 'ad.3033.at', mitglied: true, rolle: 3, dnsClient: ['10.203.29.2'] })).toBe('P: Mitglied der Domäne ad.3033.at; DNS-Client 10.203.29.2');
    const s = adStatusSkript();
    expect(s).toContain('Get-ADReplicationPartnerMetadata -Target $env:COMPUTERNAME -Scope Server');
    expect(s).toContain('Get-DnsClientServerAddress -AddressFamily IPv4');
  });
  it('Planprüfung weist Windows-Prüfbefehle ab, die im Lese-Käfig nie bestehen', async () => {
    const { pruefbefehlFehler } = await import('./change-schritte.js');
    const realfall = `powershell -NoProfile -Command "if(@(Get-ADReplicationFailure -Scope Domain -Target ad.3033.at -ErrorAction Stop).Count -eq 0){'REPL_OK'}else{'REPL_FEHLER'}"`;
    expect(pruefbefehlFehler(realfall)).toMatch(/powershell-Aufruf.*windows_ad/);
    expect(pruefbefehlFehler('(Get-DnsClientServerAddress -AddressFamily IPv4 | Where-Object {$_.ServerAddresses.Count -gt 0}).ServerAddresses')).toBeDefined();
    expect(pruefbefehlFehler('Get-ADReplicationFailure -Target dc02')).toMatch(/nicht erlaubt|nicht im Lese-Käfig/);
    for (const ok of ['Get-Service -Name sshd', 'Get-Service -Name NTDS | Select-Object -Property Status', 'Get-DnsClientServerAddress -AddressFamily IPv4']) expect(pruefbefehlFehler(ok), ok).toBeUndefined();
    expect(pruefbefehlFehler('cat /etc/os-release')).toBeUndefined();
    expect(pruefbefehlFehler("grep -c Content-Type /etc/nginx/nginx.conf")).toBeUndefined();
  });
});

// v1783 — Realfall 10.11. (I8c D 12d82a15): DNS-Proben als lesende Aktion statt Resolve-DnsName-Prüfbefehl
describe('v1783 windows_ad dns_aufloesen', () => {
  it('lesend auch außerhalb eines Changes, über Server oder eigenen Resolver, prüfbarer Wortlaut', async () => {
    const aufrufe: string[] = [];
    const antwort = (b: string) => Buffer.from(b, 'base64').toString('utf16le');
    const skill = new WindowsAdSkill({ skript: async (_z, befehl) => { const t = antwort(befehl.split(' ').pop()!); aufrufe.push(t); return { code: 0, stderr: '', stdout: t.includes('10.203.29.3') ? 'ALFRED-AD {"adressen":["10.203.29.30"]}' : 'ALFRED-AD {"adressen":[],"fehler":"DNS name does not exist"}' }; } });
    const r = await skill.execute({ action: 'dns_aufloesen', zugang: 'probe-win25b', fqdn: 'alfred-ausfall-20261108.ad.3033.at', server: '10.203.29.3' }, {} as never);
    expect(r.error).toBeUndefined();
    expect(r.display).toBe('alfred-ausfall-20261108.ad.3033.at → 10.203.29.30 (über 10.203.29.3)');
    const n = await skill.execute({ action: 'dns_aufloesen', zugang: 'probe-win25b', fqdn: 'alfred-ausfall-20261108.ad.3033.at', ohne_cache: true }, {} as never);
    expect(n.display).toContain('keine A-Antwort über den eigenen Resolver');
    expect(n.display).not.toContain('10.203.29.30');
    expect(aufrufe[1]).toContain('Clear-DnsClientCache');
    expect((await skill.execute({ action: 'dns_aufloesen', zugang: 'probe-win25b', fqdn: 'x', server: '1.2.3.4' }, {} as never)).error).toContain('fqdn');
    expect(aktionsArt('windows_ad', 'dns_aufloesen')).toBe('lesen');
  });
});
