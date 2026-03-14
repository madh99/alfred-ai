import type { SkillMetadata, SkillContext, SkillResult, UniFiConfig } from '@alfred/types';
import { Skill } from '../skill.js';

type ControllerMode = 'unifi-os' | 'classic';

export class UniFiSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'unifi',
    category: 'infrastructure',
    description:
      'Manage UniFi network devices, clients, and WLANs. ' +
      'Use "list_devices" to see APs/switches, "list_clients" for connected clients, ' +
      '"restart_device" to reboot a device, "block_client"/"unblock_client" for access control.',
    riskLevel: 'write',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'list_devices',
            'device_info',
            'list_clients',
            'client_info',
            'list_networks',
            'list_wlans',
            'site_stats',
            'dpi_stats',
            'list_alerts',
            'list_events',
            'list_vouchers',
            'restart_device',
            'locate_device',
            'reconnect_client',
            'create_voucher',
            'enable_wlan',
            'disable_wlan',
            'archive_alerts',
            'block_client',
            'unblock_client',
            'forget_client',
            'adopt_device',
          ],
          description: 'The UniFi action to perform',
        },
        mac: {
          type: 'string',
          description: 'MAC address of device or client (for device_info, client_info, restart_device, locate_device, reconnect_client, block_client, unblock_client, forget_client, adopt_device)',
        },
        active: {
          type: 'boolean',
          description: 'If true list only active clients, if false list all known clients (for list_clients, default: true)',
        },
        enabled: {
          type: 'boolean',
          description: 'Enable or disable device locate LED (for locate_device, default: true)',
        },
        id: {
          type: 'string',
          description: 'WLAN config ID (for enable_wlan, disable_wlan)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of items to return (for list_alerts, list_events)',
        },
        count: {
          type: 'number',
          description: 'Number of vouchers to create (for create_voucher, default: 1)',
        },
        duration: {
          type: 'number',
          description: 'Voucher validity in minutes (for create_voucher)',
        },
        bandwidth_down: {
          type: 'number',
          description: 'Download bandwidth limit in Kbps (for create_voucher, optional)',
        },
        bandwidth_up: {
          type: 'number',
          description: 'Upload bandwidth limit in Kbps (for create_voucher, optional)',
        },
        quota: {
          type: 'number',
          description: 'Number of uses per voucher (for create_voucher, 0 = unlimited, default: 1)',
        },
      },
      required: ['action'],
    },
  };

  private readonly config: UniFiConfig;
  private readonly site: string;

  /** Detected controller mode (lazy, set on first request when using username/password). */
  private controllerMode: ControllerMode | undefined;

  /** Cookie-based session state (username/password auth). */
  private cookies: string[] = [];
  private csrfToken: string | undefined;

  constructor(config: UniFiConfig) {
    super();

    if (!config.apiKey && !(config.username && config.password)) {
      throw new Error(
        'UniFi config requires either "apiKey" or both "username" and "password".',
      );
    }

    this.config = config;
    this.site = config.site ?? 'default';

    // API key mode always uses UniFi OS paths
    if (config.apiKey) {
      this.controllerMode = 'unifi-os';
    }
  }

  // ── execute ────────────────────────────────────────────────────

  async execute(
    input: Record<string, unknown>,
    _context: SkillContext,
  ): Promise<SkillResult> {
    const action = input.action as string;

    try {
      switch (action) {
        // ── READ ──────────────────────────────────────────────
        case 'list_devices':
          return await this.listDevices();
        case 'device_info':
          return await this.deviceInfo(input.mac as string);
        case 'list_clients':
          return await this.listClients(input.active as boolean | undefined);
        case 'client_info':
          return await this.clientInfo(input.mac as string);
        case 'list_networks':
          return await this.listNetworks();
        case 'list_wlans':
          return await this.listWlans();
        case 'site_stats':
          return await this.siteStats();
        case 'dpi_stats':
          return await this.dpiStats(input.mac as string | undefined);
        case 'list_alerts':
          return await this.listAlerts(input.limit as number | undefined);
        case 'list_events':
          return await this.listEvents(input.limit as number | undefined);
        case 'list_vouchers':
          return await this.listVouchers();

        // ── WRITE ─────────────────────────────────────────────
        case 'restart_device':
          return await this.restartDevice(input.mac as string);
        case 'locate_device':
          return await this.locateDevice(input.mac as string, input.enabled as boolean | undefined);
        case 'reconnect_client':
          return await this.reconnectClient(input.mac as string);
        case 'create_voucher':
          return await this.createVoucher(
            input.count as number | undefined,
            input.duration as number,
            input.bandwidth_down as number | undefined,
            input.bandwidth_up as number | undefined,
            input.quota as number | undefined,
          );
        case 'enable_wlan':
          return await this.enableWlan(input.id as string);
        case 'disable_wlan':
          return await this.disableWlan(input.id as string);
        case 'archive_alerts':
          return await this.archiveAlerts();

        // ── ADMIN ─────────────────────────────────────────────
        case 'block_client':
          return await this.blockClient(input.mac as string);
        case 'unblock_client':
          return await this.unblockClient(input.mac as string);
        case 'forget_client':
          return await this.forgetClient(input.mac as string);
        case 'adopt_device':
          return await this.adoptDevice(input.mac as string);

        default:
          return { success: false, error: `Unknown action: ${action}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `UniFi error: ${msg}` };
    }
  }

  // ── URL builder ────────────────────────────────────────────────

  private apiUrl(path: string): string {
    const base = this.config.baseUrl.replace(/\/+$/, '');
    if (this.controllerMode === 'unifi-os') {
      return `${base}/proxy/network/api/s/${this.site}/${path}`;
    }
    return `${base}/api/s/${this.site}/${path}`;
  }

  // ── Authentication ─────────────────────────────────────────────

  /**
   * Ensure we have a valid session. For API key mode this is a no-op.
   * For username/password mode it performs login if needed, auto-detecting
   * UniFi OS vs Classic controller.
   */
  private async ensureAuth(): Promise<void> {
    if (this.config.apiKey) return;
    if (this.cookies.length > 0) return; // already logged in

    await this.login();
  }

  private async login(): Promise<void> {
    const base = this.config.baseUrl.replace(/\/+$/, '');
    const body = JSON.stringify({
      username: this.config.username,
      password: this.config.password,
    });

    // Try UniFi OS first
    const osRes = await this.rawFetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    if (osRes.status === 200) {
      this.controllerMode = 'unifi-os';
      this.storeCookies(osRes);
      return;
    }

    // If 404 → try Classic controller
    if (osRes.status === 404) {
      const classicRes = await this.rawFetch(`${base}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      if (classicRes.ok) {
        this.controllerMode = 'classic';
        this.storeCookies(classicRes);
        return;
      }

      throw new Error(
        `UniFi Classic login failed (HTTP ${classicRes.status}): ${await classicRes.text()}`,
      );
    }

    throw new Error(
      `UniFi OS login failed (HTTP ${osRes.status}): ${await osRes.text()}`,
    );
  }

  private storeCookies(res: Response): void {
    const setCookieHeaders = res.headers.getSetCookie?.() ?? [];
    if (setCookieHeaders.length > 0) {
      this.cookies = setCookieHeaders.map((h) => h.split(';')[0]);
    }

    const csrf = res.headers.get('x-csrf-token');
    if (csrf) {
      this.csrfToken = csrf;
    }
  }

  private clearSession(): void {
    this.cookies = [];
    this.csrfToken = undefined;
  }

  // ── HTTP helpers ───────────────────────────────────────────────

  /**
   * Low-level fetch with TLS override scoped to this call.
   */
  private async rawFetch(url: string, init: RequestInit): Promise<Response> {
    const skipTls = this.config.verifyTls === false;
    if (skipTls) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    try {
      return await fetch(url, init);
    } finally {
      if (skipTls) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    }
  }

  /**
   * Authenticated API request. Handles auth headers/cookies, auto-relogin on 401.
   */
  private async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    await this.ensureAuth();

    const res = await this.doFetch(method, path, body);

    // Auto-relogin on 401 (cookie session expired)
    if (res.status === 401 && !this.config.apiKey) {
      this.clearSession();
      await this.login();
      const retry = await this.doFetch(method, path, body);
      if (!retry.ok) {
        throw new Error(`UniFi API error after relogin: HTTP ${retry.status} ${await retry.text()}`);
      }
      return this.parseResponse<T>(retry);
    }

    if (!res.ok) {
      throw new Error(`UniFi API error: HTTP ${res.status} ${await res.text()}`);
    }

    return this.parseResponse<T>(res);
  }

  private async doFetch(method: string, path: string, body?: unknown): Promise<Response> {
    const url = this.apiUrl(path);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.config.apiKey) {
      headers['X-API-Key'] = this.config.apiKey;
    } else {
      if (this.cookies.length > 0) {
        headers['Cookie'] = this.cookies.join('; ');
      }
      if (this.csrfToken) {
        headers['X-CSRF-Token'] = this.csrfToken;
      }
    }

    return this.rawFetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  }

  private async parseResponse<T>(res: Response): Promise<T> {
    const json = (await res.json()) as { data?: T; meta?: { rc: string; msg?: string } };

    // Store updated CSRF token if present
    const csrf = res.headers.get('x-csrf-token');
    if (csrf) {
      this.csrfToken = csrf;
    }

    if (json.meta?.rc === 'error') {
      throw new Error(`UniFi: ${json.meta.msg ?? 'unknown error'}`);
    }

    return json.data as T;
  }

  // ── READ actions ───────────────────────────────────────────────

  private async listDevices(): Promise<SkillResult> {
    const devices = await this.request<any[]>('GET', 'stat/device');

    const rows = (devices ?? []).map((d) => ({
      name: d.name ?? d.hostname ?? d.mac,
      model: d.model ?? 'unknown',
      ip: d.ip ?? '-',
      mac: d.mac,
      status: d.state === 1 ? 'online' : 'offline',
      clients: d.num_sta ?? 0,
      load: d['system-stats']?.cpu != null ? `${d['system-stats'].cpu}%` : '-',
    }));

    const table = rows.length === 0
      ? 'No devices found.'
      : [
          '| Name | Model | IP | MAC | Status | Clients | CPU |',
          '|------|-------|----|-----|--------|---------|-----|',
          ...rows.map((r) =>
            `| ${r.name} | ${r.model} | ${r.ip} | ${r.mac} | ${r.status} | ${r.clients} | ${r.load} |`,
          ),
        ].join('\n');

    return { success: true, data: devices, display: table };
  }

  private async deviceInfo(mac: string): Promise<SkillResult> {
    if (!mac) return { success: false, error: 'mac is required for device_info.' };

    const devices = await this.request<any[]>('GET', `stat/device/${mac}`);
    const device = devices?.[0];
    if (!device) return { success: false, error: `Device ${mac} not found.` };

    const lines = [
      `**${device.name ?? device.hostname ?? mac}**`,
      `- Model: ${device.model ?? 'unknown'} (${device.model_in_lts ? 'LTS' : device.model_in_eol ? 'EOL' : 'supported'})`,
      `- IP: ${device.ip ?? '-'}`,
      `- MAC: ${device.mac}`,
      `- Status: ${device.state === 1 ? 'online' : 'offline'}`,
      `- Version: ${device.version ?? '-'}`,
      `- Uptime: ${device.uptime ? this.formatUptime(device.uptime) : '-'}`,
      `- Clients: ${device.num_sta ?? 0}`,
      `- CPU: ${device['system-stats']?.cpu ?? '-'}%`,
      `- Memory: ${device['system-stats']?.mem ?? '-'}%`,
      `- TX bytes: ${this.formatBytes(device['tx_bytes'] ?? 0)}`,
      `- RX bytes: ${this.formatBytes(device['rx_bytes'] ?? 0)}`,
    ];

    return { success: true, data: device, display: lines.join('\n') };
  }

  private async listClients(active?: boolean): Promise<SkillResult> {
    const showActive = active !== false;
    const path = showActive ? 'stat/sta' : 'rest/user';
    const clients = await this.request<any[]>('GET', path);

    const rows = (clients ?? []).map((c) => ({
      name: c.name ?? c.hostname ?? c.mac,
      ip: c.ip ?? c.fixed_ip ?? '-',
      mac: c.mac,
      network: c.essid ?? c.network ?? '-',
      signal: c.signal != null ? `${c.signal} dBm` : '-',
      tx: this.formatBytes(c.tx_bytes ?? 0),
      rx: this.formatBytes(c.rx_bytes ?? 0),
    }));

    const table = rows.length === 0
      ? 'No clients found.'
      : [
          '| Name | IP | MAC | Network | Signal | TX | RX |',
          '|------|----|-----|---------|--------|----|----|',
          ...rows.map((r) =>
            `| ${r.name} | ${r.ip} | ${r.mac} | ${r.network} | ${r.signal} | ${r.tx} | ${r.rx} |`,
          ),
        ].join('\n');

    return {
      success: true,
      data: clients,
      display: `${showActive ? 'Active' : 'All known'} clients (${rows.length}):\n\n${table}`,
    };
  }

  private async clientInfo(mac: string): Promise<SkillResult> {
    if (!mac) return { success: false, error: 'mac is required for client_info.' };

    const clients = await this.request<any[]>('GET', 'stat/sta');
    const client = (clients ?? []).find(
      (c) => c.mac?.toLowerCase() === mac.toLowerCase(),
    );
    if (!client) return { success: false, error: `Client ${mac} not found among active clients.` };

    const lines = [
      `**${client.name ?? client.hostname ?? mac}**`,
      `- IP: ${client.ip ?? '-'}`,
      `- MAC: ${client.mac}`,
      `- Network: ${client.essid ?? client.network ?? '-'}`,
      `- Signal: ${client.signal != null ? `${client.signal} dBm` : '-'}`,
      `- Satisfaction: ${client.satisfaction != null ? `${client.satisfaction}%` : '-'}`,
      `- TX rate: ${client.tx_rate != null ? `${(client.tx_rate / 1000).toFixed(1)} Mbps` : '-'}`,
      `- RX rate: ${client.rx_rate != null ? `${(client.rx_rate / 1000).toFixed(1)} Mbps` : '-'}`,
      `- TX bytes: ${this.formatBytes(client.tx_bytes ?? 0)}`,
      `- RX bytes: ${this.formatBytes(client.rx_bytes ?? 0)}`,
      `- Uptime: ${client.uptime ? this.formatUptime(client.uptime) : '-'}`,
      `- Blocked: ${client.blocked ? 'yes' : 'no'}`,
    ];

    return { success: true, data: client, display: lines.join('\n') };
  }

  private async listNetworks(): Promise<SkillResult> {
    const networks = await this.request<any[]>('GET', 'rest/networkconf');

    const rows = (networks ?? []).map((n) => ({
      name: n.name ?? '-',
      purpose: n.purpose ?? '-',
      vlan: n.vlan ?? '-',
      subnet: n.ip_subnet ?? '-',
      dhcp: n.dhcpd_enabled ? 'on' : 'off',
    }));

    const table = rows.length === 0
      ? 'No networks found.'
      : [
          '| Name | Purpose | VLAN | Subnet | DHCP |',
          '|------|---------|------|--------|------|',
          ...rows.map((r) =>
            `| ${r.name} | ${r.purpose} | ${r.vlan} | ${r.subnet} | ${r.dhcp} |`,
          ),
        ].join('\n');

    return { success: true, data: networks, display: table };
  }

  private async listWlans(): Promise<SkillResult> {
    const wlans = await this.request<any[]>('GET', 'rest/wlanconf');

    const rows = (wlans ?? []).map((w) => ({
      name: w.name ?? '-',
      id: w._id ?? '-',
      security: w.security ?? '-',
      band: w.wlan_band ?? 'both',
      enabled: w.enabled !== false ? 'yes' : 'no',
    }));

    const table = rows.length === 0
      ? 'No WLANs found.'
      : [
          '| Name | ID | Security | Band | Enabled |',
          '|------|----|----------|------|---------|',
          ...rows.map((r) =>
            `| ${r.name} | ${r.id} | ${r.security} | ${r.band} | ${r.enabled} |`,
          ),
        ].join('\n');

    return { success: true, data: wlans, display: table };
  }

  private async siteStats(): Promise<SkillResult> {
    const base = this.config.baseUrl.replace(/\/+$/, '');
    await this.ensureAuth();

    // site stats live at a different path — not under /api/s/{site}/
    let url: string;
    if (this.controllerMode === 'unifi-os') {
      url = `${base}/proxy/network/api/stat/sites`;
    } else {
      url = `${base}/api/stat/sites`;
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) {
      headers['X-API-Key'] = this.config.apiKey;
    } else {
      if (this.cookies.length > 0) headers['Cookie'] = this.cookies.join('; ');
      if (this.csrfToken) headers['X-CSRF-Token'] = this.csrfToken;
    }

    const res = await this.rawFetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`site_stats failed: HTTP ${res.status}`);

    const json = (await res.json()) as { data?: any[] };
    const sites = json.data ?? [];

    const lines = sites.map((s: any) => {
      const health = (s.health ?? []) as any[];
      const subsystems = health.map(
        (h: any) => `  - ${h.subsystem}: ${h.status} (${h.num_user ?? 0} users)`,
      );
      return [
        `**${s.desc ?? s.name ?? 'site'}**`,
        `- Devices: ${s.num_new_alarms ?? 0} alarms`,
        ...subsystems,
      ].join('\n');
    });

    return { success: true, data: sites, display: lines.join('\n\n') || 'No site data.' };
  }

  private async dpiStats(mac?: string): Promise<SkillResult> {
    const path = mac ? 'stat/stadpi' : 'stat/sitedpi';
    const body = mac ? { type: 'by_app', macs: [mac] } : { type: 'by_app' };
    const data = await this.request<any[]>('POST', path, body);

    if (!data || data.length === 0) {
      return { success: true, data: [], display: 'No DPI data available.' };
    }

    const lines = data.slice(0, 20).map((d: any) => {
      const cat = d.cat != null ? `Cat ${d.cat}` : 'Unknown';
      const app = d.app != null ? `App ${d.app}` : '';
      return `- ${cat} ${app}: TX ${this.formatBytes(d.tx_bytes ?? 0)}, RX ${this.formatBytes(d.rx_bytes ?? 0)}`;
    });

    return { success: true, data, display: lines.join('\n') || 'No DPI data.' };
  }

  private async listAlerts(limit?: number): Promise<SkillResult> {
    const n = Math.min(Math.max(1, limit ?? 20), 200);
    const alerts = await this.request<any[]>('GET', `stat/alarm?_limit=${n}`);

    const rows = (alerts ?? []).slice(0, n).map((a) => ({
      time: a.datetime ?? a.time ?? '-',
      type: a.key ?? a.msg ?? '-',
      device: a.device_name ?? a.ap_name ?? a.mac ?? '-',
      archived: a.archived ? 'yes' : 'no',
    }));

    const table = rows.length === 0
      ? 'No alerts.'
      : [
          '| Time | Type | Device | Archived |',
          '|------|------|--------|----------|',
          ...rows.map((r) => `| ${r.time} | ${r.type} | ${r.device} | ${r.archived} |`),
        ].join('\n');

    return { success: true, data: alerts, display: table };
  }

  private async listEvents(limit?: number): Promise<SkillResult> {
    const n = Math.min(Math.max(1, limit ?? 20), 200);
    const events = await this.request<any[]>('GET', `stat/event?_limit=${n}`);

    const rows = (events ?? []).slice(0, n).map((e) => ({
      time: e.datetime ?? e.time ?? '-',
      type: e.key ?? '-',
      message: e.msg ?? '-',
    }));

    const table = rows.length === 0
      ? 'No events.'
      : [
          '| Time | Type | Message |',
          '|------|------|---------|',
          ...rows.map((r) => `| ${r.time} | ${r.type} | ${r.message} |`),
        ].join('\n');

    return { success: true, data: events, display: table };
  }

  private async listVouchers(): Promise<SkillResult> {
    const vouchers = await this.request<any[]>('GET', 'stat/voucher');

    const rows = (vouchers ?? []).map((v) => ({
      code: v.code ?? '-',
      duration: v.duration != null ? `${v.duration} min` : '-',
      quota: v.quota ?? 0,
      used: v.used ?? 0,
      created: v.create_time ? new Date(v.create_time * 1000).toISOString() : '-',
      note: v.note ?? '-',
    }));

    const table = rows.length === 0
      ? 'No vouchers.'
      : [
          '| Code | Duration | Quota | Used | Created | Note |',
          '|------|----------|-------|------|---------|------|',
          ...rows.map((r) =>
            `| ${r.code} | ${r.duration} | ${r.quota} | ${r.used} | ${r.created} | ${r.note} |`,
          ),
        ].join('\n');

    return { success: true, data: vouchers, display: table };
  }

  // ── WRITE actions ──────────────────────────────────────────────

  private async restartDevice(mac: string): Promise<SkillResult> {
    if (!mac) return { success: false, error: 'mac is required for restart_device.' };

    await this.request('POST', 'cmd/devmgr', { cmd: 'restart', mac });
    return { success: true, data: { mac }, display: `Restart command sent to device ${mac}.` };
  }

  private async locateDevice(mac: string, enabled?: boolean): Promise<SkillResult> {
    if (!mac) return { success: false, error: 'mac is required for locate_device.' };

    const enable = enabled !== false;
    const cmd = enable ? 'set-locate' : 'unset-locate';
    await this.request('POST', 'cmd/devmgr', { cmd, mac });
    return {
      success: true,
      data: { mac, enabled: enable },
      display: `Device ${mac} locate LED ${enable ? 'enabled' : 'disabled'}.`,
    };
  }

  private async reconnectClient(mac: string): Promise<SkillResult> {
    if (!mac) return { success: false, error: 'mac is required for reconnect_client.' };

    await this.request('POST', 'cmd/stamgr', { cmd: 'kick-sta', mac });
    return { success: true, data: { mac }, display: `Reconnect (kick) command sent to client ${mac}.` };
  }

  private async createVoucher(
    count?: number,
    duration?: number,
    bandwidthDown?: number,
    bandwidthUp?: number,
    quota?: number,
  ): Promise<SkillResult> {
    if (!duration) return { success: false, error: 'duration (minutes) is required for create_voucher.' };

    const body: Record<string, unknown> = {
      cmd: 'create-voucher',
      n: count ?? 1,
      expire: duration,
      quota: quota ?? 1,
    };
    if (bandwidthDown != null) {
      body.down = bandwidthDown;
    }
    if (bandwidthUp != null) {
      body.up = bandwidthUp;
    }

    const result = await this.request<any[]>('POST', 'cmd/hotspot', body);
    const createTime = result?.[0]?.create_time;

    return {
      success: true,
      data: result,
      display: `Created ${count ?? 1} voucher(s), duration ${duration} min.${createTime ? ` Batch: ${createTime}` : ''}\nUse "list_vouchers" to see the codes.`,
    };
  }

  private async enableWlan(id: string): Promise<SkillResult> {
    if (!id) return { success: false, error: 'id is required for enable_wlan.' };

    await this.request('PUT', `rest/wlanconf/${id}`, { enabled: true });
    return { success: true, data: { id, enabled: true }, display: `WLAN ${id} enabled.` };
  }

  private async disableWlan(id: string): Promise<SkillResult> {
    if (!id) return { success: false, error: 'id is required for disable_wlan.' };

    await this.request('PUT', `rest/wlanconf/${id}`, { enabled: false });
    return { success: true, data: { id, enabled: false }, display: `WLAN ${id} disabled.` };
  }

  private async archiveAlerts(): Promise<SkillResult> {
    await this.request('POST', 'cmd/evtmgr', { cmd: 'archive-all-alarms' });
    return { success: true, data: {}, display: 'All alerts archived.' };
  }

  // ── ADMIN actions ──────────────────────────────────────────────

  private async blockClient(mac: string): Promise<SkillResult> {
    if (!mac) return { success: false, error: 'mac is required for block_client.' };

    await this.request('POST', 'cmd/stamgr', { cmd: 'block-sta', mac });
    return { success: true, data: { mac }, display: `Client ${mac} blocked.` };
  }

  private async unblockClient(mac: string): Promise<SkillResult> {
    if (!mac) return { success: false, error: 'mac is required for unblock_client.' };

    await this.request('POST', 'cmd/stamgr', { cmd: 'unblock-sta', mac });
    return { success: true, data: { mac }, display: `Client ${mac} unblocked.` };
  }

  private async forgetClient(mac: string): Promise<SkillResult> {
    if (!mac) return { success: false, error: 'mac is required for forget_client.' };

    await this.request('POST', 'cmd/stamgr', { cmd: 'forget-sta', macs: [mac] });
    return { success: true, data: { mac }, display: `Client ${mac} forgotten (removed from known clients).` };
  }

  private async adoptDevice(mac: string): Promise<SkillResult> {
    if (!mac) return { success: false, error: 'mac is required for adopt_device.' };

    await this.request('POST', 'cmd/devmgr', { cmd: 'adopt', mac });
    return { success: true, data: { mac }, display: `Adopt command sent to device ${mac}.` };
  }

  // ── Formatting helpers ─────────────────────────────────────────

  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / Math.pow(1024, i);
    return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  private formatUptime(seconds: number): string {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const parts: string[] = [];
    if (d > 0) parts.push(`${d}d`);
    if (h > 0) parts.push(`${h}h`);
    parts.push(`${m}m`);
    return parts.join(' ');
  }
}
