import { ipZahl, neuesNetzFehler, netzWerte, subnetz, type NetzVorhanden } from './netz-regeln.js';
import type { SkillMetadata, SkillContext, SkillResult, PfSenseConfig } from '@alfred/types';
import { Skill } from '../skill.js';
import { tlsFetch } from './social/tls-fetch.js'; // v1385

type Action = 'list_port_forwards' | 'create_static_route' | 'delete_static_route' | 'api_schema' | 'list_routes' | 'list_rules' | 'create_rule' | 'delete_rule' | 'list_interfaces' | 'list_vlans' | 'list_gateways' | 'list_dhcp_leases' | 'list_arp' | 'status' | 'api_pruefen' | 'create_vlan' | 'delete_vlan' | 'assign_interface' | 'unassign_interface' | 'enable_dhcp' | 'disable_dhcp';

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
      '"list_rules" zeigt alle Firewall-Regeln (optional: interface Filter, interne ID wie opt1 oder Beschreibung wie MAIN_LAN). ' +
      '"list_routes" zeigt Standard-Gateway, statische Routen und die Adressen der Interfaces (lesend). ' +
      '"list_port_forwards" zeigt die Portweiterleitungen (NAT) — was von außen auf welches interne Ziel geht (lesend). ' +
      'Nur als Change-Schritt: "create_rule" (interface z. B. MAIN_LAN oder opt1, protocol, source, destination, destination_port, description = eindeutiger Name) ↔ "delete_rule" (description); "create_static_route" (network CIDR, gateway = Gateway-Name z. B. MAIN_LAN_DHCP, description) ↔ "delete_static_route" (network). ' +
      '"create_rule" erstellt eine neue Regel (interface, protocol, source, destination, destination_port, description). ' +
      '"delete_rule" löscht eine Regel (description, nur im Change). ' +
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
        action: { type: 'string', enum: ['list_port_forwards', 'create_static_route', 'delete_static_route', 'api_schema', 'list_routes', 'list_rules', 'create_rule', 'delete_rule', 'list_interfaces', 'list_vlans', 'list_gateways', 'list_dhcp_leases', 'list_arp', 'status', 'api_pruefen', 'create_vlan', 'delete_vlan', 'assign_interface', 'unassign_interface', 'enable_dhcp', 'disable_dhcp'], description: 'Netz-Aktionen (Owner 22.10.): api_pruefen (lesend: sind die REST-Endpunkte da?), create_vlan (parent_interface, vlan, description) ↔ delete_vlan (vlan); assign_interface (vlan, description, subnet) ↔ unassign_interface (interface_id); enable_dhcp (interface_id, dhcp_start, dhcp_stop) ↔ disable_dhcp (interface_id).' },
        parent_interface: { type: 'string', description: 'create_vlan: physisches Parent-Interface, z. B. vtnet1 oder igb1' },
        vlan: { type: 'number', description: 'create_vlan/delete_vlan/assign_interface: VLAN-Tag 2–4094' },
        subnet: { type: 'string', description: 'assign_interface: Subnetz, z. B. 10.203.21.0/28 (Interface-IP = erste Adresse)' },
        interface_id: { type: 'string', description: 'unassign_interface/enable_dhcp/disable_dhcp: Interface-ID, z. B. opt3' },
        dhcp_start: { type: 'string' }, dhcp_stop: { type: 'string' },
        interface: { type: 'string', description: 'Interface-Name (z.B. lan, wan, opt1) für list_rules Filter oder create_rule' },
        path: { type: 'string', description: 'api_schema: REST-Pfad der pfSense-API v2, z. B. /firewall/rule oder /routing/static_route' },
        network: { type: 'string', description: 'create_/delete_static_route: Zielnetz in CIDR, z. B. 10.203.24.0/28' },
        gateway: { type: 'string', description: 'create_static_route: Gateway-Name aus list_gateways, z. B. MAIN_LAN_DHCP' },
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
    // v1608 — schreibende Aktionen nur als Schritt eines freigegebenen Changes (Freigabe, Rückweg, Protokoll), wie bei Proxmox/UniFi
    if (PfSenseSkill.NUR_IM_CHANGE.has(action) && _context?.ausChange !== true) return { success: false, error: `${action} läuft nur als Schritt eines freigegebenen Changes — mit infrastruktur changes_planen planen` };
    switch (action) {
      case 'list_rules': return this.listRules(input.interface as string | undefined);
      case 'list_routes': return this.listRoutes();
      case 'list_port_forwards': return await this.listPortForwards();
      case 'api_schema': return await this.apiSchema(String(input.path ?? ''));
      case 'create_static_route': return await this.routeAnlegen(input);
      case 'delete_static_route': return await this.routeLoeschen(input);
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
    let rules: Array<Record<string, unknown>>;
    try {
      rules = await this.fetchDualEndpoint<Record<string, unknown>>('/firewall/rules', '/firewall/rule');
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
    // v1606 — Realfall 23.10.: die REST-API v2 ignoriert ?interface= und liefert Quelle/Ziel als Text, Interfaces als Liste; der Skill las
    // noch die v1-Felder (source.address …) und zeigte überall „any“. Jetzt hier filtern (interne ID oder Beschreibung, z. B. MAIN_LAN).
    if (iface) {
      const namen = await this.interfaces().catch(() => [] as Array<Record<string, unknown>>);
      rules = rules.filter(r => regelPasstZuInterface(r, iface, namen));
    }
    const lines = rules.map((r, i) => regelZeile(r, i));

    const display = `## pfSense Firewall Regeln${iface ? ` (${iface})` : ''}\n\n| ID | Typ | IF | Proto | Source | Destination | Beschreibung |\n|----|-----|-------|-------|--------|-------------|--------|\n${lines.join('\n')}`;
    return { success: true, data: rules, display };
  }

  static readonly NUR_IM_CHANGE = new Set<string>(['create_rule', 'delete_rule', 'create_static_route', 'delete_static_route', 'create_vlan', 'delete_vlan', 'assign_interface', 'unassign_interface', 'enable_dhcp', 'disable_dhcp']);

  /** Interface-Angabe (opt1, MAIN_LAN, lan) → interne ID */
  private async interfaceId(angabe: string): Promise<string | undefined> {
    const w = angabe.trim().toLowerCase();
    if (!w) return undefined;
    const l = await this.interfaces();
    const t = l.find(i => String(i.id ?? '').toLowerCase() === w || String(i.descr ?? '').toLowerCase() === w || String(i.if ?? '').toLowerCase() === w);
    return t?.id ? String(t.id) : (['lan', 'wan'].includes(w) ? w : undefined);
  }

  private async regeln(): Promise<Array<Record<string, unknown>>> { return this.fetchDualEndpoint('/firewall/rules', '/firewall/rule'); }

  /**
   * v1608 (Realfall 23.10., pgAdmin → 10.0.0.14) — REST-API v2: interface als Liste, Quelle/Ziel/Port als Text, danach /firewall/apply.
   * Die Beschreibung ist der Schlüssel (IDs verschieben sich beim Löschen): wiederholbar, Rückweg delete_rule mit derselben Beschreibung.
   */
  private async createRule(input: Record<string, unknown>): Promise<SkillResult> {
    const descr = String(input.description ?? '').trim();
    const ziel = String(input.destination ?? '').trim();
    const port = input.destination_port !== undefined ? String(input.destination_port).trim() : '';
    const quelle = String(input.source ?? 'any').trim() || 'any';
    const protokoll = String(input.protocol ?? 'tcp').toLowerCase();
    const typ = String(input.type ?? 'pass').toLowerCase();
    if (!/^[\w .:/>-]{4,80}$/.test(descr)) return { success: false, error: 'create_rule: description als eindeutiger Name (4–80 Zeichen) — der Rückweg findet die Regel darüber' };
    if (!ziel) return { success: false, error: 'create_rule: destination fehlt' };
    if (!['pass', 'block', 'reject'].includes(typ)) return { success: false, error: 'type: pass, block oder reject' };
    if (!['tcp', 'udp', 'tcp/udp', 'icmp'].includes(protokoll)) return { success: false, error: 'protocol: tcp, udp, tcp/udp oder icmp' };
    if (port && !/^\d{1,5}(:\d{1,5})?$/.test(port)) return { success: false, error: 'destination_port: Port oder Bereich a:b' };
    const ifId = await this.interfaceId(String(input.interface ?? ''));
    if (!ifId) return { success: false, error: `Interface „${String(input.interface ?? '')}“ unbekannt (interne ID wie opt1 oder Beschreibung wie MAIN_LAN)` };
    const vorher = (await this.regeln()).filter(x => String(x.descr ?? '') === descr);
    if (vorher.length > 1) return { success: false, error: `Mehrere Regeln heißen „${descr}“ — nicht eindeutig` };
    const soll = { type: typ, interface: [ifId], ipprotocol: 'inet', protocol: protokoll, source: quelle, destination: ziel, ...(port ? { destination_port: port } : {}), descr };
    const gleich = (x: Record<string, unknown>) => regelSeite(x.source) === quelle && regelSeite(x.destination) === ziel && String(x.destination_port ?? '') === port && String(x.protocol ?? '') === protokoll && regelPasstZuInterface(x, ifId, []) && !x.disabled;
    if (vorher[0]) {
      if (gleich(vorher[0])) return { success: true, data: { descr, vorhanden: true }, display: `Regel „${descr}“ ist bereits genau so vorhanden` };
      return { success: false, error: `Regel „${descr}“ gibt es schon mit anderen Werten — erst delete_rule` };
    }
    await this.pfFetch('/firewall/rule', { method: 'POST', body: JSON.stringify(soll) });
    await this.pfFetch('/firewall/apply', { method: 'POST', body: '{}' });
    const nachher = (await this.regeln()).find(x => String(x.descr ?? '') === descr);
    if (!nachher || !gleich(nachher)) return { success: false, error: `Regel „${descr}“ nach dem Anlegen nicht wie gewünscht nachlesbar` };
    return { success: true, data: { descr, id: nachher.id, interface: ifId }, display: `✅ pfSense-Regel „${descr}“: ${typ} ${protokoll} ${quelle} → ${ziel}${port ? `:${port}` : ''} auf ${ifId} (angewendet, zurückgelesen)` };
  }

  private async deleteRule(input: Record<string, unknown>): Promise<SkillResult> {
    const descr = String(input.description ?? '').trim();
    if (!descr) return { success: false, error: 'delete_rule: description der Regel (IDs verschieben sich beim Löschen)' };
    const l = (await this.regeln()).filter(x => String(x.descr ?? '') === descr);
    if (l.length > 1) return { success: false, error: `Mehrere Regeln heißen „${descr}“ — nicht eindeutig` };
    if (!l[0]) return { success: true, data: { descr, schonWeg: true }, display: `Regel „${descr}“ gibt es nicht (mehr)` };
    await this.pfFetch(`/firewall/rule?id=${encodeURIComponent(String(l[0].id))}`, { method: 'DELETE' });
    await this.pfFetch('/firewall/apply', { method: 'POST', body: '{}' });
    if ((await this.regeln()).some(x => String(x.descr ?? '') === descr)) return { success: false, error: `Regel „${descr}“ ist nach dem Löschen noch vorhanden` };
    return { success: true, data: { descr, entfernt: true }, display: `✅ pfSense-Regel „${descr}“ entfernt (angewendet)` };
  }

  private async routen(): Promise<Array<{ id?: number | string; network?: string; gateway?: string; descr?: string; disabled?: boolean }>> { return this.fetchDualEndpoint('/routing/static_routes', '/routing/static_route'); }

  /** v1608 — statische Route (z. B. Rückweg in ein UniFi-VLAN über MAIN_LAN_DHCP), wiederholbar, danach /routing/apply und nachlesen */
  private async routeAnlegen(input: Record<string, unknown>): Promise<SkillResult> {
    const netz = String(input.network ?? '').trim(), gw = String(input.gateway ?? '').trim();
    const descr = String(input.description ?? `Alfred: ${netz} über ${gw}`).trim().slice(0, 80);
    if (!/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(netz)) return { success: false, error: 'network: CIDR, z. B. 10.203.24.0/28' };
    const gws = await this.fetchDualEndpoint<{ name?: string }>('/routing/gateways', '/routing/gateway');
    if (!gws.some(g => g.name === gw)) return { success: false, error: `Gateway „${gw}“ unbekannt (vorhanden: ${gws.map(g => g.name).join(', ')})` };
    const da = (await this.routen()).find(x => x.network === netz);
    if (da) return da.gateway === gw && !da.disabled ? { success: true, data: { network: netz, vorhanden: true }, display: `Route ${netz} über ${gw} ist bereits vorhanden` } : { success: false, error: `Route ${netz} gibt es schon (über ${da.gateway}${da.disabled ? ', aus' : ''}) — erst delete_static_route` };
    await this.pfFetch('/routing/static_route', { method: 'POST', body: JSON.stringify({ network: netz, gateway: gw, descr, disabled: false }) });
    await this.pfFetch('/routing/apply', { method: 'POST', body: '{}' });
    const n = (await this.routen()).find(x => x.network === netz);
    if (!n || n.gateway !== gw) return { success: false, error: `Route ${netz} nach dem Anlegen nicht nachlesbar` };
    return { success: true, data: { network: netz, gateway: gw }, display: `✅ Statische Route ${netz} über ${gw} angelegt (angewendet, zurückgelesen)` };
  }

  private async routeLoeschen(input: Record<string, unknown>): Promise<SkillResult> {
    const netz = String(input.network ?? '').trim();
    const da = (await this.routen()).find(x => x.network === netz);
    if (!da) return { success: true, data: { network: netz, schonWeg: true }, display: `Route ${netz} gibt es nicht (mehr)` };
    await this.pfFetch(`/routing/static_route?id=${encodeURIComponent(String(da.id))}`, { method: 'DELETE' });
    await this.pfFetch('/routing/apply', { method: 'POST', body: '{}' });
    if ((await this.routen()).some(x => x.network === netz)) return { success: false, error: `Route ${netz} ist nach dem Löschen noch vorhanden` };
    return { success: true, data: { network: netz, entfernt: true }, display: `✅ Statische Route ${netz} entfernt (angewendet)` };
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

  /** v1606 — lesend: Felder eines REST-Endpunkts aus dem OpenAPI-Schema (Methoden, Parameter, Body-Felder mit Typ/Pflicht/Enum) */
  private async apiSchema(pfad: string): Promise<SkillResult> {
    const p = pfad.startsWith('/api/v2') ? pfad : `/api/v2${pfad.startsWith('/') ? '' : '/'}${pfad}`;
    if (!/^\/api\/v2\/[\w/]+$/.test(p)) return { success: false, error: 'path: z. B. /firewall/rule oder /routing/static_route' };
    const schema = await this.pfFetch('/schema/openapi') as { paths?: Record<string, Record<string, any>>; components?: { schemas?: Record<string, any> } };
    const e = schema.paths?.[p];
    if (!e) return { success: false, error: `${p} nicht im Schema; ähnliche: ${Object.keys(schema.paths ?? {}).filter(k => k.includes(p.split('/').pop() ?? '')).slice(0, 10).join(', ')}` };
    const aufloesen = (x: any): any => (x?.$ref ? schema.components?.schemas?.[String(x.$ref).split('/').pop()!] : x);
    const zeilen: string[] = [];
    for (const [m, op] of Object.entries(e)) {
      if (!op || typeof op !== 'object' || !('responses' in op || 'parameters' in op || 'requestBody' in op)) continue;
      zeilen.push(`${m.toUpperCase()} ${p}`);
      for (const pa of (op.parameters ?? []).map(aufloesen)) zeilen.push(`  Parameter ${pa?.name}${pa?.required ? ' (Pflicht)' : ''} in ${pa?.in}: ${pa?.schema?.type ?? ''}`);
      const body = aufloesen(op.requestBody?.content?.['application/json']?.schema);
      const props = body?.allOf ? Object.assign({}, ...body.allOf.map((x: any) => aufloesen(x)?.properties ?? {})) : body?.properties ?? {};
      const pflicht = new Set<string>(body?.required ?? []);
      for (const [k, v] of Object.entries<any>(props)) zeilen.push(`  Feld ${k}${pflicht.has(k) ? ' (Pflicht)' : ''}: ${v?.type ?? ''}${v?.items?.type ? `<${v.items.type}>` : ''}${v?.enum ? ` [${v.enum.slice(0, 12).join('|')}]` : ''}${v?.default !== undefined ? ` = ${JSON.stringify(v.default)}` : ''}${v?.description ? ` — ${String(v.description).replace(/<[^>]+>/g, '').slice(0, 140)}` : ''}`);
    }
    return { success: true, data: { pfad: p }, display: zeilen.join('\n') || 'keine Methoden' };
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

  /** v1606 — Rückweg-Fragen (Realfall 23.10.: Antwort an 10.203.24.2 ging vermutlich über das WAN-Gateway): Standard-Gateway, statische Routen, Interface-Adressen */
  private async listRoutes(): Promise<SkillResult> {
    const versuche = async (pfade: string[]) => { for (const p of pfade) { try { return ((await this.pfFetch(p)) as { data?: unknown }).data; } catch { /* nächster */ } } return undefined; };
    const [standard, routen, ifs] = await Promise.all([
      versuche(['/routing/gateway/default']),
      versuche(['/routing/static_routes', '/routing/static_route']),
      versuche(['/status/interfaces']),
    ]);
    if (standard === undefined && routen === undefined && ifs === undefined) return { success: false, error: 'pfSense: weder Standard-Gateway noch statische Routen noch Interface-Status lesbar' };
    const d = standard as { defaultgw4?: string; defaultgw6?: string } | undefined;
    const r = (Array.isArray(routen) ? routen : []) as Array<{ network?: string; gateway?: string; descr?: string; disabled?: boolean }>;
    const i = (Array.isArray(ifs) ? ifs : []) as Array<{ name?: string; descr?: string; hwif?: string; ipaddr?: string; subnet?: string | number; gateway?: string; status?: string }>;
    const zeilen = [
      `Standard-Gateway IPv4: ${d?.defaultgw4 || '(automatisch/unbekannt)'}${d?.defaultgw6 ? ` · IPv6: ${d.defaultgw6}` : ''}`,
      `Statische Routen (${r.length}):`, ...r.map(x => `- ${x.network ?? '?'} → ${x.gateway ?? '?'}${x.disabled ? ' (aus)' : ''}${x.descr ? ` — ${x.descr}` : ''}`),
      'Interfaces:', ...i.map(x => `- ${x.descr ?? x.name ?? '?'} (${x.name ?? '?'}/${x.hwif ?? '?'}): ${x.ipaddr ?? '-'}${x.subnet !== undefined && x.subnet !== '' ? `/${x.subnet}` : ''}${x.gateway ? ` · Gateway ${x.gateway}` : ''}${x.status ? ` · ${x.status}` : ''}`),
    ];
    return { success: true, data: { standard: d, routen: r, interfaces: i }, display: zeilen.join('\n') };
  }

  /** v1613 — Owner 23.10.: „alles, was öffentlich erreichbar ist, geht über MikroTik und pfSense nach außen“ — Portweiterleitungen lesen */
  private async listPortForwards(): Promise<SkillResult> {
    let l: Array<Record<string, unknown>>;
    try { l = await this.fetchDualEndpoint<Record<string, unknown>>('/firewall/nat/port_forwards', '/firewall/nat/port_forward'); }
    catch (err) { return { success: false, error: err instanceof Error ? err.message : String(err) }; }
    const zeile = (f: Record<string, unknown>, i: number) => {
      const iface = Array.isArray(f.interface) ? (f.interface as unknown[]).join(',') : String(f.interface ?? '?');
      return `| ${f.id ?? i} | ${f.disabled ? 'AUS' : 'an'} | ${iface} | ${f.protocol ?? 'any'} | ${regelSeite(f.source)} | ${regelSeite(f.destination)}:${f.destination_port ?? '*'} | ${f.target ?? '?'}:${f.local_port ?? f.destination_port ?? '*'} | ${f.descr ?? ''} |`;
    };
    return { success: true, data: l, display: `## pfSense Portweiterleitungen (${l.length})\n\n| ID | Status | Interface | Proto | Quelle | Ziel:Port (außen) | Intern:Port | Beschreibung |\n|---|---|---|---|---|---|---|---|\n${l.map(zeile).join('\n')}` };
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

/** v1606 — Adresse einer Regel-Seite: v2 liefert Text („any“, „192.168.1.0/24“, „opt1“, „lan:ip“), v1 ein Objekt */
export function regelSeite(x: unknown): string {
  if (typeof x === 'string') return x || 'any';
  if (x && typeof x === 'object') {
    const o = x as { address?: string; network?: string; any?: unknown; not?: boolean };
    const a = o.address ?? o.network ?? (o.any !== undefined ? 'any' : undefined) ?? 'any';
    return o.not ? `!${a}` : a;
  }
  return 'any';
}

/** v1606 — Interface einer Regel (v2: Liste, v1: Text) gegen interne ID oder Beschreibung (MAIN_LAN → opt1) */
export function regelPasstZuInterface(r: Record<string, unknown>, wunsch: string, interfaces: Array<Record<string, unknown>>): boolean {
  const w = wunsch.trim().toLowerCase();
  const ids = new Set([w, ...interfaces.filter(i => String(i.descr ?? '').toLowerCase() === w || String(i.if ?? '').toLowerCase() === w).map(i => String(i.id ?? '').toLowerCase()).filter(Boolean)]);
  const hat = Array.isArray(r.interface) ? (r.interface as unknown[]).map(x => String(x).toLowerCase()) : String(r.interface ?? '').toLowerCase().split(',');
  return hat.some(x => ids.has(x.trim()));
}

export function regelZeile(r: Record<string, unknown>, i: number): string {
  const f = r as { id?: unknown; type?: string; interface?: unknown; protocol?: string; source?: unknown; destination?: unknown; destination_port?: string; source_port?: string; descr?: string; disabled?: boolean };
  const iface = Array.isArray(f.interface) ? (f.interface as unknown[]).join(',') : String(f.interface ?? '?');
  const port = f.destination_port ?? (f.destination as { port?: string } | undefined)?.port ?? '*';
  return `| ${f.id ?? i} | ${f.type ?? 'pass'}${f.disabled ? ' (aus)' : ''} | ${iface} | ${f.protocol ?? 'any'} | ${regelSeite(f.source)}${f.source_port ? `:${f.source_port}` : ''} | ${regelSeite(f.destination)}:${port || '*'} | ${f.descr ?? ''} |`;
}
