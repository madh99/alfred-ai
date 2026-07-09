import type { Logger } from 'pino';
import type { ImageGeneratorInterface } from '@alfred/skills';

interface ImageGeneratorConfig {
  provider: 'openai' | 'google';
  apiKey: string;
  baseUrl?: string;
  /** v1069 — lazy Google-Key für gemini-*-Bildmodelle (Nano Banana), unabhängig vom Haupt-Provider. */
  googleKeyProvider?: () => Promise<string | undefined>;
}

interface GenerateOptions {
  model?: string;
  size?: '1024x1024' | '1536x1024' | '1024x1536';
  quality?: 'low' | 'medium' | 'high';
}

/**
 * v1069 — Format-/Qualitäts-Mapping für Gemini-Bildmodelle (pure, testbar):
 * gpt-image-Größen → aspectRatio; image_quality → Auflösung (nur Pro-Modelle
 * unterstützen imageSize).
 */
export function geminiImageOptions(model: string, size?: string, quality?: string): { aspectRatio: string; imageSize?: string } {
  const aspectRatio = size === '1536x1024' ? '3:2' : size === '1024x1536' ? '2:3' : '1:1';
  const imageSize = /-pro-/.test(model) ? (quality === 'high' ? '2K' : '1K') : undefined;
  return { aspectRatio, ...(imageSize ? { imageSize } : {}) };
}

export class ImageGenerator implements ImageGeneratorInterface {
  constructor(
    private readonly config: ImageGeneratorConfig,
    private readonly logger: Logger,
  ) {}

  async generate(prompt: string, options: GenerateOptions = {}): Promise<{ data: Buffer; mimeType: string }> {
    this.logger.info({ provider: this.config.provider, model: options.model, size: options.size }, 'Generating image');

    // v1069 — Routing am Modellnamen: gemini-* (Nano Banana) läuft über die
    // Gemini-API, egal welcher Haupt-Provider konfiguriert ist. Der Key kommt
    // lazy (LLM-Config google oder Kanal-Secret GOOGLE_API_KEY).
    if (options.model && /^gemini-/.test(options.model)) {
      const key = (await this.config.googleKeyProvider?.().catch(() => undefined))
        ?? (this.config.provider === 'google' ? this.config.apiKey : undefined);
      if (!key) {
        throw new Error(`Gemini-Bildmodell „${options.model}" angefordert, aber kein Google-API-Key gefunden (LLM-Config google oder Secret GOOGLE_API_KEY in der Kanal-ENV-Stage).`);
      }
      return this.generateGemini(prompt, options.model, key, options);
    }
    if (this.config.provider === 'openai') {
      return this.generateOpenAI(prompt, options);
    }
    return this.generateGoogle(prompt, options);
  }

  /** v1069 — Nano Banana (gemini-*-image): generateContent mit Bild-Output + imageConfig. */
  private async generateGemini(prompt: string, model: string, apiKey: string, options: GenerateOptions): Promise<{ data: Buffer; mimeType: string }> {
    // @ts-ignore — @google/genai is an optional peer dep (installed at runtime)
    const { GoogleGenAI } = await import('@google/genai');
    const genai = new GoogleGenAI({ apiKey });
    const imageConfig = geminiImageOptions(model, options.size, options.quality);
    const response = await genai.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        responseModalities: ['IMAGE', 'TEXT'],
        imageConfig,
      },
    });
    const parts = response.candidates?.[0]?.content?.parts;
    const imagePart = parts?.find((p: any) => p.inlineData?.mimeType?.startsWith('image/'));
    if (!imagePart?.inlineData) {
      const text = parts?.find((p: any) => typeof p.text === 'string')?.text;
      throw new Error(`Gemini image generation returned no image data${text ? ` (${String(text).slice(0, 150)})` : ''}`);
    }
    let buffer = Buffer.from(imagePart.inlineData.data!, 'base64');
    let mimeType = imagePart.inlineData.mimeType ?? 'image/png';
    // v1070 — auf PNG normalisieren: Gemini liefert JPEG, die nachgelagerte
    // Pipeline (Vision-Gate, studio-*.png-Dateien, Overlays) nimmt PNG an —
    // das Vision-Gate verwarf JPEG-Bytes mit PNG-Etikett fail-closed
    // (Realfall 09.07.). Ohne sharp bleibt JPEG mit EHRLICHEM mimeType.
    if (mimeType !== 'image/png') {
      try {
        const { loadSharp } = await import('@alfred/skills');
        const sharp = await loadSharp();
        if (sharp) {
          const png = await (sharp as unknown as (i: Buffer) => { png(): { toBuffer(): Promise<Buffer> } })(buffer).png().toBuffer();
          buffer = Buffer.from(png);
          mimeType = 'image/png';
        }
      } catch { /* best-effort — ehrlicher mimeType reicht dem Gate (v1070) */ }
    }
    this.logger.info({ model, bytes: buffer.length, mimeType, ...imageConfig }, 'v1069 image generated via Gemini');
    return { data: buffer, mimeType };
  }

  private async generateOpenAI(prompt: string, options: GenerateOptions): Promise<{ data: Buffer; mimeType: string }> {
    // @ts-ignore — openai is an optional peer dep (installed at runtime)
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({
      apiKey: this.config.apiKey,
      ...(this.config.baseUrl && { baseURL: this.config.baseUrl }),
    });

    const model = options.model ?? 'gpt-image-1';
    const response = await client.images.generate({
      model,
      prompt,
      n: 1,
      size: options.size ?? '1024x1024',
      quality: options.quality ?? 'medium',
    } as any);

    const b64 = (response.data?.[0] as any)?.b64_json;
    if (!b64) {
      throw new Error('OpenAI image generation returned no data');
    }

    const buffer = Buffer.from(b64, 'base64');
    this.logger.info({ model, bytes: buffer.length }, 'Image generated via OpenAI');
    return { data: buffer, mimeType: 'image/png' };
  }

  private async generateGoogle(prompt: string, options: GenerateOptions): Promise<{ data: Buffer; mimeType: string }> {
    // @ts-ignore — @google/genai is an optional peer dep (installed at runtime)
    const { GoogleGenAI } = await import('@google/genai');
    const genai = new GoogleGenAI({ apiKey: this.config.apiKey });

    const model = options.model ?? 'gemini-2.0-flash-exp';
    const response = await genai.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        responseModalities: ['IMAGE', 'TEXT'],
      },
    });

    const parts = response.candidates?.[0]?.content?.parts;
    const imagePart = parts?.find((p: any) => p.inlineData?.mimeType?.startsWith('image/'));
    if (!imagePart?.inlineData) {
      throw new Error('Google image generation returned no image data');
    }

    const buffer = Buffer.from(imagePart.inlineData.data!, 'base64');
    const mimeType = imagePart.inlineData.mimeType ?? 'image/png';
    this.logger.info({ model, bytes: buffer.length, mimeType }, 'Image generated via Google');
    return { data: buffer, mimeType };
  }
}
