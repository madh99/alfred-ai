import { describe, it, expect, vi } from 'vitest';
import { DocumentProcessor } from '../document-processor.js';

const logger = { info() {}, warn() {}, error() {}, debug() {} } as never;

describe('v1475 DocumentProcessor', () => {
  it('gleichzeitige Indexierung derselben Datei legt nur ein Dokument an', async () => {
    let n = 0;
    const repo = {
      findByContentHash: vi.fn(async () => undefined),
      createDocument: vi.fn(async (userId: string) => { await new Promise(r => setTimeout(r, 20)); return { id: `d${++n}`, userId }; }),
      addChunk: vi.fn(async () => ({})),
      updateChunkCount: vi.fn(async () => {}),
    };
    const emb = { embedAndStore: vi.fn(async () => 'e1') };
    const p = new DocumentProcessor(repo as never, emb as never, logger);
    const daten = Buffer.from('Inhalt der Rechnung');
    const [a, b] = await Promise.all([
      p.ingest('M', 'x.txt', 'x.txt', 'text/plain', daten),
      p.ingest('M', 'x.txt', 'x.txt', 'text/plain', daten),
    ]);
    expect(repo.createDocument).toHaveBeenCalledTimes(1);
    expect(a.documentId).toBe(b.documentId);
    expect(b.existing).toBe(true);
  });

  it('fehlende Embeddings werden nachgeholt und am Abschnitt vermerkt', async () => {
    const repo = {
      listChunksOhneEmbedding: vi.fn(async () => [
        { id: 'c1', documentId: 'd1', chunkIndex: 0, content: 'Teil A', userId: 'M' },
        { id: 'c2', documentId: 'd1', chunkIndex: 1, content: 'Teil B', userId: 'M' },
      ]),
      setChunkEmbedding: vi.fn(async () => {}),
    };
    const emb = { embedAndStore: vi.fn(async (_u: string, _c: string, _t: string, src: string) => `e-${src}`) };
    const r = await new DocumentProcessor(repo as never, emb as never, logger).fehlendeEmbeddingsNachholen();
    expect(r).toEqual({ offen: 2, nachgeholt: 2, fehler: 0 });
    expect(emb.embedAndStore).toHaveBeenCalledWith('M', 'Teil B', 'document', 'd1:1');
    expect(repo.setChunkEmbedding).toHaveBeenCalledWith('c2', 'e-d1:1');
  });
});
