import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NetzbetreiberSkill, validiereVorschlag, htmlZuText, baseDomain } from './netzbetreiber.js';
import type { GridSuggestion } from './netzbetreiber.js';

const CTX = { userId: 'u', masterUserId: 'u', platform: 'api', chatId: 'c', conversationId: 'c' } as never;

function htmlResponse(body: string, status = 200): Response {
  return { ok: status < 400, status, text: async () => body, json: async () => JSON.parse(body) } as unknown as Response;
}

describe('netzbetreiber — Helfer (v1133)', () => {
  it('baseDomain: letzte zwei Labels', () => {
    expect(baseDomain('smartmeter.netz-noe.at')).toBe('netz-noe.at');
    expect(baseDomain('www.wienernetze.at')).toBe('wienernetze.at');
  });

  it('htmlZuText: Skripte raus, Entities dekodiert', () => {
    expect(htmlZuText('<script>x()</script><p>Netz N&Ouml; &amp; Co</p>')).toBe('Netz NÖ & Co');
  });
});

describe('validiereVorschlag — harte Garantien (v1133)', () => {
  const kontext = {
    operator: 'AT002000',
    bestand: { website: 'https://www.netz-noe.at', phone: '02742 12345' },
    gelesen: new Set(['https://www.netz-noe.at/', 'https://www.netz-noe.at/smartmeter']),
    siteHost: 'www.netz-noe.at',
  };

  it('gültiger Vorschlag geht durch', () => {
    const v = validiereVorschlag(
      { field: 'smartMeterPortalUrl', value: 'https://smartmeter.netz-noe.at', sourceUrl: 'https://www.netz-noe.at/smartmeter', note: 'Portal-Link' },
      kontext,
    ) as GridSuggestion;
    expect(v.operator).toBe('AT002000');
    expect(v.value).toBe('https://smartmeter.netz-noe.at');
  });

  it('sourceUrl muss eine WIRKLICH gelesene Seite sein (keine erfundenen Belege)', () => {
    const v = validiereVorschlag(
      { field: 'email', value: 'netz@netz-noe.at', sourceUrl: 'https://www.netz-noe.at/erfunden' },
      kontext,
    );
    expect('verworfen' in v && v.verworfen).toContain('sourceUrl');
  });

  it('URL-Felder: fremde Domain und http:// fliegen raus, offizielle Verzeichnisse sind erlaubt', () => {
    expect('verworfen' in validiereVorschlag({ field: 'eegCheckUrl', value: 'https://vergleichsportal.example/check', sourceUrl: 'https://www.netz-noe.at/' }, kontext)).toBe(true);
    expect('verworfen' in validiereVorschlag({ field: 'website', value: 'http://www.netz-noe.at', sourceUrl: 'https://www.netz-noe.at/' }, kontext)).toBe(true);
    const ok = validiereVorschlag({ field: 'eegCheckUrl', value: 'https://www.ebutilities.at/check', sourceUrl: 'https://www.netz-noe.at/' }, kontext);
    expect('verworfen' in ok).toBe(false);
  });

  it('unveränderte Werte und unzulässige Felder werden verworfen', () => {
    expect('verworfen' in validiereVorschlag({ field: 'phone', value: '02742 12345', sourceUrl: 'https://www.netz-noe.at/' }, kontext)).toBe(true);
    expect('verworfen' in validiereVorschlag({ field: 'gridFee', value: '5', sourceUrl: 'https://www.netz-noe.at/' }, kontext)).toBe(true);
  });
});

describe('NetzbetreiberSkill — Ablauf (v1133)', () => {
  let skill: NetzbetreiberSkill;

  beforeEach(() => {
    process.env.ALFRED_GRID_KEY = 'test-key-1234567890abcdef';
    process.env.ALFRED_GRID_BASE_URL = 'https://lokalkraft.test';
    skill = new NetzbetreiberSkill();
  });

  afterEach(() => {
    delete process.env.ALFRED_GRID_KEY;
    delete process.env.ALFRED_GRID_BASE_URL;
  });

  function wireFetch(map: Record<string, string>, onPost?: (body: unknown) => Response) {
    skill.fetchImpl = vi.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
      const u = String(url);
      if (init?.method === 'POST') return onPost ? onPost(JSON.parse(init.body ?? '{}')) : htmlResponse('{"data":{"accepted":0,"rejected":[]}}');
      const hit = Object.entries(map).find(([k]) => u === k || u.startsWith(k));
      return hit ? htmlResponse(hit[1]) : htmlResponse('nicht da', 404);
    }) as unknown as typeof fetch;
  }

  it('check_operators: Recherche → Validierung → POST mit Bearer; Zusammenfassung nennt Annahmen', async () => {
    const posts: unknown[] = [];
    wireFetch({
      'https://lokalkraft.test/netzbetreiber/netz-noe': '<h1>Netz NÖ</h1> AT002000 Website: https://www.netz-noe.test',
      'https://lokalkraft.test/netzbetreiber': '<a href="/netzbetreiber/netz-noe">Netz NÖ</a>',
      'https://www.netz-noe.test': '<a href="/smartmeter">Smart Meter Portal</a> Willkommen beim Netzbetreiber',
      'https://www.netz-noe.test/smartmeter': 'Unser Smart-Meter-Webportal: https://smartmeter.netz-noe.test — Datenfreigabe im Portal.',
    }, body => { posts.push(body); return htmlResponse('{"data":{"accepted":1,"rejected":[]}}'); });
    skill.setLlmCallback(async (prompt: string) => {
      if (prompt.includes('Verzeichnis-Seite')) return '{"name":"Netz NÖ","ecPrefix":"AT002000","website":"https://www.netz-noe.test"}';
      return JSON.stringify([
        { field: 'smartMeterPortalUrl', value: 'https://smartmeter.netz-noe.test', sourceUrl: 'https://www.netz-noe.test/smartmeter', note: 'Webportal' },
        { field: 'email', value: 'x@fremde-domain.test', sourceUrl: 'https://andere-seite.test/' }, // erfundener Beleg → raus
      ]);
    });
    const r = await skill.execute({ action: 'check_operators', operators: ['netz-noe'] }, CTX);
    expect(r.success).toBe(true);
    expect(posts.length).toBe(1);
    const payload = posts[0] as { suggestions: GridSuggestion[] };
    expect(payload.suggestions.length).toBe(1);
    expect(payload.suggestions[0]).toMatchObject({ operator: 'AT002000', field: 'smartMeterPortalUrl', sourceUrl: 'https://www.netz-noe.test/smartmeter' });
    const auth = (skill.fetchImpl as unknown as { mock: { calls: Array<[unknown, { method?: string; headers?: Record<string, string> }]> } }).mock.calls
      .find(c => c[1]?.method === 'POST')?.[1].headers?.Authorization;
    expect(auth).toBe('Bearer test-key-1234567890abcdef');
    expect(r.display).toContain('1 Vorschlag');
  });

  it('dry_run: recherchiert, reicht aber NICHT ein', async () => {
    wireFetch({
      'https://lokalkraft.test/netzbetreiber/netz-noe': 'AT002000',
      'https://lokalkraft.test/netzbetreiber': '<a href="/netzbetreiber/netz-noe">x</a>',
    });
    skill.setLlmCallback(async () => '{"name":"Netz NÖ"}'); // kein website-Feld → Hinweis, keine Recherche
    const r = await skill.execute({ action: 'check_operators', operators: ['netz-noe'], dry_run: true }, CTX);
    expect(r.success).toBe(true);
    expect(r.display).toContain('DRY-RUN');
    const postCalls = (skill.fetchImpl as unknown as { mock: { calls: Array<[unknown, { method?: string }]> } }).mock.calls.filter(c => c[1]?.method === 'POST');
    expect(postCalls.length).toBe(0);
    expect(r.display).toContain('keine Ausgangs-Website');
  });

  it('404 vom Suggestions-Endpunkt = Feature abgeschaltet → Lauf endet mit sprechendem Fehler', async () => {
    wireFetch({
      'https://lokalkraft.test/netzbetreiber/netz-noe': 'AT002000 https://www.netz-noe.test',
      'https://lokalkraft.test/netzbetreiber': '<a href="/netzbetreiber/netz-noe">x</a>',
      'https://www.netz-noe.test': 'Portal https://smartmeter.netz-noe.test',
    }, () => htmlResponse('', 404));
    skill.setLlmCallback(async (prompt: string) => prompt.includes('Verzeichnis-Seite')
      ? '{"ecPrefix":"AT002000","website":"https://www.netz-noe.test"}'
      : '[{"field":"smartMeterPortalUrl","value":"https://smartmeter.netz-noe.test","sourceUrl":"https://www.netz-noe.test/"}]');
    const r = await skill.execute({ action: 'check_operators', operators: ['netz-noe'] }, CTX);
    expect(r.success).toBe(false);
    expect(r.error).toContain('abgeschaltet');
  });

  it('ohne ALFRED_GRID_KEY nur dry_run', async () => {
    delete process.env.ALFRED_GRID_KEY;
    const r = await skill.execute({ action: 'check_operators' }, CTX);
    expect(r.success).toBe(false);
    expect(r.error).toContain('ALFRED_GRID_KEY');
  });

  it('status meldet Bestand + Key-Lage', async () => {
    wireFetch({ 'https://lokalkraft.test/netzbetreiber': '<a href="/netzbetreiber/a-eins">A</a><a href="/netzbetreiber/b-zwei">B</a>' });
    const r = await skill.execute({ action: 'status' }, CTX);
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({ operators: 2, keyConfigured: true });
  });
});
