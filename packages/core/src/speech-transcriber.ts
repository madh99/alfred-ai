import type { SpeechConfig } from '@alfred/types';
import type { Logger } from 'pino';

export class SpeechTranscriber {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(
    config: SpeechConfig,
    private readonly logger: Logger,
  ) {
    this.apiKey = config.apiKey;

    if (config.provider === 'groq') {
      this.baseUrl = config.baseUrl ?? 'https://api.groq.com/openai/v1';
    } else {
      this.baseUrl = config.baseUrl ?? 'https://api.openai.com/v1';
    }
  }

  async transcribe(audioBuffer: Buffer, mimeType: string): Promise<string> {
    const ext = this.mimeToExtension(mimeType);
    const formData = new FormData();
    formData.append('file', new Blob([audioBuffer], { type: mimeType }), `audio.${ext}`);
    formData.append('model', 'whisper-1');

    try {
      const response = await fetch(`${this.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Whisper API ${response.status}: ${errorText}`);
      }

      const data = await response.json() as { text: string };
      this.logger.info({ textLength: data.text.length }, 'Voice transcribed');
      return data.text;
    } catch (err) {
      this.logger.error({ err }, 'Voice transcription failed');
      throw err;
    }
  }

  private mimeToExtension(mimeType: string): string {
    const map: Record<string, string> = {
      'audio/ogg': 'ogg',
      'audio/mpeg': 'mp3',
      'audio/mp4': 'm4a',
      'audio/wav': 'wav',
      'audio/webm': 'webm',
      'audio/x-m4a': 'm4a',
    };
    return map[mimeType] ?? 'ogg';
  }
}
