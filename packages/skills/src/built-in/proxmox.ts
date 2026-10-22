import type { SkillMetadata, SkillContext, SkillResult, ProxmoxConfig } from '@alfred/types';
import { readFileSync } from 'node:fs';
import { Skill } from '../skill.js';
import { tlsFetch } from './social/tls-fetch.js'; // v1385 — Zertifikatsprüfung request-lokal statt prozessweit
import { DISTROS, istDistro, neuesterStand, imageAngabe, pruefeDownload, vorlagenKonfig, cloudInitBenutzerDaten, snippetDatei, IMPORT_VOLUME, VM_NAME, type Distro, type ImageAngabe } from './proxmox-fabrik.js';

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
  anmelden(v: { name: string; ip: string; node: string; vmid: number; hostSchluessel: string; vorlage: number; zeitlimitMs: number }): Promise<{ ok: boolean; meldung: string }>;
  /** Fernzugang entfernen, CMDB-Eintrag stilllegen */
  abmelden(v: { name: string; node: string; vmid: number }): Promise<string>;
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
const VM_LESE_AKTIONEN = new Set(['vm_status', 'list_snapshots', 'wait_ready', 'backups_vm']);
/** I5 — Vorlagen-Fabrik */
const FABRIK_AKTIONEN = ['list_cloud_images', 'download_image', 'delete_image', 'create_template', 'provision_vm', 'delete_vm'] as const;
/** Spec I5: Anlegen und Entfernen laufen nur als Schritte freigegebener Changes (Freigabe, Rückweg, Protokoll) — nie direkt aus dem Chat */
const NUR_IM_CHANGE = new Set<string>(['download_image', 'delete_image', 'create_template', 'provision_vm', 'delete_vm']);
const VM_ZIEL_AKTIONEN = new Set(['backups_vm', 'vm_status', 'list_snapshots', 'start_vm', 'shutdown_vm', 'reboot_vm', 'suspend_vm', 'resume_vm', 'stop_vm', 'create_snapshot', 'backup_vm', 'migrate_vm', 'delete_snapshot', 'rollback_snapshot', 'wait_ready']);

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
      'Vorlagen-Fabrik (I5, nur als Schritte freigegebener Changes): "list_cloud_images" (distro → datierter Stand, url, checksum, filename) → "download_image" (node, storage mit Inhalt import, url, checksum, checksum_algorithm, filename) → "create_template" (node, storage, image=Volume, new_vmid, hostname=Name) → "provision_vm" (template, hostname, node, storage, ip CIDR, gateway; Benutzer alfred, Host-Schlüssel von Alfred, Fernzugang + CMDB automatisch). Rückwege: delete_image (volid), delete_vm (vmid + vm_name zur Bestätigung, force_stop).',
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
        distro: { type: 'string', enum: Object.keys(DISTROS), description: 'list_cloud_images: ubuntu-24.04, ubuntu-26.04, debian-12, debian-13 (leer = alle)' },
        url: { type: 'string', description: 'download_image: Image-URL des Herausgebers mit datiertem Stand (aus list_cloud_images)' },
        checksum: { type: 'string', description: 'download_image: Prüfsumme des Herausgebers (aus list_cloud_images)' },
        checksum_algorithm: { type: 'string', enum: ['sha256', 'sha512'], description: 'download_image: sha256 (Ubuntu) oder sha512 (Debian)' },
        filename: { type: 'string', description: 'download_image: Dateiname im import-Speicher (…qcow2, aus list_cloud_images)' },
        image: { type: 'string', description: 'create_template: Volume des Images, z. B. backupshare:import/ubuntu-24.04-20261017.qcow2' },
        volid: { type: 'string', description: 'delete_image: Volume im import-Speicher' },
        nameserver: { type: 'string', description: 'provision_vm: DNS-Server (IP, mehrere mit Leerzeichen)' },
        vm_name: { type: 'string', description: 'delete_vm: Name der VM zur Bestätigung (muss zur vmid passen)' },
        force_stop: { type: 'boolean', description: 'delete_vm: laufende VM vorher hart stoppen (nur für Rückwege frisch angelegter VMs)' },
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
      if (!Number.isInteger(vmid) || vmid < 100) return 'delete_vm braucht die vmid (Zahl)';
      if (typeof input.vm_name !== 'string' || !input.vm_name.trim()) return 'delete_vm braucht vm_name zur Bestätigung';
      return undefined;
    }
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

        // ── I5 VORLAGEN-FABRIK ────────────────────────────────
        case 'list_cloud_images':
          return await this.listCloudImages(input);
        case 'download_image':
          return await this.downloadImage(input);
        case 'delete_image':
          return await this.deleteImage(input);
        case 'create_template':
          return await this.createTemplate(input);
        case 'provision_vm':
          return await this.provisionVm(input);
        case 'delete_vm':
          return await this.deleteVm(input);

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
  ): Promise<{ node: string; type: 'qemu' | 'lxc' }> {
    if (explicitNode) {
      // We still need the type — try qemu first, then lxc
      try {
        await this.get(`/nodes/${explicitNode}/qemu/${vmid}/status/current`);
        return { node: explicitNode, type: 'qemu' };
      } catch {
        try {
          await this.get(`/nodes/${explicitNode}/lxc/${vmid}/status/current`);
          return { node: explicitNode, type: 'lxc' };
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
    return { node: match.node, type: match.type };
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

  private async aufgabeOderFehler(upid: unknown, ms: number, was: string): Promise<void> {
    if (typeof upid !== 'string' || !upid.startsWith('UPID:')) return;
    const w = await this.warteAufgabe(upid, ms);
    if (!w.ok) throw new Error(`${was}: ${w.fertig ? w.status : `nach ${Math.round(ms / 1000)} s nicht fertig`} (${upid})`);
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
        const stand = neuesterStand(await this.holeText(q.basis), q.herausgeber);
        if (!stand) { fehler.push(`${d}: kein datierter Stand gefunden`); continue; }
        const a = imageAngabe(d, stand, await this.holeText(`${q.basis}${stand}/${q.summen}`));
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

  private async deleteImage(input: Record<string, unknown>): Promise<SkillResult> {
    const volid = input.volid as string;
    if (!IMPORT_VOLUME.test(volid ?? '')) return { success: false, error: 'delete_image: volid eines import-Volumes' };
    const node = (input.node as string) ?? this.config.defaultNode;
    const storage = volid.split(':')[0]!;
    const upid = await this.del<string>(`/nodes/${node}/storage/${storage}/content/${encodeURIComponent(volid)}`);
    await this.aufgabeOderFehler(upid, 120_000, 'Image entfernen');
    return { success: true, data: { volid, entfernt: true }, display: `Image ${volid} entfernt` };
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
    if (alle.some(v => v.name === name)) return { success: false, error: `Name ${name} ist in Proxmox vergeben` };
    const hindernisse = await this.fabrik.vorpruefung({ name, ip: ip.replace(/\/\d+$/, '') });
    if (hindernisse.length) return { success: false, error: hindernisse.join('; ') };
    const vmid = typeof input.new_vmid === 'number' ? input.new_vmid : parseInt(String(await this.get('/cluster/nextid')), 10);
    if (!(await this.vmidFrei(vmid))) return { success: false, error: `VMID ${vmid} ist vergeben` };
    const schritte: string[] = [];
    const clone: Record<string, unknown> = { newid: vmid, name, full: 1, target: node };
    if (typeof input.storage === 'string' && input.storage) clone.storage = input.storage;
    await this.aufgabeOderFehler(await this.post<string>(`/nodes/${vorlage.node}/qemu/${tpl}/clone`, clone), 900_000, 'Klonen');
    this.vmCache = null;
    schritte.push(`VM ${name} (VMID ${vmid}) aus Vorlage ${tpl} auf ${node} geklont`);
    // Host-Schlüssel + Snippet
    const hs = await this.fabrik.hostSchluessel();
    const daten = cloudInitBenutzerDaten({ hostname: name, alfredSchluessel: await this.fabrik.alfredSchluessel(), weitereSchluessel: typeof input.ssh_public_key === 'string' && input.ssh_public_key.trim() ? [input.ssh_public_key.trim()] : [], hostPrivat: hs.privat, hostOeffentlich: hs.oeffentlich });
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
      // Cloud-Init ist in der VM abgeschaltet; Laufwerk und Snippet (mit dem privaten Host-Schlüssel) weg — das Laufwerk beim nächsten Kaltstart
      await this.post(`/nodes/${node}/qemu/${vmid}/config`, { delete: 'cicustom,ide2' }).catch(() => undefined);
      schritte.push('Cloud-Init-Laufwerk zum Entfernen vorgemerkt');
    } finally {
      await this.fabrik.snippetEntfernen(node, pfad).catch(() => undefined);
    }
    schritte.push('Snippet am Knoten entfernt');
    return { success: true, data: { vmid, name, node, ip: ip.replace(/\/\d+$/, ''), vorlage: tpl, hostSchluessel: hs.oeffentlich }, display: schritte.map(s => `- ${s}`).join('\n') };
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
    await this.aufgabeOderFehler(await this.del<string>(`/nodes/${vm.node}/qemu/${vmid}?purge=1&destroy-unreferenced-disks=1`), 600_000, 'Löschen');
    this.vmCache = null;
    const ab = this.fabrik ? await this.fabrik.abmelden({ name, node: vm.node, vmid }).catch((e: Error) => `Abmelden fehlgeschlagen: ${e.message}`) : '';
    return { success: true, data: { vmid, name, node: vm.node, entfernt: true }, display: `VM ${name} (VMID ${vmid}) auf ${vm.node} entfernt${ab ? `. ${ab}` : ''}` };
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
