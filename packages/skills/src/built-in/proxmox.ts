import type { SkillMetadata, SkillContext, SkillResult, ProxmoxConfig } from '@alfred/types';
import { readFileSync } from 'node:fs';
import { Skill } from '../skill.js';
import { randomBytes } from 'node:crypto';
import { evalLinks, serverSeiten, WIN11_SEITE, WIN_ISO_URL, VIRTIO_URL, CLOUDBASE_URL, VIRTIO_ARCHIV, buildAusUrl, neuesteVirtio, isoDateiname, ISO_DATEI, ISO_VOLUME, SPRACHE, istWinVariante, WIN_VARIANTEN, waehleAbbild, virtioOrdner, VIRTIO_TREIBER, autounattend, sysprepUnattend, setupSkript, CLOUDBASE_CONF, CLOUDBASE_UNATTEND_CONF, windowsBauKonfig, knotenJson, zufallsKennwort, windowsBenutzerDaten, WIN_EINRICHTUNG_NACHHOLEN, type WimAbbild, type WinVariante } from './windows-fabrik.js';
import { tlsFetch } from './social/tls-fetch.js'; // v1385 — Zertifikatsprüfung request-lokal statt prozessweit
import { getrennteNetze, alleNetzeGetrennt, sicherungsJobPruefung, SICHERUNGSJOB_ID, type SicherungsJobVorhanden, vlanBridgePlan, sicherungsAusnahme, ALFRED_BRIDGE_KOMMENTAR, type NetzIface, DISTROS, istDistro, neuesterStand, imageAngabe, summenUrl, distroAusImage, pruefeDownload, vorlagenKonfig, cloudInitBenutzerDaten, snippetDatei, IMPORT_VOLUME, VM_NAME, type Distro, type ImageAngabe } from './proxmox-fabrik.js';

/** I5 — was die Vorlagen-Fabrik vom Server braucht (SSH auf den Knoten, Fernzugang, CMDB); verdrahtet in alfred.ts */
export interface VmFabrikDeps {
  /** neuer ed25519-Host-Schlüssel für eine VM (OpenSSH-Format) */
  hostSchluessel(): Promise<{ privat: string; oeffentlich: string }>;
  /** öffentlicher Schlüssel, mit dem Alfred sich anmeldet */
  alfredSchluessel(): Promise<string>;
  /** Hindernisse vor dem Anlegen (Name als Fernzugang vergeben, IP antwortet schon …) — leer = frei */
  vorpruefung(v: { name: string; ip: string }): Promise<string[]>;
  /** Snippet am Knoten schreiben (über dessen Fernzugang, Rechte 600) bzw. entfernen */
  snippetSchreiben(node: string, pfad: string, inhalt: string): Promise<void>;
  snippetEntfernen(node: string, pfad: string): Promise<void>;
  /** Fernzugang mit dem bekannten Host-Schlüssel + CMDB-Eintrag anlegen und warten, bis SSH und Cloud-Init fertig sind */
  anmelden(v: { name: string; ip: string; node: string; vmid: number; hostSchluessel: string; vorlage: number; zeitlimitMs: number; system?: 'linux' | 'windows'; nachholen?: () => Promise<string> }): Promise<{ ok: boolean; meldung: string }>;
  /** Fernzugang entfernen, CMDB-Eintrag stilllegen; nurVmid: eine andere VM trägt den Namen noch → nur den Eintrag dieser VMID stilllegen */
  abmelden(v: { name: string; node: string; vmid: number; nurVmid?: boolean }): Promise<string>;
  /** Abgebrochene Bereitstellung fortsetzen: Fernzugang (mit dem Host-Schlüssel der VM) besteht schon — nur auf SSH/Cloud-Init warten */
  fortsetzen?(v: { name: string; ip: string; node: string; vmid: number; zeitlimitMs: number }): Promise<{ ok: boolean; meldung: string }>;
  /** I8a — festes Skript der Windows-Fabrik am Knoten (Auswahl über den Namen, nie Modelltext), Eingabe JSON über stdin; liefert stdout */
  knotenSkript?(node: string, art: 'win-inspektion' | 'win-antwort', eingabe: string, timeoutMs: number): Promise<string>;
  /** I8a — Kennwort einer neuen Windows-VM im Tresor ablegen; liefert den Namen des Eintrags */
  kennwortSichern?(vmName: string, wert: string, konto?: string): Promise<string>;
  /** v1745 — öffentlicher SSH-Schlüssel des Owners (Tresor owner-ssh-oeffentlich), für den eigenen Zugang */
  ownerSchluessel?(): Promise<string | undefined>;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface VmEntry {
  vmid: number;
  node: string;
  type: 'qemu' | 'lxc';
  name?: string;
  status?: string;
  maxmem?: number;
  mem?: number;
  maxdisk?: number;
  disk?: number;
  cpus?: number;
  cpu?: number;
  uptime?: number;
  netin?: number;
  netout?: number;
}

/**
 * v1537 (Owner 21.10. „A+B+C“) — VM über ihren Namen statt über die Nummer. Realfall 21.10.: Der Denk-Durchlauf schlug
 * `vm_status` mit `{"vm":"git-server"}` vor, der Skill kannte nur `vmid` → „Missing required vmid“ bei jedem Klick.
 * Genau gleichnamig (ohne Groß/Klein) gewinnt, sonst — nur bei lesenden Aktionen — ein eindeutiger Teiltreffer; mehrdeutig oder unbekannt → klare Meldung.
 */
export function vmNameAufloesen(entries: { vmid: number; name?: string; node: string }[], name: string, opts: { nurGenau?: boolean } = {}): { vmid: number } | { fehler: string } {
  const n = name.trim().toLowerCase();
  if (!n) return { fehler: 'Leerer VM-Name' };
  const genau = entries.filter(e => (e.name ?? '').toLowerCase() === n);
  if (genau.length === 1) return { vmid: genau[0]!.vmid };
  // v1538 — verändernde Aktionen (stoppen, zurückspielen, migrieren …) nur bei genau gleichem Namen: ein Teiltreffer darf nie das Ziel bestimmen
  if (opts.nurGenau && genau.length === 0) return { fehler: `Keine VM heißt genau „${name}“ — für diese Aktion die vmid oder den vollständigen Namen angeben.` };
  const kandidaten = genau.length > 1 ? genau : entries.filter(e => (e.name ?? '').toLowerCase().includes(n));
  if (kandidaten.length === 1) return { vmid: kandidaten[0]!.vmid };
  if (kandidaten.length === 0) return { fehler: `Keine VM mit Namen „${name}“ gefunden. Mit "list_vms" die vorhandenen VMs ansehen.` };
  return { fehler: `Name „${name}“ ist mehrdeutig: ${kandidaten.slice(0, 6).map(e => `${e.vmid} ${e.name ?? '-'} (${e.node})`).join(', ')} — vmid angeben.` };
}

/** Aktionen, deren `vmid` eine vorhandene VM meint (bei clone_vm/create_lxc ist `name` der Name der NEUEN Maschine). */
/** v1538 — nur lesende VM-Aktionen dürfen einen eindeutigen Teiltreffer im Namen verwenden. */
const VM_LESE_AKTIONEN = new Set(['vm_status', 'list_snapshots', 'wait_ready', 'backups_vm', 'agent_status']);
/** I5 — Vorlagen-Fabrik */
const FABRIK_AKTIONEN = ['list_cloud_images', 'download_image', 'delete_image', 'create_template', 'provision_vm', 'delete_vm', 'delete_backup', 'list_backup_jobs', 'create_backup_job', 'delete_backup_job', 'restore_backup', 'isolate_vm', 'list_windows_images', 'download_iso', 'build_windows_template', 'windows_build_log', 'finish_windows_template', 'delete_iso', 'provision_windows_vm', 'create_vlan_bridge', 'delete_vlan_bridge', 'backup_job_exclude', 'set_vm_resources'] as const;
/** Owner 22.10. („die alten Sicherungen kann man löschen“): nur echte vzdump-Sicherungsdateien */
const SICHERUNG_VOLUME = /^[a-zA-Z][\w-]{0,40}:backup\/vzdump-(qemu|lxc)-\d{1,9}-\d{4}_\d{2}_\d{2}-\d{2}_\d{2}_\d{2}\.(vma|tar)(\.(zst|gz|lzo))?$/;
/** v1771 — PBS-Sicherung einer VM (Realfall 07.11. Change 6f8f54d1: Wiederherstellungstest von VM 100 aus pbs-pve2); nur zum Wiederherstellen */
const PBS_VM_SICHERUNG = /^[a-zA-Z][\w-]{0,40}:backup\/vm\/\d{1,9}\/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
/** Spec I5: Anlegen und Entfernen laufen nur als Schritte freigegebener Changes (Freigabe, Rückweg, Protokoll) — nie direkt aus dem Chat */
const NUR_IM_CHANGE = new Set<string>(['download_image', 'delete_image', 'create_template', 'provision_vm', 'delete_vm', 'delete_backup', 'create_backup_job', 'delete_backup_job', 'restore_backup', 'isolate_vm', 'download_iso', 'build_windows_template', 'finish_windows_template', 'delete_iso', 'provision_windows_vm', 'create_vlan_bridge', 'delete_vlan_bridge', 'backup_job_exclude', 'set_vm_resources']);
/** v1626 — Wartezeit auf den Gast-Agent nach der Bereitstellung (Paketinstallation beim ersten Start braucht etwas) */
const AGENT_WARTEN_MS = 180_000;
const AGENT_ABSTAND_MS = 10_000;
const VM_ZIEL_AKTIONEN = new Set(['agent_status', 'backups_vm', 'vm_status', 'list_snapshots', 'start_vm', 'shutdown_vm', 'reboot_vm', 'suspend_vm', 'resume_vm', 'stop_vm', 'create_snapshot', 'backup_vm', 'migrate_vm', 'delete_snapshot', 'rollback_snapshot', 'wait_ready']);

type Action =
  // read
  | 'cluster_status'
  | 'list_nodes'
  | 'node_stats'
  | 'list_vms'
  | 'vm_status'
  | 'list_snapshots'
  | 'list_storage'
  | 'backups_vm'
  | 'list_tasks'
  | 'task_status'
  // write
  | 'start_vm'
  | 'shutdown_vm'
  | 'reboot_vm'
  | 'suspend_vm'
  | 'resume_vm'
  | 'create_snapshot'
  | 'backup_vm'
  | 'migrate_vm'
  // admin
  | 'stop_vm'
  | 'delete_snapshot'
  | 'rollback_snapshot'
  // infra
  | 'list_templates'
  | 'create_lxc'
  | 'clone_vm'
  | 'list_networks'
  | 'wait_ready'
  | 'agent_status'
  | 'api_raw'
  | typeof FABRIK_AKTIONEN[number];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bytes(n: number | undefined): string {
  if (n == null) return '-';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  return `${(n / 1024 ** 3).toFixed(2)} GiB`;
}

function pct(v: number | undefined): string {
  if (v == null) return '-';
  return `${(v * 100).toFixed(1)}%`;
}

function uptimeStr(seconds: number | undefined): string {
  if (!seconds) return '-';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// ProxmoxSkill
// ---------------------------------------------------------------------------

export class ProxmoxSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'proxmox',
    category: 'infrastructure',
    description:
      'Manage Proxmox VE virtual machines, containers, and cluster. ' +
      '"clone_vm" klont VM aus Template mit Cloud-Init (hostname, template=VMID, ip, gateway). Mit runtime=docker/node/python wird nach Erstellung automatisch SSH abgewartet und die Runtime + qemu-guest-agent installiert. ' +
      '"create_lxc" erstellt LXC Container. ' +
      '"list_vms" zeigt VMs, "start_vm"/"shutdown_vm" steuert sie, "cluster_status" für Health, "create_snapshot" für Backups. ' +
      'Vorlagen-Fabrik (I5, nur als Schritte freigegebener Changes): "list_cloud_images" (distro → datierter Stand, url, checksum, filename) → "download_image" (node, storage mit Inhalt import, url, checksum, checksum_algorithm, filename) → "create_template" (node, storage, image=Volume, new_vmid, hostname=Name) → "provision_vm" (template, hostname, node, storage, ip CIDR, gateway; Benutzer alfred, Host-Schlüssel von Alfred, Fernzugang + CMDB automatisch). Rückwege: delete_image (volid), delete_vm (vmid + vm_name zur Bestätigung, force_stop). ' +
      'Rettungskopie (nur Change): "restore_backup" (node, volid der vzdump-Sicherung, new_vmid frei, storage, hostname) stellt als NEUE VM wieder her, ohne Start, mit neuen MACs — danach sofort "isolate_vm" (vmid, vm_name) trennt alle Netzwerkkarten, Autostart aus; Rückweg delete_vm. ' +
      'Windows-Vorlagen (I8a, nur als Schritte freigegebener Changes außer den Lese-Aktionen): "list_windows_images" (sprache, z. B. en-us) → aktuellste Server-Testversion und Windows 11 Enterprise (url, build, filename), VirtIO-ISO, Cloudbase-Init-MSI → "download_iso" (node, storage mit Inhalt iso — nicht backupshare, der ist fast voll —, url, filename) → "build_windows_template" (node, storage für die Platten, iso=Volume des Windows-ISO, virtio_iso=Volume, variante server-standard-core|server-standard-desktop|server-datacenter-core|server-datacenter-desktop|win11, cloudbase_url aus list_windows_images, new_vmid, hostname) startet die unbeaufsichtigte Installation; die VM schaltet sich nach sysprep selbst aus (Warten bis vm_status „stopped“, 30–90 min; bei Zeitüberschreitung "windows_build_log" (vmid) liest das Einrichtungsprotokoll über den Gast-Agenten) → "finish_windows_template" (vmid, vm_name) entfernt CDs und Antwort-ISO und macht die Vorlage; Rückweg delete_vm. "delete_iso" (volid) entfernt ein ISO. "provision_windows_vm" (template = Windows-Vorlage, hostname höchstens 15 Zeichen, node, storage, ip CIDR, gateway, nameserver, memory, cores, disk_size; zeitlimitS 2400; Rückweg delete_vm mit force_stop) — Konto alfred mit Alfreds Schlüssel, Host-Schlüssel von Alfred, Kennwort im Tresor (win-<name>-admin), Fernzugang (Windows, Leseliste) + CMDB; extra_disk_size = zweite Platte (scsi1). ' +
      'I8c (nur in Changes): "set_vm_resources" (vmid, memory MiB, cores) — alte Werte im Ergebnis (Rückweg), bei laufender VM wirksam nach "reboot_vm". "create_vlan_bridge" (node, vlan, ueber = nicht VLAN-fähige Bridge wie vmbr0, bridge optional) legt eine Bridge mit Port <ueber>.<vlan> an und lädt das Netz neu — nur wenn auf dem Knoten nichts anderes aussteht; ist ueber VLAN-fähig, VM stattdessen mit vlan_tag anbinden; Rückweg "delete_vlan_bridge" (node, bridge; nur Alfreds Bridges ohne VMs). "backup_job_exclude" (job_id alfred-…, add_vmids / remove_vmids) ändert die Ausnahmeliste eines Jobs „alle VMs“; Rückweg mit vertauschten Listen. ' +
      'Sicherungsjobs: "list_backup_jobs" (lesen); "create_backup_job" (nur Change: job_id alfred-…, vmids, storage, schedule z. B. „sat 03:00“, keep_last, optional bwlimit KiB/s) mit Rückweg "delete_backup_job" (job_id).',
    riskLevel: 'write',
    version: '1.0.0',
    timeoutMs: 600_000, // 10 min — clone + SSH wait + runtime install can take 5+ min
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'cluster_status',
            'list_nodes',
            'node_stats',
            'list_vms',
            'vm_status',
            'list_snapshots',
            'list_storage',
            'backups_vm',
            'list_tasks',
            'task_status',
            'start_vm',
            'shutdown_vm',
            'reboot_vm',
            'suspend_vm',
            'resume_vm',
            'create_snapshot',
            'backup_vm',
            'migrate_vm',
            'stop_vm',
            'delete_snapshot',
            'rollback_snapshot',
            'list_templates',
            'create_lxc',
            'clone_vm',
            'list_networks',
            'wait_ready',
            'agent_status',
            ...FABRIK_AKTIONEN,
          ],
          description: 'The Proxmox action to perform',
        },
        vmid: {
          type: 'number',
          description: 'Virtual machine / container ID',
        },
        vm: {
          type: 'string',
          description: 'VM-/Container-Name statt vmid (wird über die VM-Liste aufgelöst)',
        },
        node: {
          type: 'string',
          description: 'Proxmox node name (optional — resolved automatically when omitted)',
        },
        type: {
          type: 'string',
          enum: ['qemu', 'lxc'],
          description: 'VM type filter for list_vms (default: both)',
        },
        name: {
          type: 'string',
          description: 'Snapshot name (for create/delete/rollback_snapshot)',
        },
        description: {
          type: 'string',
          description: 'Snapshot description (optional)',
        },
        target: {
          type: 'string',
          description: 'Target node for migration',
        },
        storage: {
          type: 'string',
          description: 'Storage target for backup_vm',
        },
        upid: {
          type: 'string',
          description: 'Task UPID for task_status',
        },
        // Infra
        template: {
          type: 'string',
          description: 'Template-Name oder VMID für clone_vm, oder OS-Template für create_lxc (z.B. ubuntu-22.04)',
        },
        hostname: {
          type: 'string',
          description: 'Hostname für neue VM/LXC',
        },
        memory: {
          type: 'number',
          description: 'RAM in MB (default: 2048)',
        },
        cores: {
          type: 'number',
          description: 'CPU Cores (default: 2)',
        },
        disk_size: {
          type: 'number',
          description: 'Disk-Größe in GB (default: 8)',
        },
        ip: {
          type: 'string',
          description: 'Statische IP mit CIDR (z.B. 192.168.1.95/24)',
        },
        gateway: {
          type: 'string',
          description: 'Gateway-IP',
        },
        bridge: {
          type: 'string',
          description: 'Netzwerk-Bridge (z.B. vmbr0, vmbr1)',
        },
        vlan_tag: {
          type: 'number',
          description: 'VLAN-Tag',
        },
        ssh_public_key: {
          type: 'string',
          description: 'SSH Public Key für Cloud-Init (default: aus infra.sshKeyPath)',
        },
        new_vmid: {
          type: 'number',
          description: 'VMID für neue VM (auto wenn nicht angegeben)',
        },
        runtime: {
          type: 'string',
          enum: ['docker', 'node', 'python'],
          description: 'Nach VM-Erstellung: Runtime installieren (docker, node, python). Installiert auch qemu-guest-agent. Wartet automatisch auf SSH.',
        },
        // I5 — Vorlagen-Fabrik
        distro: { type: 'string', enum: Object.keys(DISTROS), description: `list_cloud_images: ${Object.keys(DISTROS).join(', ')} (leer = alle)` },
        url: { type: 'string', description: 'download_image: Image-URL des Herausgebers mit datiertem Stand (aus list_cloud_images)' },
        checksum: { type: 'string', description: 'download_image: Prüfsumme des Herausgebers (aus list_cloud_images)' },
        checksum_algorithm: { type: 'string', enum: ['sha256', 'sha512'], description: 'download_image: sha512 (Debian), sonst sha256 — aus list_cloud_images übernehmen' },
        filename: { type: 'string', description: 'download_image: Dateiname im import-Speicher (…qcow2, aus list_cloud_images); download_iso: Dateiname …iso aus list_windows_images' },
        // I8a — Windows-Vorlagen
        sprache: { type: 'string', description: 'list_windows_images: Sprache des ISO, z. B. en-us (Standard) oder de-de' },
        variante: { type: 'string', enum: WIN_VARIANTEN, description: 'build_windows_template: Edition und Ausprägung' },
        iso: { type: 'string', description: 'build_windows_template: Volume des Windows-ISO (speicher:iso/…iso)' },
        virtio_iso: { type: 'string', description: 'build_windows_template: Volume des VirtIO-ISO' },
        cloudbase_url: { type: 'string', description: 'build_windows_template: Cloudbase-Init-MSI aus list_windows_images' },
        owner_konto: { type: 'string', description: 'provision_vm/provision_windows_vm: eigenes Konto des Owners (Standard madh, leer = keins). Linux: nur Schlüssel-Anmeldung mit dem Tresor-Schlüssel owner-ssh-oeffentlich, sudo. Windows: Administrator, Kennwort im Tresor win-<name>-<konto>' },
        rdp: { type: 'boolean', description: 'provision_windows_vm: Remotedesktop einschalten (nur auf Wunsch des Owners; mit NLA)' },
        image: { type: 'string', description: 'create_template: Volume des Images, z. B. backupshare:import/ubuntu-24.04-20261017.qcow2' },
        volid: { type: 'string', description: 'delete_image: Volume im import-Speicher' },
        nameserver: { type: 'string', description: 'provision_vm: DNS-Server (IP, mehrere mit Leerzeichen)' },
        vm_name: { type: 'string', description: 'delete_vm: Name der VM zur Bestätigung (muss zur vmid passen)' },
        force_stop: { type: 'boolean', description: 'delete_vm: laufende VM vorher hart stoppen (nur für Rückwege frisch angelegter VMs)' },
        job_id: { type: 'string', description: 'create_/delete_backup_job: Job-ID, immer alfred-… (z. B. alfred-uebergang)' },
        vmids: { type: 'array', items: { type: 'number' }, description: 'create_backup_job: zu sichernde VMIDs' },
        add_vmids: { type: 'array', items: { type: 'number' }, description: 'backup_job_exclude: VMIDs, die der Job (alle VMs) künftig auslässt' },
        remove_vmids: { type: 'array', items: { type: 'number' }, description: 'backup_job_exclude: VMIDs, die wieder gesichert werden (Rückweg)' },
        vlan: { type: 'number', description: 'create_vlan_bridge: VLAN-ID' },
        ueber: { type: 'string', description: 'create_vlan_bridge: nicht VLAN-fähige Bridge/Netzkarte des Knotens, über die das VLAN läuft (z. B. vmbr0)' },
        extra_disk_size: { type: 'number', description: 'provision_windows_vm: zweite Platte in GB (scsi1, gleicher Speicher wie storage), z. B. Sicherungsplatte' },
        schedule: { type: 'string', description: 'create_backup_job: Proxmox-Kalender, z. B. „sat 03:00“ oder „*-*-* 02:30“' },
        keep_last: { type: 'number', description: 'create_backup_job: so viele Sicherungen je VM behalten (1–30)' },
        bwlimit: { type: 'number', description: 'create_backup_job: Bandbreitengrenze in KiB/s (optional, schont den Zielspeicher)' },
        docker_bridge_ip: {
          type: 'string',
          description: 'Docker Bridge IP (z.B. 192.168.248.1/24). Setzt daemon.json bip. Nur bei runtime=docker.',
        },
      },
      required: ['action'],
    },
  };

  private readonly config: ProxmoxConfig;
  private vmCache: { entries: VmEntry[]; ts: number } | null = null;
  private static readonly VM_CACHE_TTL = 30_000; // 30 seconds
  private sshKeyPath?: string;
  private sshUser?: string;
  private postProvisionFn?: (host: string, user: string, runtime: string, isRhel: boolean, opts?: { dockerBridgeIp?: string }) => Promise<string[]>;

  constructor(config: ProxmoxConfig) {
    super();
    this.config = config;
  }

  /** Set SSH key path for Cloud-Init auto-injection on clone_vm/create_lxc. */
  setSshKeyPath(path: string): void { this.sshKeyPath = path; }
  /** v1537 — VM-Aktionen brauchen eine VM-Nummer oder einen Namen (vm / vm_name / name), sonst ist der Vorschlag unvollständig. */
  pruefeEingabe(input: Record<string, unknown>): string | undefined {
    const action = input.action as string | undefined;
    if (action === 'delete_vm') {
      const vmid = typeof input.vmid === 'number' ? input.vmid : typeof input.vmid === 'string' && /^\d+$/.test(input.vmid.trim()) ? Number(input.vmid) : NaN;
      if (!Number.isInteger(vmid) || vmid < 1) return 'delete_vm braucht die vmid (Zahl)'; // Schutz ist vm_name; ab 1, damit Verweise {{schrittN.vmid}} die Planprüfung bestehen
      if (typeof input.vm_name !== 'string' || !input.vm_name.trim()) return 'delete_vm braucht vm_name zur Bestätigung';
      return undefined;
    }
    // v1639 — Realfall 2bb39131: Proxmox erlaubt Snapshot-Namen nur bis 40 Zeichen (Buchstabe zuerst, dann Buchstaben/Ziffern/_/-)
    if (['create_snapshot', 'delete_snapshot', 'rollback_snapshot'].includes(String(action)) && typeof input.name === 'string' && !/^\{\{/.test(input.name) && !/^[A-Za-z][A-Za-z0-9_-]{1,39}$/.test(input.name)) return `${String(action)}: Snapshot-Name „${input.name.slice(0, 60)}“ ungültig — höchstens 40 Zeichen, mit einem Buchstaben beginnend, nur Buchstaben, Ziffern, _ und -`;
    if (action === 'download_image') return pruefeDownload(input) ?? (typeof input.storage === 'string' && input.storage ? undefined : 'download_image braucht storage (mit Inhalt import)');
    if (action === 'create_template') {
      if (typeof input.image !== 'string' || !IMPORT_VOLUME.test(input.image)) return 'create_template: image muss ein import-Volume sein (storage:import/datei.qcow2)';
      if (typeof input.hostname !== 'string' || !VM_NAME.test(input.hostname)) return 'create_template: hostname (Name der Vorlage) aus Kleinbuchstaben, Ziffern, -';
      if (typeof input.storage !== 'string' || !input.storage) return 'create_template braucht storage (Ziel der Platte)';
      return undefined;
    }
    if (action === 'provision_vm') {
      if (typeof input.hostname !== 'string' || !VM_NAME.test(input.hostname)) return 'provision_vm: hostname aus Kleinbuchstaben, Ziffern, -';
      if (typeof input.ip !== 'string' || !/^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(input.ip)) return 'provision_vm: ip als CIDR (z. B. 192.168.1.140/24) — feste Adresse, damit Alfred den Host sicher erreicht';
      if (typeof input.gateway !== 'string' || !/^(\d{1,3}\.){3}\d{1,3}$/.test(input.gateway)) return 'provision_vm braucht gateway';
      if (input.template === undefined || !/^\d+$/.test(String(input.template))) return 'provision_vm: template als VMID';
      return undefined;
    }
    if (action === 'delete_image' && (typeof input.volid !== 'string' || !IMPORT_VOLUME.test(input.volid))) return 'delete_image: volid eines import-Volumes';
    if (!action || !VM_ZIEL_AKTIONEN.has(action)) return undefined;
    if (typeof input.vmid === 'number' || (typeof input.vmid === 'string' && input.vmid.trim())) return undefined;
    if ([input.vm, input.vm_name, input.vmname].some(x => typeof x === 'string' && x.trim())) return undefined; // v1538 — `name` ist bei Snapshots der Snapshot-Name
    return `${action} braucht vmid oder vm (Name)`;
  }

  /** I5 — Vorlagen-Fabrik: Server-Anteile (Knoten-SSH, Fernzugang, CMDB) */
  private fabrik?: VmFabrikDeps;
  setVmFabrik(deps: VmFabrikDeps): void { this.fabrik = deps; }

  /** Set default SSH user for post-provision. */
  setSshUser(user: string): void { this.sshUser = user; }

  /** Set callback for post-provision runtime installation (SSH wait + install). */
  setPostProvisionCallback(fn: (host: string, user: string, runtime: string, isRhel: boolean, opts?: { dockerBridgeIp?: string }) => Promise<string[]>): void {
    this.postProvisionFn = fn;
  }

  // -----------------------------------------------------------------------
  // execute — main dispatch
  // -----------------------------------------------------------------------

  async execute(
    input: Record<string, unknown>,
    _context: SkillContext,
  ): Promise<SkillResult> {
    const action = input.action as Action | undefined;
    if (!action) {
      return { success: false, error: 'Missing required field "action"' };
    }
    if (NUR_IM_CHANGE.has(action) && _context?.ausChange !== true) {
      return { success: false, error: `${action} läuft nur als Schritt eines freigegebenen Changes — mit infrastruktur changes_planen planen und die Freigabe anfragen` };
    }

    try {
      // v1537 — vmid als Text („105“) oder VM über den Namen (vm / vm_name bzw. nicht-numerische vmid); v1538 verändernd nur genau
      if (VM_ZIEL_AKTIONEN.has(action)) {
        if (typeof input.vmid === 'string' && /^\d+$/.test(input.vmid.trim())) input = { ...input, vmid: Number(input.vmid.trim()) };
        if (typeof input.vmid !== 'number') {
          const name = [input.vm, input.vm_name, input.vmname, typeof input.vmid === 'string' ? input.vmid : undefined].find(x => typeof x === 'string' && x.trim()) as string | undefined; // v1538 ohne `name` (Snapshot-Name)
          if (name) {
            const r = vmNameAufloesen(await this.getAllVms(), name, { nurGenau: !VM_LESE_AKTIONEN.has(action) });
            if ('fehler' in r) return { success: false, error: r.fehler };
            input = { ...input, vmid: r.vmid };
          }
        }
      }
      switch (action) {
        // read
        case 'cluster_status':
          return await this.clusterStatus();
        case 'list_nodes':
          return await this.listNodes();
        case 'node_stats':
          return await this.nodeStats(input.node as string | undefined);
        case 'list_vms':
          return await this.listVms(
            input.node as string | undefined,
            input.type as 'qemu' | 'lxc' | undefined,
          );
        case 'vm_status':
          return await this.vmStatus(
            input.vmid as number | undefined,
            input.node as string | undefined,
          );
        case 'list_snapshots':
          return await this.listSnapshots(
            input.vmid as number | undefined,
            input.node as string | undefined,
          );
        case 'list_storage':
          return await this.listStorage(input.node as string | undefined);
        case 'backups_vm':
          return await this.backupsVm(input.vmid as number | undefined);
        case 'list_tasks':
          return await this.listTasks(input.node as string | undefined);
        case 'task_status':
          return await this.taskStatus(input.upid as string | undefined);

        // write
        case 'start_vm':
          return await this.vmPowerAction('start', input);
        case 'shutdown_vm':
          return await this.vmPowerAction('shutdown', input);
        case 'reboot_vm':
          return await this.vmPowerAction('reboot', input);
        case 'suspend_vm':
          return await this.vmPowerAction('suspend', input);
        case 'resume_vm':
          return await this.vmPowerAction('resume', input);
        case 'stop_vm':
          return await this.vmPowerAction('stop', input);
        case 'create_snapshot':
          return await this.createSnapshot(input);
        case 'backup_vm':
          return await this.backupVm(input);
        case 'migrate_vm':
          return await this.migrateVm(input);
        case 'delete_snapshot':
          return await this.deleteSnapshot(input);
        case 'rollback_snapshot':
          return await this.rollbackSnapshot(input);

        // ── INFRA ─────────────────────────────────────────────
        case 'list_templates':
          return await this.listTemplates(input);
        case 'create_lxc':
          return await this.createLxc(input);
        case 'clone_vm':
          return await this.cloneVm(input);
        case 'list_networks':
          return await this.listNetworksAction(input);
        case 'wait_ready':
          return await this.waitReady(input);
        case 'agent_status':
          return await this.agentStatus(input.vmid as number | undefined, input.node as string | undefined);

        // ── I5 VORLAGEN-FABRIK ────────────────────────────────
        case 'list_cloud_images':
          return await this.listCloudImages(input);
        case 'download_image':
          return await this.downloadImage(input);
        case 'delete_image':
          return await this.deleteImage(input);
        case 'delete_backup':
          return await this.deleteBackup(input);
        case 'list_backup_jobs':
          return await this.listBackupJobs();
        case 'restore_backup':
          return await this.restoreBackup(input);
        case 'isolate_vm':
          return await this.isolateVm(input);
        case 'create_backup_job':
          return await this.createBackupJob(input);
        case 'delete_backup_job':
          return await this.deleteBackupJob(input);
        case 'create_template':
          return await this.createTemplate(input);
        case 'provision_vm':
          return await this.provisionVm(input);
        case 'delete_vm':
          return await this.deleteVm(input);
        case 'list_windows_images':
          return await this.listWindowsImages(input);
        case 'download_iso':
          return await this.downloadIso(input);
        case 'delete_iso':
          return await this.deleteIso(input);
        case 'build_windows_template':
          return await this.buildWindowsTemplate(input);
        case 'windows_build_log':
          return await this.windowsBuildLog(input);
        case 'finish_windows_template':
          return await this.finishWindowsTemplate(input);
        case 'provision_windows_vm':
          return await this.provisionWindowsVm(input);
        case 'create_vlan_bridge':
          return await this.vlanBridgeAnlegen(input);
        case 'delete_vlan_bridge':
          return await this.vlanBridgeEntfernen(input);
        case 'backup_job_exclude':
          return await this.sicherungAusnehmen(input);
        case 'set_vm_resources':
          return await this.vmRessourcen(input);

        case 'api_raw': {
          const rawPath = input.path as string;
          if (!rawPath) return { success: false, error: 'path erforderlich' };
          const data = await this.get(rawPath);
          return { success: true, data };
        }

        default:
          return { success: false, error: `Unknown action "${action as string}"` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: `Proxmox API error: ${msg}. Check baseUrl and connectivity.`,
      };
    }
  }

  // -----------------------------------------------------------------------
  // HTTP helpers
  // -----------------------------------------------------------------------

  private async api<T = unknown>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const url = `${this.config.baseUrl}/api2/json${path}`;
    const headers: Record<string, string> = {
      Authorization: `PVEAPIToken=${this.config.tokenId}=${this.config.tokenSecret}`,
    };

    const fetchOpts: RequestInit = { method, headers };

    if (body && method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      fetchOpts.body = JSON.stringify(body);
    }

    const skipTls = this.config.verifyTls === false;

    const res = await tlsFetch(url, fetchOpts, skipTls);

    if (!res.ok) {
      let detail = '';
      try {
        const errBody = await res.text();
        detail = errBody.slice(0, 500);
      } catch { /* ignore */ }
      throw new Error(`HTTP ${res.status} ${res.statusText} — ${detail}`);
    }

    const json = (await res.json()) as { data: T };
    return json.data;
  }

  private async get<T = unknown>(path: string): Promise<T> {
    return this.api<T>('GET', path);
  }

  private async post<T = unknown>(path: string, body?: Record<string, unknown>): Promise<T> {
    return this.api<T>('POST', path, body);
  }

  private async del<T = unknown>(path: string): Promise<T> {
    return this.api<T>('DELETE', path);
  }

  // -----------------------------------------------------------------------
  // VM resolution (with 30-second cache)
  // -----------------------------------------------------------------------

  private async resolveVm(
    vmid: number,
    explicitNode?: string,
  ): Promise<{ node: string; type: 'qemu' | 'lxc'; name?: string }> {
    if (explicitNode) {
      // We still need the type — try qemu first, then lxc
      try {
        const s = await this.get<{ name?: string }>(`/nodes/${explicitNode}/qemu/${vmid}/status/current`);
        return { node: explicitNode, type: 'qemu', name: s?.name };
      } catch {
        try {
          const s = await this.get<{ name?: string }>(`/nodes/${explicitNode}/lxc/${vmid}/status/current`);
          return { node: explicitNode, type: 'lxc', name: s?.name };
        } catch {
          throw new Error(`VM ${vmid} not found on node "${explicitNode}"`);
        }
      }
    }

    const entries = await this.getAllVms();
    const match = entries.find((e) => e.vmid === vmid);
    if (!match) {
      throw new Error(
        `VM ${vmid} not found on any node. Use "list_vms" to see available VMs.`,
      );
    }
    return { node: match.node, type: match.type, name: match.name };
  }

  private async getAllVms(): Promise<VmEntry[]> {
    const now = Date.now();
    if (this.vmCache && now - this.vmCache.ts < ProxmoxSkill.VM_CACHE_TTL) {
      return this.vmCache.entries;
    }

    const nodes = await this.get<{ node: string }[]>('/nodes');
    const entries: VmEntry[] = [];

    for (const n of nodes) {
      const [qemuList, lxcList] = await Promise.all([
        this.get<VmEntry[]>(`/nodes/${n.node}/qemu`).catch(() => [] as VmEntry[]),
        this.get<VmEntry[]>(`/nodes/${n.node}/lxc`).catch(() => [] as VmEntry[]),
      ]);
      for (const vm of qemuList) entries.push({ ...vm, node: n.node, type: 'qemu' });
      for (const ct of lxcList) entries.push({ ...ct, node: n.node, type: 'lxc' });
    }

    this.vmCache = { entries, ts: now };
    return entries;
  }

  // -----------------------------------------------------------------------
  // READ actions
  // -----------------------------------------------------------------------

  private async clusterStatus(): Promise<SkillResult> {
    const data = await this.get<Record<string, unknown>[]>('/cluster/status');

    const lines = ['## Cluster Status', ''];
    const clusterInfo = data.find((e) => e.type === 'cluster') as Record<string, unknown> | undefined;
    if (clusterInfo) {
      lines.push(`**Cluster:** ${clusterInfo.name}`);
      lines.push(`**Quorum:** ${clusterInfo.quorate ? 'Yes' : 'No'}`);
      lines.push(`**Nodes:** ${clusterInfo.nodes ?? '-'}`);
      lines.push(`**Version:** ${clusterInfo.version ?? '-'}`);
      lines.push('');
    }

    const nodes = data.filter((e) => e.type === 'node');
    if (nodes.length) {
      lines.push('| Node | Online | Level | ID |');
      lines.push('|------|--------|-------|----|');
      for (const n of nodes) {
        lines.push(
          `| ${n.name} | ${n.online ? 'Yes' : '**No**'} | ${n.level ?? '-'} | ${n.nodeid ?? '-'} |`,
        );
      }
    }

    return { success: true, data, display: lines.join('\n') };
  }

  private async listNodes(): Promise<SkillResult> {
    const data = await this.get<Record<string, unknown>[]>('/nodes');

    const lines = ['## Nodes', '', '| Node | Status | CPU | RAM Used / Total | Uptime |'];
    lines.push('|------|--------|-----|------------------|--------|');

    for (const n of data) {
      const cpuVal = typeof n.cpu === 'number' ? pct(n.cpu) : '-';
      const memUsed = bytes(n.mem as number | undefined);
      const memTotal = bytes(n.maxmem as number | undefined);
      lines.push(
        `| ${n.node} | ${n.status} | ${cpuVal} | ${memUsed} / ${memTotal} | ${uptimeStr(n.uptime as number | undefined)} |`,
      );
    }

    return { success: true, data, display: lines.join('\n') };
  }

  private async nodeStats(node?: string): Promise<SkillResult> {
    const target = node ?? this.config.defaultNode;
    if (!target) {
      return { success: false, error: 'Missing "node" parameter and no defaultNode configured' };
    }

    const data = await this.get<Record<string, unknown>>(`/nodes/${target}/status`);

    const cpu = data.cpu as Record<string, unknown> | undefined;
    const mem = data.memory as Record<string, unknown> | undefined;
    const rootfs = data.rootfs as Record<string, unknown> | undefined;
    const swap = data.swap as Record<string, unknown> | undefined;

    const lines = [
      `## Node: ${target}`,
      '',
      `**Uptime:** ${uptimeStr(data.uptime as number | undefined)}`,
      `**Kernel:** ${(data.kversion as string) ?? '-'}`,
      `**PVE Version:** ${(data.pveversion as string) ?? '-'}`,
      '',
    ];

    if (cpu) {
      lines.push(`**CPU:** ${cpu.model ?? '-'} (${cpu.cpus ?? '-'} cores)`);
      lines.push(`**CPU Usage:** ${pct(cpu.cpu as number | undefined)}`);
      lines.push(`**Load:** ${Array.isArray(data.loadavg) ? (data.loadavg as number[]).join(', ') : '-'}`);
    }

    if (mem) {
      lines.push(`**RAM:** ${bytes(mem.used as number | undefined)} / ${bytes(mem.total as number | undefined)} (${pct((mem.used as number) / (mem.total as number))})`);
    }

    if (swap) {
      lines.push(`**Swap:** ${bytes(swap.used as number | undefined)} / ${bytes(swap.total as number | undefined)}`);
    }

    if (rootfs) {
      lines.push(`**Root FS:** ${bytes(rootfs.used as number | undefined)} / ${bytes(rootfs.total as number | undefined)}`);
    }

    return { success: true, data, display: lines.join('\n') };
  }

  private async listVms(
    node?: string,
    typeFilter?: 'qemu' | 'lxc',
  ): Promise<SkillResult> {
    let entries: VmEntry[];

    if (node) {
      entries = [];
      if (!typeFilter || typeFilter === 'qemu') {
        const qemu = await this.get<VmEntry[]>(`/nodes/${node}/qemu`).catch(() => []);
        for (const vm of qemu) entries.push({ ...vm, node, type: 'qemu' });
      }
      if (!typeFilter || typeFilter === 'lxc') {
        const lxc = await this.get<VmEntry[]>(`/nodes/${node}/lxc`).catch(() => []);
        for (const ct of lxc) entries.push({ ...ct, node, type: 'lxc' });
      }
    } else {
      entries = await this.getAllVms();
      if (typeFilter) {
        entries = entries.filter((e) => e.type === typeFilter);
      }
    }

    entries.sort((a, b) => a.vmid - b.vmid);

    const lines = [
      '## Virtual Machines & Containers',
      '',
      `| VMID | Name | Type | Node | Status | CPU | RAM Used / Max | Uptime |`,
      '|------|------|------|------|--------|-----|----------------|--------|',
    ];

    for (const vm of entries) {
      lines.push(
        `| ${vm.vmid} | ${vm.name ?? '-'} | ${vm.type} | ${vm.node} | ${vm.status ?? '-'} | ${pct(vm.cpu)} | ${bytes(vm.mem)} / ${bytes(vm.maxmem)} | ${uptimeStr(vm.uptime)} |`,
      );
    }

    if (entries.length === 0) {
      lines.push('| - | No VMs found | - | - | - | - | - | - |');
    }

    return { success: true, data: entries, display: lines.join('\n') };
  }

  /**
   * v1626 — Realfall 24.10.: docker-dev-01 lief ohne Gast-Agent (Installation beim ersten Start ohne Netz gescheitert), niemand merkte es.
   * Antwortet der Agent? Dann mit den IPv4-Adressen der Gast-Schnittstellen (ohne Loopback) — sonst Fehlschlag, damit eine Prüfung anhält.
   */
  private async agentStatus(vmid?: number, node?: string): Promise<SkillResult> {
    if (vmid == null) return { success: false, error: 'Missing required "vmid" parameter' };
    const resolved = await this.resolveVm(vmid, node);
    if (resolved.type !== 'qemu') return { success: false, error: `VM ${vmid} ist ein Container (${resolved.type}) — Gast-Agent gibt es nur bei qemu-VMs` };
    let netz: { result?: Array<{ name?: string; 'ip-addresses'?: Array<{ 'ip-address'?: string; 'ip-address-type'?: string }> }> };
    try {
      netz = await this.get(`/nodes/${resolved.node}/qemu/${vmid}/agent/network-get-interfaces`);
    } catch (err) {
      return { success: false, error: `Gast-Agent auf VM ${vmid} (${resolved.node}) antwortet nicht: ${(err as Error).message.slice(0, 200)} — qemu-guest-agent im Gast installieren und starten, in Proxmox agent=1` };
    }
    const ipv4 = (netz.result ?? []).filter(i => i.name !== 'lo').flatMap(i => (i['ip-addresses'] ?? []).filter(a => a['ip-address-type'] === 'ipv4' && a['ip-address'] && !a['ip-address'].startsWith('127.')).map(a => ({ schnittstelle: i.name ?? '?', ip: a['ip-address']! })));
    // v1766 (Realfall 06.11. Change 6f7b0b99): Warteschritte erwarten oft den VM-Namen — er steht deshalb in der Antwort
    const wer = resolved.name ? `VM ${vmid} ${resolved.name}` : `VM ${vmid}`;
    return { success: true, data: { vmid, name: resolved.name, node: resolved.node, agent: true, ipv4 }, display: `Gast-Agent auf ${wer} (${resolved.node}) antwortet — IPv4: ${ipv4.length ? ipv4.map(a => `${a.ip} (${a.schnittstelle})`).join(', ') : 'keine'}` };
  }

  private async vmStatus(
    vmid?: number,
    node?: string,
  ): Promise<SkillResult> {
    if (vmid == null) {
      return { success: false, error: 'Missing required "vmid" parameter' };
    }

    const resolved = await this.resolveVm(vmid, node);
    const data = await this.get<Record<string, unknown>>(
      `/nodes/${resolved.node}/${resolved.type}/${vmid}/status/current`,
    );

    const lines = [
      `## VM ${vmid} (${resolved.type}) on ${resolved.node}`,
      '',
      `**Name:** ${(data.name as string) ?? '-'}`,
      `**Status:** ${data.status}`,
      `**CPU:** ${pct(data.cpu as number | undefined)} (${data.cpus ?? '-'} cores)`,
      `**RAM:** ${bytes(data.mem as number | undefined)} / ${bytes(data.maxmem as number | undefined)}`,
      `**Disk:** ${bytes(data.disk as number | undefined)} / ${bytes(data.maxdisk as number | undefined)}`,
      `**Uptime:** ${uptimeStr(data.uptime as number | undefined)}`,
      `**PID:** ${data.pid ?? '-'}`,
      `**Net In / Out:** ${bytes(data.netin as number | undefined)} / ${bytes(data.netout as number | undefined)}`,
    ];

    if (data.lock) {
      lines.push(`**Lock:** ${data.lock}`);
    }

    return { success: true, data, display: lines.join('\n') };
  }

  private async listSnapshots(
    vmid?: number,
    node?: string,
  ): Promise<SkillResult> {
    if (vmid == null) {
      return { success: false, error: 'Missing required "vmid" parameter' };
    }

    const resolved = await this.resolveVm(vmid, node);
    const data = await this.get<Record<string, unknown>[]>(
      `/nodes/${resolved.node}/${resolved.type}/${vmid}/snapshot`,
    );

    const lines = [
      `## Snapshots for VM ${vmid}`,
      '',
      '| Name | Description | Date | Parent |',
      '|------|-------------|------|--------|',
    ];

    for (const snap of data) {
      const date = snap.snaptime
        ? new Date((snap.snaptime as number) * 1000).toISOString()
        : '-';
      lines.push(
        `| ${snap.name} | ${(snap.description as string) ?? '-'} | ${date} | ${(snap.parent as string) ?? '-'} |`,
      );
    }

    return { success: true, data, display: lines.join('\n') };
  }

  private async listStorage(node?: string): Promise<SkillResult> {
    const target = node ?? this.config.defaultNode;
    const path = target ? `/nodes/${target}/storage` : '/storage';
    const data = await this.get<Record<string, unknown>[]>(path);

    const lines = [
      `## Storage${target ? ` (Node: ${target})` : ''}`,
      '',
      '| Storage | Type | Content | Used / Total | Status |',
      '|---------|------|---------|--------------|--------|',
    ];

    for (const s of data) {
      const used = bytes(s.used as number | undefined);
      const total = bytes(s.total as number | undefined);
      lines.push(
        `| ${s.storage} | ${s.type} | ${s.content ?? '-'} | ${used} / ${total} | ${s.active ? 'active' : s.enabled ? 'enabled' : 'disabled'} |`,
      );
    }

    return { success: true, data, display: lines.join('\n') };
  }

  /**
   * v1543 (Owner 22.10. „F4“) — alle Sicherungen einer VM über alle Knoten und Speicher mit Inhalt „backup“ (lokal, NFS, PBS),
   * neueste zuerst; nicht erreichbare oder inaktive Backup-Speicher werden ausgewiesen (Realfall 21.10.: pbs-unas „No route to host“).
   */
  /**
   * I1 (Spec Infrastruktur-Vorhaben) — Sicherungen ALLER VMs/CTs in einem Durchgang (je Backup-Speicher einmal statt je VM):
   * vmid → neueste Sicherung, Anzahl, Speicher; dazu VMs ohne Sicherung und nicht erreichbare Speicher.
   */
  async alleBackupsDaten(): Promise<{ jeVm: Record<number, { name?: string; neueste?: string; anzahl: number; speicher: string[] }>; ohne: Array<{ vmid: number; name?: string }>; unerreichbar: Array<{ speicher: string; grund: string }>; speicher: string[] }> {
    const vms = await this.getAllVms();
    const jeVm: Record<number, { name?: string; neueste?: string; anzahl: number; speicher: string[] }> = {};
    for (const v of vms) jeVm[v.vmid] = { name: v.name, anzahl: 0, speicher: [] };
    const nodes = (await this.get<{ node: string; status?: string }[]>('/nodes')).filter(n => n.status !== 'offline');
    const gesehen = new Set<string>();
    const unerreichbar: Array<{ speicher: string; grund: string }> = [];
    const speicher: string[] = [];
    for (const n of nodes) {
      const liste = await this.get<Array<{ storage: string; content?: string; active?: number; enabled?: number; shared?: number }>>(`/nodes/${n.node}/storage`).catch(() => []);
      for (const st of liste) {
        if (!(st.content ?? '').split(',').includes('backup')) continue;
        const schluessel = st.shared ? st.storage : `${n.node}/${st.storage}`;
        if (gesehen.has(schluessel)) continue;
        gesehen.add(schluessel);
        speicher.push(schluessel);
        if (st.enabled === 0) { unerreichbar.push({ speicher: schluessel, grund: 'deaktiviert' }); continue; }
        if (!st.active) { unerreichbar.push({ speicher: schluessel, grund: 'nicht aktiv (nicht erreichbar)' }); continue; }
        try {
          const inhalt = await this.get<Array<{ vmid?: number; ctime?: number }>>(`/nodes/${n.node}/storage/${encodeURIComponent(st.storage)}/content?content=backup`);
          for (const b of inhalt) {
            const id = Number(b.vmid);
            if (!Number.isFinite(id)) continue;
            const e = (jeVm[id] ??= { anzahl: 0, speicher: [] });
            e.anzahl++;
            if (!e.speicher.includes(schluessel)) e.speicher.push(schluessel);
            const zeit = b.ctime ? new Date(b.ctime * 1000).toISOString() : undefined;
            if (zeit && (!e.neueste || zeit > e.neueste)) e.neueste = zeit;
          }
        } catch (err) { unerreichbar.push({ speicher: schluessel, grund: (err as Error).message.slice(0, 120) }); }
      }
    }
    const ohne = vms.filter(v => !jeVm[v.vmid]?.anzahl).map(v => ({ vmid: v.vmid, name: v.name }));
    return { jeVm, ohne, unerreichbar, speicher };
  }

  async backupsVmDaten(vmid: number): Promise<{ vmid: number; name?: string; backups: Array<{ speicher: string; volid: string; zeit: string; groesse?: number; format?: string; geprueft?: string }>; unerreichbar: Array<{ speicher: string; grund: string }>; speicher: string[] }> {
    const vm = (await this.getAllVms()).find(e => e.vmid === vmid);
    const nodes = (await this.get<{ node: string; status?: string }[]>('/nodes')).filter(n => n.status !== 'offline');
    const gesehen = new Set<string>();
    const backups: Array<{ speicher: string; volid: string; zeit: string; groesse?: number; format?: string; geprueft?: string }> = [];
    const unerreichbar: Array<{ speicher: string; grund: string }> = [];
    const speicher: string[] = [];
    for (const n of nodes) {
      const liste = await this.get<Array<{ storage: string; content?: string; active?: number; enabled?: number; shared?: number }>>(`/nodes/${n.node}/storage`).catch(() => []);
      for (const st of liste) {
        if (!(st.content ?? '').split(',').includes('backup')) continue;
        const schluessel = st.shared ? st.storage : `${n.node}/${st.storage}`;
        if (gesehen.has(schluessel)) continue;
        gesehen.add(schluessel);
        speicher.push(schluessel);
        if (st.enabled === 0) { unerreichbar.push({ speicher: schluessel, grund: 'deaktiviert' }); continue; }
        if (!st.active) { unerreichbar.push({ speicher: schluessel, grund: 'nicht aktiv (nicht erreichbar)' }); continue; }
        try {
          const inhalt = await this.get<Array<{ volid: string; ctime?: number; size?: number; format?: string; vmid?: number; verification?: { state?: string } }>>(`/nodes/${n.node}/storage/${encodeURIComponent(st.storage)}/content?content=backup&vmid=${vmid}`);
          for (const b of inhalt) {
            if (b.vmid !== undefined && Number(b.vmid) !== vmid) continue;
            backups.push({ speicher: schluessel, volid: b.volid, zeit: b.ctime ? new Date(b.ctime * 1000).toISOString() : '', groesse: b.size, format: b.format, geprueft: b.verification?.state });
          }
        } catch (err) {
          unerreichbar.push({ speicher: schluessel, grund: (err as Error).message.slice(0, 120) });
        }
      }
    }
    backups.sort((a, b) => b.zeit.localeCompare(a.zeit));
    return { vmid, name: vm?.name, backups, unerreichbar, speicher };
  }

  private async backupsVm(vmid?: number): Promise<SkillResult> {
    if (vmid == null) return { success: false, error: 'Missing required "vmid" parameter' };
    const d = await this.backupsVmDaten(vmid);
    const zeilen = [`## Sicherungen von VM ${vmid}${d.name ? ` (${d.name})` : ''}`, ''];
    if (!d.backups.length) zeilen.push(`⚠️ Keine Sicherung auf ${d.speicher.length} Backup-Speicher(n) gefunden.`);
    for (const b of d.backups.slice(0, 15)) {
      const tage = b.zeit ? Math.floor((Date.now() - Date.parse(b.zeit)) / 86_400_000) : undefined;
      zeilen.push(`- ${b.zeit.slice(0, 16).replace('T', ' ')} · ${b.speicher} · ${bytes(b.groesse)}${tage !== undefined ? ` · vor ${tage} Tagen` : ''}${b.geprueft ? ` · Prüfung: ${b.geprueft}` : ''}`);
    }
    if (d.unerreichbar.length) zeilen.push('', `Nicht geprüft: ${d.unerreichbar.map(u => `${u.speicher} (${u.grund})`).join(', ')}`);
    return { success: true, data: d, display: zeilen.join('\n') };
  }

  private async listTasks(node?: string): Promise<SkillResult> {
    const target = node ?? this.config.defaultNode;
    if (!target) {
      return { success: false, error: 'Missing "node" parameter and no defaultNode configured' };
    }

    const data = await this.get<Record<string, unknown>[]>(
      `/nodes/${target}/tasks?limit=20`,
    );

    const lines = [
      `## Recent Tasks (Node: ${target})`,
      '',
      '| UPID | Type | Status | Start | User |',
      '|------|------|--------|-------|------|',
    ];

    for (const t of data) {
      const start = t.starttime
        ? new Date((t.starttime as number) * 1000).toISOString()
        : '-';
      lines.push(
        `| \`${(t.upid as string)?.slice(-16) ?? '-'}\` | ${t.type ?? '-'} | ${t.status ?? 'running'} | ${start} | ${t.user ?? '-'} |`,
      );
    }

    return { success: true, data, display: lines.join('\n') };
  }

  private async taskStatus(upid?: string): Promise<SkillResult> {
    if (!upid) {
      return { success: false, error: 'Missing required "upid" parameter' };
    }

    // UPID format: UPID:{node}:{pid}:{pstart}:{starttime}:{type}:{id}:{user}:
    const nodePart = upid.split(':')[1];
    if (!nodePart) {
      return { success: false, error: 'Invalid UPID format — cannot extract node' };
    }

    const data = await this.get<Record<string, unknown>>(
      `/nodes/${nodePart}/tasks/${encodeURIComponent(upid)}/status`,
    );

    const lines = [
      '## Task Status',
      '',
      `**UPID:** \`${upid}\``,
      `**Status:** ${data.status}`,
      `**Type:** ${data.type ?? '-'}`,
      `**Exit Status:** ${data.exitstatus ?? 'running'}`,
      `**Node:** ${nodePart}`,
    ];

    return { success: true, data, display: lines.join('\n') };
  }

  // -----------------------------------------------------------------------
  // WRITE / ADMIN actions
  // -----------------------------------------------------------------------

  private async vmPowerAction(
    action: 'start' | 'shutdown' | 'reboot' | 'suspend' | 'resume' | 'stop',
    input: Record<string, unknown>,
  ): Promise<SkillResult> {
    const vmid = input.vmid as number | undefined;
    if (vmid == null) {
      return { success: false, error: 'Missing required "vmid" parameter' };
    }

    const resolved = await this.resolveVm(vmid, input.node as string | undefined);
    const upid = await this.post<string>(
      `/nodes/${resolved.node}/${resolved.type}/${vmid}/status/${action}`,
    );

    return {
      success: true,
      data: { vmid, node: resolved.node, type: resolved.type, action, upid },
      display: [
        `**${action.charAt(0).toUpperCase() + action.slice(1)}** sent to VM ${vmid} (${resolved.type}) on **${resolved.node}**.`,
        '',
        `UPID: \`${upid}\``,
        '',
        'Use `task_status` with this UPID to check progress.',
      ].join('\n'),
    };
  }

  private async createSnapshot(input: Record<string, unknown>): Promise<SkillResult> {
    const vmid = input.vmid as number | undefined;
    const snapname = input.name as string | undefined;
    if (vmid == null) {
      return { success: false, error: 'Missing required "vmid" parameter' };
    }
    if (!snapname) {
      return { success: false, error: 'Missing required "name" parameter (snapshot name)' };
    }

    const resolved = await this.resolveVm(vmid, input.node as string | undefined);
    // v1784 — Realfall 10.11. (I8c D 12d82a15 Schritt 2): nach einem Neustart des Changes gab es den Snapshot aus dem ersten Lauf schon
    // („snapshot name already used“) — ein vorhandener Snapshot gleichen Namens ist der gewollte Sicherungspunkt; Zeitpunkt wird genannt
    const da = ((await this.get<Array<{ name: string; snaptime?: number }>>(`/nodes/${resolved.node}/${resolved.type}/${vmid}/snapshot`).catch(() => [])) ?? []).find(s => s.name === snapname);
    if (da) {
      const seit = da.snaptime ? new Date(da.snaptime * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'unbekannt';
      return { success: true, data: { vmid, node: resolved.node, type: resolved.type, snapname, vorhanden: true, snaptime: da.snaptime }, display: `Snapshot **"${snapname}"** für VM ${vmid} auf **${resolved.node}** ist schon vorhanden (angelegt ${seit}) — nichts zu tun.` };
    }
    const body: Record<string, unknown> = { snapname };
    if (input.description) body.description = input.description;

    const upid = await this.post<string>(
      `/nodes/${resolved.node}/${resolved.type}/${vmid}/snapshot`,
      body,
    );

    return {
      success: true,
      data: { vmid, node: resolved.node, type: resolved.type, snapname, upid },
      display: [
        `Snapshot **"${snapname}"** creation started for VM ${vmid} on **${resolved.node}**.`,
        '',
        `UPID: \`${upid}\``,
      ].join('\n'),
    };
  }

  private async backupVm(input: Record<string, unknown>): Promise<SkillResult> {
    const vmid = input.vmid as number | undefined;
    if (vmid == null) {
      return { success: false, error: 'Missing required "vmid" parameter' };
    }

    const resolved = await this.resolveVm(vmid, input.node as string | undefined);
    const body: Record<string, unknown> = {
      vmid,
      mode: 'snapshot',
    };
    if (input.storage) body.storage = input.storage;

    const upid = await this.post<string>(
      `/nodes/${resolved.node}/vzdump`,
      body,
    );

    return {
      success: true,
      data: { vmid, node: resolved.node, storage: input.storage ?? 'default', upid },
      display: [
        `Backup (snapshot mode) started for VM ${vmid} on **${resolved.node}**.`,
        input.storage ? `Storage: **${input.storage}**` : '',
        '',
        `UPID: \`${upid}\``,
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }

  private async migrateVm(input: Record<string, unknown>): Promise<SkillResult> {
    const vmid = input.vmid as number | undefined;
    const target = input.target as string | undefined;
    if (vmid == null) {
      return { success: false, error: 'Missing required "vmid" parameter' };
    }
    if (!target) {
      return { success: false, error: 'Missing required "target" parameter (target node)' };
    }

    const resolved = await this.resolveVm(vmid, input.node as string | undefined);
    const upid = await this.post<string>(
      `/nodes/${resolved.node}/${resolved.type}/${vmid}/migrate`,
      { target, online: 1 },
    );

    return {
      success: true,
      data: { vmid, from: resolved.node, target, type: resolved.type, upid },
      display: [
        `Live migration of VM ${vmid} from **${resolved.node}** to **${target}** started.`,
        '',
        `UPID: \`${upid}\``,
      ].join('\n'),
    };
  }

  private async deleteSnapshot(input: Record<string, unknown>): Promise<SkillResult> {
    const vmid = input.vmid as number | undefined;
    const snapname = input.name as string | undefined;
    if (vmid == null) {
      return { success: false, error: 'Missing required "vmid" parameter' };
    }
    if (!snapname) {
      return { success: false, error: 'Missing required "name" parameter (snapshot name)' };
    }

    const resolved = await this.resolveVm(vmid, input.node as string | undefined);
    const upid = await this.del<string>(
      `/nodes/${resolved.node}/${resolved.type}/${vmid}/snapshot/${encodeURIComponent(snapname)}`,
    );

    return {
      success: true,
      data: { vmid, node: resolved.node, type: resolved.type, snapname, upid },
      display: [
        `Snapshot **"${snapname}"** deletion started for VM ${vmid} on **${resolved.node}**.`,
        '',
        `UPID: \`${upid}\``,
      ].join('\n'),
    };
  }

  private async rollbackSnapshot(input: Record<string, unknown>): Promise<SkillResult> {
    const vmid = input.vmid as number | undefined;
    const snapname = input.name as string | undefined;
    if (vmid == null) {
      return { success: false, error: 'Missing required "vmid" parameter' };
    }
    if (!snapname) {
      return { success: false, error: 'Missing required "name" parameter (snapshot name)' };
    }

    const resolved = await this.resolveVm(vmid, input.node as string | undefined);
    const upid = await this.post<string>(
      `/nodes/${resolved.node}/${resolved.type}/${vmid}/snapshot/${encodeURIComponent(snapname)}/rollback`,
    );

    return {
      success: true,
      data: { vmid, node: resolved.node, type: resolved.type, snapname, upid },
      display: [
        `Rollback to snapshot **"${snapname}"** started for VM ${vmid} on **${resolved.node}**.`,
        '',
        `UPID: \`${upid}\``,
        '',
        '**Warning:** The VM will be stopped during rollback.',
      ].join('\n'),
    };
  }

  // ── Infra Actions ──────────────────────────────────────────────

  private async listTemplates(input: Record<string, unknown>): Promise<SkillResult> {
    const node = (input.node as string) ?? this.config.defaultNode ?? "pve1";

    // QEMU templates
    const qemuVms = await this.get<Array<Record<string, unknown>>>(`/nodes/${node}/qemu`);
    const qemuTemplates = qemuVms.filter((v: any) => v.template === 1);

    // LXC available templates (appliances)
    let lxcTemplates: Array<Record<string, unknown>> = [];
    try {
      lxcTemplates = await this.get<Array<Record<string, unknown>>>(`/nodes/${node}/aplinfo`);
    } catch { /* aplinfo may not be available */ }

    const qLines = qemuTemplates.map((t: any) => `| QEMU | ${t.vmid} | ${t.name ?? '?'} | ${Math.round((t.maxmem ?? 0) / 1024 / 1024)} MB | ${t.cpus ?? '?'} |`);
    const lLines = lxcTemplates.slice(0, 20).map((t: any) => `| LXC | — | ${t.template ?? t.package ?? '?'} | — | — |`);

    const display = `## Proxmox Templates (${node})\n\n| Typ | VMID | Name | RAM | CPU |\n|-----|------|------|-----|-----|\n${qLines.join('\n')}${lLines.length > 0 ? '\n' + lLines.join('\n') : ''}`;
    return { success: true, data: { qemu: qemuTemplates, lxc: lxcTemplates.slice(0, 20) }, display };
  }

  private async createLxc(input: Record<string, unknown>): Promise<SkillResult> {
    const node = (input.node as string) ?? this.config.defaultNode ?? "pve1";
    const hostname = input.hostname as string;
    const template = input.template as string;
    if (!hostname || !template) return { success: false, error: 'hostname und template erforderlich' };

    const memory = (input.memory as number) ?? 2048;
    const cores = (input.cores as number) ?? 2;
    const diskSize = (input.disk_size as number) ?? 8;
    const ip = input.ip as string | undefined;
    const gateway = input.gateway as string | undefined;
    const bridge = (input.bridge as string) ?? 'vmbr0';
    const vlanTag = input.vlan_tag as number | undefined;
    let sshKey = input.ssh_public_key as string | undefined;
    if (!sshKey && this.sshKeyPath) {
      try { sshKey = readFileSync(`${this.sshKeyPath}.pub`, 'utf-8').trim(); } catch { /* no key */ }
    }
    const newVmid = input.new_vmid as number | undefined;

    // Find the template in available templates
    let ostemplate = template;
    if (!template.includes(':')) {
      // Try to find matching template
      try {
        const available = await this.get<Array<Record<string, unknown>>>(`/nodes/${node}/aplinfo`);
        const match = available.find((t: any) =>
          (t.template ?? t.package ?? '').toLowerCase().includes(template.toLowerCase()),
        );
        if (match) ostemplate = `local:vztmpl/${match.template ?? match.package}`;
      } catch { /* use raw template string */ }
    }

    // Build network config
    let netConfig = `name=eth0,bridge=${bridge}`;
    if (vlanTag) netConfig += `,tag=${vlanTag}`;
    if (ip) netConfig += `,ip=${ip}${gateway ? `,gw=${gateway}` : ''}`;

    const body: Record<string, unknown> = {
      ostemplate,
      hostname,
      memory,
      cores,
      rootfs: `local-lvm:${diskSize}`,
      net0: netConfig,
      start: 1,
      unprivileged: 1,
    };
    if (newVmid) body.vmid = newVmid;
    if (sshKey) body['ssh-public-keys'] = sshKey;

    const upid = await this.post<string>(`/nodes/${node}/lxc`, body);

    return {
      success: true,
      data: { node, hostname, upid, memory, cores, disk: diskSize, ip, bridge, vlanTag },
      display: `✅ LXC Container "${hostname}" wird erstellt auf ${node}\n- Template: ${ostemplate}\n- RAM: ${memory} MB, ${cores} Cores, ${diskSize} GB Disk\n- Netzwerk: ${bridge}${vlanTag ? ` VLAN ${vlanTag}` : ''}${ip ? ` IP ${ip}` : ''}\n- UPID: \`${upid}\``,
    };
  }

  private async cloneVm(input: Record<string, unknown>): Promise<SkillResult> {
    const node = (input.node as string) ?? this.config.defaultNode ?? "pve1";
    const template = input.template as string;
    const hostname = input.hostname as string;
    if (!template || !hostname) return { success: false, error: 'template (VMID) und hostname erforderlich' };

    const templateVmid = parseInt(template, 10);
    if (isNaN(templateVmid)) return { success: false, error: `template muss eine VMID sein (z.B. 9000), bekam: "${template}"` };

    const newVmid = input.new_vmid as number | undefined;
    const ip = input.ip as string | undefined;
    const gateway = input.gateway as string | undefined;
    // SSH key: explicit > auto-read from sshKeyPath
    let sshKey = input.ssh_public_key as string | undefined;
    if (!sshKey && this.sshKeyPath) {
      try { sshKey = readFileSync(`${this.sshKeyPath}.pub`, 'utf-8').trim(); } catch { /* no key */ }
    }
    const bridge = input.bridge as string | undefined;
    const vlanTag = input.vlan_tag as number | undefined;
    const memory = input.memory as number | undefined;
    const cores = input.cores as number | undefined;

    // Get next free VMID from Proxmox (reliable, not templateVmid+1)
    let assignedVmid = newVmid;
    if (!assignedVmid) {
      try {
        const cluster = await this.get<Record<string, unknown>>('/cluster/nextid');
        assignedVmid = typeof cluster === 'number' ? cluster : parseInt(String(cluster), 10);
      } catch {
        assignedVmid = templateVmid + 100; // fallback
      }
    }

    // Clone
    const cloneBody: Record<string, unknown> = {
      newid: assignedVmid,
      name: hostname,
      full: 1,
      target: node,
    };

    const upid = await this.post<string>(`/nodes/${node}/qemu/${templateVmid}/clone`, cloneBody);

    // Wait for clone task to complete before applying Cloud-Init config
    const pollStart = Date.now();
    while (Date.now() - pollStart < 120_000) {
      try {
        const taskData = await this.get<Record<string, unknown>>(`/nodes/${node}/tasks/${encodeURIComponent(upid)}/status`);
        if (taskData.status === 'stopped') break;
      } catch { /* task may not exist yet */ }
      await new Promise(r => setTimeout(r, 3_000));
    }

    // Apply Cloud-Init config to the cloned VM
    const configBody: Record<string, unknown> = {};
    if (ip) configBody.ipconfig0 = `ip=${ip}${gateway ? `,gw=${gateway}` : ''}`;
    if (sshKey) configBody.sshkeys = encodeURIComponent(sshKey);
    if (memory) configBody.memory = memory;
    if (cores) configBody.cores = cores;
    if (bridge || vlanTag) {
      let net = `virtio,bridge=${bridge ?? 'vmbr0'}`;
      if (vlanTag) net += `,tag=${vlanTag}`;
      configBody.net0 = net;
    }
    if (Object.keys(configBody).length > 0) {
      try {
        await this.post(`/nodes/${node}/qemu/${assignedVmid}/config`, configBody);
      } catch { /* config apply failed — VM still usable but may need manual config */ }
    }

    const steps: string[] = [
      `✅ VM "${hostname}" (VMID ${assignedVmid}) geklont aus Template ${templateVmid}`,
    ];
    if (ip) steps.push(`- Cloud-Init IP: ${ip}`);
    if (sshKey) steps.push('- SSH Key injiziert');

    // Auto-start + runtime install if runtime parameter is set
    const runtime = input.runtime as string | undefined;
    if (runtime && ip) {
      // Start the VM
      try {
        await this.post(`/nodes/${node}/qemu/${assignedVmid}/status/start`, {});
        steps.push('🚀 VM gestartet');
      } catch (err: any) {
        steps.push(`⚠️ VM-Start fehlgeschlagen: ${err.message?.slice(0, 80)}`);
      }

      // Detect Cloud-Init user from template name
      const tplLower = (hostname ?? template).toLowerCase();
      const ciUser = (tplLower.includes('rocky') || tplLower.includes('alma') || tplLower.includes('centos')) ? 'cloud-user'
        : tplLower.includes('debian') ? 'debian'
        : tplLower.includes('fedora') ? 'fedora'
        : 'ubuntu';
      const isRhel = ciUser === 'cloud-user' || tplLower.includes('fedora');
      steps.push(`👤 Cloud-Init User: ${ciUser}`);

      // Post-provision: SSH wait + runtime install via callback
      if (this.postProvisionFn) {
        const host = ip.replace(/\/\d+$/, ''); // strip CIDR prefix
        try {
          const dockerBridgeIp = input.docker_bridge_ip as string | undefined;
          const installSteps = await this.postProvisionFn(host, ciUser, runtime, isRhel, { dockerBridgeIp });
          steps.push(...installSteps);
        } catch (err: any) {
          steps.push(`⚠️ Post-Provision fehlgeschlagen: ${err.message?.slice(0, 100)}`);
        }
      } else {
        steps.push(`⚠️ Runtime "${runtime}" gewünscht, aber Post-Provision Callback nicht verfügbar`);
        steps.push(`Nächster Schritt: manuell SSH → ${runtime} installieren`);
      }
    } else if (!runtime) {
      steps.push(`\nNächster Schritt: "proxmox start_vm vmid=${assignedVmid}"`);
    }

    return {
      success: true,
      data: { node, templateVmid, hostname, upid, clonedVmid: assignedVmid, ip, steps },
      display: steps.join('\n'),
    };
  }

  // -----------------------------------------------------------------------
  // I5 — Vorlagen-Fabrik
  // -----------------------------------------------------------------------

  /** Auf eine Proxmox-Aufgabe warten; Fehler mit der Ausgabe des Tasks */
  private async warteAufgabe(upid: string, ms: number): Promise<{ fertig: boolean; ok: boolean; status: string }> {
    const node = upid.split(':')[1];
    const bis = Date.now() + ms;
    while (Date.now() < bis) {
      try {
        const t = await this.get<{ status?: string; exitstatus?: string }>(`/nodes/${node}/tasks/${encodeURIComponent(upid)}/status`);
        if (t.status === 'stopped') return { fertig: true, ok: t.exitstatus === 'OK', status: t.exitstatus ?? 'unbekannt' };
      } catch { /* Task noch nicht sichtbar */ }
      await new Promise(r => setTimeout(r, 2_000));
    }
    return { fertig: false, ok: false, status: 'läuft noch' };
  }

  /** warnungenOk: „WARNINGS: n“ gilt als gelungen (Realfall b0e35618: Netz neu laden auf pve1 warnt nur über die fehlende SDN-Zeile) */
  private async aufgabeOderFehler(upid: unknown, ms: number, was: string, warnungenOk = false): Promise<void> {
    if (typeof upid !== 'string' || !upid.startsWith('UPID:')) return;
    const w = await this.warteAufgabe(upid, ms);
    if (!w.ok && !(warnungenOk && w.fertig && /^WARNINGS: \d+$/.test(w.status))) throw new Error(`${was}: ${w.fertig ? w.status : `nach ${Math.round(ms / 1000)} s nicht fertig`} (${upid})`);
  }

  private async holeText(url: string): Promise<string> {
    const res = await tlsFetch(url, { method: 'GET' }, false);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res.text();
  }

  /** Neuester Stand je Distribution mit URL und Prüfsumme des Herausgebers (über HTTPS mit Zertifikatsprüfung) */
  private async listCloudImages(input: Record<string, unknown>): Promise<SkillResult> {
    const gewuenscht = istDistro(input.distro) ? [input.distro] : Object.keys(DISTROS) as Distro[];
    const liste: ImageAngabe[] = [];
    const fehler: string[] = [];
    for (const d of gewuenscht) {
      const q = DISTROS[d];
      try {
        const stand = neuesterStand(await this.holeText(q.basis), q);
        if (!stand) { fehler.push(`${d}: kein datierter Stand gefunden`); continue; }
        const a = imageAngabe(d, stand, await this.holeText(summenUrl(d, stand)));
        if ('fehler' in a) fehler.push(a.fehler); else liste.push(a);
      } catch (err) { fehler.push(`${d}: ${(err as Error).message.slice(0, 120)}`); }
    }
    const zeilen = liste.map(a => `- **${a.distro}** Stand ${a.stand}: ${a.url}\n  ${a.checksum_algorithm} ${a.checksum.slice(0, 16)}… → filename ${a.filename}`);
    return { success: liste.length > 0, data: { images: liste, fehler }, display: [...zeilen, ...fehler.map(f => `⚠️ ${f}`)].join('\n'), ...(liste.length ? {} : { error: fehler.join('; ') || 'keine Images' }) };
  }

  /** Image beim Herausgeber laden; Proxmox prüft die Prüfsumme. Liefert die Aufgabe (UPID) — der Change-Motor verfolgt sie. */
  private async downloadImage(input: Record<string, unknown>): Promise<SkillResult> {
    const f = pruefeDownload(input);
    if (f) return { success: false, error: f };
    const node = (input.node as string) ?? this.config.defaultNode;
    const storage = input.storage as string;
    if (!node || !storage) return { success: false, error: 'download_image braucht node und storage' };
    const st = (await this.get<Array<{ storage: string; content?: string; active?: number }>>(`/nodes/${node}/storage`)).find(s => s.storage === storage);
    if (!st) return { success: false, error: `Speicher ${storage} gibt es auf ${node} nicht` };
    if (!String(st.content ?? '').split(',').includes('import')) return { success: false, error: `Speicher ${storage} hat keinen Inhalt „import“ (${st.content ?? '-'})` };
    const volid = `${storage}:import/${input.filename as string}`;
    const vorhanden = await this.get<Array<{ volid: string }>>(`/nodes/${node}/storage/${storage}/content?content=import`).catch(() => [] as Array<{ volid: string }>);
    if (vorhanden.some(v => v.volid === volid)) return { success: false, error: `${volid} gibt es schon — vorhandenes Image verwenden oder zuerst delete_image` };
    const upid = await this.post<string>(`/nodes/${node}/storage/${storage}/download-url`, {
      content: 'import', filename: input.filename, url: input.url, checksum: input.checksum, 'checksum-algorithm': input.checksum_algorithm, 'verify-certificates': 1,
    });
    return { success: true, data: { upid, node, storage, volid }, display: `Image wird geladen und geprüft (${input.checksum_algorithm}): ${input.url} → ${volid}` };
  }

  /**
   * v1614 (Realfall 23.10.: MikroTik-Router gekapert, alle Zugänge entzogen) — Sicherung als NEUE VM wiederherstellen, ohne Start, mit
   * neuen MACs (unique). Gibt die Proxmox-Aufgabe zurück; der Change-Motor verfolgt sie bis zum Ende. Danach isolate_vm.
   */
  private async restoreBackup(input: Record<string, unknown>): Promise<SkillResult> {
    const volid = String(input.volid ?? '');
    const pbs = PBS_VM_SICHERUNG.test(volid);
    if (!pbs && !SICHERUNG_VOLUME.test(volid)) return { success: false, error: 'restore_backup: volid einer vzdump-Sicherung (speicher:backup/vzdump-qemu-<vmid>-<datum>.vma.zst) oder einer PBS-Sicherung (speicher:backup/vm/<vmid>/<JJJJ-MM-TTThh:mm:ssZ>)' };
    if (!pbs && !/^[a-zA-Z][\w-]{0,40}:backup\/vzdump-qemu-/.test(volid)) return { success: false, error: 'restore_backup: nur QEMU-Sicherungen' };
    const node = String(input.node ?? this.config.defaultNode ?? '');
    const vmid = Number(input.new_vmid);
    const storage = String(input.storage ?? '');
    const name = String(input.hostname ?? '').trim();
    if (!node) return { success: false, error: 'restore_backup braucht node' };
    if (!Number.isInteger(vmid) || vmid < 100) return { success: false, error: 'new_vmid: freie VMID ≥ 100' };
    if (!VM_NAME.test(name)) return { success: false, error: 'hostname: Name der Kopie (Kleinbuchstaben, Ziffern, -)' };
    this.vmCache = null;
    const vms = await this.getAllVms();
    const da = vms.find(v => v.vmid === vmid);
    if (da) {
      // wiederholbar: dieselbe Kopie gibt es schon (gleicher Name) → übernehmen
      if (da.name === name) return { success: true, data: { vmid, node: da.node, name, vorhanden: true }, display: `Kopie ${name} (VMID ${vmid}) gibt es bereits` };
      return { success: false, error: `VMID ${vmid} ist belegt (${da.name ?? '?'})` };
    }
    const speicher = (await this.get<Array<{ storage: string; content?: string }>>(`/nodes/${node}/storage`)) ?? [];
    if (!speicher.some(x => x.storage === storage && (x.content ?? '').split(',').includes('images'))) return { success: false, error: `storage „${storage}“ nimmt auf ${node} keine VM-Platten (images)` };
    const upid = await this.post<string>(`/nodes/${node}/qemu`, { vmid, archive: volid, storage, unique: 1, start: 0 });
    this.vmCache = null;
    return { success: true, data: { upid, vmid, node, name, volid }, display: `Wiederherstellung von ${volid} als VMID ${vmid} auf ${node} (${storage}) gestartet — ohne Start, neue MACs` };
  }

  /** v1614 — wiederhergestellte Kopie isolieren: jede Netzwerkkarte link_down=1, kein Autostart (kein Löschschutz — der Rückweg delete_vm muss gehen); nachlesen */
  private async isolateVm(input: Record<string, unknown>): Promise<SkillResult> {
    const vmid = Number(input.vmid);
    const name = String(input.vm_name ?? input.hostname ?? '').trim();
    this.vmCache = null;
    const vm = (await this.getAllVms()).find(v => v.vmid === vmid);
    if (!vm) return { success: false, error: `VMID ${vmid} nicht gefunden` };
    if (vm.type !== 'qemu') return { success: false, error: 'isolate_vm gilt nur für QEMU-VMs' };
    // Namensvergleich nach der Wiederherstellung: Proxmox übernimmt den Namen aus der Sicherung — dann zuerst umbenennen
    const cfg = await this.get<Record<string, unknown>>(`/nodes/${vm.node}/qemu/${vmid}/config`);
    if (cfg.lock) return { success: false, error: `VMID ${vmid} ist noch gesperrt (${String(cfg.lock)}) — Wiederherstellung läuft` };
    const st = await this.get<{ status?: string }>(`/nodes/${vm.node}/qemu/${vmid}/status/current`);
    if (st.status === 'running') return { success: false, error: `VMID ${vmid} läuft — eine Rettungskopie darf nie ungetrennt laufen; nicht verändert` };
    const netze = getrennteNetze(cfg);
    await this.api('PUT', `/nodes/${vm.node}/qemu/${vmid}/config`, { ...netze, onboot: 0, ...(name && VM_NAME.test(name) ? { name } : {}), description: `Rettungskopie (Alfred, isoliert) — Netzwerkkarten getrennt, nicht ins Netz schalten, solange das Original läuft.` });
    const nachher = await this.get<Record<string, unknown>>(`/nodes/${vm.node}/qemu/${vmid}/config`);
    if (!alleNetzeGetrennt(nachher) || Number(nachher.onboot ?? 0) !== 0) return { success: false, error: `VMID ${vmid}: Netzwerkkarten oder Autostart nach dem Setzen nicht wie verlangt` };
    this.vmCache = null;
    return { success: true, data: { vmid, node: vm.node, name: nachher.name, getrennt: Object.keys(netze), onboot: 0 }, display: `✅ VMID ${vmid} (${String(nachher.name ?? '')}) isoliert: ${Object.keys(netze).join(', ') || 'keine Karten'} getrennt, kein Autostart` };
  }

  /** Übergangsjob 22.10. — geplante vzdump-Jobs des Clusters */
  private async listBackupJobs(): Promise<SkillResult> {
    const jobs = (await this.get<Array<SicherungsJobVorhanden & { comment?: string; mode?: string; 'next-run'?: number }>>('/cluster/backup')) ?? [];
    const zeile = (j: typeof jobs[number]) => `${j.id}: ${String(j.enabled ?? '1') === '0' ? 'AUS' : 'an'}, ${j.schedule ?? '-'} → ${j.storage ?? '-'}, VMs ${j.vmid ?? ((j as { all?: number }).all ? 'alle' : '-')}${j['next-run'] ? `, nächster Lauf ${new Date(j['next-run'] * 1000).toISOString().slice(0, 16)}` : ''}${j.comment ? ` — ${j.comment}` : ''}`;
    return { success: true, data: jobs, display: jobs.length ? jobs.map(zeile).join('\n') : 'Keine Sicherungsjobs' };
  }

  /** Nur im Change: eigener vzdump-Job (alfred-…), wiederholbar; danach nachlesen */
  private async createBackupJob(input: Record<string, unknown>): Promise<SkillResult> {
    const vmids = (Array.isArray(input.vmids) ? input.vmids : String(input.vmids ?? '').split(',')).map(v => Number(String(v).trim())).filter(v => !Number.isNaN(v));
    const w = { id: String(input.job_id ?? '').trim(), vmids, storage: String(input.storage ?? '').trim(), schedule: String(input.schedule ?? '').trim(), keepLast: Number(input.keep_last ?? 3), ...(input.bwlimit !== undefined ? { bwlimit: Number(input.bwlimit) } : {}), ...(typeof input.description === 'string' ? { kommentar: input.description } : {}) };
    const [jobs, vms, speicher] = await Promise.all([
      this.get<SicherungsJobVorhanden[]>('/cluster/backup').then(r => r ?? []),
      this.getAllVms(),
      this.get<Array<{ storage: string; content?: string; disable?: number }>>('/storage').then(r => r ?? []),
    ]);
    const p = sicherungsJobPruefung(w, jobs, vms.map(v => v.vmid), speicher.filter(s => !s.disable && (s.content ?? '').split(',').includes('backup')).map(s => s.storage));
    if (p.fehler.length) return { success: false, error: `Sicherungsjob nicht angelegt: ${p.fehler.join('; ')}` };
    if (p.gleich) return { success: true, data: { id: w.id, vorhanden: true }, display: `Sicherungsjob ${w.id} ist bereits genau so vorhanden` };
    await this.post('/cluster/backup', p.body);
    const nachher = ((await this.get<SicherungsJobVorhanden[]>('/cluster/backup')) ?? []).find(j => j.id === w.id);
    if (!nachher) return { success: false, error: `Sicherungsjob ${w.id} nach dem Anlegen nicht nachlesbar` };
    return { success: true, data: { id: w.id, ...p.body }, display: `✅ Sicherungsjob ${w.id}: VMs ${String(p.body!.vmid)} → ${w.storage}, ${w.schedule}, je VM die letzten ${w.keepLast}${w.bwlimit ? `, höchstens ${Math.round(w.bwlimit / 1024)} MiB/s` : ''}` };
  }

  /** Rückweg: nur eigene Jobs (alfred-…) */
  private async deleteBackupJob(input: Record<string, unknown>): Promise<SkillResult> {
    const id = String(input.job_id ?? '').trim();
    if (!SICHERUNGSJOB_ID.test(id)) return { success: false, error: 'delete_backup_job: nur eigene Jobs (alfred-…)' };
    const da = ((await this.get<SicherungsJobVorhanden[]>('/cluster/backup')) ?? []).some(j => j.id === id);
    if (!da) return { success: true, data: { id, schonWeg: true }, display: `Sicherungsjob ${id} gibt es nicht (mehr)` };
    await this.del(`/cluster/backup/${encodeURIComponent(id)}`);
    if (((await this.get<SicherungsJobVorhanden[]>('/cluster/backup')) ?? []).some(j => j.id === id)) return { success: false, error: `Sicherungsjob ${id} ist nach dem Löschen noch vorhanden` };
    return { success: true, data: { id, entfernt: true }, display: `✅ Sicherungsjob ${id} entfernt (vorhandene Sicherungsdateien bleiben)` };
  }

  /** Eine vzdump-Sicherungsdatei entfernen (Stilllegung) — nur im Change; danach nachlesen */
  private async deleteBackup(input: Record<string, unknown>): Promise<SkillResult> {
    const volid = String(input.volid ?? '');
    if (!SICHERUNG_VOLUME.test(volid)) return { success: false, error: 'delete_backup: volid einer vzdump-Sicherung (speicher:backup/vzdump-qemu-<vmid>-<datum>.vma.zst)' };
    const node = (input.node as string) ?? this.config.defaultNode;
    if (!node) return { success: false, error: 'delete_backup braucht node' };
    const storage = volid.split(':')[0]!;
    const vorher = await this.get<Array<{ volid: string; size?: number; protected?: number }>>(`/nodes/${node}/storage/${storage}/content?content=backup`);
    const v = vorher.find(x => x.volid === volid);
    if (!v) return { success: true, data: { volid, schonWeg: true }, display: `${volid} gibt es nicht (mehr)` };
    if (v.protected) return { success: false, error: `${volid} ist geschützt (protected) — nicht gelöscht` };
    await this.aufgabeOderFehler(await this.del<string>(`/nodes/${node}/storage/${storage}/content/${encodeURIComponent(volid)}`), 600_000, 'Sicherung löschen');
    const nachher = await this.get<Array<{ volid: string }>>(`/nodes/${node}/storage/${storage}/content?content=backup`);
    if (nachher.some(x => x.volid === volid)) return { success: false, error: `${volid} ist nach dem Löschen noch vorhanden` };
    return { success: true, data: { volid, entfernt: true, gb: Math.round((v.size ?? 0) / 1e9) }, display: `Sicherung ${volid} entfernt (${Math.round((v.size ?? 0) / 1e9)} GB frei)` };
  }

  private async deleteImage(input: Record<string, unknown>): Promise<SkillResult> {
    const volid = input.volid as string;
    if (!IMPORT_VOLUME.test(volid ?? '')) return { success: false, error: 'delete_image: volid eines import-Volumes' };
    const node = (input.node as string) ?? this.config.defaultNode;
    const storage = volid.split(':')[0]!;
    const upid = await this.del<string>(`/nodes/${node}/storage/${storage}/content/${encodeURIComponent(volid)}`);
    await this.aufgabeOderFehler(upid, 120_000, 'Image entfernen');
    return { success: true, data: { volid, entfernt: true }, display: `Image ${volid} entfernt` };
  }

  // ── I8a Windows-Vorlagen ─────────────────────────────────────

  /** Ziel einer Weiterleitung (fwlink → aka.ms → Download-Server) ohne Herunterladen; nur über HTTPS mit Zertifikatsprüfung */
  private async zielUrl(url: string): Promise<{ url: string; groesse?: number }> {
    const res = await tlsFetch(url, { method: 'HEAD', redirect: 'follow' } as RequestInit, false);
    if (!res.ok) throw new Error(`${url.slice(0, 80)}: HTTP ${res.status}`);
    const g = Number(res.headers.get('content-length'));
    return { url: res.url, ...(Number.isFinite(g) && g > 0 ? { groesse: g } : {}) };
  }

  /** Aktuellste Server-Testversion und Windows 11 Enterprise je Sprache, VirtIO-ISO und Cloudbase-Init — alles mit fester Herkunft */
  private async listWindowsImages(input: Record<string, unknown>): Promise<SkillResult> {
    const sprache = typeof input.sprache === 'string' && SPRACHE.test(input.sprache.toLowerCase()) ? input.sprache.toLowerCase() : 'en-us';
    const isos: Array<{ produkt: string; version: string; build: string; sprache: string; url: string; filename: string; gb?: number }> = [];
    const fehler: string[] = [];
    let server: { version: string; fwlink: string } | undefined;
    for (const seite of serverSeiten(new Date())) {
      const html = await this.holeText(seite.url).catch(() => '');
      const l = evalLinks(html, 'server').find(x => x.sprache === sprache);
      if (l) { server = { version: l.version ?? seite.version, fwlink: l.fwlink }; break; }
    }
    if (!server) fehler.push(`Windows Server: keine Download-Seite mit ISO (${sprache}) gefunden`);
    const w11 = evalLinks(await this.holeText(WIN11_SEITE).catch(() => ''), 'win11').find(x => x.sprache === sprache);
    if (!w11) fehler.push(`Windows 11 Enterprise: kein ISO (${sprache}) gefunden`);
    for (const [produkt, version, fwlink] of [['server', server?.version, server?.fwlink], ['win11', '11', w11?.fwlink]] as const) {
      if (!fwlink || !version) continue;
      try {
        const z = await this.zielUrl(fwlink);
        const build = buildAusUrl(z.url);
        if (!WIN_ISO_URL.test(z.url) || !build) { fehler.push(`${produkt}: Weiterleitung auf unerwartete Adresse ${z.url.slice(0, 100)}`); continue; }
        isos.push({ produkt: produkt === 'server' ? `Windows Server ${version}` : 'Windows 11 Enterprise', version, build, sprache, url: z.url, filename: isoDateiname(produkt, version, build, sprache), ...(z.groesse ? { gb: Math.round(z.groesse / 1e8) / 10 } : {}) });
      } catch (err) { fehler.push(`${produkt}: ${(err as Error).message.slice(0, 120)}`); }
    }
    const virtio = neuesteVirtio(await this.holeText(VIRTIO_ARCHIV).catch(() => ''));
    if (!virtio) fehler.push('VirtIO: keine Version im Archiv gefunden');
    let cloudbase: { version: string; url: string } | undefined;
    try {
      const rel = JSON.parse(await this.holeText('https://api.github.com/repos/cloudbase/cloudbase-init/releases/latest')) as { tag_name?: string; assets?: Array<{ browser_download_url?: string }> };
      const url = (rel.assets ?? []).map(x => x.browser_download_url ?? '').find(u => CLOUDBASE_URL.test(u) && u.endsWith('_x64.msi'));
      if (url) cloudbase = { version: CLOUDBASE_URL.exec(url)![1]!, url }; else fehler.push('Cloudbase-Init: kein x64-MSI in der neuesten Version');
    } catch (err) { fehler.push(`Cloudbase-Init: ${(err as Error).message.slice(0, 120)}`); }
    const zeilen = [
      ...isos.map(i => `- **${i.produkt}** Build ${i.build} (${i.sprache}${i.gb ? `, ${i.gb} GB` : ''}): url ${i.url}\n  → filename ${i.filename}`),
      ...(virtio ? [`- **VirtIO** ${virtio.version}: url ${virtio.url}\n  → filename virtio-win-${virtio.version.replace(/-\d+$/, '')}.iso`] : []),
      ...(cloudbase ? [`- **Cloudbase-Init** ${cloudbase.version}: cloudbase_url ${cloudbase.url}`] : []),
      'Testversionen: Server 180 Tage, Windows 11 Enterprise 90 Tage ab Installation. Microsoft veröffentlicht keine Prüfsummen — Alfred berechnet die SHA-256 nach dem Laden am Knoten.',
      ...fehler.map(f => `⚠️ ${f}`),
    ];
    return { success: isos.length > 0, data: { isos, virtio: virtio ? { ...virtio, filename: `virtio-win-${virtio.version.replace(/-\d+$/, '')}.iso` } : undefined, cloudbase, fehler }, display: zeilen.join('\n'), ...(isos.length ? {} : { error: fehler.join('; ') || 'keine ISOs' }) };
  }

  /** ISO laden (Proxmox download-url, Zertifikatsprüfung an); nur feste Herkunft. Liefert die Aufgabe — der Change-Motor verfolgt sie. */
  private async downloadIso(input: Record<string, unknown>): Promise<SkillResult> {
    const url = String(input.url ?? ''); const filename = String(input.filename ?? '');
    if (!WIN_ISO_URL.test(url) && !VIRTIO_URL.test(url)) return { success: false, error: 'url: Microsoft-Testversion (software-static.download.prss.microsoft.com) oder VirtIO-ISO aus dem Archiv — aus list_windows_images' };
    if (!ISO_DATEI.test(filename)) return { success: false, error: 'filename: Kleinbuchstaben, Ziffern, . _ - und Endung .iso (aus list_windows_images)' };
    const node = (input.node as string) ?? this.config.defaultNode;
    const storage = String(input.storage ?? '');
    if (!node || !storage) return { success: false, error: 'download_iso braucht node und storage' };
    const st = (await this.get<Array<{ storage: string; content?: string; avail?: number }>>(`/nodes/${node}/storage`)).find(s => s.storage === storage);
    if (!st) return { success: false, error: `Speicher ${storage} gibt es auf ${node} nicht` };
    if (!String(st.content ?? '').split(',').includes('iso')) return { success: false, error: `Speicher ${storage} hat keinen Inhalt „iso“ (${st.content ?? '-'})` };
    const volid = `${storage}:iso/${filename}`;
    const vorhanden = await this.get<Array<{ volid: string; size?: number }>>(`/nodes/${node}/storage/${storage}/content?content=iso`).catch(() => [] as Array<{ volid: string; size?: number }>);
    const da = vorhanden.find(v => v.volid === volid);
    if (da) return { success: true, data: { node, storage, volid, vorhanden: true }, display: `${volid} ist schon vorhanden (${Math.round((da.size ?? 0) / 1e8) / 10} GB)` };
    if (st.avail !== undefined && st.avail < 12e9) return { success: false, error: `Speicher ${storage} auf ${node} hat nur ${Math.round(st.avail / 1e9)} GB frei — für ein Windows-ISO zu wenig` };
    const upid = await this.post<string>(`/nodes/${node}/storage/${storage}/download-url`, { content: 'iso', filename, url, 'verify-certificates': 1 });
    return { success: true, data: { upid, node, storage, volid }, display: `ISO wird geladen: ${url} → ${volid}` };
  }

  private async deleteIso(input: Record<string, unknown>): Promise<SkillResult> {
    const volid = String(input.volid ?? '');
    if (!ISO_VOLUME.test(volid)) return { success: false, error: 'delete_iso: volid eines ISO (speicher:iso/…iso)' };
    const node = (input.node as string) ?? this.config.defaultNode;
    const storage = volid.split(':')[0]!;
    const da = (await this.get<Array<{ volid: string }>>(`/nodes/${node}/storage/${storage}/content?content=iso`)).some(v => v.volid === volid);
    if (!da) return { success: true, data: { volid, schonWeg: true }, display: `${volid} gibt es nicht (mehr)` };
    await this.aufgabeOderFehler(await this.del<string>(`/nodes/${node}/storage/${storage}/content/${encodeURIComponent(volid)}`), 120_000, 'ISO entfernen');
    return { success: true, data: { volid, entfernt: true }, display: `ISO ${volid} entfernt` };
  }

  /** Höchste q35-Maschinenversion des Knotens (Windows bekommt eine feste) */
  private async q35Version(node: string): Promise<string | undefined> {
    const m = await this.get<Array<{ id: string; type?: string }>>(`/nodes/${node}/capabilities/qemu/machines`).catch(() => [] as Array<{ id: string; type?: string }>);
    const v = m.map(x => /^pc-q35-(\d+)\.(\d+)$/.exec(x.id)).filter((x): x is RegExpExecArray => !!x).sort((a, b) => Number(a[1]) - Number(b[1]) || Number(a[2]) - Number(b[2])).pop();
    return v?.[0];
  }

  /**
   * Bau einer Windows-Vorlage: Abbild aus dem ISO wählen, Antwort-ISO (Antwortdatei, Einrichtungsskript, Cloudbase-Init, Treiber)
   * am Knoten bauen, VM mit UEFI/TPM anlegen und starten. Die Installation läuft danach allein und endet mit sysprep + Ausschalten.
   */
  private async buildWindowsTemplate(input: Record<string, unknown>): Promise<SkillResult> {
    if (!this.fabrik?.knotenSkript) return { success: false, error: 'Windows-Fabrik ist nicht eingerichtet (Fernzugriff auf den Knoten fehlt)' };
    const node = (input.node as string) ?? this.config.defaultNode;
    const storage = String(input.storage ?? '');
    const iso = String(input.iso ?? ''); const virtioIso = String(input.virtio_iso ?? '');
    const variante = input.variante; const name = String(input.hostname ?? '');
    const cloudbase = String(input.cloudbase_url ?? '');
    if (!node || !storage) return { success: false, error: 'build_windows_template braucht node und storage' };
    if (!istWinVariante(variante)) return { success: false, error: `variante: ${WIN_VARIANTEN.join(', ')}` };
    if (!ISO_VOLUME.test(iso) || !ISO_VOLUME.test(virtioIso)) return { success: false, error: 'iso und virtio_iso: Volumes aus download_iso (speicher:iso/…iso)' };
    if (!CLOUDBASE_URL.test(cloudbase)) return { success: false, error: 'cloudbase_url: MSI aus list_windows_images' };
    if (!VM_NAME.test(name)) return { success: false, error: 'hostname: Name der Vorlage (Kleinbuchstaben, Ziffern, -)' };
    const sprache = /-([a-z]{2}-[a-z]{2})\.iso$/.exec(iso)?.[1];
    if (!sprache) return { success: false, error: 'Sprache aus dem ISO-Namen nicht lesbar (…-en-us.iso)' };
    if (variante === 'win11' ? !/win11/.test(iso) : !/win-server/.test(iso)) return { success: false, error: `ISO ${iso} passt nicht zur Variante ${variante}` };
    const vmid = typeof input.new_vmid === 'number' ? input.new_vmid : parseInt(String(await this.get('/cluster/nextid')), 10);
    if (!(await this.vmidFrei(vmid))) return { success: false, error: `VMID ${vmid} ist vergeben` };
    if ((await this.getAllVms()).some(v => v.name === name)) return { success: false, error: `Name ${name} ist vergeben` };
    for (const v of [iso, virtioIso]) {
      const [sp] = v.split(':');
      const liste = await this.get<Array<{ volid: string }>>(`/nodes/${node}/storage/${sp}/content?content=iso`).catch(() => [] as Array<{ volid: string }>);
      if (!liste.some(x => x.volid === v)) return { success: false, error: `${v} gibt es auf ${node} nicht` };
    }
    const insp = knotenJson<{ abbilder: WimAbbild[]; virtio: string[]; gastWerkzeuge: boolean }>(await this.fabrik.knotenSkript(node, 'win-inspektion', JSON.stringify({ windows: iso, virtio: virtioIso }), 300_000));
    const abbild = waehleAbbild(insp.abbilder, variante as WinVariante);
    if (!abbild) return { success: false, error: `Im ISO gibt es kein Abbild für ${variante} (vorhanden: ${insp.abbilder.map(a => `${a.index} ${a.editionId}/${a.installationType}`).join(', ')})` };
    const ordner = virtioOrdner(variante as WinVariante).find(o => insp.virtio.includes(o));
    if (!ordner || !insp.gastWerkzeuge) return { success: false, error: `VirtIO-ISO ohne passende Treiber (${virtioOrdner(variante as WinVariante).join('/')}) oder ohne virtio-win-guest-tools.exe` };
    const kennwort = zufallsKennwort(n => randomBytes(n));
    const regional = { sprache };
    const b64 = (t: string) => Buffer.from(t, 'utf-8').toString('base64');
    const antwort = `local:iso/alfred-antwort-${vmid}.iso`;
    const r = knotenJson<{ iso: string; cloudbaseSha256: string; treiber: string[] }>(await this.fabrik.knotenSkript(node, 'win-antwort', JSON.stringify({
      ziel: antwort, virtio: virtioIso, ordner, treiber: VIRTIO_TREIBER, cloudbase,
      dateien: {
        'autounattend.xml': b64(autounattend({ variante: variante as WinVariante, index: abbild.index, regional, computer: `WIN-${vmid}`, kennwort })),
        'alfred-setup.ps1': b64(setupSkript({ variante: variante as WinVariante })),
        'alfred-sysprep.xml': b64(sysprepUnattend({ variante: variante as WinVariante, regional, kennwort: zufallsKennwort(n => randomBytes(n)) })),
        'cloudbase-init.conf': b64(CLOUDBASE_CONF),
        'cloudbase-init-unattend.conf': b64(CLOUDBASE_UNATTEND_CONF),
      },
    }), 900_000));
    if (!r.treiber.includes('vioscsi')) return { success: false, error: `Antwort-ISO ohne Speichertreiber vioscsi (${r.treiber.join(', ') || 'keine'})` };
    const machine = await this.q35Version(node);
    const beschreibung = `Windows-Vorlage von Alfred (I8a): ${variante}, Abbild ${abbild.index} „${abbild.name}“ Build ${abbild.build ?? '?'}, ISO ${iso}, VirtIO ${virtioIso} (${ordner}), Cloudbase-Init ${CLOUDBASE_URL.exec(cloudbase)![1]} (SHA-256 ${r.cloudbaseSha256.slice(0, 16)}…), gebaut ${new Date().toISOString().slice(0, 10)}`;
    const konfig = windowsBauKonfig({ vmid, name, storage, windowsIso: iso, virtioIso, antwortIso: antwort, beschreibung, ...(machine ? { machine } : {}), ...(typeof input.disk_size === 'number' ? { groesseGb: input.disk_size } : {}), ...(typeof input.memory === 'number' ? { memory: input.memory } : {}), ...(typeof input.cores === 'number' ? { cores: input.cores } : {}), ...(typeof input.bridge === 'string' ? { bridge: input.bridge } : {}), ...(typeof input.vlan_tag === 'number' ? { vlan: input.vlan_tag } : {}) });
    await this.aufgabeOderFehler(await this.post<string>(`/nodes/${node}/qemu`, konfig), 300_000, 'Bau-VM anlegen');
    this.vmCache = null;
    await this.aufgabeOderFehler(await this.post<string>(`/nodes/${node}/qemu/${vmid}/status/start`, {}), 120_000, 'Starten');
    // „Press any key to boot from CD or DVD“: ein paar Sekunden lang Eingabe senden, danach läuft alles unbeaufsichtigt
    for (let i = 0; i < 20; i++) {
      await this.api('PUT', `/nodes/${node}/qemu/${vmid}/sendkey`, { key: 'ret' }).catch(() => undefined);
      await new Promise(res => setTimeout(res, 1500));
    }
    return { success: true, data: { vmid, node, name, variante, abbild: { index: abbild.index, name: abbild.name, build: abbild.build }, antwortIso: antwort, machine, virtioOrdner: ordner, cloudbaseSha256: r.cloudbaseSha256 }, display: `Windows-Installation läuft: ${name} (VMID ${vmid}) auf ${node}, ${abbild.name} Build ${abbild.build ?? '?'}, Maschine ${machine ?? 'q35'} — die VM schaltet sich nach sysprep selbst aus (meist 30–90 min)` };
  }

  /** Einrichtungsprotokoll der Bau-VM über den Gast-Agenten (gibt es erst nach den Gast-Werkzeugen) */
  private async windowsBuildLog(input: Record<string, unknown>): Promise<SkillResult> {
    const vmid = Number(input.vmid);
    const vm = (await this.getAllVms()).find(v => v.vmid === vmid);
    if (!vm) return { success: false, error: `VMID ${vmid} nicht gefunden` };
    try {
      const r = await this.get<{ content?: string; truncated?: boolean }>(`/nodes/${vm.node}/qemu/${vmid}/agent/file-read?file=${encodeURIComponent('C:\\Windows\\Temp\\alfred-setup.log')}`);
      const t = String(r.content ?? '');
      const marken = t.split(/\r?\n/).filter(z => z.startsWith('ALFRED:')).join('\n');
      return { success: true, data: { marken, ende: t.slice(-3000) }, display: `Einrichtungsprotokoll ${vm.name ?? vmid}:\n${marken || '(noch keine Schritte)'}\n…\n${t.slice(-1500)}` };
    } catch (err) {
      return { success: false, error: `Protokoll nicht lesbar (${(err as Error).message.slice(0, 120)}) — vor der Installation der Gast-Werkzeuge antwortet der Agent nicht; Konsole in Proxmox ansehen` };
    }
  }

  /** Bau abschließen: VM aus, CDs und Antwort-ISO weg, Konfigurationslaufwerk für Cloudbase-Init, dann Vorlage */
  private async finishWindowsTemplate(input: Record<string, unknown>): Promise<SkillResult> {
    const vmid = Number(input.vmid); const name = String(input.vm_name ?? '').trim();
    this.vmCache = null;
    const vm = (await this.getAllVms()).find(v => v.vmid === vmid);
    if (!vm) return { success: false, error: `VMID ${vmid} nicht gefunden` };
    if (vm.name !== name) return { success: false, error: `VMID ${vmid} heißt „${vm.name}“, nicht „${name}“` };
    const cfg = await this.get<Record<string, unknown>>(`/nodes/${vm.node}/qemu/${vmid}/config`);
    if (!String(cfg.description ?? '').startsWith('Windows-Vorlage von Alfred (I8a)')) return { success: false, error: `${name} ist keine Windows-Bau-VM von Alfred` };
    if (cfg.template) return { success: true, data: { vmid, name, node: vm.node, template: true, vorhanden: true }, display: `${name} ist schon eine Vorlage` };
    const st = await this.get<{ status?: string }>(`/nodes/${vm.node}/qemu/${vmid}/status/current`);
    if (st.status !== 'stopped') return { success: false, error: `${name} läuft noch (${st.status}) — Installation/sysprep nicht fertig; windows_build_log zeigt den Stand` };
    const antwort = Object.values(cfg).map(String).map(v => /^(local:iso\/alfred-antwort-\d+\.iso)/.exec(v)?.[1]).find(Boolean);
    const cds = Object.keys(cfg).filter(k => /^(ide|sata)\d+$/.test(k) && String(cfg[k]).includes('media=cdrom'));
    const storage = /^([\w-]+):/.exec(String(cfg.scsi0 ?? ''))?.[1];
    await this.post(`/nodes/${vm.node}/qemu/${vmid}/config`, { ...(cds.length ? { delete: cds.join(',') } : {}), boot: 'order=scsi0', ...(storage ? { ide0: `${storage}:cloudinit` } : {}) });
    if (antwort) await this.deleteIso({ volid: antwort, node: vm.node }).catch(() => undefined);
    await this.aufgabeOderFehler(await this.post<string>(`/nodes/${vm.node}/qemu/${vmid}/template`, {}), 300_000, 'zur Vorlage machen');
    this.vmCache = null;
    return { success: true, data: { vmid, name, node: vm.node, template: true, entfernteCds: cds, antwortIsoEntfernt: antwort ?? null }, display: `✅ Windows-Vorlage ${name} (VMID ${vmid}) fertig: CDs ${cds.join(', ') || '-'} entfernt, Antwort-ISO ${antwort ? 'gelöscht' : '-'}, Konfigurationslaufwerk für Cloudbase-Init angelegt` };
  }

  /**
   * I8a — neue Windows-VM aus einer Windows-Vorlage: Klon, Benutzerdaten (Host-Schlüssel von Alfred, Anmeldeschlüssel, Kennwort aus
   * dem Tresor) über das Konfigurationslaufwerk, feste IP; Fernzugang (Windows) + CMDB; danach Snippet und Laufwerk weg.
   */
  private async provisionWindowsVm(input: Record<string, unknown>): Promise<SkillResult> {
    if (!this.fabrik?.kennwortSichern) return { success: false, error: 'Windows-Fabrik ist nicht eingerichtet (Tresor/Fernzugriff fehlt)' };
    const name = String(input.hostname ?? ''); const ip = String(input.ip ?? ''); const tpl = Number(input.template);
    if (!VM_NAME.test(name) || name.length > 15) return { success: false, error: 'hostname: Kleinbuchstaben, Ziffern, -, höchstens 15 Zeichen (Windows-Computername)' };
    if (!/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(ip) || typeof input.gateway !== 'string') return { success: false, error: 'ip als CIDR (z. B. 10.203.28.5/28) und gateway angeben' };
    const alle = await this.getAllVms();
    const vorlage = alle.find(v => v.vmid === tpl);
    if (!vorlage) return { success: false, error: `Vorlage ${tpl} gibt es nicht` };
    const tplCfg = await this.get<{ description?: string; template?: number }>(`/nodes/${vorlage.node}/qemu/${tpl}/config`);
    const variante = /Windows-Vorlage von Alfred \(I8a\): ([\w-]+),/.exec(String(tplCfg.description ?? ''))?.[1];
    if (!tplCfg.template || !istWinVariante(variante)) return { success: false, error: `${tpl} ist keine Windows-Vorlage von Alfred` };
    if (alle.some(v => v.name === name)) return { success: false, error: `Name ${name} ist in Proxmox vergeben` };
    const nackt = ip.replace(/\/\d+$/, '');
    const hindernisse = await this.fabrik.vorpruefung({ name, ip: nackt });
    if (hindernisse.length) return { success: false, error: hindernisse.join('; ') };
    const node = (input.node as string) ?? vorlage.node;
    const vmid = typeof input.new_vmid === 'number' ? input.new_vmid : parseInt(String(await this.get('/cluster/nextid')), 10);
    if (!(await this.vmidFrei(vmid))) return { success: false, error: `VMID ${vmid} ist vergeben` };
    const clone: Record<string, unknown> = { newid: vmid, name, full: 1, target: node };
    // Realfall 3103ec4c (09.11.): wie v1644 bei Linux — in einen lokalen Speicher eines anderen Nodes klont Proxmox nicht
    // („storage 'data2-pve1' is not available on node 'pve'“). Dann auf den gemeinsamen Speicher der Vorlage an den Ziel-Node
    // klonen und System-, EFI- und TPM-Platte danach verschieben.
    const wunsch = typeof input.storage === 'string' && input.storage ? input.storage : undefined;
    let verschiebenNach: string | undefined;
    if (wunsch) {
      const st = await this.get<{ type?: string; shared?: number }>(`/storage/${encodeURIComponent(wunsch)}`).catch(() => ({} as { type?: string; shared?: number }));
      const gemeinsam = !!st.shared || ['rbd', 'cephfs', 'nfs', 'cifs', 'glusterfs', 'iscsi', 'iscsidirect', 'pbs'].includes(String(st.type ?? ''));
      if (node !== vorlage.node && !gemeinsam) verschiebenNach = wunsch; else clone.storage = wunsch;
    }
    const schritte: string[] = [];
    await this.aufgabeOderFehler(await this.post<string>(`/nodes/${vorlage.node}/qemu/${tpl}/clone`, clone), 1_800_000, 'Klonen');
    this.vmCache = null;
    schritte.push(`VM ${name} (VMID ${vmid}) aus Windows-Vorlage ${tpl} (${variante}) auf ${node} geklont`);
    if (verschiebenNach) {
      const vorher = await this.get<Record<string, unknown>>(`/nodes/${node}/qemu/${vmid}/config`);
      const platten = ['scsi0', 'efidisk0', 'tpmstate0'].filter(k => typeof vorher[k] === 'string' && !String(vorher[k]).startsWith(`${verschiebenNach}:`));
      for (const disk of platten) await this.aufgabeOderFehler(await this.post<string>(`/nodes/${node}/qemu/${vmid}/move_disk`, { disk, storage: verschiebenNach, delete: 1 }), 1_800_000, `Platte ${disk} verschieben`);
      const nachher = await this.get<Record<string, unknown>>(`/nodes/${node}/qemu/${vmid}/config`);
      const falsch = platten.filter(k => !String(nachher[k] ?? '').startsWith(`${verschiebenNach}:`));
      if (falsch.length) return { success: false, error: `${falsch.join(', ')} von ${name} liegt nach dem Verschieben nicht auf ${verschiebenNach}`, data: { vmid, name, node, ip } };
      schritte.push(`${platten.join(', ')} nach ${verschiebenNach} auf ${node} verschoben (über den gemeinsamen Speicher der Vorlage geklont)`);
    }
    const hs = await this.fabrik.hostSchluessel();
    const kennwort = zufallsKennwort(n => randomBytes(n));
    const tresorName = await this.fabrik.kennwortSichern(name, kennwort);
    schritte.push(`Kennwort für alfred${variante === 'win11' ? '' : ' und Administrator'} im Tresor (${tresorName})`);
    // v1745 (Owner 01.11.: eigener Zugang) — Konto des Owners (Standard „madh“, leer = keins) mit eigenem Kennwort, dazu sein SSH-Schlüssel
    const ownerName = typeof input.owner_konto === 'string' ? input.owner_konto.trim().toLowerCase() : 'madh';
    const ownerKonto = ownerName ? { name: ownerName, kennwort: zufallsKennwort(n => randomBytes(n)) } : undefined;
    if (ownerKonto) schritte.push(`Konto ${ownerKonto.name} (Administrator), Kennwort im Tresor (${await this.fabrik.kennwortSichern(name, ownerKonto.kennwort, ownerKonto.name)})`);
    const ownerSchluessel = await this.fabrik.ownerSchluessel?.().catch(() => undefined);
    const weitere = [...(typeof input.ssh_public_key === 'string' && input.ssh_public_key.trim() ? [input.ssh_public_key.trim()] : []), ...(ownerSchluessel ? [ownerSchluessel.trim()] : [])];
    if (ownerSchluessel) schritte.push('dein SSH-Schlüssel eingetragen');
    if (input.rdp === true) schritte.push('Remotedesktop eingeschaltet (nur mit Netzwerkebenen-Authentifizierung)');
    const daten = windowsBenutzerDaten({ variante, hostname: name, alfredSchluessel: await this.fabrik.alfredSchluessel(), weitereSchluessel: weitere, hostPrivat: hs.privat, hostOeffentlich: hs.oeffentlich, kennwort, ...(ownerKonto ? { ownerKonto } : {}), ...(input.rdp === true ? { rdp: true } : {}) });
    const sp = await this.get<{ path?: string }>('/storage/local');
    const pfad = `${sp.path ?? '/var/lib/vz'}/snippets/${snippetDatei(vmid)}`;
    await this.fabrik.snippetSchreiben(node, pfad, daten);
    try {
      const cfg = await this.get<Record<string, unknown>>(`/nodes/${node}/qemu/${vmid}/config`);
      const konfig: Record<string, unknown> = {
        cicustom: `user=local:snippets/${snippetDatei(vmid)}`, citype: 'configdrive2', ipconfig0: `ip=${ip},gw=${input.gateway}`, agent: 'enabled=1',
        description: `Angelegt von Alfred (I8a) aus Windows-Vorlage ${tpl} (${variante}) am ${new Date().toISOString().slice(0, 10)}. Host-Schlüssel ${hs.oeffentlich.split(' ')[1]?.slice(0, 16)}…, Kennwort im Tresor ${tresorName}`,
      };
      // Konfigurationslaufwerk (Cloudbase-Init) — Vorlagen aus finish_windows_template haben es, sonst anlegen
      if (!Object.values(cfg).some(v => String(v).includes('cloudinit'))) { const st = /^([\w-]+):/.exec(String(cfg.scsi0 ?? ''))?.[1]; if (st) konfig.ide0 = `${st}:cloudinit`; }
      if (typeof input.nameserver === 'string' && input.nameserver.trim()) konfig.nameserver = input.nameserver.trim();
      if (typeof input.memory === 'number') konfig.memory = input.memory;
      if (typeof input.cores === 'number') konfig.cores = input.cores;
      if (input.bridge || input.vlan_tag) konfig.net0 = `virtio,bridge=${(input.bridge as string) ?? 'vmbr0'}${input.vlan_tag ? `,tag=${input.vlan_tag as number}` : ''}`;
      await this.post(`/nodes/${node}/qemu/${vmid}/config`, konfig);
      if (typeof input.disk_size === 'number' && input.disk_size > 0) await this.aufgabeOderFehler(await this.api<string>('PUT', `/nodes/${node}/qemu/${vmid}/resize`, { disk: 'scsi0', size: `${Math.floor(input.disk_size)}G` }), 120_000, 'Platte vergrößern');
      // I8c — zweite Platte (z. B. Systemstatus-Sicherung eines DC); Windows sieht sie roh, Einrichten macht der AD-Baustein
      if (typeof input.extra_disk_size === 'number' && input.extra_disk_size > 0) {
        const st = (typeof input.storage === 'string' && input.storage) || /^([\w-]+):/.exec(String(cfg.scsi0 ?? ''))?.[1];
        if (!st) throw new Error('Speicher für die zweite Platte unbekannt (storage angeben)');
        await this.post(`/nodes/${node}/qemu/${vmid}/config`, { scsi1: `${st}:${Math.floor(input.extra_disk_size)},discard=on,iothread=1,ssd=1` });
        schritte.push(`zweite Platte ${Math.floor(input.extra_disk_size)} GB (scsi1, ${st})`);
      }
      await this.aufgabeOderFehler(await this.post<string>(`/nodes/${node}/qemu/${vmid}/status/start`, {}), 120_000, 'Starten');
      schritte.push(`gestartet mit ${ip}; Windows richtet sich ein (Name, Netz, Schlüssel) — mit Neustart`);
      const a = await this.fabrik.anmelden({ name, ip: nackt, node, vmid, hostSchluessel: hs.oeffentlich, vorlage: tpl, zeitlimitMs: 1_800_000, system: 'windows', nachholen: () => this.windowsEinrichtungNachholen(vmid, node) });
      schritte.push(a.meldung);
      if (!a.ok) return { success: false, error: schritte.join('\n'), data: { vmid, name, node, ip: nackt } };
      const ga = await this.warteAufAgent(vmid, node, AGENT_WARTEN_MS);
      schritte.push(ga.meldung);
      if (!ga.ok) return { success: false, error: schritte.join('\n'), data: { vmid, name, node, ip: nackt } };
    } finally {
      await this.fabrik.snippetEntfernen(node, pfad).catch(() => undefined);
      await this.cloudInitLoesen(node, vmid);
    }
    schritte.push('Benutzerdaten-Snippet entfernt, Konfigurationslaufwerk vorgemerkt');
    return { success: true, data: { vmid, name, node, ip: nackt, vorlage: tpl, variante, tresor: tresorName, hostSchluessel: hs.oeffentlich }, display: schritte.map(x => `- ${x}`).join('\n') };
  }

  /** Antwort mit allen Feldern (Proxmox meldet ausstehende Netzänderungen als `changes` neben `data`) */
  private async apiRoh(path: string): Promise<{ data?: unknown; changes?: string }> {
    const res = await tlsFetch(`${this.config.baseUrl}/api2/json${path}`, { method: 'GET', headers: { Authorization: `PVEAPIToken=${this.config.tokenId}=${this.config.tokenSecret}` } }, this.config.verifyTls === false);
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${(await res.text().catch(() => '')).slice(0, 300)}`);
    return (await res.json()) as { data?: unknown; changes?: string };
  }

  /** I8c — VLAN-Bridge anlegen (nur im Change); Rückweg delete_vlan_bridge. Nur wenn sonst nichts aussteht (fremde Änderungen würden mit wirksam). */
  private async vlanBridgeAnlegen(input: Record<string, unknown>): Promise<SkillResult> {
    const node = String(input.node ?? '');
    if (!node) return { success: false, error: 'node angeben' };
    const roh = await this.apiRoh(`/nodes/${node}/network`);
    if (roh.changes) return { success: false, error: `Auf ${node} stehen schon Netzänderungen aus — nichts angelegt (erst klären, sonst würden sie mit wirksam):\n${String(roh.changes).slice(0, 600)}` };
    const netz = (roh.data as NetzIface[] | undefined) ?? [];
    const p = vlanBridgePlan(netz, { vlan: Number(input.vlan), ueber: String(input.ueber ?? ''), ...(typeof input.bridge === 'string' && input.bridge ? { bridge: input.bridge } : {}) });
    if (p.fehler) return { success: false, error: p.fehler };
    if (p.vorhanden) return { success: true, data: { node, bridge: p.vorhanden, port: p.port, vorhanden: true }, display: `Bridge ${p.vorhanden} mit ${p.port} gibt es auf ${node} schon` };
    await this.post(`/nodes/${node}/network`, { iface: p.bridge, type: 'bridge', bridge_ports: p.port, autostart: 1, comments: `${ALFRED_BRIDGE_KOMMENTAR} ${Number(input.vlan)} über ${String(input.ueber)}` });
    await this.aufgabeOderFehler(await this.api<string>('PUT', `/nodes/${node}/network`), 180_000, 'Netz neu laden', true);
    const aktiv = ((await this.get<NetzIface[]>(`/nodes/${node}/network`)) ?? []).find(n => n.iface === p.bridge);
    if (!aktiv || Number(aktiv.active) !== 1) return { success: false, error: `Bridge ${p.bridge} nach dem Neuladen nicht aktiv`, data: { node, bridge: p.bridge } };
    return { success: true, data: { node, bridge: p.bridge, port: p.port }, display: `✅ Bridge ${p.bridge} auf ${node} angelegt und aktiv (Port ${p.port}, VLAN ${Number(input.vlan)}) — VMs mit bridge=${p.bridge} ohne Tag anbinden` };
  }

  /** I8c — Rückweg: nur von Alfred angelegte Bridges, und nur wenn keine VM sie nutzt */
  private async vlanBridgeEntfernen(input: Record<string, unknown>): Promise<SkillResult> {
    const node = String(input.node ?? ''); const bridge = String(input.bridge ?? '');
    if (!node || !/^vmbr\d{1,4}$/.test(bridge)) return { success: false, error: 'node und bridge (vmbr<Zahl>) angeben' };
    const roh = await this.apiRoh(`/nodes/${node}/network`);
    if (roh.changes) return { success: false, error: `Auf ${node} stehen Netzänderungen aus — nichts entfernt` };
    const b = ((roh.data as NetzIface[] | undefined) ?? []).find(n => n.iface === bridge);
    if (!b) return { success: true, data: { node, bridge, schonWeg: true }, display: `Bridge ${bridge} gibt es auf ${node} nicht (mehr)` };
    if (!String(b.comments ?? '').startsWith(ALFRED_BRIDGE_KOMMENTAR)) return { success: false, error: `${bridge} wurde nicht von Alfred angelegt — nichts entfernt` };
    for (const v of (await this.getAllVms()).filter(x => x.node === node && x.type === 'qemu')) {
      const cfg = await this.get<Record<string, unknown>>(`/nodes/${node}/qemu/${v.vmid}/config`).catch(() => ({} as Record<string, unknown>));
      if (Object.entries(cfg).some(([k, w]) => /^net\d+$/.test(k) && new RegExp(`bridge=${bridge}(,|$)`).test(String(w)))) return { success: false, error: `${bridge} wird noch von VM ${v.vmid} (${v.name}) genutzt — nichts entfernt` };
    }
    await this.del(`/nodes/${node}/network/${bridge}`);
    await this.aufgabeOderFehler(await this.api<string>('PUT', `/nodes/${node}/network`), 180_000, 'Netz neu laden', true);
    if (((await this.get<NetzIface[]>(`/nodes/${node}/network`)) ?? []).some(n => n.iface === bridge)) return { success: false, error: `Bridge ${bridge} nach dem Entfernen noch vorhanden` };
    return { success: true, data: { node, bridge, entfernt: true }, display: `✅ Bridge ${bridge} auf ${node} entfernt` };
  }

  /** I8c — VMs aus einem Job „alle VMs“ ausnehmen bzw. wieder aufnehmen (nur im Change, nur alfred-…); danach nachlesen */
  private async sicherungAusnehmen(input: Record<string, unknown>): Promise<SkillResult> {
    const id = String(input.job_id ?? '').trim();
    const liste = (x: unknown) => (Array.isArray(x) ? x : x === undefined || x === '' ? [] : String(x).split(',')).map(v => Number(String(v).trim()));
    const jobs = (await this.get<Array<{ id: string; all?: number | string; exclude?: string }>>('/cluster/backup')) ?? [];
    const p = sicherungsAusnahme(jobs.find(j => j.id === id), liste(input.add_vmids), liste(input.remove_vmids));
    if (p.fehler) return { success: false, error: `backup_job_exclude: ${p.fehler}` };
    if (p.gleich) return { success: true, data: { id, exclude: p.exclude }, display: `Ausnahmeliste von ${id} ist schon so: ${p.exclude || '(leer)'}` };
    await this.api('PUT', `/cluster/backup/${encodeURIComponent(id)}`, p.exclude ? { exclude: p.exclude } : { delete: 'exclude' });
    const nach = ((await this.get<Array<{ id: string; exclude?: string }>>('/cluster/backup')) ?? []).find(j => j.id === id);
    const ist = (nach?.exclude ?? '').split(',').map(x => Number(x.trim())).filter(Number.isInteger).sort((a, b) => a - b).join(',');
    if (ist !== p.exclude) return { success: false, error: `Ausnahmeliste von ${id} nach dem Ändern: ${ist || '(leer)'} statt ${p.exclude || '(leer)'}` };
    return { success: true, data: { id, exclude: p.exclude, vorher: p.vorher }, display: `✅ ${id} lässt jetzt aus: ${p.exclude || '(keine)'} (vorher ${p.vorher || '(keine)'})` };
  }

  /** I8c — Arbeitsspeicher/Kerne einer VM (nur im Change); alte Werte für den Rückweg; bei laufender VM wirksam nach reboot_vm */
  private async vmRessourcen(input: Record<string, unknown>): Promise<SkillResult> {
    const vmid = Number(input.vmid);
    const vm = (await this.getAllVms()).find(v => v.vmid === vmid && v.type === 'qemu');
    if (!vm) return { success: false, error: `VM ${input.vmid} gibt es nicht` };
    const mem = input.memory === undefined ? undefined : Number(input.memory); const cores = input.cores === undefined ? undefined : Number(input.cores);
    if (mem === undefined && cores === undefined) return { success: false, error: 'memory (MiB) und/oder cores angeben' };
    if (mem !== undefined && (!Number.isInteger(mem) || mem < 512 || mem > 524_288)) return { success: false, error: 'memory: MiB 512–524288' };
    if (cores !== undefined && (!Number.isInteger(cores) || cores < 1 || cores > 64)) return { success: false, error: 'cores: 1–64' };
    const cfg = await this.get<{ memory?: string | number; cores?: number; balloon?: number }>(`/nodes/${vm.node}/qemu/${vmid}/config`);
    // v1785 — Realfall 10.11. (12d82a15 Schritt 3, Wiederholung): /config liefert ausstehende Werte schon eingerechnet („RAM 6144 → 6144“,
    // Rückweg 6144) — „vorher“ ist der wirksame Wert (Feld value aus /pending)
    type Pend = Array<{ key: string; value?: unknown; pending?: unknown }>;
    const pend0 = await this.get<Pend>(`/nodes/${vm.node}/qemu/${vmid}/pending`).catch(() => [] as Pend);
    const wirksam = (k: string, alt: unknown) => { const e = (pend0 ?? []).find(x => x.key === k); return Number(e?.value ?? alt); };
    const vorher = { memory: wirksam('memory', cfg.memory ?? 512), cores: wirksam('cores', cfg.cores ?? 1) };
    if (mem !== undefined && cfg.balloon && Number(cfg.balloon) > mem) return { success: false, error: `Ballon-Minimum ${cfg.balloon} MiB liegt über ${mem} MiB` };
    const neu: Record<string, unknown> = { ...(mem !== undefined ? { memory: mem } : {}), ...(cores !== undefined ? { cores } : {}) };
    // v1783 — Realfall 10.11. (I8c D 12d82a15 Schritt 3): POST …/config läuft als Aufgabe; sofort nachgelesen stand noch der alte Wert
    await this.aufgabeOderFehler(await this.post<string>(`/nodes/${vm.node}/qemu/${vmid}/config`, neu), 120_000, 'VM-Ressourcen ändern');
    const pend =await this.get<Array<{ key: string; value?: unknown; pending?: unknown }>>(`/nodes/${vm.node}/qemu/${vmid}/pending`).catch(() => [] as Array<{ key: string; value?: unknown; pending?: unknown }>);
    const wert = (k: string) => { const e = pend.find(x => x.key === k); return e ? Number(e.pending ?? e.value) : undefined; };
    if ((mem !== undefined && wert('memory') !== mem) || (cores !== undefined && wert('cores') !== cores)) return { success: false, error: `nach dem Ändern gelesen: memory ${wert('memory')}, cores ${wert('cores')}` };
    const ausstehend = pend.some(x => (x.key === 'memory' || x.key === 'cores') && x.pending !== undefined);
    return { success: true, data: { vmid, node: vm.node, vorher, nachher: { ...vorher, ...neu }, ausstehend }, display: `✅ VM ${vmid} (${vm.name}): ${mem !== undefined ? `RAM ${vorher.memory} → ${mem} MiB` : ''}${mem !== undefined && cores !== undefined ? ', ' : ''}${cores !== undefined ? `Kerne ${vorher.cores} → ${cores}` : ''}${ausstehend ? ' — wirksam nach reboot_vm (Proxmox wendet ausstehende Änderungen beim Neustart an)' : ''}. Rückweg: set_vm_resources mit memory ${vorher.memory}, cores ${vorher.cores}` };
  }

  private async vmidFrei(vmid: number): Promise<boolean> {
    return !(await this.getAllVms()).some(v => v.vmid === vmid);
  }

  /** Vorlage aus einem import-Volume: VM anlegen (Platte importieren, Cloud-Init-Laufwerk), dann zur Vorlage machen */
  private async createTemplate(input: Record<string, unknown>): Promise<SkillResult> {
    const node = (input.node as string) ?? this.config.defaultNode;
    const name = input.hostname as string;
    const image = input.image as string;
    const storage = input.storage as string;
    if (!node) return { success: false, error: 'create_template braucht node' };
    if (!IMPORT_VOLUME.test(image ?? '') || !VM_NAME.test(name ?? '') || !storage) return { success: false, error: this.pruefeEingabe({ ...input, action: 'create_template' }) ?? 'Eingaben unvollständig' };
    const vmid = typeof input.new_vmid === 'number' ? input.new_vmid : parseInt(String(await this.get('/cluster/nextid')), 10);
    if (!(await this.vmidFrei(vmid))) return { success: false, error: `VMID ${vmid} ist vergeben` };
    if ((await this.getAllVms()).some(v => v.name === name)) return { success: false, error: `Name ${name} ist vergeben` };
    const beschreibung = `Vorlage von Alfred (I5) aus ${image}, angelegt ${new Date().toISOString().slice(0, 10)}`;
    const upid = await this.post<string>(`/nodes/${node}/qemu`, vorlagenKonfig({ vmid, name, storage, image, bridge: input.bridge as string | undefined, memory: input.memory as number | undefined, cores: input.cores as number | undefined, beschreibung }));
    this.vmCache = null;
    await this.aufgabeOderFehler(upid, 540_000, 'VM für die Vorlage anlegen');
    const upid2 = await this.post<string>(`/nodes/${node}/qemu/${vmid}/template`, {});
    await this.aufgabeOderFehler(upid2, 300_000, 'zur Vorlage machen');
    this.vmCache = null;
    return { success: true, data: { vmid, name, node, storage, image, template: true }, display: `Vorlage ${name} (VMID ${vmid}) auf ${node}/${storage} aus ${image}` };
  }

  /** Neue VM aus einer Vorlage: Benutzer alfred, Host-Schlüssel von Alfred (Snippet am Knoten), feste IP, Fernzugang + CMDB */
  private async provisionVm(input: Record<string, unknown>): Promise<SkillResult> {
    if (!this.fabrik) return { success: false, error: 'Vorlagen-Fabrik ist nicht eingerichtet (Fernzugriff fehlt)' };
    const f = this.pruefeEingabe({ ...input, action: 'provision_vm' });
    if (f) return { success: false, error: f };
    const name = input.hostname as string;
    const ip = input.ip as string;
    const tpl = Number(input.template);
    const alle = await this.getAllVms();
    const vorlage = alle.find(v => v.vmid === tpl);
    if (!vorlage) return { success: false, error: `Vorlage ${tpl} gibt es nicht` };
    const node = (input.node as string) ?? vorlage.node;
    // Realfall 22.10. (docker-dev-01: VM stand, SSH kam wegen eines Trunk-Ports nicht durch): eine von Alfred angelegte VM mit genau
    // dieser IP wird fortgesetzt statt neu angelegt — der Fernzugang mit ihrem Host-Schlüssel besteht schon
    const da = alle.find(v => v.name === name && v.type === 'qemu');
    if (da) {
      const cfg = await this.get<{ description?: string; ipconfig0?: string }>(`/nodes/${da.node}/qemu/${da.vmid}/config`).catch(() => ({} as { description?: string; ipconfig0?: string }));
      const vonAlfred = String(cfg.description ?? '').includes('Angelegt von Alfred (I5)') && String(cfg.ipconfig0 ?? '').includes(`ip=${ip},`);
      if (!vonAlfred || !this.fabrik.fortsetzen) return { success: false, error: `Name ${name} ist in Proxmox vergeben` };
      if (da.status !== 'running') await this.aufgabeOderFehler(await this.post<string>(`/nodes/${da.node}/qemu/${da.vmid}/status/start`, {}), 120_000, 'Starten');
      const a = await this.fabrik.fortsetzen({ name, ip: ip.replace(/\/\d+$/, ''), node: da.node, vmid: da.vmid, zeitlimitMs: 600_000 });
      if (!a.ok) return { success: false, error: `Fortsetzung von ${name} (VMID ${da.vmid}): ${a.meldung}`, data: { vmid: da.vmid, name, node: da.node } };
      const ga = await this.warteAufAgent(da.vmid, da.node, AGENT_WARTEN_MS);
      if (!ga.ok) return { success: false, error: `Fortsetzung von ${name} (VMID ${da.vmid}): ${a.meldung}\n${ga.meldung}`, data: { vmid: da.vmid, name, node: da.node } };
      await this.cloudInitLoesen(da.node, da.vmid);
      const sp = await this.get<{ path?: string }>('/storage/local').catch(() => ({} as { path?: string }));
      await this.fabrik.snippetEntfernen(da.node, `${sp.path ?? '/var/lib/vz'}/snippets/${snippetDatei(da.vmid)}`).catch(() => undefined);
      return { success: true, data: { vmid: da.vmid, name, node: da.node, ip: ip.replace(/\/\d+$/, ''), vorlage: tpl, fortgesetzt: true }, display: `- vorhandene VM ${name} (VMID ${da.vmid}) fortgesetzt\n- ${a.meldung}` };
    }
    if (alle.some(v => v.name === name)) return { success: false, error: `Name ${name} ist in Proxmox vergeben` };
    const hindernisse = await this.fabrik.vorpruefung({ name, ip: ip.replace(/\/\d+$/, '') });
    if (hindernisse.length) return { success: false, error: hindernisse.join('; ') };
    const vmid = typeof input.new_vmid === 'number' ? input.new_vmid : parseInt(String(await this.get('/cluster/nextid')), 10);
    if (!(await this.vmidFrei(vmid))) return { success: false, error: `VMID ${vmid} ist vergeben` };
    const schritte: string[] = [];
    const clone: Record<string, unknown> = { newid: vmid, name, full: 1, target: node };
    // v1644 — Realfall 24.10. (5d960660): Proxmox klont nicht über Nodes in einen lokalen Speicher („can't clone to non-shared storage“).
    // Dann: auf den (gemeinsamen) Speicher der Vorlage an den Ziel-Node klonen und die Platte danach in den gewünschten Speicher verschieben.
    const wunsch = typeof input.storage === 'string' && input.storage ? input.storage : undefined;
    let verschiebenNach: string | undefined;
    if (wunsch) {
      const st = await this.get<{ type?: string; shared?: number }>(`/storage/${encodeURIComponent(wunsch)}`).catch(() => ({} as { type?: string; shared?: number }));
      const gemeinsam = !!st.shared || ['rbd', 'cephfs', 'nfs', 'cifs', 'glusterfs', 'iscsi', 'iscsidirect', 'pbs'].includes(String(st.type ?? ''));
      if (node !== vorlage.node && !gemeinsam) verschiebenNach = wunsch; else clone.storage = wunsch;
    }
    await this.aufgabeOderFehler(await this.post<string>(`/nodes/${vorlage.node}/qemu/${tpl}/clone`, clone), 900_000, 'Klonen');
    this.vmCache = null;
    schritte.push(`VM ${name} (VMID ${vmid}) aus Vorlage ${tpl} auf ${node} geklont`);
    if (verschiebenNach) {
      await this.aufgabeOderFehler(await this.post<string>(`/nodes/${node}/qemu/${vmid}/move_disk`, { disk: 'scsi0', storage: verschiebenNach, delete: 1 }), 1_800_000, 'Platte verschieben');
      const nachher = await this.get<{ scsi0?: string }>(`/nodes/${node}/qemu/${vmid}/config`);
      if (!String(nachher.scsi0 ?? '').startsWith(`${verschiebenNach}:`)) return { success: false, error: `Platte von ${name} liegt nach dem Verschieben nicht auf ${verschiebenNach} (${String(nachher.scsi0 ?? '-').slice(0, 80)})`, data: { vmid, name, node, ip } };
      schritte.push(`Platte nach ${verschiebenNach} auf ${node} verschoben (lokaler Speicher, über den gemeinsamen Speicher der Vorlage geklont)`);
    }
    // Host-Schlüssel + Snippet
    const hs = await this.fabrik.hostSchluessel();
    // v1627 — Distribution der Vorlage aus ihrer Beschreibung („… aus <speicher>:import/<distro>-<stand>.qcow2“): wheel/dnf bei RPM-Familie
    const tplCfg = await this.get<{ description?: string }>(`/nodes/${vorlage.node}/qemu/${tpl}/config`).catch(() => ({} as { description?: string }));
    const tplDistro = distroAusImage(/aus (\S+\.qcow2)/.exec(String(tplCfg.description ?? ''))?.[1] ?? '');
    // v1758 (Owner 02.11.) — eigenes Konto des Owners (Standard „madh“, leer = keins) mit seinem Schlüssel aus dem Tresor, wie bei Windows
    const ownerKontoName = typeof input.owner_konto === 'string' ? input.owner_konto.trim().toLowerCase() : 'madh';
    const ownerKey = ownerKontoName ? await this.fabrik.ownerSchluessel?.().catch(() => undefined) : undefined;
    const daten = cloudInitBenutzerDaten({ familie: tplDistro ? DISTROS[tplDistro].familie : 'deb', hostname: name, alfredSchluessel: await this.fabrik.alfredSchluessel(), weitereSchluessel: typeof input.ssh_public_key === 'string' && input.ssh_public_key.trim() ? [input.ssh_public_key.trim()] : [], hostPrivat: hs.privat, hostOeffentlich: hs.oeffentlich, ...(ownerKontoName && ownerKey ? { ownerKonto: { name: ownerKontoName, schluessel: ownerKey } } : {}) });
    if (ownerKontoName && ownerKey) schritte.push(`Konto ${ownerKontoName} mit deinem SSH-Schlüssel (sudo)`);
    const snippetSpeicher = 'local';
    const sp = await this.get<{ path?: string }>(`/storage/${snippetSpeicher}`);
    const pfad = `${sp.path ?? '/var/lib/vz'}/snippets/${snippetDatei(vmid)}`;
    await this.fabrik.snippetSchreiben(node, pfad, daten);
    try {
      const konfig: Record<string, unknown> = {
        cicustom: `user=${snippetSpeicher}:snippets/${snippetDatei(vmid)}`,
        ipconfig0: `ip=${ip},gw=${input.gateway as string}`,
        agent: 'enabled=1',
        description: `Angelegt von Alfred (I5) aus Vorlage ${tpl} am ${new Date().toISOString().slice(0, 10)}. Host-Schlüssel ${hs.oeffentlich.split(' ')[1]?.slice(0, 16)}…`,
      };
      if (typeof input.nameserver === 'string' && input.nameserver.trim()) konfig.nameserver = input.nameserver.trim();
      if (typeof input.memory === 'number') konfig.memory = input.memory;
      if (typeof input.cores === 'number') konfig.cores = input.cores;
      if (input.bridge || input.vlan_tag) konfig.net0 = `virtio,bridge=${(input.bridge as string) ?? 'vmbr0'}${input.vlan_tag ? `,tag=${input.vlan_tag as number}` : ''}`;
      await this.post(`/nodes/${node}/qemu/${vmid}/config`, konfig);
      if (typeof input.disk_size === 'number' && input.disk_size > 0) {
        await this.aufgabeOderFehler(await this.api<string>('PUT', `/nodes/${node}/qemu/${vmid}/resize`, { disk: 'scsi0', size: `${Math.floor(input.disk_size)}G` }), 120_000, 'Platte vergrößern');
      }
      await this.aufgabeOderFehler(await this.post<string>(`/nodes/${node}/qemu/${vmid}/status/start`, {}), 120_000, 'Starten');
      schritte.push(`gestartet mit ${ip}, Benutzer alfred, Host-Schlüssel von Alfred`);
      const a = await this.fabrik.anmelden({ name, ip: ip.replace(/\/\d+$/, ''), node, vmid, hostSchluessel: hs.oeffentlich, vorlage: tpl, zeitlimitMs: 600_000 });
      schritte.push(a.meldung);
      if (!a.ok) return { success: false, error: schritte.join('\n'), data: { vmid, name, node, ip } };
      // v1626 — Pflichtprüfung: ohne antwortenden Gast-Agent ist die Bereitstellung nicht fertig (Realfall docker-dev-01, 24.10.)
      const ga = await this.warteAufAgent(vmid, node, AGENT_WARTEN_MS);
      schritte.push(ga.meldung);
      if (!ga.ok) return { success: false, error: schritte.join('\n'), data: { vmid, name, node, ip } };
      // Cloud-Init ist in der VM abgeschaltet; Laufwerk und Snippet (mit dem privaten Host-Schlüssel) weg — das Laufwerk beim nächsten Kaltstart
      await this.cloudInitLoesen(node, vmid);
      schritte.push('Cloud-Init-Laufwerk zum Entfernen vorgemerkt');
    } finally {
      await this.fabrik.snippetEntfernen(node, pfad).catch(() => undefined);
      // Realfall 22.10. (docker-dev-01 startete nach Fehlschlag nicht mehr: „volume local:snippets/alfred-144-user.yaml does not exist“):
      // ohne Snippet darf kein Verweis darauf bleiben — Cloud-Init-Laufwerk mit entfernen (die VM hat ihre Daten vom ersten Start)
      await this.cloudInitLoesen(node, vmid);
    }
    schritte.push('Snippet am Knoten entfernt');
    return { success: true, data: { vmid, name, node, ip: ip.replace(/\/\d+$/, ''), vorlage: tpl, hostSchluessel: hs.oeffentlich }, display: schritte.map(s => `- ${s}`).join('\n') };
  }

  /** v1629 — Snippet-Verweis und Cloud-Init-Laufwerk entfernen, egal an welchem Anschluss es hängt (alte Vorlagen ide2, neue scsi1) */
  private async cloudInitLoesen(node: string, vmid: number): Promise<void> {
    const cfg = await this.get<Record<string, unknown>>(`/nodes/${node}/qemu/${vmid}/config`).catch(() => ({} as Record<string, unknown>));
    const laufwerke = Object.keys(cfg).filter(k => /^(ide|sata|scsi)\d+$/.test(k) && String(cfg[k]).includes('cloudinit'));
    const weg = [...(cfg.cicustom !== undefined ? ['cicustom'] : []), ...laufwerke];
    if (weg.length) await this.post(`/nodes/${node}/qemu/${vmid}/config`, { delete: weg.join(',') }).catch(() => undefined);
  }

  /** v1626 — bis der Gast-Agent antwortet (höchstens `ms`); die Meldung nennt bei Misserfolg die Ursache aus Realfall docker-dev-01 */
  /** Einrichtung einer neuen Windows-VM über den Gast-Agenten nachholen (festes Skript, siehe WIN_EINRICHTUNG_NACHHOLEN) */
  private async windowsEinrichtungNachholen(vmid: number, node: string): Promise<string> {
    const b64 = Buffer.from(WIN_EINRICHTUNG_NACHHOLEN, 'utf16le').toString('base64');
    const { pid } = await this.post<{ pid: number }>(`/nodes/${node}/qemu/${vmid}/agent/exec`, { command: ['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', b64] });
    // die Einrichtung selbst wiederholt bis zu 30× im Abstand von 20 s (Kontenverwaltung noch nicht bereit) — daher bis 12 min warten
    const ende = Date.now() + 720_000;
    while (Date.now() < ende) {
      await new Promise(res => setTimeout(res, 5_000));
      const st = await this.get<{ exited?: number | boolean; exitcode?: number; 'out-data'?: string; 'err-data'?: string }>(`/nodes/${node}/qemu/${vmid}/agent/exec-status?pid=${pid}`);
      if (st.exited) {
        const aus = String(st['out-data'] ?? '').split(/\r?\n/).filter(z => /^NACHHOLEN_/.test(z)).join(' ');
        return `Exit ${st.exitcode ?? '?'}: ${aus || String(st['err-data'] ?? '').trim().split(/\r?\n/)[0]?.slice(0, 160) || '(keine Ausgabe)'}`;
      }
    }
    return 'nach 12 min noch nicht fertig';
  }

  private async warteAufAgent(vmid: number, node: string, ms: number): Promise<{ ok: boolean; meldung: string }> {
    const ende = Date.now() + ms;
    let letzte = '';
    for (;;) {
      const r = await this.agentStatus(vmid, node).catch((e: Error) => ({ success: false, error: e.message } as SkillResult));
      if (r.success) return { ok: true, meldung: r.display ?? 'Gast-Agent antwortet' };
      letzte = r.error ?? '';
      if (Date.now() >= ende) break;
      await new Promise(res => setTimeout(res, AGENT_ABSTAND_MS));
    }
    return { ok: false, meldung: `Gast-Agent antwortet nach ${Math.round(ms / 1000)} s nicht (${letzte.slice(0, 160)}). Häufigste Ursache: qemu-guest-agent konnte beim ersten Start nicht installiert werden (kein Internet im Netz der VM) — VM und Fernzugang bestehen, Agent per Change nachinstallieren.` };
  }

  /** VM oder Vorlage entfernen — nur mit passendem Namen, nie geschützte; laufende nur mit force_stop. Danach Fernzugang/CMDB abmelden. */
  private async deleteVm(input: Record<string, unknown>): Promise<SkillResult> {
    const f = this.pruefeEingabe({ ...input, action: 'delete_vm' });
    if (f) return { success: false, error: f };
    const vmid = Number(input.vmid);
    const name = String(input.vm_name).trim();
    this.vmCache = null;
    const vm = (await this.getAllVms()).find(v => v.vmid === vmid);
    if (!vm) return { success: true, data: { vmid, schonWeg: true }, display: `VMID ${vmid} gibt es nicht (mehr)` };
    if (vm.name !== name) return { success: false, error: `VMID ${vmid} heißt „${vm.name}“, nicht „${name}“ — nichts gelöscht` };
    if (vm.type !== 'qemu') return { success: false, error: 'delete_vm gilt nur für QEMU-VMs' };
    const cfg = await this.get<{ protection?: number }>(`/nodes/${vm.node}/qemu/${vmid}/config`);
    if (cfg.protection) return { success: false, error: `${name} ist geschützt (protection) — nichts gelöscht` };
    const st = await this.get<{ status?: string }>(`/nodes/${vm.node}/qemu/${vmid}/status/current`);
    if (st.status === 'running') {
      if (input.force_stop !== true) return { success: false, error: `${name} läuft — erst herunterfahren (oder force_stop)` };
      await this.aufgabeOderFehler(await this.post<string>(`/nodes/${vm.node}/qemu/${vmid}/status/stop`, {}), 120_000, 'Stoppen');
    }
    let hinweis = '';
    try {
      await this.aufgabeOderFehler(await this.del<string>(`/nodes/${vm.node}/qemu/${vmid}?purge=1&destroy-unreferenced-disks=1`), 600_000, 'Löschen');
    } catch (err) {
      // v1736 — Realfall 7f04dc5f (01.11.): die Suche nach verwaisten Platten durchsucht jeden Speicher des Knotens; nvme001 ist für pve
      // eingetragen, die Volume Group fehlt dort („no such logical volume“, vgscan Exit 5). Die eigenen Platten waren da schon gelöscht,
      // die VM blieb ohne Platten stehen. Dann: Verweise auf nicht mehr vorhandene Platten aus der Konfiguration nehmen und ohne die Suche löschen.
      if (!/no such logical volume|vgscan|is not online|not available on node|unable to activate storage/i.test((err as Error).message)) throw err;
      const cfg = await this.get<Record<string, unknown>>(`/nodes/${vm.node}/qemu/${vmid}/config`);
      const weg: string[] = [];
      for (const [k, v] of Object.entries(cfg)) {
        if (!/^(scsi|sata|ide|virtio|efidisk|tpmstate|unused)\d+$/.test(k) || String(v).includes('media=cdrom')) continue;
        const volid = String(v).split(',')[0]!;
        const sp = volid.split(':')[0]!;
        const da = await this.get<Array<{ volid: string }>>(`/nodes/${vm.node}/storage/${sp}/content?vmid=${vmid}`).then(l => l.some(x => x.volid === volid)).catch(() => true);
        if (!da) weg.push(k);
      }
      if (weg.length) await this.post(`/nodes/${vm.node}/qemu/${vmid}/config`, { delete: weg.join(',') });
      await this.aufgabeOderFehler(await this.del<string>(`/nodes/${vm.node}/qemu/${vmid}?purge=1`), 600_000, 'Löschen (ohne Suche nach verwaisten Platten)');
      hinweis = ` — Suche nach verwaisten Platten übersprungen (${(err as Error).message.slice(0, 120)}); ${weg.length ? `bereits gelöschte Platten aus der Konfiguration entfernt: ${weg.join(', ')}` : 'alle Platten waren noch referenziert'}`;
    }
    this.vmCache = null;
    // v1689 — eine wiederhergestellte Kopie trägt bis zur Umbenennung den Namen des Originals: Fernzugang und Server-Eintrag
    // gehören dann dem weiterlaufenden Original und bleiben (Rückweg eines Restoretests hätte sonst das Original abgemeldet)
    const nurVmid = (await this.getAllVms().catch(() => [])).some(v => v.vmid !== vmid && v.name === name);
    const ab = this.fabrik ? await this.fabrik.abmelden({ name, node: vm.node, vmid, ...(nurVmid ? { nurVmid } : {}) }).catch((e: Error) => `Abmelden fehlgeschlagen: ${e.message}`) : '';
    return { success: true, data: { vmid, name, node: vm.node, entfernt: true }, display: `VM ${name} (VMID ${vmid}) auf ${vm.node} entfernt${hinweis}${ab ? `. ${ab}` : ''}` };
  }

  private async listNetworksAction(input: Record<string, unknown>): Promise<SkillResult> {
    const node = (input.node as string) ?? this.config.defaultNode ?? "pve1";
    const nets = await this.get<Array<Record<string, unknown>>>(`/nodes/${node}/network`);

    const lines = nets
      .filter((n: any) => n.type === 'bridge' || n.type === 'bond' || n.type === 'vlan')
      .map((n: any) => `| ${n.iface ?? '?'} | ${n.type} | ${n.address ?? 'dhcp'} | ${n.bridge_ports ?? '-'} | ${n.comments ?? ''} |`);

    const display = `## Proxmox Netzwerk (${node})\n\n| Interface | Typ | IP | Ports | Kommentar |\n|-----------|-----|-------|-------|------|\n${lines.join('\n')}`;
    return { success: true, data: nets, display };
  }

  private async waitReady(input: Record<string, unknown>): Promise<SkillResult> {
    const vmid = input.vmid as number;
    if (!vmid) return { success: false, error: 'vmid erforderlich' };
    const node = (input.node as string) ?? this.config.defaultNode ?? "pve1";

    // Poll VM status for up to 120 seconds
    const maxWait = 120_000;
    const start = Date.now();
    let status = 'unknown';

    while (Date.now() - start < maxWait) {
      try {
        const resolved = await this.resolveVm(vmid, node);
        const vmStatus = await this.get<Record<string, unknown>>(`/nodes/${resolved.node}/${resolved.type}/${vmid}/status/current`);
        status = vmStatus.status as string ?? 'unknown';
        if (status === 'running') {
          const waited = Math.round((Date.now() - start) / 1000);
          return {
            success: true,
            data: { vmid, status, waitedSeconds: waited },
            display: `✅ VM ${vmid} ist running (nach ${waited}s)`,
          };
        }
      } catch { /* VM might not exist yet (clone in progress) */ }
      await new Promise(r => setTimeout(r, 5_000));
    }

    return { success: false, error: `VM ${vmid} nach ${maxWait / 1000}s nicht ready (Status: ${status})` };
  }
}
