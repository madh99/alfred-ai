import crypto from 'node:crypto';
import type { Logger } from 'pino';
import type { ScheduledActionRepository, UserRepository } from '@alfred/storage';
import type { SkillRegistry, SkillSandbox } from '@alfred/skills';
import type { MessagingAdapter } from '@alfred/messaging';
import type { Platform, ScheduledAction, NormalizedMessage } from '@alfred/types';
import type { LLMProvider } from '@alfred/llm';
import type { MessagePipeline } from './message-pipeline.js';
import type { ResponseFormatter } from './response-formatter.js';
import type { ConversationManager } from './conversation-manager.js';
import { matchesCron, getNextCronDate } from '@alfred/types';
import { buildSkillContext } from './context-factory.js';
import type { ActivityLogger } from './activity-logger.js';
import { entscheideMeldung, kennungenAus } from './geplant/meldung.js'; // v1368
import { standRahmen, standAus, laufVollstaendig, istPruefAuftrag, NACHFORDERUNG } from './geplant/stand.js'; // v1449
import { standLesen, standSchreiben, berichtBauen, einschaetzungAus } from './geplant/bericht.js'; // v1465, v1466
import { zustellProtokoll } from './zustellung/protokoll.js'; // v1369
import { mitKostenZweck } from './kosten-zweck.js'; // v1506 D5

export class ProactiveScheduler {
  private tickTimer?: ReturnType<typeof setInterval>;
  private readonly tickIntervalMs = 60_000;

  constructor(
    private readonly actionRepo: ScheduledActionRepository,
    private readonly skillRegistry: SkillRegistry,
    private readonly skillSandbox: SkillSandbox,
    private readonly llm: LLMProvider,
    private readonly adapters: Map<Platform, MessagingAdapter>,
    private readonly users: UserRepository,
    private readonly logger: Logger,
    private readonly pipeline?: MessagePipeline,
    private readonly formatter?: ResponseFormatter,
    private readonly conversationManager?: ConversationManager,
    private readonly activityLogger?: ActivityLogger,
    private readonly nodeId: string = 'single',
  ) {}

  /**
   * v1368 — Gedächtnis der gemeldeten Kennungen (Rechnungs-/Vertragsnummern, Beträge) über alle Aufgaben des Benutzers, 60 Tage;
   * von alfred.ts gesetzt. Ohne Gedächtnis gilt jede Kennung als neu (lieber einmal zu viel melden als eine Rechnung verlieren).
   */
  private meldeGedaechtnis?: { laden(userId: string): Promise<Set<string>>; merken(userId: string, kennungen: string[]): Promise<void> };
  setMeldeGedaechtnis(g: NonNullable<ProactiveScheduler['meldeGedaechtnis']>): void { this.meldeGedaechtnis = g; }
  /**
   * v1447 — Realfall 14.10.: Aufgabe aus einem App-Faden merkte sich `sitzung:<Gerät>:<Faden>`; das Ergebnis landete in einem
   * verwaisten Gespräch statt im Faden (`owner:faden:<Faden>`). Der Hook stellt Faden-Ergebnisse zu (Faden + Owner-Geräte +
   * Telegram-Kopie) und liefert true, wenn er zuständig war.
   */
  private fadenZustellung?: (chatId: string, text: string, name: string) => Promise<boolean>;
  setFadenZustellung(f: NonNullable<ProactiveScheduler['fadenZustellung']>): void { this.fadenZustellung = f; }

  start(): void {
    this.tickTimer = setInterval(() => this.tick(), this.tickIntervalMs);
    this.logger.info('Proactive scheduler started');
    void this.reparierePlanungsluecken().catch(err => this.logger.warn({ err }, 'v1654 Reparatur geplanter Aufgaben gescheitert'));
  }

  /**
   * v1654 — Realfall 25.10.2026: der 24-h-Horizont der Cron-Suche fand am Tag der Zeitumstellung keinen Termin, der Lauf
   * deaktivierte daraufhin die Aufgabe wie eine einmalige. Erkennungsmerkmal: Cron, deaktiviert, schon gelaufen, ohne nächsten
   * Termin — von Hand deaktivierte oder abgelöste Aufgaben behalten ihren nächsten Termin. Solche Aufgaben werden wieder
   * eingeschaltet, sofern ihr Ausdruck einen Termin hat.
   */
  async reparierePlanungsluecken(): Promise<string[]> {
    const repariert: string[] = [];
    for (const a of await this.actionRepo.getAll()) {
      if (a.enabled || a.scheduleType !== 'cron' || a.nextRunAt || !a.lastRunAt) continue;
      const naechster = this.calculateNextRun(a);
      if (!naechster) continue;
      await this.actionRepo.updateLastRun(a.id, a.lastRunAt, naechster);
      await this.actionRepo.setEnabled(a.id, true);
      repariert.push(a.name);
      this.logger.info({ actionId: a.id, name: a.name, naechster }, 'v1654 geplante Aufgabe nach Planungslücke wieder eingeschaltet');
    }
    return repariert;
  }

  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
    this.logger.info('Proactive scheduler stopped');
  }

  private async tick(): Promise<void> {
    try {
      const dueActions = await this.actionRepo.claimDue(this.nodeId);

      for (const action of dueActions) {
        try {
          await this.executeAction(action);
        } catch (err) {
          this.logger.error({ err, actionId: action.id }, 'Failed to execute scheduled action');
        }
      }
    } catch (err) {
      this.logger.error({ err }, 'Error during proactive scheduler tick');
    }
  }

  /**
   * v1211 — Ereignisgetriebener Lauf (Mail-Ereignisquelle): die Aufgabe läuft genau einmal für
   * den Auslöser, der Auslöser-Text hängt am Prompt, die Werkzeuge sind auf die Liste begrenzt.
   */
  async fuehreAusDurchEreignis(action: ScheduledAction, ausloeser: { text: string; allowedSkills?: string[] }): Promise<void> {
    await this.executeAction(action, ausloeser);
  }

  /** v1506 D5 — Kostenherkunft „aufgabe“ für alles, was eine geplante Aufgabe auslöst (auch durch die Pipeline). */
  private executeAction(action: ScheduledAction, ausloeser?: { text: string; allowedSkills?: string[] }): Promise<void> {
    return mitKostenZweck('aufgabe', () => this.executeActionIntern(action, ausloeser));
  }

  private async executeActionIntern(action: ScheduledAction, ausloeser?: { text: string; allowedSkills?: string[] }): Promise<void> {
    const now = new Date().toISOString();
    const startMs = Date.now();
    this.logger.info({ actionId: action.id, name: action.name, ...(ausloeser ? { ausloeser: ausloeser.text.slice(0, 160), allowedSkills: ausloeser.allowedSkills } : {}) }, 'Executing scheduled action');

    let resultText: string;
    let resultParseMode: 'text' | 'markdown' | 'html' = 'text';
    let rohErgebnis: string | undefined; // v1450 — Markdown vor der Plattform-Formatierung (fürs Gespräch und den Faden)
    let pruefLauf = false; // v1449 — Prüfauftrag mit eigenem Stand: jeder vollständige Lauf wird zugestellt

    if (action.skillName && this.skillRegistry.has(action.skillName)) {
      // Execute skill directly — preferred path (no LLM overhead).
      // Checked BEFORE promptTemplate so tasks with both fields use the
      // cheaper direct path (e.g. old briefing tasks with legacy prompt_template).
      const skill = this.skillRegistry.get(action.skillName)!;
      try {
        let input: Record<string, unknown>;
        try { input = JSON.parse(action.skillInput); }
        catch { input = {}; this.logger.warn({ actionId: action.id }, 'Invalid skillInput JSON, using empty input'); }
        const { context } = await buildSkillContext(this.users, {
          userId: action.userId,
          platform: action.platform as Platform,
          chatId: action.chatId,
          chatType: 'dm',
        });

        const result = await this.skillSandbox.execute(skill, input, context);
        if (result.success) {
          const rawText = result.display ?? JSON.stringify(result.data);
          rohErgebnis = rawText;
          if (this.formatter) {
            const formatted = this.formatter.format(rawText, action.platform as Platform);
            resultText = formatted.text;
            resultParseMode = formatted.parseMode;
          } else {
            resultText = rawText;
          }
        } else {
          resultText = `\u274C Scheduled action "${action.name}" failed: ${result.error}`;
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        resultText = `\u274C Scheduled action "${action.name}" failed: ${errorMsg}`;
      }
    } else if (action.promptTemplate && this.pipeline) {
      // Route through the full message pipeline so the LLM can use all tools.
      try {
        const isolatedChatId = `scheduled-${action.id}`;
        const pruefModus = action.stand !== undefined || istPruefAuftrag(action.promptTemplate); // v1449
        const resolvedUser = await this.users.findById(action.userId);
        const platformUserId = resolvedUser?.platformUserId ?? action.userId;
        const syntheticMessage: NormalizedMessage = {
          id: `scheduled-${crypto.randomUUID()}`,
          platform: action.platform as Platform,
          chatId: isolatedChatId,
          chatType: 'dm',
          userId: platformUserId,
          userName: resolvedUser?.username ?? platformUserId,
          // v1447 — die Aufgabe weiß, dass sie selbst die geplante Prüfung ist; v1449 — Prüfauftrag: fester Rahmen mit dem eigenen Stand
          text: (pruefModus ? `${standRahmen(action.name, action.stand ?? '', action.standZeit)}\n\nAuftrag:\n` : `[Geplante Aufgabe „${action.name}“ — läuft bereits automatisch nach Plan. Ergebnis liefern; nicht anbieten, sie einzuplanen oder zu automatisieren.]\n\n`) + action.promptTemplate + (ausloeser ? '\n\n' + ausloeser.text : '') + '\n\n[Format: Use only Markdown (**, *, ~~, `, ```). Do NOT use HTML tags like <b>, <i>, <code>. The system converts Markdown to platform-specific formatting automatically.]',
          timestamp: new Date(),
          metadata: { scheduled: true, skipHistory: true, tier: 'fast', originalChatId: action.chatId, ...(ausloeser?.allowedSkills ? { allowedSkills: ausloeser.allowedSkills } : {}) },
        };

        let result = await this.pipeline.process(syntheticMessage);
        let rohText = result.text;
        if (pruefModus) {
          // v1449 — Bericht und neuen Stand trennen; unvollständig → einmal nachfordern; sonst ehrlich melden (Stand bleibt)
          let teil = standAus(result.text);
          let v = laufVollstaendig(teil);
          if (!v.ok) {
            this.logger.warn({ actionId: action.id, name: action.name, fehlt: v.fehlt }, 'v1449 Prüflauf unvollständig — Nachforderung');
            result = await this.pipeline.process({ ...syntheticMessage, id: `scheduled-${crypto.randomUUID()}`, text: `${NACHFORDERUNG}\n\n${syntheticMessage.text}` });
            teil = standAus(result.text);
            v = laufVollstaendig(teil);
          }
          if (v.ok) {
            // v1465 — Bericht nach fester Vorlage aus altem und neuem Stand; die freie Antwort des Modells wird nur noch „Einschätzung“
            const b = berichtBauen({ alt: standLesen(action.stand), neu: standLesen(teil.stand), einschaetzung: einschaetzungAus(result.text), jetzt: new Date() }); // v1466 nur aus dem Block
            const neuerStand = standSchreiben(b.stand);
            await this.actionRepo.setzeStand(action.id, neuerStand);
            rohText = b.bericht;
            this.logger.info({ actionId: action.id, name: action.name, standZeichen: neuerStand.length, eintraege: b.stand.length }, 'v1449 Prüfstand fortgeschrieben');
          } else {
            rohText = `${teil.bericht.trim() || '(kein Bericht geliefert)'}\n\n⚠️ Prüflauf „${action.name}“ unvollständig: ${v.fehlt.join(' und ')} fehlt auch nach Nachforderung — der letzte Stand bleibt; der nächste Lauf prüft erneut.`;
            this.logger.warn({ actionId: action.id, name: action.name, fehlt: v.fehlt }, 'v1449 Prüflauf unvollständig nach Nachforderung');
          }
          pruefLauf = true;
        }
        rohErgebnis = rohText;
        const formatted = this.formatter
          ? this.formatter.format(rohText, action.platform as Platform)
          : { text: rohText, parseMode: 'text' as const };

        resultText = formatted.text;
        resultParseMode = formatted.parseMode;

        // Send file attachments if any — to the USER's original chatId
        const adapter = this.adapters.get(action.platform as Platform);
        if (adapter && result.attachments) {
          for (const att of result.attachments.filter(a => !a.nurModell)) { // v1470 — „nur fürs Modell“ nie zustellen
            try {
              const isImage = att.mimeType.startsWith('image/');
              const isVoice = att.mimeType === 'audio/ogg' || att.mimeType === 'audio/opus';
              if (isImage) {
                await adapter.sendPhoto(action.chatId, att.data, att.fileName);
              } else if (isVoice) {
                await adapter.sendVoice(action.chatId, att.data);
              } else {
                await adapter.sendFile(action.chatId, att.data, att.fileName);
              }
            } catch (err) {
              this.logger.warn({ err, fileName: att.fileName, actionId: action.id }, 'Failed to send scheduled action attachment');
            }
          }
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.logger.error({ actionId: action.id, err }, 'Pipeline execution failed for scheduled action');
        resultText = `Scheduled action "${action.name}" failed: ${errorMsg}`;
      }
    } else if (action.promptTemplate) {
      // Fallback: LLM-only (no pipeline available)
      try {
        const response = await this.llm.complete({
          messages: [{ role: 'user', content: action.promptTemplate }],
          maxTokens: 1024,
          tier: 'fast',
        });
        resultText = response.content;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.logger.error({ actionId: action.id, err }, 'LLM call failed for scheduled action');
        resultText = `Scheduled action "${action.name}" failed: ${errorMsg}`;
      }
    } else {
      this.logger.warn({ actionId: action.id, skillName: action.skillName }, 'Unknown skill for scheduled action');
      resultText = `Scheduled action "${action.name}" failed: unknown skill "${action.skillName}"`;
    }

    // Log activity
    const isError = resultText.startsWith('\u274C');
    this.activityLogger?.logScheduledExec({
      actionId: action.id, actionName: action.name,
      skillName: action.skillName ?? undefined,
      platform: action.platform, chatId: action.chatId, userId: action.userId,
      outcome: isError ? 'error' : 'success',
      durationMs: Date.now() - startMs,
      error: isError ? resultText : undefined,
    });

    // v1368 — Meldeentscheidung deterministisch (geplant/meldung.ts): Fehler immer; ausdrückliche Stille-Anweisung nur bei
    // Alarm; sonst nur, wenn der Text Neues enthält (Kennungen, die noch in keiner Meldung standen). Vorher genügte irgendein
    // „nichts" im Prompt für „still" — Realfall 11.10.: die aWATTar-Rechnung 09/2026 wurde verarbeitet, aber nie gemeldet.
    const trimmed = resultText.trim();
    let bekannt = new Set<string>();
    if (action.promptTemplate && this.meldeGedaechtnis) { try { bekannt = await this.meldeGedaechtnis.laden(action.userId); } catch { /* ohne Gedächtnis: alles neu */ } }
    // v1449 — Prüfaufträge melden jeden Lauf („Liefere JEDES MAL“): nicht über das Kennungs-Gedächtnis unterdrücken
    const entscheidung = pruefLauf && trimmed.length >= 3
      ? { senden: true, grund: 'Prüfauftrag', neu: [] as string[] }
      : action.promptTemplate
      ? entscheideMeldung({ text: trimmed, prompt: action.promptTemplate, istFehler: isError || trimmed.startsWith('Scheduled action'), bekannt })
      : { senden: trimmed.length >= 3, grund: trimmed.length >= 3 ? 'Skill-Aufgabe' : 'leer', neu: [] as string[] };
    if (!entscheidung.senden) {
      this.logger.info({ actionId: action.id, name: action.name, grund: entscheidung.grund, text: trimmed.slice(0, 200) }, 'Scheduled action produced no actionable output — skipping notification');
      if (action.promptTemplate && entscheidung.grund !== 'leer') zustellProtokoll.merke('aufgabe'); // v1369
    } else {
      this.logger.info({ actionId: action.id, name: action.name, grund: entscheidung.grund, neu: entscheidung.neu.slice(0, 6) }, 'v1368 Geplante Aufgabe meldet');
      if (action.promptTemplate && this.meldeGedaechtnis) void this.meldeGedaechtnis.merken(action.userId, kennungenAus(trimmed)).catch(() => undefined);
      // v1459 — Realfall 15.10.: im Faden fehlte die Kopfzeile (dort liest der Owner); gleiche Form wie im Gespräch gespeichert
      const imFaden = this.fadenZustellung ? await this.fadenZustellung(action.chatId, `⏰ Geplante Aufgabe „${action.name}“\n\n${rohErgebnis ?? resultText}`, action.name).catch((err: Error) => { this.logger.warn({ err: err.message, actionId: action.id }, 'v1447 Faden-Zustellung fehlgeschlagen'); return false; }) : false;
      const adapter = imFaden ? undefined : this.adapters.get(action.platform as Platform);
      if (adapter) {
        try {
          await adapter.sendMessage(action.chatId, resultText, {
            parseMode: resultParseMode !== 'text' ? resultParseMode : undefined,
            threadId: action.threadId,
          });

          // For prompt_template tasks running in an isolated conversation:
          // inject the alert into the USER's conversation so they can reply
          // with context (e.g. "restart the VM").  Skill-based tasks already
          // run without conversation context, so injecting their output would
          // just bloat the user's history.
          if (action.promptTemplate && this.conversationManager) {
            const userConv = await this.conversationManager.getOrCreateConversation(
              action.platform as Platform,
              action.chatId,
              action.userId,
            );
            // v1450 — Realfall 14.10.: die App zeigte das Hauptgespräch mit rohen <b>/<code> (gespeichert wurde die Telegram-HTML-Fassung)
            // und dem Präfix „[Automated Scheduled Alert: …]“. Jetzt Markdown wie jede andere Antwort, mit lesbarer Kopfzeile.
            const alertMsg = `⏰ Geplante Aufgabe „${action.name}“\n\n${rohErgebnis ?? resultText}`;
            await this.conversationManager.addMessage(userConv.id, 'assistant', alertMsg);
          }
        } catch (err) {
          this.logger.error({ err, actionId: action.id }, 'Failed to send scheduled action result');
        }
      }
    }

    // Prune isolated scheduled-task conversations to prevent unbounded growth.
    // Keep only the last 20 messages (≈10 prompt/response pairs).
    if (action.promptTemplate && this.conversationManager) {
      try {
        const isolatedChatId = `scheduled-${action.id}`;
        const conv = await this.conversationManager.getOrCreateConversation(
          action.platform as Platform,
          isolatedChatId,
          action.userId,
        );
        await this.conversationManager.pruneMessages(conv.id, 20);
      } catch {
        // Non-critical — ignore pruning errors
      }
    }

    // Calculate next run
    const nextRunAt = this.calculateNextRun(action);

    if (action.scheduleType === 'mail') {
      // v1211 — Mail-Aufgaben haben keinen Zeitplan; sie bleiben aktiv und warten auf die nächste Post.
      await this.actionRepo.updateLastRun(action.id, now, null);
    } else if (nextRunAt) {
      await this.actionRepo.updateLastRun(action.id, now, nextRunAt);
    } else {
      // No next run (e.g. 'once' type) — disable the action
      await this.actionRepo.updateLastRun(action.id, now, null);
      await this.actionRepo.setEnabled(action.id, false);
    }
  }

  private calculateNextRun(action: ScheduledAction): string | null {
    const now = new Date();

    switch (action.scheduleType) {
      case 'interval': {
        const minutes = parseInt(action.scheduleValue, 10);
        if (isNaN(minutes) || minutes <= 0) return null;
        return new Date(now.getTime() + minutes * 60_000).toISOString();
      }
      case 'once': {
        // One-time actions don't repeat
        return null;
      }
      case 'cron': {
        return getNextCronDate(action.scheduleValue, now)?.toISOString() ?? null;
      }
      default:
        return null;
    }
  }

  // Cron matching delegated to shared cron-utils
}
