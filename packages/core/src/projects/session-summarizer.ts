import type { LLMProvider } from '@alfred/llm';
import type { ProjectSessionSummary } from '@alfred/storage';

export interface SummarizerInput {
  /** Original goal of the session. */
  goal: string;
  /** Session type — informs the summarizer prompt context. */
  sessionType: 'project_agent' | 'code_agent' | 'delegate' | 'chat';
  /** Working directory (if applicable). */
  cwd?: string;
  /** Milestones reached during the session. */
  milestones?: string[];
  /** Counter — total files touched (rough indicator of scope). */
  totalFilesChanged?: number;
  /** Did the session reach its goal? */
  success?: boolean;
  /** Optional raw transcript excerpt (last messages or assistant final-output). */
  transcript?: string;
  /** Optional file paths the runner detected as touched. */
  files?: string[];
}

/**
 * LLM-driven extraction of structured project knowledge from a finished session.
 *
 * Returns null when the LLM call fails or output is unparseable — caller falls back
 * to a deterministic minimal summary. The strict JSON shape keeps downstream code
 * simple: anything malformed is simply dropped rather than letting bad data leak in.
 */
export class SessionSummarizer {
  constructor(
    private readonly llm: LLMProvider,
    private readonly tier: 'default' | 'strong' = 'strong',
  ) {}

  async summarize(input: SummarizerInput): Promise<ProjectSessionSummary | null> {
    const prompt = this.buildPrompt(input);
    let raw: string;
    try {
      const response = await this.llm.complete({
        messages: [{ role: 'user', content: prompt }],
        tier: this.tier,
        maxTokens: 1200,
      });
      raw = response.content;
    } catch {
      return null;
    }
    return this.parse(raw, input);
  }

  private buildPrompt(input: SummarizerInput): string {
    const milestones = (input.milestones ?? []).slice(0, 30).map((m, i) => `${i + 1}. ${m}`).join('\n');
    const files = (input.files ?? []).slice(0, 50).join('\n');
    const transcriptSnippet = input.transcript ? input.transcript.slice(0, 4000) : '';

    return `Du analysierst eine abgeschlossene ${input.sessionType}-Session und destillierst sie zu strukturiertem Projekt-Wissen.

ZIEL: ${input.goal}
${input.cwd ? `CWD: ${input.cwd}` : ''}
${typeof input.totalFilesChanged === 'number' ? `FILES_CHANGED_COUNTER: ${input.totalFilesChanged}` : ''}
SUCCESS: ${input.success === true ? 'ja' : input.success === false ? 'nein' : 'unbekannt'}

MEILENSTEINE:
${milestones || '(keine)'}

TOUCHED FILES:
${files || '(keine)'}

TRANSKRIPT-AUSZUG (gekürzt):
${transcriptSnippet || '(nicht verfügbar)'}

Erzeuge AUSSCHLIESSLICH valides JSON nach diesem Schema (KEINE Markdown-Fences, KEIN Prosa-Text davor/danach):
{
  "what_was_done": "1-3 prägnante Sätze. Was wurde konkret erreicht/gebaut/geändert?",
  "key_decisions": [{ "choice": "kurzer Titel", "rationale": "Warum so entschieden, max 1 Satz" }],
  "files_touched": ["liste konkreter Pfade aus FILES, max 20"],
  "open_items": [{ "title": "kurzer Titel", "priority": "low|normal|high", "description": "optional 1 Satz" }],
  "status": "success|failed|partial",
  "next_check_in_days": 14
}

Regeln:
- key_decisions: nur Architektur-/Stack-/Trade-off-Entscheidungen. Max 5. Bei trivialer Session: [].
- open_items: explizite TODOs aus dem Transkript ODER offensichtliche Nachfolgeschritte. Max 8.
- files_touched: nur aus den oben gelisteten FILES auswählen, keine erfinden.
- next_check_in_days: 7 bei aktiven Themen, 14 default, 30 wenn klar abgeschlossen ohne offene Punkte.
- Sprache: Deutsch.`;
  }

  private parse(raw: string, input: SummarizerInput): ProjectSessionSummary | null {
    const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); } catch { return null; }
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;

    const summary: ProjectSessionSummary = {};

    if (typeof obj.what_was_done === 'string' && obj.what_was_done.trim().length > 0) {
      summary.whatWasDone = obj.what_was_done.trim().slice(0, 600);
    }

    if (Array.isArray(obj.key_decisions)) {
      summary.keyDecisions = obj.key_decisions
        .filter((d): d is Record<string, unknown> => !!d && typeof d === 'object')
        .map(d => ({
          choice: String(d.choice ?? '').trim().slice(0, 200),
          rationale: typeof d.rationale === 'string' ? d.rationale.trim().slice(0, 400) : undefined,
        }))
        .filter(d => d.choice.length > 0)
        .slice(0, 5);
    }

    if (Array.isArray(obj.files_touched)) {
      summary.filesTouched = obj.files_touched
        .filter((f): f is string => typeof f === 'string')
        .map(f => f.trim()).filter(f => f.length > 0).slice(0, 20);
    }

    if (Array.isArray(obj.open_items)) {
      summary.openItems = obj.open_items
        .filter((it): it is Record<string, unknown> => !!it && typeof it === 'object')
        .map(it => ({
          title: String(it.title ?? '').trim().slice(0, 200),
          priority: (typeof it.priority === 'string' && ['low', 'normal', 'high'].includes(it.priority))
            ? (it.priority as 'low' | 'normal' | 'high')
            : 'normal',
          description: typeof it.description === 'string' ? it.description.trim().slice(0, 400) : undefined,
        }))
        .filter(it => it.title.length > 0)
        .slice(0, 8);
    }

    if (typeof obj.status === 'string' && ['success', 'failed', 'partial'].includes(obj.status)) {
      summary.status = obj.status as 'success' | 'failed' | 'partial';
    } else if (input.success === true) {
      summary.status = 'success';
    } else if (input.success === false) {
      summary.status = 'failed';
    }

    if (typeof obj.next_check_in_days === 'number' && obj.next_check_in_days >= 1 && obj.next_check_in_days <= 180) {
      summary.nextCheckInDays = Math.round(obj.next_check_in_days);
    }

    return summary;
  }
}
