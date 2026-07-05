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

export interface OverlaySpec {
  /** Wasserzeichen unten rechts (z.B. „fussball.cc") */
  branding?: string;
  /** Titelbalken unten (max. 2 Zeilen, automatische Schriftgröße) */
  title?: string;
  /** v1003 — Termin-Karte (ersetzt den Titelbalken) */
  termin?: TerminOverlay;
  /** Schriftfamilie (muss auf dem Host installiert sein), Default DejaVu Sans */
  font?: string;
}

type SharpModule = (input?: Buffer) => {
  metadata(): Promise<{ width?: number; height?: number }>;
  composite(layers: Array<{ input: Buffer; top?: number; left?: number }>): { png(): { toBuffer(): Promise<Buffer> } };
  extract(region: { left: number; top: number; width: number; height: number }): { png(): { toBuffer(): Promise<Buffer> } };
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

/** Text auf Zeilen umbrechen (Wort-Grenzen), harte Kappung auf maxLines. */
export function wrapText(text: string, maxCharsPerLine: number, maxLines: number): string[] {
  const words = text.trim().split(/\s+/);
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
      if (domain) return domain;
    }
  }
  return channel.name;
}

/** SVG der Overlay-Ebenen bauen (getrennt exportiert für Tests). */
export function buildOverlaySvg(width: number, height: number, spec: OverlaySpec): string {
  const font = escapeXml(spec.font ?? 'DejaVu Sans, sans-serif');
  const parts: string[] = [];
  const pad = Math.round(width * 0.035);

  if (spec.termin) {
    // Termin-Karte: dunkler Verlauf über dem unteren Drittel + strukturierte Zeilen
    const t = spec.termin;
    const cardH = Math.round(height * 0.34);
    const top = height - cardH;
    const headSize = Math.round(width / 16);
    const lineSize = Math.round(width / 30);
    const headLines = wrapText(t.headline, Math.floor(width / (headSize * 0.58)), 2);
    parts.push(`<linearGradient id="tg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="0.35" stop-color="#000" stop-opacity="0.72"/><stop offset="1" stop-color="#000" stop-opacity="0.88"/></linearGradient>`);
    parts.push(`<rect x="0" y="${top}" width="${width}" height="${cardH}" fill="url(#tg)"/>`);
    let y = top + Math.round(cardH * 0.30);
    for (const line of headLines) {
      parts.push(`<text x="${pad}" y="${y}" font-family="${font}" font-size="${headSize}" font-weight="bold" fill="#ffffff">${escapeXml(line)}</text>`);
      y += Math.round(headSize * 1.15);
    }
    y += Math.round(lineSize * 0.4);
    const info: string[] = [`Anpfiff ${t.anpfiff}`];
    if (t.einlass) info.push(`Einlass ${t.einlass}`);
    if (t.ort) info.push(t.ort);
    for (const line of info) {
      parts.push(`<text x="${pad}" y="${y}" font-family="${font}" font-size="${lineSize}" fill="#f2f2f2">${escapeXml(line)}</text>`);
      y += Math.round(lineSize * 1.45);
    }
  } else if (spec.title) {
    // Titelbalken: Verlauf unten + max. 2 Zeilen
    const titleSize = Math.round(width / 18);
    const lines = wrapText(spec.title, Math.floor(width / (titleSize * 0.58)), 2);
    const bandH = Math.round(titleSize * 1.3 * lines.length + pad * 2.2);
    const top = height - bandH;
    parts.push(`<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.82"/></linearGradient>`);
    parts.push(`<rect x="0" y="${top}" width="${width}" height="${bandH}" fill="url(#bg)"/>`);
    let y = top + pad + titleSize;
    for (const line of lines) {
      parts.push(`<text x="${pad}" y="${y}" font-family="${font}" font-size="${titleSize}" font-weight="bold" fill="#ffffff">${escapeXml(line)}</text>`);
      y += Math.round(titleSize * 1.3);
    }
  }

  if (spec.branding) {
    // Wasserzeichen unten rechts — dezent, mit Schatten für Lesbarkeit auf hellen Bildern
    const brandSize = Math.max(14, Math.round(width / 42));
    const bx = width - pad;
    const by = height - Math.round(pad * 0.7);
    parts.push(`<text x="${bx}" y="${by}" text-anchor="end" font-family="${font}" font-size="${brandSize}" font-weight="bold" fill="#ffffff" fill-opacity="0.85" stroke="#000000" stroke-opacity="0.45" stroke-width="${Math.max(1, Math.round(brandSize / 12))}" paint-order="stroke">${escapeXml(spec.branding)}</text>`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${parts.join('')}</svg>`;
}

/**
 * Overlays anwenden. Gibt bei JEDEM Fehler (sharp fehlt, Bild kaputt) das
 * Original zurück — nie die Pipeline brechen.
 */
export async function applyImageOverlays(png: Buffer, spec: OverlaySpec): Promise<Buffer> {
  if (!spec.branding && !spec.title && !spec.termin) return png;
  try {
    const sharp = await loadSharp();
    if (!sharp) return png;
    const meta = await sharp(png).metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (width < 100 || height < 100) return png;
    const svg = buildOverlaySvg(width, height, spec);
    return await sharp(png).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toBuffer();
  } catch {
    return png;
  }
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
