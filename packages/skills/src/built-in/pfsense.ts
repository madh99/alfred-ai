import type { SkillMetadata, SkillContext, SkillResult, PfSenseConfig } from '@alfred/types';
import { Skill } from '../skill.js';

type Action = 'list_rules' | 'create_rule' | 'delete_rule' | 'list_interfaces' | 'list_vlans' | 'list_gateways' | 'list_dhcp_leases' | 'list_arp' | 'status';

/**
 * pfSense Firewall Skill — verwaltet Firewall-Regeln über die pfSense REST API.
 * Unterstützt 3 Auth-Methoden: API Key, JWT, Basic Auth.
 * create_rule und delete_rule sind sicherheitskritisch → riskLevel: admin.
 */
export class PfSenseSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'pfsense',
    category: 'infrastructure',
    description:
      'pfSense Firewall-Verwaltung über REST API. ' +
      '"list_rules" zeigt alle Firewall-Regeln (optional: interface Filter). ' +
      '"create_rule" erstellt eine neue Regel (interface, protocol, source, destination, destination_port, description). ' +
      '"delete_rule" löscht eine Regel (rule_id). ' +
      '"list_interfaces" zeigt verfügbare Netzwerk-Interfaces mit IP/Subnet. ' +
      '"list_vlans" zeigt konfigurierte VLANs mit Tag und Parent-Interface. ' +
      '"list_gateways" zeigt Gateways mit Interface und IP. ' +
      '"list_dhcp_leases" zeigt aktive DHCP-Leases (IP, MAC, Hostname). ' +
      '"list_arp" zeigt die ARP-Tabelle (IP↔MAC Zuordnung aller aktiven Geräte). ' +
      '"status" zeigt den Firewall-Status. ' +
      'WICHTIG: create_rule und delete_rule ändern die Firewall — nur nach expliziter User-Bestätigung ausführen!',
    riskLevel: 'admin',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list_rules', 'create_rule', 'delete_rule', 'list_interfaces', 'list_vlans', 'list_gateways', 'list_dhcp_leases', 'list_arp', 'status'] },
        interface: { type: 'string', description: 'Interface-Name (z.B. lan, wan, opt1) für list_rules Filter oder create_rule' },
        protocol: { type: 'string', description: 'Protokoll: tcp, udp, icmp, any (default: tcp)' },
        source: { type: 'string', description: 'Quell-IP/Netzwerk (z.B. 172.17.0.10, 192.168.1.0/24, any)' },
        destination: { type: 'string', description: 'Ziel-IP/Netzwerk' },
        destination_port: { type: 'string', description: 'Ziel-Port oder Port-Range (z.B. 3000, 80-443)' },
        source_port: { type: 'string', description: 'Quell-Port (optional, meist any)' },
        type: { type: 'string', description: 'Regel-Typ: pass, block, reject (default: pass)' },
        description: { type: 'string', description: 'Beschreibung der Regel' },
        rule_id: { type: 'number', description: 'Regel-ID für delete_rule' },
      },
      required: ['action'],
    },
  };

  private readonly config: PfSenseConfig;
  private jwtToken?: string;
  private jwtExpiresAt = 0;

  constructor(config: PfSenseConfig) {
    super();
    this.config = config;
  }

  async execute(input: Record<string, unknown>, _context: SkillContext): Promise<SkillResult> {
    const action = input.action as Action;
    switch (action) {
      case 'list_rules': return this.listRules(input.interface as string | undefined);
      case 'create_rule': return this.createRule(input);
      case 'delete_rule': return this.deleteRule(input);
      case 'list_interfaces': return this.listInterfaces();
      case 'list_vlans': return this.listVlans();
      case 'list_gateways': return this.listGateways();
      case 'list_dhcp_leases': return this.listDhcpLeases();
      case 'list_arp': return this.listArp();
      case 'status': return this.getStatus();
      default: return { success: false, error: `Unknown action: ${String(action)}` };
    }
  }

  /** Build auth headers based on configured method. */
  private async getAuthHeaders(): Promise<Record<string, string>> {
    const method = this.config.authMethod ?? 'apikey';

    if (method === 'apikey' && this.config.apiKey) {
      return { 'X-API-Key': this.config.apiKey };
    }

    if (method === 'jwt') {
      if (this.jwtToken && Date.now() < this.jwtExpiresAt) {
        return { 'Authorization': `Bearer ${this.jwtToken}` };
      }
      // Get new JWT
      const res = await fetch(`${this.config.baseUrl}/api/v2/auth/jwt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: this.config.username, password: this.config.password }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`pfSense JWT Auth fehlgeschlagen: ${res.status}`);
      const data = await res.json() as { token: string; exp?: number };
      this.jwtToken = data.token;
      this.jwtExpiresAt = (data.exp !== undefined && data.exp > 0 ? data.exp : Date.now() / 1000 + 3600) * 1000 - 60_000;
      return { 'Authorization': `Bearer ${this.jwtToken}` };
    }

    if (method === 'basic' && this.config.username && this.config.password) {
      const encoded = Buffer.from(`${this.config.username}:${this.config.password}`).toString('base64');
      return { 'Authorization': `Basic ${encoded}` };
    }

    throw new Error('Keine gültige pfSense Auth-Konfiguration (apiKey, jwt oder basic)');
  }

  private async pfFetch(path: string, options?: RequestInit): Promise<any> {
    const authHeaders = await this.getAuthHeaders();
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/api/v2${path}`;

    // Handle self-signed certificates (common for pfSense)
    if (this.config.verifyTls === false && url.startsWith('https')) {
      // Temporarily allow self-signed certs for this request
      const prev = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
      process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
      try {
        return await this._doFetch(url, authHeaders, options);
      } finally {
        if (prev !== undefined) process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = prev;
        else delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
      }
    }

    return this._doFetch(url, authHeaders, options);
  }

  private async _doFetch(url: string, authHeaders: Record<string, string>, options?: RequestInit): Promise<any> {
    const res = await fetch(url, {
      ...options,
      headers: {
        ...authHeaders,
        'Content-Type': 'application/json',
        ...(options?.headers ?? {}),
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`pfSense API ${res.status}: ${text.slice(0, 300)}`);
    }

    return res.json();
  }

  /**
   * v857 Fix B — Helper für dual-endpoint List-Calls mit ehrlichem Success-Tracking.
   * Vorher: try-catch-try-catch mit skip-Kommentar → bei beiden Fails wurde
   * leeres Array mit success:true zurückgegeben → Caller (CMDB-Discoverer
   * o.ä.) sah "success + empty" statt "unreachable". Silent-Failure.
   *
   * Jetzt: tracks ob mindestens ein Endpoint erfolgreich war. Bei totalem Fail
   * wirft die Funktion einen Error mit der letzten Endpoint-Fehlermeldung — der
   * Caller bekommt success:false über das umschließende return. Echter HTTP-200
   * mit leerem `data:[]` ist weiterhin success:true (legitime leere Liste).
   */
  private async fetchDualEndpoint<T>(
    primaryPath: string,
    fallbackPath: string,
  ): Promise<T[]> {
    let lastError: unknown;
    try {
      const data = await this.pfFetch(primaryPath) as { data?: T[] };
      return data.data ?? [];
    } catch (err) {
      lastError = err;
    }
    try {
      const data = await this.pfFetch(fallbackPath) as { data?: T[] };
      return data.data ?? [];
    } catch (err) {
      lastError = err;
    }
    throw new Error(`pfSense unerreichbar (beide Endpoints ${primaryPath} + ${fallbackPath}): ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }

  private async listRules(iface?: string): Promise<SkillResult> {
    const query = iface ? `?interface=${encodeURIComponent(iface)}` : '';
    let rules: Array<Record<string, unknown>>;
    try {
      rules = await this.fetchDualEndpoint<Record<string, unknown>>(`/firewall/rules${query}`, `/firewall/rule${query}`);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    const lines = rules.map((r: any, i: number) => {
      const src = r.source?.address ?? r.source?.network ?? 'any';
      const dst = r.destination?.address ?? r.destination?.network ?? 'any';
      const dstPort = r.destination?.port ?? '*';
      return `| ${r.id ?? i} | ${r.type ?? 'pass'} | ${r.interface ?? '?'} | ${r.protocol ?? 'any'} | ${src} | ${dst}:${dstPort} | ${r.descr ?? ''} |`;
    });

    const display = `## pfSense Firewall Regeln${iface ? ` (${iface})` : ''}\n\n| ID | Typ | IF | Proto | Source | Destination | Beschreibung |\n|----|-----|-------|-------|--------|-------------|--------|\n${lines.join('\n')}`;
    return { success: true, data: rules, display };
  }

  private async createRule(input: Record<string, unknown>): Promise<SkillResult> {
    const iface = (input.interface as string) ?? 'lan';
    const protocol = (input.protocol as string) ?? 'tcp';
    const source = input.source as string;
    const destination = input.destination as string;
    const destPort = input.destination_port as string;
    const description = (input.description as string) ?? '';
    const ruleType = (input.type as string) ?? 'pass';

    if (!destination || !destPort) {
      return { success: false, error: 'destination und destination_port erforderlich' };
    }

    const body: Record<string, unknown> = {
      interface: iface,
      type: ruleType,
      ipprotocol: 'inet',
      protocol,
      source: source ? { address: source } : { network: 'any' },
      destination: { address: destination, port: destPort },
      descr: description || `Alfred: ${source ?? 'any'} → ${destination}:${destPort}`,
      apply: true,
    };

    if (input.source_port) {
      (body.source as Record<string, unknown>).port = input.source_port;
    }

    const result = await this.pfFetch('/firewall/rule', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    return {
      success: true,
      data: result,
      display: `✅ Firewall-Regel erstellt: ${ruleType} ${protocol} ${source ?? 'any'} → ${destination}:${destPort} (${iface})`,
    };
  }

  private async deleteRule(input: Record<string, unknown>): Promise<SkillResult> {
    const ruleId = input.rule_id;
    if (ruleId === undefined) return { success: false, error: 'rule_id erforderlich' };

    await this.pfFetch(`/firewall/rule/${ruleId}`, { method: 'DELETE' });
    return { success: true, display: `✅ Firewall-Regel ${ruleId} gelöscht` };
  }

  private async listInterfaces(): Promise<SkillResult> {
    let interfaces: Array<Record<string, unknown>>;
    try {
      interfaces = await this.fetchDualEndpoint<Record<string, unknown>>('/interfaces', '/interface');
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    const lines = interfaces.map((i: any) =>
      `| ${i.if ?? '?'} | ${i.descr ?? i.name ?? '?'} | ${i.ipaddr ?? 'dhcp'} | ${i.enable ? '🟢' : '🔴'} |`
    );

    const display = `## pfSense Interfaces\n\n| Interface | Name | IP | Status |\n|-----------|------|----|--------|\n${lines.join('\n')}`;
    return { success: true, data: interfaces, display };
  }

  private async listVlans(): Promise<SkillResult> {
    let vlans: Array<Record<string, unknown>>;
    try {
      vlans = await this.fetchDualEndpoint<Record<string, unknown>>('/interface/vlans', '/interface/vlan');
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    const lines = vlans.map((v: any) =>
      `| ${v.tag ?? '?'} | ${v.if ?? v.vlanif ?? '?'} | ${v.parentif ?? v.if?.split('.')[0] ?? '?'} | ${v.descr ?? ''} |`,
    );
    const display = `## pfSense VLANs (${vlans.length})\n\n| Tag | Interface | Parent | Beschreibung |\n|-----|-----------|--------|--------------|\n${lines.join('\n')}`;
    return { success: true, data: vlans, display };
  }

  private async listGateways(): Promise<SkillResult> {
    let gateways: Array<Record<string, unknown>>;
    try {
      gateways = await this.fetchDualEndpoint<Record<string, unknown>>('/routing/gateways', '/routing/gateway');
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    const lines = gateways.map((g: any) =>
      `| ${g.name ?? '?'} | ${g.interface ?? '?'} | ${g.gateway ?? '?'} | ${g.monitor ?? '—'} | ${g.status ?? '?'} |`,
    );
    const display = `## pfSense Gateways (${gateways.length})\n\n| Name | Interface | Gateway | Monitor | Status |\n|------|-----------|---------|---------|--------|\n${lines.join('\n')}`;
    return { success: true, data: gateways, display };
  }

  private async listDhcpLeases(): Promise<SkillResult> {
    let leases: Array<Record<string, unknown>>;
    try {
      leases = await this.fetchDualEndpoint<Record<string, unknown>>('/services/dhcpd/leases', '/services/dhcpd/lease');
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    const lines = leases.map((l: any) =>
      `| ${l.ip ?? '?'} | ${l.mac ?? '?'} | ${l.hostname ?? '—'} | ${l.type ?? l.state ?? '?'} | ${l.end ?? '—'} |`,
    );
    const display = `## pfSense DHCP Leases (${leases.length})\n\n| IP | MAC | Hostname | Typ | Ablauf |\n|----|-----|----------|-----|--------|\n${lines.join('\n')}`;
    return { success: true, data: leases, display };
  }

  private async listArp(): Promise<SkillResult> {
    let entries: Array<Record<string, unknown>>;
    try {
      entries = await this.fetchDualEndpoint<Record<string, unknown>>('/diagnostics/arp', '/diagnostics/arp_table');
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    const lines = entries.map((e: any) =>
      `| ${e.ip ?? '?'} | ${e.mac ?? '?'} | ${e.interface ?? '?'} | ${e.hostname ?? '—'} |`,
    );
    const display = `## pfSense ARP-Tabelle (${entries.length})\n\n| IP | MAC | Interface | Hostname |\n|----|-----|-----------|----------|\n${lines.join('\n')}`;
    return { success: true, data: entries, display };
  }

  private async getStatus(): Promise<SkillResult> {
    try {
      const data = await this.pfFetch('/status/system') as { data: Record<string, unknown> };
      const s = data.data ?? {};
      return {
        success: true,
        data: s,
        display: `## pfSense Status\n\n- **Hostname:** ${s.hostname ?? '?'}\n- **Version:** ${s.version ?? '?'}\n- **Uptime:** ${s.uptime ?? '?'}\n- **CPU:** ${s.cpu_usage ?? '?'}%\n- **RAM:** ${s.mem_usage ?? '?'}%`,
      };
    } catch (err) {
      return { success: false, error: `pfSense Status: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}
