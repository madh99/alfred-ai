import { describe, it, expect, vi } from 'vitest';
import { PublishingEngine } from '../publishing-engine.js';
import { ContentStudio } from '../content-studio.js';
import { decodeGoogleNewsUrl, extractArticleText } from '../article-fetch.js';
import type { SocialRepository, SocialChannel, ContentItem } from '@alfred/storage';
import type { Platform } from '@alfred/types';

/**
 * v1100 — „Wichtiges stirbt nicht am Limit" (Realfall 11.07.2026):
 * Der IG-Vorbericht auf Norwegen–England (Anpfiff 23:00) lief um 20:39 ins
 * Tages-Limit (15/15) und wurde stumpf auf den NÄCHSTEN MORGEN verschoben —
 * nach dem Match. Gleichzeitig plante das Studio munter 22:31-/23:53-Slots
 * auf dem längst vollen Kanal, und der Adams-Artikel entstand aus einer
 * nackten GoogleNews-Schlagzeile („kurz vor dem Start der WM 2026" mitten
 * im Halbfinale).
 */

const OWNER = 'owner-1';
const NOW = new Date().toISOString();
const PAST = new Date(Date.now() - 60_000).toISOString();

function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn().mockReturnThis() } as never;
}

function makeChannel(overrides: Partial<SocialChannel> = {}): SocialChannel {
  return {
    id: 'ch-1', userId: OWNER, platform: 'test', name: 'Kanal', mode: 'approve',
    publishMode: 'api', planningHorizonDays: 14, postingSlots: [], blacklist: [],
    maxPostsPerDay: 3, approvedStreak: 0, status: 'active', config: {},
    createdAt: NOW, updatedAt: NOW, ...overrides,
  } as SocialChannel;
}

function makeItem(overrides: Partial<ContentItem> = {}): ContentItem {
  return {
    id: 'item-1', channelId: 'ch-1', userId: OWNER, status: 'approved',
    body: 'Post-Text', media: [], hashtags: [], source: 'studio',
    scheduledAt: PAST, createdAt: NOW, updatedAt: NOW, ...overrides,
  } as ContentItem;
}

function makeEngine(opts: {
  channel: SocialChannel;
  approved?: ContentItem[];
  extraPlanned?: ContentItem[]; // für Status-Array-Abfragen (Verdrängung)
  publishResults: Array<{ success: boolean; error?: string }>;
}) {
  const publishItem = vi.fn();
  for (const r of opts.publishResults) publishItem.mockResolvedValueOnce(r);
  publishItem.mockResolvedValue(opts.publishResults[opts.publishResults.length - 1]);
  const repo = {
    listChannels: vi.fn(async () => [opts.channel]),
    listItems: vi.fn(async (_u: string, q: { status?: string | string[] }) => {
      if (Array.isArray(q?.status)) return opts.extraPlanned ?? [];
      if (q?.status === 'approved') return opts.approved ?? [];
      return [];
    }),
    mergePerformance: vi.fn(async () => { /* */ }),
    transition: vi.fn(async () => ({})),
    reschedule: vi.fn(async () => true),
  } as unknown as SocialRepository;
  const router = { store: vi.fn(async () => 'stored') } as never;
  const engine = new PublishingEngine(repo, publishItem, undefined, router, new Map(), makeLogger(), {
    ownerUserId: OWNER, chatId: 'c', platform: 'telegram' as Platform, retryAfterMs: 0, disableHumanPacing: true,
  });
  return { engine, publishItem, repo, router };
}

describe('v1100 — Limit-Override für Wichtiges', () => {
  it('Eilmeldung am Tages-Limit: Engine versucht den Override und published', async () => {
    const item = makeItem({ performance: { breaking: true } });
    const { engine, publishItem, repo } = makeEngine({
      channel: makeChannel(), approved: [item],
      publishResults: [
        { success: false, error: 'Tages-Limit erreicht (3/3 auf Kanal) — max_posts_per_day anpassen oder morgen posten.' },
        { success: true },
      ],
    });
    const r = await engine.tick();
    expect(r.published).toBe(1);
    expect(publishItem).toHaveBeenNthCalledWith(1, 'item-1');
    expect(publishItem).toHaveBeenNthCalledWith(2, 'item-1', { limitOverride: true });
    expect((repo.reschedule as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('normales Item am Tages-Limit: KEIN Override, weiterhin sanft auf morgen', async () => {
    const item = makeItem();
    const { engine, publishItem, repo } = makeEngine({
      channel: makeChannel(), approved: [item],
      publishResults: [{ success: false, error: 'Tages-Limit erreicht (3/3)' }],
    });
    await engine.tick();
    expect(publishItem).toHaveBeenCalledTimes(1); // kein Override-Versuch
    expect((repo.reschedule as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });

  it('Termin vor dem nächsten Fenster + Override ausgeschöpft → zurückgezogen statt nach dem Event gepostet', async () => {
    // Anpfiff in 2 Stunden — das Aufschub-Ziel (morgen früh) läge danach
    const item = makeItem({ performance: { terminBis: new Date(Date.now() + 2 * 3_600_000).toISOString() } });
    const { engine, publishItem, repo, router } = makeEngine({
      channel: makeChannel(), approved: [item],
      publishResults: [{ success: false, error: 'Tages-Limit erreicht (5/5)' }], // auch der Override scheitert
    });
    await engine.tick();
    expect(publishItem).toHaveBeenNthCalledWith(2, 'item-1', { limitOverride: true }); // Override wurde versucht
    expect((repo.reschedule as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled(); // NICHT nach dem Match verschoben
    const transitions = (repo.transition as ReturnType<typeof vi.fn>).mock.calls;
    expect(transitions.some(c => c[1] === 'item-1' && c[2] === 'rejected')).toBe(true);
    const stored = (router as { store: ReturnType<typeof vi.fn> }).store.mock.calls.map(c => c[0]);
    expect(stored.some(s => s.urgency === 'high' && /Termin-Post/.test(s.title))).toBe(true);
  });

  it('Verschieben verdrängt Füller: ist morgen voll verplant, weicht das späteste Evergreen-Item', async () => {
    const breaking = makeItem({ performance: { breaking: true } });
    const tomorrow = (h: number) => {
      const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(h, 0, 0, 0);
      return d.toISOString();
    };
    const filler1 = makeItem({ id: 'filler-1', status: 'scheduled', scheduledAt: tomorrow(9), performance: { art: 'evergreen' } });
    const filler2 = makeItem({ id: 'filler-2', status: 'scheduled', scheduledAt: tomorrow(15), performance: { art: 'evergreen' } });
    const news = makeItem({ id: 'news-1', status: 'approved', scheduledAt: tomorrow(11), performance: { art: 'news' } });
    const { engine, repo } = makeEngine({
      channel: makeChannel({ maxPostsPerDay: 3 }), approved: [breaking],
      extraPlanned: [filler1, filler2, news], // morgen bereits 3/3 verplant
      publishResults: [{ success: false, error: 'Tages-Limit erreicht (3/3)' }], // Override scheitert auch → defer
    });
    await engine.tick();
    const calls = (repo.reschedule as ReturnType<typeof vi.fn>).mock.calls;
    // 1) das SPÄTESTE Evergreen (filler-2) rutscht +1 Tag, 2) das Breaking-Item auf morgen früh
    expect(calls.some(c => c[1] === 'filler-2')).toBe(true);
    expect(calls.some(c => c[1] === 'item-1')).toBe(true);
    expect(calls.some(c => c[1] === 'news-1')).toBe(false); // News wird NIE verdrängt
  });
});

describe('v1100 — Studio: budget-bewusste Slots + Fenster-Termin-Slots', () => {
  function makeStudio(publishedToday: number) {
    const socialRepo = {
      countPublishedToday: vi.fn(async () => publishedToday),
      listStories: vi.fn(async () => []),
    } as unknown as SocialRepository;
    // Konstruktor-Signatur wie content-studio.test.ts (Repos/LLM gemockt)
    return new ContentStudio(socialRepo, undefined as never, undefined, { complete: vi.fn() } as never,
      undefined, undefined, undefined, makeLogger(), OWNER);
  }

  it('heutige Slots werden aufs Rest-Tagesbudget gekappt — morgen bleibt unangetastet', async () => {
    const studio = makeStudio(2); // 2 von 3 heute schon veröffentlicht
    const channel = makeChannel({ maxPostsPerDay: 3 });
    const dayEnd = new Date(); dayEnd.setHours(24, 0, 0, 0);
    const t1 = new Date(Math.min(Date.now() + 60_000, dayEnd.getTime() - 120_000)).toISOString();
    const t2 = new Date(Math.min(Date.now() + 120_000, dayEnd.getTime() - 60_000)).toISOString();
    const morgen = new Date(Date.now() + 26 * 3_600_000).toISOString();
    const planned = [makeItem({ status: 'scheduled', scheduledAt: t1 })]; // 1 weiterer heute geplant → Budget 0
    const kept = await (studio as never as { trimSlotsToDailyBudget(c: SocialChannel, s: string[], p: ContentItem[]): Promise<string[]> })
      .trimSlotsToDailyBudget(channel, [t2, morgen], planned);
    expect(kept).toEqual([morgen]);
    // Mit freiem Budget bleibt alles stehen
    const studio2 = makeStudio(0);
    const kept2 = await (studio2 as never as { trimSlotsToDailyBudget(c: SocialChannel, s: string[], p: ContentItem[]): Promise<string[]> })
      .trimSlotsToDailyBudget(channel, [t2, morgen], []);
    expect(kept2).toEqual([t2, morgen]);
  });

  it('Termin-Ad-hoc-Slot: Nachtruhe-Slot wandert auf den Fensterbeginn, wenn der Termin danach liegt', () => {
    const studio = makeStudio(0);
    const h = new Date().getHours();
    const from = (h + 2) % 24; // Fenster beginnt sicher NACH jetzt+30min
    // lead 48h → der Ad-hoc-Slot landet deterministisch bei jetzt+30min (Nachtruhe)
    const channel = makeChannel({ config: { publish_window: [from, (from + 1) % 24], termin_lead_hours: 48 } });
    const pick = (terminBis: string) => (studio as never as {
      pickTerminSlot(pool: string[], t: string, c: SocialChannel, taken?: Set<string>): string | undefined;
    }).pickTerminSlot([], terminBis, channel);
    // Termin in 30h: der Slot MUSS auf einen Fensterbeginn rutschen
    const spaet = pick(new Date(Date.now() + 30 * 3_600_000).toISOString());
    expect(spaet).toBeDefined();
    expect(new Date(spaet!).getHours()).toBe(from);
    // Nacht-Termin in 60 min: Slot bleibt VOR dem Termin (kein Verlust)
    const nacht = pick(new Date(Date.now() + 60 * 60_000).toISOString());
    expect(nacht).toBeDefined();
    expect(Date.parse(nacht!)).toBeLessThan(Date.now() + 60 * 60_000);
  });
});

describe('v1100 — Artikel-Volltext (GoogleNews headline-only)', () => {
  it('decodeGoogleNewsUrl: Publisher-URL steckt base64url-kodiert in der Artikel-Kennung', () => {
    const inner = Buffer.from('"Zhttps://www.beispiel-zeitung.at/fussball/adams-nachruf-987 rest', 'latin1').toString('base64url');
    const url = `https://news.google.com/rss/articles/${inner}?oc=5&hl=de-AT`;
    expect(decodeGoogleNewsUrl(url)).toBe('https://www.beispiel-zeitung.at/fussball/adams-nachruf-987');
    expect(decodeGoogleNewsUrl('https://www.kicker.de/artikel')).toBeUndefined(); // kein GoogleNews-Link
  });

  it('extractArticleText: nimmt Substanz-Absätze, überspringt Boilerplate, dekodiert Entities', () => {
    const langerAbsatz1 = 'Der südafrikanische Nationalspieler wurde nach Vereinsangaben am Freitag leblos aufgefunden &amp; alle Spiele des Klubs wurden abgesagt.';
    const langerAbsatz2 = 'Der Verband bestätigte den Tod des 24-Jährigen und sprach der Familie sein tiefes Mitgefühl aus, während Mitspieler Anteilnahme zeigten.';
    const html = `<html><head><style>p{color:red}</style><script>var a=1;</script></head><body>
      <p>Cookies akzeptieren</p>
      <p>${langerAbsatz1}</p>
      <nav><p>Menü</p></nav>
      <p><strong>${langerAbsatz2}</strong></p>
    </body></html>`;
    const text = extractArticleText(html);
    expect(text).toBeDefined();
    expect(text).toContain('leblos aufgefunden & alle Spiele');
    expect(text).toContain('tiefes Mitgefühl');
    expect(text).not.toContain('Cookies');
    // zu wenig Substanz → undefined (dann greift das Substanz-Gate im Prompt)
    expect(extractArticleText('<p>kurz</p>')).toBeUndefined();
  });
});
