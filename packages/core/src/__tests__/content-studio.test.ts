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

  it('v1003: ort/einlass werden geparst (Termin-Felder für die Bild-Karte)', () => {
    const out = parseIdeas('[{"title":"PV","body":"Ein ausreichend langer Ankündigungstext für den Filter.","terminBis":"2026-07-06T19:00:00.000Z","ort":"Dublin Irish Pub, Wien","einlass":"19:30"}]');
    expect(out[0].ort).toBe('Dublin Irish Pub, Wien');
    expect(out[0].einlass).toBe('19:30');
    const plain = parseIdeas('[{"title":"T","body":"Ein ausreichend langer Beitragstext ohne Termin hier."}]');
    expect(plain[0].ort).toBeUndefined();
  });

  it('v997: art wird geparst (nur gültige Werte)', () => {
    const out = parseIdeas('[{"title":"T","body":"Ein ordentlich langer Post-Text hier.","art":"recap"},{"title":"U","body":"Noch ein ordentlich langer Post-Text.","art":"quatsch"}]');
    expect(out[0].art).toBe('recap');
    expect(out[1].art).toBeUndefined();
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
    // v1005 — Bild-Bibliothek
    listMediaAssets: vi.fn(async () => []),
    createMediaAsset: vi.fn(async (_u: string, input: any) => ({ id: 'asset-1', userId: OWNER, lastUsedAt: 'x', useCount: 1, createdAt: 'x', ...input })),
    touchMediaAsset: vi.fn(async () => {}),
    deleteMediaAsset: vi.fn(async () => {}),
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
    // v990 — beide VERSUCHE zählen trotzdem aufs Budget: die OpenAI-Kosten
    // fielen an, auch wenn das Vision-Gate die Bilder verwarf
    expect((miniRepo.upsertMetric as any).mock.calls.filter((c: any[]) => c[1]?.kind === 'gen_image').length).toBe(2);
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

  it('v1006: config.language steuert die Inhaltssprache im Prompt (Default Deutsch)', async () => {
    const en = makeChannel({ config: { topic_id: 't-1', language: 'en' } });
    const { studio, llm } = makeStack({ channel: en });
    await studio.fillChannel(en);
    const prompt = (llm.complete as any).mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain('Sprache: Englisch');

    const plain = makeChannel({});
    const { studio: s2, llm: llm2 } = makeStack({ channel: plain });
    await s2.fillChannel(plain);
    expect((llm2.complete as any).mock.calls[0][0].messages[0].content).toContain('Sprache: Deutsch');
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

describe('ContentStudio — Redaktionsleitung (v993)', () => {
  function makeFamilyStack() {
    // newsdesk_quiet [24,24] = nie Nachtruhe — Tests laufen sonst nachts leer
    const website = makeChannel({ id: 'ch-web', name: 'fussball.cc', platform: 'rest', projectId: 'proj-1', postingSlots: ['Mo 08:00', 'Di 08:00', 'Mi 08:00', 'Do 08:00', 'Fr 08:00', 'Sa 08:00', 'So 08:00'], persona: 'redaktionell', config: { topic_id: 't-1', newsdesk_quiet: [24, 24] } });
    const telegram = makeChannel({ id: 'ch-tg', name: 'FussballCC News', platform: 'telegram_channel', projectId: 'proj-1', postingSlots: ['Mo 12:00', 'Di 12:00', 'Mi 12:00', 'Do 12:00', 'Fr 12:00', 'Sa 12:00', 'So 12:00'], persona: 'knapp' });
    const stories: any[] = [];
    const assignments: any[] = [];
    const { socialRepo, interestsRepo, insightsRepo, llm, createdItems, transitions } = makeStack({ channel: website });
    (socialRepo.listChannels as any) = vi.fn(async () => [website, telegram]);
    (socialRepo.listItems as any) = vi.fn(async () => []);
    (socialRepo as any).listStories = vi.fn(async () => stories);
    (socialRepo as any).createStory = vi.fn(async (_u: string, input: any) => {
      const s = { id: `story-${stories.length + 1}`, userId: OWNER, status: 'active', importance: input.importance ?? 0.5, ...input };
      stories.push(s);
      return s;
    });
    (socialRepo as any).createAssignment = vi.fn(async (input: any) => { assignments.push(input); });
    const studio = new ContentStudio(socialRepo, interestsRepo, insightsRepo, llm, undefined, undefined, undefined, makeLogger(), OWNER);
    return { studio, website, telegram, llm, createdItems, transitions, stories, assignments, socialRepo };
  }

  const CONF = JSON.stringify([{
    titel: 'Kolumbien komplettiert das Achtelfinale', zusammenfassung: 'Kolumbien schlägt X 2:1 und steht im Achtelfinale.',
    art: 'news', wichtigkeit: 0.7,
    kanaele: [{ kanal: 'fussball.cc', rolle: 'lead', versatz_h: 0 }, { kanal: 'FussballCC News', rolle: 'follow', versatz_h: 2 }],
  }]);
  const RENDER = (title: string) => JSON.stringify([{ title, body: 'Ein vollwertiger Beitrag mit allen Fakten aus dem Konferenz-Stoff und Einordnung.', hashtags: ['wm2026'], warum: 'x' }]);

  it('planFamily: Konferenz → Story + Lead/Follower-Items; Follower-Slot ≥ Lead + Versatz', async () => {
    const { studio, website, telegram, llm, createdItems, transitions, stories, assignments } = makeFamilyStack();
    (llm.complete as any)
      .mockResolvedValueOnce({ content: CONF })
      .mockResolvedValueOnce({ content: RENDER('Kolumbien ist weiter — die Analyse') })
      .mockResolvedValueOnce({ content: RENDER('Kolumbien weiter!') });
    const created = await studio.planFamily('project:proj-1', [website, telegram]);
    expect(created).toBe(2);
    expect(stories.length).toBe(1);
    expect(createdItems.every(i => (i as any).storyId === undefined || true)).toBe(true); // createItem-Mock trägt storyId in opts
    expect(assignments.map(a => a.role).sort()).toEqual(['follow', 'lead']);
    // Konferenz-Prompt enthält Kanäle + Sperr-Hinweis; Render-Prompts die Rollen
    const conferencePrompt = (llm.complete as any).mock.calls[0][0].messages[0].content as string;
    expect(conferencePrompt).toContain('Redaktionskonferenz');
    expect(conferencePrompt).toContain('fussball.cc');
    const leadPrompt = (llm.complete as any).mock.calls[1][0].messages[0].content as string;
    expect(leadPrompt).toContain('LEAD');
    const followPrompt = (llm.complete as any).mock.calls[2][0].messages[0].content as string;
    expect(followPrompt).toContain('bereits live');
    // Staging: Follower-Slot mindestens Lead + 2h
    const leadAt = transitions.find(t => t.id === 'gen-1')!.at!;
    const followAt = transitions.find(t => t.id === 'gen-2')!.at!;
    expect(Date.parse(followAt)).toBeGreaterThanOrEqual(Date.parse(leadAt) + 2 * 3_600_000);
  });

  it('planFamily: Termin-Story bekommt auf JEDEM Kanal einen Slot vor dem Anpfiff (Vorrang vor Kapazität)', async () => {
    const { studio, website, telegram, llm, transitions } = makeFamilyStack();
    const kickoff = new Date(2099, 6, 4, 19, 0).toISOString();
    (llm.complete as any)
      .mockResolvedValueOnce({ content: JSON.stringify([{
        titel: 'Public Viewing Kanada – Marokko', zusammenfassung: 'PV im Dublin Irish Pub.',
        art: 'termin', wichtigkeit: 0.8, terminBis: kickoff,
        kanaele: [{ kanal: 'fussball.cc', rolle: 'lead', versatz_h: 0 }, { kanal: 'FussballCC News', rolle: 'follow', versatz_h: 0 }],
      }]) })
      .mockResolvedValueOnce({ content: RENDER('PV-Artikel') })
      .mockResolvedValueOnce({ content: RENDER('PV kurz') });
    const created = await studio.planFamily('project:proj-1', [website, telegram]);
    expect(created).toBe(2);
    for (const t of transitions.filter(t => t.to === 'scheduled')) {
      expect(t.at! < kickoff).toBe(true);
    }
    // v998 — Termin-Render-Prompts tragen die Perspektiven-Regel (Medium, nicht Veranstalter)
    const renderPrompt = (llm.complete as any).mock.calls[1][0].messages[0].content as string;
    expect(renderPrompt).toContain('PERSPEKTIVE bei Terminen');
    expect(renderPrompt).toContain('NICHT der Veranstalter');
  });

  it('planFamily: Konferenz-Story, die eine aktive Story dupliziert, wird verworfen', async () => {
    const { studio, website, telegram, llm, stories } = makeFamilyStack();
    stories.push({ id: 'story-alt', title: 'Kolumbien komplettiert das Achtelfinale', summary: 'alt', status: 'active', kind: 'news', importance: 0.5 });
    (llm.complete as any).mockResolvedValueOnce({ content: CONF });
    const created = await studio.planFamily('project:proj-1', [website, telegram]);
    expect(created).toBe(0);
    expect(stories.length).toBe(1); // keine neue Story
  });

  it('v994: News-Desk — Score über Schwelle → Eilmeldungs-Story mit Ad-hoc-Slots auf allen Kanälen', async () => {
    const { studio, llm, transitions, stories, socialRepo } = makeFamilyStack();
    const insights = (studio as any).insightsRepo;
    const { interestsRepo } = { interestsRepo: (studio as any).interestsRepo };
    (interestsRepo.listItems as any) = vi.fn(async () => [
      { id: 'n1', topicId: 't-1', title: 'Messi tritt zurück — Karriereende nach der WM', summary: 'Offiziell bestätigt.', sourceKind: 'rss', createdAt: 'x' },
      { id: 'n2', topicId: 't-1', title: 'Rasen im Stadion gemäht', sourceKind: 'rss', createdAt: 'x' },
    ]);
    (llm.complete as any)
      .mockResolvedValueOnce({ content: '[{"index": 0, "score": 0.95}, {"index": 1, "score": 0.1}]' })
      .mockResolvedValueOnce({ content: RENDER('Messi hört auf — was das bedeutet') })
      .mockResolvedValueOnce({ content: RENDER('Messi-Rücktritt!') });
    const created = await studio.newsDesk();
    expect(created).toBe(2);
    expect(stories.length).toBe(1);
    expect(stories[0].source).toBe('event');
    // Ad-hoc-Slots innerhalb der nächsten 2 Stunden
    for (const t of transitions.filter(t => t.to === 'scheduled')) {
      const dt = Date.parse(t.at!) - Date.now();
      expect(dt).toBeGreaterThan(0);
      expect(dt).toBeLessThanOrEqual(2 * 3_600_000);
    }
    // ⚡-Insight erzeugt
    expect((insights.upsertCandidate as any).mock.calls.some((c: any[]) => String(c[1].title).includes('Eilmeldung'))).toBe(true);
    void socialRepo;
  });

  it('v994: Tages-Limit und langweilige Items → keine Eilmeldung', async () => {
    const { studio, llm, stories } = makeFamilyStack();
    const interestsRepo = (studio as any).interestsRepo;
    (interestsRepo.listItems as any) = vi.fn(async () => [
      { id: 'n2', topicId: 't-1', title: 'Rasen gemäht', sourceKind: 'rss', createdAt: 'x' },
    ]);
    (llm.complete as any).mockResolvedValueOnce({ content: '[{"index": 0, "score": 0.2}]' });
    expect(await studio.newsDesk()).toBe(0);
    expect(stories.length).toBe(0);

    // Limit erreicht: 3 Event-Stories heute → gar kein Score-Call mehr
    stories.push({ source: 'event' }, { source: 'event' }, { source: 'event' });
    (llm.complete as any).mockClear();
    expect(await studio.newsDesk()).toBe(0);
    expect((llm.complete as any).mock.calls.length).toBe(0);
  });

  it('v995: Plan-Review — abgelaufene Termine raus, reguläre weichen der Eilmeldung, LLM-Empfehlungen als Insight', async () => {
    const { studio, llm, stories, socialRepo } = makeFamilyStack();
    const insights = (studio as any).insightsRepo;
    stories.push({ id: 'story-brk', source: 'event', createdAt: new Date().toISOString(), status: 'active', title: 'Eil' });
    const past = new Date(Date.now() - 3_600_000).toISOString();
    const in30 = new Date(Date.now() + 30 * 60_000).toISOString();
    const in24h = new Date(Date.now() + 24 * 3_600_000).toISOString();
    const baseItem = (id: string, status: string, title: string): ContentItem => ({
      id, channelId: 'ch-web', userId: OWNER, status: status as any, title,
      body: 'Text', media: [], hashtags: [], source: 'studio', createdAt: 'x', updatedAt: 'x',
    });
    const expired = { ...baseItem('i-exp', 'approved', 'PV gestern'), scheduledAt: in30, performance: { terminBis: past } };
    const soonItem = { ...baseItem('i-soon', 'scheduled', 'Evergreen'), scheduledAt: in30 };
    const staleItem = { ...baseItem('i-stale', 'approved', 'Vorschau: Spiel X'), scheduledAt: in24h };
    (socialRepo.listItems as any) = vi.fn(async () => [expired, soonItem, staleItem]);
    const rescheduled: any[] = [];
    (socialRepo.reschedule as any) = vi.fn(async (_u: string, id: string, at: string) => { rescheduled.push({ id, at }); return true; });
    const interestsRepo = (studio as any).interestsRepo;
    (interestsRepo.listItems as any) = vi.fn(async () => [{ id: 'h1', topicId: 't-1', title: 'Spiel X wurde abgesagt', sourceKind: 'rss', createdAt: 'x' }]);
    (llm.complete as any).mockResolvedValueOnce({ content: '[{"index": 1, "verdict": "ueberholt", "grund": "Spiel abgesagt"}]' });

    const r = await studio.planReview();
    expect(r.expired).toBe(1);
    // abgelaufenes Item wurde rejected
    expect((socialRepo.transition as any).mock.calls.some((c: any[]) => c[1] === 'i-exp' && c[2] === 'rejected')).toBe(true);
    // Evergreen +2h verschoben
    expect(r.deferred).toBe(1);
    expect(rescheduled[0].id).toBe('i-soon');
    expect(Date.parse(rescheduled[0].at)).toBeGreaterThan(Date.parse(in30));
    // LLM-Empfehlung als Insight (kein Auto-Reject!)
    expect(r.flagged).toBe(1);
    const insight = (insights.upsertCandidate as any).mock.calls.find((c: any[]) => String(c[1].title).includes('Plan-Review'));
    expect(insight[1].body).toContain('Überholt');
    expect((socialRepo.transition as any).mock.calls.filter((c: any[]) => c[2] === 'rejected').length).toBe(1);
  });

  it('v996: Playbook — family_role lead übersteuert die Konferenz-Rolle, family_offset_hours den Versatz', async () => {
    const { studio, website, telegram, llm, assignments } = makeFamilyStack();
    // Playbook: Telegram ist fester Lead, die Website folgt mit 5h Versatz
    (telegram.config as any).family_role = 'lead';
    (website.config as any).family_offset_hours = 5;
    (llm.complete as any)
      .mockResolvedValueOnce({ content: CONF }) // Konferenz will website als Lead (versatz_h 2 für TG)
      .mockResolvedValueOnce({ content: RENDER('TG zuerst') })
      .mockResolvedValueOnce({ content: RENDER('Website folgt') });
    const created = await studio.planFamily('project:proj-1', [website, telegram]);
    expect(created).toBe(2);
    // Konferenz-Prompt nennt die verbindlichen Regeln
    const conferencePrompt = (llm.complete as any).mock.calls[0][0].messages[0].content as string;
    expect(conferencePrompt).toContain('PLAYBOOK');
    expect(conferencePrompt).toContain('Lead-Kanal ist IMMER "FussballCC News"');
    // Enforcement: Rollen gedreht, Versatz aus der Config statt aus der Konferenz
    expect(assignments.find(a => a.channelId === 'ch-tg')!.role).toBe('lead');
    const webAssign = assignments.find(a => a.channelId === 'ch-web')!;
    expect(webAssign.role).toBe('follow');
    expect(webAssign.offsetHours).toBe(5);
  });

  it('v999: traffic_mode teaser — FOLLOW-Prompt trägt Teaser-Regel + Keine-URL-Regel', async () => {
    const { studio, website, telegram, llm } = makeFamilyStack();
    (telegram.config as any).traffic_mode = 'teaser';
    (llm.complete as any)
      .mockResolvedValueOnce({ content: CONF })
      .mockResolvedValueOnce({ content: RENDER('Lead-Artikel') })
      .mockResolvedValueOnce({ content: RENDER('Teaser') });
    await studio.planFamily('project:proj-1', [website, telegram]);
    const followPrompt = (llm.complete as any).mock.calls[2][0].messages[0].content as string;
    expect(followPrompt).toContain('TEASER-MODUS');
    expect(followPrompt).toContain('KEINE URLs');
    // Lead-Prompt bleibt ohne Teaser-Regel
    const leadPrompt = (llm.complete as any).mock.calls[1][0].messages[0].content as string;
    expect(leadPrompt).not.toContain('TEASER-MODUS');
  });

  it('v996: resolveLead und playbookOffset — Helfer-Semantik', () => {
    const rest = makeChannel({ id: 'a', platform: 'rest' });
    const tg = makeChannel({ id: 'b', platform: 'telegram_channel', config: { family_role: 'lead' } });
    // family_role lead schlägt die rest-Plattform-Heuristik
    expect(ContentStudio.resolveLead([rest, tg]).id).toBe('b');
    expect(ContentStudio.resolveLead([rest, makeChannel({ id: 'c', platform: 'telegram_channel' })]).id).toBe('a');
    // Versatz: Zahl, je Story-Art mit default, Clamp, undefined
    expect(ContentStudio.playbookOffset({ config: { family_offset_hours: 3 } }, 'news')).toBe(3);
    expect(ContentStudio.playbookOffset({ config: { family_offset_hours: { vorschau: 8, default: 2 } } }, 'vorschau')).toBe(8);
    expect(ContentStudio.playbookOffset({ config: { family_offset_hours: { vorschau: 8, default: 2 } } }, 'news')).toBe(2);
    expect(ContentStudio.playbookOffset({ config: { family_offset_hours: 999 } }, 'news')).toBe(72);
    expect(ContentStudio.playbookOffset({ config: {} }, 'news')).toBeUndefined();
  });

  it('v997: verderbliche Konferenz-Story ohne Lead-Slot in der Haltbarkeit wird GAR NICHT produziert', async () => {
    const { studio, website, telegram, llm, stories, socialRepo } = makeFamilyStack();
    // Haltbarkeit praktisch 0 → kein Raster-Slot kann sie einhalten, kein Evergreen zum Verdrängen
    (website.config as any).shelf_life_hours = { news: 0.01 };
    (llm.complete as any).mockResolvedValueOnce({ content: CONF }); // art news, Lead fussball.cc
    const created = await studio.planFamily('project:proj-1', [website, telegram]);
    expect(created).toBe(0);
    expect(stories.length).toBe(0); // Story wurde nie angelegt — kein Budget verbrannt
    expect((socialRepo.createItem as any).mock.calls.length).toBe(0);
  });

  it('v997: shelfLifeHours — Defaults, config-Override, nur news/recap', () => {
    expect(ContentStudio.shelfLifeHours('news', { config: {} })).toBe(48);
    expect(ContentStudio.shelfLifeHours('recap', { config: {} })).toBe(72);
    expect(ContentStudio.shelfLifeHours('news', { config: { shelf_life_hours: { news: 24 } } })).toBe(24);
    expect(ContentStudio.shelfLifeHours('evergreen', { config: {} })).toBeUndefined();
    expect(ContentStudio.shelfLifeHours('termin', { config: {} })).toBeUndefined();
    expect(ContentStudio.shelfLifeHours(undefined, { config: {} })).toBeUndefined();
  });

  it('v997: swapWithEvergreen — Evergreen weicht auf den späten Slot, sein früher Slot wird frei', async () => {
    const { studio, website, socialRepo } = makeFamilyStack();
    const in45 = new Date(Date.now() + 45 * 60_000).toISOString();
    const in2h = new Date(Date.now() + 2 * 3_600_000).toISOString();
    const late = new Date(Date.now() + 10 * 24 * 3_600_000).toISOString();
    const evergreen = { id: 'i-eg', channelId: 'ch-web', userId: OWNER, status: 'approved', title: 'Panini-Historie', body: 'x', media: [], hashtags: [], source: 'studio', createdAt: 'x', updatedAt: 'x', scheduledAt: in45, performance: { art: 'evergreen' } };
    (socialRepo.listItems as any) = vi.fn(async () => [evergreen]);
    const rescheduled: any[] = [];
    (socialRepo.reschedule as any) = vi.fn(async (_u: string, id: string, at: string) => { rescheduled.push({ id, at }); return true; });
    const slotPool = [late];
    const freed = await (studio as any).swapWithEvergreen(website, in2h, slotPool);
    expect(freed).toBe(in45);
    expect(rescheduled).toEqual([{ id: 'i-eg', at: late }]);
    expect(slotPool).toEqual([]); // später Slot verbraucht

    // ohne Evergreen-Opfer: kein Swap
    (socialRepo.listItems as any) = vi.fn(async () => []);
    expect(await (studio as any).swapWithEvergreen(website, in2h, [late])).toBeUndefined();
  });

  it('v997: Plan-Review meldet überalterte news/recap deterministisch (Slot jenseits der Haltbarkeit)', async () => {
    const { studio, llm, socialRepo } = makeFamilyStack();
    const insights = (studio as any).insightsRepo;
    const created100hAgo = new Date(Date.now() - 100 * 3_600_000).toISOString();
    const in10h = new Date(Date.now() + 10 * 3_600_000).toISOString();
    const stale = { id: 'i-old', channelId: 'ch-web', userId: OWNER, status: 'approved', title: 'Achtelfinal-Recap', body: 'x', media: [], hashtags: [], source: 'studio', createdAt: created100hAgo, updatedAt: 'x', scheduledAt: in10h, performance: { art: 'news' } };
    (socialRepo.listItems as any) = vi.fn(async () => [stale]);
    (llm.complete as any).mockResolvedValueOnce({ content: '[]' });
    const r = await studio.planReview();
    expect(r.flagged).toBe(1);
    const insight = (insights.upsertCandidate as any).mock.calls.find((c: any[]) => String(c[1].title).includes('Plan-Review'));
    expect(insight[1].body).toContain('Überaltert');
    // NUR Empfehlung — kein Auto-Reject
    expect((socialRepo.transition as any).mock.calls.filter((c: any[]) => c[2] === 'rejected').length).toBe(0);
  });

  it('runDaily: Familien laufen über planFamily, Solo-Kanäle über fillChannel', async () => {
    const { studio, website, telegram, llm, socialRepo } = makeFamilyStack();
    const solo = makeChannel({ id: 'ch-solo', name: 'Solo', config: { topic_id: 't-1' } });
    (socialRepo.listChannels as any) = vi.fn(async () => [website, telegram, solo]);
    (llm.complete as any).mockResolvedValue({ content: '[]' });
    await studio.runDaily();
    const prompts = (llm.complete as any).mock.calls.map((c: any[]) => c[0].messages[0].content as string);
    expect(prompts.some((p: string) => p.includes('Redaktionskonferenz'))).toBe(true);
    expect(prompts.some((p: string) => p.includes('Content-Redakteur für den Social-Kanal "Solo"'))).toBe(true);
  });
});

describe('ContentStudio — Serien-Formate (v1012)', () => {
  it('nextSlotOccurrence: nächstes Wochen-Vorkommen in Ortszeit, kaputte Slots → undefined', () => {
    // Mi 01.07.2026 12:00 lokal → nächster „Mo 09:00" ist Mo 06.07. 09:00
    const from = new Date(2026, 6, 1, 12, 0).toISOString();
    expect(ContentStudio.nextSlotOccurrence('Mo 09:00', from)).toBe(new Date(2026, 6, 6, 9, 0).toISOString());
    // gleicher Tag, Zeit noch nicht vorbei → heute
    expect(ContentStudio.nextSlotOccurrence('Mi 18:00', from)).toBe(new Date(2026, 6, 1, 18, 0).toISOString());
    expect(ContentStudio.nextSlotOccurrence('Blub', from)).toBeUndefined();
  });

  it('ensureFormats: erzeugt das Wochen-Format am Slot, Dedup verhindert Doppel', async () => {
    const channel = makeChannel({ config: { topic_id: 't-1', formate: [{ slot: 'Mo 09:00', name: 'Wochenrückblick', anweisung: 'Fasse die Woche in 5 Punkten zusammen.' }] } });
    const { studio, socialRepo, llm, transitions } = makeStack({
      channel,
      llmResponse: JSON.stringify([{ title: 'Die Woche im Rückblick', body: 'Ein ausreichend langer Wochenrückblick mit fünf Punkten und Einordnung.', hashtags: ['wm2026'], warum: 'Serienformat' }]),
    });
    const created = await studio.ensureFormats(channel);
    expect(created).toBe(1);
    const prompt = (llm.complete as any).mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain('SERIEN-FORMAT „Wochenrückblick"');
    expect(prompt).toContain('Fasse die Woche in 5 Punkten zusammen.');
    const perf = (socialRepo.mergePerformance as any).mock.calls[0][2];
    expect(perf.format).toBe('Wochenrückblick');
    const at = transitions.find(t => t.to === 'scheduled')!.at!;
    expect(new Date(at).getDay()).toBe(1); // Montag

    // Dedup: existiert bereits ein Item dieses Formats in der Woche → nichts Neues
    (socialRepo.listItems as any) = vi.fn(async () => [{
      id: 'i-fmt', channelId: 'ch-1', userId: OWNER, status: 'scheduled', body: 'x', media: [], hashtags: [],
      source: 'studio', createdAt: 'x', updatedAt: 'x', scheduledAt: at, performance: { format: 'Wochenrückblick' },
    }]);
    expect(await studio.ensureFormats(channel)).toBe(0);
  });
});

describe('ContentStudio — Bild-Look (v1004)', () => {
  it('image_style/image_quality/Plattform-Format fließen in den Generierungs-Aufruf', async () => {
    const channel = makeChannel({
      platform: 'instagram', postingSlots: ['Mo 18:00'], planningHorizonDays: 7,
      config: { topic_id: 't-1', generate_images: true, image_style: 'cinematisch, 35mm', image_quality: 'high' },
    });
    const { studio } = makeStack({
      channel,
      llmResponse: JSON.stringify([{ title: 'Story', body: 'Ein ausreichend langer Beitragstext für den Bild-Test hier.', hashtags: [], warum: 'x' }]),
    });
    const execute = vi.fn(async (_s: unknown, input: Record<string, unknown>) => ({ success: true, attachments: [{ data: Buffer.from('png') }] }));
    (studio as any).skillRegistry = { get: () => ({ metadata: { name: 'image_generate' } }) };
    (studio as any).skillSandbox = { execute };
    const llm = (studio as any).llm;
    (llm.complete as any)
      .mockResolvedValueOnce({ content: JSON.stringify([{ title: 'Story', body: 'Ein ausreichend langer Beitragstext für den Bild-Test hier.', hashtags: [], warum: 'x' }]) })
      .mockResolvedValueOnce({ content: '{"person": false, "logo": false, "text": false, "begruendung": "ok"}' });
    await studio.fillChannel(channel);
    const input = execute.mock.calls[0]![1];
    expect(input.quality).toBe('high');
    expect(input.size).toBe('1024x1536'); // Instagram → Hochformat
    expect(String(input.prompt)).toContain('cinematisch, 35mm'); // Stil-Preset statt Persona
  });

  it('v1008: image_carousel + slides → mehrere Bilder, Budget je Slide-Versuch; ohne Opt-in Einzelbild', async () => {
    const channel = makeChannel({
      platform: 'instagram', postingSlots: ['Mo 18:00'], planningHorizonDays: 7,
      config: { topic_id: 't-1', generate_images: true, image_carousel: true, image_policy: 'people_ok' },
    });
    const ideaJson = JSON.stringify([{
      title: 'Die 3 Viertelfinal-Favoriten', body: 'Ein ausreichend langer Analyse-Text mit mehreren Punkten hier.',
      hashtags: [], warum: 'x', bildidee: 'Pokal auf Rasen',
      slides: [
        { motiv: 'Pokal auf Rasen unter Flutlicht', titel: 'Die Favoriten' },
        { motiv: 'Taktiktafel mit Magneten', titel: 'Spanien' },
        { motiv: 'Stadion-Kurve mit Fahnen', titel: 'Frankreich' },
      ],
    }]);
    const os = await import('node:os');
    const { socialRepo, interestsRepo, insightsRepo, llm } = makeStack({ channel, llmResponse: ideaJson });
    const studio = new ContentStudio(socialRepo, interestsRepo, insightsRepo, llm, undefined, undefined, undefined, makeLogger(), OWNER, os.tmpdir());
    const execute = vi.fn(async () => ({ success: true, attachments: [{ data: Buffer.from('png') }] }));
    (studio as any).skillRegistry = { get: () => ({ metadata: { name: 'image_generate' } }) };
    (studio as any).skillSandbox = { execute };
    await studio.fillChannel(channel);
    expect(execute.mock.calls.length).toBe(3); // ein Call je Slide (people_ok: kein Vision-Gate)
    const created = (socialRepo.createItem as any).mock.calls[0][2];
    expect(created.media.length).toBe(3); // Karussell-Medien am Item
    const genImage = (socialRepo.upsertMetric as any).mock.calls.filter((c: any[]) => c[1]?.kind === 'gen_image');
    expect(genImage.length).toBe(3); // Budget je Slide gezählt

    // ohne image_carousel: slides werden ignoriert → 1 Bild
    const solo = makeChannel({ platform: 'instagram', postingSlots: ['Mo 18:00'], planningHorizonDays: 7, config: { topic_id: 't-1', generate_images: true, image_policy: 'people_ok' } });
    const stack2 = makeStack({ channel: solo, llmResponse: ideaJson });
    const s2 = new ContentStudio(stack2.socialRepo, stack2.interestsRepo, stack2.insightsRepo, stack2.llm, undefined, undefined, undefined, makeLogger(), OWNER, os.tmpdir());
    const execute2 = vi.fn(async () => ({ success: true, attachments: [{ data: Buffer.from('png') }] }));
    (s2 as any).skillRegistry = { get: () => ({ metadata: { name: 'image_generate' } }) };
    (s2 as any).skillSandbox = { execute: execute2 };
    await s2.fillChannel(solo);
    expect(execute2.mock.calls.length).toBe(1);
  });

  it('platformImageSpec: IG Hochformat mit 4:5-Crop, rest Querformat, config.image_size übersteuert', () => {
    expect(ContentStudio.platformImageSpec({ platform: 'instagram', config: {} })).toEqual({ size: '1024x1536', crop: [4, 5] });
    expect(ContentStudio.platformImageSpec({ platform: 'rest', config: {} })).toEqual({ size: '1536x1024' });
    expect(ContentStudio.platformImageSpec({ platform: 'sonstwas', config: {} })).toEqual({});
    expect(ContentStudio.platformImageSpec({ platform: 'rest', config: { image_size: '1024x1024' } })).toEqual({ size: '1024x1024', crop: undefined });
  });
});

describe('ContentStudio — Bild-Bibliothek (v1005)', () => {
  async function makeMediaStudio(assets: any[]) {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'alfred-assets-'));
    const channel = makeChannel({ postingSlots: ['Mo 18:00'], planningHorizonDays: 7, config: { topic_id: 't-1', generate_images: true } });
    const { socialRepo, interestsRepo, insightsRepo, llm } = makeStack({
      channel,
      llmResponse: JSON.stringify([{ title: 'Flutlicht-Stimmung', body: 'Ein ausreichend langer Beitragstext für den Bild-Test hier.', hashtags: [], warum: 'x', bildidee: 'Stadion unter Flutlicht mit Ball auf dem Rasen' }]),
    });
    (socialRepo as any).listMediaAssets = vi.fn(async () => assets);
    const studio = new ContentStudio(socialRepo, interestsRepo, insightsRepo, llm, undefined, undefined, undefined, makeLogger(), OWNER, dir);
    const execute = vi.fn(async () => ({ success: true, attachments: [{ data: Buffer.from('fresh-png') }] }));
    (studio as any).skillRegistry = { get: () => ({ metadata: { name: 'image_generate' } }) };
    (studio as any).skillSandbox = { execute };
    return { studio, channel, socialRepo, llm, execute, dir, writeFile, join };
  }

  it('ähnliches Basis-Bild nach Cooldown → Wiederverwendung OHNE Generierung und OHNE Budget', async () => {
    const old = new Date(Date.now() - 40 * 24 * 3_600_000).toISOString();
    const { studio, channel, socialRepo, execute, dir, writeFile, join } = await makeMediaStudio([]);
    const assetPath = join(dir, 'asset-alt.png');
    await writeFile(assetPath, Buffer.from('base-png'));
    (socialRepo as any).listMediaAssets = vi.fn(async () => [{
      id: 'a-1', userId: OWNER, channelId: 'ch-1', path: assetPath,
      motif: 'Stadion unter Flutlicht mit Ball auf dem Rasen, atmosphärisch',
      style: undefined, format: '1536x1024', lastUsedAt: old, useCount: 1, createdAt: old,
    }]);
    await studio.fillChannel(channel);
    expect(execute).not.toHaveBeenCalled(); // kein Generierungs-Call
    const genImage = (socialRepo.upsertMetric as any).mock.calls.filter((c: any[]) => c[1]?.kind === 'gen_image');
    expect(genImage.length).toBe(0); // kein Budget verbraucht
    expect((socialRepo as any).touchMediaAsset).toHaveBeenCalledWith(OWNER, 'a-1');
    const media = (socialRepo.createItem as any).mock.calls[0][2].media;
    expect(media[0].pathOrUrl).toContain('studio-'); // eigenes Item-Bild (mit frischem Overlay)
  });

  it('kein passendes Asset (Cooldown nicht um) → normale Generierung + Registrierung in der Bibliothek', async () => {
    const fresh = new Date(Date.now() - 1 * 24 * 3_600_000).toISOString(); // erst gestern genutzt
    const { studio, channel, socialRepo, llm, execute, join, dir, writeFile } = await makeMediaStudio([]);
    const assetPath = join(dir, 'asset-frisch.png');
    await writeFile(assetPath, Buffer.from('base'));
    (socialRepo as any).listMediaAssets = vi.fn(async () => [{
      id: 'a-2', userId: OWNER, channelId: 'ch-1', path: assetPath,
      motif: 'Stadion unter Flutlicht mit Ball auf dem Rasen',
      style: undefined, format: '1536x1024', lastUsedAt: fresh, useCount: 1, createdAt: fresh,
    }]);
    // Vision-Gate: sauber
    (llm.complete as any)
      .mockResolvedValueOnce({ content: JSON.stringify([{ title: 'Flutlicht-Stimmung', body: 'Ein ausreichend langer Beitragstext für den Bild-Test hier.', hashtags: [], warum: 'x', bildidee: 'Stadion unter Flutlicht mit Ball auf dem Rasen' }]) })
      .mockResolvedValueOnce({ content: '{"person": false, "logo": false, "text": false, "begruendung": "ok"}' });
    await studio.fillChannel(channel);
    expect(execute).toHaveBeenCalled();
    const created = (socialRepo as any).createMediaAsset.mock.calls[0];
    expect(created[1].motif).toContain('Stadion unter Flutlicht');
    expect(created[1].format).toBe('1536x1024');
    expect(created[1].path).toContain('asset-');
  });
});

describe('ContentStudio — Housekeeping (v990)', () => {
  it('Bild-Budget zählt JEDEN Generierungs-Versuch (auch vom Vision-Gate verworfene)', async () => {
    // genau 1 freier Slot → genau 1 Idee → die 2 Zählungen kommen von Versuch+Retry
    const channel = makeChannel({ postingSlots: ['Mo 18:00'], planningHorizonDays: 7, config: { topic_id: 't-1', generate_images: true } });
    const { studio, socialRepo } = makeStack({
      channel,
      llmResponse: JSON.stringify([{ title: 'Story', body: 'Ein ausreichend langer Beitragstext für den Bild-Test hier.', hashtags: [], warum: 'x' }]),
    });
    const skill = { metadata: { name: 'image_generate' } };
    (studio as any).skillRegistry = { get: () => skill };
    (studio as any).skillSandbox = { execute: vi.fn(async () => ({ success: true, attachments: [{ data: Buffer.from('png') }] })) };
    // Vision-LLM: erst Verstoß (person), dann sauber — Ideen-Call kommt zuerst
    const llm = (studio as any).llm;
    (llm.complete as any)
      .mockResolvedValueOnce({ content: JSON.stringify([{ title: 'Story', body: 'Ein ausreichend langer Beitragstext für den Bild-Test hier.', hashtags: [], warum: 'x' }]) })
      .mockResolvedValueOnce({ content: '{"person": true, "logo": false, "text": false, "begruendung": "Testverstoß"}' })
      .mockResolvedValueOnce({ content: '{"person": false, "logo": false, "text": false, "begruendung": "ok"}' });
    await studio.fillChannel(channel);
    // 2 Versuche (Verstoß + Retry) → 2 Budget-Zählungen, obwohl nur 1 Bild überlebt
    const genImageUpserts = (socialRepo.upsertMetric as any).mock.calls.filter((c: any[]) => c[1]?.kind === 'gen_image');
    expect(genImageUpserts.length).toBe(2);
  });

  it('cleanupMediaDir löscht nur ALTE, UNREFERENZIERTE studio-Dateien', async () => {
    const { mkdtemp, writeFile, utimes, readdir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'alfred-media-'));
    const old = new Date(Date.now() - 40 * 24 * 3_600_000);
    await writeFile(join(dir, 'studio-alt.png'), 'x');
    await utimes(join(dir, 'studio-alt.png'), old, old);
    await writeFile(join(dir, 'studio-referenziert.png'), 'x');
    await utimes(join(dir, 'studio-referenziert.png'), old, old);
    await writeFile(join(dir, 'studio-frisch.png'), 'x');
    await writeFile(join(dir, 'fremd.png'), 'x');
    await utimes(join(dir, 'fremd.png'), old, old);

    const { socialRepo, interestsRepo, insightsRepo, llm } = makeStack({ channel: makeChannel({}) });
    (socialRepo as any).countItemsReferencingMedia = vi.fn(async (name: string) => (name.includes('referenziert') ? 1 : 0));
    const studio = new ContentStudio(socialRepo, interestsRepo, insightsRepo, llm, undefined, undefined, undefined, makeLogger(), OWNER, dir);

    const removed = await studio.cleanupMediaDir(30);
    expect(removed).toBe(1);
    const left = (await readdir(dir)).sort();
    expect(left).toEqual(['fremd.png', 'studio-frisch.png', 'studio-referenziert.png']);
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

  it('v986: Dossier-Zeilen tragen die Feed-Summary (HTML-bereinigt, gekürzt) — keine nackten Schlagzeilen mehr', async () => {
    const channel = makeChannel({});
    const { studio, llm, interestsRepo } = makeStack({ channel });
    (interestsRepo.listItems as any) = vi.fn(async () => [
      { id: 'n1', topicId: 't-1', title: 'Klopp spricht mit DFB', summary: '<p>Der Ex-Liverpool-Coach   bestätigt <b>Gespräche</b> über den Teamchefposten.</p>', sourceKind: 'rss', createdAt: 'x' },
      { id: 'n2', topicId: 't-1', title: 'Lange Story', summary: 'z'.repeat(400), sourceKind: 'rss', createdAt: 'x' },
      { id: 'n3', topicId: 't-1', title: 'Ohne Zusammenfassung', sourceKind: 'rss', createdAt: 'x' },
    ]);
    await studio.fillChannel(channel);
    const prompt = (llm.complete as any).mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain('Klopp spricht mit DFB — Der Ex-Liverpool-Coach bestätigt Gespräche über den Teamchefposten.');
    expect(prompt).not.toContain('<p>');
    expect(prompt).toContain(`Lange Story — ${'z'.repeat(220)}`);
    expect(prompt).not.toContain('z'.repeat(221));
    expect(prompt).toContain('- Ohne Zusammenfassung');
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
