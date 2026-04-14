import type { SkillMetadata, SkillContext, SkillResult, MikroTikConfig, MikroTikRouterConfig } from '@alfred/types';
import { Skill } from '../skill.js';

type SkillCallback = (input: Record<string, unknown>) => Promise<SkillResult>;

interface RouterConn {
  name: string;
  cfg: MikroTikRouterConfig;
}

type Action =
  // monitoring
  | 'status' | 'interfaces' | 'traffic' | 'resources' | 'logs'
  | 'dhcp_leases' | 'arp' | 'routes' | 'dns_cache' | 'connections' | 'neighbors' | 'wireless'
  // config
  | 'firewall_rules' | 'add_firewall' | 'remove_firewall' | 'enable_firewall' | 'disable_firewall'
  | 'nat_rules' | 'add_nat' | 'remove_nat'
  | 'set_dns' | 'add_address' | 'remove_address'
  | 'enable_interface' | 'disable_interface'
  | 'add_route' | 'remove_route' | 'add_dhcp_static' | 'set_queue' | 'backup_config'
  // troubleshooting
  | 'ping' | 'traceroute' | 'torch'
  // management
  | 'list_routers' | 'add_router' | 'remove_router' | 'configure';

const WRITE_ACTIONS = new Set<Action>([
  'add_firewall', 'remove_firewall', 'enable_firewall', 'disable_firewall',
  'add_nat', 'remove_nat', 'set_dns', 'add_address', 'remove_address',
  'enable_interface', 'disable_interface', 'add_route', 'remove_route',
  'add_dhcp_static', 'set_queue',
]);

export class MikroTikSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'mikrotik',
    category: 'infrastructure',
    description:
      'MikroTik RouterOS Management — REST API (v7.x). Multi-Router-fähig. ' +
      '"status" zeigt Gesamtübersicht. "interfaces" zeigt Interfaces + Traffic. ' +
      '"resources" zeigt CPU/RAM/Disk. "logs" zeigt System-Logs. ' +
      '"firewall_rules/nat_rules" zeigt Firewall/NAT. "add_firewall/add_nat" fügt Regeln hinzu. ' +
      '"dhcp_leases" zeigt DHCP-Leases. "arp" zeigt ARP-Tabelle. "routes" zeigt Routing. ' +
      '"connections" zeigt Active Connections. "ping/traceroute/torch" für Troubleshooting. ' +
      '"backup_config" exportiert RouterOS-Config. "list_routers" zeigt konfigurierte Router.',
    riskLevel: 'admin',
    version: '1.0.0',
    timeoutMs: 60_000,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'interfaces', 'traffic', 'resources', 'logs', 'dhcp_leases', 'arp', 'routes', 'dns_cache', 'connections', 'neighbors', 'wireless', 'firewall_rules', 'add_firewall', 'remove_firewall', 'enable_firewall', 'disable_firewall', 'nat_rules', 'add_nat', 'remove_nat', 'set_dns', 'add_address', 'remove_address', 'enable_interface', 'disable_interface', 'add_route', 'remove_route', 'add_dhcp_static', 'set_queue', 'backup_config', 'ping', 'traceroute', 'torch', 'list_routers', 'add_router', 'remove_router', 'configure'] },
        router: { type: 'string', description: 'Router-Name (default: erster/default Router)' },
        // Firewall/NAT
        chain: { type: 'string', description: 'Chain: input, forward, output' },
        fw_action: { type: 'string', description: 'Firewall Action: accept, drop, reject, fasttrack-connection' },
        src: { type: 'string', description: 'Source Address/Network' },
        dst: { type: 'string', description: 'Destination Address/Network' },
        protocol: { type: 'string', description: 'Protocol: tcp, udp, icmp' },
        port: { type: 'string', description: 'Destination Port' },
        to_addresses: { type: 'string', description: 'NAT to-addresses' },
        to_ports: { type: 'string', description: 'NAT to-ports' },
        comment: { type: 'string', description: 'Kommentar' },
        position: { type: 'number', description: 'Position in der Regelkette' },
        id: { type: 'string', description: 'RouterOS ID (*1, *2, etc.)' },
        // Interface/Address/Route
        interface: { type: 'string', description: 'Interface-Name' },
        address: { type: 'string', description: 'IP-Adresse mit CIDR' },
        dst_address: { type: 'string', description: 'Ziel-Netzwerk für Route' },
        gateway: { type: 'string', description: 'Gateway-IP' },
        // DHCP
        mac: { type: 'string', description: 'MAC-Adresse' },
        server: { type: 'string', description: 'DHCP-Server Name' },
        // DNS
        servers: { type: 'string', description: 'DNS-Server (kommagetrennt)' },
        name: { type: 'string', description: 'DNS/Router Name' },
        // Queue
        target: { type: 'string', description: 'Queue Target (IP/Subnet)' },
        max_limit: { type: 'string', description: 'Max Limit (z.B. 10M/5M)' },
        // Troubleshooting
        count: { type: 'number', description: 'Ping count (default 4)' },
        duration: { type: 'number', description: 'Torch Dauer in Sekunden (default 5)' },
        // Logs
        topic: { type: 'string', description: 'Log-Topic Filter' },
        limit: { type: 'number', description: 'Limit für Ergebnisse' },
        // Filter
        filter: { type: 'string', description: 'Name-Filter' },
        // Add router
        host: { type: 'string' },
        username: { type: 'string' },
        password: { type: 'string' },
        ssl: { type: 'boolean' },
        // Configure
        confirmation_mode: { type: 'boolean' },
        polling_interval: { type: 'number' },
      },
      required: ['action'],
    },
  };

  private config: MikroTikConfig;
  private readonly dynamicRouters: MikroTikRouterConfig[] = [];
  private itsmCallback?: SkillCallback;
  private lastInterfaceStates = new Map<string, Map<string, boolean>>(); // router → interface → isUp

  constructor(config: MikroTikConfig) {
    super();
    this.config = { ...config };
  }

  setItsmCallback(cb: SkillCallback): void { this.itsmCallback = cb; }

  async execute(input: Record<string, unknown>, _context: SkillContext): Promise<SkillResult> {
    const action = input.action as Action;
    if (WRITE_ACTIONS.has(action) && this.config.confirmation_mode) {
      return {
        success: true,
        data: { requiresConfirmation: true, action, input },
        display: `⚠️ **Bestätigung erforderlich** — ${action} ist im Bestätigungsmodus.`,
      };
    }
    switch (action) {
      // Monitoring
      case 'status': return this.getStatus(input);
      case 'interfaces': return this.getInterfaces(input);
      case 'traffic': return this.getTraffic(input);
      case 'resources': return this.getResources(input);
      case 'logs': return this.getLogs(input);
      case 'dhcp_leases': return this.getDhcpLeases(input);
      case 'arp': return this.getArp(input);
      case 'routes': return this.getRoutes(input);
      case 'dns_cache': return this.getDnsCache(input);
      case 'connections': return this.getConnections(input);
      case 'neighbors': return this.getNeighbors(input);
      case 'wireless': return this.getWireless(input);
      // Config
      case 'firewall_rules': return this.getFirewallRules(input);
      case 'add_firewall': return this.addFirewallRule(input);
      case 'remove_firewall': return this.removeItem(input, '/ip/firewall/filter');
      case 'enable_firewall': return this.toggleItem(input, '/ip/firewall/filter', true);
      case 'disable_firewall': return this.toggleItem(input, '/ip/firewall/filter', false);
      case 'nat_rules': return this.getNatRules(input);
      case 'add_nat': return this.addNatRule(input);
      case 'remove_nat': return this.removeItem(input, '/ip/firewall/nat');
      case 'set_dns': return this.setDns(input);
      case 'add_address': return this.addAddress(input);
      case 'remove_address': return this.removeItem(input, '/ip/address');
      case 'enable_interface': return this.toggleInterface(input, true);
      case 'disable_interface': return this.toggleInterface(input, false);
      case 'add_route': return this.addRoute(input);
      case 'remove_route': return this.removeItem(input, '/ip/route');
      case 'add_dhcp_static': return this.addDhcpStatic(input);
      case 'set_queue': return this.setQueue(input);
      case 'backup_config': return this.backupConfig(input);
      // Troubleshooting
      case 'ping': return this.doPing(input);
      case 'traceroute': return this.doTraceroute(input);
      case 'torch': return this.doTorch(input);
      // Management
      case 'list_routers': return this.listRouters();
      case 'add_router': return this.addRouter(input);
      case 'remove_router': return this.removeRouter(input);
      case 'configure': return this.doConfigure(input);
      default: return { success: false, error: `Unknown action "${action}"` };
    }
  }

  // ── Router Resolution ──────────────────────────────────────

  private getRouters(): MikroTikRouterConfig[] {
    const routers = [...(this.config.routers ?? []), ...this.dynamicRouters];
    // Single-router ENV shorthand
    if (routers.length === 0 && this.config.host) {
      routers.push({
        name: 'default',
        host: this.config.host,
        username: this.config.username ?? 'admin',
        password: this.config.password ?? '',
        port: this.config.port,
        ssl: this.config.ssl,
        default: true,
      });
    }
    return routers;
  }

  private resolveRouter(input: Record<string, unknown>): RouterConn | null {
    const routers = this.getRouters();
    if (routers.length === 0) return null;
    const name = input.router as string | undefined;
    const cfg = name
      ? routers.find(r => r.name.toLowerCase() === name.toLowerCase())
      : routers.find(r => r.default) ?? routers[0];
    return cfg ? { name: cfg.name, cfg } : null;
  }

  // ── REST API ───────────────────────────────────────────────

  private async api<T = unknown>(conn: RouterConn, method: string, path: string, body?: Record<string, unknown>): Promise<T> {
    const { cfg } = conn;
    const proto = cfg.ssl !== false ? 'https' : 'http';
    const port = cfg.port ?? (cfg.ssl !== false ? 443 : 80);
    const url = `${proto}://${cfg.host}:${port}/rest${path}`;

    const auth = Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');
    const headers: Record<string, string> = {
      Authorization: `Basic ${auth}`,
      Accept: 'application/json',
    };

    const opts: RequestInit = { method, headers, signal: AbortSignal.timeout(15_000) };
    if (body) {
      headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }

    const skipTls = cfg.ssl !== false;
    if (skipTls) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    let res: Response;
    try {
      res = await fetch(url, opts);
    } finally {
      if (skipTls) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`MikroTik ${cfg.name} ${method} ${path}: HTTP ${res.status} — ${detail.slice(0, 200)}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) as T : {} as T;
  }

  private requireRouter(input: Record<string, unknown>): RouterConn {
    const conn = this.resolveRouter(input);
    if (!conn) throw new Error('Kein MikroTik-Router konfiguriert. Nutze "add_router" oder setze ALFRED_MIKROTIK_HOST.');
    return conn;
  }

  // ── Monitoring ─────────────────────────────────────────────

  private async getStatus(input: Record<string, unknown>): Promise<SkillResult> {
    const routers = this.getRouters();
    if (routers.length === 0) return { success: false, error: 'Keine Router konfiguriert.' };

    const lines = ['## MikroTik Status', ''];
    for (const cfg of routers) {
      const conn = { name: cfg.name, cfg };
      try {
        const [res, identity, ifaces] = await Promise.all([
          this.api<any>(conn, 'GET', '/system/resource'),
          this.api<any>(conn, 'GET', '/system/identity'),
          this.api<any[]>(conn, 'GET', '/interface'),
        ]);
        const name = identity?.name ?? cfg.name;
        const cpu = res['cpu-load'] ?? '?';
        const ram = res['total-memory'] ? Math.round((1 - (res['free-memory'] ?? 0) / res['total-memory']) * 100) : '?';
        const uptime = res.uptime ?? '?';
        const version = res.version ?? '?';
        const up = ifaces.filter((i: any) => i.running === 'true' || i.running === true).length;
        const down = ifaces.filter((i: any) => i.running === 'false' || i.running === false).length;
        lines.push(`**${name}** (${cfg.host})`);
        lines.push(`  RouterOS ${version} | CPU ${cpu}% | RAM ${ram}% | Uptime ${uptime}`);
        lines.push(`  Interfaces: ${up} up, ${down} down`);
      } catch (err) {
        lines.push(`**${cfg.name}** (${cfg.host}) — ❌ ${err instanceof Error ? err.message.slice(0, 80) : 'nicht erreichbar'}`);
      }
      lines.push('');
    }
    return { success: true, display: lines.join('\n') };
  }

  private async getInterfaces(input: Record<string, unknown>): Promise<SkillResult> {
    const conn = this.requireRouter(input);
    const ifaces = await this.api<any[]>(conn, 'GET', '/interface');
    const filter = (input.filter as string)?.toLowerCase();
    const filtered = filter ? ifaces.filter(i => (i.name ?? '').toLowerCase().includes(filter)) : ifaces;

    const lines = [`## Interfaces — ${conn.name}`, ''];
    for (const i of filtered) {
      const status = i.running === 'true' || i.running === true ? '🟢' : '🔴';
      const tx = formatBytes(parseInt(i['tx-byte'] ?? '0'));
      const rx = formatBytes(parseInt(i['rx-byte'] ?? '0'));
      const errors = (parseInt(i['tx-error'] ?? '0') + parseInt(i['rx-error'] ?? '0'));
      const errStr = errors > 0 ? ` ⚠️ ${errors} errors` : '';
      lines.push(`${status} **${i.name}** (${i.type ?? '?'}) — TX ${tx} / RX ${rx}${errStr}`);
    }
    return { success: true, data: { count: filtered.length }, display: lines.join('\n') };
  }

  private async getTraffic(input: Record<string, unknown>): Promise<SkillResult> {
    const conn = this.requireRouter(input);
    const iface = input.interface as string;
    if (!iface) return { success: false, error: 'Missing interface name' };
    const data = await this.api<any[]>(conn, 'POST', '/interface/monitor-traffic', { interface: iface, once: '' } as any);
    const entry = Array.isArray(data) ? data[0] : data;
    return {
      success: true,
      data: entry,
      display: [
        `## Traffic — ${iface} @ ${conn.name}`,
        '',
        `**TX:** ${formatBytes(parseInt(entry?.['tx-bits-per-second'] ?? '0'))}/s`,
        `**RX:** ${formatBytes(parseInt(entry?.['rx-bits-per-second'] ?? '0'))}/s`,
        `**TX Packets:** ${entry?.['tx-packets-per-second'] ?? '?'}/s`,
        `**RX Packets:** ${entry?.['rx-packets-per-second'] ?? '?'}/s`,
      ].join('\n'),
    };
  }

  private async getResources(input: Record<string, unknown>): Promise<SkillResult> {
    const conn = this.requireRouter(input);
    const res = await this.api<any>(conn, 'GET', '/system/resource');
    const totalMB = Math.round((res['total-memory'] ?? 0) / 1024 / 1024);
    const freeMB = Math.round((res['free-memory'] ?? 0) / 1024 / 1024);
    const totalDisk = Math.round((res['total-hdd-space'] ?? 0) / 1024 / 1024);
    const freeDisk = Math.round((res['free-hdd-space'] ?? 0) / 1024 / 1024);
    return {
      success: true,
      data: res,
      display: [
        `## System Resources — ${conn.name}`,
        '',
        `**CPU:** ${res['cpu-load'] ?? '?'}% (${res['cpu-count'] ?? '?'} Cores, ${res['cpu'] ?? '?'})`,
        `**RAM:** ${totalMB - freeMB} / ${totalMB} MB (${freeMB} MB frei)`,
        `**Disk:** ${totalDisk - freeDisk} / ${totalDisk} MB (${freeDisk} MB frei)`,
        `**Uptime:** ${res.uptime ?? '?'}`,
        `**Version:** RouterOS ${res.version ?? '?'} (${res['architecture-name'] ?? '?'})`,
        `**Board:** ${res['board-name'] ?? '?'}`,
      ].join('\n'),
    };
  }

  private async getLogs(input: Record<string, unknown>): Promise<SkillResult> {
    const conn = this.requireRouter(input);
    let logs = await this.api<any[]>(conn, 'GET', '/log');
    const topic = input.topic as string | undefined;
    if (topic) logs = logs.filter(l => (l.topics ?? '').includes(topic));
    const limit = (input.limit as number) ?? 30;
    const recent = logs.slice(-limit);
    const lines = [`## Logs — ${conn.name}`, ''];
    for (const l of recent) {
      lines.push(`[${l.time ?? ''}] (${l.topics ?? ''}) ${l.message ?? ''}`);
    }
    return { success: true, display: lines.join('\n') };
  }

  private async getDhcpLeases(input: Record<string, unknown>): Promise<SkillResult> {
    const conn = this.requireRouter(input);
    const leases = await this.api<any[]>(conn, 'GET', '/ip/dhcp-server/lease');
    const lines = [`## DHCP Leases — ${conn.name}`, `${leases.length} Leases`, ''];
    for (const l of leases.slice(0, 50)) {
      const status = l.status === 'bound' ? '🟢' : '⚪';
      lines.push(`${status} **${l.address ?? '?'}** — ${l['host-name'] ?? '?'} (${l['mac-address'] ?? '?'})${l.comment ? ` [${l.comment}]` : ''}`);
    }
    return { success: true, data: { count: leases.length }, display: lines.join('\n') };
  }

  private async getArp(input: Record<string, unknown>): Promise<SkillResult> {
    const conn = this.requireRouter(input);
    const entries = await this.api<any[]>(conn, 'GET', '/ip/arp');
    const lines = [`## ARP — ${conn.name}`, `${entries.length} Einträge`, ''];
    for (const e of entries.slice(0, 50)) {
      lines.push(`**${e.address ?? '?'}** — ${e['mac-address'] ?? '?'} (${e.interface ?? '?'})`);
    }
    return { success: true, data: { count: entries.length }, display: lines.join('\n') };
  }

  private async getRoutes(input: Record<string, unknown>): Promise<SkillResult> {
    const conn = this.requireRouter(input);
    let routes = await this.api<any[]>(conn, 'GET', '/ip/route');
    const filter = input.filter as string | undefined;
    if (filter) routes = routes.filter(r => (r['dst-address'] ?? '').includes(filter) || (r.gateway ?? '').includes(filter));
    const lines = [`## Routing — ${conn.name}`, `${routes.length} Routen`, ''];
    for (const r of routes.slice(0, 40)) {
      const active = r.active === 'true' || r.active === true ? '✅' : '⚪';
      lines.push(`${active} ${r['dst-address'] ?? '?'} via ${r.gateway ?? r['immediate-gw'] ?? 'connected'} (${r['routing-table'] ?? 'main'})`);
    }
    return { success: true, data: { count: routes.length }, display: lines.join('\n') };
  }

  private async getDnsCache(input: Record<string, unknown>): Promise<SkillResult> {
    const conn = this.requireRouter(input);
    const entries = await this.api<any[]>(conn, 'GET', '/ip/dns/cache');
    const lines = [`## DNS Cache — ${conn.name}`, `${entries.length} Einträge`, ''];
    for (const e of entries.slice(0, 30)) {
      lines.push(`${e.name ?? '?'} → ${e.address ?? e.data ?? '?'} (TTL ${e.ttl ?? '?'})`);
    }
    return { success: true, display: lines.join('\n') };
  }

  private async getConnections(input: Record<string, unknown>): Promise<SkillResult> {
    const conn = this.requireRouter(input);
    let conns = await this.api<any[]>(conn, 'GET', '/ip/firewall/connection');
    if (input.src) conns = conns.filter(c => (c['src-address'] ?? '').includes(input.src as string));
    if (input.dst) conns = conns.filter(c => (c['dst-address'] ?? '').includes(input.dst as string));
    if (input.protocol) conns = conns.filter(c => c.protocol === input.protocol);
    const lines = [`## Connections — ${conn.name}`, `${conns.length} aktiv`, ''];
    for (const c of conns.slice(0, 30)) {
      lines.push(`${c.protocol ?? '?'} ${c['src-address'] ?? '?'} → ${c['dst-address'] ?? '?'} (${c['connection-state'] ?? '?'})`);
    }
    return { success: true, data: { count: conns.length }, display: lines.join('\n') };
  }

  private async getNeighbors(input: Record<string, unknown>): Promise<SkillResult> {
    const conn = this.requireRouter(input);
    const neighbors = await this.api<any[]>(conn, 'GET', '/ip/neighbor');
    const lines = [`## Neighbors — ${conn.name}`, ''];
    for (const n of neighbors) {
      lines.push(`**${n.identity ?? '?'}** — ${n.address ?? '?'} (${n.platform ?? '?'}, ${n.interface ?? '?'})`);
    }
    return { success: true, data: { count: neighbors.length }, display: lines.join('\n') };
  }

  private async getWireless(input: Record<string, unknown>): Promise<SkillResult> {
    const conn = this.requireRouter(input);
    try {
      const clients = await this.api<any[]>(conn, 'GET', '/interface/wireless/registration-table');
      const lines = [`## WLAN Clients — ${conn.name}`, ''];
      for (const c of clients) {
        lines.push(`**${c['mac-address'] ?? '?'}** — Signal ${c['signal-strength'] ?? '?'} dBm, TX ${c['tx-rate'] ?? '?'}`);
      }
      return { success: true, data: { count: clients.length }, display: lines.join('\n') };
    } catch {
      return { success: true, display: 'Kein WLAN-Interface oder CAPsMAN auf diesem Router.' };
    }
  }

  // ── Firewall ───────────────────────────────────────────────

  private async getFirewallRules(input: Record<string, unknown>): Promise<SkillResult> {
    const conn = this.requireRouter(input);
    let rules = await this.api<any[]>(conn, 'GET', '/ip/firewall/filter');
    const chain = input.chain as string | undefined;
    if (chain) rules = rules.filter(r => r.chain === chain);
    const lines = [`## Firewall Rules — ${conn.name}`, `${rules.length} Regeln`, ''];
    for (const r of rules.slice(0, 40)) {
      const disabled = r.disabled === 'true' || r.disabled === true ? '⏸️' : '✅';
      const src = r['src-address'] ?? '*';
      const dst = r['dst-address'] ?? '*';
      const proto = r.protocol ? `${r.protocol}${r['dst-port'] ? ':' + r['dst-port'] : ''}` : '*';
      lines.push(`${disabled} ${r['.id']} **${r.chain}** ${src} → ${dst} (${proto}) → **${r.action}**${r.comment ? ` // ${r.comment}` : ''}`);
    }
    return { success: true, data: { count: rules.length }, display: lines.join('\n') };
  }

  private async addFirewallRule(input: Record<string, unknown>): Promise<SkillResult> {
    const conn = this.requireRouter(input);
    const body: Record<string, string> = { chain: (input.chain as string) ?? 'input', action: (input.fw_action as string) ?? 'drop' };
    if (input.src) body['src-address'] = input.src as string;
    if (input.dst) body['dst-address'] = input.dst as string;
    if (input.protocol) body.protocol = input.protocol as string;
    if (input.port) body['dst-port'] = input.port as string;
    if (input.comment) body.comment = input.comment as string;
    const result = await this.api<any>(conn, 'POST', '/ip/firewall/filter/add', body);
    return { success: true, display: `Firewall-Regel hinzugefügt auf **${conn.name}**: ${body.chain} ${body.action} (${result?.ret ?? 'ok'})` };
  }

  private async getNatRules(input: Record<string, unknown>): Promise<SkillResult> {
    const conn = this.requireRouter(input);
    const rules = await this.api<any[]>(conn, 'GET', '/ip/firewall/nat');
    const lines = [`## NAT Rules — ${conn.name}`, `${rules.length} Regeln`, ''];
    for (const r of rules.slice(0, 30)) {
      const src = r['src-address'] ?? '*';
      const dst = r['dst-address'] ?? '*';
      const toAddr = r['to-addresses'] ?? '';
      const toPort = r['to-ports'] ?? '';
      lines.push(`${r['.id']} **${r.chain}** ${src} → ${dst} → **${r.action}**${toAddr ? ` to ${toAddr}` : ''}${toPort ? `:${toPort}` : ''}${r.comment ? ` // ${r.comment}` : ''}`);
    }
    return { success: true, data: { count: rules.length }, display: lines.join('\n') };
  }

  private async addNatRule(input: Record<string, unknown>): Promise<SkillResult> {
    const conn = this.requireRouter(input);
    const body: Record<string, string> = { chain: (input.chain as string) ?? 'dstnat', action: (input.fw_action as string) ?? 'dst-nat' };
    if (input.src) body['src-address'] = input.src as string;
    if (input.dst) body['dst-address'] = input.dst as string;
    if (input.protocol) body.protocol = input.protocol as string;
    if (input.port) body['dst-port'] = input.port as string;
    if (input.to_addresses) body['to-addresses'] = input.to_addresses as string;
    if (input.to_ports) body['to-ports'] = input.to_ports as string;
    if (input.comment) body.comment = input.comment as string;
    await this.api(conn, 'POST', '/ip/firewall/nat/add', body);
    return { success: true, display: `NAT-Regel hinzugefügt auf **${conn.name}**` };
  }

  // ── Generic CRUD ───────────────────────────────────────────

  private async removeItem(input: Record<string, unknown>, path: string): Promise<SkillResult> {
    const conn = this.requireRouter(input);
    const id = input.id as string;
    if (!id) return { success: false, error: 'Missing id' };
    await this.api(conn, 'DELETE', `${path}/${id}`);
    return { success: true, display: `Eintrag **${id}** gelöscht auf ${conn.name}` };
  }

  private async toggleItem(input: Record<string, unknown>, path: string, enable: boolean): Promise<SkillResult> {
    const conn = this.requireRouter(input);
    const id = input.id as string;
    if (!id) return { success: false, error: 'Missing id' };
    await this.api(conn, 'POST', `${path}/${enable ? 'enable' : 'disable'}`, { '.id': id });
    return { success: true, display: `Regel **${id}** ${enable ? 'aktiviert' : 'deaktiviert'} auf ${conn.name}` };
  }

  // ── Interface/Address/Route/DNS/DHCP/Queue ─────────────────

  private async toggleInterface(input: Record<string, unknown>, enable: boolean): Promise<SkillResult> {
    const conn = this.requireRouter(input);
    const iface = input.interface as string;
    if (!iface) return { success: false, error: 'Missing interface' };
    const all = await this.api<any[]>(conn, 'GET', '/interface');
    const match = all.find(i => i.name === iface);
    if (!match) return { success: false, error: `Interface "${iface}" nicht gefunden` };
    await this.api(conn, 'POST', `/interface/${enable ? 'enable' : 'disable'}`, { '.id': match['.id'] });
    return { success: true, display: `Interface **${iface}** ${enable ? 'aktiviert' : 'deaktiviert'} auf ${conn.name}` };
  }

  private async addAddress(input: Record<string, unknown>): Promise<SkillResult> {
    const conn = this.requireRouter(input);
    if (!input.address || !input.interface) return { success: false, error: 'Missing address or interface' };
    const body: Record<string, string> = { address: input.address as string, interface: input.interface as string };
    if (input.comment) body.comment = input.comment as string;
    await this.api(conn, 'POST', '/ip/address/add', body);
    return { success: true, display: `IP **${input.address}** auf **${input.interface}** gesetzt (${conn.name})` };
  }

  private async addRoute(input: Record<string, unknown>): Promise<SkillResult> {
    const conn = this.requireRouter(input);
    if (!input.dst_address || !input.gateway) return { success: false, error: 'Missing dst_address or gateway' };
    const body: Record<string, string> = { 'dst-address': input.dst_address as string, gateway: input.gateway as string };
    if (input.comment) body.comment = input.comment as string;
    await this.api(conn, 'POST', '/ip/route/add', body);
    return { success: true, display: `Route **${input.dst_address}** via **${input.gateway}** hinzugefügt (${conn.name})` };
  }

  private async setDns(input: Record<string, unknown>): Promise<SkillResult> {
    const conn = this.requireRouter(input);
    if (input.servers) {
      await this.api(conn, 'POST', '/ip/dns/set', { servers: input.servers as string });
      return { success: true, display: `DNS-Server gesetzt: **${input.servers}** (${conn.name})` };
    }
    if (input.name && input.address) {
      await this.api(conn, 'POST', '/ip/dns/static/add', { name: input.name as string, address: input.address as string });
      return { success: true, display: `DNS Static: **${input.name}** → **${input.address}** (${conn.name})` };
    }
    return { success: false, error: 'Missing servers or name+address' };
  }

  private async addDhcpStatic(input: Record<string, unknown>): Promise<SkillResult> {
    const conn = this.requireRouter(input);
    if (!input.mac || !input.address) return { success: false, error: 'Missing mac or address' };
    const body: Record<string, string> = { 'mac-address': input.mac as string, address: input.address as string };
    if (input.comment) body.comment = input.comment as string;
    if (input.server) body.server = input.server as string;
    await this.api(conn, 'POST', '/ip/dhcp-server/lease/add', body);
    return { success: true, display: `DHCP Static: **${input.mac}** → **${input.address}** (${conn.name})` };
  }

  private async setQueue(input: Record<string, unknown>): Promise<SkillResult> {
    const conn = this.requireRouter(input);
    if (!input.name || !input.target) return { success: false, error: 'Missing name or target' };
    const body: Record<string, string> = { name: input.name as string, target: input.target as string };
    if (input.max_limit) body['max-limit'] = input.max_limit as string;
    if (input.comment) body.comment = input.comment as string;
    await this.api(conn, 'POST', '/queue/simple/add', body);
    return { success: true, display: `Queue **${input.name}**: ${input.target} max ${input.max_limit ?? 'unlimited'} (${conn.name})` };
  }

  private async backupConfig(input: Record<string, unknown>): Promise<SkillResult> {
    const conn = this.requireRouter(input);
    const data = await this.api<any>(conn, 'POST', '/export', {});
    const config = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    return { success: true, data: { config }, display: `## Config Export — ${conn.name}\n\n\`\`\`\n${config.slice(0, 3000)}\n\`\`\`` };
  }

  // ── Troubleshooting ────────────────────────────────────────

  private async doPing(input: Record<string, unknown>): Promise<SkillResult> {
    const conn = this.requireRouter(input);
    if (!input.address) return { success: false, error: 'Missing address' };
    const body: Record<string, unknown> = { address: input.address as string, count: String(input.count ?? 4) };
    if (input.interface) body.interface = input.interface as string;
    const results = await this.api<any[]>(conn, 'POST', '/tool/ping', body as any);
    const lines = [`## Ping ${input.address} — ${conn.name}`, ''];
    for (const r of (Array.isArray(results) ? results : [results])) {
      if (r.time !== undefined) lines.push(`${r.size ?? '?'} bytes from ${r.host ?? input.address}: time=${r.time}ms TTL=${r.ttl ?? '?'}`);
      if (r['sent'] !== undefined) lines.push(`\n${r.sent} sent, ${r.received} received, ${r['packet-loss']}% loss`);
    }
    return { success: true, display: lines.join('\n') };
  }

  private async doTraceroute(input: Record<string, unknown>): Promise<SkillResult> {
    const conn = this.requireRouter(input);
    if (!input.address) return { success: false, error: 'Missing address' };
    const results = await this.api<any[]>(conn, 'POST', '/tool/traceroute', { address: input.address as string, count: '1' } as any);
    const lines = [`## Traceroute ${input.address} — ${conn.name}`, ''];
    for (const r of (Array.isArray(results) ? results : [results])) {
      lines.push(`${r.hop ?? '?'}. ${r.address ?? '*'} (${r.time1 ?? '?'}ms)`);
    }
    return { success: true, display: lines.join('\n') };
  }

  private async doTorch(input: Record<string, unknown>): Promise<SkillResult> {
    const conn = this.requireRouter(input);
    if (!input.interface) return { success: false, error: 'Missing interface' };
    const results = await this.api<any[]>(conn, 'POST', '/tool/torch', {
      interface: input.interface as string, duration: String(input.duration ?? 5),
    } as any);
    const lines = [`## Torch ${input.interface} — ${conn.name}`, ''];
    for (const r of (Array.isArray(results) ? results.slice(0, 20) : [results])) {
      lines.push(`${r['src-address'] ?? '?'} → ${r['dst-address'] ?? '?'}: TX ${formatBytes(parseInt(r['tx'] ?? '0'))}/s RX ${formatBytes(parseInt(r['rx'] ?? '0'))}/s`);
    }
    return { success: true, display: lines.join('\n') };
  }

  // ── Management ─────────────────────────────────────────────

  private listRouters(): SkillResult {
    const routers = this.getRouters();
    if (routers.length === 0) return { success: true, display: 'Keine Router konfiguriert.' };
    const lines = ['## MikroTik Router', ''];
    for (const r of routers) {
      const def = r.default ? ' (default)' : '';
      lines.push(`- **${r.name}** — ${r.host}:${r.port ?? (r.ssl ? 443 : 80)}${def}`);
    }
    return { success: true, display: lines.join('\n') };
  }

  private addRouter(input: Record<string, unknown>): SkillResult {
    const name = input.name as string;
    const host = input.host as string;
    if (!name || !host) return { success: false, error: 'Missing name or host' };
    this.dynamicRouters.push({
      name, host, username: (input.username as string) ?? 'admin', password: (input.password as string) ?? '',
      port: input.port as number | undefined, ssl: input.ssl as boolean | undefined,
    });
    return { success: true, display: `Router **${name}** (${host}) hinzugefügt.` };
  }

  private removeRouter(input: Record<string, unknown>): SkillResult {
    const name = input.name as string;
    if (!name) return { success: false, error: 'Missing name' };
    const idx = this.dynamicRouters.findIndex(r => r.name === name);
    if (idx >= 0) { this.dynamicRouters.splice(idx, 1); return { success: true, display: `Router **${name}** entfernt.` }; }
    return { success: false, error: `Router "${name}" nicht gefunden (nur dynamisch hinzugefügte Router können entfernt werden).` };
  }

  private doConfigure(input: Record<string, unknown>): SkillResult {
    const changes: string[] = [];
    if (input.confirmation_mode !== undefined) { this.config.confirmation_mode = input.confirmation_mode as boolean; changes.push(`Bestätigungsmodus: ${input.confirmation_mode}`); }
    if (input.polling_interval !== undefined) { this.config.polling_interval = input.polling_interval as number; changes.push(`Polling: ${input.polling_interval} Min`); }
    if (changes.length === 0) return { success: false, error: 'Keine Änderungen.' };
    return { success: true, display: `## MikroTik Config\n\n${changes.map(c => `- ${c}`).join('\n')}` };
  }

  // ── Proactive Monitoring ───────────────────────────────────

  async pollAndReport(): Promise<{ downInterfaces: string[]; cpuWarnings: string[]; ramWarnings: string[] }> {
    const result = { downInterfaces: [] as string[], cpuWarnings: [] as string[], ramWarnings: [] as string[] };
    for (const cfg of this.getRouters()) {
      const conn = { name: cfg.name, cfg };
      try {
        const [res, ifaces] = await Promise.all([
          this.api<any>(conn, 'GET', '/system/resource'),
          this.api<any[]>(conn, 'GET', '/interface'),
        ]);

        // CPU/RAM warnings
        const cpu = parseInt(res['cpu-load'] ?? '0');
        if (cpu >= (this.config.cpu_warning_pct ?? 80)) result.cpuWarnings.push(`${cfg.name}: CPU ${cpu}%`);
        const ramPct = res['total-memory'] ? Math.round((1 - (res['free-memory'] ?? 0) / res['total-memory']) * 100) : 0;
        if (ramPct >= (this.config.ram_warning_pct ?? 85)) result.ramWarnings.push(`${cfg.name}: RAM ${ramPct}%`);

        // Interface state changes
        const prevStates = this.lastInterfaceStates.get(cfg.name) ?? new Map();
        const newStates = new Map<string, boolean>();
        for (const i of ifaces) {
          const isUp = i.running === 'true' || i.running === true;
          const wasUp = prevStates.get(i.name);
          newStates.set(i.name, isUp);
          if (wasUp === true && !isUp) {
            result.downInterfaces.push(`${cfg.name}/${i.name}`);
          }
        }
        this.lastInterfaceStates.set(cfg.name, newStates);

        // Auto-incident
        if (this.config.auto_incident && this.itsmCallback && result.downInterfaces.length > 0) {
          await this.itsmCallback({
            action: 'create_incident',
            title: `MikroTik: Interface down (${result.downInterfaces.join(', ')})`,
            description: `Down: ${result.downInterfaces.join(', ')}, CPU warnings: ${result.cpuWarnings.join(', ')}`,
            priority: 'high',
            category: 'network',
          }).catch(() => {});
        }
      } catch { /* router unreachable — will retry next poll */ }
    }
    return result;
  }

  async buildReasoningContext(): Promise<string> {
    const parts: string[] = [];
    for (const cfg of this.getRouters()) {
      const conn = { name: cfg.name, cfg };
      try {
        const [res, ifaces] = await Promise.all([
          this.api<any>(conn, 'GET', '/system/resource'),
          this.api<any[]>(conn, 'GET', '/interface'),
        ]);
        const cpu = res['cpu-load'] ?? '?';
        const down = ifaces.filter((i: any) => (i.running === 'false' || i.running === false) && i.type !== 'bridge').length;
        const errors = ifaces.reduce((sum: number, i: any) => sum + parseInt(i['tx-error'] ?? '0') + parseInt(i['rx-error'] ?? '0'), 0);
        const warns: string[] = [];
        if (parseInt(String(cpu)) >= (this.config.cpu_warning_pct ?? 80)) warns.push(`CPU ${cpu}%`);
        if (down > 0) warns.push(`${down} Interfaces down`);
        if (errors > 0) warns.push(`${errors} Errors`);
        parts.push(`${cfg.name}: ${warns.length > 0 ? warns.join(', ') : 'OK'}`);
      } catch {
        parts.push(`${cfg.name}: nicht erreichbar`);
      }
    }
    return parts.length > 0 ? parts.join(' | ') : '(Keine MikroTik-Router konfiguriert)';
  }
}

// ── Helpers ──────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}
