# Alfred Satellite Agent — Architektur-Spezifikation

**Version:** 1.0 Draft
**Datum:** 2026-04-07
**Status:** Entwurf — Umsetzung nach Freigabe

## 1. Zusammenfassung

Der Alfred Satellite Agent ist ein optionaler, lightweight Node.js-Prozess der auf verwalteten Systemen installiert wird. Er gibt Alfred Echtzeit-Einblick in System-Metriken, laufende Services, Netzwerk-Verbindungen und Logs — und kann remote Commands ausführen.

**Grundprinzip:** Alfred funktioniert zu 100% ohne Agents. Alle bestehenden API-basierten Integrationen (Proxmox, UniFi, Docker, HA, Cloudflare, NPM, pfSense) bleiben unverändert. Der Agent ist rein additiv.

## 2. Architektur

```
┌─────────────────────────────────┐     ┌─────────────────────────────────┐
│  Agent (Host A)                  │     │  Agent (Host B)                  │
│  Collector → Telemetry           │     │  Collector → Telemetry           │
│  Discovery → Services/Ports/Conn │     │  Log Watcher → Events            │
│  Log Watcher → Events            │     │  Executor → Command Results      │
│  Executor → Command Results      │     └───────────┬─────────────────────┘
└───────────┬─────────────────────┘                  │
            │          MQTT Broker                    │
            └──────────────┬──────────────────────────┘
                           │
            ┌──────────────▼──────────────────────────┐
            │  Alfred Core (zentral)                    │
            │                                           │
            │  AgentManager (NEU)                       │
            │  ├── Registration + Heartbeat             │
            │  ├── Telemetry → CMDB Asset Attributes    │
            │  ├── Discovery → Service Components       │
            │  ├── Events → ITSM Auto-Incidents         │
            │  └── Command Dispatch → Results            │
            │                                           │
            │  Bestehende Systeme (UNVERÄNDERT):        │
            │  CMDB, ITSM, KG, Reasoning, Skills        │
            └───────────────────────────────────────────┘
```

## 3. Kommunikation

### 3.1 Transport: MQTT

Wiederverwendung des bestehenden MQTT Brokers (bereits für BMW Streaming konfiguriert). Kein neuer Transport nötig.

### 3.2 Topic-Struktur

| Topic | Richtung | QoS | Frequenz | Beschreibung |
|-------|----------|-----|----------|-------------|
| `alfred/agents/{hostId}/register` | Agent → Core | 1 | Einmalig + Reconnect | Registrierung mit Capabilities |
| `alfred/agents/{hostId}/heartbeat` | Agent → Core | 0 | Alle 30s | Alive-Signal + Basis-Metriken |
| `alfred/agents/{hostId}/telemetry` | Agent → Core | 0 | Alle 5 Min | Detaillierte System-Metriken |
| `alfred/agents/{hostId}/discovery` | Agent → Core | 1 | Start + alle 24h | Services, Ports, Connections |
| `alfred/agents/{hostId}/events` | Agent → Core | 1 | Echtzeit | Log-Alerts, Crashes, Threshold-Überschreitungen |
| `alfred/agents/{hostId}/results` | Agent → Core | 1 | On-Demand | Antwort auf Commands |
| `alfred/agents/{hostId}/commands` | Core → Agent | 1 | On-Demand | Befehle ausführen |
| `alfred/agents/{hostId}/config` | Core → Agent | 1 | On-Demand | Konfigurations-Updates |

**QoS-Begründung:**
- QoS 0 (fire-and-forget): Heartbeat und Telemetrie — periodisch, Verlust akzeptabel, nächster Zyklus ersetzt
- QoS 1 (at-least-once): Alles andere — muss ankommen (Events, Commands, Discovery, Results)

### 3.3 Message-Format

```typescript
interface AgentMessage {
  hostId: string;              // Hostname oder Agent-UUID
  agentVersion: string;        // Semver
  protocolVersion: number;     // Für Kompatibilitätsprüfung (startet bei 1)
  timestamp: string;           // ISO 8601
  type: 'register' | 'heartbeat' | 'telemetry' | 'discovery' | 'event' | 'result';
  data: Record<string, unknown>;
}

interface AgentCommand {
  commandId: string;           // UUID für Response-Korrelation
  action: string;              // 'exec', 'restart_service', 'read_file', etc.
  params: Record<string, unknown>;
  timeout?: number;            // ms, default 30000
}
```

### 3.4 Offline-Handling

**Agent → Core nicht erreichbar:**
- Agent buffered Messages in lokalem Ring-Buffer (JSON Lines Datei, max 10MB)
- Heartbeat: wird NICHT gebuffert (veraltet sofort)
- Telemetrie: letzter Snapshot wird gebuffert, ältere verworfen
- Events: werden gebuffert (bis zu 24h, dann verworfen)
- Discovery: wird gebuffert (1 Snapshot)
- Bei Reconnect: Buffer wird chronologisch geflusht

**Agent dauerhaft offline:**
- Alfred Core: `last_seen_at` im agent_registry veraltet
- Nach `staleThreshold` (default 10 Min): Agent-Status → `stale`
- Nach `offlineThreshold` (default 1h): Agent-Status → `offline`
- CMDB-Assets des Agents: bleiben erhalten, Status nicht geändert (API-Discovery kann sie weiterhin aktualisieren)

## 4. HA Cluster Integration

### 4.1 Nur ein Node verarbeitet Agent-Messages

AgentManager nutzt das bestehende `AdapterClaimManager`-Pattern:

```
adapterClaimManager.tryClaim('agent-manager')
  → true: dieser Node subscribt auf alfred/agents/# und verarbeitet Messages
  → false: dieser Node ignoriert Agent-Messages
```

Bei Node-Ausfall: der überlebende Node übernimmt den Claim innerhalb von 15s (bestehender `checkExpiredClaims` Zyklus).

### 4.2 Kein Agent-seitiger Cluster-Knowledge

Der Agent weiß nichts über Alfred's Cluster. Er verbindet sich zum MQTT Broker (der unabhängig von Alfred-Nodes läuft) und publiziert. Welcher Alfred-Node die Messages verarbeitet ist für den Agent transparent.

## 5. Agent-Fähigkeiten (Module)

### 5.1 System Collector (immer aktiv)

Sammelt Basis-Metriken des Host-Systems:

```typescript
interface TelemetryData {
  os: { hostname: string; platform: string; release: string; uptime: number; arch: string };
  cpu: { model: string; cores: number; usagePercent: number; loadAvg: [number, number, number] };
  memory: { totalMB: number; usedMB: number; availableMB: number; swapTotalMB: number; swapUsedMB: number };
  disk: Array<{ mount: string; totalGB: number; usedGB: number; availableGB: number; usedPercent: number; fsType: string }>;
  network: Array<{ name: string; ip: string; mac: string; rxBytes: number; txBytes: number }>;
}
```

**Implementierung:** Node.js `os` Module + `/proc/stat`, `/proc/meminfo`, `df -BM`, `ip addr` auf Linux.

**Threshold-Alerts** (Agent-seitig, sofort als Event):
- CPU > 90% für > 2 Min → Event `cpu_critical`
- RAM > 95% → Event `memory_critical`
- Disk > 90% → Event `disk_warning`, > 95% → `disk_critical`
- Load Avg > 2×Cores → Event `load_high`

### 5.2 Service Discovery

```typescript
interface DiscoveryData {
  processes: Array<{
    pid: number; name: string; cmd: string; user: string;
    ports: Array<{ port: number; protocol: 'tcp' | 'udp'; state: string }>;
    connections: Array<{ remoteIp: string; remotePort: number; state: string }>;
    memoryMB: number; cpuPercent: number;
  }>;
  dockerContainers?: Array<{
    id: string; name: string; image: string; status: string;
    ports: Array<{ hostPort: number; containerPort: number; protocol: string }>;
    networks: string[];
  }>;
  listeningPorts: Array<{ port: number; protocol: string; pid: number; processName: string }>;
  outgoingConnections: Array<{
    localPort: number; remoteIp: string; remotePort: number;
    pid: number; processName: string; state: string;
  }>;
}
```

**Implementierung:** `ss -tpn` (Linux) + `/proc/{pid}/cmdline` + Docker Socket API (wenn verfügbar).

**Automatische Service-Dependency-Erkennung:**

```
Agent auf .92: Prozess "node" (pid 1234, port 3420)
  → Connection zu 192.168.1.91:5432 (PostgreSQL)
  → Connection zu 192.168.1.91:6379 (Redis)
  → Connection zu 192.168.1.91:9000 (MinIO)

Alfred AgentManager:
  1. Port 5432 auf .91 → CMDB Asset "postgres-container" (bekannt durch Docker-Discovery)
  2. Port 6379 auf .91 → CMDB Asset "redis-container"
  3. Port 9000 auf .91 → CMDB Asset "minio-container"

  → Service "Alfred Bot" (auf .92:3420) bekommt automatisch:
     Component: PostgreSQL (role: database, asset: postgres-container, required: true)
     Component: Redis (role: cache, asset: redis-container, required: false)
     Component: MinIO (role: storage, asset: minio-container, required: false)
```

**Port-zu-Rolle Heuristik:**

| Port | Service-Typ | Rolle |
|------|------------|-------|
| 5432 | PostgreSQL | database |
| 3306 | MySQL/MariaDB | database |
| 27017 | MongoDB | database |
| 6379 | Redis | cache |
| 11211 | Memcached | cache |
| 9000 | MinIO/S3 | storage |
| 8086 | InfluxDB | database |
| 1883/8883 | MQTT | messaging |
| 80/443 | HTTP/HTTPS | api |
| 8080-8099 | HTTP Alt | api |

### 5.3 Log Watcher (optional, konfigurierbar)

```typescript
interface LogWatcherConfig {
  sources: Array<{
    type: 'file' | 'journald' | 'docker';
    path?: string;           // für type: 'file'
    unit?: string;           // für type: 'journald'
    container?: string;      // für type: 'docker'
    patterns: Array<{
      regex: string;         // Matching-Pattern
      severity: 'critical' | 'high' | 'medium' | 'low';
      cooldownSeconds: number; // Min. Zeit zwischen gleichen Alerts (Default: 300)
    }>;
  }>;
}
```

**Rate-Limiting (Agent-seitig):**
- Pro Pattern: Cooldown (default 5 Min) — gleicher Pattern matcht nicht erneut innerhalb des Cooldowns
- Global: Max 10 Events/Minute pro Agent — überschüssige werden verworfen mit Warnung

### 5.4 Skill Executor

Führt Commands auf Anfrage von Alfred Core aus.

**Vordefinierte Actions:**

| Action | Beschreibung | Beispiel-Params |
|--------|-------------|-----------------|
| `exec` | Shell-Command ausführen | `{ command: "df -h", timeout: 10000 }` |
| `service_status` | systemd/pm2/docker Status | `{ name: "postgresql", type: "systemd" }` |
| `service_restart` | Service neustarten | `{ name: "alfred", type: "pm2" }` |
| `service_stop` | Service stoppen | `{ name: "redis", type: "systemd" }` |
| `service_start` | Service starten | `{ name: "redis", type: "systemd" }` |
| `read_file` | Datei lesen (max 1MB) | `{ path: "/var/log/syslog", lines: 100 }` |
| `disk_usage` | Detaillierte Disk-Info | `{ path: "/var/lib/postgresql" }` |
| `package_list` | Installierte Packages | `{ filter: "postgres" }` |
| `update_check` | Verfügbare Updates | `{}` |
| `process_info` | Detailinfo zu einem Prozess | `{ pid: 1234 }` |

**Sicherheits-Allowlist (Agent-Konfiguration):**

```typescript
interface ExecutorConfig {
  allowedActions: string[];                    // Welche Actions erlaubt sind
  restrictedPaths: string[];                   // Dateien die nie gelesen werden dürfen
  restrictedCommands: string[];                // Shell-Commands die nie ausgeführt werden dürfen
  maxExecTimeout: number;                      // Max Timeout für exec (default: 300000ms)
  requireConfirmation: string[];               // Actions die User-Bestätigung brauchen
}

// Defaults:
{
  allowedActions: ['exec', 'service_status', 'read_file', 'disk_usage', 'package_list', 'update_check', 'process_info'],
  restrictedPaths: ['/etc/shadow', '/etc/gshadow', '/root/.ssh/id_*', '**/*.key', '**/*.pem'],
  restrictedCommands: ['rm -rf /', 'mkfs', 'dd if=', 'chmod 777', ':(){:|:&};:'],
  maxExecTimeout: 300000,
  requireConfirmation: ['service_restart', 'service_stop']
}
```

## 6. Sicherheit

### 6.1 Agent-Registration

```
1. Admin in Alfred: "Erstelle Agent-Token" (Chat oder WebUI)
   → Alfred generiert JWT (24h gültig, signiert mit Alfred-Secret)
   → Token enthält: { type: 'agent_registration', expires: '...', createdBy: userId }

2. Admin auf Ziel-Host:
   $ alfred-agent init --broker mqtt://192.168.1.91:1883 --token <JWT>

3. Agent verbindet zu MQTT, sendet Register-Message mit Token

4. AgentManager validiert JWT:
   - Signatur korrekt?
   - Nicht abgelaufen?
   - type === 'agent_registration'?

5. Bei Erfolg:
   - Erstellt Eintrag in agent_registry
   - Generiert agent-spezifische MQTT Credentials (oder Client-Zertifikat)
   - Sendet Credentials via MQTT Response
   - Agent speichert Credentials lokal (~/.alfred-agent/credentials.json)

6. Ab jetzt: Agent nutzt eigene Credentials für MQTT Auth
```

### 6.2 MQTT Broker Absicherung

- **Username/Password Auth:** Jeder Agent bekommt eigene Credentials
- **Topic-ACLs:** Agent `host-a` darf nur auf `alfred/agents/host-a/*` publishen und `alfred/agents/host-a/commands` subscriben
- **TLS:** Optional aber empfohlen (MQTT über Port 8883)
- **Alfred Core:** Darf alle `alfred/agents/#` Topics lesen und `alfred/agents/+/commands` publishen

### 6.3 Command-Autorisierung

- Agent führt nur Actions aus die in seiner `allowedActions` Liste stehen
- `restrictedPaths` und `restrictedCommands` werden vor jeder Execution geprüft
- Actions in `requireConfirmation` werden an Alfred's Confirmation Queue weitergeleitet (User muss bestätigen)
- Jeder Command hat einen `commandId` — Responses werden korreliert, Timeouts werden enforced

## 7. CMDB/ITSM Integration

### 7.1 Agent → CMDB Asset

Bei Registration erstellt AgentManager automatisch ein CMDB Asset:
- `name`: Hostname des Agents
- `assetType`: `server`
- `sourceSkill`: `agent`
- `sourceId`: `agent:{hostId}`
- `ipAddress`: Agent-IP
- `attributes`: OS, Arch, CPU-Model, RAM total, Agent-Version

Bei jedem Telemetrie-Update: Attribute aktualisiert (CPU-Usage, RAM-Usage, Disk-Usage).

### 7.2 Discovery → Service Components

AgentManager verarbeitet Discovery-Daten:

1. **Laufende Prozesse → CMDB Assets** (type: `application`)
   - Nur Prozesse die auf konfigurierten Ports lauschen (nicht jeder Shell-Prozess)
   - `sourceSkill`: `agent:{hostId}`

2. **Docker Container → CMDB Assets** (type: `container`)
   - Wenn Docker-Discovery über Agent UND über Docker-API läuft → Dedup per Container-ID
   - Agent-Source wird mit existierendem Docker-API-Asset gemergt (nicht dupliziert)

3. **Outgoing Connections → Service Components**
   - Port-zu-Asset Matching über CMDB IP+Port Lookup
   - Automatisches `add_component` auf dem Service der den Prozess hostet

### 7.3 Duplikat-Erkennung (Agent vs. API Discovery)

| Szenario | Lösung |
|----------|--------|
| Agent entdeckt Docker Container, API-Discovery auch | `sourceId` ist Container-ID → `upsertAsset` dedupt automatisch |
| Agent entdeckt Prozess, kein API-Pendant | Neues CMDB Asset mit `sourceSkill: agent:{hostId}` |
| Agent meldet IP, Proxmox meldet gleiche IP | Cross-Source-Relation `same_as` via IP-Matching (bestehende Logik) |
| Agent und API melden gleichen Port-Service | Agent-Data merged in bestehendes Asset (Attributes ergänzt, nicht überschrieben) |

**Regel:** API-Discovery bleibt primäre Quelle. Agent-Daten ergänzen und bereichern, überschreiben nie API-Daten.

### 7.4 Events → ITSM Incidents

```
Agent Event (critical log alert)
  → AgentManager empfängt
    → Gleiches Dedup wie Monitor→Incident:
      - findOpenIncidentForAsset(userId, hostId, keywords)
      - Bei Match: appendSymptoms
      - Bei kein Match: createIncident(detectedBy: 'agent')
    → Asset-Status Update wenn nötig
    → Service Health Propagation wenn Asset mit Service verknüpft
```

## 8. Agent Remote-Konfiguration

### 8.1 Initiale Konfiguration

```yaml
# ~/.alfred-agent/config.yaml (auf dem Agent-Host)
broker: mqtt://192.168.1.91:1883
hostId: node-a                    # Auto-detected wenn nicht gesetzt
intervals:
  heartbeat: 30                   # Sekunden
  telemetry: 300                  # Sekunden
  discovery: 86400                # Sekunden (24h)
collector:
  enabled: true
  thresholds:
    cpu_critical: 90              # %
    memory_critical: 95           # %
    disk_warning: 90              # %
    disk_critical: 95             # %
logWatcher:
  enabled: true
  sources:
    - type: journald
      unit: alfred
      patterns:
        - { regex: 'ERROR|FATAL', severity: high, cooldownSeconds: 300 }
    - type: docker
      container: postgres
      patterns:
        - { regex: 'FATAL|PANIC', severity: critical, cooldownSeconds: 60 }
executor:
  enabled: true
  allowedActions: [exec, service_status, read_file, disk_usage, package_list, update_check]
  restrictedPaths: ['/etc/shadow', '/root/.ssh/id_*']
```

### 8.2 Remote Config-Updates

Alfred Core kann Config-Updates per MQTT Command senden:

```json
{
  "commandId": "cfg-123",
  "action": "update_config",
  "params": {
    "path": "logWatcher.sources[0].patterns",
    "value": [{ "regex": "ERROR|FATAL|OOM", "severity": "critical", "cooldownSeconds": 60 }]
  }
}
```

Agent merged den Update in seine lokale Config und bestätigt per Result.

## 9. Agent-Lifecycle

### 9.1 Installation

```bash
# Auf dem Ziel-Host:
npm install -g @madh-io/alfred-agent

# Konfiguration + Registration:
alfred-agent init --broker mqtt://192.168.1.91:1883 --token <token>

# Start:
alfred-agent start

# Als systemd Service installieren:
alfred-agent install-service
# → erstellt /etc/systemd/system/alfred-agent.service
# → systemctl enable alfred-agent
```

### 9.2 Updates

- Agent meldet Version in jedem Heartbeat
- Alfred Core vergleicht mit erwarteter Version (konfigurierbar)
- Update-Command: `{ action: 'self_update', params: { version: 'latest' } }`
- Agent führt aus: `npm install -g @madh-io/alfred-agent@<version>` + Restart
- Rollback: Agent behält vorherige Version, bei Fehlschlag automatisch zurück

### 9.3 Deregistrierung

```bash
# Auf dem Agent-Host:
alfred-agent unregister

# Oder remote von Alfred:
"Entferne Agent node-a"
```

Effekt:
- agent_registry: status → `deregistered`
- CMDB Assets: bleiben erhalten (mit `sourceSkill: agent:{hostId}`)
- Stale-Detection: greift nach dem nächsten Discovery-Cycle (kein Agent-Update mehr → `last_verified_at` veraltet)
- Credentials: werden auf dem Agent-Host gelöscht
- MQTT: Agent disconnected, Subscription entfernt

### 9.4 Stale/Offline Detection

| last_seen_at Alter | Agent-Status | Aktion |
|---------------------|-------------|--------|
| < 2 Min | `active` | Normal |
| 2-10 Min | `stale` | Warnung im Dashboard |
| > 10 Min | `offline` | ITSM Event: "Agent {hostId} offline" |
| > 24h | `offline` | CMDB Asset-Status: `unknown` (wenn kein API-Fallback) |

## 10. Datenbank-Schema

### Migration v52: agent_registry

```sql
CREATE TABLE agent_registry (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL UNIQUE,
  hostname TEXT NOT NULL,
  ip_address TEXT,
  os TEXT,
  arch TEXT,
  agent_version TEXT,
  protocol_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  capabilities TEXT NOT NULL DEFAULT '[]',
  config TEXT NOT NULL DEFAULT '{}',
  cmdb_asset_id TEXT,
  last_telemetry TEXT DEFAULT '{}',
  last_seen_at TEXT,
  registered_at TEXT NOT NULL,
  user_id TEXT NOT NULL
);
CREATE INDEX idx_agent_registry_host ON agent_registry(host_id);
CREATE INDEX idx_agent_registry_status ON agent_registry(status);
```

### Telemetrie-Speicherung

**MVP:** Letzter Snapshot pro Agent in `agent_registry.last_telemetry` (JSON). Kein History.

**Erweitert (Phase 2+):** Optional InfluxDB (`@influxdata/influxdb-client` bereits als optionale Dependency). Time-Series mit 30-Tage Retention.

## 11. Alfred Core: AgentManager

```typescript
// packages/core/src/agent-manager.ts
class AgentManager {
  constructor(
    private readonly mqttClient: MqttClient,
    private readonly cmdbRepo: CmdbRepository,
    private readonly itsmRepo: ItsmRepository,
    private readonly agentRepo: AgentRegistryRepository,
    private readonly logger: Logger,
    private readonly ownerUserId: string,
  ) {}

  async start(): Promise<void>           // Subscribe to alfred/agents/#, start stale-check timer
  async stop(): Promise<void>            // Unsubscribe, clear timers

  // Message handlers
  async handleRegister(msg: AgentMessage): Promise<void>
  async handleHeartbeat(msg: AgentMessage): Promise<void>
  async handleTelemetry(msg: AgentMessage): Promise<void>
  async handleDiscovery(msg: AgentMessage): Promise<void>
  async handleEvent(msg: AgentMessage): Promise<void>
  async handleResult(msg: AgentMessage): Promise<void>

  // Command dispatch
  async sendCommand(hostId: string, action: string, params: Record<string, unknown>): Promise<AgentResult>

  // Internal
  private async checkStaleAgents(): Promise<void>          // Runs every 60s
  private async processDiscovery(hostId: string, data: DiscoveryData): Promise<void>
  private async matchConnectionsToAssets(connections: OutgoingConnection[]): Promise<ServiceComponent[]>
}
```

### Integration in alfred.ts

```typescript
// In initialize(), nach CMDB/ITSM Registration:
if (this.config.mqtt?.brokerUrl) {
  const agentMqtt = await this.createAgentMqttClient();
  if (agentMqtt && await adapterClaimManager.tryClaim('agent-manager')) {
    this.agentManager = new AgentManager(agentMqtt, cmdbRepo, itsmRepo, agentRepo, logger, ownerMasterUserId);
    await this.agentManager.start();
    this.logger.info('Agent Manager started (MQTT)');
  }
}
```

## 12. Agent Package-Struktur

```
packages/agent/
  ├── package.json              (@madh-io/alfred-agent)
  ├── tsconfig.json
  ├── src/
  │   ├── index.ts              CLI: alfred-agent start|init|status|unregister|install-service
  │   ├── agent.ts              Main Agent class (lifecycle, module orchestration)
  │   ├── transport.ts          MQTT client (connect, reconnect, publish, subscribe)
  │   ├── buffer.ts             Offline message buffer (ring-buffer, flush on reconnect)
  │   ├── config.ts             YAML config loader + remote update handler
  │   ├── collectors/
  │   │   ├── system.ts         OS, CPU, RAM, Disk metrics
  │   │   ├── process.ts        Running processes with ports (ss -tpn)
  │   │   ├── network.ts        Outgoing connections (ss -tpn state established)
  │   │   └── docker.ts         Docker API (socket) if available
  │   ├── log-watcher.ts        File tail + journald + docker logs
  │   ├── executor.ts           Command execution with allowlist + security checks
  │   └── installer.ts          systemd service file generator
  └── bundle/
      └── index.js              Single-file bundle for deployment
```

## 13. Skill-Integration

### Bestehende Skills: Agent als optionaler Pfad

```typescript
// Pattern für jeden Skill der Agent nutzen KANN:
async execute(input, context) {
  const hostId = input.host as string;

  // Prüfe ob Agent verfügbar
  if (hostId && this.agentManager?.isAgentOnline(hostId)) {
    return this.executeViaAgent(hostId, input);
  }

  // Fallback: bestehende API/SSH-Methode (UNVERÄNDERT)
  return this.executeViaApi(input);
}
```

| Skill | Ohne Agent (Fallback) | Mit Agent |
|-------|----------------------|-----------|
| Deploy | SSH + execFile | Agent `exec` Command (kein SSH-Key nötig) |
| Docker | Docker Socket/TCP API | Agent liest Docker lokal |
| Monitor | API-basiert (Proxmox, UniFi) | Agent: lokale Metriken + Logs |
| Shell | Nur lokal | Agent: Remote-Shell auf jedem Host |
| CMDB Discovery | API-basiert | Agent: Prozesse, Ports, Connections |
| ITSM Health-Check | HTTP Ping + Asset-Status | Agent: Prozess + Port + Log Health |

## 14. WebUI

### Agent-Dashboard (neue Seite: /alfred/agents/)

| Spalte | Beschreibung |
|--------|-------------|
| Status-Dot | Grün/Gelb/Rot basierend auf `status` |
| Hostname | Agent-Name (Link zu Detail) |
| IP | Agent-IP |
| OS | Platform + Release |
| CPU/RAM/Disk | Letzte Telemetrie-Werte (Sparkline oder Balken) |
| Version | Agent-Version |
| Last Seen | Relatives Datum |

### Agent-Detail (Klick auf Agent)

- System-Metriken (letzte Werte)
- Entdeckte Services/Prozesse
- Log-Watcher Konfiguration
- Letzte Events
- Command-History
- Verknüpfte CMDB-Assets
- "Command senden" Button

## 15. Phasen-Plan

| Phase | Was | Abhängigkeit | Aufwand |
|-------|-----|-------------|---------|
| **1** | Agent Grundgerüst: Package, CLI, MQTT Transport, Registration, Heartbeat | MQTT Broker | 8h |
| **2** | System Collector: OS/CPU/RAM/Disk → Telemetry | Phase 1 | 4h |
| **3** | AgentManager in Alfred Core: Registration + Heartbeat + Telemetry → CMDB | Phase 1+2 | 6h |
| **4** | Service Discovery: Prozesse, Ports, Connections | Phase 2 | 6h |
| **5** | Auto-Service-Components: Discovery → CMDB Service-Zuordnung | Phase 3+4 | 8h |
| **6** | Log Watcher: File + journald + Docker Logs → Events | Phase 1 | 6h |
| **7** | Events → ITSM: Log-Alerts → Auto-Incidents + Health Propagation | Phase 3+6 | 4h |
| **8** | Skill Executor: Remote-Commands via MQTT + Allowlist | Phase 1 | 6h |
| **9** | Deploy-Skill Integration: Agent statt SSH wenn verfügbar | Phase 8 | 4h |
| **10** | WebUI: Agent-Dashboard + Detail-Seite | Phase 3 | 6h |
| **11** | Security Hardening: TLS, Topic-ACLs, Audit-Log | Phase 8 | 4h |

**Geschätzter Gesamtaufwand:** ~62h

## 16. Was der Agent NICHT ist

| Der Agent ist NICHT | Begründung |
|---------------------|-----------|
| Pflicht für Alfred | Alles funktioniert ohne Agents, API-Fallback immer verfügbar |
| Ein LLM-Runtime | Kein LLM auf dem Agent, nur Datensammlung + Execution |
| Ein Backup-System | Kann Backups triggern, ist aber kein Backup-Management |
| Ein Config-Management | Kann Commands ausführen, aber kein deklaratives State-Management (Ansible/Chef) |
| Ein vollständiges Monitoring (Prometheus) | Sammelt Basis-Metriken, ersetzt kein dediziertes Monitoring |
| Windows/macOS-kompatibel (Phase 1) | Linux-only im MVP, Plattform-Abstraktion für spätere Erweiterung |

## 17. Offene Entscheidungen

| Entscheidung | Optionen | Empfehlung |
|-------------|---------|-----------|
| Agent-Runtime | Node.js (gleiche Codebase) vs. Go Binary (kleiner) | Node.js — gleiche Codebase, gleiche Skills, einfacher zu entwickeln |
| Telemetrie-History | DB-Tabelle vs. InfluxDB vs. nur letzter Snapshot | MVP: letzter Snapshot. Phase 2: InfluxDB wenn vorhanden |
| Agent-Auto-Discovery | UDP Broadcast (wie Cluster) vs. manuell | Manuell (init --broker). UDP optional für LAN-Discovery |
| MQTT vs. WebSocket | MQTT (bestehend) vs. WebSocket (simpler) | MQTT — bereits im Stack, QoS-Support, Topic-Routing |
