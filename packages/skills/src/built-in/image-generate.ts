import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../skill.js';

/** Minimal generator interface to avoid circular dep on @alfred/core. */
export interface ImageGeneratorInterface {
  generate(prompt: string, options?: {
    model?: string;
    size?: '1024x1024' | '1536x1024' | '1024x1536';
    quality?: 'low' | 'medium' | 'high';
  }): Promise<{ data: Buffer; mimeType: string }>;
}

export class ImageGenerateSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'image_generate',
    category: 'media',
    description: 'Generate an image from a text description. Use this tool when the user asks you to create, generate, draw, or design an image or picture. Returns the generated image that will be sent to the user.',
    riskLevel: 'read',
    version: '1.0.0',
    timeoutMs: 120_000,
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Detailed description of the image to generate. Be specific about style, composition, colors, and subject matter.',
        },
        model: {
          type: 'string',
          description: 'Optional model to use (e.g. gpt-image-1, gpt-image-1-mini, gemini-2.0-flash-exp). Uses provider default if omitted.',
        },
        size: {
          type: 'string',
          enum: ['1024x1024', '1536x1024', '1024x1536'],
          description: 'Image dimensions. 1024x1024 (square, default), 1536x1024 (landscape), 1024x1536 (portrait).',
        },
        quality: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Image quality level. Higher quality takes longer and costs more.',
        },
      },
      required: ['prompt'],
    },
  };

  constructor(private readonly generator: ImageGeneratorInterface) {
    super();
  }

  async execute(
    input: Record<string, unknown>,
    _context: SkillContext,
  ): Promise<SkillResult> {
    const prompt = input.prompt as string;
    if (!prompt) {
      return { success: false, error: 'No prompt provided for image generation.' };
    }

    try {
      const result = await this.generator.generate(prompt, {
        model: input.model as string | undefined,
        size: input.size as '1024x1024' | '1536x1024' | '1024x1536' | undefined,
        quality: input.quality as 'low' | 'medium' | 'high' | undefined,
      });

      return {
        success: true,
        display: 'Image generated.',
        attachments: [{
          fileName: 'image.png',
          data: result.data,
          mimeType: result.mimeType,
        }],
      };
    } catch (err) {
      return {
        success: false,
        error: `Image generation failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}
