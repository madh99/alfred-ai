# MikroTik RouterOS Management Skill — Design Spec

## Überblick

Neuer Skill `mikrotik` (category: `infrastructure`) der die RouterOS REST API (`/rest/...`, ab v7.1) anspricht. Multi-Router-fähig — Verbindungen werden benannt und verwaltet. Drei Ebenen: Monitoring, Konfiguration, Troubleshooting.

Default: voll operativ. `confirmation_mode: true` → Schreibaktionen über Confirmation Queue (HIGH_RISK).

## Verbindungsmanagement

Mehrere Router benannt konfigurierbar (wie Database-Skill Pattern):

```yaml
mikrotik:
  enabled: true
  confirmation_mode: false
  polling_interval: 5
  auto_incident: true
  cpu_warning_pct: 80
  ram_warning_pct: 85
  routers:
    - name: main-router
      host: 192.168.1.1
      username: alfred-api
      password: "..."
      port: 443
      ssl: true
      default: true
    - name: vr-dmz
      host: 192.168.10.1
      username: alfred-api
      password: "..."
      port: 80
      ssl: false
```

## Actions

### Monitoring

| Action | Beschreibung | Parameter |
|--------|-------------|-----------|
| `status` | Gesamtstatus: CPU, RAM, Uptime, Interfaces, Version | `router?` |
| `interfaces` | Alle Interfaces mit Traffic, Status, Errors | `router?`, `filter?` |
| `traffic` | Live-Traffic pro Interface | `router?`, `interface?` |
| `resources` | CPU, RAM, Disk, Temperatur, Spannung | `router?` |
| `logs` | System-Logs (filterbar) | `router?`, `topic?`, `limit?` |
| `dhcp_leases` | Aktive DHCP-Leases | `router?`, `server?` |
| `arp` | ARP-Tabelle | `router?` |
| `routes` | Routing-Tabelle | `router?`, `filter?` |
| `dns_cache` | DNS-Cache Einträge | `router?` |
| `connections` | Active Connection Tracking | `router?`, `src?`, `dst?`, `protocol?` |
| `neighbors` | Neighbor Discovery (CDP/LLDP/MNDP) | `router?` |
| `wireless` | WLAN-Clients und Status | `router?` |

### Konfiguration

| Action | Beschreibung | Parameter |
|--------|-------------|-----------|
| `firewall_rules` | Firewall Filter-Regeln auflisten | `router?`, `chain?` |
| `add_firewall` | Firewall-Regel hinzufügen | `router?`, `chain`, `action`, `src?`, `dst?`, `protocol?`, `port?`, `comment?`, `position?` |
| `remove_firewall` | Firewall-Regel entfernen | `router?`, `id` |
| `enable_firewall` | Firewall-Regel aktivieren | `router?`, `id` |
| `disable_firewall` | Firewall-Regel deaktivieren | `router?`, `id` |
| `nat_rules` | NAT-Regeln auflisten | `router?` |
| `add_nat` | NAT-Regel hinzufügen | `router?`, `chain`, `action`, `src?`, `dst?`, `to_addresses?`, `to_ports?`, `comment?` |
| `remove_nat` | NAT-Regel entfernen | `router?`, `id` |
| `set_dns` | DNS-Server/Static-Eintrag setzen | `router?`, `servers?`, `name?`, `address?` |
| `add_address` | IP-Adresse auf Interface setzen | `router?`, `address`, `interface`, `comment?` |
| `remove_address` | IP-Adresse entfernen | `router?`, `id` |
| `enable_interface` | Interface aktivieren | `router?`, `interface` |
| `disable_interface` | Interface deaktivieren | `router?`, `interface` |
| `add_route` | Statische Route hinzufügen | `router?`, `dst_address`, `gateway`, `comment?` |
| `remove_route` | Statische Route entfernen | `router?`, `id` |
| `add_dhcp_static` | Statischen DHCP-Lease hinzufügen | `router?`, `mac`, `address`, `comment?`, `server?` |
| `set_queue` | Simple Queue erstellen/ändern | `router?`, `name`, `target`, `max_limit?`, `comment?` |
| `backup_config` | RouterOS Config-Backup exportieren | `router?`, `format?` (export/binary) |

### Troubleshooting

| Action | Beschreibung | Parameter |
|--------|-------------|-----------|
| `ping` | Ping von Router aus | `router?`, `address`, `count?`, `interface?` |
| `traceroute` | Traceroute von Router aus | `router?`, `address` |
| `torch` | Torch (Live-Traffic-Analyse) | `router?`, `interface`, `duration?` |

### Verwaltung

| Action | Beschreibung | Parameter |
|--------|-------------|-----------|
| `list_routers` | Konfigurierte Router auflisten | — |
| `add_router` | Neuen Router hinzufügen | `name`, `host`, `username`, `password`, `port?`, `ssl?` |
| `remove_router` | Router-Verbindung entfernen | `name` |
| `configure` | Skill-Config ändern | `confirmation_mode?`, `polling_interval?` |

## RouterOS REST API

RouterOS 7.x REST: `GET/POST/PUT/DELETE https://{host}:{port}/rest/{path}`
Auth: HTTP Basic Auth (`username:password`)

| Ressource | REST Endpoint |
|-----------|--------------|
| System Resources | `/rest/system/resource` |
| System Identity | `/rest/system/identity` |
| Interfaces | `/rest/interface` |
| Interface Traffic | `/rest/interface/monitor-traffic` (POST) |
| IP Addresses | `/rest/ip/address` |
| IP Routes | `/rest/ip/route` |
| Firewall Filter | `/rest/ip/firewall/filter` |
| Firewall NAT | `/rest/ip/firewall/nat` |
| Firewall Connections | `/rest/ip/firewall/connection` |
| DHCP Leases | `/rest/ip/dhcp-server/lease` |
| ARP Table | `/rest/ip/arp` |
| DNS Static | `/rest/ip/dns/static` |
| DNS Cache | `/rest/ip/dns/cache` |
| System Log | `/rest/log` |
| Neighbors | `/rest/ip/neighbor` |
| Ping | `/rest/tool/ping` (POST) |
| Traceroute | `/rest/tool/traceroute` (POST) |
| Torch | `/rest/tool/torch` (POST) |
| Queue Simple | `/rest/queue/simple` |
| Export | `/rest/export` (POST) |

### REST API Conventions

- **GET** `/rest/ip/firewall/filter` → Liste aller Regeln
- **GET** `/rest/ip/firewall/filter/*{id}` → Einzelne Regel
- **PUT** `/rest/ip/firewall/filter/*{id}` → Regel ändern
- **DELETE** `/rest/ip/firewall/filter/*{id}` → Regel löschen
- **POST** `/rest/ip/firewall/filter/add` → Regel hinzufügen
- **POST** `/rest/ip/firewall/filter/set` → Regel setzen (mit `.id`)
- **POST** `/rest/ip/firewall/filter/enable` → Regel aktivieren
- **POST** `/rest/ip/firewall/filter/disable` → Regel deaktivieren

Alle Responses als JSON. IDs haben Format `*1`, `*2`, etc.

## Reasoning-Integration

Neue Source im `reasoning-context-collector.ts`:
- Key: `mikrotik`
- Label: `MikroTik Router`
- Priority: 2
- MaxTokens: 200
- Inhalt: Down-Interfaces, CPU >80%, Interface-Errors, ungewöhnlicher Traffic

## Proaktives Monitoring

Polling (default: 5 Min, alle Router):
1. Interface up/down Änderungen → Insight
2. CPU/RAM über Schwellwert → Warnung
3. Neue Interface-Errors → Alert
4. Link-Speed-Änderungen → Hinweis
5. ITSM-Incident bei Interface-Down (wenn `auto_incident: true`)
6. Cluster-aware: `AdapterClaimManager.tryClaim('mikrotik-monitor')`

## Config ENV-Overrides

```
ALFRED_MIKROTIK_ENABLED=true
ALFRED_MIKROTIK_HOST=192.168.1.1
ALFRED_MIKROTIK_USERNAME=alfred-api
ALFRED_MIKROTIK_PASSWORD=...
ALFRED_MIKROTIK_PORT=443
ALFRED_MIKROTIK_SSL=true
ALFRED_MIKROTIK_CONFIRMATION_MODE=false
ALFRED_MIKROTIK_POLLING_INTERVAL=5
ALFRED_MIKROTIK_AUTO_INCIDENT=true
ALFRED_MIKROTIK_CPU_WARNING_PCT=80
ALFRED_MIKROTIK_RAM_WARNING_PCT=85
```

## Chat-Beispiele

| User sagt | Alfred tut |
|-----------|-----------|
| "MikroTik Status" | Gesamtübersicht aller Router |
| "Zeig Interfaces vom main-router" | `interfaces` |
| "Wie ist der Traffic auf ether1?" | `traffic` |
| "Zeig Firewall-Regeln" | `firewall_rules` |
| "Blockiere IP 1.2.3.4" | `add_firewall chain=input action=drop src=1.2.3.4` |
| "Deaktiviere ether5 auf vr-dmz" | `disable_interface` |
| "Ping 8.8.8.8 vom main-router" | `ping` |
| "Wer hängt am DHCP?" | `dhcp_leases` |
| "Aktive Verbindungen zu Port 443" | `connections dst=443` |
| "Config-Backup vom main-router" | `backup_config` |
| "Route 10.0.0.0/8 via 192.168.1.254" | `add_route` |
| "Bandbreite 10M/5M für 192.168.1.100" | `set_queue` |
| "Traceroute zu 1.1.1.1" | `traceroute` |

## Abhängigkeiten

- Keine neuen npm-Packages — REST API über native `fetch` + Basic Auth
- Bestehend: AdapterClaimManager, ITSM-Skill, Reasoning-Engine
- CMDB: Router als Assets registrierbar

## Dateien

| Datei | Änderung |
|-------|----------|
| `packages/types/src/config.ts` | `MikroTikConfig` Interface |
| `packages/config/src/schema.ts` | Zod-Schema |
| `packages/config/src/loader.ts` | ENV-Overrides |
| `packages/skills/src/built-in/mikrotik.ts` | Neuer Skill |
| `packages/skills/src/index.ts` | Export |
| `packages/core/src/alfred.ts` | Registrierung + Polling + ITSM |
| `packages/core/src/reasoning-context-collector.ts` | Neue Source |
| `packages/core/src/skill-filter.ts` | Keywords |
