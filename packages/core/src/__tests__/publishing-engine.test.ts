import { describe, it, expect, vi } from 'vitest';
import { PublishingEngine } from '../publishing-engine.js';
import type { SocialRepository, SocialChannel, ContentItem, InsightsRepository } from '@alfred/storage';
import type { Platform } from '@alfred/types';

const OWNER = 'owner-1';
const NOW = new Date().toISOString();
const PAST = new Date(Date.now() - 60_000).toISOString();

function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn().mockReturnThis() } as any;
}

function makeChannel(overrides: Partial<SocialChannel> = {}): SocialChannel {
  return {
    id: 'ch-1', userId: OWNER, platform: 'test', name: 'Kanal', mode: 'approve',
    publishMode: 'api', planningHorizonDays: 14, postingSlots: [], blacklist: [],
    maxPostsPerDay: 3, approvedStreak: 0, status: 'active', config: {},
    createdAt: NOW, updatedAt: NOW, ...overrides,
  };
}

function makeItem(overrides: Partial<ContentItem> = {}): ContentItem {
  return {
    id: 'item-1', channelId: 'ch-1', userId: OWNER, status: 'scheduled',
    body: 'Post-Text', media: [], hashtags: [], source: 'studio',
    scheduledAt: PAST, createdAt: NOW, updatedAt: NOW, ...overrides,
  };
}

function makeEngine(opts: {
  channel: SocialChannel;
  approved?: ContentItem[]; scheduled?: ContentItem[]; failed?: ContentItem[]; publishing?: ContentItem[];
  publishOk?: boolean; publishError?: string;
  /** v983 — Leitplanken-Block ist dauerhaft (Duplikat/Blacklist/Termin vorbei) */
  publishPermanent?: boolean;
  insightInserted?: boolean;
}) {
  const repo = {
    listChannels: vi.fn(async () => [opts.channel]),
    listItems: vi.fn(async (_u: string, q: any) => {
      if (Array.isArray(q?.status)) return [];
      if (q?.status === 'approved') return opts.approved ?? [];
      if (q?.status === 'scheduled') return opts.scheduled ?? [];
      if (q?.status === 'failed') return opts.failed ?? [];
      if (q?.status === 'publishing') return opts.publishing ?? [];
      return [];
    }),
    mergePerformance: vi.fn(async () => {}),
    transition: vi.fn(async () => ({})),
  } as unknown as SocialRepository;

  const publishItem = vi.fn(async () => opts.publishOk === false
    ? { success: false, error: opts.publishError ?? 'kaputt', permanent: opts.publishPermanent === true }
    : { success: true, display: 'ok' });

  const insightsRepo = {
    upsertCandidate: vi.fn(async () => ({ inserted: opts.insightInserted !== false, id: 'i1' })),
  } as unknown as InsightsRepository;

  const router = { store: vi.fn(async () => 'stored'), route: vi.fn(async () => 'sent') } as any;
  const adapter = { sendMessage: vi.fn(async () => undefined) };
  const adapters = new Map([['telegram' as Platform, adapter as any]]);

  const engine = new PublishingEngine(repo, publishItem, insightsRepo, router, adapters, makeLogger(), {
    ownerUserId: OWNER, chatId: 'chat-1', platform: 'telegram' as Platform,
    retryAfterMs: 0,
    // v1075 — Bestands-Tests takten uhrzeitunabhängig; der menschliche Takt
    // (Jitter/Fenster/Abstand) wird über die pure-Funktionen separat getestet
    disableHumanPacing: true,
  });
  return { engine, repo, publishItem, insightsRepo, router, adapter };
}

describe('PublishingEngine (v934)', () => {
  it('fällige approved-Items werden veröffentlicht + still über den Router abgelegt', async () => {
    const { engine, publishItem, router } = makeEngine({
      channel: makeChannel(), approved: [makeItem({ status: 'approved' })],
    });
    const r = await engine.tick();
    expect(r.published).toBe(1);
    expect(publishItem).toHaveBeenCalledWith('item-1');
    expect(router.store).toHaveBeenCalledTimes(1);
    expect((router.store as any).mock.calls[0][0].source).toBe('social');
  });

  it('v1044: überaltertes approved-Item wird beim Fälligwerden zurückgezogen statt publiziert', async () => {
    const stale = makeItem({
      status: 'approved',
      createdAt: new Date(Date.now() - 60 * 3_600_000).toISOString(), // 60h alt, news = 48h Haltbarkeit
      performance: { art: 'news' },
    });
    const { engine, publishItem, repo } = makeEngine({ channel: makeChannel(), approved: [stale] });
    const r = await engine.tick();
    expect(r.published).toBe(0);
    expect(publishItem).not.toHaveBeenCalled();
    expect((repo.transition as any).mock.calls.some((c: any[]) => c[1] === 'item-1' && c[2] === 'rejected')).toBe(true);

    // frisches news-Item läuft normal durch
    const fresh = makeItem({ status: 'approved', performance: { art: 'news' } });
    const { engine: e2, publishItem: p2 } = makeEngine({ channel: makeChannel(), approved: [fresh] });
    expect((await e2.tick()).published).toBe(1);
    expect(p2).toHaveBeenCalled();
  });

  it('v987: stuck-in-publishing wird nach 15 min auf failed gerettet; frische bleiben unangetastet', async () => {
    const old = makeItem({ id: 'zombie', status: 'publishing', updatedAt: new Date(Date.now() - 20 * 60_000).toISOString() });
    const fresh = makeItem({ id: 'frisch', status: 'publishing', updatedAt: new Date().toISOString() });
    const { engine, repo } = makeEngine({ channel: makeChannel(), publishing: [old, fresh] });
    const r = await engine.tick();
    expect(r.rescued).toBe(1);
    const calls = (repo.transition as any).mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0][1]).toBe('zombie');
    expect(calls[0][2]).toBe('failed');
    expect(calls[0][3].error).toContain('Watchdog');
  });

  it('v983: permanenter Leitplanken-Block → Item auf failed, retried-Marker, EIN Insight — kein Endlos-Retry', async () => {
    // Realfall 04./05.07.: Doppel-Publish-Gate blockierte zwei approved-Items
    // 11 Stunden lang im 5-Minuten-Takt („Überfällig" ohne Erklärung).
    const { engine, repo, insightsRepo } = makeEngine({
      channel: makeChannel(), approved: [makeItem({ status: 'approved' })],
      publishOk: false, publishError: 'Sehr ähnlicher Beitrag … Bewusster Re-Post: force: true.', publishPermanent: true,
    });
    const r = await engine.tick();
    expect(r.published).toBe(0);
    expect((repo.transition as any).mock.calls.map((c: any[]) => c[2])).toEqual(['publishing', 'failed']);
    expect((repo.mergePerformance as any).mock.calls[0][2]).toMatchObject({ retried: true });
    const insight = (insightsRepo.upsertCandidate as any).mock.calls[0][1];
    expect(insight.dedupeKey).toBe('social-blocked:item-1');
    expect(insight.title).toContain('Publish blockiert');
  });

  it('v983: transienter Fehler lässt das Item approved (Retry beim nächsten Tick, kein failed)', async () => {
    const { engine, repo } = makeEngine({
      channel: makeChannel(), approved: [makeItem({ status: 'approved' })],
      publishOk: false, publishError: 'HTTP 503 — Plattform down',
    });
    await engine.tick();
    expect((repo.transition as any)).not.toHaveBeenCalled();
  });

  it('approve-Modus: fälliges scheduled-Item → EINE Freigabe (Insight + Buttons), kein Publish', async () => {
    const { engine, publishItem, insightsRepo, adapter } = makeEngine({
      channel: makeChannel({ mode: 'approve' }), scheduled: [makeItem()],
    });
    const r = await engine.tick();
    expect(r.asked).toBe(1);
    expect(publishItem).not.toHaveBeenCalled();
    const candidate = (insightsRepo.upsertCandidate as any).mock.calls[0][1];
    expect(candidate.category).toBe('social-approval');
    expect(candidate.actionParams).toEqual({ action: 'publish_now', item_id: 'item-1' });
    // v1044 — Dedupe je SLOT: nach Plan-Review-Umterminierung kommt die Anfrage erneut
    expect(candidate.dedupeKey).toBe(`social-approval:item-1:${PAST}`);
    const buttons = (adapter.sendMessage as any).mock.calls[0][2].replyMarkup.inlineKeyboard[0];
    expect(buttons.map((b: any) => b.callbackData)).toEqual([
      'content:item-1:approve', 'content:item-1:publish', 'content:item-1:reject',
    ]);
  });

  it('Freigabe wird NICHT wiederholt gesendet (Insight-Dedupe)', async () => {
    const { engine, adapter } = makeEngine({
      channel: makeChannel({ mode: 'approve' }), scheduled: [makeItem()],
      insightInserted: false, // Insight existiert schon
    });
    const r = await engine.tick();
    expect(r.asked).toBe(0);
    expect(adapter.sendMessage).not.toHaveBeenCalled();
  });

  it('autonomous mit Streak < 5 verhält sich wie approve (Erstpost-Sperre)', async () => {
    const { engine, publishItem } = makeEngine({
      channel: makeChannel({ mode: 'autonomous', approvedStreak: 3 }), scheduled: [makeItem()],
    });
    const r = await engine.tick();
    expect(r.asked).toBe(1);
    expect(publishItem).not.toHaveBeenCalled();
  });

  it('autonomous mit Streak ≥ 5 published automatisch + Router-Transparenz', async () => {
    const { engine, publishItem, router } = makeEngine({
      channel: makeChannel({ mode: 'autonomous', approvedStreak: 5 }), scheduled: [makeItem()],
    });
    const r = await engine.tick();
    expect(r.published).toBe(1);
    expect(publishItem).toHaveBeenCalledWith('item-1');
    expect((router.store as any).mock.calls[0][0].title).toContain('Autonom veröffentlicht');
  });

  it('autonomous: greift eine Leitplanke, geht das Item in die Freigabe-Queue', async () => {
    const { engine, insightsRepo } = makeEngine({
      channel: makeChannel({ mode: 'autonomous', approvedStreak: 5 }), scheduled: [makeItem()],
      publishOk: false, publishError: 'Kanal pausiert — erst reaktivieren.',
    });
    const r = await engine.tick();
    expect(r.published).toBe(0);
    expect(r.asked).toBe(1);
    const candidate = (insightsRepo.upsertCandidate as any).mock.calls[0][1];
    expect(candidate.body).toContain('pausiert');
  });

  it('v1077 autonomous: Tages-Limit → still auf morgen umterminiert statt Freigabe-Lärm', async () => {
    const { engine, insightsRepo, repo } = makeEngine({
      channel: makeChannel({ mode: 'autonomous', approvedStreak: 5 }), scheduled: [makeItem()],
      publishOk: false, publishError: 'Tages-Limit erreicht (3/3)',
    });
    (repo as any).reschedule = vi.fn(async () => true);
    const r = await engine.tick();
    expect(r.published).toBe(0);
    expect(r.asked).toBe(0); // keine Freigabe-Anfrage
    expect((repo as any).reschedule).toHaveBeenCalled();
    expect((insightsRepo.upsertCandidate as any)).not.toHaveBeenCalled();
  });

  it('suggest-Modus: kein aktives Nachfragen für scheduled-Items', async () => {
    const { engine, publishItem, insightsRepo } = makeEngine({
      channel: makeChannel({ mode: 'suggest' }), scheduled: [makeItem()],
    });
    const r = await engine.tick();
    expect(r.asked).toBe(0);
    expect(publishItem).not.toHaveBeenCalled();
    expect(insightsRepo.upsertCandidate).not.toHaveBeenCalled();
  });

  it('pausierter Kanal: nichts passiert', async () => {
    const { engine, publishItem } = makeEngine({
      channel: makeChannel({ status: 'paused', mode: 'autonomous', approvedStreak: 5 }),
      approved: [makeItem({ status: 'approved' })], scheduled: [makeItem({ id: 'item-2' })],
    });
    const r = await engine.tick();
    expect(r.published + r.asked).toBe(0);
    expect(publishItem).not.toHaveBeenCalled();
  });

  it('Retry: failed-Item genau EINMAL erneut versuchen; performance.retried gesetzt', async () => {
    const failedItem = makeItem({ status: 'failed', updatedAt: new Date(Date.now() - 20 * 60_000).toISOString() });
    const { engine, publishItem, repo } = makeEngine({
      channel: makeChannel(), failed: [failedItem],
    });
    const r = await engine.tick();
    expect(r.retried).toBe(1);
    expect(publishItem).toHaveBeenCalledWith('item-1');
    expect(repo.mergePerformance).toHaveBeenCalledWith(OWNER, 'item-1', expect.objectContaining({ retried: true }));
  });

  it('Retry: bereits retried-markierte Items werden nicht erneut versucht', async () => {
    const failedItem = makeItem({ status: 'failed', performance: { retried: true }, updatedAt: PAST });
    const { engine, publishItem } = makeEngine({ channel: makeChannel(), failed: [failedItem] });
    const r = await engine.tick();
    expect(r.retried).toBe(0);
    expect(publishItem).not.toHaveBeenCalled();
  });

  it('v1123: Rate-Limit-Fehler bekommt weitere Anläufe mit Backoff, gedeckelt bei 3', async () => {
    const rlError = 'instagram: Application request limit reached';
    // limitRetries 1, letzter Versuch vor 61 min → nächster Anlauf läuft
    const reif = makeItem({ status: 'failed', error: rlError, performance: { retried: true, limitRetries: 1 }, updatedAt: new Date(Date.now() - 61 * 60_000).toISOString() });
    const a = makeEngine({ channel: makeChannel(), failed: [reif] });
    expect((await a.engine.tick()).retried).toBe(1);
    expect(a.repo.mergePerformance).toHaveBeenCalledWith(OWNER, 'item-1', expect.objectContaining({ limitRetries: 2 }));
    // erst 30 min her → Backoff (60 min) noch nicht erreicht
    const zufrueh = makeItem({ status: 'failed', error: rlError, performance: { retried: true, limitRetries: 1 }, updatedAt: new Date(Date.now() - 30 * 60_000).toISOString() });
    const b = makeEngine({ channel: makeChannel(), failed: [zufrueh] });
    expect((await b.engine.tick()).retried).toBe(0);
    // 3 Anläufe verbraucht → Schluss
    const erschoepft = makeItem({ status: 'failed', error: rlError, performance: { retried: true, limitRetries: 3 }, updatedAt: PAST });
    const c = makeEngine({ channel: makeChannel(), failed: [erschoepft] });
    expect((await c.engine.tick()).retried).toBe(0);
    // NICHT-Rate-Limit-Fehler mit retried=true bleibt wie bisher liegen
    const normal = makeItem({ status: 'failed', error: 'irgendein anderer Fehler', performance: { retried: true }, updatedAt: PAST });
    const d = makeEngine({ channel: makeChannel(), failed: [normal] });
    expect((await d.engine.tick()).retried).toBe(0);
  });

  it('Retry schlägt erneut fehl → high-Insight „endgültig fehlgeschlagen"', async () => {
    const failedItem = makeItem({ status: 'failed', updatedAt: new Date(Date.now() - 20 * 60_000).toISOString() });
    const { engine, insightsRepo } = makeEngine({
      channel: makeChannel(), failed: [failedItem], publishOk: false,
    });
    await engine.tick();
    const candidate = (insightsRepo.upsertCandidate as any).mock.calls[0][1];
    expect(candidate.title).toContain('endgültig fehlgeschlagen');
    expect(candidate.sourceData.urgency).toBe('high');
  });

  it('v1140: Retry läuft in aktive Meta-Pause → kein „endgültig fehlgeschlagen"-Insight (Item ist umterminiert)', async () => {
    const failedItem = makeItem({ status: 'failed', error: 'instagram: Application request limit reached', updatedAt: new Date(Date.now() - 20 * 60_000).toISOString() });
    const { engine, insightsRepo } = makeEngine({
      channel: makeChannel(), failed: [failedItem],
      publishOk: false, publishError: 'Meta-Rate-Limit-Pause aktiv — Beitrag auf IG ist ans Pausen-Ende umterminiert (2026-07-31T12:00:00.000Z).',
    });
    const r = await engine.tick();
    expect(r.retried).toBe(1);
    expect(insightsRepo.upsertCandidate).not.toHaveBeenCalled();
  });

  it('v1140: autonomer Publish in Meta-Pause → keine Freigabe-Anfrage (bereits umterminiert)', async () => {
    const { engine, insightsRepo } = makeEngine({
      channel: makeChannel({ mode: 'autonomous', approvedStreak: 5 }), scheduled: [makeItem()],
      publishOk: false, publishError: 'Meta-Rate-Limit-Pause aktiv — Beitrag ist ans Pausen-Ende umterminiert.',
    });
    const r = await engine.tick();
    expect(r.asked).toBe(0);
    expect(insightsRepo.upsertCandidate).not.toHaveBeenCalled();
  });
});

describe('v1075 — menschlicher Takt (Jitter, Fenster)', () => {
  it('itemPublishJitterMs: deterministisch, begrenzt, streut', async () => {
    const { itemPublishJitterMs } = await import('../publishing-engine.js');
    const a = itemPublishJitterMs('item-aaaa-1111');
    expect(itemPublishJitterMs('item-aaaa-1111')).toBe(a); // deterministisch
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(10 * 60_000);
    const values = new Set(Array.from({ length: 30 }, (_, i) => itemPublishJitterMs(`item-${i}`)));
    expect(values.size).toBeGreaterThan(20); // echte Streuung, kein konstanter Versatz
  });

  it('publishWindowFor: Default 7-22, rest frei, Config-Override + false', async () => {
    const { publishWindowFor } = await import('../publishing-engine.js');
    expect(publishWindowFor({ platform: 'instagram', config: {} })).toEqual({ from: 7, to: 22 });
    expect(publishWindowFor({ platform: 'rest', config: {} })).toBeNull();
    expect(publishWindowFor({ platform: 'rest', config: { publish_window: [9, 18] } })).toEqual({ from: 9, to: 18 });
    expect(publishWindowFor({ platform: 'instagram', config: { publish_window: false } })).toBeNull();
  });

  it('isWithinWindow: Tagesfenster + Über-Mitternacht-Fenster', async () => {
    const { isWithinWindow } = await import('../publishing-engine.js');
    const at = (h: number) => new Date(2026, 6, 9, h, 30);
    expect(isWithinWindow({ from: 7, to: 22 }, at(12))).toBe(true);
    expect(isWithinWindow({ from: 7, to: 22 }, at(23))).toBe(false);
    expect(isWithinWindow({ from: 7, to: 22 }, at(0))).toBe(false); // das 00:06-Reel wäre aufgeschoben worden
    expect(isWithinWindow({ from: 22, to: 6 }, at(23))).toBe(true);
    expect(isWithinWindow({ from: 22, to: 6 }, at(12))).toBe(false);
    expect(isWithinWindow(null, at(3))).toBe(true);
  });
});

describe('v1077 — Wichtiges geht immer (Vorrang-Regeln)', () => {
  function pacingEngine(opts: { channel: SocialChannel; approved?: ContentItem[]; published?: ContentItem[] }) {
    // Engine MIT aktivem menschlichem Takt (anders als makeEngine)
    const items = [...(opts.approved ?? []), ...(opts.published ?? [])];
    const repo = {
      listChannels: vi.fn(async () => [opts.channel]),
      listItems: vi.fn(async (_u: string, q: any) => items.filter(i =>
        (q?.status === undefined || (Array.isArray(q.status) ? q.status.includes(i.status) : i.status === q.status))
        && (q?.channelId === undefined || i.channelId === q.channelId)
        && (q?.scheduledBefore === undefined || (i.scheduledAt ?? '') <= q.scheduledBefore))),
      transition: vi.fn(async (_u: string, id: string, to: any) => ({ ...items.find(i => i.id === id)!, status: to })),
      mergePerformance: vi.fn(async () => {}),
      reschedule: vi.fn(async () => true),
    } as unknown as SocialRepository;
    const publishItem = vi.fn(async () => ({ success: true }));
    const router = { store: vi.fn(async () => 'stored') } as any;
    const engine = new PublishingEngine(repo, publishItem, undefined, router, new Map(), makeLogger(), {
      ownerUserId: OWNER, chatId: 'c', platform: 'telegram' as Platform, retryAfterMs: 0,
    });
    return { engine, publishItem, repo, router };
  }

  it('Termin-Nähe-Schutz: knapper Termin überstimmt Fenster/Jitter (kein Verlust)', async () => {
    const channel = makeChannel({ config: { publish_window: [23, 23] } }); // Fenster praktisch zu
    const item = makeItem({ status: 'approved', scheduledAt: PAST, performance: { terminBis: new Date(Date.now() + 20 * 60_000).toISOString() } });
    const { engine, publishItem } = pacingEngine({ channel, approved: [item] });
    await engine.tick();
    expect(publishItem).toHaveBeenCalledWith(item.id);
  });

  it('Breaking überstimmt Fenster — aber max. 2 Nacht-Ausnahmen pro Tag', async () => {
    const channel = makeChannel({ config: { publish_window: [23, 23], publish_jitter: false } });
    const fresh = makeItem({ id: 'item-brk1-aaaa', status: 'approved', scheduledAt: PAST, performance: { breaking: true } });
    const { engine, publishItem } = pacingEngine({ channel, approved: [fresh] });
    await engine.tick();
    expect(publishItem).toHaveBeenCalledWith(fresh.id); // 0 Ausnahmen verbraucht → darf
    // Deckel: schon 2 außerhalb des Fensters publiziert → Breaking wartet
    const published = [1, 2].map(n => makeItem({ id: `item-out${n}-aaaa`, status: 'published', publishedAt: new Date().toISOString() }));
    const blocked = makeItem({ id: 'item-brk2-aaaa', status: 'approved', scheduledAt: PAST, performance: { breaking: true } });
    const second = pacingEngine({ channel, approved: [blocked], published });
    await second.engine.tick();
    expect(second.publishItem).not.toHaveBeenCalled();
  });

  it('Tages-Limit → automatisch auf morgen früh umterminiert statt failed', async () => {
    const channel = makeChannel({ config: { publish_jitter: false, min_publish_gap_minutes: 0, publish_window: false } });
    const item = makeItem({ status: 'approved', scheduledAt: PAST });
    const { engine, publishItem, repo, router } = pacingEngine({ channel, approved: [item] });
    (publishItem as any).mockResolvedValue({ success: false, error: 'Tages-Limit erreicht (5/5 auf Testkanal) — max_posts_per_day anpassen oder morgen posten.' });
    await engine.tick();
    expect((repo.reschedule as any)).toHaveBeenCalled();
    const at = (repo.reschedule as any).mock.calls[0][2] as string;
    expect(Date.parse(at)).toBeGreaterThan(Date.now()); // morgen im Fenster
    expect((router.store as any)).toHaveBeenCalled(); // stille Notiz statt Freigabe-Lärm
  });
});
