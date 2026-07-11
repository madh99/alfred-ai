import { describe, it, expect, vi } from 'vitest';
import { StoryDeduper } from '../story-dedup.js';
import { storyIdentity, cosineSimilarity } from '@alfred/skills';
import type { EmbeddingRepository } from '@alfred/storage';

const OWNER = 'owner-1';

function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn().mockReturnThis() } as any;
}

/**
 * Fake-Embedder: bildet Texte auf Vektoren ab — Story-Schlüsselwörter bestimmen
 * die Richtung, damit Paraphrasen derselben Story nahe beieinander liegen
 * (simuliert semantische Embeddings deterministisch).
 */
function makeEmbedFn() {
  const AXES = ['alaba', 'arnautovic', 'postecoglou', 'panini', 'glasner'];
  return vi.fn(async (text: string) => {
    const lower = text.toLowerCase();
    const vec = AXES.map(axis => (lower.includes(axis) ? 1 : 0.01));
    return { embedding: vec, model: 'fake-embed', dimensions: vec.length };
  });
}

function makeEmbeddingRepo(stored: Record<string, number[]> = {}) {
  return {
    findBySource: vi.fn(async (_t: string, sourceId: string) =>
      stored[sourceId] ? { embedding: stored[sourceId] } : undefined),
    store: vi.fn(async () => ({})),
  } as unknown as EmbeddingRepository;
}

describe('storyIdentity + cosineSimilarity (v973)', () => {
  it('Identität = Titel + Body-Anfang (normalisiert)', () => {
    expect(storyIdentity({ title: 'Titel', body: 'Erster  Satz.\nZweiter Satz.' }))
      .toBe('Titel — Erster Satz. Zweiter Satz.');
    expect(storyIdentity({ body: 'Nur Body' })).toBe('Nur Body');
  });

  it('cosine: identisch=1, orthogonal=0, defensiv bei Längen-Mismatch', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [1])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe('StoryDeduper (v973)', () => {
  const BLOCKED = [
    { id: 'b1', title: 'Alaba hält sich alle Optionen offen', body: 'David Alaba lässt seine Zukunft im Nationalteam offen.' },
    { id: 'b2', title: 'Panini-Sonderheft zur WM erschienen', body: 'Das neue Panini-Sonderheft ist da.' },
  ];

  it('Token-Schicht: wörtlich identischer Titel wird verworfen (Arnautovic-Realfall)', async () => {
    const deduper = new StoryDeduper(undefined, undefined, undefined, makeLogger(), OWNER);
    const r = await deduper.filterCandidates(
      [{ title: 'Alaba hält sich alle Optionen offen', body: 'Egal.' }],
      BLOCKED,
    );
    expect(r.accepted.length).toBe(0);
    expect(r.droppedToken).toBe(1);
  });

  it('semantische Schicht: PARAPHRASE derselben Story wird verworfen (Alaba-Realfall, 40% Token-Overlap)', async () => {
    const deduper = new StoryDeduper(makeEmbedFn(), makeEmbeddingRepo(), undefined, makeLogger(), OWNER);
    const r = await deduper.filterCandidates(
      [
        // v1090: Titel so gewählt, dass die Token-Schicht ihn NICHT fängt (nur 'alaba' gemeinsam) und wirklich die semantische Schicht entscheidet
        { title: 'Comeback im Nationalteam? Alaba deutet Rückkehr an', body: 'Der Real-Star Alaba deutet an…' }, // Paraphrase von b1
        { title: 'Glasner übernimmt in Nottingham', body: 'Der Trainer Glasner wechselt.' },                  // neue Story
      ],
      BLOCKED,
    );
    expect(r.accepted.map(a => a.title)).toEqual(['Glasner übernimmt in Nottingham']);
    expect(r.droppedSemantic).toBe(1);
  });

  it('Batch-intern: zweite Paraphrase desselben Kandidaten wird verworfen', async () => {
    const deduper = new StoryDeduper(makeEmbedFn(), makeEmbeddingRepo(), undefined, makeLogger(), OWNER);
    const r = await deduper.filterCandidates(
      [
        { title: 'Postecoglou übernimmt – Ronaldo bekommt neuen Coach', body: 'Postecoglou…' },
        { title: 'Postecoglou zu Ronaldo – neues Kapitel', body: 'Der Coach Postecoglou…' }, // Realfall 03.07. 23:10
      ],
      [],
    );
    expect(r.accepted.length).toBe(1);
  });

  it('persistierte Embeddings werden gelesen statt neu berechnet', async () => {
    const embedFn = makeEmbedFn();
    const repo = makeEmbeddingRepo({ b1: [1, 0.01, 0.01, 0.01, 0.01], b2: [0.01, 0.01, 0.01, 1, 0.01] });
    const deduper = new StoryDeduper(embedFn, repo, undefined, makeLogger(), OWNER);
    await deduper.filterCandidates([{ title: 'Neue Story über Tennis', body: 'Ganz anderes Thema.' }], BLOCKED);
    // embed nur für den KANDIDATEN (1×) — Blocked kam aus dem Repo
    expect(embedFn.mock.calls.length).toBe(1);
    expect(repo.findBySource).toHaveBeenCalledWith('social-item', 'b1', OWNER);
  });

  it('embedStory persistiert die Identität unter der Item-ID', async () => {
    const repo = makeEmbeddingRepo();
    const deduper = new StoryDeduper(makeEmbedFn(), repo, undefined, makeLogger(), OWNER);
    await deduper.embedStory('item-9', { title: 'Titel', body: 'Body-Text hier.' });
    expect((repo.store as any).mock.calls[0][0]).toMatchObject({
      userId: OWNER, sourceType: 'social-item', sourceId: 'item-9', model: 'fake-embed',
    });
  });

  it('ohne Embeddings: LLM-Judge-Fallback verwirft gemeldete Duplikate', async () => {
    const llm = { complete: vi.fn(async () => ({ content: '[0]' })) };
    const deduper = new StoryDeduper(undefined, undefined, llm as any, makeLogger(), OWNER);
    const r = await deduper.filterCandidates(
      [
        { title: 'Alabas Entscheidung rückt näher', body: 'x' }, // Judge sagt: Duplikat von b1
        { title: 'Neuer Rasen im Stadion', body: 'y' },
      ],
      BLOCKED,
    );
    expect(r.accepted.map(a => a.title)).toEqual(['Neuer Rasen im Stadion']);
    expect(r.droppedSemantic).toBe(1);
  });

  it('Judge-Ausfall → fail-open auf die Token-Schicht (lieber Duplikat als kein Content)', async () => {
    const llm = { complete: vi.fn(async () => { throw new Error('down'); }) };
    const deduper = new StoryDeduper(undefined, undefined, llm as any, makeLogger(), OWNER);
    const r = await deduper.filterCandidates(
      [{ title: 'Völlig neue Story über Handball', body: 'z' }],
      BLOCKED,
    );
    expect(r.accepted.length).toBe(1);
  });
});
