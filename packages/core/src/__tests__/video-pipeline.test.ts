import { describe, it, expect } from 'vitest';
import { buildSrt, buildPhraseSrt, buildReelFilterGraph, buildReelAudioGraph, estimateSpeechSeconds, ExternalVideoProviderPlaceholder } from '../video-pipeline.js';

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

describe('buildPhraseSrt (v1058)', () => {
  it('zerteilt in Phrasen ≤5 Wörter (Satzzeichen bevorzugt), Timing monoton, kein Mini-Rest', () => {
    const text = 'Drama im Aztekenstadion! England zittert sich mit drei zu zwei ins Viertelfinale, doch Mexiko kämpft bis zum Schluss zurück.';
    const srt = buildPhraseSrt(text, 20);
    const blocks = srt.trim().split('\n\n');
    expect(blocks.length).toBeGreaterThanOrEqual(4); // Phrasen, keine Satz-Wände
    for (const b of blocks) {
      const line = b.split('\n')[2];
      expect(line.split(' ').length).toBeLessThanOrEqual(7); // 5 + max. Mini-Rest 2
    }
    expect(blocks[0]).toContain('00:00:00,000 -->');
    const starts = blocks.map(b => b.split('\n')[1].split(' --> ')[0]);
    expect([...starts].sort()).toEqual(starts);
  });

  it('leerer Text → leeres SRT', () => {
    expect(buildPhraseSrt('', 10)).toBe('');
  });
});

describe('buildReelFilterGraph (v1058)', () => {
  it('Cover-Crop + Ken-Burns + Crossfades — KEIN Letterbox-Pad, End-Card statisch', () => {
    const g = buildReelFilterGraph({
      slides: [
        { motion: 'in', durationSec: 1.5 },   // Hook
        { motion: 'out', durationSec: 8 },
        { motion: 'in', durationSec: 8 },
        { motion: 'none', durationSec: 2 },   // End-Card
      ],
      width: 1080, height: 1920, srtPathEscaped: '/tmp/subs.srt',
    });
    expect(g.filterComplex).not.toContain('pad='); // Realfall: schwarze Balken
    expect(g.filterComplex).toContain('force_original_aspect_ratio=increase');
    expect(g.filterComplex).toContain('s=1080x1920');
    expect((g.filterComplex.match(/zoompan/g) ?? []).length).toBe(4);
    expect((g.filterComplex.match(/xfade/g) ?? []).length).toBe(3); // N-1 Übergänge
    expect(g.filterComplex).toContain("z='1'"); // End-Card ohne Zoom
    expect(g.filterComplex).toContain('force_style'); // Reel-Untertitel-Look
    expect(g.filterComplex).toContain('MarginV=48'); // Safe-Zone über der IG-UI
    expect(g.totalSec).toBeCloseTo(19.5, 1);
    const offsets = [...g.filterComplex.matchAll(/offset=([\d.]+)/g)].map(m => Number(m[1]));
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    expect(offsets[0]).toBeCloseTo(1.5, 2);
  });

  it('eine einzige Slide: kein xfade, Untertitel optional', () => {
    const g = buildReelFilterGraph({ slides: [{ motion: 'in', durationSec: 10 }], width: 1080, height: 1920 });
    expect(g.filterComplex).not.toContain('xfade');
    expect(g.filterComplex).not.toContain('subtitles');
    expect(g.totalSec).toBe(10);
  });
});

describe('buildReelAudioGraph (v1059)', () => {
  it('Voiceover + Musik: leises Bett mit Sidechain-Ducking, Fade-out am Ende', () => {
    const g = buildReelAudioGraph({ voiceIndex: 4, musicIndex: 5, totalSec: 30 });
    expect(g.outLabel).toBe('[aout]');
    expect(g.filterComplex).toContain('[4:a]apad,asplit=2');
    expect(g.filterComplex).toContain('[5:a]volume=0.15[bed]'); // Default leise
    expect(g.filterComplex).toContain('sidechaincompress'); // Musik weicht der Stimme
    expect(g.filterComplex).toContain('amix=inputs=2:duration=first:normalize=0');
    expect(g.filterComplex).toContain('afade=t=out:st=28.500:d=1.5');
  });

  it('nur Musik (kein Voiceover): kein Mix, Lautstärke geclampt', () => {
    const g = buildReelAudioGraph({ musicIndex: 3, musicVolume: 5, totalSec: 10 });
    expect(g.filterComplex).not.toContain('amix');
    expect(g.filterComplex).not.toContain('sidechaincompress');
    expect(g.filterComplex).toContain('[3:a]volume=1,'); // 5 → clamp auf 1
    expect(g.filterComplex).toContain('afade=t=out:st=8.500:d=1.5');
  });

  it('eigene Lautstärke wird übernommen', () => {
    const g = buildReelAudioGraph({ voiceIndex: 2, musicIndex: 3, musicVolume: 0.3, totalSec: 20 });
    expect(g.filterComplex).toContain('volume=0.3[bed]');
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
