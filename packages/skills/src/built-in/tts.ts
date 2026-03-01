import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../skill.js';

/** Minimal synthesizer interface to avoid circular dep on @alfred/core. */
export interface SpeechSynthesizerInterface {
  synthesize(text: string): Promise<Buffer>;
}

export class TTSSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'text_to_speech',
    description: 'Convert text to a voice message and send it to the user. Use when the user asks for a voice/audio response or asks you to reply as a voice message.',
    riskLevel: 'read',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text to convert to speech' },
      },
      required: ['text'],
    },
  };

  constructor(private readonly synthesizer: SpeechSynthesizerInterface) {
    super();
  }

  async execute(
    input: Record<string, unknown>,
    _context: SkillContext,
  ): Promise<SkillResult> {
    const text = input.text as string;
    if (!text) {
      return { success: false, error: 'No text provided for speech synthesis.' };
    }

    try {
      const audioBuffer = await this.synthesizer.synthesize(text);
      return {
        success: true,
        display: 'Voice message sent.',
        attachments: [{
          fileName: 'voice.ogg',
          data: audioBuffer,
          mimeType: 'audio/ogg',
        }],
      };
    } catch (err) {
      return {
        success: false,
        error: `Speech synthesis failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}
