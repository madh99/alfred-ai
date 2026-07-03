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
  /** v922 — generischer ITSM-Skill-Durchgriff für Analytics (mttr_report, capacity_forecast, …). Aktion wird in der Route gewhitelistet. */
  skillAction?: (userId: string, action: string, params?: Record<string, unknown>) => Promise<any>;
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

/** v728 — Wire-Up-Interface für Environments-CRUD-API. */
export interface EnvironmentsCallbacks {
  listStages: (projectId: string) => Promise<Array<{ stage: string; keyCount: number; updatedAt: string }>>;
  getVars: (projectId: string, stage: string, reveal: boolean) => Promise<Record<string, string>>;
  setVars: (projectId: string, stage: string, vars: Record<string, string>, replace: boolean) => Promise<{ ok: boolean; count: number; reason?: string }>;
  deleteStage: (projectId: string, stage: string) => Promise<void>;
  /** v732 — Repo-Scan: liefert Liste benötigter ENV-Keys aus .env.example + Quelltext. */
  scanRepo?: (projectId: string) => Promise<{ ok: boolean; keys?: Array<{ key: string; sources: string[] }>; reason?: string }>;
}

/** v751 — Wire-Up für Sandbox-Templates-CRUD. */
export interface SandboxTemplatesCallbacks {
  list: (projectId?: string | null) => Promise<Array<{
    id: string; projectId?: string; name: string; description?: string;
    mode: string; envStage?: string; dbSeedId?: string; initialGoal?: string;
    tags: string[]; createdAt: string; updatedAt: string;
  }>>;
  create: (input: {
    projectId?: string | null; name: string; description?: string;
    mode: 'sandbox' | 'sandbox-preview' | 'interactive-chat';
    envStage?: string; dbSeedId?: string; initialGoal?: string; tags?: string[];
  }) => Promise<{ ok: boolean; id?: string; reason?: string }>;
  update: (id: string, patch: Record<string, unknown>) => Promise<{ ok: boolean; reason?: string }>;
  delete: (id: string) => Promise<{ ok: boolean; reason?: string }>;
}

/** v764 — Project-Wizard: LLM-gestützte Bootstrap-Vorschläge. */
export interface ProjectWizardSuggestStackResult {
  frontend: string;
  backend: string;
  database: string;
  extras: string[];
  rationale: string;
}

export interface ProjectWizardPlanItem {
  title: string;
  description?: string;
  priority: 'low' | 'normal' | 'high';
  roadmapMilestone: string;
  roadmapOrder: number;
}

export interface ProjectWizardDecision {
  choice: string;
  rationale: string;
}

export interface ProjectWizardGeneratePlanResult {
  items: ProjectWizardPlanItem[];
  decisions: ProjectWizardDecision[];
}

export interface ProjectWizardValidateResult {
  ok: boolean;
  issues: string[];
  suggestions: string[];
}

export interface ProjectWizardCreateInput {
  name: string;
  slug?: string;
  description: string;
  stack: ProjectWizardSuggestStackResult;
  items: ProjectWizardPlanItem[];
  decisions: ProjectWizardDecision[];
  tags?: string[];
  /** v766 — Repo-Mode für Auto-Erstellung im Forge. */
  repoMode?: 'gitlab' | 'github' | 'local';
  /** v766 — Scaffold-Mode für Initial-Files. */
  scaffoldMode?: 'template' | 'agent' | 'none';
  /** v766 — Visibility für Remote-Repo (default private). */
  repoVisibility?: 'private' | 'public';
  /** v900 — Runtime (node/python/php/ruby/go/static) — informiert Scaffold + spätere Sandbox-Detection. */
  runtime?: string;
  /** v900 — Deploy-Ziel; 'compose' (oder DB≠SQLite) ⇒ Compose-Sandbox + Container-Fundament. */
  deployTarget?: 'static' | 'single' | 'docker' | 'compose' | 'serverless';
}

export interface ProjectWizardCallbacks {
  suggestStack: (description: string) => Promise<ProjectWizardSuggestStackResult>;
  generatePlan: (description: string, stack: ProjectWizardSuggestStackResult) => Promise<ProjectWizardGeneratePlanResult>;
  validate: (description: string, stack: ProjectWizardSuggestStackResult, items: ProjectWizardPlanItem[]) => Promise<ProjectWizardValidateResult>;
  create: (input: ProjectWizardCreateInput) => Promise<{ ok: boolean; projectId?: string; reason?: string }>;
}

/** v732 — Wire-Up-Interface für DB-Seeds-CRUD-API. */
export interface DbSeedsCallbacks {
  list: (projectId: string) => Promise<Array<{ id: string; name: string; kind: string; storageRef: string; sizeBytes: number; createdAt: string }>>;
  upload: (projectId: string, name: string, dataBase64: string) => Promise<{ ok: boolean; seedId?: string; reason?: string }>;
  registerRepoPath: (projectId: string, name: string, repoPath: string) => Promise<{ ok: boolean; seedId?: string; reason?: string }>;
  delete: (projectId: string, seedId: string) => Promise<{ ok: boolean; reason?: string }>;
  setDefault: (projectId: string, seedId: string | null) => Promise<{ ok: boolean; reason?: string }>;
}

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
  // v782 — Strukturierter AgentEvent-Subscribe-Stream parallel zu Text-Lines
  private projectAgentsSubscribeEventsFn?: (taskId: string, cb: (entry: { ts: number; type: string; data: unknown }) => void) => { history: Array<{ ts: number; type: string; data: unknown }>; unsubscribe: () => void } | null;
  private projectAgentsInterjectFn?: (taskId: string, text: string) => Promise<{ ok: boolean; error?: string }>;

  setProjectAgentCallbacks(opts: {
    list: (filter?: { phase?: string }) => Promise<any[]>;
    get: (taskId: string) => Promise<any | null>;
    stop: (taskId: string) => Promise<boolean>;
    resume?: (taskId: string, notes?: string) => Promise<{ ok: boolean; taskId?: string; error?: string }>;
    plan?: (taskId: string) => Promise<any[]>;
    subscribeOutput?: (taskId: string, cb: (line: { ts: number; source: string; text: string }) => void) => { history: Array<{ ts: number; source: string; text: string }>; unsubscribe: () => void } | null;
    /** v782 — strukturierte AgentEvents (für Card-Rendering). */
    subscribeEvents?: (taskId: string, cb: (entry: { ts: number; type: string; data: unknown }) => void) => { history: Array<{ ts: number; type: string; data: unknown }>; unsubscribe: () => void } | null;
    interject?: (taskId: string, text: string) => Promise<{ ok: boolean; error?: string }>;
  }): void {
    this.projectAgentsListFn = opts.list;
    this.projectAgentsGetFn = opts.get;
    this.projectAgentsStopFn = opts.stop;
    this.projectAgentsResumeFn = opts.resume;
    this.projectAgentsPlanFn = opts.plan;
    this.projectAgentsSubscribeOutputFn = opts.subscribeOutput;
    this.projectAgentsSubscribeEventsFn = opts.subscribeEvents;
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
  private insightsActFn?: (id: string, params?: Record<string, unknown>) => Promise<{ ok: boolean; result?: any; reason?: string }>;
  private insightsMuteCategoryFn?: (category: string, muted: boolean) => Promise<void>;
  private insightsListMutedFn?: () => Promise<string[]>;
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
  // v728 — restart + logs + stats
  private sandboxCallbacks?: {
    status: () => Promise<Record<string, unknown>>;
    list: (filter: { projectId?: string; sessionId?: string; userId?: string }) => Promise<unknown[]>;
    listAll: (userId: string) => Promise<unknown[]>;
    getById: (sandboxId: string) => Promise<unknown | null>;
    create: (input: { projectId: string; sessionId?: string | null; mode: string; slug?: string; requestUserId?: string; envStage?: string; dbSeedId?: string | null }) => Promise<unknown>;
    pause: (sandboxId: string) => Promise<void>;
    resume: (sandboxId: string) => Promise<void>;
    discard: (sandboxId: string) => Promise<void>;
    merge: (sandboxId: string, opts: { strategy?: string; commitMessage?: string; prTitle?: string; prBody?: string; confirmDirect?: boolean }) => Promise<{ ok: boolean; prUrl?: string; reason?: string }>;
    diff: (sandboxId: string) => Promise<string>;
    chatList: (sandboxId: string) => Promise<unknown[]>;
    chatSendMessage: (
      sandboxId: string,
      message: string,
      attachments?: Array<{ name: string; mime: string; dataUrl: string; dropInWorktree: boolean }>,
      mentions?: Array<{ id: string; type: 'open_item' | 'decision'; title: string; priority?: string; status?: string }>,
      /** v760 — Engine-Wahl: 'project-agent' (default, heavy 14-phase planner) | 'code-agent' (light, iterativ pro Iteration einen Commit). */
      engine?: 'project-agent' | 'code-agent' | 'discuss',
      /** v787 — Optional override: welcher CLI-Agent (claude-code/vibe/codex/generic) für diesen Run. */
      agentName?: string,
    ) => Promise<{ ok: boolean; userMessageId?: string; taskId?: string; reason?: string }>;
    /** v762 — Laufenden Code-Agent-Run via taskId abbrechen. */
    chatStopTask?: (sandboxId: string, taskId: string) => Promise<{ ok: boolean; reason?: string }>;
    /** v771 — Failed/stopped Project-Agent-Task resumen. */
    chatResumeTask?: (sandboxId: string, failedTaskId: string) => Promise<{ ok: boolean; taskId?: string; reason?: string }>;
    restart?: (sandboxId: string) => Promise<{ ok: boolean; reason?: string }>;
    getLogs?: (sandboxId: string, tail: number) => Promise<{ ok: boolean; logs?: string; reason?: string }>;
    getStats?: (sandboxId: string) => Promise<{ ok: boolean; stats?: Record<string, unknown>; reason?: string }>;
    forceFail?: (sandboxId: string, reason?: string) => Promise<{ ok: boolean; reason?: string }>;
  };

  /** v728 — Environments-CRUD-Callbacks (Wire-Up von alfred.ts → EnvironmentRepository + Crypto). */
  private environmentsCallbacks?: EnvironmentsCallbacks;
  setEnvironmentsCallbacks(cb: EnvironmentsCallbacks): void {
    this.environmentsCallbacks = cb;
  }

  /** v732 — DB-Seeds-CRUD-Callbacks. */
  private dbSeedsCallbacks?: DbSeedsCallbacks;
  setDbSeedsCallbacks(cb: DbSeedsCallbacks): void {
    this.dbSeedsCallbacks = cb;
  }

  /** v751 — Sandbox-Templates-CRUD-Callbacks. */
  private sandboxTemplatesCallbacks?: SandboxTemplatesCallbacks;
  setSandboxTemplatesCallbacks(cb: SandboxTemplatesCallbacks): void {
    this.sandboxTemplatesCallbacks = cb;
  }

  /** v764 — Project-Wizard-Callbacks (LLM-Suggest + Plan-Gen + Validator + Create). */
  private projectWizardCallbacks?: ProjectWizardCallbacks;
  setProjectWizardCallbacks(cb: ProjectWizardCallbacks): void {
    this.projectWizardCallbacks = cb;
  }

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
    create: (input: { projectId: string; sessionId?: string | null; mode: string; slug?: string; requestUserId?: string; envStage?: string; dbSeedId?: string | null }) => Promise<unknown>;
    pause: (sandboxId: string) => Promise<void>;
    resume: (sandboxId: string) => Promise<void>;
    discard: (sandboxId: string) => Promise<void>;
    merge: (sandboxId: string, opts: { strategy?: string; commitMessage?: string; prTitle?: string; prBody?: string; confirmDirect?: boolean }) => Promise<{ ok: boolean; prUrl?: string; reason?: string }>;
    diff: (sandboxId: string) => Promise<string>;
    chatList: (sandboxId: string) => Promise<unknown[]>;
    chatSendMessage: (
      sandboxId: string,
      message: string,
      attachments?: Array<{ name: string; mime: string; dataUrl: string; dropInWorktree: boolean }>,
      mentions?: Array<{ id: string; type: 'open_item' | 'decision'; title: string; priority?: string; status?: string }>,
      /** v760 — Engine-Wahl: 'project-agent' (default, heavy planner) | 'code-agent' (light, iterativ). */
      engine?: 'project-agent' | 'code-agent' | 'discuss',
      /** v787 — Optional override: welcher CLI-Agent (claude-code/vibe/codex/generic) für diesen Run. */
      agentName?: string,
    ) => Promise<{ ok: boolean; userMessageId?: string; taskId?: string; reason?: string }>;
    /** v762 — Laufenden Code-Agent-Run via taskId abbrechen. */
    chatStopTask?: (sandboxId: string, taskId: string) => Promise<{ ok: boolean; reason?: string }>;
    /** v771 — Failed/stopped Project-Agent-Task resumen. */
    chatResumeTask?: (sandboxId: string, failedTaskId: string) => Promise<{ ok: boolean; taskId?: string; reason?: string }>;
    restart?: (sandboxId: string) => Promise<{ ok: boolean; reason?: string }>;
    getLogs?: (sandboxId: string, tail: number) => Promise<{ ok: boolean; logs?: string; reason?: string }>;
    getStats?: (sandboxId: string) => Promise<{ ok: boolean; stats?: Record<string, unknown>; reason?: string }>;
    forceFail?: (sandboxId: string, reason?: string) => Promise<{ ok: boolean; reason?: string }>;
  }): void {
    this.sandboxCallbacks = cb;
  }

  /** v787/v788/v789/v791 — Agent-Session-Adapter-Liste + Session-Stats + Reset + Event-Replay. */
  private agentSessionCallbacks?: {
    listAvailable: () => Array<{ name: string; capabilities: Record<string, unknown> }>;
    /** v788 — Stats für alle Sessions einer Sandbox (für UI-Anzeige). */
    listSessionsForSandbox?: (sandboxId: string) => Promise<Array<Record<string, unknown>>>;
    /** v789 — Session-Reset: CLI-State löschen + DB-Eintrag entfernen. */
    resetSession?: (sandboxId: string, agentName: string) => Promise<{ ok: boolean; reason?: string }>;
    /** v791 — Alle Events einer Session für Replay-UI. */
    listEventsForSession?: (sessionId: string, limit?: number) => Promise<Array<Record<string, unknown>>>;
  };
  setAgentSessionCallbacks(cb: {
    listAvailable: () => Array<{ name: string; capabilities: Record<string, unknown> }>;
    listSessionsForSandbox?: (sandboxId: string) => Promise<Array<Record<string, unknown>>>;
    resetSession?: (sandboxId: string, agentName: string) => Promise<{ ok: boolean; reason?: string }>;
    listEventsForSession?: (sessionId: string, limit?: number) => Promise<Array<Record<string, unknown>>>;
  }): void {
    this.agentSessionCallbacks = cb;
  }

  setInsightsCallbacks(opts: {
    list: (filter?: { category?: string; status?: string; limit?: number }) => Promise<any[]>;
    dismiss: (id: string) => Promise<void>;
    snooze: (id: string, hours: number) => Promise<void>;
    /** v928 — params: User-Eingaben für Aktionen mit inputFields ({{key}}-Platzhalter). */
    act: (id: string, params?: Record<string, unknown>) => Promise<{ ok: boolean; result?: any; reason?: string }>;
    sweep: () => Promise<{ inserted: number; refreshed: number; perAdapter: Record<string, number>; errors: string[] }>;
    stats: () => Promise<Record<string, number>>;
    dismissCategory?: (category: string) => Promise<number>;
    /** v928 — Kategorie-Mute („solche nicht mehr"). */
    muteCategory?: (category: string, muted: boolean) => Promise<void>;
    listMutedCategories?: () => Promise<string[]>;
  }): void {
    this.insightsListFn = opts.list;
    this.insightsDismissFn = opts.dismiss;
    this.insightsSnoozeFn = opts.snooze;
    this.insightsActFn = opts.act;
    this.insightsSweepFn = opts.sweep;
    this.insightsStatsFn = opts.stats;
    this.insightsDismissCategoryFn = opts.dismissCategory;
    this.insightsMuteCategoryFn = opts.muteCategory;
    this.insightsListMutedFn = opts.listMutedCategories;
  }

  // v930 — Interessen-Radar-API (Themen/Quellen/Items) + Router-Einstellungen
  private interestsCallbacks?: {
    listTopics: () => Promise<any[]>;
    createTopic: (data: { name: string; keywords?: string[] }) => Promise<any>;
    updateTopic: (id: string, patch: { status?: string; notifyThreshold?: string; keywords?: string[] }) => Promise<{ ok: boolean; reason?: string }>;
    addSource: (topicId: string, data: { kind: string; url?: string; query?: string }) => Promise<{ ok: boolean; source?: any; reason?: string }>;
    removeSource: (topicId: string, sourceId: string) => Promise<boolean>;
    listItems: (topicId: string, limit?: number) => Promise<any[]>;
    collectNow: (topicId?: string) => Promise<number>;
    getNotificationSettings: () => Promise<Record<string, unknown>>;
    setNotificationSettings: (patch: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };

  setInterestsCallbacks(cb: NonNullable<HttpAdapter['interestsCallbacks']>): void {
    this.interestsCallbacks = cb;
  }

  // v934/v937 — Social: Kanäle, Content-Kalender, Items, Aktionen, Metriken
  private socialCallbacks?: {
    listChannels: () => Promise<any[]>;
    calendar: (fromIso: string, toIso: string) => Promise<any[]>;
    /** v937 */
    updateChannel?: (id: string, patch: Record<string, unknown>) => Promise<{ success: boolean; error?: string }>;
    pauseAll?: () => Promise<number>;
    listItems?: (filter: { channelId?: string; status?: string; limit?: number }) => Promise<any[]>;
    itemAction?: (id: string, action: 'approve' | 'reject' | 'publish' | 'schedule', extra?: Record<string, unknown>) => Promise<{ success: boolean; display?: string; error?: string }>;
    channelMetrics?: (channelId: string) => Promise<any[]>;
  };

  setSocialCallbacks(cb: NonNullable<HttpAdapter['socialCallbacks']>): void {
    this.socialCallbacks = cb;
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
    /** v847 — Chat-Action-Tracking: Liste pro Projekt */
    listChatActions?: (id: string, limit: number) => Promise<Array<Record<string, unknown>>>;
    /** v847 — Chat-Action-Detail */
    getChatAction?: (actionId: string) => Promise<Record<string, unknown> | null>;
    /** v851 — Liste der Features pro Projekt (status-filterbar). */
    listProjectFeatures?: (projectId: string, opts?: { status?: string }) => Promise<Array<Record<string, unknown>>>;
    /** v851 — Cross-Project-Suche im Feature-Library (visibility-respektiert). */
    searchFeatures?: (query: string, limit: number) => Promise<Array<Record<string, unknown>>>;
    /** v851 — Visibility eines Features ändern (manuell role-shared aktivieren). */
    setFeatureVisibility?: (featureId: string, visibility: string) => Promise<boolean>;
    /** v851 — Pending Feature confirmen (status=confirmed) oder rejecten. */
    confirmFeature?: (featureId: string, action: 'confirm' | 'reject') => Promise<boolean>;
    /** v851 — Feature retiren. */
    retireFeature?: (featureId: string, reason?: string) => Promise<boolean>;
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
    /** v704 — Erweitert: status + title + description. Status-only bleibt rückwärtskompatibel.
     *  v875 — depends_on: Item-Abhängigkeiten (Array von Item-IDs; null/[] löscht). */
    updateOpenItem: (itemId: string, patch: { status?: string; title?: string; description?: string | null; depends_on?: string[] | null }) => Promise<boolean>;
    /** v815 P1 — manuelle Decision-Erstellung (vorher nur via Session-Summary). */
    addDecision?: (projectId: string, input: { title: string; choice: string; rationale?: string }) => Promise<any | null>;
    listHealthLog: (id: string, limit: number) => Promise<any[]>;
    // v641 — Bulk-Work + Audit
    workOnOpenItems?: (projectId: string, itemIds: string[], maxItems: number) => Promise<{ ok: boolean; taskId?: string; mode?: string; liveTaskId?: string; reason?: string }>;
    /** v870 — Deep-Verify: read-only Codebase-Prüfung markierter/aller Items. */
    deepVerifyItems?: (projectId: string, itemIds: string[] | undefined, maxItems: number) => Promise<{ ok: boolean; liveTaskId?: string; itemCount?: number; skippedForCap?: number; reason?: string }>;
    deepVerifyResult?: (taskId: string) => Promise<Record<string, unknown> | null>;
    /** v872 — Repo-Status-Karte: frischer Git-Zustand (branch/sha/dirty/ahead/behind) on-demand. */
    repoStatus?: (projectId: string) => Promise<Record<string, unknown>>;
    /** v872 — CI-Pipeline-Status des aktuellen Branches je konfiguriertem Forge-Provider. */
    pipelineStatus?: (projectId: string) => Promise<{ pipelines: Array<{ provider: string; state: string; url?: string; ref: string }>; reason?: string }>;
    /** v874 — offene MRs/PRs des Projekts je konfiguriertem Forge-Provider. */
    listMergeRequests?: (projectId: string) => Promise<{ mergeRequests: Array<Record<string, unknown>>; reason?: string }>;
    /** v875 — Wochen-Budget-Status (Soft-Budget + CLI-Kosten der letzten 7 Tage). */
    budgetStatus?: (projectId: string) => Promise<{ budgetWeeklyUsd: number | null; spent7dUsd: number; error?: string }>;
    /** v873 — Docs-Tab: Markdown-Dateien des Projekt-CWDs auflisten/lesen (traversal-sicher). */
    listDocs?: (projectId: string) => Promise<{ files: Array<{ path: string; sizeBytes: number; modifiedAt: string }>; error?: string }>;
    readDoc?: (projectId: string, relPath: string) => Promise<Record<string, unknown>>;
    /** v873 — Dependency-Panel: strukturierte Outdated-Liste + Update-Lauf (async Code-Agent). */
    depsStatus?: (projectId: string) => Promise<Record<string, unknown>>;
    updateDependencies?: (projectId: string, packages?: string[]) => Promise<{ ok: boolean; liveTaskId?: string; reason?: string }>;
    /** v879 — Codebase-Review (read-only, optional Gegenprüfung durch andere CLI-Agents). */
    reviewCodebase?: (projectId: string, opts?: { scope?: string; reviewAgent?: string; crossCheckAgents?: string[] }) => Promise<{ ok: boolean; liveTaskId?: string; reason?: string }>;
    reviewResult?: (taskId: string) => Promise<Record<string, unknown> | null>;
    listCodeAgents?: () => Promise<{ agents: string[] }>;
    /** v889b — laufende CLI-Agents (für Busy-Badge). */
    agentBusy?: () => Promise<{ busy: Array<{ cli: string; projectId: string; kind: string }> }>;
    /** v880 — Feature-Discovery: Vorschläge generieren, Entscheidung pro Vorschlag (reject→Library, accept→Plan-Lauf). */
    suggestFeatures?: (projectId: string, opts?: { focus?: string; agents?: string[] }) => Promise<{ ok: boolean; liveTaskId?: string; reason?: string }>;
    suggestResult?: (taskId: string) => Promise<Record<string, unknown> | null>;
    featureDecision?: (projectId: string, opts: { title: string; description?: string; decision: 'accept' | 'reject'; agent?: string }) => Promise<{ ok: boolean; liveTaskId?: string; reason?: string }>;
    // v897 — mehrere Facetten zu EINEM konsolidierten Plan/Milestone
    planFeaturesCombined?: (projectId: string, opts: { features: Array<{ title: string; description?: string }>; name?: string; agent?: string }) => Promise<{ ok: boolean; liveTaskId?: string; reason?: string }>;
    // v898 — bestehende Roadmap-Milestones nachträglich zu EINEM Feature zusammenführen (Re-Tag)
    consolidateMilestones?: (projectId: string, opts: { milestones: string[]; name?: string; agent?: string; withPlan?: boolean }) => Promise<{ ok: boolean; liveTaskId?: string; milestone?: string; retagged?: number; planned?: boolean; reason?: string }>;
    auditOpenItems?: (projectId: string) => Promise<{ data?: any; display?: string }>;
    // v642 — Bulk-Close
    bulkCloseItems?: (projectId: string, itemIds: string[]) => Promise<{ closed: number; failed: string[] }>;
    // v643 — Commits per Project + per Session
    listProjectCommits?: (projectId: string, limit: number) => Promise<any[]>;
    listSessionCommits?: (sessionId: string) => Promise<any[]>;
    // v742 — Re-Match Open-Items gegen letzten Session-Lauf
    reMatchOpenItems?: (projectId: string) => Promise<{ ok: boolean; matched?: number; resolved?: number; considered?: number; candidates?: number; filesUsed?: number; reason?: string }>;
    // v824 — Agent-Conventions (CLAUDE.md/AGENTS.md) Phase 1 vollständig
    conventionsStatus?: (projectId: string, packagePath?: string) => Promise<{ ok: boolean; data?: unknown; reason?: string }>;
    conventionsGenerate?: (projectId: string, opts: { packagePath?: string; language?: 'de' | 'en'; tier?: 'fast' | 'default' | 'strong' }) => Promise<{ ok: boolean; data?: unknown; reason?: string }>;
    conventionsApply?: (projectId: string, opts: { packagePath?: string; content?: string; commitToGit?: boolean; outputs?: string[] }) => Promise<{ ok: boolean; data?: unknown; reason?: string }>;
    conventionsRefresh?: (projectId: string, opts: { packagePath?: string; language?: 'de' | 'en' }) => Promise<{ ok: boolean; data?: unknown; reason?: string }>;
    conventionsDriftCheck?: (projectId: string, packagePath?: string) => Promise<{ ok: boolean; data?: unknown; reason?: string }>;
    conventionsHistory?: (projectId: string, packagePath?: string) => Promise<{ ok: boolean; data?: unknown; reason?: string }>;
    conventionsRollback?: (projectId: string, historyId: string, packagePath?: string) => Promise<{ ok: boolean; data?: unknown; reason?: string }>;
    conventionsListLessons?: (projectId: string, packagePath?: string) => Promise<{ ok: boolean; data?: unknown; reason?: string }>;
    conventionsConsolidateLessons?: (projectId: string, packagePath?: string) => Promise<{ ok: boolean; data?: unknown; reason?: string }>;
    conventionsListPackages?: (projectId: string) => Promise<{ ok: boolean; data?: unknown; reason?: string }>;
    conventionsGenerateAllPackages?: (projectId: string) => Promise<{ ok: boolean; data?: unknown; reason?: string }>;
    conventionsEffectiveness?: (projectId: string) => Promise<{ ok: boolean; data?: unknown; reason?: string }>;
    conventionsSectionHealth?: (projectId: string) => Promise<{ ok: boolean; data?: unknown; reason?: string }>;
    conventionsGlobalPatterns?: () => Promise<{ ok: boolean; data?: unknown; reason?: string }>;
    conventionsGetConfigOverrides?: (projectId: string) => Promise<{ ok: boolean; data?: unknown; reason?: string }>;
    conventionsSetConfigOverrides?: (projectId: string, overrides: Record<string, unknown>) => Promise<{ ok: boolean; data?: unknown; reason?: string }>;
    // v797 — Manueller Health-Check-Trigger statt 6h-Schedule warten
    triggerHealthCheck?: (projectId: string) => Promise<{ ok: boolean; probes?: Array<{ probe: string; status: string; details?: string }>; reason?: string }>;
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
  /** v866 — CLI-Agent-Usage-Übersicht (eigene Subscriptions/Keys, getrennt von llm_usage). */
  private cliUsageCallback?: (days?: number) => Promise<Record<string, unknown> | null>;

  setLogCallbacks(cbs: typeof HttpAdapter.prototype.logCallbacks): void { this.logCallbacks = cbs; }
  setClusterCallbacks(cbs: typeof HttpAdapter.prototype.clusterCallbacks): void { this.clusterCallbacks = cbs; }
  setCliUsageCallback(cb: typeof HttpAdapter.prototype.cliUsageCallback): void { this.cliUsageCallback = cb; }

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

  /**
   * v847 — strukturiertes Progress-Event mit kind/tool/durationMs.
   * Die UI kann damit eine richtige Timeline rendern statt der pre-v847
   * "Thinking..."-Überschreibung. Adapter exposed via writeProgressEvent
   * weil Alfred via duck-typing prüft ob diese Methode existiert.
   */
  async writeProgressEvent(chatId: string, evt: unknown): Promise<void> {
    const res = this.streams.get(chatId);
    if (res) {
      this.writeSseEvent(res, 'progress', { type: 'progress', ...(typeof evt === 'object' && evt !== null ? evt : {}) });
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
    } else if (url.pathname === '/api/insights/mute-category' && req.method === 'POST') {
      this.handleInsightsMuteCategory(req, res).catch(err => this.safeError(res, err));
    } else if (url.pathname === '/api/insights/muted' && req.method === 'GET') {
      this.handleInsightsListMuted(req, res).catch(err => this.safeError(res, err));
    // ── v930 — Interessen-Radar ──
    } else if (url.pathname === '/api/interests/topics' && req.method === 'GET') {
      this.handleInterests(req, res, () => this.interestsCallbacks!.listTopics().then(topics => ({ topics }))).catch(err => this.safeError(res, err));
    } else if (url.pathname === '/api/interests/topics' && req.method === 'POST') {
      this.handleInterestsCreateTopic(req, res).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/interests\/topics\/[^/]+$/) && req.method === 'PATCH') {
      this.handleInterestsUpdateTopic(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/interests\/topics\/[^/]+\/sources$/) && req.method === 'POST') {
      this.handleInterestsAddSource(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/interests\/topics\/[^/]+\/sources\/[^/]+$/) && req.method === 'DELETE') {
      this.handleInterestsRemoveSource(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/interests\/topics\/[^/]+\/items$/) && req.method === 'GET') {
      this.handleInterestsListItems(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname === '/api/interests/collect' && req.method === 'POST') {
      this.handleInterestsCollect(req, res).catch(err => this.safeError(res, err));
    // ── v934/v937 — Social ──
    } else if (url.pathname === '/api/social/channels' && req.method === 'GET') {
      this.handleSocial(req, res, () => this.socialCallbacks!.listChannels().then(channels => ({ channels }))).catch(err => this.safeError(res, err));
    } else if (url.pathname === '/api/social/calendar' && req.method === 'GET') {
      this.handleSocial(req, res, () => {
        const from = url.searchParams.get('from') ?? new Date().toISOString();
        const to = url.searchParams.get('to') ?? new Date(Date.now() + 14 * 24 * 3_600_000).toISOString();
        return this.socialCallbacks!.calendar(from, to).then(items => ({ items, from, to }));
      }).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/social\/channels\/[^/]+$/) && req.method === 'PATCH') {
      this.handleSocialBody(req, res, async (body) => {
        if (!this.socialCallbacks?.updateChannel) return { error: 'not supported' };
        return this.socialCallbacks.updateChannel(url.pathname.split('/')[4], body);
      }).catch(err => this.safeError(res, err));
    } else if (url.pathname === '/api/social/pause-all' && req.method === 'POST') {
      this.handleSocial(req, res, async () => ({ paused: await this.socialCallbacks!.pauseAll?.() ?? 0 })).catch(err => this.safeError(res, err));
    } else if (url.pathname === '/api/social/items' && req.method === 'GET') {
      this.handleSocial(req, res, async () => ({
        items: await this.socialCallbacks!.listItems?.({
          channelId: url.searchParams.get('channel') ?? undefined,
          status: url.searchParams.get('status') ?? undefined,
          limit: Number(url.searchParams.get('limit') ?? 100),
        }) ?? [],
      })).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/social\/items\/[^/]+\/(approve|reject|publish|schedule)$/) && req.method === 'POST') {
      this.handleSocialBody(req, res, async (body) => {
        const parts = url.pathname.split('/');
        if (!this.socialCallbacks?.itemAction) return { error: 'not supported' };
        return this.socialCallbacks.itemAction(parts[4], parts[5] as 'approve' | 'reject' | 'publish' | 'schedule', body);
      }).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/social\/channels\/[^/]+\/metrics$/) && req.method === 'GET') {
      this.handleSocial(req, res, async () => ({
        metrics: await this.socialCallbacks!.channelMetrics?.(url.pathname.split('/')[4]) ?? [],
      })).catch(err => this.safeError(res, err));
    } else if (url.pathname === '/api/notifications/settings' && req.method === 'GET') {
      this.handleInterests(req, res, () => this.interestsCallbacks!.getNotificationSettings()).catch(err => this.safeError(res, err));
    } else if (url.pathname === '/api/notifications/settings' && req.method === 'POST') {
      this.handleNotificationSettingsUpdate(req, res).catch(err => this.safeError(res, err));
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
    } else if (url.pathname.match(/^\/api\/sandbox\/[^/]+\/chat\/stop$/) && req.method === 'POST') {
      this.handleSandboxChatStop(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/sandbox\/[^/]+\/chat\/resume$/) && req.method === 'POST') {
      this.handleSandboxChatResume(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname === '/api/agent-session/adapters' && req.method === 'GET') {
      this.handleAgentSessionAdapters(req, res).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/agent-session\/sessions\/[^/]+$/) && req.method === 'GET') {
      this.handleAgentSessionStats(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/agent-session\/sessions\/[^/]+\/[^/]+$/) && req.method === 'DELETE') {
      this.handleAgentSessionReset(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/agent-session\/events\/[^/]+$/) && req.method === 'GET') {
      this.handleAgentSessionEvents(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/environments$/) && req.method === 'GET') {
      this.handleEnvironmentsList(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/environments\/scan$/) && req.method === 'GET') {
      this.handleEnvironmentsScan(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/environments\/[^/]+$/) && req.method === 'GET') {
      this.handleEnvironmentsGet(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/environments\/[^/]+$/) && req.method === 'PUT') {
      this.handleEnvironmentsPut(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/environments\/[^/]+$/) && req.method === 'DELETE') {
      this.handleEnvironmentsDelete(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/db-seeds$/) && req.method === 'GET') {
      this.handleDbSeedsList(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/db-seeds$/) && req.method === 'POST') {
      this.handleDbSeedsUpload(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/db-seeds\/repo-path$/) && req.method === 'POST') {
      this.handleDbSeedsRegisterRepoPath(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/db-seeds\/default$/) && req.method === 'PUT') {
      this.handleDbSeedsSetDefault(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/db-seeds\/[^/]+$/) && req.method === 'DELETE') {
      this.handleDbSeedsDelete(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/re-match-open-items$/) && req.method === 'POST') {
      this.handleProjectsReMatchOpenItems(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/health-check$/) && req.method === 'POST') {
      this.handleProjectsHealthCheck(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/conventions\/status$/) && req.method === 'GET') {
      this.handleConventionsStatus(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/conventions\/generate$/) && req.method === 'POST') {
      this.handleConventionsGenerate(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/conventions\/apply$/) && req.method === 'POST') {
      this.handleConventionsApply(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/conventions\/refresh$/) && req.method === 'POST') {
      this.handleConventionsRefresh(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/conventions\/drift-check$/) && req.method === 'POST') {
      this.handleConventionsDriftCheck(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/conventions\/history$/) && req.method === 'GET') {
      this.handleConventionsHistory(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/conventions\/rollback$/) && req.method === 'POST') {
      this.handleConventionsRollback(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/conventions\/lessons$/) && req.method === 'GET') {
      this.handleConventionsListLessons(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/conventions\/consolidate-lessons$/) && req.method === 'POST') {
      this.handleConventionsConsolidateLessons(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/conventions\/packages$/) && req.method === 'GET') {
      this.handleConventionsListPackages(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/conventions\/generate-all-packages$/) && req.method === 'POST') {
      this.handleConventionsGenerateAllPackages(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/conventions\/effectiveness$/) && req.method === 'GET') {
      this.handleConventionsEffectiveness(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/conventions\/section-health$/) && req.method === 'GET') {
      this.handleConventionsSectionHealth(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname === '/api/conventions/patterns' && req.method === 'GET') {
      this.handleConventionsGlobalPatterns(req, res).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/conventions\/config-overrides$/) && req.method === 'GET') {
      this.handleConventionsGetConfigOverrides(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/conventions\/config-overrides$/) && req.method === 'PUT') {
      this.handleConventionsSetConfigOverrides(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname === '/api/sandbox-templates' && req.method === 'GET') {
      this.handleSandboxTemplatesList(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname === '/api/sandbox-templates' && req.method === 'POST') {
      this.handleSandboxTemplatesCreate(req, res).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/sandbox-templates\/[^/]+$/) && req.method === 'PATCH') {
      this.handleSandboxTemplatesUpdate(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/sandbox-templates\/[^/]+$/) && req.method === 'DELETE') {
      this.handleSandboxTemplatesDelete(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/sandbox\/[^/]+\/restart$/) && req.method === 'POST') {
      this.handleSandboxRestart(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/sandbox\/[^/]+\/force-fail$/) && req.method === 'POST') {
      this.handleSandboxForceFail(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/sandbox\/[^/]+\/logs$/) && req.method === 'GET') {
      this.handleSandboxLogs(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/sandbox\/[^/]+\/stats$/) && req.method === 'GET') {
      this.handleSandboxStats(req, res, url).catch(err => this.safeError(res, err));
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
    // v764 — Project-Wizard (Bootstrap-LLM-Hilfe)
    } else if (url.pathname === '/api/projects/wizard/suggest-stack' && req.method === 'POST') {
      this.handleProjectWizardSuggestStack(req, res).catch(err => this.safeError(res, err));
    } else if (url.pathname === '/api/projects/wizard/generate-plan' && req.method === 'POST') {
      this.handleProjectWizardGeneratePlan(req, res).catch(err => this.safeError(res, err));
    } else if (url.pathname === '/api/projects/wizard/validate' && req.method === 'POST') {
      this.handleProjectWizardValidate(req, res).catch(err => this.safeError(res, err));
    } else if (url.pathname === '/api/projects/wizard/create' && req.method === 'POST') {
      this.handleProjectWizardCreate(req, res).catch(err => this.safeError(res, err));
    // v675 — Spezifische Routes MÜSSEN vor der generic /api/projects/:id Route stehen,
    // sonst matched die generic Route und interpretiert z.B. "automation-templates" als Projekt-ID.
    } else if (url.pathname === '/api/projects/automation-templates' && req.method === 'GET') {
      this.handleAutomationTemplates(req, res).catch(err => this.safeError(res, err));
    } else if (url.pathname === '/api/projects/agent-busy' && req.method === 'GET') {
      // v889b — laufende CLI-Agents (Busy-Badge). Vor generic :id-Route.
      this.handleProjectsAgentBusy(req, res).catch(err => this.safeError(res, err));
    } else if (url.pathname === '/api/projects/code-agents' && req.method === 'GET') {
      // v879 — verfügbare CLI-Agents (für Agent-Auswahl im Review-Dialog).
      // MUSS vor der generic :id-Route stehen (sonst "code-agents" = Projekt-ID).
      this.handleProjectsCodeAgents(req, res).catch(err => this.safeError(res, err));
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
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/decisions$/) && req.method === 'POST') {
      // v815 P1 — manuelle Decision-Erstellung
      this.handleProjectsAddDecision(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/health-log$/) && req.method === 'GET') {
      this.handleProjectsHealthLog(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/repo-status$/) && req.method === 'GET') {
      // v872 — Repo-Status-Karte (on-demand, nicht 6h-Health-Cache)
      this.handleProjectsRepoStatus(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/pipeline-status$/) && req.method === 'GET') {
      // v872 — CI-Pipeline-Badge (Forge-API)
      this.handleProjectsPipelineStatus(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/merge-requests$/) && req.method === 'GET') {
      // v874 — offene MRs/PRs (Forge-API)
      this.handleProjectsMergeRequests(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/budget$/) && req.method === 'GET') {
      // v875 — Wochen-Budget-Status (Soft-Budget)
      this.handleProjectsBudget(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/docs$/) && req.method === 'GET') {
      // v873 — Docs-Tab: Markdown-Liste
      this.handleProjectsListDocs(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/docs\/content$/) && req.method === 'GET') {
      // v873 — Docs-Tab: Datei-Inhalt (?path=…)
      this.handleProjectsReadDoc(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/deps-status$/) && req.method === 'GET') {
      // v873 — Dependency-Panel: strukturierte Outdated-Liste
      this.handleProjectsDepsStatus(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/update-deps$/) && req.method === 'POST') {
      // v873 — Dependency-Update-Lauf (async Code-Agent)
      this.handleProjectsUpdateDeps(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/review$/) && req.method === 'POST') {
      // v879 — Codebase-Review (async, optional Gegenprüfung)
      this.handleProjectsReview(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/review\/[^/]+\/result$/) && req.method === 'GET') {
      this.handleProjectsReviewResult(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/suggest-features$/) && req.method === 'POST') {
      // v880 — Feature-Discovery (async)
      this.handleProjectsSuggestFeatures(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/suggest\/[^/]+\/result$/) && req.method === 'GET') {
      this.handleProjectsSuggestResult(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/feature-decision$/) && req.method === 'POST') {
      // v880 — Annehmen (→ Plan-Lauf) / Ablehnen (→ Library rejected)
      this.handleProjectsFeatureDecision(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/plan-features-combined$/) && req.method === 'POST') {
      // v897 — mehrere Facetten → EIN konsolidierter Plan
      this.handleProjectsPlanFeaturesCombined(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/consolidate-milestones$/) && req.method === 'POST') {
      // v898 — bestehende Milestones → EIN Feature (Re-Tag)
      this.handleProjectsConsolidateMilestones(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/work-on-items$/) && req.method === 'POST') {
      this.handleProjectsWorkOnItems(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/deep-verify$/) && req.method === 'POST') {
      // v870 — read-only Codebase-Prüfung offener Items
      this.handleProjectsDeepVerify(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/deep-verify\/[^/]+\/result$/) && req.method === 'GET') {
      this.handleProjectsDeepVerifyResult(req, res, url).catch(err => this.safeError(res, err));
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
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/chat-actions$/) && req.method === 'GET') {
      this.handleProjectsChatActions(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/chat-actions\/[^/]+$/) && req.method === 'GET') {
      this.handleChatActionDetail(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/projects\/[^/]+\/features$/) && req.method === 'GET') {
      this.handleProjectFeaturesList(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname === '/api/features/search' && req.method === 'GET') {
      this.handleFeaturesSearch(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/features\/[^/]+\/visibility$/) && req.method === 'PATCH') {
      this.handleFeatureVisibility(req, res, url).catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/features\/[^/]+\/confirm$/) && req.method === 'POST') {
      this.handleFeatureConfirm(req, res, url, 'confirm').catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/features\/[^/]+\/reject$/) && req.method === 'POST') {
      this.handleFeatureConfirm(req, res, url, 'reject').catch(err => this.safeError(res, err));
    } else if (url.pathname.match(/^\/api\/features\/[^/]+$/) && req.method === 'DELETE') {
      this.handleFeatureRetire(req, res, url).catch(err => this.safeError(res, err));
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
    } else if (url.pathname === '/api/cli-usage' && req.method === 'GET') {
      // v866 — CLI-Agent-Usage (eigene Subscriptions/Keys, getrennt von llm_usage)
      this.handleCliUsage(req, res, url).catch(err => this.safeError(res, err));
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
        // v922 — vorher Stub: las svc.dependencyMap.downstream, ein Feld das nie
        // befüllt wurde → Impact war immer leer. Downstream-Dependents werden jetzt
        // real berechnet: alle Services, deren dependencies diesen Service referenzieren.
        const all = await cbs.listServices(userId);
        const dependents = (all || []).filter((s: any) =>
          s.id !== svc.id && Array.isArray(s.dependencies) &&
          s.dependencies.some((d: string) => d === svc.id || d?.toLowerCase?.() === String(svc.name).toLowerCase()),
        ).map((s: any) => ({ id: s.id, name: s.name, criticality: s.criticality }));
        return { service: svc.name, impact: dependents, failureModes: svc.failureModes || [] };
      });
    } else if (url.pathname.match(/^\/api\/services\/[^/]+\/components\/[^/]+$/) && req.method === 'DELETE') {
      // v922 — Components per UI editierbar (gleiches Muster wie failure-modes)
      const cparts = url.pathname.split('/');
      const csvcId = cparts[3];
      const compName = decodeURIComponent(cparts[5]);
      this.handleItsmRoute(req, res, async (cbs, userId) => {
        const svc = await cbs.getService(userId, csvcId);
        if (!svc) return { error: 'Service not found' };
        svc.components = (svc.components || []).filter((c: any) => c.name !== compName);
        return cbs.updateService(userId, csvcId, { components: svc.components });
      });
    } else if (url.pathname.match(/^\/api\/services\/[^/]+\/components$/) && req.method === 'POST') {
      const csvcId = url.pathname.split('/')[3];
      this.handleItsmBodyRoute(req, res, async (cbs, userId, body) => {
        const svc = await cbs.getService(userId, csvcId);
        if (!svc) return { error: 'Service not found' };
        const comps = svc.components || [];
        comps.push(body);
        return cbs.updateService(userId, csvcId, { components: comps });
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
    } else if (url.pathname === '/api/itsm/analytics' && req.method === 'GET') {
      // v922 — Analytics-Aktionen des ITSM-Skills für die Web-UI (vorher chat-only).
      // Whitelist-Map: nur diese read-only Aktionen sind über HTTP erreichbar.
      const ANALYTICS_KINDS: Record<string, string> = {
        mttr: 'mttr_report', capacity: 'capacity_forecast', health: 'service_health_score',
        cascades: 'list_cascades', breach_risk: 'sla_breach_risk', pir: 'pir_pending',
      };
      const kind = url.searchParams.get('kind') ?? '';
      const action = ANALYTICS_KINDS[kind];
      if (!action) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Unknown analytics kind: ${kind}. Valid: ${Object.keys(ANALYTICS_KINDS).join(', ')}` }));
      } else {
        this.handleItsmRoute(req, res, (cbs, userId) => {
          if (!cbs.skillAction) return Promise.resolve({ error: 'analytics not wired' });
          return cbs.skillAction(userId, action, {});
        });
      }
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

    // v782 — Falls Event-Subscriber verfügbar: zusätzlich strukturierte AgentEvents streamen
    let eventSub: { history: Array<{ ts: number; type: string; data: unknown }>; unsubscribe: () => void } | null = null;
    if (this.projectAgentsSubscribeEventsFn) {
      try {
        eventSub = this.projectAgentsSubscribeEventsFn(taskId, (entry) => send('event', entry));
      } catch { /* */ }
    }

    // Replay history first (lines + events)
    send('history', { lines: sub.history });
    if (eventSub) {
      send('history-events', { events: eventSub.history });
    }

    // Heartbeat every 25s so proxies don't close the connection
    const heartbeat = setInterval(() => {
      try { res.write(`:hb\n\n`); } catch { /* gone */ }
    }, 25_000);

    const cleanup = () => {
      clearInterval(heartbeat);
      try { sub.unsubscribe(); } catch { /* ignore */ }
      if (eventSub) try { eventSub.unsubscribe(); } catch { /* ignore */ }
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
    // v928 — optionaler Body {params: {...}} mit User-Eingaben für inputFields
    let params: Record<string, unknown> | undefined;
    const body = await this.readBody(req);
    if (body) {
      try {
        const parsed = JSON.parse(body);
        if (parsed && typeof parsed.params === 'object' && parsed.params !== null) params = parsed.params;
      } catch { /* kein/kaputter Body → wie bisher ohne params */ }
    }
    const result = await this.insightsActFn(id, params);
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  // v928 — Kategorie-Mute („solche Insights nicht mehr")
  private async handleInsightsMuteCategory(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.insightsMuteCategoryFn) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const body = await this.readBody(req);
    let category = ''; let muted = true;
    try {
      const parsed = JSON.parse(body);
      category = String(parsed.category ?? '');
      muted = parsed.muted !== false;
    } catch { /* invalid */ }
    if (!category) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'category required' })); return; }
    await this.insightsMuteCategoryFn(category, muted);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, category, muted }));
  }

  private async handleInsightsListMuted(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.insightsListMutedFn) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const muted = await this.insightsListMutedFn();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ muted }));
  }

  // ── v930 — Interessen-Radar-Handler ──────────────────────────────────

  /** Gemeinsamer Wrapper: Auth + Callback-Check + JSON-Antwort. */
  private async handleInterests(req: http.IncomingMessage, res: http.ServerResponse, fn: () => Promise<unknown>): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.interestsCallbacks) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const result = await fn();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  /** v934 — Social-Wrapper (gleiches Muster). */
  private async handleSocial(req: http.IncomingMessage, res: http.ServerResponse, fn: () => Promise<unknown>): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.socialCallbacks) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const result = await fn();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  /** v937 — Social-Wrapper mit JSON-Body; success:false → HTTP 400. */
  private async handleSocialBody(req: http.IncomingMessage, res: http.ServerResponse, fn: (body: Record<string, unknown>) => Promise<Record<string, unknown>>): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.socialCallbacks) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    let body: Record<string, unknown> = {};
    try { const raw = await this.readBody(req); if (raw) body = JSON.parse(raw); } catch { /* leerer Body ok */ }
    const result = await fn(body);
    const failed = result.success === false || typeof result.error === 'string';
    res.writeHead(failed ? 400 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  private async handleInterestsCreateTopic(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.interestsCallbacks) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const body = await this.readBody(req);
    let data: { name?: string; keywords?: string[] } = {};
    try { data = JSON.parse(body); } catch { /* invalid */ }
    if (!data.name || typeof data.name !== 'string') { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'name required' })); return; }
    const topic = await this.interestsCallbacks.createTopic({ name: data.name, keywords: Array.isArray(data.keywords) ? data.keywords.map(String) : undefined });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ topic }));
  }

  private async handleInterestsUpdateTopic(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.interestsCallbacks) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const id = url.pathname.split('/')[4];
    const body = await this.readBody(req);
    let patch: Record<string, unknown> = {};
    try { patch = JSON.parse(body); } catch { /* invalid */ }
    const r = await this.interestsCallbacks.updateTopic(id, {
      status: typeof patch.status === 'string' ? patch.status : undefined,
      notifyThreshold: typeof patch.notifyThreshold === 'string' ? patch.notifyThreshold : undefined,
      keywords: Array.isArray(patch.keywords) ? patch.keywords.map(String) : undefined,
    });
    res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
  }

  private async handleInterestsAddSource(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.interestsCallbacks) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const topicId = url.pathname.split('/')[4];
    const body = await this.readBody(req);
    let data: { kind?: string; url?: string; query?: string } = {};
    try { data = JSON.parse(body); } catch { /* invalid */ }
    if (data.kind !== 'rss' && data.kind !== 'web_search') { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'kind must be rss|web_search' })); return; }
    const r = await this.interestsCallbacks.addSource(topicId, { kind: data.kind, url: data.url, query: data.query });
    res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
  }

  private async handleInterestsRemoveSource(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.interestsCallbacks) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const parts = url.pathname.split('/');
    const removed = await this.interestsCallbacks.removeSource(parts[4], parts[6]);
    res.writeHead(removed ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: removed }));
  }

  private async handleInterestsListItems(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.interestsCallbacks) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const topicId = url.pathname.split('/')[4];
    const limit = Number(url.searchParams.get('limit') ?? 30);
    const items = await this.interestsCallbacks.listItems(topicId, Number.isFinite(limit) ? limit : 30);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ items }));
  }

  private async handleInterestsCollect(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.interestsCallbacks) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const body = await this.readBody(req);
    let topicId: string | undefined;
    try { const p = JSON.parse(body); if (typeof p.topicId === 'string') topicId = p.topicId; } catch { /* alle */ }
    const newItems = await this.interestsCallbacks.collectNow(topicId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, newItems }));
  }

  private async handleNotificationSettingsUpdate(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.interestsCallbacks) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const body = await this.readBody(req);
    let patch: Record<string, unknown> = {};
    try { patch = JSON.parse(body); } catch { /* invalid */ }
    const settings = await this.interestsCallbacks.setNotificationSettings(patch);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(settings));
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

  // v764 — Project-Wizard Endpoints
  private async handleProjectWizardSuggestStack(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectWizardCallbacks) { res.writeHead(501, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Wizard nicht konfiguriert' })); return; }
    const body = await this.readBody(req);
    let description = '';
    try { description = String((JSON.parse(body) as Record<string, unknown>).description ?? ''); } catch { /* */ }
    if (!description.trim()) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'description required' })); return; }
    try {
      const result = await this.projectWizardCallbacks.suggestStack(description);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  private async handleProjectWizardGeneratePlan(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectWizardCallbacks) { res.writeHead(501, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Wizard nicht konfiguriert' })); return; }
    const body = await this.readBody(req);
    let description = ''; let stack: ProjectWizardSuggestStackResult | null = null;
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      description = String(parsed.description ?? '');
      stack = (parsed.stack ?? null) as ProjectWizardSuggestStackResult | null;
    } catch { /* */ }
    if (!description.trim() || !stack) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'description + stack required' })); return; }
    try {
      const result = await this.projectWizardCallbacks.generatePlan(description, stack);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  private async handleProjectWizardValidate(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectWizardCallbacks) { res.writeHead(501, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Wizard nicht konfiguriert' })); return; }
    const body = await this.readBody(req);
    let description = ''; let stack: ProjectWizardSuggestStackResult | null = null; let items: ProjectWizardPlanItem[] = [];
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      description = String(parsed.description ?? '');
      stack = (parsed.stack ?? null) as ProjectWizardSuggestStackResult | null;
      items = Array.isArray(parsed.items) ? parsed.items as ProjectWizardPlanItem[] : [];
    } catch { /* */ }
    if (!description.trim() || !stack || items.length === 0) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'description + stack + items required' })); return; }
    try {
      const result = await this.projectWizardCallbacks.validate(description, stack, items);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  private async handleProjectWizardCreate(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectWizardCallbacks) { res.writeHead(501, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Wizard nicht konfiguriert' })); return; }
    const body = await this.readBody(req);
    let input: ProjectWizardCreateInput | null = null;
    try { input = JSON.parse(body) as ProjectWizardCreateInput; } catch { /* */ }
    if (!input || !input.name || !input.description || !input.stack || !Array.isArray(input.items)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'name + description + stack + items required' }));
      return;
    }
    try {
      const result = await this.projectWizardCallbacks.create(input);
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: (err as Error).message }));
    }
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

  /** v815 P1 — manuelle Decision-Erstellung. POST /api/projects/:id/decisions */
  private async handleProjectsAddDecision(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.addDecision) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const parts = url.pathname.split('/');
    const projectId = parts[parts.length - 2];
    const body = await this.readBody(req);
    let input: { title?: string; choice?: string; rationale?: string };
    try { input = JSON.parse(body); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }
    if (!input.title || !input.choice) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'title + choice required' })); return; }
    const decision = await this.projectsCallbacks.addDecision(projectId, { title: input.title, choice: input.choice, rationale: input.rationale });
    if (!decision) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ decision }));
  }

  private async handleProjectsUpdateOpenItem(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return; }
    const itemId = url.pathname.split('/').pop()!;
    const body = await this.readBody(req);
    let patch: { status?: string; title?: string; description?: string | null; depends_on?: string[] | null };
    try { patch = JSON.parse(body); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }
    if (!patch.status && patch.title == null && patch.description === undefined && patch.depends_on === undefined) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'status, title, description oder depends_on required' }));
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

  /** v872 — GET /api/projects/:id/repo-status — frischer Git-Zustand für die Repo-Status-Karte. */
  private async handleProjectsRepoStatus(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.repoStatus) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const parts = url.pathname.split('/');
    const projectId = parts[parts.length - 2];
    const result = await this.projectsCallbacks.repoStatus(projectId);
    res.writeHead('error' in result ? 400 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  /** v872 — GET /api/projects/:id/pipeline-status — CI-Status des aktuellen Branches. */
  private async handleProjectsPipelineStatus(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.pipelineStatus) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const parts = url.pathname.split('/');
    const projectId = parts[parts.length - 2];
    const result = await this.projectsCallbacks.pipelineStatus(projectId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  /** v875 — GET /api/projects/:id/budget — Wochen-Soft-Budget + CLI-Kosten 7d. */
  private async handleProjectsBudget(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.budgetStatus) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const parts = url.pathname.split('/');
    const projectId = parts[parts.length - 2];
    const result = await this.projectsCallbacks.budgetStatus(projectId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  /** v874 — GET /api/projects/:id/merge-requests — offene MRs/PRs je Forge-Provider. */
  private async handleProjectsMergeRequests(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.listMergeRequests) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const parts = url.pathname.split('/');
    const projectId = parts[parts.length - 2];
    const result = await this.projectsCallbacks.listMergeRequests(projectId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  /** v873 — GET /api/projects/:id/docs — Markdown-Dateien des Projekt-CWDs. */
  private async handleProjectsListDocs(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.listDocs) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const parts = url.pathname.split('/');
    const projectId = parts[parts.length - 2];
    const result = await this.projectsCallbacks.listDocs(projectId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  /** v873 — GET /api/projects/:id/docs/content?path=… — Markdown-Inhalt (traversal-sicher im Callback). */
  private async handleProjectsReadDoc(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.readDoc) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const parts = url.pathname.split('/');
    const projectId = parts[parts.length - 3];
    const relPath = url.searchParams.get('path') ?? '';
    const result = await this.projectsCallbacks.readDoc(projectId, relPath);
    res.writeHead('error' in result ? 400 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  /** v873 — GET /api/projects/:id/deps-status — strukturierte Outdated-Dependency-Liste. */
  private async handleProjectsDepsStatus(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.depsStatus) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const parts = url.pathname.split('/');
    const projectId = parts[parts.length - 2];
    const result = await this.projectsCallbacks.depsStatus(projectId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  /** v879 — POST /api/projects/:id/review {scope?, review_agent?, cross_check_agents?} — async Codebase-Review. */
  private async handleProjectsReview(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.reviewCodebase) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const parts = url.pathname.split('/');
    const projectId = parts[parts.length - 2];
    const body = await this.readBody(req);
    let data: { scope?: string; review_agent?: string; cross_check_agents?: string[] };
    try { data = JSON.parse(body); } catch { data = {}; }
    const result = await this.projectsCallbacks.reviewCodebase(projectId, {
      scope: data.scope, reviewAgent: data.review_agent, crossCheckAgents: data.cross_check_agents,
    });
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  /** v879 — GET /api/projects/review/:taskId/result */
  private async handleProjectsReviewResult(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.reviewResult) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const parts = url.pathname.split('/');
    const taskId = parts[parts.length - 2];
    const result = await this.projectsCallbacks.reviewResult(taskId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result ?? { status: 'unknown' }));
  }

  /** v879 — GET /api/projects/code-agents — Namen der konfigurierten CLI-Agents. */
  private async handleProjectsCodeAgents(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.listCodeAgents) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const result = await this.projectsCallbacks.listCodeAgents();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  /** v889b — GET /api/projects/agent-busy — laufende CLI-Agents (Busy-Badge). */
  private async handleProjectsAgentBusy(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.agentBusy) {
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ busy: [] })); return;
    }
    const result = await this.projectsCallbacks.agentBusy();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  /** v880 — POST /api/projects/:id/suggest-features {focus?, agents?} — async Feature-Discovery. */
  private async handleProjectsSuggestFeatures(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.suggestFeatures) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const parts = url.pathname.split('/');
    const projectId = parts[parts.length - 2];
    const body = await this.readBody(req);
    let data: { focus?: string; agents?: string[] };
    try { data = JSON.parse(body); } catch { data = {}; }
    const result = await this.projectsCallbacks.suggestFeatures(projectId, { focus: data.focus, agents: data.agents });
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  /** v880 — GET /api/projects/suggest/:taskId/result */
  private async handleProjectsSuggestResult(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.suggestResult) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const parts = url.pathname.split('/');
    const taskId = parts[parts.length - 2];
    const result = await this.projectsCallbacks.suggestResult(taskId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result ?? { status: 'unknown' }));
  }

  /** v880 — POST /api/projects/:id/feature-decision {title, description?, decision, agent?} */
  private async handleProjectsFeatureDecision(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.featureDecision) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const parts = url.pathname.split('/');
    const projectId = parts[parts.length - 2];
    const body = await this.readBody(req);
    let data: { title?: string; description?: string; decision?: 'accept' | 'reject'; agent?: string };
    try { data = JSON.parse(body); } catch { data = {}; }
    if (!data.title || (data.decision !== 'accept' && data.decision !== 'reject')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'title und decision (accept|reject) erforderlich' }));
      return;
    }
    const result = await this.projectsCallbacks.featureDecision(projectId, {
      title: data.title, description: data.description, decision: data.decision, agent: data.agent,
    });
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  /** v897 — POST /api/projects/:id/plan-features-combined {features:[{title,description}], name?, agent?} */
  private async handleProjectsPlanFeaturesCombined(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.planFeaturesCombined) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const parts = url.pathname.split('/');
    const projectId = parts[parts.length - 2];
    const body = await this.readBody(req);
    let data: { features?: Array<{ title?: string; description?: string }>; name?: string; agent?: string };
    try { data = JSON.parse(body); } catch { data = {}; }
    const features = Array.isArray(data.features)
      ? data.features.filter(f => f && typeof f.title === 'string' && f.title.trim().length > 0).map(f => ({ title: f.title!.trim(), description: f.description }))
      : [];
    if (features.length < 2) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'mindestens 2 Facetten (features[]) erforderlich' }));
      return;
    }
    const result = await this.projectsCallbacks.planFeaturesCombined(projectId, {
      features, name: data.name, agent: data.agent,
    });
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  /** v898 — POST /api/projects/:id/consolidate-milestones {milestones:[string], name?, agent?, withPlan?} */
  private async handleProjectsConsolidateMilestones(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.consolidateMilestones) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const parts = url.pathname.split('/');
    const projectId = parts[parts.length - 2];
    const body = await this.readBody(req);
    let data: { milestones?: unknown; name?: string; agent?: string; withPlan?: boolean };
    try { data = JSON.parse(body); } catch { data = {}; }
    const milestones = Array.isArray(data.milestones)
      ? data.milestones.filter((m): m is string => typeof m === 'string' && m.trim().length > 0).map(m => m.trim())
      : [];
    if (milestones.length < 1) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'mindestens 1 Milestone erforderlich' }));
      return;
    }
    const result = await this.projectsCallbacks.consolidateMilestones(projectId, {
      milestones, name: data.name, agent: data.agent, withPlan: data.withPlan,
    });
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  /** v873 — POST /api/projects/:id/update-deps {packages?} — async Dependency-Update-Lauf. */
  private async handleProjectsUpdateDeps(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.updateDependencies) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const parts = url.pathname.split('/');
    const projectId = parts[parts.length - 2];
    const body = await this.readBody(req);
    let data: { packages?: string[] };
    try { data = JSON.parse(body); } catch { data = {}; }
    const result = await this.projectsCallbacks.updateDependencies(projectId, data.packages);
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
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

  /** v870 — POST /api/projects/:id/deep-verify {item_ids?, max_items?} */
  private async handleProjectsDeepVerify(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.deepVerifyItems) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const parts = url.pathname.split('/');
    const projectId = parts[parts.length - 2];
    const body = await this.readBody(req);
    let data: { item_ids?: string[]; max_items?: number };
    try { data = JSON.parse(body); } catch { data = {}; }
    const result = await this.projectsCallbacks.deepVerifyItems(projectId, data.item_ids, data.max_items ?? 15);
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  /** v870 — GET /api/projects/deep-verify/:taskId/result */
  private async handleProjectsDeepVerifyResult(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.deepVerifyResult) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const parts = url.pathname.split('/');
    const taskId = parts[parts.length - 2];
    const result = await this.projectsCallbacks.deepVerifyResult(taskId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result ?? { status: 'unknown' }));
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

  // v851 — Feature-Library API
  private async handleProjectFeaturesList(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.listProjectFeatures) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const parts = url.pathname.split('/');
    const projectId = parts[parts.length - 2];
    const status = url.searchParams.get('status') ?? undefined;
    const features = await this.projectsCallbacks.listProjectFeatures(projectId, status ? { status } : undefined);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ features }));
  }
  private async handleFeaturesSearch(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.searchFeatures) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const query = url.searchParams.get('q') ?? '';
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 10));
    const features = await this.projectsCallbacks.searchFeatures(query, limit);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ features }));
  }
  private async handleFeatureVisibility(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.setFeatureVisibility) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const parts = url.pathname.split('/');
    const featureId = parts[parts.length - 2];
    const body = await this.readBody(req).then(b => { try { return JSON.parse(b); } catch { return {}; } });
    const visibility = String((body as Record<string, unknown>)?.visibility ?? '');
    if (!['private', 'role-shared', 'global'].includes(visibility)) {
      res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid visibility' })); return;
    }
    const ok = await this.projectsCallbacks.setFeatureVisibility(featureId, visibility);
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok }));
  }
  private async handleFeatureConfirm(req: http.IncomingMessage, res: http.ServerResponse, url: URL, action: 'confirm' | 'reject'): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.confirmFeature) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const parts = url.pathname.split('/');
    const featureId = parts[parts.length - 2];
    const ok = await this.projectsCallbacks.confirmFeature(featureId, action);
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok }));
  }
  private async handleFeatureRetire(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.retireFeature) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const parts = url.pathname.split('/');
    const featureId = parts[parts.length - 1];
    const body = await this.readBody(req).then(b => { try { return JSON.parse(b); } catch { return {}; } }).catch(() => ({}));
    const reason = typeof (body as Record<string, unknown>)?.reason === 'string'
      ? String((body as Record<string, unknown>).reason)
      : undefined;
    const ok = await this.projectsCallbacks.retireFeature(featureId, reason);
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok }));
  }

  // v847 — Chat-Actions Liste pro Projekt (Tracking der Chat-getriggerten Skill-Arbeit)
  private async handleProjectsChatActions(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.listChatActions) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const parts = url.pathname.split('/');
    const projectId = parts[parts.length - 2];
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
    const actions = await this.projectsCallbacks.listChatActions(projectId, limit);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ actions }));
  }

  // v847 — Chat-Action-Detail
  private async handleChatActionDetail(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.getChatAction) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not configured' })); return;
    }
    const parts = url.pathname.split('/');
    const actionId = parts[parts.length - 1];
    const action = await this.projectsCallbacks.getChatAction(actionId);
    res.writeHead(action ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(action ?? { error: 'not-found' }));
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
  /**
   * v757 — Filtert alfred-eigene Cookies aus dem Cookie-Header bevor er upstream
   * weitergereicht wird. Die App im Sandbox-Container soll nur SEINE eigenen
   * Cookies sehen (z.B. Session-Cookies für Channels/Chat-Features), nicht
   * Alfred-Auth. Vorher: `delete headers['cookie']` hat ALLES gelöscht und damit
   * Apps zerschossen, die auf eigene Session-Cookies angewiesen sind.
   */
  private filterUpstreamCookies(cookieHeader: string | string[] | undefined): string | undefined {
    if (!cookieHeader) return undefined;
    const raw = Array.isArray(cookieHeader) ? cookieHeader.join('; ') : cookieHeader;
    const kept = raw.split(';')
      .map(s => s.trim())
      .filter(c => {
        const name = c.split('=')[0].trim();
        return name && !name.startsWith('__alfred_') && name !== this.PREVIEW_COOKIE;
      });
    return kept.length > 0 ? kept.join('; ') : undefined;
  }

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
    // v757 — Cookie filtern: nur alfred-eigene strippen, App-Cookies durchreichen
    // (Channels/Chat im iframe brauchen ihre eigenen Session-Cookies)
    const filteredCookies = this.filterUpstreamCookies(headers['cookie']);
    delete headers['cookie'];
    if (filteredCookies) headers['cookie'] = filteredCookies;
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

      // v757 — Set-Cookie Path-Rewriting: Upstream setzt z.B. `Path=/api`, aber
      // Requests vom iframe kommen unter `/preview/<sb>/api/...` → ohne Rewrite
      // verschickt der Browser App-Session-Cookies nie an die richtigen Routen.
      const setCookies = respHeaders['set-cookie'];
      if (setCookies) {
        const safeIdForCookie = sandboxId.replace(/[^a-zA-Z0-9-]/g, '');
        const cookiePrefix = `/preview/${safeIdForCookie}`;
        const rewriteCookie = (cookieStr: string) => {
          return cookieStr.split(';').map(part => {
            const trimmed = part.trim();
            const eq = trimmed.indexOf('=');
            const attrName = (eq === -1 ? trimmed : trimmed.slice(0, eq)).toLowerCase();
            if (attrName !== 'path') return part;
            const pathVal = trimmed.slice(eq + 1).trim();
            if (!pathVal.startsWith('/')) return ` Path=${cookiePrefix}/`;
            if (pathVal === cookiePrefix || pathVal.startsWith(`${cookiePrefix}/`)) return part;
            return ` Path=${cookiePrefix}${pathVal === '/' ? '/' : pathVal}`;
          }).join(';');
        };
        respHeaders['set-cookie'] = Array.isArray(setCookies)
          ? setCookies.map(rewriteCookie)
          : rewriteCookie(setCookies);
      }

      // v913 — Location-Header (Redirects) auf den /preview/<id>/-Pfad umschreiben.
      // Apps leiten oft um (z.B. / → /setup beim First-Run-Wizard, oder zu /login).
      // Ohne Rewrite folgt der iframe-Browser dem root-relativen Pfad und VERLÄSST
      // /preview/<id>/ → landet auf Alfred selbst (404) → iframe zeigt 🚫. Root-
      // relative Locations und absolute auf den Upstream (127.0.0.1) bekommen den
      // Prefix; externe Absolut-URLs (z.B. echte Auth-URL) bleiben unangetastet.
      const loc = respHeaders['location'];
      if (typeof loc === 'string' && loc.length > 0) {
        const safeIdForLoc = sandboxId.replace(/[^a-zA-Z0-9-]/g, '');
        const locPrefix = `/preview/${safeIdForLoc}`;
        let rewritten: string | null = null;
        if (loc.startsWith('/') && !loc.startsWith('/preview/')) {
          rewritten = `${locPrefix}${loc}`;
        } else if (/^https?:\/\//i.test(loc)) {
          try {
            const u = new URL(loc);
            if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') {
              rewritten = `${locPrefix}${u.pathname}${u.search}${u.hash}`;
            }
          } catch { /* kein parsebarer URL → unverändert lassen */ }
        }
        if (rewritten) respHeaders['location'] = rewritten;
      }

      // v725 — Link-Header rewriten (Server-Push-Hints für preload):</path>; rel=preload
      // wird vom Browser als preload-fetch mit ABSOLUTE path getriggert → braucht prefix.
      const linkHeader = respHeaders['link'];
      if (linkHeader) {
        const safeId = sandboxId.replace(/[^a-zA-Z0-9-]/g, '');
        const prefix = `/preview/${safeId}`;
        const rewrite = (s: string) => s.replace(/<(\/[^>]*)>/g, (full, path: string) => {
          // path enthält das führende '/'. Skip: zu kurz, protokoll-relativ (//), oder bereits prefixed.
          if (path.length < 2) return full;
          if (path.charAt(1) === '/') return full;
          if (path === prefix || path.startsWith(`${prefix}/`)) return full;
          return `<${prefix}${path}>`;
        });
        respHeaders['link'] = Array.isArray(linkHeader) ? linkHeader.map(rewrite) : rewrite(linkHeader);
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
            // v725 — URL-Rewriting in HTML-Attributen: alle absoluten Pfade /foo werden
            // zu /preview/<sb>/foo prefixed. Browser fetcht damit DIREKT unter preview-prefix,
            // braucht keine Referer-Magie. Konservativ: nur quoted attribute values
            // (href="/..", src="/..", srcset="/..", action="/.."). Ignoriert:
            //  - bereits prefixed (/preview/<sb>/...)
            //  - protokoll-relative (//host/...)
            //  - protokoll-absolute (http://, https://, data:, blob:, mailto:, etc.)
            //  - hash-only (#foo)
            //  - relative ohne / (foo/bar)
            body = this.rewriteSandboxHtmlUrls(body, sandboxId);
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
   * v724 — HTML-Inject-Snippet für Sandbox-Preview-Responses.
   * v725 — `<base href>` ENTFERNT weil CSP `base-uri 'self'` ihn in manchen Browsern
   * blockierte und er für absolute Pfade ohnehin nichts brachte. Statt dessen werden
   * absolute href/src-Attribute im HTML direkt rewriten (siehe rewriteSandboxHtmlUrls).
   * Behält nur den history-API-Patch der Next.js Client-Router-Navigates prefixt.
   */
  private buildSandboxHtmlInjection(sandboxId: string): string {
    // sandboxId ist UUID/Slug-Form — safe-by-construction für JS-Literal, kein User-Input.
    const safeId = sandboxId.replace(/[^a-zA-Z0-9-]/g, '');
    const prefix = `/preview/${safeId}`;
    return [
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

  /**
   * v725 — Rewriting absoluter URL-Pfade in HTML-Attributen auf den preview-prefix.
   *
   * Browser fetcht absolute Pfade (/foo) relativ zur Origin, nicht zur base-href.
   * Vorher: `<link href="/_next/static/foo.css">` → Browser fragt `/foo.css` → 404
   * Nachher: `<link href="/preview/<sb>/_next/static/foo.css">` → 200
   *
   * Konservativ implementiert:
   *  - Nur quoted attribute values (double oder single quotes)
   *  - Nur href, src, srcset, action, formaction, poster, data
   *  - Skip wenn bereits prefixed, protokoll-absolute, protokoll-relativ, data:, blob:, mailto:, javascript:, oder hash-only
   *
   * srcset (Multi-URL with descriptors): jedes URL-Token einzeln verarbeiten.
   */
  private rewriteSandboxHtmlUrls(html: string, sandboxId: string): string {
    const safeId = sandboxId.replace(/[^a-zA-Z0-9-]/g, '');
    const prefix = `/preview/${safeId}`;

    const isAbsolutePath = (val: string): boolean => {
      if (val.length === 0) return false;
      if (val.charAt(0) !== '/') return false;
      if (val.charAt(1) === '/') return false; // protokoll-relativ //host/...
      if (val.indexOf(`${prefix}/`) === 0 || val === prefix) return false; // bereits prefixed
      return true;
    };

    // Standard-Attribute: href, src, action, formaction, poster, data, ping
    const attrRe = /\b(href|src|action|formaction|poster|data|ping)\s*=\s*(["'])([^"']*)\2/gi;
    html = html.replace(attrRe, (full, attr: string, quote: string, val: string) => {
      if (!isAbsolutePath(val)) return full;
      return `${attr}=${quote}${prefix}${val}${quote}`;
    });

    // srcset ist Multi-Value: "url1 1x, url2 2x" — jedes URL-Token einzeln behandeln
    const srcsetRe = /\bsrcset\s*=\s*(["'])([^"']*)\1/gi;
    html = html.replace(srcsetRe, (full, quote: string, val: string) => {
      const rewritten = val.split(',').map(entry => {
        const trimmed = entry.trim();
        if (!trimmed) return entry;
        // entry = "URL DESCRIPTOR" (DESCRIPTOR optional)
        const spaceIdx = trimmed.search(/\s/);
        const urlPart = spaceIdx >= 0 ? trimmed.slice(0, spaceIdx) : trimmed;
        const descriptorPart = spaceIdx >= 0 ? trimmed.slice(spaceIdx) : '';
        if (!isAbsolutePath(urlPart)) return entry;
        return `${prefix}${urlPart}${descriptorPart}`;
      }).join(', ');
      return `srcset=${quote}${rewritten}${quote}`;
    });

    return html;
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
      // v757 — Nur alfred-Cookies strippen, App-Session-Cookies durchreichen
      // (WebSocket-Upgrade für Channels/Chat braucht App-Auth via Cookie)
      const filteredCookies = this.filterUpstreamCookies(headers['cookie']);
      delete headers['cookie'];
      if (filteredCookies) headers['cookie'] = filteredCookies;
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
    let input: { projectId: string; sessionId?: string | null; mode: string; slug?: string; requestUserId?: string; envStage?: string; dbSeedId?: string | null };
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
        // v733 — envStage + dbSeedId override
        envStage: typeof parsed.envStage === 'string' && /^[a-z][a-z0-9_-]{0,30}$/.test(parsed.envStage) ? parsed.envStage : undefined,
        dbSeedId: parsed.dbSeedId === null ? null : (typeof parsed.dbSeedId === 'string' && parsed.dbSeedId.length > 0 ? parsed.dbSeedId : undefined),
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
      // v745 — Quota-Errors als 429 (Too Many Requests / Quota Exceeded) statt 500
      const msg = (err as Error).message;
      const isQuota = /Max parallele Sandboxes|Disk-Quota/.test(msg);
      const isNotGitRepo = /not a git repo/.test(msg);
      const status = isQuota ? 429 : isNotGitRepo ? 400 : 500;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: msg, code: isQuota ? 'QUOTA_EXCEEDED' : isNotGitRepo ? 'NOT_A_REPO' : 'UNKNOWN' }));
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

  /** v748 — POST /api/sandbox/:id/force-fail — Stuck-Sandbox (creating > 10min) manuell auf failed setzen. */
  private async handleSandboxForceFail(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.sandboxCallbacks?.forceFail) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'Force-Fail-Action nicht verfügbar' }));
      return;
    }
    const sandboxId = url.pathname.split('/')[3];
    const body = await this.readBody(req);
    let reason: string | undefined;
    try { reason = (JSON.parse(body) as Record<string, unknown>).reason as string | undefined; } catch { /* */ }
    try {
      const r = await this.sandboxCallbacks.forceFail(sandboxId, reason);
      res.writeHead(r.ok ? 200 : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: (err as Error).message }));
    }
  }

  /** v728 — POST /api/sandbox/:id/restart — Container stop + .next/ clear + start. */
  private async handleSandboxRestart(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.sandboxCallbacks?.restart) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'Restart-Action nicht verfügbar' }));
      return;
    }
    const sandboxId = url.pathname.split('/')[3];
    try {
      const r = await this.sandboxCallbacks.restart(sandboxId);
      res.writeHead(r.ok ? 200 : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: (err as Error).message }));
    }
  }

  /** v728 — GET /api/sandbox/:id/logs?tail=N — Container-Logs. */
  private async handleSandboxLogs(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.sandboxCallbacks?.getLogs) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'Logs-Action nicht verfügbar' }));
      return;
    }
    const sandboxId = url.pathname.split('/')[3];
    const tailRaw = url.searchParams.get('tail');
    const tail = tailRaw ? Math.max(1, Math.min(2000, parseInt(tailRaw, 10) || 200)) : 200;
    try {
      const r = await this.sandboxCallbacks.getLogs(sandboxId, tail);
      res.writeHead(r.ok ? 200 : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: (err as Error).message }));
    }
  }

  /** v728 — GET /api/sandbox/:id/stats — Container-Stats (CPU, RAM, Uptime). */
  private async handleSandboxStats(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.sandboxCallbacks?.getStats) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'Stats-Action nicht verfügbar' }));
      return;
    }
    const sandboxId = url.pathname.split('/')[3];
    try {
      const r = await this.sandboxCallbacks.getStats(sandboxId);
      res.writeHead(r.ok ? 200 : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: (err as Error).message }));
    }
  }

  /** v728 — GET /api/projects/:id/environments → Liste aller Stages mit Key-Count. */
  private async handleEnvironmentsList(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.environmentsCallbacks) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Environments-Feature nicht aktiv' }));
      return;
    }
    const projectId = url.pathname.split('/')[3];
    try {
      const stages = await this.environmentsCallbacks.listStages(projectId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ stages }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  /** v728 — GET /api/projects/:id/environments/:stage?reveal=1 → vars. */
  private async handleEnvironmentsGet(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.environmentsCallbacks) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Environments-Feature nicht aktiv' }));
      return;
    }
    const parts = url.pathname.split('/');
    const projectId = parts[3];
    const stage = decodeURIComponent(parts[5] ?? '');
    const reveal = url.searchParams.get('reveal') === '1';
    try {
      const vars = await this.environmentsCallbacks.getVars(projectId, stage, reveal);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ stage, vars, reveal }));
    } catch (err) {
      // v907 — Daten mit früherem/flüchtigem Schlüssel verschlüsselt → kein harter
      // 500, sondern 422 mit klarer, umsetzbarer Meldung. Reset via „Stage löschen".
      if ((err as Error).message === 'ENV_UNREADABLE') {
        res.writeHead(422, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          unreadable: true,
          error: `Stage „${stage}" wurde mit einem früheren Verschlüsselungs-Schlüssel gespeichert und ist nicht mehr lesbar ` +
            `(der Schlüssel hat sich bei einem Neustart geändert). Bitte die Stage löschen und die Keys neu setzen. ` +
            `Dauerhaft beheben: security.envEncryptionKey in der Config setzen (stabiler 32-Byte-Key), dann überleben ENVs Neustarts.`,
        }));
        return;
      }
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  /** v728 — PUT /api/projects/:id/environments/:stage → bulk-set (body: {vars, replace?}). */
  private async handleEnvironmentsPut(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.environmentsCallbacks) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Environments-Feature nicht aktiv' }));
      return;
    }
    const parts = url.pathname.split('/');
    const projectId = parts[3];
    const stage = decodeURIComponent(parts[5] ?? '');
    const body = await this.readBody(req);
    let payload: { vars?: Record<string, string>; replace?: boolean } = {};
    try { payload = JSON.parse(body) as typeof payload; } catch { /* */ }
    const vars = payload.vars ?? {};
    if (typeof vars !== 'object' || Array.isArray(vars)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'vars muss ein Objekt sein' }));
      return;
    }
    try {
      const r = await this.environmentsCallbacks.setVars(projectId, stage, vars, payload.replace === true);
      res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: (err as Error).message }));
    }
  }

  /** v732 — GET /api/projects/:id/environments/scan → benötigte ENV-Keys aus Repo scannen. */
  private async handleEnvironmentsScan(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.environmentsCallbacks?.scanRepo) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Scan-Action nicht verfügbar' }));
      return;
    }
    const projectId = url.pathname.split('/')[3];
    try {
      const r = await this.environmentsCallbacks.scanRepo(projectId);
      res.writeHead(r.ok ? 200 : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: (err as Error).message }));
    }
  }

  /** v732 — GET /api/projects/:id/db-seeds → Liste hochgeladener + repo-path Seeds. */
  private async handleDbSeedsList(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.dbSeedsCallbacks) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'DB-Seeds-Feature nicht aktiv' }));
      return;
    }
    const projectId = url.pathname.split('/')[3];
    try {
      const seeds = await this.dbSeedsCallbacks.list(projectId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ seeds }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  /** v732 — POST /api/projects/:id/db-seeds → upload (body: {name, dataUrl}). */
  private async handleDbSeedsUpload(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.dbSeedsCallbacks) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'DB-Seeds-Feature nicht aktiv' }));
      return;
    }
    const projectId = url.pathname.split('/')[3];
    const body = await this.readBody(req);
    let payload: { name?: string; dataUrl?: string } = {};
    try { payload = JSON.parse(body) as typeof payload; } catch { /* */ }
    const name = (payload.name ?? '').trim();
    const dataUrl = payload.dataUrl ?? '';
    if (!name || !dataUrl || !dataUrl.startsWith('data:')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'name + dataUrl required (dataUrl must start with data:)' }));
      return;
    }
    const commaIdx = dataUrl.indexOf(',');
    if (commaIdx < 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'invalid dataUrl' }));
      return;
    }
    try {
      const r = await this.dbSeedsCallbacks.upload(projectId, name.slice(0, 200), dataUrl.slice(commaIdx + 1));
      res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: (err as Error).message }));
    }
  }

  /** v732 — POST /api/projects/:id/db-seeds/repo-path → registriert seed der im Repo liegt. */
  private async handleDbSeedsRegisterRepoPath(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.dbSeedsCallbacks) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'DB-Seeds-Feature nicht aktiv' }));
      return;
    }
    const projectId = url.pathname.split('/')[3];
    const body = await this.readBody(req);
    let payload: { name?: string; repoPath?: string } = {};
    try { payload = JSON.parse(body) as typeof payload; } catch { /* */ }
    const name = (payload.name ?? '').trim();
    const repoPath = (payload.repoPath ?? '').trim();
    if (!name || !repoPath) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'name + repoPath required' }));
      return;
    }
    if (repoPath.includes('..') || repoPath.startsWith('/')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'repoPath muss relativ zum project-cwd sein (kein .. und kein /-Prefix)' }));
      return;
    }
    try {
      const r = await this.dbSeedsCallbacks.registerRepoPath(projectId, name.slice(0, 200), repoPath.slice(0, 500));
      res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: (err as Error).message }));
    }
  }

  /** v732 — PUT /api/projects/:id/db-seeds/default — Default-Seed setzen (body: {seedId|null}). */
  private async handleDbSeedsSetDefault(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.dbSeedsCallbacks) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'DB-Seeds-Feature nicht aktiv' }));
      return;
    }
    const projectId = url.pathname.split('/')[3];
    const body = await this.readBody(req);
    let payload: { seedId?: string | null } = {};
    try { payload = JSON.parse(body) as typeof payload; } catch { /* */ }
    const seedId = payload.seedId === null || payload.seedId === '' ? null : (payload.seedId ?? null);
    try {
      const r = await this.dbSeedsCallbacks.setDefault(projectId, seedId);
      res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: (err as Error).message }));
    }
  }

  /** v732 — DELETE /api/projects/:id/db-seeds/:seedId. */
  private async handleDbSeedsDelete(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.dbSeedsCallbacks) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'DB-Seeds-Feature nicht aktiv' }));
      return;
    }
    const parts = url.pathname.split('/');
    const projectId = parts[3];
    const seedId = parts[5];
    try {
      const r = await this.dbSeedsCallbacks.delete(projectId, seedId);
      res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: (err as Error).message }));
    }
  }

  /** v728 — DELETE /api/projects/:id/environments/:stage → ganze Stage löschen. */
  private async handleEnvironmentsDelete(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.environmentsCallbacks) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Environments-Feature nicht aktiv' }));
      return;
    }
    const parts = url.pathname.split('/');
    const projectId = parts[3];
    const stage = decodeURIComponent(parts[5] ?? '');
    try {
      await this.environmentsCallbacks.deleteStage(projectId, stage);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  /** v751 — GET /api/sandbox-templates?projectId=X → liste Templates (global + project-scoped). */
  private async handleSandboxTemplatesList(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.sandboxTemplatesCallbacks) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Sandbox-Templates nicht verfügbar' }));
      return;
    }
    const projectIdParam = url.searchParams.get('projectId');
    const projectId = projectIdParam === null ? undefined : (projectIdParam === '' ? null : projectIdParam);
    try {
      const templates = await this.sandboxTemplatesCallbacks.list(projectId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ templates }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  /** v751 — POST /api/sandbox-templates → create */
  private async handleSandboxTemplatesCreate(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.sandboxTemplatesCallbacks) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Sandbox-Templates nicht verfügbar' }));
      return;
    }
    const body = await this.readBody(req);
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(body) as Record<string, unknown>; } catch { /* */ }
    const name = String(payload.name ?? '').trim();
    const mode = payload.mode;
    if (!name || (mode !== 'sandbox' && mode !== 'sandbox-preview' && mode !== 'interactive-chat')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'name + mode (sandbox|sandbox-preview|interactive-chat) required' }));
      return;
    }
    try {
      const r = await this.sandboxTemplatesCallbacks.create({
        projectId: payload.projectId === null ? null : (typeof payload.projectId === 'string' ? payload.projectId : undefined),
        name,
        description: typeof payload.description === 'string' ? payload.description : undefined,
        mode,
        envStage: typeof payload.envStage === 'string' ? payload.envStage : undefined,
        dbSeedId: typeof payload.dbSeedId === 'string' ? payload.dbSeedId : undefined,
        initialGoal: typeof payload.initialGoal === 'string' ? payload.initialGoal : undefined,
        tags: Array.isArray(payload.tags) ? payload.tags.filter((t): t is string => typeof t === 'string') : undefined,
      });
      res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: (err as Error).message }));
    }
  }

  /** v751 — PATCH /api/sandbox-templates/:id */
  private async handleSandboxTemplatesUpdate(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.sandboxTemplatesCallbacks) { res.writeHead(501, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'nicht verfügbar' })); return; }
    const id = url.pathname.split('/')[3];
    const body = await this.readBody(req);
    let patch: Record<string, unknown> = {};
    try { patch = JSON.parse(body) as Record<string, unknown>; } catch { /* */ }
    try {
      const r = await this.sandboxTemplatesCallbacks.update(id, patch);
      res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: (err as Error).message }));
    }
  }

  /** v751 — DELETE /api/sandbox-templates/:id */
  private async handleSandboxTemplatesDelete(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.sandboxTemplatesCallbacks) { res.writeHead(501, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'nicht verfügbar' })); return; }
    const id = url.pathname.split('/')[3];
    try {
      const r = await this.sandboxTemplatesCallbacks.delete(id);
      res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: (err as Error).message }));
    }
  }

  /** v742 — POST /api/projects/:id/re-match-open-items → manuell OpenItemMatcher gegen letzten Session-Lauf. */
  private async handleProjectsReMatchOpenItems(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.reMatchOpenItems) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Re-Match nicht verfügbar' }));
      return;
    }
    const parts = url.pathname.split('/');
    const projectId = parts[3];
    try {
      const r = await this.projectsCallbacks.reMatchOpenItems(projectId);
      res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: (err as Error).message }));
    }
  }

  /** v797 — POST /api/projects/:id/health-check → sofortiger Health-Check (statt 6h-Schedule warten). */
  private async handleProjectsHealthCheck(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.triggerHealthCheck) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Health-Check nicht verfügbar' }));
      return;
    }
    const parts = url.pathname.split('/');
    const projectId = parts[3];
    try {
      const r = await this.projectsCallbacks.triggerHealthCheck(projectId);
      res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: (err as Error).message }));
    }
  }

  // v824 — Agent-Conventions Phase 1 endpoints. Alle 7 Routes implementiert.
  private async handleConventionsStatus(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.conventionsStatus) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'Conventions not available' })); return;
    }
    const projectId = url.pathname.split('/')[3];
    const packagePath = url.searchParams.get('package_path') ?? undefined;
    try {
      const r = await this.projectsCallbacks.conventionsStatus(projectId, packagePath);
      res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: (err as Error).message }));
    }
  }

  private async handleConventionsGenerate(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.conventionsGenerate) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'Conventions not available' })); return;
    }
    const projectId = url.pathname.split('/')[3];
    const body = await this.readBody(req);
    let opts: { packagePath?: string; language?: 'de' | 'en'; tier?: 'fast' | 'default' | 'strong' } = {};
    try { opts = JSON.parse(body) as typeof opts; } catch { /* default */ }
    try {
      const r = await this.projectsCallbacks.conventionsGenerate(projectId, opts);
      res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: (err as Error).message }));
    }
  }

  private async handleConventionsApply(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.conventionsApply) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'Conventions not available' })); return;
    }
    const projectId = url.pathname.split('/')[3];
    const body = await this.readBody(req);
    let opts: { packagePath?: string; content?: string; commitToGit?: boolean; outputs?: string[] } = {};
    try { opts = JSON.parse(body) as typeof opts; } catch { /* default */ }
    try {
      const r = await this.projectsCallbacks.conventionsApply(projectId, opts);
      res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: (err as Error).message }));
    }
  }

  private async handleConventionsRefresh(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.conventionsRefresh) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'Conventions not available' })); return;
    }
    const projectId = url.pathname.split('/')[3];
    const body = await this.readBody(req);
    let opts: { packagePath?: string; language?: 'de' | 'en' } = {};
    try { opts = JSON.parse(body) as typeof opts; } catch { /* default */ }
    try {
      const r = await this.projectsCallbacks.conventionsRefresh(projectId, opts);
      res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: (err as Error).message }));
    }
  }

  private async handleConventionsDriftCheck(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.conventionsDriftCheck) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'Conventions not available' })); return;
    }
    const projectId = url.pathname.split('/')[3];
    const packagePath = url.searchParams.get('package_path') ?? undefined;
    try {
      const r = await this.projectsCallbacks.conventionsDriftCheck(projectId, packagePath);
      res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: (err as Error).message }));
    }
  }

  private async handleConventionsHistory(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.conventionsHistory) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'Conventions not available' })); return;
    }
    const projectId = url.pathname.split('/')[3];
    const packagePath = url.searchParams.get('package_path') ?? undefined;
    try {
      const r = await this.projectsCallbacks.conventionsHistory(projectId, packagePath);
      res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: (err as Error).message }));
    }
  }

  private async handleConventionsRollback(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.conventionsRollback) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'Conventions not available' })); return;
    }
    const projectId = url.pathname.split('/')[3];
    const body = await this.readBody(req);
    let opts: { historyId?: string; packagePath?: string } = {};
    try { opts = JSON.parse(body) as typeof opts; } catch { /* default */ }
    if (!opts.historyId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'historyId required' })); return;
    }
    try {
      const r = await this.projectsCallbacks.conventionsRollback(projectId, opts.historyId, opts.packagePath);
      res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: (err as Error).message }));
    }
  }

  private async handleConventionsListLessons(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.conventionsListLessons) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'Conventions not available' })); return;
    }
    const projectId = url.pathname.split('/')[3];
    const packagePath = url.searchParams.get('package_path') ?? undefined;
    try {
      const r = await this.projectsCallbacks.conventionsListLessons(projectId, packagePath);
      res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: (err as Error).message }));
    }
  }

  private async handleConventionsConsolidateLessons(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.conventionsConsolidateLessons) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'Conventions not available' })); return;
    }
    const projectId = url.pathname.split('/')[3];
    const body = await this.readBody(req);
    let opts: { packagePath?: string } = {};
    try { opts = JSON.parse(body) as typeof opts; } catch { /* default */ }
    try {
      const r = await this.projectsCallbacks.conventionsConsolidateLessons(projectId, opts.packagePath);
      res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: (err as Error).message }));
    }
  }

  private async handleConventionsGetConfigOverrides(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.conventionsGetConfigOverrides) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'Conventions not available' })); return;
    }
    const projectId = url.pathname.split('/')[3];
    try {
      const r = await this.projectsCallbacks.conventionsGetConfigOverrides(projectId);
      res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: (err as Error).message }));
    }
  }

  private async handleConventionsSetConfigOverrides(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.conventionsSetConfigOverrides) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'Conventions not available' })); return;
    }
    const projectId = url.pathname.split('/')[3];
    const body = await this.readBody(req);
    let opts: { overrides?: Record<string, unknown> } = {};
    try { opts = JSON.parse(body) as typeof opts; } catch { /* default */ }
    if (!opts.overrides || typeof opts.overrides !== 'object') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'overrides object required' })); return;
    }
    try {
      const r = await this.projectsCallbacks.conventionsSetConfigOverrides(projectId, opts.overrides);
      res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: (err as Error).message }));
    }
  }

  private async handleConventionsEffectiveness(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.conventionsEffectiveness) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'Conventions not available' })); return;
    }
    const projectId = url.pathname.split('/')[3];
    try {
      const r = await this.projectsCallbacks.conventionsEffectiveness(projectId);
      res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: (err as Error).message }));
    }
  }

  private async handleConventionsSectionHealth(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.conventionsSectionHealth) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'Conventions not available' })); return;
    }
    const projectId = url.pathname.split('/')[3];
    try {
      const r = await this.projectsCallbacks.conventionsSectionHealth(projectId);
      res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: (err as Error).message }));
    }
  }

  private async handleConventionsGlobalPatterns(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.conventionsGlobalPatterns) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'Conventions not available' })); return;
    }
    try {
      const r = await this.projectsCallbacks.conventionsGlobalPatterns();
      res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: (err as Error).message }));
    }
  }

  private async handleConventionsListPackages(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.conventionsListPackages) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'Conventions not available' })); return;
    }
    const projectId = url.pathname.split('/')[3];
    try {
      const r = await this.projectsCallbacks.conventionsListPackages(projectId);
      res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: (err as Error).message }));
    }
  }

  private async handleConventionsGenerateAllPackages(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.projectsCallbacks?.conventionsGenerateAllPackages) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'Conventions not available' })); return;
    }
    const projectId = url.pathname.split('/')[3];
    try {
      const r = await this.projectsCallbacks.conventionsGenerateAllPackages(projectId);
      res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: (err as Error).message }));
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

  // v787 — Liste aller AgentSession-Adapter (für Picker im Frontend)
  private async handleAgentSessionAdapters(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.agentSessionCallbacks) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ adapters: [] }));
      return;
    }
    try {
      const adapters = this.agentSessionCallbacks.listAvailable();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ adapters }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  // v788 — Session-Stats für eine Sandbox (alle aktiven Agents)
  private async handleAgentSessionStats(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.agentSessionCallbacks?.listSessionsForSandbox) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessions: [] }));
      return;
    }
    const sandboxId = url.pathname.split('/')[4];
    try {
      const sessions = await this.agentSessionCallbacks.listSessionsForSandbox(sandboxId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessions }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  // v791 — Event-Replay: alle Events einer Session chronologisch
  private async handleAgentSessionEvents(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.agentSessionCallbacks?.listEventsForSession) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ events: [] }));
      return;
    }
    const sessionId = url.pathname.split('/')[4];
    const limitParam = url.searchParams.get('limit');
    const limit = limitParam ? Math.min(parseInt(limitParam, 10) || 500, 2000) : 500;
    if (!sessionId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'sessionId required' }));
      return;
    }
    try {
      const events = await this.agentSessionCallbacks.listEventsForSession(sessionId, limit);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ events }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  // v789 — Session-Reset: CLI-State löschen + DB-Eintrag entfernen
  private async handleAgentSessionReset(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.agentSessionCallbacks?.resetSession) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'Reset nicht verfügbar' }));
      return;
    }
    const parts = url.pathname.split('/');
    const sandboxId = parts[4];
    const agentName = decodeURIComponent(parts[5] ?? '');
    if (!sandboxId || !agentName) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'sandboxId + agentName required' }));
      return;
    }
    try {
      const r = await this.agentSessionCallbacks.resetSession(sandboxId, agentName);
      res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: (err as Error).message }));
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
    let attachments: Array<{ name: string; mime: string; dataUrl: string; dropInWorktree: boolean }> | undefined;
    let mentions: Array<{ id: string; type: 'open_item' | 'decision'; title: string; priority?: string; status?: string }> | undefined;
    let engine: 'project-agent' | 'code-agent' | 'discuss' | undefined;
    let agentName: string | undefined;
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      message = String(parsed.message ?? '');
      // v760/v769 — Engine-Wahl (default: project-agent für Backward-Compat)
      if (parsed.engine === 'code-agent' || parsed.engine === 'project-agent' || parsed.engine === 'discuss') engine = parsed.engine;
      // v787 — Optional CLI-Agent-Override (Picker im Frontend)
      if (typeof parsed.agentName === 'string' && parsed.agentName.length > 0 && parsed.agentName.length < 80) {
        agentName = parsed.agentName;
      }
      // v729a — Attachments aus dem Body validieren
      if (Array.isArray(parsed.attachments)) {
        attachments = [];
        for (const att of parsed.attachments) {
          if (!att || typeof att !== 'object') continue;
          const a = att as Record<string, unknown>;
          if (typeof a.name !== 'string' || typeof a.mime !== 'string' || typeof a.dataUrl !== 'string') continue;
          if (!a.dataUrl.startsWith('data:')) continue;
          attachments.push({
            name: a.name.slice(0, 200),
            mime: a.mime.slice(0, 100),
            dataUrl: a.dataUrl,
            dropInWorktree: a.dropInWorktree === true,
          });
        }
        if (attachments.length === 0) attachments = undefined;
      }
      // v730 — Mentions validieren
      if (Array.isArray(parsed.mentions)) {
        mentions = [];
        for (const m of parsed.mentions) {
          if (!m || typeof m !== 'object') continue;
          const mm = m as Record<string, unknown>;
          if (typeof mm.id !== 'string' || typeof mm.title !== 'string') continue;
          if (mm.type !== 'open_item' && mm.type !== 'decision') continue;
          mentions.push({
            id: mm.id.slice(0, 64),
            type: mm.type,
            title: mm.title.slice(0, 300),
            priority: typeof mm.priority === 'string' ? mm.priority.slice(0, 20) : undefined,
            status: typeof mm.status === 'string' ? mm.status.slice(0, 20) : undefined,
          });
        }
        if (mentions.length === 0) mentions = undefined;
      }
    } catch { /* */ }
    if (!message.trim() && (!attachments || attachments.length === 0) && (!mentions || mentions.length === 0)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'message, attachments or mentions required' }));
      return;
    }
    try {
      const r = await this.sandboxCallbacks.chatSendMessage(sandboxId, message.trim(), attachments, mentions, engine, agentName);
      res.writeHead(r.ok ? 200 : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: (err as Error).message }));
    }
  }

  // v771 — Resume einen failed/stopped Project-Agent-Task per taskId
  private async handleSandboxChatResume(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.sandboxCallbacks?.chatResumeTask) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'Resume nicht verfügbar' }));
      return;
    }
    const sandboxId = url.pathname.split('/')[3];
    const body = await this.readBody(req);
    let taskId = '';
    try { taskId = String((JSON.parse(body) as Record<string, unknown>).taskId ?? ''); } catch { /* */ }
    if (!taskId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'taskId required' }));
      return;
    }
    try {
      const r = await this.sandboxCallbacks.chatResumeTask(sandboxId, taskId);
      res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: (err as Error).message }));
    }
  }

  // v762 — Stop einen laufenden Code-Agent-Task per taskId
  private async handleSandboxChatStop(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.sandboxCallbacks?.chatStopTask) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'Stop nicht verfügbar' }));
      return;
    }
    const sandboxId = url.pathname.split('/')[3];
    const body = await this.readBody(req);
    let taskId = '';
    try { taskId = String((JSON.parse(body) as Record<string, unknown>).taskId ?? ''); } catch { /* */ }
    if (!taskId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'taskId required' }));
      return;
    }
    try {
      const r = await this.sandboxCallbacks.chatStopTask(sandboxId, taskId);
      res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
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
          // v890 — Project-Chat: CLI-Wahl des Pickers ('auto' = Projekt-Strategie, sonst konkrete CLI)
          agentChoice?: string;
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
                // v890 — CLI-Wahl des Projekt-Chat-Pickers (nur bei projectId relevant)
                ...(projectId && typeof parsed.agentChoice === 'string' && parsed.agentChoice.length > 0 ? { agentChoice: parsed.agentChoice } : {}),
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

  /** v866 — CLI-Agent-Usage-Übersicht: ?days=30 (0/fehlend = alles). */
  private async handleCliUsage(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!(await this.checkAuth(req, res))) return;
    if (!this.cliUsageCallback) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'cli-usage not available' }));
      return;
    }
    const daysRaw = Number(url.searchParams.get('days') ?? 0);
    const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(daysRaw, 3650) : undefined;
    const data = await this.cliUsageCallback(days);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data ?? { totals: null }));
  }
}
