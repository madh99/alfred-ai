import { describe, it, expect } from 'vitest';
import { buildSrt, buildPhraseSrt, buildReelFilterGraph, buildReelAudioGraph, buildEditGraph, atempoChain, pickHighlightWindows, estimateSpeechSeconds, ExternalVideoProviderPlaceholder } from '../video-pipeline.js';

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

describe('buildEditGraph (v1088)', () => {
  it('trimmt, croppt auf Leinwand, verkettet mit Crossfade (Video + Ton) und rechnet die Gesamtdauer', () => {
    const g = buildEditGraph({
      clips: [
        { index: 0, audioIndex: 0, audioFromVideo: true, startSec: 2, durationSec: 10 },
        { index: 1, audioIndex: 2, audioFromVideo: false, startSec: 0, durationSec: 6 },
      ],
      width: 1080, height: 1920, fadeSec: 0.5,
    });
    expect(g.filterComplex).toContain('[0:v]trim=start=2:end=12,setpts=PTS-STARTPTS,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920');
    expect(g.filterComplex).toContain('[0:a]atrim=start=2:end=12'); // Ton aus dem Clip
    expect(g.filterComplex).toContain('[2:a]atrim=0:6'); // stummer Clip → anullsrc-Input
    expect(g.filterComplex).toContain('xfade=transition=fade:duration=0.5:offset=9.500');
    expect(g.filterComplex).toContain('acrossfade=d=0.5');
    expect(g.totalSec).toBeCloseTo(15.5, 2); // 10 + 6 − 0,5 Überblendung
    expect(g.outLabelV).toBe('[vx1]');
    expect(g.outLabelA).toBe('[ax1]');
  });

  it('Einzel-Clip mit Titel-Overlay: kein xfade, Overlay nur die ersten Sekunden', () => {
    const g = buildEditGraph({
      clips: [{ index: 0, audioIndex: 0, audioFromVideo: true, startSec: 0, durationSec: 8 }],
      width: 1920, height: 1080, overlays: [{ inputIndex: 1, fromSec: 0, toSec: 3.5 }],
    });
    expect(g.filterComplex).not.toContain('xfade');
    expect(g.filterComplex).toContain("[v0][1:v]overlay=0:0:enable='between(t,0.000,3.500)'[vo0]");
    expect(g.outLabelV).toBe('[vo0]');
    expect(g.totalSec).toBe(8);
  });

  it('v1092: Tempo skaliert Bild+Ton und die Dauern; Look-Filter und Clip-Text-Fenster sitzen richtig', () => {
    const g = buildEditGraph({
      clips: [
        { index: 0, audioIndex: 0, audioFromVideo: true, startSec: 0, durationSec: 8, speed: 2, lookFilter: 'eq=saturation=1.45:contrast=1.06' }, // → 4s effektiv
        { index: 1, audioIndex: 2, audioFromVideo: false, startSec: 0, durationSec: 3, speed: 0.5 }, // Zeitlupe → 6s effektiv
      ],
      width: 1080, height: 1920, fadeSec: 0.5,
      overlays: [{ inputIndex: 3, clip: 1 }], // Text nur während Clip 2
    });
    expect(g.filterComplex).toContain('setpts=(PTS-STARTPTS)/2');
    expect(g.filterComplex).toContain('eq=saturation=1.45:contrast=1.06,scale=1080:1920');
    expect(g.filterComplex).toContain('atempo=2'); // Ton läuft mit (Tonhöhe bleibt)
    // Effektiv: 4 + 6 − 0,5 = 9,5s; Clip 2 startet bei 3,5
    expect(g.totalSec).toBeCloseTo(9.5, 2);
    expect(g.clipWindows[1]).toEqual({ start: 3.5, end: 9.5 });
    expect(g.filterComplex).toContain("overlay=0:0:enable='between(t,3.500,9.500)'");
    // stummer Zeitlupen-Clip: Stille in EFFEKTIVER Länge (6s), kein atempo
    expect(g.filterComplex).toContain('[2:a]atrim=0:6.000');
  });

  it('v1094: pickHighlightWindows — lauteste Anker, Szenen-Einrasten, Mindestabstand, Top-N', () => {
    // Peaks bei t=30 (laut) und t=60 (lauter); Szenenwechsel bei 26,5 (einrastbar) und 40
    const rms = Array.from({ length: 90 }, (_, t) => ({ t, level: t === 30 ? -8 : t === 60 ? -5 : t === 31 ? -9 : -30 }));
    const w = pickHighlightWindows(rms, [26.5, 40], { count: 2, totalSec: 90 });
    expect(w.length).toBe(2);
    // t=60: Fenster 57–65 (kein Szenenwechsel in Reichweite)
    expect(w[1]).toMatchObject({ start: 57, end: 65 });
    // t=30: Start 27 → rastet auf Szenenwechsel 26,5 ein
    expect(w[0].start).toBe(26.5);
    expect(w[0].end).toBe(35);
    // Nachbar-Peak t=31 wurde vom Mindestabstand geschluckt (kein drittes Fenster)
    const w3 = pickHighlightWindows(rms, [], { count: 3, totalSec: 90 });
    expect(w3.length).toBe(2);
  });

  it('v1092: atempoChain kettet außerhalb 0,5–2', () => {
    expect(atempoChain(2)).toBe('atempo=2');
    expect(atempoChain(0.5)).toBe('atempo=0.5');
    expect(atempoChain(4)).toBe('atempo=2,atempo=2');
    expect(atempoChain(0.25)).toBe('atempo=0.5,atempo=0.5');
    expect(atempoChain(3)).toBe('atempo=2,atempo=1.5');
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

  it('v1082/v1106: Stimme und Musik-Track normalisiert, Master ist ein STATISCHER Limiter (kein Pumpen)', () => {
    const g = buildReelAudioGraph({ voiceIndex: 4, musicIndex: 5, totalSec: 30 });
    // Musik-Track auf Referenzpegel VOR dem volume-Regler
    expect(g.filterComplex).toContain('[5:a]loudnorm=I=-9:TP=-1:LRA=9,aresample=48000,volume=0.15[bed]');
    // v1106 — Master: Limiter ohne Auto-Gain statt dynamischem loudnorm
    // (der zog das Musik-Bett in Sprechpausen wieder hoch — Anti-Ducking)
    expect(g.filterComplex).toMatch(/normalize=0,alimiter=limit=0\.84:level=false,afade=/);
    expect(g.filterComplex).not.toContain('I=-14');
  });

  it('v1106: mit Erste-Pass-Messwerten laufen Stimme und Musik LINEAR (konstantes Gain, Emotion bleibt)', () => {
    const g = buildReelAudioGraph({
      voiceIndex: 4, musicIndex: 5, totalSec: 30,
      voiceMeasured: { inputI: -28.3, inputTp: -6.1, inputLra: 8.2, inputThresh: -38.9 },
      musicMeasured: { inputI: -11.2, inputTp: -0.4, inputLra: 4.1, inputThresh: -21.6 },
    });
    expect(g.filterComplex).toContain('[4:a]loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=-28.3:measured_TP=-6.1:measured_LRA=8.2:measured_thresh=-38.9:linear=true,aresample=48000');
    expect(g.filterComplex).toContain('[5:a]loudnorm=I=-9:TP=-1:LRA=9:measured_I=-11.2:measured_TP=-0.4:measured_LRA=4.1:measured_thresh=-21.6:linear=true,aresample=48000');
  });

  it('v1106: parseLoudnormMeasurement liest das ffmpeg-JSON, kaputte Ausgaben → undefined', async () => {
    const { parseLoudnormMeasurement } = await import('../video-pipeline.js');
    const stderr = `[Parsed_loudnorm_0 @ 0x1] \n{\n\t"input_i" : "-28.31",\n\t"input_tp" : "-6.10",\n\t"input_lra" : "8.20",\n\t"input_thresh" : "-38.92",\n\t"output_i" : "-16.02",\n\t"normalization_type" : "dynamic"\n}\n`;
    expect(parseLoudnormMeasurement(stderr)).toEqual({ inputI: -28.31, inputTp: -6.1, inputLra: 8.2, inputThresh: -38.92 });
    expect(parseLoudnormMeasurement('kein json')).toBeUndefined();
    expect(parseLoudnormMeasurement('{"input_i": "kaputt"}')).toBeUndefined();
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
