import { ipZahl, neuesNetzFehler, netzWerte, subnetz, type NetzVorhanden } from './netz-regeln.js';
import type { SkillMetadata, SkillContext, SkillResult, PfSenseConfig } from '@alfred/types';
import { Skill } from '../skill.js';
import { tlsFetch } from './social/tls-fetch.js'; // v1385

type Action = 'list_rules' | 'create_rule' | 'delete_rule' | 'list_interfaces' | 'list_vlans' | 'list_gateways' | 'list_dhcp_leases' | 'list_arp' | 'status' | 'api_pruefen' | 'create_vlan' | 'delete_vlan' | 'assign_interface' | 'unassign_interface' | 'enable_dhcp' | 'disable_dhcp';

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
        action: { type: 'string', enum: ['list_rules', 'create_rule', 'delete_rule', 'list_interfaces', 'list_vlans', 'list_gateways', 'list_dhcp_leases', 'list_arp', 'status', 'api_pruefen', 'create_vlan', 'delete_vlan', 'assign_interface', 'unassign_interface', 'enable_dhcp', 'disable_dhcp'], description: 'Netz-Aktionen (Owner 22.10.): api_pruefen (lesend: sind die REST-Endpunkte da?), create_vlan (parent_interface, vlan, description) ↔ delete_vlan (vlan); assign_interface (vlan, description, subnet) ↔ unassign_interface (interface_id); enable_dhcp (interface_id, dhcp_start, dhcp_stop) ↔ disable_dhcp (interface_id).' },
        parent_interface: { type: 'string', description: 'create_vlan: physisches Parent-Interface, z. B. vtnet1 oder igb1' },
        vlan: { type: 'number', description: 'create_vlan/delete_vlan/assign_interface: VLAN-Tag 2–4094' },
        subnet: { type: 'string', description: 'assign_interface: Subnetz, z. B. 10.203.21.0/28 (Interface-IP = erste Adresse)' },
        interface_id: { type: 'string', description: 'unassign_interface/enable_dhcp/disable_dhcp: Interface-ID, z. B. opt3' },
        dhcp_start: { type: 'string' }, dhcp_stop: { type: 'string' },
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
      case 'api_pruefen': return await this.apiPruefen();
      case 'create_vlan': return await this.vlanAnlegen(input);
      case 'delete_vlan': return await this.vlanLoeschen(input);
      case 'assign_interface': return await this.interfaceZuweisen(input);
      case 'unassign_interface': return await this.interfaceEntfernen(input);
      case 'enable_dhcp': return await this.dhcp(input, true);
      case 'disable_dhcp': return await this.dhcp(input, false);
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
      // v1385 — auch die Anmeldung (vorher ohne Ausnahme: JWT scheiterte an selbstsignierten Zertifikaten)
      const res = await tlsFetch(`${this.config.baseUrl}/api/v2/auth/jwt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: this.config.username, password: this.config.password }),
        signal: AbortSignal.timeout(10_000),
      }, this.config.verifyTls === false);
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

    return this._doFetch(url, authHeaders, options);
  }

  private async _doFetch(url: string, authHeaders: Record<string, string>, options?: RequestInit): Promise<any> {
    // v1385 — selbstsignierte Zertifikate (üblich bei pfSense) request-lokal
    const res = await tlsFetch(url, {
      ...options,
      headers: {
        ...authHeaders,
        'Content-Type': 'application/json',
        ...(options?.headers ?? {}),
      },
      signal: AbortSignal.timeout(15_000),
    }, this.config.verifyTls === false);

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

  // ── Netz-Aktionen (Owner 22.10.: Alfred legt VLANs selbst an, wählt UniFi oder pfSense) ──
  /** Endpunkte, die die Netz-Aktionen brauchen (pfSense REST API v2) */
  static readonly NETZ_ENDPUNKTE: Array<[string, string]> = [['/api/v2/interface/vlan', 'post'], ['/api/v2/interface/vlan', 'delete'], ['/api/v2/interface', 'post'], ['/api/v2/interface', 'delete'], ['/api/v2/interface/apply', 'post'], ['/api/v2/services/dhcp_server', 'patch']];

  /** Lesend: sind die Endpunkte der Netz-Aktionen auf diesem pfSense vorhanden (OpenAPI-Schema)? */
  private async apiPruefen(): Promise<SkillResult> {
    const schema = await this.pfFetch('/schema/openapi') as { paths?: Record<string, Record<string, unknown>> };
    const pfade = schema.paths ?? {};
    const z = PfSenseSkill.NETZ_ENDPUNKTE.map(([p, m]) => ({ pfad: p, methode: m.toUpperCase(), da: !!pfade[p]?.[m] }));
    const ok = z.every(x => x.da);
    return { success: true, data: { ok, endpunkte: z }, display: `${ok ? '✅ Alle Endpunkte für Netz-Aktionen vorhanden' : '⚠️ Es fehlen Endpunkte'}\n${z.map(x => `- ${x.da ? '✓' : '✗'} ${x.methode} ${x.pfad}`).join('\n')}` };
  }

  private async vlans(): Promise<Array<{ id?: number | string; if?: string; tag?: number; vlanif?: string; descr?: string }>> {
    return this.fetchDualEndpoint('/interface/vlans', '/interface/vlan');
  }
  private async interfaces(): Promise<Array<{ id?: string; if?: string; descr?: string; ipaddr?: string; subnet?: number | string; enable?: boolean }>> {
    return this.fetchDualEndpoint('/interfaces', '/interface');
  }
  private static vlanIf(v: { if?: string; tag?: number; vlanif?: string }): string { return v.vlanif ?? `${v.if}.${v.tag}`; }

  private async vlanAnlegen(input: Record<string, unknown>): Promise<SkillResult> {
    const parent = String(input.parent_interface ?? '').trim(); const tag = Number(input.vlan); const descr = String(input.description ?? `Alfred VLAN ${tag}`).trim().slice(0, 60);
    if (!/^[a-z]+\d+$/.test(parent)) return { success: false, error: 'parent_interface: physisches Interface, z. B. vtnet1' };
    if (!Number.isInteger(tag) || tag < 2 || tag > 4094) return { success: false, error: 'vlan: 2–4094' };
    const vorhanden = await this.vlans();
    if (vorhanden.some(v => Number(v.tag) === tag && v.if === parent)) return { success: false, error: `VLAN ${tag} auf ${parent} gibt es schon` };
    const r = await this.pfFetch('/interface/vlan', { method: 'POST', body: JSON.stringify({ if: parent, tag, descr }) }) as { data?: { id?: number | string } };
    return { success: true, data: { id: r.data?.id, vlan: tag, parent_interface: parent, vlanif: `${parent}.${tag}` }, display: `✅ VLAN ${tag} auf ${parent} angelegt (${parent}.${tag})` };
  }

  private async vlanLoeschen(input: Record<string, unknown>): Promise<SkillResult> {
    const tag = Number(input.vlan);
    const v = (await this.vlans()).find(x => Number(x.tag) === tag && (!input.parent_interface || x.if === input.parent_interface));
    if (!v) return { success: false, error: `VLAN ${tag} nicht gefunden` };
    const vif = PfSenseSkill.vlanIf(v);
    if ((await this.interfaces()).some(i => i.if === vif)) return { success: false, error: `VLAN ${tag} ist noch als Interface zugewiesen — zuerst unassign_interface` };
    await this.pfFetch(`/interface/vlan?id=${encodeURIComponent(String(v.id))}`, { method: 'DELETE' });
    return { success: true, data: { vlan: tag, vlanif: vif }, display: `✅ VLAN ${tag} (${vif}) gelöscht` };
  }

  private async interfaceZuweisen(input: Record<string, unknown>): Promise<SkillResult> {
    const tag = Number(input.vlan); const descr = String(input.description ?? '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 24);
    if (!descr) return { success: false, error: 'description: Name des Interfaces (z. B. DOCKER_DEV)' };
    const v = (await this.vlans()).find(x => Number(x.tag) === tag);
    if (!v) return { success: false, error: `VLAN ${tag} nicht gefunden — zuerst create_vlan` };
    const vif = PfSenseSkill.vlanIf(v);
    const ifs = await this.interfaces();
    if (ifs.some(i => i.if === vif)) return { success: false, error: `${vif} ist schon zugewiesen` };
    const vorhanden: NetzVorhanden[] = ifs.filter(i => i.ipaddr && ipZahl(String(i.ipaddr)) !== undefined && i.subnet).map(i => ({ name: String(i.descr ?? i.id), subnet: `${i.ipaddr}/${i.subnet}` }));
    const f = neuesNetzFehler({ name: descr, vlan: tag, subnet: String(input.subnet ?? '') }, vorhanden).filter(x => !x.startsWith('VLAN '));
    if (f.length) return { success: false, error: `Interface nicht zugewiesen: ${f.join('; ')}` };
    const w = netzWerte({ name: descr, vlan: tag, subnet: String(input.subnet) });
    const s = subnetz(String(input.subnet))!;
    const r = await this.pfFetch('/interface', { method: 'POST', body: JSON.stringify({ if: vif, descr, enable: true, typev4: 'static', ipaddr: w.gateway, subnet: s.laenge }) }) as { data?: { id?: string } };
    await this.pfFetch('/interface/apply', { method: 'POST', body: '{}' });
    return { success: true, data: { interface_id: r.data?.id, vlanif: vif, ip: w.gateway, subnet: s.laenge, dhcp_start: w.dhcpStart, dhcp_stop: w.dhcpStop }, display: `✅ ${vif} als ${descr} (${r.data?.id ?? '?'}) zugewiesen: ${w.gateway}/${s.laenge}` };
  }

  private async interfaceEntfernen(input: Record<string, unknown>): Promise<SkillResult> {
    const id = String(input.interface_id ?? '').trim();
    if (!/^opt\d+$/.test(id)) return { success: false, error: 'interface_id: nur zusätzliche Interfaces (optN) — nie WAN/LAN' };
    await this.pfFetch(`/interface?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    await this.pfFetch('/interface/apply', { method: 'POST', body: '{}' });
    return { success: true, data: { interface_id: id }, display: `✅ Interface ${id} entfernt` };
  }

  private async dhcp(input: Record<string, unknown>, an: boolean): Promise<SkillResult> {
    const id = String(input.interface_id ?? '').trim();
    if (!/^(lan|opt\d+)$/.test(id)) return { success: false, error: 'interface_id: lan oder optN' };
    const ifs = await this.interfaces();
    const i = ifs.find(x => x.id === id);
    if (!i?.ipaddr || !i.subnet) return { success: false, error: `Interface ${id} ohne statische IP — DHCP geht nicht` };
    const body: Record<string, unknown> = { id, enable: an };
    if (an) {
      const w = netzWerte({ name: id, vlan: 2, subnet: `${i.ipaddr}/${i.subnet}`, ...(typeof input.dhcp_start === 'string' ? { dhcpStart: input.dhcp_start } : {}), ...(typeof input.dhcp_stop === 'string' ? { dhcpStop: input.dhcp_stop } : {}) });
      const s = subnetz(`${i.ipaddr}/${i.subnet}`)!;
      for (const x of [w.dhcpStart, w.dhcpStop]) { const z = ipZahl(x); if (z === undefined || z <= s.netz || z >= s.broadcast) return { success: false, error: `${x} liegt nicht im Subnetz von ${id}` }; }
      Object.assign(body, { range_from: w.dhcpStart, range_to: w.dhcpStop });
    }
    await this.pfFetch('/services/dhcp_server', { method: 'PATCH', body: JSON.stringify(body) });
    return { success: true, data: { interface_id: id, enable: an, ...(an ? { range_from: body.range_from, range_to: body.range_to } : {}) }, display: `✅ DHCP auf ${id} ${an ? `an (${String(body.range_from)}–${String(body.range_to)})` : 'aus'}` };
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
