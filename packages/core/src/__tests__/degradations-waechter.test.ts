import { describe, it, expect, vi } from 'vitest';
import { ProviderPuls, type TierPuls } from '../lebenszeichen/provider-puls.js';
import { bewertePuls, bewerteProben, DegradationsWaechter, formatiereMeldungen, nachzuprobendeTiers } from '../lebenszeichen/degradations-waechter.js';
import { fuehreProbenAus, erwarteteFristMs } from '../lebenszeichen/proben.js';

// Jarvis Schicht 0 — Realfälle: Anthropic seit 18.08. und OpenAI seit 19.08.
// ohne Guthaben → 12 Owner-Alerts/Tag (v868, 6-h-Dedupe je Tier); KG-Wartung
// 12.–28.09. tot, von niemandem bemerkt.

const log = () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn() }) as never;
const T = (h: number, m = 0, tag = 5) => new Date(2026, 9, tag, h, m, 0);

describe('ProviderPuls', () => {
  it('hält Erfolg/Fehler je Tier fest; gestoertSeit = erster Fehler nach letztem Erfolg', () => {
    let now = T(10);
    const puls = new ProviderPuls(log(), undefined, () => now);
    puls.verarbeite({ art: 'erfolg', tier: 'default', provider: 'openai', model: 'gpt' });
    now = T(10, 5);
    puls.verarbeite({ art: 'fehler', tier: 'default', provider: 'openai', model: 'gpt', klasse: 'billing', fehler: 'insufficient_quota' });
    now = T(10, 20);
    const p = puls.verarbeite({ art: 'fehler', tier: 'default', provider: 'openai', model: 'gpt', klasse: 'billing', fehler: 'insufficient_quota' });
    expect(ProviderPuls.istGestoert(p)).toBe(true);
    expect(p.gestoertSeit).toBe(T(10, 5).toISOString());
    expect(p.fehler).toBe(2);
    now = T(11);
    const ok = puls.verarbeite({ art: 'erfolg', tier: 'default', provider: 'openai', model: 'gpt' });
    expect(ProviderPuls.istGestoert(ok)).toBe(false);
    expect(ok.gestoertSeit).toBeUndefined();
  });
});

describe('ProviderPuls.lade (nach Migrationen, mit Ereignissen vor dem Laden)', () => {
  it('verschmilzt Historie und Start-Ereignisse: gestoertSeit bleibt der alte Vorfall, Zähler addieren', async () => {
    const alt: TierPuls = {
      tier: 'fast', provider: 'anthropic', model: 'haiku', erfolge: 10, fehler: 400, updatedAt: T(0).toISOString(),
      letzterErfolg: new Date(2026, 7, 18, 9).toISOString(), letzterFehler: T(0, 50).toISOString(),
      fehlerKlasse: 'billing', gestoertSeit: new Date(2026, 7, 18, 9, 5).toISOString(),
    };
    let now = T(1, 4);
    const puls = new ProviderPuls(log(), { ladeAlle: async () => [alt], speichere: async () => undefined }, () => now);
    puls.verarbeite({ art: 'fehler', tier: 'fast', provider: 'anthropic', model: 'haiku', klasse: 'billing', fehler: 'credit' });
    puls.verarbeite({ art: 'erfolg', tier: 'fallback', provider: 'mistral', model: 'large' });
    await puls.lade();
    const fast = puls.zustand('fast')!;
    expect(fast.fehler).toBe(401);
    expect(fast.erfolge).toBe(10);
    expect(fast.gestoertSeit).toBe(alt.gestoertSeit);
    expect(fast.letzterFehler).toBe(T(1, 4).toISOString());
    expect(puls.zustand('fallback')!.erfolge).toBe(1);
    // Erfolg seit Start → Historie heilt nicht rückwärts
    now = T(1, 10);
    const geheilt = new ProviderPuls(log(), { ladeAlle: async () => [alt], speichere: async () => undefined }, () => now);
    geheilt.verarbeite({ art: 'erfolg', tier: 'fast', provider: 'anthropic', model: 'haiku' });
    await geheilt.lade();
    expect(ProviderPuls.istGestoert(geheilt.zustand('fast')!)).toBe(false);
    expect(geheilt.zustand('fast')!.gestoertSeit).toBeUndefined();
  });
});

describe('bewertePuls', () => {
  const gestoert = (tier: string, klasse: TierPuls['fehlerKlasse'], seitMin: number, now: Date): TierPuls => ({
    tier, provider: 'anthropic', model: 'claude', erfolge: 1, fehler: 5, updatedAt: now.toISOString(),
    letzterErfolg: new Date(now.getTime() - (seitMin + 1) * 60_000).toISOString(),
    letzterFehler: now.toISOString(), fehlerKlasse: klasse,
    gestoertSeit: new Date(now.getTime() - seitMin * 60_000).toISOString(),
  });

  it('Kern-Tier > 60 min gestört → ein Befund; < 60 min → keiner', () => {
    const now = T(12);
    expect(bewertePuls([gestoert('default', 'netz', 61, now)], now)).toHaveLength(1);
    expect(bewertePuls([gestoert('default', 'netz', 59, now)], now)).toHaveLength(0);
  });

  it('v1301: nennt Klasse in Worten und den Anbieter-Text, gekürzt', () => {
    const now = T(12);
    const p = { ...gestoert('default', 'anfrage', 70, now), fehlerText: "400 Invalid 'max_output_tokens': integer below minimum value. Expected a value >= 16, but got 5 instead." };
    const text = bewertePuls([p], now)[0].text;
    expect(text).toContain('nicht erreichbar (unsere Anfrage ist ungültig — Fehler auf unserer Seite: „400 Invalid');
    expect(bewertePuls([{ ...p, fehlerText: 'x'.repeat(150) }], now)[0].text).toContain('x'.repeat(110) + '…"');
    expect(bewertePuls([gestoert('default', 'unbekannt', 70, now)], now)[0].text).toContain('(Grund unbekannt)');
    expect(bewertePuls([gestoert('strong', 'netz', 70, now)], now)[0].text).toContain('(Netzwerk)');
  });

  it('Billing wird für JEDEN Tier gemeldet, Netz-Fehler nur für default/strong', () => {
    const now = T(12);
    expect(bewertePuls([gestoert('fast', 'billing', 90, now)], now)[0].text).toMatch(/ohne anthropic-Guthaben \(Tier fast/);
    expect(bewertePuls([gestoert('fast', 'netz', 90, now)], now)).toHaveLength(0);
  });
});

describe('nachzuprobendeTiers (v1270)', () => {
  const now = new Date('2026-10-07T12:00:00Z');
  const puls = (tier: string, o: Partial<TierPuls>): TierPuls => ({ tier, provider: 'x', model: 'm', erfolge: 0, fehler: 0, updatedAt: now.toISOString(), ...o });
  it('nennt gestörte Tiers (Fehler nach letztem Erfolg oder noch kein Erfolg), nie embeddings, keine gesunden', () => {
    const t = [
      puls('strong', { letzterErfolg: '2026-10-07T08:00:00Z', letzterFehler: '2026-10-07T11:00:00Z', fehlerKlasse: 'billing' }),
      puls('default', { letzterErfolg: '2026-10-07T11:30:00Z', letzterFehler: '2026-10-07T11:00:00Z' }),
      puls('fast', { letzterFehler: '2026-10-07T11:00:00Z' }),
      puls('embeddings', { letzterFehler: '2026-10-07T11:00:00Z' }),
      puls('medium', {}),
    ];
    expect(nachzuprobendeTiers(t)).toEqual(['strong', 'fast']);
  });
});

describe('DegradationsWaechter', () => {
  it('Realfall Guthaben: genau EIN Satz, danach still bis zum Morgen-Lauf des nächsten Tages, Entwarnung einmalig', async () => {
    let now = T(9);
    const w = new DegradationsWaechter({ logger: log(), now: () => now });
    const befund = [{ key: 'tier:default', text: 'Seit 18.08. ohne anthropic-Guthaben' }];

    // 10-min-Läufe: erster meldet, die weiteren schweigen
    expect(await w.abgleich(befund, { wiederholen: false })).toHaveLength(1);
    for (let i = 1; i <= 12; i++) { now = T(9, i * 10 > 59 ? 59 : i * 10); expect(await w.abgleich(befund, { wiederholen: false })).toHaveLength(0); }

    // Morgen-Lauf am selben Tag: heute schon gemeldet → still
    now = T(6, 50, 5);
    expect(await w.abgleich(befund, { wiederholen: true })).toHaveLength(0);
    // Morgen-Lauf am nächsten Tag: genau eine Wiederholung
    now = T(6, 50, 6);
    const m = await w.abgleich(befund, { wiederholen: true });
    expect(m).toHaveLength(1);
    expect(m[0].text).toMatch(/seit 05\.10\./);

    // Erfolg → einmalige Entwarnung, danach nichts mehr
    now = T(7, 0, 6);
    const e = await w.abgleich([], { wiederholen: false });
    expect(e).toEqual([{ key: 'tier:default', art: 'entwarnung', text: expect.stringMatching(/Tier default wieder in Ordnung/) }]);
    expect(await w.abgleich([], { wiederholen: false })).toHaveLength(0);
  });

  it('10-min-Lauf (nur Puls) entwarnt keine Job-Befunde aus dem Morgen-Lauf', async () => {
    const w = new DegradationsWaechter({ logger: log(), now: () => T(6, 50) });
    await w.abgleich([{ key: 'job:kg-maintenance', text: 'Job kg-maintenance: letzter Lauf vor 16 Tage' }], { wiederholen: true });
    const m = await w.abgleich([], { wiederholen: false, nurBereiche: ['tier'] });
    expect(m).toHaveLength(0);
    expect(w.offeneZustaende().map(z => z.key)).toEqual(['job:kg-maintenance']);
  });

  it('Persistenz: offener Zustand überlebt einen Neustart (kein Doppel-Satz)', async () => {
    const store = new Map<string, { key: string; offenSeit: string; zuletztGemeldet?: string; text?: string }>();
    const persistenz = {
      ladeMeldungen: async () => [...store.values()],
      speichereMeldung: async (m: { key: string; offenSeit: string; zuletztGemeldet?: string; text?: string }) => { store.set(m.key, m); },
      loescheMeldung: async (k: string) => { store.delete(k); },
    };
    const w1 = new DegradationsWaechter({ logger: log(), persistenz, now: () => T(9) });
    expect(await w1.abgleich([{ key: 'tier:strong', text: 'x' }])).toHaveLength(1);
    const w2 = new DegradationsWaechter({ logger: log(), persistenz, now: () => T(9, 30) });
    await w2.lade();
    expect(await w2.abgleich([{ key: 'tier:strong', text: 'x' }])).toHaveLength(0);
  });

  it('formatiereMeldungen: eine Zeile Warnung, eine Zeile Entwarnung', () => {
    expect(formatiereMeldungen([])).toBeUndefined();
    const t = formatiereMeldungen([
      { key: 'a', art: 'warnung', text: 'A kaputt' }, { key: 'b', art: 'warnung', text: 'B kaputt' }, { key: 'c', art: 'entwarnung', text: 'C ok' },
    ]);
    expect(t).toBe('⚠️ A kaputt · B kaputt\n✅ C ok');
  });
});

describe('Proben', () => {
  it('Realfall 12.–28.09.: täglicher Job ohne Lauf seit 16 Tagen → Probe schlägt an; frischer Lauf → ok', async () => {
    const now = T(6, 50);
    const laeufe: Record<string, { startedAt: string; ok?: boolean }> = {
      'kg-maintenance': { startedAt: new Date(now.getTime() - 16 * 86_400_000).toISOString(), ok: true },
      consolidation: { startedAt: new Date(now.getTime() - 4 * 3600_000).toISOString(), ok: true },
      'pattern-analysis': { startedAt: new Date(now.getTime() - 3 * 3600_000).toISOString(), ok: false },
    };
    const ergebnisse = await fuehreProbenAus({
      jobs: () => [
        { key: 'kg-maintenance', beschreibung: '', takt: { art: 'taeglich', um: '04:30' } },
        { key: 'consolidation', beschreibung: '', takt: { art: 'taeglich', um: '03:00' } },
        { key: 'pattern-analysis', beschreibung: '', takt: { art: 'taeglich', um: '03:30' } },
        { key: 'lebenszeichen-proben', beschreibung: '', takt: { art: 'taeglich', um: '06:50' } },
        { key: 'neu', beschreibung: '', takt: { art: 'woechentlich', tag: 0, um: '19:15' } },
      ],
      registerGestartetAm: new Date(now.getTime() - 3600_000).toISOString(),
      letzterLauf: async (k) => laeufe[k],
      ausgenommen: ['lebenszeichen-proben'],
      now: () => now,
    });
    const byName = Object.fromEntries(ergebnisse.map(e => [e.name, e]));
    expect(byName['kg-maintenance'].ok).toBe(false);
    expect(byName['kg-maintenance'].detail).toMatch(/16 Tage/);
    expect(byName['consolidation'].ok).toBe(true);
    expect(byName['pattern-analysis'].ok).toBe(false);
    expect(byName['pattern-analysis'].detail).toMatch(/fehlgeschlagen/);
    expect(byName['neu'].ok).toBe(true); // noch kein Lauf fällig (Register erst seit 1 h)
    expect(byName['lebenszeichen-proben']).toBeUndefined();
    const befunde = bewerteProben(ergebnisse);
    expect(befunde.map(b => b.key).sort()).toEqual(['job:kg-maintenance', 'job:pattern-analysis']);
  });

  it('Tier-Proben melden Fehlerklasse; Daten-Frische nach Tabelle', async () => {
    const now = T(6, 50);
    const ergebnisse = await fuehreProbenAus({
      tiers: {
        konfigurierteTiers: () => ['default', 'fallback', 'embeddings'],
        probeTier: async (tier) => tier === 'default'
          ? { ok: false, provider: 'anthropic', model: 'claude', klasse: 'billing', fehler: 'credit balance is too low', dauerMs: 300 }
          : { ok: true, provider: 'mistral', model: 'mistral-large-latest', dauerMs: 800 },
      },
      embed: async () => [0.1],
      jobs: () => [],
      letzterLauf: async () => undefined,
      juengsteZeit: async (t) => t === 'activity_log' ? new Date(now.getTime() - 30 * 3600_000).toISOString() : now.toISOString(),
      now: () => now,
    });
    const byName = Object.fromEntries(ergebnisse.map(e => [e.name, e]));
    expect(byName['default']).toMatchObject({ art: 'tier', ok: false, klasse: 'billing' });
    expect(byName['fallback'].ok).toBe(true);
    expect(byName['embeddings'].ok).toBe(true);
    expect(byName['activity_log'].ok).toBe(false);
    expect(byName['llm_usage'].ok).toBe(true);
    // Tier-Befunde laufen über den Puls, nicht über die Proben
    expect(bewerteProben(ergebnisse).map(b => b.key)).toEqual(['daten:activity_log']);
  });

  it('erwarteteFristMs: ein Takt plus Reserve', () => {
    expect(erwarteteFristMs({ art: 'taeglich', um: '03:00' })).toBe(26 * 3600_000);
    expect(erwarteteFristMs({ art: 'woechentlich', tag: 0, um: '19:15' })).toBe(8 * 86_400_000);
    expect(erwarteteFristMs({ art: 'intervall', minuten: 10 })).toBe(30 * 60_000);
    expect(erwarteteFristMs({ art: 'intervall', minuten: 60 })).toBe(120 * 60_000);
  });
});
