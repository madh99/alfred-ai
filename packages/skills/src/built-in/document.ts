import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../skill.js';
import type { DocumentRepository } from '@alfred/storage';
import { effectiveUserId, allUserIds } from '../user-utils.js';

/** Minimal embedding service interface to avoid circular dep on @alfred/core. */
export interface EmbeddingSearchService {
  semanticSearch(userId: string, query: string, limit?: number): Promise<{ key: string; value: string; category: string; score: number }[]>;
}

export interface DocumentProcessorInterface {
  ingest(
    userId: string,
    filePath: string,
    filename: string,
    mimeType: string,
  ): Promise<{ documentId: string; chunkCount: number; existing?: boolean }>;
}

type DocumentAction = 'ingest' | 'search' | 'summarize' | 'list' | 'delete' | 'share' | 'unshare';

export class DocumentSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'document',
    category: 'files',
    description:
      'Ingest, search, summarize, list, delete, share, or unshare documents. Supports PDF, DOCX, TXT, CSV, and Markdown files. ' +
      'Documents are chunked and embedded for semantic search. Documents can be private (default), shared with specific users, or public (visible to all users).',
    riskLevel: 'write',
    version: '1.0.0',
    timeoutMs: 120_000,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['ingest', 'search', 'summarize', 'list', 'delete', 'share', 'unshare'],
          description: 'Action to perform',
        },
        file_path: { type: 'string', description: 'Path to the file (for ingest)' },
        filename: { type: 'string', description: 'Original filename (for ingest)' },
        mime_type: { type: 'string', description: 'MIME type of the file (for ingest)' },
        query: { type: 'string', description: 'Search query (for search)' },
        document_id: { type: 'string', description: 'Document ID (for summarize, delete, share, unshare)' },
        limit: { type: 'number', description: 'Max results (for search, list)' },
        visibility: { type: 'string', enum: ['private', 'shared', 'public'], description: 'Document visibility (for share). "public" = all users, "shared" = specific users, "private" = only owner' },
      },
      required: ['action'],
    },
  };

  constructor(
    private readonly docRepo: DocumentRepository,
    private readonly processor: DocumentProcessorInterface,
    private readonly embeddingService?: EmbeddingSearchService,
  ) {
    super();
  }

  async execute(
    input: Record<string, unknown>,
    context: SkillContext,
  ): Promise<SkillResult> {
    const action = input.action as DocumentAction;

    switch (action) {
      case 'ingest':
        return this.ingest(input, context);
      case 'search':
        return this.search(input, context);
      case 'summarize':
        return this.summarize(input, context);
      case 'list':
        return this.list(input, context);
      case 'delete':
        return this.deleteDoc(input, context);
      case 'share':
        return this.shareDoc(input, context);
      case 'unshare':
        return this.unshareDoc(input, context);
      default:
        return {
          success: false,
          error: `Unknown action: "${String(action)}". Valid actions: ingest, search, summarize, list, delete, share, unshare`,
        };
    }
  }

  private async ingest(
    input: Record<string, unknown>,
    context: SkillContext,
  ): Promise<SkillResult> {
    const filePath = input.file_path as string | undefined;
    const filename = input.filename as string | undefined;
    const mimeType = input.mime_type as string | undefined;

    if (!filePath || typeof filePath !== 'string') {
      return { success: false, error: 'Missing required field "file_path" for ingest action' };
    }
    if (!filename || typeof filename !== 'string') {
      return { success: false, error: 'Missing required field "filename" for ingest action' };
    }
    if (!mimeType || typeof mimeType !== 'string') {
      return { success: false, error: 'Missing required field "mime_type" for ingest action' };
    }

    // Security: prevent path traversal — reject paths with ..
    const path = await import('node:path');
    const resolved = path.resolve(filePath);
    if (resolved !== path.normalize(filePath) && filePath.includes('..')) {
      return { success: false, error: 'Invalid file path: path traversal not allowed' };
    }

    // Reject obvious system paths
    const lower = resolved.toLowerCase();
    if (lower.startsWith('/etc/') || lower.startsWith('/proc/') || lower.startsWith('/sys/') ||
        lower.startsWith('c:\\windows\\') || lower.startsWith('/root/')) {
      return { success: false, error: 'Access to system directories is not allowed' };
    }

    try {
      const result = await this.processor.ingest(effectiveUserId(context), filePath, filename, mimeType);
      const display = result.existing
        ? `Document "${filename}" already ingested (${result.chunkCount} chunks). Ready for search. ID: ${result.documentId.slice(0, 8)}...`
        : `Document "${filename}" ingested successfully (${result.chunkCount} chunks). ID: ${result.documentId.slice(0, 8)}...`;
      return {
        success: true,
        data: result,
        display,
      };
    } catch (err) {
      return {
        success: false,
        error: `Failed to ingest document: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private async search(
    input: Record<string, unknown>,
    context: SkillContext,
  ): Promise<SkillResult> {
    const query = input.query as string | undefined;
    const limit = (input.limit as number) || 5;

    if (!query || typeof query !== 'string') {
      return { success: false, error: 'Missing required field "query" for search action' };
    }

    if (!this.embeddingService) {
      return { success: false, error: 'Embedding service not available for document search' };
    }

    // Search across all linked user IDs for cross-platform document access
    const allIds = allUserIds(context);
    const seen = new Set<string>();
    const allResults: { key: string; value: string; category: string; score: number }[] = [];
    for (const uid of allIds) {
      for (const r of await this.embeddingService.semanticSearch(uid, query, limit)) {
        if (!seen.has(r.key)) {
          seen.add(r.key);
          allResults.push(r);
        }
      }
    }

    // Filter to only document-sourced results + verify access
    const userId = effectiveUserId(context);
    const docResults = allResults.filter(r => {
      if (r.category !== 'document') return false;
      // key format is "doc:<docId>:chunk:<idx>" — extract docId
      const docIdMatch = r.key.match(/^doc:([^:]+)/);
      if (docIdMatch) {
        return this.docRepo.canAccess(docIdMatch[1], userId);
      }
      return true; // if can't determine doc ID, allow (backward compat)
    });

    if (docResults.length === 0) {
      return { success: true, data: [], display: `No document matches found for "${query}".` };
    }

    const display = docResults
      .map((r, i) => `${i + 1}. (score: ${r.score.toFixed(3)}) ${r.value.slice(0, 200)}${r.value.length > 200 ? '...' : ''}`)
      .join('\n\n');

    return {
      success: true,
      data: docResults,
      display: `Found ${docResults.length} relevant chunk(s):\n\n${display}`,
    };
  }

  private summarize(input: Record<string, unknown>, context: SkillContext): SkillResult {
    const documentId = input.document_id as string | undefined;

    if (!documentId || typeof documentId !== 'string') {
      return { success: false, error: 'Missing required field "document_id" for summarize action' };
    }

    const doc = this.docRepo.getDocument(documentId);
    if (!doc) {
      return { success: false, error: `Document "${documentId}" not found` };
    }

    // Access check: only owner, admin, or if document is public/shared
    const userId = effectiveUserId(context);
    if (!this.docRepo.canAccess(documentId, userId)) {
      return { success: false, error: 'Kein Zugriff auf dieses Dokument.' };
    }

    const chunks = this.docRepo.getChunks(documentId);
    if (chunks.length === 0) {
      return { success: true, data: { document: doc, content: '' }, display: `Document "${doc.filename}" has no content chunks.` };
    }

    const fullContent = chunks.map(c => c.content).join('\n\n');

    // Truncate if excessively long (keep first ~8000 chars for LLM context)
    const maxChars = 8000;
    const truncated = fullContent.length > maxChars;
    const content = truncated ? fullContent.slice(0, maxChars) + '\n\n[... truncated]' : fullContent;

    return {
      success: true,
      data: {
        document: doc,
        content,
        totalChunks: chunks.length,
        truncated,
      },
      display: `Document: **${doc.filename}** (${chunks.length} chunks, ${doc.sizeBytes} bytes)\n\n${content}`,
    };
  }

  private list(
    input: Record<string, unknown>,
    context: SkillContext,
  ): SkillResult {
    const limit = (input.limit as number) || 50;
    // List own + public + shared documents
    const userId = effectiveUserId(context);
    const docs = this.docRepo.listAccessible(userId);
    const limited = docs.slice(0, limit);

    if (limited.length === 0) {
      return { success: true, data: [], display: 'No documents found.' };
    }

    const display = limited
      .map(d => {
        const vis = d.visibility !== 'private' ? ` [${d.visibility}]` : '';
        const owner = d.userId !== userId ? ` (von ${d.userId})` : '';
        return `- **${d.filename}**${vis}${owner} [id=${d.id}] — ${d.mimeType}, ${d.chunkCount} chunks`;
      })
      .join('\n');

    return {
      success: true,
      data: limited,
      display: `${limited.length} document(s):\n${display}`,
    };
  }

  private deleteDoc(input: Record<string, unknown>, context: SkillContext): SkillResult {
    const documentId = input.document_id as string | undefined;

    if (!documentId || typeof documentId !== 'string') {
      return { success: false, error: 'Missing required field "document_id" for delete action' };
    }

    const doc = this.docRepo.getDocument(documentId);
    if (!doc) {
      return { success: false, error: `Document "${documentId}" not found` };
    }

    // Only owner or admin can delete
    const userId = effectiveUserId(context);
    if (doc.userId !== userId && context.userRole !== 'admin') {
      return { success: false, error: 'Nur der Owner oder Admin kann dieses Dokument löschen.' };
    }

    this.docRepo.deleteDocument(documentId);

    return {
      success: true,
      data: { documentId },
      display: `Document "${doc.filename}" deleted.`,
    };
  }

  private shareDoc(input: Record<string, unknown>, context: SkillContext): SkillResult {
    const documentId = input.document_id as string;
    const visibility = (input.visibility as 'private' | 'shared' | 'public') ?? 'public';
    if (!documentId) return { success: false, error: 'Missing "document_id"' };

    const doc = this.docRepo.getDocument(documentId);
    if (!doc) return { success: false, error: `Document "${documentId}" not found` };

    // Only owner or admin can share
    const userId = effectiveUserId(context);
    if (doc.userId !== userId && context.userRole !== 'admin') {
      return { success: false, error: 'Nur der Owner oder Admin kann Dokumente teilen.' };
    }

    this.docRepo.setVisibility(documentId, visibility);
    return {
      success: true,
      data: { documentId, visibility },
      display: `✅ Dokument "${doc.filename}" ist jetzt ${visibility === 'public' ? 'für alle sichtbar' : visibility === 'shared' ? 'geteilt' : 'privat'}.`,
    };
  }

  private unshareDoc(input: Record<string, unknown>, context: SkillContext): SkillResult {
    const documentId = input.document_id as string;
    if (!documentId) return { success: false, error: 'Missing "document_id"' };

    const doc = this.docRepo.getDocument(documentId);
    if (!doc) return { success: false, error: `Document "${documentId}" not found` };

    const userId = effectiveUserId(context);
    if (doc.userId !== userId && context.userRole !== 'admin') {
      return { success: false, error: 'Nur der Owner oder Admin kann die Freigabe ändern.' };
    }

    this.docRepo.setVisibility(documentId, 'private');
    return {
      success: true,
      data: { documentId },
      display: `✅ Dokument "${doc.filename}" ist jetzt privat.`,
    };
  }
}
