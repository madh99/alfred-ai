import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotificationRouter, type RoutedNotification } from '../notification-router.js';
import type { InsightsRepository } from '@alfred/storage';
import type { MessagingAdapter } from '@alfred/messaging';
import type { Platform } from '@alfred/types';

const OWNER = 'owner-uuid-1234';

function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn().mockReturnThis() } as any;
}

function makeRepo() {
  return { upsertCandidate: vi.fn().mockResolvedValue({ id: 'i1' }) } as unknown as InsightsRepository;
}

function makeAdapter() {
  return { sendMessage: vi.fn().mockResolvedValue(undefined) } as unknown as MessagingAdapter;
}

function notif(overrides: Partial<RoutedNotification> = {}): RoutedNotification {
  return {
    source: 'reasoning',
    urgency: 'low',
    title: 'Testmeldung',
    body: 'Inhalt der Meldung',
    chatId: 'chat-1',
    platform: 'telegram' as Platform,
    ...overrides,
  };
}

describe('NotificationRouter.shouldSend', () => {
  it('sendet ab Default-Schwelle high, darunter nicht', () => {
    const router = new NotificationRouter(makeRepo(), new Map(), {}, makeLogger(), OWNER);
    expect(router.shouldSend('reasoning', 'urgent')).toBe(true);
    expect(router.shouldSend('reasoning', 'high')).toBe(true);
    expect(router.shouldSend('reasoning', 'normal')).toBe(false);
    expect(router.shouldSend('reasoning', 'low')).toBe(false);
  });

  it('respektiert konfigurierte minUrgency', () => {
    const router = new NotificationRouter(makeRepo(), new Map(), { minUrgency: 'normal' }, makeLogger(), OWNER);
    expect(router.shouldSend('reasoning', 'normal')).toBe(true);
    expect(router.shouldSend('reasoning', 'low')).toBe(false);
  });

  it('perSource-Override gewinnt über minUrgency', () => {
    const router = new NotificationRouter(
      makeRepo(), new Map(),
      { minUrgency: 'normal', perSource: { reasoning: 'urgent' } },
      makeLogger(), OWNER,
    );
    expect(router.shouldSend('reasoning', 'high')).toBe(false);
    expect(router.shouldSend('reasoning', 'urgent')).toBe(true);
    // andere Quelle fällt auf minUrgency zurück
    expect(router.shouldSend('automation', 'normal')).toBe(true);
  });

  it('devMode sendet alles (Verhalten wie vor v927)', () => {
    const router = new NotificationRouter(makeRepo(), new Map(), { devMode: true, minUrgency: 'urgent' }, makeLogger(), OWNER);
    expect(router.shouldSend('reasoning', 'low')).toBe(true);
  });

  it('ohne Insights-Ablage wird immer gesendet (nichts verschlucken)', () => {
    const router = new NotificationRouter(undefined, new Map(), {}, makeLogger(), OWNER);
    expect(router.shouldSend('reasoning', 'low')).toBe(true);
  });
});

describe('NotificationRouter.store', () => {
  let repo: InsightsRepository;
  let router: NotificationRouter;

  beforeEach(() => {
    repo = makeRepo();
    router = new NotificationRouter(repo, new Map(), {}, makeLogger(), OWNER);
  });

  it('legt unter ownerUserId mit category=source und router-Marker ab', async () => {
    const result = await router.store(notif({ urgency: 'normal' }));
    expect(result).toBe('stored');
    const [uid, candidate] = (repo.upsertCandidate as any).mock.calls[0];
    expect(uid).toBe(OWNER);
    expect(candidate.category).toBe('reasoning');
    expect(candidate.title).toBe('Testmeldung');
    expect(candidate.sourceData.router).toBe(true);
    expect(candidate.sourceData.urgency).toBe('normal');
  });

  it('hängt reasons als Einstufungs-Suffix an den Body', async () => {
    await router.store(notif({ reasons: ['kein Zeitdruck', 'nur informativ'] }));
    const [, candidate] = (repo.upsertCandidate as any).mock.calls[0];
    expect(candidate.body).toContain('Inhalt der Meldung');
    expect(candidate.body).toContain('Einstufung (low): kein Zeitdruck · nur informativ');
  });

  it('ohne reasons bleibt der Body unverändert', async () => {
    await router.store(notif());
    const [, candidate] = (repo.upsertCandidate as any).mock.calls[0];
    expect(candidate.body).toBe('Inhalt der Meldung');
  });

  it('übernimmt actionSkill/actionParams/dedupeKey in den Kandidaten', async () => {
    await router.store(notif({
      actionSkill: 'todo',
      actionParams: { action: 'create', title: 'X' },
      dedupeKey: 'dk-1',
    }));
    const [, candidate] = (repo.upsertCandidate as any).mock.calls[0];
    expect(candidate.actionSkill).toBe('todo');
    expect(candidate.actionParams).toEqual({ action: 'create', title: 'X' });
    expect(candidate.dedupeKey).toBe('dk-1');
  });

  it('kürzt überlange Titel auf 200 Zeichen', async () => {
    await router.store(notif({ title: 'x'.repeat(500) }));
    const [, candidate] = (repo.upsertCandidate as any).mock.calls[0];
    expect(candidate.title.length).toBe(200);
  });

  it('dropped ohne Repo und bei Repo-Fehler (kein Throw)', async () => {
    const noRepo = new NotificationRouter(undefined, new Map(), {}, makeLogger(), OWNER);
    expect(await noRepo.store(notif())).toBe('dropped');

    (repo.upsertCandidate as any).mockRejectedValueOnce(new Error('db down'));
    expect(await router.store(notif())).toBe('dropped');
  });
});

describe('NotificationRouter.route', () => {
  it('sendet über den Adapter, wenn Dringlichkeit die Schwelle erreicht', async () => {
    const repo = makeRepo();
    const adapter = makeAdapter();
    const adapters = new Map<Platform, MessagingAdapter>([['telegram' as Platform, adapter]]);
    const router = new NotificationRouter(repo, adapters, {}, makeLogger(), OWNER);

    const result = await router.route(notif({ urgency: 'urgent' }));
    expect(result).toBe('sent');
    expect((adapter.sendMessage as any).mock.calls[0]).toEqual(['chat-1', 'Inhalt der Meldung']);
    expect(repo.upsertCandidate).not.toHaveBeenCalled();
  });

  it('legt still ab, wenn unter der Schwelle', async () => {
    const repo = makeRepo();
    const adapter = makeAdapter();
    const adapters = new Map<Platform, MessagingAdapter>([['telegram' as Platform, adapter]]);
    const router = new NotificationRouter(repo, adapters, {}, makeLogger(), OWNER);

    const result = await router.route(notif({ urgency: 'low' }));
    expect(result).toBe('stored');
    expect(adapter.sendMessage).not.toHaveBeenCalled();
    expect(repo.upsertCandidate).toHaveBeenCalledTimes(1);
  });

  it('fehlender Adapter → Ablage statt Verlust', async () => {
    const repo = makeRepo();
    const router = new NotificationRouter(repo, new Map(), {}, makeLogger(), OWNER);
    const result = await router.route(notif({ urgency: 'urgent' }));
    expect(result).toBe('stored');
    expect(repo.upsertCandidate).toHaveBeenCalledTimes(1);
  });
});
