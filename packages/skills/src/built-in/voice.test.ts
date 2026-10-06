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

// v1244 — set_default speichert die UUID, auch wenn der Owner den Namen nennt.
describe('VoiceSkill set_default', () => {
  it('löst den Namen über die Stimmenliste auf und speichert die UUID', async () => {
    const gespeichert: Record<string, string> = {};
    const skillState = { get: vi.fn().mockResolvedValue(undefined), set: vi.fn(async (_u: string, _s: string, k: string, v: string) => { gespeichert[k] = v; }) };
    const memoryRepo = { save: vi.fn().mockResolvedValue(undefined), recall: vi.fn().mockResolvedValue(undefined) } as unknown as MemoryRepository;
    const skill = new VoiceSkill('test-key', 'https://mistral.test/v1', 'voxtral-mini-tts-2603', memoryRepo, undefined, undefined, skillState as never);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [{ id: '01a1129f-15fc-72ae-a21d-07f6be678385', name: 'alfred-jav' }] }) });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const r = await skill.execute({ action: 'set_default', voice_id: 'alfred-jav' }, { userId: 'u1' } as unknown as SkillContext);
      expect(r.success).toBe(true);
      expect(gespeichert.voice_default).toBe('01a1129f-15fc-72ae-a21d-07f6be678385');
      const r2 = await skill.execute({ action: 'set_default', voice_id: 'gibt-es-nicht' }, { userId: 'u1' } as unknown as SkillContext);
      expect(r2.success).toBe(false);
    } finally { vi.unstubAllGlobals(); }
  });
});

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

  it('list_voices liest das items-Feld der Mistral-Antwort (Live-Format 09.07.)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ id: 'v-1', name: 'SprecherEins', languages: ['de'] }, { id: 'v-2', name: 'Stefan', gender: 'male' }] }),
    });
    const r = await makeSkill().execute({ action: 'list_voices' }, ctx);
    expect(r.success).toBe(true);
    expect((r.data as Array<{ id: string }>).map(v => v.id)).toEqual(['v-1', 'v-2']);
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
