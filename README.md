<p align="center">
  <img src="https://img.shields.io/badge/version-0.9.35-blue" alt="Version">
  <img src="https://img.shields.io/badge/node-%3E%3D20-green" alt="Node">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
  <img src="https://img.shields.io/badge/typescript-5.7+-blue" alt="TypeScript">
</p>

<h1 align="center">Alfred</h1>

<p align="center">
  <strong>Self-hosted AI assistant for Telegram, Discord, WhatsApp, Matrix & Signal</strong>
</p>

<p align="center">
  Alfred is a self-hosted AI assistant that connects to Telegram, Discord, WhatsApp, Matrix, and Signal simultaneously. It remembers who you are across platforms, learns from every conversation, and executes real-world tasks through an extensible skill system.
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
| **CLI** | built-in | Interactive terminal mode for local use |

### LLM Providers

| Provider | Models | API Key Required |
|----------|--------|:---:|
| **Anthropic** | Claude Opus, Sonnet, Haiku | Yes |
| **OpenAI** | GPT-4o, GPT-4, GPT-3.5 | Yes |
| **Google** | Gemini 2.0 Flash, Gemini Pro | Yes |
| **OpenRouter** | 200+ models via unified API | Yes |
| **Ollama** | Llama, Mistral, Phi, any local model | No |
| **Open WebUI** | Any OpenAI-compatible endpoint | Configurable |

**Multi-Model Routing** — Configure different models for different tasks:

```yaml
llm:
  default:
    provider: anthropic
    model: claude-sonnet-4-20250514
  strong:
    provider: anthropic
    model: claude-opus-4-0-20250115
  fast:
    provider: openai
    model: gpt-4o-mini
  local:
    provider: ollama
    model: llama3.2
```

### Built-in Skills (21+)

Alfred exposes capabilities as **skills** — tools the LLM can call autonomously based on your request.

| Category | Skills | Description |
|----------|--------|-------------|
| **Memory** | `memory`, `note`, `profile` | Persistent storage, recall, semantic search |
| **Communication** | `email`, `cross_platform`, `delegate` | Send/read emails, cross-platform messaging, autonomous sub-agents |
| **Scheduling** | `reminder`, `scheduled_task`, `background_task` | Timed reminders, cron jobs, long-running tasks |
| **Information** | `web_search`, `weather`, `system_info`, `calculator` | Brave/Tavily/SearXNG/DuckDuckGo search, weather, system info |
| **Documents** | `document` | Ingest PDF, DOCX, TXT, CSV — RAG with semantic search |
| **Code** | `code_sandbox` | Execute JavaScript & Python in an isolated sandbox |
| **Files & System** | `file`, `clipboard`, `screenshot`, `shell`, `http` | Read/write files, clipboard, screenshots, shell commands, HTTP requests |
| **Media** | `browser`, `tts` | Web browsing via Puppeteer, text-to-speech voice messages |
| **Calendar** | `calendar` | CalDAV, Google Calendar, Microsoft Calendar |

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

Supported formats: PDF, DOCX, XLSX, PPTX, TXT, CSV, MD, HTML, JSON, XML, and more.

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
3. **LLM provider** — Choose your AI provider and model
4. **Optional features** — Speech, email, calendar, web search, code sandbox

This generates `config.yaml` and `.env` in your working directory.

### Start

```bash
alfred start
```

Alfred connects to all configured platforms and starts listening.

### CLI Chat Mode

Talk to Alfred directly in your terminal:

```bash
alfred chat
alfred chat --model gpt-4o        # use a specific model
alfred chat --tier strong          # use the strong tier
```

### Other Commands

```bash
alfred status        # Show connection status and loaded skills
alfred config        # Display current configuration (keys redacted)
alfred rules         # List active security rules
alfred logs          # Show recent audit log entries
alfred --version     # Show version
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
    model: claude-sonnet-4-20250514

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
  imap:
    host: imap.gmail.com
    port: 993
    secure: true
  smtp:
    host: smtp.gmail.com
    port: 587

mcp: []
```

### Environment Variables

```bash
# Platform tokens
ALFRED_TELEGRAM_TOKEN=
ALFRED_DISCORD_TOKEN=
ALFRED_MATRIX_ACCESS_TOKEN=
ALFRED_SIGNAL_PHONE_NUMBER=

# LLM API keys
ALFRED_ANTHROPIC_API_KEY=
ALFRED_OPENAI_API_KEY=
ALFRED_GOOGLE_API_KEY=
ALFRED_OPENROUTER_API_KEY=

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
│   ├── messaging/    # Platform adapters (Telegram, Discord, Matrix, ...)
│   ├── skills/       # Skill system, built-in skills, MCP integration
│   ├── core/         # Orchestration: pipeline, scheduler, speech, learning
│   └── cli/          # CLI commands, setup wizard, bundled entry point
└── apps/
    └── alfred/       # Standalone application entry point
```

### Message Pipeline

```
User Message (any platform)
    │
    ├── Normalize → Unified message format
    ├── User Lookup → Cross-platform identity resolution
    ├── Context Load → Conversation history + token budgeting
    ├── Memory Retrieval → Semantic search on stored memories
    ├── Active Learning → Extract new memories (async)
    │
    ├── LLM Request → System prompt + context + tools
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

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm && pnpm install --prod
COPY . .
RUN pnpm build && pnpm --filter @madh-io/alfred-ai bundle
CMD ["node", "packages/cli/bundle/index.js", "start"]
```

### macOS (launchd)

```bash
alfred start > /tmp/alfred.log 2>&1 &
```

---

## Roadmap

- [ ] Google Cloud TTS & ElevenLabs voice providers
- [ ] Web dashboard for configuration and monitoring
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
