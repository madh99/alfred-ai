import type { SpeechConfig } from '@alfred/types';
import type { Logger } from 'pino';

export class SpeechSynthesizer {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly voice: string;

  constructor(config: SpeechConfig, private readonly logger: Logger) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? 'https://api.openai.com/v1';
    this.model = config.ttsModel ?? 'tts-1';
    this.voice = config.ttsVoice ?? 'alloy';
  }

  async synthesize(text: string): Promise<Buffer> {
    this.logger.info({ textLength: text.length, model: this.model, voice: this.voice }, 'Synthesizing speech');

    const response = await fetch(`${this.baseUrl}/audio/speech`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        input: text,
        voice: this.voice,
        response_format: 'opus',
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`TTS failed: ${response.status} ${errorText}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    this.logger.info({ audioBytes: buffer.length }, 'Speech synthesized');
    return buffer;
  }
}
