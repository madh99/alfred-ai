import { describe, it, expect, vi } from 'vitest';
import { ContentStudio, hatPromoBoilerplate } from '../content-studio.js';
import type { SocialRepository } from '@alfred/storage';

/**
 * v1103 — Realfall 12.07.2026 (Argentinien–Schweiz, Nachtspiel in US-Zeit):
 * Der News-Desk baute aus einem ServusTV-YouTube-Short (kein Transkript,
 * „Summary" = Sender-Promo „… LIVE bei ServusTV On … #Shorts") eine Story —
 * die Kanäle schrieben VORSCHAUEN auf ein längst entschiedenes Spiel.
 * Fixes: Promo-Boilerplate-Erkennung, Shorts raus aus dem Eilmeldungs-Stoff,
 * Spielplan-Extraktion (Anstoßzeiten → Vorschau MIT terminBis),
 * Nachmittags-Lauf nur-Termine.
 */

const OWNER = 'owner-1';

function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn().mockReturnThis() } as never;
}

describe('v1103 — Promo-Boilerplate-Erkennung', () => {
  it('erkennt Sender-Promo, lässt echte Fakten-Summaries durch', () => {
    expect(hatPromoBoilerplate('FIFA Fußball-Weltmeisterschaft 2026™ Viertelfinale: Argentinien vs. Schweiz | LIVE bei ServusTV On 🇦🇹 #ServusFussball #WM2026 #Shorts')).toBe(true);
    expect(hatPromoBoilerplate('Alle Spiele LIVE bei ServusTV')).toBe(true);
    expect(hatPromoBoilerplate('Jetzt abonnieren und nichts verpassen!')).toBe(true);
    expect(hatPromoBoilerplate('Argentinien schlägt die Schweiz 3:1 nach Verlängerung; Álvarez traf doppelt, Embolo sah Gelb-Rot in der 71. Minute.')).toBe(false);
    expect(hatPromoBoilerplate(undefined)).toBe(false);
  });
});

describe('v1103 — Spielplan-Extraktion aus dem Dossier', () => {
  function studioWithLlm(llmContent: string) {
    const llm = { complete: vi.fn(async () => ({ content: llmContent })) };
    const studio = new ContentStudio({} as never, undefined as never, undefined, llm as never,
      undefined, undefined, undefined, makeLogger(), OWNER);
    return { studio, llm };
  }
  const call = (studio: ContentStudio, dossier: string) =>
    (studio as never as { extractSpielplan(d: string): Promise<Array<{ spiel: string; at: string }>> }).extractSpielplan(dossier);

  it('übernimmt nur künftige, plausible Anstoßzeiten; Vergangenes/Kaputtes fällt raus', async () => {
    const inThreeDays = new Date(Date.now() + 3 * 24 * 3_600_000).toISOString();
    const yesterday = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const inTwoMonths = new Date(Date.now() + 60 * 24 * 3_600_000).toISOString();
    const { studio } = studioWithLlm(JSON.stringify([
      { spiel: 'England – Argentinien (WM-Halbfinale)', at: inThreeDays },
      { spiel: 'Gestern gespielt', at: yesterday },
      { spiel: 'Zu weit weg', at: inTwoMonths },
      { spiel: 'Kaputt', at: 'kein-datum' },
      { at: inThreeDays }, // ohne Spielname
    ]));
    const spiele = await call(studio, 'DOSSIER: England – Argentinien, Halbfinale am 15.07. um 21:00 Uhr (ET 15:00)');
    expect(spiele).toHaveLength(1);
    expect(spiele[0].spiel).toContain('England – Argentinien');
    expect(Date.parse(spiele[0].at)).toBeGreaterThan(Date.now());
  });

  it('leeres/uhrzeitloses Dossier bzw. LLM-Fehler → leere Liste, kein Throw', async () => {
    const { studio, llm } = studioWithLlm('[]');
    expect(await call(studio, '')).toEqual([]);
    expect(await call(studio, 'Transfergerücht ohne jede Anstoßzeit')).toEqual([]);
    expect(llm.complete).not.toHaveBeenCalled(); // ohne Uhrzeit-Muster → kein LLM-Call
    const kaputt = new ContentStudio({} as never, undefined as never, undefined,
      { complete: vi.fn(async () => { throw new Error('down'); }) } as never,
      undefined, undefined, undefined, makeLogger(), OWNER);
    expect(await call(kaputt, 'Anstoß um 21:00 Uhr')).toEqual([]);
  });
});

describe('v1103 — Nachmittags-Lauf nur-Termine', () => {
  it('runTerminGaps: nur Familien ≥2 Kanäle; planFamily bekommt nurTermine', async () => {
    const fam = (id: string) => ({
      id, userId: OWNER, platform: 'test', name: id, mode: 'approve', publishMode: 'api',
      planningHorizonDays: 14, postingSlots: [], blacklist: [], maxPostsPerDay: 10,
      approvedStreak: 0, status: 'active', config: { family: 'cc' }, createdAt: NOW_ISO, updatedAt: NOW_ISO,
    });
    const solo = { ...fam('solo'), config: {} };
    const socialRepo = { listChannels: vi.fn(async () => [fam('a'), fam('b'), solo]) } as unknown as SocialRepository;
    const studio = new ContentStudio(socialRepo, undefined as never, undefined, { complete: vi.fn() } as never,
      undefined, undefined, undefined, makeLogger(), OWNER);
    const spy = vi.spyOn(studio as never as { planFamily(f: string, c: unknown[], o?: unknown): Promise<number> }, 'planFamily')
      .mockResolvedValue(3);
    const created = await studio.runTerminGaps();
    expect(created).toBe(3);
    expect(spy).toHaveBeenCalledTimes(1); // Solo-Kanal bekommt KEINEN Termin-Lücken-Lauf
    expect(spy.mock.calls[0][2]).toEqual({ nurTermine: true });
  });
});

const NOW_ISO = new Date().toISOString();
