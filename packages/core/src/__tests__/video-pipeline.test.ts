import { describe, it, expect } from 'vitest';
import { buildSrt, estimateSpeechSeconds, ExternalVideoProviderPlaceholder } from '../video-pipeline.js';

describe('buildSrt (v938)', () => {
  it('verteilt Sätze gewichtet über die Laufzeit, SRT-Format korrekt', () => {
    const srt = buildSrt('Erster Satz. Und hier der deutlich längere zweite Satz mit mehr Inhalt!', 10);
    const blocks = srt.trim().split('\n\n');
    expect(blocks.length).toBe(2);
    expect(blocks[0]).toMatch(/^1\n00:00:00,000 --> 00:00:0\d,\d{3}\nErster Satz\.$/);
    expect(blocks[1]).toContain('Und hier der deutlich längere zweite Satz');
    // Endzeit des letzten Blocks ≈ Gesamtdauer
    expect(blocks[1]).toContain('--> 00:00:10,000');
  });

  it('leerer Text → leeres SRT', () => {
    expect(buildSrt('', 10)).toBe('');
    expect(buildSrt('   ', 10)).toBe('');
  });
});

describe('estimateSpeechSeconds (v938)', () => {
  it('~2,4 Wörter/Sekunde, min. 5s', () => {
    expect(estimateSpeechSeconds('kurz')).toBe(5);
    const text = Array.from({ length: 120 }, (_, i) => `wort${i}`).join(' ');
    expect(estimateSpeechSeconds(text)).toBe(50);
  });
});

describe('ExternalVideoProviderPlaceholder (v938)', () => {
  it('liefert klaren Aktivierungs-Hinweis statt still zu scheitern', async () => {
    const p = new ExternalVideoProviderPlaceholder('runway');
    await expect(p.generate()).rejects.toThrow(/vorbereitet aber nicht aktiviert/);
  });
});
