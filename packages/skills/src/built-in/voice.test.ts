import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VoiceSkill } from './voice.js';
import type { SkillContext } from '@alfred/types';
import type { MemoryRepository } from '@alfred/storage';

// v1080 — Regressionstests für create_voice: Die base64-Heuristik verwarf
// echte Audio-Samples, weil deren base64 mit einem Buchstaben beginnt
// (WAV "UklGR", MP3 "SUQz", M4A "AAAA") — UI-Upload lief damit ins Leere.

const ctx = { userId: 'u1' } as unknown as SkillContext;

function makeSkill() {
  const memoryRepo = { save: vi.fn().mockResolvedValue(undefined) } as unknown as MemoryRepository;
  return new VoiceSkill('test-key', 'https://mistral.test/v1', 'voxtral-mini-tts-2603', memoryRepo);
}

describe('VoiceSkill create_voice — Sample-Erkennung', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'v-123', name: 'SprecherEins', languages: ['de', 'en'] }),
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('akzeptiert base64, das mit einem Buchstaben beginnt (WAV/MP3/M4A)', async () => {
    // WAV-typischer Anfang "UklGR" + genug Nutzdaten
    const wavBase64 = 'UklGR' + 'A'.repeat(200) + '==';
    const r = await makeSkill().execute({ action: 'create_voice', name: 'SprecherEins', sample_audio: wavBase64 }, ctx);
    expect(r.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(((fetchMock.mock.calls[0] as unknown[])[1] as { body: string }).body);
    expect(body.sample_audio).toBe(wavBase64);
    expect(body.sample_filename).toBe('sample.wav');
  });

  it('reicht den Original-Dateinamen als sample_filename durch', async () => {
    const mp3Base64 = 'SUQz' + 'B'.repeat(200);
    const r = await makeSkill().execute({ action: 'create_voice', name: 'SprecherEins', sample_audio: mp3Base64, sample_filename: 'probe.mp3' }, ctx);
    expect(r.success).toBe(true);
    const body = JSON.parse(((fetchMock.mock.calls[0] as unknown[])[1] as { body: string }).body);
    expect(body.sample_filename).toBe('probe.mp3');
  });

  it('verwirft LLM-Platzhalter weiterhin (kurz bzw. kein base64-Zeichensatz)', async () => {
    const short = await makeSkill().execute({ action: 'create_voice', name: 'X', sample_audio: 'from_attachment' }, ctx);
    expect(short.success).toBe(false);
    const sentence = 'bitte nimm die soeben gesendete sprachnachricht als sample fuer die neue stimme, danke dir vielmals! '.repeat(3);
    const prose = await makeSkill().execute({ action: 'create_voice', name: 'X', sample_audio: sentence }, ctx);
    expect(prose.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
