/**
 * Spec Infrastruktur-Vorhaben, I5 (Owner 22.10.2026 „I5 wie vorgeschlagen umsetzen“) — Vorlagen-Fabrik.
 *
 * Reine Logik ohne Netz: Cloud-Images der Herausgeber (Ubuntu, Debian) mit datiertem Stand und Prüfsumme, Proxmox-Konfiguration einer
 * Vorlage aus einem import-Volume, Cloud-Init-Benutzerdaten für neue VMs (Benutzer alfred mit Schlüssel, von Alfred erzeugter
 * Host-Schlüssel statt ungeprüftem Keyscan, Cloud-Init nach dem ersten Start abgeschaltet, damit der Host-Schlüssel bleibt).
 *
 * Die Prüfsumme wird bei der Planung festgelegt und steht im Change — die Freigabe gilt damit für genau dieses Image; Proxmox prüft
 * sie beim Herunterladen (download-url mit checksum).
 */

export type Distro = 'ubuntu-24.04' | 'ubuntu-26.04' | 'debian-12' | 'debian-13';

interface Quelle { herausgeber: 'ubuntu' | 'debian'; codename: string; basis: string; summen: 'SHA256SUMS' | 'SHA512SUMS'; algorithmus: 'sha256' | 'sha512' }

export const DISTROS: Record<Distro, Quelle> = {
  'ubuntu-24.04': { herausgeber: 'ubuntu', codename: 'noble', basis: 'https://cloud-images.ubuntu.com/releases/noble/', summen: 'SHA256SUMS', algorithmus: 'sha256' },
  'ubuntu-26.04': { herausgeber: 'ubuntu', codename: 'resolute', basis: 'https://cloud-images.ubuntu.com/releases/resolute/', summen: 'SHA256SUMS', algorithmus: 'sha256' },
  'debian-12': { herausgeber: 'debian', codename: 'bookworm', basis: 'https://cloud.debian.org/images/cloud/bookworm/', summen: 'SHA512SUMS', algorithmus: 'sha512' },
  'debian-13': { herausgeber: 'debian', codename: 'trixie', basis: 'https://cloud.debian.org/images/cloud/trixie/', summen: 'SHA512SUMS', algorithmus: 'sha512' },
};

export const istDistro = (x: unknown): x is Distro => typeof x === 'string' && x in DISTROS;

/** Erlaubte Herkunft eines Images (nur die Herausgeber, nur HTTPS) */
export const IMAGE_URL = /^https:\/\/(cloud-images\.ubuntu\.com\/releases\/[a-z]+\/release-\d{8}(\.\d+)?|cloud\.debian\.org\/images\/cloud\/[a-z]+\/\d{8}-\d{4})\/[a-z0-9][\w.-]*\.(img|qcow2)$/;
/** Dateiname im import-Inhalt von Proxmox (nur .qcow2; Proxmox normalisiert sonst) */
export const IMPORT_DATEI = /^[a-z0-9][a-z0-9.+_-]{2,80}\.qcow2$/;
/** Volume-ID im import-Inhalt */
export const IMPORT_VOLUME = /^[a-zA-Z][\w-]{0,40}:import\/[a-z0-9][a-z0-9.+_-]{2,80}\.qcow2$/;
/** Hostname/VM-Name neuer Maschinen */
export const VM_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Neuester datierter Stand aus dem Verzeichnis-Listing (Ubuntu „release-20261017/“, Debian „20261021-2638/“). */
export function neuesterStand(listing: string, herausgeber: 'ubuntu' | 'debian'): string | undefined {
  const muster = herausgeber === 'ubuntu' ? /href="(release-\d{8}(?:\.\d+)?)\/"/g : /href="(\d{8}-\d{4})\/"/g;
  const staende = [...new Set([...listing.matchAll(muster)].map(m => m[1]!))];
  const schluessel = (s: string) => s.replace(/^release-/, '').replace(/\.(\d+)$/, (_, n: string) => `.${n.padStart(3, '0')}`);
  return staende.sort((a, b) => schluessel(a).localeCompare(schluessel(b))).pop();
}

/** Dateiname des Images eines Standes beim Herausgeber */
export function imageDatei(distro: Distro, stand: string): string {
  const q = DISTROS[distro];
  return q.herausgeber === 'ubuntu' ? `${distro}-server-cloudimg-amd64.img` : `${distro}-genericcloud-amd64-${stand}.qcow2`;
}

/** Prüfsumme einer Datei aus SHA256SUMS/SHA512SUMS („<hash> *datei“ oder „<hash>  datei“) */
export function summeAus(text: string, datei: string, algorithmus: 'sha256' | 'sha512'): string | undefined {
  const laenge = algorithmus === 'sha256' ? 64 : 128;
  for (const zeile of text.split(/\r?\n/)) {
    const m = /^([0-9a-f]+)\s+\*?(\S+)$/.exec(zeile.trim());
    if (m && m[2] === datei && m[1]!.length === laenge) return m[1];
  }
  return undefined;
}

export interface ImageAngabe { distro: Distro; stand: string; url: string; checksum: string; checksum_algorithm: 'sha256' | 'sha512'; filename: string }

/** Vollständige Angabe für download_image aus Stand und Summen-Datei */
export function imageAngabe(distro: Distro, stand: string, summenText: string): ImageAngabe | { fehler: string } {
  const q = DISTROS[distro];
  const datei = imageDatei(distro, stand);
  const checksum = summeAus(summenText, datei, q.algorithmus);
  if (!checksum) return { fehler: `${q.summen} von ${distro} (${stand}) enthält ${datei} nicht` };
  const kurz = stand.replace(/^release-/, '');
  return { distro, stand, url: `${q.basis}${stand}/${datei}`, checksum, checksum_algorithm: q.algorithmus, filename: `${distro}-${kurz}.qcow2`.replace(/[^a-z0-9.+_-]/g, '-') };
}

/** Eingaben von download_image prüfen (Herkunft, Prüfsumme, Dateiname) */
export function pruefeDownload(i: { url?: unknown; checksum?: unknown; checksum_algorithm?: unknown; filename?: unknown }): string | undefined {
  if (typeof i.url !== 'string' || !IMAGE_URL.test(i.url)) return 'url muss ein Cloud-Image von cloud-images.ubuntu.com/releases oder cloud.debian.org/images/cloud sein (mit datiertem Stand, list_cloud_images)';
  if (i.checksum_algorithm !== 'sha256' && i.checksum_algorithm !== 'sha512') return 'checksum_algorithm muss sha256 oder sha512 sein';
  if (typeof i.checksum !== 'string' || !new RegExp(`^[0-9a-f]{${i.checksum_algorithm === 'sha256' ? 64 : 128}}$`).test(i.checksum)) return 'checksum fehlt oder passt nicht zum Algorithmus (list_cloud_images liefert sie)';
  if (typeof i.filename !== 'string' || !IMPORT_DATEI.test(i.filename)) return 'filename: Kleinbuchstaben, Ziffern, . + _ - und Endung .qcow2';
  return undefined;
}

/** Proxmox-Konfiguration (POST /nodes/{node}/qemu) einer Vorlage aus einem import-Volume */
export function vorlagenKonfig(v: { vmid: number; name: string; storage: string; image: string; bridge?: string; memory?: number; cores?: number; beschreibung?: string }): Record<string, unknown> {
  return {
    vmid: v.vmid, name: v.name, ostype: 'l26', machine: 'q35', bios: 'seabios', cpu: 'x86-64-v2-AES',
    memory: v.memory ?? 2048, cores: v.cores ?? 2, scsihw: 'virtio-scsi-single',
    scsi0: `${v.storage}:0,import-from=${v.image},discard=on,iothread=1,ssd=1`,
    ide2: `${v.storage}:cloudinit`, boot: 'order=scsi0', serial0: 'socket', vga: 'serial0', agent: 'enabled=1',
    net0: `virtio,bridge=${v.bridge ?? 'vmbr0'}`,
    ...(v.beschreibung ? { description: v.beschreibung } : {}),
  };
}

const SSH_OEFFENTLICH = /^(ssh-ed25519|ecdsa-sha2-nistp(256|384|521)|ssh-rsa) [A-Za-z0-9+/=]{40,1200}( [\w@.+-]{0,80})?$/;
const SSH_PRIVAT = /^-----BEGIN OPENSSH PRIVATE KEY-----\n[A-Za-z0-9+/=\n]{100,5000}\n-----END OPENSSH PRIVATE KEY-----\n?$/;

/** Cloud-Init-Benutzerdaten (Snippet) einer neuen VM. Wirft bei ungültigen Eingaben — nichts Ungeprüftes landet im YAML. */
export function cloudInitBenutzerDaten(v: { hostname: string; alfredSchluessel: string; weitereSchluessel?: string[]; hostPrivat: string; hostOeffentlich: string }): string {
  if (!VM_NAME.test(v.hostname)) throw new Error(`ungültiger Hostname „${v.hostname}“`);
  const schluessel = [v.alfredSchluessel, ...(v.weitereSchluessel ?? [])].map(s => s.trim());
  for (const s of schluessel) if (!SSH_OEFFENTLICH.test(s)) throw new Error('ungültiger öffentlicher SSH-Schlüssel');
  const hostOeff = v.hostOeffentlich.trim();
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]{40,200}( \S*)?$/.test(hostOeff)) throw new Error('Host-Schlüssel muss ed25519 sein');
  const privat = v.hostPrivat.replace(/\r\n/g, '\n');
  if (!SSH_PRIVAT.test(privat)) throw new Error('privater Host-Schlüssel hat nicht das OpenSSH-Format');
  const block = privat.trimEnd().split('\n').map(z => `    ${z}`).join('\n');
  return [
    '#cloud-config',
    `hostname: ${v.hostname}`,
    'manage_etc_hosts: true',
    'users:',
    '  - name: alfred',
    '    gecos: Alfred',
    '    shell: /bin/bash',
    '    groups: [sudo]',
    '    sudo: "ALL=(ALL) NOPASSWD:ALL"',
    '    lock_passwd: true',
    '    ssh_authorized_keys:',
    ...schluessel.map(s => `      - ${JSON.stringify(s)}`),
    'disable_root: true',
    'ssh_pwauth: false',
    'ssh_deletekeys: true',
    'ssh_genkeytypes: []',
    'ssh_keys:',
    '  ed25519_private: |',
    block,
    `  ed25519_public: ${JSON.stringify(hostOeff)}`,
    'package_update: true',
    'packages: [qemu-guest-agent]',
    'runcmd:',
    '  - [systemctl, enable, --now, qemu-guest-agent]',
    // Danach nie wieder Cloud-Init: sonst erzeugt ein neuer Datenstand (oder ein entferntes Laufwerk) neue Host-Schlüssel und der Fernzugang sperrt
    '  - [touch, /etc/cloud/cloud-init.disabled]',
    '',
  ].join('\n');
}

/** Dateiname des Snippets einer VM */
export const snippetDatei = (vmid: number) => `alfred-${vmid}-user.yaml`;
