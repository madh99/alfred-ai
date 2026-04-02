/**
 * OCR Service using Mistral's OCR API.
 * Provides document OCR capabilities for PDFs and images,
 * returning structured markdown content.
 */

export interface OcrPage {
  index: number;
  markdown: string;
  images?: string[]; // base64
}

export interface OcrResult {
  pages: OcrPage[];
  totalPages: number;
}

export type OcrDocumentInput =
  | { type: 'document_url'; url: string }
  | { type: 'image_url'; url: string }
  | { type: 'base64'; data: string; mimeType: string };

export class OcrService {
  private usageCallback?: (model: string, units: number) => void;

  /** Set callback for tracking service usage (called with model + page count). */
  setUsageCallback(cb: (model: string, units: number) => void): void { this.usageCallback = cb; }

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = 'https://api.mistral.ai/v1',
    private readonly model: string = 'mistral-ocr-latest',
  ) {}

  /**
   * Process a document (PDF or image) through Mistral OCR.
   * Returns structured OcrResult with per-page markdown, or null on failure (graceful fallback).
   */
  async processDocument(input: OcrDocumentInput): Promise<OcrResult | null> {
    try {
      let document: Record<string, unknown>;

      if (input.type === 'base64') {
        // Send as data URI embedded in document_url
        const dataUri = `data:${input.mimeType};base64,${input.data}`;
        document = { type: 'document_url', document_url: dataUri };
      } else if (input.type === 'document_url') {
        document = { type: 'document_url', document_url: input.url };
      } else {
        document = { type: 'image_url', image_url: input.url };
      }

      const response = await fetch(`${this.baseUrl}/ocr`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          document,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Mistral OCR API ${response.status}: ${errorText}`);
      }

      const data = await response.json() as {
        pages?: Array<{
          index: number;
          markdown: string;
          images?: Array<{ id: string; image_base64: string }>;
        }>;
      };

      if (!data.pages || data.pages.length === 0) {
        return null;
      }

      const pages: OcrPage[] = data.pages.map(p => ({
        index: p.index,
        markdown: p.markdown,
        images: p.images?.map(img => img.image_base64),
      }));

      if (this.usageCallback) this.usageCallback(this.model, pages.length);
      return {
        pages,
        totalPages: pages.length,
      };
    } catch {
      // Graceful fallback — return null so caller can use alternative extraction
      return null;
    }
  }

  /**
   * Process a PDF buffer through OCR and return the combined markdown text.
   * Convenience method for the DocumentProcessor integration.
   */
  async processBuffer(buffer: Buffer, mimeType: string): Promise<string | null> {
    const base64 = buffer.toString('base64');
    const result = await this.processDocument({
      type: 'base64',
      data: base64,
      mimeType,
    });

    if (!result || result.pages.length === 0) {
      return null;
    }

    // Combine all pages into a single markdown string
    return result.pages.map(p => p.markdown).join('\n\n---\n\n');
  }
}
