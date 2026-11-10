import { describe, it, expect } from 'vitest';
import { sicherungsJobPruefung, neuesterStand, imageAngabe, summeAus, pruefeDownload, vorlagenKonfig, cloudInitBenutzerDaten, snippetDatei, IMPORT_VOLUME, DISTROS, IMAGE_URL, summenUrl, distroAusImage } from './proxmox-fabrik.js';
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
    expect(k.scsi1).toBe('nvme-cs001:cloudinit'); expect(k.ide2).toBeUndefined();
    expect(k).toMatchObject({ vmid: 9020, boot: 'order=scsi0', agent: 'enabled=1', net0: 'virtio,bridge=vmbr0' });
    expect(IMPORT_VOLUME.test('backupshare:import/ubuntu-24.04-20261017.qcow2')).toBe(true);
    expect(IMPORT_VOLUME.test('local:iso/x.qcow2')).toBe(false);
  });
  it('Benutzerdaten: alfred mit Schlüssel, eigener Host-Schlüssel, keine erzeugten Schlüssel, Cloud-Init danach aus', () => {
    const y = cloudInitBenutzerDaten({ hostname: 'probe-i5', alfredSchluessel: ALFRED, hostPrivat: HOST_PRIV, hostOeffentlich: HOST_PUB });
    expect(y.startsWith('#cloud-config\n')).toBe(true);
    expect(y).toContain('  - name: alfred');
    expect(y).toContain(`      - ${JSON.stringify(ALFRED)}`);
    expect(y).toContain('ssh_deletekeys: true\nssh_genkeytypes: [ed25519]');
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
  it('v1758: eigenes Konto des Owners mit seinem Schlüssel und sudo; ungültige Namen/Schlüssel abgewiesen', () => {
    const basis = { hostname: 'probe-i5', alfredSchluessel: ALFRED, hostPrivat: HOST_PRIV, hostOeffentlich: HOST_PUB };
    const y = cloudInitBenutzerDaten({ ...basis, familie: 'rpm', ownerKonto: { name: 'madh', schluessel: ALFRED } });
    expect(y).toContain(`  - name: madh\n    gecos: madh\n    shell: /bin/bash\n    groups: [wheel]\n    sudo: "ALL=(ALL) NOPASSWD:ALL"\n    lock_passwd: true\n    ssh_authorized_keys:\n      - ${JSON.stringify(ALFRED)}`);
    expect(y.indexOf('  - name: madh')).toBeGreaterThan(y.indexOf('  - name: alfred'));
    expect(cloudInitBenutzerDaten(basis)).not.toContain('name: madh');
    expect(() => cloudInitBenutzerDaten({ ...basis, ownerKonto: { name: 'root', schluessel: ALFRED } })).toThrow(/Owner-Konto/);
    expect(() => cloudInitBenutzerDaten({ ...basis, ownerKonto: { name: 'madh\n  - name: x', schluessel: ALFRED } })).toThrow(/Owner-Konto/);
    expect(() => cloudInitBenutzerDaten({ ...basis, ownerKonto: { name: 'madh', schluessel: 'kein schlüssel' } })).toThrow(/Owner-Konto/);
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

describe('sicherungsJobPruefung (Übergangsjob 22.10.)', () => {
  const w = { id: 'alfred-uebergang', vmids: [144], storage: 'backupshare', schedule: 'sat 03:00', keepLast: 3 };
  it('neuer Job → vollständiger Auftrag mit snapshot/zstd/keep-last', () => {
    const r = sicherungsJobPruefung({ ...w, bwlimit: 50000 }, [{ id: 'backup-pbs', storage: 'pbs-unas', vmid: '144', enabled: 0 }], [112, 144], ['backupshare', 'pbs-unas']);
    expect(r.fehler).toEqual([]);
    expect(r.body).toMatchObject({ id: 'alfred-uebergang', vmid: '144', storage: 'backupshare', mode: 'snapshot', compress: 'zstd', 'prune-backups': 'keep-last=3', enabled: 1, bwlimit: 50000 });
  });
  it('gleicher vorhandener Job → wiederholbar; abweichender → Fehler', () => {
    expect(sicherungsJobPruefung(w, [{ id: 'alfred-uebergang', schedule: 'sat 03:00', storage: 'backupshare', vmid: '144', 'prune-backups': { 'keep-last': '3' }, enabled: 1 }], [144], ['backupshare']).gleich).toBe(true);
    expect(sicherungsJobPruefung(w, [{ id: 'alfred-uebergang', schedule: 'sun 03:00', storage: 'backupshare', vmid: '144', 'prune-backups': 'keep-last=3' }], [144], ['backupshare']).fehler[0]).toContain('anderen Werten');
  });
  it('falsche Angaben und Doppelsicherung → Fehler', () => {
    const r = sicherungsJobPruefung({ ...w, id: 'backup-1', vmids: [999], storage: 'local', schedule: 'x', keepLast: 0 }, [], [144], ['backupshare']);
    expect(r.fehler.length).toBe(5);
    expect(sicherungsJobPruefung(w, [{ id: 'alfred-alt', storage: 'backupshare', vmid: '112,144', enabled: 1 }], [112, 144], ['backupshare']).fehler[0]).toContain('alfred-alt');
  });
});

describe('getrennteNetze (Rettungskopie MikroTik 23.10.)', () => {
  it('setzt link_down=1 an jeder Karte, ersetzt vorhandene Angaben, lässt anderes unberührt', async () => {
    const { getrennteNetze, alleNetzeGetrennt } = await import('./proxmox-fabrik.js');
    const cfg = { net0: 'virtio=1E:DA:2E:C4:50:5E,bridge=vmbr1', net1: 'virtio=E6:5A:6D:06:EF:59,bridge=vmbr0,tag=20,link_down=0', net3: 'virtio=BC:24:11:53:C3:E9,bridge=vmbr0', scsi0: 'zfs:vm-1', name: 'BGP-MT-1' };
    const g = getrennteNetze(cfg);
    expect(g).toEqual({ net0: 'virtio=1E:DA:2E:C4:50:5E,bridge=vmbr1,link_down=1', net1: 'virtio=E6:5A:6D:06:EF:59,bridge=vmbr0,tag=20,link_down=1', net3: 'virtio=BC:24:11:53:C3:E9,bridge=vmbr0,link_down=1' });
    expect(alleNetzeGetrennt(cfg)).toBe(false);
    expect(alleNetzeGetrennt({ ...cfg, ...g })).toBe(true);
  });
});

describe('restore_backup / isolate_vm (v1614, Rettungskopie)', () => {
  function welt() {
    const px = new ProxmoxSkill({ baseUrl: 'https://pve:8006', tokenId: 't', tokenSecret: 's', defaultNode: 'pve1' } as never);
    const cfg: Record<string, unknown> = { name: 'BGP-MT-1', onboot: 1, net0: 'virtio=AA:00:00:00:00:01,bridge=vmbr1', net1: 'virtio=AA:00:00:00:00:02,bridge=vmbr0,tag=20' };
    const vms = [{ vmid: 104, name: 'BGP-MT-1', node: 'pve1', type: 'qemu' }];
    const aufrufe: string[] = [];
    const a = px as unknown as Record<string, unknown>;
    a.getAllVms = async () => vms;
    a.get = async (p: string) => { aufrufe.push(`GET ${p}`); if (p.endsWith('/storage')) return [{ storage: 'zfs-nvme002', content: 'images,rootdir' }, { storage: 'backupshare', content: 'backup,import' }]; if (p.endsWith('/config')) return cfg; if (p.endsWith('/status/current')) return { status: 'stopped' }; return {}; };
    a.post = async (p: string, b: Record<string, unknown>) => { aufrufe.push(`POST ${p} ${JSON.stringify(b)}`); vms.push({ vmid: Number(b.vmid), name: 'BGP-MT-1', node: 'pve1', type: 'qemu' }); return 'UPID:pve1:1:restore'; };
    a.api = async (m: string, p: string, b: Record<string, unknown>) => { aufrufe.push(`${m} ${p}`); Object.assign(cfg, b); return null; };
    return { px, cfg, aufrufe };
  }
  const imChange = { ausChange: true } as never;
  const volid = 'backupshare:backup/vzdump-qemu-104-2026_01_09-22_09_00.vma.zst';

  it('nur im Change; stellt ohne Start mit neuen MACs wieder her und gibt die Aufgabe zurück', async () => {
    const w = welt();
    expect((await w.px.execute({ action: 'restore_backup', volid, new_vmid: 9104, storage: 'zfs-nvme002', hostname: 'bgp-mt-1-rettung' }, {} as never)).success).toBe(false);
    const r = await w.px.execute({ action: 'restore_backup', node: 'pve1', volid, new_vmid: 9104, storage: 'zfs-nvme002', hostname: 'bgp-mt-1-rettung' }, imChange);
    expect(r.success, r.error).toBe(true);
    expect((r.data as { upid: string }).upid).toMatch(/^UPID:/);
    expect(w.aufrufe.find(x => x.startsWith('POST'))).toContain('"unique":1,"start":0');
    expect((await w.px.execute({ action: 'restore_backup', node: 'pve1', volid, new_vmid: 104, storage: 'zfs-nvme002', hostname: 'x-y' }, imChange)).error).toMatch(/belegt/);
    expect((await w.px.execute({ action: 'restore_backup', node: 'pve1', volid, new_vmid: 9105, storage: 'backupshare', hostname: 'x-y' }, imChange)).error).toMatch(/images/);
  });

  it('v1771 — PBS-Sicherung einer VM (Realfall 07.11. 6f8f54d1), Container und Fremdformen nicht', async () => {
    const w = welt();
    const pbs = 'pbs-pve2:backup/vm/100/2026-11-07T04:50:04Z';
    const r = await w.px.execute({ action: 'restore_backup', node: 'pve1', volid: pbs, new_vmid: 9160, storage: 'zfs-nvme002', hostname: 'restoretest-workvm' }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(w.aufrufe.find(x => x.startsWith('POST'))).toContain(`"archive":"${pbs}"`);
    for (const nein of ['pbs-pve2:backup/ct/111/2026-11-07T04:50:04Z', 'pbs-pve2:backup/vm/100/2026-11-07T04:50:04Z;rm', 'pbs-pve2:backup/vm/100/latest'])
      expect((await w.px.execute({ action: 'restore_backup', node: 'pve1', volid: nein, new_vmid: 9161, storage: 'zfs-nvme002', hostname: 'x-y' }, imChange)).error, nein).toMatch(/volid/);
  });

  it('isolate_vm trennt jede Karte, Autostart aus, liest nach', async () => {
    const w = welt();
    const r = await w.px.execute({ action: 'isolate_vm', vmid: 104, vm_name: 'bgp-mt-1-rettung' }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(w.cfg).toMatchObject({ net0: 'virtio=AA:00:00:00:00:01,bridge=vmbr1,link_down=1', net1: 'virtio=AA:00:00:00:00:02,bridge=vmbr0,tag=20,link_down=1', onboot: 0, name: 'bgp-mt-1-rettung' });
  });
});

describe('agent_status (v1626, Realfall docker-dev-01 ohne Gast-Agent)', () => {
  function welt(agent: boolean) {
    const px = new ProxmoxSkill({ baseUrl: 'https://pve:8006', tokenId: 't', tokenSecret: 's' } as never);
    const a = px as unknown as Record<string, unknown>;
    a.getAllVms = async () => [{ vmid: 144, name: 'docker-dev-01', node: 'pve3', type: 'qemu' }, { vmid: 200, name: 'ct', node: 'pve3', type: 'lxc' }];
    a.get = async (p: string) => {
      if (p.endsWith('/agent/network-get-interfaces')) {
        if (!agent) throw new Error('HTTP 500 QEMU guest agent is not running');
        return { result: [{ name: 'lo', 'ip-addresses': [{ 'ip-address': '127.0.0.1', 'ip-address-type': 'ipv4' }] }, { name: 'eth0', 'ip-addresses': [{ 'ip-address': '10.203.24.2', 'ip-address-type': 'ipv4' }, { 'ip-address': 'fe80::1', 'ip-address-type': 'ipv6' }] }] };
      }
      return {};
    };
    return px;
  }
  it('antwortet → IPv4 ohne Loopback; antwortet nicht → Fehlschlag mit Hinweis; Container → Fehlschlag', async () => {
    const ok = await welt(true).execute({ action: 'agent_status', vm: 'docker-dev-01' }, {} as never);
    expect(ok.success, ok.error).toBe(true);
    expect(ok.display).toContain('antwortet — IPv4: 10.203.24.2 (eth0)');
    expect(ok.display).not.toContain('127.0.0.1');
    // v1766 — VM-Name steht in der Antwort (Warteschritte erwarten ihn)
    expect(ok.display).toContain('VM 144 docker-dev-01 (pve3)');
    const nein = await welt(false).execute({ action: 'agent_status', vmid: 144 }, {} as never);
    expect(nein.success).toBe(false);
    expect(nein.error).toContain('antwortet nicht');
    expect((await welt(true).execute({ action: 'agent_status', vmid: 200 }, {} as never)).error).toContain('Container');
  });
});

describe('v1627 Rocky, Alma, Fedora (Owner 24.10.; Listings und Summen wie live am 24.10. gelesen)', () => {
  const rockyListing = '<a href="Rocky-9-GenericCloud-Base-9.8-20260525.0.x86_64.qcow2">x</a><a href="Rocky-9-GenericCloud-Base-9.7-20251123.0.x86_64.qcow2">x</a><a href="Rocky-9-GenericCloud-Base.latest.x86_64.qcow2">x</a><a href="Rocky-9-GenericCloud-LVM-9.8-20260525.0.x86_64.qcow2">x</a>';
  const almaListing = '<a href="AlmaLinux-9-GenericCloud-9.8-20260810.x86_64.qcow2">x</a><a href="AlmaLinux-9-GenericCloud-9.8-20261005.x86_64.qcow2">x</a><a href="AlmaLinux-9-GenericCloud-ext4-9.8-20261005.x86_64.qcow2">x</a><a href="AlmaLinux-9-GenericCloud-latest.x86_64.qcow2">x</a>';
  const fedoraListing = '<a href="Fedora-Cloud-44-1.7-x86_64-CHECKSUM">x</a><a href="Fedora-Cloud-Base-Generic-44-1.7.x86_64.qcow2">x</a><a href="Fedora-Cloud-Base-UEFI-UKI-44-1.7.x86_64.qcow2">x</a>';
  it('neuester datierter Stand aus flachen Listings, nie „latest“, nicht LVM/ext4/UKI', () => {
    expect(neuesterStand(rockyListing, DISTROS['rocky-9'])).toBe('9.8-20260525.0');
    expect(neuesterStand(almaListing, DISTROS['alma-9'])).toBe('9.8-20261005');
    expect(neuesterStand(fedoraListing, DISTROS['fedora-44'])).toBe('1.7');
    expect(neuesterStand('<a href="release-20261017/">', 'ubuntu')).toBe('release-20261017'); // alter Aufruf bleibt
  });
  it('BSD-Summen (Rocky/Fedora) und GNU-Summen (Alma); URL passt zur Herkunftsliste', () => {
    const rocky = imageAngabe('rocky-9', '9.8-20260525.0', '# Rocky-9-GenericCloud-Base-9.8-20260525.0.x86_64.qcow2: 645988352 bytes\nSHA256 (Rocky-9-GenericCloud-Base-9.8-20260525.0.x86_64.qcow2) = ' + 'a'.repeat(64));
    expect(rocky).toMatchObject({ url: 'https://dl.rockylinux.org/pub/rocky/9/images/x86_64/Rocky-9-GenericCloud-Base-9.8-20260525.0.x86_64.qcow2', checksum: 'a'.repeat(64), checksum_algorithm: 'sha256', filename: 'rocky-9-9.8-20260525.0.qcow2' });
    expect(summenUrl('rocky-9', '9.8-20260525.0')).toBe('https://dl.rockylinux.org/pub/rocky/9/images/x86_64/Rocky-9-GenericCloud-Base-9.8-20260525.0.x86_64.qcow2.CHECKSUM');
    const alma = imageAngabe('alma-10', '10.2-20261012.0', `${'b'.repeat(64)}  AlmaLinux-10-GenericCloud-10.2-20261012.0.x86_64.qcow2\n${'c'.repeat(64)}  AlmaLinux-10-GenericCloud-ext4-10.2-20261012.0.x86_64.qcow2`);
    expect(alma).toMatchObject({ checksum: 'b'.repeat(64), url: 'https://repo.almalinux.org/almalinux/10/cloud/x86_64/images/AlmaLinux-10-GenericCloud-10.2-20261012.0.x86_64.qcow2' });
    expect(summenUrl('alma-10', '10.2-20261012.0')).toBe('https://repo.almalinux.org/almalinux/10/cloud/x86_64/images/CHECKSUM');
    const fed = imageAngabe('fedora-44', '1.7', '-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\nSHA256 (Fedora-Cloud-Base-Generic-44-1.7.x86_64.qcow2) = ' + 'd'.repeat(64));
    expect(fed).toMatchObject({ checksum: 'd'.repeat(64), url: 'https://dl.fedoraproject.org/pub/fedora/linux/releases/44/Cloud/x86_64/images/Fedora-Cloud-Base-Generic-44-1.7.x86_64.qcow2' });
    expect(summenUrl('fedora-44', '1.7')).toBe('https://dl.fedoraproject.org/pub/fedora/linux/releases/44/Cloud/x86_64/images/Fedora-Cloud-44-1.7-x86_64-CHECKSUM');
    for (const a of [rocky, alma, fed]) expect(IMAGE_URL.test((a as { url: string }).url)).toBe(true);
    expect(IMAGE_URL.test('https://dl.rockylinux.org/pub/rocky/9/images/x86_64/Rocky-9-GenericCloud-Base.latest.x86_64.qcow2')).toBe(false);
    expect(IMAGE_URL.test('https://evil.example/Rocky-9-GenericCloud-Base-9.8-20260525.0.x86_64.qcow2')).toBe(false);
    expect(pruefeDownload({ ...(fed as object), checksum_algorithm: 'sha256' })).toBeUndefined();
    expect(summeAus('SHA512 (x.qcow2) = ' + 'e'.repeat(64), 'x.qcow2', 'sha256')).toBeUndefined(); // falscher Algorithmus
  });
  it('Vorlage: x86-64-v3 für RHEL-10-Familie, sonst v2; Distribution aus dem Image-Namen', () => {
    expect(distroAusImage('local:import/rocky-10-10.2-20260525.0.qcow2')).toBe('rocky-10');
    expect(distroAusImage('local:import/rocky-9-9.8-20260525.0.qcow2')).toBe('rocky-9');
    expect(vorlagenKonfig({ vmid: 9030, name: 'rocky-10', storage: 's', image: 'local:import/rocky-10-10.2-20260525.0.qcow2' }).cpu).toBe('x86-64-v3');
    expect(vorlagenKonfig({ vmid: 9031, name: 'alma-9', storage: 's', image: 'local:import/alma-9-9.8-20261005.qcow2' }).cpu).toBe('x86-64-v2-AES');
  });
  it('Cloud-Init: RPM-Familie mit wheel und dnf, Debian-Familie mit sudo und apt; Agent mit Nachversuch', () => {
    const basis = { hostname: 'probe-rocky', alfredSchluessel: ALFRED, hostPrivat: HOST_PRIV, hostOeffentlich: HOST_PUB };
    const rpm = cloudInitBenutzerDaten({ ...basis, familie: 'rpm' });
    expect(rpm).toContain('    groups: [wheel]');
    expect(rpm).toContain('dnf -y install qemu-guest-agent');
    const deb = cloudInitBenutzerDaten(basis);
    expect(deb).toContain('    groups: [sudo]');
    expect(deb).toContain('apt-get install -y qemu-guest-agent');
    expect(deb.indexOf('qemu-ga >/dev/null')).toBeLessThan(deb.indexOf('cloud-init.disabled'));
  });
});

describe('v1629 Cloud-Init: Hostname auf der RHEL-Familie, gültiges Schema', () => {
  it('fqdn = Hostname, FQDN nicht bevorzugt, ssh_genkeytypes nicht leer', () => {
    const y = cloudInitBenutzerDaten({ hostname: 'probe-alma-9', alfredSchluessel: ALFRED, hostPrivat: HOST_PRIV, hostOeffentlich: HOST_PUB, familie: 'rpm' });
    expect(y).toContain('hostname: probe-alma-9\nfqdn: probe-alma-9\nprefer_fqdn_over_hostname: false');
    expect(y).not.toContain('ssh_genkeytypes: []');
  });
});

describe('v1635 SELinux-Modul für den vollen Lese-Käfig (Beweis 69448997)', () => {
  it('RPM-Familie schreibt das Modul und installiert es vor dem Abschalten von Cloud-Init; Debian-Familie nicht', () => {
    const basis = { hostname: 'probe-rocky-9', alfredSchluessel: ALFRED, hostPrivat: HOST_PRIV, hostOeffentlich: HOST_PUB };
    const rpm = cloudInitBenutzerDaten({ ...basis, familie: 'rpm' });
    expect(rpm).toContain('write_files:\n  - path: /etc/selinux/alfred-kaefig.cil');
    expect(rpm).toContain('content: "(allow init_t shadow_t (file (mounton)))\\n"');
    expect(rpm.indexOf('semodule -i /etc/selinux/alfred-kaefig.cil')).toBeGreaterThan(0);
    expect(rpm.indexOf('semodule -i')).toBeLessThan(rpm.indexOf('cloud-init.disabled'));
    const deb = cloudInitBenutzerDaten(basis);
    expect(deb).not.toContain('semodule');
    expect(deb).not.toContain('write_files');
  });
});

describe('v1639 Snapshot-Namen wie Proxmox (Realfall 2bb39131)', () => {
  it('höchstens 40 Zeichen, Buchstabe zuerst; Verweise bleiben erlaubt', () => {
    const px = new ProxmoxSkill({ baseUrl: 'https://pve:8006', tokenId: 't', tokenSecret: 's' } as never);
    expect(px.pruefeEingabe({ action: 'create_snapshot', vmid: 144, name: 'vor-pgadmin-host-ohne-passwortverlust-20261024' })).toMatch(/höchstens 40 Zeichen/);
    expect(px.pruefeEingabe({ action: 'create_snapshot', vmid: 144, name: '2026-vor' })).toMatch(/Buchstaben beginnend/);
    expect(px.pruefeEingabe({ action: 'create_snapshot', vmid: 144, name: 'vor-pgadmin-umstellung' })).toBeUndefined();
    expect(px.pruefeEingabe({ action: 'delete_snapshot', vmid: 144, name: '{{schritt1.name}}' })).toBeUndefined();
  });
});

describe('v1644 provision_vm auf lokalen Speicher eines anderen Nodes (Realfall 5d960660)', () => {
  function welt(zielSpeicher: { type: string; shared?: number }) {
    const px = new ProxmoxSkill({ baseUrl: 'https://pve:8006', tokenId: 't', tokenSecret: 's' } as never);
    const a = px as unknown as Record<string, unknown>;
    const aufrufe: string[] = [];
    const vms = [{ vmid: 9020, name: 'ubuntu-2404', node: 'pve3', type: 'qemu', status: 'stopped' }];
    let scsi0 = 'nvme-cs001:vm-146-disk-0';
    a.getAllVms = async () => vms;
    a.get = async (p: string) => {
      if (p === '/storage/data2') return zielSpeicher;
      if (p.endsWith('/qemu/9020/config')) return { description: 'Vorlage von Alfred (I5) aus backupshare%3Aimport/ubuntu-24.04-20261017.qcow2' };
      if (p.endsWith('/qemu/146/config')) return { scsi0 };
      if (p.endsWith('/agent/network-get-interfaces')) return { result: [{ name: 'eth0', 'ip-addresses': [{ 'ip-address': '10.203.25.2', 'ip-address-type': 'ipv4' }] }] };
      if (p === '/storage/local') return { path: '/var/lib/vz' };
      return {};
    };
    a.post = async (p: string, b: Record<string, unknown>) => {
      aufrufe.push(`POST ${p} ${JSON.stringify(b)}`);
      if (p.endsWith('/clone')) { vms.push({ vmid: 146, name: 'docker-ops-01', node: 'pve1', type: 'qemu', status: 'stopped' }); if (b.storage) scsi0 = `${String(b.storage)}:vm-146-disk-0`; }
      if (p.endsWith('/move_disk')) scsi0 = `${String(b.storage)}:vm-146-disk-0`;
      return 'UPID:x';
    };
    a.api = async () => 'UPID:x';
    a.aufgabeOderFehler = async () => undefined;
    a.vmidFrei = async () => true;
    px.setVmFabrik({
      vorpruefung: async () => [], hostSchluessel: async () => ({ privat: HOST_PRIV, oeffentlich: HOST_PUB }), alfredSchluessel: async () => ALFRED,
      snippetSchreiben: async () => undefined, snippetEntfernen: async () => undefined,
      anmelden: async () => ({ ok: true, meldung: 'SSH ok' }), fortsetzen: async () => ({ ok: true, meldung: 'x' }), abmelden: async () => '',
    } as never);
    return { px, aufrufe };
  }
  const eingabe = { action: 'provision_vm', template: 9020, node: 'pve1', storage: 'data2', hostname: 'docker-ops-01', ip: '10.203.25.2/28', gateway: '10.203.25.1', new_vmid: 146 };
  it('lokaler Speicher (lvmthin) auf anderem Node: Klon ohne storage, danach move_disk nach data2', async () => {
    const w = welt({ type: 'lvmthin' });
    const r = await w.px.execute(eingabe, { ausChange: true } as never);
    expect(r.success, r.error).toBe(true);
    const klon = w.aufrufe.find(x => x.includes('/clone'))!;
    expect(klon).not.toContain('"storage"');
    expect(w.aufrufe.some(x => x.includes('/move_disk') && x.includes('"storage":"data2"') && x.includes('"delete":1'))).toBe(true);
    expect(r.display).toContain('Platte nach data2 auf pve1 verschoben');
  });
  it('gemeinsamer Speicher (rbd): direkt dorthin klonen, kein move_disk', async () => {
    const w = welt({ type: 'rbd' });
    const r = await w.px.execute(eingabe, { ausChange: true } as never);
    expect(r.success, r.error).toBe(true);
    expect(w.aufrufe.find(x => x.includes('/clone'))).toContain('"storage":"data2"');
    expect(w.aufrufe.some(x => x.includes('/move_disk'))).toBe(false);
  });
});

describe('v1779 provision_windows_vm auf lokalen Speicher eines anderen Nodes (Realfall 3103ec4c)', () => {
  function welt(zielSpeicher: { type: string; shared?: number }) {
    const px = new ProxmoxSkill({ baseUrl: 'https://pve:8006', tokenId: 't', tokenSecret: 's' } as never);
    const a = px as unknown as Record<string, unknown>;
    const aufrufe: string[] = [];
    const vms = [{ vmid: 9100, name: 'win-vorlage', node: 'pve', type: 'qemu', status: 'stopped' }];
    const platten: Record<string, string> = { scsi0: 'nvme-cs001:vm-152-disk-1', efidisk0: 'nvme-cs001:vm-152-disk-0', tpmstate0: 'nvme-cs001:vm-152-disk-2', ide0: 'nvme-cs001:vm-152-cloudinit,media=cdrom' };
    a.getAllVms = async () => vms;
    a.get = async (p: string) => {
      if (p === '/storage/data2-pve1') return zielSpeicher;
      if (p.endsWith('/qemu/9100/config')) return { template: 1, description: 'Windows-Vorlage von Alfred (I8a): server-standard-core, gebaut …' };
      if (p.endsWith('/qemu/152/config')) return { ...platten };
      if (p === '/storage/local') return { path: '/var/lib/vz' };
      return {};
    };
    a.post = async (p: string, b: Record<string, unknown>) => {
      aufrufe.push(`POST ${p} ${JSON.stringify(b)}`);
      if (p.endsWith('/clone')) vms.push({ vmid: 152, name: 'dc01', node: 'pve1', type: 'qemu', status: 'stopped' });
      if (p.endsWith('/move_disk')) platten[String(b.disk)] = `${String(b.storage)}:vm-152-${String(b.disk)}`;
      return 'UPID:x';
    };
    a.api = async () => 'UPID:x';
    a.aufgabeOderFehler = async () => undefined;
    a.vmidFrei = async () => true;
    a.cloudInitLoesen = async () => undefined;
    px.setVmFabrik({
      vorpruefung: async () => [], hostSchluessel: async () => ({ privat: HOST_PRIV, oeffentlich: HOST_PUB }), alfredSchluessel: async () => ALFRED,
      snippetSchreiben: async () => undefined, snippetEntfernen: async () => undefined, kennwortSichern: async () => 'win-dc01-admin',
      // Anmeldung scheitert absichtlich: der Test endet nach Klon, Verschieben und Konfiguration
      anmelden: async () => ({ ok: false, meldung: 'Anmeldung (Test) aus' }), fortsetzen: async () => ({ ok: true, meldung: 'x' }), abmelden: async () => '',
    } as never);
    return { px, aufrufe, platten };
  }
  const eingabe = { action: 'provision_windows_vm', template: 9100, node: 'pve1', storage: 'data2-pve1', hostname: 'dc01', ip: '10.203.29.2/27', gateway: '10.203.29.1', new_vmid: 152, extra_disk_size: 64, owner_konto: '' };
  it('lvmthin auf anderem Node: Klon ohne storage, System-, EFI- und TPM-Platte nach data2-pve1, Cloud-Init bleibt', async () => {
    const w = welt({ type: 'lvmthin' });
    const r = await w.px.execute(eingabe, { ausChange: true } as never);
    expect(w.aufrufe.find(x => x.includes('/clone'))).not.toContain('"storage"');
    for (const d of ['scsi0', 'efidisk0', 'tpmstate0']) {
      expect(w.aufrufe.some(x => x.includes('/move_disk') && x.includes(`"disk":"${d}"`) && x.includes('"storage":"data2-pve1"') && x.includes('"delete":1'))).toBe(true);
      expect(w.platten[d]).toMatch(/^data2-pve1:/);
    }
    expect(w.aufrufe.some(x => x.includes('/move_disk') && x.includes('"disk":"ide0"'))).toBe(false);
    expect(w.aufrufe.some(x => x.includes('"scsi1":"data2-pve1:64'))).toBe(true);
    expect(r.error ?? '').toContain('scsi0, efidisk0, tpmstate0 nach data2-pve1 auf pve1 verschoben');
  });
  it('gemeinsamer Speicher (rbd): direkt dorthin klonen, kein move_disk', async () => {
    const w = welt({ type: 'rbd' });
    await w.px.execute({ ...eingabe, storage: 'data2-pve1' }, { ausChange: true } as never);
    expect(w.aufrufe.find(x => x.includes('/clone'))).toContain('"storage":"data2-pve1"');
    expect(w.aufrufe.some(x => x.includes('/move_disk'))).toBe(false);
  });
});

describe('v1689 delete_vm einer Restore-Kopie mit dem Namen des Originals', () => {
  function welt() {
    const px = new ProxmoxSkill({ baseUrl: 'https://pve:8006', tokenId: 't', tokenSecret: 's' } as never);
    const a = px as unknown as Record<string, unknown>;
    let vms = [{ vmid: 144, name: 'docker-dev-01', node: 'pve3', type: 'qemu' }, { vmid: 9150, name: 'docker-dev-01', node: 'pve3', type: 'qemu' }];
    const abgemeldet: Array<Record<string, unknown>> = [];
    a.getAllVms = async () => vms;
    a.get = async (p: string) => (p.endsWith('/status/current') ? { status: 'stopped' } : {});
    a.del = async () => { vms = vms.filter(v => v.vmid !== 9150); return 'UPID:x'; };
    a.aufgabeOderFehler = async () => undefined;
    px.setVmFabrik({ abmelden: async (v: Record<string, unknown>) => { abgemeldet.push(v); return ''; } } as never);
    return { px, abgemeldet, entferne: () => { vms = vms.filter(v => v.vmid !== 144); } };
  }
  it('Original läuft weiter → nur der Eintrag der gelöschten VMID, Fernzugang bleibt', async () => {
    const w = welt();
    const r = await w.px.execute({ action: 'delete_vm', vmid: 9150, vm_name: 'docker-dev-01', force_stop: true }, { ausChange: true } as never);
    expect(r.success, r.error).toBe(true);
    expect(w.abgemeldet).toEqual([{ name: 'docker-dev-01', node: 'pve3', vmid: 9150, nurVmid: true }]);
  });
  it('kein gleichnamiger Rest → wie bisher vollständig abmelden', async () => {
    const w = welt(); w.entferne();
    await w.px.execute({ action: 'delete_vm', vmid: 9150, vm_name: 'docker-dev-01', force_stop: true }, { ausChange: true } as never);
    expect(w.abgemeldet).toEqual([{ name: 'docker-dev-01', node: 'pve3', vmid: 9150 }]);
  });
});

describe('delete_vm bei fehlendem Speicher am Knoten (v1736, Realfall 7f04dc5f)', () => {
  it('Suche nach verwaisten Platten scheitert → gelöschte Platten aus der Konfiguration nehmen, ohne Suche löschen', async () => {
    const px = new ProxmoxSkill({ baseUrl: 'https://pve:8006', tokenId: 't', tokenSecret: 's', defaultNode: 'pve' } as never);
    const cfg: Record<string, unknown> = { name: 'probe-win25', scsi0: 'nvme-cs001:vm-9101-disk-1,size=64G', efidisk0: 'nvme-cs001:vm-9101-disk-0,size=1M', ide0: 'nvme-cs001:vm-9101-cloudinit,media=cdrom' };
    const aufrufe: string[] = [];
    const a = px as unknown as Record<string, unknown>;
    a.getAllVms = async () => [{ vmid: 9101, name: 'probe-win25', node: 'pve', type: 'qemu' }];
    a.get = async (p: string) => { if (p.endsWith('/config')) return cfg; if (p.endsWith('/status/current')) return { status: 'stopped' }; if (p.includes('/content?vmid=9101')) return []; return {}; };
    a.post = async (p: string, b: Record<string, unknown>) => { aufrufe.push(`POST ${p} ${JSON.stringify(b)}`); return null; };
    a.del = async (p: string) => { aufrufe.push(`DEL ${p}`); return p.includes('destroy-unreferenced-disks=1') ? 'UPID:alt' : 'UPID:neu'; };
    a.aufgabeOderFehler = async (u: string) => { if (u === 'UPID:alt') throw new Error('Löschen: no such logical volume nvme001/nvme001'); };
    const r = await px.execute({ action: 'delete_vm', vmid: 9101, vm_name: 'probe-win25', force_stop: true }, { ausChange: true } as never);
    expect(r.success, r.error).toBe(true);
    expect(aufrufe).toContain('POST /nodes/pve/qemu/9101/config {"delete":"scsi0,efidisk0"}');
    expect(aufrufe).toContain('DEL /nodes/pve/qemu/9101?purge=1');
    expect(r.display).toContain('Suche nach verwaisten Platten übersprungen');
  });
});

// I8c (Vorhaben 8cbcf251) — VLAN-Bridge auf pve1 (vmbr0 nicht VLAN-fähig, Netzliste live 08.11.) und PBS-Ausnahme für die DCs
describe('I8c VLAN-Bridge und Sicherungs-Ausnahme', () => {
  const PVE1 = [
    { iface: 'vmbr0', type: 'bridge', bridge_ports: 'enp8s0f0', active: 1 }, { iface: 'vmbr1', type: 'bridge', bridge_vlan_aware: 1, bridge_ports: 'enp8s0f1', active: 1 },
    { iface: 'vmbr2', type: 'bridge', bridge_vlan_aware: 1, bridge_ports: 'enp5s0', active: 1 }, { iface: 'vmbr3', type: 'bridge', bridge_vlan_aware: 1, bridge_ports: 'vmbr2.6', active: 1 },
    { iface: 'vmbr4', type: 'bridge', bridge_vlan_aware: 1, bridge_ports: 'vmbr2.8', active: 1 }, { iface: 'enp8s0f0', type: 'eth', active: 1 },
  ];
  it('Plan: neue Bridge über vmbr0, VLAN-fähige Uplinks abgewiesen, vorhandene erkannt', async () => {
    const { vlanBridgePlan } = await import('./proxmox-fabrik.js');
    expect(vlanBridgePlan(PVE1, { vlan: 829, ueber: 'vmbr0' })).toEqual({ bridge: 'vmbr5', port: 'vmbr0.829' });
    expect(vlanBridgePlan(PVE1, { vlan: 829, ueber: 'vmbr2' }).fehler).toContain('VLAN-fähig');
    expect(vlanBridgePlan(PVE1, { vlan: 6, ueber: 'vmbr2' }).fehler).toContain('VLAN-fähig');
    expect(vlanBridgePlan([...PVE1, { iface: 'vmbr7', type: 'bridge', bridge_ports: 'vmbr0.829' }], { vlan: 829, ueber: 'vmbr0' })).toMatchObject({ vorhanden: 'vmbr7' });
    expect(vlanBridgePlan(PVE1, { vlan: 829, ueber: 'vmbr9' }).fehler).toContain('gibt es auf dem Knoten nicht');
    expect(vlanBridgePlan(PVE1, { vlan: 829, ueber: 'vmbr0', bridge: 'vmbr3' }).fehler).toContain('gibt es schon');
    expect(vlanBridgePlan(PVE1, { vlan: 5000, ueber: 'vmbr0' }).fehler).toContain('2–4094');
  });
  it('Ausnahmeliste: dazu/weg, nur alfred-Jobs mit „alle VMs“ (Realfall alfred-pbs-taeglich)', async () => {
    const { sicherungsAusnahme } = await import('./proxmox-fabrik.js');
    const job = { id: 'alfred-pbs-taeglich', all: 1, exclude: '150,151,145,9000,9001,9100,9102,113,130' };
    expect(sicherungsAusnahme(job, [9200], [])).toEqual({ exclude: '113,130,145,150,151,9000,9001,9100,9102,9200', vorher: '113,130,145,150,151,9000,9001,9100,9102', gleich: false });
    expect(sicherungsAusnahme({ ...job, exclude: '113,9200' }, [], [9200]).exclude).toBe('113');
    expect(sicherungsAusnahme({ ...job, exclude: '113,9200' }, [9200], []).gleich).toBe(true);
    expect(sicherungsAusnahme({ ...job, id: 'backup-fremd' }, [9200], []).fehler).toContain('alfred-');
    expect(sicherungsAusnahme({ ...job, all: 0 }, [9200], []).fehler).toContain('alle VMs');
    expect(sicherungsAusnahme(job, [], []).fehler).toContain('angeben');
  });
  it('Skill: Bridge nur ohne ausstehende Änderungen, Ausnahme wird nachgelesen', async () => {
    const px = new ProxmoxSkill({ baseUrl: 'https://pve:8006', tokenId: 't', tokenSecret: 's' } as never);
    const a = px as unknown as Record<string, unknown>;
    const netz = PVE1.map(n => ({ ...n })) as Array<Record<string, unknown>>;
    let changes: string | undefined = '--- /etc/network/interfaces\n+iface vmbr9';
    const jobs = [{ id: 'alfred-pbs-taeglich', all: 1, exclude: '113' }];
    const aufrufe: string[] = [];
    a.apiRoh = async () => ({ data: netz, ...(changes ? { changes } : {}) });
    a.get = async (p: string) => (p.endsWith('/network') ? netz : p === '/cluster/backup' ? jobs : {});
    a.post = async (p: string, b: Record<string, unknown>) => { aufrufe.push(`POST ${p}`); netz.push({ ...b, active: 0 }); return null; };
    a.api = async (m: string, p: string, b?: Record<string, unknown>) => { aufrufe.push(`${m} ${p}`); if (p.endsWith('/network')) { for (const n of netz) n.active = 1; return 'UPID:x'; } if (p.startsWith('/cluster/backup/')) jobs[0]!.exclude = String(b?.exclude ?? ''); return null; };
    a.aufgabeOderFehler = async () => undefined;
    const imChange = { ausChange: true } as never;
    expect((await px.execute({ action: 'create_vlan_bridge', node: 'pve1', vlan: 829, ueber: 'vmbr0' }, {} as never)).success).toBe(false); // nur im Change
    expect((await px.execute({ action: 'create_vlan_bridge', node: 'pve1', vlan: 829, ueber: 'vmbr0' }, imChange)).error).toContain('stehen schon Netzänderungen aus');
    changes = undefined;
    const r = await px.execute({ action: 'create_vlan_bridge', node: 'pve1', vlan: 829, ueber: 'vmbr0' }, imChange);
    expect(r.error).toBeUndefined();
    expect(r.data).toMatchObject({ bridge: 'vmbr5', port: 'vmbr0.829' });
    expect(aufrufe).toEqual(['POST /nodes/pve1/network', 'PUT /nodes/pve1/network']);
    const e = await px.execute({ action: 'backup_job_exclude', job_id: 'alfred-pbs-taeglich', add_vmids: [9201, 9202] }, imChange);
    expect(e.error).toBeUndefined();
    expect(jobs[0]!.exclude).toBe('113,9201,9202');
  });
});

describe('I8c set_vm_resources', () => {
  it('RAM ändern, nachlesen, alte Werte für den Rückweg, ausstehend bei laufender VM', async () => {
    const px = new ProxmoxSkill({ baseUrl: 'https://pve:8006', tokenId: 't', tokenSecret: 's' } as never);
    const a = px as unknown as Record<string, unknown>;
    const pending: Array<Record<string, unknown>> = [{ key: 'memory', value: 4096 }, { key: 'cores', value: 2 }];
    a.getAllVms = async () => [{ vmid: 9102, name: 'probe-win25b', node: 'pve', type: 'qemu' }];
    a.get = async (p: string) => (p.endsWith('/config') ? { memory: '4096', cores: 2 } : p.endsWith('/pending') ? pending : {});
    a.post = async (_p: string, b: Record<string, unknown>) => { if (b.memory) pending[0] = { key: 'memory', value: 4096, pending: b.memory }; return null; };
    const imChange = { ausChange: true } as never;
    expect((await px.execute({ action: 'set_vm_resources', vmid: 9102, memory: 6144 }, {} as never)).success).toBe(false);
    const r = await px.execute({ action: 'set_vm_resources', vmid: 9102, memory: 6144 }, imChange);
    expect(r.error).toBeUndefined();
    expect(r.data).toMatchObject({ vorher: { memory: 4096, cores: 2 }, ausstehend: true });
    expect(r.display).toContain('wirksam nach reboot_vm');
    expect((await px.execute({ action: 'set_vm_resources', vmid: 9102, memory: 100 }, imChange)).error).toContain('512');
  });
});

// v1783 — Realfall 10.11. (I8c D 12d82a15 Schritt 3): POST …/config ist eine Aufgabe — erst nach ihrem Ende nachlesen
describe('v1783 set_vm_resources wartet auf die Proxmox-Aufgabe', () => {
  it('liest erst nach dem Ende der Aufgabe nach', async () => {
    const px = new ProxmoxSkill({ baseUrl: 'https://pve:8006', tokenId: 't', tokenSecret: 's' } as never);
    const a = px as unknown as Record<string, unknown>;
    const pending: Array<Record<string, unknown>> = [{ key: 'memory', value: 4096 }, { key: 'cores', value: 2 }];
    let wert: unknown;
    a.getAllVms = async () => [{ vmid: 9102, name: 'probe-win25b', node: 'pve', type: 'qemu' }];
    a.get = async (p: string) => (p.endsWith('/config') ? { memory: '4096', cores: 2 } : p.endsWith('/pending') ? pending : {});
    a.post = async (_p: string, b: Record<string, unknown>) => { wert = b.memory; return 'UPID:pve:1:2:3:qmconfig:9102:root@pam:'; };
    const gewartet: string[] = [];
    a.warteAufgabe = async (upid: string) => { gewartet.push(upid); pending[0] = { key: 'memory', value: 4096, pending: String(wert) }; return { ok: true, fertig: true, status: 'OK' }; };
    const r = await px.execute({ action: 'set_vm_resources', vmid: 9102, memory: 6144 }, { ausChange: true } as never);
    expect(r.error).toBeUndefined();
    expect(gewartet).toEqual(['UPID:pve:1:2:3:qmconfig:9102:root@pam:']);
    expect(r.data).toMatchObject({ ausstehend: true, vorher: { memory: 4096 } });
  });
});
