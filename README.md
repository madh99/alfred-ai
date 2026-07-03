<p align="center">
  <img src="https://img.shields.io/badge/version-0.19.0--multi--ha.960-blue" alt="Version">
  <img src="https://img.shields.io/badge/node-%3E%3D20-green" alt="Node">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
  <img src="https://img.shields.io/badge/typescript-5.7+-blue" alt="TypeScript">
</p>

<pre align="center">
 â–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ•— â–ˆâ–ˆâ•—     â–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ•—â–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ•— â–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ•—â–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ•—
â–ˆâ–ˆâ•”â•â•â–ˆâ–ˆâ•—â–ˆâ–ˆâ•‘     â–ˆâ–ˆâ•”â•â•â•â•â•â–ˆâ–ˆâ•”â•â•â–ˆâ–ˆâ•—â–ˆâ–ˆâ•”â•â•â•â•â•â–ˆâ–ˆâ•”â•â•â–ˆâ–ˆâ•—
â–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ•‘â–ˆâ–ˆâ•‘     â–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ•—  â–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ•”â•â–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ•—  â–ˆâ–ˆâ•‘  â–ˆâ–ˆâ•‘
â–ˆâ–ˆâ•”â•â•â–ˆâ–ˆâ•‘â–ˆâ–ˆâ•‘     â–ˆâ–ˆâ•”â•â•â•  â–ˆâ–ˆâ•”â•â•â–ˆâ–ˆâ•—â–ˆâ–ˆâ•”â•â•â•  â–ˆâ–ˆâ•‘  â–ˆâ–ˆâ•‘
â–ˆâ–ˆâ•‘  â–ˆâ–ˆâ•‘â–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ•—â–ˆâ–ˆâ•‘     â–ˆâ–ˆâ•‘  â–ˆâ–ˆâ•‘â–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ•—â–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ•”â•
â•šâ•â•  â•šâ•â•â•šâ•â•â•â•â•â•â•â•šâ•â•     â•šâ•â•  â•šâ•â•â•šâ•â•â•â•â•â•â•â•šâ•â•â•â•â•â•
</pre>

<p align="center">
  <strong>Self-hosted AI assistant for Telegram, Discord, WhatsApp, Matrix, Signal, Microsoft Teams & HTTP API</strong>
</p>

<p align="center">
  Alfred is a self-hosted AI assistant that connects to Telegram, Discord, WhatsApp, Matrix, Signal, and Microsoft Teams simultaneously â€” plus an HTTP API for CLI and web access. It remembers who you are across platforms, learns from every conversation, thinks proactively about your life, and executes real-world tasks through 90+ skills â€” from managing your BMW to controlling your smart home to planning your week.
</p>

---

## Why Alfred?

I built Alfred because I wanted a single AI assistant I could reach from any messaging app â€” without losing context when switching between them.

- **Cross-Platform Identity** â€” Link your accounts across Telegram, Matrix, Discord, WhatsApp, and Signal. Alfred recognizes you as the same person. Memories, preferences, and conversation context carry over.
- **Persistent Memory + Knowledge Graph** â€” Automatically extracts and stores facts, preferences, and context from conversations. Builds a Knowledge Graph with entities, relations, and cross-domain connections. Semantic search via pgvector embeddings. Memory consolidation via LLM-based dreaming.
- **Proactive Reasoning** â€” Thinks autonomously every 30 minutes. Analyzes 20+ data sources (calendar, email, BMW, smart home, weather, energy prices, CMDB). Proposes actions, creates multi-step plans, detects conflicts.
- **Autonomous Planning** â€” Recognizes complex scenarios (trip + charging + weather + logistics) and creates executable multi-step plans with checkpoints for user approval. LLM re-evaluates after each step.
- **90+ Skills** â€” Goes beyond chat. Manages infrastructure (Proxmox, UniFi, MikroTik, Home Assistant, Docker), vehicles (BMW CarData + MQTT), backup systems (Commvault, System Backup), CMDB/ITSM, emails, calendars, code agents, and more.
- **Any LLM** â€” Works with Claude, GPT-5, Gemini, Ollama, or any OpenAI-compatible endpoint. Different models can be assigned to different task tiers. Runs fully local if needed.
- **Self-Hosted** â€” All data stays on your machine. SQLite for single-instance, PostgreSQL + Redis + MinIO for HA cluster. No cloud dependency, no telemetry.

---

## Features

### Messaging Platforms

| Platform | Library | Features |
|----------|---------|----------|
| **Telegram** | grammy | Text, voice, images, files, inline keyboards, message editing |
| **Discord** | discord.js | Text, embeds, files, reactions |
| **WhatsApp** | baileys | Text, images, files, voice |
| **Matrix** | matrix-bot-sdk | Text, images, files, voice, end-to-end encryption capable |
| **Signal** | signal-cli REST | Text, attachments |
| **Microsoft Teams** | Bot Framework | Text, adaptive cards, proactive messaging, cluster-aware |
| **HTTP API** | built-in | REST + SSE streaming, CORS-ready for web UIs |
| **CLI** | built-in | Interactive terminal, auto-connects to running server |

### LLM Providers

| Provider | Models | API Key Required |
|----------|--------|:---:|
| **Anthropic** | Claude Opus 4.6, Sonnet 4.6, Haiku 4.5 | Yes |
| **OpenAI** | GPT-5, GPT-4.5, GPT-4o, o3 | Yes |
| **Google** | Gemini 3.1 Pro, Gemini 2.5 Flash | Yes |
| **Mistral** | Mistral Large, Medium, Small, Codestral | Yes |
| **OpenRouter** | 200+ models via unified API | Yes |
| **Ollama** | Llama, Mistral, Phi, any local model | No |
| **Open WebUI** | Any OpenAI-compatible endpoint | Configurable |

**Multi-Model Routing** â€” Configure different models for different tasks:

```yaml
llm:
  default:
    provider: anthropic
    model: claude-sonnet-4-6-20260320
  strong:
    provider: anthropic
    model: claude-opus-4-6-20260320
  fast:
    provider: google
    model: gemini-2.5-flash
  local:
    provider: ollama
    model: llama3.2
```

### Mistral AI Dienste (optional)

Alfred kann Mistral AI Dienste unabhÃ¤ngig vom Haupt-LLM-Provider nutzen â€” z.B. Claude als Haupt-LLM + Mistral fÃ¼r OCR und Moderation:

| Dienst | Modell | ENV-Variable | Beschreibung |
|---|---|---|---|
| API-Key | â€” | `ALFRED_MISTRAL_API_KEY` | EigenstÃ¤ndiger Key fÃ¼r alle Mistral-Dienste |
| Embeddings | `mistral-embed` | `ALFRED_LLM_EMBEDDINGS_PROVIDER=mistral` | Semantic Memory Search |
| OCR | `mistral-ocr-latest` | Automatisch bei Mistral-Key | PDF/Bild â†’ strukturierter Markdown (Handschrift, Tabellen, Rechnungen) |
| STT | `voxtral-mini-2602` | `ALFRED_STT_PROVIDER=mistral` | Voice-Messages â†’ Text |
| TTS | `voxtral-mini-tts-2603` | `ALFRED_TTS_PROVIDER=mistral` | Text â†’ Sprache, Voice Cloning |
| Voice Cloning | `voxtral-mini-tts-2603` | `ALFRED_VOICE_MANAGEMENT=true` | Eigene Stimmen aus Audio-Samples erstellen |
| Moderation | `mistral-moderation-latest` | `ALFRED_MODERATION_ENABLED=true` | Content-Safety fÃ¼r Input + Output |
| Sonos-Durchsagen | TTS + Sonos | `ALFRED_TTS_VOICE_ID=<voice-id>` | TTS-Audio direkt auf Sonos abspielen |

Kein Dienst ist eine Pflicht-AbhÃ¤ngigkeit. Alfred funktioniert ohne Mistral-Key wie bisher. Der Key wird automatisch an alle Dienste weitergereicht wenn deren Provider auf `mistral` steht.

### Built-in Skills (90+)

Alfred exposes capabilities as **skills** â€” tools the LLM can call autonomously based on your request.

| Category | Skills | Description |
|----------|--------|-------------|
| **Memory** | `memory`, `note`, `profile` | Persistent storage, recall, semantic search (pgvector). Memory consolidation (LLM-based dreaming), temporal decay, embedding cleanup. Entity/fact protection, connection-memories, insight-preference learning |
| **Communication** | `email`, `cross_platform`, `delegate` | Send/read/forward emails (IMAP/SMTP or Microsoft 365 Graph API, multi-account), reply drafts, PDF/DOCX attachment reading, cross-platform messaging, autonomous sub-agents with task-filtered tool sets |
| **Contacts** | `contacts` | CardDAV, Google People API, Microsoft Graph â€” search, create, update, delete contacts |
| **Scheduling & Automation** | `reminder`, `scheduled_task`, `background_task`, `todo`, `microsoft_todo`, `watch`, `workflow`, `briefing` | Timed reminders, cron jobs, long-running tasks (persistent checkpoint/resume), local todo lists, Microsoft To Do (Graph API), condition-based alerts with actions, watch chains, quiet-hours, workflow chains (multi-step skill pipelines with if/else branching), Morgenbriefing, self-healing, learning feedback loop |
| **Information** | `web_search`, `weather`, `system_info`, `calculator`, `feed_reader`, `youtube`, `recipe` | Brave/Tavily/SearXNG/DuckDuckGo search, weather, RSS/Atom feeds, YouTube (Suche, Transkripte, Channel-Monitoring), Rezeptsuche (Spoonacular/Edamam/Open Food Facts) |
| **Documents** | `document` | PDF, DOCX, TXT, CSV, Markdown â€” RAG with semantic search. OCR via Mistral |
| **Code** | `code_sandbox`, `code_agent`, `project_agent` | Sandboxed JS/Python execution, CLI coding agent orchestration, autonomous project agent |
| **Infrastructure** | `proxmox`, `unifi`, `homeassistant`, `docker`, `bmw`, `monitor`, `database`, `mqtt`, `mikrotik`, `commvault` | Proxmox VE cluster, UniFi network, Home Assistant smart home, Docker containers, BMW CarData (REST + MQTT Streaming + Reifendiagnose + Fahrzeugbild), health checks, MQTT pub/sub, **MikroTik RouterOS** (34 Actions: Monitoring, Firewall, NAT, DHCP, Routing, Troubleshooting, Multi-Router), **Commvault** (15 Actions: Jobs, Clients, Storage, Alerts, SLA Reports, LLM-Analyse, Auto-Retry, ITSM-Integration) |
| **Infra Pipeline** | `cloudflare_dns`, `nginx_proxy_manager`, `pfsense`, `deploy` | Cloudflare DNS (Zonen, Records, Multi-Level TLD), Nginx Proxy Manager (Hosts, SSL), pfSense Firewall (Rules, VLANs, Gateways), SSH-basiertes Deployment mit Full Orchestrator (VM/LXC erstellen â†’ Deploy â†’ DNS â†’ Proxy â†’ Firewall) |
| **CMDB & ITSM** | `cmdb`, `itsm`, `infra_docs` | Configuration Management Database (Auto-Discovery aus 8 Infra-Skills inkl. MikroTik), Incident/Change/Service Management, Impact-Analysis, InfraDocs (Inventar, Topologie, Runbooks) |
| **Backup** | `system_backup`, `database` (backup/restore) | System-Backup (Alfred DB + Tokens + Config, Zeitplan, Retention, S3/MinIO), Database-Backup fÃ¼r alle 7 Provider (PG, MySQL, MS SQL mit Backup-Ketten, SQLite, MongoDB, Redis, InfluxDB) |
| **Navigation & Travel** | `routing`, `transit_search`, `travel` | Google Routes API (Live-Traffic), Ã–ffentlicher Nahverkehr Ã–sterreich (HAFAS), Flugsuche & Reiseplanung (Kiwi/Booking.com) |
| **Energy** | `energy_price`, `goe_charger` | Echtzeit-Strompreise (aWATTar HOURLY, EPEX Spot AT), go-e Charger Wallbox-Steuerung |
| **Finance** | `crypto_price`, `bitpanda`, `trading` | CoinGecko Preise, Bitpanda Portfolio/Trades, Crypto-Trading auf 110+ Exchanges (CCXT) |
| **Marketplace & Shopping** | `marketplace`, `shopping` | willhaben.at + eBay Suche, Preisvergleich, Watch-Alerts, Geizhals |
| **Files & System** | `file`, `clipboard`, `screenshot`, `shell`, `http` | Read/write files, clipboard, screenshots, shell commands, HTTP requests |
| **Media** | `browser`, `tts`, `image_generate`, `spotify`, `sonos`, `voice` | Puppeteer browsing, TTS, AI image generation, Spotify (OAuth PKCE), Sonos (UPnP + Cloud), Voice Cloning (Mistral Voxtral) |
| **Calendar** | `calendar` | CalDAV, Google Calendar, Microsoft Calendar â€” find_free_slot, check_conflicts, Duplikat-PrÃ¤vention |
| **Productivity** | `onedrive`, `brainstorming` | Microsoft OneDrive (Graph API), KG-gestÃ¼tztes Brainstorming mit persistenten Sessions |
| **Admin** | `configure`, `onboarding` | Service-Konfiguration per Chat, gefÃ¼hrte Ersteinrichtung fÃ¼r neue User |
| **Multi-User** | `user_management`, `sharing`, `help` | Roles (admin/user/family/guest/service), invite codes, platform linking, per-user service config, sharing |

### Code Agent Orchestration

Delegate coding tasks to external CLI agents â€” Alfred plans, splits, parallelizes, and validates.

```
You: "Refactor the auth module to use JWT instead of sessions"
Alfred â†’ code_agent orchestrate:
  1. Planning: LLM splits task into subtasks
  2. Execution: Parallel agent runs (Claude Code, Codex, Aider, Gemini CLI)
  3. Validation: LLM reviews results, retries if needed
  4. Git: Auto-branch, commit, push, and create PR/MR
```

Supported agents are auto-detected during setup: **Claude Code**, **Codex**, **Aider**, **Gemini CLI**, or any custom CLI tool. Auto-creates working directories and handles permission management for non-root execution.

**Forge Integration** â€” Automatically creates branches, commits, pushes, and opens Pull Requests (GitHub) or Merge Requests (GitLab). Owner/repo is detected from `git remote` at runtime â€” no manual config needed.

### Project Agent (Autonomous Software Development)

Build entire software projects via chat. Alfred plans, codes, validates, fixes, and commits â€” autonomously.

```
You: "Erstelle eine REST API fÃ¼r Todo-Items mit Express und TypeScript in ~/projects/api"
Alfred: "ðŸš€ Project Agent gestartet."
Alfred: "ðŸ“‹ Plan: 1) Setup 2) Models+Routes 3) Auth 4) Tests"
Alfred: "ðŸ”¨ Phase 1: claude-code arbeitet..."
Alfred: "âœ… Build passed. 4 Dateien. Commit: a3f21b7"
Alfred: "ðŸ”¨ Phase 2..."
You: "FÃ¼ge JWT Auth hinzu"
Alfred: "ðŸ“ Eingereiht. Wird in der nÃ¤chsten Phase berÃ¼cksichtigt."
You: "Stopp"
Alfred: "â¹ Gestoppt. 12 Dateien, 5 Commits, Build: passing."
```

**How it works:**
1. LLM decomposes the goal into ordered build phases
2. For each phase: code agent (Claude Code/Codex) implements, build validator checks (`npm install && build && test`)
3. On failure: error output fed back to code agent for automatic fix (up to 3 attempts)
4. On success: auto-commit + progress update via Telegram
5. User can interject requirements mid-execution or stop at any time
6. Survives process restarts via checkpoint/resume

```yaml
projectAgents:
  enabled: true
  defaultMaxDurationHours: 8
  maxFixAttemptsPerIteration: 3
  templates:
    - name: nextjs
      buildCommands: ["npm install", "npm run build"]
      testCommands: ["npm test"]
```

### Multi-User

Alfred supports multiple users with role-based access control. Each user's data (notes, todos, memories, conversations, documents) is fully isolated.

| Role | Access |
|------|--------|
| **admin** | All skills, user management, service sharing |
| **user** | 30+ skills incl. file, code_sandbox, document, scheduled_task, sharing |
| **family** | Productivity skills incl. file, document, scheduled_task |
| **guest** | Basic skills (weather, search, calculator, routing) â€” no data access |
| **service** | Minimal (calculator, weather, search) |

**Data Isolation** â€” Non-admin users cannot access admin's Email, Calendar, Contacts, BMW, or Microsoft Todo. Each user must configure their own services.

**Per-User Service Config** â€” Each user configures their own Email, Calendar, Contacts, BMW, Microsoft Todo via chat (`setup_service`). Known email providers (GMX, Gmail, Yahoo, Outlook, iCloud, web.de, etc.) are auto-configured â€” only email + password needed. Microsoft 365 via Device Code Flow (`auth_microsoft`) â€” user signs in at microsoft.com/devicelogin, all services auto-configured. No server access required.

**Sharing** â€” Share notes, todo lists, documents, or service configs between users. MS 365 shared mailboxes/calendars supported via Graph API delegated access.

### High Availability (optional)

Active-Active cluster â€” all nodes are equal, work is split automatically via PostgreSQL atomic claims. No single point of failure.

```yaml
storage:
  backend: postgres
  connectionString: postgres://alfred:pass@db:5432/alfred
cluster:
  enabled: true
  nodeId: node-1
  redisUrl: redis://redis:6379
fileStore:
  backend: s3
  s3Endpoint: http://minio:9000
  s3Bucket: alfred-files
```

- **Active-Active** â€” All nodes run schedulers. `FOR UPDATE SKIP LOCKED` splits work atomically. No duplicates.
- **Adapter Claims** â€” Messaging adapters (Telegram, Discord, etc.) claimed by one node. Automatic failover on death.
- **Message Dedup** â€” Every inbound message processed exactly once via `processed_messages` table.
- **PostgreSQL** â€” Shared database, atomic coordination (replaces Redis locks). SQLite remains default for single-instance.
- **Redis** â€” Heartbeat, pub/sub, cross-node messaging (optional supplement â€” PG heartbeat as fallback).
- **S3/MinIO** â€” Shared file storage for uploads, documents, and generated files. File Skill supports `read_store`/`write_store`/`list_store` for S3 access. Code Sandbox auto-saves generated files (PDF, DOCX, Excel) to S3. Email attachments can be sent directly from S3.
- **`alfred migrate-db`** â€” Migrate existing SQLite data to PostgreSQL.

### Infrastructure Management

#### Proxmox VE

Full Proxmox API integration â€” manage your hypervisor cluster through natural language:

- Cluster status, nodes, storage overview
- List, start, stop, shutdown, reboot VMs and containers
- Snapshots: create, restore, delete
- Backup (vzdump), migration between nodes
- Task monitoring

```
You: "Show me all running VMs"
You: "Snapshot vm 101 before the update"
You: "Migrate container 200 to node pve2"
```

#### UniFi Network

Full UniFi controller integration â€” manage your network infrastructure:

- Devices, clients, WLANs, networks overview
- Adopt, restart, upgrade devices
- Block/unblock clients, reconnect clients
- DPI statistics, alerts, events
- Create guest WiFi vouchers

Supports **API Key** (UniFi OS 4.x+) and **Username/Password** authentication with auto-detection of UniFi OS vs. Classic Controller.

```
You: "How many clients are online?"
You: "Create 5 guest vouchers for 24 hours"
You: "Block the device with MAC aa:bb:cc:dd:ee:ff"
```

#### Home Assistant

Smart home control via the Home Assistant REST API â€” 27 actions:

- List all entities or filter by domain (lights, sensors, switches)
- Turn on, turn off, toggle devices
- Call any service with custom parameters
- View entity state history and logbook
- List available services and system config
- **Areas** â€” List rooms/zones and their entities (via Jinja2 templates)
- **Presence** â€” Who is home? Person entity status at a glance
- **Scenes & Automations** â€” Activate scenes, trigger/enable/disable automations, run scripts
- **Config API** â€” Create, update, and delete automations, scripts, and scenes directly via chat
- **Notifications** â€” Send notifications to mobile apps or other targets
- **Calendar Events** â€” Query HA calendar entities with time range
- **Templates** â€” Execute arbitrary Jinja2 queries for maximum flexibility
- **Briefing Summary** â€” Kompakte Ãœbersicht fÃ¼r Morgenbriefing: offene Kontakte, Lichter an, Batterie/SoC, Energie, Klima, Anwesenheit. Konfigurierbar per Entity-/Domain-Filter
- **Energy Stats** â€” Energieverbrauch-Statistiken: Auto-Discovery aller Energie-Sensoren, Verbrauchsberechnung Ã¼ber History-API, freundliche ZeitrÃ¤ume (heute, gestern, diese/letzte Woche/Monat)
- **Error Log** â€” View the Home Assistant error log

Uses **Long-Lived Access Tokens** for authentication (Settings â†’ Security â†’ Long-Lived Access Tokens).

```
You: "Show me all lights"
You: "Turn off light.wohnzimmer"
You: "Who is home?"
You: "What's going on in the living room?"
You: "Activate movie night scene"
You: "Create an automation that turns on the porch light at sunset"
You: "Show me calendar events for tomorrow"
```

#### Contacts

Manage contacts from CardDAV, Google People API, or Microsoft Graph:

```
You: "Search for John in my contacts"
You: "Add a new contact: Jane Doe, jane@example.com, +1-555-0123"
You: "Show me the details for contact abc123"
You: "Delete contact abc123"
```

Supports CardDAV (Nextcloud, Radicale, etc.), Google Contacts, and Microsoft 365.

#### Todo Lists

**Local** â€” Persistent todo lists stored in SQLite, always available without external service.

**Microsoft To Do** â€” Full Graph API integration for Microsoft To Do. Lists and tasks sync with the Microsoft To Do app across all devices. List resolution by display name â€” say *"fÃ¼ge Milch zur Einkaufsliste hinzu"* and Alfred finds the right list automatically. Configured automatically via `alfred auth microsoft`.

```
You: "Add a todo: Buy groceries"
You: "FÃ¼ge Milch zur Einkaufsliste hinzu"
You: "Show my Microsoft To Do lists"
You: "Complete todo abc123"
```

#### Docker

Full Docker Engine API integration â€” manage containers, images, volumes, and networks:

```
You: "Show all running containers"
You: "Show logs for container myapp"
You: "Pull the latest nginx image"
You: "Restart container myapp"
You: "Show Docker system info"
You: "Prune unused images and containers"
```

Connects via Unix socket (default) or TCP. Supports Docker Compose operations.

#### BMW CarData

Vehicle data from your BMW via the BMW CarData Customer API â€” REST + MQTT Streaming:

- **Status:** SoC, Reichweite, SoH, Kilometerstand, GPS-Position (Reverse Geocoding), TÃ¼ren/Fenster/Kofferraum, Verriegelung
- **Charging:** Ladestatus, Leistung (kW), Restzeit, Ziel-SoC, Plug/Flap, AC Volt/Ampere
- **History:** Ladehistorie (chunked fÃ¼r lange ZeitrÃ¤ume), Verbrauchsstatistik (kWh/100km)
- **Reifendiagnose:** Smart Maintenance Tyre Diagnosis â€” Dimension, VerschleiÃŸ, Defekte, Montage-Datum fÃ¼r alle 4 RÃ¤der + eingelagerte Reifen
- **Fahrzeugbild:** PNG-Bild vom Fahrzeug
- **Basisdaten:** Modell, Farbe, Baujahr, Antrieb, SA-Codes
- **MQTT Streaming:** Echtzeit-Daten Ã¼ber MQTT (68+ Datenpunkte: GPS, TÃ¼ren, Fenster, Reifendruck, Alarm, Preconditioning). Cluster-aware mit HA-Failover

OAuth Device Authorization Flow mit PKCE (S256). Container-basierter Telematik-Zugriff. 3-Tier Lookup: RAM â†’ DB â†’ REST. MQTT Token-Refresh alle 60s. Rate-Limit-Handling (CU-429). Graceful Degradation bei API-AusfÃ¤llen.

```
You: "BMW Status"
You: "Zeig mir den Ladestatus"
You: "BMW Reifendiagnose"
You: "Zeig mir die letzten LadevorgÃ¤nge"
You: "Zeig mir die Fahrzeugdaten"
```

#### Routing (Google Routes API)

Route calculation with live traffic data:

- Distance, duration, traffic delay
- Departure time recommendation for a desired arrival time
- Supports addresses and lat/lng coordinates
- Travel modes: DRIVE, BICYCLE, WALK, TRANSIT
- Address aliases ("zuhause", "BÃ¼ro") are resolved by the LLM from memory â€” no config needed

```
You: "Wie weit ist es von Altlengbach nach Wien?"
You: "Wann muss ich losfahren um um 9 Uhr im BÃ¼ro zu sein?"
```

The LLM combines BMW + Routing skills intelligently for questions like *"Schaffe ich es mit dem Auto ins BÃ¼ro ohne Laden?"*

#### Public Transit (Austria)

Public transit routing for all of Austria via hafas-client (Ã–BB profile). No API key needed â€” auto-registered on startup.

- Stop search, journey planning, departure boards
- Covers Ã–BB trains, Wiener Linien (U-Bahn, Tram, Bus), S-Bahn, Postbus, regional transit
- Real-time delay information

```
You: "Wann fÃ¤hrt die nÃ¤chste U-Bahn von Stephansplatz?"
You: "Wie komme ich von Altlengbach nach Wien Hauptbahnhof?"
You: "Zeig mir die Abfahrten am Westbahnhof in den nÃ¤chsten 20 Minuten"
```

#### Energy Prices (aWATTar HOURLY)

Real-time electricity prices based on EPEX Spot AT market data via aWATTar API. No API key needed.

- Current price with full breakdown (market price, grid fees, taxes)
- Hourly prices for today/tomorrow, cheapest hours, daily averages
- 9 Austrian grid areas with default rates (configurable via `ALFRED_ENERGY_GRID_AREA`)
- Automatic 3% surcharge handling (drops after 01.04.2026 per ElWG Â§21)

```
You: "Was kostet Strom gerade?"
You: "Wann ist Strom heute am gÃ¼nstigsten?"
You: "Zeig mir die Strompreise fÃ¼r morgen"
```

#### Marketplace (willhaben.at + eBay)

Structured marketplace search on willhaben.at and eBay. willhaben works without credentials (parses `__NEXT_DATA__` from HTML), eBay requires API keys (Browse API, OAuth Client Credentials).

- **search**: Lists matching listings with structured JSON data (watch-compatible) + Markdown display
- **compare**: Price statistics (min, max, median, avg) + cheapest 5 listings
- **detail**: Single listing deep-dive â€” description, photos, seller info, attributes
- **Filters**: `sort` (price_asc/price_desc/date_desc), `condition` (new/used), `postcode`
- **Watch-kompatibel**: `searchâ†’"count"/"minPrice"`, `compareâ†’"minPrice"/"avgPrice"` â€” Alerts bei neuen Inseraten oder Preisdrops

```
You: "Zeig mir alle RTX 5090 auf willhaben"
You: "Vergleich RTX 5090 Preise auf willhaben"
You: "Suche iPhone 16 Pro auf eBay und willhaben"
You: "Zeig mir Details zum Inserat 123456"
You: "Beobachte RTX 4070 unter 400â‚¬ auf Willhaben"
```

#### YouTube

YouTube video search, transcripts, and channel monitoring via YouTube Data API v3.

- **search**: Suche nach Videos (Top N Ergebnisse mit Titel, Channel, Datum)
- **info**: Video-Details (Titel, Dauer, Views, Likes, Beschreibung)
- **transcript**: Transkript-Extraktion mit Timestamps (self-hosted via `youtube-transcript` npm, Supadata als optionaler Fallback)
- **channel**: Letzte Videos eines Channels (Watch-kompatibel: `newCount`)

```
You: "Suche YouTube Videos Ã¼ber TypeScript Patterns"
You: "Fasse dieses Video zusammen: https://youtube.com/watch?v=abc123"
You: "Zeig mir die neuesten Videos von Fireship"
You: "Erstelle einen Watch: PrÃ¼fe den YouTube Channel Fireship alle 2 Stunden auf neue Videos"
```

Requires a YouTube Data API v3 key (free, 10,000 units/day). Transcripts are extracted locally without API key. Optional Supadata fallback for AI-generated transcripts.

#### Daily Briefing

Parallel morning briefing that gathers data from all available skills in a single call. Auto-detects which modules are available based on your configuration.

- Calendar, weather, todos, emails, energy prices, BMW status, smart home (kompakte Ãœbersicht), infrastructure
- All data fetched in parallel (~5s instead of ~30s with sequential tool calls)
- **LLM-frei als Scheduled Task** â€” Briefing wird direkt ausgefÃ¼hrt ohne LLM-Overhead ($0.00 statt ~$0.016 pro AusfÃ¼hrung)
- Regelbasierte Actionable Highlights (BMW-Akku, Infrastruktur, Strompreise, Termine)
- **Moâ€“Fr automatic commute check**: Routes home â†’ office, checks BMW battery, warns if low
- Skips commute routing when calendar shows an external appointment (physical location)
- Virtual meetings (Teams, Zoom, Meet) are not treated as external appointments

```
You: "Morgenbriefing"
You: "Erstelle ein tÃ¤gliches Briefing um 7 Uhr"
You: "Briefing nur mit Kalender, Wetter und Todos"
```

### Autonomous Automation

Alfred doesn't just alert â€” it acts. Watches monitor conditions and execute skills automatically.

**Watch-Actions** â€” "If X then do Y" without LLM involvement:
```
You: "Wenn Strompreis unter 15ct, schalte Wallbox ein"
Alfred â†’ watch:
  - Polls energy_prices every 15 min
  - Condition: bruttoCt < 15
  - Action: home_assistant turn_on switch.wallbox
  - Mode: alert_and_action (notify + execute)
```

**Composite Conditions** â€” AND/OR logic over multiple fields:
```
You: "Wenn Strom gÃ¼nstig UND Auto unter 80%, lade"
Alfred â†’ watch with conditions:
  - AND(energy.bruttoCt < 15, bmw.soc < 80)
  - Action: home_assistant turn_on switch.wallbox
```

**Human-in-the-Loop** â€” Confirmation before risky actions (Telegram: Inline Buttons):
```
Alfred: "âš¡ Strompreis unter 15ct. Soll ich die Wallbox einschalten?"
       [âœ… Approve] [âŒ Reject]
You: *clicks Approve*
Alfred: "âœ… Aktion ausgefÃ¼hrt: Wallbox eingeschaltet"
```

**Watch Chains** â€” Multi-step automations by chaining watches:
```
You: "Wenn Strom gÃ¼nstig, prÃ¼fe BMW Akku â€” wenn unter 80%, Wallbox ein"
Alfred â†’ Watch A (energy check) triggers Watch B (BMW check):
  - Watch A: energy_prices bruttoCt < 10 â†’ trigger_watch â†’ Watch B
  - Watch B: bmw battery < 80 â†’ action: turn_on switch.wallbox
  - Each watch keeps its own cooldown
  - Chain depth limited to 5 (prevents cycles)
```

**Workflow Branching** â€” If/else logic in multi-step workflows:
```
You: "Erstelle Workflow: Wetter prÃ¼fen, wenn Regen â†’ Schirm-Erinnerung, sonst â†’ Fahrradroute"
Alfred â†’ workflow with condition step:
  - Step 0: weather (get conditions)
  - Step 1: condition (prev.rain eq "true") â†’ then: 2, else: 3
  - Step 2: reminder ("Regenschirm!") â†’ jumpTo: end
  - Step 3: routing (mode: bike) â†’ jumpTo: end
```

**Inbound Webhooks** â€” Trigger watches in real-time via HTTP:
```yaml
webhooks:
  - name: github-deploy
    secret: "your-hmac-secret"
    watchId: "watch-id-to-trigger"
```
External systems send `POST /api/webhook/github-deploy` with HMAC-SHA256 signature â†’ watch executes immediately.

**Calendar Lead-Time** â€” Proactive reminders before events:
```yaml
calendar:
  vorlauf:
    enabled: true
    minutesBefore: 15
```

**Reasoning Engine** â€” Cross-domain analysis with proactive insights AND actions:
```
Alfred: "ðŸ’¡ Strompreis ist bis 15:00 unter 5 ct/kWh â€” BMW laden wÃ¤re jetzt
gÃ¼nstig (Akku war beim letzten Check bei 45%).
Soll ich die Wallbox einschalten?"
       [âœ… Approve] [âŒ Reject]
```
Aggregates calendar, todos, watches, memories, weather, energy prices, activity, and user feedback.
Runs 3x/day (configurable), one LLM call per pass (~$0.80/month with Haiku).
Can propose structured actions (skill execution, reminders) â€” always with human confirmation.

**Learning Feedback Loop** â€” Alfred learns from corrections and rejections:
```
User rejects "Wallbox einschalten" 3x â†’ Alfred stores behavioral feedback:
  "Watch 'Wallbox' wurde 3Ã— abgelehnt. Schwellenwert Ã¼berprÃ¼fen."
  â†’ Feedback appears in LLM system prompt as "Behavior Feedback"
  â†’ Reasoning Engine considers feedback in future passes

User: "Nein, nicht so â€” beim nÃ¤chsten Mal nur benachrichtigen"
  â†’ Correction detected â†’ stored as feedback memory
```

### Knowledge Graph

Alfred builds and maintains a Knowledge Graph from all data sources â€” entities, relations, cross-domain connections:

- **Entities:** Persons, locations, organizations, vehicles, items, metrics, events â€” with attributes, confidence scores, sources
- **Relations:** family, works_at, owns, plays_at, lives_at, monitors, etc. â€” with strength, context, bidirectional aliases
- **Sources:** 15+ extractors (chat, email, calendar, BMW, SmartHome, crypto, feeds, CMDB, memories, documents)
- **LLM Entity Linker:** Daily + weekly analysis (Mistral) â€” finds semantic connections, proposes new entities/relations, enriches attributes
- **Family Inference:** Transitive relations (spouse+parentâ†’parent, parent+parentâ†’sibling, grandparent, aunt/uncle)
- **CMDB Sync:** Infrastructure assets as KG entities with cross-domain relations
- **WebUI Visualization:** Force-directed graph with node selection, editing, filtering by type
- **Maintenance:** Automatic dedup, decay, phantom detection, org-variant merging

```
You: "Zeig mir den Knowledge Graph"
You: "Wer ist mit wem verwandt?"
You: "Analysiere den Knowledge Graph"
```

### Proactive Reasoning

Alfred thinks autonomously every 30 minutes â€” analyzing 20+ data sources and proposing actions:

- **Context:** Calendar, email, BMW, SmartHome, weather, energy prices, crypto, CMDB, ITSM, MikroTik, Commvault, feeds, memories, KG connections, active plans, trends
- **Two-Pass Architecture:** Quick scan (512 tokens) â†’ enrichment topics â†’ detailed analysis (1536 tokens)
- **Actions:** execute_skill, create_reminder, workflow/watch create, delegate, ITSM incidents, CMDB discovery, **multi-step plans**
- **Autonomy Levels:** `confirm_all` (default), `proactive`, `autonomous` â€” configurable, learned from feedback
- **BMW Ladeplanung:** Automatische SoC-Berechnung vor Fahrten, Wallbox-Ladefenster-Vorschlag, Schnelllader-Fallback
- **Delivery Scheduling:** Activity-profil-basiert, Deferred Queue fÃ¼r Nachtruhe
- **Event-Triggered:** Watches, Kalender-Events, externe Webhooks kÃ¶nnen Reasoning-Passes auslÃ¶sen

### Autonomous Multi-Step Planning

Alfred's killer feature â€” recognizes complex scenarios and creates executable plans:

```
Scenario: Friday appointment in Weinburg + Thursday Noah pickup from Kapfenberg

Alfred creates a Plan:
ðŸ“‹ Plan: Weinburg-Gutachten vorbereiten

â¬œ 1. Route Do: Altlengbach â†’ Kapfenberg berechnen (AUTO)
â¬œ 2. Route Fr: Altlengbach â†’ Weinburg berechnen (AUTO)
â¬œ 3. BMW SoC prÃ¼fen â€” reicht Reichweite? (AUTO)
âš ï¸ 4. Ladefenster heute Nacht vorschlagen (CHECKPOINT â€” deine BestÃ¤tigung)
â¬œ 5. Wetter Fr prÃ¼fen (AUTO)
ðŸ”” 6. Reminder "Noah abholen" erstellen (PROACTIVE)
ðŸ”” 7. Reminder "Abfahrt Weinburg" erstellen (PROACTIVE)

âœ… = lÃ¤uft automatisch | âš ï¸ = pausiert fÃ¼r deine Entscheidung | ðŸ”” = lÃ¤uft mit Benachrichtigung
```

- **3 Risk-Levels:** AUTO (no confirmation), CHECKPOINT (pauses for user), PROACTIVE (runs with notification)
- **LLM Re-Evaluation:** After every 3rd step, the LLM checks if the plan still makes sense
- **Persistent:** Plans survive restarts (stored in DB), visible in reasoning context
- **Template Resolution:** Steps can reference results from previous steps: `{{step_0.distance_km}}`

### Backup & Restore

Two components â€” Database Skill extension + System Backup Skill:

- **System Backup:** Alfred DB (PG/SQLite) + Token files + Config. Scheduled (cron), configurable retention, S3/MinIO upload, labels, permanent backups
- **Database Backup:** All 7 providers â€” PostgreSQL (`pg_dump`), MySQL, MS SQL (Backup-Ketten: copy_only/full/differential/log), SQLite, MongoDB, Redis, InfluxDB
- **Restore:** Configurable â€” default CLI-only, optionally per Chat with Confirmation Queue
- **Chat Interface:** `mach ein backup`, `backup liste`, `backup status`, `setze retention auf 14 tage`

### Cross-Platform Identity

Link your identity across platforms so Alfred treats you as one person:

```
# On Telegram:
You: "Link my account"
Alfred: "Your code is: 847291. Enter it on your other platform."

# On Matrix:
You: "Link with code 847291"
Alfred: "Linked! Your memories and preferences are now shared."
```

After linking:
- Memories saved on Telegram are accessible from Matrix
- Reminders set on Discord arrive on all your platforms
- Your profile and preferences sync everywhere
- Notes, documents, and context follow you

### Speech

- **Speech-to-Text** â€” Send voice messages on any platform. Alfred transcribes via OpenAI Whisper, Groq, Google STT, or Mistral Voxtral.
- **Text-to-Speech** â€” Ask Alfred to respond with a voice message. Uses OpenAI TTS or Mistral Voxtral TTS with multiple voice options.
- **Voice Cloning** â€” Create custom voices from audio samples (min. 2-3 Sek). Use your own voice for TTS and Sonos announcements.
- **Sonos-Durchsagen** â€” TTS-Audio direkt auf Sonos-Speaker abspielen. Auto-Fallback auf Telegram-Attachment wenn Sonos nicht verfÃ¼gbar.

### Active Learning

Alfred picks up on things you mention in conversation and stores them as memories:

- Extracts facts, preferences, and context automatically
- Detects patterns like names, dates, goals, opinions
- Consolidates related memories over time
- Runs asynchronously, rate-limited per user
- **Cross-Context Connection-Memories** â€” Erkennt Verbindungen zwischen neuen Aussagen und bestehenden Memories (z.B. "User fÃ¤hrt morgen nach Wien" + "RTX 5090 Watch aktiv" = "Abholung bei Cyberport Wien mÃ¶glich")
- **Regel-Lernsystem (MetaClaw-inspiriert)** â€” Lernt aus Fehlern und User-Korrekturen. Korrekturen werden zu generalisierbaren Verhaltensregeln destilliert. Skill-Fehler werden zu Vermeidungsregeln. Confidence-basiertes Lifecycle-Management (0.7 Start, auto-boost/decay, Cleanup < 0.3). Pro Prompt die 10 relevantesten Regeln via Hybrid-Retrieval.
- **Memory-Schutz** â€” Entity/Fact-Memories (Personen, Adressen, Arbeitgeber) sind vor automatischem Merge, Ãœberschreiben und LÃ¶schen geschÃ¼tzt. 4-Ebenen-Schutz: UPSERT-Guard, Consolidator-Guard, Delete-Confirm, Type-Klassifikation.
- **Insight-Preference Learning** â€” Trackt User-Reaktionen auf proaktive Hinweise (positiv/negativ/ignoriert). Erlernte PrÃ¤ferenzen steuern zukÃ¼nftige Insight-Priorisierung.

### Document Intelligence (RAG)

```
You: *sends a PDF*
Alfred: "I've processed 'contract.pdf' (47 pages, 12 chunks). What would you like to know?"

You: "What's the termination clause?"
Alfred: "According to section 8.2..."
```

Supported formats: PDF, DOCX, TXT, CSV, Markdown. Additional formats (XLSX, HTML, JSON) can be processed via the code sandbox. **OCR** via Mistral erkennt Handschrift, Tabellen und Rechnungen in PDFs und Bildern â€” automatisch aktiv wenn Mistral-Key vorhanden, Fallback auf bisheriges pdf-parse.

### MCP (Model Context Protocol)

Extend Alfred with any MCP-compatible server:

```yaml
mcp:
  - name: "filesystem"
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/home/user"]
  - name: "github"
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-github"]
```

MCP tools are automatically registered as Alfred skills.

### Security

YAML-based rule engine with fine-grained access control:

```yaml
rules:
  - id: block_shell_for_guests
    priority: 10
    effect: deny
    conditions:
      action: shell
      riskLevel: admin
    scope: global

  - id: rate_limit_web_search
    priority: 20
    effect: allow
    conditions:
      action: web_search
    rateLimit:
      period: 60000
      limit: 10
    scope: user
```

Risk levels: `read`, `write`, `admin`. Scopes: `global`, `user`, `conversation`, `platform`.

---

## Quick Start

### Prerequisites

- **Node.js** >= 20
- **pnpm** >= 9 (recommended) or npm

### Install from npm

```bash
npm install -g @madh-io/alfred-ai
```

### Setup

```bash
alfred setup
```

The interactive wizard guides you through:

1. **Platform selection** â€” Enable Telegram, Discord, WhatsApp, Matrix, and/or Signal
2. **API tokens** â€” Enter bot tokens for each platform
3. **LLM provider** â€” Choose your AI provider and model (available models are fetched dynamically from the provider API)
4. **Optional features** â€” Speech, email, calendar, web search, code sandbox
5. **Code Agents** â€” Auto-detects installed CLI tools (Claude Code, Codex, Aider, Gemini CLI)
6. **Forge Integration** â€” GitHub or GitLab token for automatic PR/MR creation
7. **Web Chat UI** â€” Enable/disable the built-in browser chat interface
8. **YouTube** â€” YouTube Data API v3 key for search, video info, transcripts
9. **Infrastructure** â€” Proxmox VE, UniFi Network, Home Assistant, Contacts, Docker, BMW CarData, Google Routing

This generates `config.yaml` and `.env` in your working directory. Model lists are cached locally (`~/.alfred/model-cache.json`, TTL 24h) for fast subsequent runs.

### Start

```bash
alfred start
```

Alfred connects to all configured platforms and starts the HTTP API server.

### CLI Chat Mode

Talk to Alfred directly in your terminal:

```bash
alfred chat
alfred chat --model gpt-4o        # use a specific model
alfred chat --tier strong          # use the strong tier
```

If `alfred start` is running, `alfred chat` automatically connects to the server via HTTP API. Your CLI user is linked with your main account â€” shared memories, context, and preferences. If no server is running, it falls back to standalone mode.

### HTTP API

`alfred start` exposes an HTTP API on port 3420 (localhost only by default):

```bash
# Health check (includes DB status, uptime, adapter status)
curl http://localhost:3420/api/health
# â†’ {"status":"ok","db":true,"uptime":3600,"adapters":{"telegram":"connected"},"timestamp":"..."}

# Send a message (returns SSE stream)
curl -N -X POST http://localhost:3420/api/message \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{"text": "Hello Alfred", "chatId": "my-chat", "userId": "my-user"}'
```

SSE events: `status` (progress), `response` (final answer), `attachment` (files/images), `done` (stream end), `error`.

```bash
# Dashboard data (watches, scheduled tasks, skill health)
curl http://localhost:3420/api/dashboard \
  -H "Authorization: Bearer YOUR_TOKEN"
```

Configure in `config.yaml`:

```yaml
api:
  enabled: true
  port: 3420
  host: 127.0.0.1    # localhost only; use 0.0.0.0 to expose
  token: my-secret    # optional â€” enables Bearer token auth
  corsOrigin: http://localhost:3000  # optional â€” restricts CORS origin
  webUi: true         # serves web chat UI at /alfred/ (default: true)
```

### Web Chat UI

Alfred includes a browser-based chat interface with dashboard, served automatically at `http://host:3420/alfred/`.

**Features:**
- **Chat** â€” SSE streaming, Markdown rendering, code blocks, attachment preview (images, files, voice)
- **Dashboard** â€” Active watches with last value/trigger, scheduled tasks with next run, skill health grid (green/amber/red)
- **Settings** â€” API URL + token configuration, connection test

**Configuration:**
```yaml
api:
  enabled: true
  port: 3420
  host: 127.0.0.1
  webUi: true          # set to false to disable built-in web UI
```

The web UI can also be deployed externally (nginx, CDN, Vercel) â€” it's a pure static site. Set `api.corsOrigin` to the external URL in that case.

### Other Commands

```bash
alfred status           # Show connection status and loaded skills
alfred config           # Display current configuration (keys redacted)
alfred auth microsoft   # Automatic OAuth token flow for Microsoft 365
alfred rules            # List active security rules
alfred logs             # Show recent audit log entries
alfred --version        # Show version
```

---

## Configuration

Alfred loads configuration from multiple sources (in priority order):

1. **Environment variables** (`ALFRED_*`)
2. **`.env` file** in the working directory
3. **`config.yaml`** in the working directory

### Example `config.yaml`

```yaml
telegram:
  enabled: true

matrix:
  enabled: true
  homeserverUrl: https://matrix.example.com

llm:
  default:
    provider: anthropic
    model: claude-sonnet-4-6-20260320

storage:
  path: ./data/alfred.db

logger:
  level: info
  pretty: true

security:
  rulesPath: ./rules
  defaultEffect: allow

speech:
  provider: openai
  ttsEnabled: true
  ttsVoice: nova

search:
  provider: brave

email:
  accounts:
    - name: default
      # provider: imap-smtp (default) or microsoft
      imap:
        host: imap.gmail.com
        port: 993
        secure: true
      smtp:
        host: smtp.gmail.com
        port: 587
    # Additional accounts (optional):
    # - name: work
    #   provider: microsoft
    #   microsoft:
    #     clientId: ...
    #     tenantId: ...
    #     # clientSecret + refreshToken via ENV
  # Legacy flat format (single account) is also supported

api:
  enabled: true
  port: 3420
  host: 127.0.0.1
  webUi: true           # serves web chat UI at /alfred/

conversation:
  maxHistoryMessages: 30    # 10â€“500, default 30

codeAgents:
  agents:
    - name: claude-code
      command: claude
      args: ["--print"]
  forge:
    provider: github   # or gitlab
    # token via ALFRED_GITHUB_TOKEN or ALFRED_GITLAB_TOKEN

proxmox:
  baseUrl: https://pve.local:8006
  # tokenId/tokenSecret via ENV

unifi:
  baseUrl: https://unifi.local
  # apiKey or username/password via ENV

homeassistant:
  baseUrl: http://homeassistant.local:8123
  # accessToken via ALFRED_HOMEASSISTANT_TOKEN

contacts:
  provider: carddav  # or google, microsoft
  carddav:
    serverUrl: https://cloud.example.com/remote.php/dav
    # username/password via ENV

docker:
  socketPath: /var/run/docker.sock
  # or host: http://192.168.1.10:2375

bmw:
  # clientId via ALFRED_BMW_CLIENT_ID

routing:
  # apiKey via ALFRED_ROUTING_API_KEY

youtube:
  # apiKey via ALFRED_YOUTUBE_API_KEY
  # supadata:
  #   enabled: true
  #   apiKey: via ALFRED_SUPADATA_API_KEY

energy:
  # Grid fees from your electricity bill (set via `alfred setup` or ENV)
  # gridName via ALFRED_ENERGY_GRID_NAME
  # gridUsageCt via ALFRED_ENERGY_GRID_USAGE_CT
  # gridLossCt via ALFRED_ENERGY_GRID_LOSS_CT
  # gridCapacityFee via ALFRED_ENERGY_GRID_CAPACITY_FEE
  # gridMeterFee via ALFRED_ENERGY_GRID_METER_FEE

mcp: []
```

### Environment Variables

```bash
# Platform tokens (set ENABLED=true to activate without config.yaml)
ALFRED_TELEGRAM_TOKEN=
ALFRED_TELEGRAM_ENABLED=true
ALFRED_DISCORD_TOKEN=
ALFRED_DISCORD_ENABLED=true
ALFRED_MATRIX_ACCESS_TOKEN=
ALFRED_MATRIX_ENABLED=true
ALFRED_SIGNAL_PHONE_NUMBER=
ALFRED_SIGNAL_ENABLED=true

# LLM API keys
ALFRED_ANTHROPIC_API_KEY=
ALFRED_OPENAI_API_KEY=
ALFRED_GOOGLE_API_KEY=
ALFRED_MISTRAL_API_KEY=              # also enables OCR, moderation, STT, TTS independently
ALFRED_OPENROUTER_API_KEY=

# Mistral AI Dienste (optional, unabhÃ¤ngig vom Haupt-LLM-Provider)
ALFRED_MODERATION_ENABLED=false      # Content-Safety fÃ¼r Input + Output
ALFRED_MODERATION_PROVIDER=mistral   # mistral oder openai
ALFRED_MODERATION_MODEL=             # Default: mistral-moderation-latest
ALFRED_STT_PROVIDER=openai           # openai oder mistral (voxtral-mini-2602)
ALFRED_TTS_PROVIDER=openai           # openai oder mistral (voxtral-mini-tts-2603)
ALFRED_VOICE_MANAGEMENT=true         # Voice Cloning + Sonos-Durchsagen (auto wenn Mistral TTS)
ALFRED_TTS_VOICE_ID=                 # Default-Stimme fÃ¼r TTS (Voice-ID aus create_voice)

# Forge (GitHub / GitLab)
ALFRED_GITHUB_TOKEN=
ALFRED_GITLAB_TOKEN=
ALFRED_GITLAB_BASE_URL=          # for self-hosted GitLab

# Proxmox VE
ALFRED_PROXMOX_BASE_URL=         # e.g. https://pve.local:8006
ALFRED_PROXMOX_TOKEN_ID=         # user@realm!tokenname
ALFRED_PROXMOX_TOKEN_SECRET=
ALFRED_PROXMOX_VERIFY_TLS=true

# UniFi Network
ALFRED_UNIFI_BASE_URL=           # e.g. https://unifi.local
ALFRED_UNIFI_API_KEY=            # preferred (UniFi OS 4.x+)
ALFRED_UNIFI_USERNAME=           # alternative: username/password
ALFRED_UNIFI_PASSWORD=
ALFRED_UNIFI_SITE=default
ALFRED_UNIFI_VERIFY_TLS=true

# Home Assistant
ALFRED_HOMEASSISTANT_URL=         # e.g. http://homeassistant.local:8123
ALFRED_HOMEASSISTANT_TOKEN=       # Long-Lived Access Token

# Email (Microsoft 365 â€” alternative to IMAP/SMTP)
ALFRED_EMAIL_PROVIDER=              # microsoft (default: imap-smtp)
ALFRED_MICROSOFT_EMAIL_CLIENT_ID=
ALFRED_MICROSOFT_EMAIL_CLIENT_SECRET=
ALFRED_MICROSOFT_EMAIL_TENANT_ID=
ALFRED_MICROSOFT_EMAIL_REFRESH_TOKEN=

# Contacts
ALFRED_CONTACTS_PROVIDER=           # carddav, google, or microsoft
ALFRED_CARDDAV_CONTACTS_SERVER_URL=
ALFRED_CARDDAV_CONTACTS_USERNAME=
ALFRED_CARDDAV_CONTACTS_PASSWORD=
ALFRED_GOOGLE_CONTACTS_CLIENT_ID=
ALFRED_GOOGLE_CONTACTS_CLIENT_SECRET=
ALFRED_GOOGLE_CONTACTS_REFRESH_TOKEN=
ALFRED_MICROSOFT_CONTACTS_CLIENT_ID=
ALFRED_MICROSOFT_CONTACTS_CLIENT_SECRET=
ALFRED_MICROSOFT_CONTACTS_TENANT_ID=
ALFRED_MICROSOFT_CONTACTS_REFRESH_TOKEN=

# Docker
ALFRED_DOCKER_SOCKET_PATH=          # e.g. /var/run/docker.sock
ALFRED_DOCKER_HOST=                 # e.g. http://192.168.1.10:2375

# BMW CarData
ALFRED_BMW_CLIENT_ID=               # from bmw-cardata.bmwgroup.com/customer

# Google Routing
ALFRED_ROUTING_API_KEY=             # Google Routes API key

# YouTube
ALFRED_YOUTUBE_API_KEY=             # YouTube Data API v3 key (free, 10K units/day)
ALFRED_SUPADATA_API_KEY=            # optional â€” Supadata transcript fallback (100 free/month)

# Energy / aWATTar (optional â€” grid fees from your electricity bill)
ALFRED_ENERGY_GRID_NAME=            # e.g. "Netz NiederÃ¶sterreich"
ALFRED_ENERGY_GRID_USAGE_CT=        # Netznutzungsentgelt ct/kWh netto (e.g. 8.79)
ALFRED_ENERGY_GRID_LOSS_CT=         # Netzverlustentgelt ct/kWh netto (e.g. 0.38)
ALFRED_ENERGY_GRID_CAPACITY_FEE=    # Leistungspauschale â‚¬/Monat netto (e.g. 4.59)
ALFRED_ENERGY_GRID_METER_FEE=       # Messentgelt â‚¬/Monat netto (e.g. 2.22)

# Marketplace / eBay (optional â€” willhaben works without credentials)
ALFRED_EBAY_APP_ID=                 # eBay Developer App ID (Client ID)
ALFRED_EBAY_CERT_ID=                # eBay Developer Cert ID (Client Secret)

# Briefing (optional)
ALFRED_BRIEFING_LOCATION=           # Default weather location (e.g. "Altlengbach")
ALFRED_BRIEFING_HOME_ADDRESS=       # Home address for commute routing (e.g. "Altlengbach 42")
ALFRED_BRIEFING_OFFICE_ADDRESS=     # Office address for commute routing (e.g. "Mariahilfer StraÃŸe 1, Wien")

# Reasoning Engine (optional, enabled by default)
ALFRED_REASONING_ENABLED=true       # true/false (default: true)
ALFRED_REASONING_SCHEDULE=morning_noon_evening  # morning_noon_evening | hourly | half_hourly
ALFRED_REASONING_TIER=fast          # fast (Haiku, ~$0.80/mo) | default (Sonnet, ~$2.40/mo)

# Microsoft To Do (set automatically by `alfred auth microsoft`)
ALFRED_MICROSOFT_TODO_CLIENT_ID=
ALFRED_MICROSOFT_TODO_CLIENT_SECRET=
ALFRED_MICROSOFT_TODO_TENANT_ID=
ALFRED_MICROSOFT_TODO_REFRESH_TOKEN=

# Personality (optional)
ALFRED_PERSONALITY_TONE=freundlich, direkt, informell
ALFRED_PERSONALITY_HUMOR=trocken, gelegentlich
ALFRED_PERSONALITY_DIRECTNESS=sehr direkt, keine Umschweife
ALFRED_PERSONALITY_LANGUAGE=Deutsch

# Backup (optional)
ALFRED_BACKUP_ENABLED=true
ALFRED_BACKUP_STORAGE=both          # local | s3 | both | none
ALFRED_BACKUP_LOCAL_PATH=/root/alfred/backups
ALFRED_BACKUP_S3_BUCKET=alfred-backups
ALFRED_BACKUP_SCHEDULE=0 3 * * *    # daily at 03:00
ALFRED_BACKUP_RETENTION_DAYS=30

# MikroTik (optional)
ALFRED_MIKROTIK_ENABLED=true
ALFRED_MIKROTIK_HOST=192.168.1.1
ALFRED_MIKROTIK_USERNAME=alfred-api
ALFRED_MIKROTIK_PASSWORD=...
ALFRED_MIKROTIK_PORT=443
ALFRED_MIKROTIK_SSL=true

# Commvault (optional)
ALFRED_COMMVAULT_ENABLED=true
ALFRED_COMMVAULT_BASE_URL=https://commserve.example.com/api/v2
ALFRED_COMMVAULT_API_TOKEN=...

# Optional
ALFRED_STORAGE_PATH=./data/alfred.db
ALFRED_LOG_LEVEL=info
ALFRED_OWNER_USER_ID=
```

---

## Architecture

Alfred is a TypeScript monorepo built with pnpm and Turborepo.

```
alfred/
â”œâ”€â”€ packages/
â”‚   â”œâ”€â”€ types/        # Shared TypeScript types
â”‚   â”œâ”€â”€ config/       # YAML + env configuration with Zod validation
â”‚   â”œâ”€â”€ logger/       # Structured logging (pino)
â”‚   â”œâ”€â”€ storage/      # SQLite database, repositories, migrations
â”‚   â”œâ”€â”€ security/     # Rule engine, rate limiting, audit logging
â”‚   â”œâ”€â”€ llm/          # LLM providers, multi-model router, prompt builder
â”‚   â”œâ”€â”€ messaging/    # Platform adapters (Telegram, Discord, Matrix, HTTP API, ...)
â”‚   â”œâ”€â”€ skills/       # Skill system, built-in skills, MCP integration
â”‚   â”œâ”€â”€ core/         # Orchestration: pipeline, scheduler, speech, learning
â”‚   â””â”€â”€ cli/          # CLI commands, setup wizard, bundled entry point
â””â”€â”€ apps/
    â””â”€â”€ alfred/       # Standalone application entry point
```

### Message Pipeline

```
User Message (Telegram, Discord, Matrix, Signal, WhatsApp, HTTP API, CLI)
    â”‚
    â”œâ”€â”€ Normalize â†’ Unified message format
    â”œâ”€â”€ User Lookup â†’ Cross-platform identity resolution
    â”œâ”€â”€ Context Load â†’ Conversation history + running summary
    â”œâ”€â”€ Running Summary â†’ Replaces old history with ~200-token structured summary
    â”œâ”€â”€ Tool Result Trimming â†’ Old large results â†’ short summaries
    â”œâ”€â”€ Memory Retrieval â†’ Semantic search on stored memories
    â”œâ”€â”€ Active Learning â†’ Extract new memories (async)
    â”‚
    â”œâ”€â”€ Skill Filtering â†’ Category-based tool selection per message
    â”œâ”€â”€ LLM Request â†’ System prompt + context + filtered tools
    â”‚
    â”œâ”€â”€ Tool Loop (up to 50 iterations)
    â”‚   â”œâ”€â”€ Security Check â†’ Rule engine evaluation
    â”‚   â”œâ”€â”€ Skill Execution â†’ Sandboxed skill runner
    â”‚   â””â”€â”€ Result â†’ Feed back to LLM
    â”‚
    â”œâ”€â”€ Response Formatting â†’ Platform-specific (Markdown/HTML)
    â”œâ”€â”€ Attachment Routing â†’ Images, voice, files
    â””â”€â”€ Save â†’ Conversation history + audit log
```

### Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js >= 20 |
| Language | TypeScript 5.7+ |
| Database | better-sqlite3 |
| Logging | pino |
| Validation | zod |
| Config | js-yaml + dotenv |
| Build | Turborepo + esbuild |
| Tests | Vitest |
| Package Manager | pnpm |

---

## Development

### From Source

```bash
git clone https://github.com/madh-io/alfred.git
cd alfred
pnpm install
pnpm build
```

### Commands

```bash
pnpm build          # Compile all packages
pnpm test           # Run test suite
pnpm dev            # Watch mode
pnpm lint           # Lint all packages
pnpm clean          # Clean build artifacts

# Bundle for distribution
pnpm --filter @madh-io/alfred-ai bundle
```

### Adding a Skill

Create a new file in `packages/skills/src/built-in/`:

```typescript
import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../skill.js';

export class MySkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'my_skill',
    category: 'information',  // core | productivity | information | media | automation | files | infrastructure | identity | mcp
    description: 'What this skill does â€” the LLM reads this to decide when to use it.',
    riskLevel: 'read',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The input' },
      },
      required: ['query'],
    },
  };

  async execute(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const query = input.query as string;
    // Your logic here
    return {
      success: true,
      data: { result: '...' },
      display: 'Human-readable response shown to the user.',
    };
  }
}
```

Register it in `packages/core/src/alfred.ts` and export from `packages/skills/src/index.ts`.

---

## Deployment

### Systemd (Linux)

```ini
[Unit]
Description=Alfred AI Assistant
After=network.target

[Service]
Type=simple
User=alfred
WorkingDirectory=/opt/alfred
ExecStart=/usr/bin/node /opt/alfred/bundle/index.js start
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

### Docker

A `Dockerfile` and `docker-compose.yml` are included:

```bash
# Build and start
docker compose up -d

# View logs
docker compose logs -f alfred

# Health check is built into the container
docker inspect --format='{{.State.Health.Status}}' alfred-alfred-1
```

The container mounts `config.yaml` and `.env` as read-only and persists data in a named volume.

### macOS (launchd)

```bash
alfred start > /tmp/alfred.log 2>&1 &
```

---

## Roadmap

- [x] Web Chat UI + Dashboard + Knowledge Graph Visualisierung + CMDB/ITSM/InfraDocs WebUI
- [x] Multi-user household support with role-based access
- [x] Knowledge Graph with LLM Entity-Linker, Family Inference, CMDB Sync
- [x] Proactive Reasoning Engine (cross-domain insights, actions, autonomous planning)
- [x] Autonomous Multi-Step Planning (PlanningAgent + PlanExecutor)
- [x] BMW CarData MQTT Streaming + Reifendiagnose + Fahrzeugbild + HA-Failover
- [x] MikroTik RouterOS Management (34 Actions, Multi-Router, CMDB Discovery)
- [x] Commvault Backup Management (15 Actions, LLM-Analyse, Auto-Retry, ITSM-Integration)
- [x] Infrastructure Pipeline (Cloudflare DNS, Nginx Proxy Manager, pfSense, Deploy Orchestrator)
- [x] CMDB + ITSM + InfraDocs (Auto-Discovery aus 8 Infra-Skills)
- [x] Backup & Restore (System Backup + Database Skill fÃ¼r 7 DB-Provider inkl. MS SQL Ketten)
- [x] Memory: pgvector Semantic Search, Temporal Decay, Embedding Cleanup, Consolidation
- [x] Personality Config (Ton, Humor, Direktheit, Sprache)
- [x] Delegate Prompt-Modes (task-filtered tool sets for sub-agents)
- [x] Guided Onboarding Skill
- [x] Microsoft Teams Adapter (Bot Framework, cluster-aware)
- [ ] SharePoint Skill (Sites, Document Libraries, Listen, Search)
- [ ] Slack Adapter
- [ ] n8n/Node-RED Skill
- [ ] Worker/Satellit-System (Remote-Agent auf beliebigen VMs)
- [ ] Budget/Einkaufs-Skill (OCR Kassenzettel â†’ Ausgaben tracken)
- [ ] Self-Skill-Creation
- [ ] Mobile companion app
- [ ] Plugin marketplace

---

## License

Alfred is licensed under the **MIT License**.

See [LICENSE](LICENSE) for the full text.

---

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes
4. Run `pnpm build && pnpm test` to verify
5. Submit a pull request

All contributions are subject to the MIT license.

---

## Author

**Markus Dohnal** â€” [@madh-io](https://github.com/madh-io)

---

<p align="center">
  <sub>Made in Altlengbach.</sub>
</p>
