import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';

const execFileAsync = promisify(execFile);

export type VideoFormat = '9:16' | '16:9';

export interface VideoSpec {
  /** Lokale Bildpfade in Anzeige-Reihenfolge (min. 1). */
  images: string[];
  /** Voiceover-Text (TTS); ohne → stummes Video mit Untertiteln. */
  voiceoverText?: string;
  /** Untertitel-Text (Default: voiceoverText). */
  subtitleText?: string;
  format: VideoFormat;
  /** Basisname der Ausgabedatei (ohne Endung). */
  outBaseName: string;
  /** v1058 — Hook-Karte (z.B. Titel eingebrannt) als erste Slide. */
  introImage?: string;
  /** v1058 — Dauer der Hook-Karte (Default 1,5s). */
  introSec?: number;
  /** v1058 — End-Card (CTA) als letzte Slide, ohne Zoom, nach dem Voiceover. */
  outroImage?: string;
  /** v1058 — Dauer der End-Card (Default 2s). */
  outroSec?: number;
  /** v1059 — Musik-Bett: lokale Audiodatei, wird geloopt und unters Voiceover gemischt. */
  musicPath?: string;
  /** v1059 — Lautstärke des Musik-Betts 0–1 (Default 0,15). */
  musicVolume?: number;
  /** v1060 — KI-Clips: ersetzen das Bild an images[index] als bewegte Slide. */
  clips?: Array<{ index: number; path: string; durationSec: number }>;
  /** v1078 — Sprecherstimme (Voice-ID, z.B. Mistral-Custom-Voice); leer = Default-Kaskade. */
  voiceId?: string;
  /** v1066 — Dauer-Branding: transparente Voll-Ebene (PNG), liegt über der GESAMTEN Laufzeit (TV-Bug-Stil). */
  overlayImage?: string;
}

export interface RenderResult {
  videoPath: string;
  durationSec: number;
}

/**
 * v938 — Untertitel: Text satzweise gleichmäßig über die Laufzeit verteilen
 * (pure, testbar). SRT-Format.
 */
export function buildSrt(text: string, totalDurationSec: number): string {
  const sentences = text
    .split(/(?<=[.!?…])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
  if (sentences.length === 0) return '';
  const weights = sentences.map(s => Math.max(s.length, 10));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const fmt = (sec: number) => {
    const ms = Math.round(sec * 1000);
    const h = Math.floor(ms / 3_600_000), m = Math.floor((ms % 3_600_000) / 60_000);
    const s = Math.floor((ms % 60_000) / 1000), rest = ms % 1000;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(rest).padStart(3, '0')}`;
  };
  let cursor = 0;
  const blocks: string[] = [];
  sentences.forEach((sentence, i) => {
    const dur = (weights[i] / totalWeight) * totalDurationSec;
    blocks.push(`${i + 1}\n${fmt(cursor)} --> ${fmt(cursor + dur)}\n${sentence}\n`);
    cursor += dur;
  });
  return blocks.join('\n');
}

/** Grobe Sprechdauer-Schätzung (Fallback ohne ffprobe): ~1,9 Wörter/Sekunde (deutsches TTS; v1076 — 2,4 war zu schnell und schnitt Sprecher ab). */
export function estimateSpeechSeconds(text: string): number {
  const words = text.split(/\s+/).filter(w => w.length > 0).length;
  return Math.max(5, Math.round(words / 1.9));
}

/**
 * v1058 — Reel-Untertitel: PHRASEN-Chunks (max. 5 Wörter) statt ganzer Sätze —
 * die satzweise Verteilung baute 6-7-zeilige Textwände (Realfall 08.07.,
 * beide Live-Reels). Bevorzugt an Satzzeichen getrennt, proportional zur
 * Sprechzeit getimed. SRT; der Look kommt per force_style beim Einbrennen.
 */
export function buildPhraseSrt(text: string, totalDurationSec: number, maxWords = 5, offsetSec = 0): string {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(w => w.length > 0);
  if (words.length === 0) return '';
  const phrases: string[] = [];
  let current: string[] = [];
  for (const word of words) {
    current.push(word);
    const endsClause = /[.!?…:;,]$/.test(word);
    if (current.length >= maxWords || (endsClause && current.length >= 3)) {
      phrases.push(current.join(' '));
      current = [];
    }
  }
  if (current.length > 0) {
    // Mini-Rest (1-2 Wörter) an die letzte Phrase hängen statt eigener Blitz-Einblendung
    if (current.length <= 2 && phrases.length > 0) phrases[phrases.length - 1] += ` ${current.join(' ')}`;
    else phrases.push(current.join(' '));
  }
  const weights = phrases.map(p => p.split(' ').length);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const fmt = (sec: number) => {
    const ms = Math.round(sec * 1000);
    const h = Math.floor(ms / 3_600_000), m = Math.floor((ms % 3_600_000) / 60_000);
    const s = Math.floor((ms % 60_000) / 1000), rest = ms % 1000;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(rest).padStart(3, '0')}`;
  };
  let cursor = offsetSec;
  const blocks: string[] = [];
  phrases.forEach((phrase, i) => {
    const dur = (weights[i] / totalWeight) * totalDurationSec;
    blocks.push(`${i + 1}\n${fmt(cursor)} --> ${fmt(cursor + dur)}\n${phrase}\n`);
    cursor += dur;
  });
  return blocks.join('\n');
}

/** v1058 — Reel-Untertitel-Look (libass force_style, PlayResY 288): fett, kräftiges Outline, unteres Drittel mit Safe-Zone über der IG-UI. */
export const REEL_SUBTITLE_STYLE = 'FontName=DejaVu Sans,Bold=1,FontSize=11,Outline=2,Shadow=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,MarginV=48,MarginL=18,MarginR=18,Alignment=2';

/**
 * v1058 — ffmpeg-Filtergraph fürs Reel (pure, testbar): je Slide Cover-Crop
 * (KEIN Letterbox-Pad mehr — Realfall: riesige schwarze Balken) + Ken-Burns-
 * Zoom (abwechselnd rein/raus, End-Card statisch), 0,5s-Crossfades, dann
 * Untertitel + yuv420p. Sichtbare Slide-Dauern werden so aufgeteilt, dass die
 * Gesamtlänge trotz Überblendungen exakt stimmt.
 */
export function buildReelFilterGraph(opts: {
  slides: Array<{ motion: 'in' | 'out' | 'none'; durationSec: number; kind?: 'image' | 'video' }>;
  width: number;
  height: number;
  fadeSec?: number;
  srtPathEscaped?: string;
  fps?: number;
  /** v1066 — Input-Index der Dauer-Branding-Ebene (transparentes PNG, liegt über allem inkl. Untertiteln). */
  overlayInputIndex?: number;
}): { filterComplex: string; outLabel: string; inputDurations: number[]; totalSec: number } {
  const fps = opts.fps ?? 30;
  const fade = opts.slides.length > 1 ? (opts.fadeSec ?? 0.5) : 0;
  const { width: w, height: h } = opts;
  // Zoompan skaliert intern — Quelle 1,25x größer anliefern, damit der Zoom Luft hat
  const zw = Math.round(w * 1.25 / 2) * 2;
  const zh = Math.round(h * 1.25 / 2) * 2;
  const parts: string[] = [];
  const inputDurations: number[] = [];
  opts.slides.forEach((slide, i) => {
    const visible = slide.durationSec;
    const inputSec = i < opts.slides.length - 1 ? visible + fade : visible;
    inputDurations.push(Number(inputSec.toFixed(3)));
    if (slide.kind === 'video') {
      // v1060 — KI-Clip: hat eigene Bewegung, kein Ken-Burns. Cover-Crop +
      // fps-Angleich; tpad klont das letzte Frame für die Crossfade-Überlappung
      // (falls der Clip exakt auf der sichtbaren Dauer endet).
      parts.push(
        `[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},fps=${fps},`
        + `trim=duration=${visible.toFixed(3)},setpts=PTS-STARTPTS,`
        + `tpad=stop_mode=clone:stop_duration=${fade},setsar=1,format=yuv420p[v${i}]`,
      );
      return;
    }
    const frames = Math.max(1, Math.round(inputSec * fps));
    const zoom = slide.motion === 'in'
      ? `min(1+0.10*on/${frames},1.10)`
      : slide.motion === 'out'
        ? `max(1.10-0.10*on/${frames},1.0)`
        : '1';
    parts.push(
      `[${i}:v]scale=${zw}:${zh}:force_original_aspect_ratio=increase,crop=${zw}:${zh},`
      + `zoompan=z='${zoom}':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${w}x${h}:fps=${fps},setsar=1,format=yuv420p[v${i}]`,
    );
  });
  let current = '[v0]';
  let offset = 0;
  opts.slides.forEach((slide, i) => {
    if (i === 0) { offset = slide.durationSec; return; }
    const label = i === opts.slides.length - 1 ? '[vx]' : `[x${i}]`;
    parts.push(`${current}[v${i}]xfade=transition=fade:duration=${fade}:offset=${offset.toFixed(3)}${label}`);
    current = label;
    offset += slide.durationSec;
  });
  // xfade-Kette: Gesamtlänge = Summe der sichtbaren Dauern (die Blende liegt IN den Dauern)
  const totalSec = opts.slides.reduce((s, x) => s + x.durationSec, 0);
  const tail = opts.slides.length > 1 ? current : '[v0]';
  const finalFilters = [
    ...(opts.srtPathEscaped ? [`subtitles='${opts.srtPathEscaped}':force_style='${REEL_SUBTITLE_STYLE}'`] : []),
    'format=yuv420p',
  ].join(',');
  if (opts.overlayInputIndex !== undefined) {
    // v1066 — Dauer-Branding: die transparente Ebene liegt über ALLEM (auch
    // den Untertiteln — Ecke vs. Safe-Zone unten Mitte, kollisionsfrei);
    // overlay wiederholt das Einzelframe automatisch (eof_action=repeat).
    parts.push(`${tail}${finalFilters}[vpre]`);
    parts.push(`[${opts.overlayInputIndex}:v]scale=${w}:${h}[wm]`);
    parts.push(`[vpre][wm]overlay=0:0[vout]`);
  } else {
    parts.push(`${tail}${finalFilters}[vout]`);
  }
  return { filterComplex: parts.join(';'), outLabel: '[vout]', inputDurations, totalSec: Number(totalSec.toFixed(3)) };
}

/**
 * v1059 — Audio-Graph fürs Musik-Bett (pure, testbar): Musik leise unters
 * Voiceover legen, per Sidechain-Ducking automatisch absenken solange
 * gesprochen wird, und am Video-Ende sanft ausblenden. Ohne Voiceover läuft
 * die Musik allein. Die Musik-Quelle wird per -stream_loop -1 geloopt; das
 * -t des Aufrufers schneidet den (unendlichen) Mix auf die Videolänge.
 */
export function buildReelAudioGraph(opts: {
  /** Input-Index des Voiceovers (ohne → Musik solo). */
  voiceIndex?: number;
  /** Input-Index der Musik. */
  musicIndex: number;
  /** 0–1, Default 0,15 (leises Bett). */
  musicVolume?: number;
  totalSec: number;
  /** Ausblende-Dauer am Ende (Default 1,5s). */
  fadeSec?: number;
}): { filterComplex: string; outLabel: string } {
  const vol = Math.min(1, Math.max(0.01, opts.musicVolume ?? 0.15));
  const fade = opts.fadeSec ?? 1.5;
  const fadeStart = Math.max(0, opts.totalSec - fade);
  const fadeOut = `afade=t=out:st=${fadeStart.toFixed(3)}:d=${fade}`;
  if (opts.voiceIndex === undefined) {
    return {
      filterComplex: `[${opts.musicIndex}:a]volume=${vol},${fadeOut}[aout]`,
      outLabel: '[aout]',
    };
  }
  const parts = [
    `[${opts.voiceIndex}:a]apad,asplit=2[vo1][vo2]`,
    `[${opts.musicIndex}:a]volume=${vol}[bed]`,
    // Ducking: Musik weicht der Stimme (Sidechain), kommt in Sprechpausen zurück
    `[bed][vo1]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=400[duck]`,
    `[vo2][duck]amix=inputs=2:duration=first:normalize=0,${fadeOut}[aout]`,
  ];
  return { filterComplex: parts.join(';'), outLabel: '[aout]' };
}

/**
 * v938 — Externer Video-Generator (Runway/Kling/Veo): Schnittstelle ist
 * vorbereitet und per Config aktivierbar — die konkrete Anbindung folgt,
 * sobald ein Anbieter gewählt/bezahlt ist. Bis dahin liefert generate()
 * einen klaren Hinweis statt still zu scheitern.
 */
export interface VideoGenProvider {
  readonly name: string;
  generate(prompt: string, format: VideoFormat): Promise<{ videoPath: string }>;
}

export class ExternalVideoProviderPlaceholder implements VideoGenProvider {
  constructor(readonly name: string) {}
  async generate(): Promise<{ videoPath: string }> {
    throw new Error(
      `Externer Video-Generator "${this.name}" ist vorbereitet aber nicht aktiviert — `
      + `API-Key in ENV-Stage 'social' hinterlegen und media.videoGen.provider in der Config setzen. `
      + `Bis dahin: Slideshow-Renderer (render_video) oder eigenes Video per attach_media.`,
    );
  }
}

/**
 * v938 — Slideshow-Renderer (Stufe 1): Bilder + TTS-Voiceover + eingebrannte
 * Untertitel → MP4 (Shorts/Reels 9:16 oder Standard 16:9) via ffmpeg auf dem
 * Node. Kein externer Dienst, keine Kosten.
 */
export class SlideshowVideoRenderer {
  constructor(
    private readonly logger: Logger,
    private readonly opts: {
      workDir: string;
      ffmpegPath?: string;
      ffprobePath?: string;
      /** TTS (SpeechSynthesizer.synthesize) — ohne: stummes Video. v1078: optionale Voice-ID. */
      synthesize?: (text: string, voiceId?: string) => Promise<Buffer>;
    },
  ) {}

  private get ffmpeg(): string { return this.opts.ffmpegPath ?? 'ffmpeg'; }
  private get ffprobe(): string { return this.opts.ffprobePath ?? 'ffprobe'; }

  /** Ist ffmpeg auf dem Host verfügbar? */
  async available(): Promise<boolean> {
    try {
      await execFileAsync(this.ffmpeg, ['-version'], { timeout: 10_000 });
      return true;
    } catch { return false; }
  }

  /**
   * v1076 — ECHTE Audiodauer durch Dekodieren (letzter time=-Fortschritt):
   * Ogg/Opus-Container-Metadaten weichen bis ±2 s von der realen Dauer ab
   * (gemessen 09.07.: Meta 32,5 s vs. real 34,4 s — der Sprecher wurde vom
   * -t-Schnitt gekappt). null bei Fehler (Aufrufer fällt auf Metadatum zurück).
   */
  async measureAudioSeconds(path: string): Promise<number | null> {
    try {
      const { stderr } = await execFileAsync(this.ffmpeg, ['-i', path, '-f', 'null', '-'], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
      const times = String(stderr).match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g);
      if (!times || times.length === 0) return null;
      const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(times[times.length - 1])!;
      const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      return Number.isFinite(sec) && sec > 0 ? Number(sec.toFixed(2)) : null;
    } catch { return null; }
  }

  /** v938 — Transcode-Check für User-Videos (ffprobe, best-effort). */
  async probeVideo(path: string): Promise<{ ok: boolean; durationSec?: number; detail?: string }> {
    try {
      const { stdout } = await execFileAsync(this.ffprobe,
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path],
        { timeout: 20_000 });
      const durationSec = Number(stdout.trim());
      return Number.isFinite(durationSec) && durationSec > 0
        ? { ok: true, durationSec }
        : { ok: false, detail: 'keine Videodauer erkennbar' };
    } catch (err) {
      return { ok: false, detail: (err as Error).message.slice(0, 150) };
    }
  }

  async render(spec: VideoSpec): Promise<RenderResult> {
    if (spec.images.length === 0) throw new Error('Slideshow braucht mindestens ein Bild (media am Item).');
    if (!(await this.available())) {
      throw new Error('ffmpeg nicht gefunden — auf dem Host installieren (apt install ffmpeg) oder eigenes Video per attach_media liefern.');
    }
    await mkdir(this.opts.workDir, { recursive: true });
    const base = join(this.opts.workDir, spec.outBaseName.replace(/[^a-zA-Z0-9_-]/g, '_'));

    // 1) Voiceover (bestimmt die Laufzeit)
    let audioPath: string | undefined;
    let durationSec: number;
    const voText = spec.voiceoverText?.trim();
    if (voText && this.opts.synthesize) {
      const audio = await this.opts.synthesize(voText, spec.voiceId);
      audioPath = `${base}.voice.ogg`;
      await writeFile(audioPath, audio);
      // v1076 — ECHT dekodierte Dauer (Container-Metadaten lügen bis ±2 s)
      // + 1,5 s Reserve: der Sprecher endet garantiert VOR der End-Card.
      const real = await this.measureAudioSeconds(audioPath);
      durationSec = (real ?? (await this.probeVideo(audioPath)).durationSec ?? estimateSpeechSeconds(voText)) + 1.5;
    } else {
      durationSec = Math.max(10, spec.images.length * 4);
    }

    // 2) v1058 — Slide-Plan: optionale Hook-Karte + Bilder + optionale End-Card.
    // Das Voiceover deckt Hook + Bilder ab; die End-Card läuft danach (Stille).
    // v1060 — KI-Clips ersetzen ihr Bild als bewegte Slide mit EIGENER Dauer
    // (nativ, 2–8s gekappt); die Standbilder teilen sich die restliche
    // Voiceover-Zeit.
    const introSec = spec.introImage ? Math.max(1, spec.introSec ?? 1.5) : 0;
    const outroSec = spec.outroImage ? Math.max(1, spec.outroSec ?? 2) : 0;
    const clipByIndex = new Map((spec.clips ?? []).map(c => [c.index, c]));
    const clipSec = (c: { durationSec: number }) => Math.min(Math.max(c.durationSec, 2), 8);
    const clipTotal = [...clipByIndex.values()].reduce((s, c) => s + clipSec(c), 0);
    const stillCount = spec.images.length - clipByIndex.size;
    const perStill = stillCount > 0
      ? Math.max(stillCount * 2, durationSec - introSec - clipTotal) / stillCount
      : 0;
    const middle = spec.images.map((img, i) => {
      const clip = clipByIndex.get(i);
      return clip
        ? { file: clip.path, kind: 'video' as const, durationSec: clipSec(clip) }
        : { file: img, kind: 'image' as const, durationSec: perStill };
    });
    // v1076 — GARANTIE: das Video trägt das komplette Voiceover. Realfall
    // Klopp-Reel 09.07.: EIN Bild, durch den KI-Clip ersetzt → null
    // Standbilder → Video 11,5 s bei 34 s Sprache (Sprecher hart gekappt,
    // 17 Untertitel in 9,5 s). Fehlt Zeit, trägt das Basis-Bild als
    // zusätzliche Ken-Burns-Slide den Rest.
    const middleTotal = middle.reduce((s, m) => s + m.durationSec, 0);
    const shortfall = durationSec - introSec - middleTotal;
    if (shortfall > 0.05 && spec.images.length > 0) {
      middle.push({ file: spec.images[spec.images.length - 1], kind: 'image' as const, durationSec: Math.max(2, shortfall) });
    }
    const slideFiles: string[] = [
      ...(spec.introImage ? [spec.introImage] : []),
      ...middle.map(m => m.file),
      ...(spec.outroImage ? [spec.outroImage] : []),
    ];
    // v1064 — Hook-Karte STATISCH (wie die End-Card): der Ken-Burns-Zoom
    // vergrößerte die eingebrannten Titel-Boxen über den Bildrand hinaus
    // (Realfall 09.07.: „Balken" bis zur Kante im Live-Reel).
    const slides = [
      ...(spec.introImage ? [{ motion: 'none' as const, durationSec: introSec, kind: 'image' as const }] : []),
      ...middle.map((m, i) => ({
        motion: m.kind === 'video' ? 'none' as const : ((i + (spec.introImage ? 1 : 0)) % 2 === 0 ? 'in' as const : 'out' as const),
        durationSec: m.durationSec,
        kind: m.kind,
      })),
      ...(spec.outroImage ? [{ motion: 'none' as const, durationSec: outroSec, kind: 'image' as const }] : []),
    ];
    const speechWindow = introSec + middle.reduce((s, m) => s + m.durationSec, 0);

    // 3) Untertitel — Phrasen-Chunks über die Voiceover-Zeit (nicht über die
    // End-Card). v1062 — erst NACH der Hook-Slide: dort stehen die Titel-Boxen
    // groß im Bild, Untertitel kollidierten damit (Realfall 09.07.).
    const subText = (spec.subtitleText ?? voText ?? '').trim();
    let srtPath: string | undefined;
    if (subText) {
      srtPath = `${base}.srt`;
      await writeFile(srtPath, buildPhraseSrt(subText, speechWindow - introSec, 5, introSec), 'utf8');
    }

    // 4) v1058 — ffmpeg: Cover-Crop + Ken-Burns + Crossfades statt Letterbox-Standbilder
    const [w, h] = spec.format === '9:16' ? [1080, 1920] : [1920, 1080];
    // v1066 — Dauer-Branding-Ebene als letzter Input (nach Voice + Musik)
    const wmPath = spec.overlayImage?.trim() || undefined;
    const wmIndex = wmPath
      ? slideFiles.length + (audioPath ? 1 : 0) + (spec.musicPath?.trim() ? 1 : 0)
      : undefined;
    const graph = buildReelFilterGraph({
      slides, width: w, height: h,
      srtPathEscaped: srtPath ? srtPath.replace(/\\/g, '/').replace(/'/g, "'\\''").replace(/:/g, '\\:') : undefined,
      ...(wmIndex !== undefined ? { overlayInputIndex: wmIndex } : {}),
    });
    const outPath = `${base}.mp4`;
    // v1059 — Musik-Bett: geloopte Musik unters Voiceover (Sidechain-Ducking),
    // ohne Voiceover läuft die Musik allein; -t schneidet auf die Videolänge.
    const music = spec.musicPath?.trim() || undefined;
    const audioGraph = music
      ? buildReelAudioGraph({
        ...(audioPath ? { voiceIndex: slideFiles.length } : {}),
        musicIndex: slideFiles.length + (audioPath ? 1 : 0),
        ...(spec.musicVolume !== undefined ? { musicVolume: spec.musicVolume } : {}),
        totalSec: graph.totalSec,
      })
      : undefined;
    const args = [
      '-y',
      ...slideFiles.flatMap(f => ['-i', f]),
      ...(audioPath ? ['-i', audioPath] : []),
      ...(music ? ['-stream_loop', '-1', '-i', music] : []),
      ...(wmPath ? ['-i', wmPath] : []),
      '-filter_complex', audioGraph ? `${graph.filterComplex};${audioGraph.filterComplex}` : graph.filterComplex,
      '-map', graph.outLabel,
      ...(audioGraph
        ? ['-map', audioGraph.outLabel, '-c:a', 'aac']
        : audioPath ? ['-map', `${slideFiles.length}:a`, '-c:a', 'aac', '-af', 'apad'] : ['-an']),
      '-t', String(graph.totalSec),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30',
      outPath,
    ];
    this.logger.info({ images: spec.images.length, clips: clipByIndex.size, intro: introSec, outro: outroSec, music: Boolean(music), durationSec: graph.totalSec, format: spec.format }, 'v1058 rendering reel video (cover-crop + ken-burns + crossfades)');
    await execFileAsync(this.ffmpeg, args, { timeout: 10 * 60_000, maxBuffer: 10 * 1024 * 1024 });
    return { videoPath: outPath, durationSec: graph.totalSec };
  }
}
