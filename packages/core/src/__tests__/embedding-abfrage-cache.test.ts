import { describe, it, expect, vi } from 'vitest';
import { EmbeddingService } from '../embedding-service.js';

// v1210 — Realfall 06.10.: je Chat-Nachricht wurde derselbe Text bis zu 14× eingebettet
// (Memory- und Regel-Suche × 7 verknüpfte Benutzer-IDs). Gleicher Text → ein Netzaufruf.
function service() {
  const embed = vi.fn(async (text: string) => ({ embedding: [text.length, 1, 0], model: 'test' }));
  const llm = { supportsEmbeddings: () => true, embed } as never;
  const repo = {
    vectorSearch: vi.fn(async () => [{ sourceType: 'memory', sourceId: 'm1', content: 'k: v', distance: 0.1 }]),
    findByUser: vi.fn(async () => []),
  } as never;
  const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as never;
  return { svc: new EmbeddingService(llm, repo, log), embed };
}

describe('EmbeddingService Abfrage-Cache (v1210)', () => {
  it('gleicher Text in 7 Suchen → ein embed-Aufruf; anderer Text → neuer Aufruf', async () => {
    const { svc, embed } = service();
    for (let i = 0; i < 7; i++) await svc.semanticSearch('uid-' + i, 'Wie steht es um das Auto?', 10);
    expect(embed).toHaveBeenCalledTimes(1);
    await svc.semanticSearchByType('uid-0', 'Wie steht es um das Auto?', 'memory', 5);
    expect(embed).toHaveBeenCalledTimes(1);
    await svc.semanticSearch('uid-0', 'Was kostet Strom heute?', 10);
    expect(embed).toHaveBeenCalledTimes(2);
    expect(svc.abfrageCacheStatistik()).toEqual({ treffer: 7, fehltreffer: 2 });
  });

  it('nach Ablauf der 60 s wird neu eingebettet', async () => {
    const { svc, embed } = service();
    const echt = Date.now;
    let t = 1_000_000;
    Date.now = () => t;
    try {
      await svc.semanticSearch('u', 'hallo', 10);
      t += 59_000;
      await svc.semanticSearch('u', 'hallo', 10);
      expect(embed).toHaveBeenCalledTimes(1);
      t += 2_000;
      await svc.semanticSearch('u', 'hallo', 10);
      expect(embed).toHaveBeenCalledTimes(2);
    } finally { Date.now = echt; }
  });
});
