import { describe, expect, it } from 'vitest';
import {
  evalLinks, buildAusUrl, neuesteVirtio, isoDateiname, waehleAbbild, autounattend, sysprepUnattend, setupSkript, windowsBenutzerDaten,
  windowsBauKonfig, knotenJson, zufallsKennwort, serverSeiten, WIN_ISO_URL, VIRTIO_URL, CLOUDBASE_URL, CLOUDBASE_CONF, KNOTEN_INSPEKTION, KNOTEN_ANTWORT_ISO, type WimAbbild,
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
    const u = windowsBenutzerDaten({ variante: 'server-standard-core', alfredSchluessel: SCHL, hostPrivat: PRIV, hostOeffentlich: SCHL, kennwort: KW });
    expect(u.startsWith('#ps1_sysnative')).toBe(true);
    expect(u).toContain('administrators_authorized_keys');
    expect(u).toContain('Set-LocalUser -Name Administrator');
    expect(u).toContain('Set-Service -Name cloudbase-init -StartupType Disabled');
    expect(windowsBenutzerDaten({ variante: 'win11', alfredSchluessel: SCHL, hostPrivat: PRIV, hostOeffentlich: SCHL, kennwort: KW })).not.toContain('Name Administrator');
    expect(() => windowsBenutzerDaten({ variante: 'win11', alfredSchluessel: "ssh-ed25519 x'; rm", hostPrivat: PRIV, hostOeffentlich: SCHL, kennwort: KW })).toThrow();
    expect(() => windowsBenutzerDaten({ variante: 'win11', alfredSchluessel: SCHL, hostPrivat: PRIV, hostOeffentlich: SCHL, kennwort: "x'; Remove-Item C:\\ -Recurse #aaaaaaaa" })).toThrow();
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
