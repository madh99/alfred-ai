import { describe, it, expect, vi, afterEach } from 'vitest';
import { SpeechSynthesizer } from '../speech-synthesizer.js';

// v1534 — Realfall 20.10.: Namensauflösung der Standardstimme über die Anbieterliste scheiterte ab 13:27 still → Server-Standardstimme
describe('v1534 Standardstimme', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
  const ablage = (werte: Record<string, string>) => ({ get: async (_u: string, _s: string, k: string) => werte[k] }) as never;

  function mitAnbieter(listeOk: boolean) {
    const gesendet: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
      if (String(url).endsWith('/audio/voices')) return listeOk ? new Response(JSON.stringify({ items: [{ id: '99999999-0000-0000-0000-000000000000', name: 'alfred-jav' }] })) : new Response('{"detail":"x"}', { status: 401 });
      gesendet.push(JSON.parse(String(init?.body ?? '{}')).voice_id);
      return new Response(JSON.stringify({ audio_data: Buffer.from('mp3').toString('base64') }));
    }));
    return gesendet;
  }

  it('eigene Ablage zuerst: Anbieterliste kaputt → trotzdem die eingestellte Stimme', async () => {
    const gesendet = mitAnbieter(false);
    const s = new SpeechSynthesizer({ ttsProvider: 'mistral', apiKey: 'k', defaultVoiceId: 'ced5e629-0000-0000-0000-000000000000' } as never, logger);
    s.setSkillState(ablage({ voice_default: 'alfred-jav', 'voice_alfred-jav': JSON.stringify({ voice_id: '01a1129f-15fc-72ae-a21d-07f6be678385', name: 'alfred-jav' }) }));
    await s.synthesize('Hallo', 'owner').catch(() => undefined);
    expect(gesendet[0]).toBe('01a1129f-15fc-72ae-a21d-07f6be678385');
  });

  it('ohne Ablage-Eintrag: Anbieterliste; fällt sie aus, bleibt die zuletzt gültige Stimme', async () => {
    let gesendet = mitAnbieter(true);
    const s = new SpeechSynthesizer({ ttsProvider: 'mistral', apiKey: 'k', defaultVoiceId: 'ced5e629-0000-0000-0000-000000000000' } as never, logger);
    s.setSkillState(ablage({ voice_default: 'alfred-jav' }));
    await s.synthesize('Eins', 'owner').catch(() => undefined);
    expect(gesendet[0]).toBe('99999999-0000-0000-0000-000000000000');
    (s as unknown as { cachedVoiceAt: number }).cachedVoiceAt = 0; // Zwischenspeicher abgelaufen
    gesendet = mitAnbieter(false);
    await s.synthesize('Zwei', 'owner').catch(() => undefined);
    expect(gesendet[0]).toBe('99999999-0000-0000-0000-000000000000');
  });
});
