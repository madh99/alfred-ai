import { HOSTNAME, ipZahl, neuesNetzFehler, netzWerte, type NetzVorhanden } from './netz-regeln.js';
import type { SkillMetadata, SkillContext, SkillResult, UniFiConfig } from '@alfred/types';
import { Skill } from '../skill.js';
import { alsAlarm, istInfraEreignis, istWarnung, nachSchwere, type SystemLogEintrag } from './unifi-systemlog.js'; // v1381
import { tlsFetch } from './social/tls-fetch.js';
import { randomUUID } from 'node:crypto';
import { baueRegel, neueReihenfolge, policyZeile, type Netz, type Policy, type Reihenfolge, type Zone, type RegelWunsch } from './unifi-policies.js'; // v1386 // v1385 — Zertifikatsprüfung request-lokal statt prozessweit

type ControllerMode = 'unifi-os' | 'classic';

export class UniFiSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'unifi',
    category: 'infrastructure',
    description:
      'Manage UniFi network devices, clients, and WLANs. ' +
      'Use "list_devices" to see APs/switches, "list_clients" for connected clients, ' +
      '"restart_device" to reboot a device, "block_client"/"unblock_client" for access control. ' +
      'Firewall (Zonen-Modell, UniFi Network 9+): "list_firewall_policies" (mit source_zone+destination_zone = Auswertungsreihenfolge), "create_firewall_policy" (Ausnahmen mit before_policy VOR die Sperre setzen), "set_firewall_policy_enabled", "delete_firewall_policy" — Änderungen nur nach Owner-Bestätigung.',
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
            'next_free_ip',
            'list_firewall_rules',
            'create_firewall_rule',
            'list_firewall_policies',
            'create_firewall_policy',
            'set_firewall_policy_enabled',
            'delete_firewall_policy',
            'create_network',
            'delete_network',
            'create_zone',
            'delete_zone',
            'export_config',
            'trunk_path',
            'allow_network_on_port',
            'exclude_network_on_port',
            'list_dns_records',
            'create_dns_record',
            'delete_dns_record',
          ],
          description: 'The UniFi action to perform. Netz-Aktionen (Owner 22.10.): create_network (network_name, vlan, subnet, dhcp, dhcp_start, dhcp_stop) / delete_network (network_name) — Rückweg zueinander; lokales DNS: list_dns_records, create_dns_record (hostname, ip, record_type A|AAAA|CNAME) / delete_dns_record (hostname).',
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
          description: 'Maximum number of items to return (for list_alerts, default 200, max 1000)',
        },
        filter: {
          type: 'string',
          description: 'v845 — client-side key/msg substring filter for list_alerts (e.g. "EVT_IPS_IpsAlert" or "IPS"). Optional. UniFi server-side filtering is not supported.',
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
        network_name: {
          type: 'string',
          description: 'Netzwerk/VLAN Name für next_free_ip, create_network, delete_network (z.B. "Default", "Keller", "VLAN 10")',
        },
        vlan: { type: 'number', description: 'create_network: VLAN-ID 2–4094' },
        subnet: { type: 'string', description: 'create_network: Subnetz, z. B. 10.203.21.0/28 (Gateway = erste Adresse)' },
        dhcp: { type: 'boolean', description: 'create_network: DHCP an (Standard true)' },
        dhcp_start: { type: 'string', description: 'create_network: erste DHCP-Adresse (optional)' },
        dhcp_stop: { type: 'string', description: 'create_network: letzte DHCP-Adresse (optional)' },
        hostname: { type: 'string', description: 'create_dns_record/delete_dns_record: Name, z. B. matrix.home.arpa' },
        ip: { type: 'string', description: 'create_dns_record: Ziel (IP bzw. Name bei CNAME)' },
        record_type: { type: 'string', enum: ['A', 'AAAA', 'CNAME'], description: 'create_dns_record: Standard A' },
        start_ip: {
          type: 'number',
          description: 'Ab welcher Host-Nummer suchen (für next_free_ip, default: 10)',
        },
        rule_name: {
          type: 'string',
          description: 'Name/Beschreibung der Firewall-Regel (für create_firewall_rule)',
        },
        source: {
          type: 'string',
          description: 'Quell-IP/Netzwerk für Firewall-Regel',
        },
        destination: {
          type: 'string',
          description: 'Ziel-IP/Netzwerk für Firewall-Regel',
        },
        port: {
          type: 'string',
          description: 'Port für Firewall-Regel',
        },
        protocol: {
          type: 'string',
          description: 'Protokoll: tcp, udp, any (default: tcp)',
        },
        rule_action: {
          type: 'string',
          description: 'accept oder drop (default: accept)',
        },
        // v1386 — Zonen-Firewall (UniFi Network 9+): Policies statt Regeln
        policy_name: { type: 'string', description: 'Name der Policy (create_firewall_policy) bzw. Suchtext (list_firewall_policies)' },
        policy_action: { type: 'string', description: 'ALLOW, BLOCK oder REJECT (create_firewall_policy)' },
        source_zone: { type: 'string', description: 'Quellzone (Internal, External, Gateway, Vpn, Dmz, Hotspot …); entfällt, wenn source_network genannt ist' },
        source_network: { type: 'string', description: 'Quellnetz: Name, ID oder VLAN-Nummer (z. B. DeviceLAN oder 817)' },
        source_port: { type: 'string', description: 'Quellport(s): 5353, 80,443 oder 8000-8100' },
        destination_zone: { type: 'string', description: 'Zielzone (Gateway = die UDM selbst, External = Internet, Internal …)' },
        destination_network: { type: 'string', description: 'Zielnetz: Name, ID oder VLAN-Nummer' },
        destination_port: { type: 'string', description: 'Zielport(s)' },
        policy_protocol: { type: 'string', description: 'TCP, UDP, TCP_UDP, ICMP oder alle (Ports brauchen TCP/UDP)' },
        source_ip: { type: 'string', description: 'Quell-Adressen statt Quellnetz: IP, Subnetz (CIDR) oder Bereich a-b, kommagetrennt (z. B. 192.168.1.92) — Zone dann mit source_zone angeben' },
        destination_ip: { type: 'string', description: 'Ziel-Adressen statt Zielnetz: IP, Subnetz (CIDR) oder Bereich a-b, kommagetrennt' },
        allow_return_traffic: { type: 'boolean', description: 'create_firewall_policy ALLOW: Antworten ausdrücklich zulassen (in Changes immer true)' },
        zone_name: { type: 'string', description: 'create_zone/delete_zone: Name der eigenen Firewall-Zone (z. B. Docker-Dev)' },
        client_ip: { type: 'string', description: 'trunk_path: IP eines Geräts im Netz (z. B. des Proxmox-Knotens), von dessen Switch-Port bis zur UDM' },
        client_mac: { type: 'string', description: 'trunk_path: MAC statt IP' },
        device: { type: 'string', description: 'allow_/exclude_network_on_port: Switch (Name oder MAC)' },
        switch_port: { type: 'number', description: 'allow_/exclude_network_on_port: Port-Nummer am Switch' },
        networks: { type: 'array', items: { type: 'string' }, description: 'create_zone: Netze (Name oder VLAN), die in die Zone wandern' },
        before_policy: { type: 'string', description: 'Name oder ID der Policy, VOR die die neue gesetzt wird (z. B. eine Sperre, für die eine Ausnahme gilt) — sonst hängt sie hinten an und greift ggf. nie' },
        policy_id: { type: 'string', description: 'ID der Policy (set_firewall_policy_enabled, delete_firewall_policy)' },
        freigabe: { type: 'string', description: 'Nur intern: Einmal-Freigabe nach Owner-Bestätigung — nie selbst setzen' },
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
          return await this.listAlerts(input.limit as number | undefined, input.filter as string | undefined);
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

        // ── INFRA ─────────────────────────────────────────────
        case 'next_free_ip':
          return await this.nextFreeIp(input.network_name as string | undefined, input.start_ip as number | undefined);
        case 'list_firewall_rules':
          if (await this.hatZonenFirewall()) return await this.listFirewallPolicies(input); // v1386 — altes Modell ist leer
          return await this.listFirewallRules();
        case 'create_firewall_rule':
          // v1386 — auf der Zonen-Firewall wäre eine Regel im alten Modell wirkungslos
          if (await this.hatZonenFirewall()) return { success: false, error: 'Diese UniFi-Firewall arbeitet mit Zonen-Policies — create_firewall_rule wirkt hier nicht. create_firewall_policy verwenden (policy_name, policy_action, source_network/source_zone, destination_zone/destination_network, Ports, Protokoll, before_policy).' };
          return await this.createFirewallRule(input);
        case 'list_firewall_policies':
          return await this.listFirewallPolicies(input);
        case 'create_firewall_policy':
        case 'set_firewall_policy_enabled':
        case 'delete_firewall_policy':
          return await this.firewallAenderung(action, input, _context?.ausChange === true);
        case 'create_zone':
        case 'delete_zone':
          if (_context?.ausChange !== true) return { success: false, error: `${action} läuft nur als Schritt eines freigegebenen Changes` };
          return action === 'create_zone' ? await this.zoneAnlegen(input) : await this.zoneLoeschen(input);
        case 'export_config':
          return await this.konfigSichern();
        case 'trunk_path':
          return await this.trunkPfad(input);
        case 'allow_network_on_port':
        case 'exclude_network_on_port':
          if (_context?.ausChange !== true) return { success: false, error: `${action} läuft nur als Schritt eines freigegebenen Changes` };
          return await this.portNetz(input, action === 'allow_network_on_port');

        case 'create_network':
          return await this.netzAnlegen(input);
        case 'delete_network':
          return await this.netzLoeschen(input);
        case 'list_dns_records':
          return await this.dnsListe();
        case 'create_dns_record':
          return await this.dnsAnlegen(input);
        case 'delete_dns_record':
          return await this.dnsLoeschen(input);

        default:
          return { success: false, error: `Unknown action: ${action}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `UniFi error: ${msg}` };
    }
  }

  // ── v1386 Zonen-Firewall (Integration-API v1) ─────────────────

  /** Bestätigung beim Owner einreihen; die Queue ruft den Skill nach dem Ja mit `freigabe` erneut auf. */
  private bestaetigung?: (o: { beschreibung: string; params: Record<string, unknown> }) => Promise<boolean>;
  setBestaetigung(fn: (o: { beschreibung: string; params: Record<string, unknown> }) => Promise<boolean>): void { this.bestaetigung = fn; }
  /** Einmal-Freigaben: zufällige Kennung je Bestätigung, verbraucht beim Ausführen, 2 h gültig. Ein Modell kann sie nicht erraten. */
  private readonly freigaben = new Map<string, { schluessel: string; bis: number }>();
  private integSite?: string;

  private async integ<T = unknown>(method: string, pfad: string, body?: unknown): Promise<T> {
    if (!this.config.apiKey) throw new Error('Firewall-Policies brauchen den UniFi-API-Schlüssel (Integration-API)');
    const base = `${this.config.baseUrl.replace(/\/+$/, '')}/proxy/network/integration/v1`;
    const res = await this.rawFetch(`${base}${pfad}`, {
      method, headers: { 'X-API-Key': this.config.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 300);
      try { const j = JSON.parse(text) as { message?: string; code?: string }; msg = `${j.code ?? ''} ${j.message ?? ''}`.trim() || msg; } catch { /* Rohtext */ }
      throw new Error(`UniFi ${method} ${pfad.split('?')[0]}: HTTP ${res.status} ${msg}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  private async siteId(): Promise<string> {
    if (this.integSite) return this.integSite;
    const r = await this.integ<{ data: Array<{ id: string; internalReference?: string }> }>('GET', '/sites?limit=50');
    const s = r.data.find(x => x.internalReference === this.site) ?? r.data[0];
    if (!s) throw new Error('keine UniFi-Site im Integration-API');
    this.integSite = s.id;
    return s.id;
  }

  private async liste<T>(pfad: string): Promise<T[]> {
    const sid = await this.siteId();
    const aus: T[] = [];
    for (let offset = 0; offset < 5000; offset += 200) {
      const r = await this.integ<{ data: T[]; totalCount?: number }>('GET', `/sites/${sid}${pfad}${pfad.includes('?') ? '&' : '?'}limit=200&offset=${offset}`);
      aus.push(...r.data);
      if (r.data.length < 200 || (r.totalCount !== undefined && aus.length >= r.totalCount)) break;
    }
    return aus;
  }

  private zonenFirewall?: boolean;
  private async hatZonenFirewall(): Promise<boolean> {
    if (this.zonenFirewall !== undefined) return this.zonenFirewall;
    if (!this.config.apiKey) return (this.zonenFirewall = false);
    try { this.zonenFirewall = (await this.liste<Zone>('/firewall/zones')).length > 0; } catch { this.zonenFirewall = false; }
    return this.zonenFirewall;
  }

  private async firewallStand(): Promise<{ sid: string; zonen: Zone[]; netze: Netz[]; policies: Policy[] }> {
    const sid = await this.siteId();
    const [zonen, netze, policies] = await Promise.all([this.liste<Zone>('/firewall/zones'), this.liste<Netz>('/networks'), this.liste<Policy>('/firewall/policies')]);
    return { sid, zonen, netze, policies };
  }

  private async reihenfolge(sid: string, quelle: string, ziel: string): Promise<Reihenfolge> {
    const r = await this.integ<{ orderedFirewallPolicyIds?: Reihenfolge } & Partial<Reihenfolge>>('GET', `/sites/${sid}/firewall/policies/ordering?sourceFirewallZoneId=${quelle}&destinationFirewallZoneId=${ziel}`);
    const o = r.orderedFirewallPolicyIds ?? (r as Reihenfolge);
    return { beforeSystemDefined: o.beforeSystemDefined ?? [], afterSystemDefined: o.afterSystemDefined ?? [] };
  }

  private async listFirewallPolicies(input: Record<string, unknown>): Promise<SkillResult> {
    const { sid, zonen, netze, policies } = await this.firewallStand();
    const such = String(input.policy_name ?? '').trim().toLowerCase();
    const qz = input.source_zone ? zonen.find(z => z.name.toLowerCase() === String(input.source_zone).toLowerCase()) : undefined;
    const zz = input.destination_zone ? zonen.find(z => z.name.toLowerCase() === String(input.destination_zone).toLowerCase()) : undefined;
    if (qz && zz) {
      // ein Zonenpaar: eigene Policies in Auswertungsreihenfolge (erste passende gewinnt)
      const r = await this.reihenfolge(sid, qz.id, zz.id);
      const zeile = (id: string, i: number) => { const p = policies.find(x => x.id === id); return p ? policyZeile(p, zonen, netze, i + 1) : `${i + 1}. ${id}`; };
      const vor = r.beforeSystemDefined.map(zeile); const nach = r.afterSystemDefined.map((id, i) => zeile(id, i + r.beforeSystemDefined.length));
      return { success: true, data: { reihenfolge: r }, display: `Eigene Policies ${qz.name} → ${zz.name} in Auswertungsreihenfolge (erste passende gewinnt):\n${vor.join('\n') || '(keine)'}\n— Systemregeln —\n${nach.join('\n') || '(keine)'}` };
    }
    const treffer = policies.filter(p => p.metadata?.origin !== 'SYSTEM_DEFINED' || input.system === true)
      .filter(p => !such || p.name.toLowerCase().includes(such))
      .filter(p => (!qz || p.source.zoneId === qz.id) && (!zz || p.destination.zoneId === zz.id));
    const zeilen = treffer.slice(0, 80).map(p => policyZeile(p, zonen, netze));
    return { success: true, data: { anzahl: treffer.length, gesamt: policies.length }, display: `${treffer.length} eigene Policies${such ? ` mit „${such}"` : ''}${treffer.length > 80 ? ' (erste 80)' : ''}:\n${zeilen.join('\n')}` };
  }

  /** Schreibende Firewall-Aktionen: ohne gültige Einmal-Freigabe nur Prüfung + Bestätigung beim Owner. */
  private async firewallAenderung(action: string, input: Record<string, unknown>, ausChange = false): Promise<SkillResult> {
    const { sid, zonen, netze, policies } = await this.firewallStand();
    const findePolicy = (x: unknown) => { const t = String(x ?? '').trim(); const l = policies.filter(p => p.id === t || p.name.toLowerCase() === t.toLowerCase()); if (l.length > 1) throw new Error(`„${t}" ist nicht eindeutig (${l.length} Policies) — ID angeben`); return l[0]; };
    // Vorbereitung (deterministisch, ohne Änderung): Body bauen bzw. Ziel finden, Beschreibung für die Bestätigung
    let beschreibung: string; let schluessel: string;
    let body: Record<string, unknown> | undefined; let vor: Policy | undefined; let ziel: Policy | undefined;
    if (action === 'create_firewall_policy') {
      const w: RegelWunsch = {
        name: String(input.policy_name ?? ''), aktion: String(input.policy_action ?? '').toUpperCase() as RegelWunsch['aktion'],
        quelleZone: input.source_zone as string | undefined, quelleNetz: input.source_network as string | undefined, quellePort: input.source_port !== undefined ? String(input.source_port) : undefined,
        zielZone: input.destination_zone as string | undefined, zielNetz: input.destination_network as string | undefined, zielPort: input.destination_port !== undefined ? String(input.destination_port) : undefined,
        protokoll: input.policy_protocol as string | undefined,
        ...(typeof input.source_ip === 'string' && input.source_ip.trim() ? { quelleIps: input.source_ip } : {}),
        ...(input.allow_return_traffic === true || String(input.allow_return_traffic) === 'true' ? { rueckverkehr: true } : {}),
        ...(typeof input.destination_ip === 'string' && input.destination_ip.trim() ? { zielIps: input.destination_ip } : {}),
      };
      body = baueRegel(w, zonen, netze);
      if (input.before_policy) {
        vor = findePolicy(input.before_policy);
        if (!vor) throw new Error(`Policy „${String(input.before_policy)}" nicht gefunden`);
        const b = body as { source: { zoneId: string }; destination: { zoneId: string } };
        if (vor.source.zoneId !== b.source.zoneId || vor.destination.zoneId !== b.destination.zoneId) throw new Error(`„${vor.name}" liegt in einem anderen Zonenpaar — Reihenfolge gilt nur innerhalb eines Zonenpaars`);
      }
      if (policies.some(p => p.name.toLowerCase() === w.name.trim().toLowerCase())) throw new Error(`Es gibt schon eine Policy „${w.name.trim()}" — anderen Namen wählen`);
      // Realfall 22.10. (docker-dev-01 per SSH unerreichbar): eine eigene BLOCK-Regel steht vor den von der UDM abgeleiteten
      // Rückverkehr-Regeln (Index 30000) und verwirft damit auch die Antworten erlaubter Verbindungen der Gegenrichtung. Sperrt die UDM
      // das Zonenpaar ohnehin (System-Standard BLOCK), ist eine eigene Sperre ohne Filter überflüssig und schädlich.
      const bb = body as { action: { type: string }; source: { zoneId: string; trafficFilter?: unknown }; destination: { zoneId: string; trafficFilter?: unknown } };
      if (bb.action.type !== 'ALLOW' && !bb.source.trafficFilter && !bb.destination.trafficFilter) {
        const standard = policies.filter(p => p.metadata?.origin === 'SYSTEM_DEFINED' && p.source.zoneId === bb.source.zoneId && p.destination.zoneId === bb.destination.zoneId && !(p as { connectionStateFilter?: unknown }).connectionStateFilter).sort((a, b) => (b.index ?? 0) - (a.index ?? 0))[0];
        if (standard && standard.action.type !== 'ALLOW') throw new Error(`Das Zonenpaar sperrt die UDM bereits selbst („${standard.name}") — eine eigene Sperre ohne Filter würde nur die Antworten erlaubter Verbindungen verwerfen. Nicht anlegen.`);
      }
      const vorschau = policyZeile({ id: 'neu', enabled: true, ...(body as Omit<Policy, 'id' | 'enabled'>), name: w.name.trim() } as Policy, zonen, netze).replace(/ · neu$/, '');
      beschreibung = `Firewall-Policy anlegen: ${vorschau}${vor ? `, eingereiht VOR „${vor.name}"` : ', hinten im Zonenpaar'}`;
      schluessel = JSON.stringify(['create', body, vor?.id ?? null]);
    } else {
      ziel = findePolicy(input.policy_id ?? input.policy_name);
      if (!ziel) throw new Error('Policy nicht gefunden (policy_id oder exakter policy_name)');
      if (ziel.metadata?.origin === 'SYSTEM_DEFINED' || ziel.metadata?.origin === 'DERIVED') throw new Error('System- und abgeleitete Regeln (aus UniFi-Objekten) werden nicht verändert');
      if (action === 'set_firewall_policy_enabled') {
        const an = input.enabled === true || String(input.enabled).toLowerCase() === 'true';
        beschreibung = `Firewall-Policy ${an ? 'EINSCHALTEN' : 'AUSSCHALTEN'}: ${policyZeile(ziel, zonen, netze)}`;
        schluessel = JSON.stringify(['enabled', ziel.id, an]);
      } else {
        beschreibung = `Firewall-Policy LÖSCHEN: ${policyZeile(ziel, zonen, netze)}`;
        schluessel = JSON.stringify(['delete', ziel.id]);
      }
    }

    const nonce = typeof input.freigabe === 'string' ? input.freigabe : undefined;
    const fg = nonce ? this.freigaben.get(nonce) : undefined;
    // Pilot cf82f3f2 (22.10.): im freigegebenen Change ersetzt dessen Freigabe die Einzelbestätigung (sonst fragte der Schritt nur und meldete Erfolg)
    if (!ausChange && (!fg || fg.bis < Date.now() || fg.schluessel !== schluessel)) {
      if (nonce) this.freigaben.delete(nonce);
      if (!this.bestaetigung) return { success: false, error: 'Firewall-Änderungen brauchen eine Owner-Bestätigung, die hier nicht verfügbar ist' };
      const neu = randomUUID();
      this.freigaben.set(neu, { schluessel, bis: Date.now() + 2 * 3_600_000 });
      const params = { ...Object.fromEntries(Object.entries(input).filter(([k]) => k !== 'freigabe')), action, freigabe: neu };
      const ok = await this.bestaetigung({ beschreibung, params });
      return ok
        ? { success: true, data: { zurBestaetigung: true }, display: `Zur Bestätigung an den Owner: ${beschreibung}. Nach dem Ja wird die Änderung ausgeführt und die Reihenfolge geprüft.` }
        : { success: false, error: 'Bestätigung konnte nicht eingereiht werden' };
    }
    if (nonce) this.freigaben.delete(nonce);

    if (action === 'create_firewall_policy') {
      let neu: Policy;
      let ohneRueckverkehr = false;
      try {
        neu = await this.integ<Policy>('POST', `/sites/${sid}/firewall/policies`, body);
      } catch (err) {
        const b = body as { action?: { allowReturnTraffic?: boolean } };
        if (!/cant-allow-return-traffic/.test((err as Error).message) || !b.action?.allowReturnTraffic) throw err;
        b.action.allowReturnTraffic = false; ohneRueckverkehr = true;
        neu = await this.integ<Policy>('POST', `/sites/${sid}/firewall/policies`, body);
      }
      let reihenText = 'hinten im Zonenpaar';
      if (vor) {
        const r = await this.reihenfolge(sid, neu.source.zoneId, neu.destination.zoneId);
        await this.integ('PUT', `/sites/${sid}/firewall/policies/ordering?sourceFirewallZoneId=${neu.source.zoneId}&destinationFirewallZoneId=${neu.destination.zoneId}`, { orderedFirewallPolicyIds: neueReihenfolge(r, neu.id, vor.id) });
        // zurücklesen: steht die neue Policy wirklich vor der genannten?
        const pruef = await this.reihenfolge(sid, neu.source.zoneId, neu.destination.zoneId);
        const alle = [...pruef.beforeSystemDefined, ...pruef.afterSystemDefined];
        const iNeu = alle.indexOf(neu.id); const iVor = alle.indexOf(vor.id);
        if (iNeu < 0 || iVor < 0 || iNeu > iVor) return { success: false, data: { id: neu.id }, error: `Policy ${neu.id} angelegt, aber die Reihenfolge stimmt nicht (Position ${iNeu + 1}, „${vor.name}" an ${iVor + 1}) — bitte prüfen` };
        reihenText = `Position ${iNeu + 1}, direkt vor „${vor.name}" (zurückgelesen)`;
      }
      return { success: true, data: { id: neu.id, name: neu.name }, display: `✅ Firewall-Policy angelegt: ${policyZeile(neu, zonen, netze)} — ${reihenText}${ohneRueckverkehr ? ' (Rückverkehr-Option hier nicht zulässig — ohne angelegt)' : ''}. Rückgängig: delete_firewall_policy ${neu.id}` };
    }
    if (action === 'set_firewall_policy_enabled') {
      const an = JSON.parse(schluessel)[2] as boolean;
      await this.integ('PATCH', `/sites/${sid}/firewall/policies/${ziel!.id}`, { enabled: an });
      return { success: true, data: { id: ziel!.id, enabled: an }, display: `✅ Policy „${ziel!.name}" ${an ? 'eingeschaltet' : 'ausgeschaltet'}` };
    }
    await this.integ('DELETE', `/sites/${sid}/firewall/policies/${ziel!.id}`);
    return { success: true, data: { id: ziel!.id }, display: `✅ Policy „${ziel!.name}" gelöscht` };
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
    return await tlsFetch(url, init, skipTls);
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

  /**
   * v845 — Endpoint-Migration von `stat/alarm` → `list/alarm`.
   *
   * Hintergrund: UniFi Network Application hat in einer der letzten Versionen
   * (Network App >= 8.x) die Alarm-API umgestellt. `stat/alarm` liefert jetzt
   * `HTTP 404 api.err.NotFound`, der korrekte Endpoint ist `list/alarm`.
   * Empirisch verifiziert gegen 192.168.1.1 — `list/alarm` liefert ~2400+
   * Alarms inkl. IPS-Events.
   *
   * `filter` ist eine client-side key-substring-Suche (z.B. "EVT_IPS_IpsAlert"
   * oder "IPS"), weil der `?key=...` Query-Param vom Controller akzeptiert
   * aber ignoriert wird (verifiziert).
   */
  /**
   * v1381 — System-Log der v2-API (UniFi OS). `art` = all | critical; Rückgabe die Einträge (Seite 0).
   */
  private async systemLog(art: 'all' | 'critical', vonMs: number, groesse: number): Promise<SystemLogEintrag[]> {
    await this.ensureAuth();
    const base = this.config.baseUrl.replace(/\/+$/, '');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) headers['X-API-Key'] = this.config.apiKey;
    else { if (this.cookies.length > 0) headers['Cookie'] = this.cookies.join('; '); if (this.csrfToken) headers['X-CSRF-Token'] = this.csrfToken; }
    const jetzt = Date.now();
    const res = await this.rawFetch(`${base}/proxy/network/v2/api/site/${this.site}/system-log/${art}`, {
      method: 'POST', headers, signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ timestampFrom: jetzt - vonMs, timestampTo: jetzt, pageNumber: 0, pageSize: groesse }),
    });
    if (!res.ok) throw new Error(`UniFi System-Log HTTP ${res.status}`);
    const j = (await res.json()) as { data?: SystemLogEintrag[] } | SystemLogEintrag[];
    return Array.isArray(j) ? j : (j.data ?? []);
  }

  private async listAlerts(limit?: number, filter?: string): Promise<SkillResult> {
    // v845 — Default-Limit 20→200, Cap 200→1000. Für Backlog-Triage müssen
    // wir mehr als die letzten 20 Items sehen.
    const n = Math.min(Math.max(1, limit ?? 200), 1000);
    // v1381 — UniFi OS: `list/alarm` antwortet mit HTTP 400 (Network 8.x/9.x). Warnungen kommen aus dem System-Log:
    // kritische der letzten 14 Tage plus alles außer Routine (LOW) der letzten 24 h; Format wie bisher.
    await this.ensureAuth();
    const alerts: any[] = this.controllerMode === 'unifi-os'
      ? nachSchwere([...await this.systemLog('critical', 14 * 86_400_000, 200), ...(await this.systemLog('all', 86_400_000, 1000)).filter(istWarnung)]).map(alsAlarm).slice(0, n)
      : await this.request<any[]>('GET', `list/alarm?_limit=${n}`);

    let filtered = alerts ?? [];
    if (filter && filter.length > 0) {
      // Tolerantes Match: `EVT_IPS_IpsAlert`, `IPS`, oder
      // `event_type:EVT_IPS_IpsAlert` (das letzte Format kam aus
      // Reasoning-Engine watches → key extrahieren)
      const needle = filter.replace(/^[a-z_]+:/i, '').toLowerCase();
      filtered = filtered.filter((a) => {
        const key = String(a.key ?? '').toLowerCase();
        const msg = String(a.msg ?? '').toLowerCase();
        return key.includes(needle) || msg.includes(needle);
      });
    }

    // count-by-key stats — bei großem Backlog dem Caller einen Überblick geben
    const countsByKey: Record<string, number> = {};
    for (const a of filtered) {
      const k = String(a.key ?? 'unknown');
      countsByKey[k] = (countsByKey[k] ?? 0) + 1;
    }

    const rows = filtered.map((a) => ({
      time: a.datetime ?? a.time ?? '-',
      type: a.msg && a.key ? `${a.key}: ${String(a.msg).slice(0, 120)}` : (a.key ?? a.msg ?? '-'), // v1381 Text aus dem System-Log
      device: a.device_name ?? a.ap_name ?? a.mac ?? a.src_ip ?? '-',
      archived: a.archived ? 'yes' : 'no',
    }));

    const totalRaw = (alerts ?? []).length;
    const totalFiltered = filtered.length;
    const summary = filter
      ? `${totalFiltered} of ${totalRaw} alerts match filter "${filter}".`
      : `${totalRaw} alerts.`;
    const topKeys = Object.entries(countsByKey)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([k, c]) => `${k}: ${c}`)
      .join(', ');

    const table = rows.length === 0
      ? `No alerts${filter ? ` matching "${filter}"` : ''}.`
      : [
          summary,
          topKeys ? `Top keys: ${topKeys}` : '',
          '',
          '| Time | Type | Device | Archived |',
          '|------|------|--------|----------|',
          ...rows.slice(0, 50).map((r) => `| ${r.time} | ${r.type} | ${r.device} | ${r.archived} |`),
          rows.length > 50 ? `\n_(showing first 50 of ${rows.length})_` : '',
        ].filter(Boolean).join('\n');

    return {
      success: true,
      data: { alerts: filtered, count: totalFiltered, total: totalRaw, countsByKey },
      display: table,
    };
  }

  /**
   * v845 — `stat/event` ist seit UniFi Network App 8.x ebenfalls 404.
   * Der ersatzweise `list/event`-Endpoint braucht POST mit spezifischem
   * Filter-Body (Schema noch nicht reverse-engineered). Bis dahin geben
   * wir einen klaren Hinweis statt eines silent fail, damit Watches/
   * Reasoning nicht endlos retried.
   */
  private async listEvents(limit?: number): Promise<SkillResult> {
    // v1381 — UniFi OS: Ereignisse = System-Log (v2), neueste zuerst
    await this.ensureAuth();
    if (this.controllerMode === 'unifi-os') {
      const n = Math.min(Math.max(1, limit ?? 50), 500);
      // ohne Client-Verbindungen und Firewall-Blocks (≈ 1 000/Tag), sonst sieht man nur Roaming
      const ev = (await this.systemLog('all', 7 * 86_400_000, 3000)).filter(istInfraEreignis).slice(0, n).map(alsAlarm);
      const zeilen = ev.map(a => `| ${a.datetime} | ${a.severity} | ${a.key} | ${a.msg.slice(0, 140)} |`);
      return { success: true, data: { events: ev, count: ev.length }, display: ev.length ? ['| Zeit | Schwere | Art | Text |', '|---|---|---|---|', ...zeilen].join('\n') : 'Keine Ereignisse.' };
    }
    return {
      success: false,
      error:
        'list_events ist in der aktuellen UniFi-Version (Network App 8.x) ' +
        'nicht unterstützt. Nutze stattdessen list_alerts (zeigt Alarms ' +
        'inklusive IPS, GW, AP-Events) — optional mit filter="EVT_IPS_IpsAlert" ' +
        'für IPS-only.',
    };
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

  /**
   * v845 — Endpoint-Migration von `POST cmd/evtmgr {cmd:'archive-all-alarms'}`
   * → `POST list/alarm/archive {}`. Erstes liefert HTTP 404 seit Network App
   * 8.x (verifiziert), letzteres 200. Body bleibt leer.
   */
  private async archiveAlerts(): Promise<SkillResult> {
    await this.request('POST', 'list/alarm/archive', {});
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

  // ── Netze und lokales DNS (Owner 22.10.: Alfred legt VLANs selbst an) ──

  private async netzAnlegen(input: Record<string, unknown>): Promise<SkillResult> {
    const neu = { name: String(input.network_name ?? '').trim(), vlan: Number(input.vlan), subnet: String(input.subnet ?? '').trim(), dhcp: input.dhcp !== false, ...(typeof input.dhcp_start === 'string' ? { dhcpStart: input.dhcp_start } : {}), ...(typeof input.dhcp_stop === 'string' ? { dhcpStop: input.dhcp_stop } : {}) };
    const roh = (await this.request<any[]>('GET', 'rest/networkconf')) ?? [];
    // wiederholbar: ein Netz mit genau diesem Namen, VLAN, Subnetz und DHCP-Stand gilt als vorhanden
    const gleiches = roh.find(n => String(n.name ?? '').toLowerCase() === neu.name.toLowerCase());
    if (gleiches && Number(gleiches.vlan) === neu.vlan && /^[\d.]+\/\d+$/.test(neu.subnet) && gleiches.ip_subnet === netzWerte(neu).ipSubnet && !!gleiches.dhcpd_enabled === neu.dhcp) {
      const w0 = netzWerte(neu);
      return { success: true, data: { id: gleiches._id, name: gleiches.name, vlan: neu.vlan, gateway: w0.gateway, ip_subnet: w0.ipSubnet, vorhanden: true }, display: `Netz „${gleiches.name}“ ist bereits genau so vorhanden (VLAN ${neu.vlan}, ${w0.ipSubnet}) — übernommen` };
    }
    const vorhanden = roh.map((n): NetzVorhanden => ({ name: String(n.name ?? ''), vlan: n.vlan, subnet: n.ip_subnet, purpose: n.purpose }));
    const f = neuesNetzFehler(neu, vorhanden);
    if (f.length) return { success: false, error: `Netz nicht angelegt: ${f.join('; ')}` };
    const w = netzWerte(neu);
    const body = { name: neu.name, purpose: 'corporate', networkgroup: 'LAN', vlan_enabled: true, vlan: neu.vlan, ip_subnet: w.ipSubnet, dhcpd_enabled: neu.dhcp, ...(neu.dhcp ? { dhcpd_start: w.dhcpStart, dhcpd_stop: w.dhcpStop } : {}), enabled: true };
    const r = await this.request<any[]>('POST', 'rest/networkconf', body);
    const id = Array.isArray(r) ? r[0]?._id : (r as { _id?: string } | undefined)?._id;
    return { success: true, data: { id, name: neu.name, vlan: neu.vlan, gateway: w.gateway, ip_subnet: w.ipSubnet, ...(neu.dhcp ? { dhcp_start: w.dhcpStart, dhcp_stop: w.dhcpStop } : {}) }, display: `✅ Netz „${neu.name}“ angelegt: VLAN ${neu.vlan}, Gateway ${w.ipSubnet}${neu.dhcp ? `, DHCP ${w.dhcpStart}–${w.dhcpStop}` : ', ohne DHCP'}` };
  }

  private async netzLoeschen(input: Record<string, unknown>): Promise<SkillResult> {
    const name = String(input.network_name ?? '').trim();
    const netze = (await this.request<any[]>('GET', 'rest/networkconf')) ?? [];
    const n = netze.find(x => String(x.name ?? '').toLowerCase() === name.toLowerCase());
    if (!n) return { success: false, error: `Netz „${name}“ nicht gefunden` };
    if (n.purpose === 'wan' || n.purpose === 'vpn-client' || String(n.name).toLowerCase() === 'default' || !n.vlan_enabled) return { success: false, error: `Netz „${n.name}“ wird nicht gelöscht (WAN, VPN, Default oder ohne VLAN)` };
    // nie ein Netz löschen, in dem noch Geräte sind
    const clients = (await this.request<any[]>('GET', 'stat/sta').catch(() => [])) ?? [];
    const drin = clients.filter(c => c.network_id === n._id || c.network === n.name);
    if (drin.length) return { success: false, error: `Im Netz „${n.name}“ sind noch ${drin.length} Geräte — nicht gelöscht` };
    await this.request('DELETE', `rest/networkconf/${n._id}`);
    return { success: true, data: { id: n._id, name: n.name, vlan: n.vlan }, display: `✅ Netz „${n.name}“ (VLAN ${n.vlan}) gelöscht` };
  }

  /** Pilot cf82f3f2 — eigene Firewall-Zone mit ihren Netzen: zwischen eigenen Zonen und den übrigen gilt, was die Policies erlauben */
  private async zoneAnlegen(input: Record<string, unknown>): Promise<SkillResult> {
    const name = String(input.zone_name ?? '').trim();
    if (!/^[\w .-]{2,40}$/.test(name)) return { success: false, error: 'zone_name: 2–40 Zeichen' };
    const { sid, zonen, netze } = await this.firewallStand();
    const da = zonen.find(z => z.name.toLowerCase() === name.toLowerCase()) as (Zone & { networkIds?: string[] }) | undefined;
    const wuensche = Array.isArray(input.networks) ? input.networks.map(String) : typeof input.networks === 'string' ? String(input.networks).split(',') : [];
    const ids: string[] = [];
    for (const w of wuensche.map(x => x.trim()).filter(Boolean)) {
      const n = netze.find(x => x.name.toLowerCase() === w.toLowerCase() || x.id === w || (x.vlanId !== undefined && String(x.vlanId) === w));
      if (!n) return { success: false, error: `Netz „${w}" unbekannt` };
      ids.push(n.id);
    }
    // wiederholbar (Realfall 22.10.: A lief bis zur Zone, der Rückweg blieb hängen): gleiche Zone mit denselben Netzen = vorhanden
    if (da) {
      const gleich = [...(da.networkIds ?? [])].sort().join(',') === [...ids].sort().join(',');
      if (!gleich) return { success: false, error: `Zone „${name}" gibt es schon mit anderen Netzen` };
      return { success: true, data: { id: da.id, name: da.name, networkIds: da.networkIds ?? [], vorhanden: true }, display: `Firewall-Zone „${da.name}" ist bereits genau so vorhanden (${ids.length} Netz(e)) — übernommen` };
    }
    const z = await this.integ<Zone & { networkIds?: string[] }>('POST', `/sites/${sid}/firewall/zones`, { name, networkIds: ids });
    return { success: true, data: { id: z.id, name: z.name, networkIds: z.networkIds ?? ids }, display: `✅ Firewall-Zone „${z.name}" angelegt (${ids.length} Netz(e)). Rückgängig: delete_zone ${z.name}` };
  }

  private async zoneLoeschen(input: Record<string, unknown>): Promise<SkillResult> {
    const name = String(input.zone_name ?? '').trim();
    const { sid, zonen, policies } = await this.firewallStand();
    const z = zonen.find(x => x.name.toLowerCase() === name.toLowerCase() || x.id === name) as (Zone & { metadata?: { origin?: string } }) | undefined;
    if (!z) return { success: true, data: { schonWeg: true }, display: `Zone „${name}" gibt es nicht (mehr)` };
    if (z.metadata?.origin !== 'USER_DEFINED') return { success: false, error: `„${z.name}" ist keine eigene Zone — wird nicht gelöscht` };
    // Realfall 22.10.: die UDM leitet aus Objekten (z. B. „xxx111“) Regeln je Zone ab (origin DERIVED) — die verschwinden mit der Zone
    const eigene = policies.filter(p => p.metadata?.origin === 'USER_DEFINED' && (p.source.zoneId === z.id || p.destination.zoneId === z.id));
    if (eigene.length) return { success: false, error: `Zone „${z.name}" hat noch ${eigene.length} eigene Policies (${eigene.slice(0, 5).map(p => p.name).join(', ')}) — zuerst entfernen` };
    await this.integ('DELETE', `/sites/${sid}/firewall/zones/${z.id}`);
    return { success: true, data: { id: z.id, name: z.name }, display: `✅ Firewall-Zone „${z.name}" gelöscht` };
  }

  /**
   * Pilot cf82f3f2 (Realfall 22.10.: VLAN 824 kam nicht bis zur UDM — Trunk-Ports der Kern-Switches führen nur ausgewählte VLANs).
   * Weg von einem Gerät (IP/MAC) über die Uplinks bis zur UDM, je Port: Modus (auto = alle VLANs, custom = ausgewählte, block_all) und ob
   * das Netz durchgelassen wird. Nur lesend.
   */
  private async trunkPfad(input: Record<string, unknown>): Promise<SkillResult> {
    const netzName = String(input.network_name ?? '').trim();
    const netze = (await this.request<any[]>('GET', 'rest/networkconf')) ?? [];
    // noch nicht angelegtes Netz: wie die UDM es behandelt — Ports mit ausgewählten VLANs (custom) schließen neue Netze aus
    const netz = netze.find(n => String(n.name ?? '').toLowerCase() === netzName.toLowerCase()) ?? { _id: '__neu__', name: netzName || 'neues Netz', vlan: 'neu' };
    const geraete = (await this.request<any[]>('GET', 'stat/device')) ?? [];
    const clients = (await this.request<any[]>('GET', 'stat/sta')) ?? [];
    const ip = String(input.client_ip ?? '').trim(); const mac = String(input.client_mac ?? '').trim().toLowerCase();
    const c = clients.find(x => (ip && x.ip === ip) || (mac && String(x.mac).toLowerCase() === mac));
    if (!c?.sw_mac || c.sw_port === undefined) return { success: false, error: `Gerät ${ip || mac} ist keinem Switch-Port zugeordnet` };
    const pfad: Array<{ geraet: string; mac: string; port: number; rolle: string; modus: string; durch: boolean }> = [];
    const stand = (d: any, portIdx: number, rolle: string) => {
      const ov = (d.port_overrides ?? []).find((o: any) => o.port_idx === portIdx) ?? {};
      const p = (d.port_table ?? []).find((x: any) => x.port_idx === portIdx) ?? {};
      const modus = String(ov.tagged_vlan_mgmt ?? p.tagged_vlan_mgmt ?? 'auto');
      const aus: string[] = ov.excluded_networkconf_ids ?? p.excluded_networkconf_ids ?? [];
      const nativ = ov.native_networkconf_id ?? p.native_networkconf_id;
      const durch = nativ === netz._id || modus === 'auto' || (modus === 'custom' && netz._id !== '__neu__' && !aus.includes(netz._id));
      pfad.push({ geraet: String(d.name ?? d.mac), mac: String(d.mac), port: portIdx, rolle, modus, durch });
    };
    let d = geraete.find(x => String(x.mac).toLowerCase() === String(c.sw_mac).toLowerCase());
    if (!d) return { success: false, error: `Switch ${c.sw_mac} ist kein UniFi-Gerät — Pfad nicht bestimmbar` };
    stand(d, Number(c.sw_port), 'Gerät');
    for (let i = 0; i < 8 && d && d.type !== 'udm' && d.type !== 'ugw' && d.uplink?.uplink_mac; i++) {
      stand(d, Number(d.uplink.port_idx), 'Uplink');
      const weiter = geraete.find(x => String(x.mac).toLowerCase() === String(d.uplink.uplink_mac).toLowerCase());
      if (!weiter) break;
      stand(weiter, Number(d.uplink.uplink_remote_port), 'Gegenstelle');
      d = weiter;
    }
    const zu = pfad.filter(x => !x.durch);
    return { success: true, data: { netz: netz.name, vlan: netz.vlan, pfad, gesperrt: zu }, display: [`Weg von ${ip || mac} bis zur UDM für ${netz.name} (VLAN ${netz.vlan}):`, ...pfad.map(x => `- ${x.geraet} Port ${x.port} (${x.rolle}): ${x.modus}${x.durch ? ' — durchgelassen' : ' — GESPERRT'}`), zu.length ? `${zu.length} Port(s) lassen das Netz nicht durch → allow_network_on_port je Port (device, switch_port, network_name).` : 'Alle Ports lassen das Netz durch.'].join('\n') };
  }

  /** Netz auf einem Trunk-Port (eigene Port-Einstellung, Modus custom) erlauben bzw. wieder ausschließen — nur im Change */
  private async portNetz(input: Record<string, unknown>, erlauben: boolean): Promise<SkillResult> {
    const netzName = String(input.network_name ?? '').trim();
    const netz = ((await this.request<any[]>('GET', 'rest/networkconf')) ?? []).find(n => String(n.name ?? '').toLowerCase() === netzName.toLowerCase());
    if (!netz) return { success: false, error: `Netz „${netzName}“ nicht gefunden` };
    const kennung = String(input.device ?? '').trim().toLowerCase(); const portIdx = Number(input.switch_port);
    const d = ((await this.request<any[]>('GET', 'stat/device')) ?? []).find(x => String(x.mac).toLowerCase() === kennung || String(x.name ?? '').toLowerCase() === kennung);
    if (!d || !Number.isInteger(portIdx)) return { success: false, error: 'device (Name oder MAC) und switch_port angeben' };
    const overrides: any[] = JSON.parse(JSON.stringify(d.port_overrides ?? []));
    const ov = overrides.find(o => o.port_idx === portIdx);
    if (!ov) return { success: false, error: `${d.name} Port ${portIdx} hat keine eigene Einstellung (Profil oder Standard) — nicht geändert` };
    const modus = String(ov.tagged_vlan_mgmt ?? 'auto');
    if (modus === 'block_all') return { success: false, error: `${d.name} Port ${portIdx} führt keine getaggten VLANs (block_all) — kein Trunk, nicht geändert` };
    if (modus !== 'custom') return { success: true, data: { geaendert: false, modus }, display: `${d.name} Port ${portIdx}: Modus ${modus} — ${netz.name} ist bereits durchgelassen` };
    const aus: string[] = ov.excluded_networkconf_ids ?? [];
    const drin = !aus.includes(netz._id);
    if (erlauben === drin) return { success: true, data: { geaendert: false }, display: `${d.name} Port ${portIdx}: ${netz.name} ist bereits ${erlauben ? 'erlaubt' : 'ausgeschlossen'}` };
    ov.excluded_networkconf_ids = erlauben ? aus.filter(x => x !== netz._id) : [...aus, netz._id];
    await this.request('PUT', `rest/device/${d._id}`, { port_overrides: overrides });
    // zurücklesen — die UDM wendet Port-Einstellungen mit Verzug an (Realfall 22.10.: sofortiges Lesen zeigte noch den alten Stand)
    let jetzt = !erlauben;
    for (let i = 0; i < 10 && jetzt !== erlauben; i++) {
      await new Promise(r => setTimeout(r, 3_000));
      const neu = ((await this.request<any[]>('GET', 'stat/device')) ?? []).find(x => x._id === d._id);
      const ov2 = (neu?.port_overrides ?? []).find((o: any) => o.port_idx === portIdx);
      jetzt = !(ov2?.excluded_networkconf_ids ?? []).includes(netz._id);
    }
    if (jetzt !== erlauben) return { success: false, error: `${d.name} Port ${portIdx}: Änderung nach 30 s nicht übernommen (zurückgelesen)` };
    return { success: true, data: { geaendert: true, device: d.name, port: portIdx, netz: netz.name }, display: `✅ ${d.name} Port ${portIdx}: ${netz.name} (VLAN ${netz.vlan}) ${erlauben ? 'erlaubt' : 'wieder ausgeschlossen'} (zurückgelesen)` };
  }

  /** Sicherung vor Netz-/Firewall-Änderungen: Netze (beide APIs), Zonen, Policies, Reihenfolgen als JSON-Datei am Alfred-Server */
  private async konfigSichern(): Promise<SkillResult> {
    const { sid, zonen, netze, policies } = await this.firewallStand();
    const netzconf = (await this.request<any[]>('GET', 'rest/networkconf').catch(() => [])) ?? [];
    const stand = { zeit: new Date().toISOString(), zonen, netze, netzconf, policies };
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { join, resolve } = await import('node:path');
    const ordner = resolve(process.cwd(), 'data', 'unifi-sicherungen');
    await mkdir(ordner, { recursive: true, mode: 0o700 });
    const datei = join(ordner, `unifi-${stand.zeit.replace(/[:.]/g, '-')}.json`);
    await writeFile(datei, JSON.stringify(stand, null, 1), { mode: 0o600 });
    return { success: true, data: { datei, zonen: zonen.length, netze: netze.length, policies: policies.length, site: sid }, display: `UniFi-Konfiguration gesichert: ${datei} (${netze.length} Netze, ${zonen.length} Zonen, ${policies.length} Policies)` };
  }

  /** Lokale DNS-Einträge (UniFi Network ≥ 8: v2-API static-dns) */
  private async v2(method: string, pfad: string, body?: unknown): Promise<unknown> {
    await this.ensureAuth();
    const base = this.config.baseUrl.replace(/\/+$/, '');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) headers['X-API-Key'] = this.config.apiKey;
    else { if (this.cookies.length > 0) headers['Cookie'] = this.cookies.join('; '); if (this.csrfToken) headers['X-CSRF-Token'] = this.csrfToken; }
    const res = await this.rawFetch(`${base}/proxy/network/v2/api/site/${this.site}/${pfad}`, { method, headers, signal: AbortSignal.timeout(20_000), ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    if (!res.ok) throw new Error(`UniFi v2 ${pfad} HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const t = await res.text();
    return t ? JSON.parse(t) : undefined;
  }

  private async dnsListe(): Promise<SkillResult> {
    const l = ((await this.v2('GET', 'static-dns')) as Array<{ _id: string; key: string; value: string; record_type: string; enabled: boolean }> | undefined) ?? [];
    return { success: true, data: l, display: l.length ? ['| Name | Typ | Ziel | aktiv |', '|---|---|---|---|', ...l.map(e => `| ${e.key} | ${e.record_type} | ${e.value} | ${e.enabled ? 'ja' : 'nein'} |`)].join('\n') : 'Keine lokalen DNS-Einträge.' };
  }

  private async dnsAnlegen(input: Record<string, unknown>): Promise<SkillResult> {
    const key = String(input.hostname ?? '').trim().toLowerCase(); const value = String(input.ip ?? '').trim();
    const typ = ['A', 'AAAA', 'CNAME'].includes(String(input.record_type)) ? String(input.record_type) : 'A';
    if (!HOSTNAME.test(key)) return { success: false, error: 'hostname ungültig' };
    if (typ === 'A' && ipZahl(value) === undefined) return { success: false, error: 'ip: IPv4-Adresse angeben' };
    if (typ === 'CNAME' && !HOSTNAME.test(value)) return { success: false, error: 'ip: Zielname angeben' };
    if (typ === 'AAAA' && !/^[0-9a-f:]+$/i.test(value)) return { success: false, error: 'ip: IPv6-Adresse angeben' };
    const l = ((await this.v2('GET', 'static-dns')) as Array<{ key: string }> | undefined) ?? [];
    if (l.some(e => e.key.toLowerCase() === key)) return { success: false, error: `DNS-Eintrag ${key} gibt es schon` };
    const r = await this.v2('POST', 'static-dns', { key, value, record_type: typ, enabled: true });
    return { success: true, data: { hostname: key, ip: value, record_type: typ, id: (r as { _id?: string } | undefined)?._id }, display: `✅ Lokaler DNS-Eintrag ${key} → ${value} (${typ})` };
  }

  private async dnsLoeschen(input: Record<string, unknown>): Promise<SkillResult> {
    const key = String(input.hostname ?? '').trim().toLowerCase();
    const l = ((await this.v2('GET', 'static-dns')) as Array<{ _id: string; key: string; value: string }> | undefined) ?? [];
    const e = l.find(x => x.key.toLowerCase() === key);
    if (!e) return { success: false, error: `DNS-Eintrag ${key} nicht gefunden` };
    await this.v2('DELETE', `static-dns/${e._id}`);
    return { success: true, data: { hostname: e.key, ip: e.value }, display: `✅ Lokaler DNS-Eintrag ${e.key} gelöscht` };
  }

  // ── Infra helpers ──────────────────────────────────────────────

  private async nextFreeIp(networkName?: string, startIp?: number): Promise<SkillResult> {
    // 1. Get all networks
    const networks = await this.request('GET', 'rest/networkconf') as Array<Record<string, unknown>>;

    // 2. Find the target network
    const target = networkName
      ? networks.find((n: any) =>
          n.name?.toLowerCase().includes(networkName.toLowerCase()) ||
          n.vlan?.toString() === networkName)
      : networks.find((n: any) => n.purpose === 'corporate' || n.name === 'Default');

    if (!target) {
      const available = networks.map((n: any) => `${n.name} (VLAN ${n.vlan ?? '-'})`).join(', ');
      return { success: false, error: `Netzwerk "${networkName ?? 'Default'}" nicht gefunden. Verfügbar: ${available}` };
    }

    const subnet = (target as any).ip_subnet as string; // e.g. "192.168.1.1/24"
    if (!subnet) return { success: false, error: `Netzwerk "${(target as any).name}" hat kein Subnetz konfiguriert` };

    // 3. Parse subnet (CIDR-aware — supports /16 to /30)
    const [gateway, cidrStr] = subnet.split('/');
    const cidr = parseInt(cidrStr, 10) || 24;
    const gwParts = gateway.split('.').map(Number);
    const gwInt = (gwParts[0] << 24) | (gwParts[1] << 16) | (gwParts[2] << 8) | gwParts[3];
    const mask = cidr === 0 ? 0 : (~0 << (32 - cidr)) >>> 0;
    const networkInt = (gwInt & mask) >>> 0;
    const broadcastInt = (networkInt | (~mask >>> 0)) >>> 0;
    const intToIp = (n: number) => `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;

    // 4. Get ALL known clients (active + wired + offline + DHCP reservations)
    const usedIps = new Set<string>();
    try {
      const allClients = await this.request('GET', 'rest/user') as Array<Record<string, unknown>>;
      for (const c of allClients) {
        const ip = (c.last_ip ?? c.ip ?? c.fixed_ip) as string | undefined;
        if (ip) usedIps.add(ip);
      }
    } catch { /* fallback to active only */ }
    try {
      const activeClients = await this.request('GET', 'stat/sta') as Array<Record<string, unknown>>;
      for (const c of activeClients) {
        const ip = c.ip as string | undefined;
        if (ip) usedIps.add(ip);
      }
    } catch { /* skip */ }
    usedIps.add(gateway);

    // 5. Find first free IP in subnet
    const start = startIp ?? 10;
    const firstHost = networkInt + start;
    const lastHost = broadcastInt - 1; // exclude broadcast
    for (let ipInt = firstHost; ipInt <= lastHost; ipInt++) {
      const candidate = intToIp(ipInt);
      if (!usedIps.has(candidate)) {
        return {
          success: true,
          data: {
            ip: candidate,
            network: (target as any).name,
            vlan: (target as any).vlan,
            subnet,
            gateway,
          },
          display: `✅ Nächste freie IP: **${candidate}** (${(target as any).name}, VLAN ${(target as any).vlan ?? '-'}, Subnetz ${subnet})`,
        };
      }
    }

    return { success: false, error: `Keine freie IP gefunden in ${intToIp(firstHost)}-${intToIp(lastHost)}` };
  }

  private async listFirewallRules(): Promise<SkillResult> {
    try {
      const rules = await this.request('GET', 'rest/firewallrule') as Array<Record<string, unknown>>;
      const lines = rules.map((r: any) => {
        const action = r.action ?? 'accept';
        const src = r.src_firewallgroup_ids?.length ? r.src_firewallgroup_ids.join(',') : r.src_address ?? 'any';
        const dst = r.dst_firewallgroup_ids?.length ? r.dst_firewallgroup_ids.join(',') : r.dst_address ?? 'any';
        return `| ${r.name ?? '?'} | ${action} | ${r.protocol ?? 'all'} | ${src} | ${dst} | ${r.enabled ? '🟢' : '🔴'} | ${r._id?.slice(0, 8) ?? ''} |`;
      });
      const display = `## UniFi Firewall Regeln\n\n| Name | Action | Proto | Source | Dest | Status | ID |\n|------|--------|-------|--------|------|--------|----|\n${lines.join('\n')}`;
      return { success: true, data: rules, display };
    } catch (err) {
      return { success: false, error: `UniFi Firewall: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private async createFirewallRule(input: Record<string, unknown>): Promise<SkillResult> {
    const name = (input.rule_name as string) ?? `Alfred: ${input.source ?? 'any'} → ${input.destination ?? 'any'}`;
    const body: Record<string, unknown> = {
      name,
      enabled: true,
      action: (input.rule_action as string) ?? 'accept',
      protocol: (input.protocol as string) ?? 'tcp',
      ruleset: 'LAN_IN',
      rule_index: 4000,
      src_address: input.source ?? '',
      dst_address: input.destination ?? '',
      dst_port: input.port ?? '',
    };

    const result = await this.request('POST', 'rest/firewallrule', body);
    return {
      success: true,
      data: result,
      display: `✅ UniFi Firewall-Regel erstellt: ${name}`,
    };
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
