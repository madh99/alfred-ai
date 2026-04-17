/**
 * Commvault Media Agents Module — 4 actions for media agent management
 *
 * API response field mapping (OpenAPI3 spec):
 *   GET  /V4/mediaAgent              → { mediaAgents: MediaAgentSummary[] }
 *   GET  /V4/mediaAgent/{id}         → { general, indexCache, control, security }
 *   PUT  /V4/mediaAgent/{id}         → GenericResp (update config)
 *   POST /V4/mediaAgent              → { jobId } (install MA package)
 *   GET  /V4/DDB/MediaAgents         → { mediaAgents: MediaAgentForDDBSummary[] }
 *
 * MediaAgentSummary: { id, name, displayName, netHostName, status (ONLINE|OFFLINE|MAINTENANCE),
 *   isUnlicensedMA, offlineReason, offlineReasonValue, operatingSystem: { id, name, type },
 *   version, releaseId, description, company: { id, name } }
 *
 * MediaAgentForDDBSummary: { id, name, displayName, releaseId, SIMOSId,
 *   isDDBSubclientConfigured, OSType, isConfigured, DDBDisks[], region }
 */

import type { CommvaultApiClient, SkillResult } from './types.js';
import { requireId, optionalString } from './types.js';

// ── Helper: status indicator ─────────────────────────────────
function statusIcon(status: string | undefined): string {
  const s = (status ?? '').toUpperCase();
  if (s === 'ONLINE') return '[OK]';
  if (s === 'OFFLINE') return '[!!]';
  if (s === 'MAINTENANCE') return '[||]';
  return '[--]';
}

export class CommvaultMediaAgents {
  constructor(private readonly api: CommvaultApiClient) {}

  // ── 1. list — Alle Media Agents auflisten ──────────────────

  async list(): Promise<SkillResult> {
    const data = await this.api.get<any>('/V4/mediaAgent');
    const agents: any[] = data.mediaAgents ?? [];

    const lines = [
      '## Commvault Media Agents',
      `${agents.length} Media Agent(s)`,
      '',
    ];

    for (const ma of agents) {
      const icon = statusIcon(ma.status);
      const name = ma.displayName ?? ma.name ?? '?';
      const os = ma.operatingSystem?.name ?? '-';
      const ver = ma.version ?? '-';
      const licensed = ma.isUnlicensedMA ? ' (unlizenziert)' : '';
      const offline = ma.offlineReason ? ` — ${ma.offlineReason}` : '';

      lines.push(
        `${icon} **${name}** (ID: ${ma.id ?? '?'}) | ${ma.status ?? '?'}${offline} | OS: ${os} | Version: ${ver}${licensed}`,
      );
    }

    return {
      success: true,
      data: { total: agents.length, mediaAgents: agents },
      display: lines.join('\n'),
    };
  }

  // ── 2. detail — Media Agent Details ─────────────────────────

  async detail(input: Record<string, unknown>): Promise<SkillResult> {
    const maId = requireId(input, 'media_agent_id');

    const data = await this.api.get<any>(`/V4/mediaAgent/${maId}`);
    const general = data.general ?? {};
    const indexCache = data.indexCache ?? {};
    const control = data.control ?? {};

    const lines = [
      `## Media Agent ${general.displayName ?? general.name ?? maId} — Detail`,
      '',
      `**Status:** ${statusIcon(general.status)} ${general.status ?? '?'}`,
    ];

    if (general.offlineReason) lines.push(`**Offline-Grund:** ${general.offlineReason}`);
    if (general.operatingSystem) lines.push(`**Betriebssystem:** ${general.operatingSystem}`);
    if (general.version) lines.push(`**Version:** ${general.version}`);
    if (general.description) lines.push(`**Beschreibung:** ${general.description}`);

    // Control settings
    lines.push('', '### Steuerung');
    lines.push(`**Aktiviert:** ${control.enabled !== undefined ? (control.enabled ? 'Ja' : 'Nein') : '?'}`);
    if (control.maintenanceMode !== undefined) {
      lines.push(`**Wartungsmodus:** ${control.maintenanceMode ? 'Ja' : 'Nein'}`);
    }
    if (control.ransomwareProtection !== undefined) {
      lines.push(`**Ransomware-Schutz:** ${control.ransomwareProtection ? 'Aktiviert' : 'Deaktiviert'}`);
    }
    if (control.parallelDataTransferOperations !== undefined) {
      lines.push(`**Parallele Datentransfer-Ops:** ${control.parallelDataTransferOperations}`);
    }
    if (control.optimizeForConcurrentLANBackups !== undefined) {
      lines.push(`**LAN-Backup-Optimierung:** ${control.optimizeForConcurrentLANBackups ? 'Ja' : 'Nein'}`);
    }

    // Index cache
    if (indexCache.path) {
      lines.push('', '### Index-Cache');
      lines.push(`**Pfad:** ${indexCache.path}`);
      if (indexCache.logsCache) {
        lines.push(`**Logs-Cache:** ${indexCache.logsCache.enabled ? 'Aktiviert' : 'Deaktiviert'}${indexCache.logsCache.path ? ` (${indexCache.logsCache.path})` : ''}`);
      }
    }

    return {
      success: true,
      data,
      display: lines.join('\n'),
    };
  }

  // ── 3. ddb — Media Agents fuer Dedup-Datenbanken ───────────

  async ddb(): Promise<SkillResult> {
    const data = await this.api.get<any>('/V4/DDB/MediaAgents');
    const agents: any[] = data.mediaAgents ?? [];

    const lines = [
      '## Media Agents fuer DDB',
      `${agents.length} Media Agent(s)`,
      '',
    ];

    for (const ma of agents) {
      const name = ma.displayName ?? ma.name ?? '?';
      const osType = ma.OSType ?? '-';
      const configured = ma.isConfigured ? 'konfiguriert' : 'nicht konfiguriert';
      const ddbConfigured = ma.isDDBSubclientConfigured ? 'DDB-Subclient vorhanden' : 'kein DDB-Subclient';
      const disks = ma.DDBDisks?.length ?? 0;
      const region = ma.region?.displayName ?? ma.region?.name ?? '';

      lines.push(
        `**${name}** (ID: ${ma.id ?? '?'}) | ${osType} | ${configured} | ${ddbConfigured}${disks > 0 ? ` | ${disks} DDB-Disk(s)` : ''}${region ? ` | Region: ${region}` : ''}`,
      );
    }

    return {
      success: true,
      data: { total: agents.length, mediaAgents: agents },
      display: lines.join('\n'),
    };
  }

  // ── 4. install — Media Agent installieren (HIGH_RISK) ──────

  async install(input: Record<string, unknown>): Promise<SkillResult> {
    const hostNamesRaw = input.hostNames ?? input.host_names ?? input.hosts;
    if (!hostNamesRaw) throw new Error('Parameter "hostNames" ist erforderlich (Array von Hostnamen)');

    const hostNames: string[] = Array.isArray(hostNamesRaw)
      ? hostNamesRaw.map(String)
      : [String(hostNamesRaw)];

    const username = optionalString(input, 'username');
    if (!username) throw new Error('Parameter "username" ist erforderlich');

    const password = optionalString(input, 'password');
    const osType = optionalString(input, 'os_type') ?? optionalString(input, 'OSType') ?? 'WINDOWS';
    const installLocation = optionalString(input, 'install_location') ?? optionalString(input, 'installLocation');
    const rebootIfRequired = input.reboot_if_required === true || input.rebootIfRequired === true;
    const sshKeyPath = optionalString(input, 'ssh_key_path') ?? optionalString(input, 'SSHKeyPath');
    const sshKeyPassphrase = optionalString(input, 'ssh_key_passphrase') ?? optionalString(input, 'SSHKeyFilePassphrase');

    const body: Record<string, unknown> = {
      hostNames,
      username,
      OSType: osType.toUpperCase(),
      rebootIfRequired,
    };

    if (password) body.password = password;
    if (installLocation) body.installLocation = installLocation;
    if (sshKeyPath) body.SSHKeyPath = sshKeyPath;
    if (sshKeyPassphrase) body.SSHKeyFilePassphrase = sshKeyPassphrase;

    const result = await this.api.post<any>('/V4/mediaAgent', body);

    return {
      success: true,
      data: result,
      display: `Media Agent Installation gestartet auf ${hostNames.join(', ')}.\nJob-ID: ${result.jobId ?? '?'}`,
    };
  }
}
