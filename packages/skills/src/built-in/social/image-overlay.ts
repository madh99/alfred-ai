import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import type { SocialChannel } from '@alfred/storage';

/**
 * v1002 — Deterministische Text-Overlays für generierte Bilder.
 *
 * Bildmodelle rendern Text FALSCH (v982-Realfall: halluziniertes Datum) —
 * deshalb generiert das Modell ein textfreies Motiv und Alfred legt die
 * Text-Ebenen danach pixelgenau darüber (sharp + SVG-Compositing):
 * Wasserzeichen/Branding, optionaler Titelbalken, Termin-Karte (v1003).
 * Scheitert das Compositing (sharp fehlt, kaputtes Bild), kommt das
 * Original zurück — Overlays dürfen die Bild-Pipeline NIE brechen.
 */

export interface TerminOverlay {
  /** Match/Anlass, z.B. „Portugal – Spanien" */
  headline: string;
  /** Formatierter Anpfiff, z.B. „So., 06.07. · 21:00 Uhr" */
  anpfiff: string;
  einlass?: string;
  ort?: string;
}

/** v1026 — Ecke für Wasserzeichen/Logo. */
export type OverlayCorner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';

export function parseOverlayCorner(raw: unknown, fallback: OverlayCorner): OverlayCorner {
  return raw === 'bottom-right' || raw === 'bottom-left' || raw === 'top-right' || raw === 'top-left' ? raw : fallback;
}

/** v1026 — Logo-Overlay: SVG-Markup inline (HA-sicher in der Kanal-Config, kein Datei-Sync nötig). */
export interface LogoOverlay {
  svg: string;
  /** Ecke, Default bottom-right */
  corner?: OverlayCorner;
  /** v1032 — Logo umfärben (Hex, z.B. "#ffffff"); leer/fehlend = Originalfarben des SVG */
  color?: string;
}

/**
 * v1032 — SVG umfärben: ersetzt alle fill-Werte (Attribut UND style-Notation)
 * durch die Zielfarbe — außer "none"/"transparent" (Löcher/Konturen bleiben).
 * Hat das SVG gar kein fill (Default-Schwarz), bekommt das Root-Element eins.
 * EIN hochgeladenes Logo reicht damit für alle Kanäle und Untergründe.
 */
export function recolorSvg(svg: string, color: string): string {
  if (!/^#[0-9a-fA-F]{3,8}$/.test(color)) return svg;
  let out = svg
    .replace(/fill="(?!none|transparent)[^"]*"/gi, `fill="${color}"`)
    .replace(/fill='(?!none|transparent)[^']*'/gi, `fill='${color}'`)
    .replace(/fill:\s*(?!none|transparent)[^;"'}]+/gi, `fill:${color}`);
  if (!/fill[=:]/i.test(out)) out = out.replace(/<svg\b/i, `<svg fill="${color}"`);
  return out;
}

export interface OverlaySpec {
  /** Text-Wasserzeichen (z.B. „fussball.cc") */
  branding?: string;
  /** v1026 — Ecke des Text-Wasserzeichens (Default bottom-right) */
  brandingCorner?: OverlayCorner;
  /** Titel-Overlay (v1026: gestapelte Text-Boxen unten links, optionale Vorzeile vor „:") */
  title?: string;
  /** v1065 — Titel-Zeilen früher umbrechen (0,3–1, Anteil der Bildbreite; Default 1).
   * Für Video-Hooks: kürzere, gestaffelte Boxen statt einer bildbreiten Balken-Zeile. */
  titleMaxWidthRatio?: number;
  /** v1065 — intern: gemessene Ink-Breiten der Titel-Zeilen (Index-gleich zu
   * computeTitleLines) — applyImageOverlays füllt das per sharp-Messung. */
  titleMeasuredWidths?: number[];
  /** v1003 — Termin-Karte (ersetzt den Titelbalken) */
  termin?: TerminOverlay;
  /** v1007 — CTA-Zeile oben zentriert (z.B. „🔗 Link im Profil" für Stories) */
  cta?: string;
  /** v1026 — Logo (SVG) in wählbarer Ecke, kombinierbar mit dem Text-Wasserzeichen */
  logo?: LogoOverlay;
  /** Schriftfamilie (muss auf dem Host installiert sein), Default DejaVu Sans */
  font?: string;
}

type SharpModule = (input?: Buffer) => {
  metadata(): Promise<{ width?: number; height?: number }>;
  composite(layers: Array<{ input: Buffer; top?: number; left?: number }>): { png(): { toBuffer(): Promise<Buffer> } };
  extract(region: { left: number; top: number; width: number; height: number }): { png(): { toBuffer(): Promise<Buffer> } };
  resize(opts: { width?: number; height?: number; fit?: string }): { png(): { toBuffer(): Promise<Buffer> } };
};

let sharpCache: SharpModule | null | undefined;

/** sharp lazy laden (externalisierte Dependency — Bundle-Fallback via createRequire). */
export async function loadSharp(): Promise<SharpModule | null> {
  if (sharpCache !== undefined) return sharpCache;
  try {
    sharpCache = ((await import('sharp')) as { default: SharpModule }).default;
  } catch {
    try {
      const require = createRequire(realpathSync(process.argv[1] || ''));
      sharpCache = require('sharp') as SharpModule;
    } catch {
      sharpCache = null;
    }
  }
  return sharpCache;
}

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * v1054 — Piktogramme aus Overlay-Text strippen: die SVG-Schrift (DejaVu) hat
 * keine Emoji-Glyphen — der Renderer brennt fehlende Zeichen als Unicode-
 * Hex-Tofu ins Bild (Realfall 08.07., IG-Post: Titel „… ⏳ 🇨🇭" → eigene Box
 * mit „23F3 1F1E8 1F1ED"). Gilt NUR für eingebrannte Overlays — Captions/
 * Plattform-Texte behalten ihre Emojis.
 */
/**
 * v1058 — Reel-End-Card: letztes Slide-Bild abdunkeln + CTA-Pille (+ Branding)
 * einbrennen — die letzten ~2s des Reels, nach dem Voiceover. Nutzt dieselbe
 * Overlay-Engine wie die Bilder (kein neuer Text-Renderer).
 */
export async function bakeReelEndCard(buffer: Buffer, cta: string, branding?: string): Promise<Buffer> {
  const sharp = await loadSharp();
  if (!sharp) return buffer;
  const darkened = await (sharp as unknown as (i: Buffer) => {
    modulate(o: { brightness: number; saturation?: number }): { toBuffer(): Promise<Buffer> };
  })(buffer).modulate({ brightness: 0.45, saturation: 0.8 }).toBuffer();
  return applyImageOverlays(darkened, { cta, ...(branding ? { branding } : {}) });
}

export function stripPictographs(s: string): string {
  return s
    .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, '') // Regionalindikatoren (Flaggen wie 🇨🇭)
    .replace(/\p{Extended_Pictographic}/gu, '') // Emojis/Symbole inkl. ⏳
    .replace(/[\u{FE0E}\u{FE0F}\u{200D}\u{20E3}]/gu, '') // Variation-Selektoren, ZWJ, Keycap
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.!?:;])/g, '$1')
    .trim();
}

/** Text auf Zeilen umbrechen (Wort-Grenzen), harte Kappung auf maxLines. */
export function wrapText(text: string, maxCharsPerLine: number, maxLines: number): string[] {
  // v1022 — Einzelwörter über Zeilenbreite hart trennen (vorher lief z.B. ein
  // langer Vereinsname ungebrochen aus dem Titelbalken)
  const words = text.trim().split(/\s+/).flatMap(w => {
    if (w.length <= maxCharsPerLine) return [w];
    const parts: string[] = [];
    for (let i = 0; i < w.length; i += maxCharsPerLine - 1) {
      const chunk = w.slice(i, i + maxCharsPerLine - 1);
      parts.push(i + maxCharsPerLine - 1 < w.length ? `${chunk}-` : chunk);
    }
    return parts;
  });
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line.length === 0) { line = word; continue; }
    if ((line + ' ' + word).length <= maxCharsPerLine) line += ' ' + word;
    else {
      lines.push(line);
      line = word;
      if (lines.length === maxLines) break;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  else if (lines.length === maxLines && line && lines[maxLines - 1] !== line) {
    // Rest passt nicht mehr → letzte Zeile mit Ellipse markieren
    lines[maxLines - 1] = lines[maxLines - 1] + '…';
  }
  return lines;
}

/**
 * Branding-Text eines Kanals auflösen (generisch):
 * 1. config.image_branding (String) — explizit je Kanal; false/'' = aus.
 * 2. Domain des Familien-Lead-Kanals (config.base_url, ohne Protokoll/www).
 * 3. Kanalname.
 */
export function resolveImageBranding(channel: SocialChannel, siblings: SocialChannel[]): string | undefined {
  const cfg = channel.config.image_branding;
  if (cfg === false) return undefined;
  if (typeof cfg === 'string') return cfg.trim() || undefined;
  const familyOf = (c: SocialChannel): string | null => {
    if (typeof c.config.family === 'string' && c.config.family.trim()) return `family:${c.config.family.trim().toLowerCase()}`;
    return c.projectId ? `project:${c.projectId}` : null;
  };
  const fam = familyOf(channel);
  if (fam) {
    const members = [channel, ...siblings.filter(c => c.id !== channel.id)].filter(c => familyOf(c) === fam);
    const lead = members.find(c => c.config.family_role === 'lead') ?? members.find(c => c.platform === 'rest');
    const base = lead && typeof lead.config.base_url === 'string' ? lead.config.base_url : undefined;
    if (base) {
      const domain = base.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/:].*$/, '');
      // v1018 — IP-Adressen/localhost sind interne Deploy-URLs, kein Branding
      // (Realfall: Wasserzeichen zeigte „192.168.1.96")
      const isInternal = /^(\d{1,3}\.){3}\d{1,3}$/.test(domain) || domain === 'localhost' || !domain.includes('.');
      if (domain && !isInternal) return domain;
    }
  }
  return channel.name;
}

/**
 * v1033 — Zeilen-Stapel im Nachrichten-Box-Stil, von UNTEN LINKS verankert:
 * jede Zeile bekommt ihren eigenen dunklen Kasten; textLength zwingt den Text
 * exakt in die Box (kein horizontaler Überlauf mehr, egal wie die Font misst —
 * Realfall 06.07.: Termin-Headline lief rechts aus dem Bild, Info-Zeilen
 * fielen unten raus). Bottom-Anker macht Unten-Überlauf unmöglich.
 */
function renderBoxStack(
  parts: string[], lines: Array<{ text: string; size: number; bold?: boolean; measuredW?: number }>,
  width: number, height: number, pad: number, font: string,
): void {
  if (lines.length === 0) return;
  const boxes = lines.map(l => {
    // v1065 — GEMESSENE Textbreite (sharp/trim) hat Vorrang: die librsvg auf
    // dem Host ignoriert textLength komplett, der Text lief rechts aus der
    // geschätzten Box (Realfall 09.07.: „…Mannschaft" im"/„Marokko:" ragten
    // über die Box hinaus). Ohne Messung bleibt die Schätzung + Klammer.
    let size = l.size;
    let measured = typeof l.measuredW === 'number' && l.measuredW > 0 ? l.measuredW : undefined;
    const padXOf = (s: number) => Math.round(s * 0.45);
    if (measured !== undefined) {
      const maxInner = width - pad * 2 - padXOf(size) * 2;
      if (measured > maxInner) {
        // Fontmetriken skalieren linear → exakt passend verkleinern
        size = Math.max(10, Math.floor(size * (maxInner / measured)));
        measured = maxInner;
      }
    } else {
      // v1063 — Sicherheits-Klammer für den Schätz-Pfad
      const maxInner = width - pad * 2 - padXOf(size) * 2;
      const fitSize = Math.floor(maxInner / (l.text.length * 0.62));
      if (fitSize > 0) size = Math.min(size, fitSize);
    }
    const padX = padXOf(size);
    const padY = Math.round(size * 0.26);
    const innerW = measured ?? Math.round(l.text.length * size * 0.58);
    const boxW = Math.min(width - pad * 2, innerW + padX * 2);
    return { ...l, size, padX, padY, boxW, boxH: size + padY * 2, measured };
  });
  const gap = Math.max(4, Math.round(Math.max(...boxes.map(b => b.size)) * 0.16));
  const totalH = boxes.reduce((s, b) => s + b.boxH, 0) + gap * (boxes.length - 1);
  let y = Math.max(pad, height - pad - totalH);
  for (const b of boxes) {
    parts.push(`<rect x="${pad}" y="${y}" width="${b.boxW}" height="${b.boxH}" fill="#101826" fill-opacity="0.93"/>`);
    // Bei gemessener Breite rendert der Text natürlich (passt garantiert);
    // textLength nur im Schätz-Pfad (falls die SVG-Engine es doch kann).
    const fit = b.measured !== undefined ? '' : ` textLength="${b.boxW - b.padX * 2}" lengthAdjust="spacingAndGlyphs"`;
    parts.push(`<text x="${pad + b.padX}" y="${y + b.padY + Math.round(b.size * 0.85)}" font-family="${font}" font-size="${b.size}"${b.bold === false ? '' : ' font-weight="bold"'} fill="#ffffff"${fit}>${escapeXml(b.text)}</text>`);
    y += b.boxH + gap;
  }
}

/**
 * v1065 — Titel-Zeilen deterministisch berechnen (Kicker-Split + Umbruch) —
 * exportiert, damit applyImageOverlays die IDENTISCHEN Zeilen vermessen kann.
 */
export function computeTitleLines(width: number, title: string, maxWidthRatio?: number): Array<{ text: string; size: number }> {
  const pad = Math.round(width * 0.035);
  const raw = stripPictographs(title).trim();
  if (!raw) return [];
  const colonIdx = raw.indexOf(': ');
  const kicker = colonIdx > 8 && colonIdx < raw.length - 4 ? raw.slice(0, colonIdx + 1) : undefined;
  const main = kicker ? raw.slice(colonIdx + 2) : raw;
  const mainSize = Math.round(width / 17);
  const kickerSize = Math.round(width / 27);
  // v1065 — optional engerer Umbruch (Video-Hook): Zeilen brechen früher,
  // die Boxen werden kürzer und gestaffelt statt einer bildbreiten Zeile
  const ratio = typeof maxWidthRatio === 'number' && maxWidthRatio >= 0.3 && maxWidthRatio <= 1 ? maxWidthRatio : 1;
  const usable = Math.round(width * ratio) - pad * 2;
  const lines: Array<{ text: string; size: number }> = [];
  if (kicker) {
    lines.push({ text: wrapText(kicker, Math.floor(usable / (kickerSize * 0.58)), 1)[0] ?? kicker, size: kickerSize });
  }
  for (const text of wrapText(main, Math.floor(usable / (mainSize * 0.58)), 3)) {
    lines.push({ text, size: mainSize });
  }
  return lines;
}

/** SVG der Overlay-Ebenen bauen (getrennt exportiert für Tests). */
export function buildOverlaySvg(width: number, height: number, rawSpec: OverlaySpec): string {
  // v1054 — alle Text-Eingänge der eingebrannten Ebenen von Piktogrammen
  // befreien; leer gewordene Texte fallen komplett weg (keine Leer-Boxen)
  const spec: OverlaySpec = {
    ...rawSpec,
    title: rawSpec.title ? (stripPictographs(rawSpec.title) || undefined) : rawSpec.title,
    cta: rawSpec.cta ? (stripPictographs(rawSpec.cta) || undefined) : rawSpec.cta,
    branding: rawSpec.branding ? (stripPictographs(rawSpec.branding) || undefined) : rawSpec.branding,
    termin: rawSpec.termin ? {
      ...rawSpec.termin,
      headline: stripPictographs(rawSpec.termin.headline),
      ...(rawSpec.termin.ort ? { ort: stripPictographs(rawSpec.termin.ort) || undefined } : {}),
    } : rawSpec.termin,
  };
  const font = escapeXml(spec.font ?? 'DejaVu Sans, sans-serif');
  const parts: string[] = [];
  const pad = Math.round(width * 0.035);

  if (spec.termin) {
    // v1033 — Termin-Karte im selben Box-Stil wie Titel: Headline groß,
    // darunter Anpfiff/Einlass/Ort als kleinere Box-Zeilen; alles von unten
    // verankert (vorher: alter Verlaufsbalken, Headline lief rechts raus,
    // Info-Zeilen fielen bei 2-zeiliger Headline unten aus dem Bild).
    const t = spec.termin;
    const headSize = Math.round(width / 17);
    const infoSize = Math.round(width / 30);
    const headLines = wrapText(t.headline, Math.floor((width - pad * 2) / (headSize * 0.58)), 2);
    const lines: Array<{ text: string; size: number; bold?: boolean }> = headLines.map(text => ({ text, size: headSize }));
    lines.push({ text: `Anpfiff ${t.anpfiff}`, size: infoSize });
    if (t.einlass) lines.push({ text: `Einlass ${t.einlass}`, size: infoSize });
    if (t.ort) lines.push({ text: t.ort, size: infoSize, bold: false });
    renderBoxStack(parts, lines, width, height, pad, font);
  } else if (spec.title) {
    // v1026 — Nachrichten-Stil (ZIB-Muster): gestapelte Text-Boxen unten links;
    // enthält der Titel „Vorzeile: Rest", wird die Vorzeile als kleinere
    // Kicker-Box darüber gesetzt.
    const lines: Array<{ text: string; size: number; measuredW?: number }> = computeTitleLines(width, spec.title, spec.titleMaxWidthRatio);
    // v1065 — gemessene Ink-Breiten (aus applyImageOverlays) den Zeilen zuordnen
    if (Array.isArray(spec.titleMeasuredWidths)) {
      spec.titleMeasuredWidths.forEach((w, i) => { if (lines[i] && typeof w === 'number' && w > 0) lines[i].measuredW = w; });
    }
    renderBoxStack(parts, lines, width, height, pad, font);
  }

  if (spec.cta) {
    // v1007 — CTA oben zentriert (Story-Format): dunkle Pille + Text
    const ctaSize = Math.max(16, Math.round(width / 26));
    const ctaText = spec.cta;
    const pillW = Math.min(width - pad * 2, Math.round(ctaText.length * ctaSize * 0.62 + pad * 2));
    const pillH = Math.round(ctaSize * 1.9);
    const pillX = Math.round((width - pillW) / 2);
    const pillY = pad;
    parts.push(`<rect x="${pillX}" y="${pillY}" width="${pillW}" height="${pillH}" rx="${Math.round(pillH / 2)}" fill="#000000" fill-opacity="0.55"/>`);
    parts.push(`<text x="${Math.round(width / 2)}" y="${pillY + Math.round(pillH * 0.68)}" text-anchor="middle" font-family="${font}" font-size="${ctaSize}" font-weight="bold" fill="#ffffff">${escapeXml(ctaText)}</text>`);
  }

  if (spec.branding) {
    // Wasserzeichen — dezent, mit Schatten für Lesbarkeit auf hellen Bildern;
    // v1026: Ecke wählbar (Default unten rechts)
    const corner = spec.brandingCorner ?? 'bottom-right';
    const brandSize = Math.max(14, Math.round(width / 42));
    const right = corner.endsWith('right');
    const bx = right ? width - pad : pad;
    const by = corner.startsWith('top') ? pad + brandSize : height - Math.round(pad * 0.7);
    parts.push(`<text x="${bx}" y="${by}" text-anchor="${right ? 'end' : 'start'}" font-family="${font}" font-size="${brandSize}" font-weight="bold" fill="#ffffff" fill-opacity="0.85" stroke="#000000" stroke-opacity="0.45" stroke-width="${Math.max(1, Math.round(brandSize / 12))}" paint-order="stroke">${escapeXml(spec.branding)}</text>`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${parts.join('')}</svg>`;
}

/**
 * Overlays anwenden. Gibt bei JEDEM Fehler (sharp fehlt, Bild kaputt) das
 * Original zurück — nie die Pipeline brechen.
 */
export async function applyImageOverlays(png: Buffer, spec: OverlaySpec): Promise<Buffer> {
  if (!spec.branding && !spec.title && !spec.termin && !spec.cta && !spec.logo) return png;
  try {
    const sharp = await loadSharp();
    if (!sharp) return png;
    const meta = await sharp(png).metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (width < 100 || height < 100) return png;
    // v1065 — Titel-Zeilen VOR dem SVG-Bau echt vermessen (Ink-Breite via
    // sharp/trim): die librsvg ignoriert textLength, die 0,58er-Schätzung war
    // für fette Schrift zu knapp — Text ragte über die Box hinaus.
    let effSpec = spec;
    if (spec.title && !spec.termin) {
      const font = spec.font ?? 'DejaVu Sans';
      const widths: number[] = [];
      for (const l of computeTitleLines(width, spec.title, spec.titleMaxWidthRatio)) {
        try {
          const cw = Math.max(64, Math.round(l.text.length * l.size * 1.4));
          const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cw}" height="${l.size * 3}"><text x="${l.size}" y="${l.size * 2}" font-family="${font}" font-size="${l.size}" font-weight="bold" fill="#ffffff">${escapeXml(l.text)}</text></svg>`;
          const { info } = await (sharp as unknown as (i: Buffer) => { trim(): { toBuffer(o: { resolveWithObject: true }): Promise<{ info: { width: number } }> } })(Buffer.from(svg))
            .trim().toBuffer({ resolveWithObject: true });
          widths.push(info.width > 0 ? info.width : 0);
        } catch { widths.push(0); }
      }
      if (widths.some(w => w > 0)) effSpec = { ...spec, titleMeasuredWidths: widths };
    }
    const layers: Array<{ input: Buffer; top?: number; left?: number }> = [
      { input: Buffer.from(buildOverlaySvg(width, height, effSpec)), top: 0, left: 0 },
    ];
    // v1026 — Logo (SVG) in wählbarer Ecke: separat rasterisiert (~13 % der
    // Bildbreite); Fehler im Logo (kaputtes SVG) kosten NIE das Bild
    if (spec.logo?.svg && spec.logo.svg.length < 300_000) {
      try {
        const pad = Math.round(width * 0.035);
        // v1032 — optionale Umfärbung (ein SVG für alle Kanäle/Untergründe)
        const markup = spec.logo.color ? recolorSvg(spec.logo.svg, spec.logo.color) : spec.logo.svg;
        const logoBuf = await sharp(Buffer.from(markup)).resize({ width: Math.round(width * 0.13), fit: 'inside' }).png().toBuffer();
        const lm = await sharp(logoBuf).metadata();
        const lw = lm.width ?? 0;
        const lh = lm.height ?? 0;
        if (lw > 0 && lh > 0 && lw < width && lh < height) {
          const corner = spec.logo.corner ?? 'bottom-right';
          const left = corner.endsWith('right') ? width - lw - pad : pad;
          const top = corner.startsWith('top') ? pad : height - lh - pad;
          layers.push({ input: logoBuf, top, left });
        }
      } catch { /* Logo best-effort */ }
    }
    return await sharp(png).composite(layers).png().toBuffer();
  } catch {
    return png;
  }
}

/**
 * v1066/v1067 — Dauer-Branding-Ebene fürs Video (TV-Bug-Stil): transparentes
 * PNG in Zielgröße. Bei Text+Logo drei Anordnungen: 'stack' (Block: Logo über
 * Text, eine Ecke), 'stack_fit' (wie stack, Text auf Logo-Breite skaliert),
 * 'split' (Text und Logo unabhängig positioniert wie bei den Bildern).
 * null bei Fehler/ohne sharp.
 */
export async function buildVideoWatermark(
  width: number, height: number,
  spec: {
    branding?: string; logo?: LogoOverlay; corner?: OverlayCorner;
    layout?: 'stack' | 'stack_fit' | 'split';
    /** split: eigene Ecke fürs Logo (Text nutzt corner). */
    logoCorner?: OverlayCorner;
  },
): Promise<Buffer | null> {
  if (!spec.branding && !spec.logo?.svg) return null;
  try {
    const sharp = await loadSharp();
    if (!sharp) return null;
    const s = sharp as unknown as ((i?: Buffer | object) => {
      png(): { toBuffer(): Promise<Buffer> };
      trim(): { toBuffer(o: { resolveWithObject: true }): Promise<{ data: Buffer; info: { width: number; height: number } }> };
      resize(o: object): { png(): { toBuffer(): Promise<Buffer> } };
      metadata(): Promise<{ width?: number; height?: number }>;
      composite(l: Array<{ input: Buffer; top: number; left: number }>): { png(): { toBuffer(): Promise<Buffer> } };
    });
    const blank = await s({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    const both = Boolean(spec.branding && spec.logo?.svg);
    const layout = both ? (spec.layout ?? 'stack') : 'split';
    if (layout === 'split') {
      // Einzel-Modi + getrennte Positionierung: unabhängige Ebenen wie v1066
      const out = await applyImageOverlays(blank, {
        ...(spec.branding ? { branding: spec.branding, brandingCorner: spec.corner ?? 'bottom-right' } : {}),
        ...(spec.logo?.svg ? { logo: { ...spec.logo, corner: spec.logoCorner ?? spec.corner ?? spec.logo.corner ?? 'bottom-right' } } : {}),
      });
      return out === blank ? null : out;
    }
    // v1067 — Block-Anordnung: Logo + Text als EINE Einheit in der Ecke
    const pad = Math.round(width * 0.035);
    const corner = spec.corner ?? 'bottom-right';
    const markup = spec.logo!.color ? recolorSvg(spec.logo!.svg, spec.logo!.color) : spec.logo!.svg;
    const logoBuf = await s(Buffer.from(markup)).resize({ width: Math.round(width * 0.13), fit: 'inside' }).png().toBuffer();
    const lm = await s(logoBuf).metadata();
    const logoW = lm.width ?? 0;
    const logoH = lm.height ?? 0;
    if (logoW <= 0 || logoH <= 0) return null;
    // Text als getrimmtes PNG (echte Ink-Breite, Stil wie das Bild-Wasserzeichen)
    let textSize = Math.max(14, Math.round(width / 42));
    const renderText = async (size: number) => {
      const cw = Math.max(64, Math.round(spec.branding!.length * size * 1.4));
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cw}" height="${size * 3}"><text x="${size}" y="${size * 2}" font-family="DejaVu Sans" font-size="${size}" font-weight="bold" fill="#ffffff" fill-opacity="0.85" stroke="#000000" stroke-opacity="0.45" stroke-width="${Math.max(1, Math.round(size / 12))}" paint-order="stroke">${escapeXml(stripPictographs(spec.branding!))}</text></svg>`;
      return s(Buffer.from(svg)).trim().toBuffer({ resolveWithObject: true });
    };
    let text = await renderText(textSize);
    if (layout === 'stack_fit' && text.info.width > 0) {
      // Text auf Logo-Breite angleichen (Fontmetriken skalieren linear)
      textSize = Math.max(10, Math.round(textSize * (logoW / text.info.width)));
      text = await renderText(textSize);
    }
    const gap = Math.round(textSize / 3);
    const blockW = Math.max(logoW, text.info.width);
    const blockH = logoH + gap + text.info.height;
    const left = corner.endsWith('right') ? width - blockW - pad : pad;
    const top = corner.startsWith('top') ? pad : height - blockH - pad;
    return await s(blank).composite([
      { input: logoBuf, top, left: left + Math.round((blockW - logoW) / 2) },
      { input: text.data, top: top + logoH + gap, left: left + Math.round((blockW - text.info.width) / 2) },
    ]).png().toBuffer();
  } catch { return null; }
}

/** v1004 — Bild auf ein Ziel-Seitenverhältnis zuschneiden (zentriert), z.B. Instagram 4:5. */
export async function cropToRatio(png: Buffer, ratioW: number, ratioH: number): Promise<Buffer> {
  try {
    const sharp = await loadSharp();
    if (!sharp) return png;
    const meta = await sharp(png).metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (width < 100 || height < 100) return png;
    const target = ratioW / ratioH;
    const current = width / height;
    if (Math.abs(current - target) < 0.01) return png;
    let w = width; let h = height;
    if (current > target) w = Math.round(height * target);
    else h = Math.round(width / target);
    const left = Math.round((width - w) / 2);
    const top = Math.round((height - h) / 2);
    return await sharp(png).extract({ left, top, width: w, height: h }).png().toBuffer();
  } catch {
    return png;
  }
}
