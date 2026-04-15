# Self-Reflection + Automation Platform Design

## Goal

Alfred soll wie ein Mensch sein eigenes Verhalten reflektieren und daraus lernen (Phase 1), und als vollwertige Automation-Plattform dienen die n8n/Node-RED ersetzt (Phase 2). Beide Phasen bauen aufeinander auf.

## Architecture

Zwei neue Module neben dem bestehenden ReasoningEngine:

- **ReflectionEngine** (Phase 1) — Analysiert Alfreds eigenes Verhalten (Watches, Workflows, Reminder, Konversationen). Läuft 1x täglich (konfigurierbar). Passt Alfreds Konfiguration an, schlägt Verbesserungen vor, lernt aus User-Interaktionen.
- **AutomationBuilder** (Phase 2) — Erweitert den bestehenden Workflow-Skill zu einer vollwertigen Automation-Plattform. Jeder Skill = ein Node. Persistente Trigger, Script-Generierung, DB-Tabellen, Webhooks, MQTT, HA-native Automationen. Natürliche Sprach-Erstellung per Chat.

```
ReasoningEngine (alle 30min)     ReflectionEngine (1x täglich)
    |                                |
Sammelt Kontext                  Analysiert Alfreds eigenes Verhalten
    |                                |
Generiert Insights fuer USER     Generiert Aktionen fuer ALFRED SELBST
    |                                |
Sendet Telegram-Nachricht        Passt Watches/Workflows/Reminder an
                                 Schlaegt Automationen vor
                                 Speichert gelernte Regeln
```

ReflectionEngine sitzt NEBEN dem ReasoningEngine (nicht darin). Grund: anderer Rhythmus (taeglich vs halbstuendlich), anderer Kontext (Wochen-Rueckblick vs aktuelle Daten), anderes Budget (tiefgehende Analyse vs schnelle Insights).

## Tech Stack

- TypeScript (bestehend)
- Pino Logger (bestehend)
- PostgreSQL/SQLite (bestehend, kein neues Schema fuer Automationen)
- LLM: nur fuer Konversations-Reflexion und Vorschlags-Formulierung
- WatchEngine, WorkflowRunner, ProactiveScheduler (bestehend, erweitert)

---

## Phase 1: ReflectionEngine

### Komponenten

```
ReflectionEngine
  WatchReflector        - evaluiert alle aktiven Watches
  WorkflowReflector     - evaluiert alle Workflows
  ReminderReflector     - evaluiert aktive/kuerzliche Reminder
  ConversationReflector - analysiert Chat-Patterns der letzten 7 Tage
  ActionExecutor        - fuehrt Reflexions-Ergebnisse aus
```

### ReflectionResult Interface

```typescript
interface ReflectionResult {
  target: { type: 'watch' | 'workflow' | 'reminder' | 'suggestion'; id?: string };
  finding: string;           // Was wurde erkannt
  action: 'adjust' | 'delete' | 'create' | 'suggest' | 'deactivate';
  params?: Record<string, unknown>;  // Neue Parameter
  risk: 'auto' | 'proactive' | 'confirm';
  reasoning: string;         // Warum (fuer User-Nachricht und Logging)
}
```

### WatchReflector

| Signal | Erkennung | Schwellwert (konfigurierbar) | Aktion | Risk |
|---|---|---|---|---|
| Watch triggert nie | lastTriggeredAt aus DB | staleAfterDays: 14 | Schwellwert anpassen | auto |
| Watch triggert nie (lang) | lastTriggeredAt aus DB | deleteAfterDays: 30 | Watch loeschen | proactive |
| Watch triggert zu oft | Trigger-Count aus ActivityLog | maxTriggersPerDay: 10 | Cooldown/Schwellwert verschaerfen | auto |
| Watch-Alert wird ignoriert | InsightTracker + ActivityLog | ignoredAlertsBeforePause: 5 | Watch pausieren | proactive |
| Watch-Action schlaegt fehl | SkillHealth + ActivityLog | failedActionsBeforeDisable: 3 | Watch deaktivieren | proactive |

Arbeitet regelbasiert: DB-Queries + Schwellwerte. Kein LLM noetig.

### WorkflowReflector

| Signal | Erkennung | Schwellwert | Aktion | Risk |
|---|---|---|---|---|
| Workflow schlaegt bei Step X fehl | Execution-History | failedStepsBeforeSuggest: 3 | Vorschlag an User | confirm |
| Workflow wird nie gestartet | lastRunAt aus DB | staleAfterDays: 30 | User fragen | confirm |
| Workflow-Ergebnis wird nie genutzt | Kein Follow-up im Chat | (abgeleitet) | Deaktivieren | proactive |

Arbeitet regelbasiert. Kein LLM noetig.

### ReminderReflector

| Signal | Erkennung | Schwellwert | Aktion | Risk |
|---|---|---|---|---|
| User erstellt gleichen Reminder-Typ wiederholt | Memory-Pattern | repeatPatternDays: 7 | Recurring Reminder oder Watch vorschlagen | confirm |
| Reminder wird sofort dismissed | ActivityLog: fired -> response <30s | quickDismissSeconds: 30 | Timing anpassen | auto |
| Reminder-Thema bereits erledigt | insight_resolved Memory | (automatisch) | Reminder loeschen | auto |

Arbeitet regelbasiert. Kein LLM noetig.

### ConversationReflector

| Signal | Erkennung | Schwellwert | Aktion | Risk |
|---|---|---|---|---|
| User fragt 3x+ dasselbe in 7 Tagen | Chat-History Topic-Hash Match | repeatQueryThreshold: 3 | Automation vorschlagen | confirm |
| User fuehrt gleiche Skill-Sequenz aus | ActivityLog: A->B->C wiederholt | repeatSequenceThreshold: 3 | Workflow vorschlagen | confirm |
| User korrigiert Alfred wiederholt | Correction-Memories gleiche Keywords | (automatisch) | Regel verstaerken | auto |

Nutzt LLM fuer: Intent-Erkennung aus Chat-History, Vorschlags-Formulierung.

### ActionExecutor

Gruppiert ReflectionResults nach Risk:
- `auto` -> leise ausfuehren, im naechsten Insight erwaehnen ("Ich habe Watch X angepasst weil...")
- `proactive` -> ausfuehren + sofort User informieren ("Watch X seit 30 Tagen ohne Trigger - geloescht")
- `confirm` -> als Vorschlag an User senden ("Du fragst oft nach Strompreis - soll ich eine Automation bauen?")

### Konfiguration

```yaml
reflection:
  enabled: true
  schedule: "0 4 * * *"

  watches:
    staleAfterDays: 14
    deleteAfterDays: 30
    maxTriggersPerDay: 10
    ignoredAlertsBeforePause: 5
    failedActionsBeforeDisable: 3

  workflows:
    staleAfterDays: 30
    failedStepsBeforeSuggest: 3

  reminders:
    repeatPatternDays: 7
    quickDismissSeconds: 30

  conversation:
    repeatQueryThreshold: 3
    repeatSequenceThreshold: 3
    analysisWindowDays: 7

  autonomy:
    adjustParams: "auto"
    deleteWatch: "proactive"
    createAutomation: "confirm"
    deactivate: "proactive"
```

Alle Werte haben sinnvolle Defaults. ENV-Overrides: `ALFRED_REFLECTION_ENABLED`, `ALFRED_REFLECTION_SCHEDULE`, `ALFRED_REFLECTION_WATCHES_STALE_AFTER_DAYS`, etc.

---

## Phase 2: AutomationBuilder

### Kernprinzip

Kein neues Automation-Konzept. Der bestehende Workflow-Skill wird erweitert. Jeder der 90+ Skills ist ein "Node". Workflows bekommen persistente Trigger, neue Step-Typen, und natuerliche Sprach-Erstellung.

### Workflow-Schema Erweiterung

Bestehendes Schema:
```typescript
{ name: string; steps: WorkflowStep[]; description: string; }
```

Erweitert um:
```typescript
{
  name: string;
  description: string;
  steps: WorkflowStep[];

  trigger?: {
    type: 'cron' | 'interval' | 'webhook' | 'watch' | 'mqtt' | 'manual';
    value: string;     // cron expr | minutes | webhook-name | watch-id | mqtt-topic
    enabled: boolean;
    guards?: Array<
      | { type: 'time_window'; value: string }      // "22:00-06:00"
      | { type: 'weekday'; value: string }           // "mon,tue,wed,thu,fri"
      | { type: 'skill_condition'; skillName: string; skillParams: Record<string, unknown>;
          field: string; operator: string; compareValue: unknown }
    >;
  };

  monitoring?: {
    enabled: boolean;
    notifyOnFailure: boolean;
    notifyFirstNRuns: number;            // Default: 3
    autoDisableAfterFailures: number;    // Default: 3 (Self-Healing via ReflectionEngine)
  };
}
```

### Node-Typen (Step-Typen)

| Typ | Beschreibung | Bestaetigung noetig? |
|---|---|---|
| **action** | Bestehend: skillName + inputMapping + onError | Nein |
| **condition** | Bestehend: field + operator + value + then/else | Nein |
| **script** | NEU: Python/Node.js/Bash Code generiert von Alfred | Ja (Code-Review) |
| **db_query** | NEU: SQL SELECT/INSERT/UPDATE/CREATE TABLE | Ja bei CREATE, Nein bei SELECT/INSERT |
| **webhook_register** | NEU: Registriert Webhook-Endpoint zur Laufzeit | Ja |
| **ha_automation** | NEU: Erstellt native HA-Automation/Script/Scene | Ja |

#### Script-Node Detail

```typescript
{
  type: 'script';
  language: 'python' | 'node' | 'bash';
  code: string;          // Von Alfred generiert, vom User reviewed
  timeout: number;        // Default: 30s
  outputFormat: 'json' | 'text';
}
```

- Code gespeichert unter `./data/scripts/{workflow}_{step}.{ext}`
- Ausgefuehrt ueber Shell-Skill
- Output als JSON geparst fuer nachfolgende Steps via `{{steps.N.field}}`
- Sicherheit: Script-Erstellung = HIGH_RISK (Confirmation). Script-Ausfuehrung in laufender Automation = PROACTIVE.

#### DB-Query-Node Detail

```typescript
{
  type: 'db_query';
  sql: string;           // Template-Referenzen erlaubt: {{steps.0.price}}
  params?: string[];
  createTable?: boolean; // Wenn true: HIGH_RISK Confirmation
}
```

- Alfred kann eigene `automation_data_{name}` Tabellen erstellen fuer persistente Daten
- ReflectionEngine raeumt verwaiste Tabellen auf wenn Automation geloescht wird

#### Webhook-Register-Node Detail

```typescript
{
  type: 'webhook_register';
  name: string;          // URL wird /api/webhook/{name}
  secret: string;        // HMAC-SHA256 Validierung
}
```

- Nutzt bestehende `addWebhook()` Infrastruktur im HTTP-Adapter
- Webhook wird bei Workflow-Loeschung deregistriert
- Webhook-Payload verfuegbar als `{{trigger.body}}`

### Trigger-Typen

| Trigger | Infrastruktur | Alfred kann einrichten? |
|---|---|---|
| cron | scheduled_actions + ProactiveScheduler | Ja (scheduled_task Skill) |
| interval | Intern gleich wie cron | Ja |
| webhook | HTTP-Adapter /api/webhook/{name} | Ja (NEU: dynamische Registrierung) |
| watch | WatchEngine onWatchTriggered | Ja (watch Skill) |
| mqtt | MQTT-Skill Subscribe | NEU: persistenter MQTT-Subscriber als Trigger |
| manual | Workflow run Action | Ja (bestehend) |

#### Guard-Conditions auf Trigger

Guards werden VOR dem Workflow-Start evaluiert. Wenn ein Guard false ergibt, wird der Workflow uebersprungen:

- **time_window**: "22:00-06:00" — nur in diesem Zeitfenster
- **weekday**: "mon,tue,wed,thu,fri" — nur an diesen Tagen
- **skill_condition**: Skill-Abfrage als Pre-Check. Beispiel: "Trigger alle 15min, ABER nur wenn BMW SoC < 60%"

### Natuerliche Sprach-Erstellung

Neue Workflow-Action: `create_from_prompt`

Ablauf:
1. User beschreibt Automation in natuerlicher Sprache
2. LLM parst Intent, identifiziert benoetigte Skills
3. Alfred baut Workflow-Struktur (Steps, Trigger, Conditions)
4. Dry-Run: Alfred fuehrt Workflow einmal aus ohne Seiteneffekte, zeigt Ergebnis
5. User bestaetigt -> Workflow wird persistiert und aktiviert

### Self-Healing (via ReflectionEngine Phase 1)

ReflectionEngine ueberwacht alle Automationen:
- Fehlgeschlagene Steps -> Parameter anpassen oder User informieren
- Script-Fehler -> Fehler analysieren, Fix vorschlagen
- Webhook nicht mehr aufgerufen -> User fragen ob noch noetig
- HA-Automation Konflikte -> erkennen wenn zwei Automationen sich widersprechen
- Verwaiste DB-Tabellen -> aufraeumen nach Automation-Loeschung

### Fehlende Infrastruktur (muss gebaut werden)

1. **Dynamische Webhooks** — Workflow registriert/deregistriert Webhooks zur Laufzeit. `addWebhook()` existiert, muss mit Workflow-Lifecycle verbunden werden + DB-Persistenz fuer Webhook-Registrierungen.

2. **MQTT als Trigger** — Persistenter MQTT-Subscriber der bei Message einen Workflow startet. MQTT-Skill existiert als Request/Response, braucht einen Push-Listener-Modus.

3. **Time-Window/Weekday Guards** — Guard-Evaluation vor Workflow-Start. Reine Logik, keine externe Abhaengigkeit.

4. **Workflow Trigger-Integration** — WorkflowRunner muss mit ProactiveScheduler (cron/interval), WatchEngine (watch-trigger), und HTTP-Adapter (webhook) verbunden werden.

5. **Script-Persistenz** — `./data/scripts/` Verzeichnis, Script-Lifecycle an Workflow gekoppelt.

---

## Sicherheit

| Aktion | Risk-Level | Verhalten bei proactive |
|---|---|---|
| Watch-Parameter anpassen (Interval, Schwellwert) | auto | Leise, im naechsten Insight erwaehnen |
| Watch loeschen/deaktivieren | proactive | Ausfuehren + User informieren |
| Reminder loeschen (erledigt) | auto | Leise |
| Workflow deaktivieren | proactive | Ausfuehren + User informieren |
| Automation/Workflow vorschlagen | confirm | User muss bestaetigen |
| Script erstellen/aendern | confirm (HIGH_RISK) | User muss Code reviewen |
| DB-Tabelle erstellen | confirm (HIGH_RISK) | User muss bestaetigen |
| Webhook registrieren | confirm (HIGH_RISK) | User muss bestaetigen |
| HA-Automation erstellen | confirm (HIGH_RISK) | User muss bestaetigen |
| Bestehende Automation-Parameter anpassen | auto | Leise, loggen |

User kann per Memory `autonomy_level: confirm_all` alles auf Bestaetigung zuruecksetzen.

---

## Dateien + Aenderungen (Uebersicht)

### Phase 1: ReflectionEngine

| Datei | Aenderung |
|---|---|
| `packages/core/src/reflection-engine.ts` | NEU: Hauptmodul |
| `packages/core/src/reflection/watch-reflector.ts` | NEU: Watch-Analyse |
| `packages/core/src/reflection/workflow-reflector.ts` | NEU: Workflow-Analyse |
| `packages/core/src/reflection/reminder-reflector.ts` | NEU: Reminder-Analyse |
| `packages/core/src/reflection/conversation-reflector.ts` | NEU: Chat-Pattern-Analyse (LLM) |
| `packages/core/src/reflection/action-executor.ts` | NEU: Ergebnisse ausfuehren |
| `packages/core/src/alfred.ts` | ReflectionEngine instanziieren + Timer |
| `packages/types/src/config.ts` | ReflectionConfig Interface |
| `packages/config/src/schema.ts` | Zod-Schema |
| `packages/config/src/defaults.ts` | Default-Werte |
| `packages/config/src/loader.ts` | ENV-Mappings |

### Phase 2: AutomationBuilder

| Datei | Aenderung |
|---|---|
| `packages/skills/src/built-in/workflow.ts` | Erweitert: Trigger, neue Step-Typen, create_from_prompt |
| `packages/core/src/workflow-runner.ts` | Erweitert: Script-Execution, DB-Query, Guard-Evaluation |
| `packages/core/src/alfred.ts` | Trigger-Wiring (cron->Workflow, watch->Workflow, webhook->Workflow) |
| `packages/messaging/src/adapters/http.ts` | Dynamische Webhook-Registrierung |
| `packages/storage/src/repositories/workflow-repository.ts` | Trigger-Felder in DB |
| `packages/storage/src/migrations/` | Migration: trigger + monitoring Spalten auf workflows Tabelle |

### Kein neues DB-Schema fuer Automationen

Workflows-Tabelle bekommt 2 neue JSON-Spalten: `trigger` und `monitoring`. Alles andere nutzt bestehende Tabellen (scheduled_actions, watches, webhook_handlers).

---

## Verifikation

### Phase 1
- ReflectionEngine laeuft taeglich, Logs zeigen Reflexions-Ergebnisse
- Watch die 14 Tage nicht triggert wird automatisch angepasst (Intervall/Schwellwert)
- Watch die 30 Tage nicht triggert wird geloescht + User informiert
- Reminder zu erledigtem Thema wird automatisch geloescht
- Wiederholte Frage im Chat -> Alfred schlaegt Automation vor

### Phase 2
- User erstellt Automation per Prompt ("Wenn Strompreis < 15ct...")
- Workflow mit cron-Trigger laeuft periodisch
- Script-Node fuehrt Python-Script aus, Ergebnis fliesst in naechsten Step
- Webhook-Trigger empfaengt externen Call, startet Workflow
- Self-Healing deaktiviert Automation nach 3 Fehlern
