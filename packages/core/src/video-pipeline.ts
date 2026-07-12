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
/** v1106 — Erste-Pass-Messwerte für loudnorm im Linear-Modus (konstantes Gain). */
export interface LoudnessMeasurement {
  inputI: number;
  inputTp: number;
  inputLra: number;
  inputThresh: number;
}

/**
 * v1106 — loudnorm-JSON aus dem ffmpeg-stderr eines Mess-Laufs parsen
 * (`-af loudnorm=…:print_format=json -f null -`). Fehlt/kaputt → undefined,
 * der Graph fällt dann auf den dynamischen Ein-Pass-Modus zurück.
 */
export function parseLoudnormMeasurement(stderr: string): LoudnessMeasurement | undefined {
  const start = stderr.lastIndexOf('{');
  const end = stderr.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const j = JSON.parse(stderr.slice(start, end + 1)) as Record<string, string>;
    const num = (k: string) => Number.parseFloat(j[k]);
    const m = { inputI: num('input_i'), inputTp: num('input_tp'), inputLra: num('input_lra'), inputThresh: num('input_thresh') };
    return Object.values(m).every(Number.isFinite) ? m : undefined;
  } catch {
    return undefined;
  }
}

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
  /** v1106 — Erste-Pass-Messwerte → loudnorm läuft LINEAR (konstantes Gain). */
  voiceMeasured?: LoudnessMeasurement;
  musicMeasured?: LoudnessMeasurement;
}): { filterComplex: string; outLabel: string } {
  const vol = Math.min(1, Math.max(0.01, opts.musicVolume ?? 0.15));
  const fade = opts.fadeSec ?? 1.5;
  const fadeStart = Math.max(0, opts.totalSec - fade);
  const fadeOut = `afade=t=out:st=${fadeStart.toFixed(3)}:d=${fade}`;
  // v1082 — Loudness-Normalisierung (Realfall 09.07.: Custom-Voice-Klon kam
  // 12 dB leiser aus der Mistral-API als die Builtin-Stimme → Musik übertönte
  // den Sprecher UND das Ducking griff nicht, weil die leise Stimme kaum über
  // die Sidechain-Schwelle kam): Stimme -16 LUFS, Musik-Track -9 LUFS.
  // v1106 — mit Messwerten laufen die Normalisierungen LINEAR (Zwei-Pass,
  // konstantes Gain): der Ein-Pass-Modus regelte zeitvariabel und bügelte
  // bewusste Dynamik (Emotions-Einstieg der Sprecherin) weg. Ohne Messwerte
  // (Fallback/Tests) bleibt der Ein-Pass-Modus.
  // aresample=48000 jeweils direkt danach (loudnorm arbeitet intern mit 192 kHz).
  const linear = (target: string, m?: LoudnessMeasurement) => m
    ? `${target}:measured_I=${m.inputI}:measured_TP=${m.inputTp}:measured_LRA=${m.inputLra}:measured_thresh=${m.inputThresh}:linear=true`
    : target;
  const VOICE_NORM = `${linear('loudnorm=I=-16:TP=-1.5:LRA=11', opts.voiceMeasured)},aresample=48000`;
  const MUSIC_NORM = `${linear('loudnorm=I=-9:TP=-1:LRA=9', opts.musicMeasured)},aresample=48000`;
  // v1106 — Master: STATISCHER Limiter statt dynamischem loudnorm. Der
  // Ein-Pass-Master pumpte (Realfall Bellingham 12.07.): das Musik-only-Intro
  // wurde ~14 dB Richtung Ziel hochgezogen, in Sprechpausen kletterte das
  // Gain und hob das GEDUCKTE Bett unter der Stimme wieder an (Anti-Ducking),
  // der Emotions-Einstieg wurde plattgedrückt (leiseste Sekunden des Videos).
  // Stimme und Bett sind bereits einzeln normalisiert — der Mix landet von
  // selbst bei ~-15 LUFS; der Limiter fängt nur echte Spitzen (0.84 ≈ -1,5 dB),
  // ohne Auto-Gain (level=false).
  const MASTER_LIMIT = 'alimiter=limit=0.84:level=false';
  if (opts.voiceIndex === undefined) {
    // Musik solo: Track-Normalisierung + Regler wie bisher, kein Master —
    // hier IST das leise Bett der gewollte Inhalt.
    return {
      filterComplex: `[${opts.musicIndex}:a]${MUSIC_NORM},volume=${vol},${fadeOut}[aout]`,
      outLabel: '[aout]',
    };
  }
  const parts = [
    `[${opts.voiceIndex}:a]${VOICE_NORM},apad,asplit=2[vo1][vo2]`,
    `[${opts.musicIndex}:a]${MUSIC_NORM},volume=${vol}[bed]`,
    // Ducking: Musik weicht der Stimme (Sidechain), kommt in Sprechpausen zurück
    `[bed][vo1]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=400[duck]`,
    `[vo2][duck]amix=inputs=2:duration=first:normalize=0,${MASTER_LIMIT},${fadeOut}[aout]`,
  ];
  return { filterComplex: parts.join(';'), outLabel: '[aout]' };
}

/**
 * v1092 — Farb-Look-Presets für den Schnitt (Effekt-Palette der Werkstatt).
 * Bewusst dezente, plattformtaugliche Looks — kein LUT-File nötig.
 */
export const EDIT_LOOKS: Record<string, string> = {
  kino: 'eq=contrast=1.12:saturation=1.22:brightness=-0.015,vignette=PI/5',
  warm: 'colorbalance=rm=0.07:gm=0.02:bm=-0.06,eq=saturation=1.1',
  kalt: 'colorbalance=bm=0.08:rm=-0.05,eq=saturation=1.05',
  sw: 'hue=s=0,eq=contrast=1.1',
  lebendig: 'eq=saturation=1.45:contrast=1.06',
};

/** v1092 — atempo akzeptiert nur 0,5–2,0 je Instanz: Kette für weitere Tempi. */
export function atempoChain(speed: number): string {
  const parts: string[] = [];
  let s = speed;
  while (s < 0.5) { parts.push('atempo=0.5'); s /= 0.5; }
  while (s > 2) { parts.push('atempo=2'); s /= 2; }
  parts.push(`atempo=${Number(s.toFixed(4))}`);
  return parts.join(',');
}

/**
 * v1088 — Basis-Schnitt (pure, testbar): Clips trimmen, auf eine gemeinsame
 * Leinwand bringen (Cover-Crop) und mit Crossfades verketten; Ton wird —
 * wo vorhanden — mitgetrimmt und weich übergeblendet, stumme Clips bekommen
 * Stille (anullsrc-Input des Aufrufers).
 * v1092 — Effekt-Palette je Clip: Tempo (Zeitlupe/Zeitraffer, Bild UND Ton),
 * Farb-Look (EDIT_LOOKS) und beliebige Overlay-Fenster (Titel global,
 * Text-PNGs je Clip — Zeitfenster rechnet der Graph aus den effektiven
 * Clip-Dauern selbst aus).
 */
export function buildEditGraph(opts: {
  /** Je Clip: Input-Index des Videos, Input-Index der Tonquelle (Video selbst oder anullsrc), getrimmte Dauer (roh, VOR Tempo). */
  clips: Array<{ index: number; audioIndex: number; audioFromVideo: boolean; startSec: number; durationSec: number;
    /** v1092 — Tempo 0,25–4 (1 = Original; <1 Zeitlupe, >1 Zeitraffer). */
    speed?: number;
    /** v1092 — Filterkette aus EDIT_LOOKS (oder eigene). */
    lookFilter?: string;
  }>;
  width: number; height: number;
  /** Crossfade-Dauer zwischen Clips (Default 0,5 s; 0 = harte Schnitte). */
  fadeSec?: number;
  /** v1092 — Overlay-PNGs (volle Leinwand, Alpha): entweder festes Zeitfenster (fromSec/toSec) oder clip-gebunden (clip = Index in clips). */
  overlays?: Array<{ inputIndex: number; fromSec?: number; toSec?: number; clip?: number }>;
}): { filterComplex: string; outLabelV: string; outLabelA: string; totalSec: number; clipWindows: Array<{ start: number; end: number }> } {
  if (opts.clips.length === 0) throw new Error('buildEditGraph: mindestens ein Clip');
  const fade = Math.max(0, opts.fadeSec ?? 0.5);
  const parts: string[] = [];
  const effDur = (c: typeof opts.clips[number]) => c.durationSec / (c.speed && c.speed > 0 ? c.speed : 1);
  for (let k = 0; k < opts.clips.length; k++) {
    const c = opts.clips[k];
    const end = c.startSec + c.durationSec;
    const speed = c.speed && c.speed > 0 && c.speed !== 1 ? c.speed : undefined;
    parts.push(
      `[${c.index}:v]trim=start=${c.startSec}:end=${end},setpts=${speed ? `(PTS-STARTPTS)/${speed}` : 'PTS-STARTPTS'},` +
      `${c.lookFilter ? `${c.lookFilter},` : ''}` +
      `scale=${opts.width}:${opts.height}:force_original_aspect_ratio=increase,crop=${opts.width}:${opts.height},fps=30,format=yuv420p[v${k}]`,
    );
    // Ton: aus dem Clip selbst (gleiches Trimm-Fenster) oder Stille passender Länge;
    // Tempo verändert Bild UND Ton gemeinsam (atempo hält die Tonhöhe)
    const tempo = speed ? `,${atempoChain(speed)}` : '';
    parts.push(c.audioFromVideo
      ? `[${c.audioIndex}:a]atrim=start=${c.startSec}:end=${end},asetpts=PTS-STARTPTS${tempo},aresample=48000[a${k}]`
      : `[${c.audioIndex}:a]atrim=0:${effDur(c).toFixed(3)},asetpts=PTS-STARTPTS,aresample=48000[a${k}]`);
  }
  let v = '[v0]';
  let a = '[a0]';
  const clipWindows: Array<{ start: number; end: number }> = [{ start: 0, end: effDur(opts.clips[0]) }];
  let total = effDur(opts.clips[0]);
  for (let k = 1; k < opts.clips.length; k++) {
    const d = effDur(opts.clips[k]);
    if (fade > 0) {
      const offset = Math.max(0, total - fade);
      parts.push(`${v}[v${k}]xfade=transition=fade:duration=${fade}:offset=${offset.toFixed(3)}[vx${k}]`);
      parts.push(`${a}[a${k}]acrossfade=d=${fade}[ax${k}]`);
      clipWindows.push({ start: offset, end: offset + d });
      total = offset + d;
    } else {
      parts.push(`${v}[v${k}]concat=n=2:v=1:a=0[vx${k}]`);
      parts.push(`${a}[a${k}]concat=n=2:v=0:a=1[ax${k}]`);
      clipWindows.push({ start: total, end: total + d });
      total += d;
    }
    v = `[vx${k}]`;
    a = `[ax${k}]`;
  }
  for (let o = 0; o < (opts.overlays?.length ?? 0); o++) {
    const ov = opts.overlays![o];
    const win = ov.clip !== undefined && clipWindows[ov.clip]
      ? { from: clipWindows[ov.clip].start, to: clipWindows[ov.clip].end }
      : { from: ov.fromSec ?? 0, to: ov.toSec ?? total };
    parts.push(`${v}[${ov.inputIndex}:v]overlay=0:0:enable='between(t,${win.from.toFixed(3)},${win.to.toFixed(3)})'[vo${o}]`);
    v = `[vo${o}]`;
  }
  return {
    filterComplex: parts.join(';'), outLabelV: v, outLabelA: a,
    totalSec: Number(total.toFixed(3)),
    clipWindows: clipWindows.map(w => ({ start: Number(w.start.toFixed(3)), end: Number(w.end.toFixed(3)) })),
  };
}

/**
 * v1094 — Auto-Highlights (pure, testbar): aus Lautheits-Verlauf (RMS je
 * Sekunde — Jubel, Kommentator-Ausbruch) und Szenenwechseln die besten
 * Fenster wählen. Heuristik: lauteste Sekunden als Anker, Fenster davor/
 * danach aufziehen, Start auf den nächstliegenden früheren Szenenwechsel
 * einrasten (sauberer Einstieg), Überlappungen zusammenlegen, Top-N nach
 * Lautheit mit Mindestabstand.
 */
export function pickHighlightWindows(
  rms: Array<{ t: number; level: number }>,
  scenes: number[],
  opts?: { count?: number; preSec?: number; postSec?: number; minGapSec?: number; maxLenSec?: number; totalSec?: number },
): Array<{ start: number; end: number; score: number }> {
  if (rms.length === 0) return [];
  const count = Math.max(1, Math.min(opts?.count ?? 3, 8));
  const pre = opts?.preSec ?? 3;
  const post = opts?.postSec ?? 5;
  const minGap = opts?.minGapSec ?? 8;
  const maxLen = opts?.maxLenSec ?? 20;
  const total = opts?.totalSec ?? Math.max(...rms.map(r => r.t)) + 1;
  const sorted = [...rms].sort((a, b) => b.level - a.level);
  // Qualitäts-Schwelle: ein „Highlight" muss deutlich über dem Normalpegel
  // liegen (Median + 3 dB) — sonst füllt der Top-N-Wähler flaches Material
  // mit Rausch-Fenstern auf. Bei gleichförmigem Pegel (z. B. stummes
  // Material mit Szenen-Ankern, Spread < 3 dB) entfällt die Schwelle.
  const levels = [...rms.map(r => r.level)].sort((a, b) => a - b);
  const median = levels[Math.floor(levels.length / 2)];
  const threshold = levels[levels.length - 1] - levels[0] >= 3 ? median + 3 : -Infinity;
  const picked: Array<{ start: number; end: number; score: number }> = [];
  for (const peak of sorted) {
    if (picked.length >= count) break;
    if (peak.level < threshold) break; // absteigend sortiert — Rest ist leiser
    // Mindestabstand zu bereits gewählten Highlights (Anker-zu-Fenster)
    if (picked.some(w => peak.t >= w.start - minGap && peak.t <= w.end + minGap)) continue;
    let start = Math.max(0, peak.t - pre);
    // Start auf den nächstliegenden früheren Szenenwechsel einrasten (≤ 2,5 s davor)
    const snap = scenes.filter(s => s <= start && s >= start - 2.5).sort((a, b) => b - a)[0];
    if (snap !== undefined) start = snap;
    const end = Math.min(total, Math.min(peak.t + post, start + maxLen));
    if (end - start < 2) continue;
    picked.push({ start: Number(start.toFixed(2)), end: Number(end.toFixed(2)), score: peak.level });
  }
  return picked.sort((a, b) => a.start - b.start);
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

  /**
   * v1088 — Basis-Schnitt: Clips trimmen (von–bis), auf eine gemeinsame
   * Leinwand croppen und mit Crossfades verketten; optionales Titel-Overlay
   * (PNG mit Alpha, vom Aufrufer gebacken). Ton wird mitgeschnitten, stumme
   * Clips bekommen Stille. Ergebnis liegt im workDir.
   */
  async editVideo(opts: {
    clips: Array<{ path: string; startSec?: number; endSec?: number;
      /** v1092 — Tempo 0,25–4 (Zeitlupe/Zeitraffer, Bild+Ton). */
      speed?: number;
      /** v1092 — Farb-Look aus EDIT_LOOKS. */
      look?: string;
      /** v1092 — Text-PNG (Leinwandgröße, Alpha) nur während dieses Clips. */
      overlayImage?: string;
    }>;
    format: '9:16' | '16:9';
    /** Titel-Overlay-PNG in Leinwandgröße (Alpha), z.B. aus applyImageOverlays. */
    overlayImage?: string;
    fadeSec?: number;
    outBaseName?: string;
  }): Promise<{ videoPath: string; durationSec: number }> {
    if (opts.clips.length === 0 || opts.clips.length > 8) throw new Error('Schnitt braucht 1–8 Clips.');
    const [w, h] = opts.format === '9:16' ? [1080, 1920] : [1920, 1080];
    // Je Clip: Dauer + Tonspur ermitteln, Trimm-Fenster festklopfen
    const probed: Array<{ path: string; startSec: number; durationSec: number; hasAudio: boolean; speed?: number; look?: string; overlayImage?: string }> = [];
    for (const c of opts.clips) {
      const p = await this.probeVideo(c.path);
      if (!p.ok || !p.durationSec) throw new Error(`Clip nicht lesbar: ${c.path.split(/[\\/]/).pop()} (${p.detail ?? 'keine Dauer'})`);
      const start = Math.max(0, Math.min(c.startSec ?? 0, p.durationSec - 0.2));
      const end = Math.min(c.endSec !== undefined && c.endSec > start ? c.endSec : p.durationSec, p.durationSec);
      const dur = end - start;
      if (dur < 0.4) throw new Error(`Trimm-Fenster zu kurz (${dur.toFixed(1)}s) bei ${c.path.split(/[\\/]/).pop()} — mindestens 0,4 s.`);
      const speed = typeof c.speed === 'number' && c.speed >= 0.25 && c.speed <= 4 && c.speed !== 1 ? c.speed : undefined;
      let hasAudio = false;
      try {
        const { stdout } = await execFileAsync(this.ffprobe,
          ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', c.path], { timeout: 20_000 });
        hasAudio = stdout.trim().length > 0;
      } catch { /* stumm behandeln */ }
      probed.push({
        path: c.path, startSec: start, durationSec: Number(dur.toFixed(3)), hasAudio,
        ...(speed ? { speed } : {}),
        ...(c.look && EDIT_LOOKS[c.look] ? { look: c.look } : {}),
        ...(c.overlayImage ? { overlayImage: c.overlayImage } : {}),
      });
    }
    // Crossfade darf keinen Clip überziehen (acrossfade verlangt EFFEKTIVE Länge ≥ fade)
    const minDur = Math.min(...probed.map(p => p.durationSec / (p.speed ?? 1)));
    const fade = probed.length > 1 ? Math.min(opts.fadeSec ?? 0.5, Math.max(0, minDur / 2 - 0.05)) : 0;

    // Inputs: erst die Videos, dann je stummem Clip ein anullsrc, dann die Overlays
    const args: string[] = ['-y'];
    for (const p of probed) args.push('-i', p.path);
    let nextIndex = probed.length;
    const clips = probed.map((p, k) => {
      const base = { index: k, startSec: p.startSec, durationSec: p.durationSec, ...(p.speed ? { speed: p.speed } : {}), ...(p.look ? { lookFilter: EDIT_LOOKS[p.look] } : {}) };
      if (p.hasAudio) return { ...base, audioIndex: k, audioFromVideo: true };
      args.push('-f', 'lavfi', '-t', String(p.durationSec / (p.speed ?? 1) + 1), '-i', 'anullsrc=r=48000:cl=stereo');
      return { ...base, audioIndex: nextIndex++, audioFromVideo: false };
    });
    const overlays: Array<{ inputIndex: number; fromSec?: number; toSec?: number; clip?: number }> = [];
    if (opts.overlayImage) {
      args.push('-i', opts.overlayImage);
      overlays.push({ inputIndex: nextIndex++, fromSec: 0, toSec: 3.5 });
    }
    for (let k = 0; k < probed.length; k++) {
      if (!probed[k].overlayImage) continue;
      args.push('-i', probed[k].overlayImage!);
      overlays.push({ inputIndex: nextIndex++, clip: k });
    }
    const graph = buildEditGraph({ clips, width: w, height: h, fadeSec: fade, ...(overlays.length > 0 ? { overlays } : {}) });
    const outPath = join(this.opts.workDir, `${opts.outBaseName ?? `edit-${Date.now().toString(36)}`}-${opts.format.replace(':', 'x')}.mp4`);
    args.push(
      '-filter_complex', graph.filterComplex,
      '-map', graph.outLabelV, '-map', graph.outLabelA,
      '-t', String(graph.totalSec),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac',
      outPath,
    );
    this.logger.info({ clips: probed.length, fade, format: opts.format, durationSec: graph.totalSec, title: Boolean(opts.overlayImage) }, 'v1088 editing video (trim + crossfade + overlay)');
    await execFileAsync(this.ffmpeg, args, { timeout: 10 * 60_000, maxBuffer: 10 * 1024 * 1024 });
    return { videoPath: outPath, durationSec: graph.totalSec };
  }

  /**
   * v1094 — Auto-Highlights: Lautheits-Verlauf (RMS je ~1 s) und Szenen-
   * wechsel messen, beste Fenster wählen (pickHighlightWindows). Videos
   * ohne Tonspur fallen auf reine Szenenwechsel-Anker zurück.
   */
  async analyzeHighlights(path: string, opts?: { count?: number; maxLenSec?: number }): Promise<Array<{ start: number; end: number; score: number }>> {
    const probe = await this.probeVideo(path);
    if (!probe.ok || !probe.durationSec) throw new Error(`Video nicht lesbar: ${probe.detail ?? 'keine Dauer'}`);
    // 1) RMS je Sekunde (astats über 1s-Fenster, Werte im stderr-Metadatenlog)
    const rms: Array<{ t: number; level: number }> = [];
    try {
      // asetnsamples=48000 macht 1s-Frames (astats' reset zählt FRAMES, nicht
      // Sekunden — ohne das kämen ~0,05s-Proben, E2E-Befund 11.07.)
      const { stderr } = await execFileAsync(this.ffmpeg,
        ['-i', path, '-af', 'aresample=48000,asetnsamples=n=48000,astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level', '-f', 'null', '-'],
        { timeout: 5 * 60_000, maxBuffer: 32 * 1024 * 1024 });
      const text = String(stderr);
      // Blöcke: "pts_time:12.3 ... lavfi.astats.Overall.RMS_level=-23.4"
      const re = /pts_time:(\d+(?:\.\d+)?)[\s\S]{0,200}?RMS_level=(-?\d+(?:\.\d+)?)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const level = Number(m[2]);
        if (Number.isFinite(level)) rms.push({ t: Number(m[1]), level });
      }
    } catch { /* stumm → Szenen-Fallback unten */ }
    // 2) Szenenwechsel (Schwelle 0,3)
    const scenes: number[] = [];
    try {
      const { stderr } = await execFileAsync(this.ffmpeg,
        ['-i', path, '-vf', "select='gt(scene,0.3)',metadata=mode=print:key=lavfi.scene_score", '-an', '-f', 'null', '-'],
        { timeout: 5 * 60_000, maxBuffer: 32 * 1024 * 1024 });
      const re = /pts_time:(\d+(?:\.\d+)?)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(String(stderr))) !== null) scenes.push(Number(m[1]));
    } catch { /* ohne Szenen geht es auch */ }
    if (rms.length === 0 && scenes.length === 0) throw new Error('Keine Analyse möglich (weder Tonspur noch Szenenwechsel erkannt).');
    // stummes Material: Szenenwechsel als gleichwertige Anker behandeln
    const effective = rms.length > 0 ? rms : scenes.map(t => ({ t, level: 0 }));
    const windows = pickHighlightWindows(effective, scenes, {
      ...(opts?.count ? { count: opts.count } : {}),
      ...(opts?.maxLenSec ? { maxLenSec: opts.maxLenSec } : {}),
      totalSec: probe.durationSec,
    });
    this.logger.info({ path: path.split(/[\\/]/).pop(), rmsSamples: rms.length, scenes: scenes.length, windows: windows.length }, 'v1094 highlight analysis');
    return windows;
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
    // v1106 — Zwei-Pass-Loudness: Stimme und Musik einmal vermessen, damit
    // loudnorm im Graph LINEAR läuft (konstantes Gain — kein Pumpen, Emotionen
    // der Sprecherin bleiben erhalten). Messfehler → dynamischer Fallback.
    const [voiceMeasured, musicMeasured] = music
      ? await Promise.all([
        audioPath ? this.measureLoudness(audioPath, '-16', '-1.5', '11') : Promise.resolve(undefined),
        this.measureLoudness(music, '-9', '-1', '9'),
      ])
      : [undefined, undefined];
    const audioGraph = music
      ? buildReelAudioGraph({
        ...(audioPath ? { voiceIndex: slideFiles.length } : {}),
        musicIndex: slideFiles.length + (audioPath ? 1 : 0),
        ...(spec.musicVolume !== undefined ? { musicVolume: spec.musicVolume } : {}),
        totalSec: graph.totalSec,
        ...(voiceMeasured ? { voiceMeasured } : {}),
        ...(musicMeasured ? { musicMeasured } : {}),
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
        // v1082 — auch ohne Musik-Bett die Stimme aufs Plattform-Ziel
        // normalisieren (Klon-Stimmen kommen sonst je nach Sample zu leise an)
        : audioPath ? ['-map', `${slideFiles.length}:a`, '-c:a', 'aac', '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000,apad'] : ['-an']),
      '-t', String(graph.totalSec),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30',
      outPath,
    ];
    this.logger.info({ images: spec.images.length, clips: clipByIndex.size, intro: introSec, outro: outroSec, music: Boolean(music), twoPass: Boolean(voiceMeasured || musicMeasured), durationSec: graph.totalSec, format: spec.format }, 'v1058 rendering reel video (cover-crop + ken-burns + crossfades)');
    await execFileAsync(this.ffmpeg, args, { timeout: 10 * 60_000, maxBuffer: 10 * 1024 * 1024 });
    return { videoPath: outPath, durationSec: graph.totalSec };
  }

  /**
   * v1106 — Loudness-Messlauf (erster Pass): liefert die measured_*-Werte für
   * loudnorm im Linear-Modus. Jeder Fehler ist still (undefined) — der Graph
   * fällt dann auf den dynamischen Ein-Pass-Modus zurück.
   */
  private async measureLoudness(filePath: string, i: string, tp: string, lra: string): Promise<LoudnessMeasurement | undefined> {
    try {
      const { stderr } = await execFileAsync(this.ffmpeg, [
        '-hide_banner', '-nostats', '-i', filePath,
        '-af', `loudnorm=I=${i}:TP=${tp}:LRA=${lra}:print_format=json`,
        '-f', 'null', '-',
      ], { timeout: 2 * 60_000, maxBuffer: 10 * 1024 * 1024 });
      return parseLoudnormMeasurement(String(stderr ?? ''));
    } catch {
      return undefined;
    }
  }
}
