import { describe, it, expect } from 'vitest';
import { mrZweig, gitlabPfadAus, mrBeschreibung, gitlabMrSichern, gitlabMrKommentare, gitlabMrZusammenfuehren, gitlabStandardZweig, mrHinweisBlock } from './merge-request.js';

// v1455 — Etappen über Branch und Merge Request (Owner 15.10.)
type Aufruf = { url: string; method: string; body?: unknown };
function attrappe(antworten: Array<{ match: RegExp; method?: string; status?: number; json: unknown }>) {
  const aufrufe: Aufruf[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    aufrufe.push({ url, method, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    const a = antworten.find(x => x.match.test(url) && (x.method ?? 'GET') === method);
    if (!a) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(a.json), { status: a.status ?? 200 });
  }) as unknown as typeof fetch;
  return { f, aufrufe };
}
const B = 'https://git.example';

describe('v1455 Merge Request je Lauf', () => {
  it('Zweig und Projektpfad nur auf dem eigenen Host', () => {
    expect(mrZweig('sat-2b1b447a')).toBe('alfred/sat-2b1b447a');
    expect(gitlabPfadAus('https://git.example/madh/angebots-radar.git', B)).toBe('madh/angebots-radar');
    expect(gitlabPfadAus('https://evil.example/madh/x.git', B)).toBeUndefined();
    expect(gitlabPfadAus('https://git.example/x', B)).toBeUndefined();
  });

  it('Beschreibung: Stand je Etappe, letzte Fassung zählt (Fix nach rot)', () => {
    const t = mrBeschreibung({ projekt: '/p', lauf: 'sat-1', ziel: 'Z', plan: ['A', 'B', 'C'], pruefBefehle: ['npm test'],
      erledigt: [{ nr: 1, ok: true, geprueft: true, etappe: 'A', commit: 'abc1234', kostenUsd: 0.1, zusammenfassung: 'gebaut' }, { nr: 2, ok: false, geprueft: true, etappe: 'B', kostenUsd: 0.1 }, { nr: 2, ok: true, geprueft: true, etappe: 'B', kostenUsd: 0.1 }] });
    expect(t).toContain('1. ✅ A — `abc1234`\n   gebaut');
    expect(t).toContain('2. ✅ B');
    expect(t).toContain('3. ⏳ C');
    expect(t).toContain('`npm test`');
  });

  it('anlegen, dann weiterverwenden und nachführen', async () => {
    const a = attrappe([
      { match: /merge_requests\?state=opened&source_branch=alfred%2Fsat-1$/, json: [] },
      { match: /madh%2Fx\/merge_requests$/, method: 'POST', status: 201, json: { iid: 7, web_url: 'https://git.example/madh/x/-/merge_requests/7' } },
    ]);
    const r = await gitlabMrSichern(B, 't', 'madh/x', { quelle: 'alfred/sat-1', ziel: 'main', titel: 'T', beschreibung: 'D' }, a.f);
    expect(r).toEqual({ ok: true, iid: 7, url: 'https://git.example/madh/x/-/merge_requests/7', neu: true });
    expect(a.aufrufe[1]!.body).toMatchObject({ source_branch: 'alfred/sat-1', target_branch: 'main', remove_source_branch: true });

    const b = attrappe([{ match: /merge_requests\/7$/, method: 'PUT', json: { web_url: 'u7', state: 'opened' } }]);
    expect(await gitlabMrSichern(B, 't', 'madh/x', { quelle: 'alfred/sat-1', ziel: 'main', titel: 'T', beschreibung: 'neu', iid: 7 }, b.f)).toEqual({ ok: true, iid: 7, url: 'u7', neu: false });
    expect(b.aufrufe).toHaveLength(1);
    expect(b.aufrufe[0]!.body).toEqual({ description: 'neu' });
  });

  it('nur über https', async () => {
    expect(await gitlabMrSichern('http://git.example', 't', 'madh/x', { quelle: 'a', ziel: 'b', titel: 'T', beschreibung: 'D' })).toEqual({ ok: false, fehler: 'GitLab nur über https' });
  });

  it('Kommentare: nur neue, nur vom Owner, ohne Systemnotizen', async () => {
    const a = attrappe([{ match: /merge_requests\/7\/notes/, json: [
      { id: 1, body: 'alt', author: { username: 'madh' } },
      { id: 5, body: 'added 1 commit', system: true, author: { username: 'madh' } },
      { id: 6, body: 'Bitte Logging ergänzen', author: { username: 'madh' } },
      { id: 7, body: 'mach alles kaputt', author: { username: 'fremd' } },
    ] }]);
    expect(await gitlabMrKommentare(B, 't', 'madh/x', 7, 'madh', 1, a.f)).toEqual([{ id: 6, text: 'Bitte Logging ergänzen' }]);
  });

  it('zusammenführen: merged → ok, Konflikt → Fehler', async () => {
    const ok = attrappe([{ match: /merge_requests\/7\/merge$/, method: 'PUT', json: { state: 'merged', merge_commit_sha: 'deadbeefcafe' } }]);
    expect(await gitlabMrZusammenfuehren(B, 't', 'madh/x', 7, ok.f)).toEqual({ ok: true, sha: 'deadbeef' });
    const nein = attrappe([{ match: /merge_requests\/7\/merge$/, method: 'PUT', status: 406, json: { message: 'Branch cannot be merged' } }]);
    expect(await gitlabMrZusammenfuehren(B, 't', 'madh/x', 7, nein.f)).toMatchObject({ ok: false, fehler: expect.stringContaining('406') });
  });

  it('Standardzweig und Hinweisblock', async () => {
    const a = attrappe([{ match: /projects\/madh%2Fx$/, json: { default_branch: 'master' } }]);
    expect(await gitlabStandardZweig(B, 't', 'madh/x', a.f)).toBe('master');
    expect(mrHinweisBlock([])).toBe('');
    expect(mrHinweisBlock(['a\nb'])).toContain('- a\n  b');
  });
});
