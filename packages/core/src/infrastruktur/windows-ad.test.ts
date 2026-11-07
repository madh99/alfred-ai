import { describe, it, expect } from 'vitest';
import { adErgebnis, adStatusSkript, dcBereit, mitgliedBereit, waldSkript, dcSkript, beitrittSkript, grundstrukturSkript, sicherungSkript, papierkorbSkript, dnsEintragSkript, pruefeWald, pruefeDns, pruefeGrundstruktur, kodiert, adStatusText, type AdStatus } from './windows-ad.js';
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
    expect(dcSkript({ domaene: 'ad.3033.at', netbios: 'AD3033', dns: ['10.203.29.2'] })).toContain("($p.netbios + '\\alfred')");
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
