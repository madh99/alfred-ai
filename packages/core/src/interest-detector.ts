import type { Logger } from 'pino';
import type { InterestsRepository, InsightsRepository } from '@alfred/storage';
import type { LLMProvider } from '@alfred/llm';
import type { SourceProvisioner } from './source-provisioner.js';

export interface DetectorSignals {
  /** Häufig erwähnte KG-Entities (personal layer), z.B. Themen/Konzepte/Projekte. */
  entities: Array<{ name: string; type: string; mentions: number }>;
  /** Jüngste Konversations-Zusammenfassungen (Signal für wiederkehrende Gesprächsthemen). */
  recentSummaries: string[];
}

export interface TopicSuggestion {
  name: string;
  keywords: string[];
  strength: 'strong' | 'medium';
  warum: string;
}

/** Tolerantes Parsen der LLM-Antwort (JSON-Array mit {name, keywords, strength, warum}). */
export function parseSuggestions(text: string): TopicSuggestion[] {
  const match = text?.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((s: any) => s && typeof s.name === 'string' && s.name.trim().length > 1)
      .map((s: any) => ({
        name: String(s.name).trim().slice(0, 80),
        keywords: Array.isArray(s.keywords) ? s.keywords.map(String).slice(0, 8) : [],
        strength: s.strength === 'strong' ? 'strong' as const : 'medium' as const,
        warum: typeof s.warum === 'string' ? s.warum.slice(0, 200) : '',
      }))
      .slice(0, 5);
  } catch {
    return [];
  }
}

/**
 * v930 — Interest-Detector: erkennt wiederkehrende Interessen des Users aus
 * KG-Entities + jüngsten Konversationen (täglich, HA-dedupliziert).
 *
 * - strength=strong → Topic wird AUTO angelegt (origin='auto', still) und der
 *   Source-Provisioner bestückt es; sichtbar in der Interessen-UI.
 * - strength=medium → Vorschlag als Insight (Kategorie 'interest-suggestion')
 *   mit Aktion „Thema anlegen" — der User bestätigt in der UI oder per Chat.
 * - Bereits existierende Themen (Name/Keyword-Überschneidung) werden übersprungen.
 */
export class InterestDetector {
  constructor(
    private readonly interestsRepo: InterestsRepository,
    private readonly insightsRepo: InsightsRepository | undefined,
    private readonly llm: LLMProvider,
    private readonly provisioner: SourceProvisioner | undefined,
    private readonly getSignals: () => Promise<DetectorSignals>,
    private readonly logger: Logger,
    private readonly ownerUserId: string,
  ) {}

  async runDetection(): Promise<{ autoCreated: string[]; suggested: string[] }> {
    const out = { autoCreated: [] as string[], suggested: [] as string[] };
    const [signals, existingTopics] = await Promise.all([
      this.getSignals(),
      this.interestsRepo.listTopics(this.ownerUserId),
    ]);
    if (signals.entities.length === 0 && signals.recentSummaries.length === 0) return out;

    const prompt = this.buildPrompt(signals, existingTopics.map(t => t.name));
    const response = await this.llm.complete({ messages: [{ role: 'user', content: prompt }], maxTokens: 700, tier: 'fast' });
    const suggestions = parseSuggestions(response.content ?? '');

    for (const s of suggestions) {
      // Doppel-Check gegen Bestand (LLM kann die Ausschlussliste ignorieren)
      const existing = await this.interestsRepo.findTopicByName(this.ownerUserId, s.name);
      if (existing) continue;

      if (s.strength === 'strong') {
        const topic = await this.interestsRepo.createTopic(this.ownerUserId, {
          name: s.name, keywords: s.keywords, origin: 'auto',
        });
        out.autoCreated.push(s.name);
        try { await this.provisioner?.provision(topic); } catch (err) {
          this.logger.warn({ err: (err as Error).message, topic: s.name }, 'v930 auto-provision failed');
        }
        // Still sichtbar machen: Info-Eintrag in der Insights-Ablage (keine Nachricht)
        await this.insightsRepo?.upsertCandidate(this.ownerUserId, {
          category: 'interest-suggestion',
          title: `Thema „${s.name}" automatisch angelegt`,
          body: `Alfred beobachtet jetzt **${s.name}**${s.keywords.length ? ` (Stichwörter: ${s.keywords.join(', ')})` : ''}.\n\n_Erkannt weil: ${s.warum}_\n\nQuellen und Status in der Interessen-Seite verwaltbar; pausieren jederzeit möglich.`,
          confidence: 0.8,
          sourceData: { router: true, urgency: 'low', autoCreated: true, storedAt: new Date().toISOString() },
          dedupeKey: `interest-auto:${s.name.toLowerCase()}`,
        }).catch(() => { /* non-critical */ });
      } else {
        if (!this.insightsRepo) continue;
        const r = await this.insightsRepo.upsertCandidate(this.ownerUserId, {
          category: 'interest-suggestion',
          title: `Interesse erkannt: ${s.name}`,
          body: `Alfred hat **${s.name}** als wiederkehrendes Thema in deinen Gesprächen erkannt.\n\n_Begründung: ${s.warum}_\n\nSoll Alfred das Thema laufend beobachten (RSS + Web-Suche, still gesammelt, abrufbar per „Was gibt's Neues zu ${s.name}?")?`,
          confidence: 0.65,
          sourceData: {
            actionLabel: 'Thema anlegen',
            suggestedKeywords: s.keywords,
            warum: s.warum,
          },
          actionSkill: 'interests',
          actionParams: { action: 'create_topic', name: s.name, keywords: s.keywords },
          dedupeKey: `interest-suggest:${s.name.toLowerCase()}`,
        });
        if (r.inserted) out.suggested.push(s.name);
      }
    }

    if (out.autoCreated.length || out.suggested.length) {
      this.logger.info(out, 'v930 interest detection done');
    }
    return out;
  }

  private buildPrompt(signals: DetectorSignals, existingTopics: string[]): string {
    const entityLines = signals.entities.slice(0, 30)
      .map(e => `- ${e.name} (${e.type}, ${e.mentions}× erwähnt)`).join('\n');
    const summaryLines = signals.recentSummaries.slice(0, 10)
      .map(s => `- ${s.slice(0, 200)}`).join('\n');
    return `Du erkennst DAUERHAFTE INTERESSEN-THEMEN eines Users, die es wert sind laufend beobachtet zu werden (News/RSS/Web-Suche).

Häufig erwähnte Entities aus dem Wissensgraph:
${entityLines || '(keine)'}

Jüngste Gesprächs-Zusammenfassungen:
${summaryLines || '(keine)'}

BEREITS BEOBACHTETE Themen (NICHT nochmal vorschlagen): ${existingTopics.length ? existingTopics.join(', ') : '(keine)'}

Regeln:
- NUR Themen mit News-/Entwicklungs-Charakter (Technologien, Märkte, Produkte, Hobbys mit laufenden Entwicklungen, Verkaufs-/Kaufvorhaben).
- KEINE Personen, Orte, Haushaltsgeräte, einmalige Aufgaben oder interne Systeme.
- strength=strong NUR wenn das Thema mehrfach über verschiedene Gespräche hinweg auftaucht UND klar von Dauer ist. Im Zweifel medium.
- Maximal 3 Vorschläge. Wenn nichts Substanzielles: leeres Array.

Antworte NUR mit einem JSON-Array:
[{"name": "…", "keywords": ["…", "…"], "strength": "strong|medium", "warum": "1 Satz Begründung"}]`;
  }
}
