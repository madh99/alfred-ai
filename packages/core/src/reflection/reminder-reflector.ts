import type { Logger } from 'pino';
import type { AsyncDbAdapter, MemoryRepository } from '@alfred/storage';
import type { ReflectionResult } from './types.js';

type ReminderConfig = {
  repeatPatternDays: number;
  quickDismissSeconds: number;
};

interface ReminderRow {
  id: string;
  message: string;
  trigger_at: string;
  fired: number;
  user_id: string;
  chat_id: string;
  created_at: string;
}

/**
 * Extract words with length >= minLen from text, lowercased.
 */
function extractWords(text: string, minLen = 4): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z\u00e4\u00f6\u00fc\u00df0-9]/g, ''))
    .filter((w) => w.length >= minLen);
}

export class ReminderReflector {
  constructor(
    private readonly adapter: AsyncDbAdapter | undefined,
    private readonly memoryRepo: MemoryRepository,
    private readonly logger: Logger,
    private readonly config: ReminderConfig,
  ) {}

  async reflect(userId: string): Promise<ReflectionResult[]> {
    if (!this.adapter) return [];

    const results: ReflectionResult[] = [];

    // Check 1: Active reminders matching resolved topics
    await this.checkResolvedTopics(userId, results);

    // Check 2: Same reminder message created 3+ times in repeatPatternDays
    await this.checkRepeatedReminders(userId, results);

    return results;
  }

  private async checkResolvedTopics(
    userId: string,
    results: ReflectionResult[],
  ): Promise<void> {
    try {
      const resolvedMemories = await this.memoryRepo.search(
        userId,
        'insight_resolved',
      );
      if (!resolvedMemories.length) return;

      // Collect topic words from all resolved memories
      const resolvedTopicSets = resolvedMemories.map((m) => {
        const combined = `${m.key} ${m.value}`;
        return extractWords(combined);
      });

      // Get active (unfired) reminders
      const activeReminders = (await this.adapter!.query(
        'SELECT id, message, trigger_at, fired FROM reminders WHERE user_id = ? AND fired = 0',
        [userId],
      )) as unknown as ReminderRow[];

      for (const reminder of activeReminders) {
        const reminderWords = extractWords(reminder.message);

        for (const topicWords of resolvedTopicSets) {
          const shared = reminderWords.filter((w) => topicWords.includes(w));
          if (shared.length >= 2) {
            results.push({
              target: { type: 'reminder', id: reminder.id, name: reminder.message },
              finding: `Reminder "${reminder.message}" betrifft ein bereits erledigtes Thema`,
              action: 'delete',
              risk: 'auto',
              reasoning: `Gemeinsame Begriffe (${shared.join(', ')}) mit resolved-Memory. Reminder ist obsolet.`,
            });
            break; // one match is enough
          }
        }
      }
    } catch (err) {
      this.logger.debug({ err }, 'ReminderReflector: checkResolvedTopics failed');
    }
  }

  private async checkRepeatedReminders(
    userId: string,
    results: ReflectionResult[],
  ): Promise<void> {
    try {
      const since = new Date(
        Date.now() - this.config.repeatPatternDays * 86400_000,
      ).toISOString();

      const repeated = (await this.adapter!.query(
        `SELECT message, COUNT(*) as cnt FROM reminders
         WHERE user_id = ? AND created_at >= ?
         GROUP BY message HAVING COUNT(*) >= 3`,
        [userId, since],
      )) as unknown as Array<{ message: string; cnt: number }>;

      for (const row of repeated) {
        results.push({
          target: { type: 'reminder', name: row.message },
          finding: `Reminder "${row.message}" wurde ${row.cnt}x in ${this.config.repeatPatternDays} Tagen erstellt`,
          action: 'suggest',
          params: { suggestRecurring: true, message: row.message },
          risk: 'confirm',
          reasoning: `Wiederkehrendes Muster erkannt (${row.cnt}x). Vorschlag: als wiederkehrenden Reminder einrichten.`,
        });
      }
    } catch (err) {
      this.logger.debug({ err }, 'ReminderReflector: checkRepeatedReminders failed');
    }
  }
}
