import { describe, it, expect } from 'vitest';
import type { SkillMetadata } from '@alfred/types';
import { werkzeugeFuerNachricht, zuletztBenutzteWerkzeuge, selectCategories } from '../skill-filter.js';

const meta = (name: string, category: SkillMetadata['category']) => ({ name, category, description: name, riskLevel: 'read', version: '1', inputSchema: { type: 'object', properties: {} } }) as unknown as SkillMetadata;
const ALLE = [meta('memory', 'core'), meta('help', 'core'), meta('todo', 'productivity'), meta('web_search', 'information'), meta('image_generate', 'media')];

// v1472 — Realfall 16.10. 08:47 (Faden mvaln0sl)
const VERLAUF = [
  { role: 'user', content: 'kannst du ein app icon für eine ai app entwerfen', createdAt: '2026-10-16T06:42:39.647Z' },
  { role: 'assistant', content: '', toolCalls: JSON.stringify([{ id: 'a', name: 'image_generate', input: {} }]), createdAt: '2026-10-16T06:43:45.511Z' },
  { role: 'user', content: 'ok', createdAt: '2026-10-16T06:44:26.647Z' },
  { role: 'user', content: 'ja', createdAt: '2026-10-16T06:44:41.077Z' },
  { role: 'assistant', content: '', toolCalls: JSON.stringify([{ id: 'b', name: 'image_generate', input: {} }]), createdAt: '2026-10-16T06:45:44.638Z' },
  { role: 'user', content: 'das ist gut. freigegeben', createdAt: '2026-10-16T06:47:22.462Z' },
  { role: 'assistant', content: '', toolCalls: JSON.stringify([{ id: 'c', name: 'memory', input: {} }]), createdAt: '2026-10-16T06:47:31.446Z' },
  { role: 'user', content: 'oder doch noch dem flutter icon mehr als vorbild', createdAt: '2026-10-16T06:48:26.604Z' },
];

describe('v1472 Werkzeugwahl: zuletzt benutzte Werkzeuge bleiben', () => {
  it('liest Werkzeugnamen aus tool_calls, ohne interne, im Zeitfenster', () => {
    expect(zuletztBenutzteWerkzeuge(VERLAUF, new Date('2026-10-16T06:48:35Z'))).toEqual(['image_generate']);
    expect(zuletztBenutzteWerkzeuge(VERLAUF, new Date('2026-10-16T09:00:00Z'))).toEqual([]);
    expect(zuletztBenutzteWerkzeuge([{ role: 'assistant', toolCalls: 'kaputt' }], new Date())).toEqual([]);
  });

  it('„ja“ im Rückfall behält image_generate', () => {
    const users = VERLAUF.filter(m => m.role === 'user').slice(-3).map(m => m.content);
    const ohne = werkzeugeFuerNachricht('ja', ['das ist gut. freigegeben', 'ja', 'ok'], ALLE);
    expect(ohne.metas.map(m => m.name)).not.toContain('image_generate'); // so war es am 16.10.
    const mit = werkzeugeFuerNachricht('ja', users, ALLE, zuletztBenutzteWerkzeuge(VERLAUF, new Date('2026-10-16T06:48:35Z')));
    expect(mit.metas.map(m => m.name)).toContain('image_generate');
  });

  it('Icon/Logo/Entwurf/Design treffen Medien', () => {
    const verf = new Set(['core', 'media', 'productivity', 'information', 'automation', 'files'] as const);
    for (const t of ['mach ein neues Icon', 'Logo für die Firma', 'entwirf mir was', 'ein Design-Vorschlag', 'zeichne einen Hund']) {
      expect(selectCategories(t, verf as never).has('media')).toBe(true);
    }
  });
});
