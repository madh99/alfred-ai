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
}

export interface OverlaySpec {
  /** Text-Wasserzeichen (z.B. „fussball.cc") */
  branding?: string;
  /** v1026 — Ecke des Text-Wasserzeichens (Default bottom-right) */
  brandingCorner?: OverlayCorner;
  /** Titel-Overlay (v1026: gestapelte Text-Boxen unten links, optionale Vorzeile vor „:") */
  title?: string;
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
    // v1026 — Nachrichten-Stil (ZIB-Muster): gestapelte Text-Boxen unten links,
    // jede Zeile mit eigenem dunklem Kasten; enthält der Titel „Vorzeile: Rest",
    // wird die Vorzeile als kleinere Kicker-Box darüber gesetzt. Ersetzt den
    // alten Vollbreiten-Verlaufsbalken (Titel liefen dort mitten im Wort in „…").
    const raw = spec.title.trim();
    const colonIdx = raw.indexOf(': ');
    const kicker = colonIdx > 8 && colonIdx < raw.length - 4 ? raw.slice(0, colonIdx + 1) : undefined;
    const main = kicker ? raw.slice(colonIdx + 2) : raw;
    const mainSize = Math.round(width / 17);
    const kickerSize = Math.round(width / 27);
    const boxPadX = Math.round(mainSize * 0.45);
    const boxPadY = Math.round(mainSize * 0.26);
    const gap = Math.max(4, Math.round(mainSize * 0.16));
    const maxChars = Math.floor((width - pad * 2 - boxPadX * 2) / (mainSize * 0.56));
    const mainLines = wrapText(main, maxChars, 3);
    const lineBoxH = mainSize + boxPadY * 2;
    const estW = (text: string, size: number) => Math.min(width - pad * 2, Math.round(text.length * size * 0.56) + boxPadX * 2);
    let y = height - pad - mainLines.length * (lineBoxH + gap) + gap;
    if (kicker) {
      const kickerBoxH = kickerSize + boxPadY * 2;
      const ky = y - kickerBoxH - gap;
      const kLine = wrapText(kicker, Math.floor((width - pad * 2 - boxPadX * 2) / (kickerSize * 0.56)), 1)[0] ?? kicker;
      parts.push(`<rect x="${pad}" y="${ky}" width="${estW(kLine, kickerSize)}" height="${kickerBoxH}" fill="#101826" fill-opacity="0.93"/>`);
      parts.push(`<text x="${pad + boxPadX}" y="${ky + boxPadY + Math.round(kickerSize * 0.85)}" font-family="${font}" font-size="${kickerSize}" font-weight="bold" fill="#ffffff">${escapeXml(kLine)}</text>`);
    }
    for (const line of mainLines) {
      parts.push(`<rect x="${pad}" y="${y}" width="${estW(line, mainSize)}" height="${lineBoxH}" fill="#101826" fill-opacity="0.93"/>`);
      parts.push(`<text x="${pad + boxPadX}" y="${y + boxPadY + Math.round(mainSize * 0.85)}" font-family="${font}" font-size="${mainSize}" font-weight="bold" fill="#ffffff">${escapeXml(line)}</text>`);
      y += lineBoxH + gap;
    }
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
    const layers: Array<{ input: Buffer; top?: number; left?: number }> = [
      { input: Buffer.from(buildOverlaySvg(width, height, spec)), top: 0, left: 0 },
    ];
    // v1026 — Logo (SVG) in wählbarer Ecke: separat rasterisiert (~13 % der
    // Bildbreite); Fehler im Logo (kaputtes SVG) kosten NIE das Bild
    if (spec.logo?.svg && spec.logo.svg.length < 300_000) {
      try {
        const pad = Math.round(width * 0.035);
        const logoBuf = await sharp(Buffer.from(spec.logo.svg)).resize({ width: Math.round(width * 0.13), fit: 'inside' }).png().toBuffer();
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
