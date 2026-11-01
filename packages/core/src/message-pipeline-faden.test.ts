import { describe, expect, it } from 'vitest';
import { MessagePipeline, fadenSperrePflicht } from './message-pipeline.js';

describe('v1723 — Durchgänge eines Owner-Fadens laufen nacheinander', () => {
  const pipe = () => {
    const p = Object.create(MessagePipeline.prototype) as unknown as { fadenLaeufe: Map<string, Promise<unknown>>; logger: { info: () => void }; nacheinander: <T>(c: string, f: () => Promise<T>) => Promise<T> };
    p.fadenLaeufe = new Map(); p.logger = { info: () => undefined };
    return p;
  };
  it('zweiter Durchgang startet erst nach dem ersten, andere Fäden parallel', async () => {
    const p = pipe(); const log: string[] = [];
    const lang = (n: string, ms: number) => async () => { log.push(`start ${n}`); await new Promise(r => setTimeout(r, ms)); log.push(`ende ${n}`); return n; };
    const a = p.nacheinander('owner:faden:x', lang('a', 50));
    const b = p.nacheinander('owner:faden:x', lang('b', 5));
    const c = p.nacheinander('owner:faden:y', lang('c', 5));
    await Promise.all([a, b, c]);
    expect(log.indexOf('start b')).toBeGreaterThan(log.indexOf('ende a'));
    expect(log.indexOf('start c')).toBeLessThan(log.indexOf('ende a'));
    expect(p.fadenLaeufe.size).toBe(0);
  });
  it('ein Fehler im ersten blockiert den zweiten nicht', async () => {
    const p = pipe();
    const a = p.nacheinander('owner:faden:x', async () => { throw new Error('x'); });
    const b = p.nacheinander('owner:faden:x', async () => 'ok');
    await expect(a).rejects.toThrow('x');
    await expect(b).resolves.toBe('ok');
  });
  it('nur Owner-Fäden', () => {
    expect(fadenSperrePflicht('owner:faden:infra-cf82f3f2')).toBe(true);
    expect(fadenSperrePflicht('5060785419')).toBe(false);
    expect(fadenSperrePflicht(undefined)).toBe(false);
  });
});
