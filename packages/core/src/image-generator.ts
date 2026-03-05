import type { Logger } from 'pino';
import type { ImageGeneratorInterface } from '@alfred/skills';

interface ImageGeneratorConfig {
  provider: 'openai' | 'google';
  apiKey: string;
  baseUrl?: string;
}

interface GenerateOptions {
  model?: string;
  size?: '1024x1024' | '1536x1024' | '1024x1536';
  quality?: 'low' | 'medium' | 'high';
}

export class ImageGenerator implements ImageGeneratorInterface {
  constructor(
    private readonly config: ImageGeneratorConfig,
    private readonly logger: Logger,
  ) {}

  async generate(prompt: string, options: GenerateOptions = {}): Promise<{ data: Buffer; mimeType: string }> {
    this.logger.info({ provider: this.config.provider, model: options.model, size: options.size }, 'Generating image');

    if (this.config.provider === 'openai') {
      return this.generateOpenAI(prompt, options);
    }
    return this.generateGoogle(prompt, options);
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
      response_format: 'b64_json',
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
