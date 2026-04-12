# MS Teams Adapter — Spezifikation

**Version:** 1.0 Draft
**Datum:** 2026-04-12
**Status:** Entwurf — Noch nicht umgesetzt
**Referenz:** OpenClaw MS Teams Integration (https://docs.openclaw.ai/channels/msteams)

## Zusammenfassung

Neuer Messaging-Adapter für Microsoft Teams, basierend auf dem Bot Framework SDK. Erlaubt Alfred als Teams-Bot in 1:1 DMs, Gruppenchats und Channels zu arbeiten — identisches Verhalten wie die bestehenden Telegram/Discord/Matrix Adapter.

## Voraussetzungen (existierend)

- Adapter-Pattern in `packages/messaging/src/adapters/` — bereits vorhanden
- Microsoft Graph API Auth — bereits vorhanden (Email, Calendar, Todo nutzen es)
- HTTP API Server — bereits vorhanden
- FileStore + Attachment-Pipeline — bereits vorhanden
- Cross-Platform Skill — bereits vorhanden
- Nginx Proxy Manager + Cloudflare DNS — bereits im Stack

## Architektur-Überblick

```
Teams Client → Microsoft Bot Service → HTTPS POST /api/messages
                                            ↓
                                    Alfred MSTeams Adapter
                                    (botbuilder SDK parst Activity)
                                            ↓
                                    Alfred Message Pipeline
                                    (wie bei Telegram/Discord)
                                            ↓
                                    LLM → Skills → Response
                                            ↓
                                    Bot Framework Turn Context
                                    (reply via SDK)
                                            ↓
                                    Teams Client ← Antwort
```

### Kritischer Unterschied zu anderen Adaptern

Teams braucht einen **eingehenden Webhook** (Bot Framework POST auf öffentliche URL). Alle anderen Alfred-Adapter arbeiten andersrum:

| Adapter | Verbindungsrichtung | Mechanismus |
|---|---|---|
| Telegram | Alfred → Telegram | Long-Polling |
| Discord | Alfred → Discord | WebSocket |
| Matrix | Alfred → Homeserver | Long-Polling / Sync |
| Signal | Alfred → Signal-CLI Bridge | WebSocket |
| WhatsApp | Alfred → whatsapp-web.js | WebSocket |
| **MS Teams** | **Teams → Alfred** | **HTTPS Webhook POST** |

**Lösung:** Subdomain `teams.lokalkraft.at` via Cloudflare DNS → Nginx Proxy Manager → Alfred Port 3978.

---

## Phase 1: Basic Chat (1:1 DMs + Gruppenchat)

### Scope

Alfred empfängt und beantwortet Textnachrichten in Teams. Keine Adaptive Cards, keine File-Uploads, kein Channel-Support. Grundfunktionalität identisch mit der Telegram-Erfahrung.

### Neue Dateien

#### 1. `packages/messaging/src/adapters/msteams.ts` (~300-400 LOC)

```typescript
import {
  CloudAdapter,
  ConfigurationBotFrameworkAuthentication,
  TurnContext,
  ActivityTypes,
} from 'botbuilder';
import type { MessagingAdapter, IncomingMessage, SendOptions } from '../types.js';

export interface MSTeamsAdapterConfig {
  appId: string;
  appPassword: string;
  tenantId: string;
  webhookPort?: number;    // default 3978
  webhookPath?: string;    // default /api/messages
  requireMention?: boolean; // default true (Channels), false (DMs/Groups)
  dmPolicy?: 'open' | 'allowlist' | 'disabled';
  allowedUsers?: string[]; // AAD Object IDs
  replyStyle?: 'thread' | 'top-level';
}

export class MSTeamsAdapter implements MessagingAdapter {
  readonly platform = 'msteams' as const;
  private adapter!: CloudAdapter;
  private server?: import('http').Server;
  private messageHandler?: (msg: IncomingMessage) => Promise<void>;

  constructor(private readonly config: MSTeamsAdapterConfig) {}

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  async start(): Promise<void> {
    // 1. Bot Framework Authentication
    const auth = new ConfigurationBotFrameworkAuthentication({
      MicrosoftAppId: this.config.appId,
      MicrosoftAppPassword: this.config.appPassword,
      MicrosoftAppTenantId: this.config.tenantId,
      MicrosoftAppType: 'SingleTenant',
    });

    // 2. Cloud Adapter (handles token validation, activity parsing)
    this.adapter = new CloudAdapter(auth);

    // 3. Error handler
    this.adapter.onTurnError = async (context, error) => {
      console.error('Teams Bot Error:', error);
      await context.sendActivity('Entschuldigung, ein Fehler ist aufgetreten.');
    };

    // 4. HTTP Server for incoming webhook
    const http = await import('node:http');
    const port = this.config.webhookPort ?? 3978;
    const path = this.config.webhookPath ?? '/api/messages';

    this.server = http.createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === path) {
        await this.adapter.process(req, res, async (context: TurnContext) => {
          await this.handleTurn(context);
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    this.server.listen(port);
  }

  private async handleTurn(context: TurnContext): Promise<void> {
    if (context.activity.type !== ActivityTypes.Message) return;
    if (!this.messageHandler) return;

    const activity = context.activity;

    // Strip bot mention from text (Teams prefixes "@BotName" in channels)
    let text = activity.text ?? '';
    if (activity.entities) {
      for (const entity of activity.entities) {
        if (entity.type === 'mention' && entity.mentioned?.id === this.config.appId) {
          text = text.replace(entity.text ?? '', '').trim();
        }
      }
    }

    // Policy check
    const senderId = activity.from?.aadObjectId;
    if (this.config.dmPolicy === 'allowlist' && senderId) {
      if (!this.config.allowedUsers?.includes(senderId)) return;
    }

    // Map to Alfred IncomingMessage
    const msg: IncomingMessage = {
      platform: 'msteams',
      chatId: activity.conversation.id,
      userId: senderId ?? activity.from?.id ?? 'unknown',
      userName: activity.from?.name,
      text,
      replyTo: activity.replyToId,
      // Store TurnContext reference for reply routing
      _turnContext: context,
    };

    await this.messageHandler(msg);
  }

  async sendMessage(chatId: string, text: string, opts?: SendOptions): Promise<string> {
    // For reply-in-context: use stored TurnContext
    // For proactive messages: use ConversationReference + continueConversation
    // Phase 1: only reply-in-context via TurnContext
    // Phase 2: proactive messaging via stored ConversationReferences
    throw new Error('TODO: implement sendMessage');
  }

  async stop(): Promise<void> {
    this.server?.close();
  }
}
```

**Wichtiger Architektur-Punkt:** Bot Framework replies sind **synchron im Turn-Context**. Man muss innerhalb des HTTP-Request-Lifecycles antworten. Wenn Alfred's LLM-Pipeline >15 Sekunden braucht, muss man:
- Sofort ein "Typing..." Indicator senden
- Dann per `proactive messaging` nachträglich die Antwort senden
- Dafür `ConversationReference` speichern und `adapter.continueConversation()` nutzen

#### 2. `packages/types/src/config.ts` — Config-Erweiterung (~20 LOC)

```typescript
export interface MSTeamsConfig {
  /** Azure Bot App ID (= Entra App Registration Client ID). */
  appId: string;
  /** Client Secret from Entra App Registration. */
  appPassword: string;
  /** Azure AD Tenant ID (single-tenant mode). */
  tenantId: string;
  /** Port for Bot Framework webhook listener. Default: 3978. */
  webhookPort?: number;
  /** Path for Bot Framework webhook. Default: /api/messages. */
  webhookPath?: string;
  /** Who may DM the bot. Default: 'open'. */
  dmPolicy?: 'open' | 'allowlist' | 'disabled';
  /** AAD Object IDs of allowed users (for dmPolicy='allowlist'). */
  allowedUsers?: string[];
  /** Require @mention in channels. Default: true. */
  requireMention?: boolean;
  /** Reply style in channels. Default: 'thread'. */
  replyStyle?: 'thread' | 'top-level';
  /** SharePoint Site ID for file uploads in channels/groups. */
  sharePointSiteId?: string;
  /** Max messages to fetch for conversation history via Graph API. Default: 50. */
  historyLimit?: number;
}
```

#### 3. Config Loader + Zod Schema (~20 LOC)

```typescript
// In loader.ts ENV_MAP:
ALFRED_MSTEAMS_APP_ID: ['msteams', 'appId'],
ALFRED_MSTEAMS_APP_PASSWORD: ['msteams', 'appPassword'],
ALFRED_MSTEAMS_TENANT_ID: ['msteams', 'tenantId'],
ALFRED_MSTEAMS_WEBHOOK_PORT: ['msteams', 'webhookPort'],
ALFRED_MSTEAMS_DM_POLICY: ['msteams', 'dmPolicy'],
ALFRED_MSTEAMS_REQUIRE_MENTION: ['msteams', 'requireMention'],
ALFRED_MSTEAMS_REPLY_STYLE: ['msteams', 'replyStyle'],
```

#### 4. `packages/core/src/alfred.ts` — Adapter-Registrierung (~15 LOC)

```typescript
// Nach den bestehenden Adapter-Registrierungen (Telegram, Discord, etc.)
if (this.config.msteams?.appId) {
  const { MSTeamsAdapter } = await import('@alfred/messaging');
  const teamsAdapter = new MSTeamsAdapter(this.config.msteams);
  this.registerAdapter(teamsAdapter);
  this.logger.info('MS Teams adapter enabled');
}
```

#### 5. NPM Dependency

```bash
pnpm add botbuilder  # Microsoft Bot Framework SDK
# Muss in packages/messaging/package.json als dependency
# UND in packages/cli/package.json als externalisierte dependency
```

`botbuilder` wird wie `mqtt`, `sonos`, `ccxt` als externalisierte Dependency behandelt:
- Lazy-Loading via `Function('return import("botbuilder")')()` im Adapter
- In CLI `package.json` dependencies (nicht devDependencies)

### Azure Bot Setup (einmalig, manuell)

#### Option A: Existierende Entra App erweitern

Alfred hat bereits eine Microsoft App Registration für Email/Calendar/Todo. Diese kann erweitert werden:

1. **Azure Portal → Entra ID → App Registrations → deine existierende App**
2. **API Permissions hinzufügen:**
   - `ChannelMessage.Read.All` (Application)
   - `Chat.Read.All` (Application)
   - `User.Read.All` (Application, optional)
3. **Azure Portal → Bot Services → Create**
   - Bot handle: `alfred-teams-bot`
   - App ID: deine existierende App ID
   - Messaging endpoint: `https://teams.lokalkraft.at/api/messages`
   - Type: Single Tenant
4. **Admin Consent** für die neuen Permissions erteilen

#### Option B: Neue App Registration

Eigene App nur für Teams. Sauberer getrennt, aber mehr Verwaltung.

**Empfehlung:** Option A — eine App, mehrere Scopes. Weniger Credentials zu verwalten.

### Teams App Manifest

```json
{
  "$schema": "https://developer.microsoft.com/json-schemas/teams/v1.23/MicrosoftTeams.schema.json",
  "manifestVersion": "1.23",
  "version": "1.0.0",
  "id": "<APP-ID>",
  "developer": {
    "name": "Alfred AI",
    "websiteUrl": "https://lokalkraft.at",
    "privacyUrl": "https://lokalkraft.at/privacy",
    "termsOfUseUrl": "https://lokalkraft.at/terms"
  },
  "name": {
    "short": "Alfred",
    "full": "Alfred — Personal AI Assistant"
  },
  "description": {
    "short": "AI-gestützter persönlicher Assistent",
    "full": "Alfred ist ein AI-Assistent der Kalender, Email, Smart Home, Infrastruktur und mehr verwaltet."
  },
  "icons": {
    "outline": "outline.png",
    "color": "color.png"
  },
  "accentColor": "#4F46E5",
  "bots": [
    {
      "botId": "<APP-ID>",
      "scopes": ["personal", "team", "groupChat"],
      "supportsFiles": true,
      "commandLists": [
        {
          "scopes": ["personal"],
          "commands": [
            { "title": "status", "description": "Systemstatus anzeigen" },
            { "title": "help", "description": "Hilfe und verfügbare Skills" },
            { "title": "briefing", "description": "Tägliches Briefing" }
          ]
        }
      ]
    }
  ],
  "webApplicationInfo": {
    "id": "<APP-ID>",
    "resource": "api://<APP-ID>"
  },
  "authorization": {
    "permissions": {
      "resourceSpecific": [
        { "name": "ChannelMessage.Read.Group", "type": "Application" },
        { "name": "ChatMessage.Read.Chat", "type": "Application" }
      ]
    }
  },
  "validDomains": ["teams.lokalkraft.at"]
}
```

**Deployment:** ZIP (manifest.json + outline.png + color.png) → Teams Admin Center → Upload → Install in Teams/Channels.

### Infrastruktur-Setup

```
Internet → Cloudflare DNS (teams.lokalkraft.at)
         → Nginx Proxy Manager (Host: teams.lokalkraft.at → http://192.168.1.92:3978)
         → Alfred MSTeams Adapter (Port 3978, /api/messages)
```

- Cloudflare DNS Skill kann den DNS-Eintrag erstellen
- Nginx Proxy Manager Skill kann den Proxy Host + Let's Encrypt Cert erstellen
- Alfred Deploy Skill kann das Setup orchestrieren

---

## Phase 2: Files, History, Proactive Messaging

### Scope

- File-Empfang (Bilder, PDFs in DMs → Alfred verarbeitet)
- File-Versand (FileStore → SharePoint Upload → Sharing Link in Chat)
- Conversation History via Graph API (für Kontext in Channels)
- Proactive Messaging (Alfred sendet ohne dass User zuerst schreibt — für Insights, Reminders)

### File-Empfang

Teams sendet Attachments als URL-Referenzen im Activity. Download via Graph API:

```typescript
// In handleTurn:
if (activity.attachments?.length) {
  for (const att of activity.attachments) {
    if (att.contentUrl) {
      // Download via Graph API (authenticated)
      const buffer = await this.graphDownload(att.contentUrl);
      msg.attachments.push({ fileName: att.name, data: buffer, mimeType: att.contentType });
    }
  }
}
```

### File-Versand

**DMs:** FileConsentCard (Bot Framework built-in) → User erlaubt Upload → Bot uploadet

**Channels/Groups:** SharePoint Upload via Graph API:
```
PUT https://graph.microsoft.com/v1.0/sites/{sharePointSiteId}/drive/root:/{fileName}:/content
```
Dann Sharing-Link im Chat posten.

### Proactive Messaging

Für Insights, Reminders und proaktive Benachrichtigungen muss Alfred Nachrichten senden können OHNE dass der User zuerst schreibt. Das Bot Framework unterstützt das via `ConversationReference`:

```typescript
// Bei jedem eingehenden Turn: ConversationReference speichern
private conversationRefs = new Map<string, Partial<ConversationReference>>();

private async handleTurn(context: TurnContext): Promise<void> {
  const ref = TurnContext.getConversationReference(context.activity);
  this.conversationRefs.set(context.activity.conversation.id, ref);
  // ... normal processing
}

// Proactive send:
async sendMessage(chatId: string, text: string): Promise<string> {
  const ref = this.conversationRefs.get(chatId);
  if (!ref) throw new Error('No conversation reference for this chat');
  await this.adapter.continueConversation(ref, async (context) => {
    await context.sendActivity(text);
  });
}
```

**ConversationReference Persistenz:** In DB speichern (neue Tabelle oder in `adapter_state`), damit Alfred nach Restart noch proaktive Messages senden kann.

### Conversation History via Graph API

```
GET https://graph.microsoft.com/v1.0/teams/{teamId}/channels/{channelId}/messages?$top=50
GET https://graph.microsoft.com/v1.0/chats/{chatId}/messages?$top=50
```

Braucht `ChannelMessage.Read.All` / `Chat.Read.All` Application Permission.

Integration in Alfred's Conversation-System: History als Kontext vor dem LLM-Call laden, ähnlich wie bei Telegram-Threads.

---

## Phase 3: Adaptive Cards + Rich Features

### Adaptive Cards

Strukturierte interaktive Elemente statt reinem Text:

```typescript
const card = CardFactory.adaptiveCard({
  type: "AdaptiveCard",
  body: [
    { type: "TextBlock", text: "BMW i4 Status", weight: "Bolder", size: "Medium" },
    { type: "FactSet", facts: [
      { title: "SoC", value: "64%" },
      { title: "Reichweite", value: "212 km" },
      { title: "Standort", value: "Altlengbach" },
    ]},
  ],
  actions: [
    { type: "Action.Submit", title: "Laden starten", data: { action: "charge_start" } },
    { type: "Action.Submit", title: "Status aktualisieren", data: { action: "bmw_status" } },
  ],
});
await context.sendActivity({ attachments: [card] });
```

Use Cases für Adaptive Cards:
- **Confirmation Queue:** "Soll ich X tun?" als Card mit Ja/Nein Buttons
- **BMW Status:** Faktengitter mit Laden-Button
- **Smart Home:** Schnellzugriff auf Geräte
- **ITSM Incidents:** Status-Übersicht mit Update-Button
- **Briefing:** Tagesübersicht als strukturierte Card

### @Mention Support

Alfred kann in Channels Users @mentionen:
```typescript
const mention = {
  type: 'mention',
  text: `<at>${userName}</at>`,
  mentioned: { id: userId, name: userName },
};
await context.sendActivity({
  text: `<at>${userName}</at>, dein BMW hat nur noch 20% SoC!`,
  entities: [mention],
});
```

### Typing Indicator

```typescript
await context.sendActivity({ type: ActivityTypes.Typing });
// ... long LLM processing ...
await context.sendActivity(response);
```

Wichtig für UX: Teams zeigt "Alfred tippt..." Indikator an.

---

## Sicherheit

### Webhook-Validierung

Das Bot Framework SDK (`CloudAdapter`) validiert automatisch:
- JWT Token im `Authorization` Header
- App ID + Tenant ID Match
- Signature-Validierung

Kein Custom-Code nötig — das SDK handhabt es.

### Access Control

```typescript
interface AccessPolicy {
  dmPolicy: 'open' | 'allowlist' | 'disabled';
  allowedUsers: string[];          // AAD Object IDs
  groupPolicy: 'open' | 'allowlist' | 'disabled';
  allowedGroups: string[];         // Group/Chat IDs
  channelRequireMention: boolean;  // @Alfred in Channels required?
}
```

### Credential Storage

- `appPassword` in `.env` oder Vault (wie bestehende Microsoft Secrets)
- Keine Hardcoded Secrets im Code
- Token-Refresh via Bot Framework SDK automatisch

---

## Bekannte Einschränkungen

| Einschränkung | Workaround |
|---|---|
| **Webhook-Timeout:** Wenn LLM >15s braucht, kann Teams retries senden | Typing-Indicator sofort, proactive reply danach |
| **Markdown-Limits:** Teams rendert nur basic Markdown (kein Table, keine nested Lists) | Adaptive Cards für komplexe Layouts |
| **Kein `/me/drive`:** Bots haben kein eigenes OneDrive | SharePoint Upload für File-Sharing in Channels |
| **Private Channels:** Webhook-Delivery unzuverlässig | Graph API als Fallback |
| **Rate Limits:** Bot Framework hat Throttling | Retry-Logic mit exponential backoff |
| **Attachment-Payload:** Channel-Webhooks liefern nur HTML-Stubs, keine File-Bytes | Graph API Download |

---

## Aufwand-Schätzung

| Phase | Scope | Dateien | LOC | Aufwand |
|---|---|---|---|---|
| **Phase 1** | Basic Chat (DM + Group) | 4 neue + 3 geändert | ~400 | 1-2 Tage |
| **Phase 2** | Files + History + Proactive | +2 neue | ~300 | 1 Tag |
| **Phase 3** | Adaptive Cards + Rich Features | +1 neu | ~200 | 1 Tag |
| **Setup** | Azure Bot + Manifest + DNS/Proxy | manuell | — | 1-2h |
| **Gesamt** | | | ~900 | 3-5 Tage |

## NPM Dependencies

```json
{
  "botbuilder": "^4.23.0",
  "botframework-connector": "^4.23.0"
}
```

Externalisiert wie `mqtt`, `sonos`, `ccxt` — lazy-loaded im Adapter, in CLI `package.json` als dependency.

---

## Entscheidungen vor Implementation

1. **Existierende Entra App erweitern oder neue App?** (Empfehlung: erweitern)
2. **Port 3978 oder anderer?** (3978 ist Bot Framework Convention, aber frei wählbar)
3. **Subdomain:** `teams.lokalkraft.at` oder `bot.lokalkraft.at` oder anderer Name?
4. **Phase 1 solo oder mit Phase 2?** (Empfehlung: Phase 1 solo, validieren, dann erweitern)
5. **Soll Alfred in Channels antworten?** Oder nur DMs/Gruppenchats? (Channels brauchen RSC Permissions)
6. **Typing Indicator:** Immer oder nur bei langen Requests? (Empfehlung: immer)
7. **ConversationReference Persistenz:** Neue DB-Tabelle oder bestehende `adapter_state`?

## Referenzen

- Bot Framework SDK: https://github.com/microsoft/botbuilder-js
- Teams App Manifest Schema: https://learn.microsoft.com/en-us/microsoftteams/platform/resources/schema/manifest-schema
- Graph API Messages: https://learn.microsoft.com/en-us/graph/api/channel-list-messages
- Proactive Messaging: https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages
- Adaptive Cards: https://adaptivecards.io/designer/
- OpenClaw MS Teams Reference: https://docs.openclaw.ai/channels/msteams
