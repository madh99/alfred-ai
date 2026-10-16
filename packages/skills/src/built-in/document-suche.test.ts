import { describe, it, expect, vi } from 'vitest';
import type { SkillContext, Document } from '@alfred/types';
import { DocumentSkill } from './document.js';

// v1475 — Dokumentsuche: nur Dokument-Embeddings, Treffer mit ID/Dateiname, Zugriff wirklich geprüft
const M = 'f165df7a-8689-49b6-9318-41839913846f';
const doc = (id: string, userId: string, filename: string, visibility: Document['visibility'] = 'private'): Document =>
  ({ id, userId, filename, mimeType: 'application/pdf', sizeBytes: 1, chunkCount: 1, visibility, createdAt: '2026-10-16' });
const DOCS = new Map([
  ['d-eigen', doc('d-eigen', M, 'awattar-2025-03.pdf')],
  ['d-oeff', doc('d-oeff', 'fremd', 'hausordnung.pdf', 'public')],
  ['d-privat', doc('d-privat', 'fremd', 'geheim.pdf')],
]);
const repo = {
  listAccessible: vi.fn(async (u: string) => [...DOCS.values()].filter(d => d.userId === u || d.visibility === 'public')),
  getDocument: vi.fn(async (id: string) => DOCS.get(id)),
  canAccess: vi.fn(async () => true),
};
const ctx = { userId: '5060785419', masterUserId: M, linkedPlatformUserIds: ['5060785419'], chatId: 'c', platform: 'telegram', conversationId: 'k' } as unknown as SkillContext;

describe('v1475 Dokumentsuche', () => {
  it('Treffer mit Dateiname und id, öffentliche fremde ja, private fremde nein', async () => {
    const byType = vi.fn(async (uid: string) => uid === M
      ? [{ sourceId: 'd-eigen:2', content: 'Gesamtbetrag 41,20 EUR', score: 0.81 }]
      : uid === 'fremd' ? [{ sourceId: 'd-oeff:0', content: 'Ruhezeiten 22 Uhr', score: 0.7 }, { sourceId: 'd-privat:0', content: 'geheim', score: 0.9 }] : []);
    const skill = new DocumentSkill(repo as never, { ingest: vi.fn() } as never, { semanticSearch: vi.fn(), semanticSearchByType: byType });
    const r = await skill.execute({ action: 'search', query: 'Stromrechnung März' }, ctx);
    expect(byType).toHaveBeenCalledWith(M, 'Stromrechnung März', 'document', 5, 0);
    expect(r.display).toContain('**awattar-2025-03.pdf** [id=d-eigen] Abschnitt 3');
    expect(r.display).toContain('hausordnung.pdf');
    expect(r.display).not.toContain('geheim');
    expect((r.data as Array<{ documentId: string }>).map(d => d.documentId)).toEqual(['d-eigen', 'd-oeff']);
  });

  it('store_key-Ingest liest mit der Master-UUID und bildet alte Schlüssel ab', async () => {
    const read = vi.fn(async () => Buffer.from('x'));
    const ingest = vi.fn(async () => ({ documentId: 'neu', chunkCount: 1 }));
    const skill = new DocumentSkill(repo as never, { ingest } as never, { semanticSearch: vi.fn() });
    const r = await skill.execute({ action: 'ingest', store_key: '5060785419/2026-06-06T13-42-14-587Z_plan.md' }, { ...ctx, fileStore: { read } } as unknown as SkillContext);
    expect(r.success).toBe(true);
    expect(read).toHaveBeenCalledWith(`${M}/2026-06-06T13-42-14-587Z_plan.md`, M);
    expect(ingest.mock.calls[0]![0]).toBe(M);
  });
});
