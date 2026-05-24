import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type { Duplex } from 'node:stream';
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
  getDocumentTree: (userId: string) => Promise<any>;
  saveDocument: (userId: string, data: Record<string, unknown>) => Promise<any>;
  updateDocument: (userId: string, id: string, data: Record<string, unknown>) => Promise<any>;
  deleteDocument: (userId: string, id: string) => Promise<boolean>;
  getDocumentVersions: (userId: string, entityType: string, entityId: string, docType: string) => Promise<any[]>;
  searchDocuments: (userId: string, query: string, filters?: Record<string, unknown>) => Promise<any[]>;
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
  // v632 — Bulk-Merge + Backfill (WebUI)
  bulkLinkToProblem: (userId: string, problemId: string, incidentIds: string[]) => Promise<{ linked: number; failed: string[] }>;
  promoteIncidentsToProblem: (userId: string, data: { title: string; priority?: string; incidentIds: string[] }) => Promise<any>;
  backfillAssets: (userId: string) => Promise<{ updated: number; skipped: number; unmatched: number; total: number }>;
  // v645 — Generic Bulk-Actions
  bulkIncidents: (userId: string, data: { ids: string[]; action: string; params?: Record<string, unknown> }) => Promise<{ ok: number; failed: string[] }>;
  bulkChanges: (userId: string, data: { ids: string[]; action: string; params?: Record<string, unknown> }) => Promise<{ ok: number; failed: string[] }>;
  bulkProblems: (userId: string, data: { ids: string[]; action: string; params?: Record<string, unknown> }) => Promise<{ ok: number; failed: string[] }>;
  bulkServices: (userId: string, data: { ids: string[]; action: string; params?: Record<string, unknown> }) => Promise<{ ok: number; failed: string[] }>;
  // Service Management
  getService: (userId: string, id: string) => Promise<any>;
  deleteService: (userId: string, id: string) => Promise<boolean>;
  getServicesForAsset: (userId: string, assetId: string) => Promise<any[]>;
  generateDocs: (userId: string, serviceId: string) => Promise<any>;
  // SLA Management
  setSla: (userId: string, targetType: string, targetId: string, sla: Record<string, unknown>) => Promise<any>;
  getSlaReport: (userId: string, targetType: string, targetId: string, period?: string) => Promise<any>;
  checkSlaCompliance: (userId: string) => Promise<any>;
  getSlaBreaches: (userId: string, period?: string) => Promise<any[]>;
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
  // v622 — optionaler `opts` mit `range`-Query-Param wird vom dashboardCallback
  // genutzt um den Zeitraum (today/week/month/year/all) zu wählen.
  dashboardCallback?: (opts?: { range?: string; granularity?: string; date?: string }) => Record<string, unknown> | Promise<Record<string, unknown>>;
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
  private readonly dashboardFn?: (opts?: { range?: string }) => Record<string, unknown> | Promise<Record<string, unknown>>;
  private knowledgeGraphFn?: (userId?: string) => Promise<{ entities: any[]; relations: any[] }>;
  private knowledgeGraphDeleteEntityFn?: (entityId: string) => Promise<boolean>;
  private knowledgeGraphDeleteRelationFn?: (relationId: string) => Promise<boolean>;
  private knowledgeGraphUpdateEntityFn?: (entityId: string, data: Record<string, unknown>) => Promise<boolean>;
  private knowledgeGraphUpdateRelationFn?: (relationId: string, data: Record<string, unknown>) => Promise<boolean>;
  private memoriesListFn?: (filter?: { type?: string }) => Promise<any[]>;
  private memoriesDeleteFn?: (memoryId: string) => Promise<boolean>;
  /** v606 K6 — patch the memory type (for UI-driven reclassification). */
  private memoriesUpdateTypeFn?: (memoryId: string, type: string) => Promise<boolean>;
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

  setMemoryCallbacks(opts: {
    list: (filter?: { type?: string }) => Promise<any[]>;
    delete: (memoryId: string) => Promise<boolean>;
    /** v606 K6 — optional type-update callback (e.g. UI reclassification). */
    updateType?: (memoryId: string, type: string) => Promise<boolean>;
  }): void {
    this.memoriesListFn = opts.list;
    this.memoriesDeleteFn = opts.delete;
    this.memoriesUpdateTypeFn = opts.updateType;
  }

  private runbooksListFn?: (filter?: { status?: string; sourceType?: string }) => Promise<any[]>;
  private runbooksGetFn?: (id: string) => Promise<any | null>;
  private runbooksUpdateFn?: (id: string, patch: Record<string, unknown>) => Promise<any | null>;
  private runbooksDeleteFn?: (id: string) => Promise<boolean>;

  setRunbookCallbacks(opts: {
    list: (filter?: { status?: string; sourceType?: string }) => Promise<any[]>;
    get: (id: string) => Promise<any | null>;
    update: (id: string, patch: Record<string, unknown>) => Promise<any | null>;
    delete: (id: string) => Promise<boolean>;
  }): void {
    this.runbooksListFn = opts.list;
    this.runbooksGetFn = opts.get;
    this.runbooksUpdateFn = opts.update;
    this.runbooksDeleteFn = opts.delete;
  }

  // v609 — Project-Agent-Sessions API (WebUI list/inspect/stop)
  private projectAgentsListFn?: (filter?: { phase?: string }) => Promise<any[]>;
  private projectAgentsGetFn?: (taskId: string) => Promise<any | null>;
  private projectAgentsStopFn?: (taskId: string) => Promise<boolean>;
  private projectAgentsResumeFn?: (taskId: string, notes?: string) => Promise<{ ok: boolean; taskId?: string; error?: string }>;
  private projectAgentsPlanFn?: (taskId: string) => Promise<any[]>;
  // v651 — Live-Output-Stream + Live-Interjection
  private projectAgentsSubscribeOutputFn?: (taskId: string, cb: (line: { ts: number; source: string; text: string }) => void) => { history: Array<{ ts: number; source: string; text: string }>; unsubscribe: () => void } | null;
  private projectAgentsInterjectFn?: (taskId: string, text: string) => Promise<{ ok: boolean; error?: string }>;

  setProjectAgentCallbacks(opts: {
    list: (filter?: { phase?: string }) => Promise<any[]>;
    get: (taskId: string) => Promise<any | null>;
    stop: (taskId: string) => Promise<boolean>;
    resume?: (taskId: string, notes?: string) => Promise<{ ok: boolean; taskId?: string; error?: string }>;
    plan?: (taskId: string) => Promise<any[]>;
    subscribeOutput?: (taskId: string, cb: (line: { ts: number; source: string; text: string }) => void) => { history: Array<{ ts: number; source: string; text: string }>; unsubscribe: () => void } | null;
    interject?: (taskId: string, text: string) => Promise<{ ok: boolean; error?: string }>;
  }): void {
    this.projectAgentsListFn = opts.list;
    this.projectAgentsGetFn = opts.get;
    this.projectAgentsStopFn = opts.stop;
    this.projectAgentsResumeFn = opts.resume;
    this.projectAgentsPlanFn = opts.plan;
    this.projectAgentsSubscribeOutputFn = opts.subscribeOutput;
    this.projectAgentsInterjectFn = opts.interject;
  }

  // v623 — Background-Tasks API (WebUI list/inspect/cancel)
  private backgroundTasksListFn?: (filter?: { status?: string }) => Promise<any[]>;
  private backgroundTasksGetFn?: (id: string) => Promise<any | null>;
  private backgroundTasksCancelFn?: (id: string) => Promise<boolean>;

  setBackgroundTaskCallbacks(opts: {
    list: (filter?: { status?: string }) => Promise<any[]>;
    get: (id: string) => Promise<any | null>;
    cancel: (id: string) => Promise<boolean>;
  }): void {
    this.backgroundTasksListFn = opts.list;
    this.backgroundTasksGetFn = opts.get;
    this.backgroundTasksCancelFn = opts.cancel;
  }

  // v627 — Conversation-History API (WebUI viewer)
  private conversationsListFn?: (filter?: { platform?: string; limit?: number; offset?: number; sortBy?: string; sinceIso?: string; untilIso?: string; includeDeleted?: boolean }) => Promise<any[]>;
  private conversationsMessagesFn?: (id: string, opts?: { beforeIso?: string; limit?: number }) => Promise<any[]>;
  private conversationsSummaryFn?: (id: string) => Promise<any | null>;
  private conversationsSearchFn?: (query: string, opts?: { limit?: number }) => Promise<any[]>;
  // v644 — Lifecycle
  private conversationsPatchFn?: (id: string, patch: { customLabel?: string | null; pinned?: boolean }) => Promise<void>;
  private conversationsDeleteFn?: (id: string, hard?: boolean) => Promise<void>;
  private conversationsBranchFn?: (id: string, atMessageId: string) => Promise<{ newConversationId: string }>;
  private conversationsExportFn?: (ids: string[]) => Promise<{ format: 'markdown'; entries: Array<{ id: string; filename: string; content: string }> }>;
  private conversationsReplayFn?: (conversationId: string, messageId: string) => Promise<{ ok: boolean; reason?: string; result?: any }>;
  private transcribeFn?: (audioBuffer: Buffer, mimeType: string) => Promise<string>;

  setTranscribeCallback(fn: (audioBuffer: Buffer, mimeType: string) => Promise<string>): void {
    this.transcribeFn = fn;
  }

  setConversationCallbacks(opts: {
    list: (filter?: { platform?: string; limit?: number; offset?: number; sortBy?: string; sinceIso?: string; untilIso?: string; includeDeleted?: boolean }) => Promise<any[]>;
    messages: (id: string, opts?: { beforeIso?: string; limit?: number }) => Promise<any[]>;
    summary: (id: string) => Promise<any | null>;
    search: (query: string, opts?: { limit?: number }) => Promise<any[]>;
    patch?: (id: string, patch: { customLabel?: string | null; pinned?: boolean }) => Promise<void>;
    deleteConv?: (id: string, hard?: boolean) => Promise<void>;
    branch?: (id: string, atMessageId: string) => Promise<{ newConversationId: string }>;
    exportConv?: (ids: string[]) => Promise<{ format: 'markdown'; entries: Array<{ id: string; filename: string; content: string }> }>;
    replay?: (conversationId: string, messageId: string) => Promise<{ ok: boolean; reason?: string; result?: any }>;
  }): void {
    this.conversationsListFn = opts.list;
    this.conversationsMessagesFn = opts.messages;
    this.conversationsSummaryFn = opts.summary;
    this.conversationsSearchFn = opts.search;
    this.conversationsPatchFn = opts.patch;
    this.conversationsDeleteFn = opts.deleteConv;
    this.conversationsBranchFn = opts.branch;
    this.conversationsExportFn = opts.exportConv;
    this.conversationsReplayFn = opts.replay;
  }

  // v629 — Confirmations + Reminders Side-Panel API
  private confirmationsListFn?: () => Promise<any[]>;
  private confirmationsDecideFn?: (id: string, decision: 'approve' | 'reject' | string) => Promise<{ ok: boolean; reason?: string }>;
  private remindersListFn?: () => Promise<any[]>;

  setConfirmationCallbacks(opts: {
    list: () => Promise<any[]>;
    decide: (id: string, decision: 'approve' | 'reject' | string) => Promise<{ ok: boolean; reason?: string }>;
  }): void {
    this.confirmationsListFn = opts.list;
    this.confirmationsDecideFn = opts.decide;
  }

  setRemindersCallback(list: () => Promise<any[]>): void {
    this.remindersListFn = list;
  }

  // v661 — Todos + Notes API
  private todosCallbacks?: {
    list: (opts?: { list?: string; includeCompleted?: boolean }) => Promise<any[]>;
    // v671 — projectId optional für Spiegel-Open-Item beim Anlegen
    add: (input: { title: string; description?: string; priority?: string; dueDate?: string; list?: string; projectId?: string }) => Promise<any>;
    update: (id: string, input: Record<string, unknown>) => Promise<any | null>;
    complete: (id: string) => Promise<boolean>;
    delete: (id: string) => Promise<boolean>;
    // v670 — Arbeitsnotizen / Fortschritte pro Todo
    listNotes?: (todoId: string) => Promise<any[]>;
    addNote?: (todoId: string, content: string) => Promise<any | null>;
    deleteNote?: (noteId: string) => Promise<boolean>;
    // v672 — M:N-Verknüpfung Todo ↔ User-Note (gibt aufgelöste Note-Objekte zurück)
    listLinkedNotes?: (todoId: string) => Promise<any[]>;
    linkNote?: (todoId: string, noteId: string) => Promise<boolean>;
    unlinkNote?: (todoId: string, noteId: string) => Promise<boolean>;
    listLinkedTodos?: (noteId: string) => Promise<any[]>;
  };
  private notesCallbacks?: {
    list: (opts?: { query?: string; limit?: number }) => Promise<any[]>;
    add: (input: { title: string; content: string }) => Promise<any>;
    update: (id: string, input: { title?: string; content?: string }) => Promise<any | null>;
    delete: (id: string) => Promise<boolean>;
  };

  setTodosCallbacks(cbs: typeof HttpAdapter.prototype.todosCallbacks): void {
    this.todosCallbacks = cbs;
  }
  // v673 — Attachments (Documents/Files/URLs/Uploads für Todos + Notes)
  private attachmentsCallbacks?: {
    list: (entityType: 'todo' | 'note', entityId: string) => Promise<any[]>;
    add: (input: { entityType: 'todo' | 'note'; entityId: string; sourceKind: string; sourceRef: string; label?: string; mimeType?: string; sizeBytes?: number }) => Promise<any | null>;
    delete: (id: string) => Promise<boolean>;
    listDocuments?: () => Promise<any[]>;
    listFiles?: () => Promise<any[]>;
    uploadFile?: (input: { filename: string; mimeType: string; base64Data: string }) => Promise<any | null>;
    // v674 — Download eines FileStore-Files (User-Scope-Check inside)
    readFile?: (key: string) => Promise<{ data: Buffer; fileName: string; mimeType?: string } | null>;
  };
  setAttachmentsCallbacks(cbs: typeof HttpAdapter.prototype.attachmentsCallbacks): void {
    this.attachmentsCallbacks = cbs;
  }

  setNotesCallbacks(cbs: typeof HttpAdapter.prototype.notesCallbacks): void {
    this.notesCallbacks = cbs;
  }

  // v638 — Insights API
  private insightsListFn?: (filter?: { category?: string; status?: string; limit?: number }) => Promise<any[]>;
  private insightsDismissFn?: (id: string) => Promise<void>;
  private insightsSnoozeFn?: (id: string, hours: number) => Promise<void>;
  private insightsActFn?: (id: string) => Promise<{ ok: boolean; result?: any; reason?: string }>;
  private insightsSweepFn?: () => Promise<{ inserted: number; refreshed: number; perAdapter: Record<string, number>; errors: string[] }>;
  private insightsStatsFn?: () => Promise<Record<string, number>>;
  // v695 — Bulk-Dismiss aller offenen Insights einer Kategorie (für „kg-gap"-Cleanup nach v695)
  private insightsDismissCategoryFn?: (category: string) => Promise<number>;

  // v698 — Sandbox-Proxy: löst sandboxId+token → upstreamPort + ownership
  private sandboxProxyResolve?: (sandboxId: string, token: string | null) => Promise<
    | { ok: true; hostPort: number; userId: string }
    | { ok: false; status: number; message: string }
  >;

  // v699 — Sandbox-CRUD-Callbacks (Wire-Up von alfred.ts → SandboxManager)
  // v703 — sessionId optional + chat-message + chat-list + listAll
  private sandboxCallbacks?: {
    status: () => Promise<Record<string, unknown>>;
    list: (filter: { projectId?: string; sessionId?: string; userId?: string }) => Promise<unknown[]>;
    listAll: (userId: string) => Promise<unknown[]>;
    getById: (sandboxId: string) => Promise<unknown | null>;
    create: (input: { projectId: string; sessionId?: string | null; mode: string; slug?: string; requestUserId?: string }) => Promise<unknown>;
    pause: (sandboxId: string) => Promise<void>;
    resume: (sandboxId: string) => Promise<void>;
    discard: (sandboxId: string) => Promise<void>;
    merge: (sandboxId: string, opts: { strategy?: string; commitMessage?: string; prTitle?: string; prBody?: string }) => Promise<{ ok: boolean; prUrl?: string; reason?: string }>;
    diff: (sandboxId: string) => Promise<string>;
    chatList: (sandboxId: string) => Promise<unknown[]>;
    chatSendMessage: (sandboxId: string, message: string) => Promise<{ ok: boolean; userMessageId?: string; taskId?: string; reason?: string }>;
  };

  // v639 — Goals API
  private goalsListFn?: (filter?: { status?: string; category?: string }) => Promise<any[]>;
  private goalsGetFn?: (id: string) => Promise<{ goal: any; checkpoints: any[] } | null>;
  private goalsAddFn?: (data: Record<string, unknown>) => Promise<any>;
  private goalsUpdateFn?: (id: string, data: Record<string, unknown>) => Promise<any>;
  private goalsCheckFn?: (id: string, status: string, notes?: string) => Promise<void>;

  setGoalsCallbacks(opts: {
    list: (filter?: { status?: string; category?: string }) => Promise<any[]>;
    get: (id: string) => Promise<{ goal: any; checkpoints: any[] } | null>;
    add: (data: Record<string, unknown>) => Promise<any>;
    update: (id: string, data: Record<string, unknown>) => Promise<any>;
    check: (id: string, status: string, notes?: string) => Promise<void>;
  }): void {
    this.goalsListFn = opts.list;
    this.goalsGetFn = opts.get;
    this.goalsAddFn = opts.add;
    this.goalsUpdateFn = opts.update;
    this.goalsCheckFn = opts.check;
  }

  // v698 — Sandbox-Proxy: aus alfred.ts gerufen, validiert sandboxId + Token gegen DB
  setSandboxProxyResolver(
    resolve: (sandboxId: string, token: string | null) => Promise<
      | { ok: true; hostPort: number; userId: string }
      | { ok: false; status: number; message: string }
    >,
  ): void {
    this.sandboxProxyResolve = resolve;
  }

  // v699 — Sandbox-CRUD-Callbacks (alle laufen mit checkAuth)
  // v703 — erweitert: chatList + chatSendMessage + listAll + sessionId optional
  setSandboxCallbacks(cb: {
    status: () => Promise<Record<string, unknown>>;
    list: (filter: { projectId?: string; sessionId?: string; userId?: string }) => Promise<unknown[]>;
    listAll: (userId: string) => Promise<unknown[]>;
    getById: (sandboxId: string) => Promise<unknown | null>;
    create: (input: { projectId: string; sessionId?: string | null; mode: string; slug?: string; requestUserId?: string }) => Promise<unknown>;
    pause: (sandboxId: string) => Promise<void>;
    resume: (sandboxId: string) => Promise<void>;
    discard: (sandboxId: string) => Promise<void>;
    merge: (sandboxId: string, opts: { strategy?: string; commitMessage?: string; prTitle?: string; prBody?: string }) => Promise<{ ok: boolean; prUrl?: string; reason?: string }>;
    diff: (sandboxId: string) => Promise<string>;
    chatList: (sandboxId: string) => Promise<unknown[]>;
    chatSendMessage: (sandboxId: string, message: string) => Promise<{ ok: boolean; userMessageId?: string; taskId?: string; reason?: string }>;
  }): void {
    this.sandboxCallbacks = cb;
  }

  setInsightsCallbacks(opts: {
    list: (filter?: { category?: string; status?: string; limit?: number }) => Promise<any[]>;
    dismiss: (id: string) => Promise<void>;
    snooze: (id: string, hours: number) => Promise<void>;
    act: (id: string) => Promise<{ ok: boolean; result?: any; reason?: string }>;
    sweep: () => Promise<{ inserted: number; refreshed: number; perAdapter: Record<string, number>; errors: string[] }>;
    stats: () => Promise<Record<string, number>>;
    dismissCategory?: (category: string) => Promise<number>;
  }): void {
    this.insightsListFn = opts.list;
    this.insightsDismissFn = opts.dismiss;
    this.insightsSnoozeFn = opts.snooze;
    this.insightsActFn = opts.act;
    this.insightsSweepFn = opts.sweep;
    this.insightsStatsFn = opts.stats;
    this.insightsDismissCategoryFn = opts.dismissCategory;
  }

  private projectsCallbacks?: {
    list: (filter?: { status?: string }) => Promise<any[]>;
    get: (id: string) => Promise<{ project: any; sessions: any[]; openItems: any[]; decisions: any[]; health: Record<string, any> } | null>;
    /** v658 — Work-Stats Aggregation pro Projekt */
    workStats?: (id: string) => Promise<{
      total: { count: number; totalSeconds: number; runningCount: number };
      byType: Array<{ sessionType: string; count: number; totalSeconds: number; completedCount: number }>;
      byAgent: Array<{ agent: string; count: number; totalSeconds: number }>;
    } | null>;
    /** v658 — Chat-History für Projekt-Conversation */
    chatHistory?: (id: string, limit: number) => Promise<{ conversationId: string; messages: Array<{ id: string; role: string; content: string; createdAt: string }> } | null>;
    /** v659 — Letzte Deploys aus Memory parsed + auto-detected runtime aus cwd */
    lastDeploys?: (id: string) => Promise<{
      deploys: Array<{ host: string; user: string; runtime?: string; processManager?: string; composeVariant?: string; port?: number; verified?: boolean; date?: string }>;
      detectedRuntime?: string;
      detectionReason?: string;
    }>;
    /** v659 — Deploy-Trigger mit Form-Params (process_manager, host, user, port, runtime, branch) */
    triggerDeploy?: (id: string, input: Record<string, unknown>) => Promise<{ success: boolean; data?: unknown; error?: string; display?: string }>;
    /** v663a — Roadmap-Items eines Projekts (grouped by milestone) */
    listRoadmap?: (id: string) => Promise<Record<string, any[]>>;
    /** v663a — Roadmap-Felder eines Open-Items setzen (milestone/order/estimated) */
    updateOpenItemRoadmap?: (itemId: string, patch: { milestone?: string | null; order?: number | null; estimatedHours?: number | null }) => Promise<boolean>;
    /** v663a — Alle open Items eines Milestones zu einem Project-Agent-Goal aggregieren und starten */
    implementMilestone?: (id: string, milestone: string) => Promise<{ ok: boolean; taskId?: string; itemCount?: number; error?: string }>;
    /** v663b — Automations CRUD + Templates-Liste + Run-Now */
    listAutomations?: (projectId: string) => Promise<any[]>;
    listAutomationTemplates?: () => Promise<any[]>;
    addAutomation?: (projectId: string, input: Record<string, unknown>) => Promise<any | null>;
    updateAutomation?: (id: string, patch: Record<string, unknown>) => Promise<boolean>;
    deleteAutomation?: (id: string) => Promise<boolean>;
    runAutomationNow?: (id: string) => Promise<{ ok: boolean; output?: string; error?: string }>;
    /** v665b — Cluster-Move: Shares listen + Move preflight + execute */
    listClusterShares?: () => Promise<Array<{ id: string; name?: string; mountPath: string; type: string; readOnly: boolean; available: boolean; writable: boolean; reason?: string }>>;
    moveProjectPreflight?: (projectId: string, target: { storageType: string; shareId?: string; nodeId?: string }) => Promise<any>;
    moveProject?: (projectId: string, target: { storageType: string; shareId?: string; nodeId?: string }, opts: { excludes?: string[]; keepSource?: boolean }) => Promise<{ ok: boolean; sourceCwd?: string; targetCwd?: string; durationMs?: number; error?: string }>;
    create: (input: Record<string, unknown>) => Promise<any>;
    update: (id: string, patch: Record<string, unknown>) => Promise<any | null>;
    archive: (id: string) => Promise<boolean>;
    addOpenItem: (projectId: string, input: Record<string, unknown>) => Promise<any | null>;
    /** v704 — Erweitert: status + title + description. Status-only bleibt rückwärtskompatibel. */
    updateOpenItem: (itemId: string, patch: { status?: string; title?: string; description?: string | null }) => Promise<boolean>;
    listHealthLog: (id: string, limit: number) => Promise<any[]>;
    // v641 — Bulk-Work + Audit
    workOnOpenItems?: (projectId: string, itemIds: string[], maxItems: number) => Promise<{ ok: boolean; taskId?: string; reason?: string }>;
    auditOpenItems?: (projectId: string) => Promise<{ data?: any; display?: string }>;
    // v642 — Bulk-Close
    bulkCloseItems?: (projectId: string, itemIds: string[]) => Promise<{ closed: number; failed: string[] }>;
    // v643 — Commits per Project + per Session
    listProjectCommits?: (projectId: string, limit: number) => Promise<any[]>;
    listSessionCommits?: (sessionId: string) => Promise<any[]>;
  };

  setProjectsCallbacks(cbs: typeof HttpAdapter.prototype.projectsCallbacks): void {
    this.projectsCallbacks = cbs;
  }

  setCmdbCallbacks(cbs: CmdbCallbacks): void { this.cmdbCallbacks = cbs; }
  setItsmCallbacks(cbs: ItsmCallbacks): void { this.itsmCallbacks = cbs; }
  setDocsCallbacks(cbs: DocsCallbacks): void { this.docsCallbacks = cbs; }

  // ── Log Viewer + Cluster Operations ────────────────────────
  private logCallbacks?: {
    // v681 — since (Unix-ms cutoff) + offset (skip N newest, dann lines davor)
    readAppLog: (lines: number, level?: string, filter?: string, fileIndex?: number, since?: number, offsetFromTail?: number) => Promise<{ lines: Array<Record<string, unknown>>; total: number; file: string; files?: Array<{ name: string; size: number; modified: string }> }>;
    readAuditLog: (lines: number, level?: string, filter?: string, fileIndex?: number) => Promise<{ lines: Array<Record<string, unknown>>; total: number; file: string; files?: Array<{ name: string; size: number; modified: string }> }>;
    streamAppLog: (res: http.ServerResponse, level?: string, filter?: string) => () => void;
  };
  private clusterCallbacks?: {
    getHealth: () => Promise<Record<string, unknown>>;
  };

  setLogCallbacks(cbs: typeof HttpAdapter.prototype.logCallbacks): void { this.logCallbacks = cbs; }
  setClusterCallbacks(cbs: typeof HttpAdapter.prototype.clusterCallbacks): void { this.clusterCallbacks = cbs; }

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

    // v698 — WebSocket-Upgrade-Handler für Sandbox-Preview (HMR via WebSocket)
    this.server.on('upgrade', (req, socket, head) => {
      try {
        const u = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        const m = u.pathname.match(/^\/preview\/([a-zA-Z0-9-]{8,})(\/.*)?$/);
        if (m) {
          this.handleSandboxProxyUpgrade(req, socket, head, u, m[1], m[2] ?? '/').catch(err => {
            try { socket.write(`HTTP/1.1 500 Internal Server Error\r\n\r\nUpgrade failed: ${(err as Error).message}\n`); socket.destroy(); } catch { /* */ }
          });
          return;
        }
        // v715 — Referer-basiertes Routing für HMR-WebSocket (Next.js verwendet absolute
        // Pfade wie /_next/webpack-hmr ohne /preview/-Prefix)
        const referer = req.headers.referer ?? req.headers.origin ?? '';
        const refererMatch = referer.match(/\/preview\/([a-zA-Z0-9-]{8,})\//);
        if (refererMatch && !u.pathname.startsWith('/api') && !u.pathname.startsWith('/alfred')) {
          this.handleSandboxProxyUpgrade(req, socket, head, u, refererMatch[1], u.pathname).catch(err => {
            try { socket.write(`HTTP/1.1 500 Internal Server Error\r\n\r\nUpgrade failed: ${(err as Error).message}\n`); socket.destroy(); } catch { /* */ }
          });
          return;
        }
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
      } catch {
        try { socket.destroy(); } catch { /* */ }
      }
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

    // v698 — Sandbox-Preview-Proxy: matched ALLES unter /preview/<sandboxId>/...
    // (HTTP-Methoden + Pfade transparent zum Upstream-Dev-Server)
    const previewMatch = url.pathname.match(/^\/preview\/([a-zA-Z0-9-]{8,})(\/.*)?$/);
    if (previewMatch) {
      this.handleSandboxProxyHttp(req, res, url, previewMatch[1], previewMatch[2] ?? '/').catch(err => {
        try { if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end(`Preview proxy error: ${(err as Error).message}`); } catch { /* */ }
      });
      return;
    }

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
    // ── Memories API (corrections viewer) ──
    } else if (url.pathname === '/api/memories' && req.method === 'GET') {
      this.handleMemoriesList(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.startsWith('/api/memories/') && req.method === 'DELETE') {
      this.handleMemoriesDelete(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.startsWith('/api/memories/') && req.method === 'PATCH') {
      this.handleMemoriesUpdateType(req, res, url).catch(err => this.safeError(res, err));
    // ── Runbooks API (browse drafts + manage) ──
    } else if (url.pathname === '/api/runbooks' && req.method === 'GET') {
      this.handleRunbooksList(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.startsWith('/api/runbooks/') && req.method === 'GET') {
      this.handleRunbooksGet(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.startsWith('/api/runbooks/') && req.method === 'PATCH') {
      this.handleRunbooksUpdate(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.startsWith('/api/runbooks/') && req.method === 'DELETE') {
      this.handleRunbooksDelete(req, res, url).catch(err => this.safeError(res, err));
    // ── Project-Agent-Sessions API (v609) ──
    } else if (url.pathname === '/api/project-agents' && req.method === 'GET') {
      this.handleProjectAgentsList(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/project-agents\/[^/]+$/) && req.method === 'GET') {
      this.handleProjectAgentsGet(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/project-agents\/[^/]+\/stop$/) && req.method === 'POST') {
      this.handleProjectAgentsStop(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/project-agents\/[^/]+\/resume$/) && req.method === 'POST') {
      this.handleProjectAgentsResume(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/project-agents\/[^/]+\/plan$/) && req.method === 'GET') {
      this.handleProjectAgentsPlan(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/project-agents\/[^/]+\/output$/) && req.method === 'GET') {
      this.handleProjectAgentsOutputStream(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/project-agents\/[^/]+\/interject$/) && req.method === 'POST') {
      this.handleProjectAgentsInterject(req, res, url).catch(err => this.safeError(res, err));
    // ── Background-Tasks API (v623) ──
    } else if (url.pathname === '/api/background-tasks' && req.method === 'GET') {
      this.handleBackgroundTasksList(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/background-tasks\/[^/]+$/) && req.method === 'GET') {
      this.handleBackgroundTasksGet(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/background-tasks\/[^/]+\/cancel$/) && req.method === 'POST') {
      this.handleBackgroundTasksCancel(req, res, url).catch(err => this.safeError(res, err));
    // ── Conversation-History API (v627) ──
    } else if (url.pathname === '/api/conversations' && req.method === 'GET') {
      this.handleConversationsList(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname === '/api/conversations/search' && req.method === 'GET') {
      this.handleConversationsSearch(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/conversations\/[^/]+\/messages$/) && req.method === 'GET') {
      this.handleConversationsMessages(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/conversations\/[^/]+\/summary$/) && req.method === 'GET') {
      this.handleConversationsSummary(req, res, url).catch(err => this.safeError(res, err));
    // ── Conversation Lifecycle (v644) ──
    } else if (url.pathname.match(/^\/api\/conversations\/[^/]+$/) && req.method === 'PATCH') {
      this.handleConversationsPatch(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/conversations\/[^/]+$/) && req.method === 'DELETE') {
      this.handleConversationsDelete(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/conversations\/[^/]+\/branch$/) && req.method === 'POST') {
      this.handleConversationsBranch(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname === '/api/conversations/export' && req.method === 'POST') {
      this.handleConversationsExport(req, res).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/conversations\/[^/]+\/replay$/) && req.method === 'POST') {
      this.handleConversationsReplay(req, res, url).catch(err => this.safeError(res, err));
    // ── Chat multi-modal (v644) ──
    } else if (url.pathname === '/api/transcribe' && req.method === 'POST') {
      this.handleTranscribe(req, res).catch(err => this.safeError(res, err));
    // ── Confirmations + Reminders Side-Panel (v629) ──
    } else if (url.pathname === '/api/confirmations/pending' && req.method === 'GET') {
      this.handleConfirmationsList(req, res).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/confirmations\/[^/]+\/approve$/) && req.method === 'POST') {
      this.handleConfirmationDecide(req, res, url, 'approve').catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/confirmations\/[^/]+\/reject$/) && req.method === 'POST') {
      this.handleConfirmationDecide(req, res, url, 'reject').catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/confirmations\/[^/]+\/[a-z0-9_-]+$/i) && req.method === 'POST') {
      // v657 — custom extraAction key (z.B. cancel_item, snooze_24h)
      const parts = url.pathname.split('/');
      const customKey = parts[parts.length - 1];
      this.handleConfirmationDecide(req, res, url, customKey).catch(err => this.safeError(res, err));
    } else if (url.pathname === '/api/reminders' && req.method === 'GET') {
      this.handleRemindersList(req, res).catch(err => this.safeError(res, err));
    // ── Todos + Notes API (v661) ──
    } else if (url.pathname === '/api/todos' && req.method === 'GET') {
      this.handleTodosList(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname === '/api/todos' && req.method === 'POST') {
      this.handleTodosAdd(req, res).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/todos\/[^/]+$/) && req.method === 'PATCH') {
      this.handleTodosUpdate(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/todos\/[^/]+\/complete$/) && req.method === 'POST') {
      this.handleTodosComplete(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/todos\/[^/]+$/) && req.method === 'DELETE') {
      this.handleTodosDelete(req, res, url).catch(err => this.safeError(res, err));
    // v670 — Todo-Notes (Arbeitsnotizen / Fortschritte)
    } else if (url.pathname.match(/^\/api\/todos\/[^/]+\/notes$/) && req.method === 'GET') {
      this.handleTodoNotesList(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/todos\/[^/]+\/notes$/) && req.method === 'POST') {
      this.handleTodoNotesAdd(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/todos\/notes\/[^/]+$/) && req.method === 'DELETE') {
      this.handleTodoNotesDelete(req, res, url).catch(err => this.safeError(res, err));
    // v672 — Todo ↔ Note Cross-Link (M:N)
    } else if (url.pathname.match(/^\/api\/todos\/[^/]+\/linked-notes$/) && req.method === 'GET') {
      this.handleTodoLinkedNotes(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/todos\/[^/]+\/note-links\/[^/]+$/) && req.method === 'POST') {
      this.handleTodoNoteLinkAdd(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/todos\/[^/]+\/note-links\/[^/]+$/) && req.method === 'DELETE') {
      this.handleTodoNoteLinkRemove(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/notes\/[^/]+\/linked-todos$/) && req.method === 'GET') {
      this.handleNoteLinkedTodos(req, res, url).catch(err => this.safeError(res, err));
    // v673 — Attachments (Documents, Files, URLs, Uploads)
    } else if (url.pathname === '/api/documents' && req.method === 'GET') {
      this.handleDocumentsList(req, res).catch(err => this.safeError(res, err));
    } else if (url.pathname === '/api/files' && req.method === 'GET') {
      this.handleStoredFilesList(req, res).catch(err => this.safeError(res, err));
    } else if (url.pathname === '/api/files/download' && req.method === 'GET') {
      this.handleFileDownload(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname === '/api/uploads' && req.method === 'POST') {
      this.handleBase64Upload(req, res).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/(todos|notes)\/[^/]+\/attachments$/) && req.method === 'GET') {
      this.handleAttachmentsList(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/(todos|notes)\/[^/]+\/attachments$/) && req.method === 'POST') {
      this.handleAttachmentsAdd(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/attachments\/[^/]+$/) && req.method === 'DELETE') {
      this.handleAttachmentDelete(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname === '/api/notes' && req.method === 'GET') {
      this.handleNotesList(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname === '/api/notes' && req.method === 'POST') {
      this.handleNotesAdd(req, res).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/notes\/[^/]+$/) && req.method === 'PATCH') {
      this.handleNotesUpdate(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/notes\/[^/]+$/) && req.method === 'DELETE') {
      this.handleNotesDelete(req, res, url).catch(err => this.safeError(res, err));
    // ── Insights API (v638) ──
    } else if (url.pathname === '/api/insights' && req.method === 'GET') {
      this.handleInsightsList(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname === '/api/insights/stats' && req.method === 'GET') {
      this.handleInsightsStats(req, res).catch(err => this.safeError(res, err));
    } else if (url.pathname === '/api/insights/sweep' && req.method === 'POST') {
      this.handleInsightsSweep(req, res).catch(err => this.safeError(res, err));
    } else if (url.pathname === '/api/insights/dismiss-category' && req.method === 'POST') {
      this.handleInsightsDismissCategory(req, res, url).catch(err => this.safeError(res, err));
    // v699 — Sandbox-CRUD-API
    } else if (url.pathname === '/api/sandbox/status' && req.method === 'GET') {
      this.handleSandboxStatus(req, res).catch(err => this.safeError(res, err));
    } else if (url.pathname === '/api/sandbox/list' && req.method === 'GET') {
      this.handleSandboxList(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname === '/api/sandbox/create' && req.method === 'POST') {
      this.handleSandboxCreate(req, res).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/sandbox\/[^/]+\/pause$/) && req.method === 'POST') {
      this.handleSandboxAction(req, res, url, 'pause').catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/sandbox\/[^/]+\/resume$/) && req.method === 'POST') {
      this.handleSandboxAction(req, res, url, 'resume').catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/sandbox\/[^/]+\/discard$/) && req.method === 'POST') {
      this.handleSandboxAction(req, res, url, 'discard').catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/sandbox\/[^/]+\/merge$/) && req.method === 'POST') {
      this.handleSandboxMerge(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/sandbox\/[^/]+\/diff$/) && req.method === 'GET') {
      this.handleSandboxDiff(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/sandbox\/[^/]+\/chat$/) && req.method === 'GET') {
      this.handleSandboxChatList(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/sandbox\/[^/]+\/chat$/) && req.method === 'POST') {
      this.handleSandboxChatSend(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname === '/api/sandbox/list-all' && req.method === 'GET') {
      this.handleSandboxListAll(req, res).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/sandbox\/[^/]+$/) && req.method === 'GET') {
      this.handleSandboxGet(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/insights\/[^/]+\/dismiss$/) && req.method === 'POST') {
      this.handleInsightsDismiss(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/insights\/[^/]+\/snooze$/) && req.method === 'POST') {
      this.handleInsightsSnooze(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/insights\/[^/]+\/act$/) && req.method === 'POST') {
      this.handleInsightsAct(req, res, url).catch(err => this.safeError(res, err));
    // ── Goals API (v639) ──
    } else if (url.pathname === '/api/goals' && req.method === 'GET') {
      this.handleGoalsList(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname === '/api/goals' && req.method === 'POST') {
      this.handleGoalsAdd(req, res).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/goals\/[^/]+$/) && req.method === 'GET') {
      this.handleGoalsGet(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/goals\/[^/]+$/) && req.method === 'PATCH') {
      this.handleGoalsUpdate(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/goals\/[^/]+\/check$/) && req.method === 'POST') {
      this.handleGoalsCheck(req, res, url).catch(err => this.safeError(res, err));
    // ── Projects API ──
    } else if (url.pathname === '/api/projects' && req.method === 'GET') {
      this.handleProjectsList(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname === '/api/projects' && req.method === 'POST') {
      this.handleProjectsCreate(req, res).catch(err => this.safeError(res, err));
    // v675 — Spezifische Routes MÜSSEN vor der generic /api/projects/:id Route stehen,
    // sonst matched die generic Route und interpretiert z.B. "automation-templates" als Projekt-ID.
    } else if (url.pathname === '/api/projects/automation-templates' && req.method === 'GET') {
      this.handleAutomationTemplates(req, res).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+$/) && req.method === 'GET') {
      this.handleProjectsGet(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+$/) && req.method === 'PATCH') {
      this.handleProjectsUpdate(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+$/) && req.method === 'DELETE') {
      this.handleProjectsArchive(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/open-items$/) && req.method === 'POST') {
      this.handleProjectsAddOpenItem(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/open-items\/[^/]+$/) && req.method === 'PATCH') {
      this.handleProjectsUpdateOpenItem(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/health-log$/) && req.method === 'GET') {
      this.handleProjectsHealthLog(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/work-on-items$/) && req.method === 'POST') {
      this.handleProjectsWorkOnItems(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/audit-items$/) && req.method === 'POST') {
      this.handleProjectsAuditItems(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/bulk-close-items$/) && req.method === 'POST') {
      this.handleProjectsBulkCloseItems(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/commits$/) && req.method === 'GET') {
      this.handleProjectsCommits(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/sessions\/[^/]+\/commits$/) && req.method === 'GET') {
      this.handleProjectsSessionCommits(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/work-stats$/) && req.method === 'GET') {
      this.handleProjectsWorkStats(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/chat-history$/) && req.method === 'GET') {
      this.handleProjectsChatHistory(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/last-deploys$/) && req.method === 'GET') {
      this.handleProjectsLastDeploys(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/deploy$/) && req.method === 'POST') {
      this.handleProjectsDeploy(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/roadmap$/) && req.method === 'GET') {
      this.handleProjectsRoadmap(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/open-items\/[^/]+\/roadmap$/) && req.method === 'PATCH') {
      this.handleProjectsUpdateOpenItemRoadmap(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/implement-milestone$/) && req.method === 'POST') {
      this.handleProjectsImplementMilestone(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/automations$/) && req.method === 'GET') {
      this.handleAutomationsList(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/automations$/) && req.method === 'POST') {
      this.handleAutomationsAdd(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/automations\/[^/]+$/) && req.method === 'PATCH') {
      this.handleAutomationsUpdate(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/automations\/[^/]+$/) && req.method === 'DELETE') {
      this.handleAutomationsDelete(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/automations\/[^/]+\/run$/) && req.method === 'POST') {
      this.handleAutomationsRun(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname === '/api/cluster/shares' && req.method === 'GET') {
      this.handleClusterShares(req, res).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/move\/preflight$/) && req.method === 'POST') {
      this.handleProjectMovePreflight(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/move$/) && req.method === 'POST') {
      this.handleProjectMove(req, res, url).catch(err => this.safeError(res, err));
    // ── Log Viewer API ──
    } else if (url.pathname === '/api/logs/app' && req.method === 'GET') {
      this.handleLogApp(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname === '/api/logs/app/stream' && req.method === 'GET') {
      this.handleLogStream(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname === '/api/logs/audit' && req.method === 'GET') {
      this.handleLogAudit(req, res, url).catch(err => this.safeError(res, err));
    // ── Cluster / HA Operations API ──
    } else if (url.pathname === '/api/cluster/health' && req.method === 'GET') {
      this.handleClusterHealth(req, res).catch(err => this.safeError(res, err));
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
    // ── Services API ──
    } else if (url.pathname.match(/^\/api\/services\/[^/]+\/failure-modes\/[^/]+$/) && req.method === 'DELETE') {
      const parts = url.pathname.split('/');
      const svcId = parts[3];
      const fmName = decodeURIComponent(parts[5]);
      this.handleItsmRoute(req, res, async (cbs, userId) => {
        const svc = await cbs.getService(userId, svcId);
        if (!svc) return { error: 'Service not found' };
        svc.failureModes = (svc.failureModes || []).filter((fm: any) => fm.name !== fmName);
        return cbs.updateService(userId, svcId, { failure_modes: svc.failureModes });
      });
    } else if (url.pathname.match(/^\/api\/services\/[^/]+\/failure-modes$/) && req.method === 'POST') {
      const svcId = url.pathname.split('/')[3];
      this.handleItsmBodyRoute(req, res, async (cbs, userId, body) => {
        const svc = await cbs.getService(userId, svcId);
        if (!svc) return { error: 'Service not found' };
        const modes = svc.failureModes || [];
        modes.push(body);
        return cbs.updateService(userId, svcId, { failure_modes: modes });
      });
    } else if (url.pathname.match(/^\/api\/services\/[^/]+\/impact$/) && req.method === 'GET') {
      const svcId = url.pathname.split('/')[3];
      this.handleItsmRoute(req, res, async (cbs, userId) => {
        const svc = await cbs.getService(userId, svcId);
        if (!svc) return { error: 'Service not found' };
        const dependents = svc.dependencyMap?.downstream || [];
        return { service: svc.name, impact: dependents, failureModes: svc.failureModes || [] };
      });
    } else if (url.pathname.match(/^\/api\/services\/[^/]+\/generate-docs$/) && req.method === 'POST') {
      const svcId = url.pathname.split('/')[3];
      this.handleItsmRoute(req, res, (cbs, userId) => cbs.generateDocs(userId, svcId));
    } else if (url.pathname === '/api/services' && req.method === 'GET') {
      this.handleItsmRoute(req, res, (cbs, userId) => {
        const filters = Object.fromEntries(url.searchParams.entries());
        return cbs.listServices(userId, filters);
      });
    } else if (url.pathname === '/api/services' && req.method === 'POST') {
      this.handleItsmBodyRoute(req, res, (cbs, userId, body) => cbs.createService(userId, body));
    } else if (url.pathname.match(/^\/api\/services\/[^/]+$/) && req.method === 'GET') {
      const id = url.pathname.split('/').pop()!;
      this.handleItsmRoute(req, res, (cbs, userId) => cbs.getService(userId, id));
    } else if (url.pathname.match(/^\/api\/services\/[^/]+$/) && req.method === 'PATCH') {
      const id = url.pathname.split('/').pop()!;
      this.handleItsmBodyRoute(req, res, (cbs, userId, body) => cbs.updateService(userId, id, body));
    } else if (url.pathname.match(/^\/api\/services\/[^/]+$/) && req.method === 'DELETE') {
      const id = url.pathname.split('/').pop()!;
      this.handleItsmRoute(req, res, (cbs, userId) => cbs.deleteService(userId, id));
    } else if (url.pathname === '/api/sla/compliance' && req.method === 'GET') {
      this.handleItsmRoute(req, res, (cbs, userId) => cbs.checkSlaCompliance(userId));
    } else if (url.pathname === '/api/sla/breaches' && req.method === 'GET') {
      this.handleItsmRoute(req, res, (cbs, userId) => cbs.getSlaBreaches(userId, url.searchParams.get('period') ?? undefined));
    } else if (url.pathname.match(/^\/api\/sla\/report\/(service|asset)\/[^/]+$/) && req.method === 'GET') {
      const parts = url.pathname.split('/');
      const targetType = parts[4];
      const targetId = parts[5];
      this.handleItsmRoute(req, res, (cbs, userId) => cbs.getSlaReport(userId, targetType, targetId, url.searchParams.get('period') ?? undefined));
    } else if (url.pathname === '/api/sla/set' && req.method === 'POST') {
      this.handleItsmBodyRoute(req, res, (cbs, userId, body) => cbs.setSla(userId, body.targetType as string, body.targetId as string, body.sla as Record<string, unknown>));
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
    // v632 — Bulk-Merge + Promote + Backfill
    } else if (url.pathname.match(/^\/api\/itsm\/problems\/[^/]+\/bulk-link$/) && req.method === 'POST') {
      const id = url.pathname.split('/api/itsm/problems/')[1].split('/bulk-link')[0];
      this.handleItsmBodyRoute(req, res, (cbs, userId, body) => cbs.bulkLinkToProblem(userId, id, (body.incident_ids as string[]) ?? []));
    } else if (url.pathname === '/api/itsm/problems/promote' && req.method === 'POST') {
      this.handleItsmBodyRoute(req, res, (cbs, userId, body) => cbs.promoteIncidentsToProblem(userId, {
        title: body.title as string,
        priority: body.priority as string | undefined,
        incidentIds: (body.incident_ids as string[]) ?? [],
      }));
    } else if (url.pathname === '/api/itsm/incidents/backfill-assets' && req.method === 'POST') {
      this.handleItsmRoute(req, res, (cbs, userId) => cbs.backfillAssets(userId));
    // v645 — Generic Bulk-Actions
    } else if (url.pathname === '/api/itsm/incidents/bulk' && req.method === 'POST') {
      this.handleItsmBodyRoute(req, res, (cbs, userId, body) => cbs.bulkIncidents(userId, body as any));
    } else if (url.pathname === '/api/itsm/changes/bulk' && req.method === 'POST') {
      this.handleItsmBodyRoute(req, res, (cbs, userId, body) => cbs.bulkChanges(userId, body as any));
    } else if (url.pathname === '/api/itsm/problems/bulk' && req.method === 'POST') {
      this.handleItsmBodyRoute(req, res, (cbs, userId, body) => cbs.bulkProblems(userId, body as any));
    } else if (url.pathname === '/api/itsm/services/bulk' && req.method === 'POST') {
      this.handleItsmBodyRoute(req, res, (cbs, userId, body) => cbs.bulkServices(userId, body as any));
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
    // ── Extended Docs API ──
    } else if (url.pathname === '/api/docs/list' && req.method === 'GET') {
      this.handleCmdbRoute(req, res, (cbs, userId) => {
        const filters = Object.fromEntries(url.searchParams.entries());
        return cbs.listDocuments(userId, filters);
      });
    } else if (url.pathname === '/api/docs/tree' && req.method === 'GET') {
      this.handleCmdbRoute(req, res, (cbs, userId) => cbs.getDocumentTree(userId));
    } else if (url.pathname === '/api/docs/search' && req.method === 'GET') {
      this.handleCmdbRoute(req, res, (cbs, userId) => {
        const query = url.searchParams.get('q') ?? '';
        const filters = Object.fromEntries(url.searchParams.entries());
        delete filters.q;
        return cbs.searchDocuments(userId, query, filters);
      });
    } else if (url.pathname === '/api/docs' && req.method === 'POST') {
      this.handleCmdbBodyRoute(req, res, (cbs, userId, body) => cbs.saveDocument(userId, body));
    } else if (url.pathname.match(/^\/api\/docs\/[^/]+\/versions$/) && req.method === 'GET') {
      const parts = url.pathname.split('/');
      const id = parts[3];
      this.handleCmdbRoute(req, res, async (cbs, userId) => {
        const doc = await cbs.getDocument(userId, id);
        if (!doc) return { error: 'Document not found' };
        return cbs.getDocumentVersions(userId, doc.linkedEntityType ?? '', doc.linkedEntityId ?? '', doc.docType);
      });
    } else if (url.pathname.startsWith('/api/docs/') && req.method === 'GET') {
      const id = url.pathname.split('/').pop()!;
      this.handleCmdbRoute(req, res, (cbs, userId) => cbs.getDocument(userId, id));
    } else if (url.pathname.startsWith('/api/docs/') && req.method === 'PATCH') {
      const id = url.pathname.split('/').pop()!;
      this.handleCmdbBodyRoute(req, res, (cbs, userId, body) => cbs.updateDocument(userId, id, body));
    } else if (url.pathname.startsWith('/api/docs/') && req.method === 'DELETE') {
      const id = url.pathname.split('/').pop()!;
      this.handleCmdbRoute(req, res, (cbs, userId) => cbs.deleteDocument(userId, id));
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
      // v716 — Referer-basiertes Sandbox-Routing als LETZTER Fallback vor 404.
      // Wenn keine Alfred-Route matched aber Referer auf /preview/<sid>/ zeigt:
      // → der Browser hat eine absolute URL aus dem iframe-Content angefragt
      //   (z.B. /_next/static/foo.css, /api/likes für Sandbox-App, etc.)
      // → transparent zur richtigen Sandbox routen.
      // Damit fallen ALLE nicht-Alfred-spezifischen Pfade durch zur Sandbox.
      const referer = req.headers.referer ?? '';
      const refererMatch = referer.match(/\/preview\/([a-zA-Z0-9-]{8,})\//);
      if (refererMatch) {
        this.handleSandboxProxyHttp(req, res, url, refererMatch[1], url.pathname).catch(err => {
          try { if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end(`Preview proxy error: ${(err as Error).message}`); } } catch { /* */ }
        });
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  }

  private async checkAuth(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    if (!this.apiToken && !this.authCb) return true;
    const authHeader = req.headers['authorization'];
    let token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

    // v651 — EventSource kann keinen Authorization-Header setzen, daher Token via
    // ?token=… aus der Query als Fallback akzeptieren. Nur für GET (SSE).
    if (!token && req.method === 'GET' && req.url) {
      try {
        const u = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
        const qsToken = u.searchParams.get('token');
        if (qsToken) token = qsToken;
      } catch { /* ignore */ }
    }

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
      // v622 — Range-Param aus Query-String extrahieren und an Callback weiterreichen.
      // v656 — Zusätzlich granularity=hour + date=YYYY-MM-DD für stundenweise Darstellung.
      const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
      const rangeParam = url.searchParams.get('range') ?? undefined;
      const allowed = ['today', 'week', 'month', 'year', 'all'];
      const range = rangeParam && allowed.includes(rangeParam) ? rangeParam : undefined;
      const granularityParam = url.searchParams.get('granularity') ?? undefined;
      const granularity = granularityParam === 'hour' ? 'hour' : undefined;
      const dateParam = url.searchParams.get('date') ?? undefined;
      const date = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : undefined;
      const opts: Record<string, string> = {};
      if (range) opts.range = range;
      if (granularity) opts.granularity = granularity;
      if (date) opts.date = date;
      const data = await this.dashboardFn(Object.keys(opts).length ? opts : undefined) as Record<string, unknown>;

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

  private async handleMemoriesList(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.memoriesListFn) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const type = url.searchParams.get('type') ?? undefined;
    const list = await this.memoriesListFn(type ? { type } : undefined);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ memories: list }));
  }

  private async handleMemoriesDelete(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.memoriesDeleteFn) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const memoryId = url.pathname.split('/').pop()!;
    const ok = await this.memoriesDeleteFn(memoryId);
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: ok }));
  }

  private async handleMemoriesUpdateType(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.memoriesUpdateTypeFn) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const memoryId = url.pathname.split('/').pop()!;
    const body = await this.readBody(req);
    let parsed: { type?: string };
    try { parsed = JSON.parse(body); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }
    if (!parsed.type || typeof parsed.type !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'type required' })); return;
    }
    const allowedTypes = new Set(['correction', 'preference', 'fact', 'entity', 'general', 'pattern']);
    if (!allowedTypes.has(parsed.type)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `invalid type, allowed: ${[...allowedTypes].join(', ')}` }));
      return;
    }
    const ok = await this.memoriesUpdateTypeFn(memoryId, parsed.type);
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: ok }));
  }

  // ── Runbooks API handlers ──
  private async handleRunbooksList(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.runbooksListFn) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const status = url.searchParams.get('status') ?? undefined;
    const sourceType = url.searchParams.get('source_type') ?? undefined;
    const list = await this.runbooksListFn({ status, sourceType });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ runbooks: list }));
  }

  private async handleRunbooksGet(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.runbooksGetFn) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const id = url.pathname.split('/').pop()!;
    const rb = await this.runbooksGetFn(id);
    if (!rb) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ runbook: rb }));
  }

  private async handleRunbooksUpdate(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.runbooksUpdateFn) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const id = url.pathname.split('/').pop()!;
    const body = await this.readBody(req);
    let patch: Record<string, unknown>;
    try { patch = JSON.parse(body); }
    catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }
    const updated = await this.runbooksUpdateFn(id, patch);
    if (!updated) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ runbook: updated }));
  }

  private async handleRunbooksDelete(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.runbooksDeleteFn) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const id = url.pathname.split('/').pop()!;
    const ok = await this.runbooksDeleteFn(id);
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: ok }));
  }

  // ── Project-Agent-Sessions API handlers (v609) ──
  private async handleProjectAgentsList(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectAgentsListFn) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const phase = url.searchParams.get('phase') ?? undefined;
    const list = await this.projectAgentsListFn({ phase });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sessions: list }));
  }

  private async handleProjectAgentsGet(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectAgentsGetFn) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const taskId = url.pathname.split('/').pop()!;
    const session = await this.projectAgentsGetFn(taskId);
    if (!session) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ session }));
  }

  private async handleProjectAgentsStop(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectAgentsStopFn) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const segments = url.pathname.split('/');
    const taskId = segments[segments.length - 2]; // .../{taskId}/stop
    const ok = await this.projectAgentsStopFn(taskId);
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: ok }));
  }

  // v649 — Resume + Plan
  private async handleProjectAgentsResume(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectAgentsResumeFn) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Resume not configured' })); return;
    }
    const segments = url.pathname.split('/');
    const taskId = segments[segments.length - 2];
    const body = await this.readBody(req);
    let notes: string | undefined;
    try { notes = JSON.parse(body).notes; } catch { /* skip */ }
    const result = await this.projectAgentsResumeFn(taskId, notes);
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  private async handleProjectAgentsPlan(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectAgentsPlanFn) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const segments = url.pathname.split('/');
    const taskId = segments[segments.length - 2];
    const phases = await this.projectAgentsPlanFn(taskId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ phases }));
  }

  // v651 — SSE-Stream der laufenden Project-Agent-Session Output-Buffer-Zeilen
  private async handleProjectAgentsOutputStream(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectAgentsSubscribeOutputFn) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Output stream not configured' })); return;
    }
    const segments = url.pathname.split('/');
    const taskId = segments[segments.length - 2];

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // disable Nginx buffering
    });

    const send = (event: string, data: unknown) => {
      try {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch { /* client gone */ }
    };

    const sub = this.projectAgentsSubscribeOutputFn(taskId, (line) => send('line', line));
    if (!sub) {
      send('error', { message: 'no active session' });
      res.end();
      return;
    }

    // Replay history first
    send('history', { lines: sub.history });

    // Heartbeat every 25s so proxies don't close the connection
    const heartbeat = setInterval(() => {
      try { res.write(`:hb\n\n`); } catch { /* gone */ }
    }, 25_000);

    const cleanup = () => {
      clearInterval(heartbeat);
      try { sub.unsubscribe(); } catch { /* ignore */ }
      try { res.end(); } catch { /* ignore */ }
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
  }

  // v651 — Live-Interjection für laufende Session
  private async handleProjectAgentsInterject(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectAgentsInterjectFn) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Interject not configured' })); return;
    }
    const segments = url.pathname.split('/');
    const taskId = segments[segments.length - 2];
    const body = await this.readBody(req);
    let text: string | undefined;
    try { text = JSON.parse(body).text; } catch { /* skip */ }
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'text required' })); return;
    }
    const result = await this.projectAgentsInterjectFn(taskId, text.trim());
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  // ── Background-Tasks API handlers (v623) ──
  private async handleBackgroundTasksList(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.backgroundTasksListFn) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const status = url.searchParams.get('status') ?? undefined;
    const list = await this.backgroundTasksListFn({ status });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tasks: list }));
  }

  private async handleBackgroundTasksGet(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.backgroundTasksGetFn) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const id = url.pathname.split('/').pop()!;
    const task = await this.backgroundTasksGetFn(id);
    if (!task) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ task }));
  }

  private async handleBackgroundTasksCancel(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.backgroundTasksCancelFn) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const segments = url.pathname.split('/');
    const id = segments[segments.length - 2]; // .../{id}/cancel
    const ok = await this.backgroundTasksCancelFn(id);
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: ok }));
  }

  // ── Conversation-History API handlers (v627) ──
  private async handleConversationsList(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.conversationsListFn) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const list = await this.conversationsListFn({
      platform: url.searchParams.get('platform') ?? undefined,
      limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined,
      offset: url.searchParams.get('offset') ? Number(url.searchParams.get('offset')) : undefined,
      sortBy: url.searchParams.get('sort') ?? undefined,
      sinceIso: url.searchParams.get('since') ?? undefined,
      untilIso: url.searchParams.get('until') ?? undefined,
      includeDeleted: url.searchParams.get('include_deleted') === '1',
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ conversations: list }));
  }

  // v644 — Lifecycle handlers
  private async handleConversationsPatch(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.conversationsPatchFn) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const id = url.pathname.split('/').pop()!;
    const body = await this.readBody(req);
    let patch: { customLabel?: string | null; pinned?: boolean };
    try { patch = JSON.parse(body); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }
    await this.conversationsPatchFn(id, patch);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
  }

  private async handleConversationsDelete(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.conversationsDeleteFn) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const id = url.pathname.split('/').pop()!;
    const hard = url.searchParams.get('hard') === '1';
    await this.conversationsDeleteFn(id, hard);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
  }

  private async handleConversationsBranch(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.conversationsBranchFn) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const parts = url.pathname.split('/');
    const id = parts[parts.length - 2];
    const body = await this.readBody(req);
    let data: { at_message_id?: string };
    try { data = JSON.parse(body); } catch { data = {}; }
    if (!data.at_message_id) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'at_message_id required' })); return; }
    const result = await this.conversationsBranchFn(id, data.at_message_id);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  private async handleConversationsExport(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.conversationsExportFn) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const body = await this.readBody(req);
    let data: { conversation_ids?: string[] };
    try { data = JSON.parse(body); } catch { data = {}; }
    if (!data.conversation_ids || data.conversation_ids.length === 0) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'conversation_ids required' })); return; }
    const result = await this.conversationsExportFn(data.conversation_ids);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  // v644 — Audio-Transcription für Chat-Voice-Input
  private async handleTranscribe(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.transcribeFn) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Transcribe not configured' })); return; }
    const contentType = req.headers['content-type'] ?? 'application/octet-stream';
    const chunks: Buffer[] = [];
    let total = 0;
    const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      total += buf.length;
      if (total > MAX_AUDIO_BYTES) {
        res.writeHead(413, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Audio too large (>25MB)' })); return;
      }
      chunks.push(buf);
    }
    try {
      const audio = Buffer.concat(chunks);
      const text = await this.transcribeFn(audio, contentType);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  private async handleConversationsReplay(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.conversationsReplayFn) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const parts = url.pathname.split('/');
    const conversationId = parts[parts.length - 2];
    const body = await this.readBody(req);
    let data: { message_id?: string };
    try { data = JSON.parse(body); } catch { data = {}; }
    if (!data.message_id) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'message_id required' })); return; }
    const result = await this.conversationsReplayFn(conversationId, data.message_id);
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  private async handleConversationsMessages(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.conversationsMessagesFn) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const segments = url.pathname.split('/');
    const id = segments[segments.length - 2]; // .../{id}/messages
    const beforeIso = url.searchParams.get('before') ?? undefined;
    const limit = url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined;
    const messages = await this.conversationsMessagesFn(id, { beforeIso, limit });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ messages }));
  }

  private async handleConversationsSummary(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.conversationsSummaryFn) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const segments = url.pathname.split('/');
    const id = segments[segments.length - 2]; // .../{id}/summary
    const summary = await this.conversationsSummaryFn(id);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ summary }));
  }

  private async handleConversationsSearch(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.conversationsSearchFn) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const query = url.searchParams.get('q') ?? '';
    if (!query.trim()) {
      res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'q query parameter required' })); return;
    }
    const limit = url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined;
    const results = await this.conversationsSearchFn(query, { limit });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ results }));
  }

  // ── Confirmations + Reminders Side-Panel handlers (v629) ──
  private async handleConfirmationsList(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.confirmationsListFn) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const list = await this.confirmationsListFn();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ confirmations: list }));
  }

  private async handleConfirmationDecide(req: http.IncomingMessage, res: http.ServerResponse, url: URL, decision: 'approve' | 'reject' | string): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.confirmationsDecideFn) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const segments = url.pathname.split('/');
    const id = segments[segments.length - 2]; // .../{id}/approve|reject
    const result = await this.confirmationsDecideFn(id, decision);
    if (!result.ok) {
      res.writeHead(result.reason?.startsWith('already-') ? 409 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: result.reason ?? 'Failed' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
  }

  private async handleRemindersList(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.remindersListFn) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const list = await this.remindersListFn();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ reminders: list }));
  }

  // ── Todos + Notes handlers (v661) ──
  private async handleTodosList(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.todosCallbacks) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const list = url.searchParams.get('list') ?? undefined;
    const includeCompleted = url.searchParams.get('includeCompleted') === '1';
    const todos = await this.todosCallbacks.list({ list, includeCompleted });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ todos }));
  }

  private async handleTodosAdd(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.todosCallbacks) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const body = await this.readBody(req);
    let data: { title?: string; description?: string; priority?: string; dueDate?: string; list?: string; projectId?: string };
    try { data = JSON.parse(body); } catch { data = {}; }
    if (!data.title?.trim()) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'title erforderlich' })); return; }
    const todo = await this.todosCallbacks.add({
      title: data.title.trim(),
      description: data.description,
      priority: data.priority,
      dueDate: data.dueDate,
      list: data.list,
      // v671 — optional Projekt-Verknüpfung beim Anlegen
      projectId: data.projectId,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ todo }));
  }

  private async handleTodosUpdate(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.todosCallbacks) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const id = url.pathname.split('/').pop()!;
    const body = await this.readBody(req);
    let data: Record<string, unknown>;
    try { data = JSON.parse(body); } catch { data = {}; }
    const todo = await this.todosCallbacks.update(id, data);
    res.writeHead(todo ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(todo ? { todo } : { error: 'not-found' }));
  }

  private async handleTodosComplete(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.todosCallbacks) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const parts = url.pathname.split('/');
    const id = parts[parts.length - 2];
    const ok = await this.todosCallbacks.complete(id);
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: ok }));
  }

  private async handleTodosDelete(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.todosCallbacks) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const id = url.pathname.split('/').pop()!;
    const ok = await this.todosCallbacks.delete(id);
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: ok }));
  }

  // v670 — Todo-Notes (Arbeitsnotizen / Fortschritts-Verlauf)
  private async handleTodoNotesList(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.todosCallbacks?.listNotes) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const parts = url.pathname.split('/');
    const todoId = parts[parts.length - 2];
    const notes = await this.todosCallbacks.listNotes(todoId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ notes }));
  }
  private async handleTodoNotesAdd(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.todosCallbacks?.addNote) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const parts = url.pathname.split('/');
    const todoId = parts[parts.length - 2];
    const body = await this.readBody(req);
    let data: { content?: unknown };
    try { data = JSON.parse(body); }
    catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }
    const content = typeof data?.content === 'string' ? data.content.trim() : '';
    if (!content) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'content required' })); return; }
    const note = await this.todosCallbacks.addNote(todoId, content);
    res.writeHead(note ? 201 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(note ? { note } : { error: 'todo-not-found' }));
  }
  private async handleTodoNotesDelete(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.todosCallbacks?.deleteNote) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const noteId = url.pathname.split('/').pop()!;
    const ok = await this.todosCallbacks.deleteNote(noteId);
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: ok }));
  }

  // v672 — Todo ↔ Note M:N Verknüpfung
  private async handleTodoLinkedNotes(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.todosCallbacks?.listLinkedNotes) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const parts = url.pathname.split('/');
    const todoId = parts[parts.length - 2];
    const notes = await this.todosCallbacks.listLinkedNotes(todoId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ notes }));
  }
  private async handleTodoNoteLinkAdd(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.todosCallbacks?.linkNote) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const parts = url.pathname.split('/');
    const noteId = parts[parts.length - 1];
    const todoId = parts[parts.length - 3];
    const ok = await this.todosCallbacks.linkNote(todoId, noteId);
    res.writeHead(ok ? 201 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, created: ok }));
  }
  private async handleTodoNoteLinkRemove(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.todosCallbacks?.unlinkNote) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const parts = url.pathname.split('/');
    const noteId = parts[parts.length - 1];
    const todoId = parts[parts.length - 3];
    const ok = await this.todosCallbacks.unlinkNote(todoId, noteId);
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: ok }));
  }
  private async handleNoteLinkedTodos(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.todosCallbacks?.listLinkedTodos) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const parts = url.pathname.split('/');
    const noteId = parts[parts.length - 2];
    const todos = await this.todosCallbacks.listLinkedTodos(noteId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ todos }));
  }

  // v673 — Attachment-Handler (Documents, FileStore, URLs, Base64-Upload)
  private async handleDocumentsList(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.attachmentsCallbacks?.listDocuments) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const documents = await this.attachmentsCallbacks.listDocuments();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ documents }));
  }
  private async handleStoredFilesList(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.attachmentsCallbacks?.listFiles) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const files = await this.attachmentsCallbacks.listFiles();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ files }));
  }

  // v674 — Download eines im FileStore gespeicherten Files
  private async handleFileDownload(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.attachmentsCallbacks?.readFile) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const key = url.searchParams.get('key');
    if (!key) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'key required' })); return; }
    const result = await this.attachmentsCallbacks.readFile(key);
    if (!result) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'File not found or access denied' })); return; }
    // Sicheres Content-Disposition: RFC 5987 UTF-8 + ASCII-Fallback ohne CR/LF (Header-Injection-Schutz)
    const safeName = result.fileName.replace(/[^\w.\-]/g, '_').replace(/_{2,}/g, '_');
    const utf8Name = encodeURIComponent(result.fileName);
    res.writeHead(200, {
      'Content-Type': result.mimeType ?? 'application/octet-stream',
      'Content-Length': String(result.data.length),
      'Content-Disposition': `attachment; filename="${safeName}"; filename*=UTF-8''${utf8Name}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=0, no-cache',
    });
    res.end(result.data);
  }
  private async handleBase64Upload(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.attachmentsCallbacks?.uploadFile) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured (FileStore disabled)' })); return; }
    const body = await this.readBody(req);
    let data: { filename?: string; mimeType?: string; base64Data?: string };
    try { data = JSON.parse(body); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }
    if (!data.filename || !data.base64Data) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'filename + base64Data erforderlich' })); return; }
    const result = await this.attachmentsCallbacks.uploadFile({
      filename: data.filename, mimeType: data.mimeType ?? 'application/octet-stream', base64Data: data.base64Data,
    });
    res.writeHead(result ? 201 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result ? { file: result } : { error: 'upload failed' }));
  }
  private async handleAttachmentsList(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.attachmentsCallbacks) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const parts = url.pathname.split('/');
    const entityType = parts[2] === 'todos' ? 'todo' : 'note';
    const entityId = parts[3];
    const attachments = await this.attachmentsCallbacks.list(entityType, entityId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ attachments }));
  }
  private async handleAttachmentsAdd(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.attachmentsCallbacks) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const parts = url.pathname.split('/');
    const entityType = parts[2] === 'todos' ? 'todo' : 'note';
    const entityId = parts[3];
    const body = await this.readBody(req);
    let data: { sourceKind?: string; sourceRef?: string; label?: string; mimeType?: string; sizeBytes?: number };
    try { data = JSON.parse(body); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }
    if (!data.sourceKind || !data.sourceRef) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'sourceKind + sourceRef erforderlich' })); return; }
    if (!['document', 'file', 'url', 'upload'].includes(data.sourceKind)) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid sourceKind' })); return; }
    const att = await this.attachmentsCallbacks.add({
      entityType, entityId, sourceKind: data.sourceKind, sourceRef: data.sourceRef,
      label: data.label, mimeType: data.mimeType, sizeBytes: data.sizeBytes,
    });
    res.writeHead(att ? 201 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(att ? { attachment: att } : { error: 'entity not found' }));
  }
  private async handleAttachmentDelete(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.attachmentsCallbacks) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const id = url.pathname.split('/').pop()!;
    const ok = await this.attachmentsCallbacks.delete(id);
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: ok }));
  }

  private async handleNotesList(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.notesCallbacks) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const query = url.searchParams.get('q') ?? undefined;
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
    const notes = await this.notesCallbacks.list({ query, limit });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ notes }));
  }

  private async handleNotesAdd(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.notesCallbacks) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const body = await this.readBody(req);
    let data: { title?: string; content?: string };
    try { data = JSON.parse(body); } catch { data = {}; }
    if (!data.title?.trim() || !data.content?.trim()) {
      res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'title + content erforderlich' })); return;
    }
    const note = await this.notesCallbacks.add({ title: data.title.trim(), content: data.content });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ note }));
  }

  private async handleNotesUpdate(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.notesCallbacks) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const id = url.pathname.split('/').pop()!;
    const body = await this.readBody(req);
    let data: { title?: string; content?: string };
    try { data = JSON.parse(body); } catch { data = {}; }
    const note = await this.notesCallbacks.update(id, data);
    res.writeHead(note ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(note ? { note } : { error: 'not-found' }));
  }

  private async handleNotesDelete(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.notesCallbacks) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const id = url.pathname.split('/').pop()!;
    const ok = await this.notesCallbacks.delete(id);
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: ok }));
  }

  // ── Insights handlers (v638) ──
  private async handleInsightsList(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.insightsListFn) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const filter = {
      category: url.searchParams.get('category') ?? undefined,
      status: url.searchParams.get('status') ?? undefined,
      limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined,
    };
    const list = await this.insightsListFn(filter);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ insights: list }));
  }

  private async handleInsightsStats(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.insightsStatsFn) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const stats = await this.insightsStatsFn();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ stats }));
  }

  private async handleInsightsSweep(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.insightsSweepFn) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const result = await this.insightsSweepFn();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  private async handleInsightsDismiss(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.insightsDismissFn) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const id = url.pathname.split('/')[3];
    await this.insightsDismissFn(id);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
  }

  // v695 — Bulk-Dismiss: alle pending/snoozed Insights einer Kategorie auf einen Schlag erledigen.
  private async handleInsightsDismissCategory(req: http.IncomingMessage, res: http.ServerResponse, _url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.insightsDismissCategoryFn) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const body = await this.readBody(req);
    let category = '';
    try { category = String(JSON.parse(body).category ?? ''); } catch { /* invalid */ }
    if (!category) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'category required' })); return; }
    const dismissed = await this.insightsDismissCategoryFn(category);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, dismissed }));
  }

  private async handleInsightsSnooze(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.insightsSnoozeFn) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const id = url.pathname.split('/')[3];
    const body = await this.readBody(req);
    let hours = 24;
    try { hours = Number(JSON.parse(body).hours ?? 24); } catch { /* default */ }
    await this.insightsSnoozeFn(id, hours);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
  }

  private async handleInsightsAct(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.insightsActFn) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const id = url.pathname.split('/')[3];
    const result = await this.insightsActFn(id);
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  // ── Goals handlers (v639) ──
  private async handleGoalsList(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.goalsListFn) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const list = await this.goalsListFn({
      status: url.searchParams.get('status') ?? undefined,
      category: url.searchParams.get('category') ?? undefined,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ goals: list }));
  }
  private async handleGoalsGet(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.goalsGetFn) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const id = url.pathname.split('/')[3];
    const detail = await this.goalsGetFn(id);
    if (!detail) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(detail));
  }
  private async handleGoalsAdd(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.goalsAddFn) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const body = await this.readBody(req);
    let data: Record<string, unknown>;
    try { data = JSON.parse(body); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }
    if (!data.title) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'title required' })); return; }
    const goal = await this.goalsAddFn(data);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ goal }));
  }
  private async handleGoalsUpdate(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.goalsUpdateFn) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const id = url.pathname.split('/')[3];
    const body = await this.readBody(req);
    let data: Record<string, unknown>;
    try { data = JSON.parse(body); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }
    const goal = await this.goalsUpdateFn(id, data);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ goal }));
  }
  private async handleGoalsCheck(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.goalsCheckFn) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const id = url.pathname.split('/')[3];
    const body = await this.readBody(req);
    let data: { status?: string; notes?: string };
    try { data = JSON.parse(body); } catch { data = {}; }
    await this.goalsCheckFn(id, data.status ?? 'on-track', data.notes);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
  }

  // ── Projects API handlers ──
  private async handleProjectsList(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const status = url.searchParams.get('status') ?? undefined;
    const list = await this.projectsCallbacks.list({ status });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ projects: list }));
  }

  private async handleProjectsGet(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const id = url.pathname.split('/').pop()!;
    const detail = await this.projectsCallbacks.get(id);
    if (!detail) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(detail));
  }

  private async handleProjectsCreate(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const body = await this.readBody(req);
    let input: Record<string, unknown>;
    try { input = JSON.parse(body); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }
    if (!input.name) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'name required' })); return; }
    const project = await this.projectsCallbacks.create(input);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ project }));
  }

  private async handleProjectsUpdate(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const id = url.pathname.split('/').pop()!;
    const body = await this.readBody(req);
    let patch: Record<string, unknown>;
    try { patch = JSON.parse(body); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }
    const project = await this.projectsCallbacks.update(id, patch);
    if (!project) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ project }));
  }

  private async handleProjectsArchive(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const id = url.pathname.split('/').pop()!;
    const ok = await this.projectsCallbacks.archive(id);
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: ok }));
  }

  private async handleProjectsAddOpenItem(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const parts = url.pathname.split('/');
    const projectId = parts[parts.length - 2];
    const body = await this.readBody(req);
    let input: Record<string, unknown>;
    try { input = JSON.parse(body); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }
    if (!input.title) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'title required' })); return; }
    const item = await this.projectsCallbacks.addOpenItem(projectId, input);
    if (!item) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ item }));
  }

  private async handleProjectsUpdateOpenItem(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const itemId = url.pathname.split('/').pop()!;
    const body = await this.readBody(req);
    let patch: { status?: string; title?: string; description?: string | null };
    try { patch = JSON.parse(body); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }
    if (!patch.status && patch.title == null && patch.description === undefined) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'status, title oder description required' }));
      return;
    }
    const ok = await this.projectsCallbacks.updateOpenItem(itemId, patch);
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: ok }));
  }

  private async handleProjectsHealthLog(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const parts = url.pathname.split('/');
    const projectId = parts[parts.length - 2];
    const limit = Number(url.searchParams.get('limit') ?? '100');
    const entries = await this.projectsCallbacks.listHealthLog(projectId, limit);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ entries }));
  }

  // v641 — Bulk-Work + Audit handlers
  private async handleProjectsWorkOnItems(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.workOnOpenItems) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const parts = url.pathname.split('/');
    const projectId = parts[parts.length - 2];
    const body = await this.readBody(req);
    let data: { item_ids?: string[]; max_items?: number };
    try { data = JSON.parse(body); } catch { data = {}; }
    const result = await this.projectsCallbacks.workOnOpenItems(projectId, data.item_ids ?? [], data.max_items ?? 10);
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  private async handleProjectsAuditItems(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.auditOpenItems) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const parts = url.pathname.split('/');
    const projectId = parts[parts.length - 2];
    const result = await this.projectsCallbacks.auditOpenItems(projectId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  // v643 — Commits handlers
  private async handleProjectsCommits(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.listProjectCommits) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const parts = url.pathname.split('/');
    const projectId = parts[parts.length - 2];
    const limit = Number(url.searchParams.get('limit') ?? '100');
    const commits = await this.projectsCallbacks.listProjectCommits(projectId, limit);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ commits }));
  }

  private async handleProjectsSessionCommits(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.listSessionCommits) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const parts = url.pathname.split('/');
    const sessionId = parts[parts.length - 2];
    const commits = await this.projectsCallbacks.listSessionCommits(sessionId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ commits }));
  }

  // v658 — Work-Stats: Aggregation der Arbeitszeit pro Projekt (byType + byAgent)
  private async handleProjectsWorkStats(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.workStats) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const parts = url.pathname.split('/');
    const projectId = parts[parts.length - 2];
    const stats = await this.projectsCallbacks.workStats(projectId);
    res.writeHead(stats ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(stats ?? { error: 'not-found' }));
  }

  // v658 — Chat-History für die Projekt-Conversation
  private async handleProjectsChatHistory(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.chatHistory) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const parts = url.pathname.split('/');
    const projectId = parts[parts.length - 2];
    const limitParam = url.searchParams.get('limit');
    const limit = Math.min(200, Math.max(1, Number(limitParam) || 50));
    const history = await this.projectsCallbacks.chatHistory(projectId, limit);
    res.writeHead(history ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(history ?? { error: 'not-found' }));
  }

  // v659 — Letzte Deploys aus deploy_*-Memories parsen + auto-detected Runtime
  private async handleProjectsLastDeploys(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.lastDeploys) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const parts = url.pathname.split('/');
    const projectId = parts[parts.length - 2];
    const result = await this.projectsCallbacks.lastDeploys(projectId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  // v659 — Deploy-Trigger mit Form-Params
  private async handleProjectsDeploy(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.triggerDeploy) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Deploy nicht konfiguriert' })); return;
    }
    const parts = url.pathname.split('/');
    const projectId = parts[parts.length - 2];
    const body = await this.readBody(req);
    let data: Record<string, unknown>;
    try { data = JSON.parse(body); } catch { data = {}; }
    const result = await this.projectsCallbacks.triggerDeploy(projectId, data);
    res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  // v663a — Roadmap-Handler
  private async handleProjectsRoadmap(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.listRoadmap) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const parts = url.pathname.split('/');
    const projectId = parts[parts.length - 2];
    const milestones = await this.projectsCallbacks.listRoadmap(projectId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ milestones }));
  }

  private async handleProjectsUpdateOpenItemRoadmap(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.updateOpenItemRoadmap) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const parts = url.pathname.split('/');
    const itemId = parts[parts.length - 2];
    const body = await this.readBody(req);
    let data: { milestone?: string | null; order?: number | null; estimatedHours?: number | null };
    try { data = JSON.parse(body); } catch { data = {}; }
    const ok = await this.projectsCallbacks.updateOpenItemRoadmap(itemId, data);
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: ok }));
  }

  private async handleProjectsImplementMilestone(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.implementMilestone) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const parts = url.pathname.split('/');
    const projectId = parts[parts.length - 2];
    const body = await this.readBody(req);
    let data: { milestone?: string };
    try { data = JSON.parse(body); } catch { data = {}; }
    if (!data.milestone?.trim()) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'milestone required' })); return; }
    const result = await this.projectsCallbacks.implementMilestone(projectId, data.milestone.trim());
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  // v663b — Automations Handlers
  private async handleAutomationTemplates(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.listAutomationTemplates) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const templates = await this.projectsCallbacks.listAutomationTemplates();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ templates }));
  }

  private async handleAutomationsList(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.listAutomations) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const parts = url.pathname.split('/');
    const projectId = parts[parts.length - 2];
    const automations = await this.projectsCallbacks.listAutomations(projectId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ automations }));
  }

  private async handleAutomationsAdd(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.addAutomation) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const parts = url.pathname.split('/');
    const projectId = parts[parts.length - 2];
    const body = await this.readBody(req);
    let data: Record<string, unknown>;
    try { data = JSON.parse(body); } catch { data = {}; }
    const automation = await this.projectsCallbacks.addAutomation(projectId, data);
    res.writeHead(automation ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(automation ? { automation } : { error: 'add failed' }));
  }

  private async handleAutomationsUpdate(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.updateAutomation) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const id = url.pathname.split('/').pop()!;
    const body = await this.readBody(req);
    let data: Record<string, unknown>;
    try { data = JSON.parse(body); } catch { data = {}; }
    const ok = await this.projectsCallbacks.updateAutomation(id, data);
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: ok }));
  }

  private async handleAutomationsDelete(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.deleteAutomation) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const id = url.pathname.split('/').pop()!;
    const ok = await this.projectsCallbacks.deleteAutomation(id);
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: ok }));
  }

  private async handleAutomationsRun(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.runAutomationNow) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const parts = url.pathname.split('/');
    const id = parts[parts.length - 2];
    const result = await this.projectsCallbacks.runAutomationNow(id);
    res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  // v665b — Cluster-Shares + Project-Move
  private async handleClusterShares(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.listClusterShares) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const shares = await this.projectsCallbacks.listClusterShares();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ shares }));
  }

  private async handleProjectMovePreflight(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.moveProjectPreflight) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const parts = url.pathname.split('/');
    const projectId = parts[parts.length - 3]; // /api/projects/:id/move/preflight
    const body = await this.readBody(req);
    let data: { storageType?: string; shareId?: string; nodeId?: string };
    try { data = JSON.parse(body); } catch { data = {}; }
    if (!data.storageType) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'storageType required' })); return; }
    const result = await this.projectsCallbacks.moveProjectPreflight(projectId, data as { storageType: string; shareId?: string; nodeId?: string });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  private async handleProjectMove(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.moveProject) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const parts = url.pathname.split('/');
    const projectId = parts[parts.length - 2];
    const body = await this.readBody(req);
    let data: { storageType?: string; shareId?: string; nodeId?: string; excludes?: string[]; keepSource?: boolean };
    try { data = JSON.parse(body); } catch { data = {}; }
    if (!data.storageType) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'storageType required' })); return; }
    const result = await this.projectsCallbacks.moveProject(
      projectId,
      { storageType: data.storageType, shareId: data.shareId, nodeId: data.nodeId },
      { excludes: data.excludes, keepSource: data.keepSource },
    );
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  // v642 — Bulk-Close handler
  private async handleProjectsBulkCloseItems(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.bulkCloseItems) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const parts = url.pathname.split('/');
    const projectId = parts[parts.length - 2];
    const body = await this.readBody(req);
    let data: { item_ids?: string[] };
    try { data = JSON.parse(body); } catch { data = {}; }
    const result = await this.projectsCallbacks.bulkCloseItems(projectId, data.item_ids ?? []);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
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

  // ─────────────────────────────────────────────────────────────────────────
  // v698 — Sandbox-Preview-Proxy (HTTP + WebSocket)
  // ─────────────────────────────────────────────────────────────────────────

  /** Cookie-Name für preview-token. Path-scoped damit nicht in andere Pfade leakt. */
  private readonly PREVIEW_COOKIE = '__alfred_preview_token';

  /** Liest preview-token aus Cookie ODER aus ?_alfred_auth=... (initial-load). */
  private extractPreviewToken(req: http.IncomingMessage, url: URL): { token: string | null; viaQuery: boolean } {
    const queryToken = url.searchParams.get('_alfred_auth');
    if (queryToken) return { token: queryToken, viaQuery: true };
    const cookieHeader = req.headers['cookie'] ?? '';
    for (const c of cookieHeader.split(';')) {
      const [name, ...rest] = c.trim().split('=');
      if (name === this.PREVIEW_COOKIE) return { token: rest.join('='), viaQuery: false };
    }
    return { token: null, viaQuery: false };
  }

  /**
   * Beim ersten Hit mit `?_alfred_auth=TOKEN`: setzt path-scoped Cookie und
   * 302-redirected auf dieselbe URL ohne Query — danach trägt der Browser
   * den Cookie automatisch zu allen sub-resources (inkl. WebSocket-HMR).
   */
  private writePreviewCookieAndRedirect(
    res: http.ServerResponse,
    sandboxId: string,
    token: string,
    pathInsideSandbox: string,
    url: URL,
  ): void {
    const target = new URL(url.toString());
    target.searchParams.delete('_alfred_auth');
    // v715 — Cookie path=/ (statt /preview/<sid>/) damit der Browser ihn auch bei
    // Sub-Resource-Requests wie /_next/static/* mitschickt (Next.js erzeugt absolute
    // Pfade die nicht den /preview/-Prefix tragen → würden ohne Cookie 401-en).
    // Sicher weil ownership-check pro sandboxId+token im Proxy-Resolver erfolgt.
    const cookieParts = [
      `${this.PREVIEW_COOKIE}=${encodeURIComponent(token)}`,
      `Path=/`,
      `HttpOnly`,
      `SameSite=Strict`,
    ];
    // Secure-Flag wenn TLS aktiv (https-Server hat setSecureContext)
    if (this.server && typeof (this.server as { setSecureContext?: unknown }).setSecureContext === 'function') cookieParts.push('Secure');
    void pathInsideSandbox;
    res.writeHead(302, {
      'Set-Cookie': cookieParts.join('; '),
      'Location': target.pathname + target.search,
      'Cache-Control': 'no-store',
    });
    res.end();
  }

  private writePreviewError(res: http.ServerResponse, status: number, title: string, message: string): void {
    // v716 — defensive guard: never crash if headers already sent
    if (res.headersSent || res.writableEnded) {
      try { res.destroy(); } catch { /* */ }
      return;
    }
    try {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!DOCTYPE html><html><head><title>${title}</title><meta charset="utf-8"></head>
<body style="font-family:system-ui;padding:2rem;background:#111;color:#ddd">
<h1 style="margin-top:0">${title}</h1>
<p>${message.replace(/</g, '&lt;')}</p>
<p style="opacity:0.6;font-size:0.9em">Alfred Sandbox-Preview</p>
</body></html>`);
    } catch { try { res.destroy(); } catch { /* */ } }
  }

  private async handleSandboxProxyHttp(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    sandboxId: string,
    upstreamPath: string,
  ): Promise<void> {
    // v713 — Alfred setzt X-Frame-Options: DENY als Default am Anfang von handleRequest
    // für ALLE Responses (Sicherheit). Für /preview/-Routes wollen wir iframe-Embed erlauben
    // — daher Default-Header EXPLIZIT entfernen bevor wir die Response schreiben.
    res.removeHeader('X-Frame-Options');
    if (!this.sandboxProxyResolve) {
      return this.writePreviewError(res, 503, 'Sandbox-Proxy nicht aktiv', 'Das Sandbox-Feature ist auf diesem Alfred-Node nicht aktiv.');
    }
    const { token, viaQuery } = this.extractPreviewToken(req, url);
    if (!token) {
      return this.writePreviewError(res, 401, 'Nicht angemeldet', 'Bitte öffne die Preview aus dem Alfred-WebUI heraus.');
    }

    const r = await this.sandboxProxyResolve(sandboxId, token);
    if (!r.ok) {
      return this.writePreviewError(res, r.status, `Preview nicht verfügbar (${r.status})`, r.message);
    }

    // Wenn token via Query kam: Cookie setzen + redirect auf clean-URL
    if (viaQuery) {
      this.writePreviewCookieAndRedirect(res, sandboxId, token, upstreamPath, url);
      return;
    }

    // Proxy-Request an Upstream
    const upstreamUrl = new URL(upstreamPath + (url.search ? url.search.replace(/[?&]_alfred_auth=[^&]*/g, '') : ''), `http://127.0.0.1:${r.hostPort}`);
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) { if (v != null) headers[k] = v; }
    // Cookie für Upstream bereinigen — Alfred-Cookies sollen nicht zum dev-server lecken
    delete headers['cookie'];
    delete headers['authorization'];
    headers['host'] = `127.0.0.1:${r.hostPort}`;
    headers['x-forwarded-host'] = String(req.headers['host'] ?? '');
    headers['x-forwarded-proto'] = this.server instanceof https.Server ? 'https' : 'http';
    headers['x-forwarded-prefix'] = `/preview/${sandboxId}`;
    // v724 — Accept-Encoding auf identity zwingen damit wir bei HTML-Responses den Body
    // ungekomprimiert buffern und <base href> + history-API-Patch injizieren können.
    // Upstream ist 127.0.0.1, compression bringt hier eh nichts.
    headers['accept-encoding'] = 'identity';

    const upstreamReq = http.request({
      host: '127.0.0.1',
      port: r.hostPort,
      method: req.method,
      path: upstreamUrl.pathname + upstreamUrl.search,
      headers,
      timeout: 60_000,
    }, upstreamRes => {
      // Status + Headers durchreichen
      const respHeaders: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(upstreamRes.headers)) {
        if (v == null) continue;
        const lk = k.toLowerCase();
        // Hop-by-hop-Headers verwerfen
        if (lk === 'connection' || lk === 'keep-alive' || lk === 'transfer-encoding' || lk === 'upgrade') continue;
        // v712 — iframe-Blocker entfernen: x-frame-options DENY + CSP frame-ancestors blockieren
        // sonst das Live-Preview. Da das iframe nur über unseren auth-gated Proxy lädt,
        // ist same-origin-Embed sicher.
        if (lk === 'x-frame-options') continue;
        if (lk === 'content-security-policy' || lk === 'content-security-policy-report-only') {
          // Strip frame-ancestors-Directive (kann iframe-Embedding blocken)
          const csp = Array.isArray(v) ? v.join('; ') : String(v);
          const cleaned = csp
            .split(';')
            .map(s => s.trim())
            .filter(s => !s.toLowerCase().startsWith('frame-ancestors'))
            .join('; ');
          if (cleaned) respHeaders[k] = cleaned;
          continue;
        }
        respHeaders[k] = v as string | string[];
      }

      // v724 — Bei HTML-Responses Body buffern, <base href> + history-API-Patch injizieren.
      // So bleibt der iframe-URL nach client-side Next.js-Navigation im /preview/<sid>/-Prefix
      // → Subresources (CSS, JS, API, _next/data) finden ihr Routing wieder.
      // NICHT für Streaming-RSC (text/x-component) oder SSE (text/event-stream).
      const ctRaw = upstreamRes.headers['content-type'];
      const ct = Array.isArray(ctRaw) ? ctRaw[0] : (ctRaw ?? '');
      const isHtmlResponse = /^text\/html\b/i.test(ct);
      if (isHtmlResponse) {
        const chunks: Buffer[] = [];
        upstreamRes.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        upstreamRes.on('end', () => {
          try {
            let body = Buffer.concat(chunks).toString('utf8');
            const inject = this.buildSandboxHtmlInjection(sandboxId);
            // Versuche nach <head ...> einzufügen (kann Attribute haben).
            // Fallback: nach <html ...>. Letzter Fallback: einfach voranstellen.
            const headMatch = body.match(/<head\b[^>]*>/i);
            if (headMatch && typeof headMatch.index === 'number') {
              const at = headMatch.index + headMatch[0].length;
              body = body.slice(0, at) + inject + body.slice(at);
            } else {
              const htmlMatch = body.match(/<html\b[^>]*>/i);
              if (htmlMatch && typeof htmlMatch.index === 'number') {
                const at = htmlMatch.index + htmlMatch[0].length;
                body = body.slice(0, at) + '<head>' + inject + '</head>' + body.slice(at);
              } else {
                body = inject + body;
              }
            }
            const out = Buffer.from(body, 'utf8');
            // Content-Length anpassen, falls vorher gesetzt war (war es bei identity oft)
            respHeaders['content-length'] = String(out.length);
            // Eigene Content-Encoding-Header entfernen (sicher ist sicher — wir senden identity)
            delete respHeaders['content-encoding'];
            res.writeHead(upstreamRes.statusCode ?? 502, respHeaders);
            res.end(out);
          } catch (err) {
            process.stderr.write(`[sandbox-proxy] html-inject failed sandbox=${sandboxId} err=${(err as Error).message}\n`);
            try {
              if (!res.headersSent) {
                res.writeHead(upstreamRes.statusCode ?? 502, respHeaders);
                res.end(Buffer.concat(chunks));
              }
            } catch { /* swallow */ }
          }
        });
        upstreamRes.on('error', err => {
          if (res.headersSent || res.writableEnded) { try { res.destroy(); } catch { /* */ } return; }
          try { this.writePreviewError(res, 502, 'Dev-Server-Stream abgebrochen', `Upstream-Fehler: ${(err as Error).message}`); } catch { /* */ }
        });
      } else {
        res.writeHead(upstreamRes.statusCode ?? 502, respHeaders);
        upstreamRes.pipe(res);
      }
    });

    upstreamReq.on('error', err => {
      // v716/v719 — Guard gegen ERR_HTTP_HEADERS_SENT: wenn response schon begann zu streamen
      // (z.B. 200 OK + Body) und der Upstream stirbt, würde writeHead crashen.
      const errMsg = (err as Error).message ?? String(err);
      if (res.headersSent || res.writableEnded) {
        try { res.destroy(); } catch { /* */ }
        return;
      }
      // v719 — Diagnose-Log für socket-hang-up + ähnliche Upstream-Fehler. Hilft beim
      // Debuggen ob Browser- oder Container-Seite den connection-close verursacht.
      try {
        // best-effort log via direct stderr (kein logger im scope hier)
        process.stderr.write(`[sandbox-proxy] upstream error sandbox=${sandboxId} path=${upstreamPath} method=${req.method} err=${errMsg}\n`);
      } catch { /* */ }
      try { this.writePreviewError(res, 502, 'Dev-Server nicht erreichbar', `Upstream-Fehler: ${errMsg}`); } catch { /* swallow */ }
    });
    upstreamReq.on('timeout', () => {
      upstreamReq.destroy(new Error('Timeout to upstream dev-server'));
    });
    // v719 — req.on('close') handler komplett ENTFERNT. War in v716 als "Cleanup" gedacht
    // wenn Browser disconnectet, aber feuerte ZU OFT (auch bei normalem keep-alive-end)
    // → socket-hang-up race. Node GC räumt orphan-streams auch ohne explicit destroy auf.
    // Trade-off: minimaler memory-leak-Risiko vs. korrekte Funktionalität. Wir wählen Funktion.

    req.pipe(upstreamReq);
  }

  /**
   * v724 — Baut das HTML-Inject-Snippet für Sandbox-Preview-Responses.
   * Zwei Komponenten:
   *  (a) `<base href="/preview/<sb>/">` — fängt plain `<a href="/foo">` und alle relativen
   *      Subresource-URLs ein, lässt sie unter dem preview-prefix auflösen.
   *  (b) `<script>` der history.pushState/replaceState wrapped — fängt Next.js Client-Router
   *      (`router.push('/community')`) ab und prefixt absolute Pfade.
   * Beides nötig: (a) allein reicht nicht weil Next.js URLs intern aus location.origin baut;
   * (b) allein reicht nicht weil plain `<a>` ohne Wrapper das base-href braucht.
   * Beide Komponenten sind idempotent: re-injection bei SPA-renavigates ist harmlos.
   */
  private buildSandboxHtmlInjection(sandboxId: string): string {
    // sandboxId ist UUID/Slug-Form — safe-by-construction für JS-Literal, kein User-Input.
    const safeId = sandboxId.replace(/[^a-zA-Z0-9-]/g, '');
    const prefix = `/preview/${safeId}`;
    return [
      `<base href="${prefix}/">`,
      `<script>`,
      `(function(){`,
      `var P=${JSON.stringify(prefix)};`,
      `function fix(u){`,
      `  if(typeof u==='string'&&u.charAt(0)==='/'&&u.indexOf(P+'/')!==0&&u!==P){return P+u;}`,
      `  return u;`,
      `}`,
      `try{`,
      `  var op=history.pushState.bind(history);`,
      `  var or=history.replaceState.bind(history);`,
      `  history.pushState=function(s,t,u){return op(s,t,fix(u));};`,
      `  history.replaceState=function(s,t,u){return or(s,t,fix(u));};`,
      `}catch(e){}`,
      `})();`,
      `</script>`,
    ].join('');
  }

  private async handleSandboxProxyUpgrade(
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
    url: URL,
    sandboxId: string,
    upstreamPath: string,
  ): Promise<void> {
    if (!this.sandboxProxyResolve) { socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n'); socket.destroy(); return; }
    const { token } = this.extractPreviewToken(req, url);
    if (!token) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    const r = await this.sandboxProxyResolve(sandboxId, token);
    if (!r.ok) { socket.write(`HTTP/1.1 ${r.status} ${r.message}\r\n\r\n`); socket.destroy(); return; }

    const upstream = net.connect({ host: '127.0.0.1', port: r.hostPort }, () => {
      // Original-Request rebuilden für upstream — bereinigt um alfred-cookies
      const headers = { ...req.headers };
      delete headers['cookie'];
      delete headers['authorization'];
      headers['host'] = `127.0.0.1:${r.hostPort}`;
      const cleanQuery = (url.search ?? '').replace(/[?&]_alfred_auth=[^&]*/g, '');
      const upstreamUrl = upstreamPath + cleanQuery;
      const lines: string[] = [`${req.method ?? 'GET'} ${upstreamUrl} HTTP/${req.httpVersion}`];
      for (const [k, v] of Object.entries(headers)) {
        if (v == null) continue;
        if (Array.isArray(v)) {
          for (const vv of v) lines.push(`${k}: ${vv}`);
        } else {
          lines.push(`${k}: ${v}`);
        }
      }
      upstream.write(lines.join('\r\n') + '\r\n\r\n');
      if (head && head.length > 0) upstream.write(head);
      // Duplex-pipe
      socket.pipe(upstream);
      upstream.pipe(socket);
    });

    upstream.on('error', err => {
      try { socket.write(`HTTP/1.1 502 Bad Gateway\r\n\r\nUpstream socket error: ${(err as Error).message}\n`); } catch { /* */ }
      try { socket.destroy(); } catch { /* */ }
    });
    socket.on('error', () => { try { upstream.destroy(); } catch { /* */ } });
    socket.on('close', () => { try { upstream.destroy(); } catch { /* */ } });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // v699 — Sandbox CRUD API
  // ─────────────────────────────────────────────────────────────────────────

  private async handleSandboxStatus(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.sandboxCallbacks) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ enabled: false, available: false, reason: 'feature-disabled' }));
      return;
    }
    const s = await this.sandboxCallbacks.status();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(s));
  }

  private async handleSandboxList(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.sandboxCallbacks) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Sandbox-Feature disabled' })); return; }
    const projectId = url.searchParams.get('projectId') ?? undefined;
    const sessionId = url.searchParams.get('sessionId') ?? undefined;
    const sandboxes = await this.sandboxCallbacks.list({ projectId, sessionId });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sandboxes }));
  }

  private async handleSandboxGet(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.sandboxCallbacks) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Sandbox-Feature disabled' })); return; }
    const sandboxId = url.pathname.split('/')[3];
    const sb = await this.sandboxCallbacks.getById(sandboxId);
    if (!sb) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Sandbox not found' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sandbox: sb }));
  }

  private async handleSandboxCreate(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.sandboxCallbacks) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Sandbox-Feature disabled' })); return; }
    // v714 — extract requesting user-id from token, damit sandbox.user_id = web-user (admin)
    // statt project.userId (kann Legacy-UID sein und blockt späteren Preview-Access mit 403)
    const authHeader = req.headers['authorization'];
    const tokenForUser = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    let requestUserId = '';
    if (tokenForUser && this.authCb) {
      const u = await this.authCb.getUserByToken(tokenForUser);
      if (u) requestUserId = u.userId;
    }
    const body = await this.readBody(req);
    let input: { projectId: string; sessionId?: string | null; mode: string; slug?: string; requestUserId?: string };
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      // v705 — sessionId ist optional seit v703 (Standalone-Sandboxes via "🚀 Interactive Sandbox")
      if (typeof parsed.projectId !== 'string' || typeof parsed.mode !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'projectId, mode required' }));
        return;
      }
      input = {
        projectId: parsed.projectId,
        sessionId: typeof parsed.sessionId === 'string' && parsed.sessionId.length > 0 ? parsed.sessionId : null,
        mode: parsed.mode,
        slug: typeof parsed.slug === 'string' ? parsed.slug : undefined,
        requestUserId, // v714 — wird im callback als sandbox.user_id verwendet
      };
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }
    try {
      const sb = await this.sandboxCallbacks.create(input);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sandbox: sb }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  private async handleSandboxAction(req: http.IncomingMessage, res: http.ServerResponse, url: URL, action: 'pause' | 'resume' | 'discard'): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.sandboxCallbacks) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Sandbox-Feature disabled' })); return; }
    const sandboxId = url.pathname.split('/')[3];
    try {
      if (action === 'pause') await this.sandboxCallbacks.pause(sandboxId);
      else if (action === 'resume') await this.sandboxCallbacks.resume(sandboxId);
      else if (action === 'discard') await this.sandboxCallbacks.discard(sandboxId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  private async handleSandboxMerge(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.sandboxCallbacks) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Sandbox-Feature disabled' })); return; }
    const sandboxId = url.pathname.split('/')[3];
    const body = await this.readBody(req);
    let opts: { strategy?: string; commitMessage?: string; prTitle?: string; prBody?: string } = {};
    try { opts = JSON.parse(body) as typeof opts; } catch { /* default empty */ }
    try {
      const r = await this.sandboxCallbacks.merge(sandboxId, opts);
      res.writeHead(r.ok ? 200 : 409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: (err as Error).message }));
    }
  }

  private async handleSandboxDiff(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.sandboxCallbacks) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Sandbox-Feature disabled' })); return; }
    const sandboxId = url.pathname.split('/')[3];
    try {
      const diff = await this.sandboxCallbacks.diff(sandboxId);
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(diff);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  // v703 — Sandbox-Chat (Interactive-Mode)
  private async handleSandboxChatList(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.sandboxCallbacks) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Sandbox-Feature disabled' })); return; }
    const sandboxId = url.pathname.split('/')[3];
    try {
      const messages = await this.sandboxCallbacks.chatList(sandboxId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ messages }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  private async handleSandboxChatSend(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.sandboxCallbacks) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Sandbox-Feature disabled' })); return; }
    const sandboxId = url.pathname.split('/')[3];
    const body = await this.readBody(req);
    let message = '';
    try { message = String((JSON.parse(body) as Record<string, unknown>).message ?? ''); } catch { /* */ }
    if (!message.trim()) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'message required' })); return; }
    try {
      const r = await this.sandboxCallbacks.chatSendMessage(sandboxId, message.trim());
      res.writeHead(r.ok ? 200 : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: (err as Error).message }));
    }
  }

  private async handleSandboxListAll(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.sandboxCallbacks) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Sandbox-Feature disabled' })); return; }
    try {
      // Auth-Check via Bearer-Token → wir nehmen einfach den ersten authentifizierten User
      // (für Multi-User: müsste hier userId aus checkAuth zurückgegeben werden — Phase-C-Polish)
      const authHeader = req.headers['authorization'];
      const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
      let userId = '';
      if (token && this.authCb) {
        const u = await this.authCb.getUserByToken(token);
        if (u) userId = u.userId;
      }
      const sandboxes = await this.sandboxCallbacks.listAll(userId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sandboxes }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
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
        const parsed = JSON.parse(body) as { text?: string; chatId?: string; userId?: string; replyToText?: string; replyToFrom?: string; replyToMessageId?: string; projectId?: string;
          // v687 — Project-Chat: optionale Context-Refs für In-Chat-Attachments/@-Mentions
          contextRefs?: Array<{ kind: string; refId: string; label?: string }>;
        };
        const text = parsed.text;
        if (!text || typeof text !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing or invalid "text" field' }));
          return;
        }

        // v658 — Projekt-Chat: wenn projectId gesetzt, chatId = `project:<id>` damit
        // die ConversationRepo.findOrCreateForProject() trifft. Pipeline injiziert
        // den Projekt-Kontext basierend auf der projectId.
        const projectId = typeof parsed.projectId === 'string' && parsed.projectId.length > 0 ? parsed.projectId : undefined;
        const chatId = projectId ? `project:${projectId}` : (parsed.chatId ?? `api-chat-${crypto.randomUUID()}`);
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
        // v680 — UUID statt Counter: Counter startet bei jedem Alfred-Restart bei 1.
        // `api-1` ist dann im processed_messages-Cluster-Store als bereits-verarbeitet
        // markiert → HA-Dedup verwirft die Message → Pipeline returnt leer (kein Feedback im UI).
        // UUID macht jede Message global eindeutig über Restarts hinweg.
        this.messageCounter++;
        const message: NormalizedMessage = {
          id: `api-${crypto.randomUUID()}`,
          platform: 'api',
          chatId,
          chatType: 'dm',
          userId,
          userName: userId,
          displayName: 'API User',
          text,
          timestamp: new Date(),
          // v657 — Reply-Kontext aus dem WebUI durchreichen
          replyToText: typeof parsed.replyToText === 'string' ? parsed.replyToText : undefined,
          replyToFrom: typeof parsed.replyToFrom === 'string' ? parsed.replyToFrom : undefined,
          replyToMessageId: typeof parsed.replyToMessageId === 'string' ? parsed.replyToMessageId : undefined,
          // v658 — Projekt-Chat: projectId in metadata damit message-pipeline den Kontext laden kann
          // v687 — contextRefs (Open-Items / Attachments / Notes) ebenfalls über metadata
          ...((projectId || (Array.isArray(parsed.contextRefs) && parsed.contextRefs.length > 0))
            ? { metadata: {
                ...(projectId ? { projectId } : {}),
                ...(Array.isArray(parsed.contextRefs) && parsed.contextRefs.length > 0 ? { contextRefs: parsed.contextRefs } : {}),
              } }
            : {}),
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

  // ── Log Viewer Handlers ────────────────────────────────────

  private async handleLogApp(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.logCallbacks) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Log viewer not configured' }));
      return;
    }
    // v681 — Caps deutlich erhöht: tägliche Logs haben oft 5000+ Zeilen, alte 500 zeigten
    // nur die letzte Stunde. Neue Defaults: 5000 Zeilen, hartes Cap 100k.
    const lines = Math.min(parseInt(url.searchParams.get('lines') ?? '5000', 10) || 5000, 100000);
    const level = url.searchParams.get('level') ?? undefined;
    const filter = url.searchParams.get('filter') ?? undefined;
    const fileIndex = url.searchParams.has('file') ? parseInt(url.searchParams.get('file')!, 10) || 0 : undefined;
    // v681 — since=<unixMs>: nur Log-Einträge ab dieser Zeit. Erlaubt Time-Range im UI.
    const since = url.searchParams.has('since') ? parseInt(url.searchParams.get('since')!, 10) || undefined : undefined;
    // v681 — beforeLines=<n>: skippe die letzten N Zeilen, dann nimm `lines` Zeilen DAVOR
    // (Pagination "ältere laden"). 0 = newest, >0 = ältere blättern.
    const offsetFromTail = url.searchParams.has('offset') ? parseInt(url.searchParams.get('offset')!, 10) || 0 : 0;
    const result = await this.logCallbacks.readAppLog(lines, level, filter, fileIndex, since, offsetFromTail);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  private async handleLogStream(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.logCallbacks) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Log streaming not configured' }));
      return;
    }
    const level = url.searchParams.get('level') ?? undefined;
    const filter = url.searchParams.get('filter') ?? undefined;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': this.corsOrigin,
      'X-Content-Type-Options': 'nosniff',
    });
    res.flushHeaders();

    const cleanup = this.logCallbacks.streamAppLog(res, level, filter);
    res.on('close', cleanup);
  }

  private async handleLogAudit(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.logCallbacks) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Log viewer not configured' }));
      return;
    }
    const lines = Math.min(parseInt(url.searchParams.get('lines') ?? '100', 10) || 100, 2000);
    const fileIndex = url.searchParams.has('file') ? parseInt(url.searchParams.get('file')!, 10) || 0 : undefined;
    const result = await this.logCallbacks.readAuditLog(lines, undefined, undefined, fileIndex);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  // ── Cluster Health Handler ─────────────────────────────────

  private async handleClusterHealth(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.clusterCallbacks) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ clusterEnabled: false, thisNodeId: 'single', nodes: [], claims: [], recentReasoningSlots: [], operations: {} }));
      return;
    }
    const data = await this.clusterCallbacks.getHealth();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }
}
