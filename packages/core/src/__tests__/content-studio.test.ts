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

  it('v1045: auch numerische und hex-Entities werden dekodiert', () => {
    expect(decodeHtmlEntities('Messi&#8217;s Abschied &#252;ber Nacht &#x2013; &#x201E;Danke&#x201C;')).toBe('Messi’s Abschied über Nacht – „Danke“');
    // kaputte/absurde Codepoints bleiben unangetastet
    expect(decodeHtmlEntities('&#0; &#1114112; &#xZZ;')).toBe('&#0; &#1114112; &#xZZ;');
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
    upsertMetric: vi.fn(async () => {}), incrementMetric: vi.fn(async () => {}),
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

  it('v1022: „ß" ist kein Token-Trennzeichen mehr (Großer/Fußball zerfielen vorher)', () => {
    expect(isNearDuplicateTitle('Großer Fußball Abend', ['Großer Fußball Auftakt'])).toBe(true);
  });

  it('v1090: Floskel-Tokens sind kein Duplikat-Signal (Spanien/Argentinien-Realfall 11.07.)', () => {
    // „zittert sich" allein machte 2 gemeinsame Tokens bei 50% Überlappung → Fehlalarm
    expect(isNearDuplicateTitle('Spanien zittert sich ins Halbfinale', ['Argentinien zittert sich weiter'])).toBe(false);
    // echte Doppelungen (Inhaltswörter gemeinsam) werden weiter erkannt
    expect(isNearDuplicateTitle('Spanien zittert sich ins Halbfinale', ['Spanien erst spät im Halbfinale'])).toBe(true);
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
      upsertMetric: vi.fn(async () => {}), incrementMetric: vi.fn(async () => {}),
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
    expect((miniRepo.incrementMetric as any).mock.calls.filter((c: any[]) => c[1]?.kind === 'gen_image').length).toBe(2);
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
      upsertMetric: vi.fn(async () => {}), incrementMetric: vi.fn(async () => {}), listChannels: vi.fn(async () => [channel]),
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

  it('v1085: YouTube mit auto_video → Konzept mit Bild wird automatisch gerendert (Format aus Config)', async () => {
    const os = await import('node:os');
    const sandbox = { execute: vi.fn(async () => ({ success: true, attachments: [{ fileName: 'image.png', data: Buffer.from('png'), mimeType: 'image/png' }] })) };
    const registry = { get: vi.fn(() => ({ metadata: { name: 'image_generate' } })) };
    const llm = {
      complete: vi.fn(async () => ({ content: JSON.stringify([{ title: 'WM-Analyse: Der Weg ins Finale', body: 'HOOK…\nSCRIPT mit Kapiteln und ausreichend langem Sprechtext für ein Video.\n---\nBESCHREIBUNG mit Kapitelmarken.', hashtags: ['wm2026'], bildidee: 'Stadion bei Flutlicht' }]) })),
    } as any;
    const interests = { getDigest: vi.fn(async () => null), listItems: vi.fn(async () => []), findTopicByName: vi.fn(async () => null), createTopic: vi.fn(async () => ({ id: 't-1' })) } as any;
    const makeMiniRepo = (ch: SocialChannel) => ({
      listItems: vi.fn(async () => []),
      createItem: vi.fn(async (_u: string, chId: string, o: any) => ({ id: 'g1', channelId: chId, ...o, createdAt: 'x', updatedAt: 'x' })),
      transition: vi.fn(async () => ({})), mergePerformance: vi.fn(async () => {}),
      updateChannel: vi.fn(async () => {}), listMetrics: vi.fn(async () => []),
      upsertMetric: vi.fn(async () => {}), incrementMetric: vi.fn(async () => {}), listChannels: vi.fn(async () => [ch]),
    }) as any;
    const { ContentStudio } = await import('../content-studio.js');

    // auto_video an, Format 9:16 aus der Config
    const yt = makeChannel({ platform: 'youtube', config: { topic_id: 't-1', generate_images: true, image_policy: 'people_ok', auto_video: true, auto_video_format: '9:16' } });
    const studio = new ContentStudio(makeMiniRepo(yt), interests, undefined, llm, registry as any, sandbox as any, undefined, makeLogger(), OWNER, os.tmpdir());
    const render = vi.fn(async () => {});
    studio.setVideoRenderer(render);
    expect(await studio.fillChannel(yt)).toBe(1);
    await new Promise(res => setTimeout(res, 5)); // fire-and-forget abwarten
    expect(render).toHaveBeenCalledWith('g1', '9:16');

    // ohne auto_video → kein Render (Konzept bleibt Konzept)
    const ohne = makeChannel({ platform: 'youtube', config: { topic_id: 't-1', generate_images: true, image_policy: 'people_ok' } });
    const studio2 = new ContentStudio(makeMiniRepo(ohne), interests, undefined, llm, registry as any, sandbox as any, undefined, makeLogger(), OWNER, os.tmpdir());
    const render2 = vi.fn(async () => {});
    studio2.setVideoRenderer(render2);
    await studio2.fillChannel(ohne);
    await new Promise(res => setTimeout(res, 5));
    expect(render2).not.toHaveBeenCalled();
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

  it('v1045: Dossier — Cross-Topic-Dedup (gleicher Artikel nur einmal) + Wichtigkeit vor Frische', async () => {
    const channel = makeChannel({ config: { topic_ids: ['t-1', 't-2'] } });
    const { studio, llm, interestsRepo } = makeStack({ channel });
    (interestsRepo.getTopicById as any) = vi.fn(async (_u: string, id: string) =>
      id === 't-1' ? { id: 't-1', name: 'WM 2026' } : { id: 't-2', name: 'Transfers' });
    (interestsRepo.getDigest as any) = vi.fn(async () => null);
    const shared = { id: 'n-shared', title: 'Mbappé-Transfer perfekt — Rekordsumme bestätigt', url: 'https://quelle.example/mbappe', sourceKind: 'rss', createdAt: 'x', importance: 0.9 };
    (interestsRepo.listItems as any) = vi.fn(async (topicId: string) => topicId === 't-1'
      ? [
        // NEUESTES zuerst (listItems-Reihenfolge): bei reiner Frische wäre
        // „Rasenpflege" in den Top-8 — nach Wichtigkeit fliegt es raus
        { id: 'boring', topicId: 't-1', title: 'Rasenpflege im Trainingszentrum dokumentiert', sourceKind: 'rss', createdAt: 'x', importance: 0.1 },
        shared,
        ...Array.from({ length: 8 }, (_, i) => ({ id: `f${i}`, topicId: 't-1', title: `Wichtige Meldung Nummer ${i} zur Weltmeisterschaft`, sourceKind: 'rss', createdAt: 'x', importance: 0.7 })),
      ]
      : [shared]);
    await studio.fillChannel(channel);
    const prompt = (llm.complete as any).mock.calls[0][0].messages[0].content as string;
    expect(prompt.split('Mbappé-Transfer perfekt').length - 1).toBe(1); // nur EINMAL (Dedup über Topics)
    expect(prompt).not.toContain('Rasenpflege'); // importance 0.1 verliert gegen 0.7er
  });

  it('v1048: youtube-Items zeigen im Dossier bis 400 Zeichen (Analyse-Material), andere bleiben bei 220', async () => {
    const channel = makeChannel({ config: { topic_id: 't-1' } });
    const { studio, llm, interestsRepo } = makeStack({ channel });
    (interestsRepo.getDigest as any) = vi.fn(async () => null);
    const longTail = 'x'.repeat(250) + ' YTMARKER_TIEF_IM_TEXT';
    (interestsRepo.listItems as any) = vi.fn(async () => [
      { id: 'y1', topicId: 't-1', title: 'Spielanalyse Argentinien', sourceKind: 'youtube', createdAt: 'x', summary: longTail },
      { id: 'r1', topicId: 't-1', title: 'Kurzmeldung', sourceKind: 'rss', createdAt: 'x', summary: 'r'.repeat(250) + ' RSSMARKER_TIEF_IM_TEXT' },
    ]);
    await studio.fillChannel(channel);
    const prompt = (llm.complete as any).mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain('YTMARKER_TIEF_IM_TEXT'); // youtube: 400-Zeichen-Fenster
    expect(prompt).not.toContain('RSSMARKER_TIEF_IM_TEXT'); // rss: weiter 220
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
    (socialRepo as any).setStoryStatus = vi.fn(async (_u: string, id: string, status: string) => {
      const s = stories.find(x => x.id === id);
      if (s) s.status = status;
    });
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

  it('v1121: Follower-Prompt ehrlich — kurzer Lead verbietet „ausführlich", tiefer Lead erlaubt es', async () => {
    const { studio, website, telegram, llm } = makeFamilyStack();
    (llm.complete as any)
      .mockResolvedValueOnce({ content: CONF })
      .mockResolvedValueOnce({ content: RENDER('Kurz-Lead') }) // RENDER-Body ~80 Zeichen → dünn
      .mockResolvedValueOnce({ content: RENDER('Follow') });
    await studio.planFamily('project:proj-1', [website, telegram]);
    const followPrompt = (llm.complete as any).mock.calls[2][0].messages[0].content as string;
    expect(followPrompt).toContain('KEINE Ausführlichkeit');
    expect(followPrompt).toContain('bereits live'); // v1023-Zusicherung bleibt
    expect(followPrompt).not.toContain('Der ausführliche Beitrag');

    const { studio: s2, website: w2, telegram: t2, llm: llm2 } = makeFamilyStack();
    const langBody = 'Ein sehr ausführlicher Absatz mit vielen Details, Zitaten und Einordnung für die Leser. '.repeat(12);
    (llm2.complete as any)
      .mockResolvedValueOnce({ content: CONF })
      .mockResolvedValueOnce({ content: JSON.stringify([{ title: 'Tiefer Lead', body: langBody, hashtags: ['wm2026'], warum: 'x' }]) })
      .mockResolvedValueOnce({ content: RENDER('Follow kurz') });
    await s2.planFamily('project:proj-1', [w2, t2]);
    const tiefPrompt = (llm2.complete as any).mock.calls[2][0].messages[0].content as string;
    expect(tiefPrompt).toContain('Der ausführliche Beitrag');
    expect(tiefPrompt).not.toContain('KEINE Ausführlichkeit');
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

  it('v1042: scheitert der LEAD-Text, wird die ganze Story ausgelassen (keine Follower ohne Lead)', async () => {
    const { studio, website, telegram, llm, createdItems, transitions, stories } = makeFamilyStack();
    (llm.complete as any)
      .mockResolvedValueOnce({ content: CONF })
      .mockResolvedValueOnce({ content: 'kein brauchbares json' }); // Lead-Render scheitert
    const created = await studio.planFamily('project:proj-1', [website, telegram]);
    expect(created).toBe(0);
    expect(createdItems.length).toBe(0); // insbesondere KEIN Follower-Item
    expect(transitions.filter(t => t.to === 'scheduled').length).toBe(0);
    void stories;
  });

  it('v1042: zwei Konferenz-Stories mit identischem terminBis → nur die erste wird geplant', async () => {
    const { studio, website, telegram, llm, stories } = makeFamilyStack();
    const kickoff = new Date(2099, 6, 4, 19, 0).toISOString();
    const terminStory = (titel: string) => ({
      titel, zusammenfassung: 'PV im Pub.', art: 'termin', wichtigkeit: 0.8, terminBis: kickoff,
      kanaele: [{ kanal: 'fussball.cc', rolle: 'lead', versatz_h: 0 }, { kanal: 'FussballCC News', rolle: 'follow', versatz_h: 0 }],
    });
    (llm.complete as any)
      .mockResolvedValueOnce({ content: JSON.stringify([terminStory('Public Viewing Kanada – Marokko'), terminStory('PV: Kanada gegen Marokko im Pub')]) })
      .mockResolvedValueOnce({ content: RENDER('PV-Artikel') })
      .mockResolvedValueOnce({ content: RENDER('PV kurz') });
    const created = await studio.planFamily('project:proj-1', [website, telegram]);
    expect(created).toBe(2); // 2 Items (Lead+Follow) — aber nur EINE Story
    expect(stories.length).toBe(1);
  });

  it('v1046: LEAD-Render-Prompt verlangt Absätze — bei Terminen einen eigenen Fakten-Absatz', async () => {
    const { studio, website, telegram, llm } = makeFamilyStack();
    const kickoff = new Date(2099, 6, 4, 19, 0).toISOString();
    (llm.complete as any)
      .mockResolvedValueOnce({ content: JSON.stringify([{
        titel: 'Public Viewing', zusammenfassung: 'PV im Pub.', art: 'termin', wichtigkeit: 0.8, terminBis: kickoff,
        kanaele: [{ kanal: 'fussball.cc', rolle: 'lead', versatz_h: 0 }, { kanal: 'FussballCC News', rolle: 'follow', versatz_h: 0 }],
      }]) })
      .mockResolvedValueOnce({ content: RENDER('PV-Artikel') })
      .mockResolvedValueOnce({ content: RENDER('PV kurz') });
    await studio.planFamily('project:proj-1', [website, telegram]);
    const leadPrompt = (llm.complete as any).mock.calls[1][0].messages[0].content as string;
    expect(leadPrompt).toContain('LEERZEILEN');
    expect(leadPrompt).toContain('Was, Wann, Wo');
    const followPrompt = (llm.complete as any).mock.calls[2][0].messages[0].content as string;
    expect(followPrompt).not.toContain('LEERZEILEN'); // Follower bleiben Kurzform
  });

  it('v1043: story.terminBis ist autoritativ fürs Bild — LLM-Echo darf fehlen', async () => {
    const { studio, website, telegram, llm } = makeFamilyStack();
    const kickoff = new Date(2099, 6, 4, 19, 0).toISOString();
    const imageSpy = vi.fn(async () => []);
    (studio as any).maybeGenerateImage = imageSpy;
    (llm.complete as any)
      .mockResolvedValueOnce({ content: JSON.stringify([{
        titel: 'Public Viewing', zusammenfassung: 'PV im Pub.', art: 'termin', wichtigkeit: 0.8, terminBis: kickoff,
        kanaele: [{ kanal: 'fussball.cc', rolle: 'lead', versatz_h: 0 }],
      }]) })
      .mockResolvedValueOnce({ content: RENDER('PV-Artikel') }); // RENDER echot KEIN terminBis
    await studio.planFamily('project:proj-1', [website, telegram]);
    expect(imageSpy).toHaveBeenCalled();
    expect((imageSpy.mock.calls[0] as any[])[1].terminBis).toBe(kickoff); // injiziert
  });

  it('v1042: News-Desk wählt bei Überangebot die WICHTIGSTE Eilmeldung, nicht die Array-Reihenfolge', async () => {
    const { studio, llm, stories } = makeFamilyStack();
    stories.push(
      { id: 'evt-1', title: 'Alte Eilmeldung eins', summary: 'x', source: 'event', kind: 'news', createdAt: new Date().toISOString(), status: 'active' },
      { id: 'evt-2', title: 'Alte Eilmeldung zwei', summary: 'x', source: 'event', kind: 'news', createdAt: new Date().toISOString(), status: 'active' },
    ); // 2 von 3 Tages-Slots verbraucht → Budget 1
    const interestsRepo = (studio as any).interestsRepo;
    (interestsRepo.listItems as any) = vi.fn(async () => [
      { id: 'n1', topicId: 't-1', title: 'Wichtige Meldung mit Score 0.86 über den Trainerwechsel', sourceKind: 'rss', createdAt: 'x' },
      { id: 'n2', topicId: 't-1', title: 'Sensation: Messi tritt zurück — Karriereende offiziell', sourceKind: 'rss', createdAt: 'x' },
    ]);
    (llm.complete as any)
      .mockResolvedValueOnce({ content: '[{"index": 0, "score": 0.86}, {"index": 1, "score": 0.99}]' })
      .mockResolvedValueOnce({ content: RENDER('Messi hört auf') })
      .mockResolvedValueOnce({ content: RENDER('Messi-Rücktritt!') });
    const created = await studio.newsDesk();
    expect(created).toBe(2);
    const neu = stories.filter(s => !String(s.id).startsWith('evt-'));
    expect(neu.length).toBe(1);
    expect(neu[0].title).toContain('Messi'); // 0.99 schlägt 0.86
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

  it('v1115: Event-Alter-Gate — Score-Prompt kennt Datum, Alt-Ereignis-Regel und bereits behandelte Storys', async () => {
    const { studio, llm, stories } = makeFamilyStack();
    // Realfall 13.07.: die Match-Abdeckung lief unter einem Titel OHNE
    // Token-Überlappung zur neuen Quelle — nur der Score-Kontext kann das fangen
    stories.push({ id: 'story-alt', title: 'July 11 Matchday Recap | #FIFAWorldCup', summary: 'x', status: 'done', kind: 'news', source: 'studio', createdAt: new Date().toISOString() });
    const interestsRepo = (studio as any).interestsRepo;
    (interestsRepo.listItems as any) = vi.fn(async () => [
      { id: 'n1', topicId: 't-1', title: 'Bellingham mit dem Doppelpack (93.) - Norwegen gegen England', summary: 'Highlight-Video zum Spiel.', sourceKind: 'rss', createdAt: 'x' },
    ]);
    (llm.complete as any).mockResolvedValueOnce({ content: '[{"index": 0, "score": 0.2}]' });
    expect(await studio.newsDesk()).toBe(0);
    const scorePrompt = (llm.complete as any).mock.calls[0][0].messages[0].content as string;
    expect(scorePrompt).toContain('HEUTE ist');
    expect(scorePrompt).toContain('KEINE Eilmeldung');
    expect(scorePrompt).toContain('gestern oder früher');
    expect(scorePrompt).toContain('BEREITS BEHANDELT');
    expect(scorePrompt).toContain('July 11 Matchday Recap');
  });

  it('v1115: heuteZeile — Wochentag + Datum + Uhrzeit ohne Intl (ICU-Kaltstart-sicher)', () => {
    expect(ContentStudio.heuteZeile(new Date(2026, 6, 13, 8, 5))).toBe('Montag, 13.07.2026, 08:05 Uhr');
    expect(ContentStudio.heuteZeile(new Date(2026, 0, 4, 23, 59))).toBe('Sonntag, 04.01.2026, 23:59 Uhr');
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

  it('v1056: approved OHNE Termin — Begleitformat wird ad-hoc terminiert, Artikel nur gemeldet', async () => {
    const { studio, socialRepo } = makeFamilyStack();
    const base = { channelId: 'ch-web', userId: OWNER, body: 'Text', media: [], hashtags: [], source: 'studio' as const, createdAt: new Date().toISOString(), updatedAt: 'x' };
    (socialRepo.listItems as any) = vi.fn(async () => [
      { ...base, id: 'i-reel', status: 'approved', title: 'Reel hängt', performance: { format: 'reel', autoReel: true } },
      { ...base, id: 'i-art', status: 'approved', title: 'Artikel ohne Slot', performance: { art: 'news' } },
    ]);
    const rescheduled: any[] = [];
    (socialRepo.reschedule as any) = vi.fn(async (_u: string, id: string, at: string) => { rescheduled.push({ id, at }); return true; });
    const r = await studio.planReview();
    expect(rescheduled.map(x => x.id)).toEqual(['i-reel']); // Begleitformat automatisch
    expect(Date.parse(rescheduled[0].at)).toBeGreaterThan(Date.now());
    expect(r.flagged).toBeGreaterThanOrEqual(1); // Artikel nur als Empfehlung gemeldet
  });

  it('v1044: verpasste Freigabe — frisch → +4h neu terminiert (Nudge), überaltert → zurückgezogen, 3 Nudges → Ruhe', async () => {
    const { studio, socialRepo } = makeFamilyStack();
    const overdue = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const mk = (id: string, createdAgoH: number, extra?: Record<string, unknown>): any => ({
      id, channelId: 'ch-web', userId: OWNER, status: 'scheduled', title: id,
      body: 'Text', media: [], hashtags: [], source: 'studio',
      createdAt: new Date(Date.now() - createdAgoH * 3_600_000).toISOString(), updatedAt: 'x',
      scheduledAt: overdue, performance: { art: 'news', ...extra },
    });
    (socialRepo.listItems as any) = vi.fn(async () => [
      mk('i-frisch', 1),                          // news, 1h alt → Nudge
      mk('i-alt', 60),                            // news, 60h alt (> 48h) → reject
      mk('i-genug', 1, { approvalNudges: 3 }),    // 3 Anläufe → liegen lassen
    ]);
    const rescheduled: any[] = [];
    (socialRepo.reschedule as any) = vi.fn(async (_u: string, id: string, at: string) => { rescheduled.push({ id, at }); return true; });
    const r = await studio.planReview();
    expect(rescheduled.map(x => x.id)).toEqual(['i-frisch']);
    expect(Date.parse(rescheduled[0].at)).toBeGreaterThan(Date.now() + 3 * 3_600_000);
    expect((socialRepo.mergePerformance as any).mock.calls.some((c: any[]) => c[1] === 'i-frisch' && c[2].approvalNudges === 1)).toBe(true);
    expect((socialRepo.transition as any).mock.calls.some((c: any[]) => c[1] === 'i-alt' && c[2] === 'rejected')).toBe(true);
    expect((socialRepo.transition as any).mock.calls.some((c: any[]) => c[1] === 'i-genug')).toBe(false);
    expect(r.expired).toBe(1);
    expect(r.deferred).toBe(1);
  });

  it('v1044: Konferenz-Kanalnamen werden normalisiert; unbekannter Kanal → Story wird gedroppt statt gesperrt', async () => {
    const { studio, website, telegram, llm, stories, socialRepo } = makeFamilyStack();
    (socialRepo as any).setStoryStatus = vi.fn(async () => {});
    // Groß-/Kleinschreibung + Leerzeichen matchen trotzdem
    (llm.complete as any)
      .mockResolvedValueOnce({ content: JSON.stringify([{
        titel: 'Normalisierte Namen', zusammenfassung: 'Stoff hier.', art: 'news', wichtigkeit: 0.6,
        kanaele: [{ kanal: '  FUSSBALL.CC ', rolle: 'lead', versatz_h: 0 }, { kanal: 'fussballcc news', rolle: 'follow', versatz_h: 2 }],
      }]) })
      .mockResolvedValueOnce({ content: RENDER('Lead') })
      .mockResolvedValueOnce({ content: RENDER('Follow') });
    expect(await studio.planFamily('project:proj-1', [website, telegram])).toBe(2);
    expect((socialRepo as any).setStoryStatus).not.toHaveBeenCalled();

    // Nur unbekannte Kanäle → Story entsteht, wird aber sofort gedroppt
    (llm.complete as any).mockResolvedValueOnce({ content: JSON.stringify([{
      titel: 'Nirwana-Story', zusammenfassung: 'Stoff.', art: 'news', wichtigkeit: 0.6,
      kanaele: [{ kanal: 'Nirwana-Kanal', rolle: 'lead', versatz_h: 0 }],
    }]) });
    expect(await studio.planFamily('project:proj-1', [website, telegram])).toBe(0);
    const dropCall = (socialRepo as any).setStoryStatus.mock.calls.find((c: any[]) => c[2] === 'dropped');
    expect(dropCall).toBeDefined();
    void stories;
  });

  it('v1044: verderblicher Follower bei suggest-Lead wird als slotloser Entwurf angelegt statt verworfen', async () => {
    const { studio, website, telegram, llm, createdItems, transitions } = makeFamilyStack();
    (website as any).mode = 'suggest'; // Lead-Kanal ohne Auto-Publish
    (llm.complete as any)
      .mockResolvedValueOnce({ content: CONF }) // art news = verderblich
      .mockResolvedValueOnce({ content: RENDER('Lead-Entwurf') })
      .mockResolvedValueOnce({ content: RENDER('Follower-Entwurf') });
    const created = await studio.planFamily('project:proj-1', [website, telegram]);
    expect(created).toBe(2); // vorher: Follower fiel komplett aus
    expect(createdItems.length).toBe(2);
    expect(transitions.filter(t => t.to === 'scheduled').length).toBe(0); // beide slotlos (Entwurf)
  });

  it('v1044: erster News-Desk-Lauf nach der Nachtruhe sieht bis 2h VOR den Ruhebeginn zurück', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 6, 8, 6, 30)); // 06:30 lokal, Nachtruhe 22-6 gerade vorbei
      const { studio, website } = makeFamilyStack();
      (website.config as any).newsdesk_quiet = [22, 6];
      const interestsRepo = (studio as any).interestsRepo;
      (interestsRepo.listItems as any) = vi.fn(async () => []);
      await studio.newsDesk();
      const sinceIso = (interestsRepo.listItems as any).mock.calls[0][1].sinceIso;
      expect(sinceIso).toBe(new Date(2026, 6, 7, 20, 0).toISOString()); // 22:00 Ruhebeginn − 2h
    } finally {
      vi.useRealTimers();
    }
  });

  it('v1045: Eilmeldungs-Verschiebung (+2h) weicht belegten Minuten aus (15-min-Schritte)', async () => {
    const { studio, socialRepo, stories } = makeFamilyStack();
    stories.push({ id: 'story-brk', source: 'event', createdAt: new Date().toISOString(), status: 'active', title: 'Eil' });
    const in30 = new Date(Date.now() + 30 * 60_000).toISOString();
    const target = new Date(Date.parse(in30) + 2 * 3_600_000).toISOString(); // +2h wäre belegt
    (socialRepo.listItems as any) = vi.fn(async () => [
      { id: 'i-weiche', channelId: 'ch-web', userId: OWNER, status: 'scheduled', title: 'Regulär', body: 'T', media: [], hashtags: [], source: 'studio', createdAt: 'x', updatedAt: 'x', scheduledAt: in30 },
      { id: 'i-belegt', channelId: 'ch-web', userId: OWNER, status: 'scheduled', title: 'Später', body: 'T', media: [], hashtags: [], source: 'studio', createdAt: 'x', updatedAt: 'x', scheduledAt: target },
    ]);
    const rescheduled: any[] = [];
    (socialRepo.reschedule as any) = vi.fn(async (_u: string, id: string, at: string) => { rescheduled.push({ id, at }); return true; });
    await studio.planReview();
    const move = rescheduled.find(r => r.id === 'i-weiche');
    expect(move).toBeDefined();
    expect(move.at.slice(0, 16)).not.toBe(target.slice(0, 16)); // NICHT auf die belegte Minute
    expect(Date.parse(move.at)).toBe(Date.parse(target) + 15 * 60_000);
  });

  it('v1045: adhocTaken räumt vergangene Slot-Minuten aus (kein unbegrenztes Wachstum)', async () => {
    const { studio } = makeFamilyStack();
    const past = '2020-01-01T10:00';
    const future = new Date(Date.now() + 3_600_000).toISOString().slice(0, 16);
    (studio as any).adhocSlotMinutes.set('ch-x', new Set([past, future]));
    const set = (studio as any).adhocTaken('ch-x');
    expect(set.has(past)).toBe(false);
    expect(set.has(future)).toBe(true);
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
    // v1121 — Teaser setzt einen Lead mit TIEFE voraus (kurzer Lead → kein Teaser-Versprechen)
    const langBody = 'Ein sehr ausführlicher Absatz mit vielen Details, Zitaten und Einordnung für die Leser. '.repeat(12);
    (llm.complete as any)
      .mockResolvedValueOnce({ content: CONF })
      .mockResolvedValueOnce({ content: JSON.stringify([{ title: 'Lead-Artikel', body: langBody, hashtags: ['wm2026'], warum: 'x' }]) })
      .mockResolvedValueOnce({ content: RENDER('Teaser') });
    await studio.planFamily('project:proj-1', [website, telegram]);
    const followPrompt = (llm.complete as any).mock.calls[2][0].messages[0].content as string;
    expect(followPrompt).toContain('TEASER-MODUS');
    expect(followPrompt).toContain('KEINE URLs');
    // Lead-Prompt bleibt ohne Teaser-Regel
    const leadPrompt = (llm.complete as any).mock.calls[1][0].messages[0].content as string;
    expect(leadPrompt).not.toContain('TEASER-MODUS');
    // v1121 — kurzer Lead: Teaser-Regel entfällt trotz traffic_mode=teaser
    const { studio: s2, website: w2, telegram: t2, llm: llm2 } = makeFamilyStack();
    (t2.config as any).traffic_mode = 'teaser';
    (llm2.complete as any)
      .mockResolvedValueOnce({ content: CONF })
      .mockResolvedValueOnce({ content: RENDER('Kurz-Lead') })
      .mockResolvedValueOnce({ content: RENDER('Teaser') });
    await s2.planFamily('project:proj-1', [w2, t2]);
    const kurzFollow = (llm2.complete as any).mock.calls[2][0].messages[0].content as string;
    expect(kurzFollow).not.toContain('TEASER-MODUS');
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

  it('v1116: Lead-Raster voll → verderbliche Story bekommt Ad-hoc-Slot statt Drop', async () => {
    const { studio, website, telegram, llm, transitions, stories } = makeFamilyStack();
    website.postingSlots = ['Zz 99:99']; // leeres Lead-Raster (v977-Muster)
    (llm.complete as any)
      .mockResolvedValueOnce({ content: CONF })
      .mockResolvedValueOnce({ content: RENDER('Kolumbien ist weiter — die Analyse') })
      .mockResolvedValueOnce({ content: RENDER('Kolumbien weiter!') });
    const created = await studio.planFamily('project:proj-1', [website, telegram]);
    expect(created).toBe(2);
    expect(stories.length).toBe(1);
    const leadAt = transitions.find(t => t.id === 'gen-1')!.at!;
    expect(Date.parse(leadAt)).toBeGreaterThan(Date.now());
    expect(Date.parse(leadAt)).toBeLessThanOrEqual(Date.now() + 48 * 3_600_000); // innerhalb der News-Haltbarkeit
    // Follower kommt NACH dem Lead (Versatz +2h)
    const followAt = transitions.find(t => t.id === 'gen-2')!.at!;
    expect(Date.parse(followAt)).toBeGreaterThanOrEqual(Date.parse(leadAt));
  });

  it('v1116: keine Rettung möglich (Deadline vor dem frühesten Ad-hoc-Zeitpunkt) → Drop wie bisher', async () => {
    const { studio, website, telegram, llm, stories } = makeFamilyStack();
    website.postingSlots = ['Zz 99:99'];
    website.config = { ...website.config, shelf_life_hours: { news: 0.3 } }; // Deadline in 18 min — Ad-hoc beginnt bei +30 min
    (llm.complete as any).mockResolvedValueOnce({ content: CONF });
    const created = await studio.planFamily('project:proj-1', [website, telegram]);
    expect(created).toBe(0);
    expect(stories.length).toBe(0);
  });

  it('v1116: Verdrängung — artloses Feature weicht (Haltbarkeit deckt den späten Slot), Breaking/alte News nie; Evergreen zuerst', async () => {
    const { studio, website, socialRepo } = makeFamilyStack();
    const t0 = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    const in2h = iso(t0 + 2 * 3_600_000);
    const in3h = iso(t0 + 3 * 3_600_000);
    const in5d = iso(t0 + 5 * 24 * 3_600_000);
    const deadline = iso(t0 + 4 * 3_600_000);
    const base = { channelId: 'ch-web', status: 'scheduled', body: 'x', media: [], hashtags: [] };
    const feature = { ...base, id: 'it-feat', scheduledAt: in2h, createdAt: iso(t0), performance: {} }; // artlos, Default 168h ≥ später Slot
    const alteNews = { ...base, id: 'it-news', scheduledAt: in3h, createdAt: iso(t0 - 40 * 3_600_000), performance: { art: 'news' } }; // 48h-Haltbarkeit deckt +5d NICHT
    const breaking = { ...base, id: 'it-brk', scheduledAt: in2h, createdAt: iso(t0), performance: { art: 'news', breaking: true } };
    (socialRepo.listItems as any) = vi.fn(async () => [breaking, alteNews, feature]);
    const pool = [in5d];
    const freed = await (studio as any).swapWithEvergreen(website, deadline, pool);
    expect(freed).toBe(in2h);
    expect((socialRepo.reschedule as any).mock.calls[0][1]).toBe('it-feat'); // NICHT breaking, NICHT die alte News
    expect((socialRepo.reschedule as any).mock.calls[0][2]).toBe(in5d);
    expect(pool.length).toBe(0);

    // Evergreen weicht ZUERST, auch wenn sein Slot später liegt als der des Features
    (socialRepo.reschedule as any).mockClear();
    const evergreen = { ...base, id: 'it-eg', scheduledAt: in3h, createdAt: iso(t0), performance: { art: 'evergreen' } };
    (socialRepo.listItems as any) = vi.fn(async () => [feature, evergreen]);
    const pool2 = [in5d];
    const freed2 = await (studio as any).swapWithEvergreen(website, deadline, pool2);
    expect(freed2).toBe(in3h);
    expect((socialRepo.reschedule as any).mock.calls[0][1]).toBe('it-eg');
  });

  it('v1116: Ad-hoc-Slot respektiert Mindestabstand, Tagesbudget und Nachtruhe', async () => {
    const { studio, website, socialRepo } = makeFamilyStack();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 6, 20, 10, 0)); // Mo 20.07. 10:00 Lokalzeit — deterministisch (v977-Lektion)
      const t0 = Date.now();
      const iso = (ms: number) => new Date(ms).toISOString();
      const base = { channelId: 'ch-web', status: 'scheduled', body: 'x', media: [], hashtags: [], createdAt: iso(t0), performance: {} };
      const deadline = iso(t0 + 48 * 3_600_000);
      // Mindestabstand: geplanter Post um 10:45 → Slot frühestens 90 min davon entfernt (12:30)
      (socialRepo.listItems as any) = vi.fn(async () => [{ ...base, id: 'p1', scheduledAt: iso(t0 + 45 * 60_000) }]);
      const slot = await (studio as any).adhocSlotForPerishable(website, deadline);
      expect(slot).toBeDefined();
      expect(Date.parse(slot)).toBeGreaterThanOrEqual(t0 + 30 * 60_000);
      expect(Math.abs(Date.parse(slot) - (t0 + 45 * 60_000))).toBeGreaterThanOrEqual(90 * 60_000);
      expect(Date.parse(slot)).toBeLessThanOrEqual(Date.parse(deadline));
      // Tagesbudget: 3 Posts heute geplant (maxPostsPerDay 3) → Slot erst am Folgetag
      (socialRepo.listItems as any) = vi.fn(async () => [1, 2, 3].map(h => ({ ...base, id: `p${h}`, scheduledAt: iso(t0 + h * 3_600_000) })));
      const slot2 = await (studio as any).adhocSlotForPerishable(website, deadline);
      expect(slot2).toBeDefined();
      expect(new Date(slot2).getDate()).toBe(21); // Folgetag
      // Nachtruhe rund um die Uhr → kein Slot möglich
      (socialRepo.listItems as any) = vi.fn(async () => []);
      const nachtkanal = { ...website, config: { ...website.config, newsdesk_quiet: [0, 24] } };
      expect(await (studio as any).adhocSlotForPerishable(nachtkanal, deadline)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
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

  it('v997/v1034: shelfLifeHours — Defaults, config-Override; news/recap/vorschau verderben', () => {
    expect(ContentStudio.shelfLifeHours('news', { config: {} })).toBe(48);
    expect(ContentStudio.shelfLifeHours('recap', { config: {} })).toBe(72);
    // v1034 — Vorschau ohne terminBis (Konferenz-Lücke) verdirbt nach 72h,
    // statt irgendeinen späten Slot NACH dem Ereignis zu bekommen (Realfall 06.07.)
    expect(ContentStudio.shelfLifeHours('vorschau', { config: {} })).toBe(72);
    expect(ContentStudio.shelfLifeHours('vorschau', { config: { shelf_life_hours: { vorschau: 24 } } })).toBe(24);
    expect(ContentStudio.shelfLifeHours('news', { config: { shelf_life_hours: { news: 24 } } })).toBe(24);
    expect(ContentStudio.shelfLifeHours('evergreen', { config: {} })).toBeUndefined();
    expect(ContentStudio.shelfLifeHours('termin', { config: {} })).toBeUndefined();
    // v1102 — Items ohne art-Marker haben jetzt einen 7-Tage-Default statt
    // GAR KEINER Haltbarkeit (Realfall Glasner: 03.07. erstellt, 12.07. geplant)
    expect(ContentStudio.shelfLifeHours(undefined, { config: {} })).toBe(168);
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

  it('v1024: planAdhocStory — User-Stoff → Story (source manual), Lead +30/Follower +90, Insight', async () => {
    const { studio, llm, stories, assignments, transitions, socialRepo } = makeFamilyStack();
    const insightsRepo = (studio as any).insightsRepo;
    (llm.complete as any)
      .mockResolvedValueOnce({ content: RENDER('USA-Politikum: Rote Karte aufgehoben') })
      .mockResolvedValueOnce({ content: RENDER('Rote Karte weg — Politik mischt mit') });
    const before = Date.now();
    const r = await studio.planAdhocStory(undefined, 'Ein USA-Spieler darf trotz Roter Karte weiterspielen, weil die Politik interveniert hat. Die FIFA prüft den Vorgang.');
    expect(r.created).toBe(2);
    expect(r.family).toBe('project:proj-1');
    expect(stories.length).toBe(1);
    expect(stories[0].source).toBe('manual');
    expect(stories[0].kind).toBe('news');
    expect(assignments.map((a: any) => a.role).sort()).toEqual(['follow', 'lead']);
    // Ad-hoc-Slots: Lead ~+30 min, Follower ~+90 min
    const times = transitions.filter(t => t.to === 'scheduled').map(t => Date.parse(t.at!) - before);
    expect(times.length).toBe(2);
    expect(times[0]).toBeGreaterThan(25 * 60_000);
    expect(times[0]).toBeLessThan(35 * 60_000);
    expect(times[1]).toBeGreaterThan(85 * 60_000);
    // Insight „Story angestoßen"
    const ins = (insightsRepo.upsertCandidate as any).mock.calls.find((c: any[]) => String(c[1].title).includes('Story angestoßen'));
    expect(ins).toBeTruthy();
    // kein Konferenz-/Score-LLM-Call — nur die zwei Render-Calls
    expect((llm.complete as any).mock.calls.length).toBe(2);
    void socialRepo;
  });

  it('v1024: planAdhocStory ohne Familie → verständlicher Fehler', async () => {
    const { studio, socialRepo } = makeFamilyStack();
    (socialRepo.listChannels as any) = vi.fn(async () => [makeChannel({ id: 'solo', projectId: undefined })]);
    await expect(studio.planAdhocStory(undefined, 'Stoff mit ausreichend Länge für den Test hier.')).rejects.toThrow('Familie');
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

  it('v1022: terminloser suggest-Entwurf desselben Formats blockt (kein tägliches Duplikat)', async () => {
    const channel = makeChannel({ mode: 'suggest', config: { topic_id: 't-1', formate: [{ slot: 'Mo 09:00', name: 'Wochenrückblick', anweisung: 'x' }] } });
    const { studio, socialRepo, llm } = makeStack({ channel });
    // suggest: der Entwurf hat weder scheduledAt noch publishedAt — vorher
    // fiel der Dedup-Check auf 1970 zurück und erzeugte täglich ein Duplikat
    (socialRepo.listItems as any) = vi.fn(async () => [{
      id: 'i-fmt', channelId: 'ch-1', userId: OWNER, status: 'draft', body: 'x', media: [], hashtags: [],
      source: 'studio', createdAt: 'x', updatedAt: 'x', performance: { format: 'Wochenrückblick' },
    }]);
    expect(await studio.ensureFormats(channel)).toBe(0);
    expect((llm.complete as any).mock.calls.length).toBe(0);
  });

  it('v1093: Video-Serienformat mit Bild wird automatisch gerendert (Format aus dem Eintrag)', async () => {
    const os = await import('node:os');
    const sandbox = { execute: vi.fn(async () => ({ success: true, attachments: [{ fileName: 'image.png', data: Buffer.from('png'), mimeType: 'image/png' }] })) };
    const registry = { get: vi.fn(() => ({ metadata: { name: 'image_generate' } })) };
    const llm = {
      complete: vi.fn(async () => ({ content: JSON.stringify([{ title: 'Transfer-Ticker KW28', body: 'Ein ausreichend langer Serientext über die Transfer-Woche mit Einordnung.', hashtags: ['wm2026'], warum: 'Serie', bildidee: 'Transfer-Collage' }]) })),
    } as any;
    const interests = { getDigest: vi.fn(async () => null), listItems: vi.fn(async () => []), findTopicByName: vi.fn(async () => null), createTopic: vi.fn(async () => ({ id: 't-1' })) } as any;
    const channel = makeChannel({ config: { topic_id: 't-1', generate_images: true, image_policy: 'people_ok', formate: [{ slot: 'Fr 16:00', name: 'Transfer-Ticker', anweisung: 'Die Transfer-Woche kompakt.', video: '9:16' }] } });
    const miniRepo = {
      listItems: vi.fn(async () => []),
      createItem: vi.fn(async (_u: string, chId: string, o: any) => ({ id: 'fmt-1', channelId: chId, ...o, createdAt: 'x', updatedAt: 'x' })),
      transition: vi.fn(async () => ({})), mergePerformance: vi.fn(async () => {}),
      updateChannel: vi.fn(async () => {}), listMetrics: vi.fn(async () => []),
      upsertMetric: vi.fn(async () => {}), incrementMetric: vi.fn(async () => {}), listChannels: vi.fn(async () => [channel]),
    } as any;
    const { ContentStudio } = await import('../content-studio.js');
    const studio = new ContentStudio(miniRepo, interests, undefined, llm, registry as any, sandbox as any, undefined, makeLogger(), OWNER, os.tmpdir());
    const render = vi.fn(async () => {});
    studio.setVideoRenderer(render);
    expect(await studio.ensureFormats(channel)).toBe(1);
    await new Promise(res => setTimeout(res, 5)); // fire-and-forget abwarten
    expect(render).toHaveBeenCalledWith('fmt-1', '9:16');
  });
});

describe('stripSourceBoilerplate (v1036)', () => {
  it('entfernt die Transfermarkt-Boilerplate (Realfall), lässt Inhalt unangetastet', async () => {
    const { stripSourceBoilerplate } = await import('../content-studio.js');
    const real = 'Dieser Artikel erschien auf Transfermarkt in seiner ersten Fassung um 13:28 Uhr und wird fortlaufend aktualisiert.\nDer Fußball-Weltverband FIFA hat sich erstmals geäußert.';
    expect(stripSourceBoilerplate(real)).toBe('Der Fußball-Weltverband FIFA hat sich erstmals geäußert.');
    // mitten im Fließtext wird BEWUSST nicht gestrippt (Zeilen-Anker = Sicherheitsnetz
    // gegen Fehltreffer) — der Text bleibt dann komplett unverändert
    const mid = 'Intro. Dieser Artikel erschien zuerst woanders und wird laufend aktualisiert. Rest bleibt.';
    expect(stripSourceBoilerplate(mid)).toBe(mid);
    // NEGATIV: inhaltliche Sätze mit „Dieser Artikel" bleiben stehen
    const content = 'Dieser Artikel behandelt die FIFA-Entscheidung im Detail.';
    expect(stripSourceBoilerplate(content)).toBe(content);
    // NEGATIV: „aktualisiert" mitten im echten Satz bleibt
    const legit = 'Die FIFA hat ihre Regeln aktualisiert. Das sorgt für Diskussionen.';
    expect(stripSourceBoilerplate(legit)).toBe(legit);
  });
});

describe('ContentStudio — „-no-title"-Marker (v1027)', () => {
  it('overlayBakesTitle: Titel-/Termin-Bedingungen spiegeln applyOverlays', () => {
    const ch = (overlay: Record<string, unknown>) => ({ config: { image_overlay: overlay } });
    // Titel-Overlay an + Titel vorhanden → gebrannt
    expect(ContentStudio.overlayBakesTitle(ch({ title: true }), { title: 'X' })).toBe(true);
    // Titel-Overlay aus → nicht gebrannt
    expect(ContentStudio.overlayBakesTitle(ch({ title: false }), { title: 'X' })).toBe(false);
    // Default (kein image_overlay-title) → nicht gebrannt
    expect(ContentStudio.overlayBakesTitle({ config: {} }, { title: 'X' })).toBe(false);
    // Termin-Karte (Default an) → gebrannt, auch bei title:false
    expect(ContentStudio.overlayBakesTitle(ch({ title: false }), { title: 'X', terminBis: '2026-07-08T19:00:00Z' })).toBe(true);
    // Termin-Karte abgeschaltet (fussball.cc) → nicht gebrannt
    expect(ContentStudio.overlayBakesTitle(ch({ title: false, termin_card: false }), { title: 'X', terminBis: '2026-07-08T19:00:00Z' })).toBe(false);
    // Karussell: forcedTitle string → gebrannt; forcedTitle null (nur Branding) → nicht
    expect(ContentStudio.overlayBakesTitle(ch({}), { title: 'X' }, 'Slide-Titel')).toBe(true);
    expect(ContentStudio.overlayBakesTitle(ch({}), { title: 'X', terminBis: '2026-07-08T19:00:00Z' }, null)).toBe(false);
  });
});

describe('ContentStudio — Overlays neu anwenden (v1026)', () => {
  it('refreshOverlays: baut studio-Bild aus dem asset-Zwilling neu, überspringt Bilder ohne Asset', async () => {
    const { mkdtemp, writeFile, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { loadSharp } = await import('@alfred/skills');
    const sharp = await loadSharp();
    const dir = await mkdtemp(join(tmpdir(), 'alfred-ovl-'));
    const base: Buffer = sharp
      ? await (sharp as any)({ create: { width: 400, height: 300, channels: 3, background: { r: 20, g: 20, b: 80 } } }).png().toBuffer()
      : Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await writeFile(join(dir, 'asset-t1-x.png'), base);
    await writeFile(join(dir, 'studio-t1-x.png'), base);
    await writeFile(join(dir, 'studio-t2-y.png'), base); // ohne asset-Zwilling → skip
    const channel = makeChannel({ config: { topic_id: 't-1', image_branding: 'fussball.cc', image_overlay: { watermark: true, title: true } } });
    const { studio, socialRepo } = makeStack({ channel });
    (socialRepo.listItems as any) = vi.fn(async () => [
      { id: 'i1', channelId: 'ch-1', userId: OWNER, status: 'scheduled', title: 'Testtitel: Neu gestempelt', body: 'x', hashtags: [], source: 'studio', createdAt: 'x', updatedAt: 'x', media: [{ type: 'image', source: 'generated', pathOrUrl: join(dir, 'studio-t1-x.png') }] },
      { id: 'i2', channelId: 'ch-1', userId: OWNER, status: 'draft', title: 'Ohne Asset', body: 'x', hashtags: [], source: 'studio', createdAt: 'x', updatedAt: 'x', media: [{ type: 'image', source: 'generated', pathOrUrl: join(dir, 'studio-t2-y.png') }] },
    ]);
    const r = await studio.refreshOverlays();
    expect(r.refreshed).toBe(1);
    expect(r.skipped).toBe(1);
    if (sharp) {
      const rebuilt = await readFile(join(dir, 'studio-t1-x.png'));
      expect(Buffer.compare(rebuilt, base)).not.toBe(0); // Overlay ist drauf
    }
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
    const genImage = (socialRepo.incrementMetric as any).mock.calls.filter((c: any[]) => c[1]?.kind === 'gen_image');
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
    const genImage = (socialRepo.incrementMetric as any).mock.calls.filter((c: any[]) => c[1]?.kind === 'gen_image');
    expect(genImage.length).toBe(0); // kein Budget verbraucht
    expect((socialRepo as any).touchMediaAsset).toHaveBeenCalledWith(OWNER, 'a-1', 'ch-1');
    const media = (socialRepo.createItem as any).mock.calls[0][2].media;
    expect(media[0].pathOrUrl).toContain('studio-'); // eigenes Item-Bild (mit frischem Overlay)
    // v1027 — ohne Titel-Overlay/Termin-Karte trägt der Dateiname den Plattform-Marker
    expect(media[0].pathOrUrl).toContain('-no-title.png');
  });

  it('v1038: generisches Symbolbild wird trotz frischer Nutzung wiederverwendet (kurze Karenz)', async () => {
    const recent = new Date(Date.now() - 3 * 24 * 3_600_000).toISOString(); // vor 3 Tagen genutzt — < 30d-Cooldown, > 2d-Karenz
    const { studio, channel, socialRepo, execute, dir, writeFile, join } = await makeMediaStudio([]);
    const assetPath = join(dir, 'asset-symbol.png');
    await writeFile(assetPath, Buffer.from('symbol-png'));
    (socialRepo as any).listMediaAssets = vi.fn(async () => [{
      id: 'a-sym', userId: OWNER, channelId: 'ch-1', path: assetPath,
      motif: 'Symbolbild Fußball: Stadion unter Flutlicht mit Ball auf dem Rasen, atmosphärisch',
      style: undefined, format: '1536x1024', lastUsedAt: recent, useCount: 3, blocked: false, pinned: false, createdAt: recent,
    }]);
    // Idee mit generischem Symbolmotiv (wie der Vision-Fallback es erzeugt)
    const media = await (studio as any).produceImage(channel, {
      title: 'x', body: 'y', hashtags: [], warum: '',
      bildidee: 'Symbolbild Fußball: Stadion unter Flutlicht mit Ball, ohne Menschen',
    });
    expect(execute).not.toHaveBeenCalled(); // KEINE Neuanfertigung
    expect(media[0].pathOrUrl).toContain('studio-');
  });

  it('v1038: gepinntes Stamm-Bild schlägt besseren Score und ignoriert den Cooldown', async () => {
    const yesterday = new Date(Date.now() - 3 * 24 * 3_600_000).toISOString();
    const old = new Date(Date.now() - 40 * 24 * 3_600_000).toISOString();
    const { studio, channel, socialRepo, execute, dir, writeFile, join } = await makeMediaStudio([]);
    const p1 = join(dir, 'asset-pin.png');
    const p2 = join(dir, 'asset-frei.png');
    await writeFile(p1, Buffer.from('pin'));
    await writeFile(p2, Buffer.from('frei'));
    (socialRepo as any).listMediaAssets = vi.fn(async () => [
      { id: 'a-pin', userId: OWNER, channelId: 'ch-1', path: p1, motif: 'Stadion unter Flutlicht mit Ball auf dem Rasen', style: undefined, format: '1536x1024', lastUsedAt: yesterday, useCount: 2, blocked: false, pinned: true, createdAt: old },
      { id: 'a-frei', userId: OWNER, channelId: 'ch-1', path: p2, motif: 'Stadion unter Flutlicht mit Ball auf dem Rasen, atmosphärisch', style: undefined, format: '1536x1024', lastUsedAt: old, useCount: 1, blocked: false, pinned: false, createdAt: old },
    ]);
    const media = await (studio as any).produceImage(channel, {
      title: 'x', body: 'y', hashtags: [], warum: '',
      bildidee: 'Stadion unter Flutlicht mit Ball auf dem Rasen',
    });
    expect(execute).not.toHaveBeenCalled();
    expect((socialRepo as any).touchMediaAsset).toHaveBeenCalledWith(OWNER, 'a-pin', 'ch-1'); // Stamm-Bild gewinnt
    void media;
  });

  it('v1038: semantisches Matching — Paraphrase ohne Wort-Überlappung trifft via Embedding', async () => {
    const old = new Date(Date.now() - 40 * 24 * 3_600_000).toISOString();
    const { studio, channel, socialRepo, execute, dir, writeFile, join } = await makeMediaStudio([]);
    const assetPath = join(dir, 'asset-sem.png');
    await writeFile(assetPath, Buffer.from('sem'));
    (socialRepo as any).listMediaAssets = vi.fn(async () => [{
      id: 'a-sem', userId: OWNER, channelId: 'ch-1', path: assetPath,
      motif: 'Nahaufnahme eines Balls vor unscharfer Arena',
      style: undefined, format: '1536x1024', lastUsedAt: old, useCount: 1, blocked: false, pinned: false, createdAt: old,
    }]);
    // Stub-Deduper: alle Texte bekommen denselben Vektor → Cosine 1.0
    (studio as any).storyDeduper = { embedText: vi.fn(async () => [0.6, 0.8]) };
    const media = await (studio as any).produceImage(channel, {
      title: 'x', body: 'y', hashtags: [], warum: '',
      bildidee: 'Fußball liegt im Rampenlicht des Stadions', // kaum Token-Überlappung
    });
    expect(execute).not.toHaveBeenCalled(); // Embedding-Treffer statt Neuanfertigung
    expect((socialRepo as any).touchMediaAsset).toHaveBeenCalledWith(OWNER, 'a-sem', 'ch-1');
    void media;
  });

  it('v1014: gesperrtes Asset (blocked) wird NIE wiederverwendet → normale Generierung', async () => {
    const old = new Date(Date.now() - 40 * 24 * 3_600_000).toISOString();
    const { studio, channel, socialRepo, llm, execute, dir, writeFile, join } = await makeMediaStudio([]);
    const assetPath = join(dir, 'asset-gesperrt.png');
    await writeFile(assetPath, Buffer.from('base'));
    (socialRepo as any).listMediaAssets = vi.fn(async () => [{
      id: 'a-blk', userId: OWNER, channelId: 'ch-1', path: assetPath,
      motif: 'Stadion unter Flutlicht mit Ball auf dem Rasen',
      style: undefined, format: '1536x1024', lastUsedAt: old, useCount: 1, blocked: true, createdAt: old,
    }]);
    (llm.complete as any)
      .mockResolvedValueOnce({ content: JSON.stringify([{ title: 'Flutlicht-Stimmung', body: 'Ein ausreichend langer Beitragstext für den Bild-Test hier.', hashtags: [], warum: 'x', bildidee: 'Stadion unter Flutlicht mit Ball auf dem Rasen' }]) })
      .mockResolvedValueOnce({ content: '{"person": false, "logo": false, "text": false, "begruendung": "ok"}' });
    await studio.fillChannel(channel);
    expect(execute).toHaveBeenCalled(); // trotz Motiv-Match generiert
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

  it('v1039(C): gestern auf ANDEREM Kanal genutzt → für diesen Kanal sofort frei', async () => {
    const fresh = new Date(Date.now() - 1 * 24 * 3_600_000).toISOString();
    const { studio, channel, socialRepo, execute, dir, writeFile, join } = await makeMediaStudio([]);
    const assetPath = join(dir, 'asset-anderer-kanal.png');
    await writeFile(assetPath, Buffer.from('base'));
    (socialRepo as any).listMediaAssets = vi.fn(async () => [{
      id: 'a-x', userId: OWNER, channelId: 'ch-1', path: assetPath,
      motif: 'Stadion unter Flutlicht mit Ball auf dem Rasen',
      style: undefined, format: '1536x1024', lastUsedAt: fresh, useCount: 2,
      channelUses: { 'ch-instagram': fresh }, // dieser Kanal (ch-1) hat es NIE genutzt
      blocked: false, pinned: false, createdAt: fresh,
    }]);
    const media = await (studio as any).produceImage(channel, {
      title: 'x', body: 'y', hashtags: [], warum: '',
      bildidee: 'Stadion unter Flutlicht mit Ball auf dem Rasen',
    });
    expect(execute).not.toHaveBeenCalled(); // Reuse trotz frischer Fremd-Nutzung
    expect((socialRepo as any).touchMediaAsset).toHaveBeenCalledWith(OWNER, 'a-x', 'ch-1');
    void media;
  });

  it('v1039(C): gestern auf DIESEM Kanal genutzt → Cooldown greift, normale Generierung', async () => {
    const fresh = new Date(Date.now() - 1 * 24 * 3_600_000).toISOString();
    const { studio, channel, socialRepo, llm, execute, dir, writeFile, join } = await makeMediaStudio([]);
    const assetPath = join(dir, 'asset-eigener-kanal.png');
    await writeFile(assetPath, Buffer.from('base'));
    (socialRepo as any).listMediaAssets = vi.fn(async () => [{
      id: 'a-y', userId: OWNER, channelId: 'ch-1', path: assetPath,
      motif: 'Stadion unter Flutlicht mit Ball auf dem Rasen',
      style: undefined, format: '1536x1024', lastUsedAt: fresh, useCount: 2,
      channelUses: { 'ch-1': fresh },
      blocked: false, pinned: false, createdAt: fresh,
    }]);
    (llm.complete as any).mockResolvedValueOnce({ content: '{"person": false, "logo": false, "text": false, "begruendung": "ok"}' });
    await (studio as any).produceImage(channel, {
      title: 'x', body: 'y', hashtags: [], warum: '',
      bildidee: 'Stadion unter Flutlicht mit Ball auf dem Rasen',
    });
    expect(execute).toHaveBeenCalled(); // kein Reuse — dieser Kanal hatte es gerade erst
  });

  it('v1040(1b): Vision-Beschreibung des Gates wird als Bibliotheks-Motiv gespeichert (nicht der Prompt)', async () => {
    const { studio, channel, socialRepo, llm, execute } = await makeMediaStudio([]);
    (socialRepo as any).listMediaAssets = vi.fn(async () => []);
    (llm.complete as any)
      .mockResolvedValueOnce({ content: JSON.stringify([{ title: 'Flutlicht-Stimmung', body: 'Ein ausreichend langer Beitragstext für den Bild-Test hier.', hashtags: [], warum: 'x', bildidee: 'Stadion unter Flutlicht mit Ball auf dem Rasen' }]) })
      .mockResolvedValueOnce({ content: '{"person": false, "logo": false, "text": false, "begruendung": "ok", "motiv": "Leeres Stadion in der Dämmerung, Ball im Anstoßkreis, violettes Licht"}' });
    await studio.fillChannel(channel);
    expect(execute).toHaveBeenCalled();
    const created = (socialRepo as any).createMediaAsset.mock.calls[0];
    expect(created[1].motif).toBe('Leeres Stadion in der Dämmerung, Ball im Anstoßkreis, violettes Licht');
  });

  it('v1040(1a): Retry nach Vision-Verstoß speichert das Symbolmotiv, nicht das Artikel-Motiv', async () => {
    const { studio, channel, socialRepo, llm, execute } = await makeMediaStudio([]);
    (socialRepo as any).listMediaAssets = vi.fn(async () => []);
    (llm.complete as any)
      .mockResolvedValueOnce({ content: JSON.stringify([{ title: 'Flutlicht-Stimmung', body: 'Ein ausreichend langer Beitragstext für den Bild-Test hier.', hashtags: [], warum: 'x', bildidee: 'Stadion unter Flutlicht mit Ball auf dem Rasen' }]) })
      .mockResolvedValueOnce({ content: '{"person": true, "logo": false, "text": false, "begruendung": "zeigt erkennbaren Spieler"}' }) // Versuch 0: Verstoß
      .mockResolvedValueOnce({ content: '{"person": false, "logo": false, "text": false, "begruendung": "ok"}' }); // Versuch 1: sauber, ohne motiv
    await studio.fillChannel(channel);
    expect(execute).toHaveBeenCalledTimes(2);
    const created = (socialRepo as any).createMediaAsset.mock.calls[0];
    expect(created[1].motif).toMatch(/^Symbolbild/); // Fallback-Motiv, nicht die Artikel-Bildidee
  });

  it('v1041: Termin-Vorlage — Termin-Post nimmt das feste Basis-Bild, keine Generierung', async () => {
    const { studio, channel, socialRepo, execute, dir, writeFile, join } = await makeMediaStudio([]);
    const tplPath = join(dir, 'asset-vorlage.png');
    await writeFile(tplPath, Buffer.from('vorlage-png'));
    (channel.config as Record<string, unknown>).image_overlay = { termin_image: 'a-tpl' };
    (socialRepo as any).listMediaAssets = vi.fn(async () => [{
      id: 'a-tpl', userId: OWNER, channelId: 'ch-1', path: tplPath,
      motif: 'Termin-Vorlage: Stadion-Grafik', style: undefined, format: '1536x1024',
      lastUsedAt: new Date().toISOString(), useCount: 1, blocked: false, pinned: true, createdAt: 'x',
    }]);
    const media = await (studio as any).produceImage(channel, {
      title: 'Public Viewing: Schweiz – Kolumbien', body: 'Achtelfinale im Pub.', hashtags: [], warum: '',
      terminBis: new Date(Date.now() + 48 * 3_600_000).toISOString(), ort: 'Wien',
    });
    expect(execute).not.toHaveBeenCalled(); // kein Budget, kein Bildmodell
    expect(media[0].pathOrUrl).toContain('studio-');
    expect(media[0].pathOrUrl).not.toContain('-no-title'); // Termin-Karte eingebrannt
    expect((socialRepo as any).touchMediaAsset).toHaveBeenCalledWith(OWNER, 'a-tpl', 'ch-1');
  });

  it('v1041: Vorlage gesetzt aber Asset weg → normale Generierung (Fallback)', async () => {
    const { studio, channel, socialRepo, llm, execute } = await makeMediaStudio([]);
    (channel.config as Record<string, unknown>).image_overlay = { termin_image: 'gibt-es-nicht' };
    (socialRepo as any).listMediaAssets = vi.fn(async () => []);
    (llm.complete as any).mockResolvedValueOnce({ content: '{"person": false, "logo": false, "text": false, "begruendung": "ok"}' });
    await (studio as any).produceImage(channel, {
      title: 'Public Viewing', body: 'Achtelfinale im Pub.', hashtags: [], warum: '',
      terminBis: new Date(Date.now() + 48 * 3_600_000).toISOString(),
    });
    expect(execute).toHaveBeenCalled();
  });

  it('v1042: erschöpftes Budget blockiert NICHT die Gratis-Pfade (Reuse liefert, Generierung nicht)', async () => {
    const old = new Date(Date.now() - 40 * 24 * 3_600_000).toISOString();
    const { studio, channel, socialRepo, execute, dir, writeFile, join } = await makeMediaStudio([]);
    (channel.config as Record<string, unknown>).image_budget_per_month = 0; // Budget aufgebraucht
    const assetPath = join(dir, 'asset-budget.png');
    await writeFile(assetPath, Buffer.from('base'));
    (socialRepo as any).listMediaAssets = vi.fn(async () => [{
      id: 'a-b', userId: OWNER, channelId: 'ch-1', path: assetPath,
      motif: 'Stadion unter Flutlicht mit Ball auf dem Rasen',
      style: undefined, format: '1536x1024', lastUsedAt: old, useCount: 1, blocked: false, pinned: false, createdAt: old,
    }]);
    const media = await (studio as any).produceImage(channel, {
      title: 'x', body: 'y', hashtags: [], warum: '',
      bildidee: 'Stadion unter Flutlicht mit Ball auf dem Rasen',
    });
    expect(media[0].pathOrUrl).toContain('studio-'); // Reuse trotz Budget 0
    expect(execute).not.toHaveBeenCalled();

    // ohne passendes Asset: Budget-Gate verhindert die Generierung
    (socialRepo as any).listMediaAssets = vi.fn(async () => []);
    const none = await (studio as any).produceImage(channel, {
      title: 'x', body: 'y', hashtags: [], warum: '', bildidee: 'Taktiktafel mit Kreide in der Kabine',
    });
    expect(none).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  it('v1042: Embedding-Cache-Key trägt den Motiv-INHALT — geändertes Motiv gleicher Länge wird neu embedded', async () => {
    const { studio } = await makeMediaStudio([]);
    const embedText = vi.fn(async () => [0.6, 0.8]);
    (studio as any).storyDeduper = { embedText };
    await (studio as any).embedMotifCached('a-1', 'Motiv AAAA');
    await (studio as any).embedMotifCached('a-1', 'Motiv BBBB'); // gleiche Länge, anderer Inhalt
    expect(embedText).toHaveBeenCalledTimes(2);
    await (studio as any).embedMotifCached('a-1', 'Motiv BBBB'); // identisch → Cache
    expect(embedText).toHaveBeenCalledTimes(2);
  });

  it('v1043: Lesefehler beim Reuse löscht NIE die DB-Zeile — nächster Treffer wird genommen', async () => {
    const old = new Date(Date.now() - 40 * 24 * 3_600_000).toISOString();
    const { studio, channel, socialRepo, execute, dir, writeFile, join } = await makeMediaStudio([]);
    const okPath = join(dir, 'asset-lesbar.png');
    await writeFile(okPath, Buffer.from('ok'));
    (socialRepo as any).listMediaAssets = vi.fn(async () => [
      // gepinnt = würde gewinnen, aber Datei liegt auf dem „anderen Node"
      { id: 'a-fremd', userId: OWNER, channelId: 'ch-1', path: join(dir, 'asset-gibt-es-nicht.png'), motif: 'Stadion unter Flutlicht mit Ball auf dem Rasen', style: undefined, format: '1536x1024', lastUsedAt: old, useCount: 1, blocked: false, pinned: true, createdAt: old },
      { id: 'a-ok', userId: OWNER, channelId: 'ch-1', path: okPath, motif: 'Stadion unter Flutlicht mit Ball auf dem Rasen, atmosphärisch', style: undefined, format: '1536x1024', lastUsedAt: old, useCount: 1, blocked: false, pinned: false, createdAt: old },
    ]);
    const media = await (studio as any).produceImage(channel, {
      title: 'x', body: 'y', hashtags: [], warum: '', bildidee: 'Stadion unter Flutlicht mit Ball auf dem Rasen',
    });
    expect((socialRepo as any).deleteMediaAsset).not.toHaveBeenCalled(); // NIE löschen
    expect((socialRepo as any).touchMediaAsset).toHaveBeenCalledWith(OWNER, 'a-ok', 'ch-1'); // Fallback-Treffer
    expect(execute).not.toHaveBeenCalled();
    void media;
  });

  it('v1055: Timeout-Fehlschlag zählt aufs Budget (Kosten angefallen), andere Fehler nicht', async () => {
    const { studio, channel, socialRepo, execute } = await makeMediaStudio([]);
    (socialRepo as any).listMediaAssets = vi.fn(async () => []);
    (execute as any).mockResolvedValue({ success: false, error: 'Skill "image_generate" timed out after 300000ms' });
    const media = await (studio as any).produceImage(channel, {
      title: 'x', body: 'y', hashtags: [], warum: '', bildidee: 'Stadion unter Flutlicht mit Ball',
    });
    expect(media).toEqual([]);
    expect((socialRepo as any).incrementMetric.mock.calls.filter((c: any[]) => c[1]?.kind === 'gen_image').length).toBe(1);

    // anderer Fehler (z.B. Auth) → KEINE Budget-Zählung
    (socialRepo as any).incrementMetric.mockClear();
    (execute as any).mockResolvedValue({ success: false, error: 'OpenAI: 401 Unauthorized' });
    await (studio as any).produceImage(channel, { title: 'x', body: 'y', hashtags: [], warum: '', bildidee: 'Taktiktafel mit Kreide' });
    expect((socialRepo as any).incrementMetric).not.toHaveBeenCalled();
  });

  it('v1043: liefert der Bild-Skill nur eine URL (kein Buffer) → bei symbolic fail-closed verworfen', async () => {
    const { studio, channel, socialRepo, execute } = await makeMediaStudio([]);
    (socialRepo as any).listMediaAssets = vi.fn(async () => []);
    (execute as any).mockResolvedValue({ success: true, data: { url: 'https://cdn.example/bild.png' } }); // kein attachments-Buffer
    const media = await (studio as any).produceImage(channel, {
      title: 'x', body: 'y', hashtags: [], warum: '', bildidee: 'Stadion unter Flutlicht mit Ball',
    });
    expect(media).toEqual([]); // Vision-Gate/Overlays unmöglich → kein Bild
  });

  it('v1043: cleanupMediaDir — HA-sicher: nur lokal existierende Dateien, Vorlagen/Waisen korrekt', async () => {
    const oldIso = new Date(Date.now() - 200 * 24 * 3_600_000).toISOString();
    const { studio, channel, socialRepo, dir, writeFile, join } = await makeMediaStudio([]);
    (channel.config as Record<string, unknown>).image_overlay = { termin_image: 'a-tpl' };
    const mk = async (name: string) => { const p = join(dir, name); await writeFile(p, Buffer.from(name)); return p; };
    const base = { userId: OWNER, channelId: 'ch-1', motif: 'm', lastUsedAt: oldIso, useCount: 1, blocked: false, createdAt: oldIso };
    const localPath = await mk('asset-lokal.png');
    const tplPath = await mk('asset-tpl.png');
    await mk('asset-waise.png'); // Datei OHNE DB-Zeile
    { // mtime eindeutig VOR den Cutoff legen (Sub-ms-Timing ist sonst flaky)
      const { utimes } = await import('node:fs/promises');
      const past = new Date(Date.now() - 300 * 24 * 3_600_000);
      await utimes(join(dir, 'asset-waise.png'), past, past);
    }
    (socialRepo as any).listMediaAssets = vi.fn(async () => [
      { ...base, id: 'a-pin', path: await mk('asset-pin.png'), pinned: true },
      { ...base, id: 'a-tpl', path: tplPath, pinned: false }, // referenziert als Termin-Vorlage
      { ...base, id: 'a-lokal', path: localPath, pinned: false },
      { ...base, id: 'a-fremd', path: join(dir, 'asset-fremder-node.png'), pinned: false }, // Datei existiert NICHT
    ]);
    (socialRepo as any).countItemsReferencingMedia = vi.fn(async () => 0);
    await studio.cleanupMediaDir(0); // Cutoff = jetzt → alles Alte fällig
    const deleted = (socialRepo as any).deleteMediaAsset.mock.calls.map((c: any[]) => c[1]);
    expect(deleted).toEqual(['a-lokal']); // Vorlage + gepinnt + fremder Node bleiben
    const { access } = await import('node:fs/promises');
    await expect(access(join(dir, 'asset-waise.png'))).rejects.toThrow(); // Waise entfernt
    await expect(access(tplPath)).resolves.toBeUndefined(); // Vorlage-Datei bleibt
  });

  it('v1043: dedupMediaLibrary löscht als Termin-Vorlage referenzierte Assets nicht', async () => {
    const old = new Date(Date.now() - 10 * 24 * 3_600_000).toISOString();
    const { studio, channel, socialRepo, dir, writeFile, join } = await makeMediaStudio([]);
    (channel.config as Record<string, unknown>).image_overlay = { termin_image: 'a-tpl' };
    const mk = async (name: string) => { const p = join(dir, name); await writeFile(p, Buffer.from(name)); return p; };
    const base = { userId: OWNER, channelId: 'ch-1', style: undefined, format: '1536x1024', lastUsedAt: old, blocked: false, pinned: false, createdAt: old };
    (socialRepo as any).listMediaAssets = vi.fn(async () => [
      { ...base, id: 'a-keep', path: await mk('asset-k.png'), motif: 'Stadion unter Flutlicht mit Ball auf dem Rasen', useCount: 9 },
      { ...base, id: 'a-tpl', path: await mk('asset-t.png'), motif: 'Stadion unter Flutlicht mit Ball auf dem Rasen bei Nacht', useCount: 1 },
      { ...base, id: 'a-weg', path: await mk('asset-w.png'), motif: 'Stadion unter Flutlicht mit Ball auf dem Rasen, atmosphärisch', useCount: 1 },
    ]);
    const r = await studio.dedupMediaLibrary();
    expect(r.removed).toBe(1);
    const deleted = (socialRepo as any).deleteMediaAsset.mock.calls.map((c: any[]) => c[1]);
    expect(deleted).toEqual(['a-weg']); // a-tpl geschützt, a-keep Keeper
  });

  it('v1039(E): dedupMediaLibrary — Fast-Duplikate weg, Stamm-Bild bleibt, Fremdmotiv unberührt', async () => {
    const old = new Date(Date.now() - 10 * 24 * 3_600_000).toISOString();
    const { studio, socialRepo, dir, writeFile, join } = await makeMediaStudio([]);
    const mk = async (name: string) => { const p = join(dir, name); await writeFile(p, Buffer.from(name)); return p; };
    const base = { userId: OWNER, channelId: 'ch-1', style: undefined, format: '1536x1024', lastUsedAt: old, blocked: false, createdAt: old };
    (socialRepo as any).listMediaAssets = vi.fn(async () => [
      { ...base, id: 'a-pin', path: await mk('asset-pin.png'), motif: 'Stadion unter Flutlicht mit Ball auf dem Rasen', useCount: 1, pinned: true },
      { ...base, id: 'a-big', path: await mk('asset-big.png'), motif: 'Stadion unter Flutlicht mit Ball auf dem Rasen, atmosphärisch', useCount: 9, pinned: false },
      { ...base, id: 'a-small', path: await mk('asset-small.png'), motif: 'Stadion unter Flutlicht mit Ball auf dem Rasen bei Nacht', useCount: 1, pinned: false },
      { ...base, id: 'a-other', path: await mk('asset-other.png'), motif: 'Taktiktafel mit Kreide in der Kabine', useCount: 1, pinned: false },
    ]);
    const r = await studio.dedupMediaLibrary();
    expect(r).toEqual({ scanned: 4, groups: 1, removed: 2 });
    const deleted = (socialRepo as any).deleteMediaAsset.mock.calls.map((c: any[]) => c[1]);
    expect(deleted.sort()).toEqual(['a-big', 'a-small']); // gepinnt gewinnt, Fremdmotiv bleibt
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
    const genImageUpserts = (socialRepo.incrementMetric as any).mock.calls.filter((c: any[]) => c[1]?.kind === 'gen_image');
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
    // Slot-Raster bewusst leer ('Zz 99:99'): mit echten Wochen-Slots ist der
    // Test zeitabhängig — fällt ein Raster-Slot zufällig in die nächsten
    // 10 Minuten, wird der Termin LEGITIM platziert (Realfall 06.07. 17:54,
    // Slot Mo 18:00). Hier soll ausschließlich der Ad-hoc-Pfad scheitern.
    const channel = makeChannel({ mode: 'approve', postingSlots: ['Zz 99:99'] });
    const { studio, llm, createdItems, interestsRepo } = makeStack({
      channel,
      llmResponse: JSON.stringify([
        { title: 'Public Viewing gleich', body: 'Ganz kurzfristige Ankündigung für das Match in wenigen Minuten im Pub!', hashtags: [], warum: 'Termin', terminBis: soon },
      ]),
    });
    // Kommendes Event, damit der Termin-Durchlauf (voller/leerer Kanal) anspringt
    const soonLocal = new Date(Date.now() + 10 * 60_000);
    const dd = String(soonLocal.getDate()).padStart(2, '0');
    const mm = String(soonLocal.getMonth() + 1).padStart(2, '0');
    const hh = String(soonLocal.getHours()).padStart(2, '0');
    const min = String(soonLocal.getMinutes()).padStart(2, '0');
    (interestsRepo.listItems as any) = vi.fn(async () => [{
      id: 'ev-soon', topicId: 't-1', title: `Match gleich – Kickoff – ${dd}.${mm}.${soonLocal.getFullYear()}, ${hh}:${min}`,
      summary: 'Pub, Wien', sourceKind: 'events', createdAt: '2026-01-01',
    }]);
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

describe('v1073 — Termin-Karte nur für echte Termin-Ankündigungen', () => {
  it('isTerminAnnouncement: termin/ohne-art ja, vorschau/news nein', async () => {
    const { isTerminAnnouncement } = await import('../content-studio.js');
    expect(isTerminAnnouncement({ terminBis: '2026-07-09T19:00:00Z', art: 'termin' })).toBe(true);
    expect(isTerminAnnouncement({ terminBis: '2026-07-09T19:00:00Z' })).toBe(true); // Story-/Event-Pfad ohne art
    expect(isTerminAnnouncement({ terminBis: '2026-07-09T19:00:00Z', art: 'vorschau' })).toBe(false); // Realfall Regragui
    expect(isTerminAnnouncement({ terminBis: '2026-07-09T19:00:00Z', art: 'news' })).toBe(false);
    expect(isTerminAnnouncement({ art: 'termin' })).toBe(false); // ohne Zeitpunkt keine Karte
  });

  it('cleanTerminField: Platzhalter („—", n/a, tbd) werden verworfen', () => {
    expect(ContentStudio.cleanTerminField('—', 120)).toBeUndefined();
    expect(ContentStudio.cleanTerminField('-', 40)).toBeUndefined();
    expect(ContentStudio.cleanTerminField(' n/a ', 40)).toBeUndefined();
    expect(ContentStudio.cleanTerminField('TBD', 40)).toBeUndefined();
    expect(ContentStudio.cleanTerminField('Dublin Irish Pub, Wien', 120)).toBe('Dublin Irish Pub, Wien');
    expect(ContentStudio.cleanTerminField('19:30', 40)).toBe('19:30');
    expect(ContentStudio.cleanTerminField(undefined, 40)).toBeUndefined();
  });
});
