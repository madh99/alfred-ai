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

/** Grobe Sprechdauer-Schätzung (Fallback ohne ffprobe): ~2,4 Wörter/Sekunde. */
export function estimateSpeechSeconds(text: string): number {
  const words = text.split(/\s+/).filter(w => w.length > 0).length;
  return Math.max(5, Math.round(words / 2.4));
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
      /** TTS (SpeechSynthesizer.synthesize) — ohne: stummes Video. */
      synthesize?: (text: string) => Promise<Buffer>;
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
      const audio = await this.opts.synthesize(voText);
      audioPath = `${base}.voice.ogg`;
      await writeFile(audioPath, audio);
      durationSec = (await this.probeVideo(audioPath)).durationSec ?? estimateSpeechSeconds(voText);
    } else {
      durationSec = Math.max(10, spec.images.length * 4);
    }

    // 2) Concat-Liste: Bilder gleichmäßig über die Laufzeit
    const perImage = durationSec / spec.images.length;
    const listPath = `${base}.list.txt`;
    const listBody = spec.images
      .map(img => `file '${img.replace(/'/g, "'\\''")}'\nduration ${perImage.toFixed(2)}`)
      .join('\n') + `\nfile '${spec.images[spec.images.length - 1].replace(/'/g, "'\\''")}'\n`;
    await writeFile(listPath, listBody, 'utf8');

    // 3) Untertitel
    const subText = (spec.subtitleText ?? voText ?? '').trim();
    let srtPath: string | undefined;
    if (subText) {
      srtPath = `${base}.srt`;
      await writeFile(srtPath, buildSrt(subText, durationSec), 'utf8');
    }

    // 4) ffmpeg: skalieren/padden aufs Format, Untertitel einbrennen, Ton mischen
    const [w, h] = spec.format === '9:16' ? [1080, 1920] : [1920, 1080];
    const filters = [
      `scale=${w}:${h}:force_original_aspect_ratio=decrease`,
      `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black`,
      ...(srtPath ? [`subtitles='${srtPath.replace(/\\/g, '/').replace(/'/g, "'\\''").replace(/:/g, '\\:')}'`] : []),
    ].join(',');
    const outPath = `${base}.mp4`;
    const args = [
      '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
      ...(audioPath ? ['-i', audioPath] : []),
      '-vf', filters,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30',
      ...(audioPath ? ['-c:a', 'aac', '-shortest'] : ['-an']),
      outPath,
    ];
    this.logger.info({ images: spec.images.length, durationSec, format: spec.format }, 'v938 rendering slideshow video');
    await execFileAsync(this.ffmpeg, args, { timeout: 10 * 60_000, maxBuffer: 10 * 1024 * 1024 });
    return { videoPath: outPath, durationSec };
  }
}
