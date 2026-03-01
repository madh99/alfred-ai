import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import path from 'node:path';
import os from 'node:os';
import { Skill } from '../skill.js';

// Inline types — avoids compile-time dependency on puppeteer
interface PuppeteerModule {
  launch(options?: Record<string, unknown>): Promise<PBrowser>;
}

interface PBrowser {
  newPage(): Promise<PPage>;
  close(): Promise<void>;
  connected: boolean;
}

interface PPage {
  goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
  evaluate<T>(fn: string | (() => T)): Promise<T>;
  click(selector: string): Promise<void>;
  type(selector: string, text: string, options?: Record<string, unknown>): Promise<void>;
  screenshot(options?: Record<string, unknown>): Promise<Buffer>;
  content(): Promise<string>;
  close(): Promise<void>;
  title(): Promise<string>;
  url(): string;
  setViewport(viewport: { width: number; height: number }): Promise<void>;
  waitForSelector(selector: string, options?: Record<string, unknown>): Promise<unknown>;
  waitForNavigation(options?: Record<string, unknown>): Promise<unknown>;
}

const MAX_TEXT_LENGTH = 50_000;

export class BrowserSkill extends Skill {
  private browser: PBrowser | null = null;
  private page: PPage | null = null;

  readonly metadata: SkillMetadata = {
    name: 'browser',
    description:
      'Open web pages in a real browser (Puppeteer/Chromium). Renders JavaScript, ' +
      'so it works with SPAs and dynamic sites. Can also interact with pages: ' +
      'click buttons, fill forms, take screenshots. ' +
      'Use when http skill returns empty/broken content, or when you need to interact with a web page.',
    riskLevel: 'write',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['open', 'screenshot', 'click', 'type', 'evaluate', 'close'],
          description:
            'open = navigate to URL and return page text. ' +
            'screenshot = save screenshot of current page. ' +
            'click = click element by CSS selector. ' +
            'type = type text into input by CSS selector. ' +
            'evaluate = run JavaScript on the page. ' +
            'close = close the browser.',
        },
        url: {
          type: 'string',
          description: 'URL to open (required for "open", optional for "screenshot")',
        },
        selector: {
          type: 'string',
          description: 'CSS selector for the element (required for "click" and "type")',
        },
        text: {
          type: 'string',
          description: 'Text to type (required for "type")',
        },
        script: {
          type: 'string',
          description: 'JavaScript code to evaluate (required for "evaluate")',
        },
        path: {
          type: 'string',
          description: 'File path to save screenshot (optional, defaults to Desktop)',
        },
      },
      required: ['action'],
    },
  };

  async execute(
    input: Record<string, unknown>,
    _context: SkillContext,
  ): Promise<SkillResult> {
    const action = input.action as string;

    if (action === 'close') {
      return this.closeBrowser();
    }

    // All other actions need puppeteer
    const pup = await this.loadPuppeteer();
    if (!pup) {
      return {
        success: false,
        error:
          'Puppeteer is not installed. Run: npm install -g puppeteer\n' +
          'Or add it to Alfred: npm install puppeteer',
      };
    }

    switch (action) {
      case 'open':
        return this.openPage(pup, input);
      case 'screenshot':
        return this.screenshotPage(pup, input);
      case 'click':
        return this.clickElement(input);
      case 'type':
        return this.typeText(input);
      case 'evaluate':
        return this.evaluateScript(input);
      default:
        return { success: false, error: `Unknown action "${action}". Valid: open, screenshot, click, type, evaluate, close` };
    }
  }

  private async loadPuppeteer(): Promise<PuppeteerModule | null> {
    try {
      // Dynamic import — puppeteer is an optional dependency
      const mod = await (Function('return import("puppeteer")')() as Promise<unknown>);
      return this.resolvePuppeteerModule(mod);
    } catch {
      try {
        const mod = await (Function('return import("puppeteer-core")')() as Promise<unknown>);
        return this.resolvePuppeteerModule(mod);
      } catch {
        return null;
      }
    }
  }

  private resolvePuppeteerModule(mod: unknown): PuppeteerModule {
    const m = mod as Record<string, unknown>;
    if (typeof m.launch === 'function') return m as unknown as PuppeteerModule;
    const def = m.default as Record<string, unknown>;
    return def as unknown as PuppeteerModule;
  }

  private async ensureBrowser(pup: PuppeteerModule): Promise<PBrowser> {
    if (this.browser && this.browser.connected) {
      return this.browser;
    }

    this.browser = await pup.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    return this.browser;
  }

  private async ensurePage(pup: PuppeteerModule): Promise<PPage> {
    const browser = await this.ensureBrowser(pup);

    if (!this.page) {
      this.page = await browser.newPage();
      await this.page.setViewport({ width: 1280, height: 900 });
    }

    return this.page;
  }

  private async openPage(pup: PuppeteerModule, input: Record<string, unknown>): Promise<SkillResult> {
    const url = input.url as string;
    if (!url) {
      return { success: false, error: 'Missing "url" for open action' };
    }

    // Validate URL: block non-http(s) protocols and private/internal IPs
    const urlError = this.validateUrl(url);
    if (urlError) {
      return { success: false, error: urlError };
    }

    try {
      const page = await this.ensurePage(pup);
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30_000 });

      const title = await page.title();

      // Extract readable text from the rendered page
      const text = await page.evaluate(`
        (() => {
          document.querySelectorAll('script, style, noscript').forEach(el => el.remove());
          return document.body?.innerText ?? '';
        })()
      `) as string;

      const trimmed = text.length > MAX_TEXT_LENGTH
        ? text.slice(0, MAX_TEXT_LENGTH) + '\n\n[... truncated]'
        : text;

      // Clean up excessive whitespace
      const cleaned = trimmed.replace(/\n{3,}/g, '\n\n').trim();

      return {
        success: true,
        data: { url: page.url(), title, length: text.length },
        display: `**${title}** (${page.url()})\n\n${cleaned}`,
      };
    } catch (err) {
      return { success: false, error: `Failed to open "${url}": ${(err as Error).message}` };
    }
  }

  private async screenshotPage(pup: PuppeteerModule, input: Record<string, unknown>): Promise<SkillResult> {
    try {
      const page = await this.ensurePage(pup);

      // Navigate if URL provided
      const url = input.url as string | undefined;
      if (url) {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30_000 });
      }

      const currentUrl = page.url();
      if (currentUrl === 'about:blank') {
        return { success: false, error: 'No page is open. Use action "open" with a URL first, or provide a URL.' };
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const outputPath = (input.path as string) || path.join(os.homedir(), 'Desktop', `browser-${timestamp}.png`);

      await page.screenshot({ path: outputPath, fullPage: false });

      return {
        success: true,
        data: { path: outputPath, url: currentUrl },
        display: `Screenshot saved to ${outputPath}`,
      };
    } catch (err) {
      return { success: false, error: `Screenshot failed: ${(err as Error).message}` };
    }
  }

  private async clickElement(input: Record<string, unknown>): Promise<SkillResult> {
    const selector = input.selector as string;
    if (!selector) {
      return { success: false, error: 'Missing "selector" for click action' };
    }

    if (!this.page) {
      return { success: false, error: 'No page is open. Use action "open" first.' };
    }

    try {
      await this.page.waitForSelector(selector, { timeout: 5000 });
      await this.page.click(selector);

      // Wait briefly for any navigation or state change
      try {
        await this.page.waitForNavigation({ timeout: 3000 });
      } catch {
        // No navigation happened, that's fine
      }

      const title = await this.page.title();
      return {
        success: true,
        data: { selector, url: this.page.url(), title },
        display: `Clicked "${selector}" — now on: ${title} (${this.page.url()})`,
      };
    } catch (err) {
      return { success: false, error: `Click failed on "${selector}": ${(err as Error).message}` };
    }
  }

  private async typeText(input: Record<string, unknown>): Promise<SkillResult> {
    const selector = input.selector as string;
    const text = input.text as string;

    if (!selector) return { success: false, error: 'Missing "selector" for type action' };
    if (!text) return { success: false, error: 'Missing "text" for type action' };

    if (!this.page) {
      return { success: false, error: 'No page is open. Use action "open" first.' };
    }

    try {
      await this.page.waitForSelector(selector, { timeout: 5000 });
      await this.page.click(selector); // Focus the element
      await this.page.type(selector, text, { delay: 50 });

      return {
        success: true,
        data: { selector, textLength: text.length },
        display: `Typed ${text.length} characters into "${selector}"`,
      };
    } catch (err) {
      return { success: false, error: `Type failed on "${selector}": ${(err as Error).message}` };
    }
  }

  private async evaluateScript(input: Record<string, unknown>): Promise<SkillResult> {
    const script = input.script as string;
    if (!script) {
      return { success: false, error: 'Missing "script" for evaluate action' };
    }

    if (!this.page) {
      return { success: false, error: 'No page is open. Use action "open" first.' };
    }

    try {
      const result = await this.page.evaluate(script);
      const output = typeof result === 'string' ? result : JSON.stringify(result, null, 2);

      return {
        success: true,
        data: { result },
        display: output?.slice(0, 10_000) ?? '(no output)',
      };
    } catch (err) {
      return { success: false, error: `Evaluate failed: ${(err as Error).message}` };
    }
  }

  private validateUrl(url: string): string | null {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return `Invalid URL: "${url}"`;
    }

    const blockedProtocols = ['file:', 'chrome:', 'about:', 'data:', 'javascript:'];
    if (blockedProtocols.includes(parsed.protocol)) {
      return `Blocked URL protocol "${parsed.protocol}". Only http: and https: are allowed.`;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return `Unsupported URL protocol "${parsed.protocol}". Only http: and https: are allowed.`;
    }

    const hostname = parsed.hostname;
    if (this.isPrivateHost(hostname)) {
      return `Access to private/internal network address "${hostname}" is blocked.`;
    }

    return null;
  }

  private isPrivateHost(hostname: string): boolean {
    // Localhost
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
      return true;
    }
    // IPv6 private (fc00::/7)
    if (hostname.startsWith('[') || hostname.toLowerCase().startsWith('fc') || hostname.toLowerCase().startsWith('fd')) {
      const clean = hostname.replace(/[\[\]]/g, '').toLowerCase();
      if (clean.startsWith('fc') || clean.startsWith('fd') || clean === '::1') {
        return true;
      }
    }
    // IPv4 private ranges
    const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
    if (ipv4Match) {
      const [, a, b] = ipv4Match.map(Number);
      if (a === 10) return true;                              // 10.0.0.0/8
      if (a === 172 && b >= 16 && b <= 31) return true;       // 172.16.0.0/12
      if (a === 192 && b === 168) return true;                 // 192.168.0.0/16
      if (a === 127) return true;                              // 127.0.0.0/8
      if (a === 169 && b === 254) return true;                 // 169.254.0.0/16
      if (a === 0) return true;                                // 0.0.0.0/8
    }
    return false;
  }

  private async closeBrowser(): Promise<SkillResult> {
    try {
      this.page = null;
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
      }
      return { success: true, display: 'Browser closed.' };
    } catch (err) {
      this.browser = null;
      this.page = null;
      return { success: false, error: `Close failed: ${(err as Error).message}` };
    }
  }
}
