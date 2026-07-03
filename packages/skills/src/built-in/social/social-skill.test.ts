import { describe, it, expect, vi } from 'vitest';
import { SocialSkill } from './social-skill.js';
import { SocialProvider, composePostText, type ProviderCapabilities, type PublishResult } from './social-provider.js';
import type { SocialRepository, SocialChannel, ContentItem } from '@alfred/storage';
import type { SkillContext } from '@alfred/types';

const CTX = { userId: 'u1', masterUserId: 'u1', platform: 'api', chatId: 'c1' } as unknown as SkillContext;

function makeChannel(overrides: Partial<SocialChannel> = {}): SocialChannel {
  return {
    id: 'ch-1', userId: 'u1', platform: 'test', name: 'Testkanal',
    mode: 'suggest', publishMode: 'api', planningHorizonDays: 14, postingSlots: [],
    blacklist: [], maxPostsPerDay: 3, approvedStreak: 0, status: 'active', config: {},
    createdAt: 'x', updatedAt: 'x', ...overrides,
  };
}

function makeItem(overrides: Partial<ContentItem> = {}): ContentItem {
  return {
    id: 'item-0001-aaaa', channelId: 'ch-1', userId: 'u1', status: 'draft',
    body: 'Hallo Welt', media: [], hashtags: ['fussball'], source: 'manual',
    createdAt: 'x', updatedAt: 'x', ...overrides,
  };
}

class FakeProvider extends SocialProvider {
  readonly platform = 'test';
  published: ContentItem[] = [];
  failNext = false;
  capabilities(): ProviderCapabilities { return { text: true, image: true, video: false, supportsDelete: true, supportsMetrics: false }; }
  async publish(item: ContentItem): Promise<PublishResult> {
    if (this.failNext) { this.failNext = false; throw new Error('API down'); }
    this.published.push(item);
    return { externalId: 'ext-1', url: 'https://ex.at/p/1' };
  }
  async validateAuth(): Promise<{ ok: boolean; detail?: string }> { return { ok: true, detail: 'Testkanal' }; }
  override async deletePost(): Promise<boolean> { return true; }
}

function makeRepo(channel: SocialChannel, item: ContentItem) {
  const state = { channel: { ...channel }, item: { ...item } };
  const repo = {
    createChannel: vi.fn(async (_u: string, o: any) => ({ ...makeChannel(), ...o, id: 'ch-new' })),
    getChannel: vi.fn(async (_u: string, id: string) => (id === state.channel.id ? state.channel : null)),
    findChannelByName: vi.fn(async (_u: string, q: string) =>
      state.channel.name.toLowerCase().includes(q.toLowerCase()) ? state.channel : null),
    listChannels: vi.fn(async () => [state.channel]),
    listAllActiveChannels: vi.fn(async () => [state.channel]),
    updateChannel: vi.fn(async (_u: string, _id: string, patch: any) => { Object.assign(state.channel, patch); }),
    pauseAll: vi.fn(async () => 1),
    createItem: vi.fn(async (_u: string, chId: string, o: any) => ({ ...makeItem(), ...o, channelId: chId, id: 'item-new' })),
    getItem: vi.fn(async (_u: string, id: string) => (id === state.item.id ? state.item : null)),
    listItems: vi.fn(async () => [state.item]),
    transition: vi.fn(async (_u: string, _id: string, to: any, extra?: any) => {
      state.item = { ...state.item, status: to, ...(extra ?? {}) };
      return state.item;
    }),
    updateItemContent: vi.fn(async () => {}),
    reschedule: vi.fn(async (_u: string, _id: string, at: string) => { state.item = { ...state.item, scheduledAt: at }; return true; }),
    countPublishedToday: vi.fn(async () => 0),
    upsertMetric: vi.fn(async () => {}),
    listMetrics: vi.fn(async () => []),
  };
  return { repo: repo as unknown as SocialRepository, state, spies: repo };
}

function makeSkill(channel: SocialChannel, item: ContentItem) {
  const { repo, state, spies } = makeRepo(channel, item);
  const skill = new SocialSkill(repo);
  const provider = new FakeProvider();
  skill.registerProvider(provider);
  skill.setSecretsResolver(async () => ({ API_TOKEN: 't' }));
  return { skill, provider, state, spies };
}

describe('composePostText', () => {
  it('Body + Hashtags, Titel vorangestellt', () => {
    const text = composePostText(makeItem({ title: 'Derby-Sieg!', hashtags: ['fussball', '#noe'] }));
    expect(text).toContain('Derby-Sieg!');
    expect(text).toContain('Hallo Welt');
    expect(text).toContain('#fussball #noe');
  });

  it('kürzt auf maxLength, Hashtags bleiben erhalten', () => {
    const text = composePostText(makeItem({ body: 'x'.repeat(500), hashtags: ['tag'] }), 120);
    expect(text.length).toBeLessThanOrEqual(120);
    expect(text).toContain('#tag');
  });
});

describe('SocialSkill — Veröffentlichung + Leitplanken', () => {
  it('publish_now (api): Provider published, Item wird published mit external-Daten', async () => {
    const { skill, provider, state } = makeSkill(makeChannel(), makeItem());
    const r = await skill.execute({ action: 'publish_now', item_id: 'item-0001-aaaa' }, CTX);
    expect(r.success).toBe(true);
    expect(provider.published.length).toBe(1);
    expect(state.item.status).toBe('published');
    expect(state.item.externalId).toBe('ext-1');
    expect(r.display).toContain('https://ex.at/p/1');
  });

  it('publish_now (prepare): kein Provider-Call, fertige Aufbereitung als Antwort', async () => {
    const { skill, provider, state } = makeSkill(makeChannel({ publishMode: 'prepare' }), makeItem({ title: 'Derby' }));
    const r = await skill.execute({ action: 'publish_now', item_id: 'item-0001-aaaa' }, CTX);
    expect(r.success).toBe(true);
    expect(provider.published.length).toBe(0);
    expect(state.item.status).toBe('approved');
    expect(r.display).toContain('Fertig aufbereitet');
    expect(r.display).toContain('Derby');
    expect(r.display).toContain('mark_published');
  });

  it('Leitplanke Tages-Limit: publish_now verweigert bei Limit', async () => {
    const { skill, spies } = makeSkill(makeChannel({ maxPostsPerDay: 2 }), makeItem());
    (spies.countPublishedToday as any).mockResolvedValue(2);
    const r = await skill.execute({ action: 'publish_now', item_id: 'item-0001-aaaa' }, CTX);
    expect(r.success).toBe(false);
    expect(r.error).toContain('Tages-Limit');
  });

  it('Leitplanke Blacklist: Treffer blockiert die Veröffentlichung', async () => {
    const { skill, provider } = makeSkill(
      makeChannel({ blacklist: ['schiedsrichter'] }),
      makeItem({ body: 'Der Schiedsrichter war eine Katastrophe!' }),
    );
    const r = await skill.execute({ action: 'publish_now', item_id: 'item-0001-aaaa' }, CTX);
    expect(r.success).toBe(false);
    expect(r.error).toContain('Blacklist');
    expect(provider.published.length).toBe(0);
  });

  it('pausierter Kanal: publish_now verweigert', async () => {
    const { skill } = makeSkill(makeChannel({ status: 'paused' }), makeItem());
    const r = await skill.execute({ action: 'publish_now', item_id: 'item-0001-aaaa' }, CTX);
    expect(r.success).toBe(false);
    expect(r.error).toContain('paused');
  });

  it('Provider-Fehler → Item failed mit Fehlertext, kein Throw', async () => {
    const { skill, provider, state } = makeSkill(makeChannel(), makeItem());
    provider.failNext = true;
    const r = await skill.execute({ action: 'publish_now', item_id: 'item-0001-aaaa' }, CTX);
    expect(r.success).toBe(false);
    expect(state.item.status).toBe('failed');
    expect(state.item.error).toContain('API down');
  });

  it('Erstpost-Sperre: approve erhöht Streak, reject setzt zurück', async () => {
    const { skill, state } = makeSkill(makeChannel({ approvedStreak: 2 }), makeItem({ status: 'scheduled' }));
    await skill.execute({ action: 'approve_content', item_id: 'item-0001-aaaa' }, CTX);
    expect(state.channel.approvedStreak).toBe(3);

    state.item.status = 'scheduled';
    await skill.execute({ action: 'reject_content', item_id: 'item-0001-aaaa' }, CTX);
    expect(state.channel.approvedStreak).toBe(0);
  });

  it('mark_published trackt manuell gepostete Beiträge', async () => {
    const { skill, state } = makeSkill(makeChannel({ publishMode: 'prepare' }), makeItem({ status: 'approved' }));
    const r = await skill.execute({ action: 'mark_published', item_id: 'item-0001-aaaa', external_url: 'https://insta.example/p/9' }, CTX);
    expect(r.success).toBe(true);
    expect(state.item.status).toBe('published');
    expect(state.item.externalUrl).toBe('https://insta.example/p/9');
  });

  it('delete_remote löscht via Provider (Leitplanke 6)', async () => {
    const { skill } = makeSkill(makeChannel(), makeItem({ status: 'published', externalId: 'ext-1' }));
    const r = await skill.execute({ action: 'delete_remote', item_id: 'item-0001-aaaa' }, CTX);
    expect(r.success).toBe(true);
    expect(r.display).toContain('gelöscht');
  });

  it('pause_all = Social-Stopp', async () => {
    const { skill } = makeSkill(makeChannel(), makeItem());
    const r = await skill.execute({ action: 'pause_all' }, CTX);
    expect(r.success).toBe(true);
    expect(r.display).toContain('Social-Stopp');
  });

  it('crosspost: kopiert formatgerecht auf Ziel-Kanäle, überspringt die Quelle', async () => {
    const source = makeChannel({ id: 'ch-1', name: 'Telegram-Kanal' });
    const target = makeChannel({ id: 'ch-2', name: 'fussball.cc', platform: 'rest', persona: 'redaktionell' });
    const item = makeItem({ channelId: 'ch-1', title: 'Derby-Sieg', hashtags: ['fussball'] });
    const createdItems: any[] = [];
    const repo = {
      getChannel: vi.fn(async (_u: string, id: string) => (id === 'ch-1' ? source : id === 'ch-2' ? target : null)),
      findChannelByName: vi.fn(async (_u: string, q: string) =>
        q.toLowerCase().includes('fussball.cc') ? target : q.toLowerCase().includes('telegram') ? source : null),
      getItem: vi.fn(async () => item),
      listItems: vi.fn(async () => [item]),
      createItem: vi.fn(async (_u: string, chId: string, o: any) => {
        const copy = { ...makeItem(), ...o, channelId: chId, id: `copy-${createdItems.length + 1}` };
        createdItems.push(copy);
        return copy;
      }),
      transition: vi.fn(async () => item),
    } as unknown as SocialRepository;
    const skill = new SocialSkill(repo);
    skill.registerProvider(new FakeProvider());
    skill.setLlm({
      complete: vi.fn(async () => ({ content: '{"title":"Derby-Sieg: Die Analyse","body":"Redaktionell aufbereiteter Beitrag zum Derby-Sieg mit allen Details.","hashtags":["fussball","derby"]}' })),
    } as any);

    const r = await skill.execute({ action: 'crosspost', item_id: 'item-0001-aaaa', channels: ['fussball.cc', 'Telegram-Kanal'] }, CTX);
    expect(r.success).toBe(true);
    // Quelle (Telegram-Kanal) übersprungen — nur EINE Kopie auf fussball.cc
    expect(createdItems.length).toBe(1);
    expect(createdItems[0].channelId).toBe('ch-2');
    expect(createdItems[0].body).toContain('Redaktionell aufbereiteter');
    expect(createdItems[0].hashtags).toEqual(['fussball', 'derby']);
    expect(createdItems[0].media).toEqual(item.media);
  });

  it('crosspost ohne LLM: wörtliche Kopie; unbekannter Ziel-Kanal → Fehler', async () => {
    const source = makeChannel({ id: 'ch-1', name: 'Quelle' });
    const target = makeChannel({ id: 'ch-2', name: 'Ziel', platform: 'rest' });
    const item = makeItem({ channelId: 'ch-1', body: 'Original-Text bleibt wörtlich erhalten.' });
    const createdItems: any[] = [];
    const repo = {
      getChannel: vi.fn(async (_u: string, id: string) => (id === 'ch-2' ? target : id === 'ch-1' ? source : null)),
      findChannelByName: vi.fn(async (_u: string, q: string) => (q === 'Ziel' ? target : null)),
      getItem: vi.fn(async () => item),
      listItems: vi.fn(async () => [item]),
      createItem: vi.fn(async (_u: string, chId: string, o: any) => {
        const copy = { ...makeItem(), ...o, channelId: chId, id: 'copy-1' };
        createdItems.push(copy);
        return copy;
      }),
      transition: vi.fn(async () => item),
    } as unknown as SocialRepository;
    const skill = new SocialSkill(repo);

    const ok = await skill.execute({ action: 'crosspost', item_id: 'item-0001-aaaa', channels: ['Ziel'] }, CTX);
    expect(ok.success).toBe(true);
    expect(createdItems[0].body).toBe('Original-Text bleibt wörtlich erhalten.');

    const bad = await skill.execute({ action: 'crosspost', item_id: 'item-0001-aaaa', channels: ['GibtEsNicht'] }, CTX);
    expect(bad.success).toBe(false);
    expect(bad.error).toContain('GibtEsNicht');
  });

  it('v951: link_topic/unlink_topic pflegen config.topic_ids (Legacy topic_id wird überführt)', async () => {
    const channel = makeChannel({ config: { topic_id: 't-legacy' } });
    const state = { config: channel.config as Record<string, unknown> };
    const repo = {
      getChannel: vi.fn(async () => ({ ...channel, config: state.config })),
      findChannelByName: vi.fn(async () => ({ ...channel, config: state.config })),
      updateChannel: vi.fn(async (_u: string, _id: string, patch: any) => { state.config = patch.config; }),
    } as unknown as SocialRepository;
    const skill = new SocialSkill(repo);
    skill.setTopicResolver(async (q: string) =>
      q.toLowerCase().includes('panini') ? { id: 't-panini', name: 'Panini-Sammelalbum' }
        : q === 't-legacy' ? { id: 't-legacy', name: 'WM 2026' } : null);

    // Verknüpfen: Legacy-topic_id wird in topic_ids überführt + neues Topic dazu
    const r = await skill.execute({ action: 'link_topic', channel: 'Testkanal', topic: 'Panini' }, CTX);
    expect(r.success).toBe(true);
    expect(state.config.topic_ids).toEqual(expect.arrayContaining(['t-legacy', 't-panini']));
    expect(state.config.topic_id).toBeUndefined();

    // Lösen
    const r2 = await skill.execute({ action: 'unlink_topic', channel: 'Testkanal', topic: 'Panini' }, CTX);
    expect(r2.success).toBe(true);
    expect(state.config.topic_ids).toEqual(['t-legacy']);

    // Unbekanntes Thema → klarer Fehler mit create_topic-Hinweis
    const bad = await skill.execute({ action: 'link_topic', channel: 'Testkanal', topic: 'GibtEsNicht' }, CTX);
    expect(bad.success).toBe(false);
    expect(bad.error).toContain('create_topic');
  });

  it('v955: edit_content korrigiert Text/Hashtags; lesson wird am Kanal gespeichert (Realfall EM→WM)', async () => {
    const channel = makeChannel();
    const item = makeItem({ status: 'scheduled', body: 'Nach dem EM-Aus gegen Spanien folgt die harte Analyse.', hashtags: ['EURO2024'] });
    const state = { config: channel.config as Record<string, unknown> };
    const repo = {
      getItem: vi.fn(async () => item),
      listItems: vi.fn(async () => [item]),
      getChannel: vi.fn(async () => ({ ...channel, config: state.config })),
      findChannelByName: vi.fn(async () => ({ ...channel, config: state.config })),
      updateItemContent: vi.fn(async () => {}),
      updateChannel: vi.fn(async (_u: string, _id: string, patch: any) => { state.config = patch.config; }),
    } as unknown as SocialRepository;
    const skill = new SocialSkill(repo);

    const r = await skill.execute({
      action: 'edit_content', item_id: 'item-0001-aaaa',
      body: 'Nach dem WM-Aus gegen Spanien folgt die harte Analyse.',
      hashtags: ['WM2026'],
      lesson: 'Es ist die WM 2026, nicht die EM — auch in Hashtags.',
    }, CTX);
    expect(r.success).toBe(true);
    expect((repo.updateItemContent as any).mock.calls[0][2]).toEqual({
      body: 'Nach dem WM-Aus gegen Spanien folgt die harte Analyse.',
      hashtags: ['WM2026'],
    });
    expect(state.config.lessons).toEqual(['Es ist die WM 2026, nicht die EM — auch in Hashtags.']);
    expect(r.display).toContain('Lektion gespeichert');
  });

  it('v955: edit_content verweigert bei published; get_content liefert vollen Text; add_lesson dedupliziert', async () => {
    const channel = makeChannel({ config: { lessons: ['Alte Lektion'] } });
    const published = makeItem({ status: 'published' });
    const state = { config: channel.config as Record<string, unknown> };
    const repo = {
      getItem: vi.fn(async () => published),
      listItems: vi.fn(async () => [published]),
      getChannel: vi.fn(async () => ({ ...channel, config: state.config })),
      findChannelByName: vi.fn(async () => ({ ...channel, config: state.config })),
      updateItemContent: vi.fn(async () => {}),
      updateChannel: vi.fn(async (_u: string, _id: string, patch: any) => { state.config = patch.config; }),
    } as unknown as SocialRepository;
    const skill = new SocialSkill(repo);

    const edit = await skill.execute({ action: 'edit_content', item_id: 'item-0001-aaaa', body: 'Neuer Text hier.' }, CTX);
    expect(edit.success).toBe(false);
    expect(edit.error).toContain('Veröffentlichte');

    const get = await skill.execute({ action: 'get_content', item_id: 'item-0001-aaaa' }, CTX);
    expect(get.success).toBe(true);
    expect(get.display).toContain('Hallo Welt');

    await skill.execute({ action: 'add_lesson', channel: 'Testkanal', lesson: 'Alte Lektion' }, CTX);
    expect(state.config.lessons).toEqual(['Alte Lektion']); // dedupliziert
    await skill.execute({ action: 'add_lesson', channel: 'Testkanal', lesson: 'Neue Lektion' }, CTX);
    expect(state.config.lessons).toEqual(['Alte Lektion', 'Neue Lektion']);
  });

  it('create_channel verweigert unbekannte Plattform mit Liste der vorhandenen', async () => {
    const { skill } = makeSkill(makeChannel(), makeItem());
    const r = await skill.execute({ action: 'create_channel', platform: 'instagram', name: 'IG' }, CTX);
    expect(r.success).toBe(false);
    expect(r.error).toContain('test');
  });

  it('v959: replan_channel ruft den Replanner und meldet die Anzahl', async () => {
    const { skill } = makeSkill(makeChannel(), makeItem());
    const replan = vi.fn(async () => 3);
    skill.setReplanner(replan);
    const r = await skill.execute({ action: 'replan_channel', channel: 'Testkanal' }, CTX);
    expect(r.success).toBe(true);
    expect(replan).toHaveBeenCalledOnce();
    expect(r.display).toContain('3');
    expect(r.display).toContain('umgeplant');
  });

  it('v964: schedule_content termininiert scheduled-Items STATUSERHALTEND um', async () => {
    const { skill, state, spies } = makeSkill(makeChannel(), makeItem({ status: 'scheduled', scheduledAt: '2026-07-10T18:00:00.000Z' }));
    const r = await skill.execute({ action: 'schedule_content', item_id: 'item-0001-aaaa', scheduled_at: '2026-07-11T10:00:00.000Z' }, CTX);
    expect(r.success).toBe(true);
    expect(spies.reschedule).toHaveBeenCalledWith('u1', 'item-0001-aaaa', '2026-07-11T10:00:00.000Z', ['scheduled', 'approved']);
    expect(spies.transition).not.toHaveBeenCalled();
    expect(state.item.status).toBe('scheduled');
    expect(state.item.scheduledAt).toBe('2026-07-11T10:00:00.000Z');
  });

  it('v964: approved-Item behält beim Umterminieren seine Freigabe', async () => {
    const { skill, state, spies } = makeSkill(makeChannel(), makeItem({ status: 'approved', scheduledAt: '2026-07-10T18:00:00.000Z' }));
    const r = await skill.execute({ action: 'schedule_content', item_id: 'item-0001-aaaa', scheduled_at: '2026-07-12T08:00:00.000Z' }, CTX);
    expect(r.success).toBe(true);
    expect(spies.transition).not.toHaveBeenCalled();
    expect(state.item.status).toBe('approved');
    expect(r.display).toContain('Status bleibt approved');
  });

  it('v964: draft-Item wird wie bisher via Transition terminiert', async () => {
    const { skill, spies } = makeSkill(makeChannel(), makeItem({ status: 'draft' }));
    const r = await skill.execute({ action: 'schedule_content', item_id: 'item-0001-aaaa', scheduled_at: '2026-07-12T08:00:00.000Z' }, CTX);
    expect(r.success).toBe(true);
    expect(spies.transition).toHaveBeenCalledWith('u1', 'item-0001-aaaa', 'scheduled', { scheduledAt: '2026-07-12T08:00:00.000Z' });
    expect(spies.reschedule).not.toHaveBeenCalled();
  });

  it('v962: add_content generiert ein Bild, wenn der Kanal generate_images hat', async () => {
    const { skill, spies } = makeSkill(makeChannel({ config: { generate_images: true } }), makeItem());
    const gen = vi.fn(async () => [{ type: 'image', source: 'generated', pathOrUrl: '/tmp/bild.png' }]);
    skill.setImageGenerator(gen as any);
    const r = await skill.execute({ action: 'add_content', channel: 'Testkanal', body: 'Ein ausreichend langer Ad-hoc-Beitrag.' }, CTX);
    expect(r.success).toBe(true);
    expect(gen).toHaveBeenCalledOnce();
    expect((spies.createItem as any).mock.calls[0][2].media).toEqual([{ type: 'image', source: 'generated', pathOrUrl: '/tmp/bild.png' }]);
    expect(r.display).toContain('mit generiertem Bild');
  });

  it('v962: add_content ohne generate_images ruft den Generator nicht', async () => {
    const { skill, spies } = makeSkill(makeChannel(), makeItem());
    const gen = vi.fn(async () => []);
    skill.setImageGenerator(gen as any);
    const r = await skill.execute({ action: 'add_content', channel: 'Testkanal', body: 'Ein ausreichend langer Ad-hoc-Beitrag.' }, CTX);
    expect(r.success).toBe(true);
    expect(gen).not.toHaveBeenCalled();
    expect((spies.createItem as any).mock.calls[0][2].media).toEqual([]);
  });

  it('v962: media_url des Users hat Vorrang vor der Generierung', async () => {
    const { skill, spies } = makeSkill(makeChannel({ config: { generate_images: true } }), makeItem());
    const gen = vi.fn(async () => [{ type: 'image', source: 'generated', pathOrUrl: '/tmp/bild.png' }]);
    skill.setImageGenerator(gen as any);
    await skill.execute({ action: 'add_content', channel: 'Testkanal', body: 'Ein ausreichend langer Ad-hoc-Beitrag.', media_url: 'https://ex.at/foto.jpg' }, CTX);
    expect(gen).not.toHaveBeenCalled();
    expect((spies.createItem as any).mock.calls[0][2].media[0].pathOrUrl).toBe('https://ex.at/foto.jpg');
  });

  it('v962: Generator-Fehlschlag blockiert den Post nicht (ohne Bild, mit Warnhinweis)', async () => {
    const { skill } = makeSkill(makeChannel({ config: { generate_images: true } }), makeItem());
    skill.setImageGenerator(vi.fn(async () => { throw new Error('image API down'); }) as any);
    const r = await skill.execute({ action: 'add_content', channel: 'Testkanal', body: 'Ein ausreichend langer Ad-hoc-Beitrag.' }, CTX);
    expect(r.success).toBe(true);
    expect(r.display).toContain('Kein Bild');
  });

  it('v963: update_channel merged config verschachtelt — body_template bleibt vollständig', async () => {
    const channel = makeChannel({
      config: {
        generate_images: true,
        body_template: { title: '{{title}}', content: '{{body}}', status: 'DRAFT', tags: '{{hashtags}}' },
      },
    });
    const { skill, state } = makeSkill(channel, makeItem());
    const r = await skill.execute({ action: 'update_channel', channel: 'Testkanal', config: { body_template: { status: 'PUBLISHED' } } }, CTX);
    expect(r.success).toBe(true);
    expect((state.channel.config as any).body_template).toEqual({ title: '{{title}}', content: '{{body}}', status: 'PUBLISHED', tags: '{{hashtags}}' });
    expect((state.channel.config as any).generate_images).toBe(true);
  });

  it('v963: null in der Config löscht den Schlüssel, Arrays werden ersetzt', async () => {
    const channel = makeChannel({ config: { media_upload: { path: '/api/media' }, topic_ids: ['a', 'b'] } });
    const { skill, state } = makeSkill(channel, makeItem());
    await skill.execute({ action: 'update_channel', channel: 'Testkanal', config: { media_upload: null, topic_ids: ['c'] } }, CTX);
    expect('media_upload' in (state.channel.config as any)).toBe(false);
    expect((state.channel.config as any).topic_ids).toEqual(['c']);
  });

  it('v959: update_channel mit posting_slots weist auf replan_channel hin', async () => {
    const { skill } = makeSkill(makeChannel(), makeItem());
    const r = await skill.execute({ action: 'update_channel', channel: 'Testkanal', posting_slots: ['Sa 10:00', 'So 19:00'] }, CTX);
    expect(r.success).toBe(true);
    expect(r.display).toContain('replan_channel');
  });
});
