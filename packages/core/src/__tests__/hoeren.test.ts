import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { HoerRelais, NACHLAUF_MS, type UpstreamSocket } from '../geraete/hoeren.js';

// v1251 — Relais: Protokollübersetzung Sitzung ⇄ Mistral Realtime mit gefälschtem Anbieter und gefälschter Sitzung.
class FakeUpstream extends EventEmitter implements UpstreamSocket {
  readonly gesendet: string[] = [];
  readyState = 0;
  send(d: string): void { this.gesendet.push(d); }
  close(): void { this.readyState = 3; this.emit('close'); }
  oeffne(): void { this.readyState = 1; this.emit('open'); }
}
class FakeWs extends EventEmitter { readyState = 1; readonly raus: string[] = []; send(d: string): void { this.raus.push(d); } close(): void { this.readyState = 3; } }

function relais(up: FakeUpstream, verbuche = vi.fn(), max?: number) {
  const r = new HoerRelais({
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never,
    authentifiziere: async () => ({ userId: 'u', geraetId: 'g1', name: 'PC' }),
    mistralKey: () => 'k', upstreamFabrik: () => up, verbuche, maxMinutenProTag: max, now: () => Date.parse('2026-10-07T00:00:00Z'),
  });
  const ws = new FakeWs();
  (r as unknown as { starte: (w: unknown, g: unknown) => void }).starte(ws, { geraetId: 'g1', name: 'PC' });
  return { r, ws };
}

describe('HoerRelais', () => {
  it('übersetzt Audio und Ende nach Mistral und Deltas/Fertig zurück, verbucht Sekunden', () => {
    const up = new FakeUpstream(); const verbuche = vi.fn();
    const { ws } = relais(up, verbuche);
    expect(JSON.parse(ws.raus[0])).toEqual({ typ: 'bereit' });
    ws.emit('message', Buffer.from('{"typ":"start"}'), false);
    ws.emit('message', Buffer.alloc(32_000, 1), true); // 1 s Audio, noch vor open → wartet
    up.oeffne();
    expect(JSON.parse(up.gesendet[0])).toMatchObject({ type: 'session.update', session: { audio_format: { encoding: 'pcm_s16le', sample_rate: 16000 }, target_streaming_delay_ms: 480 } });
    expect(JSON.parse(up.gesendet[1]).type).toBe('input_audio.append');
    ws.emit('message', Buffer.alloc(16_000, 1), true); // 0,5 s
    ws.emit('message', Buffer.from('{"typ":"ende"}'), false);
    expect(JSON.parse(up.gesendet[3])).toEqual({ type: 'input_audio.flush' });
    up.emit('message', JSON.stringify({ type: 'transcription.text.delta', text: 'Hallo' }));
    up.emit('message', JSON.stringify({ type: 'transcription.text.delta', text: ' Welt' }));
    up.emit('message', JSON.stringify({ type: 'transcription.done', text: 'Hallo Welt', usage: { prompt_audio_seconds: 1 } }));
    const raus = ws.raus.map(x => JSON.parse(x));
    expect(raus[1]).toEqual({ typ: 'delta', text: 'Hallo' });
    expect(raus[3]).toEqual({ typ: 'fertig', text: 'Hallo Welt', sekunden: 1.5 });
    expect(verbuche).toHaveBeenCalledWith(1.5, 'voxtral-mini-transcribe-realtime-2602');
    ws.emit('message', Buffer.from('{"typ":"schluss"}'), false);
    expect(JSON.parse(up.gesendet[up.gesendet.length - 1])).toEqual({ type: 'input_audio.end' });
  });
  it('Tageslimit stoppt weiteres Audio', () => {
    const up = new FakeUpstream();
    const { r, ws } = relais(up, vi.fn(), 1); // 1 Minute
    up.oeffne();
    ws.emit('message', Buffer.alloc(32_000 * 61, 0), true); // 61 s in einem Rahmen (Test)
    ws.emit('message', Buffer.from('{"typ":"ende"}'), false);
    up.emit('message', JSON.stringify({ type: 'transcription.done', text: 'x' }));
    ws.emit('message', Buffer.alloc(3200, 0), true);
    const letzte = JSON.parse(ws.raus[ws.raus.length - 1]);
    expect(letzte.typ).toBe('limit');
    expect(r.aktive()[0]).toMatchObject({ geraet: 'PC', sekunden: 61 });
  });
  // v1346 — Realfall 10.10. 22:57: Ton ohne Ende (App verstummt, weil Alfred antwortet) → Mistral 3804 nach 30 s, Satz verloren.
  it('schließt eine Äußerung ohne Ende nach dem Nachlauf selbst ab (kein 3804)', () => {
    vi.useFakeTimers();
    try {
      const up = new FakeUpstream();
      const { ws } = relais(up);
      ws.emit('message', Buffer.alloc(32_000, 1), true);
      up.oeffne();
      vi.advanceTimersByTime(NACHLAUF_MS - 100);
      expect(up.gesendet.some(x => JSON.parse(x).type === 'input_audio.flush')).toBe(false);
      ws.emit('message', Buffer.alloc(3_200, 1), true); // weiterer Ton verlängert den Nachlauf
      vi.advanceTimersByTime(NACHLAUF_MS - 100);
      expect(up.gesendet.some(x => JSON.parse(x).type === 'input_audio.flush')).toBe(false);
      vi.advanceTimersByTime(200);
      expect(up.gesendet.filter(x => JSON.parse(x).type === 'input_audio.flush')).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });
  it('kein zusätzlicher Flush, wenn die Sitzung das Ende selbst schickt', () => {
    vi.useFakeTimers();
    try {
      const up = new FakeUpstream();
      const { ws } = relais(up);
      ws.emit('message', Buffer.alloc(32_000, 1), true);
      up.oeffne();
      ws.emit('message', Buffer.from('{"typ":"ende"}'), false);
      vi.advanceTimersByTime(NACHLAUF_MS * 3);
      expect(up.gesendet.filter(x => JSON.parse(x).type === 'input_audio.flush')).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });
  it('Anbieter schließt mit offenem Ton → nächste Äußerung auf frischer Verbindung', () => {
    const erste = new FakeUpstream(); const zweite = new FakeUpstream();
    const fabrik = vi.fn().mockReturnValueOnce(erste).mockReturnValueOnce(zweite);
    const r = new HoerRelais({
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never,
      authentifiziere: async () => ({ userId: 'u', geraetId: 'g1', name: 'PC' }),
      mistralKey: () => 'k', upstreamFabrik: fabrik, now: () => Date.parse('2026-10-07T00:00:00Z'),
    });
    const ws = new FakeWs();
    (r as unknown as { starte: (w: unknown, g: unknown) => void }).starte(ws, { geraetId: 'g1', name: 'PC' });
    ws.emit('message', Buffer.alloc(32_000, 1), true);
    erste.oeffne();
    erste.emit('message', JSON.stringify({ type: 'error', error: { message: 'Timeout waiting for response from streaming transcription.', code: 3804 } }));
    erste.close();
    ws.emit('message', Buffer.alloc(3_200, 1), true);
    expect(fabrik).toHaveBeenCalledTimes(2);
    expect(JSON.parse(ws.raus[1])).toMatchObject({ typ: 'fehler' });
  });
});
