import { describe, it, expect } from 'vitest';
import { geminiImageOptions, ImageGenerator } from '../image-generator.js';

describe('geminiImageOptions (v1069)', () => {
  it('mappt gpt-image-Größen auf Gemini-aspectRatio', () => {
    expect(geminiImageOptions('gemini-3.1-flash-image', '1536x1024')).toEqual({ aspectRatio: '3:2' });
    expect(geminiImageOptions('gemini-3.1-flash-image', '1024x1536')).toEqual({ aspectRatio: '2:3' });
    expect(geminiImageOptions('gemini-3.1-flash-image', '1024x1024')).toEqual({ aspectRatio: '1:1' });
    expect(geminiImageOptions('gemini-3.1-flash-image')).toEqual({ aspectRatio: '1:1' });
  });

  it('imageSize nur für Pro-Modelle: high → 2K, sonst 1K', () => {
    expect(geminiImageOptions('gemini-3-pro-image', '1536x1024', 'high')).toEqual({ aspectRatio: '3:2', imageSize: '2K' });
    expect(geminiImageOptions('gemini-3-pro-image', '1024x1024', 'medium')).toEqual({ aspectRatio: '1:1', imageSize: '1K' });
    expect(geminiImageOptions('gemini-3.1-flash-image', '1024x1024', 'high')).toEqual({ aspectRatio: '1:1' }); // flash kennt kein imageSize
  });
});

describe('ImageGenerator-Routing (v1069)', () => {
  const logger = { info: () => {}, warn: () => {}, error: () => {}, child() { return this; } } as never;

  it('gemini-Modell OHNE Google-Key → klare Fehlermeldung (kein stiller OpenAI-Fallback)', async () => {
    const gen = new ImageGenerator({ provider: 'openai', apiKey: 'sk-test' }, logger);
    await expect(gen.generate('ein Stadion', { model: 'gemini-3.1-flash-image' }))
      .rejects.toThrow(/kein Google-API-Key/);
  });

  it('googleKeyProvider-Fehler wird geschluckt → gleiche klare Meldung', async () => {
    const gen = new ImageGenerator({
      provider: 'openai', apiKey: 'sk-test',
      googleKeyProvider: async () => { throw new Error('env kaputt'); },
    }, logger);
    await expect(gen.generate('ein Stadion', { model: 'gemini-3-pro-image' }))
      .rejects.toThrow(/kein Google-API-Key/);
  });
});
