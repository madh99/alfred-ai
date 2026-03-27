import { describe, it, expect, vi, beforeEach } from 'vitest';

// We test the private methods by extracting them via prototype or
// by instantiating the class with a mock MemoryRepository.

// Since FeedReaderSkill has private methods we need to test, we access them
// via the instance using bracket notation.

const mockMemoryRepo = {
  save: vi.fn().mockResolvedValue(undefined),
  delete: vi.fn().mockResolvedValue(true),
  listByCategory: vi.fn().mockResolvedValue([]),
  get: vi.fn().mockResolvedValue(null),
  getByType: vi.fn().mockResolvedValue([]),
};

// Mock rss-parser before importing FeedReaderSkill
vi.mock('rss-parser', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      parseURL: vi.fn(),
    })),
  };
});

// Use dynamic import so mocks are in place
const { FeedReaderSkill } = await import('../built-in/feed-reader.js');

type FeedReaderInstance = InstanceType<typeof FeedReaderSkill>;

function createSkill(): FeedReaderInstance {
  return new FeedReaderSkill(mockMemoryRepo as any);
}

// ── findLastKnownIndex ────────────────────────────────────────────────

describe('FeedReaderSkill.findLastKnownIndex', () => {
  let skill: FeedReaderInstance;

  beforeEach(() => {
    skill = createSkill();
  });

  const call = (items: any[], entry: any): number =>
    (skill as any).findLastKnownIndex(items, entry);

  it('matches by guid (highest priority)', () => {
    const items = [
      { guid: 'g3', link: 'l3', title: 't3' },
      { guid: 'g2', link: 'l2', title: 't2' },
      { guid: 'g1', link: 'l1', title: 't1' },
    ];
    const entry = {
      lastEntryIds: { guid: 'g2', link: 'l2', title: 't2' },
      lastEntryId: null,
    };
    expect(call(items, entry)).toBe(1);
  });

  it('matches by link when guid is absent', () => {
    const items = [
      { link: 'l3', title: 't3' },
      { link: 'l2', title: 't2' },
      { link: 'l1', title: 't1' },
    ];
    const entry = {
      lastEntryIds: { guid: undefined, link: 'l2', title: 't2' },
      lastEntryId: null,
    };
    expect(call(items, entry)).toBe(1);
  });

  it('matches by title as last resort', () => {
    const items = [
      { title: 'New article' },
      { title: 'Old article' },
    ];
    const entry = {
      lastEntryIds: { guid: undefined, link: undefined, title: 'Old article' },
      lastEntryId: null,
    };
    expect(call(items, entry)).toBe(1);
  });

  it('falls back to legacy lastEntryId', () => {
    const items = [
      { guid: 'g3', link: 'l3', title: 't3' },
      { guid: 'g2', link: 'l2', title: 't2' },
    ];
    const entry = {
      lastEntryIds: null,
      lastEntryId: 'g2', // legacy: matched via guid ?? link ?? title
    };
    expect(call(items, entry)).toBe(1);
  });

  it('returns -1 when not found', () => {
    const items = [
      { guid: 'g1', link: 'l1', title: 't1' },
    ];
    const entry = {
      lastEntryIds: { guid: 'missing', link: 'missing', title: 'missing' },
      lastEntryId: 'also-missing',
    };
    expect(call(items, entry)).toBe(-1);
  });

  it('returns 0 when last known is the first (newest) item', () => {
    const items = [
      { guid: 'g1', link: 'l1', title: 't1' },
      { guid: 'g2', link: 'l2', title: 't2' },
    ];
    const entry = {
      lastEntryIds: { guid: 'g1' },
      lastEntryId: null,
    };
    expect(call(items, entry)).toBe(0);
  });
});

// ── fallbackByDate ────────────────────────────────────────────────────

describe('FeedReaderSkill.fallbackByDate', () => {
  let skill: FeedReaderInstance;

  beforeEach(() => {
    skill = createSkill();
  });

  const call = (items: any[], lastCheckedAt: string | null): any[] =>
    (skill as any).fallbackByDate(items, lastCheckedAt);

  it('filters items newer than lastCheckedAt', () => {
    const items = [
      { title: 'new', pubDate: '2026-03-27T12:00:00Z' },
      { title: 'old', pubDate: '2026-03-25T12:00:00Z' },
    ];
    const result = call(items, '2026-03-26T00:00:00Z');
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('new');
  });

  it('returns empty when items have no pubDate', () => {
    const items = [
      { title: 'no-date-1' },
      { title: 'no-date-2' },
    ];
    const result = call(items, '2026-03-26T00:00:00Z');
    expect(result).toHaveLength(0);
  });

  it('returns up to 5 items when lastCheckedAt is null (first check)', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ title: `item-${i}` }));
    const result = call(items, null);
    expect(result).toHaveLength(5);
  });

  it('returns empty for invalid lastCheckedAt date', () => {
    const items = [
      { title: 'a', pubDate: '2026-03-27T12:00:00Z' },
    ];
    const result = call(items, 'not-a-date');
    expect(result).toHaveLength(0);
  });

  it('uses isoDate when pubDate is absent', () => {
    const items = [
      { title: 'new', isoDate: '2026-03-27T12:00:00Z' },
    ];
    const result = call(items, '2026-03-26T00:00:00Z');
    expect(result).toHaveLength(1);
  });
});

// ── checkSingleFeed ───────────────────────────────────────────────────

describe('FeedReaderSkill.checkSingleFeed', () => {
  let skill: FeedReaderInstance;

  beforeEach(() => {
    skill = createSkill();
    vi.clearAllMocks();
  });

  it('returns new items based on findLastKnownIndex', async () => {
    // Mock the RSS parser inside the skill — override the dynamic import
    const mockParseURL = vi.fn().mockResolvedValue({
      items: [
        { guid: 'g3', title: 'Third', link: 'http://3' },
        { guid: 'g2', title: 'Second', link: 'http://2' },
        { guid: 'g1', title: 'First', link: 'http://1' },
      ],
    });

    // Patch the internal method to avoid rss-parser import complexity
    const origCheck = (skill as any).checkSingleFeed.bind(skill);

    // We mock at a lower level: override the import to return our mock parser
    const RSSParser = (await import('rss-parser')).default;
    (RSSParser as any).mockImplementation(() => ({
      parseURL: mockParseURL,
    }));

    const entry = {
      url: 'http://example.com/feed',
      label: 'Example',
      lastCheckedAt: '2026-03-25T00:00:00Z',
      lastEntryId: 'g2',
      lastEntryIds: { guid: 'g2', link: 'http://2', title: 'Second' },
    };

    const result = await origCheck('user1', entry);

    expect(result.newCount).toBe(1); // only g3 is newer than g2
    expect(result.items[0].title).toBe('Third');
    expect(mockMemoryRepo.save).toHaveBeenCalled();
  });

  it('returns up to 5 items on first check (no lastEntryId)', async () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      guid: `g${i}`,
      title: `Item ${i}`,
      link: `http://${i}`,
    }));
    const mockParseURL = vi.fn().mockResolvedValue({ items });

    const RSSParser = (await import('rss-parser')).default;
    (RSSParser as any).mockImplementation(() => ({
      parseURL: mockParseURL,
    }));

    const entry = {
      url: 'http://example.com/feed',
      label: 'Example',
      lastCheckedAt: null,
      lastEntryId: null,
    };

    const result = await (skill as any).checkSingleFeed('user1', entry);

    expect(result.newCount).toBe(5);
  });

  it('returns 0 new items when last known is the first item', async () => {
    const mockParseURL = vi.fn().mockResolvedValue({
      items: [
        { guid: 'g1', title: 'Latest', link: 'http://1' },
        { guid: 'g0', title: 'Old', link: 'http://0' },
      ],
    });

    const RSSParser = (await import('rss-parser')).default;
    (RSSParser as any).mockImplementation(() => ({
      parseURL: mockParseURL,
    }));

    const entry = {
      url: 'http://example.com/feed',
      label: 'Example',
      lastCheckedAt: '2026-03-26T00:00:00Z',
      lastEntryId: 'g1',
      lastEntryIds: { guid: 'g1', link: 'http://1', title: 'Latest' },
    };

    const result = await (skill as any).checkSingleFeed('user1', entry);

    expect(result.newCount).toBe(0);
  });
});
