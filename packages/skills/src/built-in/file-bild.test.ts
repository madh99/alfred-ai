import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileSkill } from './file.js';
import type { SkillContext } from '@alfred/types';

// v1470 — read/read_store geben Bilder „nur fürs Modell“ zurück statt „Binary file“
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b50000000049454e44ae426082', 'hex');

describe('v1470 Datei-Werkzeug: Bilder fürs Modell', () => {
  it('read_store: Bild als Anhang mit nurModell, kein „Binary file“', async () => {
    const store = { read: async () => PNG };
    const ctx = { userId: 'u', masterUserId: 'f165df7a-8689-49b6-9318-41839913846f', fileStore: store } as unknown as SkillContext;
    const r = await new FileSkill().execute({ action: 'read_store', path: 'f165df7a-8689-49b6-9318-41839913846f/2026-10-15T18-21-52-740Z_Screenshot 1.png' }, ctx);
    expect(r.success).toBe(true);
    expect(r.attachments).toHaveLength(1);
    expect(r.attachments![0]).toMatchObject({ fileName: '2026-10-15T18-21-52-740Z_Screenshot 1.png', mimeType: 'image/png', nurModell: true });
    expect(r.display).toContain('NICHT an den Nutzer');
  });

  it('read_store: andere Binärdatei bleibt beim Hinweis', async () => {
    const store = { read: async () => Buffer.from([0, 1, 2, 0]) };
    const ctx = { userId: 'u', fileStore: store } as unknown as SkillContext;
    const r = await new FileSkill().execute({ action: 'read_store', path: 'u/x.bin' }, ctx);
    expect(r.attachments).toBeUndefined();
    expect(r.display).toContain('Binary file');
  });

  it('v1471 list_store ohne Pfad, unter der Master-UUID, neueste zuerst', async () => {
    let gefragt = '';
    const store = { list: async (u: string) => { gefragt = u; return [
      { key: `${u}/a.png`, fileName: 'a.png', userId: u, size: 1, createdAt: '2026-10-14T10:00:00.000Z' },
      { key: `${u}/b.png`, fileName: 'b.png', userId: u, size: 1, createdAt: '2026-10-15T10:00:00.000Z' },
    ]; } };
    const ctx = { userId: 'api-user', masterUserId: 'f165df7a-8689-49b6-9318-41839913846f', fileStore: store } as unknown as SkillContext;
    const r = await new FileSkill().execute({ action: 'list_store' }, ctx);
    expect(r.success).toBe(true);
    expect(gefragt).toBe('f165df7a-8689-49b6-9318-41839913846f');
    expect(r.display!.indexOf('b.png')).toBeLessThan(r.display!.indexOf('a.png'));
  });

  it('read: lokales Bild ebenso', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v1470-'));
    const p = path.join(dir, 'bild.png');
    fs.writeFileSync(p, PNG);
    const r = await new FileSkill().execute({ action: 'read', path: p }, { userId: 'u' } as unknown as SkillContext);
    expect(r.attachments?.[0]).toMatchObject({ fileName: 'bild.png', nurModell: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
