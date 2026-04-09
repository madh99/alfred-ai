import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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

export interface TlsOptions {
  enabled?: boolean;
  cert?: string;  // path to cert.pem
  key?: string;   // path to key.pem
}

export interface CmdbCallbacks {
  listAssets: (userId: string, filters?: Record<string, unknown>) => Promise<any[]>;
  getAsset: (userId: string, id: string) => Promise<any>;
  createAsset: (userId: string, data: Record<string, unknown>) => Promise<any>;
  updateAsset: (userId: string, id: string, data: Record<string, unknown>) => Promise<any>;
  deleteAsset: (userId: string, id: string) => Promise<boolean>;
  listRelations: (userId: string) => Promise<any[]>;
  createRelation: (userId: string, data: Record<string, unknown>) => Promise<any>;
  deleteRelation: (userId: string, id: string) => Promise<boolean>;
  discover: (userId: string) => Promise<any>;
  getStats: (userId: string) => Promise<any>;
  getChanges: (userId: string, assetId: string) => Promise<any[]>;
  listDocuments: (userId: string, filters?: Record<string, unknown>) => Promise<any[]>;
  getDocument: (userId: string, id: string) => Promise<any>;
}

export interface ItsmCallbacks {
  listIncidents: (userId: string, filters?: Record<string, unknown>) => Promise<any[]>;
  getIncident: (userId: string, id: string) => Promise<any>;
  createIncident: (userId: string, data: Record<string, unknown>) => Promise<any>;
  updateIncident: (userId: string, id: string, data: Record<string, unknown>) => Promise<any>;
  listChanges: (userId: string, filters?: Record<string, unknown>) => Promise<any[]>;
  createChange: (userId: string, data: Record<string, unknown>) => Promise<any>;
  updateChange: (userId: string, id: string, data: Record<string, unknown>) => Promise<any>;
  listServices: (userId: string, filters?: Record<string, unknown>) => Promise<any[]>;
  createService: (userId: string, data: Record<string, unknown>) => Promise<any>;
  updateService: (userId: string, id: string, data: Record<string, unknown>) => Promise<any>;
  healthCheck: (userId: string) => Promise<any>;
  getDashboard: (userId: string) => Promise<any>;
  // Problem Management
  listProblems: (userId: string, filters?: Record<string, unknown>) => Promise<any[]>;
  getProblem: (userId: string, id: string) => Promise<any>;
  createProblem: (userId: string, data: Record<string, unknown>) => Promise<any>;
  updateProblem: (userId: string, id: string, data: Record<string, unknown>) => Promise<any>;
  linkIncidentToProblem: (userId: string, problemId: string, incidentId: string) => Promise<any>;
  unlinkIncidentFromProblem: (userId: string, problemId: string, incidentId: string) => Promise<any>;
  createFixChange: (userId: string, problemId: string, data: Record<string, unknown>) => Promise<any>;
  detectPatterns: (userId: string, data: Record<string, unknown>) => Promise<any>;
  getProblemDashboard: (userId: string) => Promise<any>;
}

export interface DocsCallbacks {
  generate: (userId: string, type: string, params?: Record<string, unknown>) => Promise<any>;
  exportData: (userId: string, format?: string) => Promise<any>;
}

export interface HttpAdapterOptions {
  port: number;
  host: string;
  apiToken?: string;
  corsOrigin?: string;
  healthCheck?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
  metricsCallback?: () => string | Promise<string>;
  webhooks?: WebhookHandler[];
  dashboardCallback?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
  webUiPath?: string;
  tls?: TlsOptions;
  authCallback?: {
    loginWithCode: (code: string) => Promise<{ success: boolean; userId?: string; username?: string; role?: string; token?: string; error?: string }>;
    getUserByToken: (token: string) => Promise<{ userId: string; username: string; role: string } | null>;
  };
  oauthCallbacks?: Map<string, (code: string, state: Record<string, unknown>) => Promise<{ success: boolean; error?: string }>>;
  publicUrl?: string;
}

const MAX_BODY_SIZE = 1_048_576; // 1 MB

/**
 * HTTP API adapter — exposes Alfred as an HTTP server with SSE streaming.
 * Accepts POST /api/message and streams responses back via Server-Sent Events.
 */
export class HttpAdapter extends MessagingAdapter {
  readonly platform: Platform = 'api';
  private server: http.Server | https.Server | null = null;
  private httpFallbackServer: http.Server | null = null;
  private readonly streams = new Map<string, http.ServerResponse>();
  private messageCounter = 0;
  private readonly port: number;
  private readonly host: string;
  private readonly apiToken?: string;
  private readonly corsOrigin: string;
  private readonly healthCheckFn?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
  private readonly metricsFn?: () => string | Promise<string>;
  private readonly dashboardFn?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
  private knowledgeGraphFn?: (userId?: string) => Promise<{ entities: any[]; relations: any[] }>;
  private knowledgeGraphDeleteEntityFn?: (entityId: string) => Promise<boolean>;
  private knowledgeGraphDeleteRelationFn?: (relationId: string) => Promise<boolean>;
  private knowledgeGraphUpdateEntityFn?: (entityId: string, data: Record<string, unknown>) => Promise<boolean>;
  private knowledgeGraphUpdateRelationFn?: (relationId: string, data: Record<string, unknown>) => Promise<boolean>;
  private cmdbCallbacks?: CmdbCallbacks;
  private itsmCallbacks?: ItsmCallbacks;
  private docsCallbacks?: DocsCallbacks;
  private readonly webUiPath?: string;
  private readonly tls?: TlsOptions;
  private readonly authCb?: HttpAdapterOptions['authCallback'];
  private readonly webhooks: Map<string, WebhookHandler> = new Map();
  private readonly oauthCallbacks: Map<string, (code: string, state: Record<string, unknown>) => Promise<{ success: boolean; error?: string }>> = new Map();
  private readonly publicUrl?: string;

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
    this.tls = options?.tls;
    this.publicUrl = options?.publicUrl;
    this.authCb = options?.authCallback;
    if (options?.webhooks) {
      for (const wh of options.webhooks) {
        this.webhooks.set(wh.name, wh);
      }
    }
    if (options?.oauthCallbacks) {
      for (const [name, cb] of options.oauthCallbacks) {
        this.oauthCallbacks.set(name, cb);
      }
    }
  }

  addWebhook(handler: WebhookHandler): void {
    this.webhooks.set(handler.name, handler);
  }

  registerOAuthCallback(service: string, handler: (code: string, state: Record<string, unknown>) => Promise<{ success: boolean; error?: string }>): void {
    this.oauthCallbacks.set(service, handler);
  }

  setKnowledgeGraphCallbacks(opts: {
    getGraph: (userId?: string) => Promise<{ entities: any[]; relations: any[] }>;
    deleteEntity: (entityId: string) => Promise<boolean>;
    deleteRelation: (relationId: string) => Promise<boolean>;
    updateEntity?: (entityId: string, data: Record<string, unknown>) => Promise<boolean>;
    updateRelation?: (relationId: string, data: Record<string, unknown>) => Promise<boolean>;
  }): void {
    this.knowledgeGraphFn = opts.getGraph;
    this.knowledgeGraphDeleteEntityFn = opts.deleteEntity;
    this.knowledgeGraphDeleteRelationFn = opts.deleteRelation;
    this.knowledgeGraphUpdateEntityFn = opts.updateEntity;
    this.knowledgeGraphUpdateRelationFn = opts.updateRelation;
  }

  setCmdbCallbacks(cbs: CmdbCallbacks): void { this.cmdbCallbacks = cbs; }
  setItsmCallbacks(cbs: ItsmCallbacks): void { this.itsmCallbacks = cbs; }
  setDocsCallbacks(cbs: DocsCallbacks): void { this.docsCallbacks = cbs; }

  async connect(): Promise<void> {
    this.status = 'connecting';

    const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
      this.handleRequest(req, res);
    };

    const tlsOpts = await this.resolveTls();
    if (tlsOpts) {
      this.server = https.createServer(tlsOpts, handler);
      // Also start a plain HTTP server for Sonos TTS file serving
      // Sonos speakers cannot access HTTPS with self-signed certs
      const httpPort = this.port + 2; // e.g., 3422 if main port is 3420 (port+1 is used by cluster discovery)
      const httpHandler = (req: http.IncomingMessage, res: http.ServerResponse) => {
        // Only serve /files/tts/ on the plain HTTP port — reject everything else
        if (req.url?.startsWith('/files/tts/')) {
          this.handleRequest(req, res);
        } else {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('Use HTTPS for API access');
        }
      };
      this.httpFallbackServer = http.createServer(httpHandler);
      this.httpFallbackServer.listen(httpPort, this.host, () => {
        console.log(`[HttpAdapter] HTTP fallback for Sonos TTS file serving on port ${httpPort}`);
      });
    } else {
      this.server = http.createServer(handler);
    }

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

    // Close the servers
    if (this.httpFallbackServer) {
      this.httpFallbackServer.close();
      this.httpFallbackServer = null;
    }
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

  private async resolveTls(): Promise<{ cert: string | Buffer; key: string | Buffer } | null> {
    if (!this.tls?.enabled) return null;

    // User-provided cert
    if (this.tls.cert && this.tls.key) {
      try {
        return {
          cert: fs.readFileSync(this.tls.cert),
          key: fs.readFileSync(this.tls.key),
        };
      } catch (err) {
        throw new Error(`TLS cert/key read failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Auto-generate self-signed cert
    const tlsDir = path.join(process.env.HOME ?? process.env.USERPROFILE ?? '.', '.alfred', 'tls');
    const certPath = path.join(tlsDir, 'cert.pem');
    const keyPath = path.join(tlsDir, 'key.pem');

    if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
      return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
    }

    // Generate self-signed cert using openssl CLI
    try {
      const { execFileSync } = await import('node:child_process');
      const { generateKeyPairSync } = await import('node:crypto');

      const { privateKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });

      fs.mkdirSync(tlsDir, { recursive: true });
      fs.writeFileSync(keyPath, privateKey, { mode: 0o600 });

      // Build SAN with all relevant IPs/hostnames
      const sanEntries = new Set(['IP:127.0.0.1', 'IP:0.0.0.0', 'DNS:localhost']);
      // Add configured host if it's a real IP (not 0.0.0.0/127.0.0.1)
      if (this.host && this.host !== '0.0.0.0' && this.host !== '127.0.0.1' && this.host !== '::') {
        sanEntries.add(/^\d+\.\d+\.\d+\.\d+$/.test(this.host) ? `IP:${this.host}` : `DNS:${this.host}`);
      }
      // Extract IP/hostname from publicUrl if configured
      if (this.publicUrl) {
        try {
          const pubHost = new URL(this.publicUrl).hostname;
          if (pubHost && pubHost !== 'localhost') {
            sanEntries.add(/^\d+\.\d+\.\d+\.\d+$/.test(pubHost) ? `IP:${pubHost}` : `DNS:${pubHost}`);
          }
        } catch { /* ignore invalid URL */ }
      }

      execFileSync('openssl', [
        'req', '-new', '-x509',
        '-key', keyPath,
        '-out', certPath,
        '-days', '365',
        '-subj', '/CN=Alfred AI/O=Alfred',
        '-addext', `subjectAltName=${[...sanEntries].join(',')}`,
      ], { stdio: 'pipe' });

      return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
    } catch (err) {
      console.warn(`[HttpAdapter] Self-signed TLS cert generation failed: ${err instanceof Error ? err.message : String(err)}. Running without TLS.`);
      return null;
    }
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Security headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', this.corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname === '/api/health' && req.method === 'GET') {
      this.handleHealth(res).catch(err => this.safeError(res, err));
    } else if (url.pathname === '/api/auth/required' && req.method === 'GET') {
      // Public: tells the frontend whether auth is needed
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ authRequired: !!(this.apiToken || this.authCb) }));
    } else if (url.pathname === '/api/metrics' && req.method === 'GET') {
      this.handleMetricsAuth(req, res).catch(err => this.safeError(res, err));
    } else if (url.pathname === '/api/message' && req.method === 'POST') {
      this.handleMessage(req, res).catch(err => this.safeError(res, err));
    } else if (url.pathname === '/api/dashboard' && req.method === 'GET') {
      this.handleDashboard(req, res).catch(err => this.safeError(res, err));
    } else if (url.pathname === '/api/knowledge-graph' && req.method === 'GET') {
      this.handleKnowledgeGraph(req, res).catch(err => this.safeError(res, err));
    } else if (url.pathname.startsWith('/api/knowledge-graph/entity/') && req.method === 'DELETE') {
      this.handleKgDeleteEntity(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.startsWith('/api/knowledge-graph/relation/') && req.method === 'DELETE') {
      this.handleKgDeleteRelation(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.startsWith('/api/knowledge-graph/entity/') && req.method === 'PATCH') {
      this.handleKgUpdateEntity(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.startsWith('/api/knowledge-graph/relation/') && req.method === 'PATCH') {
      this.handleKgUpdateRelation(req, res, url).catch(err => this.safeError(res, err));
    // ── CMDB API ──
    } else if (url.pathname === '/api/cmdb/assets' && req.method === 'GET') {
      this.handleCmdbRoute(req, res, async (cbs, userId) => {
        const filters = Object.fromEntries(url.searchParams.entries());
        return cbs.listAssets(userId, filters);
      });
    } else if (url.pathname === '/api/cmdb/assets' && req.method === 'POST') {
      this.handleCmdbBodyRoute(req, res, (cbs, userId, body) => cbs.createAsset(userId, body));
    } else if (url.pathname.startsWith('/api/cmdb/assets/') && req.method === 'GET') {
      const id = url.pathname.split('/').pop()!;
      this.handleCmdbRoute(req, res, (cbs, userId) => cbs.getAsset(userId, id));
    } else if (url.pathname.startsWith('/api/cmdb/assets/') && req.method === 'PATCH') {
      const id = url.pathname.split('/api/cmdb/assets/')[1];
      this.handleCmdbBodyRoute(req, res, (cbs, userId, body) => cbs.updateAsset(userId, id, body));
    } else if (url.pathname.startsWith('/api/cmdb/assets/') && req.method === 'DELETE') {
      const id = url.pathname.split('/').pop()!;
      this.handleCmdbRoute(req, res, (cbs, userId) => cbs.deleteAsset(userId, id));
    } else if (url.pathname === '/api/cmdb/relations' && req.method === 'GET') {
      this.handleCmdbRoute(req, res, (cbs, userId) => cbs.listRelations(userId));
    } else if (url.pathname === '/api/cmdb/relations' && req.method === 'POST') {
      this.handleCmdbBodyRoute(req, res, (cbs, userId, body) => cbs.createRelation(userId, body));
    } else if (url.pathname.startsWith('/api/cmdb/relations/') && req.method === 'DELETE') {
      const id = url.pathname.split('/').pop()!;
      this.handleCmdbRoute(req, res, (cbs, userId) => cbs.deleteRelation(userId, id));
    } else if (url.pathname === '/api/cmdb/discover' && req.method === 'POST') {
      this.handleCmdbRoute(req, res, (cbs, userId) => cbs.discover(userId));
    } else if (url.pathname === '/api/cmdb/stats' && req.method === 'GET') {
      this.handleCmdbRoute(req, res, (cbs, userId) => cbs.getStats(userId));
    // ── ITSM API ──
    } else if (url.pathname === '/api/itsm/incidents' && req.method === 'GET') {
      this.handleItsmRoute(req, res, (cbs, userId) => {
        const filters = Object.fromEntries(url.searchParams.entries());
        return cbs.listIncidents(userId, filters);
      });
    } else if (url.pathname === '/api/itsm/incidents' && req.method === 'POST') {
      this.handleItsmBodyRoute(req, res, (cbs, userId, body) => cbs.createIncident(userId, body));
    } else if (url.pathname.startsWith('/api/itsm/incidents/') && req.method === 'GET') {
      const id = url.pathname.split('/').pop()!;
      this.handleItsmRoute(req, res, (cbs, userId) => cbs.getIncident(userId, id));
    } else if (url.pathname.startsWith('/api/itsm/incidents/') && req.method === 'PATCH') {
      const id = url.pathname.split('/api/itsm/incidents/')[1];
      this.handleItsmBodyRoute(req, res, (cbs, userId, body) => cbs.updateIncident(userId, id, body));
    } else if (url.pathname === '/api/itsm/changes' && req.method === 'GET') {
      this.handleItsmRoute(req, res, (cbs, userId) => {
        const filters = Object.fromEntries(url.searchParams.entries());
        return cbs.listChanges(userId, filters);
      });
    } else if (url.pathname === '/api/itsm/changes' && req.method === 'POST') {
      this.handleItsmBodyRoute(req, res, (cbs, userId, body) => cbs.createChange(userId, body));
    } else if (url.pathname.startsWith('/api/itsm/changes/') && req.method === 'PATCH') {
      const id = url.pathname.split('/api/itsm/changes/')[1];
      this.handleItsmBodyRoute(req, res, (cbs, userId, body) => cbs.updateChange(userId, id, body));
    } else if (url.pathname === '/api/itsm/services' && req.method === 'GET') {
      this.handleItsmRoute(req, res, (cbs, userId) => {
        const filters = Object.fromEntries(url.searchParams.entries());
        return cbs.listServices(userId, filters);
      });
    } else if (url.pathname === '/api/itsm/services' && req.method === 'POST') {
      this.handleItsmBodyRoute(req, res, (cbs, userId, body) => cbs.createService(userId, body));
    } else if (url.pathname.startsWith('/api/itsm/services/health-check') && req.method === 'POST') {
      this.handleItsmRoute(req, res, (cbs, userId) => cbs.healthCheck(userId));
    } else if (url.pathname.startsWith('/api/itsm/services/') && req.method === 'PATCH') {
      const id = url.pathname.split('/api/itsm/services/')[1];
      this.handleItsmBodyRoute(req, res, (cbs, userId, body) => cbs.updateService(userId, id, body));
    } else if (url.pathname === '/api/itsm/dashboard' && req.method === 'GET') {
      this.handleItsmRoute(req, res, (cbs, userId) => cbs.getDashboard(userId));
    // ── Problem Management API ──
    } else if (url.pathname === '/api/itsm/problems/detect-patterns' && req.method === 'POST') {
      this.handleItsmBodyRoute(req, res, (cbs, userId, body) => cbs.detectPatterns(userId, body));
    } else if (url.pathname === '/api/itsm/problems/dashboard' && req.method === 'GET') {
      this.handleItsmRoute(req, res, (cbs, userId) => cbs.getProblemDashboard(userId));
    } else if (url.pathname === '/api/itsm/problems' && req.method === 'GET') {
      this.handleItsmRoute(req, res, (cbs, userId) => {
        const filters = Object.fromEntries(url.searchParams.entries());
        return cbs.listProblems(userId, filters);
      });
    } else if (url.pathname === '/api/itsm/problems' && req.method === 'POST') {
      this.handleItsmBodyRoute(req, res, (cbs, userId, body) => cbs.createProblem(userId, body));
    } else if (url.pathname.match(/^\/api\/itsm\/problems\/[^/]+\/link-incident$/) && req.method === 'POST') {
      const id = url.pathname.split('/api/itsm/problems/')[1].split('/link-incident')[0];
      this.handleItsmBodyRoute(req, res, (cbs, userId, body) => cbs.linkIncidentToProblem(userId, id, body.incident_id as string));
    } else if (url.pathname.match(/^\/api\/itsm\/problems\/[^/]+\/link-incident\/[^/]+$/) && req.method === 'DELETE') {
      const parts = url.pathname.split('/');
      const problemId = parts[4];
      const incidentId = parts[6];
      this.handleItsmRoute(req, res, (cbs, userId) => cbs.unlinkIncidentFromProblem(userId, problemId, incidentId));
    } else if (url.pathname.match(/^\/api\/itsm\/problems\/[^/]+\/fix-change$/) && req.method === 'POST') {
      const id = url.pathname.split('/api/itsm/problems/')[1].split('/fix-change')[0];
      this.handleItsmBodyRoute(req, res, (cbs, userId, body) => cbs.createFixChange(userId, id, body));
    } else if (url.pathname.startsWith('/api/itsm/problems/') && req.method === 'GET') {
      const id = url.pathname.split('/api/itsm/problems/')[1];
      this.handleItsmRoute(req, res, (cbs, userId) => cbs.getProblem(userId, id));
    } else if (url.pathname.startsWith('/api/itsm/problems/') && req.method === 'PATCH') {
      const id = url.pathname.split('/api/itsm/problems/')[1];
      this.handleItsmBodyRoute(req, res, (cbs, userId, body) => cbs.updateProblem(userId, id, body));
    // ── Docs API ──
    } else if (url.pathname === '/api/docs/generate' && req.method === 'POST') {
      this.handleDocsBodyRoute(req, res, (cbs, userId, body) => cbs.generate(userId, body.type as string, body));
    } else if (url.pathname === '/api/docs/export' && req.method === 'GET') {
      this.handleDocsRoute(req, res, (cbs, userId) => cbs.exportData(userId, url.searchParams.get('format') ?? undefined));
    // ── Documents Archive API ──
    } else if (url.pathname === '/api/cmdb/documents' && req.method === 'GET') {
      this.handleCmdbRoute(req, res, (cbs, userId) => {
        const filters = Object.fromEntries(url.searchParams.entries());
        return cbs.listDocuments(userId, filters);
      });
    } else if (url.pathname.startsWith('/api/cmdb/documents/') && req.method === 'GET') {
      const id = url.pathname.split('/').pop()!;
      this.handleCmdbRoute(req, res, (cbs, userId) => cbs.getDocument(userId, id));
    } else if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      this.handleAuthLogin(req, res);
    } else if (url.pathname === '/api/auth/me' && req.method === 'GET') {
      this.handleAuthMeProtected(req, res).catch(err => this.safeError(res, err));
    } else if (url.pathname === '/api/oauth/callback' && req.method === 'GET') {
      this.handleOAuthCallback(url, res);
    } else if (url.pathname.startsWith('/api/webhook/') && req.method === 'POST') {
      const name = url.pathname.slice('/api/webhook/'.length);
      this.handleWebhook(req, res, name);
    } else if (this.webUiPath && url.pathname.startsWith('/alfred/') && req.method === 'GET') {
      this.serveStaticFile(url.pathname, res);
    } else if (this.webUiPath && url.pathname === '/alfred' && req.method === 'GET') {
      res.writeHead(302, { Location: '/alfred/' });
      res.end();
    } else if (url.pathname.startsWith('/files/tts/') && req.method === 'GET') {
      this.serveTtsFile(url.pathname, res);
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  }

  private async checkAuth(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    if (!this.apiToken && !this.authCb) return true;
    const authHeader = req.headers['authorization'];
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

    // Check static API token
    if (this.apiToken && token) {
      const expected = this.apiToken;
      if (token.length === expected.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
        return true;
      }
    }

    // Check user session token
    if (this.authCb && token) {
      const user = await this.authCb.getUserByToken(token);
      if (user) return true;
    }

    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return false;
  }

  private handleAuthLogin(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!this.authCb) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Auth not configured' })); return; }

    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', async () => {
      try {
        const { code } = JSON.parse(body) as { code?: string };
        if (!code) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Missing code' })); return; }

        const result = await this.authCb!.loginWithCode(code);
        if (result.success) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, userId: result.userId, username: result.username, role: result.role, token: result.token }));
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: result.error ?? 'Invalid code' }));
        }
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
  }

  private async handleAuthMeProtected(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    return this.handleAuthMe(req, res);
  }

  private async handleMetricsAuth(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    return this.handleMetrics(res);
  }

  private async handleAuthMe(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.authCb) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Auth not configured' })); return; }

    const authHeader = req.headers['authorization'];
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'No token' })); return; }

    const user = await this.authCb.getUserByToken(token);
    if (!user) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid token' })); return; }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(user));
  }

  private async handleDashboard(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.dashboardFn) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Dashboard not configured' }));
      return;
    }
    try {
      const data = await this.dashboardFn() as Record<string, unknown>;

      // Strip admin-only data for non-admin users
      const authHeader = req.headers['authorization'];
      const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
      const user = token && this.authCb ? await this.authCb.getUserByToken(token) : null;
      if (user && user.role !== 'admin') {
        delete data.userUsage;
        delete data.userSkillUsage;
      }

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

  private serveTtsFile(pathname: string, res: http.ServerResponse): void {
    const TTS_MIME: Record<string, string> = {
      '.mp3': 'audio/mpeg',
      '.opus': 'audio/ogg',
      '.wav': 'audio/wav',
      '.flac': 'audio/flac',
      '.aac': 'audio/aac',
      '.ogg': 'audio/ogg',
    };

    const filename = pathname.slice('/files/tts/'.length);

    // Security: prevent path traversal
    if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid filename' }));
      return;
    }

    const ttsDir = path.join(os.tmpdir(), 'alfred-tts');
    const filePath = path.join(ttsDir, filename);

    // Double-check resolved path stays inside ttsDir
    if (!path.resolve(filePath).startsWith(path.resolve(ttsDir))) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden' }));
      return;
    }

    // Auto-cleanup: remove files older than 5 minutes
    try {
      if (fs.existsSync(ttsDir)) {
        const now = Date.now();
        for (const entry of fs.readdirSync(ttsDir)) {
          try {
            const entryPath = path.join(ttsDir, entry);
            const stat = fs.statSync(entryPath);
            if (now - stat.mtimeMs > 5 * 60 * 1000) {
              fs.unlinkSync(entryPath);
            }
          } catch { /* ignore cleanup errors for individual files */ }
        }
      }
    } catch { /* ignore cleanup errors */ }

    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'File not found' }));
      return;
    }

    const stat = fs.statSync(filePath);
    const ext = path.extname(filename).toLowerCase();
    const contentType = TTS_MIME[ext] ?? 'audio/mpeg';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  }

  // ── Knowledge Graph API ─────────────────────────────────

  private async handleKnowledgeGraph(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.knowledgeGraphFn) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Knowledge graph not configured' })); return;
    }
    try {
      // Admin can pass ?userId= to view other users' KGs
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const requestedUserId = url.searchParams.get('userId') ?? undefined;
      const data = await this.knowledgeGraphFn(requestedUserId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Knowledge graph fetch failed' }));
    }
  }

  private async handleKgDeleteEntity(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.knowledgeGraphDeleteEntityFn) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const entityId = url.pathname.split('/').pop()!;
    const ok = await this.knowledgeGraphDeleteEntityFn(entityId);
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: ok }));
  }

  private async handleKgDeleteRelation(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.knowledgeGraphDeleteRelationFn) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const relationId = url.pathname.split('/').pop()!;
    const ok = await this.knowledgeGraphDeleteRelationFn(relationId);
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: ok }));
  }

  private async handleKgUpdateEntity(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.knowledgeGraphUpdateEntityFn) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const entityId = url.pathname.split('/').pop()!;
    const body = await this.readBody(req);
    const data = JSON.parse(body);
    const ok = await this.knowledgeGraphUpdateEntityFn(entityId, data);
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: ok }));
  }

  private async handleKgUpdateRelation(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.knowledgeGraphUpdateRelationFn) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const relationId = url.pathname.split('/').pop()!;
    const body = await this.readBody(req);
    const data = JSON.parse(body);
    const ok = await this.knowledgeGraphUpdateRelationFn(relationId, data);
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: ok }));
  }

  // ── CMDB/ITSM/Docs generic handlers ──

  private async resolveUserId(req: http.IncomingMessage): Promise<string> {
    const token = req.headers['authorization']?.startsWith('Bearer ') ? req.headers['authorization'].slice(7) : null;
    if (this.authCb && token) {
      const user = await this.authCb.getUserByToken(token);
      if (user) return (user as any).masterUserId ?? (user as any).id ?? '';
    }
    return '';
  }

  private handleCmdbRoute(req: http.IncomingMessage, res: http.ServerResponse, fn: (cbs: CmdbCallbacks, userId: string) => Promise<any>): void {
    (async () => {
      if (!(await this.checkAuth(req, res))) return;
      if (!this.cmdbCallbacks) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'CMDB not configured' })); return; }
      const userId = await this.resolveUserId(req);
      const result = await fn(this.cmdbCallbacks, userId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    })().catch(err => this.safeError(res, err));
  }

  private handleCmdbBodyRoute(req: http.IncomingMessage, res: http.ServerResponse, fn: (cbs: CmdbCallbacks, userId: string, body: Record<string, unknown>) => Promise<any>): void {
    (async () => {
      if (!(await this.checkAuth(req, res))) return;
      if (!this.cmdbCallbacks) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'CMDB not configured' })); return; }
      const userId = await this.resolveUserId(req);
      let body: Record<string, unknown>;
      try { body = JSON.parse(await this.readBody(req)); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }
      const result = await fn(this.cmdbCallbacks, userId, body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    })().catch(err => this.safeError(res, err));
  }

  private handleItsmRoute(req: http.IncomingMessage, res: http.ServerResponse, fn: (cbs: ItsmCallbacks, userId: string) => Promise<any>): void {
    (async () => {
      if (!(await this.checkAuth(req, res))) return;
      if (!this.itsmCallbacks) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'ITSM not configured' })); return; }
      const userId = await this.resolveUserId(req);
      const result = await fn(this.itsmCallbacks, userId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    })().catch(err => this.safeError(res, err));
  }

  private handleItsmBodyRoute(req: http.IncomingMessage, res: http.ServerResponse, fn: (cbs: ItsmCallbacks, userId: string, body: Record<string, unknown>) => Promise<any>): void {
    (async () => {
      if (!(await this.checkAuth(req, res))) return;
      if (!this.itsmCallbacks) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'ITSM not configured' })); return; }
      const userId = await this.resolveUserId(req);
      let body: Record<string, unknown>;
      try { body = JSON.parse(await this.readBody(req)); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }
      const result = await fn(this.itsmCallbacks, userId, body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    })().catch(err => this.safeError(res, err));
  }

  private handleDocsRoute(req: http.IncomingMessage, res: http.ServerResponse, fn: (cbs: DocsCallbacks, userId: string) => Promise<any>): void {
    (async () => {
      if (!(await this.checkAuth(req, res))) return;
      if (!this.docsCallbacks) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Docs not configured' })); return; }
      const userId = await this.resolveUserId(req);
      const result = await fn(this.docsCallbacks, userId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    })().catch(err => this.safeError(res, err));
  }

  private handleDocsBodyRoute(req: http.IncomingMessage, res: http.ServerResponse, fn: (cbs: DocsCallbacks, userId: string, body: Record<string, unknown>) => Promise<any>): void {
    (async () => {
      if (!(await this.checkAuth(req, res))) return;
      if (!this.docsCallbacks) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Docs not configured' })); return; }
      const userId = await this.resolveUserId(req);
      let body: Record<string, unknown>;
      try { body = JSON.parse(await this.readBody(req)); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }
      const result = await fn(this.docsCallbacks, userId, body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    })().catch(err => this.safeError(res, err));
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }

  private safeError(res: http.ServerResponse, err: unknown): void {
    try {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ error: 'Internal server error' }));
    } catch { /* response already closed */ }
  }

  private async handleHealth(res: http.ServerResponse): Promise<void> {
    const health = await this.healthCheckFn?.() ?? {};
    const status = (health.db !== false) ? 'ok' : 'degraded';
    const code = status === 'ok' ? 200 : 503;
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status, ...health, timestamp: new Date().toISOString() }));
  }

  private async handleMetrics(res: http.ServerResponse): Promise<void> {
    if (this.metricsFn) {
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(await this.metricsFn());
    } else {
      // Fallback: return health as JSON
      await this.handleHealth(res);
    }
  }

  private async handleMessage(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Auth check
    if (!(await this.checkAuth(req, res))) return;

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

        // Set up SSE response (include CORS + security headers since writeHead replaces setHeader)
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': this.corsOrigin,
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'X-Content-Type-Options': 'nosniff',
        });
        res.flushHeaders();

        this.streams.set(chatId, res);

        // Clean up on client disconnect (use res, not req — req closes after body is read)
        res.on('close', () => {
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

  private async handleOAuthCallback(url: URL, res: http.ServerResponse): Promise<void> {
    const code = url.searchParams.get('code');
    const stateParam = url.searchParams.get('state');
    const error = url.searchParams.get('error');

    if (error) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<html><body><h2>Autorisierung abgelehnt</h2><p>${error}</p><p>Du kannst dieses Fenster schließen.</p></body></html>`);
      return;
    }

    if (!code || !stateParam) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body><h2>Fehler</h2><p>Code oder State fehlt.</p></body></html>');
      return;
    }

    let state: Record<string, unknown>;
    try {
      state = JSON.parse(Buffer.from(stateParam, 'base64url').toString());
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body><h2>Fehler</h2><p>Ung\u00fcltiger State-Parameter.</p></body></html>');
      return;
    }

    const service = state.service as string;
    const handler = this.oauthCallbacks.get(service);
    if (!handler) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<html><body><h2>Fehler</h2><p>Kein OAuth-Handler f\u00fcr "${service}" registriert.</p></body></html>`);
      return;
    }

    try {
      const result = await handler(code, state);
      if (result.success) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body><h2>Erfolgreich verbunden!</h2><p>Du kannst dieses Fenster schlie\u00dfen und zu Alfred zur\u00fcckkehren.</p></body></html>');
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<html><body><h2>Fehler</h2><p>${result.error ?? 'Unbekannter Fehler'}</p></body></html>`);
      }
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<html><body><h2>Fehler</h2><p>${err instanceof Error ? err.message : 'Interner Fehler'}</p></body></html>`);
    }
  }

  private writeSseEvent(res: http.ServerResponse, event: string, data: Record<string, unknown>): void {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}
