import { describe, it, expect } from 'vitest';
import { neuesterStand, imageAngabe, summeAus, pruefeDownload, vorlagenKonfig, cloudInitBenutzerDaten, snippetDatei, IMPORT_VOLUME } from './proxmox-fabrik.js';
import { ProxmoxSkill } from './proxmox.js';

// I5 — Vorlagen-Fabrik: Stände/Prüfsummen der Herausgeber, Vorlagen-Konfiguration, Cloud-Init mit eigenem Host-Schlüssel
const SHA = '04e8f2461a16a44e78a370284471f29616cdd9baf1893df25807b71f985b6c94';
const SHA512 = '16e0965312c56feb331049d45d2b1b5778f3f942a33d4300eedbb97527707f2bea87c0006f3e4cc7a25fadbff739c4e235a51fb9bcd1b66fd554f7f8e80ba45c';
const HOST_PUB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
const HOST_PRIV = `-----BEGIN OPENSSH PRIVATE KEY-----\n${'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW'.repeat(3)}\n${'QyNTUxOQAAACDjKqp5Fc65tEnRulDqKiy7Gm4B+QvaJFotHYdpfRiiZQAAAJhKqXr8Sql6'.repeat(2)}\n-----END OPENSSH PRIVATE KEY-----\n`;
const ALFRED = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE9F/SaqXPs6UnyvBdPJdi34sVHD5eepWONpDm8r9bLD alfred-fernzugriff';

describe('Stände und Prüfsummen', () => {
  it('nimmt den neuesten datierten Stand (Ubuntu inkl. Nachlieferung .1, Debian)', () => {
    expect(neuesterStand('<a href="release-20260911/"> <a href="release-20261017/"> <a href="release-20261017.1/"> <a href="release/">', 'ubuntu')).toBe('release-20261017.1');
    expect(neuesterStand('<a href="20261012-2600/"> <a href="20261021-2638/"> <a href="latest/"> <a href="daily/">', 'debian')).toBe('20261021-2638');
    expect(neuesterStand('<a href="latest/">', 'debian')).toBeUndefined();
  });
  it('liest die Summe genau der Datei mit passender Länge', () => {
    const t = `${SHA} *ubuntu-24.04-server-cloudimg-amd64.img\n${SHA.slice(0, 60)} *falsch.img\n`;
    expect(summeAus(t, 'ubuntu-24.04-server-cloudimg-amd64.img', 'sha256')).toBe(SHA);
    expect(summeAus(t, 'falsch.img', 'sha256')).toBeUndefined();
  });
  it('baut die Angabe für download_image (URL des Standes, Dateiname .qcow2)', () => {
    const u = imageAngabe('ubuntu-24.04', 'release-20261017', `${SHA} *ubuntu-24.04-server-cloudimg-amd64.img`);
    expect(u).toEqual({ distro: 'ubuntu-24.04', stand: 'release-20261017', url: 'https://cloud-images.ubuntu.com/releases/noble/release-20261017/ubuntu-24.04-server-cloudimg-amd64.img', checksum: SHA, checksum_algorithm: 'sha256', filename: 'ubuntu-24.04-20261017.qcow2' });
    const d = imageAngabe('debian-13', '20261021-2638', `${SHA512}  debian-13-genericcloud-amd64-20261021-2638.qcow2`);
    expect(d).toMatchObject({ url: 'https://cloud.debian.org/images/cloud/trixie/20261021-2638/debian-13-genericcloud-amd64-20261021-2638.qcow2', checksum_algorithm: 'sha512', filename: 'debian-13-20261021-2638.qcow2' });
    expect(imageAngabe('debian-13', '20261021-2638', 'nichts')).toHaveProperty('fehler');
    expect(pruefeDownload(u as never)).toBeUndefined();
    expect(pruefeDownload(d as never)).toBeUndefined();
  });
  it('weist fremde Herkunft, fehlende/zu kurze Prüfsumme und falsche Dateinamen ab', () => {
    const ok = { url: 'https://cloud-images.ubuntu.com/releases/noble/release-20261017/ubuntu-24.04-server-cloudimg-amd64.img', checksum: SHA, checksum_algorithm: 'sha256', filename: 'ubuntu-24.04-20261017.qcow2' };
    expect(pruefeDownload({ ...ok, url: 'https://boese.example/ubuntu.img' })).toMatch(/url/);
    expect(pruefeDownload({ ...ok, url: 'http://cloud-images.ubuntu.com/releases/noble/release-20261017/x.img' })).toMatch(/url/);
    expect(pruefeDownload({ ...ok, url: 'https://cloud-images.ubuntu.com/releases/noble/current/../x.img' })).toMatch(/url/);
    expect(pruefeDownload({ ...ok, url: 'https://cloud-images.ubuntu.com/releases/noble/../x.img' })).toMatch(/url/);
    expect(pruefeDownload({ ...ok, url: 'https://cloud-images.ubuntu.com/releases/noble/release/ubuntu-24.04-server-cloudimg-amd64.img' })).toMatch(/url/);
    expect(pruefeDownload({ ...ok, checksum: undefined })).toMatch(/checksum/);
    expect(pruefeDownload({ ...ok, checksum_algorithm: 'sha512' })).toMatch(/checksum/);
    expect(pruefeDownload({ ...ok, filename: '../etc/passwd.qcow2' })).toMatch(/filename/);
    expect(pruefeDownload({ ...ok, filename: 'image.img' })).toMatch(/filename/);
  });
});

describe('Vorlage und Cloud-Init', () => {
  it('Vorlage importiert die Platte aus dem import-Volume und hat ein Cloud-Init-Laufwerk', () => {
    const k = vorlagenKonfig({ vmid: 9020, name: 'ubuntu-2404-20261017', storage: 'nvme-cs001', image: 'backupshare:import/ubuntu-24.04-20261017.qcow2' });
    expect(k.scsi0).toBe('nvme-cs001:0,import-from=backupshare:import/ubuntu-24.04-20261017.qcow2,discard=on,iothread=1,ssd=1');
    expect(k.ide2).toBe('nvme-cs001:cloudinit');
    expect(k).toMatchObject({ vmid: 9020, boot: 'order=scsi0', agent: 'enabled=1', net0: 'virtio,bridge=vmbr0' });
    expect(IMPORT_VOLUME.test('backupshare:import/ubuntu-24.04-20261017.qcow2')).toBe(true);
    expect(IMPORT_VOLUME.test('local:iso/x.qcow2')).toBe(false);
  });
  it('Benutzerdaten: alfred mit Schlüssel, eigener Host-Schlüssel, keine erzeugten Schlüssel, Cloud-Init danach aus', () => {
    const y = cloudInitBenutzerDaten({ hostname: 'probe-i5', alfredSchluessel: ALFRED, hostPrivat: HOST_PRIV, hostOeffentlich: HOST_PUB });
    expect(y.startsWith('#cloud-config\n')).toBe(true);
    expect(y).toContain('  - name: alfred');
    expect(y).toContain(`      - ${JSON.stringify(ALFRED)}`);
    expect(y).toContain('ssh_deletekeys: true\nssh_genkeytypes: []');
    expect(y).toContain('  ed25519_private: |\n    -----BEGIN OPENSSH PRIVATE KEY-----\n');
    expect(y).toContain('    -----END OPENSSH PRIVATE KEY-----\n  ed25519_public: ');
    expect(y).toContain('ssh_pwauth: false');
    expect(y).toContain('[touch, /etc/cloud/cloud-init.disabled]');
    expect(snippetDatei(9021)).toBe('alfred-9021-user.yaml');
  });
  it('lässt nichts Ungeprüftes ins YAML (Hostname, Schlüssel mit Zeilenumbruch, fremder Host-Schlüsseltyp)', () => {
    const basis = { hostname: 'probe-i5', alfredSchluessel: ALFRED, hostPrivat: HOST_PRIV, hostOeffentlich: HOST_PUB };
    expect(() => cloudInitBenutzerDaten({ ...basis, hostname: 'x\nruncmd: [rm]' })).toThrow(/Hostname/);
    expect(() => cloudInitBenutzerDaten({ ...basis, weitereSchluessel: [`${ALFRED}\nruncmd: [x]`] })).toThrow(/Schlüssel/);
    expect(() => cloudInitBenutzerDaten({ ...basis, hostOeffentlich: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQDQowgAO3AO2expjg7K80FWjrxoJ13x' })).toThrow(/ed25519/);
    expect(() => cloudInitBenutzerDaten({ ...basis, hostPrivat: 'kein schlüssel' })).toThrow(/OpenSSH/);
  });
});

describe('Eingabeprüfung der Fabrik-Aktionen', () => {
  const px = new ProxmoxSkill({ baseUrl: 'https://pve:8006', tokenId: 't', tokenSecret: 's' } as never);
  it('delete_vm braucht vmid und vm_name', () => {
    expect(px.pruefeEingabe({ action: 'delete_vm', vm_name: 'x' })).toMatch(/vmid/);
    expect(px.pruefeEingabe({ action: 'delete_vm', vmid: 9021 })).toMatch(/vm_name/);
    expect(px.pruefeEingabe({ action: 'delete_vm', vmid: '9021', vm_name: 'probe-i5' })).toBeUndefined();
  });
  it('provision_vm braucht feste IP, Gateway, Vorlage und gültigen Namen', () => {
    const ok = { action: 'provision_vm', template: 9020, hostname: 'probe-i5', ip: '192.168.1.140/24', gateway: '192.168.1.1' };
    expect(px.pruefeEingabe(ok)).toBeUndefined();
    expect(px.pruefeEingabe({ ...ok, ip: 'dhcp' })).toMatch(/CIDR/);
    expect(px.pruefeEingabe({ ...ok, gateway: undefined })).toMatch(/gateway/);
    expect(px.pruefeEingabe({ ...ok, hostname: 'Probe_I5' })).toMatch(/hostname/);
    expect(px.pruefeEingabe({ ...ok, template: 'ubuntu' })).toMatch(/template/);
  });
  it('create_template und delete_image nur mit import-Volume', () => {
    expect(px.pruefeEingabe({ action: 'create_template', image: 'local:iso/x.iso', hostname: 'v', storage: 's' })).toMatch(/import-Volume/);
    expect(px.pruefeEingabe({ action: 'create_template', image: 'backupshare:import/ubuntu-24.04-20261017.qcow2', hostname: 'ubuntu-2404-20261017', storage: 'nvme-cs001' })).toBeUndefined();
    expect(px.pruefeEingabe({ action: 'delete_image', volid: 'local-lvm:vm-100-disk-0' })).toMatch(/import/);
  });
  it('schreibende Fabrik-Aktionen nur im Change', async () => {
    for (const action of ['download_image', 'delete_image', 'create_template', 'provision_vm', 'delete_vm']) {
      const r = await px.execute({ action, vmid: 9021, vm_name: 'x' }, { userId: 'o', chatId: 'c', platform: 'telegram', conversationId: 'k' } as never);
      expect(r.error).toMatch(/nur als Schritt eines freigegebenen Changes/);
    }
  });
  it('provision_vm ohne eingerichtete Fabrik läuft nicht', async () => {
    const r = await px.execute({ action: 'provision_vm', template: 9020, hostname: 'probe-i5', ip: '192.168.1.140/24', gateway: '192.168.1.1' }, { ausChange: true } as never);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/nicht eingerichtet/);
  });
});
