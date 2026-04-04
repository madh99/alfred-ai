import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../skill.js';
import type { BrainstormingRepository, BrainstormingSession } from '@alfred/storage';

type Action = 'start' | 'continue' | 'deepen' | 'compare' | 'plan' | 'execute' | 'list' | 'resume' | 'archive';

export class BrainstormingSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'brainstorming',
    category: 'productivity',
    description:
      'Strukturiertes Brainstorming mit Kontext aus dem Knowledge Graph. ' +
      '"start" beginnt eine neue Session zu einem Thema — sammelt automatisch KG/Memory-Kontext und generiert Ideen in mehreren Perspektiven (praktisch, finanziell, zeitlich, Risiken). ' +
      '"continue" setzt die aktive Session fort, "deepen" vertieft einen bestimmten Punkt (item_number angeben). ' +
      '"compare" vergleicht zwei Optionen (Pro/Con). "plan" erstellt einen konkreten Action-Plan. ' +
      '"execute" erstellt Todos/Reminders aus dem Plan. "list" zeigt alle Sessions. ' +
      '"resume" setzt eine pausierte Session fort, "archive" schließt ab.',
    riskLevel: 'write',
    version: '1.0.0',
    timeoutMs: 120_000,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'continue', 'deepen', 'compare', 'plan', 'execute', 'list', 'resume', 'archive'],
        },
        topic: { type: 'string', description: 'Thema für start/continue' },
        item_number: { type: 'number', description: 'Punkt-Nummer für deepen' },
        option_a: { type: 'string', description: 'Option A für compare' },
        option_b: { type: 'string', description: 'Option B für compare' },
        session_id: { type: 'string', description: 'Session-ID für resume/archive' },
        input: { type: 'string', description: 'Zusätzlicher User-Input/Frage' },
      },
      required: ['action'],
    },
  };

  private kgContextFn?: (userId: string, topic: string) => Promise<string>;
  private llmCallFn?: (prompt: string, tier: 'default' | 'strong') => Promise<string>;

  constructor(
    private readonly repo: BrainstormingRepository,
  ) {
    super();
  }

  /** Inject KG context fetcher (from alfred.ts). */
  setKgContextFn(fn: typeof this.kgContextFn): void { this.kgContextFn = fn; }
  /** Inject LLM call function (from alfred.ts). */
  setLlmCallFn(fn: typeof this.llmCallFn): void { this.llmCallFn = fn; }

  async execute(input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const action = input.action as Action;
    const userId = context.alfredUserId ?? context.userId;

    switch (action) {
      case 'start': return this.startSession(userId, input, context);
      case 'continue': return this.continueSession(userId, input);
      case 'deepen': return this.deepenItem(userId, input);
      case 'compare': return this.compareOptions(userId, input);
      case 'plan': return this.createPlan(userId, input);
      case 'list': return this.listSessions(userId);
      case 'resume': return this.resumeSession(input);
      case 'archive': return this.archiveSession(input);
      case 'execute': return this.executePlan(userId, input);
      default:
        return { success: false, error: `Unknown action: ${String(action)}` };
    }
  }

  private async startSession(userId: string, input: Record<string, unknown>, context: SkillContext): Promise<SkillResult> {
    const topic = input.topic as string;
    if (!topic) return { success: false, error: 'Kein Thema angegeben (topic fehlt).' };

    // Check for existing active session on same topic
    const existing = await this.repo.getActiveSession(userId, topic);
    if (existing) {
      return this.continueSession(userId, { ...input, session_id: existing.id });
    }

    // Gather KG context
    let kgContext = '';
    if (this.kgContextFn) {
      try { kgContext = await this.kgContextFn(userId, topic); } catch { /* no context */ }
    }

    // Create session
    const session = await this.repo.createSession(userId, topic, { kgContext });

    // Generate initial brainstorming via LLM
    const prompt = this.buildBrainstormPrompt(topic, kgContext, input.input as string | undefined);
    let llmResult = '';
    if (this.llmCallFn) {
      try { llmResult = await this.llmCallFn(prompt, 'strong'); } catch { llmResult = '(LLM-Aufruf fehlgeschlagen)'; }
    }

    // Parse and save items
    const items = this.parseItems(llmResult);
    for (const item of items) {
      await this.repo.addItem(session.id, 'ideas', item.content, item.category);
    }

    const display = `## Brainstorming: ${topic}\n\n${llmResult}\n\n---\n*Session ${session.id.slice(0, 8)} — ${items.length} Ideen gespeichert. Sage "vertiefen Punkt X", "vergleiche A vs B", oder "mach einen Plan".*`;
    return { success: true, data: { sessionId: session.id, items: items.length }, display };
  }

  private async continueSession(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const sessionId = input.session_id as string | undefined;
    const session = sessionId
      ? await this.repo.getSession(sessionId)
      : await this.repo.getActiveSession(userId, input.topic as string | undefined);

    if (!session) return { success: false, error: 'Keine aktive Brainstorming-Session gefunden.' };

    const existingItems = await this.repo.getItems(session.id);
    const userInput = input.input as string ?? input.topic as string ?? 'Weitere Ideen';

    const prompt = `Du bist ein Brainstorming-Assistent. Das bisherige Brainstorming zum Thema "${session.topic}":\n\n${existingItems.map((item, i) => `${i + 1}. [${item.category ?? 'allgemein'}] ${item.content}`).join('\n')}\n\nKontext: ${JSON.stringify(session.context).slice(0, 500)}\n\nDer User möchte weiterbrainstormen: "${userInput}"\n\nGeneriere 3-5 weitere Ideen in Markdown. Nummeriere sie fortlaufend ab ${existingItems.length + 1}. Kategorisiere jede Idee.`;

    let llmResult = '';
    if (this.llmCallFn) {
      try { llmResult = await this.llmCallFn(prompt, 'strong'); } catch { llmResult = '(LLM fehlgeschlagen)'; }
    }

    const newItems = this.parseItems(llmResult);
    for (const item of newItems) {
      await this.repo.addItem(session.id, 'ideas', item.content, item.category);
    }
    await this.repo.touchSession(session.id);

    return { success: true, data: { sessionId: session.id, newItems: newItems.length }, display: `## ${session.topic} — Fortsetzung\n\n${llmResult}` };
  }

  private async deepenItem(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const session = await this.repo.getActiveSession(userId);
    if (!session) return { success: false, error: 'Keine aktive Session.' };

    const items = await this.repo.getItems(session.id);
    const num = (input.item_number as number) ?? 0;
    const item = items[num - 1];
    if (!item) return { success: false, error: `Punkt ${num} nicht gefunden (${items.length} Punkte vorhanden).` };

    const prompt = `Vertiefe diesen Brainstorming-Punkt zum Thema "${session.topic}":\n\n"${item.content}"\n\nKontext: ${JSON.stringify(session.context).slice(0, 500)}\n\nAnalysiere im Detail: Machbarkeit, Vor-/Nachteile, konkrete Umsetzungsschritte, Risiken. Auf Deutsch, strukturiert in Markdown.`;

    let llmResult = '';
    if (this.llmCallFn) {
      try { llmResult = await this.llmCallFn(prompt, 'strong'); } catch { llmResult = '(LLM fehlgeschlagen)'; }
    }

    await this.repo.addItem(session.id, 'analysis', `Vertiefung Punkt ${num}: ${llmResult.slice(0, 500)}`, item.category);
    await this.repo.touchSession(session.id);

    return { success: true, display: `## Vertiefung: Punkt ${num}\n\n${llmResult}` };
  }

  private async compareOptions(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const session = await this.repo.getActiveSession(userId);
    if (!session) return { success: false, error: 'Keine aktive Session.' };

    const optA = input.option_a as string ?? 'Option A';
    const optB = input.option_b as string ?? 'Option B';

    const prompt = `Vergleiche diese beiden Optionen zum Thema "${session.topic}":\n\nOption A: ${optA}\nOption B: ${optB}\n\nKontext: ${JSON.stringify(session.context).slice(0, 500)}\n\nErstelle eine Pro/Con-Analyse für beide Optionen. Empfehle eine Option mit Begründung. Auf Deutsch, Markdown-Tabelle.`;

    let llmResult = '';
    if (this.llmCallFn) {
      try { llmResult = await this.llmCallFn(prompt, 'strong'); } catch { llmResult = '(LLM fehlgeschlagen)'; }
    }

    await this.repo.addItem(session.id, 'analysis', `Vergleich: ${optA} vs ${optB}`, 'comparison');
    await this.repo.touchSession(session.id);

    return { success: true, display: `## Vergleich: ${optA} vs ${optB}\n\n${llmResult}` };
  }

  private async createPlan(userId: string, input: Record<string, unknown>): Promise<SkillResult> {
    const session = await this.repo.getActiveSession(userId);
    if (!session) return { success: false, error: 'Keine aktive Session.' };

    const items = await this.repo.getItems(session.id);
    const selectedItems = items.filter(i => i.status !== 'rejected');

    const prompt = `Erstelle einen konkreten Action-Plan basierend auf diesem Brainstorming zu "${session.topic}":\n\n${selectedItems.map((item, i) => `${i + 1}. ${item.content}`).join('\n')}\n\nKontext: ${JSON.stringify(session.context).slice(0, 500)}\n\nErstelle max 7 konkrete, priorisierte Schritte mit Zeitrahmen. Format: nummerierte Liste, jeder Punkt mit geschätzter Deadline. Auf Deutsch.`;

    let llmResult = '';
    if (this.llmCallFn) {
      try { llmResult = await this.llmCallFn(prompt, 'strong'); } catch { llmResult = '(LLM fehlgeschlagen)'; }
    }

    const planItems = this.parseItems(llmResult);
    for (const item of planItems) {
      await this.repo.addItem(session.id, 'action_plan', item.content, 'action');
    }
    await this.repo.touchSession(session.id);

    return { success: true, data: { planItems: planItems.length }, display: `## Action-Plan: ${session.topic}\n\n${llmResult}\n\n---\n*Sage "ausführen" um Todos/Reminders aus dem Plan zu erstellen.*` };
  }

  private async executePlan(userId: string, _input: Record<string, unknown>): Promise<SkillResult> {
    const session = await this.repo.getActiveSession(userId);
    if (!session) return { success: false, error: 'Keine aktive Session.' };

    const planItems = await this.repo.getItems(session.id, 'action_plan');
    if (planItems.length === 0) return { success: false, error: 'Kein Action-Plan vorhanden. Sage erst "plan machen".' };

    // Return the plan items formatted for the LLM to create todos/reminders
    const lines = planItems.map((item, i) => `${i + 1}. ${item.content}`);
    await this.repo.updateSessionStatus(session.id, 'completed');

    return {
      success: true,
      data: { sessionId: session.id, planItems: planItems.length },
      display: `## ${session.topic} — Plan zur Umsetzung\n\n${lines.join('\n')}\n\n✅ Session abgeschlossen. Erstelle jetzt die entsprechenden Todos/Reminders für diese Punkte.`,
    };
  }

  private async listSessions(userId: string): Promise<SkillResult> {
    const sessions = await this.repo.listSessions(userId, 10);
    if (sessions.length === 0) return { success: true, display: 'Keine Brainstorming-Sessions vorhanden.' };

    const lines = sessions.map(s => {
      const icon = s.status === 'active' ? '🟢' : s.status === 'paused' ? '⏸️' : s.status === 'completed' ? '✅' : '📦';
      return `${icon} **${s.topic}** (${s.status}, ${s.createdAt.slice(0, 10)}) — ID: ${s.id.slice(0, 8)}`;
    });

    return { success: true, data: sessions, display: `## Brainstorming-Sessions\n\n${lines.join('\n')}` };
  }

  private async resumeSession(input: Record<string, unknown>): Promise<SkillResult> {
    const sessionId = input.session_id as string;
    if (!sessionId) return { success: false, error: 'session_id erforderlich.' };
    await this.repo.updateSessionStatus(sessionId, 'active');
    return { success: true, display: `Session ${sessionId.slice(0, 8)} wieder aktiviert. Sage "weiter" um fortzufahren.` };
  }

  private async archiveSession(input: Record<string, unknown>): Promise<SkillResult> {
    const sessionId = input.session_id as string;
    if (!sessionId) return { success: false, error: 'session_id erforderlich.' };
    await this.repo.updateSessionStatus(sessionId, 'archived');
    return { success: true, display: `Session ${sessionId.slice(0, 8)} archiviert.` };
  }

  private buildBrainstormPrompt(topic: string, kgContext: string, userInput?: string): string {
    return `Du bist ein kreativer Brainstorming-Assistent. Der User möchte strukturiert über folgendes Thema nachdenken:

THEMA: ${topic}
${userInput ? `USER-INPUT: ${userInput}` : ''}

KONTEXT (aus dem persönlichen Knowledge Graph des Users):
${kgContext || '(kein zusätzlicher Kontext)'}

Generiere ein strukturiertes Brainstorming mit 5-10 Ideen/Punkten, aufgeteilt in Kategorien:
- 🚀 Praktisch / Machbarkeit
- 💰 Finanziell / Kosten
- ⏰ Zeitlich / Deadlines
- ⚠️ Risiken / Was könnte schiefgehen
- 💡 Kreativ / Alternativen

Nummeriere ALLE Punkte durchgehend (1, 2, 3...). Schreibe bei jedem Punkt die Kategorie dazu.
Beziehe dich auf den Kontext wenn möglich (z.B. bekannte Adressen, Fahrzeuge, Personen).
Auf Deutsch, Markdown-Format. Am Ende: kurze Empfehlung für nächste Schritte.`;
  }

  private parseItems(llmOutput: string): Array<{ content: string; category?: string }> {
    const items: Array<{ content: string; category?: string }> = [];
    const lines = llmOutput.split('\n');
    for (const line of lines) {
      const match = line.match(/^\s*\d+\.\s+(?:\[([^\]]+)\]\s*)?(.+)/);
      if (match) {
        const category = match[1]?.toLowerCase().trim();
        items.push({ content: match[2].trim(), category });
      }
    }
    // If no numbered items found, treat each non-empty line as an item
    if (items.length === 0) {
      for (const line of lines) {
        const trimmed = line.replace(/^[-*•]\s*/, '').trim();
        if (trimmed.length > 10) items.push({ content: trimmed });
      }
    }
    return items.slice(0, 15);
  }
}
