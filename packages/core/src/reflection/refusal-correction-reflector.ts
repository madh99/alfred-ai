import type { Logger } from 'pino';
import type {
  ConversationRepository,
  LearnedRecipeRepository,
  RecipeAction,
} from '@alfred/storage';

/**
 * v722 — RefusalCorrectionReflector
 *
 * Erkennt das "Alfred sagte 'kann ich nicht' → User korrigiert → Skill funktioniert"-Pattern
 * und legt einen LearnedRecipe-Candidate mit confidence=0.5 + source=refusal_correction an.
 *
 * Detection (innerhalb 30 Min Fenster, gleiche Conversation):
 *   1. assistant-Message enthält Refusal-Marker (siehe REFUSAL_PATTERNS)
 *   2. nächste user-Message korrigiert ("doch", "hast du schon mal gemacht", "geht doch")
 *   3. innerhalb 5 nächster Messages assistant-Message OHNE Refusal + tool_calls vorhanden
 *      → das ist der erfolgreiche Workaround.
 *
 * Bei Match: extrahiere die tool_calls aus dem Success-Reply als RecipeAction[],
 * persistiere als invalidatedAt=NULL Recipe mit triggerPhrase = die ursprüngliche
 * User-Request-Message (die Frage VOR dem Refusal).
 */
export interface RefusalCorrectionReflectorOptions {
  /** Window für Refusal→Correction Span in Minuten. Default 30. */
  windowMinutes?: number;
  /** Max Messages zwischen Correction und Success. Default 6. */
  maxStepsToSuccess?: number;
  /** Look-back Window für Scan in Stunden. Default 24. */
  lookbackHours?: number;
}

const REFUSAL_PATTERNS = [
  /\b(kann ich nicht|kann ich leider nicht|nicht möglich|geht nicht|funktioniert nicht|nicht implementiert|keine möglichkeit|habe keine möglichkeit)\b/i,
  /\b(i can'?t|i cannot|not possible|not implemented|no way to)\b/i,
];

const CORRECTION_PATTERNS = [
  /\b(doch|geht doch|hast du schon|hast du in der vergangenheit|musst du|du kannst|funktioniert doch|war doch|ist doch|aber du)\b/i,
  /\b(yes you can|you did|you have done|you should|works)\b/i,
];

export interface DetectedRefusalCorrection {
  conversationId: string;
  userId: string;
  /** Die User-Anfrage vor dem Refusal. */
  triggerPhrase: string;
  triggerKeywords: string[];
  /** Extrahierte Skill-Calls aus dem Success-Reply. */
  actionSequence: RecipeAction[];
  /** Hinweis was im Memory war das den Workaround ermöglichte. */
  contextHint?: string;
  /** Activity-Trace für Audit. */
  refusalMessageId: string;
  correctionMessageId: string;
  successMessageId: string;
  detectedAt: string;
}

export class RefusalCorrectionReflector {
  private readonly windowMinutes: number;
  private readonly maxStepsToSuccess: number;
  private readonly lookbackHours: number;
  /** Hashes der bereits verarbeiteten Patterns (in-memory cache; verhindert Re-Detection im selben Process). */
  private readonly seen = new Set<string>();

  constructor(
    private readonly conversationRepo: ConversationRepository,
    private readonly recipeRepo: LearnedRecipeRepository,
    private readonly logger: Logger,
    options?: RefusalCorrectionReflectorOptions,
  ) {
    this.windowMinutes = options?.windowMinutes ?? 30;
    this.maxStepsToSuccess = options?.maxStepsToSuccess ?? 6;
    this.lookbackHours = options?.lookbackHours ?? 24;
  }

  /**
   * Scannt aktive Conversations eines Users nach Refusal-Correction-Patterns.
   * Idempotent — schon-erkannte Patterns werden geskippt (per seen-Hash).
   */
  async scanForUser(userId: string): Promise<DetectedRefusalCorrection[]> {
    const detected: DetectedRefusalCorrection[] = [];
    try {
      const conversations = await this.conversationRepo.listConversations({ userId, limit: 20 });
      for (const conv of conversations) {
        const messages = await this.conversationRepo.getMessages(conv.id, 100);
        const patterns = this.detectInMessages(conv.id, userId, messages);
        for (const p of patterns) {
          const hash = `${p.refusalMessageId}:${p.correctionMessageId}:${p.successMessageId}`;
          if (this.seen.has(hash)) continue;
          this.seen.add(hash);
          await this.recipeRepo.create({
            userId,
            triggerPhrase: p.triggerPhrase,
            triggerKeywords: p.triggerKeywords,
            actionSequence: p.actionSequence,
            contextHint: p.contextHint,
            source: 'refusal_correction',
            confidence: 0.5,
          });
          detected.push(p);
          this.logger.info({
            userId, conversationId: conv.id,
            trigger: p.triggerPhrase.slice(0, 60),
            steps: p.actionSequence.length,
          }, 'v722 refusal-correction pattern → learned recipe persisted');
        }
      }
    } catch (err) {
      this.logger.warn({ err, userId }, 'v722 refusal-correction scan failed');
    }
    return detected;
  }

  /**
   * Public for unit testing — detects patterns in an in-memory message list.
   */
  detectInMessages(
    conversationId: string,
    userId: string,
    messages: Array<{ id: string; role: string; content: string; toolCalls?: string; createdAt: string }>,
  ): DetectedRefusalCorrection[] {
    const result: DetectedRefusalCorrection[] = [];
    const cutoff = new Date(Date.now() - this.lookbackHours * 3600_000).toISOString();
    const recent = messages.filter(m => m.createdAt >= cutoff);
    for (let i = 0; i < recent.length; i++) {
      const m = recent[i];
      if (m.role !== 'assistant') continue;
      if (!REFUSAL_PATTERNS.some(p => p.test(m.content))) continue;
      // Find the immediately preceding user-request (this is the actual goal)
      let triggerMsg: typeof m | undefined;
      for (let k = i - 1; k >= 0; k--) {
        if (recent[k].role === 'user') { triggerMsg = recent[k]; break; }
      }
      if (!triggerMsg) continue;
      // Find user correction within window
      let correctionIdx = -1;
      for (let j = i + 1; j < Math.min(i + 1 + this.maxStepsToSuccess, recent.length); j++) {
        const c = recent[j];
        if (c.role !== 'user') continue;
        if (this.spanMinutes(m.createdAt, c.createdAt) > this.windowMinutes) break;
        if (CORRECTION_PATTERNS.some(p => p.test(c.content))) { correctionIdx = j; break; }
      }
      if (correctionIdx < 0) continue;
      // Find subsequent assistant message with tool_calls and NO refusal
      let successMsg: typeof m | undefined;
      for (let j = correctionIdx + 1; j < Math.min(correctionIdx + 1 + this.maxStepsToSuccess, recent.length); j++) {
        const s = recent[j];
        if (s.role !== 'assistant') continue;
        if (REFUSAL_PATTERNS.some(p => p.test(s.content))) continue;
        if (!s.toolCalls) continue;
        successMsg = s;
        break;
      }
      if (!successMsg?.toolCalls) continue;
      // Extract structured actions from tool_calls
      const actions = this.extractActions(successMsg.toolCalls);
      if (actions.length === 0) continue;
      const trigger = triggerMsg.content.slice(0, 200);
      result.push({
        conversationId,
        userId,
        triggerPhrase: trigger,
        triggerKeywords: this.tokenize(trigger),
        actionSequence: actions,
        contextHint: this.extractContextHint(successMsg.content),
        refusalMessageId: m.id,
        correctionMessageId: recent[correctionIdx].id,
        successMessageId: successMsg.id,
        detectedAt: new Date().toISOString(),
      });
    }
    return result;
  }

  private spanMinutes(a: string, b: string): number {
    return Math.abs(new Date(b).getTime() - new Date(a).getTime()) / 60000;
  }

  private tokenize(text: string): string[] {
    const lc = text.toLowerCase();
    const tokens = lc.match(/[a-zäöüß0-9_]+/g) ?? [];
    const stop = new Set(['der', 'die', 'das', 'ein', 'eine', 'und', 'oder', 'aber', 'mit', 'ohne', 'für', 'von', 'auf', 'bitte', 'kannst', 'könntest', 'starte', 'spiel', 'spiele']);
    const uniq = new Set<string>();
    for (const t of tokens) {
      if (t.length < 4) continue;
      if (stop.has(t)) continue;
      uniq.add(t);
    }
    return Array.from(uniq).slice(0, 8);
  }

  private extractActions(toolCallsJson: string): RecipeAction[] {
    try {
      const parsed = JSON.parse(toolCallsJson);
      if (!Array.isArray(parsed)) return [];
      const actions: RecipeAction[] = [];
      for (const tc of parsed) {
        const skill = tc.skill ?? tc.skillName ?? tc.name;
        if (typeof skill !== 'string') continue;
        const args = (tc.args ?? tc.params ?? tc.parameters ?? {}) as Record<string, unknown>;
        actions.push({
          skill,
          action: typeof args.action === 'string' ? args.action : undefined,
          params: args,
        });
      }
      return actions;
    } catch {
      return [];
    }
  }

  private extractContextHint(content: string): string | undefined {
    // Heuristik: wenn die Success-Antwort einen Memory-Key referenziert ("aus Memory ...")
    const memMatch = content.match(/(?:memory|gemerkt|gespeichert)[^\n.]{0,80}/i);
    if (memMatch) return memMatch[0].slice(0, 120);
    return undefined;
  }
}
