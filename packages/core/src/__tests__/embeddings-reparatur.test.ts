import { describe, it, expect, vi } from 'vitest';
import { EmbeddingService } from '../embedding-service.js';
import { MemoryRetriever } from '../active-learning/memory-retriever.js';

/**
 * v1495 — Realfall 18.10.: alle Embeddings waren Nullvektoren, pgvector-Treffer bekamen die Ähnlichkeit 1,0, und
 * verwaiste Treffer belegten als „general" ohne Altersabzug alle Plätze — die Stromrechnungen erreichten den Prompt nie.
 */
const logger = { debug() {}, info() {}, warn: vi.fn(), error() {}, child() { return logger; } } as never;

function llm(embedding: number[] | undefined) {
  return {
    supportsEmbeddings: () => true,
    embed: vi.fn().mockResolvedValue(embedding ? { embedding, model: 'mistral-embed', dimensions: embedding.length } : undefined),
  } as never;
}

function repo() {
  return {
    store: vi.fn().mockResolvedValue({ id: 'e1' }),
    loescheAndereDimension: vi.fn().mockResolvedValue(4360),
    loescheNullvektoren: vi.fn().mockResolvedValue(0),
    loescheVerwaisteMemoryEmbeddings: vi.fn().mockResolvedValue(0),
    vektorSpalteAnpassen: vi.fn().mockResolvedValue(true),
    vectorSearch: vi.fn(),
  };
}

describe('v1495 Embeddings', () => {
  it('Nullvektor wird nicht gespeichert', async () => {
    const r = repo();
    const s = new EmbeddingService(llm([0, 0, 0, 0]), r as never, logger);
    expect(await s.embedAndStore('u', 'text', 'memory', 'm1')).toBeUndefined();
    expect(r.store).not.toHaveBeenCalled();
  });

  it('gültiger Vektor wird gespeichert', async () => {
    const r = repo();
    const s = new EmbeddingService(llm([0.6, 0.8]), r as never, logger);
    expect(await s.embedAndStore('u', 'text', 'memory', 'm1')).toBe('e1');
  });

  it('Reparatur: Probe liefert die Dimension, danach wird gelöscht und die Spalte angepasst', async () => {
    const r = repo();
    const s = new EmbeddingService(llm(Array.from({ length: 1024 }, () => 0.03)), r as never, logger);
    expect(await s.defekteEntfernen()).toEqual({ dimension: 1024, andereDimension: 4360, nullvektoren: 0, verwaist: 0, spalteNeu: true });
    expect(r.loescheAndereDimension).toHaveBeenCalledWith(1024);
    expect(r.vektorSpalteAnpassen).toHaveBeenCalledWith(1024);
  });

  it('Reparatur ohne gültige Probe löscht nichts', async () => {
    for (const probe of [undefined, [0, 0, 0]]) {
      const r = repo();
      const s = new EmbeddingService(llm(probe), r as never, logger);
      expect(await s.defekteEntfernen()).toBeUndefined();
      expect(r.loescheAndereDimension).not.toHaveBeenCalled();
      expect(r.loescheNullvektoren).not.toHaveBeenCalled();
    }
  });

  it('Ähnlichkeit kommt aus dem pgvector-Abstand (vorher immer 1,0)', async () => {
    const r = repo();
    r.vectorSearch.mockResolvedValue([
      { sourceType: 'memory', sourceId: 'm1', content: 'a: b', distance: 0.19 },
      { sourceType: 'memory', sourceId: 'm2', content: 'c: d', distance: 0.42 },
    ]);
    const s = new EmbeddingService(llm([0.6, 0.8]), r as never, logger);
    const t = await s.semanticSearchByType('u', 'frage', 'memory', 5, 0);
    expect(t.map(x => Number(x.score.toFixed(2)))).toEqual([0.81, 0.58]);
  });
});

describe('v1495 MemoryRetriever semantisch', () => {
  const jetzt = new Date().toISOString();
  const mem = (id: string, key: string, type = 'general') =>
    ({ id, key, value: `Wert ${key}`, category: 'general', type, confidence: 1, updatedAt: jetzt });

  it('nur Memory-Embeddings, aufgelöst über die ID; verwaiste und interne fallen weg', async () => {
    const memoryRepo = {
      keywordSearch: vi.fn().mockResolvedValue([]),
      getByIds: vi.fn().mockResolvedValue([mem('m1', 'awattar_invoice_summary_2026'), mem('m3', 'connection_x')]),
      recordAccess: vi.fn(),
    };
    const embeddingService = {
      semanticSearchByType: vi.fn().mockResolvedValue([
        { sourceId: 'weg', content: 'gamescom_plan: alt', score: 0.9 },
        { sourceId: 'm1', content: 'veralteter Text', score: 0.81 },
        { sourceId: 'm3', content: 'connection_x: y', score: 0.8 },
      ]),
    };
    const r = new MemoryRetriever(memoryRepo as never, logger, embeddingService as never);
    const ergebnis = await r.retrieve('owner', 'strom heuer', 15);
    expect(embeddingService.semanticSearchByType).toHaveBeenCalledWith('owner', 'strom heuer', 'memory', 30, 0);
    expect(ergebnis.map(e => e.key)).toEqual(['awattar_invoice_summary_2026']);
    expect(ergebnis[0].value).toBe('Wert awattar_invoice_summary_2026'); // aktueller Inhalt, nicht der Embedding-Text
    expect(ergebnis[0].score).toBeCloseTo(0.81 * 0.7, 3);
  });
});
