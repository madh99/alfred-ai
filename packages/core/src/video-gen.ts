import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import type { VideoFormat } from './video-pipeline.js';

const execFileAsync = promisify(execFile);
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

/**
 * v1060 — Stufe 3: echte KI-Video-Clips (Image-to-Video) für Reels.
 * Drei Provider hinter einem Interface: Sora (OpenAI, nutzt den vorhandenen
 * LLM-Key), Runway und Veo (Google) — beide optional über Kanal-Secrets.
 * Jeder Aufruf kostet echtes Geld (~0,25–3 € je Clip) und läuft daher NUR,
 * wenn der Kanal reel_ai_clips gesetzt hat (Opt-in, Budget-gedeckelt).
 */
export type AiClipProviderName = 'sora' | 'runway' | 'veo';

export interface AiClipRequest {
  /**
   * Ausgangsbild (lokal) — wird auf die Zielgröße des Providers gebracht.
   * v1107 — OHNE Bild läuft der Provider im TEXT-ZU-VIDEO-Modus (echte
   * generierte Szene statt belebtem Standbild); sora/veo können das,
   * Runway nicht (klarer Fehler).
   */
  imagePath?: string;
  /** Szenen-/Bewegungs-Beschreibung (englisch, ohne Text-/Personen-Wünsche). */
  prompt: string;
  format: VideoFormat;
  /** Modell-Override (Default je Provider). */
  model?: string;
  /** Wunsch-Dauer in s — wird auf das Provider-Raster gerundet (Sora 4/8/12, Runway 5/10, Veo fix). Default 8. */
  targetSec?: number;
  /** Arbeitsverzeichnis für Zwischen-/Ergebnisdateien. */
  workDir: string;
  outBaseName: string;
}

export interface AiClipResult {
  clipPath: string;
  durationSec: number;
  provider: AiClipProviderName;
  model: string;
}

export class AiClipGenerator {
  constructor(
    private readonly logger: Logger,
    private readonly keys: { openai?: string; runway?: string; google?: string },
    private readonly ffmpegPath = 'ffmpeg',
  ) {}

  async generate(provider: AiClipProviderName, req: AiClipRequest): Promise<AiClipResult> {
    const started = Date.now();
    const result = provider === 'sora'
      ? await this.generateSora(req)
      : provider === 'runway'
        ? await this.generateRunway(req)
        : await this.generateVeo(req);
    this.logger.info(
      { provider, model: result.model, durationSec: result.durationSec, tookMs: Date.now() - started },
      'v1060 ai clip generated',
    );
    return result;
  }

  /** Ausgangsbild auf exakte Zielgröße bringen (Cover-Crop via ffmpeg — kein sharp im Core). */
  private async prepareImage(req: AiClipRequest, w: number, h: number, ext: 'png' | 'jpg'): Promise<string> {
    if (!req.imagePath) throw new Error('prepareImage ohne imagePath (Text-zu-Video-Pfad ruft das nicht auf).');
    const out = join(req.workDir, `${req.outBaseName}-ref.${ext}`);
    await execFileAsync(this.ffmpegPath, [
      '-y', '-i', req.imagePath,
      '-vf', `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`,
      '-frames:v', '1', out,
    ], { timeout: 60_000 });
    return out;
  }

  /** Clip-Dauer bestimmen (best-effort — Provider-Sollwert als Fallback). */
  private async probeDuration(path: string, fallback: number): Promise<number> {
    try {
      const { stdout } = await execFileAsync(this.ffmpegPath.replace(/ffmpeg([^\\/]*)$/, 'ffprobe$1'),
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], { timeout: 20_000 });
      const d = Number(stdout.trim());
      return Number.isFinite(d) && d > 0 ? Number(d.toFixed(2)) : fallback;
    } catch { return fallback; }
  }

  // ── Sora (OpenAI) ────────────────────────────────────────────────────────
  // POST /v1/videos (multipart, input_reference = Bild in Zielgröße) →
  // Status-Poll → GET /v1/videos/{id}/content lädt das mp4.
  private async generateSora(req: AiClipRequest): Promise<AiClipResult> {
    const key = this.keys.openai;
    if (!key) throw new Error('Sora braucht einen OpenAI-Key (LLM-Config oder Secret OPENAI_API_KEY).');
    const model = req.model ?? 'sora-2';
    const [w, h] = req.format === '9:16' ? [720, 1280] : [1280, 720];
    const form = new FormData();
    form.append('model', model);
    form.append('prompt', req.prompt);
    form.append('size', `${w}x${h}`);
    const soraSec = [4, 8, 12].reduce((best, s) => Math.abs(s - (req.targetSec ?? 8)) < Math.abs(best - (req.targetSec ?? 8)) ? s : best, 8);
    form.append('seconds', String(soraSec));
    // v1107 — ohne Ausgangsbild: reines Text-zu-Video (Szenen-Modus)
    if (req.imagePath) {
      const ref = await this.prepareImage(req, w, h, 'jpg');
      form.append('input_reference', new Blob([new Uint8Array(await readFile(ref))], { type: 'image/jpeg' }), 'reference.jpg');
    }
    const create = await fetch('https://api.openai.com/v1/videos', {
      method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form,
    });
    if (!create.ok) throw new Error(`Sora create ${create.status}: ${(await create.text()).slice(0, 300)}`);
    const job = await create.json() as { id: string; status: string };
    const deadline = Date.now() + 8 * 60_000;
    let status = job.status;
    let pollErrors = 0;
    while (status !== 'completed') {
      if (status === 'failed') throw new Error('Sora-Job fehlgeschlagen (Status failed — oft Moderation des Ausgangsbilds).');
      if (Date.now() > deadline) throw new Error('Sora-Timeout nach 8 min (Job läuft evtl. weiter — Kosten fallen an).');
      await sleep(10_000);
      // Transiente Poll-Fehler (503 etc.) NICHT zum Abbruch machen — der Job
      // ist bezahlt und läuft serverseitig weiter (Realfall beim Live-Test).
      try {
        const poll = await fetch(`https://api.openai.com/v1/videos/${job.id}`, { headers: { Authorization: `Bearer ${key}` } });
        if (!poll.ok) throw new Error(`Sora poll ${poll.status}`);
        status = ((await poll.json()) as { status: string }).status;
        pollErrors = 0;
      } catch (err) {
        if (++pollErrors >= 6) throw err;
      }
    }
    const content = await fetch(`https://api.openai.com/v1/videos/${job.id}/content`, { headers: { Authorization: `Bearer ${key}` } });
    if (!content.ok) throw new Error(`Sora download ${content.status}`);
    const clipPath = join(req.workDir, `${req.outBaseName}-sora.mp4`);
    await writeFile(clipPath, Buffer.from(await content.arrayBuffer()));
    return { clipPath, durationSec: await this.probeDuration(clipPath, 8), provider: 'sora', model };
  }

  // ── Runway ───────────────────────────────────────────────────────────────
  // POST /v1/image_to_video (promptImage als data-URI) → Task-Poll → Output-URL.
  private async generateRunway(req: AiClipRequest): Promise<AiClipResult> {
    const key = this.keys.runway;
    if (!key) throw new Error('Runway braucht das Secret RUNWAY_API_SECRET (ENV-Stage des Kanals).');
    if (!req.imagePath) throw new Error('Runway kann hier nur Bild-zu-Video — für Text-zu-Video-Szenen sora oder veo verwenden.');
    const model = req.model ?? 'gen4_turbo';
    const [w, h] = req.format === '9:16' ? [720, 1280] : [1280, 720];
    const ref = await this.prepareImage(req, w, h, 'jpg');
    const dataUri = `data:image/jpeg;base64,${(await readFile(ref)).toString('base64')}`;
    const headers = { Authorization: `Bearer ${key}`, 'X-Runway-Version': '2024-11-06', 'Content-Type': 'application/json' };
    const create = await fetch('https://api.dev.runwayml.com/v1/image_to_video', {
      method: 'POST', headers,
      body: JSON.stringify({ model, promptImage: dataUri, promptText: req.prompt, ratio: `${w}:${h}`, duration: (req.targetSec ?? 5) >= 8 ? 10 : 5 }),
    });
    if (!create.ok) throw new Error(`Runway create ${create.status}: ${(await create.text()).slice(0, 300)}`);
    const task = await create.json() as { id: string };
    const deadline = Date.now() + 8 * 60_000;
    let pollErrors = 0;
    for (;;) {
      await sleep(8_000);
      if (Date.now() > deadline) throw new Error('Runway-Timeout nach 8 min.');
      let st: { status: string; output?: string[]; failure?: string };
      try {
        const poll = await fetch(`https://api.dev.runwayml.com/v1/tasks/${task.id}`, { headers: { Authorization: headers.Authorization, 'X-Runway-Version': headers['X-Runway-Version'] } });
        if (!poll.ok) throw new Error(`Runway poll ${poll.status}`);
        st = await poll.json() as { status: string; output?: string[]; failure?: string };
        pollErrors = 0;
      } catch (err) {
        if (++pollErrors >= 6) throw err;
        continue;
      }
      if (st.status === 'SUCCEEDED' && st.output?.[0]) {
        const dl = await fetch(st.output[0]);
        if (!dl.ok) throw new Error(`Runway download ${dl.status}`);
        const clipPath = join(req.workDir, `${req.outBaseName}-runway.mp4`);
        await writeFile(clipPath, Buffer.from(await dl.arrayBuffer()));
        return { clipPath, durationSec: await this.probeDuration(clipPath, 5), provider: 'runway', model };
      }
      if (st.status === 'FAILED' || st.status === 'CANCELLED') {
        throw new Error(`Runway-Job ${st.status}: ${st.failure ?? 'ohne Detail'}`);
      }
    }
  }

  // ── Veo (Google GenAI SDK, wie der Bild-Generator als optionaler Peer-Dep) ─
  private async generateVeo(req: AiClipRequest): Promise<AiClipResult> {
    const key = this.keys.google;
    if (!key) throw new Error('Veo braucht einen Google-Key (Secret GOOGLE_API_KEY oder LLM-Config google).');
    // Default: fast-Variante (~halber Preis, 8s). Live-geprüft 09.07.2026 —
    // der AI-Studio-Key listet NUR veo-3.1-*-preview (kein 2.0/3.0).
    const model = req.model ?? 'veo-3.1-fast-generate-preview';
    // @ts-ignore — @google/genai ist ein optionaler Peer-Dep (zur Laufzeit installiert)
    const { GoogleGenAI } = await import('@google/genai');
    const genai = new GoogleGenAI({ apiKey: key });
    const [w, h] = req.format === '9:16' ? [720, 1280] : [1280, 720];
    // v1107 — ohne Ausgangsbild: reines Text-zu-Video (Szenen-Modus)
    const image = req.imagePath
      ? { image: { imageBytes: (await readFile(await this.prepareImage(req, w, h, 'png'))).toString('base64'), mimeType: 'image/png' } }
      : {};
    let op = await genai.models.generateVideos({
      model,
      prompt: req.prompt,
      ...image,
      config: { aspectRatio: req.format, numberOfVideos: 1 },
    });
    const deadline = Date.now() + 8 * 60_000;
    while (!op.done) {
      if (Date.now() > deadline) throw new Error('Veo-Timeout nach 8 min.');
      await sleep(10_000);
      op = await genai.operations.getVideosOperation({ operation: op });
    }
    const video = op.response?.generatedVideos?.[0]?.video;
    if (!video) throw new Error(`Veo lieferte kein Video (${JSON.stringify(op.response ?? {}).slice(0, 200)}).`);
    const clipPath = join(req.workDir, `${req.outBaseName}-veo.mp4`);
    await genai.files.download({ file: video, downloadPath: clipPath });
    return { clipPath, durationSec: await this.probeDuration(clipPath, 8), provider: 'veo', model };
  }
}
