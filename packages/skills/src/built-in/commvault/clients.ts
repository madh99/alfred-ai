/**
 * Commvault Clients Module — 8 actions for client/server management
 *
 * API response field mapping:
 *   GET /Client                         → { clientProperties: [{ client: { clientEntity: { clientName, clientId }, osInfo: { OsDisplayInfo: { OSName } } } }] }
 *   GET /Client/{clientId}              → client detail (clientProperties[0])
 *   GET /Subclient?clientId={id}        → { subClientProperties: [...] }
 *   GET /V4/Servers                     → { servers: [...] }
 *   GET /V4/FileServers                 → { fileServers: [...] }
 *   GET /V4/ServerGroup                 → { serverGroups: [...] }
 *   POST /V4/Servers/Retire             → { errorCode?, errorMessage? }
 *   GET /V4/VirtualMachines             → { virtualMachines: [...] }
 */

import type { CommvaultApiClient, SkillResult } from './types.js';
import { requireId } from './types.js';

// ── Helper: status icon ───────────────────────────────────────
function statusIcon(status: string): string {
  const s = (status ?? '').toLowerCase();
  if (s.includes('ready') || s.includes('online') || s.includes('protected')) return '[OK]';
  if (s.includes('deconfigured') || s.includes('retired') || s.includes('deleted')) return '[X]';
  if (s.includes('offline') || s.includes('unreachable')) return '[!!]';
  if (s.includes('pending') || s.includes('not ready')) return '[..]';
  if (s.includes('warning') || s.includes('partial')) return '[!]';
  return '[--]';
}

export class CommvaultClients {
  constructor(private readonly api: CommvaultApiClient) {}

  // ── 1. list — Alle Clients auflisten ────────────────────────

  async list(): Promise<SkillResult> {
    const data = await this.api.get<any>('/Client');
    const clients: any[] = data.clientProperties ?? [];

    const lines = ['## Commvault Clients', `${clients.length} Clients`, ''];

    for (const cp of clients.slice(0, 80)) {
      const entity = cp.client?.clientEntity ?? {};
      const name = entity.clientName ?? '?';
      const id = entity.clientId ?? '?';
      const os = cp.client?.osInfo?.OsDisplayInfo?.OSName ?? '-';
      const status = cp.clientProps?.activityControl?.enableBackup !== false ? 'aktiv' : 'deaktiviert';
      lines.push(`${statusIcon(status)} **${name}** (ID: ${id}) — ${os} | ${status}`);
    }

    if (clients.length > 80) lines.push(`\n... und ${clients.length - 80} weitere Clients`);

    return {
      success: true,
      data: { total: clients.length, clients: clients.slice(0, 80).map((cp: any) => cp.client?.clientEntity ?? {}) },
      display: lines.join('\n'),
    };
  }

  // ── 2. detail — Client Detail mit Subclients und Jobs ───────

  async detail(input: Record<string, unknown>): Promise<SkillResult> {
    const clientId = requireId(input, 'client_id');

    const [clientRes, subclientRes, jobsRes] = await Promise.allSettled([
      this.api.get<any>(`/Client/${clientId}`),
      this.api.get<any>(`/Subclient?clientId=${clientId}`),
      this.api.get<any>(`/Job?clientId=${clientId}&completedJobLookupTime=86400&jobFilter=Backup`),
    ]);

    const clientData = clientRes.status === 'fulfilled' ? clientRes.value : null;
    const subclientData = subclientRes.status === 'fulfilled' ? subclientRes.value : null;
    const jobsData = jobsRes.status === 'fulfilled' ? jobsRes.value : null;

    const cp = clientData?.clientProperties?.[0] ?? clientData ?? {};
    const entity = cp.client?.clientEntity ?? {};
    const os = cp.client?.osInfo?.OsDisplayInfo?.OSName ?? '-';
    const subclients: any[] = subclientData?.subClientProperties ?? [];
    const jobs: any[] = (jobsData?.jobs ?? []).map((j: any) => j.jobSummary ?? j);

    const lines = [`## Client: ${entity.clientName ?? clientId}`, ''];
    lines.push(`**ID:** ${entity.clientId ?? clientId}`);
    lines.push(`**Betriebssystem:** ${os}`);

    if (cp.client?.osInfo?.OsDisplayInfo?.ProcessorType) {
      lines.push(`**Prozessor:** ${cp.client.osInfo.OsDisplayInfo.ProcessorType}`);
    }

    // Subclients
    lines.push('', `### Subclients (${subclients.length})`);
    for (const sc of subclients.slice(0, 20)) {
      const scEntity = sc.subClientEntity ?? {};
      const scName = scEntity.subclientName ?? '?';
      const scId = scEntity.subclientId ?? '?';
      const appName = scEntity.appName ?? '';
      lines.push(`- **${scName}** (ID: ${scId})${appName ? ` — ${appName}` : ''}`);
    }
    if (subclients.length > 20) lines.push(`  ... und ${subclients.length - 20} weitere`);

    // Recent jobs
    lines.push('', `### Letzte Jobs (${Math.min(jobs.length, 10)} von ${jobs.length})`);
    for (const j of jobs.slice(0, 10)) {
      const status = j.status ?? '?';
      const jobId = j.jobId ?? '?';
      const start = j.jobStartTime ? new Date(j.jobStartTime * 1000).toLocaleString('de-AT') : '-';
      lines.push(`${statusIcon(status)} Job **${jobId}** — ${status} | ${start}`);
    }

    return {
      success: true,
      data: { client: entity, os, subclients: subclients.length, recentJobs: jobs.length },
      display: lines.join('\n'),
    };
  }

  // ── 3. servers — Alle Server (V4 API) ──────────────────────

  async servers(): Promise<SkillResult> {
    const data = await this.api.get<any>('/V4/Servers');
    const servers: any[] = data.servers ?? [];

    const lines = ['## Commvault Server', `${servers.length} Server`, ''];

    for (const s of servers.slice(0, 80)) {
      const name = s.hostName ?? s.name ?? s.displayName ?? '?';
      const id = s.id ?? '?';
      const status = s.status ?? s.state ?? '-';
      const os = s.osType ?? s.operatingSystem ?? '-';
      lines.push(`${statusIcon(status)} **${name}** (ID: ${id}) — ${os} | ${status}`);
    }

    if (servers.length > 80) lines.push(`\n... und ${servers.length - 80} weitere Server`);

    return {
      success: true,
      data: { total: servers.length, servers: servers.slice(0, 80) },
      display: lines.join('\n'),
    };
  }

  // ── 4. fileServers — File Server (V4 API) ──────────────────

  async fileServers(): Promise<SkillResult> {
    const data = await this.api.get<any>('/V4/FileServers');
    const servers: any[] = data.fileServers ?? [];

    const lines = ['## Commvault File Server', `${servers.length} File Server`, ''];

    for (const s of servers.slice(0, 80)) {
      const name = s.hostName ?? s.name ?? s.displayName ?? '?';
      const id = s.id ?? '?';
      const status = s.status ?? s.state ?? '-';
      const os = s.osType ?? s.operatingSystem ?? '-';
      lines.push(`${statusIcon(status)} **${name}** (ID: ${id}) — ${os} | ${status}`);
    }

    if (servers.length > 80) lines.push(`\n... und ${servers.length - 80} weitere`);

    return {
      success: true,
      data: { total: servers.length, fileServers: servers.slice(0, 80) },
      display: lines.join('\n'),
    };
  }

  // ── 5. serverGroups — Server-Gruppen (V4 API) ──────────────

  async serverGroups(): Promise<SkillResult> {
    const data = await this.api.get<any>('/V4/ServerGroup');
    const groups: any[] = data.serverGroups ?? [];

    const lines = ['## Commvault Server-Gruppen', `${groups.length} Gruppen`, ''];

    for (const g of groups) {
      const name = g.name ?? g.serverGroupName ?? '?';
      const id = g.id ?? g.serverGroupId ?? '?';
      const desc = g.description ?? '';
      const memberCount = g.associatedClients?.length ?? g.memberServers?.length ?? 0;
      lines.push(`- **${name}** (ID: ${id}) — ${memberCount} Mitglieder${desc ? ` | ${desc}` : ''}`);
    }

    return {
      success: true,
      data: { total: groups.length, groups },
      display: lines.join('\n'),
    };
  }

  // ── 6. subclients — Subclients eines Clients ───────────────

  async subclients(input: Record<string, unknown>): Promise<SkillResult> {
    const clientId = requireId(input, 'client_id');

    const data = await this.api.get<any>(`/Subclient?clientId=${clientId}`);
    const subclients: any[] = data.subClientProperties ?? [];

    const lines = [`## Subclients fuer Client ${clientId}`, `${subclients.length} Subclients`, ''];

    for (const sc of subclients) {
      const entity = sc.subClientEntity ?? {};
      const name = entity.subclientName ?? '?';
      const id = entity.subclientId ?? '?';
      const appName = entity.appName ?? '-';
      const backupSet = entity.backupsetName ?? '';
      const status = sc.commonProperties?.activityControl?.enableBackup !== false ? 'aktiv' : 'deaktiviert';
      lines.push(
        `${statusIcon(status)} **${name}** (ID: ${id}) — ${appName}${backupSet ? ` / ${backupSet}` : ''} | ${status}`,
      );
    }

    return {
      success: true,
      data: { clientId, total: subclients.length, subclients: subclients.map((sc: any) => sc.subClientEntity ?? {}) },
      display: lines.join('\n'),
    };
  }

  // ── 7. retire — Server stilllegen (HIGH_RISK) ──────────────

  async retire(input: Record<string, unknown>): Promise<SkillResult> {
    const serverId = requireId(input, 'server_id');

    const result = await this.api.post<any>('/V4/Servers/Retire', {
      serverIds: [serverId],
    });

    if (result.errorCode && result.errorCode !== 0) {
      return {
        success: false,
        data: result,
        error: `Server ${serverId} konnte nicht stillgelegt werden: ${result.errorMessage ?? `Fehlercode ${result.errorCode}`}`,
      };
    }

    return {
      success: true,
      data: result,
      display: `Server ${serverId} wurde zur Stilllegung markiert (Retire).`,
    };
  }

  // ── 8. virtualMachines — VM Backup-Status ──────────────────

  async virtualMachines(): Promise<SkillResult> {
    const data = await this.api.get<any>('/V4/VirtualMachines');
    const vms: any[] = data.virtualMachines ?? [];

    const protectedCount = vms.filter((v: any) => {
      const s = (v.vmStatus ?? v.protectionStatus ?? '').toLowerCase();
      return s.includes('protected') || s.includes('backed');
    }).length;
    const unprotectedCount = vms.length - protectedCount;

    const lines = [
      '## Commvault Virtual Machines',
      `${vms.length} VMs | Geschuetzt: ${protectedCount} | Ungeschuetzt: ${unprotectedCount}`,
      '',
    ];

    for (const vm of vms.slice(0, 80)) {
      const name = vm.name ?? vm.vmName ?? vm.displayName ?? '?';
      const id = vm.id ?? vm.vmId ?? '?';
      const status = vm.vmStatus ?? vm.protectionStatus ?? '-';
      const hypervisor = vm.hypervisor?.name ?? vm.vsaClient ?? '';
      lines.push(
        `${statusIcon(status)} **${name}** (ID: ${id}) — ${status}${hypervisor ? ` | ${hypervisor}` : ''}`,
      );
    }

    if (vms.length > 80) lines.push(`\n... und ${vms.length - 80} weitere VMs`);

    return {
      success: true,
      data: { total: vms.length, protected: protectedCount, unprotected: unprotectedCount, vms: vms.slice(0, 80) },
      display: lines.join('\n'),
    };
  }
}
