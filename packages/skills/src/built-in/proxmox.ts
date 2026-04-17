import type { SkillMetadata, SkillContext, SkillResult, ProxmoxConfig } from '@alfred/types';
import { readFileSync } from 'node:fs';
import { Skill } from '../skill.js';

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

type Action =
  // read
  | 'cluster_status'
  | 'list_nodes'
  | 'node_stats'
  | 'list_vms'
  | 'vm_status'
  | 'list_snapshots'
  | 'list_storage'
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
  | 'api_raw';

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
      '"list_vms" zeigt VMs, "start_vm"/"shutdown_vm" steuert sie, "cluster_status" für Health, "create_snapshot" für Backups.',
    riskLevel: 'write',
    version: '1.0.0',
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
          ],
          description: 'The Proxmox action to perform',
        },
        vmid: {
          type: 'number',
          description: 'Virtual machine / container ID',
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
      },
      required: ['action'],
    },
  };

  private readonly config: ProxmoxConfig;
  private vmCache: { entries: VmEntry[]; ts: number } | null = null;
  private static readonly VM_CACHE_TTL = 30_000; // 30 seconds
  private sshKeyPath?: string;
  private sshUser?: string;
  private postProvisionFn?: (host: string, user: string, runtime: string, isRhel: boolean) => Promise<string[]>;

  constructor(config: ProxmoxConfig) {
    super();
    this.config = config;
  }

  /** Set SSH key path for Cloud-Init auto-injection on clone_vm/create_lxc. */
  setSshKeyPath(path: string): void { this.sshKeyPath = path; }

  /** Set default SSH user for post-provision. */
  setSshUser(user: string): void { this.sshUser = user; }

  /** Set callback for post-provision runtime installation (SSH wait + install). */
  setPostProvisionCallback(fn: (host: string, user: string, runtime: string, isRhel: boolean) => Promise<string[]>): void {
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

    try {
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
    if (skipTls) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

    let res: Response;
    try {
      res = await fetch(url, fetchOpts);
    } finally {
      if (skipTls) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    }

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
          const installSteps = await this.postProvisionFn(host, ciUser, runtime, isRhel);
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
