import type { Logger } from 'pino';
import type { Platform } from '@alfred/types';
import type {
  TodoRepository,
  WatchRepository,
  MemoryRepository,
  ActivityRepository,
  SkillHealthRepository,
  FeedbackRepository,
  UserRepository,
  WorkflowRepository,
  BmwTelematicRepository,
  NoteRepository,
  ReminderRepository,
  DocumentRepository,
  ConversationRepository,
  RunbookRepository,
  ProjectRepository,
} from '@alfred/storage';
import type { SkillRegistry, SkillSandbox, CalendarProvider } from '@alfred/skills';
import { buildSkillContext } from './context-factory.js';

/**
 * v1143 — J1: findet das SPÄTESTE Datum in einem Text (ISO oder deutsches
 * dd.mm.[yyyy]). Grundlage für den Vergangenheits-Anker: Kontextzeilen mit
 * Termin in der Vergangenheit müssen als „vorbei" markiert werden — der
 * Realfall „Rückfahrt von Köln planen" entstand aus Memories mit „Do 27.08.",
 * die zwei Tage nach der Fahrt noch als aktuelles Wissen im Kontext lagen.
 */
export function spaetestesDatumImText(text: string, jetzt = new Date()): Date | null {
  const funde: Date[] = [];
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10), 12);
    if (!isNaN(d.getTime())) funde.push(d);
  }
  for (const m of text.matchAll(/\b(\d{1,2})\.(\d{1,2})\.(\d{2,4})?(?!\d)/g)) {
    const tag = parseInt(m[1], 10); const monat = parseInt(m[2], 10);
    if (tag < 1 || tag > 31 || monat < 1 || monat > 12) continue;
    let jahr = m[3] ? parseInt(m[3], 10) : jetzt.getFullYear();
    if (jahr < 100) jahr += 2000;
    const d = new Date(jahr, monat - 1, tag, 12);
    if (!isNaN(d.getTime())) funde.push(d);
  }
  if (funde.length === 0) return null;
  funde.sort((a, b) => a.getTime() - b.getTime());
  return funde[funde.length - 1];
}

/**
 * v1143 — J2: erkennt Alfreds EIGENES Insight-Format (Markdown-Fettdruck +
 * Emoji-Header, Aktions-Zeilen, Dringlichkeits-Marker). Solche Texte sind
 * Ausgaben, kein Wissen — als Memory gespeichert entstand daraus die
 * Echo-Schleife (Reasoning liest die eigene Meldung als Fakt und erneuert sie).
 */
export function istInsightEcho(text: string): boolean {
  if (/→\s*\*?\s*Aktion/i.test(text)) return true;
  if (/\*\*[^*]{3,}\*\*/.test(text) && /\p{Extended_Pictographic}/u.test(text)) return true;
  return /\bDRINGEND\b|Alfred Insights/i.test(text);
}

/**
 * v1143 — J4: Anwesenheits-Zeile aus den Home-Assistant-person-Zeilen —
 * deterministisches Standort-Grounding („User ist zuhause") gegen
 * Reise-Halluzinationen aus veraltetem Kontext.
 */
export function extrahiereAnwesenheit(haContent: string): string | null {
  const status: string[] = [];
  for (const zeile of haContent.split('\n')) {
    const name = zeile.match(/person\.([a-z0-9_]+)/i)?.[1];
    if (!name) continue;
    if (/\bnot_home\b|\baway\b|\babwesend\b/i.test(zeile)) status.push(`${name}: abwesend`);
    else if (/\bhome\b|\bzuhause\b/i.test(zeile)) status.push(`${name}: zuhause`);
  }
  if (status.length === 0) return null;
  return `📍 Anwesenheit JETZT: ${status.join(', ')} — Reise-/Rückfahrt-Themen sind nur relevant, wenn ein KÜNFTIGES Ereignis ansteht.`;
}

/**
 * v1142 — H5: Circuit-Breaker für Kollektor-Quellen. Eine Quelle, die
 * `schwelle`-mal IN FOLGE fehlschlägt (Fehler, Timeout, success:false), wird
 * für `pauseMs` (~20 h ≈ 1 Probe-Versuch/Tag) pausiert; nach Ablauf darf genau
 * EIN Versuch laufen (half-open) — Erfolg setzt alles zurück, Fehlschlag
 * pausiert erneut. Bewusst in-memory: ein Neustart gibt jeder Quelle eine
 * frische Chance.
 */
export class QuellenSchalter {
  private readonly zustand = new Map<string, { fails: number; pauseBis: number }>();

  constructor(
    private readonly schwelle = 12,
    private readonly pauseMs = 20 * 3_600_000,
  ) {}

  istPausiert(quelle: string): boolean {
    const z = this.zustand.get(quelle);
    if (!z) return false;
    if (z.fails < this.schwelle) return false;
    if (Date.now() < z.pauseBis) return true;
    // half-open: einen Versuch zulassen — pauseBis vorschieben, damit parallele
    // Aufrufe im selben Pass nicht alle gleichzeitig durchrutschen
    z.pauseBis = Date.now() + this.pauseMs;
    return false;
  }

  /** Registriert einen Fehlschlag; true genau dann, wenn die Pause JETZT beginnt. */
  fehlschlag(quelle: string): boolean {
    const z = this.zustand.get(quelle) ?? { fails: 0, pauseBis: 0 };
    z.fails++;
    const beginnt = z.fails === this.schwelle;
    if (z.fails >= this.schwelle) z.pauseBis = Date.now() + this.pauseMs;
    this.zustand.set(quelle, z);
    return beginnt;
  }

  erfolg(quelle: string): void { this.zustand.delete(quelle); }

  fehlversuche(quelle: string): number { return this.zustand.get(quelle)?.fails ?? 0; }
}

// ── Helpers ──────────────────────────────────────────────────

/**
 * Render a memory line for the LLM prompt. Includes:
 * - `(erfasst YYYY-MM-DD)` — creation date, so relative phrases ("morgen", "Montag")
 *   can be interpreted against the right anchor.
 * - `(gültig bis YYYY-MM-DD)` — for corrections with a temporal validity window.
 *   Past this date, the correction is rendered with "(abgelaufen)" marker so the
 *   LLM knows it's no longer in effect.
 * - `(betrifft: <refs>)` — for `_resolved` corrections, lists the specific events
 *   this correction resolves. New events with DIFFERENT refs are NOT blocked by it.
 */
function formatMemoryLine(m: {
  type?: string; key: string; value: string;
  createdAt?: string; relevantUntil?: string | null; sourceEventRefs?: string[] | null;
}): string {
  const annotations: string[] = [];
  if (m.createdAt) annotations.push(`erfasst ${m.createdAt.slice(0, 10)}`);

  if (m.relevantUntil) {
    const validUntilDate = m.relevantUntil.slice(0, 10);
    const isPast = m.relevantUntil < new Date().toISOString();
    annotations.push(isPast ? `abgelaufen seit ${validUntilDate}` : `gültig bis ${validUntilDate}`);
  } else {
    // v1143 — J1: auch OHNE relevant_until zählt ein Datum im Text — liegt es
    // >24 h zurück, wird die Zeile hart als vorbei markiert. Vorher entschied
    // das LLM über die Vergangenheit („Rückfahrt von Köln" zwei Tage nach der
    // Rückkehr, weil „Do 27.08." kommentarlos im Kontext stand).
    const datum = spaetestesDatumImText(m.value);
    if (datum && Date.now() - datum.getTime() > 24 * 3_600_000) {
      annotations.push(`EREIGNIS VORBEI seit ${datum.toISOString().slice(0, 10)} — nur Rückblick, KEINE Aktionen ableiten`);
    }
  }

  if (m.sourceEventRefs && m.sourceEventRefs.length > 0) {
    annotations.push(`betrifft: ${m.sourceEventRefs.slice(0, 5).join(', ')}`);
  }

  const annPart = annotations.length > 0 ? ` (${annotations.join('; ')})` : '';
  return `- [${m.type ?? 'general'}] ${m.key}${annPart}: ${m.value}`;
}

// ── Types ────────────────────────────────────────────────────

export interface ReasoningSection {
  key: string;
  label: string;
  content: string;
  priority: 1 | 2 | 3;
  tokenEstimate: number;
  changed: boolean;
}

export interface CollectedContext {
  dateTime: string;
  sections: ReasoningSection[];
  changedSections: string[];
  totalTokens: number;
}

// ── Source Definitions ───────────────────────────────────────

interface SourceDef {
  key: string;
  label: string;
  priority: 1 | 2 | 3;
  maxTokens: number;
  fetch: () => Promise<string>;
}

// ── Constants ────────────────────────────────────────────────

/** Total token budget for all data sections combined. */
const TOTAL_TOKEN_BUDGET = 5000;

/** Timeout for individual skill data fetches (ms). */
const SKILL_FETCH_TIMEOUT_MS = 5_000;

// ── Collector ────────────────────────────────────────────────

export class ReasoningContextCollector {
  /** In-memory change detection: previous content per section key. */
  private previousContent = new Map<string, string>();
  /** In-memory error tracking: was this section successful on the previous run? */
  private previousSuccess = new Map<string, boolean>();
  /** Resolved master user ID (cached after first resolve). */
  private resolvedUserId?: string;
  /** Optional planning agent for active plans context. */
  private planningAgent?: import('./planning-agent.js').PlanningAgent;
  setPlanningAgent(agent: import('./planning-agent.js').PlanningAgent): void { this.planningAgent = agent; }

  constructor(
    private readonly skillRegistry: SkillRegistry,
    private readonly skillSandbox: SkillSandbox,
    private readonly userRepo: UserRepository,
    private readonly calendarProvider: CalendarProvider | undefined,
    private readonly todoRepo: TodoRepository,
    private readonly watchRepo: WatchRepository,
    private readonly memoryRepo: MemoryRepository,
    private readonly activityRepo: ActivityRepository,
    private readonly skillHealthRepo: SkillHealthRepository,
    private readonly feedbackRepo: FeedbackRepository | undefined,
    private readonly defaultChatId: string,
    private readonly defaultPlatform: Platform,
    private readonly defaultLocation: string | undefined,
    private readonly logger: Logger,
    private readonly workflowRepo?: WorkflowRepository,
    private readonly bmwTelematicRepo?: BmwTelematicRepository,
    private readonly noteRepo?: NoteRepository,
    private readonly reminderRepo?: ReminderRepository,
    private readonly documentRepo?: DocumentRepository,
    private readonly userTimezone?: string,
    private readonly conversationRepo?: ConversationRepository,
    private readonly runbookRepo?: RunbookRepository,
    private readonly projectRepo?: ProjectRepository,
  ) {}

  /** Get the effective user ID for memory lookups (resolves master_user_id once, cached). */
  private async getEffectiveUserId(): Promise<string> {
    if (this.resolvedUserId) return this.resolvedUserId;
    try {
      const user = await this.userRepo.findOrCreate(this.defaultPlatform, this.defaultChatId);
      this.resolvedUserId = user.masterUserId ?? user.id;
    } catch {
      this.resolvedUserId = this.defaultChatId;
    }
    return this.resolvedUserId;
  }

  async collect(): Promise<CollectedContext> {
    // Resolve master user ID once per collect() for all memory lookups
    this.resolvedUserId = await this.getEffectiveUserId();

    const now = new Date();
    const tz = this.userTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const dateTime = now.toLocaleString('de-AT', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
      timeZone: tz,
    }) + ` (${tz})`;

    const allSources = this.buildSourceDefs(now);

    // ── PHASE 1: Fetch all sources EXCEPT memories in parallel ───
    // Memories are fetched in Phase 2 with context-awareness (keywords from Phase 1 results).
    const memoriesIdx = allSources.findIndex(s => s.key === 'memories');
    const memoriesDef = memoriesIdx >= 0 ? allSources.splice(memoriesIdx, 1)[0] : undefined;

    const fetchStart = Date.now();
    const truncations: string[] = [];
    const timings: Record<string, number> = {};

    const fetchSection = async (src: typeof allSources[0]): Promise<ReasoningSection> => {
      const t0 = Date.now();
      let content = await src.fetch();
      timings[src.key] = Date.now() - t0;

      const maxChars = Math.floor(src.maxTokens * 3.5);
      if (content.length > maxChars) {
        const originalTokens = Math.ceil(content.length / 3.5);
        const lines = content.split('\n');
        let charCount = 0;
        const kept: string[] = [];
        for (const line of lines) {
          if (charCount + line.length + 1 > maxChars) break;
          kept.push(line);
          charCount += line.length + 1;
        }
        content = kept.join('\n') + '\n...(gekürzt)';
        truncations.push(`${src.key}:${originalTokens}→${src.maxTokens}`);
      }
      return {
        key: src.key, label: src.label, priority: src.priority,
        content, tokenEstimate: Math.ceil(content.length / 3.5), changed: false,
      };
    };

    const phase1Results = await Promise.allSettled(allSources.map(fetchSection));

    // Collect Phase 1 results
    const sections: ReasoningSection[] = [];
    const rejected: string[] = [];
    const empty: string[] = [];
    for (let i = 0; i < phase1Results.length; i++) {
      const r = phase1Results[i];
      const srcKey = allSources[i]?.key ?? `unknown-${i}`;
      if (r.status === 'rejected') {
        rejected.push(`${srcKey}: ${String(r.reason).slice(0, 100)}`);
      } else if (!r.value.content) {
        empty.push(srcKey);
      } else {
        sections.push(r.value);
      }
    }

    // Single aggregated log for all fetch results
    const fetchDuration = Date.now() - fetchStart;
    const slowSources = Object.entries(timings).filter(([, ms]) => ms > 2000).map(([k, ms]) => `${k}:${ms}ms`);
    this.logger.info({
      component: 'reasoning-collector',
      fetchDurationMs: fetchDuration,
      total: allSources.length + (memoriesDef ? 1 : 0), fulfilled: sections.length,
      rejected: rejected.length, empty: empty.length,
      truncated: truncations.length > 0 ? truncations.join(', ') : undefined,
      slow: slowSources.length > 0 ? slowSources.join(', ') : undefined,
    }, 'ReasoningCollector: sources fetched');

    if (rejected.length > 0) this.logger.warn({ rejected }, 'ReasoningCollector: sources rejected');
    if (empty.length > 0) this.logger.warn({ empty }, 'ReasoningCollector: sources returned empty content');

    // ── PHASE 2: Context-aware memory fetch ──────────────────
    // Extract keywords from Phase 1 sections, then fetch memories that match the current context.
    if (memoriesDef) {
      const contextKeywords = this.extractContextKeywords(sections);
      const memoriesContent = await this.fetchMemoriesContextAware(contextKeywords);
      if (memoriesContent) {
        let content = memoriesContent;
        const maxChars = Math.floor(memoriesDef.maxTokens * 3.5);
        if (content.length > maxChars) {
          const lines = content.split('\n');
          let charCount = 0;
          const kept: string[] = [];
          for (const line of lines) {
            if (charCount + line.length + 1 > maxChars) break;
            kept.push(line);
            charCount += line.length + 1;
          }
          content = kept.join('\n') + '\n...(gekürzt)';
          truncations.push(`memories:${Math.ceil(memoriesContent.length / 3.5)}→${memoriesDef.maxTokens}`);
        }
        sections.push({
          key: 'memories', label: memoriesDef.label, priority: memoriesDef.priority,
          content, tokenEstimate: Math.ceil(content.length / 3.5), changed: false,
        });
      }
    }

    // ── PHASE 2b: Opt-in chat-history FTS section ────────────────
    // Only runs when:
    //   1. ConversationRepository is wired (production setup)
    //   2. There is at least one meaningful context keyword (proper noun, domain term)
    //      → avoids spending tokens when no topic stands out
    //   3. The search returns actual matches (skip empty)
    if (this.conversationRepo) {
      try {
        const userId = await this.getEffectiveUserId();
        const contextKeywords = this.extractContextKeywords(sections);
        // Only meaningful capitalized / multi-word terms (heuristic for proper nouns)
        const meaningful = contextKeywords.filter(k => k.length >= 5).slice(0, 3);
        if (userId && meaningful.length > 0) {
          const query = meaningful.join(' OR ');
          const results = await this.conversationRepo.searchMessages(userId, query, {
            limit: 5, roles: ['user', 'assistant', 'tool'], timeDecay: true,
          });
          if (results.length > 0) {
            const lines = results.map(r => {
              const when = r.createdAt?.slice(0, 10) ?? '';
              const snippet = r.content.length > 140 ? `${r.content.slice(0, 140)}…` : r.content;
              return `- [${when} ${r.role}] ${snippet.replace(/\n/g, ' ')}`;
            });
            const content = `Relevante frühere Konversationen (FTS-Match auf "${meaningful.join(', ')}"):\n${lines.join('\n')}`;
            sections.push({
              key: 'chatHistory', label: 'Frühere Konversationen', priority: 3,
              content, tokenEstimate: Math.ceil(content.length / 3.5), changed: false,
            });
          }
        }
      } catch (err) {
        this.logger.debug({ err }, 'Chat-history FTS section failed (non-critical)');
      }
    }

    // ── PHASE 2c: Generic Runbook-Match section (v592) ────────────
    // Independent of ITSM. Surfaces relevant past experience for ANY current topic
    // (Bewerbung, Logistik, BMW, Familie, etc.). Searches verified+draft runbooks
    // against the same meaningful keywords used for chat-history. Hidden when no
    // useful matches — saves prompt tokens.
    if (this.runbookRepo) {
      try {
        const userId = await this.getEffectiveUserId();
        const contextKeywords = this.extractContextKeywords(sections);
        const queryTerms = contextKeywords.filter(k => k.length >= 5).slice(0, 5);
        if (userId && queryTerms.length > 0) {
          // findMatching uses keyword-overlap on title+symptom+tags — works across topics
          const matches = await this.runbookRepo.findMatching(userId, queryTerms.join(' '), 4);
          if (matches.length > 0) {
            // v614 L2 — count "surface" as usage. Bumps usage_count for every
            // matched runbook and auto-promotes draft → verified at threshold.
            // Rationale: a runbook the system repeatedly considers relevant has
            // proven its value, even if the LLM doesn't explicitly "use" it.
            // Best-effort, never fails the prompt-build path.
            const PROMOTION_THRESHOLD = 3;
            for (const rb of matches) {
              try {
                await this.runbookRepo.incrementUsage(rb.id);
                if (rb.status === 'draft' && (rb.usageCount + 1) >= PROMOTION_THRESHOLD) {
                  await this.runbookRepo.update(userId, rb.id, { status: 'verified' });
                  this.logger.info({ id: rb.id, title: rb.title.slice(0, 60), usageCount: rb.usageCount + 1 },
                    'Runbook auto-promoted draft → verified (L2 threshold reached)');
                }
              } catch { /* non-critical */ }
            }
            const lines = matches.map(rb => {
              const newCount = rb.usageCount + 1;
              const status = (rb.status === 'verified' || (rb.status === 'draft' && newCount >= PROMOTION_THRESHOLD)) ? '✓' : '·';
              const tagsSuffix = rb.tags.length > 0 ? ` [${rb.tags.slice(0, 3).join(', ')}]` : '';
              return `- ${status} [${rb.id.slice(0, 8)}] ${rb.title.slice(0, 70)}${tagsSuffix} (${newCount}× verwendet)`;
            });
            const content = `Relevante Erfahrungen aus früheren Aufgaben (Runbooks zum aktuellen Thema):\n${lines.join('\n')}\n\nHinweis: Wenn ein Runbook passt → mit \`runbook get\` den vollständigen Steps abrufen und referenzieren.`;
            sections.push({
              key: 'runbooks', label: 'Erfahrungen & Runbooks', priority: 2,
              content, tokenEstimate: Math.ceil(content.length / 3.5), changed: false,
            });
          }
        }
      } catch (err) {
        this.logger.debug({ err }, 'Generic runbook-match section failed (non-critical)');
      }
    }

    // ── PHASE 2c2: Recent successful Deploys (v608 F8) ────────────
    // Surfaces "I have deployed project X to host H before, and it worked".
    // Lets the LLM say "you previously deployed alpbyte-games to 192.168.1.96"
    // instead of asking the user where to deploy it. Strictly success-only and
    // capped at 5 entries so the prompt stays small.
    if (this.activityRepo) {
      try {
        const userId = await this.getEffectiveUserId();
        if (userId) {
          const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
          const rows = await this.activityRepo.query({
            eventType: 'skill_exec',
            action: 'deploy',
            outcome: 'success',
            userId,
            since,
            limit: 30,
          });
          // Group by host+project, keep most recent per pair
          type Entry = { host: string; project: string; when: string; details?: Record<string, unknown> };
          const byKey = new Map<string, Entry>();
          for (const r of rows) {
            const d = r.details ?? {};
            const host = typeof d.host === 'string' ? d.host
              : (typeof d.target_host === 'string' ? d.target_host : undefined);
            const project = typeof d.project === 'string' ? d.project : undefined;
            if (!host || !project) continue;
            const key = `${host}::${project}`;
            if (!byKey.has(key)) {
              byKey.set(key, { host, project, when: r.timestamp, details: d });
            }
          }
          if (byKey.size > 0) {
            const items = [...byKey.values()].slice(0, 5);
            const lines = items.map(e => {
              const ago = Math.floor((Date.now() - new Date(e.when).getTime()) / 86_400_000);
              const ageStr = ago === 0 ? 'heute' : ago === 1 ? 'gestern' : `vor ${ago}d`;
              const runtime = typeof e.details?.runtime === 'string' ? ` · runtime=${e.details.runtime}` : '';
              const pm = typeof e.details?.process_manager === 'string' ? ` · pm=${e.details.process_manager}` : '';
              return `- ${e.project} → ${e.host} (${ageStr})${runtime}${pm}`;
            });
            const content = `Erfolgreich deployte Projekte (letzte 14 Tage, je host+project nur neueste):\n${lines.join('\n')}\n\nHinweis: Wenn der User dasselbe Projekt erneut deployen will, ist Host & Setup oben dokumentiert.`;
            sections.push({
              key: 'deploys', label: 'Letzte Deploys', priority: 2,
              content, tokenEstimate: Math.ceil(content.length / 3.5), changed: false,
            });
          }
        }
      } catch (err) {
        this.logger.debug({ err }, 'Recent-deploys section failed (non-critical)');
      }
    }

    // ── PHASE 2d: Active Projects section (v599) ──────────────────
    // Project containers Alfred has been working on. Hidden when no active projects.
    // Surfaces open items and stale projects so the LLM can reference them in insights
    // ("Project X has been quiet for 5 weeks — archive it or follow up?").
    if (this.projectRepo) {
      try {
        const userId = await this.getEffectiveUserId();
        if (userId) {
          const projects = await this.projectRepo.list(userId, { status: 'active', limit: 10 });
          if (projects.length > 0) {
            const lines: string[] = [];
            const staleLines: string[] = [];
            const now = Date.now();
            const STALE_DAYS = 30;

            // Gather open items once across all active projects for budget reasons
            const openItems = await this.projectRepo.listOpenItems(userId, { status: 'open', limit: 50 });
            const openByProject = new Map<string, number>();
            for (const it of openItems) {
              openByProject.set(it.projectId, (openByProject.get(it.projectId) ?? 0) + 1);
            }

            for (const p of projects.slice(0, 5)) {
              const ageDays = Math.floor((now - new Date(p.lastActiveAt).getTime()) / (24 * 60 * 60 * 1000));
              const ageStr = ageDays === 0 ? 'heute' : ageDays === 1 ? 'gestern' : `vor ${ageDays}d`;
              const oc = openByProject.get(p.id) ?? 0;
              const ocStr = oc > 0 ? ` — ${oc} offene Punkte` : '';
              lines.push(`- **${p.name.slice(0, 60)}** (${ageStr})${ocStr}`);
              if (ageDays >= STALE_DAYS) {
                staleLines.push(`- **${p.name.slice(0, 60)}** — seit ${ageDays} Tagen keine Aktivität`);
              }
            }

            // Top overdue / unscheduled open items across all active projects
            const overdueOrUnscheduled = openItems
              .filter(it => !it.dueAt || new Date(it.dueAt).getTime() < now)
              .sort((a, b) => (a.priority === 'high' ? 0 : 2) - (b.priority === 'high' ? 0 : 2))
              .slice(0, 5);
            const itemLines: string[] = [];
            if (overdueOrUnscheduled.length > 0) {
              const projectNames = new Map(projects.map(p => [p.id, p.name]));
              for (const it of overdueOrUnscheduled) {
                const icon = it.priority === 'high' ? '🔴' : it.priority === 'low' ? '⚪' : '🟡';
                const pname = projectNames.get(it.projectId)?.slice(0, 30) ?? '?';
                itemLines.push(`${icon} ${it.title.slice(0, 80)} [${pname}]`);
              }
            }

            const parts: string[] = [`Aktive Projekte (${projects.length}):`, ...lines];
            if (staleLines.length > 0) {
              parts.push('', '**Stale (>30d inaktiv):**', ...staleLines);
            }
            if (itemLines.length > 0) {
              parts.push('', 'Offene Punkte (überfällig oder ohne Datum):', ...itemLines);
            }
            parts.push('', 'Hinweis: Wenn das aktuelle Thema zu einem dieser Projekte passt, referenziere es im Insight. Stale-Projekte sind Kandidaten für Archivierung-Frage oder Follow-up.');
            const content = parts.join('\n');
            sections.push({
              key: 'projects', label: 'Aktive Projekte', priority: 2,
              content, tokenEstimate: Math.ceil(content.length / 3.5), changed: false,
            });
          }
        }
      } catch (err) {
        this.logger.debug({ err }, 'Active-projects section failed (non-critical)');
      }
    }

    // Change detection + error status annotation
    const changedSections: string[] = [];
    for (const section of sections) {
      const prev = this.previousContent.get(section.key);
      if (prev !== undefined && prev !== section.content) {
        section.changed = true;
        changedSections.push(section.key);
      }
      this.previousContent.set(section.key, section.content);

      // Annotate transient vs persistent errors so the LLM doesn't overreact
      const isError = section.content.startsWith('(') && (
        section.content.includes('fehlgeschlagen') || section.content.includes('error') ||
        section.content.includes('timeout') || section.content.includes('nicht verfügbar')
      );
      const wasSuccessful = this.previousSuccess.get(section.key);
      if (isError && wasSuccessful === true) {
        section.content += '\n⚠️ TRANSIENTER FEHLER — beim letzten Lauf funktionierte diese Quelle. Wahrscheinlich vorübergehend, KEIN Handlungsbedarf empfehlen.';
      } else if (isError && wasSuccessful === false) {
        section.content += '\n🔴 PERSISTENTER FEHLER — bereits beim letzten Lauf fehlgeschlagen. Handlungsbedarf möglich.';
      }
      this.previousSuccess.set(section.key, !isError);
    }

    // Memory-enrichment: annotate sections whose topics the user marked as resolved
    this.annotateResolvedTopics(sections);

    // Fit to token budget
    const fitted = this.fitToBudget(sections, TOTAL_TOKEN_BUDGET);
    const totalTokens = fitted.reduce((sum, s) => sum + s.tokenEstimate, 0);

    return { dateTime, sections: fitted, changedSections, totalTokens };
  }

  // ── Source Definitions ──────────────────────────────────────

  private buildSourceDefs(now: Date): SourceDef[] {
    const defs: SourceDef[] = [];

    // ── Priority 1: Always available (DB queries) ─────────────
    defs.push(
      { key: 'calendar', label: 'Kalender (nächste 48h)', priority: 1, maxTokens: 400, fetch: () => this.fetchCalendar(now) },
      { key: 'todos', label: 'Offene Todos', priority: 1, maxTokens: 300, fetch: () => this.fetchTodos() },
      { key: 'watches', label: 'Aktive Watches', priority: 1, maxTokens: 300, fetch: () => this.fetchWatches() },
      { key: 'memories', label: 'User-Erinnerungen', priority: 1, maxTokens: 1200, fetch: () => this.fetchMemories() },
    );

    // Aktive Workflows (für Dedup — LLM sieht welche Workflows existieren)
    if (this.workflowRepo) {
      defs.push({
        key: 'workflows', label: 'Aktive Workflows', priority: 2, maxTokens: 200,
        fetch: () => this.fetchWorkflows(),
      });
    }

    // ── Priority 2: Notes, Reminders, Documents ──────────────
    if (this.reminderRepo) {
      defs.push({
        key: 'reminders', label: 'Aktive Erinnerungen', priority: 2, maxTokens: 100,
        fetch: () => this.fetchReminders(),
      });
    }
    if (this.noteRepo) {
      defs.push({
        key: 'notes', label: 'Notizen', priority: 2, maxTokens: 200,
        fetch: () => this.fetchNotes(),
      });
    }
    if (this.documentRepo) {
      defs.push({
        key: 'documents', label: 'Dokumente', priority: 3, maxTokens: 150,
        fetch: () => this.fetchDocuments(),
      });
    }

    // ── Priority 2: Skill-based (only if registered) ──────────
    // Weather with dynamic location resolution (from config → memories → skip)
    if (this.skillRegistry.has('weather')) {
      defs.push({
        key: 'weather', label: 'Wetter', priority: 2, maxTokens: 150,
        fetch: () => this.fetchWeather(),
      });
    }

    // Smart Home with domain filtering (from memories → default whitelist)
    if (this.skillRegistry.has('homeassistant')) {
      defs.push({
        key: 'smarthome', label: 'Smart Home', priority: 2, maxTokens: 400,
        fetch: () => this.fetchSmartHome(),
      });
    }

    // BMW with extended timeout (token refresh can take up to 15s + API call)
    if (this.planningAgent) {
      defs.push({
        key: 'plans', label: 'Aktive Pläne', priority: 1, maxTokens: 200,
        fetch: async () => {
          const uid = this.resolvedUserId ?? '';
          const summary = await this.planningAgent!.getContextSummary(uid);
          return summary || '(keine aktiven Pläne)';
        },
      });
    }

    if (this.skillRegistry.has('bmw')) {
      defs.push({
        key: 'bmw', label: 'BMW Status', priority: 2, maxTokens: 200,
        fetch: () => this.fetchBmwFromDb(),
      });
    }

    if (this.skillRegistry.has('mikrotik')) {
      defs.push({
        key: 'mikrotik', label: 'MikroTik Router', priority: 2, maxTokens: 200,
        fetch: async () => {
          const skill = this.skillRegistry.get('mikrotik') as any;
          if (skill?.buildReasoningContext) return skill.buildReasoningContext();
          return '(MikroTik: keine Daten)';
        },
      });
    }

    if (this.skillRegistry.has('commvault')) {
      defs.push({
        key: 'commvault', label: 'Commvault Backup', priority: 2, maxTokens: 200,
        fetch: async () => {
          const skill = this.skillRegistry.get('commvault') as any;
          if (skill?.buildReasoningContext) return skill.buildReasoningContext();
          return '(Commvault: keine Daten)';
        },
      });
    }

    // Email with dedicated reasoning formatter (15 emails, all with preview, token-efficient)
    if (this.skillRegistry.has('email')) {
      defs.push({
        key: 'email', label: 'E-Mail Inbox', priority: 2, maxTokens: 500,
        fetch: () => this.fetchEmailForReasoning(),
      });
    }

    const p2: Array<{ key: string; label: string; skill: string; input: Record<string, unknown>; maxTokens: number }> = [
      { key: 'energy', label: 'Energiepreise', skill: 'energy_price', input: { action: 'current' }, maxTokens: 150 },
      { key: 'charger', label: 'Wallbox', skill: 'goe_charger', input: { action: 'status' }, maxTokens: 100 },
      { key: 'mstodo', label: 'Microsoft To Do', skill: 'microsoft_todo', input: { action: 'list_tasks' }, maxTokens: 200 },
      { key: 'crypto', label: 'Crypto/Bitpanda', skill: 'bitpanda', input: { action: 'portfolio' }, maxTokens: 150 },
    ];
    for (const src of p2) {
      if (this.skillRegistry.has(src.skill)) {
        defs.push({
          key: src.key, label: src.label, priority: 2, maxTokens: src.maxTokens,
          fetch: () => this.fetchSkillData(src.skill, src.input),
        });
      }
    }

    // ── Priority 2: Temporal trends (from TemporalAnalyzer memories) ──
    defs.push({
      key: 'trends', label: 'Trends & Anomalien (4 Wochen)', priority: 2, maxTokens: 250,
      fetch: () => this.fetchTemporalInsights(),
    });

    // ── Priority 2: User feedback on actions + insights ───────
    defs.push({
      key: 'action_feedback', label: 'User-Feedback (Aktionen & Insights)', priority: 2, maxTokens: 200,
      fetch: () => this.fetchActionFeedback(),
    });

    // ── Priority 3: Nice-to-have ──────────────────────────────
    defs.push(
      { key: 'activity', label: 'Aktivität 24h', priority: 3, maxTokens: 150, fetch: () => this.fetchActivity() },
      { key: 'skillHealth', label: 'Skill-Status', priority: 3, maxTokens: 100, fetch: () => this.fetchSkillHealth() },
      { key: 'feedback', label: 'Nutzer-Feedback', priority: 3, maxTokens: 100, fetch: () => this.fetchFeedback() },
    );

    // Insight tracking: delivered insights + resolved status (for follow-up reasoning)
    defs.push({
      key: 'insightTracking', label: 'Insight-Tracking', priority: 1, maxTokens: 150,
      fetch: () => this.fetchInsightTracking(),
    });

    // RSS Feeds with extended timeout (check_all fetches multiple external servers)
    if (this.skillRegistry.has('feed_reader')) {
      defs.push({
        key: 'feeds', label: 'RSS Feeds (neue Artikel)', priority: 2, maxTokens: 400,
        fetch: () => this.fetchFeeds(),
      });
    }

    // Monitor/Infra with extended timeout (checks multiple services, can be slow)
    if (this.skillRegistry.has('monitor')) {
      defs.push({
        key: 'infra', label: 'Infrastruktur', priority: 3, maxTokens: 150,
        fetch: () => this.fetchWithTimeout('monitor', { action: 'status' }, 30_000),
      });
    }

    // CMDB summary (asset counts + open incidents with titles)
    if (this.skillRegistry.has('cmdb') || this.skillRegistry.has('itsm')) {
      defs.push({
        key: 'cmdb', label: 'CMDB / ITSM', priority: 2, maxTokens: 300,
        fetch: async () => {
          const parts: string[] = [];
          try {
            if (this.skillRegistry.has('cmdb')) {
              const statsResult = await this.fetchWithTimeout('cmdb', { action: 'stats' }, 10_000);
              if (statsResult) parts.push(statsResult);
            }
          } catch { /* skip */ }
          try {
            if (this.skillRegistry.has('itsm')) {
              const dashResult = await this.fetchWithTimeout('itsm', { action: 'dashboard' }, 10_000);
              if (dashResult) parts.push(dashResult);
              // Include active + recently resolved incidents so LLM can update/avoid duplicates
              const skill = this.skillRegistry.get('itsm');
              if (skill) {
                // v653 — bauen Skill-Context einmal mit echter masterUserId. Vorher 4× `{} as any`,
                // wodurch `userId = context.masterUserId || context.userId` undefined wurde und
                // alle Listen leer blieben → LLM halluzinierte Incident-IDs.
                const { context: itsmCtx } = await buildSkillContext(this.userRepo, {
                  userId: this.defaultChatId, platform: this.defaultPlatform, chatId: this.defaultChatId, chatType: 'dm',
                });
                {
                  // Single fetch: all incidents, then filter by status in code
                  const allRaw = await this.skillSandbox.execute(skill, { action: 'list_incidents' }, itsmCtx);
                  if (allRaw.success && Array.isArray(allRaw.data)) {
                    const allInc = allRaw.data as Array<{ id: string; title: string; severity: string; status: string; rootCause?: string; resolvedAt?: string; createdAt?: string; resolution?: string }>;
                    const activeStatuses = new Set(['open', 'acknowledged', 'investigating', 'mitigating']);
                    const active = allInc.filter(i => activeStatuses.has(i.status));
                    const activeLines = active.slice(0, 15)
                      .map(i => {
                        let line = `- [${i.id.slice(0, 8)}] [${i.severity}] ${i.title} (${i.status})`;
                        if (i.rootCause) line += ` — RC: ${i.rootCause.slice(0, 60)}`;
                        return line;
                      }).join('\n');
                    if (activeLines) parts.push(`Aktive Incidents:\n${activeLines}`);

                    // Runbook-Match: for each active incident, find matching runbooks via
                    // keyword overlap on title/symptom. Surfaces past solutions for current
                    // problems — closes the learning loop. Verified runbooks ranked higher.
                    if (this.runbookRepo && active.length > 0) {
                      try {
                        const uid = await this.getEffectiveUserId();
                        if (uid) {
                          const matchLines: string[] = [];
                          for (const inc of active.slice(0, 8)) {
                            const rbs = await this.runbookRepo.findMatching(uid, inc.title, 2);
                            for (const rb of rbs) {
                              const status = rb.status === 'verified' ? '✓' : '·';
                              matchLines.push(`- [${inc.id.slice(0, 8)}] ${inc.title.slice(0, 45)} → ${status} Runbook [${rb.id.slice(0, 8)}] ${rb.title.slice(0, 50)} (${rb.usageCount}× verwendet)`);
                            }
                          }
                          if (matchLines.length > 0) {
                            parts.push(`Passende Runbooks für aktive Incidents (frühere Lösungen):\n${matchLines.slice(0, 10).join('\n')}`);
                          }
                        }
                      } catch { /* non-critical */ }
                    }

                    // Recently resolved (last 24h) so LLM doesn't re-create.
                    // Auto-resolved incidents get a distinct tag so the LLM can mention them proactively.
                    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
                    const recent = allInc
                      .filter(i => i.status === 'resolved' && i.resolvedAt && new Date(i.resolvedAt).getTime() > cutoff)
                      .slice(0, 5)
                      .map(i => {
                        const isAuto = i.resolution?.startsWith('🔄 Auto-resolved');
                        const tag = isAuto ? ' (🔄 auto-resolved)' : ' (resolved)';
                        return `- [${i.id.slice(0, 8)}] ${i.title}${tag}`;
                      });
                    if (recent.length > 0) parts.push(`Kürzlich gelöst (24h):\n${recent.join('\n')}`);

                    // Patch C: Recurrence-Stats — group incidents by title-prefix (until first
                    // digit/percent/colon-tail) and show recurring patterns. Lets the LLM see
                    // "git-server RAM usage: 8× in 12d (5 resolved, 3 open)" instead of just
                    // 1-3 individual incidents — enabling create_problem suggestions when 3+
                    // of the same kind exist anywhere in history.
                    const fourteenDaysAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
                    const recentInc = allInc.filter(i => {
                      const t = i.createdAt ? new Date(i.createdAt).getTime() : 0;
                      return t > fourteenDaysAgo && i.status !== 'cancelled';
                    });
                    const groups = new Map<string, { total: number; open: number; resolved: number; sample: string }>();
                    for (const i of recentInc) {
                      // Normalize title: strip percentages, numbers, IPs, IDs to find recurring pattern
                      const norm = i.title
                        .replace(/\d+(?:[.,]\d+)?%/g, '')        // 95.1%
                        .replace(/\b\d+\b/g, '')                  // pure numbers
                        .replace(/\s+/g, ' ')
                        .trim()
                        .toLowerCase();
                      const g = groups.get(norm) ?? { total: 0, open: 0, resolved: 0, sample: i.title };
                      g.total++;
                      if (activeStatuses.has(i.status)) g.open++;
                      if (i.status === 'resolved' || i.status === 'closed') g.resolved++;
                      groups.set(norm, g);
                    }
                    const recurring = [...groups.values()]
                      .filter(g => g.total >= 3)
                      .sort((a, b) => b.total - a.total)
                      .slice(0, 5)
                      .map(g => `- ${g.sample.slice(0, 80)}: ${g.total}× in 14d (${g.open} offen, ${g.resolved} gelöst) → Problem-Kandidat`);
                    if (recurring.length > 0) parts.push(`Wiederkehrende Incident-Muster (Problem-Kandidaten):\n${recurring.join('\n')}`);
                  }
                }
                {
                  // Also include pending Change Requests
                  const crRaw = await this.skillSandbox.execute(skill, { action: 'list_changes', status: 'draft' }, itsmCtx);
                  if (crRaw.success && Array.isArray(crRaw.data)) {
                    const pending = (crRaw.data as Array<{ id: string; title: string; type: string; status: string }>)
                      .slice(0, 5)
                      .map(c => `- [${c.id.slice(0, 8)}] ${c.title} (${c.type}, ${c.status})`);
                    if (pending.length > 0) parts.push(`Offene Changes:\n${pending.join('\n')}`);
                  }
                }

                // Active problems + known errors
                {
                  const probRaw = await this.skillSandbox.execute(skill, { action: 'list_problems' }, itsmCtx);
                  if (probRaw.success && Array.isArray(probRaw.data)) {
                    const activeProbs = (probRaw.data as any[]).filter((p: any) => !['resolved', 'closed'].includes(p.status));
                    const probLines = activeProbs.slice(0, 10).map((p: any) => {
                      let line = `- [${p.id.slice(0, 8)}] [${p.priority}] ${p.title} (${p.status})`;
                      if (p.isKnownError) line += ' [KNOWN ERROR]';
                      if (p.workaround) line += ` — WA: ${String(p.workaround).slice(0, 60)}`;
                      if (p.linkedIncidentIds?.length > 0) line += ` — ${p.linkedIncidentIds.length} Inc`;
                      return line;
                    }).join('\n');
                    if (probLines) parts.push(`Aktive Probleme:\n${probLines}`);
                  }
                }

                // SLA Breaches
                {
                  const slaRaw = await this.skillSandbox.execute(skill, { action: 'check_sla_compliance' }, itsmCtx);
                  if (slaRaw.success && Array.isArray(slaRaw.data)) {
                    const breaches = (slaRaw.data as any[]).filter((r: any) => !r.compliant);
                    if (breaches.length > 0) {
                      const slaLines = breaches.map((r: any) => `- ❌ ${r.name}: ${r.actual?.toFixed(3)}% (Ziel: ${r.target}%)`).join('\n');
                      parts.push(`SLA-Verletzungen:\n${slaLines}`);
                    }
                  }
                }
              }
            }
          } catch { /* skip */ }
          return parts.join('\n') || '';
        },
      });
    }

    const p3Skills: Array<{ key: string; label: string; skill: string; input: Record<string, unknown>; maxTokens: number }> = [
      { key: 'mealPlan', label: 'Meal-Plan heute', skill: 'recipe', input: { action: 'meal_plan', sub_action: 'get', week: 'current', day: new Date().toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase() }, maxTokens: 100 },
      { key: 'travel', label: 'Anstehende Reisen', skill: 'travel', input: { action: 'plan_list', status: 'booked' }, maxTokens: 100 },
    ];
    for (const src of p3Skills) {
      if (this.skillRegistry.has(src.skill)) {
        defs.push({
          key: src.key, label: src.label, priority: 3, maxTokens: src.maxTokens,
          fetch: () => this.fetchSkillData(src.skill, src.input),
        });
      }
    }

    return defs;
  }

  // ── Token Budget Management ─────────────────────────────────

  private fitToBudget(sections: ReasoningSection[], maxTokens: number): ReasoningSection[] {
    // Sort: priority ASC, then changed first, then by tokenEstimate ASC
    const sorted = [...sections].sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      if (a.changed !== b.changed) return a.changed ? -1 : 1;
      return a.tokenEstimate - b.tokenEstimate;
    });

    const result: ReasoningSection[] = [];
    let remaining = maxTokens;
    const dropped: string[] = [];
    const budgetTruncated: string[] = [];

    for (const section of sorted) {
      if (remaining <= 0) {
        dropped.push(`${section.key}:${section.tokenEstimate}`);
        continue;
      }

      if (section.tokenEstimate <= remaining) {
        result.push(section);
        remaining -= section.tokenEstimate;
      } else if (section.priority <= 2) {
        // Priority 1+2: truncate rather than drop (factor 3.5 consistent with tokenEstimate)
        const maxChars = Math.floor(remaining * 3.5);
        const truncated = section.content.slice(0, maxChars) + '\n...(gekürzt)';
        result.push({
          ...section,
          content: truncated,
          tokenEstimate: Math.ceil(truncated.length / 3.5),
        });
        budgetTruncated.push(`${section.key}:${section.tokenEstimate}→${remaining}`);
        remaining = 0;
      } else {
        dropped.push(`${section.key}:${section.tokenEstimate}`);
      }
    }

    // Log final context composition + what was dropped
    this.logger?.info({
      component: 'reasoning-collector',
      sections: result.map(s => `${s.key}:${s.tokenEstimate}`).join(', '),
      totalTokens: maxTokens - remaining, budget: maxTokens,
      dropped: dropped.length > 0 ? dropped.join(', ') : undefined,
      budgetTruncated: budgetTruncated.length > 0 ? budgetTruncated.join(', ') : undefined,
    }, 'Context sections assembled');

    return result;
  }

  // ── Data Fetchers ───────────────────────────────────────────

  private async fetchCalendar(now: Date): Promise<string> {
    if (!this.calendarProvider) return '(Kalender nicht konfiguriert)';
    try {
      const start = now;
      const end = new Date(now.getTime() + 48 * 60 * 60 * 1000); // 48h window
      const events = await this.calendarProvider.listEvents(start, end);
      if (events.length === 0) return 'Keine Termine in den nächsten 48h.';
      return events.map(e => {
        const time = e.start instanceof Date
          ? e.start.toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' })
          : String(e.start);
        const day = e.start instanceof Date
          ? e.start.toLocaleDateString('de-AT', { weekday: 'short', day: '2-digit', month: '2-digit' })
          : '';
        const loc = e.location ? ` (${e.location})` : '';
        return `- ${day} ${time}: ${e.title ?? 'Termin'}${loc}`;
      }).join('\n');
    } catch (err) {
      this.logger.warn({ err }, 'ReasoningCollector: calendar fetch failed');
      return '(Kalender-Abfrage fehlgeschlagen)';
    }
  }

  private async fetchTodos(): Promise<string> {
    try {
      const overdue = await this.todoRepo.getOverdue();
      const windowEnd = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const upcoming = await this.todoRepo.getDueInWindow(windowEnd);
      const allOpen = await this.todoRepo.list(this.resolvedUserId!);

      const lines: string[] = [];
      if (overdue.length > 0) {
        lines.push(`Überfällig (${overdue.length}):`);
        for (const t of overdue.slice(0, 10)) {
          lines.push(`  - [${t.priority}] ${t.title} (fällig: ${t.dueDate})`);
        }
      }
      if (upcoming.length > 0) {
        lines.push(`Bald fällig (${upcoming.length}):`);
        for (const t of upcoming.slice(0, 10)) {
          lines.push(`  - [${t.priority}] ${t.title} (fällig: ${t.dueDate})`);
        }
      }
      if (allOpen.length > 0) {
        lines.push(`Gesamt offene Todos: ${allOpen.length}`);
      }
      return lines.length > 0 ? lines.join('\n') : 'Keine offenen Todos.';
    } catch (err) {
      this.logger.warn({ err }, 'ReasoningCollector: todo fetch failed');
      return '(Todo-Abfrage fehlgeschlagen)';
    }
  }

  private async fetchWatches(): Promise<string> {
    try {
      const watches = await this.watchRepo.getEnabled();
      if (watches.length === 0) return 'Keine aktiven Watches.';
      return watches.map(w => {
        const lastVal = w.lastValue
          ? (() => { try { const p = JSON.parse(w.lastValue!); return typeof p === 'object' ? JSON.stringify(p).slice(0, 200) : String(p); } catch { return w.lastValue!.slice(0, 200); } })()
          : 'noch kein Ergebnis';
        const lastTrigger = w.lastTriggeredAt
          ? `letzter Alert: ${new Date(w.lastTriggeredAt).toLocaleString('de-AT')}`
          : 'noch nie ausgelöst';
        return `- "${w.name}" (${w.skillName}, alle ${w.intervalMinutes} Min) → ${lastTrigger}\n  Letzter Wert: ${lastVal}`;
      }).join('\n');
    } catch (err) {
      this.logger.warn({ err }, 'ReasoningCollector: watch fetch failed');
      return '(Watch-Abfrage fehlgeschlagen)';
    }
  }

  /**
   * Cross-reference "resolved" memories against section content.
   * If a section mentions a topic the user has explicitly marked as resolved/erledigt,
   * annotate that section so the LLM doesn't re-surface it as an open issue.
   */
  private annotateResolvedTopics(sections: ReasoningSection[]): void {
    // Collect resolved topic words from TWO sources:
    // 1. Memory entries containing "erledigt/resolved/..." keywords
    // 2. insight_resolved:* entries from the Insight-Tracking system (set when user acknowledges)
    const resolvedTopicSets: Array<{ topicWords: string[]; label: string }> = [];

    // Source 1: Memory keywords
    const memorySection = sections.find(s => s.key === 'memories');
    if (memorySection) {
      const resolvedPattern = /erledigt|resolved|überholt|kein.{0,20}handlungsbedarf|nicht mehr.{0,20}problem|abgeschlossen|geklärt|bereits gesagt/i;
      for (const line of memorySection.content.split('\n')) {
        if (resolvedPattern.test(line)) {
          const keyMatch = line.match(/\]\s*([^:]+):/);
          if (keyMatch) {
            const topicWords = keyMatch[1].trim().split('_').filter(w => w.length >= 4).map(w => w.toLowerCase());
            if (topicWords.length > 0) {
              resolvedTopicSets.push({ topicWords, label: line.replace(/^-\s*\[.*?\]\s*/, '').slice(0, 150) });
            }
          }
        }
      }
    }

    // Source 2: [correction] type memories — user explicitly corrected Alfred
    if (memorySection) {
      for (const line of memorySection.content.split('\n')) {
        if (/\[correction\]/i.test(line)) {
          // Extract topic words from both key AND value
          const keyMatch = line.match(/\]\s*([^:]+):/);
          const valueText = line.replace(/^-\s*\[.*?\]\s*[^:]+:\s*/, '');
          const topicWords = [
            ...(keyMatch ? keyMatch[1].trim().split('_') : []),
            ...valueText.toLowerCase().replace(/[^a-zäöüß0-9\s]/g, ' ').split(/\s+/),
          ].filter(w => w.length >= 4).map(w => w.toLowerCase());
          const unique = [...new Set(topicWords)].slice(0, 8);
          if (unique.length > 0) {
            resolvedTopicSets.push({ topicWords: unique, label: `KORREKTUR: ${valueText.slice(0, 150)}` });
          }
        }
      }
    }

    // Source 3: insight_resolved entries from Insight-Tracking section
    const trackingSection = sections.find(s => s.key === 'insightTracking');
    if (trackingSection) {
      for (const line of trackingSection.content.split('\n')) {
        if (/BESTÄTIGT|resolved/i.test(line)) {
          const textMatch = line.match(/:\s*(.+)$/);
          if (textMatch) {
            const topicWords = textMatch[1].toLowerCase()
              .replace(/[^a-zäöüß0-9\s]/g, ' ')
              .split(/\s+/)
              .filter(w => w.length >= 4)
              .slice(0, 5);
            if (topicWords.length > 0) {
              resolvedTopicSets.push({ topicWords, label: textMatch[1].slice(0, 150) });
            }
          }
        }
      }
    }

    if (resolvedTopicSets.length === 0) return;

    // Annotate matching sections
    for (const resolved of resolvedTopicSets) {
      for (const section of sections) {
        if (section.key === 'memories' || section.key === 'insightTracking') continue;
        const contentLower = section.content.toLowerCase();
        const matches = resolved.topicWords.filter(w => contentLower.includes(w));
        if (matches.length >= 2 || (matches.length === 1 && resolved.topicWords.length === 1)) {
          section.content += `\n\n✅ ERLEDIGT: "${resolved.label}" — NICHT als offenes Problem oder Handlungsbedarf darstellen.`;
        }
      }
    }
  }

  // ── Context-Aware Memory Retrieval ────────────────────────

  private static readonly STOP_WORDS = new Set([
    'eine', 'einer', 'eines', 'einem', 'einen', 'dass', 'dies', 'diese', 'dieser',
    'dieses', 'sind', 'wird', 'wurde', 'werden', 'haben', 'hatte', 'sein', 'seine',
    'kann', 'nach', 'noch', 'auch', 'oder', 'aber', 'wenn', 'dann', 'nicht', 'kein',
    'keine', 'keinen', 'mehr', 'alle', 'anderen', 'andere', 'anderer', 'anderes',
    'the', 'and', 'for', 'with', 'from', 'that', 'this', 'have', 'has', 'was', 'were',
    'info', 'status', 'data', 'error', 'true', 'false', 'null', 'none', 'undefined',
    'aktuell', 'heute', 'morgen', 'gestern', 'gerade', 'bereits', 'etwa', 'circa',
    'letzte', 'letzten', 'nächste', 'nächsten', 'keine', 'kein', 'nicht',
  ]);

  /** Extract top-N keywords from collected sections for context-aware memory retrieval. */
  private extractContextKeywords(sections: ReasoningSection[]): string[] {
    const wordCounts = new Map<string, number>();
    for (const section of sections) {
      const words = section.content.toLowerCase()
        .replace(/[^a-zäöüß0-9\s_-]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length >= 4 && !ReasoningContextCollector.STOP_WORDS.has(w));
      for (const word of words) {
        wordCounts.set(word, (wordCounts.get(word) ?? 0) + 1);
      }
    }
    return [...wordCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([word]) => word);
  }

  /** Fetch memories with context-awareness: guaranteed corrections/patterns + context-matched + recent fill. */
  private async fetchMemoriesContextAware(contextKeywords: string[]): Promise<string> {
    try {
      const userId = this.resolvedUserId!;
      const all = new Map<string, any>();

      // 1. ALWAYS: Corrections (up to 10) — user rules, MUST be in context
      try {
        for (const m of await this.memoryRepo.getByType(userId, 'correction', 10)) all.set(m.key, m);
      } catch { /* skip */ }

      // 2. ALWAYS: Preferences (up to 5) — user preferences
      try {
        for (const m of await this.memoryRepo.getByType(userId, 'preference', 5)) {
          if (!all.has(m.key)) all.set(m.key, m);
        }
      } catch { /* skip */ }

      // 3. ALWAYS: Patterns (up to 5) — behavioral context
      try {
        for (const m of await this.memoryRepo.getByType(userId, 'pattern', 5)) {
          if (!all.has(m.key)) all.set(m.key, m);
        }
      } catch { /* skip */ }

      // 4. CONTEXT-MATCH: Search memories matching current context keywords
      if (contextKeywords.length > 0) {
        try {
          const searchQuery = contextKeywords.slice(0, 5).join(' ');
          const matched = await this.memoryRepo.search(userId, searchQuery);
          for (const m of matched) {
            if (all.size >= 25) break;
            if (!all.has(m.key)) all.set(m.key, m);
          }
        } catch { /* skip */ }
      }

      // 5. FILL remaining with highest-confidence most-recent memories
      const MAX = 25;
      if (all.size < MAX) {
        try {
          const recent = await this.memoryRepo.getRecentForPrompt(userId, MAX - all.size + 5);
          for (const m of recent) {
            if (all.size >= MAX) break;
            if (!all.has(m.key)) all.set(m.key, m);
          }
        } catch { /* skip */ }
      }

      if (all.size === 0) return 'Keine gespeicherten Erinnerungen.';
      return [...all.values()].map((m: any) => formatMemoryLine(m)).join('\n');
    } catch (err) {
      this.logger.warn({ err }, 'ReasoningCollector: context-aware memory fetch failed');
      return '(Memory-Abfrage fehlgeschlagen)';
    }
  }

  /** Legacy fetch (used if context-aware not triggered). */
  private async fetchMemories(): Promise<string> {
    try {
      const userId = this.resolvedUserId!;
      const all = new Map<string, any>();

      // 1. CORRECTIONS — user corrections, MUST be in context (up to 10)
      try {
        for (const m of await this.memoryRepo.getByType(userId, 'correction', 10)) {
          all.set(m.key, m);
        }
      } catch { /* skip */ }

      // 2. PREFERENCES — user rules (up to 5)
      try {
        for (const m of await this.memoryRepo.getByType(userId, 'preference', 5)) {
          if (!all.has(m.key)) all.set(m.key, m);
        }
      } catch { /* skip */ }

      // 3. PATTERNS — behavioral context (up to 5)
      try {
        for (const m of await this.memoryRepo.getByType(userId, 'pattern', 5)) {
          if (!all.has(m.key)) all.set(m.key, m);
        }
      } catch { /* skip */ }

      // 4. CONNECTIONS — cross-domain links (up to 3)
      try {
        for (const m of await this.memoryRepo.getByType(userId, 'connection', 3)) {
          if (!all.has(m.key)) all.set(m.key, m);
        }
      } catch { /* skip */ }

      // 5. FILL remaining slots with highest-confidence most-recent memories of any type
      const MAX = 25;
      const remaining = MAX - all.size;
      if (remaining > 0) {
        try {
          const recent = await this.memoryRepo.getRecentForPrompt(userId, remaining + 10);
          for (const m of recent) {
            if (all.size >= MAX) break;
            if (!all.has(m.key)) all.set(m.key, m);
          }
        } catch { /* skip */ }
      }

      if (all.size === 0) return 'Keine gespeicherten Erinnerungen.';
      return [...all.values()].map(m => formatMemoryLine(m)).join('\n');
    } catch (err) {
      this.logger.warn({ err }, 'ReasoningCollector: memory fetch failed');
      return '(Memory-Abfrage fehlgeschlagen)';
    }
  }

  /** Read BMW telematic data directly from DB — zero REST API calls. */
  private async fetchBmwFromDb(): Promise<string> {
    if (!this.bmwTelematicRepo) {
      return this.fetchWithTimeout('bmw', { action: 'status' }, 20_000); // fallback to skill call
    }
    try {
      const uid = await this.getEffectiveUserId();
      // Get latest MQTT and REST snapshots
      const mqtt = await this.bmwTelematicRepo.getLatestAnyVinBySource(uid, 'mqtt');
      const rest = await this.bmwTelematicRepo.getLatestAnyVinBySource(uid, 'rest');

      if (!mqtt && !rest) return '(Keine BMW-Daten in DB)';

      // Merge: MQTT wins for shared fields
      const merged: Record<string, { value: string; unit?: string }> = {};
      if (rest) for (const [k, v] of Object.entries(rest.telematicData)) merged[k] = v as any;
      if (mqtt) for (const [k, v] of Object.entries(mqtt.telematicData)) merged[k] = v as any;

      const tv = (key: string, ...alts: string[]): string => {
        for (const k of [key, ...alts]) if (merged[k]?.value) return merged[k].value;
        return '?';
      };

      const soc = tv('vehicle.drivetrain.batteryManagement.header', 'vehicle.powertrain.electric.battery.stateOfCharge.displayed');
      const range = tv('vehicle.drivetrain.electricEngine.remainingElectricRange', 'vehicle.drivetrain.lastRemainingRange');
      const km = tv('vehicle.vehicle.travelledDistance');
      const lockedRaw = tv('vehicle.access.centralLocking.isLocked', 'vehicle.cabin.door.status');
      const locked = lockedRaw === 'true' || lockedRaw === 'LOCKED' || lockedRaw === 'SECURED' ? 'Ja' : lockedRaw === 'UNLOCKED' || lockedRaw === 'false' ? 'Nein' : '?';

      const newestAt = mqtt?.createdAt ?? rest?.createdAt;
      const dataAge = newestAt ? Math.round((Date.now() - new Date(newestAt).getTime()) / 60_000) : 999;

      // If data is very old (>6h) and no MQTT/REST update, do ONE REST refresh via skill
      if (dataAge > 360 && Object.keys(merged).length > 0) {
        try {
          const fresh = await this.fetchWithTimeout('bmw', { action: 'status' }, 20_000);
          if (fresh && !fresh.startsWith('(') && !fresh.includes('rate limit')) return fresh;
        } catch { /* rate limited or error — use stale data */ }
      }

      const lines = [
        `**Ladestand (SoC):** ${soc} %`,
        `**Reichweite:** ${range} km`,
        `**Kilometerstand:** ${km} km`,
        `**Verriegelt:** ${locked}`,
      ];
      if (dataAge > 60) lines.push(`⚠️ Daten ${dataAge} Min alt`);

      return lines.filter(l => !l.includes('?')).join('\n') || '(Keine verwertbaren BMW-Daten)';
    } catch (err) {
      this.logger.debug({ err }, 'BMW DB fetch failed');
      return '(BMW DB-Abfrage fehlgeschlagen)';
    }
  }

  private async fetchReminders(): Promise<string> {
    try {
      const uid = await this.getEffectiveUserId();
      const lines: string[] = [];

      // Active (unfired) reminders due within 24h
      const pending = await this.reminderRepo!.getAllPending();
      const cutoff = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
      const relevant = pending
        .filter(r => r.userId === uid || r.chatId === this.defaultChatId)
        .filter(r => r.triggerAt <= cutoff)
        .slice(0, 10);
      for (const r of relevant) {
        const due = new Date(r.triggerAt);
        const overdue = due.getTime() < Date.now();
        lines.push(`- [${r.id.slice(0, 8)}] ${overdue ? '⚠️ ÜBERFÄLLIG' : due.toLocaleString('de-AT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}: ${r.message}`);
      }

      // Recently fired reminders (last 24h) — so LLM knows the topic was already handled
      try {
        const recentCutoff = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
        const fired = await (this.reminderRepo as any).adapter?.query?.(
          "SELECT id, message, trigger_at FROM reminders WHERE fired = 1 AND trigger_at > ? AND (user_id = ? OR chat_id = ?) ORDER BY trigger_at DESC LIMIT 10",
          [recentCutoff, uid, this.defaultChatId],
        ) as Array<{ message: string; trigger_at: string }> | undefined;
        if (fired?.length) {
          for (const r of fired) {
            const time = new Date(r.trigger_at).toLocaleString('de-AT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: this.userTimezone });
            lines.push(`- [${(r as any).id?.slice(0, 8) ?? '?'}] ✅ BEREITS ERINNERT (${time}): ${r.message.slice(0, 80)}`);
          }
        }
      } catch { /* non-critical */ }

      return lines.length > 0 ? lines.join('\n') : 'Keine aktiven Erinnerungen.';
    } catch { return '(Erinnerungen nicht verfügbar)'; }
  }

  private async fetchNotes(): Promise<string> {
    try {
      const uid = await this.getEffectiveUserId();
      const notes = await this.noteRepo!.list(uid, 10);
      if (notes.length === 0) return 'Keine Notizen.';
      return notes.map(n => {
        const preview = n.content.slice(0, 100).replace(/\n/g, ' ');
        return `- [${n.updatedAt.slice(0, 10)}] **${n.title}**: ${preview}${n.content.length > 100 ? '...' : ''}`;
      }).join('\n');
    } catch { return '(Notizen nicht verfügbar)'; }
  }

  private async fetchDocuments(): Promise<string> {
    try {
      const uid = await this.getEffectiveUserId();
      const docs = await this.documentRepo!.listAccessible(uid);
      if (docs.length === 0) return 'Keine Dokumente.';
      return docs.slice(0, 15).map(d => {
        const sizeKb = Math.round(d.sizeBytes / 1024);
        return `- ${d.filename} (${sizeKb} KB, ${d.chunkCount} Seiten, ${d.createdAt.slice(0, 10)})`;
      }).join('\n');
    } catch { return '(Dokumente nicht verfügbar)'; }
  }

  private async fetchActivity(): Promise<string> {
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const stats = await this.activityRepo.stats(since);
      if (stats.length === 0) return 'Keine Aktivität in den letzten 24h.';
      return stats.map(s => `- ${s.eventType} (${s.outcome}): ${s.count}×`).join('\n');
    } catch (err) {
      this.logger.warn({ err }, 'ReasoningCollector: activity fetch failed');
      return '(Aktivitäts-Abfrage fehlgeschlagen)';
    }
  }

  private async fetchSkillHealth(): Promise<string> {
    try {
      const disabled = await this.skillHealthRepo.getDisabled();
      if (disabled.length === 0) return 'Alle Skills aktiv.';
      return disabled.map(s =>
        `- ${s.skillName}: deaktiviert bis ${s.disabledUntil} (${s.consecutiveFails} Fehler: ${s.lastError ?? '?'})`,
      ).join('\n');
    } catch (err) {
      this.logger.warn({ err }, 'ReasoningCollector: skill health fetch failed');
      return '(Skill-Health-Abfrage fehlgeschlagen)';
    }
  }

  private async fetchFeedback(): Promise<string> {
    if (!this.feedbackRepo) return '';
    try {
      const events = await this.feedbackRepo.getRecentEvents(this.defaultChatId, 20);
      if (events.length === 0) return 'Kein Feedback zu Watches oder Korrekturen.';
      return events.map(e =>
        `- [${e.feedbackType}] ${e.description} (${e.occurredAt.slice(0, 10)})`,
      ).join('\n');
    } catch (err) {
      this.logger.warn({ err }, 'ReasoningCollector: feedback fetch failed');
      return '';
    }
  }

  private async fetchInsightTracking(): Promise<string> {
    if (!this.memoryRepo) return '';
    try {
      const userId = await this.getEffectiveUserId();
      if (!userId) return '';

      const cutoff48h = new Date(Date.now() - 48 * 60 * 60_000).toISOString();
      const lines: string[] = [];

      // Fetch delivered insights (last 48h) — filter by key prefix to avoid false positives
      const deliveredRaw = await this.memoryRepo.search(userId, 'insight_delivered');
      const delivered = deliveredRaw.filter(m => m.key.startsWith('insight_delivered:'));
      const recent = delivered.filter(m => m.updatedAt > cutoff48h);
      if (recent.length === 0) return '';

      // Fetch resolved insights — filter by key prefix
      const resolvedRaw = await this.memoryRepo.search(userId, 'insight_resolved');
      const resolved = resolvedRaw.filter(m => m.key.startsWith('insight_resolved:'));
      const resolvedTopics = new Set(resolved.map(m => m.key.replace('insight_resolved:', '')));

      for (const m of recent.slice(0, 5)) {
        const topic = m.key.replace('insight_delivered:', '');
        const ageH = Math.round((Date.now() - new Date(m.updatedAt).getTime()) / 3600_000);
        const isResolved = resolvedTopics.has(topic);
        const resolvedMem = isResolved ? resolved.find(r => r.key === `insight_resolved:${topic}`) : undefined;
        const status = isResolved
          ? `BESTÄTIGT (${resolvedMem?.value?.slice(0, 50) ?? 'ok'})`
          : 'OFFEN';
        lines.push(`- [vor ${ageH}h] ${status}: ${m.value.slice(0, 80)}`);
      }

      if (lines.length === 0) return '';
      return `Gesendete Insights (letzte 48h):\n${lines.join('\n')}\nHinweis: OFFENE Insights >24h können Follow-up-Erinnerungen auslösen (nur bei handlungsrelevanten Themen, NICHT bei Status/Wetter/Preisen).`;
    } catch {
      return '';
    }
  }

  private async fetchSmartHome(): Promise<string> {
    // ADDITIVE system: Default-Domains + User-Domains + User-Entities — all combined
    const DEFAULT_DOMAINS = ['light', 'person', 'input_boolean', 'climate'];

    // binary_sensor needs special filtering (only door/window/motion/occupancy/smoke/plug)
    const BINARY_SENSOR_FILTER = /door|window|motion|occupancy|smoke|plug/i;

    const parts: string[] = [];

    // 1. Default domains (always loaded)
    await this.fetchSmartHomeByDomains(DEFAULT_DOMAINS, parts);

    // 2. binary_sensor filtered by device_class (door, motion, smoke, plug — not the 74 "none" and 57 "problem")
    try {
      const result = await this.fetchSkillData('homeassistant', { action: 'states', domain: 'binary_sensor' });
      if (result && !result.startsWith('(')) {
        const lines = result.split('\n').filter(l => {
          if (!l.startsWith('|') || l.startsWith('|---') || l.includes('Entity ID')) return false;
          // Only include lines where name suggests door/window/motion/smoke/plug
          return BINARY_SENSOR_FILTER.test(l);
        });
        if (lines.length > 0) {
          parts.push(`binary_sensor (${lines.length} gefiltert):`);
          for (const line of lines.slice(0, 20)) parts.push(line);
        }
      }
    } catch { /* skip */ }

    // 3. User-configured additional domains (ADDITIVE, from memory "briefing_ha_domains")
    try {
      const mems = await this.memoryRepo.search(this.resolvedUserId!, 'ha_domain');
      const domainMem = mems.find(m => /ha_domain|home.?assistant.*domain|briefing.*domain/i.test(m.key));
      if (domainMem) {
        const userDomains = domainMem.value.split(/[,;]\s*/).map(d => d.trim()).filter(Boolean);
        // Only fetch domains not already in defaults
        const additional = userDomains.filter(d => !DEFAULT_DOMAINS.includes(d) && d !== 'binary_sensor');
        if (additional.length > 0) {
          await this.fetchSmartHomeByDomains(additional, parts);
        }
      }
    } catch { /* skip */ }

    // 4. User-configured specific entities (ADDITIVE, from memory "briefing_ha_entities")
    try {
      const mems = await this.memoryRepo.search(this.resolvedUserId!, 'ha_entit');
      const entityMem = mems.find(m => /ha_entit|home.?assistant.*entit|briefing.*entit/i.test(m.key));
      if (entityMem) {
        const entityIds = entityMem.value.split(/[,;]\s*/).map(e => e.trim()).filter(Boolean);
        if (entityIds.length > 0) {
          await this.fetchSmartHomeByEntities(entityIds, parts);
        }
      }
    } catch { /* skip */ }

    // v1143 — J4: Anwesenheit als erste Zeile — deterministisches
    // Standort-Grounding statt im Tabellen-Rauschen verstecktem person.*-Status.
    const inhalt = parts.join('\n');
    const anwesenheit = extrahiereAnwesenheit(inhalt);
    if (anwesenheit) return `${anwesenheit}\n${inhalt}`;
    return parts.length > 0 ? inhalt : '(Smart Home: keine relevanten Entities)';
  }

  private async fetchSmartHomeByEntities(entityIds: string[], parts: string[]): Promise<void> {
    parts.push('Konfigurierte Entities:');
    for (const eid of entityIds.slice(0, 20)) {
      try {
        const result = await this.fetchSkillData('homeassistant', { action: 'state', entityId: eid });
        if (result && !result.startsWith('(')) {
          const stateMatch = result.match(/\*\*State:\*\*\s*(.+)/);
          const nameMatch = result.match(/^##\s*(.+)/m);
          if (stateMatch) {
            parts.push(`  ${nameMatch?.[1] ?? eid}: ${stateMatch[1].trim()}`);
          }
        }
      } catch { /* skip entity */ }
    }
  }

  private async fetchSmartHomeByDomains(domains: string[], parts: string[]): Promise<void> {
    for (const domain of domains.slice(0, 8)) {
      try {
        const result = await this.fetchSkillData('homeassistant', { action: 'states', domain });
        if (result && !result.startsWith('(')) {
          const lines = result.split('\n').filter(l => l.startsWith('|') && !l.startsWith('|---') && !l.includes('Entity ID'));
          if (lines.length > 0) {
            parts.push(`${domain} (${lines.length}):`);
            for (const line of lines.slice(0, 15)) parts.push(line);
          }
        }
      } catch { /* skip domain */ }
    }
  }

  /** Fetch a skill with a custom timeout (for slow skills like monitor, feed_reader). */
  /** v1142 — H5: Circuit-Breaker je Quelle (siehe QuellenSchalter). */
  private readonly quellenSchalter = new QuellenSchalter();

  private async fetchWithTimeout(skillName: string, input: Record<string, unknown>, timeoutMs: number): Promise<string> {
    const skill = this.skillRegistry.get(skillName);
    if (!skill) return `(${skillName} nicht verfügbar)`;
    // v1142 — H5: tote Quellen nicht dauerhämmern. Der BMW-Skill lief mit
    // kaputtem Token 636×/Tag über alle Call-Stellen — nach 12 Fehlversuchen
    // in Folge pausiert die Quelle ~20 h (danach EIN Probe-Versuch).
    if (this.quellenSchalter.istPausiert(skillName)) {
      return `(${skillName} pausiert — ${this.quellenSchalter.fehlversuche(skillName)} Fehlversuche in Folge, nächster Versuch später)`;
    }
    try {
      const { context } = await buildSkillContext(this.userRepo, {
        userId: this.defaultChatId, platform: this.defaultPlatform, chatId: this.defaultChatId, chatType: 'dm',
      });
      const result = await Promise.race([
        this.skillSandbox.execute(skill, input, context),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${skillName} timeout`)), timeoutMs)),
      ]);
      if (!result.success) {
        if (this.quellenSchalter.fehlschlag(skillName)) {
          this.logger.warn({ skillName, fails: this.quellenSchalter.fehlversuche(skillName) }, 'v1142 Quelle pausiert (dauerhaft fehlschlagend)');
        }
        return `(${skillName}: ${result.error})`;
      }
      this.quellenSchalter.erfolg(skillName);
      return result.display ?? JSON.stringify(result.data);
    } catch (err) {
      if (this.quellenSchalter.fehlschlag(skillName)) {
        this.logger.warn({ skillName, fails: this.quellenSchalter.fehlversuche(skillName) }, 'v1142 Quelle pausiert (dauerhaft fehlschlagend)');
      }
      this.logger.warn({ err, skillName }, 'ReasoningCollector: skill fetch failed');
      return `(${skillName}-Abfrage fehlgeschlagen)`;
    }
  }

  private async fetchFeeds(): Promise<string> {
    return this.fetchWithTimeout('feed_reader', { action: 'check_all' }, 25_000);
  }

  private async fetchWorkflows(): Promise<string> {
    if (!this.workflowRepo) return 'Keine Workflow-Daten.';
    try {
      const workflows = await this.workflowRepo.findByUser(this.resolvedUserId!);
      if (workflows.length === 0) return 'Keine aktiven Workflows.';
      return workflows.map((w: any) => {
        const stepNames = (w.steps ?? []).map((s: any) => s.skillName || s.type || '?').join(' → ');
        const enabled = w.enabled !== false ? '✅' : '❌';
        return `- ${enabled} "${w.name}" (${stepNames})`;
      }).join('\n');
    } catch (err) {
      this.logger.warn({ err }, 'ReasoningCollector: workflow fetch failed');
      return '(Workflow-Abfrage fehlgeschlagen)';
    }
  }

  private async fetchWeather(): Promise<string> {
    // Resolve location: config → memories (home address) → skip
    let location = this.defaultLocation;
    if (!location) {
      try {
        for (const query of ['heim', 'home', 'adress', 'wohn']) {
          const results = await this.memoryRepo.search(this.resolvedUserId!, query);
          if (results.length > 0) {
            // Extract city from address value: PLZ pattern first, then comma-separated parts
            const value = results[0].value;
            // "3033 Altlengbach" or "80331 München"
            const plzMatch = value.match(/\b\d{4,5}\s+([A-ZÄÖÜ][a-zäöüß]{2,}(?:[\s-][A-ZÄÖÜ][a-zäöüß]+)?)\b/);
            if (plzMatch) { location = plzMatch[1]; break; }
            // Comma-separated: "Musterstraße 5, Altlengbach" → second-to-last or last part
            const parts = value.split(',').map((p: string) => p.trim());
            if (parts.length >= 2) {
              const candidate = parts.length >= 3 ? parts[parts.length - 2] : parts[parts.length - 1];
              if (candidate.length > 2 && candidate.length < 40 && /^[A-ZÄÖÜ]/.test(candidate)) { location = candidate; break; }
            }
            // Fallback: use the whole value as location
            if (value.length > 2 && value.length < 50) { location = value; break; }
          }
        }
      } catch { /* skip location resolution */ }
    }
    if (!location) return '(Wetter: kein Standort konfiguriert — Heimadresse in Memories speichern oder ALFRED_BRIEFING_LOCATION setzen)';
    return this.fetchSkillData('weather', { action: 'current', location });
  }

  private async fetchTemporalInsights(): Promise<string> {
    try {
      const trends = await this.memoryRepo.recall(this.resolvedUserId!, 'temporal_trends_weekly');
      const anomalies = await this.memoryRepo.recall(this.resolvedUserId!, 'temporal_anomalies_weekly');
      const parts: string[] = [];
      if (trends?.value && trends.value !== 'Keine signifikanten Trends.') {
        parts.push(`Trends:\n${trends.value}`);
      }
      if (anomalies?.value && anomalies.value !== 'Keine Anomalien.') {
        parts.push(`Anomalien:\n${anomalies.value}`);
      }
      return parts.length > 0 ? parts.join('\n\n') : 'Keine temporalen Auffälligkeiten.';
    } catch {
      return '(Trend-Daten nicht verfügbar)';
    }
  }

  private async fetchActionFeedback(): Promise<string> {
    try {
      const parts: string[] = [];

      // Action acceptance rates
      const summary = await this.memoryRepo.recall(this.resolvedUserId!, 'action_feedback_summary');
      if (summary?.value) {
        parts.push(summary.value);
      }

      // Insight preferences
      const prefs = await this.memoryRepo.search(this.resolvedUserId!, 'insight_pref_');
      if (prefs.length > 0) {
        const positive = prefs.filter(p => p.value.includes('nützlich') || p.value.includes('positiv')).map(p => p.key.replace('insight_pref_', ''));
        const negative = prefs.filter(p => p.value.includes('abgelehnt') || p.value.includes('ablehnt')).map(p => p.key.replace('insight_pref_', ''));
        // Note: "ignoriert" preferences from the old system are not included — silence ≠ rejection
        if (positive.length > 0) parts.push(`Insight-Präferenz positiv (User findet nützlich): ${positive.join(', ')}`);
        if (negative.length > 0) parts.push(`Insight-Präferenz negativ (EXPLIZIT abgelehnt — Häufigkeit reduzieren, NICHT eliminieren): ${negative.join(', ')}`);
      }

      // Autonomy suggestion
      const suggestion = await this.memoryRepo.recall(this.resolvedUserId!, 'autonomy_suggestion');
      if (suggestion?.value) parts.push(suggestion.value);

      return parts.length > 0 ? parts.join('\n') : 'Noch kein Feedback zu Aktionen gesammelt.';
    } catch {
      return '(Feedback-Daten nicht verfügbar)';
    }
  }

  // ── Enrichment ───────────────────────────────────────────

  /** Topic-to-skill mapping for deep enrichment fetches after Scan identifies concerns. */
  private static readonly ENRICHMENT_MAP: Record<string, { skill: string; input: Record<string, unknown>; maxTokens: number }> = {
    vehicle_battery:  { skill: 'bmw',          input: { action: 'status' },                  maxTokens: 300 },
    routing:          { skill: 'routing',       input: { action: 'route' },                   maxTokens: 300 },
    weather_forecast: { skill: 'weather',       input: { action: 'forecast' },                maxTokens: 250 },
    email_detail:     { skill: 'email',         input: { action: 'inbox', limit: 3 },         maxTokens: 300 },
    calendar_detail:  { skill: 'calendar',      input: { action: 'list_events', days: 3 },    maxTokens: 300 },
    smarthome_detail: { skill: 'homeassistant', input: { action: 'states' },                  maxTokens: 300 },
    crypto_detail:    { skill: 'bitpanda',      input: { action: 'portfolio' },               maxTokens: 250 },
    energy_forecast:  { skill: 'energy_price',  input: { action: 'today' },                   maxTokens: 200 },
  };

  /** Timeout for enrichment skill fetches (longer than base context). */
  private static readonly ENRICHMENT_TIMEOUT_MS = 8_000;

  /** Separate token budget for enrichment data. */
  private static readonly MAX_ENRICHMENT_TOKENS = 1500;

  /**
   * Fetch deeper data for topics identified by the Scan pass.
   * Runs in parallel with per-skill dedup and token budget enforcement.
   */
  async enrichTopics(topics: Array<{ topic: string; params?: Record<string, unknown> }>): Promise<Map<string, string>> {
    const results = new Map<string, string>();

    // Handle memory-based topics (no skill call needed)
    for (const t of topics) {
      if (t.topic === 'trend_analysis') {
        const content = await this.fetchTemporalInsights();
        if (content && !content.startsWith('(') && content !== 'Keine temporalen Auffälligkeiten.') {
          results.set('trend_analysis', content);
        }
      }
    }

    // Deduplicate: don't call same skill twice
    const toFetch = new Map<string, { topic: string; skill: string; input: Record<string, unknown> }>();
    for (const t of topics) {
      const def = ReasoningContextCollector.ENRICHMENT_MAP[t.topic];
      if (!def || !this.skillRegistry.has(def.skill)) continue;
      if (toFetch.has(def.skill)) continue;
      const mergedInput = { ...def.input, ...(t.params ?? {}) };
      toFetch.set(t.topic, { topic: t.topic, skill: def.skill, input: mergedInput });
    }

    if (toFetch.size === 0) return results;

    // Parallel fetch with timeout
    const fetches = [...toFetch.values()].map(async (entry) => {
      try {
        const content = await Promise.race([
          this.fetchSkillData(entry.skill, entry.input),
          new Promise<string>((_, rej) =>
            setTimeout(() => rej(new Error('enrichment timeout')), ReasoningContextCollector.ENRICHMENT_TIMEOUT_MS),
          ),
        ]);
        return { topic: entry.topic, content };
      } catch {
        return { topic: entry.topic, content: '' };
      }
    });

    const settled = await Promise.allSettled(fetches);
    let usedTokens = 0;

    for (const r of settled) {
      if (r.status !== 'fulfilled' || !r.value.content) continue;
      const est = Math.ceil(r.value.content.length / 3.5);
      if (usedTokens + est > ReasoningContextCollector.MAX_ENRICHMENT_TOKENS) {
        const remaining = (ReasoningContextCollector.MAX_ENRICHMENT_TOKENS - usedTokens) * 4;
        if (remaining > 100) {
          results.set(r.value.topic, r.value.content.slice(0, remaining) + '\n...(gekürzt)');
        }
        break;
      }
      results.set(r.value.topic, r.value.content);
      usedTokens += est;
    }

    return results;
  }

  // ── Email Reasoning Fetcher ─────────────────────────────────

  /**
   * Fetch emails for reasoning context: 15 emails, all with preview,
   * intelligently formatted with status tags. The LLM needs content
   * (not just subjects) to discover cross-domain connections.
   */
  private async fetchEmailForReasoning(): Promise<string> {
    const skill = this.skillRegistry.get('email');
    if (!skill) return '(Email nicht verfügbar)';
    try {
      const { context } = await buildSkillContext(this.userRepo, {
        userId: this.defaultChatId,
        platform: this.defaultPlatform,
        chatId: this.defaultChatId,
        chatType: 'dm',
      });

      const result = await Promise.race([
        this.skillSandbox.execute(skill, { action: 'inbox', count: 15 }, context),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('email timeout')), SKILL_FETCH_TIMEOUT_MS),
        ),
      ]);

      if (!result.success) return `(Email: ${result.error})`;
      if (!result.data || !Array.isArray((result.data as any).messages)) {
        return result.display ?? '(Email: keine Daten)';
      }

      const messages = (result.data as any).messages as Array<{
        id: string; subject: string; from: string; date: Date | string;
        read?: boolean; replied?: boolean; hasAttachments?: boolean;
        importance?: string; preview?: string; classification?: string;
      }>;

      if (messages.length === 0) return 'Inbox ist leer.';

      const unreadCount = messages.filter(m => !m.read).length;
      const needsReplyCount = messages.filter(m => !m.replied && !m.read).length;

      const AUTOMATED = /no[_-]?reply@|noreply@|notifications?@|ci@|builds?@|npm|github\.com|gitlab\.com|sentry\.io/i;

      const lines = messages.map((m, i) => {
        const isAuto = AUTOMATED.test(m.from) || m.classification === 'other';
        let status: string;
        if (m.replied) status = '✅';
        else if (m.read) status = '📖';
        else if (isAuto) status = 'ℹ️';
        else status = '🔴';

        const att = m.hasAttachments ? ' [ATT]' : '';
        const imp = m.importance === 'high' ? ' ❗' : '';
        const dateObj = m.date instanceof Date ? m.date : new Date(m.date);
        const dateStr = dateObj.toLocaleString('de-AT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

        // Preview: 80 chars for all emails (LLM needs content for cross-domain reasoning)
        const preview = m.preview ? `\n   ${m.preview.slice(0, 80).replace(/\n/g, ' ')}` : '';

        return `${i + 1}. ${status}${att}${imp} ${m.subject}\n   ${m.from} | ${dateStr}${preview}`;
      });

      const header = `Inbox (${messages.length} Emails, ${unreadCount} unread${needsReplyCount > 0 ? `, ${needsReplyCount} needs reply` : ''}):`;
      return `${header}\n${lines.join('\n')}`;
    } catch (err) {
      this.logger.warn({ err }, 'ReasoningCollector: email reasoning fetch failed');
      return '(Email-Abfrage fehlgeschlagen)';
    }
  }

  // ── Skill Data Fetcher ──────────────────────────────────────

  private async fetchSkillData(skillName: string, input: Record<string, unknown>): Promise<string> {
    const skill = this.skillRegistry.get(skillName);
    if (!skill) return `(${skillName} nicht verfügbar)`;
    try {
      const { context } = await buildSkillContext(this.userRepo, {
        userId: this.defaultChatId,
        platform: this.defaultPlatform,
        chatId: this.defaultChatId,
        chatType: 'dm',
      });

      const start = Date.now();
      // Timeout wrapper
      const result = await Promise.race([
        this.skillSandbox.execute(skill, input, context),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`${skillName} timeout`)), SKILL_FETCH_TIMEOUT_MS),
        ),
      ]);

      if (!result.success) return `(${skillName}: ${result.error})`;
      return result.display ?? JSON.stringify(result.data);
    } catch (err) {
      this.logger.warn({ err, skillName }, 'ReasoningCollector: skill fetch failed');
      return `(${skillName}-Abfrage fehlgeschlagen)`;
    }
  }
}
