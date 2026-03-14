import { lookup } from 'node:dns/promises';
import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../skill.js';

const MAX_RESPONSE_SIZE = 100_000; // 100KB text limit

export class HttpSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'http',
    category: 'files',
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

    // URL validation and scheme check
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { success: false, error: `Invalid URL: "${url}"` };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { success: false, error: `Unsupported URL scheme "${parsed.protocol}". Only http: and https: are allowed.` };
    }

    // Block requests to private/internal network addresses (SSRF protection with DNS resolution)
    if (await this.resolveAndCheckHost(parsed.hostname)) {
      return { success: false, error: `Access to private/internal network address "${parsed.hostname}" is blocked.` };
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

  private isPrivateIp(ip: string): boolean {
    // IPv4-mapped IPv6 (::ffff:a.b.c.d)
    const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(ip);
    if (mapped) return this.isPrivateIp(mapped[1]);

    // IPv6 private (fc00::/7, ::1)
    const clean = ip.replace(/[\[\]]/g, '').toLowerCase();
    if (clean === '::1' || clean.startsWith('fc') || clean.startsWith('fd') || clean.startsWith('fe80')) return true;

    // IPv4 private ranges
    const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
    if (ipv4Match) {
      const [, a, b] = ipv4Match.map(Number);
      if (a === 10) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 192 && b === 168) return true;
      if (a === 127) return true;
      if (a === 169 && b === 254) return true;
      if (a === 0) return true;
    }
    return false;
  }

  private isPrivateHost(hostname: string): boolean {
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
    return this.isPrivateIp(hostname);
  }

  private async resolveAndCheckHost(hostname: string): Promise<boolean> {
    if (this.isPrivateHost(hostname)) return true;
    // Resolve DNS to catch rebinding attacks
    try {
      const { address } = await lookup(hostname);
      if (this.isPrivateIp(address)) return true;
    } catch { /* DNS resolution failed — allow, let fetch handle it */ }
    return false;
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
