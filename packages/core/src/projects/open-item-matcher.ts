import type { Logger } from 'pino';
import type { ProjectRepository, ProjectOpenItem } from '@alfred/storage';
import type { LLMProvider } from '@alfred/llm';

const SYSTEM_PROMPT = `Du bewertest welche offenen Punkte eines Software-Projekts durch einen gerade abgeschlossenen Agent-Lauf erledigt wurden.

Du bekommst:
- Project-Goal (Was sollte der Lauf tun)
- Milestones (was tatsächlich gemacht wurde)
- Geänderte Dateien (relativ zum cwd)
- Eine Liste offener Punkte mit ID + Titel + optional Beschreibung

Antworte als JSON-Array. Jedes Element:
{
  "item_id": "uuid",
  "resolved": true|false,
  "confidence": 0.0-1.0,
  "reason": "Kurzbegründung, warum erledigt (oder nicht)"
}

Sei konservativ: nur als "resolved=true" markieren wenn klar erkennbar ist dass der Lauf den Punkt addressiert hat (Milestone matched semantisch, geänderte Dateien passen zum Item-Inhalt). Im Zweifel resolved=false.`;

interface MatchResult {
  item_id: string;
  resolved: boolean;
  confidence: number;
  reason?: string;
}

/**
 * v641 — Nach jedem erfolgreichen Project-Agent-Lauf:
 *   1. Hole alle 'open'/'in_progress' Items des Projekts
 *   2. Frag den LLM ob/welche der Items mit Milestones + Files gematcht sind
 *   3. Auto-resolve mit Confidence + Attribution
 *
 * Skippt komplett wenn keine Items offen sind ODER LLM-Provider nicht da ODER
 * der Lauf 0 Files änderte.
 */
export class OpenItemMatcher {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly llm: LLMProvider,
    private readonly logger: Logger,
  ) {}

  async matchAfterSession(opts: {
    projectId: string;
    sessionId: string;
    goal: string;
    milestones: string[];
    changedFiles?: string[];
    totalFilesChanged: number;
  }): Promise<{ matched: number; resolved: number }> {
    if (opts.totalFilesChanged === 0) return { matched: 0, resolved: 0 };

    const openItems = await this.projects.listOpenItemsForProject(opts.projectId);
    if (openItems.length === 0) return { matched: 0, resolved: 0 };

    const itemsForPrompt = openItems.map(i => ({
      id: i.id,
      title: i.title.slice(0, 200),
      description: (i.description ?? '').slice(0, 400),
    }));

    const payload = {
      goal: opts.goal.slice(0, 1000),
      milestones: opts.milestones.slice(0, 30),
      files: (opts.changedFiles ?? []).slice(0, 80),
      open_items: itemsForPrompt,
    };

    let results: MatchResult[] = [];
    try {
      const res = await this.llm.complete({
        messages: [{ role: 'user', content: `${SYSTEM_PROMPT}\n\nDaten:\n\`\`\`json\n${JSON.stringify(payload, null, 2).slice(0, 12000)}\n\`\`\`` }],
        tier: 'default' as any,
        maxTokens: 1500,
      });
      const cleaned = res.content.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, '$1').trim();
      const start = cleaned.indexOf('[');
      const end = cleaned.lastIndexOf(']');
      if (start >= 0 && end > start) results = JSON.parse(cleaned.slice(start, end + 1));
    } catch (err) {
      this.logger.debug({ err, projectId: opts.projectId }, 'OpenItemMatcher LLM call failed');
      return { matched: 0, resolved: 0 };
    }

    const knownIds = new Set(openItems.map(i => i.id));
    let resolved = 0;
    for (const r of results) {
      if (!knownIds.has(r.item_id)) continue;
      if (!r.resolved && (r.confidence ?? 0) < 0.4) continue;
      const ok = await this.projects.autoResolveOpenItem(
        r.item_id,
        `project_agent_session:${opts.sessionId}`,
        r.confidence ?? 0,
        r.resolved,
      ).catch(() => false);
      if (ok && r.resolved && r.confidence >= 0.6) resolved++;
    }
    this.logger.info({
      projectId: opts.projectId, sessionId: opts.sessionId,
      considered: openItems.length, llmResults: results.length, resolved,
    }, 'OpenItemMatcher complete');
    return { matched: results.length, resolved };
  }
}
