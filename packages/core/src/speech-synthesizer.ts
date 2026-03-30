import type { SpeechConfig } from '@alfred/types';
import type { MemoryRepository, SkillStateRepository } from '@alfred/storage';
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
  private memoryRepo?: MemoryRepository;
  private skillState?: SkillStateRepository;
  private cachedVoiceId?: string;

  /** Inject skill state repo for reading user's default voice from DB. */
  setSkillState(repo: SkillStateRepository): void { this.skillState = repo; }
  /** @deprecated Use setSkillState instead. Kept for backward compatibility. */
  setMemoryRepo(repo: MemoryRepository): void { this.memoryRepo = repo; }

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

  async synthesize(text: string, userId?: string): Promise<Buffer> {
    // Resolve voice: 1) config defaultVoiceId, 2) DB voice_default memory, 3) built-in fallback
    let effectiveVoice = this.defaultVoiceId;

    if (!effectiveVoice && this.ttsProvider === 'mistral' && userId) {
      // Read user's default voice from DB (cached for performance)
      if (!this.cachedVoiceId) {
        try {
          if (this.skillState) {
            const val = await this.skillState.get(userId, 'voice', 'voice_default');
            if (val) this.cachedVoiceId = val;
          } else if (this.memoryRepo) {
            const mem = await this.memoryRepo.recall(userId, 'voice_default');
            if (mem?.value) this.cachedVoiceId = mem.value;
          }
        } catch { /* ignore */ }
      }
      effectiveVoice = this.cachedVoiceId;
    }

    if (!effectiveVoice) effectiveVoice = this.voice;

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
