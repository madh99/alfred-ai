import type { Logger } from 'pino';
import type { ConfirmationRepository, KgQuestionsRepository } from '@alfred/storage';

interface KgEntity {
  id: string;
  name: string;
  entityType: string;
  mentionCount: number;
  attributes: Record<string, unknown>;
}
interface KgFacade {
  /** v694 — accepts array (owner master + linked + legacy data-uids).
   *  Implementation MUST canonical-merge identical entities by (type + normalized_name). */
  listEntities(userIds: string[]): Promise<KgEntity[]>;
}

interface GapCandidate {
  targetKind: string;
  targetId: string;
  targetName: string;
  attribute: string;
  question: string;
  /** Action to run on user-answer (skill+params). Memory-add is the safe default. */
  answerSkill: string;
  answerParams: Record<string, unknown>;
  /** Higher score = ask sooner. Considers mentions, attribute-class-importance, ignore-history. */
  score: number;
}

/**
 * v640 — Question-Generator: tägliche Auswahl von max 3 KG-Lücken die hochwertige
 * Antworten versprechen. Sendet pro Lücke eine Confirmation an die Owner-Platform mit
 * gebundener `memory.add`-Action (User-Antwort wird zur KG-Persistierung gespeichert).
 *
 * Anti-Nagging: pro (target, attribute) wird nur alle ≥7d nachgefragt, und nach 3
 * Ignores (Confirmation läuft ab) wird die Frage permanent als 'ignored' markiert.
 * Zusätzlich Back-Off pro Attribut-Klasse: wenn Birthday-Fragen oft ignoriert wurden,
 * werden NEUE Birthday-Fragen mit niedrigerem Score versehen.
 */
export class KgQuestionGenerator {
  constructor(
    private readonly kg: KgFacade,
    private readonly questions: KgQuestionsRepository,
    private readonly confirm: ConfirmationRepository,
    private readonly logger: Logger,
  ) {}

  async run(userId: string, opts: { platform: string; chatId: string; maxPerRun?: number; linkedUserIds?: string[] }): Promise<{ asked: number; skipped: number; ignored: number }> {
    const maxPerRun = opts.maxPerRun ?? 3;
    const uids = opts.linkedUserIds && opts.linkedUserIds.length > 0 ? opts.linkedUserIds : [userId];
    let entities: KgEntity[] = [];
    try { entities = await this.kg.listEntities(uids); } catch { return { asked: 0, skipped: 0, ignored: 0 }; }

    const candidates = await this.buildCandidates(userId, entities);
    candidates.sort((a, b) => b.score - a.score);

    let asked = 0, skipped = 0, ignored = 0;
    for (const c of candidates) {
      if (asked >= maxPerRun) break;
      const upsert = await this.questions.upsertAsk(userId, {
        targetKind: c.targetKind,
        targetId: c.targetId,
        attribute: c.attribute,
        questionText: c.question,
        askedViaPlatform: opts.platform,
        askedViaChatId: opts.chatId,
      });
      if (!upsert) { skipped++; continue; }
      if (upsert.ignoreCount >= 3) { ignored++; continue; }

      // Enqueue confirmation that asks the user — Approve = User wird gefragt zu antworten
      try {
        await this.confirm.create({
          chatId: opts.chatId,
          platform: opts.platform,
          source: 'reasoning',
          sourceId: `kg-question:${upsert.id}`,
          description: `🤔 ${c.question}\n\n_(Antwort als kurze Memory-Notiz speichern? Approve = ja, dann Antwort als nächste Nachricht schreiben. Reject = nicht fragen.)_`,
          skillName: 'memory',
          skillParams: c.answerParams,
          expiresAt: new Date(Date.now() + 2 * 86400_000).toISOString(),
        });
        asked++;
      } catch (err) {
        this.logger.debug({ err, qid: upsert.id }, 'KG-question confirmation enqueue failed');
      }
    }
    this.logger.info({ userId, asked, skipped, ignored }, 'KG-question-generator complete');
    return { asked, skipped, ignored };
  }

  private async buildCandidates(userId: string, entities: KgEntity[]): Promise<GapCandidate[]> {
    const candidates: GapCandidate[] = [];

    // Per-attribute ignore-rate für Back-Off
    const ignoreRates: Record<string, number> = {};
    for (const attr of ['birthday', 'relation', 'org-incomplete', 'location-address']) {
      ignoreRates[attr] = await this.questions.ignoreRateForAttribute(userId, attr).catch(() => 0);
    }
    const backoff = (attr: string) => 1 - Math.min(0.7, ignoreRates[attr] ?? 0);

    for (const e of entities) {
      const attrs = e.attributes ?? {};
      const mentions = e.mentionCount ?? 0;
      if (mentions < 3) continue;

      if (e.entityType === 'person') {
        if (!attrs.birthday && !attrs.birth_date) {
          candidates.push({
            targetKind: 'person', targetId: e.id, targetName: e.name,
            attribute: 'birthday',
            question: `Wann hat **${e.name}** Geburtstag?`,
            answerSkill: 'memory',
            answerParams: { action: 'add', text: `Geburtstag von ${e.name}: <user-answer>` },
            score: mentions * 2 * backoff('birthday'),
          });
        }
        if (!attrs.relation_to_owner && !attrs.relation) {
          candidates.push({
            targetKind: 'person', targetId: e.id, targetName: e.name,
            attribute: 'relation',
            question: `Wie steht **${e.name}** zu dir? (Familie, Freund, Kollege …)`,
            answerSkill: 'memory',
            answerParams: { action: 'add', text: `${e.name} ist meine/mein <user-answer>` },
            score: mentions * 1.5 * backoff('relation'),
          });
        }
      }

      if (e.entityType === 'organization' && mentions >= 5) {
        const missing: string[] = [];
        if (!attrs.url && !attrs.website) missing.push('URL');
        if (!attrs.industry && !attrs.branche) missing.push('Branche');
        if (missing.length >= 1) {
          candidates.push({
            targetKind: 'organization', targetId: e.id, targetName: e.name,
            attribute: 'org-incomplete',
            question: `Was macht **${e.name}** eigentlich? (Branche / Website kurz)`,
            answerSkill: 'memory',
            answerParams: { action: 'add', text: `${e.name} (Organisation): <user-answer>` },
            score: mentions * 1.2 * backoff('org-incomplete'),
          });
        }
      }

      if (e.entityType === 'location' && mentions >= 3 && !attrs.address) {
        candidates.push({
          targetKind: 'location', targetId: e.id, targetName: e.name,
          attribute: 'location-address',
          question: `Wo liegt **${e.name}** genau? (Adresse, kurz)`,
          answerSkill: 'memory',
          answerParams: { action: 'add', text: `${e.name} (Ort): <user-answer>` },
          score: mentions * 1.3 * backoff('location-address'),
        });
      }
    }
    return candidates;
  }
}
