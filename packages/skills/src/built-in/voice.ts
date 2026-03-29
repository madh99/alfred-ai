import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../skill.js';
import type { MemoryRepository } from '@alfred/storage';
import { effectiveUserId } from '../user-utils.js';

type VoiceAction = 'create_voice' | 'list_voices' | 'delete_voice' | 'speak' | 'announce' | 'set_default';

interface MistralVoice {
  id: string;
  name: string;
  languages?: string[];
  gender?: string;
  created_at?: string;
}

export class VoiceSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'voice',
    category: 'media',
    description:
      'Voice management: create custom voices from audio samples, generate speech with custom voices, ' +
      'make Sonos announcements. Actions: create_voice, list_voices, delete_voice, speak, announce, set_default',
    riskLevel: 'write',
    version: '1.0.0',
    timeoutMs: 60_000,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create_voice', 'list_voices', 'delete_voice', 'speak', 'announce', 'set_default'],
          description: 'The voice action to perform',
        },
        name: { type: 'string', description: 'Voice name (for create_voice)' },
        voice_id: { type: 'string', description: 'Voice ID (for delete_voice, speak, announce, set_default)' },
        text: { type: 'string', description: 'Text to speak (for speak, announce)' },
        room: { type: 'string', description: 'Sonos room name (for announce)' },
        sample_audio: { type: 'string', description: 'Base64-encoded audio sample (for create_voice)' },
        languages: {
          type: 'array',
          items: { type: 'string' },
          description: 'Voice languages, e.g. ["de", "en"] (for create_voice)',
        },
        gender: {
          type: 'string',
          enum: ['male', 'female'],
          description: 'Voice gender (for create_voice)',
        },
        format: {
          type: 'string',
          enum: ['mp3', 'wav', 'pcm', 'opus', 'flac', 'aac'],
          description: 'Audio output format (default: mp3)',
        },
      },
      required: ['action'],
    },
  };

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = 'https://api.mistral.ai/v1',
    private readonly model: string = 'voxtral-mini-tts-2603',
    private readonly memoryRepo: MemoryRepository,
  ) {
    super();
  }

  async execute(
    input: Record<string, unknown>,
    context: SkillContext,
  ): Promise<SkillResult> {
    const action = input.action as VoiceAction;
    if (!action) {
      return { success: false, error: 'No action specified.' };
    }

    try {
      switch (action) {
        case 'create_voice': return await this.createVoice(input, context);
        case 'list_voices': return await this.listVoices();
        case 'delete_voice': return await this.deleteVoice(input, context);
        case 'speak': return await this.speak(input, context);
        case 'announce': return await this.announce(input, context);
        case 'set_default': return await this.setDefault(input, context);
        default:
          return { success: false, error: `Unknown action: ${action}` };
      }
    } catch (err) {
      return {
        success: false,
        error: `Voice action '${action}' failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // ── create_voice ──────────────────────────────────────────────────────
  private async createVoice(
    input: Record<string, unknown>,
    context: SkillContext,
  ): Promise<SkillResult> {
    const name = input.name as string | undefined;
    const sampleAudio = input.sample_audio as string | undefined;
    const languages = (input.languages as string[] | undefined) ?? ['de', 'en'];
    const gender = input.gender as string | undefined;

    if (!name) return { success: false, error: 'Missing required parameter: name' };
    if (!sampleAudio) return { success: false, error: 'Missing required parameter: sample_audio (base64-encoded audio)' };

    const body: Record<string, unknown> = {
      name,
      sample_audio: sampleAudio,
      sample_filename: 'sample.wav',
      languages,
    };
    if (gender) body.gender = gender;

    const resp = await fetch(`${this.baseUrl}/audio/voices`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Mistral Voices API: ${resp.status} ${errText}`);
    }

    const voice = await resp.json() as MistralVoice;
    const userId = effectiveUserId(context);
    await this.memoryRepo.save(
      userId,
      `voice_${name.toLowerCase().replace(/\s+/g, '_')}`,
      JSON.stringify({ voice_id: voice.id, name: voice.name, languages: voice.languages }),
      'voice',
    );

    return {
      success: true,
      data: voice,
      display: `Voice "${voice.name}" erstellt (ID: ${voice.id}).`,
    };
  }

  // ── list_voices ───────────────────────────────────────────────────────
  private async listVoices(): Promise<SkillResult> {
    const resp = await fetch(`${this.baseUrl}/audio/voices`, {
      method: 'GET',
      headers: this.headers(),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Mistral Voices API: ${resp.status} ${errText}`);
    }

    const data = await resp.json() as { data?: MistralVoice[] } | MistralVoice[];
    const voices: MistralVoice[] = Array.isArray(data) ? data : (data.data ?? []);

    if (voices.length === 0) {
      return { success: true, data: [], display: 'Keine Custom Voices vorhanden.' };
    }

    const lines = voices.map(v =>
      `- ${v.name} (ID: ${v.id}, Sprachen: ${(v.languages ?? []).join(', ')}, Geschlecht: ${v.gender ?? 'k.A.'})`,
    );
    return {
      success: true,
      data: voices,
      display: `**Custom Voices (${voices.length}):**\n${lines.join('\n')}`,
    };
  }

  // ── delete_voice ──────────────────────────────────────────────────────
  private async deleteVoice(
    input: Record<string, unknown>,
    context: SkillContext,
  ): Promise<SkillResult> {
    const voiceId = input.voice_id as string | undefined;
    if (!voiceId) return { success: false, error: 'Missing required parameter: voice_id' };

    const resp = await fetch(`${this.baseUrl}/audio/voices/${encodeURIComponent(voiceId)}`, {
      method: 'DELETE',
      headers: this.headers(),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Mistral Voices API: ${resp.status} ${errText}`);
    }

    // Clean up matching memory entries
    const userId = effectiveUserId(context);
    const memories = await this.memoryRepo.search(userId, voiceId);
    for (const mem of memories) {
      if (mem.category === 'voice' && mem.value.includes(voiceId)) {
        await this.memoryRepo.delete(userId, mem.key);
      }
    }

    // If this was the default voice, remove the default memory too
    const defaultMem = await this.memoryRepo.recall(userId, 'voice_default');
    if (defaultMem?.value === voiceId) {
      await this.memoryRepo.delete(userId, 'voice_default');
    }

    return {
      success: true,
      display: `Voice ${voiceId} gelöscht.`,
    };
  }

  // ── speak ─────────────────────────────────────────────────────────────
  private async speak(
    input: Record<string, unknown>,
    context: SkillContext,
  ): Promise<SkillResult> {
    const text = input.text as string | undefined;
    if (!text) return { success: false, error: 'Missing required parameter: text' };

    const voiceId = await this.resolveVoiceId(input.voice_id as string | undefined, context);
    const format = (input.format as string | undefined) ?? 'mp3';

    const body: Record<string, unknown> = {
      model: this.model,
      input: text,
      response_format: format,
    };
    if (voiceId) body.voice_id = voiceId;

    const resp = await fetch(`${this.baseUrl}/audio/speech`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Mistral TTS API: ${resp.status} ${errText}`);
    }

    const audioBuffer = Buffer.from(await resp.arrayBuffer());
    const mimeType = this.formatToMime(format);
    const ext = format === 'pcm' ? 'raw' : format;

    return {
      success: true,
      display: `Sprache generiert${voiceId ? ` (Voice: ${voiceId})` : ''}.`,
      attachments: [{
        fileName: `speech.${ext}`,
        data: audioBuffer,
        mimeType,
      }],
    };
  }

  // ── announce ──────────────────────────────────────────────────────────
  private async announce(
    input: Record<string, unknown>,
    context: SkillContext,
  ): Promise<SkillResult> {
    const text = input.text as string | undefined;
    const room = input.room as string | undefined;
    if (!text) return { success: false, error: 'Missing required parameter: text' };

    // Generate the audio first (same as speak)
    const voiceId = await this.resolveVoiceId(input.voice_id as string | undefined, context);
    const format = 'mp3'; // MP3 for broadest Sonos compatibility

    const body: Record<string, unknown> = {
      model: this.model,
      input: text,
      response_format: format,
    };
    if (voiceId) body.voice_id = voiceId;

    const resp = await fetch(`${this.baseUrl}/audio/speech`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Mistral TTS API: ${resp.status} ${errText}`);
    }

    const audioBuffer = Buffer.from(await resp.arrayBuffer());

    // Return audio with guidance on Sonos playback
    const roomHint = room ? ` im Raum "${room}"` : '';
    return {
      success: true,
      display: `Audio-Durchsage generiert${roomHint}. Sage "Spiel das auf ${room ?? '[Raumname]'} ab" um es über Sonos abzuspielen.`,
      data: { room, voiceId, format },
      attachments: [{
        fileName: 'announcement.mp3',
        data: audioBuffer,
        mimeType: 'audio/mpeg',
      }],
    };
  }

  // ── set_default ───────────────────────────────────────────────────────
  private async setDefault(
    input: Record<string, unknown>,
    context: SkillContext,
  ): Promise<SkillResult> {
    const voiceId = input.voice_id as string | undefined;
    if (!voiceId) return { success: false, error: 'Missing required parameter: voice_id' };

    const userId = effectiveUserId(context);
    await this.memoryRepo.save(userId, 'voice_default', voiceId, 'voice');

    return {
      success: true,
      display: `Default-Voice auf ${voiceId} gesetzt.`,
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────
  private headers(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  private async resolveVoiceId(
    explicitId: string | undefined,
    context: SkillContext,
  ): Promise<string | undefined> {
    if (explicitId) return explicitId;

    // Check for a user-specific default voice in memory
    const userId = effectiveUserId(context);
    const defaultMem = await this.memoryRepo.recall(userId, 'voice_default');
    return defaultMem?.value ?? undefined;
  }

  private formatToMime(format: string): string {
    switch (format) {
      case 'mp3': return 'audio/mpeg';
      case 'wav': return 'audio/wav';
      case 'opus': return 'audio/opus';
      case 'flac': return 'audio/flac';
      case 'aac': return 'audio/aac';
      case 'pcm': return 'audio/pcm';
      default: return 'audio/mpeg';
    }
  }
}
