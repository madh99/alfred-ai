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

  it('v1062: offsetSec verschiebt den Start (Untertitel erst nach der Hook-Slide)', () => {
    const srt = buildPhraseSrt('Ein kurzer Text für die Phrasen im Reel hier.', 10, 5, 1.5);
    expect(srt).toContain('00:00:01,500 -->'); // erster Block startet am Offset
    expect(srt).not.toContain('00:00:00,000');
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

  it('v1066: Dauer-Branding-Ebene liegt über allem (overlay als letzter Schritt)', () => {
    const g = buildReelFilterGraph({
      slides: [{ motion: 'in', durationSec: 8 }, { motion: 'out', durationSec: 8 }],
      width: 1080, height: 1920, srtPathEscaped: '/tmp/s.srt', overlayInputIndex: 5,
    });
    expect(g.filterComplex).toContain('[5:v]scale=1080:1920[wm]');
    expect(g.filterComplex).toContain('[vpre][wm]overlay=0:0[vout]');
    expect(g.filterComplex.indexOf('subtitles')).toBeLessThan(g.filterComplex.indexOf('overlay=')); // Branding ÜBER den Untertiteln
    expect(g.outLabel).toBe('[vout]');
    // ohne Overlay-Index: unverändert direkt auf [vout]
    const g2 = buildReelFilterGraph({ slides: [{ motion: 'in', durationSec: 8 }], width: 1080, height: 1920 });
    expect(g2.filterComplex).not.toContain('overlay=');
  });

  it('v1060: KI-Clip-Slide — kein Ken-Burns, Trim + tpad für die Blende, xfade-Kette bleibt', () => {
    const g = buildReelFilterGraph({
      slides: [
        { motion: 'in', durationSec: 1.5 },                    // Hook (Bild)
        { motion: 'none', durationSec: 6, kind: 'video' },     // KI-Clip
        { motion: 'in', durationSec: 8 },                      // Standbild
      ],
      width: 1080, height: 1920,
    });
    expect((g.filterComplex.match(/zoompan/g) ?? []).length).toBe(2); // nur die Bilder
    expect(g.filterComplex).toContain('[1:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,trim=duration=6.000');
    expect(g.filterComplex).toContain('setpts=PTS-STARTPTS');
    expect(g.filterComplex).toContain('tpad=stop_mode=clone:stop_duration=0.5'); // deckt die Crossfade-Überlappung
    expect((g.filterComplex.match(/xfade/g) ?? []).length).toBe(2);
    expect((g.filterComplex.match(/format=yuv420p/g) ?? []).length).toBeGreaterThanOrEqual(3); // je Slide (Mix Bild/Video braucht gleiches Pixelformat)
    expect(g.totalSec).toBeCloseTo(15.5, 1);
  });
});

describe('buildReelAudioGraph (v1059/v1082)', () => {
  it('Voiceover + Musik: leises Bett mit Sidechain-Ducking, Fade-out am Ende', () => {
    const g = buildReelAudioGraph({ voiceIndex: 4, musicIndex: 5, totalSec: 30 });
    expect(g.outLabel).toBe('[aout]');
    expect(g.filterComplex).toContain('[4:a]loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000,apad,asplit=2');
    expect(g.filterComplex).toContain('volume=0.15[bed]'); // Default leise
    expect(g.filterComplex).toContain('sidechaincompress'); // Musik weicht der Stimme
    expect(g.filterComplex).toContain('amix=inputs=2:duration=first:normalize=0');
    expect(g.filterComplex).toContain('afade=t=out:st=28.500:d=1.5');
  });

  it('v1082: Stimme, Musik-Track und Master werden normalisiert (Klon-Stimme kam 12 dB zu leise)', () => {
    const g = buildReelAudioGraph({ voiceIndex: 4, musicIndex: 5, totalSec: 30 });
    // Musik-Track auf Referenzpegel VOR dem volume-Regler
    expect(g.filterComplex).toContain('[5:a]loudnorm=I=-9:TP=-1:LRA=9,aresample=48000,volume=0.15[bed]');
    // Master aufs Plattform-Ziel, VOR dem Fade-out (sonst pumpt loudnorm den Ausklang wieder hoch)
    expect(g.filterComplex).toMatch(/normalize=0,loudnorm=I=-14:TP=-1\.5:LRA=11,aresample=48000,afade=/);
  });

  it('nur Musik (kein Voiceover): kein Mix, Track normalisiert, Lautstärke geclampt, kein Master', () => {
    const g = buildReelAudioGraph({ musicIndex: 3, musicVolume: 5, totalSec: 10 });
    expect(g.filterComplex).not.toContain('amix');
    expect(g.filterComplex).not.toContain('sidechaincompress');
    expect(g.filterComplex).toContain('[3:a]loudnorm=I=-9:TP=-1:LRA=9,aresample=48000,volume=1,'); // 5 → clamp auf 1
    expect(g.filterComplex).not.toContain('I=-14'); // Musik solo: das leise Bett ist der Inhalt
    expect(g.filterComplex).toContain('afade=t=out:st=8.500:d=1.5');
  });

  it('eigene Lautstärke wird übernommen', () => {
    const g = buildReelAudioGraph({ voiceIndex: 2, musicIndex: 3, musicVolume: 0.3, totalSec: 20 });
    expect(g.filterComplex).toContain('volume=0.3[bed]');
  });
});

describe('estimateSpeechSeconds (v938/v1076)', () => {
  it('~1,9 Wörter/Sekunde (deutsches TTS), min. 5s', () => {
    expect(estimateSpeechSeconds('kurz')).toBe(5);
    const text = Array.from({ length: 120 }, (_, i) => `wort${i}`).join(' ');
    expect(estimateSpeechSeconds(text)).toBe(63);
  });
});

describe('ExternalVideoProviderPlaceholder (v938)', () => {
  it('liefert klaren Aktivierungs-Hinweis statt still zu scheitern', async () => {
    const p = new ExternalVideoProviderPlaceholder('runway');
    await expect(p.generate()).rejects.toThrow(/vorbereitet aber nicht aktiviert/);
  });
});
