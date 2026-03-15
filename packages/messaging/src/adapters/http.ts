import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Platform, NormalizedMessage, SendMessageOptions } from '@alfred/types';
import { MessagingAdapter } from '../adapter.js';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export interface WebhookHandler {
  name: string;
  secret: string;
  callback: (payload: Record<string, unknown>) => Promise<void>;
}

export interface HttpAdapterOptions {
  port: number;
  host: string;
  apiToken?: string;
  corsOrigin?: string;
  healthCheck?: () => Record<string, unknown>;
  metricsCallback?: () => string;
  webhooks?: WebhookHandler[];
  dashboardCallback?: () => Record<string, unknown>;
  webUiPath?: string;  // path to static web UI files (apps/web/out/)
}

const MAX_BODY_SIZE = 1_048_576; // 1 MB

/**
 * HTTP API adapter — exposes Alfred as an HTTP server with SSE streaming.
 * Accepts POST /api/message and streams responses back via Server-Sent Events.
 */
export class HttpAdapter extends MessagingAdapter {
  readonly platform: Platform = 'api';
  private server: http.Server | null = null;
  private readonly streams = new Map<string, http.ServerResponse>();
  private messageCounter = 0;
  private readonly port: number;
  private readonly host: string;
  private readonly apiToken?: string;
  private readonly corsOrigin: string;
  private readonly healthCheckFn?: () => Record<string, unknown>;
  private readonly metricsFn?: () => string;
  private readonly dashboardFn?: () => Record<string, unknown>;
  private readonly webUiPath?: string;
  private readonly webhooks: Map<string, WebhookHandler> = new Map();

  constructor(port: number, host: string, options?: Omit<HttpAdapterOptions, 'port' | 'host'>) {
    super();
    this.port = port;
    this.host = host;
    this.apiToken = options?.apiToken;
    this.corsOrigin = options?.corsOrigin ?? 'http://localhost:3420';
    this.healthCheckFn = options?.healthCheck;
    this.metricsFn = options?.metricsCallback;
    this.dashboardFn = options?.dashboardCallback;
    this.webUiPath = options?.webUiPath;
    if (options?.webhooks) {
      for (const wh of options.webhooks) {
        this.webhooks.set(wh.name, wh);
      }
    }
  }

  addWebhook(handler: WebhookHandler): void {
    this.webhooks.set(handler.name, handler);
  }

  async connect(): Promise<void> {
    this.status = 'connecting';

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.port, this.host, () => {
        resolve();
      });
      this.server!.once('error', reject);
    });

    this.status = 'connected';
    this.emit('connected');
  }

  async disconnect(): Promise<void> {
    // Close all active SSE streams
    for (const [chatId, res] of this.streams) {
      this.writeSseEvent(res, 'done', { type: 'done' });
      res.end();
      this.streams.delete(chatId);
    }

    // Close the server
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }

    this.status = 'disconnected';
    this.emit('disconnected');
  }

  async sendMessage(chatId: string, text: string, _options?: SendMessageOptions): Promise<string> {
    const id = `api-resp-${++this.messageCounter}`;
    const res = this.streams.get(chatId);
    if (res) {
      this.writeSseEvent(res, 'response', { type: 'response', text });
    }
    return id;
  }

  async editMessage(chatId: string, _messageId: string, text: string, _options?: SendMessageOptions): Promise<void> {
    const res = this.streams.get(chatId);
    if (res) {
      this.writeSseEvent(res, 'status', { type: 'status', text });
    }
  }

  async deleteMessage(_chatId: string, _messageId: string): Promise<void> {
    // No-op for HTTP API
  }

  async sendPhoto(chatId: string, photo: Buffer, caption?: string): Promise<string | undefined> {
    const res = this.streams.get(chatId);
    if (res) {
      this.writeSseEvent(res, 'attachment', {
        type: 'attachment',
        attachmentType: 'image',
        data: photo.toString('base64'),
        caption,
      });
    }
    return `api-photo-${++this.messageCounter}`;
  }

  async sendFile(chatId: string, file: Buffer, fileName: string, caption?: string): Promise<string | undefined> {
    const res = this.streams.get(chatId);
    if (res) {
      this.writeSseEvent(res, 'attachment', {
        type: 'attachment',
        attachmentType: 'file',
        data: file.toString('base64'),
        fileName,
        caption,
      });
    }
    return `api-file-${++this.messageCounter}`;
  }

  async sendVoice(chatId: string, audio: Buffer, caption?: string): Promise<string | undefined> {
    const res = this.streams.get(chatId);
    if (res) {
      this.writeSseEvent(res, 'attachment', {
        type: 'attachment',
        attachmentType: 'voice',
        data: audio.toString('base64'),
        caption,
      });
    }
    return `api-voice-${++this.messageCounter}`;
  }

  endStream(chatId: string): void {
    const res = this.streams.get(chatId);
    if (res) {
      this.writeSseEvent(res, 'done', { type: 'done' });
      res.end();
      this.streams.delete(chatId);
    }
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Security headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', this.corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname === '/api/health' && req.method === 'GET') {
      this.handleHealth(res);
    } else if (url.pathname === '/api/metrics' && req.method === 'GET') {
      this.handleMetrics(res);
    } else if (url.pathname === '/api/message' && req.method === 'POST') {
      this.handleMessage(req, res);
    } else if (url.pathname === '/api/dashboard' && req.method === 'GET') {
      this.handleDashboard(req, res);
    } else if (url.pathname.startsWith('/api/webhook/') && req.method === 'POST') {
      const name = url.pathname.slice('/api/webhook/'.length);
      this.handleWebhook(req, res, name);
    } else if (this.webUiPath && url.pathname.startsWith('/alfred/') && req.method === 'GET') {
      this.serveStaticFile(url.pathname, res);
    } else if (this.webUiPath && url.pathname === '/alfred' && req.method === 'GET') {
      res.writeHead(302, { Location: '/alfred/' });
      res.end();
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  }

  private checkAuth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    if (!this.apiToken) return true;
    const authHeader = req.headers['authorization'];
    const expected = `Bearer ${this.apiToken}`;
    if (!authHeader || authHeader.length !== expected.length ||
        !crypto.timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected))) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return false;
    }
    return true;
  }

  private handleDashboard(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!this.checkAuth(req, res)) return;
    if (!this.dashboardFn) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Dashboard not configured' }));
      return;
    }
    try {
      const data = this.dashboardFn();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Dashboard data fetch failed' }));
    }
  }

  private serveStaticFile(pathname: string, res: http.ServerResponse): void {
    if (!this.webUiPath) { res.writeHead(404); res.end(); return; }

    // Strip basePath prefix
    let filePath = pathname.replace(/^\/alfred/, '');
    if (!filePath || filePath === '/') filePath = '/index.html';

    // Security: prevent directory traversal
    const resolved = path.resolve(this.webUiPath, '.' + filePath);
    if (!resolved.startsWith(path.resolve(this.webUiPath))) {
      res.writeHead(403); res.end(); return;
    }

    // Try exact file, then with .html, then index.html in directory
    let target = resolved;
    if (!fs.existsSync(target)) {
      if (fs.existsSync(target + '.html')) target = target + '.html';
      else if (fs.existsSync(path.join(target, 'index.html'))) target = path.join(target, 'index.html');
      else { res.writeHead(404, { 'Content-Type': 'text/html' }); res.end('Not found'); return; }
    }

    // Resolve directories to index.html
    try {
      const initialStat = fs.statSync(target);
      if (initialStat.isDirectory()) {
        const indexPath = path.join(target, 'index.html');
        if (fs.existsSync(indexPath)) target = indexPath;
        else { res.writeHead(404); res.end(); return; }
      }
    } catch { res.writeHead(404); res.end(); return; }

    // Get final stat AFTER resolving directory → index.html
    const stat = fs.statSync(target);
    const ext = path.extname(target).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
    const cacheControl = ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'Cache-Control': cacheControl,
    });
    fs.createReadStream(target).pipe(res);
  }

  private handleHealth(res: http.ServerResponse): void {
    const health = this.healthCheckFn?.() ?? {};
    const status = (health.db !== false) ? 'ok' : 'degraded';
    const code = status === 'ok' ? 200 : 503;
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status, ...health, timestamp: new Date().toISOString() }));
  }

  private handleMetrics(res: http.ServerResponse): void {
    if (this.metricsFn) {
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(this.metricsFn());
    } else {
      // Fallback: return health as JSON
      this.handleHealth(res);
    }
  }

  private handleMessage(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Auth check
    if (!this.checkAuth(req, res)) return;

    let body = '';
    let bodySize = 0;
    let aborted = false;

    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      bodySize += chunk.length;
      if (bodySize > MAX_BODY_SIZE) {
        aborted = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
        req.destroy();
        return;
      }
      body += chunk.toString();
    });

    req.on('end', () => {
      if (aborted) return;
      try {
        const parsed = JSON.parse(body) as { text?: string; chatId?: string; userId?: string };
        const text = parsed.text;
        if (!text || typeof text !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing or invalid "text" field' }));
          return;
        }

        const chatId = parsed.chatId ?? `api-chat-${crypto.randomUUID()}`;
        const userId = parsed.userId ?? 'api-user';

        // Close any existing stream for this chatId
        const existingStream = this.streams.get(chatId);
        if (existingStream) {
          this.writeSseEvent(existingStream, 'done', { type: 'done' });
          existingStream.end();
        }

        // Set up SSE response
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        this.streams.set(chatId, res);

        // Clean up on client disconnect
        req.on('close', () => {
          this.streams.delete(chatId);
        });

        // Emit normalized message for processing
        this.messageCounter++;
        const message: NormalizedMessage = {
          id: `api-${this.messageCounter}`,
          platform: 'api',
          chatId,
          chatType: 'dm',
          userId,
          userName: userId,
          displayName: 'API User',
          text,
          timestamp: new Date(),
        };

        this.emit('message', message);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      }
    });
  }

  private handleWebhook(req: http.IncomingMessage, res: http.ServerResponse, name: string): void {
    const handler = this.webhooks.get(name);
    if (!handler) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Webhook "${name}" not found` }));
      return;
    }

    let body = '';
    let bodySize = 0;
    let aborted = false;

    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      bodySize += chunk.length;
      if (bodySize > MAX_BODY_SIZE) {
        aborted = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
        req.destroy();
        return;
      }
      body += chunk.toString();
    });

    req.on('end', async () => {
      if (aborted) return;

      // HMAC-SHA256 signature validation
      const signature = req.headers['x-webhook-signature'] as string | undefined;
      if (!signature) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing X-Webhook-Signature header' }));
        return;
      }

      const expectedBuf = crypto.createHmac('sha256', handler.secret).update(body).digest();
      const signatureBuf = Buffer.from(signature, 'hex');
      if (signatureBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(signatureBuf, expectedBuf)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid signature' }));
        return;
      }

      try {
        const payload = JSON.parse(body) as Record<string, unknown>;
        await handler.callback(payload);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }));
      }
    });
  }

  private writeSseEvent(res: http.ServerResponse, event: string, data: Record<string, unknown>): void {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}
