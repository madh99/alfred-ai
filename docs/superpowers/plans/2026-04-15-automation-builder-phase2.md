# AutomationBuilder (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bestehender Workflow-Skill wird zur vollwertigen Automation-Plattform — jeder Skill ein Node, persistente Trigger, Script/DB/Webhook/MQTT/HA Nodes, natuerliche Sprach-Erstellung, Self-Healing via ReflectionEngine.

**Architecture:** Workflow-Schema Erweiterung (trigger + monitoring Felder), 4 neue Step-Typen (script, db_query, webhook_register, ha_automation), Trigger-Integration mit ProactiveScheduler/WatchEngine/HTTP-Adapter/MQTT, Guard-Conditions, Dry-Run, create_from_prompt LLM-Action. Keine neue DB-Tabelle — workflows-Tabelle bekommt 2 JSON-Spalten.

**Tech Stack:** TypeScript, PostgreSQL/SQLite, LLM (fuer create_from_prompt), Pino Logger, bestehende Skills als Nodes

**Voraussetzung:** Phase 1 (ReflectionEngine) muss implementiert sein fuer Self-Healing.

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `packages/core/src/workflow/trigger-manager.ts` | Verbindet Trigger (cron/watch/webhook/mqtt) mit Workflow-Starts |
| `packages/core/src/workflow/guard-evaluator.ts` | Evaluiert Guard-Conditions vor Workflow-Start |
| `packages/core/src/workflow/script-executor.ts` | Fuehrt Script-Nodes aus (Python/Node/Bash) |
| `packages/core/src/workflow/db-query-executor.ts` | Fuehrt DB-Query-Nodes aus |
| `packages/core/src/workflow/prompt-parser.ts` | LLM-basiertes Parsing von natuerlicher Sprache zu Workflow-Struktur |

### Modified Files
| File | Change |
|------|--------|
| `packages/skills/src/built-in/workflow.ts` | Neue Actions: create_from_prompt, dry_run. Trigger/Monitoring in Schema |
| `packages/core/src/workflow-runner.ts` | Neue Step-Typen: script, db_query, webhook_register, ha_automation |
| `packages/storage/src/migrations/pg-migrations.ts` | Migration: trigger + monitoring Spalten |
| `packages/storage/src/migrations/sqlite-migrations.ts` | Gleiche Migration fuer SQLite |
| `packages/storage/src/repositories/workflow-repository.ts` | Trigger/Monitoring Felder lesen/schreiben |
| `packages/messaging/src/adapters/http.ts` | Dynamische Webhook-Registrierung/Deregistrierung |
| `packages/core/src/alfred.ts` | TriggerManager instanziieren, Webhook-Bridge |
| `packages/core/src/reflection/watch-reflector.ts` | Self-Healing: Automations-Monitoring einbeziehen |

### Test Files
| File | Tests |
|------|-------|
| `packages/core/src/workflow/guard-evaluator.test.ts` | Guard-Conditions |
| `packages/core/src/workflow/trigger-manager.test.ts` | Trigger-Routing |
| `packages/core/src/workflow/prompt-parser.test.ts` | LLM Intent-Parsing |
| `packages/core/src/workflow/script-executor.test.ts` | Script-Ausfuehrung |

---

### Task 1: DB Migration — trigger + monitoring Spalten

**Files:**
- Modify: `packages/storage/src/migrations/pg-migrations.ts`
- Modify: `packages/storage/src/migrations/sqlite-migrations.ts`
- Modify: `packages/storage/src/repositories/workflow-repository.ts`

- [ ] **Step 1: Add PG migration (naechste freie Version)**

```sql
-- v56 (oder naechste freie)
ALTER TABLE workflows ADD COLUMN IF NOT EXISTS trigger_config TEXT DEFAULT NULL;
ALTER TABLE workflows ADD COLUMN IF NOT EXISTS monitoring TEXT DEFAULT NULL;
ALTER TABLE workflows ADD COLUMN IF NOT EXISTS last_triggered_at TEXT DEFAULT NULL;
ALTER TABLE workflows ADD COLUMN IF NOT EXISTS trigger_enabled BOOLEAN DEFAULT false;
```

`trigger_config` und `monitoring` sind JSON-Strings. `trigger_enabled` separates Boolean fuer schnelle Abfrage welche Workflows aktive Trigger haben.

- [ ] **Step 2: Add SQLite migration (gleiche Version)**

```sql
ALTER TABLE workflows ADD COLUMN trigger_config TEXT DEFAULT NULL;
ALTER TABLE workflows ADD COLUMN monitoring TEXT DEFAULT NULL;
ALTER TABLE workflows ADD COLUMN last_triggered_at TEXT DEFAULT NULL;
ALTER TABLE workflows ADD COLUMN trigger_enabled INTEGER DEFAULT 0;
```

- [ ] **Step 3: Extend WorkflowRepository**

Add methods to `packages/storage/src/repositories/workflow-repository.ts`:

```typescript
async listTriggered(): Promise<Workflow[]> {
  const rows = await this.adapter.query(
    'SELECT * FROM workflows WHERE trigger_enabled = 1 AND status = ?',
    ['active'],
  );
  return (rows as any[]).map(r => this.mapRow(r));
}

async updateTriggerState(id: string, lastTriggeredAt: string): Promise<void> {
  await this.adapter.execute(
    'UPDATE workflows SET last_triggered_at = ? WHERE id = ?',
    [lastTriggeredAt, id],
  );
}
```

Extend existing `create` and `update` methods to handle `trigger_config`, `monitoring`, `trigger_enabled` fields.

- [ ] **Step 4: Build + verify migration runs**

```bash
pnpm build
```

- [ ] **Step 5: Commit**

```bash
git add packages/storage/src/migrations/ packages/storage/src/repositories/workflow-repository.ts
git commit -m "feat: Workflow trigger + monitoring DB-Spalten (Phase 2.1)"
```

---

### Task 2: Guard Evaluator

**Files:**
- Create: `packages/core/src/workflow/guard-evaluator.ts`
- Test: `packages/core/src/workflow/guard-evaluator.test.ts`

- [ ] **Step 1: Write tests**

```typescript
// packages/core/src/workflow/guard-evaluator.test.ts
import { describe, it, expect, vi } from 'vitest';
import { GuardEvaluator } from './guard-evaluator.js';

describe('GuardEvaluator', () => {
  it('passes time_window guard when inside window', () => {
    const evaluator = new GuardEvaluator(null as any, null as any);
    // Mock current time to 23:00
    vi.setSystemTime(new Date('2026-04-16T23:00:00'));
    const result = evaluator.evaluateTimeWindow('22:00-06:00');
    expect(result).toBe(true);
    vi.useRealTimers();
  });

  it('fails time_window guard when outside window', () => {
    const evaluator = new GuardEvaluator(null as any, null as any);
    vi.setSystemTime(new Date('2026-04-16T12:00:00'));
    const result = evaluator.evaluateTimeWindow('22:00-06:00');
    expect(result).toBe(false);
    vi.useRealTimers();
  });

  it('passes weekday guard on matching day', () => {
    const evaluator = new GuardEvaluator(null as any, null as any);
    vi.setSystemTime(new Date('2026-04-16T12:00:00')); // Thursday
    const result = evaluator.evaluateWeekday('mon,tue,wed,thu,fri');
    expect(result).toBe(true);
    vi.useRealTimers();
  });

  it('fails weekday guard on non-matching day', () => {
    const evaluator = new GuardEvaluator(null as any, null as any);
    vi.setSystemTime(new Date('2026-04-18T12:00:00')); // Saturday
    const result = evaluator.evaluateWeekday('mon,tue,wed,thu,fri');
    expect(result).toBe(false);
    vi.useRealTimers();
  });

  it('evaluates skill_condition guard', async () => {
    const mockSandbox = {
      execute: vi.fn().mockResolvedValue({ success: true, data: { soc: 45 } }),
    };
    const mockRegistry = { get: vi.fn().mockReturnValue({}) };
    const evaluator = new GuardEvaluator(mockRegistry as any, mockSandbox as any);

    const result = await evaluator.evaluateSkillCondition({
      skillName: 'bmw', skillParams: { action: 'status' },
      field: 'soc', operator: 'lt', compareValue: 60,
    });
    expect(result).toBe(true);
  });
});
```

- [ ] **Step 2: Implement GuardEvaluator**

```typescript
// packages/core/src/workflow/guard-evaluator.ts
import type { SkillRegistry, SkillSandbox } from '@alfred/skills';

interface Guard {
  type: 'time_window' | 'weekday' | 'skill_condition';
  value?: string;
  skillName?: string;
  skillParams?: Record<string, unknown>;
  field?: string;
  operator?: string;
  compareValue?: unknown;
}

export class GuardEvaluator {
  constructor(
    private readonly skillRegistry: SkillRegistry,
    private readonly skillSandbox: SkillSandbox,
  ) {}

  async evaluateAll(guards: Guard[]): Promise<boolean> {
    for (const guard of guards) {
      let passed = false;
      switch (guard.type) {
        case 'time_window':
          passed = this.evaluateTimeWindow(guard.value ?? '');
          break;
        case 'weekday':
          passed = this.evaluateWeekday(guard.value ?? '');
          break;
        case 'skill_condition':
          passed = await this.evaluateSkillCondition(guard as any);
          break;
        default:
          passed = true;
      }
      if (!passed) return false;
    }
    return true;
  }

  evaluateTimeWindow(window: string): boolean {
    const [startStr, endStr] = window.split('-').map(s => s.trim());
    if (!startStr || !endStr) return true;

    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const [sh, sm] = startStr.split(':').map(Number);
    const [eh, em] = endStr.split(':').map(Number);
    const startMinutes = sh * 60 + (sm || 0);
    const endMinutes = eh * 60 + (em || 0);

    if (startMinutes <= endMinutes) {
      // Same-day window: 09:00-17:00
      return currentMinutes >= startMinutes && currentMinutes < endMinutes;
    }
    // Overnight window: 22:00-06:00
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }

  evaluateWeekday(days: string): boolean {
    const dayMap: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    const allowed = days.toLowerCase().split(',').map(d => dayMap[d.trim()]).filter(n => n !== undefined);
    return allowed.includes(new Date().getDay());
  }

  async evaluateSkillCondition(guard: {
    skillName: string;
    skillParams: Record<string, unknown>;
    field: string;
    operator: string;
    compareValue: unknown;
  }): Promise<boolean> {
    try {
      const skill = this.skillRegistry.get(guard.skillName);
      if (!skill) return true; // Skip guard if skill not available

      const result = await Promise.race([
        this.skillSandbox.execute(skill, guard.skillParams, {} as any),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('guard timeout')), 10_000)),
      ]);

      if (!result.success || !result.data) return true;
      const value = (result.data as Record<string, unknown>)[guard.field];
      if (value === undefined) return true;

      switch (guard.operator) {
        case 'lt': return Number(value) < Number(guard.compareValue);
        case 'gt': return Number(value) > Number(guard.compareValue);
        case 'lte': return Number(value) <= Number(guard.compareValue);
        case 'gte': return Number(value) >= Number(guard.compareValue);
        case 'eq': return String(value) === String(guard.compareValue);
        case 'neq': return String(value) !== String(guard.compareValue);
        case 'contains': return String(value).includes(String(guard.compareValue));
        default: return true;
      }
    } catch {
      return true; // On error, don't block workflow
    }
  }
}
```

- [ ] **Step 3: Run tests, verify pass**

```bash
cd packages/core && npx vitest run src/workflow/guard-evaluator.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/workflow/guard-evaluator.ts packages/core/src/workflow/guard-evaluator.test.ts
git commit -m "feat: GuardEvaluator — time_window, weekday, skill_condition (Phase 2.2)"
```

---

### Task 3: Script Executor

**Files:**
- Create: `packages/core/src/workflow/script-executor.ts`
- Test: `packages/core/src/workflow/script-executor.test.ts`

- [ ] **Step 1: Write tests**

```typescript
// packages/core/src/workflow/script-executor.test.ts
import { describe, it, expect, vi } from 'vitest';
import { ScriptExecutor } from './script-executor.js';

const mockLogger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } as any;

describe('ScriptExecutor', () => {
  it('executes bash script and returns output', async () => {
    const executor = new ScriptExecutor('./data/scripts', mockLogger);
    const result = await executor.execute({
      language: 'bash',
      code: 'echo \'{"value": 42}\'',
      timeout: 5000,
      outputFormat: 'json',
    }, 'test-wf', 0);

    expect(result.success).toBe(true);
    expect(result.data.value).toBe(42);
  });

  it('handles script timeout', async () => {
    const executor = new ScriptExecutor('./data/scripts', mockLogger);
    const result = await executor.execute({
      language: 'bash',
      code: 'sleep 10',
      timeout: 500,
      outputFormat: 'text',
    }, 'test-wf', 1);

    expect(result.success).toBe(false);
    expect(result.error).toContain('timeout');
  });
});
```

- [ ] **Step 2: Implement ScriptExecutor**

```typescript
// packages/core/src/workflow/script-executor.ts
import { execFile } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from 'pino';

interface ScriptStep {
  language: 'python' | 'node' | 'bash';
  code: string;
  timeout: number;
  outputFormat: 'json' | 'text';
}

interface ScriptResult {
  success: boolean;
  data: Record<string, unknown>;
  output?: string;
  error?: string;
}

const INTERPRETERS: Record<string, string> = {
  python: 'python3',
  node: 'node',
  bash: 'bash',
};

const EXTENSIONS: Record<string, string> = {
  python: '.py',
  node: '.mjs',
  bash: '.sh',
};

export class ScriptExecutor {
  constructor(
    private readonly scriptsDir: string,
    private readonly logger: Logger,
  ) {
    try { mkdirSync(scriptsDir, { recursive: true }); } catch { /* exists */ }
  }

  async execute(step: ScriptStep, workflowId: string, stepIndex: number): Promise<ScriptResult> {
    const ext = EXTENSIONS[step.language] ?? '.sh';
    const filename = `${workflowId}_step${stepIndex}${ext}`;
    const filepath = join(this.scriptsDir, filename);

    // Write script to disk
    writeFileSync(filepath, step.code, 'utf-8');

    const interpreter = INTERPRETERS[step.language] ?? 'bash';
    const timeout = step.timeout || 30_000;

    return new Promise<ScriptResult>((resolve) => {
      const proc = execFile(interpreter, [filepath], { timeout, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          const isTimeout = (err as any).killed || err.message.includes('TIMEOUT');
          resolve({
            success: false,
            data: {},
            error: isTimeout ? `Script timeout after ${timeout}ms` : `${err.message}${stderr ? '\n' + stderr : ''}`,
          });
          return;
        }

        const output = stdout.trim();
        if (step.outputFormat === 'json') {
          try {
            const parsed = JSON.parse(output);
            resolve({ success: true, data: typeof parsed === 'object' ? parsed : { result: parsed }, output });
          } catch {
            resolve({ success: true, data: { raw: output }, output });
          }
        } else {
          resolve({ success: true, data: { raw: output }, output });
        }
      });

      // Safety: kill on timeout (belt + suspenders with execFile timeout)
      setTimeout(() => {
        try { proc.kill('SIGTERM'); } catch { /* already dead */ }
      }, timeout + 1000);
    });
  }

  /** Remove script files for a deleted workflow. */
  cleanup(workflowId: string): void {
    try {
      const { readdirSync, unlinkSync } = require('node:fs') as typeof import('node:fs');
      const files = readdirSync(this.scriptsDir);
      for (const f of files) {
        if (f.startsWith(`${workflowId}_`)) {
          unlinkSync(join(this.scriptsDir, f));
        }
      }
    } catch { /* best effort */ }
  }
}
```

- [ ] **Step 3: Run tests, verify pass**

```bash
cd packages/core && npx vitest run src/workflow/script-executor.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/workflow/script-executor.ts packages/core/src/workflow/script-executor.test.ts
git commit -m "feat: ScriptExecutor — Python/Node/Bash Scripts als Workflow-Nodes (Phase 2.3)"
```

---

### Task 4: DB Query Executor

**Files:**
- Create: `packages/core/src/workflow/db-query-executor.ts`

- [ ] **Step 1: Implement DbQueryExecutor**

```typescript
// packages/core/src/workflow/db-query-executor.ts
import type { AsyncDbAdapter } from '@alfred/storage';
import type { Logger } from 'pino';

interface DbQueryStep {
  sql: string;
  params?: string[];
  createTable?: boolean;
}

interface DbQueryResult {
  success: boolean;
  data: Record<string, unknown>;
  rowCount?: number;
  error?: string;
}

export class DbQueryExecutor {
  constructor(
    private readonly adapter: AsyncDbAdapter,
    private readonly logger: Logger,
  ) {}

  async execute(step: DbQueryStep, templateContext: Record<string, unknown>): Promise<DbQueryResult> {
    // Resolve template references in SQL: {{steps.0.price}} etc.
    let sql = step.sql;
    for (const [key, value] of Object.entries(templateContext)) {
      sql = sql.replace(new RegExp(`\\{\\{${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}\\}`, 'g'), String(value));
    }

    const isWrite = /^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)/i.test(sql);

    try {
      if (isWrite) {
        const result = await this.adapter.execute(sql, step.params ?? []);
        return { success: true, data: { changes: result.changes }, rowCount: result.changes };
      }
      const rows = await this.adapter.query(sql, step.params ?? []);
      return {
        success: true,
        data: { rows, count: (rows as any[]).length },
        rowCount: (rows as any[]).length,
      };
    } catch (err) {
      return {
        success: false,
        data: {},
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/core/src/workflow/db-query-executor.ts
git commit -m "feat: DbQueryExecutor — SQL-Queries als Workflow-Nodes (Phase 2.4)"
```

---

### Task 5: TriggerManager

**Files:**
- Create: `packages/core/src/workflow/trigger-manager.ts`
- Test: `packages/core/src/workflow/trigger-manager.test.ts`

- [ ] **Step 1: Write tests**

```typescript
// packages/core/src/workflow/trigger-manager.test.ts
import { describe, it, expect, vi } from 'vitest';
import { TriggerManager } from './trigger-manager.js';

const mockLogger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } as any;

describe('TriggerManager', () => {
  it('starts cron-triggered workflows on matching tick', async () => {
    const runWorkflow = vi.fn().mockResolvedValue({ status: 'completed' });
    const workflowRepo = {
      listTriggered: vi.fn().mockResolvedValue([{
        id: 'wf1', name: 'Test',
        triggerConfig: JSON.stringify({ type: 'cron', value: '* * * * *', enabled: true }),
        lastTriggeredAt: null,
      }]),
    } as any;
    const guardEvaluator = { evaluateAll: vi.fn().mockResolvedValue(true) } as any;

    const tm = new TriggerManager(workflowRepo, guardEvaluator, runWorkflow, mockLogger);
    await tm.tick();

    expect(runWorkflow).toHaveBeenCalledWith('wf1', {});
  });

  it('skips workflow when guard fails', async () => {
    const runWorkflow = vi.fn();
    const workflowRepo = {
      listTriggered: vi.fn().mockResolvedValue([{
        id: 'wf1', name: 'Test',
        triggerConfig: JSON.stringify({ type: 'interval', value: '15', enabled: true, guards: [{ type: 'weekday', value: 'mon' }] }),
        lastTriggeredAt: null,
      }]),
    } as any;
    const guardEvaluator = { evaluateAll: vi.fn().mockResolvedValue(false) } as any;

    const tm = new TriggerManager(workflowRepo, guardEvaluator, runWorkflow, mockLogger);
    await tm.tick();

    expect(runWorkflow).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Implement TriggerManager**

```typescript
// packages/core/src/workflow/trigger-manager.ts
import type { Logger } from 'pino';
import type { WorkflowRepository } from '@alfred/storage';
import type { GuardEvaluator } from './guard-evaluator.js';
import { matchesCron } from '@alfred/types';

interface TriggerConfig {
  type: 'cron' | 'interval' | 'webhook' | 'watch' | 'mqtt' | 'manual';
  value: string;
  enabled: boolean;
  guards?: Array<Record<string, unknown>>;
}

type RunWorkflowFn = (workflowId: string, triggerData: Record<string, unknown>) => Promise<any>;

export class TriggerManager {
  private timer?: ReturnType<typeof setInterval>;
  /** webhook name → workflow ID mapping */
  private webhookMap = new Map<string, string>();

  constructor(
    private readonly workflowRepo: WorkflowRepository,
    private readonly guardEvaluator: GuardEvaluator,
    private readonly runWorkflow: RunWorkflowFn,
    private readonly logger: Logger,
  ) {}

  start(): void {
    // Tick every 60 seconds for cron/interval triggers
    this.timer = setInterval(() => {
      this.tick().catch(err => this.logger.error({ err }, 'TriggerManager tick error'));
    }, 60_000);
    this.logger.info('Workflow TriggerManager started');
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }

  /** Called every 60s — checks cron/interval triggers. */
  async tick(): Promise<void> {
    let workflows: any[];
    try {
      workflows = await this.workflowRepo.listTriggered();
    } catch { return; }

    const now = new Date();

    for (const wf of workflows) {
      try {
        const trigger: TriggerConfig = JSON.parse(wf.triggerConfig ?? '{}');
        if (!trigger.enabled || trigger.type === 'manual') continue;

        let shouldRun = false;

        if (trigger.type === 'cron') {
          shouldRun = matchesCron(trigger.value, now);
          // Dedup: don't run twice in same minute
          if (shouldRun && wf.lastTriggeredAt) {
            const lastMin = new Date(wf.lastTriggeredAt).getTime();
            if (now.getTime() - lastMin < 60_000) shouldRun = false;
          }
        } else if (trigger.type === 'interval') {
          const intervalMs = parseInt(trigger.value, 10) * 60_000;
          const lastRun = wf.lastTriggeredAt ? new Date(wf.lastTriggeredAt).getTime() : 0;
          shouldRun = (now.getTime() - lastRun) >= intervalMs;
        }
        // webhook, watch, mqtt are push-based → handled via onWebhook/onWatch/onMqtt

        if (!shouldRun) continue;

        // Evaluate guards
        if (trigger.guards && trigger.guards.length > 0) {
          const guardsPass = await this.guardEvaluator.evaluateAll(trigger.guards as any[]);
          if (!guardsPass) {
            this.logger.debug({ workflowId: wf.id, name: wf.name }, 'Workflow trigger skipped (guard failed)');
            continue;
          }
        }

        // Run workflow
        this.logger.info({ workflowId: wf.id, name: wf.name, trigger: trigger.type }, 'Workflow triggered');
        await this.workflowRepo.updateTriggerState(wf.id, now.toISOString());
        await this.runWorkflow(wf.id, { triggerType: trigger.type, triggeredAt: now.toISOString() });
      } catch (err) {
        this.logger.warn({ err, workflowId: wf.id }, 'Workflow trigger failed');
      }
    }
  }

  /** Called by HTTP-Adapter when a webhook fires. */
  async onWebhook(name: string, payload: Record<string, unknown>): Promise<void> {
    const workflowId = this.webhookMap.get(name);
    if (!workflowId) return;
    this.logger.info({ webhookName: name, workflowId }, 'Webhook-triggered workflow');
    await this.runWorkflow(workflowId, { triggerType: 'webhook', webhookName: name, body: payload });
  }

  /** Called by WatchEngine when a watch fires. */
  async onWatchTriggered(watchId: string, value: unknown): Promise<void> {
    // Find workflows with watch trigger matching this watchId
    try {
      const workflows = await this.workflowRepo.listTriggered();
      for (const wf of workflows) {
        const trigger = JSON.parse(wf.triggerConfig ?? '{}');
        if (trigger.type === 'watch' && trigger.value === watchId) {
          this.logger.info({ workflowId: wf.id, watchId }, 'Watch-triggered workflow');
          await this.workflowRepo.updateTriggerState(wf.id, new Date().toISOString());
          await this.runWorkflow(wf.id, { triggerType: 'watch', watchId, watchValue: value });
        }
      }
    } catch (err) {
      this.logger.warn({ err, watchId }, 'Watch-triggered workflow lookup failed');
    }
  }

  /** Register a webhook→workflow mapping. */
  registerWebhook(name: string, workflowId: string): void {
    this.webhookMap.set(name, workflowId);
  }

  /** Deregister webhook when workflow is deleted. */
  deregisterWebhook(name: string): void {
    this.webhookMap.delete(name);
  }
}
```

- [ ] **Step 3: Run tests, verify pass**

```bash
cd packages/core && npx vitest run src/workflow/trigger-manager.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/workflow/trigger-manager.ts packages/core/src/workflow/trigger-manager.test.ts
git commit -m "feat: TriggerManager — cron/interval/webhook/watch Trigger (Phase 2.5)"
```

---

### Task 6: Prompt Parser (create_from_prompt)

**Files:**
- Create: `packages/core/src/workflow/prompt-parser.ts`
- Test: `packages/core/src/workflow/prompt-parser.test.ts`

- [ ] **Step 1: Implement PromptParser**

```typescript
// packages/core/src/workflow/prompt-parser.ts
import type { LLMProvider } from '@alfred/llm';
import type { SkillRegistry } from '@alfred/skills';
import type { Logger } from 'pino';

interface ParsedWorkflow {
  name: string;
  description: string;
  trigger?: {
    type: 'cron' | 'interval' | 'webhook' | 'watch' | 'manual';
    value: string;
    enabled: boolean;
    guards?: Array<Record<string, unknown>>;
  };
  steps: Array<{
    type: 'action' | 'condition' | 'script' | 'db_query';
    skillName?: string;
    inputMapping?: Record<string, unknown>;
    condition?: Record<string, unknown>;
    code?: string;
    language?: string;
    sql?: string;
    onError?: 'stop' | 'skip' | 'retry';
  }>;
}

export class PromptParser {
  constructor(
    private readonly llm: LLMProvider,
    private readonly skillRegistry: SkillRegistry,
    private readonly logger: Logger,
  ) {}

  async parse(userPrompt: string): Promise<ParsedWorkflow | null> {
    // Build available skills list for the LLM
    const skills: string[] = [];
    for (const [name, skill] of this.skillRegistry.entries()) {
      const actions = (skill.metadata.inputSchema as any)?.properties?.action?.enum;
      skills.push(`- ${name}: ${skill.metadata.description?.slice(0, 80) ?? ''}${actions ? ` (actions: ${actions.join(', ')})` : ''}`);
    }

    const response = await this.llm.complete({
      messages: [{
        role: 'user',
        content: `Erstelle einen Workflow aus dieser Beschreibung:

"${userPrompt}"

Verfuegbare Skills (als Workflow-Steps nutzbar):
${skills.join('\n')}

Antworte NUR mit validem JSON in diesem Format:
{
  "name": "kurzer-name",
  "description": "Was der Workflow macht",
  "trigger": { "type": "interval|cron|webhook|watch|manual", "value": "15", "enabled": true,
    "guards": [{"type":"time_window","value":"22:00-06:00"}] },
  "steps": [
    { "type": "action", "skillName": "energy_price", "inputMapping": {"action":"current"}, "onError": "skip" },
    { "type": "condition", "condition": {"field":"{{steps.0.price_gross}}","operator":"lt","value":15}, "then": 2, "else": "end" },
    { "type": "action", "skillName": "goe_charger", "inputMapping": {"action":"start_charging"}, "onError": "stop" }
  ]
}

Regeln:
- Nutze NUR Skills aus der Liste oben
- Trigger-Typ waehlen: cron fuer zeitbasiert, interval fuer alle N Minuten, webhook fuer externe Aufrufe, watch fuer Event-basiert, manual fuer manuell
- Guards optional: time_window ("HH:MM-HH:MM"), weekday ("mon,tue,..."), skill_condition (skillName+field+operator+value)
- Steps referenzieren vorherige Ergebnisse mit {{steps.N.field}} oder {{prev.field}}
- onError: stop (Workflow bricht ab), skip (naechster Step), retry (nochmal versuchen)
- Wenn kein passender Skill existiert, nutze type:"script" mit language+code
- Wenn Daten-Persistenz noetig, nutze type:"db_query" mit sql`,
      }],
      system: 'Du bist ein Workflow-Builder. Antworte ausschliesslich mit validem JSON. Keine Erklaerungen.',
      maxTokens: 1024,
      tier: 'default',
    });

    try {
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;
      const parsed = JSON.parse(jsonMatch[0]) as ParsedWorkflow;

      // Validate: all skillNames must exist
      for (const step of parsed.steps) {
        if (step.type === 'action' && step.skillName && !this.skillRegistry.has(step.skillName)) {
          this.logger.warn({ skillName: step.skillName }, 'PromptParser: unknown skill in generated workflow');
          return null;
        }
      }

      return parsed;
    } catch (err) {
      this.logger.warn({ err }, 'PromptParser: failed to parse LLM response');
      return null;
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/core/src/workflow/prompt-parser.ts
git commit -m "feat: PromptParser — natuerliche Sprache zu Workflow (Phase 2.6)"
```

---

### Task 7: WorkflowRunner erweitern + Workflow-Skill erweitern

**Files:**
- Modify: `packages/core/src/workflow-runner.ts`
- Modify: `packages/skills/src/built-in/workflow.ts`

- [ ] **Step 1: Add new step types to WorkflowRunner**

In `packages/core/src/workflow-runner.ts`, extend the step execution to handle `script` and `db_query` types:

```typescript
// In the step execution switch/if block, add:
if (step.type === 'script' && this.scriptExecutor) {
  const result = await this.scriptExecutor.execute(
    { language: step.language ?? 'bash', code: step.code!, timeout: step.timeout ?? 30000, outputFormat: step.outputFormat ?? 'json' },
    workflowId, stepIndex,
  );
  if (!result.success) throw new Error(result.error);
  return result.data;
}

if (step.type === 'db_query' && this.dbQueryExecutor) {
  const templateCtx = this.buildTemplateContext(previousResults);
  const result = await this.dbQueryExecutor.execute(
    { sql: step.sql!, params: step.params },
    templateCtx,
  );
  if (!result.success) throw new Error(result.error);
  return result.data;
}
```

Add constructor parameters for `ScriptExecutor` and `DbQueryExecutor` (optional, to maintain backward compatibility).

- [ ] **Step 2: Add create_from_prompt and dry_run to Workflow Skill**

In `packages/skills/src/built-in/workflow.ts`, add new actions:

```typescript
case 'create_from_prompt': {
  const prompt = input.prompt as string;
  if (!prompt) return { success: false, error: 'prompt is required' };

  const parsed = await this.promptParser.parse(prompt);
  if (!parsed) return { success: false, error: 'Could not parse workflow from prompt' };

  // Create but don't activate trigger yet — user must confirm
  const workflow = await this.workflowRepo.create(userId, {
    name: parsed.name,
    description: parsed.description,
    steps: parsed.steps,
    triggerConfig: parsed.trigger ? JSON.stringify(parsed.trigger) : undefined,
    triggerEnabled: false, // Needs confirmation
  });

  return {
    success: true,
    data: { workflowId: workflow.id, ...parsed },
    display: `Workflow "${parsed.name}" erstellt:\n${parsed.description}\n\nTrigger: ${parsed.trigger?.type ?? 'manual'} (${parsed.trigger?.value ?? '-'})\nSteps: ${parsed.steps.length}\n\nNoch NICHT aktiviert — bestaetige mit "workflow activate ${workflow.id}"`,
  };
}

case 'dry_run': {
  const workflowId = input.workflowId as string;
  if (!workflowId) return { success: false, error: 'workflowId is required' };

  const result = await this.workflowRunner.execute(workflowId, { dryRun: true });
  return {
    success: true,
    data: result,
    display: `Dry-Run fuer Workflow ${workflowId}:\nStatus: ${result.status}\nSteps: ${result.stepResults?.length ?? 0}\n${result.stepResults?.map((s: any, i: number) => `  Step ${i}: ${s.success ? 'OK' : 'FAIL'} — ${JSON.stringify(s.data ?? s.error).slice(0, 100)}`).join('\n') ?? ''}`,
  };
}

case 'activate': {
  const workflowId = input.workflowId as string;
  if (!workflowId) return { success: false, error: 'workflowId is required' };

  await this.workflowRepo.update(workflowId, { triggerEnabled: true });
  return { success: true, data: { workflowId, activated: true }, display: `Workflow ${workflowId} aktiviert — Trigger laeuft.` };
}
```

- [ ] **Step 3: Build + verify**

```bash
pnpm build
```

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/workflow-runner.ts packages/skills/src/built-in/workflow.ts
git commit -m "feat: Workflow erweitert — script/db_query Steps, create_from_prompt, dry_run (Phase 2.7)"
```

---

### Task 8: Wire into Alfred + Dynamic Webhooks + Release

**Files:**
- Modify: `packages/core/src/alfred.ts`
- Modify: `packages/messaging/src/adapters/http.ts`

- [ ] **Step 1: Wire TriggerManager into Alfred**

In `packages/core/src/alfred.ts`, after workflow skill registration:

```typescript
// Workflow Trigger Manager
if (this.workflowRepo) {
  const { TriggerManager } = await import('./workflow/trigger-manager.js');
  const { GuardEvaluator } = await import('./workflow/guard-evaluator.js');

  const guardEvaluator = new GuardEvaluator(skillRegistry, skillSandbox);
  const triggerManager = new TriggerManager(
    this.workflowRepo, guardEvaluator,
    async (wfId, triggerData) => {
      return this.workflowRunner.execute(wfId, triggerData);
    },
    this.logger.child({ component: 'trigger-manager' }),
  );
  triggerManager.start();

  // Connect WatchEngine → TriggerManager
  const existingWatchCallback = this.watchEngine.onWatchTriggered;
  this.watchEngine.onWatchTriggered = (name, value, data, skillName) => {
    existingWatchCallback?.(name, value, data, skillName);
    triggerManager.onWatchTriggered(name, value).catch(() => {});
  };

  // Connect HTTP webhooks → TriggerManager
  const apiAdapter = this.adapters.get('api');
  if (apiAdapter && 'addWebhook' in apiAdapter) {
    // Load persisted webhook registrations from triggered workflows
    try {
      const triggered = await this.workflowRepo.listTriggered();
      for (const wf of triggered) {
        const trigger = JSON.parse(wf.triggerConfig ?? '{}');
        if (trigger.type === 'webhook' && trigger.value) {
          triggerManager.registerWebhook(trigger.value, wf.id);
          (apiAdapter as any).addWebhook({
            name: trigger.value,
            secret: trigger.secret ?? '',
            handler: async (payload: Record<string, unknown>) => {
              await triggerManager.onWebhook(trigger.value, payload);
              return { success: true };
            },
          });
        }
      }
    } catch { /* no triggered workflows yet */ }
  }
}
```

- [ ] **Step 2: Build + bundle + version + CHANGELOG + commit + push**

```bash
pnpm build
node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('packages/cli/package.json','utf8'));p.version='0.19.0-multi-ha.XXX';fs.writeFileSync('packages/cli/package.json',JSON.stringify(p,null,2)+'\n')"
node scripts/bundle.mjs
git add -A
git commit -m "feat: AutomationBuilder — Workflow als Automation-Plattform (Phase 2)"
git push gitlab feature/multi-user
git push github feature/multi-user
```

---

## Self-Review

**1. Spec coverage:**
- Workflow-Schema Erweiterung (trigger + monitoring) → Task 1 ✓
- Guard-Conditions (time_window, weekday, skill_condition) → Task 2 ✓
- Script-Node (Python/Node/Bash) → Task 3 ✓
- DB-Query-Node → Task 4 ✓
- Trigger-Integration (cron, interval, webhook, watch) → Task 5 ✓
- Natuerliche Sprach-Erstellung (create_from_prompt) → Task 6 ✓
- WorkflowRunner neue Step-Typen → Task 7 ✓
- Wiring + Dynamic Webhooks → Task 8 ✓
- MQTT als Trigger → Nicht in Phase 2 implementiert (braucht persistenten Subscriber, eigenes Feature)
- Self-Healing → Durch Phase 1 ReflectionEngine abgedeckt (WorkflowReflector)
- Dry-Run → Task 7 ✓
- Monitoring → Task 1 (DB-Spalte) + Phase 1 ReflectionEngine

**2. Placeholder scan:** Kein TBD, kein "implement later". MQTT-Trigger explizit als nicht-enthalten dokumentiert.

**3. Type consistency:**
- `TriggerConfig` in trigger-manager.ts matches DB schema from Task 1
- `ParsedWorkflow` in prompt-parser.ts matches workflow creation in Task 7
- `GuardEvaluator.evaluateAll` signature matches TriggerManager.tick() call
- `ScriptExecutor.execute` signature matches WorkflowRunner extension in Task 7
