import { describe, it, expect } from 'vitest';
import { SatzendeErkenner, rms16, pcm16ZuWav } from '../interaktion/satzende.js';

// v1250 — Satzende-Erkennung auf synthetischem PCM: Rauschen, Ton, Rauschen.
function pcm(ms: number, amplitude: number, rate = 16000, seed = 1): Buffer {
  const n = Math.floor(rate * ms / 1000);
  const b = Buffer.alloc(n * 2);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const zufall = (x / 0x7fffffff) * 2 - 1;
    const wert = amplitude === 0 ? 0 : Math.round(amplitude * (amplitude > 500 ? Math.sin(i / 10) : zufall));
    b.writeInt16LE(Math.max(-32768, Math.min(32767, wert)), i * 2);
  }
  return b;
}

describe('SatzendeErkenner', () => {
  it('erkennt Start und Ende einer Äußerung im Rauschen und gibt nur die Sprache weiter', () => {
    const e = new SatzendeErkenner();
    const ereignisse = [
      ...e.schiebe(pcm(1500, 60)),      // Grundrauschen
      ...e.schiebe(pcm(1200, 4000)),    // Sprache 1,2 s
      ...e.schiebe(pcm(1000, 60)),      // Ruhe → Ende nach 700 ms
    ];
    expect(ereignisse.map(x => x.art)).toEqual(['start', 'ende']);
    const ende = ereignisse[1] as { art: 'ende'; audio: Buffer; dauerMs: number };
    expect(ende.dauerMs).toBeGreaterThanOrEqual(1100);
    expect(ende.dauerMs).toBeLessThanOrEqual(1400);
    // Audio enthält die Sprache plus Vorlauf und die Endruhe, aber nicht die 1,5 s Rauschen davor
    expect(ende.audio.length / 32).toBeLessThan(2300);
    expect(ende.audio.length / 32).toBeGreaterThan(1100);
  });
  it('verwirft kurze Knackser, beendet zu lange Äußerungen hart, schließt beim Stromende', () => {
    const e = new SatzendeErkenner({ maxDauerMs: 2000 });
    expect(e.schiebe(pcm(1000, 60)).length).toBe(0);
    const kurz = [...e.schiebe(pcm(120, 4000)), ...e.schiebe(pcm(900, 60))];
    expect(kurz.map(x => x.art)).toEqual(['start', 'verworfen']);
    const lang = e.schiebe(pcm(2500, 4000));
    // hartes Ende nach 2 s, der weiterlaufende Ton beginnt zu Recht eine neue Äußerung
    expect(lang.slice(0, 2).map(x => x.art)).toEqual(['start', 'ende']);
    expect((lang[1] as { dauerMs: number }).dauerMs).toBe(2000);
    expect(lang[2]?.art).toBe('start');
    const e2 = new SatzendeErkenner();
    e2.schiebe(pcm(500, 60)); e2.schiebe(pcm(800, 4000));
    expect(e2.spricht).toBe(true);
    expect(e2.schliesse().map(x => x.art)).toEqual(['ende']);
  });
  it('rms und WAV-Kopf', () => {
    expect(rms16(pcm(20, 0))).toBe(0);
    expect(rms16(pcm(20, 4000))).toBeGreaterThan(2000);
    const w = pcm16ZuWav(Buffer.alloc(3200), 16000);
    expect(w.toString('latin1', 0, 4)).toBe('RIFF');
    expect(w.readUInt32LE(24)).toBe(16000);
    expect(w.readUInt32LE(40)).toBe(3200);
    expect(w.length).toBe(3244);
  });
});
