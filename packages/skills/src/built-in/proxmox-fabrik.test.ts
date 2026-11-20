import { describe, it, expect, vi, afterEach } from 'vitest';
import { sicherungsJobPruefung, neuesterStand, imageAngabe, summeAus, pruefeDownload, vorlagenKonfig, cloudInitBenutzerDaten, snippetDatei, IMPORT_VOLUME, DISTROS, IMAGE_URL, summenUrl, distroAusImage } from './proxmox-fabrik.js';
import { ProxmoxSkill, WIN_SCHLUESSEL_ABSTAND_MS } from './proxmox.js';

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

describe('I8e provision_vm mit Zusatzplatten (SQL Server auf Linux: Daten/Log/TempDB/Sicherung)', () => {
  function welt(o: { start?: Record<string, string>; vorhanden?: Record<string, string> } = {}) {
    const px = new ProxmoxSkill({ baseUrl: 'https://pve:8006', tokenId: 't', tokenSecret: 's' } as never);
    const a = px as unknown as Record<string, unknown>;
    const aufrufe: string[] = [];
    const vms: Array<{ vmid: number; name: string; node: string; type: string; status: string }> = [{ vmid: 9020, name: 'ubuntu-2404', node: 'pve1', type: 'qemu', status: 'stopped' }];
    // Klon der Linux-Vorlage: Cloud-Init-Laufwerk als SCSI-CD auf scsi1 (vorlagenKonfig, v1629)
    const cfg: Record<string, string> = { scsi0: 'data2:vm-160-disk-0,discard=on,iothread=1,ssd=1,size=8G', scsi1: 'data2:vm-160-cloudinit,media=cdrom', ...(o.start ?? {}) };
    let gestartet = false;
    a.getAllVms = async () => vms;
    a.get = async (p: string) => {
      if (p.endsWith('/qemu/9020/config')) return { description: 'Vorlage von Alfred (I5) aus backupshare%3Aimport/ubuntu-24.04-20261017.qcow2' };
      if (p.endsWith('/qemu/160/config')) return o.vorhanden ?? { ...cfg };
      if (p === '/storage/local') return { path: '/var/lib/vz' };
      return {};
    };
    a.post = async (p: string, b: Record<string, unknown>) => {
      aufrufe.push(`POST ${p} ${JSON.stringify(b)}`);
      if (p.endsWith('/clone')) vms.push({ vmid: 160, name: 'sql-lx01', node: 'pve1', type: 'qemu', status: 'stopped' });
      if (p.endsWith('/qemu/160/config')) {
        if (gestartet) return null;
        // Proxmox: Löschen (pending) und Anlegen im selben Aufruf ist unzuverlässig — immer getrennt
        const weg = String(b.delete ?? '').split(',').filter(Boolean);
        if (weg.length && Object.keys(b).some(k => /^(scsi|ide|sata)\d+$/.test(k))) throw new Error('delete und neues Laufwerk im selben Aufruf');
        for (const k of weg) delete cfg[k];
        for (const [k, v] of Object.entries(b)) if (/^(scsi|ide|sata)\d+$/.test(k)) { if (cfg[k]) throw new Error(`${k} ist belegt`); cfg[k] = String(v); }
      }
      if (p.endsWith('/status/start')) gestartet = true;
      return 'UPID:x';
    };
    a.api = async () => 'UPID:x';
    a.aufgabeOderFehler = async () => undefined;
    a.vmidFrei = async () => true;
    a.warteAufAgent = async () => ({ ok: true, meldung: 'Gast-Agent antwortet' });
    px.setVmFabrik({
      vorpruefung: async () => [], hostSchluessel: async () => ({ privat: HOST_PRIV, oeffentlich: HOST_PUB }), alfredSchluessel: async () => ALFRED,
      snippetSchreiben: async () => undefined, snippetEntfernen: async () => undefined,
      anmelden: async () => ({ ok: true, meldung: 'SSH ok' }), fortsetzen: async () => ({ ok: true, meldung: 'SSH ok' }), abmelden: async () => '',
    } as never);
    return { px, aufrufe, cfg, startIndex: () => aufrufe.findIndex(x => x.includes('/status/start')) };
  }
  const eingabe = { action: 'provision_vm', template: 9020, node: 'pve1', storage: 'data2', hostname: 'sql-lx01', ip: '10.203.28.10/28', gateway: '10.203.28.1', new_vmid: 160, extra_disks: [160, 80, 64, 128] };

  it('setzt scsi1–scsi4 vor dem Start, verlegt das Cloud-Init-Laufwerk und nennt die Platten im Ergebnis', async () => {
    const w = welt();
    const r = await w.px.execute(eingabe, { ausChange: true } as never);
    expect(r.success, r.error).toBe(true);
    const platten = w.aufrufe.findIndex(x => x.includes('"scsi1":"data2:160,discard=on,iothread=1,ssd=1"'));
    expect(platten).toBeGreaterThan(-1);
    expect(platten).toBeLessThan(w.startIndex());
    expect(w.aufrufe[platten]).toContain('"scsi2":"data2:80,');
    expect(w.aufrufe[platten]).toContain('"scsi3":"data2:64,');
    expect(w.aufrufe[platten]).toContain('"scsi4":"data2:128,');
    // Cloud-Init bleibt ein SCSI-Laufwerk (v1629), aber hinter den möglichen Zusatzplatten
    const loeschen = w.aufrufe.findIndex(x => x.endsWith('/qemu/160/config {"delete":"scsi1"}'));
    const verlegt = w.aufrufe.findIndex(x => x.endsWith('/qemu/160/config {"scsi7":"data2:cloudinit"}'));
    expect(loeschen).toBeGreaterThan(-1);
    expect(verlegt).toBeGreaterThan(loeschen);
    expect(verlegt).toBeLessThan(platten);
    expect(r.data).toMatchObject({ zusatzplatten: [{ laufwerk: 'scsi1', gb: 160 }, { laufwerk: 'scsi2', gb: 80 }, { laufwerk: 'scsi3', gb: 64 }, { laufwerk: 'scsi4', gb: 128 }] });
    expect(r.display).toContain('scsi1 160 GB, scsi2 80 GB, scsi3 64 GB, scsi4 128 GB');
    // Fix-Welle M-11: die Verlegung des Cloud-Init-Laufwerks steht in der Anzeige (von → nach)
    expect(r.display).toContain('Cloud-Init-Laufwerk scsi1 → scsi7');
  });

  it('ohne extra_disks bleibt alles wie bisher (kein Verlegen, keine Platten)', async () => {
    const w = welt();
    const { extra_disks: _x, ...ohne } = eingabe;
    const r = await w.px.execute(ohne, { ausChange: true } as never);
    expect(r.success, r.error).toBe(true);
    expect(w.aufrufe.some(x => x.includes('scsi7') || x.includes('"scsi2"'))).toBe(false);
    expect((r.data as Record<string, unknown>).zusatzplatten).toBeUndefined();
  });

  it('ungültige Größen werden vor jedem Proxmox-Aufruf abgewiesen', async () => {
    for (const extra_disks of [[0], [5000], [160, 160], [1, 2, 3, 4, 5, 6, 7], [-3], ['x'], '160,80']) {
      const w = welt();
      const r = await w.px.execute({ ...eingabe, extra_disks }, { ausChange: true } as never);
      expect(r.success, JSON.stringify(extra_disks)).toBe(false);
      expect(r.error).toMatch(/extra_disks/);
      expect(w.aufrufe).toHaveLength(0);
    }
  });

  it('belegter Platz für eine Zusatzplatte (fremdes Laufwerk) → Abbruch vor dem Start', async () => {
    const w = welt({ start: { scsi2: 'data2:vm-160-disk-9,size=4G' } });
    const r = await w.px.execute(eingabe, { ausChange: true } as never);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/scsi2/);
    expect(w.startIndex()).toBe(-1);
  });

  it('Fortsetzung einer vorhandenen VM prüft die Zusatzplatten statt sie neu anzulegen', async () => {
    const beschreibung = 'Angelegt von Alfred (I5) aus Vorlage 9020';
    const passend = { description: beschreibung, ipconfig0: 'ip=10.203.28.10/28,gw=10.203.28.1', scsi0: 'data2:vm-160-disk-0,size=80G', scsi1: 'data2:vm-160-disk-1,discard=on,size=160G', scsi2: 'data2:vm-160-disk-2,size=80G', scsi3: 'data2:vm-160-disk-3,size=64G', scsi4: 'data2:vm-160-disk-4,size=128G' };
    const ok = welt({ vorhanden: passend });
    (ok.px as unknown as { getAllVms: () => Promise<unknown[]> }).getAllVms = async () => [{ vmid: 9020, name: 'ubuntu-2404', node: 'pve1', type: 'qemu', status: 'stopped' }, { vmid: 160, name: 'sql-lx01', node: 'pve1', type: 'qemu', status: 'running' }];
    const r = await ok.px.execute(eingabe, { ausChange: true } as never);
    expect(r.success, r.error).toBe(true);
    expect(r.data).toMatchObject({ fortgesetzt: true, zusatzplatten: [{ laufwerk: 'scsi1', gb: 160 }, { laufwerk: 'scsi2', gb: 80 }, { laufwerk: 'scsi3', gb: 64 }, { laufwerk: 'scsi4', gb: 128 }] });
    expect(ok.aufrufe.some(x => x.includes('"scsi1":"data2:160'))).toBe(false);
    const falsch = welt({ vorhanden: { ...passend, scsi3: 'data2:vm-160-disk-3,size=32G' } });
    (falsch.px as unknown as { getAllVms: () => Promise<unknown[]> }).getAllVms = async () => [{ vmid: 9020, name: 'ubuntu-2404', node: 'pve1', type: 'qemu', status: 'stopped' }, { vmid: 160, name: 'sql-lx01', node: 'pve1', type: 'qemu', status: 'running' }];
    const f = await falsch.px.execute(eingabe, { ausChange: true } as never);
    expect(f.success).toBe(false);
    expect(f.error).toMatch(/scsi3/);
    expect(f.error).toMatch(/delete_vm/);
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
    a.windowsHostSchluesselAbwarten = async () => ({ ok: true, meldung: 'Gast-Agent (Test) bestätigt' });
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

// v1784 — Realfall 10.11. (I8c D 12d82a15 Schritt 2): vorhandener Snapshot gleichen Namens → nichts zu tun
describe('v1784 create_snapshot mit vorhandenem Namen', () => {
  it('meldet den vorhandenen Snapshot mit Zeitpunkt und legt keinen neuen an', async () => {
    const px = new ProxmoxSkill({ baseUrl: 'https://pve:8006', tokenId: 't', tokenSecret: 's' } as never);
    const a = px as unknown as Record<string, unknown>;
    const posts: string[] = [];
    a.resolveVm = async () => ({ node: 'pve', type: 'qemu' });
    a.get = async (p: string) => (p.endsWith('/snapshot') ? [{ name: 'i8c_d_vor_beitritt', snaptime: 1794304620 }, { name: 'current' }] : {});
    a.post = async (p: string) => { posts.push(p); return 'UPID:x'; };
    const r = await px.execute({ action: 'create_snapshot', vmid: 9102, name: 'i8c_d_vor_beitritt' }, {} as never);
    expect(r.success).toBe(true);
    expect(r.display).toContain('schon vorhanden (angelegt 2026-11-10');
    expect(posts).toEqual([]);
    const n = await px.execute({ action: 'create_snapshot', vmid: 9102, name: 'neu_snap' }, {} as never);
    expect(n.success).toBe(true);
    expect(posts).toEqual(['/nodes/pve/qemu/9102/snapshot']);
  });
});

// v1785 — Realfall 10.11. (12d82a15 Schritt 3, Wiederholung): „vorher“ ist der wirksame Wert, nicht der ausstehende
describe('v1785 set_vm_resources: vorher = wirksamer Wert', () => {
  it('bei schon ausstehendem RAM nennt das Ergebnis den laufenden Wert als vorher und Rückweg', async () => {
    const px = new ProxmoxSkill({ baseUrl: 'https://pve:8006', tokenId: 't', tokenSecret: 's' } as never);
    const a = px as unknown as Record<string, unknown>;
    const pending: Array<Record<string, unknown>> = [{ key: 'memory', value: 4096, pending: '6144' }, { key: 'cores', value: 2 }];
    a.getAllVms = async () => [{ vmid: 9102, name: 'probe-win25b', node: 'pve', type: 'qemu' }];
    a.get = async (p: string) => (p.endsWith('/config') ? { memory: '6144', cores: 2 } : p.endsWith('/pending') ? pending : {});
    a.post = async () => null;
    const r = await px.execute({ action: 'set_vm_resources', vmid: 9102, memory: 6144 }, { ausChange: true } as never);
    expect(r.error).toBeUndefined();
    expect(r.data).toMatchObject({ vorher: { memory: 4096, cores: 2 } });
    expect(r.display).toContain('RAM 4096 → 6144 MiB');
    expect(r.display).toContain('Rückweg: set_vm_resources mit memory 4096');
  });
});

// I8e Paket 2 Task 1 — Watchdog i6300esb (Aktion reset) an der VM, damit SBD den Gast selbst zurücksetzen kann
describe('I8e provision_vm mit watchdog', () => {
  function welt(vorhanden?: Record<string, string>, pending: unknown = []) {
    const px = new ProxmoxSkill({ baseUrl: 'https://pve:8006', tokenId: 't', tokenSecret: 's' } as never);
    const a = px as unknown as Record<string, unknown>;
    const aufrufe: string[] = [];
    const vms: Array<{ vmid: number; name: string; node: string; type: string; status: string }> = [{ vmid: 9020, name: 'ubuntu-2404', node: 'pve1', type: 'qemu', status: 'stopped' }];
    if (vorhanden) vms.push({ vmid: 160, name: 'sql-lx01', node: 'pve1', type: 'qemu', status: 'running' });
    a.getAllVms = async () => vms;
    a.get = async (p: string) => {
      if (p.endsWith('/qemu/9020/config')) return { description: 'Vorlage von Alfred (I5) aus backupshare%3Aimport/ubuntu-24.04-20261017.qcow2' };
      if (p.endsWith('/qemu/160/config') && vorhanden) return vorhanden;
      if (p.endsWith('/qemu/160/pending')) { if (pending === 'fehler') throw new Error('500'); return pending; }
      if (p.endsWith('/qemu/160/config')) return { scsi0: 'data2:vm-160-disk-0,size=8G', scsi1: 'data2:vm-160-cloudinit,media=cdrom' };
      if (p === '/storage/local') return { path: '/var/lib/vz' };
      return {};
    };
    a.post = async (p: string, b: Record<string, unknown>) => {
      aufrufe.push(`POST ${p} ${JSON.stringify(b)}`);
      if (p.endsWith('/clone')) vms.push({ vmid: 160, name: 'sql-lx01', node: 'pve1', type: 'qemu', status: 'stopped' });
      return 'UPID:x';
    };
    a.api = async () => 'UPID:x';
    a.aufgabeOderFehler = async () => undefined;
    a.vmidFrei = async () => true;
    a.warteAufAgent = async () => ({ ok: true, meldung: 'Gast-Agent antwortet' });
    px.setVmFabrik({
      vorpruefung: async () => [], hostSchluessel: async () => ({ privat: HOST_PRIV, oeffentlich: HOST_PUB }), alfredSchluessel: async () => ALFRED,
      snippetSchreiben: async () => undefined, snippetEntfernen: async () => undefined,
      anmelden: async () => ({ ok: true, meldung: 'SSH ok' }), fortsetzen: async () => ({ ok: true, meldung: 'SSH ok' }), abmelden: async () => '',
    } as never);
    return { px, aufrufe };
  }
  const eingabe = { action: 'provision_vm', template: 9020, node: 'pve1', storage: 'data2', hostname: 'sql-lx01', ip: '10.203.28.10/28', gateway: '10.203.28.1', new_vmid: 160 };

  it('setzt genau model=i6300esb,action=reset vor dem ersten Start und nennt es im Ergebnis', async () => {
    const w = welt();
    const r = await w.px.execute({ ...eingabe, watchdog: 'i6300esb' }, { ausChange: true } as never);
    expect(r.success, r.error).toBe(true);
    const i = w.aufrufe.findIndex(x => x.includes('"watchdog":"model=i6300esb,action=reset"'));
    expect(i).toBeGreaterThan(-1);
    expect(i).toBeLessThan(w.aufrufe.findIndex(x => x.includes('/status/start')));
    expect(r.display).toContain('Watchdog i6300esb');
    expect(r.data).toMatchObject({ watchdog: 'i6300esb' });
  });
  it('ohne watchdog bleibt die Konfiguration unverändert', async () => {
    const w = welt();
    const r = await w.px.execute(eingabe, { ausChange: true } as never);
    expect(r.success, r.error).toBe(true);
    expect(w.aufrufe.some(x => x.includes('watchdog'))).toBe(false);
  });
  const vorhanden = { description: 'Angelegt von Alfred (I5) aus Vorlage 9020', ipconfig0: 'ip=10.203.28.10/28,gw=10.203.28.1', scsi0: 'data2:vm-160-disk-0,size=8G' };
  it('Fortsetzung: fehlender Watchdog → sichtbarer Fehler, nichts geändert', async () => {
    const w = welt(vorhanden);
    const r = await w.px.execute({ ...eingabe, watchdog: 'i6300esb' }, { ausChange: true } as never);
    expect(r.success).toBe(false);
    expect(r.error).toContain('(keiner)');
    expect(r.error).toContain('set_vm_watchdog');
    expect(r.error).toContain('stop_vm');
    expect(w.aufrufe).toEqual([]);
  });
  it('Fortsetzung: abweichender Watchdog (action=poweroff) → Fehler mit dem Ist-Wert', async () => {
    const w = welt({ ...vorhanden, watchdog: 'model=i6300esb,action=poweroff' });
    const r = await w.px.execute({ ...eingabe, watchdog: 'i6300esb' }, { ausChange: true } as never);
    expect(r.success).toBe(false);
    expect(r.error).toContain('model=i6300esb,action=poweroff');
    expect(w.aufrufe).toEqual([]);
  });
  it('Fortsetzung: Watchdog nur ausstehend (Setzen) → Fehler „noch ausstehend“, kein data.watchdog', async () => {
    const w = welt({ ...vorhanden, watchdog: 'model=i6300esb,action=reset' }, [{ key: 'watchdog', pending: 'model=i6300esb,action=reset' }]);
    const r = await w.px.execute({ ...eingabe, watchdog: 'i6300esb' }, { ausChange: true } as never);
    expect(r.success).toBe(false);
    expect(r.error).toContain('noch ausstehend');
    expect(r.error).toContain('stop_vm/start_vm');
    expect(w.aufrufe).toEqual([]);
  });
  it('Fortsetzung: wirksamer Watchdog mit ausstehendem Entfernen → Fehler', async () => {
    const w = welt(vorhanden, [{ key: 'watchdog', value: 'model=i6300esb,action=reset', delete: 1 }]);
    const r = await w.px.execute({ ...eingabe, watchdog: 'i6300esb' }, { ausChange: true } as never);
    expect(r.success).toBe(false);
    expect(r.error).toContain('noch ausstehend');
    expect(w.aufrufe).toEqual([]);
  });
  it('Fortsetzung: wirksam ist ein anderer Wert als in /config (value aus /pending) → Fehler mit wirksamem Wert', async () => {
    const w = welt({ ...vorhanden, watchdog: 'model=i6300esb,action=reset' }, [{ key: 'watchdog', value: 'model=i6300esb,action=poweroff' }]);
    const r = await w.px.execute({ ...eingabe, watchdog: 'i6300esb' }, { ausChange: true } as never);
    expect(r.success).toBe(false);
    expect(r.error).toContain('ist model=i6300esb,action=poweroff');
  });
  it('Fortsetzung: wirksamer Watchdog laut /pending (value) → ok', async () => {
    const w = welt({ ...vorhanden, watchdog: 'model=i6300esb,action=reset' }, [{ key: 'watchdog', value: 'model=i6300esb,action=reset' }]);
    const r = await w.px.execute({ ...eingabe, watchdog: 'i6300esb' }, { ausChange: true } as never);
    expect(r.success, r.error).toBe(true);
    expect(r.data).toMatchObject({ watchdog: 'i6300esb' });
  });
  it('Fortsetzung: /pending nicht lesbar oder kein Array → Watchdog nicht prüfbar, nichts geändert', async () => {
    for (const pend of ['fehler', { data: 1 }]) {
      const w = welt({ ...vorhanden, watchdog: 'model=i6300esb,action=reset' }, pend);
      const r = await w.px.execute({ ...eingabe, watchdog: 'i6300esb' }, { ausChange: true } as never);
      expect(r.success).toBe(false);
      expect(r.error).toContain('Watchdog nicht prüfbar — /pending nicht lesbar — nichts geändert');
      expect(w.aufrufe).toEqual([]);
    }
  });
  it('Fortsetzung: passender Watchdog → ok und im Ergebnis genannt; ohne Wunsch keine Prüfung', async () => {
    const w = welt({ ...vorhanden, watchdog: 'model=i6300esb,action=reset' });
    const r = await w.px.execute({ ...eingabe, watchdog: 'i6300esb' }, { ausChange: true } as never);
    expect(r.success, r.error).toBe(true);
    expect(r.data).toMatchObject({ fortgesetzt: true, watchdog: 'i6300esb' });
    const ohne = await welt(vorhanden).px.execute(eingabe, { ausChange: true } as never);
    expect(ohne.success, ohne.error).toBe(true);
  });
  it('weist andere Modelle ab, ohne etwas anzulegen', async () => {
    const w = welt();
    const r = await w.px.execute({ ...eingabe, watchdog: 'ib700' }, { ausChange: true } as never);
    expect(r.success).toBe(false);
    expect(r.error).toContain('i6300esb');
    expect(w.aufrufe).toEqual([]);
  });
});

describe('I8e set_vm_watchdog', () => {
  function welt(watchdog?: string, pending: unknown = []) {
    const px = new ProxmoxSkill({ baseUrl: 'https://pve:8006', tokenId: 't', tokenSecret: 's' } as never);
    const a = px as unknown as Record<string, unknown>;
    const posts: Array<Record<string, unknown>> = [];
    let aktuell = watchdog;
    a.getAllVms = async () => [{ vmid: 156, name: 'sqllnx01', node: 'pve', type: 'qemu', status: 'running' }];
    a.get = async (p: string) => { if (p.endsWith('/pending') && pending === 'fehler') throw new Error('500'); return p.endsWith('/config') ? { ...(aktuell ? { watchdog: aktuell } : {}) } : p.endsWith('/pending') ? pending : {}; };
    a.post = async (_p: string, b: Record<string, unknown>) => {
      posts.push(b);
      if (typeof b.watchdog === 'string') aktuell = b.watchdog; else if (b.delete === 'watchdog') aktuell = undefined;
      return null;
    };
    a.aufgabeOderFehler = async () => undefined;
    return { px, posts };
  }
  const imChange = { ausChange: true } as never;

  it('setzt den Watchdog, nennt vorher und den Kaltstart-Hinweis', async () => {
    const w = welt();
    const r = await w.px.execute({ action: 'set_vm_watchdog', vmid: 156, model: 'i6300esb' }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(w.posts).toEqual([{ watchdog: 'model=i6300esb,action=reset' }]);
    expect(r.data).toMatchObject({ vmid: 156, vorher: null, nachher: 'i6300esb' });
    expect(r.display).toContain('stop_vm/start_vm');
  });
  it('ist idempotent: schon gesetzt → keine Änderung', async () => {
    const w = welt('model=i6300esb,action=reset');
    const r = await w.px.execute({ action: 'set_vm_watchdog', vmid: 156, model: 'i6300esb' }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(w.posts).toEqual([]);
    expect(r.display).toContain('schon');
    expect(r.data).toMatchObject({ vorher: 'i6300esb', nachher: 'i6300esb' });
  });
  it('entfernt mit model null und liefert vorher für den Rückweg', async () => {
    const w = welt('model=i6300esb,action=reset');
    const r = await w.px.execute({ action: 'set_vm_watchdog', vmid: 156, model: null }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(w.posts).toEqual([{ delete: 'watchdog' }]);
    expect(r.data).toMatchObject({ vorher: 'i6300esb', nachher: null });
    const nochmal = await w.px.execute({ action: 'set_vm_watchdog', vmid: 156, model: null }, imChange);
    expect(nochmal.display).toContain('schon');
    expect(w.posts).toHaveLength(1);
  });
  it('weist andere Modelle, fehlendes model und Aufrufe außerhalb eines Changes ab', async () => {
    const w = welt();
    expect((await w.px.execute({ action: 'set_vm_watchdog', vmid: 156, model: 'ib700' }, imChange)).success).toBe(false);
    expect((await w.px.execute({ action: 'set_vm_watchdog', vmid: 156 }, imChange)).success).toBe(false);
    expect((await w.px.execute({ action: 'set_vm_watchdog', vmid: 156, model: 'i6300esb' }, {} as never)).success).toBe(false);
    expect(w.posts).toEqual([]);
  });
  it('abgewichene Aktion am vorhandenen Watchdog (z. B. action=poweroff) wird als anderer Stand behandelt und gesetzt', async () => {
    const w = welt('model=i6300esb,action=poweroff');
    const r = await w.px.execute({ action: 'set_vm_watchdog', vmid: 156, model: 'i6300esb' }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(w.posts).toEqual([{ watchdog: 'model=i6300esb,action=reset' }]);
  });
  it('vorherRoh nennt die Rohangabe; abweichende Aktion → Hinweis, dass der Rückweg sie nicht exakt wiederherstellt', async () => {
    const w = welt('model=i6300esb,action=poweroff');
    const r = await w.px.execute({ action: 'set_vm_watchdog', vmid: 156, model: null }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(r.data).toMatchObject({ vorher: 'i6300esb', vorherRoh: 'model=i6300esb,action=poweroff' });
    expect(r.display).toContain('model=i6300esb,action=poweroff');
    expect(r.display).toMatch(/nicht exakt/);
    const sauber = await welt('model=i6300esb,action=reset').px.execute({ action: 'set_vm_watchdog', vmid: 156, model: null }, imChange);
    expect(sauber.data).toMatchObject({ vorherRoh: 'model=i6300esb,action=reset' });
    expect(sauber.display).not.toMatch(/nicht exakt/);
    const leer = await welt().px.execute({ action: 'set_vm_watchdog', vmid: 156, model: 'i6300esb' }, imChange);
    expect(leer.data).toMatchObject({ vorher: null, vorherRoh: null });
    expect(leer.display).not.toMatch(/nicht exakt/);
  });
  it('schon gesetzt, aber noch ausstehend (/pending): „schon“ mit Hinweis stop_vm/start_vm', async () => {
    const w = welt('model=i6300esb,action=reset', [{ key: 'watchdog', pending: 'model=i6300esb,action=reset' }]);
    const r = await w.px.execute({ action: 'set_vm_watchdog', vmid: 156, model: 'i6300esb' }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(w.posts).toEqual([]);
    expect(r.display).toContain('schon');
    expect(r.display).toContain('stop_vm/start_vm');
    expect(r.data).toMatchObject({ ausstehend: true });
  });
  it('vorher kommt aus dem wirksamen Wert in /pending, nicht aus der Konfiguration', async () => {
    const w = welt('model=i6300esb,action=reset', [{ key: 'watchdog', value: 'model=i6300esb,action=poweroff', pending: 'model=i6300esb,action=reset' }]);
    const r = await w.px.execute({ action: 'set_vm_watchdog', vmid: 156, model: null }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(r.data).toMatchObject({ vorher: 'i6300esb', vorherRoh: 'model=i6300esb,action=poweroff' });
  });
  it('ausstehendes Entfernen: „entfernt, noch ausstehend“ bei model null; Setzen antwortet NICHT „schon so“', async () => {
    const pend = [{ key: 'watchdog', value: 'model=i6300esb,action=reset', delete: 1 }];
    const w = welt(undefined, pend);
    const r = await w.px.execute({ action: 'set_vm_watchdog', vmid: 156, model: null }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(w.posts).toEqual([]);
    expect(r.display).toContain('entfernt, noch ausstehend');
    expect(r.data).toMatchObject({ ausstehend: true, nachher: null });
    const w2 = welt(undefined, pend);
    const s = await w2.px.execute({ action: 'set_vm_watchdog', vmid: 156, model: 'i6300esb' }, imChange);
    expect(w2.posts).toEqual([{ watchdog: 'model=i6300esb,action=reset' }]);
    expect(s.display).not.toContain('schon so');
    expect(s.data).toMatchObject({ vorher: 'i6300esb', geaendert: true });
  });
  it('ausstehendes Setzen: „gesetzt, noch ausstehend“; wirksam gesetzt: „nichts geändert (wirksam)“; ausstehendes Setzen + Anfrage null → ändert', async () => {
    const w = welt('model=i6300esb,action=reset', [{ key: 'watchdog', pending: 'model=i6300esb,action=reset' }]);
    const r = await w.px.execute({ action: 'set_vm_watchdog', vmid: 156, model: 'i6300esb' }, imChange);
    expect(r.display).toContain('gesetzt, noch ausstehend');
    const wirksam = await welt('model=i6300esb,action=reset', [{ key: 'watchdog', value: 'model=i6300esb,action=reset' }]).px.execute({ action: 'set_vm_watchdog', vmid: 156, model: 'i6300esb' }, imChange);
    expect(wirksam.display).toContain('nichts geändert (wirksam)');
    expect(wirksam.data).toMatchObject({ ausstehend: false });
    const w3 = welt('model=i6300esb,action=reset', [{ key: 'watchdog', pending: 'model=i6300esb,action=reset' }]);
    await w3.px.execute({ action: 'set_vm_watchdog', vmid: 156, model: null }, imChange);
    expect(w3.posts).toEqual([{ delete: 'watchdog' }]);
  });
  it('/pending nicht lesbar oder kein Array → nicht prüfbar, kein POST', async () => {
    for (const pend of ['fehler', { data: 1 }]) {
      const w = welt('model=i6300esb,action=reset', pend);
      for (const model of ['i6300esb', null]) {
        const r = await w.px.execute({ action: 'set_vm_watchdog', vmid: 156, model }, imChange);
        expect(r.success).toBe(false);
        expect(r.error).toContain('Watchdog nicht prüfbar — /pending nicht lesbar — nichts geändert');
      }
      expect(w.posts).toEqual([]);
    }
  });
  it('Konfiguration zeigt das Ziel, wirksam ist aber etwas anderes (Eintrag ohne pending) → Abweichung statt „(wirksam)“', async () => {
    const w = welt('model=i6300esb,action=reset', [{ key: 'watchdog', value: 'model=i6300esb,action=poweroff' }]);
    const r = await w.px.execute({ action: 'set_vm_watchdog', vmid: 156, model: 'i6300esb' }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(w.posts).toEqual([]);
    expect(r.display).toContain('ACHTUNG');
    expect(r.display).toContain('model=i6300esb,action=poweroff');
    expect(r.display).not.toContain('(wirksam)');
    expect(r.data).toMatchObject({ wirksam: false, vorher: 'i6300esb', vorherRoh: 'model=i6300esb,action=poweroff' });
  });
  it('vorher und vorherRoh stammen im „schon“-Zweig aus demselben wirksamen Wert', async () => {
    const r = await welt('model=i6300esb,action=reset', [{ key: 'watchdog', value: 'model=i6300esb,action=reset' }]).px.execute({ action: 'set_vm_watchdog', vmid: 156, model: 'i6300esb' }, imChange);
    expect(r.data).toMatchObject({ vorher: 'i6300esb', vorherRoh: 'model=i6300esb,action=reset', wirksam: true });
    const leer = await welt().px.execute({ action: 'set_vm_watchdog', vmid: 156, model: null }, imChange);
    expect(leer.data).toMatchObject({ vorher: null, vorherRoh: null, geaendert: false, wirksam: true });
    expect(leer.display).toContain('(wirksam)');
  });
});

// ── Ruling R35 (I8e L6): Medienprüfung — abholen beim Warten, finish fail-closed, lesend auf jeder Windows-VM ─────────────────────
describe('Ruling R35 (I8e L6) Medienprüfung in der Windows-Fabrik', () => {
  const MS = 'CN=Microsoft Windows, O=Microsoft Corporation, L=Redmond, S=Washington, C=US';
  const WHCP = 'CN=Microsoft Windows Hardware Compatibility Publisher, O=Microsoft Corporation, L=Redmond, S=Washington, C=US';
  const CB = 'CN=Cloudbase Solutions Srl, O=Cloudbase Solutions Srl, L=Timisoara, C=RO';
  const e = (datei: string, signer: string, status = 'Valid') => ({ datei, status, signer });
  const json = (secureBoot = true) => JSON.stringify({
    version: 1, ok: secureBoot, installationType: 'Client', secureBoot,
    system: ['System32\\ntoskrnl.exe', 'System32\\winload.efi', 'System32\\ci.dll', 'System32\\kernel32.dll', 'explorer.exe'].map(d => e(`C:\\Windows\\${d}`, MS)),
    virtio: ['vioscsi', 'netkvm', 'vioser'].map(t => e(`C:\\Windows\\System32\\drivers\\${t}.sys`, WHCP)),
    cloudbase: [e('E:\\CloudbaseInitSetup_x64.msi', CB)], fehler: secureBoot ? [] : ['Secure Boot nicht aktiv'],
  });
  const BAU = 'Windows-Vorlage von Alfred (I8a): win11, Abbild 3 Windows 11 Enterprise Evaluation Build 26100.1, gebaut 2026-11-20';
  function welt(o: { status: string; beschreibung?: string; gast?: string; agentStdout?: string; template?: number }) {
    const px = new ProxmoxSkill({ baseUrl: 'https://pve:8006', tokenId: 't', tokenSecret: 's' } as never);
    const a = px as unknown as Record<string, unknown>;
    const aufrufe: string[] = [];
    const cfg: Record<string, unknown> = { description: o.beschreibung ?? BAU, scsi0: 'nvme-cs001:vm-9110-disk-1', ide2: 'local:iso/win11.iso,media=cdrom', sata1: 'local:iso/alfred-antwort-9110.iso,media=cdrom', ...(o.template ? { template: o.template } : {}) };
    a.getAllVms = async () => [{ vmid: 9110, name: 'win11-tpl', node: 'pve', type: 'qemu', status: o.status }];
    a.get = async (p: string) => {
      aufrufe.push(`GET ${p}`);
      if (p.endsWith('/qemu/9110/config')) return cfg;
      if (p.endsWith('/status/current')) return { status: o.status, name: 'win11-tpl' };
      if (p.includes('/agent/file-read')) { if (o.gast === undefined) throw new Error('HTTP 500 QEMU guest agent is not running'); return { content: o.gast }; }
      return {};
    };
    a.post = async (p: string, b: Record<string, unknown>) => { aufrufe.push(`POST ${p} ${JSON.stringify(b)}`); return 'UPID:x'; };
    a.api = async (m: string, p: string, b: Record<string, unknown>) => { aufrufe.push(`${m} ${p} ${JSON.stringify(b)}`); if (p.endsWith('/config') && b?.description) cfg.description = b.description; return null; };
    a.aufgabeOderFehler = async () => undefined;
    a.deleteIso = async () => ({ success: true });
    a.gastPowershell = async (vmid: number, name: string, skript: string) => { aufrufe.push(`PS ${vmid} ${name} ${skript.length}`); return { code: 0, stdout: o.agentStdout ?? '', stderr: '' }; };
    return { px, aufrufe, cfg };
  }
  const imChange = { ausChange: true } as never;

  it('vm_status der laufenden Bau-VM holt das Ergebnis ab, hält es in der Beschreibung fest und gibt sysprep frei', async () => {
    const w = welt({ status: 'running', gast: `\uFEFF${json()}` });
    const r = await w.px.execute({ action: 'vm_status', vmid: 9110 }, {} as never);
    expect(r.success, r.error).toBe(true);
    expect(r.display).toContain('MEDIEN_SIGNIERT win11-tpl: Secure Boot an, 5 Systemdateien Microsoft-signiert, VirtIO 3 signiert, Cloudbase-Init signiert');
    expect(String(w.cfg.description)).toMatch(/^Windows-Vorlage von Alfred \(I8a\): win11,[^\n]*\nMEDIENPRUEFUNG \{"version":1/);
    const ack = w.aufrufe.find(x => x.includes('/agent/file-write'));
    expect(ack).toContain('medienpruefung.abgeholt');
    // Reihenfolge: erst festhalten, dann freigeben
    expect(w.aufrufe.findIndex(x => x.startsWith('PUT') && x.includes('/config'))).toBeLessThan(w.aufrufe.indexOf(ack!));
  });

  it('vm_status: fehlgeschlagene Prüfung wird festgehalten, aber nicht freigegeben; fremde VMs bleiben unberührt', async () => {
    const w = welt({ status: 'running', gast: json(false) });
    const r = await w.px.execute({ action: 'vm_status', vmid: 9110 }, {} as never);
    expect(r.display).toContain('MEDIEN_NICHT_BELEGT win11-tpl: ');
    expect(String(w.cfg.description)).toContain('MEDIENPRUEFUNG ');
    expect(w.aufrufe.some(x => x.includes('/agent/file-write'))).toBe(false);
    const fremd = welt({ status: 'running', beschreibung: 'Produktiv-VM', gast: json() });
    await fremd.px.execute({ action: 'vm_status', vmid: 9110 }, {} as never);
    expect(fremd.aufrufe.some(x => x.includes('/agent/'))).toBe(false);
    expect(fremd.cfg.description).toBe('Produktiv-VM');
    // noch kein Ergebnis im Gast: nichts geschrieben
    const frueh = welt({ status: 'running' });
    expect((await frueh.px.execute({ action: 'vm_status', vmid: 9110 }, {} as never)).success).toBe(true);
    expect(frueh.cfg.description).toBe(BAU);
  });

  it('finish_windows_template ist fail-closed: ohne festgehaltenes Ergebnis keine Vorlage', async () => {
    const w = welt({ status: 'stopped' });
    const r = await w.px.execute({ action: 'finish_windows_template', vmid: 9110, vm_name: 'win11-tpl' }, imChange);
    expect(r.success).toBe(false);
    expect(r.error).toContain('MEDIEN_NICHT_BELEGT win11-tpl: kein Ergebnis');
    expect(w.aufrufe.some(x => x.includes('/template') || x.startsWith('POST'))).toBe(false);
    const kaputt = welt({ status: 'stopped', beschreibung: `${BAU}\nMEDIENPRUEFUNG {kaputt` });
    expect((await kaputt.px.execute({ action: 'finish_windows_template', vmid: 9110, vm_name: 'win11-tpl' }, imChange)).error).toContain('unlesbar');
  });

  it('finish_windows_template mit bestandener Prüfung: Vorlage und feste Zeile MEDIEN_SIGNIERT', async () => {
    const w = welt({ status: 'stopped', beschreibung: `${BAU}\nMEDIENPRUEFUNG ${json()}` });
    const r = await w.px.execute({ action: 'finish_windows_template', vmid: 9110, vm_name: 'win11-tpl' }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(r.display).toContain('MEDIEN_SIGNIERT win11-tpl: Secure Boot an, 5 Systemdateien Microsoft-signiert, VirtIO 3 signiert, Cloudbase-Init signiert');
    expect(w.aufrufe.some(x => x.includes('/qemu/9110/template'))).toBe(true);
  });

  it('finish_windows_template bei laufender VM mit fehlgeschlagener Prüfung: klarer Fehler mit Prüfergebnis', async () => {
    const w = welt({ status: 'running', gast: json(false) });
    const r = await w.px.execute({ action: 'finish_windows_template', vmid: 9110, vm_name: 'win11-tpl' }, imChange);
    expect(r.success).toBe(false);
    expect(r.error).toContain('Medienprüfung fehlgeschlagen');
    expect(r.error).toContain('Secure Boot');
    // bestehende Vorlage (z. B. 9100) bleibt unberührt
    const alt = welt({ status: 'stopped', template: 1, beschreibung: 'Windows-Vorlage von Alfred (I8a): server-standard-core, gebaut …' });
    expect((await alt.px.execute({ action: 'finish_windows_template', vmid: 9110, vm_name: 'win11-tpl' }, imChange)).display).toContain('schon eine Vorlage');
  });

  it('check_windows_media: lesend auch außerhalb von Changes, gleiche Zeile, fail-closed', async () => {
    const klon = 'Angelegt von Alfred (I8a) aus Windows-Vorlage 9110 (win11) am 2026-11-20.';
    const ok = welt({ status: 'running', beschreibung: klon, agentStdout: `Rauschen\nALFRED_MEDIEN ${json()}\n` });
    const r = await ok.px.execute({ action: 'check_windows_media', vm: 'win11-tpl' }, {} as never);
    expect(r.success, r.error).toBe(true);
    expect(r.display).toContain('MEDIEN_SIGNIERT win11-tpl: Secure Boot an, 5 Systemdateien');
    expect(ok.aufrufe.some(x => x.startsWith('PS 9110 win11-tpl'))).toBe(true);
    expect(ok.aufrufe.some(x => x.startsWith('PUT') || x.includes('file-write'))).toBe(false);
    const nein = await welt({ status: 'running', beschreibung: klon, agentStdout: `ALFRED_MEDIEN ${json(false)}` }).px.execute({ action: 'check_windows_media', vmid: 9110 }, {} as never);
    expect(nein.success).toBe(false);
    expect(nein.error).toContain('MEDIEN_NICHT_BELEGT win11-tpl');
    const leer = await welt({ status: 'running', beschreibung: klon, agentStdout: 'nichts' }).px.execute({ action: 'check_windows_media', vmid: 9110 }, {} as never);
    expect(leer.success).toBe(false);
    expect(leer.error).toContain('kein Ergebnis');
    const aus = await welt({ status: 'stopped', beschreibung: klon }).px.execute({ action: 'check_windows_media', vmid: 9110 }, {} as never);
    expect(aus.success).toBe(false);
    expect(aus.error).toContain('läuft nicht');
    // Sicherheitsprüfung: keine Gast-Ausführung auf fremden VMs (ohne Variante in der Beschreibung)
    const fremd = welt({ status: 'running', beschreibung: 'irgendeine VM', agentStdout: `ALFRED_MEDIEN ${json()}` });
    const f = await fremd.px.execute({ action: 'check_windows_media', vmid: 9110 }, {} as never);
    expect(f.success).toBe(false);
    expect(f.error).toContain('keine Windows-VM aus Alfreds Vorlagen');
    expect(fremd.aufrufe.some(x => x.startsWith('PS '))).toBe(false);
  });
});

// ── Ruling R36 (I8e L6): build_windows_template mit win11-pro ─────────────────────────────────────────────────────────────────────
describe('Ruling R36 (I8e L6) build_windows_template win11-pro', () => {
  const CBURL = 'https://github.com/cloudbase/cloudbase-init/releases/download/1.1.9/CloudbaseInitSetup_1_1_9_x64.msi';
  function welt(isos: string[]) {
    const px = new ProxmoxSkill({ baseUrl: 'https://pve:8006', tokenId: 't', tokenSecret: 's' } as never);
    const a = px as unknown as Record<string, unknown>;
    const skripte: Array<{ name: string; eingabe: Record<string, unknown> }> = [];
    a.getAllVms = async () => [];
    a.vmidFrei = async () => true;
    a.get = async (p: string) => (p.includes('/content?content=iso') ? isos.map(volid => ({ volid })) : {});
    px.setVmFabrik({
      knotenSkript: async (_n: string, name: string, eingabe: string) => {
        skripte.push({ name, eingabe: JSON.parse(eingabe) as Record<string, unknown> });
        if (name === 'win-inspektion') return `ALFRED_JSON ${JSON.stringify({ abbilder: [{ index: 1, name: 'Windows 11 Home', editionId: 'Core', installationType: 'Client' }, { index: 6, name: 'Windows 11 Pro', editionId: 'Professional', installationType: 'Client' }], virtio: ['w10', 'w11'], gastWerkzeuge: true })}`;
        throw new Error('Test endet nach dem Antwort-ISO');
      },
    } as never);
    return { px, skripte };
  }
  const basis = { action: 'build_windows_template', node: 'pve', storage: 'nvme-cs001', virtio_iso: 'local:iso/virtio-win-0.1.302.iso', variante: 'win11-pro', cloudbase_url: CBURL, hostname: 'w11pro-tpl', new_vmid: 9111 };
  const imChange = { ausChange: true } as never;

  it('Microsoft-ISO mit Sprache aus dem Namen: Abbild Professional, Antwortdatei mit GVLK und Windows-11-Sonderfällen', async () => {
    const iso = 'local:iso/Win11_25H2_German_x64.iso';
    const w = welt([iso, basis.virtio_iso]);
    const r = await w.px.execute({ ...basis, iso }, imChange);
    expect(r.error).toContain('Test endet');
    const antwort = w.skripte.find(s => s.name === 'win-antwort')!;
    expect(antwort.eingabe.ordner).toBe('w11');
    const au = Buffer.from(String((antwort.eingabe.dateien as Record<string, string>)['autounattend.xml']), 'base64').toString('utf8');
    expect(au).toContain('<Key>/IMAGE/INDEX</Key><Value>6</Value>');
    expect(au).toContain('<Key>W269N-WFGWX-YVC9B-4J6C9-T83GX</Key>');
    expect(au).toContain('<UILanguage>de-DE</UILanguage>');
    expect(au).toContain('BypassCPUCheck');
  });

  it('fail-closed: falsches ISO, unbekannte Sprache ohne Angabe, Widerspruch', async () => {
    const eval11 = 'local:iso/win11-enterprise-eval-26100.1-en-us.iso';
    expect((await welt([eval11, basis.virtio_iso]).px.execute({ ...basis, iso: eval11 }, imChange)).error).toMatch(/passt nicht|Windows-11-ISO/);
    const fr = 'local:iso/Win11_25H2_French_x64.iso';
    expect((await welt([fr, basis.virtio_iso]).px.execute({ ...basis, iso: fr }, imChange)).error).toContain('sprache');
    const de = 'local:iso/Win11_25H2_German_x64.iso';
    expect((await welt([de, basis.virtio_iso]).px.execute({ ...basis, iso: de, sprache: 'en-us' }, imChange)).error).toContain('widerspricht');
    // Enterprise-Variante nimmt das Mehrfach-Edition-ISO nicht
    expect((await welt([de, basis.virtio_iso]).px.execute({ ...basis, variante: 'win11', iso: de }, imChange)).error).toBeTruthy();
  });
});

describe('Ruling R37 (I8e L6): windows_build_log liest die Statusdatei', () => {
  function bau(dateien: Record<string, string | Error>) {
    const px = new ProxmoxSkill({ baseUrl: 'https://pve:8006', tokenId: 't', tokenSecret: 's' } as never);
    const a = px as unknown as Record<string, unknown>;
    a.getAllVms = async () => [{ vmid: 9110, name: 'win11-ent-eval', node: 'pve', type: 'qemu', status: 'running' }];
    a.get = async (p: string) => {
      const m = /agent\/file-read\?file=(.*)$/.exec(p);
      if (m) { const d = dateien[decodeURIComponent(m[1])]; if (d === undefined || d instanceof Error) throw d ?? new Error('HTTP 500 file not found'); return { content: d }; }
      if (p.endsWith('/config')) return { description: 'Windows-Vorlage von Alfred (I8a): win11, Abbild 1' };
      return {};
    };
    a.medienAbholen = async () => undefined;
    return px;
  }
  const TRANSKRIPT = String.raw`C:\Windows\Temp\alfred-setup.log`;
  const STATUS = String.raw`C:\Windows\Temp\alfred-setup-status.log`;
  const GESPERRT = new Error(`HTTP 500 Agent error: failed to open file '${TRANSKRIPT}': The process cannot access the file because`);

  it('Transkript gesperrt: Marken kommen aus der Statusdatei (mit BOM und Zeitstempel)', async () => {
    const r = await bau({
      [STATUS]: '\uFEFF2026-11-20T18:10:00 ALFRED: Gast-Werkzeuge\r\n2026-11-20T18:12:00 ALFRED: OpenSSH (Windows Update, hoechstens 90 min)\r\n',
      [TRANSKRIPT]: GESPERRT,
    }).execute({ action: 'windows_build_log', vmid: 9110 }, {} as never);
    expect(r.success, r.error).toBe(true);
    expect(r.display).toContain('2026-11-20T18:12:00 ALFRED: OpenSSH');
    expect(r.display).toContain('2026-11-20T18:10:00 ALFRED: Gast-Werkzeuge');
    expect(r.display).toContain('(Transkript während des Laufs gesperrt)');
  });

  it('älterer Bau ohne Statusdatei: Marken aus dem Transkript; beides unlesbar = Fehler', async () => {
    const alt = await bau({ [TRANSKRIPT]: 'Rauschen\r\nALFRED: Cloudbase-Init\r\n' }).execute({ action: 'windows_build_log', vmid: 9110 }, {} as never);
    expect(alt.success, alt.error).toBe(true);
    expect(alt.display).toContain('ALFRED: Cloudbase-Init');
    const nichts = await bau({ [TRANSKRIPT]: GESPERRT }).execute({ action: 'windows_build_log', vmid: 9110 }, {} as never);
    expect(nichts.success).toBe(false);
    expect(nichts.error).toContain('Protokoll nicht lesbar');
  });
});

describe('Ruling R39 (I8e L6): Antwort-ISO gehört zur Bau-VM', () => {
  const ANTWORT = 'local:iso/alfred-antwort-9112.iso';
  function welt(o: { beschreibung: string; isos: string[] }) {
    const px = new ProxmoxSkill({ baseUrl: 'https://pve:8006', tokenId: 't', tokenSecret: 's' } as never);
    const a = px as unknown as Record<string, unknown>;
    const ablauf: string[] = [];
    let vms = [{ vmid: 9112, name: 'win11-ent-eval-de', node: 'pve', type: 'qemu', status: 'stopped' }];
    a.getAllVms = async () => vms;
    a.vmidFrei = async () => true;
    a.get = async (p: string) => {
      if (p.includes('/content?content=iso')) return o.isos.map(volid => ({ volid }));
      if (p.endsWith('/config')) return { description: o.beschreibung };
      if (p.endsWith('/status/current')) return { status: 'stopped' };
      return {};
    };
    a.del = async (p: string) => { ablauf.push(`DEL ${decodeURIComponent(p)}`); if (p.includes('/qemu/9112')) vms = []; if (p.includes('alfred-antwort')) o.isos = o.isos.filter(i => i !== ANTWORT); return 'UPID:x'; };
    a.aufgabeOderFehler = async () => undefined;
    px.setVmFabrik({
      knotenSkript: async (_n: string, name: string) => {
        ablauf.push(`SKRIPT ${name}`);
        if (name === 'win-inspektion') return `ALFRED_JSON ${JSON.stringify({ abbilder: [{ index: 1, name: 'Windows 11 Enterprise Evaluation', editionId: 'EnterpriseEval', installationType: 'Client' }], virtio: ['w11'], gastWerkzeuge: true })}`;
        throw new Error('Test endet nach dem Antwort-ISO');
      },
      abmelden: async () => '',
    } as never);
    return { px, ablauf };
  }
  const imChange = { ausChange: true } as never;

  it('delete_vm einer Bau-VM entfernt ihr Antwort-ISO mit; andere VMs lassen ISOs unberührt', async () => {
    const bau = welt({ beschreibung: 'Windows-Vorlage von Alfred (I8a): win11, Abbild 1', isos: [ANTWORT] });
    const r = await bau.px.execute({ action: 'delete_vm', vmid: 9112, vm_name: 'win11-ent-eval-de' }, imChange);
    expect(r.success, r.error).toBe(true);
    expect(r.display).toContain(`Antwort-ISO ${ANTWORT} entfernt`);
    expect(bau.ablauf.some(x => x.includes('alfred-antwort-9112.iso'))).toBe(true);
    const fremd = welt({ beschreibung: 'Produktiv-VM', isos: [ANTWORT] });
    await fremd.px.execute({ action: 'delete_vm', vmid: 9112, vm_name: 'win11-ent-eval-de' }, imChange);
    expect(fremd.ablauf.some(x => x.includes('alfred-antwort'))).toBe(false);
  });

  it('Neubau auf freier VMID räumt ein verwaistes Antwort-ISO vor dem Erzeugen weg (Realfall 049f6c32)', async () => {
    const iso = 'local:iso/win11-enterprise-eval-26300.9457-de-de.iso';
    const w = welt({ beschreibung: '', isos: [iso, 'local:iso/virtio-win-0.1.302.iso', ANTWORT] });
    (w.px as unknown as Record<string, unknown>).getAllVms = async () => [];
    const r = await w.px.execute({ action: 'build_windows_template', node: 'pve', storage: 'data2-pve', iso, virtio_iso: 'local:iso/virtio-win-0.1.302.iso', variante: 'win11', cloudbase_url: 'https://github.com/cloudbase/cloudbase-init/releases/download/1.1.9/CloudbaseInitSetup_1_1_9_x64.msi', hostname: 'win11-ent-eval-de', new_vmid: 9112 }, imChange);
    expect(r.error).toContain('Test endet');
    const weg = w.ablauf.findIndex(x => x.includes('alfred-antwort-9112.iso'));
    expect(weg).toBeGreaterThanOrEqual(0);
    expect(weg).toBeLessThan(w.ablauf.indexOf('SKRIPT win-antwort'));
  });
});

describe('Ruling R40 erster SSH-Kontakt erst nach Alfreds Host-Schlüssel im Windows-Gast (Realfall 869080b1)', () => {
  afterEach(() => { vi.useRealTimers(); });
  const FREMD = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFremderSchluesselVonSshdBeimErstenStartXXXXXXXX';
  function welt(antworten: Array<{ cb: string; hk: string } | 'fehler'>) {
    const px = new ProxmoxSkill({ baseUrl: 'https://pve:8006', tokenId: 't', tokenSecret: 's' } as never);
    const a = px as unknown as Record<string, unknown>;
    let n = 0; let nachgeholt = 0;
    a.gastAusfuehren = async () => {
      const x = antworten[Math.min(n++, antworten.length - 1)];
      if (x === 'fehler') throw new Error('QEMU guest agent is not running');
      return { code: 0, stdout: `CB=${x.cb}\r\nHK=${x.hk}\r\n`, stderr: '' };
    };
    const warte = (ms: number) => (a.windowsHostSchluesselAbwarten as (v: number, nd: string, h: string, ms: number, f: () => Promise<string>) => Promise<{ ok: boolean; meldung: string }>)
      .call(px, 119, 'pve', `${HOST_PUB} alfred`, ms, async () => { nachgeholt++; return 'Exit 0'; });
    return { warte, aufrufe: () => n, nachgeholt: () => nachgeholt };
  }
  it('fertig eingerichtet mit Alfreds Schlüssel: sofort ok', async () => {
    const r = await welt([{ cb: 'Disabled', hk: `${HOST_PUB} ` }]).warte(60_000);
    expect(r.ok).toBe(true);
    expect(r.meldung).toContain('Host-Schlüssel in der VM ist Alfreds');
  });
  it('von sshd erzeugter Schlüssel nach abgeschlossener Einrichtung: fail-closed ohne SSH', async () => {
    const r = await welt([{ cb: 'Disabled', hk: FREMD }]).warte(60_000);
    expect(r.ok).toBe(false);
    expect(r.meldung).toContain('NICHT Alfreds');
  });
  it('Lücke des Realfalls: erst Agent fehlt, dann sshd-Schlüssel bei laufender Einrichtung, dann Alfreds — wartet statt zu sperren', async () => {
    vi.useFakeTimers();
    const w = welt(['fehler', { cb: 'Automatic', hk: FREMD }, { cb: 'Disabled', hk: HOST_PUB }]);
    const p = w.warte(600_000);
    await vi.advanceTimersByTimeAsync(WIN_SCHLUESSEL_ABSTAND_MS * 3);
    const r = await p;
    expect(r.ok).toBe(true);
    expect(w.aufrufe()).toBe(3);
    expect(w.nachgeholt()).toBe(0);
  });
  it('Zeitüberschreitung: kein ok, Einrichtung einmal nachgeholt', async () => {
    vi.useFakeTimers();
    const w = welt([{ cb: 'Automatic', hk: '' }]);
    const p = w.warte(400_000);
    await vi.advanceTimersByTimeAsync(450_000);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.meldung).toContain('kein SSH-Kontakt');
    expect(w.nachgeholt()).toBe(1);
  });
});
