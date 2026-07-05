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
    expect(candidate.dedupeKey).toBe('social-approval:item-1');
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
      publishOk: false, publishError: 'Tages-Limit erreicht (3/3)',
    });
    const r = await engine.tick();
    expect(r.published).toBe(0);
    expect(r.asked).toBe(1);
    const candidate = (insightsRepo.upsertCandidate as any).mock.calls[0][1];
    expect(candidate.body).toContain('Tages-Limit');
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
});
