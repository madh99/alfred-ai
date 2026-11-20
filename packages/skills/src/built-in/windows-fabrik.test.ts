import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evalLinks, buildAusUrl, neuesteVirtio, isoDateiname, waehleAbbild, autounattend, sysprepUnattend, setupSkript, windowsBenutzerDaten, WIN_EINRICHTUNG_NACHHOLEN,
  windowsBauKonfig, knotenJson, zufallsKennwort, serverSeiten, WIN_ISO_URL, VIRTIO_URL, CLOUDBASE_URL, CLOUDBASE_CONF, KNOTEN_INSPEKTION, KNOTEN_ANTWORT_ISO, type WimAbbild,
  medienPsPruefung, medienPruefSkript, bewerteMedienpruefung, medienAusBeschreibung, MEDIEN_DATEI, MEDIEN_MARKE, VIRTIO_SYS_PFLICHT,
  WIN_VARIANTEN, virtioOrdner, WIN11_PRO_GVLK, lizenzHinweis, win11ProIso, SETUP_STATUS_DATEI, OPENSSH_ZEITLIMIT_S, BOOT_TASTEN,
} from './windows-fabrik.js';

// Echte Anker aus dem Evaluation Center (01.11.2026)
const a = (label: string, href: string) => `<a data-bi-cn="64-bit edition" data-bi-tags="{&#34;BiLinkName&#34;:&#34;x&#34;}" data-target="${href.replace(/&/g, '&amp;')}" aria-label="${label}" target="_blank" href="${href}">`;
const SERVER = [
  a('64-bit edition : Download Windows Server 2025 Preview ISO 64-bit (en-US)', 'https://go.microsoft.com/fwlink/?linkid=2345730&clcid=0x409&culture=en-us&country=us'),
  a('64-bit edition : Download Windows Server 2025 Preview VHD 64-bit (en-US)', 'https://go.microsoft.com/fwlink/?linkid=2345826&clcid=0x409&culture=en-us&country=us'),
  a('64-bit edition : Download Windows Server 2025 Preview ISO 64-bit (de-DE)', 'https://go.microsoft.com/fwlink/?linkid=2345827&clcid=0x409&culture=en-us&country=us'),
].join('\n');
const WIN11 = [
  a('64-bit edition: Download Windows 11 Enterprise ISO 64-bit (en-US)', 'https://go.microsoft.com/fwlink/?LinkId=2382600&clcid=0x409&culture=en-us&country=us'),
  a('Download Windows 11 Enterprise ISO LTSC 64-bit (en-US)', 'https://go.microsoft.com/fwlink/?linkid=2289029&clcid=0x409&culture=en-us&country=us'),
  a('64-bit edition: Download Windows 11 Enterprise ISO 64-bit (de-DE)', 'https://go.microsoft.com/fwlink/?LinkId=2382603&clcid=0x409&culture=en-us&country=us'),
].join('\n');

const SCHL = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK9nC0Sx0V1i7cVh2Hj8b6vY0Gm8L5H8p3rQ1u2w3x4y alfred@server';
const PRIV = `-----BEGIN OPENSSH PRIVATE KEY-----\n${'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW'.repeat(3)}\n-----END OPENSSH PRIVATE KEY-----\n`;
const KW = 'Al-abcdefghijkmnopqrstuvwx9a';

describe('I8a Windows-Vorlagen-Fabrik', () => {
  it('Evaluation Center: ISO-Links je Sprache, ohne VHD und LTSC', () => {
    expect(evalLinks(SERVER, 'server')).toEqual([
      { sprache: 'en-us', fwlink: 'https://go.microsoft.com/fwlink/?linkid=2345730&clcid=0x409&culture=en-us&country=us', version: '2025' },
      { sprache: 'de-de', fwlink: 'https://go.microsoft.com/fwlink/?linkid=2345827&clcid=0x409&culture=en-us&country=us', version: '2025' },
    ]);
    expect(evalLinks(WIN11, 'win11').map(x => [x.sprache, x.fwlink.includes('2382600') || x.fwlink.includes('2382603')])).toEqual([['en-us', true], ['de-de', true]]);
    expect(serverSeiten(new Date('2026-11-01')).map(s => s.version)).toEqual(['2027', '2026', '2025']);
  });

  it('feste Herkunft, Buildnummer und Dateinamen', () => {
    const url = 'https://software-static.download.prss.microsoft.com/dbazure/998969d5-f34g-4e03-ac9d-1f9786c66749/26100.32230.260111-0550.lt_release_svc_refresh_SERVER_EVAL_x64FRE_en-us.iso';
    expect(WIN_ISO_URL.test(url)).toBe(true);
    expect(WIN_ISO_URL.test('https://example.com/x.iso')).toBe(false);
    expect(buildAusUrl(url)).toBe('26100.32230');
    expect(buildAusUrl('https://software-static.download.prss.microsoft.com/dbazure/26300.9457.260913-1737.26h2_ge_release_svc_refresh_CLIENTENTERPRISEEVAL_OEMRET_x64FRE_en-us.iso')).toBe('26300.9457');
    expect(isoDateiname('server', '2025', '26100.32230', 'en-us')).toBe('win-server-2025-eval-26100.32230-en-us.iso');
    const v = neuesteVirtio('<a href="virtio-win-0.1.271-1/">x</a><a href="virtio-win-0.1.302-1/">y</a><a href="virtio-win-0.1.285-1/">z</a>');
    expect(v).toEqual({ version: '0.1.302-1', url: 'https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/archive-virtio/virtio-win-0.1.302-1/virtio-win-0.1.302.iso' });
    expect(VIRTIO_URL.test(v!.url)).toBe(true);
    expect(CLOUDBASE_URL.exec('https://github.com/cloudbase/cloudbase-init/releases/download/1.1.9/CloudbaseInitSetup_1_1_9_x64.msi')?.[1]).toBe('1.1.9');
  });

  it('Abbild nach Edition und Ausprägung', () => {
    const bilder: WimAbbild[] = [
      { index: 1, name: 'Windows Server 2025 Standard Evaluation', editionId: 'ServerStandardEval', installationType: 'Server Core' },
      { index: 2, name: 'Windows Server 2025 Standard Evaluation (Desktop Experience)', editionId: 'ServerStandardEval', installationType: 'Server' },
      { index: 3, name: 'Windows Server 2025 Datacenter Evaluation', editionId: 'ServerDatacenterEval', installationType: 'Server Core' },
      { index: 4, name: 'Windows Server 2025 Datacenter Evaluation (Desktop Experience)', editionId: 'ServerDatacenterEval', installationType: 'Server' },
    ];
    expect(waehleAbbild(bilder, 'server-standard-core')?.index).toBe(1);
    expect(waehleAbbild(bilder, 'server-standard-desktop')?.index).toBe(2);
    expect(waehleAbbild(bilder, 'server-datacenter-core')?.index).toBe(3);
    expect(waehleAbbild(bilder, 'server-datacenter-desktop')?.index).toBe(4);
    expect(waehleAbbild([{ index: 1, name: 'Windows 11 Enterprise Evaluation', editionId: 'EnterpriseEval', installationType: 'Client' }], 'win11')?.index).toBe(1);
    expect(waehleAbbild(bilder, 'win11')).toBeUndefined();
  });

  it('Antwortdateien: Index, Konto alfred, Server mit Administrator-Kennwort, Windows 11 mit Prozessor-Ausnahme und ohne Geräteverschlüsselung', () => {
    const s = autounattend({ variante: 'server-standard-core', index: 1, regional: { sprache: 'en-us' }, computer: 'WINTPL-9100', kennwort: KW });
    expect(s).toContain('<Key>/IMAGE/INDEX</Key><Value>1</Value>');
    expect(s).toContain('<UILanguage>en-US</UILanguage>');
    expect(s).toContain('<AdministratorPassword>');
    expect(s).toContain('<Name>alfred</Name><Group>Administrators</Group>');
    expect(s).not.toContain('BypassCPUCheck');
    const w = autounattend({ variante: 'win11', index: 3, regional: { sprache: 'de-de' }, computer: 'WIN11TPL', kennwort: KW });
    expect(w).toContain('BypassCPUCheck');
    expect(w).toContain('PreventDeviceEncryption');
    expect(w).not.toContain('<AdministratorPassword>');
    expect(() => autounattend({ variante: 'win11', index: 1, regional: { sprache: 'en-us' }, computer: 'viel-zu-langer-name', kennwort: KW })).toThrow();
    expect(() => autounattend({ variante: 'win11', index: 1, regional: { sprache: 'en-us' }, computer: 'X', kennwort: 'kurz' })).toThrow();
    const sp = sysprepUnattend({ variante: 'server-datacenter-core', regional: { sprache: 'en-us' }, kennwort: KW });
    expect(sp).toContain('cloudbase-init-unattend.conf');
    expect(sp).toContain('&amp;&amp; exit 1 || exit 2');
    expect(CLOUDBASE_CONF).toContain('UserDataPlugin');
  });

  it('Einrichtungsskript endet mit sysprep, entfernt Host-Schlüssel und Kennwörter', () => {
    const t = setupSkript({ variante: 'win11' });
    expect(t).toContain('virtio-win-guest-tools.exe');
    expect(t).toContain('OpenSSH.Server');
    expect(t).toContain('Remove-Item "C:\\Windows\\Panther\\unattend.xml"');
    expect(t).toContain('ssh_host_*');
    expect(t.trim().split('\r\n').pop()).toMatch(/sysprep\.exe" \/generalize \/oobe \/shutdown/);
    expect(t).toContain('AutoDownload');
    expect(setupSkript({ variante: 'server-standard-core' })).not.toContain('AutoDownload');
  });

  it('Benutzerdaten je Klon: Host-Schlüssel, Anmeldeschlüssel, Kennwort, Cloudbase-Init danach aus; nichts Ungeprüftes', () => {
    const u = windowsBenutzerDaten({ variante: 'server-standard-core', hostname: 'probe-win25', alfredSchluessel: SCHL, hostPrivat: PRIV, hostOeffentlich: SCHL, kennwort: KW });
    expect(u.startsWith('#ps1_sysnative')).toBe(true);
    expect(u).toContain('administrators_authorized_keys');
    expect(u).toContain('Set-LocalUser -Name Administrator');
    expect(u).toContain('Set-Service -Name cloudbase-init -StartupType Disabled');
    // Realfall probe-win25 (01.11.): Name aus den Benutzerdaten, SSH in allen Profilen, Wiederholung bis die Kontenverwaltung bereit ist
    expect(u).toContain("if ($env:COMPUTERNAME -ne 'PROBE-WIN25') { Rename-Computer -NewName 'probe-win25' -Force;");
    expect(u).toContain('exit 1001');
    expect(u).toContain('-Profile Any');
    expect(u).toMatch(/for \(\$i = 0; \$i -lt 30 -and -not \$ok; \$i\+\+\) \{ try \{ Einrichten/);
    expect(u).toContain('if (-not $ok) { exit 1003 }');
    expect(setupSkript({ variante: 'server-standard-core' })).toContain('-Profile Any');
    // v1745 — eigener Zugang des Owners: Konto als Administrator, idempotent; RDP nur auf Wunsch, mit NLA
    const mitOwner = windowsBenutzerDaten({ variante: 'server-standard-core', hostname: 'probe-win25', alfredSchluessel: SCHL, weitereSchluessel: [SCHL], hostPrivat: PRIV, hostOeffentlich: SCHL, kennwort: KW, ownerKonto: { name: 'madh', kennwort: KW }, rdp: true });
    expect(mitOwner).toContain("New-LocalUser -Name 'madh'");
    expect(mitOwner).toContain("Where-Object { $_.Name -like '*\\madh' }");
    expect(mitOwner).toContain('Add-LocalGroupMember -SID S-1-5-32-544');
    expect(mitOwner).toContain('fDenyTSConnections -Value 0');
    expect(mitOwner).toContain('UserAuthentication -Value 1');
    expect(u).not.toContain('fDenyTSConnections');
    expect(() => windowsBenutzerDaten({ variante: 'win11', hostname: 'x1', alfredSchluessel: SCHL, hostPrivat: PRIV, hostOeffentlich: SCHL, kennwort: KW, ownerKonto: { name: 'administrator', kennwort: KW } })).toThrow();
    expect(() => windowsBenutzerDaten({ variante: 'win11', hostname: 'x1', alfredSchluessel: SCHL, hostPrivat: PRIV, hostOeffentlich: SCHL, kennwort: KW, ownerKonto: { name: "m'; x", kennwort: KW } })).toThrow();
    expect(() => windowsBenutzerDaten({ variante: 'win11', hostname: 'viel-zu-langer-name', alfredSchluessel: SCHL, hostPrivat: PRIV, hostOeffentlich: SCHL, kennwort: KW })).toThrow();
    expect(windowsBenutzerDaten({ variante: 'win11', hostname: 'win11-test', alfredSchluessel: SCHL, hostPrivat: PRIV, hostOeffentlich: SCHL, kennwort: KW })).not.toContain('Name Administrator');
    expect(() => windowsBenutzerDaten({ variante: 'win11', hostname: 'win11-test', alfredSchluessel: "ssh-ed25519 x'; rm", hostPrivat: PRIV, hostOeffentlich: SCHL, kennwort: KW })).toThrow();
    expect(() => windowsBenutzerDaten({ variante: 'win11', hostname: 'win11-test', alfredSchluessel: SCHL, hostPrivat: PRIV, hostOeffentlich: SCHL, kennwort: "x'; Remove-Item C:\\ -Recurse #aaaaaaaa" })).toThrow();
  });

  it('Bau-VM: UEFI mit Microsoft-Schlüsseln, TPM 2.0, drei CDs, feste Maschinenversion', () => {
    const k = windowsBauKonfig({ vmid: 9100, name: 'win-tpl', storage: 'nvme-cs001', windowsIso: 'local:iso/win-server-2025-eval-26100.32230-en-us.iso', virtioIso: 'local:iso/virtio-win-0.1.302.iso', antwortIso: 'local:iso/alfred-antwort-9100.iso', machine: 'pc-q35-9.2' });
    expect(k).toMatchObject({ bios: 'ovmf', machine: 'pc-q35-9.2', ostype: 'win11', efidisk0: 'nvme-cs001:1,efitype=4m,pre-enrolled-keys=1', tpmstate0: 'nvme-cs001:1,version=v2.0', boot: 'order=scsi0;ide2' });
    expect(() => windowsBauKonfig({ vmid: 1, name: 'x', storage: 's', windowsIso: 'local:iso/../x.iso', virtioIso: 'local:iso/v.iso', antwortIso: 'local:iso/a.iso' })).toThrow();
    expect(() => windowsBauKonfig({ vmid: 1, name: 'x', storage: 's', windowsIso: 'local:iso/w.iso', virtioIso: 'local:iso/v.iso', antwortIso: 'local:iso/a.iso', machine: 'q35;rm' })).toThrow();
  });

  it('Knoten-Skripte und Hilfen', () => {
    expect(KNOTEN_INSPEKTION).toContain("b'MSWIM\\0\\0\\0'");
    expect(KNOTEN_ANTWORT_ISO).toContain("'$WinPEDriver$'");
    expect(knotenJson<{ a: number }>('Rauschen\nALFRED_JSON {"a":1}\n')).toEqual({ a: 1 });
    expect(() => knotenJson('nichts')).toThrow();
    const k = zufallsKennwort(n => new Uint8Array(n).map((_x, i) => i * 7));
    expect(k).toMatch(/^[A-Za-z0-9_.+-]{16,64}$/);
    expect(k).toMatch(/[A-Z]/); expect(k).toMatch(/[a-z]/); expect(k).toMatch(/\d/);
  });
});

// v1747 — Realfall probe-win25b: Benutzerdaten beim ersten Start mit Exit 1 abgebrochen, Cloudbase-Init wiederholt nicht
describe('I8 Einrichtung über den Gast-Agenten nachholen', () => {
  it('nur wenn nötig, ohne Datei, ohne Inhalt in der Ausgabe, Neustart nur bei 1001', () => {
    const t = WIN_EINRICHTUNG_NACHHOLEN;
    expect(t).toContain("StartType -eq 'Disabled') { 'NACHHOLEN_UNNOETIG");
    expect(t).toContain('@(0, 1001, 1003) -contains $alt');
    expect(t).toContain("'-EncodedCommand', $b");
    expect(t).not.toMatch(/Set-Content|Out-File|WriteAllText|Copy-Item/);
    // gelesen, geprüft, kodiert — die Benutzerdaten (mit Kennwörtern) werden nie ausgegeben
    expect(t.match(/\$t\b/g)).toEqual(['$t', '$t', '$t']);
    expect(t).toContain('GetBytes($t)');
    expect(t).toContain("if ($c -eq 1001) { shutdown.exe /r");
  });
});

// ── Ruling R35 (I8e L6): Medienprüfung im Gast (vor sysprep und lesend) ──────────────────────────────────────────────────────────
const MS = 'CN=Microsoft Windows, O=Microsoft Corporation, L=Redmond, S=Washington, C=US';
const WHCP = 'CN=Microsoft Windows Hardware Compatibility Publisher, O=Microsoft Corporation, L=Redmond, S=Washington, C=US';
const CB = 'CN=Cloudbase Solutions Srl, O=Cloudbase Solutions Srl, L=Timisoara, C=RO';
const e = (datei: string, signer: string, status = 'Valid') => ({ datei, status, signer });
function medienJson(o: { kern?: boolean; installationType?: string; secureBoot?: boolean; ohne?: string[]; virtioSigner?: string; cbSigner?: string; system?: unknown; fehler?: string[] } = {}): string {
  const sys = ['C:\\Windows\\System32\\ntoskrnl.exe', 'C:\\Windows\\System32\\winload.efi', 'C:\\Windows\\System32\\ci.dll', 'C:\\Windows\\System32\\kernel32.dll', ...(o.kern ? [] : ['C:\\Windows\\explorer.exe'])]
    .filter(d => !(o.ohne ?? []).some(x => d.toLowerCase().endsWith(x)));
  const vio = ['vioscsi', 'netkvm', 'vioser', 'pvpanic'].filter(t => !(o.ohne ?? []).includes(`${t}.sys`)).map(t => e(`C:\\Windows\\System32\\drivers\\${t}.sys`, o.virtioSigner ?? WHCP));
  const fehler = o.fehler ?? [];
  return JSON.stringify({
    version: 1, ok: fehler.length === 0, installationType: o.installationType ?? (o.kern ? 'Server Core' : 'Client'), secureBoot: o.secureBoot ?? true,
    system: o.system ?? sys.map(d => e(d, MS)), virtio: vio, cloudbase: [e('E:\\CloudbaseInitSetup_x64.msi', o.cbSigner ?? CB)], fehler,
  });
}

describe('Ruling R35 (I8e L6) — Medienprüfung', () => {
  it('Einrichtungsskript: Cloudbase-MSI vor msiexec geprüft, Gesamtprüfung nach dem Aufräumen, sysprep erst nach Abholung', () => {
    for (const v of ['win11', 'server-standard-core', 'server-standard-desktop'] as const) {
      const t = setupSkript({ variante: v });
      const msi = t.indexOf('Signatur "$antwort\\CloudbaseInitSetup_x64.msi"');
      expect(msi).toBeGreaterThan(0);
      expect(msi).toBeLessThan(t.indexOf('msiexec.exe'));
      // fail-closed: bei Fehlschlag Ergebnis schreiben und ohne Installation enden
      expect(t.slice(msi, t.indexOf('msiexec.exe'))).toContain('MpFehlschlag');
      const pruef = t.indexOf('Confirm-SecureBootUEFI');
      expect(pruef).toBeGreaterThan(t.indexOf('Marke "Aufraeumen"'));
      expect(t.indexOf(medienPsPruefung())).toBeGreaterThan(0);
      expect(t).toContain(MEDIEN_DATEI);
      const warten = t.indexOf(`Test-Path -LiteralPath $mpAbgeholt`);
      expect(warten).toBeGreaterThan(pruef);
      expect(warten).toBeLessThan(t.indexOf('sysprep.exe'));
      expect(t.trim().split('\r\n').pop()).toMatch(/sysprep\.exe" \/generalize \/oobe \/shutdown/);
    }
  });

  it('feste Listen: Kernsystemdateien, explorer.exe nur außerhalb von Server Core, VirtIO-Pflichttreiber', () => {
    const p = medienPsPruefung();
    for (const d of ['ntoskrnl.exe', 'winload.efi', 'ci.dll', 'kernel32.dll']) expect(p).toContain(`C:\\Windows\\System32\\${d}`);
    expect(p).toContain('if ($mp.installationType -ne "Server Core") { $sys += "C:\\Windows\\explorer.exe" }');
    expect(setupSkript({ variante: 'win11' })).toContain('Get-AuthenticodeSignature -LiteralPath $pfad');
    expect(VIRTIO_SYS_PFLICHT).toEqual(['vioscsi', 'netkvm', 'vioser']);
  });

  it('lesende Prüfung: gleiche Prüflogik, Cloudbase-Init installiert statt MSI, Ausgabe statt Datei', () => {
    const t = medienPruefSkript();
    expect(t).toContain(medienPsPruefung());
    expect(t).toContain('Win32_Service');
    expect(t).toContain('LocalPackage');
    expect(t).not.toContain('CloudbaseInitSetup_x64.msi');
    expect(t).not.toMatch(/WriteAllText|Set-Content|Out-File|sysprep/);
    expect(t).toContain('"ALFRED_MEDIEN "');
  });

  it('Bewertung: bestanden mit fester Zeile; Server Core ohne explorer.exe', () => {
    const ok = bewerteMedienpruefung(medienJson(), 'win11-tpl', 'win11');
    expect(ok.fehler).toEqual([]);
    expect(ok.ok).toBe(true);
    expect(ok.zeile).toBe('MEDIEN_SIGNIERT win11-tpl: Secure Boot an, 5 Systemdateien Microsoft-signiert, VirtIO 4 signiert, Cloudbase-Init signiert');
    const kern = bewerteMedienpruefung(medienJson({ kern: true }), 'win-core', 'server-standard-core');
    expect(kern.ok).toBe(true);
    expect(kern.zeile).toContain('4 Systemdateien');
    // Sicherheitsprüfung: ohne Variante zählt die Selbstauskunft „Server Core“ nicht — explorer.exe bleibt Pflicht
    expect(bewerteMedienpruefung(medienJson({ kern: true }), 'x').ok).toBe(false);
    // Red-Hat-signierte VirtIO-Treiber zählen auch
    expect(bewerteMedienpruefung(medienJson({ virtioSigner: 'CN=Red Hat, Inc., O="Red Hat, Inc.", L=Raleigh, S=North Carolina, C=US' }), 'x', 'win11').ok).toBe(true);
  });

  it('Bewertung fail-closed: jede Lücke ist ein Fehlschlag', () => {
    const nein = (roh: string | undefined, v?: Parameters<typeof bewerteMedienpruefung>[2]) => { const r = bewerteMedienpruefung(roh, 'x', v); expect(r.ok).toBe(false); expect(r.zeile.startsWith('MEDIEN_NICHT_BELEGT x: ')).toBe(true); return r.zeile; };
    expect(nein(undefined)).toContain('kein Ergebnis');
    expect(nein('{kaputt')).toContain('unlesbar');
    expect(nein(medienJson({ secureBoot: false }), 'win11')).toContain('Secure Boot');
    expect(nein(medienJson({ ohne: ['explorer.exe'] }), 'server-standard-desktop')).toContain('explorer.exe');
    expect(nein(medienJson({ kern: true }), 'server-standard-desktop')).toContain('explorer.exe');
    expect(nein(medienJson({ ohne: ['vioscsi.sys'] }), 'win11')).toContain('vioscsi.sys');
    expect(nein(medienJson({ virtioSigner: 'CN=Irgendwer, O=Irgendwer' }), 'win11')).toContain('netkvm.sys');
    expect(nein(medienJson({ cbSigner: 'CN=Cloudbase Solutions Srl' }), 'win11')).toContain('Cloudbase-Init');
    expect(nein(medienJson({ system: [e('C:\\Windows\\System32\\ntoskrnl.exe', MS, 'HashMismatch')] }), 'win11')).toContain('ntoskrnl.exe');
    expect(nein(medienJson({ fehler: ['Gast meldet etwas'] }), 'win11')).toContain('Gast meldet etwas');
    expect(nein(medienJson({ kern: true }), 'win11')).toContain('Installationsart');
  });

  it('Ergebnis in der Beschreibung der Bau-VM wiederfinden', () => {
    const d = `Windows-Vorlage von Alfred (I8a): win11, gebaut 2026-11-20\n${MEDIEN_MARKE}${medienJson()}`;
    expect(medienAusBeschreibung(d)).toBe(medienJson());
    expect(medienAusBeschreibung('Windows-Vorlage von Alfred (I8a): win11, x')).toBeUndefined();
  });

  it('Sicherheitsprüfung: eingeschleuste zweite Ergebniszeile ist mehrdeutig → nicht belegt', () => {
    const echt = `${MEDIEN_MARKE}${medienJson()}`;
    const doppelt = `Windows-Vorlage von Alfred (I8a): win11\n${echt}\n${MEDIEN_MARKE}${medienJson()}`;
    expect(bewerteMedienpruefung(medienAusBeschreibung(doppelt), 'v', 'win11').ok).toBe(false);
    const nichtLetzte = `Windows-Vorlage von Alfred (I8a): win11\n${echt}\nweiterer Text`;
    expect(bewerteMedienpruefung(medienAusBeschreibung(nichtLetzte), 'v', 'win11').ok).toBe(false);
  });

  it('Sicherheitsprüfung: ohne Variante verkürzt „Server Core“ die Pflichtliste nicht (explorer.exe bleibt Pflicht)', () => {
    const r = bewerteMedienpruefung(medienJson({ kern: true }), 'v');
    expect(r.ok).toBe(false);
    expect(r.zeile).toContain('explorer.exe');
  });
});

// Ruling R35 (I8e L6) — beide Skripte mit der Medienprüfung parsen in Windows PowerShell 5.1 (ohne PowerShell übersprungen)
const psDa = (() => { const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' }); return r.status === 0; })();
describe.skipIf(!psDa)('Ruling R35 (I8e L6) — PowerShell-Parser', () => {
  it('Einrichtungsskript (alle Varianten) und lesende Prüfung sind gültiges PowerShell; Gegenprobe erkannt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alfred-r35-'));
    try {
      const skripte: Record<string, string> = { lesend: medienPruefSkript(), gegenprobe: 'if ($a -eq { "x" ' };
      for (const v of ['win11', 'server-standard-core', 'server-standard-desktop'] as const) skripte[v] = setupSkript({ variante: v });
      for (const [n, t] of Object.entries(skripte)) writeFileSync(join(dir, `${n}.ps1`), `${String.fromCharCode(0xfeff)}${t}`, 'utf8');
      const pruef = `Get-ChildItem -LiteralPath '${dir}' -Filter *.ps1 | ForEach-Object { $t = $null; $f = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$t, [ref]$f); "$($_.BaseName)=$(if ($f.Count) { ($f | ForEach-Object { $_.Message }) -join ' | ' } else { 'OK' })" }`;
      const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', pruef], { encoding: 'utf8' });
      const aus = Object.fromEntries(String(r.stdout).trim().split(/\r?\n/).map(z => [z.split('=')[0], z.slice(z.indexOf('=') + 1)]));
      expect(aus.gegenprobe).not.toBe('OK');
      for (const n of Object.keys(skripte).filter(x => x !== 'gegenprobe')) expect(aus[n], n).toBe('OK');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ── Ruling R36 (I8e L6): Windows 11 Pro als eigene Variante neben Windows 11 Enterprise Evaluation ───────────────────────────────
describe('Ruling R36 (I8e L6) — Variante win11-pro', () => {
  // EDITIONID-Werte eines Windows-11-Mehrfach-Edition-ISO (Win11_<Version>_<Sprache>_x64.iso)
  const verbraucher: WimAbbild[] = [
    ['Windows 11 Home', 'Core'], ['Windows 11 Home N', 'CoreN'], ['Windows 11 Home Single Language', 'CoreSingleLanguage'], ['Windows 11 Education', 'Education'],
    ['Windows 11 Education N', 'EducationN'], ['Windows 11 Pro', 'Professional'], ['Windows 11 Pro N', 'ProfessionalN'], ['Windows 11 Pro Education', 'ProfessionalEducation'],
    ['Windows 11 Pro Education N', 'ProfessionalEducationN'], ['Windows 11 Pro for Workstations', 'ProfessionalWorkstation'], ['Windows 11 Pro N for Workstations', 'ProfessionalWorkstationN'],
  ].map(([name, editionId], i) => ({ index: i + 1, name: name!, editionId: editionId!, installationType: 'Client' }));

  it('Variante bekannt, Abbild genau „Professional“, Treiber wie Windows 11', () => {
    expect(WIN_VARIANTEN).toContain('win11-pro');
    expect(WIN_VARIANTEN).toContain('win11');
    expect(waehleAbbild(verbraucher, 'win11-pro')?.index).toBe(6);
    expect(waehleAbbild(verbraucher.filter(a => a.editionId !== 'Professional'), 'win11-pro')).toBeUndefined();
    expect(waehleAbbild(verbraucher, 'win11')).toBeUndefined();
    expect(waehleAbbild([{ index: 1, name: 'Windows 11 Enterprise Evaluation', editionId: 'EnterpriseEval', installationType: 'Client' }], 'win11-pro')).toBeUndefined();
    expect(virtioOrdner('win11-pro')).toEqual(['w11', 'w10']);
  });

  it('Windows-11-Sonderfälle gelten für beide Varianten; nur Pro bekommt den KMS-Client-Schlüssel (GVLK)', () => {
    const p = autounattend({ variante: 'win11-pro', index: 6, regional: { sprache: 'de-de' }, computer: 'WIN-9111', kennwort: KW });
    expect(p).toContain('BypassCPUCheck');
    expect(p).toContain('PreventDeviceEncryption');
    expect(p).not.toContain('<AdministratorPassword>');
    expect(WIN11_PRO_GVLK).toBe('W269N-WFGWX-YVC9B-4J6C9-T83GX');
    expect(p).toContain(`<ProductKey><Key>${WIN11_PRO_GVLK}</Key><WillShowUI>OnError</WillShowUI></ProductKey>`);
    expect(autounattend({ variante: 'win11', index: 3, regional: { sprache: 'de-de' }, computer: 'WIN-9110', kennwort: KW })).not.toContain('<ProductKey>');
    expect(sysprepUnattend({ variante: 'win11-pro', regional: { sprache: 'de-de' }, kennwort: KW })).not.toContain('AdministratorPassword');
    expect(setupSkript({ variante: 'win11-pro' })).toContain('AutoDownload');
    expect(windowsBenutzerDaten({ variante: 'win11-pro', hostname: 'w11pro', alfredSchluessel: SCHL, hostPrivat: PRIV, hostOeffentlich: SCHL, kennwort: KW })).not.toContain('Name Administrator');
  });

  it('Lizenzhinweis: Pro unaktiviert, Enterprise Evaluation bleibt 90 Tage', () => {
    expect(lizenzHinweis('win11-pro')).toBe('Pro unaktiviert — Aktivierung braucht eine eigene Lizenz (KMS/MAK/Retail)');
    expect(lizenzHinweis('win11')).toContain('90 Tage');
    expect(lizenzHinweis('server-standard-core')).toContain('180 Tage');
  });

  it('ISO und Sprache für Pro: Microsoft-Dateiname oder umbenannt, Sprache aus Name oder Angabe, nichts geraten', () => {
    expect(win11ProIso('local:iso/Win11_25H2_German_x64.iso')).toEqual({ sprache: 'de-de' });
    expect(win11ProIso('local:iso/Win11_24H2_English_x64v2.iso')).toEqual({ sprache: 'en-us' });
    expect(win11ProIso('local:iso/Win11_24H2_EnglishInternational_x64.iso')).toEqual({ sprache: 'en-gb' });
    expect(win11ProIso('local:iso/Win11_25H2_German_x64.iso', 'de-de')).toEqual({ sprache: 'de-de' });
    expect(win11ProIso('local:iso/win11-pro-25h2-de-de.iso')).toEqual({ sprache: 'de-de' });
    expect(win11ProIso('local:iso/Win11_25H2_French_x64.iso', 'fr-fr')).toEqual({ sprache: 'fr-fr' });
    expect('fehler' in win11ProIso('local:iso/Win11_25H2_French_x64.iso')).toBe(true);
    expect(win11ProIso('local:iso/Win11_25H2_German_x64.iso', 'en-us')).toMatchObject({ fehler: expect.stringContaining('widerspricht') });
    expect('fehler' in win11ProIso('local:iso/win11-enterprise-eval-26100.1-en-us.iso')).toBe(true);
    expect('fehler' in win11ProIso('local:iso/win-server-2025-eval-26100.1-en-us.iso')).toBe(true);
    expect('fehler' in win11ProIso('local:iso/Win11_25H2_German_x64.iso', 'deutsch')).toBe(true);
    expect('fehler' in win11ProIso('local:iso/../Win11_25H2_German_x64.iso')).toBe(true);
    // die Bau-VM nimmt den Microsoft-Dateinamen an
    expect(windowsBauKonfig({ vmid: 9111, name: 'w11pro', storage: 'nvme-cs001', windowsIso: 'local:iso/Win11_25H2_German_x64.iso', virtioIso: 'local:iso/virtio-win-0.1.302.iso', antwortIso: 'local:iso/alfred-antwort-9111.iso' }).ide2).toBe('local:iso/Win11_25H2_German_x64.iso,media=cdrom');
  });

  it('R35 gilt auch für win11-pro (explorer.exe Pflicht, Installationsart Client)', () => {
    expect(bewerteMedienpruefung(medienJson(), 'w11pro', 'win11-pro').ok).toBe(true);
    expect(bewerteMedienpruefung(medienJson({ ohne: ['explorer.exe'] }), 'w11pro', 'win11-pro').ok).toBe(false);
  });
});

describe('Ruling R37 (I8e L6): Bau ohne Hänger', () => {
  it('Enter nur im Fenster der Boot-Abfrage (höchstens 15 s), nicht mehr 30 s lang', () => {
    expect(BOOT_TASTEN.anzahl * BOOT_TASTEN.abstandMs).toBeLessThanOrEqual(15_000);
    expect(BOOT_TASTEN.anzahl * BOOT_TASTEN.abstandMs).toBeGreaterThanOrEqual(8_000);
  });
  it('Marken gehen zusätzlich zeilenweise in die Statusdatei — auch die Fehler aus trap und Medienprüfung', () => {
    for (const v of WIN_VARIANTEN) {
      const t = setupSkript({ variante: v });
      expect(t).toContain(`$alfredStatus = "${SETUP_STATUS_DATEI}"`);
      expect(SETUP_STATUS_DATEI).toBe(String.raw`C:\Windows\Temp\alfred-setup-status.log`);
      expect(t).toContain('Add-Content -LiteralPath $alfredStatus');
      expect(t.indexOf('function Marke')).toBeLessThan(t.indexOf('trap {'));
      expect(t).not.toContain('Write-Output "ALFRED: FEHLER');
      expect(t).toContain('trap { Marke "FEHLER');
      expect(t).toContain('Marke "MEDIENPRUEFUNG_FEHLER');
    }
  });
  it('OpenSSH aus Windows Update mit Zeitlimit — Zeitüberschreitung ist ein Fehler vor sysprep', () => {
    const t = setupSkript({ variante: 'win11' });
    expect(t).toContain(`Wait-Job -Job $job -Timeout ${OPENSSH_ZEITLIMIT_S}`);
    expect(t).toMatch(/Stop-Job -Job \$job; throw "OpenSSH-Server/);
    expect(t.indexOf('Wait-Job')).toBeLessThan(t.indexOf('sysprep.exe'));
    // nur ASCII in den Marken (PowerShell 5.1 liest die Datei ohne BOM als ANSI)
    expect(t).toMatch(/Marke "OpenSSH \(Windows Update, hoechstens 90 min\)"/);
  });
});
