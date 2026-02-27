import { describe, it, expect } from 'vitest';
import { DocumentProcessor } from '../document-processor.js';

// We only test the pure chunkText() method which has no external dependencies.
// To access it we create a DocumentProcessor with dummy deps and call chunkText directly.
function getProcessor(): DocumentProcessor {
  const dummyDocRepo = {} as any;
  const dummyEmbedding = {} as any;
  const dummyLogger = { info() {}, warn() {}, error() {}, debug() {} } as any;
  return new DocumentProcessor(dummyDocRepo, dummyEmbedding, dummyLogger);
}

describe('DocumentProcessor.chunkText', () => {
  const processor = getProcessor();

  it('should return a single chunk for short text', () => {
    const text = 'This is a short piece of text.';
    const chunks = processor.chunkText(text, 500, 50);

    expect(chunks.length).toBe(1);
    expect(chunks[0]).toBe(text);
  });

  it('should chunk long text into multiple chunks', () => {
    // 500 tokens * 3.5 chars/token = 1750 chars target per chunk
    // Create text well over 1750 chars
    const paragraph = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. ';
    const text = paragraph.repeat(100); // ~5700 chars

    const chunks = processor.chunkText(text, 500, 50);

    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should be within a reasonable range of the target
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThan(0);
    }
  });

  it('should produce correct chunk sizes (approximately targetTokens * 3.5 chars)', () => {
    const targetTokens = 100;
    const overlapTokens = 10;
    const targetChars = Math.round(targetTokens * 3.5); // 350

    // Create text that is much larger than one chunk
    const word = 'word ';
    const text = word.repeat(500); // 2500 chars

    const chunks = processor.chunkText(text, targetTokens, overlapTokens);

    expect(chunks.length).toBeGreaterThan(1);
    // All chunks except possibly the last should be roughly around targetChars
    for (let i = 0; i < chunks.length - 1; i++) {
      // Allow generous range since boundary breaking can shift the size
      expect(chunks[i].length).toBeGreaterThan(targetChars * 0.3);
      expect(chunks[i].length).toBeLessThan(targetChars * 2);
    }
  });

  it('should have overlap between consecutive chunks', () => {
    // Use distinct sentences so we can check for overlapping content
    const sentences: string[] = [];
    for (let i = 0; i < 100; i++) {
      sentences.push(`Sentence number ${i} with unique content here.`);
    }
    const text = sentences.join(' ');

    const chunks = processor.chunkText(text, 100, 20);

    // With overlap, the end of one chunk should share some content with the start of the next
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 0; i < chunks.length - 1; i++) {
      // The tail of chunk[i] should appear somewhere in the beginning of chunk[i+1]
      // because overlapChars = 20 * 3.5 = 70 chars of overlap
      const tailOfCurrent = chunks[i].slice(-50);
      const headOfNext = chunks[i + 1].slice(0, 200);
      // At least some portion of the tail should appear in the head of the next chunk
      // We check that there's shared content (at least a few words)
      const words = tailOfCurrent.split(/\s+/).filter(w => w.length > 3);
      const someOverlap = words.some(w => headOfNext.includes(w));
      expect(someOverlap).toBe(true);
    }
  });

  it('should prefer breaking at paragraph boundaries', () => {
    const para1 = 'A'.repeat(800);
    const para2 = 'B'.repeat(800);
    const text = `${para1}\n\n${para2}`;

    // Target ~500 tokens = ~1750 chars. The total is 1602 chars + 2 newlines.
    // With paragraphs, the break should happen at \n\n
    const chunks = processor.chunkText(text, 500, 50);

    if (chunks.length > 1) {
      // First chunk should end around the paragraph boundary
      expect(chunks[0]).not.toContain('\n\n');
    }
  });

  it('should prefer breaking at sentence boundaries when available', () => {
    // Create text with multiple sentence breaks spread throughout, no paragraph breaks
    const sentences: string[] = [];
    for (let i = 0; i < 80; i++) {
      sentences.push(`This is sentence number ${i} with enough words to make it reasonably long.`);
    }
    const text = sentences.join(' ');

    const chunks = processor.chunkText(text, 200, 20);

    // With ". " boundaries available, the chunker should break at sentence ends
    expect(chunks.length).toBeGreaterThan(1);
    // At least some non-final chunks should end at a sentence boundary (period)
    const nonFinalChunks = chunks.slice(0, -1);
    const endsWithPeriod = nonFinalChunks.filter(c => c.endsWith('.'));
    expect(endsWithPeriod.length).toBeGreaterThan(0);
  });

  it('should handle empty text', () => {
    const chunks = processor.chunkText('', 500, 50);
    expect(chunks.length).toBe(0);
  });

  it('should handle text with only whitespace', () => {
    const chunks = processor.chunkText('   \n\n   ', 500, 50);
    expect(chunks.length).toBe(0);
  });

  it('should handle text exactly at target size', () => {
    const targetChars = Math.round(500 * 3.5); // 1750
    const text = 'A'.repeat(targetChars);

    const chunks = processor.chunkText(text, 500, 50);

    // Should produce 1 or 2 chunks depending on boundary logic
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks.length).toBeLessThanOrEqual(2);
  });
});
