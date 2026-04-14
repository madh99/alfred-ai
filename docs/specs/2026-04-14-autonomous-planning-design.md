# Autonome Multi-Step-Planung — Design Spec

## Problem

Alfred **beobachtet** und **meldet** — aber er **plant** und **handelt** nicht autonom. Das Reasoning schlägt max 5 einzelne, unabhängige Actions pro Pass vor. Jede Action ist atomar: ein Skill-Call, eine Bestätigung, eine Ausführung. Es gibt kein Konzept von "Ziel → Plan → schrittweise Ausführung mit Anpassung".

### Was heute passiert

User hat Freitag ein Gutachten in Weinburg. Alfred sieht:
- Kalender: Fr 09:00 Gutachten
- BMW: 43% SoC, 198km Reichweite
- Routing: Altlengbach → Weinburg = ~60km
- Kalender: Do 15:05 Linus Training, Do 15:45 Noah abholen Kapfenberg

Alfred meldet: "Du hast am Freitag einen Termin. Donnerstag gibt es einen Konflikt zwischen Linus Training und Noah abholen."

### Was passieren sollte

Alfred erkennt das **Szenario** und erstellt einen **Plan**:

```
Ziel: "Noah-Gutachten Freitag Weinburg vorbereiten"

Schritt 1: Route Do Altlengbach → Kapfenberg berechnen (AUTO)
Schritt 2: Route Fr Altlengbach → Weinburg berechnen (AUTO)
Schritt 3: BMW SoC prüfen — reicht Reichweite für beide Fahrten? (AUTO)
Schritt 4: Wenn SoC < 70% → Ladefenster heute Nacht vorschlagen (CHECKPOINT)
Schritt 5: Wetter Fr prüfen → bei Regen 15min Puffer (AUTO)
Schritt 6: Kalender-Konflikt Do auflösen — Vorschlag an User (CHECKPOINT)
Schritt 7: Reminder Do 15:00 "Noah abholen" erstellen (PROACTIVE)
Schritt 8: Reminder Fr 07:30 "Abfahrt Weinburg" erstellen (PROACTIVE)
```

Der User sieht den Plan, bestätigt ihn (oder ändert einzelne Schritte), und Alfred führt alles aus.

---

## Architektur

### Bestehende Primitive

| Komponente | Kann | Kann nicht |
|-----------|------|-----------|
| **ReasoningEngine** | Kontext aus 20+ Quellen, LLM-Analyse, 5 Actions pro Pass | Keine Pläne, keine Schritt-Verkettung |
| **WorkflowRunner** | Statische Step-Chains, Conditions, Templates | Kein LLM im Loop, keine dynamische Anpassung |
| **DelegateSkill** | LLM-in-Loop, 25 Iterationen, Tool-Calls | Ephemeral (Single-Session), kein Persist, kein Checkpoint |
| **ConfirmationQueue** | Einzelne Action bestätigen/ablehnen | Kein Plan-Konzept, keine selektive Step-Bestätigung |

### Neuer Layer: PlanningAgent

Der PlanningAgent sitzt **zwischen** Reasoning und Execution:

```
ReasoningEngine
       ↓ erkennt Szenario
PlanningAgent
       ↓ erstellt Plan (LLM-generiert)
       ↓ persistiert Plan in DB
       ↓ zeigt Plan dem User
       ↓ User bestätigt/ändert
PlanExecutor
       ↓ führt Schritte aus
       ↓ LLM re-evaluiert nach jedem Schritt
       ↓ pausiert an Checkpoints für User-Input
       ↓ adaptiert verbleibende Schritte
       ↓ meldet Abschluss/Fehler
```

---

## Plan-Struktur

```typescript
interface Plan {
  id: string;
  userId: string;
  goal: string;                    // "Noah-Gutachten Freitag vorbereiten"
  status: 'draft' | 'pending_approval' | 'running' | 'paused_at_checkpoint' | 'completed' | 'failed' | 'cancelled';
  steps: PlanStep[];
  currentStepIndex: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  triggerSource: 'reasoning' | 'user' | 'event';
  context: Record<string, unknown>; // Accumulated results from completed steps
}

interface PlanStep {
  index: number;
  description: string;             // "Route berechnen Altlengbach → Kapfenberg"
  skillName: string;               // "routing"
  skillParams: Record<string, unknown>;
  riskLevel: 'auto' | 'checkpoint' | 'proactive';
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'waiting_approval';
  result?: Record<string, unknown>;
  error?: string;
  condition?: string;              // "if step[2].result.soc < 70"
  onFailure: 'stop' | 'skip' | 'retry' | 'replan';
  dependsOn?: number[];            // Step indices this step needs results from
}
```

---

## Szenario-Erkennung

### Wie erkennt das Reasoning ein Planungs-Szenario?

Die bestehende Reasoning-Engine erkennt bereits Cross-Domain-Verbindungen. Was fehlt: statt einzelne Actions vorzuschlagen, soll sie bei **komplexen Szenarien** einen Plan vorschlagen.

### Erweiterung des Reasoning-Prompts

Neuer Action-Typ in der Detail-Prompt-Instruktion:

```
AKTIONSTYP 9: PLAN ERSTELLEN
Wenn eine Situation MEHRERE zusammenhängende Schritte erfordert die aufeinander aufbauen,
erstelle einen Plan statt einzelner Actions.

Beispiele für Plan-Szenarien:
- Reise/Termin mit Vorbereitung (Route + Laden + Wetter + Reminder)
- Infrastruktur-Change (Backup → Deploy → Verify → DNS → Notify)
- Familien-Logistik (Kinder abholen + Termine koordinieren + Fahrten planen)
- Einkauf/Beschaffung (Preisvergleich → Entscheidung → Bestellung → Tracking)

Format:
{"type": "execute_plan", "description": "...", "goal": "...", "steps": [
  {"description": "...", "skillName": "...", "skillParams": {...}, "riskLevel": "auto|checkpoint|proactive", "onFailure": "stop|skip|replan"},
  ...
], "checkpoints": [3, 5]}

Regeln:
- Maximal 10 Schritte pro Plan
- AUTO-Schritte: Informationssammlung (routing, weather, bmw status) → laufen ohne Bestätigung
- CHECKPOINT-Schritte: Entscheidungen die User-Input brauchen → Plan pausiert, User entscheidet
- PROACTIVE-Schritte: Ausführungen die der User wahrscheinlich will (Reminder, Kalender) → laufen automatisch mit Notification
- Mindestens 1 Checkpoint pro Plan (kein vollautonomer Plan ohne User-Beteiligung)
- Schritte können Ergebnisse vorheriger Schritte referenzieren: {{step[0].result.distance_km}}
```

### Szenario-Trigger

Das Reasoning erkennt Plan-Szenarien wenn:
1. **Zeitlicher Druck** — Termin in den nächsten 48h mit Vorbereitungsbedarf
2. **Cross-Domain-Abhängigkeit** — ≥3 verschiedene Skills nötig für ein Ziel
3. **Logistik-Konflikt** — Überschneidende Termine mit räumlicher Distanz
4. **Mehrstufiger Prozess** — User äußert Ziel das mehrere Schritte braucht

---

## Plan-Execution

### PlanExecutor

```typescript
class PlanExecutor {
  async executePlan(plan: Plan): Promise<Plan> {
    plan.status = 'running';
    await this.planRepo.update(plan);

    while (plan.currentStepIndex < plan.steps.length) {
      const step = plan.steps[plan.currentStepIndex];

      // 1. Condition check
      if (step.condition) {
        const conditionMet = this.evaluateCondition(step.condition, plan.context);
        if (!conditionMet) {
          step.status = 'skipped';
          plan.currentStepIndex++;
          continue;
        }
      }

      // 2. Checkpoint → pause for user approval
      if (step.riskLevel === 'checkpoint') {
        step.status = 'waiting_approval';
        plan.status = 'paused_at_checkpoint';
        await this.planRepo.update(plan);
        await this.notifyUser(plan, step); // Shows step + context so far
        return plan; // Execution pauses here — resumed on user approval
      }

      // 3. Execute step
      step.status = 'running';
      try {
        const params = this.resolveTemplates(step.skillParams, plan.context);
        const result = await this.skillSandbox.execute(
          this.skillRegistry.get(step.skillName)!,
          params,
          this.buildContext(plan),
        );
        step.result = result.data as Record<string, unknown>;
        step.status = 'completed';
        plan.context[`step_${step.index}`] = step.result;

        // 4. LLM re-evaluation: should we continue as planned?
        if (plan.currentStepIndex < plan.steps.length - 1) {
          const shouldAdapt = await this.reevaluate(plan);
          if (shouldAdapt) {
            // LLM may modify remaining steps based on actual results
            await this.adaptPlan(plan);
          }
        }
      } catch (err) {
        step.status = 'failed';
        step.error = err.message;
        if (step.onFailure === 'stop') { plan.status = 'failed'; break; }
        if (step.onFailure === 'skip') { /* continue */ }
        if (step.onFailure === 'replan') { await this.adaptPlan(plan); }
      }

      // 5. Notify user on proactive steps
      if (step.riskLevel === 'proactive' && step.status === 'completed') {
        await this.notifyUser(plan, step, 'proaktiv ausgeführt');
      }

      plan.currentStepIndex++;
      await this.planRepo.update(plan);
    }

    if (plan.status === 'running') plan.status = 'completed';
    plan.completedAt = new Date().toISOString();
    await this.planRepo.update(plan);
    await this.notifyCompletion(plan);
    return plan;
  }
}
```

### LLM Re-Evaluation

Nach jedem Schritt (außer dem letzten) prüft das LLM ob der Plan noch Sinn ergibt:

```
Bisherige Ergebnisse:
- Schritt 1 (Route berechnen): 127km, 1h35min
- Schritt 2 (BMW Status): 43% SoC, 198km Reichweite

Verbleibende Schritte:
- Schritt 3: Ladefenster vorschlagen
- Schritt 4: Wetter prüfen
- Schritt 5: Reminder erstellen

Frage: Sind die verbleibenden Schritte noch sinnvoll angesichts der Ergebnisse?
Antwort als JSON: {"adapt": false} oder {"adapt": true, "reason": "...", "modifiedSteps": [...]}
```

Das ist der Kernunterschied zum statischen WorkflowRunner: der Plan passt sich an reale Ergebnisse an.

---

## User-Interaktion

### Plan-Präsentation

Wenn das Reasoning einen Plan vorschlägt, sieht der User:

```
📋 **Plan: Noah-Gutachten Freitag vorbereiten**

1. ✅ Route Do: Altlengbach → Kapfenberg berechnen
2. ✅ Route Fr: Altlengbach → Weinburg berechnen
3. ✅ BMW SoC prüfen
4. 🔲 ⚠️ Ladefenster vorschlagen (braucht deine Bestätigung)
5. ✅ Wetter Fr prüfen
6. 🔲 ⚠️ Kalender-Konflikt Do auflösen (braucht deine Bestätigung)
7. ✅ Reminder "Noah abholen" erstellen
8. ✅ Reminder "Abfahrt Weinburg" erstellen

✅ = läuft automatisch | ⚠️ = pausiert für deine Entscheidung

Soll ich den Plan starten?
```

### User-Befehle während Plan-Execution

- "ja" / "starten" → Plan startet
- "nein" / "abbrechen" → Plan wird cancelled
- "Schritt 4 ändern: lade auf 90% statt 80%" → Plan-Modifikation
- "Schritt 6 überspringen" → Step wird skipped
- "Plan stoppen" → Plan pausiert, kann später fortgesetzt werden
- "Plan Status" → zeigt aktuellen Stand

### Checkpoint-Interaktion

Wenn der Plan an einem Checkpoint pausiert:

```
📋 Plan "Noah-Gutachten" — Checkpoint Schritt 4

Bisherige Ergebnisse:
- Route Do: 127km, 1h35min
- Route Fr: 63km, 50min
- BMW: 43% SoC, 198km — reicht NICHT für beide Fahrten (190km gesamt)

**Vorschlag:** Ladefenster heute Nacht 01:00-03:00 aktivieren (Ziel: 80% SoC)

Bestätigst du? (ja / nein / ändern)
```

---

## Persistenz

### Migration (v55)

```sql
CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  steps JSONB NOT NULL,
  current_step_index INTEGER NOT NULL DEFAULT 0,
  context JSONB NOT NULL DEFAULT '{}',
  trigger_source TEXT NOT NULL DEFAULT 'reasoning',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX idx_plans_user_status ON plans(user_id, status);
```

### Reasoning-Kontext-Erweiterung

Neue Source in ReasoningContextCollector (Priority 1, 200 Tokens):

```
=== Aktive Pläne ===
- "Noah-Gutachten vorbereiten" (running, Schritt 4/8, pausiert: Checkpoint Ladefenster)
```

Das verhindert dass das Reasoning doppelte Pläne für dasselbe Ziel vorschlägt.

---

## Sicherheit

### Regeln

1. **Mindestens 1 Checkpoint pro Plan** — kein vollautonomer Plan ohne User-Beteiligung
2. **Maximal 10 Schritte** — verhindert ausufernde Pläne
3. **HIGH_RISK Skills erfordern immer Checkpoint** — Deploy, ITSM, BMW authorize etc.
4. **Plan-Timeout:** 24h — Pläne die nicht innerhalb von 24h abgeschlossen werden, werden automatisch cancelled
5. **Rollback-Info:** Jeder Plan kann optionale Rollback-Schritte haben die bei Abbruch/Fehler ausgeführt werden
6. **Kein Plan-in-Plan** — Pläne können keine weiteren Pläne erstellen (verhindert Endlosrekursion)
7. **Autonomy-Level wird respektiert** — im `confirm_all` Modus sind ALLE Schritte Checkpoints

### Feedback-Integration

`ActionFeedbackTracker` trackt:
- Plan-Completion-Rate (completed/total)
- Welche Schritte am häufigsten geändert/übersprungen werden → Reasoning lernt bessere Pläne zu erstellen
- Welche Szenarien erfolgreich waren → Reasoning erkennt ähnliche Szenarien in Zukunft

---

## Integration mit bestehenden Systemen

### ReasoningEngine

- Neuer Action-Typ `execute_plan` im Detail-Prompt
- `processActions()` erkennt `type === 'execute_plan'` und leitet an PlanningAgent
- Plan wird als Ganzes in die ConfirmationQueue gestellt (nicht einzelne Steps)

### ConfirmationQueue

- Erweitert um `type: 'plan'` neben `type: 'action'`
- Plan-Bestätigung startet den PlanExecutor
- Checkpoint-Bestätigungen werden als Plan-spezifische Messages erkannt

### WorkflowRunner

- Wird NICHT ersetzt — Workflows bleiben für statische, wiederkehrende Automatisierungen
- Pläne sind für dynamische, einmalige Multi-Step-Tasks
- Wenn ein Plan-Muster wiederholt auftritt, kann das Reasoning vorschlagen einen Workflow daraus zu machen

### DelegateSkill

- Wird NICHT ersetzt — Delegate bleibt für offene, explorative Tasks ("recherchiere X")
- Pläne sind für strukturierte Tasks mit klaren Schritten
- Ein Plan-Schritt kann einen `delegate` Call enthalten für offene Teilaufgaben

### KG

- Abgeschlossene Pläne werden als `event` Entity im KG gespeichert
- Plan-Ergebnisse fließen in Memories (z.B. "Route Altlengbach→Weinburg = 63km, 50min")

---

## Chat-Beispiele

| User sagt | Alfred tut |
|-----------|-----------|
| "Ich muss Freitag nach Weinburg" | Reasoning erkennt Szenario → erstellt Plan → zeigt Plan |
| "Plan starten" | PlanExecutor startet, AUTO-Steps laufen |
| "ja" (an Checkpoint) | Nächste Steps werden ausgeführt |
| "Ändere auf 90% laden" | Plan-Step wird modifiziert, Execution fährt fort |
| "Plan Status" | Zeigt aktuellen Stand aller Steps |
| "Plan abbrechen" | Plan wird cancelled |
| "Erstelle einen Plan für das Wochenende" | User-initiierter Plan → LLM erstellt Steps aus Kontext |

---

## Dateien

| Datei | Änderung |
|-------|----------|
| `packages/core/src/planning-agent.ts` | **NEU** — PlanningAgent + PlanExecutor |
| `packages/core/src/reasoning-engine.ts` | Neuer Action-Typ `execute_plan` im Prompt + processActions |
| `packages/core/src/reasoning-context-collector.ts` | Neue Source `plans` (Priority 1) |
| `packages/core/src/confirmation-queue.ts` | Plan-Bestätigung + Checkpoint-Handling |
| `packages/core/src/alfred.ts` | PlanningAgent Registrierung + Wiring |
| `packages/storage/src/repositories/plan-repository.ts` | **NEU** — CRUD für Plans |
| `packages/storage/src/migrations/` | v55: plans Tabelle |
| `packages/types/src/` | Plan + PlanStep Interfaces |

## Abhängigkeiten

- Keine neuen npm-Packages
- Bestehend: ReasoningEngine, ConfirmationQueue, SkillSandbox, SkillRegistry, LLMProvider
- DB: Migration v55 (PG + SQLite)

## Risiken

- **LLM-Halluzination bei Plan-Erstellung:** LLM könnte unrealistische Schritte vorschlagen. Mitigation: Skill-Validierung vor Plan-Start (alle skillNames müssen existieren, alle Actions valide)
- **Plan-Explosion:** LLM schlägt zu viele/komplexe Pläne vor. Mitigation: Max 1 aktiver Plan pro User, max 2 Pläne in der Queue
- **Checkpoint-Vergessen:** User bestätigt Checkpoint nicht und Plan hängt. Mitigation: 4h Checkpoint-Timeout, dann Reminder, nach 24h auto-cancel
- **Endlosschleife bei replan:** LLM adaptiert Plan endlos. Mitigation: Max 3 Re-Evaluations pro Plan
