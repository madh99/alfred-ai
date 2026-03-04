import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../skill.js';

export interface WebSearchConfig {
  provider: 'brave' | 'searxng' | 'tavily' | 'duckduckgo';
  apiKey?: string;       // Brave / Tavily API key
  baseUrl?: string;      // SearXNG instance URL (e.g. http://localhost:8080)
  maxResults?: number;
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export class WebSearchSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'web_search',
    category: 'information',
    description: 'Search the internet for current information, news, facts, or anything the user asks about that you don\'t know. Use this whenever you need up-to-date information.',
    riskLevel: 'read',
    version: '1.1.0',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query',
        },
        count: {
          type: 'number',
          description: 'Number of results to return (default: 5, max: 10)',
        },
      },
      required: ['query'],
    },
  };

  constructor(private readonly config?: WebSearchConfig) {
    super();
  }

  async execute(
    input: Record<string, unknown>,
    _context: SkillContext,
  ): Promise<SkillResult> {
    const query = input.query as string;
    const count = Math.min(Math.max(1, (input.count as number) || 5), 10);

    if (!query || typeof query !== 'string') {
      return { success: false, error: 'Invalid input: "query" must be a non-empty string' };
    }

    if (!this.config) {
      return {
        success: false,
        error: 'Web search is not configured. Run `alfred setup` to configure a search provider.',
      };
    }

    const needsKey = this.config.provider === 'brave' || this.config.provider === 'tavily';
    if (needsKey && !this.config.apiKey) {
      return {
        success: false,
        error: `Web search requires an API key for ${this.config.provider}. Run \`alfred setup\` to configure it.`,
      };
    }

    try {
      let results: SearchResult[];

      switch (this.config.provider) {
        case 'brave':
          results = await this.searchBrave(query, count);
          break;
        case 'searxng':
          results = await this.searchSearXNG(query, count);
          break;
        case 'tavily':
          results = await this.searchTavily(query, count);
          break;
        case 'duckduckgo':
          results = await this.searchDuckDuckGo(query, count);
          break;
        default:
          return { success: false, error: `Unknown search provider: ${this.config.provider}` };
      }

      if (results.length === 0) {
        return {
          success: true,
          data: { results: [] },
          display: `No results found for "${query}".`,
        };
      }

      const display = results
        .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`)
        .join('\n\n');

      return {
        success: true,
        data: { query, results },
        display: `Search results for "${query}":\n\n${display}`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Search failed: ${msg}` };
    }
  }

  // ── Brave Search ──────────────────────────────────────────────

  private async searchBrave(query: string, count: number): Promise<SearchResult[]> {
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(count));

    const response = await fetch(url.toString(), {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': this.config!.apiKey!,
      },
    });

    if (!response.ok) {
      throw new Error(`Brave Search API returned ${response.status}: ${response.statusText}`);
    }

    const data = await response.json() as {
      web?: { results?: Array<{ title: string; url: string; description: string }> };
    };

    return (data.web?.results ?? []).slice(0, count).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.description,
    }));
  }

  // ── SearXNG ───────────────────────────────────────────────────

  private async searchSearXNG(query: string, count: number): Promise<SearchResult[]> {
    const base = (this.config!.baseUrl ?? 'http://localhost:8080').replace(/\/+$/, '');
    const url = new URL(`${base}/search`);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('pageno', '1');

    const response = await fetch(url.toString(), {
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`SearXNG returned ${response.status}: ${response.statusText}`);
    }

    const data = await response.json() as {
      results?: Array<{ title: string; url: string; content: string }>;
    };

    return (data.results ?? []).slice(0, count).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.content,
    }));
  }

  // ── Tavily ────────────────────────────────────────────────────

  private async searchTavily(query: string, count: number): Promise<SearchResult[]> {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: this.config!.apiKey!,
        query,
        max_results: count,
        include_answer: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`Tavily API returned ${response.status}: ${response.statusText}`);
    }

    const data = await response.json() as {
      results?: Array<{ title: string; url: string; content: string }>;
    };

    return (data.results ?? []).slice(0, count).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.content,
    }));
  }

  // ── DuckDuckGo (HTML scraping, no API key) ────────────────────

  private async searchDuckDuckGo(query: string, count: number): Promise<SearchResult[]> {
    const url = new URL('https://html.duckduckgo.com/html/');
    url.searchParams.set('q', query);

    const response = await fetch(url.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Alfred/1.0)',
      },
    });

    if (!response.ok) {
      throw new Error(`DuckDuckGo returned ${response.status}: ${response.statusText}`);
    }

    const html = await response.text();
    return this.parseDuckDuckGoHtml(html, count);
  }

  private parseDuckDuckGoHtml(html: string, count: number): SearchResult[] {
    const results: SearchResult[] = [];

    // Match result blocks: <a class="result__a" href="URL">TITLE</a>
    // and <a class="result__snippet" ...>SNIPPET</a>
    const linkRegex = /<a[^>]+class="result__a"[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
    const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

    const links: Array<{ url: string; title: string }> = [];
    let match: RegExpExecArray | null;

    while ((match = linkRegex.exec(html)) !== null) {
      const rawUrl = match[1];
      const title = this.stripHtml(match[2]).trim();
      // DDG wraps URLs in a redirect — extract the actual URL
      const actualUrl = this.extractDdgUrl(rawUrl);
      if (title && actualUrl) {
        links.push({ url: actualUrl, title });
      }
    }

    const snippets: string[] = [];
    while ((match = snippetRegex.exec(html)) !== null) {
      snippets.push(this.stripHtml(match[1]).trim());
    }

    for (let i = 0; i < Math.min(links.length, count); i++) {
      results.push({
        title: links[i].title,
        url: links[i].url,
        snippet: snippets[i] ?? '',
      });
    }

    return results;
  }

  private extractDdgUrl(rawUrl: string): string {
    // DDG redirect format: //duckduckgo.com/l/?uddg=ENCODED_URL&...
    try {
      if (rawUrl.includes('uddg=')) {
        const parsed = new URL(rawUrl, 'https://duckduckgo.com');
        const uddg = parsed.searchParams.get('uddg');
        if (uddg) return decodeURIComponent(uddg);
      }
    } catch { /* fall through */ }
    // If it's already a direct URL
    if (rawUrl.startsWith('http')) return rawUrl;
    return '';
  }

  private stripHtml(html: string): string {
    return html
      .replace(/<[^>]*>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ');
  }
}
