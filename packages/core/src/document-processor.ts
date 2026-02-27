import type { Logger } from 'pino';
import type { EmbeddingService } from './embedding-service.js';
import type { DocumentRepository } from '@alfred/storage';

export class DocumentProcessor {
  constructor(
    private readonly docRepo: DocumentRepository,
    private readonly embeddingService: EmbeddingService,
    private readonly logger: Logger,
  ) {}

  async ingest(
    userId: string,
    filePath: string,
    filename: string,
    mimeType: string,
  ): Promise<{ documentId: string; chunkCount: number }> {
    // 1. Read file content based on type
    const content = await this.extractText(filePath, mimeType);

    // 2. Create document record
    const fs = await import('node:fs');
    const stat = fs.statSync(filePath);
    const doc = this.docRepo.createDocument(userId, filename, mimeType, stat.size);

    // 3. Chunk content (~500 tokens per chunk with 50-token overlap)
    const chunks = this.chunkText(content, 500, 50);

    // 4. Store each chunk and create embeddings
    for (let i = 0; i < chunks.length; i++) {
      let embeddingId: string | undefined;
      try {
        await this.embeddingService.embedAndStore(userId, chunks[i], 'document', `${doc.id}:${i}`);
        embeddingId = `${doc.id}:${i}`;
      } catch {
        this.logger.warn({ documentId: doc.id, chunkIndex: i }, 'Embedding failed for chunk, continuing');
      }
      this.docRepo.addChunk(doc.id, i, chunks[i], embeddingId);
    }

    this.docRepo.updateChunkCount(doc.id, chunks.length);

    this.logger.info({ documentId: doc.id, filename, chunkCount: chunks.length }, 'Document ingested');

    return { documentId: doc.id, chunkCount: chunks.length };
  }

  async extractText(filePath: string, mimeType: string): Promise<string> {
    const fs = await import('node:fs');

    if (mimeType === 'application/pdf') {
      try {
        const pdfParse = (await import('pdf-parse')).default;
        const buffer = fs.readFileSync(filePath);
        const data = await pdfParse(buffer);
        return data.text;
      } catch (err) {
        this.logger.error({ err }, 'PDF parsing failed');
        throw new Error('Failed to parse PDF');
      }
    }

    if (
      mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      mimeType === 'application/msword'
    ) {
      try {
        const mammoth = await import('mammoth');
        const result = await mammoth.extractRawText({ path: filePath });
        return result.value;
      } catch (err) {
        this.logger.error({ err }, 'DOCX parsing failed');
        throw new Error('Failed to parse DOCX');
      }
    }

    // Text-based formats: txt, csv, md, etc.
    return fs.readFileSync(filePath, 'utf-8');
  }

  chunkText(text: string, targetTokens: number, overlapTokens: number): string[] {
    // Rough token estimation: ~3.5 chars per token
    const charsPerToken = 3.5;
    const targetChars = Math.round(targetTokens * charsPerToken);
    const overlapChars = Math.round(overlapTokens * charsPerToken);

    const chunks: string[] = [];
    let start = 0;

    while (start < text.length) {
      let end = start + targetChars;

      if (end >= text.length) {
        chunks.push(text.slice(start).trim());
        break;
      }

      // Try to break at a paragraph or sentence boundary
      const searchStart = Math.max(end - 200, start);
      const searchRegion = text.slice(searchStart, end + 200);

      // Prefer paragraph breaks
      const paragraphBreak = searchRegion.lastIndexOf('\n\n');
      if (paragraphBreak > 0) {
        end = searchStart + paragraphBreak;
      } else {
        // Fall back to sentence break
        const sentenceBreak = searchRegion.lastIndexOf('. ');
        if (sentenceBreak > 0) {
          end = searchStart + sentenceBreak + 1;
        }
      }

      const chunk = text.slice(start, end).trim();
      if (chunk) chunks.push(chunk);

      start = end - overlapChars;
    }

    return chunks.filter(c => c.length > 0);
  }
}
