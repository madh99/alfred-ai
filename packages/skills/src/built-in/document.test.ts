import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SkillContext } from '@alfred/types';
import type { Document, DocumentChunk } from '@alfred/types';
import { DocumentSkill } from './document.js';
import type { DocumentProcessorInterface, EmbeddingSearchService } from './document.js';

const ctx: SkillContext = {
  userId: 'u1',
  chatId: 'c1',
  platform: 'test',
  conversationId: 'conv1',
};

function createMockDocRepo() {
  const documents = new Map<string, Document>();
  const chunks = new Map<string, DocumentChunk[]>();
  let counter = 0;

  return {
    createDocument: vi.fn((userId: string, filename: string, mimeType: string, sizeBytes: number): Document => {
      const id = `doc-${++counter}`;
      const now = new Date().toISOString();
      const doc: Document = { id, userId, filename, mimeType, sizeBytes, chunkCount: 0, createdAt: now };
      documents.set(id, doc);
      return doc;
    }),
    updateChunkCount: vi.fn((documentId: string, count: number) => {
      const doc = documents.get(documentId);
      if (doc) doc.chunkCount = count;
    }),
    addChunk: vi.fn((documentId: string, chunkIndex: number, content: string, embeddingId?: string): DocumentChunk => {
      const id = `chunk-${++counter}`;
      const now = new Date().toISOString();
      const chunk: DocumentChunk = { id, documentId, chunkIndex, content, embeddingId, createdAt: now };
      const existing = chunks.get(documentId) ?? [];
      existing.push(chunk);
      chunks.set(documentId, existing);
      return chunk;
    }),
    getDocument: vi.fn((id: string) => documents.get(id)),
    getChunks: vi.fn((documentId: string) => chunks.get(documentId) ?? []),
    listByUser: vi.fn((userId: string) => [...documents.values()].filter(d => d.userId === userId)),
    deleteDocument: vi.fn((id: string) => {
      documents.delete(id);
      chunks.delete(id);
    }),
    getChunksByEmbeddingIds: vi.fn((_ids: string[]) => []),
  };
}

function createMockProcessor(): DocumentProcessorInterface {
  return {
    ingest: vi.fn(async (userId: string, _filePath: string, _filename: string, _mimeType: string) => {
      return { documentId: `doc-ingested-${Date.now()}`, chunkCount: 3 };
    }),
  };
}

function createMockEmbeddingService(): EmbeddingSearchService {
  return {
    semanticSearch: vi.fn(async (_userId: string, _query: string, _limit?: number) => {
      return [
        { key: 'doc:1:0', value: 'This is a relevant chunk about AI systems.', category: 'document', score: 0.92 },
        { key: 'doc:1:1', value: 'Another chunk about machine learning.', category: 'document', score: 0.85 },
        { key: 'mem:1', value: 'Some memory entry', category: 'memory', score: 0.7 },
      ];
    }),
  };
}

describe('DocumentSkill', () => {
  let skill: DocumentSkill;
  let docRepo: ReturnType<typeof createMockDocRepo>;
  let processor: DocumentProcessorInterface;
  let embeddingService: EmbeddingSearchService;

  beforeEach(() => {
    docRepo = createMockDocRepo();
    processor = createMockProcessor();
    embeddingService = createMockEmbeddingService();
    skill = new DocumentSkill(docRepo as any, processor, embeddingService);
  });

  it('should have correct metadata', () => {
    expect(skill.metadata.name).toBe('document');
    expect(skill.metadata.riskLevel).toBe('write');
  });

  it('ingest calls processor and returns success', async () => {
    const result = await skill.execute(
      {
        action: 'ingest',
        file_path: '/tmp/test.pdf',
        filename: 'test.pdf',
        mime_type: 'application/pdf',
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(processor.ingest).toHaveBeenCalledWith('u1', '/tmp/test.pdf', 'test.pdf', 'application/pdf');
    const data = result.data as { documentId: string; chunkCount: number };
    expect(data.documentId).toBeDefined();
    expect(data.chunkCount).toBe(3);
    expect(result.display).toContain('test.pdf');
    expect(result.display).toContain('3 chunks');
  });

  it('ingest with missing file_path returns error', async () => {
    const result = await skill.execute(
      { action: 'ingest', filename: 'test.pdf', mime_type: 'application/pdf' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('file_path');
  });

  it('ingest with missing filename returns error', async () => {
    const result = await skill.execute(
      { action: 'ingest', file_path: '/tmp/test.pdf', mime_type: 'application/pdf' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('filename');
  });

  it('ingest with missing mime_type returns error', async () => {
    const result = await skill.execute(
      { action: 'ingest', file_path: '/tmp/test.pdf', filename: 'test.pdf' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('mime_type');
  });

  it('search returns semantic results filtered to documents', async () => {
    const result = await skill.execute(
      { action: 'search', query: 'AI systems' },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(embeddingService.semanticSearch).toHaveBeenCalledWith('u1', 'AI systems', 5);

    const data = result.data as Array<{ category: string; score: number }>;
    expect(data.length).toBe(2); // Only document results, not memory
    expect(data.every(d => d.category === 'document')).toBe(true);
    expect(result.display).toContain('2 relevant chunk(s)');
  });

  it('search with missing query returns error', async () => {
    const result = await skill.execute(
      { action: 'search' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('query');
  });

  it('search without embedding service returns error', async () => {
    const skillNoEmbed = new DocumentSkill(docRepo as any, processor);

    const result = await skillNoEmbed.execute(
      { action: 'search', query: 'test' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Embedding service not available');
  });

  it('summarize returns document content', async () => {
    // Prepare a document with chunks
    const doc = docRepo.createDocument('u1', 'report.pdf', 'application/pdf', 1024);
    docRepo.addChunk(doc.id, 0, 'Chapter 1: Introduction to the topic.');
    docRepo.addChunk(doc.id, 1, 'Chapter 2: Deep dive into details.');
    docRepo.updateChunkCount(doc.id, 2);

    const result = await skill.execute(
      { action: 'summarize', document_id: doc.id },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = result.data as { document: Document; content: string; totalChunks: number };
    expect(data.totalChunks).toBe(2);
    expect(data.content).toContain('Chapter 1');
    expect(data.content).toContain('Chapter 2');
    expect(result.display).toContain('report.pdf');
  });

  it('summarize with missing document_id returns error', async () => {
    const result = await skill.execute(
      { action: 'summarize' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('document_id');
  });

  it('summarize with unknown document_id returns error', async () => {
    const result = await skill.execute(
      { action: 'summarize', document_id: 'nonexistent-id' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('list returns user documents', async () => {
    docRepo.createDocument('u1', 'file1.pdf', 'application/pdf', 500);
    docRepo.createDocument('u1', 'file2.txt', 'text/plain', 200);
    docRepo.createDocument('u2', 'other.pdf', 'application/pdf', 300); // different user

    const result = await skill.execute(
      { action: 'list' },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = result.data as Document[];
    expect(data.length).toBe(2);
    expect(result.display).toContain('file1.pdf');
    expect(result.display).toContain('file2.txt');
  });

  it('list with no documents returns empty', async () => {
    const result = await skill.execute(
      { action: 'list' },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = result.data as Document[];
    expect(data.length).toBe(0);
    expect(result.display).toContain('No documents found');
  });

  it('delete removes document', async () => {
    const doc = docRepo.createDocument('u1', 'to-delete.pdf', 'application/pdf', 100);

    const result = await skill.execute(
      { action: 'delete', document_id: doc.id },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(docRepo.deleteDocument).toHaveBeenCalledWith(doc.id);
    expect(result.display).toContain('to-delete.pdf');
    expect(result.display).toContain('deleted');
  });

  it('delete with missing document_id returns error', async () => {
    const result = await skill.execute(
      { action: 'delete' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('document_id');
  });

  it('delete with unknown document_id returns error', async () => {
    const result = await skill.execute(
      { action: 'delete', document_id: 'nonexistent' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('unknown action returns error', async () => {
    const result = await skill.execute(
      { action: 'invalid' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown action');
  });
});
