import { describe, expect, it } from 'vitest';
import type { CmdbChangeRequest } from '@alfred/types';
import { standZeilen } from './change-endstand.js';

const change = (id: string, status: string, extra: Partial<CmdbChangeRequest> = {}) => ({ id, status, title: `Titel ${id.slice(0, 3)}`, ...extra }) as unknown as CmdbChangeRequest;

describe('v1971 Endstand der berührten Changes', () => {
  it('Realfall 26.11.: Change war beim Werkzeugaufruf eingereicht, am Ende der Runde abgeschlossen → Zeile mit echter Zeit', async () => {
    const k = new Map([['943b8254-aaaa', { status: 'submitted', titel: 'Open WebUI' }]]);
    const t = await standZeilen(k, async () => change('943b8254-aaaa', 'completed', { completedAt: '2026-11-26T19:22:40.244Z' }));
    expect(t).toContain('943b8254');
    expect(t).toContain('jetzt abgeschlossen um 20:22');
    expect(t).toContain('vorher eingereicht');
  });

  it('unveränderter Status → nichts anhängen', async () => {
    const k = new Map([['c9d5f466-bbbb', { status: 'submitted', titel: 'Node-RED' }]]);
    expect(await standZeilen(k, async () => change('c9d5f466-bbbb', 'submitted'))).toBeUndefined();
  });

  it('nicht lesbar → ausdrücklich sagen statt schweigen', async () => {
    const k = new Map([['89bba438-cccc', { status: 'approved', titel: 'Home Assistant' }]]);
    const t = await standZeilen(k, async () => { throw new Error('DB weg'); });
    expect(t).toContain('Stand nicht lesbar');
  });
});
