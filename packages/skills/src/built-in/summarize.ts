import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../skill.js';

const DEFAULT_MAX_LENGTH = 280;

export class SummarizeSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'summarize',
    description: 'Produce an extractive summary of the given text',
    riskLevel: 'read',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The text to summarize',
        },
        maxLength: {
          type: 'number',
          description: 'Maximum character length for the summary (default: 280)',
        },
      },
      required: ['text'],
    },
  };

  async execute(
    input: Record<string, unknown>,
    _context: SkillContext,
  ): Promise<SkillResult> {
    const text = input.text as string;
    const maxLength = (input.maxLength as number | undefined) ?? DEFAULT_MAX_LENGTH;

    if (!text || typeof text !== 'string') {
      return {
        success: false,
        error: 'Invalid input: "text" must be a non-empty string',
      };
    }

    if (text.length <= maxLength) {
      return {
        success: true,
        data: { summary: text },
        display: text,
      };
    }

    const summary = this.extractiveSummarize(text, maxLength);

    return {
      success: true,
      data: { summary },
      display: summary,
    };
  }

  private extractiveSummarize(text: string, maxLength: number): string {
    // Split into sentences using common delimiters
    const sentences = text
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    if (sentences.length === 0) {
      return text.slice(0, maxLength);
    }

    // Build word frequency map (excluding common stop words)
    const wordFrequency = this.buildWordFrequency(text);

    // Score each sentence by the sum of its word frequencies
    const scored = sentences.map((sentence, index) => ({
      sentence,
      index,
      score: this.scoreSentence(sentence, wordFrequency),
    }));

    // Sort by score descending
    const ranked = [...scored].sort((a, b) => b.score - a.score);

    // Greedily pick top-scoring sentences until we exceed maxLength,
    // then re-sort by original order for coherence
    const selected: typeof scored = [];
    let currentLength = 0;

    for (const entry of ranked) {
      const addition = currentLength === 0 ? entry.sentence.length : entry.sentence.length + 1;

      if (currentLength + addition > maxLength) {
        continue;
      }

      selected.push(entry);
      currentLength += addition;
    }

    // If nothing was selected, take the first sentence truncated
    if (selected.length === 0) {
      return sentences[0].slice(0, maxLength);
    }

    // Re-sort by original order so the summary reads naturally
    selected.sort((a, b) => a.index - b.index);

    return selected.map((s) => s.sentence).join(' ');
  }

  private buildWordFrequency(text: string): Map<string, number> {
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
      'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
      'before', 'after', 'and', 'but', 'or', 'nor', 'not', 'so', 'yet',
      'both', 'either', 'neither', 'each', 'every', 'all', 'any', 'few',
      'more', 'most', 'other', 'some', 'such', 'no', 'only', 'own', 'same',
      'than', 'too', 'very', 'just', 'because', 'if', 'when', 'where',
      'how', 'what', 'which', 'who', 'whom', 'this', 'that', 'these',
      'those', 'it', 'its', 'i', 'me', 'my', 'we', 'our', 'you', 'your',
      'he', 'him', 'his', 'she', 'her', 'they', 'them', 'their',
    ]);

    const frequency = new Map<string, number>();
    const words = text.toLowerCase().match(/\b[a-z]+\b/g) ?? [];

    for (const word of words) {
      if (stopWords.has(word) || word.length < 3) {
        continue;
      }

      frequency.set(word, (frequency.get(word) ?? 0) + 1);
    }

    return frequency;
  }

  private scoreSentence(sentence: string, wordFrequency: Map<string, number>): number {
    const words = sentence.toLowerCase().match(/\b[a-z]+\b/g) ?? [];
    let score = 0;

    for (const word of words) {
      score += wordFrequency.get(word) ?? 0;
    }

    return score;
  }
}
