// Type shims for optional document parsing dependencies.
// These are installed in apps/alfred at runtime.

declare module 'pdf-parse' {
  interface PDFData {
    text: string;
    numpages: number;
    info: Record<string, unknown>;
  }
  function pdfParse(buffer: Buffer): Promise<PDFData>;
  export default pdfParse;
}

declare module 'mammoth' {
  interface ExtractResult {
    value: string;
    messages: unknown[];
  }
  export function extractRawText(options: { path: string }): Promise<ExtractResult>;
}
