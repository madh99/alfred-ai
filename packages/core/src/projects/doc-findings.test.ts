import { describe, it, expect } from 'vitest';
import { parseDocFindings } from './session-summarizer.js';

describe('parseDocFindings (v876)', () => {
  it('parses a plain JSON array', () => {
    const raw = JSON.stringify([
      { title: 'BUG-MOD-01: Kommentar-Edit speichert nicht', priority: 'high', description: 'CommentDetailClient.tsx:63-78' },
      { title: 'PN-Suche fehlt', priority: 'normal' },
    ]);
    const r = parseDocFindings(raw)!;
    expect(r).toHaveLength(2);
    expect(r[0].priority).toBe('high');
    expect(r[0].description).toContain('CommentDetailClient');
    expect(r[1].description).toBeUndefined();
  });

  it('strips markdown fences and surrounding prose', () => {
    const raw = 'Hier die Befunde:\n```json\n[{"title":"X fehlt","priority":"low"}]\n```\nFertig.';
    const r = parseDocFindings(raw)!;
    expect(r).toHaveLength(1);
    expect(r[0].title).toBe('X fehlt');
    expect(r[0].priority).toBe('low');
  });

  it('normalizes invalid priority to normal', () => {
    const r = parseDocFindings('[{"title":"A","priority":"urgent"},{"title":"B"}]')!;
    expect(r[0].priority).toBe('normal');
    expect(r[1].priority).toBe('normal');
  });

  it('drops entries without title and caps at 15', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ title: `Punkt ${i + 1}`, priority: 'normal' }));
    const withJunk = [{ priority: 'high' }, { title: '' }, ...many];
    const r = parseDocFindings(JSON.stringify(withJunk))!;
    expect(r).toHaveLength(15);
    expect(r[0].title).toBe('Punkt 1');
  });

  it('returns empty array for documented "keine Befunde"', () => {
    expect(parseDocFindings('[]')).toEqual([]);
  });

  it('returns null for garbage / non-array', () => {
    expect(parseDocFindings('kein json hier')).toBeNull();
    expect(parseDocFindings('{"title":"obj statt array"}')).toBeNull();
    expect(parseDocFindings('[{kaputt')).toBeNull();
  });

  it('caps title at 200 and description at 600 chars', () => {
    const r = parseDocFindings(JSON.stringify([{ title: 'T'.repeat(300), description: 'D'.repeat(800) }]))!;
    expect(r[0].title).toHaveLength(200);
    expect(r[0].description).toHaveLength(600);
  });
});
