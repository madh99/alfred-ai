import type { SpeechConfig } from '@alfred/types';
import type { Logger } from 'pino';

/** Resolved STT provider: 'openai' | 'groq' | 'mistral'. */
type SttProvider = 'openai' | 'groq' | 'mistral';

export class SpeechTranscriber {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly sttProvider: SttProvider;
  private readonly model: string;

  constructor(
    config: SpeechConfig,
    private readonly logger: Logger,
  ) {
    // Determine effective STT provider
    this.sttProvider = config.sttProvider ?? (config.provider === 'groq' ? 'groq' : 'openai');

    // Use dedicated STT API key if provided, otherwise fall back to main speech key
    this.apiKey = config.sttApiKey ?? config.apiKey;

    // Resolve base URL and model per provider
    switch (this.sttProvider) {
      case 'mistral':
        this.baseUrl = 'https://api.mistral.ai/v1';
        this.model = 'mistral-stt-latest';
        break;
      case 'groq':
        this.baseUrl = config.baseUrl ?? 'https://api.groq.com/openai/v1';
        this.model = 'whisper-1';
        break;
      default:
        this.baseUrl = config.baseUrl ?? 'https://api.openai.com/v1';
        this.model = 'whisper-1';
        break;
    }
  }

  async transcribe(audioBuffer: Buffer, mimeType: string): Promise<string> {
    const ext = this.mimeToExtension(mimeType);
    const formData = new FormData();
    formData.append('file', new Blob([audioBuffer], { type: mimeType }), `audio.${ext}`);
    formData.append('model', this.model);

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
        throw new Error(`STT API (${this.sttProvider}) ${response.status}: ${errorText}`);
      }

      const data = await response.json() as { text: string };
      this.logger.info({ textLength: data.text.length, provider: this.sttProvider }, 'Voice transcribed');
      return data.text;
    } catch (err) {
      this.logger.error({ err, provider: this.sttProvider }, 'Voice transcription failed');
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
