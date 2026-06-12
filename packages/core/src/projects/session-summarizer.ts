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
 * Pattern for an 8-character hex prefix of a UUID/ITSM-ID (e.g. "faad041f").
 * Used in Anti-Duplicate-Filter (v602 P4): open-items whose title contains
 * such an ID get the ID extracted into `linked_incident_id` instead of duplicated.
 */
const ITSM_ID_RE = /\b([0-9a-f]{8})\b/i;

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
- open_items: AUSSCHLIESSLICH Punkte, die im Transkript EXPLIZIT als offen/unerledigt/fehlgeschlagen benannt sind. Max 8.
  WICHTIG (v869): NIEMALS Punkte aufnehmen, die in DIESER Session bereits erledigt wurden — auch nicht als
  "verifizieren"/"testen"-Variante des Erledigten. KEINE erfundenen Nachfolgeschritte, KEINE generischen
  Verbesserungsideen ("könnte man noch optimieren"). Wenn nichts explizit offen blieb: [].
- files_touched: nur aus den oben gelisteten FILES auswählen, keine erfinden.
- next_check_in_days: 7 bei aktiven Themen, 14 default, 30 wenn klar abgeschlossen ohne offene Punkte.
- Sprache: Deutsch.

ANTI-DUPLICATE-REGEL (wichtig, v602 P4):
Wenn ein Open-Item eine konkrete ITSM-Incident-ID referenziert (8-stelliger hex-Prefix wie "faad041f" oder "b173ca40"),
hänge die ID als zusätzliches Feld an statt sie als generischen TODO zu duplizieren:
- linked_incident_id: "faad041f"   ← Hex-ID aus dem Titel
- Der title sollte dann eine ZUSAMMENFASSUNG der Aufgabe sein, ohne die ID zu doppeln
- Beispiel STATT "Incident faad041f schließen" → { title: "Redundanten Meta-Incident schließen", linked_incident_id: "faad041f" }
- Diese verlinkten Items erscheinen weiterhin im Projekt, sind aber mit dem ITSM-Incident verknüpft sodass Resolve auf einer Seite beide schließt.`;
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
        .map(it => {
          const titleRaw = String(it.title ?? '').trim().slice(0, 200);
          // Anti-Duplicate fallback: if LLM didn't extract linked_incident_id but the title
          // still contains an ITSM-ID prefix, extract it now.
          let linkedIncidentId = typeof it.linked_incident_id === 'string' && /^[0-9a-f]{8}$/i.test(it.linked_incident_id)
            ? it.linked_incident_id.toLowerCase()
            : undefined;
          let title = titleRaw;
          if (!linkedIncidentId) {
            const match = ITSM_ID_RE.exec(titleRaw);
            if (match) {
              linkedIncidentId = match[1].toLowerCase();
              // Strip the ID from the title for cleanliness (keep surrounding text)
              title = titleRaw.replace(match[0], '').replace(/\s{2,}/g, ' ').trim();
              if (title.length === 0) title = titleRaw;
            }
          }
          return {
            title,
            priority: (typeof it.priority === 'string' && ['low', 'normal', 'high'].includes(it.priority))
              ? (it.priority as 'low' | 'normal' | 'high')
              : 'normal',
            description: typeof it.description === 'string' ? it.description.trim().slice(0, 400) : undefined,
            linkedIncidentId,
          };
        })
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

  /**
   * v876 — Befund-Extraktion aus dem INHALT eines Doku-only-Artefakts
   * (Audit/Review/Proposal). Der reguläre Summarizer sieht nur Datei-Pfade
   * und den Agent-Schlusstext — die dokumentierten Gaps/Bugs mit Fundstellen
   * stehen aber im Dokument selbst (Vorfall 12.06.: 19 Gaps im Audit-Doc,
   * Items sagten nur "nochmal prüfen"). Returns null bei LLM-/Parse-Fehler —
   * Caller fällt auf das v869.5-"Umsetzen:"-Item zurück.
   */
  async extractDocFindings(input: { goal: string; docPath: string; docContent: string }): Promise<DocFinding[] | null> {
    const prompt = [
      `Ein Analyse-/Audit-Lauf hat das folgende Dokument erzeugt. Extrahiere die dort DOKUMENTIERTEN offenen Befunde (Bugs, Lücken, fehlende Features, konkrete Empfehlungen) als umsetzbare Arbeitspunkte.`,
      ``,
      `ZIEL DES LAUFS: ${input.goal.slice(0, 400)}`,
      `DOKUMENT (${input.docPath}):`,
      `---`,
      input.docContent,
      `---`,
      ``,
      `Antworte AUSSCHLIESSLICH mit einem validen JSON-Array (keine Fences, kein Text davor/danach):`,
      `[{"title": "kurzer umsetzbarer Titel (max 150 Zeichen)", "priority": "low|normal|high", "description": "1-2 Sätze inkl. Fundstelle (Datei:Zeile) wenn im Dokument genannt"}]`,
      ``,
      `Regeln:`,
      `- NUR Punkte, die das Dokument explizit als offen/fehlend/fehlerhaft benennt — NICHTS erfinden.`,
      `- KEINE Punkte, die das Dokument als erledigt/vollständig/funktionierend beschreibt.`,
      `- KEINE Wiederholung der Prüf-/Audit-Frage selbst ("X prüfen/verifizieren") — die Prüfung IST dieses Dokument.`,
      `- Priorität aus dem Dokument übernehmen wenn vorhanden (P1/kritisch/Bug → high, P2 → normal, P3/nice-to-have → low).`,
      `- Max 15 Punkte; bei mehr: die wichtigsten. Wenn das Dokument keine offenen Befunde enthält: [].`,
      `- Sprache: Deutsch.`,
    ].join('\n');
    let raw: string;
    try {
      const response = await this.llm.complete({
        messages: [{ role: 'user', content: prompt }],
        tier: this.tier,
        maxTokens: 1800,
      });
      raw = response.content;
    } catch {
      return null;
    }
    return parseDocFindings(raw);
  }
}

/** v876 — Befund aus einem Doku-Artefakt (extrahiert für Open-Item-Erzeugung). */
export interface DocFinding {
  title: string;
  priority: 'low' | 'normal' | 'high';
  description?: string;
}

/** v876 — pure Parser für die Befund-Extraktion (separat exportiert für Tests). */
export function parseDocFindings(raw: string): DocFinding[] | null {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  // JSON-Array auch dann finden, wenn das LLM Prosa drumherum gesetzt hat
  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed.slice(start, end + 1)); } catch { return null; }
  if (!Array.isArray(parsed)) return null;
  return parsed
    .filter((it): it is Record<string, unknown> => !!it && typeof it === 'object')
    .map(it => ({
      title: String(it.title ?? '').trim().slice(0, 200),
      priority: (typeof it.priority === 'string' && ['low', 'normal', 'high'].includes(it.priority))
        ? (it.priority as 'low' | 'normal' | 'high')
        : 'normal',
      description: typeof it.description === 'string' ? it.description.trim().slice(0, 600) : undefined,
    }))
    .filter(it => it.title.length > 0)
    .slice(0, 15);
}
