import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../skill.js';

const MAX_RESPONSE_SIZE = 100_000; // 100KB text limit

export class HttpSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'http',
    description:
      'Make HTTP requests to fetch web pages or call REST APIs. ' +
      'Use when you need to read a URL, call an API endpoint, or fetch data from the web. ' +
      'Supports GET, POST, PUT, PATCH, DELETE methods.',
    riskLevel: 'write',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to request',
        },
        method: {
          type: 'string',
          enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
          description: 'HTTP method (default: GET)',
        },
        headers: {
          type: 'object',
          description: 'Request headers as key-value pairs (optional)',
        },
        body: {
          type: 'string',
          description: 'Request body for POST/PUT/PATCH (optional)',
        },
      },
      required: ['url'],
    },
  };

  async execute(
    input: Record<string, unknown>,
    _context: SkillContext,
  ): Promise<SkillResult> {
    const url = input.url as string;
    const method = ((input.method as string) ?? 'GET').toUpperCase();
    const headers = input.headers as Record<string, string> | undefined;
    const body = input.body as string | undefined;

    if (!url || typeof url !== 'string') {
      return { success: false, error: 'Missing required field "url"' };
    }

    // Basic URL validation
    try {
      new URL(url);
    } catch {
      return { success: false, error: `Invalid URL: "${url}"` };
    }

    try {
      const fetchOptions: RequestInit = {
        method,
        headers: {
          'User-Agent': 'Alfred/1.0',
          ...(headers ?? {}),
        },
        signal: AbortSignal.timeout(15_000),
      };

      if (body && ['POST', 'PUT', 'PATCH'].includes(method)) {
        fetchOptions.body = body;
        // Auto-set Content-Type if not specified
        if (!headers?.['Content-Type'] && !headers?.['content-type']) {
          (fetchOptions.headers as Record<string, string>)['Content-Type'] = 'application/json';
        }
      }

      const res = await fetch(url, fetchOptions);
      const contentType = res.headers.get('content-type') ?? '';
      const text = await res.text();
      const truncated = text.length > MAX_RESPONSE_SIZE;
      const responseBody = truncated ? text.slice(0, MAX_RESPONSE_SIZE) + '\n\n[... truncated]' : text;

      // Try to extract meaningful text from HTML
      let display = responseBody;
      if (contentType.includes('text/html')) {
        display = this.stripHtml(responseBody).slice(0, 10_000);
      }

      const data = {
        status: res.status,
        statusText: res.statusText,
        contentType,
        bodyLength: text.length,
        truncated,
        body: responseBody,
      };

      if (!res.ok) {
        return {
          success: true,
          data,
          display: `HTTP ${res.status} ${res.statusText}\n\n${display.slice(0, 2000)}`,
        };
      }

      return {
        success: true,
        data,
        display: `HTTP ${res.status} OK (${text.length} bytes)\n\n${display.slice(0, 5000)}`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `HTTP request failed: ${msg}` };
    }
  }

  private stripHtml(html: string): string {
    return html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
}
