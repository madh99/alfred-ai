import type { Logger } from 'pino';
import type { KgQuestionsRepository } from '@alfred/storage';

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
  /** Higher score = ask sooner. Considers mentions, attribute-class-importance, ignore-history. */
  score: number;
}

/** v1155 — Rollen-Präfix im Namen („Tochter Lena") zählt als bekannte Beziehung. */
const ROLLEN_PRAEFIX_RE = /^(tochter|sohn|schwester|bruder|mutter|vater|mama|papa|oma|opa|tante|onkel|nichte|neffe|cousine|cousin|frau|mann|freund|freundin|kollege|kollegin)\s+/i;

/**
 * v640 — Question-Generator: tägliche Auswahl von max 3 KG-Lücken die hochwertige
 * Antworten versprechen.
 *
 * v1155 — Komplett-Renovierung nach dem ersten echten Praxiseinsatz (der Generator
 * lief bis v1142 NIE): (1) Er prüfte die Alt-Keys `birthday`/`relation_to_owner`,
 * der KG-Standard ist aber `birthdate`/`relation_to_user` — er fragte deshalb nach
 * Geburtstagen und Beziehungen, die längst im KG standen (Realfall „Hannah Dohnal").
 * (2) Die Zustellung als Ja/Nein-Confirmation war absurde UX und ihre Antwort-Aktion
 * (`memory action:add`) existiert seit langem nicht mehr. Jetzt: EINE normale
 * Chat-Nachricht mit den Fragen — die Antwort läuft durch die normale Pipeline
 * und wird vom Stammdaten-Sync (v1146) konstruktiv in den KG übernommen.
 *
 * Anti-Nagging unverändert: pro (target, attribute) nur alle ≥7d, nach 3 Ignores
 * permanent 'ignored'; Back-Off pro Attribut-Klasse bei hoher Ignore-Rate.
 */
export class KgQuestionGenerator {
  constructor(
    private readonly kg: KgFacade,
    private readonly questions: KgQuestionsRepository,
    private readonly logger: Logger,
  ) {}

  async run(userId: string, opts: {
    platform: string;
    chatId: string;
    maxPerRun?: number;
    linkedUserIds?: string[];
    /** v1155 — Zustellung als normale Nachricht (statt Confirmation). */
    sendeNachricht: (text: string) => Promise<void>;
  }): Promise<{ asked: number; skipped: number; ignored: number }> {
    const maxPerRun = opts.maxPerRun ?? 3;
    const uids = opts.linkedUserIds && opts.linkedUserIds.length > 0 ? opts.linkedUserIds : [userId];
    let entities: KgEntity[] = [];
    try { entities = await this.kg.listEntities(uids); } catch { return { asked: 0, skipped: 0, ignored: 0 }; }

    const candidates = await this.buildCandidates(userId, entities);
    candidates.sort((a, b) => b.score - a.score);

    const zuStellen: string[] = [];
    let skipped = 0, ignored = 0;
    for (const c of candidates) {
      if (zuStellen.length >= maxPerRun) break;
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
      zuStellen.push(c.question);
    }

    if (zuStellen.length > 0) {
      try {
        const text = zuStellen.length === 1
          ? `🤔 ${zuStellen[0]}\n\n_(Einfach antworten — ich merke es mir.)_`
          : `🤔 **Ein paar Wissenslücken:**\n${zuStellen.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n\n_(Einfach antworten — ich merke es mir.)_`;
        await opts.sendeNachricht(text);
      } catch (err) {
        this.logger.warn({ err }, 'KG-question delivery failed');
        return { asked: 0, skipped, ignored };
      }
    }
    this.logger.info({ userId, asked: zuStellen.length, skipped, ignored }, 'KG-question-generator complete');
    return { asked: zuStellen.length, skipped, ignored };
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
        // v1155 — KG-Standard-Key ist `birthdate` (v1144); Alt-Varianten weiter toleriert.
        if (!attrs.birthdate && !attrs.birthday && !attrs.birth_date) {
          candidates.push({
            targetKind: 'person', targetId: e.id, targetName: e.name,
            attribute: 'birthday',
            question: `Wann hat **${e.name}** Geburtstag?`,
            score: mentions * 2 * backoff('birthday'),
          });
        }
        // v1155 — KG-Standard-Key ist `relation_to_user`; Rollen-Präfix im Namen zählt auch.
        const hatBeziehung = attrs.relation_to_user || attrs.relation_to_owner || attrs.relation || ROLLEN_PRAEFIX_RE.test(e.name);
        if (!hatBeziehung) {
          candidates.push({
            targetKind: 'person', targetId: e.id, targetName: e.name,
            attribute: 'relation',
            question: `Wie steht **${e.name}** zu dir? (Familie, Freund, Kollege …)`,
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
            score: mentions * 1.2 * backoff('org-incomplete'),
          });
        }
      }

      if (e.entityType === 'location' && mentions >= 3 && !attrs.address) {
        candidates.push({
          targetKind: 'location', targetId: e.id, targetName: e.name,
          attribute: 'location-address',
          question: `Wo liegt **${e.name}** genau? (Adresse, kurz)`,
          score: mentions * 1.3 * backoff('location-address'),
        });
      }
    }
    return candidates;
  }
}
