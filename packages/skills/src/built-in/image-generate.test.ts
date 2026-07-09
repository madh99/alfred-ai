import { describe, it, expect, vi } from 'vitest';
import { ImageGenerateSkill } from './image-generate.js';
import type { SkillContext } from '@alfred/types';

const CTX = { userId: 'u1', masterUserId: 'u1', platform: 'api', chatId: 'c1' } as unknown as SkillContext;

describe('ImageGenerateSkill (v1074)', () => {
  it('reicht reference_images als referenceImages an den Generator durch (max. 3, nur Strings)', async () => {
    const generate = vi.fn(async () => ({ data: Buffer.from('png'), mimeType: 'image/png' }));
    const skill = new ImageGenerateSkill({ generate });
    const r = await skill.execute({
      prompt: 'Ein Stadion bei Nacht',
      model: 'gemini-3.1-flash-image',
      reference_images: ['/a.png', 42, '/b.png', '/c.png', '/d.png'],
    }, CTX);
    expect(r.success).toBe(true);
    expect(generate).toHaveBeenCalledWith('Ein Stadion bei Nacht', expect.objectContaining({
      model: 'gemini-3.1-flash-image',
      referenceImages: ['/a.png', '/b.png', '/c.png'], // Nicht-Strings raus, Cap 3
    }));
  });

  it('ohne reference_images: kein referenceImages-Feld (Bestandsverhalten)', async () => {
    const generate = vi.fn(async () => ({ data: Buffer.from('png'), mimeType: 'image/png' }));
    const skill = new ImageGenerateSkill({ generate });
    await skill.execute({ prompt: 'Ball auf Rasen' }, CTX);
    expect((generate.mock.calls as unknown[][])[0][1]).not.toHaveProperty('referenceImages');
  });
});
