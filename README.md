<p align="center">
  <img src="https://img.shields.io/badge/version-0.19.0--multi--ha.2-blue" alt="Version">
  <img src="https://img.shields.io/badge/node-%3E%3D20-green" alt="Node">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
  <img src="https://img.shields.io/badge/typescript-5.7+-blue" alt="TypeScript">
</p>

<pre align="center">
 █████╗ ██╗     ███████╗██████╗ ███████╗██████╗
██╔══██╗██║     ██╔════╝██╔══██╗██╔════╝██╔══██╗
███████║██║     █████╗  ██████╔╝█████╗  ██║  ██║
██╔══██║██║     ██╔══╝  ██╔══██╗██╔══╝  ██║  ██║
██║  ██║███████╗██║     ██║  ██║███████╗██████╔╝
╚═╝  ╚═╝╚══════╝╚═╝     ╚═╝  ╚═╝╚══════╝╚═════╝
</pre>

<p align="center">
  <strong>Self-hosted AI assistant for Telegram, Discord, WhatsApp, Matrix, Signal & HTTP API</strong>
</p>

<p align="center">
  Alfred is a self-hosted AI assistant that connects to Telegram, Discord, WhatsApp, Matrix, and Signal simultaneously — plus an HTTP API for CLI and web access. It remembers who you are across platforms, learns from every conversation, and executes real-world tasks through an extensible skill system.
</p>

---

## Why Alfred?

I built Alfred because I wanted a single AI assistant I could reach from any messaging app — without losing context when switching between them.

- **Cross-Platform Identity** — Link your accounts across Telegram, Matrix, Discord, WhatsApp, and Signal. Alfred recognizes you as the same person. Memories, preferences, and conversation context carry over.
- **Persistent Memory** — Automatically extracts and stores facts, preferences, and context from conversations. Remembers things across sessions without being told to.
- **Extensible Skill System** — Goes beyond chat. Sends emails, sets reminders, searches the web, manages files, runs code, reads documents, manages your calendar — triggered through natural language.
- **Any LLM** — Works with Claude, GPT-4, Gemini, Ollama, or any OpenAI-compatible endpoint. Different models can be assigned to different task tiers. Runs fully local if needed.
- **Self-Hosted** — All data stays on your machine in a local SQLite database. No cloud dependency, no telemetry, no accounts.

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

**Multi-Model Routing** — Configure different models for different tasks:

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

### Built-in Skills (46+)

Alfred exposes capabilities as **skills** — tools the LLM can call autonomously based on your request.

| Category | Skills | Description |
|----------|--------|-------------|
| **Memory** | `memory`, `note`, `profile` | Persistent storage, recall, semantic search |
| **Communication** | `email`, `cross_platform`, `delegate` | Send/read/forward emails (IMAP/SMTP or Microsoft 365 Graph API, multi-account), reply drafts, PDF/DOCX attachment reading, cross-platform messaging, autonomous sub-agents |
| **Contacts** | `contacts` | CardDAV, Google People API, Microsoft Graph — search, create, update, delete contacts |
| **Scheduling & Automation** | `reminder`, `scheduled_task`, `background_task`, `todo`, `microsoft_todo`, `watch`, `workflow`, `briefing` | Timed reminders, cron jobs, long-running tasks (persistent checkpoint/resume), local todo lists, Microsoft To Do (Graph API), condition-based alerts with actions (AND/OR conditions, skill execution on trigger, human-in-the-loop confirmation, template variables, **watch chains** for multi-step automations), workflow chains (multi-step skill pipelines with **if/else branching**), calendar lead-time notifications, Morgenbriefing, self-healing (auto-disable failing skills), **learning feedback loop** (behavioral memory from rejections/corrections) |
| **Information** | `web_search`, `weather`, `system_info`, `calculator`, `feed_reader`, `youtube` | Brave/Tavily/SearXNG/DuckDuckGo search, weather, system info, RSS/Atom feed monitoring, **YouTube** (Suche, Video-Info, Transkript-Extraktion, Channel-Monitoring) |
| **Documents** | `document` | Ingest PDF, DOCX, TXT, CSV, Markdown — RAG with semantic search |
| **Code** | `code_sandbox`, `code_agent`, `project_agent` | Sandboxed JS/Python execution (PDF, DOCX, Excel), CLI coding agent orchestration, **autonomous project agent** (plan → code → validate → fix → commit loop, Telegram-controlled) |
| **Infrastructure** | `proxmox`, `unifi`, `homeassistant`, `docker`, `bmw`, `monitor`, `database` | Proxmox VE cluster, UniFi network, Home Assistant smart home (Entitäten steuern, Services aufrufen, Automationen/Skripte/Szenen erstellen & löschen), Docker containers, BMW CarData, deterministic health checks (inkl. Proxmox Backup Server) |
| **Navigation** | `routing`, `transit_search` | Google Routes API (Live-Traffic), Öffentlicher Nahverkehr Österreich (ÖBB/Wiener Linien via HAFAS) |
| **Energy** | `energy_price` | Echtzeit-Strompreise (aWATTar HOURLY, EPEX Spot AT) mit Netzentgelten und Abgaben |
| **Marketplace** | `marketplace` | Marktplatz-Suche auf willhaben.at und eBay — Inseratliste, Preisvergleich, Einzelinserat-Details, Watch-Alerts |
| **Files & System** | `file`, `clipboard`, `screenshot`, `shell`, `http` | Read/write files, clipboard, screenshots, shell commands, HTTP requests |
| **Media** | `browser`, `tts`, `image_generate` | Web browsing via Puppeteer, text-to-speech voice messages, AI image generation (OpenAI/Google) |
| **Calendar** | `calendar` | CalDAV, Google Calendar, Microsoft Calendar — inkl. `find_free_slot` und `check_conflicts` |
| **Admin** | `configure` | Configure services (Proxmox, UniFi, HA, Contacts, Docker) via chat — hot-reload, no restart needed |
| **Multi-User** | `user_management`, `sharing`, `help` | Roles (admin/user/family/guest/service), invite codes, platform linking, per-user service config, share notes/todos/documents/services between users, interactive help |

### Code Agent Orchestration

Delegate coding tasks to external CLI agents — Alfred plans, splits, parallelizes, and validates.

```
You: "Refactor the auth module to use JWT instead of sessions"
Alfred → code_agent orchestrate:
  1. Planning: LLM splits task into subtasks
  2. Execution: Parallel agent runs (Claude Code, Codex, Aider, Gemini CLI)
  3. Validation: LLM reviews results, retries if needed
  4. Git: Auto-branch, commit, push, and create PR/MR
```

Supported agents are auto-detected during setup: **Claude Code**, **Codex**, **Aider**, **Gemini CLI**, or any custom CLI tool.

**Forge Integration** — Automatically creates branches, commits, pushes, and opens Pull Requests (GitHub) or Merge Requests (GitLab). Owner/repo is detected from `git remote` at runtime — no manual config needed.

### Project Agent (Autonomous Software Development)

Build entire software projects via chat. Alfred plans, codes, validates, fixes, and commits — autonomously.

```
You: "Erstelle eine REST API für Todo-Items mit Express und TypeScript in ~/projects/api"
Alfred: "🚀 Project Agent gestartet."
Alfred: "📋 Plan: 1) Setup 2) Models+Routes 3) Auth 4) Tests"
Alfred: "🔨 Phase 1: claude-code arbeitet..."
Alfred: "✅ Build passed. 4 Dateien. Commit: a3f21b7"
Alfred: "🔨 Phase 2..."
You: "Füge JWT Auth hinzu"
Alfred: "📝 Eingereiht. Wird in der nächsten Phase berücksichtigt."
You: "Stopp"
Alfred: "⏹ Gestoppt. 12 Dateien, 5 Commits, Build: passing."
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
| **user** | 25+ skills, own data, per-user service config |
| **family** | Productivity skills, own data |
| **guest** | Read-only skills (weather, search, calculator) |

**Per-User Service Config** — Each user configures their own Email, Calendar, Contacts, BMW, Microsoft Todo via chat (`setup_service`). No server access needed.

**Sharing** — Share notes, todo lists, documents, or service configs between users. MS 365 shared mailboxes/calendars supported via Graph API delegated access.

### High Availability (optional)

Active-Active cluster — all nodes are equal, work is split automatically via PostgreSQL atomic claims. No single point of failure.

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

- **Active-Active** — All nodes run schedulers. `FOR UPDATE SKIP LOCKED` splits work atomically. No duplicates.
- **Adapter Claims** — Messaging adapters (Telegram, Discord, etc.) claimed by one node. Automatic failover on death.
- **Message Dedup** — Every inbound message processed exactly once via `processed_messages` table.
- **PostgreSQL** — Shared database, atomic coordination (replaces Redis locks). SQLite remains default for single-instance.
- **Redis** — Heartbeat, pub/sub, cross-node messaging (optional supplement — PG heartbeat as fallback).
- **S3/MinIO** — Shared file storage for uploads and documents.
- **`alfred migrate-db`** — Migrate existing SQLite data to PostgreSQL.

### Infrastructure Management

#### Proxmox VE

Full Proxmox API integration — manage your hypervisor cluster through natural language:

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

Full UniFi controller integration — manage your network infrastructure:

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

Smart home control via the Home Assistant REST API — 27 actions:

- List all entities or filter by domain (lights, sensors, switches)
- Turn on, turn off, toggle devices
- Call any service with custom parameters
- View entity state history and logbook
- List available services and system config
- **Areas** — List rooms/zones and their entities (via Jinja2 templates)
- **Presence** — Who is home? Person entity status at a glance
- **Scenes & Automations** — Activate scenes, trigger/enable/disable automations, run scripts
- **Config API** — Create, update, and delete automations, scripts, and scenes directly via chat
- **Notifications** — Send notifications to mobile apps or other targets
- **Calendar Events** — Query HA calendar entities with time range
- **Templates** — Execute arbitrary Jinja2 queries for maximum flexibility
- **Briefing Summary** — Kompakte Übersicht für Morgenbriefing: offene Kontakte, Lichter an, Batterie/SoC, Energie, Klima, Anwesenheit. Konfigurierbar per Entity-/Domain-Filter
- **Energy Stats** — Energieverbrauch-Statistiken: Auto-Discovery aller Energie-Sensoren, Verbrauchsberechnung über History-API, freundliche Zeiträume (heute, gestern, diese/letzte Woche/Monat)
- **Error Log** — View the Home Assistant error log

Uses **Long-Lived Access Tokens** for authentication (Settings → Security → Long-Lived Access Tokens).

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

**Local** — Persistent todo lists stored in SQLite, always available without external service.

**Microsoft To Do** — Full Graph API integration for Microsoft To Do. Lists and tasks sync with the Microsoft To Do app across all devices. List resolution by display name — say *"füge Milch zur Einkaufsliste hinzu"* and Alfred finds the right list automatically. Configured automatically via `alfred auth microsoft`.

```
You: "Add a todo: Buy groceries"
You: "Füge Milch zur Einkaufsliste hinzu"
You: "Show my Microsoft To Do lists"
You: "Complete todo abc123"
```

#### Docker

Full Docker Engine API integration — manage containers, images, volumes, and networks:

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

Vehicle data from your BMW via the BMW CarData Customer API (`api-cardata.bmwgroup.com`):

- Battery state of charge, electric range, battery health (SoH)
- Charging status, power (kW), remaining time, target SoC
- Plug/flap/lock status, AC voltage & amperage
- Charging session history (custom date range)
- Vehicle model & basic data

Uses OAuth Device Authorization Flow with PKCE (S256). Container-based telematic data access. Tokens are stored persistently and refreshed automatically. Response cache (5 min TTL) respects BMW's 50 calls/day rate limit.

```
You: "Wie ist der Ladestand meines Autos?"
You: "Zeig mir den Ladestatus"
You: "Zeig mir die letzten Ladevorgänge"
```

#### Routing (Google Routes API)

Route calculation with live traffic data:

- Distance, duration, traffic delay
- Departure time recommendation for a desired arrival time
- Supports addresses and lat/lng coordinates
- Travel modes: DRIVE, BICYCLE, WALK, TRANSIT
- Address aliases ("zuhause", "Büro") are resolved by the LLM from memory — no config needed

```
You: "Wie weit ist es von Altlengbach nach Wien?"
You: "Wann muss ich losfahren um um 9 Uhr im Büro zu sein?"
```

The LLM combines BMW + Routing skills intelligently for questions like *"Schaffe ich es mit dem Auto ins Büro ohne Laden?"*

#### Public Transit (Austria)

Public transit routing for all of Austria via hafas-client (ÖBB profile). No API key needed — auto-registered on startup.

- Stop search, journey planning, departure boards
- Covers ÖBB trains, Wiener Linien (U-Bahn, Tram, Bus), S-Bahn, Postbus, regional transit
- Real-time delay information

```
You: "Wann fährt die nächste U-Bahn von Stephansplatz?"
You: "Wie komme ich von Altlengbach nach Wien Hauptbahnhof?"
You: "Zeig mir die Abfahrten am Westbahnhof in den nächsten 20 Minuten"
```

#### Energy Prices (aWATTar HOURLY)

Real-time electricity prices based on EPEX Spot AT market data via aWATTar API. No API key needed.

- Current price with full breakdown (market price, grid fees, taxes)
- Hourly prices for today/tomorrow, cheapest hours, daily averages
- 9 Austrian grid areas with default rates (configurable via `ALFRED_ENERGY_GRID_AREA`)
- Automatic 3% surcharge handling (drops after 01.04.2026 per ElWG §21)

```
You: "Was kostet Strom gerade?"
You: "Wann ist Strom heute am günstigsten?"
You: "Zeig mir die Strompreise für morgen"
```

#### Marketplace (willhaben.at + eBay)

Structured marketplace search on willhaben.at and eBay. willhaben works without credentials (parses `__NEXT_DATA__` from HTML), eBay requires API keys (Browse API, OAuth Client Credentials).

- **search**: Lists matching listings with structured JSON data (watch-compatible) + Markdown display
- **compare**: Price statistics (min, max, median, avg) + cheapest 5 listings
- **detail**: Single listing deep-dive — description, photos, seller info, attributes
- **Filters**: `sort` (price_asc/price_desc/date_desc), `condition` (new/used), `postcode`
- **Watch-kompatibel**: `search→"count"/"minPrice"`, `compare→"minPrice"/"avgPrice"` — Alerts bei neuen Inseraten oder Preisdrops

```
You: "Zeig mir alle RTX 5090 auf willhaben"
You: "Vergleich RTX 5090 Preise auf willhaben"
You: "Suche iPhone 16 Pro auf eBay und willhaben"
You: "Zeig mir Details zum Inserat 123456"
You: "Beobachte RTX 4070 unter 400€ auf Willhaben"
```

#### YouTube

YouTube video search, transcripts, and channel monitoring via YouTube Data API v3.

- **search**: Suche nach Videos (Top N Ergebnisse mit Titel, Channel, Datum)
- **info**: Video-Details (Titel, Dauer, Views, Likes, Beschreibung)
- **transcript**: Transkript-Extraktion mit Timestamps (self-hosted via `youtube-transcript` npm, Supadata als optionaler Fallback)
- **channel**: Letzte Videos eines Channels (Watch-kompatibel: `newCount`)

```
You: "Suche YouTube Videos über TypeScript Patterns"
You: "Fasse dieses Video zusammen: https://youtube.com/watch?v=abc123"
You: "Zeig mir die neuesten Videos von Fireship"
You: "Erstelle einen Watch: Prüfe den YouTube Channel Fireship alle 2 Stunden auf neue Videos"
```

Requires a YouTube Data API v3 key (free, 10,000 units/day). Transcripts are extracted locally without API key. Optional Supadata fallback for AI-generated transcripts.

#### Daily Briefing

Parallel morning briefing that gathers data from all available skills in a single call. Auto-detects which modules are available based on your configuration.

- Calendar, weather, todos, emails, energy prices, BMW status, smart home (kompakte Übersicht), infrastructure
- All data fetched in parallel (~5s instead of ~30s with sequential tool calls)
- **LLM-frei als Scheduled Task** — Briefing wird direkt ausgeführt ohne LLM-Overhead ($0.00 statt ~$0.016 pro Ausführung)
- Regelbasierte Actionable Highlights (BMW-Akku, Infrastruktur, Strompreise, Termine)
- **Mo–Fr automatic commute check**: Routes home → office, checks BMW battery, warns if low
- Skips commute routing when calendar shows an external appointment (physical location)
- Virtual meetings (Teams, Zoom, Meet) are not treated as external appointments

```
You: "Morgenbriefing"
You: "Erstelle ein tägliches Briefing um 7 Uhr"
You: "Briefing nur mit Kalender, Wetter und Todos"
```

### Autonomous Automation

Alfred doesn't just alert — it acts. Watches monitor conditions and execute skills automatically.

**Watch-Actions** — "If X then do Y" without LLM involvement:
```
You: "Wenn Strompreis unter 15ct, schalte Wallbox ein"
Alfred → watch:
  - Polls energy_prices every 15 min
  - Condition: bruttoCt < 15
  - Action: home_assistant turn_on switch.wallbox
  - Mode: alert_and_action (notify + execute)
```

**Composite Conditions** — AND/OR logic over multiple fields:
```
You: "Wenn Strom günstig UND Auto unter 80%, lade"
Alfred → watch with conditions:
  - AND(energy.bruttoCt < 15, bmw.soc < 80)
  - Action: home_assistant turn_on switch.wallbox
```

**Human-in-the-Loop** — Confirmation before risky actions (Telegram: Inline Buttons):
```
Alfred: "⚡ Strompreis unter 15ct. Soll ich die Wallbox einschalten?"
       [✅ Approve] [❌ Reject]
You: *clicks Approve*
Alfred: "✅ Aktion ausgeführt: Wallbox eingeschaltet"
```

**Watch Chains** — Multi-step automations by chaining watches:
```
You: "Wenn Strom günstig, prüfe BMW Akku — wenn unter 80%, Wallbox ein"
Alfred → Watch A (energy check) triggers Watch B (BMW check):
  - Watch A: energy_prices bruttoCt < 10 → trigger_watch → Watch B
  - Watch B: bmw battery < 80 → action: turn_on switch.wallbox
  - Each watch keeps its own cooldown
  - Chain depth limited to 5 (prevents cycles)
```

**Workflow Branching** — If/else logic in multi-step workflows:
```
You: "Erstelle Workflow: Wetter prüfen, wenn Regen → Schirm-Erinnerung, sonst → Fahrradroute"
Alfred → workflow with condition step:
  - Step 0: weather (get conditions)
  - Step 1: condition (prev.rain eq "true") → then: 2, else: 3
  - Step 2: reminder ("Regenschirm!") → jumpTo: end
  - Step 3: routing (mode: bike) → jumpTo: end
```

**Inbound Webhooks** — Trigger watches in real-time via HTTP:
```yaml
webhooks:
  - name: github-deploy
    secret: "your-hmac-secret"
    watchId: "watch-id-to-trigger"
```
External systems send `POST /api/webhook/github-deploy` with HMAC-SHA256 signature → watch executes immediately.

**Calendar Lead-Time** — Proactive reminders before events:
```yaml
calendar:
  vorlauf:
    enabled: true
    minutesBefore: 15
```

**Reasoning Engine** — Cross-domain analysis with proactive insights AND actions:
```
Alfred: "💡 Strompreis ist bis 15:00 unter 5 ct/kWh — BMW laden wäre jetzt
günstig (Akku war beim letzten Check bei 45%).
Soll ich die Wallbox einschalten?"
       [✅ Approve] [❌ Reject]
```
Aggregates calendar, todos, watches, memories, weather, energy prices, activity, and user feedback.
Runs 3x/day (configurable), one LLM call per pass (~$0.80/month with Haiku).
Can propose structured actions (skill execution, reminders) — always with human confirmation.

**Learning Feedback Loop** — Alfred learns from corrections and rejections:
```
User rejects "Wallbox einschalten" 3x → Alfred stores behavioral feedback:
  "Watch 'Wallbox' wurde 3× abgelehnt. Schwellenwert überprüfen."
  → Feedback appears in LLM system prompt as "Behavior Feedback"
  → Reasoning Engine considers feedback in future passes

User: "Nein, nicht so — beim nächsten Mal nur benachrichtigen"
  → Correction detected → stored as feedback memory
```

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

- **Speech-to-Text** — Send voice messages on any platform. Alfred transcribes via OpenAI Whisper, Groq, or Google STT.
- **Text-to-Speech** — Ask Alfred to respond with a voice message. Uses OpenAI TTS with multiple voice options.

### Active Learning

Alfred picks up on things you mention in conversation and stores them as memories:

- Extracts facts, preferences, and context automatically
- Detects patterns like names, dates, goals, opinions
- Consolidates related memories over time
- Runs asynchronously, rate-limited per user

### Document Intelligence (RAG)

```
You: *sends a PDF*
Alfred: "I've processed 'contract.pdf' (47 pages, 12 chunks). What would you like to know?"

You: "What's the termination clause?"
Alfred: "According to section 8.2..."
```

Supported formats: PDF, DOCX, TXT, CSV, Markdown. Additional formats (XLSX, HTML, JSON) can be processed via the code sandbox.

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

1. **Platform selection** — Enable Telegram, Discord, WhatsApp, Matrix, and/or Signal
2. **API tokens** — Enter bot tokens for each platform
3. **LLM provider** — Choose your AI provider and model (available models are fetched dynamically from the provider API)
4. **Optional features** — Speech, email, calendar, web search, code sandbox
5. **Code Agents** — Auto-detects installed CLI tools (Claude Code, Codex, Aider, Gemini CLI)
6. **Forge Integration** — GitHub or GitLab token for automatic PR/MR creation
7. **Web Chat UI** — Enable/disable the built-in browser chat interface
8. **YouTube** — YouTube Data API v3 key for search, video info, transcripts
9. **Infrastructure** — Proxmox VE, UniFi Network, Home Assistant, Contacts, Docker, BMW CarData, Google Routing

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

If `alfred start` is running, `alfred chat` automatically connects to the server via HTTP API. Your CLI user is linked with your main account — shared memories, context, and preferences. If no server is running, it falls back to standalone mode.

### HTTP API

`alfred start` exposes an HTTP API on port 3420 (localhost only by default):

```bash
# Health check (includes DB status, uptime, adapter status)
curl http://localhost:3420/api/health
# → {"status":"ok","db":true,"uptime":3600,"adapters":{"telegram":"connected"},"timestamp":"..."}

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
  token: my-secret    # optional — enables Bearer token auth
  corsOrigin: http://localhost:3000  # optional — restricts CORS origin
  webUi: true         # serves web chat UI at /alfred/ (default: true)
```

### Web Chat UI

Alfred includes a browser-based chat interface with dashboard, served automatically at `http://host:3420/alfred/`.

**Features:**
- **Chat** — SSE streaming, Markdown rendering, code blocks, attachment preview (images, files, voice)
- **Dashboard** — Active watches with last value/trigger, scheduled tasks with next run, skill health grid (green/amber/red)
- **Settings** — API URL + token configuration, connection test

**Configuration:**
```yaml
api:
  enabled: true
  port: 3420
  host: 127.0.0.1
  webUi: true          # set to false to disable built-in web UI
```

The web UI can also be deployed externally (nginx, CDN, Vercel) — it's a pure static site. Set `api.corsOrigin` to the external URL in that case.

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
  maxHistoryMessages: 30    # 10–500, default 30

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
ALFRED_MISTRAL_API_KEY=
ALFRED_OPENROUTER_API_KEY=

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

# Email (Microsoft 365 — alternative to IMAP/SMTP)
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
ALFRED_SUPADATA_API_KEY=            # optional — Supadata transcript fallback (100 free/month)

# Energy / aWATTar (optional — grid fees from your electricity bill)
ALFRED_ENERGY_GRID_NAME=            # e.g. "Netz Niederösterreich"
ALFRED_ENERGY_GRID_USAGE_CT=        # Netznutzungsentgelt ct/kWh netto (e.g. 8.79)
ALFRED_ENERGY_GRID_LOSS_CT=         # Netzverlustentgelt ct/kWh netto (e.g. 0.38)
ALFRED_ENERGY_GRID_CAPACITY_FEE=    # Leistungspauschale €/Monat netto (e.g. 4.59)
ALFRED_ENERGY_GRID_METER_FEE=       # Messentgelt €/Monat netto (e.g. 2.22)

# Marketplace / eBay (optional — willhaben works without credentials)
ALFRED_EBAY_APP_ID=                 # eBay Developer App ID (Client ID)
ALFRED_EBAY_CERT_ID=                # eBay Developer Cert ID (Client Secret)

# Briefing (optional)
ALFRED_BRIEFING_LOCATION=           # Default weather location (e.g. "Altlengbach")
ALFRED_BRIEFING_HOME_ADDRESS=       # Home address for commute routing (e.g. "Altlengbach 42")
ALFRED_BRIEFING_OFFICE_ADDRESS=     # Office address for commute routing (e.g. "Mariahilfer Straße 1, Wien")

# Reasoning Engine (optional, enabled by default)
ALFRED_REASONING_ENABLED=true       # true/false (default: true)
ALFRED_REASONING_SCHEDULE=morning_noon_evening  # morning_noon_evening | hourly | half_hourly
ALFRED_REASONING_TIER=fast          # fast (Haiku, ~$0.80/mo) | default (Sonnet, ~$2.40/mo)

# Microsoft To Do (set automatically by `alfred auth microsoft`)
ALFRED_MICROSOFT_TODO_CLIENT_ID=
ALFRED_MICROSOFT_TODO_CLIENT_SECRET=
ALFRED_MICROSOFT_TODO_TENANT_ID=
ALFRED_MICROSOFT_TODO_REFRESH_TOKEN=

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
├── packages/
│   ├── types/        # Shared TypeScript types
│   ├── config/       # YAML + env configuration with Zod validation
│   ├── logger/       # Structured logging (pino)
│   ├── storage/      # SQLite database, repositories, migrations
│   ├── security/     # Rule engine, rate limiting, audit logging
│   ├── llm/          # LLM providers, multi-model router, prompt builder
│   ├── messaging/    # Platform adapters (Telegram, Discord, Matrix, HTTP API, ...)
│   ├── skills/       # Skill system, built-in skills, MCP integration
│   ├── core/         # Orchestration: pipeline, scheduler, speech, learning
│   └── cli/          # CLI commands, setup wizard, bundled entry point
└── apps/
    └── alfred/       # Standalone application entry point
```

### Message Pipeline

```
User Message (Telegram, Discord, Matrix, Signal, WhatsApp, HTTP API, CLI)
    │
    ├── Normalize → Unified message format
    ├── User Lookup → Cross-platform identity resolution
    ├── Context Load → Conversation history + running summary
    ├── Running Summary → Replaces old history with ~200-token structured summary
    ├── Tool Result Trimming → Old large results → short summaries
    ├── Memory Retrieval → Semantic search on stored memories
    ├── Active Learning → Extract new memories (async)
    │
    ├── Skill Filtering → Category-based tool selection per message
    ├── LLM Request → System prompt + context + filtered tools
    │
    ├── Tool Loop (up to 50 iterations)
    │   ├── Security Check → Rule engine evaluation
    │   ├── Skill Execution → Sandboxed skill runner
    │   └── Result → Feed back to LLM
    │
    ├── Response Formatting → Platform-specific (Markdown/HTML)
    ├── Attachment Routing → Images, voice, files
    └── Save → Conversation history + audit log
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
    description: 'What this skill does — the LLM reads this to decide when to use it.',
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

- [x] Web Chat UI (Next.js, Dark Theme, SSE streaming, Dashboard mit Watches/Skills/Scheduled Tasks)
- [x] Watch Chains (Watch A triggers Watch B, depth-limited recursive execution)
- [x] Workflow Branching (if/else conditions, jumpTo, cycle guard)
- [x] Learning Feedback Loop (rejection tracking, behavioral memory, correction signals)
- [x] Reasoning with Actions (structured skill/reminder proposals via confirmation queue)
- [x] Reasoning Engine (cross-domain proactive insights)
- [x] Marketplace search & price comparison (willhaben.at, eBay)
- [x] Workflow chains (multi-step skill pipelines)
- [x] Persistent agents (checkpoint/resume for long-running tasks)
- [x] Self-healing (auto-disable failing skills)
- [x] Security audit — hardened shell blocklist, safe calculator parser, deep log redaction, race condition fixes
- [ ] Google Cloud TTS & ElevenLabs voice providers
- [ ] Plugin marketplace
- [ ] End-to-end encrypted Matrix rooms
- [ ] Multi-user household support
- [ ] Mobile companion app

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

**Markus Dohnal** — [@madh-io](https://github.com/madh-io)

---

<p align="center">
  <sub>Made in Altlengbach.</sub>
</p>
