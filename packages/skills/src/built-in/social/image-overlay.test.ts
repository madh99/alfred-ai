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
