import type { SkillMetadata, SkillContext, SkillResult, ProxmoxConfig, UniFiConfig, HomeAssistantConfig, ProxmoxBackupConfig } from '@alfred/types';
import { Skill } from '../skill.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface MonitorCheckConfig {
  proxmox?: ProxmoxConfig;
  unifi?: UniFiConfig;
  homeassistant?: HomeAssistantConfig;
  proxmoxBackup?: ProxmoxBackupConfig;
}

type CheckName = 'proxmox' | 'unifi' | 'homeassistant' | 'proxmox_backup';

interface Alert {
  source: CheckName;
  message: string;
}

// ---------------------------------------------------------------------------
// MonitorSkill
// ---------------------------------------------------------------------------

export class MonitorSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'monitor',
    category: 'infrastructure',
    description:
      'Deterministic infrastructure health checks without LLM. ' +
      'Checks Proxmox cluster, UniFi network, and Home Assistant for issues. ' +
      'Returns alerts only when problems are detected — empty display means all OK.',
    riskLevel: 'read',
    version: '1.0.0',
    timeoutMs: 60_000,
    inputSchema: {
      type: 'object',
      properties: {
        checks: {
          type: 'array',
          items: { type: 'string', enum: ['proxmox', 'unifi', 'homeassistant', 'proxmox_backup'] },
          description: 'Which checks to run (default: all configured)',
        },
      },
    },
  };

  private readonly config: MonitorCheckConfig;

  constructor(config: MonitorCheckConfig) {
    super();
    this.config = config;
  }

  async execute(
    input: Record<string, unknown>,
    _context: SkillContext,
  ): Promise<SkillResult> {
    const requested = input.checks as CheckName[] | undefined;
    const checks: Array<{ name: CheckName; promise: Promise<Alert[]> }> = [];

    const shouldRun = (name: CheckName) =>
      !requested || requested.length === 0 || requested.includes(name);

    if (this.config.proxmox && shouldRun('proxmox')) {
      checks.push({ name: 'proxmox', promise: this.checkProxmox() });
    }
    if (this.config.unifi && shouldRun('unifi')) {
      checks.push({ name: 'unifi', promise: this.checkUnifi() });
    }
    if (this.config.homeassistant && shouldRun('homeassistant')) {
      checks.push({ name: 'homeassistant', promise: this.checkHomeAssistant() });
    }
    if (this.config.proxmoxBackup && shouldRun('proxmox_backup')) {
      checks.push({ name: 'proxmox_backup', promise: this.checkProxmoxBackup() });
    }

    if (checks.length === 0) {
      return { success: true, display: '' };
    }

    const results = await Promise.allSettled(checks.map(c => c.promise));
    const alerts: Alert[] = [];

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'fulfilled') {
        alerts.push(...r.value);
      } else {
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        alerts.push({ source: checks[i].name, message: `Health check failed: ${msg}` });
      }
    }

    if (alerts.length === 0) {
      return { success: true, display: '' };
    }

    const lines = ['⚠ Infrastructure Alerts:', ''];
    for (const a of alerts) {
      lines.push(`- [${a.source}] ${a.message}`);
    }

    return { success: true, data: alerts, display: lines.join('\n') };
  }

  // -----------------------------------------------------------------------
  // Proxmox check
  // -----------------------------------------------------------------------

  private async checkProxmox(): Promise<Alert[]> {
    const cfg = this.config.proxmox!;
    const alerts: Alert[] = [];

    // 1. Cluster/node status
    const clusterData = await this.proxmoxGet<Record<string, unknown>[]>(cfg, '/cluster/status');
    for (const entry of clusterData) {
      if (entry.type === 'node' && !entry.online) {
        alerts.push({ source: 'proxmox', message: `Node "${entry.name}" is offline` });
      }
    }

    // 2. VM/CT resources
    const resources = await this.proxmoxGet<Record<string, unknown>[]>(cfg, '/cluster/resources?type=vm');
    for (const r of resources) {
      const name = (r.name as string) ?? `VMID ${r.vmid}`;
      const status = r.status as string | undefined;

      // Disk usage > 90%
      const maxdisk = r.maxdisk as number | undefined;
      const disk = r.disk as number | undefined;
      if (maxdisk && maxdisk > 0 && disk != null) {
        const diskPct = (disk / maxdisk) * 100;
        if (diskPct > 90) {
          alerts.push({
            source: 'proxmox',
            message: `${name} disk usage ${diskPct.toFixed(1)}%`,
          });
        }
      }

      // RAM usage > 95% (only for running VMs)
      if (status === 'running') {
        const maxmem = r.maxmem as number | undefined;
        const mem = r.mem as number | undefined;
        if (maxmem && maxmem > 0 && mem != null) {
          const memPct = (mem / maxmem) * 100;
          if (memPct > 95) {
            alerts.push({
              source: 'proxmox',
              message: `${name} RAM usage ${memPct.toFixed(1)}%`,
            });
          }
        }
      }
    }

    return alerts;
  }

  private async proxmoxGet<T>(cfg: ProxmoxConfig, path: string): Promise<T> {
    const url = `${cfg.baseUrl}/api2/json${path}`;
    const headers: Record<string, string> = {
      Authorization: `PVEAPIToken=${cfg.tokenId}=${cfg.tokenSecret}`,
    };

    const res = await this.apiFetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(15_000),
    }, cfg.verifyTls);

    if (!res.ok) {
      throw new Error(`Proxmox HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }

    const json = (await res.json()) as { data: T };
    return json.data;
  }

  // -----------------------------------------------------------------------
  // UniFi check
  // -----------------------------------------------------------------------

  private async checkUnifi(): Promise<Alert[]> {
    const cfg = this.config.unifi!;
    const alerts: Alert[] = [];
    const site = cfg.site ?? 'default';

    // Auth: cookie login or API key
    let headers: Record<string, string>;
    let cookies: string[] = [];
    let csrfToken: string | undefined;

    if (cfg.apiKey) {
      headers = { 'X-API-Key': cfg.apiKey, 'Content-Type': 'application/json' };
    } else {
      // Login
      const base = cfg.baseUrl.replace(/\/+$/, '');
      const loginBody = JSON.stringify({ username: cfg.username, password: cfg.password });

      // Try UniFi OS first
      const osRes = await this.apiFetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: loginBody,
      }, cfg.verifyTls);

      let mode: 'unifi-os' | 'classic';

      if (osRes.status === 200) {
        mode = 'unifi-os';
        cookies = (osRes.headers.getSetCookie?.() ?? []).map(h => h.split(';')[0]);
        csrfToken = osRes.headers.get('x-csrf-token') ?? undefined;
      } else if (osRes.status === 404) {
        const classicRes = await this.apiFetch(`${base}/api/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: loginBody,
        }, cfg.verifyTls);
        if (!classicRes.ok) throw new Error(`UniFi login failed: HTTP ${classicRes.status}`);
        mode = 'classic';
        cookies = (classicRes.headers.getSetCookie?.() ?? []).map(h => h.split(';')[0]);
      } else {
        throw new Error(`UniFi login failed: HTTP ${osRes.status}`);
      }

      headers = { 'Content-Type': 'application/json' };
      if (cookies.length > 0) headers['Cookie'] = cookies.join('; ');
      if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

      // Override mode for URL building — store in closure
      void mode;
    }

    const apiUrl = (path: string) => {
      const base = cfg.baseUrl.replace(/\/+$/, '');
      // API key always uses UniFi OS paths; cookie mode — we try OS first, so default to OS
      return `${base}/proxy/network/api/s/${site}/${path}`;
    };

    const unifiGet = async <T>(path: string): Promise<T> => {
      const res = await this.apiFetch(apiUrl(path), {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(15_000),
      }, cfg.verifyTls);
      if (!res.ok) throw new Error(`UniFi HTTP ${res.status}`);
      const json = (await res.json()) as { data?: T };
      return json.data as T;
    };

    // 1. Site health
    try {
      const health = await unifiGet<any[]>('stat/health');
      for (const subsystem of health ?? []) {
        if (subsystem.status && subsystem.status !== 'ok') {
          alerts.push({
            source: 'unifi',
            message: `Subsystem "${subsystem.subsystem}" status: ${subsystem.status}`,
          });
        }
      }
    } catch { /* stat/health may not exist on all controllers */ }

    // 2. Devices not connected
    try {
      const devices = await unifiGet<any[]>('stat/device');
      for (const d of devices ?? []) {
        if (d.state !== 1) {
          const name = d.name ?? d.hostname ?? d.mac ?? 'unknown';
          alerts.push({
            source: 'unifi',
            message: `Device "${name}" is not connected (state: ${d.state})`,
          });
        }
      }
    } catch { /* ignore */ }

    // 3. Open alerts
    try {
      const unAlerts = await unifiGet<any[]>('rest/alarm?archived=false');
      if (unAlerts && unAlerts.length > 0) {
        alerts.push({
          source: 'unifi',
          message: `${unAlerts.length} open alert(s): ${unAlerts.slice(0, 3).map(a => a.key ?? a.msg ?? 'unknown').join(', ')}`,
        });
      }
    } catch { /* ignore */ }

    return alerts;
  }

  // -----------------------------------------------------------------------
  // Home Assistant check
  // -----------------------------------------------------------------------

  private async checkHomeAssistant(): Promise<Alert[]> {
    const cfg = this.config.homeassistant!;
    const alerts: Alert[] = [];

    const states = await this.haGet<any[]>(cfg, '/api/states');

    let unavailableCount = 0;
    const unavailableExamples: string[] = [];

    for (const entity of states) {
      const eid = entity.entity_id as string;

      // Skip update.* entities — they are commonly "unavailable" when no update is pending
      if (eid.startsWith('update.')) continue;

      // Unavailable entities
      if (entity.state === 'unavailable') {
        unavailableCount++;
        if (unavailableExamples.length < 5) {
          const name = entity.attributes?.friendly_name ?? eid;
          unavailableExamples.push(name);
        }
      }

      // Low battery — only actual battery % sensors (device_class: battery, unit: %)
      const dc = (entity.attributes?.device_class ?? '') as string;
      const unit = (entity.attributes?.unit_of_measurement ?? '') as string;
      if (eid.startsWith('sensor.') && dc === 'battery' && unit === '%') {
        const val = parseFloat(entity.state);
        if (!isNaN(val) && val >= 0 && val < 20) {
          const name = entity.attributes?.friendly_name ?? eid;
          alerts.push({
            source: 'homeassistant',
            message: `Low battery: ${name} at ${val}%`,
          });
        }
      }
    }

    if (unavailableCount > 0) {
      const examples = unavailableExamples.join(', ');
      const suffix = unavailableCount > 5 ? ` (and ${unavailableCount - 5} more)` : '';
      alerts.push({
        source: 'homeassistant',
        message: `${unavailableCount} unavailable entities: ${examples}${suffix}`,
      });
    }

    return alerts;
  }

  private async haGet<T>(cfg: HomeAssistantConfig, path: string): Promise<T> {
    const url = `${cfg.baseUrl.replace(/\/+$/, '')}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${cfg.accessToken}`,
      'Content-Type': 'application/json',
    };

    const res = await this.apiFetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(15_000),
    }, cfg.verifyTls);

    if (!res.ok) {
      throw new Error(`HA HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }

    return (await res.json()) as T;
  }

  // -----------------------------------------------------------------------
  // Proxmox Backup Server check
  // -----------------------------------------------------------------------

  private async checkProxmoxBackup(): Promise<Alert[]> {
    const cfg = this.config.proxmoxBackup!;
    const alerts: Alert[] = [];
    const maxAgeHours = cfg.maxAgeHours ?? 24;

    const url = `${cfg.baseUrl.replace(/\/+$/, '')}/api2/json/nodes/localhost/tasks`;
    const headers: Record<string, string> = {
      Authorization: `PBSAPIToken=${cfg.tokenId}:${cfg.tokenSecret}`,
    };

    const res = await this.apiFetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(15_000),
    }, cfg.verifyTls);

    if (!res.ok) {
      alerts.push({ source: 'proxmox_backup', message: `PBS unreachable: HTTP ${res.status}` });
      return alerts;
    }

    const json = (await res.json()) as { data: Array<{ worker_type: string; status: string; starttime: number; endtime?: number }> };
    const tasks = json.data ?? [];

    // Filter backup tasks
    const backupTasks = tasks.filter(t => t.worker_type === 'backup');
    const now = Date.now() / 1000;

    // Find most recent successful backup
    const successful = backupTasks
      .filter(t => t.status === 'OK')
      .sort((a, b) => (b.endtime ?? b.starttime) - (a.endtime ?? a.starttime));

    if (successful.length === 0) {
      alerts.push({ source: 'proxmox_backup', message: 'No successful backups found' });
    } else {
      const lastBackupTime = successful[0].endtime ?? successful[0].starttime;
      const ageHours = (now - lastBackupTime) / 3600;
      if (ageHours > maxAgeHours) {
        alerts.push({
          source: 'proxmox_backup',
          message: `Last successful backup is ${ageHours.toFixed(1)}h old (threshold: ${maxAgeHours}h)`,
        });
      }
    }

    // Check for recent failures
    const recentFailures = backupTasks.filter(t =>
      t.status !== 'OK' && (now - (t.endtime ?? t.starttime)) < maxAgeHours * 3600,
    );
    if (recentFailures.length > 0) {
      alerts.push({
        source: 'proxmox_backup',
        message: `${recentFailures.length} failed backup(s) in the last ${maxAgeHours}h`,
      });
    }

    return alerts;
  }

  // -----------------------------------------------------------------------
  // HTTP helper with TLS bypass
  // -----------------------------------------------------------------------

  private async apiFetch(
    url: string,
    init: RequestInit,
    verifyTls?: boolean,
  ): Promise<Response> {
    const skipTls = verifyTls === false;
    const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    if (skipTls) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

    try {
      return await fetch(url, init);
    } finally {
      if (skipTls) {
        if (prev === undefined) {
          delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        } else {
          process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
        }
      }
    }
  }
}
