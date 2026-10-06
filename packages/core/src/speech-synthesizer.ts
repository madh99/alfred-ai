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
  /** v1244 — Cache der Owner-Standardstimme läuft ab, damit „set_default" ohne Neustart wirkt. */
  private cachedVoiceAt = 0;
  private static readonly VOICE_CACHE_MS = 60_000;
  private usageCallback?: (model: string, units: number) => void;

  /** Set callback for tracking service usage (called with model + character count). */
  setUsageCallback(cb: (model: string, units: number) => void): void { this.usageCallback = cb; }
  /** Inject skill state repo for reading user's default voice from DB. */
  setSkillState(repo: SkillStateRepository): void { this.skillState = repo; }
  /** @deprecated Use setSkillState instead. Kept for backward compatibility. */
  setMemoryRepo(repo: MemoryRepository): void { this.memoryRepo = repo; }

  /** v1244 — Stimmenname → UUID über die Stimmenliste des Anbieters (Mistral). */
  private async loeseStimmennameAuf(name: string): Promise<string | undefined> {
    try {
      const resp = await fetch(`${this.baseUrl}/audio/voices`, { headers: { Authorization: `Bearer ${this.apiKey}` } });
      if (!resp.ok) return undefined;
      const data = await resp.json() as { items?: Array<{ id: string; name: string }> };
      const treffer = (data.items ?? []).find(v => v.name.toLowerCase() === name.toLowerCase());
      if (treffer) this.logger.info({ name, voiceId: treffer.id }, 'v1244 Standardstimme per Name aufgelöst');
      return treffer?.id;
    } catch { return undefined; }
  }

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

  async synthesize(text: string, userId?: string, voiceId?: string): Promise<Buffer> {
    // v1244 — Kaskade (Owner-Wunsch „immer mit alfred-jav sprechen"): 1) voiceId-Parameter (z. B. Reel-Sprecher),
    // 2) vom Owner gesetzte Standardstimme (DB voice_default, Name wird zur UUID aufgelöst), 3) config defaultVoiceId
    // (ALFRED_TTS_VOICE_ID), 4) eingebauter Fallback. Vorher schlug die Konfiguration die Owner-Wahl.
    let effectiveVoice = voiceId?.trim() || undefined;

    if (!effectiveVoice && this.ttsProvider === 'mistral' && userId) {
      if (!this.cachedVoiceId || Date.now() - this.cachedVoiceAt > SpeechSynthesizer.VOICE_CACHE_MS) {
        try {
          let val: string | undefined;
          if (this.skillState) val = await this.skillState.get(userId, 'voice', 'voice_default') ?? undefined;
          else if (this.memoryRepo) val = (await this.memoryRepo.recall(userId, 'voice_default'))?.value ?? undefined;
          if (val && !/^[0-9a-f]{8}-/.test(val)) val = await this.loeseStimmennameAuf(val);
          this.cachedVoiceId = val || undefined;
          this.cachedVoiceAt = Date.now();
        } catch { /* ignore */ }
      }
      effectiveVoice = this.cachedVoiceId;
    }

    if (!effectiveVoice) effectiveVoice = this.defaultVoiceId;
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
    if (this.usageCallback) this.usageCallback(this.model, text.length);
    return buffer;
  }
}
