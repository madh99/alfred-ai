import type { SpeechConfig } from '@alfred/types';
import type { Logger } from 'pino';

/** Resolved TTS provider. */
type TtsProvider = 'openai' | 'mistral';

export class SpeechSynthesizer {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly voice: string;
  private readonly defaultVoiceId?: string;
  private readonly ttsProvider: TtsProvider;

  constructor(config: SpeechConfig, private readonly logger: Logger) {
    this.ttsProvider = config.ttsProvider ?? 'openai';

    // Use dedicated TTS API key if provided, otherwise fall back to main speech key
    this.apiKey = config.ttsApiKey ?? config.apiKey;
    this.defaultVoiceId = config.defaultVoiceId;

    if (this.ttsProvider === 'mistral') {
      this.baseUrl = 'https://api.mistral.ai/v1';
      this.model = config.ttsModel ?? 'voxtral-mini-tts-2603';
      this.voice = config.ttsVoice ?? 'alloy';
    } else {
      this.baseUrl = config.baseUrl ?? 'https://api.openai.com/v1';
      this.model = config.ttsModel ?? 'tts-1';
      this.voice = config.ttsVoice ?? 'alloy';
    }
  }

  async synthesize(text: string): Promise<Buffer> {
    // For Mistral: prefer defaultVoiceId (custom voice) over generic ttsVoice
    const effectiveVoice = (this.ttsProvider === 'mistral' && this.defaultVoiceId) ? this.defaultVoiceId : this.voice;
    this.logger.info({ textLength: text.length, model: this.model, voice: effectiveVoice, provider: this.ttsProvider }, 'Synthesizing speech');

    // Mistral TTS REQUIRES a voice_id — there is no default voice fallback
    const MISTRAL_BUILTIN_VOICE = 'c69964a6-ab8b-4f8a-9465-ec0925096ec8'; // Paul - Neutral
    const mistralVoiceId = (effectiveVoice && /^[0-9a-f]{8}-/.test(effectiveVoice))
      ? effectiveVoice
      : MISTRAL_BUILTIN_VOICE;

    const body: Record<string, unknown> = this.ttsProvider === 'mistral'
      ? { model: this.model, input: text, voice_id: mistralVoiceId, response_format: 'mp3' }
      : { model: this.model, input: text, voice: effectiveVoice, response_format: 'opus' };

    const response = await fetch(`${this.baseUrl}/audio/speech`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`TTS (${this.ttsProvider}) failed: ${response.status} ${errorText}`);
    }

    let buffer: Buffer;
    if (this.ttsProvider === 'mistral') {
      // Mistral TTS returns JSON with base64-encoded audio_data
      const data = await response.json() as { audio_data?: string };
      if (!data.audio_data) throw new Error('Mistral TTS: No audio_data in response');
      buffer = Buffer.from(data.audio_data, 'base64');
    } else {
      // OpenAI returns raw audio stream
      buffer = Buffer.from(await response.arrayBuffer());
    }
    this.logger.info({ audioBytes: buffer.length, provider: this.ttsProvider }, 'Speech synthesized');
    return buffer;
  }
}
