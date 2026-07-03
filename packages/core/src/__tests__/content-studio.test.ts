import { describe, it, expect, vi } from 'vitest';
import { ContentStudio, nextFreeSlots, parseIdeas, stripMetaLines, decodeHtmlEntities } from '../content-studio.js';
import type { SocialRepository, SocialChannel, ContentItem, InterestsRepository, InsightsRepository } from '@alfred/storage';

const OWNER = 'owner-1';

function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn().mockReturnThis() } as any;
}

function makeChannel(overrides: Partial<SocialChannel> = {}): SocialChannel {
  return {
    id: 'ch-1', userId: OWNER, platform: 'telegram_channel', name: 'FussballCC',
    mode: 'approve', publishMode: 'api', planningHorizonDays: 7,
    postingSlots: ['Mo 18:00', 'Do 18:00'], blacklist: [], maxPostsPerDay: 3,
    approvedStreak: 0, status: 'active', config: { topic_id: 't-1' },
    createdAt: 'x', updatedAt: 'x', ...overrides,
  };
}

describe('nextFreeSlots (v935)', () => {
  // Mi 01.07.2026 12:00 UTC
  const FROM = '2026-07-01T12:00:00.000Z';

  it('liefert kommende Slots im Horizont, sortiert', () => {
    const slots = nextFreeSlots(
      { postingSlots: ['Mo 18:00', 'Do 18:00'], planningHorizonDays: 7 },
      [], 4, FROM,
    );
    // Do 02.07. + Mo 06.07. liegen im 7-Tage-Horizont
    expect(slots).toEqual(['2026-07-02T18:00:00.000Z', '2026-07-06T18:00:00.000Z']);
  });

  it('überspringt bereits belegte Zeitpunkte', () => {
    const slots = nextFreeSlots(
      { postingSlots: ['Do 18:00'], planningHorizonDays: 7 },
      [{ scheduledAt: '2026-07-02T18:00:00.000Z' }], 3, FROM,
    );
    expect(slots).toEqual([]);
  });

  it('ohne konfigurierte Slots: Default Mo/Mi/Fr 18:00', () => {
    const slots = nextFreeSlots({ postingSlots: [], planningHorizonDays: 7 }, [], 10, FROM);
    expect(slots.length).toBe(3); // Fr 03., Mo 06., Mi 08. — Mi 01. 18:00 liegt nach from? 12:00<18:00 → 4? prüfen unten
    expect(slots[0] > FROM).toBe(true);
  });

  it('kaputte Slot-Strings werden ignoriert', () => {
    expect(nextFreeSlots({ postingSlots: ['Blub', '99:99'], planningHorizonDays: 7 }, [], 3, FROM)).toEqual([]);
  });
});

describe('parseIdeas (v935)', () => {
  it('parst Ideen-JSON tolerant (tags-Alias, Limits)', () => {
    const out = parseIdeas('Hier: [{"title":"Derby","body":"Was für ein Spiel im Lokalderby gestern!","tags":["fussball"],"warum":"aktuell"}]');
    expect(out).toEqual([{ title: 'Derby', body: 'Was für ein Spiel im Lokalderby gestern!', hashtags: ['fussball'], warum: 'aktuell' }]);
  });

  it('leere/kaputte Antworten → []; zu kurze bodies gefiltert', () => {
    expect(parseIdeas('KEINE')).toEqual([]);
    expect(parseIdeas('[{"title":"x","body":"kurz"}]')).toEqual([]);
  });

  it('v941: bildidee wird als eigenes Feld geparst (auch image_idea-Alias)', () => {
    const out = parseIdeas('[{"title":"T","body":"Ein ordentlich langer Post-Text hier.","bildidee":"Sechs Team-Wappen im Kreis"}]');
    expect(out[0].bildidee).toBe('Sechs Team-Wappen im Kreis');
    const alias = parseIdeas('[{"title":"T","body":"Ein ordentlich langer Post-Text hier.","image_idea":"Stadion bei Nacht"}]');
    expect(alias[0].bildidee).toBe('Stadion bei Nacht');
  });

  it('v941: „Bildidee:"-Meta-Zeilen werden aus dem body gestrippt (Realfall 03.07.)', () => {
    const out = parseIdeas(JSON.stringify([{
      title: 'Titelfavoriten-Check',
      body: 'Wer holt den Pokal? Spanien und Frankreich vorn.\n\nBildidee: Sechs Team-Wappen im Kreis angeordnet mit Fragezeichen.\n\nEuer Tipp?',
      hashtags: ['WM2026'],
    }]));
    expect(out[0].body).toContain('Wer holt den Pokal?');
    expect(out[0].body).toContain('Euer Tipp?');
    expect(out[0].body).not.toContain('Bildidee');
    expect(out[0].body).not.toContain('Team-Wappen');
  });
});

describe('decodeHtmlEntities (v942)', () => {
  it('dekodiert HTML-Entities in Titel und Body (Realfall „WM-Modus &amp; Format")', () => {
    expect(decodeHtmlEntities('WM-Modus &amp; Format erklärt')).toBe('WM-Modus & Format erklärt');
    expect(decodeHtmlEntities('&lt;b&gt;fett&lt;/b&gt; &quot;zitiert&quot; &#39;x&#39;&nbsp;!')).toBe(`<b>fett</b> "zitiert" 'x' !`);
  });

  it('parseIdeas wendet die Dekodierung auf title UND body an', () => {
    const out = parseIdeas('[{"title":"ÖFB-Rückblick &amp; Rangnick-Ära","body":"Kopf hoch &amp; weiter — ein langer Text hier."}]');
    expect(out[0].title).toBe('ÖFB-Rückblick & Rangnick-Ära');
    expect(out[0].body).toContain('Kopf hoch & weiter');
  });
});

describe('stripMetaLines (v941)', () => {
  it('entfernt Bildidee/Bildvorschlag/Thumbnail-Idee/Image-idea-Zeilen, Rest bleibt', () => {
    const body = 'Zeile 1\nBildidee: X\nBild-Idee: Y\nBildvorschlag: Z\nThumbnail-Idee: W\nImage idea: V\nZeile 2';
    expect(stripMetaLines(body)).toBe('Zeile 1\nZeile 2');
  });

  it('kollabiert entstehende Leerzeilen-Löcher', () => {
    expect(stripMetaLines('A\n\nBildidee: X\n\nB')).toBe('A\n\nB');
  });
});

function makeStack(opts: {
  channel: SocialChannel;
  planned?: ContentItem[];
  llmResponse?: string;
}) {
  const createdItems: ContentItem[] = [];
  const transitions: Array<{ id: string; to: string; at?: string }> = [];
  const socialRepo = {
    listChannels: vi.fn(async () => [opts.channel]),
    listItems: vi.fn(async (_u: string, q: any) => {
      if (q?.status === 'published') return [];
      return opts.planned ?? [];
    }),
    getItem: vi.fn(async () => null),
    createItem: vi.fn(async (_u: string, chId: string, o: any) => {
      const item = { id: `gen-${createdItems.length + 1}`, channelId: chId, userId: OWNER, status: o.status ?? 'draft', body: o.body, title: o.title, media: o.media ?? [], hashtags: o.hashtags ?? [], source: o.source, createdAt: 'x', updatedAt: 'x' } as ContentItem;
      createdItems.push(item);
      return item;
    }),
    transition: vi.fn(async (_u: string, id: string, to: string, extra?: any) => {
      transitions.push({ id, to, at: extra?.scheduledAt });
      return {} as ContentItem;
    }),
    mergePerformance: vi.fn(async () => {}),
    updateChannel: vi.fn(async () => {}),
    listMetrics: vi.fn(async () => []),
    upsertMetric: vi.fn(async () => {}),
  } as unknown as SocialRepository;

  const interestsRepo = {
    getTopicById: vi.fn(async (_u: string, id: string) => ({ id, userId: OWNER, name: 'Fußball NÖ', keywords: [], status: 'active', origin: 'auto', notifyThreshold: 'high', createdAt: 'x' })),
    getDigest: vi.fn(async () => ({ topicId: 't-1', summary: 'Derby-Woche in Niederösterreich.', itemsSinceUpdate: 0, updatedAt: 'x' })),
    listItems: vi.fn(async () => [{ id: 'ti1', topicId: 't-1', title: 'Transfergerücht XY', sourceKind: 'rss', createdAt: 'x' }]),
    findTopicByName: vi.fn(async () => null),
    createTopic: vi.fn(async (_u: string, o: any) => ({ id: 't-new', userId: OWNER, name: o.name, keywords: o.keywords ?? [], status: 'active', origin: o.origin, notifyThreshold: 'high', createdAt: 'x' })),
  } as unknown as InterestsRepository;

  const insightsRepo = { upsertCandidate: vi.fn(async () => ({ inserted: true, id: 'i1' })) } as unknown as InsightsRepository;

  const llm = {
    complete: vi.fn(async () => ({
      content: opts.llmResponse ?? JSON.stringify([
        { title: 'Derby-Recap', body: 'Ein packendes Lokalderby mit spätem Siegtreffer — die Analyse.', hashtags: ['fussball', 'noe'], warum: 'Derby war gestern' },
        { title: 'Transfer-Update', body: 'Was ist dran am Gerücht um XY? Die Fakten im Überblick.', hashtags: ['transfer'], warum: 'Dossier-Thema' },
      ]),
    })),
  } as any;

  const studio = new ContentStudio(socialRepo, interestsRepo, insightsRepo, llm, undefined, undefined, undefined, makeLogger(), OWNER);
  return { studio, socialRepo, interestsRepo, insightsRepo, llm, createdItems, transitions };
}

describe('ContentStudio (v935)', () => {
  it('approve-Modus: erzeugt Entwürfe und terminiert sie in freie Slots', async () => {
    const { studio, createdItems, transitions, llm } = makeStack({ channel: makeChannel({ mode: 'approve' }) });
    const created = await studio.fillChannel(makeChannel({ mode: 'approve' }));
    expect(created).toBe(2);
    expect(createdItems.length).toBe(2);
    expect(createdItems[0].source).toBe('studio');
    expect(transitions.filter(t => t.to === 'scheduled').length).toBe(2);
    expect(transitions[0].at).toBeTruthy();
    // Prompt enthält Dossier-Wissen + Persona-Kontext
    const prompt = (llm.complete as any).mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain('Derby-Woche');
    expect(prompt).toContain('Transfergerücht XY');
  });

  it('suggest-Modus: Entwürfe bleiben draft + EIN stiller Sammel-Insight', async () => {
    const channel = makeChannel({ mode: 'suggest' });
    const { studio, transitions, insightsRepo } = makeStack({ channel });
    const created = await studio.fillChannel(channel);
    expect(created).toBe(2);
    expect(transitions.filter(t => t.to === 'scheduled').length).toBe(0);
    const candidate = (insightsRepo.upsertCandidate as any).mock.calls[0][1];
    expect(candidate.title).toContain('Content-Vorschläge');
    expect(candidate.sourceData.router).toBe(true);
  });

  it('voller Planungshorizont: keine neuen Items, kein LLM-Call', async () => {
    const channel = makeChannel();
    const planned: ContentItem[] = ['2026-07-02T18:00:00.000Z', '2026-07-06T18:00:00.000Z', '2026-07-09T18:00:00.000Z', '2026-07-13T18:00:00.000Z']
      .map((at, i) => ({ id: `p${i}`, channelId: 'ch-1', userId: OWNER, status: 'scheduled', body: 'x', media: [], hashtags: [], source: 'studio', scheduledAt: at, createdAt: 'x', updatedAt: 'x' } as ContentItem));
    const { studio, llm } = makeStack({ channel, planned });
    const created = await studio.fillChannel(channel);
    expect(created).toBe(0);
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it('YouTube-Kanal: Video-Konzept-Prompt (Hook/Script/Beschreibung)', async () => {
    const channel = makeChannel({ platform: 'youtube', postingSlots: ['Fr 15:00'] });
    const { studio, llm } = makeStack({ channel });
    await studio.fillChannel(channel);
    const prompt = (llm.complete as any).mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain('YouTube');
    expect(prompt).toContain('HOOK');
    expect(prompt).toContain('BESCHREIBUNG');
  });

  it('v947: Prompt verlangt vollwertige Beiträge statt Schlagzeilen', async () => {
    const channel = makeChannel();
    const { studio, llm } = makeStack({ channel });
    await studio.fillChannel(channel);
    const prompt = (llm.complete as any).mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain('4-8 Sätzen');
    expect(prompt).toContain('NIEMALS nur Schlagzeile');
  });

  it('Blacklist landet als TABU im Prompt', async () => {
    const channel = makeChannel({ blacklist: ['schiedsrichter'] });
    const { studio, llm } = makeStack({ channel });
    await studio.fillChannel(channel);
    const prompt = (llm.complete as any).mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain('TABU');
    expect(prompt).toContain('schiedsrichter');
  });

  it('v950: symbolic-Policy — Namen geschrubbt, Vision-Verstoß → Retry, 2. Verstoß → kein Bild', async () => {
    const os = await import('node:os');
    const channel = makeChannel({ config: { topic_id: 't-1', generate_images: true } });
    const { studio: base } = makeStack({ channel });
    // Eigener Stack mit Bild-Sandbox + Vision-LLM
    const sandboxCalls: string[] = [];
    const sandbox = {
      execute: vi.fn(async (_s: unknown, input: { prompt: string }) => {
        sandboxCalls.push(input.prompt);
        return { success: true, attachments: [{ fileName: 'image.png', data: Buffer.from('png'), mimeType: 'image/png' }] };
      }),
    };
    const registry = { get: vi.fn(() => ({ metadata: { name: 'image_generate' } })) };
    let llmCall = 0;
    const llm = {
      complete: vi.fn(async (req: any) => {
        llmCall++;
        // Call 1 = Ideen; alle weiteren = Vision-Verdicts (immer Verstoß)
        if (llmCall === 1) {
          return { content: JSON.stringify([{ title: 'Marko Arnautovic tritt ab', body: 'Ein ausführlicher Beitrag über den Rücktritt mit Einordnung und allem Drum und Dran für die Community.', hashtags: ['oefb'], bildidee: 'Marko Arnautovic winkt den Fans' }]) };
        }
        expect(Array.isArray(req.messages[0].content)).toBe(true); // Vision-Call mit Bild-Block
        return { content: '{"person": true, "logo": false, "begruendung": "erkennbarer Spieler"}' };
      }),
    } as any;
    const { ContentStudio } = await import('../content-studio.js');
    const repo = (base as any).socialRepo ?? undefined; // nicht nutzbar — eigener Mini-Repo:
    const createdMedia: unknown[] = [];
    const miniRepo = {
      listItems: vi.fn(async (_u: string, q: any) => (q?.status === 'published' ? [] : [])),
      createItem: vi.fn(async (_u: string, chId: string, o: any) => { createdMedia.push(o.media); return { id: 'g1', channelId: chId, ...o, createdAt: 'x', updatedAt: 'x' }; }),
      transition: vi.fn(async () => ({})),
      mergePerformance: vi.fn(async () => {}),
      updateChannel: vi.fn(async () => {}),
      listMetrics: vi.fn(async () => []),
      upsertMetric: vi.fn(async () => {}),
      listChannels: vi.fn(async () => [channel]),
    } as any;
    const interests = {
      getDigest: vi.fn(async () => null), listItems: vi.fn(async () => []),
      findTopicByName: vi.fn(async () => null), createTopic: vi.fn(async () => ({ id: 't-1' })),
    } as any;
    const studio = new ContentStudio(miniRepo, interests, undefined, llm, registry as any, sandbox as any, undefined, makeLogger(), OWNER, os.tmpdir());

    const created = await studio.fillChannel(channel);
    expect(created).toBe(1);
    // Prompt 1: Name geschrubbt + Policy-Regeln; Prompt 2: strenges Symbolmotiv (Retry)
    expect(sandboxCalls.length).toBe(2);
    expect(sandboxCalls[0]).not.toContain('Arnautovic');
    expect(sandboxCalls[0]).toContain('KEINE realen oder identifizierbaren Personen');
    expect(sandboxCalls[1]).toContain('Symbolbild Fußball');
    // Beide Versuche verletzten die Policy → Post OHNE Bild
    expect(createdMedia[0]).toEqual([]);
    expect(miniRepo.upsertMetric).not.toHaveBeenCalled(); // kein Budget verbraucht ohne Bild
  });

  it('v950: people_ok-Policy überspringt Scrubbing und Vision-Gate', async () => {
    const os = await import('node:os');
    const channel = makeChannel({ config: { topic_id: 't-1', generate_images: true, image_policy: 'people_ok' } });
    const sandbox = { execute: vi.fn(async (_s: unknown, input: { prompt: string }) => ({ success: true, attachments: [{ fileName: 'image.png', data: Buffer.from('png'), mimeType: 'image/png' }] })) };
    const registry = { get: vi.fn(() => ({ metadata: { name: 'image_generate' } })) };
    const llm = {
      complete: vi.fn(async () => ({ content: JSON.stringify([{ title: 'Alaba bleibt', body: 'Ein ausführlicher Beitrag über die Zukunft mit Einordnung und Community-Frage am Ende dabei.', hashtags: ['oefb'], bildidee: 'David Alaba Porträt' }]) })),
    } as any;
    const createdMedia: unknown[] = [];
    const miniRepo = {
      listItems: vi.fn(async () => []),
      createItem: vi.fn(async (_u: string, chId: string, o: any) => { createdMedia.push(o.media); return { id: 'g1', channelId: chId, ...o, createdAt: 'x', updatedAt: 'x' }; }),
      transition: vi.fn(async () => ({})), mergePerformance: vi.fn(async () => {}),
      updateChannel: vi.fn(async () => {}), listMetrics: vi.fn(async () => []),
      upsertMetric: vi.fn(async () => {}), listChannels: vi.fn(async () => [channel]),
    } as any;
    const interests = { getDigest: vi.fn(async () => null), listItems: vi.fn(async () => []), findTopicByName: vi.fn(async () => null), createTopic: vi.fn(async () => ({ id: 't-1' })) } as any;
    const { ContentStudio } = await import('../content-studio.js');
    const studio = new ContentStudio(miniRepo, interests, undefined, llm, registry as any, sandbox as any, undefined, makeLogger(), OWNER, os.tmpdir());

    const created = await studio.fillChannel(channel);
    expect(created).toBe(1);
    // Nur 1 Generierung, Prompt enthält den Namen (Opt-in), KEIN Vision-Call (llm nur 1× für Ideen)
    const prompt = (sandbox.execute as any).mock.calls[0][1].prompt as string;
    expect(prompt).toContain('David Alaba');
    expect(prompt).not.toContain('KEINE realen');
    expect((llm.complete as any).mock.calls.length).toBe(1);
    expect((createdMedia[0] as unknown[]).length).toBe(1);
  });

  it('v951: mehrere verknüpfte Themen → je Topic eine Dossier-Sektion + Verteilungs-Hinweis', async () => {
    const channel = makeChannel({ config: { topic_ids: ['t-1', 't-2'] } });
    const { studio, llm, interestsRepo } = makeStack({ channel });
    (interestsRepo.getTopicById as any) = vi.fn(async (_u: string, id: string) =>
      id === 't-1' ? { id: 't-1', name: 'WM 2026' } : { id: 't-2', name: 'Panini-Sammelalbum' });
    (interestsRepo.getDigest as any) = vi.fn(async (id: string) =>
      id === 't-1' ? { topicId: 't-1', summary: 'Österreich-Aus, Favoriten-Check.', itemsSinceUpdate: 0, updatedAt: 'x' }
        : { topicId: 't-2', summary: 'Neue Sticker-Serie erschienen.', itemsSinceUpdate: 0, updatedAt: 'x' });
    (interestsRepo.listItems as any) = vi.fn(async () => []);

    await studio.fillChannel(channel);
    const prompt = (llm.complete as any).mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain('Thema „WM 2026"');
    expect(prompt).toContain('Thema „Panini-Sammelalbum"');
    expect(prompt).toContain('Verteile die Posts sinnvoll über ALLE obigen Themen');
    // kein Auto-Topic angelegt — Themen sind ja verknüpft
    expect(interestsRepo.createTopic).not.toHaveBeenCalled();
  });

  it('v954: Geschwister-Kanäle derselben Familie → Rollen + Titel + Anti-Doppelungs-Regeln im Prompt', async () => {
    const telegram = makeChannel({ id: 'ch-tg', name: 'FussballCC News', projectId: 'proj-1', persona: 'Community-Kanal: kurz, Termine, Interaktion' });
    const platform = makeChannel({ id: 'ch-cc', name: 'fussball.cc', platform: 'rest', projectId: 'proj-1', persona: 'redaktionelle News' });
    const fremd = makeChannel({ id: 'ch-games', name: 'Games-Kanal', projectId: 'proj-games' });
    const { studio, llm, socialRepo } = makeStack({ channel: telegram });
    (socialRepo.listChannels as any) = vi.fn(async () => [telegram, platform, fremd]);
    (socialRepo.listItems as any) = vi.fn(async (_u: string, q: any) => {
      if (q?.channelId === 'ch-cc') return [{ id: 'x1', channelId: 'ch-cc', title: 'Arnautovic: Die große Analyse', body: '', media: [], hashtags: [], status: 'scheduled', source: 'studio', createdAt: 'x', updatedAt: 'x' }];
      if (q?.status === 'published') return [];
      return [];
    });

    await studio.fillChannel(telegram);
    const prompt = (llm.complete as any).mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain('Kanal-Familie');
    expect(prompt).toContain('fussball.cc');
    expect(prompt).toContain('redaktionelle News');
    expect(prompt).toContain('Arnautovic: Die große Analyse');
    expect(prompt).toContain('KEINE inhaltliche Doppelung');
    expect(prompt).toContain('Cross-Promo');
    // Fremde Familie taucht NICHT auf
    expect(prompt).not.toContain('Games-Kanal');
  });

  it('v954: config.family gruppiert auch ohne Projekt; solo-Kanäle bekommen keine Familien-Sektion', async () => {
    const gamesA = makeChannel({ id: 'g1', name: 'Games YouTube', config: { topic_id: 't-1', family: 'games' } });
    const gamesB = makeChannel({ id: 'g2', name: 'Games Telegram', config: { topic_id: 't-1', family: 'games' } });
    const solo = makeChannel({ id: 's1', name: 'Solo-Kanal', config: { topic_id: 't-1' } });
    const { studio, llm, socialRepo } = makeStack({ channel: gamesA });
    (socialRepo.listChannels as any) = vi.fn(async () => [gamesA, gamesB, solo]);

    await studio.fillChannel(gamesA);
    const prompt1 = (llm.complete as any).mock.calls[0][0].messages[0].content as string;
    expect(prompt1).toContain('Games Telegram');
    expect(prompt1).not.toContain('Solo-Kanal');

    (llm.complete as any).mockClear();
    await studio.fillChannel(solo);
    const prompt2 = (llm.complete as any).mock.calls[0][0].messages[0].content as string;
    expect(prompt2).not.toContain('Kanal-Familie');
  });

  it('ohne topic_id: Interessen-Topic wird auto-angelegt und am Kanal gespeichert', async () => {
    const channel = makeChannel({ config: { niche: 'Amateurfußball NÖ' } });
    const { studio, interestsRepo, socialRepo } = makeStack({ channel });
    await studio.fillChannel(channel);
    expect((interestsRepo.createTopic as any).mock.calls[0][1]).toMatchObject({ name: 'Amateurfußball NÖ', origin: 'auto' });
    expect((socialRepo.updateChannel as any).mock.calls[0][2].config.topic_id).toBe('t-new');
  });
});
