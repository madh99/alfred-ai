import type { SkillMetadata, SkillContext, SkillResult, ProxmoxConfig } from '@alfred/types';
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
  | 'rollback_snapshot';

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
      'Use action "list_vms" to see VMs, "start_vm"/"shutdown_vm" to control them, ' +
      '"cluster_status" for health, "create_snapshot" for backups.',
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
      },
      required: ['action'],
    },
  };

  private readonly config: ProxmoxConfig;
  private vmCache: { entries: VmEntry[]; ts: number } | null = null;
  private static readonly VM_CACHE_TTL = 30_000; // 30 seconds

  constructor(config: ProxmoxConfig) {
    super();
    this.config = config;
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
}
