import { describe, it, expect, vi } from 'vitest';
import { MemoryRetriever, altersFaktor, ALTERS_BODEN } from '../active-learning/memory-retriever.js';

/**
 * v1496 — Realfall 18.10.: Die Jahresübersicht der Stromrechnungen (82 Tage alt, Ähnlichkeit 0,81) kam mit dem
 * Faktor 0,15 auf 0,084 und fiel unter die Mindestgrenze 0,1. Eine 103 Tage alte Erinnerung kam dagegen auf 0,50,
 * weil die Stichwortsuche sie auch fand und der semantische Anteil dann ohne Abzug zählte.
 */
const TAG = 864e5;
const logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return logger; } } as never;
const vor = (tage: number) => new Date(Date.now() - tage * TAG).toISOString();

describe('v1496 Altersfaktor mit Boden', () => {
  it('frisch 1, nach 30 Tagen 0,65, nie unter 0,3', () => {
    const jetzt = Date.now();
    expect(altersFaktor(new Date(jetzt).toISOString(), jetzt)).toBeCloseTo(1, 5);
    expect(altersFaktor(new Date(jetzt - 30 * TAG).toISOString(), jetzt)).toBeCloseTo(0.65, 5);
    expect(altersFaktor(new Date(jetzt - 82 * TAG).toISOString(), jetzt)).toBeCloseTo(0.3 + 0.7 * Math.pow(0.5, 82 / 30), 5);
    expect(altersFaktor(new Date(jetzt - 3650 * TAG).toISOString(), jetzt)).toBeGreaterThanOrEqual(ALTERS_BODEN);
  });

  it('ohne Datum kein Abzug', () => {
    expect(altersFaktor(undefined)).toBe(1);
    expect(altersFaktor('kein Datum')).toBe(1);
  });

  it('Realfall: die 82 Tage alte Jahresübersicht bleibt über der Mindestgrenze', async () => {
    const memoryRepo = {
      keywordSearch: vi.fn().mockResolvedValue([]),
      getByIds: vi.fn().mockResolvedValue([{ id: 's', key: 'awattar_invoice_summary_2026', value: 'Tabelle', category: 'general', type: 'general', confidence: 1, updatedAt: vor(82) }]),
      recordAccess: vi.fn(),
    };
    const embeddingService = { semanticSearchByType: vi.fn().mockResolvedValue([{ sourceId: 's', content: 'x', score: 0.81 }]) };
    const [m] = await new MemoryRetriever(memoryRepo as never, logger, embeddingService as never).retrieve('owner', 'strom heuer');
    expect(m.score).toBeGreaterThan(0.1);
    expect(m.score).toBeCloseTo(0.81 * 0.7 * altersFaktor(vor(82)), 3);
  });

  it('Stichwort- und Bedeutungstreffer derselben Erinnerung: beide Anteile mit demselben Abzug', async () => {
    const alt = { id: 'a', key: 'hausbatterie_kritisch', value: 'v', category: 'general', type: 'feedback', confidence: 1, updatedAt: vor(103) };
    const memoryRepo = { keywordSearch: vi.fn().mockResolvedValue([alt]), getByIds: vi.fn().mockResolvedValue([alt]), recordAccess: vi.fn() };
    const embeddingService = { semanticSearchByType: vi.fn().mockResolvedValue([{ sourceId: 'a', content: 'x', score: 0.8 }]) };
    const [m] = await new MemoryRetriever(memoryRepo as never, logger, embeddingService as never).retrieve('owner', 'hausbatterie');
    // Stichwort Rang 1 von 1 → 1,0 · 0,3; Bedeutung 0,8 · 0,7 — beide × Altersfaktor
    expect(m.score).toBeCloseTo((0.3 + 0.8 * 0.7) * altersFaktor(vor(103)), 3);
  });
});
