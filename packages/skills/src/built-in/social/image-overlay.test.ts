import { describe, it, expect } from 'vitest';
import { applyImageOverlays, buildOverlaySvg, cropToRatio, escapeXml, resolveImageBranding, wrapText, loadSharp } from './image-overlay.js';
import type { SocialChannel } from '@alfred/storage';

function makeChannel(overrides: Partial<SocialChannel> = {}): SocialChannel {
  return {
    id: 'ch-1', userId: 'u1', platform: 'telegram_channel', name: 'FussballCC News',
    mode: 'approve', publishMode: 'api', planningHorizonDays: 14, postingSlots: [],
    blacklist: [], maxPostsPerDay: 3, approvedStreak: 0, status: 'active', config: {},
    createdAt: 'x', updatedAt: 'x', ...overrides,
  };
}

async function makeTestPng(width = 400, height = 400): Promise<Buffer> {
  const sharp = await loadSharp();
  if (!sharp) throw new Error('sharp fehlt im Test-Setup');
  return (sharp as any)({ create: { width, height, channels: 3, background: { r: 30, g: 90, b: 40 } } }).png().toBuffer();
}

describe('image-overlay (v1002)', () => {
  it('wrapText: Wort-Umbruch + Ellipse bei Überlauf', () => {
    expect(wrapText('Portugal gegen Spanien im Achtelfinale', 20, 2)).toEqual(['Portugal gegen', 'Spanien im…']);
    expect(wrapText('Kurz', 20, 2)).toEqual(['Kurz']);
  });

  it('v1026: Titel als gestapelte Boxen unten links, Vorzeile vor „:" wird Kicker', () => {
    const svg = buildOverlaySvg(1000, 1000, { title: 'Berichte über Anruf: US-Stürmer darf wieder spielen' });
    expect(svg).toContain('Berichte über Anruf:');
    expect(svg).toContain('US-Stürmer darf wieder');
    expect((svg.match(/<rect/g) ?? []).length).toBeGreaterThanOrEqual(2); // Kicker-Box + Titel-Box(en)
    expect(svg).not.toContain('linearGradient id="bg"'); // alter Vollbreiten-Verlaufsbalken ist Geschichte
    // ohne Doppelpunkt: kein Kicker, nur Titel-Boxen
    const plain = buildOverlaySvg(1000, 1000, { title: 'England zittert sich ins Viertelfinale' });
    expect(plain).toContain('England zittert sich ins');
  });

  it('v1054: Emojis/Flaggen werden aus eingebrannten Texten gestrippt (kein Unicode-Hex-Tofu)', () => {
    // Realfall 08.07. (IG): Titel „70 Jahre Wartezeit vorbei ⏳ 🇨🇭" → die
    // SVG-Schrift kennt keine Emojis, der Renderer brannte „23F3 1F1E8 1F1ED"
    const svg = buildOverlaySvg(1000, 1000, { title: '70 Jahre Wartezeit vorbei ⏳ 🇨🇭', branding: 'fussball.cc ⚽' });
    expect(svg).toContain('70 Jahre Wartezeit vorbei');
    expect(svg).not.toContain('⏳');
    expect(svg).not.toContain('🇨🇭');
    expect(svg).not.toContain('⚽');
    // KEINE Leer-Box für die weggefallene Emoji-Zeile: nur die eine Titel-Zeile
    expect((svg.match(/<text/g) ?? []).length).toBe(2); // Titel + Branding
    // reiner Emoji-Titel → gar keine Titel-Box
    const empty = buildOverlaySvg(1000, 1000, { title: '⏳🇨🇭' });
    expect(empty).not.toContain('<text');
  });

  it('v1033: Termin-Karte im Box-Stil — Boxen, textLength gegen Überlauf, kein Verlaufsbalken, bottom-verankert', () => {
    const svg = buildOverlaySvg(1536, 1024, {
      termin: { headline: 'Viertelfinale live erleben: Schweiz gegen Kolumbien im Pub', anpfiff: 'Di., 07.07. · 22:00 Uhr', ort: 'Dublin Irish Pub, Wien' },
    });
    expect(svg).toContain('Anpfiff Di., 07.07.');
    expect(svg).toContain('Dublin Irish Pub, Wien');
    expect((svg.match(/<rect/g) ?? []).length).toBeGreaterThanOrEqual(4); // 2 Headline- + 2 Info-Boxen
    expect(svg).toContain('lengthAdjust="spacingAndGlyphs"'); // Text wird in die Box gezwungen
    expect(svg).not.toContain('linearGradient'); // alter Verlauf ist weg
    // bottom-verankert: keine Box ragt unter die Bildkante
    const ys = [...svg.matchAll(/<rect x="\d+" y="(\d+)" width="\d+" height="(\d+)"/g)].map(m => Number(m[1]) + Number(m[2]));
    expect(Math.max(...ys)).toBeLessThanOrEqual(1024);
  });

  it('v1026: Wasserzeichen-Ecke wählbar', () => {
    const tl = buildOverlaySvg(1000, 800, { branding: 'fussball.cc', brandingCorner: 'top-left' });
    expect(tl).toContain('text-anchor="start"');
    const br = buildOverlaySvg(1000, 800, { branding: 'fussball.cc' });
    expect(br).toContain('text-anchor="end"'); // Default unten rechts
  });

  it('v1032: recolorSvg färbt fill-Werte um, none/transparent bleiben, Default-Schwarz bekommt Root-fill', async () => {
    const { recolorSvg } = await import('./image-overlay.js');
    // Attribut-Notation (Realfall: User-Logo mit fill="#000000")
    expect(recolorSvg('<svg><path fill="#000000" d="M0 0"/></svg>', '#ffffff')).toContain('fill="#ffffff"');
    // Löcher/Aussparungen bleiben
    const holes = recolorSvg('<svg><path fill="none" d="M0 0"/><path fill="#123456" d="M1 1"/></svg>', '#00ff00');
    expect(holes).toContain('fill="none"');
    expect(holes).toContain('fill="#00ff00"');
    // style-Notation
    expect(recolorSvg('<svg><path style="fill:#333;stroke:none" d="M0 0"/></svg>', '#abcdef')).toContain('fill:#abcdef');
    // gar kein fill → Root-Element bekommt eins
    expect(recolorSvg('<svg viewBox="0 0 10 10"><path d="M0 0"/></svg>', '#ff0000')).toContain('<svg fill="#ff0000"');
    // ungültige Farbe → unverändert
    const orig = '<svg><path fill="#000" d="M0 0"/></svg>';
    expect(recolorSvg(orig, 'rot')).toBe(orig);
  });

  it('v1026: Logo-SVG wird komposittiert — Bildmaße bleiben, Bild ändert sich', async () => {
    const sharp = await loadSharp();
    if (!sharp) return; // ohne sharp (seltene Dev-Umgebung) nichts zu prüfen
    const png: Buffer = await (sharp as any)({ create: { width: 600, height: 400, channels: 3, background: { r: 10, g: 60, b: 30 } } }).png().toBuffer();
    const logo = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40"><rect width="100" height="40" fill="#ff0000"/></svg>';
    const out = await applyImageOverlays(png, { logo: { svg: logo, corner: 'top-left' } });
    expect(Buffer.compare(out, png)).not.toBe(0);
    const meta = await (sharp as any)(out).metadata();
    expect(meta.width).toBe(600);
    expect(meta.height).toBe(400);
    // kaputtes Logo kostet NIE das Bild
    const broken = await applyImageOverlays(png, { logo: { svg: '<svg><kaputt', corner: 'top-left' } });
    expect(broken.length).toBeGreaterThan(0);
  });

  it('v1022: Einzelwort über Zeilenbreite wird hart getrennt statt überzulaufen', () => {
    const lines = wrapText('Donaudampfschifffahrtsgesellschaft', 10, 5);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(10);
    expect(lines.join('').replace(/-/g, '')).toBe('Donaudampfschifffahrtsgesellschaft');
  });

  it('escapeXml: SVG-gefährliche Zeichen', () => {
    expect(escapeXml('Bayern & Co: <3 "quotes"')).toBe('Bayern &amp; Co: &lt;3 &quot;quotes&quot;');
  });

  it('resolveImageBranding: config → Lead-Domain → Kanalname', () => {
    const web = makeChannel({ id: 'w', platform: 'rest', name: 'fussball.cc Website', projectId: 'p1', config: { base_url: 'https://www.fussball.cc' } });
    const tg = makeChannel({ id: 't', projectId: 'p1' });
    // Lead-Domain (www. weg, Protokoll weg)
    expect(resolveImageBranding(tg, [web, tg])).toBe('fussball.cc');
    // explizite Config gewinnt
    expect(resolveImageBranding(makeChannel({ projectId: 'p1', config: { image_branding: '@fussballcc' } }), [web])).toBe('@fussballcc');
    // false = aus
    expect(resolveImageBranding(makeChannel({ config: { image_branding: false } }), [])).toBeUndefined();
    // Solo ohne Familie: Kanalname
    expect(resolveImageBranding(makeChannel({}), [])).toBe('FussballCC News');
  });

  it('v1018: interne Lead-URLs (IP/localhost) sind KEIN Branding → Fallback Kanalname', () => {
    const internal = makeChannel({ id: 'w', platform: 'rest', name: 'fussball.cc Website', projectId: 'p1', config: { base_url: 'https://192.168.1.96:3003' } });
    const tg = makeChannel({ id: 't', name: 'FussballCC News', projectId: 'p1' });
    expect(resolveImageBranding(tg, [internal, tg])).toBe('FussballCC News');
    const local = makeChannel({ id: 'w2', platform: 'rest', projectId: 'p2', config: { base_url: 'http://localhost:3001' } });
    expect(resolveImageBranding(makeChannel({ id: 'x', name: 'X', projectId: 'p2' }), [local])).toBe('X');
  });

  it('v1018: prepareBlueskyImage — klein bleibt PNG, groß wird JPEG unter 1,9 MB', async () => {
    const { prepareBlueskyImage } = await import('./bluesky-provider.js');
    const small = Buffer.alloc(100_000, 1);
    expect(await prepareBlueskyImage(small)).toEqual({ bytes: small, mime: 'image/png' });
    // echtes großes Bild: 2500x2500 Rauschen → PNG > 1,9 MB → verkleinert als JPEG
    const sharp = await loadSharp();
    const noise = Buffer.alloc(2500 * 2500 * 3);
    let seed = 42;
    for (let i = 0; i < noise.length; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0; // LCG — echtes Pseudo-Rauschen, PNG kann das nicht komprimieren
      noise[i] = seed >>> 24;
    }
    const bigPng: Buffer = await (sharp as any)(noise, { raw: { width: 2500, height: 2500, channels: 3 } }).png().toBuffer();
    expect(bigPng.length).toBeGreaterThan(1_900_000);
    const prepared = await prepareBlueskyImage(bigPng);
    expect(prepared).not.toBeNull();
    expect(prepared!.mime).toBe('image/jpeg');
    expect(prepared!.bytes.length).toBeLessThanOrEqual(1_900_000);
    const meta = await (sharp as any)(prepared!.bytes).metadata();
    expect(Math.max(meta.width, meta.height)).toBeLessThanOrEqual(1600);
  });

  it('buildOverlaySvg: Branding + Titel + Termin-Karte landen als Text im SVG', () => {
    const svg = buildOverlaySvg(1024, 1024, {
      branding: 'fussball.cc', title: 'Marokko marschiert weiter',
      termin: { headline: 'Portugal – Spanien', anpfiff: '06.07. · 21:00 Uhr', einlass: '19:30 Uhr', ort: 'Dublin Irish Pub, Wien' },
    });
    expect(svg).toContain('fussball.cc');
    expect(svg).toContain('Portugal – Spanien');
    expect(svg).toContain('Anpfiff 06.07. · 21:00 Uhr');
    expect(svg).toContain('Einlass 19:30 Uhr');
    expect(svg).toContain('Dublin Irish Pub, Wien');
    // Termin-Karte ersetzt den Titelbalken
    expect(svg).not.toContain('Marokko marschiert weiter');
  });

  it('applyImageOverlays: Compositing verändert das Bild, Maße bleiben; leere Spec = Original', async () => {
    const base = await makeTestPng(400, 400);
    const out = await applyImageOverlays(base, { branding: 'fussball.cc', title: 'Derby-Sieg im Achtelfinale' });
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out.equals(base)).toBe(false);
    const sharp = await loadSharp();
    const meta = await (sharp as any)(out).metadata();
    expect(meta.width).toBe(400);
    expect(meta.height).toBe(400);
    // leere Spec → Original unangetastet
    expect(await applyImageOverlays(base, {})).toBe(base);
  });

  it('cropToRatio: 1024x1536 → 4:5 zentriert (1024x1280); passendes Verhältnis bleibt', async () => {
    const tall = await makeTestPng(512, 768);
    const cropped = await cropToRatio(tall, 4, 5);
    const sharp = await loadSharp();
    const meta = await (sharp as any)(cropped).metadata();
    expect(meta.width).toBe(512);
    expect(meta.height).toBe(640);
    const square = await makeTestPng(200, 200);
    expect(await cropToRatio(square, 1, 1)).toBe(square);
  });

  it('kaputter Buffer → Original zurück (Pipeline bricht nie)', async () => {
    const junk = Buffer.from('kein bild');
    expect(await applyImageOverlays(junk, { branding: 'x' })).toBe(junk);
  });
});
