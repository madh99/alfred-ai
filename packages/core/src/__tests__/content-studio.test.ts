import { describe, it, expect, vi } from 'vitest';
import { ContentStudio, nextFreeSlots, parseIdeas, parseEventTime, extractJsonArray, stripMetaLines, decodeHtmlEntities, isNearDuplicateTitle, extractTrailingHashtags } from '../content-studio.js';
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

describe('nextFreeSlots (v935/v959 — Server-Ortszeit)', () => {
  // Mi 01.07.2026 12:00 LOKAL — v959: Slots gelten in Server-Ortszeit, nicht UTC
  // (Realfall: „Mo 18:00" wurde auf dem Europe/Vienna-Host um 20:00 gepostet).
  const FROM = new Date(2026, 6, 1, 12, 0).toISOString();
  const local = (day: number, hour: number, minute = 0) => new Date(2026, 6, day, hour, minute).toISOString();

  it('liefert kommende Slots im Horizont, sortiert — in Ortszeit', () => {
    const slots = nextFreeSlots(
      { postingSlots: ['Mo 18:00', 'Do 18:00'], planningHorizonDays: 7 },
      [], 4, FROM,
    );
    // Do 02.07. + Mo 06.07. liegen im 7-Tage-Horizont
    expect(slots).toEqual([local(2, 18), local(6, 18)]);
  });

  it('überspringt bereits belegte Zeitpunkte', () => {
    const slots = nextFreeSlots(
      { postingSlots: ['Do 18:00'], planningHorizonDays: 7 },
      [{ scheduledAt: local(2, 18) }], 3, FROM,
    );
    expect(slots).toEqual([]);
  });

  it('v959: ohne konfigurierte Slots gelten Plattform-Best-Practices inkl. Wochenende', () => {
    const slots = nextFreeSlots({ postingSlots: [], planningHorizonDays: 7, platform: 'telegram_channel' }, [], 10, FROM);
    // Do 02.07. 18:30, Sa 04.07. 10:00, So 05.07. 19:00, Di 07.07. 12:00
    expect(slots).toEqual([local(2, 18, 30), local(4, 10), local(5, 19), local(7, 12)]);
    // Wochenende ist abgedeckt
    expect(slots.some(s => [0, 6].includes(new Date(s).getDay()))).toBe(true);
  });

  it('v959: unbekannte Plattform → Fallback-Slots inkl. Sonntag', () => {
    const slots = nextFreeSlots({ postingSlots: [], planningHorizonDays: 7 }, [], 10, FROM);
    // Mi 01. 18:00, Fr 03. 18:00, So 05. 10:00, Mo 06. 18:00 (Mi 08. 18:00 > Horizont-Ende Mi 08. 12:00)
    expect(slots).toEqual([local(1, 18), local(3, 18), local(5, 10), local(6, 18)]);
  });

  it('v959: User-Slots überstimmen Best-Practice', () => {
    const slots = nextFreeSlots({ postingSlots: ['Fr 09:00'], planningHorizonDays: 7, platform: 'telegram_channel' }, [], 10, FROM);
    expect(slots).toEqual([local(3, 9)]);
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

describe('extractTrailingHashtags (v961)', () => {
  it('Realfall: Hashtag-Lauf nach der Community-Frage wird abgetrennt', () => {
    const { body, tags } = extractTrailingHashtags('Wie hat euch das Match gefallen? #ÖFB #Spanien #Turnier');
    expect(body).toBe('Wie hat euch das Match gefallen?');
    expect(tags).toEqual(['#ÖFB', '#Spanien', '#Turnier']);
  });

  it('Realfall: reine Hashtag-Schlusszeile wird entfernt (auch nach Leerzeile)', () => {
    const { body, tags } = extractTrailingHashtags('Stolz auf das Team.\n\nDanke, Burschen. ❤️\n\n#FussballCC #WM2026 #Österreich');
    expect(body).toBe('Stolz auf das Team.\n\nDanke, Burschen. ❤️');
    expect(tags).toEqual(['#FussballCC', '#WM2026', '#Österreich']);
  });

  it('einzelner, in den Satz integrierter Hashtag bleibt stehen', () => {
    const { body, tags } = extractTrailingHashtags('Wir sind stolz auf das #Nationalteam');
    expect(body).toBe('Wir sind stolz auf das #Nationalteam');
    expect(tags).toEqual([]);
  });

  it('Hashtag mitten im Text bleibt unangetastet', () => {
    const input = 'Das #ÖFB-Team kämpft weiter.\nMorgen geht es los.';
    expect(extractTrailingHashtags(input)).toEqual({ body: input, tags: [] });
  });

  it('Schlusszeile UND Lauf davor werden beide eingesammelt', () => {
    const { body, tags } = extractTrailingHashtags('Was denkt ihr? #Alaba #ÖFB\n#Zukunft #Nationalteam');
    expect(body).toBe('Was denkt ihr?');
    expect(tags).toEqual(['#Alaba', '#ÖFB', '#Zukunft', '#Nationalteam']);
  });
});

describe('parseIdeas — Hashtag-Bereinigung (v961)', () => {
  it('Body-Hashtags werden abgetrennt und ohne Duplikate ins Feld gemergt', () => {
    const out = parseIdeas(JSON.stringify([{
      title: 'Spanien schickt Österreich nach Hause',
      body: 'Ein bitterer Abend für das Nationalteam. Wie hat euch das Match gefallen? #ÖFB #Spanien #Turnier',
      hashtags: ['#ÖFB', '#Spanien', '#Ausscheiden'],
    }]));
    expect(out[0].body).toBe('Ein bitterer Abend für das Nationalteam. Wie hat euch das Match gefallen?');
    expect(out[0].hashtags).toEqual(['#ÖFB', '#Spanien', '#Ausscheiden', '#Turnier']);
  });

  it('Dedup ist case-insensitiv und ignoriert das #-Präfix', () => {
    const out = parseIdeas(JSON.stringify([{
      title: 'T', body: 'Ein ausreichend langer Text für den Filter. #WM2026 #Österreich', hashtags: ['wm2026'],
    }]));
    expect(out[0].hashtags).toEqual(['wm2026', '#Österreich']);
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
      // v973 — published/rejected-Sperrlisten-Abfragen liefern hier leer
      if (q?.status === 'published' || q?.status === 'rejected') return [];
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
    reschedule: vi.fn(async () => true),
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

  it('v971: kein 10er-Deckel mehr — Batches füllen den Horizont (Realfall: 11 Slots/Woche → „1 neuer Entwurf")', async () => {
    const channel = makeChannel({
      postingSlots: ['Mo 08:00', 'Mo 12:00', 'Di 08:00', 'Di 12:00', 'Mi 08:00', 'Mi 12:00', 'Do 08:00', 'Do 12:00', 'Fr 08:00', 'Fr 12:00', 'Sa 08:00', 'Sa 12:00', 'So 08:00', 'So 12:00'],
      planningHorizonDays: 7,
    });
    const { studio, llm, createdItems } = makeStack({ channel });
    let n = 0;
    (llm.complete as any).mockImplementation(async () => ({
      content: JSON.stringify(Array.from({ length: 8 }, () => {
        n++;
        return { title: `Exklusivthema${n}`, body: `Ein ausreichend langer Beitrag Nummer ${n} mit Substanz, Kontext und einer Frage an die Community?`, hashtags: ['wm'] };
      })),
    }));
    const created = await studio.fillChannel(channel);
    expect(created).toBeGreaterThan(10); // alter Deckel: hart 10 offene Items je Kanal
    expect(createdItems.length).toBe(created);
    expect((llm.complete as any).mock.calls.length).toBeGreaterThan(1); // Batches
  });

  it('v971: Batch-Schleife stoppt, wenn nur noch Duplikate kommen', async () => {
    const channel = makeChannel({ postingSlots: ['Mo 08:00', 'Di 08:00', 'Mi 08:00', 'Do 08:00', 'Fr 08:00', 'Sa 08:00', 'So 08:00'], planningHorizonDays: 14 });
    const { studio, llm } = makeStack({ channel }); // Mock liefert IMMER dieselben 2 Ideen
    const created = await studio.fillChannel(channel);
    expect(created).toBe(2); // Runde 2 liefert nur Duplikate → Abbruch statt Endlosschleife
    expect((llm.complete as any).mock.calls.length).toBe(2);
  });

  it('voller Planungshorizont: keine neuen Items, kein LLM-Call', async () => {
    const channel = makeChannel();
    // Alle freien Slots des Horizonts sind bereits belegt (TZ-agnostisch berechnet)
    const planned: ContentItem[] = nextFreeSlots(channel, [], 10, new Date().toISOString())
      .map((at, i) => ({ id: `p${i}`, channelId: 'ch-1', userId: OWNER, status: 'scheduled', body: 'x', media: [], hashtags: [], source: 'studio', scheduledAt: at, createdAt: 'x', updatedAt: 'x' } as ContentItem));
    const { studio, llm } = makeStack({ channel, planned });
    const created = await studio.fillChannel(channel);
    expect(created).toBe(0);
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it('v959: replanChannel verteilt geplante Beiträge in die aktuellen Slots (Reihenfolge bleibt)', async () => {
    const channel = makeChannel({ postingSlots: ['Sa 10:00', 'So 19:00'] });
    const { studio, socialRepo } = makeStack({ channel });
    const mk = (id: string, at: string) => ({ id, channelId: 'ch-1', userId: OWNER, status: 'scheduled', body: 'x', media: [], hashtags: [], source: 'studio', scheduledAt: at, createdAt: 'x', updatedAt: 'x' } as ContentItem);
    // Alt-Termine liegen NICHT auf den neuen Slots (z.B. nach Slot-Änderung); s2 ist früher als s1
    const scheduled = [mk('s1', '2099-01-08T18:00:00.000Z'), mk('s2', '2099-01-06T18:00:00.000Z')];
    (socialRepo.listItems as any).mockImplementation(async (_u: string, q: any) => (q?.status === 'scheduled' ? scheduled : []));
    const moved = await studio.replanChannel(channel);
    expect(moved).toBe(2);
    const calls = (socialRepo.reschedule as any).mock.calls;
    // frühester Alt-Termin bekommt den frühesten neuen Slot
    expect(calls[0][1]).toBe('s2');
    expect(calls[1][1]).toBe('s1');
    // neue Termine liegen ausschließlich auf Sa/So (Ortszeit)
    for (const c of calls) expect([0, 6]).toContain(new Date(c[2] as string).getDay());
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

  it('v957: isNearDuplicateTitle erkennt den Alaba-Realfall, lässt Verschiedenes durch', () => {
    const existing = ['Alaba lässt Zukunft im Nationalteam offen', 'Arnautovic: Schluss mit Nationalteam'];
    expect(isNearDuplicateTitle('Alaba lässt Zukunft im Nationalteam offen', existing)).toBe(true);
    expect(isNearDuplicateTitle('Alaba-Zukunft im Nationalteam weiter offen', existing)).toBe(true);
    expect(isNearDuplicateTitle('Panini-Tauschbörse: Die gefragtesten Sticker', existing)).toBe(false);
    expect(isNearDuplicateTitle('Spaniens Presse feiert den Sieg', existing)).toBe(false);
  });

  it('v957: Ideen mit Geschwister-Doppelung werden deterministisch verworfen', async () => {
    const telegram = makeChannel({ id: 'ch-tg', name: 'FussballCC News', projectId: 'proj-1' });
    const platform = makeChannel({ id: 'ch-cc', name: 'fussball.cc', platform: 'rest', projectId: 'proj-1' });
    const { studio, socialRepo, createdItems } = makeStack({
      channel: telegram,
      llmResponse: JSON.stringify([
        { title: 'Alaba lässt Zukunft im Nationalteam offen', body: 'Ein ausführlicher Beitrag über die offene Zukunft mit allem Drum und Dran.', hashtags: ['alaba'], warum: 'x' },
        { title: 'Panini-Tauschbörse boomt', body: 'Ein ausführlicher Beitrag über die Tauschbörse mit Community-Frage am Ende.', hashtags: ['panini'], warum: 'y' },
      ]),
    });
    (socialRepo.listChannels as any) = vi.fn(async () => [telegram, platform]);
    (socialRepo.listItems as any) = vi.fn(async (_u: string, q: any) => {
      if (q?.channelId === 'ch-cc') return [{ id: 'x1', channelId: 'ch-cc', title: 'Alaba lässt Zukunft im Nationalteam offen', body: '', media: [], hashtags: [], status: 'scheduled', source: 'studio', createdAt: 'x', updatedAt: 'x' }];
      return [];
    });

    const created = await studio.fillChannel(telegram);
    expect(created).toBe(1); // Alaba-Doppelung verworfen, nur Panini bleibt
    expect(createdItems.length).toBe(1);
    expect(createdItems[0].title).toContain('Panini');
  });

  it('v958: Doppelungen INNERHALB eines Batches werden verworfen (Realfall 2× Einzelkritik)', async () => {
    const channel = makeChannel();
    const { studio, createdItems } = makeStack({
      channel,
      llmResponse: JSON.stringify([
        { title: 'Einzelkritik im Blick: ÖFB-Spieler analysiert', body: 'Ein ausführlicher Beitrag über die Einzelkritik mit allen Details und Einordnung.', hashtags: ['oefb'], warum: 'x' },
        { title: 'Noten für die ÖFB-Spieler: Wie war eure Einzelkritik?', body: 'Ein weiterer ausführlicher Beitrag zur Einzelkritik mit Community-Frage am Ende.', hashtags: ['oefb'], warum: 'y' },
        { title: 'Panini-Tauschbörse: Diese Sticker sind heiß begehrt', body: 'Ein ausführlicher Beitrag über die Tauschbörse mit konkreten Beispielen und Frage.', hashtags: ['panini'], warum: 'z' },
      ]),
    });
    const created = await studio.fillChannel(channel);
    expect(created).toBe(2); // zweite Einzelkritik im selben Batch verworfen
    expect(createdItems.map(i => i.title)).toEqual([
      'Einzelkritik im Blick: ÖFB-Spieler analysiert',
      'Panini-Tauschbörse: Diese Sticker sind heiß begehrt',
    ]);
  });

  it('v955: Fakten-Regel + Kanal-Lektionen landen im Prompt', async () => {
    const channel = makeChannel({ config: { topic_id: 't-1', lessons: ['Es ist die WM 2026, nicht die EM — auch in Hashtags.'] } });
    const { studio, llm } = makeStack({ channel });
    await studio.fillChannel(channel);
    const prompt = (llm.complete as any).mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain('FAKTEN-TREUE');
    expect(prompt).toContain('NIEMALS aus dem Trainingswissen');
    expect(prompt).toContain('KORREKTUREN AUS DER VERGANGENHEIT');
    expect(prompt).toContain('WM 2026, nicht die EM');
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
    const llm = {
      // v971 — Ideen-Calls haben String-Content, Vision-Calls einen Bild-Block:
      // an der Request-Form unterscheiden (Batch-Schleife ruft Ideen mehrfach ab;
      // Runde 2 liefert dieselbe Idee → Dedup beendet die Schleife)
      complete: vi.fn(async (req: any) => {
        if (typeof req.messages[0].content === 'string') {
          return { content: JSON.stringify([{ title: 'Marko Arnautovic tritt ab', body: 'Ein ausführlicher Beitrag über den Rücktritt mit Einordnung und allem Drum und Dran für die Community.', hashtags: ['oefb'], bildidee: 'Marko Arnautovic winkt den Fans' }]) };
        }
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
    // Nur 1 Generierung, Prompt enthält den Namen (Opt-in), KEIN Vision-Call
    // (v971: LLM-Calls sind Ideen-Batches — Runde 2 liefert dieselbe Idee, Dedup bricht ab;
    // entscheidend ist, dass KEIN Call ein Vision-Call mit Bild-Block ist)
    const prompt = (sandbox.execute as any).mock.calls[0][1].prompt as string;
    expect(prompt).toContain('David Alaba');
    expect(prompt).not.toContain('KEINE realen');
    for (const call of (llm.complete as any).mock.calls) {
      expect(typeof call[0].messages[0].content).toBe('string'); // nie Vision (Bild-Block)
    }
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
    // v956 — Realfall: Telegram versprach nicht existierende fussball.cc-Analysen
    expect(prompt).toContain('QUERVERWEISE NUR AUF EXISTIERENDES');
    expect(prompt).toContain('NIEMALS Inhalte versprechen');
    // v957 — Realfall: fussball.cc-Post verwies auf fussball.cc selbst
    expect(prompt).toContain('NIE auf den EIGENEN Kanal');
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

describe('parseIdeas — Format-Reparatur (v978)', () => {
  it('Realfall 04.07.: deutsches Zitat mit ASCII-Schließzeichen bricht das JSON nicht mehr', () => {
    const broken = '```json\n[{"title": "Klopp zum DFB", "body": "Der Coach fühlt sich nach eigener Aussage „mehr als aufgetankt" und offen für die Aufgabe. Die Gespräche laufen weiter ohne Zeitdruck dabei.", "hashtags": ["Klopp"], "warum": "aktuell"}]\n```';
    const out = parseIdeas(broken);
    expect(out.length).toBe(1);
    expect(out[0].body).toContain('„mehr als aufgetankt“');
  });

  it('Prosa mit Klammern vor und nach dem Array stört den Parse nicht', () => {
    const noisy = 'Hier die Posts [Stand 04.07.]:\n[{"title": "T", "body": "Ein ausreichend langer Beitragstext für den Filter hier.", "hashtags": []}]\nHinweis: [terminBis] wurde gesetzt.';
    expect(parseIdeas(noisy).length).toBe(1);
  });

  it('extractJsonArray: sauberes gefenctes JSON wie bisher', () => {
    expect(extractJsonArray('```json\n[1, 2, [3]]\n```')).toEqual([1, 2, [3]]);
    expect(extractJsonArray('kein array hier')).toBeNull();
  });

  it('v980: abgeschnittene Antwort (maxTokens) — vollständige Objekte werden gerettet', () => {
    const truncated = '```json\n[{"title": "Erster", "body": "Ein ausreichend langer Beitragstext für den Filter hier drin.", "hashtags": []}, {"title": "Zweiter", "body": "Auch dieser Text ist lang genug für den Body-Filter im Parser.", "hashtags": []}, {"title": "Abgeschnitten", "body": "Dieser Text endet mitt';
    const out = parseIdeas(truncated);
    expect(out.map(i => i.title)).toEqual(['Erster', 'Zweiter']);
  });
});

describe('ContentStudio — Modell-Tier je Kanal (v979)', () => {
  it('config.model_tier steuert das LLM-Tier der Content-Erzeugung', async () => {
    const channel = makeChannel({ config: { topic_id: 't-1', model_tier: 'medium' } });
    const { studio, llm } = makeStack({ channel });
    await studio.fillChannel(channel);
    expect((llm.complete as any).mock.calls[0][0].tier).toBe('medium');
  });

  it('ohne bzw. mit ungültigem model_tier bleibt fast (Default unverändert)', async () => {
    const plain = makeChannel({});
    const { studio, llm } = makeStack({ channel: plain });
    await studio.fillChannel(plain);
    expect((llm.complete as any).mock.calls[0][0].tier).toBe('fast');

    const invalid = makeChannel({ config: { topic_id: 't-1', model_tier: 'turbo' } });
    const { studio: s2, llm: llm2 } = makeStack({ channel: invalid });
    await s2.fillChannel(invalid);
    expect((llm2.complete as any).mock.calls[0][0].tier).toBe('fast');
  });
});

describe('ContentStudio — Batch-Resilienz (v978)', () => {
  it('unparsebarer erster Batch beendet den Lauf nicht — nächste Runde liefert', async () => {
    const channel = makeChannel({ mode: 'approve' });
    const { studio, llm, createdItems } = makeStack({ channel });
    (llm.complete as any)
      .mockResolvedValueOnce({ content: 'Sorry, hier ist Prosa statt JSON — kein Array weit und breit.' })
      .mockResolvedValueOnce({ content: JSON.stringify([
        { title: 'Zweite Runde', body: 'Ein vollwertiger Beitrag aus dem zweiten LLM-Wurf mit genug Substanz.', hashtags: [], warum: 'x' },
      ]) });
    const created = await studio.fillChannel(channel);
    expect(created).toBeGreaterThanOrEqual(1);
    expect(createdItems.some(i => i.title === 'Zweite Runde')).toBe(true);
  });
});

describe('ContentStudio — Termin-Ankündigungen (v975)', () => {
  // Realfall Public Viewing: Event-Titel tragen den Termin, der Ort steht in
  // der summary („Dublin Irish Pub, Wien") — beides muss beim LLM ankommen.
  const EVENT_LOCAL = new Date(2099, 6, 4, 19, 0); // 04.07.2099 19:00 Server-Ortszeit
  const EVENT_ISO = EVENT_LOCAL.toISOString();
  const EVENT_ITEM = {
    id: 'ev1', topicId: 't-1', title: 'Kanada - Marokko – Canada – Morocco – 04.07.2099, 19:00',
    summary: 'Dublin Irish Pub, Wien', sourceKind: 'events', createdAt: '2026-01-01',
  };

  it('parseEventTime: Termin aus Event-Titel, Server-Ortszeit wie nextFreeSlots', () => {
    expect(parseEventTime(EVENT_ITEM.title)).toBe(EVENT_ISO);
    expect(parseEventTime('Kein Termin hier')).toBeNull();
  });

  it('Dossier: Event überlebt den News-Strom (eigene Termin-Sektion mit ORT und ISO), News auf 8 gekappt', async () => {
    const channel = makeChannel({});
    const { studio, llm, interestsRepo } = makeStack({ channel });
    const news = Array.from({ length: 9 }, (_, i) => ({
      id: `n${i}`, topicId: 't-1', title: `News-Story Nummer ${i + 1}`, sourceKind: 'rss', createdAt: 'x',
    }));
    // Event ist das ÄLTESTE Item — im alten News-Strom wäre es längst verdrängt
    (interestsRepo.listItems as any) = vi.fn(async () => [...news, EVENT_ITEM]);

    await studio.fillChannel(channel);
    const prompt = (llm.complete as any).mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain('KOMMENDE TERMINE');
    expect(prompt).toContain('Ort: Dublin Irish Pub, Wien');
    expect(prompt).toContain(`[terminBis: ${EVENT_ISO}]`);
    expect(prompt).toContain('TERMIN-ANKÜNDIGUNGEN');
    expect(prompt).toContain('News-Story Nummer 8');
    expect(prompt).not.toContain('News-Story Nummer 9'); // News-Kappe bleibt bei 8
  });

  it('Termin-Idee bekommt den SPÄTESTEN Slot vor dem Anpfiff; terminBis wird persistiert', async () => {
    const channel = makeChannel({ mode: 'approve', postingSlots: ['Mo 18:00', 'Do 18:00'] });
    const { studio, createdItems, transitions, socialRepo } = makeStack({
      channel,
      llmResponse: JSON.stringify([
        { title: 'Public Viewing: Kanada gegen Marokko', body: 'Kommt vorbei — wir schauen das Match gemeinsam im Dublin Irish Pub in Wien!', hashtags: ['pv'], warum: 'Termin', terminBis: EVENT_ISO },
        { title: 'Transfer-Update', body: 'Was ist dran am Gerücht um XY? Die Fakten im Überblick und die Einordnung.', hashtags: ['transfer'], warum: 'Dossier' },
      ]),
    });
    const created = await studio.fillChannel(channel);
    expect(created).toBe(2);
    const terminItem = createdItems.find(i => i.title?.includes('Public Viewing'))!;
    const terminSlot = transitions.find(t => t.id === terminItem.id)!.at!;
    const normalSlot = transitions.find(t => t.id !== terminItem.id)!.at!;
    // Termin weit außerhalb des Horizonts → spätester Horizont-Slot; normale Idee bekommt den frühesten
    expect(terminSlot < EVENT_ISO).toBe(true);
    expect(terminSlot > normalSlot).toBe(true);
    const perf = (socialRepo.mergePerformance as any).mock.calls.find((c: any[]) => c[1] === terminItem.id)![2];
    expect(perf.terminBis).toBe(EVENT_ISO);
  });

  it('kein freier Slot vor dem Termin → Termin-Idee wird verworfen, normale Ideen laufen weiter', async () => {
    const pastTermin = new Date().toISOString(); // alle Slots liegen NACH jetzt
    const channel = makeChannel({ mode: 'approve' });
    const { studio, createdItems } = makeStack({
      channel,
      llmResponse: JSON.stringify([
        { title: 'Public Viewing heute', body: 'Kurzfristige Ankündigung für das heutige Match im Pub — kommt vorbei!', hashtags: [], warum: 'Termin', terminBis: pastTermin },
        { title: 'Transfer-Update', body: 'Was ist dran am Gerücht um XY? Die Fakten im Überblick und die Einordnung.', hashtags: [], warum: 'Dossier' },
      ]),
    });
    await studio.fillChannel(channel);
    expect(createdItems.some(i => i.title === 'Public Viewing heute')).toBe(false);
    expect(createdItems.some(i => i.title === 'Transfer-Update')).toBe(true);
  });

  it('bereits angekündigter Termin (performance.terminBis) sperrt Idee UND Dossier-Zeile', async () => {
    const channel = makeChannel({ mode: 'approve' });
    const announced: ContentItem = {
      id: 'old-pv', channelId: 'ch-1', userId: OWNER, status: 'scheduled', title: 'Public Viewing: Kanada gegen Marokko',
      body: 'Wir schauen gemeinsam im Dublin Irish Pub!', hashtags: [], media: [], source: 'studio',
      performance: { terminBis: EVENT_ISO }, createdAt: 'x', updatedAt: 'x',
    } as unknown as ContentItem;
    const { studio, llm, createdItems, interestsRepo } = makeStack({
      channel, planned: [announced],
      llmResponse: JSON.stringify([
        { title: 'Public Viewing: Match im Pub', body: 'Kommt zum gemeinsamen Schauen ins Pub — Anpfiff am Abend, wir freuen uns!', hashtags: [], warum: 'Termin', terminBis: EVENT_ISO },
      ]),
    });
    (interestsRepo.listItems as any) = vi.fn(async () => [EVENT_ITEM]);

    const created = await studio.fillChannel(channel);
    const prompt = (llm.complete as any).mock.calls[0][0].messages[0].content as string;
    expect(prompt).not.toContain('KOMMENDE TERMINE'); // Dossier bietet den Termin nicht erneut an
    expect(created).toBe(0);
    expect(createdItems.length).toBe(0);
  });

  it('v977: Ad-hoc-Slot — voller/slotloser Kanal legt Termin trotzdem an (Anpfiff − Vorlauf)', async () => {
    // Unparsebare Slots → Raster leer → needed=0: ohne Termin-Vorrang liefe hier gar nichts
    const channel = makeChannel({ mode: 'approve', postingSlots: ['Zz 99:99'] });
    const { studio, llm, createdItems, transitions, interestsRepo } = makeStack({
      channel,
      llmResponse: JSON.stringify([
        { title: 'Public Viewing: Kanada gegen Marokko', body: 'Wir schauen das Match gemeinsam im Dublin Irish Pub in Wien — kommt vorbei!', hashtags: [], warum: 'Termin', terminBis: EVENT_ISO },
      ]),
    });
    (interestsRepo.listItems as any) = vi.fn(async () => [EVENT_ITEM]);

    const created = await studio.fillChannel(channel);
    expect(created).toBe(1);
    expect(createdItems[0].title).toContain('Public Viewing');
    const slot = transitions.find(t => t.to === 'scheduled')!.at!;
    expect(slot).toBe(new Date(Date.parse(EVENT_ISO) - 3 * 3_600_000).toISOString()); // Default-Vorlauf 3h
    expect((llm.complete as any).mock.calls.length).toBe(1);
  });

  it('v977: config.termin_lead_hours übersteuert den Ad-hoc-Vorlauf', async () => {
    const channel = makeChannel({ mode: 'approve', postingSlots: ['Zz 99:99'], config: { topic_id: 't-1', termin_lead_hours: 6 } });
    const { studio, transitions, interestsRepo } = makeStack({
      channel,
      llmResponse: JSON.stringify([
        { title: 'Public Viewing: Kanada gegen Marokko', body: 'Wir schauen das Match gemeinsam im Dublin Irish Pub in Wien — kommt vorbei!', hashtags: [], warum: 'Termin', terminBis: EVENT_ISO },
      ]),
    });
    (interestsRepo.listItems as any) = vi.fn(async () => [EVENT_ITEM]);
    await studio.fillChannel(channel);
    expect(transitions.find(t => t.to === 'scheduled')!.at).toBe(new Date(Date.parse(EVENT_ISO) - 6 * 3_600_000).toISOString());
  });

  it('v977: voller Kanal OHNE Termine generiert weiterhin nichts (kein LLM-Call)', async () => {
    const channel = makeChannel({ mode: 'approve', postingSlots: ['Zz 99:99'] });
    const { studio, llm, interestsRepo } = makeStack({ channel });
    (interestsRepo.listItems as any) = vi.fn(async () => []);
    expect(await studio.fillChannel(channel)).toBe(0);
    expect((llm.complete as any).mock.calls.length).toBe(0);
  });

  it('v977: unplatzierbarer Termin wird für die restlichen Runden gesperrt (keine Wiederholungs-Generierung)', async () => {
    const soon = new Date(Date.now() + 10 * 60_000).toISOString(); // Anpfiff in 10 min — auch ad-hoc (jetzt+30min) zu spät
    const channel = makeChannel({ mode: 'approve' });
    const { studio, llm, createdItems } = makeStack({
      channel,
      llmResponse: JSON.stringify([
        { title: 'Public Viewing gleich', body: 'Ganz kurzfristige Ankündigung für das Match in wenigen Minuten im Pub!', hashtags: [], warum: 'Termin', terminBis: soon },
      ]),
    });
    expect(await studio.fillChannel(channel)).toBe(0);
    expect(createdItems.length).toBe(0);
    // Runde 1 generiert + verwirft; Runde 2 filtert den gesperrten Termin → accepted leer → Abbruch
    expect((llm.complete as any).mock.calls.length).toBe(2);
  });

  it('v977: Prompt trägt Veröffentlichungsfenster und ZEITBEZUG-Regel', async () => {
    const channel = makeChannel({ mode: 'approve' });
    const { studio, llm } = makeStack({ channel });
    await studio.fillChannel(channel);
    const prompt = (llm.complete as any).mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain('VERÖFFENTLICHUNGSZEITRAUM');
    expect(prompt).toContain('erscheinen zwischen');
    expect(prompt).toContain('ZEITBEZUG');
    expect(prompt).toContain('NIE relative Zeitwörter');
  });

  it('Termin-Idee läuft am Token-Gate vorbei (Ort/Format teilen sich alle Ankündigungen)', async () => {
    const channel = makeChannel({ mode: 'approve' });
    // Geplanter NORMALER Post mit fast gleichen Titel-Tokens (anderes Match, kein terminAt)
    const similar: ContentItem = {
      id: 'old', channelId: 'ch-1', userId: OWNER, status: 'scheduled', title: 'Public Viewing: Brasilien gegen Norwegen im Dublin Irish Pub',
      body: 'Rückblick auf den Public-Viewing-Abend.', hashtags: [], media: [], source: 'studio',
      createdAt: 'x', updatedAt: 'x',
    } as unknown as ContentItem;
    const { studio, createdItems } = makeStack({
      channel, planned: [similar],
      llmResponse: JSON.stringify([
        { title: 'Public Viewing: Kanada gegen Marokko im Dublin Irish Pub', body: 'Nächster Termin — wir schauen das Achtelfinale gemeinsam, kommt vorbei!', hashtags: [], warum: 'Termin', terminBis: EVENT_ISO },
      ]),
    });
    const created = await studio.fillChannel(channel);
    expect(created).toBe(1);
    expect(createdItems[0].title).toContain('Kanada gegen Marokko');
  });
});
